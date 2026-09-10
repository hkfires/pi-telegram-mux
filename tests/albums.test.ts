import { randomFillSync } from "node:crypto";
import { deflateSync } from "node:zlib";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { getMediaDir, getRuntimeDir } from "../src/config.js";
import { runtimeFixture, telegramUpdate, testConfig } from "./helpers.js";
import type { TelegramUpdate } from "../src/types.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
let dir: string;
let fixtures: Awaited<ReturnType<typeof runtimeFixture>>[];
let c: LeaderCoordinator;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-albums-"));
  fixtures = [];
});
afterEach(async () => {
  for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
  await c?.stop();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});
async function start() {
  const f = await runtimeFixture(dir, "leader", 50, "startup");
  fixtures.push(f);
  (f.ctx as any).model = { input: ["text", "image"] };
  c = (f.runtime as any).coordinator;
  (c as any).options.albumDelayMs = 40;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockImplementation(async file => ({ file_id: file, file_unique_id: file, file_path: `photos/${file}.jpg` }));
  vi.spyOn(client, "downloadFile").mockImplementation(async file => Buffer.from(file));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 999 } as any);
  return f;
}
function image(id: number, group = "album", caption?: string, thread = 50): TelegramUpdate {
  const update = telegramUpdate(thread, "", id);
  delete update.message!.text;
  update.message!.media_group_id = group;
  update.message!.caption = caption;
  update.message!.photo = [{ file_id: `image${id}`, file_unique_id: `image${id}`, width: 100, height: 100 }];
  return update;
}

it.each(["leader-idle", "leader-followUp", "leader-steer", "follower-idle", "follower-followUp", "follower-steer"])("submits one labelled multi-image prompt on %s", async scenario => {
  const leader = await start();
  let f = leader;
  let thread = 50;
  if (scenario.startsWith("follower")) {
    f = await runtimeFixture(dir, "follower", 51, "startup");
    fixtures.push(f);
    thread = 51;
    (f.ctx as any).model = { input: ["text", "image"] };
  }
  const idle = scenario.endsWith("idle");
  if (idle) {
    f.pi.sendUserMessage.mockImplementation((content: any) => {
      void f.runtime.onBeforeAgentStart(f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content }, f.ctx));
    });
  } else {
    c.updateInputMode(scenario.endsWith("steer") ? "steer" : "followUp");
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await f.runtime.onBeforeAgentStart(f.ctx);
  }
  // Telegram can split an album across poll responses and deliver members out of order.
  const first = c.processUpdate(image(20, "album", "Compare these", thread));
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = c.processUpdate(image(10, "album", "First image caption", thread));
  const duplicate = c.processUpdate(image(20, "album", "Compare these", thread));
  await Promise.all([first, second, duplicate]);
  const send = idle ? f.pi.sendUserMessage : f.pi.sendMessage;
  expect(send).toHaveBeenCalledOnce();
  const content = idle ? send.mock.calls[0][0] : send.mock.calls[0][0].content;
  expect(content).toEqual([
    { type: "text", text: "[Image#1] [Image#2]\n\nFirst image caption\n\nCompare these" },
    { type: "image", mimeType: "image/jpeg", data: Buffer.from("photos/image10.jpg").toString("base64") },
    { type: "image", mimeType: "image/jpeg", data: Buffer.from("photos/image20.jpg").toString("base64") },
  ]);
  if (!idle) expect(f.pi.sendMessage.mock.calls[0][1]).toMatchObject({ deliverAs: scenario.endsWith("steer") ? "steer" : "followUp" });
  expect(c.getTelegramClient().downloadFile).toHaveBeenCalledTimes(2);
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(2);
  for (const name of retained) expect(name).toMatch(/\.jpg$/);
  expect((await Promise.all(retained.map(name => fs.readFile(path.join(getMediaDir(dir), name), "utf8")))).sort())
    .toEqual(["photos/image10.jpg", "photos/image20.jpg"]);
  expect([...((c as any).albums as Map<string, any>).values()][0].messages).toEqual([]);
});

it.each([undefined, "", " \n\t"])("uses only labels when two image captions are %j", async caption => {
  const f = await start();
  f.pi.sendUserMessage.mockImplementation((content: any) => {
    void f.runtime.onBeforeAgentStart(f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content }, f.ctx));
  });
  await Promise.all([c.processUpdate(image(1, "album", caption)), c.processUpdate(image(2, "album", caption))]);
  expect(f.pi.sendUserMessage).toHaveBeenCalledOnce();
  expect(f.pi.sendUserMessage.mock.calls[0][0]).toEqual([
    { type: "text", text: "[Image#1] [Image#2]" },
    { type: "image", mimeType: "image/jpeg", data: Buffer.from("photos/image1.jpg").toString("base64") },
    { type: "image", mimeType: "image/jpeg", data: Buffer.from("photos/image2.jpg").toString("base64") },
  ]);
});

it("keeps separate albums and later text ordered without combining topics", async () => {
  await start();
  const delivered: { text: string; count: number; thread: number }[] = [];
  for (const thread of [60, 61]) c.registerLocalRoute({ runtimeId: `r${thread}`, sessionId: `s${thread}`, threadId: thread, generation: 1,
    dispatchInbound: async (text, _id, media) => { delivered.push({ text, count: Array.isArray(media) ? media.length : media ? 1 : 0, thread }); return { accepted: true, busy: false }; } });
  const tasks = [
    c.processUpdate(image(1, "same-id", "a", 60)),
    c.processUpdate(telegramUpdate(60, "after")),
    c.processUpdate(image(2, "same-id", "b", 61)),
    c.processUpdate(image(3, "same-id", undefined, 60)),
    c.processUpdate(image(4, "other-album", "c", 60)),
  ];
  await Promise.all(tasks);
  expect(delivered.filter(item => item.thread === 60)).toEqual([
    { text: "a", count: 2, thread: 60 }, { text: "after", count: 0, thread: 60 }, { text: "c", count: 1, thread: 60 },
  ]);
  expect(delivered.filter(item => item.thread === 61)).toEqual([{ text: "b", count: 1, thread: 61 }]);
});

it.each(["download failure", "unsupported member", "too many members"])("rejects the whole album on %s", async reason => {
  const f = await start();
  const one = image(1, "album", "Inspect all");
  const two = image(2);
  if (reason === "unsupported member") {
    delete two.message!.photo;
    two.message!.document = { file_id: "pdf", file_unique_id: "pdf", mime_type: "application/pdf" };
  }
  if (reason === "download failure") vi.mocked(c.getTelegramClient().downloadFile).mockResolvedValueOnce(Buffer.from("one")).mockRejectedValueOnce(new Error("failed"));
  const tasks = [c.processUpdate(one), c.processUpdate(two)];
  if (reason === "too many members") for (let id = 3; id <= 11; id++) tasks.push(c.processUpdate(image(id)));
  await Promise.all(tasks);
  await c.feedback.whenIdle();
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect(c.getTelegramClient().sendMessage).toHaveBeenCalled();
  if (reason === "download failure") expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
  else expect(c.getTelegramClient().downloadFile).not.toHaveBeenCalled();
});

it.each(["stop", "route change", "shutdown"])("cancels buffered albums on %s", async reason => {
  const f = await start();
  const tasks = [c.processUpdate(image(1)), c.processUpdate(image(2))];
  if (reason === "stop") await c.processUpdate(telegramUpdate(50, "/stop"));
  if (reason === "route change") {
    const route = c.getRoutes().get(50)!;
    c.registerLocalRoute({ ...route, generation: route.generation + 1 });
  }
  if (reason === "shutdown") await f.runtime.onSessionShutdown(f.ctx);
  await Promise.all(tasks);
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(c.getTelegramClient().downloadFile).not.toHaveBeenCalled();
});

it("rejects late album members rather than running a second task", async () => {
  await start();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch });
  await c.processUpdate(image(1, "album", "one", 60));
  await c.processUpdate(image(2, "album", undefined, 60));
  await c.feedback.whenIdle();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(c.getTelegramClient().sendMessage).toHaveBeenCalledWith(testConfig.chatId, expect.stringContaining("arrived after collection"), { message_thread_id: 60 }, expect.any(AbortSignal));
});

it("rejects an unauthorized member before it can join a valid album", async () => {
  await start();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch });
  const valid = c.processUpdate(image(1, "album", "valid", 60));
  const invalid = image(2, "album", "bad", 60);
  invalid.message!.from!.id++;
  await c.processUpdate(invalid);
  await valid;
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0][0]).toBe("valid");
  expect(c.getTelegramClient().downloadFile).toHaveBeenCalledTimes(1);
});

it("rejects all members when the first arrives during overload", async () => {
  await start();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const dispatch = vi.fn(async () => { await barrier; return { accepted: true, busy: false }; });
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch });
  const tasks = Array.from({ length: 16 }, () => c.processUpdate(telegramUpdate(60, "blocking")));
  try {
    await c.processUpdate(image(1, "overload", "missing caption", 60));
    expect((c as any).rejectedAlbums.size).toBe(1);
  } finally { release(); await Promise.all(tasks); }
  const count = dispatch.mock.calls.length;
  await c.processUpdate(image(2, "overload", undefined, 60));
  expect(dispatch).toHaveBeenCalledTimes(count);
  expect(c.getTelegramClient().getFile).not.toHaveBeenCalled();
});

it("submits an album above the queue budget intact when the media queue is empty", async () => {
  const f = await start();
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  await f.runtime.onBeforeAgentStart(f.ctx);
  const bytes = Buffer.alloc(13 * 1024 * 1024);
  vi.mocked(c.getTelegramClient().downloadFile).mockResolvedValue(bytes);
  await Promise.all([c.processUpdate(image(1, "large", "both")), c.processUpdate(image(2, "large"))]);
  expect(f.pi.sendMessage).toHaveBeenCalledOnce();
  const content = f.pi.sendMessage.mock.calls[0][0].content;
  expect(content).toHaveLength(3);
  for (const part of content.slice(1)) {
    expect(part.type).toBe("image");
    expect(part.data.length).toBe(Math.ceil(bytes.length / 3) * 4);
  }
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(2);
  for (const name of retained) expect((await fs.readFile(path.join(getMediaDir(dir), name))).equals(bytes)).toBe(true);
});

it.each(["anthropic-messages", "bedrock-converse-stream"])("passes a valid 6 MiB PNG to %s without enforcing provider size limits", async api => {
  const f = await start();
  (f.ctx as any).model = { id: "claude-test", api, input: ["text", "image"] };
  f.pi.sendUserMessage.mockImplementation((content: any) => {
    void f.runtime.onBeforeAgentStart(f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content }, f.ctx));
  });
  const width = 1536, height = 1366;
  const raw = randomFillSync(Buffer.alloc((width * 3 + 1) * height));
  for (let row = 0; row < height; row++) raw[row * (width * 3 + 1)] = 0;
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  expect(png.length).toBeGreaterThan(5 * 1024 * 1024);
  await fs.mkdir(getMediaDir(dir), { recursive: true });
  const file = path.join(getMediaDir(dir), "large.png");
  await fs.writeFile(file, png);
  const result = await f.runtime.handleInboundText("inspect", f.ctx, 1, undefined, { path: file, mimeType: "image/png" });
  expect(result.accepted).toBe(true);
  expect(f.pi.sendUserMessage).toHaveBeenCalledOnce();
  expect(f.pi.sendUserMessage.mock.calls[0][0][1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  expect((await fs.readFile(file)).equals(png)).toBe(true);
});

it.each(["outside", "junction", ...(process.platform === "win32" ? ["case alias"] : [])])("validates cache directory identity for %s", async kind => {
  const f = await start();
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  await f.runtime.onBeforeAgentStart(f.ctx);
  await fs.mkdir(getMediaDir(dir), { recursive: true });
  let file = path.join(getMediaDir(dir), "alias.jpg");
  if (kind === "outside") file = path.join(dir, "outside.jpg");
  await fs.writeFile(file, "image");
  if (kind === "junction") {
    const alias = path.join(dir, "media-alias");
    await fs.symlink(getMediaDir(dir), alias, process.platform === "win32" ? "junction" : "dir");
    file = path.join(alias, "alias.jpg");
  }
  if (kind === "case alias") file = file.toUpperCase();
  const result = await f.runtime.handleInboundText("inspect", f.ctx, 1, "followUp", { path: file, mimeType: "image/jpeg" });
  expect(result.accepted).toBe(kind !== "outside");
  if (kind === "outside") {
    expect(await fs.readFile(file, "utf8")).toBe("image");
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
  } else {
    expect(f.pi.sendMessage).toHaveBeenCalledOnce();
    expect(await fs.readFile(file, "utf8")).toBe("image");
  }
});

it.each(["quit", "reload"])("releases Leader resources when image reading stalls during %s", async reason => {
  const f = await start();
  const read = fs.readFile;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let reading = false;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) { reading = true; await barrier; }
    return (read as any)(...args);
  });
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const receiving = c.processUpdate(image(1));
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    await f.runtime.onSessionShutdown({ reason }, f.ctx);
    await expect(fs.access(path.join(getRuntimeDir(dir), "leader.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((c as any).server).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MEDIA_SHUTDOWN_PENDING"));
  } finally { release(); }
  await receiving;
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("photos/image1.jpg");
});

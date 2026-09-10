import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupStaleMedia, ensureMediaDir, getMediaDir } from "../src/config.js";
import { LeaderCoordinator } from "../src/coordinator.js";
import type { InboundMedia, InboundResult, TelegramUpdate } from "../src/types.js";
import { runtimeFixture, telegramUpdate } from "./helpers.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>() }));
let dir: string;
let fixtures: Awaited<ReturnType<typeof runtimeFixture>>[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-media-retention-"));
  fixtures = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
  await fs.rm(dir, { recursive: true, force: true });
});
async function start() {
  const f = await runtimeFixture(dir, "retention", 50, "startup");
  fixtures.push(f);
  (f.ctx as any).model = { input: ["text", "image"] };
  const c = (f.runtime as any).coordinator as LeaderCoordinator;
  (c as any).options.albumDelayMs = 25;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockImplementation(async id => ({ file_id: id, file_unique_id: id, file_path: `photos/${id}.jpg` }));
  vi.spyOn(client, "downloadFile").mockImplementation(async file => Buffer.from(file));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 99 } as any);
  return { f, c, client };
}
function photo(id: number, group?: string, thread = 60): TelegramUpdate {
  const update = telegramUpdate(thread, "", id);
  delete update.message!.text;
  update.message!.caption = "RETENTION_CAPTION_CANARY";
  update.message!.media_group_id = group;
  update.message!.photo = [{ file_id: `image${id}`, file_unique_id: `image${id}`, width: 1, height: 1 }];
  return update;
}

it.each(["accepted", "busy", "rejected", "throws"])("retains the whole published album after dispatch is %s", async outcome => {
  const { c } = await start();
  let handedOff: InboundMedia[] = [];
  const dispatch = vi.fn((_text: string, _id: number, media?: InboundMedia | InboundMedia[]): Promise<InboundResult> => {
    expect(Array.isArray(media)).toBe(true);
    handedOff = media as InboundMedia[];
    if (outcome === "throws") throw new Error("Synchronous dispatch failure");
    return Promise.resolve({ accepted: outcome === "accepted", busy: outcome === "busy" });
  });
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch });
  await Promise.all([c.processUpdate(photo(1, "album")), c.processUpdate(photo(2, "album"))]);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(handedOff).toHaveLength(2);
  expect((await fs.readdir(getMediaDir(dir))).sort()).toEqual(handedOff.map(media => path.basename(media.path)).sort());
  for (const [index, media] of handedOff.entries()) {
    expect(media.path).toMatch(/\.jpg$/);
    expect(await fs.readFile(media.path, "utf8")).toBe(`photos/image${index + 1}.jpg`);
  }
  await c.stop();
  for (const media of handedOff) await expect(fs.access(media.path)).resolves.toBeUndefined();
});

it.each(["download", "open", "write", "rename"])("cleans the whole undelivered album when its second %s fails", async stage => {
  const { c, client } = await start();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch });
  const failure = Object.assign(new Error("Injected image I/O failure"), { code: "EIO" });
  let operations = 0;
  if (stage === "download") vi.mocked(client.downloadFile).mockResolvedValueOnce(Buffer.from("first")).mockRejectedValueOnce(failure);
  if (stage === "open" || stage === "write") {
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
      const failing = typeof args[0] === "string" && args[0].endsWith(".part") && ++operations === 2;
      if (failing && stage === "open") throw failure;
      const file = await (open as any)(...args);
      if (failing) {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementationOnce(async () => { await write("partial"); throw failure; });
      }
      return file;
    });
  }
  const published: string[] = [];
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (String(source).endsWith(".part")) {
      if (stage === "rename" && ++operations === 2) throw failure;
      await rename(source, target);
      published.push(String(target));
    } else await rename(source, target);
  });
  await Promise.all([c.processUpdate(photo(1, "album")), c.processUpdate(photo(2, "album"))]);
  await c.feedback.whenIdle();
  expect(dispatch).not.toHaveBeenCalled();
  expect(c.getStatus().feedbackError?.code).toBe("EIO");
  expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
  // A publish failure must remove both the earlier completed file and remaining staging files.
  expect(published).toHaveLength(stage === "rename" ? 1 : 0);
});

it.each(["staging", "completed"])("never overwrites or deletes an existing %s file on a basename collision", async kind => {
  const { c } = await start();
  const mediaDir = await ensureMediaDir(dir);
  const id = crypto.randomUUID();
  const existing = path.join(mediaDir, `${id}.jpg${kind === "staging" ? ".part" : ""}`);
  await fs.writeFile(existing, "already owned");
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(id);
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch });
  await c.processUpdate(photo(1));
  expect(dispatch).not.toHaveBeenCalled();
  expect(c.getStatus().feedbackError?.code).toBe("EEXIST");
  expect(await fs.readdir(mediaDir)).toEqual([path.basename(existing)]);
  expect(await fs.readFile(existing, "utf8")).toBe("already owned");
});

it.each(["stop", "route replacement", "shutdown"])("cleans published files when %s precedes the handoff", async change => {
  const { c } = await start();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  const route = { runtimeId: "r", sessionId: "s", threadId: 60, generation: 1, dispatchInbound: dispatch, abortRun: () => true };
  c.registerLocalRoute(route);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename;
  let published: string | undefined;
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    await rename(source, target);
    if (String(source).endsWith(".part")) { published = String(target); await barrier; }
  });
  const input = c.processUpdate(photo(1));
  try {
    await vi.waitFor(() => expect(published).toBeTypeOf("string"));
    expect(await fs.readFile(published!, "utf8")).toBe("photos/image1.jpg");
    if (change === "stop") await c.processUpdate(telegramUpdate(60, "/stop"));
    else if (change === "route replacement") c.registerLocalRoute({ ...route, generation: 2 });
    else await c.stop();
  } finally { release(); }
  await input;
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(dispatch).not.toHaveBeenCalled();
  expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
});

it.each([false, true])("retains images after the Pi admission deadline and subsequent stop (follower=%s)", async follower => {
  const { f, c, client } = await start();
  const target = follower ? await runtimeFixture(dir, "follower", 51, "startup") : f;
  if (follower) fixtures.push(target);
  (target.ctx as any).model = { input: ["text", "image"] };
  const thread = follower ? 51 : 50;
  try {
    await c.processUpdate(photo(1, undefined, thread));
    await c.feedback.whenIdle();
    expect(target.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(client.sendMessage).mock.calls.some(call => call[1].includes("Task admission result unknown"))).toBe(true);
    const retained = await fs.readdir(getMediaDir(dir));
    expect(retained).toHaveLength(1);
    const file = path.join(getMediaDir(dir), retained[0]);
    expect(await fs.readFile(file, "utf8")).toBe("photos/image1.jpg");
    await c.processUpdate(telegramUpdate(thread, "/stop"));
    expect(await fs.readFile(file, "utf8")).toBe("photos/image1.jpg");
    expect(target.pi.sendUserMessage).toHaveBeenCalledOnce();
  } finally {
    await target.runtime.onSessionShutdown(target.ctx);
    if (target.pi.sendUserMessage.mock.calls.length) {
      expect(await target.inInput(() => target.runtime.onInput(target.ctx))).toEqual({ action: "handled" });
    }
  }
});

it("retains files when a real follower accepts images but its IPC acknowledgement is lost", async () => {
  const { c } = await start();
  const follower = await runtimeFixture(dir, "follower", 51, "startup");
  fixtures.push(follower);
  (follower.ctx as any).model = { input: ["text", "image"] };
  vi.mocked(follower.ctx.isIdle).mockReturnValue(false);
  await follower.runtime.onBeforeAgentStart(follower.ctx);
  (c as any).options.requestTimeoutMs = 150;
  const handleFrame = (c as any).handleFrame.bind(c);
  const acknowledgements: unknown[] = [];
  vi.spyOn(c as any, "handleFrame").mockImplementation((socket, state, msg: any) => {
    if (msg.type === "inbound_ack") { acknowledgements.push(msg); return; }
    return handleFrame(socket, state, msg);
  });
  const dispatch = vi.spyOn(c.getRoutes().get(51)!, "dispatchInbound");
  await c.processUpdate(photo(1, undefined, 51));
  expect(acknowledgements).toHaveLength(1);
  expect(dispatch).toHaveResolvedWith(expect.objectContaining({ accepted: false, statusReply: expect.stringContaining("Execution result unknown") }));
  expect(follower.pi.sendMessage).toHaveBeenCalledOnce();
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("photos/image1.jpg");
});

it("retains an unreadable handed-off file and rejects rather than submitting its caption alone", async () => {
  const { f, c } = await start();
  const read = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) {
      throw Object.assign(new Error("Injected read failure"), { code: "EACCES" });
    }
    return (read as any)(...args);
  });
  await c.processUpdate(photo(1, undefined, 50));
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(f.pi.sendMessage).not.toHaveBeenCalled();
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(await read(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("photos/image1.jpg");
});

it.each(["reload", "quit"])("keeps completed files through settlement, %s, new Leader startup and a fresh process read", async reason => {
  const { f, c } = await start();
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  await f.runtime.onBeforeAgentStart(f.ctx);
  await Promise.all([c.processUpdate(photo(1, "album", 50)), c.processUpdate(photo(2, "album", 50))]);
  expect(f.pi.sendMessage).toHaveBeenCalledOnce();
  f.runtime.onMessageStart({ role: "custom", ...f.pi.sendMessage.mock.calls[0][0] }, f.ctx);
  await f.runtime.onAgentSettled(f.ctx);
  const names = (await fs.readdir(getMediaDir(dir))).sort();
  expect(names).toHaveLength(2);
  const files = names.map(name => path.join(getMediaDir(dir), name));
  const expected = await Promise.all(files.map(file => fs.readFile(file, "utf8")));
  const stale = new Date(Date.now() - 365 * 24 * 3600_000);
  for (const file of files) await fs.utimes(file, stale, stale);
  await c.reloadConfig();
  await f.runtime.onSessionShutdown({ reason }, f.ctx);

  const resumed = await runtimeFixture(dir, "retention", 50, reason === "reload" ? "reload" : "startup");
  fixtures.push(resumed);
  const leader = (resumed.runtime as any).coordinator;
  await vi.waitFor(() => expect(leader.mediaCleanupTask).toBeUndefined());
  expect(resumed.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(resumed.pi.sendMessage).not.toHaveBeenCalled();
  await resumed.runtime.onSessionShutdown(resumed.ctx);
  expect((await fs.readdir(getMediaDir(dir))).sort()).toEqual(names);
  const { stdout } = await promisify(execFile)(process.execPath, ["-e",
    "const fs=require('node:fs');process.stdout.write(JSON.stringify(process.argv.slice(1).map(file=>fs.readFileSync(file,'utf8'))));", ...files]);
  expect(JSON.parse(stdout)).toEqual(expected);
  expect([...expected].sort()).toEqual(["photos/image1.jpg", "photos/image2.jpg"]);
  expect((await fs.readdir(path.join(dir, "pi-telegram-mux"))).sort()).toEqual(["config-mutex", "config.json", "media", "runtime"]);
  for (const file of files) expect(await fs.readFile(file, "utf8")).not.toContain("RETENTION_CAPTION_CANARY");
  // Manual deletion is user-owned; maintenance neither restores it nor removes the other image.
  await fs.unlink(files[0]);
  await cleanupStaleMedia(dir);
  await expect(fs.access(files[0])).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(files[1], "utf8")).toBe(expected[1]);
});

it("does not recurse into matching directories or follow junctions during staging maintenance", async () => {
  const mediaDir = await ensureMediaDir(dir);
  const nested = path.join(mediaDir, `${crypto.randomUUID()}.jpg.part`);
  const outside = path.join(dir, "outside");
  await fs.mkdir(nested);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(nested, "keep.jpg"), "nested");
  await fs.writeFile(path.join(outside, "keep.jpg"), "outside");
  const alias = path.join(mediaDir, `${crypto.randomUUID()}.png.part`);
  await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await cleanupStaleMedia(dir, -1);
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(path.join(nested, "keep.jpg"), "utf8")).toBe("nested");
  expect(await fs.readFile(path.join(outside, "keep.jpg"), "utf8")).toBe("outside");
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { inspect, promisify } from "node:util";
import { IpcFollowerClient } from "../src/ipc.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupStaleMedia, ensureMediaDir, getMediaDir, saveConfig } from "../src/config.js";
import { LeaderCoordinator } from "../src/coordinator.js";
import { ConflictError, TelegramApiError, TelegramClient, TelegramDecodeError, TelegramRequestError } from "../src/telegram.js";
import { IPC_PROTOCOL_VERSION } from "../src/types.js";
import { runtimeFixture, telegramUpdate, testConfig } from "./helpers.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
let dir: string;
let coordinators: LeaderCoordinator[];
let fixtures: Awaited<ReturnType<typeof runtimeFixture>>[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-media-regression-"));
  coordinators = [];
  fixtures = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
  for (const c of coordinators) await c.stop();
  await fs.rm(dir, { recursive: true, force: true });
});
function photo(thread = 50) {
  const update = telegramUpdate(thread, "caption");
  delete update.message!.text;
  update.message!.caption = "caption";
  update.message!.photo = [{ file_id: "image", file_unique_id: "image", width: 100, height: 100 }];
  return update;
}
async function coordinator() {
  const c = new LeaderCoordinator(testConfig, dir);
  coordinators.push(c);
  await c.start();
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  return c;
}
async function fixture() {
  const f = await runtimeFixture(dir, "media", 50, "startup");
  fixtures.push(f);
  (f.ctx as any).model = { input: ["text", "image"] };
  return f;
}
async function cache(size = 8, unfinished = false) {
  const file = path.join(await ensureMediaDir(dir), `${randomUUID()}.jpg${unfinished ? ".part" : ""}`);
  await fs.writeFile(file, Buffer.alloc(size));
  return { path: file, mimeType: "image/jpeg" };
}

it.each(["disconnect", "generation", "config"])("does not submit after %s during image validation", async change => {
  const f = await fixture();
  const media = await cache();
  const open = fs.open;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    if (args[0] === media.path && args[1] === "r") await barrier;
    return (open as any)(...args);
  });
  const task = f.runtime.handleInboundText("caption", f.ctx, 1, undefined, media);
  await vi.waitFor(() => expect(spy).toHaveBeenCalled());
  if (change === "disconnect") f.runtime.handleTgDisconnect(f.ctx);
  else if (change === "generation") (f.runtime as any).generation++;
  else (f.runtime as any).config = { ...(f.runtime as any).config, allowedUserId: 456 };
  release();
  expect((await task).accepted).toBe(false);
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect(await fs.readFile(media.path)).toEqual(Buffer.alloc(8));
});

it("fences a route mutated during download and cleans the undelivered image", async () => {
  const c = await coordinator();
  const old = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: old });
  let release!: (buffer: Buffer) => void;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const task = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const replacement = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 2, dispatchInbound: replacement });
  release(Buffer.from("image"));
  await task;
  expect(old).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
});

it("keeps stop responsive, preserves topic order, and bounds pending media", async () => {
  const c = await coordinator();
  const order: string[] = [];
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: async text => {
    order.push(text); return { accepted: false, busy: true };
  } });
  const stop = vi.fn(() => true);
  c.registerLocalRoute({ runtimeId: "r2", sessionId: "s2", threadId: 51, generation: 1, dispatchInbound: vi.fn(), abortRun: stop });
  let release!: (buffer: Buffer) => void;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const image = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const text = c.processUpdate(telegramUpdate(50, "later"));
  const queued = Array.from({ length: 30 }, () => c.processUpdate(photo()));
  expect((c as any).pendingUpdates).toBe(16);
  await c.processUpdate(telegramUpdate(51, "/stop"));
  expect(stop).toHaveBeenCalledOnce();
  expect(order).toEqual([]);
  release(Buffer.from("image"));
  await Promise.all([image, text, ...queued]);
  expect(order.slice(0, 2)).toEqual(["caption", "later"]);
  expect(order).toHaveLength(16);
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(15);
  for (const name of retained) {
    expect(name).toMatch(/\.jpg$/);
    expect(await fs.readFile(path.join(getMediaDir(dir), name), "utf8")).toBe("image");
  }
});

it("translates abort errors without stopping polling", async () => {
  const c = await coordinator();
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: vi.fn(), abortRun: () => { throw new Error("abort failed"); } });
  await c.processUpdate(telegramUpdate(50, "/stop"));
  expect(c.isRunning()).toBe(true);
  expect(c.getStatus().feedbackError?.message).toBe("abort failed");
});

it.each(["image/svg+xml", "image/tiff", "application/pdf"])("does not execute an unsupported %s attachment caption", async mime_type => {
  const c = await coordinator();
  const dispatch = vi.fn();
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch });
  const update = photo();
  delete update.message!.photo;
  update.message!.document = { file_id: "file", file_unique_id: "file", mime_type };
  await c.processUpdate(update);
  expect(dispatch).not.toHaveBeenCalled();
  expect(c.getTelegramClient().getFile).not.toHaveBeenCalled();
});

it("queues multiple large image paths without reading bytes and retains delivery identity", async () => {
  const f = await fixture();
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  await f.runtime.onBeforeAgentStart(f.ctx);
  const media = await cache(13 * 1024 * 1024);
  const second = await cache(13 * 1024 * 1024);
  const read = vi.spyOn(fs, "readFile");
  expect((await f.runtime.handleInboundText("one", f.ctx, 1, "followUp", media)).accepted).toBe(true);
  expect((await f.runtime.handleInboundText("two", f.ctx, 2, "followUp", second)).accepted).toBe(true);
  expect(read).not.toHaveBeenCalled();
  const [one, two] = f.pi.sendMessage.mock.calls.map(call => call[0]);
  expect(one.content).toBe(`[Image#1] ${media.path}\n\none`);
  expect(two.content).toBe(`[Image#1] ${second.path}\n\ntwo`);
  expect(one.details.deliveryId).not.toBe(two.details.deliveryId);
  f.runtime.onMessageStart({ role: "custom", ...one }, f.ctx);
  expect((f.runtime as any).queuedInputs.has(two.details.deliveryId)).toBe(true);
  expect((f.runtime as any).queuedInputs.has(one.details.deliveryId)).toBe(false);
});

it("bounds image-path queue count rather than image bytes and releases capacity on consumption", async () => {
  const f = await fixture();
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  await f.runtime.onBeforeAgentStart(f.ctx);
  const size = 33 * 1024 * 1024;
  const large = await cache(size);
  expect((await f.runtime.handleInboundText("large", f.ctx, 1, "followUp", large)).accepted).toBe(true);
  const sent = f.pi.sendMessage.mock.calls[0][0];
  expect(sent.content).toBe(`[Image#1] ${large.path}\n\nlarge`);
  expect((await fs.stat(large.path)).size).toBe(size);

  const small = await cache();
  const read = vi.spyOn(fs, "readFile");
  for (let i = 1; i < 64; i++) expect((await f.runtime.handleInboundText("later", f.ctx, i + 1, "followUp", small)).accepted).toBe(true);
  expect(await f.runtime.handleInboundText("overload", f.ctx, 65, "followUp", small)).toEqual({ accepted: false, busy: true });
  expect(read).not.toHaveBeenCalled();
  expect(await fs.readFile(small.path)).toEqual(Buffer.alloc(8));

  f.runtime.onMessageStart({ role: "custom", ...sent }, f.ctx);
  const fresh = await cache();
  expect((await f.runtime.handleInboundText("fresh", f.ctx, 3, "steer", fresh)).accepted).toBe(true);
});

it("propagates unexpected staging cleanup errors but permits missing-file races", async () => {
  const media = await cache(8, true);
  const stale = new Date(Date.now() - 7200_000);
  await fs.utimes(media.path, stale, stale);
  const unlink = vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("locked"), { code: "EBUSY" }));
  await expect(cleanupStaleMedia(dir)).rejects.toMatchObject({ code: "EBUSY" });
  unlink.mockRejectedValue(Object.assign(new Error("gone"), { code: "ENOENT" }));
  await expect(cleanupStaleMedia(dir)).resolves.toBeUndefined();
});

it("honors download retry_after and prevents repeated network requests", async () => {
  const client = new TelegramClient({ botToken: "test" });
  const notify = vi.fn();
  client.onRateLimit = notify;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 60 } }), {
    status: 429, headers: { "content-type": "application/json", "retry-after": "30" },
  }));
  vi.stubGlobal("fetch", fetch);
  await expect(client.downloadFile("photos/test.jpg")).rejects.toMatchObject({ retryAfter: 60 });
  expect(client.getRemainingPauseMs()).toBeGreaterThan(59000);
  expect(notify).toHaveBeenCalled();
  await expect(client.downloadFile("photos/test.jpg")).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

it("downloads a chunked image above 20 MiB and releases request supervision", async () => {
  let signal: AbortSignal | undefined;
  const chunk = new Uint8Array(11 * 1024 * 1024).fill(9);
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    } }));
  }));
  const downloaded = await new TelegramClient({ botToken: "test" }).downloadFile("photos/test.jpg");
  expect(downloaded.length).toBe(chunk.length * 2);
  expect(downloaded[0]).toBe(9);
  expect(downloaded.at(-1)).toBe(9);
  expect(signal?.aborted).toBe(true);
});

it("fails malformed download 429 JSON without retaining response-body excerpts", async () => {
  const canary = "PRIVATE_RESPONSE_CANARY";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(canary, { status: 429, headers: { "content-type": "application/json" } })));
  const client = new TelegramClient({ botToken: "test" });
  await expect(client.downloadFile("photos/test.jpg")).rejects.toSatisfy(error => {
    expect(error).toBeInstanceOf(TelegramDecodeError);
    expect(error.code).toBe("TELEGRAM_DECODE_ERROR");
    expect(inspect(error, { depth: 10 })).not.toContain(canary);
    return true;
  });
  expect(client.getRemainingPauseMs()).toBeGreaterThan(0);
});

it("does not broadcast malformed download response content through runtime diagnostics", async () => {
  const f = await fixture();
  const c = (f.runtime as any).coordinator as LeaderCoordinator;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  const canary = "PRIVATE_RESPONSE_CANARY";
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).includes("/file/bot")
    ? new Response(canary, { status: 429, headers: { "content-type": "application/json" } }) : fetch(url, init)));
  await c.processUpdate(photo());
  expect(c.getStatus().feedbackError?.code).toBe("TELEGRAM_DECODE_ERROR");
  expect(inspect({ status: c.getStatus(), notifications: f.ui.notify.mock.calls, feedback: vi.mocked(client.sendMessage).mock.calls }, { depth: 10 })).not.toContain(canary);
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
});

it("still bounds download error envelopes independently of image size", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(JSON.stringify({ ok: false, description: "x".repeat(8192) }), {
      status: 429, headers: { "content-type": "application/json" },
    });
  }));
  await expect(new TelegramClient({ botToken: "test" }).downloadFile("photos/test.jpg")).rejects.toBeInstanceOf(TelegramDecodeError);
  expect(signal?.aborted).toBe(true);
});

it("periodically cleans orphaned staging files but preserves completed images", async () => {
  const interval = vi.spyOn(globalThis, "setInterval");
  const c = await coordinator();
  await vi.waitFor(() => expect((c as any).mediaCleanupTask).toBeUndefined());
  const media = await cache();
  const unfinished = await cache(8, true);
  const stale = new Date(Date.now() - 7200_000);
  await fs.utimes(media.path, stale, stale);
  await fs.utimes(unfinished.path, stale, stale);
  const maintenance = interval.mock.calls.find(call => call[1] === 60_000)![0] as () => void;
  maintenance();
  await vi.waitFor(() => expect((c as any).mediaCleanupTask).toBeUndefined());
  expect(await fs.readdir(getMediaDir(dir))).toEqual([path.basename(media.path)]);
  expect(await fs.readFile(media.path)).toEqual(Buffer.alloc(8));
});

it("does not apply a delayed dispatch result to a replacement route", async () => {
  const c = await coordinator();
  let release!: (value: any) => void;
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1,
    dispatchInbound: () => new Promise(resolve => { release = resolve; }) });
  const task = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 2, dispatchInbound: vi.fn() });
  release({ accepted: true, busy: false, inputMode: "steer", inputModeRevision: 100 });
  await task;
  expect(c.getInputMode()).toBe("followUp");
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("image");
});

it("keeps the actual poll loop responsive while downloading", async () => {
  const c = new LeaderCoordinator(testConfig, dir);
  coordinators.push(c);
  const client = c.getTelegramClient();
  const original = client.getUpdates.bind(client);
  let first = true;
  vi.spyOn(client, "getUpdates").mockImplementation(options => {
    if (first) { first = false; return Promise.resolve([photo(), telegramUpdate(51, "/stop", 2)]); }
    return original(options);
  });
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  let release!: (value: Buffer) => void;
  vi.spyOn(client, "downloadFile").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 1 } as any);
  const stop = vi.fn(() => true);
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: async () => ({ accepted: false, busy: true }) });
  c.registerLocalRoute({ runtimeId: "r2", sessionId: "s2", threadId: 51, generation: 1, dispatchInbound: vi.fn(), abortRun: stop });
  await c.start();
  try { await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce()); }
  finally { release?.(Buffer.from("image")); }
});

it("rejects unrouted text rather than delivering it to a replacement session", async () => {
  const c = await coordinator();
  const old = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "old", sessionId: "old", threadId: 50, generation: 1, dispatchInbound: old });
  let release!: (value: Buffer) => void;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const downloading = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  try {
    c.unregisterLocalRoute(50, "old");
    const unrouted = c.processUpdate(telegramUpdate(50, "must not reach replacement"));
    expect((c as any).pendingUpdates).toBe(1);
    const replacement = vi.fn(async () => ({ accepted: true, busy: false }));
    c.registerLocalRoute({ runtimeId: "new", sessionId: "new", threadId: 50, generation: 1, dispatchInbound: replacement });
    release(Buffer.from("image"));
    await Promise.all([downloading, unrouted]);
    expect(old).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  } finally {
    release(Buffer.from("image"));
    await downloading;
  }
});

it("coalesces burst overload feedback without poisoning other topics", async () => {
  const c = await coordinator();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const dispatch = vi.fn(async () => { await barrier; return { accepted: true, busy: false }; });
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch });
  c.registerLocalRoute({ runtimeId: "other", sessionId: "other", threadId: 51, generation: 1, dispatchInbound: vi.fn() });
  const burst = Array.from({ length: 100 }, (_, n) => c.processUpdate(telegramUpdate(50, `task ${n}`, n + 1)));
  try {
    expect((c as any).pendingUpdates).toBe(16);
    expect(c.feedback.size).toBeLessThanOrEqual(1);
    await c.feedback.whenIdle();
    // A second burst while still saturated must not enqueue another rejection per input.
    await Promise.all(Array.from({ length: 100 }, () => c.processUpdate(telegramUpdate(50, "more"))));
    await c.feedback.whenIdle();
    expect(vi.mocked(c.getTelegramClient().sendMessage).mock.calls.filter(call => call[1].includes("queue is full"))).toHaveLength(1);
    expect(c.feedback.error).toBeNull();
    await c.processUpdate(telegramUpdate(51, "/status"));
    await c.feedback.whenIdle();
    expect(c.getTelegramClient().sendMessage).toHaveBeenLastCalledWith(testConfig.chatId, expect.stringContaining("Topic: Online"), { message_thread_id: 51 }, expect.any(AbortSignal));
  } finally {
    release();
    await Promise.all(burst);
  }
  expect(dispatch).toHaveBeenCalledTimes(16);
  expect(c.feedback.error).toBeNull();
});

it.each(["user", "chat", "bot", "missing message"])("rejects unauthorized callback %s before quota accounting", async invalid => {
  const c = await coordinator();
  const stop = vi.fn(() => true);
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: vi.fn(), abortRun: stop });
  const message = telegramUpdate(50, "menu").message!;
  const query = { id: "q", from: { id: testConfig.allowedUserId, is_bot: false, first_name: "User" }, message: message as typeof message | undefined, data: "mux:000000000000000000000000:0" };
  if (invalid === "user") query.from.id++;
  if (invalid === "chat") message.chat.id--;
  if (invalid === "bot") query.from.is_bot = true;
  if (invalid === "missing message") query.message = undefined;
  const tasks = Array.from({ length: 100 }, (_, update_id) => c.processUpdate({ update_id, callback_query: query }));
  expect((c as any).pendingUpdates).toBe(0);
  await c.processUpdate(telegramUpdate(50, "/stop"));
  expect(stop).toHaveBeenCalledOnce();
  await Promise.all(tasks);
});

it.each([" /stop", "\t/status \n"])("bypasses a saturated download queue for normalized command %j", async command => {
  const c = await coordinator();
  const stop = vi.fn(() => true);
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1,
    dispatchInbound: async () => ({ accepted: true, busy: false }), abortRun: stop });
  let release!: (value: Buffer) => void;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const downloading = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const queued = Array.from({ length: 15 }, () => c.processUpdate(telegramUpdate(50, "later")));
  try {
    expect((c as any).pendingUpdates).toBe(16);
    await c.processUpdate(telegramUpdate(50, command));
    await c.feedback.whenIdle();
    if (command.trim() === "/stop") expect(stop).toHaveBeenCalledOnce();
    else expect(c.getTelegramClient().sendMessage).toHaveBeenCalledWith(testConfig.chatId, expect.stringContaining("Topic: Online"), { message_thread_id: 50 }, expect.any(AbortSignal));
  } finally {
    release(Buffer.from("image"));
    await Promise.all([downloading, ...queued]);
  }
});

it.each([false, true])("stop invalidates downloads and queued inputs even when abort fails: %s", async abortFails => {
  const c = await coordinator();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch,
    abortRun: () => { if (abortFails) throw new Error("abort failure"); return true; } });
  let release!: (value: Buffer) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce((_file, incomingSignal) => {
    signal = incomingSignal;
    return new Promise(resolve => { release = resolve; });
  });
  const downloading = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const queued = c.processUpdate(telegramUpdate(50, "old queued task"));
  try {
    await c.processUpdate(telegramUpdate(50, " /stop"));
    expect(signal?.aborted).toBe(true);
  } finally { release(Buffer.from("image")); }
  await Promise.all([downloading, queued]);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
  await c.processUpdate(telegramUpdate(50, "fresh task"));
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0][0]).toBe("fresh task");
});

it.each(["message", "getFile", "header", "stream"])("does not impose an image size limit at %s", async stage => {
  const c = await coordinator();
  const client = c.getTelegramClient();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch });
  const update = photo();
  const largeSize = 20 * 1024 * 1024 + 1;
  if (stage === "message") update.message!.photo![0].file_size = largeSize;
  if (stage === "getFile") vi.mocked(client.getFile).mockResolvedValueOnce({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg", file_size: largeSize });
  if (stage === "header" || stage === "stream") {
    const download = TelegramClient.prototype.downloadFile;
    vi.mocked(client.downloadFile).mockImplementationOnce((...args) => download.apply(client, args));
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).includes("/file/bot")
      ? new Response(new Uint8Array(largeSize), { headers: stage === "header" ? { "content-length": String(largeSize) } : {} })
      : fetch(url, init)));
  }
  await c.processUpdate(update);
  await c.feedback.whenIdle();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(c.getStatus().feedbackError).toBeUndefined();
  expect(c.feedback.error).toBeNull();
  expect(client.sendMessage).not.toHaveBeenCalled();
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatch(/\.jpg$/);
  expect((await fs.stat(path.join(getMediaDir(dir), retained[0]))).size).toBe(stage === "header" || stage === "stream" ? largeSize : 5);
  await c.processUpdate(photo());
  await c.processUpdate(telegramUpdate(50, "valid text"));
  expect(dispatch).toHaveBeenCalledTimes(3);
  expect(c.getStatus().feedbackError).toBeUndefined();
  expect(c.feedback.error).toBeNull();
});

it("sends absolute media references over IPC from a relative agent directory", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  dir = await fs.mkdtemp(path.join(process.cwd(), ".media-ipc-test-"));
  const relative = path.relative(process.cwd(), dir);
  expect(path.isAbsolute(relative)).toBe(false);
  const c = new LeaderCoordinator(testConfig, relative);
  coordinators.push(c);
  const info = await c.start();
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("cross-directory image"));
  const follower = new IpcFollowerClient(info.port, info.capability, "other-cwd");
  const otherCwd = path.join(dir, "other-cwd");
  await fs.mkdir(otherCwd);
  let received = false;
  follower.setInboundHandler(async msg => {
    expect(path.isAbsolute(msg.media!.path)).toBe(true);
    // Use the same cache containment check from a separate process with another cwd.
    const { stdout } = await promisify(execFile)(process.execPath, ["-e",
      "const fs=require('node:fs'),p=require('node:path');if(p.dirname(p.resolve(process.argv[1]))!==p.resolve(process.argv[2]))throw Error('Invalid cache reference');process.stdout.write(fs.readFileSync(process.argv[1]));",
      msg.media!.path, getMediaDir(dir)], { cwd: otherCwd });
    expect(stdout).toBe("cross-directory image");
    received = true;
    return { accepted: true, busy: false };
  });
  try {
    await follower.connect();
    await follower.register({ runtimeId: "other-cwd", sessionId: "s", threadId: 50, generation: 1 });
    await c.processUpdate(photo());
    expect(received).toBe(true);
    const retained = await fs.readdir(getMediaDir(dir));
    expect(retained).toHaveLength(1);
    expect(await fs.readFile(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("cross-directory image");
  } finally { follower.close(); }
});

it.each(["leader-idle", "leader-busy", "follower-idle", "follower-busy"])("stop prevents submission after paused image validation on %s", async scenario => {
  const leader = await fixture();
  const follower = await runtimeFixture(dir, "follower", 51, "startup");
  fixtures.push(follower);
  (follower.ctx as any).model = { input: ["text", "image"] };
  const target = scenario.startsWith("follower") ? follower : leader;
  const other = target === leader ? follower : leader;
  const thread = target === leader ? 50 : 51;
  const c = (leader.runtime as any).coordinator as LeaderCoordinator;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  if (scenario.endsWith("busy")) {
    vi.mocked(target.ctx.isIdle).mockReturnValue(false);
    await target.runtime.onBeforeAgentStart(target.ctx);
  }
  const open = fs.open;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let reading = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    if (args[1] === "r" && typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) {
      reading = true;
      await barrier;
    }
    return (open as any)(...args);
  });
  const receiving = c.processUpdate(photo(thread));
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    await c.processUpdate(telegramUpdate(thread, "/stop", 2));
    expect(target.ctx.abort).toHaveBeenCalledOnce();
    expect(other.ctx.abort).not.toHaveBeenCalled();
  } finally { release(); }
  await receiving;
  expect(target.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(target.pi.sendMessage).not.toHaveBeenCalled();
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("image");
  // A new input captures the replacement cancellation signal.
  vi.mocked(target.ctx.isIdle).mockReturnValue(false);
  if (!scenario.endsWith("busy")) await target.runtime.onBeforeAgentStart(target.ctx);
  await c.processUpdate(telegramUpdate(thread, "fresh task", 3));
  expect(target.pi.sendMessage).toHaveBeenCalledOnce();
});

it.each([
  ["download", new TelegramRequestError("TELEGRAM_TIMEOUT", "Download timed out")],
  ["getFile", new TelegramApiError("File unavailable", 400)],
  ["download", new TelegramApiError("File unavailable", 404)],
] as const)("keeps %s refusal %s input-scoped without invalidating healthy sessions", async (stage, error) => {
  const leader = await fixture();
  const follower = await runtimeFixture(dir, "follower", 51, "startup");
  fixtures.push(follower);
  const c = (leader.runtime as any).coordinator as LeaderCoordinator;
  const client = c.getTelegramClient();
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  const getFile = vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  const download = vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
  if (stage === "getFile") getFile.mockRejectedValueOnce(error);
  else download.mockRejectedValueOnce(error);
  const generations = [leader.runtime.getGeneration(), follower.runtime.getGeneration()];
  const reload = vi.spyOn(c, "reloadConfig");
  await c.processUpdate(photo());
  await c.feedback.whenIdle();
  expect(c.getStatus().feedbackError).toBeUndefined();
  expect(c.getStatus().interactionError).toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED" });
  expect(leader.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(client.sendMessage).toHaveBeenCalledWith(testConfig.chatId, expect.stringContaining("Failed to download image"), { message_thread_id: 50 }, expect.any(AbortSignal));
  await vi.waitFor(() => expect((follower.runtime as any).followerClient.getStatus().interactionError?.code).toBe("MEDIA_DOWNLOAD_FAILED"));
  expect((follower.runtime as any).followerClient.getStatus().feedbackError).toBeUndefined();
  vi.mocked(leader.ctx.isIdle).mockReturnValue(false);
  await leader.runtime.onBeforeAgentStart(leader.ctx);
  await c.processUpdate(photo());
  expect(leader.pi.sendMessage).toHaveBeenCalledOnce();
  await c.processUpdate(telegramUpdate(50, "valid text", 3));
  expect(leader.pi.sendMessage).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect((follower.runtime as any).followerClient.getStatus().interactionError).toBeUndefined());
  expect(c.getStatus().feedbackError).toBeUndefined();
  expect(c.getStatus().interactionError).toBeUndefined();
  expect([leader.runtime.getGeneration(), follower.runtime.getGeneration()]).toEqual(generations);
  expect(reload).not.toHaveBeenCalled();
  expect(leader.runtime.hasActiveTransport()).toBe(true);
  expect(follower.runtime.hasActiveTransport()).toBe(true);
});

it.each([
  new TelegramApiError("Unauthorized", 401),
  new TelegramApiError("Forbidden", 403),
  new TelegramDecodeError("Malformed Telegram envelope"),
  Object.assign(new Error("Unexpected I/O failure"), { code: "EIO" }),
])("preserves shared download failure signals for %s", async error => {
  const c = await coordinator();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch });
  vi.mocked(c.getTelegramClient().getFile).mockRejectedValueOnce(error);
  await c.processUpdate(photo());
  expect(dispatch).not.toHaveBeenCalled();
  expect(c.getStatus().feedbackError?.code).toBe(error.code);
  expect(c.getStatus().interactionError).toBeUndefined();
  await c.processUpdate(photo());
  expect(dispatch).toHaveBeenCalledOnce();
  // A successful file fetch must not hide a genuine auth/protocol/I/O failure.
  expect(c.getStatus().feedbackError?.code).toBe(error.code);
});

it("allows 3.5-second image validation followed by 1.7-second admission over follower IPC", async () => {
  const leader = await fixture();
  const follower = await runtimeFixture(dir, "follower", 51, "startup");
  fixtures.push(follower);
  (follower.ctx as any).model = { input: ["text", "image"] };
  const c = (leader.runtime as any).coordinator as LeaderCoordinator;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
  const feedback = vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    if (args[1] === "r" && typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) await new Promise(resolve => setTimeout(resolve, 3500));
    return (open as any)(...args);
  });
  const captureInput = follower.pi.sendUserMessage.getMockImplementation()!;
  let lifecycle: Promise<void> | undefined;
  follower.pi.sendUserMessage.mockImplementation((content: any) => {
    captureInput();
    lifecycle = (async () => {
      await new Promise(resolve => setTimeout(resolve, 1700));
      await follower.inInput(async () => {
        await follower.runtime.onBeforeAgentStart(follower.ctx);
        follower.runtime.onMessageStart({ role: "user", content }, follower.ctx);
      });
    })();
  });
  const ipc = (follower.runtime as any).followerClient;
  const admission = vi.spyOn(follower.runtime, "handleInboundText");
  try {
    await c.processUpdate(photo(51));
    await lifecycle;
    await c.feedback.whenIdle();
    expect(admission).toHaveResolvedWith({ accepted: true, busy: false });
    expect(follower.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(ipc.isConnected()).toBe(true);
    expect((follower.runtime as any).followerClient).toBe(ipc);
    expect(feedback.mock.calls.some(call => call[1].includes("Execution result unknown"))).toBe(false);
    expect(c.getRoutes().has(51)).toBe(true);
    await c.processUpdate(telegramUpdate(51, "/stop", 2));
    expect(follower.ctx.abort).toHaveBeenCalledOnce();
  } finally { await lifecycle; }
}, 12000);

it("does not retain a cancelled admission or release its replacement after reload", async () => {
  const f = await fixture();
  const c = (f.runtime as any).coordinator as LeaderCoordinator;
  const hooks: (() => ReturnType<typeof f.runtime.onInput>)[] = [];
  f.pi.sendUserMessage.mockImplementation(() => { hooks.push(AsyncLocalStorage.bind(() => f.runtime.onInput(f.ctx))); });
  const old = f.runtime.handleInboundText("old", f.ctx);
  await c.reloadConfig();
  expect((await old).accepted).toBe(false);
  expect((f.runtime as any).pendingInput).toBeUndefined();
  const fresh = f.runtime.handleInboundText("fresh", f.ctx);
  const admission = (f.runtime as any).pendingInput;
  expect(admission).toBeDefined();
  expect(await hooks[0]()).toEqual({ action: "handled" });
  expect((f.runtime as any).pendingInput).toBe(admission);
  expect(await hooks[1]()).toBeUndefined();
  await (f.runtime as any).inputOrigin.run(admission, () => f.runtime.onBeforeAgentStart(f.ctx));
  f.runtime.onMessageStart({ role: "user", content: "fresh" }, f.ctx);
  expect((await fresh).accepted).toBe(true);
});

it.each([401, 409])("cancels pending image dispatch after terminal polling HTTP %s", async code => {
  const c = new LeaderCoordinator(testConfig, dir);
  coordinators.push(c);
  const client = c.getTelegramClient();
  let failPoll!: (error: Error) => void;
  vi.spyOn(client, "getUpdates").mockImplementation(() => new Promise((_resolve, reject) => { failPoll = reject; }));
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  let release!: (buffer: Buffer) => void;
  vi.spyOn(client, "downloadFile").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await c.start();
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch });
  const receiving = c.processUpdate(photo());
  try {
    await vi.waitFor(() => { expect(failPoll).toBeTypeOf("function"); expect(release).toBeTypeOf("function"); });
    failPoll(code === 409 ? new ConflictError("Polling conflict") : new TelegramApiError("Unauthorized", 401));
    await vi.waitFor(() => expect(c.getStatus().polling).toBe(code === 409 ? "conflict" : "error"));
    await receiving;
    expect((c as any).pendingUpdates).toBe(0);
    await c.processUpdate(telegramUpdate(50, "cannot dispatch with a broken stop channel"));
    expect(dispatch).not.toHaveBeenCalled();
  } finally { release(Buffer.from("image")); }
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(dispatch).not.toHaveBeenCalled();
  expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
});

it.each(["stop", "reload"])("releases cancelled capacity exactly once after %s without waiting for stalled I/O", async change => {
  const c = await coordinator();
  await saveConfig(dir, testConfig);
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  const route = { runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: dispatch, abortRun: () => true };
  c.registerLocalRoute(route);
  let release!: (buffer: Buffer) => void;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const old = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const queued = Array.from({ length: 15 }, () => c.processUpdate(telegramUpdate(50, "stale")));
  expect((c as any).pendingUpdates).toBe(16);
  let finishFresh!: (result: any) => void;
  try {
    if (change === "stop") await c.processUpdate(telegramUpdate(50, "/stop"));
    else { await c.reloadConfig(); c.registerLocalRoute({ ...route, generation: 2 }); }
    await Promise.all([old, ...queued]);
    expect((c as any).pendingUpdates).toBe(0);
    dispatch.mockImplementationOnce(() => new Promise(resolve => { finishFresh = resolve; }));
    const fresh = c.processUpdate(telegramUpdate(50, "fresh"));
    await vi.waitFor(() => expect(finishFresh).toBeTypeOf("function"));
    const tail = (c as any).inputQueues.get(50);
    release(Buffer.from("image"));
    await vi.waitFor(() => expect((c as any).inputWork.size).toBe(1));
    expect((c as any).pendingUpdates).toBe(1);
    expect((c as any).inputQueues.get(50)).toBe(tail);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("fresh", expect.any(Number), undefined, expect.any(AbortSignal));
    finishFresh({ accepted: true, busy: false });
    await fresh;
    expect((c as any).pendingUpdates).toBe(0);
    expect((c as any).inputQueues.size).toBe(0);
  } finally { release(Buffer.from("image")); finishFresh?.({ accepted: false, busy: true }); }
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(await fs.readdir(getMediaDir(dir))).toEqual([]);
});

it.each(["stop", "reload"])("admits a fresh image after %s while cancelled cache validation remains stalled", async change => {
  const f = await fixture();
  const c = (f.runtime as any).coordinator as LeaderCoordinator;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  const open = fs.open;
  const releases: (() => void)[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    if (args[1] === "r" && typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) {
      await new Promise<void>(resolve => { releases.push(resolve); });
    }
    return (open as any)(...args);
  });
  const old = c.processUpdate(photo());
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    if (change === "stop") await c.processUpdate(telegramUpdate(50, "/stop"));
    else await c.reloadConfig();
    await old;
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await f.runtime.onBeforeAgentStart(f.ctx);
    // Reload replaced the Telegram client; mock only the new image endpoints.
    if (change === "reload") {
      vi.spyOn(c.getTelegramClient(), "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
      vi.spyOn(c.getTelegramClient(), "downloadFile").mockResolvedValue(Buffer.from("image"));
      vi.spyOn(c.getTelegramClient(), "sendMessage").mockResolvedValue({ message_id: 100 } as any);
    }
    const fresh = c.processUpdate(photo());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const reservation = (f.runtime as any).mediaValidating;
    const tail = (c as any).inputQueues.get(50);
    releases[0]();
    await vi.waitFor(() => expect((c as any).inputWork.size).toBe(1));
    expect((f.runtime as any).mediaValidating).toBe(reservation);
    expect((c as any).inputQueues.get(50)).toBe(tail);
    expect((c as any).pendingUpdates).toBe(1);
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    releases[1]();
    await fresh;
    expect(f.pi.sendMessage).toHaveBeenCalledOnce();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect((c as any).pendingUpdates).toBe(0);
    const retained = await fs.readdir(getMediaDir(dir));
    expect(retained).toHaveLength(2);
    for (const name of retained) {
      expect(name).toMatch(/\.jpg$/);
      expect(await fs.readFile(path.join(getMediaDir(dir), name), "utf8")).toBe("image");
    }
  } finally { for (const release of releases) release(); }
});

it("reports detached cleanup failures without poisoning the replacement lifecycle", async () => {
  const c = await coordinator();
  c.registerLocalRoute({ runtimeId: "r", sessionId: "s", threadId: 50, generation: 1, dispatchInbound: vi.fn(), abortRun: () => true });
  let release!: (buffer: Buffer) => void;
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const receiving = c.processUpdate(photo());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("Cleanup locked"), { code: "EBUSY" }));
  await c.processUpdate(telegramUpdate(50, "/stop"));
  await receiving;
  release(Buffer.from("image"));
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(unlink).toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("[pi-telegram-mux] INPUT_CLEANUP_FAILED:", expect.objectContaining({ message: "Cleanup locked" }));
  expect(c.getStatus().feedbackError).toBeUndefined();
  expect((c as any).pendingUpdates).toBe(0);
});

it("isolates media-capable IPC from legacy v5", () => {
  expect(IPC_PROTOCOL_VERSION).toBe(6);
});

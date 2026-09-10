import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { ConflictError, TelegramApiError, TelegramClient } from "../src/telegram.js";
import { getMediaDir } from "../src/config.js";
import { runtimeFixture, telegramUpdate } from "./helpers.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
let dir: string;
let fixtures: Awaited<ReturnType<typeof runtimeFixture>>[];
const releases: (() => void)[] = [];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-cancel-contract-")); fixtures = []; });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
async function setup(follower = false) {
  const leader = await runtimeFixture(dir, "leader", 50, "startup"); fixtures.push(leader);
  const target = follower ? await runtimeFixture(dir, "follower", 51, "startup") : leader;
  if (follower) fixtures.push(target);
  (target.ctx as any).model = { input: ["text", "image"] };
  const c = (leader.runtime as any).coordinator as LeaderCoordinator;
  const client = c.getTelegramClient();
  vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
  vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
  vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
  return { leader, target, c, thread: follower ? 51 : 50 };
}
function photo(thread: number) {
  const update = telegramUpdate(thread, "caption");
  delete update.message!.text;
  update.message!.photo = [{ file_id: "image", file_unique_id: "image", width: 1, height: 1 }];
  return update;
}

it.each([false, true].flatMap(follower => [401, 409].map(code => ({ follower, code }))))("revokes cached image submission on terminal polling $code (follower=$follower)", async ({ follower, code }) => {
  let failPoll!: (error: Error) => void;
  vi.spyOn(TelegramClient.prototype, "getUpdates").mockImplementation(options => new Promise((_resolve, reject) => {
    failPoll = reject;
    options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
  }));
  const { target, c, thread } = await setup(follower);
  const paused = gate();
  const read = fs.readFile;
  let reading = false;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) { reading = true; await paused.promise; }
    return (read as any)(...args);
  });
  const input = c.processUpdate(photo(thread));
  await vi.waitFor(() => expect(reading).toBe(true));
  failPoll(code === 409 ? new ConflictError("conflict") : new TelegramApiError("Unauthorized", 401));
  await vi.waitFor(() => expect(c.getStatus().polling).toBe(code === 409 ? "conflict" : "error"));
  paused.release();
  await input;
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(target.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(target.pi.sendMessage).not.toHaveBeenCalled();
  expect(target.ctx.abort).not.toHaveBeenCalled();
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(getMediaDir(dir), retained[0]), "utf8")).toBe("image");
});

it.each([false, true])("bounds cancelled physical work and retains control commands (follower=%s)", async follower => {
  const { target, c, thread } = await setup(follower);
  const paused = gate();
  const read = fs.readFile;
  let reads = 0;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === getMediaDir(dir)) { reads++; await paused.promise; }
    return (read as any)(...args);
  });
  for (let i = 1; i <= 32; i++) {
    const input = c.processUpdate(photo(thread));
    await vi.waitFor(() => expect(reads).toBe(i));
    await c.processUpdate(telegramUpdate(thread, "/stop"));
    await input;
  }
  expect((c as any).inputWork.size).toBe(32);
  await c.feedback.whenIdle();
  await c.processUpdate(photo(thread));
  expect(c.getTelegramClient().downloadFile).toHaveBeenCalledTimes(32);
  await c.processUpdate(telegramUpdate(thread, "/status"));
  await c.feedback.whenIdle();
  expect(vi.mocked(c.getTelegramClient().sendMessage).mock.calls.some(call => call[1].includes("Input queue is full"))).toBe(true);
  expect(vi.mocked(c.getTelegramClient().sendMessage).mock.calls.some(call => call[1].includes("Topic: Online"))).toBe(true);
  paused.release();
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  const retained = await fs.readdir(getMediaDir(dir));
  expect(retained).toHaveLength(32);
  for (const name of retained) {
    expect(name).toMatch(/\.jpg$/);
    expect(await fs.readFile(path.join(getMediaDir(dir), name), "utf8")).toBe("image");
  }
  vi.mocked(target.ctx.isIdle).mockReturnValue(false);
  await target.runtime.onBeforeAgentStart(target.ctx);
  await c.processUpdate(photo(thread));
  expect(target.pi.sendMessage).toHaveBeenCalledOnce();
}, 10_000);

it("bounds cancelled unknown Pi admissions across reload until their hooks finish", async () => {
  const { target, c, thread } = await setup();
  const admissions: any[] = [];
  target.pi.sendUserMessage.mockImplementation(() => { admissions.push((target.runtime as any).inputOrigin.getStore()); });
  try {
    for (let i = 1; i <= 32; i++) {
      const input = c.processUpdate(photo(thread));
      await vi.waitFor(() => expect(admissions).toHaveLength(i));
      await c.processUpdate(telegramUpdate(thread, "/stop"));
      await input;
    }
    await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
    await c.reloadConfig();
    const client = c.getTelegramClient();
    vi.spyOn(client, "getFile").mockResolvedValue({ file_id: "image", file_unique_id: "image", file_path: "photos/image.jpg" });
    vi.spyOn(client, "downloadFile").mockResolvedValue(Buffer.from("image"));
    vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 100 } as any);
    await c.processUpdate(photo(thread));
    expect(admissions).toHaveLength(32);
    // Admission backpressure still retains the file already handed to Runtime.
    const retained = await fs.readdir(getMediaDir(dir));
    expect(retained).toHaveLength(33);
    for (const name of retained) {
      expect(name).toMatch(/\.jpg$/);
      expect(await fs.readFile(path.join(getMediaDir(dir), name), "utf8")).toBe("image");
    }
  } finally {
    // Resume the real runtime guard in each captured asynchronous origin. Until
    // this point the void Pi API has provided no physical admission completion.
    for (const admission of admissions) {
      expect(await (target.runtime as any).inputOrigin.run(admission, () => target.runtime.onInput(target.ctx))).toEqual({ action: "handled" });
    }
  }
  vi.mocked(target.ctx.isIdle).mockReturnValue(false);
  await target.runtime.onBeforeAgentStart(target.ctx);
  await c.processUpdate(photo(thread));
  expect(target.pi.sendMessage).toHaveBeenCalledOnce();
}, 10_000);

it("keeps same-lease refresh ordered, but detaches a generation replacement", async () => {
  const { c, thread } = await setup();
  const paused = gate();
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(async () => { await paused.promise; return Buffer.from("old"); });
  const old = c.processUpdate(photo(thread));
  await vi.waitFor(() => expect(c.getTelegramClient().downloadFile).toHaveBeenCalled());
  const lease = c.getRoutes().get(thread)!;
  const controller = (c as any).topicInputs.get(lease);
  c.registerLocalRoute({ ...lease });
  expect(c.getRoutes().get(thread)).toBe(lease);
  expect(controller.signal.aborted).toBe(false);
  const queued = c.processUpdate(telegramUpdate(thread, "old queued"));
  const dispatch = vi.fn(async () => ({ accepted: true, busy: false }));
  c.registerLocalRoute({ ...lease, generation: lease.generation + 1, dispatchInbound: dispatch });
  expect(controller.signal.aborted).toBe(true);
  await c.processUpdate(telegramUpdate(thread, "new lease"));
  expect(dispatch).toHaveBeenCalledOnce();
  await Promise.all([old, queued]);
  paused.release();
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(dispatch.mock.calls[0][0]).toBe("new lease");
});

it("does not retire an unacknowledged cancellation timeout or hide its unknown outcome", async () => {
  const { c, target, thread } = await setup(true);
  (c as any).options.requestTimeoutMs = 150;
  const handleFrame = (c as any).handleFrame.bind(c);
  vi.spyOn(c as any, "handleFrame").mockImplementation((socket, state, msg: any) => msg.type === "cancel_input_ack" ? undefined : handleFrame(socket, state, msg));
  const paused = gate();
  const realpath = fs.realpath;
  let validating = false;
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
    if (args[0] === getMediaDir(dir)) { validating = true; await paused.promise; }
    return (realpath as any)(...args);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const ipc = (target.runtime as any).followerClient;
  const input = c.processUpdate(photo(thread));
  await vi.waitFor(() => expect(validating).toBe(true));
  await c.processUpdate(telegramUpdate(thread, "/stop"));
  await input;
  await vi.waitFor(() => expect(ipc.isConnected()).toBe(false));
  expect(log.mock.calls.some(call => String(call[0]).includes("INPUT_CANCEL_UNCONFIRMED"))).toBe(true);
  paused.release();
});

it("keeps a cancelled late I/O failure visible without affecting a replacement input", async () => {
  const { target, c, thread } = await setup(true);
  const paused = gate();
  const realpath = fs.realpath;
  let validating = false;
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
    if (args[0] === getMediaDir(dir) && !validating) {
      validating = true;
      await paused.promise;
      throw Object.assign(new Error("private-path-or-token"), { code: "EACCES" });
    }
    return (realpath as any)(...args);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const old = c.processUpdate(photo(thread));
  await vi.waitFor(() => expect(validating).toBe(true));
  await c.processUpdate(telegramUpdate(thread, "/stop"));
  await old;
  vi.mocked(target.ctx.isIdle).mockReturnValue(false);
  await target.runtime.onBeforeAgentStart(target.ctx);
  await c.processUpdate(telegramUpdate(thread, "fresh"));
  paused.release();
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(target.pi.sendMessage).toHaveBeenCalledOnce();
  expect(log.mock.calls.some(call => String(call[0]).includes("MEDIA_VALIDATION_FAILED"))).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-path-or-token");
  expect(c.getStatus().feedbackError).toBeUndefined();
});

it("retires the destructive media IPC deadline after confirmed cancellation, not after I/O completion", async () => {
  const { target, c, thread } = await setup(true);
  const paused = gate();
  const realpath = fs.realpath;
  let validating = false;
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
    if (args[0] === getMediaDir(dir)) { validating = true; await paused.promise; }
    return (realpath as any)(...args);
  });
  const input = c.processUpdate(photo(thread));
  await vi.waitFor(() => expect(validating).toBe(true));
  const ipc = (target.runtime as any).followerClient;
  await c.processUpdate(telegramUpdate(thread, "/stop"));
  await input;
  vi.mocked(target.ctx.isIdle).mockReturnValue(false);
  await target.runtime.onBeforeAgentStart(target.ctx);
  await c.processUpdate(telegramUpdate(thread, "new input before old deadline"));
  expect(target.pi.sendMessage).toHaveBeenCalledOnce();
  // Deliberately cross the actual default deadline, not an options override.
  await new Promise(resolve => setTimeout(resolve, 10_100));
  expect(ipc.isConnected()).toBe(true);
  expect(c.getRoutes().has(thread)).toBe(true);
  await c.processUpdate(telegramUpdate(thread, "new input after old deadline"));
  expect(target.pi.sendMessage).toHaveBeenCalledTimes(2);
  paused.release();
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(target.pi.sendUserMessage).not.toHaveBeenCalled();
}, 15_000);

it.each([false, true])("detaches released route downloads so a reconnected lease progresses immediately (follower=%s)", async follower => {
  const { target, c, thread } = await setup(follower);
  const paused = gate();
  vi.mocked(c.getTelegramClient().downloadFile).mockImplementationOnce(async () => { await paused.promise; return Buffer.from("old"); });
  const old = c.processUpdate(photo(thread));
  await vi.waitFor(() => expect(c.getTelegramClient().downloadFile).toHaveBeenCalled());
  target.runtime.handleTgDisconnect(target.ctx);
  await target.runtime.handleTgConnect(target.ctx);
  vi.mocked(target.ctx.isIdle).mockReturnValue(false);
  await target.runtime.onBeforeAgentStart(target.ctx);
  const fresh = c.processUpdate(telegramUpdate(thread, "fresh"));
  await vi.waitFor(() => expect(target.pi.sendMessage).toHaveBeenCalledOnce());
  await fresh;
  paused.release();
  await old;
  await vi.waitFor(() => expect((c as any).inputWork.size).toBe(0));
  expect(target.pi.sendUserMessage).not.toHaveBeenCalled();
});

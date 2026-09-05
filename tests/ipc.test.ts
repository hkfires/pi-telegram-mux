import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import * as configModule from "../src/config.js";
import { encodeFrame, FrameParser, IpcFollowerClient, tryAcquireLeaderLock } from "../src/ipc.js";
import { IPC_PROTOCOL_VERSION, type IpcMessage, type OutputTarget } from "../src/types.js";
import { testConfig, telegramUpdate } from "./helpers.js";

const target: OutputTarget = { sessionId: "session", threadId: 50, generation: 1 };

describe("IPC protocol regressions", () => {
  let dir: string;
  let coordinator: LeaderCoordinator;
  let info: Awaited<ReturnType<LeaderCoordinator["start"]>>;
  const followers: IpcFollowerClient[] = [];
  const sockets: net.Socket[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ipc-regression-"));
    coordinator = new LeaderCoordinator(testConfig, dir, undefined, { requestTimeoutMs: 150 });
    info = await coordinator.start();
    await vi.waitFor(() => expect((coordinator as any).botUsername).toBe("fixture_bot"));
  });
  afterEach(async () => {
    for (const f of followers.splice(0)) f.close();
    for (const s of sockets.splice(0)) s.destroy();
    await coordinator.stop();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function connect(id = "follower", capability = info.capability) {
    const f = new IpcFollowerClient(info.port, capability, id);
    followers.push(f);
    await f.connect();
    return f;
  }

  async function rawFollower(onRequest: (message: IpcMessage, socket: net.Socket) => void) {
    const socket = net.createConnection({ host: "127.0.0.1", port: info.port });
    sockets.push(socket);
    const parser = new FrameParser();
    socket.on("error", () => {});
    socket.on("data", chunk => { for (const msg of parser.push(chunk)) onRequest(msg, socket); });
    await once(socket, "connect");
    socket.write(encodeFrame({ type: "auth", protocolVersion: IPC_PROTOCOL_VERSION, runtimeId: "raw", capability: info.capability }));
    socket.write(encodeFrame({ type: "register", registration: { runtimeId: "raw", ...target } }));
    await vi.waitFor(() => expect(coordinator.getRoutes().has(50)).toBe(true));
    return socket;
  }

  it("rejects an incorrect capability before any Bot API call", async () => {
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi");
    await expect(connect("wrong", "wrong-capability")).rejects.toThrow("closed");
    expect(api).not.toHaveBeenCalled();
  });

  it("requires registration and fences unsupported or cross-topic requests", async () => {
    const f = await connect();
    await expect(f.callTelegram("createForumTopic", { chat_id: testConfig.chatId, name: "x" })).rejects.toThrow("closed");
    const registered = await connect("registered");
    await registered.register({ runtimeId: "registered", ...target });
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValue({});
    await expect(registered.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 50, text: "x" })).rejects.toThrow("fenced");
    await expect(registered.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 51, text: "x" }, target)).rejects.toThrow("fenced");
    await expect(registered.callTelegram("getUpdates", { chat_id: testConfig.chatId })).rejects.toThrow("Unsupported");
    expect(api).not.toHaveBeenCalled();
  });

  it("parses a fragmented ACK exactly once and continues to the next update", async () => {
    let delivered = 0;
    const socket = await rawFollower((msg, s) => {
      if (msg.type !== "inbound") return;
      delivered++;
      const ack = encodeFrame({ type: "inbound_ack", requestId: msg.requestId, accepted: true, busy: false });
      s.write(ack.subarray(0, 2));
      setTimeout(() => s.write(ack.subarray(2)), 20);
    });
    await coordinator.processUpdate(telegramUpdate(50, "first", 1));
    await coordinator.processUpdate(telegramUpdate(50, "second", 2));
    expect(delivered).toBe(2);
    expect(socket.destroyed).toBe(false);
  });

  it.each(["disconnect", "timeout"])("settles an inbound request after follower %s", async cause => {
    await rawFollower((msg, socket) => { if (msg.type === "inbound" && cause === "disconnect") socket.destroy(); });
    await expect(coordinator.processUpdate(telegramUpdate(50, "pending"))).resolves.toBeUndefined();
    await vi.waitFor(() => expect(coordinator.getRoutes().has(50)).toBe(false));
  });

  it("routes /stop to the follower and waits for its confirmation", async () => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const abort = vi.fn(() => true);
    f.setAbortHandler(abort);
    const send = vi.spyOn(coordinator.getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
    await coordinator.processUpdate(telegramUpdate(50, "/stop"));
    expect(abort).toHaveBeenCalledWith(target);
    expect(send).toHaveBeenCalledWith(testConfig.chatId, "已发送中止信号", { message_thread_id: 50 }, expect.any(AbortSignal));
  });

  it("does not report a successful stop when the follower cannot abort", async () => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const send = vi.spyOn(coordinator.getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
    await coordinator.processUpdate(telegramUpdate(50, "/stop"));
    expect(send.mock.calls[0][1]).toContain("未能确认");
  });

  it("rejects duplicate claims without letting the rejected socket remove the owner", async () => {
    const a = await connect("a");
    const b = await connect("b");
    await a.register({ runtimeId: "a", ...target });
    await expect(b.register({ runtimeId: "b", ...target })).rejects.toThrow("already claimed");
    b.close();
    await new Promise(r => setTimeout(r, 30));
    expect(coordinator.getRoutes().get(50)?.runtimeId).toBe("a");
    await a.register({ runtimeId: "a", ...target, threadId: 51, generation: 2 });
    expect(coordinator.getRoutes().has(50)).toBe(false);
    expect(coordinator.getRoutes().get(51)?.runtimeId).toBe("a");
  });

  it("intentional close does not call the disconnect handler", async () => {
    const f = await connect();
    const disconnect = vi.fn();
    f.setDisconnectHandler(disconnect);
    f.close();
    await new Promise(r => setTimeout(r, 30));
    expect(disconnect).not.toHaveBeenCalled();
  });

  describe.each(["success", "failure"])("configuration loading %s", outcome => {
    it.each(["register", "call_telegram"])("settles a concurrent %s request without an unexplained disconnect", async method => {
      await configModule.saveConfig(dir, testConfig);
      const f = await connect();
      await f.register({ runtimeId: "follower", ...target });
      const disconnect = vi.fn();
      f.setDisconnectHandler(disconnect);
      const api = vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValue({});
      const frames = vi.spyOn(coordinator as any, "handleFrame");
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const failure = new SyntaxError("Simulated malformed configuration");
      vi.spyOn(configModule, "loadConfig").mockImplementationOnce(async () => {
        await gate;
        if (outcome === "failure") throw failure;
        return testConfig;
      });
      const reload = coordinator.reloadConfig().then(() => undefined, error => error);
      const pending = (method === "register" ? f.register({ runtimeId: "follower", ...target })
        : f.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: target.threadId, text: "pending" }, target))
        .then(() => ({ ok: true }), error => ({ ok: false, error }));
      try {
        await vi.waitFor(() => expect(frames.mock.calls.some(([, , message]: any) => message.type === method)).toBe(true));
        release();
        expect(await reload).toBe(outcome === "failure" ? failure : undefined);
        const result = await pending;
        if (outcome === "success") {
          expect(result.ok).toBe(false);
          expect(disconnect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "IPC_TRANSPORT_RESET" }));
          expect(api).not.toHaveBeenCalled();
          expect(coordinator.getRoutes().size).toBe(0);
        } else {
          expect(result.ok).toBe(true);
          expect(disconnect).not.toHaveBeenCalled();
          expect(f.isConnected()).toBe(true);
          expect(api).toHaveBeenCalledTimes(method === "call_telegram" ? 1 : 0);
        }
      } finally {
        release();
        await reload;
        await pending;
      }
    });
  });

  it.each(["cancel", "release"])("honors %s before resuming a deferred send after reload failure", async operation => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValue({});
    const frames = vi.spyOn(coordinator as any, "handleFrame");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failure = new SyntaxError("Simulated malformed configuration");
    vi.spyOn(configModule, "loadConfig").mockImplementationOnce(async () => { await gate; throw failure; });
    const reload = coordinator.reloadConfig().catch(error => error);
    const controller = new AbortController();
    const request = f.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 50, text: "cancelled" }, target, undefined, controller.signal)
      .then(() => ({ ok: true }), error => ({ ok: false, error }));
    try {
      await vi.waitFor(() => expect(frames.mock.calls.some(([, , message]: any) => message.type === "call_telegram")).toBe(true));
      if (operation === "cancel") controller.abort();
      else f.send({ type: "release", runtimeId: "follower", sessionId: target.sessionId });
      await vi.waitFor(() => expect(frames.mock.calls.some(([, , message]: any) => message.type === (operation === "cancel" ? "cancel_telegram" : "release"))).toBe(true));
      release();
      expect(await reload).toBe(failure);
      expect((await request).ok).toBe(false);
      // A subsequent registration ACK also confirms all earlier frames settled.
      await f.register({ runtimeId: "follower", ...target, generation: 2 });
      expect(api).not.toHaveBeenCalled();
      expect(f.isConnected()).toBe(true);
      expect((coordinator as any).connections.values().next().value.calls.size).toBe(0);
    } finally {
      release();
      await reload;
      await request;
    }
  });

  it("resets an authenticated follower that joins after the initial reload notification", async () => {
    await configModule.saveConfig(dir, { ...testConfig, chatId: -100999 });
    let release!: () => void;
    let stopped!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pollStopped = new Promise<void>(resolve => { stopped = resolve; });
    (coordinator as any).pollingTask = (coordinator as any).pollingTask.then(async () => { stopped(); await gate; });
    const reload = coordinator.reloadConfig();
    try {
      await pollStopped;
      const late = await connect("late");
      const disconnect = vi.fn();
      late.setDisconnectHandler(disconnect);
      const frames = vi.spyOn(coordinator as any, "handleFrame");
      const registration = late.register({ runtimeId: "late", ...target }).catch(error => error);
      await vi.waitFor(() => expect(frames.mock.calls.some(([, , message]: any) => message.type === "register")).toBe(true));
      release();
      await reload;
      expect(await registration).toMatchObject({ code: "IPC_CLOSED" });
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "IPC_TRANSPORT_RESET" }));
      expect(coordinator.getRoutes().size).toBe(0);
    } finally {
      release();
      await reload;
    }
  });

  it("does not resume a deferred request after shutdown during configuration loading", async () => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi");
    const frames = vi.spyOn(coordinator as any, "handleFrame");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(configModule, "loadConfig").mockImplementationOnce(async () => { await gate; return testConfig; });
    const reload = coordinator.reloadConfig().catch(error => error);
    const request = f.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 50, text: "obsolete" }, target).catch(error => error);
    try {
      await vi.waitFor(() => expect(frames.mock.calls.some(([, , message]: any) => message.type === "call_telegram")).toBe(true));
      await coordinator.stop();
      release();
      expect(await reload).toBeInstanceOf(Error);
      expect(await request).toMatchObject({ code: "IPC_CLOSED" });
      expect(api).not.toHaveBeenCalled();
      expect(coordinator.isRunning()).toBe(false);
      expect(coordinator.getRoutes().size).toBe(0);
    } finally {
      release();
      await reload;
      await request;
    }
  });

  it("resets peers authenticated during reload even if registration arrives after completion", async () => {
    await configModule.saveConfig(dir, { ...testConfig, chatId: -100999 });
    let release!: () => void;
    let stopped!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const drained = new Promise<void>(resolve => { stopped = resolve; });
    (coordinator as any).pollingTask = (coordinator as any).pollingTask.then(async () => { stopped(); await gate; });
    const reload = coordinator.reloadConfig();
    try {
      await drained;
      const late = await connect("late");
      expect(late.getConfigFingerprint()).toBe(configModule.configFingerprint(testConfig));
      const disconnect = vi.fn();
      late.setDisconnectHandler(disconnect);
      release();
      await reload;
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ code: "IPC_TRANSPORT_RESET" })));
      await expect(late.register({ runtimeId: "late", ...target })).rejects.toMatchObject({ code: "IPC_CLOSED" });
      expect(coordinator.getRoutes().size).toBe(0);
      const fresh = await connect("fresh");
      expect(fresh.getConfigFingerprint()).toBe(configModule.configFingerprint({ ...testConfig, chatId: -100999 }));
      await fresh.register({ runtimeId: "fresh", ...target });
      expect(coordinator.getRoutes().get(50)?.runtimeId).toBe("fresh");
    } finally { release(); await reload; }
  });

  it.each(["cancel", "release", "both"])("fences deferred registration on %s when loading fails", async operation => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const frames = vi.spyOn(coordinator as any, "handleFrame");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(configModule, "loadConfig").mockImplementationOnce(async () => { await gate; throw new SyntaxError("Invalid configuration"); });
    const reload = coordinator.reloadConfig().catch(error => error);
    const controller = new AbortController();
    const registration = f.register({ runtimeId: "follower", ...target, generation: 2 }, controller.signal).then(() => true, () => false);
    try {
      await vi.waitFor(() => expect(frames.mock.calls.some(([, , msg]: any) => msg.type === "register")).toBe(true));
      if (operation !== "release") controller.abort();
      if (operation !== "cancel") f.send({ type: "release", runtimeId: "follower", sessionId: target.sessionId });
      await vi.waitFor(() => {
        const types = frames.mock.calls.map(([, , msg]: any) => msg.type);
        if (operation !== "release") expect(types).toContain("cancel_telegram");
        if (operation !== "cancel") expect(types).toContain("release");
      });
      release();
      await reload;
      expect(await registration).toBe(false);
      expect(f.isConnected()).toBe(true);
      expect(coordinator.getRoutes().get(50)?.generation).toBe(operation === "cancel" ? 1 : undefined);
      await f.register({ runtimeId: "follower", ...target, generation: 3 });
      expect(coordinator.getRoutes().get(50)?.generation).toBe(3);
      expect((coordinator as any).connections.values().next().value.calls.size).toBe(0);
    } finally { release(); await reload; await registration; }
  });

  it("shutdown closes unauthenticated sockets and cancels polling", async () => {
    const s = net.createConnection({ host: "127.0.0.1", port: info.port });
    sockets.push(s);
    await once(s, "connect");
    await coordinator.stop();
    await vi.waitFor(() => expect(s.destroyed).toBe(true));
    expect(coordinator.isRunning()).toBe(false);
  });

  it("does not replace the lock of a live PID even if its port is unavailable", async () => {
    const result = await tryAcquireLeaderLock(dir, 1234);
    expect(result.acquired).toBe(false);
    expect(result.lockData.capability).toBe(info.capability);
  });
});

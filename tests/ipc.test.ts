import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import * as configModule from "../src/config.js";
import { encodeFrame, FrameParser, IpcFollowerClient, tryAcquireLeaderLock } from "../src/ipc.js";
import { IMAGE_INPUT_MODE, IPC_PROTOCOL_VERSION, type IpcMessage, type OutputTarget } from "../src/types.js";
import { RateLimitError, TelegramApiError } from "../src/telegram.js";
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
    socket.write(encodeFrame({ type: "auth", protocolVersion: IPC_PROTOCOL_VERSION, imageInputMode: IMAGE_INPUT_MODE, runtimeId: "raw", capability: info.capability }));
    socket.write(encodeFrame({ type: "register", registration: { runtimeId: "raw", ...target } }));
    await vi.waitFor(() => expect(coordinator.getRoutes().has(50)).toBe(true));
    return socket;
  }

  it.each([5, 6])("rejects a legacy v%s peer before route registration", async protocolVersion => {
    const socket = net.createConnection({ host: "127.0.0.1", port: info.port });
    sockets.push(socket);
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(encodeFrame({ type: "auth", protocolVersion, imageInputMode: IMAGE_INPUT_MODE, runtimeId: "legacy", capability: info.capability }));
    await closed;
    expect(coordinator.getRoutes().size).toBe(0);
  });

  it.each([undefined, "inline-v1", "tui-paths-v1"])("rejects a current follower with incompatible image mode %j before registration", async imageInputMode => {
    const socket = net.createConnection({ host: "127.0.0.1", port: info.port });
    sockets.push(socket);
    socket.on("error", () => {});
    await once(socket, "connect");
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    const replies: IpcMessage[] = [];
    const parser = new FrameParser();
    socket.on("data", chunk => replies.push(...parser.push(chunk)));
    socket.write(Buffer.concat([
      encodeFrame({ type: "auth", protocolVersion: IPC_PROTOCOL_VERSION, imageInputMode, runtimeId: "mixed", capability: info.capability }),
      encodeFrame({ type: "register", registration: { runtimeId: "mixed", ...target } }),
    ]));
    await closed;
    expect(replies).toEqual([]);
    expect(coordinator.getRoutes().size).toBe(0);
  });

  it.each([
    { protocolVersion: 6, imageInputMode: IMAGE_INPUT_MODE },
    ...[undefined, "inline-v1", "tui-paths-v1"].map(imageInputMode => ({ protocolVersion: IPC_PROTOCOL_VERSION, imageInputMode })),
  ])("rejects an incompatible leader %j before coalesced input", async ({ protocolVersion, imageInputMode }) => {
    const auth: IpcMessage[] = [];
    const server = net.createServer(socket => {
      sockets.push(socket);
      socket.on("error", () => {});
      const parser = new FrameParser();
      socket.on("data", chunk => {
        for (const msg of parser.push(chunk)) {
          auth.push(msg);
          if (msg.type !== "auth") continue;
          socket.write(Buffer.concat([
            encodeFrame({ type: "auth_ack", protocolVersion, imageInputMode, epoch: 1, configFingerprint: "fixture", status: { polling: "online" } }),
            encodeFrame({ type: "inbound", requestId: "must-not-run", messageId: 1, target, fromId: testConfig.allowedUserId, text: "untrusted mixed-mode input" }),
          ]));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const f = new IpcFollowerClient((server.address() as net.AddressInfo).port, "fixture", "new");
    followers.push(f);
    const inbound = vi.fn();
    f.setInboundHandler(inbound);
    try {
      if (protocolVersion !== IPC_PROTOCOL_VERSION) await expect(f.connect()).rejects.toThrow("Incompatible IPC protocol");
      else await expect(f.connect()).rejects.toMatchObject({ code: "IPC_IMAGE_MODE_MISMATCH" });
      expect(auth[0]).toMatchObject({ type: "auth", protocolVersion: IPC_PROTOCOL_VERSION, imageInputMode: IMAGE_INPUT_MODE });
      expect(f.isConnected()).toBe(false);
      expect(inbound).not.toHaveBeenCalled();
    } finally {
      f.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

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
    await expect(registered.callTelegram("closeForumTopic", { chat_id: testConfig.chatId, message_thread_id: -1 })).rejects.toThrow("Invalid message_thread_id");
    await registered.callTelegram("closeForumTopic", { chat_id: testConfig.chatId, message_thread_id: 50 }, target);
    expect(api).toHaveBeenCalledWith("closeForumTopic", { chat_id: testConfig.chatId, message_thread_id: 50 }, undefined, expect.any(AbortSignal));
    api.mockClear();

    await expect(registered.callTelegram("setMessageReaction", { chat_id: testConfig.chatId, message_id: 0 })).rejects.toThrow("Invalid message_id");
    await expect(registered.callTelegram("setMessageReaction", { chat_id: testConfig.chatId, message_id: 123 })).rejects.toThrow("fenced");
    await registered.callTelegram("setMessageReaction", { chat_id: testConfig.chatId, message_id: 123, reaction: [{ type: "emoji", emoji: "⚡" }] }, target);
    expect(api).toHaveBeenCalledWith("setMessageReaction", { chat_id: testConfig.chatId, message_id: 123, reaction: [{ type: "emoji", emoji: "⚡" }] }, undefined, expect.any(AbortSignal), { ignoreRateLimit: true });
    api.mockClear();

    await expect(registered.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 0 })).rejects.toThrow("Invalid message_id");
    await expect(registered.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 123 })).rejects.toThrow("fenced");
    await expect(registered.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 123 }, target)).rejects.toThrow("does not belong to this route");

    // Send message through target route so coordinator tracks ownership
    api.mockResolvedValueOnce({ message_id: 555 });
    const sent = await registered.callTelegram<TelegramMessage>("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 50, text: "msg" }, target);
    expect(sent.message_id).toBe(555);

    // Deleting the owned message succeeds without ignoreRateLimit
    api.mockResolvedValueOnce(true);
    await registered.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 555 }, target);
    expect(api).toHaveBeenCalledWith("deleteMessage", { chat_id: testConfig.chatId, message_id: 555 }, undefined, expect.any(AbortSignal));
    api.mockClear();
  });

  it("reconciles retained message ownership on route registration and reconnection", async () => {
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi");
    const follower = await connect("reconcile-owner");

    // Invalid retainedMessageIds should close connection
    await expect(follower.register({
      runtimeId: "reconcile-owner", ...target, retainedMessageIds: [-1],
    })).rejects.toThrow("closed");

    // Reconnect and register with valid retained message IDs (simulating in-flight placeholder from active run)
    const validFollower = await connect("reconcile-owner-valid");
    await validFollower.register({
      runtimeId: "reconcile-owner-valid", ...target, retainedMessageIds: [777],
    });

    // A different topic's real message cannot be claimed through registration.
    const other = await connect("other-topic");
    const otherTarget = { ...target, threadId: 51 };
    await other.register({ runtimeId: "other-topic", ...otherTarget });
    api.mockResolvedValueOnce({ message_id: 777 });
    await other.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 51, text: "private" }, otherTarget);
    await validFollower.register({ runtimeId: "reconcile-owner-valid", ...target, retainedMessageIds: [777] });
    api.mockClear();

    // Authenticated local peers still cannot forge deletion authority.
    await expect(validFollower.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 777 }, target)).rejects.toThrow("does not belong to this route");

    expect(api).not.toHaveBeenCalled();

    // Send a new message 888
    api.mockResolvedValueOnce({ message_id: 888 });
    await validFollower.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 50, text: "placeholder" }, target);

    // Follower disconnects
    validFollower.close();

    // Reconnecting follower registers with retained message ID 888 (reconnection reconciliation)
    const reconnected = await connect("reconcile-owner-valid");
    await reconnected.register({
      runtimeId: "reconcile-owner-valid", ...target, retainedMessageIds: [888],
    });

    // Deleting 888 after reconnect succeeds
    api.mockResolvedValueOnce(true);
    await reconnected.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 888 }, target);
    expect(api).toHaveBeenCalledWith("deleteMessage", { chat_id: testConfig.chatId, message_id: 888 }, undefined, expect.any(AbortSignal));
  });

  it("bounds ownership records and rejects unverified restoration of evicted placeholders", async () => {
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi");
    for (let n = 0; n < 130; n++) {
      const runtimeId = `abandoned-${n}`;
      const lease = { ...target, threadId: 1000 + n };
      const peer = await connect(runtimeId);
      await peer.register({ runtimeId, ...lease });
      api.mockResolvedValueOnce({ message_id: 5000 + n });
      await peer.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: lease.threadId, text: "placeholder" }, lease);
      peer.close();
      await vi.waitFor(() => expect(coordinator.getRoutes().has(lease.threadId)).toBe(false));
    }
    const records = (coordinator as any).routeMessages as Map<number, unknown>;
    expect(records.size).toBe(128);
    expect(records.has(1000)).toBe(false);
    const peer = await connect("abandoned-0");
    const lease = { ...target, threadId: 1000 };
    await peer.register({ runtimeId: "abandoned-0", ...lease, retainedMessageIds: [5000] });
    api.mockResolvedValueOnce(true);
    await expect(peer.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 5000 }, lease)).rejects.toThrow("does not belong");
  }, 30_000);

  it.each(["chat", "bot", "preference"])("scopes disconnected message ownership across %s reloads", async change => {
    const owner = await connect("reload-owner");
    await owner.register({ runtimeId: "reload-owner", ...target });
    vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValueOnce({ message_id: 4321 });
    await owner.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: target.threadId, text: "placeholder" }, target);
    owner.close();
    await vi.waitFor(() => expect(coordinator.getRoutes().has(target.threadId)).toBe(false));
    const config = { ...testConfig,
      ...(change === "chat" ? { chatId: -100999 } : change === "bot" ? { botToken: "replacement-token" } : { autoCloseTopics: true }),
    };
    await configModule.saveConfig(dir, config);
    await coordinator.reloadConfig();
    await vi.waitFor(() => expect((coordinator as any).botUsername).toBe("fixture_bot"));
    const reconnected = await connect("reload-owner");
    await reconnected.register({ runtimeId: "reload-owner", ...target });
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValue(true);
    const deletion = reconnected.callTelegram("deleteMessage", { chat_id: config.chatId, message_id: 4321 }, target);
    if (change === "preference") await expect(deletion).resolves.toBe(true);
    else {
      await expect(deletion).rejects.toThrow("does not belong");
      expect(api).not.toHaveBeenCalled();
      api.mockResolvedValueOnce({ message_id: 4321 });
      await reconnected.callTelegram("sendMessage", { chat_id: config.chatId, message_thread_id: target.threadId, text: "fresh" }, target);
      await expect(reconnected.callTelegram("deleteMessage", { chat_id: config.chatId, message_id: 4321 }, target)).resolves.toBe(true);
    }
  });

  it.each(["same-owner", "other-runtime", "other-session"])("isolates retained message records after disconnect: %s", async scenario => {
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValue({ message_id: 4321 });
    const owner = await connect("original");
    await owner.register({ runtimeId: "original", ...target });
    await owner.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: target.threadId, text: "placeholder" }, target);
    owner.close();
    await vi.waitFor(() => expect(coordinator.getRoutes().has(target.threadId)).toBe(false));
    const runtimeId = scenario === "other-runtime" ? "replacement" : "original";
    const nextTarget = { ...target, sessionId: scenario === "other-session" ? "replacement-session" : target.sessionId };
    const next = await connect(runtimeId);
    await next.register({ runtimeId, ...nextTarget });
    api.mockClear();
    api.mockResolvedValue(true);
    const deletion = next.callTelegram("deleteMessage", { chat_id: testConfig.chatId, message_id: 4321 }, nextTarget);
    if (scenario === "same-owner") {
      await expect(deletion).resolves.toBe(true);
      expect(api).toHaveBeenCalledOnce();
    } else {
      await expect(deletion).rejects.toThrow("does not belong to this route");
      expect(api).not.toHaveBeenCalled();
    }
  });

  it.each(["closeForumTopic", "reopenForumTopic"])("fences ownership, session and generation for %s", async method => {
    const owner = await connect("owner");
    await owner.register({ runtimeId: "owner", ...target });
    const other = await connect("other");
    await other.register({ runtimeId: "other", sessionId: "other", threadId: null, generation: 1 });
    const api = vi.spyOn(coordinator.getTelegramClient(), "callApi").mockResolvedValue(true);
    const params = { chat_id: testConfig.chatId, message_thread_id: 50 };
    await expect(other.callTelegram(method, params, target)).rejects.toThrow("fenced");
    await expect(owner.callTelegram(method, params)).rejects.toThrow("fenced");
    await expect(owner.callTelegram(method, params, { ...target, sessionId: "stale" })).rejects.toThrow("fenced");
    await expect(owner.callTelegram(method, params, { ...target, generation: 2 })).rejects.toThrow("fenced");
    await expect(owner.callTelegram(method, { ...params, message_thread_id: 51 }, { ...target, threadId: 51 })).rejects.toThrow("fenced");
    await expect(coordinator.callTelegram(method, params, "owner", target)).rejects.toThrow("fenced");
    expect(api).not.toHaveBeenCalled();
    await expect(owner.callTelegram(method, params, target)).resolves.toBe(true);
  });

  it.each([new RateLimitError(2), new TelegramApiError("Forbidden", 403)])("preserves RPC error metadata for %s", async error => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    vi.spyOn(coordinator, "callTelegram").mockRejectedValueOnce(error);
    await expect(f.callTelegram("sendMessage", { text: "test" }, target)).rejects.toMatchObject({
      message: error.message, code: error.code, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    });
    expect(f.isConnected()).toBe(true);
  });

  it.each([
    { error: "Legacy rejection" },
    { error: "Bad code", code: 429 },
    { error: "Bad delay", code: "TELEGRAM_HTTP_429", retryAfter: -1 },
    { error: "Fractional delay", code: "TELEGRAM_HTTP_429", retryAfter: 1.5 },
  ])("handles legacy or malformed RPC error metadata: $error", async payload => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const handle = (coordinator as any).handleFrame.bind(coordinator);
    vi.spyOn(coordinator as any, "handleFrame").mockImplementation(async (socket: any, state: any, msg: any) => {
      if (msg.type !== "call_telegram") return handle(socket, state, msg);
      socket.write(encodeFrame({ type: "call_telegram_ack", callId: msg.callId, ok: false, ...payload } as any));
    });
    const request = f.callTelegram("sendMessage", { text: "test" }, target);
    if (!("code" in payload)) {
      await expect(request).rejects.toThrow("Legacy rejection");
      expect(f.isConnected()).toBe(true);
    } else {
      await expect(request).rejects.toThrow();
      expect(f.getStatus().error?.code).toBe("IPC_PROTOCOL_ERROR");
    }
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
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledWith(testConfig.chatId, "Abort signal sent.", { message_thread_id: 50 }, expect.any(AbortSignal));
  });

  it("does not report a successful stop when the follower cannot abort", async () => {
    const f = await connect();
    await f.register({ runtimeId: "follower", ...target });
    const send = vi.spyOn(coordinator.getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
    await coordinator.processUpdate(telegramUpdate(50, "/stop"));
    await coordinator.feedback.whenIdle();
    expect(send.mock.calls[0][1]).toContain("Could not confirm abort");
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

  it("does not replace a Leader whose listening endpoint is still owned", async () => {
    const result = await tryAcquireLeaderLock(dir, 1234);
    expect(result.acquired).toBe(false);
    expect(result.lockData.capability).toBe(info.capability);
  });

  it.each(["live host", "dead host"])("recovers legacy metadata with a retired endpoint and a %s", async host => {
    const lockPath = path.join(dir, "pi-telegram-mux", "runtime", "leader.json");
    const previous = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    await coordinator.stop();
    if (host === "dead host") previous.pid = 999999;
    await fs.writeFile(lockPath, JSON.stringify(previous));
    coordinator = new LeaderCoordinator(testConfig, dir);
    const recovered = await coordinator.start();
    expect(recovered.leader).toBe(true);
    expect(recovered.capability).not.toBe(previous.capability);
    expect(JSON.parse(await fs.readFile(lockPath, "utf-8")).capability).toBe(recovered.capability);
    const follower = new IpcFollowerClient(recovered.port, recovered.capability, "recovered");
    followers.push(follower);
    await follower.connect();
    expect(follower.isConnected()).toBe(true);
  });

  it("recognizes the candidate's own allocation of the retired port", async () => {
    const lockPath = path.join(dir, "pi-telegram-mux", "runtime", "leader.json");
    const previous = await fs.readFile(lockPath, "utf-8");
    await coordinator.stop();
    await fs.writeFile(lockPath, previous);
    const candidate = net.createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(info.port, "127.0.0.1", resolve);
    });
    try {
      const recovered = await tryAcquireLeaderLock(dir, info.port, Date.now(), candidate);
      expect(recovered.acquired).toBe(true);
      expect(candidate.listening).toBe(true);
      expect(recovered.lockData.capability).not.toBe(info.capability);
      await recovered.releaseLock!();
    } finally { await new Promise<void>(resolve => candidate.close(() => resolve())); }
  });

  it.each(["EACCES", "EADDRINUSE", "EAFNOSUPPORT"])("does not reclaim a record when binding its endpoint fails with %s", async code => {
    const listen = net.Server.prototype.listen;
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: any[]) {
      if (args[0]?.port === info.port) {
        queueMicrotask(() => this.emit("error", Object.assign(new Error("Simulated bind failure"), { code })));
        return this;
      }
      return listen.apply(this, args as any);
    });
    const acquiring = tryAcquireLeaderLock(dir, 1234);
    if (code === "EAFNOSUPPORT") await expect(acquiring).rejects.toMatchObject({ code });
    else expect((await acquiring).acquired).toBe(false);
    const runtimeDir = path.join(dir, "pi-telegram-mux", "runtime");
    expect(JSON.parse(await fs.readFile(path.join(runtimeDir, "leader.json"), "utf-8")).capability).toBe(info.capability);
    expect(await fs.readdir(path.join(runtimeDir, "election"))).toEqual([]);
  });
});

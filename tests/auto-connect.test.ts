import * as fs from "node:fs/promises";
import type { Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderCoordinator } from "../src/coordinator.js";
import { encodeFrame } from "../src/ipc.js";
import { TelegramApiError, TelegramClient, TelegramRequestError } from "../src/telegram.js";
import type { IpcMessage } from "../src/types.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe("manual connection for new sessions", () => {
  let dir: string;
  const fixtures: Fixture[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-auto-connect-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fixture of fixtures.reverse()) await fixture.runtime.onSessionShutdown({ reason: "reload" }, fixture.ctx);
    fixtures.length = 0;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not connect or create a topic until /tg-connect when autoConnect is false", async () => {
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "createForumTopic" || method === "sendMessage") {
        requests.push({ method, params });
      }
      if (method === "createForumTopic") return { message_thread_id: 208, name: "Manual" } as any;
      if (method === "sendMessage") return { message_id: 1 } as any;
      return original.call(this, method, params, ...args);
    });

    const f = await runtimeFixture(dir, "manual-session", null, "new", { ...testConfig, autoConnect: false });
    fixtures.push(f);
    expect(f.runtime.hasActiveTransport()).toBe(false);

    await f.runtime.onBeforeAgentStart({ prompt: "local only" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local only" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "local answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(f.runtime.getBindingState()).toBe("unbound");
    expect(f.runtime.outbox.error).toBeNull();
    expect(requests).toEqual([]);

    await f.runtime.handleTgConnect(f.ctx);
    expect(f.runtime.hasActiveTransport()).toBe(true);
    expect(f.runtime.getBindingState()).toBe("bound");
    expect(requests).toEqual([
      { method: "createForumTopic", params: { chat_id: testConfig.chatId, name: expect.stringMatching(/^Pi: /) } },
    ]);

    await f.runtime.onBeforeAgentStart({ prompt: "synced after manual connect" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "synced after manual connect" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "synced answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(requests.filter(request => request.method === "sendMessage").map(request => request.params)).toEqual([
      { chat_id: testConfig.chatId, message_thread_id: 208, text: "🧑‍💻 [Prompt]\nsynced after manual connect" },
      { chat_id: testConfig.chatId, message_thread_id: 208, text: "synced answer" },
    ]);
  });

  it.each(["a new topic", "an existing topic"])("syncs the active task after manually connecting to %s without another prompt", async binding => {
    const original = TelegramClient.prototype.callApi;
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "createForumTopic") return { message_thread_id: 208, name: "Manual" } as any;
      if (method === "sendMessage") return { message_id: 1 } as any;
      return original.call(this, method, params, ...args);
    });
    const f = await runtimeFixture(dir, "active-local-task", binding === "a new topic" ? null : 208, "new", { ...testConfig, autoConnect: false });
    fixtures.push(f);
    if (binding === "an existing topic") await f.runtime.handleTgDisconnect(f.ctx);
    f.entries.push({ type: "message", message: { role: "assistant", content: "old answer" } });

    await f.runtime.onBeforeAgentStart({ prompt: "already running" }, f.ctx);
    f.runtime.onAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "already running" }, f.ctx);
    f.runtime.onMessageStart({ role: "assistant" }, f.ctx);
    await f.runtime.handleTgConnect(f.ctx);

    const reply = { role: "assistant", content: "active answer", stopReason: "stop" };
    f.runtime.onMessageEnd(reply);
    f.runtime.onTurnEnd(reply);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(f.runtime.getBindingState()).toBe("bound");
    expect(api.mock.calls.filter(([method]) => method === "sendMessage").map(([, params]) => params)).toEqual([
      { chat_id: testConfig.chatId, message_thread_id: 208, text: "active answer" },
    ]);
  });

  it.each(["same session", "task started after timeout", "after navigation"])("requires explicit retry after an uncertain create (%s)", async retry => {
    const f = await runtimeFixture(dir, "create-retry-local-task", null, "new", { ...testConfig, autoConnect: false });
    fixtures.push(f);
    const original = f.runtime.callTelegram.bind(f.runtime);
    let attempts = 0;
    const telegram = vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (method, params, ...args) => {
      if (method === "createForumTopic") {
        if (++attempts === 1) throw new TelegramRequestError("TELEGRAM_TIMEOUT", "Topic creation timed out");
        return { message_thread_id: 208, name: "Retry" } as any;
      }
      if (method === "sendMessage") return { message_id: 1 } as any;
      return original(method, params, ...args);
    });
    const startLocal = async () => {
      await f.runtime.onBeforeAgentStart({ prompt: "local task" }, f.ctx);
      f.runtime.onAgentStart(f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "local task" }, f.ctx);
    };
    if (retry !== "task started after timeout") await startLocal();
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.runtime.getBindingState()).toBe("create-unknown");
    expect(f.ui.notify).toHaveBeenCalledWith("Telegram connection failed: Topic creation timed out", "error");
    await f.runtime.outbox.whenIdle();
    expect(attempts).toBe(1);

    if (retry === "task started after timeout") await startLocal();
    if (retry === "after navigation") await f.runtime.onSessionBeforeTree();
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.ui.confirm).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(2);
    expect(f.runtime.getCurrentThreadId()).toBe(208);
    f.runtime.onTurnEnd({ role: "assistant", content: "local answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(telegram.mock.calls.filter(([method]) => method === "sendMessage").map(([, params]) => [params.message_thread_id, params.text])).toEqual(
      retry === "after navigation" ? [] : [[208, "local answer"]],
    );
  });

  it("attaches the active local run when a competing instance releases the topic", async () => {
    const f = await runtimeFixture(dir, "retry-local-task", 208, "new");
    fixtures.push(f);
    const telegram = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_id: 1 });
    await f.runtime.handleTgDisconnect(f.ctx);
    const competitor = await runtimeFixture(dir, "competing-session", 208, "new");
    fixtures.push(competitor);
    const coordinator: LeaderCoordinator = (f.runtime as any).coordinator;
    expect(coordinator.getRoutes().get(208)?.runtimeId).toBe(competitor.runtime.runtimeId);

    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await f.runtime.onBeforeAgentStart({ prompt: "local task" }, f.ctx);
    f.runtime.onAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local task" }, f.ctx);
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.runtime.getBindingState()).toBe("bound");
    expect(f.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("occupied"), "warning");
    await expect(f.runtime.handleInboundText("before retry", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });

    await competitor.runtime.handleTgDisconnect(competitor.ctx);
    await vi.waitFor(() => expect(coordinator.getRoutes().has(208)).toBe(false));
    await f.runtime.handleTgConnect(f.ctx);
    expect(coordinator.getRoutes().get(208)?.runtimeId).toBe(f.runtime.runtimeId);
    expect(f.ui.notify).toHaveBeenLastCalledWith("Connected to topic 208; will not duplicate.", "info");
    f.runtime.onTurnEnd({ role: "assistant", content: "local answer", stopReason: "stop" });
    await f.runtime.outbox.whenIdle();
    expect(telegram.mock.calls.map(([method, params]) => [method, params.message_thread_id, params.text])).toEqual([
      ["sendMessage", 208, "local answer"],
    ]);
    await expect(f.runtime.handleInboundText("after retry", f.ctx)).resolves.toMatchObject({ accepted: true, busy: false });
  });

  it.each(["disconnect", "live socket timeout"])("reattaches the local run when a Follower loses a registration ACK (%s)", async failure => {
    const original = TelegramClient.prototype.callApi;
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "sendMessage") return { message_id: 1 } as any;
      return original.call(this, method, params, ...args);
    });
    const leader = await runtimeFixture(dir, "leader", 10, "new");
    fixtures.push(leader);
    const f = await runtimeFixture(dir, "follower-local-task", 208, "new");
    fixtures.push(f);
    expect(f.runtime.getIsLeader()).toBe(false);
    await f.runtime.handleTgDisconnect(f.ctx);
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await f.runtime.onBeforeAgentStart({ prompt: "local task" }, f.ctx);
    f.runtime.onAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local task" }, f.ctx);

    const coordinator = (leader.runtime as any).coordinator;
    const handleFrame = coordinator.handleFrame.bind(coordinator);
    let interrupted = false;
    let withheldAck: Socket | undefined;
    vi.spyOn(coordinator, "handleFrame").mockImplementation(async (socket: Socket, state: unknown, message: IpcMessage) => {
      if (!interrupted && message.type === "register" && message.registration.runtimeId === f.runtime.runtimeId &&
          message.registration.threadId === 208) {
        interrupted = true;
        if (failure === "disconnect") { socket.destroy(); return; }
        const ack = encodeFrame({ type: "register_ack", callId: message.callId, ok: true });
        const write = socket.write.bind(socket);
        vi.spyOn(socket, "write").mockImplementation((chunk, ...args) => {
          if (Buffer.isBuffer(chunk) && chunk.equals(ack)) { withheldAck = socket; return true; }
          return write(chunk, ...args);
        });
      }
      await handleFrame(socket, state, message);
    });
    const connecting = f.runtime.handleTgConnect(f.ctx);
    if (failure === "live socket timeout") {
      await vi.waitFor(() => expect(withheldAck?.destroyed).toBe(false));
      const route = (coordinator as LeaderCoordinator).getRoutes().get(208)!;
      expect(route.runtimeId).toBe(f.runtime.runtimeId);
      await expect(route.dispatchInbound("before acknowledgement")).resolves.toMatchObject({ accepted: false, busy: true });
    }
    await connecting;
    expect(interrupted).toBe(true);
    expect(f.runtime.getBindingState()).toBe("bound");
    expect(f.ui.notify).not.toHaveBeenCalledWith(expect.stringMatching(/^Connected to/), "info");
    await vi.waitFor(() => {
      expect(f.runtime.hasActiveTransport()).toBe(true);
      expect(f.runtime.getIsReconnecting()).toBe(false);
      expect((coordinator as LeaderCoordinator).getRoutes().get(208)?.runtimeId).toBe(f.runtime.runtimeId);
    }, { timeout: 3500 });

    f.runtime.onTurnEnd({ role: "assistant", content: "local answer after reconnect", stopReason: "stop" });
    await f.runtime.outbox.whenIdle();
    expect(api.mock.calls.filter(([method]) => method === "sendMessage").map(([, params]) => [params?.message_thread_id, params?.text])).toEqual([
      [208, "local answer after reconnect"],
    ]);
    const route = (coordinator as LeaderCoordinator).getRoutes().get(208)!;
    await expect(route.dispatchInbound("after reconnect")).resolves.toMatchObject({ accepted: true, busy: false });
  }, 16_000);

  it.each(["direct reopen", "reopen after HTTP 429"])("gates busy input and attaches the local task on %s", async mode => {
    const original = TelegramClient.prototype.callApi;
    let reopens = 0;
    let releaseReopen!: () => void;
    const reopenGate = new Promise<void>(resolve => { releaseReopen = resolve; });
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "reopenForumTopic") {
        if (++reopens === 1) throw new TelegramApiError("Forbidden", 403);
        if (reopens === 2 && mode === "reopen after HTTP 429") throw new TelegramApiError("Too Many Requests", 429, 1);
        await reopenGate;
        return true as any;
      }
      if (method === "sendMessage") return { message_id: 1 } as any;
      if (method === "deleteMessage") return true as any;
      return original.call(this, method, params, ...args);
    });
    const f = await runtimeFixture(dir, "local-while-disconnected", 208, "resume");
    fixtures.push(f);
    await f.runtime.handleTgDisconnect(f.ctx);
    expect(f.runtime.hasActiveTransport()).toBe(true);
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await f.runtime.onBeforeAgentStart({ prompt: "local task" }, f.ctx);
    f.runtime.onAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local task" }, f.ctx);

    const connecting = f.runtime.handleTgConnect(f.ctx);
    try {
      if (mode === "reopen after HTTP 429") {
        await connecting;
        expect(reopens).toBe(2);
        await expect(f.runtime.handleInboundText("during cooldown", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
      }
      await vi.waitFor(() => expect(reopens).toBe(mode === "direct reopen" ? 2 : 3), { timeout: 3000 });
      await expect(f.runtime.handleInboundText("during reopen", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
    } finally {
      releaseReopen();
      await connecting;
    }
    await vi.waitFor(() => expect(f.runtime.getIsReconnecting()).toBe(false));

    f.runtime.onTurnEnd({ role: "assistant", content: "local answer", stopReason: "stop" });
    await expect(f.runtime.handleInboundText("after reopen", f.ctx)).resolves.toMatchObject({ accepted: true, busy: false });
    const [message] = f.pi.sendMessage.mock.calls[0];
    f.runtime.onMessageStart({ ...message, role: "custom" }, f.ctx);
    f.runtime.onTurnEnd({ role: "assistant", content: "follow-up answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(api.mock.calls.filter(([method]) => method === "sendMessage").map(([, params]) => [params?.message_thread_id, params?.text])).toEqual([
      [208, "local answer"], [208, "⏳ Working..."], [208, "follow-up answer"],
    ]);
  });

  it.each(["extension trigger", "stale Telegram input"])("handles a turn started by %s after manually connecting", async trigger => {
    const original = TelegramClient.prototype.callApi;
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "createForumTopic") return { message_thread_id: 208, name: "Manual" } as any;
      if (method === "sendMessage") return { message_id: 1 } as any;
      return original.call(this, method, params, ...args);
    });
    const f = await runtimeFixture(dir, "promptless-turn", null, "new", { ...testConfig, autoConnect: false });
    fixtures.push(f);
    await f.runtime.handleTgConnect(f.ctx);

    f.runtime.onAgentStart(f.ctx);
    f.runtime.onMessageStart(trigger === "extension trigger"
      ? { role: "custom", customType: "reminder", content: "extension trigger" }
      : { role: "custom", customType: "Telegram", content: "stale input", details: { runtimeId: "old-runtime", deliveryId: "old-input" } }, f.ctx);
    const reply = { role: "assistant", content: "promptless answer", stopReason: "stop" };
    f.runtime.onMessageStart(reply, f.ctx);
    f.runtime.onMessageEnd(reply);
    f.runtime.onTurnEnd(reply);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(api.mock.calls.filter(([method]) => method === "sendMessage").map(([, params]) => params)).toEqual([
      ...(trigger === "extension trigger" ? [{ chat_id: testConfig.chatId, message_thread_id: 208, text: "promptless answer" }] : []),
    ]);
  });

  it("clears follower reconnect state when the leader disables automatic connection", async () => {
    const leader = await runtimeFixture(dir, "leader", 10);
    fixtures.push(leader);
    const follower = await runtimeFixture(dir, "unbound-follower", null);
    fixtures.push(follower);
    expect(follower.runtime.hasActiveTransport()).toBe(true);
    leader.ui.select.mockResolvedValueOnce("Auto-connect New Sessions: On")
      .mockResolvedValueOnce("Off - Connect only with /tg-connect");

    await leader.runtime.handleTgSetup(leader.ctx);
    await vi.waitFor(() => {
      expect((follower.runtime as any).config.autoConnect).toBe(false);
      expect(follower.runtime.hasActiveTransport()).toBe(false);
      expect(follower.runtime.getIsReconnecting()).toBe(false);
      expect((follower.runtime as any).reconnectTimer).toBeUndefined();
      expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: offline");
    }, { timeout: 2500 });
  });

  it("keeps an existing bound session connected when autoConnect is false", async () => {
    const original = TelegramClient.prototype.callApi;
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, params, ...args) {
      if (method === "reopenForumTopic") return Promise.resolve(true as any);
      return original.call(this, method, params, ...args);
    });

    const f = await runtimeFixture(dir, "manual-restored", 50, "resume", { ...testConfig, autoConnect: false });
    fixtures.push(f);

    expect(f.runtime.hasActiveTransport()).toBe(true);
    expect(api.mock.calls.filter(([method, params]) => method === "reopenForumTopic" && params?.message_thread_id === 50)).toHaveLength(1);
  });

  it("rebuilds a deleted topic from an existing bound session when autoConnect is false", async () => {
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let topicDeleted = true;
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "createForumTopic" || method === "sendMessage") requests.push({ method, params });
      if (method === "createForumTopic") return { message_thread_id: 208, name: "Replacement" } as any;
      if (method === "sendMessage") {
        if (topicDeleted) throw new TelegramApiError("Bad Request: TOPIC_ID_INVALID", 400);
        return { message_id: 1 } as any;
      }
      return original.call(this, method, params, ...args);
    });

    const f = await runtimeFixture(dir, "manual-replacement", 108, undefined, { ...testConfig, autoConnect: false });
    fixtures.push(f);
    expect(f.runtime.hasActiveTransport()).toBe(true);

    await f.runtime.onBeforeAgentStart({ prompt: "lost prompt" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "lost prompt" }, f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.getBindingState()).toBe("topic-missing");
    expect(f.runtime.outbox.error).toBeNull();

    topicDeleted = false;
    await f.runtime.onBeforeAgentStart({ prompt: "replacement prompt" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "replacement prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "replacement answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(f.runtime.getBindingState()).toBe("bound");
    expect(requests.filter(request => request.method === "createForumTopic")).toHaveLength(1);
    expect(requests.filter(request => request.method === "sendMessage").map(request => [request.params?.message_thread_id, request.params?.text])).toEqual([
      [108, "🧑‍💻 [Prompt]\nlost prompt"],
      [208, "🧑‍💻 [Prompt]\nreplacement prompt"],
      [208, "replacement answer"],
    ]);
  });
});

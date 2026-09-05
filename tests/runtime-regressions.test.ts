import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { loadConfig } from "../src/config.js";
import * as configModule from "../src/config.js";
import { MuxRuntime } from "../src/runtime.js";
import { TelegramClient } from "../src/telegram.js";
import { runtimeFixture, telegramUpdate, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
const coordinatorOf = (f: Fixture) => (f.runtime as unknown as { coordinator: LeaderCoordinator }).coordinator;

describe("Runtime lifecycle and safety regressions", () => {
  let dir: string;
  const fixtures: Fixture[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-runtime-regression-")); });
  afterEach(async () => {
    vi.useRealTimers();
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function fixture(id: string, thread: number | null = 50) {
    const f = await runtimeFixture(dir, id, thread);
    fixtures.push(f);
    return f;
  }
  function validateSetup() {
    vi.spyOn(TelegramClient.prototype, "getMe").mockResolvedValue({ id: 1, is_bot: true, first_name: "Fake", username: "fixture_bot" });
    vi.spyOn(TelegramClient.prototype, "getChat").mockImplementation(async id => ({ id, type: "supergroup", is_forum: true }));
    vi.spyOn(TelegramClient.prototype, "getChatMember").mockImplementation(async (_chat, user) => user === 1 ? { status: "administrator", can_manage_topics: true } : { status: "member" });
  }

  it("does not reconnect or republish status after follower shutdown", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    await follower.runtime.onSessionShutdown(follower.ctx);
    await new Promise(r => setTimeout(r, 650));
    expect(follower.runtime.hasActiveTransport()).toBe(false);
    expect(coordinatorOf(leader).getRoutes().has(51)).toBe(false);
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", undefined);
  });

  it("shutdown waits for and discards an in-flight election", async () => {
    const f = await fixture("base");
    await f.runtime.onSessionShutdown(f.ctx);
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const start = LeaderCoordinator.prototype.start;
    vi.spyOn(LeaderCoordinator.prototype, "start").mockImplementation(async function () {
      const result = await start.call(this);
      entered();
      await barrier;
      return result;
    });
    const runtime = new MuxRuntime(f.pi as any, dir);
    const starting = runtime.onSessionStart(f.ctx);
    await entry;
    const stopping = runtime.onSessionShutdown(f.ctx);
    release();
    await Promise.all([starting, stopping]);
    expect(runtime.hasActiveTransport()).toBe(false);
    await expect(fs.access(path.join(dir, "pi-telegram-mux/runtime/leader.json"))).rejects.toThrow();
  });

  it("ignores a session-start config load that completes after shutdown", async () => {
    const f = await fixture("loading");
    await f.runtime.onSessionShutdown(f.ctx);
    let release!: (config: typeof testConfig) => void;
    vi.spyOn(configModule, "loadConfig").mockReturnValue(new Promise(resolve => { release = resolve; }));
    const starting = f.runtime.onSessionStart(f.ctx);
    await f.runtime.onSessionShutdown(f.ctx);
    release(testConfig);
    await starting;
    expect(f.runtime.hasActiveTransport()).toBe(false);
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", undefined);
  });

  it.each(["cancel", "validation failure"])("resumes Leader recovery after setup %s during a disconnect", async outcome => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    let answer!: (value: string | undefined) => void;
    follower.ui.input.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }))
      .mockResolvedValueOnce(String(testConfig.chatId)).mockResolvedValueOnce(String(testConfig.allowedUserId));
    if (outcome === "validation failure") vi.spyOn(TelegramClient.prototype, "getMe").mockRejectedValueOnce(new Error("Simulated validation failure"));
    const setup = follower.runtime.handleTgSetup("", follower.ctx);
    await leader.runtime.onSessionShutdown(leader.ctx);
    await vi.waitFor(() => expect((follower.runtime as any).followerClient).toBeNull());
    answer(outcome === "cancel" ? undefined : testConfig.botToken);
    await setup;
    await vi.waitFor(() => expect(follower.runtime.getIsLeader()).toBe(true), { timeout: 4000 });
    expect(follower.runtime.hasActiveTransport()).toBe(true);
  });

  it("/tg-connect is idempotent and /tg-disconnect leaves no executable route", async () => {
    const f = await fixture("bound");
    const call = vi.spyOn(f.runtime, "callTelegram");
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect([...coordinatorOf(f).getRoutes().keys()]).toEqual([50]);
    f.runtime.handleTgDisconnect(f.ctx);
    await coordinatorOf(f).processUpdate(telegramUpdate(50, "must not run"));
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(coordinatorOf(f).getRoutes().size).toBe(0);
  });

  it.each(["disconnect", "tree", "shutdown", "switch"])("fences remaining output chunks after %s", async action => {
    const f = await fixture("chunk");
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "x".repeat(9000) });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const call = vi.spyOn(f.runtime, "callTelegram").mockImplementation(async () => { await barrier; return {} as any; });
    const sending = f.runtime.onAgentSettled(f.ctx);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0][2]).toMatchObject({ sessionId: "chunk", threadId: 50 });
    if (action === "disconnect") f.runtime.handleTgDisconnect(f.ctx);
    if (action === "tree") f.runtime.onSessionBeforeTree();
    if (action === "shutdown") await f.runtime.onSessionShutdown(f.ctx);
    if (action === "switch") f.runtime.onSessionBeforeSwitch(f.ctx);
    release();
    await sending;
    await f.runtime.outbox.whenIdle();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("never retries an uncertain first-turn create without explicit confirmation", async () => {
    const f = await fixture("unknown", null);
    const call = vi.spyOn(f.runtime, "callTelegram").mockRejectedValue(new Error("Unknown create timeout"));
    await f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "answer" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "second" }, f.ctx);
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.runtime.getBindingState()).toBe("create-unknown");
    call.mockResolvedValue({ message_thread_id: 60 } as any);
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.ui.confirm).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
    expect(f.runtime.getCurrentThreadId()).toBe(60);
  });

  it("does not bind a late create response after disconnect", async () => {
    const f = await fixture("late-create", null);
    let release!: (value: any) => void;
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.runtime.handleTgDisconnect(f.ctx);
    release({ message_thread_id: 99 });
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.getBindingState()).toBe("disconnected");
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.pi.appendEntry.mock.calls[0][1].threadId).toBeNull();
  });

  it("rejects admission while Pi is compacting and reserves a pending injection", async () => {
    const f = await fixture("admission");
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    expect(await f.runtime.handleInboundText("compacting", f.ctx)).toEqual({ accepted: false, busy: true });
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    vi.mocked(f.ctx.isIdle).mockReturnValue(true);
    const admission = f.runtime.handleInboundText("first", f.ctx);
    expect(await f.runtime.handleInboundText("second", f.ctx)).toEqual({ accepted: false, busy: true });
    await f.inInput(() => f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx));
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    expect(await admission).toEqual({ accepted: true, busy: false });
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("reports unknown rather than accepted when Pi emits no admission event", async () => {
    const f = await fixture("no-event");
    vi.useFakeTimers();
    const admission = f.runtime.handleInboundText("not accepted by Pi", f.ctx);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await admission).toMatchObject({ accepted: false, busy: false, statusReply: expect.stringContaining("未知") });
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps an unresolved admission reserved after timeout until Pi actually consumes it", async () => {
    const f = await fixture("slow-preflight");
    vi.useFakeTimers();
    const admission = f.runtime.handleInboundText("first", f.ctx);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await admission).toMatchObject({ accepted: false, statusReply: expect.stringContaining("未知") });
    expect(await f.runtime.handleInboundText("second", f.ctx)).toEqual({ accepted: false, busy: true });
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    await f.inInput(() => f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx));
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    expect(f.runtime.getIsIdle()).toBe(true);
  });

  it("delivers uncertainty feedback even when before_agent_start refreshed the route", async () => {
    const f = await fixture("slow-start");
    const coordinator = coordinatorOf(f);
    const send = vi.spyOn(coordinator.getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
    f.pi.sendUserMessage.mockImplementation((text: string) => { void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx); });
    vi.useFakeTimers();
    const processing = coordinator.processUpdate(telegramUpdate(50, "first"));
    await vi.advanceTimersByTimeAsync(2001);
    await processing;
    expect(send).toHaveBeenCalledWith(testConfig.chatId, expect.stringContaining("未知"), { message_thread_id: 50 }, expect.any(AbortSignal));
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    expect(f.runtime.getIsIdle()).toBe(true);
  });

  it("does not mirror a delayed old-authority preflight after configuration changes", async () => {
    const f = await fixture("preflight-config");
    const admission = f.runtime.handleInboundText("old authorized prompt", f.ctx);
    validateSetup();
    await f.runtime.handleTgSetup(`${testConfig.botToken} -100999 999`, f.ctx);
    expect(await admission).toMatchObject({ accepted: false });
    expect(await f.runtime.handleInboundText("second", f.ctx)).toEqual({ accepted: false, busy: true });
    const call = vi.spyOn(f.runtime, "callTelegram");
    await f.inInput(() => f.runtime.onBeforeAgentStart({ prompt: "old authorized prompt" }, f.ctx));
    f.runtime.onMessageStart({ role: "user", content: "old authorized prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "old authorized answer" });
    await f.runtime.onAgentSettled(f.ctx);
    expect(call).not.toHaveBeenCalled();
    expect(f.runtime.getIsIdle()).toBe(true);
  });

  it("/stop reaches the actual follower context", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    vi.spyOn(coordinatorOf(leader).getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
    await coordinatorOf(leader).processUpdate(telegramUpdate(51, "/stop"));
    expect(follower.ctx.abort).toHaveBeenCalledTimes(1);
    expect(leader.ctx.abort).not.toHaveBeenCalled();
  });

  it.each(["leader", "follower"])("applies authorization changes initiated by the %s to all peers", async origin => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    const c = coordinatorOf(leader);
    const previousGeneration = c.getRoutes().get(51)!.generation;
    validateSetup();
    await (origin === "leader" ? leader : follower).runtime.handleTgSetup(`${testConfig.botToken} ${testConfig.chatId} 999`, (origin === "leader" ? leader : follower).ctx);
    await vi.waitFor(() => {
      expect(c.getRoutes().get(51)?.generation).toBeGreaterThan(previousGeneration);
      expect(follower.runtime.getIsReconnecting()).toBe(false);
    }, { timeout: 4000 });
    expect(leader.runtime.getIsLeader()).toBe(true);
    expect(follower.runtime.getIsLeader()).toBe(false);
    for (const f of [leader, follower]) {
      f.pi.sendUserMessage.mockImplementation((text: string) => {
        void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
      });
    }
    await c.processUpdate(telegramUpdate(50, "old user"));
    await c.processUpdate(telegramUpdate(51, "old user"));
    expect(leader.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(follower.pi.sendUserMessage).not.toHaveBeenCalled();
    const next = { ...testConfig, allowedUserId: 999 };
    await c.processUpdate(telegramUpdate(50, "new user", 3, next));
    await c.processUpdate(telegramUpdate(51, "new user", 4, next));
    expect(leader.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(follower.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not reuse old chat thread IDs after changing the configured chat", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    validateSetup();
    await leader.runtime.handleTgSetup(`${testConfig.botToken} -100999 999`, leader.ctx);
    await vi.waitFor(() => expect(follower.runtime.getBindingState()).toBe("unbound"), { timeout: 4000 });
    expect(leader.runtime.getBindingState()).toBe("unbound");
    expect(coordinatorOf(leader).getRoutes().size).toBe(0);
  });

  it("synchronizes changed authorization even when setup starts on a disconnected follower", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    (follower.runtime as any).followerClient.close();
    validateSetup();
    await follower.runtime.handleTgSetup(`${testConfig.botToken} ${testConfig.chatId} 999`, follower.ctx);
    expect(follower.runtime.hasActiveTransport()).toBe(true);
    expect(follower.ui.notify.mock.calls.some(call => String(call[0]).includes("保存并应用"))).toBe(true);
    const c = coordinatorOf(leader);
    await c.processUpdate(telegramUpdate(50, "old authorization"));
    await c.processUpdate(telegramUpdate(51, "old authorization"));
    expect(leader.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(follower.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("never redirects an existing first-turn reply to a newly configured chat", async () => {
    const f = await fixture("first-turn-config", null);
    const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_thread_id: 61 } as any);
    await f.runtime.onBeforeAgentStart({ prompt: "old-chat prompt" }, f.ctx);
    validateSetup();
    await f.runtime.handleTgSetup(`${testConfig.botToken} -100999 999`, f.ctx);
    call.mockClear();
    f.runtime.onMessageEnd({ role: "assistant", content: "old-chat confidential answer" });
    await f.runtime.onAgentSettled(f.ctx);
    expect(f.runtime.getBindingState()).toBe("unbound");
    expect(call).not.toHaveBeenCalled();
  });

  it("preserves an uncertain create across same-chat configuration reloads", async () => {
    const f = await fixture("unknown-reload", null);
    const call = vi.spyOn(f.runtime, "callTelegram").mockRejectedValue(new Error("Unknown create timeout"));
    await f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx);
    validateSetup();
    await f.runtime.handleTgSetup(`${testConfig.botToken} ${testConfig.chatId} 999`, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "late first answer" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "second" }, f.ctx);
    expect(f.runtime.getBindingState()).toBe("create-unknown");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("uses the literal token for setup and polling after configuration reload", async () => {
    const f = await fixture("literal-token");
    const requested: string[] = [];
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      requested.push(String(url));
      const method = String(url).split("/").at(-1);
      const result = method === "getMe" ? { id: 1, is_bot: true, first_name: "Fake", username: "fixture_bot" }
        : method === "getChat" ? { id: testConfig.chatId, type: "supergroup", is_forum: true }
        : method === "getChatMember" ? { status: "administrator", can_manage_topics: true } : undefined;
      return result ? Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 })) : fetch(url, init);
    });
    await f.runtime.handleTgSetup(`123:literal-test-token ${testConfig.chatId} ${testConfig.allowedUserId}`, f.ctx);
    expect((await loadConfig(dir))?.botToken).toBe("123:literal-test-token");
    await vi.waitFor(() => expect(requested.some(url => url.includes("bot123:literal-test-token/getUpdates"))).toBe(true));
    expect(requested.some(url => url.includes("bot123:literal-test-token/getMe"))).toBe(true);
    expect(coordinatorOf(f).getTelegramClient().redact("123:literal-test-token")).toBe("<redacted>");
  });
});

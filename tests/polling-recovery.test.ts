import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { IpcFollowerClient } from "../src/ipc.js";
import { MuxRuntime } from "../src/runtime.js";
import { ConflictError, TelegramApiError, TelegramClient } from "../src/telegram.js";
import { runtimeFixture, testConfig } from "./helpers.js";

describe("polling recovery ownership and unconfigured synchronization", () => {
  let dir: string;
  const fixtures: { runtime: MuxRuntime; ctx: ExtensionContext }[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-polling-recovery-")); });
  afterEach(async () => {
    for (const f of fixtures.reverse()) {
      await f.runtime.onSessionShutdown(f.ctx);
      await f.runtime.outbox.whenIdle();
    }
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([401, 409])("cancels stale Follower sends before recovering HTTP %s with unchanged configuration", async errorCode => {
    const originalFetch = globalThis.fetch;
    let failPoll!: () => void;
    let pollCount = 0;
    let oldSendAborted = false;
    let rejectNewSend = false;
    const sent: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) return new Promise<Response>((resolve, reject) => {
          failPoll = () => resolve(new Response(JSON.stringify({ ok: false, error_code: errorCode, description: "Simulated permanent poll failure" }), { status: errorCode }));
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
        if (pollCount === 2) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: [] })));
      }
      if (url.pathname.endsWith("/sendMessage")) {
        const params = JSON.parse(init!.body as string);
        sent.push(params.text);
        if (params.text === "🧑‍💻 [Prompt]\nold prompt") return new Promise<Response>((_resolve, reject) => {
          init!.signal!.throwIfAborted();
          init!.signal!.addEventListener("abort", () => { oldSendAborted = true; reject(init!.signal!.reason); }, { once: true });
        });
        if (rejectNewSend) return Promise.resolve(new Response(JSON.stringify({ ok: false, error_code: 403, description: "Simulated new send failure" }), { status: 403 }));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })));
      }
      return originalFetch(input, init);
    });
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const follower = await runtimeFixture(dir, "follower", 51);
    fixtures.push(follower);
    const ipc = (follower.runtime as any).followerClient as IpcFollowerClient;
    const call = vi.spyOn(follower.runtime, "callTelegram");
    await follower.runtime.onBeforeAgentStart(follower.ctx);
    follower.runtime.onMessageStart({ role: "user", content: "old prompt" }, follower.ctx);
    follower.runtime.onMessageEnd({ role: "assistant", content: "old answer", stopReason: "stop" });
    await follower.runtime.onAgentSettled(follower.ctx);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    failPoll();
    await vi.waitFor(() => expect(ipc.getStatus().error?.code).toBe(`TELEGRAM_HTTP_${errorCode}`));
    const oldSignal = call.mock.calls[0][3]!;
    const oldGeneration = follower.runtime.getGeneration();
    const reload = ipc.reloadConfig.bind(ipc);
    let cancelledBeforeReload = false;
    vi.spyOn(ipc, "reloadConfig").mockImplementation(() => {
      cancelledBeforeReload = oldSignal.aborted;
      return reload();
    });

    await follower.runtime.handleTgConnect(follower.ctx);
    await follower.runtime.outbox.whenIdle();

    expect(follower.runtime.outbox.error).toBeNull();
    expect(cancelledBeforeReload).toBe(true);
    expect(oldSendAborted).toBe(true);
    expect(follower.runtime.getGeneration()).toBeGreaterThan(oldGeneration);
    expect(follower.runtime.getCurrentThreadId()).toBe(51);
    expect(follower.runtime.getIsLeader()).toBe(false);
    expect(follower.runtime.getIsReconnecting()).toBe(false);
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (llower)");
    expect(follower.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("sync paused"), "error");
    await follower.runtime.onBeforeAgentStart(follower.ctx);
    follower.runtime.onMessageStart({ role: "user", content: "new prompt" }, follower.ctx);
    follower.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
    await follower.runtime.onAgentSettled(follower.ctx);
    await follower.runtime.outbox.whenIdle();
    expect(sent).toEqual(["🧑‍💻 [Prompt]\nold prompt", "🧑‍💻 [Prompt]\nnew prompt", "new answer"]);
    expect(follower.runtime.outbox.error).toBeNull();

    // Recovery owns only the stale cancellation; a new delivery failure must
    // still halt the queue and must not let its dependent answer pass through.
    rejectNewSend = true;
    await follower.runtime.onBeforeAgentStart(follower.ctx);
    follower.runtime.onMessageStart({ role: "user", content: "failing new prompt" }, follower.ctx);
    follower.runtime.onMessageEnd({ role: "assistant", content: "must not be sent", stopReason: "stop" });
    await follower.runtime.onAgentSettled(follower.ctx);
    await follower.runtime.outbox.whenIdle();
    expect(sent).toHaveLength(4);
    expect(follower.runtime.outbox.error).toBeInstanceOf(Error);
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
  });

  describe.each([401, 409])("Leader polling failure HTTP %s", errorCode => {
    it.each(["cancel", "validation failure"])("retains its lifecycle/role after setup %s and recovers without self-IPC", async outcome => {
      const pollFailure = errorCode === 409 ? new ConflictError("Simulated poll conflict") : new TelegramApiError("Simulated authorization failure", errorCode);
      const poll = vi.spyOn(TelegramClient.prototype, "getUpdates").mockRejectedValueOnce(pollFailure);
      const f = await runtimeFixture(dir, "leader", 50);
      fixtures.push(f);
      const coordinator = (f.runtime as any).coordinator as LeaderCoordinator;
      await vi.waitFor(() => expect(coordinator.getStatus().error?.code).toBe(pollFailure.code));
      const connect = vi.spyOn(IpcFollowerClient.prototype, "connect");
      const start = vi.spyOn(LeaderCoordinator.prototype, "start");
      if (outcome === "validation failure") vi.spyOn(TelegramClient.prototype, "getMe").mockRejectedValueOnce(new TelegramApiError("Simulated setup validation failure", 401));

      await f.runtime.handleTgSetup(outcome === "cancel" ? "" : `${testConfig.botToken} ${testConfig.chatId} ${testConfig.allowedUserId}`, f.ctx);
      // Even an explicit connection attempt must recognize the still-live Leader.
      await f.runtime.setupTransport(f.ctx);

      expect(connect).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(f.runtime.getIsLeader()).toBe(true);
      expect(f.runtime.getIsReconnecting()).toBe(false);
      expect(coordinator.isRunning()).toBe(true);
      expect(f.runtime.hasActiveTransport()).toBe(true);
      expect((f.runtime as any).followerClient).toBeNull();
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", errorCode === 409 ? "tg: conflict (409)" : "tg: error");
      const call = vi.spyOn(coordinator.getTelegramClient(), "callApi");
      await expect(f.runtime.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 50, text: "must not send while polling is failed" }, { sessionId: "leader", threadId: 50, generation: f.runtime.getGeneration() })).rejects.toThrow();
      expect(call).not.toHaveBeenCalled();

      poll.mockResolvedValueOnce([]);
      await f.runtime.handleTgConnect(f.ctx);
      await vi.waitFor(() => expect(coordinator.getStatus().polling).toBe("online"));
      expect((f.runtime as any).coordinator).toBe(coordinator);
      expect(connect).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(f.runtime.getIsLeader()).toBe(true);
      expect(f.runtime.getIsReconnecting()).toBe(false);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (leader)");
    });
  });

  it.each(["leader", "follower"])("clears stale reconnect state when the existing %s transport is recognized", async role => {
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
    if (f !== leader) fixtures.push(f);
    (f.runtime as any).scheduleReconnect(f.ctx);
    expect(f.runtime.getIsReconnecting()).toBe(true);
    await f.runtime.setupTransport(f.ctx);
    expect(f.runtime.getIsReconnecting()).toBe(false);
    expect((f.runtime as any).reconnectTimer).toBeUndefined();
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
  });

  it.each(["large prompt", "many prompts"])("never enqueues unconfigured synchronization: %s", async workload => {
    const ui = { setStatus: vi.fn(), notify: vi.fn() };
    const ctx = {
      mode: "tui", cwd: dir, ui,
      sessionManager: { getSessionId: () => "unconfigured", getEntries: () => [], getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
    const runtime = new MuxRuntime({} as ExtensionAPI, dir);
    fixtures.push({ runtime, ctx });
    await runtime.onSessionStart(ctx);
    const enqueue = vi.spyOn(runtime.outbox, "enqueue");
    const call = vi.spyOn(runtime, "callTelegram");
    await runtime.onBeforeAgentStart(ctx);
    const text = workload === "large prompt" ? "x".repeat(256 * 1024 + 1) : "local follow-up";
    for (let i = 0; i < (workload === "large prompt" ? 1 : 100); i++) runtime.onMessageStart({ role: "user", content: text }, ctx);
    runtime.onMessageEnd({ role: "assistant", content: "local answer", stopReason: "stop" });
    await runtime.onAgentSettled(ctx);
    await runtime.outbox.whenIdle();
    expect(enqueue).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(runtime.outbox.error).toBeNull();
    expect(runtime.outbox.size).toBe(0);
    expect(runtime.getIsIdle()).toBe(true);
    expect(ui.notify).not.toHaveBeenCalled();
    expect(ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: unconfigured");
  });
});

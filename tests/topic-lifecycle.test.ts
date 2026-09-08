import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuxRuntime } from "../src/runtime.js";
import { LeaderCoordinator } from "../src/coordinator.js";
import { saveConfig } from "../src/config.js";
import { encodeFrame, IpcError } from "../src/ipc.js";
import { TelegramApiError, TelegramClient } from "../src/telegram.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe("forum topic lifecycle", () => {
  let dir: string;
  const fixtures: Fixture[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-topic-lifecycle-"));
    await saveConfig(dir, { ...testConfig, autoCloseTopics: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    fixtures.length = 0;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps a terminal IPC failure visible while a rate-limited reopen is pending", async () => {
    const leader = await runtimeFixture(dir, "host", 10);
    fixtures.push(leader);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
      return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 });
    });
    const follower = await runtimeFixture(dir, "pending-error", 50, "resume");
    fixtures.push(follower);
    const coordinator = (leader.runtime as any).coordinator;
    const socket = [...coordinator.connections.entries()].find(([, state]: any) => state.runtimeId === follower.runtime.runtimeId)![0] as any;
    const malformed = encodeFrame({ type: "ping" });
    malformed.fill(0x7b, 4);
    socket.write(malformed);
    await vi.waitFor(() => expect(follower.runtime.hasActiveTransport()).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect((follower.runtime as any).connectionError.code).toBe("IPC_PROTOCOL_ERROR");
    expect(follower.runtime.getIsReconnecting()).toBe(false);
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
  });

  describe.each(["leader", "follower"])("%s", role => {
    beforeEach(async () => {
      if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
    });

    it.each(["startup", "resume", "reload"] as const)("reopens its bound topic on %s", async reason => {
      const api = vi.spyOn(TelegramClient.prototype, "callApi");
      const f = await runtimeFixture(dir, "restored", 50, reason);
      fixtures.push(f);
      expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(1);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (stored)");
    });

    it("retains the topic during reload while releasing runtime resources", async () => {
      const f = await runtimeFixture(dir, "reload", 50);
      fixtures.push(f);
      const api = vi.spyOn(TelegramClient.prototype, "callApi");
      await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
      expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(0);
      expect(f.runtime.hasActiveTransport()).toBe(false);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", undefined);
      const replacement = await runtimeFixture(dir, "reload", 50, "reload");
      fixtures.push(replacement);
      expect(replacement.runtime.hasActiveTransport()).toBe(true);
      expect(replacement.ui.notify).not.toHaveBeenCalled();
      expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(1);
    });

    describe.each(["queued", "sent", "acknowledged"])("navigation registration %s", timing => {
      it.each(["new", "resume", "fork"] as const)("closes the outgoing topic on %s", async reason => {
        const f = await runtimeFixture(dir, "outgoing", 50);
        fixtures.push(f);
        const api = vi.spyOn(TelegramClient.prototype, "callApi");
        if (reason === "fork") f.runtime.onSessionBeforeFork(f.ctx);
        else f.runtime.onSessionBeforeSwitch(f.ctx);
        // Pi awaits before-event handlers, allowing the registration to be sent
        // before shutdown without waiting for its IPC acknowledgement.
        if (timing === "sent") await Promise.resolve();
        if (timing === "acknowledged") await f.runtime.outbox.whenIdle();
        const closing = f.runtime.onSessionShutdown({ reason }, f.ctx);
        await expect(f.runtime.handleInboundText("late input", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
        await closing;
        expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toEqual([
          ["closeForumTopic", { chat_id: testConfig.chatId, message_thread_id: 50 }, undefined, expect.any(AbortSignal)],
        ]);
        expect(f.runtime.hasActiveTransport()).toBe(false);
        expect(f.runtime.outbox.error).toBeNull();
        expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
      });
    });

    it.each([
      { trigger: "automatic", outcome: "success" },
      { trigger: "automatic", outcome: "failure" },
      { trigger: "manual", outcome: "success" },
      { trigger: "manual", outcome: "failure" },
    ])("finishes pending reopen after $trigger connection recovery ($outcome)", async ({ trigger, outcome }) => {
      vi.spyOn(LeaderCoordinator.prototype, "start").mockRejectedValueOnce(new IpcError("IPC_ELECTION_BUSY", "Simulated election race"));
      const original = TelegramClient.prototype.callApi;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      let closed = true;
      const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, ...args) {
        if (method === "reopenForumTopic") {
          await barrier;
          if (outcome === "failure") throw new TelegramApiError("Forbidden: missing topic permission", 403);
          closed = false;
          return true as any;
        }
        return original.call(this, method, ...args);
      });
      const f = await runtimeFixture(dir, "recovered", 50, "resume");
      fixtures.push(f);
      let manualRecovery: Promise<void> | undefined;
      try {
        expect(f.runtime.hasActiveTransport()).toBe(false);
        expect(f.runtime.getIsReconnecting()).toBe(true);
        if (trigger === "manual") manualRecovery = f.runtime.handleTgConnect(f.ctx);
        await vi.waitFor(() => expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(1), { timeout: 2000 });
        expect(f.runtime.hasActiveTransport()).toBe(true);
        expect(f.runtime.getIsReconnecting()).toBe(true);
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: reconnecting");
        await expect(f.runtime.handleInboundText("premature task", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
        expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
        release();
        await manualRecovery;
        await vi.waitFor(() => expect(f.runtime.getIsReconnecting()).toBe(false));
        expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(1);
        expect(closed).toBe(outcome === "failure");
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", outcome === "success" ? "tg: connected (overed)" : "tg: error");
        if (outcome === "failure") {
          expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("topic reopen failed"), "error");
          api.mockImplementation(original);
          await f.runtime.handleTgConnect(f.ctx);
          expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (overed)");
          expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(2);
        }
      } finally { release(); await manualRecovery; }
    });

    it.each(["success", "another 429", "403"])("automatically finishes a rate-limited reopen: %s", async outcome => {
      const originalFetch = globalThis.fetch;
      const attempts: number[] = [];
      const sent: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const method = String(input).split("/").at(-1);
        if (method === "reopenForumTopic") {
          attempts.push(Date.now());
          const code = attempts.length === 1 || (outcome === "another 429" && attempts.length === 2) ? 429 : outcome === "403" ? 403 : 200;
          return new Response(JSON.stringify(code === 200 ? { ok: true, result: true } : {
            ok: false, error_code: code, description: code === 403 ? "Forbidden" : "Too Many Requests", parameters: { retry_after: 1 },
          }), { status: code });
        }
        if (method === "sendMessage") {
          sent.push(JSON.parse(init!.body as string).text);
          return new Response(JSON.stringify({ ok: true, result: { message_id: 900 } }));
        }
        return originalFetch(input, init);
      });
      const f = await runtimeFixture(dir, "limited", 50, "resume");
      fixtures.push(f);
      expect(f.ui.setStatus.mock.calls.at(-1)?.[1]).toContain("429");
      expect(f.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("/tg-connect"), "error");
      const expectedAttempts = outcome === "another 429" ? 3 : 2;
      await vi.waitFor(() => {
        expect(attempts).toHaveLength(expectedAttempts);
        expect(f.runtime.getIsReconnecting()).toBe(false);
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", outcome === "403" ? "tg: error" : "tg: connected (imited)");
      }, { timeout: 5000 });
      for (let i = 1; i < attempts.length; i++) expect(attempts[i] - attempts[i - 1]).toBeGreaterThanOrEqual(1000);
      if (outcome === "403") {
        expect((f.runtime as any).connectionError.code).toBe("TELEGRAM_HTTP_403");
        await new Promise(resolve => setTimeout(resolve, 1100));
        expect(attempts).toHaveLength(expectedAttempts);
      } else {
        expect((f.runtime as any).connectionError).toBeNull();
        expect((f.runtime as any).topicNeedsReopen).toBe(false);
        vi.spyOn((f.runtime as any).markdownWorker, "render").mockImplementation(async (text: string) => [{ text }]);
        await f.runtime.onBeforeAgentStart(f.ctx);
        f.runtime.onTurnEnd({ role: "assistant", content: "fresh reply", stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
        await f.runtime.outbox.whenIdle();
        expect(sent).toEqual(["fresh reply"]);
      }
    });

    it.each(["self", "another instance"])("retains a rate-limited reopen when %s changes auto-close settings", async origin => {
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
        return ++attempts === 1
          ? new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: true }));
      });
      const f = await runtimeFixture(dir, "settings-reopen", 50, "resume");
      fixtures.push(f);
      const owner = origin === "self" ? f : await runtimeFixture(dir, "settings-peer", 51);
      if (owner !== f) fixtures.push(owner);
      owner.ui.select.mockResolvedValueOnce("Auto-close Topics: On").mockResolvedValueOnce("Off - Keep topics open (faster exit)");
      await owner.runtime.handleTgSetup(owner.ctx);
      await vi.waitFor(() => {
        expect(attempts).toBe(2);
        expect((f.runtime as any).topicNeedsReopen).toBe(false);
        expect((f.runtime as any).rateLimitReopenTarget).toBeNull();
        expect(f.runtime.getIsReconnecting()).toBe(false);
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (reopen)");
      }, { timeout: 5000 });
    });

    it("waits for an in-progress configuration reload after the reopen cooldown expires", async () => {
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
        return ++attempts === 1
          ? new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: true }));
      });
      const f = await runtimeFixture(dir, "reload-reopen", 50, "resume");
      fixtures.push(f);
      const peer = await runtimeFixture(dir, "reload-peer", 51);
      fixtures.push(peer);
      const coordinator = fixtures.find(item => item.runtime.getIsLeader())!.runtime as any;
      const options = coordinator.coordinator.options;
      const apply = options.onConfigChange;
      let entered!: () => void;
      let release!: () => void;
      const changing = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      options.onConfigChange = async (config: any) => { entered(); await gate; await apply(config); };
      peer.ui.select.mockResolvedValueOnce("Auto-close Topics: On").mockResolvedValueOnce("Off - Keep topics open (faster exit)");
      const setup = peer.runtime.handleTgSetup(peer.ctx);
      try {
        await changing;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, (f.runtime as any).rateLimitUntil - Date.now()) + 100));
        expect(attempts).toBe(1);
        expect((f.runtime as any).rateLimitReopenTarget).not.toBeNull();
        expect(f.runtime.getIsReconnecting()).toBe(true);
        await expect(f.runtime.handleInboundText("wait for recovery", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
        release();
        await setup;
        await vi.waitFor(() => {
          expect(attempts).toBe(2);
          expect((f.runtime as any).topicNeedsReopen).toBe(false);
          expect((f.runtime as any).rateLimitReopenTarget).toBeNull();
        }, { timeout: 4000 });
      } finally { release(); await setup; options.onConfigChange = apply; }
    });

    it.each(["token", "chat"])("does not carry a rate-limited reopen into another %s", async change => {
      const originalFetch = globalThis.fetch;
      const calls: { url: string; chatId: number }[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
        calls.push({ url: String(input), chatId: JSON.parse(init!.body as string).chat_id });
        return calls.length === 1
          ? new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: true }));
      });
      const f = await runtimeFixture(dir, "changed-reopen", 50, "resume");
      fixtures.push(f);
      const next = { ...testConfig, autoCloseTopics: true, ...(change === "token" ? { botToken: "new-test-token" } : { chatId: -100999 }) };
      await saveConfig(dir, next);
      const leader = fixtures.find(item => item.runtime.getIsLeader())!.runtime as any;
      await leader.coordinator.reloadConfig();
      await vi.waitFor(() => expect((f.runtime as any).config.botToken === next.botToken && (f.runtime as any).config.chatId === next.chatId).toBe(true), { timeout: 3000 });
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect((f.runtime as any).rateLimitReopenTarget).toBeNull();
      expect(calls.filter(call => call.url.includes(testConfig.botToken) && call.chatId === testConfig.chatId)).toHaveLength(1);
    });

    it("keeps a manual reopen from racing the cooldown recovery", async () => {
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      let release!: () => void;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
        if (++attempts === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 30 } }), { status: 429 });
        return new Promise<Response>((resolve, reject) => {
          release = () => resolve(new Response(JSON.stringify({ ok: true, result: true })));
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
      });
      const f = await runtimeFixture(dir, "manual-reopen", 50, "resume");
      fixtures.push(f);
      const clock = vi.spyOn(Date, "now").mockReturnValue((f.runtime as any).rateLimitUntil + 1);
      const manual = f.runtime.handleTgConnect(f.ctx);
      try {
        await vi.waitFor(() => expect(attempts).toBe(2));
        expect(f.runtime.getIsReconnecting()).toBe(true);
        f.runtime.updateStatusBar();
        await f.runtime.handleTgConnect(f.ctx);
        expect(attempts).toBe(2);
        release();
        await manual;
        expect((f.runtime as any).rateLimitReopenTarget).toBeNull();
        expect(f.runtime.getIsReconnecting()).toBe(false);
      } finally { release?.(); await manual; clock.mockRestore(); }
    });

    it.each(["disconnect", "shutdown"])("does not retry a rate-limited reopen after %s", async action => {
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
        attempts++;
        return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 });
      });
      const f = await runtimeFixture(dir, "cancelled", 50, "resume");
      fixtures.push(f);
      if (action === "shutdown") await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
      else f.runtime.handleTgDisconnect(f.ctx);
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(attempts).toBe(1);
      expect((f.runtime as any).rateLimitReopenTarget).toBeNull();
      expect(f.runtime.getIsReconnecting()).toBe(false);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", action === "shutdown" ? undefined : "tg: disconnected");
    });

    it.each(["complete", "disconnect", "shutdown"])("serializes an automatic reopen and fences it on %s", async action => {
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      let release!: () => void;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/reopenForumTopic")) return originalFetch(input, init);
        if (++attempts === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 });
        return new Promise<Response>((resolve, reject) => {
          release = () => resolve(new Response(JSON.stringify({ ok: true, result: true })));
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
      });
      const f = await runtimeFixture(dir, "pending", 50, "resume");
      fixtures.push(f);
      try {
        await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 3000 });
        expect(f.runtime.getIsReconnecting()).toBe(true);
        await expect(f.runtime.handleInboundText("too early", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
        for (let i = 0; i < 3; i++) f.runtime.updateStatusBar();
        await f.runtime.handleTgConnect(f.ctx);
        expect(attempts).toBe(2);
        const pending = (f.runtime as any).rateLimitReopenTask;
        if (action === "disconnect") f.runtime.handleTgDisconnect(f.ctx);
        if (action === "shutdown") await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
        release();
        await pending;
        await vi.waitFor(() => expect(f.runtime.getIsReconnecting()).toBe(false));
        expect(attempts).toBe(2);
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", action === "complete" ? "tg: connected (ending)" : action === "disconnect" ? "tg: disconnected" : undefined);
      } finally { release?.(); }
    });

    it("reports a reopen failure and retries it through tg-connect", async () => {
      const original = TelegramClient.prototype.callApi;
      const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
        if (method === "reopenForumTopic") return Promise.reject(new TelegramApiError("Forbidden: missing topic permission", 403));
        return original.call(this, method, ...args);
      });
      const f = await runtimeFixture(dir, "denied", 50, "resume");
      fixtures.push(f);
      expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("topic reopen failed"), "error");
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
      api.mockImplementation(original);
      await f.runtime.handleTgConnect(f.ctx);
      expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(2);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (denied)");
    });

    it("preserves a pending reopen when settings change while manually disconnected", async () => {
      const original = TelegramClient.prototype.callApi;
      let permissionDenied = true;
      let closed = true;
      const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
        if (method === "reopenForumTopic" && params?.message_thread_id === 50) {
          if (permissionDenied) throw new TelegramApiError("Forbidden: missing topic permission", 403);
          closed = false;
          return true as any;
        }
        if (method === "sendMessage" && params?.message_thread_id === 50) {
          if (closed) throw new TelegramApiError("Bad Request: TOPIC_CLOSED", 400);
          return { message_id: 1 } as any;
        }
        return original.call(this, method, params, ...args);
      });
      const f = await runtimeFixture(dir, "recovered", 50, "resume");
      fixtures.push(f);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
      f.runtime.handleTgDisconnect(f.ctx);
      permissionDenied = false;
      f.ui.select.mockImplementationOnce(async (_title, options) => options[1])
        .mockImplementationOnce(async (_title, options) => options[0]);
      await f.runtime.handleTgSetup(f.ctx);
      expect(f.runtime.getBindingState()).toBe("disconnected");

      await f.runtime.handleTgConnect(f.ctx);
      await f.runtime.onBeforeAgentStart({ prompt: "after repair" }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "after repair" }, f.ctx);
      f.runtime.onMessageEnd({ role: "assistant", content: "recovered answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await f.runtime.outbox.whenIdle();
      expect(f.runtime.outbox.error).toBeNull();
      expect(closed).toBe(false);
      expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(2);
      expect(api.mock.calls.filter(([method]) => method === "sendMessage").map(([, params]) => params)).toEqual([
        { chat_id: testConfig.chatId, message_thread_id: 50, text: "🧑‍💻 [Prompt]\nafter repair" },
        { chat_id: testConfig.chatId, message_thread_id: 50, text: "recovered answer" },
      ]);
      expect(api.mock.calls.filter(([method]) => method === "createForumTopic")).toHaveLength(0);
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (overed)");
    });

    it("treats an already-open topic as successful", async () => {
      const original = TelegramClient.prototype.callApi;
      vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
        if (method === "reopenForumTopic") return Promise.reject(new TelegramApiError("Bad Request: TOPIC_NOT_MODIFIED", 400));
        return original.call(this, method, ...args);
      });
      const f = await runtimeFixture(dir, "open", 50, "resume");
      fixtures.push(f);
      expect(f.ui.notify).not.toHaveBeenCalled();
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (open)");
    });

    it("cancels remaining chunks and rejects input before awaiting topic closure", async () => {
      const f = await runtimeFixture(dir, "quitting", 50);
      fixtures.push(f);
      let releaseSend!: () => void;
      let releaseClose!: () => void;
      let firstReady!: () => void;
      const first = new Promise<void>(resolve => { firstReady = resolve; });
      const sendBarrier = new Promise<void>(resolve => { releaseSend = resolve; });
      const closeBarrier = new Promise<void>(resolve => { releaseClose = resolve; });
      let sendSignal: AbortSignal | undefined;
      const send = vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (_method, _params, _target, signal) => {
        sendSignal = signal;
        firstReady();
        await sendBarrier;
        return {} as any;
      });
      const original = TelegramClient.prototype.callApi;
      const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, ...args) {
        if (method === "closeForumTopic") { await closeBarrier; return true as any; }
        return original.call(this, method, ...args);
      });
      let closing: Promise<void> | undefined;
      try {
        await f.runtime.onBeforeAgentStart(f.ctx);
        f.runtime.onMessageEnd({ role: "assistant", content: "x".repeat(9000), stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
        await first;
        closing = f.runtime.onSessionShutdown(f.ctx);
        expect(sendSignal?.aborted).toBe(true);
        await expect(f.runtime.handleInboundText("late input", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
        expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(1));
        releaseSend();
        await f.runtime.outbox.whenIdle();
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        releaseSend();
        releaseClose();
        await closing;
      }
    });
  });

  it.each(["closeForumTopic", "reopenForumTopic"])("uses a three-second deadline for %s", async method => {
    const original = TelegramClient.prototype.callApi;
    const initial = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (name, ...args) {
      if (name === "reopenForumTopic") return Promise.reject(new TelegramApiError("Forbidden", 403));
      return original.call(this, name, ...args);
    });
    const f = await runtimeFixture(dir, "deadline", 50, method === "reopenForumTopic" ? "resume" : undefined);
    fixtures.push(f);
    initial.mockRestore();
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (name, ...args) {
      if (name !== method) return original.call(this, name, ...args);
      observedSignal = args[2];
      return new Promise((_resolve, reject) => observedSignal!.addEventListener("abort", () => reject(observedSignal!.reason), { once: true }));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const operation = method === "closeForumTopic" ? f.runtime.onSessionShutdown(f.ctx) : f.runtime.handleTgConnect(f.ctx);
    await vi.advanceTimersByTimeAsync(2999);
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(observedSignal?.aborted).toBe(true);
    await operation;
    vi.useRealTimers();
  });

  it.each(["rejected", "timeout"])("releases a follower without closing when its final registration fails (%s)", async outcome => {
    fixtures.push(await runtimeFixture(dir, "host", 10));
    const f = await runtimeFixture(dir, "outgoing", 50);
    fixtures.push(f);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    let signal: AbortSignal | undefined;
    vi.spyOn((f.runtime as any).followerClient, "register").mockImplementation((_registration, requestedSignal) => {
      signal = requestedSignal as AbortSignal;
      if (outcome === "rejected") return Promise.reject(new Error("Topic already claimed by another Runtime"));
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = f.runtime.onSessionShutdown({ reason: "new" }, f.ctx);
    if (outcome === "timeout") {
      await vi.advanceTimersByTimeAsync(2999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
    }
    await closing;
    vi.useRealTimers();
    expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(0);
    expect(f.runtime.hasActiveTransport()).toBe(false);
    const coordinator = (fixtures[0].runtime as any).coordinator as LeaderCoordinator;
    await vi.waitFor(() => expect(coordinator.getRoutes().has(50)).toBe(false));
  });

  it("does not reopen or close a topic when a follower wins the initial route claim", async () => {
    let leader: MuxRuntime | undefined;
    let reached!: () => void;
    let release!: () => void;
    const atRegistration = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = MuxRuntime.prototype.registerRoute;
    vi.spyOn(MuxRuntime.prototype, "registerRoute").mockImplementation(async function (...args) {
      leader ??= this;
      if (this === leader) { reached(); await barrier; }
      return original.apply(this, args);
    });
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const starting = runtimeFixture(dir, "same-session", 50, "resume");
    try {
      await atRegistration;
      fixtures.push(await runtimeFixture(dir, "same-session", 50, "resume"));
    } finally { release(); }
    const rejected = await starting;
    fixtures.push(rejected);
    expect(rejected.ui.notify).toHaveBeenCalledWith(expect.stringContaining("occupied"), "warning");
    expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(1);
    await rejected.runtime.onSessionShutdown(rejected.ctx);
    expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(0);
  });
});

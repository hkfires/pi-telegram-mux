import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe("placeholder ownership and delivery boundaries", () => {
  let dir: string;
  let deletionFailure: number | "timeout" | "decode" | undefined;
  let messageId: number;
  let deletionRetryAfter: number;
  let calls: { method: string; params: Record<string, any>; time: number }[];
  const fixtures: Fixture[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-placeholder-"));
    deletionFailure = undefined;
    deletionRetryAfter = 1;
    messageId = 0;
    calls = [];
    const fetch = globalThis.fetch;
    // Keep the real Telegram decoder, rate-limit broadcaster, FIFO and TCP IPC.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1)!;
      const params = init?.body ? JSON.parse(String(init.body)) : {};
      if (["sendMessage", "deleteMessage", "reopenForumTopic"].includes(method)) calls.push({ method, params, time: Date.now() });
      if (method === "deleteMessage" && deletionFailure !== undefined) {
        if (deletionFailure === "timeout") return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
          else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        });
        if (deletionFailure === "decode") return new Response("not JSON");
        return new Response(JSON.stringify({ ok: false, error_code: deletionFailure, parameters: { retry_after: deletionRetryAfter } }), { status: deletionFailure });
      }
      if (method === "sendMessage" && params.text === "trigger ordinary 429") {
        return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 });
      }
      if (method === "sendMessage") return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }));
      return fetch(input, init);
    });
  });

  afterEach(async () => {
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fixture(role: string): Promise<Fixture> {
    if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
    const f = await runtimeFixture(dir, "task", 50);
    fixtures.push(f);
    f.pi.sendUserMessage.mockImplementation((text: string) => {
      void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
    });
    expect((await f.runtime.handleInboundText("Task", f.ctx, 1)).accepted).toBe(true);
    await f.runtime.outbox.whenIdle();
    expect((f.runtime as any).pendingPlaceholders.size).toBe(1);
    return f;
  }

  describe.each(["leader", "follower"])("%s", role => {
    it.each(["stop", "error", "aborted", "empty"])("releases ownership once on %s settlement", async stopReason => {
      const f = await fixture(role);
      const content = stopReason === "stop" ? "Answer" : "";
      f.runtime.onTurnEnd({ role: "assistant", content, stopReason });
      await f.runtime.onAgentSettled(f.ctx);
      await f.runtime.outbox.whenIdle();
      expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
      expect(calls.filter(c => c.method === "deleteMessage").map(c => c.params.message_id)).toEqual([1]);
      expect(calls.filter(c => c.method === "sendMessage").map(c => c.params.text)).toEqual([
        "⏳ Working...",
        ...(stopReason === "stop" ? ["Answer"] : stopReason === "error" ? ["⚠️ Task failed. Please check local Pi errors."] : stopReason === "aborted" ? ["⏹ Task aborted."] : []),
      ]);
      expect(f.runtime.outbox.error).toBeNull();
    });

    it.each([400, 403, 500, "decode", "timeout"] as const)("keeps final delivery after cleanup failure %s without retaining or retrying deletion", async failure => {
      const f = await fixture(role);
      deletionFailure = failure;
      f.runtime.onTurnEnd({ role: "assistant", content: "Answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await f.runtime.outbox.whenIdle();
      expect(calls.filter(c => c.method === "sendMessage").map(c => c.params.text)).toEqual(["⏳ Working...", "Answer"]);
      expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(1);
      expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
      expect(f.runtime.outbox.error).toBeNull();
      await f.runtime.handleTgDisconnect(f.ctx);
      expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(1);
    }, 10_000);

    it("preserves FIFO and another runtime's answer during a cleanup-only 429", async () => {
      const f = await fixture(role);
      const other = await runtimeFixture(dir, "other", 51);
      fixtures.push(other);
      await other.runtime.onBeforeAgentStart({ prompt: "Other task" }, other.ctx);
      other.runtime.onMessageStart({ role: "user", content: "Other task" }, other.ctx);
      await other.runtime.outbox.whenIdle();
      deletionFailure = 429;
      f.runtime.onTurnEnd({ role: "assistant", content: "First answer", stopReason: "stop" });
      f.runtime.onMessageStart({ role: "assistant" }, f.ctx);
      f.runtime.onTurnEnd({ role: "assistant", content: "Second answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await vi.waitFor(() => expect((f.runtime as any).rateLimitPreservesOutput).toBe(true));
      await vi.waitFor(() => expect((other.runtime as any).rateLimitPreservesOutput).toBe(true));
      other.runtime.onTurnEnd({ role: "assistant", content: "Other answer", stopReason: "stop" });
      await other.runtime.onAgentSettled(other.ctx);
      // A local prompt can start during the cosmetic cooldown without losing output.
      await f.runtime.onBeforeAgentStart({ prompt: "Next task" }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "Next task" }, f.ctx);
      f.runtime.onTurnEnd({ role: "assistant", content: "Next answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await Promise.all([f.runtime.outbox.whenIdle(), other.runtime.outbox.whenIdle()]);
      const deletion = calls.find(c => c.method === "deleteMessage")!;
      const answers = calls.filter(c => c.method === "sendMessage" && c.params.text.includes("answer"));
      expect(answers).toHaveLength(4);
      expect(answers.every(c => c.time - deletion.time >= 1000)).toBe(true);
      expect(answers.filter(c => c.params.message_thread_id === 50).map(c => c.params.text)).toEqual(["First answer", "Second answer", "Next answer"]);
      expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(1);
      expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
      expect(f.runtime.outbox.error).toBeNull();
      expect(other.runtime.outbox.error).toBeNull();
    }, 10_000);

    it.each(["disconnect", "switch", "shutdown"])("cancels the cleanup-cooldown wait on %s", async action => {
      const f = await fixture(role);
      deletionFailure = 429;
      f.runtime.onTurnEnd({ role: "assistant", content: "Obsolete answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await vi.waitFor(() => expect((f.runtime as any).rateLimitPreservesOutput).toBe(true));
      if (action === "disconnect") await f.runtime.handleTgDisconnect(f.ctx);
      else if (action === "switch") await f.runtime.onSessionBeforeSwitch(f.ctx);
      else await f.runtime.onSessionShutdown(f.ctx);
      await f.runtime.outbox.whenIdle();
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(calls.filter(c => c.method === "sendMessage").map(c => c.params.text)).toEqual(["⏳ Working..."]);
      expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
      expect(f.runtime.outbox.error).toBeNull();
    });

    it("abandons settled runs on every ordinary 429, including automatic recovery", async () => {
      const f = await fixture(role);
      const client = (fixtures[0].runtime as any).coordinator.getTelegramClient();
      for (let n = 0; n < 3; n++) {
        if (n) {
          expect((await f.runtime.handleInboundText(`Task ${n}`, f.ctx, n + 1)).accepted).toBe(true);
          await f.runtime.outbox.whenIdle();
        }
        const run = (f.runtime as any).currentRun;
        await expect(client.callApi("sendMessage", { chat_id: testConfig.chatId, text: "trigger ordinary 429" })).rejects.toMatchObject({ code: "TELEGRAM_HTTP_429" });
        await vi.waitFor(() => expect(run.suppressed).toBe(true));
        f.runtime.onTurnEnd({ role: "assistant", content: "Discarded answer", stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
        expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
        expect(run.workingMessageId).toBeUndefined();
        await vi.waitFor(() => expect((f.runtime as any).rateLimitUntil).toBe(0), { timeout: 2500 });
      }
      expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(0);
      expect(calls.some(c => c.params.text === "Discarded answer")).toBe(false);
    }, 15_000);

    it("releases placeholder references immediately when the bounded FIFO fails", async () => {
      const f = await fixture(role);
      const run = (f.runtime as any).currentRun;
      const failure = new Error("Output failed");
      f.runtime.outbox.enqueue(async () => { throw failure; });
      await f.runtime.outbox.whenIdle();
      expect(f.runtime.outbox.error).toBe(failure);
      expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
      expect(run.workingMessageId).toBeUndefined();
    });
  });

  it.each(["startup", "resume"] as const)("automatically reopens another session on %s after a five-second shared cleanup cooldown", async reason => {
    const a = await fixture("leader");
    deletionFailure = 429;
    deletionRetryAfter = 5;
    a.runtime.onTurnEnd({ role: "assistant", content: "Answer after cooldown", stopReason: "stop" });
    await a.runtime.onAgentSettled(a.ctx);
    await vi.waitFor(() => expect((a.runtime as any).rateLimitPreservesOutput).toBe(true));
    const started = Date.now();
    const b = await runtimeFixture(dir, "resuming", 51, reason);
    fixtures.push(b);
    // A pre-HTTP pause must return promptly, not consume the reopen I/O deadline.
    expect(Date.now() - started).toBeLessThan(2500);
    expect((b.runtime as any).topicNeedsReopen).toBe(true);
    expect((b.runtime as any).rateLimitReopenTarget).not.toBeNull();
    expect((b.runtime as any).connectionError).toMatchObject({ code: "TELEGRAM_CLEANUP_PAUSED" });
    expect(calls.filter(c => c.method === "reopenForumTopic")).toHaveLength(0);
    await vi.waitFor(() => expect((b.runtime as any).topicNeedsReopen).toBe(false), { timeout: 8000 });
    expect((b.runtime as any).rateLimitReopenTarget).toBeNull();
    expect((b.runtime as any).connectionError).toBeNull();
    const reopens = calls.filter(c => c.method === "reopenForumTopic");
    expect(reopens).toHaveLength(1);
    expect(reopens[0].params.message_thread_id).toBe(b.runtime.getCurrentThreadId());
    expect(reopens[0].time - calls.find(c => c.method === "deleteMessage")!.time).toBeGreaterThanOrEqual(5000);
    await a.runtime.outbox.whenIdle();
    expect(calls.some(c => c.params.text === "Answer after cooldown")).toBe(true);
    expect(a.runtime.outbox.error).toBeNull();
    expect(b.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("please check and run /tg-connect"), "error");
  }, 15_000);

  it("abandons old placeholder authority on TCP loss but preserves the active reply on reconnect", async () => {
    const f = await fixture("follower");
    const run = (f.runtime as any).currentRun;
    const previous = (f.runtime as any).followerClient;
    previous.socket.destroy();
    await vi.waitFor(() => expect(run.workingMessageId).toBeUndefined());
    expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
    await vi.waitFor(() => expect(f.runtime.hasActiveTransport()).toBe(true), { timeout: 3000 });
    expect((f.runtime as any).followerClient).not.toBe(previous);
    f.runtime.onTurnEnd({ role: "assistant", content: "After reconnect", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(calls.filter(c => c.method === "deleteMessage")).toHaveLength(0);
    expect(calls.filter(c => c.method === "sendMessage").map(c => c.params.text)).toEqual(["⏳ Working...", "After reconnect"]);
    expect(f.runtime.outbox.error).toBeNull();
  });
});

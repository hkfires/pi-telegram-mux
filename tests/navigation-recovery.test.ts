import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../src/ipc.js";
import { MuxRuntime } from "../src/runtime.js";
import { runtimeFixture } from "./helpers.js";

const navigationEvents = ["onSessionBeforeTree", "onSessionBeforeSwitch", "onSessionBeforeFork"] as const;

describe("navigation registration and outbox recovery status", () => {
  let dir: string;
  const fixtures: { runtime: MuxRuntime; ctx: ExtensionContext }[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-navigation-recovery-")); });
  afterEach(async () => {
    for (const { runtime, ctx } of fixtures.reverse()) await runtime.onSessionShutdown(ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe.each(["leader", "follower"])("working message cleanup for %s", role => {
    it.each(["disconnect", "disconnect-twice", "setup", "empty-settlement", "switch", "fork", "tree", "shutdown", "shutdown-timeout"])("handles working message and route ownership on %s", async action => {
      const originalFetch = globalThis.fetch;
      const completed: number[] = [];
      let messageId = 0;
      let aborted = 0;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }));
        }
        if (url.endsWith("/deleteMessage")) {
          const params = JSON.parse(String(init?.body));
          await new Promise<void>((resolve, reject) => {
            const timer = action === "shutdown-timeout" ? undefined : setTimeout(resolve, 20);
            const abort = () => { clearTimeout(timer); aborted++; reject(new Error("Aborted")); };
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener("abort", abort, { once: true });
          });
          completed.push(params.message_id);
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        return originalFetch(input, init);
      });
      if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
      const f = await runtimeFixture(dir, "outgoing", 50);
      fixtures.push(f);
      f.pi.sendUserMessage.mockImplementation((text: string) => {
        void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
      });
      const admission = f.runtime.handleInboundText("inbound prompt", f.ctx, 101);
      expect((await admission).accepted).toBe(true);
      await f.runtime.outbox.whenIdle();
      expect(messageId).toBe(1);

      const generation = f.runtime.getGeneration();
      if (action === "setup") {
        f.ui.select.mockResolvedValueOnce("Auto-close Topics: Off").mockResolvedValueOnce("On - Close topics (may wait up to 3 seconds)").mockResolvedValueOnce(undefined);
      }
      const cleanup = action === "setup" ? f.runtime.handleTgSetup(f.ctx)
        : action === "empty-settlement" ? f.runtime.onAgentSettled(f.ctx)
        : action.startsWith("disconnect") ? f.runtime.handleTgDisconnect(f.ctx)
        : action === "switch" ? f.runtime.onSessionBeforeSwitch(f.ctx)
        : action === "fork" ? f.runtime.onSessionBeforeFork(f.ctx)
        : action === "tree" ? f.runtime.onSessionBeforeTree()
        : f.runtime.onSessionShutdown(f.ctx);
      if (action !== "setup" && action !== "empty-settlement") {
        expect(f.runtime.getGeneration()).toBe(generation + 1);
        await expect(f.runtime.handleInboundText("late input", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
      }
      const repeated = action === "disconnect-twice" ? f.runtime.handleTgDisconnect(f.ctx) : undefined;
      await Promise.all([cleanup, repeated]);
      await f.runtime.outbox.whenIdle();

      expect(completed).toEqual(action === "shutdown-timeout" ? [] : [1]);
      if (action === "empty-settlement") expect(messageId).toBe(1);
      if (action === "setup") expect(f.ui.notify).toHaveBeenCalledWith("Telegram configuration saved and applied.", "info");
      // Follower cancellation reaches the Leader on the next socket event.
      await vi.waitFor(() => expect(aborted).toBe(action === "shutdown-timeout" ? 1 : 0));
      expect(f.runtime.outbox.error).toBeNull();
      if (action.startsWith("shutdown")) expect(f.runtime.hasActiveTransport()).toBe(false);
      else if (action.startsWith("disconnect")) {
        expect(f.runtime.getBindingState()).toBe("disconnected");
        if (action === "disconnect-twice") {
          const replacement = await runtimeFixture(dir, "replacement", 50);
          fixtures.push(replacement);
          expect(await replacement.runtime.registerRoute(replacement.ctx)).toBe(true);
        } else {
          await f.runtime.handleTgConnect(f.ctx);
          expect(f.runtime.getBindingState()).toBe("bound");
        }
      }
    }, 10_000);
  });

  it.each(["disconnect", "switch", "shutdown"])("cleans a settled placeholder while output is paused before %s", async action => {
    const f = await runtimeFixture(dir, "settled", 50);
    fixtures.push(f);
    const fetch = globalThis.fetch;
    const deleted: number[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any) => {
      if (String(input).endsWith("/deleteMessage")) deleted.push(JSON.parse(init.body).message_id);
      return fetch(input, init);
    });
    f.pi.sendUserMessage.mockImplementation((text: string) => {
      void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
    });
    await f.runtime.handleInboundText("Task", f.ctx, 1);
    await f.runtime.outbox.whenIdle();
    let started!: () => void;
    const paused = new Promise<void>(resolve => { started = resolve; });
    f.runtime.outbox.enqueue(signal => new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      started();
    }));
    await paused;
    f.runtime.onMessageEnd({ role: "assistant", content: "Result", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    expect((f.runtime as any).currentRun).toBeNull();
    expect(deleted).toEqual([]);
    if (action === "disconnect") await f.runtime.handleTgDisconnect(f.ctx);
    else if (action === "switch") await f.runtime.onSessionBeforeSwitch(f.ctx);
    else await f.runtime.onSessionShutdown(f.ctx);
    expect(deleted).toEqual([100]);
    expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
  });

  it.each(navigationEvents)("does not enqueue %s registration for an unconfigured TUI session", async event => {
    const ui = { setStatus: vi.fn(), notify: vi.fn() };
    const ctx = {
      mode: "tui", cwd: dir, ui,
      sessionManager: { getSessionId: () => "unconfigured", getEntries: () => [] },
    } as unknown as ExtensionContext;
    const runtime = new MuxRuntime({} as ExtensionAPI, dir);
    fixtures.push({ runtime, ctx });
    await runtime.onSessionStart(ctx);
    expect(ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: unconfigured");
    const register = vi.spyOn(runtime, "registerRoute");
    const enqueue = vi.spyOn(runtime.outbox, "enqueue");
    const generation = runtime.getGeneration();

    runtime[event](ctx);
    await runtime.outbox.whenIdle();

    expect(runtime.getGeneration()).toBe(generation + 1);
    expect(register).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(runtime.outbox.error).toBeNull();
    expect(ui.notify).not.toHaveBeenCalled();
    expect(ui.setStatus).not.toHaveBeenCalledWith("tg", "tg: error");
    expect(ui.setStatus).toHaveBeenLastCalledWith("tg", event === "onSessionBeforeTree" ? "tg: unconfigured" : undefined);
  });

  it.each(navigationEvents)("does not enqueue late %s registration after integration shutdown", async event => {
    const f = await runtimeFixture(dir, "disabled");
    fixtures.push(f);
    await f.runtime.onSessionShutdown(f.ctx);
    const register = vi.spyOn(f.runtime, "registerRoute");
    const enqueue = vi.spyOn(f.runtime.outbox, "enqueue");
    f.ui.notify.mockClear();
    f.ui.setStatus.mockClear();

    f.runtime[event](f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(register).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.notify).not.toHaveBeenCalled();
    expect(f.ui.setStatus).not.toHaveBeenCalledWith("tg", "tg: error");
  });

  describe.each(["offline", "rejected"] as const)("genuine %s registration failures", failureMode => {
    it.each(navigationEvents)("still exposes failures during %s", async event => {
      const f = await runtimeFixture(dir, "configured");
      fixtures.push(f);
      const register = vi.spyOn(f.runtime, "registerRoute");
      const failure = new IpcError("IPC_CLOSED", "Simulated registration failure");
      if (failureMode === "offline") await (f.runtime as any).stopTransport();
      else register.mockRejectedValue(failure);
      f.ui.notify.mockClear();

      f.runtime[event](f.ctx);
      await f.runtime.outbox.whenIdle();

      expect(register).toHaveBeenCalledTimes(1);
      expect(f.runtime.outbox.error).toBeInstanceOf(Error);
      if (failureMode === "rejected") expect(f.runtime.outbox.error).toBe(failure);
      expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sync paused"), "error");
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    });
  });

  it.each(["leader", "follower"])("abandons stale placeholders on repeated %s outbox recovery", async role => {
    if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
    const f = await runtimeFixture(dir, "recovering", 50);
    fixtures.push(f);
    const calls = vi.spyOn(f.runtime, "callTelegram");
    f.pi.sendUserMessage.mockImplementation((text: string) => {
      void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
    });
    for (let i = 0; i < 3; i++) {
      expect((await f.runtime.handleInboundText(`Task ${i}`, f.ctx, i + 1)).accepted).toBe(true);
      await f.runtime.outbox.whenIdle();
      const run = (f.runtime as any).currentRun;
      expect((f.runtime as any).pendingPlaceholders.size).toBe(1);
      const failure = new Error("Simulated output failure");
      f.runtime.outbox.enqueue(async () => { throw failure; });
      await f.runtime.outbox.whenIdle();
      f.runtime.onMessageEnd({ role: "assistant", content: "Undelivered", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      expect(f.runtime.outbox.error).toBe(failure);
      await f.runtime.handleTgConnect(f.ctx);
      expect(f.runtime.outbox.error).toBeNull();
      expect((f.runtime as any).pendingPlaceholders.size).toBe(0);
      expect(run.workingMessageId).toBeUndefined();
    }
    expect(calls.mock.calls.filter(([method]) => method === "deleteMessage")).toHaveLength(0);
  });

  it.each(["leader", "follower"])("refreshes bound %s status after /tg-connect recovers a failed outbox", async role => {
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
    if (f !== leader) fixtures.push(f);
    const threadId = f.runtime.getCurrentThreadId();
    const failure = new Error("Simulated send failure");
    const send = vi.spyOn(f.runtime, "callTelegram").mockRejectedValueOnce(failure).mockResolvedValue({} as any);
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "failed prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "discarded answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.runtime.outbox.error).toBe(failure);
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(f.runtime.hasActiveTransport()).toBe(true);

    await f.runtime.handleTgConnect(f.ctx);

    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
    expect(f.runtime.getCurrentThreadId()).toBe(threadId);
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "new prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(send.mock.calls.map(([, params]) => params.text)).toEqual(["🧑‍💻 [Prompt]\nfailed prompt", "🧑‍💻 [Prompt]\nnew prompt", "new answer"]);
    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuxRuntime } from "../src/runtime.js";
import { LeaderCoordinator } from "../src/coordinator.js";
import { IpcError } from "../src/ipc.js";
import { TelegramApiError, TelegramClient } from "../src/telegram.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe("forum topic lifecycle", () => {
  let dir: string;
  const fixtures: Fixture[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-topic-lifecycle-")); });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    fixtures.length = 0;
    await fs.rm(dir, { recursive: true, force: true });
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

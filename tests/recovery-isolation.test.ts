import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import * as configModule from "../src/config.js";
import { encodeFrame, IpcFollowerClient } from "../src/ipc.js";
import { TelegramApiError } from "../src/telegram.js";
import { runtimeFixture } from "./helpers.js";

/** Mock HTTP while retaining real client cancellation and local TCP/IPC ordering. */
function telegramFixture() {
  const originalFetch = globalThis.fetch;
  const state = { sent: [] as string[], pollCount: 0, failPoll: undefined as ((code: number) => void) | undefined, oldSignal: undefined as AbortSignal | undefined, failNewSend: false };
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/getUpdates")) {
      if (++state.pollCount === 1) return new Promise<Response>((resolve, reject) => {
        state.failPoll = code => resolve(new Response(JSON.stringify({ ok: false, error_code: code, description: "Simulated polling failure" }), { status: code }));
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
      if (state.pollCount === 2) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: [] })));
    }
    if (url.pathname.endsWith("/sendMessage")) {
      const { text } = JSON.parse(init!.body as string);
      state.sent.push(text);
      if (text === "🧑‍💻 [Prompt]\nold prompt") return new Promise<Response>((_resolve, reject) => {
        state.oldSignal = init!.signal!;
        state.oldSignal.throwIfAborted();
        state.oldSignal.addEventListener("abort", () => reject(state.oldSignal!.reason), { once: true });
      });
      const body = state.failNewSend ? { ok: false, error_code: 403, description: "Simulated new delivery failure" } : { ok: true, result: { message_id: state.sent.length } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: state.failNewSend ? 403 : 200 }));
    }
    return originalFetch(input, init);
  });
  return state;
}

describe("cross-instance recovery and dependent-send isolation", () => {
  let dir: string;
  const fixtures: Awaited<ReturnType<typeof runtimeFixture>>[] = [];
  const releases: (() => void)[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-recovery-isolation-")); });
  afterEach(async () => {
    releases.splice(0).forEach(release => release());
    for (const f of fixtures.reverse()) {
      await f.runtime.onSessionShutdown(f.ctx);
      await f.runtime.outbox.whenIdle();
    }
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe.each([401, 409])("polling failure HTTP %s", errorCode => {
    it.each(["leader", "other Follower"])("recovers a third instance's queue when the %s restarts polling", async initiator => {
      const network = telegramFixture();
      const leader = await runtimeFixture(dir, "leader", 50);
      fixtures.push(leader);
      const requester = await runtimeFixture(dir, "requester", 51);
      fixtures.push(requester);
      const peer = await runtimeFixture(dir, "peer", 52);
      fixtures.push(peer);
      const oldClient = (peer.runtime as any).followerClient as IpcFollowerClient;
      const generation = peer.runtime.getGeneration();
      const setup = peer.runtime.setupTransport.bind(peer.runtime);
      const resume = new Promise<void>(resolve => releases.push(resolve));
      vi.spyOn(peer.runtime, "setupTransport").mockImplementationOnce(async ctx => { await resume; return setup(ctx); });
      await peer.runtime.onBeforeAgentStart(peer.ctx);
      peer.runtime.onMessageStart({ role: "user", content: "old prompt" }, peer.ctx);
      await vi.waitFor(() => expect(network.sent).toHaveLength(1));
      network.failPoll!(errorCode);
      await vi.waitFor(() => expect(((requester.runtime as any).followerClient as IpcFollowerClient).getStatus().error?.code).toBe(`TELEGRAM_HTTP_${errorCode}`));
      const recovery = initiator === "leader" ? leader : requester;

      await recovery.runtime.handleTgConnect(recovery.ctx);
      await vi.waitFor(() => expect(peer.runtime.getIsReconnecting()).toBe(true));
      await peer.runtime.outbox.whenIdle();

      expect(peer.runtime.outbox.error).toBeNull();
      expect(peer.runtime.getGeneration()).toBeGreaterThan(generation);
      expect(network.oldSignal?.aborted).toBe(true);
      expect(oldClient.isConnected()).toBe(false);
      peer.runtime.onMessageEnd({ role: "assistant", content: "orphaned old answer", stopReason: "stop" });
      await peer.runtime.onAgentSettled(peer.ctx);
      // A Pi run admitted during reconnect must not acquire a target later and
      // send an answer whose prompt was skipped during the recovery window.
      await peer.runtime.onBeforeAgentStart(peer.ctx);
      peer.runtime.onMessageStart({ role: "user", content: "prompt during recovery" }, peer.ctx);
      releases.splice(0).forEach(release => release());
      await vi.waitFor(() => expect(peer.runtime.getIsReconnecting()).toBe(false), { timeout: 2500 });
      expect(peer.runtime.hasActiveTransport()).toBe(true);
      peer.runtime.onMessageEnd({ role: "assistant", content: "answer to skipped prompt", stopReason: "stop" });
      await peer.runtime.onAgentSettled(peer.ctx);
      await peer.runtime.outbox.whenIdle();
      expect(network.sent).toEqual(["🧑‍💻 [Prompt]\nold prompt"]);
      expect(peer.runtime.outbox.error).toBeNull();
      expect(peer.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("sync paused"), "error");

      await peer.runtime.onBeforeAgentStart(peer.ctx);
      peer.runtime.onMessageStart({ role: "user", content: "new prompt" }, peer.ctx);
      peer.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
      await peer.runtime.onAgentSettled(peer.ctx);
      await peer.runtime.outbox.whenIdle();
      expect(network.sent).toEqual(["🧑‍💻 [Prompt]\nold prompt", "🧑‍💻 [Prompt]\nnew prompt", "new answer"]);
      expect(peer.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (peer)");
      expect(peer.runtime.getCurrentThreadId()).toBe(52);

      network.failNewSend = true;
      await peer.runtime.onBeforeAgentStart(peer.ctx);
      peer.runtime.onMessageStart({ role: "user", content: "new failing prompt" }, peer.ctx);
      peer.runtime.onMessageEnd({ role: "assistant", content: "dependent failed answer", stopReason: "stop" });
      await peer.runtime.onAgentSettled(peer.ctx);
      await peer.runtime.outbox.whenIdle();
      expect(network.sent).toHaveLength(4);
      expect(peer.runtime.outbox.error).toBeInstanceOf(Error);
      expect(peer.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    });
  });

  describe.each(["leader", "affected Follower", "other Follower"])("reload initiated by the %s", origin => {
    it.each(["new run", "navigation"])("recovers queued output when %s starts during configuration loading", async operation => {
      const network = telegramFixture();
      const leader = await runtimeFixture(dir, "leader", 50);
      fixtures.push(leader);
      const peer = await runtimeFixture(dir, "peer", 51);
      fixtures.push(peer);
      const other = await runtimeFixture(dir, "other", 52);
      fixtures.push(other);
      const initiator = origin === "leader" ? leader : origin === "affected Follower" ? peer : other;
      const coordinator = (leader.runtime as any).coordinator as LeaderCoordinator;
      const oldClient = (peer.runtime as any).followerClient as IpcFollowerClient;
      const frames = vi.spyOn(coordinator as any, "handleFrame");
      network.failPoll!(401);
      await vi.waitFor(() => {
        expect(((peer.runtime as any).followerClient as IpcFollowerClient).getStatus().error?.code).toBe("TELEGRAM_HTTP_401");
        expect(((other.runtime as any).followerClient as IpcFollowerClient).getStatus().error?.code).toBe("TELEGRAM_HTTP_401");
      });
      const load = configModule.loadConfig;
      let entered!: () => void;
      let release!: () => void;
      const loading = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      releases.push(release);
      vi.spyOn(configModule, "loadConfig").mockImplementationOnce(async agentDir => {
        entered();
        await gate;
        return load(agentDir);
      });
      const recovery = initiator.runtime.handleTgConnect(initiator.ctx);
      try {
        await loading;
        if (operation === "navigation") peer.runtime.onSessionBeforeTree();
        else {
          await peer.runtime.onBeforeAgentStart({ prompt: "prompt during recovery" }, peer.ctx);
          peer.runtime.onMessageStart({ role: "user", content: "prompt during recovery" }, peer.ctx);
        }
        if (operation === "navigation" || peer !== initiator) {
          await vi.waitFor(() => expect(frames.mock.calls.some(([, state, message]: any) =>
            state.runtimeId === peer.runtime.runtimeId && message.type === "register")).toBe(true));
        } else {
          expect(peer.runtime.getIsReconnecting()).toBe(true);
          expect(peer.runtime.outbox.size).toBe(0);
        }
        release();
        await recovery;
        await vi.waitFor(() => {
          expect((peer.runtime as any).followerClient).not.toBe(oldClient);
          expect(peer.runtime.hasActiveTransport()).toBe(true);
          expect(peer.runtime.getIsReconnecting()).toBe(false);
        }, { timeout: 3000 });
        await peer.runtime.outbox.whenIdle();
        expect(peer.runtime.outbox.error).toBeNull();
        peer.runtime.onMessageEnd({ role: "assistant", content: "discarded recovery answer", stopReason: "stop" });
        await peer.runtime.onAgentSettled(peer.ctx);
        await peer.runtime.outbox.whenIdle();
        expect(network.sent).toEqual([]);
        expect(initiator.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Telegram connection failed"), "error");
        expect(peer.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("sync paused"), "error");

        await peer.runtime.onBeforeAgentStart({ prompt: "fresh prompt" }, peer.ctx);
        peer.runtime.onMessageStart({ role: "user", content: "fresh prompt" }, peer.ctx);
        peer.runtime.onMessageEnd({ role: "assistant", content: "fresh answer", stopReason: "stop" });
        await peer.runtime.onAgentSettled(peer.ctx);
        await peer.runtime.outbox.whenIdle();
        expect(network.sent).toEqual(["🧑‍💻 [Prompt]\nfresh prompt", "fresh answer"]);
        expect(peer.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (peer)");
      } finally {
        release();
        await recovery;
      }
    });
  });

  it.each(["auth", "register"])("keeps reconnecting when reset arrives in the same batch as %s acknowledgement", async phase => {
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const coordinator = (leader.runtime as any).coordinator;
    const handleFrame = coordinator.handleFrame.bind(coordinator);
    let notified = false;
    vi.spyOn(coordinator, "handleFrame").mockImplementation(async (socket: any, state: any, message: any) => {
      if (message.type !== phase || notified) return handleFrame(socket, state, message);
      notified = true;
      // Coalesce ACK + reset so the connection continuation runs only after the
      // reset handler. This is a real TCP ordering race, not a mocked connect().
      socket.cork();
      await handleFrame(socket, state, message);
      socket.write(encodeFrame({ type: "transport_reset" }));
      socket.uncork();
      socket.end();
    });
    const peer = await runtimeFixture(dir, "peer", 51);
    fixtures.push(peer);
    expect(peer.runtime.hasActiveTransport()).toBe(false);
    expect(peer.runtime.getIsReconnecting()).toBe(true);
    await vi.waitFor(() => {
      expect(peer.runtime.hasActiveTransport()).toBe(true);
      expect(peer.runtime.getIsReconnecting()).toBe(false);
    }, { timeout: 2500 });
    expect(peer.runtime.outbox.error).toBeNull();
    expect(peer.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (peer)");
  });

  it("does not treat an unexplained IPC disconnect as a coordinated queue reset", async () => {
    const network = telegramFixture();
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const peer = await runtimeFixture(dir, "peer", 51);
    fixtures.push(peer);
    const oldClient = (peer.runtime as any).followerClient as IpcFollowerClient;
    await peer.runtime.onBeforeAgentStart(peer.ctx);
    peer.runtime.onMessageStart({ role: "user", content: "old prompt" }, peer.ctx);
    await vi.waitFor(() => expect(network.sent).toHaveLength(1));
    const coordinator = (leader.runtime as any).coordinator as LeaderCoordinator;
    const socket = [...(coordinator as any).connections.entries()].find(([, state]: any) => state.runtimeId === peer.runtime.runtimeId)![0];
    socket.destroy();
    await vi.waitFor(() => expect(peer.runtime.outbox.error).toMatchObject({ code: "IPC_CLOSED" }));
    await vi.waitFor(() => {
      expect((peer.runtime as any).followerClient?.isConnected()).toBe(true);
      expect(peer.runtime.getIsReconnecting()).toBe(false);
    }, { timeout: 2500 });
    expect((peer.runtime as any).followerClient).not.toBe(oldClient);
    expect(peer.runtime.outbox.error).toMatchObject({ code: "IPC_CLOSED" });
    expect(peer.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(network.sent).toHaveLength(1);
  });

  it.each(["leader", "follower"])("invalidates the unfinished %s run when its failed outbox is recovered", async role => {
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
    if (f !== leader) fixtures.push(f);
    const failure = new TelegramApiError("Simulated prompt failure", 403);
    const call = vi.spyOn(f.runtime, "callTelegram").mockRejectedValueOnce(failure).mockResolvedValue({} as any);
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "failed prompt" }, f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.outbox.error).toBe(failure);
    expect(f.runtime.getIsIdle()).toBe(false);
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.runtime.outbox.error).toBeNull();
    f.runtime.onMessageEnd({ role: "assistant", content: "orphaned answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(call).toHaveBeenCalledTimes(1);
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "new prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(call.mock.calls.map(([, params]) => params.text)).toEqual(["🧑‍💻 [Prompt]\nfailed prompt", "🧑‍💻 [Prompt]\nnew prompt", "new answer"]);
  });

  describe.each(["leader", "follower"])("disconnected %s", role => {
    it.each(["oversized prompt", "many prompts"])("never enqueues synchronization for %s", async workload => {
      const leader = await runtimeFixture(dir, "leader", 50);
      fixtures.push(leader);
      const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
      if (f !== leader) fixtures.push(f);
      f.runtime.handleTgDisconnect(f.ctx);
      f.ui.notify.mockClear();
      const enqueue = vi.spyOn(f.runtime.outbox, "enqueue");
      const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
      await f.runtime.onBeforeAgentStart(f.ctx);
      const text = workload === "oversized prompt" ? "x".repeat(256 * 1024 + 1) : "local follow-up";
      for (let i = 0; i < (workload === "oversized prompt" ? 1 : 100); i++) f.runtime.onMessageStart({ role: "user", content: text }, f.ctx);
      f.runtime.onMessageEnd({ role: "assistant", content: "local answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await f.runtime.outbox.whenIdle();
      expect(enqueue).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      expect(f.runtime.outbox.error).toBeNull();
      expect(f.runtime.outbox.size).toBe(0);
      expect(f.runtime.getBindingState()).toBe("disconnected");
      expect(f.ui.notify).not.toHaveBeenCalled();
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: disconnected");
      await f.runtime.handleTgConnect(f.ctx);
      await f.runtime.onBeforeAgentStart(f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "new prompt" }, f.ctx);
      f.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await f.runtime.outbox.whenIdle();
      expect(call.mock.calls.map(([, params]) => params.text)).toEqual(["🧑‍💻 [Prompt]\nnew prompt", "new answer"]);
    });
  });
});

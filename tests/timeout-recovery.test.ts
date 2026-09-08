import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { IpcFollowerClient } from "../src/ipc.js";
import { TelegramApiError, TelegramClient, TelegramRequestError } from "../src/telegram.js";
import { runtimeFixture, telegramUpdate } from "./helpers.js";

describe("transient Telegram failures across two runtimes", () => {
  let dir: string;
  let coordinator: LeaderCoordinator;
  const fixtures: Awaited<ReturnType<typeof runtimeFixture>>[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-timeout-recovery-")); });
  afterEach(async () => {
    for (const f of fixtures.reverse()) {
      await f.runtime.onSessionShutdown(f.ctx);
      await f.runtime.outbox.whenIdle();
    }
    await coordinator?.feedback.whenIdle();
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function pair() {
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    coordinator = (leader.runtime as unknown as { coordinator: LeaderCoordinator }).coordinator;
    const follower = await runtimeFixture(dir, "follower", 51);
    fixtures.push(follower);
    const ipc = (follower.runtime as unknown as { followerClient: IpcFollowerClient }).followerClient;
    return { leader, follower, ipc };
  }

  it.each([
    new TelegramRequestError("TELEGRAM_TIMEOUT", "Telegram request timed out (getUpdates)"),
    new TelegramRequestError("ECONNRESET", "Telegram connection reset (getUpdates)"),
    new TelegramApiError("HTTP 503", 503),
  ])("shows polling retries and automatically restores both status bars (%s)", async error => {
    let failPoll!: () => void;
    const poll = vi.spyOn(TelegramClient.prototype, "getUpdates").mockImplementationOnce(options => new Promise((_resolve, reject) => {
      failPoll = () => reject(error);
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    })).mockResolvedValueOnce([]);
    const { leader, follower, ipc } = await pair();
    const reload = vi.spyOn(coordinator, "reloadConfig");
    const elect = vi.spyOn(LeaderCoordinator.prototype, "start");
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    // Both windows are connected before the Leader encounters the timeout.
    failPoll();

    await vi.waitFor(() => {
      expect(ipc.getStatus()).toMatchObject({ polling: "retrying", error: { code: error.code } });
      for (const f of [leader, follower]) {
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: reconnecting");
        expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(error.code), "warning");
        // Polling retries are not IPC reconnects and must not suppress local runs.
        expect(f.runtime.getIsReconnecting()).toBe(false);
      }
    });
    await vi.waitFor(() => {
      expect(ipc.getStatus().polling).toBe("online");
      for (const f of [leader, follower]) {
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
      }
    }, { timeout: 3500 });
    expect(coordinator.getStatus().error).toBeUndefined();
    expect(ipc.getStatus().error).toBeUndefined();
    expect(poll.mock.contexts.every(client => client === coordinator.getTelegramClient())).toBe(true);
    expect(ipc.isConnected()).toBe(true);
    expect(leader.runtime.getIsLeader()).toBe(true);
    expect(follower.runtime.getIsLeader()).toBe(false);
    expect(elect).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    for (const f of [leader, follower]) {
      expect(f.runtime.outbox.error).toBeNull();
      expect(f.ui.setStatus).not.toHaveBeenCalledWith("tg", "tg: error");
    }
  });

  it("isolates an actual feedback request timeout without replaying it or poisoning either window", async () => {
    const fetch = globalThis.fetch;
    const requests: { message_thread_id: number; text: string }[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/sendMessage")) return fetch(input, init);
      requests.push(JSON.parse(init!.body as string));
      if (requests.length === 1) return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } })));
    });
    const callApi = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, params, timeout, signal, options) {
      // Exercise the real abort/timeout classification without a 30-second test.
      return callApi.call(this, method, params, method === "sendMessage" ? 25 : timeout, signal, options);
    });
    vi.spyOn(TelegramClient.prototype, "getUpdates").mockResolvedValueOnce([]);
    const { leader, follower, ipc } = await pair();
    const reload = vi.spyOn(coordinator, "reloadConfig");
    await coordinator.processUpdate(telegramUpdate(50, "/status", 1));
    await coordinator.processUpdate(telegramUpdate(51, "/status", 2));
    await coordinator.feedback.whenIdle();

    expect(coordinator.feedback.error).toBeNull();
    expect(coordinator.getStatus()).toMatchObject({ polling: "online", interactionError: { code: "TELEGRAM_TIMEOUT" } });
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    await vi.waitFor(() => expect(ipc.getStatus().interactionError?.code).toBe("TELEGRAM_TIMEOUT"));
    for (const f of [leader, follower]) {
      expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not be confirmed"), "warning");
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
      expect(f.ui.setStatus).not.toHaveBeenCalledWith("tg", "tg: error");
      f.runtime.handleTgStatus(f.ctx);
      expect(f.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Menu / Reply Warning: Telegram command feedback"), "info");
    }
    expect(requests.map(request => request.message_thread_id)).toEqual([50, 51]);
    // Later independent feedback also works for the topic whose reply timed out.
    await coordinator.processUpdate(telegramUpdate(50, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(requests.map(request => request.message_thread_id)).toEqual([50, 51, 50]);
    expect(reload).not.toHaveBeenCalled();
    expect(ipc.isConnected()).toBe(true);
  });

  it.each(["feedback", "output"])("does not hide or reset a real %s queue failure when polling recovers", async queue => {
    vi.spyOn(TelegramClient.prototype, "getUpdates")
      .mockRejectedValueOnce(new TelegramRequestError("TELEGRAM_TIMEOUT", "Telegram request timed out (getUpdates)"))
      .mockResolvedValueOnce([]);
    const { leader, follower, ipc } = await pair();
    const error = queue === "feedback"
      ? new TelegramApiError("Forbidden", 403)
      : new TelegramRequestError("TELEGRAM_TIMEOUT", "Telegram request timed out (sendMessage)");
    const callApi = TelegramClient.prototype.callApi;
    const send = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "sendMessage") return Promise.reject(error);
      return callApi.call(this, method, ...args);
    });
    if (queue === "feedback") {
      await coordinator.processUpdate(telegramUpdate(50, "/status", 1));
      await coordinator.processUpdate(telegramUpdate(51, "/status", 2));
      await coordinator.feedback.whenIdle();
      expect(coordinator.feedback.error).toBe(error);
      await vi.waitFor(() => expect(ipc.getStatus().feedbackError?.code).toBe(error.code));
    } else {
      await follower.runtime.onBeforeAgentStart(follower.ctx);
      follower.runtime.onMessageStart({ role: "user", content: "prompt with uncertain delivery" }, follower.ctx);
      follower.runtime.onMessageEnd({ role: "assistant", content: "must not follow the failed prompt", stopReason: "stop" });
      await follower.runtime.onAgentSettled(follower.ctx);
      await follower.runtime.outbox.whenIdle();
      expect(follower.runtime.outbox.error?.message).toBe(error.message);
    }
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    await vi.waitFor(() => expect(ipc.getStatus().polling).toBe("online"), { timeout: 3500 });
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(leader.ui.setStatus).toHaveBeenLastCalledWith("tg", queue === "feedback" ? "tg: error" : "tg: connected (leader)");
    expect(send.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
    expect(ipc.isConnected()).toBe(true);
  });
});

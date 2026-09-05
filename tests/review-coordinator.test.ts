import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { IpcFollowerClient } from "../src/ipc.js";
import { saveConfig } from "../src/config.js";
import { TelegramApiError, TelegramClient, TelegramDecodeError, TelegramRequestError } from "../src/telegram.js";
import { telegramUpdate, testConfig } from "./helpers.js";

const me = { id: 1, is_bot: true, first_name: "Fixture", username: "review_bot" };

describe("review regressions: polling, commands and feedback backpressure", () => {
  let dir: string;
  let coordinator: LeaderCoordinator;
  let client: TelegramClient;
  let follower: IpcFollowerClient | undefined;
  const releases: (() => void)[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-review-coordinator-"));
    await saveConfig(dir, testConfig);
    client = new TelegramClient({ botToken: testConfig.botToken });
    vi.spyOn(client, "getMe").mockResolvedValue(me);
    coordinator = new LeaderCoordinator(testConfig, dir, client);
  });
  afterEach(async () => {
    vi.useRealTimers();
    releases.splice(0).forEach(release => release());
    follower?.close();
    follower = undefined;
    await coordinator.stop();
    await coordinator.feedback.whenIdle();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
  }
  function route(threadId: number, abortRun = vi.fn(() => true)) {
    const dispatchInbound = vi.fn(async () => ({ accepted: false, busy: true }));
    coordinator.registerLocalRoute({ runtimeId: `runtime-${threadId}`, sessionId: `session-${threadId}`, generation: 1, threadId, dispatchInbound, abortRun });
    return { dispatchInbound, abortRun };
  }

  it("processes another topic's /stop while polling feedback delivery is stalled", async () => {
    const barrier = gate();
    const send = vi.spyOn(client, "sendMessage").mockImplementation(async () => { await barrier.promise; return {} as any; });
    vi.spyOn(client, "getUpdates").mockResolvedValueOnce([telegramUpdate(50, "busy"), telegramUpdate(51, "/stop", 2)]);
    route(50);
    const second = route(51);
    await coordinator.start();
    await vi.waitFor(() => expect(second.abortRun).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
    expect(coordinator.feedback.size).toBe(2);
    barrier.resolve();
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenLastCalledWith(testConfig.chatId, "已发送中止信号", { message_thread_id: 51 }, expect.any(AbortSignal));
  });

  it("bounds feedback, exposes overflow and still executes control commands", async () => {
    const barrier = gate();
    vi.spyOn(client, "sendMessage").mockImplementation(async () => { await barrier.promise; return {} as any; });
    const bound = route(50);
    await coordinator.start();
    for (let i = 0; i < 100; i++) await coordinator.processUpdate(telegramUpdate(50, "/status", i));
    expect(coordinator.feedback.size).toBeLessThanOrEqual(32);
    expect(coordinator.getStatus().feedbackError?.code).toBe("OUTBOX_FULL");
    await coordinator.processUpdate(telegramUpdate(50, "/stop", 101));
    expect(bound.abortRun).toHaveBeenCalledTimes(1);
  });

  it("drops queued old-chat feedback on configuration reload", async () => {
    const barrier = gate();
    const send = vi.spyOn(client, "sendMessage").mockImplementation(async () => { await barrier.promise; return {} as any; });
    route(50);
    await coordinator.start();
    await coordinator.processUpdate(telegramUpdate(50, "/status"));
    await coordinator.processUpdate(telegramUpdate(50, "/status", 2));
    await saveConfig(dir, { ...testConfig, chatId: -100999, allowedUserId: 999 });
    await coordinator.reloadConfig();
    barrier.resolve();
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(coordinator.getRoutes().size).toBe(0);
  });

  it("fences queued feedback when a route keeps ownership but changes generation", async () => {
    const barrier = gate();
    const send = vi.spyOn(client, "sendMessage").mockImplementation(async () => { await barrier.promise; return {} as any; });
    route(50);
    await coordinator.start();
    await coordinator.processUpdate(telegramUpdate(50, "/status"));
    await coordinator.processUpdate(telegramUpdate(50, "/stop", 2));
    const old = coordinator.getRoutes().get(50)!;
    coordinator.registerLocalRoute({ ...old, generation: old.generation + 1 });
    barrier.resolve();
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("exposes feedback errors instead of silently pretending delivery succeeded", async () => {
    vi.spyOn(client, "sendMessage").mockRejectedValue(new TelegramApiError("delivery denied", 403));
    route(50);
    await coordinator.start();
    await coordinator.processUpdate(telegramUpdate(50, "/status"));
    await coordinator.feedback.whenIdle();
    expect(coordinator.getStatus().feedbackError?.code).toBe("TELEGRAM_HTTP_403");
    expect(coordinator.feedback.error).toBeInstanceOf(TelegramApiError);
  });

  it.each([new TelegramApiError("arbitrary text", 401), new TelegramApiError("arbitrary text", 403), new TelegramDecodeError("malformed response")])("halts permanent polling failure and publishes its stable code (%s)", async error => {
    const poll = vi.spyOn(client, "getUpdates").mockRejectedValue(error);
    const info = await coordinator.start();
    await vi.waitFor(() => expect(coordinator.getStatus().polling).toBe("error"));
    // The poller halted, but the Leader still owns its lock and IPC listener.
    expect(coordinator.isRunning()).toBe(true);
    follower = new IpcFollowerClient(info.port, info.capability, "observer");
    await follower.connect();
    expect(follower.getStatus().error?.code).toBe(error.code);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await coordinator.reloadConfig();
    expect(coordinator.getStatus().error).toBeUndefined();
    expect(coordinator.isRunning()).toBe(true);
    await coordinator.stop();
    expect(coordinator.isRunning()).toBe(false);
  });

  it.each([new TelegramApiError("not matched by text", 503), new TelegramRequestError("ECONNRESET", "not matched by text")])("retries justified transient polling failures (%s)", async error => {
    const poll = vi.spyOn(client, "getUpdates").mockRejectedValueOnce(error).mockResolvedValueOnce([]);
    await coordinator.start();
    await vi.waitFor(() => expect(coordinator.getStatus().polling).toBe("retrying"));
    // Retry delay already exists as a real timer, so wait for the observable recovery.
    await vi.waitFor(() => expect(coordinator.getStatus().polling).toBe("online"), { timeout: 3500 });
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["getMe", "getUpdates"])("automatically resumes after a temporary DNS failure in %s", async method => {
    vi.mocked(client.getMe).mockRestore();
    const fetch = globalThis.fetch;
    let failed = false;
    let successfulPoll = false;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith(`/${method}`) && !failed) {
        failed = true;
        // Match Node fetch's nested DNS error without contacting external services.
        return Promise.reject(new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND" }),
        }));
      }
      if (String(input).endsWith("/getUpdates") && !successfulPoll) {
        successfulPoll = true;
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: [] })));
      }
      return fetch(input, init);
    });
    await coordinator.start();
    await vi.waitFor(() => expect(coordinator.getStatus()).toMatchObject({ polling: "retrying", error: { code: "ENOTFOUND" } }));
    await vi.waitFor(() => expect(coordinator.getStatus().polling).toBe("online"), { timeout: 3500 });
    expect(coordinator.getStatus().error).toBeUndefined();
    expect(successfulPoll).toBe(true);
    expect(coordinator.isRunning()).toBe(true);
  });

  it("automatically resumes polling after a temporary HTML gateway error", async () => {
    const fetch = globalThis.fetch;
    let polls = 0;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/getUpdates")) {
        if (++polls === 1) return Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }));
        if (polls === 2) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: [] })));
      }
      return fetch(input, init);
    });
    await coordinator.start();
    await vi.waitFor(() => expect(coordinator.getStatus()).toMatchObject({ polling: "retrying", error: { code: "TELEGRAM_HTTP_502" } }));
    await vi.waitFor(() => expect(coordinator.getStatus().polling).toBe("online"), { timeout: 3500 });
    expect(coordinator.getStatus().error).toBeUndefined();
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it.each(["stop", "status"])("normalizes /%s@bot and ignores other bots", async command => {
    const send = vi.spyOn(client, "sendMessage").mockResolvedValue({} as any);
    const bound = route(50);
    await coordinator.start();
    await vi.waitFor(() => expect(client.getMe).toHaveResolvedWith(me));
    await coordinator.processUpdate(telegramUpdate(50, `/${command}@other_bot`));
    expect(send).not.toHaveBeenCalled();
    expect(bound.abortRun).not.toHaveBeenCalled();
    await coordinator.processUpdate(telegramUpdate(50, `/${command}@ReVieW_BoT`));
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(bound.dispatchInbound).not.toHaveBeenCalled();
    expect(bound.abortRun).toHaveBeenCalledTimes(command === "stop" ? 1 : 0);
  });
});

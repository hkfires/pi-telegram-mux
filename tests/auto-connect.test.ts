import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramApiError, TelegramClient } from "../src/telegram.js";
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

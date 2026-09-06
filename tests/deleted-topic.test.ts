import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBindingState } from "../src/binding.js";
import { MuxRuntime } from "../src/runtime.js";
import { TelegramApiError, TelegramClient } from "../src/telegram.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe.each(["leader", "follower"])("deleted topic recovery on %s", role => {
  let dir: string;
  let f: Fixture;
  let reopenError: Error | null;
  let createError: Error | null;
  const fixtures: Fixture[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-deleted-topic-"));
    reopenError = new TelegramApiError("Bad Request: TOPIC_ID_INVALID", 400);
    createError = null;
    requests.length = 0;
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(async function (method, params, ...args) {
      if (method === "reopenForumTopic" || method === "closeForumTopic" || method === "createForumTopic" || method === "sendMessage") {
        requests.push({ method, params: params! });
      }
      if (method === "reopenForumTopic" && params?.message_thread_id === 108 && reopenError) throw reopenError;
      if (method === "createForumTopic") {
        if (createError) throw createError;
        return { message_thread_id: 208, name: "Replacement", icon_color: 1 } as any;
      }
      if (method === "sendMessage") return { message_id: 1 } as any;
      return original.call(this, method, params, ...args);
    });
    if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
    f = await runtimeFixture(dir, "restored", 108);
    fixtures.push(f);
    f.entries.push({ type: "message", message: { role: "assistant", content: "Previous answer" } });
    expect(f.runtime.getIsLeader()).toBe(role === "leader");
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
  });

  afterEach(async () => {
    for (const fixture of fixtures.reverse()) await fixture.runtime.onSessionShutdown({ reason: "reload" }, fixture.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(["startup", "resume", "reload"] as const)("warns on %s and creates nothing without a prompt", async reason => {
    await f.runtime.onSessionStart({ reason }, f.ctx);
    expect(f.runtime.getBindingState()).toBe("topic-missing");
    expect(f.runtime.getCurrentThreadId()).toBeNull();
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("next prompt in Pi"), "warning");
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: topic deleted");
    expect(f.runtime.outbox.error).toBeNull();
    expect(resolveBindingState(f.entries, "restored", testConfig.chatId)).toEqual({ state: "topic-missing", threadId: null, lastValidThreadId: null });
    const coordinator = (fixtures[0].runtime as any).coordinator;
    await vi.waitFor(() => expect(coordinator.getRoutes().has(108)).toBe(false));
    if (role === "follower") expect(coordinator.getRoutes().has(10)).toBe(true);

    f.runtime.handleTgStatus(f.ctx);
    await f.runtime.handleTgConnect(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(0);
    expect(requests.filter(r => r.method === "reopenForumTopic")).toHaveLength(1);
    await f.runtime.onSessionShutdown(f.ctx);
    expect(requests.filter(r => r.method === "closeForumTopic")).toHaveLength(0);
  });

  it("creates one replacement on the next prompt and mirrors that prompt and subsequent replies", async () => {
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    for (const prompt of ["first prompt", "second prompt"]) {
      await f.runtime.onBeforeAgentStart({ prompt }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: prompt }, f.ctx);
      f.runtime.onMessageEnd({ role: "assistant", content: `answer to ${prompt}`, stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
    }
    await f.runtime.outbox.whenIdle();
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(1);
    expect(requests.filter(r => r.method === "sendMessage").map(r => [r.params.message_thread_id, r.params.text])).toEqual([
      [208, "🧑‍💻 [Prompt]\nfirst prompt"], [208, "answer to first prompt"],
      [208, "🧑‍💻 [Prompt]\nsecond prompt"], [208, "answer to second prompt"],
    ]);
    expect(resolveBindingState(f.entries, "restored", testConfig.chatId)).toEqual({ state: "bound", threadId: 208, lastValidThreadId: 208 });
    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (stored)");
    expect(f.ui.notify).toHaveBeenCalledWith("Telegram topic was deleted. Creating a replacement topic for this session...", "warning");
    expect(f.ui.notify).toHaveBeenCalledWith("Connected to new topic 208.", "info");
  });

  it("remembers the pending replacement across runtime restarts and then restores the new binding", async () => {
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    f = { ...f, runtime: new MuxRuntime(f.pi as any, dir) };
    fixtures.push(f);
    f.ui.notify.mockClear();
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    expect(f.runtime.getBindingState()).toBe("topic-missing");
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("next prompt in Pi"), "warning");
    expect(requests.filter(r => r.method === "reopenForumTopic")).toHaveLength(1);
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(0);

    await f.runtime.onBeforeAgentStart({ prompt: "after restart" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "after restart" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    f = { ...f, runtime: new MuxRuntime(f.pi as any, dir) };
    fixtures.push(f);
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    expect(f.runtime.getCurrentThreadId()).toBe(208);
    expect(requests.filter(r => r.method === "reopenForumTopic").map(r => r.params.message_thread_id)).toEqual([108, 208]);
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(1);
  });

  it("lets a manual disconnect cancel the pending replacement without remembering the deleted ID", async () => {
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    f.runtime.handleTgDisconnect(f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "local only" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local only" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(resolveBindingState(f.entries, "restored", testConfig.chatId)).toEqual({ state: "disconnected", threadId: null, lastValidThreadId: null });
    expect(requests.filter(r => r.method === "createForumTopic" || r.method === "sendMessage")).toHaveLength(0);
  });

  it.each(["TOPIC_ID_INVALID", "Bad Request: message thread not found"])("recognizes the missing-topic response %s over either transport", async message => {
    reopenError = new TelegramApiError(message, 400);
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    expect(f.runtime.getBindingState()).toBe("topic-missing");
  });

  it.each([
    new TelegramApiError("Forbidden: missing topic permission", 403),
    new TelegramApiError("Bad Request: CHAT_ID_INVALID", 400),
    new Error("Telegram request timed out (reopenForumTopic)"),
    new TelegramApiError("Bad Request: TOPIC_NOT_MODIFIED", 400),
  ])("preserves the binding for other responses: %s", async error => {
    reopenError = error;
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    expect(f.runtime.getBindingState()).toBe("bound");
    expect(f.runtime.getCurrentThreadId()).toBe(108);
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
    expect(f.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("next prompt in Pi"), "warning");
  });

  it("reports a failed reset write and retries it before forgetting the original binding", async () => {
    f.pi.appendEntry.mockImplementationOnce(() => { throw new Error("Write failed"); });
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    expect(f.runtime.getBindingState()).toBe("bound");
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("saving the binding reset failed"), "error");
    await f.runtime.handleTgConnect(f.ctx);
    expect(f.runtime.getBindingState()).toBe("topic-missing");
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(0);
  });

  it("does not request a replacement if recording the attempt fails", async () => {
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    f.pi.appendEntry.mockImplementationOnce(() => { throw new Error("Write failed"); });
    await f.runtime.onBeforeAgentStart({ prompt: "replace" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "replace" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.outbox.error?.message).toContain("no new topic was requested");
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(0);
  });

  it.each(["request fails", "binding write fails"])("does not automatically repeat an uncertain replacement after restart when %s", async failure => {
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    if (failure === "request fails") createError = new Error("Request timed out");
    else {
      const append = f.pi.appendEntry.getMockImplementation()!;
      f.pi.appendEntry.mockImplementation((customType, data) => {
        if (data.threadId === 208) throw new Error("Write failed");
        return append(customType, data);
      });
    }
    await f.runtime.onBeforeAgentStart({ prompt: "replace" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "replace" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.outbox.error).not.toBeNull();
    expect(resolveBindingState(f.entries, "restored", testConfig.chatId)).toEqual({ state: "create-unknown", threadId: null, lastValidThreadId: null });
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    f = { ...f, runtime: new MuxRuntime(f.pi as any, dir) };
    fixtures.push(f);
    await f.runtime.onSessionStart({ reason: "resume" }, f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "do not duplicate" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "do not duplicate" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.getBindingState()).toBe("create-unknown");
    expect(requests.filter(r => r.method === "createForumTopic")).toHaveLength(1);
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import { LeaderCoordinator } from "../src/coordinator.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
const cases = ["leader", "follower"].flatMap(role =>
  ["cooldown", "inflight", "complete"].flatMap(phase =>
    ["self", "peer"].flatMap(origin =>
      ["fast", "held"].flatMap(drain =>
        ["same", "token", "chat"].map(change => ({ role, phase, origin, drain, change }))))));

describe("reopen ownership across configuration interleavings", () => {
  let dir: string;
  let now: number;
  const fixtures: Fixture[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-reopen-matrix-"));
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await saveConfig(dir, { ...testConfig, autoCloseTopics: true });
  });
  afterEach(async () => {
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fixture(id: string, threadId: number, reason?: "resume") {
    const f = await runtimeFixture(dir, id, threadId, reason);
    fixtures.push(f);
    return f;
  }

  function expire(coordinator: LeaderCoordinator) {
    now = Math.max(now, ...fixtures.map(f => (f.runtime as any).rateLimitUntil), now + coordinator.getTelegramClient().getRemainingPauseMs()) + 1;
    for (const f of fixtures) f.runtime.updateStatusBar(f.ctx);
  }

  async function settle() {
    for (let round = 0; round < 3; round++) {
      for (const f of fixtures) {
        if (!f.runtime.hasActiveTransport() && !(f.runtime as any).configuring) {
          await f.runtime.setupTransport(f.ctx).catch(error => (f.runtime as any).connectionFailed(error, f.ctx));
        }
        f.runtime.updateStatusBar(f.ctx);
      }
      await new Promise(resolve => setImmediate(resolve));
      await Promise.all(fixtures.map(f => (f.runtime as any).rateLimitReopenTask));
    }
  }

  it.each(cases)("$role / $phase / $origin / $drain / $change", async ({ role, phase, origin, drain, change }) => {
    const fetch = globalThis.fetch;
    let attempts = 0;
    let started!: () => void;
    const retryStarted = new Promise<void>(resolve => { started = resolve; });
    const requests: { url: string; chatId: number }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1);
      const params = init?.body ? JSON.parse(init.body as string) : {};
      if (method === "getChat") return new Response(JSON.stringify({ ok: true, result: { id: params.chat_id, type: "supergroup", is_forum: true } }));
      if (method === "getChatMember") return new Response(JSON.stringify({ ok: true, result: { status: params.user_id === 1 ? "administrator" : "member", can_manage_topics: true } }));
      if (method !== "reopenForumTopic" || params.message_thread_id !== 50) return fetch(input, init);
      requests.push({ url: String(input), chatId: params.chat_id });
      if (++attempts === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 60 } }), { status: 429 });
      if (phase === "inflight" && attempts === 2) return new Promise<Response>((_resolve, reject) => {
        started();
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
      return new Response(JSON.stringify({ ok: true, result: true }));
    });
    const host = role === "follower" ? await fixture("host", 10) : null;
    const target = await fixture("target", 50, "resume");
    const coordinator = ((host ?? target).runtime as any).coordinator as LeaderCoordinator;
    const actor = origin === "peer" ? await fixture("peer", 51) : target;
    if (phase !== "cooldown") {
      expire(coordinator);
      if (phase === "inflight") await retryStarted;
      else await settle();
    }
    const pending = (target.runtime as any).rateLimitReopenTask;
    let entered!: () => void;
    let release!: () => void;
    const draining = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (drain === "held") {
      // Polling may still be processing an input while reload cancels HTTP work.
      (coordinator as any).pollingTask = (coordinator as any).pollingTask.then(async () => { entered(); await gate; });
    }
    if (change === "same") actor.ui.select.mockResolvedValueOnce("Auto-close Topics: On").mockResolvedValueOnce("Off - Keep topics open (faster exit)");
    else {
      actor.ui.select.mockResolvedValueOnce("Connection Settings");
      actor.ui.input.mockResolvedValueOnce(change === "token" ? "replacement-token" : testConfig.botToken)
        .mockResolvedValueOnce(String(change === "chat" ? -100999 : testConfig.chatId)).mockResolvedValueOnce(String(testConfig.allowedUserId));
    }
    const boundary = requests.length;
    const setup = actor.runtime.handleTgSetup(actor.ctx);
    try {
      if (drain === "held") {
        await draining;
        await pending;
        if (phase === "cooldown") expire(coordinator);
        if (phase !== "complete" && change === "same") expect((target.runtime as any).rateLimitReopenTarget).not.toBeNull();
        release();
      }
      await setup;
      expire(coordinator);
      await settle();
      expect((target.runtime as any).config).toMatchObject({
        botToken: change === "token" ? "replacement-token" : testConfig.botToken,
        chatId: change === "chat" ? -100999 : testConfig.chatId,
      });
      expect((target.runtime as any).rateLimitReopenTarget).toBeNull();
      if (change === "same") {
        expect((target.runtime as any).topicNeedsReopen).toBe(false);
        expect(target.runtime.getIsReconnecting()).toBe(false);
        expect(target.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: connected (target)");
        if (phase === "complete") expect(requests).toHaveLength(boundary);
      } else {
        expect(requests.slice(boundary).filter(request => change === "token" ? request.url.includes(testConfig.botToken) : request.chatId === testConfig.chatId)).toEqual([]);
      }
    } finally { release(); await setup; }
  });
});

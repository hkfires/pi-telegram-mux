import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeFixture, testConfig, telegramUpdate } from "./helpers.js";
import { TelegramClient } from "../src/telegram.js";
import { encodeFrame } from "../src/ipc.js";
import type { TelegramMessageEntity } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("review regressions: origin, nonblocking FIFO and terminal messages", () => {
  let dir: string;
  const fixtures: Awaited<ReturnType<typeof runtimeFixture>>[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-review-runtime-")); });
  afterEach(async () => {
    for (const fixture of fixtures.reverse()) await fixture.runtime.onSessionShutdown(fixture.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function fixture(thread: number | null = 50) {
    const result = await runtimeFixture(dir, "review", thread);
    fixtures.push(result);
    return result;
  }
  function setupValidation() {
    vi.spyOn(TelegramClient.prototype, "getChat").mockImplementation(async id => ({ id, type: "supergroup", is_forum: true }));
    vi.spyOn(TelegramClient.prototype, "getChatMember").mockResolvedValue({ status: "administrator", can_manage_topics: true });
  }

  describe.each(["leader", "follower"])("%s formatted delivery", role => {
    const code = "if value:\n    print(value)\n".repeat(200).trimEnd();
    it.each([
      { name: "plain reply", markdown: "已完成修复。", text: "已完成修复。" },
      { name: "formatted reply", markdown: "**完成**：修改了 `src/render.ts`，参考 [使用指南](https://example.com/docs)。", text: "完成：修改了 src/render.ts，参考 使用指南。", entity: "text_link" },
      { name: "long code", markdown: "```python\n" + code + "\n```", text: code, entity: "pre" },
      { name: "entity rejection", markdown: "[docs](https://example.com/docs)", text: "docs", entity: "text_link", description: "Bad Request: can't parse entities" },
      { name: "topic rejection", markdown: "[docs](https://example.com/docs)", text: "docs", entity: "text_link", description: "Bad Request: TOPIC_CLOSED" },
    ])("delivers $name with the correct target and failure status", async ({ markdown, text, entity, description }) => {
      const requests: Record<string, unknown>[] = [];
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).endsWith("/sendMessage")) return fetch(input, init);
        requests.push(JSON.parse(init!.body as string));
        if (description) {
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } })));
      });
      const leader = await fixture();
      const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
      if (f !== leader) fixtures.push(f);
      await f.runtime.onBeforeAgentStart(f.ctx);
      f.runtime.onMessageEnd({ role: "assistant", content: markdown, stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await f.runtime.outbox.whenIdle();

      expect(requests.map(request => request.text).join("")).toBe(text);
      expect(requests.length > 1).toBe(text.length > 4096);
      for (const request of requests) {
        expect(request).toMatchObject({ chat_id: testConfig.chatId, message_thread_id: f.runtime.getCurrentThreadId() });
        expect((request.text as string).length).toBeLessThanOrEqual(4096);
        const entities = (request.entities ?? []) as TelegramMessageEntity[];
        if (entity) expect(entities.some(item => item.type === entity)).toBe(true);
        else expect(entities).toEqual([]);
        if (entity === "text_link") expect(entities.some(item => item.url === "https://example.com/docs")).toBe(true);
      }
      if (description) {
        expect(requests).toHaveLength(1);
        expect(f.runtime.outbox.error?.message).toBe(description);
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
        expect(f.ui.notify).toHaveBeenCalledWith("Telegram sync paused: " + description, "error");
      } else {
        expect(f.runtime.outbox.error).toBeNull();
      }
    });
  });

  describe.each(["leader", "follower"])("paused %s input protection", role => {
    it.each(["delivery", "overflow"])("rejects input after %s failure and accepts fresh work after recovery", async cause => {
      const leader = await fixture();
      const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
      if (f !== leader) fixtures.push(f);
      const coordinator = (leader.runtime as any).coordinator;
      const feedback = vi.spyOn(coordinator.getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
      if (cause === "overflow") f.runtime.outbox.enqueue(async () => {}, 256 * 1024 + 1);
      else f.runtime.outbox.enqueue(async () => { throw new Error("Simulated delivery failure"); });
      await f.runtime.outbox.whenIdle();
      await coordinator.processUpdate(telegramUpdate(f.runtime.getCurrentThreadId()!, "must not execute"));
      await coordinator.feedback.whenIdle();
      expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
      expect(feedback).toHaveBeenCalledWith(testConfig.chatId, expect.stringContaining("sync is paused"), { message_thread_id: f.runtime.getCurrentThreadId() }, expect.any(AbortSignal));
      const send = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
      await f.runtime.handleTgConnect(f.ctx);
      let processing!: Promise<void>;
      f.pi.sendUserMessage.mockImplementation((text: string) => {
        processing = (async () => {
          await f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx);
          f.runtime.onMessageStart({ role: "user", content: text }, f.ctx);
          f.runtime.onMessageEnd({ role: "assistant", content: "fresh answer", stopReason: "stop" });
          await f.runtime.onAgentSettled(f.ctx);
        })();
      });
      expect(await f.runtime.handleInboundText("fresh task", f.ctx)).toEqual({ accepted: true, busy: false });
      await processing;
      await f.runtime.outbox.whenIdle();
      expect(send.mock.calls.map(([, params]) => params.text)).toEqual(["fresh answer"]);
    });
  });

  describe.each(["leader", "follower"])("%s payload boundaries", role => {
    const prefix = "🧑‍💻 [Prompt]\n";
    let f: Awaited<ReturnType<typeof runtimeFixture>>;
    let sent: string[];
    beforeEach(async () => {
      sent = [];
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/sendMessage")) {
          sent.push(JSON.parse(init!.body as string).text);
          return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })));
        }
        return fetch(input, init);
      });
      // Retain Coordinator validation and real Follower IPC before the HTTP boundary.
      const leader = await fixture();
      f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
      if (f !== leader) fixtures.push(f);
    });

    it.each([
      { name: "leading code block", prompt: "first prompt", answer: "```text\n" + " ".repeat(4096) + "  indented answer\n\n```", expected: [prefix + "first prompt", "  indented answer\n"] },
      { name: "middle code block", prompt: "first prompt", answer: "```text\n" + "x".repeat(4096) + "\n".repeat(4096) + "  tail\n\n```", expected: [prefix + "first prompt", "x".repeat(4096), "  tail\n"] },
      { name: "trailing code block", prompt: "first prompt", answer: "```text\n" + "x".repeat(4096) + "\n\n```", expected: [prefix + "first prompt", "x".repeat(4096)] },
      { name: "trailing prompt block", prompt: "x".repeat(4096 - prefix.length) + "\n", answer: "first answer", expected: [prefix + "x".repeat(4096 - prefix.length), "first answer"] },
    ])("skips a blank $name and keeps subsequent messages flowing", async ({ prompt, answer, expected }) => {
      for (const [text, reply] of [[prompt, answer], ["next prompt", "next answer"]]) {
        await f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx);
        f.runtime.onMessageStart({ role: "user", content: text }, f.ctx);
        f.runtime.onMessageEnd({ role: "assistant", content: reply, stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
        await f.runtime.outbox.whenIdle();
        expect(f.runtime.outbox.error).toBeNull();
      }
      expect(sent).toEqual([...expected, prefix + "next prompt", "next answer"]);
    });

    it.each([
      { name: "ASCII prompt at the limit", prompt: "x".repeat(65_536), oversized: false },
      { name: "ASCII prompt above the limit", prompt: "x".repeat(65_537), oversized: true },
      { name: "prompt larger than the entire outbox", prompt: "x".repeat(256 * 1024 + 1), oversized: true },
      { name: "multibyte prompt at the limit", prompt: "€".repeat(65_536), oversized: false },
      { name: "multibyte prompt above the limit", prompt: "€".repeat(65_537), oversized: true },
    ])("bounds $name while preserving answers and later runs", async ({ prompt, oversized }) => {
      for (const [text, reply] of [[prompt, "first answer"], ["next prompt", "next answer"]]) {
        await f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx);
        f.runtime.onMessageStart({ role: "user", content: text }, f.ctx);
        f.runtime.onMessageEnd({ role: "assistant", content: reply, stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
        await f.runtime.outbox.whenIdle();
        expect(f.runtime.outbox.error).toBeNull();
      }
      const mirroredPrompt = sent.slice(0, -3).join("");
      const expectedPrompt = prefix + (oversized ? "Prompt is too long. Please view it locally in Pi; task results will still be synced." : prompt);
      expect(mirroredPrompt.length).toBe(expectedPrompt.length);
      expect(mirroredPrompt).toBe(expectedPrompt);
      expect(sent.slice(-3)).toEqual(["first answer", prefix + "next prompt", "next answer"]);
    });
  });

  it.each(["automatic", "manual"])("rejects input coalesced with the %s recovery registration ACK", async recovery => {
    const leader = await fixture();
    const f = await runtimeFixture(dir, "follower", 51);
    fixtures.push(f);
    const coordinator = (leader.runtime as any).coordinator;
    const feedback = vi.spyOn(coordinator.getTelegramClient(), "sendMessage").mockResolvedValue({} as any);
    const handle = coordinator.handleFrame.bind(coordinator);
    let processing: Promise<void> | undefined;
    vi.spyOn(coordinator, "handleFrame").mockImplementation(async (socket: any, state: any, msg: any) => {
      if (msg.type !== "register" || processing) return handle(socket, state, msg);
      socket.cork();
      await handle(socket, state, msg);
      // A poll update can be dispatched immediately after the route is claimed,
      // before the Follower resumes its registration promise continuation.
      processing = coordinator.processUpdate(telegramUpdate(51, "premature task"));
      socket.uncork();
    });
    if (recovery === "automatic") {
      [...coordinator.connections.entries()].find(([, state]: any) => state.runtimeId === f.runtime.runtimeId)![0].destroy();
    } else {
      f.runtime.outbox.enqueue(async () => { throw new Error("Simulated delivery failure"); });
      await f.runtime.outbox.whenIdle();
      await f.runtime.handleTgConnect(f.ctx);
    }
    await vi.waitFor(() => expect(processing).toBeDefined(), { timeout: 2500 });
    await processing;
    await coordinator.feedback.whenIdle();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(testConfig.chatId, expect.stringContaining("busy"), { message_thread_id: 51 }, expect.any(AbortSignal));
    await vi.waitFor(() => expect(f.runtime.getIsReconnecting()).toBe(false));
    const admission = f.runtime.handleInboundText("ready task", f.ctx);
    await f.inInput(() => f.runtime.onBeforeAgentStart({ prompt: "ready task" }, f.ctx));
    f.runtime.onMessageStart({ role: "user", content: "ready task" }, f.ctx);
    expect(await admission).toEqual({ accepted: true, busy: false });
    await f.runtime.onAgentSettled(f.ctx);
  });

  it.each([false, true])("tracks transformed Telegram input independently of text (config changes: %s)", async changed => {
    const f = await fixture();
    const gate = deferred();
    let processing!: Promise<void>;
    const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
    f.pi.sendUserMessage.mockImplementation(() => {
      // Pi's public void API starts an asynchronous prompt path. Input transforms
      // can occur before or after this extension and can change all of the text.
      processing = (async () => {
        await gate.promise;
        await f.runtime.onBeforeAgentStart({ prompt: "completely transformed" }, f.ctx);
        f.runtime.onMessageStart({ role: "user", content: "completely transformed" }, f.ctx);
        f.runtime.onMessageEnd({ role: "assistant", content: "confidential answer", stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
      })();
    });
    const admission = f.runtime.handleInboundText("original", f.ctx);
    if (changed) {
      setupValidation();
      f.ui.select.mockResolvedValueOnce("Connection settings");
      f.ui.input.mockResolvedValueOnce(testConfig.botToken).mockResolvedValueOnce("-100999").mockResolvedValueOnce("999");
      await f.runtime.handleTgSetup(f.ctx);
    }
    gate.resolve();
    await processing;
    expect((await admission).accepted).toBe(!changed);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.getIsIdle()).toBe(true);
    expect(call.mock.calls.filter(args => args[0] === "sendMessage").map(args => args[1].text)).toEqual(changed ? [] : ["confidential answer"]);
    if (changed) expect(call).not.toHaveBeenCalled();
  });

  it("does not assign a concurrent local prompt to an unresolved Telegram submission", async () => {
    const f = await fixture();
    const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
    const admission = f.runtime.handleInboundText("remote", f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "local" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local" }, f.ctx);
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(call.mock.calls.map(args => args[1].text)).toEqual(["🧑‍💻 [Prompt]\nlocal"]);
    expect(f.runtime.getIsIdle()).toBe(false);
    await f.inInput(async () => {
      await f.runtime.onBeforeAgentStart({ prompt: "transformed remote" }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "transformed remote" }, f.ctx);
      await f.runtime.onAgentSettled(f.ctx);
    });
    expect((await admission).accepted).toBe(true);
  });

  it("does not delay Pi on slow topic creation and preserves create/prompt/answer order", async () => {
    const f = await fixture(null);
    const gate = deferred();
    const calls: string[] = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (method, params) => {
      calls.push(method === "createForumTopic" ? "create" : String(params.text));
      if (method === "createForumTopic") { await gate.promise; return { message_thread_id: 77 } as any; }
      return {} as any;
    });
    await f.runtime.onBeforeAgentStart({ prompt: "local" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "local" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    expect(f.runtime.getIsIdle()).toBe(true);
    expect(calls).toEqual(["create"]);
    gate.resolve();
    await f.runtime.outbox.whenIdle();
    expect(calls).toEqual(["create", "🧑‍💻 [Prompt]\nlocal", "answer"]);
  });

  it("preserves FIFO across consecutive runs and actual local steering/follow-up messages", async () => {
    const f = await fixture();
    const gate = deferred();
    const texts: unknown[] = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (_method, params) => { texts.push(params.text); await gate.promise; return {} as any; });
    await f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "steering" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "follow-up" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "first answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "second" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "second" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "second answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    gate.resolve();
    await f.runtime.outbox.whenIdle();
    expect(texts).toEqual(["🧑‍💻 [Prompt]\nfirst", "🧑‍💻 [Prompt]\nsteering", "🧑‍💻 [Prompt]\nfollow-up", "first answer", "🧑‍💻 [Prompt]\nsecond", "second answer"]);
  });

  it("retains prompts until first-turn session persistence becomes available", async () => {
    const f = await fixture(null);
    let file: string | undefined;
    vi.spyOn(f.ctx.sessionManager, "getSessionFile").mockImplementation(() => file);
    const calls: string[] = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (method, params) => {
      calls.push(method === "createForumTopic" ? "create" : String(params.text));
      return { message_thread_id: 77 } as any;
    });
    await f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    expect(calls).toEqual([]);
    file = path.join(dir, "session.jsonl");
    f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(calls).toEqual(["create", "🧑‍💻 [Prompt]\nfirst", "answer"]);
  });

  it.each(["error", "aborted"])("never publishes old tool commentary after an empty %s message", async stopReason => {
    const f = await fixture();
    const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "I will run the tests now.", stopReason: "toolUse" });
    f.runtime.onMessageStart({ role: "assistant", content: [] }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: [], stopReason });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(call.mock.calls.map(args => args[1].text)).toEqual([stopReason === "error" ? "⚠️ Task failed. Please check local Pi errors." : "⏹ Task aborted."]);
  });

  it("halts dependent delivery and exposes background errors instead of sending an answer after a failed prompt", async () => {
    const f = await fixture();
    const call = vi.spyOn(f.runtime, "callTelegram").mockRejectedValue(new Error("Simulated delivery failure"));
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "answer" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.runtime.outbox.error?.message).toContain("Simulated");
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("paused"), "error");
  });

  it("preserves a healthy pending FIFO when /tg-connect is repeated", async () => {
    const f = await fixture();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const texts: unknown[] = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (_method, params, _target, current) => {
      signal = current;
      texts.push(params.text);
      await gate.promise;
      return {} as any;
    });
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    const queued = f.runtime.outbox.size;
    await f.runtime.handleTgConnect(f.ctx);
    expect(signal?.aborted).toBe(false);
    expect(f.runtime.outbox.size).toBe(queued);
    gate.resolve();
    await f.runtime.outbox.whenIdle();
    expect(texts).toEqual(["🧑‍💻 [Prompt]\nprompt", "answer"]);
  });

  describe.each(["cancel", "validation failure"])("setup %s preserves an existing run", outcome => {
    it.each(["during setup", "after setup"])("sends the prompt before an answer completed %s", async timing => {
      const f = await fixture();
      const registration = deferred();
      const registered = deferred();
      const register = f.runtime.registerRoute.bind(f.runtime);
      vi.spyOn(f.runtime, "registerRoute").mockImplementationOnce(async (...args) => {
        await registration.promise;
        const ok = await register(...args);
        registered.resolve();
        return ok;
      });
      const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
      let answerDialog!: (value: string | undefined) => void;
      f.ui.input.mockReturnValueOnce(new Promise(resolve => { answerDialog = resolve; }))
        .mockResolvedValueOnce(String(testConfig.chatId)).mockResolvedValueOnce(String(testConfig.allowedUserId));
      f.ui.select.mockResolvedValueOnce("Connection settings");
      if (outcome === "validation failure") vi.spyOn(TelegramClient.prototype, "getMe").mockRejectedValueOnce(new Error("Simulated validation failure"));
      await f.runtime.onBeforeAgentStart({ prompt: "prompt" }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "prompt" }, f.ctx);
      const setup = f.runtime.handleTgSetup(f.ctx);
      try {
        registration.resolve();
        await registered.promise;
        if (timing === "during setup") {
          f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
          await f.runtime.onAgentSettled(f.ctx);
          expect(f.runtime.getIsIdle()).toBe(true);
        }
        // Let the FIFO reach delivery while the configuration dialog stays open.
        await new Promise(resolve => setImmediate(resolve));
        expect(call).not.toHaveBeenCalled();
        answerDialog(outcome === "cancel" ? undefined : testConfig.botToken);
        await setup;
        if (timing === "after setup") {
          f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
          await f.runtime.onAgentSettled(f.ctx);
        }
        await f.runtime.outbox.whenIdle();
        expect(call.mock.calls.map(([, params]) => params.text)).toEqual(["🧑‍💻 [Prompt]\nprompt", "answer"]);
        expect(f.runtime.outbox.error).toBeNull();
      } finally {
        registration.resolve();
        answerDialog(undefined);
        await setup;
      }
    });
  });

  it("resumes the remaining prompt chunks and retains steering and the answer across setup cancellation", async () => {
    const f = await fixture();
    const firstChunk = deferred();
    const call = vi.spyOn(f.runtime, "callTelegram").mockImplementationOnce(async () => {
      await firstChunk.promise;
      return {} as any;
    }).mockResolvedValue({} as any);
    const prompt = "x".repeat(5000);
    await f.runtime.onBeforeAgentStart({ prompt }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: prompt }, f.ctx);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    let cancelDialog!: () => void;
    f.ui.input.mockReturnValueOnce(new Promise(resolve => { cancelDialog = () => resolve(undefined); }));
    f.ui.select.mockResolvedValueOnce("Connection settings");
    const setup = f.runtime.handleTgSetup(f.ctx);
    try {
      firstChunk.resolve();
      f.runtime.onMessageStart({ role: "user", content: "steering" }, f.ctx);
      f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await new Promise(resolve => setImmediate(resolve));
      expect(call).toHaveBeenCalledTimes(1);
      cancelDialog();
      await setup;
      await f.runtime.outbox.whenIdle();
      const texts = call.mock.calls.map(([, params]) => params.text);
      expect(texts.slice(0, -2).join("")).toBe(`🧑‍💻 [Prompt]\n${prompt}`);
      expect(texts.slice(-2)).toEqual(["🧑‍💻 [Prompt]\nsteering", "answer"]);
      expect(f.runtime.outbox.error).toBeNull();
    } finally {
      firstChunk.resolve();
      cancelDialog();
      await setup;
    }
  });

  it("retains first-turn topic creation and output until setup is cancelled", async () => {
    const f = await fixture(null);
    let sessionFile: string | undefined;
    vi.spyOn(f.ctx.sessionManager, "getSessionFile").mockImplementation(() => sessionFile);
    const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_thread_id: 77 } as any);
    await f.runtime.onBeforeAgentStart({ prompt: "first" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "first" }, f.ctx);
    let cancelDialog!: () => void;
    f.ui.input.mockReturnValueOnce(new Promise(resolve => { cancelDialog = () => resolve(undefined); }));
    f.ui.select.mockResolvedValueOnce("Connection settings");
    const setup = f.runtime.handleTgSetup(f.ctx);
    try {
      sessionFile = path.join(dir, "review.jsonl");
      f.runtime.onMessageEnd({ role: "assistant", content: "answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await new Promise(resolve => setImmediate(resolve));
      expect(call).not.toHaveBeenCalled();
      cancelDialog();
      await setup;
      await f.runtime.outbox.whenIdle();
      expect(call.mock.calls.map(([method, params]) => method === "createForumTopic" ? "create" : params.text))
        .toEqual(["create", "🧑‍💻 [Prompt]\nfirst", "answer"]);
      expect(f.runtime.getCurrentThreadId()).toBe(77);
      expect(f.runtime.outbox.error).toBeNull();
    } finally {
      cancelDialog();
      await setup;
    }
  });

  it.each(["save", "tree", "shutdown"])("discards setup-paused output on %s without waiting for the dialog", async action => {
    const f = await fixture();
    const registration = deferred();
    const registered = deferred();
    const register = f.runtime.registerRoute.bind(f.runtime);
    vi.spyOn(f.runtime, "registerRoute").mockImplementationOnce(async (...args) => {
      await registration.promise;
      const ok = await register(...args);
      registered.resolve();
      return ok;
    });
    const call = vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({} as any);
    let answerDialog!: (value: string | undefined) => void;
    f.ui.input.mockReturnValueOnce(new Promise(resolve => { answerDialog = resolve; }))
      .mockResolvedValueOnce(String(testConfig.chatId)).mockResolvedValueOnce("999");
    f.ui.select.mockResolvedValueOnce("Connection settings");
    setupValidation();
    await f.runtime.onBeforeAgentStart({ prompt: "old prompt" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "old prompt" }, f.ctx);
    const setup = f.runtime.handleTgSetup(f.ctx);
    try {
      registration.resolve();
      await registered.promise;
      f.runtime.onMessageEnd({ role: "assistant", content: "old answer", stopReason: "stop" });
      await f.runtime.onAgentSettled(f.ctx);
      await new Promise(resolve => setImmediate(resolve));
      if (action === "save") {
        answerDialog(testConfig.botToken);
        await setup;
      } else if (action === "tree") f.runtime.onSessionBeforeTree();
      else await f.runtime.onSessionShutdown(f.ctx);
      // Navigation/shutdown must cancel the queue's wait, even with the UI still open.
      await f.runtime.outbox.whenIdle();
      expect(call).not.toHaveBeenCalled();
      expect(f.runtime.outbox.error).toBeNull();
      answerDialog(undefined);
      await setup;
      await f.runtime.outbox.whenIdle();
      expect(call).not.toHaveBeenCalled();
    } finally {
      registration.resolve();
      answerDialog(undefined);
      await setup;
    }
  });

  it.each(["leader", "follower"])("cancels active %s HTTP/IPC delivery so a reconnected FIFO progresses without releasing the old request", async role => {
    const leader = await fixture();
    const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
    if (f !== leader) fixtures.push(f);
    const client = (leader.runtime as any).coordinator.getTelegramClient() as TelegramClient;
    const original = client.callApi.bind(client);
    const texts: unknown[] = [];
    let cancelled = 0;
    vi.spyOn(client, "callApi").mockImplementation(async (method, params, timeout, signal) => {
      if (method !== "sendMessage") return original(method, params, timeout, signal);
      texts.push(params!.text);
      if (String(params!.text).includes("old")) {
        signal!.throwIfAborted();
        await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => { cancelled++; reject(signal!.reason); }, { once: true }));
      }
      return {} as any;
    });
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "old prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "old answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    f.runtime.handleTgDisconnect(f.ctx);
    await f.runtime.handleTgConnect(f.ctx);
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "new prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await vi.waitFor(() => expect(texts).toEqual(["🧑‍💻 [Prompt]\nold prompt", "🧑‍💻 [Prompt]\nnew prompt", "new answer"]));
    expect(cancelled).toBe(1);
    await f.runtime.outbox.whenIdle();
    expect(f.runtime.outbox.error).toBeNull();
  });

  it("treats post-authentication malformed IPC as fatal until an explicit reconnect", async () => {
    const leader = await fixture();
    const follower = await runtimeFixture(dir, "follower", 51);
    fixtures.push(follower);
    const c = (leader.runtime as any).coordinator;
    const setup = vi.spyOn(follower.runtime, "setupTransport");
    const socket = [...c.connections.entries()].find(([, state]: any) => state.runtimeId === follower.runtime.runtimeId)![0] as any;
    const malformed = encodeFrame({ type: "ping" });
    malformed.fill(0x7b, 4);
    socket.write(malformed);
    await vi.waitFor(() => expect(follower.runtime.hasActiveTransport()).toBe(false));
    expect(follower.runtime.getIsReconnecting()).toBe(false);
    expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(follower.ui.notify).toHaveBeenCalledWith(expect.stringContaining("IPC_PROTOCOL_ERROR"), "error");
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(setup).not.toHaveBeenCalled();
    await follower.runtime.handleTgConnect(follower.ctx);
    expect(follower.runtime.hasActiveTransport()).toBe(true);
  });

  it("handles only identified intentional IPC-close cancellation while shutting down an unfinished handshake", async () => {
    const leader = await fixture();
    const follower = await runtimeFixture(dir, "follower", 51);
    fixtures.push(follower);
    await (follower.runtime as any).stopTransport();
    const c = (leader.runtime as any).coordinator;
    const original = c.handleFrame.bind(c);
    const gate = deferred();
    const frames = vi.spyOn(c, "handleFrame").mockImplementation(async (...args: any[]) => {
      if (args[2].type === "auth") await gate.promise;
      return original(...args);
    });
    try {
      const setup = follower.runtime.setupTransport(follower.ctx).then(() => undefined, error => error);
      await vi.waitFor(() => expect(frames).toHaveBeenCalled());
      await follower.runtime.onSessionShutdown(follower.ctx);
      expect(await setup).toMatchObject({ code: "IPC_CLOSED" });
      expect(follower.runtime.hasActiveTransport()).toBe(false);
      expect(follower.ui.setStatus).toHaveBeenLastCalledWith("tg", undefined);
    } finally { gate.resolve(); }
  });

  it("stops reconnecting and exposes malformed configuration JSON", async () => {
    const f = await fixture();
    await (f.runtime as any).stopTransport();
    await fs.writeFile(path.join(dir, "pi-telegram-mux", "config.json"), "not JSON");
    const setup = vi.spyOn(f.runtime, "setupTransport");
    (f.runtime as any).scheduleReconnect(f.ctx);
    await vi.waitFor(() => expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("connection failed"), "error"), { timeout: 1200 });
    expect(f.runtime.getIsReconnecting()).toBe(false);
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("bounds pending work and discards overflow visibly", async () => {
    const f = await fixture();
    const gate = deferred();
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async () => { await gate.promise; return {} as any; });
    await f.runtime.onBeforeAgentStart(f.ctx);
    for (let i = 0; i < 100; i++) f.runtime.onMessageStart({ role: "user", content: `message ${i}` }, f.ctx);
    expect(f.runtime.outbox.size).toBeLessThanOrEqual(32);
    expect(f.runtime.outbox.error).toMatchObject({ code: "OUTBOX_FULL" });
    gate.resolve();
    await f.runtime.outbox.whenIdle();
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBindingState } from "../../src/binding.js";
import { saveConfig } from "../../src/config.js";
import { MuxRuntime } from "../../src/runtime.js";
import type { MuxConfig, TelegramForumTopic, TelegramMessage } from "../../src/types.js";

describe("Single Process Integration", () => {
  let tempDir: string;
  const mockConfig: MuxConfig = {
    version: 1,
    botToken: "token-single-process-test",
    chatId: -100777888,
    allowedUserId: 999111,
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-single-"));
    await saveConfig(tempDir, mockConfig);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("completes full first-turn auto-binding flow", async () => {
    const sessionEntries: any[] = [];
    const mockPi = {
      appendEntry: vi.fn((customType: string, data: any) => {
        sessionEntries.push({ type: "custom", customType, data });
      }),
      sendUserMessage: vi.fn(),
    } as any;

    const mockCtx = {
      mode: "tui",
      cwd: "/workspace/my-project",
      sessionManager: {
        getSessionId: () => "sess-blank-123456",
        getSessionFile: () => "/tmp/sess-blank.jsonl",
        getSessionName: () => "My Session",
        getEntries: () => sessionEntries,
      },
      ui: {
        notify: vi.fn(),
      },
    } as any;

    const runtime = new MuxRuntime(mockPi, tempDir);

    // 1. session_start on blank session
    await runtime.onSessionStart(mockCtx);
    expect(runtime.getBindingState()).toBe("unbound");
    expect(runtime.getCurrentThreadId()).toBeNull();

    // 2. First turn starts
    runtime.onBeforeAgentStart(mockCtx);
    expect(runtime.getIsIdle()).toBe(false);

    // Assistant message stream
    runtime.onMessageEnd({
      role: "assistant",
      content: "Hello from Pi! This is the first assistant output.",
    });

    // Mock Telegram call
    const telegramCalls: { method: string; params: any }[] = [];
    vi.spyOn(runtime, "callTelegram").mockImplementation(async (method, params) => {
      telegramCalls.push({ method, params });
      if (method === "createForumTopic") {
        return {
          message_thread_id: 301,
          name: params.name,
        } as TelegramForumTopic;
      }
      if (method === "sendMessage") {
        return {
          message_id: 1001,
          chat: { id: params.chat_id, type: "supergroup" },
          date: Date.now(),
          text: params.text,
        } as TelegramMessage;
      }
      throw new Error(`Unhandled method: ${method}`);
    });

    // 3. agent_settled triggers first-turn auto bind
    await runtime.onAgentSettled(mockCtx);
    await runtime.outbox.whenIdle();

    // Verify topic was created
    const createCall = telegramCalls.find((c) => c.method === "createForumTopic");
    expect(createCall).toBeDefined();
    expect(createCall?.params.chat_id).toBe(mockConfig.chatId);
    expect(createCall?.params.name).toContain("My Session");

    // Verify binding entry was appended to session
    expect(mockPi.appendEntry).toHaveBeenCalled();
    const binding = resolveBindingState(sessionEntries, "sess-blank-123456", mockConfig.chatId);
    expect(binding.state).toBe("bound");
    expect(binding.threadId).toBe(301);

    // Verify runtime state updated
    expect(runtime.getBindingState()).toBe("bound");
    expect(runtime.getCurrentThreadId()).toBe(301);

    // Verify captured assistant text was sent to new topic
    const sendCall = telegramCalls.find((c) => c.method === "sendMessage");
    expect(sendCall).toBeDefined();
    expect(sendCall?.params.message_thread_id).toBe(301);
    expect(sendCall?.params.text).toBe("Hello from Pi! This is the first assistant output.");

    // Clean up
    await runtime.onSessionShutdown(mockCtx);
  });

  it("handles disconnect and reconnect", async () => {
    const sessionEntries: any[] = [];
    const mockPi = {
      appendEntry: vi.fn((customType: string, data: any) => {
        sessionEntries.push({ type: "custom", customType, data });
      }),
      sendUserMessage: vi.fn(),
    } as any;

    const mockCtx = {
      mode: "tui",
      cwd: "/workspace/proj",
      sessionManager: {
        getSessionId: () => "sess-conn-test",
        getSessionFile: () => "/tmp/sess.jsonl",
        getEntries: () => sessionEntries,
      },
      ui: {
        notify: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
      },
    } as any;

    const runtime = new MuxRuntime(mockPi, tempDir);

    // Pre-bind session to thread 77
    sessionEntries.push({
      type: "custom",
      customType: "pi-telegram-mux.binding",
      data: {
        version: 1,
        sessionId: "sess-conn-test",
        chatId: mockConfig.chatId,
        threadId: 77,
      },
    });

    await runtime.onSessionStart(mockCtx);
    expect(runtime.getBindingState()).toBe("bound");
    expect(runtime.getCurrentThreadId()).toBe(77);

    // Disconnect
    runtime.handleTgDisconnect(mockCtx);
    expect(runtime.getBindingState()).toBe("disconnected");
    expect(runtime.getCurrentThreadId()).toBeNull();

    // Reconnect
    await runtime.handleTgConnect(mockCtx);
    expect(runtime.getBindingState()).toBe("bound");
    expect(runtime.getCurrentThreadId()).toBe(77);

    await runtime.onSessionShutdown(mockCtx);
  });

  it("creates the topic and mirrors admitted prompts on the background queue for a blank session", async () => {
    const sessionEntries: any[] = [];
    const mockPi = {
      appendEntry: vi.fn((customType: string, data: any) => {
        sessionEntries.push({ type: "custom", customType, data });
      }),
      sendUserMessage: vi.fn(),
    } as any;

    const mockCtx = {
      mode: "tui",
      cwd: "/workspace/new-proj",
      sessionManager: {
        getSessionId: () => "sess-immediate-topic",
        getSessionFile: () => "/tmp/sess-immediate.jsonl",
        getSessionName: () => "Immediate Project",
        getEntries: () => sessionEntries,
      },
      ui: { notify: vi.fn() },
    } as any;

    const runtime = new MuxRuntime(mockPi, tempDir);

    const telegramCalls: { method: string; params: any }[] = [];
    vi.spyOn(runtime, "callTelegram").mockImplementation(async (method, params) => {
      telegramCalls.push({ method, params });
      if (method === "createForumTopic") {
        return { message_thread_id: 404, name: params.name } as TelegramForumTopic;
      }
      if (method === "sendMessage") {
        return { message_id: 2002, chat: { id: params.chat_id, type: "supergroup" }, date: Date.now(), text: params.text } as TelegramMessage;
      }
      throw new Error(`Unhandled method: ${method}`);
    });

    await runtime.onSessionStart(mockCtx);

    // Press Enter locally with a new prompt
    await runtime.onBeforeAgentStart({ prompt: "Hello from immediate start" }, mockCtx);
    runtime.onMessageStart({ role: "user", content: "Hello from immediate start" }, mockCtx);
    await runtime.outbox.whenIdle();

    // The background preparation must create exactly one Topic before delivery.
    const createCall = telegramCalls.find((c) => c.method === "createForumTopic");
    expect(createCall).toBeDefined();
    expect(createCall?.params.chat_id).toBe(mockConfig.chatId);
    expect(runtime.getBindingState()).toBe("bound");
    expect(runtime.getCurrentThreadId()).toBe(404);

    // The admitted prompt is delivered before the answer.
    const promptCall = telegramCalls.find((c) => c.method === "sendMessage");
    expect(promptCall).toBeDefined();
    expect(promptCall?.params.message_thread_id).toBe(404);
    expect(promptCall?.params.text).toBe("🧑‍💻 [Prompt]\nHello from immediate start");

    // Later: Assistant finishes reply
    runtime.onMessageEnd({ role: "assistant", content: "Reply to immediate start" });
    await runtime.onAgentSettled(mockCtx);
    await runtime.outbox.whenIdle();

    // Assistant reply sent to topic 404, without duplicating prompt
    const assistantCalls = telegramCalls.filter((c) => c.method === "sendMessage");
    expect(assistantCalls.length).toBe(2);
    expect(assistantCalls[1].params.text).toBe("Reply to immediate start");

    await runtime.onSessionShutdown(mockCtx);
  });
});

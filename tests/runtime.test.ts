import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import {
  extractAssistantText,
  extractUserText,
  findLastUserPrompt,
  splitTelegramMessage,
} from "../src/render.js";
import { MuxRuntime } from "../src/runtime.js";
import type { MuxConfig } from "../src/types.js";

describe("runtime module", () => {
  let tempDir: string;
  const runtimes: { runtime: MuxRuntime; ctx: any }[] = [];
  const originalStart = MuxRuntime.prototype.onSessionStart;
  const mockConfig: MuxConfig = {
    version: 1,
    botToken: "mock-token",
    chatId: -100123456,
    allowedUserId: 112233,
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-runtime-test-"));
    await saveConfig(tempDir, mockConfig);
    vi.spyOn(MuxRuntime.prototype, "onSessionStart").mockImplementation(function (eventOrCtx: any, maybeCtx?: any) {
      const ctx = maybeCtx ?? eventOrCtx;
      runtimes.push({ runtime: this, ctx });
      return (originalStart as any).call(this, eventOrCtx, maybeCtx);
    });
  });

  afterEach(async () => {
    for (const { runtime, ctx } of runtimes.splice(0)) await runtime.onSessionShutdown(ctx);
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("render helpers", () => {
    it("extracts text from assistant string content", () => {
      const msg = { role: "assistant", content: "Hello from assistant" };
      expect(extractAssistantText(msg)).toBe("Hello from assistant");
    });

    it("extracts text from assistant parts array", () => {
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "Part 1. " },
          { type: "tool_use", name: "bash" },
          { type: "text", text: "Part 2." },
        ],
      };
      expect(extractAssistantText(msg)).toBe("Part 1. Part 2.");
    });

    it("extracts text from user string content and parts", () => {
      const msg1 = { role: "user", content: "Hello from user" };
      expect(extractUserText(msg1)).toBe("Hello from user");

      const msg2 = {
        role: "user",
        content: [{ type: "text", text: "Part A. " }, { type: "text", text: "Part B." }],
      };
      expect(extractUserText(msg2)).toBe("Part A. Part B.");

      expect(extractUserText({ role: "assistant", content: "hi" })).toBe("");
    });

    it("finds last user prompt from session entries", () => {
      const entries = [
        { type: "message", message: { role: "user", content: "First prompt" } },
        { type: "message", message: { role: "assistant", content: "First answer" } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Second prompt" }] } },
      ];
      expect(findLastUserPrompt(entries)).toBe("Second prompt");
    });

    it("splits long text without exceeding maximum length", () => {
      const longText = "a".repeat(10000);
      const chunks = splitTelegramMessage(longText, 4096);
      expect(chunks.length).toBe(3);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
      expect(chunks.join("")).toBe(longText);
    });

    it("splits on newlines when possible", () => {
      const p1 = "First line.\n";
      const p2 = "Second line.\n";
      const p3 = "Third line.";
      const text = p1 + p2 + p3;
      const chunks = splitTelegramMessage(text, 20);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(text);
    });

    it("preserves emojis and surrogate pairs across chunk boundaries", () => {
      // 4095 chars + 1 emoji (2 code units)
      const prefix = "a".repeat(4095);
      const emoji = "🚀"; // \uD83D\uDE80
      const text = prefix + emoji + "suffix";
      const chunks = splitTelegramMessage(text, 4096);
      // Emoji should not be cut in half
      expect(chunks[0].length).toBeLessThanOrEqual(4096);
      expect(chunks.join("")).toBe(text);
    });
  });

  describe("MuxRuntime lifecycle and admission", () => {
    it("ignores session_start in non-TUI mode", async () => {
      const mockPi = {
        on: vi.fn(),
        registerCommand: vi.fn(),
        sendUserMessage: vi.fn(),
        appendEntry: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const mockCtx = {
        mode: "print", // non-TUI
        sessionManager: {
          getSessionId: () => "sess-1",
          getEntries: () => [],
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      expect(runtime.getBindingState()).toBe("unbound");
    });

    it("rejects inbound message when busy without queueing", async () => {
      const mockPi = {
        sendUserMessage: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const mockCtx = {
        sessionManager: {
          getSessionId: () => "sess-1",
          getEntries: () => [],
        },
      } as any;

      // Simulate run start (runtime busy)
      runtime.onBeforeAgentStart(mockCtx);
      expect(runtime.getIsIdle()).toBe(false);

      // Inbound arrives while busy
      const result = await runtime.handleInboundText("hello while busy", mockCtx);
      expect(result.busy).toBe(true);
      expect(result.accepted).toBe(false);
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("injects inbound message when idle", async () => {
      const mockPi = {
        sendUserMessage: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const mockCtx = {
        mode: "tui",
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "sess-1",
          getEntries: () => [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: "sess-1", chatId: mockConfig.chatId, threadId: 10 } }],
        },
      } as any;
      await runtime.onSessionStart(mockCtx);
      expect(runtime.getIsIdle()).toBe(true);
      mockPi.sendUserMessage.mockImplementation((text: string) => {
        void runtime.onBeforeAgentStart({ prompt: text }, mockCtx).then(() => runtime.onMessageStart({ role: "user", content: text }, mockCtx));
      });
      const admission = runtime.handleInboundText("hello while idle", mockCtx);
      const result = await admission;
      expect(result.busy).toBe(false);
      expect(result.accepted).toBe(true);
      expect(mockPi.sendUserMessage).toHaveBeenCalledWith("hello while idle", {
        expandPromptTemplates: false,
      });
    });

    it("fences output if session switched during turn", async () => {
      const mockPi = {
        appendEntry: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: unknown[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-original",
            chatId: mockConfig.chatId,
            threadId: 555,
          },
        },
      ];

      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-original",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      expect(runtime.getBindingState()).toBe("bound");
      expect(runtime.getCurrentThreadId()).toBe(555);

      // Start run
      runtime.onBeforeAgentStart(mockCtx);
      runtime.onMessageEnd({ role: "assistant", content: "Final answer" });

      // Simulate session switch before agent settled
      const switchedCtx = {
        ...mockCtx,
        sessionManager: {
          ...mockCtx.sessionManager,
          getSessionId: () => "sess-switched",
        },
      };
      runtime.onSessionBeforeSwitch(switchedCtx);

      // Agent settles after switch
      const spyCallTelegram = vi.spyOn(runtime, "callTelegram").mockResolvedValue({} as any);
      await runtime.onAgentSettled(switchedCtx);

      // Output should have been fenced/dropped, NOT sent to thread 555
      expect(spyCallTelegram).not.toHaveBeenCalled();
    });

    it("does not auto-create topic for session with historical assistant entries", async () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const entriesWithHistory = [
        {
          type: "message",
          message: { role: "user", content: "old user" },
        },
        {
          type: "message",
          message: { role: "assistant", content: "old assistant answer" },
        },
      ];

      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-historical",
          getEntries: () => entriesWithHistory,
          getSessionFile: () => "/tmp/sess.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      expect(runtime.getBindingState()).toBe("unbound");

      // Run starts
      runtime.onBeforeAgentStart(mockCtx);
      runtime.onMessageEnd({ role: "assistant", content: "New answer" });

      const spyCallTelegram = vi.spyOn(runtime, "callTelegram");
      await runtime.onAgentSettled(mockCtx);

      // Must NOT auto-create topic
      expect(spyCallTelegram).not.toHaveBeenCalled();
      expect(runtime.getBindingState()).toBe("unbound");
    });

    it("mirrors local user prompt before assistant text in bound session", async () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-mirror-1",
            chatId: mockConfig.chatId,
            threadId: 777,
          },
        },
        {
          type: "message",
          message: { role: "user", content: "What is 1 + 1?" },
        },
      ];

      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-mirror-1",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      expect(runtime.getBindingState()).toBe("bound");

      const sentMessages: string[] = [];
      vi.spyOn(runtime, "callTelegram").mockImplementation(async (method, params: any) => {
        if (method === "sendMessage") {
          sentMessages.push(params.text);
        }
        return {} as any;
      });

      // Mirror actual user admission on the background FIFO, not in before_agent_start.
      await runtime.onBeforeAgentStart(mockCtx);
      runtime.onMessageStart({ role: "user", content: "What is 1 + 1?" }, mockCtx);
      await runtime.outbox.whenIdle();
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0]).toBe("🧑‍💻 [Prompt]\nWhat is 1 + 1?");

      runtime.onMessageEnd({ role: "assistant", content: "It is 2." });
      await runtime.onAgentSettled(mockCtx);
      await runtime.outbox.whenIdle();

      // Verify assistant reply was sent after agent settled
      expect(sentMessages.length).toBe(2);
      expect(sentMessages[1]).toBe("It is 2.");
    });

    it("does NOT mirror prompt if the run was initiated from Telegram inbound", async () => {
      const mockPi = {
        appendEntry: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-tg-inbound",
            chatId: mockConfig.chatId,
            threadId: 777,
          },
        },
      ];

      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-tg-inbound",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);

      // The simulated Pi pipeline preserves the submission's asynchronous context.
      mockCtx.isIdle = () => true;
      mockPi.sendUserMessage.mockImplementation((text: string) => {
        void runtime.onBeforeAgentStart({ prompt: text }, mockCtx).then(() => runtime.onMessageStart({ role: "user", content: text }, mockCtx));
      });
      const admission = runtime.handleInboundText("Hello from Telegram!", mockCtx);

      // Simulate entry added by Pi after sendUserMessage
      entries.push({
        type: "message",
        message: { role: "user", content: "Hello from Telegram!" },
      });

      expect((await admission).accepted).toBe(true);
      runtime.onMessageEnd({ role: "assistant", content: "Hello back!" });

      const sentMessages: string[] = [];
      vi.spyOn(runtime, "callTelegram").mockImplementation(async (method, params: any) => {
        if (method === "sendMessage") {
          sentMessages.push(params.text);
        }
        return {} as any;
      });

      await runtime.onAgentSettled(mockCtx);
      await runtime.outbox.whenIdle();

      // Only assistant reply should be sent, NO prompt echo
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0]).toBe("Hello back!");
    });

    it("mirrors admitted user text rather than stale session history", async () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-pref",
            chatId: mockConfig.chatId,
            threadId: 888,
          },
        },
        {
          type: "message",
          message: { role: "user", content: "stale prompt in entries" },
        },
      ];

      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-pref",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);

      const sentMessages: string[] = [];
      vi.spyOn(runtime, "callTelegram").mockImplementation(async (method, params: any) => {
        if (method === "sendMessage") {
          sentMessages.push(params.text);
        }
        return {} as any;
      });

      await runtime.onBeforeAgentStart({ prompt: "fresh prompt from event" }, mockCtx);
      runtime.onMessageStart({ role: "user", content: "fresh prompt from event" }, mockCtx);
      await runtime.outbox.whenIdle();
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0]).toBe("🧑‍💻 [Prompt]\nfresh prompt from event");

      runtime.onMessageEnd({ role: "assistant", content: "Reply to fresh" });
      await runtime.onAgentSettled(mockCtx);
      await runtime.outbox.whenIdle();

      expect(sentMessages.length).toBe(2);
      expect(sentMessages[1]).toBe("Reply to fresh");
    });

    it("automatically closes forum topic on session shutdown when bound", async () => {
      const mockPi = { appendEntry: vi.fn() } as any;
      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-close-1",
            chatId: mockConfig.chatId,
            threadId: 888,
          },
        },
      ];
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-close-1",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess-close-1.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      expect(runtime.getBindingState()).toBe("bound");

      const spyCall = vi.spyOn((runtime as any).coordinator.getTelegramClient(), "callApi").mockResolvedValue({} as any);
      await runtime.onSessionShutdown(mockCtx);

      expect(spyCall).toHaveBeenCalledWith(
        "closeForumTopic",
        {
          chat_id: mockConfig.chatId,
          message_thread_id: 888,
        },
        undefined,
        expect.any(AbortSignal)
      );
    });

    it("does not close forum topic on session shutdown when unbound", async () => {
      const mockPi = { appendEntry: vi.fn() } as any;
      const runtime = new MuxRuntime(mockPi, tempDir);
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-unbound-1",
          getEntries: () => [],
          getSessionFile: () => "/tmp/sess-unbound-1.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      expect(runtime.getBindingState()).toBe("unbound");

      const spyCall = vi.spyOn((runtime as any).coordinator.getTelegramClient(), "callApi");
      await runtime.onSessionShutdown(mockCtx);

      expect(spyCall.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(0);
    });

    it("tolerates closeForumTopic failure during session shutdown", async () => {
      const mockPi = { appendEntry: vi.fn() } as any;
      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-close-err",
            chatId: mockConfig.chatId,
            threadId: 999,
          },
        },
      ];
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-close-err",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess-close-err.jsonl",
        },
      } as any;

      await runtime.onSessionStart(mockCtx);
      vi.spyOn((runtime as any).coordinator.getTelegramClient(), "callApi").mockRejectedValue(new Error("Network error"));

      // Must not throw
      await expect(runtime.onSessionShutdown(mockCtx)).resolves.not.toThrow();
    });

    it("automatically reopens forum topic on session resume when bound", async () => {
      const mockPi = { appendEntry: vi.fn() } as any;
      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-resume-1",
            chatId: mockConfig.chatId,
            threadId: 777,
          },
        },
      ];
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-resume-1",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess-resume-1.jsonl",
        },
      } as any;

      const spyCall = vi.spyOn(runtime, "callTelegram").mockResolvedValue({} as any);
      await runtime.onSessionStart({ reason: "resume" }, mockCtx);

      expect(spyCall).toHaveBeenCalledWith(
        "reopenForumTopic",
        {
          chat_id: mockConfig.chatId,
          message_thread_id: 777,
        },
        expect.objectContaining({ sessionId: "sess-resume-1", threadId: 777 }),
        expect.any(AbortSignal)
      );
    });

    it("reopens the existing forum topic on CLI startup", async () => {
      const mockPi = { appendEntry: vi.fn() } as any;
      const runtime = new MuxRuntime(mockPi, tempDir);
      const entries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-startup-1",
            chatId: mockConfig.chatId,
            threadId: 777,
          },
        },
      ];
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-startup-1",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess-startup-1.jsonl",
        },
      } as any;

      const spyCall = vi.spyOn(runtime, "callTelegram").mockResolvedValue({} as any);
      await runtime.onSessionStart({ reason: "startup" }, mockCtx);

      expect(spyCall).toHaveBeenCalledWith("reopenForumTopic", expect.objectContaining({ message_thread_id: 777 }), expect.objectContaining({ sessionId: "sess-startup-1", threadId: 777 }), expect.any(AbortSignal));
    });

    it("closes old topic on /new lifecycle and readies new unbound session", async () => {
      const mockPi = { appendEntry: vi.fn() } as any;
      const runtime = new MuxRuntime(mockPi, tempDir);
      const oldEntries: any[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-old-1",
            chatId: mockConfig.chatId,
            threadId: 666,
          },
        },
      ];
      const oldCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-old-1",
          getEntries: () => oldEntries,
          getSessionFile: () => "/tmp/sess-old-1.jsonl",
        },
      } as any;

      await runtime.onSessionStart(oldCtx);
      expect(runtime.getBindingState()).toBe("bound");

      const spyCall = vi.spyOn((runtime as any).coordinator.getTelegramClient(), "callApi").mockResolvedValue({} as any);

      // 1. Pi emits session_before_switch then session_shutdown for the old session
      runtime.onSessionBeforeSwitch(oldCtx);
      await runtime.onSessionShutdown(oldCtx);

      // Verifies the old topic was closed
      expect(spyCall).toHaveBeenCalledWith(
        "closeForumTopic",
        {
          chat_id: mockConfig.chatId,
          message_thread_id: 666,
        },
        undefined,
        expect.any(AbortSignal)
      );

      // 2. Pi emits session_start with reason: "new" for the replacement session
      const newCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-new-1",
          getEntries: () => [],
          getSessionFile: () => "/tmp/sess-new-1.jsonl",
        },
      } as any;

      spyCall.mockClear();
      await runtime.onSessionStart({ reason: "new" }, newCtx);

      // Verifies the replacement session is ready and unbound, does not reopen old topic
      expect(runtime.getBindingState()).toBe("unbound");
      expect(runtime.getCurrentThreadId()).toBeNull();
      expect(spyCall).not.toHaveBeenCalled();
    });
  });
});

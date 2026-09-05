import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../src/config.js";
import { MuxRuntime } from "../../src/runtime.js";
import type { MuxConfig, TelegramForumTopic, TelegramMessage } from "../../src/types.js";

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const res = path.resolve(dir, entry.name);
      return entry.isDirectory() ? getAllFiles(res) : [res];
    })
  );
  return files.flat();
}

describe("Privacy & No Chat Persistence Canary Test", () => {
  let tempDir: string;
  const mockConfig: MuxConfig = {
    version: 1,
    botToken: "token-canary-test-123",
    chatId: -100444333,
    allowedUserId: 998877,
  };

  const CANARY_USER_INPUT = "CANARY_USER_PROMPT_SECRET_987654321";
  const CANARY_ASSISTANT_TEXT = "CANARY_ASSISTANT_ANSWER_CONFIDENTIAL_123456789";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-canary-"));
    await saveConfig(tempDir, mockConfig);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("verifies mux files and temporary files never persist chat content or canary strings", async () => {
    const sessionEntries: any[] = [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: "sess-canary-42", chatId: mockConfig.chatId, threadId: 888 } }];
    const mockPi = {
      appendEntry: vi.fn((customType: string, data: any) => {
        sessionEntries.push({ type: "custom", customType, data });
      }),
      sendUserMessage: vi.fn(),
    } as any;

    const mockCtx = {
      mode: "tui",
      isIdle: () => true,
      cwd: "/workspace/canary-project",
      sessionManager: {
        getSessionId: () => "sess-canary-42",
        getSessionFile: () => "/tmp/canary-session.jsonl",
        getSessionName: () => "CanarySession",
        getEntries: () => sessionEntries,
      },
      ui: { notify: vi.fn() },
    } as any;

    const runtime = new MuxRuntime(mockPi, tempDir);

    // Mock telegram API calls
    vi.spyOn(runtime, "callTelegram").mockImplementation(async (method, params: any) => {
      if (method === "createForumTopic") {
        return { message_thread_id: 888, name: params.name } as TelegramForumTopic;
      }
      if (method === "sendMessage") {
        return {
          message_id: 99,
          chat: { id: params.chat_id, type: "supergroup" },
          date: Date.now(),
          text: params.text,
        } as TelegramMessage;
      }
      return {} as any;
    });

    // 1. Session start
    await runtime.onSessionStart(mockCtx);

    // 2. Inbound Telegram text arrives (contains Canary user input)
    mockPi.sendUserMessage.mockImplementation((text: string) => {
      void runtime.onBeforeAgentStart({ prompt: text }, mockCtx).then(() => runtime.onMessageStart({ role: "user", content: text }, mockCtx));
    });
    const admission = runtime.handleInboundText(CANARY_USER_INPUT, mockCtx);
    expect((await admission).accepted).toBe(true);
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(CANARY_USER_INPUT, {
      expandPromptTemplates: false,
    });

    // 3. Assistant output generated (contains Canary assistant text)
    runtime.onMessageEnd({ role: "assistant", content: CANARY_ASSISTANT_TEXT });
    await runtime.onAgentSettled(mockCtx);
    await runtime.outbox.whenIdle();

    // 4. Shutdown runtime
    await runtime.onSessionShutdown(mockCtx);

    // 5. Scan all files in tempDir (agentDir) created by mux
    const allFiles = await getAllFiles(tempDir);
    expect(allFiles.length).toBeGreaterThan(0);

    for (const filePath of allFiles) {
      const content = await fs.readFile(filePath, "utf-8");

      // Canary assertions: neither user input nor assistant output may be in any file
      expect(content).not.toContain(CANARY_USER_INPUT);
      expect(content).not.toContain(CANARY_ASSISTANT_TEXT);

      // Verify custom entry data does NOT contain chat text
      if (filePath.endsWith("config.json")) {
        const parsed = JSON.parse(content);
        expect(parsed.version).toBe(1);
        expect(parsed.botToken).toBe(mockConfig.botToken);
        expect(parsed.chatId).toBe(mockConfig.chatId);
        expect(parsed.allowedUserId).toBe(mockConfig.allowedUserId);
        // Ensure no chat/offset/topic fields leaked into config
        expect(parsed.offset).toBeUndefined();
        expect(parsed.topics).toBeUndefined();
        expect(parsed.messages).toBeUndefined();
      }
    }

    // 6. Verify that binding entries appended to session contain ONLY minimal metadata
    for (const entry of sessionEntries) {
      if (entry.type === "custom" && entry.customType === "pi-telegram-mux.binding") {
        expect(entry.data).toEqual({
          version: 1,
          sessionId: "sess-canary-42",
          chatId: mockConfig.chatId,
          threadId: 888,
        });
        // Strictly no chat or canary strings
        const json = JSON.stringify(entry.data);
        expect(json).not.toContain(CANARY_USER_INPUT);
        expect(json).not.toContain(CANARY_ASSISTANT_TEXT);
      }
    }
  });
});

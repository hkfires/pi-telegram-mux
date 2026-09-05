import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../src/config.js";
import { LeaderCoordinator } from "../../src/coordinator.js";
import { IpcFollowerClient } from "../../src/ipc.js";
import type { MuxConfig, TelegramMessage, TelegramUpdate } from "../../src/types.js";

describe("Leader/Follower TCP Integration", () => {
  let tempDir: string;
  const mockConfig: MuxConfig = {
    version: 1,
    botToken: "token-multi-proc-test",
    chatId: -100555444,
    allowedUserId: 888777,
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-multi-"));
    await saveConfig(tempDir, mockConfig);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("routes inbound and fenced outbound messages through IPC", async () => {
    // 1. Start Leader
    const coordinator = new LeaderCoordinator(mockConfig, tempDir);
    const { port, capability } = await coordinator.start();
    expect(port).toBeGreaterThan(0);
    expect(capability).toBeTruthy();

    // Mock coordinator's telegram client calls
    const sentMessages: { chatId: number; text: string; threadId?: number }[] = [];
    const callApi = coordinator.getTelegramClient().callApi.bind(coordinator.getTelegramClient());
    vi.spyOn(coordinator.getTelegramClient(), "callApi").mockImplementation(
      async (method: string, params: any, timeout, signal) => {
        if (method === "sendMessage") {
          sentMessages.push({
            chatId: params.chat_id,
            text: params.text,
            threadId: params.message_thread_id,
          });
          return {
            message_id: 1,
            chat: { id: params.chat_id, type: "supergroup" },
            date: Date.now(),
            text: params.text,
          } as TelegramMessage;
        }
        return callApi(method, params, timeout, signal);
      }
    );

    // 2. Start Follower
    const followerRuntimeId = "follower-proc-1";
    const followerClient = new IpcFollowerClient(port, capability, followerRuntimeId);

    const receivedInbound: string[] = [];
    followerClient.setInboundHandler(async (msg) => {
      receivedInbound.push(msg.text);
      return { accepted: true, busy: false };
    });

    await followerClient.connect();

    // 3. Follower registers route for thread 900
    followerClient.send({
      type: "register",
      registration: {
        runtimeId: followerRuntimeId,
        sessionId: "follower-session-999",
        threadId: 900,
        generation: 1,
      },
    });

    // Wait briefly for registration frame to be processed
    await new Promise((r) => setTimeout(r, 100));
    expect(coordinator.getRoutes().has(900)).toBe(true);

    // 4. Inbound Telegram update arrives at Leader for thread 900
    const update: TelegramUpdate = {
      update_id: 101,
      message: {
        message_id: 501,
        message_thread_id: 900,
        chat: { id: mockConfig.chatId, type: "supergroup" },
        from: { id: mockConfig.allowedUserId, is_bot: false, first_name: "AllowedUser" },
        date: Date.now(),
        text: "Please run tests",
      },
    };

    await coordinator.processUpdate(update);

    // Follower should have received the inbound text
    expect(receivedInbound).toContain("Please run tests");

    // 5. Follower calls Telegram API through Leader
    const sendResult = await followerClient.callTelegram<TelegramMessage>("sendMessage", {
      chat_id: mockConfig.chatId,
      message_thread_id: 900,
      text: "Running tests now...",
    }, { sessionId: "follower-session-999", threadId: 900, generation: 1 });

    expect(sendResult.message_id).toBe(1);
    expect(sentMessages.some((m) => m.text === "Running tests now..." && m.threadId === 900)).toBe(
      true
    );

    // 6. Follower disconnects -> Route automatically removed from Leader
    followerClient.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(coordinator.getRoutes().has(900)).toBe(false);

    // Clean up Leader
    await coordinator.stop();
  });
});

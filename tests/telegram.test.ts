import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  RateLimitError,
  TelegramClient,
  TelegramDecodeError,
  TelegramRequestError,
  isRecoverableTelegramError,
  validateBotAndChat,
} from "../src/telegram.js";

describe("telegram client module", () => {
  let mockServer: http.Server;
  let mockPort: number;
  let mockApiBase: string;
  const mockToken = "123456789:AAFakeTokenForTestingOnly";

  // Mock server routing
  let nextHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      if (nextHandler) {
        nextHandler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => resolve());
    });

    const address = mockServer.address() as { port: number };
    mockPort = address.port;
    mockApiBase = `http://127.0.0.1:${mockPort}`;
  });

  afterAll(async () => {
    mockServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it("redacts bot token from text and URLs", () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    const raw = `Request failed: https://api.telegram.org/bot${mockToken}/sendMessage?text=hi`;
    const redacted = client.redact(raw);
    expect(redacted).not.toContain(mockToken);
    expect(redacted).toBe("Request failed: https://api.telegram.org/bot<redacted>/sendMessage?text=hi");
  });

  it("calls getMe successfully", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: { id: 99999, is_bot: true, first_name: "TestBot", username: "test_bot" },
        })
      );
    };

    const me = await client.getMe();
    expect(me.id).toBe(99999);
    expect(me.is_bot).toBe(true);
    expect(me.username).toBe("test_bot");
  });

  it("serializes an inline keyboard with the target topic", async () => {
    const client = new TelegramClient({ botToken: mockToken, apiBase: mockApiBase });
    let body: any;
    nextHandler = (req, res) => {
      let text = "";
      req.on("data", chunk => { text += chunk; });
      req.on("end", () => {
        body = JSON.parse(text);
        res.end(JSON.stringify({ ok: true, result: { message_id: 900 } }));
      });
    };
    const reply_markup = { inline_keyboard: [[{ text: "high", callback_data: "mux:0123456789abcdef01234567:0" }]] };
    await client.sendMessage(-100123, "Thinking", { message_thread_id: 50, reply_markup });
    expect(body).toEqual({ chat_id: -100123, text: "Thinking", message_thread_id: 50, reply_markup });
  });

  it("decodes callback updates and rejects malformed callback payloads", async () => {
    const client = new TelegramClient({ botToken: mockToken, apiBase: mockApiBase });
    const valid = { id: "query", from: { id: 123, is_bot: false }, data: "mux:0123456789abcdef01234567:0", message: { message_id: 900, chat: { id: -100123 }, date: 1 } };
    let query: unknown = valid;
    nextHandler = (_req, res) => { res.end(JSON.stringify({ ok: true, result: [{ update_id: 1, callback_query: query }] })); };
    expect((await client.getUpdates())[0].callback_query).toEqual(valid);
    for (const bad of [null, {}, { ...valid, id: 3 }, { ...valid, from: null }, { ...valid, from: { id: 123 } },
      { ...valid, data: "x".repeat(65) }, { ...valid, message: { ...valid.message, message_id: "900" } },
      { ...valid, message: { ...valid.message, message_thread_id: "50" } }]) {
      query = bad;
      await expect(client.getUpdates()).rejects.toThrow(TelegramDecodeError);
    }
    // Telegram can send inaccessible messages and callbacks without a message; the coordinator rejects them safely.
    query = { ...valid, message: { ...valid.message, date: 0 } };
    await expect(client.getUpdates()).resolves.toHaveLength(1);
    query = { ...valid, message: undefined };
    await expect(client.getUpdates()).resolves.toHaveLength(1);
  });

  it("handles 429 Too Many Requests and pauses", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    nextHandler = (_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 2",
          parameters: { retry_after: 2 },
        })
      );
    };

    await expect(client.getMe()).rejects.toThrow(RateLimitError);
    expect(client.isRateLimited()).toBe(true);
    expect(client.getRemainingPauseMs()).toBeGreaterThan(0);

    // Immediate next call should fail locally without network request
    let networkCalled = false;
    nextHandler = (_req, _res) => {
      networkCalled = true;
    };

    await expect(client.getMe()).rejects.toThrow(RateLimitError);
    expect(networkCalled).toBe(false);
  });

  it("handles 409 Conflict", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    nextHandler = (_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error_code: 409,
          description: "Conflict: terminated by other getUpdates request",
        })
      );
    };

    await expect(client.getUpdates()).rejects.toThrow(ConflictError);
  });

  it.each(["not JSON", "{}", '{"ok":true}', '{"ok":true,"result":{}}', '{"ok":true,"result":[{"update_id":"invalid"}]}'])("fails loudly on malformed polling responses: %s", async payload => {
    const client = new TelegramClient({ botToken: mockToken, apiBase: mockApiBase });
    nextHandler = (_req, res) => { res.writeHead(200); res.end(payload); };
    await expect(client.getUpdates()).rejects.toBeInstanceOf(TelegramDecodeError);
  });

  it.each([401, 403, 503])("classifies HTTP %s by its code, not error wording", async status => {
    const client = new TelegramClient({ botToken: mockToken, apiBase: mockApiBase });
    nextHandler = (_req, res) => { res.writeHead(status); res.end(JSON.stringify({ ok: false, error_code: status, description: "arbitrary localized description" })); };
    const failure = await client.getUpdates().then(() => { throw new Error("Expected API failure"); }, error => error);
    expect(failure.errorCode).toBe(status);
    expect(isRecoverableTelegramError(failure)).toBe(status === 503);
  });

  it.each([
    [502, "<html>Bad Gateway</html>"], [503, "{}"], [504, "not JSON"], [408, ""],
  ])("retains retryable HTTP %s despite a non-API body", async (status, body) => {
    const client = new TelegramClient({ botToken: mockToken, apiBase: mockApiBase });
    nextHandler = (_req, res) => { res.writeHead(Number(status)); res.end(body); };
    const error = await client.getUpdates().catch(error => error);
    expect(error.errorCode).toBe(status);
    expect(isRecoverableTelegramError(error)).toBe(true);
  });

  describe("validateBotAndChat", () => {
    it.each([
      {
        name: "validates bot and chat permissions",
        chat: { id: -100, type: "supergroup", is_forum: true, title: "Super Forum" },
        botMember: { status: "administrator", can_manage_topics: true },
        expectedError: undefined,
      },
      {
        name: "fails validateBotAndChat if chat is a supergroup but not a forum",
        chat: { id: -100, type: "supergroup", is_forum: false },
        botMember: { status: "administrator", can_manage_topics: true },
        expectedError: "not a Forum Supergroup",
      },
      {
        name: "fails validateBotAndChat if bot lacks can_manage_topics permission",
        chat: { id: -100, type: "supergroup", is_forum: true, title: "Super Forum" },
        botMember: { status: "administrator", can_manage_topics: false },
        expectedError: "topic management permissions",
      },
    ])("$name", async ({ chat, botMember, expectedError }) => {
      const client = new TelegramClient({
        botToken: mockToken,
        apiBase: mockApiBase,
      });

      nextHandler = (req, res) => {
        const url = req.url || "";
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const bodyStr = Buffer.concat(chunks).toString("utf-8");
          const parsed = bodyStr ? JSON.parse(bodyStr) : {};
          res.writeHead(200, { "Content-Type": "application/json" });

          if (url.includes("/getMe")) {
            res.end(JSON.stringify({ ok: true, result: { id: 10, is_bot: true, first_name: "B", username: "fixture_bot" } }));
          } else if (url.includes("/getChatMember")) {
            const result = parsed.user_id === 10 ? botMember : { status: "member" };
            res.end(JSON.stringify({ ok: true, result }));
          } else if (url.includes("/getChat")) {
            res.end(JSON.stringify({ ok: true, result: chat }));
          }
        });
      };

      if (expectedError) {
        await expect(validateBotAndChat(client, -100, 20)).rejects.toThrow(expectedError);
      } else {
        const res = await validateBotAndChat(client, -100, 20);
        expect(res.botUser.id).toBe(10);
        expect(res.chat.is_forum).toBe(true);
      }
    });
  });

  it("calls closeForumTopic successfully", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    let receivedBody = "";
    nextHandler = (req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: true }));
      });
    };

    const result = await client.closeForumTopic(-100123, 42);
    expect(result).toBe(true);
    expect(JSON.parse(receivedBody)).toEqual({ chat_id: -100123, message_thread_id: 42 });
  });

  it("formats timeout failures cleanly without 'This operation was aborted'", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
      defaultTimeoutMs: 50,
    });

    nextHandler = (_req, _res) => {
      // Intentionally do not respond to trigger timeout
    };

    const error = await client.callApi("getUpdates", undefined, 50).catch(err => err);
    expect(error).toBeInstanceOf(TelegramRequestError);
    expect(error.code).toBe("TELEGRAM_TIMEOUT");
    expect(error.message).toBe("Telegram request timed out (getUpdates)");
    expect(error.message).not.toContain("This operation was aborted");
  });

  it("calls setMessageReaction successfully", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    let receivedBody = "";
    nextHandler = (req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: true }));
      });
    };

    const result = await client.setMessageReaction(-100123, 42, [{ type: "emoji", emoji: "⚡" }]);
    expect(result).toBe(true);
    expect(JSON.parse(receivedBody)).toEqual({
      chat_id: -100123,
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "⚡" }],
    });
  });

  it("does not set rate-limit pause when setMessageReaction receives 429", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    nextHandler = (_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      }));
    };

    const reactionResult = await client.setMessageReaction(-100123, 42, [{ type: "emoji", emoji: "👀" }]);
    expect(reactionResult).toBe(false);
    // Crucial: Rate limit must NOT be recorded for cosmetic reactions
    expect(client.isRateLimited()).toBe(false);

    // Follow-up normal API call should not be rate-limited
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 999 } }));
    };

    const sendResult = await client.sendMessage(-100123, "Answer");
    expect(sendResult).toMatchObject({ message_id: 999 });
  });
});

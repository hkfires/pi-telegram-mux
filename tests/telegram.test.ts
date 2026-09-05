import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  RateLimitError,
  TelegramClient,
  TelegramDecodeError,
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

  it("validates bot and chat permissions", async () => {
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
          if (parsed.user_id === 10) {
            // bot member
            res.end(
              JSON.stringify({
                ok: true,
                result: { status: "administrator", can_manage_topics: true },
              })
            );
          } else {
            // allowed user member
            res.end(JSON.stringify({ ok: true, result: { status: "member" } }));
          }
        } else if (url.includes("/getChat")) {
          res.end(
            JSON.stringify({
              ok: true,
              result: { id: -100, type: "supergroup", is_forum: true, title: "Super Forum" },
            })
          );
        }
      });
    };

    const res = await validateBotAndChat(client, -100, 20);
    expect(res.botUser.id).toBe(10);
    expect(res.chat.is_forum).toBe(true);
  });

  it("fails validateBotAndChat if chat is a supergroup but not a forum", async () => {
    const client = new TelegramClient({
      botToken: mockToken,
      apiBase: mockApiBase,
    });

    nextHandler = (req, res) => {
      const url = req.url || "";
      res.writeHead(200, { "Content-Type": "application/json" });

      if (url.includes("getMe")) {
        res.end(JSON.stringify({ ok: true, result: { id: 10, is_bot: true, first_name: "B", username: "fixture_bot" } }));
      } else if (url.includes("getChat")) {
        res.end(
          JSON.stringify({
            ok: true,
            result: { id: -100, type: "supergroup", is_forum: false },
          })
        );
      }
    };

    await expect(validateBotAndChat(client, -100, 20)).rejects.toThrow("not a Forum Supergroup");
  });

  it("fails validateBotAndChat if bot lacks can_manage_topics permission", async () => {
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
          if (parsed.user_id === 10) {
            // bot member without can_manage_topics
            res.end(
              JSON.stringify({
                ok: true,
                result: { status: "administrator", can_manage_topics: false },
              })
            );
          } else {
            res.end(JSON.stringify({ ok: true, result: { status: "creator" } }));
          }
        } else if (url.includes("/getChat")) {
          res.end(
            JSON.stringify({
              ok: true,
              result: { id: -100, type: "supergroup", is_forum: true, title: "Super Forum" },
            })
          );
        }
      });
    };

    await expect(validateBotAndChat(client, -100, 20)).rejects.toThrow("topic management permissions");
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
});

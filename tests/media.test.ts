import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupStaleMedia, ensureMediaDir, getMediaDir, saveConfig } from "../src/config.js";
import { LeaderCoordinator } from "../src/coordinator.js";
import { MuxRuntime } from "../src/runtime.js";
import { RateLimitError, TelegramClient } from "../src/telegram.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InboundMedia, MuxConfig, TelegramUpdate } from "../src/types.js";

const testConfig: MuxConfig = {
  version: 1,
  botToken: "test-bot-token-media",
  chatId: -1001234567,
  allowedUserId: 99999,
};

describe("media handling and multimodal prompts", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-media-"));
    await saveConfig(tempDir, testConfig);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("media directory and cleanup", () => {
    it("creates media directory with 0o700 permissions", async () => {
      const mediaDir = getMediaDir(tempDir);
      expect(mediaDir).toBe(path.join(tempDir, "pi-telegram-mux", "media"));

      const ensured = await ensureMediaDir(tempDir);
      expect(ensured).toBe(mediaDir);

      const stat = await fs.stat(mediaDir);
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });

    it.each(["jpg", "png", "gif", "webp"])("cleans only stale unfinished %s files, preserving completed and unrelated files", async ext => {
      const mediaDir = await ensureMediaDir(tempDir);
      const staleName = `${crypto.randomUUID()}.${ext}.part`;
      const freshName = `${crypto.randomUUID()}.${ext}.part`;
      const completedName = `${crypto.randomUUID()}.${ext}`;
      const preserved = [freshName, completedName, "legacy.jpg", "unrelated.part", `${crypto.randomUUID()}.txt.part`];
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      for (const name of [staleName, ...preserved]) {
        const file = path.join(mediaDir, name);
        await fs.writeFile(file, name);
        if (name !== freshName) await fs.utimes(file, twoHoursAgo, twoHoursAgo);
      }

      await cleanupStaleMedia(tempDir);

      expect((await fs.readdir(mediaDir)).sort()).toEqual(preserved.sort());
      for (const name of preserved) expect(await fs.readFile(path.join(mediaDir, name), "utf8")).toBe(name);
    });
  });

  describe("TelegramClient - getFile & downloadFile", () => {
    it("calls getFile and returns file metadata", async () => {
      const client = new TelegramClient({ botToken: "test-token" });
      const apiSpy = vi.spyOn(client, "callApi").mockResolvedValue({
        file_id: "file-xyz-123",
        file_unique_id: "unique-123",
        file_path: "photos/file_0.jpg",
        file_size: 1024,
      });

      const result = await client.getFile("file-xyz-123");
      expect(apiSpy).toHaveBeenCalledWith("getFile", { file_id: "file-xyz-123" }, undefined, undefined);
      expect(result.file_path).toBe("photos/file_0.jpg");
    });

    it("downloads file buffer via HTTP GET", async () => {
      const client = new TelegramClient({ botToken: "test-token" });
      const fakeBinary = Buffer.from("image-binary-content-12345");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url: any) => {
        expect(url.toString()).toContain("/file/bot<redacted>/photos/file_0.jpg".replace("<redacted>", "test-token"));
        return new Response(fakeBinary, { headers: { "content-length": String(fakeBinary.byteLength) } });
      });

      try {
        const buffer = await client.downloadFile("photos/file_0.jpg");
        expect(buffer.toString()).toBe("image-binary-content-12345");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("downloads an image larger than 20 MiB without a local size limit", async () => {
      const client = new TelegramClient({ botToken: "test-token" });
      const image = Buffer.alloc(25_000_000, 7);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => new Response(image, {
        headers: { "content-length": String(image.length) },
      }));

      try {
        const downloaded = await client.downloadFile("photos/large.jpg");
        expect(downloaded.equals(image)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws RateLimitError on 429 response", async () => {
      const client = new TelegramClient({ botToken: "test-token" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Headers(),
      } as any));

      try {
        await expect(client.downloadFile("photos/limited.jpg")).rejects.toThrow(RateLimitError);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Coordinator image processing", () => {
    it("downloads photo, saves to media directory, and dispatches to route", async () => {
      const client = new TelegramClient({ botToken: testConfig.botToken });
      const coordinator = new LeaderCoordinator(testConfig, tempDir, client);
      (coordinator as any).running = true;

      const fakeImageBytes = Buffer.from("fake-jpeg-image-bytes");
      vi.spyOn(client, "getFile").mockResolvedValue({
        file_id: "photo-large-id",
        file_unique_id: "photo-unique",
        file_path: "photos/photo_highres.jpg",
      });
      vi.spyOn(client, "downloadFile").mockResolvedValue(fakeImageBytes);

      let dispatchedText = "";
      let dispatchedMedia: InboundMedia | undefined;
      const threadId = 100;

      coordinator.registerLocalRoute({
        sessionId: "sess-1",
        threadId,
        generation: 1,
        runtimeId: "rt-1",
        dispatchInbound: async (text, _msgId, media) => {
          dispatchedText = text;
          dispatchedMedia = media;
          expect(await fs.readFile(media!.path)).toEqual(fakeImageBytes);
          return { accepted: true, busy: false };
        },
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 42,
          message_thread_id: threadId,
          chat: { id: testConfig.chatId, type: "supergroup" },
          from: { id: testConfig.allowedUserId, is_bot: false, first_name: "Tester" },
          date: 123456,
          caption: "Check this screenshot",
          photo: [
            { file_id: "photo-thumb-id", file_unique_id: "u1", width: 100, height: 100 },
            { file_id: "photo-large-id", file_unique_id: "u2", width: 800, height: 800 },
          ],
        },
      };

      await coordinator.processUpdate(update);
      await coordinator.feedback.whenIdle();

      expect(dispatchedText).toBe("Check this screenshot");
      expect(dispatchedMedia).toBeDefined();
      expect(dispatchedMedia?.mimeType).toBe("image/jpeg");
      expect(dispatchedMedia?.path).toContain(path.join(tempDir, "pi-telegram-mux", "media"));

      // Handed-off paths remain usable even when the receiving route does not read them.
      expect(await fs.readFile(dispatchedMedia!.path)).toEqual(fakeImageBytes);
      expect(await fs.readdir(getMediaDir(tempDir))).toEqual([path.basename(dispatchedMedia!.path)]);
      if (process.platform !== "win32") expect((await fs.stat(dispatchedMedia!.path)).mode & 0o777).toBe(0o600);
    });

    it("downloads document image and dispatches with document mime type", async () => {
      const client = new TelegramClient({ botToken: testConfig.botToken });
      const coordinator = new LeaderCoordinator(testConfig, tempDir, client);
      (coordinator as any).running = true;

      const fakePngBytes = Buffer.from("fake-png-image-bytes");
      vi.spyOn(client, "getFile").mockResolvedValue({
        file_id: "doc-png-id",
        file_unique_id: "doc-unique",
        file_path: "documents/diagram.png",
      });
      vi.spyOn(client, "downloadFile").mockResolvedValue(fakePngBytes);

      let dispatchedMedia: InboundMedia | undefined;
      const threadId = 101;

      coordinator.registerLocalRoute({
        sessionId: "sess-2",
        threadId,
        generation: 1,
        runtimeId: "rt-2",
        dispatchInbound: async (_text, _msgId, media) => {
          dispatchedMedia = media;
          return { accepted: true, busy: false };
        },
      });

      const update: TelegramUpdate = {
        update_id: 2,
        message: {
          message_id: 43,
          message_thread_id: threadId,
          chat: { id: testConfig.chatId, type: "supergroup" },
          from: { id: testConfig.allowedUserId, is_bot: false, first_name: "Tester" },
          date: 123456,
          document: {
            file_id: "doc-png-id",
            file_unique_id: "doc-unique",
            file_name: "diagram.png",
            mime_type: "image/png",
          },
        },
      };

      await coordinator.processUpdate(update);
      await coordinator.feedback.whenIdle();

      expect(dispatchedMedia).toBeDefined();
      expect(dispatchedMedia?.mimeType).toBe("image/png");
      expect(dispatchedMedia?.fileName).toBe("diagram.png");
      expect(await fs.readFile(dispatchedMedia!.path)).toEqual(fakePngBytes);
    });

    it("handles download failure gracefully and reports feedback", async () => {
      const client = new TelegramClient({ botToken: testConfig.botToken });
      const coordinator = new LeaderCoordinator(testConfig, tempDir, client);
      (coordinator as any).running = true;

      vi.spyOn(client, "getFile").mockRejectedValue(new Error("File not found"));
      const sendSpy = vi.spyOn(client, "sendMessage").mockResolvedValue({ message_id: 999 } as any);

      const threadId = 102;
      coordinator.registerLocalRoute({
        sessionId: "sess-3",
        threadId,
        generation: 1,
        runtimeId: "rt-3",
        dispatchInbound: vi.fn(),
      });

      const update: TelegramUpdate = {
        update_id: 3,
        message: {
          message_id: 44,
          message_thread_id: threadId,
          chat: { id: testConfig.chatId, type: "supergroup" },
          from: { id: testConfig.allowedUserId, is_bot: false, first_name: "Tester" },
          date: 123456,
          photo: [{ file_id: "photo-fail-id", file_unique_id: "u3", width: 100, height: 100 }],
        },
      };

      await coordinator.processUpdate(update);
      await coordinator.feedback.whenIdle();

      // Coordinator sends feedback about failure
      expect(sendSpy).toHaveBeenCalledWith(
        testConfig.chatId,
        expect.stringContaining("Failed to download image"),
        expect.objectContaining({ message_thread_id: threadId }),
        expect.any(Object)
      );
    });
  });

  describe("MuxRuntime - inbound media processing", () => {
    it("reads image file into Base64, retains the file, and passes multimodal content to sendUserMessage", async () => {
      const mediaDir = await ensureMediaDir(tempDir);
      const testImagePath = path.join(mediaDir, `${crypto.randomUUID()}.png`);
      const imageContent = Buffer.from("raw-test-image-binary-data");
      await fs.writeFile(testImagePath, imageContent);

      const mockPi = {
        sendUserMessage: vi.fn(),
        sendMessage: vi.fn(),
        appendEntry: vi.fn(),
      };

      const mockCtx = {
        mode: "tui",
        model: { input: ["text", "image"] },
        cwd: tempDir,
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "sess-test-media",
          getEntries: () => [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: "sess-test-media", chatId: testConfig.chatId, threadId: 50 } }],
          getSessionFile: () => `${tempDir}/sess.jsonl`,
        },
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext;

      const runtime = new MuxRuntime(mockPi as unknown as ExtensionAPI, tempDir);
      await runtime.onSessionStart(mockCtx);

      mockPi.sendUserMessage.mockImplementation(() => {
        void runtime.onBeforeAgentStart({ prompt: "Please inspect this chart" }, mockCtx).then(() => {
          runtime.onMessageStart({ role: "user", content: "Please inspect this chart" }, mockCtx);
        });
      });

      const media: InboundMedia = {
        path: testImagePath,
        mimeType: "image/png",
        fileName: "chart.png",
      };

      const result = await runtime.handleInboundText("Please inspect this chart", mockCtx, 101, undefined, media);

      expect(result.accepted).toBe(true);
      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        [
          { type: "text", text: "[Image#1]\n\nPlease inspect this chart" },
          { type: "image", data: imageContent.toString("base64"), mimeType: "image/png" },
        ],
        { expandPromptTemplates: false }
      );

      expect(await fs.readFile(testImagePath)).toEqual(imageContent);
    });

    it("uses only the image label when text is empty for image input", async () => {
      const mediaDir = await ensureMediaDir(tempDir);
      const testImagePath = path.join(mediaDir, `${crypto.randomUUID()}.jpg`);
      await fs.writeFile(testImagePath, "some-jpeg-data");

      const mockPi = {
        sendUserMessage: vi.fn(),
        sendMessage: vi.fn(),
        appendEntry: vi.fn(),
      };

      const mockCtx = {
        mode: "tui",
        model: { input: ["text", "image"] },
        cwd: tempDir,
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "sess-test-empty-caption",
          getEntries: () => [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: "sess-test-empty-caption", chatId: testConfig.chatId, threadId: 50 } }],
          getSessionFile: () => `${tempDir}/sess.jsonl`,
        },
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext;

      const runtime = new MuxRuntime(mockPi as unknown as ExtensionAPI, tempDir);
      await runtime.onSessionStart(mockCtx);

      mockPi.sendUserMessage.mockImplementation((content: any) => {
        void runtime.onBeforeAgentStart({ prompt: "[Image#1]" }, mockCtx).then(() => {
          runtime.onMessageStart({ role: "user", content }, mockCtx);
        });
      });

      const media: InboundMedia = {
        path: testImagePath,
        mimeType: "image/jpeg",
      };

      const result = await runtime.handleInboundText("", mockCtx, 102, undefined, media);

      expect(result.accepted).toBe(true);
      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        [
          { type: "text", text: "[Image#1]" },
          { type: "image", data: Buffer.from("some-jpeg-data").toString("base64"), mimeType: "image/jpeg" },
        ],
        { expandPromptTemplates: false }
      );
    });

    it("rejects image input but retains the file if model explicitly does not support images", async () => {
      const mediaDir = await ensureMediaDir(tempDir);
      const testImagePath = path.join(mediaDir, `${crypto.randomUUID()}.jpg`);
      await fs.writeFile(testImagePath, "some-jpeg-data");

      const mockPi = {
        sendUserMessage: vi.fn(),
        sendMessage: vi.fn(),
        appendEntry: vi.fn(),
      };

      const mockCtx = {
        mode: "tui",
        cwd: tempDir,
        isIdle: () => true,
        model: {
          id: "text-only-model",
          provider: "openai",
          input: ["text"], // No "image" support!
        },
        sessionManager: {
          getSessionId: () => "sess-test-text-only-model",
          getEntries: () => [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: "sess-test-text-only-model", chatId: testConfig.chatId, threadId: 50 } }],
          getSessionFile: () => `${tempDir}/sess.jsonl`,
        },
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext;

      const runtime = new MuxRuntime(mockPi as unknown as ExtensionAPI, tempDir);
      await runtime.onSessionStart(mockCtx);

      const media: InboundMedia = {
        path: testImagePath,
        mimeType: "image/jpeg",
      };

      const result = await runtime.handleInboundText("Analyze this", mockCtx, 103, undefined, media);

      expect(result.accepted).toBe(false);
      expect(result.statusReply).toContain("does not support image input");
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();

      expect(await fs.readFile(testImagePath, "utf8")).toBe("some-jpeg-data");
    });

    it("queues multimodal message when Pi is busy", async () => {
      const mediaDir = await ensureMediaDir(tempDir);
      const testImagePath = path.join(mediaDir, `${crypto.randomUUID()}.png`);
      const imageBytes = Buffer.from("busy-mode-image-bytes");
      await fs.writeFile(testImagePath, imageBytes);

      const mockPi = {
        sendUserMessage: vi.fn(),
        sendMessage: vi.fn(),
        appendEntry: vi.fn(),
      };

      const mockCtx = {
        mode: "tui",
        cwd: tempDir,
        model: { input: ["text", "image"] },
        isIdle: () => false, // Pi is busy!
        sessionManager: {
          getSessionId: () => "sess-busy-media",
          getEntries: () => [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: "sess-busy-media", chatId: testConfig.chatId, threadId: 50 } }],
          getSessionFile: () => `${tempDir}/sess.jsonl`,
        },
        ui: { notify: vi.fn() },
      } as unknown as ExtensionContext;

      const runtime = new MuxRuntime(mockPi as unknown as ExtensionAPI, tempDir);
      await runtime.onSessionStart(mockCtx);

      // Start an active run so currentRun !== null
      await runtime.onBeforeAgentStart({ prompt: "Initial prompt" }, mockCtx);

      const media: InboundMedia = {
        path: testImagePath,
        mimeType: "image/png",
      };

      const result = await runtime.handleInboundText("Followup with diagram", mockCtx, 104, "followUp", media);

      expect(result.accepted).toBe(true);
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "Telegram",
          content: [
            { type: "text", text: "[Image#1]\n\nFollowup with diagram" },
            { type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" },
          ],
        }),
        { triggerTurn: true, deliverAs: "followUp" }
      );

      expect(await fs.readFile(testImagePath)).toEqual(imageBytes);
    });
  });
});

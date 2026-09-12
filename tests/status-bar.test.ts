import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import {
  formatStatus,
  getTgStatusText,
  MuxRuntime,
  TG_STATUS_KEY,
  type TgStatusInfo,
} from "../src/runtime.js";
import type { MuxConfig } from "../src/types.js";

describe("Status Bar module", () => {
  const mockConfig: MuxConfig = {
    version: 1,
    botToken: "mock-token",
    chatId: -100123456,
    allowedUserId: 112233,
  };

  describe("getTgStatusText", () => {
    it.each([
      {
        name: "unconfigured status when config is missing",
        options: { config: null, isReconnecting: false, isConflict: false, hasActiveTransport: false, bindingState: "unbound", threadId: null },
        expected: { text: "tg: unconfigured", color: "dim" },
      },
      {
        name: "reconnecting status when isReconnecting is true",
        options: { config: mockConfig, isReconnecting: true, isConflict: false, hasActiveTransport: false, bindingState: "bound", threadId: 101 },
        expected: { text: "tg: reconnecting", color: "muted" },
      },
      {
        name: "conflict status when 409 conflict is detected",
        options: { config: mockConfig, isReconnecting: false, isConflict: true, hasActiveTransport: true, bindingState: "bound", threadId: 101 },
        expected: { text: "tg: conflict (409)", color: "muted" },
      },
      {
        name: "offline status when active transport is unavailable",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: false, bindingState: "bound", threadId: 101 },
        expected: { text: "tg: offline", color: "muted" },
      },
      {
        name: "connected status with shortId when bound",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "bound", threadId: 101, shortId: "a1b2c3" },
        expected: { text: "tg: connected (a1b2c3)", color: "muted" },
      },
      {
        name: "connected status with threadId fallback when bound and shortId missing",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "bound", threadId: 101 },
        expected: { text: "tg: connected (#101)", color: "muted" },
      },
      {
        name: "connected status without threadId when bound but threadId is null",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "bound", threadId: null },
        expected: { text: "tg: connected", color: "muted" },
      },
      {
        name: "ready status when transport is active and state is unbound (blank session ready for first prompt)",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "unbound", threadId: null },
        expected: { text: "tg: ready", color: "dim" },
      },
      {
        name: "disconnected status when state is disconnected",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "disconnected", threadId: null },
        expected: { text: "tg: disconnected", color: "dim" },
      },
      {
        name: "topic deleted status when state is topic-missing",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "topic-missing", threadId: null },
        expected: { text: "tg: topic deleted", color: "dim" },
      },
      {
        name: "error status when state is create-unknown",
        options: { config: mockConfig, isReconnecting: false, isConflict: false, hasActiveTransport: true, bindingState: "create-unknown", threadId: null },
        expected: { text: "tg: error", color: "muted" },
      },
    ] as { name: string; options: Parameters<typeof getTgStatusText>[0]; expected: TgStatusInfo }[])("returns $name", ({ options, expected }) => {
      expect(getTgStatusText(options)).toEqual(expected);
    });
  });

  describe("formatStatus", () => {
    it("applies theme color when theme fg function is present", () => {
      const mockTheme = {
        fg: vi.fn((color, text) => `[${color}]${text}[/${color}]`),
      };
      const result = formatStatus("tg: connected (#101)", "muted", mockTheme);
      expect(mockTheme.fg).toHaveBeenCalledWith("muted", "tg: connected (#101)");
      expect(result).toBe("[muted]tg: connected (#101)[/muted]");
    });

    it("returns raw text when theme is undefined or lacks fg function", () => {
      expect(formatStatus("tg: unconfigured", "dim")).toBe("tg: unconfigured");
      expect(formatStatus("tg: unconfigured", "dim", {} as any)).toBe("tg: unconfigured");
    });
  });

  describe("MuxRuntime Status Bar Integration", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-statusbar-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("does not set status in non-TUI mode", async () => {
      const setStatus = vi.fn();
      const mockCtx = {
        mode: "print",
        sessionManager: {
          getSessionId: () => "sess-1",
          getEntries: () => [],
        },
        ui: { setStatus },
      } as any;

      const runtime = new MuxRuntime({} as any, tempDir);
      await runtime.onSessionStart(mockCtx);
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("sets status to 'tg: unconfigured' when config is not present in TUI mode", async () => {
      const setStatus = vi.fn();
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-1",
          getEntries: () => [],
        },
        ui: { setStatus },
      } as any;

      const runtime = new MuxRuntime({} as any, tempDir);
      await runtime.onSessionStart(mockCtx);
      expect(setStatus).toHaveBeenCalledWith(TG_STATUS_KEY, "tg: unconfigured");
    });

    it("sets status to 'tg: ready' when config is present and blank session is ready", async () => {
      await saveConfig(tempDir, mockConfig);
      const setStatus = vi.fn();
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-1",
          getEntries: () => [],
          getSessionFile: () => "/tmp/sess.jsonl",
        },
        ui: { setStatus },
      } as any;

      const runtime = new MuxRuntime({} as any, tempDir);
      await runtime.onSessionStart(mockCtx);
      expect(setStatus).toHaveBeenCalledWith(TG_STATUS_KEY, "tg: ready");
      await runtime.onSessionShutdown(mockCtx);
    });

    it("sets status to 'tg: connected (a1b2c3)' when session has bound topic entry", async () => {
      await saveConfig(tempDir, mockConfig);
      const setStatus = vi.fn();
      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-123-a1b2c3",
          getEntries: () => [
            {
              type: "custom",
              customType: "pi-telegram-mux.binding",
              data: {
                version: 1,
                sessionId: "sess-123-a1b2c3",
                chatId: mockConfig.chatId,
                threadId: 123,
              },
            },
          ],
          getSessionFile: () => "/tmp/sess.jsonl",
        },
        ui: { setStatus },
      } as any;

      const runtime = new MuxRuntime({} as any, tempDir);
      await runtime.onSessionStart(mockCtx);
      expect(setStatus).toHaveBeenCalledWith(TG_STATUS_KEY, "tg: connected (a1b2c3)");
      await runtime.onSessionShutdown(mockCtx);
    });

    it("updates status bar when disconnected and reconnected", async () => {
      await saveConfig(tempDir, mockConfig);
      const entries: unknown[] = [
        {
          type: "custom",
          customType: "pi-telegram-mux.binding",
          data: {
            version: 1,
            sessionId: "sess-test-a1b2c3",
            chatId: mockConfig.chatId,
            threadId: 555,
          },
        },
      ];

      const setStatus = vi.fn();
      const mockPi = {
        appendEntry: vi.fn((customType: string, data: any) => {
          entries.push({ type: "custom", customType, data });
        }),
      } as any;

      const mockCtx = {
        mode: "tui",
        sessionManager: {
          getSessionId: () => "sess-test-a1b2c3",
          getEntries: () => entries,
          getSessionFile: () => "/tmp/sess.jsonl",
        },
        ui: {
          setStatus,
          notify: vi.fn(),
          confirm: vi.fn().mockResolvedValue(true),
        },
      } as any;

      const runtime = new MuxRuntime(mockPi, tempDir);
      await runtime.onSessionStart(mockCtx);
      expect(setStatus).toHaveBeenLastCalledWith(TG_STATUS_KEY, "tg: connected (a1b2c3)");

      // Disconnect
      runtime.handleTgDisconnect(mockCtx);
      expect(setStatus).toHaveBeenLastCalledWith(TG_STATUS_KEY, "tg: disconnected");

      // Reconnect restores last valid thread 555
      await runtime.handleTgConnect(mockCtx);
      expect(setStatus).toHaveBeenLastCalledWith(TG_STATUS_KEY, "tg: connected (a1b2c3)");

      // Switch session clears status
      runtime.onSessionBeforeSwitch(mockCtx);
      expect(setStatus).toHaveBeenLastCalledWith(TG_STATUS_KEY, undefined);

      // Shutdown clears status
      await runtime.onSessionShutdown(mockCtx);
      expect(setStatus).toHaveBeenLastCalledWith(TG_STATUS_KEY, undefined);
    });
  });
});

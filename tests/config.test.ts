import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigDir,
  getConfigPath,
  getRuntimeDir,
  loadConfig,
  saveConfig,
  validateConfig,
} from "../src/config.js";
import type { MuxConfig } from "../src/types.js";

describe("config module", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("computes correct paths", () => {
    expect(getConfigDir(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux"));
    expect(getConfigPath(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux", "config.json"));
    expect(getRuntimeDir(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux", "runtime"));
  });

  describe("validateConfig", () => {
    it("validates a correct config", () => {
      const input = {
        version: 1,
        botToken: "123456:ABC-DEF",
        chatId: -1001234567890,
        allowedUserId: 987654321,
      };
      const result = validateConfig({ ...input, botToken: `  ${input.botToken}  ` });
      expect(result).toEqual(input);
    });

    it("rejects invalid versions", () => {
      expect(() => validateConfig({ version: 2, botToken: "x", chatId: 1, allowedUserId: 1 })).toThrow(
        "Invalid config version"
      );
    });

    it("rejects non-object or null", () => {
      expect(() => validateConfig(null)).toThrow("Invalid config");
      expect(() => validateConfig("string")).toThrow("Invalid config");
    });

    it("rejects empty or missing botToken", () => {
      expect(() => validateConfig({ version: 1, botToken: "", chatId: 1, allowedUserId: 1 })).toThrow(
        "botToken must be a non-empty string"
      );
      expect(() => validateConfig({ version: 1, chatId: 1, allowedUserId: 1 })).toThrow(
        "botToken must be a non-empty string"
      );
    });

    it("rejects non-integer chatId", () => {
      expect(() => validateConfig({ version: 1, botToken: "x", chatId: "1", allowedUserId: 1 })).toThrow(
        "chatId must be a safe integer"
      );
      expect(() => validateConfig({ version: 1, botToken: "x", chatId: 1.5, allowedUserId: 1 })).toThrow(
        "chatId must be a safe integer"
      );
    });

    it("rejects non-positive or non-integer allowedUserId", () => {
      expect(() => validateConfig({ version: 1, botToken: "x", chatId: 1, allowedUserId: 0 })).toThrow(
        "allowedUserId must be a positive safe integer"
      );
      expect(() => validateConfig({ version: 1, botToken: "x", chatId: 1, allowedUserId: -5 })).toThrow(
        "allowedUserId must be a positive safe integer"
      );
    });

    it("strips unexpected fields from persistence", () => {
      const input = {
        version: 1,
        botToken: "x",
        chatId: 1,
        allowedUserId: 1,
        topics: [1, 2, 3],
        offset: 123,
      };
      const result = validateConfig(input) as Record<string, unknown>;
      expect(result.topics).toBeUndefined();
      expect(result.offset).toBeUndefined();
    });
  });

  describe("loadConfig and saveConfig", () => {
    it("returns null when config file does not exist", async () => {
      const loaded = await loadConfig(tempDir);
      expect(loaded).toBeNull();
    });

    it("saves and loads configuration successfully", async () => {
      const config: MuxConfig = {
        version: 1,
        botToken: "123456:TOKEN",
        chatId: -100987654321,
        allowedUserId: 12345,
      };

      await saveConfig(tempDir, config);
      const loaded = await loadConfig(tempDir);
      expect(loaded).toEqual(config);
    });
  });
});

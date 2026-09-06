import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configFingerprint,
  getConfigDir,
  getConfigPath,
  getRuntimeDir,
  loadConfig,
  loadConfigSync,
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
      expect(result).toEqual({ ...input, autoCloseTopics: false });
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

    it.each([null, "false", "true", 0, 1, [], {}])("rejects invalid autoCloseTopics: %j", autoCloseTopics => {
      expect(() => validateConfig({ version: 1, botToken: "x", chatId: 1, allowedUserId: 1, autoCloseTopics })).toThrow(
        "autoCloseTopics must be a boolean"
      );
    });

    it("includes the effective auto-close setting in the configuration fingerprint", () => {
      const config: MuxConfig = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      expect(configFingerprint(config)).toBe(configFingerprint({ ...config, autoCloseTopics: false }));
      expect(configFingerprint(config)).not.toBe(configFingerprint({ ...config, autoCloseTopics: true }));
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

    it.each([false, true])("saves and loads configuration with autoCloseTopics=%s", async autoCloseTopics => {
      const config: MuxConfig = {
        version: 1,
        botToken: "123456:TOKEN",
        chatId: -100987654321,
        allowedUserId: 12345,
        autoCloseTopics,
      };

      await saveConfig(tempDir, config);
      const loaded = await loadConfig(tempDir);
      expect(loaded).toEqual(config);
      expect(loadConfigSync(tempDir)).toEqual(config);
      expect(JSON.parse(await fs.readFile(getConfigPath(tempDir), "utf-8"))).toEqual(config);
    });

    it("loads legacy configuration with automatic topic closure disabled", async () => {
      const legacy = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(getConfigPath(tempDir), JSON.stringify(legacy));
      expect(await loadConfig(tempDir)).toEqual({ ...legacy, autoCloseTopics: false });
      expect(loadConfigSync(tempDir)).toEqual({ ...legacy, autoCloseTopics: false });
    });

    it.each([
      { name: "malformed JSON", content: "{", autoCloseTopics: false },
      { name: "invalid Chat ID", content: '{"version":1,"botToken":"old","chatId":"bad","allowedUserId":1,"autoCloseTopics":true}', autoCloseTopics: true },
      { name: "missing connection fields", content: '{"version":1,"autoCloseTopics":true}', autoCloseTopics: true },
      { name: "invalid preference", content: '{"version":1,"botToken":"old","chatId":1,"allowedUserId":1,"autoCloseTopics":"ON"}', autoCloseTopics: false },
      { name: "unsupported version", content: '{"version":2,"botToken":"old","chatId":1,"allowedUserId":1,"autoCloseTopics":true}', autoCloseTopics: true },
      { name: "null", content: "null", autoCloseTopics: false },
      { name: "array", content: "[]", autoCloseTopics: false },
    ])("rebuilds $name only with a complete connection update", async ({ content, autoCloseTopics }) => {
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(getConfigPath(tempDir), content);
      await expect(loadConfig(tempDir)).rejects.toThrow();
      const updates = { botToken: "replacement-token", chatId: -100555, allowedUserId: 555 };
      expect(await loadConfig(tempDir, updates)).toEqual({ version: 1, ...updates, autoCloseTopics });
      expect(await fs.readFile(getConfigPath(tempDir), "utf-8")).toBe(content);
    });

    it("merges a preference update before validating that saved field", async () => {
      const connection = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(getConfigPath(tempDir), JSON.stringify({ ...connection, autoCloseTopics: "bad" }));
      expect(await loadConfig(tempDir, { autoCloseTopics: true })).toEqual({ ...connection, autoCloseTopics: true });
      await expect(loadConfig(tempDir)).rejects.toThrow("autoCloseTopics must be a boolean");
    });

    it.each([{ autoCloseTopics: "ON" }, { autoCloseTopics: null }, { version: 2 }])("rejects explicitly supplied invalid updates: %j", async invalid => {
      const connection = { botToken: "x", chatId: 1, allowedUserId: 1 };
      await saveConfig(tempDir, { version: 1, ...connection });
      await expect(loadConfig(tempDir, { ...connection, ...invalid } as unknown as Partial<MuxConfig>)).rejects.toThrow("Invalid config");
    });

    it.each([{ autoCloseTopics: true }, { botToken: "replacement-token" }])("does not rebuild malformed JSON from an incomplete update: %j", async updates => {
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(getConfigPath(tempDir), "{");
      await expect(loadConfig(tempDir, updates)).rejects.toBeInstanceOf(SyntaxError);
    });

    it("propagates file read failures even with a complete connection update", async () => {
      await fs.mkdir(getConfigPath(tempDir), { recursive: true });
      await expect(loadConfig(tempDir, { botToken: "x", chatId: 1, allowedUserId: 1 })).rejects.toMatchObject({ code: expect.any(String) });
    });
  });
});

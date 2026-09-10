import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configFingerprint,
  getConfigDir,
  getConfigPath,
  getMediaDir,
  getRuntimeDir,
  loadConfig,
  loadConfigSync,
  saveConfig,
  validateConfig,
  withConfigLock,
} from "../src/config.js";
import type { MuxConfig } from "../src/types.js";
import * as processIdentity from "../src/process-identity.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

describe("config module", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tg-mux-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("computes correct paths", () => {
    expect(getConfigDir(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux"));
    expect(getConfigPath(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux", "config.json"));
    expect(getRuntimeDir(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux", "runtime"));
    expect(getMediaDir(tempDir)).toBe(path.join(tempDir, "pi-telegram-mux", "media"));
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

    it.each([null, "false", "true", 0, 1, [], {}, "invalid", "follow_up", "steering"])("rejects invalid inputMode: %j", inputMode => {
      expect(() => validateConfig({ version: 1, botToken: "x", chatId: 1, allowedUserId: 1, inputMode })).toThrow(
        "inputMode must be 'followUp' or 'steer'"
      );
    });

    it("includes the effective auto-close setting in the configuration fingerprint", () => {
      const config: MuxConfig = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      expect(configFingerprint(config)).toBe(configFingerprint({ ...config, autoCloseTopics: false }));
      expect(configFingerprint(config)).not.toBe(configFingerprint({ ...config, autoCloseTopics: true }));
    });

    it("includes the effective input-mode setting in the configuration fingerprint", () => {
      const config: MuxConfig = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      expect(configFingerprint(config)).toBe(configFingerprint({ ...config, inputMode: "followUp" }));
      expect(configFingerprint(config)).not.toBe(configFingerprint({ ...config, inputMode: "steer" }));
    });

    it("excludes input mode and revision from the connection fingerprint", () => {
      const config: MuxConfig = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      expect(configFingerprint(config, "connection")).toBe(configFingerprint({ ...config, inputMode: "steer", inputModeRevision: 10 }, "connection"));
      for (const changes of [{ botToken: "y" }, { chatId: 2 }, { allowedUserId: 2 }, { autoCloseTopics: true }]) {
        expect(configFingerprint(config, "connection")).not.toBe(configFingerprint({ ...config, ...changes }, "connection"));
      }
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

    it.each(["followUp", "steer"] as const)("saves and loads configuration with inputMode=%s", async inputMode => {
      const config: MuxConfig = {
        version: 1,
        botToken: "123456:TOKEN",
        chatId: -100987654321,
        allowedUserId: 12345,
        inputMode,
      };

      await saveConfig(tempDir, config, { modeUpdate: true });
      const loaded = await loadConfig(tempDir);
      expect(loaded).toEqual({ ...config, autoCloseTopics: false, inputModeRevision: 1 });
      expect(loadConfigSync(tempDir)).toEqual({ ...config, autoCloseTopics: false, inputModeRevision: 1 });
      expect(JSON.parse(await fs.readFile(getConfigPath(tempDir), "utf-8"))).toEqual({ ...config, autoCloseTopics: false, inputModeRevision: 1 });
    });

    it("merges selected settings after acquiring the lock without restoring a stale connection or mode", async () => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, inputMode: "followUp" };
      await saveConfig(tempDir, initial);
      const latest: MuxConfig = { ...initial, botToken: "new-tok", chatId: 20, allowedUserId: 2, inputMode: "steer", inputModeRevision: 2 };
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const holding = withConfigLock(tempDir, async () => {
        enter();
        await gate;
        await fs.writeFile(getConfigPath(tempDir), JSON.stringify(latest));
      });
      await entered;
      const updating = saveConfig(tempDir, { updates: { autoCloseTopics: true } });
      try {
        await vi.waitFor(async () => {
          expect((await fs.readdir(path.join(getConfigDir(tempDir), "config-mutex"))).filter(file => file.endsWith(".json"))).toHaveLength(2);
        });
        release();
        await holding;
        expect(await updating).toEqual({ ...latest, autoCloseTopics: true });
        expect(await loadConfig(tempDir)).toEqual({ ...latest, autoCloseTopics: true });
      } finally { release(); await holding; await updating.catch(() => {}); }
    });

    it("merges connection updates without resetting current preferences", async () => {
      const initial = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, autoCloseTopics: true, inputMode: "steer", inputModeRevision: 5 } as const;
      await saveConfig(tempDir, initial);
      const connection = { botToken: "new-tok", chatId: 20, allowedUserId: 2 };
      expect(await saveConfig(tempDir, { updates: connection })).toEqual({ ...initial, ...connection });
      expect(await loadConfig(tempDir)).toEqual({ ...initial, ...connection });
    });

    it("does not create missing configuration from a preference update", async () => {
      await expect(saveConfig(tempDir, { updates: { autoCloseTopics: true } })).rejects.toThrow();
      await expect(fs.access(getConfigPath(tempDir))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(path.join(getConfigDir(tempDir), "config-mutex"))).toEqual([]);
    });

    it.each(["EACCES", "EIO"])("does not overwrite configuration when reading a settings update fails with %s", async code => {
      await saveConfig(tempDir, { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 });
      const configPath = getConfigPath(tempDir);
      const read = fs.readFile;
      const before = await read(configPath, "utf8");
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) === configPath) throw Object.assign(new Error("Read failed"), { code });
        return read(...args);
      });
      await expect(saveConfig(tempDir, { updates: { autoCloseTopics: true } })).rejects.toMatchObject({ code });
      expect(await read(configPath, "utf8")).toBe(before);
      expect(await fs.readdir(path.join(getConfigDir(tempDir), "config-mutex"))).toEqual([]);
    });

    it("allocates one reconciliation revision for concurrent observers of a manual edit", async () => {
      const config: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, inputMode: "followUp" };
      const initial = await saveConfig(tempDir, config);
      const results = await Promise.all(Array.from({ length: 4 }, () => saveConfig(tempDir, initial, {
        expectedBase: initial,
        reconcileInputMode: { mode: "steer", revision: 1 },
      })));
      expect(results.map(result => result.inputModeRevision)).toEqual([2, 2, 2, 2]);
      expect((await loadConfig(tempDir))?.inputMode).toBe("followUp");
      expect((await loadConfig(tempDir))?.inputModeRevision).toBe(2);
    });

    it("rejects saveConfig when connection settings change during check-and-replace", async () => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 };
      await saveConfig(tempDir, initial);
      const configPath = getConfigPath(tempDir);

      await expect(saveConfig(tempDir, { ...initial, inputMode: "steer" }, {
        expectedBase: initial,
        onChecked: async () => {
          await fs.writeFile(configPath, JSON.stringify({ ...initial, chatId: 99 }, null, 2) + "\n");
        },
      })).rejects.toThrow("Connection configuration was modified concurrently on disk");

      const disk = await loadConfig(tempDir);
      expect(disk?.chatId).toBe(99);
    });

    it.each(["EACCES", "EPERM", "EIO"])("does not overwrite a newer mode after a configuration read fails with %s", async code => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, inputMode: "followUp" };
      await saveConfig(tempDir, initial);
      const stale = (await loadConfig(tempDir, { autoCloseTopics: true }))!;
      await saveConfig(tempDir, { ...stale, inputMode: "steer" }, { modeUpdate: true });
      const configPath = getConfigPath(tempDir);
      const before = await fs.readFile(configPath, "utf8");
      const read = fs.readFile;
      let injected = false;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (!injected && String(args[0]) === configPath) {
          injected = true;
          throw Object.assign(new Error("Simulated configuration read failure"), { code });
        }
        return read(...args);
      });
      await expect(saveConfig(tempDir, stale)).rejects.toMatchObject({ code });
      expect(await read(configPath, "utf8")).toBe(before);
    });

    it.each(["before check", "after check"])("rejects removal of the expected configuration %s", async phase => {
      const base = await saveConfig(tempDir, { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 });
      const configPath = getConfigPath(tempDir);
      if (phase === "before check") await fs.rm(configPath);
      await expect(saveConfig(tempDir, { ...base, inputMode: "steer" }, {
        expectedBase: base, modeUpdate: true,
        onChecked: phase === "after check" ? () => fs.rm(configPath) : undefined,
      })).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(getConfigDir(tempDir))).filter(file => file.endsWith(".tmp"))).toEqual([]);
      expect(await fs.readdir(path.join(getConfigDir(tempDir), "config-mutex"))).toEqual([]);
    });

    it.each(["choosing", "waiting"])("reclaims a %s claim after its PID has been reused", async phase => {
      const identity = await processIdentity.getProcessIdentity(process.pid);
      expect(identity).toMatch(/^[a-f\d]{64}$/);
      const previousIdentity = identity === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
      const mutexDir = path.join(getConfigDir(tempDir), "config-mutex");
      await fs.mkdir(mutexDir, { recursive: true });
      const claim = path.join(mutexDir, `${process.pid}-${previousIdentity}-00000000-0000-0000-0000-000000000001.json`);
      await fs.writeFile(claim, phase === "choosing" ? "" : "7");
      const action = vi.fn();
      await withConfigLock(tempDir, action);
      expect(action).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(mutexDir)).toEqual([]);
    });

    it("retains an identified live holder until it releases the critical section", async () => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const holding = withConfigLock(tempDir, async () => { enter(); await gate; });
      await entered;
      const mutexDir = path.join(getConfigDir(tempDir), "config-mutex");
      const [owner] = await fs.readdir(mutexDir);
      expect(owner).toMatch(/^\d+-[a-f\d]{64}-/);
      const action = vi.fn();
      const waiting = withConfigLock(tempDir, action);
      try {
        await vi.waitFor(async () => expect((await fs.readdir(mutexDir)).filter(file => file.endsWith(".json"))).toHaveLength(2));
        expect(action).not.toHaveBeenCalled();
      } finally { release(); await holding; await waiting; }
      expect(action).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(mutexDir)).toEqual([]);
    });

    it("does not reclaim a live PID when its process identity cannot be queried", async () => {
      const mutexDir = path.join(getConfigDir(tempDir), "config-mutex");
      await fs.mkdir(mutexDir, { recursive: true });
      const holder = path.join(mutexDir, `${process.ppid}-${"a".repeat(64)}-00000000-0000-0000-0000-000000000001.json`);
      await fs.writeFile(holder, "1");
      const query = processIdentity.getProcessIdentity;
      vi.spyOn(processIdentity, "getProcessIdentity").mockImplementation(pid => pid === process.ppid ? Promise.resolve(undefined) : query(pid));
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const read = fs.readFile;
      let reads = 0;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) === holder && ++reads > 1) now += 10001;
        return read(...args);
      });
      await expect(withConfigLock(tempDir, async () => {})).rejects.toThrow("waiting for a live process");
      expect(await fs.readdir(mutexDir)).toEqual([path.basename(holder)]);
    });

    it("serializes simultaneous saveConfig calls without corrupting configuration", async () => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 };
      await saveConfig(tempDir, initial);

      // Run 5 simultaneous saves with different modes
      const promises = Array.from({ length: 5 }, (_, i) =>
        saveConfig(tempDir, { ...initial, inputMode: i % 2 === 0 ? "steer" : "followUp" }, { modeUpdate: true })
      );
      const results = await Promise.all(promises);

      // Every save returned a valid config and allocated monotonic revisions
      for (const res of results) {
        expect(res.inputModeRevision).toBeGreaterThanOrEqual(1);
      }
      const loaded = await loadConfig(tempDir);
      expect(loaded?.version).toBe(1);
      expect(loaded?.chatId).toBe(10);
      expect(loaded?.inputModeRevision).toBe(5);
    });

    it.each([
      ["choosing", "EPERM"], ["choosing", "EACCES"], ["choosing", "EBUSY"],
      ["waiting", "EPERM"], ["waiting", "EACCES"], ["waiting", "EBUSY"],
    ])("retries a %s sharing violation (%s) without bypassing a live lock owner", async (phase, code) => {
      const mutexDir = path.join(getConfigDir(tempDir), "config-mutex");
      await fs.mkdir(mutexDir, { recursive: true });
      const holder = path.join(mutexDir, `${process.pid}-00000000-0000-0000-0000-000000000001.json`);
      await fs.writeFile(holder, "7");
      const readFile = fs.readFile;
      let reads = 0;
      const read = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) === holder && ++reads === (phase === "choosing" ? 1 : 2)) {
          throw Object.assign(new Error("Sharing violation"), { code });
        }
        return readFile(...args);
      });
      let entered = false;
      let failure: unknown;
      const acquiring = withConfigLock(tempDir, async () => { entered = true; }).catch(error => { failure = error; });
      try {
        await vi.waitFor(() => { expect(failure).toBeUndefined(); expect(reads).toBeGreaterThanOrEqual(3); });
        expect(entered).toBe(false);
        const claim = (await fs.readdir(mutexDir)).find(file => file.endsWith(".json") && file !== path.basename(holder))!;
        expect(Number(await readFile(path.join(mutexDir, claim), "utf-8"))).toBe(8);
        await fs.rm(holder);
        await acquiring;
        expect(failure).toBeUndefined();
        expect(entered).toBe(true);
        expect(await fs.readdir(mutexDir)).toEqual([]);
      } finally {
        read.mockRestore();
        await fs.rm(holder, { force: true });
        await acquiring;
      }
    });

    it.each(["choosing", "waiting"])("bounds persistent sharing violations during %s and removes its claim", async phase => {
      const mutexDir = path.join(getConfigDir(tempDir), "config-mutex");
      await fs.mkdir(mutexDir, { recursive: true });
      const holder = path.join(mutexDir, `${process.pid}-00000000-0000-0000-0000-000000000001.json`);
      await fs.writeFile(holder, "7");
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const readFile = fs.readFile;
      let reads = 0;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) === holder && ++reads >= (phase === "choosing" ? 1 : 2)) {
          now += 5001;
          throw Object.assign(new Error("Sharing violation"), { code: "EPERM" });
        }
        return readFile(...args);
      });
      const action = vi.fn();
      await expect(withConfigLock(tempDir, action)).rejects.toThrow(/Config mutex.*retry later/);
      expect(action).not.toHaveBeenCalled();
      expect(reads).toBeLessThanOrEqual(3);
      expect(await fs.readdir(mutexDir)).toEqual([path.basename(holder)]);
    });

    it("does not retry unrelated I/O errors while acquiring the configuration mutex", async () => {
      vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("I/O failure"), { code: "EIO" }));
      const action = vi.fn();
      await expect(withConfigLock(tempDir, action)).rejects.toMatchObject({ code: "EIO" });
      expect(action).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(getConfigDir(tempDir), "config-mutex"))).toEqual([]);
    });

    it("allocates monotonic revisions whether caller is ahead or disk is ahead", async () => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 };
      const first = await saveConfig(tempDir, { ...initial, inputMode: "steer" }, { modeUpdate: true });
      expect(first.inputModeRevision).toBe(1);

      // Disk is at 1, caller supplies stale revision 0: allocates 2
      const second = await saveConfig(tempDir, { ...initial, inputMode: "followUp", inputModeRevision: 0 }, { modeUpdate: true });
      expect(second.inputModeRevision).toBe(2);

      // Caller is ahead at revision 10: allocates 11
      const third = await saveConfig(tempDir, { ...initial, inputMode: "steer", inputModeRevision: 10 }, { modeUpdate: true });
      expect(third.inputModeRevision).toBe(11);
    });

    it("preserves existing inputMode and revision when an unrelated save supplies a legacy-shaped config", async () => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 };
      await saveConfig(tempDir, { ...initial, inputMode: "steer" }, { modeUpdate: true });
      const diskBefore = await loadConfig(tempDir);
      expect(diskBefore?.inputMode).toBe("steer");
      expect(diskBefore?.inputModeRevision).toBe(1);

      // An unrelated save (e.g. from connection setup) passes a config without modeUpdate
      const updatedConnection: MuxConfig = { version: 1, botToken: "new-tok", chatId: 20, allowedUserId: 2 };
      await saveConfig(tempDir, updatedConnection);

      const diskAfter = await loadConfig(tempDir);
      expect(diskAfter?.botToken).toBe("new-tok");
      expect(diskAfter?.chatId).toBe(20);
      expect(diskAfter?.inputMode).toBe("steer");
      expect(diskAfter?.inputModeRevision).toBe(1);
    });

    it("preserves disk inputMode without revision when unrelated save occurs", async () => {
      const configPath = getConfigPath(tempDir);
      const legacyMode = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, inputMode: "steer" };
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(legacyMode, null, 2) + "\n");

      // An unrelated save passes connection updates without mode
      await saveConfig(tempDir, { version: 1, botToken: "new-tok", chatId: 20, allowedUserId: 2 });

      const loaded = await loadConfig(tempDir);
      expect(loaded?.chatId).toBe(20);
      expect(loaded?.inputMode).toBe("steer");
      expect(loaded?.inputModeRevision).toBeUndefined();
    });

    it("preserves disk inputModeRevision without mode when unrelated save occurs", async () => {
      const configPath = getConfigPath(tempDir);
      const revisionOnly = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, inputModeRevision: 5 };
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(revisionOnly, null, 2) + "\n");

      // An unrelated save passes connection updates without mode
      await saveConfig(tempDir, { version: 1, botToken: "new-tok", chatId: 20, allowedUserId: 2 });

      const loaded = await loadConfig(tempDir);
      expect(loaded?.chatId).toBe(20);
      expect(loaded?.inputMode).toBeUndefined();
      expect(loaded?.inputModeRevision).toBe(5);
    });

    it("reclaims dead-process bakery mutex claims without removing live claims and prevents overlapping transactions", async () => {
      const initial: MuxConfig = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1 };
      const mutexDir = path.join(getConfigDir(tempDir), "config-mutex");
      await fs.mkdir(mutexDir, { recursive: true });

      // Simulate a dead process claim file (PID 999999)
      const deadClaim = path.join(mutexDir, "999999-00000000-0000-0000-0000-000000000000.json");
      await fs.writeFile(deadClaim, "1");

      // Simulate a competing LIVE claim file belonging to current process (PID process.pid) with ticket 1
      const liveClaimId = `${process.pid}-00000000-0000-0000-0000-000000000001.json`;
      const liveClaim = path.join(mutexDir, liveClaimId);
      await fs.writeFile(liveClaim, "1");

      // Start saveConfig: it should clean up the dead claim, but MUST wait for the live claim
      let saveStarted = false;
      const savePromise = saveConfig(tempDir, { ...initial, inputMode: "steer" }, { modeUpdate: true }).then(res => {
        saveStarted = true;
        return res;
      });

      // Allow bakery scan to run and clean up dead claims
      let filesMid: string[] = [];
      await vi.waitFor(async () => {
        filesMid = await fs.readdir(mutexDir);
        expect(filesMid.includes("999999-00000000-0000-0000-0000-000000000000.json")).toBe(false);
      });
      expect(saveStarted).toBe(false);
      expect(filesMid.includes(liveClaimId)).toBe(true);

      // Now release the live claim
      await fs.rm(liveClaim, { force: true });

      // saveConfig should now proceed and complete
      const saved = await savePromise;
      expect(saved.inputMode).toBe("steer");
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

    it.each([0, -1, null, "2", 1.5, Number.MAX_SAFE_INTEGER + 1])("repairs an invalid stored input-mode revision only with a complete connection update: %j", async inputModeRevision => {
      const stored = { version: 1, botToken: "tok", chatId: 10, allowedUserId: 1, inputMode: "steer", inputModeRevision };
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      const content = JSON.stringify(stored);
      await fs.writeFile(getConfigPath(tempDir), content);
      await expect(loadConfig(tempDir)).rejects.toThrow("inputModeRevision must be a positive safe integer");
      await expect(saveConfig(tempDir, { updates: { autoCloseTopics: true } })).rejects.toThrow("inputModeRevision must be a positive safe integer");
      expect(await fs.readFile(getConfigPath(tempDir), "utf8")).toBe(content);
      const connection = { botToken: "new-tok", chatId: 20, allowedUserId: 2 };
      expect(await loadConfig(tempDir, connection)).toEqual({ version: 1, ...connection, autoCloseTopics: false, inputMode: "steer" });
      const repaired = await saveConfig(tempDir, { updates: connection });
      expect(repaired).toEqual({ version: 1, ...connection, autoCloseTopics: false, inputMode: "steer", inputModeRevision: 1 });
      expect(await loadConfig(tempDir)).toEqual(repaired);
    });

    it("merges a preference update before validating that saved field", async () => {
      const connection = { version: 1, botToken: "x", chatId: 1, allowedUserId: 1 };
      await fs.mkdir(getConfigDir(tempDir), { recursive: true });
      await fs.writeFile(getConfigPath(tempDir), JSON.stringify({ ...connection, autoCloseTopics: "bad" }));
      expect(await loadConfig(tempDir, { autoCloseTopics: true })).toEqual({ ...connection, autoCloseTopics: true });
      await expect(loadConfig(tempDir)).rejects.toThrow("autoCloseTopics must be a boolean");
    });

    it.each([
      { autoCloseTopics: "ON" }, { autoCloseTopics: null }, { version: 2 },
      { inputModeRevision: 0 }, { inputModeRevision: null }, { inputModeRevision: "2" },
      { inputModeRevision: 1.5 }, { inputModeRevision: Number.MAX_SAFE_INTEGER + 1 },
    ])("rejects explicitly supplied invalid updates: %j", async invalid => {
      const connection = { botToken: "x", chatId: 1, allowedUserId: 1 };
      await saveConfig(tempDir, { version: 1, ...connection });
      const updates = { ...connection, ...invalid } as unknown as Partial<MuxConfig>;
      await expect(loadConfig(tempDir, updates)).rejects.toThrow("Invalid config");
      await expect(saveConfig(tempDir, { updates })).rejects.toThrow("Invalid config");
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

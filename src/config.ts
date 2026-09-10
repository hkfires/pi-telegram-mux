import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getProcessIdentity } from "./process-identity.js";
import { MEDIA_STAGING_FILE_PATTERN } from "./media.js";
import type { MuxConfig } from "./types.js";

/**
 * Get directory for pi-telegram-mux configuration.
 */
export function getConfigDir(agentDir: string): string {
  return path.join(agentDir, "pi-telegram-mux");
}

/**
 * Get path to config.json.
 */
export function getConfigPath(agentDir: string): string {
  return path.join(getConfigDir(agentDir), "config.json");
}

/**
 * Get directory for temporary runtime files (Leader lock, IPC sockets).
 */
export function getRuntimeDir(agentDir: string): string {
  return path.join(getConfigDir(agentDir), "runtime");
}

/**
 * Get directory for downloaded images and unfinished staging files.
 */
export function getMediaDir(agentDir: string): string {
  return path.join(getConfigDir(agentDir), "media");
}

/**
 * Ensure media directory exists with restrictive permissions.
 */
export async function ensureMediaDir(agentDir: string): Promise<string> {
  const dir = getMediaDir(agentDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Clean up only stale unfinished staging files (defaults to 1 hour).
 * Completed image paths remain usable until explicitly removed by the user.
 */
export async function cleanupStaleMedia(agentDir: string, maxAgeMs = 3600_000): Promise<void> {
  const dir = getMediaDir(agentDir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !MEDIA_STAGING_FILE_PATTERN.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fs.lstat(fullPath);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(fullPath);
        }
      } catch (error) {
        // The creator may have published or removed this staging file already.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Validate that unknown data matches MuxConfig schema.
 */
export function validateConfig(data: unknown): MuxConfig {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Invalid config: expected a JSON object");
  }

  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(`Invalid config version: expected 1, received ${String(obj.version)}`);
  }

  if (typeof obj.botToken !== "string" || obj.botToken.trim() === "") {
    throw new Error("Invalid config: botToken must be a non-empty string");
  }

  if (typeof obj.chatId !== "number" || !Number.isSafeInteger(obj.chatId)) {
    throw new Error("Invalid config: chatId must be a safe integer");
  }

  if (
    typeof obj.allowedUserId !== "number" ||
    !Number.isSafeInteger(obj.allowedUserId) ||
    obj.allowedUserId <= 0
  ) {
    throw new Error("Invalid config: allowedUserId must be a positive safe integer");
  }

  if (obj.autoCloseTopics !== undefined && typeof obj.autoCloseTopics !== "boolean") {
    throw new Error("Invalid config: autoCloseTopics must be a boolean");
  }

  if (obj.inputMode !== undefined && obj.inputMode !== "followUp" && obj.inputMode !== "steer") {
    throw new Error("Invalid config: inputMode must be 'followUp' or 'steer'");
  }

  if (obj.inputModeRevision !== undefined && (!Number.isSafeInteger(obj.inputModeRevision) || (obj.inputModeRevision as number) <= 0)) {
    throw new Error("Invalid config: inputModeRevision must be a positive safe integer");
  }

  // Strictly return only MuxConfig fields to avoid extra persistence.
  return {
    version: 1,
    botToken: obj.botToken.trim(),
    chatId: obj.chatId,
    allowedUserId: obj.allowedUserId,
    autoCloseTopics: obj.autoCloseTopics ?? false,
    ...(obj.inputMode !== undefined ? { inputMode: obj.inputMode } : {}),
    ...(obj.inputModeRevision !== undefined ? { inputModeRevision: obj.inputModeRevision as number } : {}),
  };
}

/** Compare effective configuration without sending the token over IPC. */
export function configFingerprint(config: MuxConfig, scope: "all" | "connection" = "all"): string {
  return createHash("sha256").update(JSON.stringify([
    config.botToken,
    config.chatId,
    config.allowedUserId,
    config.autoCloseTopics ?? false,
    ...(scope === "all" ? [config.inputMode ?? "followUp", config.inputModeRevision ?? 0] : []),
  ])).digest("hex");
}

/**
 * Load and validate config from disk. Returns null if config file does not exist.
 */
export function loadConfigSync(agentDir: string): MuxConfig | null {
  const configPath = getConfigPath(agentDir);
  try {
    if (!fsSync.existsSync(configPath)) {
      return null;
    }
    const content = fsSync.readFileSync(configPath, "utf-8");
    return validateConfig(JSON.parse(content));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Load configuration and validate it after applying optional settings updates.
 * A complete connection update can rebuild malformed configuration; ordinary
 * loads and updates to individual preferences still require valid connection data.
 */
export async function loadConfig(agentDir: string, updates?: Partial<MuxConfig>): Promise<MuxConfig | null> {
  const configPath = getConfigPath(agentDir);
  const canRebuild = updates?.botToken !== undefined && updates.chatId !== undefined && updates.allowedUserId !== undefined;
  let data: unknown;
  try {
    const content = await fs.readFile(configPath, "utf-8");
    data = JSON.parse(content);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (!updates) return null;
    } else if (!canRebuild || !(err instanceof SyntaxError)) throw err;
  }
  if (updates) {
    const stored = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const merged = { ...stored, ...updates };
    if (canRebuild) {
      if (updates.version === undefined) merged.version = 1;
      if (updates.autoCloseTopics === undefined && typeof merged.autoCloseTopics !== "boolean") merged.autoCloseTopics = false;
      if (updates.inputMode === undefined && merged.inputMode !== "followUp" && merged.inputMode !== "steer") delete merged.inputMode;
      if (updates.inputModeRevision === undefined && (!Number.isSafeInteger(merged.inputModeRevision) || (merged.inputModeRevision ?? 0) <= 0)) delete merged.inputModeRevision;
    }
    data = merged;
  }
  return validateConfig(data);
}

/** Atomic rename with bounded retries for Windows readers holding a sharing lock. */
export async function replaceFile(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (err) {
      if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await delay(25);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireConfigMutex(agentDir: string): Promise<() => Promise<void>> {
  const dir = path.join(getConfigDir(agentDir), "config-mutex");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const identity = await getProcessIdentity(process.pid);
  // Identity belongs in the filename so even an empty choosing claim is identifiable.
  // The hexadecimal component also remains visible to older bakery-lock readers.
  const id = `${process.pid}-${identity ? `${identity}-` : ""}${randomUUID()}.json`;
  const identities = new Map<string, Promise<string | undefined>>();
  const claim = path.join(dir, id);
  const temporary = `${claim}.tmp`;
  await fs.writeFile(claim, "", { flag: "wx", mode: 0o600 });
  try {
    const deadline = Date.now() + 10_000;
    let highest = 0;
    for (;;) {
      highest = 0;
      let retry = false;
      for (const file of await fs.readdir(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const ticket = Number(await fs.readFile(path.join(dir, file), "utf-8"));
          if (Number.isSafeInteger(ticket) && ticket > highest) highest = ticket;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "";
          if (code === "ENOENT") continue;
          if (!["EPERM", "EACCES", "EBUSY"].includes(code)) throw err;
          retry = true;
          break;
        }
      }
      if (!retry) break;
      // Keep the empty choosing claim visible and rescan. Skipping an unreadable
      // ticket could assign a number ahead of an existing lock owner.
      if (Date.now() >= deadline) throw new Error("Config mutex could not read competing claims; retry later");
      await delay(25);
    }
    const ticket = highest + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("Config mutex ticket overflow");
    await fs.writeFile(temporary, String(ticket), { flag: "wx", mode: 0o600 });
    await replaceFile(temporary, claim);
    for (;;) {
      let wait = false;
      for (const file of await fs.readdir(dir)) {
        if (file === id || !/^\d+-[\da-f-]+\.json$/.test(file)) continue;
        const otherPath = path.join(dir, file);
        const pid = Number(file.slice(0, file.indexOf("-")));
        const ownerIdentity = /^\d+-([a-f\d]{64})-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.json$/i.exec(file)?.[1];
        let alive = isProcessAlive(pid);
        if (alive && ownerIdentity) {
          // A reused PID can create a new claim while this acquisition is waiting.
          // Cache by claim so it cannot inherit a previous owner's lookup result.
          let reading = identities.get(file);
          if (!reading) {
            reading = pid === process.pid ? Promise.resolve(identity) : getProcessIdentity(pid);
            identities.set(file, reading);
          }
          const currentIdentity = await reading;
          if (currentIdentity !== undefined && currentIdentity !== ownerIdentity) alive = false;
        }
        // Legacy claims have no start identity: a live PID must remain protected.
        if (!alive) {
          await fs.rm(otherPath, { force: true });
          await fs.rm(`${otherPath}.tmp`, { force: true });
          continue;
        }
        try {
          const other = Number(await fs.readFile(otherPath, "utf-8"));
          if (!Number.isSafeInteger(other) || other <= 0 || other < ticket || (other === ticket && file < id)) wait = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "";
          if (code === "ENOENT") continue;
          if (!["EPERM", "EACCES", "EBUSY"].includes(code)) throw err;
          wait = true;
        }
      }
      if (!wait) break;
      if (Date.now() >= deadline) throw new Error("Config mutex is waiting for a live process; retry later");
      await delay(25);
    }
    return () => fs.rm(claim, { force: true });
  } catch (err) {
    await fs.rm(claim, { force: true });
    throw err;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Exclusive lock helper to serialize configuration check-and-replace transactions across processes. */
export async function withConfigLock<T>(agentDir: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireConfigMutex(agentDir);
  try {
    return await action();
  } finally {
    await release();
  }
}

/**
 * Save config to disk in a secure manner (directory 0700, file 0600).
 * Settings callers supply only selected updates, merged from disk under the lock.
 */
export async function saveConfig(agentDir: string, input: MuxConfig | { updates: Partial<MuxConfig> }, options?: {
  expectedBase?: MuxConfig;
  onChecked?: () => Promise<void> | void;
  modeUpdate?: boolean;
  reconcileInputMode?: { mode: NonNullable<MuxConfig["inputMode"]>; revision: number };
}): Promise<MuxConfig> {
  const dir = getConfigDir(agentDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const configPath = getConfigPath(agentDir);
  return withConfigLock(agentDir, async () => {
    const config = "updates" in input ? await loadConfig(agentDir, input.updates) : input;
    if (!config) throw new Error("Telegram configuration missing during settings update");
    let currentConfig: MuxConfig | null = null;
    try {
      const currentDisk = await fs.readFile(configPath, "utf-8");
      try {
        currentConfig = validateConfig(JSON.parse(currentDisk));
      } catch (parseErr) {
        if (options?.expectedBase) throw parseErr;
      }
      if (options?.expectedBase && currentConfig) {
        const currentAutoClose = currentConfig.autoCloseTopics ?? false;
        const expectedAutoClose = options.expectedBase.autoCloseTopics ?? false;
        if (
          currentConfig.chatId !== options.expectedBase.chatId ||
          currentConfig.botToken !== options.expectedBase.botToken ||
          currentConfig.allowedUserId !== options.expectedBase.allowedUserId ||
          currentAutoClose !== expectedAutoClose
        ) {
          throw new Error("Connection configuration was modified concurrently on disk");
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || options?.expectedBase) throw err;
    }
    if (options?.onChecked) {
      await options.onChecked();
    }
    let configToSave: MuxConfig = { ...config };
    const currentMode = currentConfig?.inputMode;
    const currentRevision = currentConfig?.inputModeRevision;

    if (options?.reconcileInputMode) {
      if (!currentConfig) throw new Error("Telegram configuration missing during input mode reconciliation");
      const peer = options.reconcileInputMode;
      // Read under the same lock as ordinary settings writes. A newer persisted
      // update wins over the stale handshake that initiated reconciliation.
      if ((currentRevision ?? 0) > peer.revision || (currentMode ?? "followUp") === peer.mode) return currentConfig;
      configToSave = {
        ...currentConfig,
        inputMode: currentMode ?? "followUp",
        inputModeRevision: Math.max(currentRevision ?? 0, peer.revision) + 1,
      };
    } else if (options?.modeUpdate === true) {
      if (configToSave.inputMode !== undefined) {
        const baseRev = currentRevision ?? 0;
        configToSave.inputModeRevision = Math.max(baseRev + 1, (configToSave.inputModeRevision ?? 0) + 1);
      }
    } else if (currentConfig !== null) {
      // Unrelated save (setup, connection settings, auto-close): preserve whatever mode and revision exist on disk
      if (currentMode !== undefined) {
        configToSave.inputMode = currentMode;
      } else {
        delete configToSave.inputMode;
      }
      if (currentRevision !== undefined) {
        configToSave.inputModeRevision = currentRevision;
      } else {
        delete configToSave.inputModeRevision;
      }
    } else {
      // First save of a new config: keep caller's mode and assign revision 1 if omitted
      if (configToSave.inputMode !== undefined && configToSave.inputModeRevision === undefined) {
        configToSave.inputModeRevision = 1;
      }
    }
    const validated = validateConfig(configToSave);
    const json = JSON.stringify(validated, null, 2) + "\n";
    const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      if (options?.expectedBase) {
        const currentDisk = await fs.readFile(configPath, "utf-8");
        const recheckConfig = validateConfig(JSON.parse(currentDisk));
        const recheckAutoClose = recheckConfig.autoCloseTopics ?? false;
        const expectedAutoClose = options.expectedBase.autoCloseTopics ?? false;
        if (
          recheckConfig.chatId !== options.expectedBase.chatId ||
          recheckConfig.botToken !== options.expectedBase.botToken ||
          recheckConfig.allowedUserId !== options.expectedBase.allowedUserId ||
          recheckAutoClose !== expectedAutoClose
        ) {
          throw new Error("Connection configuration was modified concurrently on disk");
        }
      }
      await replaceFile(temporaryPath, configPath);
      return validated;
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  });
}

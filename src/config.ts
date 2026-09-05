import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

  // Strictly return only MuxConfig fields to avoid extra persistence.
  return {
    version: 1,
    botToken: obj.botToken.trim(),
    chatId: obj.chatId,
    allowedUserId: obj.allowedUserId,
  };
}

/** Compare effective configuration without sending the token over IPC. */
export function configFingerprint(config: MuxConfig): string {
  return createHash("sha256").update(JSON.stringify([config.botToken, config.chatId, config.allowedUserId])).digest("hex");
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
 * Async load and validate config from disk.
 */
export async function loadConfig(agentDir: string): Promise<MuxConfig | null> {
  const configPath = getConfigPath(agentDir);
  try {
    const content = await fs.readFile(configPath, "utf-8");
    return validateConfig(JSON.parse(content));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
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

/**
 * Save config to disk in a secure manner (directory 0700, file 0600).
 */
export async function saveConfig(agentDir: string, config: MuxConfig): Promise<void> {
  const validated = validateConfig(config);
  const dir = getConfigDir(agentDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const configPath = getConfigPath(agentDir);
  const json = JSON.stringify(validated, null, 2) + "\n";
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    await replaceFile(temporaryPath, configPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

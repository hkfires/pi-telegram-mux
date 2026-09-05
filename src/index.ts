import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MuxRuntime } from "./runtime.js";

export * from "./binding.js";
export * from "./config.js";
export * from "./coordinator.js";
export * from "./ipc.js";
export * from "./pi-compat.js";
export * from "./render.js";
export * from "./runtime.js";
export * from "./telegram.js";
export * from "./types.js";

/**
 * Determine the active Pi agent directory.
 */
export function resolveAgentDir(explicitDir?: string): string {
  // Match Pi 0.85's getAgentDir/normalizePath behavior without loading the entire
  // SDK at extension import time (Pi's CLI supplies its extension API separately).
  let dir = explicitDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  if (process.platform === "win32" && !dir.startsWith("//") && !dir.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(dir);
    if (drive) dir = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/") || (process.platform === "win32" && dir.startsWith("~\\"))) return path.join(os.homedir(), dir.slice(2));
  return dir.startsWith("file://") ? fileURLToPath(dir) : dir;
}

/**
 * Pi Extension Entrypoint
 */
export default function (pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir();
  const runtime = new MuxRuntime(pi, agentDir);

  // Register local commands
  pi.registerCommand("tg-setup", {
    description: "Configure Telegram Bot Token, Supergroup Chat ID, and Allowed User ID",
    handler: async (args, ctx) => {
      await runtime.handleTgSetup(args, ctx);
    },
  });

  pi.registerCommand("tg-status", {
    description: "Show current Telegram multiplexer and session binding status",
    handler: async (_args, ctx) => {
      runtime.handleTgStatus(ctx);
    },
  });

  pi.registerCommand("tg-connect", {
    description: "Connect or reconnect current Pi session to a Telegram Forum Topic",
    handler: async (_args, ctx) => {
      await runtime.handleTgConnect(ctx);
    },
  });

  pi.registerCommand("tg-disconnect", {
    description: "Disconnect current session from its Telegram Forum Topic",
    handler: async (_args, ctx) => {
      runtime.handleTgDisconnect(ctx);
    },
  });

  // Lifecycle Events
  pi.on("session_start", async (_event, ctx) => {
    await runtime.onSessionStart(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await runtime.onBeforeAgentStart(event, ctx);
  });

  pi.on("message_start", async (event, ctx) => {
    runtime.onMessageStart(event.message, ctx);
  });

  pi.on("message_end", async (event) => {
    runtime.onMessageEnd(event.message);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await runtime.onAgentSettled(ctx);
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    runtime.onSessionBeforeSwitch(ctx);
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    runtime.onSessionBeforeFork(ctx);
  });

  pi.on("session_before_tree", async () => {
    runtime.onSessionBeforeTree();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.onSessionShutdown(ctx);
  });
}

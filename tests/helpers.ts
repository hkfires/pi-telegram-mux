import * as fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { getConfigPath, saveConfig } from "../src/config.js";
import { MuxRuntime } from "../src/runtime.js";
import type { MuxConfig, TelegramUpdate } from "../src/types.js";

export const testConfig: MuxConfig = { version: 1, botToken: "fake-regression-token", chatId: -100123, allowedUserId: 123 };

/** A Pi fixture with mutable history, real lifecycle hooks and explicit cleanup. */
export async function runtimeFixture(agentDir: string, id: string, threadId: number | null = 50, reason?: "startup" | "resume" | "reload" | "new" | "fork") {
  try { await fs.access(getConfigPath(agentDir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await saveConfig(agentDir, testConfig); }
  const entries: any[] = threadId === null ? [] : [{ type: "custom", customType: "pi-telegram-mux.binding", data: { version: 1, sessionId: id, chatId: testConfig.chatId, threadId } }];
  const ui = { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(async () => true), input: vi.fn() };
  const ctx = {
    mode: "tui", cwd: agentDir, ui, isIdle: vi.fn(() => true), abort: vi.fn(),
    sessionManager: { getSessionId: () => id, getEntries: () => entries, getSessionFile: () => `${agentDir}/${id}.jsonl` },
  } as unknown as ExtensionContext;
  let inputContext: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
  const pi = {
    sendUserMessage: vi.fn(() => { inputContext = AsyncLocalStorage.snapshot(); }),
    appendEntry: vi.fn((customType, data) => entries.push({ type: "custom", customType, data })),
  };
  const runtime = new MuxRuntime(pi as unknown as ExtensionAPI, agentDir);
  if (reason) await runtime.onSessionStart({ reason }, ctx);
  else await runtime.onSessionStart(ctx);
  return { runtime, ctx, pi, ui, entries, inInput: <T>(work: () => T): T => {
    if (!inputContext) throw new Error("No simulated Pi input has been submitted");
    return inputContext(work);
  } };
}

export function telegramUpdate(threadId: number, text: string, updateId = 1, config = testConfig): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, message_thread_id: threadId, chat: { id: config.chatId, type: "supergroup" }, from: { id: config.allowedUserId, is_bot: false, first_name: "Fixture" }, date: 1, text } };
}

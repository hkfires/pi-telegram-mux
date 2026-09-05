import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BINDING_CUSTOM_TYPE,
  type BindingState,
  type TelegramBindingEntryData,
} from "./types.js";

export interface ResolvedBinding {
  state: BindingState;
  threadId: number | null;
  lastValidThreadId: number | null;
}

/**
 * Validate that an unknown object is a valid TelegramBindingEntryData.
 */
export function validateBindingData(data: unknown): TelegramBindingEntryData | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    return null;
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.trim() === "") {
    return null;
  }
  if (typeof obj.chatId !== "number" || !Number.isSafeInteger(obj.chatId)) {
    return null;
  }
  if (obj.threadId !== null) {
    if (typeof obj.threadId !== "number" || !Number.isSafeInteger(obj.threadId) || obj.threadId <= 0) {
      return null;
    }
  }

  return {
    version: 1,
    sessionId: obj.sessionId,
    chatId: obj.chatId,
    threadId: obj.threadId,
  };
}

/**
 * Filter session entries for matching TelegramBindingEntryData for current sessionId and chatId.
 */
export function getMatchingBindingEntries(
  entries: readonly unknown[],
  sessionId: string,
  chatId: number
): TelegramBindingEntryData[] {
  const result: TelegramBindingEntryData[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.type !== "custom" || e.customType !== BINDING_CUSTOM_TYPE) {
      continue;
    }

    const validated = validateBindingData(e.data);
    if (!validated) {
      continue;
    }

    // Must match current sessionId and chatId
    if (validated.sessionId === sessionId && validated.chatId === chatId) {
      result.push(validated);
    }
  }

  return result;
}

/**
 * Resolve current binding state from session entries.
 */
export function resolveBindingState(
  entries: readonly unknown[],
  sessionId: string,
  chatId: number
): ResolvedBinding {
  const matching = getMatchingBindingEntries(entries, sessionId, chatId);

  if (matching.length === 0) {
    return {
      state: "unbound",
      threadId: null,
      lastValidThreadId: null,
    };
  }

  let lastPositiveThreadId: number | null = null;
  for (const entry of matching) {
    if (entry.threadId !== null) {
      lastPositiveThreadId = entry.threadId;
    }
  }

  const latest = matching[matching.length - 1];
  if (latest.threadId !== null) {
    return {
      state: "bound",
      threadId: latest.threadId,
      lastValidThreadId: latest.threadId,
    };
  } else {
    return {
      state: "disconnected",
      threadId: null,
      lastValidThreadId: lastPositiveThreadId,
    };
  }
}

/**
 * Append a binding custom entry to the current session.
 * Returns true if entry was appended and verified in session entries, false otherwise.
 */
export function appendBindingEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  chatId: number,
  threadId: number | null
): boolean {
  if (threadId !== null && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
    return false;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return false;
  }

  const entryData: TelegramBindingEntryData = {
    version: 1,
    sessionId,
    chatId,
    threadId,
  };

  try {
    pi.appendEntry(BINDING_CUSTOM_TYPE, entryData);
  } catch {
    return false;
  }

  // Verification: verify that the entry now exists in session entries
  try {
    const entries = ctx.sessionManager.getEntries();
    const matching = getMatchingBindingEntries(entries, sessionId, chatId);
    if (matching.length === 0) {
      return false;
    }
    const latest = matching[matching.length - 1];
    return (
      latest.version === 1 &&
      latest.sessionId === sessionId &&
      latest.chatId === chatId &&
      latest.threadId === threadId
    );
  } catch {
    return false;
  }
}

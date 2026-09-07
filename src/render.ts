export { renderTelegramMarkdown, splitTelegramMessage } from "./render-core.mjs";
export type { FormattedMessageChunk } from "./render-core.mjs";

/**
 * Extract plain text from an assistant message.
 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const msg = message as Record<string, unknown>;

  // Check role if present
  if (msg.role && msg.role !== "assistant") {
    return "";
  }

  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (typeof part === "object" && part !== null) {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          textParts.push(p.text);
        }
      }
    }
    return textParts.join("");
  }

  return "";
}

/**
 * Extract plain text from a user message.
 */
export function extractUserText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const msg = message as Record<string, unknown>;

  // Check role if present
  if (msg.role && msg.role !== "user") {
    return "";
  }

  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    const textParts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (typeof part === "object" && part !== null) {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          textParts.push(p.text);
        }
      }
    }
    return textParts.join("");
  }

  return "";
}

/**
 * Find the latest user prompt text from session entries.
 */
export function findLastUserPrompt(entries: readonly unknown[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.type === "message" && e.message) {
      const text = extractUserText(e.message);
      if (text.trim()) {
        return text.trim();
      }
    }
  }
  return "";
}

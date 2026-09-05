/**
 * Assistant text rendering and Telegram chunking.
 */

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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

/**
 * Split text into chunks safe for Telegram (maxLength <= 4096 chars).
 * Splits at newline or whitespace where possible, respecting Unicode code points.
 */
export function splitTelegramMessage(
  text: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH
): string[] {
  if (text.length <= maxLength) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Work on a slice up to maxLength
    let splitIndex = maxLength;

    // Avoid splitting in the middle of a UTF-16 surrogate pair
    if (splitIndex > 0 && splitIndex < remaining.length) {
      const code = remaining.charCodeAt(splitIndex - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        // splitIndex lands between high and low surrogate, pull back by 1
        splitIndex--;
      }
    }

    const candidateSlice = remaining.slice(0, splitIndex);

    // Try to split on newline first
    const lastNewline = candidateSlice.lastIndexOf("\n");
    if (lastNewline > maxLength * 0.3) {
      splitIndex = lastNewline + 1; // Include newline in current chunk
    } else {
      // Try to split on whitespace
      const lastSpace = candidateSlice.lastIndexOf(" ");
      if (lastSpace > maxLength * 0.3) {
        splitIndex = lastSpace + 1;
      }
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}

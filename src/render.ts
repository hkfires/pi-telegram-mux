import { createRequire } from "node:module";
import type { TelegramMessageEntity } from "./types.js";

/**
 * Assistant text rendering and Telegram chunking.
 */

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface FormattedMessageChunk {
  text: string;
  entities?: TelegramMessageEntity[];
}

interface MarkdownEntitiesModule {
  renderMarkdown(markdown: string): { text: string; entities: TelegramMessageEntity[] };
}

let cachedRenderer: MarkdownEntitiesModule | null | undefined;

function getMarkdownRenderer(): MarkdownEntitiesModule | null {
  if (cachedRenderer !== undefined) {
    return cachedRenderer;
  }
  const req = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = req.resolve("telegram-md-entities");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND") throw error;
    // A missing entry in an installed package is a broken installation. Only
    // an absent package may fall back in source-only/isolated installations.
    try {
      req.resolve("telegram-md-entities/package.json");
    } catch (packageError) {
      if ((packageError as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND") throw packageError;
      cachedRenderer = null;
      return null;
    }
    throw error;
  }
  // Loading happens outside the fallback boundary so syntax, initialization and
  // transitive dependency failures reach the caller's delivery error boundary.
  const mod = req(entry) as MarkdownEntitiesModule;
  if (typeof mod?.renderMarkdown !== "function") throw new TypeError("Markdown renderer does not export renderMarkdown");
  cachedRenderer = mod;
  return mod;
}

/**
 * Use the renderer's Markdown semantics while retaining code whitespace through
 * rendering and chunking. Missing installations fall back to plain text; other
 * failures reach the caller's delivery error boundary.
 */
export function renderTelegramMarkdown(
  markdown: string,
  options?: { maxLength?: number }
): FormattedMessageChunk[] {
  if (!markdown || !markdown.trim()) {
    return [];
  }

  const renderer = getMarkdownRenderer();
  if (!renderer) {
    return splitTelegramMessage(markdown, options?.maxLength).map(text => ({ text }));
  }

  // Non-whitespace boundary paragraphs keep the renderer from trimming a code
  // block at the document edges. Remove only these known boundary positions,
  // never matching markers inside user content, and clip their entity ranges.
  const prefix = "\uE000\n\n";
  const suffix = "\n\n\uE000";
  const rendered = renderer.renderMarkdown(prefix + markdown + suffix);
  if (!rendered.text.startsWith(prefix) || !rendered.text.endsWith(suffix)) {
    throw new Error("Markdown renderer did not preserve document boundaries");
  }
  const contentStart = prefix.length;
  const contentEnd = rendered.text.length - suffix.length;
  rendered.text = rendered.text.slice(contentStart, contentEnd);
  rendered.entities = rendered.entities.flatMap(entity => {
    const start = Math.max(contentStart, entity.offset);
    const end = Math.min(contentEnd, entity.offset + entity.length);
    return end > start ? [{ ...entity, offset: start - contentStart, length: end - start }] : [];
  });
  // The dependency trims each split, including indentation inside pre entities.
  // Slice the rendered text verbatim and clip entity ranges to each chunk instead.
  const entities = [...rendered.entities]
    .sort((a, b) => a.offset - b.offset);
  const maxLength = options?.maxLength ?? TELEGRAM_MAX_MESSAGE_LENGTH;
  const chunks: FormattedMessageChunk[] = [];
  let offset = 0;
  while (offset < rendered.text.length) {
    const active = entities.filter(entity => entity.offset + entity.length > offset);
    // Leave room below Telegram's 100-entity cap for server-side normalization.
    const entityLimit = active[90]?.offset ?? Infinity;
    const budget = Math.min(maxLength, entityLimit - offset);
    if (budget < 1) throw new Error("Cannot split within Telegram entity limits");
    let end = Math.min(offset + budget, rendered.text.length);
    if (end < rendered.text.length) {
      // Match the plain-text splitter's preference for complete lines and words.
      if (/^[\uDC00-\uDFFF]$/.test(rendered.text[end]) && /[\uD800-\uDBFF]/.test(rendered.text[end - 1])) end--;
      if (end === offset) throw new Error("Cannot split a Unicode character within the limit");
      const candidate = rendered.text.slice(offset, end);
      const newline = candidate.lastIndexOf("\n");
      const space = candidate.lastIndexOf(" ");
      if (newline > budget * 0.3) end = offset + newline + 1;
      else if (space > budget * 0.3) end = offset + space + 1;
    }
    const clipped = active.filter(entity => entity.offset < end).map(entity => {
      const start = Math.max(offset, entity.offset);
      return { ...entity, offset: start - offset, length: Math.min(end, entity.offset + entity.length) - start };
    });
    chunks.push({ text: rendered.text.slice(offset, end), entities: clipped.length ? clipped : undefined });
    offset = end;
  }
  return chunks;
}

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

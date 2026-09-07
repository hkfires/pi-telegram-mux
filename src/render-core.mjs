import { createRequire } from "node:module";
/** @typedef {import("./types.js").TelegramMessageEntity} TelegramMessageEntity */

/**
 * Assistant text rendering and Telegram chunking.
 */

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** @typedef {{ text: string, entities?: TelegramMessageEntity[] }} FormattedMessageChunk */

/** @typedef {{ renderMarkdown(markdown: string): { text: string, entities: TelegramMessageEntity[] } }} MarkdownEntitiesModule */

/** @type {MarkdownEntitiesModule | null | undefined} */
let cachedRenderer;

/** @returns {MarkdownEntitiesModule | null} */
function getMarkdownRenderer() {
  if (cachedRenderer !== undefined) {
    return cachedRenderer;
  }
  const req = createRequire(import.meta.url);
  /** @type {string} */
  let entry;
  try {
    entry = req.resolve("telegram-md-entities");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "MODULE_NOT_FOUND") throw error;
    // A missing entry in an installed package is a broken installation. Only
    // an absent package may fall back in source-only/isolated installations.
    try {
      req.resolve("telegram-md-entities/package.json");
    } catch (packageError) {
      if (/** @type {NodeJS.ErrnoException} */ (packageError)?.code !== "MODULE_NOT_FOUND") throw packageError;
      cachedRenderer = null;
      return null;
    }
    throw error;
  }
  // Loading happens outside the fallback boundary so syntax, initialization and
  // transitive dependency failures reach the caller's delivery error boundary.
  const mod = /** @type {MarkdownEntitiesModule} */ (req(entry));
  if (typeof mod?.renderMarkdown !== "function") throw new TypeError("Markdown renderer does not export renderMarkdown");
  cachedRenderer = mod;
  return mod;
}

/**
 * Use the renderer's Markdown semantics while retaining code whitespace through
 * rendering and chunking. Missing installations fall back to plain text; other
 * failures reach the caller's delivery error boundary.
 * @param {string} markdown
 * @param {{ maxLength?: number }} [options]
 * @returns {FormattedMessageChunk[]}
 */
export function renderTelegramMarkdown(markdown, options) {
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
  /** @type {FormattedMessageChunk[]} */
  const chunks = [];
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
 * Split text into chunks safe for Telegram (maxLength <= 4096 chars).
 * Splits at newline or whitespace where possible, respecting Unicode code points.
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string[]}
 */
export function splitTelegramMessage(text, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLength) {
    return text.length > 0 ? [text] : [];
  }

  /** @type {string[]} */
  const chunks = [];
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

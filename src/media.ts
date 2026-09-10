import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InboundMedia } from "./types.js";

// Count active and cancelled-but-unfinished work, never bytes or image size.
export const MAX_INPUT_WORK = 32;
export const INPUT_CLEANUP_NOTICE_MS = 60_000;
export const MEDIA_VALIDATION_TIMEOUT_MS = 5000;
export const INPUT_ADMISSION_TIMEOUT_MS = 2000;
// Include metadata/cleanup and IPC scheduling headroom beyond validation and Pi admission.
export const MEDIA_IPC_TIMEOUT_MS = MEDIA_VALIDATION_TIMEOUT_MS + INPUT_ADMISSION_TIMEOUT_MS + 3000;
export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Only unfinished, mux-created staging files are eligible for age-based cleanup.
export const MEDIA_STAGING_FILE_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.(?:jpg|png|gif|webp)\.part$/;

/** Validate the entire album without loading image bytes, then expose stable paths. */
export async function buildImagePathPrompt(caption: string, images: InboundMedia[], mediaDir: string, signal: AbortSignal): Promise<string> {
  if (!images.length || images.length > 10 || images.some(image => !image || typeof image.path !== "string" ||
      !path.isAbsolute(image.path) || (process.platform === "win32" && path.parse(image.path).root.length === 1) ||
      /[\r\n\0]/.test(image.path) || !IMAGE_MIME_TYPES.has(image.mimeType))) {
    throw new Error("Invalid image cache reference or unsupported format");
  }
  signal.throwIfAborted();
  const cache = await fs.stat(await fs.realpath(mediaDir), { bigint: true });
  if (!cache.isDirectory()) throw new Error("Image cache is not a directory");
  const lines: string[] = [];
  for (const [index, image] of images.entries()) {
    signal.throwIfAborted();
    const filePath = path.resolve(image.path);
    const parent = await fs.stat(await fs.realpath(path.dirname(filePath)), { bigint: true });
    if (!parent.isDirectory() || parent.dev !== cache.dev || parent.ino !== cache.ino) {
      throw new Error("Image is outside the cache directory");
    }
    const expected = await fs.lstat(filePath, { bigint: true });
    if (!expected.isFile()) throw new Error("Image cache is not a regular file");
    signal.throwIfAborted();
    // Opening read-only verifies readability without copying image content into mux.
    // Recheck the opened file so a replacement between lstat and open cannot pass.
    const file = await fs.open(filePath, "r");
    try {
      const actual = await file.stat({ bigint: true });
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new Error("Image cache changed during validation");
      }
      signal.throwIfAborted();
    } finally { await file.close(); }
    lines.push(`[Image#${index + 1}] ${filePath}`);
  }
  signal.throwIfAborted();
  // Paths are plain text, never shell arguments or hidden attachment tokens.
  const text = caption.trim();
  return text ? `${lines.join("\n")}\n\n${text}` : lines.join("\n");
}

export async function removeMedia(file: string | string[]): Promise<void> {
  if (Array.isArray(file)) {
    // Attempt every member's cleanup before reporting failures from an album.
    const results = await Promise.allSettled(file.map(item => removeMedia(item)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Failed to remove image cache files");
    return;
  }
  try {
    await fs.unlink(file);
  } catch (error) {
    // Creator cleanup can race staging-file maintenance; only absence is benign.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

import * as fs from "node:fs/promises";

// Queue backpressure only: an empty media queue may admit one input of any size.
export const MEDIA_QUEUE_BUDGET_BYTES = 32 * 1024 * 1024;
// Count active and cancelled-but-unfinished work, never bytes or image size.
export const MAX_INPUT_WORK = 32;
export const INPUT_CLEANUP_NOTICE_MS = 60_000;
export const MEDIA_READ_TIMEOUT_MS = 5000;
export const INPUT_ADMISSION_TIMEOUT_MS = 2000;
// Include metadata/cleanup and IPC scheduling headroom beyond reading and Pi admission.
export const MEDIA_IPC_TIMEOUT_MS = MEDIA_READ_TIMEOUT_MS + INPUT_ADMISSION_TIMEOUT_MS + 3000;
export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Only unfinished, mux-created staging files are eligible for age-based cleanup.
export const MEDIA_STAGING_FILE_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.(?:jpg|png|gif|webp)\.part$/;

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

import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderTelegramMarkdown } from "../dist/render.js";
import { MarkdownWorker } from "../dist/markdown-worker.js";

// Synthetic data only. Each mode starts in a fresh process to include cold loading.
const mode = process.argv[2];
if (!mode) {
  for (const mode of ["sync", "worker"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], { encoding: "utf8" });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
} else {
  const renderer = new MarkdownWorker();
  try {
    for (const [scenario, text] of [
      ["cold-short", "🧑‍💻 [Prompt]\nPlease review **this change**."],
      ["warm-short", "🧑‍💻 [Prompt]\nPlease review **this change**."],
      ["warm-long", "**Result**\n\n```ts\n  const value = 1;\n```\n\n".repeat(1000)],
    ]) {
      let previous = performance.now();
      let maxGap = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - previous);
        previous = now;
      }, 5);
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        const started = performance.now();
        const chunks = mode === "sync" ? renderTelegramMarkdown(text) : await renderer.render(text, new AbortController().signal);
        const total = performance.now() - started;
        await new Promise(resolve => setTimeout(resolve, 30));
        console.log(JSON.stringify({ mode, scenario, characters: text.length, chunks: chunks.length,
          totalMs: +total.toFixed(2), maxMainThreadTimerGapMs: +maxGap.toFixed(2) }));
      } finally { clearInterval(timer); }
    }
  } finally { await renderer.close(); }
}

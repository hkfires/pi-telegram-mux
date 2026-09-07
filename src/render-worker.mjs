import { parentPort } from "node:worker_threads";
import { renderTelegramMarkdown } from "./render-core.mjs";

const port = parentPort;
if (!port) throw new Error("Markdown renderer requires a worker thread");

port.on("message", /** @param {string} text */ text => {
  try {
    port.postMessage({ chunks: renderTelegramMarkdown(text) });
  } catch (error) {
    // Preserve renderer failures across the worker boundary; never send raw Markdown as a silent fallback.
    port.postMessage({ error: error instanceof Error ? error : new Error("Markdown rendering failed", { cause: error }) });
  }
});

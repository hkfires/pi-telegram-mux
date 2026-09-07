import { afterEach, describe, expect, it } from "vitest";
import { MarkdownWorker } from "../src/markdown-worker.js";
import { renderTelegramMarkdown } from "../src/render.js";
import type { Worker } from "node:worker_threads";

const renderers: MarkdownWorker[] = [];
afterEach(async () => { await Promise.all(renderers.splice(0).map(renderer => renderer.close())); });

describe("Markdown worker", () => {
  it("keeps the main event loop available during cold rendering and reuses its worker", async () => {
    const renderer = new MarkdownWorker();
    renderers.push(renderer);
    let completed = false;
    const text = "**重点**\n\n```ts\n  const x = 1;\n```\n".repeat(150);
    const result = renderer.render(text, new AbortController().signal).then(chunks => { completed = true; return chunks; });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    const chunks = await result;
    expect(chunks).toEqual(renderTelegramMarkdown(text));
    const worker = (renderer as unknown as { worker: Worker }).worker;
    expect(await renderer.render("**next**", new AbortController().signal)).toEqual(renderTelegramMarkdown("**next**"));
    expect((renderer as unknown as { worker: Worker }).worker).toBe(worker);
  }, 15_000);

  it("cancels cold work, rejects stale results and can restart", async () => {
    const renderer = new MarkdownWorker();
    renderers.push(renderer);
    const controller = new AbortController();
    const result = renderer.render("**old**".repeat(10000), controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(await renderer.render("new", new AbortController().signal)).toEqual([{ text: "new", entities: undefined }]);
  }, 15_000);

  it("rejects an unexpected worker exit and releases the pending request", async () => {
    const renderer = new MarkdownWorker();
    renderers.push(renderer);
    const result = renderer.render("text", new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("exited unexpectedly");
    await (renderer as unknown as { worker: Worker }).worker.terminate();
    await rejected;
  });

  it("rejects pending work on shutdown and does not create a worker for aborted input", async () => {
    const renderer = new MarkdownWorker();
    renderers.push(renderer);
    const aborted = AbortSignal.abort();
    await expect(renderer.render("old", aborted)).rejects.toMatchObject({ name: "AbortError" });
    expect((renderer as unknown as { worker?: Worker }).worker).toBeUndefined();
    const result = renderer.render("text", new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("closed");
    await renderer.close();
    await rejected;
  });
});

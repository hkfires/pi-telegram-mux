import { Worker } from "node:worker_threads";
import type { FormattedMessageChunk } from "./render.js";

/** One lazy renderer per runtime. The outbox serializes requests and owns backpressure. */
export class MarkdownWorker {
  private worker?: Worker;
  private termination: Promise<void> = Promise.resolve();
  private pending?: {
    resolve: (chunks: FormattedMessageChunk[]) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  };

  public render(text: string, signal: AbortSignal): Promise<FormattedMessageChunk[]> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.pending) return Promise.reject(new Error("Markdown renderer is already processing a message"));
    if (!text.trim()) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        const worker = new Worker(new URL("./render-worker.mjs", import.meta.url), { execArgv: [] });
        this.worker = worker;
        worker.on("message", (result: { chunks: FormattedMessageChunk[]; error?: Error }) => {
          if (this.worker !== worker) return;
          const pending = this.pending;
          this.pending = undefined;
          pending?.cleanup();
          worker.unref();
          if (result.error) pending?.reject(result.error);
          else pending?.resolve(result.chunks);
        });
        worker.once("error", error => {
          if (this.worker === worker) void this.close(error);
        });
        worker.once("exit", code => {
          if (this.worker === worker) void this.close(new Error(`Markdown worker exited unexpectedly (${code})`));
        });
      }
      const abort = () => { void this.close(signal.reason); };
      const timer = setTimeout(() => { void this.close(new Error("Markdown rendering timed out")); }, 30_000);
      this.pending = {
        resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.worker.ref();
      try { this.worker.postMessage(text); }
      catch (error) { void this.close(error); }
    });
  }

  /** Termination also interrupts synchronous parsing, so stale work cannot delay the next session. */
  public close(error: unknown = new Error("Markdown renderer closed")): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.reject(error);
    if (worker) this.termination = Promise.all([this.termination, worker.terminate()]).then(() => undefined);
    return this.termination;
  }
}

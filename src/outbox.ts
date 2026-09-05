/** A bounded, in-memory FIFO. Failed delivery halts the queue until an explicit reset. */
export class BoundedOutbox {
  private readonly jobs: { work: (signal: AbortSignal) => Promise<void>; bytes: number }[] = [];
  private active: Promise<void> | null = null;
  private controller?: AbortController;
  private bytes = 0;
  private activeBytes = 0;
  public error: Error | null = null;

  constructor(private readonly onFailure: (error: Error) => void, private readonly maxJobs = 32, private readonly maxBytes = 256 * 1024) {}

  public get size(): number { return this.jobs.length + (this.active ? 1 : 0); }

  public enqueue(work: (signal: AbortSignal) => Promise<void>, bytes = 0): boolean {
    if (this.error) return false;
    if (this.size >= this.maxJobs || bytes > this.maxBytes - this.bytes) {
      this.fail(Object.assign(new Error("Telegram background queue is full; sync is paused. Check errors and run /tg-connect to retry."), { code: "OUTBOX_FULL" }));
      return false;
    }
    this.bytes += bytes;
    this.jobs.push({ work, bytes });
    this.pump();
    return true;
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    this.controller?.abort();
    this.jobs.length = 0;
    this.bytes = this.activeBytes;
    this.onFailure(error);
  }

  private pump(): void {
    if (this.active || this.error || !this.jobs.length) return;
    const job = this.jobs.shift()!;
    const controller = new AbortController();
    this.controller = controller;
    this.activeBytes = job.bytes;
    // Start on a microtask so synchronous completion cannot race active assignment.
    this.active = Promise.resolve().then(() => job.work(controller.signal)).catch(error => {
      // Delivery boundary: explicit cancellation discards obsolete work. Any other
      // failure stops all dependent jobs and is exposed to the owner's status/UI.
      if (!controller.signal.aborted) this.fail(error instanceof Error ? error : new Error("Telegram background task failed", { cause: error }));
    }).finally(() => {
      this.bytes -= this.activeBytes;
      this.activeBytes = 0;
      this.active = null;
      this.controller = undefined;
      this.pump();
    });
  }

  public reset(): void {
    this.controller?.abort();
    this.jobs.length = 0;
    this.bytes = this.activeBytes;
    this.error = null;
  }

  /** For shutdown/tests, never awaited by Pi prompt or message lifecycle handlers. */
  public async whenIdle(): Promise<void> {
    while (this.active) await this.active;
  }
}

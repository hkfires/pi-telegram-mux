import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeFixture } from "./helpers.js";

let dir: string;
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-prompt-performance-")); });
afterEach(async () => {
  if (fixture) await fixture.runtime.onSessionShutdown(fixture.ctx);
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

it("does not read history for a bound local prompt", async () => {
  fixture = await runtimeFixture(dir, "bound");
  const read = vi.spyOn(fixture.ctx.sessionManager, "getEntries");
  await fixture.runtime.onBeforeAgentStart({ prompt: "next" }, fixture.ctx);
  await fixture.runtime.outbox.whenIdle();
  expect(read).not.toHaveBeenCalled();
});

it("captures new-topic eligibility before a queued job can see the first reply", async () => {
  fixture = await runtimeFixture(dir, "new", null);
  const read = vi.spyOn(fixture.ctx.sessionManager, "getEntries");
  const call = vi.spyOn(fixture.runtime, "callTelegram").mockResolvedValue({ message_thread_id: 99 } as any);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.runtime.outbox.enqueue(async () => { await gate; });
  try {
    await fixture.runtime.onBeforeAgentStart({ prompt: "first" }, fixture.ctx);
    expect(read).toHaveBeenCalledOnce();
    fixture.entries.push({ type: "message", message: { role: "assistant", content: "fast reply" } });
  } finally { release(); }
  await fixture.runtime.outbox.whenIdle();
  expect(call.mock.calls.filter(([method]) => method === "createForumTopic")).toHaveLength(1);
  expect(fixture.runtime.getBindingState()).toBe("bound");
});

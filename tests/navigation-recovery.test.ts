import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../src/ipc.js";
import { MuxRuntime } from "../src/runtime.js";
import { runtimeFixture } from "./helpers.js";

const navigationEvents = ["onSessionBeforeTree", "onSessionBeforeSwitch", "onSessionBeforeFork"] as const;

describe("navigation registration and outbox recovery status", () => {
  let dir: string;
  const fixtures: { runtime: MuxRuntime; ctx: ExtensionContext }[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-navigation-recovery-")); });
  afterEach(async () => {
    for (const { runtime, ctx } of fixtures.reverse()) await runtime.onSessionShutdown(ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(navigationEvents)("does not enqueue %s registration for an unconfigured TUI session", async event => {
    const ui = { setStatus: vi.fn(), notify: vi.fn() };
    const ctx = {
      mode: "tui", cwd: dir, ui,
      sessionManager: { getSessionId: () => "unconfigured", getEntries: () => [] },
    } as unknown as ExtensionContext;
    const runtime = new MuxRuntime({} as ExtensionAPI, dir);
    fixtures.push({ runtime, ctx });
    await runtime.onSessionStart(ctx);
    expect(ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: unconfigured");
    const register = vi.spyOn(runtime, "registerRoute");
    const enqueue = vi.spyOn(runtime.outbox, "enqueue");
    const generation = runtime.getGeneration();

    runtime[event](ctx);
    await runtime.outbox.whenIdle();

    expect(runtime.getGeneration()).toBe(generation + 1);
    expect(register).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(runtime.outbox.error).toBeNull();
    expect(ui.notify).not.toHaveBeenCalled();
    expect(ui.setStatus).not.toHaveBeenCalledWith("tg", "tg: error");
    expect(ui.setStatus).toHaveBeenLastCalledWith("tg", event === "onSessionBeforeTree" ? "tg: unconfigured" : undefined);
  });

  it.each(navigationEvents)("does not enqueue late %s registration after integration shutdown", async event => {
    const f = await runtimeFixture(dir, "disabled");
    fixtures.push(f);
    await f.runtime.onSessionShutdown(f.ctx);
    const register = vi.spyOn(f.runtime, "registerRoute");
    const enqueue = vi.spyOn(f.runtime.outbox, "enqueue");
    f.ui.notify.mockClear();
    f.ui.setStatus.mockClear();

    f.runtime[event](f.ctx);
    await f.runtime.outbox.whenIdle();

    expect(register).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.notify).not.toHaveBeenCalled();
    expect(f.ui.setStatus).not.toHaveBeenCalledWith("tg", "tg: error");
  });

  describe.each(["offline", "rejected"] as const)("genuine %s registration failures", failureMode => {
    it.each(navigationEvents)("still exposes failures during %s", async event => {
      const f = await runtimeFixture(dir, "configured");
      fixtures.push(f);
      const register = vi.spyOn(f.runtime, "registerRoute");
      const failure = new IpcError("IPC_CLOSED", "Simulated registration failure");
      if (failureMode === "offline") await (f.runtime as any).stopTransport();
      else register.mockRejectedValue(failure);
      f.ui.notify.mockClear();

      f.runtime[event](f.ctx);
      await f.runtime.outbox.whenIdle();

      expect(register).toHaveBeenCalledTimes(1);
      expect(f.runtime.outbox.error).toBeInstanceOf(Error);
      if (failureMode === "rejected") expect(f.runtime.outbox.error).toBe(failure);
      expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sync paused"), "error");
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    });
  });

  it.each(["leader", "follower"])("refreshes bound %s status after /tg-connect recovers a failed outbox", async role => {
    const leader = await runtimeFixture(dir, "leader", 50);
    fixtures.push(leader);
    const f = role === "leader" ? leader : await runtimeFixture(dir, "follower", 51);
    if (f !== leader) fixtures.push(f);
    const threadId = f.runtime.getCurrentThreadId();
    const failure = new Error("Simulated send failure");
    const send = vi.spyOn(f.runtime, "callTelegram").mockRejectedValueOnce(failure).mockResolvedValue({} as any);
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "failed prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "discarded answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.runtime.outbox.error).toBe(failure);
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", "tg: error");
    expect(f.runtime.hasActiveTransport()).toBe(true);

    await f.runtime.handleTgConnect(f.ctx);

    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
    expect(f.runtime.getCurrentThreadId()).toBe(threadId);
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
    await f.runtime.onBeforeAgentStart(f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "new prompt" }, f.ctx);
    f.runtime.onMessageEnd({ role: "assistant", content: "new answer", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(send.mock.calls.map(([, params]) => params.text)).toEqual(["🧑‍💻 [Prompt]\nfailed prompt", "🧑‍💻 [Prompt]\nnew prompt", "new answer"]);
    expect(f.runtime.outbox.error).toBeNull();
    expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", `tg: connected (${f.ctx.sessionManager.getSessionId().slice(-6)})`);
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigPath, loadConfig, saveConfig } from "../src/config.js";
import { TelegramClient } from "../src/telegram.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe("optional automatic topic closure", () => {
  let dir: string;
  const fixtures: Fixture[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-auto-close-"));
    await saveConfig(dir, testConfig);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    fixtures.length = 0;
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe.each(["leader", "follower"])("%s", role => {
    describe.each([undefined, false])("autoCloseTopics=%s", autoCloseTopics => {
      it.each(["exit", "new", "resume", "fork"])("retains its topic and releases ownership on %s", async reason => {
        // Write the legacy form directly so a missing setting is tested on disk.
        await fs.writeFile(getConfigPath(dir), JSON.stringify({ ...testConfig, autoCloseTopics }));
        if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
        const f = await runtimeFixture(dir, "outgoing", 50);
        fixtures.push(f);
        const entries = [...f.entries];
        const api = vi.spyOn(TelegramClient.prototype, "callApi");
        if (reason === "fork") f.runtime.onSessionBeforeFork(f.ctx);
        else if (reason !== "exit") f.runtime.onSessionBeforeSwitch(f.ctx);
        const shutdown = f.runtime.onSessionShutdown({ reason }, f.ctx);
        await expect(f.runtime.handleInboundText("late input", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
        await shutdown;
        expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(0);
        expect(f.runtime.hasActiveTransport()).toBe(false);
        expect(f.runtime.outbox.error).toBeNull();
        expect(f.ui.setStatus).toHaveBeenLastCalledWith("tg", undefined);
        expect(f.entries).toEqual(entries);
        expect(f.pi.appendEntry).not.toHaveBeenCalled();

        const restored = await runtimeFixture(dir, "outgoing", 50, "resume");
        fixtures.push(restored);
        expect(restored.runtime.hasActiveTransport()).toBe(true);
        expect(restored.runtime.getCurrentThreadId()).toBe(50);
        expect(restored.ui.notify).not.toHaveBeenCalled();
        expect(api.mock.calls.filter(([method]) => method === "reopenForumTopic")).toHaveLength(1);
      });
    });
  });

  describe("setup", () => {
    beforeEach(() => {
      vi.spyOn(TelegramClient.prototype, "getChat").mockResolvedValue({ id: testConfig.chatId, type: "supergroup", is_forum: true });
      vi.spyOn(TelegramClient.prototype, "getChatMember").mockResolvedValue({ status: "creator" });
    });

    it.each([false, true])("sets autoCloseTopics=%s through the interactive setup", async autoCloseTopics => {
      await saveConfig(dir, { ...testConfig, autoCloseTopics: !autoCloseTopics });
      const f = await runtimeFixture(dir, "interactive");
      fixtures.push(f);
      f.ui.select.mockImplementationOnce(async (_title, options) => options[1]).mockImplementationOnce(async (title, options) => {
        expect(title).toBe(`Auto-close topics (current: ${autoCloseTopics ? "OFF" : "ON"})`);
        expect(options).toEqual(["OFF - keep topics open (faster exit)", "ON - close topics (may wait up to 3 seconds)"]);
        return options[autoCloseTopics ? 1 : 0];
      });
      await f.runtime.handleTgSetup(f.ctx);
      expect(f.ui.select).toHaveBeenCalledTimes(3);
      expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", `Auto-close topics: ${autoCloseTopics ? "ON" : "OFF"}`]);
      expect(f.ui.input).not.toHaveBeenCalled();
      expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
      expect(TelegramClient.prototype.getChatMember).not.toHaveBeenCalled();
      expect(await loadConfig(dir)).toEqual({ ...testConfig, autoCloseTopics });
      f.runtime.handleTgStatus(f.ctx);
      expect(f.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`Auto-close topics: ${autoCloseTopics ? "ON" : "OFF"}`), "info");
    });

    it("leaves configuration untouched when the auto-close selection is cancelled", async () => {
      const f = await runtimeFixture(dir, "cancelled");
      fixtures.push(f);
      const original = await fs.readFile(getConfigPath(dir), "utf-8");
      f.ui.select.mockImplementationOnce(async (_title, options) => options[1]).mockResolvedValueOnce(undefined);
      await f.runtime.handleTgSetup(f.ctx);
      expect(f.ui.select).toHaveBeenCalledTimes(3);
      expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", "Auto-close topics: OFF"]);
      expect(await fs.readFile(getConfigPath(dir), "utf-8")).toBe(original);
      expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
      expect(f.ui.input).not.toHaveBeenCalled();
      expect(f.runtime.hasActiveTransport()).toBe(true);
    });

    it("keeps the same options and order when reopening the submenu after a change", async () => {
      const f = await runtimeFixture(dir, "stable-options");
      fixtures.push(f);
      f.ui.select.mockImplementationOnce(async (_title, options) => options[1])
        .mockImplementationOnce(async (_title, options) => options[1])
        .mockImplementationOnce(async (_title, options) => options[1])
        .mockImplementationOnce(async (_title, options) => options[0]);
      await f.runtime.handleTgSetup(f.ctx);
      const options = ["OFF - keep topics open (faster exit)", "ON - close topics (may wait up to 3 seconds)"];
      expect(f.ui.select.mock.calls.filter(([title]) => title.startsWith("Auto-close topics (current:"))).toEqual([
        ["Auto-close topics (current: OFF)", options],
        ["Auto-close topics (current: ON)", options],
      ]);
      expect((await loadConfig(dir))?.autoCloseTopics).toBe(false);
      expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", "Auto-close topics: OFF"]);
    });

    describe.each(["leader", "follower"])("configured by the %s", role => {
      it.each([false, true])("applies autoCloseTopics=%s from the menu to all connected runtimes", async autoCloseTopics => {
        await saveConfig(dir, { ...testConfig, autoCloseTopics: !autoCloseTopics });
        const host = await runtimeFixture(dir, "host", 10);
        fixtures.push(host);
        const peer = await runtimeFixture(dir, "peer", 50);
        fixtures.push(peer);
        const f = role === "leader" ? host : peer;
        f.ui.select.mockImplementationOnce(async (_title, options) => options[1])
          .mockImplementationOnce(async (_title, options) => options[autoCloseTopics ? 1 : 0]);
        await f.runtime.handleTgSetup(f.ctx);
        expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
        expect(await loadConfig(dir)).toEqual({ ...testConfig, autoCloseTopics });
        await vi.waitFor(() => {
          for (const current of [host, peer]) {
            expect(current.runtime.hasActiveTransport()).toBe(true);
            expect(current.runtime.getIsReconnecting()).toBe(false);
            current.runtime.handleTgStatus(current.ctx);
            expect(current.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`Auto-close topics: ${autoCloseTopics ? "ON" : "OFF"}`), "info");
          }
        }, { timeout: 2500 });
        const api = vi.spyOn(TelegramClient.prototype, "callApi");
        await peer.runtime.onSessionShutdown(peer.ctx);
        await host.runtime.onSessionShutdown(host.ctx);
        expect(api.mock.calls.filter(([method]) => method === "closeForumTopic")).toHaveLength(autoCloseTopics ? 2 : 0);
      });
    });
  });
});

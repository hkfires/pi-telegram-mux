import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigPath, loadConfig, saveConfig } from "../src/config.js";
import activateExtension from "../src/index.js";
import { MuxRuntime } from "../src/runtime.js";
import { TelegramClient } from "../src/telegram.js";
import { runtimeFixture, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;

describe("Telegram settings menu", () => {
  let dir: string;
  const fixtures: Fixture[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-setup-menu-"));
    vi.spyOn(TelegramClient.prototype, "getChat").mockImplementation(async id => ({ id, type: "supergroup", is_forum: true }));
    vi.spyOn(TelegramClient.prototype, "getChatMember").mockResolvedValue({ status: "creator" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    fixtures.length = 0;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([false, true])("groups connection fields without changing autoCloseTopics=%s", async autoCloseTopics => {
    await saveConfig(dir, { ...testConfig, autoCloseTopics });
    const f = await runtimeFixture(dir, "connection");
    fixtures.push(f);
    f.ui.select.mockResolvedValueOnce("Connection settings");
    f.ui.input.mockResolvedValueOnce("new-bot-token").mockResolvedValueOnce("-100999").mockResolvedValueOnce("999");
    await f.runtime.handleTgSetup(f.ctx);
    expect(f.ui.select).toHaveBeenCalledTimes(2);
    expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", `Auto-close topics: ${autoCloseTopics ? "ON" : "OFF"}`]);
    expect(f.ui.input).toHaveBeenCalledTimes(3);
    expect(TelegramClient.prototype.getChat).toHaveBeenCalledWith(-100999);
    expect(TelegramClient.prototype.getChatMember).toHaveBeenCalledWith(-100999, 999);
    expect(await loadConfig(dir)).toEqual({ version: 1, botToken: "new-bot-token", chatId: -100999, allowedUserId: 999, autoCloseTopics });
    expect(f.runtime.getBindingState()).toBe("unbound");
    expect(f.ui.notify).toHaveBeenCalledWith("Telegram configuration saved and applied.", "info");
  });

  it.each([
    { stage: "menu", inputs: [] },
    { stage: "Bot Token", inputs: [undefined] },
    { stage: "Chat ID", inputs: ["new-bot-token", undefined] },
    { stage: "User ID", inputs: ["new-bot-token", "-100999", undefined] },
  ])("preserves configuration and the connection when cancelling $stage", async ({ stage, inputs }) => {
    const f = await runtimeFixture(dir, "cancelled");
    fixtures.push(f);
    const original = await fs.readFile(getConfigPath(dir), "utf-8");
    f.ui.select.mockResolvedValueOnce(stage === "menu" ? undefined : "Connection settings");
    for (const input of inputs) f.ui.input.mockResolvedValueOnce(input);
    await f.runtime.handleTgSetup(f.ctx);
    expect(f.ui.select).toHaveBeenCalledTimes(stage === "menu" ? 1 : 2);
    expect(f.ui.input).toHaveBeenCalledTimes(inputs.length);
    expect(await fs.readFile(getConfigPath(dir), "utf-8")).toBe(original);
    expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
    expect(f.runtime.hasActiveTransport()).toBe(true);
    expect(f.runtime.outbox.error).toBeNull();
  });

  it.each(["Connection settings", "Auto-close topics: OFF"])("handles %s before a connection is configured", async setting => {
    const f = await runtimeFixture(dir, "unconfigured", null);
    fixtures.push(f);
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    await fs.unlink(getConfigPath(dir));
    await f.runtime.onSessionStart(f.ctx);
    f.ui.select.mockResolvedValueOnce(setting);
    f.ui.input.mockResolvedValueOnce(testConfig.botToken)
      .mockResolvedValueOnce(String(testConfig.chatId)).mockResolvedValueOnce(String(testConfig.allowedUserId));
    await f.runtime.handleTgSetup(f.ctx);
    if (setting === "Connection settings") {
      expect(await loadConfig(dir)).toEqual({ ...testConfig, autoCloseTopics: false });
      expect(f.runtime.hasActiveTransport()).toBe(true);
    } else {
      expect(await loadConfig(dir)).toBeNull();
      expect(f.ui.input).not.toHaveBeenCalled();
      expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
      expect(f.ui.notify).toHaveBeenCalledWith("Configure the Telegram connection first.", "warning");
    }
  });

  it("preserves connection changes made while the auto-close submenu is open", async () => {
    const f = await runtimeFixture(dir, "auto-close");
    fixtures.push(f);
    const latest = { ...testConfig, botToken: "other-instance-token", chatId: -100999, allowedUserId: 999 };
    f.ui.select.mockImplementationOnce(async (_title, options) => options[1]).mockImplementationOnce(async (_title, options) => {
      await saveConfig(dir, latest);
      return options[1];
    });
    await f.runtime.handleTgSetup(f.ctx);
    expect(await loadConfig(dir)).toEqual({ ...latest, autoCloseTopics: true });
    expect(f.ui.input).not.toHaveBeenCalled();
    expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
  });

  it("preserves an auto-close change made while the connection is being verified", async () => {
    const f = await runtimeFixture(dir, "connection");
    fixtures.push(f);
    f.ui.select.mockResolvedValueOnce("Connection settings");
    f.ui.input.mockResolvedValueOnce("new-bot-token").mockResolvedValueOnce("-100999").mockResolvedValueOnce("999");
    vi.mocked(TelegramClient.prototype.getChat).mockImplementationOnce(async id => {
      await saveConfig(dir, { ...testConfig, autoCloseTopics: true });
      return { id, type: "supergroup", is_forum: true };
    });
    await f.runtime.handleTgSetup(f.ctx);
    expect(await loadConfig(dir)).toEqual({ version: 1, botToken: "new-bot-token", chatId: -100999, allowedUserId: 999, autoCloseTopics: true });
  });

  it.each([
    { name: "malformed JSON", content: "{", autoCloseTopics: false },
    { name: "invalid Chat ID", content: JSON.stringify({ ...testConfig, chatId: "bad", autoCloseTopics: true }), autoCloseTopics: true },
  ])("repairs $name through connection settings after startup fails", async ({ content, autoCloseTopics }) => {
    const f = await runtimeFixture(dir, "repair", null);
    fixtures.push(f);
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    await fs.writeFile(getConfigPath(dir), content);
    const runtime = new MuxRuntime(f.pi as any, dir);
    fixtures.push({ ...f, runtime });
    await expect(runtime.onSessionStart(f.ctx)).rejects.toThrow();
    f.ui.select.mockResolvedValueOnce("Connection settings");
    f.ui.input.mockResolvedValueOnce(testConfig.botToken)
      .mockResolvedValueOnce(String(testConfig.chatId)).mockResolvedValueOnce(String(testConfig.allowedUserId));
    await runtime.handleTgSetup(f.ctx);
    expect(await loadConfig(dir)).toEqual({ ...testConfig, autoCloseTopics });
    expect(runtime.hasActiveTransport()).toBe(true);
    expect(f.ui.notify).toHaveBeenCalledWith("Telegram configuration saved and applied.", "info");
    expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", `Auto-close topics: ${autoCloseTopics ? "ON" : "OFF"}`]);
  });

  it.each(["cancel", "invalid input", "Telegram validation failure"])("does not replace malformed configuration after %s", async outcome => {
    const f = await runtimeFixture(dir, "failed-repair");
    fixtures.push(f);
    await fs.writeFile(getConfigPath(dir), "{");
    f.ui.select.mockResolvedValueOnce("Connection settings");
    if (outcome !== "cancel") {
      f.ui.input.mockResolvedValueOnce(testConfig.botToken)
        .mockResolvedValueOnce(outcome === "invalid input" ? "bad-id" : String(testConfig.chatId))
        .mockResolvedValueOnce(String(testConfig.allowedUserId));
    }
    if (outcome === "Telegram validation failure") vi.mocked(TelegramClient.prototype.getChat).mockRejectedValueOnce(new Error("Forbidden"));
    await f.runtime.handleTgSetup(f.ctx);
    expect(await fs.readFile(getConfigPath(dir), "utf-8")).toBe("{");
    expect(f.ui.notify).not.toHaveBeenCalledWith("Telegram configuration saved and applied.", "info");
  });

  it("does not replace malformed configuration when only a preference is changed", async () => {
    const f = await runtimeFixture(dir, "incomplete-repair");
    fixtures.push(f);
    await fs.writeFile(getConfigPath(dir), "{");
    f.ui.select.mockImplementationOnce(async (_title, options) => options[1])
      .mockImplementationOnce(async (_title, options) => options[1]);
    await f.runtime.handleTgSetup(f.ctx);
    expect(await fs.readFile(getConfigPath(dir), "utf-8")).toBe("{");
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("configuration validation failed"), "error");
    expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
  });

  it.each(["leader", "follower"])("edits multiple settings in one command from the %s", async role => {
    if (role === "follower") fixtures.push(await runtimeFixture(dir, "host", 10));
    const f = await runtimeFixture(dir, "multiple");
    fixtures.push(f);
    f.ui.input.mockResolvedValueOnce("new-bot-token")
      .mockResolvedValueOnce(String(testConfig.chatId)).mockResolvedValueOnce(String(testConfig.allowedUserId));
    f.ui.select.mockResolvedValueOnce("Connection settings")
      .mockImplementationOnce(async (title, options) => {
        expect(title).toBe("Telegram settings");
        expect((await loadConfig(dir))?.botToken).toBe("new-bot-token");
        return options[1];
      })
      .mockImplementationOnce(async (_title, options) => options[1]);
    await f.runtime.handleTgSetup(f.ctx);
    expect(await loadConfig(dir)).toEqual({ ...testConfig, botToken: "new-bot-token", autoCloseTopics: true });
    expect(f.ui.select).toHaveBeenCalledTimes(4);
    expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", "Auto-close topics: ON"]);
    expect(f.ui.notify.mock.calls.filter(([text]) => text === "Telegram configuration saved and applied.")).toHaveLength(2);
    expect(TelegramClient.prototype.getChat).toHaveBeenCalledTimes(1);
    expect(f.runtime.hasActiveTransport()).toBe(true);
    expect(f.runtime.outbox.error).toBeNull();
  });

  it("can edit another setting after cancelling connection settings", async () => {
    const f = await runtimeFixture(dir, "cancel-then-edit");
    fixtures.push(f);
    f.ui.input.mockResolvedValueOnce("discarded-token").mockResolvedValueOnce(undefined);
    f.ui.select.mockResolvedValueOnce("Connection settings")
      .mockImplementationOnce(async (_title, options) => options[1])
      .mockImplementationOnce(async (_title, options) => options[1]);
    await f.runtime.handleTgSetup(f.ctx);
    expect(await loadConfig(dir)).toEqual({ ...testConfig, autoCloseTopics: true });
    expect(f.ui.input).toHaveBeenCalledTimes(2);
    expect(f.ui.select).toHaveBeenCalledTimes(4);
    expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", "Auto-close topics: ON"]);
    expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
  });

  it("keeps an earlier save and returns to the menu after a later validation failure", async () => {
    const f = await runtimeFixture(dir, "save-then-fail");
    fixtures.push(f);
    f.ui.select.mockImplementationOnce(async (_title, options) => options[1])
      .mockImplementationOnce(async (_title, options) => options[1])
      .mockResolvedValueOnce("Connection settings");
    f.ui.input.mockResolvedValueOnce("discarded-token").mockResolvedValueOnce("invalid-chat-id").mockResolvedValueOnce("999");
    await f.runtime.handleTgSetup(f.ctx);
    expect(await loadConfig(dir)).toEqual({ ...testConfig, autoCloseTopics: true });
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("configuration validation failed: Invalid config: chatId"), "error");
    expect(f.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("could not confirm updates"), "error");
    expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", "Auto-close topics: ON"]);
    expect(f.runtime.hasActiveTransport()).toBe(true);
  });

  it("keeps settings active at the returned menu until the user exits", async () => {
    const f = await runtimeFixture(dir, "returned-menu");
    fixtures.push(f);
    let leaveMenu: ((value?: string) => void) | undefined;
    f.ui.select.mockImplementationOnce(async (_title, options) => options[1])
      .mockImplementationOnce(async (_title, options) => options[1])
      .mockImplementationOnce(() => new Promise(resolve => { leaveMenu = resolve; }));
    let finished = false;
    const setup = f.runtime.handleTgSetup(f.ctx).then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(leaveMenu).toBeDefined());
      expect(finished).toBe(false);
      expect(f.ui.select).toHaveBeenLastCalledWith("Telegram settings", ["Connection settings", "Auto-close topics: ON"]);
      await expect(f.runtime.handleInboundText("while configuring", f.ctx)).resolves.toMatchObject({ accepted: false, busy: true });
      await f.runtime.handleTgSetup(f.ctx);
      expect(f.ui.select).toHaveBeenCalledTimes(3);
      expect((await loadConfig(dir))?.autoCloseTopics).toBe(true);
      leaveMenu!();
      await setup;
      expect(finished).toBe(true);
      await f.runtime.handleTgConnect(f.ctx);
      expect(f.ui.notify).toHaveBeenLastCalledWith("Connected to topic 50; will not duplicate.", "info");
    } finally {
      leaveMenu?.();
      await setup;
    }
  });

  it("ignores a menu selection completed after session shutdown", async () => {
    const f = await runtimeFixture(dir, "shutdown");
    fixtures.push(f);
    const original = await fs.readFile(getConfigPath(dir), "utf-8");
    let select!: (value: string) => void;
    f.ui.select.mockReturnValueOnce(new Promise(resolve => { select = resolve; }));
    const setup = f.runtime.handleTgSetup(f.ctx);
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    select("Connection settings");
    await setup;
    expect(f.ui.input).not.toHaveBeenCalled();
    expect(TelegramClient.prototype.getChat).not.toHaveBeenCalled();
    expect(await fs.readFile(getConfigPath(dir), "utf-8")).toBe(original);
    expect(f.runtime.hasActiveTransport()).toBe(false);
  });

  it.each([
    { name: "no arguments", args: "", opensMenu: true },
    { name: "whitespace", args: " \t ", opensMenu: true },
    { name: "legacy connection arguments", args: "fake-token -100123 123", opensMenu: false },
    { name: "legacy auto-close arguments", args: "fake-token -100123 123 on", opensMenu: false },
  ])("handles $name at the command boundary", async ({ args, opensMenu }) => {
    const pi = { registerCommand: vi.fn(), on: vi.fn() };
    const ctx = { ui: { notify: vi.fn() } };
    const setup = vi.spyOn(MuxRuntime.prototype, "handleTgSetup").mockResolvedValue();
    activateExtension(pi as any);
    const command = pi.registerCommand.mock.calls.find(([name]) => name === "tg-setup")![1];
    await command.handler(args, ctx);
    if (opensMenu) {
      expect(setup).toHaveBeenCalledExactlyOnceWith(ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } else {
      expect(setup).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Run /tg-setup without arguments to open settings.", "warning");
    }
  });
});

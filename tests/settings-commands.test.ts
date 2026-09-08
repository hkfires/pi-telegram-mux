import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { getConfigDir, getConfigPath, loadConfig, saveConfig, withConfigLock } from "../src/config.js";
import { encodeFrame, IpcFollowerClient } from "../src/ipc.js";
import { MuxRuntime } from "../src/runtime.js";
import { TelegramApiError, TelegramClient, TelegramDecodeError, TelegramRequestError } from "../src/telegram.js";
import type { TelegramInlineKeyboardMarkup, TelegramUpdate } from "../src/types.js";
import { runtimeFixture, telegramUpdate, testConfig } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
const coordinatorOf = (f: Fixture) => (f.runtime as unknown as { coordinator: LeaderCoordinator }).coordinator;

describe("Telegram session settings commands", () => {
  let dir: string;
  const fixtures: Fixture[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-settings-")); });
  afterEach(async () => {
    for (const f of fixtures.reverse()) await f.runtime.onSessionShutdown(f.ctx);
    fixtures.length = 0;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function fixture(id = "leader", thread = 50) {
    const f = await runtimeFixture(dir, id, thread);
    fixtures.push(f);
    const models = [{ provider: "provider", id: "model/one" }, { provider: "other", id: "two" }];
    let model = models[0];
    let thinking = "medium";
    Object.assign(f.ctx, { modelRegistry: { getAvailable: vi.fn(() => models) }, scopedModels: [] });
    Object.defineProperty(f.ctx, "model", { get: () => model });
    const settings = {
      getThinkingLevel: vi.fn(() => thinking),
      setThinkingLevel: vi.fn((level: string) => { thinking = level === "max" ? "high" : level; }),
      setModel: vi.fn(async (value: typeof model) => { model = value; return true; }),
    };
    Object.assign(f.pi, settings);
    return { ...f, settings, models };
  }

  it("lists models and thinking without sending a prompt or reserving admission", async () => {
    const f = await fixture();
    const result = await f.runtime.handleInboundText("/model", f.ctx);
    expect(result.statusReply).toContain("Model: provider/model/one");
    expect(result.menu?.flat()).toContainEqual({ text: "other/two", command: "/model other/two" });
    expect(result.statusReply).toContain("Thinking: medium");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.runtime.getIsIdle()).toBe(true);
    expect((await f.runtime.handleInboundText("/thinking", f.ctx)).statusReply).toContain("/thinking <level>");
  });

  it("keeps model and thinking menus independent without cross-navigation buttons", async () => {
    const f = await fixture();
    for (let n = 0; n < 8; n++) f.models.push({ provider: "p", id: `m${n}` });
    for (const command of ["/model", "/model page 2"]) {
      const buttons = (await f.runtime.handleInboundText(command, f.ctx)).menu!.flat();
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every(button => button.command.startsWith("/model "))).toBe(true);
    }
    const levels = (await f.runtime.handleInboundText("/thinking", f.ctx)).menu!.flat();
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every(button => button.command.startsWith("/thinking "))).toBe(true);
  });

  it("uses English for menu labels and instructions", async () => {
    const f = await fixture();
    for (let n = 0; n < 8; n++) f.models.push({ provider: "p", id: `m${n}` });
    for (const command of ["/model", "/model page 2", "/model other/two", "/thinking", "/thinking high"]) {
      const result = await f.runtime.handleInboundText(command, f.ctx);
      if (["/model other/two", "/thinking high"].includes(command)) expect(result.menu).toBeUndefined();
      else expect(result.menu).toBeDefined();
      expect(JSON.stringify(result)).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it("switches an exact provider/model identifier and handles bot suffixes", async () => {
    const f = await fixture();
    const result = await f.runtime.handleInboundText("/model@fixture_bot other/two", f.ctx);
    expect(f.settings.setModel).toHaveBeenCalledWith(f.models[1]);
    expect(result.statusReply).toContain("Model: other/two");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports the effective thinking level after Pi clamps it", async () => {
    const f = await fixture();
    expect((await f.runtime.handleInboundText("/thinking high", f.ctx)).statusReply).toBe("Thinking: high");
    expect((await f.runtime.handleInboundText("/thinking max", f.ctx)).statusReply).toContain("requested max; adjusted");
    const calls = f.settings.setThinkingLevel.mock.calls.length;
    expect((await f.runtime.handleInboundText("/thinking nonsense", f.ctx)).statusReply).toContain("Invalid thinking level");
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(calls);
  });

  it("respects scoped models and rejects unknown models without prompting", async () => {
    const f = await fixture();
    Object.assign(f.ctx, { scopedModels: [{ model: f.models[0] }] });
    expect((await f.runtime.handleInboundText("/model", f.ctx)).menu?.flat().some(button => button.command === "/model other/two")).toBe(false);
    for (const text of ["/model other/two", "/model nonexistent", "/model two"]) {
      expect((await f.runtime.handleInboundText(text, f.ctx)).statusReply).toContain("Model unavailable");
    }
    expect(f.settings.setModel).not.toHaveBeenCalled();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("paginates the model list and validates pages", async () => {
    const f = await fixture();
    for (let n = 0; n < 15; n++) f.models.push({ provider: "p", id: `m${n}` });
    expect((await f.runtime.handleInboundText("/model", f.ctx)).menu?.flat()).toContainEqual({ text: "Next ›", command: "/model page 2" });
    expect((await f.runtime.handleInboundText("/model page 3", f.ctx)).menu?.flat()).toContainEqual({ text: "p/m14", command: "/model p/m14" });
    expect((await f.runtime.handleInboundText("/model page 99", f.ctx)).statusReply).toContain("Invalid page");
    expect(f.settings.setModel).not.toHaveBeenCalled();
  });

  it("allows /model and /thinking changes while Pi is busy", async () => {
    const f = await fixture();
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    const thinkingResult = await f.runtime.handleInboundText("/thinking high", f.ctx);
    expect(thinkingResult.busy).toBe(false);
    expect(thinkingResult.accepted).toBe(true);
    expect(thinkingResult.statusReply).toContain("Thinking: high");
    expect(f.settings.setThinkingLevel).toHaveBeenCalledWith("high");

    const modelResult = await f.runtime.handleInboundText("/model other/two", f.ctx);
    expect(modelResult.busy).toBe(false);
    expect(modelResult.accepted).toBe(true);
    expect(modelResult.statusReply).toContain("Model: other/two");
    expect(f.settings.setModel).toHaveBeenCalledWith(f.models[1]);
  });

  it.each(["/model other/two", "/thinking high"])("blocks %s until a timed-out input is actually admitted", async command => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const admission = f.runtime.handleInboundText("delayed input", f.ctx, 100);
      expect((await f.runtime.handleInboundText(command, f.ctx)).busy).toBe(true);
      await vi.advanceTimersByTimeAsync(2001);
      expect(await admission).toMatchObject({ accepted: false, statusReply: expect.stringContaining("unknown") });
      expect((await f.runtime.handleInboundText(command, f.ctx)).busy).toBe(true);
      expect(f.settings.setModel).not.toHaveBeenCalled();
      expect(f.settings.setThinkingLevel).not.toHaveBeenCalled();
      expect(f.runtime.onInput(f.ctx)).toBeUndefined();

      await f.inInput(() => f.runtime.onBeforeAgentStart({ prompt: "delayed input" }, f.ctx));
      f.runtime.onMessageStart({ role: "user", content: "delayed input" }, f.ctx);
      expect((await f.runtime.handleInboundText(command, f.ctx)).accepted).toBe(true);
      await f.runtime.onAgentSettled(f.ctx);
      expect(f.runtime.getIsIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["followUp", "success"], ["followUp", "failure"],
    ["steer", "success"], ["steer", "failure"],
  ] as const)("keeps queued %s input when a later model change settles with %s", async (mode, outcome) => {
    const f = await fixture();
    vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_id: 900 } as any);
    await f.runtime.onBeforeAgentStart({ prompt: "initial task" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "initial task" }, f.ctx);
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    let finishModel!: (value: boolean) => void;
    let rejectModel!: (error: Error) => void;
    f.settings.setModel.mockImplementation(() => new Promise((resolve, reject) => {
      finishModel = resolve;
      rejectModel = reject;
    }));
    expect((await f.runtime.handleInboundText("queued busy prompt", f.ctx, 101, mode)).accepted).toBe(true);
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.pi.sendMessage).toHaveBeenCalledWith({
      customType: "Telegram", content: "queued busy prompt", display: true,
      details: { runtimeId: expect.any(String), deliveryId: expect.any(String) },
    }, { triggerTurn: true, deliverAs: mode });
    const changing = f.runtime.handleInboundText("/model other/two", f.ctx);
    try {
      expect(f.settings.setModel).toHaveBeenCalledTimes(1);
      expect((await f.runtime.handleInboundText("new remote prompt", f.ctx)).busy).toBe(true);
      const setEditorText = vi.fn();
      Object.assign(f.ctx.ui, { setEditorText });
      expect(f.runtime.onInput(f.ctx, "new local prompt")).toEqual({ action: "handled" });
      expect(setEditorText).toHaveBeenCalledWith("new local prompt");
      if (outcome === "success") finishModel(true);
      else rejectModel(new Error("Fixture model change failed"));
      await changing;
      const [queuedMessage] = f.pi.sendMessage.mock.calls[0];
      f.runtime.onMessageStart({ ...queuedMessage, role: "custom" }, f.ctx);
      await f.runtime.outbox.whenIdle();
      expect(f.runtime.callTelegram).toHaveBeenCalledWith("setMessageReaction", expect.objectContaining({
        message_id: 101, reaction: [{ type: "emoji", emoji: "👀" }],
      }), expect.anything(), expect.anything());
      expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
      await f.runtime.onAgentSettled(f.ctx);
      expect(f.runtime.getIsIdle()).toBe(true);
    } finally {
      finishModel(true);
      await changing;
    }
  });

  it("serializes remote settings against other inbound messages", async () => {
    const f = await fixture();
    let release!: (result: boolean) => void;
    f.settings.setModel.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const changing = f.runtime.handleInboundText("/model other/two", f.ctx);
    expect(f.runtime.getIsIdle()).toBe(false);
    expect((await f.runtime.handleInboundText("/thinking high", f.ctx)).busy).toBe(true);
    expect((await f.runtime.handleInboundText("hello", f.ctx)).busy).toBe(true);
    release(true);
    await changing;
    expect(f.runtime.getIsIdle()).toBe(true);
  });

  it("bounds slow settings without releasing their reservation or blocking another topic's stop", async () => {
    vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({} as any);
    const f = await fixture();
    const other = await fixture("other", 51);
    let release!: (result: boolean) => void;
    f.settings.setModel.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await coordinatorOf(f).processUpdate(telegramUpdate(50, "/model other/two"));
    expect(f.runtime.getIsIdle()).toBe(false);
    await coordinatorOf(f).processUpdate(telegramUpdate(51, "/stop", 2));
    expect(other.ctx.abort).toHaveBeenCalled();
    expect((await f.runtime.handleInboundText("/thinking high", f.ctx)).busy).toBe(true);
    release(true);
    await vi.waitFor(() => expect(f.runtime.getIsIdle()).toBe(true));
    expect(f.settings.setModel).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending model barrier across reload without hanging shutdown or losing typed input", async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const apply = f.settings.setModel.getMockImplementation()!;
    f.settings.setModel.mockImplementation(async model => { await barrier; return apply(model); });
    const changing = f.runtime.handleInboundText("/model other/two", f.ctx);
    const setEditorText = vi.fn();
    Object.assign(f.ctx.ui, { setEditorText });
    expect(f.runtime.onInput(f.ctx, "keep this prompt")).toEqual({ action: "handled" });
    expect(setEditorText).toHaveBeenCalledWith("keep this prompt");
    expect(await f.runtime.onSessionBeforeTree()).toEqual({ cancel: true });
    expect(await f.runtime.onSessionBeforeSwitch(f.ctx)).toEqual({ cancel: true });
    expect(await f.runtime.onSessionBeforeFork(f.ctx)).toEqual({ cancel: true });
    try {
      await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
      expect(f.runtime.hasActiveTransport()).toBe(false);
      expect(f.ctx.model!.id).toBe("model/one");
      const reloaded = await fixture();
      expect(reloaded.runtime.getIsIdle()).toBe(false);
      expect(reloaded.runtime.onInput(reloaded.ctx)).toEqual({ action: "handled" });
      expect(await reloaded.runtime.onSessionBeforeSwitch(reloaded.ctx)).toEqual({ cancel: true });
      expect((await reloaded.runtime.handleInboundText("/model other/two", reloaded.ctx)).busy).toBe(true);
      expect(reloaded.ui.notify).toHaveBeenCalledWith(expect.stringContaining("quit and restart Pi"), "warning");
      release();
      expect((await changing).statusReply).toContain("Session changed");
      expect(reloaded.runtime.getIsIdle()).toBe(true);
      expect(reloaded.runtime.onInput(reloaded.ctx)).toBeUndefined();
      expect(f.ctx.model!.id).toBe("two");
    } finally { release(); await changing; }
  });

  it("reports a safe restart path on timeout and lets Pi quit while the provider is still pending", async () => {
    const f = await fixture();
    let release!: (result: boolean) => void;
    f.settings.setModel.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const result = await f.runtime.handleInboundText("/model other/two", f.ctx);
    try {
      expect(result.statusReply).toContain("quit and restart Pi");
      expect(result.statusReply).toContain("/reload cannot cancel");
      expect(f.runtime.getIsIdle()).toBe(false);
      await f.runtime.onSessionShutdown({ reason: "quit" }, f.ctx);
      expect(f.runtime.hasActiveTransport()).toBe(false);
    } finally {
      release(false);
      await vi.waitFor(() => expect((f.runtime as any).settingsCommandInFlight).toBe(false));
    }
  });

  it("bounds feedback for oversized Unicode model identifiers", async () => {
    const f = await fixture();
    f.models[0].id = "😀".repeat(3000);
    const result = await f.runtime.handleInboundText("/model", f.ctx);
    expect(result.statusReply!.length).toBeLessThanOrEqual(4096);
    expect(result.statusReply).toContain("List truncated");
    expect(result.statusReply!.isWellFormed()).toBe(true);
  });

  it("continues polling when menu registration fails", async () => {
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "setMyCommands") return Promise.reject(new Error("Menu registration failed"));
      return original.call(this, method, ...args);
    });
    const poll = vi.spyOn(TelegramClient.prototype, "getUpdates");
    const f = await fixture();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    expect(coordinatorOf(f).getStatus().feedbackError).toBeUndefined();
    expect(coordinatorOf(f).getStatus().commandMenuError).toBeDefined();
    expect((await f.runtime.handleInboundText("/thinking high", f.ctx)).statusReply).toBe("Thinking: high");
  });

  it("does not expose provider errors and recovers after failed settings", async () => {
    const f = await fixture();
    f.settings.setModel.mockResolvedValueOnce(false);
    expect((await f.runtime.handleInboundText("/model other/two", f.ctx)).statusReply).toContain("authentication");
    f.settings.setModel.mockRejectedValueOnce(new Error("SECRET_TOKEN"));
    const result = await f.runtime.handleInboundText("/model other/two", f.ctx);
    expect(result.statusReply).toContain("failed or result unknown");
    expect(result.statusReply).not.toContain("SECRET_TOKEN");
    expect(result.accepted).toBe(false);
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_MODEL_AUTH_UNAVAILABLE"), "error");
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_MODEL_CHANGE_FAILED"), "error");
    f.runtime.handleTgStatus(f.ctx);
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Settings error: PI_MODEL_CHANGE_FAILED"), "info");
    expect(JSON.stringify(f.ui.notify.mock.calls)).not.toContain("SECRET_TOKEN");
    expect(f.runtime.getIsIdle()).toBe(true);
    await f.runtime.handleInboundText("/model other/two", f.ctx);
    f.runtime.handleTgStatus(f.ctx);
    expect(f.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Settings error: none"), "info");
  });

  it("records credential-safe diagnostics when a model change fails after the Telegram deadline", async () => {
    const f = await fixture();
    let reject!: (error: Error) => void;
    f.settings.setModel.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const result = await f.runtime.handleInboundText("/model other/two", f.ctx);
    expect(result.statusReply).toContain("result unknown");
    const reference = /reference ([a-f\d-]+)/.exec(result.statusReply!)![1];
    reject(Object.assign(new Error("SECRET_PROVIDER_CREDENTIAL"), { code: "ETIMEDOUT" }));
    await vi.waitFor(() => expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`PI_MODEL_CHANGE_FAILED (reference ${reference}) [ETIMEDOUT]`), "error"));
    f.runtime.handleTgStatus(f.ctx);
    expect(f.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(reference), "info");
    expect(JSON.stringify(f.ui.notify.mock.calls)).not.toContain("SECRET_PROVIDER_CREDENTIAL");
    expect(f.runtime.getIsIdle()).toBe(true);
  });

  it("reports late errors without using a stale UI after shutdown", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    let reject!: (error: Error) => void;
    f.settings.setModel.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const changing = f.runtime.handleInboundText("/model other/two", f.ctx);
    await f.runtime.onSessionShutdown({ reason: "reload" }, f.ctx);
    f.ui.notify.mockClear();
    reject(Object.assign(new Error("SECRET_AFTER_RELOAD"), { code: "SECRET_CODE" }));
    const result = await changing;
    expect(result.accepted).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PI_MODEL_CHANGE_FAILED"));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
    expect(f.ui.notify).not.toHaveBeenCalled();
  });

  it("reports a failed thinking setter as an error, not a successful operation", async () => {
    const f = await fixture();
    f.settings.setThinkingLevel.mockImplementationOnce(() => { throw new Error("SECRET_THINKING_ERROR"); });
    const result = await f.runtime.handleInboundText("/thinking high", f.ctx);
    expect(result.accepted).toBe(false);
    expect(result.statusReply).toContain("PI_THINKING_CHANGE_FAILED");
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PI_THINKING_CHANGE_FAILED"), "error");
    expect(JSON.stringify([result, f.ui.notify.mock.calls])).not.toContain("SECRET_THINKING_ERROR");
  });

  it("routes commands through IPC to the correct topic without changing the Leader session", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({} as any);
    const leader = await fixture();
    const follower = await fixture("follower", 51);
    await vi.waitFor(() => expect(coordinatorOf(leader).getRoutes().has(51)).toBe(true));
    await coordinatorOf(leader).processUpdate(telegramUpdate(51, "/model@fixture_bot other/two"));
    await coordinatorOf(leader).feedback.whenIdle();
    expect(follower.settings.setModel).toHaveBeenCalledWith(follower.models[1]);
    expect(leader.settings.setModel).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(testConfig.chatId, expect.stringContaining("Model: other/two"), { message_thread_id: 51 }, expect.any(AbortSignal));
    await coordinatorOf(leader).processUpdate(telegramUpdate(51, "/thinking high", 2));
    expect(follower.settings.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(leader.settings.setThinkingLevel).not.toHaveBeenCalled();
    expect(follower.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("retains user authorization and other-bot filtering", async () => {
    const f = await fixture();
    const unauthorized = telegramUpdate(50, "/thinking high");
    unauthorized.message!.from!.id++;
    await coordinatorOf(f).processUpdate(unauthorized);
    await coordinatorOf(f).processUpdate(telegramUpdate(50, "/thinking@other_bot high"));
    expect(f.settings.setThinkingLevel).not.toHaveBeenCalled();
  });

  function click(data: string, thread = 50, messageId = 900): TelegramUpdate {
    return { update_id: 2, callback_query: {
      id: "query-1", data, from: { id: testConfig.allowedUserId, is_bot: false, first_name: "User" },
      message: { message_id: messageId, message_thread_id: thread, date: 1, chat: { id: testConfig.chatId, type: "supergroup" } },
    } };
  }

  function button(markup: TelegramInlineKeyboardMarkup, label: string): string {
    const found = markup.inline_keyboard.flat().find(button => button.text.includes(label));
    expect(found, `Missing button ${label}`).toBeDefined();
    return found!.callback_data;
  }

  it.each(["leader", "follower"])("opens a model menu and switches the %s session by clicking", async owner => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const leader = await fixture();
    const f = owner === "follower" ? await fixture("follower", 51) : leader;
    const thread = owner === "follower" ? 51 : 50;
    const coordinator = coordinatorOf(leader);
    await coordinator.processUpdate(telegramUpdate(thread, "/model"));
    await coordinator.feedback.whenIdle();
    const markup = send.mock.calls.at(-1)![2]!.reply_markup!;
    expect(markup.inline_keyboard[0][0].text).toBe("✓ provider/model/one");
    const data = button(markup, "other/two");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data).not.toContain("other/two");
    await coordinator.processUpdate(click(data, thread));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setModel).toHaveBeenCalledWith(f.models[1]);
    if (owner === "follower") expect(leader.settings.setModel).not.toHaveBeenCalled();
    const edit = api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)!;
    expect(edit[1]).toMatchObject({ chat_id: testConfig.chatId, message_id: 900, text: "Model: other/two\nThinking: medium" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(edit[1]!.reply_markup).toEqual({ inline_keyboard: [] });
    expect((coordinator as any).menus.size).toBe(0);
    await coordinator.processUpdate(click(data, thread));
    expect(f.settings.setModel).toHaveBeenCalledTimes(1);
    // A completed selection closes the menu. Open a new one to choose thinking.
    await coordinator.processUpdate(telegramUpdate(thread, "/thinking", 3));
    await coordinator.feedback.whenIdle();
    const thinking = send.mock.calls.at(-1)![2]!.reply_markup!;
    const high = thinking.inline_keyboard.flat().find(item => item.text === "high")!.callback_data;
    await coordinator.processUpdate(click(high, thread));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setThinkingLevel).toHaveBeenCalledWith("high");
    const selected = api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)![1]!.reply_markup as TelegramInlineKeyboardMarkup;
    expect(selected.inline_keyboard).toEqual([]);
    expect((coordinator as any).menus.size).toBe(0);
    expect(api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)![1]!.text).toBe("Thinking: high");
    await coordinator.processUpdate(click(high, thread));
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.filter(call => call[0] === "answerCallbackQuery").at(-1)![1]).toMatchObject({ show_alert: true });
  });

  it.each(["leader", "follower"])("switches the %s model without waiting for a click acknowledgement that times out", async owner => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    let rejectAnswer!: (error: Error) => void;
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "answerCallbackQuery") return new Promise((_resolve, reject) => { rejectAnswer = reject; });
      return original.call(this, method, ...args);
    });
    const leader = await fixture();
    const f = owner === "follower" ? await fixture("follower", 51) : leader;
    const thread = owner === "follower" ? 51 : 50;
    const coordinator = coordinatorOf(leader);
    await coordinator.processUpdate(telegramUpdate(thread, "/model"));
    await coordinator.feedback.whenIdle();
    const data = button(send.mock.calls[0][2]!.reply_markup!, "other/two");
    await coordinator.processUpdate(click(data, thread));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setModel).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.find(call => call[0] === "answerCallbackQuery")![2]).toBe(5000);
    expect(api.mock.calls.find(call => call[0] === "editMessageText")![1]).toMatchObject({ text: "Model: other/two\nThinking: medium", reply_markup: { inline_keyboard: [] } });
    expect((coordinator as any).callbackAnswersInFlight).toBe(1);
    rejectAnswer(new TelegramRequestError("TELEGRAM_TIMEOUT", "Telegram request timed out (answerCallbackQuery)"));
    await vi.waitFor(() => expect((coordinator as any).callbackAnswersInFlight).toBe(0));
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(coordinator.feedback.error).toBeNull();
    expect(f.settings.setModel).toHaveBeenCalledTimes(1);
    await coordinator.processUpdate(telegramUpdate(thread, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(send.mock.calls.at(-1)![1]).toContain("Topic: Online");
  });

  it.each([
    new TelegramRequestError("ECONNRESET", "Connection reset"),
    new TelegramApiError("HTTP 502", 502),
    new TelegramApiError("Bad Request: query is too old and response timeout expired or query ID is invalid", 400),
  ])("does not turn a best-effort click acknowledgement failure into a global error (%s)", async error => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "answerCallbackQuery") return Promise.reject(error);
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    await vi.waitFor(() => expect((coordinator as any).callbackAnswersInFlight).toBe(0));
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(coordinator.feedback.error).toBeNull();
  });

  it("still exposes non-transient click acknowledgement failures without retrying a selection", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "answerCallbackQuery") return Promise.reject(new TelegramApiError("Unauthorized", 401));
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await vi.waitFor(() => expect(coordinator.getStatus().feedbackError?.message).toBe("Unauthorized"));
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
  });

  it("bounds background acknowledgements without blocking selections and releases capacity", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    const answers: Array<() => void> = [];
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "answerCallbackQuery") return new Promise(resolve => { answers.push(() => resolve(true)); });
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    for (let n = 0; n < 40; n++) await coordinator.processUpdate(click("mux:000000000000000000000000:0"));
    expect(api.mock.calls.filter(call => call[0] === "answerCallbackQuery")).toHaveLength(32);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.filter(call => call[0] === "answerCallbackQuery")).toHaveLength(32);
    answers.forEach(resolve => resolve());
    await vi.waitFor(() => expect((coordinator as any).callbackAnswersInFlight).toBe(0));
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
  });

  it("cancels pending acknowledgements at shutdown without publishing stale errors", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    let answerSignal: AbortSignal | undefined;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "answerCallbackQuery") {
        answerSignal = args[2];
        return new Promise((_resolve, reject) => {
          answerSignal!.addEventListener("abort", () => reject(new TelegramRequestError("TELEGRAM_ABORTED", "Aborted")), { once: true });
        });
      }
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    expect(answerSignal?.aborted).toBe(false);
    await f.runtime.onSessionShutdown(f.ctx);
    expect(answerSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect((coordinator as any).callbackAnswersInFlight).toBe(0));
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
  });

  it("paginates inline without changing a model or sending additional messages", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const f = await fixture();
    for (let n = 0; n < 15; n++) f.models.push({ provider: "p", id: `m${n}` });
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/model"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "Next")));
    await coordinator.feedback.whenIdle();
    const next = api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)![1]!;
    expect(next.text).toContain("(2/3)");
    await coordinator.processUpdate(click(button(next.reply_markup as TelegramInlineKeyboardMarkup, "Previous")));
    await coordinator.feedback.whenIdle();
    expect(api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)![1]!.text).toContain("(1/3)");
    expect(f.settings.setModel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthorized, copied, forged and inaccessible callbacks without consuming valid choices", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    const data = button(send.mock.calls[0][2]!.reply_markup!, "high");
    const unauthorized = click(data);
    unauthorized.callback_query!.from.id++;
    const bot = click(data);
    bot.callback_query!.from.is_bot = true;
    const wrongChat = click(data);
    wrongChat.callback_query!.message!.chat.id--;
    const inaccessible = click(data);
    inaccessible.callback_query!.message!.date = 0;
    const inline = click(data);
    delete inline.callback_query!.message;
    for (const update of [unauthorized, bot, wrongChat, inaccessible, inline, click(data, 51), click(data, 50, 901), click("mux:000000000000000000000000:0")]) {
      await coordinator.processUpdate(update);
    }
    expect(f.settings.setThinkingLevel).not.toHaveBeenCalled();
    await coordinator.processUpdate(click(data));
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
  });

  it.each(["new-menu", "generation", "expiry", "route-replacement"])("rejects a stale menu after %s", async reason => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    const data = button(send.mock.calls[0][2]!.reply_markup!, "high");
    if (reason === "new-menu") {
      await coordinator.processUpdate(telegramUpdate(50, "/model", 3));
      await coordinator.feedback.whenIdle();
    } else if (reason === "generation") {
      await f.runtime.onSessionBeforeTree();
      await f.runtime.outbox.whenIdle();
    } else if (reason === "expiry") {
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 600_001);
    } else {
      const route = coordinator.getRoutes().get(50)!;
      coordinator.unregisterLocalRoute(50, route.runtimeId);
      coordinator.registerLocalRoute({ ...route, sessionId: "replacement" });
    }
    await coordinator.processUpdate(click(data));
    expect(f.settings.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("acknowledges once and rejects a double click while the first action is pending", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/model"));
    await coordinator.feedback.whenIdle();
    const data = button(send.mock.calls[0][2]!.reply_markup!, "other/two");
    let release!: (result: boolean) => void;
    f.settings.setModel.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = coordinator.processUpdate(click(data));
    await vi.waitFor(() => expect(f.settings.setModel).toHaveBeenCalledTimes(1));
    await coordinator.processUpdate(click(data));
    expect(f.settings.setModel).toHaveBeenCalledTimes(1);
    release(true);
    await first;
  });

  it("applies settings change via button click even while Pi is busy", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setThinkingLevel).toHaveBeenCalledWith("high");
    const edit = api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)![1]!;
    expect(edit.text).toContain("Thinking: high");
  });

  it("clears buttons and explains a busy session when settings dispatch is busy", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    vi.spyOn(f.runtime, "handleInboundText").mockResolvedValueOnce({ accepted: false, busy: true });
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setThinkingLevel).not.toHaveBeenCalled();
    const edit = api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)![1]!;
    expect(edit.text).toContain("busy");
    expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("uses short opaque tokens even for long model identifiers", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const f = await fixture();
    f.models[1].id = "long-model-".repeat(30);
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/model"));
    await coordinator.feedback.whenIdle();
    const choice = send.mock.calls[0][2]!.reply_markup!.inline_keyboard[1][0];
    expect(choice.text.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(choice.callback_data)).toBeLessThanOrEqual(64);
    await coordinator.processUpdate(click(choice.callback_data));
    expect(f.settings.setModel).toHaveBeenCalledWith(f.models[1]);
  });

  it.each(["Bad Request: message to edit not found", "Unrecognized localized response", "Completely different server wording"])("isolates an edit HTTP 400 regardless of description (%s)", async description => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValueOnce({ message_id: 900 } as any).mockResolvedValue({ message_id: 901 } as any);
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "editMessageText") return Promise.reject(new TelegramApiError(description, 400));
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    await fixture("other", 51);
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toContain("settings menu could not be updated (HTTP 400)");
    expect(coordinator.getStatus().interactionError?.code).toBe("TELEGRAM_MENU_REJECTED");
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TELEGRAM_MENU_REJECTED"), "warning");
    expect(coordinator.feedback.error).toBeNull();
    expect(send.mock.calls[1][2]!.reply_markup).toBeUndefined();
    expect((coordinator as any).menus.size).toBe(0);
    // Opening a new menu binds it to its new message, not the deleted one.
    await coordinator.processUpdate(telegramUpdate(50, "/thinking", 3));
    await coordinator.feedback.whenIdle();
    const fallback = button(send.mock.calls[2][2]!.reply_markup!, "low");
    await coordinator.processUpdate(click(fallback));
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    await coordinator.processUpdate(click(fallback, 50, 901));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setThinkingLevel).toHaveBeenCalledWith("low");
    await coordinator.processUpdate(telegramUpdate(51, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(send.mock.calls.at(-1)![2]).toEqual({ message_thread_id: 51 });
  });

  it("isolates an unmatched callback HTTP 400 and exposes a warning without breaking other topics", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "answerCallbackQuery") return Promise.reject(new TelegramApiError("Unrecognized response with SECRET_TEXT", 400));
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    const other = await fixture("other", 51);
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    await vi.waitFor(() => expect(other.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TELEGRAM_CALLBACK_REJECTED"), "warning"));
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(coordinator.feedback.error).toBeNull();
    expect(JSON.stringify([coordinator.getStatus(), f.ui.notify.mock.calls, other.ui.notify.mock.calls])).not.toContain("SECRET_TEXT");
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    await coordinator.processUpdate(telegramUpdate(51, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(send.mock.calls.at(-1)![2]).toEqual({ message_thread_id: 51 });
  });

  it("contains HTTP 400 when even the single menu failure notice is rejected", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage")
      .mockResolvedValueOnce({ message_id: 900 } as any)
      .mockRejectedValueOnce(new TelegramApiError("Unmatched notice error", 400))
      .mockResolvedValue({ message_id: 901 } as any);
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "editMessageText") return Promise.reject(new TelegramApiError("Unmatched edit error", 400));
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    await fixture("other", 51);
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(coordinator.getStatus().interactionError?.code).toBe("TELEGRAM_MENU_REJECTED");
    expect(coordinator.feedback.error).toBeNull();
    await coordinator.processUpdate(telegramUpdate(51, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("isolates a menu creation HTTP 400 without retrying it or stopping feedback", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage")
      .mockRejectedValueOnce(new TelegramApiError("Unmatched create error", 400))
      .mockResolvedValue({ message_id: 900 } as any);
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/model"));
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(coordinator.feedback.error).toBeNull();
    expect((coordinator as any).menus.size).toBe(0);
    expect(coordinator.getStatus().interactionError?.code).toBe("TELEGRAM_MENU_REJECTED");
    await coordinator.processUpdate(telegramUpdate(50, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  describe.each([
    new TelegramRequestError("TELEGRAM_TIMEOUT", "Telegram request timed out"),
    new TelegramRequestError("ECONNRESET", "SECRET_TEXT"),
    new TelegramApiError("HTTP 503", 503),
  ])("transient menu feedback failure (%s)", error => {
    it.each(["sendMessage", "editMessageText"])("isolates %s without replaying a selection or retaining unknown menu buttons", async method => {
      const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
      if (method === "sendMessage") send.mockRejectedValueOnce(error);
      const original = TelegramClient.prototype.callApi;
      const call = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (name, ...args) {
        if (name === "editMessageText") return Promise.reject(error);
        return original.call(this, name, ...args);
      });
      const f = await fixture();
      const other = await fixture("other", 51);
      const coordinator = coordinatorOf(f);
      await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
      await coordinator.feedback.whenIdle();
      const token = button(send.mock.calls[0][2]!.reply_markup!, "high");
      await coordinator.processUpdate(click(token));
      await coordinator.feedback.whenIdle();
      expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(method === "editMessageText" ? 1 : 0);
      expect(coordinator.feedback.error).toBeNull();
      expect(coordinator.getStatus().feedbackError).toBeUndefined();
      expect(coordinator.getStatus().interactionError?.code).toBe(error.code);
      expect((coordinator as any).menus.size).toBe(0);
      await vi.waitFor(() => expect(other.ui.notify).toHaveBeenCalledWith(expect.stringContaining(error.code), "warning"));
      expect(JSON.stringify([coordinator.getStatus(), f.ui.notify.mock.calls, other.ui.notify.mock.calls])).not.toContain("SECRET_TEXT");
      // Even if Telegram accepted an unconfirmed menu, its buttons cannot execute.
      await coordinator.processUpdate(click(token));
      await coordinator.feedback.whenIdle();
      expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(method === "editMessageText" ? 1 : 0);
      expect(call.mock.calls.filter(([name]) => name === "editMessageText")).toHaveLength(method === "editMessageText" ? 1 : 0);
      expect(send).toHaveBeenCalledTimes(1);
      await coordinator.processUpdate(telegramUpdate(51, "/status", 3));
      await coordinator.feedback.whenIdle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][2]).toEqual({ message_thread_id: 51 });
    });
  });

  it.each([new TelegramApiError("Unauthorized", 401), new TelegramDecodeError("Malformed JSON")])("does not hide transport/authentication/decoding failures at the menu boundary (%s)", async error => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const original = TelegramClient.prototype.callApi;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "editMessageText") return Promise.reject(error);
      return original.call(this, method, ...args);
    });
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high")));
    await coordinator.feedback.whenIdle();
    expect(coordinator.feedback.error).toBe(error);
    expect(coordinator.getStatus().feedbackError).toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.settings.setThinkingLevel).toHaveBeenCalledTimes(1);
  });

  it("bounds the ephemeral menu ledger and invalidates evicted tokens", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    const dispatchInbound = vi.fn(async () => ({ accepted: true, busy: false, statusReply: "Choose", menu: [[{ text: "high", command: "/thinking high" }]] }));
    for (let n = 0; n < 129; n++) {
      coordinator.registerLocalRoute({ runtimeId: `r${n}`, sessionId: `s${n}`, generation: 1, threadId: 100 + n, dispatchInbound });
      await coordinator.processUpdate(telegramUpdate(100 + n, "/thinking", n));
      await coordinator.feedback.whenIdle();
    }
    expect((coordinator as any).menus.size).toBe(128);
    const calls = dispatchInbound.mock.calls.length;
    await coordinator.processUpdate(click(button(send.mock.calls[0][2]!.reply_markup!, "high"), 100));
    expect(dispatchInbound).toHaveBeenCalledTimes(calls);
  });

  it("does not publish unsafe menu actions from a runtime", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage");
    const f = await fixture();
    vi.spyOn(f.runtime, "handleInboundText").mockResolvedValue({ accepted: true, busy: false, statusReply: "Choose", menu: [[{ text: "Unsafe", command: "/stop" }]] });
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/model"));
    await coordinator.feedback.whenIdle();
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.getStatus().feedbackError?.code).toBe("INVALID_SETTINGS_MENU");
  });

  it("subscribes to callback queries along with messages", async () => {
    const poll = vi.spyOn(TelegramClient.prototype, "getUpdates");
    await fixture();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    expect(poll.mock.calls[0][0]!.allowed_updates).toEqual(["message", "callback_query"]);
  });

  it.each(["answerCallbackQuery", "editMessageText"])("drops feedback after a real HTTP 429 from %s and accepts fresh work after cooldown", async rejectedMethod => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; at: number; params: any }> = [];
    let rejectedAt = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1)!;
      if (!["answerCallbackQuery", "editMessageText", "sendMessage"].includes(method)) return originalFetch(input, init);
      const at = Date.now();
      requests.push({ method, at, params: JSON.parse(init!.body as string) });
      if (method === rejectedMethod && !rejectedAt) {
        rejectedAt = at;
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }), { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 900 } }));
    });
    const f = await fixture();
    await fixture("other", 51);
    const apply = f.settings.setModel.getMockImplementation()!;
    f.settings.setModel.mockImplementation(async model => { await new Promise(resolve => setTimeout(resolve, 30)); return apply(model); });
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/model"));
    await coordinator.feedback.whenIdle();
    const markup = requests.find(request => request.method === "sendMessage")!.params.reply_markup as TelegramInlineKeyboardMarkup;
    await coordinator.processUpdate(click(button(markup, "other/two")));
    await coordinator.processUpdate(telegramUpdate(51, "/status", 3));
    await coordinator.feedback.whenIdle();
    expect(f.settings.setModel).toHaveBeenCalledTimes(1);
    const edits = requests.filter(request => request.method === "editMessageText");
    expect(edits).toHaveLength(rejectedMethod === "editMessageText" ? 1 : 0);
    expect(coordinator.getStatus().rateLimitUntil).toBeGreaterThan(Date.now());
    await vi.waitFor(() => expect(coordinator.getStatus().rateLimitUntil).toBeUndefined(), { timeout: 2000 });
    expect(requests.filter(request => request.method === "editMessageText")).toHaveLength(edits.length);
    await coordinator.processUpdate(telegramUpdate(51, "/status", 4));
    await coordinator.feedback.whenIdle();
    expect(coordinator.feedback.error).toBeNull();
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(requests.at(-1)!.params).toMatchObject({ message_thread_id: 51, text: expect.stringContaining("Topic: Online") });
  });

  it.each(["leader", "follower"])("drops a rejected %s reply and resumes fresh output without reconnecting", async owner => {
    const leader = await fixture();
    const follower = await fixture("follower", 51);
    const f = owner === "leader" ? leader : follower;
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    const generations = [leader.runtime.getGeneration(), follower.runtime.getGeneration()];
    for (const peer of [leader, follower]) {
      vi.spyOn((peer.runtime as any).markdownWorker, "render").mockImplementation(async (text: string) => [{ text }]);
    }
    const originalFetch = globalThis.fetch;
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/sendMessage")) return originalFetch(input, init);
      const params = JSON.parse(init!.body as string);
      sent.push(params.text);
      if (params.text === "rejected reply") return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }));
    });
    await f.runtime.onBeforeAgentStart({ prompt: "initial" }, f.ctx);
    f.runtime.onTurnEnd({ role: "assistant", content: "rejected reply", stopReason: "stop" });
    await f.runtime.outbox.whenIdle();
    await vi.waitFor(() => {
      for (const peer of [leader, follower]) expect(peer.ui.setStatus).toHaveBeenLastCalledWith("tg", expect.stringContaining("429"));
    });
    expect((await follower.runtime.handleInboundText("during cooldown", follower.ctx)).busy).toBe(true);
    await leader.runtime.handleTgConnect(leader.ctx);
    await vi.waitFor(() => {
      for (const peer of [leader, follower]) expect(peer.ui.setStatus.mock.calls.at(-1)?.[1]).toContain("1s");
    }, { timeout: 1500 });
    await vi.waitFor(() => expect(coordinator.getStatus().rateLimitUntil).toBeUndefined(), { timeout: 2000 });
    // A late result belonging to the dropped run must not reappear after recovery.
    f.runtime.onTurnEnd({ role: "assistant", content: "obsolete late reply", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.onBeforeAgentStart({ prompt: "fresh" }, f.ctx);
    f.runtime.onTurnEnd({ role: "assistant", content: "fresh reply", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();
    expect(sent).toEqual(["rejected reply", "fresh reply"]);
    expect(reload).not.toHaveBeenCalled();
    expect([leader.runtime.getGeneration(), follower.runtime.getGeneration()]).toEqual(generations);
    expect(f.runtime.outbox.error).toBeNull();
  });

  it.each([false, true])("preserves cooldown only for the same Bot on reload (token changed: %s)", async changedToken => {
    const leader = await fixture();
    const follower = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    coordinator.getTelegramClient().recordRateLimit(30);
    await vi.waitFor(() => expect(follower.ui.setStatus.mock.calls.at(-1)?.[1]).toContain("429"));
    const next = { ...testConfig, botToken: changedToken ? "replacement-test-token" : testConfig.botToken, autoCloseTopics: false };
    await saveConfig(dir, next);
    await coordinator.reloadConfig();
    expect(coordinator.getTelegramClient().isRateLimited()).toBe(!changedToken);
    if (changedToken) expect(coordinator.getStatus().rateLimitUntil).toBeUndefined();
    else expect(coordinator.getStatus().rateLimitUntil).toBeGreaterThan(Date.now());
    await vi.waitFor(() => {
      expect(follower.runtime.hasActiveTransport()).toBe(true);
      expect(follower.runtime.getIsReconnecting()).toBe(false);
      expect((follower.runtime as any).config.botToken).toBe(next.botToken);
    }, { timeout: 3000 });
    const late = await fixture("late", 52);
    for (const peer of [leader, follower, late]) {
      expect(String(peer.ui.setStatus.mock.calls.at(-1)?.[1]).includes("429")).toBe(!changedToken);
      expect((peer.runtime as any).rateLimitUntil > Date.now()).toBe(!changedToken);
    }
  });

  it("clears the old Bot cooldown when restarting a Runtime with another token", async () => {
    const f = await fixture();
    coordinatorOf(f).getTelegramClient().recordRateLimit(30);
    await f.runtime.onSessionShutdown(f.ctx);
    await saveConfig(dir, { ...testConfig, botToken: "replacement-test-token" });
    await f.runtime.onSessionStart(f.ctx);
    expect((f.runtime as any).rateLimitUntil).toBe(0);
    expect(coordinatorOf(f).getTelegramClient().isRateLimited()).toBe(false);
    expect(f.ui.setStatus.mock.calls.at(-1)?.[1]).not.toContain("429");
  });

  it("recovers a Follower from an RPC-only 429 without a cooldown broadcast", async () => {
    const leader = await fixture();
    const f = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    coordinator.getTelegramClient().onRateLimit = undefined;
    const originalFetch = globalThis.fetch;
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/sendMessage")) return originalFetch(input, init);
      sent.push(JSON.parse(init!.body as string).text);
      return sent.length === 1
        ? new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }), { status: 429 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }));
    });
    const target = { sessionId: "follower", threadId: 51, generation: f.runtime.getGeneration() };
    f.runtime.outbox.enqueue(async signal => {
      await f.runtime.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 51, text: "rejected" }, target, signal);
    });
    await f.runtime.outbox.whenIdle();
    expect(coordinator.getStatus().rateLimitUntil).toBeUndefined();
    expect(f.runtime.outbox.error).toMatchObject({ code: "TELEGRAM_HTTP_429", retryAfter: 1 });
    expect(f.ui.setStatus.mock.calls.at(-1)?.[1]).toContain("429");
    await vi.waitFor(() => expect(f.runtime.outbox.error).toBeNull(), { timeout: 2000 });
    f.runtime.outbox.enqueue(async signal => {
      await f.runtime.callTelegram("sendMessage", { chat_id: testConfig.chatId, message_thread_id: 51, text: "fresh" }, target, signal);
    });
    await f.runtime.outbox.whenIdle();
    expect(sent).toEqual(["rejected", "fresh"]);
    expect(f.runtime.outbox.error).toBeNull();
  });

  it("rechecks the Client deadline when the cooldown timer fires early", async () => {
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      coordinator.getTelegramClient().recordRateLimit(1);
      const until = coordinator.getStatus().rateLimitUntil;
      clock.mockReturnValue(now + 998);
      await vi.advanceTimersByTimeAsync(1000);
      expect(coordinator.getStatus().rateLimitUntil).toBe(until);
      expect(coordinator.getTelegramClient().isRateLimited()).toBe(true);
      clock.mockReturnValue(now + 1000);
      await vi.advanceTimersByTimeAsync(2);
      expect(coordinator.getStatus().rateLimitUntil).toBeUndefined();
      expect(coordinator.getTelegramClient().isRateLimited()).toBe(false);
    } finally { clock.mockRestore(); vi.useRealTimers(); }
  });

  it("does not repeatedly broadcast a cooldown longer than the Node timer limit", async () => {
    const poll = vi.spyOn(TelegramClient.prototype, "getUpdates");
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      coordinator.getTelegramClient().recordRateLimit(30 * 24 * 60 * 60);
      const calls = f.ui.setStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10);
      expect(f.ui.setStatus).toHaveBeenCalledTimes(calls);
      expect(coordinator.getStatus().rateLimitUntil).toBeGreaterThan(Date.now());
    } finally { vi.useRealTimers(); }
  });

  it("extends cooldown without clearing unrelated errors or scheduling reconnects after shutdown", async () => {
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    const error = new TelegramRequestError("TELEGRAM_TIMEOUT", "Unrelated delivery timeout");
    f.runtime.outbox.enqueue(async () => { throw error; });
    await f.runtime.outbox.whenIdle();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      coordinator.getTelegramClient().recordRateLimit(2);
      await vi.advanceTimersByTimeAsync(1000);
      coordinator.getTelegramClient().recordRateLimit(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.ui.setStatus.mock.calls.at(-1)?.[1]).toContain("2s");
      await vi.advanceTimersByTimeAsync(2001);
      expect(coordinator.getStatus().rateLimitUntil).toBeUndefined();
      expect(f.runtime.outbox.error).toBe(error);
      coordinator.getTelegramClient().recordRateLimit(10);
      await f.runtime.onSessionShutdown(f.ctx);
      const calls = f.ui.setStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(11000);
      expect(f.ui.setStatus).toHaveBeenCalledTimes(calls);
      expect(f.runtime.hasActiveTransport()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a feedback rate-limit wait promptly on shutdown", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage");
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    coordinator.getTelegramClient().recordRateLimit(60);
    await coordinator.processUpdate(telegramUpdate(50, "/status"));
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.stop();
    await coordinator.feedback.whenIdle();
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.feedback.error).toBeNull();
  });

  it("fences old feedback after a route changes during rate-limit waiting", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage");
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    coordinator.getTelegramClient().recordRateLimit(1);
    await coordinator.processUpdate(telegramUpdate(50, "/status"));
    await new Promise(resolve => setImmediate(resolve));
    const route = coordinator.getRoutes().get(50)!;
    coordinator.registerLocalRoute({ ...route, generation: route.generation + 1 });
    await coordinator.feedback.whenIdle();
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.feedback.error).toBeNull();
  });

  it("retries failed command-menu registration independently and clears its warning on success", async () => {
    const original = TelegramClient.prototype.callApi;
    let attempts = 0;
    vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "setMyCommands" && ++attempts === 1) return Promise.reject(new TelegramRequestError("TELEGRAM_TIMEOUT", "Menu registration timed out"));
      return original.call(this, method, ...args);
    });
    let releasePoll!: () => void;
    const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
    vi.spyOn(TelegramClient.prototype, "getUpdates").mockImplementationOnce(async () => { await pollGate; return []; });
    const f = await fixture();
    const follower = await fixture("other", 51);
    const coordinator = coordinatorOf(f);
    await vi.waitFor(() => expect(coordinator.getStatus().commandMenuError).toBeDefined());
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(f.ui.setStatus.mock.calls.at(-1)![1]).toContain("connected");
    await vi.waitFor(() => expect(follower.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Command menu unavailable"), "warning"));
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
    releasePoll();
    await vi.waitFor(() => expect(attempts).toBe(2));
    await vi.waitFor(() => expect(coordinator.getStatus().commandMenuError).toBeUndefined());
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
  });

  it.each(["leader", "follower"])("does not disable %s automatic topic closure when command-menu registration fails", async owner => {
    await saveConfig(dir, { ...testConfig, autoCloseTopics: true });
    const original = TelegramClient.prototype.callApi;
    const api = vi.spyOn(TelegramClient.prototype, "callApi").mockImplementation(function (method, ...args) {
      if (method === "setMyCommands") return Promise.reject(new TelegramRequestError("TELEGRAM_TIMEOUT", "Menu registration timed out"));
      return original.call(this, method, ...args);
    });
    const leader = await fixture();
    const f = owner === "follower" ? await fixture("follower", 51) : leader;
    await vi.waitFor(() => expect(coordinatorOf(leader).getStatus().commandMenuError).toBeDefined());
    if (owner === "follower") await vi.waitFor(() => expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Command menu unavailable"), "warning"));
    await f.runtime.onSessionShutdown({ reason: "quit" }, f.ctx);
    expect(api.mock.calls.filter(call => call[0] === "closeForumTopic")).toContainEqual([
      "closeForumTopic", { chat_id: testConfig.chatId, message_thread_id: owner === "follower" ? 51 : 50 }, undefined, expect.any(AbortSignal),
    ]);
  });

  it("registers the five commands only once for the allowed chat member", async () => {
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    await fixture();
    await fixture("follower", 51);
    const calls = api.mock.calls.filter(call => call[0] === "setMyCommands");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({
      scope: { type: "chat_member", chat_id: testConfig.chatId, user_id: testConfig.allowedUserId },
      commands: [
        { command: "model", description: expect.any(String) },
        { command: "thinking", description: expect.any(String) },
        { command: "inputmode", description: expect.any(String) },
        { command: "status", description: expect.any(String) },
        { command: "stop", description: expect.any(String) },
      ],
    });
  });

  it("handles /inputmode command and switches busy input mode", async () => {
    const f = await fixture();
    const initial = await f.runtime.handleInboundText("/inputmode", f.ctx);
    expect(initial.statusReply).toContain("Busy input mode: Follow-up (global)");
    expect(initial.menu?.flat()).toEqual([
      { text: "✓ Follow-up", command: "/inputmode followup" },
      { text: "Steering", command: "/inputmode steer" },
    ]);

    const switched = await f.runtime.handleInboundText("/inputmode steer", f.ctx);
    expect(switched.statusReply).toContain("Busy input mode set to Steering (global)");
    expect(switched.menu).toBeUndefined();
    expect(switched.inputMode).toBe("steer");
    expect((await loadConfig(dir))?.inputMode).toBe("steer");

    const updated = await f.runtime.handleInboundText("/inputmode", f.ctx);
    expect(updated.statusReply).toContain("Busy input mode: Steering (global)");
    expect(updated.menu?.flat()).toEqual([
      { text: "Follow-up", command: "/inputmode followup" },
      { text: "✓ Steering", command: "/inputmode steer" },
    ]);

    const restored = await f.runtime.handleInboundText("/inputmode followup", f.ctx);
    expect(restored.statusReply).toContain("Busy input mode set to Follow-up (global)");
    expect(restored.menu).toBeUndefined();
    expect(restored.inputMode).toBe("followUp");
    expect((await loadConfig(dir))?.inputMode).toBe("followUp");

    const invalid = await f.runtime.handleInboundText("/inputmode unknown", f.ctx);
    expect(invalid.accepted).toBe(false);
    expect(invalid.statusReply).toContain("Invalid input mode");
  });

  it("allows /inputmode command while Pi is busy", async () => {
    const f = await fixture();
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    expect((await f.runtime.handleInboundText("/thinking high", f.ctx)).busy).toBe(false);
    expect(f.settings.setThinkingLevel).toHaveBeenCalledWith("high");
    expect((await f.runtime.handleInboundText("/model other/two", f.ctx)).busy).toBe(false);
    expect(f.settings.setModel).toHaveBeenCalledWith(f.models[1]);

    const result = await f.runtime.handleInboundText("/inputmode", f.ctx);
    expect(result.busy).toBe(false);
    expect(result.statusReply).toContain("Busy input mode");

    const switched = await f.runtime.handleInboundText("/inputmode steer", f.ctx);
    expect(switched.busy).toBe(false);
    expect(switched.statusReply).toContain("Steering");
    expect((await loadConfig(dir))?.inputMode).toBe("steer");
  });

  it.each(["leader", "follower"])("switches input mode via inline button click on %s", async owner => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const leader = await fixture();
    const f = owner === "follower" ? await fixture("follower", 51) : leader;
    const thread = owner === "follower" ? 51 : 50;
    const coordinator = coordinatorOf(leader);

    await coordinator.processUpdate(telegramUpdate(thread, "/inputmode"));
    await coordinator.feedback.whenIdle();
    const markup = send.mock.calls.at(-1)![2]!.reply_markup!;
    expect(markup.inline_keyboard[0][0].text).toBe("✓ Follow-up");
    const steerButton = button(markup, "Steering");

    await coordinator.processUpdate(click(steerButton, thread));
    await coordinator.feedback.whenIdle();

    expect((await loadConfig(dir))?.inputMode).toBe("steer");
    const edit = api.mock.calls.filter(call => call[0] === "editMessageText").at(-1)!;
    expect(edit[1]).toMatchObject({ chat_id: testConfig.chatId, message_id: 900, text: expect.stringContaining("Busy input mode set to Steering") });
  });

  it("queues user prompts while Pi is busy according to input mode and skips notice when idle", async () => {
    const f = await fixture();
    // Idle prompt: sends directly, no statusReply
    f.pi.sendUserMessage.mockImplementation((text: string) => {
      void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
    });
    const idleAdmission = await f.runtime.handleInboundText("idle prompt", f.ctx);
    expect(idleAdmission.accepted).toBe(true);
    expect(idleAdmission.busy).toBe(false);
    expect(idleAdmission.statusReply).toBeUndefined();
    expect(f.pi.sendUserMessage).toHaveBeenCalledWith("idle prompt", { expandPromptTemplates: false });

    // Now Pi is busy running a task
    expect(f.runtime.getIsIdle()).toBe(false);
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);

    // Default mode is followUp:
    const busyFollowUp = await f.runtime.handleInboundText("follow-up prompt", f.ctx);
    expect(busyFollowUp.accepted).toBe(true);
    expect(busyFollowUp.busy).toBe(false);
    expect(busyFollowUp.statusReply).toContain("Follow-up: Request received");
    expect(f.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "Telegram", content: "follow-up prompt" }), { triggerTurn: true, deliverAs: "followUp" });

    // Switch mode to steer while busy:
    await f.runtime.handleInboundText("/inputmode steer", f.ctx);

    // Next busy prompt queues with steer:
    const busySteer = await f.runtime.handleInboundText("steering prompt", f.ctx);
    expect(busySteer.accepted).toBe(true);
    expect(busySteer.busy).toBe(false);
    expect(busySteer.statusReply).toContain("Steering: Request received");
    expect(f.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "Telegram", content: "steering prompt" }), { triggerTurn: true, deliverAs: "steer" });
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("synchronizes global input mode across leader and follower topics in both directions", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    await vi.waitFor(() => expect(coordinator.getRoutes().has(51)).toBe(true));

    // Initially both use followUp
    expect(coordinator.getInputMode()).toBe("followUp");

    // Follower changes mode to steer via command
    await coordinator.processUpdate(telegramUpdate(51, "/inputmode steer"));
    await coordinator.feedback.whenIdle();
    expect(coordinator.getInputMode()).toBe("steer");

    // Leader's local topic now displays and uses steer
    const leaderMenu = await leader.runtime.handleInboundText("/inputmode", leader.ctx);
    expect(leaderMenu.statusReply).toContain("Busy input mode: Steering (global)");
    expect(leaderMenu.menu?.flat()).toEqual([
      { text: "Follow-up", command: "/inputmode followup" },
      { text: "✓ Steering", command: "/inputmode steer" },
    ]);

    // Leader changes mode back to followUp
    await coordinator.processUpdate(telegramUpdate(50, "/inputmode followup"));
    await coordinator.feedback.whenIdle();
    expect(coordinator.getInputMode()).toBe("followUp");

    // Follower's topic now displays followUp
    await vi.waitFor(async () => {
      const followerMenu = await follower.runtime.handleInboundText("/inputmode", follower.ctx);
      expect(followerMenu.statusReply).toContain("Busy input mode: Follow-up (global)");
    });
  });

  it.each([false, true])("preserves active replies when input mode changes during follower authentication (round trip: %s)", async roundTrip => {
    const leader = await fixture("leader", 50);
    const peer = await fixture("peer", 51);
    const active = [leader, peer];
    const sends = active.map(f => vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_id: 900 } as any));
    for (const f of active) {
      await f.runtime.onBeforeAgentStart({ prompt: "running task" }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "running task" }, f.ctx);
      await f.runtime.outbox.whenIdle();
    }
    const generations = active.map(f => f.runtime.getGeneration());
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let reached!: () => void;
    const reachedAuth = new Promise<void>(resolve => { reached = resolve; });
    const connect = IpcFollowerClient.prototype.connect;
    vi.spyOn(IpcFollowerClient.prototype, "connect").mockImplementationOnce(async function (...args) {
      reached();
      await gate;
      return connect.apply(this, args);
    });
    const joining = fixture("joining", 52);
    try {
      await reachedAuth;
      expect((await leader.runtime.handleInboundText("/inputmode steer", leader.ctx)).accepted).toBe(true);
      if (roundTrip) expect((await leader.runtime.handleInboundText("/inputmode followup", leader.ctx)).accepted).toBe(true);
      resume();
      const joined = await joining;
      expect(joined.runtime.hasActiveTransport()).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      expect(active.map(f => f.runtime.getGeneration())).toEqual(generations);
      expect((await joined.runtime.handleInboundText("/inputmode", joined.ctx)).statusReply).toContain(roundTrip ? "Follow-up" : "Steering");
      for (const [i, f] of active.entries()) {
        f.runtime.onTurnEnd({ role: "assistant", content: `completed task ${i}`, stopReason: "stop" });
        await f.runtime.onAgentSettled(f.ctx);
        await f.runtime.outbox.whenIdle();
        expect(sends[i].mock.calls.some(([method, params]) => method === "sendMessage" && params.text === `completed task ${i}`)).toBe(true);
      }
    } finally {
      resume();
      await joining;
    }
  });

  it("preserves a disconnected follower's active reply when it loads a newer mode on reconnect", async () => {
    const leader = await fixture("leader", 50);
    const peer = await fixture("peer", 51);
    const send = vi.spyOn(peer.runtime, "callTelegram").mockResolvedValue({ message_id: 900 } as any);
    await peer.runtime.onBeforeAgentStart({ prompt: "running task" }, peer.ctx);
    peer.runtime.onMessageStart({ role: "user", content: "running task" }, peer.ctx);
    await peer.runtime.outbox.whenIdle();
    const generation = peer.runtime.getGeneration();
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const setup = peer.runtime.setupTransport.bind(peer.runtime);
    vi.spyOn(peer.runtime, "setupTransport").mockImplementationOnce(async ctx => { await gate; return setup(ctx); });
    const socket = [...(coordinator as any).connections.entries()].find(([, state]: any) => state.runtimeId === peer.runtime.runtimeId)![0];
    socket.destroy();
    try {
      await vi.waitFor(() => expect(peer.runtime.getIsReconnecting()).toBe(true));
      await leader.runtime.handleInboundText("/inputmode steer", leader.ctx);
      resume();
      await vi.waitFor(() => expect(peer.runtime.getIsReconnecting()).toBe(false), { timeout: 2500 });
      expect(peer.runtime.getGeneration()).toBe(generation);
      expect(reload).not.toHaveBeenCalled();
      expect((await peer.runtime.handleInboundText("/inputmode", peer.ctx)).statusReply).toContain("Steering");
      peer.runtime.onTurnEnd({ role: "assistant", content: "completed after reconnect", stopReason: "stop" });
      await peer.runtime.onAgentSettled(peer.ctx);
      await peer.runtime.outbox.whenIdle();
      expect(send.mock.calls.some(([method, params]) => method === "sendMessage" && params.text === "completed after reconnect")).toBe(true);
    } finally {
      resume();
    }
  });

  it.each([
    ["steer", "followUp"], ["followUp", "steer"], [undefined, "steer"],
  ] as const)("coordinates a manual mode edit from %s to %s across simultaneous joining followers", async (initial, target) => {
    const leader = await fixture("leader", 50);
    const peer = await fixture("peer", 51);
    if (initial) await leader.runtime.handleInboundText(`/inputmode ${initial.toLowerCase()}`, leader.ctx);
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    const send = vi.spyOn(leader.runtime, "callTelegram").mockResolvedValue({ message_id: 900 } as any);
    await leader.runtime.onBeforeAgentStart({ prompt: "running task" }, leader.ctx);
    leader.runtime.onMessageStart({ role: "user", content: "running task" }, leader.ctx);
    await leader.runtime.outbox.whenIdle();
    const generation = leader.runtime.getGeneration();
    const disk = (await loadConfig(dir))!;
    await fs.writeFile(getConfigPath(dir), JSON.stringify({ ...disk, inputMode: target }));
    const joining = await Promise.all([fixture("joining-a", 52), fixture("joining-b", 53)]);
    await vi.waitFor(() => expect(coordinator.getInputMode()).toBe(target));
    for (const f of [peer, ...joining]) {
      await vi.waitFor(async () => {
        expect((await f.runtime.handleInboundText("/inputmode", f.ctx)).statusReply).toContain(target === "steer" ? "Steering" : "Follow-up");
      });
    }
    expect((await loadConfig(dir))?.inputModeRevision).toBe((disk.inputModeRevision ?? 0) + 1);
    expect((await loadConfig(dir))?.inputMode).toBe(target);
    expect(reload).not.toHaveBeenCalled();
    expect(leader.runtime.getGeneration()).toBe(generation);
    leader.runtime.onTurnEnd({ role: "assistant", content: "reply survives manual edit", stopReason: "stop" });
    await leader.runtime.onAgentSettled(leader.ctx);
    await leader.runtime.outbox.whenIdle();
    expect(send.mock.calls.some(([method, params]) => method === "sendMessage" && params.text === "reply survives manual edit")).toBe(true);

    const f = joining[0];
    vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_id: 901 } as any);
    await f.runtime.onBeforeAgentStart({ prompt: "busy task" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "busy task" }, f.ctx);
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    await f.runtime.outbox.whenIdle();
    await coordinator.getRoutes().get(52)!.dispatchInbound("next task", 101);
    expect(f.pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: "Telegram", content: "next task" }), { triggerTurn: true, deliverAs: target });
  });

  it.each(["newer command", "manual revert"])("uses fresh disk state when reconciliation overlaps a %s", async change => {
    const leader = await fixture("leader", 50);
    await leader.runtime.handleInboundText("/inputmode steer", leader.ctx);
    const disk = (await loadConfig(dir))!;
    await fs.writeFile(getConfigPath(dir), JSON.stringify({ ...disk, inputMode: "followUp" }));
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    const configModule = await import("../src/config.js");
    const originalSave = configModule.saveConfig;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let entered!: () => void;
    const reachedSave = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(configModule, "saveConfig").mockImplementation(async (agentDir, config, options) => {
      if (options?.reconcileInputMode) { entered(); await gate; }
      return originalSave(agentDir, config, options);
    });
    const joining = fixture("joining", 51);
    try {
      await reachedSave;
      if (change === "newer command") {
        expect((await leader.runtime.handleInboundText("/inputmode steer", leader.ctx)).accepted).toBe(true);
      } else {
        await fs.writeFile(getConfigPath(dir), JSON.stringify(disk));
      }
      resume();
      const f = await joining;
      expect(f.runtime.hasActiveTransport()).toBe(true);
      expect((await f.runtime.handleInboundText("/inputmode", f.ctx)).statusReply).toContain("Steering");
      expect(coordinator.getInputMode()).toBe("steer");
      expect((await loadConfig(dir))?.inputModeRevision).toBe(change === "newer command" ? 2 : 1);
      expect((await loadConfig(dir))?.inputMode).toBe("steer");
      expect(reload).not.toHaveBeenCalled();
    } finally {
      resume();
      await joining;
    }
  });

  it.each(["disconnect", "shutdown"])("handles %s while input mode reconciliation is waiting for the config lock", async action => {
    const leader = await fixture("leader", 50);
    const peer = await fixture("peer", 51);
    await leader.runtime.handleInboundText("/inputmode steer", leader.ctx);
    await vi.waitFor(() => expect(peer.runtime.getInputModeRevision()).toBe(1));
    const disk = (await loadConfig(dir))!;
    await fs.writeFile(getConfigPath(dir), JSON.stringify({ ...disk, inputMode: "followUp" }));
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let entered!: () => void;
    const lockEntered = new Promise<void>(resolve => { entered = resolve; });
    const holding = withConfigLock(dir, async () => { entered(); await gate; });
    await lockEntered;
    const setup = vi.spyOn(peer.runtime, "setupTransport");
    const coordinator = coordinatorOf(leader);
    let shutdown: Promise<void> | undefined;
    try {
      (peer.runtime as any).followerClient.socket.destroy();
      await vi.waitFor(async () => {
        const claims = (await fs.readdir(path.join(getConfigDir(dir), "config-mutex"))).filter(file => file.endsWith(".json"));
        expect(claims).toHaveLength(2);
      }, { timeout: 3000 });
      expect(setup).toHaveBeenCalledTimes(1);

      if (action === "disconnect") {
        (peer.runtime as any).followerClient.socket.destroy();
        // The second timer reuses the setup task that is still waiting for the lock.
        await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(2), { timeout: 2000 });
        expect(peer.runtime.hasActiveTransport()).toBe(false);
        resume();
        await holding;
        await vi.waitFor(() => {
          expect(peer.runtime.hasActiveTransport()).toBe(true);
          expect(peer.runtime.getIsReconnecting()).toBe(false);
          expect(coordinator.getRoutes().has(51)).toBe(true);
        }, { timeout: 2500 });
        expect(setup).toHaveBeenCalledTimes(3);
        expect((await peer.runtime.handleInboundText("/inputmode", peer.ctx)).statusReply).toContain("Follow-up");
        expect(coordinator.getInputMode()).toBe("followUp");
      } else {
        shutdown = peer.runtime.onSessionShutdown(peer.ctx);
        resume();
        await holding;
        await shutdown;
        expect(peer.runtime.hasActiveTransport()).toBe(false);
        expect((peer.runtime as any).reconnectTimer).toBeUndefined();
        expect(setup).toHaveBeenCalledTimes(1);
        expect(peer.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Telegram connection failed"), "error");
      }
    } finally {
      resume();
      await holding;
      await shutdown;
    }
  }, 10_000);

  it.each(["steer", "followUp"] as const)("preserves a concurrent %s save while reconnect drains the old poller", async mode => {
    const f = await fixture();
    if (mode === "followUp") await f.runtime.handleInboundText("/inputmode steer", f.ctx);
    const coordinator = coordinatorOf(f);
    let releaseLock!: () => void;
    const lockGate = new Promise<void>(resolve => { releaseLock = resolve; });
    let entered!: () => void;
    const lockEntered = new Promise<void>(resolve => { entered = resolve; });
    const holding = withConfigLock(dir, async () => { entered(); await lockGate; });
    await lockEntered;
    let releasePoller!: () => void;
    const pollerGate = new Promise<void>(resolve => { releasePoller = resolve; });
    // Hold the real poller's completion after cancellation, so reload has read
    // its snapshot but has not installed it when the concurrent save finishes.
    (coordinator as any).pollingTask = Promise.all([(coordinator as any).pollingTask, pollerGate]).then(() => {});
    let changing: ReturnType<typeof f.runtime.handleInboundText> | undefined;
    let reconnecting: Promise<void> | undefined;
    try {
      changing = f.runtime.handleInboundText(`/inputmode ${mode.toLowerCase()}`, f.ctx);
      await vi.waitFor(async () => {
        const claims = (await fs.readdir(path.join(getConfigDir(dir), "config-mutex"))).filter(file => file.endsWith(".json"));
        expect(claims).toHaveLength(2);
      });
      (coordinator as any).publishStatus({ ...coordinator.getStatus(), feedbackError: { code: "TELEGRAM_REQUEST_FAILED", message: "Simulated delivery failure" } });
      reconnecting = f.runtime.handleTgConnect(f.ctx);
      await vi.waitFor(() => expect((coordinator as any).pollController.signal.aborted).toBe(true));
      releaseLock();
      await holding;
      await changing;
      const disk = (await loadConfig(dir))!;
      expect(disk.inputMode).toBe(mode);
      expect(coordinator.getInputModeRevision()).toBe(disk.inputModeRevision);
      releasePoller();
      await reconnecting;
      expect(coordinator.getInputMode()).toBe(mode);
      expect(coordinator.getInputModeRevision()).toBe(disk.inputModeRevision);
      expect(f.runtime.getInputModeRevision()).toBe(disk.inputModeRevision);
      expect((await f.runtime.handleInboundText("/inputmode", f.ctx)).statusReply).toContain(mode === "steer" ? "Steering" : "Follow-up");
      vi.spyOn(f.runtime, "callTelegram").mockResolvedValue({ message_id: 900 } as any);
      await f.runtime.onBeforeAgentStart({ prompt: "busy work" }, f.ctx);
      f.runtime.onMessageStart({ role: "user", content: "busy work" }, f.ctx);
      vi.mocked(f.ctx.isIdle).mockReturnValue(false);
      await f.runtime.outbox.whenIdle();
      await coordinator.getRoutes().get(50)!.dispatchInbound("next task", 101);
      expect(f.pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: "Telegram", content: "next task" }), { triggerTurn: true, deliverAs: mode });
    } finally {
      releaseLock();
      releasePoller();
      await Promise.allSettled([holding, changing, reconnecting]);
    }
  });

  it("synchronizes a newer persisted mode from a joining follower without reloading the Leader", async () => {
    const leader = await fixture("leader", 50);
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    const generation = leader.runtime.getGeneration();
    await saveConfig(dir, { ...testConfig, inputMode: "steer" }, { modeUpdate: true });
    await fixture("joining", 51);
    await vi.waitFor(() => expect(coordinator.getInputMode()).toBe("steer"));
    expect(reload).not.toHaveBeenCalled();
    expect(leader.runtime.getGeneration()).toBe(generation);
  });

  it.each([
    { botToken: "updated-fixture-token" }, { chatId: -100999 },
    { allowedUserId: 456 }, { autoCloseTopics: true },
  ])("still reloads changed connection configuration during authentication: %j", async changes => {
    const leader = await fixture("leader", 50);
    await leader.runtime.handleInboundText("/inputmode steer", leader.ctx);
    const coordinator = coordinatorOf(leader);
    const reload = vi.spyOn(coordinator, "reloadConfig");
    const generation = leader.runtime.getGeneration();
    await saveConfig(dir, { ...testConfig, ...changes });
    const follower = await fixture("joining", 51);
    expect(follower.runtime.hasActiveTransport()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(leader.runtime.getGeneration()).toBeGreaterThan(generation);
  });

  it("rolls back candidate configuration when saveConfig fails during inputmode change", async () => {
    const f = await fixture();
    const configModule = await import("../src/config.js");
    const saveSpy = vi.spyOn(configModule, "saveConfig").mockRejectedValueOnce(new Error("Disk error"));

    const result = await f.runtime.handleInboundText("/inputmode steer", f.ctx);
    expect(result.accepted).toBe(false);
    expect(result.statusReply).toContain("Settings update failed");
    expect((await loadConfig(dir))?.inputMode ?? "followUp").toBe("followUp");

    // Live mode was not changed
    const query = await f.runtime.handleInboundText("/inputmode", f.ctx);
    expect(query.statusReply).toContain("Busy input mode: Follow-up (global)");
  });

  it("reports a synchronous Pi queue rejection without blocking subsequent busy input", async () => {
    const f = await fixture();
    f.pi.sendUserMessage.mockImplementationOnce((text: string) => {
      void f.runtime.onBeforeAgentStart({ prompt: text }, f.ctx).then(() => f.runtime.onMessageStart({ role: "user", content: text }, f.ctx));
    });
    await f.runtime.handleInboundText("initial task", f.ctx);
    expect(f.runtime.getIsIdle()).toBe(false);
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);

    f.pi.sendMessage.mockImplementationOnce(() => {
      throw new Error("Compaction in progress");
    });
    const syncResult = await f.runtime.handleInboundText("sync failed task", f.ctx);
    expect(syncResult.accepted).toBe(false);
    expect(syncResult.busy).toBe(false);
    expect(syncResult.statusReply).toContain("Pi rejected the task");

    expect((await f.runtime.handleInboundText("next task", f.ctx)).accepted).toBe(true);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves active-run prompt mirroring and reply delivery after changing input mode while busy", async () => {
    const f = await fixture();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (method, params) => {
      calls.push({ method, params });
      return { message_id: 888 } as any;
    });
    await f.runtime.onBeforeAgentStart({ prompt: "active task" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "active task" }, f.ctx);
    await f.runtime.outbox.whenIdle();

    // Mode is changed mid-run
    const modeChange = await f.runtime.handleInboundText("/inputmode steer", f.ctx);
    expect(modeChange.statusReply).toContain("Steering");

    // Next turn completes
    f.runtime.onTurnEnd({ role: "assistant", content: "answer after mode change", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    const sentTexts = calls.filter(c => c.method === "sendMessage").map(c => c.params.text);
    expect(sentTexts).toContain("answer after mode change");
  });

  it.each([
    ["leader", false, false, false], ["follower", false, false, false],
    ["leader", true, false, false], ["follower", true, false, false],
    ["leader", false, true, false], ["leader", false, false, true],
  ] as const)("loads the completed pending input mode save after %s replacement (failure: %s, cancelled: %s, timeout: %s)", async (owner, failure, cancelled, timeout) => {
    // A separately evaluated module must inherit pending writes from the old one.
    const Runtime = owner === "leader" && !failure && !cancelled
      ? (await import("../src/runtime.js?input-mode-reload")).MuxRuntime
      : MuxRuntime;
    const survivor = owner === "follower" ? await fixture("survivor", 50) : undefined;
    const previous = await fixture("previous", owner === "follower" ? 51 : 50);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = withConfigLock(dir, async () => { entered(); await gate; });
    await ready;
    const configModule = await import("../src/config.js");
    if (failure) {
      const save = configModule.saveConfig;
      vi.spyOn(configModule, "saveConfig").mockImplementationOnce((agentDir, config, options) => save(agentDir, config, {
        ...options, onChecked: () => { throw new Error("Simulated save failure"); },
      }));
    }
    const changing = previous.runtime.handleInboundText("/inputmode steer", previous.ctx);
    const replacement = new Runtime(previous.pi as any, dir);
    fixtures.push({ ...previous, runtime: replacement });
    let starting: Promise<void> | undefined;
    try {
      await vi.waitFor(async () => {
        expect((await fs.readdir(path.join(getConfigDir(dir), "config-mutex"))).filter(file => file.endsWith(".json"))).toHaveLength(2);
      });
      if (timeout) expect((await changing).statusReply).toContain("input mode configuration is still being saved");
      expect(previous.runtime.getIsIdle()).toBe(false);
      expect(await previous.runtime.onSessionBeforeSwitch(previous.ctx)).toEqual({ cancel: true });
      expect(await previous.runtime.onSessionBeforeFork(previous.ctx)).toEqual({ cancel: true });
      expect(await previous.runtime.onSessionBeforeTree()).toEqual({ cancel: true });
      expect(previous.ui.notify).toHaveBeenCalledWith(expect.stringContaining("input mode configuration"), "warning");
      // Reload/quit still shuts down without awaiting the blocked disk write.
      await previous.runtime.onSessionShutdown({ reason: "reload" }, previous.ctx);
      const load = vi.spyOn(configModule, "loadConfig");
      starting = replacement.onSessionStart(previous.ctx);
      expect(load).not.toHaveBeenCalled();
      expect(replacement.hasActiveTransport()).toBe(false);
      if (cancelled) await replacement.onSessionShutdown(previous.ctx);
      release();
      await Promise.all([holding, changing, starting]);
      if (cancelled) {
        expect(load).not.toHaveBeenCalled();
        expect(replacement.hasActiveTransport()).toBe(false);
        return;
      }
      const disk = (await loadConfig(dir))!;
      const mode = failure ? "followUp" : "steer";
      expect(disk.inputMode ?? "followUp").toBe(mode);
      expect(replacement.hasActiveTransport()).toBe(true);
      expect(replacement.getInputModeRevision()).toBe(disk.inputModeRevision ?? 0);
      expect((await replacement.handleInboundText("/inputmode", previous.ctx)).statusReply).toContain(failure ? "Follow-up" : "Steering");
      if (survivor) await vi.waitFor(() => expect(coordinatorOf(survivor).getInputMode()).toBe(mode));
    } finally {
      release();
      await Promise.allSettled([holding, changing, starting]);
    }
  }, 10_000);

  it("reconnects a follower after a blocked mode broadcast and restores its current setting", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    const socket = [...(coordinator as any).connections.entries()].find(([, state]: any) => state.runtimeId === follower.runtime.runtimeId)![0];
    Object.defineProperty(socket, "writableLength", { configurable: true, value: 1024 * 1024 + 1 });
    expect((await leader.runtime.handleInboundText("/inputmode steer", leader.ctx)).accepted).toBe(true);
    expect(socket.destroyed).toBe(true);
    await vi.waitFor(() => {
      expect(follower.runtime.hasActiveTransport()).toBe(true);
      expect(follower.runtime.getInputModeRevision()).toBe(coordinator.getInputModeRevision());
      expect(coordinator.getRoutes().has(51)).toBe(true);
    }, { timeout: 3000 });
    expect((await follower.runtime.handleInboundText("/inputmode", follower.ctx)).statusReply).toContain("Steering");
  });

  it("synchronizes follower mode to leader even when saveConfig completes after the settings deadline", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    await vi.waitFor(() => expect(coordinator.getRoutes().has(51)).toBe(true));

    // Delay saveConfig on the follower beyond the 2000ms deadline
    let finishSave!: () => void;
    const saveBlocked = new Promise<void>(resolve => { finishSave = resolve; });
    const configModule = await import("../src/config.js");
    const originalSave = configModule.saveConfig;
    vi.spyOn(configModule, "saveConfig").mockImplementation(async (dir, config, options) => {
      await saveBlocked;
      return originalSave(dir, config, options);
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const changing = follower.runtime.handleInboundText("/inputmode steer", follower.ctx);
    // Advance timers past the 2000ms deadline
    await vi.advanceTimersByTimeAsync(2001);
    const timedOut = await changing;
    expect(timedOut.statusReply).toContain("unknown");
    expect(timedOut.statusReply).toContain("input mode configuration is still being saved");
    expect(timedOut.statusReply).not.toMatch(/model change|restart Pi|\/reload cannot/);
    // Leader has not received the update yet
    expect(coordinator.getInputMode()).toBe("followUp");

    // Now let the save complete
    vi.useRealTimers();
    finishSave();
    await vi.waitFor(() => expect(coordinator.getInputMode()).toBe("steer"));
    const diskConfig = await loadConfig(dir);
    expect(diskConfig?.inputMode).toBe("steer");
    expect(diskConfig?.inputModeRevision).toBeGreaterThanOrEqual(1);
  });

  it("preserves pending-input mirroring when input mode is changed during a delayed input hook", async () => {
    const f = await fixture();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (method, params) => {
      calls.push({ method, params });
      return { message_id: 888 } as any;
    });

    // Block saveConfig so /inputmode remains in-flight during the input hook
    let finishSave!: () => void;
    const saveBlocked = new Promise<void>(resolve => { finishSave = resolve; });
    const configModule = await import("../src/config.js");
    const originalSave = configModule.saveConfig;
    vi.spyOn(configModule, "saveConfig").mockImplementation(async (dir, config, options) => {
      await saveBlocked;
      return originalSave(dir, config, options);
    });

    // Submit idle message (this calls sendUserMessage and sets inputContext for f.inInput)
    const admission = f.runtime.handleInboundText("delayed task", f.ctx, 100);

    // Start inputmode change (blocked inside saveConfig)
    const modeChange = f.runtime.handleInboundText("/inputmode steer", f.ctx);

    // Verify onInput does NOT swallow the prompt while mode change is in flight
    expect(f.runtime.onInput(f.ctx, "delayed task")).toBeUndefined();

    // Now let the delayed hook execute in the captured origin context before saveConfig completes
    await f.inInput(() => f.runtime.onBeforeAgentStart({ prompt: "delayed task" }, f.ctx));
    f.runtime.onMessageStart({ role: "user", content: "delayed task" }, f.ctx);

    // Now let saveConfig finish
    finishSave();
    await modeChange;
    await admission;
    const diskConfig = await loadConfig(dir);
    expect(diskConfig?.inputMode).toBe("steer");
    expect(diskConfig?.inputModeRevision).toBeGreaterThanOrEqual(1);

    // Run completes
    f.runtime.onTurnEnd({ role: "assistant", content: "reply to delayed task", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    const sentTexts = calls.filter(c => c.method === "sendMessage").map(c => c.params.text);
    expect(sentTexts).toContain("reply to delayed task");
  });

  it("rejects /inputmode update when connection configuration changed on disk", async () => {
    const f = await fixture();
    // Simulate connection settings changed on disk (e.g. chatId changed)
    await saveConfig(dir, { ...testConfig, chatId: -100999 });

    const result = await f.runtime.handleInboundText("/inputmode steer", f.ctx);
    expect(result.accepted).toBe(false);
    expect(result.statusReply).toContain("Settings update failed");
    // Live configuration on runtime was not corrupted
    expect(f.runtime.config?.chatId).toBe(testConfig.chatId);
  });

  it("prevents an overlapping /inputmode save from overwriting newer connection settings", async () => {
    const f = await fixture();
    let resumeReplace!: () => void;
    let signalReachedCheck!: () => void;
    const replacePaused = new Promise<void>(resolve => { resumeReplace = resolve; });
    const reachedCheck = new Promise<void>(resolve => { signalReachedCheck = resolve; });

    const configModule = await import("../src/config.js");
    const originalSave = configModule.saveConfig;

    let saveCalls = 0;
    vi.spyOn(configModule, "saveConfig").mockImplementation(async (agentDir, config, options) => {
      saveCalls++;
      if (saveCalls === 1) {
        return originalSave(agentDir, config, {
          ...options,
          onChecked: async () => {
            signalReachedCheck();
            await replacePaused;
          },
        });
      }
      return originalSave(agentDir, config, options);
    });

    // Start /inputmode steer
    const modeChange = f.runtime.handleInboundText("/inputmode steer", f.ctx);
    // Wait deterministically for the mode save transaction to reach the check
    await reachedCheck;

    // Concurrently, newer connection settings are written directly to configPath
    const configPath = configModule.getConfigPath(dir);
    const updatedConnection = { ...testConfig, chatId: -100888, botToken: "brand-new-token" };
    await fs.writeFile(configPath, JSON.stringify(updatedConnection, null, 2) + "\n");

    // Now resume the paused replace
    resumeReplace();
    const result = await modeChange;

    // The mode change must fail because connection settings changed concurrently
    expect(result.accepted).toBe(false);
    expect(result.statusReply).toContain("Settings update failed");

    // The newer connection settings on disk must survive completely intact!
    const diskConfig = await loadConfig(dir);
    expect(diskConfig?.chatId).toBe(-100888);
    expect(diskConfig?.botToken).toBe("brand-new-token");
  });

  it("rejects out-of-order stale mode synchronization frames across both leader and follower", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    await vi.waitFor(() => expect(coordinator.getRoutes().has(51)).toBe(true));

    // Update to steer with revision 2
    coordinator.updateInputMode("steer", undefined, 2);
    expect(coordinator.getInputMode()).toBe("steer");
    await vi.waitFor(async () => {
      const menu = await follower.runtime.handleInboundText("/inputmode", follower.ctx);
      expect(menu.statusReply).toContain("Steering");
    });

    // Stale sync frame with older revision 1 arrives from peer socket
    const socket = [...(coordinator as any).connections.entries()].find(([, state]: any) => state.runtimeId === follower.runtime.runtimeId)![0];
    coordinator.updateInputMode("followUp", socket, 1);

    // Stale frame was discarded; leader remains on steer
    expect(coordinator.getInputMode()).toBe("steer");

    // Equal revision frame (2) is also discarded
    coordinator.updateInputMode("followUp", socket, 2);
    expect(coordinator.getInputMode()).toBe("steer");

    // Deliver stale and equal frames directly to the follower client
    socket.write(encodeFrame({ type: "sync_input_mode", mode: "followUp", revision: 1 }));
    socket.write(encodeFrame({ type: "sync_input_mode", mode: "followUp", revision: 2 }));
    await new Promise(r => setTimeout(r, 40));

    // Follower also remains on steer (was not downgraded by equal or older revision)
    const followerCheck = await follower.runtime.handleInboundText("/inputmode", follower.ctx);
    expect(followerCheck.statusReply).toContain("Steering");

    // Valid newer frame with revision 3 updates both peers
    coordinator.updateInputMode("followUp", undefined, 3);
    expect(coordinator.getInputMode()).toBe("followUp");
    await vi.waitFor(async () => {
      const menu = await follower.runtime.handleInboundText("/inputmode", follower.ctx);
      expect(menu.statusReply).toContain("Follow-up");
    });
  });

  it("synchronizes inputModeRevision on configuration reload and rejects stale frames", async () => {
    const leader = await fixture("leader", 50);
    const coordinator = coordinatorOf(leader);
    // Save config with inputModeRevision = 5 on disk (allocated to 6)
    const saved = await saveConfig(dir, { ...testConfig, inputMode: "steer", inputModeRevision: 5 }, { modeUpdate: true });
    expect(saved.inputModeRevision).toBe(6);
    await coordinator.reloadConfig();
    expect(coordinator.getInputMode()).toBe("steer");

    // Coordinator reloaded revision 6 from disk
    expect((coordinator as any).inputModeRevision).toBe(6);

    // Stale frame with revision 4 is rejected
    coordinator.updateInputMode("followUp", undefined, 4);
    expect(coordinator.getInputMode()).toBe("steer");

    // Equal frame with revision 6 is rejected
    coordinator.updateInputMode("followUp", undefined, 6);
    expect(coordinator.getInputMode()).toBe("steer");

    // Strictly newer frame with revision 7 is accepted
    coordinator.updateInputMode("followUp", undefined, 7);
    expect(coordinator.getInputMode()).toBe("followUp");
    expect((coordinator as any).inputModeRevision).toBe(7);
  });

  it("does not overwrite newer live configuration when a delayed save completes with an older revision", async () => {
    const leader = await fixture("leader", 50);
    const follower = await fixture("follower", 51);
    const coordinator = coordinatorOf(leader);
    await vi.waitFor(() => expect(coordinator.getRoutes().has(51)).toBe(true));

    let finishSave!: () => void;
    const savePaused = new Promise<void>(resolve => { finishSave = resolve; });
    const configModule = await import("../src/config.js");
    const originalSave = configModule.saveConfig;
    let saveCount = 0;
    vi.spyOn(configModule, "saveConfig").mockImplementation(async (dir, config, options) => {
      saveCount++;
      if (saveCount === 1) {
        await savePaused;
      }
      return originalSave(dir, config, options);
    });

    const followerChange = follower.runtime.handleInboundText("/inputmode steer", follower.ctx);

    // Concurrently, leader updates mode to followUp with a newer revision 50
    coordinator.updateInputMode("followUp", undefined, 50);

    // Now let the older save complete (allocating an older revision < 50)
    finishSave();
    const result = await followerChange;

    expect(result.accepted).toBe(false);
    expect(result.statusReply).toContain("superseded");

    // Follower live mode must NOT revert to steer
    await vi.waitFor(async () => {
      const checkFollower = await follower.runtime.handleInboundText("/inputmode", follower.ctx);
      expect(checkFollower.statusReply).toContain("Follow-up");
    });
  });

  it("preserves active-run prompt mirroring and reply delivery after changing model and thinking while busy", async () => {
    const f = await fixture();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.spyOn(f.runtime, "callTelegram").mockImplementation(async (method, params) => {
      calls.push({ method, params });
      return { message_id: 888 } as any;
    });
    await f.runtime.onBeforeAgentStart({ prompt: "active task" }, f.ctx);
    f.runtime.onMessageStart({ role: "user", content: "active task" }, f.ctx);
    await f.runtime.outbox.whenIdle();

    // Model and thinking changed mid-run
    const thinkingChange = await f.runtime.handleInboundText("/thinking high", f.ctx);
    expect(thinkingChange.busy).toBe(false);
    expect(f.settings.setThinkingLevel).toHaveBeenCalledWith("high");

    const modelChange = await f.runtime.handleInboundText("/model other/two", f.ctx);
    expect(modelChange.busy).toBe(false);
    expect(f.settings.setModel).toHaveBeenCalledWith(f.models[1]);

    // Next turn completes
    f.runtime.onTurnEnd({ role: "assistant", content: "answer after model change", stopReason: "stop" });
    await f.runtime.onAgentSettled(f.ctx);
    await f.runtime.outbox.whenIdle();

    const sentTexts = calls.filter(c => c.method === "sendMessage").map(c => c.params.text);
    expect(sentTexts).toContain("answer after model change");
  });
});

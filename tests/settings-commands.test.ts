import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderCoordinator } from "../src/coordinator.js";
import { saveConfig } from "../src/config.js";
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

  it("rejects changes while Pi is busy", async () => {
    const f = await fixture();
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    expect((await f.runtime.handleInboundText("/thinking high", f.ctx)).busy).toBe(true);
    expect((await f.runtime.handleInboundText("/model other/two", f.ctx)).busy).toBe(true);
    expect(f.settings.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.settings.setModel).not.toHaveBeenCalled();
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

  it("clears buttons and explains a busy session without making a settings change", async () => {
    const send = vi.spyOn(TelegramClient.prototype, "sendMessage").mockResolvedValue({ message_id: 900 } as any);
    const api = vi.spyOn(TelegramClient.prototype, "callApi");
    const f = await fixture();
    const coordinator = coordinatorOf(f);
    await coordinator.processUpdate(telegramUpdate(50, "/thinking"));
    await coordinator.feedback.whenIdle();
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
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

  it.each(["answerCallbackQuery", "editMessageText"])("recovers feedback after a real HTTP 429 from %s without replaying the selection", async rejectedMethod => {
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
    expect(edits).toHaveLength(rejectedMethod === "editMessageText" ? 2 : 1);
    expect(edits.at(-1)!.at - rejectedAt).toBeGreaterThanOrEqual(990);
    expect(coordinator.feedback.error).toBeNull();
    expect(coordinator.getStatus().feedbackError).toBeUndefined();
    expect(requests.at(-1)!.params).toMatchObject({ message_thread_id: 51, text: expect.stringContaining("Topic: Online") });
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

  it("registers the four commands only once for the allowed chat member", async () => {
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
        { command: "status", description: expect.any(String) },
        { command: "stop", description: expect.any(String) },
      ],
    });
  });
});

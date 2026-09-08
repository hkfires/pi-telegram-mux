// Copied next to the source in a temporary package and loaded by the real Pi CLI.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MuxRuntime } from "./runtime.js";
import { TelegramClient } from "./telegram.js";
import { LeaderCoordinator } from "./coordinator.js";
import { loadConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const scenario = process.env.MUX_REVIEW_SCENARIO;
  const busyModelScenario = scenario === "busy-follow-up-model" || scenario === "busy-steer-model";
  const concurrentBusyScenario = scenario === "busy-concurrent-input-gate";
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  let releaseBusyInput!: () => void;
  const busyInputProcessed = new Promise<void>(resolve => { releaseBusyInput = resolve; });
  let beginFirstResponse!: () => void;
  const firstResponseStarted = new Promise<void>(resolve => { beginFirstResponse = resolve; });
  let releaseConcurrentInput!: () => void;
  const concurrentInputGate = new Promise<void>(resolve => { releaseConcurrentInput = resolve; });
  let inputWaited = false;
  let modelChanged = false;
  globalThis.fetch = async () => { throw new Error("External network is forbidden in lifecycle tests"); };
  TelegramClient.prototype.getMe = async () => ({ id: 1, is_bot: true, first_name: "Fixture", username: "fixture_bot" });
  TelegramClient.prototype.getChat = async id => ({ id, type: "supergroup", is_forum: true });
  TelegramClient.prototype.getChatMember = async () => ({ status: "administrator", can_manage_topics: true });
  TelegramClient.prototype.getUpdates = options => new Promise((_resolve, reject) => {
    const signal = options!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  let answers = 0;
  const modelInputs: string[][] = [];
  pi.registerProvider("mux-review", {
    baseUrl: "http://127.0.0.1:1", apiKey: "fake-test-key", api: "openai-completions",
    models: ["fake", "fake-other"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model, context) => {
      modelInputs.push(context.messages.filter(message => message.role === "user").map(message =>
        typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("")));
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${++answers}` }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (answers === 1) beginFirstResponse();
      const response = scenario === "length-follow-up" && answers === 1
        ? { ...message, stopReason: "length" as const, usage: { ...message.usage, output: model.maxTokens, totalTokens: model.maxTokens + 1 } }
        : message;
      const ready = busyModelScenario && answers === 1 ? busyInputProcessed : new Promise<void>(resolve => setTimeout(resolve, 25));
      void ready.then(() => { stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason: response.stopReason, message: response }); stream.end(); });
      return stream;
    },
  });
  // Exercise real Pi events in RPC without needing an interactive terminal. The
  // proxy changes only the mode guard and preserves Pi's lazy context properties.
  const tui = (ctx: ExtensionContext): ExtensionContext => new Proxy(ctx, { get: (target, key) => key === "mode" ? "tui" : Reflect.get(target, key, target) });
  const runtime = new MuxRuntime(pi, process.env.PI_CODING_AGENT_DIR!);
  const texts: unknown[] = [];
  const reactions: { messageId: unknown; emoji: unknown }[] = [];
  const received: string[] = [];
  const feedback: string[] = [];
  let coordinator: LeaderCoordinator | undefined;
  let admitted: unknown;
  let starts = 0;
  let nextMessageId = 1000;
  runtime.callTelegram = async (method, params) => {
    if (method === "setMessageReaction") {
      reactions.push({ messageId: params.message_id, emoji: (params.reaction as { emoji?: string }[])[0]?.emoji });
    } else {
      texts.push(params.text ?? "create");
    }
    return { message_thread_id: 50, message_id: nextMessageId++ } as any;
  };
  pi.on("session_start", async (_event, ctx) => {
    if (scenario === "reconnect") {
      coordinator = new LeaderCoordinator((await loadConfig(process.env.PI_CODING_AGENT_DIR!))!, process.env.PI_CODING_AGENT_DIR!);
      coordinator.getTelegramClient().sendMessage = async (_chat, text) => { feedback.push(text); return {} as any; };
      await coordinator.start();
    }
    pi.appendEntry("pi-telegram-mux.binding", { version: 1, sessionId: ctx.sessionManager.getSessionId(), chatId: -100123, threadId: 50 });
    await runtime.onSessionStart(tui(ctx));
  });
  if (scenario !== "reconnect") pi.on("input", async (event, ctx) => {
    if (busyModelScenario) {
      if (event.source !== "extension") return { action: "continue" };
      inputWaited = true;
      return { action: "transform", text: "transformed busy prompt" };
    }
    if (concurrentBusyScenario) {
      if (event.source === "extension") {
        inputWaited = true;
        // A sendUserMessage regression holds both remote inputs until the local
        // run has settled, exposing concurrent asynchronous prompt admission.
        await concurrentInputGate;
      }
      return { action: "continue" };
    }
    if (scenario === "follow-up" || scenario === "length-follow-up") return { action: "continue" };
    await new Promise(resolve => setTimeout(resolve, 20));
    if (scenario === "config") await runtime.handleTgSetup(tui(ctx));
    return { action: "transform", text: "completely transformed" };
  });
  if (busyModelScenario) {
    pi.on("model_select", async () => { await modelGate; });
  }
  pi.on("before_agent_start", async (event, ctx) => { starts++; await runtime.onBeforeAgentStart(event, tui(ctx)); });
  pi.on("message_start", (event, ctx) => {
    runtime.onMessageStart(event.message, tui(ctx));
    if (event.message.role === "user" || event.message.role === "custom") {
      received.push(typeof event.message.content === "string" ? event.message.content : event.message.content.filter(part => part.type === "text").map(part => part.text).join(""));
      if ((scenario === "follow-up" || scenario === "length-follow-up") && received.length === 1) pi.sendUserMessage("local-follow-up", { deliverAs: "followUp" });
      if (busyModelScenario && received.length === 1) {
        void firstResponseStarted.then(async () => {
          // Submit during the first model request: steering before it starts
          // legitimately merges both prompts into a single response.
          admitted = await runtime.handleInboundText("remote busy prompt", tui(ctx), 101, scenario === "busy-steer-model" ? "steer" : "followUp");
          // Keep the first response open until the queued prompt and model
          // change are ready; remote delivery must not need an input hook.
          const changing = runtime.handleInboundText("/model mux-review/fake-other", tui(ctx));
          setImmediate(releaseModel);
          modelChanged = (await changing).accepted;
          releaseBusyInput();
        });
      }
      if (concurrentBusyScenario && received.length === 1) {
        void Promise.all([
          runtime.handleInboundText("busy-one", tui(ctx), 101, "followUp"),
          runtime.handleInboundText("busy-two", tui(ctx), 102, "followUp"),
        ]).then(results => { admitted = results; });
      }
    }
  });
  pi.on("message_end", event => { runtime.onMessageEnd(event.message); });
  pi.on("turn_end", event => { runtime.onTurnEnd(event.message); });
  pi.on("agent_settled", async (_event, ctx) => {
    if (concurrentBusyScenario) releaseConcurrentInput();
    await runtime.onAgentSettled(tui(ctx));
    // Test observation only: production handlers never await the outbox.
    await runtime.outbox.whenIdle();
    if (concurrentBusyScenario && (received.length < 3 || answers < 3)) return;
    ctx.ui.notify(JSON.stringify({ type: "mux_review_result", texts, reactions, received, modelInputs, admitted, starts, feedback, inputWaited, modelChanged, idle: runtime.getIsIdle(), error: runtime.outbox.error?.message }), "info");
  });
  pi.on("session_shutdown", async (_event, ctx) => { await runtime.onSessionShutdown(tui(ctx)); await coordinator?.stop(); });
  pi.registerCommand("review-inbound", { handler: async (_args, ctx) => { admitted = await runtime.handleInboundText("original", tui(ctx)); } });
  pi.registerCommand("review-reconnect", { handler: async (_args, ctx) => {
    const leader = coordinator! as any;
    const handle = leader.handleFrame.bind(leader);
    let processing: Promise<void> | undefined;
    leader.handleFrame = async (socket: any, state: any, message: any) => {
      if (message.type !== "register" || processing) return handle(socket, state, message);
      socket.cork();
      await handle(socket, state, message);
      processing = coordinator!.processUpdate({ update_id: 1, message: {
        message_id: 1, message_thread_id: 50, chat: { id: -100123, type: "supergroup" },
        from: { id: 123, is_bot: false, first_name: "Fixture" }, date: 1, text: "premature task",
      } });
      socket.uncork();
    };
    [...leader.connections.entries()].find(([, state]: any) => state.runtimeId === runtime.runtimeId)![0].destroy();
    const deadline = Date.now() + 4000;
    while (!processing || runtime.getIsReconnecting()) {
      if (Date.now() > deadline) throw new Error("Reconnect test timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await processing;
    await coordinator!.feedback.whenIdle();
    admitted = await runtime.handleInboundText("ready task", tui(ctx));
  } });
}

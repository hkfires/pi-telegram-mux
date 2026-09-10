// Copied next to the source in a temporary package and loaded by the real Pi CLI.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MuxRuntime } from "./runtime.js";
import { TelegramClient, TelegramApiError } from "./telegram.js";
import { LeaderCoordinator } from "./coordinator.js";
import { loadConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const scenario = process.env.MUX_REVIEW_SCENARIO;
  const albumScenario = scenario === "album" || scenario === "album-read";
  const reloadScenario = scenario?.startsWith("reload-");
  const overlapScenario = scenario?.startsWith("overlap-");
  let overlapResponseComplete = false;
  let enterOldStart!: () => void;
  const oldStartEntered = new Promise<void>(resolve => { enterOldStart = resolve; });
  let releaseOldStart!: () => void;
  const oldStartGate = new Promise<void>(resolve => { releaseOldStart = resolve; });
  let finishOldRun!: () => void;
  const oldRunSettled = new Promise<void>(resolve => { finishOldRun = resolve; });
  let finishFreshRun!: () => void;
  const freshRunSettled = new Promise<void>(resolve => { finishFreshRun = resolve; });
  const reloadState = reloadScenario ? ((globalThis as any)[Symbol.for("mux-test.extension-reload")] ??= { loads: 0, providerCalls: [] }) : undefined;
  const busyModelScenario = scenario === "busy-follow-up-model" || scenario === "busy-steer-model";
  const concurrentBusyScenario = scenario === "busy-concurrent-input-gate";
  const terminalScenario = scenario?.startsWith("terminal-");
  const stopScenario = scenario?.startsWith("stop-") || terminalScenario;
  let failPolling!: (error: Error) => void;
  let releaseTerminalInput!: () => void;
  const terminalInputGate = new Promise<void>(resolve => { releaseTerminalInput = resolve; });
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  let releaseBusyInput!: () => void;
  const busyInputProcessed = new Promise<void>(resolve => { releaseBusyInput = resolve; });
  let beginFirstResponse!: () => void;
  const firstResponseStarted = new Promise<void>(resolve => { beginFirstResponse = resolve; });
  let releaseConcurrentInput!: () => void;
  const concurrentInputGate = new Promise<void>(resolve => { releaseConcurrentInput = resolve; });
  let recoveringAfterStop = false;
  let inputWaited = false;
  let modelChanged = false;
  globalThis.fetch = async () => { throw new Error("External network is forbidden in lifecycle tests"); };
  TelegramClient.prototype.getMe = async () => ({ id: 1, is_bot: true, first_name: "Fixture", username: "fixture_bot" });
  TelegramClient.prototype.getChat = async id => ({ id, type: "supergroup", is_forum: true });
  TelegramClient.prototype.getChatMember = async () => ({ status: "administrator", can_manage_topics: true });
  TelegramClient.prototype.getUpdates = options => new Promise((_resolve, reject) => {
    failPolling = reject;
    const signal = options!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  let answers = 0;
  const modelInputs: string[][] = [];
  const modelImageCounts: number[] = [];
  pi.registerProvider("mux-review", {
    baseUrl: "http://127.0.0.1:1", apiKey: "fake-test-key", api: "openai-completions",
    models: ["fake", "fake-other"].map(id => ({ id, name: id, reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model, context) => {
      if (reloadState) reloadState.providerCalls.push(structuredClone(context.messages));
      modelImageCounts.push(context.messages.reduce((sum, message) => sum + ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) ? message.content.filter(part => part.type === "image").length : 0), 0));
      modelInputs.push(context.messages.filter(message => message.role === "user").map(message =>
        typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("")));
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${++answers}` }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (answers === 1) beginFirstResponse();
      const response = scenario === "album-read" && answers === 1
        ? { ...message, stopReason: "toolUse" as const, content: [...modelInputs.at(-1)!.at(-1)!.matchAll(/^\[Image#\d+\] (.+)$/gm)].map((match, index) =>
          ({ type: "toolCall" as const, id: `read-${index}`, name: "read", arguments: { path: match[1] } })) }
        : scenario === "length-follow-up" && answers === 1
          ? { ...message, stopReason: "length" as const, usage: { ...message.usage, output: model.maxTokens, totalTokens: model.maxTokens + 1 } }
          : message;
      const ready = overlapScenario && answers === 1 ? modelGate : busyModelScenario && answers === 1 ? busyInputProcessed : new Promise<void>(resolve => setTimeout(resolve, 25));
      void ready.then(() => { if (overlapScenario) overlapResponseComplete = true; stream.push({ type: "start", partial: response }); stream.push({ type: "done", reason: response.stopReason, message: response }); stream.end(); });
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
  if (reloadState) {
    const firstLoad = ++reloadState.loads === 1;
    if (firstLoad) {
      reloadState.oldEntered = new Promise<void>(resolve => { reloadState.enterOld = resolve; });
      reloadState.oldGate = new Promise<void>(resolve => { reloadState.releaseOld = resolve; });
      reloadState.freshEntered = new Promise<void>(resolve => { reloadState.enterFresh = resolve; });
      reloadState.freshGate = new Promise<void>(resolve => { reloadState.releaseFresh = resolve; });
    }
    reloadState.runtime = runtime;
    reloadState.pi = pi;
    pi.on("session_start", async (_event, ctx) => {
      pi.appendEntry("pi-telegram-mux.binding", { version: 1, sessionId: ctx.sessionManager.getSessionId(), chatId: -100123, threadId: 50 });
      await runtime.onSessionStart(tui(ctx));
      reloadState.ctx = tui(ctx);
    });
    const muxInput = async (_event: unknown, ctx: ExtensionContext) => {
      const result = await runtime.onInput(tui(ctx));
      if (result?.action === "handled") reloadState.finishTurn();
      return result;
    };
    // The after-check cases force cancellation through the NEW agent_start
    // handler: the old input has already passed mux's input checkpoint.
    if (!scenario!.includes("before-check")) pi.on("input", muxInput);
    pi.on("input", async event => {
      if (firstLoad) { reloadState.enterOld(); await reloadState.oldGate; }
      else if (event.text === "fresh remote") { reloadState.enterFresh(); await reloadState.freshGate; }
      return { action: "continue" };
    });
    if (scenario!.includes("before-check")) pi.on("input", muxInput);
    pi.on("before_agent_start", (event, ctx) => runtime.onBeforeAgentStart(event, tui(ctx)));
    pi.on("agent_start", (_event, ctx) => runtime.onAgentStart(tui(ctx)));
    pi.on("message_start", (event, ctx) => runtime.onMessageStart(event.message, tui(ctx)));
    pi.on("message_end", event => runtime.onMessageEnd(event.message));
    pi.on("turn_end", event => runtime.onTurnEnd(event.message));
    pi.on("agent_settled", async (_event, ctx) => {
      await runtime.onAgentSettled(tui(ctx));
      await runtime.outbox.whenIdle();
      reloadState.finishTurn();
    });
    pi.on("session_shutdown", (_event, ctx) => runtime.onSessionShutdown(tui(ctx)));
    pi.registerCommand("review-inbound", { handler: async (_args, ctx) => {
      const leader = (runtime as any).coordinator as LeaderCoordinator;
      const client = leader.getTelegramClient();
      client.sendMessage = async () => ({ message_id: 100 } as any);
      client.getFile = async () => ({ file_id: "image", file_unique_id: "image", file_path: "photos/image.png" });
      client.downloadFile = async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTt4AAAAASUVORK5CYII=", "base64");
      const image = scenario!.includes("image");
      const update = { update_id: 1, message: {
        message_id: 1, message_thread_id: 50, chat: { id: -100123, type: "supergroup" }, date: 1,
        from: { id: 123, is_bot: false, first_name: "Fixture" },
        ...(image ? { caption: "cancelled image", photo: [{ file_id: "image", file_unique_id: "image", width: 1, height: 1 }] } : { text: "cancelled text" }),
      } };
      const pending = leader.processUpdate(update);
      await reloadState.oldEntered;
      const oldAdmission = (runtime as any).pendingInput;
      if (scenario!.includes("timeout")) await pending;
      if (!scenario!.includes("shutdown")) await leader.processUpdate({ ...update, message: { ...update.message, photo: undefined, text: "/stop" } });
      await ctx.reload();
      await pending;
      // From here use only the new extension's API/context. The old command's
      // context is stale, but its ordinary gate values remain safe to release.
      const freshRuntime = reloadState.runtime as MuxRuntime;
      const fresh = freshRuntime.handleInboundText("fresh remote", reloadState.ctx);
      await reloadState.freshEntered;
      const freshAdmission = (freshRuntime as any).pendingInput;
      const records = (globalThis as any)[Symbol.for("pi-telegram-mux.mobile-admissions.v1")] as Set<unknown>;
      const retainedBeforeResume = records.has(oldAdmission) && records.has(freshAdmission);
      const oldDone = new Promise<void>(resolve => { reloadState.finishTurn = resolve; });
      reloadState.releaseOld();
      await oldDone;
      const cancelledProviderCalls = reloadState.providerCalls.length;
      const isolated = (freshRuntime as any).pendingInput === freshAdmission && records.has(freshAdmission) && !records.has(oldAdmission);
      const freshDone = new Promise<void>(resolve => { reloadState.finishTurn = resolve; });
      reloadState.releaseFresh();
      const freshResult = await fresh;
      await freshDone;
      const localDone = new Promise<void>(resolve => { reloadState.finishTurn = resolve; });
      reloadState.pi.sendUserMessage("fresh local");
      await localDone;
      reloadState.ctx.ui.notify(JSON.stringify({ type: "mux_review_result", loads: reloadState.loads,
        cancelled: oldAdmission.signal.aborted, cancelledProviderCalls, retainedBeforeResume, isolated,
        freshAccepted: freshResult.accepted, providerCalls: reloadState.providerCalls.length,
        providerMessages: reloadState.providerCalls,
        records: records.size, idle: freshRuntime.getIsIdle() }), "info");
    } });
    return;
  }
  pi.on("session_start", async (_event, ctx) => {
    if (scenario === "reconnect") {
      coordinator = new LeaderCoordinator((await loadConfig(process.env.PI_CODING_AGENT_DIR!))!, process.env.PI_CODING_AGENT_DIR!);
      coordinator.getTelegramClient().sendMessage = async (_chat, text) => { feedback.push(text); return {} as any; };
      await coordinator.start();
    }
    pi.appendEntry("pi-telegram-mux.binding", { version: 1, sessionId: ctx.sessionManager.getSessionId(), chatId: -100123, threadId: 50 });
    await runtime.onSessionStart(tui(ctx));
  });
  if (scenario === "stop-input-after" || terminalScenario) pi.on("input", (_event, ctx) => runtime.onInput(tui(ctx)));
  if (scenario !== "reconnect") pi.on("input", async (event, ctx) => {
    if (recoveringAfterStop) return { action: "continue" };
    if (overlapScenario) return { action: "continue" };
    if (terminalScenario) {
      inputWaited = true;
      if (scenario === "terminal-admission-unknown") await terminalInputGate;
      else {
        failPolling(new TelegramApiError("Unauthorized", 401));
        await (runtime as any).coordinator.pollingTask;
      }
      return { action: "continue" };
    }
    if (stopScenario) {
      if (scenario !== "stop-start") {
        inputWaited = true;
        const leader = (runtime as any).coordinator as LeaderCoordinator;
        await leader.processUpdate({ update_id: 9, message: {
          message_id: 9, message_thread_id: 50, chat: { id: -100123, type: "supergroup" }, date: 1,
          from: { id: 123, is_bot: false, first_name: "Fixture" }, text: "/stop",
        } });
      }
      return { action: "continue" };
    }
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
    if (albumScenario || scenario === "follow-up" || scenario === "length-follow-up") return { action: "continue" };
    await new Promise(resolve => setTimeout(resolve, 20));
    if (scenario === "config") await runtime.handleTgSetup(tui(ctx));
    return { action: "transform", text: "completely transformed" };
  });
  if (scenario === "stop-input-before") pi.on("input", (_event, ctx) => runtime.onInput(tui(ctx)));
  if (busyModelScenario) {
    pi.on("model_select", async () => { await modelGate; });
  }
  const pauseObsoleteStart = async (event: { prompt: string }) => {
    if (event.prompt.includes("obsolete")) { enterOldStart(); await oldStartGate; }
  };
  if (overlapScenario && scenario!.includes("before")) pi.on("before_agent_start", pauseObsoleteStart);
  pi.on("before_agent_start", async (event, ctx) => { starts++; await runtime.onBeforeAgentStart(event, tui(ctx)); });
  if (overlapScenario && scenario!.includes("after")) pi.on("before_agent_start", pauseObsoleteStart);
  if (scenario === "stop-start") pi.on("before_agent_start", async () => {
    if (recoveringAfterStop) return;
    const leader = (runtime as any).coordinator as LeaderCoordinator;
    await leader.processUpdate({ update_id: 9, message: {
      message_id: 9, message_thread_id: 50, chat: { id: -100123, type: "supergroup" }, date: 1,
      from: { id: 123, is_bot: false, first_name: "Fixture" }, text: "/stop",
    } });
  });
  pi.on("agent_start", (_event, ctx) => runtime.onAgentStart(tui(ctx)));
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
  pi.on("message_end", event => runtime.onMessageEnd(event.message));
  pi.on("turn_end", event => { runtime.onTurnEnd(event.message); });
  pi.on("agent_settled", async (_event, ctx) => {
    if (concurrentBusyScenario) releaseConcurrentInput();
    await runtime.onAgentSettled(tui(ctx));
    // Test observation only: production handlers never await the outbox.
    await runtime.outbox.whenIdle();
    if (overlapScenario) {
      if ((runtime as any).inputOrigin.getStore()?.signal.aborted) finishOldRun();
      else finishFreshRun();
      return;
    }
    if (recoveringAfterStop) finishFreshRun();
    if (stopScenario || (concurrentBusyScenario && (received.length < 3 || answers < 3))) return;
    ctx.ui.notify(JSON.stringify({ type: "mux_review_result", texts, reactions, received, modelInputs, modelImageCounts, admitted, starts, feedback, inputWaited, modelChanged, idle: runtime.getIsIdle(), error: runtime.outbox.error?.message }), "info");
  });
  pi.on("session_shutdown", async (_event, ctx) => { await runtime.onSessionShutdown(tui(ctx)); await coordinator?.stop(); });
  pi.registerCommand("review-inbound", { handler: async (_args, ctx) => {
    if (overlapScenario) {
      const leader = (runtime as any).coordinator as LeaderCoordinator;
      const client = leader.getTelegramClient();
      client.sendMessage = async () => ({ message_id: 100 } as any);
      client.getFile = async () => ({ file_id: "image", file_unique_id: "image", file_path: "photos/image.png" });
      client.downloadFile = async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTt4AAAAASUVORK5CYII=", "base64");
      const base = { message_id: 1, message_thread_id: 50, chat: { id: -100123, type: "supergroup" }, date: 1, from: { id: 123, is_bot: false, first_name: "Fixture" } };
      const oldTask = leader.processUpdate({ update_id: 1, message: { ...base,
        ...(scenario!.includes("image") ? { caption: "obsolete", photo: [{ file_id: "image", file_unique_id: "image", width: 1, height: 1 }] } : { text: "obsolete" }),
      } });
      await oldStartEntered;
      await leader.processUpdate({ update_id: 2, message: { ...base, message_id: 2, text: "/stop" } });
      await oldTask;
      await leader.processUpdate({ update_id: 3, message: { ...base, message_id: 3, text: "surviving task" } });
      await firstResponseStarted;
      const liveRun = (runtime as any).currentRun;
      releaseOldStart();
      await oldRunSettled;
      const keptRun = (runtime as any).currentRun === liveRun;
      const prematureIdle = runtime.getIsIdle();
      // Pi's obsolete prompt also resets its own idle flag in finally. The
      // held provider response, not that flag, proves the fresh request is active.
      const providerStillPending = !overlapResponseComplete;
      releaseModel();
      await freshRunSettled;
      await runtime.outbox.whenIdle();
      ctx.ui.notify(JSON.stringify({ type: "mux_review_result", keptRun, prematureIdle, providerStillPending, texts, modelInputs, modelImageCounts, idle: runtime.getIsIdle(), error: runtime.outbox.error?.message }), "info");
      return;
    }
    if (!albumScenario && !stopScenario) { admitted = await runtime.handleInboundText("original", tui(ctx)); return; }
    const leader = (runtime as any).coordinator as LeaderCoordinator;
    (leader as any).options.albumDelayMs = 10;
    const client = leader.getTelegramClient();
    client.sendMessage = async (_chat, text) => { feedback.push(text); return { message_id: nextMessageId++ } as any; };
    client.getFile = async id => ({ file_id: id, file_unique_id: id, file_path: `photos/${id}.png` });
    // Valid 2x2 PNG for the actual native read tool (including decoder validation).
    client.downloadFile = async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAVSURBVBhXY/jPAEQNIIrhPxD8/w8AQ9QJeKxchO4AAAAASUVORK5CYII=", "base64");
    await Promise.all([1, 2].map(id => leader.processUpdate({ update_id: id, message: {
      message_id: id, message_thread_id: 50, chat: { id: -100123, type: "supergroup" }, date: 1,
      from: { id: 123, is_bot: false, first_name: "Fixture" }, media_group_id: "one-album",
      caption: id === 1 ? "Compare these images" : undefined,
      document: { file_id: `image${id}`, file_unique_id: `image${id}`, mime_type: "image/png" },
    } })));
    if (scenario === "terminal-admission-unknown") {
      // The real 2s admission deadline has replied, but Pi is still inside the
      // input hook. Terminal transport status must revoke that retired RPC too.
      failPolling(new TelegramApiError("Unauthorized", 401));
      await (leader as any).pollingTask;
      releaseTerminalInput();
    }
    if (stopScenario) {
      // Let the real void sendUserMessage pipeline drain, including the handled
      // path which deliberately emits no agent_settled event.
      await new Promise(resolve => setTimeout(resolve, 100));
      await runtime.outbox.whenIdle();
      await leader.feedback.whenIdle();
      const cancelledProviderCalls = modelInputs.length;
      let freshAccepted: boolean | undefined;
      if (scenario!.startsWith("stop-")) {
        recoveringAfterStop = true;
        freshAccepted = (await runtime.handleInboundText("fresh after stop", tui(ctx))).accepted;
        await freshRunSettled;
      }
      ctx.ui.notify(JSON.stringify({ type: "mux_review_result", texts, reactions, received, modelInputs, modelImageCounts, starts, feedback, cancelledProviderCalls, freshAccepted, idle: runtime.getIsIdle(), error: runtime.outbox.error?.message }), "info");
    }
  } });
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

import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendBindingEntry, resolveBindingState } from "./binding.js";
import { configFingerprint, loadConfig, saveConfig, validateConfig } from "./config.js";
import { LeaderCoordinator } from "./coordinator.js";
import { IpcError, IpcFollowerClient } from "./ipc.js";
import { BoundedOutbox } from "./outbox.js";
import { extractAssistantText, extractUserText, splitTelegramMessage } from "./render.js";
import { TelegramClient, validateBotAndChat } from "./telegram.js";
import type { BindingState, InboundResult, MuxConfig, OutputTarget, RuntimeRegistration, TelegramForumTopic } from "./types.js";

const MAX_MIRRORED_TEXT_LENGTH = 65_536;

export const TG_STATUS_KEY = "tg";
export type TgStatusColor = "muted" | "dim";
export interface TgStatusInfo { text: string; color: TgStatusColor; }

export function getTgStatusText(options: {
  config: MuxConfig | null;
  isReconnecting: boolean;
  isConflict: boolean;
  hasError?: boolean;
  hasActiveTransport: boolean;
  bindingState: BindingState;
  threadId: number | null;
  shortId?: string | null;
}): TgStatusInfo {
  if (!options.config && !options.hasError) return { text: "tg: unconfigured", color: "dim" };
  if (options.isReconnecting) return { text: "tg: reconnecting", color: "muted" };
  if (options.isConflict) return { text: "tg: conflict (409)", color: "muted" };
  if (options.hasError) return { text: "tg: error", color: "muted" };
  if (!options.hasActiveTransport) return { text: "tg: offline", color: "muted" };
  switch (options.bindingState) {
    case "bound": {
      const id = options.shortId ? ` (${options.shortId})` : options.threadId !== null ? ` (#${options.threadId})` : "";
      return { text: `tg: connected${id}`, color: "muted" };
    }
    case "disconnected": return { text: "tg: disconnected", color: "dim" };
    case "create-unknown": return { text: "tg: error", color: "muted" };
    default: return { text: "tg: ready", color: "dim" };
  }
}

export function formatStatus(text: string, color: TgStatusColor, theme?: { fg?: (color: TgStatusColor, text: string) => string }): string {
  return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
}

interface Admission {
  sessionId: string;
  generation: number;
  config: MuxConfig | null;
  consumed: boolean;
  resolve?: (result: InboundResult) => void;
  timer: NodeJS.Timeout;
}

interface MirrorRun {
  sessionId: string;
  generation: number;
  config: MuxConfig | null;
  ctx: ExtensionContext;
  target: OutputTarget | null;
  origin?: Admission;
  suppressed: boolean;
  firstUserMessage: boolean;
  text: string;
  stopReason?: string;
  settled: Promise<void>;
  settle: () => void;
}

export class MuxRuntime {
  readonly runtimeId = crypto.randomUUID();
  private generation = 1;
  private isIdle = true;
  private active = false;
  private bindingState: BindingState = "unbound";
  private currentThreadId: number | null = null;
  private registeredTarget: OutputTarget | null = null;
  private topicNeedsReopen = false;
  private lastValidThreadId: number | null = null;
  private isLeader = false;
  private isReconnecting = false;
  private recovering = false;
  private activeCtx: ExtensionContext | null = null;
  private config: MuxConfig | null = null;
  private coordinator: LeaderCoordinator | null = null;
  private followerClient: IpcFollowerClient | null = null;
  private transportVersion = 0;
  private setupTask: Promise<void> | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private lastTransportError = "";
  private connectionError: Error | null = null;
  private configuring = false;
  private configurationTask: Promise<void> | null = null;
  private createInFlight = false;
  private readonly unknownCreates = new Set<string>();
  private currentRun: MirrorRun | null = null;
  private pendingInput?: Admission;
  private readonly inputOrigin = new AsyncLocalStorage<Admission>();
  public readonly outbox: BoundedOutbox;

  constructor(private readonly pi: ExtensionAPI, private readonly agentDir: string) {
    this.outbox = new BoundedOutbox(error => {
      this.activeCtx?.ui?.notify(`Telegram sync paused: ${error.message}`, "error");
      this.updateStatusBar();
    });
  }

  public getBindingState(): BindingState { return this.bindingState; }
  public getCurrentThreadId(): number | null { return this.currentThreadId; }
  public getIsIdle(): boolean { return this.isIdle && !this.pendingInput; }
  public getIsLeader(): boolean { return this.isLeader; }
  public getIsReconnecting(): boolean { return this.isReconnecting || this.recovering; }
  public getGeneration(): number { return this.generation; }
  public hasActiveTransport(): boolean { return Boolean(this.coordinator?.isRunning() || this.followerClient?.isConnected()); }

  public updateStatusBar(explicitCtx?: ExtensionContext): void {
    const ctx = explicitCtx ?? this.activeCtx;
    if (typeof ctx?.ui?.setStatus !== "function") return;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const status = this.coordinator?.getStatus() ?? this.followerClient?.getStatus();
    const failure = status?.error ?? status?.feedbackError;
    const notice = failure ? `${failure.code}: ${failure.message}` : "";
    if (notice && notice !== this.lastTransportError) ctx.ui.notify(`Telegram ${notice}`, status?.polling === "retrying" ? "warning" : "error");
    this.lastTransportError = notice;
    const { text, color } = getTgStatusText({
      config: this.config, isReconnecting: this.getIsReconnecting(),
      isConflict: status?.polling === "conflict", hasError: Boolean(this.outbox.error || failure || this.connectionError), hasActiveTransport: this.hasActiveTransport(),
      bindingState: this.bindingState, threadId: this.currentThreadId, shortId: sessionId?.slice(-6),
    });
    ctx.ui.setStatus(TG_STATUS_KEY, formatStatus(text, color, ctx.ui.theme));
  }

  public clearStatusBar(explicitCtx?: ExtensionContext): void {
    const ctx = explicitCtx ?? this.activeCtx;
    ctx?.ui?.setStatus?.(TG_STATUS_KEY, undefined);
  }

  private applyConfig(config: MuxConfig, ctx: ExtensionContext): void {
    this.invalidateRun();
    this.config = config;
    this.connectionError = null;
    const resolved = resolveBindingState(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId(), config.chatId);
    const uncertain = this.unknownCreates.has(`${ctx.sessionManager.getSessionId()}:${config.chatId}`);
    this.bindingState = resolved.state === "unbound" && uncertain ? "create-unknown" : resolved.state;
    this.currentThreadId = resolved.threadId;
    this.lastValidThreadId = resolved.lastValidThreadId;
  }

  /** Only one connection attempt may be in flight, and shutdown invalidates it. */
  public setupTransport(ctx: ExtensionContext): Promise<void> {
    if (!this.active || this.configuring || !this.config) return Promise.resolve();
    if (this.setupTask) return this.setupTask;
    if (this.hasActiveTransport()) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.isReconnecting = false;
      this.connectionError = null;
      this.updateStatusBar(ctx);
      return Promise.resolve();
    }
    const version = this.transportVersion;
    this.setupTask = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const config = await loadConfig(this.agentDir);
        if (!this.active || version !== this.transportVersion || !config) return;
        if (JSON.stringify(config) !== JSON.stringify(this.config)) this.applyConfig(config, ctx);
        const candidate = new LeaderCoordinator(config, this.agentDir, undefined, {
          onConfigChange: async next => {
            if (this.active && version === this.transportVersion) {
              this.applyConfig(next, ctx);
              await this.registerRoute(ctx);
            }
          },
          onStatusChange: () => { if (this.active && version === this.transportVersion) this.updateStatusBar(); },
        });
        try {
          const result = await candidate.start();
          if (!this.active || version !== this.transportVersion) { await candidate.stop(); return; }
          if (result.leader) {
            this.coordinator = candidate;
            this.isLeader = true;
          } else {
            await candidate.stop();
            const client = new IpcFollowerClient(result.port, result.capability, this.runtimeId);
            this.followerClient = client;
            client.setStatusHandler(() => { if (this.active && version === this.transportVersion) this.updateStatusBar(ctx); });
            client.setInboundHandler(msg => {
              if (!this.isTargetCurrent(msg.target, ctx) || msg.fromId !== this.config?.allowedUserId) return Promise.resolve({ accepted: false, busy: true });
              return this.handleInboundText(msg.text, ctx);
            });
            client.setAbortHandler(target => {
              if (!this.isTargetCurrent(target, ctx) || !ctx.abort) return false;
              ctx.abort();
              return true;
            });
            client.setDisconnectHandler(reason => {
              if (this.active && version === this.transportVersion && this.followerClient === client) {
                const failure = client.getStatus().error;
                const reset = reason?.code === "IPC_TRANSPORT_RESET";
                // Only an explicit Leader reset owns cancellation of stale work;
                // ordinary connection loss must retain genuine outbox failures.
                if (reset) this.invalidateRun();
                this.followerClient = null;
                if (!reset && failure?.code === "IPC_PROTOCOL_ERROR") this.connectionFailed(new IpcError(failure.code, failure.message), ctx);
                else this.scheduleReconnect(ctx);
              }
            });
            await client.connect();
            if (!this.active || version !== this.transportVersion) { client.close(); return; }
            if (!client.isConnected() || this.followerClient !== client) throw new IpcError("IPC_CLOSED", "IPC reset during authentication");
            this.isLeader = false;
            if (client.getConfigFingerprint() !== configFingerprint(config)) {
              // A disconnected setup or manual config edit must also update the existing
              // Leader before this Runtime can claim a route or submit a business request.
              await client.register({ runtimeId: this.runtimeId, sessionId: ctx.sessionManager.getSessionId(), threadId: null, generation: this.generation });
              await client.reloadConfig();
              client.close();
              if (this.followerClient === client) this.followerClient = null;
              continue;
            }
          }
          const registered = await this.registerRoute(ctx);
          if (!this.active || version !== this.transportVersion) return;
          // ACK and reset may share one frame batch; an ACK is not proof that
          // the transport still exists when this continuation resumes.
          if (!this.hasActiveTransport()) throw new IpcError("IPC_CLOSED", "IPC reset during registration");
          this.connectionError = null;
          // Reconnection must finish a restored session's pending topic reopen before accepting input.
          if (registered && this.topicNeedsReopen) await this.reopenTopic(ctx);
          if (!this.active || version !== this.transportVersion) return;
          if (!this.hasActiveTransport()) throw new IpcError("IPC_CLOSED", "IPC reset during topic reopening");
          this.isReconnecting = false;
          this.updateStatusBar(ctx);
          return;
        } catch (err) {
          // Failed election/authentication/registration must release partial
          // transport resources and propagate, never masquerade as a connection.
          await candidate.stop();
          if (this.coordinator === candidate) this.coordinator = null;
          this.followerClient?.close();
          this.followerClient = null;
          this.isLeader = false;
          throw err;
        }
      }
      throw new IpcError("IPC_CONFIG_BUSY", "Telegram configuration kept changing during connection; retry later");
    })().finally(() => { this.setupTask = null; });
    return this.setupTask;
  }

  private connectionFailed(error: unknown, ctx: ExtensionContext): void {
    // Connection supervision boundary: only known election/socket races retry.
    // Invalid configuration/JSON, protocol violations and unknown errors are fatal.
    if (!this.active) return;
    this.connectionError = error instanceof Error ? error : new Error("Telegram connection failed", { cause: error });
    ctx.ui?.notify(`Telegram connection failed: ${this.connectionError.message}`, "error");
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "IPC_CLOSED", "IPC_TIMEOUT", "IPC_ELECTION_BUSY", "IPC_CONFIG_BUSY"].includes(code)) this.scheduleReconnect(ctx);
    else { this.isReconnecting = false; this.updateStatusBar(ctx); }
  }

  private scheduleReconnect(ctx: ExtensionContext): void {
    if (!this.active || this.configuring || this.reconnectTimer) return;
    this.isReconnecting = true;
    this.updateStatusBar(ctx);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.setupTransport(ctx).catch(error => this.connectionFailed(error, ctx));
    }, 500);
    this.reconnectTimer.unref();
  }

  private async stopTransport(): Promise<void> {
    this.transportVersion++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.followerClient?.close();
    try { await this.setupTask; }
    catch (error) {
      // Intentional shutdown closes an in-flight authentication/RPC socket. Only
      // that identified cancellation is benign; all other setup failures propagate.
      if (!(error instanceof IpcError && error.code === "IPC_CLOSED")) throw error;
    } finally {
      this.followerClient?.close();
      this.followerClient = null;
      if (this.coordinator) await this.coordinator.stop();
      this.coordinator = null;
      this.registeredTarget = null;
      this.isLeader = false;
      this.isReconnecting = false;
    }
  }

  public async registerRoute(ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!this.active) return false;
    const sessionId = ctx.sessionManager.getSessionId();
    const threadId = this.bindingState === "bound" ? this.currentThreadId : null;
    const reg: RuntimeRegistration = { runtimeId: this.runtimeId, sessionId, threadId, generation: this.generation };
    if (this.coordinator && threadId !== null) {
      const target: OutputTarget = { sessionId, threadId, generation: this.generation };
      const ok = this.coordinator.registerLocalRoute({
        ...target, runtimeId: this.runtimeId,
        dispatchInbound: text => this.isTargetCurrent(target, ctx) ? this.handleInboundText(text, ctx) : Promise.resolve({ accepted: false, busy: true }),
        abortRun: () => { if (!this.isTargetCurrent(target, ctx) || !ctx.abort) return false; ctx.abort(); return true; },
      });
      if (!ok) ctx.ui?.notify("This topic is already occupied by another Pi instance. Please close duplicate sessions before reconnecting.", "warning");
      if (ok) this.registeredTarget = target;
      return ok;
    }
    if (this.followerClient?.isConnected()) {
      await this.followerClient.register(reg, signal);
      if (this.active && reg.generation === this.generation) {
        this.registeredTarget = threadId === null ? null : { sessionId, threadId, generation: reg.generation };
      }
    }
    return this.hasActiveTransport();
  }

  public unregisterRoute(ctx: ExtensionContext): void {
    this.registeredTarget = null;
    if (this.currentThreadId === null) return;
    this.coordinator?.unregisterLocalRoute(this.currentThreadId, this.runtimeId);
    if (this.followerClient?.isConnected()) {
      this.followerClient.send({ type: "release", runtimeId: this.runtimeId, sessionId: ctx.sessionManager.getSessionId() });
    }
  }

  private isTargetCurrent(target: OutputTarget, ctx: ExtensionContext): boolean {
    return this.active && !this.configuring && this.bindingState === "bound" && target.threadId === this.currentThreadId &&
      target.generation === this.generation && target.sessionId === ctx.sessionManager.getSessionId();
  }

  public async callTelegram<T>(method: string, params: Record<string, unknown>, target?: OutputTarget, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.active || this.configuring || (target && (!this.activeCtx || !this.isTargetCurrent(target, this.activeCtx)))) throw new Error("Telegram output target is no longer active");
    if (this.coordinator) return this.coordinator.callTelegram<T>(method, params, this.runtimeId, target, undefined, signal);
    if (this.followerClient) return this.followerClient.callTelegram<T>(method, params, target, undefined, signal);
    throw new Error("No active transport to Telegram Leader");
  }

  public handleInboundText(text: string, ctx: ExtensionContext): Promise<InboundResult> {
    if (!this.active || this.configuring || this.getIsReconnecting() || this.bindingState !== "bound" || !this.getIsIdle() || !ctx.isIdle()) return Promise.resolve({ accepted: false, busy: true });
    if (this.outbox.error) return Promise.resolve({ accepted: false, busy: false, statusReply: "Telegram sync is paused. Please check errors on your computer and run /tg-connect to retry." });
    if (!text.trim() || text.length > 4096) return Promise.resolve({ accepted: false, busy: true });
    // Reserve admission synchronously. Pi's void return is not an execution ACK.
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        // An ACK deadline cannot cancel Pi's asynchronous input hooks. Keep the
        // reservation until a real admission event, even after reporting uncertainty.
        this.finishInput({ accepted: false, busy: false, statusReply: "Task admission result unknown. Mobile input has been paused; please check local session and do not resend automatically. If unconfirmed, restart this Pi instance." }, false);
      }, 2000);
      const admission: Admission = { sessionId: ctx.sessionManager.getSessionId(), generation: this.generation, config: this.config, consumed: false, resolve, timer };
      this.pendingInput = admission;
      // Async context survives Pi's awaited input transformations. Neither origin
      // nor authority is inferred from mutable prompt text or a global pending slot.
      try { this.inputOrigin.run(admission, () => this.pi.sendUserMessage(text, { expandPromptTemplates: false })); }
      catch (error) {
        // The public void API can reject synchronously (e.g. stale session API).
        // Translate that rejection at the inbound boundary, never claim acceptance.
        this.finishInput({ accepted: false, busy: false, statusReply: "Pi rejected the task. Please check local errors." });
        ctx.ui?.notify(`Telegram input failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });
  }

  private finishInput(result: InboundResult, release = true): void {
    const pending = this.pendingInput;
    if (!pending) return;
    if (release) this.pendingInput = undefined;
    clearTimeout(pending.timer);
    pending.resolve?.(result);
    pending.resolve = undefined;
  }

  public onMessageStart(message: unknown, ctx: ExtensionContext): void {
    const run = this.currentRun;
    if (!run || !message || typeof message !== "object" || !("role" in message)) return;
    if (message.role === "assistant") { run.text = ""; run.stopReason = undefined; return; }
    if (message.role !== "user") return;
    run.text = "";
    run.stopReason = undefined;
    if (run.firstUserMessage) {
      run.firstUserMessage = false;
      if (run.origin) {
        run.origin.consumed = true;
        if (this.pendingInput === run.origin) this.finishInput({ accepted: !run.suppressed, busy: false });
        return;
      }
    }
    const text = extractUserText(message);
    if (text.trim() && this.isRunCurrent(run)) {
      // Actual user-message admission also covers steering/follow-up messages,
      // which Pi delivers without another before_agent_start event.
      const prompt = `🧑‍💻 [Prompt]\n${text.length <= MAX_MIRRORED_TEXT_LENGTH ? text : "Prompt is too long. Please view it locally in Pi; task results will still be synced."}`;
      this.outbox.enqueue(signal => this.sendRunText(prompt, run, signal), Buffer.byteLength(prompt, "utf-8"));
    }
  }

  public async onSessionStart(eventOrCtx: { reason?: string } | ExtensionContext, maybeCtx?: ExtensionContext): Promise<void> {
    const ctx = maybeCtx ?? eventOrCtx as ExtensionContext;
    const event = maybeCtx ? eventOrCtx as { reason?: string } : undefined;
    if (ctx.mode !== "tui") return;
    this.active = true;
    this.activeCtx = ctx;
    const version = this.transportVersion;
    const config = await loadConfig(this.agentDir);
    if (!this.active || version !== this.transportVersion) return;
    this.config = config;
    if (this.config) {
      this.applyConfig(this.config, ctx);
      try { await this.setupTransport(ctx); }
      catch (error) { this.connectionFailed(error, ctx); }
    }
    if (this.active && version === this.transportVersion) {
      this.updateStatusBar(ctx);
      if (this.bindingState === "bound" && (event?.reason === "startup" || event?.reason === "resume" || event?.reason === "reload")) {
        this.topicNeedsReopen = true;
        await this.reopenTopic(ctx);
      }
    }
  }

  /** Reopening has a bounded deadline and reports non-idempotent failures without failing Pi startup. */
  private async reopenTopic(ctx: ExtensionContext): Promise<boolean> {
    const target = this.registeredTarget;
    const config = this.config;
    const version = this.transportVersion;
    if (!target || !config || !this.isTargetCurrent(target, ctx) || !this.hasActiveTransport()) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await this.callTelegram("reopenForumTopic", { chat_id: config.chatId, message_thread_id: target.threadId }, target, controller.signal);
    } catch (error) {
      if (!this.isTargetCurrent(target, ctx) || version !== this.transportVersion) return false;
      // Telegram returns this error when the topic is already open, including through IPC.
      if (!(error instanceof Error && /^(?:Bad Request: )?TOPIC_NOT_MODIFIED$/i.test(error.message))) {
        this.connectionError = error instanceof Error ? error : new Error("Telegram topic reopen failed", { cause: error });
        ctx.ui?.notify(`Telegram topic reopen failed: ${this.connectionError.message}; please check and run /tg-connect to retry.`, "error");
        this.updateStatusBar(ctx);
        return false;
      }
    } finally {
      clearTimeout(timer);
    }
    if (!this.isTargetCurrent(target, ctx) || version !== this.transportVersion) return false;
    this.topicNeedsReopen = false;
    this.connectionError = null;
    this.updateStatusBar(ctx);
    return true;
  }

  public async onBeforeAgentStart(eventOrCtx: { prompt?: string } | ExtensionContext, maybeCtx?: ExtensionContext): Promise<void> {
    const ctx = maybeCtx ?? eventOrCtx as ExtensionContext;
    this.activeCtx = ctx;
    this.isIdle = false;
    const origin = this.inputOrigin.getStore();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    // Runs admitted during recovery/configuration must never gain a target later.
    const run: MirrorRun = {
      sessionId: ctx.sessionManager.getSessionId(), generation: this.generation, config: this.config, ctx,
      target: null, origin: origin?.consumed ? undefined : origin,
      suppressed: this.getIsReconnecting() || this.configuring || Boolean(origin && (origin.generation !== this.generation || origin.config !== this.config || origin.sessionId !== ctx.sessionManager.getSessionId())),
      firstUserMessage: true, text: "", settled, settle,
    };
    this.currentRun = run;
    if (!this.isRunCurrent(run)) return;
    const canCreate = !origin && !ctx.sessionManager.getEntries().some(e => e.type === "message" && e.message.role === "assistant");
    // Enqueue preparation, never await Telegram/IPC in a Pi lifecycle handler.
    // Normal consecutive runs share a binding generation and retain FIFO order.
    this.outbox.enqueue(async signal => {
      if (!this.isRunCurrent(run) || signal.aborted) return;
      if (canCreate && this.bindingState === "unbound") {
        if (!ctx.sessionManager.getSessionFile()) await new Promise<void>(resolve => {
          const done = () => { signal.removeEventListener("abort", done); resolve(); };
          signal.addEventListener("abort", done, { once: true });
          void settled.then(done);
        });
        if (!this.isRunCurrent(run) || signal.aborted) return;
        if (ctx.sessionManager.getSessionFile()) run.target = await this.createTopic(ctx, run.generation, signal);
      }
      if (!this.isRunCurrent(run) || signal.aborted) return;
      if (!run.target && this.bindingState === "bound" && this.currentThreadId !== null) {
        run.target = { sessionId: run.sessionId, threadId: this.currentThreadId, generation: run.generation };
        if (!await this.registerRoute(ctx, signal)) throw new Error("Failed to register the Telegram topic; synchronization has stopped.");
      }
    });
  }

  private isRunCurrent(run: MirrorRun): boolean {
    // A setup dialog pauses delivery, but existing runs must keep their captures.
    // Saving a configuration invalidates the run through its generation instead.
    return this.active && this.config !== null && this.bindingState !== "disconnected" && !run.suppressed && run.generation === this.generation &&
      run.config === this.config && run.sessionId === run.ctx.sessionManager.getSessionId();
  }

  public onMessageEnd(message: unknown): void {
    const run = this.currentRun;
    if (!run || !this.isRunCurrent(run) || !message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return;
    // Always replace capture, including empty error/abort messages. Tool commentary
    // and streaming partials are never substituted for a failed terminal answer.
    const text = extractAssistantText(message);
    run.text = text.length <= MAX_MIRRORED_TEXT_LENGTH ? text : "⚠️ Response exceeds background sync size limit. Please view it locally in Pi.";
    run.stopReason = "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
  }

  public async onAgentSettled(ctx: ExtensionContext): Promise<void> {
    this.activeCtx = ctx;
    this.isIdle = true;
    const run = this.currentRun;
    this.currentRun = null;
    if (!run) return;
    run.settle();
    if (!this.isRunCurrent(run)) return;
    const text = run.stopReason === "error" ? "⚠️ Task failed. Please check local Pi errors."
      : run.stopReason === "aborted" ? "⏹ Task aborted."
      : run.stopReason === "toolUse" || run.stopReason === "pending" ? "⚠️ Task did not produce a final response. Please check local Pi status."
      : run.stopReason === "length" ? `⚠️ Response reached length limit.\n${run.text}` : run.text;
    if (text.trim()) this.outbox.enqueue(signal => this.sendRunText(text, run, signal), Buffer.byteLength(text, "utf-8"));
  }

  private async sendRunText(text: string, run: MirrorRun, signal: AbortSignal): Promise<void> {
    if (!this.isRunCurrent(run) || signal.aborted || !run.target) return;
    await this.sendText(text, run.target, run.ctx, signal);
  }

  private async waitForConfiguration(signal?: AbortSignal): Promise<void> {
    while (this.configurationTask) {
      signal?.throwIfAborted();
      const task = this.configurationTask;
      await new Promise<void>((resolve, reject) => {
        // Reset/shutdown must cancel this wait even if the dialog is still open.
        const aborted = () => reject(signal?.reason);
        signal?.addEventListener("abort", aborted, { once: true });
        void task.then(() => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        });
      });
    }
    signal?.throwIfAborted();
  }

  /** One uncertain create is never retried automatically, even if append fails. */
  private async createTopic(ctx: ExtensionContext, generation: number, signal?: AbortSignal): Promise<OutputTarget | null> {
    if (this.configurationTask) await this.waitForConfiguration(signal);
    if (!this.active || generation !== this.generation || !this.config || this.createInFlight || this.configuring) return null;
    const config = this.config;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionName = ctx.sessionManager.getSessionName?.() || path.basename(ctx.cwd);
    const name = `Pi: ${sessionName} [${sessionId.slice(-6)}]`.slice(0, 128);
    this.createInFlight = true;
    this.unknownCreates.add(`${sessionId}:${config.chatId}`);
    this.bindingState = "create-unknown";
    try {
      const topic = await this.callTelegram<TelegramForumTopic>("createForumTopic", { chat_id: config.chatId, name }, undefined, signal);
      if (signal?.aborted || !this.active || generation !== this.generation || this.config !== config || sessionId !== ctx.sessionManager.getSessionId()) return null;
      if (!Number.isSafeInteger(topic?.message_thread_id) || topic.message_thread_id <= 0) throw new Error("Topic creation result unknown; no valid message_thread_id returned");
      if (!appendBindingEntry(this.pi, ctx, config.chatId, topic.message_thread_id)) throw new Error("Topic may have been created, but writing session binding failed");
      this.unknownCreates.delete(`${sessionId}:${config.chatId}`);
      this.bindingState = "bound";
      this.currentThreadId = topic.message_thread_id;
      this.lastValidThreadId = topic.message_thread_id;
      if (!await this.registerRoute(ctx, signal)) throw new Error("Failed to register the Telegram topic; synchronization has stopped.");
      return { sessionId, threadId: topic.message_thread_id, generation };
    } finally {
      this.createInFlight = false;
      if (this.active) this.updateStatusBar();
    }
  }

  private async sendText(text: string, target: OutputTarget, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const config = this.config;
    if (!config) return;
    for (const chunk of splitTelegramMessage(text)) {
      if (!chunk.trim()) continue;
      if (this.configurationTask) await this.waitForConfiguration(signal);
      if (!this.isTargetCurrent(target, ctx) || signal.aborted) return;
      // Delivery failures propagate to the bounded outbox's visible failure boundary.
      await this.callTelegram("sendMessage", { chat_id: config.chatId, message_thread_id: target.threadId, text: chunk }, target, signal);
    }
  }

  private invalidateRun(): void {
    this.generation++;
    this.currentRun?.settle();
    this.currentRun = null;
    this.outbox.reset();
    this.finishInput({ accepted: false, busy: false, statusReply: "Session changed; execution result unknown. Please check local status." }, false);
  }

  public onSessionBeforeSwitch(ctx: ExtensionContext): void {
    this.invalidateRun();
    // before_* can be cancelled by another extension; release ownership at shutdown.
    // Only enabled integration needs registration; configured transport failures remain errors.
    if (this.active && this.config) this.outbox.enqueue(async signal => {
      if (!signal.aborted && !await this.registerRoute(ctx, signal)) throw new Error("Failed to update Telegram navigation route.");
    });
    this.clearStatusBar(ctx);
  }

  public onSessionBeforeFork(ctx: ExtensionContext): void { this.onSessionBeforeSwitch(ctx); }
  public onSessionBeforeTree(): void {
    this.invalidateRun();
    const ctx = this.activeCtx;
    if (ctx && this.active && this.config) this.outbox.enqueue(async signal => {
      if (!signal.aborted && !await this.registerRoute(ctx, signal)) throw new Error("Failed to update Telegram navigation route.");
    });
  }

  public async onSessionShutdown(eventOrCtx: { reason?: string } | ExtensionContext, maybeCtx?: ExtensionContext): Promise<void> {
    const ctx = maybeCtx ?? eventOrCtx as ExtensionContext;
    const event = maybeCtx ? eventOrCtx as { reason?: string } : undefined;
    const status = this.coordinator?.getStatus() ?? this.followerClient?.getStatus();
    const hasError = Boolean(this.outbox.error || status?.error || status?.feedbackError || this.connectionError);
    const target = this.registeredTarget;
    const config = this.config;
    const coordinator = this.coordinator;
    const follower = this.followerClient;
    const shouldClose = event?.reason !== "reload" && this.active && !this.configuring && !this.getIsReconnecting() && !hasError &&
      config && target && this.bindingState === "bound" && target.threadId === this.currentThreadId &&
      target.sessionId === ctx.sessionManager.getSessionId() && this.hasActiveTransport();
    // Fence inputs and cancel queued output synchronously, retaining the last acknowledged route only for closure.
    this.active = false;
    this.invalidateRun();
    if (shouldClose) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const params = { chat_id: config.chatId, message_thread_id: target.threadId };
          if (coordinator) await coordinator.callTelegram("closeForumTopic", params, this.runtimeId, target, undefined, controller.signal);
          else if (follower) await follower.callTelegram("closeForumTopic", params, target, undefined, controller.signal);
        } finally { clearTimeout(timer); }
      } catch {
        // Topic closure is best-effort on shutdown; do not block shutdown if Telegram is unreachable
      }
    }
    this.unregisterRoute(ctx);
    try { await this.stopTransport(); }
    finally { this.clearStatusBar(ctx); this.activeCtx = null; }
  }

  public handleTgStatus(ctx: ExtensionContext): void {
    this.activeCtx = ctx;
    const status = this.coordinator?.getStatus() ?? this.followerClient?.getStatus();
    const failure = this.connectionError?.message ?? status?.error?.message ?? status?.feedbackError?.message ?? this.outbox.error?.message;
    ctx.ui?.notify(`[Telegram Mux Status]\nConfig: ${this.config ? "configured" : "missing"}\nRole: ${this.isLeader ? "Leader" : this.followerClient ? "Follower" : "None"}\nSession ID: ${ctx.sessionManager.getSessionId()?.slice(-6)}\nBinding: ${this.bindingState}\nThread ID: ${this.currentThreadId ?? "none"}\nRuntime: ${this.getIsIdle() && ctx.isIdle() ? "idle" : "busy"}\nPolling: ${status?.polling ?? "offline"}\nPending sync: ${this.outbox.size}\nError: ${failure ?? "none"}`, "info");
    this.updateStatusBar(ctx);
  }

  public async handleTgConnect(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !this.active) return;
    this.activeCtx = ctx;
    if (!this.config) { ctx.ui?.notify("Please run /tg-setup first.", "warning"); return; }
    if (this.configuring || this.recovering || this.createInFlight) { ctx.ui?.notify("Telegram configuration, connection, or topic creation is in progress. Please try again later.", "warning"); return; }
    try {
      const status = this.coordinator?.getStatus() ?? this.followerClient?.getStatus();
      // Keep new runs out of the old transport for the entire recovery command,
      // including the interval after stopTransport clears its reconnect timer state.
      this.recovering = Boolean(this.outbox.error || status?.error || status?.feedbackError || !this.hasActiveTransport());
      if (this.recovering) this.updateStatusBar(ctx);
      if (this.outbox.error || status?.error || status?.feedbackError) {
        // Reset the failed dependency chain, including unfinished Pi runs, before
        // accepting new work or allowing reload to abort outstanding requests.
        this.invalidateRun();
      }
      if (status?.error || status?.feedbackError) {
        if (this.coordinator) await this.coordinator.reloadConfig();
        else if (this.followerClient?.isConnected()) {
          await this.followerClient.reloadConfig();
          // Cancel route updates queued by navigation during the reload before
          // closing the requester socket can reject them as unexplained failures.
          this.invalidateRun();
          await this.stopTransport();
        }
      }
      await this.setupTransport(ctx);
      if (this.bindingState === "bound") {
        if (await this.registerRoute(ctx) && this.active && (!this.topicNeedsReopen || (!this.connectionError && await this.reopenTopic(ctx)))) {
          this.updateStatusBar(ctx);
          ctx.ui?.notify(`Connected to topic ${this.currentThreadId}; will not duplicate.`, "info");
        }
        return;
      }
      if (this.bindingState === "disconnected" && this.lastValidThreadId !== null) {
        if (!appendBindingEntry(this.pi, ctx, this.config.chatId, this.lastValidThreadId)) throw new Error("Failed to write session binding");
        this.invalidateRun();
        this.bindingState = "bound";
        this.currentThreadId = this.lastValidThreadId;
        if (await this.registerRoute(ctx) && this.topicNeedsReopen) await this.reopenTopic(ctx);
        this.updateStatusBar(ctx);
        return;
      }
      const generation = this.generation;
      const sessionId = ctx.sessionManager.getSessionId();
      if (!await ctx.ui.confirm("Connect Telegram", "Create a new topic for current session? If the previous result was unknown, an unbound topic may already exist.")) return;
      if (!this.active || generation !== this.generation || sessionId !== ctx.sessionManager.getSessionId() || this.createInFlight) return;
      this.invalidateRun();
      const target = await this.createTopic(ctx, this.generation);
      if (target) ctx.ui.notify(`Connected to new topic ${target.threadId}.`, "info");
    } catch (err) {
      // Command boundary: creation/registration may fail with an unknown remote
      // outcome. Report the failure without claiming success or retrying the request.
      if (this.active) ctx.ui?.notify(`Telegram connection failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    } finally {
      if (this.recovering) {
        this.recovering = false;
        if (this.active) this.updateStatusBar(ctx);
      }
    }
  }

  public handleTgDisconnect(ctx: ExtensionContext): void {
    if (!this.active || ctx.mode !== "tui" || !this.config || this.configuring || this.recovering) return;
    if (!appendBindingEntry(this.pi, ctx, this.config.chatId, null)) { ctx.ui?.notify("Failed to write disconnect record.", "error"); return; }
    this.invalidateRun();
    this.unregisterRoute(ctx);
    this.bindingState = "disconnected";
    this.currentThreadId = null;
    this.updateStatusBar(ctx);
    ctx.ui?.notify("Disconnected from Telegram topic.", "info");
  }

  public async handleTgSetup(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !this.active || this.configuring || this.recovering || this.configurationTask) return;
    this.activeCtx = ctx;
    this.configuring = true;
    let finishConfiguration!: () => void;
    this.configurationTask = new Promise<void>(resolve => { finishConfiguration = resolve; });
    let saved = false;
    try {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const botToken = parts.length >= 3 ? parts[0] : await ctx.ui.input("Bot Token:");
      if (!botToken) return;
      const chatInput = parts.length >= 3 ? parts[1] : await ctx.ui.input("Forum Supergroup Chat ID:");
      if (!chatInput) return;
      const userInput = parts.length >= 3 ? parts[2] : await ctx.ui.input("Allowed User ID:");
      if (!userInput) return;
      const config = validateConfig({ version: 1, botToken, chatId: Number(chatInput), allowedUserId: Number(userInput) });
      const client = new TelegramClient({ botToken: config.botToken });
      await validateBotAndChat(client, config.chatId, config.allowedUserId);
      if (!this.active) return;
      await saveConfig(this.agentDir, config);
      saved = true;
      this.invalidateRun();
      if (this.coordinator) {
        await this.coordinator.reloadConfig();
      } else if (this.followerClient?.isConnected()) {
        // The Leader applies the new config before acknowledging, then reconnects peers.
        await this.followerClient.reloadConfig();
        await this.stopTransport();
        this.applyConfig(config, ctx);
      } else {
        await this.stopTransport();
        this.applyConfig(config, ctx);
      }
      this.configuring = false;
      await this.setupTransport(ctx);
      this.updateStatusBar(ctx);
      ctx.ui.notify("Telegram configuration verified, saved, and applied.", "info");
    } catch (err) {
      if (saved) {
        await this.stopTransport();
        ctx.ui?.notify("Configuration saved, but could not confirm updates on all processes. Please restart all Pi instances.", "error");
      } else ctx.ui?.notify(`Telegram configuration validation failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    } finally {
      this.configuring = false;
      this.configurationTask = null;
      finishConfiguration();
      if (this.active) {
        // A Leader can disappear while the setup dialog is open. Cancellation or
        // validation failure must resume the recovery suppressed during setup.
        if (!saved && this.config && !this.hasActiveTransport()) this.scheduleReconnect(ctx);
        this.updateStatusBar(ctx);
      }
    }
  }
}

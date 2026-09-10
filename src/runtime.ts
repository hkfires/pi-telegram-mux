import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { appendBindingEntry, resolveBindingState } from "./binding.js";
import { getMediaDir, configFingerprint, loadConfig, saveConfig, validateConfig } from "./config.js";
import { LeaderCoordinator } from "./coordinator.js";
import { IpcError, IpcFollowerClient } from "./ipc.js";
import { BoundedOutbox } from "./outbox.js";
import { extractAssistantText, extractUserText, splitTelegramMessage } from "./render.js";
import { IMAGE_MIME_TYPES, INPUT_ADMISSION_TIMEOUT_MS, MAX_INPUT_WORK, MEDIA_QUEUE_BUDGET_BYTES, MEDIA_READ_TIMEOUT_MS } from "./media.js";
import { MarkdownWorker } from "./markdown-worker.js";
import { TelegramClient, validateBotAndChat } from "./telegram.js";
import type { BindingState, BusyInputMode, InboundMedia, InboundResult, MuxConfig, OutputTarget, RuntimeRegistration, TelegramForumTopic, TelegramMessage } from "./types.js";

// Pi cannot cancel setModel(). Keep its safety barrier across extension reloads, but never
// await it during shutdown: quitting the Pi process is the safe recovery for a hung provider.
const modelChangesKey = Symbol.for("pi-telegram-mux.pending-model-changes.v1");
const inputModeChangesKey = Symbol.for("pi-telegram-mux.pending-input-mode-changes.v1");
const mediaWorkKey = Symbol.for("pi-telegram-mux.media-work.v1");
const admissionsKey = Symbol.for("pi-telegram-mux.mobile-admissions.v1");
const inputOriginKey = Symbol.for("pi-telegram-mux.input-origin.v1");
const processState = globalThis as typeof globalThis & {
  [mediaWorkKey]?: Set<symbol>;
  [admissionsKey]?: Set<Admission>;
  [inputOriginKey]?: AsyncLocalStorage<Admission>;
  [modelChangesKey]?: Map<string, Promise<boolean>>;
  [inputModeChangesKey]?: Map<string, Set<Promise<InboundResult>>>;
};
// Unknown work survives extension reload: cancellation cannot manufacture free
// capacity while the OS or Pi still retains it.
const mediaWork = processState[mediaWorkKey] ??= new Set<symbol>();
const mobileAdmissions = processState[admissionsKey] ??= new Set<Admission>();
// Pi may resume an old input hook through newly loaded lifecycle handlers.
// Share provenance (not cancellation controllers); never disable it on shutdown.
const inputOrigin = processState[inputOriginKey] ??= new AsyncLocalStorage<Admission>();
const pendingModelChanges = processState[modelChangesKey] ??= new Map<string, Promise<boolean>>();
const pendingInputModeChanges = processState[inputModeChangesKey] ??= new Map<string, Set<Promise<InboundResult>>>();
const SETTINGS_PENDING_NOTICE = "A Telegram model change is still pending. Wait for it to finish, or quit and restart Pi if it is stuck. /reload cannot cancel it.";
const INPUT_MODE_PENDING_NOTICE = "The input mode configuration is still being saved. Wait for the save to finish, then use /inputmode to check the current setting.";

const MAX_MIRRORED_TEXT_LENGTH = 65_536;
const MAX_QUEUED_INPUTS = 64;
const TELEGRAM_INPUT_TYPE = "Telegram";
const TOPIC_MISSING_NOTICE = "Telegram topic is no longer available. A new topic will be created when you send your next prompt in Pi.";

export const TG_STATUS_KEY = "tg";
export type TgStatusColor = "muted" | "dim";
export interface TgStatusInfo { text: string; color: TgStatusColor; }

export function formatTransportNotice(failure: { code: string; message: string }): string {
  let text = failure.message.trim();
  text = text.replace(/This operation was aborted/gi, "request timed out");
  text = text.replace(/^Telegram request failed \(([^)]+)\): request timed out/i, "Telegram request timed out ($1)");
  text = text.replace(/^Telegram request failed \(([^)]+)\): connection reset/i, "Telegram connection reset ($1)");
  text = text.replace(/^Telegram request failed \(([^)]+)\): connection refused/i, "Telegram connection refused ($1)");
  text = text.replace(/^Telegram request failed \(([^)]+)\): connection timed out/i, "Telegram connection timed out ($1)");
  text = text.replace(/^Telegram request failed \(([^)]+)\): network unreachable/i, "Telegram network unreachable ($1)");
  text = text.replace(/^Telegram request failed \(([^)]+)\): request aborted/i, "Telegram request aborted ($1)");

  if (!text.toLowerCase().startsWith("telegram")) {
    text = text.startsWith(":") ? `Telegram${text}` : `Telegram: ${text}`;
  }

  if (failure.code && !text.includes(`[${failure.code}]`) && !text.endsWith(` ${failure.code}`)) {
    text = `${text} [${failure.code}]`;
  }
  return text;
}

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
    case "topic-missing": return { text: "tg: topic deleted", color: "dim" };
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
  started?: boolean;
  rejected?: boolean;
  discardUserMessage?: boolean;
  signal: AbortSignal;
  messageId?: number;
  resolve?: (result: InboundResult) => void;
  timer: NodeJS.Timeout;
  detach?: () => void;
}

interface MirrorRun {
  sessionId: string;
  generation: number;
  config: MuxConfig | null;
  ctx: ExtensionContext;
  target: OutputTarget | null;
  origin?: Admission;
  promptMessageIds: number[];
  suppressed: boolean;
  firstUserMessage: boolean;
  text: string;
  stopReason?: string;
  replyQueued?: boolean;
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
  private rateLimitReopenTarget: { sessionId: string; threadId: number; botToken: string; chatId: number } | null = null;
  private rateLimitReopenTask: Promise<boolean> | null = null;
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
  private lastConnectionError = "";
  private rateLimitUntil = 0;
  private rateLimitTimer?: NodeJS.Timeout;
  private lastTransportError = "";
  private lastCommandMenuError = "";
  private lastInteractionError = "";
  private settingsFailure?: string;
  private connectionError: Error | null = null;
  private configuring = false;
  private configurationTask: Promise<void> | null = null;
  private createInFlight = false;
  private readonly unknownCreates = new Set<string>();
  private currentRun: MirrorRun | null = null;
  private cleanupTask: Promise<void> | null = null;
  private pendingInput?: Admission;
  private mediaReading?: AbortSignal;
  private inputCancellation = new AbortController();
  private readonly queuedInputs = new Map<string, { run: MirrorRun; messageId?: number; mediaBytes?: number }>();
  private settingsCommandInFlight = false;
  private inputModeCommandInFlight = false;
  private inputModeRevision = 0;
  private readonly inputOrigin = inputOrigin;
  public readonly outbox: BoundedOutbox;
  private readonly markdownWorker = new MarkdownWorker();

  constructor(private readonly pi: ExtensionAPI, private readonly agentDir: string) {
    this.outbox = new BoundedOutbox(error => {
      const failure = error as Error & { code?: string; retryAfter?: number };
      // An RPC rejection may arrive without a cooldown broadcast (for example
      // while joining during reload). Keep recovery bounded by its retry_after.
      if (failure.code === "TELEGRAM_HTTP_429" && Number.isSafeInteger(failure.retryAfter) && failure.retryAfter! > 0) {
        if (this.rateLimitUntil <= Date.now()) this.rateLimitUntil = Date.now() + failure.retryAfter! * 1000;
        if (this.currentRun) this.currentRun.suppressed = true;
      }
      this.activeCtx?.ui?.notify(`Telegram sync paused: ${error.message}`, "error");
      this.updateStatusBar();
    });
  }

  public getBindingState(): BindingState { return this.bindingState; }
  public getCurrentThreadId(): number | null { return this.currentThreadId; }
  public getInputModeRevision(): number { return Math.max(this.inputModeRevision, this.coordinator?.getInputModeRevision() ?? 0); }
  public getIsIdle(): boolean { return this.isIdle && !this.pendingInput && !this.settingsCommandInFlight && !this.inputModeCommandInFlight && !this.hasPendingModelChange(); }

  private hasPendingModelChange(ctx: ExtensionContext | null = this.activeCtx): boolean {
    return Boolean(ctx && pendingModelChanges.has(JSON.stringify([this.agentDir, ctx.sessionManager.getSessionId()])));
  }
  public getIsLeader(): boolean { return this.isLeader; }
  public getIsReconnecting(): boolean {
    return this.isReconnecting || this.recovering || this.rateLimitReopenTask !== null ||
      (this.rateLimitReopenTarget !== null && this.rateLimitUntil <= Date.now() && this.hasActiveTransport());
  }
  public getGeneration(): number { return this.generation; }
  public hasActiveTransport(): boolean { return Boolean(this.coordinator?.isRunning() || this.followerClient?.isConnected()); }

  public updateStatusBar(explicitCtx?: ExtensionContext): void {
    const ctx = explicitCtx ?? this.activeCtx;
    const pendingReopen = this.rateLimitReopenTarget;
    if (pendingReopen && (this.bindingState !== "bound" || pendingReopen.sessionId !== ctx?.sessionManager.getSessionId() ||
        pendingReopen.threadId !== this.currentThreadId || pendingReopen.botToken !== this.config?.botToken || pendingReopen.chatId !== this.config?.chatId)) {
      this.rateLimitReopenTarget = null;
    }
    const until = (this.coordinator?.getStatus() ?? this.followerClient?.getStatus())?.rateLimitUntil ?? 0;
    if (until > Date.now() && until !== this.rateLimitUntil) {
      this.rateLimitUntil = until;
      if (this.currentRun) this.currentRun.suppressed = true;
      // Failed and pending output is dropped, not replayed after the cooldown.
      if (!this.outbox.error || (this.outbox.error as { code?: string }).code === "TELEGRAM_HTTP_429") this.outbox.reset();
    }
    clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = undefined;
    const remaining = Math.max(0, this.rateLimitUntil - Date.now());
    if (this.active && remaining > 0) {
      this.rateLimitTimer = setTimeout(() => this.updateStatusBar(), Math.min(1000, remaining));
      this.rateLimitTimer.unref();
    } else if (this.rateLimitUntil) {
      this.rateLimitUntil = 0;
      if ((this.outbox.error as { code?: string } | null)?.code === "TELEGRAM_HTTP_429") this.outbox.reset();
    }
    if (this.active && ctx && remaining === 0 && !this.configuring && !this.recovering && !this.setupTask && !this.rateLimitReopenTask &&
        this.bindingState === "bound" && this.topicNeedsReopen && this.registeredTarget && this.isTargetCurrent(this.registeredTarget, ctx) &&
        this.hasActiveTransport() && !this.coordinator?.isReloading() && this.rateLimitReopenTarget) {
      const version = this.transportVersion;
      const generation = this.generation;
      const reopening = this.reopenTopic(ctx).catch(error => {
        if (this.active && version === this.transportVersion && generation === this.generation) {
          this.rateLimitReopenTarget = null;
          this.connectionFailed(error, ctx);
        }
        return false;
      }).finally(() => {
        if (this.rateLimitReopenTask !== reopening) return;
        this.rateLimitReopenTask = null;
        if (this.active) this.updateStatusBar();
      });
      this.rateLimitReopenTask = reopening;
    }
    if (typeof ctx?.ui?.setStatus !== "function") return;
    if (remaining > 0) {
      ctx.ui.setStatus(TG_STATUS_KEY, formatStatus(`tg: 429 · ${Math.ceil(remaining / 1000)}s`, "muted", ctx.ui.theme));
      return;
    }
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const status = this.coordinator?.getStatus() ?? this.followerClient?.getStatus();
    const menuNotice = status?.commandMenuError ? formatTransportNotice(status.commandMenuError) : "";
    if (menuNotice && menuNotice !== this.lastCommandMenuError) ctx.ui.notify(`Command menu unavailable; will retry automatically. ${menuNotice}`, "warning");
    this.lastCommandMenuError = menuNotice;
    const interactionNotice = status?.interactionError ? formatTransportNotice(status.interactionError) : "";
    if (interactionNotice && interactionNotice !== this.lastInteractionError) ctx.ui.notify(interactionNotice, "warning");
    this.lastInteractionError = interactionNotice;
    const failure = status?.error ?? status?.feedbackError;
    const notice = failure ? formatTransportNotice(failure) : "";
    if (notice && notice !== this.lastTransportError) ctx.ui.notify(notice, status?.polling === "retrying" ? "warning" : "error");
    this.lastTransportError = notice;
    // Reuse the reconnecting label for polling retries, not the runtime admission
    // gate. Real delivery/connection failures still take priority over polling retries.
    const pollingRetry = status?.polling === "retrying";
    const hasError = Boolean(this.outbox.error || this.connectionError || status?.feedbackError || (!pollingRetry && status?.error));
    const { text, color } = getTgStatusText({
      config: this.config, isReconnecting: this.getIsReconnecting() || (pollingRetry && !hasError),
      isConflict: status?.polling === "conflict", hasError,
      hasActiveTransport: this.hasActiveTransport(),
      bindingState: this.bindingState, threadId: this.currentThreadId, shortId: sessionId?.slice(-6),
    });
    ctx.ui.setStatus(TG_STATUS_KEY, formatStatus(text, color, ctx.ui.theme));
  }

  public clearStatusBar(explicitCtx?: ExtensionContext): void {
    clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = undefined;
    const ctx = explicitCtx ?? this.activeCtx;
    ctx?.ui?.setStatus?.(TG_STATUS_KEY, undefined);
  }

  private applyConfig(config: MuxConfig, ctx: ExtensionContext): void {
    if (this.config?.botToken !== config.botToken) {
      this.rateLimitUntil = 0;
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = undefined;
    }
    this.invalidateRun();
    this.config = config;
    this.inputModeRevision = config.inputModeRevision ?? 0;
    this.connectionError = null;
    const resolved = resolveBindingState(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId(), config.chatId);
    const uncertain = this.unknownCreates.has(`${ctx.sessionManager.getSessionId()}:${config.chatId}`);
    this.bindingState = (resolved.state === "unbound" || resolved.state === "topic-missing") && uncertain ? "create-unknown" : resolved.state;
    this.currentThreadId = resolved.threadId;
    this.lastValidThreadId = resolved.lastValidThreadId;
    // A manual disconnect can still restore the previous topic and its pending reopen.
    if (this.lastValidThreadId === null) this.topicNeedsReopen = false;
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
      this.lastConnectionError = "";
      this.updateStatusBar(ctx);
      return Promise.resolve();
    }
    const version = this.transportVersion;
    this.setupTask = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const config = await loadConfig(this.agentDir);
        if (!this.active || version !== this.transportVersion || !config) return;
        if (!this.config || configFingerprint(config, "connection") !== configFingerprint(this.config, "connection")) {
          this.applyConfig(config, ctx);
        } else if ((config.inputModeRevision ?? 0) >= this.getInputModeRevision()) {
          // A preference change during disconnection must not invalidate a run.
          this.config.inputMode = config.inputMode;
          this.config.inputModeRevision = config.inputModeRevision;
          this.inputModeRevision = config.inputModeRevision ?? 0;
        }
        const candidate = new LeaderCoordinator(this.config ?? config, this.agentDir, undefined, {
          onConfigChange: async next => {
            if (this.active && version === this.transportVersion) {
              this.applyConfig(next, ctx);
              await this.registerRoute(ctx);
            }
          },
          onStatusChange: () => { if (this.active && version === this.transportVersion) this.transportStatusChanged(); },
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
            let modeConflict: { mode: BusyInputMode; revision: number } | undefined;
            this.followerClient = client;
            client.setStatusHandler(() => { if (this.active && version === this.transportVersion) this.transportStatusChanged(ctx); });
            client.setInputModeHandler((mode, revision) => {
              if ((mode !== "followUp" && mode !== "steer") || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return;
              if (revision === this.getInputModeRevision() && mode !== (this.config?.inputMode ?? "followUp")) {
                modeConflict = { mode, revision };
              }
              if (revision <= this.getInputModeRevision()) return;
              modeConflict = undefined;
              this.inputModeRevision = revision;
              if (this.config) {
                this.config.inputMode = mode;
                this.config.inputModeRevision = revision;
              }
              if (this.currentRun?.config) {
                this.currentRun.config.inputMode = mode;
                this.currentRun.config.inputModeRevision = revision;
              }
              if (this.pendingInput?.config) {
                this.pendingInput.config.inputMode = mode;
                this.pendingInput.config.inputModeRevision = revision;
              }
            });
            client.setInboundHandler((msg, signal) => {
              if (!this.isTargetCurrent(msg.target, ctx) || msg.fromId !== this.config?.allowedUserId) return Promise.resolve({ accepted: false, busy: true });
              return this.handleInboundText(msg.text, ctx, msg.messageId, msg.mode, msg.media, signal);
            });
            client.setAbortHandler(target => {
              if (!this.isTargetCurrent(target, ctx)) return false;
              this.cancelInput();
              if (!ctx.abort) return false;
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
            // Modes synchronize independently of the connection. Older peers
            // without a connection fingerprint retain full reconciliation.
            const connectionFingerprint = client.getConfigFingerprint("connection");
            const syncMode = Boolean(connectionFingerprint) && (this.getInputModeRevision() > 0 || modeConflict !== undefined);
            if ((syncMode ? connectionFingerprint : client.getConfigFingerprint()) !== configFingerprint(config, syncMode ? "connection" : "all")) {
              // A disconnected setup or manual config edit must also update the existing
              // Leader before this Runtime can claim a route or submit a business request.
              await client.register({ runtimeId: this.runtimeId, sessionId: ctx.sessionManager.getSessionId(), threadId: null, generation: this.generation });
              await client.reloadConfig();
              client.close();
              if (this.followerClient === client) this.followerClient = null;
              continue;
            }
            if (syncMode && this.config) {
              if (modeConflict) {
                // A manual edit can change the mode without changing its revision.
                // Allocate a revision for the latest disk value, never the cached one.
                const reconciled = await saveConfig(this.agentDir, this.config, { expectedBase: this.config, reconcileInputMode: modeConflict });
                if (!this.active || version !== this.transportVersion) return;
                // A retry timer may already have joined this setup task while the
                // save was pending. Reject it so connection supervision retries again.
                if (this.followerClient !== client || !client.isConnected()) throw new IpcError("IPC_CLOSED", "IPC disconnected during input mode reconciliation");
                const revision = reconciled.inputModeRevision ?? 0;
                if (revision >= this.getInputModeRevision()) {
                  this.config.inputMode = reconciled.inputMode;
                  this.config.inputModeRevision = reconciled.inputModeRevision;
                  this.inputModeRevision = revision;
                }
              }
              // Disk may have advanced before its writer notified the Leader.
              // Equal or older revisions are ignored by the receiving coordinator.
              if (this.getInputModeRevision() > 0) client.send({ type: "sync_input_mode", mode: this.config.inputMode ?? "followUp", revision: this.getInputModeRevision() });
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
          this.lastConnectionError = "";
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
    const notice = `Telegram connection failed: ${this.connectionError.message}`;
    if (notice !== this.lastConnectionError) ctx.ui?.notify(notice, "error");
    this.lastConnectionError = notice;
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
    this.rateLimitReopenTask = null;
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
        dispatchInbound: (text, messageId, media, signal) => this.isTargetCurrent(target, ctx) ? this.handleInboundText(text, ctx, messageId, this.coordinator?.getInputMode() ?? this.config?.inputMode ?? "followUp", media, signal) : Promise.resolve({ accepted: false, busy: true }),
        abortRun: () => {
          if (!this.isTargetCurrent(target, ctx)) return false;
          this.cancelInput();
          if (!ctx.abort) return false;
          ctx.abort();
          return true;
        },
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

  public async handleInboundText(text: string, ctx: ExtensionContext, messageId?: number, explicitMode?: BusyInputMode, media?: InboundMedia | InboundMedia[], upstreamSignal?: AbortSignal): Promise<InboundResult> {
    // Residual I/O is counted until physical completion, even after reconnect.
    // Paths are borrowed from the creator. Runtime rejection or completion must
    // never delete files that Pi may retain in history or queued input.
    if (media && mediaWork.size + mobileAdmissions.size >= MAX_INPUT_WORK) return { accepted: false, busy: true };
    const reservation = media ? Symbol() : undefined;
    if (reservation) mediaWork.add(reservation);
    try { return await this.processInboundText(text, ctx, messageId, explicitMode, media, upstreamSignal); }
    finally { if (reservation) mediaWork.delete(reservation); }
  }

  private async processInboundText(text: string, ctx: ExtensionContext, messageId?: number, explicitMode?: BusyInputMode, media?: InboundMedia | InboundMedia[], upstreamSignal?: AbortSignal): Promise<InboundResult> {
    const polling = (this.coordinator?.getStatus() ?? this.followerClient?.getStatus())?.polling;
    if (polling === "error" || polling === "conflict") return { accepted: false, busy: false, statusReply: "Telegram transport has stopped. Reconnect before submitting input." };
    const inputReference = crypto.randomUUID();
    const generation = this.generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const config = this.config;
    const inputSignal = upstreamSignal ? AbortSignal.any([upstreamSignal, this.inputCancellation.signal]) : this.inputCancellation.signal;
    const images = media ? Array.isArray(media) ? media : [media] : [];
    if (media) {
      if (!images.length || images.length > 10 || images.some(image => !image || typeof image.path !== "string" || !IMAGE_MIME_TYPES.has(image.mimeType))) {
        return { accepted: false, busy: false, statusReply: "Invalid image cache reference or unsupported format." };
      }
      try {
        const cache = await fs.stat(await fs.realpath(getMediaDir(this.agentDir)), { bigint: true });
        for (const image of images) {
          const parent = await fs.stat(await fs.realpath(path.dirname(path.resolve(image.path))), { bigint: true });
          if (!parent.isDirectory() || parent.dev !== cache.dev || parent.ino !== cache.ino) {
            return { accepted: false, busy: false, statusReply: "Invalid image cache reference or unsupported format." };
          }
        }
      } catch {
        // Validation can finish after cancellation. Keep a redacted diagnostic
        // even when its safe rejection can no longer be returned to Telegram.
        console.error(`[pi-telegram-mux] MEDIA_VALIDATION_FAILED: reference ${inputReference}`);
        // Input boundary: missing/inaccessible cache directories cannot produce a partial prompt.
        return { accepted: false, busy: false, statusReply: "Failed to validate image cache on local machine." };
      }
    }
    if (inputSignal.aborted) return { accepted: false, busy: false, statusReply: "Input cancelled." };
    if (this.rateLimitUntil > Date.now()) return { accepted: false, busy: true };
    if (!this.active || this.configuring || this.getIsReconnecting() || this.bindingState !== "bound") {
      return Promise.resolve({ accepted: false, busy: true });
    }
    if (this.outbox.error) {
      return Promise.resolve({ accepted: false, busy: false, statusReply: "Telegram sync is paused. Please check errors on your computer and run /tg-connect to retry." });
    }
    const trimmed = text.trim();
    if (!media && (!trimmed || trimmed.length > 4096)) return Promise.resolve({ accepted: false, busy: true });
    if (media && trimmed.length > 4096) return Promise.resolve({ accepted: false, busy: true });
    if (!media) {
      const settingsCommand = /^\/(model|thinking|inputmode)(?:@[a-z\d_]+)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
      if (settingsCommand) {
        const commandName = settingsCommand[1].toLowerCase();
        const commandArgs = settingsCommand[2]?.trim() ?? "";
        if (this.settingsCommandInFlight || this.inputModeCommandInFlight || this.hasPendingModelChange(ctx) ||
          (commandName !== "inputmode" && this.pendingInput)) {
          return Promise.resolve({ accepted: false, busy: true });
        }
        const reference = crypto.randomUUID();
        const task = this.handleSettingsCommand(commandName, commandArgs, ctx, reference);
        if (commandName === "inputmode") {
          const pending = pendingInputModeChanges.get(this.agentDir) ?? new Set<Promise<InboundResult>>();
          pendingInputModeChanges.set(this.agentDir, pending);
          pending.add(task);
          const clear = () => {
            pending.delete(task);
            if (!pending.size && pendingInputModeChanges.get(this.agentDir) === pending) pendingInputModeChanges.delete(this.agentDir);
          };
          void task.then(clear, clear);
        }
        let timer: NodeJS.Timeout;
        const deadline = new Promise<InboundResult>(resolve => {
          const notice = commandName === "inputmode" ? INPUT_MODE_PENDING_NOTICE : SETTINGS_PENDING_NOTICE;
          timer = setTimeout(() => resolve({ accepted: false, busy: false, statusReply: `Settings update result unknown (reference ${reference}). Do not resend automatically. ${notice}` }), 2000);
        });
        // A slow provider or model-select hook must not block the bot-wide poller.
        // Keep the settings reservation until the actual operation settles, even on timeout.
        return Promise.race([task, deadline]).finally(() => clearTimeout(timer));
      }
    }
    if (this.settingsCommandInFlight || this.inputModeCommandInFlight || this.hasPendingModelChange(ctx) || this.pendingInput) {
      return Promise.resolve({ accepted: false, busy: true });
    }
    if (media && ctx.model?.input && Array.isArray(ctx.model.input) && !ctx.model.input.includes("image")) {
      return {
        accepted: false,
        busy: false,
        statusReply: "The current model does not support image input. Please use /model to switch to a vision-capable model.",
      };
    }

    let promptPayload: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    let mediaBytes = 0;
    if (media) {
      if (this.mediaReading && !this.mediaReading.aborted) return { accepted: false, busy: true };
      this.mediaReading = inputSignal;
      try {
        const stats = await Promise.all(images.map(image => fs.lstat(image.path)));
        if (stats.some(stat => !stat.isFile())) throw new Error("Image cache is not a regular file");
        const queuedBytes = [...this.queuedInputs.values()].reduce((sum, input) => sum + (input.mediaBytes ?? 0), 0);
        mediaBytes = stats.reduce((sum, stat) => sum + Math.ceil(stat.size / 3) * 4, 0);
        // Never reject an input solely for its size. Large inputs wait for an empty
        // media queue, and pause further image admission until they are consumed.
        if (queuedBytes > 0 && queuedBytes + mediaBytes > MEDIA_QUEUE_BUDGET_BYTES) {
          return { accepted: false, busy: true };
        }
        // Keep labels in the text block so Pi can display attachments even without inline graphics.
        const labels = images.map((_, index) => `[Image#${index + 1}]`).join(" ");
        promptPayload = [{ type: "text", text: trimmed ? `${labels}\n\n${trimmed}` : labels }];
        const readSignal = AbortSignal.any([inputSignal, AbortSignal.timeout(MEDIA_READ_TIMEOUT_MS)]);
        for (let index = 0; index < images.length; index++) {
          readSignal.throwIfAborted();
          const buffer = await fs.readFile(images[index].path, { signal: readSignal });
          if (buffer.length !== stats[index].size) throw new Error("Image cache changed during reading");
          promptPayload.push({ type: "image", data: buffer.toString("base64"), mimeType: images[index].mimeType });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== "ABORT_ERR" && !(error instanceof DOMException && error.name === "AbortError")) {
          console.error(`[pi-telegram-mux] MEDIA_READ_FAILED: reference ${inputReference}`);
        }
        // Input boundary: failed cache reads cannot submit a partial text-only task.
        return { accepted: false, busy: false, statusReply: "Failed to read image cache on local machine." };
      } finally {
        if (this.mediaReading === inputSignal) this.mediaReading = undefined;
      }
    } else {
      promptPayload = trimmed;
    }

    // /stop can arrive through either the local route or IPC while image I/O is pending.
    if (inputSignal.aborted) return { accepted: false, busy: false, statusReply: "Input cancelled by /stop." };
    // Image I/O must not grant authority to a replacement session or configuration.
    if (media && (generation !== this.generation || sessionId !== ctx.sessionManager.getSessionId() ||
        !this.isConfigCompatible(config) || !this.active || this.configuring || this.getIsReconnecting() ||
        this.bindingState !== "bound" || this.outbox.error || this.rateLimitUntil > Date.now() || this.pendingInput ||
        this.settingsCommandInFlight || this.inputModeCommandInFlight || this.hasPendingModelChange(ctx))) {
      return { accepted: false, busy: true };
    }
    if (media && !ctx.model?.input?.includes("image")) {
      return { accepted: false, busy: false, statusReply: "Select a vision-capable model with /model before sending images." };
    }
    if (this.isIdle && ctx.isIdle()) {
      if (mobileAdmissions.size >= MAX_INPUT_WORK) return { accepted: false, busy: true };
      // Reserve admission synchronously. Pi's void return is not an execution ACK.
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (this.pendingInput !== admission) return;
          // An ACK deadline cannot cancel Pi's asynchronous input hooks. Keep the
          // reservation until a real admission event, even after reporting uncertainty.
          this.finishInput({ accepted: false, busy: false, statusReply: "Task admission result unknown. Mobile input has been paused; please check local session and do not resend automatically. If unconfirmed, restart this Pi instance." }, false);
        }, INPUT_ADMISSION_TIMEOUT_MS);
        const admission: Admission = { sessionId: ctx.sessionManager.getSessionId(), generation: this.generation, config: this.config, consumed: false, signal: inputSignal, messageId, resolve, timer };
        this.pendingInput = admission;
        mobileAdmissions.add(admission);
        const cancelled = () => {
          if (!admission.started && this.currentRun?.origin === admission) {
            this.currentRun.suppressed = true;
            this.currentRun.settle();
            this.currentRun = null;
            this.isIdle = true;
          }
          if (this.pendingInput === admission) this.finishInput({ accepted: false, busy: false, statusReply: "Input cancelled." });
        };
        admission.detach = () => inputSignal.removeEventListener("abort", cancelled);
        inputSignal.addEventListener("abort", cancelled, { once: true });
        if (inputSignal.aborted) { mobileAdmissions.delete(admission); cancelled(); return; }
        // Async context survives Pi's awaited input transformations. Neither origin
        // nor authority is inferred from mutable prompt text or a global pending slot.
        try { this.inputOrigin.run(admission, () => this.pi.sendUserMessage(promptPayload, { expandPromptTemplates: false })); }
        catch (error) {
          mobileAdmissions.delete(admission);
          // The public void API can reject synchronously (e.g. stale session API).
          // Translate that rejection at the inbound boundary, never claim acceptance.
          if (this.pendingInput === admission) this.finishInput({ accepted: false, busy: false, statusReply: "Pi rejected the task. Please check local errors." });
          ctx.ui?.notify(`Telegram input failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      });
    }
    if (this.currentRun !== null && !this.isIdle && !ctx.isIdle()) {
      if (this.queuedInputs.size >= MAX_QUEUED_INPUTS) return { accepted: false, busy: true };
      const mode: BusyInputMode = explicitMode ?? this.config?.inputMode ?? "followUp";
      const deliveryId = crypto.randomUUID();
      this.queuedInputs.set(deliveryId, { run: this.currentRun, messageId, mediaBytes });
      try {
        // In Pi 0.85 an active run queues custom messages synchronously, before
        // any await. Keep the idle check and send together: sendUserMessage's
        // asynchronous input hooks can otherwise race the end of the run.
        // Public custom-message details survive queue delivery without changing
        // model-visible text or guessing provenance from transformed input.
        this.pi.sendMessage({
          customType: TELEGRAM_INPUT_TYPE,
          content: promptPayload,
          display: true,
          details: { runtimeId: this.runtimeId, deliveryId },
        }, { triggerTurn: true, deliverAs: mode });
        const statusReply = mode === "steer"
          ? "↗ Steering: Request received for delivery after the current tool turn finishes."
          : "↪ Follow-up: Request received for delivery after the current task finishes.";
        return { accepted: true, busy: false, statusReply };
      } catch (error) {
        this.queuedInputs.delete(deliveryId);
        return { accepted: false, busy: false, statusReply: "Pi rejected the task. Please check local errors." };
      }
    }
    return Promise.resolve({ accepted: false, busy: true });
  }

  private reportSettingsFailure(code: string, reference: string, cause?: unknown): void {
    // Provider messages, stacks and arbitrary codes may contain credentials. This boundary
    // keeps a correlated failure and allowlisted OS error code without copying provider text.
    const rawCode = cause instanceof Error && "code" in cause ? cause.code : undefined;
    const causeCode = typeof rawCode === "string" &&
      ["ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ABORT_ERR"].includes(rawCode) ? rawCode : undefined;
    const diagnostic = `${code} (reference ${reference})${causeCode ? ` [${causeCode}]` : ""}. Provider details are redacted; verify local model/authentication settings before retrying.`;
    this.settingsFailure = diagnostic;
    if (this.active && this.activeCtx) this.activeCtx.ui.notify(diagnostic, "error");
    else console.error(`[pi-telegram-mux] ${diagnostic}`);
  }

  private async handleSettingsCommand(command: string, args: string, ctx: ExtensionContext, reference: string): Promise<InboundResult> {
    // Settings commands have their own completion path: they do not start an agent turn.
    if (command === "inputmode") this.inputModeCommandInFlight = true;
    else this.settingsCommandInFlight = true;
    const generation = this.generation;
    const sessionId = ctx.sessionManager.getSessionId();
    let reply: string;
    let menu: InboundResult["menu"];
    let accepted = true;
    let failureCode = "PI_SETTINGS_QUERY_FAILED";
    let inputModeResult: BusyInputMode | undefined;
    try {
      if (command === "inputmode") {
        failureCode = "PI_INPUT_MODE_CHANGE_FAILED";
        const currentMode = this.coordinator?.getInputMode() ?? this.config?.inputMode ?? "followUp";
        const normalized = args.toLowerCase().replace(/[-_]/g, "");
        if (!args) {
          reply = `Busy input mode: ${currentMode === "steer" ? "Steering" : "Follow-up"} (global)\nChoose how messages sent while Pi is working should be handled:`;
          menu = [
            [
              { text: `${currentMode === "followUp" ? "✓ " : ""}Follow-up`, command: "/inputmode followup" },
              { text: `${currentMode === "steer" ? "✓ " : ""}Steering`, command: "/inputmode steer" },
            ],
          ];
        } else if (normalized !== "followup" && normalized !== "steer" && normalized !== "steering") {
          accepted = false;
          reply = "Invalid input mode. Use: /inputmode followup or /inputmode steer.";
        } else {
          const targetMode: BusyInputMode = normalized.startsWith("steer") ? "steer" : "followUp";
          const freshConfig = await loadConfig(this.agentDir, { inputMode: targetMode });
          if (!freshConfig) throw new Error("Telegram configuration missing");
          if (!this.isConfigCompatible(freshConfig)) {
            throw new Error("Connection configuration has changed on disk; reconnect before changing input mode");
          }
          const savedConfig = await saveConfig(this.agentDir, freshConfig, { expectedBase: this.config ?? undefined, modeUpdate: true });
          const revision = savedConfig.inputModeRevision ?? 1;
          if (revision <= this.getInputModeRevision()) {
            const actualMode = this.coordinator?.getInputMode() ?? this.config?.inputMode ?? "followUp";
            reply = `Input mode update was superseded by a newer setting. Current mode is ${actualMode === "steer" ? "Steering" : "Follow-up"} (global).`;
            menu = [
              [
                { text: `${actualMode === "followUp" ? "✓ " : ""}Follow-up`, command: "/inputmode followup" },
                { text: `${actualMode === "steer" ? "✓ " : ""}Steering`, command: "/inputmode steer" },
              ],
            ];
            return { accepted: false, busy: false, statusReply: reply, menu, inputMode: actualMode, inputModeRevision: this.getInputModeRevision() };
          }
          this.inputModeRevision = revision;
          if (this.config) {
            this.config.inputMode = targetMode;
            this.config.inputModeRevision = revision;
          }
          if (this.currentRun?.config) {
            this.currentRun.config.inputMode = targetMode;
            this.currentRun.config.inputModeRevision = revision;
          }
          if (this.pendingInput?.config) {
            this.pendingInput.config.inputMode = targetMode;
            this.pendingInput.config.inputModeRevision = revision;
          }
          if (this.coordinator) {
            this.coordinator.updateInputMode(targetMode, undefined, revision);
          }
          if (this.followerClient?.isConnected()) {
            this.followerClient.send({ type: "sync_input_mode", mode: targetMode, revision });
          }
          inputModeResult = targetMode;
          reply = `Busy input mode set to ${targetMode === "steer" ? "Steering" : "Follow-up"} (global).`;
        }
      } else if (command === "thinking") {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
        const level = levels.find(value => value === args.toLowerCase());
        if (!args) {
          reply = `Thinking: ${this.pi.getThinkingLevel()}\nSelect a thinking level below, or use /thinking <level>.\nPi adjusts unsupported levels to the current model's capabilities.`;
        } else if (!level) {
          accepted = false;
          reply = `Invalid thinking level. Use: ${levels.join(", ")}.`;
        } else {
          failureCode = "PI_THINKING_CHANGE_FAILED";
          this.pi.setThinkingLevel(level);
          this.settingsFailure = undefined;
          const actual = this.pi.getThinkingLevel();
          reply = `Thinking: ${actual}${actual !== level ? ` (requested ${level}; adjusted to model capabilities)` : ""}`;
        }
        if (!level) {
          const current = this.pi.getThinkingLevel();
          menu = levels.map(value => [{ text: `${value === current ? "✓ " : ""}${value}`, command: `/thinking ${value}` }]);
        }
      } else {
        const available = ctx.modelRegistry.getAvailable();
        const scoped = ctx.scopedModels ?? [];
        const models = available.filter(model => `${model.provider}/${model.id}`.length <= 4089 &&
          (!scoped.length || scoped.some(entry => entry.model.provider === model.provider && entry.model.id === model.id)));
        const pageMatch = /^page ([1-9]\d*)$/.exec(args);
        if (!args || pageMatch) {
          const page = pageMatch ? Number(pageMatch[1]) : 1;
          const pages = Math.max(1, Math.ceil(models.length / 8));
          if (!Number.isSafeInteger(page) || page > pages) {
            accepted = false;
            reply = `Invalid page. Use /model page 1 through /model page ${pages}.`;
          } else {
            const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
            menu = models.slice((page - 1) * 8, page * 8).map(model => {
              const id = `${model.provider}/${model.id}`;
              return [{ text: `${id === current ? "✓ " : ""}${Array.from(id).slice(0, 60).join("")}${Array.from(id).length > 60 ? "…" : ""}`, command: `/model ${id}` }];
            });
            const navigation: NonNullable<InboundResult["menu"]>[number] = [];
            if (page > 1) navigation.push({ text: "‹ Previous", command: `/model page ${page - 1}` });
            if (page < pages) navigation.push({ text: "Next ›", command: `/model page ${page + 1}` });
            if (navigation.length) menu.push(navigation);
            reply = `Model: ${current}\nThinking: ${this.pi.getThinkingLevel()}\nAvailable models (${page}/${pages})\n${models.length ? "Select a model below to switch." : "No available models. Configure authentication locally in Pi."}`;
          }
        } else {
          const model = models.find(model => `${model.provider}/${model.id}` === args);
          if (!model) {
            accepted = false;
            reply = "Model unavailable or outside this session's model scope. Use /model and copy an exact provider/model_id.";
          } else {
            failureCode = "PI_MODEL_CHANGE_FAILED";
            const key = JSON.stringify([this.agentDir, sessionId]);
            const changing = this.pi.setModel(model);
            pendingModelChanges.set(key, changing);
            const clear = () => { if (pendingModelChanges.get(key) === changing) pendingModelChanges.delete(key); };
            void changing.then(clear, clear);
            if (!(await changing)) {
              accepted = false;
              this.reportSettingsFailure("PI_MODEL_AUTH_UNAVAILABLE", reference);
              reply = `Model switch failed: authentication is not configured (reference ${reference}). Check local Pi settings.`;
            } else {
              this.settingsFailure = undefined;
              reply = `Model: ${model.provider}/${model.id}\nThinking: ${this.pi.getThinkingLevel()}`;
            }
          }
        }
      }
      if (!this.active || generation !== this.generation || sessionId !== ctx.sessionManager.getSessionId()) {
        accepted = false;
        reply = "Session changed during settings update. Result unknown; check local Pi settings.";
        menu = undefined;
      }
    } catch (error) {
      // Settings execution is an explicit boundary. Record failures even if the Telegram
      // deadline already won, and translate them into a credential-safe error response.
      this.reportSettingsFailure(failureCode, reference, error);
      accepted = false;
      reply = `Settings update failed or result unknown [${failureCode}; reference ${reference}]. Check local Pi settings before retrying.`;
      menu = undefined;
    } finally {
      if (command === "inputmode") this.inputModeCommandInFlight = false;
      else this.settingsCommandInFlight = false;
    }
    // Model identifiers are provider-controlled; keep feedback within Telegram's limit.
    if (reply.length > 4000) reply = `${Array.from(reply).slice(0, 1900).join("")}\nList truncated; check the full model identifiers locally.`;
    return { accepted, busy: false, statusReply: reply, ...(menu ? { menu } : {}), ...(inputModeResult ? { inputMode: inputModeResult, inputModeRevision: this.inputModeRevision } : {}) };
  }

  private transportStatusChanged(ctx?: ExtensionContext): void {
    const polling = (this.coordinator?.getStatus() ?? this.followerClient?.getStatus())?.polling;
    // A completed/unknown IPC admission may no longer have an active RPC slot.
    // Terminal status also revokes those mobile origins, without aborting local work.
    if (polling === "error" || polling === "conflict") this.cancelInput();
    this.updateStatusBar(ctx);
  }

  private cancelInput(): void {
    // Pi's void submission API can still be inside async hooks with no active run.
    // Keep the aborted signal on its admission even after releasing the reservation.
    this.inputCancellation.abort();
    this.inputCancellation = new AbortController();
    this.mediaReading = undefined;
    this.finishInput({ accepted: false, busy: false, statusReply: "Input cancelled." });
  }

  public onAgentStart(ctx: ExtensionContext): void {
    // input may have run before another extension's slow hook. Only agent_start
    // guarantees that ctx.abort() has an active Pi abort controller to cancel.
    const origin = this.inputOrigin.getStore();
    if (origin) { origin.started = true; mobileAdmissions.delete(origin); }
    if (origin && (origin.signal.aborted || origin.rejected)) {
      if (this.currentRun?.origin === origin) this.currentRun.suppressed = true;
      ctx.abort();
    }
  }

  private finishInput(result: InboundResult, release = true): void {
    const pending = this.pendingInput;
    if (!pending) return;
    if (release) { this.pendingInput = undefined; pending.detach?.(); }
    clearTimeout(pending.timer);
    pending.resolve?.(result);
    pending.resolve = undefined;
  }

  public onMessageStart(message: unknown, ctx: ExtensionContext): void {
    if (!message || typeof message !== "object" || !("role" in message)) return;
    const origin = this.inputOrigin.getStore();
    if (message.role === "user" && origin && !origin.consumed && (origin.signal.aborted || origin.rejected)) {
      // Pi still emits/persists the user message after agent_start aborts. Remove
      // its payload at message_end, before it becomes durable provider context.
      origin.consumed = true;
      origin.discardUserMessage = true;
      mobileAdmissions.delete(origin);
      if (this.pendingInput === origin) this.finishInput({ accepted: false, busy: false, statusReply: "Input cancelled." });
      return;
    }
    const run = this.currentRun;
    if (!run || (origin && (origin.signal.aborted || origin.rejected) && run.origin !== origin)) return;
    if (message.role === "assistant") { run.text = ""; run.stopReason = undefined; run.replyQueued = false; return; }
    let queued: { run: MirrorRun; messageId?: number } | undefined;
    if (message.role === "custom" && "customType" in message && message.customType === TELEGRAM_INPUT_TYPE) {
      const details = "details" in message ? message.details : undefined;
      if (!details || typeof details !== "object" || !("runtimeId" in details) || details.runtimeId !== this.runtimeId ||
          !("deliveryId" in details) || typeof details.deliveryId !== "string") return;
      queued = this.queuedInputs.get(details.deliveryId);
      this.queuedInputs.delete(details.deliveryId);
      // A queued input can outlive disconnect/setup. Its reply must never gain
      // the authority of a newer run or a newly configured Telegram target.
      if (!queued || queued.run !== run || !this.isRunCurrent(run)) { run.suppressed = true; return; }
    } else if (message.role !== "user") return;
    run.text = "";
    run.stopReason = undefined;
    run.replyQueued = false;
    if (queued) {
      const messageId = queued.messageId;
      if (typeof messageId === "number") {
        run.promptMessageIds.push(messageId);
        this.outbox.enqueue(async signal => {
          if (this.isRunCurrent(run) && run.target && !signal.aborted) await this.setReaction(run.target, messageId, "👀", signal);
        });
      }
      return;
    }
    if (run.firstUserMessage) {
      run.firstUserMessage = false;
      if (run.origin) {
        run.origin.consumed = true;
        mobileAdmissions.delete(run.origin);
        if (this.pendingInput === run.origin) this.finishInput({ accepted: !run.suppressed, busy: false });
        return;
      }
    }
    const text = extractUserText(message);
    if (text.trim() && this.isRunCurrent(run)) {
      // Actual user-message admission also covers steering/follow-up messages,
      // which Pi delivers without another before_agent_start event.
      const prompt = `🧑‍💻 [Prompt]\n${text.length <= MAX_MIRRORED_TEXT_LENGTH ? text : "Prompt is too long. Please view it locally in Pi; task results will still be synced."}`;
      this.outbox.enqueue(async signal => {
        const sent = await this.sendRunText(prompt, run, signal);
        if (sent && typeof sent.message_id === "number" && run.target && !signal.aborted) {
          run.promptMessageIds.push(sent.message_id);
          await this.setReaction(run.target, sent.message_id, "👀", signal);
        }
      }, Buffer.byteLength(prompt, "utf-8"));
    }
  }

  public async onSessionStart(eventOrCtx: { reason?: string } | ExtensionContext, maybeCtx?: ExtensionContext): Promise<void> {
    const ctx = maybeCtx ?? eventOrCtx as ExtensionContext;
    const event = maybeCtx ? eventOrCtx as { reason?: string } : undefined;
    if (ctx.mode !== "tui") return;
    this.active = true;
    this.activeCtx = ctx;
    if (this.hasPendingModelChange(ctx)) ctx.ui.notify(SETTINGS_PENDING_NOTICE, "warning");
    const version = this.transportVersion;
    // Shutdown need not await a settings write, but a replacement runtime must
    // read after it commits. Keep this barrier across extension module reloads.
    while (pendingInputModeChanges.has(this.agentDir)) {
      await Promise.allSettled([...pendingInputModeChanges.get(this.agentDir)!]);
      if (!this.active || version !== this.transportVersion) return;
    }
    const config = await loadConfig(this.agentDir);
    if (!this.active || version !== this.transportVersion) return;
    if (config) {
      this.applyConfig(config, ctx);
      try { await this.setupTransport(ctx); }
      catch (error) { this.connectionFailed(error, ctx); }
    } else this.config = null;
    if (this.active && version === this.transportVersion) {
      this.updateStatusBar(ctx);
      if (this.bindingState === "bound" && (event?.reason === "startup" || event?.reason === "resume" || event?.reason === "reload")) {
        this.topicNeedsReopen = true;
        await this.reopenTopic(ctx);
      } else if (this.bindingState === "topic-missing") {
        ctx.ui?.notify(TOPIC_MISSING_NOTICE, "warning");
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
      if ((error as { code?: string } | null)?.code === "TELEGRAM_RELOADING" && this.rateLimitReopenTarget) {
        // Reload cancels this request, not the pending operation. Its stable
        // ownership is checked again before retrying after the transport is ready.
        return false;
      }
      // Match the specific Telegram response, whose text is also preserved over IPC.
      if (error instanceof Error && /^(?:Bad Request: )?(?:TOPIC_ID_INVALID|message thread not found)$/i.test(error.message)) {
        if (appendBindingEntry(this.pi, ctx, config.chatId, null, "topic-missing")) {
          this.invalidateRun();
          this.unregisterRoute(ctx);
          this.bindingState = "topic-missing";
          this.currentThreadId = null;
          this.lastValidThreadId = null;
          this.topicNeedsReopen = false;
          this.rateLimitReopenTarget = null;
          this.connectionError = null;
          ctx.ui?.notify(TOPIC_MISSING_NOTICE, "warning");
          this.updateStatusBar(ctx);
          return false;
        }
        error = new Error("Telegram topic is no longer available, but saving the binding reset failed", { cause: error });
      }
      // Telegram returns this error when the topic is already open, including through IPC.
      if (!(error instanceof Error && /^(?:Bad Request: )?TOPIC_NOT_MODIFIED$/i.test(error.message))) {
        this.connectionError = error instanceof Error ? error : new Error("Telegram topic reopen failed", { cause: error });
        const failure = this.connectionError as Error & { code?: string; retryAfter?: number };
        if (failure.code === "TELEGRAM_HTTP_429") {
          // Reopening is idempotent. Keep the pending operation until its cooldown
          // expires, including when only an IPC rejection supplied retry_after.
          const retryAfter = Number.isSafeInteger(failure.retryAfter) && failure.retryAfter! > 0 ? failure.retryAfter! : 5;
          // Configuration reloads can clear diagnostics and change route generations
          // without completing this operation. Retain its stable ownership separately.
          this.rateLimitReopenTarget = { sessionId: target.sessionId, threadId: target.threadId, botToken: config.botToken, chatId: config.chatId };
          this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + retryAfter * 1000);
          this.updateStatusBar(ctx);
          return false;
        }
        this.rateLimitReopenTarget = null;
        ctx.ui?.notify(`Telegram topic reopen failed: ${this.connectionError.message}; please check and run /tg-connect to retry.`, "error");
        this.updateStatusBar(ctx);
        return false;
      }
    } finally {
      clearTimeout(timer);
    }
    if (!this.isTargetCurrent(target, ctx) || version !== this.transportVersion) return false;
    this.topicNeedsReopen = false;
    this.rateLimitReopenTarget = null;
    this.connectionError = null;
    this.updateStatusBar(ctx);
    return true;
  }

  public async onBeforeAgentStart(eventOrCtx: { prompt?: string } | ExtensionContext, maybeCtx?: ExtensionContext): Promise<void> {
    const ctx = maybeCtx ?? eventOrCtx as ExtensionContext;
    const origin = this.inputOrigin.getStore();
    if (origin && (origin.signal.aborted || origin.rejected || origin.generation !== this.generation ||
        origin.sessionId !== ctx.sessionManager.getSessionId() || !this.isConfigCompatible(origin.config))) {
      // A delayed pre-start hook can resume while a replacement task is active.
      // It owns neither the active run nor its idle flag, reactions or settlement.
      origin.rejected = true;
      return;
    }
    this.activeCtx = ctx;
    this.isIdle = false;
    const oldRun = this.currentRun;
    if (oldRun && !oldRun.replyQueued && oldRun.promptMessageIds.length > 0 && oldRun.target) {
      const target = oldRun.target;
      const ids = [...oldRun.promptMessageIds];
      this.outbox.enqueue(async signal => {
        if (!signal.aborted) {
          for (const id of ids) {
            await this.setReaction(target, id, "😭", signal);
          }
        }
      });
    }
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const promptMessageIds: number[] = [];
    if (origin && !origin.consumed && typeof origin.messageId === "number") {
      promptMessageIds.push(origin.messageId);
    }
    // Runs admitted during recovery/configuration must never gain a target later.
    const run: MirrorRun = {
      sessionId: ctx.sessionManager.getSessionId(), generation: this.generation, config: this.config, ctx,
      target: null, origin: origin?.consumed ? undefined : origin, promptMessageIds,
      suppressed: this.rateLimitUntil > Date.now() || this.getIsReconnecting() || this.configuring || Boolean(origin && (origin.signal.aborted || origin.generation !== this.generation || !this.isConfigCompatible(origin.config) || origin.sessionId !== ctx.sessionManager.getSessionId())),
      firstUserMessage: true, text: "", settled, settle,
    };
    this.currentRun = run;
    if (!this.isRunCurrent(run)) return;
    // A missing topic is replaced on the next local prompt, even in a session with history.
    const isTopicMissing = !origin && this.bindingState === "topic-missing";
    // Capture eligibility now: queued work may run after the first assistant reply is persisted.
    const canCreate = isTopicMissing || (!origin && this.bindingState === "unbound" && !ctx.sessionManager.getEntries().some(e => e.type === "message" && e.message.role === "assistant"));
    if (isTopicMissing) {
      ctx.ui?.notify("Telegram topic was deleted. Creating a replacement topic for this session...", "warning");
    }
    // Enqueue preparation, never await Telegram/IPC in a Pi lifecycle handler.
    // Normal consecutive runs share a binding generation and retain FIFO order.
    this.outbox.enqueue(async signal => {
      if (!this.isRunCurrent(run) || signal.aborted) return;
      if (canCreate && (this.bindingState === "unbound" || this.bindingState === "topic-missing")) {
        const wasMissing = this.bindingState === "topic-missing";
        if (!ctx.sessionManager.getSessionFile()) await new Promise<void>(resolve => {
          const done = () => { signal.removeEventListener("abort", done); resolve(); };
          signal.addEventListener("abort", done, { once: true });
          void settled.then(done);
        });
        if (!this.isRunCurrent(run) || signal.aborted) return;
        if (ctx.sessionManager.getSessionFile()) {
          run.target = await this.createTopic(ctx, run.generation, signal);
          if (wasMissing && run.target) {
            ctx.ui?.notify(`Connected to new topic ${run.target.threadId}.`, "info");
          }
        }
      }
      if (!this.isRunCurrent(run) || signal.aborted) return;
      if (!run.target && this.bindingState === "bound" && this.currentThreadId !== null) {
        run.target = { sessionId: run.sessionId, threadId: this.currentThreadId, generation: run.generation };
        if (!await this.registerRoute(ctx, signal)) throw new Error("Failed to register the Telegram topic; synchronization has stopped.");
      }
      if (!this.isRunCurrent(run) || signal.aborted || !run.target) return;
      for (const msgId of run.promptMessageIds) {
        await this.setReaction(run.target, msgId, "👀", signal);
      }
    });
  }

  private isConfigCompatible(other: MuxConfig | null): boolean {
    if (!this.config || !other) return false;
    return this.config === other || (
      this.config.chatId === other.chatId &&
      this.config.botToken === other.botToken &&
      this.config.allowedUserId === other.allowedUserId &&
      this.config.autoCloseTopics === other.autoCloseTopics
    );
  }

  private isRunCurrent(run: MirrorRun): boolean {
    // A setup dialog pauses delivery, but existing runs must keep their captures.
    // Saving a configuration invalidates the run through its generation instead.
    return this.active && this.config !== null && this.bindingState !== "disconnected" && !run.suppressed && run.generation === this.generation &&
      this.isConfigCompatible(run.config) && run.sessionId === run.ctx.sessionManager.getSessionId();
  }

  public onMessageEnd(message: unknown): { message: MessageEndEvent["message"] } | undefined {
    const origin = this.inputOrigin.getStore();
    if (origin?.discardUserMessage && message && typeof message === "object" && "role" in message && message.role === "user") {
      origin.discardUserMessage = false;
      // The public replacement hook updates Pi's agent state AND session record.
      // Never copy cancelled text/images or extension-added fields into the tombstone.
      return { message: { role: "user", content: "[Telegram input cancelled before execution.]", timestamp: (message as MessageEndEvent["message"]).timestamp } };
    }
    const run = this.currentRun;
    if (origin && (origin.signal.aborted || origin.rejected) && run?.origin !== origin) return;
    if (!run || !this.isRunCurrent(run) || !message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return;
    // Always replace capture, including empty error/abort messages. Tool commentary
    // and streaming partials are never substituted for a failed terminal answer.
    const text = extractAssistantText(message);
    run.text = text.length <= MAX_MIRRORED_TEXT_LENGTH ? text : "⚠️ Response exceeds background sync size limit. Please view it locally in Pi.";
    run.stopReason = "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
    run.replyQueued = false;
  }

  public onTurnEnd(message: unknown): void {
    const run = this.currentRun;
    const origin = this.inputOrigin.getStore();
    if (origin && (origin.signal.aborted || origin.rejected) && run?.origin !== origin) return;
    if (!run || run.replyQueued || !this.isRunCurrent(run) || !message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return;
    // Pi has applied message_end replacements and persisted the assistant by now.
    // Deliver returned text even at the output limit. Tool commentary stays local,
    // and transient errors still wait for Pi's retry outcome.
    this.onMessageEnd(message);
    if ((run.stopReason !== "stop" && run.stopReason !== "length") || ("content" in message && Array.isArray(message.content) && message.content.some(part => part?.type === "toolCall"))) return;
    const text = run.text;
    if (text.trim()) this.outbox.enqueue(async signal => { await this.sendRunText(text, run, signal); }, Buffer.byteLength(text, "utf-8"));
    run.replyQueued = true;
    // Release first-turn topic preparation without marking the agent idle or
    // dropping the run: queued user messages still belong to this agent run.
    run.settle();
  }

  public async onAgentSettled(ctx: ExtensionContext): Promise<void> {
    const origin = this.inputOrigin.getStore();
    // Pi also emits settlement when a late prompt loses its concurrent-start
    // race. Release only that admission; do not settle the surviving active run.
    if (origin) mobileAdmissions.delete(origin);
    if (origin && (origin.signal.aborted || origin.rejected) && this.currentRun?.origin !== origin) return;
    this.activeCtx = ctx;
    this.isIdle = true;
    const run = this.currentRun;
    this.currentRun = null;
    const undelivered = [...this.queuedInputs.values()].filter(input => input.run === run);
    this.queuedInputs.clear();
    if (!run) return;
    run.settle();
    if (undelivered.length && this.isRunCurrent(run)) {
      this.outbox.enqueue(async signal => {
        if (!this.isRunCurrent(run) || !run.target || signal.aborted) return;
        for (const input of undelivered) {
          if (typeof input.messageId === "number") await this.setReaction(run.target, input.messageId, "😭", signal);
        }
        await this.sendRunText("⚠️ Some queued Telegram messages were not delivered before the task ended. Check local Pi before resending.", run, signal);
      });
    }
    const emoji = run.stopReason === "error" ? "😱"
      : run.stopReason === "aborted" ? "😭"
      : "💯";
    if (!this.isRunCurrent(run) || run.replyQueued) {
      if (this.isRunCurrent(run)) {
        this.outbox.enqueue(async signal => {
          if (run.target && !signal.aborted) {
            for (const msgId of run.promptMessageIds) {
              await this.setReaction(run.target, msgId, emoji, signal);
            }
          }
        });
      }
      return;
    }
    const text = run.stopReason === "error" ? "⚠️ Task failed. Please check local Pi errors."
      : run.stopReason === "aborted" ? "⏹ Task aborted."
      : run.stopReason === "toolUse" || run.stopReason === "pending" ? "⚠️ Task did not produce a final response. Please check local Pi status."
      : run.text;
    if (text.trim()) this.outbox.enqueue(async signal => { await this.sendRunText(text, run, signal); }, Buffer.byteLength(text, "utf-8"));
    this.outbox.enqueue(async signal => {
      if (run.target && !signal.aborted) {
        for (const msgId of run.promptMessageIds) {
          await this.setReaction(run.target, msgId, emoji, signal);
        }
      }
    });
  }

  private async setReaction(target: OutputTarget, messageId: number, emoji: string, signal?: AbortSignal): Promise<void> {
    const config = this.config;
    if (!config || !this.active || this.bindingState === "disconnected") return;
    try {
      await this.callTelegram(
        "setMessageReaction",
        {
          chat_id: config.chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji }],
        },
        target,
        signal
      );
    } catch {
      // Best-effort reaction: ignore permissions, unsupported reactions, or rate limits.
    }
  }

  private async sendRunText(text: string, run: MirrorRun, signal: AbortSignal): Promise<TelegramMessage | null> {
    if (!this.isRunCurrent(run) || signal.aborted || !run.target) return null;
    return this.sendText(text, run.target, run.ctx, signal);
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
    // Persist the attempt before sending it so a restart cannot automatically
    // repeat an uncertain replacement after a timeout or binding write failure.
    if (this.bindingState === "topic-missing" && !appendBindingEntry(this.pi, ctx, config.chatId, null, "create-unknown")) {
      throw new Error("Failed to save the topic replacement attempt; no new topic was requested");
    }
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

  private async sendText(text: string, target: OutputTarget, ctx: ExtensionContext, signal: AbortSignal): Promise<TelegramMessage | null> {
    const config = this.config;
    if (!config) return null;
    let firstMessage: TelegramMessage | null = null;
    const chunks = await this.markdownWorker.render(text, signal);
    for (const chunk of chunks) {
      if (!chunk.text.trim()) continue;
      if (this.configurationTask) await this.waitForConfiguration(signal);
      if (!this.isTargetCurrent(target, ctx) || signal.aborted) return null;
      const params: Record<string, unknown> = {
        chat_id: config.chatId,
        message_thread_id: target.threadId,
        text: chunk.text,
      };
      if (chunk.entities && chunk.entities.length > 0) {
        params.entities = chunk.entities;
      }
      // Delivery failures propagate to the bounded outbox's visible failure boundary.
      const sent = await this.callTelegram<TelegramMessage>("sendMessage", params, target, signal);
      if (!firstMessage && sent && typeof sent === "object" && typeof (sent as TelegramMessage).message_id === "number") {
        firstMessage = sent;
      }
    }
    return firstMessage;
  }

  private invalidateRun(): void {
    this.generation++;
    // Detach stale cache I/O; its finalizer cannot release a newer read reservation.
    this.inputCancellation.abort();
    this.inputCancellation = new AbortController();
    this.mediaReading = undefined;
    this.rateLimitReopenTask = null;
    this.currentRun?.settle();
    this.currentRun = null;
    this.queuedInputs.clear();
    this.outbox.reset();
    this.finishInput({ accepted: false, busy: false, statusReply: "Session changed; execution result unknown. Please check local status." });
  }

  private cleanupRunReactions(): Promise<void> | null {
    const run = this.currentRun;
    const target = run?.target;
    const config = this.config;
    const coordinator = this.coordinator;
    const follower = this.followerClient;
    if (!run || !target || !config || !this.active || this.configuring || !run.promptMessageIds.length) return this.cleanupTask;
    const messageIds = run.promptMessageIds.splice(0);
    const previous = this.cleanupTask;
    const task = (async () => {
      if (previous) await previous;
      // Retain the acknowledged route while ordinary output is synchronously fenced.
      // All reactions share one deadline so cleanup cannot hold navigation or exit open.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        for (const messageId of messageIds) {
          if (controller.signal.aborted) break;
          const params = { chat_id: config.chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: "😭" }] };
          try {
            if (coordinator) await coordinator.callTelegram("setMessageReaction", params, this.runtimeId, target, undefined, controller.signal);
            else if (follower) await follower.callTelegram("setMessageReaction", params, target, undefined, controller.signal);
          } catch {
            // Cleanup is best-effort; a failed reaction must not block route release.
          }
        }
      } finally { clearTimeout(timer); }
    })().finally(() => { if (this.cleanupTask === task) this.cleanupTask = null; });
    this.cleanupTask = task;
    return task;
  }

  public onInput(ctx: ExtensionContext, interactiveText?: string): { action: "handled" } | undefined | Promise<{ action: "handled" } | undefined> {
    const cancelledOrigin = this.inputOrigin.getStore();
    if (cancelledOrigin?.signal.aborted) { mobileAdmissions.delete(cancelledOrigin); return { action: "handled" }; }
    // This only fences settings already in progress. Pi exposes no terminal input-preflight
    // event for downstream handled/failed inputs, so a full bidirectional lock needs SDK support.
    if (!this.settingsCommandInFlight && !this.hasPendingModelChange(ctx)) return undefined;
    const origin = this.inputOrigin.getStore();
    if (interactiveText === undefined && origin && !origin.consumed && this.active &&
      origin.generation === this.generation && origin.sessionId === ctx.sessionManager.getSessionId() &&
      this.isConfigCompatible(origin.config)) {
      // This input passed admission before the model change began. Pi awaits input
      // hooks, so wait for the change instead of consuming and losing the prompt.
      // Recheck after either outcome in case another change has started meanwhile.
      const changing = pendingModelChanges.get(JSON.stringify([this.agentDir, origin.sessionId]));
      if (changing) return changing.then(() => this.onInput(ctx), () => this.onInput(ctx));
      return undefined;
    }
    if (interactiveText !== undefined) ctx.ui.setEditorText?.(interactiveText);
    ctx.ui.notify(SETTINGS_PENDING_NOTICE, "warning");
    return { action: "handled" };
  }

  public onSessionBeforeSwitch(ctx: ExtensionContext): Promise<void | { cancel: true }> {
    if (this.inputModeCommandInFlight) {
      ctx.ui.notify(INPUT_MODE_PENDING_NOTICE, "warning");
      return Promise.resolve({ cancel: true });
    }
    if (this.settingsCommandInFlight || this.hasPendingModelChange(ctx)) {
      ctx.ui.notify(SETTINGS_PENDING_NOTICE, "warning");
      return Promise.resolve({ cancel: true });
    }
    const cleanup = this.cleanupRunReactions();
    this.invalidateRun();
    // before_* can be cancelled by another extension; release ownership at shutdown.
    // Only enabled integration needs registration; configured transport failures remain errors.
    if (this.active && this.config) this.outbox.enqueue(async signal => {
      if (cleanup) await cleanup;
      if (!signal.aborted && !await this.registerRoute(ctx, signal)) throw new Error("Failed to update Telegram navigation route.");
    });
    this.clearStatusBar(ctx);
    return cleanup ?? Promise.resolve();
  }

  public onSessionBeforeFork(ctx: ExtensionContext): Promise<void | { cancel: true }> { return this.onSessionBeforeSwitch(ctx); }
  public onSessionBeforeTree(): Promise<void | { cancel: true }> {
    if (this.inputModeCommandInFlight) {
      this.activeCtx?.ui.notify(INPUT_MODE_PENDING_NOTICE, "warning");
      return Promise.resolve({ cancel: true });
    }
    if (this.settingsCommandInFlight || this.hasPendingModelChange()) {
      this.activeCtx?.ui.notify(SETTINGS_PENDING_NOTICE, "warning");
      return Promise.resolve({ cancel: true });
    }
    const cleanup = this.cleanupRunReactions();
    this.invalidateRun();
    const ctx = this.activeCtx;
    if (ctx && this.active && this.config) this.outbox.enqueue(async signal => {
      if (cleanup) await cleanup;
      if (!signal.aborted && !await this.registerRoute(ctx, signal)) throw new Error("Failed to update Telegram navigation route.");
    });
    return cleanup ?? Promise.resolve();
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
      config?.autoCloseTopics === true && target && this.bindingState === "bound" && target.threadId === this.currentThreadId &&
      target.sessionId === ctx.sessionManager.getSessionId() && this.hasActiveTransport();
    const cleanup = this.cleanupRunReactions();
    // Fence inputs and cancel queued output synchronously, retaining the last acknowledged route only for closure.
    this.active = false;
    this.rateLimitReopenTarget = null;
    this.invalidateRun();
    // Do not await an uncancellable provider/model-select hook here. The process-wide
    // barrier fences input and session replacement after reload until it really settles.
    await this.markdownWorker.close();
    if (cleanup) await cleanup;
    if (shouldClose) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const params = { chat_id: config.chatId, message_thread_id: target.threadId };
          if (coordinator) await coordinator.callTelegram("closeForumTopic", params, this.runtimeId, target, undefined, controller.signal);
          else if (follower) {
            // Cancelling an earlier registration cannot undo a claim already
            // accepted by the Leader. Confirm a newer generation on the same
            // socket before closing, within the shared shutdown deadline.
            const closingTarget = { ...target, generation: this.generation };
            await follower.register({ runtimeId: this.runtimeId, ...closingTarget }, controller.signal);
            await follower.callTelegram("closeForumTopic", params, closingTarget, undefined, controller.signal);
          }
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
    const binding = { unbound: "Unbound", disconnected: "Disconnected", bound: "Bound", "topic-missing": "Topic missing", "create-unknown": "Creation unknown" }[this.bindingState];
    const polling = status ? { starting: "Starting", online: "Online", retrying: "Retrying", error: "Error", conflict: "Conflict" }[status.polling] : "Offline";
    ctx.ui?.notify([
      "[Telegram Mux Status]",
      `Config: ${this.config ? "Configured" : "Missing"}`,
      `Role: ${this.isLeader ? "Leader" : this.followerClient ? "Follower" : "None"}`,
      `Session ID: ${ctx.sessionManager.getSessionId()?.slice(-6) ?? "None"}`,
      `Binding: ${binding}`,
      `Thread ID: ${this.currentThreadId ?? "None"}`,
      `Auto-close Topics: ${this.config?.autoCloseTopics ? "On" : "Off"}`,
      `Busy Input Mode: ${this.config?.inputMode === "steer" ? "Steering" : "Follow-up"}`,
      `Runtime: ${this.getIsIdle() && ctx.isIdle() ? "Idle" : "Busy"}`,
      `Polling: ${polling}`,
      `Pending Sync: ${this.outbox.size}`,
      `Connection / Sync Error: ${failure ?? "None"}`,
      `Settings Error: ${this.settingsFailure ?? "None"}`,
      `Menu / Reply Warning: ${status?.interactionError?.message ?? "None"}`,
    ].join("\n"), "info");
    this.updateStatusBar(ctx);
  }

  public async handleTgConnect(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !this.active) return;
    this.activeCtx = ctx;
    if (!this.config) { ctx.ui?.notify("Please run /tg-setup first.", "warning"); return; }
    if (this.rateLimitUntil > Date.now()) { this.updateStatusBar(ctx); return; }
    if (this.configuring || this.recovering || this.rateLimitReopenTask || this.createInFlight) { ctx.ui?.notify("Telegram configuration, connection, or topic creation is in progress. Please try again later.", "warning"); return; }
    try {
      const status = this.coordinator?.getStatus() ?? this.followerClient?.getStatus();
      // Keep new runs out of the old transport for the entire recovery command,
      // including the interval after stopTransport clears its reconnect timer state.
      this.recovering = Boolean(this.outbox.error || status?.error || status?.feedbackError || this.rateLimitReopenTarget || !this.hasActiveTransport());
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
      if (this.bindingState === "topic-missing") {
        ctx.ui?.notify(TOPIC_MISSING_NOTICE, "warning");
        this.updateStatusBar(ctx);
        return;
      }
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
    if (this.bindingState === "disconnected") return;
    if (!appendBindingEntry(this.pi, ctx, this.config.chatId, null)) { ctx.ui?.notify("Failed to write disconnect record.", "error"); return; }
    this.invalidateRun();
    this.unregisterRoute(ctx);
    this.bindingState = "disconnected";
    this.currentThreadId = null;
    if (this.topicNeedsReopen && (this.connectionError as { code?: string } | null)?.code === "TELEGRAM_HTTP_429") this.connectionError = null;
    this.updateStatusBar(ctx);
    ctx.ui?.notify("Disconnected from Telegram topic.", "info");
  }

  public async handleTgSetup(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !this.active || this.configuring || this.recovering || this.configurationTask) return;
    this.activeCtx = ctx;
    this.configuring = true;
    let finishConfiguration!: () => void;
    this.configurationTask = new Promise<void>(resolve => { finishConfiguration = resolve; });
    let saved = false;
    try {
      while (this.active) {
        // Each menu selection has its own save outcome; the command retains the
        // configuration barrier until the user leaves the top-level menu.
        saved = false;
        this.configuring = true;
        try {
          const connectionOption = "Connection Settings";
          const autoCloseOption = `Auto-close Topics: ${this.config?.autoCloseTopics ? "On" : "Off"}`;
          const setting = await ctx.ui.select("Telegram Settings", [connectionOption, autoCloseOption]);
          if (setting === undefined || !this.active) return;
          let changes: Partial<MuxConfig>;
          if (setting === connectionOption) {
            const botToken = await ctx.ui.input("Bot Token:");
            if (!this.active) return;
            if (!botToken) continue;
            const chatInput = await ctx.ui.input("Forum Supergroup Chat ID:");
            if (!this.active) return;
            if (!chatInput) continue;
            const userInput = await ctx.ui.input("Allowed User ID:");
            if (!this.active) return;
            if (!userInput) continue;
            changes = { botToken, chatId: Number(chatInput), allowedUserId: Number(userInput) };
            const connection = validateConfig({ version: 1, ...changes });
            const client = new TelegramClient({ botToken: connection.botToken });
            await validateBotAndChat(client, connection.chatId, connection.allowedUserId);
          } else if (setting === autoCloseOption) {
            if (!this.config) {
              ctx.ui.notify("Configure the Telegram connection first.", "warning");
              continue;
            }
            const options = ["Off - Keep topics open (faster exit)", "On - Close topics (may wait up to 3 seconds)"];
            const selected = await ctx.ui.select(`Auto-close Topics (Current: ${this.config.autoCloseTopics ? "On" : "Off"})`, options);
            if (selected === undefined) continue;
            changes = { autoCloseTopics: selected === options[1] };
          } else return;
          if (!this.active) return;
          // Read and merge selected fields under the persistence lock, including
          // changes committed by another instance while this save was waiting.
          const config = await saveConfig(this.agentDir, { updates: changes });
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
          ctx.ui.notify("Telegram configuration saved and applied.", "info");
        } catch (err) {
          if (saved) {
            await this.stopTransport();
            ctx.ui?.notify("Configuration saved, but could not confirm updates on all processes. Please restart all Pi instances.", "error");
            return;
          }
          ctx.ui?.notify(`Telegram configuration validation failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
        }
      }
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

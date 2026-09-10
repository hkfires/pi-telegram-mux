import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupStaleMedia, configFingerprint, ensureMediaDir, loadConfig } from "./config.js";
import { encodeFrame, FrameParser, tryAcquireLeaderLock } from "./ipc.js";
import { IMAGE_MIME_TYPES, INPUT_CLEANUP_NOTICE_MS, MAX_INPUT_WORK, MEDIA_IPC_TIMEOUT_MS, removeMedia } from "./media.js";
import { BoundedOutbox } from "./outbox.js";
import { ConflictError, isRecoverableTelegramError, RateLimitError, TelegramApiError, TelegramClient } from "./telegram.js";
import { IPC_PROTOCOL_VERSION, type BusyInputMode, type InboundMedia, type InboundResult, type IpcMessage, type MuxConfig, type OutputTarget, type RuntimeRegistration, type TelegramMessage, type TelegramUpdate, type TransportStatus } from "./types.js";

const inputWorkKey = Symbol.for("pi-telegram-mux.coordinator-input-work.v1");
const workState = globalThis as typeof globalThis & { [inputWorkKey]?: Set<Promise<void>> };
const physicalInputWork = workState[inputWorkKey] ??= new Set<Promise<void>>();

export interface RouteEntry extends OutputTarget {
  runtimeId: string;
  dispatchInbound: (text: string, messageId: number, media?: InboundMedia | InboundMedia[], signal?: AbortSignal) => Promise<InboundResult>;
  abortRun?: () => boolean | void | Promise<boolean | void>;
}

interface MediaAlbum {
  messages: TelegramMessage[];
  route: RouteEntry;
  generation: number;
  client: TelegramClient;
  inputSignal: AbortSignal;
  ready: Promise<void>;
  finish: () => void;
  timer?: NodeJS.Timeout;
  deadline: number;
  sealed: boolean;
  rejected?: string;
  lateNoticeSent?: boolean;
  work?: Promise<void>;
}

interface SettingsMenu {
  route: RouteEntry;
  generation: number;
  expiresAt: number;
  messageId?: number;
  commands: string[];
}

interface FollowerConnection {
  runtimeId?: string;
  registration?: RuntimeRegistration;
  authTimer: NodeJS.Timeout;
  calls: Map<string, AbortController>;
  registrationRevision: number;
}

export interface CoordinatorOptions {
  requestTimeoutMs?: number;
  albumDelayMs?: number;
  onConfigChange?: (config: MuxConfig) => void | Promise<void>;
  onStatusChange?: () => void;
}

export class LeaderCoordinator {
  private client: TelegramClient;
  private finishStartup!: () => void;
  private readonly startupReady = new Promise<void>(resolve => { this.finishStartup = resolve; });
  private server: net.Server | null = null;
  private releaseLock?: () => Promise<void>;
  private running = false;
  private readonly albums = new Map<string, MediaAlbum>();
  private readonly rejectedAlbums = new Set<string>();
  private readonly inputQueues = new Map<number, Promise<void>>();
  private readonly inputWork = new Set<Promise<void>>();
  private readonly topicInputs = new WeakMap<RouteEntry, AbortController>();
  private pendingUpdates = 0;
  private nextOverloadNoticeAt = 0;
  private mediaCleanupTimer?: NodeJS.Timeout;
  private mediaCleanupTask?: Promise<void>;
  private capability = "";
  private configuration: string;
  private epoch = 0;
  private offset?: number;
  private botUsername?: string;
  private inputModeRevision = 0;
  private rateLimitTimer?: NodeJS.Timeout;
  private status: TransportStatus = { polling: "starting" };
  public readonly feedback: BoundedOutbox;
  private pollController: AbortController | null = null;
  private pollingTask: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private reloading: Promise<void> | null = null;
  private readonly routes = new Map<number, RouteEntry>();
  private readonly routeOwners = new Map<number, net.Socket>();
  private readonly menus = new Map<string, SettingsMenu>();
  private callbackAnswersInFlight = 0;
  private readonly connections = new Map<net.Socket, FollowerConnection>();
  private readonly pending = new Map<string, { socket: net.Socket; resolve: (value: InboundResult | boolean) => void; timer: NodeJS.Timeout; kind: "inbound" | "abort"; detach?: () => void; cancelRequested?: boolean; cancelConfirmed?: boolean }>();

  constructor(private config: MuxConfig, private readonly agentDir: string, client?: TelegramClient, private readonly options: CoordinatorOptions = {}) {
    this.client = client ?? new TelegramClient({ botToken: config.botToken });
    this.client.onRateLimit = until => this.pauseForRateLimit(until);
    this.inputModeRevision = config.inputModeRevision ?? 0;
    this.configuration = configFingerprint(config);
    this.feedback = new BoundedOutbox(error => this.publishStatus({ ...this.status, feedbackError: this.describeError(error) }));
  }

  public getTelegramClient(): TelegramClient { return this.client; }
  public getStatus(): TransportStatus { return this.status; }
  public isConflict(): boolean { return this.status.polling === "conflict"; }
  // Poll failure does not release the Leader lock or IPC listener.
  public isRunning(): boolean { return this.running; }
  public isReloading(): boolean { return this.reloading !== null; }

  private pauseForRateLimit(until: number): void {
    if (!this.running) return;
    clearTimeout(this.rateLimitTimer);
    // Discard obsolete feedback; never replay a rejected send after cooling down.
    if (!this.feedback.error || (this.feedback.error as { code?: string }).code === "TELEGRAM_HTTP_429") this.feedback.reset();
    this.publishStatus({ ...this.status, rateLimitUntil: until });
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = undefined;
      if (!this.running) return;
      if (this.client.isRateLimited()) {
        this.pauseForRateLimit(Date.now() + this.client.getRemainingPauseMs());
        return;
      }
      if ((this.feedback.error as { code?: string } | null)?.code === "TELEGRAM_HTTP_429") this.feedback.reset();
      const status = { ...this.status, rateLimitUntil: undefined };
      for (const key of ["error", "feedbackError", "commandMenuError", "interactionError"] as const) {
        if (status[key]?.code === "TELEGRAM_HTTP_429") delete status[key];
      }
      this.publishStatus(status);
    }, Math.min(2_147_483_647, Math.max(1, until - Date.now())));
    this.rateLimitTimer.unref();
  }

  private describeError(error: unknown): { code: string; message: string } {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "MUX_OPERATION_FAILED";
    return { code, message: this.client.redact(error instanceof Error ? error.message : String(error)).slice(0, 512) };
  }

  private publishStatus(status: TransportStatus): void {
    this.status = status;
    for (const [socket, state] of this.connections) {
      if (state.runtimeId && !socket.destroyed && !socket.writableEnded) {
        if (socket.writableLength > 1024 * 1024) socket.destroy();
        else socket.write(encodeFrame({ type: "transport_status", status }));
      }
    }
    this.options.onStatusChange?.();
  }
  public getRoutes(): ReadonlyMap<number, RouteEntry> { return this.routes; }

  public registerLocalRoute(route: RouteEntry): boolean { return this.claimRoute(route); }

  private claimRoute(route: RouteEntry, socket?: net.Socket): boolean {
    const existing = this.routes.get(route.threadId);
    if (existing && (existing.runtimeId !== route.runtimeId || this.routeOwners.get(route.threadId) !== socket || existing.generation > route.generation)) return false;
    if (existing?.sessionId === route.sessionId && existing.generation === route.generation) {
      // Preserve lease identity for ordinary registration refreshes. Queued
      // feedback also checks generation to reject navigation/configuration changes.
      Object.assign(existing, route);
      return true;
    }
    // A Runtime can own only one Topic, including when it explicitly rebinds.
    for (const [threadId, current] of this.routes) {
      if (current.runtimeId === route.runtimeId && this.routeOwners.get(threadId) === socket) this.releaseRoute(threadId);
    }
    this.routes.set(route.threadId, route);
    if (socket) this.routeOwners.set(route.threadId, socket);
    return true;
  }

  public unregisterLocalRoute(threadId: number, runtimeId: string): void {
    if (this.routes.get(threadId)?.runtimeId === runtimeId && !this.routeOwners.has(threadId)) this.releaseRoute(threadId);
  }

  /** Bind the real endpoint first, then acquire and publish leadership exactly once. */
  public async start(): Promise<{ leader: boolean; port: number; capability: string; epoch: number }> {
    if (this.server || this.stopping) throw new Error("Coordinator already started or stopped");
    const server = net.createServer(socket => this.handleFollowerConnection(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const port = (server.address() as net.AddressInfo).port;
      const result = await tryAcquireLeaderLock(this.agentDir, port, Date.now(), server);
      if (!result.acquired) {
        for (const socket of this.connections.keys()) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        this.server = null;
        return { leader: false, ...result.lockData };
      }
      this.releaseLock = result.releaseLock;
      this.capability = result.lockData.capability;
      this.epoch = result.lockData.epoch;
      this.running = true;
      const cleanup = () => {
        if (this.mediaCleanupTask) return;
        // Maintenance boundary: expose failures without stopping unrelated sessions.
        this.mediaCleanupTask = cleanupStaleMedia(this.agentDir).catch(error => {
          this.publishStatus({ ...this.status, feedbackError: { code: "MEDIA_CLEANUP_FAILED", message: this.describeError(error).message } });
        }).finally(() => { this.mediaCleanupTask = undefined; });
      };
      cleanup();
      this.mediaCleanupTimer = setInterval(cleanup, 60_000);
      this.mediaCleanupTimer.unref();
      this.startPolling();
      return { leader: true, port, capability: this.capability, epoch: this.epoch };
    } catch (err) {
      for (const socket of this.connections.keys()) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      this.server = null;
      throw err;
    } finally {
      this.finishStartup();
    }
  }

  private handleFollowerConnection(socket: net.Socket): void {
    const parser = new FrameParser();
    const state: FollowerConnection = { authTimer: setTimeout(() => socket.destroy(), 5000), calls: new Map(), registrationRevision: 0 };
    this.connections.set(socket, state);
    socket.on("data", chunk => {
      try {
        for (const msg of parser.push(chunk)) {
          // Async business requests must not block the parser or ACK dispatch.
          void this.startupReady.then(() => this.handleFrame(socket, state, msg)).catch(() => socket.destroy());
        }
      } catch { socket.destroy(); }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(state.authTimer);
      for (const controller of state.calls.values()) controller.abort();
      state.calls.clear();
      this.removeSocketRoutes(socket);
      this.settlePending(socket);
      this.connections.delete(socket);
    });
  }

  private cancelRouteInputs(route: RouteEntry): void {
    this.topicInputs.get(route)?.abort();
    this.topicInputs.delete(route);
    // Only the current lease may detach the thread's waiting tail.
    if (this.routes.get(route.threadId) === route) this.inputQueues.delete(route.threadId);
  }

  private releaseRoute(threadId: number): void {
    const route = this.routes.get(threadId);
    if (route) this.cancelRouteInputs(route);
    this.routes.delete(threadId);
    this.routeOwners.delete(threadId);
  }

  private removeSocketRoutes(socket: net.Socket): void {
    for (const [threadId, owner] of this.routeOwners) {
      if (owner === socket) this.releaseRoute(threadId);
    }
  }

  private resetFollowerConnection(socket: net.Socket, state: FollowerConnection): void {
    state.registration = undefined;
    this.removeSocketRoutes(socket);
    if (!state.runtimeId || socket.destroyed || socket.writableLength > 1024 * 1024) { socket.destroy(); return; }
    if (socket.writableEnded) return;
    clearTimeout(state.authTimer);
    state.authTimer = setTimeout(() => socket.destroy(), this.options.requestTimeoutMs ?? 5000);
    state.authTimer.unref();
    // Flush the reset before EOF; bound the drain for nonresponsive peers.
    socket.end(encodeFrame({ type: "transport_reset" }));
  }

  private async handleFrame(socket: net.Socket, state: FollowerConnection, msg: IpcMessage): Promise<void> {
    if (!this.running || socket.destroyed) { socket.destroy(); return; }
    if (socket.writableEnded) return;
    if (!state.runtimeId) {
      if (msg.type !== "auth" || msg.protocolVersion !== IPC_PROTOCOL_VERSION ||
          typeof msg.capability !== "string" || typeof msg.runtimeId !== "string" || !msg.runtimeId || msg.runtimeId.length > 128) {
        socket.destroy(); return;
      }
      const expected = Buffer.from(this.capability);
      const actual = Buffer.from(msg.capability);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { socket.destroy(); return; }
      state.runtimeId = msg.runtimeId;
      clearTimeout(state.authTimer);
      socket.write(encodeFrame({ type: "auth_ack", protocolVersion: IPC_PROTOCOL_VERSION, epoch: this.epoch, configFingerprint: this.configuration, connectionFingerprint: configFingerprint(this.config, "connection"), status: this.status, inputMode: this.config.inputMode ?? "followUp", inputModeRevision: this.inputModeRevision }));
      return;
    }

    if (msg.type === "cancel_input_ack") {
      if (typeof msg.requestId !== "string" || !msg.requestId || msg.requestId.length > 128 || typeof msg.ok !== "boolean") throw new Error("Invalid input cancellation acknowledgement");
      const pending = this.pending.get(msg.requestId);
      if (pending?.socket === socket && pending.kind === "inbound" && pending.cancelRequested && !pending.cancelConfirmed && msg.ok) {
        pending.cancelConfirmed = true;
        clearTimeout(pending.timer);
        // Submission rights are revoked, not I/O completion. Retain the request
        // and its capacity until inbound_ack/close, without killing a healthy peer.
        pending.timer = setTimeout(() => console.error(`[pi-telegram-mux] INPUT_CLEANUP_PENDING: request ${msg.requestId}`), INPUT_CLEANUP_NOTICE_MS);
        pending.timer.unref();
      }
      return;
    }
    if (msg.type === "inbound_ack" || msg.type === "abort_ack") {
      const pending = this.pending.get(msg.requestId);
      if (pending?.socket === socket && (msg.type === "inbound_ack" ? pending.kind === "inbound" : pending.kind === "abort")) {
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        pending.detach?.();
        if (msg.type === "abort_ack") {
          pending.resolve(msg.ok === true);
          return;
        }
        const result = {
          accepted: msg.accepted === true,
          busy: msg.busy === true,
          statusReply: typeof msg.statusReply === "string" ? msg.statusReply.slice(0, 4096) : undefined,
          menu: msg.menu,
          inputMode: msg.inputMode === "steer" || msg.inputMode === "followUp" ? msg.inputMode : undefined,
          inputModeRevision: typeof msg.inputModeRevision === "number" ? msg.inputModeRevision : undefined,
        };
        if (result.inputMode && !pending.cancelRequested) {
          this.updateInputMode(result.inputMode, socket, result.inputModeRevision);
        }
        pending.resolve(result);
      }
      return;
    }
    if (msg.type === "ping") { socket.write(encodeFrame({ type: "pong" })); return; }
    if (msg.type === "sync_input_mode") {
      if ((msg.mode === "followUp" || msg.mode === "steer") && Number.isSafeInteger(msg.revision) && msg.revision > 0) {
        this.updateInputMode(msg.mode, socket, msg.revision);
      }
      return;
    }
    // Cancellation and release must not wait behind a reload barrier.
    if (msg.type === "cancel_telegram") {
      if (typeof msg.callId !== "string" || msg.callId.length > 128) throw new Error("Invalid cancellation ID");
      state.calls.get(msg.callId)?.abort();
      return;
    }
    if (msg.type === "release") {
      if (!state.registration || msg.runtimeId !== state.runtimeId || msg.sessionId !== state.registration.sessionId) throw new Error("Invalid route release");
      this.removeSocketRoutes(socket);
      state.registrationRevision++;
      state.registration = { ...state.registration, threadId: null };
      socket.write(encodeFrame({ type: "release_ack", ok: true }));
      return;
    }

    let controller: AbortController | undefined;
    const registrationRevision = state.registrationRevision;
    if (msg.type === "call_telegram" || msg.type === "reload_config" || (msg.type === "register" && msg.callId !== undefined)) {
      if (typeof msg.callId !== "string" || !msg.callId || msg.callId.length > 128 || state.calls.has(msg.callId) || state.calls.size >= 128) throw new Error("Invalid or excessive request ID");
      // Reserve before waiting so a cancelled deferred call can never start later.
      controller = new AbortController();
      state.calls.set(msg.callId, controller);
    }
    try {
      while (this.reloading) {
        const pollController = this.pollController;
        let completed = false;
        try { await this.reloading; completed = true; }
        catch {
          // The reload caller reports the error. If loading/validation failed before
          // stopping the old transport, peers can continue using that configuration.
        }
        if (!this.running || socket.destroyed) { socket.destroy(); return; }
        if (socket.writableEnded) return;
        if (completed || pollController?.signal.aborted) {
          // Peers that authenticated after the initial reset loop also need a reset,
          // so their registrations cannot outlive the configuration they observed.
          this.resetFollowerConnection(socket, state);
          return;
        }
      }

      if (msg.type === "register") {
        // A release fences every earlier registration, including legacy frames
        // without a call ID. Cancelling one RPC must not close a healthy socket.
        if (controller?.signal.aborted || registrationRevision !== state.registrationRevision) {
          socket.write(encodeFrame({ type: "register_ack", callId: msg.callId, ok: false, error: "Route registration cancelled or released" }));
          return;
        }
        const reg = msg.registration;
        if (!reg || reg.runtimeId !== state.runtimeId || typeof reg.sessionId !== "string" || !reg.sessionId || reg.sessionId.length > 256 ||
            !Number.isSafeInteger(reg.generation) || reg.generation < 1 ||
            (reg.threadId !== null && (!Number.isSafeInteger(reg.threadId) || reg.threadId <= 0)) ||
            (state.registration && reg.generation < state.registration.generation)) throw new Error("Invalid route registration");
        let ok = true;
        if (reg.threadId === null) this.removeSocketRoutes(socket);
        else {
          const target: OutputTarget = { sessionId: reg.sessionId, threadId: reg.threadId, generation: reg.generation };
          ok = this.claimRoute({
            ...target,
            runtimeId: reg.runtimeId,
            dispatchInbound: (text, messageId, media, signal) => this.requestFollower(socket, {
              type: "inbound",
              requestId: "",
              messageId,
              target,
              fromId: this.config.allowedUserId,
              text,
              mode: this.config.inputMode ?? "followUp",
              media,
            }, signal) as Promise<InboundResult>,
            abortRun: () => this.requestFollower(socket, { type: "abort", requestId: "", target }) as Promise<boolean>,
          }, socket);
        }
        if (ok) state.registration = reg;
        socket.write(encodeFrame({ type: "register_ack", callId: msg.callId, ok, error: ok ? undefined : "Topic already claimed by another Runtime" }));
        return;
      }
      if (!state.registration) throw new Error("Register a session before submitting IPC requests");

      if (msg.type === "call_telegram" || msg.type === "reload_config") {
        try {
          let result: unknown;
          if (msg.type === "reload_config") await this.reloadConfig(socket);
          else result = await this.callTelegram(msg.method, msg.params, state.runtimeId, msg.target, socket, controller!.signal);
          if (!socket.destroyed && !socket.writableEnded) {
            const reply = encodeFrame({ type: "call_telegram_ack", callId: msg.callId, ok: true, result });
            if (msg.type === "reload_config") socket.end(reply);
            else socket.write(reply);
          }
        } catch (err) {
          // RPC boundary: report the failure unless a prior reset frame already
          // cancelled this connection's work and its response stream is closing.
          if (!socket.destroyed && !socket.writableEnded) {
            const failure = this.describeError(err);
            socket.write(encodeFrame({ type: "call_telegram_ack", callId: msg.callId, ok: false, error: failure.message, code: failure.code, retryAfter: err instanceof TelegramApiError ? err.retryAfter : undefined }));
          }
        }
      } else throw new Error("Unexpected IPC message");
    } finally {
      if (controller && "callId" in msg && msg.callId) state.calls.delete(msg.callId);
    }
  }

  private requestFollower(socket: net.Socket, msg: Extract<IpcMessage, { type: "inbound" | "abort" }>, signal?: AbortSignal): Promise<InboundResult | boolean> {
    const unavailable = msg.type === "abort" ? false : { accepted: false, busy: false, statusReply: "Execution result unknown. Please check local session; do not resend automatically." };
    if (signal?.aborted || socket.destroyed || socket.writableEnded || this.pending.size >= 128) return Promise.resolve(unavailable);
    const requestId = crypto.randomUUID();
    const timeoutMs = this.options.requestTimeoutMs ?? (msg.type === "inbound" && msg.media ? MEDIA_IPC_TIMEOUT_MS : 5000);
    return new Promise(resolve => {
      const cancel = () => {
        const pending = this.pending.get(requestId);
        if (!pending || pending.cancelRequested) return;
        pending.cancelRequested = true;
        if (!socket.destroyed && !socket.writableEnded) socket.write(encodeFrame({ type: "cancel_input", requestId }));
      };
      const detach = () => signal?.removeEventListener("abort", cancel);
      const timer = setTimeout(() => {
        if (this.pending.get(requestId)?.cancelRequested) console.error(`[pi-telegram-mux] INPUT_CANCEL_UNCONFIRMED: request ${requestId}; execution result unknown`);
        detach(); this.pending.delete(requestId); resolve(unavailable); socket.destroy();
      }, timeoutMs);
      this.pending.set(requestId, { socket, resolve, timer, kind: msg.type, detach });
      socket.write(encodeFrame({ ...msg, requestId }));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  private settlePending(socket?: net.Socket): void {
    for (const [id, pending] of this.pending) {
      if (!socket || pending.socket === socket) {
        clearTimeout(pending.timer);
        pending.detach?.();
        this.pending.delete(id);
        pending.resolve(pending.kind === "abort" ? false : { accepted: false, busy: false, statusReply: "Execution result unknown. Please check local session; do not resend automatically." });
      }
    }
  }

  /** Apply the same output ownership checks to local and remote senders. */
  public async callTelegram<T>(method: string, params: Record<string, unknown>, runtimeId: string, target?: OutputTarget, socket?: net.Socket, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const pollingFailed = this.status.polling === "error" || this.status.polling === "conflict";
    if (!this.isRunning() || pollingFailed || this.reloading || !params || params.chat_id !== this.config.chatId) throw new Error("Telegram transport unavailable or chat mismatch");
    if (method === "sendMessage") {
      const route = target ? this.routes.get(target.threadId) : undefined;
      if (!target || !route || route.runtimeId !== runtimeId || route.sessionId !== target.sessionId || route.generation !== target.generation ||
          this.routeOwners.get(target.threadId) !== socket || params.message_thread_id !== target.threadId ||
          typeof params.text !== "string" || !params.text.trim() || params.text.length > 4096 ||
          (params.entities !== undefined && (!Array.isArray(params.entities) || params.entities.length > 100))) throw new Error("Output target fenced or invalid message");
    } else if (method === "closeForumTopic" || method === "reopenForumTopic") {
      if (!Number.isSafeInteger(params.message_thread_id) || (params.message_thread_id as number) <= 0) {
        throw new Error("Invalid message_thread_id for forum topic");
      }
      const route = target ? this.routes.get(target.threadId) : undefined;
      if (!target || !route || route.runtimeId !== runtimeId || route.sessionId !== target.sessionId || route.generation !== target.generation ||
          this.routeOwners.get(target.threadId) !== socket || params.message_thread_id !== target.threadId) {
        throw new Error("Forum topic target fenced");
      }
    } else if (method === "setMessageReaction") {
      if (!Number.isSafeInteger(params.message_id) || (params.message_id as number) <= 0) {
        throw new Error("Invalid message_id for setMessageReaction");
      }
      const route = target ? this.routes.get(target.threadId) : undefined;
      if (!target || !route || route.runtimeId !== runtimeId || route.sessionId !== target.sessionId || route.generation !== target.generation ||
          this.routeOwners.get(target.threadId) !== socket) {
        throw new Error("Output target fenced for setMessageReaction");
      }
      return this.client.callApi<T>(method, params, undefined, signal, { ignoreRateLimit: true });
    } else if (method !== "createForumTopic" || typeof params.name !== "string" || !params.name.trim() || params.name.length > 128) {
      throw new Error("Unsupported Telegram request");
    }
    return this.client.callApi<T>(method, params, undefined, signal);
  }

  private startPolling(): void {
    const controller = new AbortController();
    this.pollController = controller;
    this.publishStatus({ polling: "starting", rateLimitUntil: this.status.rateLimitUntil });
    this.pollingTask = this.poll(controller.signal).catch(error => {
      // Poll supervisor boundary: shutdown/reload cancellation is expected. Every
      // other failure becomes a persistent, broadcast error state; no silent retry.
      if (controller.signal.aborted) return;
      // A terminal poll failure removes the Telegram stop channel. Fence pending
      // inputs and release their queue reservations before publishing the failure.
      controller.abort();
      for (const route of this.routes.values()) this.cancelRouteInputs(route);
      this.publishStatus({ ...this.status, polling: error instanceof ConflictError ? "conflict" : "error", error: this.describeError(error) });
    });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let menuRegistered = false;
    let nextMenuAttempt = 0;
    while (this.running && !signal.aborted) {
      try {
        if (this.client.isRateLimited()) {
          await delay(Math.min(this.client.getRemainingPauseMs() + 100, 5000), undefined, { signal });
          continue;
        }
        if (!this.botUsername) this.botUsername = (await this.client.getMe(signal)).username!.toLowerCase();
        // Command discovery is auxiliary: retry independently without marking the transport failed.
        if (!menuRegistered && Date.now() >= nextMenuAttempt) {
          try {
            await this.client.callApi("setMyCommands", {
              scope: { type: "chat_member", chat_id: this.config.chatId, user_id: this.config.allowedUserId },
              commands: [
                { command: "model", description: "List or select the current session model" },
                { command: "thinking", description: "View or change the current session thinking level" },
                { command: "inputmode", description: "View or change busy input mode (follow-up or steering)" },
                { command: "status", description: "Show topic connection status" },
                { command: "stop", description: "Stop the current session run" },
              ],
            }, 5000, signal);
            menuRegistered = true;
            if (this.status.commandMenuError) this.publishStatus({ ...this.status, commandMenuError: undefined });
          } catch (error) {
            if (signal.aborted) return;
            this.publishStatus({ ...this.status, commandMenuError: this.describeError(error) });
            nextMenuAttempt = Date.now() + 60_000;
          }
        }
        if (this.client.isRateLimited()) continue;
        const updates = await this.client.getUpdates({ offset: this.offset, limit: 100, timeout: 25, allowed_updates: ["message", "callback_query"], signal });
        if (signal.aborted || !this.running) return;
        if (this.status.polling !== "online") this.publishStatus({ ...this.status, polling: "online", error: undefined });
        for (const update of updates) {
          if (signal.aborted || !this.running) return;
          this.offset = update.update_id + 1;
          // Admission is bounded and per-topic ordered; downloads never block polling /stop.
          void this.processUpdate(update);
        }
      } catch (error) {
        // Only known transient polling failures are recoverable. Decoding errors,
        // authentication failures and unknown exceptions propagate to the supervisor.
        if (signal.aborted) return;
        if (!isRecoverableTelegramError(error)) throw error;
        this.publishStatus({ ...this.status, polling: "retrying", error: this.describeError(error) });
        const waitMs = error instanceof RateLimitError ? Math.min(this.client.getRemainingPauseMs() + 100, 5000) : 2000;
        await delay(waitMs, undefined, { signal });
      }
    }
  }

  public async processUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.running || this.reloading || this.pollController?.signal.aborted) return;
    const query = update.callback_query;
    const msg = query ? undefined : update.message;
    // Authenticate both update variants before reserving shared input capacity.
    if (query) {
      if (!query.message || query.message.chat.id !== this.config.chatId ||
          query.from?.id !== this.config.allowedUserId || query.from.is_bot) return;
    } else if (!msg || msg.chat.id !== this.config.chatId || msg.from?.id !== this.config.allowedUserId || msg.from.is_bot) return;
    const thread = msg?.message_thread_id;
    const route = thread === undefined ? undefined : this.routes.get(thread);
    const albumKey = msg?.media_group_id ? JSON.stringify([msg.chat.id, thread, msg.from!.id, msg.media_group_id]) : undefined;
    if (albumKey && this.rejectedAlbums.has(albumKey)) return;
    // Never let queued input acquire a destination that did not exist at admission.
    if (msg && !route) {
      if (albumKey) {
        if (this.rejectedAlbums.size >= 128) this.rejectedAlbums.delete(this.rejectedAlbums.values().next().value!);
        this.rejectedAlbums.add(albumKey);
      }
      return;
    }
    const generation = route?.generation;
    const client = this.client;
    const signal = this.pollController?.signal;
    if (albumKey) {
      const existing = this.albums.get(albumKey);
      if (existing) {
        if (existing.client !== client || existing.inputSignal.aborted || existing.route !== route || existing.generation !== generation) return;
        if (existing.messages.some(item => item.message_id === msg!.message_id)) return;
        if (existing.sealed) {
          // Telegram has no album-complete event. Never silently split a late member into another task.
          if (!existing.lateNoticeSent) {
            existing.lateNoticeSent = true;
            this.enqueueSettingsFeedback(route!, generation!, "An album image arrived after collection finished and was not submitted. Check the earlier task before resending the album.");
          }
          return;
        }
        if (existing.messages.length >= 10) {
          existing.rejected = "Albums are limited to 10 images; no images were submitted.";
          existing.finish();
        } else {
          existing.messages.push(msg!);
          clearTimeout(existing.timer);
          existing.timer = setTimeout(existing.finish, Math.max(0, Math.min(this.options.albumDelayMs ?? 1000, existing.deadline - performance.now())));
        }
        return existing.work;
      }
    }
    const bypass = !msg || (!msg.photo && !msg.document && /^\/(stop|status)(?:@[a-z\d_]+)?(?:\s|$)/i.test(msg.text?.trim() ?? ""));
    if (this.pendingUpdates >= (bypass ? 32 : 16) || (!bypass && physicalInputWork.size >= MAX_INPUT_WORK)) {
      // A rejected first member rejects the album, even if capacity recovers before later members.
      if (albumKey) {
        if (this.rejectedAlbums.size >= 128) this.rejectedAlbums.delete(this.rejectedAlbums.values().next().value!);
        this.rejectedAlbums.add(albumKey);
      }
      // Coalesce overload notices globally; optional feedback must not exhaust the outbox.
      const now = performance.now();
      if (route && now >= this.nextOverloadNoticeAt && this.feedback.size === 0 && !this.feedback.error) {
        this.nextOverloadNoticeAt = now + 5000;
        this.enqueueSettingsFeedback(route, route.generation, "Input queue is full. Please try again later.");
      }
      return;
    }
    let inputSignal: AbortSignal | undefined;
    if (route && !bypass) {
      let controller = this.topicInputs.get(route);
      if (!controller) {
        controller = new AbortController();
        this.topicInputs.set(route, controller);
      }
      inputSignal = controller.signal;
    }
    let album: MediaAlbum | undefined;
    if (albumKey && msg && route && inputSignal) {
      // Pending albums consume ordinary input capacity; completed IDs retain no message content.
      while (this.albums.size >= 128) {
        const oldest = [...this.albums].find(([, value]) => value.sealed && !value.work);
        if (!oldest) break;
        this.albums.delete(oldest[0]);
      }
      let settle!: () => void;
      const ready = new Promise<void>(resolve => { settle = resolve; });
      const collectionSignal = signal ? AbortSignal.any([signal, inputSignal]) : inputSignal;
      album = { messages: [msg], route, generation: generation!, client, inputSignal, ready,
        deadline: performance.now() + 5000, sealed: false, finish: () => {
          if (album!.sealed) return;
          album!.sealed = true;
          clearTimeout(album!.timer);
          collectionSignal.removeEventListener("abort", album!.finish);
          settle();
        } };
      this.albums.set(albumKey, album);
      collectionSignal.addEventListener("abort", album.finish, { once: true });
      album.timer = setTimeout(album.finish, this.options.albumDelayMs ?? 1000);
    }
    this.pendingUpdates++;
    const previous = !bypass && thread !== undefined ? this.inputQueues.get(thread) : undefined;
    const cancellation = inputSignal && signal ? AbortSignal.any([inputSignal, signal]) : inputSignal ?? signal;
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    cancellation?.addEventListener("abort", cancel, { once: true });
    if (cancellation?.aborted) cancel();
    const operation = (async () => {
      if (previous) await previous;
      if (album) await album.ready;
      if (inputSignal?.aborted || client !== this.client || signal?.aborted || (route && (this.routes.get(thread!) !== route || route.generation !== generation))) return;
      if (album?.rejected) {
        this.enqueueSettingsFeedback(route!, generation!, album.rejected);
        return;
      }
      await this.processUpdateNow(update, route, inputSignal, album?.messages);
    })().catch(error => {
      // Command/input boundary: abort and cleanup failures must not terminate the poller.
      if (!this.running || client !== this.client || cancellation?.aborted) {
        // Detached cleanup still has an observable failure boundary, but cannot
        // poison the replacement transport or report success for stale work.
        console.error("[pi-telegram-mux] INPUT_CLEANUP_FAILED:", this.describeError(error));
        return;
      }
      this.publishStatus({ ...this.status, feedbackError: this.describeError(error) });
      if (route) this.enqueueSettingsFeedback(route, generation!, "Operation failed; execution result unknown. Check local Pi errors before retrying.");
    });
    this.inputWork.add(operation);
    physicalInputWork.add(operation);
    const residualDeadline = setTimeout(() => console.error(`[pi-telegram-mux] INPUT_WORK_PENDING: update ${update.update_id}`), INPUT_CLEANUP_NOTICE_MS);
    residualDeadline.unref();
    void operation.then(() => { clearTimeout(residualDeadline); this.inputWork.delete(operation); physicalInputWork.delete(operation); });
    // Cancellation releases capacity and topic ordering without waiting for OS
    // I/O. The detached operation still owns cleanup and is fenced before dispatch.
    const work = Promise.race([operation, cancelled]).finally(() => {
      cancellation?.removeEventListener("abort", cancel);
      this.pendingUpdates--;
      if (album) { album.messages = []; album.work = undefined; }
      if (thread !== undefined && this.inputQueues.get(thread) === work) this.inputQueues.delete(thread);
    });
    if (album) album.work = work;
    if (!bypass && thread !== undefined) this.inputQueues.set(thread, work);
    await work;
  }

  private async processUpdateNow(update: TelegramUpdate, admittedRoute?: RouteEntry, inputSignal?: AbortSignal, albumMessages?: TelegramMessage[]): Promise<void> {
    if (update.callback_query) return this.processSettingsCallback(update.callback_query);
    const messages = albumMessages ? [...albumMessages].sort((a, b) => a.message_id - b.message_id) : update.message ? [update.message] : [];
    const msg = messages[0];
    if (!this.running || this.reloading || !msg || msg.chat.id !== this.config.chatId || msg.message_thread_id === undefined ||
        msg.from?.id !== this.config.allowedUserId || msg.from.is_bot) return;

    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasDocImage = Boolean(msg.document && typeof msg.document.mime_type === "string" && msg.document.mime_type.startsWith("image/"));
    const hasImage = hasPhoto || hasDocImage || albumMessages !== undefined;
    const rawText = albumMessages ? messages.map(item => item.caption?.trim() ?? "").filter(Boolean).join("\n\n")
      : (typeof msg.text === "string" ? msg.text : hasImage && typeof msg.caption === "string" ? msg.caption : "").trim();

    if (!hasImage && (!rawText || rawText.length > 4096)) return;
    if (hasImage && rawText.length > 4096) {
      if (admittedRoute) this.enqueueSettingsFeedback(admittedRoute, admittedRoute.generation, "Image captions exceed 4096 characters; no images were submitted.");
      return;
    }

    const route = admittedRoute;
    if (!route || this.routes.get(msg.message_thread_id) !== route) return;
    const generation = route.generation;
    const sessionId = route.sessionId;
    const client = this.client;
    const pollSignal = this.pollController?.signal;
    const signal = inputSignal && pollSignal ? AbortSignal.any([inputSignal, pollSignal]) : inputSignal ?? pollSignal;
    const dispatch = route.dispatchInbound;
    if (hasImage && messages.some(item => !(item.photo?.length) && !IMAGE_MIME_TYPES.has(item.document?.mime_type ?? ""))) {
      this.enqueueSettingsFeedback(route, generation, "Unsupported image format. Send JPEG, PNG, GIF or WebP.");
      return;
    }

    if (!hasImage) {
      const command = /^\/([a-z\d_]+)(?:@([a-z\d_]+))?(?:\s|$)/i.exec(rawText);
      if (command?.[2] && command[2].toLowerCase() !== this.botUsername) return;
      const name = command?.[1].toLowerCase();
      if (name === "status") {
        this.enqueueSettingsFeedback(route, generation, `Topic: Online\nSession: ${route.sessionId.slice(-6)}\nRoute: Active`);
        return;
      }
      if (name === "stop") {
        // Invalidate queued work synchronously, even if aborting the active Pi run fails.
        this.cancelRouteInputs(route);
        const stopped = route.abortRun ? (await route.abortRun()) !== false : false;
        const reply = stopped ? "Abort signal sent." : "Could not confirm abort; please check local session.";
        this.enqueueSettingsFeedback(route, generation, reply);
        return;
      }
    }

    const mediaItems: InboundMedia[] = [];
    const downloadedPaths = new Set<string>();
    let mediaHandedOff = false;

    try {
    if (hasImage) {
      try {
        for (const imageMessage of messages) {
        if (signal?.aborted || client !== this.client) return;
        let fileId: string;
        let mimeType = "image/jpeg";
        let fileName: string | undefined;

        if (imageMessage.photo?.length) {
          const photo = imageMessage.photo[imageMessage.photo.length - 1];
          fileId = photo.file_id;
        } else {
          fileId = imageMessage.document!.file_id;
          mimeType = imageMessage.document!.mime_type!;
          fileName = imageMessage.document!.file_name;
        }

        const fileInfo = await client.getFile(fileId, signal);
        if (!fileInfo.file_path) throw new Error("Telegram file_path is missing");

        const buffer = await client.downloadFile(fileInfo.file_path, signal);
        const mediaDir = await ensureMediaDir(this.agentDir);
        const ext = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : mimeType === "image/gif" ? ".gif" : ".jpg";
        const downloadedPath = path.resolve(mediaDir, `${crypto.randomUUID()}${ext}`);
        const stagingPath = `${downloadedPath}.part`;
        // Own the path only after exclusive creation succeeds. A failed open
        // must never make cleanup delete an existing file belonging to someone else.
        const file = await fs.open(stagingPath, "wx", 0o600);
        downloadedPaths.add(stagingPath);
        try { await file.writeFile(buffer); }
        finally { await file.close(); }
        mediaItems.push({ path: downloadedPath, mimeType, fileName });
        }
        if (!this.running || this.reloading || signal?.aborted || client !== this.client ||
            this.routes.get(msg.message_thread_id) !== route || route.generation !== generation || route.sessionId !== sessionId) return;
        // Publish complete images at their final, stable paths before handing
        // out references. Until then the creator still owns whole-album cleanup.
        for (const media of mediaItems) {
          // The exclusively created sibling .part file reserves this random
          // basename against other mux writers until publication finishes.
          try {
            await fs.lstat(media.path);
            throw Object.assign(new Error("Image cache destination already exists"), { code: "EEXIST" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const stagingPath = `${media.path}.part`;
          await fs.rename(stagingPath, media.path);
          downloadedPaths.delete(stagingPath);
          downloadedPaths.add(media.path);
        }
        if (this.running && !signal?.aborted && client === this.client && this.status.interactionError?.code === "MEDIA_DOWNLOAD_FAILED") {
          this.publishStatus({ ...this.status, interactionError: undefined });
        }
      } catch (error) {
        // Download boundary: no task has been submitted; report a definite failure.
        if (!this.running || signal?.aborted || client !== this.client) {
          const code = (error as { code?: string } | null)?.code;
          if (code !== "TELEGRAM_ABORTED" && code !== "TELEGRAM_RELOADING") {
            console.error(`[pi-telegram-mux] MEDIA_DOWNLOAD_FAILED: update ${update.update_id}`, this.describeError(error));
          }
          return;
        }
        const fileRefused = error instanceof TelegramApiError && (error.errorCode === 400 || error.errorCode === 404);
        if (fileRefused || isRecoverableTelegramError(error)) {
          // Download boundary: file-level 400/404 refusals and transient failures submitted no task.
          // Authentication and malformed-protocol failures must still signal a shared operational error.
          const failure = this.describeError(error);
          this.publishStatus({ ...this.status, interactionError: { code: "MEDIA_DOWNLOAD_FAILED", message: `Image download failed (${failure.code}); no task was submitted.` } });
        } else {
          // Unexpected decoding/I/O failures remain visible as operational errors.
          this.publishStatus({ ...this.status, feedbackError: this.describeError(error) });
        }
        this.enqueueSettingsFeedback(route, generation, "Failed to download image from Telegram. Please check network and try again.");
        return;
      }
    }

    let reply: string | undefined;
    let menu: InboundResult["menu"];
    try {
      if (!this.running || this.reloading || signal?.aborted || client !== this.client ||
          this.routes.get(msg.message_thread_id) !== route || route.generation !== generation || route.sessionId !== sessionId) return;
      // Like native clipboard images, handed-off files outlive the operation.
      // A rejection, timeout or lost acknowledgement cannot prove that a path
      // is no longer referenced; never make retention depend on an execution ACK.
      mediaHandedOff = mediaItems.length > 0;
      const result = await dispatch(rawText, msg.message_id, mediaItems.length > 1 ? mediaItems : mediaItems[0], signal);
      if (!this.running || this.reloading || signal?.aborted || client !== this.client ||
          this.routes.get(msg.message_thread_id) !== route || route.generation !== generation || route.sessionId !== sessionId) return;
      if (result.inputMode) {
        this.updateInputMode(result.inputMode, undefined, result.inputModeRevision);
      }
      reply = result.busy ? "Current session is busy. Please try again later." : result.statusReply;
      menu = result.busy ? undefined : result.menu;
    } catch (error) {
      // Inbound dispatch boundary: execution may already have started. Return an
      // explicit unknown result, expose the failure, and never resubmit the input.
      if (!this.running || this.reloading || signal?.aborted || client !== this.client ||
          this.routes.get(msg.message_thread_id) !== route || route.generation !== generation || route.sessionId !== sessionId) return;
      this.publishStatus({ ...this.status, feedbackError: this.describeError(error) });
      reply = "Execution result unknown. Please check local Pi errors; do not resend automatically.";
    }
    if (reply) this.enqueueSettingsFeedback(route, generation, reply, menu);
    } finally {
      // Only the creator cleans files that never reached the handoff boundary.
      // No consumer, run finalizer or maintenance sweep owns completed images.
      if (!mediaHandedOff && downloadedPaths.size) {
        try { await removeMedia([...downloadedPaths]); }
        catch (error) {
          // Cache ownership boundary: deletion failure is operationally significant even after reload.
          if (this.running && client === this.client && !signal?.aborted) {
            this.publishStatus({ ...this.status, feedbackError: { code: "MEDIA_CLEANUP_FAILED", message: "Temporary image deletion failed; check local media directory permissions." } });
          } else console.error("[pi-telegram-mux] MEDIA_CLEANUP_FAILED: temporary image deletion failed after transport shutdown/reset.");
          throw error;
        }
      }
    }
  }

  private async processSettingsCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const msg = query.message;
    if (!this.running || this.reloading || !msg || msg.chat.id !== this.config.chatId ||
        query.from?.id !== this.config.allowedUserId || query.from.is_bot ||
        typeof query.id !== "string" || !query.id || typeof query.data !== "string" || !query.data.startsWith("mux:")) return;
    const match = /^mux:([a-f\d]{24}):(\d{1,2})$/.exec(query.data);
    const menu = match ? this.menus.get(match[1]) : undefined;
    const command = menu?.commands[Number(match?.[2])];
    const valid = menu && command && performance.now() < menu.expiresAt && msg.date !== 0 &&
      msg.message_id === menu.messageId && (msg.message_thread_id === undefined || msg.message_thread_id === menu.route.threadId) &&
      this.routes.get(menu.route.threadId) === menu.route && menu.route.generation === menu.generation;
    // Consume all sibling buttons before awaiting anything: replayed/double clicks cannot execute twice.
    if (valid) this.menus.delete(match![1]);
    const client = this.client;
    const signal = this.pollController?.signal;
    // The click acknowledgement is cosmetic, not an execution prerequisite.
    // Bound background requests so stale-button spam cannot exhaust the transport.
    if (this.callbackAnswersInFlight < 32) {
      this.callbackAnswersInFlight++;
      void client.callApi("answerCallbackQuery", {
        callback_query_id: query.id,
        text: valid ? "Processing…" : "Menu expired. Send /model, /thinking, or /inputmode to open a new menu.",
        show_alert: !valid,
      }, 5000, signal).catch(error => {
        if (signal?.aborted || !this.running || this.reloading || this.client !== client) return;
        if (isRecoverableTelegramError(error)) return;
        if (error instanceof TelegramApiError && error.errorCode === 400) {
          // Telegram provides only a generic 400, not a stable expired-query subcode.
          // The acknowledgement boundary reports the rejected interaction without poisoning transport.
          this.publishStatus({ ...this.status, interactionError: {
            code: "TELEGRAM_CALLBACK_REJECTED",
            message: "Telegram rejected a button acknowledgement (HTTP 400). Check the selection result; do not repeat it automatically.",
          } });
          return;
        }
        // Keep authentication/protocol failures visible, but never retry the settings action.
        this.publishStatus({ ...this.status, feedbackError: this.describeError(error) });
      }).finally(() => { this.callbackAnswersInFlight--; });
    }
    if (!valid || !this.running || this.reloading || this.client !== client ||
        this.routes.get(menu.route.threadId) !== menu.route || menu.route.generation !== menu.generation) return;
    let result: InboundResult;
    try {
      result = await menu.route.dispatchInbound(command, msg.message_id);
      if (result.inputMode) {
        this.updateInputMode(result.inputMode, undefined, result.inputModeRevision);
      }
    } catch (error) {
      this.publishStatus({ ...this.status, feedbackError: this.describeError(error) });
      result = { accepted: false, busy: false, statusReply: "Execution result unknown. Check local Pi; do not click again." };
    }
    const reply = result.busy ? "The current session is busy. Send /model, /thinking, or /inputmode again when the task finishes." : result.statusReply ?? "Operation finished. Send /model, /thinking, or /inputmode to view settings.";
    this.enqueueSettingsFeedback(menu.route, menu.generation, reply, result.busy ? undefined : result.menu, msg.message_id);
  }

  private async deliverFeedback<T>(client: TelegramClient, signal: AbortSignal, route: RouteEntry, generation: number, send: () => Promise<T>): Promise<T | undefined> {
    signal.throwIfAborted();
    if (!this.running || this.reloading || this.client !== client || this.routes.get(route.threadId) !== route || route.generation !== generation || client.isRateLimited()) return undefined;
    return send();
  }

  public getInputMode(): BusyInputMode {
    return this.config.inputMode ?? "followUp";
  }

  public getInputModeRevision(): number {
    return this.inputModeRevision;
  }

  public updateInputMode(mode: BusyInputMode, originSocket?: net.Socket, revision?: number): void {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision <= 0)) return;
    const rev = revision ?? this.inputModeRevision + 1;
    if (rev <= this.inputModeRevision) return;
    this.inputModeRevision = rev;
    this.config.inputMode = mode;
    this.config.inputModeRevision = rev;
    this.configuration = configFingerprint(this.config);
    this.broadcastInputMode(mode, originSocket, rev);
  }

  public broadcastInputMode(mode: BusyInputMode, originSocket?: net.Socket, revision?: number): void {
    const rev = revision ?? this.inputModeRevision;
    if (!Number.isSafeInteger(rev) || rev <= 0) return;
    for (const [socket, state] of this.connections) {
      if (socket !== originSocket && state.runtimeId && !socket.destroyed && !socket.writableEnded) {
        if (socket.writableLength > 1024 * 1024) socket.destroy();
        else socket.write(encodeFrame({ type: "sync_input_mode", mode, revision: rev }));
      }
    }
  }

  private enqueueSettingsFeedback(route: RouteEntry, generation: number, text: string, menu?: InboundResult["menu"], messageId?: number): void {
    // Only bounded settings actions from an authenticated Runtime can become buttons.
    if (menu && (!Array.isArray(menu) || menu.length > 12 || menu.some(row => !Array.isArray(row) || !row.length || row.length > 3 || row.some(button =>
      !button || typeof button.text !== "string" || !button.text.trim() || button.text.length > 128 ||
      typeof button.command !== "string" || button.command.length > 4096 || !/^\/(model|thinking|inputmode)(?:\s|$)/.test(button.command))))) {
      this.publishStatus({ ...this.status, feedbackError: { code: "INVALID_SETTINGS_MENU", message: "Runtime returned an invalid settings menu" } });
      return;
    }
    const client = this.client;
    const chatId = this.config.chatId;
    this.feedback.enqueue(async signal => {
      if (signal.aborted || !this.running || this.reloading || this.client !== client || this.routes.get(route.threadId) !== route || route.generation !== generation) return;
      const now = performance.now();
      for (const [id, existing] of this.menus) {
        if (now >= existing.expiresAt || ((menu || messageId !== undefined) && existing.route.threadId === route.threadId)) this.menus.delete(id);
      }
      // Ephemeral tokens never contain model identifiers and cannot outlive this Leader.
      const token = crypto.randomBytes(12).toString("hex");
      const state: SettingsMenu = { route, generation, expiresAt: now + 10 * 60_000, commands: [] };
      const replyMarkup = { inline_keyboard: (menu ?? []).map(row => row.map(button => {
        const index = state.commands.push(button.command) - 1;
        return { text: button.text, callback_data: `mux:${token}:${index}` };
      })) };
      if (menu) {
        while (this.menus.size >= 128) this.menus.delete(this.menus.keys().next().value!);
        this.menus.set(token, state);
      }
      try {
        if (messageId !== undefined) {
          try {
            await this.deliverFeedback(client, signal, route, generation, () => client.callApi("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup }, undefined, signal));
            state.messageId = messageId;
          } catch (error) {
            // A generic 400 definitively rejects this edit, but does not identify why.
            // Report it and send one plain-text failure notice, never infer deletion from wording,
            // retry a settings action, or reuse potentially invalid keyboard markup.
            if (!(error instanceof TelegramApiError) || error.errorCode !== 400) throw error;
            this.menus.delete(token);
            if (signal.aborted || !this.running || this.reloading || this.client !== client || this.routes.get(route.threadId) !== route || route.generation !== generation) return;
            this.publishStatus({ ...this.status, interactionError: {
              code: "TELEGRAM_MENU_REJECTED",
              message: "Telegram rejected a settings menu update (HTTP 400). The selection may already have completed.",
            } });
            await this.deliverFeedback(client, signal, route, generation, () => client.sendMessage(chatId,
              "The settings menu could not be updated (HTTP 400). The selection may already have completed. Send /model or /thinking to check.",
              { message_thread_id: route.threadId }, signal));
          }
        } else {
          const sent = await this.deliverFeedback(client, signal, route, generation, () => client.sendMessage(chatId, text, { message_thread_id: route.threadId, ...(menu ? { reply_markup: replyMarkup } : {}) }, signal));
          state.messageId = sent?.message_id;
        }
      } catch (error) {
        this.menus.delete(token);
        // Feedback jobs are independent. An uncertain reply/update ends only this
        // job, not the bot-wide queue; never retry it or the already executed action.
        if (isRecoverableTelegramError(error)) {
          if (!signal.aborted && this.running && !this.reloading && this.client === client) this.publishStatus({ ...this.status, interactionError: {
            code: this.describeError(error).code,
            message: `Telegram command feedback for topic ${route.threadId} could not be confirmed. It was not resent; later feedback can continue. Check Telegram and local Pi before repeating an action.`,
          } });
          return;
        }
        // Menu creation or its one failure notice can also be rejected. Contain generic 400s
        // to this interaction, report them explicitly, and leave unrelated feedback operational.
        if ((menu !== undefined || messageId !== undefined) && error instanceof TelegramApiError && error.errorCode === 400) {
          if (!signal.aborted && this.running && !this.reloading && this.client === client) this.publishStatus({ ...this.status, interactionError: {
            code: "TELEGRAM_MENU_REJECTED",
            message: "Telegram rejected a settings menu or its failure notice (HTTP 400). Open a new menu to check settings.",
          } });
          return;
        }
        throw error;
      }
    }, Buffer.byteLength(JSON.stringify({ text, menu }), "utf-8"));
  }

  /** Stop the old poller before applying validated configuration to every Runtime. */
  public reloadConfig(requester?: net.Socket): Promise<void> {
    if (this.reloading) return this.reloading;
    this.reloading = (async () => {
      const config = await loadConfig(this.agentDir);
      if (!config) throw new Error("Telegram configuration missing");
      const client = new TelegramClient({ botToken: config.botToken });
      // Notify every affected peer before aborting requests. end() flushes the
      // reset before EOF; a bounded drain deadline handles nonresponsive peers.
      for (const [socket, state] of this.connections) {
        if (socket === requester) continue;
        this.resetFollowerConnection(socket, state);
      }
      this.pollController?.abort();
      this.feedback.reset();
      this.client.abortAll("reload");
      this.settlePending();
      await this.pollingTask;
      if (!this.running) throw new Error("Coordinator stopped during configuration update");
      for (const threadId of this.routes.keys()) this.releaseRoute(threadId);
      this.menus.clear();
      // Authentication can finish while the old poller is draining. Reset those
      // peers too, before publishing the new configuration without another await.
      for (const [socket, state] of this.connections) {
        state.registration = undefined;
        if (socket !== requester) this.resetFollowerConnection(socket, state);
      }
      const sameToken = this.config.botToken === config.botToken;
      if (!sameToken) this.offset = undefined;
      // A mode save can finish while the old poller drains. For the same
      // connection, retain that newer commit instead of reinstalling the snapshot.
      if (configFingerprint(this.config, "connection") === configFingerprint(config, "connection") &&
          this.inputModeRevision > (config.inputModeRevision ?? 0)) {
        config.inputMode = this.config.inputMode;
        config.inputModeRevision = this.inputModeRevision;
      }
      this.config = config;
      this.inputModeRevision = config.inputModeRevision ?? 0;
      this.configuration = configFingerprint(config);
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = undefined;
      const remainingPause = this.client.getRemainingPauseMs();
      this.client.onRateLimit = undefined;
      this.client = client;
      this.client.onRateLimit = until => this.pauseForRateLimit(until);
      if (sameToken && remainingPause > 0) this.client.recordRateLimit(remainingPause / 1000);
      else this.status = { ...this.status, rateLimitUntil: undefined };
      this.botUsername = undefined;
      await this.options.onConfigChange?.(config);
      this.startPolling();
    })().finally(() => { this.reloading = null; this.options.onStatusChange?.(); });
    return this.reloading;
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    for (const album of this.albums.values()) album.finish();
    this.albums.clear();
    this.rejectedAlbums.clear();
    clearInterval(this.mediaCleanupTimer);
    clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = undefined;
    this.client.onRateLimit = undefined;
    this.pollController?.abort();
    this.feedback.reset();
    this.client.abortAll();
    this.settlePending();
    for (const [socket, state] of this.connections) { clearTimeout(state.authTimer); socket.destroy(); }
    for (const threadId of this.routes.keys()) this.releaseRoute(threadId);
    this.menus.clear();
    this.stopping = (async () => {
      await this.pollingTask;
      // File I/O cannot always be cancelled by the OS. Late input is fenced by running/signal checks;
      // it must not retain the IPC listener and leadership lock during shutdown or /reload.
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.all([...this.inputWork, this.mediaCleanupTask]).then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 250); }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) console.error("[pi-telegram-mux] MEDIA_SHUTDOWN_PENDING: cancelled media cleanup is still finishing in the background.");
      if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
      if (this.releaseLock) { await this.releaseLock(); this.releaseLock = undefined; }
    })();
    return this.stopping;
  }
}

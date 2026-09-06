import * as crypto from "node:crypto";
import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { configFingerprint, loadConfig } from "./config.js";
import { encodeFrame, FrameParser, tryAcquireLeaderLock } from "./ipc.js";
import { BoundedOutbox } from "./outbox.js";
import { ConflictError, isRecoverableTelegramError, RateLimitError, TelegramClient } from "./telegram.js";
import { IPC_PROTOCOL_VERSION, type InboundResult, type IpcMessage, type MuxConfig, type OutputTarget, type RuntimeRegistration, type TelegramUpdate, type TransportStatus } from "./types.js";

export interface RouteEntry extends OutputTarget {
  runtimeId: string;
  dispatchInbound: (text: string, messageId: number) => Promise<InboundResult>;
  abortRun?: () => boolean | void | Promise<boolean | void>;
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
  private capability = "";
  private configuration: string;
  private epoch = 0;
  private offset?: number;
  private botUsername?: string;
  private status: TransportStatus = { polling: "starting" };
  public readonly feedback: BoundedOutbox;
  private pollController: AbortController | null = null;
  private pollingTask: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private reloading: Promise<void> | null = null;
  private readonly routes = new Map<number, RouteEntry>();
  private readonly routeOwners = new Map<number, net.Socket>();
  private readonly connections = new Map<net.Socket, FollowerConnection>();
  private readonly pending = new Map<string, { socket: net.Socket; resolve: (value: InboundResult | boolean) => void; timer: NodeJS.Timeout; kind: "inbound" | "abort" }>();

  constructor(private config: MuxConfig, private readonly agentDir: string, client?: TelegramClient, private readonly options: CoordinatorOptions = {}) {
    this.client = client ?? new TelegramClient({ botToken: config.botToken });
    this.configuration = configFingerprint(config);
    this.feedback = new BoundedOutbox(error => this.publishStatus({ ...this.status, feedbackError: this.describeError(error) }));
  }

  public getTelegramClient(): TelegramClient { return this.client; }
  public getStatus(): TransportStatus { return this.status; }
  public isConflict(): boolean { return this.status.polling === "conflict"; }
  // Poll failure does not release the Leader lock or IPC listener.
  public isRunning(): boolean { return this.running; }

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
    if (existing?.sessionId === route.sessionId) {
      // Preserve lease identity for ordinary registration refreshes. Queued
      // feedback also checks generation to reject navigation/configuration changes.
      Object.assign(existing, route);
      return true;
    }
    // A Runtime can own only one Topic, including when it explicitly rebinds.
    for (const [threadId, current] of this.routes) {
      if (current.runtimeId === route.runtimeId && this.routeOwners.get(threadId) === socket) {
        this.routes.delete(threadId);
        this.routeOwners.delete(threadId);
      }
    }
    this.routes.set(route.threadId, route);
    if (socket) this.routeOwners.set(route.threadId, socket);
    return true;
  }

  public unregisterLocalRoute(threadId: number, runtimeId: string): void {
    if (this.routes.get(threadId)?.runtimeId === runtimeId && !this.routeOwners.has(threadId)) this.routes.delete(threadId);
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
      const result = await tryAcquireLeaderLock(this.agentDir, port);
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

  private removeSocketRoutes(socket: net.Socket): void {
    for (const [threadId, owner] of this.routeOwners) {
      if (owner === socket) {
        this.routes.delete(threadId);
        this.routeOwners.delete(threadId);
      }
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
      socket.write(encodeFrame({ type: "auth_ack", protocolVersion: IPC_PROTOCOL_VERSION, epoch: this.epoch, configFingerprint: this.configuration, status: this.status }));
      return;
    }

    if (msg.type === "inbound_ack" || msg.type === "abort_ack") {
      const pending = this.pending.get(msg.requestId);
      if (pending?.socket === socket && (msg.type === "inbound_ack" ? pending.kind === "inbound" : pending.kind === "abort")) {
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        pending.resolve(msg.type === "abort_ack" ? msg.ok === true : {
          accepted: msg.accepted === true,
          busy: msg.busy === true,
          statusReply: typeof msg.statusReply === "string" ? msg.statusReply.slice(0, 4096) : undefined,
        });
      }
      return;
    }
    if (msg.type === "ping") { socket.write(encodeFrame({ type: "pong" })); return; }
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
            dispatchInbound: (text, messageId) => this.requestFollower(socket, { type: "inbound", requestId: "", messageId, target, fromId: this.config.allowedUserId, text }) as Promise<InboundResult>,
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
          if (!socket.destroyed && !socket.writableEnded) socket.write(encodeFrame({ type: "call_telegram_ack", callId: msg.callId, ok: false, error: err instanceof Error ? err.message : "IPC request failed" }));
        }
      } else throw new Error("Unexpected IPC message");
    } finally {
      if (controller && "callId" in msg && msg.callId) state.calls.delete(msg.callId);
    }
  }

  private requestFollower(socket: net.Socket, msg: Extract<IpcMessage, { type: "inbound" | "abort" }>): Promise<InboundResult | boolean> {
    const unavailable = msg.type === "abort" ? false : { accepted: false, busy: false, statusReply: "Execution result unknown. Please check local session; do not resend automatically." };
    if (socket.destroyed || socket.writableEnded || this.pending.size >= 128) return Promise.resolve(unavailable);
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(unavailable); socket.destroy(); }, this.options.requestTimeoutMs ?? 5000);
      this.pending.set(requestId, { socket, resolve, timer, kind: msg.type });
      socket.write(encodeFrame({ ...msg, requestId }));
    });
  }

  private settlePending(socket?: net.Socket): void {
    for (const [id, pending] of this.pending) {
      if (!socket || pending.socket === socket) {
        clearTimeout(pending.timer);
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
    } else if (method !== "createForumTopic" || typeof params.name !== "string" || !params.name.trim() || params.name.length > 128) {
      throw new Error("Unsupported Telegram request");
    }
    return this.client.callApi<T>(method, params, undefined, signal);
  }

  private startPolling(): void {
    const controller = new AbortController();
    this.pollController = controller;
    this.publishStatus({ polling: "starting" });
    this.pollingTask = this.poll(controller.signal).catch(error => {
      // Poll supervisor boundary: shutdown/reload cancellation is expected. Every
      // other failure becomes a persistent, broadcast error state; no silent retry.
      if (controller.signal.aborted) return;
      this.publishStatus({ ...this.status, polling: error instanceof ConflictError ? "conflict" : "error", error: this.describeError(error) });
    });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        if (this.client.isRateLimited()) {
          await delay(Math.min(this.client.getRemainingPauseMs() + 100, 5000), undefined, { signal });
          continue;
        }
        if (!this.botUsername) this.botUsername = (await this.client.getMe(signal)).username!.toLowerCase();
        const updates = await this.client.getUpdates({ offset: this.offset, limit: 100, timeout: 25, allowed_updates: ["message"], signal });
        if (signal.aborted || !this.running) return;
        if (this.status.polling !== "online") this.publishStatus({ ...this.status, polling: "online", error: undefined });
        for (const update of updates) {
          if (signal.aborted || !this.running) return;
          this.offset = update.update_id + 1;
          await this.processUpdate(update);
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
    const msg = update.message;
    if (!this.running || this.reloading || !msg || msg.chat.id !== this.config.chatId || msg.message_thread_id === undefined ||
        msg.from?.id !== this.config.allowedUserId || msg.from.is_bot || typeof msg.text !== "string" || !msg.text.trim() || msg.text.length > 4096) return;
    const route = this.routes.get(msg.message_thread_id);
    if (!route) return;
    const text = msg.text.trim();
    const command = /^\/([a-z\d_]+)(?:@([a-z\d_]+))?(?:\s|$)/i.exec(text);
    if (command?.[2] && command[2].toLowerCase() !== this.botUsername) return;
    const name = command?.[1].toLowerCase();
    const client = this.client;
    const chatId = this.config.chatId;
    const generation = route.generation;
    let reply: string | undefined;
    try {
      if (name === "status") reply = `Topic: Online\nSession: ${route.sessionId.slice(-6)}\nRoute: Active`;
      else if (name === "stop") {
        const stopped = route.abortRun ? (await route.abortRun()) !== false : false;
        reply = stopped ? "Abort signal sent." : "Could not confirm abort; please check local session.";
      } else {
        const result = await route.dispatchInbound(text, update.update_id);
        reply = result.busy ? "Current session is busy. Please try again later." : result.statusReply;
      }
    } catch (error) {
      // Inbound dispatch boundary: execution may already have started. Return an
      // explicit unknown result, expose the failure, and never resubmit the input.
      this.publishStatus({ ...this.status, feedbackError: this.describeError(error) });
      reply = "Execution result unknown. Please check local Pi errors; do not resend automatically.";
    }
    if (reply) {
      const feedback = reply;
      this.feedback.enqueue(async signal => {
        if (signal.aborted || !this.running || this.reloading || this.client !== client || this.routes.get(route.threadId) !== route || route.generation !== generation) return;
        await client.sendMessage(chatId, feedback, { message_thread_id: route.threadId }, signal);
      }, Buffer.byteLength(feedback, "utf-8"));
    }
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
      this.client.abortAll();
      this.settlePending();
      await this.pollingTask;
      if (!this.running) throw new Error("Coordinator stopped during configuration update");
      this.routes.clear();
      this.routeOwners.clear();
      // Authentication can finish while the old poller is draining. Reset those
      // peers too, before publishing the new configuration without another await.
      for (const [socket, state] of this.connections) {
        state.registration = undefined;
        if (socket !== requester) this.resetFollowerConnection(socket, state);
      }
      if (this.config.botToken !== config.botToken) this.offset = undefined;
      this.config = config;
      this.configuration = configFingerprint(config);
      this.client = client;
      this.botUsername = undefined;
      await this.options.onConfigChange?.(config);
      this.startPolling();
    })().finally(() => { this.reloading = null; this.options.onStatusChange?.(); });
    return this.reloading;
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.pollController?.abort();
    this.feedback.reset();
    this.client.abortAll();
    this.settlePending();
    for (const [socket, state] of this.connections) { clearTimeout(state.authTimer); socket.destroy(); }
    this.routes.clear();
    this.routeOwners.clear();
    this.stopping = (async () => {
      await this.pollingTask;
      if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
      if (this.releaseLock) { await this.releaseLock(); this.releaseLock = undefined; }
    })();
    return this.stopping;
  }
}

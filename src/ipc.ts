import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getRuntimeDir, replaceFile } from "./config.js";
import { IPC_PROTOCOL_VERSION, type InboundResult, type IpcMessage, type LeaderLockData, type OutputTarget, type RuntimeRegistration, type TransportStatus } from "./types.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const LOCK_FILE_NAME = "leader.json";

export class IpcError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "IpcError"; }
}

/**
 * Lamport's bakery mutex for the short metadata transaction. An empty claim means
 * "choosing a ticket". Unique PID/nonce filenames allow dead-process reclamation
 * without ever deleting a successor's claim. Live claims NEVER expire: a paused
 * process may delay election, but cannot resume into somebody else's critical section.
 */
async function acquireElectionMutex(runtimeDir: string): Promise<() => Promise<void>> {
  const dir = path.join(runtimeDir, "election");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${crypto.randomUUID()}.json`;
  const claim = path.join(dir, id);
  const temporary = `${claim}.tmp`;
  await fs.writeFile(claim, "", { flag: "wx", mode: 0o600 });
  try {
    let highest = 0;
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ticket = Number(await fs.readFile(path.join(dir, file), "utf-8"));
        if (Number.isSafeInteger(ticket) && ticket > highest) highest = ticket;
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
    const ticket = highest + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("Election ticket overflow");
    await fs.writeFile(temporary, String(ticket), { flag: "wx", mode: 0o600 });
    await replaceFile(temporary, claim);
    const deadline = Date.now() + 10_000;
    for (;;) {
      let wait = false;
      for (const file of await fs.readdir(dir)) {
        if (file === id || !/^\d+-[\da-f-]+\.json$/.test(file)) continue;
        const otherPath = path.join(dir, file);
        const pid = Number(file.slice(0, file.indexOf("-")));
        if (!isProcessAlive(pid)) {
          await fs.rm(otherPath, { force: true });
          await fs.rm(`${otherPath}.tmp`, { force: true });
          continue;
        }
        try {
          const other = Number(await fs.readFile(otherPath, "utf-8"));
          if (!Number.isSafeInteger(other) || other <= 0 || other < ticket || (other === ticket && file < id)) wait = true;
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      }
      if (!wait) break;
      if (Date.now() >= deadline) throw new IpcError("IPC_ELECTION_BUSY", "Leader election is waiting for a live process; retry later");
      await delay(25);
    }
    return () => fs.rm(claim, { force: true });
  } catch (err) {
    await fs.rm(claim, { force: true });
    throw err;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function encodeFrame(message: IpcMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf-8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("IPC frame exceeded maximum size");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Each socket must have exactly one parser and one data listener. */
export class FrameParser {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer): IpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: IpcMessage[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error("Invalid IPC frame size");
      if (this.buffer.length < 4 + length) break;
      const message: unknown = JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf-8"));
      this.buffer = this.buffer.subarray(4 + length);
      if (!message || typeof message !== "object" || !("type" in message) || typeof message.type !== "string") {
        throw new Error("Invalid IPC message");
      }
      messages.push(message as IpcMessage);
      if (messages.length > 1024) throw new Error("Too many IPC frames in one batch");
    }
    return messages;
  }
}

export interface AcquireLeaderLockResult {
  acquired: boolean;
  lockData: LeaderLockData;
  releaseLock?: () => Promise<void>;
}

/**
 * Serialize publication, dead-PID reclamation and release under the same mutex.
 * A live but unresponsive PID is never evicted. The port must already be listening.
 */
export async function tryAcquireLeaderLock(agentDir: string, port: number, epoch = Date.now()): Promise<AcquireLeaderLockResult> {
  const runtimeDir = getRuntimeDir(agentDir);
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const canonicalDir = await fs.realpath(runtimeDir);
  const lockPath = path.join(canonicalDir, LOCK_FILE_NAME);
  const unlock = await acquireElectionMutex(canonicalDir);
  const lockData: LeaderLockData = { pid: process.pid, port, capability: crypto.randomBytes(24).toString("hex"), epoch, createdAt: Date.now() };
  try {
    for (const file of fsSync.readdirSync(canonicalDir)) {
      const match = /^leader\.json\.(\d+)\.[\da-f]+\.tmp$/.exec(file);
      if (match && !isProcessAlive(Number(match[1]))) fsSync.rmSync(path.join(canonicalDir, file), { force: true });
    }
    if (fsSync.existsSync(lockPath)) {
      const existing = JSON.parse(fsSync.readFileSync(lockPath, "utf-8")) as LeaderLockData;
      if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0 ||
          !Number.isInteger(existing.port) || existing.port <= 0 || existing.port > 65535 ||
          typeof existing.capability !== "string" || !existing.capability) {
        throw new Error("Invalid Leader lock; remove it only after all mux processes have exited");
      }
      if (isProcessAlive(existing.pid)) return { acquired: false, lockData: existing };
    }
    // Publish complete metadata atomically; a crash leaves the old record or none.
    const temporaryPath = `${lockPath}.${process.pid}.${lockData.capability}.tmp`;
    try {
      fsSync.writeFileSync(temporaryPath, JSON.stringify(lockData), { mode: 0o600, flag: "wx" });
      fsSync.renameSync(temporaryPath, lockPath);
    } finally {
      fsSync.rmSync(temporaryPath, { force: true });
    }
  } finally {
    await unlock();
  }

  return {
    acquired: true,
    lockData,
    releaseLock: async () => {
      const release = await acquireElectionMutex(canonicalDir);
      try {
        if (fsSync.existsSync(lockPath)) {
          const existing = JSON.parse(fsSync.readFileSync(lockPath, "utf-8")) as LeaderLockData;
          if (existing.capability === lockData.capability && existing.pid === process.pid) fsSync.unlinkSync(lockPath);
        }
      } finally {
        await release();
      }
    },
  };
}

export async function testLeaderConnection(port: number, capability: string): Promise<boolean> {
  const client = new IpcFollowerClient(port, capability, "probe");
  try {
    await client.connect(1000);
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/** Authenticated, bounded RPC client. Closing intentionally never schedules reconnect. */
export class IpcFollowerClient {
  private socket: net.Socket | null = null;
  private connected = false;
  private configuration = "";
  private status: TransportStatus = { polling: "starting" };
  private onStatusHandler?: () => void;

  public getStatus(): TransportStatus { return this.status; }
  public setStatusHandler(handler: () => void): void { this.onStatusHandler = handler; }
  public getConfigFingerprint(): string { return this.configuration; }

  private updateStatus(status: TransportStatus): void {
    if (!status || !["starting", "online", "retrying", "error", "conflict"].includes(status.polling) ||
        [status.error, status.feedbackError].some(error => error !== undefined && (!error || typeof error.code !== "string" || typeof error.message !== "string"))) {
      throw new Error("Invalid IPC transport status");
    }
    this.status = status;
    this.onStatusHandler?.();
  }
  private closed = false;
  private readonly pendingCalls = new Map<string, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();
  private onInboundHandler?: (msg: Extract<IpcMessage, { type: "inbound" }>) => Promise<InboundResult>;
  private onAbortHandler?: (target: OutputTarget) => boolean | Promise<boolean>;
  private onDisconnectHandler?: (reason?: IpcError) => void;

  constructor(private readonly port: number, private readonly capability: string, private readonly runtimeId: string) {}

  public setInboundHandler(handler: NonNullable<IpcFollowerClient["onInboundHandler"]>): void { this.onInboundHandler = handler; }
  public setAbortHandler(handler: NonNullable<IpcFollowerClient["onAbortHandler"]>): void { this.onAbortHandler = handler; }
  public setDisconnectHandler(handler: (reason?: IpcError) => void): void { this.onDisconnectHandler = handler; }

  public async connect(timeoutMs = 5000): Promise<number> {
    if (this.closed || this.socket) throw new Error("IPC client cannot be reused");
    return new Promise((resolve, reject) => {
      const parser = new FrameParser();
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      this.socket = socket;
      const timeout = setTimeout(() => { reject(new IpcError("IPC_TIMEOUT", "IPC connection timeout")); socket.destroy(); }, timeoutMs);
      socket.on("connect", () => socket.write(encodeFrame({ type: "auth", protocolVersion: IPC_PROTOCOL_VERSION, capability: this.capability, runtimeId: this.runtimeId })));
      socket.on("data", (chunk) => {
        try {
          for (const msg of parser.push(chunk)) {
            if (msg.type === "auth_ack") {
              if (msg.protocolVersion !== IPC_PROTOCOL_VERSION) throw new Error("Incompatible IPC protocol; restart all mux processes");
              clearTimeout(timeout);
              this.connected = true;
              this.configuration = msg.configFingerprint;
              this.updateStatus(msg.status);
              resolve(msg.epoch);
            } else if (!this.connected) {
              throw new Error("IPC message before authentication");
            } else if (msg.type === "transport_status") {
              this.updateStatus(msg.status);
            } else if (msg.type === "transport_reset") {
              // Authenticated reset boundary: invalidate dependent work before
              // socket-close rejection can make intentional cancellation a failure.
              this.connected = false;
              this.onDisconnectHandler?.(new IpcError("IPC_TRANSPORT_RESET", "Leader is resetting the transport"));
              socket.destroy();
              break;
            } else if (msg.type === "call_telegram_ack" || msg.type === "register_ack") {
              const pending = msg.callId ? this.pendingCalls.get(msg.callId) : undefined;
              if (pending && msg.callId) {
                if (msg.ok) pending.resolve(msg.type === "call_telegram_ack" ? msg.result : undefined);
                else pending.reject(new Error(msg.error ?? "IPC request rejected"));
              }
            } else if (msg.type === "inbound" || msg.type === "abort") {
              // Do not block parsing later acknowledgements while Pi handles an input.
              void this.handleRequest(msg, socket).catch(() => socket.destroy());
            } else if (msg.type === "ping") {
              socket.write(encodeFrame({ type: "pong" }));
            }
          }
        } catch (err) {
          // Protocol boundary: malformed frames fail authentication or expose a
          // terminal status before closing an already authenticated connection.
          if (this.connected) this.updateStatus({ polling: "error", error: { code: "IPC_PROTOCOL_ERROR", message: "Invalid IPC response; restart all mux processes" } });
          reject(err);
          socket.destroy();
        }
      });
      socket.on("error", (err) => { reject(err); socket.destroy(); });
      socket.on("close", () => {
        clearTimeout(timeout);
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        reject(new IpcError("IPC_CLOSED", "IPC socket closed before authentication"));
        for (const pending of this.pendingCalls.values()) {
          pending.reject(new IpcError("IPC_CLOSED", "IPC socket closed"));
        }
        this.pendingCalls.clear();
        if (!this.closed && wasConnected) this.onDisconnectHandler?.();
      });
    });
  }

  private async handleRequest(msg: Extract<IpcMessage, { type: "inbound" | "abort" }>, socket: net.Socket): Promise<void> {
    let reply: IpcMessage;
    try {
      if (msg.type === "inbound") {
        const result = await this.onInboundHandler?.(msg) ?? { accepted: false, busy: true };
        reply = { type: "inbound_ack", requestId: msg.requestId, ...result };
      } else {
        reply = { type: "abort_ack", requestId: msg.requestId, ok: await this.onAbortHandler?.(msg.target) ?? false };
      }
    } catch {
      // Pi request boundary: a thrown handler has an unknown outcome, not a busy
      // rejection. Send an explicit safe failure without exposing private details.
      reply = msg.type === "inbound"
        ? { type: "inbound_ack", requestId: msg.requestId, accepted: false, busy: false, statusReply: "Execution result unknown. Please check local Pi errors; do not resend automatically." }
        : { type: "abort_ack", requestId: msg.requestId, ok: false };
    }
    if (!this.closed && !socket.destroyed) socket.write(encodeFrame(reply));
  }

  public send(msg: IpcMessage): void {
    if (!this.isConnected()) throw new IpcError("IPC_CLOSED", "IPC socket not connected");
    this.socket!.write(encodeFrame(msg));
  }

  /** Correlate every RPC through the single socket parser, with bounded cleanup. */
  private request<T>(message: Extract<IpcMessage, { type: "register" | "call_telegram" | "reload_config" }>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pendingCalls.size >= 128) return Promise.reject(new Error("Too many pending IPC calls"));
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancelRemote = () => {
        if ((message.type === "call_telegram" || message.type === "register") && this.isConnected()) this.send({ type: "cancel_telegram", callId });
      };
      const aborted = () => { cancelRemote(); this.pendingCalls.get(callId)?.reject(signal!.reason); };
      const timer = setTimeout(() => {
        cancelRemote();
        this.pendingCalls.get(callId)?.reject(new IpcError("IPC_TIMEOUT", "IPC request timed out; result unknown"));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); this.pendingCalls.delete(callId); };
      this.pendingCalls.set(callId, {
        resolve: value => { cleanup(); resolve(value as T); },
        reject: error => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", aborted, { once: true });
      try { this.send({ ...message, callId }); }
      catch (err) {
        // RPC boundary: failed writes reject the caller and release its reservation.
        this.pendingCalls.get(callId)?.reject(err);
      }
    });
  }

  public register(registration: RuntimeRegistration, signal?: AbortSignal): Promise<void> {
    return this.request({ type: "register", registration }, 5000, signal);
  }

  public reloadConfig(): Promise<void> {
    return this.request({ type: "reload_config", callId: "" }, 10_000);
  }

  public callTelegram<T>(method: string, params: Record<string, unknown>, target?: OutputTarget, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    return this.request({ type: "call_telegram", callId: "", method, params, target }, timeoutMs, signal);
  }

  public isConnected(): boolean { return !this.closed && this.connected && this.socket !== null && !this.socket.destroyed; }

  public close(): void {
    this.closed = true;
    this.connected = false;
    this.socket?.destroy();
  }
}

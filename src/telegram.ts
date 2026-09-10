import type {
  TelegramApiResponse,
  TelegramChat,
  TelegramChatMember,
  TelegramFile,
  TelegramForumTopic,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB
const RELOAD_ABORT = Symbol("Telegram configuration reload");
const REQUEST_TIMEOUT = Symbol("Telegram request timeout");

async function readDownloadBody(response: Response, maxBytes: number, controller: AbortController): Promise<Buffer> {
  if (!response.body) throw new TelegramDecodeError("Empty Telegram download body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        throw new TelegramDecodeError("Telegram response size exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export class TelegramApiError extends Error {
  readonly code: string;
  readonly errorCode?: number;
  readonly retryAfter?: number;

  constructor(message: string, errorCode?: number, retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.code = errorCode === undefined ? "TELEGRAM_API_ERROR" : `TELEGRAM_HTTP_${errorCode}`;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

export class RateLimitError extends TelegramApiError {
  constructor(retryAfterSeconds: number) {
    super(`Telegram rate limit: 429 Too Many Requests. Retry after ${retryAfterSeconds}s`, 429, retryAfterSeconds);
    this.name = "RateLimitError";
  }
}

/** The request never reached HTTP. Keep the stable IPC code for pre-dispatch pauses. */
export class CleanupPauseError extends RateLimitError {
  override readonly code = "TELEGRAM_CLEANUP_PAUSED";
}

export class ConflictError extends TelegramApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class TelegramDecodeError extends Error {
  readonly code = "TELEGRAM_DECODE_ERROR";
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = "TelegramDecodeError"; }
}

export class TelegramRequestError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) { super(message, { cause }); this.name = "TelegramRequestError"; }
}

const TRANSIENT_NETWORK_CODES = new Set(["TELEGRAM_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

/** Retry polling only for known transport failures, rate limits, and temporary HTTP errors. */
export function isRecoverableTelegramError(error: unknown): boolean {
  return error instanceof RateLimitError ||
    (error instanceof TelegramApiError && error.errorCode !== undefined && (error.errorCode === 408 || (error.errorCode >= 500 && error.errorCode <= 599))) ||
    (error instanceof TelegramRequestError && TRANSIENT_NETWORK_CODES.has(error.code));
}

export interface TelegramClientOptions {
  botToken: string;
  apiBase?: string;
  defaultTimeoutMs?: number;
}

export class TelegramClient {
  private readonly botToken: string;
  private readonly apiBase: string;
  private readonly defaultTimeoutMs: number;
  private pauseUntilMs = 0;
  public onRateLimit?: (until: number) => void;
  private readonly requests = new Set<AbortController>();

  public abortAll(reason?: "reload"): void {
    for (const controller of this.requests) controller.abort(reason === "reload" ? RELOAD_ABORT : undefined);
  }

  constructor(options: TelegramClientOptions) {
    this.botToken = options.botToken;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Redact the bot token from any string (URL, error message, etc.).
   */
  public redact(text: string): string {
    if (!this.botToken) {
      return text;
    }
    return text.replaceAll(this.botToken, "<redacted>");
  }

  /**
   * Check if client is currently in a 429 pause.
   */
  public isRateLimited(): boolean {
    return Date.now() < this.pauseUntilMs;
  }

  /**
   * Get remaining rate-limit pause in milliseconds.
   */
  public getRemainingPauseMs(): number {
    return Math.max(0, this.pauseUntilMs - Date.now());
  }

  /**
   * Manually record a 429 retry_after deadline in memory.
   */
  public recordRateLimit(retryAfterSeconds: number): void {
    const deadline = Date.now() + Math.max(1, retryAfterSeconds) * 1000;
    this.pauseUntilMs = Math.max(this.pauseUntilMs, deadline);
    this.onRateLimit?.(this.pauseUntilMs);
  }

  /**
   * Call a Telegram Bot API method.
   */
  public async callApi<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: { ignoreRateLimit?: boolean }
  ): Promise<T> {
    if (this.isRateLimited() && !options?.ignoreRateLimit) {
      const waitSec = Math.ceil(this.getRemainingPauseMs() / 1000);
      throw new CleanupPauseError(waitSec);
    }

    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    this.requests.add(controller);
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(REQUEST_TIMEOUT), timeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: params ? JSON.stringify(params) : undefined,
        signal: requestSignal,
        redirect: "error",
      });

      // Check response size
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new TelegramDecodeError(`Telegram response size exceeded limit: ${contentLength} bytes`);
      }

      const rawText = await response.text();
      if (rawText.length > MAX_RESPONSE_BYTES) {
        throw new TelegramDecodeError(`Telegram response text exceeded limit: ${rawText.length} bytes`);
      }

      // Gateways can return HTML or an empty body for temporary HTTP failures.
      // Their status remains retryable regardless of the API envelope format.
      if (response.status === 408 || (response.status >= 500 && response.status <= 599)) {
        throw new TelegramApiError(`HTTP ${response.status}`, response.status);
      }

      let parsed: TelegramApiResponse<T>;
      try {
        parsed = JSON.parse(rawText) as TelegramApiResponse<T>;
      } catch (cause) {
        // Decoding boundary: preserve the cause, expose a stable fatal code and do
        // not include the potentially sensitive response body in the public error.
        throw new TelegramDecodeError(`Invalid JSON from Telegram: HTTP ${response.status}`, cause);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.ok !== "boolean" ||
          (parsed.ok && !("result" in parsed)) || (parsed.error_code !== undefined && !Number.isSafeInteger(parsed.error_code))) {
        throw new TelegramDecodeError("Invalid Telegram API response envelope");
      }
      const errorCode = parsed.error_code ?? response.status;
      if ((!response.ok || !parsed.ok) && errorCode === 429) {
        // Telegram permits omitted response parameters; use a conservative 5s pause.
        const retryAfter = parsed.parameters?.retry_after ?? 5;
        if (!Number.isSafeInteger(retryAfter) || retryAfter <= 0) throw new TelegramDecodeError("Invalid Telegram retry_after");
        if (!options?.ignoreRateLimit) {
          this.recordRateLimit(retryAfter);
        }
        throw new RateLimitError(retryAfter);
      }

      if ((!response.ok || !parsed.ok) && errorCode === 409) {
        throw new ConflictError(this.redact(parsed.description ?? "Conflict (409)"));
      }

      if (!response.ok || !parsed.ok) {
        const desc = parsed.description ? this.redact(parsed.description) : `HTTP ${response.status}`;
        throw new TelegramApiError(desc, parsed.error_code ?? response.status, parsed.parameters?.retry_after);
      }

      return parsed.result as T;
    } catch (err: unknown) {
      if (err instanceof TelegramApiError || err instanceof TelegramDecodeError) throw err;
      // HTTP boundary: normalize fetch/timeout failures using identifiers, not
      // message text. Unclassified errors remain fatal to the polling supervisor.
      const failure = err as { code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
      const identifier = failure?.cause?.code ?? failure?.code;
      // The combined signal retains the first cancellation cause, even if another
      // cancellation source fires before fetch finishes unwinding.
      const timedOut = requestSignal.aborted && requestSignal.reason === REQUEST_TIMEOUT;
      const code = timedOut ? "TELEGRAM_TIMEOUT" : requestSignal.aborted ? requestSignal.reason === RELOAD_ABORT ? "TELEGRAM_RELOADING" : "TELEGRAM_ABORTED"
        : typeof identifier === "string" ? identifier : "TELEGRAM_REQUEST_FAILED";
      let detail: string;
      if (timedOut) {
        detail = "request timed out";
      } else if (code === "ECONNRESET") {
        detail = "connection reset";
      } else if (code === "ECONNREFUSED") {
        detail = "connection refused";
      } else if (code === "ETIMEDOUT") {
        detail = "connection timed out";
      } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        detail = "network unreachable";
      } else if (code === "TELEGRAM_ABORTED") {
        detail = "request aborted";
      } else if (code === "TELEGRAM_RELOADING") {
        detail = "request cancelled for configuration reload";
      } else {
        const raw = typeof failure?.cause?.message === "string" ? failure.cause.message
          : err instanceof Error ? err.message : String(err);
        detail = this.redact(raw);
      }
      const message = timedOut || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "TELEGRAM_ABORTED" || code === "TELEGRAM_RELOADING"
        ? `Telegram ${detail} (${method})`
        : `Telegram request failed (${method}): ${detail}`;
      throw new TelegramRequestError(code, message, err);
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  public async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    const me = await this.callApi<TelegramUser>("getMe", undefined, undefined, signal);
    if (!me || !Number.isSafeInteger(me.id) || me.is_bot !== true || typeof me.username !== "string" || !/^[a-z\d_]+$/i.test(me.username)) {
      throw new TelegramDecodeError("Invalid Telegram getMe result");
    }
    return me;
  }

  public async getChat(chatId: number): Promise<TelegramChat> {
    return this.callApi<TelegramChat>("getChat", { chat_id: chatId });
  }

  public async getChatMember(chatId: number, userId: number): Promise<TelegramChatMember> {
    return this.callApi<TelegramChatMember>("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
  }

  public async createForumTopic(chatId: number, name: string): Promise<TelegramForumTopic> {
    return this.callApi<TelegramForumTopic>("createForumTopic", {
      chat_id: chatId,
      name,
    });
  }

  public async closeForumTopic(
    chatId: number,
    messageThreadId: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.callApi<boolean>(
      "closeForumTopic",
      { chat_id: chatId, message_thread_id: messageThreadId },
      undefined,
      signal
    );
  }

  public async reopenForumTopic(
    chatId: number,
    messageThreadId: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.callApi<boolean>(
      "reopenForumTopic",
      { chat_id: chatId, message_thread_id: messageThreadId },
      undefined,
      signal
    );
  }

  public async sendMessage(
    chatId: number,
    text: string,
    options?: { message_thread_id?: number; reply_markup?: TelegramInlineKeyboardMarkup; disable_notification?: boolean },
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options?.message_thread_id) {
      params.message_thread_id = options.message_thread_id;
    }
    if (options?.reply_markup) params.reply_markup = options.reply_markup;
    if (options?.disable_notification !== undefined) params.disable_notification = options.disable_notification;
    return this.callApi<TelegramMessage>("sendMessage", params, undefined, signal);
  }

  public async deleteMessage(
    chatId: number,
    messageId: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
    };
    return this.callApi<boolean>("deleteMessage", params, undefined, signal);
  }

  public async setMessageReaction(
    chatId: number,
    messageId: number,
    reaction?: Array<{ type: "emoji"; emoji: string }>,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.isRateLimited()) {
      return false;
    }
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      reaction: reaction ?? [],
    };
    try {
      return await this.callApi<boolean>("setMessageReaction", params, undefined, signal, { ignoreRateLimit: true });
    } catch {
      return false;
    }
  }

  public async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    const file = await this.callApi<TelegramFile>("getFile", { file_id: fileId }, undefined, signal);
    if (!file || typeof file !== "object" || typeof file.file_id !== "string") {
      throw new TelegramDecodeError("Invalid Telegram getFile result");
    }
    return file;
  }

  public async downloadFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    if (this.isRateLimited()) {
      const waitSec = Math.ceil(this.getRemainingPauseMs() / 1000);
      throw new RateLimitError(waitSec);
    }

    if (!/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(filePath) || filePath.split("/").some(part => part === ".." || !part)) {
      throw new TelegramDecodeError("Invalid Telegram file path");
    }
    const url = `${this.apiBase}/file/bot${this.botToken}/${filePath}`;
    const timeout = this.defaultTimeoutMs;

    const controller = new AbortController();
    this.requests.add(controller);
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(REQUEST_TIMEOUT), timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: requestSignal,
        redirect: "error",
      });

      if (response.status === 408 || (response.status >= 500 && response.status <= 599)) {
        throw new TelegramApiError(`HTTP ${response.status}`, response.status);
      }

      if (response.status === 429) {
        // Record a conservative floor even if the server's error body is malformed.
        this.recordRateLimit(5);
        let retryAfter = 5;
        const header = response.headers.get("retry-after");
        if (header) {
          const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
          if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new TelegramDecodeError("Invalid download Retry-After");
          retryAfter = Math.max(retryAfter, seconds);
          this.recordRateLimit(retryAfter);
        }
        if (response.headers.get("content-type")?.includes("application/json")) {
          const body = (await readDownloadBody(response, 8192, controller)).toString("utf8");
          let error: unknown;
          try { error = JSON.parse(body); }
          catch (cause) {
            // Decoding boundary: SyntaxError excerpts can contain private response
            // data. Propagate a body-free fatal error, never a parsed fallback.
            if (!(cause instanceof SyntaxError)) throw cause;
            throw new TelegramDecodeError(`Invalid JSON from Telegram download: HTTP ${response.status}`);
          }
          if (!error || typeof error !== "object" || !("ok" in error) || error.ok !== false) throw new TelegramDecodeError("Invalid download error envelope");
          const parameters = "parameters" in error ? error.parameters : undefined;
          if (parameters !== undefined) {
            if (!parameters || typeof parameters !== "object" || !("retry_after" in parameters) ||
                !Number.isSafeInteger(parameters.retry_after) || (parameters.retry_after as number) <= 0) throw new TelegramDecodeError("Invalid download retry_after");
            retryAfter = Math.max(retryAfter, parameters.retry_after as number);
            this.recordRateLimit(retryAfter);
          }
        }
        throw new RateLimitError(retryAfter);
      }

      if (!response.ok) {
        throw new TelegramApiError(`Download failed with HTTP ${response.status}`, response.status);
      }

      // File-size acceptance belongs to Telegram and the selected model, not the mux.
      if (!response.body) throw new TelegramDecodeError("Empty Telegram download body");
      return Buffer.from(await response.arrayBuffer());
    } catch (err: unknown) {
      if (err instanceof TelegramApiError || err instanceof TelegramDecodeError) throw err;
      const failure = err as { code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
      const identifier = failure?.cause?.code ?? failure?.code;
      const timedOut = requestSignal.aborted && requestSignal.reason === REQUEST_TIMEOUT;
      const code = timedOut ? "TELEGRAM_TIMEOUT" : requestSignal.aborted ? requestSignal.reason === RELOAD_ABORT ? "TELEGRAM_RELOADING" : "TELEGRAM_ABORTED"
        : typeof identifier === "string" ? identifier : "TELEGRAM_REQUEST_FAILED";
      let detail: string;
      if (timedOut) {
        detail = "request timed out";
      } else if (code === "ECONNRESET") {
        detail = "connection reset";
      } else if (code === "ECONNREFUSED") {
        detail = "connection refused";
      } else if (code === "ETIMEDOUT") {
        detail = "connection timed out";
      } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        detail = "network unreachable";
      } else if (code === "TELEGRAM_ABORTED") {
        detail = "request aborted";
      } else if (code === "TELEGRAM_RELOADING") {
        detail = "request cancelled for configuration reload";
      } else {
        const raw = typeof failure?.cause?.message === "string" ? failure.cause.message
          : err instanceof Error ? err.message : String(err);
        detail = this.redact(raw);
      }
      const message = `Telegram file download failed: ${detail}`;
      throw new TelegramRequestError(code, message, err);
    } finally {
      // Abort unread bodies on every early HTTP rejection before dropping supervision.
      controller.abort();
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  public async getUpdates(options?: {
    offset?: number;
    limit?: number;
    timeout?: number;
    allowed_updates?: string[];
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    const timeoutSec = options?.timeout ?? 25;
    const httpTimeoutMs = (timeoutSec + 10) * 1000;

    const params: Record<string, unknown> = {
      timeout: timeoutSec,
      allowed_updates: options?.allowed_updates ?? ["message"],
      limit: options?.limit ?? 100,
    };
    if (options?.offset !== undefined) {
      params.offset = options.offset;
    }

    const updates = await this.callApi<TelegramUpdate[]>("getUpdates", params, httpTimeoutMs, options?.signal);
    if (!Array.isArray(updates) || updates.some(update => !update || !Number.isSafeInteger(update.update_id) ||
        (update.message !== undefined && (!update.message || !Number.isSafeInteger(update.message.chat?.id) ||
          (update.message.from !== undefined && (!update.message.from || !Number.isSafeInteger(update.message.from.id))) ||
          (update.message.message_thread_id !== undefined && !Number.isSafeInteger(update.message.message_thread_id)) ||
          (update.message.text !== undefined && typeof update.message.text !== "string"))))) {
      throw new TelegramDecodeError("Invalid Telegram getUpdates result");
    }
    if (updates.some(update => update.callback_query !== undefined && (
      !update.callback_query || typeof update.callback_query.id !== "string" || !update.callback_query.id || update.callback_query.id.length > 256 ||
      !Number.isSafeInteger(update.callback_query.from?.id) || typeof update.callback_query.from.is_bot !== "boolean" ||
      (update.callback_query.data !== undefined && (typeof update.callback_query.data !== "string" || Buffer.byteLength(update.callback_query.data, "utf-8") > 64)) ||
      (update.callback_query.message !== undefined && (!update.callback_query.message ||
        !Number.isSafeInteger(update.callback_query.message.chat?.id) || !Number.isSafeInteger(update.callback_query.message.message_id) ||
        !Number.isSafeInteger(update.callback_query.message.date) ||
        (update.callback_query.message.message_thread_id !== undefined && !Number.isSafeInteger(update.callback_query.message.message_thread_id))))
    ))) throw new TelegramDecodeError("Invalid Telegram callback query");
    return updates;
  }
}

/**
 * Validates bot setup against Telegram API according to architecture spec:
 * 1. getMe
 * 2. getChat(chatId) - must be a Forum Supergroup
 * 3. getChatMember(chatId, bot.id) - bot must be admin or have can_manage_topics
 * 4. getChatMember(chatId, allowedUserId) - user must not be left or kicked
 */
export async function validateBotAndChat(
  client: TelegramClient,
  chatId: number,
  allowedUserId: number
): Promise<{ botUser: TelegramUser; chat: TelegramChat }> {
  const botUser = await client.getMe();

  const chat = await client.getChat(chatId);
  if (!chat.is_forum || chat.type !== "supergroup") {
    throw new Error(
      `Chat ${chatId} is not a Forum Supergroup (type: ${chat.type}, is_forum: ${Boolean(chat.is_forum)}). Please ensure the group is a Supergroup and 'Topics' is enabled.`
    );
  }

  const botMember = await client.getChatMember(chatId, botUser.id);
  const botCanManage =
    botMember.status === "creator" ||
    (botMember.status === "administrator" && botMember.can_manage_topics === true) ||
    botMember.can_manage_topics === true;
  if (!botCanManage) {
    throw new Error(`Bot does not have topic management permissions in chat ${chatId}. Please grant the bot 'Manage Topics' administrator permission.`);
  }

  const userMember = await client.getChatMember(chatId, allowedUserId);
  if (userMember.status === "left" || userMember.status === "kicked") {
    throw new Error(`Allowed user ${allowedUserId} is not a member of chat ${chatId} (status: ${userMember.status})`);
  }

  return { botUser, chat };
}

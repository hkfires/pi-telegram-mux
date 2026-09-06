/**
 * Types for pi-telegram-mux v0.1
 */

export const BINDING_CUSTOM_TYPE = "pi-telegram-mux.binding";

/**
 * Global configuration stored in {agentDir}/pi-telegram-mux/config.json
 */
export interface MuxConfig {
  version: 1;
  botToken: string; // literal Bot Token
  chatId: number; // numeric ID of Forum Supergroup
  allowedUserId: number; // numeric Telegram user ID
  autoCloseTopics?: boolean; // Close topics when leaving a session; defaults to false.
}

/**
 * Session binding entry stored in Pi session JSONL.
 */
export interface TelegramBindingEntryData {
  version: 1;
  sessionId: string;
  chatId: number;
  threadId: number | null;
  state?: "topic-missing" | "create-unknown"; // Null-thread records that must not restore an older topic.
}

/**
 * Session binding state of the current Runtime.
 */
export type BindingState = "unbound" | "disconnected" | "bound" | "topic-missing" | "create-unknown";

/**
 * Binding-generation-fenced output target. Normal runs retain FIFO ordering;
 * disconnect, session navigation and configuration changes invalidate generation.
 */
export interface OutputTarget {
  sessionId: string;
  threadId: number;
  generation: number;
}

/**
 * Registration sent by Follower to Leader.
 */
export interface RuntimeRegistration {
  runtimeId: string;
  sessionId: string;
  threadId: number | null;
  generation: number;
}

export interface InboundResult {
  accepted: boolean;
  busy: boolean;
  statusReply?: string;
}

export interface TransportStatus {
  polling: "starting" | "online" | "retrying" | "error" | "conflict";
  error?: { code: string; message: string };
  feedbackError?: { code: string; message: string };
}

export const IPC_PROTOCOL_VERSION = 3;

/**
 * Leader lock metadata stored in {agentDir}/pi-telegram-mux/runtime/leader.json
 */
export interface LeaderLockData {
  pid: number;
  port: number;
  capability: string;
  epoch: number;
  createdAt: number;
}

/**
 * Telegram API Types
 */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramChatMember {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  can_manage_topics?: boolean;
  user?: TelegramUser;
}

export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

/**
 * IPC Frame Types between Leader and Follower
 */
export type IpcMessage =
  | { type: "auth"; protocolVersion: number; capability: string; runtimeId: string }
  | { type: "auth_ack"; protocolVersion: number; epoch: number; configFingerprint: string; status: TransportStatus }
  | { type: "transport_status"; status: TransportStatus }
  | { type: "transport_reset" }
  | { type: "register"; callId?: string; registration: RuntimeRegistration }
  | { type: "register_ack"; callId?: string; ok: boolean; error?: string }
  | { type: "release"; runtimeId: string; sessionId: string }
  | { type: "release_ack"; ok: boolean }
  | { type: "inbound"; requestId: string; messageId: number; target: OutputTarget; fromId: number; text: string }
  | ({ type: "inbound_ack"; requestId: string } & InboundResult)
  | { type: "abort"; requestId: string; target: OutputTarget }
  | { type: "abort_ack"; requestId: string; ok: boolean }
  | { type: "reload_config"; callId: string }
  | { type: "call_telegram"; callId: string; method: string; params: Record<string, unknown>; target?: OutputTarget }
  | { type: "cancel_telegram"; callId: string }
  | { type: "call_telegram_ack"; callId: string; ok: boolean; result?: unknown; error?: string; retryAfter?: number }
  | { type: "ping" }
  | { type: "pong" };

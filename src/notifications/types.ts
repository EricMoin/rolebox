// ── Notification Event Types ──────────────────────────────────────────

export enum NotificationEventType {
  Idle = "idle",
  Question = "question",
  Permission = "permission",
  Error = "error",
  DispatchComplete = "dispatch_complete",
  LoopComplete = "loop_complete",
  SessionDeleted = "session_deleted",
  Custom = "custom",
}

// ── Notification Channel Kinds ───────────────────────────────────────

export enum NotificationChannelKind {
  SystemToast = "system_toast",
  Sound = "sound",
  CustomCommand = "custom_command",
  Webhook = "webhook",
  File = "file",
  Log = "log",
}

// ── Platform Info ─────────────────────────────────────────────────────

export interface PlatformInfo {
  os: "darwin" | "linux" | "win32" | "unknown";
}

// ── Quiet Hours ───────────────────────────────────────────────────────

export interface QuietHoursRange {
  /** Start time in "HH:MM" format (24-hour). */
  start: string;
  /** End time in "HH:MM" format (24-hour). */
  end: string;
  /** Day-of-week abbreviations, e.g. ["Mon", "Tue"]. Omit for daily. */
  days?: string[];
}

export interface QuietHoursConfig {
  enabled: boolean;
  /** IANA timezone identifier, e.g. "America/New_York". Defaults to system timezone. */
  timezone?: string;
  ranges: QuietHoursRange[];
}

// ── Throttle Config ───────────────────────────────────────────────────

export interface ThrottleConfig {
  /** Rolling time window in milliseconds for the global rate limit. */
  windowMs: number;
  /** Maximum notifications allowed within the global window. */
  maxPerWindow: number;
  /** Per-event-type overrides for the rate limit. */
  perEventType?: Partial<
    Record<
      NotificationEventType,
      { windowMs: number; maxPerWindow: number }
    >
  >;
}

// ── Template Variables ────────────────────────────────────────────────

/** Flat key-value map of template variables for notification messages. */
export type NotificationTemplateVars = Record<string, string>;

// ── Notification Message ─────────────────────────────────────────────

/** Wire format exchanged between the notification manager and channels. */
export interface NotificationMessage {
  title: string;
  body: string;
  sessionId: string;
  eventType: NotificationEventType;
  agent?: string;
  roleName?: string;
  /** ISO 8601 timestamp of when the event occurred. */
  timestamp: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}

// ── Channel Config (discriminated union by kind) ─────────────────────

export interface SystemToastChannelConfig {
  kind: NotificationChannelKind.SystemToast;
  enabled: boolean;
}

export interface SoundChannelConfig {
  kind: NotificationChannelKind.Sound;
  enabled: boolean;
  /** Path to the sound file to play. */
  soundPath: string;
}

export interface CustomCommandChannelConfig {
  kind: NotificationChannelKind.CustomCommand;
  enabled: boolean;
  /** Shell command to execute. */
  command: string;
  /** When true, the notification message is piped to the command via stdin. */
  passAsStdin?: boolean;
  /** Additional environment variables for the command process. */
  env?: Record<string, string>;
}

export interface WebhookChannelConfig {
  kind: NotificationChannelKind.Webhook;
  enabled: boolean;
  /** Target URL for the webhook POST request. */
  url: string;
  /** Custom HTTP headers to include in the request. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
}

export interface FileChannelConfig {
  kind: NotificationChannelKind.File;
  enabled: boolean;
  /** Absolute or relative path to the notification log file. */
  path: string;
}

export interface LogChannelConfig {
  kind: NotificationChannelKind.Log;
  enabled: boolean;
  /** Log level for the notification entry (default: "info"). */
  level?: "info" | "warn" | "error" | "debug";
}

export type NotificationChannelConfig =
  | SystemToastChannelConfig
  | SoundChannelConfig
  | CustomCommandChannelConfig
  | WebhookChannelConfig
  | FileChannelConfig
  | LogChannelConfig;

// ── Per-Event Config ──────────────────────────────────────────────────

export interface NotificationEventConfig {
  /** Whether notifications for this event type are enabled. */
  enabled: boolean;
  /** Channel overrides specific to this event type. Falls back to global channels. */
  channels?: NotificationChannelConfig[];
  /** Template string for the notification title. Supports {{var}} placeholders. */
  titleTemplate?: string;
  /** Template string for the notification body. Supports {{var}} placeholders. */
  messageTemplate?: string;
  /** Throttle overrides specific to this event type. */
  throttle?: Partial<ThrottleConfig>;
  /** Quiet hours override specific to this event type. */
  quietHoursOverride?: QuietHoursConfig;
}

// ── Top-Level Config ──────────────────────────────────────────────────

export interface NotificationConfig {
  /** Master toggle for the entire notification system. */
  enabled: boolean;
  /** When true, only the main session triggers notifications. */
  mainSessionOnly: boolean;
  /** Milliseconds of inactivity before an idle notification fires. */
  idleDelayMs: number;
  /** Tool names that represent a "question" to the user (used for question event detection). */
  questionToolNames: string[];
  /** Global channel configurations. */
  channels: NotificationChannelConfig[];
  /** Per-event-type configuration overrides. */
  events?: Partial<Record<NotificationEventType, NotificationEventConfig>>;
  /** Global quiet hours configuration. */
  quietHours: QuietHoursConfig;
  /** Global throttle configuration. */
  throttle: ThrottleConfig;
}

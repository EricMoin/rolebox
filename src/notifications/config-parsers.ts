// ── Config Sub-parsers ──────────────────────────────────────────────
//
// Extracted from config.ts for modularity. Each function handles a
// single config subtree. No public API surface — these are internal
// helpers consumed by parseNotificationConfig and mergeNotificationConfigs.

import { createSubLogger } from "../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import {
  DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
  DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
} from "../constants.ts";
import { NOTIFICATION_CHANNEL_KINDS } from "./types.ts";
import type {
  NotificationConfig,
  NotificationChannelConfig,
  NotificationEventConfig,
  NotificationEventType,
  QuietHoursConfig,
  ThrottleConfig,
  QuietHoursRange,
} from "./types.ts";

const log: Logger<ILogObj> = createSubLogger("notification-config-parsers");

// ── Helpers ─────────────────────────────────────────────────────────

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isNaN(n)) return n;
    }
  }
  return undefined;
}

/** Check whether a raw value is a plain object (not null, not array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Sub-parsers ─────────────────────────────────────────────────────

export function parseQuietHoursRange(raw: unknown): QuietHoursRange | null {
  if (!isObject(raw)) return null;
  const start = raw.start;
  const end = raw.end;
  if (typeof start !== "string" || typeof end !== "string") return null;
  const result: QuietHoursRange = { start, end };
  if (Array.isArray(raw.days) && raw.days.every((d: unknown) => typeof d === "string")) {
    result.days = raw.days as string[];
  }
  return result;
}

export function parseQuietHours(raw: unknown): QuietHoursConfig | undefined {
  if (!isObject(raw)) return undefined;
  const enabled = asBoolean(raw.enabled);
  return {
    enabled: enabled ?? false,
    timezone: typeof raw.timezone === "string" ? raw.timezone : undefined,
    ranges: Array.isArray(raw.ranges)
      ? raw.ranges.map((r: unknown) => parseQuietHoursRange(r)).filter((r: unknown): r is QuietHoursRange => r !== null)
      : [],
  };
}

export function parseThrottle(raw: unknown): ThrottleConfig | undefined {
  if (!isObject(raw)) return undefined;
  const rawWindowMs = raw.windowMs;
  const rawMaxPerWindow = raw.maxPerWindow;
  const windowMs = asNumber(rawWindowMs);
  const maxPerWindow = asNumber(rawMaxPerWindow);
  if (windowMs === undefined && maxPerWindow === undefined) return undefined;
  const result: ThrottleConfig = {
    windowMs: windowMs ?? DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
    maxPerWindow: maxPerWindow ?? DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
  };
  if (isObject(raw.perEventType)) {
    const perEventType: ThrottleConfig["perEventType"] = {};
    for (const [key, val] of Object.entries(raw.perEventType)) {
      if (isObject(val)) {
        const evtWindow = asNumber(val.windowMs);
        const evtMax = asNumber(val.maxPerWindow);
        if (evtWindow !== undefined || evtMax !== undefined) {
          const typedKey = key as NotificationEventType;
          perEventType[typedKey] = {
            windowMs: evtWindow ?? DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
            maxPerWindow: evtMax ?? DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
          };
        }
      }
    }
    if (Object.keys(perEventType).length > 0) {
      result.perEventType = perEventType;
    }
  }
  return result;
}

export function parseChannelConfig(raw: unknown): NotificationChannelConfig | null {
  if (!isObject(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== "string") return null;

  const enabled = asBoolean(raw.enabled) ?? true;

  switch (kind) {
    case NOTIFICATION_CHANNEL_KINDS.SystemToast:
      return { kind: NOTIFICATION_CHANNEL_KINDS.SystemToast, enabled };

    case NOTIFICATION_CHANNEL_KINDS.Sound:
      return {
        kind: NOTIFICATION_CHANNEL_KINDS.Sound,
        enabled,
        soundPath: typeof raw.soundPath === "string" ? raw.soundPath : "",
      };

    case NOTIFICATION_CHANNEL_KINDS.CustomCommand:
      return {
        kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
        enabled,
        command: typeof raw.command === "string" ? raw.command : "",
        passAsStdin: asBoolean(raw.passAsStdin),
        env: isObject(raw.env) ? (raw.env as Record<string, string>) : undefined,
      };

    case NOTIFICATION_CHANNEL_KINDS.Webhook:
      return {
        kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
        enabled,
        url: typeof raw.url === "string" ? raw.url : "",
        headers: isObject(raw.headers) ? (raw.headers as Record<string, string>) : undefined,
        timeoutMs: asNumber(raw.timeoutMs),
      };

    case NOTIFICATION_CHANNEL_KINDS.File:
      return {
        kind: NOTIFICATION_CHANNEL_KINDS.File,
        enabled,
        path: typeof raw.path === "string" ? raw.path : "",
      };

    case NOTIFICATION_CHANNEL_KINDS.Log:
      return {
        kind: NOTIFICATION_CHANNEL_KINDS.Log,
        enabled,
        level: typeof raw.level === "string" &&
          ["info", "warn", "error", "debug"].includes(raw.level)
          ? (raw.level as "info" | "warn" | "error" | "debug")
          : undefined,
      };

    default:
      log.warn(`Unknown notification channel kind "${String(kind)}"; skipping channel entry`);
      return null;
  }
}

/**
 * Parse a single raw event config value into a validated `NotificationEventConfig`.
 * Returns `undefined` when the value is invalid or has no meaningful fields.
 */
export function parseEventConfig(val: unknown): NotificationEventConfig | undefined {
  if (!isObject(val)) return undefined;
  const evtObj = val as Record<string, unknown>;
  const eventConfig: Partial<NotificationEventConfig> = {};

  const evtEnabled = asBoolean(evtObj.enabled);
  if (evtEnabled !== undefined) eventConfig.enabled = evtEnabled;

  if (Array.isArray(evtObj.channels)) {
    const parsedChs: NotificationChannelConfig[] = [];
    for (let i = 0; i < evtObj.channels.length; i++) {
      const ch = parseChannelConfig(evtObj.channels[i]);
      if (ch !== null) parsedChs.push(ch);
    }
    if (parsedChs.length > 0) eventConfig.channels = parsedChs;
  }

  if (typeof evtObj.titleTemplate === "string") eventConfig.titleTemplate = evtObj.titleTemplate;
  if (typeof evtObj.messageTemplate === "string") eventConfig.messageTemplate = evtObj.messageTemplate;

  if (isObject(evtObj.throttle)) {
    const t = parseThrottle(evtObj.throttle);
    if (t) eventConfig.throttle = t;
  }

  if (isObject(evtObj.quietHoursOverride)) {
    const q = parseQuietHours(evtObj.quietHoursOverride);
    if (q) eventConfig.quietHoursOverride = q;
  }

  if (Object.keys(eventConfig).length === 0) return undefined;
  return eventConfig as NotificationEventConfig;
}

/**
 * Parse the raw `events` map into a validated events dictionary.
 * Skips unknown event types with a warning.
 */
export function parseEventConfigs(
  raw: unknown,
  validEventTypes: string[],
): NotificationConfig["events"] | undefined {
  if (!isObject(raw)) return undefined;

  const parsedEvents: Record<string, NotificationEventConfig> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!validEventTypes.includes(key)) {
      log.warn(`Skipping unknown notification event type "${key}"`);
      continue;
    }
    const eventType = key as NotificationEventType;
    const parsed = parseEventConfig(val);
    if (parsed) {
      parsedEvents[eventType] = parsed;
    }
  }

  if (Object.keys(parsedEvents).length === 0) return undefined;
  return parsedEvents as NotificationConfig["events"];
}

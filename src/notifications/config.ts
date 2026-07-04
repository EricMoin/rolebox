// ── Config parsing, merging, defaults, and env var resolution ──────

import { createSubLogger } from "../logger.ts";
import { resolveEnvVarsDeep } from "../env-resolver.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import {
  DEFAULT_NOTIFICATION_IDLE_DELAY_MS,
  DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
  DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
  DEFAULT_QUESTION_TOOL_NAMES,
} from "../constants.ts";
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_CHANNEL_KINDS,
} from "./types.ts";
import type {
  NotificationConfig,
  NotificationChannelConfig,
  NotificationEventConfig,
  NotificationEventType,
  QuietHoursConfig,
  ThrottleConfig,
  QuietHoursRange,
} from "./types.ts";

const log: Logger<ILogObj> = createSubLogger("notification-config");

// ── Defaults ────────────────────────────────────────────────────────

/**
 * Frozen default notification configuration.
 * All optional-adjacent fields have explicit defaults so consumers
 * never need null checks for the top-level shape.
 */
export const DEFAULT_NOTIFICATION_CONFIG: Readonly<NotificationConfig> = Object.freeze({
  enabled: true,
  mainSessionOnly: true,
  idleDelayMs: DEFAULT_NOTIFICATION_IDLE_DELAY_MS,
  questionToolNames: [...DEFAULT_QUESTION_TOOL_NAMES],
  channels: [] as NotificationChannelConfig[],
  events: undefined,
  quietHours: {
    enabled: false,
    ranges: [],
  },
  throttle: {
    windowMs: DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
    maxPerWindow: DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
  },
});

// ── Helpers ─────────────────────────────────────────────────────────

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
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
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Sub-parsers ─────────────────────────────────────────────────────

function parseQuietHoursRange(raw: unknown): QuietHoursRange | null {
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

function parseQuietHours(raw: unknown): QuietHoursConfig | undefined {
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

function parseThrottle(raw: unknown): ThrottleConfig | undefined {
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

function parseChannel(raw: unknown): NotificationChannelConfig | null {
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

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a raw (YAML-parsed) value into a validated `NotificationConfig`.
 *
 * Coerces strings to numbers where safe (e.g. `"1500"` → `1500`).
 * Logs warnings for invalid or unrecognized fields and falls back to
 * `DEFAULT_NOTIFICATION_CONFIG` for malformed input.
 *
 * @param raw - The raw (typically JSON/YAML-parsed) config value.
 * @returns A fully populated `NotificationConfig`.
 */
export function parseNotificationConfig(raw: unknown): NotificationConfig {
  if (!isObject(raw)) {
    log.warn("Notification config is not an object; using defaults");
    return { ...DEFAULT_NOTIFICATION_CONFIG, channels: [], questionToolNames: [...DEFAULT_QUESTION_TOOL_NAMES] };
  }

  const result: NotificationConfig = {
    enabled: true,
    mainSessionOnly: true,
    idleDelayMs: DEFAULT_NOTIFICATION_IDLE_DELAY_MS,
    questionToolNames: [...DEFAULT_QUESTION_TOOL_NAMES],
    channels: [],
    events: undefined,
    quietHours: { enabled: false, ranges: [] },
    throttle: {
      windowMs: DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
      maxPerWindow: DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
    },
  };

  const enabled = asBoolean(raw.enabled);
  if (enabled !== undefined) {
    result.enabled = enabled;
  } else if (raw.enabled !== undefined) {
    log.warn(`Invalid "enabled" value; expected boolean, got ${typeof raw.enabled}`);
  }

  const mainSessionOnly = asBoolean(raw.mainSessionOnly);
  if (mainSessionOnly !== undefined) {
    result.mainSessionOnly = mainSessionOnly;
  } else if (raw.mainSessionOnly !== undefined) {
    log.warn(`Invalid "mainSessionOnly" value; expected boolean, got ${typeof raw.mainSessionOnly}`);
  }

  const idleDelayMs = asNumber(raw.idleDelayMs);
  if (idleDelayMs !== undefined) {
    result.idleDelayMs = idleDelayMs;
  } else if (raw.idleDelayMs !== undefined) {
    log.warn(`Invalid "idleDelayMs" value; expected number, got ${typeof raw.idleDelayMs}`);
  }

  if (Array.isArray(raw.questionToolNames)) {
    if (raw.questionToolNames.every((item: unknown) => typeof item === "string")) {
      result.questionToolNames = [...raw.questionToolNames];
    } else {
      log.warn('"questionToolNames" must be an array of strings; using defaults');
    }
  } else if (raw.questionToolNames !== undefined) {
    log.warn(`Invalid "questionToolNames" value; expected array, got ${typeof raw.questionToolNames}`);
  }

  if (Array.isArray(raw.channels)) {
    const parsed: NotificationChannelConfig[] = [];
    for (let i = 0; i < raw.channels.length; i++) {
      const ch = parseChannel(raw.channels[i]);
      if (ch !== null) {
        parsed.push(ch);
      } else {
        log.warn(`Skipping invalid channel entry at index ${i}`);
      }
    }
    result.channels = parsed;
  } else if (raw.channels !== undefined) {
    log.warn(`Invalid "channels" value; expected array, got ${typeof raw.channels}`);
  }

  if (isObject(raw.events)) {
    const parsedEvents: NotificationConfig["events"] = {};
    for (const [key, val] of Object.entries(raw.events)) {
      const validEventTypes = Object.values(NOTIFICATION_EVENT_TYPES) as string[];
      if (!validEventTypes.includes(key)) {
        log.warn(`Skipping unknown notification event type "${key}"`);
        continue;
      }
      const eventType = key as NotificationEventType;
      if (isObject(val)) {
        const evtObj = val as Record<string, unknown>;
        const eventConfig: Partial<NotificationEventConfig> = {};
        const evtEnabled = asBoolean(evtObj.enabled);
        if (evtEnabled !== undefined) eventConfig.enabled = evtEnabled;
        if (Array.isArray(evtObj.channels)) {
          const parsedChs: NotificationChannelConfig[] = [];
          for (let i = 0; i < evtObj.channels.length; i++) {
            const ch = parseChannel(evtObj.channels[i]);
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
        if (Object.keys(eventConfig).length > 0) {
          parsedEvents[eventType] = eventConfig as NotificationEventConfig;
        }
      } else {
        log.warn(`Invalid event config for "${key}"; expected object, got ${typeof val}`);
      }
    }
    if (Object.keys(parsedEvents).length > 0) {
      result.events = parsedEvents;
    }
  } else if (raw.events !== undefined) {
    log.warn(`Invalid "events" value; expected object, got ${typeof raw.events}`);
  }

  if (isObject(raw.quietHours)) {
    const qh = parseQuietHours(raw.quietHours);
    if (qh) result.quietHours = qh;
  } else if (raw.quietHours !== undefined) {
    log.warn(`Invalid "quietHours" value; expected object, got ${typeof raw.quietHours}`);
  }

  if (isObject(raw.throttle)) {
    const th = parseThrottle(raw.throttle);
    if (th) result.throttle = th;
  } else if (raw.throttle !== undefined) {
    log.warn(`Invalid "throttle" value; expected object, got ${typeof raw.throttle}`);
  }

  return result;
}

function deepCloneConfig(config: NotificationConfig): NotificationConfig {
  return {
    ...config,
    questionToolNames: [...config.questionToolNames],
    channels: config.channels.map((ch) => ({ ...ch })),
    quietHours: {
      ...config.quietHours,
      ranges: config.quietHours.ranges.map((r) => ({ ...r })),
    },
    throttle: {
      ...config.throttle,
      perEventType: config.throttle.perEventType
        ? { ...config.throttle.perEventType }
        : undefined,
    },
    events: config.events
      ? Object.fromEntries(
          Object.entries(config.events).map(([key, evt]) => [
            key,
            evt ? {
              ...evt,
              channels: evt.channels ? evt.channels.map((ch) => ({ ...ch })) : undefined,
              throttle: evt.throttle ? { ...evt.throttle } : undefined,
              quietHoursOverride: evt.quietHoursOverride
                ? {
                    ...evt.quietHoursOverride,
                    ranges: evt.quietHoursOverride.ranges.map((r) => ({ ...r })),
                  }
                : undefined,
            } : undefined,
          ]),
        )
      : undefined,
  };
}

/**
 * Merge a role-level notification config on top of a global config.
 *
 * Semantics:
 * - Scalar fields (enabled, mainSessionOnly, idleDelayMs, questionToolNames,
 *   quietHours, throttle): role value always wins (all fields are required
 *   in `NotificationConfig`).
 * - `channels`: role's channels array **replaces** global's entirely.
 * - `events`: merged at the event-key level. Role's event config replaces
 *   global's for the same key. Keys present only in global are preserved.
 * - If `role` is `undefined`, returns a deep clone of `global`.
 *
 * @param global - The global/base notification configuration.
 * @param role - Optional role-level overrides.
 * @returns A new merged `NotificationConfig` (input objects are not mutated).
 */
export function mergeNotificationConfigs(
  global: NotificationConfig,
  role?: NotificationConfig,
): NotificationConfig {
  if (!role) return deepCloneConfig(global);

  const result: NotificationConfig = {
    enabled: role.enabled,
    mainSessionOnly: role.mainSessionOnly,
    idleDelayMs: role.idleDelayMs,
    questionToolNames: [...role.questionToolNames],
    channels: role.channels.map((ch) => ({ ...ch })),
    quietHours: {
      ...role.quietHours,
      ranges: role.quietHours.ranges.map((r) => ({ ...r })),
    },
    throttle: {
      ...role.throttle,
      perEventType: role.throttle.perEventType
        ? { ...role.throttle.perEventType }
        : undefined,
    },
    events: undefined,
  };

  if (global.events || role.events) {
    const merged: Record<string, NotificationEventConfig | undefined> = {};
    if (global.events) {
      for (const [key, evt] of Object.entries(global.events)) {
        merged[key as NotificationEventType] = evt
          ? {
              ...evt,
              channels: evt.channels ? evt.channels.map((ch) => ({ ...ch })) : undefined,
              throttle: evt.throttle ? { ...evt.throttle } : undefined,
              quietHoursOverride: evt.quietHoursOverride
                ? {
                    ...evt.quietHoursOverride,
                    ranges: evt.quietHoursOverride.ranges.map((r) => ({ ...r })),
                  }
                : undefined,
            }
          : undefined;
      }
    }
    if (role.events) {
      for (const [key, evt] of Object.entries(role.events)) {
        const eventType = key as NotificationEventType;
        if (evt === undefined) {
          merged[eventType] = undefined;
        } else {
          merged[eventType] = {
            ...evt,
            channels: evt.channels ? evt.channels.map((ch) => ({ ...ch })) : undefined,
            throttle: evt.throttle ? { ...evt.throttle } : undefined,
            quietHoursOverride: evt.quietHoursOverride
              ? {
                  ...evt.quietHoursOverride,
                  ranges: evt.quietHoursOverride.ranges.map((r) => ({ ...r })),
                }
              : undefined,
          };
        }
      }
    }
    const defined = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(defined).length > 0) {
      result.events = defined as NotificationConfig["events"];
    }
  }

  return result;
}

/**
 * Resolve `{env:VAR_NAME}` patterns in all string values of a
 * `NotificationConfig`. Produces a new object; does not mutate the input.
 *
 * @param config - The config to resolve environment variables in.
 * @returns A new `NotificationConfig` with all env vars resolved.
 */
export function resolveEnvVarsInConfig(config: NotificationConfig): NotificationConfig {
  return resolveEnvVarsDeep(config) as NotificationConfig;
}

/**
 * Validate a `NotificationConfig` and return a list of warning strings.
 *
 * Checks include:
 * - `idleDelayMs` must not be negative
 * - `throttle.maxPerWindow` must be at least 1
 * - `throttle.windowMs` must be positive
 * - All channel entries have a known `kind`
 * - All event keys are valid `NotificationEventType` values
 * - `quietHours` time ranges use valid "HH:MM" format
 *
 * @param config - The config to validate.
 * @returns An array of warning strings. Empty = valid config.
 */
export function validateNotificationConfig(config: NotificationConfig): string[] {
  const warnings: string[] = [];

  if (config.idleDelayMs < 0) {
    warnings.push(`idleDelayMs is negative (${config.idleDelayMs})`);
  }

  if (config.throttle.maxPerWindow < 1) {
    warnings.push(`throttle.maxPerWindow must be at least 1 (got ${config.throttle.maxPerWindow})`);
  }
  if (config.throttle.windowMs <= 0) {
    warnings.push(`throttle.windowMs must be positive (got ${config.throttle.windowMs})`);
  }
  if (config.throttle.perEventType) {
    for (const [eventType, limits] of Object.entries(config.throttle.perEventType)) {
      if (limits) {
        if (limits.maxPerWindow !== undefined && limits.maxPerWindow < 1) {
          warnings.push(`throttle.perEventType.${eventType}.maxPerWindow must be at least 1 (got ${limits.maxPerWindow})`);
        }
        if (limits.windowMs !== undefined && limits.windowMs <= 0) {
          warnings.push(`throttle.perEventType.${eventType}.windowMs must be positive (got ${limits.windowMs})`);
        }
      }
    }
  }

  const validKinds = new Set(Object.values(NOTIFICATION_CHANNEL_KINDS));
  for (let i = 0; i < config.channels.length; i++) {
    const ch = config.channels[i];
    if (!validKinds.has(ch.kind)) {
      warnings.push(`channels[${i}] has unknown kind "${ch.kind}"`);
    }
    if (ch.kind === NOTIFICATION_CHANNEL_KINDS.Sound && !ch.soundPath) {
      warnings.push(`channels[${i}] (Sound) has an empty soundPath`);
    }
    if (ch.kind === NOTIFICATION_CHANNEL_KINDS.CustomCommand && !ch.command) {
      warnings.push(`channels[${i}] (CustomCommand) has an empty command`);
    }
    if (ch.kind === NOTIFICATION_CHANNEL_KINDS.Webhook && !ch.url) {
      warnings.push(`channels[${i}] (Webhook) has an empty url`);
    }
    if (ch.kind === NOTIFICATION_CHANNEL_KINDS.File && !ch.path) {
      warnings.push(`channels[${i}] (File) has an empty path`);
    }
  }

  const validEventTypes = new Set<string>(Object.values(NOTIFICATION_EVENT_TYPES));
  if (config.events) {
    for (const [key, evt] of Object.entries(config.events)) {
      if (!validEventTypes.has(key as NotificationEventType)) {
        warnings.push(`events has unknown key "${key}"`);
      }
      if (evt) {
        if (evt.throttle) {
          if (evt.throttle.maxPerWindow !== undefined && evt.throttle.maxPerWindow < 1) {
            warnings.push(`events.${key}.throttle.maxPerWindow must be at least 1 (got ${evt.throttle.maxPerWindow})`);
          }
          if (evt.throttle.windowMs !== undefined && evt.throttle.windowMs <= 0) {
            warnings.push(`events.${key}.throttle.windowMs must be positive (got ${evt.throttle.windowMs})`);
          }
        }
        if (evt.channels) {
          for (let i = 0; i < evt.channels.length; i++) {
            const ch = evt.channels[i];
            if (!validKinds.has(ch.kind)) {
              warnings.push(`events.${key}.channels[${i}] has unknown kind "${ch.kind}"`);
            }
          }
        }
        if (evt.quietHoursOverride) {
          for (let i = 0; i < evt.quietHoursOverride.ranges.length; i++) {
            const r = evt.quietHoursOverride.ranges[i];
            if (!/^\d{2}:\d{2}$/.test(r.start)) {
              warnings.push(`events.${key}.quietHoursOverride.ranges[${i}].start is not in HH:MM format`);
            }
            if (!/^\d{2}:\d{2}$/.test(r.end)) {
              warnings.push(`events.${key}.quietHoursOverride.ranges[${i}].end is not in HH:MM format`);
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < config.quietHours.ranges.length; i++) {
    const r = config.quietHours.ranges[i];
    if (!/^\d{2}:\d{2}$/.test(r.start)) {
      warnings.push(`quietHours.ranges[${i}].start is not in HH:MM format`);
    }
    if (!/^\d{2}:\d{2}$/.test(r.end)) {
      warnings.push(`quietHours.ranges[${i}].end is not in HH:MM format`);
    }
  }

  if (config.questionToolNames.length === 0) {
    warnings.push("questionToolNames is empty; no tool names will trigger question events");
  }

  return warnings;
}

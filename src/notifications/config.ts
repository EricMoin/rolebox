
import { createSubLogger } from "../logger.ts";
import { resolveEnvVarsDeep } from "../resolver/env-resolver.ts";
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
import {
  asBoolean,
  asNumber,
  isObject,
  parseQuietHours,
  parseThrottle,
  parseChannelConfig,
  parseEventConfigs,
} from "./config-parsers.ts";
const log: Logger<ILogObj> = createSubLogger("notification-config");

// ── Defaults ────────────────────────────────────────────────────────

/**
 * Default per-event notification configs, seeded into every parsed config so
 * events like the graph approval gate have a sensible enabled state and title
 * template without requiring explicit user config. A user config entry for the
 * same event key overrides the whole entry at the event-key level (see
 * `parseNotificationConfig` / `mergeNotificationConfigs`).
 */
export const DEFAULT_NOTIFICATION_EVENT_CONFIGS: Readonly<
  Partial<Record<NotificationEventType, NotificationEventConfig>>
> = Object.freeze({
  [NOTIFICATION_EVENT_TYPES.ApprovalPending]: Object.freeze({
    enabled: true,
    titleTemplate: "Approval gate waiting: {graph_id}/{node_id}",
  }),
});

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
  events: DEFAULT_NOTIFICATION_EVENT_CONFIGS as NotificationConfig["events"],
  quietHours: {
    enabled: false,
    ranges: [],
  },
  throttle: {
    windowMs: DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
    maxPerWindow: DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
  },
});

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
      const ch = parseChannelConfig(raw.channels[i]);
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
  const events = parseEventConfigs(raw.events, Object.values(NOTIFICATION_EVENT_TYPES) as string[]);
  // Seed default per-event configs (e.g. approval_pending title template) so an
  // event has a sensible default even when the user does not configure it. A
  // user entry for the same key (parsed `events`) overrides the default whole.
  const mergedEvents = { ...DEFAULT_NOTIFICATION_EVENT_CONFIGS, ...(events ?? {}) };
  if (Object.keys(mergedEvents).length > 0) {
    result.events = mergedEvents as NotificationConfig["events"];
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

export { validateNotificationConfig } from "./config-validate.ts";

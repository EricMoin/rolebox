import type { NotificationConfig } from "./types.ts";
import { NOTIFICATION_CHANNEL_KINDS, NOTIFICATION_EVENT_TYPES } from "./types.ts";
import type { NotificationEventType } from "./types.ts";

/**
 * Validate a `NotificationConfig` and return a list of warning strings.
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

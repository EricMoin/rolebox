// ── Quiet Hours / Do-Not-Disturb Evaluation ──────────────────────────

import { createSubLogger } from "../logger.ts";
import type { QuietHoursConfig } from "./types.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";

const log: Logger<ILogObj> = createSubLogger("quiet-hours");

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse a "HH:MM" time string into minutes since midnight.
 * Returns -1 on parse failure (invalid format, out-of-range values).
 */
function parseTimeToMinutes(time: string): number {
  if (typeof time !== "string") return -1;
  const trimmed = time.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return -1;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours < 0 || hours > 23) return -1;
  if (minutes < 0 || minutes > 59) return -1;

  return hours * 60 + minutes;
}

/**
 * Return the 3-letter day-of-week abbreviation ("Mon", "Tue", etc.)
 * for the given date, optionally in a specific timezone.
 */
function getDayOfWeek(date: Date, timezone?: string): string {
  try {
    const opts: Intl.DateTimeFormatOptions = { weekday: "short" };
    if (timezone) opts.timeZone = timezone;
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  } catch {
    // Timezone not recognized — fall back to local
    if (timezone) {
      log.warn(`Unrecognized timezone: "${timezone}"; falling back to local time`);
    }
    return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  }
}

/**
 * Return the current time in minutes since midnight for the given date,
 * optionally in a specific timezone.
 */
function getTimeInMinutes(date: Date, timezone?: string): number {
  try {
    const opts: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    if (timezone) opts.timeZone = timezone;
    const formatter = new Intl.DateTimeFormat("en-US", opts);
    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    return hour * 60 + minute;
  } catch {
    // Timezone not recognized — fall back to local
    if (timezone) {
      log.warn(`Unrecognized timezone: "${timezone}"; falling back to local time`);
    }
    return date.getHours() * 60 + date.getMinutes();
  }
}

// ── QuietHours Class ─────────────────────────────────────────────────

/**
 * Evaluates do-not-disturb / quiet-hours conditions from a config.
 *
 * - If config is undefined or `enabled: false`, all checks return `false`
 *   (never quiet).
 * - Supports per-range day-of-week filtering.
 * - Supports midnight-crossover ranges (e.g., 22:00–07:00).
 * - Supports timezone-aware evaluation via `Intl.DateTimeFormat`.
 */
export class QuietHours {
  private config?: QuietHoursConfig;

  constructor(config?: QuietHoursConfig) {
    this.config = config;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Check if the given time (default: now) falls within any configured
   * quiet range.
   *
   * Returns `false` immediately when:
   * - config is undefined
   * - config.enabled is false
   * - config.ranges is empty
   */
  isQuiet(now?: Date): boolean {
    const config = this.config;
    if (!config || !config.enabled) return false;
    if (!config.ranges || config.ranges.length === 0) return false;

    const dt = now ?? new Date();
    const timezone = config.timezone;
    const nowMinutes = getTimeInMinutes(dt, timezone);
    const today = getDayOfWeek(dt, timezone);

    for (const range of config.ranges) {
      // Skip if range has day filters and today doesn't match
      if (range.days && range.days.length > 0 && !range.days.includes(today)) {
        continue;
      }

      const startMinutes = parseTimeToMinutes(range.start);
      const endMinutes = parseTimeToMinutes(range.end);

      // Skip range on invalid time format
      if (startMinutes < 0 || endMinutes < 0) {
        log.warn(
          `Invalid time format in quiet hours range: start="${range.start}", end="${range.end}"`,
        );
        continue;
      }

      // Evaluate the range
      if (startMinutes === endMinutes) {
        // Full 24-hour quiet
        return true;
      }

      if (endMinutes < startMinutes) {
        // Midnight crossover (e.g., 22:00–07:00)
        if (nowMinutes >= startMinutes || nowMinutes < endMinutes) {
          return true;
        }
      } else {
        // Normal range (e.g., 09:00–17:00)
        if (nowMinutes >= startMinutes && nowMinutes < endMinutes) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Return the Date when the currently active quiet period ends.
   * Returns `null` if not currently quiet.
   *
   * For midnight-crossover ranges, the end Date may be on the following day.
   * For full-day ranges (start === end), the end is 24 hours from now.
   */
  nextActiveTime(now?: Date): Date | null {
    const config = this.config;
    if (!config || !config.enabled) return null;
    if (!config.ranges || config.ranges.length === 0) return null;

    const dt = now ?? new Date();
    const timezone = config.timezone;
    const nowMinutes = getTimeInMinutes(dt, timezone);
    const today = getDayOfWeek(dt, timezone);

    for (const range of config.ranges) {
      // Skip if range has day filters and today doesn't match
      if (range.days && range.days.length > 0 && !range.days.includes(today)) {
        continue;
      }

      const startMinutes = parseTimeToMinutes(range.start);
      const endMinutes = parseTimeToMinutes(range.end);

      if (startMinutes < 0 || endMinutes < 0) continue;

      let isActive = false;
      if (startMinutes === endMinutes) {
        isActive = true;
      } else if (endMinutes < startMinutes) {
        isActive = nowMinutes >= startMinutes || nowMinutes < endMinutes;
      } else {
        isActive = nowMinutes >= startMinutes && nowMinutes < endMinutes;
      }

      if (isActive) {
        return this.buildEndDate(dt, endMinutes, startMinutes, endMinutes < startMinutes);
      }
    }

    return null;
  }

  /** No-op for interface consistency. */
  dispose(): void {
    // No resources to clean up.
  }

  // ── Internal ─────────────────────────────────────────────────────

  /**
   * Build a Date representing `endMinutes` minutes since midnight.
   *
   * @param base — reference date (used for year/month/day)
   * @param endMinutes — minutes since midnight for the end time
   * @param isCrossOver — whether the range crosses midnight (end < start)
   */
  private buildEndDate(
    base: Date,
    endMinutes: number,
    startMinutes: number,
    isCrossOver: boolean,
  ): Date {
    const endHour = Math.floor(endMinutes / 60);
    const endMin = endMinutes % 60;

    const result = new Date(base);
    result.setHours(endHour, endMin, 0, 0);

    if (isCrossOver) {
      // Current time is past start → end is tomorrow
      result.setDate(result.getDate() + 1);
    } else if (startMinutes === endMinutes) {
      // Full-day range → end is tomorrow
      result.setDate(result.getDate() + 1);
    }

    return result;
  }
}

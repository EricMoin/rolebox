// ── Notification Throttling & Deduplication ──────────────────────────

import { createSubLogger } from "../logger.ts";
import { NotificationEventType } from "./types.ts";
import type { ThrottleConfig } from "./types.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";

const log: Logger<ILogObj> = createSubLogger("notification-throttle");

// ── Default Config ───────────────────────────────────────────────────

/** Sensible defaults for the notification throttle. */
export const DEFAULT_THROTTLE_CONFIG: Readonly<ThrottleConfig> = Object.freeze({
  windowMs: 3000,
  maxPerWindow: 3,
  perEventType: undefined,
});

// ── Notification Throttle ────────────────────────────────────────────

/**
 * Rate-limits and deduplicates notifications per session+event-type key.
 *
 * Tracks a rolling window of timestamps and checks two thresholds:
 * 1. **Rate limit** — max N notifications per window (configurable per
 *    event type via `perEventType` overrides).
 * 2. **Hard minimum interval** — at least 1000ms between identical
 *    session+event-type pairs (rapid duplicate suppression).
 *
 * Auto-prunes expired entries on every `allow()` call to prevent
 * unbounded memory growth.
 */
export class NotificationThrottle {
  private config: ThrottleConfig;
  /** Map keyed by `${sessionID}:${eventType}` → chronological timestamps. */
  private timestamps: Map<string, number[]> = new Map();

  constructor(config: ThrottleConfig) {
    if (!config || typeof config !== "object") {
      log.warn("Throttle config missing or invalid; using defaults");
      this.config = { ...DEFAULT_THROTTLE_CONFIG };
    } else {
      this.config = {
        windowMs: config.windowMs ?? DEFAULT_THROTTLE_CONFIG.windowMs,
        maxPerWindow: config.maxPerWindow ?? DEFAULT_THROTTLE_CONFIG.maxPerWindow,
        perEventType: config.perEventType,
      };
    }
  }

  /**
   * The main gate function. Returns `true` if the notification should be
   * allowed through, `false` if it should be suppressed (throttled).
   */
  allow(sessionID: string, eventType: NotificationEventType): boolean {
    const now = Date.now();
    const topWindowMs = this.config.windowMs;
    if (topWindowMs <= 0) {
      return true;
    }

    const topMaxPerWindow = this.config.maxPerWindow <= 0
      ? 1
      : this.config.maxPerWindow;

    // ── Auto-prune: remove timestamps older than top-level windowMs ──
    const pruneCutoff = now - topWindowMs;
    for (const [key, stamps] of this.timestamps) {
      const filtered = stamps.filter((t) => t >= pruneCutoff);
      if (filtered.length === 0) {
        this.timestamps.delete(key);
      } else {
        this.timestamps.set(key, filtered);
      }
    }

    const key = `${sessionID}:${eventType}`;
    const perEvent = this.config.perEventType?.[eventType];
    const effectiveWindowMs = perEvent?.windowMs ?? topWindowMs;
    const effectiveMaxPerWindow = perEvent?.maxPerWindow ?? topMaxPerWindow;

    const currentStamps = this.timestamps.get(key) ?? [];
    const effectiveCutoff = now - effectiveWindowMs;
    const recentStamps = currentStamps.filter((t) => t >= effectiveCutoff);

    if (recentStamps.length >= effectiveMaxPerWindow) {
      return false;
    }

    if (currentStamps.length > 0) {
      const lastStamp = currentStamps[currentStamps.length - 1];
      if (now - lastStamp < 1000) {
        return false;
      }
    }

    currentStamps.push(now);
    this.timestamps.set(key, currentStamps);
    return true;
  }

  /** Clear all tracked state (timestamps map). */
  reset(): void {
    this.timestamps.clear();
  }

  /**
   * Remove expired entries from all keys.
   * Also removes keys whose arrays have become empty.
   */
  prune(): void {
    const now = Date.now();
    const windowMs = this.config.windowMs;
    if (windowMs <= 0) return;

    const cutoff = now - windowMs;
    for (const [key, stamps] of this.timestamps) {
      const filtered = stamps.filter((t) => t >= cutoff);
      if (filtered.length === 0) {
        this.timestamps.delete(key);
      } else {
        this.timestamps.set(key, filtered);
      }
    }
  }

  /**
   * Return basic stats for debugging / logging.
   *
   * - `totalTracked`: sum of all timestamp entries across all keys.
   * - `keys`: number of distinct `${sessionID}:${eventType}` keys.
   */
  stats(): { totalTracked: number; keys: number } {
    let totalTracked = 0;
    for (const stamps of this.timestamps.values()) {
      totalTracked += stamps.length;
    }
    return { totalTracked, keys: this.timestamps.size };
  }
}

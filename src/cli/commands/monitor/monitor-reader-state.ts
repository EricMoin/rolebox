/**
 * State-file readers for the monitor.
 *
 * Reads notification state and recovery metrics from the on-disk
 * state files produced by the dispatch subsystem.
 *
 * @module
 */

import type { NotificationState, RecoveryMetrics } from "./monitor-reader-types.ts";
import { tryReadJson, listStateFiles } from "./monitor-reader-utils.ts";

/**
 * Scan the state directory for notification sidecar files (notifications-*.json)
 * and return a best-effort NotificationState. Returns null when no notification
 * state file exists (notifications subsystem may be disabled).
 *
 * The notification subsystem does not persist runtime state to disk by default,
 * so this reader returns null gracefully when no data is found.
 */
export function readNotificationState(stateDir: string): NotificationState | null {
  const notifFiles = listStateFiles(stateDir, "notifications-");
  if (notifFiles.length === 0) return null;

  for (const filePath of notifFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;

    const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
    let quietHoursActive = false;

    // Compute quietHoursActive from quietHours config if present
    if (typeof obj.quietHours === "object" && obj.quietHours !== null) {
      const qh = obj.quietHours as Record<string, unknown>;
      if (qh.enabled === true) {
        // Best-effort: if quiet hours are configured as enabled, report active
        // A full evaluation would require time-of-day checking
        quietHoursActive = true;
      }
    }

    // Throttle stats if available
    let throttleStats: { recentCount: number; windowMs: number } | undefined;
    if (typeof obj.throttle === "object" && obj.throttle !== null) {
      const th = obj.throttle as Record<string, unknown>;
      if (typeof th.windowMs === "number" && typeof th.maxPerWindow === "number") {
        throttleStats = {
          recentCount: th.maxPerWindow as number,
          windowMs: th.windowMs as number,
        };
      }
    }

    // Recent notification events if stored
    const recentEvents: Array<{ ts: string; type: string }> = [];
    if (Array.isArray(obj.recentEvents)) {
      for (const evt of obj.recentEvents) {
        if (
          evt &&
          typeof evt === "object" &&
          typeof (evt as Record<string, unknown>).ts === "string" &&
          typeof (evt as Record<string, unknown>).type === "string"
        ) {
          recentEvents.push({
            ts: (evt as Record<string, unknown>).ts as string,
            type: (evt as Record<string, unknown>).type as string,
          });
        }
      }
    }

    return { enabled, quietHoursActive, recentEvents, throttleStats };
  }

  return null;
}

/**
 * Parse the `recovery` key from the metrics-*.json sidecar file.
 * Returns a RecoveryMetrics object when the key is present and valid,
 * or null when absent, malformed, or the metrics file doesn't exist.
 *
 * The `recovery` key is optional in the persisted file — absent when no
 * recovery engine is wired or when ROLEBOX_METRICS is disabled.
 */
export function readRecoveryMetrics(stateDir: string): RecoveryMetrics | null {
  const metricsFiles = listStateFiles(stateDir, "metrics-");
  if (metricsFiles.length === 0) return null;

  for (const filePath of metricsFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const recovery = obj.recovery;
    if (!recovery || typeof recovery !== "object") continue;
    const r = recovery as Record<string, unknown>;
    if (
      typeof r.totalAttempts === "number" &&
      typeof r.successfulRecoveries === "number" &&
      typeof r.abortedChains === "number" &&
      typeof r.exhaustedChains === "number"
    ) {
      return r as unknown as RecoveryMetrics;
    }
  }

  return null;
}

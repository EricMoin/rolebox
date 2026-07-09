/**
 * Computation helpers for monitor-reader.
 *
 * Pure functions that compute derived values from snapshots:
 * durations, dispatch summaries, and concurrency status.
 *
 * @module
 */

import type { MetricsSnapshot } from "../../dispatch/metrics.ts";
import type { TaskSnapshot, DispatchSummary, ConcurrencyStatus } from "./monitor-reader-types.ts";

// ── Concurrency gauge name constants ──────────────────────────────

export const CONCURRENCY_GAUGE_ACTIVE = "concurrency_active";
export const CONCURRENCY_GAUGE_QUEUED = "concurrency_queued";
export const CONCURRENCY_GAUGE_LIMIT = "concurrency_limit";

// ── Duration calculation ──────────────────────────────────────────

export function computeDurationMs(startedAt: string | undefined, completedAt?: string): number {
  try {
    const start = startedAt ? new Date(startedAt).getTime() : NaN;
    if (isNaN(start)) return 0;
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    return Math.max(0, end - start);
  } catch {
    return 0;
  }
}

// ── Dispatch summary ──────────────────────────────────────────────

/**
 * Compute a DispatchSummary from an array of TaskSnapshot objects.
 * Counts tasks by their status field.
 */
export function computeDispatchSummary(tasks: TaskSnapshot[]): DispatchSummary {
  let pending = 0;
  let running = 0;
  let completed = 0;
  let error = 0;
  let cancelled = 0;

  for (const t of tasks) {
    switch (t.status) {
      case "pending":
        pending++;
        break;
      case "running":
        running++;
        break;
      case "completed":
        completed++;
        break;
      case "error":
        error++;
        break;
      case "cancelled":
        cancelled++;
        break;
      // "timeout" is counted as error for summary purposes
      default:
        break;
    }
  }

  return { pending, running, completed, error, cancelled };
}

// ── Concurrency status ────────────────────────────────────────────

/**
 * Compute an aggregate ConcurrencyStatus from a MetricsSnapshot.
 *
 * Scans the metrics gauges for keys matching known concurrency gauge
 * patterns (concurrency_active, concurrency_queued, concurrency_limit)
 * and aggregates their values across all model keys.
 *
 * Returns a zeroed ConcurrencyStatus when no metrics or no concurrency
 * gauges are present.
 */
export function computeConcurrencyStatus(
  metrics: MetricsSnapshot | null | undefined,
): ConcurrencyStatus {
  const result: ConcurrencyStatus = { active: 0, limit: 0, queued: 0 };

  if (!metrics) return result;

  // Aggregate across all model keys by matching gauge name prefix
  for (const [key, gs] of Object.entries(metrics.gauges)) {
    if (key.startsWith(CONCURRENCY_GAUGE_ACTIVE + "{") || key === CONCURRENCY_GAUGE_ACTIVE) {
      result.active += gs.value;
    } else if (key.startsWith(CONCURRENCY_GAUGE_QUEUED + "{") || key === CONCURRENCY_GAUGE_QUEUED) {
      result.queued += gs.value;
    } else if (key.startsWith(CONCURRENCY_GAUGE_LIMIT + "{") || key === CONCURRENCY_GAUGE_LIMIT) {
      result.limit += gs.value;
    }
  }

  return result;
}

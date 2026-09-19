import type { DispatchTask } from "../types.ts";
import { formatDuration as canonicalFormatDuration } from "../../utils/text-format.ts";

// ─── Duration formatters (shared) ──────────────────────────────────────────
//
// Every formatter below is a one-line delegation to the canonical
// `src/utils/text-format.ts`.

/**
 * Format the elapsed time of a task from startedAt to completedAt (or now).
 *
 * `formatDuration(…, "clock")`: `Xs` under a minute, `Xm Ys` under an hour,
 * `Xh Ym` above (the old ladder pinned everything to minutes).
 */
export function formatDuration(task: DispatchTask): string {
  const end = task.completedAt ?? new Date();
  const ms = end.getTime() - task.startedAt.getTime();
  return canonicalFormatDuration(ms, "clock");
}

/**
 * Format a millisecond duration as a human-readable age string.
 *
 * `formatDuration(…, "monitor")` after clamping negatives to zero: `0ms` for
 * negatives (unchanged) and the `?` sentinel — never `NaNm NaNs` — for
 * non-finite input. Exact-minute ages lose the trailing zero seconds
 * (`1m 0s` → `1m`), the monitor style's documented shape.
 */
export function formatAge(ms: number): string {
  return canonicalFormatDuration(Math.max(0, ms), "monitor");
}

/**
 * Format the duration between two explicit Date values.
 * Used by task-export where both start and end are known.
 *
 * Same `"clock"` ladder as {@link formatDuration}: `Xm Ys` rolls up to
 * `Xh Ym` past the hour instead of staying pinned to minutes.
 */
export function formatDurationBetween(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  return canonicalFormatDuration(ms, "clock");
}

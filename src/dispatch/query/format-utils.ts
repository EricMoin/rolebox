import type { DispatchTask } from "../types.ts";

// ─── Duration formatters (shared) ──────────────────────────────────────────

/**
 * Format the elapsed time of a task from startedAt to completedAt (or now).
 */
export function formatDuration(task: DispatchTask): string {
  const end = task.completedAt ?? new Date();
  const ms = end.getTime() - task.startedAt.getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}

/**
 * Format a millisecond duration as a human-readable age string.
 */
export function formatAge(ms: number): string {
  if (ms < 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}

/**
 * Format the duration between two explicit Date values.
 * Used by task-export where both start and end are known.
 */
export function formatDurationBetween(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}

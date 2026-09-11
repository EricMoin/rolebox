/**
 * Progress tools — milestone-threshold tracking core.
 *
 * Phase C (graph-engine migration) removed the deprecated `dispatch_progress`
 * and `dispatch_stream` tool factories. This file survives ONLY to keep the
 * per-task milestone-threshold tracking (`emittedThresholds`) that the core
 * DispatchManager lifecycle (`clearEmittedThresholds`) still depends on.
 */

/** Per-task set of already-emitted milestone thresholds. */
const emittedThresholds = new Map<string, Set<number>>();

/** Clean up emitted-threshold tracking for a task (called when progress is cleared). */
export function clearEmittedThresholds(taskId: string): void {
  emittedThresholds.delete(taskId);
}

/** Clean up all emitted-threshold tracking (for testing or reset). */
export function clearAllEmittedThresholds(): void {
  emittedThresholds.clear();
}

import type { DispatchTask } from "../types.ts";
import { metrics } from "../persistence/metrics.ts";
import type { MetricsSnapshot } from "../persistence/metrics.ts";
import type { DispatchManagerConfig } from "../types.ts";
import { BudgetTracker } from "../budget/budget-tracker.ts";

export function getTasksByParent(
  tasks: Map<string, DispatchTask>,
  parentSessionId: string,
): DispatchTask[] {
  const result: DispatchTask[] = [];
  for (const task of tasks.values()) {
    if (task.parentSessionId === parentSessionId) {
      result.push(task);
    }
  }
  return result;
}

export function getMetricsSnapshotFn(): MetricsSnapshot {
  return metrics.snapshot();
}

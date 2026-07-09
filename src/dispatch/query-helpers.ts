import type { DispatchTask } from "./types.ts";
import type { IConcurrencyManager } from "./concurrency.ts";
import { metrics } from "./metrics.ts";
import type { MetricsSnapshot } from "./metrics.ts";
import type { DispatchManagerConfig } from "./types.ts";
import { BudgetTracker } from "./budget-tracker.ts";

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

export function getConcurrencyStatus(concurrency: IConcurrencyManager): {
  keys: Array<{
    key: string;
    active: number;
    limit: number;
    available: number;
    reserved: number;
    queueDepth: number;
  }>;
  total: {
    active: number;
    limit: number;
    queueDepth: number;
    keys: number;
  };
} {
  const allKeys = concurrency.getAllKeys();
  const keys = allKeys.map(key => {
    const active = concurrency.getActiveCount(key);
    const limit = concurrency.getLimit(key);
    const reserved = concurrency.getReserved(key);
    const queueDepth = concurrency.getQueueDepth(key);
    const available = Math.max(0, limit - active);
    return { key, active, limit, available, reserved, queueDepth };
  });

  const total = {
    active: keys.reduce((s, k) => s + k.active, 0),
    limit: keys.reduce((s, k) => s + k.limit, 0),
    queueDepth: keys.reduce((s, k) => s + k.queueDepth, 0),
    keys: keys.length,
  };

  return { keys, total };
}

export function getMetricsSnapshotFn(): MetricsSnapshot {
  return metrics.snapshot();
}

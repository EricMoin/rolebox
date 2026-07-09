import { unlinkSync } from "node:fs";
import type { DispatchTask, DispatchTaskStatus } from "./types.ts";
import { debugLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";
import { resultSidecarPath } from "./result-extractor.ts";

/** Shared mutable state injected by DispatchManager — defined in task-lifecycle.ts for manager.ts imports. */
export interface TaskLifecycleDeps {
  tasks: Map<string, DispatchTask>;
  eventState: Map<string, import("./types.ts").TaskEventState>;
  client: import("@opencode-ai/sdk").OpencodeClient;
  concurrency: import("./concurrency.ts").IConcurrencyManager;
  watchdog: import("./watchdog.ts").TaskWatchdogManager;
  config: import("./config.ts").DispatchManagerConfig;
  cancelQueue: Map<string, () => void>;
  syncControllers: Map<string, AbortController>;
  completedSyncSessions: Map<string, string>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  sidecarGCTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingNotifications: Set<string>;
  sessionToTask: Map<string, string>;
  sessionsByRequest: Map<string, number>;
  notifyOutbox: Set<string>;
  deferredIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  cleanedUpTasks: Map<string, number>;
  subagentModelKey: Map<string, string>;
  directory: string;
  sessionMonitor: {
    verifyExistence: (client: import("@opencode-ai/sdk").OpencodeClient, sessionId: string) => Promise<"exists" | "missing" | "unknown">;
  };
  cleanupTask: (taskId: string) => void;
  persistState: () => void;
  addToOutbox: (taskId: string) => void;
  sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) => Promise<boolean>;
}

const DEFAULT_CONCURRENCY_KEY = "default";

/** Derive the concurrency key for a subagent ID. */
export function deriveKey(d: TaskLifecycleDeps, subagentId: string): string {
  return d.subagentModelKey.get(subagentId) ?? DEFAULT_CONCURRENCY_KEY;
}

/** Compute the nesting depth for a task dispatched from the given parent session. */
export function computeDepth(d: TaskLifecycleDeps, parentSessionId: string): number {
  const parentTaskId = d.sessionToTask.get(parentSessionId);
  if (!parentTaskId) return 0;
  const parentTask = d.tasks.get(parentTaskId);
  if (!parentTask) return 0;
  return (parentTask.depth ?? 0) + 1;
}

/** Get the number of sessions spawned so far for the given root session. */
export function getRequestSessions(d: TaskLifecycleDeps, rootSession: string): number {
  return d.sessionsByRequest.get(rootSession) ?? 0;
}

/** Increment the request session counter for a root session. */
export function incRequestSessions(d: TaskLifecycleDeps, rootSession: string): void {
  d.sessionsByRequest.set(rootSession, (d.sessionsByRequest.get(rootSession) ?? 0) + 1);
}

/** Reset the request session counter for a root session. */
export function resetRequestSessions(d: TaskLifecycleDeps, rootSession: string): void {
  d.sessionsByRequest.delete(rootSession);
}

/**
 * Atomic compare-and-swap status transition.
 * Returns true iff THIS call won the race.
 */
export function transition(
  d: TaskLifecycleDeps,
  taskId: string,
  from: DispatchTaskStatus[],
  to: DispatchTaskStatus,
  fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
): boolean {
  const t = d.tasks.get(taskId);
  if (!t) return false;
  if (!from.includes(t.status)) return false;
  t.status = to;
  t.completedAt = fields && "completedAt" in fields ? fields.completedAt : new Date();
  if (fields?.error !== undefined) t.error = fields.error;
  return true;
}

/** Count inflight (running + pending) tasks for a given parent session. */
export function getInflightCount(d: TaskLifecycleDeps, parentSessionId: string): number {
  let count = 0;
  for (const task of d.tasks.values()) {
    if (task.parentSessionId === parentSessionId &&
        (task.status === "running" || task.status === "pending")) {
      count++;
    }
  }
  return count;
}

/** Schedule cleanup of a task (via the cleanupTask callback). */
export function scheduleCleanup(d: TaskLifecycleDeps, taskId: string): void {
  const existing = d.cleanupTimers.get(taskId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    if (d.pendingNotifications.has(taskId) || d.notifyOutbox.has(taskId)) {
      scheduleCleanup(d, taskId);
      return;
    }
    d.cleanupTask(taskId);
  }, d.config.taskTtlMs);

  d.cleanupTimers.set(taskId, timer);
}

/** Schedule garbage collection of the result sidecar file. */
export function scheduleSidecarGC(d: TaskLifecycleDeps, taskId: string): void {
  const t = d.tasks.get(taskId);
  if (!t?.result) return;

  const retention = d.config.resultRetentionMs ?? 3_600_000;
  const timer = setTimeout(() => {
    const path = resultSidecarPath(taskId, d.directory);
    try { unlinkSync(path); } catch {}
    d.sidecarGCTimers.delete(taskId);
  }, retention);
  d.sidecarGCTimers.set(taskId, timer);
}

/** Notify parent about task completion. */
export async function notifyCompletion(
  d: TaskLifecycleDeps,
  task: DispatchTask,
  remainingTasks: number,
  resultText?: string,
): Promise<boolean> {
  d.pendingNotifications.add(task.id);
  try {
    return await d.sendNotification(task, remainingTasks, resultText);
  } finally {
    d.pendingNotifications.delete(task.id);
  }
}

/** Release concurrency slot and schedule cleanup for a task that has finished running. */
export function leaveRunning(d: TaskLifecycleDeps, taskId: string): void {
  const t = d.tasks.get(taskId);
  if (!t) return;
  if (t.concurrencyKey) {
    d.concurrency.release(t.concurrencyKey, t.parentSessionId);
  } else {
    debugLog("leaveRunning", taskId, "concurrencyKey is empty — skipping release to prevent ghost slot injection");
  }
  const timer = d.deferredIdleTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    d.deferredIdleTimers.delete(taskId);
  }
  metrics.gauge("inflight_tasks").dec();
  d.persistState();
  scheduleCleanup(d, taskId);
}

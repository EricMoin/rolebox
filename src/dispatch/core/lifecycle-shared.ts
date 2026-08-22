import { unlinkSync } from "node:fs";
import type { DispatchTask, DispatchTaskStatus } from "../types.ts";
import { metrics } from "../persistence/metrics.ts";
import { resultSidecarPath } from "../completion/result-extractor.ts";
import type { ProgressStore } from "../types.progress.ts";
import { clearEmittedThresholds } from "../progress/progress-tools.ts";
import type { DispatchManagerConfig } from "../config.ts";

/** Index mapping parentSessionId → set of task IDs for O(1) lookup. */
export type ParentTasksIndex = Map<string, Set<string>>;

/**
 * Add a task ID to the parent-tasks index.
 */
export function addToParentIndex(
  index: ParentTasksIndex,
  parentSessionId: string,
  taskId: string,
): void {
  const set = index.get(parentSessionId) ?? new Set<string>();
  set.add(taskId);
  index.set(parentSessionId, set);
}

/**
 * Remove a task ID from the parent-tasks index.
 * Cleans up the parent key if the set becomes empty.
 */
export function removeFromParentIndex(
  index: ParentTasksIndex,
  parentSessionId: string,
  taskId: string,
): void {
  const set = index.get(parentSessionId);
  if (!set) return;
  set.delete(taskId);
  if (set.size === 0) {
    index.delete(parentSessionId);
  }
}

/** Shared mutable state injected by DispatchManager — defined in task-lifecycle.ts for manager.ts imports. */
export interface TaskLifecycleDeps {
  tasks: Map<string, DispatchTask>;
  eventState: Map<string, import("../types.ts").TaskEventState>;
  client: import("../../platform/ports/session-client.ts").ISessionClient;
  watchdog: import("./watchdog.ts").TaskWatchdogManager;
  config: DispatchManagerConfig;
  cancelQueue: Map<string, () => void>;
  syncControllers: Map<string, AbortController>;
  completedSyncSessions: Map<string, string>;
  completedSyncSessionsSetAt: Map<string, number>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  sidecarGCTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingNotifications: Set<string>;
  sessionToTask: Map<string, string>;
  notifyOutbox: Set<string>;
  deferredIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  cleanedUpTasks: Map<string, number>;
  subagentModelKey: Map<string, string>;
  /** Maps a dispatched agent ID to its owning root role ID — the role prefix of composite concurrency keys. */
  subagentRoleKey: Map<string, string>;
  /** Per-role merged dispatch configs keyed by root role ID — resolved by resolveDispatchingRole/effectiveConfigFor. */
  roleConfigs: ReadonlyMap<string, DispatchManagerConfig>;
  directory: string;
  sessionMonitor: {
    verifyExistence: (client: import("../../platform/ports/session-client.ts").ISessionClient, sessionId: string) => Promise<"exists" | "missing" | "unknown">;
  };
  cleanupTask: (taskId: string) => void;
  persistState: () => void;
  addToOutbox: (taskId: string) => void;
  sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) => Promise<boolean>;
  progressStore: ProgressStore;
  /** Clear per-task emitted milestone thresholds (from progress-tools.ts). */
  clearEmittedThresholds: (taskId: string) => void;
  /** Delete on-disk checkpoint data for a task (fire-and-forget). */
  deleteTaskCheckpoint: (taskId: string) => Promise<void>;
  /** Per-task terminated listeners (fire-once: auto-cleared after notify). */
  taskTerminatedListeners: Map<string, Set<Function>>;
  /** Parent→taskIds index for O(1) getTasksByParent lookups. */
  parentTasksIndex: ParentTasksIndex;
  /** Inflight running task count per parentSessionId — replaces O(n) scan in getInflightCount. */
  inflightByParent: Map<string, number>;
  /** Oldest startedAt timestamp per parentSessionId — replaces O(n) scan in getOldestInflightChildStartedAt. */
  oldestStartedAtByParent: Map<string, number>;
}

/**
 * Resolve the owning root role ID for a dispatched agent.
 *
 * Priority: the explicit subagent→role map (d.subagentRoleKey), then treating
 * the agent ID itself as a root role ID when it has a per-role dispatch config
 * (covers graph dispatch of a root role id). Returns undefined when neither
 * applies — the legacy plain-model-key path.
 */
export function resolveDispatchingRole(d: TaskLifecycleDeps, agentId: string): string | undefined {
  const roleId = d.subagentRoleKey.get(agentId);
  if (roleId !== undefined) return roleId;
  if (d.roleConfigs.has(agentId)) return agentId;
  return undefined;
}

/**
 * Resolve the effective dispatch config for a dispatched agent: the owning
 * role's merged config when a role resolves, otherwise the manager's base config.
 */
export function effectiveConfigFor(d: TaskLifecycleDeps, agentId: string): DispatchManagerConfig {
  return d.roleConfigs.get(resolveDispatchingRole(d, agentId) ?? "") ?? d.config;
}

/** Compute the nesting depth for a task dispatched from the given parent session. */
export function computeDepth(d: TaskLifecycleDeps, parentSessionId: string): number {
  const parentTaskId = d.sessionToTask.get(parentSessionId);
  if (!parentTaskId) return 0;
  const parentTask = d.tasks.get(parentTaskId);
  if (!parentTask) return 0;
  return (parentTask.depth ?? 0) + 1;
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
  const wasRunning = t.status === "running";
  t.status = to;
  t.completedAt = fields && "completedAt" in fields ? fields.completedAt : new Date();
  if (fields?.error !== undefined) t.error = fields.error;
  // Track inflight counters inline with status transitions
  if (to === "running" && !wasRunning) {
    const pid = t.parentSessionId;
    d.inflightByParent.set(pid, (d.inflightByParent.get(pid) ?? 0) + 1);
    const startedAt = t.startedAt.getTime();
    const currOldest = d.oldestStartedAtByParent.get(pid);
    if (currOldest === undefined || startedAt < currOldest) {
      d.oldestStartedAtByParent.set(pid, startedAt);
    }
  } else if (wasRunning && to !== "running") {
    // Decrement when leaving running — counter stays in sync with status
    const pid = t.parentSessionId;
    const curr = d.inflightByParent.get(pid);
    if (curr !== undefined) {
      if (curr <= 1) {
        d.inflightByParent.delete(pid);
        d.oldestStartedAtByParent.delete(pid);
      } else {
        d.inflightByParent.set(pid, curr - 1);
      }
    }
  }
  return true;
}

/** Count inflight (running + pending) tasks for a given parent session. */
export function getInflightCount(d: TaskLifecycleDeps, parentSessionId: string): number {
  return d.inflightByParent.get(parentSessionId) ?? 0;
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

/**
 * Notify parent about task completion.
 *
 * Graph-scope suppression: tasks dispatched by the graph engine (marker
 * `task.graphScoped`) are skipped entirely — graph-node completion is reported
 * EXCLUSIVELY by the graph notifier (`createGraphNotifier` /
 * `createGraphTerminalNotifier` in `src/graph/engine/graph-notify.ts`), which
 * references the node id rather than the internal `bg_*` dispatch task id.
 * Emitting both would give the emperor two reminders with two id namespaces.
 * Real-session tasks notify exactly as before.
 */
export async function notifyCompletion(
  d: TaskLifecycleDeps,
  task: DispatchTask,
  remainingTasks: number,
  resultText?: string,
): Promise<boolean> {
  if (task.graphScoped) return true;
  d.pendingNotifications.add(task.id);
  try {
    return await d.sendNotification(task, remainingTasks, resultText);
  } finally {
    d.pendingNotifications.delete(task.id);
  }
}

/** Schedule cleanup for a task that has finished running. */
export function leaveRunning(d: TaskLifecycleDeps, taskId: string): void {
  const t = d.tasks.get(taskId);
  if (!t) return;
  const timer = d.deferredIdleTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    d.deferredIdleTimers.delete(taskId);
  }
  metrics.gauge("inflight_tasks").dec();
  d.persistState();
  scheduleCleanup(d, taskId);
  clearEmittedThresholds(taskId);
}

/** Notify terminated listeners for a task (fire-once — auto-clears after notification).

 * Must be called AFTER the task status has been transitioned to its terminal value.
 * Callbacks receive (taskId, status). */

export function notifyTerminated(d: TaskLifecycleDeps, taskId: string, status: string): void {
  const t = d.tasks.get(taskId);
  if (!t) return;
  const listeners = d.taskTerminatedListeners.get(taskId);
  if (!listeners || listeners.size === 0) return;

  for (const cb of listeners) {
    try {
      (cb as (taskId: string, status: string) => void)(taskId, status);
    } catch {
      // Swallow listener errors — never crash dispatch on a misbehaving listener
    }
  }
  d.taskTerminatedListeners.delete(taskId);
}


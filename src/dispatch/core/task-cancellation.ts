import type { TaskLifecycleDeps } from "./lifecycle-shared.ts";
import {
  transition,
  getInflightCount,
  scheduleCleanup,
  notifyCompletion,
  leaveRunning,
  notifyTerminated,
} from "./lifecycle-shared.ts";
import { infoLog, debugLog } from "./debug-log.ts";
import { metrics } from "../persistence/metrics.ts";

/**
 * Cancel a dispatch task.
 * Handles pending (queued), sync, and running states.
 * Returns true if the task was actually cancelled (not already terminal).
 */
export async function cancelTask(
  d: TaskLifecycleDeps,
  taskId: string,
): Promise<boolean> {
  const task = d.tasks.get(taskId);
  if (!task) return false;

  if (
    task.status === "completed" ||
    task.status === "error" ||
    task.status === "timeout" ||
    task.status === "cancelled"
  ) {
    debugLog("cancelTask", taskId, `already in terminal status ${task.status} — skipping`);
    return false;
  }

  if (d.pendingNotifications.has(taskId)) {
    debugLog("cancelTask", taskId, `has in-flight notification — skipping`);
    return false;
  }

  // Handle pending (queued) task
  if (task.status === "pending") {
    const cancelHandle = d.cancelQueue.get(taskId);
    if (cancelHandle) {
      cancelHandle();
      d.cancelQueue.delete(taskId);
    }
    if (!transition(d, taskId, ["pending"], "cancelled")) return false;
    const t = d.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✕ cancelled (queued) agent=${t.agent}`);
    metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
    d.clearEmittedThresholds(taskId);
    notifyTerminated(d, taskId, "cancelled");
    void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
    scheduleCleanup(d, taskId);
    return true;
  }

  // Sync task
  if (task.mode === "sync") {
    const controller = d.syncControllers.get(taskId);
    if (controller) {
      if (task.sessionId) {
        try {
          await d.client.abort(task.sessionId);
        } catch (err) {
          debugLog("cancelTask", taskId, `Session cancel failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      controller.abort();
    }
    if (!transition(d, taskId, ["pending"], "cancelled")) return false;
    const t = d.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✕ cancelled (sync) agent=${t.agent}`);
    metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
    d.clearEmittedThresholds(taskId);
    notifyTerminated(d, taskId, "cancelled");
    return true;
  }

  // Running task
  if (!transition(d, taskId, ["pending", "running"], "cancelled")) return false;

  try {
    await d.client.abort(task.sessionId);
  } catch (err) {
    debugLog("cancelTask", taskId, `Session cancel failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
  }
  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `✕ cancelled agent=${t.agent}`);
  metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);
  d.clearEmittedThresholds(taskId);
  notifyTerminated(d, taskId, "cancelled");
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
  return true;
}

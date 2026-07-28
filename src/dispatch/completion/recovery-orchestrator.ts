import type { CompletionOrchestratorDeps } from "./completion-orchestrator.ts";
import type { DispatchTask } from "../types.ts";
import { DISPATCH_RECOVERY_MARKER } from "../notification.ts";
import { debugLog } from "../core/debug-log.ts";
import { metrics } from "../persistence/metrics.ts";
import { buildReminder } from "../../prompt/reminder.ts";

const DEFAULT_CONCURRENCY_KEY = "default";

export async function recoverOrchestrator(
  deps: CompletionOrchestratorDeps,
  isRecovered: () => boolean,
  setRecovered: () => void,
  scheduleCleanupCb: (taskId: string) => void,
  cleanupTaskCb: (taskId: string) => void,
  persistStateCb: () => void,
): Promise<void> {
  if (isRecovered()) return;
  setRecovered();

  if (!deps.store.tryLock()) {
    debugLog("recover", "*", "Could not acquire state lock, operating in read-only recover mode");
  }

  restoreState(deps);

  const runningTasks: DispatchTask[] = [];
  const toRemove: string[] = [];
  const lostPendingByParent = new Map<string, DispatchTask[]>();

  for (const [taskId, task] of deps.tasks) {
    switch (task.status) {
      case "pending": {
        toRemove.push(taskId);
        const siblings = lostPendingByParent.get(task.parentSessionId) ?? [];
        siblings.push(task);
        lostPendingByParent.set(task.parentSessionId, siblings);
        break;
      }
      case "running": {
        if (task.mode === "sync") {
          task.status = "error";
          task.error = "Sync task interrupted by restart";
          task.completedAt = new Date();
          scheduleCleanupFromRecovery(deps, task, scheduleCleanupCb, cleanupTaskCb);
          debugLog("recover", taskId, "sync task interrupted by restart — marked error, NOT notified");
        } else {
          runningTasks.push(task);
        }
        break;
      }
      case "completed":
        if (!task.result) {
          debugLog("recover", taskId, "completed task without result — lazy fetch on first read");
        }
        scheduleCleanupFromRecovery(deps, task, scheduleCleanupCb, cleanupTaskCb);
        break;
      case "error":
      case "timeout":
      case "cancelled":
        scheduleCleanupFromRecovery(deps, task, scheduleCleanupCb, cleanupTaskCb);
        break;
    }
  }

  for (const id of toRemove) {
    deps.tasks.delete(id);
  }

  for (const [parentSessionId, lostTasks] of lostPendingByParent) {
    void notifyLostPendingTasks(deps, parentSessionId, lostTasks);
  }

  for (const task of runningTasks) {
    try {
      const result = await deps.client.get(task.sessionId);
      if (result) {
        const key = task.concurrencyKey ?? DEFAULT_CONCURRENCY_KEY;
        const occupied = deps.concurrency.forceOccupyBackground(key, 1, task.parentSessionId);
        if (occupied === 1) {
          task.concurrencyKey = key;
          deps.watchdog.registerTask(task.id);
          deps.sessionToTask.set(task.sessionId, task.id);
          deps.eventState.set(task.id, {
            lastMessageCount: 0,
            lastProgressUpdate: Date.now(),
            hasProducedOutput: false,
            lastEventAt: Date.now(),
            messageCountAtStart: task.messageCountAtStart ?? 0,
            consecutiveFetchFailures: 0,
          });
        } else {
          deps._transition!(task.id, ["running"], "error", {
            error: "Exceeded concurrency limit on recovery",
          });
          void deps.sendNotification(task, deps.getInflightCount(task.parentSessionId));
          scheduleCleanupCb(task.id);
          debugLog("recover", task.id, "dropped — concurrency limit exceeded on recovery");
        }
      } else {
        task.status = "error";
        task.error = "Session lost after process restart — You can re-dispatch with dispatch(...)";
        task.completedAt = new Date();
        void deps.sendNotification(task, deps.getInflightCount(task.parentSessionId));
        scheduleCleanupCb(task.id);
        debugLog("recover", task.id, "session gone after restart");
      }
    } catch {
      task.status = "error";
      task.error = "Session verification failed after restart — You can re-dispatch with dispatch(...)";
      task.completedAt = new Date();
      void deps.sendNotification(task, deps.getInflightCount(task.parentSessionId));
      scheduleCleanupCb(task.id);
    }
  }

  if (toRemove.length > 0 || runningTasks.length > 0) {
    persistStateCb();
  }
}

function restoreState(deps: CompletionOrchestratorDeps): void {
  const loaded = deps.store.load();
  if (!loaded) return;
  const { tasks: loadedTasks, outbox, eventState: loadedEventState } = loaded;
  for (const [taskId, task] of loadedTasks) {
    deps.tasks.set(taskId, task);
  }
  for (const id of outbox) {
    deps.notifyOutbox.add(id);
  }
  for (const [taskId, es] of loadedEventState) {
    deps.eventState.set(taskId, es);
  }
}

async function notifyLostPendingTasks(
  deps: CompletionOrchestratorDeps,
  parentSessionId: string,
  lostTasks: DispatchTask[],
): Promise<void> {
  const taskList = lostTasks
    .map((t) => `- ${t.description || t.id}`)
    .join("\n");
  const text = buildReminder({
    marker: DISPATCH_RECOVERY_MARKER,
    fields: [{ label: "count", value: String(lostTasks.length) }],
    action: "You can re-dispatch these tasks with dispatch(...).",
    body: taskList,
  });

  const parentAgent = lostTasks[0]?.parentAgent;
  try {
    await deps.client.prompt(parentSessionId, {
      ...(parentAgent ? { agent: parentAgent } : {}),
      parts: [{ type: "text", text }],
      noReply: true,
    });
    metrics.counter("notify_sent_total").inc();
  } catch (err) {
    metrics.counter("notify_failed_total").inc();
    debugLog("recover", "notify",
      `Failed to notify parent ${parentSessionId} about lost pending tasks`);
  }
}

function scheduleCleanupFromRecovery(
  deps: CompletionOrchestratorDeps,
  task: DispatchTask,
  scheduleCleanupCb: (taskId: string) => void,
  cleanupTaskCb: (taskId: string) => void,
): void {
  if (!task.completedAt) {
    scheduleCleanupCb(task.id);
    return;
  }
  const elapsed = Date.now() - new Date(task.completedAt).getTime();
  const remaining = Math.max(deps.config.taskTtlMs - elapsed, 0);
  if (remaining === 0) {
    cleanupTaskCb(task.id);
    return;
  }
  const timer = setTimeout(() => {
    cleanupTaskCb(task.id);
  }, remaining);
  deps.cleanupTimers.set(task.id, timer);
}

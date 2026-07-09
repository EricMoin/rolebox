import type { DispatchTask } from "../types.ts";
import type { CompletionOrchestratorDeps } from "../completion/completion-orchestrator.ts";
import { debugLog } from "../core/debug-log.ts";

/**
 * Debounced asynchronous state persistence. Safe to call frequently.
 */
export function persistState(deps: CompletionOrchestratorDeps): void {
  deps._dirtyInternal = true;
  if (deps._persistTimerInternal) return;
  deps._persistTimerInternal = setTimeout(async () => {
    deps._persistTimerInternal = undefined;
    if (!deps._dirtyInternal) return;
    deps._dirtyInternal = false;
    try {
      await deps.store.save(deps.tasks, deps.notifyOutbox, deps.eventState);
    } catch (err) {
      debugLog("persist", "*", `async save failed: ${err}`);
    }
    try {
      await deps.metricsPersister.persist();
    } catch (err) {
      debugLog("persist", "*", `metrics persist failed: ${err}`);
    }
  }, 500);
}

/**
 * Adds a task ID to the notification outbox and triggers persistence.
 */
export function addToOutbox(deps: CompletionOrchestratorDeps, taskId: string): void {
  deps.notifyOutbox.add(taskId);
  persistState(deps);
}

/**
 * Force synchronous flush of any pending persistState writes.
 */
export async function flushPersist(deps: CompletionOrchestratorDeps): Promise<void> {
  if (deps._persistTimerInternal) {
    clearTimeout(deps._persistTimerInternal);
    deps._persistTimerInternal = undefined;
  }
  if (deps._dirtyInternal) {
    deps._dirtyInternal = false;
    await deps.store.save(deps.tasks, deps.notifyOutbox, deps.eventState);
  }
  await deps.metricsPersister.persist();
}

/**
 * Synchronous version of flushPersist() for process-exit crash safety.
 */
export function flushPersistSync(deps: CompletionOrchestratorDeps): void {
  if (deps._persistTimerInternal) {
    clearTimeout(deps._persistTimerInternal);
    deps._persistTimerInternal = undefined;
  }
  if (deps._dirtyInternal) {
    deps._dirtyInternal = false;
    try {
      deps.store.saveSync(deps.tasks, deps.notifyOutbox, deps.eventState);
    } catch (err) {
      debugLog("persist", "*", `sync flush failed: ${err}`);
    }
    deps.metricsPersister.flushSync();
    deps.metricsPersister.dispose();
  }
  if (deps._budgetSamplerTimer) {
    clearInterval(deps._budgetSamplerTimer);
    deps._budgetSamplerTimer = undefined;
  }
  if (deps._sweeperTimerInternal) {
    clearInterval(deps._sweeperTimerInternal);
    deps._sweeperTimerInternal = undefined;
  }
  for (const timer of deps.sidecarGCTimers.values()) {
    clearTimeout(timer);
  }
  deps.sidecarGCTimers.clear();
  for (const timer of deps.deferredIdleTimers.values()) {
    clearTimeout(timer);
  }
  deps.deferredIdleTimers.clear();
  for (const timer of deps.cleanupTimers.values()) {
    clearTimeout(timer);
  }
  deps.cleanupTimers.clear();
  deps.watchdog.dispose();
}

/**
 * Remove a task and its event state from all in-memory maps, persist,
 * and schedule-side cleanup of sidecar files.
 */
export function cleanupTask(deps: CompletionOrchestratorDeps, taskId: string): void {
  const t = deps.tasks.get(taskId);
  if (t?.sessionId) deps.sessionToTask.delete(t.sessionId);
  deps.eventState.delete(taskId);
  deps.tasks.delete(taskId);

  persistState(deps);
  deps.cleanedUpTasks.set(taskId, Date.now());
  if (deps.cleanedUpTasks.size > 500) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [key, ts] of deps.cleanedUpTasks) {
      if (ts < oldestTime) {
        oldestTime = ts;
        oldestKey = key;
      }
    }
    if (oldestKey) deps.cleanedUpTasks.delete(oldestKey);
  }
  const timer = deps.cleanupTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    deps.cleanupTimers.delete(taskId);
  }
}

/**
 * Schedule a delayed cleanup. Used by recovery.
 */
export function scheduleCleanup(deps: CompletionOrchestratorDeps, taskId: string): void {
  const existing = deps.cleanupTimers.get(taskId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    if (deps.pendingNotifications.has(taskId) || deps.notifyOutbox.has(taskId)) {
      scheduleCleanup(deps, taskId);
      return;
    }
    cleanupTask(deps, taskId);
  }, deps.config.taskTtlMs);

  deps.cleanupTimers.set(taskId, timer);
}

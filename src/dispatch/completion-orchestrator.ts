import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  DispatchTask,
  DispatchTaskStatus,
  DispatchManagerConfig,
  TaskEventState,
} from "./types.ts";
import {
  OUTBOX_SWEEP_INTERVAL_MS,
  DEFAULT_BUDGET_SAMPLE_INTERVAL_MS,
  MATERIALIZE_TIMEOUT_MS,
  RESULT_RETENTION_MS,
} from "./config.ts";
import { unlinkSync } from "node:fs";
import type { IConcurrencyManager } from "./concurrency.ts";
import { TaskWatchdogManager } from "./watchdog.ts";
import { SessionMonitor } from "./session-monitor.ts";
import { MetricsPersister } from "./metrics-persister.ts";
import { BudgetTracker } from "./budget-tracker.ts";
import { TaskStateStore } from "./task-store.ts";
import { hasFinalNotifyBeenSent, DISPATCH_RECOVERY_MARKER } from "./notification.ts";
import { extractResultBlock, readResultSidecar } from "./result-extractor.ts";
import { debugLog, infoLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";
import { withTimeout, TimeoutError } from "./with-timeout.ts";

const DEFAULT_CONCURRENCY_KEY = "default";

export interface CompletionOrchestratorDeps {
  tasks: Map<string, DispatchTask>;
  eventState: Map<string, TaskEventState>;
  client: OpencodeClient;
  concurrency: IConcurrencyManager;
  watchdog: TaskWatchdogManager;
  config: DispatchManagerConfig;
  sessionToTask: Map<string, string>;
  notifyOutbox: Set<string>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  sidecarGCTimers: Map<string, ReturnType<typeof setTimeout>>;
  cleanedUpTasks: Map<string, number>;
  deferredIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingNotifications: Set<string>;
  sessionMonitor: SessionMonitor;
  budgetTracker: BudgetTracker;
  store: TaskStateStore;
  metricsPersister: MetricsPersister;
  directory: string;

  /** Callback to get inflight count for the sweeper. */
  getInflightCount: (parentSessionId: string) => number;
  /** Callback for sending completion notifications (routes through DispatchManager.notifyCompletion). */
  sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) => Promise<boolean>;
  /** Callback to cancel a task from the budget sampler. */
  cancelTask: (taskId: string) => Promise<boolean>;
}

/**
 * Owns all completion-orchestration responsibilities that were formerly
 * private methods of DispatchManager: persistence, sweeper, budget sampler,
 * recovery, and the shared-state cleanup / transition primitives.
 *
 * All Map/Set references are shared with the owning DispatchManager and
 * TaskLifecycleManager — mutations are visible across all three.
 */
export class CompletionOrchestrator {
  private d: CompletionOrchestratorDeps;
  private _recovered = false;
  private _dirty = false;
  private _persistTimer: ReturnType<typeof setTimeout> | undefined;
  private sweeperTimer: ReturnType<typeof setInterval> | undefined;
  private _budgetSamplerTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: CompletionOrchestratorDeps) {
    this.d = deps;
  }

  // ── Cleanup ────────────────────────────────────────────────────

  /**
   * Remove a task and its event state from all in-memory maps, persist,
   * and schedule-side cleanup of sidecar files.
   */
  cleanupTask(taskId: string): void {
    const t = this.d.tasks.get(taskId);
    if (t?.sessionId) this.d.sessionToTask.delete(t.sessionId);
    this.d.eventState.delete(taskId);
    this.d.tasks.delete(taskId);

    this.persistState();
    this.d.cleanedUpTasks.set(taskId, Date.now());
    if (this.d.cleanedUpTasks.size > 500) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [key, ts] of this.d.cleanedUpTasks) {
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestKey = key;
        }
      }
      if (oldestKey) this.d.cleanedUpTasks.delete(oldestKey);
    }
    const timer = this.d.cleanupTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.d.cleanupTimers.delete(taskId);
    }
  }

  /**
   * Schedule a delayed cleanup. Used by recovery.
   */
  scheduleCleanup(taskId: string): void {
    const existing = this.d.cleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      if (this.d.pendingNotifications.has(taskId) || this.d.notifyOutbox.has(taskId)) {
        this.scheduleCleanup(taskId);
        return;
      }
      this.cleanupTask(taskId);
    }, this.d.config.taskTtlMs);

    this.d.cleanupTimers.set(taskId, timer);
  }

  // ── Persistence ────────────────────────────────────────────────

  /**
   * Debounced asynchronous state persistence. Safe to call frequently.
   */
  persistState(): void {
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(async () => {
      this._persistTimer = undefined;
      if (!this._dirty) return;
      this._dirty = false;
      try {
        await this.d.store.save(this.d.tasks, this.d.notifyOutbox);
      } catch (err) {
        debugLog("persist", "*", `async save failed: ${err}`);
      }
      try {
        await this.d.metricsPersister.persist();
      } catch (err) {
        debugLog("persist", "*", `metrics persist failed: ${err}`);
      }
    }, 500);
  }

  /**
   * Adds a task ID to the notification outbox and triggers persistence.
   */
  addToOutbox(taskId: string): void {
    this.d.notifyOutbox.add(taskId);
    this.persistState();
  }

  /**
   * Force synchronous flush of any pending persistState writes.
   */
  async flushPersist(): Promise<void> {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    if (this._dirty) {
      this._dirty = false;
      await this.d.store.save(this.d.tasks, this.d.notifyOutbox);
    }
    await this.d.metricsPersister.persist();
  }

  /**
   * Synchronous version of flushPersist() for process-exit crash safety.
   */
  flushPersistSync(): void {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    if (this._dirty) {
      this._dirty = false;
      try {
        this.d.store.saveSync(this.d.tasks, this.d.notifyOutbox);
      } catch (err) {
        debugLog("persist", "*", `sync flush failed: ${err}`);
      }
      this.d.metricsPersister.flushSync();
      this.d.metricsPersister.dispose();
    }
    if (this._budgetSamplerTimer) {
      clearInterval(this._budgetSamplerTimer);
      this._budgetSamplerTimer = undefined;
    }
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = undefined;
    }
    for (const timer of this.d.sidecarGCTimers.values()) {
      clearTimeout(timer);
    }
    this.d.sidecarGCTimers.clear();
    for (const timer of this.d.deferredIdleTimers.values()) {
      clearTimeout(timer);
    }
    this.d.deferredIdleTimers.clear();
    for (const timer of this.d.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.d.cleanupTimers.clear();
    this.d.watchdog.dispose();
  }

  // ── Sweeper ────────────────────────────────────────────────────

  startSweeper(): void {
    const interval = this.d.config.outboxSweepIntervalMs ?? OUTBOX_SWEEP_INTERVAL_MS;
    this.sweeperTimer = setInterval(async () => {
      for (const taskId of this.d.notifyOutbox) {
        const task = this.d.tasks.get(taskId);
        if (!task || hasFinalNotifyBeenSent(taskId)) {
          this.d.notifyOutbox.delete(taskId);
          continue;
        }

        // INVARIANT: every taskId in notifyOutbox is a FINAL notification.
        // materializeAndNotify() only calls addToOutbox() when remaining === 0, and
        // restoreState() rehydrates only previously-final entries. Intermediate
        // notifications (remaining > 0) are fire-and-forget and never enter the outbox.
        //
        // Therefore the sweeper MUST NOT re-check the live inflight count here. That
        // count is mutable — the parent may dispatch UNRELATED new tasks after this
        // final notification was queued but before its send succeeds. Gating on it would
        // silently drop a legitimate, undelivered final notification, leaving the parent
        // waiting forever for a completion signal it never receives. Idempotency is
        // already guaranteed by the hasFinalNotifyBeenSent() check above.

        let sweeperResultText: string | undefined;
        if (task.result?.sidecarPath && !task.result.fetchError) {
          const sidecarText = readResultSidecar(task.result.sidecarPath);
          if (sidecarText !== null) {
            sweeperResultText = extractResultBlock(sidecarText).result;
          }
        }
        const sent = await this.d.sendNotification(
          task,
          0,
          sweeperResultText,
        );
        if (sent) {
          this.d.notifyOutbox.delete(taskId);
        }
      }
    }, interval);
  }

  // ── Budget sampler ─────────────────────────────────────────────

  startBudgetSampler(): void {
    const interval = this.d.config.budgetSampleIntervalMs ?? DEFAULT_BUDGET_SAMPLE_INTERVAL_MS;

    const hasBudgetLimits =
      this.d.config.maxInputTokensPerRequest !== undefined ||
      this.d.config.maxOutputTokensPerRequest !== undefined ||
      this.d.config.maxCostPerRequest !== undefined ||
      this.d.config.maxInputTokensPerSession !== undefined ||
      this.d.config.maxCostPerSession !== undefined;

    if (!hasBudgetLimits) return;

    this._budgetSamplerTimer = setInterval(async () => {
      await this.sampleBudgetUsage();
    }, interval);
  }

  private async sampleBudgetUsage(): Promise<void> {
    for (const [sessionId, taskId] of this.d.sessionToTask) {
      const task = this.d.tasks.get(taskId);
      if (!task || task.status !== "running") continue;

      try {
        const msgResult = await withTimeout(
          this.d.client.session.messages({ path: { id: sessionId } }),
          this.d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
          "budgetSampler:session.messages",
        );

        if (msgResult.error !== undefined || !msgResult.data) continue;

        const messages = msgResult.data as Array<{
          cost?: number;
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: number };
        }>;

        let inputTokens = 0;
        let outputTokens = 0;
        let cost = 0;

        for (const msg of messages) {
          if (msg.tokens) {
            inputTokens += msg.tokens.input ?? 0;
            outputTokens += msg.tokens.output ?? 0;
          }
          if (msg.cost !== undefined) {
            cost += msg.cost;
          }
        }

        this.d.budgetTracker.recordUsage(
          sessionId,
          task.parentSessionId,
          { input: inputTokens, output: outputTokens },
          cost,
        );

        const sessionCheck = this.d.budgetTracker.isSessionBudgetExceeded(sessionId);
        if (sessionCheck.exceeded) {
          infoLog("budget", taskId, `session budget exceeded — cancelling: ${sessionCheck.reason}`);
          metrics.counter("dispatch_rejected_total", { reason: "session-budget-exceeded" }).inc();
          void this.d.cancelTask(taskId);
        }
      } catch (err) {
        debugLog("budget", taskId, `sampler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Recovery ───────────────────────────────────────────────────

  async recover(): Promise<void> {
    if (this._recovered) return;
    this._recovered = true;

    if (!this.d.store.tryLock()) {
      debugLog("recover", "*", "Could not acquire state lock, operating in read-only recover mode");
    }

    this.restoreState();

    const runningTasks: DispatchTask[] = [];
    const toRemove: string[] = [];
    const lostPendingByParent = new Map<string, DispatchTask[]>();

    for (const [taskId, task] of this.d.tasks) {
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
            this.scheduleCleanupFromRecovery(taskId, task);
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
          this.scheduleCleanupFromRecovery(taskId, task);
          break;
        case "error":
        case "timeout":
        case "cancelled":
          this.scheduleCleanupFromRecovery(taskId, task);
          break;
      }
    }

    for (const id of toRemove) {
      this.d.tasks.delete(id);
    }

    for (const [parentSessionId, lostTasks] of lostPendingByParent) {
      void this.notifyLostPendingTasks(parentSessionId, lostTasks);
    }

    for (const task of runningTasks) {
      try {
        const result = await this.d.client.session.get({
          path: { id: task.sessionId },
        });
        if (result.data) {
          const key = task.concurrencyKey ?? DEFAULT_CONCURRENCY_KEY;
          const occupied = this.d.concurrency.forceOccupyBackground(key, 1, task.parentSessionId);
          if (occupied === 1) {
            task.concurrencyKey = key;
            this.d.watchdog.registerTask(task.id);
            this.d.sessionToTask.set(task.sessionId, task.id);
            this.d.eventState.set(task.id, {
              lastMessageCount: 0,
              lastProgressUpdate: Date.now(),
              hasProducedOutput: false,
              messageCountAtStart: task.messageCountAtStart ?? 0,
              lastEventAt: Date.now(),
            });
            debugLog("recover", task.id, `session ${task.sessionId} alive — re-registered`);
          } else {
            this.transition(task.id, ["running"], "error", {
              error: "Exceeded concurrency limit on recovery",
            });
            void this.d.sendNotification(task, this.d.getInflightCount(task.parentSessionId));
            this.scheduleCleanup(task.id);
            debugLog("recover", task.id, "dropped — concurrency limit exceeded on recovery");
          }
        } else {
          task.status = "error";
          task.error = "Session lost after process restart — You can re-dispatch with dispatch(...)";
          task.completedAt = new Date();
          void this.d.sendNotification(task, this.d.getInflightCount(task.parentSessionId));
          this.scheduleCleanup(task.id);
          debugLog("recover", task.id, "session gone after restart");
        }
      } catch {
        task.status = "error";
        task.error = "Session verification failed after restart — You can re-dispatch with dispatch(...)";
        task.completedAt = new Date();
        void this.d.sendNotification(task, this.d.getInflightCount(task.parentSessionId));
        this.scheduleCleanup(task.id);
      }
    }

    if (toRemove.length > 0 || runningTasks.length > 0) {
      this.persistState();
    }
  }

  private restoreState(): void {
    const loaded = this.d.store.load();
    if (!loaded) return;
    const { tasks: loadedTasks, outbox } = loaded;
    for (const [taskId, task] of loadedTasks) {
      this.d.tasks.set(taskId, task);
    }
    for (const id of outbox) {
      this.d.notifyOutbox.add(id);
    }
  }

  private async notifyLostPendingTasks(
    parentSessionId: string,
    lostTasks: DispatchTask[],
  ): Promise<void> {
    const taskList = lostTasks
      .map((t) => `- ${t.description || t.id}`)
      .join("\n");
    const text = [
      "<system-reminder>",
      DISPATCH_RECOVERY_MARKER,
      `**${lostTasks.length} pending task(s) were lost during process restart:**`,
      taskList,
      "",
      "You can re-dispatch these tasks with dispatch(...).",
      "</system-reminder>",
    ].join("\n");

    const parentAgent = lostTasks[0]?.parentAgent;
    try {
      await this.d.client.session.promptAsync({
        path: { id: parentSessionId },
        body: {
          ...parentAgent ? { agent: parentAgent } : {},
          parts: [{ type: "text", text }],
          noReply: true,
        },
      });
      metrics.counter("notify_sent_total").inc();
    } catch (err) {
      metrics.counter("notify_failed_total").inc();
      debugLog("recover", "notify",
        `Failed to notify parent ${parentSessionId} about lost pending tasks`);
    }
  }

  private scheduleCleanupFromRecovery(taskId: string, task: DispatchTask): void {
    if (!task.completedAt) {
      this.scheduleCleanup(taskId);
      return;
    }
    const elapsed = Date.now() - new Date(task.completedAt).getTime();
    const remaining = Math.max(this.d.config.taskTtlMs - elapsed, 0);
    if (remaining === 0) {
      this.cleanupTask(taskId);
      return;
    }
    const timer = setTimeout(() => {
      this.cleanupTask(taskId);
    }, remaining);
    this.d.cleanupTimers.set(taskId, timer);
  }

  /**
   * Atomic compare-and-swap status transition. Returns true iff THIS call won the race.
   * Used in recovery paths that need direct access.
   */
  private transition(
    taskId: string,
    from: DispatchTaskStatus[],
    to: DispatchTaskStatus,
    fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
  ): boolean {
    const t = this.d.tasks.get(taskId);
    if (!t) return false;
    if (!from.includes(t.status)) return false;
    t.status = to;
    t.completedAt = fields && "completedAt" in fields ? fields.completedAt : new Date();
    if (fields?.error !== undefined) t.error = fields.error;
    return true;
  }
}

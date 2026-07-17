import type { ISessionClient } from "../../platform/ports/session-client.ts";
import type {
  DispatchTask,
  DispatchTaskStatus,
  DispatchManagerConfig,
  TaskEventState,
} from "../types.ts";
import { OUTBOX_SWEEP_INTERVAL_MS } from "../config.ts";
import type { IConcurrencyManager } from "../concurrency/concurrency.ts";
import { TaskWatchdogManager } from "../core/watchdog.ts";
import { SessionMonitor } from "./session-monitor.ts";
import { MetricsPersister } from "../persistence/metrics-persister.ts";
import { BudgetTracker } from "../budget/budget-tracker.ts";
import { TaskStateStore } from "../persistence/task-store.ts";
import { hasFinalNotifyBeenSent } from "../notification.ts";
import { extractResultBlock, readResultSidecar, cleanupOrphanSidecars } from "./result-extractor.ts";
import { debugLog } from "../core/debug-log.ts";
import { startBudgetSampler } from "../budget/budget-sampler.ts";
import {
  cleanupTask as cleanupTaskFn,
  scheduleCleanup as scheduleCleanupFn,
  persistState as persistStateFn,
  addToOutbox as addToOutboxFn,
  flushPersist as flushPersistFn,
  flushPersistSync as flushPersistSyncFn,
} from "../persistence/persist-helpers.ts";
import { recoverOrchestrator } from "./recovery-orchestrator.ts";
import type { CheckpointStore } from "../types.checkpoint.ts";
import type { ProgressStore } from "../types.progress.ts";
import type { ParentTasksIndex } from "../core/lifecycle-shared.ts";


export interface CompletionOrchestratorDeps {
  tasks: Map<string, DispatchTask>;
  eventState: Map<string, TaskEventState>;
  client: ISessionClient;
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
  checkpointStore: CheckpointStore;
  progressStore: ProgressStore;
  clearEmittedThresholds: (taskId: string) => void;

  /** Internal mutable state shared with persist-helpers. */
  _dirtyInternal?: boolean;
  _persistTimerInternal?: ReturnType<typeof setTimeout> | undefined;
  /** Timer handle set by budget sampler — cleared in flushPersistSync. */
  _budgetSamplerTimer?: ReturnType<typeof setInterval> | undefined;
  /** Timer handle set by sweeper — cleared in flushPersistSync. */
  _sweeperTimerInternal?: ReturnType<typeof setInterval> | undefined;
  /** Transition function injected by the orchestrator for recovery use. */
  _transition?: (
    taskId: string,
    from: DispatchTaskStatus[],
    to: DispatchTaskStatus,
    fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
  ) => boolean;

  /** Callback to get inflight count for the sweeper. */
  getInflightCount: (parentSessionId: string) => number;
  /** Callback for sending completion notifications (routes through DispatchManager.notifyCompletion). */
  sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) => Promise<boolean>;
  /** Callback to cancel a task from the budget sampler. */
  cancelTask: (taskId: string) => Promise<boolean>;
  /** Parent→taskIds index for O(1) getTasksByParent lookups. */
  parentTasksIndex: ParentTasksIndex;
  /** Inflight running task count per parentSessionId — shared with TaskLifecycleDeps for O(1) getInflightCount. */
  inflightByParent: Map<string, number>;
  /** Oldest startedAt timestamp per parentSessionId — shared with TaskLifecycleDeps for O(1) getOldestInflightChildStartedAt. */
  oldestStartedAtByParent: Map<string, number>;
}

/**
 * Owns all completion-orchestration responsibilities that were formerly
 * private methods of DispatchManager: persistence, sweeper, budget sampler,
 * recovery, and the shared-state cleanup / transition primitives.
 *
 * All Map/Set references are shared with the owning DispatchManager and
 * TaskLifecycleManager — mutations are visible across all three.
 */
/**
 * Bridge interface for private methods/fields accessed by DispatchManager via `(this.orchestrator as any)`.
 * Provides type-safe access without exposing the full internal API.
 */
export interface OrchestratorBridge {
  readonly _dirty: boolean;
  readonly _persistTimer: ReturnType<typeof setTimeout> | undefined;
  readonly sweeperTimer: ReturnType<typeof setInterval> | undefined;
  transition(
    taskId: string,
    from: DispatchTaskStatus[],
    to: DispatchTaskStatus,
    fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
  ): boolean;
  setStore(store: TaskStateStore): void;
  setMetricsPersister(persister: MetricsPersister): void;
  setDirectory(directory: string): void;
}

export class CompletionOrchestrator implements OrchestratorBridge {
  private d: CompletionOrchestratorDeps;
  private _recovered = false;

  get _dirty(): boolean { return !!this.d._dirtyInternal; }

  get _persistTimer(): ReturnType<typeof setTimeout> | undefined { return this.d._persistTimerInternal; }
  get sweeperTimer(): ReturnType<typeof setInterval> | undefined { return this.d._sweeperTimerInternal; }

  constructor(deps: CompletionOrchestratorDeps) {
    this.d = deps;
    // Initialize internal mutable state on deps so extracted modules can access them
    this.d._dirtyInternal = false;
    this.d._persistTimerInternal = undefined;
    this.d._budgetSamplerTimer = undefined;
    this.d._sweeperTimerInternal = undefined;
    // Bind transition for recovery orchestrator
    this.d._transition = this.transition.bind(this);
  }

  // ── Dispose ───────────────────────────────────────────────────

  dispose(): void {
    if (this.d._sweeperTimerInternal) {
      clearInterval(this.d._sweeperTimerInternal);
      this.d._sweeperTimerInternal = undefined;
    }
    if (this.d._budgetSamplerTimer) {
      clearInterval(this.d._budgetSamplerTimer);
      this.d._budgetSamplerTimer = undefined;
    }
    if (this.d._persistTimerInternal) {
      clearTimeout(this.d._persistTimerInternal);
      this.d._persistTimerInternal = undefined;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────

  cleanupTask(taskId: string): void {
    cleanupTaskFn(this.d, taskId);
  }

  scheduleCleanup(taskId: string): void {
    scheduleCleanupFn(this.d, taskId);
  }

  // ── Persistence ────────────────────────────────────────────────

  persistState(): void {
    persistStateFn(this.d);
  }

  addToOutbox(taskId: string): void {
    addToOutboxFn(this.d, taskId);
  }

  async flushPersist(): Promise<void> {
    await flushPersistFn(this.d);
  }

  flushPersistSync(): void {
    flushPersistSyncFn(this.d);
  }

  // ── Sweeper ────────────────────────────────────────────────────

  startSweeper(): void {
    const interval = this.d.config.outboxSweepIntervalMs ?? OUTBOX_SWEEP_INTERVAL_MS;
    this.d._sweeperTimerInternal = setInterval(async () => {
      // Fire-and-forget periodic checkpoint cleanup (never blocks outbox processing)
      this.d.checkpointStore.cleanupExpired(this.d.config.taskTtlMs ?? 1_800_000).catch(() => {});
      // Fire-and-forget periodic orphan sidecar cleanup
      cleanupOrphanSidecars(
        this.d.directory,
        this.d.tasks as unknown as ReadonlyMap<string, unknown>,
        this.d.config.resultRetentionMs ?? 86_400_000,
      );
      for (const taskId of this.d.notifyOutbox) {
        const task = this.d.tasks.get(taskId);
        if (!task || hasFinalNotifyBeenSent(taskId)) {
          this.d.notifyOutbox.delete(taskId);
          continue;
        }
        let sweeperResultText: string | undefined;
        if (task.result?.sidecarPath && !task.result.fetchError) {
          const sidecarText = readResultSidecar(task.result.sidecarPath);
          if (sidecarText !== null) {
            sweeperResultText = extractResultBlock(sidecarText).result;
          }
        }
        const sent = await this.d.sendNotification(task, 0, sweeperResultText);
        if (sent) {
          this.d.notifyOutbox.delete(taskId);
        }
      }
    }, interval);
  }

  // ── Budget sampler ─────────────────────────────────────────────

  startBudgetSampler(): void {
    this.d._budgetSamplerTimer = startBudgetSampler(this.d) ?? undefined;
  }

  // ── Recovery ───────────────────────────────────────────────────

  async recover(): Promise<void> {
    await recoverOrchestrator(
      this.d,
      () => this._recovered,
      () => { this._recovered = true; },
      (taskId) => this.scheduleCleanup(taskId),
      (taskId) => this.cleanupTask(taskId),
      () => this.persistState(),
    );
  }

  // ── Transition ─────────────────────────────────────────────────

  transition(
    taskId: string,
    from: DispatchTaskStatus[],
    to: DispatchTaskStatus,
    fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
  ): boolean {
    const t = this.d.tasks.get(taskId);
    if (!t) return false;
    if (!from.includes(t.status)) return false;
    const wasRunning = t.status === "running";
    t.status = to;
    t.completedAt = fields && "completedAt" in fields ? fields.completedAt : new Date();
    if (fields?.error !== undefined) t.error = fields.error;
    // Track inflight counters (mirrors lifecycle-shared.ts transition() logic)
    if (to === "running" && !wasRunning) {
      const pid = t.parentSessionId;
      this.d.inflightByParent.set(pid, (this.d.inflightByParent.get(pid) ?? 0) + 1);
      const startedAt = t.startedAt.getTime();
      const currOldest = this.d.oldestStartedAtByParent.get(pid);
      if (currOldest === undefined || startedAt < currOldest) {
        this.d.oldestStartedAtByParent.set(pid, startedAt);
      }
    } else if (wasRunning && to !== "running") {
      const pid = t.parentSessionId;
      const curr = this.d.inflightByParent.get(pid);
      if (curr !== undefined) {
        if (curr <= 1) {
          this.d.inflightByParent.delete(pid);
          this.d.oldestStartedAtByParent.delete(pid);
        } else {
          this.d.inflightByParent.set(pid, curr - 1);
        }
      }
    }
    return true;
  }

  // ── Bridge setter methods (mutate deps from DispatchManager) ──

  setStore(store: TaskStateStore): void {
    this.d.store = store;
  }

  setMetricsPersister(persister: MetricsPersister): void {
    this.d.metricsPersister = persister;
  }

  setDirectory(directory: string): void {
    this.d.directory = directory;
  }
}

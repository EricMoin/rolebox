import type { ISessionClient } from "../../platform/ports/session-client.ts";
import type {
  DispatchInput,
  DispatchTask,
  DispatchManagerConfig,
} from "../types.ts";
import {
  DEFAULT_CONFIG,
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
} from "../config.ts";
import { ConcurrencyManager, type IConcurrencyManager } from "../concurrency/concurrency.ts";
import { TaskWatchdogManager } from "./watchdog.ts";
import { notifyParent } from "../notification.ts";
import { SessionMonitor } from "../completion/session-monitor.ts";
import { MetricsPersister } from "../persistence/metrics-persister.ts";
import { BudgetTracker } from "../budget/budget-tracker.ts";

import { TaskStateStore } from "../persistence/task-store.ts";
import { debugLog } from "./debug-log.ts";
import { metrics } from "../persistence/metrics.ts";
import { TaskLifecycleManager } from "./task-lifecycle.ts";
import { CompletionOrchestrator, type CompletionOrchestratorDeps } from "../completion/completion-orchestrator.ts";
import { FileSystemCheckpointStore } from "../checkpoint/checkpoint-store.ts";
import { DEFAULT_CHECKPOINT_TTL_MS } from "../config.ts";
import { InMemoryProgressStore } from "../progress/progress-store.ts";
import { clearEmittedThresholds } from "../progress/progress-tools.ts";
export { extractSessionErrorMessage } from "./error-utils.ts";

export class DispatchManager {
  // ── Shared mutable state (owned here, shared with lifecycle & orchestrator) ─
  private tasks: Map<string, DispatchTask> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sidecarGCTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingNotifications: Set<string> = new Set();
  private cleanedUpTasks = new Map<string, number>();
  private concurrency: IConcurrencyManager;
  private config: DispatchManagerConfig;
  private client: ISessionClient;
  private watchdog: TaskWatchdogManager;
  private sessionToTask: Map<string, string> = new Map();
  private eventState: Map<string, import("../types.ts").TaskEventState> = new Map();
  private store: TaskStateStore;
  private checkpointStore: FileSystemCheckpointStore;

  private sessionsByRequest = new Map<string, number>();
  private _cancelQueue: Map<string, () => void> = new Map();
  private _syncControllers: Map<string, AbortController> = new Map();
  /** Maps completed sync task IDs to their opencode session IDs for continuation support. */
  private completedSyncSessions = new Map<string, string>();
  /** Timestamps (epoch ms) for completedSyncSessions entries — used for TTL eviction. */
  private completedSyncSessionsSetAt = new Map<string, number>();
  private subagentModelKey: Map<string, string>;
  private sessionMonitor: SessionMonitor;
  private metricsPersister: MetricsPersister;
  private budgetTracker: BudgetTracker;
  private notifyOutbox = new Set<string>();
  private _deferredIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _directory: string;
  private progressStore: InMemoryProgressStore;
  private taskTerminatedListeners = new Map<string, Set<Function>>();
  /** Parent→taskIds index for O(1) getTasksByParent lookups. */
  private parentTasksIndex: Map<string, Set<string>> = new Map();
  /** Inflight running task count per parentSessionId — replaces O(n) scan in getInflightCount. */
  private inflightByParent: Map<string, number> = new Map();
  /** Oldest startedAt timestamp per parentSessionId — replaces O(n) scan in getOldestInflightChildStartedAt. */
  private oldestStartedAtByParent: Map<string, number> = new Map();

  /** Delegated lifecycle manager. */
  private lifecycle: TaskLifecycleManager;
  /** Delegated completion orchestrator. */
  private orchestrator: CompletionOrchestrator;

  constructor(
    client: ISessionClient,
    config?: Partial<DispatchManagerConfig>,
    subagentModelKey?: Map<string, string>,
    customConcurrency?: IConcurrencyManager,
  ) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (customConcurrency) {
      this.concurrency = customConcurrency;
    } else if (this.config.concurrency_policy) {
      this.concurrency = this.config.concurrency_policy(
        this.config.maxConcurrent,
        this.config.maxQueueDepth ?? DEFAULT_CONFIG.maxQueueDepth ?? 100,
        this.config.syncReservedSlots ?? 2,
        this.config.retryAfterMs,
      );
    } else {
      this.concurrency = new ConcurrencyManager(
        this.config.maxConcurrent,
        this.config.maxQueueDepth ?? 100,
        this.config.syncReservedSlots ?? 2,
        this.config.retryAfterMs,
      );
    }
    this._directory = process.cwd();
    this.store = new TaskStateStore(this._directory);
    this.subagentModelKey = subagentModelKey ?? new Map();
    this.sessionMonitor = new SessionMonitor();
    this.metricsPersister = new MetricsPersister(this._directory);
    this.checkpointStore = new FileSystemCheckpointStore(this._directory);
    this.progressStore = new InMemoryProgressStore(this._directory);
    this.budgetTracker = new BudgetTracker(this.config, this._directory);

    // Create TaskWatchdogManager — lifecycle deps require it.
    // The `?.` guard on this.lifecycle covers the brief window before construction completes;
    // no tasks are registered yet so no callbacks fire during that window.
    this.watchdog = new TaskWatchdogManager(
      {
        onReconcile: (taskId: string) => this.lifecycle?.evaluateAndComplete(taskId, "watchdog-reconcile"),
        onSweep: (taskId: string) => {
          if (!this.watchdog.isDebouncing(taskId)) {
            return this.lifecycle?.evaluateAndComplete(taskId, "global-sweep");
          }
        },
        onDebounceElapsed: (taskId: string) => this.lifecycle?.evaluateAndComplete(taskId, "idle-debounce"),
      },
      {
        watchdogIntervalMs: this.config.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS,
        globalSweepIntervalMs: this.config.globalSweepIntervalMs ?? GLOBAL_SWEEP_INTERVAL_MS,
        idleDebounceMs: this.config.idleDebounceMs ?? IDLE_DEBOUNCE_MS,
      },
    );

    // Create CompletionOrchestrator — share all Map/Set references via deps.
    // getInflightCount and sendNotification callbacks bounce through DispatchManager
    // so they resolve after lifecycle is created below.
    const orchestratorDeps: CompletionOrchestratorDeps = {
      tasks: this.tasks,
      eventState: this.eventState,
      client: this.client,
      concurrency: this.concurrency,
      watchdog: this.watchdog,
      config: this.config,
      sessionToTask: this.sessionToTask,
      notifyOutbox: this.notifyOutbox,
      cleanupTimers: this.cleanupTimers,
      sidecarGCTimers: this.sidecarGCTimers,
      cleanedUpTasks: this.cleanedUpTasks,
      deferredIdleTimers: this._deferredIdleTimers,
      pendingNotifications: this.pendingNotifications,
      sessionMonitor: this.sessionMonitor,
      budgetTracker: this.budgetTracker,
      store: this.store,
      metricsPersister: this.metricsPersister,
      directory: this._directory,
      checkpointStore: this.checkpointStore,
      progressStore: this.progressStore,
      clearEmittedThresholds: (taskId: string) => clearEmittedThresholds(taskId),
      getInflightCount: (parentSessionId: string) => this.getInflightCount(parentSessionId),
      sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) =>
        this.notifyCompletion(task, remainingTasks, resultText),
      cancelTask: (taskId: string) => this.cancelTask(taskId),
      parentTasksIndex: this.parentTasksIndex,
      inflightByParent: this.inflightByParent,
      oldestStartedAtByParent: this.oldestStartedAtByParent,
    };
    this.orchestrator = new CompletionOrchestrator(orchestratorDeps);

    // Create TaskLifecycleManager — from this point onward, watchdog callbacks see a real lifecycle
    this.lifecycle = new TaskLifecycleManager({
      tasks: this.tasks,
      eventState: this.eventState,
      client: this.client,
      concurrency: this.concurrency,
      watchdog: this.watchdog,
      config: this.config,
      cancelQueue: this._cancelQueue,
      syncControllers: this._syncControllers,
      completedSyncSessions: this.completedSyncSessions,
      completedSyncSessionsSetAt: this.completedSyncSessionsSetAt,
      cleanupTimers: this.cleanupTimers,
      sidecarGCTimers: this.sidecarGCTimers,
      pendingNotifications: this.pendingNotifications,
      sessionToTask: this.sessionToTask,
      sessionsByRequest: this.sessionsByRequest,
      notifyOutbox: this.notifyOutbox,
      deferredIdleTimers: this._deferredIdleTimers,
      cleanedUpTasks: this.cleanedUpTasks,
      subagentModelKey: this.subagentModelKey,
      directory: this._directory,
      sessionMonitor: this.sessionMonitor,
      cleanupTask: (taskId: string) => this.orchestrator.cleanupTask(taskId),
      persistState: () => this.orchestrator.persistState(),
      addToOutbox: (taskId: string) => this.orchestrator.addToOutbox(taskId),
      sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) =>
        this.notifyCompletion(task, remainingTasks, resultText),
      progressStore: this.progressStore,
      clearEmittedThresholds: (taskId: string) => clearEmittedThresholds(taskId),
      deleteTaskCheckpoint: (taskId: string) => this.checkpointStore.deleteCheckpoint(taskId),
      taskTerminatedListeners: this.taskTerminatedListeners,
      parentTasksIndex: this.parentTasksIndex,
      inflightByParent: this.inflightByParent,
      oldestStartedAtByParent: this.oldestStartedAtByParent,
    });
    this.progressStore.startSweeper();
    this.orchestrator.startSweeper();
    this.orchestrator.startBudgetSampler();
  }

  // ── Delegated lifecycle methods ───────────────────────────────

  async launch(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<DispatchTask> {
    return this.lifecycle.launch(input, parentContext);
  }

  async executeSync(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<string> {
    return this.lifecycle.executeSync(input, parentContext);
  }

  async reopenForContinuation(
    taskId: string,
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<DispatchTask> {
    return this.lifecycle.reopenForContinuation(taskId, input, parentContext);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    return this.lifecycle.cancelTask(taskId);
  }

  /**
   * Approve a task that is paused in "awaiting_approval" state.
   * Transitions the task to "completed" and notifies the parent.
   * Returns false if the task is not in awaiting_approval state or not found.
   */
  async approveTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "awaiting_approval") return false;
    task.status = "completed";
    task.completedAt = new Date();
    this.orchestrator.persistState();
    this.orchestrator.scheduleCleanup(taskId);
    void this.notifyCompletion(task, this.getInflightCount(task.parentSessionId));
    return true;
  }

  /**
   * Reject a task that is paused in "awaiting_approval" state.
   * Transitions the task to "error" with the provided reason and notifies the parent.
   * Returns false if the task is not in awaiting_approval state or not found.
   */
  async rejectTask(taskId: string, reason?: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "awaiting_approval") return false;
    task.status = "error";
    task.error = reason ?? "Rejected by parent";
    task.completedAt = new Date();
    this.orchestrator.persistState();
    this.orchestrator.scheduleCleanup(taskId);
    void this.notifyCompletion(task, this.getInflightCount(task.parentSessionId));
    return true;
  }

  async getResult(
    taskId: string,
  ): Promise<{
    kind: "ok" | "expired" | "not_found" | "fetch_error";
    text: string;
    resultText: string;
    hadFence: boolean;
    totalChars: number;
    error?: string;
  }> {
    return this.lifecycle.getResult(taskId);
  }

  getInflightCount(parentSessionId: string): number {
    return this.lifecycle.getInflightCount(parentSessionId);
  }

  // ── Delegated orchestrator methods (public API) ──────────────

  cleanupTask(taskId: string): void {
    this.orchestrator.cleanupTask(taskId);
  }

  async flushPersist(): Promise<void> {
    await this.orchestrator.flushPersist();
  }

  flushPersistSync(): void {
    this.orchestrator.flushPersistSync();
  }

  async dispose(): Promise<void> {
    this.orchestrator.dispose();
    this.progressStore.stopSweeper();
    const budgetDispose = (this.budgetTracker as unknown as { dispose?: () => void }).dispose;
    if (budgetDispose) budgetDispose.call(this.budgetTracker);
    this.cleanupCompletedSyncSessions();
    await this.flushPersist();
  }

  /** Sweep completedSyncSessions entries older than 1 hour (COMPLETED_SYNC_TTL_MS). */
  private cleanupCompletedSyncSessions(): void {
    const ttlMs = 3_600_000; // 1 hour
    const now = Date.now();
    for (const [taskId, setAt] of this.completedSyncSessionsSetAt) {
      if (now - setAt > ttlMs) {
        this.completedSyncSessions.delete(taskId);
        this.completedSyncSessionsSetAt.delete(taskId);
      }
    }
  }

  async recover(): Promise<void> {
    await this.orchestrator.recover();
    // Rebuild inflight counters from tasks after recovery (one-time O(n), replaces per-tick O(n))
    this.inflightByParent.clear();
    this.oldestStartedAtByParent.clear();
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "pending") {
        const pid = task.parentSessionId;
        this.inflightByParent.set(pid, (this.inflightByParent.get(pid) ?? 0) + 1);
        const startedAt = task.startedAt.getTime();
        const currOldest = this.oldestStartedAtByParent.get(pid);
        if (currOldest === undefined || startedAt < currOldest) {
          this.oldestStartedAtByParent.set(pid, startedAt);
        }
      }
    }
  }

  // ── Notification ──────────────────────────────────────────────

  async notifyCompletion(task: DispatchTask, remainingTasks: number, resultText?: string): Promise<boolean> {
    return notifyParent(this.client, task, remainingTasks, undefined, resultText);
  }

  /**
   * Send a progress milestone `<system-reminder>` to the parent session.
   * Used by dispatch_progress tool when a 25/50/75/100% threshold is crossed.
   * Fire-and-forget — errors are silently caught.
   */
  async sendProgressMilestone(taskId: string, text: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    try {
      await this.client.prompt(task.parentSessionId, {
        ...(task.parentAgent ? { agent: task.parentAgent } : {}),
        parts: [{ type: "text", text }],
        noReply: true,
      });
    } catch {
      // Fire-and-forget — errors are non-critical
    }
  }

  // ── Delegated event handlers ──────────────────────────────────

  async handleSessionIdle(sessionId: string): Promise<void> {
    return this.lifecycle.handleSessionIdle(sessionId);
  }

  handleSessionStatus(sessionId: string, statusType: string): Promise<void> {
    return this.lifecycle.handleSessionStatus(sessionId, statusType);
  }

  handleMessageUpdated(sessionId: string): void {
    return this.lifecycle.handleMessageUpdated(sessionId);
  }

  async handleSessionError(sessionId: string, error: unknown): Promise<void> {
    return this.lifecycle.handleSessionError(sessionId, error);
  }

  async handleSessionDeleted(sessionId: string): Promise<void> {
    this.budgetTracker.removeRequest(sessionId);
    this.budgetTracker.removeSession(sessionId);
    return this.lifecycle.handleSessionDeleted(sessionId);
  }

  // ── Query methods ────────────────────────────────────────────

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByParent(parentSessionId: string): DispatchTask[] {
    const ids = this.parentTasksIndex.get(parentSessionId);
    if (!ids || ids.size === 0) return [];
    const result: DispatchTask[] = [];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task) result.push(task);
    }
    return result;
  }

  getAllTasks(): DispatchTask[] {
    return [...this.tasks.values()];
  }

  getConcurrencyStatus(): {
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
    const allKeys = this.concurrency.getAllKeys();
    const keys = allKeys.map(key => {
      const active = this.concurrency.getActiveCount(key);
      const limit = this.concurrency.getLimit(key);
      const reserved = this.concurrency.getReserved(key);
      const queueDepth = this.concurrency.getQueueDepth(key);
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

  getMetricsSnapshot(): import("../persistence/metrics.ts").MetricsSnapshot {
    return metrics.snapshot();
  }

  isSyncSession(sessionId: string): boolean {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return false;
    const task = this.tasks.get(taskId);
    return task?.mode === "sync";
  }

  getBudgetTracker(): BudgetTracker {
    return this.budgetTracker;
  }

  getBudgetStatus(parentSessionId: string): string {
    return this.budgetTracker.getStatus(parentSessionId);
  }

  getConfig(): Readonly<DispatchManagerConfig> {
    return this.config;
  }

  getEventState(): Map<string, import("../types.ts").TaskEventState> {
    return this.eventState;
  }

  getCheckpointStore(): FileSystemCheckpointStore {
    return this.checkpointStore;
  }

  getProgressStore(): InMemoryProgressStore {
    return this.progressStore;
  }

  /** Register a one-time listener for when a task enters a terminal state.
   *
   * If the task is already in a terminal status (completed/error/cancelled/timeout),
   * the callback fires immediately (async via microtask) to handle the listen-after-
   * terminate race — e.g. the loop coordinator registering after the worker has already finished.
   * Fire-once semantics are preserved: the callback is removed from the listener set
   * before the microtask fires, so notifyTerminated will not call it again. */
  onTaskTerminated(taskId: string, callback: (taskId: string, status: string) => void): (taskId: string, status: string) => void {
    let set = this.taskTerminatedListeners.get(taskId);
    if (!set) {
      set = new Set();
      this.taskTerminatedListeners.set(taskId, set);
    }
    set.add(callback as Function);

    // Immediate-fire guard: if the task is already terminal, the normal
    // notifyTerminated path can never fire because it runs only when the
    // task transitions to terminal. Fire async via microtask to avoid
    // synchronous re-entrancy into the caller's registration stack frame.
    const task = this.getTask(taskId);
    if (task && (task.status === "completed" || task.status === "error" || task.status === "cancelled" || task.status === "timeout")) {
      // Remove from listener set immediately (fire-once — prevent double-fire
      // in case notifyTerminated somehow runs, though it won't for an already-terminal task)
      set.delete(callback as Function);
      if (set.size === 0) {
        this.taskTerminatedListeners.delete(taskId);
      }
      queueMicrotask(() => {
        try {
          callback(taskId, task.status);
        } catch {
          // Swallow — same policy as notifyTerminated
        }
      });
    }

    return callback;
  }

  /** Remove a previously registered task-terminated listener. */
  removeTaskTerminatedListener(taskId: string, callback: (taskId: string, status: string) => void): void {
    const set = this.taskTerminatedListeners.get(taskId);
    if (!set) return;
    set.delete(callback as Function);
    if (set.size === 0) {
      this.taskTerminatedListeners.delete(taskId);
    }
  }

  // ── Bridge methods (accessed by tests via (manager as any)) ──
  // See manager-bridge.ts for documentation. These one-liners delegate
  // to lifecycle/orchestrator internals for test access.

  get _dirty(): boolean { return this.orchestrator._dirty; }
  get _persistTimer(): ReturnType<typeof setTimeout> | undefined { return this.orchestrator._persistTimer; }
  get sweeperTimer(): ReturnType<typeof setInterval> | undefined { return this.orchestrator.sweeperTimer; }

  evaluateAndComplete(taskId: string, trigger: "idle-debounce" | "watchdog-reconcile" | "global-sweep" | "error-event" | "deleted-event", errorDetail?: string): Promise<void> { return this.lifecycle.evaluateAndComplete(taskId, trigger, errorDetail); }
  async handleTaskCompleted(taskId: string): Promise<void> { return this.lifecycle.handleTaskCompleted(taskId); }
  handleTaskError(taskId: string, error: string): void { this.lifecycle.handleTaskError(taskId, error); }
  handleTaskTimeout(taskId: string, reason: string): void { this.lifecycle.handleTaskTimeout(taskId, reason); }
  materializeResult(taskId: string): Promise<import("../types.ts").MaterializedResultRef> { return this.lifecycle.materializeResult(taskId); }
  materializeAndNotify(taskId: string): Promise<void> { return this.lifecycle.materializeAndNotify(taskId); }
  computeDepth(parentSessionId: string): number { return this.lifecycle.computeDepth(parentSessionId); }
  getRequestSessions(rootSession: string): number { return this.lifecycle.getRequestSessions(rootSession); }
  leaveRunning(taskId: string): void { this.lifecycle.leaveRunning(taskId); }
  persistState(): void { this.orchestrator.persistState(); }
  scheduleCleanup(taskId: string): void { this.orchestrator.scheduleCleanup(taskId); }
  transition(taskId: string, from: import("../types.ts").DispatchTaskStatus[], to: import("../types.ts").DispatchTaskStatus, fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>): boolean { return this.orchestrator.transition(taskId, from, to, fields); }

  setConcurrencyManager(manager: IConcurrencyManager): void {
    this.concurrency = manager;
    this.lifecycle.setConcurrencyManager(manager);
  }

  setStoreDirectory(directory: string): void {
    this._directory = directory;
    this.store = new TaskStateStore(directory);
    this.metricsPersister = new MetricsPersister(directory);
    this.progressStore.setDirectory(directory);
    this.checkpointStore = new FileSystemCheckpointStore(directory);
    this.lifecycle.setDirectory(directory);
    this.orchestrator.setStore(this.store);
    this.orchestrator.setMetricsPersister(this.metricsPersister);
    this.orchestrator.setDirectory(directory);
  }

  setRecoverySnapshotProvider(
    provider: (() => import("../../recovery/types.ts").RecoveryMetricsSnapshot | null) | null,
  ): void {
    this.metricsPersister.setRecoverySnapshotProvider(provider);
  }
}

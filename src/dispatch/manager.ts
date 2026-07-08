import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  DispatchInput,
  DispatchTask,
  DispatchManagerConfig,
} from "./types.ts";
import {
  DEFAULT_CONFIG,
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
} from "./config.ts";
import { ConcurrencyManager, type IConcurrencyManager } from "./concurrency.ts";
import { TaskWatchdogManager } from "./watchdog.ts";
import { notifyParent } from "./notification.ts";
import { SessionMonitor } from "./session-monitor.ts";
import { MetricsPersister } from "./metrics-persister.ts";
import { BudgetTracker } from "./budget-tracker.ts";

import { TaskStateStore } from "./task-store.ts";
import { debugLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";
import { TaskLifecycleManager } from "./task-lifecycle.ts";
import { CompletionOrchestrator, type CompletionOrchestratorDeps } from "./completion-orchestrator.ts";

/**
 * Extract a human-readable error message from various session.error shapes.
 * Re-exported from the original manager.ts for test backward compatibility.
 *
 * Opencode session.error payloads vary (Error | string | { name, data: { message } }).
 * String(obj) would yield "[object Object]" and hide the real cause, so dig out a message.
 */
export function extractSessionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "string") return error.trim() || "Unknown session error";
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    const data = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
    const msg = data.message ?? o.message;
    const name = typeof o.name === "string" ? o.name : undefined;
    if (typeof msg === "string" && msg.trim()) {
      return name && name !== msg ? `${name}: ${msg}` : msg;
    }
    if (name && name.trim()) return name;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      return String(error);
    }
  }
  return error !== undefined ? String(error) : "Unknown session error";
}

export class DispatchManager {
  // ── Shared mutable state (owned here, shared with lifecycle & orchestrator) ─
  private tasks: Map<string, DispatchTask> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sidecarGCTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingNotifications: Set<string> = new Set();
  private cleanedUpTasks = new Map<string, number>();
  private concurrency: IConcurrencyManager;
  private config: DispatchManagerConfig;
  private client: OpencodeClient;
  private watchdog: TaskWatchdogManager;
  private sessionToTask: Map<string, string> = new Map();
  private eventState: Map<string, import("./types.ts").TaskEventState> = new Map();
  private store: TaskStateStore;

  private sessionsByRequest = new Map<string, number>();
  private _cancelQueue: Map<string, () => void> = new Map();
  private _syncControllers: Map<string, AbortController> = new Map();
  /** Maps completed sync task IDs to their opencode session IDs for continuation support. */
  private completedSyncSessions = new Map<string, string>();
  private subagentModelKey: Map<string, string>;
  private sessionMonitor: SessionMonitor;
  private metricsPersister: MetricsPersister;
  private budgetTracker: BudgetTracker;
  private notifyOutbox = new Set<string>();
  private _deferredIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _directory: string;

  /** Delegated lifecycle manager. */
  private lifecycle: TaskLifecycleManager;
  /** Delegated completion orchestrator. */
  private orchestrator: CompletionOrchestrator;

  constructor(
    client: OpencodeClient,
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
    this.budgetTracker = new BudgetTracker(this.config);

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
      getInflightCount: (parentSessionId: string) => this.getInflightCount(parentSessionId),
      sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) =>
        this.notifyCompletion(task, remainingTasks, resultText),
      cancelTask: (taskId: string) => this.cancelTask(taskId),
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
    });
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

  async recover(): Promise<void> {
    await this.orchestrator.recover();
  }

  // ── Notification ──────────────────────────────────────────────

  async notifyCompletion(task: DispatchTask, remainingTasks: number, resultText?: string): Promise<boolean> {
    return notifyParent(this.client, task, remainingTasks, undefined, resultText);
  }

  // ── Delegated event handlers ──────────────────────────────────

  async handleSessionIdle(sessionId: string): Promise<void> {
    return this.lifecycle.handleSessionIdle(sessionId);
  }

  handleSessionStatus(sessionId: string, statusType: string): void {
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
    const result: DispatchTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === parentSessionId) {
        result.push(task);
      }
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

  getMetricsSnapshot(): import("./metrics.ts").MetricsSnapshot {
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

  getEventState(): Map<string, import("./types.ts").TaskEventState> {
    return this.eventState;
  }

  // ── Bridge methods (accessed by tests via (manager as any)) ──

  // ── Bridge properties ──
  /** Bridge: tests read orchestrator's dirty flag. */
  get _dirty(): boolean { return (this.orchestrator as any)._dirty; }
  /** Bridge: tests read orchestrator's persist timer. */
  get _persistTimer(): ReturnType<typeof setTimeout> | undefined { return (this.orchestrator as any)._persistTimer; }
  /** Bridge: tests read orchestrator's sweeper timer. */
  get sweeperTimer(): ReturnType<typeof setInterval> | undefined { return (this.orchestrator as any).sweeperTimer; }

  // ── Bridge: lifecycle methods ──

  evaluateAndComplete(
    taskId: string,
    trigger: "idle-debounce" | "watchdog-reconcile" | "global-sweep" | "error-event" | "deleted-event",
    errorDetail?: string,
  ): Promise<void> {
    return this.lifecycle.evaluateAndComplete(taskId, trigger, errorDetail);
  }

  handleTaskCompleted(taskId: string): void {
    (this.lifecycle as any).handleTaskCompleted(taskId);
  }

  handleTaskError(taskId: string, error: string): void {
    (this.lifecycle as any).handleTaskError(taskId, error);
  }

  handleTaskTimeout(taskId: string, reason: string): void {
    (this.lifecycle as any).handleTaskTimeout(taskId, reason);
  }

  materializeResult(taskId: string): Promise<import("./types.ts").MaterializedResultRef> {
    return (this.lifecycle as any).materializeResult(taskId);
  }

  materializeAndNotify(taskId: string): Promise<void> {
    return (this.lifecycle as any).materializeAndNotify(taskId);
  }

  computeDepth(parentSessionId: string): number {
    return (this.lifecycle as any).computeDepth(parentSessionId);
  }

  getRequestSessions(rootSession: string): number {
    return (this.lifecycle as any).getRequestSessions(rootSession);
  }

  leaveRunning(taskId: string): void {
    this.lifecycle.leaveRunning(taskId);
  }

  // ── Bridge: orchestrator methods ──

  persistState(): void {
    this.orchestrator.persistState();
  }

  scheduleCleanup(taskId: string): void {
    this.orchestrator.scheduleCleanup(taskId);
  }

  /**
   * Transition a task's status atomically. Delegates to the orchestrator.
   * Accessed by tests via (manager as any).transition(...).
   */
  transition(
    taskId: string,
    from: import("./types.ts").DispatchTaskStatus[],
    to: import("./types.ts").DispatchTaskStatus,
    fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
  ): boolean {
    return (this.orchestrator as any).transition(taskId, from, to, fields);
  }

  setConcurrencyManager(manager: IConcurrencyManager): void {
    this.concurrency = manager;
    (this.lifecycle as any).d.concurrency = manager;
  }

  // ── Store directory & recovery setup ───────────────────────

  setStoreDirectory(directory: string): void {
    this._directory = directory;
    this.store = new TaskStateStore(directory);
    this.metricsPersister = new MetricsPersister(directory);
    (this.lifecycle as any).d.directory = directory;
    // Propagate store & metricsPersister to the orchestrator's deps
    (this.orchestrator as any).d.store = this.store;
    (this.orchestrator as any).d.metricsPersister = this.metricsPersister;
    (this.orchestrator as any).d.directory = directory;
  }

  setRecoverySnapshotProvider(
    provider: (() => import("../recovery/types.ts").RecoveryMetricsSnapshot | null) | null,
  ): void {
    this.metricsPersister.setRecoverySnapshotProvider(provider);
  }
}

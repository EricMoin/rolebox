/**
 * TaskWatchdogManager — 3-tier timer orchestration for the dispatch subsystem.
 *
 * Replaces the old GlobalPoller's inline timer management with a dedicated
 * coordinator that operates purely via dependency-injected callbacks.
 *
 * Tier 1: Per-task reconcile watchdog   (setTimeout, self-resetting)
 * Tier 2: Global sweep                   (setInterval, starts/ends with task count)
 * Tier 3: Idle debounce                  (setTimeout, per-task)
 *
 * No imports from SDK or manager.ts — this is pure timer management.
 */

export interface TaskWatchdogDeps {
  /** Called when a task's reconcile watchdog fires. */
  onReconcile: (taskId: string) => void | Promise<void>;
  /** Called for every running task on each global sweep tick. */
  onSweep: (taskId: string) => void | Promise<void>;
  /** Called when a task's idle debounce timer elapses. */
  onDebounceElapsed: (taskId: string) => void | Promise<void>;
}

export interface TaskWatchdogConfig {
  /** Per-task reconcile watchdog interval (ms). */
  watchdogIntervalMs: number;
  /** Global sweep interval (ms). */
  globalSweepIntervalMs: number;
  /** Idle debounce delay (ms). */
  idleDebounceMs: number;
}

export class TaskWatchdogManager {
  private deps: TaskWatchdogDeps;
  private config: TaskWatchdogConfig;

  /** Per-task reconcile watchdog timeout handles. */
  private watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-task idle debounce timeout handles. */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tasks with a currently-pending debounce timer. */
  private pendingDebounce = new Set<string>();
  /** Registered task IDs. */
  private registeredTasks = new Set<string>();

  /** Global sweep interval handle. */
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  /** Track whether dispose() was called to prevent re-entry. */
  private disposed = false;

  constructor(deps: TaskWatchdogDeps, config: TaskWatchdogConfig) {
    this.deps = deps;
    this.config = config;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Register a running task: start its watchdog.
   * Starts the global sweep if this is the first task.
   * Idempotent — calling twice for the same taskId is a no-op.
   */
  registerTask(taskId: string): void {
    if (this.disposed) return;
    if (this.registeredTasks.has(taskId)) return;

    this.registeredTasks.add(taskId);
    this._startWatchdog(taskId);

    if (this.registeredTasks.size === 1) {
      this._startGlobalSweep();
    }
  }

  /**
   * Remove a task: clear its watchdog and debounce timers.
   * Stops the global sweep if this was the last task.
   */
  unregisterTask(taskId: string): void {
    if (this.disposed) return;

    this.registeredTasks.delete(taskId);
    this._clearWatchdog(taskId);
    this._clearDebounce(taskId);

    if (this.registeredTasks.size === 0) {
      this._stopGlobalSweep();
    }
  }

  /** Reset a task's watchdog timer (called on every routed event). No-op if not registered. */
  resetWatchdog(taskId: string): void {
    if (this.disposed || !this.registeredTasks.has(taskId)) return;

    this._clearWatchdog(taskId);
    this._startWatchdog(taskId);
  }

  /** Start the idle-debounce timer for a task. Replaces any existing one. */
  startDebounce(taskId: string): void {
    if (this.disposed || !this.registeredTasks.has(taskId)) return;

    this._clearDebounce(taskId);

    const handle = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      this.pendingDebounce.delete(taskId);
      void this._runSafe(() => this.deps.onDebounceElapsed(taskId));
    }, this.config.idleDebounceMs);

    this.debounceTimers.set(taskId, handle);
    this.pendingDebounce.add(taskId);
  }

  /** Cancel a task's debounce timer (task resumed). No-op if none. */
  cancelDebounce(taskId: string): void {
    this._clearDebounce(taskId);
  }

  /** True if a debounce timer is currently pending for this task. */
  isDebouncing(taskId: string): boolean {
    return this.pendingDebounce.has(taskId);
  }

  /** Clear ALL timers (watchdogs, debounces, global sweep). Safe to call multiple times. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Clear all per-task watchdogs
    for (const handle of this.watchdogTimers.values()) {
      clearTimeout(handle);
    }
    this.watchdogTimers.clear();

    // Clear all debounce timers
    for (const handle of this.debounceTimers.values()) {
      clearTimeout(handle);
    }
    this.debounceTimers.clear();
    this.pendingDebounce.clear();

    // Stop global sweep
    this._stopGlobalSweep();

    // Clear task registry
    this.registeredTasks.clear();
  }

  // ── Test hooks (do not call in production code) ──────────────────────

  /** Directly fire the reconcile callback for a task, emulating a watchdog timeout. */
  triggerWatchdog(taskId: string): void | Promise<void> {
    if (this.disposed || !this.registeredTasks.has(taskId)) return;
    return this._runSafe(() => this.deps.onReconcile(taskId));
  }

  /** Directly fire the sweep callback for all registered tasks. */
  triggerSweep(): void | Promise<void> {
    if (this.disposed) return;
    const promises: Array<Promise<void>> = [];
    for (const taskId of this.registeredTasks) {
      promises.push(this._runSafe(() => this.deps.onSweep(taskId)));
    }
    if (promises.length === 0) return;
    return Promise.all(promises).then(() => {});
  }

  /** Directly fire the debounce callback for a task, emulating debounce timer expiry. */
  triggerDebounce(taskId: string): void | Promise<void> {
    if (this.disposed) return;
    if (!this.pendingDebounce.has(taskId)) return;
    this.pendingDebounce.delete(taskId);
    this._clearDebounce(taskId);
    return this._runSafe(() => this.deps.onDebounceElapsed(taskId));
  }

  /** Return a snapshot of currently-registered task IDs (for test assertions). */
  getRegisteredTaskIds(): string[] {
    return [...this.registeredTasks];
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Start the per-task reconcile watchdog (self-resetting setTimeout). */
  private _startWatchdog(taskId: string): void {
    if (this.disposed) return;

    const handle = setTimeout(() => {
      this.watchdogTimers.delete(taskId);
      void this._runSafe(() => this.deps.onReconcile(taskId));
      // Re-set if still registered
      if (this.registeredTasks.has(taskId) && !this.disposed) {
        this._startWatchdog(taskId);
      }
    }, this.config.watchdogIntervalMs);

    this.watchdogTimers.set(taskId, handle);
  }

  /** Clear a task's watchdog timer. */
  private _clearWatchdog(taskId: string): void {
    const handle = this.watchdogTimers.get(taskId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.watchdogTimers.delete(taskId);
    }
  }

  /** Clear a task's debounce timer and remove from pending set. */
  private _clearDebounce(taskId: string): void {
    const handle = this.debounceTimers.get(taskId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.debounceTimers.delete(taskId);
    }
    this.pendingDebounce.delete(taskId);
  }

  /** Start the global sweep setInterval. */
  private _startGlobalSweep(): void {
    if (this.sweepInterval !== null || this.disposed) return;

    this.sweepInterval = setInterval(() => {
      if (this.disposed) return;
      for (const taskId of this.registeredTasks) {
        void this._runSafe(() => this.deps.onSweep(taskId));
      }
    }, this.config.globalSweepIntervalMs);
  }

  /** Stop the global sweep setInterval. */
  private _stopGlobalSweep(): void {
    if (this.sweepInterval !== null) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /** Wrap a callback to catch and silence errors (prevents unhandled rejections in timers). */
  private async _runSafe(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // Silently swallow — timer callbacks should never throw
    }
  }
}

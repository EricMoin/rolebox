import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  DispatchInput,
  DispatchTask,
  DispatchTaskStatus,
  DispatchManagerConfig,
} from "./types.ts";
import { DEFAULT_CONFIG, SYNC_TIMEOUT_MS } from "./config.ts";
import { ConcurrencyManager } from "./concurrency.ts";
import { GlobalPoller } from "./global-poller.ts";
import { SessionMonitor } from "./session-monitor.ts";
import { detectCompletion } from "./completion-detector.ts";
import { notifyParent } from "./notification.ts";

import { TaskStateStore } from "./task-store.ts";
import { debugLog, infoLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";

const DEFAULT_CONCURRENCY_KEY = "default";

export class DispatchManager {
  private tasks: Map<string, DispatchTask> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingNotifications: Set<string> = new Set();
  private cleanedUpTasks = new Set<string>();
  private concurrency: ConcurrencyManager;
  private config: DispatchManagerConfig;
  private client: OpencodeClient;
  private poller: GlobalPoller;
  private sessionMonitor: SessionMonitor;
  private store: TaskStateStore;
  private _recovered = false;
  private inflightByParent = new Map<string, number>();

  constructor(client: OpencodeClient, config?: Partial<DispatchManagerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.concurrency = new ConcurrencyManager(this.config.maxConcurrent);
    this.sessionMonitor = new SessionMonitor();
    this.store = new TaskStateStore(process.cwd());
    this.poller = new GlobalPoller(client, this.config, {
      completionDetector: detectCompletion,
      sessionMonitor: this.sessionMonitor,
      onTaskCompleted: (taskId) => this.handleTaskCompleted(taskId),
      onTaskError: (taskId, error) => this.handleTaskError(taskId, error),
      onTaskTimeout: (taskId, reason) => this.handleTaskTimeout(taskId, reason),
    });
  }

  async launch(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<DispatchTask> {
    const taskId = `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

    const task: DispatchTask = {
      id: taskId,
      sessionId: "",
      parentSessionId: parentContext.sessionID,
      status: "pending",
      agent: input.subagent,
      prompt: input.prompt,
      description: input.description,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };

    this.tasks.set(taskId, task);

    debugLog("launch", taskId, `agent=${input.subagent} bg=${input.run_in_background} desc="${input.description ?? ""}"`);

    // Pool-full fast-fail: reject immediately if all slots are occupied
    if (this.concurrency.getActiveCount(DEFAULT_CONCURRENCY_KEY) >= this.concurrency.getLimit(DEFAULT_CONCURRENCY_KEY)) {
      metrics.counter("dispatch_rejected_total", { reason: "pool-full" }).inc();
      task.status = "error";
      task.error = "Pool is full — all concurrent slots occupied";
      task.completedAt = new Date();
      debugLog("launch", taskId, `REJECTED: pool-full (${this.concurrency.getActiveCount(DEFAULT_CONCURRENCY_KEY)}/${this.concurrency.getLimit(DEFAULT_CONCURRENCY_KEY)})`);
      this.scheduleCleanup(taskId);
      void this.notifyCompletion(task);
      return task;
    }

    await this.concurrency.acquire(DEFAULT_CONCURRENCY_KEY);
    task.concurrencyKey = DEFAULT_CONCURRENCY_KEY;

    let didMarkRunning = false;

    try {
      const createResult = await this.client.session.create({
        body: {
          parentID: parentContext.sessionID,
        },
        query: {
          directory: parentContext.directory,
        },
      });

      const session = createResult.data;
      if (!session) {
        throw new Error("Failed to create session: empty response");
      }
      task.sessionId = session.id;
      task.status = "running";
      didMarkRunning = true;
      infoLog("launch", taskId, `running agent=${input.subagent}`);
      metrics.counter("dispatch_total", { agent: input.subagent, mode: "background" }).inc();
      metrics.gauge("inflight_tasks").inc();
      this.incInflight(task.parentSessionId);
      task.progress.lastUpdate = new Date();
      this.persistState();

      debugLog("launch", taskId, `session created: ${session.id}`);

      if (input.run_in_background) {
        await this.client.session.promptAsync({
          path: { id: session.id },
          body: {
            agent: input.subagent,
            parts: [{ type: "text", text: input.prompt }],
          },
        });

        debugLog("launch", taskId, "promptAsync sent — registering with poller");
        this.poller.registerTask(taskId, session.id);
      }
    } catch (err) {
      task.status = "error";
      task.error = err instanceof Error ? err.message : String(err);
      debugLog("launch", taskId, `ERROR: ${task.error}`);
      if (didMarkRunning) {
        this.leaveRunning(taskId);
      } else {
        this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
        this.scheduleCleanup(taskId);
      }
    }

    return task;
  }

  /**
   * Execute a synchronous (blocking) dispatch. NOT tracked in this.tasks,
   * NOT persisted, NOT registered with the poller. Protected by:
   * - Cancelable concurrency acquire (shared "default" pool with background tasks)
   * - syncTimeoutMs config for both acquire-wait and prompt phases
   * - AbortController + session.abort() for prompt timeout
   * - Leak-free: cancelAcq on acquire timeout, didAcquire guard on release
   *
   * Returns the joined text of all assistant text parts.
   * Throws on timeout or network/session error.
   */
  async executeSync(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<string> {
    const timeoutMs = this.config.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
    let didAcquire = false;

    // Step 1: Cancelable acquire covering the wait phase
    const { promise: acq, cancel: cancelAcq } = this.concurrency.acquireCancelable(DEFAULT_CONCURRENCY_KEY);
    let acqTimer: ReturnType<typeof setTimeout> | undefined;
    const acqTimeout = new Promise<"timeout">((r) => {
      acqTimer = setTimeout(() => r("timeout"), timeoutMs);
    });
    const acqResult = await Promise.race([acq.then(() => "acquired" as const), acqTimeout]);
    clearTimeout(acqTimer);

    if (acqResult === "timeout") {
      cancelAcq();
      throw new Error(`executeSync timed out waiting for a concurrency slot after ${timeoutMs}ms`);
    }
    didAcquire = true;
    metrics.counter("dispatch_total", { agent: input.subagent, mode: "sync" }).inc();

    try {
      // Step 2: Session create
      const createResult = await this.client.session.create({
        body: { parentID: parentContext.sessionID },
        query: { directory: parentContext.directory },
      });
      const session = createResult.data;
      if (!session) throw new Error("Failed to create session: empty response");

      // Step 3: Prompt with abort + timeout
      const controller = new AbortController();
      let promptTimer: ReturnType<typeof setTimeout> | undefined;
      const promptTimeout = new Promise<never>((_, rej) => {
        promptTimer = setTimeout(() => {
          controller.abort();
          void this.client.session.abort({ path: { id: session.id } });
          rej(new Error(`executeSync prompt timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        const promptResult: { data?: { parts: Array<{ type: string; text?: string }> } } = 
          await Promise.race([
            this.client.session.prompt({
              path: { id: session.id },
              body: {
                agent: input.subagent,
                parts: [{ type: "text", text: input.prompt }],
              },
              signal: controller.signal,
            }),
            promptTimeout,
          ]);

        clearTimeout(promptTimer);

        const response = promptResult.data;
        if (!response) return "";
        const text = response.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("");
        return text;
      } finally {
        clearTimeout(promptTimer);
      }
    } finally {
      if (didAcquire) {
        this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
      }
    }
  }

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

  /** Return a snapshot of current dispatch metrics. */
  getMetricsSnapshot(): import("./metrics.ts").MetricsSnapshot {
    return metrics.snapshot();
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Don't cancel tasks that have already reached a terminal state
    if (
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "timeout" ||
      task.status === "cancelled"
    ) {
      debugLog("cancelTask", taskId, `already in terminal status ${task.status} — skipping`);
      return false;
    }

    // Don't cancel tasks while a notification is in-flight
    if (this.pendingNotifications.has(taskId)) {
      debugLog("cancelTask", taskId, `has in-flight notification — skipping`);
      return false;
    }

    try {
      await this.client.session.abort({
        path: { id: task.sessionId },
      });
    } catch (err) {
      debugLog("cancelTask", taskId, `Session cancel failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!this.transition(taskId, ["pending", "running"], "cancelled")) return false;
    const t = this.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✕ cancelled agent=${t.agent}`);
    metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
    this.poller.unregisterTask(taskId);
    this.sessionMonitor.clearTask(taskId);
    void this.notifyCompletion(t);
    this.leaveRunning(taskId);
    return true;
  }

  async getResult(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      if (this.cleanedUpTasks.has(taskId)) {
        return ""; // Task was cleaned up after completion — result no longer available
      }
      return ""; // Task never existed
    }

    const messagesResult = await this.client.session.messages({
      path: { id: task.sessionId },
    });

    if (messagesResult.error !== undefined) {
      return `[Error retrieving task output: ${JSON.stringify(messagesResult.error)}]`;
    }

    const messages = messagesResult.data ?? [];

    const textParts: string[] = [];
    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (part.type === "text") {
          textParts.push(
            (part as { type: "text"; text: string }).text,
          );
        }
      }
    }

    return textParts.join("");
  }

  cleanupTask(taskId: string): void {
    this.tasks.delete(taskId);
    this.persistState();
    this.cleanedUpTasks.add(taskId);
    if (this.cleanedUpTasks.size > 500) {
      const oldest = this.cleanedUpTasks.values().next().value;
      if (oldest !== undefined) this.cleanedUpTasks.delete(oldest);
    }
    const timer = this.cleanupTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(taskId);
    }
  }

  private persistState(): void {
    this.store.save(this.tasks);
  }

  private restoreState(): void {
    const loaded = this.store.load();
    if (!loaded) return;
    for (const [taskId, task] of loaded) {
      this.tasks.set(taskId, task);
    }
  }

  /**
   * Set the workspace directory used for multi-instance state file isolation.
   * Must be called before recover() if the default process.cwd() is wrong.
   */
  setStoreDirectory(directory: string): void {
    this.store = new TaskStateStore(directory);
  }

  async recover(): Promise<void> {
    if (this._recovered) return;
    this._recovered = true;

    this.restoreState();

    const runningTasks: DispatchTask[] = [];
    const toRemove: string[] = [];

    for (const [taskId, task] of this.tasks) {
      switch (task.status) {
        case "pending":
          toRemove.push(taskId);
          break;
        case "running":
          runningTasks.push(task);
          break;
        case "completed":
        case "error":
        case "timeout":
        case "cancelled":
          this.scheduleCleanupFromRecovery(taskId, task);
          break;
      }
    }

    // Remove silent pending tasks
    for (const id of toRemove) {
      this.tasks.delete(id);
    }

    // Verify each running task's session
    for (const task of runningTasks) {
      try {
        const result = await this.client.session.get({
          path: { id: task.sessionId },
        });
        if (result.data) {
          const occupied = this.concurrency.forceOccupy(DEFAULT_CONCURRENCY_KEY);
          if (occupied === 1) {
            task.concurrencyKey = DEFAULT_CONCURRENCY_KEY;
            this.poller.registerTask(task.id, task.sessionId);
            this.incInflight(task.parentSessionId);
            debugLog("recover", task.id, `session ${task.sessionId} alive — re-registered`);
          } else {
            // Would exceed concurrency limit — error the task out
            this.transition(task.id, ["running"], "error", {
              error: "Exceeded concurrency limit on recovery",
            });
            this.scheduleCleanup(task.id);
            debugLog("recover", task.id, "dropped — concurrency limit exceeded on recovery");
          }
        } else {
          task.status = "error";
          task.error = "Session lost after process restart";
          task.completedAt = new Date();
          this.scheduleCleanup(task.id);
          debugLog("recover", task.id, "session gone after restart");
        }
      } catch {
        task.status = "error";
        task.error = "Session verification failed after restart";
        task.completedAt = new Date();
        this.scheduleCleanup(task.id);
      }
    }

    if (toRemove.length > 0 || runningTasks.length > 0) {
      this.persistState();
    }
  }

  private scheduleCleanupFromRecovery(taskId: string, task: DispatchTask): void {
    if (!task.completedAt) {
      this.scheduleCleanup(taskId);
      return;
    }
    const elapsed = Date.now() - new Date(task.completedAt).getTime();
    const remaining = Math.max(this.config.taskTtlMs - elapsed, 0);
    if (remaining === 0) {
      this.cleanupTask(taskId);
      return;
    }
    const timer = setTimeout(() => {
      this.cleanupTask(taskId);
    }, remaining);
    this.cleanupTimers.set(taskId, timer);
  }

  async notifyCompletion(task: DispatchTask): Promise<void> {
    const remainingCount = this.getInflight(task.parentSessionId);

    this.pendingNotifications.add(task.id);
    try {
      await notifyParent(this.client, task, remainingCount);
    } finally {
      this.pendingNotifications.delete(task.id);
    }
  }

  async handleSessionIdle(sessionId: string): Promise<void> {
    let targetTask: DispatchTask | undefined;
    let targetTaskId: string | undefined;

    for (const [taskId, task] of this.tasks) {
      if (task.sessionId === sessionId && task.status === "running") {
        targetTask = task;
        targetTaskId = taskId;
        break;
      }
    }

    if (!targetTask || !targetTaskId) return;

    const elapsed = Date.now() - targetTask.startedAt.getTime();
    // Different from the hasAssistantOutput check below: this debounces idle events
    // for tasks that are too young to have produced any output. The output check
    // determines whether the model has actually responded.
    if (elapsed < this.config.minRuntimeMs) {
      debugLog("event", targetTaskId, `session.idle too early (${elapsed}ms), deferring`);
      return;
    }

    try {
      debugLog("event", targetTaskId, "session.idle received — validating output");

      const msgResult = await this.client.session.messages({
        path: { id: sessionId },
      });

      const messages = (msgResult.data ?? []) as Array<{
        info: { role: string; finish?: string; error?: unknown };
        parts: Array<{ type: string; state?: string; text?: string }>;
      }>;

      let hasAssistantOutput = false;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.info.role === "assistant") {
          const hasText = m.parts.some(p => p.type === "text" && p.text && p.text.length > 0);
          const hasToolResult = m.parts.some(p => p.type === "tool");
          const hasPendingTools = m.parts.some(p => p.type === "tool" && (p.state === "pending" || p.state === "running"));

          if (hasPendingTools) {
            debugLog("event", targetTaskId, "session.idle but tools still pending — skipping");
            return;
          }

          if (hasText || hasToolResult) {
            hasAssistantOutput = true;
          }
          break;
        }
      }

      if (!hasAssistantOutput) {
        debugLog("event", targetTaskId, "session.idle but no assistant output yet — skipping");
        return;
      }

      debugLog("event", targetTaskId, "session.idle validated — completing task");
      // Gate through transition: only the winner proceeds
      if (!this.transition(targetTaskId, ["running"], "completed")) {
        debugLog("event", targetTaskId, "session.idle race lost — poller already completed this task");
        return;
      }
      // Winner: unregister (idle handler's responsibility) + finalize
      this.poller.unregisterTask(targetTaskId);
      this.finalizeCompletion(targetTaskId);
    } catch (err) {
      debugLog("event", targetTaskId, "handleSessionIdle error: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private incInflight(parentSessionId: string): void {
    this.inflightByParent.set(parentSessionId, (this.inflightByParent.get(parentSessionId) ?? 0) + 1);
  }

  private decInflight(parentSessionId: string): void {
    const current = this.inflightByParent.get(parentSessionId);
    if (current === undefined) return;
    if (current <= 1) {
      this.inflightByParent.delete(parentSessionId);
    } else {
      this.inflightByParent.set(parentSessionId, current - 1);
    }
  }

  private getInflight(parentSessionId: string): number {
    return this.inflightByParent.get(parentSessionId) ?? 0;
  }

  /** Atomic compare-and-swap status transition. Returns true iff THIS call won the race. */
  private transition(
    taskId: string,
    from: DispatchTaskStatus[],
    to: DispatchTaskStatus,
    fields?: Partial<Pick<DispatchTask, "error" | "completedAt">>,
  ): boolean {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (!from.includes(t.status)) return false;
    t.status = to;
    t.completedAt = fields?.completedAt ?? new Date();
    if (fields?.error !== undefined) t.error = fields.error;
    return true;
  }

  private handleTaskCompleted(taskId: string): void {
    if (!this.transition(taskId, ["pending", "running"], "completed")) return;
    const t = this.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✓ completed agent=${t.agent}`);
    this.finalizeCompletion(taskId);
  }

  private handleTaskError(taskId: string, error: string): void {
    if (!this.transition(taskId, ["pending", "running"], "error", { error })) return;
    const t = this.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✗ error agent=${t.agent}: ${error}`);
    metrics.counter("dispatch_error_total", { agent: t.agent }).inc();
    void this.notifyCompletion(t);
    this.leaveRunning(taskId);
  }

  private handleTaskTimeout(taskId: string, reason: string): void {
    if (!this.transition(taskId, ["pending", "running"], "timeout", { error: reason })) return;
    const t = this.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: ${reason}`);
    metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
    void this.notifyCompletion(t);
    this.leaveRunning(taskId);
  }

  /** Shared winner-branch side effects after a successful transition. */
  private finalizeCompletion(taskId: string): void {
    const t = this.tasks.get(taskId)!;
    const duration = Date.now() - t.startedAt.getTime();
    infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
    metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
    metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
    void this.notifyCompletion(t);
    this.leaveRunning(taskId);
  }

  /**
   * Centralized teardown for all terminal paths. Handles:
   * - concurrency slot release (guarded: only if concurrencyKey set)
   * - parent inflight counter decrement
   * - inflight_tasks gauge decrement
   * - state persistence
   * - delayed cleanup scheduling
   *
   * Must only be called after acquire/gauge.inc() have been performed.
   * Pool-rejected and failed-before-running paths must NOT call this.
   */
  private leaveRunning(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.concurrencyKey) {
      this.concurrency.release(t.concurrencyKey);
    } else {
      debugLog("leaveRunning", taskId, "concurrencyKey is empty — skipping release to prevent ghost slot injection");
    }
    this.decInflight(t.parentSessionId);
    metrics.gauge("inflight_tasks").dec();
    this.persistState();
    this.scheduleCleanup(taskId);
  }

  private scheduleCleanup(taskId: string): void {
    const existing = this.cleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      if (this.pendingNotifications.has(taskId)) {
        this.scheduleCleanup(taskId);
        return;
      }
      this.cleanupTask(taskId);
    }, this.config.taskTtlMs);

    this.cleanupTimers.set(taskId, timer);
  }
}

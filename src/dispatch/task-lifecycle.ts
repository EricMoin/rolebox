import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  DispatchInput,
  DispatchTask,
  DispatchTaskStatus,
  DispatchManagerConfig,
  TaskEventState,
  SessionMessageSnapshot,
  MaterializedResultRef,
} from "./types.ts";
import {
  DEFAULT_CONFIG,
  SYNC_TIMEOUT_MS,
  DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_SYNC_RESERVED_SLOTS,
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
  BACKGROUND_STALE_TIMEOUT_MS,
  MATERIALIZE_TIMEOUT_MS,
  RESULT_RETENTION_MS,
} from "./config.ts";
import { unlinkSync } from "node:fs";
import type { IConcurrencyManager } from "./concurrency.ts";
import { TaskWatchdogManager } from "./watchdog.ts";
import { detectCompletion } from "./completion-detector.ts";
import { notifyParent } from "./notification.ts";
import { extractResultBlock, readResultSidecar, resultSidecarPath, writeResultSidecar } from "./result-extractor.ts";
import { debugLog, infoLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";
import { withTimeout, TimeoutError } from "./with-timeout.ts";

const DEFAULT_CONCURRENCY_KEY = "default";

/**
 * Shared mutable state injected by DispatchManager.
 * All Map/Set references are shared — mutations are visible to both classes.
 */
export interface TaskLifecycleDeps {
  tasks: Map<string, DispatchTask>;
  eventState: Map<string, TaskEventState>;
  client: OpencodeClient;
  concurrency: IConcurrencyManager;
  watchdog: TaskWatchdogManager;
  config: DispatchManagerConfig;
  cancelQueue: Map<string, () => void>;
  syncControllers: Map<string, AbortController>;
  completedSyncSessions: Map<string, string>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  sidecarGCTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingNotifications: Set<string>;
  sessionToTask: Map<string, string>;
  sessionsByRequest: Map<string, number>;
  notifyOutbox: Set<string>;
  deferredIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  cleanedUpTasks: Map<string, number>;
  subagentModelKey: Map<string, string>;
  directory: string;
  sessionMonitor: {
    verifyExistence: (client: import("@opencode-ai/sdk").OpencodeClient, sessionId: string) => Promise<"exists" | "missing" | "unknown">;
  };

  /** Callback to DispatchManager.cleanupTask — the only DM-owned method needed by lifecycle. */
  cleanupTask: (taskId: string) => void;
  /** Callback to DispatchManager.persistState — debounced state persistence. */
  persistState: () => void;
  /** Callback to DispatchManager.addToOutbox — adds taskId to notify outbox and persists. */
  addToOutbox: (taskId: string) => void;
  /**
   * Callback for sending the actual parent notification.
   * This goes through DispatchManager.notifyCompletion (which tests may override)
   * rather than calling notifyParent directly from the lifecycle.
   * The lifecycle wraps this with pendingNotifications management.
   */
  sendNotification: (task: DispatchTask, remainingTasks: number, resultText?: string) => Promise<boolean>;
}

export class TaskLifecycleManager {
  private d: TaskLifecycleDeps;

  constructor(deps: TaskLifecycleDeps) {
    this.d = deps;
  }

  // ── Model-key helpers ─────────────────────────────────────────

  private deriveKey(subagentId: string): string {
    return this.d.subagentModelKey.get(subagentId) ?? DEFAULT_CONCURRENCY_KEY;
  }

  private computeDepth(parentSessionId: string): number {
    const parentTaskId = this.d.sessionToTask.get(parentSessionId);
    if (!parentTaskId) return 0;
    const parentTask = this.d.tasks.get(parentTaskId);
    if (!parentTask) return 0;
    return (parentTask.depth ?? 0) + 1;
  }

  private getRequestSessions(rootSession: string): number {
    return this.d.sessionsByRequest.get(rootSession) ?? 0;
  }

  private incRequestSessions(rootSession: string): void {
    this.d.sessionsByRequest.set(rootSession, (this.d.sessionsByRequest.get(rootSession) ?? 0) + 1);
  }

  resetRequestSessions(rootSession: string): void {
    this.d.sessionsByRequest.delete(rootSession);
  }

  /** Atomic compare-and-swap status transition. Returns true iff THIS call won the race. */
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

  getInflightCount(parentSessionId: string): number {
    let count = 0;
    for (const task of this.d.tasks.values()) {
      if (task.parentSessionId === parentSessionId &&
          (task.status === "running" || task.status === "pending")) {
        count++;
      }
    }
    return count;
  }

  // ── launch() ──────────────────────────────────────────────────

  async launch(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<DispatchTask> {
    const taskId = `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const concurrencyKey = this.deriveKey(input.subagent);

    const budget = this.d.config.maxTotalSessionsPerRequest;
    const root = parentContext.sessionID;
    if (budget !== undefined && this.getRequestSessions(root) >= budget) {
      metrics.counter("dispatch_rejected_total", { reason: "budget-exhausted" }).inc();
      const task: DispatchTask = {
        id: taskId,
        sessionId: "",
        parentSessionId: parentContext.sessionID,
        parentAgent: parentContext.agent,
        depth: this.computeDepth(parentContext.sessionID),
        status: "error",
        agent: input.subagent,
        prompt: input.prompt,
        description: input.description,
        startedAt: new Date(),
        completedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        timeoutMs: input.timeout_ms,
        error: JSON.stringify({
          error: "Session budget exhausted",
          limit: budget,
          spawned: this.getRequestSessions(root),
        }),
      };
      this.d.tasks.set(taskId, task);
      this.scheduleCleanup(taskId);
      void this.notifyCompletion(task, this.getInflightCount(task.parentSessionId));
      return task;
    }

    const task: DispatchTask = {
      id: taskId,
      sessionId: "",
      parentSessionId: parentContext.sessionID,
      parentAgent: parentContext.agent,
      depth: this.computeDepth(parentContext.sessionID),
      status: "pending",
      agent: input.subagent,
      prompt: input.prompt,
      description: input.description,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      timeoutMs: input.timeout_ms,
    };

    this.d.tasks.set(taskId, task);
    this.incRequestSessions(root);

    debugLog("launch", taskId, `agent=${input.subagent} key=${concurrencyKey} bg=${input.run_in_background} desc="${input.description ?? ""}"`);

    const acqResult = this.d.concurrency.acquireBackground(concurrencyKey, {
      parentId: task.parentSessionId,
      maxActivePerParent: this.d.config.maxActivePerParent,
    });

    switch (acqResult.outcome) {
      case "full": {
        const maxRetries = this.d.config.backpressureMaxRetries ?? 0;
        if (maxRetries > 0) {
          task.concurrencyKey = concurrencyKey;
          debugLog("launch", taskId, `QUEUE-FULL — scheduling backpressure retry (0/${maxRetries})`);
          this._scheduleBackpressureRetry(taskId, concurrencyKey, input, parentContext, 0, maxRetries);
          return task;
        }

        metrics.counter("dispatch_rejected_total", { reason: "queue-full" }).inc();
        task.status = "error";
        task.error = JSON.stringify({
          error: "Queue is full",
          retry_after: acqResult.error.retryAfter,
          queue_depth: acqResult.error.depth,
          limit: acqResult.error.limit,
        });
        task.completedAt = new Date();
        debugLog("launch", taskId, `REJECTED: queue-full depth=${acqResult.error.depth}/${acqResult.error.limit}`);
        this.scheduleCleanup(taskId);
        void this.notifyCompletion(task, this.getInflightCount(task.parentSessionId));
        return task;
      }

      case "acquired": {
        task.concurrencyKey = concurrencyKey;
        await this.startBackgroundTask(taskId, input, parentContext);
        return task;
      }

      case "queued": {
        task.concurrencyKey = concurrencyKey;
        this.d.cancelQueue.set(taskId, acqResult.cancel);
        debugLog("launch", taskId, `QUEUED — returning pending task immediately`);
        void acqResult.promise.then(() => this._promoteQueued(taskId, input, parentContext));
        return task;
      }
    }
  }

  private async startBackgroundTask(
    taskId: string,
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<void> {
    const task = this.d.tasks.get(taskId);
    if (!task) return;

    let didMarkRunning = false;

    try {
      const createResult = await this.d.client.session.create({
        body: input.noParentInherit ? {} : { parentID: parentContext.sessionID },
        query: { directory: parentContext.directory },
      });

      const session = createResult.data;
      if (!session) throw new Error("Failed to create session: empty response");

      task.sessionId = session.id;
      this.d.sessionToTask.set(session.id, taskId);
      this.d.eventState.set(taskId, {
        lastMessageCount: 0,
        lastProgressUpdate: Date.now(),
        hasProducedOutput: false,
        messageCountAtStart: 0,
        lastEventAt: Date.now(),
      });
      task.status = "running";
      didMarkRunning = true;
      infoLog("launch", taskId, `running agent=${input.subagent}`);
      metrics.counter("dispatch_total", { agent: input.subagent, mode: "background" }).inc();
      metrics.gauge("inflight_tasks").inc();
      task.progress.lastUpdate = new Date();
      this.d.persistState();

      debugLog("launch", taskId, `session created: ${session.id}`);

      if (input.run_in_background) {
        await this.d.client.session.promptAsync({
          path: { id: session.id },
          body: {
            agent: input.subagent,
            parts: [{ type: "text", text: input.prompt }],
          },
        });

        debugLog("launch", taskId, "promptAsync sent — registering with watchdog");
        this.d.watchdog.registerTask(taskId);
      }
    } catch (err) {
      task.status = "error";
      task.error = err instanceof Error ? err.message : String(err);
      debugLog("launch", taskId, `ERROR: ${task.error}`);
      if (didMarkRunning) {
        this.d.sessionToTask.delete(task.sessionId);
        task.completedAt = new Date();
        this.leaveRunning(taskId);
        void notifyParent(this.d.client, task, 0, { maxRetries: 0 });
      } else {
        this.d.concurrency.release(task.concurrencyKey!, task.parentSessionId);
        this.scheduleCleanup(taskId);
      }
    }
  }

  private async _promoteQueued(
    taskId: string,
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<void> {
    this.d.cancelQueue.delete(taskId);

    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== "pending") {
      this.d.concurrency.release(task?.concurrencyKey ?? this.deriveKey(input.subagent), task?.parentSessionId);
      return;
    }

    await this.startBackgroundTask(taskId, input, parentContext);
  }

  private _scheduleBackpressureRetry(
    taskId: string,
    concurrencyKey: string,
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
    attempt: number,
    maxRetries: number,
  ): void {
    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== "pending") return;

    const retryAfterMs = this.d.config.retryAfterMs;
    const maxDelayMs = this.d.config.backpressureMaxDelayMs ?? 60000;
    const delay = Math.min(retryAfterMs * Math.pow(2, attempt), maxDelayMs);
    metrics.counter("dispatch_backpressure_retry_total", { key: concurrencyKey }).inc();

    debugLog("launch", taskId, `backpressure retry attempt=${attempt + 1}/${maxRetries} delay=${delay}ms`);

    const timer = setTimeout(() => {
      this.d.cancelQueue.delete(taskId);
      const currentTask = this.d.tasks.get(taskId);
      if (!currentTask || currentTask.status !== "pending") return;

      const acqResult = this.d.concurrency.acquireBackground(concurrencyKey, {
        parentId: task.parentSessionId,
        maxActivePerParent: this.d.config.maxActivePerParent,
      });

      if (acqResult.outcome === "acquired") {
        debugLog("launch", taskId, `backpressure retry ${attempt + 1}: acquired`);
        void this.startBackgroundTask(taskId, input, parentContext);
        return;
      }

      if (acqResult.outcome === "queued") {
        debugLog("launch", taskId, `backpressure retry ${attempt + 1}: queued`);
        this.d.cancelQueue.set(taskId, acqResult.cancel);
        void acqResult.promise.then(() => this._promoteQueued(taskId, input, parentContext));
        return;
      }

      if (attempt + 1 >= maxRetries) {
        debugLog("launch", taskId, `backpressure exhausted after ${maxRetries} attempts`);
        metrics.counter("dispatch_rejected_total", { reason: "backpressure-exhausted" }).inc();
        task.status = "error";
        task.error = JSON.stringify({
          error: "Queue is full after backpressure retries exhausted",
          attempts: attempt + 1,
          retry_after: acqResult.error.retryAfter,
          queue_depth: acqResult.error.depth,
          limit: acqResult.error.limit,
        });
        task.completedAt = new Date();
        this.scheduleCleanup(taskId);
        void this.notifyCompletion(task, this.getInflightCount(task.parentSessionId));
        return;
      }

      this._scheduleBackpressureRetry(taskId, concurrencyKey, input, parentContext, attempt + 1, maxRetries);
    }, delay);

    this.d.cancelQueue.set(taskId, () => clearTimeout(timer));
  }

  // ── executeSync() ─────────────────────────────────────────────

  async executeSync(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<string> {
    const acquireTimeoutMs = this.d.config.syncAcquireTimeoutMs ?? DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS;
    const promptTimeoutMs = input.sync_timeout_ms
      ?? this.d.config.syncPromptTimeoutMs
      ?? this.d.config.syncTimeoutMs
      ?? SYNC_TIMEOUT_MS;
    const concurrencyKey = this.deriveKey(input.subagent);

    const callerDepth = this.computeDepth(parentContext.sessionID);
    if (callerDepth > 0) {
      throw new Error(JSON.stringify({
        error: "Synchronous dispatch forbidden at depth>0",
        depth: callerDepth,
      }));
    }

    const budget = this.d.config.maxTotalSessionsPerRequest;
    const root = parentContext.sessionID;
    const isNewSession = !input.session_id;

    let existingSessionId: string | undefined;
    if (input.session_id) {
      const prevTask = this.d.tasks.get(input.session_id);
      if (prevTask && prevTask.sessionId) {
        existingSessionId = prevTask.sessionId;
      } else if (this.d.completedSyncSessions.has(input.session_id)) {
        existingSessionId = this.d.completedSyncSessions.get(input.session_id)!;
      } else {
        throw new Error(JSON.stringify({
          error: `Session continuation: task '${input.session_id}' not found or has no session`,
          phase: "continuation",
        }));
      }
    }

    if (isNewSession && budget !== undefined && this.getRequestSessions(root) >= budget) {
      metrics.counter("dispatch_rejected_total", { reason: "budget-exhausted" }).inc();
      throw new Error(JSON.stringify({
        error: "Session budget exhausted",
        limit: budget,
        spawned: this.getRequestSessions(root),
      }));
    }

    const taskId = `sync_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const task: DispatchTask = {
      id: taskId,
      sessionId: existingSessionId ?? "",
      parentSessionId: parentContext.sessionID,
      parentAgent: parentContext.agent,
      depth: this.computeDepth(parentContext.sessionID),
      status: "pending",
      agent: input.subagent,
      prompt: input.prompt,
      description: input.description,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      mode: "sync",
      continuationOf: existingSessionId ? input.session_id : undefined,
    };
    this.d.tasks.set(taskId, task);

    let didAcquire = false;
    const startTime = Date.now();

    try {
      const { promise: acq, cancel: cancelAcq } = this.d.concurrency.acquireSync(concurrencyKey);
      let acqTimer: ReturnType<typeof setTimeout> | undefined;
      const acqTimeout = new Promise<"timeout">((r) => {
        acqTimer = setTimeout(() => r("timeout"), acquireTimeoutMs);
      });
      const acqResult = await Promise.race([acq.then(() => "acquired" as const), acqTimeout]);
      clearTimeout(acqTimer);

      if (acqResult === "timeout") {
        cancelAcq();
        const err = JSON.stringify({
          error: `Timed out waiting for a concurrency slot after ${acquireTimeoutMs}ms`,
          phase: "acquire",
          timeout_ms: acquireTimeoutMs,
        });
        throw new Error(err);
      }
      didAcquire = true;
      metrics.counter("dispatch_total", { agent: input.subagent, mode: "sync" }).inc();
      metrics.gauge("inflight_tasks").inc();

      if (existingSessionId) {
        task.sessionId = existingSessionId;
        this.d.sessionToTask.set(existingSessionId, taskId);
        debugLog("launch", taskId, `continuing session ${existingSessionId}`);
      } else {
        const createTimeoutMs = this.d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS;
        let createResult: Awaited<ReturnType<typeof this.d.client.session.create>>;
        try {
          createResult = await withTimeout(
            this.d.client.session.create({
              body: { parentID: parentContext.sessionID },
              query: { directory: parentContext.directory },
            }),
            createTimeoutMs,
            "session.create",
          );
        } catch (e) {
          if (e instanceof TimeoutError) {
            const err = JSON.stringify({
              error: `Session create timed out after ${createTimeoutMs}ms`,
              phase: "session",
              timeout_ms: createTimeoutMs,
            });
            throw new Error(err);
          }
          throw e;
        }
        const session = createResult.data;
        if (!session) {
          const err = JSON.stringify({
            error: "Failed to create session: empty response",
            phase: "session",
            timeout_ms: promptTimeoutMs,
          });
          throw new Error(err);
        }

        task.sessionId = session.id;
        this.d.sessionToTask.set(session.id, taskId);
        this.d.completedSyncSessions.set(taskId, session.id);
        if (isNewSession) this.incRequestSessions(root);
      }

      const controller = new AbortController();
      this.d.syncControllers.set(taskId, controller);
      let promptTimer: ReturnType<typeof setTimeout> | undefined;
      const promptTimeout = new Promise<never>((_, rej) => {
        promptTimer = setTimeout(() => {
          controller.abort();
          void this.d.client.session.abort({ path: { id: task.sessionId } });
          const err = JSON.stringify({
            error: `Prompt timed out after ${promptTimeoutMs}ms`,
            phase: "prompt",
            timeout_ms: promptTimeoutMs,
          });
          rej(new Error(err));
        }, promptTimeoutMs);
      });

      try {
        const promptResult: { data?: { parts: Array<{ type: string; text?: string }> } } =
          await Promise.race([
            this.d.client.session.prompt({
              path: { id: task.sessionId },
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
        const text = response
          ? response.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("")
          : "";
        metrics.counter("dispatch_completed_total", { mode: "sync" }).inc();
        metrics.histogram("task_duration_ms", { mode: "sync" }).observe(Date.now() - startTime);
        return text;
      } finally {
        clearTimeout(promptTimer);
      }
    } catch (err) {
      metrics.counter("dispatch_error_total", { mode: "sync" }).inc();
      throw err;
    } finally {
      metrics.gauge("inflight_tasks").dec();
      this.d.syncControllers.delete(taskId);
      this.d.sessionToTask.delete(task.sessionId);
      this.d.tasks.delete(taskId);
      if (didAcquire) {
        this.d.concurrency.release(concurrencyKey, parentContext.sessionID);
      }
    }
  }

  // ── reopenForContinuation() ───────────────────────────────────

  async reopenForContinuation(
    taskId: string,
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<DispatchTask> {
    if (this.d.cleanedUpTasks.has(taskId)) throw new Error(`Task '${taskId}' was cleaned up`);
    const task = this.d.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (task.agent !== input.subagent) throw new Error(`Task '${taskId}' agent mismatch: expected ${task.agent}, got ${input.subagent}`);

    const concurrencyKey = this.deriveKey(input.subagent);
    const acqResult = this.d.concurrency.acquireBackground(concurrencyKey, {
      parentId: task.parentSessionId,
      maxActivePerParent: this.d.config.maxActivePerParent,
    });

    if (acqResult.outcome === "full" || acqResult.outcome === "queued") {
      if (acqResult.outcome === "queued") {
        acqResult.cancel();
      }
      metrics.counter("dispatch_rejected_total", { reason: "queue-full" }).inc();
      task.status = "error";
      task.error = JSON.stringify({
        error: "Queue is full",
        retry_after: acqResult.outcome === "full" ? acqResult.error.retryAfter : 30_000,
        queue_depth: 0,
        limit: 1,
      });
      task.completedAt = new Date();
      debugLog("reopen", taskId, `REJECTED: no slot available`);
      this.scheduleCleanup(taskId);
      void this.notifyCompletion(task, this.getInflightCount(task.parentSessionId));
      return task;
    }

    const msgResult = await withTimeout(
      this.d.client.session.messages({ path: { id: task.sessionId } }),
      this.d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
      "reopen:session.messages",
    );
    const messageCountAtStart = (msgResult.data ?? []).length;

    this.transition(taskId, ["completed", "error", "timeout", "running"], "running", { completedAt: undefined });
    task.startedAt = new Date();
    task.progress = { lastUpdate: new Date(), toolCalls: 0 };
    task.error = undefined;
    task.messageCountAtStart = messageCountAtStart;
    if (input.timeout_ms !== undefined) {
      task.timeoutMs = input.timeout_ms;
    }
    task.concurrencyKey = concurrencyKey;

    debugLog("reopen", taskId, `continuing ${task.agent} on session ${task.sessionId} (msgCount=${messageCountAtStart})`);

    await this.d.client.session.promptAsync({
      path: { id: task.sessionId },
      body: {
        agent: input.subagent,
        parts: [{ type: "text", text: input.prompt }],
      },
    });

    this.d.watchdog.cancelDebounce(taskId);
    this.d.watchdog.unregisterTask(taskId);
    this.d.watchdog.registerTask(taskId);

    const es = this.d.eventState.get(taskId) ?? {
      lastMessageCount: 0,
      lastProgressUpdate: Date.now(),
      hasProducedOutput: false,
      messageCountAtStart: 0,
      lastEventAt: Date.now(),
    };
    es.messageCountAtStart = messageCountAtStart;
    es.lastProgressUpdate = Date.now();
    es.hasProducedOutput = false;
    es.lastEventAt = Date.now();
    this.d.eventState.set(taskId, es);

    this.d.sessionToTask.set(task.sessionId, taskId);
    metrics.gauge("inflight_tasks").inc();
    this.d.persistState();

    return task;
  }

  // ── cancelTask() ──────────────────────────────────────────────

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.d.tasks.get(taskId);
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

    if (this.d.pendingNotifications.has(taskId)) {
      debugLog("cancelTask", taskId, `has in-flight notification — skipping`);
      return false;
    }

    // Handle pending (queued) task
    if (task.status === "pending") {
      const cancelHandle = this.d.cancelQueue.get(taskId);
      if (cancelHandle) {
        cancelHandle();
        this.d.cancelQueue.delete(taskId);
      }
      if (!this.transition(taskId, ["pending"], "cancelled")) return false;
      const t = this.d.tasks.get(taskId)!;
      infoLog("lifecycle", taskId, `✕ cancelled (queued) agent=${t.agent}`);
      metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
      void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
      this.scheduleCleanup(taskId);
      return true;
    }

    // Sync task
    if (task.mode === "sync") {
      const controller = this.d.syncControllers.get(taskId);
      if (controller) {
        if (task.sessionId) {
          try {
            await this.d.client.session.abort({ path: { id: task.sessionId } });
          } catch (err) {
            debugLog("cancelTask", taskId, `Session cancel failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        controller.abort();
      }
      if (!this.transition(taskId, ["pending"], "cancelled")) return false;
      const t = this.d.tasks.get(taskId)!;
      infoLog("lifecycle", taskId, `✕ cancelled (sync) agent=${t.agent}`);
      metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
      return true;
    }

    // Running task
    if (!this.transition(taskId, ["pending", "running"], "cancelled")) return false;

    try {
      await this.d.client.session.abort({
        path: { id: task.sessionId },
      });
    } catch (err) {
      debugLog("cancelTask", taskId, `Session cancel failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
    }
    const t = this.d.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✕ cancelled agent=${t.agent}`);
    metrics.counter("dispatch_cancelled_total", { agent: t.agent }).inc();
    this.d.watchdog.unregisterTask(taskId);
    this.d.watchdog.cancelDebounce(taskId);
    void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
    this.leaveRunning(taskId);
    return true;
  }

  // ── getResult() ───────────────────────────────────────────────

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
    const task = this.d.tasks.get(taskId);

    // Step 1: Check task.result (cache hit)
    if (task?.result) {
      if (task.result.fetchError) {
        return {
          kind: "fetch_error",
          text: "",
          resultText: "",
          hadFence: false,
          totalChars: 0,
          error: task.result.fetchError,
        };
      }
      const sidecarText = readResultSidecar(task.result.sidecarPath);
      if (sidecarText !== null) {
        const extracted = extractResultBlock(sidecarText);
        return {
          kind: "ok",
          text: sidecarText,
          resultText: extracted.result,
          hadFence: extracted.hadFence,
          totalChars: task.result.totalChars,
        };
      }
    }

    // Step 2: Task completed but no result (lazy backward-compat fetch)
    if (task && task.status === "completed" && !task.result) {
      const ref = await this.materializeResult(taskId);
      task.result = ref;
      this.d.persistState();

      if (ref.fetchError) {
        return {
          kind: "fetch_error",
          text: "",
          resultText: "",
          hadFence: false,
          totalChars: 0,
          error: ref.fetchError,
        };
      }
      const sidecarText = readResultSidecar(ref.sidecarPath);
      if (sidecarText !== null) {
        const extracted = extractResultBlock(sidecarText);
        return {
          kind: "ok",
          text: sidecarText,
          resultText: extracted.result,
          hadFence: extracted.hadFence,
          totalChars: ref.totalChars,
        };
      }
    }

    // Step 3: Task missing but sidecar exists
    if (!task) {
      const sidecarPath = resultSidecarPath(taskId, this.d.directory);
      const sidecarText = readResultSidecar(sidecarPath);
      if (sidecarText !== null) {
        const extracted = extractResultBlock(sidecarText);
        return {
          kind: "ok",
          text: sidecarText,
          resultText: extracted.result,
          hadFence: extracted.hadFence,
          totalChars: sidecarText.length,
        };
      }
    }

    // Step 4: Expired / Not found
    if (task) {
      return {
        kind: "expired",
        text: "",
        resultText: "",
        hadFence: false,
        totalChars: 0,
        error: "Task status neither completed nor has materialized result",
      };
    }
    if (this.d.cleanedUpTasks.has(taskId)) {
      return {
        kind: "expired",
        text: "",
        resultText: "",
        hadFence: false,
        totalChars: 0,
        error: "Task result no longer available (was cleaned up)",
      };
    }
    return {
      kind: "not_found",
      text: "",
      resultText: "",
      hadFence: false,
      totalChars: 0,
      error: "Task never existed",
    };
  }

  // ── materializeResult() ───────────────────────────────────────

  private async materializeResult(taskId: string): Promise<MaterializedResultRef> {
    const task = this.d.tasks.get(taskId);
    if (!task) {
      return {
        sidecarPath: "",
        totalChars: 0,
        hadFence: false,
        fetchError: "task not found",
        materializedAt: new Date().toISOString(),
      };
    }

    const boundary = task.messageCountAtStart ?? 0;

    try {
      const messagesResult = await withTimeout(
        this.d.client.session.messages({ path: { id: task.sessionId } }),
        this.d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
        "materializeResult:session.messages",
      );

      if (messagesResult.error !== undefined) {
        return {
          sidecarPath: "",
          totalChars: 0,
          hadFence: false,
          fetchError: `Error retrieving task output: ${JSON.stringify(messagesResult.error)}`,
          materializedAt: new Date().toISOString(),
        };
      }

      const allMessages = (messagesResult.data ?? []) as SessionMessageSnapshot[];
      const fullText = this.buildAssistantText(allMessages, boundary);
      const extracted = extractResultBlock(fullText);
      const path = writeResultSidecar(taskId, fullText, this.d.directory);

      return {
        sidecarPath: path,
        totalChars: fullText.length,
        hadFence: extracted.hadFence,
        materializedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      if (err instanceof TimeoutError) {
        return {
          sidecarPath: "",
          totalChars: 0,
          hadFence: false,
          fetchError: "timeout",
          materializedAt: new Date().toISOString(),
        };
      }
      return {
        sidecarPath: "",
        totalChars: 0,
        hadFence: false,
        fetchError: String(err),
        materializedAt: new Date().toISOString(),
      };
    }
  }

  private buildAssistantText(
    messages: readonly SessionMessageSnapshot[],
    boundary: number,
  ): string {
    const textParts: string[] = [];
    for (let i = boundary; i < messages.length; i++) {
      const msg = messages[i];
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

  // ── notifyCompletion() ────────────────────────────────────────

  async notifyCompletion(task: DispatchTask, remainingTasks: number, resultText?: string): Promise<boolean> {
    this.d.pendingNotifications.add(task.id);
    try {
      return await this.d.sendNotification(task, remainingTasks, resultText);
    } finally {
      this.d.pendingNotifications.delete(task.id);
    }
  }

  // ── scheduleCleanup() ─────────────────────────────────────────

  scheduleCleanup(taskId: string): void {
    const existing = this.d.cleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      if (this.d.pendingNotifications.has(taskId) || this.d.notifyOutbox.has(taskId)) {
        this.scheduleCleanup(taskId);
        return;
      }
      this.d.cleanupTask(taskId);
    }, this.d.config.taskTtlMs);

    this.d.cleanupTimers.set(taskId, timer);
  }

  // ── scheduleSidecarGC() ───────────────────────────────────────

  scheduleSidecarGC(taskId: string): void {
    const t = this.d.tasks.get(taskId);
    if (!t?.result) return;

    const retention = this.d.config.resultRetentionMs ?? RESULT_RETENTION_MS;
    const timer = setTimeout(() => {
      const path = resultSidecarPath(taskId, this.d.directory);
      try { unlinkSync(path); } catch {}
      this.d.sidecarGCTimers.delete(taskId);
    }, retention);
    this.d.sidecarGCTimers.set(taskId, timer);
  }

  // ── leaveRunning() / _clearDeferredIdle() ─────────────────────

  leaveRunning(taskId: string): void {
    const t = this.d.tasks.get(taskId);
    if (!t) return;
    if (t.concurrencyKey) {
      this.d.concurrency.release(t.concurrencyKey, t.parentSessionId);
    } else {
      debugLog("leaveRunning", taskId, "concurrencyKey is empty — skipping release to prevent ghost slot injection");
    }
    this._clearDeferredIdle(taskId);
    metrics.gauge("inflight_tasks").dec();
    this.d.persistState();
    this.scheduleCleanup(taskId);
  }

  private _clearDeferredIdle(taskId: string): void {
    const timer = this.d.deferredIdleTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.d.deferredIdleTimers.delete(taskId);
    }
  }

  // ── evaluateAndComplete() ─────────────────────────────────────

  async evaluateAndComplete(
    taskId: string,
    trigger: "idle-debounce" | "watchdog-reconcile" | "global-sweep" | "error-event" | "deleted-event",
    errorDetail?: string,
  ): Promise<void> {
    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== "running") {
      debugLog("evaluate", taskId, `no-op: task ${!task ? "not found" : `status=${task.status}`}`);
      return;
    }

    if (trigger === "error-event") {
      if (this.transition(taskId, ["running"], "error", { error: errorDetail ?? "Task error event received" })) {
        this.d.watchdog.unregisterTask(taskId);
        this.d.watchdog.cancelDebounce(taskId);
        this.finalizeCompletion(taskId);
      }
      return;
    }

    if (trigger === "deleted-event") {
      if (this.transition(taskId, ["running"], "error", { error: "Session deleted" })) {
        this.d.watchdog.unregisterTask(taskId);
        this.d.watchdog.cancelDebounce(taskId);
        this.finalizeCompletion(taskId);
      }
      return;
    }

    try {
      const fetchTimeoutMs = this.d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS;

      let msgResult;
      let statusResult;
      try {
        msgResult = await withTimeout(
          this.d.client.session.messages({ path: { id: task.sessionId } }),
          fetchTimeoutMs,
          "session.messages",
        );
        statusResult = await withTimeout(
          this.d.client.session.status(),
          fetchTimeoutMs,
          "session.status",
        );
      } catch (e) {
        if (e instanceof TimeoutError) {
          debugLog("evaluate", taskId, `fetch timed out after ${fetchTimeoutMs}ms`);
          return;
        }
        throw e;
      }

      if (msgResult.error !== undefined) {
        debugLog("evaluate", taskId, `messages fetch error: ${JSON.stringify(msgResult.error)}`);
        return;
      }

      const allMessages = (msgResult.data ?? []) as SessionMessageSnapshot[];
      const statusMap = (statusResult.data ?? {}) as Record<string, { type: string }>;
      const sessionStatus = statusMap[task.sessionId];

      const eventState = this.d.eventState.get(taskId);
      if (!eventState) return;

      const startIndex = eventState.messageCountAtStart ?? 0;
      const scopedMessages = startIndex > 0 ? allMessages.slice(startIndex) : allMessages;

      if (sessionStatus === undefined) {
        const existence = await this.d.sessionMonitor.verifyExistence(this.d.client, task.sessionId);
        if (existence === "missing") {
          if (this.transition(taskId, ["running"], "error", { error: "Session no longer exists" })) {
            this.d.watchdog.unregisterTask(taskId);
            this.d.watchdog.cancelDebounce(taskId);
            const t = this.d.tasks.get(taskId)!;
            debugLog("evaluate", taskId, `session gone (verifyExistence=missing) — erroring task`);
            void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
            this.leaveRunning(taskId);
          }
          return;
        }
        debugLog("evaluate", taskId, `sessionStatus undefined but verifyExistence=${existence} — treating as idle`);
      }

      const sig = detectCompletion(scopedMessages, sessionStatus, eventState, true);

      switch (sig.type) {
        case "completed": {
          if (trigger === "idle-debounce") {
            const pc = eventState.pendingConfirm;
            if (!pc) {
              eventState.pendingConfirm = { messageCount: scopedMessages.length, at: Date.now() };
              this.d.watchdog.startDebounce(taskId);
              debugLog("evaluate", taskId, `idle-debounce pendingConfirm recorded (msgCount=${scopedMessages.length}) — re-armed`);
              break;
            }
            if (scopedMessages.length !== pc.messageCount) {
              delete eventState.pendingConfirm;
              debugLog("evaluate", taskId, `pendingConfirm failed: msgCount ${pc.messageCount} → ${scopedMessages.length} — staying running`);
              break;
            }
            delete eventState.pendingConfirm;
            debugLog("evaluate", taskId, `pendingConfirm passed: msgCount stable at ${scopedMessages.length} — completing`);
          }
          if (this.transition(taskId, ["running"], "completed")) {
            this.d.watchdog.unregisterTask(taskId);
            this.d.watchdog.cancelDebounce(taskId);
            const t = this.d.tasks.get(taskId)!;
            const duration = Date.now() - t.startedAt.getTime();
            infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
            metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
            metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
            this.leaveRunning(taskId);
            void this.materializeAndNotify(taskId);
          }
          break;
        }
        case "error": {
          if (this.transition(taskId, ["running"], "error", { error: sig.message })) {
            this.d.watchdog.unregisterTask(taskId);
            this.d.watchdog.cancelDebounce(taskId);
            this.finalizeCompletion(taskId);
          }
          break;
        }
        case "not_ready": {
          const now = Date.now();
          const elapsed = now - task.startedAt.getTime();
          const staleMs = task.timeoutMs ?? this.d.config.backgroundStaleTimeoutMs ?? BACKGROUND_STALE_TIMEOUT_MS;
          if (!eventState.hasProducedOutput && elapsed > staleMs) {
            if (this.transition(taskId, ["running"], "timeout", { error: "Never produced output" })) {
              this.d.watchdog.unregisterTask(taskId);
              this.d.watchdog.cancelDebounce(taskId);
              const t = this.d.tasks.get(taskId)!;
              infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: Never produced output`);
              metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
              void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
              this.leaveRunning(taskId);
            }
            break;
          }
          if (eventState.hasProducedOutput && now - eventState.lastProgressUpdate > staleMs) {
            if (this.transition(taskId, ["running"], "timeout", { error: "Task stalled" })) {
              this.d.watchdog.unregisterTask(taskId);
              this.d.watchdog.cancelDebounce(taskId);
              const t = this.d.tasks.get(taskId)!;
              infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: Task stalled`);
              metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
              void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
              this.leaveRunning(taskId);
            }
            break;
          }
          debugLog("evaluate", taskId, `not_ready — no stale timeout`);
          break;
        }
        case "stabilizing": {
          debugLog("evaluate", taskId, `stabilizing with skipStabilityGating=true — treating as completed`);
          if (this.transition(taskId, ["running"], "completed")) {
            this.d.watchdog.unregisterTask(taskId);
            this.d.watchdog.cancelDebounce(taskId);
            const t = this.d.tasks.get(taskId)!;
            const duration = Date.now() - t.startedAt.getTime();
            infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
            metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
            metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
            this.leaveRunning(taskId);
            void this.materializeAndNotify(taskId);
          }
          break;
        }
      }
    } catch (err) {
      debugLog("evaluate", taskId, `error fetching: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Event handlers ────────────────────────────────────────────

  async handleSessionIdle(sessionId: string): Promise<void> {
    const taskId = this.d.sessionToTask.get(sessionId);
    if (!taskId) return;

    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    const elapsed = Date.now() - task.startedAt.getTime();
    if (elapsed < this.d.config.minRuntimeMs) {
      if (!this.d.deferredIdleTimers.has(taskId)) {
        const remaining = this.d.config.minRuntimeMs - elapsed;
        debugLog("event", taskId, `session.idle too early (${elapsed}ms) — deferring by ${remaining}ms`);
        const timer = setTimeout(() => {
          this.d.deferredIdleTimers.delete(taskId);
          const t = this.d.tasks.get(taskId);
          if (t && t.status === "running") {
            void this.handleSessionIdle(sessionId);
          }
        }, remaining);
        this.d.deferredIdleTimers.set(taskId, timer);
      }
      this.d.watchdog.resetWatchdog(taskId);
      return;
    }

    this.d.watchdog.resetWatchdog(taskId);

    try {
      const msgResult = await withTimeout(
        this.d.client.session.messages({ path: { id: sessionId } }),
        this.d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
        "handleSessionIdle:session.messages",
      );
      if (msgResult.error !== undefined) {
        debugLog("event", taskId, `session.idle messages fetch error: ${JSON.stringify(msgResult.error)}`);
        return;
      }

      const allMessages = (msgResult.data ?? []) as Array<{
        info: { role: string; finish?: string; error?: unknown };
        parts: Array<{ type: string; state?: string; text?: string }>;
      }>;

      const eventState = this.d.eventState.get(taskId);
      const startIndex = eventState?.messageCountAtStart ?? 0;
      const messages = allMessages.slice(startIndex);

      let hasAssistantOutput = false;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.info.role === "assistant") {
          const hasPendingTools = m.parts.some(
            (p) => p.type === "tool" && (p.state === "pending" || p.state === "running"),
          );
          if (hasPendingTools) {
            debugLog("event", taskId, "session.idle but tools still pending — skipping");
            return;
          }
          if (m.info.finish === "tool-calls") {
            debugLog("event", taskId, "session.idle but finish=tool-calls — skipping");
            return;
          }
          const hasText = m.parts.some((p) => p.type === "text" && p.text && p.text.length > 0);
          const hasToolResult = m.parts.some((p) => p.type === "tool");
          if (hasText || hasToolResult) {
            hasAssistantOutput = true;
          }
          break;
        }
      }

      if (!hasAssistantOutput) {
        debugLog("event", taskId, "session.idle but no assistant output — skipping");
        return;
      }

      if (this.d.watchdog.isDebouncing(taskId)) {
        debugLog("event", taskId, "already debouncing — ignoring duplicate idle");
        return;
      }

      debugLog("event", taskId, "session.idle validated — starting debounce");
      this.d.watchdog.startDebounce(taskId);
    } catch (err) {
      debugLog("event", taskId, "handleSessionIdle error: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  handleSessionStatus(sessionId: string, statusType: string): void {
    const taskId = this.d.sessionToTask.get(sessionId);
    if (!taskId) return;
    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    const eventState = this.d.eventState.get(taskId);
    if (!eventState) return;

    eventState.lastEventAt = Date.now();
    this.d.watchdog.resetWatchdog(taskId);

    if (statusType === "busy" || statusType === "retry") {
      eventState.lastProgressUpdate = Date.now();
      eventState.hasProducedOutput = true;
      this.d.watchdog.cancelDebounce(taskId);
      debugLog("event", taskId, `session.status=${statusType} — progress heartbeat, cancelled debounce`);
    } else {
      debugLog("event", taskId, `session.status=${statusType} — idle heartbeat (stale clock preserved)`);
    }
  }

  handleMessageUpdated(sessionId: string): void {
    const taskId = this.d.sessionToTask.get(sessionId);
    if (!taskId) return;
    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    const eventState = this.d.eventState.get(taskId);
    if (!eventState) return;

    eventState.lastProgressUpdate = Date.now();
    eventState.hasProducedOutput = true;
    eventState.lastEventAt = Date.now();
    this.d.watchdog.resetWatchdog(taskId);
    this.d.watchdog.cancelDebounce(taskId);

    debugLog("event", taskId, "message.updated — progress heartbeat, cancelled debounce");
  }

  async handleSessionError(sessionId: string, error: unknown): Promise<void> {
    const taskId = this.d.sessionToTask.get(sessionId);
    if (!taskId) return;
    const errorMsg = extractSessionErrorMessage(error);
    debugLog("event", taskId, `session.error (${errorMsg}) — routing to evaluateAndComplete`);
    await this.evaluateAndComplete(taskId, "error-event", errorMsg);
  }

  async handleSessionDeleted(sessionId: string): Promise<void> {
    this.resetRequestSessions(sessionId);
    const taskId = this.d.sessionToTask.get(sessionId);
    if (!taskId) return;
    debugLog("event", taskId, `session.deleted — routing to evaluateAndComplete`);
    await this.evaluateAndComplete(taskId, "deleted-event");
  }

  // ── Completion helpers ────────────────────────────────────────

  private handleTaskCompleted(taskId: string): void {
    if (!this.transition(taskId, ["pending", "running"], "completed")) return;
    const t = this.d.tasks.get(taskId)!;
    const duration = Date.now() - t.startedAt.getTime();
    infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
    metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
    metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
    this.leaveRunning(taskId);
    void this.materializeAndNotify(taskId);
  }

  private handleTaskError(taskId: string, error: string): void {
    if (!this.transition(taskId, ["pending", "running"], "error", { error })) return;
    const t = this.d.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `✗ error agent=${t.agent}: ${error}`);
    metrics.counter("dispatch_error_total", { agent: t.agent }).inc();
    void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
    this.leaveRunning(taskId);
  }

  private handleTaskTimeout(taskId: string, reason: string): void {
    if (!this.transition(taskId, ["pending", "running"], "timeout", { error: reason })) return;
    const t = this.d.tasks.get(taskId)!;
    infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: ${reason}`);
    metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
    void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
    this.leaveRunning(taskId);
  }

  private finalizeCompletion(taskId: string): void {
    const t = this.d.tasks.get(taskId)!;
    const duration = Date.now() - t.startedAt.getTime();
    const status = t.status === "error" ? "error" : "completed";
    infoLog("lifecycle", taskId, `${status === "error" ? "✗ error" : "✓ completed"} agent=${t.agent} duration=${duration}ms`);
    if (status === "error") {
      metrics.counter("dispatch_error_total", { agent: t.agent }).inc();
    } else {
      metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
    }
    metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
    void this.notifyCompletion(t, this.getInflightCount(t.parentSessionId));
    this.leaveRunning(taskId);
  }

  private async materializeAndNotify(taskId: string): Promise<void> {
    const t = this.d.tasks.get(taskId);
    if (!t || t.status !== "completed") return;

    const ref = await this.materializeResult(taskId);
    t.result = ref;
    this.scheduleSidecarGC(taskId);
    this.d.persistState();

    let resultText: string | undefined;
    if (ref.sidecarPath && !ref.fetchError) {
      const sidecarText = readResultSidecar(ref.sidecarPath);
      if (sidecarText !== null) {
        resultText = extractResultBlock(sidecarText).result;
      }
    }

    this.d.addToOutbox(taskId);
    await this.notifyCompletion(t, this.getInflightCount(t.parentSessionId), resultText);
  }
}

/** Re-exported from manager.ts for use in event handlers. */
function extractSessionErrorMessage(error: unknown): string {
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

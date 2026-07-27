import type { DispatchInput, DispatchTask } from "../types.ts";
import type { TaskLifecycleDeps } from "./lifecycle-shared.ts";
import {
  deriveKey,
  computeDepth,
  getRequestSessions,
  incRequestSessions,
  transition,
  getInflightCount,
  scheduleCleanup,
  notifyCompletion,
  notifyTerminated,
  leaveRunning,
  addToParentIndex,
} from "./lifecycle-shared.ts";
import { infoLog, debugLog } from "./debug-log.ts";
import { metrics } from "../persistence/metrics.ts";
import { notifyParent } from "../notification.ts";
import { withTimeout } from "./with-timeout.ts";
import { MATERIALIZE_TIMEOUT_MS } from "../config.ts";
import {
  SessionCreateRejectedError,
  isSessionCreateRejected,
  type SessionInfo,
} from "../../platform/types.ts";

/**
 * Launch a background dispatch task.
 * Handles budget checks, concurrency acquisition, queuing, and backpressure retry.
 */
export async function launch(
  d: TaskLifecycleDeps,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string },
): Promise<DispatchTask> {
  const taskId = `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const concurrencyKey = deriveKey(d, input.subagent);

  const budget = d.config.maxTotalSessionsPerRequest;
  const root = parentContext.sessionID;
  if (budget !== undefined && getRequestSessions(d, root) >= budget) {
    metrics.counter("dispatch_rejected_total", { reason: "budget-exhausted" }).inc();
    const task: DispatchTask = {
      id: taskId,
      sessionId: "",
      parentSessionId: parentContext.sessionID,
      parentAgent: parentContext.agent,
      depth: computeDepth(d, parentContext.sessionID),
      status: "error",
      agent: input.subagent,
      prompt: input.prompt,
      description: input.description,
      startedAt: new Date(),
      completedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      timeoutMs: input.timeout_ms,
      priority: input.priority ?? 0,
      error: JSON.stringify({
        error: "Session budget exhausted",
        limit: budget,
        spawned: getRequestSessions(d, root),
      }),
    };
    d.tasks.set(taskId, task);
    addToParentIndex(d.parentTasksIndex, task.parentSessionId, taskId);
    scheduleCleanup(d, taskId);
    void notifyCompletion(d, task, getInflightCount(d, task.parentSessionId));
    return task;
  }

  const task: DispatchTask = {
    id: taskId,
    sessionId: "",
    parentSessionId: parentContext.sessionID,
    parentAgent: parentContext.agent,
    depth: computeDepth(d, parentContext.sessionID),
    status: "pending",
    agent: input.subagent,
    prompt: input.prompt,
    description: input.description,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    timeoutMs: input.timeout_ms,
    priority: input.priority ?? 0,
  };

  d.tasks.set(taskId, task);
  addToParentIndex(d.parentTasksIndex, task.parentSessionId, taskId);
  incRequestSessions(d, root);

  debugLog("launch", taskId, `agent=${input.subagent} key=${concurrencyKey} bg=${input.run_in_background} desc="${input.description ?? ""}"`);

  const acqResult = d.concurrency.acquireBackground(concurrencyKey, {
    parentId: task.parentSessionId,
    maxActivePerParent: d.config.maxActivePerParent,
  });

  switch (acqResult.outcome) {
    case "full": {
      const maxRetries = d.config.backpressureMaxRetries ?? 0;
      if (maxRetries > 0) {
        task.concurrencyKey = concurrencyKey;
        debugLog("launch", taskId, `QUEUE-FULL — scheduling backpressure retry (0/${maxRetries})`);
        scheduleBackpressureRetry(d, taskId, concurrencyKey, input, parentContext, 0, maxRetries);
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
      scheduleCleanup(d, taskId);
      void notifyCompletion(d, task, getInflightCount(d, task.parentSessionId));
      return task;
    }

    case "acquired": {
      task.concurrencyKey = concurrencyKey;
      await startBackgroundTask(d, taskId, input, parentContext);
      return task;
    }

    case "queued": {
      task.concurrencyKey = concurrencyKey;
      d.cancelQueue.set(taskId, acqResult.cancel);
      debugLog("launch", taskId, `QUEUED — returning pending task immediately`);
      void acqResult.promise.then(() => promoteQueued(d, taskId, input, parentContext));
      return task;
    }
  }
}

/**
 * Start a background task by creating a session and sending the prompt.
 * Marks the task as "running" on success.
 */
export async function startBackgroundTask(
  d: TaskLifecycleDeps,
  taskId: string,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string },
): Promise<void> {
  const task = d.tasks.get(taskId);
  if (!task) return;

  let didMarkRunning = false;

  try {
    // Bounded retry around session creation for TRANSIENT failures only.
    // Classification (mirrors OpencodeSessionAdapter.create, session.ts:236-270):
    //   - SessionCreateRejectedError (tagged) → server-side rejection (r.error)
    //     → REAL error, never retried; reason surfaced verbatim.
    //   - THROWN plain error → transient transport/network failure → retry with
    //     backoff, then surface the underlying error after exhaustion.
    //   - null RETURN → rejection with no reason available → never retried
    //     (reported as "empty response").
    // The happy path below is a single `await d.client.create(...)` — identical
    // await/microtask count to a bare call, so concurrency-timing behavior is
    // unchanged. Retries only add awaits when a throw actually occurs.
    const createOptions = () => ({
      directory: parentContext.directory,
      agent: input.subagent,
      ...(input.noParentInherit ? {} : { parentID: parentContext.sessionID }),
    });
    const totalAttempts = d.config.createRetryAttempts ?? 3;
    const backoffMs = d.config.createRetryBackoffMs ?? 250;

    let session: SessionInfo | null = null;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        session = await d.client.create(createOptions());
      } catch (err) {
        // A SessionCreateRejectedError is a SERVER REJECTION (real,
        // non-transient) — surface it immediately, never retried. This mirrors
        // the pre-subtask-4 null-return semantics: a rejection was never
        // retried. Any OTHER thrown error is a transient transport failure →
        // retry, preserving the underlying error. After retries are exhausted
        // the underlying error is re-thrown — never silently swallowed.
        if (isSessionCreateRejected(err)) throw err;
        if (attempt < totalAttempts) {
          debugLog("launch", taskId, `session.create threw (transient) attempt=${attempt}/${totalAttempts} — retrying: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        debugLog("launch", taskId, `session.create exhausted after ${totalAttempts} attempts`);
        throw err;
      }
      // Reached only when create() returned (did not throw).
      break;
    }

    // A bare null return is a rejection with no server reason available (some
    // platforms / stubs return null with no error detail). Treat it as a tagged
    // rejection so the classification stays uniform: never retried. When the
    // adapter surfaced a real reason it already threw a
    // SessionCreateRejectedError above, which re-threw past this point.
    if (!session) throw new SessionCreateRejectedError("Failed to create session: empty response");

    task.sessionId = session.id;
    d.sessionToTask.set(session.id, taskId);
    d.eventState.set(taskId, {
      lastMessageCount: 0,
      lastProgressUpdate: Date.now(),
      hasProducedOutput: false,
      messageCountAtStart: 0,
      lastEventAt: Date.now(),
      consecutiveFetchFailures: 0,
    });
    task.status = "running";
    // Track inflight counter (mirrors transition() entering-running logic for direct status assignment)
    {
      const pid = task.parentSessionId;
      d.inflightByParent.set(pid, (d.inflightByParent.get(pid) ?? 0) + 1);
      const startedAt = task.startedAt.getTime();
      const currOldest = d.oldestStartedAtByParent.get(pid);
      if (currOldest === undefined || startedAt < currOldest) {
        d.oldestStartedAtByParent.set(pid, startedAt);
      }
    }
    didMarkRunning = true;
    infoLog("launch", taskId, `running agent=${input.subagent}`);
    metrics.counter("dispatch_total", { agent: input.subagent, mode: "background" }).inc();
    metrics.gauge("inflight_tasks").inc();
    task.progress.lastUpdate = new Date();
    d.persistState();

    debugLog("launch", taskId, `session created: ${session.id}`);

    if (input.run_in_background) {
      const promptResult = await d.client.prompt(session.id, {
        agent: input.subagent,
        parts: [{ type: "text", text: input.prompt }],
      });

      if (!promptResult) {
        // Spawn failed — sub-agent process never started
        task.status = "error";
        task.error = "Failed to spawn Pi process for sub-agent";
        task.completedAt = new Date();
        debugLog("launch", taskId, `SPAWN-FAILED: prompt returned null for agent=${input.subagent}`);
        // Decrement inflight counter — status changed directly, not via transition()
        {
          const pid = task.parentSessionId;
          const curr = d.inflightByParent.get(pid);
          if (curr !== undefined) {
            if (curr <= 1) {
              d.inflightByParent.delete(pid);
              d.oldestStartedAtByParent.delete(pid);
            } else {
              d.inflightByParent.set(pid, curr - 1);
            }
          }
        }
        d.sessionToTask.delete(task.sessionId);
        leaveRunning(d, taskId);
        notifyTerminated(d, taskId, "error");
        try { await d.client.abort(task.sessionId); } catch { /* session may already be gone */ }
        void notifyParent(d.client, task, 0, { maxRetries: 0 });
        return;
      }

      debugLog("launch", taskId, "promptAsync sent — registering with watchdog");
      d.watchdog.registerTask(taskId);
    }
  } catch (err) {
    task.status = "error";
    task.error = err instanceof Error ? err.message : String(err);
    debugLog("launch", taskId, `ERROR: ${task.error}`);
    if (didMarkRunning) {
      // Decrement inflight counter — status changed directly, not via transition()
      {
        const pid = task.parentSessionId;
        const curr = d.inflightByParent.get(pid);
        if (curr !== undefined) {
          if (curr <= 1) {
            d.inflightByParent.delete(pid);
            d.oldestStartedAtByParent.delete(pid);
          } else {
            d.inflightByParent.set(pid, curr - 1);
          }
        }
      }
      d.sessionToTask.delete(task.sessionId);
      task.completedAt = new Date();
      leaveRunning(d, taskId);
      notifyTerminated(d, taskId, "error");
      try { await d.client.abort(task.sessionId); } catch { /* session may already be gone */ }
      void notifyParent(d.client, task, 0, { maxRetries: 0 });
    } else {
      d.concurrency.release(task.concurrencyKey!, task.parentSessionId);
      scheduleCleanup(d, taskId);
      notifyTerminated(d, taskId, "error");
    }
  }
}

/**
 * Promote a queued task to running once a concurrency slot becomes available.
 */
async function promoteQueued(
  d: TaskLifecycleDeps,
  taskId: string,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string },
): Promise<void> {
  d.cancelQueue.delete(taskId);

  const task = d.tasks.get(taskId);
  if (!task || task.status !== "pending") {
    d.concurrency.release(task?.concurrencyKey ?? deriveKey(d, input.subagent), task?.parentSessionId);
    return;
  }

  await startBackgroundTask(d, taskId, input, parentContext);
}

/**
 * Schedule an exponential-backoff retry for a task that was rejected due to queue fullness.
 */
function scheduleBackpressureRetry(
  d: TaskLifecycleDeps,
  taskId: string,
  concurrencyKey: string,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string },
  attempt: number,
  maxRetries: number,
): void {
  const task = d.tasks.get(taskId);
  if (!task || task.status !== "pending") return;

  const retryAfterMs = d.config.retryAfterMs;
  const maxDelayMs = d.config.backpressureMaxDelayMs ?? 60000;
  const delay = Math.min(retryAfterMs * Math.pow(2, attempt), maxDelayMs);
  metrics.counter("dispatch_backpressure_retry_total", { key: concurrencyKey }).inc();

  debugLog("launch", taskId, `backpressure retry attempt=${attempt + 1}/${maxRetries} delay=${delay}ms`);

  const timer = setTimeout(() => {
    d.cancelQueue.delete(taskId);
    const currentTask = d.tasks.get(taskId);
    if (!currentTask || currentTask.status !== "pending") return;

  const acqResult = d.concurrency.acquireBackground(concurrencyKey, {
    parentId: task.parentSessionId,
    maxActivePerParent: d.config.maxActivePerParent,
    priority: task.priority,
  });

    if (acqResult.outcome === "acquired") {
      debugLog("launch", taskId, `backpressure retry ${attempt + 1}: acquired`);
      void startBackgroundTask(d, taskId, input, parentContext);
      return;
    }

    if (acqResult.outcome === "queued") {
      debugLog("launch", taskId, `backpressure retry ${attempt + 1}: queued`);
      d.cancelQueue.set(taskId, acqResult.cancel);
      void acqResult.promise.then(() => promoteQueued(d, taskId, input, parentContext));
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
      scheduleCleanup(d, taskId);
      void notifyCompletion(d, task, getInflightCount(d, task.parentSessionId));
      return;
    }

    scheduleBackpressureRetry(d, taskId, concurrencyKey, input, parentContext, attempt + 1, maxRetries);
  }, delay);

  d.cancelQueue.set(taskId, () => clearTimeout(timer));
}

/**
 * Reopen a completed/errored task for continuation with a new prompt.
 * The task is returned to "running" status on the same session.
 */
export async function reopenForContinuation(
  d: TaskLifecycleDeps,
  taskId: string,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string },
): Promise<DispatchTask> {
  if (d.cleanedUpTasks.has(taskId)) throw new Error(`Task '${taskId}' was cleaned up`);
  const task = d.tasks.get(taskId);
  if (!task) throw new Error(`Task '${taskId}' not found`);
  if (task.agent !== input.subagent) throw new Error(`Task '${taskId}' agent mismatch: expected ${task.agent}, got ${input.subagent}`);

  const concurrencyKey = deriveKey(d, input.subagent);
  const acqResult = d.concurrency.acquireBackground(concurrencyKey, {
    parentId: task.parentSessionId,
    maxActivePerParent: d.config.maxActivePerParent,
    priority: task.priority,
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
    scheduleCleanup(d, taskId);
    void notifyCompletion(d, task, getInflightCount(d, task.parentSessionId));
    return task;
  }

  const msgs = await withTimeout(
    d.client.messages(task.sessionId),
    d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
    "reopen:session.messages",
  );
  const messageCountAtStart = (msgs ?? []).length;

  transition(d, taskId, ["completed", "error", "timeout", "running"], "running", { completedAt: undefined });
  task.startedAt = new Date();
  task.progress = { lastUpdate: new Date(), toolCalls: 0 };
  task.error = undefined;
  task.messageCountAtStart = messageCountAtStart;
  if (input.timeout_ms !== undefined) {
    task.timeoutMs = input.timeout_ms;
  }
  task.concurrencyKey = concurrencyKey;

  debugLog("reopen", taskId, `continuing ${task.agent} on session ${task.sessionId} (msgCount=${messageCountAtStart})`);

  await d.client.prompt(task.sessionId, {
    agent: input.subagent,
    parts: [{ type: "text", text: input.prompt }],
  });

  d.watchdog.cancelDebounce(taskId);
  d.watchdog.unregisterTask(taskId);
  d.watchdog.registerTask(taskId);

  const es = d.eventState.get(taskId) ?? {
    lastMessageCount: 0,
    lastProgressUpdate: Date.now(),
    hasProducedOutput: false,
    messageCountAtStart: 0,
    lastEventAt: Date.now(),
    consecutiveFetchFailures: 0,
  };
  es.messageCountAtStart = messageCountAtStart;
  es.lastProgressUpdate = Date.now();
  es.hasProducedOutput = false;
  es.lastEventAt = Date.now();
  d.eventState.set(taskId, es);

  d.sessionToTask.set(task.sessionId, taskId);
  metrics.gauge("inflight_tasks").inc();
  d.persistState();

  return task;
}

import type { DispatchInput, DispatchTask } from "./types.ts";
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
  leaveRunning,
} from "./lifecycle-shared.ts";
import { infoLog, debugLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";
import { notifyParent } from "./notification.ts";
import { withTimeout } from "./with-timeout.ts";
import { MATERIALIZE_TIMEOUT_MS } from "./config.ts";

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
      error: JSON.stringify({
        error: "Session budget exhausted",
        limit: budget,
        spawned: getRequestSessions(d, root),
      }),
    };
    d.tasks.set(taskId, task);
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
  };

  d.tasks.set(taskId, task);
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
    const createResult = await d.client.session.create({
      body: input.noParentInherit ? {} : { parentID: parentContext.sessionID },
      query: { directory: parentContext.directory },
    });

    const session = createResult.data;
    if (!session) throw new Error("Failed to create session: empty response");

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
    didMarkRunning = true;
    infoLog("launch", taskId, `running agent=${input.subagent}`);
    metrics.counter("dispatch_total", { agent: input.subagent, mode: "background" }).inc();
    metrics.gauge("inflight_tasks").inc();
    task.progress.lastUpdate = new Date();
    d.persistState();

    debugLog("launch", taskId, `session created: ${session.id}`);

    if (input.run_in_background) {
      await d.client.session.promptAsync({
        path: { id: session.id },
        body: {
          agent: input.subagent,
          parts: [{ type: "text", text: input.prompt }],
        },
      });

      debugLog("launch", taskId, "promptAsync sent — registering with watchdog");
      d.watchdog.registerTask(taskId);
    }
  } catch (err) {
    task.status = "error";
    task.error = err instanceof Error ? err.message : String(err);
    debugLog("launch", taskId, `ERROR: ${task.error}`);
    if (didMarkRunning) {
      d.sessionToTask.delete(task.sessionId);
      task.completedAt = new Date();
      leaveRunning(d, taskId);
      void notifyParent(d.client, task, 0, { maxRetries: 0 });
    } else {
      d.concurrency.release(task.concurrencyKey!, task.parentSessionId);
      scheduleCleanup(d, taskId);
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

  const msgResult = await withTimeout(
    d.client.session.messages({ path: { id: task.sessionId } }),
    d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
    "reopen:session.messages",
  );
  const messageCountAtStart = (msgResult.data ?? []).length;

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

  await d.client.session.promptAsync({
    path: { id: task.sessionId },
    body: {
      agent: input.subagent,
      parts: [{ type: "text", text: input.prompt }],
    },
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

import type { DispatchInput, DispatchTask } from "../types.ts";
import type { TaskLifecycleDeps } from "./lifecycle-shared.ts";
import {
  computeDepth,
  transition,
  scheduleCleanup,
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
 */
export async function launch(
  d: TaskLifecycleDeps,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string; graphScoped?: boolean },
): Promise<DispatchTask> {
  const taskId = `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  // Graph-scope marker: set by the graph engine via graphParentContext and/or
  // DispatchInput.graphScoped (executeNode sets both). Carried onto the task so
  // the notification choke points can suppress parent reminders for
  // graph-scoped tasks (graph-notify.ts reports node completion instead).
  const graphScoped = parentContext.graphScoped ?? input.graphScoped;

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
    graphScoped,
  };

  d.tasks.set(taskId, task);
  addToParentIndex(d.parentTasksIndex, task.parentSessionId, taskId);

  debugLog("launch", taskId, `agent=${input.subagent} bg=${input.run_in_background} desc="${input.description ?? ""}"`);

  await startBackgroundTask(d, taskId, input, parentContext);
  return task;
}

/**
 * Start a background task by creating a session and sending the prompt.
 * Marks the task as "running" on success.
 */
export async function startBackgroundTask(
  d: TaskLifecycleDeps,
  taskId: string,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string; graphScoped?: boolean },
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
        // Graph-scope suppression: node completion is reported exclusively by
        // the graph notifier — never emit a dispatch-layer parent reminder for
        // a graph-scoped task, even on spawn failure.
        if (!task.graphScoped) {
          void notifyParent(d.client, task, 0, { maxRetries: 0 });
        }
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
      // Graph-scope suppression: node completion is reported exclusively by
      // the graph notifier — never emit a dispatch-layer parent reminder for
      // a graph-scoped task, even on session-create failure.
      if (!task.graphScoped) {
        void notifyParent(d.client, task, 0, { maxRetries: 0 });
      }
    } else {
      scheduleCleanup(d, taskId);
      notifyTerminated(d, taskId, "error");
    }
  }
}

/**
 * Reopen a completed/errored task for continuation with a new prompt.
 * The task is returned to "running" status on the same session.
 */
export async function reopenForContinuation(
  d: TaskLifecycleDeps,
  taskId: string,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string; graphScoped?: boolean },
): Promise<DispatchTask> {
  if (d.cleanedUpTasks.has(taskId)) throw new Error(`Task '${taskId}' was cleaned up`);
  const task = d.tasks.get(taskId);
  if (!task) throw new Error(`Task '${taskId}' not found`);
  if (task.agent !== input.subagent) throw new Error(`Task '${taskId}' agent mismatch: expected ${task.agent}, got ${input.subagent}`);

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

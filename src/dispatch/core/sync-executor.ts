import type { DispatchInput } from "../types.ts";
import type { TaskLifecycleDeps } from "./lifecycle-shared.ts";
import {
  deriveKey,
  computeDepth,
  getRequestSessions,
  incRequestSessions,
  addToParentIndex,
  removeFromParentIndex,
} from "./lifecycle-shared.ts";
import { debugLog } from "./debug-log.ts";
import { metrics } from "../persistence/metrics.ts";
import { withTimeout, TimeoutError } from "./with-timeout.ts";
import {
  SYNC_TIMEOUT_MS,
  DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS,
  MATERIALIZE_TIMEOUT_MS,
} from "../config.ts";

/**
 * Execute a dispatch synchronously (blocking the caller).
 * Only allowed at depth===0 (direct dispatch from the caller session).
 * Handles session creation/continuation, concurrency acquisition, prompt timeout.
 */
export async function executeSync(
  d: TaskLifecycleDeps,
  input: DispatchInput,
  parentContext: { sessionID: string; agent: string; directory: string },
): Promise<string> {
  const acquireTimeoutMs = d.config.syncAcquireTimeoutMs ?? DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS;
  const promptTimeoutMs = input.sync_timeout_ms
    ?? d.config.syncPromptTimeoutMs
    ?? d.config.syncTimeoutMs
    ?? SYNC_TIMEOUT_MS;
  const concurrencyKey = deriveKey(d, input.subagent);

  const callerDepth = computeDepth(d, parentContext.sessionID);
  if (callerDepth > 0) {
    throw new Error(JSON.stringify({
      error: "Synchronous dispatch forbidden at depth>0",
      depth: callerDepth,
    }));
  }

  const budget = d.config.maxTotalSessionsPerRequest;
  const root = parentContext.sessionID;
  const isNewSession = !input.session_id;

  let existingSessionId: string | undefined;
  if (input.session_id) {
    const prevTask = d.tasks.get(input.session_id);
    if (prevTask && prevTask.sessionId) {
      existingSessionId = prevTask.sessionId;
    } else if (d.completedSyncSessions.has(input.session_id)) {
      existingSessionId = d.completedSyncSessions.get(input.session_id)!;
    } else {
      throw new Error(JSON.stringify({
        error: `Session continuation: task '${input.session_id}' not found or has no session`,
        phase: "continuation",
      }));
    }
  }

  if (isNewSession && budget !== undefined && getRequestSessions(d, root) >= budget) {
    metrics.counter("dispatch_rejected_total", { reason: "budget-exhausted" }).inc();
    throw new Error(JSON.stringify({
      error: "Session budget exhausted",
      limit: budget,
      spawned: getRequestSessions(d, root),
    }));
  }

  const taskId = `sync_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const task: import("../types.ts").DispatchTask = {
    id: taskId,
    sessionId: existingSessionId ?? "",
    parentSessionId: parentContext.sessionID,
    parentAgent: parentContext.agent,
    depth: computeDepth(d, parentContext.sessionID),
    status: "pending",
    agent: input.subagent,
    prompt: input.prompt,
    description: input.description,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    mode: "sync",
    continuationOf: existingSessionId ? input.session_id : undefined,
    priority: 0,
  };
  d.tasks.set(taskId, task);
  addToParentIndex(d.parentTasksIndex, task.parentSessionId, taskId);

  let didAcquire = false;
  const startTime = Date.now();

  try {
    const { promise: acq, cancel: cancelAcq } = d.concurrency.acquireSync(concurrencyKey);
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
      d.sessionToTask.set(existingSessionId, taskId);
      debugLog("launch", taskId, `continuing session ${existingSessionId}`);
    } else {
      const createTimeoutMs = d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS;
      let session: Awaited<ReturnType<typeof d.client.create>>;
      try {
        session = await withTimeout(
          d.client.create({
            directory: parentContext.directory,
            parentID: parentContext.sessionID,
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
      if (!session) {
        const err = JSON.stringify({
          error: "Failed to create session: empty response",
          phase: "session",
          timeout_ms: promptTimeoutMs,
        });
        throw new Error(err);
      }

      task.sessionId = session.id;
      d.sessionToTask.set(session.id, taskId);
      d.completedSyncSessions.set(taskId, session.id);
      if (isNewSession) incRequestSessions(d, root);
    }

    const controller = new AbortController();
    d.syncControllers.set(taskId, controller);
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    const promptTimeout = new Promise<never>((_, rej) => {
      promptTimer = setTimeout(() => {
        controller.abort();
        void d.client.abort(task.sessionId);
        const err = JSON.stringify({
          error: `Prompt timed out after ${promptTimeoutMs}ms`,
          phase: "prompt",
          timeout_ms: promptTimeoutMs,
        });
        rej(new Error(err));
      }, promptTimeoutMs);
    });

    try {
      const promptResult =
        await Promise.race([
          d.client.promptSync(task.sessionId, {
            agent: input.subagent,
            parts: [{ type: "text", text: input.prompt }],
            signal: controller.signal,
          }),
          promptTimeout,
        ]);

      clearTimeout(promptTimer);

      const text = promptResult
        ? promptResult.parts
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
    d.syncControllers.delete(taskId);
    d.sessionToTask.delete(task.sessionId);
    removeFromParentIndex(d.parentTasksIndex, task.parentSessionId, taskId);
    d.tasks.delete(taskId);
    if (didAcquire) {
      d.concurrency.release(concurrencyKey, parentContext.sessionID);
    }
  }
}

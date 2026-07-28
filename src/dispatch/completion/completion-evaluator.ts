import type { SessionMessageSnapshot } from "../types.ts";
import type { TaskLifecycleDeps } from "../core/lifecycle-shared.ts";
import {
  transition,
  getInflightCount,
  notifyCompletion,
  leaveRunning,
  notifyTerminated,
  resetRequestSessions,
} from "../core/lifecycle-shared.ts";
import { detectCompletion } from "./completion-detector.ts";
import { extractSessionErrorMessage } from "../core/error-utils.ts";
import { infoLog, debugLog } from "../core/debug-log.ts";
import { metrics } from "../persistence/metrics.ts";
import {
  BACKGROUND_STALE_TIMEOUT_MS,
  MATERIALIZE_TIMEOUT_MS,
  MAX_CONSECUTIVE_FETCH_FAILURES,
} from "../config.ts";
import { withTimeout, TimeoutError } from "../core/with-timeout.ts";
import { materializeAndNotify } from "./result-materializer.ts";
import type { ProgressEvent } from "../types.progress.ts";
import { buildReminder } from "../../prompt/reminder.ts";
import { sessionSignalLedger } from "../../signal/session-signal-ledger.ts";
import { SYNTHETIC_ANSWER_SIGNAL } from "../../signal/signal-constants.ts";

// ── Signal-type classification ──────────────────────────────────────

/**
 * Check whether the subagent session associated with this task emitted any
 * HITL (human-in-the-loop) signals (need_approval, blocked, need_clarification).
 *
 * When a HITL signal is found, the task transitions to "awaiting_approval"
 * instead of "completed", and the parent session is notified with the signal
 * details so a human can approve or reject via approve_task / reject_task.
 *
 * @returns true if a HITL signal was handled (task is now awaiting_approval).
 */
async function checkHitlSignals(d: TaskLifecycleDeps, taskId: string): Promise<boolean> {
  const task = d.tasks.get(taskId);
  if (!task || !task.sessionId) return false;

  const hitlInfo = sessionSignalLedger.getHitlSignal(task.sessionId);
  if (!hitlInfo) return false;

  const hitlType = hitlInfo.type;
  const hitlPayload = hitlInfo.payload;

  // Transition to awaiting_approval instead of completed
  if (!transition(d, taskId, ["running"], "awaiting_approval")) return false;

  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);

  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `⏸ awaiting_approval agent=${t.agent} type=${hitlType}`);

  metrics.counter("dispatch_hitl_paused_total", { type: hitlType }).inc();

  // Release concurrency slot
  if (t.concurrencyKey) {
    d.concurrency.release(t.concurrencyKey, t.parentSessionId);
  }
  metrics.gauge("inflight_tasks").dec();
  d.persistState();

  // Send <system-reminder> to parent with approval details
  const notifyText = buildReminder({
    marker: "[HITL APPROVAL REQUIRED]",
    fields: [
      { label: "task", value: taskId },
      ...(t.description ? [{ label: "desc", value: t.description }] : []),
      { label: "agent", value: t.agent },
      { label: "signal", value: hitlType },
      { label: "payload", value: JSON.stringify(hitlPayload) },
    ],
    action: [
      `Use \`approve_task(task_id="${taskId}")\` to approve and continue.`,
      `Use \`reject_task(task_id="${taskId}", reason="...")\` to reject.`,
    ].join("\n"),
  });

  try {
    await d.client.prompt(t.parentSessionId, {
      ...(t.parentAgent ? { agent: t.parentAgent } : {}),
      parts: [{ type: "text", text: notifyText }],
      noReply: false,
    });
  } catch {
    // Non-critical — parent may be offline
  }

  // Do NOT schedule cleanup — the task remains in awaiting_approval state
  // for the parent to approve or reject.

  notifyTerminated(d, taskId, hitlType);
  return true;
}

/**
 * Read the last terminating signal emitted by the sub-agent session
 * associated with a task from the function runtime signal ledger.
 *
 * When the sub-agent called `signal(type="revise_needed")` (or `escalate`,
 * `answer`) before its session completed, that signal type and payload are
 * recorded in the session's function runtime state. This function reads the
 * highest-severity terminating signal so the completion evaluator can pass
 * it through to the graph engine instead of hardcoding "completed → answer".
 *
 * Severity order: escalate > revise_needed > answer.
 *
 * @returns The terminating signal info, or `null` when no terminating signal
 *          was recorded (normal completion → defaults to answer downstream).
 */
function getTerminatingSignal(
  taskId: string,
  sessionId: string,
): { type: string; payload: unknown } | null {
  return sessionSignalLedger.getTerminating(sessionId);
}

// ── Helpers for common transition patterns ─────────────────────

/** Build a synthetic "completed" progress event and emit it. */
function emitCompletionEvent(d: TaskLifecycleDeps, taskId: string): void {
  const event: ProgressEvent = {
    task_id: taskId,
    percentage: 100,
    stage: "complete",
    message: "Task completed",
    timestamp: new Date().toISOString(),
  };
  d.progressStore.addProgressEvent(taskId, event);
}

/** Clear progress, milestone thresholds, and checkpoints for a completed task. */
function cleanupTerminalCompleted(d: TaskLifecycleDeps, taskId: string): void {
  emitCompletionEvent(d, taskId);
  d.progressStore.clearProgress(taskId);
  d.clearEmittedThresholds(taskId);
  // Delete checkpoints on success — no retry needed
  d.deleteTaskCheckpoint(taskId).catch(() => {});
}

/** Clear milestone thresholds only (preserve progress + checkpoints for retry). */
function cleanupTerminalError(d: TaskLifecycleDeps, taskId: string): void {
  d.clearEmittedThresholds(taskId);
}

/** Transition task to completed, log metrics, release resources. */
async function completeAndRelease(d: TaskLifecycleDeps, taskId: string): Promise<void> {
  if (!transition(d, taskId, ["running"], "completed")) return;
  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);
  const t = d.tasks.get(taskId)!;
  const duration = Date.now() - t.startedAt.getTime();
  infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
  metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
  metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
  cleanupTerminalCompleted(d, taskId);
  leaveRunning(d, taskId);
  await materializeAndNotify(d, taskId);
  notifyTerminated(d, taskId, "completed");
}
/** Transition task to timeout, log metrics, notify, release. */
function timeoutAndRelease(d: TaskLifecycleDeps, taskId: string, reason: string): void {
  if (!transition(d, taskId, ["running"], "timeout", { error: reason })) return;
  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);
  notifyTerminated(d, taskId, "timeout");
  const t = d.tasks.get(taskId)!;
  // Abort the worker session to prevent leaks (mirrors task-cancellation.ts:83-84)
  if (t.sessionId) {
    d.client.abort(t.sessionId).catch(() => {});
  }
  infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: ${reason}`);
  metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
  cleanupTerminalError(d, taskId);
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
}

/** Transition task to error, log metrics, notify, release. */
function finalizeCompletion(d: TaskLifecycleDeps, taskId: string): void {
  const t = d.tasks.get(taskId)!;
  const duration = Date.now() - t.startedAt.getTime();
  const status = t.status === "error" ? "error" : "completed";
  infoLog("lifecycle", taskId, `${status === "error" ? "✗ error" : "✓ completed"} agent=${t.agent} duration=${duration}ms`);
  if (status === "error") {
    metrics.counter("dispatch_error_total", { agent: t.agent }).inc();
  } else {
    metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
  }
  metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
}

/** Mark error (unregister, cancel debounce, finalize). */
function markError(d: TaskLifecycleDeps, taskId: string, errorMsg: string): void {
  if (!transition(d, taskId, ["running"], "error", { error: errorMsg })) return;
  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);
  notifyTerminated(d, taskId, "error");
  cleanupTerminalError(d, taskId);
  finalizeCompletion(d, taskId);
}

/** Find the earliest start time among inflight children of the given session, or null if none. */
function getOldestInflightChildStartedAt(d: TaskLifecycleDeps, sessionId: string): number | null {
  return d.oldestStartedAtByParent.get(sessionId) ?? null;
}

/**
 * Evaluate a running task and complete/error/timeout it as appropriate.
 * Triggered by idle-debounce, watchdog-reconcile, global-sweep, error-event, or deleted-event.
 */
export async function evaluateAndComplete(
  d: TaskLifecycleDeps,
  taskId: string,
  trigger: "idle-debounce" | "watchdog-reconcile" | "global-sweep" | "error-event" | "deleted-event",
  errorDetail?: string,
): Promise<void> {
  const task = d.tasks.get(taskId);
  if (!task || task.status !== "running") {
    debugLog("evaluate", taskId, `no-op: task ${!task ? "not found" : `status=${task.status}`}`);
    return;
  }

  if (trigger === "error-event") {
    markError(d, taskId, errorDetail ?? "Task error event received");
    return;
  }

  if (trigger === "deleted-event") {
    markError(d, taskId, "Session deleted");
    return;
  }

  try {
    const fetchTimeoutMs = d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS;

    let allMessages: SessionMessageSnapshot[];
    let statusResult: import("../../session/types.ts").SessionStatus | null;
    try {
      const msgs = await withTimeout(d.client.messages(task.sessionId), fetchTimeoutMs, "session.messages");
      allMessages = (msgs ?? []) as SessionMessageSnapshot[];
      statusResult = await withTimeout(d.client.status(task.sessionId), fetchTimeoutMs, "session.status");
    } catch (e) {
      if (e instanceof TimeoutError) {
        handleEvaluateFetchFailure(d, taskId, `fetch timed out after ${fetchTimeoutMs}ms`, fetchTimeoutMs);
        return;
      }
      throw e;
    }

    const sessionStatus = statusResult as { type: string } | null;

    const eventState = d.eventState.get(taskId);
    if (!eventState) return;
    eventState.consecutiveFetchFailures = 0;

    const startIndex = eventState.messageCountAtStart ?? 0;
    const scopedMessages = startIndex > 0 ? allMessages.slice(startIndex) : allMessages;

    if (sessionStatus === null || sessionStatus === undefined) {
      const existence = await d.sessionMonitor.verifyExistence(d.client, task.sessionId);
      if (existence === "missing") {
        if (transition(d, taskId, ["running"], "error", { error: "Session no longer exists" })) {
          d.watchdog.unregisterTask(taskId);
          d.watchdog.cancelDebounce(taskId);
          notifyTerminated(d, taskId, "error");
          const t = d.tasks.get(taskId)!;
          debugLog("evaluate", taskId, `session gone (verifyExistence=missing) — erroring task`);
          void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
          leaveRunning(d, taskId);
        }
        return;
      }
      debugLog("evaluate", taskId, `sessionStatus undefined but verifyExistence=${existence} — treating as idle`);
    }

    const sig = detectCompletion(scopedMessages, sessionStatus ?? undefined, eventState, true);

    switch (sig.type) {
      case "completed": {
        if (trigger === "idle-debounce") {
          const pc = eventState.pendingConfirm;
          if (!pc) {
            eventState.pendingConfirm = { messageCount: scopedMessages.length, at: Date.now() };
            d.watchdog.startDebounce(taskId);
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
        } else {
          // Non-idle-debounce triggers (watchdog-reconcile, global-sweep):
          // if the task has inflight child tasks, it yielded its turn waiting for a
          // background subagent — treat as not_ready instead of completing prematurely.
          const inflight = getInflightCount(d, task.sessionId);
          if (inflight > 0) {
            const oldest = getOldestInflightChildStartedAt(d, task.sessionId);
            const now = Date.now();
            if (oldest !== null) {
              const childElapsed = now - oldest;
              const staleMs = task.timeoutMs ?? d.config.backgroundStaleTimeoutMs ?? BACKGROUND_STALE_TIMEOUT_MS;
              if (childElapsed <= staleMs) {
                eventState.lastProgressUpdate = now;
                debugLog("evaluate", taskId, `completed but ${inflight} inflight child(ren) within stale timeout — treating as not_ready`);
                break;  // treat as not_ready — children are healthy
              }
              // child is stale — fall through to completeAndRelease (natural timeout)
            }
          }
        }
        // Check for HITL signals (need_approval, blocked, need_clarification)
        // before completing. If found, the task pauses instead of completing.
        if (await checkHitlSignals(d, taskId)) break;
        // Record the real terminating signal (if any) from the function runtime
        // state before completing, so the graph engine emits the correct signal
        // type (e.g. revise_needed) instead of unconditionally mapping
        // completed → answer. When the sub-agent never called signal(), we
        // populate a synthetic answer on its behalf.
        task.terminatingSignal = getTerminatingSignal(taskId, task.sessionId) ?? SYNTHETIC_ANSWER_SIGNAL;
        await completeAndRelease(d, taskId);
        break;
      }
      case "error": {
        markError(d, taskId, sig.message);
        break;
      }
      case "not_ready": {
        const now = Date.now();
        const elapsed = now - task.startedAt.getTime();
        const staleMs = task.timeoutMs ?? d.config.backgroundStaleTimeoutMs ?? BACKGROUND_STALE_TIMEOUT_MS;
        if (!eventState.hasProducedOutput && elapsed > staleMs) {
          timeoutAndRelease(d, taskId, "Never produced output");
        } else if (eventState.hasProducedOutput && now - eventState.lastProgressUpdate > staleMs) {
          timeoutAndRelease(d, taskId, "Task stalled");
        } else {
          const inflight = getInflightCount(d, task.sessionId);
          if (inflight > 0) {
            const oldest = getOldestInflightChildStartedAt(d, task.sessionId);
            if (oldest !== null) {
              const childElapsed = now - oldest;
              if (childElapsed <= staleMs) {
                eventState.lastProgressUpdate = now;
                debugLog("evaluate", taskId, `not_ready — ${inflight} inflight child(ren) within stale timeout, reset lastProgressUpdate`);
                break;
              }
              debugLog("evaluate", taskId, `not_ready — oldest inflight child exceeded stale timeout (${childElapsed}ms > ${staleMs}ms), allowing parent timeout`);
            }
          }
          debugLog("evaluate", taskId, `not_ready — no stale timeout`);
        }
        break;
      }
      case "stabilizing": {
        debugLog("evaluate", taskId, `stabilizing with skipStabilityGating=true — treating as completed`);
        if (await checkHitlSignals(d, taskId)) break;
        task.terminatingSignal = getTerminatingSignal(taskId, task.sessionId) ?? SYNTHETIC_ANSWER_SIGNAL;
        await completeAndRelease(d, taskId);
        break;
      }
    }
  } catch (err) {
    handleEvaluateFetchFailure(d, taskId, `error fetching: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
}

/**
 * Handle a consecutive fetch failure in evaluateAndComplete.
 * Returns true iff escalation to error status occurred.
 */
function handleEvaluateFetchFailure(d: TaskLifecycleDeps, taskId: string, failureLabel: string, _fetchTimeoutMs: number): boolean {
  const es = d.eventState.get(taskId);
  if (!es) return false;
  es.consecutiveFetchFailures++;
  infoLog("evaluate", taskId, `${failureLabel} (failure #${es.consecutiveFetchFailures})`);
  if (es.consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
    markError(d, taskId, `Cannot verify task liveness — SDK fetch failed ${es.consecutiveFetchFailures} consecutive times`);
    d.persistState();
    return true;
  }
  d.persistState();
  return false;
}

// ── Event handlers ────────────────────────────────────────────

/** Handle session.idle event: validate and start debounce if appropriate. */
export async function handleSessionIdle(d: TaskLifecycleDeps, sessionId: string): Promise<void> {
  const taskId = d.sessionToTask.get(sessionId);
  if (!taskId) return;

  const task = d.tasks.get(taskId);
  if (!task || task.status !== "running") return;

  const elapsed = Date.now() - task.startedAt.getTime();
  if (elapsed < d.config.minRuntimeMs) {
    if (!d.deferredIdleTimers.has(taskId)) {
      const remaining = d.config.minRuntimeMs - elapsed;
      debugLog("event", taskId, `session.idle too early (${elapsed}ms) — deferring by ${remaining}ms`);
      const timer = setTimeout(() => {
        d.deferredIdleTimers.delete(taskId);
        const t = d.tasks.get(taskId);
        if (t && t.status === "running") {
          void handleSessionIdle(d, sessionId);
        }
      }, remaining);
      d.deferredIdleTimers.set(taskId, timer);
    }
    d.watchdog.resetWatchdog(taskId);
    return;
  }

  d.watchdog.resetWatchdog(taskId);

  try {
    const msgs = await withTimeout(
      d.client.messages(sessionId),
      d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
      "handleSessionIdle:session.messages",
    );

    const allMessages = (msgs ?? []) as Array<{
      info: { role: string; finish?: string; error?: unknown };
      parts: Array<{ type: string; state?: string; text?: string }>;
    }>;

    const eventState = d.eventState.get(taskId);
    const startIndex = eventState?.messageCountAtStart ?? 0;
    const messages = allMessages.slice(startIndex);

    let hasAssistantOutput = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.info.role === "assistant") {
        const hasPendingTools = m.parts.some((p) => p.type === "tool" && (p.state === "pending" || p.state === "running"));
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

    if (d.watchdog.isDebouncing(taskId)) {
      debugLog("event", taskId, "already debouncing — ignoring duplicate idle");
      return;
    }

    const inflight = getInflightCount(d, sessionId);
    if (inflight > 0) {
      debugLog("event", taskId, `session.idle but ${inflight} child task(s) inflight — dispatch-and-yield pattern, skipping debounce`);
      return;
    }

    debugLog("event", taskId, "session.idle validated — starting debounce");
    d.watchdog.startDebounce(taskId);
  } catch (err) {
    debugLog("event", taskId, "handleSessionIdle error: " + (err instanceof Error ? err.message : String(err)));
  }
}

/** Handle session.status event — update event state and heartbeat. */
export function handleSessionStatus(d: TaskLifecycleDeps, sessionId: string, statusType: string): void {
  const taskId = d.sessionToTask.get(sessionId);
  if (!taskId) return;
  const task = d.tasks.get(taskId);
  if (!task || task.status !== "running") return;

  const eventState = d.eventState.get(taskId);
  if (!eventState) return;

  eventState.lastEventAt = Date.now();
  d.watchdog.resetWatchdog(taskId);

  if (statusType === "busy" || statusType === "retry") {
    eventState.lastProgressUpdate = Date.now();
    eventState.hasProducedOutput = true;
    d.watchdog.cancelDebounce(taskId);
    debugLog("event", taskId, `session.status=${statusType} — progress heartbeat, cancelled debounce`);
  } else {
    debugLog("event", taskId, `session.status=${statusType} — idle heartbeat (stale clock preserved)`);
  }
}

/** Handle message.updated event — progress heartbeat. */
export function handleMessageUpdated(d: TaskLifecycleDeps, sessionId: string): void {
  const taskId = d.sessionToTask.get(sessionId);
  if (!taskId) return;
  const task = d.tasks.get(taskId);
  if (!task || task.status !== "running") return;

  const eventState = d.eventState.get(taskId);
  if (!eventState) return;

  eventState.lastProgressUpdate = Date.now();
  eventState.hasProducedOutput = true;
  eventState.lastEventAt = Date.now();
  d.watchdog.resetWatchdog(taskId);
  d.watchdog.cancelDebounce(taskId);
  debugLog("event", taskId, "message.updated — progress heartbeat, cancelled debounce");
}

/** Handle session.error event — route to evaluateAndComplete with error-event trigger. */
export async function handleSessionError(d: TaskLifecycleDeps, sessionId: string, error: unknown): Promise<void> {
  const taskId = d.sessionToTask.get(sessionId);
  if (!taskId) return;
  const errorMsg = extractSessionErrorMessage(error);
  debugLog("event", taskId, `session.error (${errorMsg}) — routing to evaluateAndComplete`);
  await evaluateAndComplete(d, taskId, "error-event", errorMsg);
}

/** Handle session.deleted event — route to evaluateAndComplete with deleted-event trigger. */
export async function handleSessionDeleted(d: TaskLifecycleDeps, sessionId: string): Promise<void> {
  resetRequestSessions(d, sessionId);
  const taskId = d.sessionToTask.get(sessionId);
  if (!taskId) return;
  debugLog("event", taskId, `session.deleted — routing to evaluateAndComplete`);
  await evaluateAndComplete(d, taskId, "deleted-event");
}

// ── Completion helpers (externally triggered) ─────────────────

/** Handle an externally-detected task completed signal. */
export async function handleTaskCompleted(d: TaskLifecycleDeps, taskId: string): Promise<void> {
  // Record the real terminating signal (if any) from the function runtime
  // state before completing, so the graph engine emits the correct signal
  // type (e.g. revise_needed) instead of unconditionally mapping
  // completed → answer. Must happen before the transition so it's
  // available when notifyTerminated fires downstream.
  const task = d.tasks.get(taskId);
  if (task && task.sessionId) {
    task.terminatingSignal = getTerminatingSignal(taskId, task.sessionId) ?? SYNTHETIC_ANSWER_SIGNAL;
  }

  if (!transition(d, taskId, ["pending", "running"], "completed")) return;
  const t = d.tasks.get(taskId)!;
  const duration = Date.now() - t.startedAt.getTime();
  infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
  metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
  metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
  cleanupTerminalCompleted(d, taskId);
  leaveRunning(d, taskId);
  await materializeAndNotify(d, taskId);
  notifyTerminated(d, taskId, "completed");
}
/** Handle an externally-detected task error. */
export function handleTaskError(d: TaskLifecycleDeps, taskId: string, error: string): void {
  if (!transition(d, taskId, ["pending", "running"], "error", { error })) return;
  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `✗ error agent=${t.agent}: ${error}`);
  metrics.counter("dispatch_error_total", { agent: t.agent }).inc();
  notifyTerminated(d, taskId, "error");
  cleanupTerminalError(d, taskId);
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
}

/** Handle an externally-detected task timeout. */
export function handleTaskTimeout(d: TaskLifecycleDeps, taskId: string, reason: string): void {
  if (!transition(d, taskId, ["pending", "running"], "timeout", { error: reason })) return;
  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: ${reason}`);
  metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
  notifyTerminated(d, taskId, "timeout");
  cleanupTerminalError(d, taskId);
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
}

import type { SessionMessageSnapshot } from "../types.ts";
import type { TaskLifecycleDeps } from "../core/lifecycle-shared.ts";
import {
  transition,
  getInflightCount,
  notifyCompletion,
  leaveRunning,
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

// ── Helpers for common transition patterns ─────────────────────

/** Transition task to completed, log metrics, release resources. */
function completeAndRelease(d: TaskLifecycleDeps, taskId: string): void {
  if (!transition(d, taskId, ["running"], "completed")) return;
  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);
  const t = d.tasks.get(taskId)!;
  const duration = Date.now() - t.startedAt.getTime();
  infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
  metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
  metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
  leaveRunning(d, taskId);
  void materializeAndNotify(d, taskId);
}

/** Transition task to timeout, log metrics, notify, release. */
function timeoutAndRelease(d: TaskLifecycleDeps, taskId: string, reason: string): void {
  if (!transition(d, taskId, ["running"], "timeout", { error: reason })) return;
  d.watchdog.unregisterTask(taskId);
  d.watchdog.cancelDebounce(taskId);
  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: ${reason}`);
  metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
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
  finalizeCompletion(d, taskId);
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
        }
        completeAndRelease(d, taskId);
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
          debugLog("evaluate", taskId, `not_ready — no stale timeout`);
        }
        break;
      }
      case "stabilizing": {
        debugLog("evaluate", taskId, `stabilizing with skipStabilityGating=true — treating as completed`);
        completeAndRelease(d, taskId);
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
export function handleTaskCompleted(d: TaskLifecycleDeps, taskId: string): void {
  if (!transition(d, taskId, ["pending", "running"], "completed")) return;
  const t = d.tasks.get(taskId)!;
  const duration = Date.now() - t.startedAt.getTime();
  infoLog("lifecycle", taskId, `✓ completed agent=${t.agent} duration=${duration}ms`);
  metrics.counter("dispatch_completed_total", { agent: t.agent }).inc();
  metrics.histogram("task_duration_ms", { agent: t.agent }).observe(duration);
  leaveRunning(d, taskId);
  void materializeAndNotify(d, taskId);
}

/** Handle an externally-detected task error. */
export function handleTaskError(d: TaskLifecycleDeps, taskId: string, error: string): void {
  if (!transition(d, taskId, ["pending", "running"], "error", { error })) return;
  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `✗ error agent=${t.agent}: ${error}`);
  metrics.counter("dispatch_error_total", { agent: t.agent }).inc();
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
}

/** Handle an externally-detected task timeout. */
export function handleTaskTimeout(d: TaskLifecycleDeps, taskId: string, reason: string): void {
  if (!transition(d, taskId, ["pending", "running"], "timeout", { error: reason })) return;
  const t = d.tasks.get(taskId)!;
  infoLog("lifecycle", taskId, `⏱ timeout agent=${t.agent}: ${reason}`);
  metrics.counter("dispatch_timeout_total", { agent: t.agent }).inc();
  void notifyCompletion(d, t, getInflightCount(d, t.parentSessionId));
  leaveRunning(d, taskId);
}

/**
 * Pure-function completion detector for the global poller.
 *
 * Determines whether a dispatched background task session has reached
 * a final state by inspecting the session status and message state.
 *
 * This module has NO side effects and NO SDK calls — it operates
 * exclusively on the structured snapshots provided by the caller.
 *
 * Detection strategy (aligned with oh-my-openagent):
 *   - Primary signal: session status (idle = potentially done, busy/retry = working)
 *   - Secondary signal: has assistant output + no pending tools
 *   - Does NOT rely on specific `finish` field values since different models
 *     use different finish reasons ("end_turn" for Claude, "stop" for OpenAI, etc.)
 */

import type { CompletionSignal, SessionMessageSnapshot, TaskEventState } from "../types.ts";

// ── Public Types ───────────────────────────────────────────────────────

/**
 * Finish reasons that definitively indicate the model is still working
 * and will produce more output (tool execution pending).
 */
export type NonTerminalFinishReason = "tool-calls";

// ── Constants ─────────────────────────────────────────────────────────

/** Session status types that indicate active processing. */
const ACTIVE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "busy",
  "retry",
  "running",
]);

/** Session status types that are terminally done (not idle). */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "interrupted",
]);

// ── Tool In-Flight Helper ─────────────────────────────────────────────

/**
 * Normalize a tool part's state value, supporting both the string form
 * (`state: "pending"`) used by opencode snapshots and the object form
 * (`state: { status: "running" }`) produced by the Pi adapter, so an in-flight
 * tool is never missed across adapters.
 */
function partStateValue(state: string | { status?: string } | undefined): string | undefined {
  if (typeof state === "string") return state;
  return state?.status;
}

/**
 * True if any tool part is in-flight (state `pending` or `running`).
 *
 * The last assistant message carrying an in-flight tool means the model has
 * produced a tool call that is still executing — the session is NOT idle and
 * must not be reported complete (or error-latched) until the tool settles.
 */
export function hasInflightToolPart(
  parts: Array<{ type: string; state?: string | { status?: string } }>,
): boolean {
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const status = partStateValue(part.state);
    if (status === "pending" || status === "running") return true;
  }
  return false;
}

// ── Core Detection ────────────────────────────────────────────────────

/**
 * Evaluate whether a background task session has reached completion.
 *
 * The decision follows a fixed priority order:
 *   1. Tool-execution-in-progress guard — pending/running tool on the last
 *      assistant message → not ready. Evaluated first so a transient error or
 *      a stale idle/terminal status never latches a terminal result while the
 *      model's tool is still running.
 *   2. Session actively processing → not ready
 *   3. Session in terminal status (interrupted) → completed
 *   4. No assistant output → not ready
 *   5. Error detection on last assistant message
 *   6. finish "tool-calls" → not ready
 *   7. Stability gating (MIN_STABILITY_POLLS consecutive idle polls)
 *
 * @param messages  Chronological message snapshots from the sub-agent session
 * @param sessionStatus  Current session status (type field: "idle", "busy", "retry", etc.)
 * @param pollState  Per-task polling metadata (stable idle count, etc.)
 * @returns A structured completion signal
 */
export function detectCompletion(
  messages: SessionMessageSnapshot[],
  sessionStatus: { type: string } | undefined,
  pollState: TaskEventState,
  skipStabilityGating?: boolean,
): CompletionSignal {
  // Find the LAST assistant message (reverse scan). Needed by the
  // tool-in-flight guard, error detection, and finish-reason checks.
  let lastAssistant: SessionMessageSnapshot | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "assistant") {
      lastAssistant = messages[i];
      break;
    }
  }

  // Tool-execution-in-progress guard — evaluated BEFORE the idle/error/
  // completed decisions so a transient error or a stale idle/terminal status
  // never latches a terminal result while the model's tool is still running.
  if (lastAssistant && hasInflightToolPart(lastAssistant.parts)) {
    return { type: "not_ready" };
  }

  // Status-based gating applies ONLY when a status is present. An absent
  // status (undefined) means the session is missing from the directory-scoped
  // `session.status()` map — NOT that it is gone — so it is treated as
  // idle-equivalent and falls through to the message checks below. The caller
  // distinguishes truly-gone sessions via SessionMonitor.verifyExistence().
  if (sessionStatus) {
    if (ACTIVE_SESSION_STATUSES.has(sessionStatus.type)) {
      return { type: "not_ready" };
    }
    if (TERMINAL_SESSION_STATUSES.has(sessionStatus.type)) {
      return { type: "completed" };
    }
  }

  // No assistant message found — hasn't started generating
  if (!lastAssistant) {
    return { type: "not_ready" };
  }

  // Error on the last assistant message
  if (lastAssistant.info.error) {
    return { type: "error", message: extractAssistantError(lastAssistant.info.error) };
  }

  // If finish is explicitly "tool-calls", model expects tool execution → not ready
  if (lastAssistant.info.finish === "tool-calls") {
    return { type: "not_ready" };
  }

  // Session is idle, has assistant output, no pending tools.
  // Apply stability gating to avoid premature completion detection.
  // When skipStabilityGating=true (event-driven evaluation), bypass stability.
  if (!skipStabilityGating) {
    return { type: "stabilizing" };
  }

  // All gates passed → task is complete
  return { type: "completed" };
}

// ── Error Extraction Helper ───────────────────────────────────────────

/**
 * Normalize an opaque error value into a human-readable message string.
 *
 * Handles the common shapes returned by the SDK's error types
 * (strings, Error instances, objects with `.message` or `.error` fields,
 * and arbitrary JSON-able values).
 *
 * @param error  The raw error from `SessionMessageSnapshot.info.error`
 * @returns A non-empty error message string
 */
export function extractAssistantError(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    return JSON.stringify(error);
  }
  return String(error);
}

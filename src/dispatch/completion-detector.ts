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

import type { CompletionSignal, SessionMessageSnapshot, TaskEventState } from "./types.ts";

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

// ── Core Detection ────────────────────────────────────────────────────

/**
 * Evaluate whether a background task session has reached completion.
 *
 * The decision follows a fixed priority order:
 *   1. Session gone → defer to session monitor
 *   2. Session actively processing → not ready
 *   3. Session in terminal status (interrupted) → completed
 *   4. Session idle → check for assistant output
 *   5. Error detection on last assistant message
 *   6. Tool-execution-in-progress guard
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
  // 1. Session gone → let the session monitor handle it
  if (!sessionStatus) {
    return { type: "not_ready" };
  }

  // 2. Session is actively processing
  if (ACTIVE_SESSION_STATUSES.has(sessionStatus.type)) {
    return { type: "not_ready" };
  }

  // 3. Terminal session status (e.g., "interrupted") → task is done
  if (TERMINAL_SESSION_STATUSES.has(sessionStatus.type)) {
    return { type: "completed" };
  }

  // 4. For idle sessions: verify we have assistant output
  //    (non-idle, non-active, non-terminal statuses are treated as idle-like)

  // 5. Find the LAST assistant message (reverse scan)
  let lastAssistant: SessionMessageSnapshot | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "assistant") {
      lastAssistant = messages[i];
      break;
    }
  }

  // 6. No assistant message found — hasn't started generating
  if (!lastAssistant) {
    return { type: "not_ready" };
  }

  // 7. Error on the last assistant message
  if (lastAssistant.info.error) {
    return { type: "error", message: extractAssistantError(lastAssistant.info.error) };
  }

  // 8. Tool execution in progress (pending or running)
  for (const part of lastAssistant.parts) {
    if (part.type === "tool") {
      if (part.state === "pending" || part.state === "running") {
        return { type: "not_ready" };
      }
    }
  }

  // 9. If finish is explicitly "tool-calls", model expects tool execution → not ready
  if (lastAssistant.info.finish === "tool-calls") {
    return { type: "not_ready" };
  }

  // 10. Session is idle, has assistant output, no pending tools.
  //     Apply stability gating to avoid premature completion detection.
  //     When skipStabilityGating=true (event-driven evaluation), bypass stability.
  if (!skipStabilityGating) {
    return { type: "stabilizing" };
  }

  // 11. All gates passed → task is complete
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

/**
 * Pure-function completion detector for the global poller.
 *
 * Determines whether a dispatched background task session has reached
 * a final state by inspecting the message sequence and session status.
 *
 * This module has NO side effects and NO SDK calls — it operates
 * exclusively on the structured snapshots provided by the caller.
 */

import type { CompletionSignal, SessionMessageSnapshot, TaskPollState } from "./types.js";
import { MIN_STABILITY_POLLS } from "./config.js";

// ── Public Types ───────────────────────────────────────────────────────

/**
 * Finish reasons returned by the model provider that are NOT terminal.
 *
 * Only `"end_turn"` signals natural completion.  Everything else means
 * the model stopped mid-work (length limit, safety, tool requests, etc.)
 * and may produce more output.
 */
export type NonTerminalFinishReason = "tool-calls" | "stop" | "length" | "unknown";

// ── Constants ─────────────────────────────────────────────────────────

const NON_TERMINAL: ReadonlySet<string> = new Set([
  "tool-calls",
  "stop",
  "length",
  "unknown",
]);

// ── Core Detection ────────────────────────────────────────────────────

/**
 * Evaluate whether a background task session has reached completion.
 *
 * The decision follows a fixed priority order:
 *   1. Session status checks (gone / busy / wrong state)
 *   2. Error detection on the last assistant message
 *   3. Finish-signal inspection (end_turn vs non-terminal)
 *   4. Tool-execution-in-progress guard
 *   5. Stability gating (MIN_STABILITY_POLLS consecutive idle polls)
 *
 * @param messages  Chronological message snapshots from the sub-agent session
 * @param sessionStatus  Current session status (type field: "idle", "busy", "retry", etc.)
 * @param pollState  Per-task polling metadata (stable idle count, etc.)
 * @returns A structured completion signal
 */
export function detectCompletion(
  messages: SessionMessageSnapshot[],
  sessionStatus: { type: string } | undefined,
  pollState: TaskPollState,
): CompletionSignal {
  // 1. Session gone → let the session monitor handle it
  if (!sessionStatus) {
    return { type: "not_ready" };
  }

  // 2. Session is actively processing
  if (sessionStatus.type === "busy" || sessionStatus.type === "retry") {
    return { type: "not_ready" };
  }

  // 3. Unexpected / unknown session status
  if (sessionStatus.type !== "idle") {
    return { type: "not_ready" };
  }

  // 4. Find the LAST assistant message (reverse scan)
  let lastAssistant: SessionMessageSnapshot | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "assistant") {
      lastAssistant = messages[i];
      break;
    }
  }

  // 5. No assistant message found — hasn't started generating
  if (!lastAssistant) {
    return { type: "not_ready" };
  }

  // 6. Error on the last assistant message
  if (lastAssistant.info.error) {
    return { type: "error", message: extractAssistantError(lastAssistant.info.error) };
  }

  // 7. No finish signal yet — still generating
  if (lastAssistant.info.finish === undefined) {
    return { type: "not_ready" };
  }

  // 8. Non-terminal finish reason — still working or stopped mid-way
  if (NON_TERMINAL.has(lastAssistant.info.finish)) {
    return { type: "not_ready" };
  }

  // 9. Tool execution in progress (pending or running)
  for (const part of lastAssistant.parts) {
    if (part.type === "tool") {
      if (part.state === "pending" || part.state === "running") {
        return { type: "not_ready" };
      }
    }
  }

  // 10. Not enough stable idle polls yet
  if (pollState.stableIdlePolls < MIN_STABILITY_POLLS) {
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

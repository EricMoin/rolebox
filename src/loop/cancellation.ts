import type { LoopState, LoopPhase } from "./types.js";
import {
  STOP_LOOP_SIGNAL,
} from "./constants.js";
import {
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
} from "../dispatch/notification.js";

export const DISPATCH_MARKERS = [
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
] as const;

const TERMINAL_PHASES = new Set<LoopPhase>([
  "complete",
  "cancelled",
  "error",
  "interrupted",
]);

/** Phases owned by the origin/orchestrator — human input here is NOT an interrupt. */
const ORIGIN_OWNED_PHASES = new Set<LoopPhase>([
  "activating",
  "summarizing",
  "finalizing",
]);

/**
 * Determine whether an incoming message should cancel the loop.
 *
 * Cancellation requires an **explicit stop signal** (the `/stop-loop` command
 * injects `STOP_LOOP_SIGNAL` into the message text). Ordinary user messages
 * no longer interrupt a running loop — only the dedicated command does.
 *
 * System re-prompts (dispatch completion markers, auto-continue, loop-progress
 * notes) are still excluded for safety.
 */
export function shouldCancelLoop(
  loopState: LoopState,
  messageText: string,
): boolean {
  if (!messageText.includes(STOP_LOOP_SIGNAL)) return false;

  if (TERMINAL_PHASES.has(loopState.phase)) return false;
  if (ORIGIN_OWNED_PHASES.has(loopState.phase)) return false;

  if (loopState.phase === "awaiting_worker") return true;
  if (loopState.phase === "dispatching") return true;

  return false;
}

export { TERMINAL_PHASES, ORIGIN_OWNED_PHASES };

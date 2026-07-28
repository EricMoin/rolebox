import { graphSessionState } from "./state.ts";
import type { AdvanceResult } from "./state.ts";
import { evaluateAsync } from "./termination-async.ts";
import type { JudgeFn } from "./termination-async.ts";
import type { ResolvedGraph } from "../types.ts";
import { createSubLogger } from "../logger.ts";
import { buildReminder } from "../prompt/reminder.ts";

export const MAX_CORRECTIONS = 3;
export const ASYNC_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [200, 400];

/** In-flight async convergence evaluations, keyed by sessionId. */
const inFlightEvaluations = new Map<string, Promise<void>>();

const log = createSubLogger("graph:advance");

let _advanceJudge: JudgeFn | undefined;

export function setAdvanceJudge(judge: JudgeFn): void {
  _advanceJudge = judge;
}

/**
 * Await any in-flight convergence evaluation for the given session.
 * Returns immediately if none is pending. Useful for test synchronization.
 */
export async function drainConvergence(sessionID: string): Promise<void> {
  const pending = inFlightEvaluations.get(sessionID);
  if (pending) await pending;
}

// Regex patterns for string fallback extraction, matching the existing
// patterns from the plugin-hooks tool.execute.after handler.
const taskQuotedRegex = /subagent_type\s*=\s*["']([^"']+)["']/;
const taskUnquotedRegex = /subagent_type\s*=\s*([^\s,}\])]+)/;
const dispatchQuotedRegex = /subagent\s*=\s*["']([^"']+)["']/;
const dispatchUnquotedRegex = /subagent\s*=\s*([^\s,}\])]+)/;

/**
 * Extract the dispatched subagent target from structured tool arguments.
 *
 * - tool === "task" → reads args.subagent_type
 * - tool === "dispatch" → reads args.subagent
 * - Falls back to regex extraction if args is a raw string
 * - Returns undefined if target can't be determined
 */
export function extractDispatchTarget(
  tool: string,
  args: unknown,
): string | undefined {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;

    if (tool === "task") {
      const val = record.subagent_type;
      if (typeof val === "string" && val.length > 0) return val;
    }

    if (tool === "dispatch") {
      const val = record.subagent;
      if (typeof val === "string" && val.length > 0) return val;
    }

    return undefined;
  }

  if (typeof args === "string") {
    if (tool === "task") {
      const quoted = args.match(taskQuotedRegex);
      if (quoted) return quoted[1];

      const unquoted = args.match(taskUnquotedRegex);
      if (unquoted) return unquoted[1];
    }

    if (tool === "dispatch") {
      const quoted = args.match(dispatchQuotedRegex);
      if (quoted) return quoted[1];

      const unquoted = args.match(dispatchUnquotedRegex);
      if (unquoted) return unquoted[1];
    }
  }

  return undefined;
}

/**
 * Single-authority entry point for advancing the graph state after a dispatch.
 * Checks session state validity, extracts target, calls graphSessionState.advanceStep.
 *
 * Returns the AdvanceResult plus an optional correction string for off-route
 * or unknown dispatches. The correction is a <system-reminder> block suitable
 * for injection into the orchestrator's next system prompt (Task 18).
 */
export function advanceGraphForDispatch(
  sessionID: string,
  tool: string,
  args: unknown,
): { result: AdvanceResult; correction?: string } {
  const state = graphSessionState.getState(sessionID);
  if (!state) return { result: { kind: "ignored" } };
  if (state.status !== "active") return { result: { kind: "ignored" } };

  const target = extractDispatchTarget(tool, args);
  if (!target) return { result: { kind: "ignored" } };

  const result = graphSessionState.advanceStep(sessionID, target);

  if (result.kind === "off_route") {
    state.correctionCount = (state.correctionCount ?? 0) + 1;
    const expected = result.expected.join(", ");

    let correction: string;
    if (state.correctionCount >= MAX_CORRECTIONS) {
      correction = buildReminder({
        fields: [{ label: "reason", value: "repeated off-route dispatches" }],
        action: "Stop dispatching and synthesize the best final result from the completed agents' work.",
      });
    } else {
      correction = buildReminder({
        fields: [
          { label: "got", value: result.got },
          { label: "expected", value: expected },
        ],
        action: "The dispatch went off-route. Graph state has not been advanced.",
      });
    }
    return { result, correction };
  }

  if (result.kind === "unknown") {
    const correction = buildReminder({
      fields: [{ label: "got", value: result.got }],
      action: "Not part of the collaboration graph. Graph state has not been advanced.",
    });
    return { result, correction };
  }

  // ── Async orchestration phase ─────────────────────────────────
  // When the termination config includes converged/result_matches,
  // fire evaluateAsync via the managed runAsyncConvergence which
  // provides dedup, timeout, retry, and warning logging.
  const graph = graphSessionState.getGraph(sessionID);
  const needsAsync = graph?.termination
    ? hasAsyncCondition(graph.termination.config)
    : false;

  if (needsAsync && _advanceJudge && graph) {
    runAsyncConvergence(sessionID, graph, _advanceJudge);
  }

  return { result };
}

/**
 * Run async convergence evaluation with dedup, timeout, and retry.
 *
 * - Skips if an evaluation is already in-flight for this session (dedup).
 * - Wraps evaluateAsync with a 30s timeout via Promise.race.
 * - Retries up to 2 times with exponential backoff (200ms, 400ms).
 * - On final failure: logs a warning and leaves graph state unchanged.
 */
async function runAsyncConvergence(
  sessionID: string,
  graph: ResolvedGraph,
  judge: JudgeFn,
): Promise<void> {
  // Skip duplicate if an evaluation is already pending for this session
  if (inFlightEvaluations.has(sessionID)) {
    return;
  }

  const promise = (async (): Promise<void> => {
    try {
      let lastError: unknown;

      // Attempt 0 is the initial call, attempts 1-2 are retries
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          const evalResult = await raceTimeout(
            evaluateAsync(
              graphSessionState.getState(sessionID)!,
              graph,
              { judge },
            ),
            ASYNC_TIMEOUT_MS,
            `Async convergence evaluation timed out after ${ASYNC_TIMEOUT_MS}ms`,
          );

          const currentState = graphSessionState.getState(sessionID);
          if (!currentState) return;

          if (evalResult.converged) {
            currentState.terminationReason = "converged";
            currentState.convergenceSignal = "converged";
            currentState.status = "complete";
          } else if (evalResult.resultMatch) {
            currentState.terminationReason = "result_match";
            currentState.status = "complete";
          }

          return; // success
        } catch (err) {
          lastError = err;
          if (attempt < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt]);
          }
        }
      }

      // All retries exhausted — log warning, no state change
      log.warn(
        `Async convergence failed for session "${sessionID}" after ${RETRY_DELAYS_MS.length + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    } finally {
      inFlightEvaluations.delete(sessionID);
    }
  })();

  inFlightEvaluations.set(sessionID, promise);
}

/**
 * Await a promise with a timeout that rejects after the given ms.
 */
function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAsyncCondition(
  config: { any_of?: unknown[]; all_of?: unknown[] },
): boolean {
  const check = (arr: unknown[] | undefined): boolean =>
    arr?.some(
      (c) =>
        typeof c === "object" && c !== null && ("converged" in c || "result_matches" in c),
    ) ?? false;
  return check(config.any_of) || check(config.all_of);
}

import { graphSessionState } from "./state.ts";
import type { AdvanceResult } from "./state.ts";
import { evaluateAsync } from "./termination-async.ts";
import type { JudgeFn } from "./termination-async.ts";

export const MAX_CORRECTIONS = 3;

let _advanceJudge: JudgeFn | undefined;

export function setAdvanceJudge(judge: JudgeFn): void {
  _advanceJudge = judge;
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
      correction = `<system-reminder>
The workflow has terminated due to repeated off-route dispatches. Stop dispatching and synthesize the best final result from the completed agents' work.
</system-reminder>`;
    } else {
      correction = `<system-reminder>
The dispatch to "${result.got}" went off the collaboration graph route.
Expected next target(s): ${expected}.
The graph state has not been advanced.
</system-reminder>`;
    }
    return { result, correction };
  }

  if (result.kind === "unknown") {
    const correction = `<system-reminder>
"${result.got}" is not part of the collaboration graph.
The graph state has not been advanced.
</system-reminder>`;
    return { result, correction };
  }

  // ── Async orchestration phase ─────────────────────────────────
  // When the termination config includes converged/result_matches,
  // fire evaluateAsync after sync advanceStep returns. Results are
  // stored onto state for the next system.transform read.
  const graph = graphSessionState.getGraph(sessionID);
  const needsAsync = graph?.termination
    ? hasAsyncCondition(graph.termination.config)
    : false;

  if (needsAsync && _advanceJudge && graph) {
    const sessionIDCapture = sessionID;
    Promise.resolve().then(async () => {
      try {
        const evalResult = await evaluateAsync(
          graphSessionState.getState(sessionIDCapture)!,
          graph,
          { judge: _advanceJudge! },
        );
        const currentState = graphSessionState.getState(sessionIDCapture);
        if (!currentState) return;

        if (evalResult.converged) {
          currentState.terminationReason = "converged";
          currentState.convergenceSignal = "converged";
          currentState.status = "complete";
        } else if (evalResult.resultMatch) {
          currentState.terminationReason = "result_match";
          currentState.status = "complete";
        }
      } catch {
        // converged async failure → not converged (no state change)
      }
    });
  }

  return { result };
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

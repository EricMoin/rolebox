import { graphSessionState } from "./state.ts";
import type { AdvanceResult } from "./state.ts";

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
    const expected = result.expected.join(", ");
    const correction = `<system-reminder>
The dispatch to "${result.got}" went off the collaboration graph route.
Expected next target(s): ${expected}.
The graph state has not been advanced.
</system-reminder>`;
    return { result, correction };
  }

  if (result.kind === "unknown") {
    const correction = `<system-reminder>
"${result.got}" is not part of the collaboration graph.
The graph state has not been advanced.
</system-reminder>`;
    return { result, correction };
  }

  return { result };
}

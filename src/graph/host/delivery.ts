import type { AcceptedData, JsonValue } from "../domain/model.ts";
import type { OutcomeDispatchRequest } from "../outcome/dispatch-effects.ts";
import type { DeliveredInputView } from "./input-view.ts";

const INLINE_DATA_MAX_CHARS = 160;
const SUMMARY_MAX_CHARS = 240;

/**
 * Render the prompt one attempt's worker receives: the plan's own prompt, the
 * attempt identity and credential handoff, and — when this attempt consumes
 * upstream results — the input view it was armed with.
 *
 * The plan's prompt is preserved verbatim as the first block — every appended
 * block follows it, never interleaves it, so a node author's instructions read
 * exactly as declared.
 */
export function buildAttemptDeliveryPrompt(
  request: OutcomeDispatchRequest,
  inputView?: DeliveredInputView,
): string {
  const blocks = [
    request.prompt,
    "",
    "---",
    "[rolebox outcome protocol — attempt handoff]",
    "You are running graph " +
    JSON.stringify(request.graphId) +
    " node " +
    JSON.stringify(request.nodeId) +
    " attempt " +
    JSON.stringify(request.attemptId) +
    ".",
    "When your work satisfies one of this node's declared outcomes, settle it with the",
    "graph_submit_outcome tool, passing:",
    "  graph_id:   " + request.graphId,
    "  node_id:    " + request.nodeId,
    "  outcome_id: the declared outcome your work achieved",
    "  credential: " + request.credential,
    "The credential is bound to THIS attempt only. Do not write it into a file, a",
    "shared message, or another node's context; pass it only to graph_submit_outcome.",
  ];
  if (inputView !== undefined) {
    blocks.push(...inputViewLines(inputView));
  }
  return blocks.join("\n");
}

/** The prompt is a short handoff; the manifest retains every accepted value. */
function inputViewLines(view: DeliveredInputView): readonly string[] {
  const lines: string[] = [
    "",
    "---",
    "## Accepted upstream results",
    "These are producer-reported results. Verify claims independently before relying on them.",
    "Full results manifest: " + JSON.stringify(view.manifestPath),
    "Read only the fields you need from the manifest. Artifact paths below name delivered copies.",
  ];
  for (const [index, entry] of view.entries.entries()) {
    lines.push(
      "- Producer: " + JSON.stringify(entry.from) +
      "; outcome: " + JSON.stringify(entry.outcome) +
      "; attempt: " + JSON.stringify(entry.attemptId),
    );
    const data = describeAcceptedData(entry.payload);
    if (data !== undefined) lines.push("  " + data);
    const issue = describeReportedIssues(entry.payload);
    if (issue !== undefined) lines.push("  " + issue);
    lines.push(
      "  Full accepted data: inputs[" + index + "].payload" +
      (entry.payload.kind === "value" ? ".value" : "") +
      " in the manifest.",
    );
    if (entry.artifacts.length === 0) {
      lines.push("  Retained artifact files: none.");
    } else {
      lines.push("  Retained artifact files:");
      for (const artifact of entry.artifacts) {
        lines.push(
          "    - " + JSON.stringify(artifact.ref) +
          " → " + JSON.stringify(artifact.path),
        );
      }
    }
  }
  return lines;
}

/** Preserve absent, null and empty values without inlining a large result. */
function describeAcceptedData(payload: AcceptedData): string | undefined {
  if (payload.kind === "absent") {
    return "Accepted data: absent (the producer supplied no data).";
  }
  const value = payload.value;
  const summary = asRecord(value)?.summary;
  if (typeof summary === "string" && summary.trim() !== "") {
    const normalized = summary.replace(/\s+/g, " ").trim();
    const characters = Array.from(normalized);
    const excerpt = characters.length > SUMMARY_MAX_CHARS;
    const shown = excerpt
      ? characters.slice(0, SUMMARY_MAX_CHARS).join("") + "…"
      : normalized;
    return "Producer summary" + (excerpt ? " (excerpt)" : "") + ": " +
      JSON.stringify(shown);
  }
  const json = JSON.stringify(value);
  if (Array.from(json).length <= INLINE_DATA_MAX_CHARS) {
    return "Accepted data: " + json;
  }
  return undefined;
}

/** Surface caveats without promoting a producer's report to a verified result. */
function describeReportedIssues(payload: AcceptedData): string | undefined {
  if (payload.kind === "absent") return undefined;
  const record = asRecord(payload.value);
  if (record === undefined) return undefined;
  const limitations = Array.isArray(record.limitations) && record.limitations.length > 0;
  const failedChecks = Array.isArray(record.commands) && record.commands.some((command) => {
    const check = asRecord(command);
    return check !== undefined && typeof check.exit === "number" && check.exit !== 0;
  });
  if (!limitations && !failedChecks) return undefined;
  const reported = limitations && failedChecks
    ? "limitations and failed checks"
    : limitations ? "limitations" : "failed checks";
  return "The producer reported " + reported +
    ". Read the full result before relying on its claims, and verify them independently.";
}

function asRecord(value: JsonValue): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

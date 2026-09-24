/**
 * Graph Execution Engine v2 — the worker-facing attempt handoff
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The ONE text a host appends to a dispatched node's prompt: the attempt's
 * identity and the bearer credential the worker must present to
 * `graph_submit_outcome`, and — when the attempt consumes upstream results — the
 * INPUT VIEW the host materialized for it (`input-view.ts`, D7): the producing
 * node, its accepted outcome, the producing attempt, the accepted data and the
 * paths of the real files that worker can read.
 *
 * WHY THE PROMPT IS THE CHANNEL. The credential exists in exactly two places —
 * the host's protected vault and the dispatch request this module renders. It
 * must reach the worker the attempt belongs to and nobody else: the shared
 * `<graph_state>` block, `graph_status`, logs, receipts and the ledger are all
 * deliberately credential-free. A subagent start is the host's one channel that
 * addresses a single worker, so the credential travels here and nowhere else.
 *
 * WHAT THE INPUT BLOCK MAY SAY. Only what the view carries: nodes, outcomes,
 * attempts, accepted data and paths inside that consumer's own directory. A
 * store root, a credential, a policy or another attempt's files are never
 * rendered, because the worker is handed this view and nothing behind it.
 */

import type { AcceptedData } from "../domain/model.ts";
import type { OutcomeDispatchRequest } from "../outcome/dispatch-effects.ts";
import type { DeliveredInputView } from "./input-view.ts";

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

/**
 * The input block: every accepted upstream result this attempt consumes, with
 * the files the host materialized from the retained content identities.
 *
 * ABSENT, NULL AND EMPTY STAY DISTINGUISHABLE HERE (D1): `absent` is rendered as
 * "the producing submission carried no data at all", and every value the
 * submission did carry is rendered as its own JSON — `null`, `{}` and `""`
 * included — so a worker never has to guess which of them it received.
 */
function inputViewLines(view: DeliveredInputView): readonly string[] {
  const lines: string[] = [
    "",
    "---",
    "[rolebox graph inputs — the accepted results this attempt consumes]",
    "Each entry below is what an upstream node ACCEPTED, bound to the attempt that",
    "accepted it. The files are real copies retained under their content identity; the",
    "paths are the ONLY files this attempt was given, and the bytes at them are what the",
    "acceptance verified. Read them at these paths — the plan's own references name what",
    "the producer declared, not where the retained bytes live.",
    "manifest: " + view.manifestPath,
  ];
  for (const entry of view.entries) {
    lines.push(
      "- from " +
        JSON.stringify(entry.from) +
        ", outcome " +
        JSON.stringify(entry.outcome) +
        ", attempt " +
        JSON.stringify(entry.attemptId) +
        ":",
      "    accepted data: " + describeAcceptedData(entry.payload),
    );
    if (entry.artifacts.length === 0) {
      lines.push(
        "    file: none (this acceptance retained no artifact for this input)",
      );
    }
    for (const artifact of entry.artifacts) {
      lines.push(
        "    file: " +
          artifact.ref +
          " -> " +
          artifact.path +
          " (" +
          artifact.artifactId +
          ", " +
          String(artifact.size) +
          " bytes)",
      );
    }
  }
  return lines;
}

/** One accepted payload, rendered with its presence intact (D1). */
function describeAcceptedData(payload: AcceptedData): string {
  if (payload.kind === "absent") {
    return "none (the producing submission carried no data at all)";
  }
  return JSON.stringify(payload.value);
}

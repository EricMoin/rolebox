/**
 * Graph Execution Engine v2 — the worker-facing attempt handoff
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The ONE text a host appends to a dispatched node's prompt: the attempt's
 * identity and the bearer credential the worker must present to
 * `graph_submit_outcome`.
 *
 * WHY THE PROMPT IS THE CHANNEL. The credential exists in exactly two places —
 * the host's protected vault and the dispatch request this module renders. It
 * must reach the worker the attempt belongs to and nobody else: the shared
 * `<graph_state>` block, `graph_status`, logs, receipts and the ledger are all
 * deliberately credential-free. A subagent start is the host's one channel that
 * addresses a single worker, so the credential travels here and nowhere else.
 */

import type { OutcomeDispatchRequest } from "../outcome/dispatch-effects.ts";

/**
 * Render the prompt one attempt's worker receives: the plan's own prompt plus
 * the attempt identity and credential handoff.
 *
 * The plan's prompt is preserved verbatim as the first block — the handoff is
 * appended, never interleaved, so a node author's instructions read exactly as
 * declared.
 */
export function buildAttemptDeliveryPrompt(
  request: OutcomeDispatchRequest,
): string {
  return [
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
  ].join("\n");
}

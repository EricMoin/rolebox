/**
 * Graph Execution Engine v2 — Cascade Canceller
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * A convergence node (a node with multiple upstream edges) accumulates upstream
 * results under its join strategy (all / any / quorum:N). Once that join
 * resolves — satisfied (the threshold is met, so extra upstreams are no longer
 * needed) or failed (the join can never resolve, e.g. `all` aborts on the first
 * non-answer signal, or a quorum became impossible) — the still-outstanding
 * upstream nodes are "no longer needed" and must be cancelled so they stop
 * consuming dispatch budget.
 *
 * {@link cancelPendingUpstreams} is that cascade. It is the standalone
 * cancellation half of fan-in, complementing {@link evaluateJoin}
 * (`join-evaluator.ts`), which is the evaluation half. The two cooperate:
 * the caller passes the join verdict produced by {@link evaluateJoin}, and the
 * canceller applies the lifecycle + dispatch consequences described in
 * `.rolebox/design/failure-resilience.md` §3.3:
 *
 *   1. cancel the dispatch task for each no-longer-needed upstream node
 *      (best-effort via an optional cancel seam — never awaited).
 *   2. those nodes transition `running|ready|pending → cancelled → done`.
 *   3. the convergence node proceeds immediately; it does NOT wait for
 *      cancellation acknowledgements.
 *
 * Partial-failure retention (§3.2): a `waiting` verdict (and the cancellation
 * path in general) never mutates `node.upstreamResults`. Upstream signals
 * already recorded — including `escalate` / `revise_needed` — are preserved in
 * `upstreamResults` and in the fan-in `sources[]`, so the convergence node's
 * agent can still inspect them for diagnostics. Cancellation only retires
 * upstreams that have NOT yet produced a payload.
 *
 * Invariant: this module is an import-only consumer of the lifecycle state
 * machine (`node-lifecycle.ts`) and join topology (`join-evaluator.ts`). It
 * never reaches into the dispatch / signal / loop subsystems directly.
 */

import { NodeStatus } from "../../constants.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import {
  getUpstreamNodeIds,
  type JoinVerdict,
} from "./join-evaluator.ts";
import { markCancelled, markDone } from "./node-lifecycle.ts";

// ── Ports ──────────────────────────────────────────────────────────────────

/**
 * The cancellation seam the canceller touches. Structurally satisfied by
 * {@link NodeDispatchPort} (`engine-advance.ts`), whose `cancelTask` is
 * optional — a port may omit it, in which case cancellation is lifecycle-only
 * (the nodes still reach `cancelled → done`, but no dispatch task is torn
 * down). Tests inject a fake to observe the cancel calls.
 */
export interface CancelDispatchPort {
  /** Best-effort cancellation of a running dispatch task. Never awaited. */
  cancelTask?(taskId: string): Promise<boolean>;
}

// ── Report ─────────────────────────────────────────────────────────────────

/**
 * What {@link cancelPendingUpstreams} did, for diagnostics and tests.
 *
 * - `cancelled` — upstream node IDs that were retired to `cancelled → done`
 *   (and, when a cancel seam was present, had their dispatch task cancelled).
 * - `alreadyResolved` — upstream node IDs that had already produced a payload
 *   (answer / escalate / revise_needed). These were left untouched — their
 *   signals remain in `upstreamResults` for the convergence node to inspect.
 */
export interface CascadeCancelReport {
  cancelled: string[];
  alreadyResolved: string[];
}

// ── Cascade canceller ──────────────────────────────────────────────────────

/**
 * Cancel the upstream nodes a convergence node no longer needs once its join
 * has resolved (satisfied or failed).
 *
 * The join verdict is supplied by the caller (typically a re-derivation of
 * {@link evaluateJoin}) because the canceller is a pure consequence function —
 * it should not re-run topology/strategy evaluation it does not own. Policy:
 *
 * - `satisfied` — the strategy threshold is met (e.g. `any` on the first
 *   answer, or `quorum:N` reached); every upstream that has not yet produced a
 *   payload is cancelled because its result can no longer matter.
 * - `failed` — the join can never resolve further (e.g. `all` aborted on the
 *   first non-answer signal, or a quorum became impossible per §3.1); the
 *   still-pending upstreams are cancelled because they could not have changed
 *   the outcome.
 * - `waiting` — the join can still resolve; this is a no-op. No node is
 *   cancelled and nothing in `upstreamResults` is touched.
 *
 * For every cancelled node:
 *   1. the node lifecycle advances `running | ready | pending → cancelled → done`
 *      via {@link markCancelled} / {@link markDone} (design §3.3 step 2), so the
 *      node stops being an "active" node and the graph can terminate.
 *   2. when a cancel seam is present and the node carries a `dispatchTaskId`,
 *      the dispatch task is cancelled fire-and-forget (`void` the promise).
 *      The canceller never awaits the acknowledgement — it returns immediately
 *      (§3.3 step 3).
 *
 * Nodes already recorded in `node.upstreamResults` (answer, escalate,
 * revise_needed) are `alreadyResolved` and are intentionally not cancelled;
 * their partial-failure signals are retained for downstream diagnostics
 * (§3.2), not dropped.
 *
 * @param state         Engine state (source of per-node runtime state).
 * @param node          The convergence node whose upstreams are being retired.
 * @param joinVerdict   The join verdict to act on (satisfied / failed / waiting).
 * @param dispatchPort  Optional cancellation seam; when omitted, only the node
 *                      lifecycle is advanced (no dispatch task teardown).
 * @returns A {@link CascadeCancelReport} describing cancelled vs. resolved nodes.
 */
export function cancelPendingUpstreams(
  state: EngineState,
  node: NodeRuntimeState,
  joinVerdict: JoinVerdict,
  dispatchPort?: CancelDispatchPort,
): CascadeCancelReport {
  // A still-undecided join must not retire anything — upstreams may yet answer.
  if (joinVerdict.kind === "waiting") {
    return { cancelled: [], alreadyResolved: [] };
  }

  const cancelled: string[] = [];
  const alreadyResolved: string[] = [];

  for (const sourceId of getUpstreamNodeIds(state, node)) {
    // An upstream that already recorded a payload has resolved (answered or
    // failed). Its signal stays in `upstreamResults` — it is not re-cancelled.
    if (node.upstreamResults.has(sourceId)) {
      alreadyResolved.push(sourceId);
      continue;
    }

    const upstream = state.nodes.get(sourceId);
    if (!upstream || !isCancellable(upstream)) continue;

    // Retire the node's lifecycle: running | ready | pending → cancelled → done.
    markCancelled(state, upstream, `cancelled by join cascade at convergence node "${node.nodeId}"`);
    markDone(state, upstream);
    cancelled.push(sourceId);

    // Best-effort dispatch teardown, fire-and-forget. Never await the ack —
    // the convergence node proceeds immediately (§3.3 step 3). Called as a
    // method so class-based ports keep their `this` receiver.
    if (dispatchPort?.cancelTask && upstream.dispatchTaskId) {
      void dispatchPort.cancelTask(upstream.dispatchTaskId);
    }
  }

  return { cancelled, alreadyResolved };
}

/**
 * Whether a node is still eligible for cancellation: only `pending`, `ready`,
 * and `running` nodes can be cancelled. A node already in `completed`,
 * `escalate`, `timeout`, `cancelled`, `blocked`, or `done` is either resolved
 * or already terminal and must not be touched (transition table enforces this
 * by throwing — we guard before calling).
 */
function isCancellable(node: NodeRuntimeState): boolean {
  return (
    node.status === NodeStatus.Pending ||
    node.status === NodeStatus.Ready ||
    node.status === NodeStatus.Running
  );
}

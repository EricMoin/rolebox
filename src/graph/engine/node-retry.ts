/**
 * Graph Execution Engine v2 — Node Retry (re-open / re-dispatch)
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * Retry support for the imperative `graph_run(node_id, retry=true, modify_prompt=...)`
 * surface (`.rolebox/design/tool-merge-map.md` §2.2 `graph_run`). Phase-4 concern:
 * a terminal graph's failed / escalated / completed node is re-opened for a clean
 * re-dispatch, clearing the stale per-run artifacts of the node **and its
 * downstream subgraph** so a re-run sees a fresh execution state.
 *
 * The work is split into two layers, mirroring the approval-handler convention
 * (`approval-handler.ts` — pure state primitives + an engine method that runs
 * them inside the advancement critical section):
 *
 * - {@link resetNodeForRetry} — a **pure state mutation**. Resets the target
 *   node and its transitive downstream to `pending`, prepends `modifyPrompt` to
 *   the target's prompt, re-marks the target `ready` (into the frontier) so it
 *   is picked up by `_dispatchReadyNodes`, and re-opens a terminal graph phase
 *   (`complete → executing`). Never dispatches, never acquires the lock.
 * - {@link retryNode} — the engine-facing orchestration (see `AdvanceEngine.retryNode`
 *   in `engine-advance.ts`): runs the reset inside a critical section, dispatches
 *   the now-ready target, re-checks termination, and returns a {@link RetryReport}.
 *
 * Design-vs-code notes:
 *
 * 1. **Deliberate reset, not a signal-driven transition.** Retry of a terminal
 *    node has to clear a `done` / `timeout` / `cancelled` node, none of which have
 *    a legal transition out of the terminal state in `node-lifecycle.ts` (`done`
 *    has no out-edges at all). So the reset writes `NodeStatus.Pending` directly
 *    instead of routing through `transitionNode`/`canTransitionNode`. It is a
 *    manual re-open, not an event the graph observed. `markReady` is still reused
 *    for the `pending → ready` hop (a legal transition), and
 *    `addToFrontier`/`removeFromFrontier` (engine-state.ts) manage the frontier.
 * 2. **Engine-phase re-entry.** The phase machine (`engine-state.ts`) only moves
 *    forward (`idle → executing → complete`); there is no `complete → executing`
 *    edge. Retrying a terminal graph therefore writes the phase back to
 *    `executing` directly. This is the same deliberate-reopen rationale as the
 *    node-level reset above and keeps the forward-only invariant intact for all
 *    signal-driven advancement.
 * 3. **Counters are preserved.** `sessionsSpawned`, `tokensConsumed`,
 *    `traversalCount`, and `retryCount` accumulate across retries so budget and
 *    loop accounting stay honest; only the per-run execution artifacts
 *    (status, signals, result, dispatch ids, join state) are cleared.
 *
 * Design reference: `.rolebox/design/tool-merge-map.md` §2.2 `graph_run`.
 */

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import type { EngineRuntime } from "./index.ts";
import {
  addToFrontier,
  getNode,
  removeFromFrontier,
} from "./engine-state.ts";
import { markReady } from "./node-lifecycle.ts";
import { recordCheckpointForNode } from "./recorder.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/** Options for {@link retryNode} / {@link resetNodeForRetry}. */
export interface RetryNodeOptions {
  /**
   * When provided, prepended to the target node's `prompt` before it re-dispatches
   * (tool-merge-map.md §2.2 `graph_run` `modify_prompt`).
   */
  modifyPrompt?: string;
}

/** Result of the pure {@link resetNodeForRetry} mutation (no dispatch). */
export interface RetryResetReport {
  /** The node id being retried. */
  target: string;
  /** Node ids reset to `pending` for a clean re-run (target + downstream). */
  reset: string[];
  /** The node ids left `ready` (in the frontier) for immediate dispatch. */
  ready: string[];
}

/** Result of the full {@link retryNode} orchestration (reset + dispatch). */
export interface RetryReport extends RetryResetReport {
  /** Number of nodes actually (re-)dispatched into `running` this call. */
  reDispatched: number;
}

// ── Reset helper ────────────────────────────────────────────────────────────

/**
 * Clear the per-run execution artifacts of a node so it can execute again.
 *
 * Preserves the accumulated counters (`sessionsSpawned`, `tokensConsumed`,
 * `traversalCount`, `retryCount`) and the node's static identity (`agent`,
 * `prompt` — the prompt may be mutated for `modify_prompt`, done by the caller).
 * The `result`, recorded signals, dispatch task ids, join accumulation, and error
 * reason are all dropped so a re-run starts from a clean execution state.
 */
function resetNodeRun(node: NodeRuntimeState): void {
  node.signalsObserved = {};
  node.result = undefined;
  node.dispatchTaskId = undefined;
  node.dispatchSessionId = undefined;
  node.errorReason = undefined;
  node.upstreamResults = new Map();
  node.joinSatisfied = false;
  node.completedAt = undefined;
}

// ── Pure reset primitive ────────────────────────────────────────────────────

/**
 * Pure state mutation that re-opens a node for retry (tool-merge-map.md §2.2
 * `graph_run(node_id, retry=true, modify_prompt=...)`).
 *
 * Steps:
 *  1. Collect the target node's **transitive downstream** (BFS along every edge
 *     type — same walk shape as `pruneDownstreamSubgraph` in approval-handler.ts,
 *     except we reset instead of cancel). Any downstream node that already ran
 *     (terminal or currently pending/ready with stale artifacts) is reset to
 *     `pending` and removed from the frontier. It will re-activate via its join
 *     once the target re-completes and re-emits.
 *  2. Reset the **target**: clear its per-run artifacts, force `pending`, prepend
 *     `modifyPrompt` to its prompt, then re-mark it `ready` and add it to the
 *     frontier so `_dispatchReadyNodes` re-dispatches it regardless of its
 *     upstreams (a manual retry forces a re-run).
 *  3. Re-open a terminal graph phase (`complete → executing`) so advancement and
 *     termination checks keep working (see header note 2).
 *
 * Never dispatches and never acquires the advancement lock — callers (the advance
 * engine's critical section) own that.
 *
 * @throws when `nodeId` is unknown (reuses `getNode`).
 */
export function resetNodeForRetry(
  state: EngineState,
  nodeId: string,
  opts?: RetryNodeOptions,
): RetryResetReport {
  const target = getNode(state, nodeId);

  // 1. Transitive downstream (excluding the target).
  const downstream = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of state.graphDeclaration.edges) {
      if (edge.from !== current) continue;
      if (edge.to === nodeId || downstream.has(edge.to)) continue;
      downstream.add(edge.to);
      queue.push(edge.to);
    }
  }

  // Reset every downstream node that may carry stale run state. Terminal nodes
  // (completed / escalate / timeout / cancelled / done) and any pending/ready
  // node from a prior activation are all dropped back to `pending`.
  for (const id of downstream) {
    const node = state.nodes.get(id);
    if (!node) continue;
    resetNodeRun(node);
    const downstreamPrevStatus = node.status;
    node.status = NodeStatus.Pending;
    recordCheckpointForNode(state, node, downstreamPrevStatus, NodeStatus.Pending, Date.now());
    removeFromFrontier(state, id);
  }

  // 2. Reset the target: clean run artifacts, prepend modify_prompt, re-ready.
  resetNodeRun(target);
  if (opts?.modifyPrompt && opts.modifyPrompt.trim().length > 0) {
    target.prompt = `${opts.modifyPrompt.trim()}\n\n${target.prompt}`;
  }
  target.retryCount += 1;
  const targetPrevStatus = target.status;
  target.status = NodeStatus.Pending;
  recordCheckpointForNode(state, target, targetPrevStatus, NodeStatus.Pending, Date.now());
  markReady(state, target); // pending → ready (a legal transition)
  addToFrontier(state, nodeId);

  // 3. Re-open a terminal graph phase so the re-run stays active.
  if (state.phase === EnginePhase.Complete) {
    state.phase = EnginePhase.Executing;
    state.updatedAt = Date.now();
    state.isDirty = true;
  }

  return {
    target: nodeId,
    reset: [nodeId, ...downstream],
    ready: [nodeId],
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Retry a node on an {@link EngineRuntime}: delegates to the runtime's
 * `retryNode` method (implemented by `AdvanceEngine.retryNode`, which runs the
 * {@link resetNodeForRetry} reset inside the advancement critical section, then
 * dispatches the re-ready target and re-checks termination).
 *
 * @returns a {@link RetryReport} — {@link RetryReport.reDispatched} is the number
 *   of nodes (re-)dispatched into `running` this call.
 */
export function retryNode(
  runtime: EngineRuntime,
  nodeId: string,
  opts?: RetryNodeOptions,
): Promise<RetryReport> {
  return runtime.retryNode(nodeId, opts);
}

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
 * 4. **The graph-level signal ledger is synced.** The per-node
 *    `signalsObserved` reset alone would leave the dual-write
 *    `state.signalLedger` entry (signals, lastSignalAt, history) carrying
 *    PRE-retry events, so `resetNodeForRetry` also drops the ledger entry for
 *    the target and every reset downstream node — restoring the invariant
 *    "per-node signalsObserved ⇔ graph-level ledger" and keeping `graph_status`
 *    `stream` / `since` / `include_history` / `progress` views free of stale
 *    signal events from the previous run.
 * 5. **M11 retry guard (state check).** Retry only re-opens a QUIESCENT node.
 *    A node still mid-execution — `running` (a live dispatch task: tokens/cost
 *    keep flowing and the net-live `sessionsSpawned` slot would never be
 *    refunded) or `blocked` (a HITL approval gate in flight, owned by
 *    `graph_approve`) — anywhere in the reset scope (target + downstream) is
 *    REFUSED with an actionable error BEFORE any mutation. The caller cancels
 *    the node (`graph_cancel`) or waits for it to terminate, then retries.
 * 6. **Superseded subscriptions are reported.** The previous `dispatchTaskId`
 *    of every reset node is captured into {@link RetryResetReport.supersededTaskIds}
 *    so the engine layer can unregister the matching `onTaskTerminated`
 *    listeners (`AdvanceEngine.retryNode` → `_purgeSupersededTerminationSubscriptions`)
 *    — no zombie subscriptions accumulate across retries.
 * 7. **`modifyPrompt` is replace-style deduplicated.** Re-applying the SAME
 *    `modify_prompt` block is idempotent: when the block already prefixes the
 *    prompt it is NOT prepended again, so repeated retries never grow the
 *    prompt unboundedly (M11).
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
import { markDirty } from "./engine-persistence.ts";
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
  /**
   * The previous `dispatchTaskId` of every reset node (target + downstream),
   * captured as the reset cleared them (M11). The engine layer unregisters the
   * matching `onTaskTerminated` subscriptions so no zombie subscription
   * outlives its superseded task. Empty when no reset node carried a task.
   */
  supersededTaskIds: string[];
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

/**
 * Synchronize the graph-level signal ledger with a per-node run reset.
 *
 * `resetNodeRun` clears the node's per-node `signalsObserved`, but the
 * dual-write `state.signalLedger` entry (signals, lastSignalAt, history)
 * written by `signal-bridge.ts:record` would otherwise survive untouched —
 * after a retry the ledger would still carry the PRE-retry `history` /
 * `lastSignalAt`, misleading `graph_status` `stream` / `since` /
 * `include_history` / `progress` views into showing stale events from the
 * previous run as if they belonged to the fresh one. Deleting the entry
 * restores the invariant "per-node signalsObserved ⇔ graph-level ledger" for
 * the reset run; the entry is lazily re-created by `signal-bridge.ts:record`
 * when the node emits again. A simple clear is chosen over a retry-relocation
 * record — no existing test depends on ledger history surviving a retry.
 */
function clearSignalLedgerEntry(state: EngineState, nodeId: string): void {
  state.signalLedger.delete(nodeId);
}

// ── Pure reset primitive ────────────────────────────────────────────────────

/**
 * Pure state mutation that re-opens a node for retry (tool-merge-map.md §2.2
 * `graph_run(node_id, retry=true, modify_prompt=...)`).
 *
 * Steps:
 *  0. **M11 state guard.** Refuse (throw, no mutation) when ANY node in the
 *     reset scope — the target or a transitive downstream — is still
 *     mid-execution (`running` with a live dispatch task, or `blocked` under a
 *     HITL gate). Resetting such a node would clear its `dispatchTaskId`
 *     without cancelling the task: the live dispatch session keeps consuming
 *     (tokens/cost, an unrefunded `sessionsSpawned` slot) and its
 *     `onTaskTerminated` listener would become a zombie. The error is
 *     actionable — cancel the node (`graph_cancel`) or wait for termination.
 *  1. Collect the target node's **transitive downstream** (BFS along every edge
 *     type — same walk shape as `pruneDownstreamSubgraph` in approval-handler.ts,
 *     except we reset instead of cancel). Any downstream node that already ran
 *     (terminal or currently pending/ready with stale artifacts) is reset to
 *     `pending` and removed from the frontier. It will re-activate via its join
 *     once the target re-completes and re-emits.
 *  2. Reset the **target**: clear its per-run artifacts, force `pending`, prepend
 *     `modifyPrompt` to its prompt (replace-style dedup — re-applying the same
 *     block is a no-op), then re-mark it `ready` and add it to the frontier so
 *     `_dispatchReadyNodes` re-dispatches it regardless of its upstreams (a
 *     manual retry forces a re-run).
 *  3. Re-open a terminal graph phase (`complete → executing`) so advancement and
 *     termination checks keep working (see header note 2).
 *  4. **Sync the graph-level signal ledger** (header note 4): for the target and
 *     every reset downstream node, drop its `state.signalLedger` entry so no
 *     pre-retry `history` / `lastSignalAt` leaks into `graph_status`
 *     `stream` / `since` / `include_history` / `progress` views of the retry run.
 *  5. Report every superseded `dispatchTaskId` in
 *     {@link RetryResetReport.supersededTaskIds} (header note 6) for the engine
 *     layer's zombie-subscription cleanup.
 *
 * Never dispatches and never acquires the advancement lock — callers (the advance
 * engine's critical section) own that.
 *
 * @throws when `nodeId` is unknown (reuses `getNode`) or when a node in the
 *   reset scope is still `running` / `blocked` (M11 state guard).
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

  // 0. M11 state guard — reject BEFORE any mutation when the reset scope still
  // holds a mid-execution node (live dispatch session / HITL gate). Retry is a
  // deliberate re-open of a QUIESCENT subgraph; clobbering a live node would
  // orphan its dispatch task (tokens/cost keep flowing, the net-live
  // `sessionsSpawned` slot is never refunded) and leave a zombie
  // `onTaskTerminated` listener behind.
  const liveNodes: NodeRuntimeState[] = [];
  const consider = (n: NodeRuntimeState | undefined): void => {
    if (
      n &&
      (n.status === NodeStatus.Running || n.status === NodeStatus.Blocked) &&
      !liveNodes.includes(n)
    ) {
      liveNodes.push(n);
    }
  };
  consider(target);
  for (const id of downstream) consider(state.nodes.get(id));
  if (liveNodes.length > 0) {
    const names = liveNodes.map((n) => `"${n.nodeId}" (${n.status})`).join(", ");
    throw new Error(
      `cannot retry node "${nodeId}" in graph "${state.graphId}": ` +
        `live node(s) in the retry scope — ${names} — must be terminal ` +
        `(completed / escalated / timed out / cancelled / done); cancel first ` +
        `(graph_cancel) or wait for termination to avoid leaking the running ` +
        `dispatch session`,
    );
  }

  // Superseded dispatch task ids of the reset scope (M11, header note 6):
  // every node reset below had its previous task id cleared — capture them so
  // the engine layer can unregister the matching onTaskTerminated listeners.
  const supersededTaskIds: string[] = [];

  // Reset every downstream node that may carry stale run state. Terminal nodes
  // (completed / escalate / timeout / cancelled / done) and any pending/ready
  // node from a prior activation are all dropped back to `pending`.
  for (const id of downstream) {
    const node = state.nodes.get(id);
    if (!node) continue;
    if (node.dispatchTaskId) supersededTaskIds.push(node.dispatchTaskId);
    resetNodeRun(node);
    clearSignalLedgerEntry(state, id);
    const downstreamPrevStatus = node.status;
    node.status = NodeStatus.Pending;
    recordCheckpointForNode(state, node, downstreamPrevStatus, NodeStatus.Pending, Date.now());
    removeFromFrontier(state, id);
  }

  // 2. Reset the target: clean run artifacts, prepend modify_prompt, re-ready.
  if (target.dispatchTaskId) supersededTaskIds.push(target.dispatchTaskId);
  resetNodeRun(target);
  clearSignalLedgerEntry(state, nodeId);
  if (opts?.modifyPrompt && opts.modifyPrompt.trim().length > 0) {
    const block = `${opts.modifyPrompt.trim()}\n\n`;
    // M11 replace-style dedup (header note 7): re-applying the SAME
    // modify_prompt must not accumulate. When the block is already the prompt
    // prefix, the injection is a no-op — N identical injections == 1, so
    // repeated retries never grow the prompt unboundedly.
    if (!target.prompt.startsWith(block)) {
      target.prompt = `${block}${target.prompt}`;
    }
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
    markDirty(state);
  }

  return {
    target: nodeId,
    reset: [nodeId, ...downstream],
    ready: [nodeId],
    supersededTaskIds,
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

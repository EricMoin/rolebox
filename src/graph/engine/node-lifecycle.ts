/**
 * Graph Execution Engine v2 — Generic Node Lifecycle State Machine
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Every node in the graph follows this single generic lifecycle. There are NO
 * per-type state machines — no branching on node agent, prompt, or role. Node
 * identity is an `{agent, prompt}` tuple, and its semantics emerge purely from
 * that tuple; the state machine itself only ever reads `NodeRuntimeState.status`.
 *
 *  Lifecycle:
 *
 *     pending → ready → running → completed → done
 *                  │        │            │
 *                  │        ├──→ escalate → done (error)
 *                  │        ├──→ timeout → done (error)
 *                  │        ├──→ cancelled → done
 *                  │        └──→ blocked (needs_approval) → completed (approve)
 *                  │               └──→ ready (reject, revision feedback)
 *                  │                    └──→ escalate (reject, no loop group)
 *                  └──→ cancelled → done
 *                  completed → ready  (revise-driven loop re-entry)
 *
  *  `completed → ready` is the loop-group re-entry edge: when a convergence
   *  node emits `revise_needed` with findings, failed upstream nodes re-enter
   *  `ready` (bounded by the loop-group `max_traversals` counter). See
   *  `.rolebox/design/orchestration-patterns.md` §1.6.
   *
 *  `completed → escalate` is the revision-cap edge: when a reviewer completes
 *  its `revise_needed` pass but the loop group's `max_traversals` is already
 *  exhausted, the revision escalates instead of looping (failure-resilience.md
 *  §1.6). `escalate → ready` is the automatic-retry edge: an escalating node
 *  re-enters `ready` for a retry when an outbound edge declares `retry: N > 0`
 *  and `retryCount < N` (graph-model.md §5.3). `pending → escalate` is the
 *  cascade-abort edge: a node that never started is escalated by an escalation
 *  cascading into its convergence node, so it stops blocking termination.
 *
 *  Pause path (Phase 3):  running → blocked (needs_approval), then
 *    blocked → completed (approve), blocked → ready (reject, revision feedback
 *    re-entry), or blocked → escalate (reject with no loop group).
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §2.
 * NodeStatus vocabulary: `src/constants.ts` (`NodeStatus`, lines 183-198).
 */

import { NodeStatus } from "../../constants.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import { recordCheckpointForNode } from "./recorder.ts";
import { markDirty } from "./engine-persistence.ts";

// ── Transition table ───────────────────────────────────────────────────────

/**
 * Valid transitions for the generic node lifecycle. All nodes share this one
 * table — the transition legality is a pure function of `(from, to)` and never
 * consults `agent`, `prompt`, or `needsApproval`.
 */
const VALID_NODE_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  // Normal path
  pending: [NodeStatus.Ready, NodeStatus.Cancelled, NodeStatus.Escalate],
  ready: [NodeStatus.Running, NodeStatus.Cancelled],
  running: [
    NodeStatus.Completed,
    NodeStatus.Escalate,
    NodeStatus.Timeout,
    NodeStatus.Cancelled,
    NodeStatus.Blocked,
  ],
  completed: [NodeStatus.Done, NodeStatus.Ready, NodeStatus.Escalate],
  // Pause path (approval mechanics are Phase 3 — see markNodeBlocked).
  // `blocked → escalate` is the reject-with-no-loop-group lane (Phase 3):
  // when a human rejects a `needs_approval` node that has no loop group to
  // re-open, the rejection escalates instead of re-entering `ready`.
  blocked: [NodeStatus.Completed, NodeStatus.Ready, NodeStatus.Escalate],
  // Error / cancel paths converge on the terminal `done` state
  timeout: [NodeStatus.Done],
  escalate: [NodeStatus.Done, NodeStatus.Ready],
  cancelled: [NodeStatus.Done],
  // Terminal — no further transitions
  done: [],
};

/** Whether `from → to` is a legal node-lifecycle transition. */
export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return VALID_NODE_TRANSITIONS[from].includes(to);
}

/**
 * Throw unless `from → to` is a legal node-lifecycle transition.
 */
export function assertValidNodeTransition(
  from: NodeStatus,
  to: NodeStatus,
): void {
  if (!canTransitionNode(from, to)) {
    throw new Error(`Invalid node transition: ${from} -> ${to}`);
  }
}

// ── Transition options ──────────────────────────────────────────────────────

/** Optional metadata carried into a transition. */
export interface TransitionOptions {
  /** Dispatch task ID (set when a node enters `running`). */
  dispatchTaskId?: string;
  /** Dispatch session ID (set when a node enters `running`). */
  dispatchSessionId?: string;
  /** Materialized result ref (set when a node becomes `completed`). */
  result?: NodeRuntimeState["result"];
  /** Error reason (set for `escalate` / `timeout` / error `done`). */
  errorReason?: string;
}

// ── Transition core ─────────────────────────────────────────────────────────

/**
 * Apply a node status transition after validating it against the generic
 * transition table. Illegal transitions throw. Performs status-coupled
 * bookkeeping (spawn counters, task ids, timing) along the way.
 */
export function transitionNode(
  state: EngineState,
  node: NodeRuntimeState,
  to: NodeStatus,
  opts: TransitionOptions = {},
): NodeRuntimeState {
  assertValidNodeTransition(node.status, to);
  const now = Date.now();
  const from = node.status;

  // ready → running: a dispatch is spawned
  if (node.status === NodeStatus.Ready && to === NodeStatus.Running) {
    node.sessionsSpawned += 1;
    if (opts.dispatchTaskId) {
      node.dispatchTaskId = opts.dispatchTaskId;
    }
    if (opts.dispatchSessionId) {
      node.dispatchSessionId = opts.dispatchSessionId;
    }
    node.startedAt = now;
  }

  // running → completed: the node produced a result
  if (to === NodeStatus.Completed) {
    node.completedAt = now;
    if (opts.result) {
      node.result = opts.result;
    }
  }

  if (opts.errorReason !== undefined) {
    node.errorReason = opts.errorReason;
  }

  node.status = to;
  if (state) markDirty(state);

  // Auto-save a lifecycle checkpoint on every status change (subtask C-RECORD).
  // Fires for every transition because ALL convenience transitions funnel
  // through this single choke point. No-ops when state is falsy (standalone
  // construction without an engine) — nothing is fabricated.
  recordCheckpointForNode(state, node, from, to, now);

  return node;
}

/**
 * Transition a node into the `blocked` (needs_approval) state.
 *
 * A blocked node awaits human approval before it can continue its lifecycle.
 * The engine pauses graph advancement for this node's downstream subgraph
 * until a `graph_approve` call resolves or rejects the block.
 */
export function markNodeBlocked(state: EngineState, node: NodeRuntimeState): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Blocked);
}

// ── Convenience transitions ────────────────────────────────────────────────

/** pending → ready. */
export function markReady(state: EngineState, node: NodeRuntimeState): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Ready);
}

/** ready → running, recording the dispatch ids. */
export function markRunning(
  state: EngineState,
  node: NodeRuntimeState,
  opts: Pick<TransitionOptions, "dispatchTaskId" | "dispatchSessionId"> = {},
): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Running, opts);
}

/** running → completed. */
export function markCompleted(
  state: EngineState,
  node: NodeRuntimeState,
  opts: Pick<TransitionOptions, "result"> = {},
): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Completed, opts);
}

/** running → escalate, with a required error reason. */
export function markEscalated(
  state: EngineState,
  node: NodeRuntimeState,
  errorReason: string,
): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Escalate, { errorReason });
}

/** running → timeout, with an optional error reason. */
export function markTimedOut(
  state: EngineState,
  node: NodeRuntimeState,
  errorReason?: string,
): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Timeout, { errorReason });
}

/** pending | ready | running → cancelled. */
export function markCancelled(
  state: EngineState,
  node: NodeRuntimeState,
  errorReason?: string,
): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Cancelled, { errorReason });
}

/** escalate | timeout | cancelled | completed → done. */
export function markDone(
  state: EngineState,
  node: NodeRuntimeState,
  errorReason?: string,
): NodeRuntimeState {
  return transitionNode(state, node, NodeStatus.Done, { errorReason });
}

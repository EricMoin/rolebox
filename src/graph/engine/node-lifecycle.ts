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
import type { NodeRuntimeState } from "../../types.engine-v2.ts";
import { recordCheckpointForNode } from "./recorder.ts";

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

  // Auto-save a lifecycle checkpoint on every status change (subtask C-RECORD).
  // Fires for every transition because ALL convenience transitions funnel
  // through this single choke point. No-ops when the node is not bound to an
  // engine state (standalone construction) — nothing is fabricated.
  recordCheckpointForNode(node, from, to, now);

  return node;
}

// ── Phase-3 pause stub ─────────────────────────────────────────────────────

/**
 * Stub: transition a running node into the `blocked` (needs_approval) state.
 *
 * TODO(Phase 3): Full `needs_approval` pause mechanics are not implemented in
 * Phase 1. The complete flow — dispatch the node with a pause-capable prompt,
 * have the worker emit `signal(type="need_approval")`, pause graph advancement
 * for this node's downstream subgraph, then resume via `dispatch_approve`
 * (→ `completed`) or `dispatch_reject` (→ `ready` for retry) — is deferred to
 * Phase 3 (see `.rolebox/design/engine-state-machine.md` §2.2 `blocked` and
 * `src/constants.ts` `NodeStatus.Blocked`). Today this only records the state
 * transition so the `blocked` status is representable.
 */
export function markNodeBlocked(node: NodeRuntimeState): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Blocked);
}

// ── Convenience transitions ────────────────────────────────────────────────

/** pending → ready. */
export function markReady(node: NodeRuntimeState): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Ready);
}

/** ready → running, recording the dispatch ids. */
export function markRunning(
  node: NodeRuntimeState,
  opts: Pick<TransitionOptions, "dispatchTaskId" | "dispatchSessionId"> = {},
): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Running, opts);
}

/** running → completed. */
export function markCompleted(
  node: NodeRuntimeState,
  opts: Pick<TransitionOptions, "result"> = {},
): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Completed, opts);
}

/** running → escalate, with a required error reason. */
export function markEscalated(
  node: NodeRuntimeState,
  errorReason: string,
): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Escalate, { errorReason });
}

/** running → timeout, with an optional error reason. */
export function markTimedOut(
  node: NodeRuntimeState,
  errorReason?: string,
): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Timeout, { errorReason });
}

/** pending | ready | running → cancelled. */
export function markCancelled(
  node: NodeRuntimeState,
  errorReason?: string,
): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Cancelled, { errorReason });
}

/** escalate | timeout | cancelled | completed → done. */
export function markDone(
  node: NodeRuntimeState,
  errorReason?: string,
): NodeRuntimeState {
  return transitionNode(node, NodeStatus.Done, { errorReason });
}

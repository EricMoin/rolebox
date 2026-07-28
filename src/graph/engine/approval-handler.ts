/**
 * Graph Execution Engine v2 — Approval Handler
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Pure state-mutation primitives for the `needs_approval` (human-in-the-loop)
 * gate lifecycle. When a `needs_approval` node pauses in the `blocked` state,
 * the human resumes it one of three ways (orchestration-patterns.md §1.3/§1.5):
 *
 * - {@link approveBlockedNode}  — approve → `blocked → completed`; the engine
 *   records an `answer` signal and returns the {@link EdgePayload} so the
 *   caller's forward-data-flow step activates the downstream `on_signal
 *   (answer)` / `always` edges.
 * - {@link rejectBlockedNode}   — reject → `blocked → ready` (re-enter with the
 *   rejection feedback merged into the node's re-execution prompt), or
 *   `blocked → escalate` when there is no loop group to absorb the rejection.
 * - {@link pruneDownstreamSubgraph} + rejected-upstream re-entry — partial
 *   approve → cancel the rejected branches' transitive dependents and re-enter
 *   the rejected upstream nodes `ready` with feedback, so the surviving graph
 *   re-runs only the deltas (orchestration-patterns.md §1.5).
 *
 * These primitives are **pure state-mutation steps**, mirroring the
 * signal-propagation conventions: they mutate node lifecycle status and the
 * frontier only, and never dispatch. Dispatch of re-entered-`ready` nodes (and
 * any downstream activation) is the caller's job (the advance engine's
 * `_dispatchReadyNodes`). Cancellation of pruned nodes touches a
 * `CancelDispatchPort` seam (optional) — structurally satisfied by the
 * `NodeDispatchPort` cancel seam (`engine-advance.ts`).
 *
 * Design references:
 * - `.rolebox/design/orchestration-patterns.md` §1.3 (approval lifecycle),
 *   §1.5 (partial-approval pruning).
 */

import { JoinStrategy, NodeStatus } from "../../constants.ts";
import type { EdgePayload, EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import {
  canTransitionNode,
  markCompleted,
  markDone,
  markCancelled,
  markEscalated,
  markReady,
} from "./node-lifecycle.ts";
import {
  getJoinStrategy,
  getUpstreamNodeIds,
  joinSatisfied,
} from "./join-evaluator.ts";
import { addToFrontier, removeFromFrontier } from "./engine-state.ts";
import type { CancelDispatchPort } from "./cascade-canceller.ts";

// ── Report shapes ───────────────────────────────────────────────────────────

/** Result of {@link rejectBlockedNode}. */
export interface RejectReport {
  /** Which lane the rejection took. */
  kind: "escalate" | "revise" | "already_resolved";
  /**
   * When `kind === "already_resolved"`, the actual node status at the time of
   * the no-op reject (e.g. Completed, Escalate, Done). Absent for genuine
   * rejection lanes.
   */
  actualStatus?: NodeStatus;
}

/** Result of {@link pruneDownstreamSubgraph}. */
export interface PruneReport {
  /** Nodes cancelled (transitively dependent on rejected results, cannot survive). */
  cancelled: string[];
  /** Downstream nodes that survive on their remaining approved upstream sources. */
  surviving: string[];
}

/** Result of {@link reenterRejectedUpstreams}. */
export interface ReentryReport {
  /** Rejected upstream nodes re-marked `ready` and added to the frontier. */
  reEntered: string[];
}

// ── Feedback merging ────────────────────────────────────────────────────────

/**
 * Append rejection feedback to a node's re-execution prompt so the re-run sees
 * why it was rejected. Returns the prompt unchanged when there is no reason.
 */
export function mergeRejectionFeedback(prompt: string, reason?: string): string {
  const text = reason?.trim();
  if (!text) return prompt;
  return `${prompt}\n\n[Rejection feedback]:\n${text}`;
}

// ── Approve primitive ───────────────────────────────────────────────────────

/**
 * Resolve an approval: transition the blocked node to `completed` and record an
 * `answer` signal for it, returning the {@link EdgePayload} the caller should
 * route downstream along the `answer` lane.
 *
 * - The approval's payload (the agent-rendered summary from the `need_approval`
 *   signal, or the caller-provided payload) becomes the node's `answer` output.
 * - `blocked → completed` (completed is a legal blocked exit) marks the node
 *   terminal-success and lets downstream `on_signal(answer)` / `always` edges
 *   activate via the caller's forward-data-flow step.
 *
 * @returns The downstream {@link EdgePayload}, or `null` when the node was not
 *   actually `blocked` (a no-op guard — approve is idempotent).
 */
export function approveBlockedNode(
  state: EngineState,
  node: NodeRuntimeState,
  payload?: unknown,
): EdgePayload | null {
  if (node.status !== NodeStatus.Blocked) return null;

  // Derive the answer output from the caller payload, else the agent-rendered
  // `need_approval` summary, else a plain accept marker.
  const raw = node.signalsObserved["need_approval"];
  const answerOutput =
    payload !== undefined
      ? payload
      : typeof raw === "string" && raw.length > 0
        ? raw
        : "approved";

  node.signalsObserved.answer = answerOutput;
  markCompleted(state, node);

  const tc = node.tokensConsumed;
  return {
    fromNode: node.nodeId,
    fromSignal: "answer",
    result: typeof answerOutput === "string"
      ? answerOutput
      : JSON.stringify(answerOutput ?? ""),
    artifacts: [],
    budgetConsumed: {
      tokens: tc.inputTokens + tc.outputTokens,
      cost: tc.cost,
      sessions: node.sessionsSpawned,
    },
  };
}

// ── Reject primitive ────────────────────────────────────────────────────────

/**
 * Resolve a rejection on a blocked `needs_approval` node.
 *
 * - No loop group → the rejection has nowhere to re-enter; the node escalates
 *   with the rejection reason (`blocked → escalate`, added Phase 3). This keeps
 *   the graph from proceeding with un-reviewed changes (safety-first timeout /
 *   reject behavior, §1.3).
 * - Loop group present → the node re-enters `ready` (blocked → ready) with the
 *   rejection feedback merged into its re-execution prompt, so it (and the loop
 *   that feeds it) re-runs. Callers that want the loop group's upstream nodes
 *   re-entered as well reuse `propagateRevise` (signal-propagation.ts) on the
 *   feeding convergence node.
 *
 * Pure state mutation — never dispatches. Re-entered-`ready` nodes are added to
 * the frontier for the caller's `_dispatchReadyNodes` step.
 *
 * @returns {@link RejectReport} describing the lane taken.
 */
export function rejectBlockedNode(
  state: EngineState,
  node: NodeRuntimeState,
  reason?: string,
): RejectReport {
  if (node.status !== NodeStatus.Blocked) {
    // Idempotent guard: replaying a reject on an already-resolved node is a
    // no-op. Return an accurate `actualStatus` so callers can distinguish a
    // genuine rejection from a stale replay.
    return { kind: "already_resolved", actualStatus: node.status };
  }

  const reasonText = typeof reason === "string" && reason.trim() ? reason.trim() : "rejected";
  node.signalsObserved.revise_needed = reasonText;

  if (!node.loopGroupId) {
    markEscalated(state, node, reasonText);
    removeFromFrontier(state, node.nodeId);
    return { kind: "escalate" };
  }

  node.prompt = mergeRejectionFeedback(node.prompt, reasonText);
  markReady(state, node);
  addToFrontier(state, node.nodeId);
  return { kind: "revise" };
}

// ── Partial-approve primitives ──────────────────────────────────────────────

/**
 * Phase 1 + Phase 2 of the partial-approval algorithm (orchestration-patterns.md
 * §1.5): find every node transitively downstream of a rejected upstream branch
 * and cancel those that cannot survive on their remaining approved sources
 * alone.
 *
 * - Phase 1 BFS: collect nodes transitively reachable from any rejected node
 *   along `always` / `on_signal(answer)` edges, excluding the approval node
 *   itself (it stays put to re-render).
 * - Phase 2: for each downstream node, cancel it when it has no surviving
 *   approved upstream, or when its join cannot be met by approved sources alone
 *   (`all` needs every feeder; `quorum:N` needs N). `any` joins survive on a
 *   single approved source. Nodes that depend on a mix of approved + rejected
 *   upstream are **not** cancelled — they enter a partial-await and re-join once
 *   the rejected source re-executes and re-answers (§1.5 rule 2).
 *
 * Cancelled nodes transition `pending | ready | running → cancelled → done`
 * (reusing the cascade-canceller lifecycle pattern) and, when a cancel seam is
 * present, their dispatch tasks are torn down fire-and-forget (never awaited).
 *
 * @param rejectedNodeIds   Upstream branches the human rejected.
 * @param approvalNodeId    The `needs_approval` node issuing the partial verdict.
 * @param dispatchPort      Optional cancellation seam (task teardown).
 */
export function pruneDownstreamSubgraph(
  state: EngineState,
  rejectedNodeIds: string[],
  approvalNodeId: string,
  dispatchPort?: CancelDispatchPort,
): PruneReport {
  const rejected = new Set(rejectedNodeIds);
  if (rejected.size === 0) return { cancelled: [], surviving: [] };

  // Precondition guard: pruning only makes sense when the approval node is
  // indeed a `needs_approval` gate. A non-gate node has no human-decision
  // lifecycle and partial-approval semantics do not apply — return early
  // with an empty result to avoid corrupting the graph.
  const approvalNode = state.nodes.get(approvalNodeId);
  if (!approvalNode || !approvalNode.needsApproval) {
    return { cancelled: [], surviving: [] };
  }

  // ── Phase 1: transitive downstream of every rejected node ─────────────────
  const downstream = new Set<string>();
  const queue = [...rejected];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of state.graphDeclaration.edges) {
      if (edge.from !== current) continue;
      // Only answer-forward lanes carry a rejected branch's effect downstream.
      const activates =
        edge.type === "always" ||
        (edge.type === "on_signal" && (edge.signal_filter ?? []).includes("answer"));
      if (!activates) continue;
      if (edge.to === approvalNodeId) continue; // approval node re-renders, not cancelled
      if (downstream.has(edge.to)) continue;
      downstream.add(edge.to);
      queue.push(edge.to);
    }
  }

  // ── Phase 2: cancel nodes that cannot survive on approved sources alone ────
  const cancelled: string[] = [];
  const surviving: string[] = [];

  for (const nodeId of downstream) {
    const node = state.nodes.get(nodeId);
    if (!node) continue;

    // Approved upstreams = feeders not in the rejected set (topology view — a
    // still-pending approved feeder may yet answer).
    const upstreamIds = getUpstreamNodeIds(state, node);
    const approvedCount = upstreamIds.filter((id) => !rejected.has(id)).length;
    const strategy = getJoinStrategy(state, node);

    if (shouldCancel(approvedCount, upstreamIds.length, strategy)) {
      cancelNode(state, node, dispatchPort);
      cancelled.push(nodeId);
    } else {
      surviving.push(nodeId);
    }
  }

  return { cancelled, surviving };
}

/**
 * Whether a downstream node must be cancelled given its surviving approved
 * upstream count. Mirrors §1.5 Phase 2: zero approved sources, an `all` join
 * (a rejected feeder exists, so "all" can never be met from approved alone), or
 * a `quorum:N` that can no longer be reached. `any` survives on one approved
 * source.
 */
function shouldCancel(
  approvedCount: number,
  upstreamTotal: number,
  strategy: ReturnType<typeof getJoinStrategy>,
): boolean {
  if (upstreamTotal === 0) return false;
  if (approvedCount === 0) return true;
  if (strategy === JoinStrategy.All) return true;
  if (typeof strategy === "object" && "quorum" in strategy) {
    return approvedCount < strategy.quorum;
  }
  // "any" — at least one approved source survives.
  return false;
}

/**
 * Re-enter the rejected upstream nodes `ready` with the rejection feedback so
 * they re-execute and re-answer, which re-satisfies the approval node's join.
 * Only nodes currently transitionable to `ready` are re-entered (completed →
 * ready; never a still-running or terminal node).
 */
export function reenterRejectedUpstreams(
  state: EngineState,
  rejectedNodeIds: string[],
  reason?: string,
): ReentryReport {
  const report: ReentryReport = { reEntered: [] };
  for (const nodeId of rejectedNodeIds) {
    const node = state.nodes.get(nodeId);
    if (!node || !canTransitionNode(node.status, NodeStatus.Ready)) continue;
    node.prompt = mergeRejectionFeedback(node.prompt, reason);
    markReady(state, node);
    addToFrontier(state, nodeId);
    report.reEntered.push(nodeId);
  }
  return report;
}

/**
 * Clear the rejected sources from an approval node's accumulated upstream
 * results and recompute its join satisfaction, so the approval node re-waits
 * for the rejected branches to re-execute and re-answer before it re-renders.
 * Returns the recomputed join verdict via `node.joinSatisfied`.
 */
export function resetRejectedUpstreams(
  state: EngineState,
  node: NodeRuntimeState,
  rejectedNodeIds: string[],
): void {
  for (const id of rejectedNodeIds) {
    node.upstreamResults.delete(id);
  }
  node.joinSatisfied = joinSatisfied(state, node);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Cancel a node's lifecycle (`pending | ready | running → cancelled → done`) and,
 * when a cancel seam is present and the node carries a dispatch task, tear it
 * down fire-and-forget (never awaited). Reuses the cascade-canceller convention.
 */
function cancelNode(
  state: EngineState,
  node: NodeRuntimeState,
  dispatchPort?: CancelDispatchPort,
): void {
  if (!canTransitionNode(node.status, NodeStatus.Cancelled)) return;
  markCancelled(state, node, `cancelled by partial-approval pruning at "${state.graphId}"`);
  markDone(state, node);
  removeFromFrontier(state, node.nodeId);
  if (dispatchPort?.cancelTask && node.dispatchTaskId) {
    void dispatchPort.cancelTask(node.dispatchTaskId);
  }
}

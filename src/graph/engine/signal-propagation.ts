/**
 * Graph Execution Engine v2 — Signal Propagation
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * The two propagation half of the engine's advancement algorithm (steps 4a
 * and 4b in `engine-advance.ts`), complementing the forward data flow that
 * runs on `answer`. Whereas `answer` flows *down* along edges to activate
 * downstream joins, failure signals travel the other two lanes:
 *
 * - {@link propagateRevise} — a convergence node emits `revise_needed`; the
 *   revision feedback is routed *back* along the loop group's
 *   `on_signal(revise_needed)` back-edges so the offending upstream nodes
 *   re-enter `ready`, bounded by the loop group's `max_traversals` counter.
 *   When the cap is reached (or there is no loop group), the revision
 *   *escalates* instead of looping.
 *
 * - {@link propagateEscalate} — a node signals `escalate`; the worst signal
 *   (escalate > revise_needed > answer, graph-model.md §5.1) travels *forward*
 *   along outbound edges to the nearest fan-in convergence node. Each outbound
 *   edge's `retry` policy is consulted: `retry: N > 0` re-marks the source
 *   node `ready` for an automatic retry (bounded by `retryCount`); otherwise
 *   the escalation lands on the convergence node, whose join re-evaluates and
 *   fails → that node escalates too, and the walk continues. Single-input
 *   (non-convergence) nodes are transparent pass-throughs.
 *
 * Both functions are **pure state-mutation** steps. They mutate node lifecycle
 * status and the frontier only — they never dispatch. Dispatch of the
 * re-marked-ready nodes is done by the caller's existing `_dispatchReadyNodes`
 * step (which also applies the budget pre-check before each dispatch). This
 * keeps the propagation logic free of I/O and easy to test in isolation.
 *
 * Design references:
 * - `.rolebox/design/graph-model.md` §4 (bounded-cycle loops), §5.1 (signal
 *   escalation lattice), §5.3 (retry as an edge property)
 * - `.rolebox/design/failure-resilience.md` §1.5 (join failure), §1.6 (loop
 *   traversal exhaustion), §2 (propagation rules), §4 (bounded-cycle exit)
 * - `.rolebox/design/orchestration-patterns.md` §1.6 (bounded-cycle loop
 *   groups, revise-driven re-dispatch)
 */

import { NodeStatus } from "../../constants.ts";
import type {
  EdgePayload,
  EngineState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";
import type { EdgeDeclaration } from "../../types.graph-v2.ts";
import { addToFrontier, incrementLoopTraversal } from "./engine-state.ts";
import {
  canTransitionNode,
  markEscalated,
  markReady,
} from "./node-lifecycle.ts";
import {
  evaluateJoin,
  joinSatisfied,
  getUpstreamNodeIds,
} from "./join-evaluator.ts";

// ── Report ──────────────────────────────────────────────────────────────────

/**
 * What a propagation step did, for diagnostics and tests.
 *
 * The fields are intentionally separate so a single call can be inspected
 * precisely: which upstream nodes were re-marked `ready` (revise), which nodes
 * were escalated (exhaustion / join failure), which node was re-marked `ready`
 * for an automatic retry (escalate), where the escalation was absorbed, and
 * where it reached the graph root.
 */
export interface SignalPropagationReport {
  /** Which propagation lane ran: `revise` or `escalate`. */
  kind: "revise" | "escalate";
  /** (revise) Upstream nodes re-marked `ready` and added to the frontier. */
  revisedUpstream: string[];
  /** Nodes escalated by this propagation (traversal exhaustion / join failure). */
  escalated: string[];
  /** The escalating node that was re-marked `ready` for an automatic retry. */
  retried: string[];
  /** Escalation reached the graph root (graph will terminate with error). */
  rootReached: string[];
  /** Escalation absorbed — the convergence node's join is still satisfiable. */
  absorbed: string[];
  /** Machine-readable reason for an escalation (e.g. "max_traversals exhausted"). */
  reason?: string;
}

// ── Payload → text helpers ──────────────────────────────────────────────────

/** Best-effort short reason string from an `escalate` payload. */
function extractReason(payload: unknown): string {
  if (typeof payload === "string") return payload || "escalated";
  if (payload && typeof payload === "object") {
    const obj = payload as { reason?: unknown; error?: unknown; message?: unknown };
    if (typeof obj.reason === "string") return obj.reason;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return "escalated";
}

/** Best-effort human-readable revision feedback from a `revise_needed` payload. */
function revisionText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["findings", "verdict", "reason", "feedback", "review"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        return value.map((item) => `- ${item}`).join("\n");
      }
    }
    return JSON.stringify(payload);
  }
  return "";
}

/** Append revision feedback to a node's re-execution prompt for the given round. */
function mergeRevisionFeedback(
  prompt: string,
  round: number,
  payload: unknown,
): string {
  const text = revisionText(payload);
  if (!text) return prompt;
  return `${prompt}\n\n[Revision feedback — round ${round}]:\n${text}`;
}

// ── Revise propagation ──────────────────────────────────────────────────────

/**
 * Whether an edge acts as a `revise_needed` back-edge.
 *
 * Only `on_signal` edges whose filter names `revise_needed` qualify (design
 * graph-model.md §5.2, orchestration-patterns.md §1.6). `always` edges are
 * forward data-flow, not revision back-edges; `on_condition` edges are not
 * signal-routed and are out of scope for revision re-entry.
 */
function activatesOnRevise(edge: EdgeDeclaration): boolean {
  if (edge.type !== "on_signal") return false;
  return (edge.signal_filter ?? []).includes("revise_needed");
}

/**
 * Back-propagate a `revise_needed` signal from a convergence node into its
 * loop group.
 *
 * 1. No loop group → the revision has nowhere to re-enter; the node escalates
 *    with reason `no loop group`.
 * 2. Loop group present but `incrementLoopTraversal` is rejected
 *    (`traversalCount >= max_traversals`) → the `revise_needed` back-edge is
 *    deactivated (graph-model.md §4.2); the node escalates with reason
 *    `max_traversals exhausted`.
 * 3. Otherwise the traversal counter is incremented and every upstream target
 *    reachable via an `on_signal(revise_needed)` back-edge within the loop
 *    group re-enters `ready` (added to the frontier) with the revision feedback
 *    merged into its re-execution prompt. The caller's `_dispatchReadyNodes`
 *    step re-dispatches them (completed → ready is the loop re-entry edge,
 *    node-lifecycle.ts).
 *
 * The escalating node is expected to already be `completed` (the reviewing
 * pass finished); exhausting the cap flips it to `escalate`
 * (`completed → escalate`).
 */
export function propagateRevise(
  state: EngineState,
  node: NodeRuntimeState,
  payload: unknown,
): SignalPropagationReport {
  const report: SignalPropagationReport = {
    kind: "revise",
    revisedUpstream: [],
    escalated: [],
    retried: [],
    rootReached: [],
    absorbed: [],
  };

  const groupId = node.loopGroupId;
  if (!groupId) {
    escalateNode(node, "no loop group");
    report.reason = "no loop group";
    report.escalated.push(node.nodeId);
    return report;
  }

  if (!incrementLoopTraversal(state, groupId)) {
    escalateNode(node, "max_traversals exhausted");
    report.reason = "max_traversals exhausted";
    report.escalated.push(node.nodeId);
    return report;
  }

  // The current traversal round (1-based) for feedback labeling.
  const round = state.loopGroups.get(groupId)?.traversalCount ?? 1;

  for (const edge of state.graphDeclaration.edges) {
    if (edge.from !== node.nodeId) continue;
    if (!activatesOnRevise(edge)) continue;

    const target = state.nodes.get(edge.to);
    // Only targets inside the same loop group and in a state from which `ready`
    // is reachable are re-entered (completed / pending / blocked — never a
    // still-running or terminal node).
    if (!target || target.loopGroupId !== groupId) continue;
    if (!canTransitionNode(target.status, NodeStatus.Ready)) continue;

    target.prompt = mergeRevisionFeedback(target.prompt, round, payload);
    markReady(target);
    addToFrontier(state, edge.to);
    report.revisedUpstream.push(edge.to);
  }

  return report;
}

// ── Escalate propagation ────────────────────────────────────────────────────

/**
 * Whether `node` has any outbound edge whose `retry` policy allows another
 * automatic retry (retry is an edge property — graph-model.md §5.3). A single
 * retryable outbound edge is sufficient: the retried node re-runs and
 * re-emits along all its outbound edges.
 */
function findRetryEdge(
  state: EngineState,
  node: NodeRuntimeState,
): EdgeDeclaration | undefined {
  for (const edge of state.graphDeclaration.edges) {
    if (edge.from !== node.nodeId) continue;
    const retry = edge.retry;
    if (retry && retry.max > 0 && node.retryCount < retry.max) {
      return edge;
    }
  }
  return undefined;
}

/**
 * Propagate the worst signal (`escalate`) from an escalating node forward to
 * the nearest fan-in convergence node(s), per the signal escalation lattice
 * (graph-model.md §5.1) and retry policy (§5.3).
 *
 * 1. **Retry gate:** consult the node's outbound edges. If any declares
 *    `retry: N > 0` and `retryCount < N`, increment `retryCount` and re-mark
 *    the node `ready` (escalate → ready) so it re-runs — no upward
 *    propagation this round. Backoff/budget for the retry dispatch is handled
 *    by the caller's dispatch step (graph-model.md §6.3).
 * 2. **Forward propagation:** otherwise walk the node's outbound edges.
 *    Single-input (non-convergence) nodes are transparent pass-throughs.
 *    At the first multi-input fan-in node, record the `escalate` as an upstream
 *    result and re-evaluate its join:
 *      - join `failed` → that convergence node escalates too; the walk
 *        continues from it.
 *      - join `satisfied` / `waiting` → partial failure absorbed (`any` /
 *        `quorum` can still proceed); the walk stops on that branch.
 *    If the escalation reaches a node with no outbound edge (a graph sink),
 *    it has reached the end of the line — nothing further to abort.
 *
 * A still-satisfiable downstream join (absorption) is what keeps a partial
 * failure from misjudging the graph `complete`: the escalating node and any
 * join-failed convergence node are terminal, but a pending/running branch that
 * legitimately continues keeps the engine in `executing` (engine-advance's
 * `_checkTermination` guard).
 */
export function propagateEscalate(
  state: EngineState,
  node: NodeRuntimeState,
  payload: unknown,
): SignalPropagationReport {
  const report: SignalPropagationReport = {
    kind: "escalate",
    revisedUpstream: [],
    escalated: [],
    retried: [],
    rootReached: [],
    absorbed: [],
  };

  // 1. Retry gate — re-mark the source node ready for an automatic retry.
  if (findRetryEdge(state, node) && canTransitionNode(node.status, NodeStatus.Ready)) {
    node.retryCount += 1;
    node.prompt = `${node.prompt}\n\n[Automatic retry ${node.retryCount}]: previous attempt escalated — ${extractReason(payload)}`;
    markReady(node);
    addToFrontier(state, node.nodeId);
    report.retried.push(node.nodeId);
    return report;
  }

  // 2. Forward propagation toward the nearest fan-in convergence node(s).
  propagateEscalationForward(state, node, payload, report);
  return report;
}

/**
 * BFS over outbound edges, escalating join-failed convergence nodes and
 * stopping at absorbed ones. Single-input nodes pass through untouched.
 */
function propagateEscalationForward(
  state: EngineState,
  start: NodeRuntimeState,
  payload: unknown,
  report: SignalPropagationReport,
): void {
  const visited = new Set<string>([start.nodeId]);
  const queue: NodeRuntimeState[] = [start];

  while (queue.length > 0) {
    const current = queue.shift() as NodeRuntimeState;
    let advanced = false;

    for (const edge of state.graphDeclaration.edges) {
      if (edge.from !== current.nodeId) continue;
      const target = state.nodes.get(edge.to);
      if (!target || visited.has(target.nodeId)) continue;
      visited.add(target.nodeId);

      // Only multi-input fan-in nodes are escalation targets; single-input
      // nodes are transparent pass-throughs (kept pending so a partial
      // failure does not spuriously complete the graph).
      if (getUpstreamNodeIds(state, target).length <= 1) {
        queue.push(target);
        continue;
      }

      // Convergence node reached: record the escalate, re-evaluate its join.
      recordEscalate(state, target, current, payload);
      const verdict = evaluateJoin(state, target);
      if (verdict.kind === "failed") {
        if (canTransitionNode(target.status, NodeStatus.Escalate)) {
          markEscalated(target, extractReason(payload));
          report.escalated.push(target.nodeId);
          queue.push(target); // its failure may fail the next convergence node
          advanced = true;
        }
      } else {
        // satisfied / waiting → partial failure absorbed; this branch stops.
        report.absorbed.push(target.nodeId);
      }
    }
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Record an upstream `escalate` as an {@link EdgePayload} into a convergence
 * node's `upstreamResults` and recompute its join satisfaction, so the join
 * evaluator (and the cascade canceller, which reads `upstreamResults` to
 * distinguish resolved from cancellable sources) sees the failure.
 */
function recordEscalate(
  state: EngineState,
  target: NodeRuntimeState,
  source: NodeRuntimeState,
  payload: unknown,
): void {
  const edgePayload: EdgePayload = {
    fromNode: source.nodeId,
    fromSignal: "escalate",
    result: extractReason(payload),
    artifacts: [],
    budgetConsumed: {
      tokens: 0,
      cost: 0,
      sessions: source.sessionsSpawned,
    },
  };
  target.upstreamResults.set(source.nodeId, edgePayload);
  target.joinSatisfied = joinSatisfied(state, target);
}

/**
 * Escalate a node that has already finished its pass (e.g. a reviewer that
 * completed its `revise_needed` review, then hit the traversal cap). The
 * `completed → escalate` transition represents "revision rejected at the cap →
 * escalate". Guarded so replaying an already-escalated node is a no-op.
 */
function escalateNode(node: NodeRuntimeState, reason: string): void {
  if (canTransitionNode(node.status, NodeStatus.Escalate)) {
    markEscalated(node, reason);
  }
}

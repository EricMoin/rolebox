/**
 * Graph Execution Engine v2 — Join (Fan-In) Evaluator
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Pure graph-theoretic fan-in mechanism. A convergence node collects the
 * {@link EdgePayload}s arriving along its incoming edges and activates once
 * the declared join strategy is satisfied. What the node does with the merged
 * {@link FanInContext} (validate, synthesize, approve) is the agent's business —
 * this module only enforces the join and merges upstream data.
 *
 * Design references:
 * - `.rolebox/design/graph-model.md` §3 (join semantics)
 * - `.rolebox/design/orchestration-patterns.md` §1.1 (fan-in aggregation)
 *
 * All three join strategies are implemented at runtime: `all`, `any`, and
 * `quorum:N`. {@link joinSatisfied} exposes the compact boolean contract
 * (`true` iff satisfied); {@link evaluateJoin} exposes the full discriminated
 * verdict (`satisfied` | `failed` | `waiting`) with per-verdict reasons for
 * downstream diagnostics and cancellation decisions.
 */

import { JoinStrategy } from "../../constants.ts";
import type { JoinConfig } from "../../types.graph-v2.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import type { EdgePayload, FanInContext } from "../../types.engine-v2.ts";

// ── Join strategy resolution ────────────────────────────────────────────────

/**
 * Resolved join strategy, shared by both the per-node runtime field
 * (`NodeRuntimeState.joinStrategy`) and join evaluation.
 *
 * `'all'` | `{ quorum: number }` — see {@link resolveJoinStrategy}.
 */
export type ResolvedJoinStrategy = JoinStrategy | { quorum: number };

/**
 * Pure resolver that projects a node's declared {@link JoinConfig} into the
 * runtime join-strategy shape. Absent `join` (or `strategy: all`) resolves to
 * "all".
 *
 * `any` resolves to the `JoinStrategy.Any` string value; `quorum:N` resolves to
 * `{ quorum: N }` (the required count lives on the {@link JoinConfig}, not the
 * strategy string). The default quorum is `1`.
 *
 * This is THE single source of truth for the join-strategy shape: it is used
 * both to populate the runtime field in {@link registerNode} and, via
 * {@link getJoinStrategy}, to drive {@link evaluateJoin} / {@link joinSatisfied}
 * — so evaluation and the runtime field can never diverge.
 */
export function resolveJoinStrategy(join?: JoinConfig): ResolvedJoinStrategy {
  if (!join || join.strategy === JoinStrategy.All) {
    return JoinStrategy.All;
  }
  // `any` resolves to the strategy string value; evaluation decides when the
  // single-answer threshold is met.
  if (join.strategy === JoinStrategy.Any) {
    return JoinStrategy.Any;
  }
  // quorum:N — the quorum count lives on the JoinConfig, not the strategy string.
  return { quorum: join.quorum ?? 1 };
}

/**
 * The declared join strategy for a node, read from its {@link JoinConfig} in
 * the graph declaration.
 *
 * Thin wrapper that locates the node's declared config, then delegates to
 * {@link resolveJoinStrategy} — the same resolver that populates the node's
 * runtime `joinStrategy` field in {@link registerNode}. Keeping both paths on
 * one resolver guarantees they stay in lockstep.
 */
export function getJoinStrategy(
  state: EngineState,
  node: NodeRuntimeState,
): ResolvedJoinStrategy {
  const config = state.graphDeclaration.nodes.find((n) => n.id === node.nodeId);
  return resolveJoinStrategy(config?.join);
}

// ── Upstream topology ───────────────────────────────────────────────────────

/**
 * Distinct node IDs that feed `node` via its incoming edges.
 *
 * This is a pure topological fact derived from the graph declaration — every
 * edge with `to === node.nodeId` contributes its `from` source. A node with no
 * incoming edges returns an empty set (a graph root, satisfied immediately).
 */
export function getUpstreamNodeIds(state: EngineState, node: NodeRuntimeState): string[] {
  const upstream = new Set<string>();
  for (const edge of state.graphDeclaration.edges) {
    if (edge.to === node.nodeId) {
      upstream.add(edge.from);
    }
  }
  return [...upstream];
}

// ── Join satisfaction ───────────────────────────────────────────────────────

/**
 * Discriminated verdict of a join evaluation, produced by {@link evaluateJoin}.
 *
 * - `satisfied` — the join strategy's threshold has been met; the convergence
 *   node may activate and run its agent+prompt on the merged fan-in context.
 * - `failed` — the join cannot be (further) satisfied given the signals
 *   already received; the convergence node must propagate the worst observed
 *   upstream signal upward (see failure-resilience.md §1.5).
 * - `waiting` — neither satisfied nor failed; the node keeps accumulating
 *   upstream results until a future signal tips the balance.
 */
export type JoinVerdict =
  | { kind: "satisfied"; reasons: string[] }
  | { kind: "failed"; reasons: string[] }
  | { kind: "waiting"; reasons: string[] };

/** Aggregate of per-upstream signal counts over a node's incoming edges. */
interface JoinSignalCounts {
  /** Upstream sources that recorded an `answer` signal. */
  answerCount: number;
  /** Upstream sources that recorded a non-`answer` terminating signal. */
  failedCount: number;
  /** Upstream sources that have not recorded any payload yet. */
  pendingCount: number;
}

/** Count each upstream source's signal into one of the three buckets. */
function countSignals(
  upstream: string[],
  node: NodeRuntimeState,
): JoinSignalCounts {
  let answerCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  for (const sourceId of upstream) {
    const payload = node.upstreamResults.get(sourceId);
    if (!payload) {
      pendingCount += 1;
    } else if (payload.fromSignal === "answer") {
      answerCount += 1;
    } else {
      // escalate / revise_needed (any non-answer terminating signal).
      failedCount += 1;
    }
  }
  return { answerCount, failedCount, pendingCount };
}

/**
 * Evaluate a node's join strategy against its accumulated upstream results,
 * returning a full discriminated verdict (satisfied / failed / waiting).
 *
 * This is the evaluation half of fan-in, driven by the same signal counts and
 * escalation-lattice rules as the design references:
 * - `.rolebox/design/graph-model.md` §3.1 (join strategies)
 * - `.rolebox/design/failure-resilience.md` §1.5 (join-failure: partial failure
 *   at a convergence point)
 * - `.rolebox/design/orchestration-patterns.md` §1.1 (fan-in aggregation)
 *
 * Strategy semantics:
 * - No upstream edges → a graph root; satisfied immediately.
 * - `all` → satisfied when every upstream records `answer`; fails as soon as
 *   any upstream records a non-`answer` terminating signal (the worst signal is
 *   propagated); otherwise waiting.
 * - `any` → satisfied on the first upstream `answer`; fails only when every
 *   upstream has emitted a non-`answer` terminating signal before any `answer`
 *   arrived; otherwise waiting (a pending upstream may still answer).
 * - `quorum:N` → satisfied when `answer_count >= N`; fails when the quorum
 *   becomes impossible, i.e. `answer_count + pending_count < N`; otherwise
 *   waiting.
 */
export function evaluateJoin(
  state: EngineState,
  node: NodeRuntimeState,
): JoinVerdict {
  const strategy = getJoinStrategy(state, node);
  const upstream = getUpstreamNodeIds(state, node);
  const label = `join for node "${node.nodeId}"`;

  // A node with no upstream edges has nothing to wait on — immediately ready.
  if (upstream.length === 0) {
    return {
      kind: "satisfied",
      reasons: [`${label}: no upstream edges, join satisfied immediately`],
    };
  }

  const { answerCount, failedCount, pendingCount } = countSignals(
    upstream,
    node,
  );

  // quorum:N — need at least N answers; fail early if that becomes impossible.
  if (typeof strategy === "object" && "quorum" in strategy) {
    const n = strategy.quorum;
    if (answerCount >= n) {
      return {
        kind: "satisfied",
        reasons: [
          `${label}: quorum:${n} met (${answerCount}/${upstream.length} upstream answered)`,
        ],
      };
    }
    // Worst-case achievable answers = answered + still-pending. Below that,
    // quorum can never be reached → fail now rather than wait forever.
    if (answerCount + pendingCount < n) {
      return {
        kind: "failed",
        reasons: [
          `${label}: quorum:${n} impossible — ${answerCount} answered, ` +
            `${pendingCount} pending, ${failedCount} failed (max reachable ${answerCount + pendingCount} < ${n})`,
        ],
      };
    }
    return {
      kind: "waiting",
      reasons: [
        `${label}: quorum:${n} not yet met — ${answerCount} answered, ` +
          `${pendingCount} pending, ${failedCount} failed`,
      ],
    };
  }

  // any — proceed on the first answer; fail only when every upstream failed
  // before any answer could arrive.
  if (strategy === JoinStrategy.Any) {
    if (answerCount >= 1) {
      return {
        kind: "satisfied",
        reasons: [`${label}: "any" met — first upstream answer received`],
      };
    }
    // No answer yet. If every upstream has already failed, no future answer
    // can arrive → join failed.
    if (failedCount === upstream.length) {
      return {
        kind: "failed",
        reasons: [
          `${label}: "any" failed — all ${upstream.length} upstream(s) signaled ` +
            `escalate/revise before any answered`,
        ],
      };
    }
    return {
      kind: "waiting",
      reasons: [
        `${label}: "any" waiting — ${failedCount} upstream(s) failed, ` +
          `${pendingCount} still pending, none answered yet`,
      ],
    };
  }

  // all — need every upstream to answer; any failure aborts immediately.
  if (failedCount > 0) {
    return {
      kind: "failed",
      reasons: [
        `${label}: "all" failed — ${failedCount} upstream(s) signaled ` +
          `escalate/revise before all answered`,
      ],
    };
  }
  if (answerCount === upstream.length) {
    return {
      kind: "satisfied",
      reasons: [
        `${label}: "all" met — every upstream (${answerCount}/${upstream.length}) answered`,
      ],
    };
  }
  return {
    kind: "waiting",
    reasons: [
      `${label}: "all" waiting — ${answerCount}/${upstream.length} upstream(s) ` +
        `answered, ${pendingCount} still pending`,
    ],
  };
}

/**
 * Whether a node's join strategy is satisfied — i.e. the required upstream
 * results have been received under the declared strategy (all / any / quorum:N).
 *
 * This is a thin boolean projection of {@link evaluateJoin}: it returns `true`
 * exactly when the verdict is `satisfied`, and `false` for both `failed` and
 * `waiting`. The boolean contract is intentionally preserved so existing
 * callers (e.g. {@link collectUpstreamResults} caching `node.joinSatisfied`)
 * keep working unchanged; use {@link evaluateJoin} when the failed-vs-waiting
 * distinction matters.
 *
 * - No upstream edges → immediately satisfied (`true`).
 * - `all` → satisfied only when every upstream source recorded `answer`.
 * - `any` → satisfied on the first upstream `answer`.
 * - `quorum:N` → satisfied when at least N upstream sources recorded `answer`.
 *
 * Always returns a consistent `boolean` (strict `true`/`false`, never truthy).
 */
export function joinSatisfied(state: EngineState, node: NodeRuntimeState): boolean {
  return evaluateJoin(state, node).kind === "satisfied";
}

// ── Upstream result collection ──────────────────────────────────────────────

/**
 * Record an upstream {@link EdgePayload} into the node's accumulated results,
 * keyed by the source node ID (`edgePayload.fromNode`). After recording, the
 * node's cached `joinSatisfied` flag is recomputed so callers can rely on the
 * field without re-deriving topology each time.
 *
 * This is the aggregation half of fan-in: the advance engine calls this when an
 * `answer` signal arrives along an incoming edge, then queries
 * `node.joinSatisfied` to decide whether to activate the node.
 */
export function collectUpstreamResults(
  state: EngineState,
  node: NodeRuntimeState,
  edgePayload: EdgePayload,
): void {
  node.upstreamResults.set(edgePayload.fromNode, edgePayload);
  node.joinSatisfied = joinSatisfied(state, node);
}

// ── Fan-in context merge ────────────────────────────────────────────────────

/**
 * Merge a node's accumulated upstream results (a `Map<SourceNodeId, EdgePayload>`)
 * into a single structured {@link FanInContext} delivered as part of the node's
 * activation input.
 *
 * - `sources` — per-node provenance, in insertion order: `{node, signal, result}`.
 * - `merged_artifacts` — artifact paths from all sources, deduplicated in order
 *   of first appearance.
 * - `budget_consumed_total` — tokens / cost / sessions summed across sources.
 */
export function mergeFanInContext(
  results: ReadonlyMap<string, EdgePayload>,
): FanInContext {
  const sources: FanInContext["sources"] = [];
  const artifactSeen = new Set<string>();
  const mergedArtifacts: string[] = [];
  let tokens = 0;
  let cost = 0;
  let sessions = 0;

  for (const [fromNode, payload] of results) {
    sources.push({
      node: fromNode,
      signal: payload.fromSignal,
      result: payload.result,
    });

    for (const artifact of payload.artifacts) {
      if (!artifactSeen.has(artifact)) {
        artifactSeen.add(artifact);
        mergedArtifacts.push(artifact);
      }
    }

    tokens += payload.budgetConsumed.tokens;
    cost += payload.budgetConsumed.cost;
    sessions += payload.budgetConsumed.sessions;
  }

  return {
    sources,
    merged_artifacts: mergedArtifacts,
    budget_consumed_total: {
      tokens,
      cost,
      sessions,
    },
  };
}

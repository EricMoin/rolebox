/**
 * Graph Execution Engine v2 — Approval Payload Builder
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * When a `needs_approval: true` node enters the `blocked` state, the engine
 * assembles the node's upstream context into a structured {@link ApprovalPayload}.
 * This is a pure engine primitive — the engine renders whatever upstream results
 * the node has collected, regardless of what agent+prompt the node carries. The
 * approval rendering is an orchestration convention layered on top of this
 * structured context (orchestration-patterns.md §1.4).
 *
 * The payload carries:
 * - node identity + the node's own prompt (serves as the human's decision prompt)
 * - graph-scoped context totals (phase, completed-node count, cumulative budget)
 * - one `upstream_results` entry per incoming edge payload (per the fan-in
 *   results already accumulated on `node.upstreamResults`).
 *
 * Design reference: `.rolebox/design/orchestration-patterns.md` §1.4.
 */

import { NodeStatus } from "../../constants.ts";
import type {
  EdgePayload,
  EngineState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";

// ── Payload shape ───────────────────────────────────────────────────────────

/** Truncation length for each upstream result summary (design §1.4, 200 chars). */
const SUMMARY_LIMIT = 200;

/**
 * Structured context the engine assembles from a `needs_approval` node's
 * upstream results once it enters `blocked`. Shape mirrors
 * `.rolebox/design/orchestration-patterns.md` §1.4.
 */
export interface ApprovalPayload {
  /** Node ID from the graph declaration. */
  node_id: string;
  /** The node's prompt — serves as the decision prompt for the human. */
  node_prompt: string;
  /** ISO 8601 timestamp of assembly. */
  timestamp: string;

  // Graph context
  /** Graph name from the declaration. */
  graph_name: string;
  /** Current engine phase (idle / executing / complete). */
  phase: string;
  /** Count of nodes currently `completed` in the graph. */
  total_nodes_completed: number;
  /** Cumulative graph budget cost (USD). */
  total_cost_usd: number;
  /** Cumulative graph input tokens. */
  total_input_tokens: number;
  /** Cumulative graph output tokens. */
  total_output_tokens: number;

  // Upstream results (per incoming edge payload)
  upstream_results: ApprovalUpstreamResult[];
}

/** A single upstream source's contribution to the approval payload. */
export interface ApprovalUpstreamResult {
  from_node_id: string;
  /** The agent that produced this result. */
  from_agent: string;
  /** The signal that carried it (only `answer` edges reach a fan-in gate). */
  from_signal: string;
  /** First {@link SUMMARY_LIMIT} chars of the result text. */
  summary: string;
  /** Artifact file paths produced by the source node. */
  artifacts: string[];
  /** Budget consumed by the source node in producing this result. */
  budget_consumed: { tokens: number; cost: number; sessions: number };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Truncate a string to the summary limit, preserving the full text when shorter. */
function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_LIMIT) return text;
  return text.slice(0, SUMMARY_LIMIT);
}

/** Count nodes in the graph currently in the `completed` lifecycle state. */
function countCompletedNodes(state: EngineState): number {
  let count = 0;
  for (const node of state.nodes.values()) {
    if (node.status === NodeStatus.Completed) count += 1;
  }
  return count;
}

/** Render a single upstream {@link EdgePayload} into its payload shape. */
function renderUpstream(
  state: EngineState,
  fromNodeId: string,
  payload: EdgePayload,
): ApprovalUpstreamResult {
  const source = state.nodes.get(fromNodeId);
  return {
    from_node_id: fromNodeId,
    from_agent: source?.agent ?? "",
    from_signal: payload.fromSignal,
    summary: truncateSummary(payload.result),
    artifacts: [...payload.artifacts],
    budget_consumed: {
      tokens: payload.budgetConsumed.tokens,
      cost: payload.budgetConsumed.cost,
      sessions: payload.budgetConsumed.sessions,
    },
  };
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the structured {@link ApprovalPayload} for a `needs_approval` node from
 * its accumulated upstream results and the graph-level context.
 *
 * Pure function — no state mutation. Reads:
 * - `node.upstreamResults` (the fan-in results already collected for the node)
 * - `state.graphDeclaration.name`, `state.phase`, `state.budget`, `state.nodes`.
 *
 * The agent bound to the `needs_approval` node is expected to render this
 * structured context into the human-facing approval summary (§1.4 rendering
 * mechanism). This builder is engine behavior: it renders whatever upstream
 * results the node has collected, independent of agent/prompt.
 *
 * @param state The engine state (source of graph context + source-node agent ids).
 * @param node  The `needs_approval` node (typically in `blocked`).
 * @returns The assembled {@link ApprovalPayload}.
 */
export function buildApprovalPayload(
  state: EngineState,
  node: NodeRuntimeState,
): ApprovalPayload {
  const b = state.budget;
  const upstream_results: ApprovalUpstreamResult[] = [];
  for (const [fromNodeId, payload] of node.upstreamResults) {
    upstream_results.push(renderUpstream(state, fromNodeId, payload));
  }

  return {
    node_id: node.nodeId,
    node_prompt: node.prompt,
    timestamp: new Date().toISOString(),
    graph_name: state.graphDeclaration.name,
    phase: state.phase,
    total_nodes_completed: countCompletedNodes(state),
    total_cost_usd: b.totalCost,
    total_input_tokens: b.totalInputTokens,
    total_output_tokens: b.totalOutputTokens,
    upstream_results,
  };
}

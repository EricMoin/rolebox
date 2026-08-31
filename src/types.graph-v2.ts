/**
 * Graph Model v2 Type Definitions — rolebox Graph Execution Engine
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Central thesis: the graph engine is a role-agnostic primitive.
 * A node is nothing more than an {agent, prompt} tuple. Whether a node
 * functions as planner, implementer, reviewer, or approval gate is
 * entirely a property of the prompt and agent assigned by the
 * orchestrating topology designer.
 *
 * Design reference: .rolebox/design/graph-model.md
 */

import type { JoinStrategy, GraphTemplate } from "./constants.ts";

// ── Graph Declaration ───────────────────────────────────────────────────

/** Root declaration of a rolebox execution graph (v2 schema). */
export interface GraphDeclaration {
  /** Schema version — always 2 for this type */
  version: 2;
  /** Human-readable name for this graph */
  name: string;
  /**
   * Legacy collaboration provenance: the v1 topology shorthand (e.g.
   * "pipeline", "review-loop", "star") this graph was converted from, when
   * the declaration originates from a `collaboration:` config. Set ONLY by
   * `convertCollaborationToGraphDeclaration`; it is ignored by the graph
   * engine and is retained so the v2→v1 bridge can reproduce the exact
   * routing rendering the legacy parser produced. Absent for native v2 graphs.
   */
  template?: GraphTemplate;
  /**
   * Legacy collaboration provenance: the effective max-iteration cap the v1
   * parser would have assigned (explicit value clamped to ≥0, else 3 on a
   * cycle, else 0). Set ONLY by the converter so the v2→v1 bridge can
   * reproduce the legacy `ResolvedGraph.maxIterations` for acyclic graphs
   * (which carry no loop group to infer the cap from). Ignored by the engine.
   */
  max_iterations?: number;
  /** Graph-level resource budget (cumulative across all nodes) */
  budget?: GraphBudgetSpec;
  /** All nodes in the graph (order-independent — topology is defined by edges) */
  nodes: NodeConfig[];
  /** Directed edges defining data flow between nodes */
  edges: EdgeDeclaration[];
  /** Bounded-cycle loop groups (optional) */
  loop_groups?: LoopGroupDecl[];
  /** Graph-level termination conditions */
  termination?: TerminationDecl;
}

// ── Node Model ──────────────────────────────────────────────────────────

/**
 * Role-agnostic node configuration.
 *
 * Every node is defined by {id, agent, prompt} — there is no type field,
 * no role classification, no hardcoded node categories. Semantics emerge
 * entirely from the agent+prompt assigned by the orchestrating topology
 * designer.
 */
export interface NodeConfig {
  /** Unique identifier within the graph */
  id: string;
  /** Agent identifier (dispatchable subagent name, e.g. "emperor--jinyiwei--backend") */
  agent: string;
  /** Prompt text executed by the agent */
  prompt: string;
  /** Optional named condition from the condition vocabulary that marks the node complete */
  completion_condition?: string;
  /**
   * When true, the engine pauses at this node after execution for human approval.
   * Replaces the old `human_gate` node type — it is a pausing flag, not a node category.
   */
  needs_approval?: boolean;
  /** Fan-in strategy for convergence nodes (determines when all required upstream results are received) */
  join?: JoinConfig;
  /** Per-node resource budget */
  budget?: NodeBudgetSpec;
}

// ── Edge Model ──────────────────────────────────────────────────────────

/** Classification of edge activation semantics. */
export type EdgeType = "always" | "on_signal" | "on_condition";

/**
 * Directed edge between two nodes with signal-aware routing.
 *
 * Edges carry both structural and behavioral semantics. The edge model
 * is role-agnostic — edges are data-flow and signal-routing primitives
 * that operate uniformly regardless of node agent or prompt.
 */
export interface EdgeDeclaration {
  /** Source node ID */
  from: string;
  /** Target node ID */
  to: string;
  /**
   * Legacy collaboration provenance: the v1 flow-edge label (e.g. "loop",
   * "exit", "research findings"). Set ONLY by `convertCollaborationToGraphDeclaration`;
   * the engine ignores it, but the v2→v1 bridge reads it to reproduce the
   * legacy `ResolvedGraph.edges[].label`, which the v1 prompt/state builders
   * surface (e.g. buildGraphStateBlock's next-action label). Absent for
   * native v2 graphs.
   */
  label?: string;
  /** Edge activation semantics */
  type: EdgeType;
  /** When type is "on_signal", only these signal types activate the edge */
  signal_filter?: string[];
  /** When type is "on_condition", this named condition must evaluate true */
  condition?: string;
  /** Describes what subset of upstream data passes to downstream (default: full result) */
  data_passthrough?: DataMapping;
  /**
   * Retry policy on escalate.
   * Retry is an edge property, not a node property — it covers
   * automatic retries of BOTH incident nodes on escalate: its source
   * node, AND its target when the target itself escalates. The engine
   * honors `backoff_ms` between attempts, and an effective per-node
   * retry budget is resolved as the max of the node's own
   * `budget.max_retries` and the `retry.max` of its incident edges.
   */
  retry?: RetryConfig;
}

/** Specifies which data fields pass from upstream to downstream along an edge. */
export interface DataMapping {
  /** Field names to include in passthrough data (if empty, all fields pass through) */
  fields?: string[];
  /**
   * Field names to exclude from passthrough data. Removes any artifact path
   * whose name matches an excluded value, and (when the source result is
   * parseable JSON) drops the matching top-level keys from the JSON.
   */
  exclude?: string[];
  /** Truncate the downstream `result` to at most N characters. */
  maxChars?: number;
}

/** Retry configuration embedded on an edge. */
export interface RetryConfig {
  /** Maximum number of automatic retries per incident node on escalate */
  max: number;
  /** Backoff in milliseconds between retries */
  backoff_ms?: number;
}

// ── Join Model ──────────────────────────────────────────────────────────

/**
 * Fan-in (convergence) configuration for nodes with multiple upstream edges.
 *
 * Convergence is a pure graph-theoretic mechanism. The join strategy
 * determines when all required upstream results are received. What the
 * node does with the merged input (validate, synthesize, approve) is
 * the agent's business — the engine only enforces the join.
 */
export interface JoinConfig {
  /**
   * Strategy for determining when all required upstream results are received.
   * - "all": wait for every upstream to signal answer
   * - "any": proceed as soon as one upstream signals answer
   * - "quorum": proceed when N upstreams signal answer
   */
  strategy: JoinStrategy;
  /** Number of required answers when strategy is "quorum" (N in quorum:N) */
  quorum?: number;
}

// ── Loop Group ──────────────────────────────────────────────────────────

/**
 * Session-isolation mode for a loop group's rounds.
 *
 * The engine's loop rounds re-dispatch members within the SAME engine state
 * (propagateRevise increments `traversalCount` on the shared node, see
 * `src/graph/engine/loop-group-executor.ts`), so rounds are inherently
 * inherit-flavored. `fresh` per-round session isolation is NOT wired in the
 * engine — requesting it returns a documented-unsupported error, never a
 * silent no-op.
 */
export type LoopMode = "inherit" | "fresh";

/**
 * Bounded-cycle loop group declaration.
 *
 * The graph remains fundamentally a DAG; cycles are contained within
 * explicitly declared loop groups. Each loop group has a hard max-traversal
 * cap and optional early-exit termination conditions.
 */
export interface LoopGroupDecl {
  /** Unique identifier for this loop group */
  id: string;
  /** Node IDs that participate in the loop */
  nodes: string[];
  /** Hard cap on the number of cycle traversals (prevents infinite loops) */
  max_traversals: number;
  /** Early-exit termination conditions */
  termination?: TerminationDecl;
  /**
   * Session-isolation mode for this loop group's rounds. `inherit` (the only
   * real mode) records that rounds re-dispatch within the same engine state.
   * `fresh` is documented-unsupported — requesting it returns an explicit
   * error naming the alternative path (a separate graph per round). Absent =
   * default behavior (byte-identical to legacy output).
   */
  mode?: LoopMode;
}

// ── Budget ──────────────────────────────────────────────────────────────

/** Per-node resource budget (maps to DispatchManager per-session limits). */
export interface NodeBudgetSpec {
  /** Max input tokens for this node */
  max_input_tokens?: number;
  /** Max output tokens for this node */
  max_output_tokens?: number;
  /** Max cumulative cost for this node (USD) */
  max_cost_usd?: number;
  /** Wall-clock timeout for this node (ms) */
  timeout_ms?: number;
  /** Automatic retries on escalate */
  max_retries?: number;
}

/**
 * Graph-level resource budget (cumulative across all nodes).
 *
 * The orchestrating agent sub-allocates the graph budget to child nodes.
 * Overbooking is allowed (sum of per-node budgets may exceed graph budget),
 * but actual consumption is bounded by the graph budget.
 */
export interface GraphBudgetSpec {
  /** Max total input tokens across all nodes */
  max_total_input_tokens?: number;
  /** Max total output tokens across all nodes */
  max_total_output_tokens?: number;
  /** Max total cost across all nodes (USD) */
  max_total_cost_usd?: number;
}

// ── Termination ─────────────────────────────────────────────────────────

/**
 * Termination condition composition for graph or loop group.
 *
 * Reuses the existing condition vocabulary from src/types.graph.ts:116-121
 * (TerminationConfig) plus signal-based and budget-exhausted conditions
 * specific to the v2 graph model.
 */
export interface TerminationDecl {
  /** Terminate when ANY one of these conditions is met */
  any_of?: TerminationCondition[];
  /** Terminate only when ALL of these conditions are met */
  all_of?: TerminationCondition[];
}

/** A single termination condition — discriminated union over all possible criteria. */
export type TerminationCondition =
  | { max_iterations: number }
  | { timeout_ms: number }
  | { converged: string }
  | {
      result_matches: {
        agent: string;
        contains?: string;
        regex?: string;
        score_gte?: number;
        no_changes?: boolean;
      };
    }
  | { stuck: { repeats: number } }
  | { budget_exhausted: true }
  | { signal: string };

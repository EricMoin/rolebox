import type { GraphTemplate } from "./constants.ts";

// Re-export GraphTemplate for consumers that import it from types.ts
export type { GraphTemplate };

/**
 * A directed edge in a collaboration graph between two agent nodes.
 * Represents a flow of work from one agent to another.
 */
export interface FlowEdge {
  /** Source agent ID */
  from: string;
  /** Target agent ID */
  to: string;
  /** Optional label describing the transition condition or data flow */
  label?: string;
  /** When true, this edge exits the collaboration flow (terminal transition) */
  exit?: boolean;
}

/**
 * Raw collaboration graph configuration as parsed from role.yaml.
 * Defines how agents coordinate in a multi-agent workflow.
 */
export interface CollaborationConfig {
  /** Optional named topology shorthand */
  topology?: GraphTemplate;
  /** List of agent IDs participating in the collaboration */
  agents?: string[];
  /** Explicit flow edges defining work transitions between agents */
  flow?: FlowEdge[];
  /** Maximum collaboration iterations before forced termination */
  max_iterations?: number;
  /** Loop termination conditions (when to stop the collaboration flow) */
  termination?: TerminationConfig;
}

/**
 * Normalized internal representation of a collaboration graph.
 * Generated at build-time from CollaborationConfig by resolving
 * template expansions, deduplicating nodes, and categorizing edges.
 */
export interface ResolvedGraph {
  /** All resolved flow edges (including exit edges) */
  edges: FlowEdge[];
  /** Deduplicated list of all agent node IDs in the graph */
  nodes: string[];
  /** Maximum iterations (defaulted to a sensible value if not specified) */
  maxIterations: number;
  /** Subset of edges marked as exit transitions */
  exitEdges: FlowEdge[];
  /** The template that was expanded, if any */
  template?: string;
  /** Loop groups detected in the graph (cycles subject to termination rules) */
  loopGroups: LoopGroup[];
  /** Resolved termination configuration for the graph */
  termination?: ResolvedTermination;
}

/**
 * Per-agent role metadata within a resolved collaboration graph.
 * Provides each agent with its connectivity context for routing decisions.
 */
export interface GraphNodeRole {
  /** Agent identifier matching a node in the graph */
  agentId: string;
  /** Agents that can send work to this agent */
  upstream: string[];
  /** Agents that this agent can send work to */
  downstream: string[];
  /** Whether this agent is an entry point for the collaboration flow */
  isEntryPoint: boolean;
  /** Whether this agent is an exit point for the collaboration flow */
  isExitPoint: boolean;
}

// ── Loop & Termination Types ─────────────────────────────────────────────

/**
 * Reasons a collaboration loop can terminate.
 * Each reason corresponds to a specific termination condition being met.
 */
export type TerminationReason =
  | "max_iterations"
  | "timeout"
  | "stuck"
  | "converged"
  | "result_match"
  | "error";

/**
 * A discriminated union of all possible loop termination conditions.
 * Each variant describes a single condition under which a collaboration
 * loop should stop executing.
 */
export type LoopCondition =
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
  | { stuck: { repeats: number } };

/**
 * Composition of loop termination conditions.
 * - `any_of`: the loop terminates when ANY of the listed conditions is met
 * - `all_of`: the loop terminates when ALL of the listed conditions are met
 */
export interface TerminationConfig {
  /** Terminate when any one of these conditions is met */
  any_of?: LoopCondition[];
  /** Terminate only when all of these conditions are met */
  all_of?: LoopCondition[];
}

/**
 * A detected loop in a resolved collaboration graph.
 * Captures the cycle metadata for runtime loop detection and termination.
 */
export interface LoopGroup {
  /** Unique identifier for this loop group */
  id: string;
  /** Node IDs that participate in the loop */
  nodes: string[];
  /** Back-edges that form the cycle(s) in this loop */
  backEdges: FlowEdge[];
  /** Optional per-loop iteration cap (overrides global max where set) */
  maxIterations?: number;
}

/**
 * Resolved termination configuration attached to a resolved graph.
 * Combines the user-facing TerminationConfig with the detected LoopGroup list.
 */
export interface ResolvedTermination {
  /** The normalized termination config (may contain resolved defaults) */
  config: TerminationConfig;
  /** Loops detected in the graph that are subject to termination rules */
  loopGroups: LoopGroup[];
}

// ── Function State Machine Types ─────────────────────────────────────────

/** A boolean predicate over the closed condition vocabulary. */
export type Condition =
  | string                          // named condition, e.g. "user_approval", "artifact_exists(plan)"
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

/** A reaction a function runs when a lifecycle event fires. */
export interface ObserveSpec {
  /** Which lifecycle event triggers this reaction. */
  on: string;
  /** For on:"tool_after", only fire when this tool was called. */
  tool?: string;
  /** Optional extra guard; reaction only runs when this condition is true. */
  when?: Condition;
  /** Content to inject into the next system prompt when fired. */
  inject?: string;
  /** Mark this evidence tag as observed. */
  set_evidence?: string;
  /** Extract the ```{name} fenced block from the assistant message into artifact {name}. */
  capture_artifact?: string;
  /** Mirror the latest todowrite state into function STATE under key "__todos". */
  sync_todos?: boolean;
  /** Only fire when the tool output matches these content conditions. */
  when_output?: {
    /** Output must contain this string (case-sensitive). */
    contains?: string;
    /** Output must NOT contain this string (case-sensitive). */
    not_contains?: string;
  };
}

export const BUILTIN_OBSERVE_EVENTS = ["tool_after", "message", "activate"] as const;

/** When `when` becomes true, activate/deactivate the listed functions. */
export interface TransitionSpec {
  when: Condition;
  activate?: string[];
  deactivate?: string[];
}

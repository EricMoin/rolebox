import type { GraphTemplate } from "./constants.ts";

// Re-export GraphTemplate for consumers that import it from types.ts
export type { GraphTemplate };

/**
 * A directed edge between two graph nodes.
 * Represents a flow of work from one agent to another.
 */
export interface FlowEdge {
  /** Source agent ID */
  from: string;
  /** Target agent ID */
  to: string;
  /** Optional label describing the transition condition or data flow */
  label?: string;
  /** When true, this edge exits the graph flow (terminal transition) */
  exit?: boolean;
}

/**
 * Selector for the role's graph orchestration engine, as declared in the
 * `graph.orchestration` role.yaml key.
 */
export type GraphOrchestration = "graph_v2";

/**
 * Raw `graph:` role-level configuration as declared in role.yaml.
 *
 * This is an INPUT type: it captures what the role author wrote under the
 * `graph:` key.
 */
export interface GraphRoleConfig {
  /** Orchestration engine that should drive this role's graph execution. */
  orchestration?: GraphOrchestration;
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
  /** Store the tool's args payload (JSON-serialized) as an artifact under this name. */
  capture_payload_as?: string;
  /** Mirror the latest todowrite state into function STATE under key "__todos". */
  sync_todos?: boolean;
  /** Only fire when the tool output matches these content conditions. */
  when_output?: {
    /** Output must contain this string (case-sensitive). */
    contains?: string;
    /** Output must NOT contain this string (case-sensitive). */
    not_contains?: string;
  };
  /** Only fire when the tool arguments match these conditions. */
  when_args?: {
    /** Every key-value pair here must equal the corresponding key in toolArgs. */
    match?: Record<string, unknown>;
    /** No key-value pair here may match the corresponding key in toolArgs. */
    not_match?: Record<string, unknown>;
  };
}

export const BUILTIN_OBSERVE_EVENTS = ["tool_after", "message", "activate"] as const;

/** When `when` becomes true, activate/deactivate the listed functions. */
export interface TransitionSpec {
  when: Condition;
  activate?: string[];
  deactivate?: string[];
}

// Graph declarations and shared display types.
export type { GraphDeclarationV3 } from "./graph/compiler/declaration-v3.ts";
export type { CompiledPlan, PlanBinding } from "./graph/compiler/plan.ts";
export type { NodeBudgetSpec, GraphBudgetSpec, BudgetState as GraphBudgetState } from "./graph/domain/budget.ts";
export type { JoinConfig, ResolvedJoinStrategy } from "./graph/domain/join.ts";

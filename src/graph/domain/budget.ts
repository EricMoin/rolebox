/**
 * Graph domain — the neutral BUDGET vocabulary
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The declared limits and the consumption state, MOVED here from the retired v2
 * type containers: `NodeBudgetSpec` / `GraphBudgetSpec` from the v2 graph
 * declaration module and the consumption state (`GraphBudgetState`, whose
 * canonical name here is `BudgetState`) from the v2 engine-state module.
 * Exactly ONE definition of each concept exists; both retired modules re-export
 * these names instead of declaring them.
 *
 * Dependency leaf: this module imports nothing at all, so every layer may name
 * the budget vocabulary without dragging a retired container in.
 */

// ── Budget specs (declaration content) ──────────────────────────────────────

/**
 * Per-node resource budget (maps to DispatchManager per-session limits).
 *
 * Field ownership (P1): the SPEC is immutable definition content — the compiler
 * copies it into `CompiledPlan.nodes[].budget`, and a changed limit is a new
 * plan revision rather than an edit of a running graph.
 * Writers: the declaration/compile path only; no run, worker or recovery path
 * writes a spec.
 * Replaces: nothing — this is the same declared vocabulary the v3 declaration
 * grammar and the compiler already consume (`src/graph/compiler/compile.ts`
 * reads exactly these keys); only its home moved.
 */
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
 *
 * Field ownership (P1): declaration content, exactly as {@link NodeBudgetSpec}.
 * Writers: the declaration path only.
 * Replaces: nothing — the same declared vocabulary the RETIRED v2 declaration
 * carried (`GraphDeclaration.budget`), moved with its semantics intact; only
 * its home moved.
 * KNOWN FACT: no live compiler path reads this shape. The v3 grammar
 * (`GraphDeclarationV3`) declares NO graph-level budget, so only
 * {@link NodeBudgetSpec} is consumed today (per-node specs are compiled into the
 * plan). Whether the converged definition keeps a graph-level spec, and which
 * budget object enforces it, is a P3/P4 decision — this move deliberately
 * changes neither.
 */
export interface GraphBudgetSpec {
  /** Max total input tokens across all nodes */
  max_total_input_tokens?: number;
  /** Max total output tokens across all nodes */
  max_total_output_tokens?: number;
  /** Max total cost across all nodes (USD) */
  max_total_cost_usd?: number;
}

// ── Budget state (runtime consumption) ──────────────────────────────────────

/**
 * Cumulative graph-level budget consumption state.
 *
 * The counters an execution actually moved: dispatch sessions spawned and
 * tokens/cost consumed across all nodes of one run.
 *
 * Field ownership (P1)
 * Owns: the graph-level consumption counters of ONE run. It is the only
 * aggregate the store needs for a budget check; per-node mirrors are not a
 * second authority.
 * Writers: NO live writer today — the v2 container's `applyBudgetDelta` writer
 * was deleted with the legacy runtime, and the outcome run-state body carries no
 * budget field at all. The converged store's owner is the outcome reducer,
 * inside the acceptance transaction (the ledger's `runInTransaction` boundary),
 * so consumption advances with the state change that consumed it and never
 * beside it — that wiring is P3's.
 * Replaces: the `GraphBudgetState` field the retired v2 container carried on
 * `EngineState.budget` and the per-node
 * `NodeRuntimeState.tokensConsumed` / `sessionsSpawned` mirror that fed it.
 * KNOWN GAP (P3): reservation before parallel dispatch and reconciliation
 * against real usage are NOT modeled here yet; these are the plain consumed
 * counters, moved with their semantics intact.
 */
export interface BudgetState {
  /** Total dispatch sessions spawned across all nodes */
  sessionsSpawned: number;
  /** Total input tokens consumed across all nodes */
  totalInputTokens: number;
  /** Total output tokens consumed across all nodes */
  totalOutputTokens: number;
  /** Total cost consumed across all nodes (USD) */
  totalCost: number;
}

/**
 * The name this consumption state carried inside the retired v2 engine-state
 * container, kept as an alias so existing importers of that name keep resolving
 * — one definition, two names, never two shapes.
 */
export type GraphBudgetState = BudgetState;

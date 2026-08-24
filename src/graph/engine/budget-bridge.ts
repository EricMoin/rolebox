/**
 * Graph Execution Engine v2 — Budget Bridge
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * A read-only seam over the dispatch budget subsystem. The graph engine checks
 * budget ceilings through this bridge before spawning node dispatches.
 *
 * The bridge surfaces two checks:
 *
 * - **Graph-level** — `checkGraphBudget(graphId, state)` first delegates to
 *   `BudgetTracker.isRequestBudgetExceeded(parentSessionId)`, passing the
 *   graph ID as the request scope. Because `dispatch-bridge.graphParentContext`
 *   seeds request usage keyed off the graph ID, this yields a per-graph budget
 *   ceiling (a single graph instance == one logical "request").
 *
 *   `isRequestBudgetExceeded` already covers both the request and session
 *   tiers from one `DispatchManagerConfig` (`src/dispatch/budget/budget-tracker.ts:148-176`).
 *
 *   The graph-declared session cap was removed — the bridge now delegates
 *   solely to the tracker. `EngineState.budget.sessionsSpawned` remains a
 *   NET-LIVE display counter (incremented per successful dispatch in
 *   `engine-advance.ts`, decremented on cancelled/timeout termination in
 *   `engine-recovery.ts`), but no longer gates dispatch.
 *
 * - **Per-node** — `checkNodeBudget(node)` is a stub in this phase. Enforcement
 *   of cumulative per-node consumption against per-graph `max_total_*` limits
 *   is deferred to Phase 7 (see the `applyBudgetDelta` stub note in
 *   `engine-state.ts`).
 *
 * Invariant: import-only consumer of the *public* `BudgetTracker` API. Imports
 * only the `BudgetTracker` class type and the `BudgetCheckResult` / `UsageRecord`
 * types exported from `src/dispatch/budget/budget-tracker.ts`.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §5.
 */

import type { BudgetTracker, BudgetCheckResult, UsageRecord } from "../../dispatch/budget/budget-tracker.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import type { GraphDeclaration } from "../../types.graph-v2.ts";

// ── BudgetBridge ────────────────────────────────────────────────────────────

/**
 * Read-only wrapper over {@link BudgetTracker}'s budget-query surface.
 *
 * The `BudgetTracker` instance is injected (via
 * `DispatchBridge.getBudgetTracker()`) — it is never constructed here, and the
 * engine never mutates budget state through this bridge.
 */
export class BudgetBridge {
  constructor(
    private readonly tracker: BudgetTracker,
    private readonly graphDeclaration: GraphDeclaration,
  ) {}

  /**
   * Graph-level budget check.
   *
   * Delegates to `BudgetTracker.isRequestBudgetExceeded(graphId)` — the graph
   * ID is the request scope (see `dispatch-bridge.graphParentContext`), so the
   * tracker check returns `{ exceeded: true, reason }` when the graph instance
   * has breached any configured request-level ceiling.
   *
   * The graph-declared session cap was removed, so this is the only check —
   * `state.budget.sessionsSpawned` (a NET-LIVE display counter, incremented
   * per successful dispatch and decremented on cancelled/timeout termination)
   * no longer gates dispatch.
   */
  checkGraphBudget(graphId: string, state: EngineState): BudgetCheckResult {
    return this.tracker.isRequestBudgetExceeded(graphId);
  }

  /**
   * Cumulative request usage for a graph instance (all nodes dispatched under
   * that graph ID). Read-only — the engine reads it, never writes it.
   */
  getGraphUsage(graphId: string): UsageRecord {
    return this.tracker.getRequestUsage(graphId);
  }

  /**
   * Per-node budget check.
   *
   * STUB (Phase 7): Per-node cumulative consumption enforcement is out of
   * scope for Phase 1. This always reports `{ exceeded: false }` and exists so
   * the engine has a stable call site to upgrade once per-node ceiling logic
   * lands (compare `engine-state.ts:applyBudgetDelta`'s stub note).
   *
   * @param node  The node's runtime state — carries `tokensConsumed`, the
   *              per-node cumulative usage this future check will compare
   *              against a ceiling.
   */
  checkNodeBudget(_node: NodeRuntimeState): BudgetCheckResult {
    return { exceeded: false };
  }
}

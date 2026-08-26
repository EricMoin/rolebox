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
 *   On top of the tracker, the bridge enforces the graph declaration's OWN
 *   ceilings (`GraphDeclaration.budget.max_total_*`) against the cumulative
 *   `EngineState.budget` counters, which are fed by
 *   `engine-recovery.ts::captureNodeUsage` (`applyBudgetDelta`) at task
 *   termination. The declaration ceilings use `>=` (at-the-ceiling is a
 *   breach); when no declaration budget is present, the tracker result is the
 *   only gate.
 *
 *   `EngineState.budget.sessionsSpawned` remains a NET-LIVE display counter
 *   (incremented per successful dispatch in `engine-advance.ts`, decremented
 *   on cancelled/timeout termination in `engine-recovery.ts`) and no longer
 *   gates dispatch.
 *
 * - **Per-node** — `checkNodeBudget(node)` is a live port member: the
 *   advance engine invokes it through `GraphBudgetPort` as a pre-dispatch
 *   pre-check alongside `checkGraphBudget` (`engine-advance.ts::_dispatchNode`).
 *   It compares the node's DECLARED per-node ceilings
 *   (`node.budget.max_input_tokens` / `max_output_tokens` / `max_cost_usd`,
 *   carried from `NodeConfig.budget` by `registerNode`) against the node's
 *   cumulative `tokensConsumed` (`>=` means breach). No declared per-node
 *   budget → accept. A breach escalates the ready node without dispatching it.
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
 * `DispatchManager.getBudgetTracker()`) — it is never constructed here, and the
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
   * Two-layer check:
   *
   * 1. Delegates to `BudgetTracker.isRequestBudgetExceeded(graphId)` — the
   *    graph ID is the request scope (see `dispatch-bridge.graphParentContext`),
   *    so the tracker check returns `{ exceeded: true, reason }` when the
   *    graph instance has breached any configured request-level ceiling.
   * 2. When the graph declaration declares its own ceilings
   *    (`GraphDeclaration.budget.max_total_input_tokens` /
   *    `max_total_output_tokens` / `max_total_cost_usd`), compares the
   *    cumulative `EngineState.budget` counters (`>=` means breach) and
   *    returns the first breach with a descriptive reason. The counters are
   *    fed by `engine-recovery.ts::captureNodeUsage` at task termination.
   *
   * No declared graph budget → the tracker result is the only gate (and
   * `state.budget.sessionsSpawned`, a NET-LIVE display counter, never gates).
   */
  checkGraphBudget(graphId: string, state: EngineState): BudgetCheckResult {
    const trackerResult = this.tracker.isRequestBudgetExceeded(graphId);
    if (trackerResult.exceeded) return trackerResult;

    const budget = this.graphDeclaration.budget;
    if (!budget) return trackerResult;
    if (
      budget.max_total_input_tokens !== undefined &&
      state.budget.totalInputTokens >= budget.max_total_input_tokens
    ) {
      return {
        exceeded: true,
        reason: `graph budget exhausted: inputTokens ${state.budget.totalInputTokens}/${budget.max_total_input_tokens}`,
      };
    }
    if (
      budget.max_total_output_tokens !== undefined &&
      state.budget.totalOutputTokens >= budget.max_total_output_tokens
    ) {
      return {
        exceeded: true,
        reason: `graph budget exhausted: outputTokens ${state.budget.totalOutputTokens}/${budget.max_total_output_tokens}`,
      };
    }
    if (
      budget.max_total_cost_usd !== undefined &&
      state.budget.totalCost >= budget.max_total_cost_usd
    ) {
      return {
        exceeded: true,
        reason: `graph budget exhausted: cost ${state.budget.totalCost}/${budget.max_total_cost_usd}`,
      };
    }
    return trackerResult;
  }

  /**
   * Cumulative request usage for a graph instance (all nodes dispatched under
   * that graph ID). Read-only — the engine reads it, never writes it.
   *
   * NOTE: consumer-facing query, NOT part of the {@link GraphBudgetPort}
   * contract — the advance engine never invokes this (it touches only
   * `checkGraphBudget` / `checkNodeBudget` through the port). It exists on the
   * concrete bridge so status / monitor consumers can read cumulative usage
   * without reaching into the tracker directly.
   */
  getGraphUsage(graphId: string): UsageRecord {
    return this.tracker.getRequestUsage(graphId);
  }

  /**
   * Per-node budget check — invoked by the engine through
   * {@link GraphBudgetPort} as a pre-dispatch pre-check
   * (`engine-advance.ts::_dispatchNode`).
   *
   * Compares the node's DECLARED per-node ceilings (`node.budget.max_input_tokens`
   * / `max_output_tokens` / `max_cost_usd`, carried into runtime state from
   * `NodeConfig.budget` by `registerNode`) against the node's cumulative
   * `tokensConsumed`. `>=` means breach — the first breached ceiling is
   * returned with a descriptive reason. No declared per-node budget → accept
   * (`{ exceeded: false }`).
   *
   * @param node  The node's runtime state — carries `tokensConsumed` (the
   *              per-node cumulative usage) and `budget` (the declared
   *              per-node ceilings).
   */
  checkNodeBudget(node: NodeRuntimeState): BudgetCheckResult {
    const budget = node.budget;
    if (!budget) return { exceeded: false };
    const consumed = node.tokensConsumed;
    if (
      budget.max_input_tokens !== undefined &&
      consumed.inputTokens >= budget.max_input_tokens
    ) {
      return {
        exceeded: true,
        reason: `node budget exhausted: inputTokens ${consumed.inputTokens}/${budget.max_input_tokens}`,
      };
    }
    if (
      budget.max_output_tokens !== undefined &&
      consumed.outputTokens >= budget.max_output_tokens
    ) {
      return {
        exceeded: true,
        reason: `node budget exhausted: outputTokens ${consumed.outputTokens}/${budget.max_output_tokens}`,
      };
    }
    if (
      budget.max_cost_usd !== undefined &&
      consumed.cost >= budget.max_cost_usd
    ) {
      return {
        exceeded: true,
        reason: `node budget exhausted: cost ${consumed.cost}/${budget.max_cost_usd}`,
      };
    }
    return { exceeded: false };
  }
}

/**
 * Graph Execution Engine v2 — DispatchManager Bridge
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * A read-only seam over {@link DispatchManager}. The graph engine uses this
 * bridge as its *only* touchpoint into the dispatch subsystem. It wraps the
 * public methods (`launch`, `executeSync`, `onTaskTerminated`,
 * `removeTaskTerminatedListener`, `getResult`, `cancelTask`, `getTasksByParent`,
 * `getBudgetTracker`) with proper TS types
 * so the engine never reaches into `DispatchManager` internals directly.
 *
 * Invariant: this module is an **import-only consumer** of the dispatch
 * subsystem's *public* API. It imports only the `DispatchManager` class type
 * and dispatch value types (`DispatchInput`, `DispatchTask`) — no private
 * members of `src/dispatch/core/manager.ts`.
 *
 * A node in the graph is an `{agent, prompt}` tuple. "Executing" a node means
 * dispatching work to that node's bound agent via {@link executeNode}.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §3.
 */

import type { DispatchManager } from "../../dispatch/core/manager.ts";
import type { DispatchInput, DispatchTask } from "../../dispatch/types.ts";
import type { BudgetTracker, UsageRecord } from "../../dispatch/budget/budget-tracker.ts";
import type { NodeRuntimeState } from "../../types.engine-v2.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Parent-context shape required by `DispatchManager.launch`/`executeSync`.
 * Mirrors the inline parameter type at `src/dispatch/core/manager.ts:209`.
 */
export interface DispatchParentContext {
  /** Session ID of the parent agent dispatching the task. */
  sessionID: string;
  /** Agent ID of the parent. */
  agent: string;
  /** Working directory of the parent. */
  directory: string;
  /**
   * Optional per-parent concurrency cap for background dispatches.
   * When omitted, task-launcher falls back to the dispatch config's
   * `maxActivePerParent` (default 3). {@link graphParentContext} sets this to
   * `Number.POSITIVE_INFINITY`: graphId is a request/budget scope, not a real
   * session needing per-parent protection, so graph-node concurrency is
   * engine-managed (frontier, loop max_traversals, per-node budgets) rather
   * than capped by the per-parent default. Real-session parents (legacy
   * dispatch_* tools) omit this field and keep per-parent fairness.
   */
  maxActivePerParent?: number;
}

/**
 * Structured payload returned by `DispatchManager.getResult`.
 * Mirrors the inline return type at `src/dispatch/core/manager.ts:266-275`.
 */
export interface DispatchResultPayload {
  kind: "ok" | "expired" | "not_found" | "fetch_error";
  text: string;
  resultText: string;
  hadFence: boolean;
  totalChars: number;
  error?: string;
}

/** Options for building the parent context of a graph-level dispatch. */
export interface GraphParentOptions {
  /** Graph ID — becomes the request scope for request-level budget tracking. */
  graphId: string;
  /** Acting agent for the graph executor (defaults to {@link DEFAULT_GRAPH_AGENT}). */
  agent?: string;
  /** Working directory for dispatched graph nodes. */
  directory: string;
}

/** Callback signature for task termination (matches `DispatchManager.onTaskTerminated`). */
export type TaskTerminatedCallback = (taskId: string, status: string) => void;

// ── Constants ───────────────────────────────────────────────────────────────

/** Fallback acting-agent identity when a graph supplies no explicit agent. */
export const DEFAULT_GRAPH_AGENT = "emperor--jinyiwei";

// ── Parent-context helpers ──────────────────────────────────────────────────

/**
 * Build the parent context for a graph-level dispatch.
 *
 * `graphId` is deliberately placed in `sessionID` because the dispatch
 * subsystem treats the parent session ID as the **request** scope: it seeds
 * `requestUsage` and `getBudgetTracker().getRequestUsage(...)` keyed off it.
 * Scoping requests to the graph therefore makes request-level budget checks
 * per-graph (see `budget-bridge.ts`).
 */
export function graphParentContext(opts: GraphParentOptions): DispatchParentContext {
  return {
    sessionID: opts.graphId,
    agent: opts.agent || DEFAULT_GRAPH_AGENT,
    directory: opts.directory,
    // graphId is a request/budget scope, not a real parent session — the
    // engine's frontier, loop max_traversals, and per-node budgets are the
    // governing bounds (emperor role.yaml design comment: "concurrency is
    // engine-managed"). Lifting the per-parent cap (config default: 3) here
    // means a graph's nodes are never throttled merely for sharing the same
    // graphId parent. Real-session parents omit this field and retain the
    // config default via task-launcher's `?? d.config.maxActivePerParent`.
    maxActivePerParent: Number.POSITIVE_INFINITY,
  };
}

// ── DispatchBridge ──────────────────────────────────────────────────────────

/**
 * Read-only wrapper over {@link DispatchManager}'s public surface.
 *
 * The instance is injected (dependency injection) — this matches the existing
 * dispatch-tool pattern (`src/dispatch/tools.ts`) rather than a module-level
 * singleton. The graph engine constructs one `DispatchBridge` per graph
 * execution from the active manager.
 */
export class DispatchBridge {
  constructor(private readonly manager: DispatchManager) {}

  /** Dispatch a task asynchronously (returns immediately with the task handle). */
  launch(input: DispatchInput, parentContext: DispatchParentContext): Promise<DispatchTask> {
    return this.manager.launch(input, parentContext);
  }

  /** Dispatch a task synchronously (blocks until it completes, returns its text). */
  executeSync(input: DispatchInput, parentContext: DispatchParentContext): Promise<string> {
    return this.manager.executeSync(input, parentContext);
  }

  /** Register a one-time listener fired when a task enters a terminal state. */
  onTaskTerminated(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): TaskTerminatedCallback {
    return this.manager.onTaskTerminated(taskId, callback);
  }

  /**
   * Remove a previously-registered task-terminated listener (monitor M4).
   *
   * Delegates to `DispatchManager.removeTaskTerminatedListener`
   * (`src/dispatch/core/manager.ts`). Consumed by the engine's subscription
   * accessor (`AdvanceEngine.getTerminationSubscriptions`) so a teardown path
   * (S7 dispose) can unregister every listener this engine wired — closing the
   * leak previously left by fire-once `onTaskTerminated` subscriptions.
   */
  removeTaskTerminatedListener(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void {
    this.manager.removeTaskTerminatedListener(taskId, callback);
  }

  /**
   * Look up a dispatched task's current status (for recovery reconciliation
   * and to read `task.error` on an errored task). Returns `undefined` for an
   * unknown task id.
   */
  getTask(taskId: string): DispatchTask | undefined {
    return this.manager.getTask(taskId);
  }

  /** Fetch the materialized output of a completed task. */
  getResult(taskId: string): Promise<DispatchResultPayload> {
    return this.manager.getResult(taskId);
  }

  /** Cancel a running task. Returns `true` if the cancellation was issued. */
  cancelTask(taskId: string): Promise<boolean> {
    return this.manager.cancelTask(taskId);
  }

  /** List the tasks dispatched by the given parent session. */
  getTasksByParent(parentSessionId: string): DispatchTask[] {
    return this.manager.getTasksByParent(parentSessionId);
  }

  /** Access the shared budget tracker (read-only budget queries live in `budget-bridge.ts`). */
  getBudgetTracker(): BudgetTracker {
    return this.manager.getBudgetTracker();
  }

  /**
   * Cumulative token/cost usage for a single dispatched session (keyed by the
   * dispatch session ID). Delegates to the budget tracker's per-session ledger.
   *
   * This is the per-node usage surface: a node's `dispatchSessionId` identifies
   * exactly one dispatched session, so the engine reads this at task termination
   * to populate `node.tokensConsumed` (the Phase-7 per-node consumption gap).
   * Returns a zeroed `UsageRecord` when the tracker has no record for the
   * session (e.g. usage was never sampled or the session was reset).
   */
  getSessionUsage(sessionId: string): UsageRecord {
    return this.manager.getBudgetTracker().getSessionUsage(sessionId);
  }

  /**
   * Execute a graph node by dispatching to its bound agent.
   *
   * "Executing a node" === dispatching work to `node.agent` with `node.prompt`.
   * Runs in the background (async) and returns the task handle so the caller
   * can register an `onTaskTerminated` listener and await completion.
   *
   * @param node           The node's runtime state (source of `agent` + `prompt`).
   * @param parentContext  Parent context; use {@link graphParentContext} to scope
   *                       request-level budget to the owning graph.
   * @param description    Optional human-readable task description.
   */
  executeNode(
    node: NodeRuntimeState,
    parentContext: DispatchParentContext,
    description?: string,
  ): Promise<DispatchTask> {
    const input: DispatchInput = {
      subagent: node.agent,
      prompt: node.prompt,
      run_in_background: true,
      description: description ?? `graph node ${node.nodeId}`,
      noParentInherit: true,
      // Monitor M2: propagate the node's declared per-node budget timeout into
      // the dispatch task input. `task-launcher.ts:444-445` consumes
      // `input.timeout_ms` → `task.timeoutMs` (the background-task hard
      // timeout), so a `graph_add_node`-declared `budget.timeout_ms` now
      // actually bounds the dispatched task. Omitted when undefined (task
      // falls back to the background default).
      ...(node.budget?.timeout_ms !== undefined
        ? { timeout_ms: node.budget.timeout_ms }
        : {}),
    };
    return this.manager.launch(input, parentContext);
  }
}

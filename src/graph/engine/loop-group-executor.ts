/**
 * Graph Execution Engine v2 — Loop-Group Executor
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * The orchestration layer that ties the Phase 2 primitives into a single
 * bounded-cycle execution decision for a convergence node inside a loop group.
 * Each primitive owns one concern and stays import-only here:
 *
 * - traversal counting → `engine-state.ts` (`incrementLoopTraversal`,
 *   `isLoopExhausted`, `loopGroups`)
 * - revise-driven re-dispatch → `signal-propagation.ts` (`propagateRevise`)
 * - worst-signal forward propagation → `signal-propagation.ts`
 *   (`propagateEscalate`)
 * - upstream cancellation → `cascade-canceller.ts` (`cancelPendingUpstreams`)
 * - join arbitration → `join-evaluator.ts` (`evaluateJoin`)
 *
 * {@link executeLoopStep} is the single entry point: given a loop-group member
 * node's terminating signal, it decides which of the three soft early-exits in
 * `.rolebox/design/failure-resilience.md` §4.3 applies and executes it:
 *
 * | Condition | Trigger | Outcome |
 * |---|---|---|
 * | **converged** | Convergence node signals `answer` | Loop exits naturally — only forward edges run (engine's `answer` data flow); the stale tracker is reset and no traversal is consumed. |
 * | **max_traversals exhausted** | A `revise_needed` arrives when the loop group's `max_traversals` hard cap is reached | `completed → escalate` with the structured payload `{ reason: "max_traversals exhausted", unresolved, traversals }` (§1.6). |
 * | **stuck** | Consecutive convergence outputs are identical for `>= CONSECUTIVE_STALE_THRESHOLD` (= 2) traversals | `completed → escalate` with reason `"stuck"` before any further traversal is consumed (§4.3). |
 *
 * Otherwise (`revise_needed` with traversals remaining) the executor delegates
 * to {@link propagateRevise}, which increments the traversal counter and
 * re-enters the offending upstream nodes (bounded-cycle re-dispatch). An
 * `escalate` from a loop-group member delegates to {@link propagateEscalate}
 * and, at any convergence node whose join has now failed, retires the
 * still-pending upstream nodes via the cascade canceller (§3.3).
 *
 * Design references:
 * - `.rolebox/design/failure-resilience.md` §1.6, §2.1, §3.3, §4
 * - `.rolebox/design/graph-model.md` §4 (bounded-cycle loop model), §5.1 (lattice)
 * - `.rolebox/design/orchestration-patterns.md` §1.6
 * - `src/loop/constants.ts:66` — `CONSECUTIVE_STALE_THRESHOLD = 2`
 */

import { NodeStatus } from "../../constants.ts";
import { CONSECUTIVE_STALE_THRESHOLD } from "../../loop/constants.ts";
import type {
  EngineState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
  RoundHistoryEntry,
} from "../../types.engine-v2.ts";
import type { SignalType } from "./signal-bridge.ts";
import type { SignalPropagationReport } from "./signal-propagation.ts";
import { propagateEscalate, propagateRevise } from "./signal-propagation.ts";
import { cancelPendingUpstreams, type CancelDispatchPort } from "./cascade-canceller.ts";
import { evaluateJoin } from "./join-evaluator.ts";
import { isLoopExhausted } from "./engine-state.ts";
import { markEscalated } from "./node-lifecycle.ts";
import { recordLoopRound } from "./recorder.ts";

// ── Outcomes ────────────────────────────────────────────────────────────────

/**
 * The resolved early-exit / continuation branch of one bounded-cycle step.
 *
 * - `converged` — the node signalled `answer`; the loop ends on the happy path
 *   (forward flow only, no traversal consumed, stale tracker reset).
 * - `revising` — a `revise_needed` with traversals remaining; the back-edge
 *   re-entered the offending upstream nodes (one traversal consumed).
 * - `stuck` — consecutive identical convergence outputs crossed
 *   `CONSECUTIVE_STALE_THRESHOLD`; the node escalated with reason `"stuck"`.
 * - `max_traversals_exhausted` — a `revise_needed` arrived at the hard cap; the
 *   node escalated with the structured exhaustion payload.
 * - `escalating` — the node signalled `escalate`; the worst signal propagated
 *   forward and failed convergence nodes had their pending upstreams cancelled.
 */
export type LoopOutcome =
  | "converged"
  | "revising"
  | "stuck"
  | "max_traversals_exhausted"
  | "escalating";

/** The structured escalation payload mandated by failure-resilience.md §1.6 / §4.3. */
export interface LoopEscalatePayload {
  /** The machine-readable exit reason: `"max_traversals exhausted"` or `"stuck"`. */
  reason: "max_traversals exhausted" | "stuck";
  /** Items that could not be resolved by the final traversal (best-effort). */
  unresolved: unknown[];
  /** The loop group's traversal counter at exit time. */
  traversals: number;
}

/**
 * What one bounded-cycle step did, for diagnostics and tests.
 *
 * Every branch surfaces the same shape so a single call can be inspected
 * precisely: which upstream nodes were re-marked `ready` (revise), which nodes
 * were escalated, which pending upstreams were cancelled, and — for an
 * exhaustion / stuck exit — the full structured escalation payload.
 */
export interface LoopStepReport {
  /** The branch taken by this step (see {@link LoopOutcome}). */
  outcome: LoopOutcome;
  /** Loop-group id the step ran against (absent when the node was not a member). */
  groupId?: string;
  /** The loop group's traversal counter after the step. */
  traversals: number;
  /** Upstream nodes re-marked `ready` and added to the frontier (revise). */
  revisedUpstream: string[];
  /** Nodes escalated by this step (exhaustion / stuck / join failure). */
  escalated: string[];
  /** The escalating node that was re-marked `ready` for an automatic retry. */
  retried: string[];
  /** Pending upstream nodes retired to `cancelled → done` (cascade). */
  cancelled: string[];
  /** Upstream nodes that already recorded a payload and were left untouched. */
  alreadyResolved: string[];
  /**
   * The underlying signal-propagation report (revise or escalate), when the
   * step delegated to one of the propagation primitives.
   */
  propagation?: SignalPropagationReport;
  /** Structured escalation payload for `stuck` / `max_traversals_exhausted`. */
  escalatePayload?: LoopEscalatePayload;
}

// ── Convergence-output fingerprinting ───────────────────────────────────────

/**
 * Stable, order-insensitive canonical string for an arbitrary JSON payload.
 *
 * Keys are sorted recursively so `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }` produce
 * the same fingerprint — the convergence output's *content* is what matters for
 * staleness, not the incidental key order the reviewer happened to emit.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fingerprint a convergence node's signal payload for stuck detection.
 *
 * Strings are compared on their trimmed text; objects are canonicalized. This
 * is the "identical output" test in graph-model.md §4.3 — two revision findings
 * that carry the same verdict/content count as a repeated output.
 */
export function fingerprintPayload(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  return canonicalize(payload);
}

/**
 * Best-effort extraction of the unresolved items from a `revise_needed` payload.
 *
 * Accepts the conventional shapes an orchestration prompt may emit: a top-level
 * `unresolved` or `items` array of findings, a `findings` array, or — as a
 * last resort — the payload itself wrapped in a single-element array so the
 * escalation report never loses the reviewer's message.
 */
export function extractUnresolved(payload: unknown): unknown[] {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["unresolved", "items", "findings"]) {
      if (Array.isArray(obj[key])) return obj[key];
    }
    const verdict = obj["verdict"];
    if (typeof verdict === "string") return [verdict];
  }
  if (typeof payload === "string") return payload ? [payload] : [];
  if (Array.isArray(payload)) return payload;
  if (payload !== undefined && payload !== null) return [payload];
  return [];
}

// ── Stuck detection ─────────────────────────────────────────────────────────

/**
 * Record a convergence node's output against the loop group's rolling
 * fingerprint and report whether the loop is now stuck.
 *
 * - Fingerprint unchanged from the last traversal → `consecutiveStale` rises.
 * - Fingerprint changed → `consecutiveStale` resets to 1 (a fresh signal).
 * - First recorded output → `consecutiveStale` set to 1.
 *
 * Returns `true` when `consecutiveStale >= CONSECUTIVE_STALE_THRESHOLD`, i.e.
 * the loop has produced identical convergence output on at least the required
 * consecutive traversals and should exit with `escalate` (reason `"stuck"`).
 *
 * Pure state mutation on the loop group's tracker — never touches a node or the
 * frontier. The caller decides how to react to the `stuck` verdict.
 */
export function recordConvergenceOutput(
  state: EngineState,
  groupId: string,
  payload: unknown,
): boolean {
  const group = state.loopGroups.get(groupId);
  if (!group) {
    throw new Error(`Unknown loop group "${groupId}" in graph "${state.graphId}"`);
  }
  const fp = fingerprintPayload(payload);

  if (group.convergenceFingerprint !== undefined && group.convergenceFingerprint === fp) {
    group.consecutiveStale += 1;
  } else {
    group.convergenceFingerprint = fp;
    group.consecutiveStale = 1;
  }
  state.updatedAt = Date.now();

  return group.consecutiveStale >= CONSECUTIVE_STALE_THRESHOLD;
}

/**
 * Clear a loop group's stuck tracker.
 *
 * Called on a `converged` (`answer`) signal — the loop exited on the happy path,
 * so no output history needs to carry into a fresh group run.
 */
export function resetConvergenceTracker(state: EngineState, groupId: string): void {
  const group = state.loopGroups.get(groupId)!;
  group.convergenceFingerprint = undefined;
  group.consecutiveStale = 0;
  state.updatedAt = Date.now();
}

// ── Convergence-node identification ─────────────────────────────────────────

/**
 * Whether a node is the loop's convergence/reviewer node — i.e. it routes
 * revisions back along an `on_signal(revise_needed)` back-edge.
 *
 * This is the node whose verdict decides the loop's fate (revise vs converge)
 * and whose staleness the stuck tracker tracks. Worker members of the loop do
 * not own a back-edge and therefore neither emit `revise_needed` nor own the
 * convergence tracker.
 */
function hasReviseBackEdge(state: EngineState, node: NodeRuntimeState): boolean {
  for (const edge of state.graphDeclaration.edges) {
    if (edge.from !== node.nodeId) continue;
    if (edge.type === "on_signal" && (edge.signal_filter ?? []).includes("revise_needed")) {
      return true;
    }
  }
  return false;
}

// ── Core step ───────────────────────────────────────────────────────────────

/** Initialize an empty step report for the given loop group. */
function initReport(group: LoopGroupRuntimeState): LoopStepReport {
  return {
    outcome: "revising",
    groupId: group.id,
    traversals: group.traversalCount,
    revisedUpstream: [],
    escalated: [],
    retried: [],
    cancelled: [],
    alreadyResolved: [],
  };
}

/**
 * Run one bounded-cycle step for a loop-group member's terminating signal.
 *
 * This is the coalesced integration point for subtasks 1-5. The three soft
 * early-exits of failure-resilience.md §4.3 are decided here:
 *
 * 1. **converged** (`answer`) — reset the stuck tracker and, since the node's
 *    join is satisfied, retire any still-pending upstream nodes the cascade
 *    canceller no longer needs. Forward data flow is left to the caller
 *    (engine-advance's `answer` branch); nothing here consumes a traversal.
 * 2. **revise_needed** — first check the stuck condition. If identical output
 *    repeats for `>= CONSECUTIVE_STALE_THRESHOLD` traversals, escalate with
 *    reason `"stuck"` *without* consuming another traversal. Otherwise check
 *    the hard cap: if `isLoopExhausted`, escalate with the structured
 *    `{ reason: "max_traversals exhausted", unresolved, traversals }` payload.
 *    With traversals remaining, delegate to {@link propagateRevise} for the
 *    traversal increment + back-edge re-entry.
 * 3. **escalate** — delegate to {@link propagateEscalate} (worst-signal forward
 *    propagation), then, at every convergence node whose join has just failed,
 *    cancel the still-pending upstream nodes via {@link cancelPendingUpstreams}.
 *
 * @param state       Engine state (source of loop-group + node runtime state).
 * @param node        The loop-group member that emitted the terminating signal.
 * @param signalType  The terminating signal (`answer` | `revise_needed` | `escalate`).
 * @param payload     The signal payload (revision findings for `revise_needed`).
 * @param cancelPort  Optional cascade-canceller seam; when omitted, cancelled
 *                    nodes still reach `cancelled → done` but no dispatch task
 *                    is torn down.
 * @returns A {@link LoopStepReport} describing the branch taken.
 */
export function executeLoopStep(
  state: EngineState,
  node: NodeRuntimeState,
  signalType: SignalType,
  payload: unknown,
  cancelPort?: CancelDispatchPort,
): LoopStepReport {
  const groupId = node.loopGroupId;
  if (!groupId || !state.loopGroups.has(groupId)) {
    // Guard: this module only orchestrates loop-group members. A caller that
    // routes a non-member here gets an explicit non-loop outcome rather than a
    // silent mis-execution.
    const report: LoopStepReport = {
      outcome: "revising",
      traversals: 0,
      revisedUpstream: [],
      escalated: [],
      retried: [],
      cancelled: [],
      alreadyResolved: [],
    };
    report.outcome = "converged"; // nominal — non-loop nodes are not the executor's concern
    report.revisedUpstream = [];
    return report;
  }
  const group = state.loopGroups.get(groupId)!;
  const report = initReport(group);

  if (signalType === "answer") {
    // ── converged: happy path ──────────────────────────────────────────────
    //
    // Only the loop's convergence/reviewer node — the one that routes revisions
    // back along a `revise_needed` back-edge — records the `converged` outcome
    // (by clearing the stuck tracker). A worker-member answer simply flows
    // forward and must not disturb the reviewer's staleness counter, and must
    // not cascade-cancel: `getUpstreamNodeIds` counts the back-edge, so an
    // upstream worker would wrongly "cancel" the downstream convergence node.
    // Cascade cancellation is the escalate path's job (§3.3, test d).
    if (hasReviseBackEdge(state, node)) {
      resetConvergenceTracker(state, groupId);
    }
    report.outcome = "converged";
    report.traversals = group.traversalCount;
    return report;
  }

  if (signalType === "revise_needed") {
    // ── stuck early-exit (§4.3) ────────────────────────────────────────────
    if (recordConvergenceOutput(state, groupId, payload)) {
      markEscalated(node, "stuck");
      report.outcome = "stuck";
      report.escalated.push(node.nodeId);
      report.escalatePayload = {
        reason: "stuck",
        unresolved: extractUnresolved(payload),
        traversals: group.traversalCount,
      };
      report.traversals = group.traversalCount;
      return report;
    }

    // ── hard-cap early-exit (§1.6) ─────────────────────────────────────────
    if (isLoopExhausted(state, groupId)) {
      markEscalated(node, "max_traversals exhausted");
      report.outcome = "max_traversals_exhausted";
      report.escalated.push(node.nodeId);
      report.escalatePayload = {
        reason: "max_traversals exhausted",
        unresolved: extractUnresolved(payload),
        traversals: group.traversalCount,
      };
      report.traversals = group.traversalCount;
      return report;
    }

    // ── bounded-cycle continuation: delegate to the revise propagator ─────
    const prop = propagateRevise(state, node, payload);
    report.propagation = prop;
    report.revisedUpstream = prop.revisedUpstream;
    report.escalated = prop.escalated;
    report.traversals = group.traversalCount;
    // propagateRevise can still escalate (its own increment check races the
    // cap) — surface that with the structured payload for a consistent shape.
    if (prop.escalated.length > 0) {
      report.outcome = "max_traversals_exhausted";
      report.escalatePayload = {
        reason: "max_traversals exhausted",
        unresolved: extractUnresolved(payload),
        traversals: group.traversalCount,
      };
    } else {
      report.outcome = "revising";
      // A traversal boundary was crossed: the loop consumed one traversal and
      // re-entered the offending upstream nodes. Record a completed-round
      // snapshot from genuinely observed data (subtask C-RECORD). The round
      // number is 1-based and monotonic across the group's whole history.
      const roundEntry: RoundHistoryEntry = {
        round: (group.rounds?.length ?? 0) + 1,
        traversalCount: group.traversalCount,
        nodeIds: [...report.revisedUpstream],
        status: node.status,
        startedAt: node.startedAt,
        completedAt: Date.now(),
      };
      recordLoopRound(state, groupId, roundEntry);
    }
    return report;
  }

  // ── escalate: worst-signal forward propagation + cascade cancellation ────
  const prop = propagateEscalate(state, node, payload);
  report.propagation = prop;
  report.retried = prop.retried;
  report.escalated = [...prop.escalated];
  // Every convergence node whose join just failed no longer needs its
  // still-pending upstreams — retire them via the cascade canceller (§3.3).
  for (const escalatedId of prop.escalated) {
    const target = state.nodes.get(escalatedId);
    if (!target) continue;
    const verdict = evaluateJoin(state, target);
    const cc = cancelPendingUpstreams(state, target, verdict, cancelPort);
    report.cancelled.push(...cc.cancelled);
    report.alreadyResolved.push(...cc.alreadyResolved);
  }
  report.outcome = "escalating";
  report.traversals = group.traversalCount;
  return report;
}

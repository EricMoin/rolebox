/**
 * Graph Termination Checker
 *
 * Extracted from engine-advance.ts. Pure state-reader: inspects the engine
 * state graph, transitions to terminal phases when all nodes are quiescent,
 * and invokes the optional `onGraphTerminal` callback exactly once per
 * terminal type (complete / blocked).
 *
 * Terminal notifications are deduped at TWO layers (monitor-audit M10 /
 * F15 exact-once):
 * 1. The per-instance {@link TerminationContext} (engine-private, reset when
 *    the graph is re-opened via `retryNode` / `resetTerminalDedupe`).
 * 2. The persisted `EngineState.terminalNotified` flag (survives engine
 *    rebuilds / restarts so a fresh instance never re-delivers a terminal
 *    notification that was already delivered).
 *
 * A terminal event fires only when BOTH layers are unclaimed; a fire claims
 * both and marks the state dirty so the claim persists. Because only the
 * per-instance context is reset on re-open (retry / extend), this module also
 * reconciles the persisted layer: a graph that demonstrably has
 * scheduler-active (`running` / `ready`) nodes while a terminal flag is
 * recorded has been re-opened, so its next quiescence is a NEW legitimate
 * terminal event and the stale cross-restart guard is cleared (mirroring the
 * context reset). The quiescent re-fire signature of a genuinely fresh
 * instance over a persisted terminal state — complete or blocked — keeps its
 * suppression, so F15 is preserved.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §3.3.
 */

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { EngineState } from "../../types.engine-v2.ts";
import { canTransitionPhase, transitionPhase } from "./engine-state.ts";
import { markEscalated } from "./node-lifecycle.ts";
import { markDirty } from "./engine-persistence.ts";

/**
 * Reason applied to every pending node when a runtime graph deadlock is
 * detected. A deadlocked graph has pending node(s) with no running/ready
 * upstream to ever satisfy them, no blocked gate to resolve them, no terminal
 * error to surface, and no deferred completion still to drain.
 */
const DEADLOCK_REASON =
  "graph deadlock: no active upstream can satisfy pending node(s)";

/**
 * A graph-terminal event emitted via the optional onGraphTerminal callback
 * seam. The engine stays role-agnostic — it packages only the immutable facts;
 * notification / delivery is the consumer's concern and never lives in the
 * engine.
 *
 * Emitted exactly once per terminal transition per event type (complete /
 * blocked). A blocked fire followed later by approval-resume and eventual
 * completion MAY fire the complete event — blocked and complete are separate
 * dedupe guards.
 */
export interface GraphTerminalEvent {
  /** Owning graph id. */
  graphId: string;
  /** The graph's engine phase at emission time. */
  phase: string;
  /** Counts of nodes in each terminal / notable status at emission time. */
  nodeStatusSummaries: {
    completed: number;
    escalate: number;
    timeout: number;
    blocked: number;
    running: number;
  };
  /** True when the graph is quiescent-blocked (no active nodes, ≥1 blocked). */
  isBlocked: boolean;
}

/**
 * Mutable dedupe context for terminal events. Each terminal type (complete /
 * blocked) fires at most once per engine instance via these flags. Reset when
 * the graph is re-opened (e.g. `retryNode`).
 *
 * This is the per-instance half of the two-layer terminal dedupe (M10); the
 * other half is the persisted `EngineState.terminalNotified` flag, which
 * survives engine rebuilds / restarts. `fireGraphTerminal` claims BOTH layers
 * on a fire and refuses to fire while either is claimed; `checkGraphTermination`
 * reconciles the persisted layer on re-open (see module header).
 */
export interface TerminationContext {
  terminalComplete: boolean;
  terminalBlocked: boolean;
}

/**
 * Check whether the graph has reached a terminal state and advance the phase
 * / fire the terminal callback accordingly.
 *
 * - When no active node remains (no running, ready, pending, or blocked),
 *   transitions `executing → complete` and fires `onGraphTerminal` with
 *   `isBlocked=false`.
 * - When no scheduler-active node remains (no running, ready, pending) but
 *   ≥1 blocked node exists, fires `onGraphTerminal` with `isBlocked=true`
 *   WITHOUT a phase transition (graph stays `executing`, waiting on human).
 *
 * Both terminal-event types use separate dedupe guards — the per-instance
 * `ctx` AND the persisted `state.terminalNotified` flag (M10 two-layer
 * exact-once; see module header) — each fires at most once per guard epoch.
 *
 * When the runtime deadlock guard synthetically escalates pending node(s),
 * `onSyntheticEscalate` is invoked once per escalated node with
 * `(nodeId, reason)` so the caller (e.g. a monitor / notification layer) can
 * surface the synthetic escalation instead of it being silent (monitor-audit
 * M1). A no-op when not supplied.
 *
 * The optional `isPendingDeadEnded` predicate relaxes the runtime deadlock
 * guard (F3): a pending node is "dead-ended" when every one of its incoming
 * edges is provably unable to activate — a never-true `on_condition` edge, an
 * `on_signal` edge whose filter excludes the source's recorded terminating
 * signal once the source is terminal, or an edge sourced from a cancelled
 * node. When supplied and it returns true for EVERY pending node, the guard
 * fires even when an escalated/timed-out node is present; without this such a
 * graph would hang in `executing` forever (the strict
 * `counts.escalate === 0 && counts.timeout === 0` activation is preserved).
 * The predicate must be a PURE state reader — the AdvanceEngine builds it
 * from its edge topology + conditionResolver and never mutates state.
 *
 * A throwing consumer must not corrupt the advancing critical section
 * (mirrors _notifyCompletion conventions). A no-op when no callback is
 * registered.
 */
export function checkGraphTermination(
  state: EngineState,
  onGraphTerminal: ((event: GraphTerminalEvent) => void) | undefined,
  ctx: TerminationContext,
  onSyntheticEscalate?: (nodeId: string, reason: string) => void,
  isPendingDeadEnded?: (nodeId: string) => boolean,
): void {
  if (state.phase !== EnginePhase.Executing) return;

  // Tally node statuses for the optional terminal-event summary.
  const counts = { completed: 0, escalate: 0, timeout: 0, blocked: 0, running: 0 };
  // Scheduler-active nodes — `running` or `ready` — are nodes the engine will
  // progress on its own (a running node resolves via a signal; a ready node
  // is dispatched). Pending nodes are NOT scheduler-active: they merely wait
  // on upstream results and, on their own, can never advance the graph.
  let hasSchedulerActive = false;
  let hasBlocked = false;
  let hasPending = false;
  const pendingNodeIds: string[] = [];
  for (const node of state.nodes.values()) {
    switch (node.status) {
      case NodeStatus.Completed: counts.completed += 1; break;
      case NodeStatus.Done: counts.completed += 1; break;
      case NodeStatus.Escalate: counts.escalate += 1; break;
      case NodeStatus.Timeout: counts.timeout += 1; break;
      case NodeStatus.Blocked:
        counts.blocked += 1;
        hasBlocked = true;
        break;
      case NodeStatus.Running:
        counts.running += 1;
        hasSchedulerActive = true;
        break;
      case NodeStatus.Ready:
        hasSchedulerActive = true;
        break;
      case NodeStatus.Pending:
        hasPending = true;
        pendingNodeIds.push(node.nodeId);
        break;
      default: break;
    }
  }

  const hasAnyActive = hasSchedulerActive || hasBlocked || hasPending;

  // Two-layer terminal-dedupe reconciliation (M10 / F15): a terminal flag on
  // the persisted state must suppress re-delivery by a fresh engine instance
  // whose graph is already quiescent (the restart re-fire signature — whether
  // quiescent-complete or quiescent-blocked). But a graph that demonstrably
  // has SCHEDULER-ACTIVE nodes (`running` / `ready`) while a terminal flag is
  // recorded has been RE-OPENED — either by `retryNode` or an
  // extend-after-complete rebuild — so its next quiescence is a NEW legitimate
  // terminal event. The re-open path resets only the per-instance ctx guards
  // (engine-advance.ts), so clear the stale cross-restart layer here to keep
  // both layers in the same epoch; without this the retried/extended chain's
  // legitimate terminal event would be permanently suppressed (the B2
  // stale-guard defect, at the state layer). A re-opened graph's first check
  // ALWAYS sees the re-dispatched target / new root as `running` or `ready`,
  // so `hasSchedulerActive` is a precise re-open signal — a blocked-only or
  // pending-only quiescence (both terminal signatures) never clears the guard.
  if (hasSchedulerActive && state.terminalNotified) {
    state.terminalNotified = undefined;
    markDirty(state);
  }

  // Standard completion path: no active node remains.
  if (!hasAnyActive && canTransitionPhase(state, EnginePhase.Complete)) {
    transitionPhase(state, EnginePhase.Complete);
    fireGraphTerminal(state, onGraphTerminal, counts, false, ctx);
  } else if (!hasSchedulerActive && hasBlocked) {
    // Quiescent-blocked: no running/ready nodes remain but ≥1 blocked node
    // exists. The graph is paused, waiting on a human. Do NOT transition the
    // phase. Pending nodes below a blocked gate are NOT deadlocked — the gate
    // will feed them on approval, and the blocked terminal event fires here.
    fireGraphTerminal(state, onGraphTerminal, counts, true, ctx);
  } else if (
    hasPending &&
    !hasSchedulerActive &&
    !hasBlocked &&
    state.pendingCompletions.length === 0 &&
    (
      // Strict activation: no terminal error to surface. An escalated/timeout
      // node normally means the graph is in an error state awaiting
      // orchestrator attention — never force-complete that.
      (counts.escalate === 0 && counts.timeout === 0) ||
      // F3 relaxed activation: even with an escalated/timed-out node present,
      // the graph is provably deadlocked when the caller's predicate confirms
      // every pending node is dead-ended (each incoming edge is a never-true
      // `on_condition`, a filter-excluding `on_signal` from a terminal source,
      // or an edge sourced from a cancelled node — see
      // AdvanceEngine#_isPendingDeadEnded). Without this the never-activatable
      // pending node would hang in `executing` forever.
      (
        isPendingDeadEnded !== undefined &&
        pendingNodeIds.every((id) => isPendingDeadEnded(id))
      )
    )
  ) {
    // Runtime deadlock guard: pending node(s) exist with no running/ready
    // upstream to ever satisfy them, no blocked gate to resolve them, no
    // deferred completion still to drain, and either no terminal error to
    // surface or a provably never-activatable pending set. This is an
    // unsatisfiable graph (e.g. an unrooted always-cycle, an unprotected cycle
    // reachable only through a satisfied root that cannot feed it, or a
    // condition-gated downstream whose every incoming edge can never fire).
    //
    // Escalate every pending node (`pending → escalate` is a legal transition,
    // node-lifecycle.ts) so the graph quiesces, then transition to complete and
    // fire the terminal event. Without this the engine would sit in `executing`
    // forever and [GRAPH COMPLETE] would never fire. Each synthetic escalation
    // is surfaced through `onSyntheticEscalate` (monitor-audit M1) so the
    // caller can observe it; a no-op when not supplied.
    for (const node of state.nodes.values()) {
      if (node.status === NodeStatus.Pending) {
        markEscalated(state, node, DEADLOCK_REASON);
        counts.escalate += 1;
        if (onSyntheticEscalate) {
          try {
            onSyntheticEscalate(node.nodeId, DEADLOCK_REASON);
          } catch {
            // A throwing observer must not break the deadlock quiescence
            // (mirrors the onGraphTerminal notifier convention).
          }
        }
      }
    }
    if (canTransitionPhase(state, EnginePhase.Complete)) {
      transitionPhase(state, EnginePhase.Complete);
      fireGraphTerminal(state, onGraphTerminal, counts, false, ctx);
    }
  }
}

/**
 * Fire the optional onGraphTerminal callback seam exactly once per event
 * type (complete / blocked). Blocked and complete use separate dedupe
 * guards, so a blocked fire followed later by approval-resume and eventual
 * completion may fire the complete event.
 *
 * Exact-once is enforced at TWO layers (M10 / F15): the per-instance
 * {@link TerminationContext} AND the persisted `state.terminalNotified`
 * flag. A fire requires BOTH layers unclaimed; on fire both are claimed and
 * the state is marked dirty so the cross-restart claim survives a rebuild /
 * restart. `state.terminalNotified` may be `undefined` (graphs that never
 * reached a terminal phase, or pre-M10 persisted files) — treated as
 * unclaimed.
 *
 * A throwing consumer must not corrupt the advancing critical section
 * (mirrors _notifyCompletion conventions). A no-op when no callback is
 * registered.
 */
function fireGraphTerminal(
  state: EngineState,
  onGraphTerminal: ((event: GraphTerminalEvent) => void) | undefined,
  counts: { completed: number; escalate: number; timeout: number; blocked: number; running: number },
  isBlocked: boolean,
  ctx: TerminationContext,
): void {
  const cb = onGraphTerminal;
  if (!cb) return;
  // Two-layer dedupe: fire only when NEITHER the per-instance ctx NOR the
  // persisted cross-restart flag has claimed this event type. Claim both
  // layers before invoking the callback so a re-entrant or repeated check
  // cannot double-fire (mirrors the existing claim-before-call ordering).
  const notified = state.terminalNotified ?? { complete: false, blocked: false };
  if (isBlocked) {
    if (ctx.terminalBlocked || notified.blocked) return;
    ctx.terminalBlocked = true;
    notified.blocked = true;
  } else {
    if (ctx.terminalComplete || notified.complete) return;
    ctx.terminalComplete = true;
    notified.complete = true;
  }
  state.terminalNotified = notified;
  // The cross-restart claim is a critical mutation — persist it with the
  // rest of the terminal transition via the engine's dirty flag.
  markDirty(state);
  const event: GraphTerminalEvent = {
    graphId: state.graphId,
    phase: state.phase,
    nodeStatusSummaries: {
      completed: counts.completed,
      escalate: counts.escalate,
      timeout: counts.timeout,
      blocked: counts.blocked,
      running: counts.running,
    },
    isBlocked,
  };
  try {
    cb(event);
  } catch {
    // Never let a notifier failure break graph advancement.
  }
}

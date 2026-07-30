/**
 * Graph Termination Checker
 *
 * Extracted from engine-advance.ts. Pure state-reader: inspects the engine
 * state graph, transitions to terminal phases when all nodes are quiescent,
 * and invokes the optional `onGraphTerminal` callback exactly once per
 * terminal type (complete / blocked).
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §3.3.
 */

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { EngineState } from "../../types.engine-v2.ts";
import { canTransitionPhase, transitionPhase } from "./engine-state.ts";
import { markEscalated } from "./node-lifecycle.ts";

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
 * Both terminal-event types use separate dedupe guards in `ctx` — each fires
 * at most once until the context is reset.
 *
 * A throwing consumer must not corrupt the advancing critical section
 * (mirrors _notifyCompletion conventions). A no-op when no callback is
 * registered.
 */
export function checkGraphTermination(
  state: EngineState,
  onGraphTerminal: ((event: GraphTerminalEvent) => void) | undefined,
  ctx: TerminationContext,
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
        break;
      default: break;
    }
  }

  const hasAnyActive = hasSchedulerActive || hasBlocked || hasPending;

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
    counts.escalate === 0 &&
    counts.timeout === 0 &&
    state.pendingCompletions.length === 0
  ) {
    // Runtime deadlock guard: pending node(s) exist with no running/ready
    // upstream to ever satisfy them, no blocked gate to resolve them, no
    // terminal error to surface (an escalated/timeout node means the graph is
    // in an error state awaiting orchestrator attention — never force-complete
    // that), and no deferred completion still to drain. This is an
    // unsatisfiable graph (e.g. an unrooted always-cycle, or an unprotected
    // cycle reachable only through a satisfied root that cannot feed it).
    //
    // Escalate every pending node (`pending → escalate` is a legal transition,
    // node-lifecycle.ts) so the graph quiesces, then transition to complete and
    // fire the terminal event. Without this the engine would sit in `executing`
    // forever and [GRAPH COMPLETE] would never fire.
    for (const node of state.nodes.values()) {
      if (node.status === NodeStatus.Pending) {
        markEscalated(state, node, DEADLOCK_REASON);
        counts.escalate += 1;
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
  // Dedupe: each terminal type fires at most once.
  if (isBlocked) {
    if (ctx.terminalBlocked) return;
    ctx.terminalBlocked = true;
  } else {
    if (ctx.terminalComplete) return;
    ctx.terminalComplete = true;
  }
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

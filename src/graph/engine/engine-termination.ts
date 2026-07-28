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
  let hasSchedulerActive = false;
  let hasBlocked = false;
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
      case NodeStatus.Pending:
        hasSchedulerActive = true;
        break;
      default: break;
    }
  }

  const hasAnyActive = hasSchedulerActive || hasBlocked;

  // Standard completion path: no active node remains.
  if (!hasAnyActive && canTransitionPhase(state, EnginePhase.Complete)) {
    transitionPhase(state, EnginePhase.Complete);
    fireGraphTerminal(state, onGraphTerminal, counts, false, ctx);
  } else if (!hasSchedulerActive && hasBlocked) {
    // Quiescent-blocked: no running/ready/pending nodes remain but ≥1
    // blocked node exists. The graph is paused, waiting on a human.
    // Do NOT transition the phase — executing stays executing.
    fireGraphTerminal(state, onGraphTerminal, counts, true, ctx);
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

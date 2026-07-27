/**
 * Graph Execution Engine v2 — Crash Recovery + Dispatch→Signal Reconcile
 *
 * Version: 3.0
 * Date: 2026-07-25
 *
 * The recovery half of the engine. When a process crashes mid-execution, the
 * persisted {@link EngineState} (written write-through by `engine-persistence.ts`)
 * survives, but the in-memory `onTaskTerminated` subscriptions and the advancing
 * critical section are gone. On restart the engine calls `recover()`, which:
 *
 * 1. Loads the persisted state (`engine-persistence.load`).
 * 2. Reconciles every `running` node against the live dispatch system
 *    (`getTask(taskId)`): a vanished task → `timeout`; a task that finished
 *    during the restart window → re-emit its terminating signal; a still-live
 *    task → re-subscribe its `onTaskTerminated` listener.
 * 3. Rebuilds the frontier from every `ready` node.
 * 4. Drains the deferred completions (nodes that finished during the window).
 *
 * This is the exact pattern proven by `LoopCoordinator.reSubscribeListeners()`
 * (`src/loop/coordinator.ts:662-729`), which this module mirrors
 * (orphaned→interrupted, terminal→advance, live→re-subscribe).
 *
 * This module also owns the shared **status→signal mapping** used by BOTH the
 * live dispatch seam (`engine-advance.ts::_dispatchNode`) and recovery:
 * `completed → answer`, `error → escalate` (with `task.error`), `timeout →
 * escalate`, `cancelled →` no terminating signal (the node is cancelled
 * directly). Keeping the mapping here means the two entry points can never
 * drift apart.
 *
 * Finally, this module ships the stale-lock {@link EngineLockSweeper}, matching
 * `src/loop/coordinator.ts:101-124` (engine-state-machine.md §3.4 / failure
 * resilience.md §5.6). The sweeper is **manually tickable** (`sweep`) and does
 * not start an unbounded `setInterval` on its own — `start()` is opt-in so
 * tests never leak a timer.
 *
 * Design references:
 * - `.rolebox/design/engine-state-machine.md` §5.1 (recovery entry point),
 *   §5.2 (idempotency), §5.4 (restart window), §5.6 (stale-lock sweeper).
 * - `.rolebox/design/failure-resilience.md` §5.1-§5.6.
 * - `src/loop/coordinator.ts:662-729` (proven re-subscribe pattern).
 */

import { NodeStatus } from "../../constants.ts";
import {
  SWEEPER_INTERVAL_MS,
  ADVANCING_LOCK_TIMEOUT_MS,
} from "../../loop/constants.ts";
import type { DispatchTask } from "../../dispatch/types.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";
import { releaseAdvancingLock } from "./engine-state.ts";
import { markCancelled, markTimedOut } from "./node-lifecycle.ts";
import { bindNodeState } from "./recorder.ts";
import type { SignalType } from "./signal-bridge.ts";
import type { TaskTerminatedCallback } from "./dispatch-bridge.ts";

// ── Constants ────────────────────────────────────────────────────────────────

/** Error reason stamped on a node whose dispatch task vanished during restart. */
export const ORPHAN_REASON = "Worker task vanished during restart";

/** Dispatch statuses that ended the task — its termination was missed. */
export const TERMINAL_DISPATCH_STATUSES = new Set<string>([
  "completed",
  "error",
  "cancelled",
  "timeout",
]);

/** Dispatch statuses that are still live — re-subscribe, never re-dispatch. */
export const LIVE_DISPATCH_STATUSES = new Set<string>([
  "running",
  "pending",
  "awaiting_approval",
]);

// ── Ports / types ────────────────────────────────────────────────────────────

/**
 * The dispatch surface recovery needs. Structurally satisfied by
 * {@link NodeDispatchPort} (`engine-advance.ts`) — a node dispatch port is a
 * superset of this. Both members are optional so test fakes and minimal ports
 * can omit the recovery half; every consumer guards on presence.
 */
export interface DispatchRecoveryPort {
  /** Look up a task's current status (mirrors `DispatchManager.getTask`). */
  getTask?(taskId: string): DispatchTask | undefined;
  /** Register a one-time listener for a task's terminal transition. */
  onTaskTerminated?(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void;
}

/** A dispatch status mapped to a terminating engine signal (answer | escalate). */
export interface DispatchStatusSignal {
  type: SignalType;
  payload: unknown;
}

/** A node whose completion was missed during restart, ready to re-emit. */
export interface DeferredSignal {
  nodeId: string;
  type: SignalType;
  payload: unknown;
}

/** What recovery reconciled, for diagnostics and tests. */
export interface ReconcileReport {
  /** Nodes whose live tasks were re-subscribed (waiting for termination). */
  reSubscribed: string[];
  /** Nodes whose tasks vanished → marked `timeout` (and re-emitted as escalate). */
  timedOut: string[];
  /** Nodes that finished during the window → their terminating signal re-emitted. */
  deferred: DeferredSignal[];
}

/** The signal-drive callback used to advance the graph on a task termination. */
export type RecoveryEmitSignal = (
  nodeId: string,
  type: SignalType,
  payload: unknown,
) => void;

// ── Status → signal mapping (shared by live seam + recovery) ────────────────

/**
 * Map a dispatch task's terminal status to the terminating engine signal that
 * advances its node:
 *
 * - `completed` → `answer` (forward data flow runs).
 * - `error`     → `escalate` (payload carries `task.error`).
 * - `timeout`   → `escalate` (a timed-out worker is an unrecoverable failure).
 * - `cancelled` → `null` — a cancellation is not a terminating signal; the node
 *   is cancelled directly by the caller instead.
 * - any other status → `null` (non-terminal: running / pending / awaiting).
 */
export function mapDispatchStatusToSignal(
  status: string,
  task?: DispatchTask,
): DispatchStatusSignal | null {
  switch (status) {
    case "completed":
      return { type: "answer", payload: null };
    case "error":
      return {
        type: "escalate",
        payload: { error: task?.error ?? "dispatch task errored" },
      };
    case "timeout":
      return {
        type: "escalate",
        payload: { error: "dispatch task timed out" },
      };
    default:
      return null; // cancelled + non-terminal statuses
  }
}

// ── Re-subscription (live seam + recovery share this) ───────────────────────

/**
 * Register a one-time `onTaskTerminated` listener for a node's in-flight
 * dispatch task and route the terminal transition back into the graph via
 * {@link emitSignal} (which records a terminating signal → advances the engine).
 *
 * Guarded so a stale listener (from a superseded dispatch task id, or a node
 * the engine already moved past `running`) can never advance a node twice:
 * - the node's `dispatchTaskId` must still match the completed task id;
 * - the node must still be `running` (a cancellation that the engine already
 *   applied — e.g. via the cascade canceller — is skipped).
 *
 * When the dispatch task reports `cancelled`, the node is cancelled directly
 * (`running → cancelled`) — there is no terminating signal to record.
 */
export function subscribeTaskTermination(
  state: EngineState,
  port: DispatchRecoveryPort,
  node: NodeRuntimeState,
  emitSignal: RecoveryEmitSignal,
): void {
  const taskId = node.dispatchTaskId;
  if (!taskId || !port.onTaskTerminated) return;
  const nodeId = node.nodeId;

  port.onTaskTerminated(taskId, (completedTaskId, status) => {
    const current = state.nodes.get(nodeId);
    if (!current) return;
    if (current.dispatchTaskId !== completedTaskId) return; // superseded task
    if (current.status !== NodeStatus.Running) return; // already advanced / cancelled
    if (status === "cancelled") {
      markCancelled(current, "dispatch task cancelled");
      return;
    }
    const task = safeGetTask(port, completedTaskId);
    const sig = mapDispatchStatusToSignal(status, task);
    if (!sig) return;
    emitSignal(nodeId, sig.type, sig.payload);
  });
}

// ── Per-node reconciliation ──────────────────────────────────────────────────

/**
 * Reconcile every `running` node against the dispatch system
 * (failure-resilience.md §5.2):
 *
 * - no `dispatchTaskId`, or `getTask` returns undefined → orphaned → the node
 *   is marked `timeout` with {@link ORPHAN_REASON} and queued for an `escalate`
 *   re-emit so its failure propagates (it must not silently stall a join).
 * - terminal dispatch status → the termination was missed during the window:
 *   `cancelled` cancels the node in place; `completed` / `error` / `timeout`
 *   queue the mapped terminating signal for re-emission.
 * - live status → re-subscribe the `onTaskTerminated` listener (the node keeps
 *   running and will advance when the task finally terminates).
 *
 * This is a **pure decision pass** — it marks terminal nodes and records
 * re-subscriptions, but never dispatches and never awaits. The caller re-emits
 * {@link ReconcileReport.deferred} (awaiting each) and then dispatches the
 * rebuilt frontier.
 */
export function reconcileEngine(
  state: EngineState,
  port: DispatchRecoveryPort,
  emitSignal: RecoveryEmitSignal,
): ReconcileReport {
  const reSubscribed: string[] = [];
  const timedOut: string[] = [];
  const deferred: DeferredSignal[] = [];

  for (const node of state.nodes.values()) {
    if (node.status !== NodeStatus.Running) continue;

    const taskId = node.dispatchTaskId;
    if (!taskId) {
      markTimedOut(node, ORPHAN_REASON);
      timedOut.push(node.nodeId);
      deferred.push({
        nodeId: node.nodeId,
        type: "escalate",
        payload: { error: ORPHAN_REASON },
      });
      continue;
    }

    const task = safeGetTask(port, taskId);
    if (!task) {
      markTimedOut(node, ORPHAN_REASON);
      timedOut.push(node.nodeId);
      deferred.push({
        nodeId: node.nodeId,
        type: "escalate",
        payload: { error: ORPHAN_REASON },
      });
      continue;
    }

    if (TERMINAL_DISPATCH_STATUSES.has(task.status)) {
      if (task.status === "cancelled") {
        markCancelled(node, "dispatch task cancelled during restart");
      } else {
        const sig = mapDispatchStatusToSignal(task.status, task);
        if (sig) {
          deferred.push({
            nodeId: node.nodeId,
            type: sig.type,
            payload: sig.payload,
          });
        }
      }
      continue;
    }

    // Still live → re-subscribe for future termination.
    subscribeTaskTermination(state, port, node, emitSignal);
    reSubscribed.push(node.nodeId);
  }

  return { reSubscribed, timedOut, deferred };
}

// ── Frontier rebuild ─────────────────────────────────────────────────────────

/**
 * Rebuild the frontier from every node whose lifecycle status is `ready`.
 *
 * Divergence from design: engine-state-machine.md §5.1 step 4 says "ready +
 * joinSatisfied". In the implemented engine a node is only transitioned to
 * `ready` when it is either a provisioned root (no join needed —
 * `joinSatisfied` stays false by construction) or a downstream node whose join
 * just became satisfied. So `status === ready` alone is the correct and complete
 * dispatch predicate — additionally requiring `joinSatisfied` would strand
 * ready root nodes. Every ready node is, by invariant, dispatchable.
 */
export function rebuildFrontier(state: EngineState): string[] {
  const ready: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.status === NodeStatus.Ready) ready.push(node.nodeId);
  }
  state.frontier = ready;
  state.updatedAt = Date.now();
  return [...state.frontier];
}

// ── Hydrate (adopt a loaded persisted state in place) ────────────────────────

/**
 * Copy a loaded {@link EngineState} (from `engine-persistence.load`) into the
 * live state object the {@link AdvanceEngine} already references. Persistence
 * always saved this very object, so the loaded content is semantically
 * identical; copying in place keeps the advance engine's reference valid
 * (it reads `state.nodes` / `state.frontier` dynamically).
 */
export function hydrateEngineState(
  target: EngineState,
  source: EngineState,
): void {
  target.phase = source.phase;
  target.graphId = source.graphId;
  target.graphDeclaration = source.graphDeclaration;
  target.nodes = source.nodes;
  target.edges = source.edges;
  target.loopGroups = source.loopGroups;
  target.frontier = source.frontier;
  target.budget = source.budget;
  target.signalLedger = source.signalLedger;
  target.startedAt = source.startedAt;
  target.updatedAt = source.updatedAt;
  target.advancingLock = source.advancingLock;
  target.pendingCompletions = source.pendingCompletions;
  // Re-bind recovered nodes to the LIVE target state so post-recovery lifecycle
  // transitions auto-save checkpoints into `target.checkpoints`, not into the
  // deserialized intermediate container (subtask C-RECORD).
  for (const node of target.nodes.values()) {
    bindNodeState(node, target);
  }
}

// ── Stale critical-section state ─────────────────────────────────────────────

/**
 * Clear the critical-section state a crashed process left behind: the
 * `advancingLock` may be stuck `true` (an exception escaped the `finally`, or
 * the process died mid-advance) and `pendingCompletions` may be non-empty.
 * In this fresh process no critical section is actually running, so the lock is
 * released and the orphaned deferred queue dropped (reconciliation re-derives
 * every running node's outcome from the dispatch system instead).
 */
export function clearStaleCriticalSection(state: EngineState): void {
  if (state.advancingLock) {
    releaseAdvancingLock(state);
  }
  state.pendingCompletions = [];
  state.updatedAt = Date.now();
}

// ── Stale-lock sweeper ───────────────────────────────────────────────────────

/** Options for {@link EngineLockSweeper}. */
export interface LockSweeperOptions {
  /** Sweep interval for `start()` (defaults to `SWEEPER_INTERVAL_MS`). */
  intervalMs?: number;
  /** How long a lock may stay held before it is released (defaults to `ADVANCING_LOCK_TIMEOUT_MS`). */
  lockTimeoutMs?: number;
  /** Called when the sweeper releases a stale lock. */
  onRelease?: (graphId: string) => void;
}

/**
 * Stale-lock sweeper, mirroring `src/loop/coordinator.ts:101-124`
 * (engine-state-machine.md §3.4 / failure-resilience.md §5.6). The engine's
 * advancing critical section is guarded by `state.advancingLock`; if an
 * exception ever escapes the `finally` (or a process is killed mid-advance) the
 * lock can stay `true` and deadlock every subsequent signal. The sweeper
 * detects a lock held past {@link ADVANCING_LOCK_TIMEOUT_MS} and releases it.
 *
 * The engine tracks the lock with a plain boolean, so the sweeper remembers its
 * own first-observed-held timestamp per graph. A lock observed held for the
 * first time is recorded; it is only released once it has been *continuously*
 * held for the full timeout — a briefly-held lock is never touched.
 *
 * Test-control: the sweeper is **manually tickable** via {@link sweep}
 * (accepting an injectable `now` for deterministic tests) and never starts a
 * timer on its own. `start()` (the periodic `setInterval`) is opt-in — tests
 * drive {@link sweep} directly instead, so no unbounded interval leaks.
 */
export class EngineLockSweeper {
  private readonly intervalMs: number;
  private readonly lockTimeoutMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly firstSeen = new Map<string, number>();

  constructor(private readonly opts: LockSweeperOptions = {}) {
    this.intervalMs = opts.intervalMs ?? SWEEPER_INTERVAL_MS;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? ADVANCING_LOCK_TIMEOUT_MS;
  }

  /**
   * One sweep tick. Returns `true` when a stale lock was released.
   *
   * @param now Optional clock for deterministic tests (defaults to `Date.now`).
   */
  sweep(state: EngineState, now: number = Date.now()): boolean {
    const id = state.graphId;
    if (state.advancingLock) {
      if (!this.firstSeen.has(id)) {
        this.firstSeen.set(id, now);
        return false;
      }
      const first = this.firstSeen.get(id)!;
      if (now - first >= this.lockTimeoutMs) {
        releaseAdvancingLock(state);
        this.firstSeen.delete(id);
        this.opts.onRelease?.(id);
        return true;
      }
      return false;
    }
    // Lock released externally — forget any first-seen timestamp.
    this.firstSeen.delete(id);
    return false;
  }

  /** Start the periodic sweep. Opt-in — never auto-started. */
  start(state: EngineState): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.sweep(state);
      } catch {
        // A sweep must never take down the process.
      }
    }, this.intervalMs);
    // Don't keep the process alive just because a sweep interval is pending.
    (this.timer as (typeof this.timer) & { unref?: () => unknown })?.unref?.();
  }

  /** Stop the periodic sweep (no-op if never started). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Defensive `getTask` — a throwing/lacking port yields `undefined`. */
function safeGetTask(
  port: DispatchRecoveryPort,
  taskId: string,
): DispatchTask | undefined {
  if (!port.getTask) return undefined;
  try {
    return port.getTask(taskId);
  } catch {
    return undefined;
  }
}

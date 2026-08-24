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
 * Finally, this module ships the stale-lock {@link EngineLockSweeper}, the
 * stale-node {@link NodeStalenessWatcher} (monitor M3), and the heartbeat-based
 * {@link NodeLivenessMonitor} (node-anomaly-detection subtask 3), matching
 * `src/loop/coordinator.ts:101-124` (engine-state-machine.md §3.4 / failure
 * resilience.md §5.6). All are **manually tickable** and do not start an
 * unbounded `setInterval` on their own — `start()` is opt-in so tests never
 * leak a timer.
 *
 * Hydrate/adopt completeness (H3 / L7 / M10): `hydrateEngineState` and
 * `adoptPriorNodeStates` carry the monitor-relevant graph state across
 * recovery and rebuilds — the append-only `checkpointHistory` (H3), per-node
 * `artifacts` / `evidence` and loop-group `convergenceFingerprint` (L7), and
 * the cross-restart `terminalNotified` dedup flags (M10). `subscribeTaskTermination`
 * returns its registered callback (M4) so callers can later
 * `removeTaskTerminatedListener`; `reconcileEngine` surfaces the re-subscribed
 * `{ taskId, callback }` pairs through an optional out-parameter.
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
import type { UsageRecord } from "../../dispatch/budget/budget-tracker.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";
import { computeInDegrees, releaseAdvancingLock, removeFromFrontier, applyBudgetDelta } from "./engine-state.ts";
import { markCancelled, markTimedOut } from "./node-lifecycle.ts";
import {
  cloneCheckpointHistory,
  markDirty,
  markNonCriticalDirty,
} from "./engine-persistence.ts";
import { recordCheckpointForNode } from "./recorder.ts";
import type { SignalType } from "./signal-bridge.ts";
import { TERMINATING_SIGNALS } from "./signal-bridge.ts";
import type { TaskTerminatedCallback } from "./dispatch-bridge.ts";
import { sessionSignalLedger } from "../../signal/session-signal-ledger.ts";

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
  /**
   * Cumulative token/cost usage for a single dispatched session (keyed by the
   * dispatch session ID). OPTIONAL-ADDITIVE — a port without it simply cannot
   * report per-node usage, so the engine degrades to the pre-Phase-7 behavior
   * (zero consumption). Structurally satisfied by {@link DispatchBridge}
   * (`dispatch-bridge.ts:getSessionUsage`). Consumed by {@link captureNodeUsage}
   * to populate `node.tokensConsumed` at task termination.
   */
  getSessionUsage?(sessionId: string): UsageRecord;
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

/**
 * Re-subscription handles surfaced to callers (monitor M4). Passed as an
 * optional out-parameter to {@link reconcileEngine}; when supplied, every live
 * re-subscription made by the pass is recorded here so the caller can later
 * remove the listener (via `removeTaskTerminatedListener(taskId, callback)`)
 * once the node is no longer running.
 */
export interface ReconcileSubscriptions {
  /**
   * Re-subscribed live tasks and the exact callbacks handed to
   * `port.onTaskTerminated`. The callback is the value returned by
   * {@link subscribeTaskTermination}, so it is safe to pass back to
   * `removeTaskTerminatedListener`.
   */
  listeners: Array<{ taskId: string; callback: TaskTerminatedCallback }>;
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
 * - `completed` → `answer` (forward data flow runs). When the subtask emitted a
 *   real terminating signal (`task.terminatingSignal`), it is preserved
 *   including the signal type (e.g. `revise_needed` / `escalate` / `answer`)
 *   so loop back-edges and other signal consumers activate correctly. When no
 *   terminating signal was recorded, the payload is tagged `{ __inferred: true }`
 *   — this is a best-effort inference that the task "just finished", emitted so
 *   downstream join evaluation and signal routing never silently stall.
 * - `error`     → `escalate` (payload carries `task.error`).
 * - `timeout`   → `escalate` (a timed-out worker is an unrecoverable failure).
 * - `cancelled` → `null` — a cancellation is not a terminating signal; the node
 *   is cancelled directly by the caller instead.
 * - HITL statuses (`awaiting_approval` — the paused task's status — plus
 *   `need_approval` / `blocked` / `need_clarification` — the signal types the
 *   completion evaluator delivers) → the pausing `need_approval` signal. The
 *   engine advances a declared `needs_approval` node `running → blocked` on it
 *   (engine-advance.ts `_pauseForApproval`), so `[GRAPH BLOCKED]` fires instead
 *   of the HITL termination being dropped at `subscribeTaskTermination`'s
 *   `if (!sig) return;`. A node NOT declared `needs_approval` keeps today's
 *   semantics (record-only; resumes when a human uses approve/reject).
 * - any other status → `null` (non-terminal: running / pending).
 */
export function mapDispatchStatusToSignal(
  status: string,
  task?: DispatchTask,
): DispatchStatusSignal | null {
  switch (status) {
    case "completed": {
      // When the sub-agent emitted a real terminating signal (revise_needed,
      // escalate, answer) that was recorded in the function runtime state and
      // carried through by the completion evaluator, use it instead of the
      // hardcoded answer default. This preserves the signal type so loop
      // back-edges (on_signal(revise_needed)) and other terminating-signal
      // consumers activate correctly.
      if (task?.terminatingSignal && TERMINATING_SIGNALS.has(task.terminatingSignal.type)) {
        return {
          type: task.terminatingSignal.type as SignalType,
          payload: task.terminatingSignal.payload,
        };
      }
      // Last-resort: when the task object lacks terminatingSignal, check the
      // sessionSignalLedger. The completion evaluator records the real
      // terminating signal in the ledger before propagating it to the task
      // object; in rare timing/ordering edge cases, the signal may exist in the
      // ledger but not yet on the task.
      if (task?.sessionId) {
        const ledgerSignal = sessionSignalLedger.getTerminating(task.sessionId);
        if (ledgerSignal) {
          logWarn(
            `engine-recovery: recovered terminating signal from sessionSignalLedger ` +
            `(sessionId=${task.sessionId}, taskId=${task.id}) — ` +
            `type=${ledgerSignal.type}`,
          );
          return {
            type: ledgerSignal.type as SignalType,
            payload: ledgerSignal.payload,
          };
        }
      }
      // No terminating signal recorded anywhere — infer an "answer" with a
      // marker so downstream routing never silently drops the node's completion.
      logInfo(
        `engine-recovery: no terminatingSignal recorded for completed task ` +
        `(sessionId=${task?.sessionId ?? "unknown"}, taskId=${task?.id ?? "unknown"}) — ` +
        `inferred answer signal`,
      );
      return { type: "answer", payload: { __inferred: true } };
    }
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
    // HITL pause statuses (F1 bridge): when the completion evaluator pauses a
    // task for a human decision (completion-evaluator.ts:53 transitions it to
    // `awaiting_approval` and :99 delivers the HITL signal type via
    // notifyTerminated), map to the engine's pausing `need_approval` signal so
    // `subscribeTaskTermination`'s `if (!sig) return;` never silently drops a
    // HITL termination. `cancelled` / `running` / `pending` stay `null`.
    case "awaiting_approval":
    case "need_approval":
    case "blocked":
    case "need_clarification":
      return {
        type: "need_approval",
        payload: { hitl: status, ...(task ? { taskId: task.id } : {}) },
      };
    default:
      return null; // cancelled + non-terminal statuses
  }
}

/**
 * Whether a dispatch task is currently STILL LIVE (running / pending /
 * awaiting_approval) per the dispatch port's authoritative `getTask` read.
 *
 * Backs the transient-error guard in {@link subscribeTaskTermination} and the
 * `_dispatchNode` race-guard (`engine-advance.ts`): when a dispatch termination
 * reports a status of `error`, the engine re-checks liveness before committing
 * the node to `escalate`. A transient execution error must never latch a node as
 * a terminal error while the underlying session continues — so if the
 * authoritative read shows the task is still live, the reported `error` is
 * treated as stale and the escalate is skipped (the node stays running).
 *
 * A missing `getTask` port, a vanished task, or a throwing read all resolve to
 * `false` (NOT live) — the conservative "genuine terminal" default — so a
 * reported error that cannot be re-confirmed as live still escalates.
 */
export function isDispatchTaskLive(
  port: DispatchRecoveryPort,
  taskId: string,
): boolean {
  if (!port.getTask) return false;
  const task = safeGetTask(port, taskId);
  return !!task && LIVE_DISPATCH_STATUSES.has(task.status);
}

// ── Per-node usage capture (Phase-7 per-node consumption) ───────────────────

/**
 * Record a node's per-session token/cost consumption into `node.tokensConsumed`
 * from the dispatch layer's budget tracker.
 *
 * Background: `node.tokensConsumed` was historically only ever assigned by
 * `adoptPriorNodeStates` (copying a prior run), so a freshly executed node
 * always reported zero per-node consumption. The dispatch subsystem tracks
 * usage per dispatched session (`BudgetTracker.getSessionUsage(sessionId)`,
 * keyed by the node's `dispatchSessionId`), so this helper reads that record at
 * task termination and writes it onto the node.
 *
 * Semantics (minimal honest path):
 * - **Replace, not accumulate.** The node's `tokensConsumed` is set to the
 *   terminating session's usage. This is idempotent across the live-seam,
 *   race-guard, and recovery paths (which may both observe the same
 *   termination), so it cannot double-count. The residual gap — a node that
 *   re-dispatches multiple sessions (retry / loop re-entry) reflects only the
 *   LAST session's usage, not the cumulative total — is documented in
 *   `docs/graph-engine-architecture.md`.
 * - **Zero-guard.** When the tracker reports all-zero usage (the session was
 *   never sampled, or usage was reset), the node's existing value is left
 *   untouched rather than clobbered to zero — so an adopted prior value is not
 *   erased by a transient zero read.
 * - **Best-effort.** A throwing or absent `getSessionUsage` is a no-op that
 *   never corrupts node advancement.
 *
 * @param state  Engine state (used to mark the mutation dirty for persistence).
 * @param node   The node whose `dispatchSessionId` identifies the session.
 * @param port   The dispatch port exposing `getSessionUsage` (optional).
 */
export function captureNodeUsage(
  state: EngineState,
  node: NodeRuntimeState,
  port: DispatchRecoveryPort,
): void {
  if (!port.getSessionUsage) return;
  const sessionId = node.dispatchSessionId;
  if (!sessionId) return;
  try {
    const usage = port.getSessionUsage(sessionId);
    if (!usage) return;
    if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cost === 0) {
      return; // zero-guard — never clobber an adopted/prior value with a zero read
    }
    node.tokensConsumed.inputTokens = usage.inputTokens;
    node.tokensConsumed.outputTokens = usage.outputTokens;
    node.tokensConsumed.cost = usage.cost;
    // Per-node token counters are non-critical churn — route through the
    // debounced tier rather than forcing a synchronous write.
    markNonCriticalDirty(state);
  } catch {
    // best-effort — a throwing tracker must never corrupt node advancement
  }
}

// ── Re-subscription (live seam + recovery share this) ───────────────────────

/**
 * Register a one-time `onTaskTerminated` listener for a node's in-flight
 * dispatch task. This is the **single delivery seam** for dispatch→signal
 * routing — every dispatch termination (live or recovery) funnels through
 * {@link emitSignal}, which records a terminating signal and advances the
 * engine. The post-registration race-condition guard in _dispatchNode
 * (engine-advance.ts) catches already-terminal tasks via a deferred completion
 * instead of duplicating the emitSignal path, so this callback owns the
 * exclusive `signalBridge.record()` call.
 *
 * Guarded so a stale listener (from a superseded dispatch task id, or a node
 * the engine already moved past `running`) can never advance a node twice:
 * - the node's `dispatchTaskId` must still match the completed task id;
 * - the node must still be `running` (a cancellation that the engine already
 *   applied — e.g. via the cascade canceller — or a deferred completion that
 *   drained earlier in the same critical section — is skipped).
 *
 * When the dispatch task reports `cancelled`, the node is cancelled directly
 * (`running → cancelled`) — there is no terminating signal to record.
 *
 * Transient-error guard (subtask 4): a reported `error` is re-checked against
 * the dispatch port's authoritative `getTask` read via {@link isDispatchTaskLive}.
 * If the task is still live (running / pending / awaiting_approval), the `error`
 * is treated as stale — a transient execution error must not latch the node as a
 * terminal error while the underlying session continues — so the escalate is
 * skipped, the node stays `running`, and the listener is re-subscribed so a
 * genuine later termination still advances it.
 *
 * M9 listener-ledger escape (review 04-F5): the transient-error re-subscription
 * registers a NEW listener whose callback would otherwise escape the caller's
 * subscription ledger — dispose() could never unregister it and the zombie
 * callback would carry a disposed engine's `state`/`emitSignal` closures when it
 * finally fired. The optional `out` collector captures every such re-subscribed
 * `{ taskId, callback }` pair so the caller can register it into its ledger
 * (engine-advance.ts `_dispatchNode` passes its `_terminationSubscriptions`).
 *
 * Returns the exact callback handed to `port.onTaskTerminated` (monitor M4), so
 * a caller that no longer needs the subscription can pass it to
 * `removeTaskTerminatedListener(taskId, callback)`. Returns `undefined` when
 * there is nothing to subscribe (no task id, or a port without the listener
 * surface).
 */
export function subscribeTaskTermination(
  state: EngineState,
  port: DispatchRecoveryPort,
  node: NodeRuntimeState,
  emitSignal: RecoveryEmitSignal,
  out?: Array<{ taskId: string; callback: TaskTerminatedCallback }>,
): TaskTerminatedCallback | undefined {
  const taskId = node.dispatchTaskId;
  if (!taskId || !port.onTaskTerminated) return undefined;
  const nodeId = node.nodeId;

  const callback: TaskTerminatedCallback = (completedTaskId, status) => {
    const current = state.nodes.get(nodeId);
    if (!current) return;
    if (current.dispatchTaskId !== completedTaskId) return; // superseded task
    if (current.status !== NodeStatus.Running) return; // already advanced / cancelled
    // Record the terminated task's token/cost consumption (Phase-7 gap) before
    // the node advances. Idempotent replace — safe across the live-seam /
    // race-guard double-observation of the same termination.
    captureNodeUsage(state, current, port);
    // Session-slot refund (the graph-level mirror of S4's `decRequestSessions`):
    // a cancelled / timed-out dispatch task refunds its net-live session slot
    // (the dispatch layer refunds cancelled/timeout tasks only; completed /
    // error / blocked keep counting). The graph-declared session cap was
    // removed, so this refund no longer gates dispatch — `sessionsSpawned`
    // remains a NET-LIVE display counter, and the -1 refund keeps it accurate.
    if (status === "cancelled" || status === "timeout") {
      applyBudgetDelta(state, { sessions: -1 });
    }
    if (status === "cancelled") {
      markCancelled(state, current, "dispatch task cancelled");
      return;
    }
    // Transient-error guard: a reported `error` may be stale — the underlying
    // session could have recovered and the task returned to a live status
    // (running / pending / awaiting_approval). Re-check via the dispatch port
    // before committing the node to `escalate`. When the task is still live,
    // skip the escalate (keep the node running) and re-subscribe so a genuine
    // later termination still advances the node.
    if (status === "error" && isDispatchTaskLive(port, completedTaskId)) {
      logWarn(
        `engine-recovery: dispatch reported error for task ${completedTaskId} ` +
        `(node ${nodeId}) but the task is still live — skipping escalate, ` +
        `keeping node running`,
      );
      // M9: the re-subscription is a NEW `onTaskTerminated` registration that
      // must be removable by the caller's teardown (dispose) exactly like the
      // original — collect its `{ taskId, callback }` pair into the optional
      // ledger instead of discarding it, so no zombie callback escapes the
      // engine's subscription ledger (review 04-F5).
      const reSubscribed = subscribeTaskTermination(
        state,
        port,
        current,
        emitSignal,
        out,
      );
      if (reSubscribed && out) {
        out.push({ taskId: completedTaskId, callback: reSubscribed });
      }
      return;
    }
    const task = safeGetTask(port, completedTaskId);
    const sig = mapDispatchStatusToSignal(status, task);
    if (!sig) return;
    emitSignal(nodeId, sig.type, sig.payload);
  };

  port.onTaskTerminated(taskId, callback);
  return callback;
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
  out?: ReconcileSubscriptions,
): ReconcileReport {
  const reSubscribed: string[] = [];
  const timedOut: string[] = [];
  const deferred: DeferredSignal[] = [];

  for (const node of state.nodes.values()) {
    if (node.status !== NodeStatus.Running) continue;

    const taskId = node.dispatchTaskId;
    if (!taskId) {
      markTimedOut(state, node, ORPHAN_REASON);
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
      markTimedOut(state, node, ORPHAN_REASON);
      timedOut.push(node.nodeId);
      deferred.push({
        nodeId: node.nodeId,
        type: "escalate",
        payload: { error: ORPHAN_REASON },
      });
      continue;
    }

    if (TERMINAL_DISPATCH_STATUSES.has(task.status)) {
      // M8 transient-error guard (recovery parity): a reported `error` may be
      // stale — the authoritative dispatch read (`isDispatchTaskLive`) shows
      // the task still live (running / pending / awaiting_approval), i.e. the
      // restart window overlapped a transient execution error whose session is
      // still continuing. Committing the node to escalate here would latch it
      // terminal and the genuine later termination could never advance it —
      // the exact asymmetry review M8 / 04-F4 flagged against
      // `subscribeTaskTermination`'s live-seam guard (lines 426-434) and
      // `_dispatchNode`'s race-guard return (engine-advance.ts:1689-1694).
      // Route into the re-subscribe branch instead: the node stays `running`
      // and the listener (or a later reconcile) advances it on a real
      // termination. The task is not terminated, so no usage capture runs.
      if (task.status === "error" && isDispatchTaskLive(port, taskId)) {
        logWarn(
          `engine-recovery: reconcile saw error status for task ${taskId} ` +
          `(node ${node.nodeId}) but the task is still live — skipping escalate, ` +
          `keeping node running and re-subscribing`,
        );
        const callback = subscribeTaskTermination(state, port, node, emitSignal);
        reSubscribed.push(node.nodeId);
        // Surface the { taskId, callback } pair so the caller can later
        // removeTaskTerminatedListener (monitor M4) once the node stops running.
        if (callback && out) {
          out.listeners.push({ taskId, callback });
        }
        continue;
      }
      // Record the finished-during-restart task's consumption (Phase-7 gap)
      // before the deferred signal is emitted. Idempotent replace.
      captureNodeUsage(state, node, port);
      if (task.status === "cancelled") {
        markCancelled(state, node, "dispatch task cancelled during restart");
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
    const callback = subscribeTaskTermination(state, port, node, emitSignal);
    reSubscribed.push(node.nodeId);
    // Surface the { taskId, callback } pair so the caller can later
    // removeTaskTerminatedListener (monitor M4) once the node stops running.
    if (callback && out) {
      out.listeners.push({ taskId, callback });
    }
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
  // L21 (review 05-F5): `frontier` is a persistent field — the choke-point
  // contract (engine-persistence.ts:73-83) requires markDirty after mutating
  // it. Without this, a recover() whose reconcile-failure catch path
  // (index.ts:1091-1093) runs rebuildFrontier + dispatchReady with no other
  // mutation would drop the frontier recomputation from disk — the rebuilt
  // ready set would only survive if an unrelated critical-section mutation
  // happened to set the flag.
  markDirty(state);
  return [...state.frontier];
}

// ── Hydrate (adopt a loaded persisted state in place) ────────────────────────

/**
 * Clear every node's `loopGroupId` that names a loop group the current graph
 * declaration does not declare.
 *
 * Subtask-5 dangling-loop-group guard. A node whose `loopGroupId` points at a
 * dropped group would otherwise be routed into {@link executeLoopStep} as a
 * loop member, where a `revise_needed` is fabricated into a `converged`
 * outcome — silently swallowed (no re-entry, no escalation, no traversal
 * accounting; an unbounded loop or a lost revision) — and a convergence-tracker
 * touch (`recordConvergenceOutput` / `resetConvergenceTracker`) throws on the
 * missing group. The declaration is the source of truth for membership; a
 * stale id is cleared so the node degrades to a plain non-loop node.
 */
function clearUndeclaredLoopGroupIds(state: EngineState): void {
  const declared = new Set<string>();
  for (const group of state.graphDeclaration.loop_groups ?? []) {
    declared.add(group.id);
  }
  for (const node of state.nodes.values()) {
    if (node.loopGroupId !== undefined && !declared.has(node.loopGroupId)) {
      node.loopGroupId = undefined;
    }
  }
}

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
  target.loopGroups = source.loopGroups;
  // Subtask-5 dangling-loop-group guard: a persisted state whose declaration
  // dropped a loop group may still carry member nodes tagged with the stale
  // loopGroupId (the node map is adopted wholesale). Clear any such tag — a
  // dangling id would route the node into executeLoopStep, which fabricates
  // `converged` for a revise_needed (silently swallowing the revision) or
  // throws on the missing group's convergence tracker.
  clearUndeclaredLoopGroupIds(target);
  target.frontier = source.frontier;
  target.budget = source.budget;
  // Deep-clone signalLedger (Map) to avoid shared-mutation between source/target.
  const clonedLedger = new Map<string, typeof source.signalLedger extends Map<string, infer V> ? V : never>();
  for (const [nodeId, entry] of source.signalLedger) {
    clonedLedger.set(nodeId, {
      ...entry,
      signals: { ...entry.signals },
      history: entry.history ? [...entry.history] : undefined,
    });
  }
  target.signalLedger = clonedLedger as typeof source.signalLedger;
  target.startedAt = source.startedAt;
  target.updatedAt = source.updatedAt;
  target.advancingLock = source.advancingLock;
  target.pendingCompletions = source.pendingCompletions;
  // Runtime-only dirty flags are never adopted from a persisted source — a
  // recovered state starts clean (critical and non-critical both false).
  target.isDirty = false;
  target.isNonCriticalDirty = false;
  target.checkpoints = source.checkpoints
    ? Object.fromEntries(
        Object.entries(source.checkpoints).map(([id, r]) => [id, { ...r }])
      )
    : undefined;
  // OPTIONAL-ADDITIVE (H3): the append-only per-node checkpoint history is
  // deep-cloned exactly like `checkpoints` so the source and target never share
  // record arrays. Absent → undefined (no fabricated value).
  target.checkpointHistory = cloneCheckpointHistory(source.checkpointHistory);
  // OPTIONAL-ADDITIVE (monitor M10): cross-restart termination-notification
  // dedup flags are durable graph state — copied, never aliased. Absent →
  // undefined.
  target.terminalNotified = source.terminalNotified
    ? { ...source.terminalNotified }
    : undefined;
}

// ── Prior-state adoption (incremental graph rebuild) ────────────────────────

/**
 * Adopt a *prior* engine run's per-node progress into a freshly provisioned
 * state (same graph id, possibly a superset declaration).
 *
 * This backs the imperative `graph_*` tool flow where the toolset rebuilds a
 * fresh engine from the declaration after every mutation (`graph_add_node`) and
 * on every `graph_run`. Without adoption, a rebuild resets every node to
 * `ready`/`pending`, so a second `graph_run` re-dispatches nodes that already
 * completed — the "completed node re-run" bug.
 *
 * For every node present in BOTH states whose prior status is not `pending`
 * (i.e. it made real progress), the prior run's execution fields are copied
 * onto the freshly provisioned node **in place** (the target node object stays
 * bound to its owning state for checkpoint recording). The frontier is then
 * corrected: adopted non-`ready` nodes leave the frontier; adopted `ready`
 * nodes (re-entered by a prior retry/revise) are kept dispatchable.
 *
 * Nodes that exist only in the new declaration are untouched (fresh
 * `pending`/`ready` as provisioned). A prior node whose `agent` no longer
 * matches is skipped — its identity changed, so a fresh run is correct.
 *
 * Graph-level progress is carried too: budget counters, the signal ledger,
 * checkpoints, and loop-group traversal counts (so loop caps stay honest
 * across rebuilds).
 */
export function adoptPriorNodeStates(
  target: EngineState,
  prior: EngineState,
): void {
  for (const [nodeId, prev] of prior.nodes) {
    const node = target.nodes.get(nodeId);
    if (!node) continue; // node removed / renamed — nothing to adopt
    if (prev.status === NodeStatus.Pending) continue; // no progress to carry
    if (prev.agent !== node.agent) continue; // identity changed — fresh run

    // Copy the prior run's execution state in place (keep the object bound).
    const adoptedFrom = node.status;
    node.status = prev.status;
    // L15 (review 03-F6): this direct status write bypasses transitionNode's
    // single choke-point, so it never auto-records a checkpoint. Compensate
    // when the write actually changed the status — the append-only
    // checkpointHistory must not have a gap at the adopt/recover transition
    // (recorder.ts:55-59 "complete ordered traceability" promise). No
    // checkpoint is fabricated for a no-change adoption (e.g. a provisioned
    // ready root adopting a prior ready root).
    if (adoptedFrom !== node.status) {
      recordCheckpointForNode(target, node, adoptedFrom, node.status, Date.now());
    }
    node.prompt = prev.prompt; // preserves modify_prompt mutations
    node.signalsObserved = { ...prev.signalsObserved };
    node.result = prev.result ? { ...prev.result } : undefined;
    node.dispatchTaskId = prev.dispatchTaskId;
    node.dispatchSessionId = prev.dispatchSessionId;
    node.errorReason = prev.errorReason;
    node.upstreamResults = new Map(prev.upstreamResults);
    node.joinSatisfied = prev.joinSatisfied;
    node.traversalCount = prev.traversalCount;
    node.retryCount = prev.retryCount;
    node.sessionsSpawned = prev.sessionsSpawned;
    node.tokensConsumed = { ...prev.tokensConsumed };
    node.startedAt = prev.startedAt;
    node.completedAt = prev.completedAt;
    // OPTIONAL-ADDITIVE (L7): per-node artifact/evidence references are carried
    // across rebuilds — defensive copies, never aliased.
    node.artifacts = prev.artifacts ? [...prev.artifacts] : undefined;
    node.evidence = prev.evidence ? [...prev.evidence] : undefined;

    // Frontier correction: only genuinely-ready nodes stay dispatchable.
    if (node.status === NodeStatus.Ready) {
      if (!target.frontier.includes(nodeId)) target.frontier.push(nodeId);
    } else {
      removeFromFrontier(target, nodeId);
    }
  }

  // Subtask-5 dangling-loop-group guard: the current declaration is the source
  // of truth for membership. A node whose loopGroupId names a group the
  // declaration no longer declares (dropped between the prior run and this
  // rebuild) must not keep it — executeLoopStep would otherwise fabricate
  // `converged` for a revise_needed signal (silently swallowing the revision —
  // no re-entry, no escalation, no traversal accounting) or throw on the
  // missing group's convergence tracker.
  clearUndeclaredLoopGroupIds(target);

  // ── Post-adoption in-degree reconciliation ──────────────────────────────
  // H2: adoptPriorNodeStates overwrites provision()'s correct `Pending`
  // assignment with a stale prior `Ready`, then re-adds the node to the
  // frontier (lines above).  When edges are added AFTER nodes (the normal
  // construction-tool order), `provision()` is called before the edges exist,
  // so everything starts `Ready`; `graph_add_edge` later calls `buildEngine()`
  // → `provision()` again which correctly demotes the downstream node to
  // `Pending`, but `adoptPrior()` then promotes it back to `Ready` from the
  // stale prior state.  This pass undoes that promotion.
  //
  // Recompute in-degree from the CURRENT edges using the identical filter
  // rules as provision() (via computeInDegrees — same function, cannot drift).
  // For every node adopted as Ready whose effective in-degree is now > 0,
  // demote it to Pending and yank it from the frontier.  Completed, running,
  // blocked, done, escalate, timeout, and cancelled nodes are left untouched
  // (adopting prior progress for those is load-bearing).
  {
    const upstream = computeInDegrees(target);
    for (const [nodeId, node] of target.nodes) {
      if (node.status !== NodeStatus.Ready) continue;
      const incoming = upstream.get(nodeId) ?? 0;
      if (incoming > 0) {
        node.status = NodeStatus.Pending;
        removeFromFrontier(target, nodeId);
        // L15 (review 03-F6): the H2 demotion is another direct status write
        // that bypasses transitionNode's choke-point — compensate with an
        // explicit checkpoint so the node's rebuild history records the
        // Ready → Pending demote (no traceability gap).
        recordCheckpointForNode(
          target,
          node,
          NodeStatus.Ready,
          NodeStatus.Pending,
          Date.now(),
        );
      }
    }
  }

  // Graph-level progress: budget counters, signal history, checkpoints.
  target.budget = { ...prior.budget };
  for (const [nodeId, entry] of prior.signalLedger) {
    target.signalLedger.set(nodeId, {
      ...entry,
      signals: { ...entry.signals },
      history: entry.history ? [...entry.history] : undefined,
    });
  }
  if (prior.checkpoints) {
    target.checkpoints = { ...prior.checkpoints, ...(target.checkpoints ?? {}) };
  }
  // OPTIONAL-ADDITIVE (H3): merge the append-only checkpoint history with the
  // same prior-first semantics as `checkpoints` — prior records survive a
  // rebuild, and a target record (recorded after provisioning) wins key
  // conflicts. Absent on both sides → no fabricated value beyond the merge.
  target.checkpointHistory = {
    ...cloneCheckpointHistory(prior.checkpointHistory),
    ...(target.checkpointHistory ?? {}),
  };
  // OPTIONAL-ADDITIVE (monitor M10): carry the prior run's terminal-notification
  // dedup flags so a rebuilt engine never re-notifies a graph whose terminal
  // reminder was already delivered. Absent → undefined.
  target.terminalNotified = prior.terminalNotified
    ? { ...prior.terminalNotified }
    : undefined;

  // Loop-group traversal counters (caps stay honest across rebuilds).
  for (const [groupId, prevGroup] of prior.loopGroups) {
    const group = target.loopGroups.get(groupId);
    if (!group) continue;
    group.traversalCount = prevGroup.traversalCount;
    group.consecutiveStale = prevGroup.consecutiveStale;
    // OPTIONAL-ADDITIVE (L7): the stuck-exit convergence fingerprint is graph
    // progress — carried across rebuilds so the stale-exit heuristic is not
    // reset by a fresh provision.
    group.convergenceFingerprint = prevGroup.convergenceFingerprint;
    if (prevGroup.rounds) group.rounds = [...prevGroup.rounds];
  }

  target.updatedAt = Date.now();
  // Node-state adoption is a critical transition — the caller persists
  // synchronously. Reset the non-critical flag (its churn is included in that
  // write) so the recovered runtime starts clean.
  target.isDirty = true;
  target.isNonCriticalDirty = false;
}

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
  // L21 (review 05-F5): `advancingLock` and `pendingCompletions` are persistent
  // fields — the choke-point contract (engine-persistence.ts:73-83) requires
  // markDirty after mutating them. Without this, a recover() whose
  // reconcile-failure catch path never runs a mutating critical section would
  // leave the released lock / cleared queue unpersisted — a re-crash would
  // resurrect the stale lock.
  markDirty(state);
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

// ── Stale-node watcher (monitor M3) ─────────────────────────────────────────

/** Options for {@link NodeStalenessWatcher}. */
export interface NodeStalenessWatcherOptions {
  /** Tick interval for `start()` (defaults to `SWEEPER_INTERVAL_MS`). */
  intervalMs?: number;
  /**
   * How long a `running` node may stay live before it is marked `timeout`.
   * A node with a declared per-node budget overrides this with
   * `node.budget?.timeout_ms` (the declaration is authoritative).
   */
  nodeStaleTimeoutMs: number;
  /**
   * Called with the node id and error reason whenever a stale running node is
   * marked `timeout` by {@link tick}.
   */
  onTimeout?: (nodeId: string, errorReason: string) => void;
  /**
   * Optional dispatch-liveness probe (the same quiet-but-alive channel the
   * {@link NodeLivenessMonitor} consults). When present and returning `true`
   * for a running node that is past its staleness deadline, {@link tick}
   * treats the node as quiet-but-alive rather than hung: it refreshes
   * `lastActivityAt` (heartbeatSource `"dispatch"`) and SKIPS the wall-clock
   * timeout for that tick. The node stays running while the dispatch layer
   * verifiably considers its task in-flight; the authoritative hung-kill for
   * a task that stays verifiably live but never completes lives in the
   * dispatch watchdog (`completion-evaluator.ts` not_ready branch), not here.
   *
   * When the probe is absent, returns `false` (task dead / orphaned), or
   * throws (unverifiable), the wall-clock deadline remains authoritative —
   * the node is marked `timeout` exactly as before (the "no-feed fallback"
   * contract). A throwing probe is swallowed and treated as not-alive, so a
   * tick never breaks and a broken probe can never resurrect a hung node.
   * When the probe is present and its node IS timed out, its result is
   * folded into the timeout REASON string for diagnostics (e.g.
   * `dispatch task live=false`).
   */
  isDispatchAlive?: (node: NodeRuntimeState) => boolean;
}

/**
 * Stale-node watcher (monitor M3) — detects `running` nodes whose worker has
 * stopped advancing and marks them `timeout` so the graph never hangs on a node
 * nobody is driving. Same shape as the stale-lock {@link EngineLockSweeper}:
 * **manually tickable** (`tick` with an injectable clock for deterministic
 * tests) and never starts a timer on its own — `start()` (the periodic
 * `setInterval`) is opt-in, so tests never leak an interval.
 *
 * Deadline resolution per node:
 * - a node with a declared per-node budget (`node.budget?.timeout_ms`) uses
 *   that value as its staleness deadline — the declaration wins;
 * - every other node uses the watcher-wide `nodeStaleTimeoutMs`;
 * - a non-positive deadline means the node never goes stale (defensive — a
 *   `0`/negative per-node override or watcher-wide value disables staleness).
 *
 * Dispatch-liveness gate (S2): when the optional {@link NodeStalenessWatcherOptions
 * .isDispatchAlive} probe is present and verifiably reports the node's task
 * in-flight, a running node past its deadline is quiet-but-alive — the tick
 * refreshes its heartbeat (heartbeatSource `"dispatch"`) and skips the
 * timeout. The wall-clock kill remains the no-feed fallback: probe absent,
 * `false`, or throwing → the node is timed out byte-identically to the
 * legacy behavior, and the authoritative hung-kill for a verifiably-live
 * but never-completing task lives in the dispatch watchdog
 * (`completion-evaluator.ts` not_ready branch).
 *
 * The engine's behavior is unchanged unless a consumer instantiates the
 * watcher (default not instantiated) and drives it — `index.ts` (S7) wires
 * the opt-in interval. Each tick marks stale nodes via
 * {@link markTimedOut} (a normal `running → timeout` transition, so lifecycle
 * checkpoints and the critical-dirty flag are recorded by the shared
 * transition choke point).
 */
export class NodeStalenessWatcher {
  private readonly intervalMs: number;
  private readonly nodeStaleTimeoutMs: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: NodeStalenessWatcherOptions) {
    this.intervalMs = opts.intervalMs ?? SWEEPER_INTERVAL_MS;
    this.nodeStaleTimeoutMs = opts.nodeStaleTimeoutMs;
  }

  /**
   * One staleness tick. Marks every `running` node whose elapsed `startedAt`
   * time meets or exceeds its staleness deadline as `timeout` (via
   * {@link markTimedOut}), reporting each through the `onTimeout` callback —
   * unless the optional dispatch-liveness probe verifiably reports the node's
   * task in-flight, in which case the node is quiet-but-alive: its heartbeat
   * is refreshed (heartbeatSource `"dispatch"`) and the timeout is skipped
   * for this tick.
   *
   * @returns The ids of the nodes that were timed out by this tick.
   * @param now Optional clock for deterministic tests (defaults to `Date.now`).
   */
  tick(state: EngineState, now: number = Date.now()): string[] {
    const timedOut: string[] = [];
    for (const node of state.nodes.values()) {
      if (node.status !== NodeStatus.Running) continue;
      const deadline = node.budget?.timeout_ms ?? this.nodeStaleTimeoutMs;
      if (deadline <= 0) continue; // no staleness deadline — never stale
      if (now - node.startedAt >= deadline) {
        // Dispatch-liveness gate (quiet-but-alive): when the optional probe
        // verifiably reports the node's task in-flight, the wall-clock
        // deadline is suspended — refresh the heartbeat (heartbeatSource
        // "dispatch", mirroring the NodeLivenessMonitor channel) and skip the
        // timeout. Hung-but-alive nodes (task stuck verifiably live, never
        // completing) fall to the dispatch watchdog's not_ready hung-kill,
        // not this watcher. Probe absent / false / throwing → the wall-clock
        // kill below is byte-identical to the legacy no-feed fallback.
        const dispatchAlive = this.evalDispatchAlive(node);
        if (dispatchAlive === true) {
          node.liveness = {
            ...node.liveness,
            lastActivityAt: now,
            heartbeatSource: "dispatch",
            stallStatus: "healthy",
            stallWarnedAt: undefined,
            stallReason: undefined,
          };
          markNonCriticalDirty(state);
          continue;
        }
        const reason = this.buildTimeoutReason(node, deadline, now, dispatchAlive);
        markTimedOut(state, node, reason);
        timedOut.push(node.nodeId);
        this.opts.onTimeout?.(node.nodeId, reason);
      }
    }
    return timedOut;
  }

  /**
   * Evaluate the optional dispatch-liveness probe for a node — exactly once
   * per tick. Returns `undefined` when the probe is absent or throws; both
   * resolve to the conservative not-verifiable default, so a broken probe can
   * never resurrect a hung node and a tick never breaks.
   */
  private evalDispatchAlive(node: NodeRuntimeState): boolean | undefined {
    if (!this.opts.isDispatchAlive) return undefined;
    try {
      return this.opts.isDispatchAlive(node);
    } catch {
      return undefined; // probe threw — not verifiably alive → wall-clock kill
    }
  }

  /**
   * Compose the timeout reason for a stale running node. The base message is
   * unchanged; the node's liveness-carrier facts (idle time since the last
   * heartbeat, heartbeat source, stall classification) and — when the
   * optional dispatch-liveness probe is present — its result are appended for
   * diagnosis (S1 enrichment). The probe result is passed in precomputed by
   * {@link tick} (evaluated exactly once per node per tick — the same value
   * that gated the timeout skip), so the reason is always consistent with the
   * decision. Reason string only: this NEVER influences which nodes time out
   * (the {@link tick} gate plus the wall-clock deadline decide); a throwing
   * probe resolves to `undefined` (segment omitted) so a tick never breaks;
   * the legacy reason is byte-identical when no liveness facts or probe
   * exist.
   */
  private buildTimeoutReason(
    node: NodeRuntimeState,
    deadline: number,
    now: number,
    dispatchAlive?: boolean,
  ): string {
    const facts: string[] = [];
    if (dispatchAlive !== undefined) {
      facts.push(`dispatch task live=${dispatchAlive}`);
    }
    const liv = node.liveness;
    if (liv?.lastActivityAt !== undefined) {
      facts.push(`last heartbeat ${formatIdle(now - liv.lastActivityAt)} ago`);
    }
    if (liv?.heartbeatSource) {
      facts.push(`heartbeat source=${liv.heartbeatSource}`);
    }
    if (liv?.stallStatus) {
      facts.push(`stall status=${liv.stallStatus}`);
    }
    const base = `node ran past its staleness timeout (${deadline}ms)`;
    return facts.length > 0 ? `${base}; ${facts.join(", ")}` : base;
  }

  /** Start the periodic tick. Opt-in — never auto-started. */
  start(state: EngineState): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.tick(state);
      } catch {
        // A tick must never take down the process.
      }
    }, this.intervalMs);
    // Don't keep the process alive just because a tick interval is pending.
    (this.timer as (typeof this.timer) & { unref?: () => unknown })?.unref?.();
  }

  /** Stop the periodic tick (no-op if never started). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// ── Node liveness monitor (heartbeat-based stall detection) ─────────────────

/**
 * The immutable detection facts captured at the moment {@link NodeLivenessMonitor}
 * fires its `onStall` callback. Passed as the optional third argument so a
 * consumer (e.g. the engine's stall notifier seam) can render an actionable
 * reminder without re-deriving monitor internals.
 */
export interface StallDetectionInfo {
  /** Idle time (ms) since the node's last heartbeat at detection time. */
  idleMs: number;
  /** The soft-stall warn threshold (ms) used for this detection. */
  stallWarnMs: number;
  /** Epoch-ms timestamp stamping the start of this stall episode. */
  stallWarnedAt: number;
}

/**
 * A node-stall event emitted via the optional {@link NodeLivenessMonitorOptions
 * .onStall} callback seam (node-anomaly-detection subtask 5). The engine
 * packages only the immutable facts captured at detection time; notification /
 * delivery (a notifier) is the consumer's concern and never lives in the
 * monitor or the engine.
 */
export interface NodeStallEvent {
  /** Owning graph id. */
  graphId: string;
  /** The node that entered the soft-stall (`stalling`) classification. */
  nodeId: string;
  /** The node's bound agent id. */
  agent: string;
  /** Idle time (ms) since the node's last heartbeat at detection time. */
  idleMs: number;
  /** The soft-stall warn threshold (ms) used for this detection. */
  stallWarnMs: number;
  /**
   * Epoch-ms timestamp when this stall episode was first warned. Identifies
   * the stall episode — a notifier's dedupe key folds it in so a recovery
   * (fresh heartbeat → `healthy`) followed by a re-stall is a distinct episode
   * and legally re-notifies, while an idempotent replay of the same episode is
   * dropped.
   */
  stallWarnedAt: number;
}

/** Options for {@link NodeLivenessMonitor}. */
export interface NodeLivenessMonitorOptions {
  /** Tick interval for `start()` (defaults to `SWEEPER_INTERVAL_MS`). */
  intervalMs?: number;
  /**
   * Watcher-wide staleness timeout — the hard cap on how long any `running`
   * node may stay alive. The per-node effective deadline is
   * `min(node.budget?.timeout_ms ?? this, this)` — a node's declared budget
   * can shorten the window but never extend it past this value. A
   * non-positive effective deadline disables liveness-based staleness for
   * that node.
   */
  nodeStaleTimeoutMs: number;
  /**
   * Idle time since the last heartbeat at which a node is first classified
   * `stalling` and `onStall` fires. Single-fire per stall episode — the
   * callback does not repeat while the node stays `stalling`, and a fresh
   * episode (after a heartbeat returns the node to `healthy`) warns again.
   * Defaults to `min(60_000, nodeStaleTimeoutMs / 2)`.
   */
  stallWarnMs?: number;
  /**
   * Additional idle time past `stallWarnMs` before a stalling node is
   * hard-stalled — marked `timeout` via {@link markTimedOut} and reported
   * through `onTimeout` (the same signature as
   * {@link NodeStalenessWatcherOptions.onTimeout}). Defaults to 30_000.
   */
  stallGraceMs?: number;
  /**
   * Optional dispatch-liveness probe (quiet-but-alive channel). When present
   * and returning `true` for a running heartbeat-fed node, {@link tick}
   * treats the node as quiet-but-alive rather than stalled: once the node has
   * been idle past `stallWarnMs` (i.e. it is ABOUT to be classified stalled),
   * the tick refreshes `lastActivityAt` (heartbeatSource `"dispatch"`) and
   * skips the stall ladder.
   *
   * The probe must answer "is the underlying dispatch/process verifiably
   * in-flight?" — on opencode, the background task status being
   * running/pending/awaiting_approval (backed by the SDK session tracking);
   * on Pi, the task status running (backed by the live child process between
   * JSON events). A subagent mid-turn with zero streaming events is alive, not
   * stalled, so it must not be hard-stalled merely for being quiet.
   *
   * Consequences (deliberate):
   * - The warn ladder (`[GRAPH NODE STALLED]`) and the heartbeat hard-stall
   *   now fire ONLY when the dispatch can no longer verify the task — the
   *   genuinely abnormal state (orphaned node, dead task that never
   *   terminal-advanced). Quiet-but-alive nodes no longer warn.
   * - A genuinely HUNG node whose task stays verifiably live but never
   *   completes is NOT caught here — it falls to the dispatch watchdog's
   *   not_ready hung-kill (`completion-evaluator.ts`), and the wall-clock
   *   {@link NodeStalenessWatcher} wired beside this monitor applies the SAME
   *   probe gate (S2): while the probe verifies the task in-flight, the
   *   watcher skips its timeout too. Only a watcher WITHOUT the probe
   *   (feed-less engines / test fakes) keeps the pure wall-clock deadline as
   *   the hung-but-alive backstop.
   * - A node whose declared per-node budget (`budget.timeout_ms`) is tighter
   *   than the warn window is bounded by that cap (the hard-stall branch
   *   precedes the probe refresh) — the declared deadline is authoritative.
   */
  isDispatchAlive?: (node: NodeRuntimeState) => boolean;
  /**
   * Called once when a running node first enters the soft-stall
   * (`stalling`) classification. The optional third argument carries the
   * {@link StallDetectionInfo} captured at fire time (idle / warn threshold /
   * episode timestamp) so a consumer can render an actionable notification
   * without re-deriving monitor internals. The monitor contains the call in
   * try/catch — a throwing consumer is logged and swallowed so a tick never
   * breaks.
   */
  onStall?: (nodeId: string, reason: string, info?: StallDetectionInfo) => void;
  /**
   * Called with the node id and error reason whenever a hard-stalled running
   * node is marked `timeout` by {@link tick}.
   */
  onTimeout?: (nodeId: string, errorReason: string) => void;
}

/**
 * Node liveness monitor — heartbeat-based stall detection layered on top of
 * the wall-clock {@link NodeStalenessWatcher} (node-anomaly-detection subtask
 * 3). Same shape as the watcher: **manually tickable** (`tick` with an
 * injectable clock for deterministic tests) and never starts a timer on its
 * own — `start()` (the periodic `setInterval`) is opt-in, so tests never leak
 * an interval.
 *
 * Unlike the wall-clock watcher (which times a node out purely from
 * `startedAt`), the monitor classifies a node from its **heartbeat feed**
 * (`node.liveness.lastActivityAt`, written by subtask 2's
 * `recordLivenessHeartbeat` / the platform liveness feed):
 *
 * - heartbeat fresh (`now - lastActivityAt < stallWarnMs`) → `healthy` — the
 *   node's `stallStatus` is reset to `healthy`, clearing any soft-stall
 *   classification;
 * - soft stall (Tier 1) — idle `>= stallWarnMs` and `< stallWarnMs +
 *   stallGraceMs` → the node is classified `stalling` with `stallWarnedAt`
 *   stamped, and `onStall` fires **once** (guarded on the existing
 *   `stallStatus`, so the warning never repeats within one episode);
 * - hard stall (Tier 2) — idle `>= min(effectiveDeadline, stallWarnMs +
 *   stallGraceMs)` → the node is marked `timeout` via the shared
 *   {@link markTimedOut} (the normal `running → timeout` transition, so
 *   lifecycle checkpoints and the critical-dirty flag are recorded by the
 *   transition choke point) and reported through `onTimeout`.
 *
 * Fallback (Tier 3): a node WITHOUT a heartbeat feed (`liveness.lastActivityAt`
 * absent) is skipped entirely — it keeps the pure wall-clock deadline of the
 * unmodified {@link NodeStalenessWatcher}. Both monitors coexist; the engine's
 * behavior is unchanged unless a consumer instantiates the monitor (default
 * not instantiated) and drives it.
 */
export class NodeLivenessMonitor {
  private readonly intervalMs: number;
  private readonly nodeStaleTimeoutMs: number;
  private readonly stallWarnMs: number;
  private readonly stallGraceMs: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: NodeLivenessMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? SWEEPER_INTERVAL_MS;
    this.nodeStaleTimeoutMs = opts.nodeStaleTimeoutMs;
    this.stallWarnMs =
      opts.stallWarnMs ?? Math.min(60_000, this.nodeStaleTimeoutMs / 2);
    this.stallGraceMs = opts.stallGraceMs ?? 30_000;
  }

  /**
   * One liveness tick. Classifies every `running` node with a heartbeat feed
   * (see the class docs for the healthy → stalling → stalled ladder) and
   * hard-stalls nodes past their effective deadline via {@link markTimedOut}.
   *
   * @returns The ids of the nodes that were hard-stalled (timed out) by this tick.
   * @param now Optional clock for deterministic tests (defaults to `Date.now`).
   */
  tick(state: EngineState, now: number = Date.now()): string[] {
    const timedOut: string[] = [];
    for (const node of state.nodes.values()) {
      if (node.status !== NodeStatus.Running) continue;
      const effectiveDeadline = Math.min(
        node.budget?.timeout_ms ?? this.nodeStaleTimeoutMs,
        this.nodeStaleTimeoutMs,
      );
      if (effectiveDeadline <= 0) continue; // liveness staleness disabled
      const lastActivityAt = node.liveness?.lastActivityAt;
      if (lastActivityAt === undefined) continue; // no feed — wall-clock fallback (Tier 3)
      const idle = now - lastActivityAt;
      // Dispatch-liveness channel (quiet-but-alive): the node is ABOUT to be
      // classified stalled (idle >= warn), but the dispatch layer verifiably
      // considers its task/process in-flight — a silent-but-alive subagent
      // (long non-streaming model call, Pi child process between JSON events)
      // is alive, not stalled. Refresh the heartbeat and skip the ladder; the
      // probe is only consulted once idle reaches the warn threshold, so
      // normally-active nodes (relay heartbeats) are untouched and the
      // heartbeatSource tag stays "session" while activity flows. When the
      // probe turns false (dispatch died / task orphaned), the node is a
      // genuine stall candidate and the ladder below fires normally. A node
      // that stays verifiably alive but never completes is caught by the
      // wall-clock NodeStalenessWatcher backstop, not here.
      if (idle >= this.stallWarnMs && this.opts.isDispatchAlive?.(node)) {
        node.liveness = {
          ...node.liveness,
          lastActivityAt: now,
          heartbeatSource: "dispatch",
          stallStatus: "healthy",
          stallWarnedAt: undefined,
          stallReason: undefined,
        };
        markNonCriticalDirty(state);
        continue;
      }
      const hardStallAt = Math.min(
        effectiveDeadline,
        this.stallWarnMs + this.stallGraceMs,
      );
      if (idle >= hardStallAt) {
        // Tier 2 — hard stall: budget or warn+grace elapsed with no heartbeat.
        const reason =
          `node heartbeat stalled past its liveness deadline ` +
          `(idle ${idle}ms, deadline ${hardStallAt}ms)`;
        markTimedOut(state, node, reason);
        node.liveness = {
          ...node.liveness,
          stallStatus: "stalled",
          stallWarnedAt: node.liveness!.stallWarnedAt ?? now,
          stallReason: reason,
        };
        markNonCriticalDirty(state);
        timedOut.push(node.nodeId);
        this.opts.onTimeout?.(node.nodeId, reason);
        continue;
      }
      if (idle >= this.stallWarnMs) {
        // Tier 1 — soft stall: single-fire warning per stall episode.
        if (node.liveness!.stallStatus !== "stalling") {
          const reason =
            `node heartbeat stalled for ${idle}ms ` +
            `(soft-stall warn threshold ${this.stallWarnMs}ms)`;
          node.liveness = {
            ...node.liveness,
            stallStatus: "stalling",
            stallWarnedAt: now,
            stallReason: reason,
          };
          markNonCriticalDirty(state);
          // Subtask 5: pass the detection facts captured at fire time as the
          // optional third argument. The call is contained — a throwing
          // consumer (e.g. a misbehaving notifier) is logged and swallowed so
          // a tick never breaks the monitor loop.
          try {
            this.opts.onStall?.(node.nodeId, reason, {
              idleMs: idle,
              stallWarnMs: this.stallWarnMs,
              stallWarnedAt: now,
            });
          } catch (err) {
            logWarn(
              `engine-recovery: onStall consumer threw for node "${node.nodeId}" — ` +
                `swallowed so a tick never breaks: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        continue;
      }
      // Heartbeat fresh — healthy; reset any soft-stall classification.
      if (
        node.liveness!.stallStatus !== "healthy" ||
        node.liveness!.stallWarnedAt !== undefined ||
        node.liveness!.stallReason !== undefined
      ) {
        node.liveness = {
          ...node.liveness,
          stallStatus: "healthy",
          stallWarnedAt: undefined,
          stallReason: undefined,
        };
        markNonCriticalDirty(state);
      }
    }
    return timedOut;
  }

  /** Start the periodic tick. Opt-in — never auto-started. */
  start(state: EngineState): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.tick(state);
      } catch {
        // A tick must never take down the process.
      }
    }, this.intervalMs);
    // Don't keep the process alive just because a tick interval is pending.
    (this.timer as (typeof this.timer) & { unref?: () => unknown })?.unref?.();
  }

  /** Stop the periodic tick (no-op if never started). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compact idle-time rendering for timeout reasons ("42s" for sub-minute,
 * "12m" for minutes). Negative skew (clock moved backwards) clamps to zero.
 */
function formatIdle(ms: number): string {
  const clamped = Math.max(0, ms);
  return clamped < 60_000
    ? `${Math.round(clamped / 1_000)}s`
    : `${Math.round(clamped / 60_000)}m`;
}

/** Minimal, dependency-free warning logger (no createSubLogger import cycle). */
function logWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

/** Minimal, dependency-free info logger. */
function logInfo(message: string): void {
  // eslint-disable-next-line no-console
  console.info(message);
}

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

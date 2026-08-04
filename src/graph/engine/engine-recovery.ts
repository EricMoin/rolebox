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
 * Finally, this module ships the stale-lock {@link EngineLockSweeper} and the
 * stale-node {@link NodeStalenessWatcher} (monitor M3), matching
 * `src/loop/coordinator.ts:101-124` (engine-state-machine.md §3.4 / failure
 * resilience.md §5.6). Both are **manually tickable** and do not start an
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
import { computeInDegrees, releaseAdvancingLock, removeFromFrontier } from "./engine-state.ts";
import { markCancelled, markTimedOut } from "./node-lifecycle.ts";
import { cloneCheckpointHistory, markNonCriticalDirty } from "./engine-persistence.ts";
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
      subscribeTaskTermination(state, port, current, emitSignal);
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
    node.status = prev.status;
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
   * {@link markTimedOut}), reporting each through the `onTimeout` callback.
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
        const reason = `node ran past its staleness timeout (${deadline}ms)`;
        markTimedOut(state, node, reason);
        timedOut.push(node.nodeId);
        this.opts.onTimeout?.(node.nodeId, reason);
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

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
import { computeInDegrees, releaseAdvancingLock, removeFromFrontier } from "./engine-state.ts";
import { markCancelled, markTimedOut } from "./node-lifecycle.ts";
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
 * - any other status → `null` (non-terminal: running / pending / awaiting).
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
    default:
      return null; // cancelled + non-terminal statuses
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
      markCancelled(state, current, "dispatch task cancelled");
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
  target.checkpoints = source.checkpoints
    ? Object.fromEntries(
        Object.entries(source.checkpoints).map(([id, r]) => [id, { ...r }])
      )
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

  // Loop-group traversal counters (caps stay honest across rebuilds).
  for (const [groupId, prevGroup] of prior.loopGroups) {
    const group = target.loopGroups.get(groupId);
    if (!group) continue;
    group.traversalCount = prevGroup.traversalCount;
    group.consecutiveStale = prevGroup.consecutiveStale;
    if (prevGroup.rounds) group.rounds = [...prevGroup.rounds];
  }

  target.updatedAt = Date.now();
  target.isDirty = true;
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

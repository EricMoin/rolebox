/**
 * Graph Execution Engine v2 — Core Signal-Driven Advancement Algorithm
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * The heart of the engine. Advances the graph in response to terminating
 * signals emitted by dispatched worker nodes. There is no polling loop — the
 * engine reacts to a signal on a node and walks: transition the node's
 * lifecycle → evaluate outbound edges → check downstream fan-in joins →
 * enqueue satisfied downstream nodes → dispatch ready nodes.
 *
 * Re-entrancy guard: the whole advancement runs inside the `_advancing`
 * critical section (the `advancingLock` on `EngineState`), modeled exactly on
 * `src/loop/coordinator.ts:397-404` (defer under lock) and
 * `src/loop/coordinator.ts:450-462` (drain in the `finally` block). Only one
 * advancement critical section runs at a time for a graph instance; signals
 * that arrive while it is held are queued to `pendingCompletions` and drained
 * (re-processed under a fresh critical section) once the current one exits.
 *
 * Phase 1 scope:
 * - `onNodeSignalEmitted` self-contained entry: records the signal via the
 *   `SignalBridge`, then advances under the lock.
 * - Node lifecycle transitions for `answer` (→ completed) and `escalate`
 *   (→ escalated). `revise_needed` completes the reviewing node's own
 *   lifecycle; the back-edge re-activation is implemented in Phase 2.
 * - Forward edge evaluation on `answer`: `always` and `on_signal` (signal
 *   filter) are evaluated; `on_condition` delegates to an injected resolver.
 * - `escalate` / `revise_needed` propagation are delegated to
 *   `signal-propagation.ts` (Phase 2).
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §3.3.
 */

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { GraphBudgetState, EdgePayload, RoundHistoryEntry } from "../../types.engine-v2.ts";
import type { EngineState, NodeRuntimeState, NodeLivenessState } from "../../types.engine-v2.ts";
import type { EdgeDeclaration } from "../../types.graph-v2.ts";
import type { DispatchTask } from "../../dispatch/types.ts";
import type { BudgetCheckResult, UsageRecord } from "../../dispatch/budget/budget-tracker.ts";
import {
  shouldPersist,
  clearDirty,
  clearNonCriticalDirty,
  shouldPersistNonCritical,
  markDirty,
  markNonCriticalDirty,
} from "./engine-persistence.ts";
import {
  type DispatchParentContext,
  type TaskTerminatedCallback,
  graphParentContext,
} from "./dispatch-bridge.ts";
import {
  getNode,
  acquireAdvancingLock,
  releaseAdvancingLock,
  queuePendingCompletion,
  drainPendingCompletions,
  addToFrontier,
  removeFromFrontier,
  canTransitionPhase,
  transitionPhase,
  incrementLoopTraversal,
  isLoopExhausted,
} from "./engine-state.ts";
import {
  markCompleted,
  markDone,
  markReady,
  markRunning,
  markEscalated,
  markTimedOut,
  markNodeBlocked,
  canTransitionNode,
} from "./node-lifecycle.ts";
import {
  subscribeTaskTermination,
  mapDispatchStatusToSignal,
  isDispatchTaskLive,
} from "./engine-recovery.ts";
import { collectUpstreamResults, evaluateJoin } from "./join-evaluator.ts";
import { applyDataMapping } from "./data-mapping-transform.ts";
import { cancelPendingUpstreams } from "./cascade-canceller.ts";
import {
  propagateEscalate,
  propagateRevise,
  type SignalPropagationReport,
} from "./signal-propagation.ts";
import {
  checkGraphTermination,
  type GraphTerminalEvent,
  type TerminationContext,
} from "./engine-termination.ts";
import { executeLoopStep } from "./loop-group-executor.ts";
import {
  recordNodeArtifactsAndEvidence,
  recordLoopRound,
  deriveNodeArtifacts,
} from "./recorder.ts";
import { buildApprovalPayload } from "./approval-payload.ts";
import {
  approveBlockedNode,
  rejectBlockedNode,
  pruneDownstreamSubgraph,
  reenterRejectedUpstreams,
  resetRejectedUpstreams,
} from "./approval-handler.ts";
import {
  resetNodeForRetry,
  type RetryNodeOptions,
  type RetryReport,
} from "./node-retry.ts";
import type {
  NodeSignalEmittedListener,
  SignalType,
  SignalBridge,
} from "./signal-bridge.ts";
import { recordSignalToLedger } from "./signal-bridge.ts";
import type { SignalLedgerSource } from "../../types.engine-v2.ts";
import type { GraphEventRecorder } from "./graph-events.ts";

// ── Ports (dependency injection seams) ──────────────────────────────────────

/**
 * The dispatch surface the engine touches. Structurally satisfied by
 * {@link DispatchBridge} (`src/graph/engine/dispatch-bridge.ts`). Declared as
 * a minimal interface so tests can inject a fake and avoid real sub-agent
 * dispatch.
 */
export interface NodeDispatchPort {
  /** Execute a graph node by dispatching to its bound agent (background). */
  executeNode(
    node: NodeRuntimeState,
    parentContext: DispatchParentContext,
    description?: string,
  ): Promise<DispatchTask>;
  /**
   * Cancel a dispatched graph node's background task. Optional — omitted by
   * test fakes and any port without a cancellation surface; structurally
   * satisfied by {@link DispatchBridge}. Consumed by the cascade canceller
   * (`cascade-canceller.ts`) to stop now-unneeded upstream nodes once a fan-in
   * join resolves (see failure-resilience.md §3.3). Never awaited — the engine
   * proceeds without a cancellation acknowledgement.
   */
  cancelTask?(taskId: string): Promise<boolean>;
  /**
   * Look up a dispatched task's current status. Optional — recovery and the
   * status→signal mapping use it to read `task.error`. Structurally satisfied
   * by {@link DispatchBridge}; omitted by test fakes.
   */
  getTask?(taskId: string): DispatchTask | undefined;
  /**
   * Register a one-time listener for a task's terminal transition. Optional —
   * a port without it simply cannot push dispatch completions into the engine;
   * the engine degrades to signal-driven advancement only. Structurally
   * satisfied by {@link DispatchBridge}. Wired by {@link _dispatchNode} and by
   * recovery to close the dispatch→signal delivery seam.
   */
  onTaskTerminated?(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void;
  /**
   * Remove a previously-registered task-terminated listener. Optional — a port
   * without it simply cannot clean up its subscriptions (leak-free teardown is
   * then the caller's concern). Structurally satisfied by {@link DispatchBridge}
   * (which delegates to `DispatchManager.removeTaskTerminatedListener`).
   * Consumed by the engine's subscription accessor
   * ({@link AdvanceEngine.getTerminationSubscriptions}) so a teardown path
   * (monitor M4 / S7 dispose) can unregister every listener this engine wired.
   */
  removeTaskTerminatedListener?(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void;
  /**
   * Cumulative token/cost usage for a single dispatched session (keyed by the
   * dispatch session ID). OPTIONAL-ADDITIVE — a port without it simply cannot
   * report per-node usage, so the engine degrades to the pre-Phase-7 behavior
   * (zero consumption). Structurally satisfied by {@link DispatchBridge}
   * (`dispatch-bridge.ts:getSessionUsage`); consumed by
   * `engine-recovery.ts:captureNodeUsage` to populate `node.tokensConsumed` at
   * task termination.
   */
  getSessionUsage?(sessionId: string): UsageRecord;
}

/**
 * The node-liveness surface the engine touches (subtask 2 of the
 * node-anomaly-detection feature). Structurally satisfied by the platform's
 * liveness feed — the layer that observes live dispatch sessions (tool calls,
 * messages, session errors) and reports activity back into the engine.
 * Declared as a minimal interface so tests can inject a fake and avoid any
 * real platform/session wiring.
 *
 * Direction: `attach` / `detach` are engine→feed — the engine registers a
 * node's live dispatch session when it is successfully launched and
 * unregisters it when the node reaches a terminal state, so the feed knows
 * which sessions to observe. The optional `onHeartbeat` / `onSessionError` /
 * `onSessionGone` members are feed→engine push hooks the platform may use to
 * relay session-level observations; the engine's stall monitor (subtask 3)
 * consumes them through {@link AdvanceEngine.recordLivenessHeartbeat}.
 *
 * Every member is `void`-returning — a throwing or absent feed must never
 * break advancement (the engine calls through optional chaining and contains
 * nothing here). All members are OPTIONAL-ADDITIVE: an engine without a feed
 * behaves exactly as before (no liveness recording, no index maintenance).
 */
export interface NodeLivenessFeed {
  /**
   * Register a node's live dispatch session with the feed. Called by the
   * engine immediately after a successful launch (`_dispatchNode`), when the
   * node's `dispatchTaskId` / `dispatchSessionId` are known. The engine ALSO
   * records the `sessionId → nodeId` mapping in its own reverse index at this
   * point, so the platform feed can look up the owning node for a session id
   * (see {@link AdvanceEngine.getNodeIdForSession}).
   */
  attach(nodeId: string, sessionId: string): void;
  /**
   * Unregister a node's session. Called by the engine when a running node
   * reaches a terminal state (signal-driven completion / escalation) — the
   * feed stops observing the session, and the engine drops the node's
   * `sessionId → nodeId` index entry. A no-op for a node that was never
   * attached.
   */
  detach(nodeId: string): void;
  /**
   * Push a session-level activity heartbeat for a node. Optional — a feed
   * without it simply cannot relay platform activity into the engine; the
   * engine's own dispatch-time heartbeat and `recordLivenessHeartbeat`
   * callers remain the alternative observation channels.
   */
  onHeartbeat?(nodeId: string, source: NodeLivenessState["heartbeatSource"]): void;
  /**
   * Push a session-level error observation for a node. Optional — the stall
   * monitor (subtask 3) may surface the node's status accordingly.
   */
  onSessionError?(nodeId: string, reason: string): void;
  /**
   * Push a session-gone observation — the platform can no longer see the
   * node's session at all. Optional — recovery / the stall monitor (subtask
   * 3) owns the authoritative timeout handling.
   */
  onSessionGone?(nodeId: string): void;
}

/**
 * The budget-query surface the engine touches. Structurally satisfied by
 * {@link BudgetBridge} (`src/graph/engine/budget-bridge.ts`). Optional —
 * omitted in tests, and Phase 1 never enforces ceilings (see the Phase-7 stub
 * note in `budget-bridge.ts`).
 */
export interface GraphBudgetPort {
  checkGraphBudget(graphId: string): BudgetCheckResult;
}

/** Evaluates a named `on_condition` edge condition. Phase 2 vocabulary. */
export type EdgeConditionResolver = (
  condition: string,
  source: NodeRuntimeState,
) => boolean;

/**
 * A node-completion event emitted via the optional {@link AdvanceEngineOptions
 * .onNodeCompletion} callback seam (subtask 1). The engine stays role-agnostic
 * — it packages only the immutable facts; notification / delivery (a notifier)
 * is the consumer's concern and never lives in the engine.
 */
export interface NodeCompletionEvent {
  /** Owning graph id. */
  graphId: string;
  /** The node that reached a terminal / notable status. */
  nodeId: string;
  /** The node's bound agent id. */
  nodeAgent: string;
  /**
   * The signal that drove the transition — one of the terminating
   * `SignalType`s (`answer` / `revise_needed` / `escalate`) for a
   * signal-driven transition, or the synthetic `timeout` marker for a
   * recovery-side timing-out node (no terminating signal drives a timeout).
   */
  signalType: string;
  /** The signal payload that drove the transition (may be undefined). */
  payload: unknown;
  /** The node's terminal / notable lifecycle status at emission time. */
  nodeStatus: NodeStatus;
  /**
   * Epoch-ms timestamp when the node started (additive, may be absent for
   * synthetic events). Lets a notifier report a real duration.
   */
  startedAt?: number;
  /** Epoch-ms timestamp when the node completed (additive, may be absent). */
  completedAt?: number;
}

export interface AdvanceEngineOptions {
  /** The engine state container this engine advances. */
  state: EngineState;
  /** Signal bridge — used to record signals and to subscribe as a listener. */
  signalBridge: SignalBridge;
  /** Dispatch seam — `executeNode` dispatches ready nodes to their agents. */
  dispatch: NodeDispatchPort;
  /** Optional budget seam — pre-dispatch graph-budget check (Phase 7). */
  budget?: GraphBudgetPort;
  /** Parent context for node dispatches (defaults to a graph-scoped one). */
  parentContext?: DispatchParentContext;
  /**
   * Optional `on_condition` edge evaluator. When absent, `on_condition`
   * edges never activate.
   */
  conditionResolver?: EdgeConditionResolver;
  /**
   * Optional engine-state persistence seam. When provided, the advancement
   * critical section performs a **write-through** save of the engine state in
   * its `finally` block — after every critical transition (node lifecycle,
   * graph phase, frontier) — so the state survives a crash. Per
   * `.rolebox/design/implementation-roadmap.md` Q2 Option A: critical
   * transitions write through immediately; noisy (non-critical) updates are
   * debounced elsewhere. When absent, the engine runs without persistence
   * (in-memory only), preserving the role-agnostic primitive's constructibility.
   *
   * Returns `true` when the state reached durable storage, `false` on a failed
   * write (never throws) — the engine only clears its dirty flag on success
   * (monitor M5), so a failed save is retried by the next mutating critical
   * section instead of silently dropped. A `void` return (or an absent seam)
   * is treated as success — backward-compatible with no-op test seams.
   */
  persistState?: (state: EngineState) => boolean | void;
  /**
   * Optional debounced-persistence seam (Q2 Option A, non-critical tier). When
   * a critical section produced ONLY non-critical mutations (signal-ledger
   * history, budget / tokensConsumed counters), the `finally` block routes the
   * write through this debounced seam instead of the synchronous
   * {@link persistState}. Absent → non-critical-only sections skip persistence
   * (the in-memory engine still runs).
   *
   * Returns `false` on a definite write failure (the debounced store retains
   * the pending state and retries it); the engine keeps its non-critical dirty
   * flag set in that case so a later section re-hands the churn to the seam
   * (monitor M5, non-critical tier). A `void` return is treated as success —
   * `EnginePersistence.scheduleSave` is the legacy void-returning seam, whose
   * failure retry is owned internally by the debounced store's pending
   * retention.
   */
  schedulePersistState?: (state: EngineState) => boolean | void;
  /**
   * Optional flush seam for the debounced tier. Invoked when the engine reaches
   * a terminal phase (`complete`) so no pending debounced write is lost. Absent
   * → no-op (in-memory engine).
   */
  flushPersistState?: () => void;
  /**
   * Optional node-completion notification seam (subtask 1). Invoked exactly
   * once per terminating / notable transition — `answer → completed`,
   * `revise_needed → completed` (reviewer finished), `escalate`,
   * `blocked → completed` (approval-resume), and the recovery-side `timeout`.
   * Defaults to a no-op, so the engine's existing behavior is unchanged.
   * Notification logic never lives in the engine — this is a pure
   * role-agnostic DI seam, exactly like {@link AdvanceEngineOptions.dispatch} /
   * {@link AdvanceEngineOptions.budget} / {@link AdvanceEngineOptions.persistState}.
   */
  onNodeCompletion?: (event: NodeCompletionEvent) => void;
  /**
   * Optional write-side durable event log (graph monitoring). When present, the
   * engine records node dispatch (`node_dispatched`) and node terminal
   * transitions (`node_completed`) into the recorder, alongside the
   * `onNodeCompletion` notifier. The recorder is total (never throws), so this
   * seam cannot break advancement. Absent → no event logging, engine behavior
   * unchanged.
   */
  graphEvents?: GraphEventRecorder;
  /**
   * Optional node-liveness feed seam (subtask 2 of node-anomaly-detection).
   * When present, the engine records an initial `dispatch` heartbeat on every
   * successfully launched node, maintains a `sessionId → nodeId` reverse
   * index of running nodes, and registers / unregisters each node's session
   * with the feed (`attach` on launch, `detach` on terminal transition).
   * Absent → the engine behaves exactly as before: no liveness recording, no
   * index, no feed calls. A pure role-agnostic DI seam, exactly like
   * {@link AdvanceEngineOptions.dispatch} / {@link AdvanceEngineOptions.budget}.
   */
  livenessFeed?: NodeLivenessFeed;
  /**
   * Optional graph-terminal notification seam. Invoked exactly once per
   * terminal transition (GRAPH COMPLETE / GRAPH BLOCKED). When absent, the
   * engine behaves identically — this is a pure DI seam like
   * {@link AdvanceEngineOptions.onNodeCompletion}. Callback exceptions must
   * never break advancement (try/catch + log).
   */
  onGraphTerminal?: (event: GraphTerminalEvent) => void;
}

/**
 * Severity ordering for picking which recorded terminating signal to replay
 * when a deferred completion is drained. Follows the signal escalation lattice
 * (`progress < answer < revise_needed < escalate`). See `graph-model.md §5.1`.
 */
const TERMINATING_SEVERITY: readonly SignalType[] = [
  "escalate",
  "revise_needed",
  "answer",
];

/**
 * Detect the default throw-on-use dispatch stub (`index.ts:throwOnDispatch`).
 * The stub carries the `isNoDispatchSeamStub` marker so `_dispatchNode` can
 * rethrow ITS rejection — the "no dispatch seam" misconfiguration must surface
 * to the caller of `run()` — while containing every genuine dispatch failure.
 */
function isNoDispatchSeamStub(port: NodeDispatchPort): boolean {
  return (port as { isNoDispatchSeamStub?: boolean }).isNoDispatchSeamStub === true;
}

/** Minimal, dependency-free warning logger (no sub-logger import cycle). */
function logWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

export type { GraphTerminalEvent } from "./engine-termination.ts";
export type { TerminationContext } from "./engine-termination.ts";

// ── AdvanceEngine ───────────────────────────────────────────────────────────

/**
 * Core signal-driven advancement engine for a single graph instance.
 *
 * One instance owns one {@link EngineState}. Public surface:
 *
 * - {@link AdvanceEngine.onNodeSignalEmitted} — the entry point. Records the
 *   signal and, if it is terminating, advances the graph under the lock.
 * - {@link AdvanceEngine.dispatchReady} — kickoff: dispatch any already-ready
 *   frontier nodes (roots after `provision`) under the lock.
 * - {@link AdvanceEngine.register} — subscribe to the {@link SignalBridge} so
 *   real signal emissions (recorded upstream) also advance the graph.
 *
 * Re-entrancy: every advancement path funnels through `_advanceSignal`, which
 * acquires `advancingLock`, runs the work, and — in `finally` — releases the
 * lock and drains deferred completions. The lock makes state mutation
 * single-threaded per graph; the drain makes deferred work eventually run.
 */
export class AdvanceEngine {
  private readonly state: EngineState;
  private readonly signalBridge: SignalBridge;
  private readonly dispatchPort: NodeDispatchPort;
  private readonly budgetPort?: GraphBudgetPort;
  private readonly parentContext: DispatchParentContext;
  private readonly conditionResolver?: EdgeConditionResolver;
  private readonly persistState?: (state: EngineState) => boolean | void;
  private readonly schedulePersistState?: (state: EngineState) => boolean | void;
  private readonly flushPersistState?: () => void;
  private readonly onNodeCompletion?: (event: NodeCompletionEvent) => void;
  private readonly graphEvents?: GraphEventRecorder;
  private readonly livenessFeed?: NodeLivenessFeed;
  private readonly onGraphTerminal?: (event: GraphTerminalEvent) => void;
  /**
   * Reverse index of live dispatch sessions: `dispatchSessionId → nodeId`,
   * maintained for RUNNING nodes only, so the platform liveness feed can look
   * up the owning node for a session id (subtask 2). Populated on `attach`
   * (a node's successful launch inside {@link _dispatchNode}), dropped on
   * `detach` (the node's terminal transition). Empty when no feed is wired.
   */
  private readonly _sessionToNodeId = new Map<string, string>();
  private readonly _terminationCtx: TerminationContext = {
    terminalComplete: false,
    terminalBlocked: false,
  };
  /**
   * Every `onTaskTerminated` subscription this engine registered via
   * {@link subscribeTaskTermination} during `_dispatchNode` (monitor M4),
   * as the exact `{ taskId, callback }` pair handed to the dispatch port.
   * Consumed by {@link getTerminationSubscriptions} so a teardown path
   * (S7 dispose) can unregister each listener and never leak one.
   */
  private readonly _terminationSubscriptions: Array<{
    taskId: string;
    callback: TaskTerminatedCallback;
  }> = [];

  constructor(opts: AdvanceEngineOptions) {
    this.state = opts.state;
    this.signalBridge = opts.signalBridge;
    this.dispatchPort = opts.dispatch;
    this.budgetPort = opts.budget;
    this.conditionResolver = opts.conditionResolver;
    this.persistState = opts.persistState;
    this.schedulePersistState = opts.schedulePersistState;
    this.flushPersistState = opts.flushPersistState;
    this.onNodeCompletion = opts.onNodeCompletion;
    this.graphEvents = opts.graphEvents;
    this.livenessFeed = opts.livenessFeed;
    this.onGraphTerminal = opts.onGraphTerminal;
    this.parentContext =
      opts.parentContext ??
      graphParentContext({
        graphId: this.state.graphId,
        directory: process.cwd(),
      });

    // Wire the write-side event sinks onto the state so transitionPhase /
    // applyBudgetDelta can reach the recorder without a module-level import
    // cycle. Previously done by GraphEventRecorder's constructor via global
    // setPhaseEventSink / setBudgetEventSink; now scoped to this engine instance
    // as EngineState fields (non-serializable, excluded from persistence DTOs).
    if (opts.graphEvents) {
      this.state.phaseEventSink = (gId, from, to) =>
        opts.graphEvents!.phaseChange(gId, from, to);
      this.state.budgetEventSink = (gId, budget) =>
        opts.graphEvents!.budgetUpdate(gId, budget);
    }
  }

  // ── Public entry points ───────────────────────────────────────────────────

  /**
   * Advance the graph in response to a signal emitted by a node.
   *
   * Step 1: records the signal (type → payload) into the node's
   * `signalsObserved` via the {@link SignalBridge}. Non-terminating signals
   * (pausing / handoff / info) are recorded only — they never advance the graph
   * in Phase 1. Terminating signals then run the advancement critical section
   * (`_advanceSignal`), which also routes through the re-entrancy guard.
   *
   * @param source Origin discriminator for the signal ledger event (defaults
   *               to `"dispatch"` for live worker signals; recovery deferred
   *               drain paths pass `"recovery"`).
   */
  onNodeSignalEmitted(
    nodeId: string,
    signalType: SignalType,
    signalPayload: unknown,
    source: SignalLedgerSource = "dispatch",
  ): Promise<void> {
    // Step 1: record the signal (per-node ledger + graph signalLedger).
    const terminating = this.signalBridge.record(
      this.state,
      nodeId,
      signalType,
      signalPayload,
      source,
    );
    // `need_approval` is a PAUSING signal (signal-bridge.ts PAUSING_SIGNALS),
    // so `terminating` is false for it — yet it still drives an advancement
    // critical section that transitions the `needs_approval` node to `blocked`
    // (Phase-3 approval pause). Other non-terminating signals (handoff / info)
    // are recorded only and never advance the graph.
    if (signalType === "need_approval") {
      return this._advanceSignal(nodeId, signalType, signalPayload);
    }
    if (!terminating) {
      // Pausing / handoff / info signals carry no Phase-1 graph advancement.
      return Promise.resolve();
    }
    return this._advanceSignal(nodeId, signalType, signalPayload);
  }

  /**
   * Kickoff: dispatch every node currently `ready` in the frontier.
   *
   * After `provision()` the root nodes are `ready` + in the frontier; calling
   * this dispatches them (each becomes `running`), moving the graph from
   * `idle` to `executing`. Subsequent advancement is driven purely by signals.
   */
  dispatchReady(): Promise<void> {
    if (!acquireAdvancingLock(this.state)) {
      return Promise.resolve();
    }
    return this._runCriticalSection(async () => {
      await this._dispatchReadyNodes();
      this._checkTermination();
    });
  }

  /**
   * Subscribe to the {@link SignalBridge}'s terminating-signal listener registry.
   *
   * The recorded signal is already written by `signalBridge.record()` before
   * listeners fire, so the listener advances WITHOUT re-recording — this is the
   * `_advanceSignal` (steps 2-7) path, avoiding a `record → fire → record`
   * recursion loop. Returns an unsubscribe function.
   */
  register(): () => void {
    const listener: NodeSignalEmittedListener = (nodeId, type, payload) => {
      // Recording already happened upstream (signalBridge.record step 1).
      // Subtask 2: the advance is contained (see _advanceSignal), but this
      // promise is discarded fire-and-forget — attach a catch so a future
      // regression can never surface an unhandled rejection from here.
      void this._advanceSignal(nodeId, type, payload).catch((err) => {
        logWarn(
          `engine: signal-driven advance failed for node "${nodeId}" in graph "${this.state.graphId}": ${this._errorString(err)}`,
        );
      });
    };
    return this.signalBridge.onNodeSignalEmitted(listener);
  }

  /**
   * The task-termination subscriptions this engine has registered during
   * `_dispatchNode` (monitor M4). Returns a defensive copy so a teardown path
   * (S7 dispose) can iterate it and unregister every listener via
   * `dispatch.removeTaskTerminatedListener(taskId, callback)` without mutating
   * the engine's internal ledger. Each `callback` is the exact value that was
   * handed to `port.onTaskTerminated`.
   */
  getTerminationSubscriptions(): Array<{
    taskId: string;
    callback: TaskTerminatedCallback;
  }> {
    return [...this._terminationSubscriptions];
  }

  // ── Re-entrancy guard (coordinator.ts:397-404 + 450-462 pattern) ──────────

  /**
   * Advancement critical-section wrapper.
   *
   * - If the lock is already held (a signal arrived mid-critical-section), the
   *   node is deferred to `pendingCompletions` and returns immediately — the
   *   current critical section will re-process it in its `finally` drain.
   * - Otherwise it acquires the lock, moves `idle → executing`, runs the work,
   *   and in `finally` releases the lock and drains deferred completions.
   */
  private async _advanceSignal(
    nodeId: string,
    signalType: SignalType,
    signalPayload: unknown,
  ): Promise<void> {
    if (!acquireAdvancingLock(this.state)) {
      queuePendingCompletion(this.state, nodeId);
      return;
    }
    return this._runCriticalSection(
      () => this._advance(nodeId, signalType, signalPayload),
      // Subtask 2: contain a throwing advance — log, escalate the affected
      // node, and let the section resolve instead of rejecting (fire-and-forget
      // advancement paths discard the promise with `void`).
      (err) => this._containAdvanceError(nodeId, err),
    );
  }

  /**
   * Body shared by every critical section: ensure the engine is `executing`,
   * run the work, then — in `finally` — release the lock and drain any
   * completions deferred while the section was held. Resolves with the work's
   * return value (`T`), so callers like `retryNode` can report what the
   * section produced (e.g. a retry count). Existing `() => Promise<void>`
   * callers are unaffected.
   */
  private async _runCriticalSection<T>(
    work: () => Promise<T>,
    onError?: (err: unknown) => void,
  ): Promise<T> {
    try {
      if (
        this.state.phase === EnginePhase.Idle &&
        canTransitionPhase(this.state, EnginePhase.Executing)
      ) {
        transitionPhase(this.state, EnginePhase.Executing);
      }
      return await work();
    } catch (err) {
      // Subtask 2: a throwing critical-section body must never escape as a
      // rejection — fire-and-forget advancement paths (the signalBridge
      // listener in register(), the dispatch-termination callback, recovery's
      // reconcile callbacks) discard the promise with `void`, so an escaped
      // rejection would surface as an unhandled rejection. Log, hand the
      // error to the caller's containment hook (escalate the affected node),
      // and RESOLVE. Callers that must keep propagating — e.g. dispatchReady
      // from run(), whose "no dispatch seam" rejection is a public contract
      // (engine-index.test.ts "rejects run() with a clear error") — simply
      // omit `onError`.
      logWarn(
        `engine: advancement critical section threw for graph "${this.state.graphId}": ${this._errorString(err)}`,
      );
      if (onError) {
        try {
          onError(err);
        } catch (containErr) {
          // containment must never rethrow out of the section
          logWarn(
            `engine: advancement error containment threw for graph "${this.state.graphId}": ${String(containErr)}`,
          );
        }
        return undefined as T;
      }
      // No containment hook — propagate the rejection (e.g. dispatchReady from
      // run(), whose "no dispatch seam" rejection is a public contract).
      throw err;
    } finally {
      releaseAdvancingLock(this.state);
      // Two-tier persistence point (Q2 Option A): only persist when the state
      // was mutated during this critical section. Critical mutations (node
      // lifecycle, phase, frontier, checkpoints, approval) write through
      // synchronously; a section that mutated ONLY non-critical churn
      // (signal-ledger history, budget / tokensConsumed) is routed through the
      // debounced seam. The flags are cleared after the write is handed off. The
      // seams are optional: when absent (no persistence configured) this is a
      // no-op. See engine-persistence.ts dirty-flag helpers.
      if (shouldPersist(this.state) || shouldPersistNonCritical(this.state)) {
        if (shouldPersist(this.state)) {
          // Monitor M5: only clear the dirty flag when the write-through save
          // actually reached durable storage. A failed save (boolean `false`
          // from the seam; a void return is treated as success) leaves
          // `isDirty` set so the NEXT mutating critical section retries the
          // persist instead of silently dropping the mutation.
          const ok = this.persistState?.(this.state);
          if (ok !== false) {
            clearDirty(this.state);
          }
        } else {
          // Non-critical tier (monitor M5, same policy): the debounced seam
          // reports a definite failure via `false`; the engine keeps the
          // non-critical dirty flag set so the churn is re-handed on a later
          // section (the store also retains its pending state internally).
          const ok = this.schedulePersistState?.(this.state);
          if (ok !== false) {
            clearNonCriticalDirty(this.state);
          }
        }
      }
      // flush-on-terminate: when the engine reaches a terminal phase (complete),
      // drain any pending debounced non-critical write so the on-disk state is
      // complete. On the critical path the synchronous save already cancelled
      // the debounce, so this is a no-op; it matters only for a terminal section
      // whose write went through the debounced tier.
      if (this.state.phase === EnginePhase.Complete) {
        this.flushPersistState?.();
      }
      await this._drainDeferred();
    }
  }

  /**
   * Drain deferred completions queued while a critical section was held.
   *
   * Mirrors `src/loop/coordinator.ts:450-462`: re-process each deferred node
   * under a fresh critical section. The signal to replay is re-derived from the
   * node's recorded `signalsObserved` (highest-severity terminating signal).
   */
  private async _drainDeferred(): Promise<void> {
    const drained = drainPendingCompletions(this.state);
    for (const nodeId of drained) {
      const node = this.state.nodes.get(nodeId);
      if (!node) continue; // node vanished — skip (getNode would throw)
      const sig = this._latestTerminating(node);
      if (!sig) continue;
      // Lock is free here — each drained item re-acquires its own section.
      // Subtask 2: a drained advance must never reject the caller's critical
      // section (a rejection here would override the section's resolution and
      // surface as an unhandled rejection at the fire-and-forget call sites) —
      // contain per node.
      try {
        await this._advanceSignal(nodeId, sig.type, sig.payload);
      } catch (err) {
        logWarn(
          `engine: deferred-drain advance failed for node "${nodeId}" in graph "${this.state.graphId}": ${this._errorString(err)}`,
        );
      }
    }
  }

  /**
   * Contain a throwing advancement critical section for the affected node
   * (subtask 2). Invoked via {@link _advanceSignal}'s onError hook so a
   * `work()` exception — a throwing conditionResolver, a broken propagation
   * invariant, a throwing recorder — surfaces as a terminal node failure
   * instead of an unhandled rejection:
   *
   * - Escalate the node when its lifecycle permits (`running` / `ready` /
   *   `pending` / `completed` / `blocked` → `escalate`), carrying the error
   *   reason, and surface it through the completion seam like a live escalate.
   * - Fall back to `timeout` when the node is stuck `running` and escalation
   *   is somehow not legal (defense-in-depth for the "stuck running" case).
   * - When the node is already terminal, just log — there is no transition
   *   left to apply.
   *
   * Finally re-checks graph termination so the terminal transition (GRAPH
   * COMPLETE / BLOCKED) is never silently dropped by the containment.
   */
  private _containAdvanceError(nodeId: string, err: unknown): void {
    const node = this.state.nodes.get(nodeId);
    const reason = `advance critical-section error: ${this._errorString(err)}`;
    if (!node) {
      logWarn(
        `engine: cannot contain advancement error for unknown node "${nodeId}" in graph "${this.state.graphId}": ${reason}`,
      );
      return;
    }
    if (canTransitionNode(node.status, NodeStatus.Escalate)) {
      markEscalated(this.state, node, reason);
      removeFromFrontier(this.state, nodeId);
      this._notifyCompletion(node, "escalate", reason, NodeStatus.Escalate);
    } else if (canTransitionNode(node.status, NodeStatus.Timeout)) {
      markTimedOut(this.state, node, reason);
      this._notifyCompletion(node, "timeout", reason, NodeStatus.Timeout);
    } else {
      logWarn(
        `engine: node "${nodeId}" in "${node.status}" after section error — cannot escalate (graph "${this.state.graphId}"): ${reason}`,
      );
    }
    try {
      this._checkTermination();
    } catch (termErr) {
      logWarn(
        `engine: termination re-check after containment threw for graph "${this.state.graphId}": ${this._errorString(termErr)}`,
      );
    }
  }

  /** Best-effort error message from an unknown throw value. */
  private _errorString(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // ── Advancement core ──────────────────────────────────────────────────────

  /**
   * Run the signal-driven advancement algorithm (design §3.3, steps 2-7) for
   * one terminating signal on one node, inside the critical section.
   */
  private async _advance(
    nodeId: string,
    signalType: SignalType,
    signalPayload: unknown,
  ): Promise<void> {
    const state = this.state;
    const node = getNode(state, nodeId);

    // Phase-3 approval pause: a `needs_approval` node emits the pausing
    // `need_approval` signal → transition `running → blocked`, remove it from
    // the frontier, and gate its downstream branch (no forward data flow). The
    // graph phase stays `executing` (blocked counts as active), waiting on the
    // human. Resumption routes through approveNode / rejectNode / partialApprove.
    if (signalType === "need_approval") {
      this._pauseForApproval(node, signalPayload);
      this._checkTermination();
      return;
    }

    // Step 2: transition the node's lifecycle (generic state machine).
    this._applySignalTransition(node, signalType, signalPayload);

    // Loop-group awareness: convergence decisions inside a bounded cycle are
    // orchestrated by the loop-group executor, which coalesces the Phase 2
    // primitives (traversal counting, revise re-dispatch, escalation cascade,
    // upstream cancellation) and applies the §4.3 soft early-exits. Non-loop
    // nodes keep the plain propagation primitives.
    const loopMember = node.loopGroupId !== undefined;

    // escalate / revise propagation.
    if (signalType === "escalate") {
      if (loopMember) {
        executeLoopStep(this.state, node, signalType, signalPayload, this.dispatchPort);
      } else {
        const report = this._propagateEscalate(node, signalPayload);
        // Non-loop mirror of loop-group-executor's §3.3 cascade: every
        // join-failed NON-loop convergence node's still-pending upstreams are
        // no longer needed and must be retired so they stop consuming dispatch
        // budget. Loop-group members are skipped — their cascade is owned by
        // executeLoopStep, and the revise back-edge topology makes a blind
        // cascade here unsafe (it would wrongly retire the still-needed
        // back-edge source).
        for (const escalatedId of report.escalated) {
          const target = state.nodes.get(escalatedId);
          if (!target || target.loopGroupId !== undefined) continue;
          cancelPendingUpstreams(
            state,
            target,
            evaluateJoin(state, target),
            this.dispatchPort,
          );
        }
        // Monitor (M1b): escalate propagation escalated downstream convergence
        // node(s) inside signal-propagation.ts — those markEscalated calls are
        // lifecycle transitions, not signals, so surface each through the
        // completion seam / event log exactly once.
        this._notifyPropagatedEscalations(report, signalPayload);
      }
    } else if (signalType === "revise_needed") {
      if (loopMember) {
        executeLoopStep(this.state, node, signalType, signalPayload, this.dispatchPort);
      } else {
        // Monitor (M1b): a plain revise with nowhere to re-enter escalates
        // (or a stuck / max-traversals-exhausted revision marks the reviewer
        // done) inside signal-propagation.ts — surface the report's escalated
        // node(s) through the completion seam exactly once.
        const report = this._propagateRevise(node, signalPayload);
        this._notifyPropagatedEscalations(report, signalPayload);
      }
    }

    // Steps 3-5: forward data flow on `answer`.
    if (signalType === "answer") {
      // Loop convergence: a loop member's answer step decides whether forward
      // data flow runs. Only a `converged` answer flows forward (the loop exits
      // on the happy path — forward edges run). A downgraded answer (revising /
      // stuck / max_traversals_exhausted) or an escalating step already handled
      // propagation / re-entry, so forward activation is skipped — otherwise
      // downstream nodes (e.g. the sink along the reviewer's `answer` edge)
      // would be wrongly activated while the loop is still churning.
      let forwardActivate = true;
      if (loopMember) {
        const report = executeLoopStep(this.state, node, signalType, signalPayload, this.dispatchPort);
        forwardActivate = report.outcome === "converged";
      }
      if (forwardActivate) {
        const basePayload = this._buildEdgePayload(node, signalType, signalPayload);
        // Shared forward-activation: edge activation, per-edge data mapping,
        // upstream result collection, join-satisfied re-entry, and loop-group
        // traversal accounting. Deduplicated with _forwardAnswerOnApproval so
        // the approval-resume path stays in parity with the live-signal path.
        this._forwardActivation(node, signalType, basePayload);
      }
    }

    // Step 6: dispatch ready frontier nodes via the dispatch bridge.
    await this._dispatchReadyNodes();

    // Step 7: check whether the graph is complete.
    this._checkTermination();
  }

  /**
   * Capture the dispatch task's materialized result ref onto the node's
   * runtime state. Best-effort — a missing task, an absent `getTask` port
   * (test fakes), or a failed read are no-ops that never block advancement.
   *
   * Called after `markCompleted` in every completion path (answer / revise /
   * approval-resume) so `node.result` is populated before downstream
   * consumers (graph_status include_output, export_path) read it.
   */
  private _captureNodeResult(node: NodeRuntimeState): void {
    if (node.result) return; // already captured (prior run, adoptPrior, etc.)
    const taskId = node.dispatchTaskId;
    if (!taskId) return;
    const port = this.dispatchPort as {
      getTask?: (taskId: string) => DispatchTask | undefined;
    };
    if (!port.getTask) return;
    try {
      const task = port.getTask(taskId);
      if (task?.result && !task.result.fetchError) {
        node.result = { ...task.result };
        markDirty(this.state);
      }
    } catch {
      // best-effort — a throwing getTask must never corrupt advancement
    }
  }

  /**
   * Apply the generic node-lifecycle transition for the given signal.
   *
   * Idempotent by construction: a transition is only applied when the node is
   * actually in the from-state, so re-advancing an already-processed node is a
   * harmless no-op (this also makes deferred-completion replay safe).
   */
  private _applySignalTransition(
    node: NodeRuntimeState,
    signalType: SignalType,
    signalPayload: unknown,
  ): void {
    switch (signalType) {
      case "answer":
        if (node.status === NodeStatus.Running) {
          // Liveness feed (subtask 2): the node's session is terminal — stop
          // observing it and drop the reverse-index entry.
          this._detachLiveness(node);
          markCompleted(this.state, node);
          // Record the node's genuinely produced artifacts/evidence at
          // completion (subtask C-RECORD). Fields stay absent when the node
          // produced none — never fabricated.
          this._captureNodeResult(node);
          recordNodeArtifactsAndEvidence(this.state, node);
          // Subtask 1: notify exactly once — `answer → completed`.
          this._notifyCompletion(node, "answer", signalPayload, NodeStatus.Completed);
        }
        break;
      case "revise_needed":
        // The reviewing node finished its pass; its own lifecycle completes.
        // Back-edge re-activation of the upstream node is Phase 2.
        if (node.status === NodeStatus.Running) {
          this._detachLiveness(node);
          markCompleted(this.state, node);
          this._captureNodeResult(node);
          recordNodeArtifactsAndEvidence(this.state, node);
          // Subtask 1: notify exactly once — reviewer finished → completed.
          this._notifyCompletion(node, "revise_needed", signalPayload, NodeStatus.Completed);
        }
        break;
      case "escalate":
        if (node.status === NodeStatus.Running) {
          this._detachLiveness(node);
          markEscalated(this.state, node, this._extractErrorMessage(signalPayload));
          // Subtask 1: notify exactly once — `escalate`.
          this._notifyCompletion(node, "escalate", signalPayload, NodeStatus.Escalate);
        }
        break;
      default:
        // Pausing / handoff / info signals never reach here (guarded upstream).
        break;
    }
  }

  /**
   * Fire the optional node-completion seam for a node that reached a terminal /
   * notable status (subtask 1). A no-op when no callback is registered, so the
   * engine's behavior is unchanged without the seam. The event packages the
   * immutable facts only ({@link NodeCompletionEvent}) — notification logic is
   * the consumer's concern. A throwing consumer must not corrupt the advancing
   * critical section (a notifier is observability, not a control path).
   */
  private _notifyCompletion(
    node: NodeRuntimeState,
    signalType: string,
    payload: unknown,
    nodeStatus: NodeStatus,
  ): void {
    const event: NodeCompletionEvent = {
      graphId: this.state.graphId,
      nodeId: node.nodeId,
      nodeAgent: node.agent,
      signalType,
      payload,
      nodeStatus,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
    };
    // The notification seam is optional — a throwing / absent notifier must not
    // suppress the durable event log, so the event is built unconditionally.
    const cb = this.onNodeCompletion;
    if (cb) {
      try {
        const ret = cb(event) as unknown;
        // Subtask 2: the seam is typed `() => void`, but real notifiers
        // (graph-notify.ts createGraphNotifier) return a promise — an async
        // throw / rejection would otherwise surface as an unhandled rejection
        // at the fire-and-forget advancement paths. Contain sync throws
        // (catch below) AND async rejections (catch on the thenable).
        if (
          ret !== null &&
          ret !== undefined &&
          typeof (ret as PromiseLike<unknown>).then === "function"
        ) {
          void (ret as PromiseLike<unknown>).then(undefined, (e: unknown) => {
            logWarn(
              `engine: node-completion notifier rejected for node "${node.nodeId}" in graph "${this.state.graphId}": ${this._errorString(e)}`,
            );
          });
        }
      } catch (err) {
        // never let a notifier failure break graph advancement
        logWarn(
          `engine: node-completion notifier threw for node "${node.nodeId}" in graph "${this.state.graphId}": ${this._errorString(err)}`,
        );
      }
    }
    // Write-side durable log: record the terminal transition alongside the
    // notifier. The recorder is total (never throws), so no extra guard needed
    // beyond the notifier's.
    this.graphEvents?.nodeCompleted(event);
  }

  /**
   * Notify the completion seam for a node timed out by the recovery path
   * (subtask 1). Recovery marks a `running` node `timeout` directly inside
   * `reconcileEngine` (`engine-recovery.ts`) when its dispatch task vanished —
   * that transition happens outside the signal-driven `_applySignalTransition`,
   * so recovery surfaces it through this public seam exactly once. No
   * terminating signal drives a timeout, so the event uses the synthetic
   * `timeout` marker with the node's recorded `errorReason` as payload.
   *
   * Monitor H2: the durable event log is written UNCONDITIONALLY — even when
   * no `onNodeCompletion` notifier is registered — mirroring
   * {@link _notifyCompletion} (the event is built and logged regardless of the
   * notifier seam). Only the `onNodeCompletion` callback invocation is
   * conditional. A no-op when the node is not `timeout`.
   */
  notifyNodeTimeout(nodeId: string): void {
    const node = getNode(this.state, nodeId);
    if (node.status !== NodeStatus.Timeout) return;
    this._notifyCompletion(
      node,
      "timeout",
      node.errorReason ?? "timed out",
      NodeStatus.Timeout,
    );
  }

  /**
   * Public node-terminal notification entry point (monitor H4). Wraps the
   * private {@link _notifyCompletion} so external control paths that mutate
   * node lifecycle OUTSIDE the signal-driven advancement (e.g. graph
   * cancellation, S7) can surface the node's terminal transition through the
   * same completion seam + durable event log as signal-driven transitions.
   *
   * The caller supplies the transition facts (`signalType`, `payload`,
   * `nodeStatus`) — the engine stays role-agnostic and only packages them.
   * A no-op for an unknown node id.
   */
  notifyNodeTerminal(
    nodeId: string,
    signalType: string,
    payload: unknown,
    nodeStatus: NodeStatus,
  ): void {
    const node = this.state.nodes.get(nodeId);
    if (!node) return;
    this._notifyCompletion(node, signalType, payload, nodeStatus);
  }

  /**
   * Record a session-activity heartbeat for a running node (subtask 2 of
   * node-anomaly-detection). The public liveness intake — called by the
   * platform liveness feed (session tool-call / message observations) and by
   * the stall monitor (subtask 3) when it re-classifies activity.
   *
   * Guarded: a heartbeat only lands on a node that is BOTH `running` AND
   * actually dispatched by this engine (`dispatchTaskId` set — matching the
   * launch that produced the session). Every other case is a strict no-op:
   * a completed / escalated / blocked / pending node must never be revived
   * into activity, and a node that was never launched has no live session to
   * heartbeat. The mutation is non-critical observability churn — it rides
   * the debounced persistence tier (`markNonCriticalDirty`), never the
   * synchronous write-through.
   */
  recordLivenessHeartbeat(
    nodeId: string,
    source: NodeLivenessState["heartbeatSource"],
  ): void {
    const node = this.state.nodes.get(nodeId);
    if (!node) return;
    if (node.status !== NodeStatus.Running) return;
    if (!node.dispatchTaskId) return;
    node.liveness = {
      ...node.liveness,
      lastActivityAt: Date.now(),
      heartbeatSource: source,
    };
    markNonCriticalDirty(this.state);
  }

  /**
   * Immediate-failure fast path (subtask 4 of node-anomaly-detection). Public
   * intake for session-level failure observations relayed by the platform
   * liveness feed — a dispatch session reported `error` (session.error) or
   * `gone` (session.deleted: the platform can no longer see the session at all).
   *
   * Strictly guarded — a no-op unless ALL of:
   * - the node is RUNNING (a terminal / pending / ready / blocked / cancelled
   *   node must never be revived or re-advanced);
   * - the liveness feed is attached: the seam is wired AND the node's dispatch
   *   session was registered with it at launch (`dispatchSessionId` present —
   *   the same predicate {@link _detachLiveness} uses to unregister).
   *
   * Per-kind semantics:
   * - `gone` is AUTHORITATIVE — the worker vanished and the platform can no
   *   longer observe it, so the node fails immediately through the existing
   *   escalate advance ({@link onNodeSignalEmitted} with source `"dispatch"`),
   *   reusing the standard escalate propagation + cascade cancel so the
   *   abnormal node never blocks graph advancement.
   * - `error` is first re-checked against the dispatch port via
   *   {@link isDispatchTaskLive}: a task that is STILL LIVE (running / pending /
   *   awaiting_approval) means the session error was transient — the engine
   *   records a `session` heartbeat (activity continues) and returns, keeping
   *   the node running (matching the dispatch layer's guardedMarkError
   *   semantics). A task that is genuinely NOT live escalates like `gone`.
   *
   * Returns the contained advance promise — it resolves when the observation
   * was processed (or rejected by a guard) and never rejects out of the box:
   * the escalate advance's critical section contains its own errors (subtask 2),
   * so a throwing feed relay can never break the engine.
   */
  handleFeedSessionEvent(
    nodeId: string,
    kind: "error" | "gone",
    reason?: string,
  ): Promise<void> {
    const node = this.state.nodes.get(nodeId);
    if (!node) return Promise.resolve();
    if (node.status !== NodeStatus.Running) return Promise.resolve();
    // The liveness feed must be attached: the seam is wired AND the node's
    // session was registered with it at launch. A node whose session was never
    // attached has no observed session to fail fast on.
    if (!this.livenessFeed || !node.dispatchSessionId) return Promise.resolve();

    // `error` carries the transient-error protection: the session reported an
    // error, but the dispatch task may still be live (a transient execution
    // error while the underlying session continues — guardedMarkError parity
    // with engine-recovery.ts subscribeTaskTermination). Only a task that is
    // genuinely NOT live escalates.
    if (kind === "error") {
      const taskId = node.dispatchTaskId;
      if (taskId && isDispatchTaskLive(this.dispatchPort, taskId)) {
        // Still live — record the session activity and keep the node running;
        // the subscribed onTaskTerminated listener (or recovery) advances it on
        // a genuine later termination.
        this.recordLivenessHeartbeat(nodeId, "session");
        return Promise.resolve();
      }
    }

    // `gone` (authoritative) or a genuinely-dead `error` → immediate escalate
    // through the standard advancement path: running → escalated lifecycle +
    // completion seam + escalate propagation (retry gate / cascade cancel) +
    // termination re-check. Source `"dispatch"`: the observation is a
    // dispatch-layer session event, not a recovery pass.
    const payload = { error: reason ?? "dispatch session deleted" };
    return this.onNodeSignalEmitted(node.nodeId, "escalate", payload, "dispatch");
  }

  /**
   * Reverse-lookup the node owning a live dispatch session (subtask 2). Backs
   * the platform liveness feed's `sessionId → nodeId` reverse index: given a
   * session the platform observes, the feed can find the graph node it
   * belongs to. Returns `undefined` for an unknown session or a session whose
   * node has detached (terminal transition). Only meaningful when a
   * {@link NodeLivenessFeed} is wired — the index is otherwise empty.
   */
  getNodeIdForSession(sessionId: string): string | undefined {
    return this._sessionToNodeId.get(sessionId);
  }

  /**
   * Unregister a node's session from the feed + reverse index (subtask 2).
   * Mirrors {@link NodeLivenessFeed.attach}: called when a running node
   * reaches a terminal state, so the feed stops observing the session and the
   * `sessionId → nodeId` index entry is dropped. A no-op when no feed is
   * wired (the index is empty then) or the node never attached. The feed
   * call is optional-chained and total — it can never break advancement.
   */
  private _detachLiveness(node: NodeRuntimeState): void {
    if (!this.livenessFeed) return;
    if (node.dispatchSessionId) {
      this._sessionToNodeId.delete(node.dispatchSessionId);
    }
    this.livenessFeed.detach(node.nodeId);
  }

  /**
   * Public termination re-check (monitor H4). Wraps the private
   * {@link _checkTermination} so external control paths (e.g. graph
   * cancellation, S7) can re-evaluate graph termination after manual state
   * mutation without entering a full advancement critical section. Fires the
   * `onGraphTerminal` seam (deduped via the two-layer guards) and surfaces
   * runtime-deadlock synthetic escalations through the completion seam, exactly
   * like the signal-driven path.
   */
  checkTermination(): void {
    this._checkTermination();
  }

  /**
   * Package a node's terminating signal into an {@link EdgePayload} for
   * downstream consumption (design §2.2 edge payload shape).
   */
  private _buildEdgePayload(
    source: NodeRuntimeState,
    signalType: SignalType,
    signalPayload: unknown,
  ): EdgePayload {
    const result =
      typeof signalPayload === "string"
        ? signalPayload
        : JSON.stringify(signalPayload ?? "");
    const tc = source.tokensConsumed;
    return {
      fromNode: source.nodeId,
      fromSignal: signalType,
      result,
      artifacts: source.artifacts ?? deriveNodeArtifacts(source),
      budgetConsumed: {
        tokens: tc.inputTokens + tc.outputTokens,
        cost: tc.cost,
        sessions: source.sessionsSpawned,
      },
    };
  }

  /**
   * Whether an outbound edge activates for the given signal.
   *
   * - `always` → true (any terminating signal).
   * - `on_signal` → true when the signal is in the edge's `signal_filter`.
   * - `on_condition` → delegates to the injected resolver; with no
   *   resolver the edge never activates.
   */
  private _edgeActivates(
    edge: EdgeDeclaration,
    signalType: SignalType,
    source: NodeRuntimeState,
  ): boolean {
    switch (edge.type) {
      case "always":
        return true;
      case "on_signal":
        return (edge.signal_filter ?? []).includes(signalType);
      case "on_condition":
        if (!edge.condition) return false;
        if (!this.conditionResolver) return false;
        return this.conditionResolver(edge.condition, source);
      default:
        return false;
    }
  }

  /**
   * Dispatch every node currently `ready` in the frontier (design §3.3 step 6).
   * Each becomes `running` atomically inside the critical section and is
   * removed from the frontier, then dispatched to its bound agent.
   */
  private async _dispatchReadyNodes(): Promise<void> {
    const state = this.state;
    const readyIds = [...state.frontier];
    for (const id of readyIds) {
      const node = state.nodes.get(id);
      if (!node || node.status !== NodeStatus.Ready) continue;
      await this._dispatchNode(state, node);
    }
  }

  /** Dispatch a single ready node: budget pre-check, mark running, launch. */
  private async _dispatchNode(
    state: EngineState,
    node: NodeRuntimeState,
  ): Promise<void> {
    // Budget pre-check (Phase 1: stub port; Phase 7 enforces ceilings).
    if (this.budgetPort) {
      const check = this.budgetPort.checkGraphBudget(state.graphId);
      if (check.exceeded) {
        if (node.status === NodeStatus.Ready) {
          markEscalated(this.state, node, check.reason ?? "graph budget exhausted");
          // The node is escalated, not dispatched — drop it from the frontier so
          // it is not left lingering as a ready entry (see budget pre-check).
          removeFromFrontier(state, node.nodeId);
          // Monitor (M1a): the budget pre-check escalated a ready node that was
          // never dispatched — surface it through the completion seam / durable
          // event log exactly like a live `escalate` signal (markEscalated is a
          // lifecycle transition, not a signal, so _applySignalTransition never
          // sees it).
          this._notifyCompletion(
            node,
            "escalate",
            check.reason ?? "graph budget exhausted",
            NodeStatus.Escalate,
          );
        }
        return;
      }
    }

    // ready → running happens before the async launch so the node is never
    // left in a dispatching-ready state while the critical section awaits.
    markRunning(this.state, node);
    removeFromFrontier(state, node.nodeId);
    // Write-side durable log: record that this node was dispatched (its
    // `startedAt` was set by `markRunning`). Total — never breaks dispatch.
    this.graphEvents?.nodeDispatched(state.graphId, node.nodeId, node.agent, node.startedAt);

    let task: DispatchTask;
    try {
      task = await this.dispatchPort.executeNode(
        node,
        this.parentContext,
        `graph node ${node.nodeId}`,
      );
    } catch (err) {
      // Preserve the "no dispatch seam" misconfiguration rejection: only the
      // throwOnDispatch fallback stub (index.ts, marker-detected) rethrows so
      // run() still rejects with /no dispatch seam/. All genuine dispatch
      // failures are contained below.
      if (isNoDispatchSeamStub(this.dispatchPort)) throw err;
      const reason = `node dispatch failed: ${String(err)}`;
      logWarn(
        `engine: dispatch failed for node "${node.nodeId}" in graph "${this.state.graphId}": ${reason}`,
      );
      // Orphan-path parity (engine-recovery.ts:469-478): mark the node terminal
      // (timeout) + record an escalate ledger signal so downstream joins fail
      // fast via the deferred-drain re-advance (race-guard pattern at
      // engine-advance.ts:1110-1111).
      markTimedOut(this.state, node, reason);
      recordSignalToLedger(this.state, node.nodeId, "escalate", { error: reason }, "race_guard");
      queuePendingCompletion(this.state, node.nodeId);
      this.notifyNodeTimeout(node.nodeId); // completion seam parity (index.ts:782-784)
      return; // CONTINUE dispatching the remaining frontier — do not abort the pass
    }
    node.dispatchTaskId = task.id;
    node.dispatchSessionId = task.sessionId;
    markDirty(state);
    // Liveness feed (subtask 2): record the initial `dispatch` heartbeat — the
    // node is provably live the moment its launch succeeded — and register its
    // session with the platform feed plus the engine's own reverse index
    // (`sessionId → nodeId`, for the feed's reverse lookup).
    //
    // The initial heartbeat is written WITHOUT a separate non-critical dirty
    // mark: `markDirty` above already flags this critical section, so the
    // synchronous write-through persists the whole snapshot — including the
    // `liveness` carrier (serialized at engine-persistence.ts) — in the same
    // section. Adding `markNonCriticalDirty` here would leave the flag set
    // after the sync tier owns the write, breaking the M5 contract that a
    // pure critical mutation leaves `isNonCriticalDirty` untouched (and
    // triggering a spurious debounced write on the next idle section). Later
    // heartbeats outside critical sections (`recordLivenessHeartbeat`) DO ride
    // the debounced tier, as they are genuinely standalone non-critical churn.
    node.liveness = { lastActivityAt: Date.now(), heartbeatSource: "dispatch" };
    if (this.livenessFeed) {
      this.livenessFeed.attach(node.nodeId, task.sessionId);
      this._sessionToNodeId.set(task.sessionId, node.nodeId);
    }
    // Phase-3 delivery seam (closes the known integration gap): a real dispatch
    // completion never reached the advance engine — only direct
    // `signalBridge.record` injection did. Register an `onTaskTerminated`
    // listener (via `subscribeTaskTermination`) so the dispatch subsystem's
    // terminal transition is mapped to a terminating signal and fed through
    // `signalBridge.record`, driving the graph exactly like a live worker
    // signal. The mapping lives in engine-recovery.ts so recovery re-subscribes
    // with the identical semantics. The listener fires asynchronously (the
    // manager's immediate-fire guard uses a microtask), so re-entrancy into the
    // advancing critical section is safe.
    // Monitor (M4): `subscribeTaskTermination` returns the exact callback it
    // handed to `port.onTaskTerminated`. Register it into the engine's own
    // subscription ledger (keyed by the dispatched task id) so a teardown path
    // can unregister every listener this engine wired — exposed via
    // {@link getTerminationSubscriptions} (S7 dispose iterates it and calls
    // `port.removeTaskTerminatedListener(taskId, callback)`).
    const terminationCb = subscribeTaskTermination(
      this.state,
      this.dispatchPort,
      node,
      (nid, type, payload) => {
        // F1 bridge: route dispatch terminations through the public advance
        // entry instead of the raw signalBridge.record seam. signalBridge.record
        // only fires listeners for TERMINATING signals, so a HITL pause status
        // (mapped to the pausing `need_approval` signal in engine-recovery.ts)
        // was recorded but never advanced the node — it stayed `running`
        // forever and [GRAPH BLOCKED] never fired. onNodeSignalEmitted keeps
        // signalBridge.record as the exclusive ledger-write path (step 1) and
        // additionally routes the pausing `need_approval` through
        // `_advanceSignal` → the running → blocked transition. Fire-and-forget
        // (void), matching the record-only callback's semantics today —
        // Subtask 2: attach a catch so a contained-advance regression can
        // never surface an unhandled rejection from this fire-and-forget site.
        void this.onNodeSignalEmitted(nid, type, payload, "dispatch").catch(
          (err) => {
            logWarn(
              `engine: dispatch-termination advance failed for node "${nid}" in graph "${this.state.graphId}": ${this._errorString(err)}`,
            );
          },
        );
      },
    );
    if (terminationCb) {
      this._terminationSubscriptions.push({
        taskId: task.id,
        callback: terminationCb,
      });
    }

    // Post-registration race-condition guard: after the onTaskTerminated listener
    // is attached, re-read the dispatched task's current status. If the task has
    // ALREADY reached a terminal status (completed / error / timeout) before the
    // listener was attached, the microtask-scheduled listener fire would miss it.
    // Derive the signal via mapDispatchStatusToSignal, record it in
    // node.signalsObserved (so _latestTerminating() can replay it during drain),
    // and queue a deferred completion that _drainDeferred() will process when the
    // current critical section exits. This keeps signalBridge.record() as the
    // exclusive delivery seam owned by the subscribeTaskTermination callback —
    // no duplicate dispatch→signal paths to keep in sync.
    //
    // Double-advance prevention: the deferred completion drains AFTER the lock
    // is released by _runCriticalSection's finally block. If the
    // microtask-scheduled onTaskTerminated listener fires first (theoretical —
    // it is scheduled after this guard runs synchronously), the listener
    // advances via signalBridge.record → _advanceSignal → lock-held →
    // queuePendingCompletion, which is the same deferred path. When the guard's
    // deferred completion finally drains, subscribeTaskTermination's own
    // status != Running guard (engine-recovery.ts:240) rejects the stale
    // callback (the node already transitioned out of Running).
    //
    // cancelled status must NOT be turned into a signal (handled by direct node
    // cancellation via the cascade canceller or the listener's cancelled path).
    if (this.dispatchPort.getTask) {
      const currentStatus = this.dispatchPort.getTask(task.id);
      if (
        currentStatus &&
        currentStatus.status !== "cancelled"
      ) {
        // Transient-error guard (subtask 4): the post-subscription read may
        // report `error` while the task/session is actually still live. Re-check
        // liveness via the dispatch port before queueing an escalate — a
        // transient execution error must never latch the node as a terminal
        // error while the underlying session continues. When the task is still
        // live, skip the escalate (the node stays running; the subscribed
        // listener or recovery will advance it on a genuine termination).
        if (
          currentStatus.status === "error" &&
          isDispatchTaskLive(this.dispatchPort, task.id)
        ) {
          return;
        }
        const current = this.state.nodes.get(node.nodeId);
        if (
          current &&
          current.status === NodeStatus.Running &&
          current.dispatchTaskId === task.id
        ) {
          const sig = mapDispatchStatusToSignal(currentStatus.status, currentStatus);
          if (sig) {
            // Record the signal through the shared ledger write path so the
            // ledger history/lastSignalAt stay complete for this race-guard
            // synthetic signal, matching live-worker signals. `_latestTerminating()`
            // still finds it on node.signalsObserved when the deferred completion
            // is drained. This mirrors the recovery path (engine-recovery.ts
            // reconcileEngine → deferred signals).
            recordSignalToLedger(this.state, node.nodeId, sig.type, sig.payload, "race_guard");
            queuePendingCompletion(this.state, node.nodeId);
          }
        }
      }
    }
  }

  /**
   * Advance `executing → complete` when no node remains active (running, ready,
   * pending, or blocked). Mirrors the exit guard in design §1.2.
   *
   * Also detects the quiescent-blocked terminal: no running / ready / pending
   * nodes remain but ≥1 blocked node exists. Fires `onGraphTerminal` with
   * `isBlocked=true` WITHOUT a phase transition. Each terminal type (complete /
   * blocked) fires at most once via separate dedupe guards.
   *
   * Monitor (M1c): the runtime-deadlock guard's synthetic escalations (pending
   * nodes escalated with `DEADLOCK_REASON` inside checkGraphTermination) are
   * surfaced through the completion seam via the `onSyntheticEscalate` hook —
   * one `_notifyCompletion` per escalated node. Dedup: the deadlock guard only
   * escalates `pending` nodes and only when no node is already escalated
   * (`counts.escalate === 0`), so a node escalated by propagation (M1b) or a
   * live signal is never double-notified; the status guard below is the
   * defense-in-depth.
   */
  private _checkTermination(): void {
    checkGraphTermination(
      this.state,
      this.onGraphTerminal,
      this._terminationCtx,
      (nodeId, reason) => {
        const node = this.state.nodes.get(nodeId);
        if (!node) return;
        // Only a node the guard JUST escalated (`pending → escalate`) is
        // notified — an already-terminal node cannot be re-escalated, and a
        // node escalated by a live signal or propagation is not pending.
        if (node.status !== NodeStatus.Escalate) return;
        this._notifyCompletion(node, "escalate", reason, NodeStatus.Escalate);
      },
      // F3: the runtime-deadlock predicate. A pure state reader built from the
      // edge topology + conditionResolver — a pending node is dead-ended when
      // every one of its incoming edges can provably never activate, so the
      // deadlock guard may fire even when an escalated/timed-out node exists.
      (nodeId) => this._isPendingDeadEnded(nodeId),
    );
  }

  /**
   * Whether a pending node is dead-ended: every one of its incoming edges is
   * provably unable to activate, so the node can never become `ready` (F3).
   *
   * A pending node is dead-ended iff EVERY incoming edge is:
   * (i)   an `on_condition` edge with no condition, no injected resolver, or a
   *       resolver that returns false (the edge can never fire);
   * (ii)  an `on_signal` edge whose `signal_filter` excludes the source's
   *       recorded terminating signal while the source is terminal
   *       (Completed / Done / Escalate / Timeout — the source can never emit
   *       an in-filter signal again);
   * (iii) sourced from a Cancelled node (a cancelled source never emits).
   *
   * An `always` edge NEVER counts as dead-ended, even from a terminal source:
   * the graph is then in an error state awaiting orchestrator attention — an
   * escalated node with a pending downstream via an `always` edge must keep
   * the engine `executing` (engine-terminal.test.ts "does NOT deadlock-
   * terminate a graph with an escalated node and a pending downstream").
   *
   * Pure state reader — never mutates. Unknown / unverifiable topology
   * conservatively reports NOT dead-ended so the guard never force-completes
   * a graph it cannot prove is stuck.
   */
  private _isPendingDeadEnded(nodeId: string): boolean {
    const state = this.state;
    const node = state.nodes.get(nodeId);
    if (!node || node.status !== NodeStatus.Pending) return false;
    const incoming = state.graphDeclaration.edges.filter((e) => e.to === nodeId);
    if (incoming.length === 0) return false;
    for (const edge of incoming) {
      const source = state.nodes.get(edge.from);
      // (iii) an edge sourced from a cancelled node can never fire.
      if (source && source.status === NodeStatus.Cancelled) continue;
      if (edge.type === "always") return false; // always edges never count
      if (edge.type === "on_condition") {
        // (i) a never-activatable on_condition edge.
        if (!edge.condition || !this.conditionResolver) continue;
        if (!source) return false; // missing source — cannot verify dead-end
        try {
          if (!this.conditionResolver(edge.condition, source)) continue;
        } catch (err) {
          // Subtask 2: a throwing resolver can never activate its edge — the
          // pending node IS dead-ended (the edge is provably never-firing).
          // Without this the F3 guard could not quiesce a graph whose resolver
          // already aborted advancement, leaving it hung in `executing`.
          logWarn(
            `engine: conditionResolver threw for condition "${edge.condition}" (node "${nodeId}", graph "${this.state.graphId}"): ${this._errorString(err)}`,
          );
          continue;
        }
        return false; // could still activate → not dead-ended
      }
      if (edge.type === "on_signal") {
        // (ii) filter excludes the source's recorded terminating signal while
        // the source is terminal.
        if (
          source &&
          (source.status === NodeStatus.Completed ||
            source.status === NodeStatus.Done ||
            source.status === NodeStatus.Escalate ||
            source.status === NodeStatus.Timeout)
        ) {
          const sig = this._latestTerminating(source);
          if (!sig || !(edge.signal_filter ?? []).includes(sig.type)) continue;
        }
        return false; // source not terminal, or an in-filter signal → not dead-ended
      }
      return false; // unknown edge type — conservative
    }
    return true;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Highest-severity terminating signal recorded for a node, or null. */
  private _latestTerminating(
    node: NodeRuntimeState,
  ): { type: SignalType; payload: unknown } | null {
    for (const t of TERMINATING_SEVERITY) {
      if (node.signalsObserved[t] !== undefined) {
        return { type: t, payload: node.signalsObserved[t] };
      }
    }
    return null;
  }

  /** Best-effort error string from an `escalate` payload. */
  private _extractErrorMessage(payload: unknown): string {
    if (typeof payload === "string") return payload || "escalated";
    if (payload && typeof payload === "object") {
      const obj = payload as { reason?: unknown; error?: unknown };
      if (typeof obj.reason === "string") return obj.reason;
      if (typeof obj.error === "string") return obj.error;
    }
    return "escalated";
  }

  // ── Phase 2 signal propagation ──────────────────────────────────────────

  /**
   * Propagate an `escalate` forward to the nearest fan-in convergence node(s),
   * consulting each outbound edge's `retry` policy (retry re-marks the node
   * `ready`; otherwise the escalation travels up the escalation lattice).
   * Delegates to {@link propagateEscalate} (`signal-propagation.ts`).
   *
   * Used for **non-loop-group** nodes; loop-group members are routed through
   * the {@link executeLoopStep} executor (which also applies the cascade
   * canceller on a failed convergence join).
   */
  private _propagateEscalate(
    node: NodeRuntimeState,
    signalPayload: unknown,
  ): SignalPropagationReport {
    return propagateEscalate(this.state, node, signalPayload);
  }

  /**
   * Surface every node a propagation pass escalated (monitor M1b).
   *
   * `propagateEscalate` / `propagateRevise` escalate nodes via the lifecycle
   * `markEscalated` / `markDone` transitions inside signal-propagation.ts —
   * those are not signals, so `_applySignalTransition` never sees them and the
   * completion seam would otherwise stay silent. This helper replays the
   * propagation report's `escalated` list through {@link _notifyCompletion}.
   *
   * Dedup: a node is only notified when it actually landed in a terminal
   * escalated state this pass (`Escalate`, or `Done` for a stuck / exhausted
   * revise). The escalating SOURCE node was already notified by
   * `_applySignalTransition`, and an already-terminal node cannot be escalated
   * again (escalate is terminal), so no node is double-notified here; the
   * status guard is the defense-in-depth against any future overlap with the
   * synthetic-escalation path ({@link _checkTermination}).
   *
   * The payload is the propagation's machine-readable reason when present
   * (e.g. `max_traversals exhausted`), falling back to the original signal
   * payload for a join-failure cascade.
   */
  private _notifyPropagatedEscalations(
    report: SignalPropagationReport,
    fallbackPayload: unknown,
  ): void {
    const payload = report.reason ?? fallbackPayload;
    for (const id of report.escalated) {
      const node = this.state.nodes.get(id);
      if (!node) continue;
      if (node.status !== NodeStatus.Escalate && node.status !== NodeStatus.Done) {
        continue;
      }
      this._notifyCompletion(node, "escalate", payload, node.status);
    }
  }

  /**
   * Back-propagate a `revise_needed` along the loop group's
   * `on_signal(revise_needed)` back-edges so upstream nodes re-enter `ready`,
   * bounded by the loop group's `max_traversals` (escalate when exhausted).
   * Delegates to {@link propagateRevise} (`signal-propagation.ts`).
   *
   * Used for **non-loop-group** nodes (a plain revise with nowhere to re-enter
   * escalates with reason `no loop group`); loop-group members are routed
   * through the {@link executeLoopStep} executor (which applies the §4.3 stuck
   * and exhaustion early-exits first).
   */
  private _propagateRevise(
    node: NodeRuntimeState,
    signalPayload: unknown,
  ): SignalPropagationReport {
    return propagateRevise(this.state, node, signalPayload);
  }

  // ── Phase 3 approval lifecycle ────────────────────────────────────────────

  /**
   * Pause a `needs_approval` node for human decision.
   *
   * Called inside the advancement critical section when the node emits the
   * pausing `need_approval` signal. Transitions `running → blocked` via
   * {@link markNodeBlocked}, removes the node from the frontier, and gates its
   * downstream branch (no forward data flow). The structured approval context
   * (upstream results + graph totals, §1.4) is assembled and stashed on the
   * node's `signalsObserved.approval_payload` for consumers to render.
   *
   * Idempotent: a replayed `need_approval` on a non-`running` node (or on a
   * node that did not declare `needs_approval`) is a no-op.
   */
  private _pauseForApproval(node: NodeRuntimeState, _signalPayload: unknown): void {
    if (node.status !== NodeStatus.Running) return;
    // Only a declared `needs_approval` node pauses; a stray `need_approval`
    // signal on a non-gate node is recorded but never blocks the graph.
    if (!node.needsApproval) return;
    markNodeBlocked(this.state, node);
    removeFromFrontier(this.state, node.nodeId);
    // Assemble the human-facing decision context from the frozen upstream state.
    // Routed through the shared helper (writes node.signalsObserved; a non-signal
    // stash like approval_payload does NOT enter the ledger history).
    recordSignalToLedger(this.state, node.nodeId, "approval_payload", buildApprovalPayload(this.state, node));
    markDirty(this.state);
  }

  /**
   * Resume a blocked `needs_approval` node with an **approval**.
   *
   * Under the advancement critical section: `blocked → completed` + record an
   * `answer` signal ({@link approveBlockedNode}), then run the forward `answer`
   * data flow so downstream `on_signal(answer)` / `always` edges activate and
   * satisfied downstream joins become `ready` (§1.3 resume-on-approval).
   * Freshly-ready nodes are dispatched and termination re-checked inside the
   * same section (durable via the write-through persistence seam).
   */
  approveNode(nodeId: string, payload?: unknown): Promise<void> {
    return this._runCriticalSection(async () => {
      const node = getNode(this.state, nodeId);
      // Capture the dispatch task's materialized result (if available) BEFORE
      // building the EdgePayload, so recordNodeArtifactsAndEvidence (invoked
      // inside approveBlockedNode) can derive the node's genuine artifacts into
      // the downstream merged_artifacts.
      this._captureNodeResult(node);
      const edgePayload = approveBlockedNode(
        this.state,
        node,
        payload,
      );
      if (edgePayload) {
        this._forwardAnswerOnApproval(nodeId, edgePayload);
        // Subtask 1: notify exactly once — `blocked → completed` on
        // approval-resume. Guarded on `edgePayload` (null = not actually
        // blocked, an idempotent no-op) so the seam fires only on a real
        // transition, matching the signal-driven points.
        this._notifyCompletion(
          node,
          "answer",
          payload ?? edgePayload.result,
          NodeStatus.Completed,
        );
      }
      await this._dispatchReadyNodes();
      this._checkTermination();
    });
  }

  /**
   * Resume a blocked `needs_approval` node with a **rejection**.
   *
   * Delegates to {@link rejectBlockedNode} (`signal-propagation.ts` re-entry
   * lane reuse): `blocked → ready` re-enter with the rejection feedback merged
   * into the re-execution prompt, or `blocked → escalate` when the node has no
   * loop group to re-open. No forward data flow runs on reject.
   */
  rejectNode(nodeId: string, reason?: string): Promise<void> {
    return this._runCriticalSection(async () => {
      rejectBlockedNode(this.state, getNode(this.state, nodeId), reason);
      await this._dispatchReadyNodes();
      this._checkTermination();
    });
  }

  /**
   * Partially approve a blocked `needs_approval` node (§1.5).
   *
   * - {@link pruneDownstreamSubgraph} — cancel the rejected branches'
   *   transitive dependents that cannot survive on the approved sources alone.
   * - {@link resetRejectedUpstreams} — drop the rejected sources from the
   *   approval node's accumulated results and recompute its join, so it
   *   re-waits for their re-execution.
   * - {@link reenterRejectedUpstreams} — re-mark the rejected upstreams `ready`
   *   (completed → ready) with feedback so they re-run and re-answer.
   * - If the approval node's join is still satisfied by the surviving approved
   *   sources (e.g. `any`), it re-enters `ready` to re-render immediately;
   *   otherwise it stays `blocked` awaiting the re-executed branches.
   */
  partialApprove(
    nodeId: string,
    _approved: string[],
    rejected: string[],
    reason?: string,
  ): Promise<void> {
    return this._runCriticalSection(async () => {
      const node = getNode(this.state, nodeId);
      if (node.status === NodeStatus.Blocked) {
        pruneDownstreamSubgraph(this.state, rejected, nodeId, this.dispatchPort);
        resetRejectedUpstreams(this.state, node, rejected);
        reenterRejectedUpstreams(this.state, rejected, reason);
        if (
          node.joinSatisfied &&
          canTransitionNode(node.status, NodeStatus.Ready)
        ) {
          markReady(this.state, node);
          addToFrontier(this.state, nodeId);
        }
        // Notify external observers: partial approval resolved the gate for
        // the approved branches (their downstream edges fire); the rejected
        // branches have been pruned + re-entered. The node's current status
        // (Blocked while waiting for re-execution, or Ready to re-render)
        // is the authoritative signal.
        this._notifyCompletion(
          node,
          "answer",
          { partial_approve: { approved: _approved, rejected, reason } },
          node.status,
        );
      }
      await this._dispatchReadyNodes();
      this._checkTermination();
    });
  }

  /**
   * Retry a terminal graph's node (tool-merge-map.md §2.2 `graph_run(node_id,
   * retry=true, modify_prompt=...)`).
   *
   * Under the advancement critical section: {@link resetNodeForRetry} re-opens
   * the target node (and its downstream subgraph) into a clean `pending` state,
   * prepends `modify_prompt` to the target's prompt, re-marks the target `ready`
   * (into the frontier), and re-opens a terminal graph phase. The freshly-ready
   * target is then dispatched and termination re-checked inside the same
   * section (durable via the write-through persistence seam).
   *
   * Downstream nodes reset to `pending` re-activate via their joins once the
   * target re-completes and re-emits — only the target is re-dispatched here, so
   * {@link RetryReport.reDispatched} is the number of reset nodes that ended this
   * call in `running` (normally the single target).
   */
  retryNode(nodeId: string, opts?: RetryNodeOptions): Promise<RetryReport> {
    return this._runCriticalSection(async () => {
      const report = resetNodeForRetry(this.state, nodeId, opts);
      // 5. Reset terminal dedupe guards — `resetNodeForRetry` re-opens a
      //    terminal graph phase (Complete → Executing). Without this reset,
      //    the one-shot guards from the prior completion block the legitimate
      //    `[GRAPH COMPLETE]` / `[GRAPH BLOCKED]` that should fire when the
      //    retried chain quiesces again (stale dedupe guard B2).
      this._terminationCtx.terminalComplete = false;
      this._terminationCtx.terminalBlocked = false;
      // Monitor (M10): re-opening a terminal graph starts a NEW terminal
      // epoch — the persisted cross-restart dedup flag must be cleared
      // alongside the per-instance ctx guards so the retried chain's next
      // terminal event fires (and the cleared flag is durable via markDirty).
      if (this.state.terminalNotified) {
        this.state.terminalNotified = undefined;
        markDirty(this.state);
      }
      await this._dispatchReadyNodes();
      this._checkTermination();
      let reDispatched = 0;
      for (const id of report.reset) {
        const n = this.state.nodes.get(id);
        if (n && n.status === NodeStatus.Running && n.dispatchTaskId) {
          reDispatched += 1;
        }
      }
      return { ...report, reDispatched };
    });
  }

  /**
   * Reset the terminal dedupe guards (`terminalComplete` / `terminalBlocked`)
   * on the internal {@link TerminationContext}. Call this after manually
   * re-opening a terminal graph phase (e.g. adding nodes to a completed graph
   * and transitioning phase back to `Executing`) so that the next legitimate
   * terminal event fires exactly once.
   *
   * This is the public counterpart of the guard-reset embedded in
   * {@link retryNode} — use it for non-retry re-open paths (e.g. extend after
   * complete) where the engine instance is reused.
   */
  resetTerminalDedupe(): void {
    this._terminationCtx.terminalComplete = false;
    this._terminationCtx.terminalBlocked = false;
    // Monitor (M10): same epoch reset as `retryNode` — the persisted
    // cross-restart dedup flag must not suppress the next legitimate terminal
    // event after a non-retry re-open (e.g. extend after complete). Cleared
    // durably via markDirty.
    if (this.state.terminalNotified) {
      this.state.terminalNotified = undefined;
      markDirty(this.state);
    }
  }

  /**
   * Forward an approved node's `answer` payload along its outbound edges,
   * activating downstream joins and readying satisfied targets. Mirrors the
   * `answer` forward-data-flow block in {@link _advance} but is driven by an
   * approval resume instead of a live worker signal.
   */
  private _forwardAnswerOnApproval(nodeId: string, payload: EdgePayload): void {
    const source = getNode(this.state, nodeId);
    // Shared forward-activation: identical to the live-signal answer path,
    // including loop-group traversal accounting + round recording (which the
    // prior approval path omitted). Driven by an approval resume instead of a
    // live worker signal.
    this._forwardActivation(source, "answer", payload);
  }

  /**
   * Shared forward-activation for an `answer` signal: walk the source's
   * outbound edges, apply edge activation, per-edge data mapping, collect
   * upstream results, and re-enter satisfied downstream joins into `ready`.
   * Includes loop-group traversal accounting (intra-group `always`-edge
   * re-entries) + round recording.
   *
   * Used by BOTH the live-signal path ({@link _advance} answer block) and the
   * approval-resume path ({@link _forwardAnswerOnApproval}) so the two never
   * drift. The approval path previously omitted the loop traversal increment
   * and round recording — this shared method brings it into parity.
   */
  private _forwardActivation(
    source: NodeRuntimeState,
    signalType: SignalType,
    basePayload: EdgePayload,
  ): void {
    const state = this.state;
    for (const edge of state.graphDeclaration.edges) {
      if (edge.from !== source.nodeId) continue;
      // Skip self-loop edges: a single-point always self-loop must never
      // re-enter itself (defense-in-depth — the validator normally rejects such
      // graphs, but one built bypassing validation could otherwise spin forever).
      if (edge.to === source.nodeId) continue;
      if (!this._edgeActivates(edge, signalType, source)) continue;

      const target = getNode(state, edge.to);
      // Step 4: apply the edge's data_passthrough transform (truncation /
      // exclusion) to a per-edge clone, then record the upstream result and
      // recompute the join strategy. A per-edge transform lets two edges
      // leaving the same source deliver differently-shaped payloads.
      const payload = applyDataMapping(basePayload, edge.data_passthrough);
      collectUpstreamResults(state, target, payload);
      // Step 5: a satisfied downstream becomes ready + in frontier.
      //
      // Beyond the normal `pending → ready` activation, a **loop-group**
      // convergence node that is `completed` (it finished a prior
      // `revise_needed` review round) re-enters `ready` when its join
      // re-satisfies — this is the `completed → ready` loop re-entry edge
      // (node-lifecycle.ts §2, orchestration-patterns.md §1.6). Non-loop
      // `completed` nodes are never re-activated (they are terminal sinks).
      if (target.joinSatisfied) {
        // D3: retire any still-pending sibling upstreams now that the fan-in
        // join has resolved (any/quorum satisfied). cancelPendingUpstreams
        // no-ops on a `waiting` verdict and skips already-resolved sources, so
        // linear flows and always-cycle loop re-entry are unaffected. Gated to
        // NON-loop targets: a loop convergence node's upstream set includes its
        // revise back-edge (getUpstreamNodeIds counts it), so a blind cascade
        // here would wrongly retire the still-needed back-edge source. Loop
        // cancellation is owned by executeLoopStep (§3.3, escalate path).
        if (target.loopGroupId === undefined) {
          cancelPendingUpstreams(
            state,
            target,
            evaluateJoin(state, target),
            this.dispatchPort,
          );
        }
        const isPendingActivation = target.status === NodeStatus.Pending;
        const isLoopReentry = target.status === NodeStatus.Completed &&
          target.loopGroupId !== undefined;
        const reEnter = isPendingActivation || isLoopReentry;
        if (reEnter) {
          let blockedByCap = false;
          // Loop-group traversal accounting for always-edge cycles.
          //
          // Only `always`-edge-driven re-entries consume a traversal.
          // `on_signal(revise_needed)` edges route through
          // `executeLoopStep → propagateRevise` which owns the increment
          // for revise-driven loops. `on_signal(answer)` edges are forward
          // data flow — in revise-driven loops they re-enter the reviewer
          // but that re-entry is the second half of an already-counted
          // traversal round, so no increment is needed here. Only pure
          // `always` cycles — where no revise back-edge exists to count
          // the traversal — route through this path.
          //
          // Only intra-group edges count; cross-group edges never consume
          // a traversal. Pending → Ready (normal forward activation) is
          // never a loop re-entry.
          if (isLoopReentry && source.loopGroupId === target.loopGroupId && edge.type === "always") {
            const groupId = target.loopGroupId!;
            if (!incrementLoopTraversal(state, groupId)) {
              // Hard cap reached: escalate the target instead of re-entering.
              // `completed → escalate` is valid per the lifecycle table
              // (node-lifecycle.ts §2). The target escalates with reason
              // `"max_traversals exhausted"`, matching the revise-driven
              // exhaustion path so the graph's termination logic sees a
              // consistent outcome. No traversal was consumed — the cap
              // was already at maxTraversals from a prior re-entry.
              markDone(this.state, target, "max_traversals exhausted");
              blockedByCap = true;
            } else {
              // Per-node traversal count for loop re-entry diagnostics
              // (graph_status). Incremented once per re-entry alongside
              // the per-group counter in incrementLoopTraversal().
              target.traversalCount += 1;
              // Traversal consumed: record a completed-round snapshot for
              // diagnostics (graph_status include_history). The round number
              // is 1-based and monotonic across the group's whole history.
              const group = state.loopGroups.get(groupId)!;
              const roundEntry: RoundHistoryEntry = {
                round: (group.rounds?.length ?? 0) + 1,
                traversalCount: group.traversalCount,
                nodeIds: [target.nodeId],
                status: source.status,
                startedAt: source.startedAt,
                completedAt: Date.now(),
              };
              recordLoopRound(state, groupId, roundEntry);
            }
          }
          if (!blockedByCap) {
            markReady(this.state, target);
            addToFrontier(state, edge.to);
          }
        }
      }
    }
  }
}

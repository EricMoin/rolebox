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
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import type { EdgeDeclaration } from "../../types.graph-v2.ts";
import type { DispatchTask } from "../../dispatch/types.ts";
import type { BudgetCheckResult, UsageRecord } from "../../dispatch/budget/budget-tracker.ts";
import {
  shouldPersist,
  clearDirty,
  clearNonCriticalDirty,
  shouldPersistNonCritical,
  markDirty,
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
  markNodeBlocked,
  canTransitionNode,
} from "./node-lifecycle.ts";
import { subscribeTaskTermination, mapDispatchStatusToSignal } from "./engine-recovery.ts";
import { collectUpstreamResults } from "./join-evaluator.ts";
import { applyDataMapping } from "./data-mapping-transform.ts";
import {
  propagateEscalate,
  propagateRevise,
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
   */
  persistState?: (state: EngineState) => void;
  /**
   * Optional debounced-persistence seam (Q2 Option A, non-critical tier). When
   * a critical section produced ONLY non-critical mutations (signal-ledger
   * history, budget / tokensConsumed counters), the `finally` block routes the
   * write through this debounced seam instead of the synchronous
   * {@link persistState}. Absent → non-critical-only sections skip persistence
   * (the in-memory engine still runs).
   */
  schedulePersistState?: (state: EngineState) => void;
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
  private readonly persistState?: (state: EngineState) => void;
  private readonly schedulePersistState?: (state: EngineState) => void;
  private readonly flushPersistState?: () => void;
  private readonly onNodeCompletion?: (event: NodeCompletionEvent) => void;
  private readonly graphEvents?: GraphEventRecorder;
  private readonly onGraphTerminal?: (event: GraphTerminalEvent) => void;
  private readonly _terminationCtx: TerminationContext = {
    terminalComplete: false,
    terminalBlocked: false,
  };

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
      void this._advanceSignal(nodeId, type, payload);
    };
    return this.signalBridge.onNodeSignalEmitted(listener);
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
    return this._runCriticalSection(() =>
      this._advance(nodeId, signalType, signalPayload),
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
  private async _runCriticalSection<T>(work: () => Promise<T>): Promise<T> {
    try {
      if (
        this.state.phase === EnginePhase.Idle &&
        canTransitionPhase(this.state, EnginePhase.Executing)
      ) {
        transitionPhase(this.state, EnginePhase.Executing);
      }
      return await work();
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
          this.persistState?.(this.state);
        } else {
          this.schedulePersistState?.(this.state);
        }
        clearDirty(this.state);
        clearNonCriticalDirty(this.state);
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
      const node = getNode(this.state, nodeId);
      const sig = this._latestTerminating(node);
      if (!sig) continue;
      // Lock is free here — each drained item re-acquires its own section.
      await this._advanceSignal(nodeId, sig.type, sig.payload);
    }
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
        this._propagateEscalate(node, signalPayload);
      }
    } else if (signalType === "revise_needed") {
      if (loopMember) {
        executeLoopStep(this.state, node, signalType, signalPayload, this.dispatchPort);
      } else {
        this._propagateRevise(node, signalPayload);
      }
    }

    // Steps 3-5: forward data flow on `answer`.
    if (signalType === "answer") {
      // Loop convergence: record the `converged` early-exit and retire any
      // no-longer-needed pending upstreams (the loop ends on the happy path —
      // only forward edges run).
      if (loopMember) {
        executeLoopStep(this.state, node, signalType, signalPayload, this.dispatchPort);
      }
      const basePayload = this._buildEdgePayload(node, signalType, signalPayload);
      // Shared forward-activation: edge activation, per-edge data mapping,
      // upstream result collection, join-satisfied re-entry, and loop-group
      // traversal accounting. Deduplicated with _forwardAnswerOnApproval so
      // the approval-resume path stays in parity with the live-signal path.
      this._forwardActivation(node, signalType, basePayload);
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
          markCompleted(this.state, node);
          this._captureNodeResult(node);
          recordNodeArtifactsAndEvidence(this.state, node);
          // Subtask 1: notify exactly once — reviewer finished → completed.
          this._notifyCompletion(node, "revise_needed", signalPayload, NodeStatus.Completed);
        }
        break;
      case "escalate":
        if (node.status === NodeStatus.Running) {
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
        cb(event);
      } catch {
        // never let a notifier failure break graph advancement
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
   * so recovery surfaces it through this public seam exactly once. A no-op when
   * the node is not `timeout` or no callback is registered. No terminating
   * signal drives a timeout, so the event uses the synthetic `timeout` marker
   * with the node's recorded `errorReason` as payload.
   */
  notifyNodeTimeout(nodeId: string): void {
    const cb = this.onNodeCompletion;
    if (!cb) return;
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

    const task = await this.dispatchPort.executeNode(
      node,
      this.parentContext,
      `graph node ${node.nodeId}`,
    );
    node.dispatchTaskId = task.id;
    node.dispatchSessionId = task.sessionId;
    markDirty(state);
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
    subscribeTaskTermination(this.state, this.dispatchPort, node, (nid, type, payload) => {
      this.signalBridge.record(this.state, nid, type, payload, "dispatch");
    });

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
   */
  private _checkTermination(): void {
    checkGraphTermination(this.state, this.onGraphTerminal, this._terminationCtx);
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
  ): void {
    propagateEscalate(this.state, node, signalPayload);
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
  ): void {
    propagateRevise(this.state, node, signalPayload);
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

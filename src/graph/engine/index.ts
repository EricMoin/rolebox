/**
 * Graph Execution Engine v2 — Public Engine API (barrel)
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * The single public entry point for the graph execution engine. Consumers
 * construct an {@link EngineRuntime} with {@link createEngine}, then drive it
 * through the lifecycle:
 *
 *     provision()  — initialize {@link EngineState} (register nodes, bootstrap roots).
 *     run()        — transition `idle → executing` and dispatch the ready roots.
 *     status()     — read a snapshot of the {@link EngineState}.
 *
 * Beyond the core lifecycle, the full control surface is implemented:
 * `recover()` resumes an interrupted graph from its persisted state,
 * `cancel()` / `cancelNodes()` tear down running graphs, `approveNode()` /
 * `rejectNode()` / `partialApprove()` drive the `needs_approval` gate,
 * `retryNode()` re-opens a node for re-dispatch, and `dispose()` releases a
 * replaced runtime (cancelling its debounced persistence timer).
 *
 * Design: the engine is a role-agnostic primitive. This barrel only wires the
 * runtime; it carries no dispatch or role logic itself. The dispatch surface
 * is an injected seam (see {@link EngineRuntimeOptions.dispatch}) so callers
 * and tests can avoid real sub-agent dispatch. External integration (wiring
 * this runtime into the platform entry points and re-exporting it from the
 * package root) lives in `src/graph/tools/graph-tools.ts`.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md`.
 */

import type { DispatchManager } from "../../dispatch/core/manager.ts";
import type { DispatchTask } from "../../dispatch/types.ts";
import type { GraphDeclaration } from "../../types.graph-v2.ts";
import { EnginePhase, NodeStatus } from "../../constants.ts";
import type {
  EngineState,
  NodeLivenessState,
  NodeRuntimeState,
  SignalLedgerSource,
} from "../../types.engine-v2.ts";
import {
  createEngineState,
  provision as provisionState,
} from "./engine-state.ts";
import {
  AdvanceEngine,
  type AdvanceEngineOptions,
  type NodeDispatchPort,
  type NodeLivenessFeed,
  type GraphBudgetPort,
  type EdgeConditionResolver,
  type NodeCompletionEvent,
  type GraphTerminalEvent,
} from "./engine-advance.ts";
import { SignalBridge } from "./signal-bridge.ts";
import {
  BudgetBridge,
} from "./budget-bridge.ts";
import {
  DispatchBridge,
  type DispatchParentContext,
} from "./dispatch-bridge.ts";
import defaultConditionResolver from "./condition-resolver.ts";
import {
  EnginePersistence,
} from "./engine-persistence.ts";
import type { GraphEventRecorder } from "./graph-events.ts";
import {
  executeLoopStep,
  recordConvergenceOutput,
  resetConvergenceTracker,
  fingerprintPayload,
  extractUnresolved,
  type LoopOutcome,
  type LoopStepReport,
  type LoopEscalatePayload,
} from "./loop-group-executor.ts";
import type {
  RetryNodeOptions,
  RetryReport,
} from "./node-retry.ts";
import {
  adoptPriorNodeStates,
  clearStaleCriticalSection,
  hydrateEngineState,
  isDispatchTaskLive,
  reconcileEngine,
  rebuildFrontier,
  EngineLockSweeper,
  NodeLivenessMonitor,
  NodeStalenessWatcher,
  type DispatchRecoveryPort,
  type NodeStallEvent,
  type ReconcileReport,
  type StallDetectionInfo,
} from "./engine-recovery.ts";
import { markCancelled, markDone, canTransitionNode } from "./node-lifecycle.ts";
import {
  canTransitionPhase,
  transitionPhase,
} from "./engine-state.ts";
import {
  cancelNodes as cancelScopedNodes,
  type CancelScopeOptions,
  type CancelScopeReport,
} from "./cancellation.ts";

// ── EngineRuntime ───────────────────────────────────────────────────────────

/**
 * A bound engine instance for a single graph execution.
 *
 * One `EngineRuntime` owns one {@link EngineState} and one signal-driven
 * {@link AdvanceEngine}. It is constructed via {@link createEngine}.
 */
export interface EngineRuntime {
  /**
   * Initialize the {@link EngineState}: register every declared node and
   * bootstrap the topology (root nodes become `ready` and enter the frontier).
   *
   * Idempotent — calling more than once is a no-op.
   *
   * @returns a snapshot of the state after provisioning.
   */
  provision(): EngineState;

  /**
   * Transition the engine from `idle` to `executing` and dispatch the ready
   * root nodes. Provisioning is applied first if it has not run yet.
   *
   * Requires a dispatch seam (see {@link EngineRuntimeOptions.dispatch} or
   * {@link EngineRuntimeOptions.manager}); without one, this rejects with a
   * clear error.
   */
  run(): Promise<void>;

  /**
   * Resume an interrupted graph instance (Phase 3 — crash recovery).
   *
   * Loads the persisted {@link EngineState} (engine-state-machine.md §5.1) and
   * reconciles every `running` node against the dispatch system
   * (`failure-resilience.md §5.2`): vanished → `timeout`, finished-during-the-
   * window → re-emit its signal, still-live → re-subscribe `onTaskTerminated`.
   * Rebuilds the frontier and drains the deferred completions. A no-op when no
   * persisted state exists (first run) or no persistence is configured.
   *
   * Rejects when the persisted state file exists but cannot be read (any
   * non-ENOENT read failure): an unreadable state file is an explicit error,
   * never a silent clean start (review 05-F6/L22).
   */
  recover(): Promise<void>;

  /**
   * Adopt a prior engine run's per-node progress into this (freshly built)
   * runtime. Used by the imperative `graph_*` toolset, which rebuilds a fresh
   * engine from the declaration after every construction step and on every
   * `graph_run` — without adoption, a rebuild would reset completed nodes to
   * `ready`/`pending` and a subsequent `run()` would re-dispatch them.
   *
   * Provisions first if needed, copies each prior node's execution state onto
   * the matching node (skipping nodes with no progress or a changed agent),
   * corrects the frontier, and reconciles adopted `running` nodes against the
   * dispatch system (vanished → timeout, finished-during-window → re-emit,
   * live → re-subscribe). Never re-dispatches an already-progressed node.
   */
  adoptPrior(prior: EngineState, opts?: AdoptPriorOptions): Promise<void>;

  /**
   * Return a read-only snapshot of the current {@link EngineState}. The
   * snapshot's collections (`nodes`, `edges`, `frontier`, `signalLedger`,
   * `loopGroups`, ...) are freshly allocated deep-enough clones — mutating
   * them does not affect the live engine.
   *
   * Caveat (monitor M7): the snapshot is taken synchronously without acquiring
   * the advancing lock, so while a critical section is in flight
   * (`state.advancingLock === true`) it may reflect the middle of that
   * section's mutations rather than a quiescent state.
   */
  status(): EngineState;

  /**
   * Cancel an in-progress graph execution (Phase 3 — teardown).
   *
   * Transitions every active node (`running` / `ready` / `pending`) to
   * `cancelled`, cancels in-flight dispatch tasks via the dispatch seam, and
   * advances the engine lifecycle to `complete`. `blocked` (needs_approval)
   * nodes await the human and are left untouched.
   */
  cancel(): Promise<void>;

  /**
   * Approve a blocked `needs_approval` node: `blocked → completed`, record an
   * `answer` signal, and activate the node's downstream `answer` edges (forward
   * data flow). Resolves the node's approval gate and lets the graph continue.
   *
   * @param nodeId  The `needs_approval` node currently `blocked`.
   * @param payload Optional approval output (defaults to the node's recorded
   *                `need_approval` summary, else an accept marker).
   */
  approveNode(nodeId: string, payload?: unknown): Promise<void>;

  /**
   * Reject a blocked `needs_approval` node: `blocked → ready` (re-enter with
   * the rejection feedback merged into the re-execution prompt), or
   * `blocked → escalate` when the node has no loop group to re-open.
   *
   * @param nodeId  The `needs_approval` node currently `blocked`.
   * @param reason  Optional human-supplied rejection reason.
   */
  rejectNode(nodeId: string, reason?: string): Promise<void>;

  /**
   * Partially approve a blocked `needs_approval` node: accept the `approved`
   * upstream branches and cancel the `rejected` branches' transitive
   * dependents that cannot survive on the approved sources alone. Rejected
   * upstreams re-enter `ready` with feedback; the approval node re-waits for
   * their re-execution (or re-renders immediately when its join is already
   * satisfied by the approved sources). See orchestration-patterns.md §1.5.
   *
   * @param nodeId    The `needs_approval` node currently `blocked`.
   * @param approved  Upstream node ids the human accepted.
   * @param rejected  Upstream node ids the human rejected (re-executed).
   * @param reason    Optional rejection feedback for the re-executed branches.
   */
  partialApprove(
    nodeId: string,
    approved: string[],
    rejected: string[],
    reason?: string,
  ): Promise<void>;

  /**
   * Retry a terminal graph's node (`tool-merge-map.md` §2.2
   * `graph_run(node_id, retry=true, modify_prompt=...)`).
   *
   * Re-opens the target node (and its downstream subgraph) into a clean
   * `pending` state so re-dispatch is fresh, optionally prepending
   * `modifyPrompt` to the target's prompt, then re-marks the target `ready`
   * and dispatches it. A terminal graph phase (`complete`) is re-opened to
   * `executing`. See `node-retry.ts`.
   *
   * @param nodeId  A node in any terminal state (`completed` / `escalate` /
   *                `timeout` / `cancelled` / `done`) — or a pending/ready node —
   *                to re-run.
   * @param opts    Optional `modifyPrompt` prepended to the node's prompt.
   * @returns a {@link RetryReport} with the reset set and the number of nodes
   *          (re-)dispatched this call.
   */
  retryNode(
    nodeId: string,
    opts?: RetryNodeOptions,
  ): Promise<RetryReport>;

  /**
   * Cancel one or more named node ids (optionally cascading to their transitive
   * downstream dependents) via the scoped/cascade cancellation primitive
   * (`cancellation.ts`).
   *
   * Scoped — this is NOT the whole-graph {@link cancel}: only the requested
   * targets (and, under `cascade`, everything downstream of them) are retired,
   * and the engine phase is untouched. A loop-group target expands to its full
   * member set. Reuses only the existing lifecycle machinery: cancellable
   * nodes (`pending | ready | running`) advance `→ cancelled → done` with their
   * dispatch tasks torn down fire-and-forget; `completed` / `blocked` /
   * terminal nodes are reported as skipped and left untouched.
   *
   * @param nodeIds  Node ids to cancel (loop targets expand to their members).
   * @param options  `{ cascade?: boolean }` — cascade to transitive downstream
   *                 dependents over the declaration's edges when true.
   * @returns a {@link CancelScopeReport} of retired vs. skipped node ids.
   */
  cancelNodes(
    nodeIds: string[],
    options?: CancelScopeOptions,
  ): CancelScopeReport;

  /**
   * Relay a session-level failure observation from the platform liveness feed
   * into the engine (node-anomaly-detection subtask 4 — immediate-failure fast
   * path). The runtime-level wiring point for the feed's session observations,
   * placed beside the staleness-timeout handler {@link onStaleNodeTimeout} so
   * both failure intakes funnel the affected node through the SAME downstream
   * processing: the escalate ledger signal, escalate propagation (retry
   * re-entry / cascade cancel), completion seam, and termination re-check —
   * an abnormal node never blocks graph advancement.
   *
   * - `gone` (session.deleted) is authoritative: the `running` node escalates
   *   immediately.
   * - `error` (session.error) is re-checked against the dispatch system via
   *   `isDispatchTaskLive`: a task that is still live (running / pending /
   *   awaiting_approval) keeps the node running — transient-error protection —
   *   and only a `session` heartbeat is recorded; a task that is genuinely not
   *   live escalates like `gone`.
   *
   * A strict no-op for a non-running node, an unattached session (no
   * `dispatchSessionId`), an engine without a feed, or an unknown node id. The
   * returned promise resolves when the observation is processed and never
   * rejects (escalate advances are contained inside the advance engine).
   */
  handleFeedSessionEvent(
    nodeId: string,
    kind: "error" | "gone",
    reason?: string,
  ): Promise<void>;

  /**
   * Record a session-activity heartbeat for a running node (subtask 6 — the
   * runtime-level public wrapper beside {@link handleFeedSessionEvent}, so the
   * platform liveness feed can heartbeat a node through the PUBLIC engine
   * surface instead of reaching into the advance engine). Thin delegation to
   * the advance engine's identical intake (engine-advance.ts
   * `recordLivenessHeartbeat`), strictly guarded there: a heartbeat only lands
   * on a node that is BOTH `running` AND actually dispatched by this engine
   * (`dispatchTaskId` set — matching the launch that produced the session).
   * A strict no-op otherwise: a completed / escalated / blocked / pending node
   * is never revived into activity, and an unknown node id never throws.
   *
   * @param nodeId  The running node to heartbeat.
   * @param source  The observation channel that produced the heartbeat
   *                (`"tool"` / `"message"` / `"session"` / `"dispatch"` /
   *                `"feed"` — see {@link NodeLivenessState.heartbeatSource}).
   */
  recordLivenessHeartbeat(
    nodeId: string,
    source: NodeLivenessState["heartbeatSource"],
  ): void;

  /**
   * Reverse-lookup the node owning a live dispatch session (subtask 6 — the
   * runtime-level public wrapper beside {@link handleFeedSessionEvent}). Thin
   * delegation to the advance engine's identical `sessionId → nodeId` reverse
   * index (engine-advance.ts `getNodeIdForSession`): backs the platform
   * liveness feed's session-to-node resolution for the observations relayed
   * through this runtime. Returns `undefined` for an unknown session or a
   * session whose node has detached (terminal transition). Only meaningful
   * when a {@link NodeLivenessFeed} is wired — the index is otherwise empty.
   */
  getNodeIdForSession(sessionId: string): string | undefined;

  /**
   * Dispose the engine runtime (monitor M4). Unregisters every
   * task-terminated listener this engine registered with the dispatch seam
   * (`removeTaskTerminatedListener`) so a disposed runtime never receives (or
   * leaks) stale dispatch→signal callbacks, stops the opt-in staleness
   * watcher (monitor M3) so a disposed runtime never keeps ticking, and —
   * when persistence is configured — disposes the {@link EnginePersistence}
   * store (review 05-F1/M14): a replaced runtime's pending debounced write is
   * CANCELLED and dropped (never flushed), so stale state can never overwrite
   * the successor runtime's newer state on the shared state file. Idempotent
   * — a second dispose is a no-op.
   */
  dispose(): void;
}

/** Options for {@link EngineRuntime.adoptPrior}. */
export interface AdoptPriorOptions {
  /**
   * When true, replay adopted completed nodes' `answer` forward flow into
   * downstream targets that have not yet received their upstream result (e.g.
   * a node appended to the declaration after its upstream completed). Replay
   * may dispatch freshly-ready downstream nodes, so it should only be enabled
   * on an execution path (`graph_run`), never during pure construction.
   * Default: false.
   */
  replayAnswers?: boolean;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Options for {@link createEngine}. */
export interface CreateEngineOptions {
  /**
   * Dispatch seam — the only way `run()` actually launches graph nodes.
   *
   * Inject a fake here for tests, or pass a real one backed by a
   * {@link DispatchManager}. When omitted (and no `manager` is supplied), the
   * engine is still constructible and `status()`/`provision()` work, but
   * `run()` rejects with a clear error.
   */
  dispatch?: NodeDispatchPort;

  /**
   * A {@link DispatchManager} used to build the *default* dispatch and budget
   * seams (`DispatchBridge` / `BudgetBridge`) when `dispatch`/`budget` are not
   * supplied explicitly. This is the production path.
   */
  manager?: DispatchManager;

  /** Budget seam (defaults to a `BudgetBridge` over `manager` when available). */
  budget?: GraphBudgetPort;

  /** Parent context for node dispatches (defaults to a graph-scoped one). */
  parentContext?: DispatchParentContext;

  /**
   * Optional `on_condition` edge resolver. When omitted, the engine injects
   * the default resolver (Phase 2) supporting `signal_observed(<type>)` and
   * `artifact_exists(<name>)`; unsupported conditions evaluate false.
   */
  conditionResolver?: EdgeConditionResolver;

  /** Graph-id override (defaults to a generated unique id). */
  graphId?: string;

  /**
   * Optional workspace directory for engine-state persistence
   * (`.rolebox/state/engine-{graphId}.json`). When provided, the advance engine
   * performs a write-through save after every critical transition
   * (implementation-roadmap Q2 Option A). When omitted, the engine runs
   * in-memory with no on-disk persistence.
   */
  stateDir?: string;

  /**
   * Optional stale-lock sweep interval (ms). When provided (> 0),
   * `recover()` starts a periodic {@link EngineLockSweeper} at this interval
   * so a lock left `true` past `ADVANCING_LOCK_TIMEOUT_MS` is released.
   * Defaults to off — tests drive the sweeper via manual ticks instead of an
   * unbounded `setInterval` (see failure-resilience.md §5.6).
   */
  sweeperIntervalMs?: number;

  /**
   * Optional staleness deadline for `running` nodes (monitor M3). When provided
   * (> 0), the runtime instantiates a {@link NodeStalenessWatcher} (ticking at
   * {@link sweeperIntervalMs} when set, else the watcher's default interval)
   * and a `running` node that exceeds its staleness deadline is marked
   * `timeout`, surfaced through the completion seam + durable event log
   * (`notifyNodeTimeout`), and its failure propagated via an `escalate` ledger
   * signal (parity with the recovery orphan path — a timed-out upstream must
   * not silently stall a join). Started alongside the lock sweeper in
   * `recover()` and on `run()`, stopped by `cancel()` / `dispose()`. Defaults
   * to off — engine behavior is unchanged without it.
   */
  nodeStaleTimeoutMs?: number;

  /**
   * Optional soft-stall warn threshold (ms) for the heartbeat-based liveness
   * monitor (node-anomaly-detection subtask 6). When `nodeStaleTimeoutMs` is
   * configured (the monitor is instantiated beside the stale-node watcher), a
   * heartbeat-fed `running` node that goes idle for `nodeStallWarnMs` is
   * classified `stalling` and the {@link onNodeStall} seam fires once per stall
   * episode. Defaults to `min(60_000, nodeStaleTimeoutMs / 2)` (the monitor's
   * own default). Absent → engine behavior unchanged.
   */
  nodeStallWarnMs?: number;

  /**
   * Optional hard-stall grace (ms) past `nodeStallWarnMs` for the liveness
   * monitor (node-anomaly-detection subtask 6). A `stalling` node that stays
   * idle for `nodeStallWarnMs + nodeStallGraceMs` (capped by the per-node
   * effective staleness deadline) is marked `timeout` and funnels through the
   * SAME {@link onStaleNodeTimeout} handler as the wall-clock watcher (escalate
   * ledger signal + completion seam). Defaults to 30_000 (the monitor's own
   * default). Absent → engine behavior unchanged.
   */
  nodeStallGraceMs?: number;

  /**
   * Optional node-completion notification seam (subtask 1). Wired into the
   * advance engine's identical seam; the engine fires it exactly once per
   * terminating / notable transition — `answer → completed`, `revise_needed →
   * completed` (reviewer finished), `escalate`, `blocked → completed` on
   * approval-resume, and the recovery-side `timeout`. Defaults to a no-op, so
   * engine behavior is unchanged without it. Notification logic (a notifier)
   * never lives here — this is a role-agnostic DI seam like
   * {@link CreateEngineOptions.dispatch} (see {@link NodeCompletionEvent}).
   */
  onNodeCompletion?: (event: NodeCompletionEvent) => void;
  /**
   * Optional write-side durable graph event log (graph monitoring). When
   * present, the engine records node dispatch and node terminal transitions
   * into the recorder alongside the `onNodeCompletion` notifier, and the
   * recorder's phase-change / budget-event sinks (registered on construction)
   * capture the engine lifecycle transitions in `engine-state.ts`. Absent →
   * no event logging, engine behavior unchanged.
   */
  graphEvents?: GraphEventRecorder;
  /**
   * Optional graph-terminal notification seam. Wired into the advance engine's
   * identical seam; the engine fires it exactly once per terminal transition
   * (GRAPH COMPLETE / GRAPH BLOCKED). Defaults to a no-op, so engine behavior
   * is unchanged without it. Notification logic never lives here — this is a
   * role-agnostic DI seam like {@link CreateEngineOptions.onNodeCompletion}
   * (see {@link GraphTerminalEvent}).
   */
  onGraphTerminal?: (event: GraphTerminalEvent) => void;
  /**
   * Optional node-stall notification seam (node-anomaly-detection subtask 5).
   * Wired into the opt-in {@link NodeLivenessMonitor} instantiated alongside
   * the stale-node watcher when `nodeStaleTimeoutMs` is configured; the monitor
   * fires it once per soft-stall episode (`stalling`) for a heartbeat-fed
   * `running` node. Defaults to a no-op, so engine behavior is unchanged
   * without it. Notification logic (a notifier) never lives here — this is a
   * role-agnostic DI seam like {@link CreateEngineOptions.onNodeCompletion}
   * (see {@link NodeStallEvent}). Callback exceptions are swallowed (logged)
   * so a monitor tick never breaks.
   */
  onNodeStall?: (event: NodeStallEvent) => void;
  /**
   * Optional node-liveness feed seam (node-anomaly-detection subtask 2). Wired
   * into the advance engine's identical seam: when present, the engine records
   * an initial `dispatch` heartbeat on every successfully launched node,
   * maintains a `sessionId → nodeId` reverse index of running nodes, and
   * registers / unregisters each node's session with the feed (`attach` on
   * launch, `detach` on terminal transition). Absent → engine behavior
   * unchanged. Session-level failure observations (subtask 4) are relayed into
   * the engine through {@link EngineRuntime.handleFeedSessionEvent} — the
   * immediate-failure fast path beside the staleness timeout handler.
   */
  livenessFeed?: NodeLivenessFeed;
}

// ── Engine identity ─────────────────────────────────────────────────────────

let engineSeq = 0;
/** Generate a unique, human-scannable graph id for a runtime instance. */
function defaultGraphId(name: string): string {
  engineSeq += 1;
  return `${name}-${Date.now()}-${engineSeq}`;
}

/** Minimal, dependency-free warning logger (no sub-logger import cycle). */
function logWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

// ── Snapshot helpers ────────────────────────────────────────────────────────

/** Deep-enough clone of a node's runtime state for a snapshot. */
function cloneNode(n: NodeRuntimeState): NodeRuntimeState {
  return {
    ...n,
    signalsObserved: { ...n.signalsObserved },
    upstreamResults: new Map(n.upstreamResults),
    tokensConsumed: { ...n.tokensConsumed },
    result: n.result ? { ...n.result } : undefined,
    // C-WIRE (node-anomaly-detection subtask 1): the liveness carrier is a
    // mutable object — clone it so a snapshot consumer's in-place heartbeat /
    // stall mutation can never alias the live node's liveness state. Absent →
    // undefined (no liveness recorded yet).
    liveness: n.liveness ? { ...n.liveness } : undefined,
  };
}

/** Clone every live collection of the state into a fresh snapshot. */
function snapshotEngineState(state: EngineState): EngineState {
  return {
    phase: state.phase,
    graphId: state.graphId,
    // Y4: the graph declaration is a live, mutable object (the imperative
    // toolset mutates it on every construction step) — deep-clone it so a
    // snapshot consumer's in-place node/edge/loop/budget mutation can never
    // alias the live declaration (status()'s deep-enough-clone promise,
    // index.ts:166-174). GraphDeclaration is plain JSON data, so
    // structuredClone covers every nested field (nodes/edges/loop_groups/
    // budget/termination) for free.
    graphDeclaration: structuredClone(state.graphDeclaration),
    nodes: new Map(
      [...state.nodes].map(([id, n]) => [id, cloneNode(n)]),
    ),
    loopGroups: new Map(
      [...state.loopGroups].map(([id, g]) => [
        id,
        {
          ...g,
          termination: g.termination ? { ...g.termination } : undefined,
          // Monitor (M7): `rounds` is an append-only array — deep-enough clone
          // it (fresh entry objects, mirroring engine-persistence.ts:221-227) so
          // a snapshot consumer's in-place push/mutation can never alias the
          // live loop-group history.
          rounds: g.rounds ? g.rounds.map((r) => ({ ...r })) : undefined,
        },
      ]),
    ),
    frontier: [...state.frontier],
    budget: { ...state.budget },
    signalLedger: new Map(
      [...state.signalLedger].map(([id, e]) => [
        id,
        {
          ...e,
          signals: { ...e.signals },
          // Monitor (M7): same deep-enough clone for the per-node signal-event
          // history (mirrors engine-persistence.ts:229-235) — mutating a
          // snapshot's `history` must never affect the live ledger.
          history: e.history ? e.history.map((h) => ({ ...h })) : undefined,
        },
      ]),
    ),
    // C-WIRE: the per-node checkpoint store is an optional-additive field and
    // must be carried into the snapshot so `graph_status`'s `include_checkpoint`
    // flag reads genuine lifecycle snapshots. `CheckpointRecord`s are immutable
    // snapshots, so sharing their references (shallow clone) is safe — the same
    // reference-sharing the snapshot already uses for loop `rounds` and signal
    // `history`. Absent until a checkpoint is recorded (subtask 2).
    checkpoints: state.checkpoints ? { ...state.checkpoints } : undefined,
    // C-WIRE (subtask 7): carry the append-only per-node checkpoint history into
    // the snapshot so `include_checkpoint` surfaces the full ordered trace. Same
    // immutable-snapshot reference-sharing as `checkpoints`; arrays are shallow-
    // cloned so the outer record is fresh while the immutable records are shared.
    checkpointHistory: state.checkpointHistory
      ? Object.fromEntries(
          Object.entries(state.checkpointHistory).map(([id, records]) => [
            id,
            [...records],
          ]),
        )
      : undefined,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    advancingLock: state.advancingLock,
    isDirty: state.isDirty,
    isNonCriticalDirty: state.isNonCriticalDirty,
    pendingCompletions: [...state.pendingCompletions],
    // Monitor (M10 / bug 3 part a): the persisted-layer terminal-notification
    // dedupe flags are cross-restart graph progress — carry them into the
    // snapshot (shallow copy, mirroring engine-persistence.ts:334 and
    // engine-recovery.ts:762-764) so the adopt/rebuild path (graph-tools.ts
    // status() → adoptPrior) never discards the claim and defeats the two-layer
    // exact-once terminal guard. Absent → undefined (no fabricated claim).
    terminalNotified: state.terminalNotified
      ? { ...state.terminalNotified }
      : undefined,
  };
}

// ── Default dispatch stub ───────────────────────────────────────────────────

/**
 * Fallback dispatch seam when neither `dispatch` nor `manager` is supplied.
 *
 * `createEngine` remains constructible without a dispatch seam (so
 * `provision()`/`status()` are usable for pure inspection), but `run()` has no
 * way to launch a node — it rejects with an actionable error.
 */
const throwOnDispatch: NodeDispatchPort & { isNoDispatchSeamStub?: boolean } = {
  // Marker consumed by `isNoDispatchSeamStub` (engine-advance.ts) so
  // `_dispatchNode` can rethrow THIS stub's rejection — the "no dispatch
  // seam" misconfiguration surfaces to the `run()` caller — while containing
  // every genuine dispatch failure.
  isNoDispatchSeamStub: true,
  executeNode(): Promise<DispatchTask> {
    return Promise.reject(
      new Error(
        "createEngine: no dispatch seam provided. Inject options.dispatch " +
          "(a NodeDispatchPort or a test fake) or options.manager (a " +
          "DispatchManager) before calling run().",
      ),
    );
  },
};

// ── EngineRuntime implementation ────────────────────────────────────────────

class EngineRuntimeImpl implements EngineRuntime {
  private readonly state: EngineState;
  private readonly advance: AdvanceEngine;
  private readonly signalBridge: SignalBridge;
  private readonly dispatchPort: NodeDispatchPort;
  private readonly persistence?: EnginePersistence;
  private readonly sweeper: EngineLockSweeper;
  private readonly sweeperIntervalMs?: number;
  /**
   * Opt-in stale-node watcher (monitor M3). Absent unless
   * `nodeStaleTimeoutMs` is configured — engine behavior is unchanged without
   * it. A `running` node past its staleness deadline is marked `timeout` and
   * its failure surfaced/propagated via the {@link onStaleNodeTimeout}
   * handler. Started on `run()`/`recover()`, stopped by `cancel()`/`dispose()`.
   */
  private readonly staleWatcher?: NodeStalenessWatcher;
  private readonly onNodeCompletion?: (event: NodeCompletionEvent) => void;
  private readonly graphEvents?: GraphEventRecorder;
  private readonly onGraphTerminal?: (event: GraphTerminalEvent) => void;
  private readonly onNodeStall?: (event: NodeStallEvent) => void;
  /**
   * Opt-in heartbeat-based liveness monitor (subtask 5). Absent unless
   * `nodeStaleTimeoutMs` is configured (instantiated beside the
   * {@link staleWatcher}) — engine behavior is unchanged without it. A
   * heartbeat-fed `running` node that goes idle past the warn threshold fires
   * the {@link onNodeStall} seam once per stall episode; hard stalls funnel
   * through the same {@link onStaleNodeTimeout} handler as the wall-clock
   * watcher. Started on `run()`/`recover()`, stopped by `cancel()`/`dispose()`.
   */
  private readonly livenessMonitor?: NodeLivenessMonitor;
  private provisioned = false;

  constructor(
    graphDeclaration: GraphDeclaration,
    graphId: string,
    opts: CreateEngineOptions,
  ) {
    // 1. Fresh idle EngineState.
    this.state = createEngineState(graphDeclaration, graphId);

    // 2. Resolve the dispatch seam: explicit > manager-backed > throw-on-use.
    this.dispatchPort =
      opts.dispatch ??
      (opts.manager ? new DispatchBridge(opts.manager) : throwOnDispatch);

    // 3. Resolve the budget seam: explicit > manager-backed > absent (the
    //    advance engine treats `undefined` as a no-op port — an engine without
    //    a budget seam never enforces ceilings).
    const budget: GraphBudgetPort | undefined =
      opts.budget ?? (opts.manager ? new BudgetBridge(opts.manager.getBudgetTracker(), graphDeclaration) : undefined);

    // 4. Signal bridge — routes terminating signals into the advance engine.
    this.signalBridge = new SignalBridge();

    // 5. Wire the signal-driven advance engine over the same state.
    //    Write-through persistence seam (Phase 3): when a `stateDir` is
    //    supplied, every advancement critical section persists the engine
    //    state. Optional — omitted by default so the engine stays a
    //    constructible in-memory primitive (implementation-roadmap Q2 Option A).
    this.persistence = opts.stateDir
      ? new EnginePersistence(opts.stateDir)
      : undefined;
    this.onNodeCompletion = opts.onNodeCompletion;
    this.graphEvents = opts.graphEvents;
    this.onGraphTerminal = opts.onGraphTerminal;
    this.onNodeStall = opts.onNodeStall;
    const advanceOpts: AdvanceEngineOptions = {
      state: this.state,
      signalBridge: this.signalBridge,
      dispatch: this.dispatchPort,
      budget,
      parentContext: opts.parentContext,
      conditionResolver: opts.conditionResolver ?? defaultConditionResolver,
      persistState: this.persistence ? (s) => this.persistence!.save(s) : undefined,
      schedulePersistState: this.persistence
        ? (s) => this.persistence!.scheduleSave(s)
        : undefined,
      flushPersistState: this.persistence
        ? () => this.persistence!.flush()
        : undefined,
      onNodeCompletion: this.onNodeCompletion,
      graphEvents: this.graphEvents,
      onGraphTerminal: this.onGraphTerminal,
      livenessFeed: opts.livenessFeed,
    };
    this.advance = new AdvanceEngine(advanceOpts);
    // The advance engine is the terminating-signal consumer.
    this.advance.register();

    // 6. Stale-lock sweeper. Manual ticks by default; the periodic interval is
    //    opt-in (`sweeperIntervalMs`) so tests never leak a setInterval.
    this.sweeper = new EngineLockSweeper({
      intervalMs: opts.sweeperIntervalMs,
      onRelease: () => this.persistence?.save(this.state),
    });
    this.sweeperIntervalMs = opts.sweeperIntervalMs;

    // 7. Stale-node watcher (monitor M3). Opt-in via `nodeStaleTimeoutMs` —
    //    a `running` node that exceeds its staleness deadline is marked
    //    `timeout` and its failure surfaced through the completion seam +
    //    durable event log, then propagated via an `escalate` ledger signal
    //    (parity with the recovery orphan path). Like the lock sweeper it is
    //    manually tickable and never auto-starts a timer — `start()` is
    //    opt-in so tests never leak an interval.
    if (opts.nodeStaleTimeoutMs !== undefined && opts.nodeStaleTimeoutMs > 0) {
      // Shared dispatch-liveness probe (quiet-but-alive channel): the liveness
      // monitor consults it for stall classification; the wall-clock watcher
      // consults it to GATE its timeout (S2) — a running node whose dispatch
      // task is verifiably in-flight is quiet-but-alive, so the watcher skips
      // the wall-clock kill, and the authoritative hung-kill for a task that
      // stays verifiably live but never completes lives in the dispatch
      // watchdog (completion-evaluator.ts not_ready branch). When the probe
      // reports not-live (or the engine has no dispatch port / probe —
      // feed-less engines), the wall-clock deadline still times the node out
      // unchanged. When a probe-gated node IS timed out (probe false), its
      // result is folded into the timeout reason for diagnostics (S1).
      const dispatchAliveProbe = (node: NodeRuntimeState): boolean =>
        isDispatchTaskLive(
          this.dispatchPort as DispatchRecoveryPort,
          node.dispatchTaskId ?? "",
        );
      this.staleWatcher = new NodeStalenessWatcher({
        nodeStaleTimeoutMs: opts.nodeStaleTimeoutMs,
        intervalMs: opts.sweeperIntervalMs,
        onTimeout: this.onStaleNodeTimeout.bind(this),
        isDispatchAlive: dispatchAliveProbe,
      });
      // Subtask 5: heartbeat-based liveness monitor beside the wall-clock
      // watcher (same opt-in window, same tick cadence). Soft stalls fire the
      // role-agnostic `onNodeStall` seam once per episode; hard stalls funnel
      // through the SAME onStaleNodeTimeout handler so both monitors share the
      // timeout downstream (escalate ledger signal + completion seam).
      this.livenessMonitor = new NodeLivenessMonitor({
        nodeStaleTimeoutMs: opts.nodeStaleTimeoutMs,
        intervalMs: opts.sweeperIntervalMs,
        // Subtask 6: thread the optional stall thresholds through — absent →
        // the monitor's own defaults (warn `min(60s, stale/2)`, grace 30s).
        ...(opts.nodeStallWarnMs !== undefined
          ? { stallWarnMs: opts.nodeStallWarnMs }
          : {}),
        ...(opts.nodeStallGraceMs !== undefined
          ? { stallGraceMs: opts.nodeStallGraceMs }
          : {}),
        onStall: (nodeId, _reason, info) => this.onNodeStallFired(nodeId, info),
        onTimeout: this.onStaleNodeTimeout.bind(this),
        // Dispatch-liveness channel (quiet-but-alive): while the dispatch
        // layer verifiably considers the node's task in-flight — opencode:
        // background-task status running/pending/awaiting_approval backed by
        // the SDK session tracking; Pi: task status running backed by the
        // live child process between JSON events — a silent-but-alive node
        // (long non-streaming model call, child between events) must not be
        // classified stalled. The stall ladder then fires only when the
        // dispatch can no longer verify the task (orphaned / dead-task
        // nodes). Hung-but-alive nodes (task stuck verifiably live, never
        // completing) are NOT caught here either — the wall-clock
        // `staleWatcher` applies the SAME probe gate (S2), so the
        // authoritative hung-kill for them lives in the dispatch watchdog
        // (completion-evaluator.ts not_ready branch); only feed-less engines
        // without a dispatch port keep the pure wall-clock kill.
        isDispatchAlive: dispatchAliveProbe,
      });
    }
  }

  /**
   * Monitor (M3) stale-node handler. Called by the {@link staleWatcher} for
   * every `running` node it marked `timeout` (the watcher itself performed the
   * `markTimedOut` transition):
   *
   * 1. Surface the timeout through the completion seam + durable event log via
   *    {@link AdvanceEngine.notifyNodeTimeout} (status-guarded, so it fires
   *    exactly once, and — since the S5 fix — writes the `node_completed`
   *    event even when no notifier is registered).
   * 2. Record an `escalate` signal so the failure propagates to downstream
   *    joins (a timed-out upstream must not silently stall a fan-in), matching
   *    the recovery orphan path's escalate re-emission.
   *
   * Fire-and-forget: the watcher ticks from a timer, so the (async) escalation
   * is driven without awaiting — the advance engine's re-entrancy guard
   * serializes it against any in-flight critical section.
   */
  private onStaleNodeTimeout(nodeId: string, errorReason: string): void {
    this.advance.notifyNodeTimeout(nodeId);
    // Subtask 2: fire-and-forget — the escalate advance is contained inside
    // the advance engine, but attach a catch so a regression can never surface
    // an unhandled rejection from this timer-driven site.
    void this.advance.onNodeSignalEmitted(
      nodeId,
      "escalate",
      { error: errorReason },
      "recovery",
    ).catch((err) => {
      logWarn(
        `engine: stale-node escalate advance failed for node "${nodeId}" in graph "${this.state.graphId}": ${String(err)}`,
      );
    });
  }

  /**
   * Subtask-5 stall seam intake. Called by the {@link livenessMonitor} for
   * every `running` node that first entered the soft-stall (`stalling`)
   * classification. Packages the detection facts captured at fire time into a
   * {@link NodeStallEvent} (the agent is looked up from the live node) and
   * forwards it to the role-agnostic `onNodeStall` DI seam. The callback is
   * contained in try/catch — a throwing notifier must never break the monitor
   * tick that is driving it.
   */
  private onNodeStallFired(nodeId: string, info?: StallDetectionInfo): void {
    const node = this.state.nodes.get(nodeId);
    const event: NodeStallEvent = {
      graphId: this.state.graphId,
      nodeId,
      agent: node?.agent ?? "N/A",
      idleMs: info?.idleMs ?? 0,
      stallWarnMs: info?.stallWarnMs ?? 0,
      stallWarnedAt:
        info?.stallWarnedAt ?? node?.liveness?.stallWarnedAt ?? Date.now(),
    };
    try {
      this.onNodeStall?.(event);
    } catch (err) {
      logWarn(
        `engine: onNodeStall consumer threw for node "${nodeId}" in graph "${this.state.graphId}" — ` +
          `swallowed so a monitor tick never breaks: ${String(err)}`,
      );
    }
  }

  /**
   * Liveness fast-path wiring (node-anomaly-detection subtask 4). The
   * runtime-level intake for session-level failure observations from the
   * platform liveness feed, placed beside the staleness-timeout handler
   * ({@link onStaleNodeTimeout}) so both failure intakes share the same
   * downstream discipline. Forwards into the advance engine's
   * {@link AdvanceEngine.handleFeedSessionEvent}, which:
   *
   * - applies the transient-error re-check for `error` (a still-live dispatch
   *   task keeps the node running — heartbeat only);
   * - otherwise escalates the node through the SAME downstream as the timeout
   *   path — the escalate ledger signal, escalate propagation (retry gate
   *   re-entry / cascade cancel), completion seam, and termination re-check —
   *   so an abnormal node never blocks graph advancement.
   *
   * Fire-and-forget friendly: the returned promise never rejects (escalate
   * advances are contained inside the advance engine's critical section), but
   * the catch is defense-in-depth so a regression can never surface an
   * unhandled rejection from this relay site.
   */
  handleFeedSessionEvent(
    nodeId: string,
    kind: "error" | "gone",
    reason?: string,
  ): Promise<void> {
    return this.advance.handleFeedSessionEvent(nodeId, kind, reason).catch((err) => {
      logWarn(
        `engine: feed-session advance failed for node "${nodeId}" in graph "${this.state.graphId}": ${String(err)}`,
      );
    });
  }

  /**
   * Subtask 6: runtime-level public wrapper — thin delegation to the advance
   * engine's identical liveness intake (guarded there: running + dispatched
   * only, so a terminal node is never revived). Mirrors the defensive style of
   * {@link handleFeedSessionEvent}: a no-op for an unknown node id.
   */
  recordLivenessHeartbeat(
    nodeId: string,
    source: NodeLivenessState["heartbeatSource"],
  ): void {
    this.advance.recordLivenessHeartbeat(nodeId, source);
  }

  /**
   * Subtask 6: runtime-level public wrapper — thin delegation to the advance
   * engine's `sessionId → nodeId` reverse index (populated at launch when a
   * liveness feed is wired, dropped on the node's terminal transition).
   */
  getNodeIdForSession(sessionId: string): string | undefined {
    return this.advance.getNodeIdForSession(sessionId);
  }

  /**
   * Monitor (M6): surface every node currently in the `timeout` status through
   * the completion seam + durable event log. `notifyNodeTimeout` is
   * status-guarded (fires exactly once per timeout node) and — since the S5
   * fix — writes the `node_completed` graphEvents line even when no
   * `onNodeCompletion` notifier is registered, so this never double-notifies a
   * node and never depends on the optional notifier seam. Used by `recover()`
   * paths that cannot (or did not) complete a full reconcile pass: the
   * no-getTask path (no way to apply timeout semantics) and the
   * reconcile-failure catch path (nodes timed out before the throw).
   */
  private _notifyRecoveredTimeouts(): void {
    for (const node of this.state.nodes.values()) {
      if (node.status === NodeStatus.Timeout) {
        this.advance.notifyNodeTimeout(node.nodeId);
      }
    }
  }

  provision(): EngineState {
    if (!this.provisioned) {
      provisionState(this.state);
      this.provisioned = true;
    }
    return snapshotEngineState(this.state);
  }

  async run(): Promise<void> {
    if (!this.provisioned) {
      this.provision();
    }
    // Monitor (M3): start the opt-in staleness watcher so a live run never
    // hangs on a `running` node whose worker stopped advancing. A no-op when
    // not configured (default behavior unchanged).
    this.staleWatcher?.start(this.state);
    // Subtask 5: start the opt-in liveness monitor beside the watcher so a
    // heartbeat-fed `running` node that stops advancing surfaces a stall
    // notification. A no-op when not configured (default behavior unchanged).
    this.livenessMonitor?.start(this.state);
    // F2: start the opt-in stale-lock sweeper on the PRIMARY execution path
    // too (parity with recover()) so a stuck `advancingLock` never deadlocks
    // a live run. A no-op when `sweeperIntervalMs` is absent — the sweeper
    // then stays manual-tick-only and no interval is ever created.
    if (this.sweeperIntervalMs && this.sweeperIntervalMs > 0) {
      this.sweeper.start(this.state);
    }
    // dispatchReady transitions `idle → executing` and dispatches the ready
    // roots inside a single advancement critical section.
    await this.advance.dispatchReady();
  }

  /**
   * Resume an interrupted graph instance (engine-state-machine.md §5.1 /
   * failure-resilience.md §5.1-§5.6):
   *
   * 1. Load the persisted state — a missing/corrupt/version-mismatched file
   *    returns `null` and recovery is a clean no-op (first run). A non-ENOENT
   *    read failure (unreadable-but-present file) propagates out of `recover()`
   *    — recovery fails explicitly instead of silently re-provisioning a graph
   *    whose completed nodes would be re-executed (review 05-F6/L22).
   * 2. Adopt the loaded state in place (the advance engine keeps referencing
   *    this object), clear the stale critical-section state the crashed
   *    process left behind (a stuck `advancingLock`, orphaned deferred
   *    completions).
   * 3. Reconcile every `running` node against the dispatch system
   *    (`getTask`): vanished → `timeout`, terminal → re-emit its signal,
   *    live → re-subscribe `onTaskTerminated`.
   * 4. Drain the deferred completions (nodes that finished during the window)
   *    by recording their terminating signal — this runs the advancement
   *    critical section and re-dispatchs ready downstream nodes.
   * 5. Rebuild the frontier and dispatch any remaining ready nodes.
   *
   * Idempotency: no node is re-dispatched — reconciliation only re-attaches to
   * already-dispatched tasks (§5.2). A crashed process can only ever be
   * resumed into `running` nodes whose tasks already exist in the dispatch
   * system, or be timed-out when the task vanished.
   */
  async recover(): Promise<void> {
    if (!this.persistence) return; // no persistence → nothing to recover
    // `load()` returns `null` for a missing / corrupt / version-mismatched
    // file (clean start — first run) and rethrows any NON-ENOENT read failure
    // (an unreadable-but-present state file is an explicit error, never a
    // silent clean start — engine-persistence.ts:571-576). Let that error
    // propagate: recovery fails explicitly so the caller surfaces it instead
    // of silently re-provisioning a graph whose completed nodes would be
    // re-executed (review 05-F6/L22). ENOENT / corrupt / version-mismatch
    // remain clean no-ops.
    const loaded = this.persistence.load(this.state.graphId);
    if (!loaded) return; // clean start (first run / version mismatch)

    // Adopt the persisted state in place; clear the crashed process's stale
    // critical-section state (no section is actually running here).
    hydrateEngineState(this.state, loaded);
    this.provisioned = true;
    clearStaleCriticalSection(this.state);

    // Restart the stale-lock sweeper (§5.1 step 6 / §5.6) and the opt-in
    // stale-node watcher (monitor M3, resumed executions must not hang on a
    // dead worker either). An interval is only started when the consumer opted
    // in — manual ticking otherwise.
    if (this.sweeperIntervalMs && this.sweeperIntervalMs > 0) {
      this.sweeper.start(this.state);
    }
    this.staleWatcher?.start(this.state);
    // Subtask 5: start the opt-in liveness monitor beside the watcher —
    // resumed executions must surface heartbeat stalls too.
    this.livenessMonitor?.start(this.state);

    // Reconcile running nodes against the dispatch system (requires getTask).
    const port = this.dispatchPort as DispatchRecoveryPort;
    if (!port.getTask) {
      // No way to reconcile — adopt the state and re-dispatch any ready nodes
      // whose tasks were never launched (blocked / approval-resume cases).
      // Monitor (M6): WITHOUT getTask this path cannot apply timeout semantics
      // (it has no way to read a vanished running task's status), so it only
      // surfaces nodes whose `timeout` status was ALREADY recorded (e.g. in
      // the persisted state) through the completion seam + durable event log.
      this._notifyRecoveredTimeouts();
      rebuildFrontier(this.state);
      await this.advance.dispatchReady();
      return;
    }

    // Live re-subscriptions route future terminations through signalBridge.record
    // (identical to the _dispatchNode seam). Deferred completions (nodes that
    // finished during the window) are collected here and drained below.
    let report: ReconcileReport;
    try {
      report = reconcileEngine(
        this.state,
        port,
        (nodeId, type, payload) => {
          // F1 bridge (mirrors the deferred-drain call at :777): the reconcile
          // emitSignal feeds through the public advance entry so a HITL status
          // delivered to a re-subscribed listener (awaiting_approval /
          // need_approval / blocked / need_clarification → the pausing
          // `need_approval` signal) reaches the running → blocked transition
          // instead of being recorded-and-dropped by signalBridge.record (which
          // only fires terminating-signal listeners).
          // Subtask 2: fire-and-forget — the advance is contained, but attach
          // a catch so a regression can never surface an unhandled rejection
          // from this recovery reconcile site.
          void this.advance.onNodeSignalEmitted(nodeId, type, payload, "recovery").catch(
            (err) => {
              logWarn(
                `engine-recover: reconcile emitSignal advance failed for node "${nodeId}" in graph "${this.state.graphId}": ${String(err)}`,
              );
            },
          );
        },
      );
    } catch (err) {
      // A single bad node must not abort recovery — adopt the rest.
      logWarn(
        `engine-recover: reconcile failed for graph "${this.state.graphId}": ${String(err)}`,
      );
      // Monitor (M6): reconcileEngine may have timed out some nodes before it
      // threw — surface every node now in the `timeout` status through the
      // completion seam + durable event log (one notification per node).
      this._notifyRecoveredTimeouts();
      rebuildFrontier(this.state);
      await this.advance.dispatchReady();
      return;
    }

    // Subtask 1: surface recovery-side timeouts through the completion seam
    // exactly once. `reconcileEngine` timed these nodes out directly (their
    // dispatch tasks vanished) — a transition that happens outside the
    // signal-driven advance engine, so it is emitted here via the public seam.
    for (const id of report.timedOut) {
      this.advance.notifyNodeTimeout(id);
    }

    // Subtask 2 (Y2): tear down crash-window orphan sessions fire-and-forget —
    // a node persisted `running` with no `dispatchTaskId` had its session
    // launched anyway (the crash hit between the running-write and
    // `executeNode` resolving the task handle); reconcile matched it back by
    // parent + description and recovery must cancel it so it stops burning
    // budget with its result lost. Never awaited — mirrors the
    // cancellation.ts fire-and-forget precedent; a rejected cancel is logged
    // and swallowed.
    for (const oc of report.orphanCancellations ?? []) {
      void port.cancelTask?.(oc.taskId).catch((err) => {
        logWarn(
          `engine-recover: cancelTask failed for orphaned task ${oc.taskId} ` +
            `(node "${oc.nodeId}") in graph "${this.state.graphId}": ${String(err)}`,
        );
      });
    }

    // Drain deferred completions: re-emit each finished-during-restart node's
    // terminating signal through the public advance entry, running the
    // critical section (the re-entrancy guard makes the follow-up advance of
    // already-completed nodes a no-op).
    for (const d of report.deferred) {
      await this.advance.onNodeSignalEmitted(d.nodeId, d.type, d.payload, "recovery");
    }

    // Rebuild the frontier and dispatch any ready nodes that recovery left
    // waiting (e.g. downstream of a re-emitted completion, or approval-resume).
    rebuildFrontier(this.state);
    await this.advance.dispatchReady();
    this.persistence?.save(this.state);
    // flush-on-terminate: the runtime was rebuilt from persisted state — drain
    // any pending debounced non-critical write so no churn is lost on replace.
    this.persistence?.flush();
  }

  async adoptPrior(prior: EngineState, opts?: AdoptPriorOptions): Promise<void> {
    if (!this.provisioned) {
      this.provision();
    }
    // Copy the prior run's per-node progress + graph-level counters in place.
    adoptPriorNodeStates(this.state, prior);

    // Reconcile adopted `running` nodes against the dispatch system so a node
    // whose worker finished (or vanished) while the toolset was rebuilding the
    // engine still advances — identical semantics to `recover()`.
    const port = this.dispatchPort as DispatchRecoveryPort;
    if (port.getTask) {
      try {
        const report = reconcileEngine(
          this.state,
          port,
          (nodeId, type, payload) => {
            // F1 bridge (mirrors the recover() reconcile callback at :761 and
            // the deferred-drain call at :828): the adopt-window reconcile
            // emitSignal feeds through the public advance entry so a HITL
            // status delivered to a re-subscribed listener (awaiting_approval /
            // need_approval / blocked / need_clarification → the pausing
            // `need_approval` signal) reaches the running → blocked transition
            // instead of being recorded-and-dropped by signalBridge.record
            // (which only fires terminating-signal listeners).
            // Subtask 2: fire-and-forget — attach a catch so a regression can
            // never surface an unhandled rejection from this adopt reconcile
            // site.
            void this.advance.onNodeSignalEmitted(nodeId, type, payload, "recovery").catch(
              (err) => {
                logWarn(
                  `engine-adopt: reconcile emitSignal advance failed for node "${nodeId}" in graph "${this.state.graphId}": ${String(err)}`,
                );
              },
            );
          },
        );
        for (const id of report.timedOut) {
          this.advance.notifyNodeTimeout(id);
        }
        // Subtask 2 (Y2): tear down crash-window orphan sessions fire-and-forget
        // (parity with recover() — an adopted `running` node with no
        // `dispatchTaskId` had its session launched anyway; cancel it so it
        // stops burning budget). Never awaited; a rejected cancel is logged.
        for (const oc of report.orphanCancellations ?? []) {
          void port.cancelTask?.(oc.taskId).catch((err) => {
            logWarn(
              `engine-adopt: cancelTask failed for orphaned task ${oc.taskId} ` +
                `(node "${oc.nodeId}") in graph "${this.state.graphId}": ${String(err)}`,
            );
          });
        }
        for (const d of report.deferred) {
          await this.advance.onNodeSignalEmitted(d.nodeId, d.type, d.payload, "recovery");
        }
      } catch (err) {
        logWarn(
          `engine-adopt: reconcile failed for graph "${this.state.graphId}": ${String(err)}`,
        );
      }
    }

    if (!opts?.replayAnswers) {
      this.persistence?.save(this.state);
      // flush-on-terminate: runtime replaced by adoption — drain any pending
      // debounced non-critical write so the on-disk state is complete.
      this.persistence?.flush();
      return;
    }

    // Replay `answer` forward flow for adopted completed nodes whose downstream
    // targets have not yet received their result — this covers nodes ADDED to
    // the declaration after the upstream completed (e.g. a validate node
    // appended mid-flight). Re-emitting is safe: `_applySignalTransition` is
    // idempotent for a non-running node, so only the forward data flow and
    // downstream activation run.
    for (const node of this.state.nodes.values()) {
      if (node.status !== NodeStatus.Completed) continue;
      const answer = node.signalsObserved["answer"];
      if (answer === undefined) continue;
      const needsReplay = this.state.graphDeclaration.edges.some((e) => {
        if (e.from !== node.nodeId) return false;
        const target = this.state.nodes.get(e.to);
        return (
          target !== undefined &&
          target.status === NodeStatus.Pending &&
          !target.upstreamResults.has(node.nodeId)
        );
      });
      if (needsReplay) {
        await this.advance.onNodeSignalEmitted(node.nodeId, "answer", answer);
      }
    }

    this.persistence?.save(this.state);
    // flush-on-terminate: runtime replaced by adoption — drain any pending
    // debounced non-critical write so the on-disk state is complete.
    this.persistence?.flush();
  }

  status(): EngineState {
    return snapshotEngineState(this.state);
  }

  /**
   * Cancel an in-progress graph execution: stop the stale-lock sweeper,
   * cancel every in-flight dispatch task via the seam, transition every active
   * node (`running` / `ready` / `pending`) to `cancelled`, and advance the
   * engine lifecycle to `complete`. `blocked` (needs_approval) nodes are left
   * for the human; terminal nodes are untouched. Best-effort cancellation is
   * never awaited to completion — the graph teardown proceeds regardless.
   */
  async cancel(): Promise<void> {
    this.sweeper.stop();
    // Monitor (M3): a cancelled graph must not keep ticking the opt-in
    // staleness watcher.
    this.staleWatcher?.stop();
    // Subtask 5: stop the opt-in liveness monitor too (parity with the
    // staleness watcher above and dispose()) — a cancelled graph must not
    // keep ticking its stall detection.
    this.livenessMonitor?.stop();

    // Cancel in-flight dispatch tasks (best-effort), then cancel the nodes.
    const reason = "cancelled by engine.cancel()";
    for (const node of this.state.nodes.values()) {
      if (node.status === NodeStatus.Running && node.dispatchTaskId) {
        try {
          await this.dispatchPort.cancelTask?.(node.dispatchTaskId);
        } catch {
          // best-effort — teardown continues without a cancellation ack
        }
      }
      if (
        (node.status === NodeStatus.Running ||
          node.status === NodeStatus.Ready ||
          node.status === NodeStatus.Pending) &&
        canTransitionNode(node.status, NodeStatus.Cancelled)
      ) {
        markCancelled(this.state, node, reason);
        markDone(this.state, node);
        // Monitor (H4): cancellation is a lifecycle transition performed
        // OUTSIDE the signal-driven advancement — surface each cancelled node
        // through the same completion seam + durable event log as
        // signal-driven transitions (`notifyNodeTerminal`), so a cancel emits
        // the per-node `node_completed` line + notifier event.
        this.advance.notifyNodeTerminal(
          node.nodeId,
          "cancelled",
          reason,
          NodeStatus.Done,
        );
      }
    }
    this.state.frontier = [];

    // Advance idle → executing so the termination check can evaluate the now
    // quiescent graph (checkGraphTermination no-ops outside `executing`).
    if (
      this.state.phase === EnginePhase.Idle &&
      canTransitionPhase(this.state, EnginePhase.Executing)
    ) {
      transitionPhase(this.state, EnginePhase.Executing);
    }
    // Monitor (H4): every cancellable node is now retired to `done`, so the
    // normal termination check drives executing → complete and fires
    // `onGraphTerminal` ([GRAPH COMPLETE]) through the standard seam instead
    // of a silent manual transition.
    this.advance.checkTermination();
    // Fallback: when the termination check did not migrate the phase (e.g. a
    // persisted terminal-notification guard already claimed the event, or a
    // blocked node kept the graph from quiescing), keep the manual transition
    // so the cancelled graph still ends terminal.
    if (
      this.state.phase === EnginePhase.Executing &&
      canTransitionPhase(this.state, EnginePhase.Complete)
    ) {
      transitionPhase(this.state, EnginePhase.Complete);
    }

    this.persistence?.save(this.state);
    // flush-on-terminate: the graph reached `complete` (cancel teardown) — drain
    // any pending debounced non-critical write so the on-disk state is complete.
    this.persistence?.flush();
  }

  async approveNode(nodeId: string, payload?: unknown): Promise<void> {
    await this.advance.approveNode(nodeId, payload);
  }

  async rejectNode(nodeId: string, reason?: string): Promise<void> {
    await this.advance.rejectNode(nodeId, reason);
  }

  async partialApprove(
    nodeId: string,
    approved: string[],
    rejected: string[],
    reason?: string,
  ): Promise<void> {
    await this.advance.partialApprove(nodeId, approved, rejected, reason);
  }

  async retryNode(
    nodeId: string,
    opts?: RetryNodeOptions,
  ): Promise<RetryReport> {
    return this.advance.retryNode(nodeId, opts);
  }

  cancelNodes(
    nodeIds: string[],
    options?: CancelScopeOptions,
  ): CancelScopeReport {
    return cancelScopedNodes(
      this.state,
      nodeIds,
      options,
      this.dispatchPort,
      (nodeId, reason) => {
        // Monitor (H4): a scoped cancellation retires nodes outside the
        // signal-driven advancement — route each through the same completion
        // seam + durable event log as signal-driven transitions so the monitor
        // observes the per-node `node_completed` line + notifier event.
        this.advance.notifyNodeTerminal(
          nodeId,
          "cancelled",
          reason,
          NodeStatus.Done,
        );
      },
    );
  }

  dispose(): void {
    // Monitor (M4): unregister every task-terminated listener this engine
    // registered during dispatch (`getTerminationSubscriptions` returns the
    // exact `{ taskId, callback }` pairs handed to the port) so a disposed
    // runtime never receives — or leaks — stale dispatch→signal callbacks.
    // `removeTaskTerminatedListener` is optional on the port seam: a port
    // without it degrades to best-effort teardown.
    for (const sub of this.advance.getTerminationSubscriptions()) {
      this.dispatchPort.removeTaskTerminatedListener?.(sub.taskId, sub.callback);
    }
    // Clear the engine's own subscription ledger through the public teardown
    // entry (review 06-F1 / M16) — never `as unknown as` into the private
    // field. A disposed runtime keeps no handles to stale callbacks and a
    // re-run re-registers fresh ones (a second dispose is then a no-op).
    this.advance.clearTerminationSubscriptions();
    // Review 05-F1/F3 (M14/ML1): a replaced / discarded runtime must cancel
    // its pending debounced persistence write — flushing it would overwrite
    // the successor runtime's newer state on the shared state file. dispose
    // drops the pending write (it does NOT flush).
    this.persistence?.dispose();
    // Monitor (M3): stop the opt-in staleness watcher — a disposed runtime
    // must not keep ticking.
    this.staleWatcher?.stop();
    // Subtask 5: stop the opt-in liveness monitor — a disposed runtime must
    // not keep ticking its stall detection either.
    this.livenessMonitor?.stop();
    // F2: stop the opt-in stale-lock sweeper too (parity with cancel()) — a
    // disposed runtime must not keep sweeping its periodic interval. No-op
    // when the interval was never started.
    this.sweeper.stop();
  }
}

// ── Public factory ──────────────────────────────────────────────────────────

/**
 * Construct an {@link EngineRuntime} bound to the given graph declaration.
 *
 * @param graphDeclaration The parsed v2 graph (nodes + edges + optional budget/loops).
 * @param options          Seams — most importantly an injectable dispatch port.
 */
export function createEngine(
  graphDeclaration: GraphDeclaration,
  options: CreateEngineOptions = {},
): EngineRuntime {
  const graphId =
    options.graphId ?? defaultGraphId(graphDeclaration.name);
  return new EngineRuntimeImpl(graphDeclaration, graphId, options);
}

// ── Re-exports (public engine API surface) ──────────────────────────────────

/** The top-level engine state container — re-exported for consumer typing. */
export type { EngineState } from "../../types.engine-v2.ts";

/**
 * Bounded-cycle orchestration primitives (Phase 2). {@link executeLoopStep} is
 * the coalesced convergence decision for a loop-group member's terminating
 * signal — it applies the failure-resilience.md §4.3 soft early-exits and
 * coordinates the Phase 2 primitives (traversal counting, revise re-dispatch,
 * escalation cascade, upstream cancellation). The fingerprint / tracker
 * helpers are exported for direct, testable use.
 */
export {
  executeLoopStep,
  recordConvergenceOutput,
  resetConvergenceTracker,
  fingerprintPayload,
  extractUnresolved,
} from "./loop-group-executor.ts";
export type {
  LoopOutcome,
  LoopStepReport,
  LoopEscalatePayload,
} from "./loop-group-executor.ts";
export type { CancelDispatchPort } from "./cascade-canceller.ts";
export {
  cancelNodes,
  type CancelScopeOptions,
  type CancelScopeReport,
  type CancelNodeNotifier,
} from "./cancellation.ts";
export {
  buildApprovalPayload,
  type ApprovalPayload,
  type ApprovalUpstreamResult,
} from "./approval-payload.ts";
export {
  approveBlockedNode,
  rejectBlockedNode,
  pruneDownstreamSubgraph,
  reenterRejectedUpstreams,
  resetRejectedUpstreams,
  mergeRejectionFeedback,
  type RejectReport,
  type PruneReport,
} from "./approval-handler.ts";
export {
  resetNodeForRetry,
  retryNode,
  type RetryNodeOptions,
  type RetryResetReport,
  type RetryReport,
} from "./node-retry.ts";
export type { NodeDispatchPort } from "./engine-advance.ts";
export type { NodeLivenessFeed } from "./engine-advance.ts";
export type {
  NodeCompletionEvent,
} from "./engine-advance.ts";
export type {
  GraphTerminalEvent,
} from "./engine-advance.ts";
export type {
  NodeStallEvent,
} from "./engine-recovery.ts";
export {
  GraphEventRecorder,
  graphEventsHash,
  graphEventsPath,
  readGraphEventLog,
  type GraphEventRecord,
  type GraphEventType,
} from "./graph-events.ts";
export {
  type PhaseEventSink,
  type BudgetEventSink,
} from "../../types.engine-v2.ts";

// ── Re-exports for tool-layer consumers (barrel-only access) ─────────────────

export { loadEngineStateFromJson } from "./engine-persistence.ts";

export { graphParentContext } from "./dispatch-bridge.ts";
export type { DispatchParentContext } from "./dispatch-bridge.ts";

export {
  createGraphNotifier,
  createGraphStallNotifier,
  createGraphTerminalNotifier,
} from "./graph-notify.ts";
export type {
  GraphCompletionHandler,
  GraphStallHandler,
  GraphTerminalHandler,
} from "./graph-notify.ts";

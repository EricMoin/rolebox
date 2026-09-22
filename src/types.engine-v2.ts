/**
 * Graph Execution Engine State Machine v2 Type Definitions
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Defines the runtime types for the graph execution engine: engine lifecycle
 * phases, per-node runtime state, edge payloads, fan-in context, and
 * related structures.
 *
 * Central thesis: the engine is a role-agnostic primitive. A node is an
 * {agent, prompt} tuple. The engine routes signals, enforces joins, manages
 * cycles, propagates failures, and tracks budgets — without knowing or
 * caring about "roles."
 *
 * Design reference: .rolebox/design/engine-state-machine.md
 */

import type { GraphDeclaration, LoopGroupDecl, NodeBudgetSpec } from "./types.graph-v2.ts";
import type { EnginePhase, NodeStatus } from "./constants.ts";
import type { MaterializedResultRef } from "./dispatch/types.ts";
import type { UsageRecord } from "./dispatch/budget/budget-tracker.ts";
import type {
  ContractContentSnapshot,
  ContractIdentityIndex,
  ContractRef,
} from "./graph/contracts/contract-definition.ts";
import type { PersistedCompiledPlan } from "./graph/compiler/plan.ts";

// ── Engine State ────────────────────────────────────────────────────────

/**
 * A consumer notified on an engine lifecycle phase transition
 * (`transitionPhase`). Wired into EngineState so the pure transition
 * function can reach a durable event log without a module-level import cycle.
 * Non-serializable (function) — excluded from persistence DTOs.
 */
export type PhaseEventSink = (
  graphId: string,
  from: EnginePhase,
  to: EnginePhase,
) => void;

/** A consumer notified on a graph-level budget update (`applyBudgetDelta`).
 *  Non-serializable — same persistence exclusion as PhaseEventSink. */
export type BudgetEventSink = (
  graphId: string,
  budget: GraphBudgetState,
) => void;

/**
 * Runtime state of the graph execution engine.
 *
 * This is the top-level state container persisted across sessions.
 * It subsumes graph session state, loop coordinator state, and dispatch task
 * tracking into a single unified structure.
 */
export interface EngineState {
  /** Current phase of the engine lifecycle */
  phase: EnginePhase;
  /** Unique identifier for this graph instance */
  graphId: string;
  /** The parsed graph declaration this engine is executing */
  graphDeclaration: GraphDeclaration;
  /** Per-node runtime state, keyed by node ID */
  nodes: Map<string, NodeRuntimeState>;
  /** Per-loop-group runtime state */
  loopGroups: Map<string, LoopGroupRuntimeState>;
  /** Nodes ready for dispatch this tick (frontier set) */
  frontier: string[];
  /** Cumulative graph-level budget consumption */
  budget: GraphBudgetState;
  /** Per-node signal history */
  signalLedger: Map<string, SignalLedgerEntry>;
  /** Epoch ms timestamp when the graph started */
  startedAt: number;
  /** Epoch ms timestamp of the last state update */
  updatedAt: number;
  /** Re-entrancy guard — only one advancement critical section at a time */
  advancingLock: boolean;
  /**
   * Runtime-only (non-persisted) dirty flag. Set to `true` by any **critical**
   * mutation — node lifecycle status changes, phase changes, frontier updates,
   * checkpoint records, approval state — so that {@link _runCriticalSection}
   * issues a synchronous write-through persist when the section mutated the
   * durable graph state. Cleared immediately after a successful persist.
   * Defaults to `false` for fresh and deserialized states (never resurrected
   * from persistence). See the two-tier policy in engine-persistence.ts (Q2
   * Option A).
   */
  isDirty: boolean;
  /**
   * Runtime-only (non-persisted) dirty flag for **non-critical** churn —
   * signal-ledger history updates and budget / per-node tokensConsumed
   * counters. When a critical section produced ONLY non-critical mutations, the
   * section schedules a debounced (non-blocking) write instead of a synchronous
   * one. Defaults to `false` for fresh and deserialized states. Never
   * resurrected from persistence (same rule as {@link isDirty}).
   */
  isNonCriticalDirty: boolean;
  /** Completions deferred during a critical section (drained on unlock) */
  pendingCompletions: string[];

  /**
   * DERIVED VIEW of {@link checkpointHistory}: the latest lifecycle-transition
   * snapshot per node, keyed by node ID. Backs the `graph_status`
   * `include_checkpoint` flag.
   *
   * CONTRACT (Y9): `checkpointHistory` is the AUTHORITATIVE record; this field
   * is a convenience projection and `checkpoints[nodeId]` must equal the last
   * element of `checkpointHistory[nodeId]` whenever the history entry exists.
   * It is retained for backward compatibility with readers and persisted files
   * written before the history existed — not as an independent source of
   * truth.
   *
   * Writer contract (recorder.ts): append the transition to
   * `checkpointHistory[nodeId]`, then set `checkpoints[nodeId]` to that same
   * snapshot, so the two can never disagree.
   *
   * Reader contract (graph_status / graph-tools.ts): read
   * `checkpointHistory` first; fall back to this field ONLY when the history
   * for that node is absent (files authored before the history field, or a
   * graph whose checkpoints predate it). A fallback result is a documented
   * degradation — the reader cannot distinguish "history truncated" from
   * "history never recorded" — and must not be used when history exists.
   *
   * OPTIONAL-ADDITIVE — absent until a checkpoint is recorded (subtask 2).
   * Absence and an empty record are treated identically; it never carries
   * fabricated values.
   */
  checkpoints?: Record<string, CheckpointRecord>;

  /**
   * AUTHORITATIVE append-only per-node checkpoint history: an ordered list of
   * lifecycle-transition snapshots keyed by node ID, in the order transitions
   * occurred (earliest first). Backs the `graph_status` `include_checkpoint`
   * flag with full traceability — every recorded transition is preserved,
   * unlike the derived {@link checkpoints} view (which retains only the
   * latest).
   *
   * CONTRACT (Y9): this is the source of truth for `graph_status` checkpoint
   * reporting. Writers append here and then refresh {@link checkpoints};
   * readers prefer this field and use {@link checkpoints} only as the
   * documented pre-history fallback.
   *
   * OPTIONAL-ADDITIVE — absent until a checkpoint is recorded (subtask 7).
   * Absence and an empty record are treated identically; it never carries
   * fabricated values.
   */
  checkpointHistory?: Record<string, CheckpointRecord[]>;

  /**
   * Optional phase-transition event sink. Wired by the engine runtime at
   * construction when a {@link GraphEventRecorder} is provided. Non-serializable
   * (function) — excluded from persistence DTOs; always `undefined` after
   * deserialization.
   */
  phaseEventSink?: PhaseEventSink;

  /**
   * Optional budget-update event sink. Same wiring and persistence exclusion as
   * {@link phaseEventSink}.
   */
  budgetEventSink?: BudgetEventSink;

  /**
   * Cross-restart termination-notification dedup flag.
   *
   * OPTIONAL-ADDITIVE — absent in persisted files written before this field
   * existed, and absent for graphs that never reached a terminal phase; both
   * cases deserialize cleanly (the field is simply `undefined`).
   *
   * When present, records whether the engine has already delivered the
   * `[GRAPH COMPLETE]` (`complete`) and/or `[GRAPH BLOCKED]` (`blocked`)
   * terminal notification for this graph. A fresh engine instance created
   * after a restart consults this flag before emitting a terminal reminder so
   * a graph whose terminal notification was already delivered is not notified
   * again across engine instances (monitor-audit F15 / M10 exact-once).
   */
  terminalNotified?: { complete: boolean; blocked: boolean };

  /**
   * The execution protocol this graph's semantics belong to — an identity on
   * its own axis, independent of the storage format and the authoring
   * declaration version.
   *
   * OPTIONAL-ADDITIVE — absent in files written before this field existed, and
   * for states that never bound one. Absence is deliberately NOT
   * self-describing: the format-2 decoder is the one component allowed to
   * infer `LEGACY_SIGNAL_PROTOCOL` for it, because format 2 IS the
   * legacy layout. A future storage format that lacks the field is corrupt,
   * never guessed as legacy. When present, the loader classifies the value
   * against the execution-protocol registry and refuses an unregistered one
   * instead of running it under legacy rules.
   */
  executionProtocolVersion?: number;

  /**
   * The durable compiled-plan record this graph runs under (B7): the plan's
   * identity, its compiled topology, its pinned contract snapshots and its
   * node→contract index, exactly as `CompiledPlan` compiles them.
   *
   * OPTIONAL-ADDITIVE — absent means "no compiled plan was ever persisted" and
   * is LEGAL: such a state serializes with no key at all and loads exactly as
   * it did before this field existed. When present, the format-2 decoder
   * verifies it before the load may answer `valid`: the record's
   * `planRevision` is recomputed from its own body, its topology is checked
   * against the compiler's plan-level rules, and its snapshots/bindings are
   * held to the same rules as the persisted binding. Any violation is
   * `corrupt(contract)`; a record is never repaired or fabricated.
   *
   * RECOVERY DOES NOT READ THIS FIELD AS AUTHORITY YET. The engine still resumes
   * from the retained `graphDeclaration`; nothing consumes the plan, and
   * switching recovery onto it is a later slice. B8 makes recovery CARRY the
   * record (deep-cloned, never aliased) across `hydrateEngineState` and
   * `adoptPriorNodeStates`, and `snapshotEngineState` carries it through
   * `status()`, so a plan a state was loaded with cannot be silently dropped by
   * the next rebuild. Adoption refuses explicitly when the declaration changed
   * instead of carrying a record that no longer matches it.
   */
  compiledPlan?: PersistedCompiledPlan;

  /**
   * The persisted binding of the compiled plan this graph runs under: the
   * plan's revision, the immutable contract snapshots it binds, and each node's
   * contract reference.
   *
   * OPTIONAL-ADDITIVE — absent means "legacy graph with no compiled plan" and
   * is LEGAL: such a state serializes with no key at all and loads exactly as
   * it did before this field existed. When present, the format-2 decoder
   * verifies it before the load may answer `valid` and refuses a tampered or
   * stale binding as `corrupt(contract)`; a binding is never repaired,
   * re-resolved or fabricated.
   *
   * `planRevision` is the COMPILED PLAN's content address — the same identity
   * `compiledPlan.planRevision` carries — and therefore a foreign key into
   * that record, NOT a digest recomputed from this record's own body (see
   * {@link PlanBinding}). A binding that stands alone has no plan body to
   * resolve the key against; when both records are present the load requires
   * the two revisions to be equal.
   */
  planBinding?: PlanBinding;
}

/**
 * The persisted contract binding of one compiled plan (B6; RE-MEANT in B7).
 *
 * `planRevision` is the COMPILED PLAN's content address — the same
 * `CompiledPlan.planRevision` the `compiledPlan` record carries. B6 computed
 * it over this record's own binding body `{ contractSnapshots, nodeBindings }`
 * because the topology was not persisted, so the field name claimed one
 * identity (the plan's revision) while holding another (a digest of the
 * binding). B7 removes that second meaning: the binding-body digest rule is
 * DELETED, not renamed, and the load compares this revision with the plan
 * record's when both are present. A binding that stands alone keeps the field
 * as an unverifiable foreign key rather than a self-address, because there is
 * no plan body to recompute it from.
 *
 * `contractSnapshots` is CONTENT keyed by CONTRACT DIGEST: each entry's body
 * must hash to its own key, so a snapshot's content identity is proven rather
 * than declared. The entry carries NO `ref` (B8): one body can belong to
 * several `(id, revision)` identities, and a single ref would have to name one
 * of them and silently drop the others.
 *
 * `contractIdentities` is the IDENTITY index: `id` → `revision` → content
 * digest. One exact identity maps to exactly one digest, every digest it names
 * must have a snapshot whose body hashes back to it, and two identities may
 * share one digest. `nodeBindings` maps each bound node id to the exact
 * `ContractRef` the plan resolved for it; the bound ref resolves THROUGH the
 * identity index — never by matching a snapshot's single ref, which no longer
 * exists.
 */
export interface PlanBinding {
  /** The compiled plan's content address, shared with `compiledPlan`. */
  readonly planRevision: string;
  /** The immutable contract CONTENT this plan binds, keyed by digest. */
  readonly contractSnapshots: Readonly<Record<string, ContractContentSnapshot>>;
  /** The contract identity index this plan binds: id → revision → digest. */
  readonly contractIdentities: ContractIdentityIndex;
  /** Each bound node's exact contract reference, keyed by node id. */
  readonly nodeBindings: Readonly<Record<string, ContractRef>>;
}

// ── Join Strategy (runtime) ─────────────────────────────────────────────

/**
 * Runtime join strategy for a convergence node — the resolved projection of
 * the declaration's `JoinConfig` (C1).
 *
 * `"all"` / `"any"` stay strings; `quorum:N` becomes `{ quorum: N }` so the
 * required count travels with the strategy. The declared union forces
 * `quorum` to exist on the quorum branch, so a bare `"quorum"` string is not
 * representable at either boundary. `readQuorum` in
 * `src/graph/engine/join-evaluator.ts` is the single reader of the count; the
 * approval cancellation gate (`approval-handler.ts` `shouldCancel`) and
 * `evaluateJoin` both go through it.
 */
export type ResolvedJoinStrategy = "all" | "any" | { quorum: number };

// ── Node Runtime State ──────────────────────────────────────────────────

/**
 * Per-node runtime state tracked by the engine.
 *
 * Every node follows the same generic lifecycle state machine — no per-type
 * state machines. The `type` field from v1.0 (designer/executor/validator/
 * human_gate) is intentionally absent. Node identity is defined by {agent, prompt}.
 */
export interface NodeRuntimeState {
  /** Node identifier from the graph declaration */
  nodeId: string;
  /** Agent identifier from the node declaration */
  agent: string;
  /** Prompt text from the node declaration */
  prompt: string;
  /**
   * Whether this node pauses for human approval after execution.
   * Replaces the old `human_gate` node type — it is a pausing flag,
   * not a node category.
   */
  needsApproval: boolean;
  /** Current lifecycle status */
  status: NodeStatus;

  // ── Dispatch ──
  /** ID of the dispatch task for this node (set when node enters running) */
  dispatchTaskId?: string;
  /** Session ID of the dispatch task */
  dispatchSessionId?: string;
  /** Reference to materialized node output (populated on completion) */
  result?: MaterializedResultRef;
  /**
   * Stashed text snapshot of the node's materialized result sidecar, read
   * ONCE at completion time by `AdvanceEngine._captureNodeResult`
   * (`src/graph/engine/engine-advance.ts`, subtask 2). Backs the EdgePayload
   * `result` fallback in `_edgeResultText` so downstream data flow never
   * performs a synchronous disk read while the advancement critical section
   * holds the lock.
   *
   * OPTIONAL-ADDITIVE — absent until a completed node's sidecar was stashed
   * (or when the node has no materialized result); the I/O-failure → ''
   * degradation stashes an empty string. Absent in persisted files authored
   * before this field existed — both cases deserialize cleanly (undefined).
   */
  resultText?: string;

  // ── Signals ──
  /** Signals observed for this node (signal type → payload) */
  signalsObserved: Record<string, unknown>;

  // ── Budget ──
  /** Number of dispatch sessions spawned for this node */
  sessionsSpawned: number;
  /** Cumulative token and cost consumption for this node */
  tokensConsumed: UsageRecord;

  // ── Join state (for convergence nodes) ──
  /** Results collected from upstream edges, keyed by source node ID */
  upstreamResults: Map<string, EdgePayload>;
  /**
   * Join strategy from the node declaration (see
   * {@link ResolvedJoinStrategy}). Populated at provision time by
   * `resolveJoinStrategy` and re-validated on persisted-state load; a legacy
   * persisted bare `"quorum"` string is normalized to `{ quorum: 1 }` by the
   * persistence layer, never hydrated as-is.
   */
  joinStrategy: ResolvedJoinStrategy;
  /** Whether the join strategy is satisfied (all required upstream results received) */
  joinSatisfied: boolean;

  // ── Loop tracking ──
  /** Loop group this node belongs to, if any */
  loopGroupId?: string;
  /** How many times this node has executed within its loop group */
  traversalCount: number;

  // ── Timing ──
  /** Epoch ms timestamp when the node started */
  startedAt: number;
  /** Epoch ms timestamp when the node completed (absent while running) */
  completedAt?: number;
  /** Number of retries attempted */
  retryCount: number;
  /**
   * Epoch ms until which the node's automatic escalate-retry dispatch is
   * withheld (the retry backoff window). Written by the escalate retry gate
   * (signal-propagation.ts) as `now + backoff_ms` when the qualifying retry
   * edge declares `backoff_ms`; the dispatch step consumes it before
   * re-dispatching a re-marked-ready node.
   * OPTIONAL-ADDITIVE — absent until a retry edge declares a backoff, and in
   * persisted files authored before the field existed (both deserialize to
   * `undefined` via the DTO's `...rest` spread).
   */
  retryBackoffUntil?: number;
  /** Error reason when status is escalate, timeout, or done (error) */
  errorReason?: string;

  // ── Optional-Additive runtime fields ──
  /**
   * Artifact file paths produced by this node. Backs the `graph_status`
   * `include_artifacts` flag. OPTIONAL-ADDITIVE — absent until recorded.
   */
  artifacts?: string[];
  /**
   * Evidence references produced by this node. Backs the `graph_status`
   * `include_evidence` flag. OPTIONAL-ADDITIVE — absent until recorded.
   */
  evidence?: string[];
  /**
   * Runtime carrier for this node's declared budget spec — mirrors
   * {@link NodeConfig.budget} into runtime state so dispatch-facing code can
   * read the declared limits without re-parsing the declaration. Notably the
   * DispatchBridge sources the node's declared `timeout_ms` from here into the
   * dispatch task input (monitor-audit F7 / M2: the declared timeout was
   * previously written to the declaration but never consumed).
   * OPTIONAL-ADDITIVE — absent when the node declared no budget.
   */
  budget?: NodeBudgetSpec;
  /**
   * Per-node liveness detection state — heartbeat + stall tracking for the
   * node-anomaly-detection monitor.
   *
   * OPTIONAL-ADDITIVE — absent in persisted files written before this field
   * existed, and absent for nodes that have not yet recorded a heartbeat;
   * both cases deserialize cleanly (the field is simply `undefined`).
   *
   * Written by the liveness feed (subtask 2) and classified by the stall
   * monitor (subtask 3); the state carrier itself is defined here (subtask 1).
   */
  liveness?: NodeLivenessState;
}

/**
 * Per-node liveness tracking state recorded by the liveness feed and
 * classified by the stall monitor.
 *
 * OPTIONAL-ADDITIVE runtime carrier on {@link NodeRuntimeState.liveness} —
 * every field is JSON-primitive, so the carrier serializes and deserializes
 * losslessly through `engine-persistence.ts` without a schema bump. Absent
 * until the first heartbeat is recorded.
 */
export interface NodeLivenessState {
  /** Epoch ms of the most recent observed activity (tool call, message, dispatch event, …). */
  lastActivityAt?: number;
  /** Which observation channel produced the most recent heartbeat. */
  heartbeatSource?: "tool" | "message" | "session" | "dispatch" | "feed";
  /** Latest stall classification from the monitor. */
  stallStatus?: "healthy" | "stalling" | "stalled";
  /** Epoch ms when the stall warning was first issued (stalling → stalled). */
  stallWarnedAt?: number;
  /** Human-readable reason for the current stallStatus (monitor diagnosis). */
  stallReason?: string;
}

// ── Edge Payload ────────────────────────────────────────────────────────

/**
 * Data payload carried along an edge from upstream to downstream node.
 *
 * When a node completes, the engine materializes its result and packages
 * it into an EdgePayload. This formalizes what currently happens implicitly
 * through dispatch_output result extraction.
 */
export interface EdgePayload {
  /** Source node ID that produced this payload */
  fromNode: string;
  /** Signal type that triggered this payload (answer, revise_needed, escalate, progress) */
  fromSignal: string;
  /**
   * Output text carried from the source node.
   *
   * The worker's terminating signal payload when one was emitted (string
   * verbatim, object JSON-serialized). When the payload is missing, empty, or
   * the synthetic `{ __inferred: true }` marker (the worker never emitted
   * genuine output), this falls back to the source node's materialized result
   * sidecar text (M3) — the real output the worker produced, when it was
   * materialized (`totalChars > 0` and no `fetchError`); otherwise `""`.
   * See `AdvanceEngine._buildEdgePayload` (`src/graph/engine/engine-advance.ts`).
   */
  result: string;
  /** List of artifact file paths produced by the source node */
  artifacts: string[];
  /** Budget consumed by the source node in producing this result */
  budgetConsumed: {
    tokens: number;
    cost: number;
    sessions: number;
  };
}

// ── Supporting Runtime Types ────────────────────────────────────────────

/** Runtime state for a loop group during engine execution. */
export interface LoopGroupRuntimeState {
  /** Loop group identifier */
  id: string;
  /** Maximum number of cycle traversals (hard cap) */
  maxTraversals: number;
  /** Current traversal count */
  traversalCount: number;
  /** Epoch ms when the loop group started */
  startTimeMs: number;
  /**
   * Rolling fingerprint of the most recent convergence-node output, used by
   * the stuck early-exit (failure-resilience.md §4.3). Absent before the first
   * revision output is recorded.
   */
  convergenceFingerprint?: string;
  /**
   * Number of consecutive loop traversals whose convergence output matched
   * {@link convergenceFingerprint}. When this reaches `CONSECUTIVE_STALE_THRESHOLD`
   * (`src/loop/constants.ts:66`, = 2), the loop is considered stuck and exits
   * with `escalate` (reason `"stuck"`). Reset to 0 on any changed output or on
   * a `converged` (`answer`) signal.
   */
  consecutiveStale: number;
  /**
   * Optional ordered history of completed traversal rounds for this loop group.
   * Backs the `graph_status` `round` flag. OPTIONAL-ADDITIVE — absent until the
   * first round is recorded (subtask 2); never fabricated.
   */
  rounds?: RoundHistoryEntry[];
}

/**
 * Immutable snapshot of a single completed traversal round within a loop group.
 *
 * Backs the `graph_status` `round` flag. Recorded by subtask 2 when a round
 * finishes; the engine does not populate it on its own.
 */
export interface RoundHistoryEntry {
  /** 1-based round index within the loop group */
  round: number;
  /** Traversal count for the loop group when this round completed */
  traversalCount: number;
  /** Node IDs that executed during this round */
  nodeIds: string[];
  /** Aggregate status after the round (e.g. "completed", "converged") */
  status: NodeStatus;
  /** Epoch ms when the round started */
  startedAt: number;
  /** Epoch ms when the round completed (absent if still running) */
  completedAt?: number;
}

/**
 * Lifecycle transition snapshot recorded per node checkpoint.
 *
 * Backs the `graph_status` `include_checkpoint` flag. Recorded by subtask 2 at
 * meaningful lifecycle transitions (ready → running, running → completed, etc.);
 * the engine does not fabricate checkpoints.
 */
export interface CheckpointRecord {
  /** Node the checkpoint belongs to */
  nodeId: string;
  /** Lifecycle status captured at this checkpoint */
  status: NodeStatus;
  /** Epoch ms timestamp of the transition */
  at: number;
  /** Optional human/agent note attached to the checkpoint */
  note?: string;
}

/** Cumulative graph-level budget consumption state. */
export interface GraphBudgetState {
  /** Total dispatch sessions spawned across all nodes */
  sessionsSpawned: number;
  /** Total input tokens consumed across all nodes */
  totalInputTokens: number;
  /** Total output tokens consumed across all nodes */
  totalOutputTokens: number;
  /** Total cost consumed across all nodes (USD) */
  totalCost: number;
}

/** Entry in the per-node signal ledger. */
export interface SignalLedgerEntry {
  /** Signals observed, keyed by signal type (e.g. "answer", "revise_needed") */
  signals: Record<string, unknown>;
  /** Epoch ms timestamp of the most recent signal */
  lastSignalAt: number;
  /**
   * Optional ordered, timestamped signal-event history. Backs the
   * `graph_status` `include_history`, `stream`, and `since` flags.
   * OPTIONAL-ADDITIVE — absent until the first event is recorded (subtask 2).
   */
  history?: SignalLedgerEvent[];
}

/**
 * Discriminator for the origin of a signal recorded in the per-node ledger
 * history. Helps graph_status consumers distinguish live worker signals from
 * recovery-side reconciliation, race-guard paths, and synthetic
 * human-approval signals.
 */
export type SignalLedgerSource =
  | "dispatch"
  | "recovery"
  | "race_guard"
  | "approval";

/**
 * A single timestamped signal event in the per-node ledger history.
 *
 * Backs the `stream` (chronological) and `since` (from a given timestamp)
 * `graph_status` flags. Recorded by subtask 2 as genuine events arrive; the
 * engine does not synthesize events.
 */
export interface SignalLedgerEvent {
  /** Signal type (e.g. "answer", "revise_needed", "progress") */
  signal: string;
  /** Optional payload carried by the signal */
  payload?: unknown;
  /** Epoch ms timestamp when the event occurred */
  atMs: number;
  /**
   * Origin discriminator for this signal event.
   *
   * - `dispatch`     — live worker signal (onNodeSignalEmitted / dispatch listener)
   * - `recovery`     — recovery-side re-subscription or reconciliation
   * - `race_guard`   — race guard detected an already-terminal dispatch task
   * - `approval`     — synthetic signal from human approval / rejection of a blocked node
   */
  source: SignalLedgerSource;
}

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

import type { GraphDeclaration, LoopGroupDecl, TerminationDecl } from "./types.graph-v2.ts";
import type { EnginePhase, JoinStrategy, NodeStatus } from "./constants.ts";
import type { MaterializedResultRef } from "./dispatch/types.ts";
import type { UsageRecord } from "./dispatch/budget/budget-tracker.ts";

// ── Engine State ────────────────────────────────────────────────────────

/**
 * Runtime state of the graph execution engine.
 *
 * This is the top-level state container persisted across sessions.
 * It replaces GraphExecutionState (src/graph/state.ts:10-21) and subsumes
 * the graph session state, loop coordinator state, and dispatch task tracking
 * into a single unified structure.
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
  /** Per-edge runtime state (active data payloads), keyed by "from->to" */
  edges: Map<string, EdgePayload>;
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
  /** Completions deferred during a critical section (drained on unlock) */
  pendingCompletions: string[];

  /**
   * Optional per-node checkpoint store: lifecycle transition snapshots keyed
   * by node ID. Backs the `graph_status` `include_checkpoint` flag.
   *
   * OPTIONAL-ADDITIVE — absent until a checkpoint is recorded (subtask 2).
   * The engine and persistence layer treat its absence and an empty record
   * identically; it never carries fabricated values.
   */
  checkpoints?: Record<string, CheckpointRecord>;
}

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
   * Join strategy from the node declaration.
   * For "quorum" strategy, wraps the JoinStrategy string with the required count.
   */
  joinStrategy: JoinStrategy | { quorum: number };
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
  /** Output text from the source node */
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

// ── Fan-In Context ──────────────────────────────────────────────────────

/**
 * Merged context delivered to a fan-in (convergence) node.
 *
 * When a convergence node activates (join strategy satisfied), upstream
 * EdgePayloads are merged into a single structured FanInContext delivered
 * as part of the node's input.
 */
export interface FanInContext {
  /** Results from each upstream source */
  sources: {
    node: string;
    signal: string;
    result: string;
  }[];
  /** Artifacts from all upstream sources (deduplicated) */
  merged_artifacts: string[];
  /** Total budget consumed by all upstream sources */
  budget_consumed_total: {
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
  /** Termination configuration for this loop group */
  termination?: TerminationDecl;
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
}

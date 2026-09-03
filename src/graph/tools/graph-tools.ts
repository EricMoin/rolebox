/**
 * Graph Execution Engine v2 — Imperative `graph_*` Tool Logic
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * Phase 4, Subtask 5. Implements the TOOL LOGIC layer for the eight imperative
 * graph tools defined in `.rolebox/design/tool-merge-map.md` §2.2:
 *
 *     graph_create, graph_add_node, graph_add_edge, graph_add_loop,
 *     graph_run, graph_status, graph_cancel
 *
 * This module intentionally contains **no zod schemas and no tool
 * registration** — those belong to the tool-assembly wiring (subtask 6). It
 * exports a factory, {@link createGraphToolSet}, whose methods take plain
 * object parameters and return plain (JSON-serializable) values so subtask 6
 * can wrap each one with a zod `args` schema + a `defineTool` registration
 * without touching this file.
 *
 * ## Architecture
 *
 * - A per-instance **in-memory graph registry** maps `graph_id` →
 *   `{ declaration, runtime }`. The declaration is the source of truth being
 *   mutated by the construction tools; the runtime is a bound
 *   {@link EngineRuntime} (see `src/graph/engine/index.ts`) rebuilt from the
 *   declaration after every construction step.
 * - **Construction tools** (create/add_node/add_edge/add_loop) build a
 *   *candidate* declaration, structurally validate it, and only commit +
 *   re-provision on success. Mutation is therefore atomic — a failing edit
 *   leaves the registry untouched.
 * - **`graph_run`** (non dry-run) builds a manager-backed runtime via
 *   `createEngine(declaration, { manager, graphId, parentContext })` and calls
 *   `run()`. `dry_run` validates the structure without executing.
 *
 * ## Design-vs-code divergences (tool-merge-map.md §2.2 → real types)
 *
 * 1. `graph_add_node(join)` — the design pseudo-code shows a bare string
 *    (`join: "all"`), but the real `JoinConfig` type
 *    (`src/types.graph-v2.ts:125`) is structured `{ strategy, quorum? }`. This
 *    tool accepts the **structured** form to match the code.
 * 2. `graph_add_edge(data_passthrough_*)` — the design lists
 *    `include/exclude/max_chars`. All three are stored on the real
 *    `DataMapping` (`src/types.graph-v2.ts:102`):
 *    `data_passthrough_include` → `data_passthrough.fields`,
 *    `data_passthrough_exclude` → `data_passthrough.exclude`,
 *    `data_passthrough_max_chars` → `data_passthrough.maxChars`. No
 *    `exclude`/`max_chars` arguments are reported as `ignored` — both are now
 *    applied by the engine's data-mapping transform.
 * 3. `graph_add_edge(retry)` — design shows a bare number; real `RetryConfig`
 *    (`src/types.graph-v2.ts:108`) is `{ max, backoff_ms? }`. A bare number is
 *    coerced to `{ max }`.
 * 4. `graph_run` — the design's `node_id`/`retry`/`modify_prompt` retry mutation
 *    is now backed by the engine's `EngineRuntime.retryNode` surface
 *    (`node-retry.ts`, Phase-4 finishing round). When `node_id` is supplied with
 *    `retry:true` (or `modify_prompt` set), `graph_run` re-opens and re-dispatches
 *    that node after `run()` instead of reporting it `retry_pending`. The
 *    `retry_pending` field is therefore gone from {@link GraphRunResult}.
 * 5. `graph_cancel` — the engine's {@link EngineRuntime.cancel} is whole-graph
 *    only (there is no node/loop-scoped teardown primitive in Phase 4). A
 *    `node_id` / `loop_id` target is applied as a **filter** on the cancelled
 *    result set rather than a scoped cancellation. `cascade` is accepted and
 *    forwarded for API-shape compatibility.
 * 6. **Observed & confirmed:** `engine-state.registerNode`
 *    (`src/graph/engine/engine-state.ts:222-225`) correctly calls
 *    `resolveJoinStrategy(config.join)` to propagate the node's declared join
 *    (default `"all"`) into `NodeRuntimeState.joinStrategy`. The join config
 *    written by this tool therefore flows through correctly — no engine-side
 *    hard-coding remains.
 *
 * Design reference: `.rolebox/design/tool-merge-map.md` §2.2.
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import type { DispatchManager } from "../../dispatch/core/manager.ts";
import type { MaterializedResultRef } from "../../dispatch/types.ts";
import type {
  GraphDeclaration,
  NodeConfig,
  EdgeDeclaration,
  EdgeType,
  LoopGroupDecl,
  LoopMode,
  JoinConfig,
  DataMapping,
  RetryConfig,
  GraphBudgetSpec,
  NodeBudgetSpec,
  TerminationDecl,
} from "../../types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
  LoopGroupRuntimeState,
  RoundHistoryEntry,
  CheckpointRecord,
  SignalLedgerEvent,
  GraphBudgetState,
} from "../../types.engine-v2.ts";
import {
  createEngine,
  type EngineRuntime,
  type CreateEngineOptions,
  type NodeDispatchPort,
  type NodeCompletionEvent,
  type NodeStallEvent,
  type NodeLivenessFeed,
  type GraphTerminalEvent,
  GraphEventRecorder,
  readGraphEventLog,
  createGraphNotifier,
  createGraphStallNotifier,
  createGraphTerminalNotifier,
  type GraphCompletionHandler,
  type GraphStallHandler,
  type GraphTerminalHandler,
  graphParentContext,
  type DispatchParentContext,
} from "../engine/index.ts";
import type { ISessionClient } from "../../platform/ports/session-client.ts";
import { createSubLogger } from "../../logger.ts";
import { validateGraphDeclaration } from "../validator-v2.ts";
import { serializeGraphDeclaration } from "../serialize.ts";
import {
  EnginePhase,
  NodeStatus,
} from "../../constants.ts";
import {
  filterNodes,
  groupCompletedNodes,
  limitNodes,
  listPendingApprovals,
  toEpochMs,
  type GroupByMode,
  type StatusQuery,
} from "./status-queries.ts";
import {
  scanPersistedStates,
  type PersistedStateScan,
} from "./persisted-state.ts";

// Module logger (exported so tests can spy on the degradation warnings, F6).
export const log = createSubLogger("graph:tools");

// ── Registry ─────────────────────────────────────────────────────────────────

/** A bound engine plus the declaration it was built from. */
interface GraphEntry {
  declaration: GraphDeclaration;
  runtime: EngineRuntime;
  /**
   * Sticky invoking-session id captured at `graph_create` (or the first
   * `graph_run` / construction tool call that carried one). Drives the
   * graph-notify emperor-session resolver on every engine (re)build, so a
   * mid-flight structure mutation (e.g. `graph_add_node` after `graph_run`)
   * keeps working notification seams. Absent → the resolver falls back to the
   * freshly-supplied session id per call. See the notifier-resolution contract
   * in {@link GraphToolSet.commit}.
   */
  invokingSessionId?: string;
  /**
   * Sticky acting-agent (role id) captured at `graph_create` (or the first
   * `graph_run` / construction tool call that carried one). Mirrors
   * `invokingSessionId`: it is threaded into the graph-notify factories so the
   * injected `<system-reminder>` carries THIS agent, and opencode resumes the
   * orchestrator session as its real role instead of falling back to
   * `default_agent`. Absent → the notifier falls back to the config's static
   * `agent` (if any). See the notifier-resolution contract in
   * {@link GraphToolSet.commit}.
   */
  agent?: string;
}

/**
 * Config form of a graph-notify source (subtask 3). Carries the owner emperor
 * session identity + the session client used to deliver reminders. A single
 * config feeds both the per-node {@link onNodeCompletion} seam (via
 * {@link createGraphNotifier}) and the graph-terminal {@link onGraphTerminal}
 * seam (via {@link createGraphTerminalNotifier}), each with independent dedupe
 * epochs per engine construction. `emperorSessionId` may be a static string or a
 * resolver evaluated at engine-construction time (a resolver lets a caller
 * resolve the emperor session lazily, e.g. from a live session registry).
 */
export interface GraphNotifyConfig {
  /** Session client used to deliver `<system-reminder>` completions. */
  sessionClient: ISessionClient;
  /**
   * Emperor session to target for reminders. A static id, or a resolver invoked
   * once when the notifier is built (fresh per engine construction). The
   * resolver receives the invoking session id (`invokingSessionId`) — the
   * session whose execution context drove the engine construction — so a caller
   * can derive the emperor session from the graph tool's execution context at
   * runtime. When the resolved value is absent / empty, the notifier is a no-op.
   */
  emperorSessionId?: string | ((invokingSessionId?: string) => string | undefined);
  /** Optional agent tag forwarded to the injected prompt. */
  agent?: string;
}

/**
 * Graph node-completion notifier source accepted by {@link GraphToolSetDeps}.
 * Either a prebuilt notifier fn (a `GraphCompletionHandler` from
 * `graph-notify.ts`) or a structured owner config. When a structured config is
 * supplied, it also produces a graph-terminal notifier (`onGraphTerminal` seam)
 * via {@link createGraphTerminalNotifier} — the config form feeds both per-node
 * completion and graph-terminal reminders. Absent → the engine runs with its
 * default no-op seams (backward compatible).
 */
export type GraphNotifySource = GraphCompletionHandler | GraphNotifyConfig;

/** Options for constructing a {@link GraphToolSet}. */
export interface GraphToolSetDeps {
  /** Active {@link DispatchManager}; required only for non dry-run execution. */
  manager?: DispatchManager;
  /**
   * Optional injected dispatch seam. When present, it is used in place of a
   * manager-backed bridge for graph node dispatch — this lets callers and tests
   * drive `graph_run` (including the `retry` path) without a real
   * {@link DispatchManager} (see `engine-advance.ts` `NodeDispatchPort`).
   */
  dispatch?: NodeDispatchPort;
  /** Working directory for graph node dispatches (parent context). */
  directory?: string;
  /** Optional engine-state persistence dir (`.rolebox/state/...`). */
  stateDir?: string;
  /**
   * Optional per-node staleness deadline (ms) for every engine this toolset
   * builds (F2). Defaults to {@link DEFAULT_NODE_STALE_TIMEOUT_MS} (15 min) —
   * a `running` node whose worker stops advancing is marked `timeout` so a
   * graph never hangs. A node's declared per-node `budget.timeout_ms`
   * overrides it. Set to a non-positive value to disable the staleness
   * watcher on these engines (opt-out).
   */
  nodeStaleTimeoutMs?: number;
  /**
   * Optional stale-lock sweep interval (ms) for every engine this toolset
   * builds (F2). Defaults to {@link DEFAULT_SWEEPER_INTERVAL_MS} (60 s) — a
   * stuck `advancingLock` is released periodically. Set to a non-positive
   * value to disable the periodic sweep on these engines (manual ticking
   * only — opt-out).
   */
  sweeperIntervalMs?: number;
  /**
   * Optional soft-stall warn threshold (ms) for the heartbeat-based liveness
   * monitor every engine this toolset builds instantiates (subtask 6). A
   * heartbeat-fed `running` node that goes idle past this threshold is
   * classified `stalling` and surfaces the engine's `onNodeStall` seam (the
   * stall notifier) once per stall episode. Absent → the monitor's default
   * (`min(60_000, nodeStaleTimeoutMs / 2)`).
   */
  nodeStallWarnMs?: number;
  /**
   * Optional hard-stall grace (ms) past `nodeStallWarnMs` before a stalling
   * node is marked `timeout` (subtask 6). Absent → the monitor's default
   * (30_000).
   */
  nodeStallGraceMs?: number;
  /**
   * Optional node-liveness feed seam (node-anomaly-detection subtask 2).
   * Threaded into every engine this toolset builds: when present, the engine
   * records a `dispatch` heartbeat on every launch, registers its sessions
   * with the feed, and maintains a `sessionId → nodeId` reverse index (see
   * {@link GraphToolSet.resolveSessionOwner}) so the platform liveness wiring
   * can heartbeat / fail-fast graph sessions. Absent → engine behavior
   * unchanged.
   */
  livenessFeed?: NodeLivenessFeed;
  /**
   * Optional graph-notify source (subtask 3). When present, every engine this
   * toolset constructs — in `buildEngine` (used by all construction paths) and
   * in `graph_run`'s own runtime — wires both the engine's `onNodeCompletion`
   * DI seam (via {@link createGraphNotifier}) and the `onGraphTerminal` seam
   * (via {@link createGraphTerminalNotifier}), so per-node completions AND
   * graph-terminal transitions (COMPLETE / BLOCKED) route to graph-notify
   * targeting the owner emperor session. A prebuilt `GraphCompletionHandler` fn
   * is used as-is for `onNodeCompletion` but cannot produce a terminal handler
   * — use the config form ({@link GraphNotifyConfig}) to enable both. Absent →
   * the engine's default no-op seams (no notification). `graphParentContext`
   * budget scoping (`sessionID: graphId`) is untouched — the emperor session is
   * carried ONLY for notification targeting.
   */
  graphNotify?: GraphNotifySource;
}

// ── Tool parameter shapes (plain objects — subtask 6 wraps with zod) ─────────

export interface GraphCreateArgs {
  name: string;
  budget?: GraphBudgetSpec;
}

export interface GraphAddNodeArgs {
  graph_id: string;
  id: string;
  agent: string;
  prompt: string;
  completion_condition?: string;
  needs_approval?: boolean;
  join?: JoinConfig;
  budget?: NodeBudgetSpec;
  timeout_ms?: number;
  max_retries?: number;
}

export interface GraphAddEdgeArgs {
  graph_id: string;
  from: string;
  to: string;
  type?: EdgeType;
  signal_filter?: string[];
  condition?: string;
  data_passthrough_include?: string[];
  data_passthrough_exclude?: string[];
  data_passthrough_max_chars?: number;
  retry?: number | RetryConfig;
}

export interface GraphAddLoopArgs {
  graph_id: string;
  id: string;
  nodes: string[];
  max_traversals: number;
  termination?: TerminationDecl;
  /**
   * Session-isolation mode for this loop group's rounds. `inherit` (real) is
   * recorded on the loop declaration and surfaced in `graph_status` loop
   * render/summary. `fresh` (per-round session isolation) is
   * documented-unsupported — it returns an explicit error naming the
   * alternative path (a separate graph per round) rather than a silent no-op.
   * Absent = default behavior (byte-identical to legacy output).
   */
  mode?: LoopMode;
}

export interface GraphRunArgs {
  graph_id: string;
  node_id?: string;
  retry?: boolean;
  modify_prompt?: string;
  dry_run?: boolean;
}

export type GraphStatusFormat = "summary" | "tree" | "json";

/**
 * Session-scope of a `graph_status` query.
 *
 * - `session` — the in-memory registry only (the default; byte-identical to
 *   legacy behavior).
 * - `persisted` — only graphs hydrated from the on-disk engine-state store
 *   (`stateDir/.rolebox/state/engine-*.json`, subtask 3's scanner) — a
 *   cross-session view over graphs written by earlier sessions.
 * - `all` — the registry PLUS persisted graphs; on a `graphId` collision the
 *   live registry entry wins.
 */
export type GraphStatusScope = "session" | "persisted" | "all";

export interface GraphStatusArgs {
  graph_id?: string;
  node_id?: string;
  loop_id?: string;
  format?: GraphStatusFormat;
  /** Session-scope of the query (see {@link GraphStatusScope}). When
   * `persisted` or `all`, the scanned persisted EngineStates are merged into
   * the render/query pipeline so the no-target list, query/status/agent/
   * from_date/to_date filter, `group_by` buckets, and `include_budget`
   * aggregation all read across sessions. An empty store yields an explicit
   * honest-empty note — never fabricated rows. */
  scope?: GraphStatusScope;
  /** Case-insensitive substring filter on nodeId / prompt / agent (backed by
   * `status-queries.ts` — pure, honest subset, never fabricated rows). */
  query?: string;
  /** Exact {@link NodeStatus} node filter (canonical lowercase value). */
  status?: NodeStatus;
  /** Exact agent node filter. */
  agent?: string;
  /** ISO-8601 window lower bound on node timestamps (startedAt >= from). */
  from_date?: string;
  /** ISO-8601 window upper bound on node timestamps (completedAt <= to). */
  to_date?: string;
  /** Bucket COMPLETED nodes over their completedAt by hour / day / agent,
   * returning the bucket list with counts (uncompleted nodes excluded honestly).
   * A distinct view mode — when set it takes precedence over the row render. */
  group_by?: GroupByMode;
  /** Cap the number of node rows emitted in summary and json renders. Unset or
   * <= 0 leaves the output unbounded (byte-identical to legacy behavior). */
  limit?: number;
  /** Prune the tree render at `depth` levels (0 = roots only). Unset = full
   * depth (byte-identical to legacy tree output). */
  depth?: number;
  include_output?: boolean;
  include_progress?: boolean;
  include_budget?: boolean;
  include_metrics?: boolean;
  include_loops?: boolean;
  /** Include the node's recorded lifecycle checkpoint snapshot(s) from
   * `EngineState.checkpoints[nodeId]` (subtask 1 field). OPTIONAL-ADDITIVE —
   * absent until a checkpoint is recorded; when none exist, an explicit
   * "no checkpoint recorded" note is shown — never fabricated. */
  include_checkpoint?: boolean;
  /** Include the node's recorded artifact file paths from
   * `NodeRuntimeState.artifacts[]` (subtask 1 field). Nodes with no artifacts
   * are omitted honestly; a run with no artifacts yields an explicit
   * "no artifacts / evidence recorded" note. */
  include_artifacts?: boolean;
  /** Include the node's recorded evidence references from
   * `NodeRuntimeState.evidence[]` (subtask 1 field). Honest-empty like
   * `include_artifacts`. */
  include_evidence?: boolean;
  /** Include each node's recorded liveness state from
   * `NodeRuntimeState.liveness` (subtask 1 field). OPTIONAL-ADDITIVE —
   * only nodes WITH recorded liveness get the block; absent liveness →
   * nothing rendered, never fabricated. Running nodes always render their
   * liveness regardless of this flag. */
  include_liveness?: boolean;
  /** Include each loop group's ordered round history from
   * `LoopGroupRuntimeState.rounds[]` (subtask 1 field). Absent rounds yield an
   * explicit "no loop rounds recorded" note — never invented rows. */
  include_history?: boolean;
  /** Filter round history to a single 1-based round index within a loop group
   * (paired with `include_history` or alone). A round that was not recorded
   * yields an explicit "round N: not recorded" note. */
  round?: number;
  /** Surface the timestamped per-node signal-event history from
   * `SignalLedgerEntry.history` ({signal, payload, atMs}). An empty history
   * yields an explicit "no events recorded" note — never fabricated rows. */
  stream?: boolean;
  /** ISO-8601 lower bound — when `stream` (or alone) is set, include only
   * signal events at or after this timestamp. Events before `since` are
   * filtered out; if none remain, an explicit "no events since <ts>" note. */
  since?: string;
  /** First-class "awaiting human" view: list every `blocked` `needs_approval`
   * node across the resolved scope (registry only for `session`; persisted only
   * for `persisted`; merged for `all`). Each row carries the owning graph, the
   * blocked-since timestamp, a truncated `approval_payload` summary, and a
   * paste-ready `graph_approve` call. A distinct view mode — an empty result
   * renders an honest "no pending approvals" note, never fabricated rows. */
  pending_approvals?: boolean;
  max_chars?: number;
  offset?: number;
  tail?: boolean;
  /** When set, atomically write an export to this path and return a
   * confirmation instead of a status render. Mode-dependent: a `node_id` writes
   * that node's materialized result text, `include_metrics` writes a metrics
   * JSON snapshot, and neither writes the owning graph's declaration to YAML
   * (dispatch_export merge — §3 row 18). */
  export_path?: string;
}

export interface GraphCancelArgs {
  graph_id: string;
  node_id?: string;
  loop_id?: string;
  cascade?: boolean;
}

// ── Return shapes (JSON-serializable) ────────────────────────────────────────

export interface GraphCreateResult {
  graph_id: string;
  name: string;
  created_at: string;
}

export interface GraphAddNodeResult {
  node_id: string;
  graph_id: string;
  created: boolean;
}

export interface GraphAddEdgeResult {
  edge_id: string;
  from: string;
  to: string;
  type: EdgeType;
}

export interface GraphAddLoopResult {
  loop_id: string;
  graph_id: string;
  nodes: string[];
  max_traversals: number;
}

export interface GraphRunResult {
  graph_id: string;
  phase: string;
  /** Nodes that are genuinely active: Running, Blocked, or Ready (dispatch-imminent). Excludes Pending. */
  active_nodes: string[];
  /** Nodes that are Pending — not yet dispatched, awaiting upstream completion. */
  pending_nodes: string[];
  dry_run?: boolean;
  validation?: { valid: boolean; errors: string[]; warnings: string[] };
  /** Present when a node retry was requested (`node_id` + `retry`/`modify_prompt`). */
  retry?: {
    node_id: string;
    re_dispatched: number;
    reset: string[];
  };
}

export interface GraphCancelResult {
  cancelled: string[];
  graph_id: string;
}

export type GraphApproveAction = "approve" | "reject";

/**
 * Human-approval routing for a blocked `needs_approval` node.
 *
 * Backs the Phase C migration of the orchestrator-facing `dispatch_approve` /
 * `dispatch_reject` pair (see `.rolebox/design/tool-merge-map.md` §3 rows 7–8,
 * GAP-2 in `phase-c-inventory.md`). Routes import-only to the engine's public
 * `EngineRuntime.approveNode` / `rejectNode` — a thin parent-facing surface so
 * a graph that has paused at a `blocked` `needs_approval` node can be resumed
 * (approve) or re-entered/escalated (reject) from the orchestrator session.
 */
export interface GraphApproveArgs {
  /** Graph containing the blocked node. */
  graph_id: string;
  /** The `needs_approval` node currently `blocked` awaiting the human. */
  node_id: string;
  /**
   * `approve` resolves the gate (`blocked → completed`) and runs the node's
   * forward `answer` data flow. `reject` re-enters the node (`blocked → ready`,
   * merging the reason into its re-execution prompt) when it belongs to a loop
   * group, or escalates it (`blocked → escalate`) when it has no loop to re-open.
   */
  action: GraphApproveAction;
  /** Human-supplied rejection feedback (only meaningful when action=reject). */
  reason?: string;
  /** Optional approval output passed downstream on the answer edge (action=approve). */
  payload?: unknown;
}

export interface GraphApproveResult {
  graph_id: string;
  node_id: string;
  action: GraphApproveAction;
  /** The node's lifecycle status after the decision (NodeStatus, or "unknown"). */
  node_status: NodeStatus | "unknown";
  /** The graph phase after the decision advanced. */
  phase: string;
}

// ── Tool set ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 16000;

/**
 * F2 production defaults applied to every engine this toolset builds (in
 * `buildEngine` and `graph_run`) unless the caller supplies an override:
 *
 * - {@link DEFAULT_NODE_STALE_TIMEOUT_MS} — per-node staleness deadline. A
 *   `running` node whose worker stops advancing is marked `timeout` so a
 *   graph never hangs (monitor M3). A node's declared per-node
 *   `budget.timeout_ms` overrides it (engine-recovery.ts, deadline resolution
 *   is per-node).
 * - {@link DEFAULT_SWEEPER_INTERVAL_MS} — periodic stale-lock sweep. A stuck
 *   `advancingLock` is released so a hung critical section never deadlocks
 *   the graph (failure-resilience.md §5.6).
 */
const DEFAULT_NODE_STALE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SWEEPER_INTERVAL_MS = 60_000;

/**
 * `graph_status` flags in `.rolebox/design/tool-merge-map.md` §2.2 that have
 * **no backing data** in the current engine runtime shapes
 * (`src/types.engine-v2.ts` — `EngineState` / `NodeRuntimeState` /
 * `LoopGroupRuntimeState`). These are intentionally NOT exposed as zod args and
 * are never fabricated — answering an observability request the engine cannot
 * support would mean inventing values.
 *
 * Kept as a single inspectable registry so tests can assert that every §2.2
 * flag is either surfaced with genuine data or explicitly documented as
 * unbacked (see `tests/graph/graph-status-flags.test.ts`).
 *
 * The flag-backing timeline (each backed flag is therefore absent here):
 *
 * - Subtask 3 backed `group_by` (completed-node bucketing), `limit` (row cap for
 *   summary/json), and `depth` (tree cutoff) — see `status-queries.ts`.
 * - Subtask 3 (C-WIRE) backed the final seven: `round` + `include_history`
 *   (`LoopGroupRuntimeState.rounds[]`), `include_checkpoint`
 *   (`EngineState.checkpoints`), `include_artifacts` / `include_evidence`
 *   (`NodeRuntimeState.artifacts[]` / `.evidence[]`), and `stream` + `since`
 *   (`SignalLedgerEntry.history[]`). Their renderers live in the "C-WIRE
 *   observability flags" section below.
 *
 * The registry is therefore EMPTY — every original §2.2 `graph_status` flag is
 * now backed with genuine data or an honest-empty note. It is retained as an
 * empty `ReadonlyArray` so the audit tests can pin this end state.
 */
export const UNSUPPORTED_GRAPH_STATUS_FLAGS: ReadonlyArray<{
  flag: string;
  reason: string;
}> = [];


/**
 * The imperative `graph_*` tool set bound to a dispatch manager and a single
 * in-memory graph registry. Construct once per session (or per graph batch);
 * {@link graph_create} opens a registry slot that the other tools mutate.
 */
export class GraphToolSet {
  private readonly registry = new Map<string, GraphEntry>();

  constructor(private readonly deps: GraphToolSetDeps = {}) {}

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve the configured graph-notify source into a concrete
   * `onNodeCompletion` handler, or `undefined` for the engine's default no-op
   * seam. A prebuilt notifier fn is returned as-is; a config form is materialized
   * via {@link createGraphNotifier} once per call (a fresh notifier = a fresh
   * dedupe epoch per engine construction). The config's `emperorSessionId`
   * resolver is invoked with the invoking session id (`invokingSessionId`) when
   * provided, so the emperor session can be derived from the graph tool's
   * execution context at runtime. Returns `undefined` when no source is
   * configured or the resolved emperor session is absent — in the latter case a
   * degradation warning naming the graph is logged (and a durable
   * `notification_degraded` marker recorded when a stateDir is configured) so
   * the silent drop is observable (F6). Subtask 3.
   */
  private completionHandler(
    graphId: string,
    invokingSessionId?: string,
    agent?: string,
  ): ((event: NodeCompletionEvent) => void) | undefined {
    const src = this.deps.graphNotify;
    if (src === undefined) return undefined;
    if (typeof src === "function") return src;
    const emperorSessionId =
      typeof src.emperorSessionId === "function"
        ? src.emperorSessionId(invokingSessionId)
        : src.emperorSessionId;
    if (!emperorSessionId) {
      // F6: no silent no-op — name the graph + seam, and persist a marker when
      // a stateDir is available so graph_status consumers can observe the drop.
      log.warn(
        `graph-tools: graph "${graphId}" completion notification degraded — no emperor session resolved; node-completion reminder suppressed`,
      );
      this.recordNotificationDegraded(graphId, "completion");
      return undefined;
    }
    // The acting-agent passed at engine construction (the orchestrator's role)
    // wins over a statically-configured `src.agent`, so a runtime-captured
    // `context.agent` is forwarded to opencode's prompt body.
    const notifierAgent = agent || src.agent;
    return createGraphNotifier(src.sessionClient, {
      emperorSessionId,
      ...(notifierAgent ? { agent: notifierAgent } : {}),
    });
  }

  /**
   * Resolve the configured graph-notify source into a concrete
   * `onGraphTerminal` handler, or `undefined` for the engine's default no-op
   * seam. Same resolution logic as {@link completionHandler} — but only the
   * config form (`GraphNotifyConfig`) can produce a terminal handler; a prebuilt
   * `GraphCompletionHandler` fn cannot be deconstructed, so it yields
   * `undefined`. A fresh notifier = a fresh dedupe epoch per engine construction.
   * When the resolved emperor session is absent, a degradation warning naming
   * the graph is logged (plus a durable marker when a stateDir is configured)
   * instead of silently degrading (F6).
   */
  private terminalHandler(
    graphId: string,
    invokingSessionId?: string,
    agent?: string,
  ): ((event: GraphTerminalEvent) => void) | undefined {
    const src = this.deps.graphNotify;
    if (src === undefined) return undefined;
    // A prebuilt per-node handler cannot produce a terminal handler.
    if (typeof src === "function") return undefined;
    const emperorSessionId =
      typeof src.emperorSessionId === "function"
        ? src.emperorSessionId(invokingSessionId)
        : src.emperorSessionId;
    if (!emperorSessionId) {
      log.warn(
        `graph-tools: graph "${graphId}" terminal notification degraded — no emperor session resolved; graph-terminal reminder suppressed`,
      );
      this.recordNotificationDegraded(graphId, "terminal");
      return undefined;
    }
    const notifierAgent = agent || src.agent;
    return createGraphTerminalNotifier(src.sessionClient, {
      emperorSessionId,
      ...(notifierAgent ? { agent: notifierAgent } : {}),
    }) as (event: GraphTerminalEvent) => void;
  }

  /**
   * Resolve the configured graph-notify source into a concrete `onNodeStall`
   * handler, or `undefined` for the engine's default no-op seam. Same
   * resolution logic as {@link completionHandler} — config form only
   * (`GraphNotifyConfig`); a prebuilt `GraphCompletionHandler` fn cannot be
   * deconstructed, so it yields `undefined` (stall notifications ride the
   * engine-level `onNodeStall` DI seam, distinct from the prebuilt per-node
   * completion handler). A fresh notifier = a fresh dedupe epoch per engine
   * construction. When the resolved emperor session is absent, a degradation
   * warning naming the graph is logged (plus a durable marker when a stateDir
   * is configured) instead of silently degrading (F6). Subtask 5.
   */
  private stallHandler(
    graphId: string,
    invokingSessionId?: string,
    agent?: string,
  ): ((event: NodeStallEvent) => void) | undefined {
    const src = this.deps.graphNotify;
    if (src === undefined) return undefined;
    // A prebuilt per-node handler cannot produce a stall handler.
    if (typeof src === "function") return undefined;
    const emperorSessionId =
      typeof src.emperorSessionId === "function"
        ? src.emperorSessionId(invokingSessionId)
        : src.emperorSessionId;
    if (!emperorSessionId) {
      // F6: no silent no-op — name the graph + seam, and persist a marker when
      // a stateDir is available so graph_status consumers can observe the drop.
      log.warn(
        `graph-tools: graph "${graphId}" stall notification degraded — no emperor session resolved; stall reminder suppressed`,
      );
      this.recordNotificationDegraded(graphId, "stall");
      return undefined;
    }
    const notifierAgent = agent || src.agent;
    return createGraphStallNotifier(src.sessionClient, {
      emperorSessionId,
      ...(notifierAgent ? { agent: notifierAgent } : {}),
    }) as (event: NodeStallEvent) => void;
  }

  /**
   * Record a durable `notification_degraded` event when a stateDir is
   * configured (F6, optional-additive — absent stateDir → warning log only).
   * Written by the toolset itself because the notifier is never constructed in
   * this path; the marker lands in the graph's event log (`.rolebox/state/
   * graph-events-{hash}.ndjson`) so a graph_status consumer can surface
   * "terminal notification degraded". Subtask 5 adds the `stall` kind.
   */
  private recordNotificationDegraded(
    graphId: string,
    kind: "completion" | "terminal" | "stall",
  ): void {
    if (!this.deps.stateDir) return;
    // The recorder's `kind` slot is the serialized `status` string
    // (graph-events.ts writes it verbatim into the record's generic status
    // field); its type union predates the newer "stall" kind, so the kind is
    // widened at this boundary — the record shape is identical.
    new GraphEventRecorder(this.deps.stateDir).notificationDegraded(
      graphId,
      kind as "completion" | "terminal",
    );
  }

  /**
   * Read-only helper backing the graph_status degraded hint: read the graph's
   * durable event log (`.rolebox/state/graph-events-{hash}.ndjson`) and return
   * the deduped `status` values of any `notification_degraded` events
   * (`"completion"` / `"terminal"`), in file order. Empty when no stateDir is
   * configured, no log file exists, or no degraded event was recorded — and
   * never throws, so a missing / corrupt log can never break a status query
   * (total, observability-only, mirroring the recorder's own total discipline).
   */
  private notificationDegradedStatuses(graphId: string): string[] {
    if (!this.deps.stateDir) return [];
    const statuses: string[] = [];
    for (const record of readGraphEventLog(this.deps.stateDir, graphId)) {
      if (record.event === "notification_degraded" && record.status) {
        if (!statuses.includes(record.status)) statuses.push(record.status);
      }
    }
    return statuses;
  }

  /** Create a fresh, provisioned engine from a declaration (re-provision). */
  private buildEngine(
    declaration: GraphDeclaration,
    graphId: string,
    invokingSessionId?: string,
    agent?: string,
  ): EngineRuntime {
    const options: CreateEngineOptions = {
      manager: this.deps.manager,
      graphId,
      stateDir: this.deps.stateDir,
      // F2: enable the stale-node watcher + stale-lock sweeper on every engine
      // the toolset builds — mid-flight rebuilds (construction tools) keep the
      // same guard as graph_run. Conservative production defaults unless the
      // caller supplied an explicit override; per-node budget.timeout_ms beats
      // the watcher deadline (engine-recovery.ts).
      nodeStaleTimeoutMs:
        this.deps.nodeStaleTimeoutMs ?? DEFAULT_NODE_STALE_TIMEOUT_MS,
      sweeperIntervalMs: this.deps.sweeperIntervalMs ?? DEFAULT_SWEEPER_INTERVAL_MS,
      // Subtask 6: thread the optional liveness-monitor stall thresholds + the
      // node-liveness feed into every engine the toolset builds (absent → the
      // engine's defaults / unchanged behavior).
      ...(this.deps.nodeStallWarnMs !== undefined
        ? { nodeStallWarnMs: this.deps.nodeStallWarnMs }
        : {}),
      ...(this.deps.nodeStallGraceMs !== undefined
        ? { nodeStallGraceMs: this.deps.nodeStallGraceMs }
        : {}),
      ...(this.deps.livenessFeed !== undefined
        ? { livenessFeed: this.deps.livenessFeed }
        : {}),
    };
    // Subtask 3: wire the configured graph-notify completion seam (absent →
    // no-op). The emperor session is targeted ONLY for notification; the
    // graphParentContext budget scope (sessionID: graphId) is left unchanged.
    const completion = this.completionHandler(graphId, invokingSessionId, agent);
    if (completion) {
      options.onNodeCompletion = completion;
    }
    const terminal = this.terminalHandler(graphId, invokingSessionId, agent);
    if (terminal) {
      options.onGraphTerminal = terminal;
    }
    // Subtask 5: wire the configured graph-notify stall seam (absent → no-op).
    const stall = this.stallHandler(graphId, invokingSessionId, agent);
    if (stall) {
      options.onNodeStall = stall;
    }
    // Graph monitoring: a durable write-side event log alongside the notifier.
    // Constructed only when a stateDir is configured — absent stateDir → no
    // recorder → no event logging (no-op safe).
    const graphEvents = this.deps.stateDir
      ? new GraphEventRecorder(this.deps.stateDir)
      : undefined;
    if (graphEvents) {
      options.graphEvents = graphEvents;
    }
    // An injected dispatch seam wins over the manager-backed bridge (explicit >
    // manager, per createEngine). Present when a caller drives graph dispatch
    // without a real DispatchManager.
    if (this.deps.dispatch) {
      options.dispatch = this.deps.dispatch;
    }
    if (this.deps.manager) {
      options.parentContext = this.parentContext(graphId);
    }
    const runtime = createEngine(declaration, options);
    runtime.provision();
    return runtime;
  }

  private parentContext(graphId: string): DispatchParentContext {
    return graphParentContext({
      graphId,
      directory: this.deps.directory ?? ".",
    });
  }

  /** Look up a graph entry or throw a descriptive error. */
  private getEntry(graphId: string): GraphEntry {
    const entry = this.registry.get(graphId);
    if (!entry) {
      throw new Error(
        `graph "${graphId}" does not exist. Call graph_create first to open a graph registry slot.`,
      );
    }
    return entry;
  }

  /**
   * Resolve an entry for `graph_approve` / `graph_reject` that survives a plugin
   * restart (subtask 2).
   *
   * The in-memory registry is empty after a restart, but a graph paused at a
   * `blocked` `needs_approval` node persists its state on disk. `recoverInterruptedGraphs`
   * (engine-startup.ts) rebuilds such graphs as independent `createEngine`
   * instances that are never placed into this toolset's registry — so a plain
   * `getEntry` throws "graph X does not exist" even though the gate is durably
   * resumable.
   *
   * Order of resolution:
   * 1. Registry hit → return it unchanged (the normal in-memory path).
   * 2. Persisted hit at a non-`complete` phase with a `blocked` target node →
   *    rebuild a fresh engine from the persisted declaration, adopt the on-disk
   *    per-node progress with `adoptPrior` semantics (so the `blocked` gate is
   *    carried across instead of reset to `ready`), register it, and return.
   * 3. Neither present → throw the same descriptive error `getEntry` throws.
   *
   * Additive and non-destructive: the registry path is untouched; the persisted
   * path only rebuilds when the registry has no entry for `graphId`.
   */
  private async resolveApprovalEntry(
    graphId: string,
    nodeId: string,
  ): Promise<GraphEntry> {
    const existing = this.registry.get(graphId);
    if (existing) return existing;

    const found = this.persistedScan().loaded.find((s) => s.graphId === graphId);
    const target = found?.nodes.get(nodeId);
    // Only a resumable gate is worth rebuilding: a non-complete persisted phase
    // (idle/executing — "blocked" is a node status, not a phase) whose target
    // node is blocked. Anything else falls through to the descriptive error so
    // the registry remains the source of truth for the normal paths.
    if (found && found.phase !== EnginePhase.Complete && target?.status === NodeStatus.Blocked) {
      const runtime = this.buildEngine(found.graphDeclaration, graphId);
      // Fire-and-forget is unacceptable here (constructors are sync), but
      // adoption's async half is only the dispatch reconcile — safe to await:
      // no node is re-dispatched, only the `blocked` gate is carried across.
      // A throwing adoptPrior is contained (logged), never surfaced raw.
      try {
        await runtime.adoptPrior(found);
      } catch (err) {
        log.warn(
          `graph-tools: adoptPrior (approval recovery) failed for graph "${graphId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const entry: GraphEntry = {
        declaration: found.graphDeclaration,
        runtime,
      };
      this.registry.set(graphId, entry);
      return entry;
    }

    // Registry miss and no resumable persisted state → the same descriptive
    // error `getEntry` throws today.
    throw new Error(
      `graph "${graphId}" does not exist. Call graph_create first to open a graph registry slot.`,
    );
  }

  /** Commit a candidate declaration: validate → store → rebuild runtime.
   *
   * When the graph already has a runtime with execution progress (a
   * construction tool was called AFTER `graph_run` — e.g. the emperor adds a
   * validate node mid-flight), the prior runtime's per-node progress is
   * adopted into the rebuilt engine so completed / running nodes are never
   * reset back to `ready` and re-dispatched on the next `graph_run`. */
  private commit(
    graphId: string,
    candidate: GraphDeclaration,
    invokingSessionId?: string,
    agent?: string,
  ): void {
    const validation = validateGraphDeclaration(candidate);
    if (!validation.valid) {
      throw new Error(
        `graph "${graphId}" failed structural validation:\n` +
          validation.errors.map((e) => `  - ${e}`).join("\n"),
      );
    }
    const prior = this.registry.get(graphId);
    // Sticky notifier session: prefer the graph-captured (stored) invoking
    // session id, falling back to the freshly-supplied one (a construction
    // tool called before any graph_create/graph_run captured a session). This
    // keeps the emperor-session resolver consistent across mid-flight rebuilds
    // so `completionHandler`/`terminalHandler` never degrade to a no-op.
    const sessionId = prior?.invokingSessionId ?? invokingSessionId;
    // Sticky notifier agent: same sticky discipline — prefer the captured
    // acting-agent so the injected `<system-reminder>` keeps forwarding the
    // orchestrator's role across mid-flight rebuilds.
    const resolvedAgent = prior?.agent ?? agent;
    const runtime = this.buildEngine(candidate, graphId, sessionId, resolvedAgent);
    if (prior) {
      const priorState = prior.runtime.status();
      const hasProgress = [...priorState.nodes.values()].some(
        (n) => n.status !== NodeStatus.Pending && n.status !== NodeStatus.Ready,
      );
      if (hasProgress || priorState.phase !== EnginePhase.Idle) {
        // Fire-and-forget is unacceptable here (constructors are sync), but
        // adoption's async half is only the dispatch reconcile — which is
        // safe to run detached: it never re-dispatches, only re-attaches /
        // re-emits already-finished work. Subtask 2: a throwing adoptPrior
        // must be contained (logged) — never an unhandled rejection from this
        // fire-and-forget commit site.
        void runtime.adoptPrior(priorState).catch((err: unknown) => {
          log.warn(
            `graph-tools: adoptPrior failed for graph "${graphId}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
    // Monitor M4: dispose the PRIOR runtime before replacing the registry entry
    // so its orphaned `onTaskTerminated` dispatch listeners (engine-recovery.ts
    // subscribeTaskTermination) are unregistered from the dispatch seam — a
    // mid-flight rebuild must never leave a stale runtime receiving (or
    // leaking) completion callbacks for tasks the new engine now owns.
    prior?.runtime.dispose?.();
    this.registry.set(graphId, {
      declaration: candidate,
      runtime,
      ...(sessionId ? { invokingSessionId: sessionId } : {}),
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
    });
  }

  private static shallowCloneDeclaration(d: GraphDeclaration): GraphDeclaration {
    return {
      ...d,
      nodes: d.nodes.map((n) => ({ ...n })),
      edges: d.edges.map((e) => ({ ...e })),
      loop_groups: d.loop_groups?.map((g) => ({ ...g })),
      budget: d.budget ? { ...d.budget } : undefined,
      termination: d.termination ? { ...d.termination } : undefined,
    };
  }

  // ── graph_create ───────────────────────────────────────────────────────────

  graph_create(args: GraphCreateArgs, invokingSessionId?: string, agent?: string): GraphCreateResult {
    const { name, budget } = args;
    if (!name || name.trim() === "") {
      throw new Error('graph_create: "name" is required and must be non-empty.');
    }
    const declaration: GraphDeclaration = {
      version: 2,
      name: name.trim(),
      nodes: [],
      edges: [],
    };
    if (budget && Object.keys(budget).length > 0) {
      declaration.budget = budget;
    }

    // Generate a unique graph id. Deterministic for tests when a single graph
    // is created; collision-free for multiple graphs via a suffix counter.
    let graphId = name.trim();
    let seq = 2;
    while (this.registry.has(graphId)) {
      graphId = `${name.trim()}-${seq}`;
      seq += 1;
    }

    // Capture the invoking session id onto the registry entry so every
    // subsequent construction/run uses it for the graph-notify resolver.
    this.commit(graphId, declaration, invokingSessionId, agent);
    return {
      graph_id: graphId,
      name: name.trim(),
      created_at: new Date().toISOString(),
    };
  }

  // ── graph_add_node ─────────────────────────────────────────────────────────

  graph_add_node(args: GraphAddNodeArgs, invokingSessionId?: string, agent?: string): GraphAddNodeResult {
    const entry = this.getEntry(args.graph_id);
    if (entry.declaration.nodes.some((n) => n.id === args.id)) {
      throw new Error(
        `graph_add_node: node "${args.id}" already exists in graph "${args.graph_id}".`,
      );
    }
    if (!args.agent || args.agent.trim() === "") {
      throw new Error(`graph_add_node: node "${args.id}" requires a non-empty "agent".`);
    }

    const node: NodeConfig = {
      id: args.id,
      agent: args.agent.trim(),
      prompt: args.prompt,
    };
    if (args.completion_condition) {
      node.completion_condition = args.completion_condition;
    }
    if (args.needs_approval) {
      node.needs_approval = true;
    }
    if (args.join) {
      node.join = args.join;
    }
    const budget: NodeBudgetSpec = { ...(args.budget ?? {}) };
    if (args.timeout_ms !== undefined) budget.timeout_ms = args.timeout_ms;
    if (args.max_retries !== undefined) budget.max_retries = args.max_retries;
    if (Object.keys(budget).length > 0) node.budget = budget;

    const candidate = GraphToolSet.shallowCloneDeclaration(entry.declaration);
    candidate.nodes.push(node);
    this.commit(args.graph_id, candidate, invokingSessionId, agent);
    return { node_id: args.id, graph_id: args.graph_id, created: true };
  }

  // ── graph_add_edge ─────────────────────────────────────────────────────────

  graph_add_edge(args: GraphAddEdgeArgs, invokingSessionId?: string, agent?: string): GraphAddEdgeResult {
    const entry = this.getEntry(args.graph_id);
    const type: EdgeType = args.type ?? "always";

    if (type === "on_signal" && (!args.signal_filter || args.signal_filter.length === 0)) {
      throw new Error(
        `graph_add_edge: edge "${args.from} -> ${args.to}" is type "on_signal" ` +
          `but no "signal_filter" was provided.`,
      );
    }
    if (type === "on_condition" && !args.condition) {
      throw new Error(
        `graph_add_edge: edge "${args.from} -> ${args.to}" is type "on_condition" ` +
          `but no "condition" was provided.`,
      );
    }

    const edge: EdgeDeclaration = { from: args.from, to: args.to, type };
    if (args.signal_filter && args.signal_filter.length > 0) {
      edge.signal_filter = args.signal_filter;
    }
    if (args.condition) {
      edge.condition = args.condition;
    }
    if (
      (args.data_passthrough_include && args.data_passthrough_include.length > 0) ||
      (args.data_passthrough_exclude && args.data_passthrough_exclude.length > 0) ||
      args.data_passthrough_max_chars !== undefined
    ) {
      const mapping: DataMapping = {};
      if (args.data_passthrough_include && args.data_passthrough_include.length > 0) {
        mapping.fields = args.data_passthrough_include;
      }
      if (args.data_passthrough_exclude && args.data_passthrough_exclude.length > 0) {
        mapping.exclude = args.data_passthrough_exclude;
      }
      if (args.data_passthrough_max_chars !== undefined) {
        mapping.maxChars = args.data_passthrough_max_chars;
      }
      edge.data_passthrough = mapping;
    }
    if (args.retry !== undefined) {
      edge.retry = typeof args.retry === "number"
        ? { max: args.retry }
        : { ...args.retry };
    }

    const candidate = GraphToolSet.shallowCloneDeclaration(entry.declaration);
    candidate.edges.push(edge);
    this.commit(args.graph_id, candidate, invokingSessionId, agent);

    return { edge_id: `${args.from}->${args.to}`, from: args.from, to: args.to, type };
  }

  // ── graph_add_loop ─────────────────────────────────────────────────────────

  graph_add_loop(args: GraphAddLoopArgs, invokingSessionId?: string, agent?: string): GraphAddLoopResult {
    const entry = this.getEntry(args.graph_id);
    if ((entry.declaration.loop_groups ?? []).some((g) => g.id === args.id)) {
      throw new Error(
        `graph_add_loop: loop group "${args.id}" already exists in graph "${args.graph_id}".`,
      );
    }
    if (args.max_traversals < 1) {
      throw new Error(
        `graph_add_loop: loop group "${args.id}" requires max_traversals >= 1.`,
      );
    }
    if (args.mode === "fresh") {
      // Documented-unsupported, never a silent no-op: name the alternative path.
      throw new Error(
        `graph_add_loop: mode="fresh" is not supported. The engine re-dispatches ` +
          `loop members within the SAME engine state (propagateRevise increments ` +
          `traversalCount on the shared node), so loop rounds are inherently ` +
          `inherit-flavored; per-round session isolation is not wired. For fresh ` +
          `session isolation, create a SEPARATE GRAPH per round instead of a loop ` +
          `group. Supported mode: "inherit" (default behavior is to leave mode unset).`,
      );
    }

    const loop: LoopGroupDecl = {
      id: args.id,
      nodes: [...args.nodes],
      max_traversals: args.max_traversals,
    };
    if (args.termination) {
      loop.termination = args.termination;
    }
    if (args.mode === "inherit") {
      loop.mode = "inherit";
    }

    const candidate = GraphToolSet.shallowCloneDeclaration(entry.declaration);
    const groups = [...(candidate.loop_groups ?? [])];
    groups.push(loop);
    candidate.loop_groups = groups;
    this.commit(args.graph_id, candidate, invokingSessionId, agent);

    return {
      loop_id: args.id,
      graph_id: args.graph_id,
      nodes: loop.nodes,
      max_traversals: loop.max_traversals,
    };
  }

  // ── graph_run ──────────────────────────────────────────────────────────────

  async graph_run(
    args: GraphRunArgs,
    invokingSessionId?: string,
    agent?: string,
  ): Promise<GraphRunResult> {
    const entry = this.getEntry(args.graph_id);

    // dry_run: validate structure without executing. Execution-mode severity:
    // a dry run answers "would this graph actually run?" — an uncontained
    // revise-free cycle (Bug #2) or an unknown on_condition name (Bug #1)
    // must report valid=false here rather than pass and deadlock at run.
    if (args.dry_run) {
      const validation = validateGraphDeclaration(entry.declaration, {
        mode: "execution",
      });
      return {
        graph_id: args.graph_id,
        phase: validation.valid ? "validating" : "invalid",
        active_nodes: [],
        pending_nodes: [],
        dry_run: true,
        validation,
      };
    }

    // Non dry-run: build an engine and run it. A dispatch path (a real manager
    // or an injected dispatch seam) is required for real dispatch — without one,
    // run() rejects and we surface the actionable error.
    if (!this.deps.manager && !this.deps.dispatch) {
      throw new Error(
        `graph_run: no dispatch manager (or injected dispatch seam) available. ` +
          `Graph execution requires a DispatchManager or dispatch seam; construct the GraphToolSet with one (or use dry_run=true).`,
      );
    }

    // Sticky notifier session: prefer the graph-captured (stored) invoking
    // session id, falling back to the freshly-supplied one. When graph_run
    // receives a fresh session id, the stored value is updated below so
    // subsequent mid-flight rebuilds (construction tools) keep working seams.
    const sessionId = entry.invokingSessionId ?? invokingSessionId;
    // Sticky notifier agent: same sticky discipline — prefer the graph-captured
    // acting-agent so the injected `<system-reminder>` keeps forwarding the
    // orchestrator's role across rebuilds/retries.
    const agentId = entry.agent ?? agent;

    // Per-graph in-flight guard (concurrency fix): when the registry entry's
    // runtime is ALREADY executing with running/ready nodes, a concurrent
    // `graph_run` (no node_id) must NOT build a fresh engine. Building one would
    // orphan the live runtime's in-flight `onTaskTerminated` dispatch listeners
    // (engine-recovery.ts subscribeTaskTermination) and its EngineState — the
    // second runtime would supersede the first while the first's tasks are still
    // mid-flight, silently dropping completion routing. Instead, REUSE the live
    // runtime and return its current status (phase / active_nodes / pending_nodes)
    // WITHOUT re-dispatching — an idempotent re-run.
    //
    // The adoptPrior + replayAnswers rebuild path below remains for the legitimate
    // rebuild-after-complete case (phase is Idle/Complete here → guard skipped),
    // and targeted retry (`node_id` + `retry`/`modify_prompt`) is exempt so it
    // keeps working.
    const liveStatus = entry.runtime.status();
    const hasInFlightNode = [...liveStatus.nodes.values()].some(
      (n) =>
        n.status === NodeStatus.Running || n.status === NodeStatus.Ready,
    );
    const isMidFlight =
      liveStatus.phase === EnginePhase.Executing && hasInFlightNode;
    if (isMidFlight && !args.node_id) {
      const active: string[] = [];
      const pending: string[] = [];
      for (const n of liveStatus.nodes.values()) {
        if (GRAPH_RUN_ACTIVE_STATUSES.has(n.status)) {
          active.push(n.nodeId);
        } else if (n.status === NodeStatus.Pending) {
          pending.push(n.nodeId);
        }
      }
      // Update the sticky session id even on an idempotent mid-flight re-run so
      // the stored value stays current for any later rebuild.
      this.registry.set(args.graph_id, {
        ...entry,
        ...(invokingSessionId ? { invokingSessionId } : {}),
        ...(agent ? { agent: agentId } : {}),
      });
      return {
        graph_id: args.graph_id,
        phase: liveStatus.phase,
        active_nodes: active,
        pending_nodes: pending,
      };
    }

    // Completed-graph short-circuit (idempotent re-run of a finished graph).
    // When the registry entry's runtime has ALREADY reached phase Complete and
    // no node is left in an unsettled state (Ready/Running/Blocked/Pending), a
    // redundant `graph_run` (no node_id) must NOT rebuild a fresh engine. The
    // rebuild path below would create a new per-instance `_terminationCtx`
    // (engine-advance.ts) and a fresh graph-terminal notifier with a clean
    // dedupe epoch (graph-notify.ts `notified` Set), so every redundant re-run
    // re-fires `[GRAPH COMPLETE]`. Instead, return the current status (phase
    // Complete with empty active/pending) without rebuilding or re-dispatching.
    // Targeted retry (node_id + retry/modify_prompt) is exempt — it must
    // re-dispatch and fire exactly one new COMPLETE (verified in
    // terminal-notification-reopen.test.ts). The mid-flight guard above already
    // covers the Executing case.
    const hasUnsettledNode = [...liveStatus.nodes.values()].some(
      (n) =>
        GRAPH_RUN_ACTIVE_STATUSES.has(n.status) || n.status === NodeStatus.Pending,
    );
    const isCompletedIdle =
      liveStatus.phase === EnginePhase.Complete && !hasUnsettledNode;
    if (isCompletedIdle && !args.node_id) {
      // Update the sticky session id even on an idempotent completed re-run so
      // the stored value stays current for any later rebuild.
      this.registry.set(args.graph_id, {
        ...entry,
        ...(invokingSessionId ? { invokingSessionId } : {}),
        ...(agent ? { agent: agentId } : {}),
      });
      return {
        graph_id: args.graph_id,
        phase: liveStatus.phase,
        active_nodes: [],
        pending_nodes: [],
      };
    }

    // Subtask 3: wire the configured graph-notify completion seam into the
    // runtime graph_run builds (absent → the engine's default no-op seam).
    // `sessionId` (the graph-captured / invoking execution session) is forwarded
    // so the emperor-session resolver can target the orchestrator at runtime.

    // Subtask 3 (execution-mode validation): the graph is about to be built
    // into a fresh engine and run — re-validate under execution severity. A
    // declaration can be construction-valid (an uncontained cycle is only a
    // construct-mode WARNING) yet un-runnable: an uncontained revise-free
    // cycle can never activate, so graph_run must refuse it here instead of
    // deadlock-escalating at runtime with 'graph deadlock: no active upstream
    // can satisfy pending node(s)'. Skipped on the mid-flight / completed-idle
    // short-circuit paths above — those graphs already passed this gate on
    // their first run.
    const validation = validateGraphDeclaration(entry.declaration, {
      mode: "execution",
    });
    if (!validation.valid) {
      throw new Error(
        `graph "${args.graph_id}" failed execution validation:\n` +
          validation.errors.map((e) => `  - ${e}`).join("\n"),
      );
    }

    const completion = this.completionHandler(args.graph_id, sessionId, agentId);
    const terminal = this.terminalHandler(args.graph_id, sessionId, agentId);
    const stall = this.stallHandler(args.graph_id, sessionId, agentId);
    const runtime = createEngine(entry.declaration, {
      manager: this.deps.manager,
      graphId: args.graph_id,
      parentContext: this.parentContext(args.graph_id),
      stateDir: this.deps.stateDir,
      // F2: enable the stale-node watcher + stale-lock sweeper on the
      // production graph_run runtime (the primary execution path). The
      // staleness watcher is the secondary backstop for a hung graph — the
      // per-node `budget.timeout_ms` (if declared) overrides this deadline.
      nodeStaleTimeoutMs:
        this.deps.nodeStaleTimeoutMs ?? DEFAULT_NODE_STALE_TIMEOUT_MS,
      sweeperIntervalMs: this.deps.sweeperIntervalMs ?? DEFAULT_SWEEPER_INTERVAL_MS,
      ...(this.deps.dispatch ? { dispatch: this.deps.dispatch } : {}),
      ...(completion ? { onNodeCompletion: completion } : {}),
      ...(terminal ? { onGraphTerminal: terminal } : {}),
      ...(stall ? { onNodeStall: stall } : {}),
      // Graph monitoring: durable write-side event log when a stateDir is set.
      ...(this.deps.stateDir
        ? { graphEvents: new GraphEventRecorder(this.deps.stateDir) }
        : {}),
      // Subtask 6: thread the optional liveness-monitor stall thresholds + the
      // node-liveness feed into the production graph_run runtime (the primary
      // execution path — absent → the engine's defaults / unchanged behavior).
      ...(this.deps.nodeStallWarnMs !== undefined
        ? { nodeStallWarnMs: this.deps.nodeStallWarnMs }
        : {}),
      ...(this.deps.nodeStallGraceMs !== undefined
        ? { nodeStallGraceMs: this.deps.nodeStallGraceMs }
        : {}),
      ...(this.deps.livenessFeed !== undefined
        ? { livenessFeed: this.deps.livenessFeed }
        : {}),
    });

    // Subtask 3 (failure atomicity): the adopt/retry/run block is the ONLY place
    // a fresh engine can fail mid-flight (a throwing dispatch seam, an adoptPrior
    // rejection, a retryNode failure). A throw here used to skip
    // `entry.runtime.dispose?.()` + `registry.set(...)` below — leaking the
    // partially-dispatched NEW engine (its registered `onTaskTerminated` dispatch
    // listeners and wired completion/terminal notifiers keep firing ghost
    // [GRAPH NODE COMPLETED] / [GRAPH COMPLETE] reminders for the failed run)
    // while the registry kept the stale OLD runtime. The catch disposes the new
    // runtime (its dispatch listeners unregistered via the M4 dispose path), the
    // prior registry entry is left untouched (a retry re-dispatches from a
    // consistent state), and the actionable error is rethrown. Invariants: no
    // node is dispatched twice within a run, and no ghost terminal notification
    // fires for a failed run.
    let retryReport: Awaited<ReturnType<EngineRuntime["retryNode"]>> | undefined;
    try {
      // Idempotent re-run: adopt the prior runtime's per-node progress into the
      // fresh engine BEFORE dispatching. Without this, a second `graph_run` on
      // the same graph (a common pattern when a model runs each node with its
      // own graph_run call) rebuilds every node as `ready`/`pending` and
      // re-dispatches nodes that already completed or are still running.
      const priorState = entry.runtime.status();
      const priorHasProgress = [...priorState.nodes.values()].some(
        (n) => n.status !== NodeStatus.Pending && n.status !== NodeStatus.Ready,
      );
      // BUG 3b (retry completion race): on the retry path, adopt prior state
      // WITHOUT replaying answers. adoptPrior's answer replay re-emits an
      // adopted Completed node's `answer` through the full advancement critical
      // section, which runs `_checkTermination()` while the retry target is
      // still `Completed` (resetNodeForRetry has not run yet) — firing a
      // premature `[GRAPH COMPLETE]` before `retryNode` re-opens the node. The
      // subsequent `retryNode` call is the sole dispatch + termination authority
      // on the retry path, so answer replay is both unnecessary and harmful
      // here. The non-retry path keeps `replayAnswers: true` unchanged.
      const isRetry = Boolean(args.node_id && (args.retry || args.modify_prompt));
      if (priorHasProgress || priorState.phase !== EnginePhase.Idle) {
        await runtime.adoptPrior(priorState, { replayAnswers: !isRetry });
      }

      // Node retry (tool-merge-map.md §2.2 `graph_run`): when `node_id` is
      // supplied with `retry:true` or `modify_prompt`, re-open and re-dispatch
      // that node on the just-run runtime instead of reporting it as pending.
      // This backs the design's `dispatch_retry` replacement (MERGE row 4).
      //
      // B1 (ordering bug fix): skip `runtime.run()` on the retry path. After
      // `adoptPrior` loads previously-terminal nodes, `run()` sees a quiescent
      // graph, fires a premature COMPLETE notification, then `retryNode`
      // re-opens the phase to `executing` — the stale notification lands after
      // the retry is already running. `adoptPrior(replayAnswers)` already
      // dispatches nodes made ready by answer replay, and `retryNode` handles
      // the retry target's dispatch + termination check, so nothing is left
      // undispatched by skipping `run()`.
      if (args.node_id && (args.retry || args.modify_prompt)) {
        retryReport = await runtime.retryNode(args.node_id, {
          modifyPrompt: args.modify_prompt,
        });
      } else {
        await runtime.run();
      }
    } catch (err) {
      // Failure atomicity: the new engine never reaches the registry. Dispose
      // it now so its registered dispatch listeners are unregistered (no ghost
      // completion can fire for the failed run); the prior registry entry is
      // left untouched and remains the consistent runtime for any retry.
      runtime.dispose();
      throw err;
    }

    // Update the registry runtime so subsequent graph_status reads live state,
    // and persist the sticky session id when graph_run carried a fresh one.
    // Monitor M4: dispose the PRIOR runtime first so its orphaned
    // `onTaskTerminated` dispatch listeners are unregistered before the new
    // engine takes over the registry slot — a disposed runtime never receives
    // (or leaks) stale dispatch→signal callbacks.
    entry.runtime.dispose?.();
    this.registry.set(args.graph_id, {
      ...entry,
      runtime,
      ...(invokingSessionId ? { invokingSessionId } : {}),
      ...(agent ? { agent: agentId } : {}),
    });

    const state = runtime.status();
    const active: string[] = [];
    const pending: string[] = [];
    for (const n of state.nodes.values()) {
      if (GRAPH_RUN_ACTIVE_STATUSES.has(n.status)) {
        active.push(n.nodeId);
      } else if (n.status === NodeStatus.Pending) {
        pending.push(n.nodeId);
      }
    }

    return {
      graph_id: args.graph_id,
      phase: state.phase,
      active_nodes: active,
      pending_nodes: pending,
      ...(retryReport
        ? {
            retry: {
              node_id: retryReport.target,
              re_dispatched: retryReport.reDispatched,
              reset: retryReport.reset,
            },
          }
        : {}),
    };
  }

  // ── Session-level in-flight query ───────────────────────────────────────────

  /**
   * Whether the given session owns at least one graph whose engine is genuinely
   * mid-flight: phase `executing` AND at least one node `ready` or `running`.
   *
   * `Blocked` nodes are deliberately EXCLUDED (hence the dedicated
   * {@link GRAPH_INFLIGHT_NODE_STATUSES} predicate rather than reusing
   * `GRAPH_RUN_ACTIVE_STATUSES`, which includes `Blocked`) — a `needs_approval`
   * gate is a legitimate pause awaiting the human, so an auto-continue must
   * freeze through the existing gated (approval) path instead of treating the
   * graph as inflight work to contend with. A graph whose phase is `idle` (never
   * run / finished) or whose executing engine has no unsettled node does NOT
   * count. Absent invoking-session match, or no graphs at all → `false`.
   */
  hasInflightGraphsForSession(sessionID: string): boolean {
    for (const entry of this.registry.values()) {
      if (entry.invokingSessionId !== sessionID) continue;
      const liveStatus = entry.runtime.status();
      if (liveStatus.phase !== EnginePhase.Executing) continue;
      for (const n of liveStatus.nodes.values()) {
        if (GRAPH_INFLIGHT_NODE_STATUSES.has(n.status)) return true;
      }
    }
    return false;
  }

  // ── Session-level liveness resolution (subtask 6) ──────────────────────────

  /**
   * Resolve the engine runtime + node owning a live dispatch session (subtask
   * 6 — the Pi liveness wiring's `sessionId → nodeId` resolution). Iterates
   * every registry runtime's engine-level reverse index
   * (`EngineRuntime.getNodeIdForSession` — populated at launch when a liveness
   * feed is wired onto the engine, dropped on the node's terminal transition).
   * Returns `undefined` when no registry runtime owns the session (unknown
   * session, detached terminal node, or an engine built without a liveness
   * feed) — the wiring then no-ops. Total: a misbehaving runtime is logged and
   * skipped, never thrown.
   */
  resolveSessionOwner(
    sessionId: string,
  ): { graphId: string; runtime: EngineRuntime; nodeId: string } | undefined {
    for (const [graphId, entry] of this.registry) {
      try {
        const nodeId = entry.runtime.getNodeIdForSession?.(sessionId);
        if (nodeId) return { graphId, runtime: entry.runtime, nodeId };
      } catch (err) {
        log.warn(
          `graph-tools: getNodeIdForSession threw for graph "${graphId}" (session "${sessionId}") — skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return undefined;
  }

  // ── Live registry snapshot (monitor S10) ───────────────────────────────────

  /**
   * Snapshot every live runtime in this toolset's in-memory graph registry as
   * an {@link EngineState}, in registry order (graph_create order).
   *
   * This is the monitor's live-state surface: on platforms where engine state
   * is never persisted to disk (opencode — see the platform contract in
   * `src/core/services/tool-service.ts`), `readLiveEngineGraphs`
   * (`src/cli/commands/monitor/monitor-reader-engine.ts`) projects these
   * runtimes instead of scanning `engine-*.json`. Statuses come from
   * {@link EngineRuntime.status()}, so each returned state is a deep-enough
   * clone — mutating it cannot corrupt the live engine. Returns an empty array
   * when the registry holds no graphs.
   */
  liveEngineStates(): EngineState[] {
    const states: EngineState[] = [];
    for (const [, entry] of this.registry) {
      states.push(entry.runtime.status());
    }
    return states;
  }

  // ── graph_status ───────────────────────────────────────────────────────────

  graph_status(args: GraphStatusArgs): string {
    const scope: GraphStatusScope = args.scope ?? "session";
    const noTarget = !args.graph_id && !args.node_id && !args.loop_id;

    // ── Pending-approvals view (first-class "awaiting human" surface) ─────────
    // A distinct view mode that resolves the blocked+needsApproval nodes across
    // the requested scope. Runs before every other branch so it composes with
    // any scope (session / persisted / all) and an optional graph_id filter.
    if (args.pending_approvals === true) {
      return this.renderPendingApprovals(args, scope);
    }

    // ── Cross-session views (scope persisted/all) ─────────────────────────────
    // Merge the scanned persisted EngineStates (subtask 3) into the render/query
    // pipeline: the no-target list shows persisted graphs, and a filter/group_by/
    // include_budget view aggregates across sessions. Session scope is untouched.
    if (scope !== "session") {
      if (noTarget) {
        // A filter/group/budget view without a target = a cross-session aggregate.
        if (this.crossSessionViewRequested(args)) {
          return this.renderCrossSession(args, scope);
        }
        return this.renderScopedGraphList(scope);
      }
      // Targeted (graph_id / node_id / loop_id) — resolve across registry + store.
      return this.renderScopedTarget(args, scope);
    }

    // ── Session scope: the existing byte-identical pipeline ───────────────────
    if (noTarget) {
      // No target: list the whole registry.
      if (this.registry.size === 0) {
        return "No graphs exist. Call graph_create to open a graph registry slot.";
      }
      const lines = [...this.registry.entries()].map(([id, entry]) => {
        const s = entry.runtime.status();
        return `  ${id}\t[phase: ${s.phase}]\t${s.nodes.size} nodes`;
      });
      return `Graphs (${this.registry.size}):\n${lines.join("\n")}`;
    }

    // Resolve the owning graph. Prefer an explicit graph_id; otherwise search
    // the registry for the graph that contains the requested node / loop.
    const graphId = args.graph_id
      ? args.graph_id
      : this.resolveOwningGraph(args.node_id, args.loop_id);
    const entry = this.getEntry(graphId);

    // export_path: mode-dependent export to the target path (see exportForState).
    if (args.export_path) {
      return this.exportForState(entry.runtime.status(), entry.declaration, args);
    }

    const state = entry.runtime.status();

    if (args.loop_id) {
      return this.renderLoop(state, args.loop_id, args);
    }
    if (args.node_id) {
      return this.renderNode(state, args.node_id, args);
    }

    // Filter/query surface (query / status / agent / from_date / to_date). Built
    // via the pure `status-queries.ts` module: an honest subset of the node set,
    // never fabricated rows. `undefined` when no filter is active.
    const nodeFilter: Set<string> | undefined = this.buildNodeFilter(state, args);
    return this.renderGraph(state, args, nodeFilter);
  }

  // ── Cross-session (persisted/all) helpers ─────────────────────────────────

  /** Scan the on-disk engine-state store under `stateDir` (default cwd). */
  private persistedScan(): PersistedStateScan {
    return scanPersistedStates(this.deps.stateDir ?? process.cwd());
  }

  /** True when a filter/group_by/include_budget view is active (drives the
   * cross-session aggregate rather than the plain graph list). */
  private crossSessionViewRequested(args: GraphStatusArgs): boolean {
    return (
      args.query !== undefined ||
      args.status !== undefined ||
      args.agent !== undefined ||
      args.from_date !== undefined ||
      args.to_date !== undefined ||
      args.group_by !== undefined ||
      args.include_budget === true
    );
  }

  /** Registry states followed by persisted states, deduped by graphId (registry
   * wins) — the node set the `all` scope aggregates over. */
  private collectAllStates(): EngineState[] {
    const seen = new Set<string>();
    const out: EngineState[] = [];
    for (const [, entry] of this.registry) {
      const s = entry.runtime.status();
      if (!seen.has(s.graphId)) {
        seen.add(s.graphId);
        out.push(s);
      }
    }
    for (const p of this.persistedScan().loaded) {
      if (!seen.has(p.graphId)) {
        seen.add(p.graphId);
        out.push(p);
      }
    }
    return out;
  }

  /** The in-memory registry states, in registry order (graph_create order). */
  private registryStates(): EngineState[] {
    const out: EngineState[] = [];
    for (const [, entry] of this.registry) out.push(entry.runtime.status());
    return out;
  }

  /**
   * Pending-approvals render: enumerate every `blocked` `needs_approval` node
   * across the resolved scope (registry for `session`; persisted for
   * `persisted`; merged for `all`, deduped registry-wins) via the pure
   * `status-queries.ts` {@link listPendingApprovals} helper. An optional
   * `graph_id` narrows the scan to a single graph. Every row carries the owning
   * graph, blocked-since timestamp, a truncated approval_payload summary, and a
   * paste-ready `graph_approve` call — all sourced from REAL recorded state,
   * never fabricated. An empty result yields an honest note.
   */
  private renderPendingApprovals(args: GraphStatusArgs, scope: GraphStatusScope): string {
    const scan = this.persistedScan();
    let states: EngineState[];
    if (scope === "persisted") {
      states = scan.loaded;
    } else if (scope === "all") {
      states = this.collectAllStates();
    } else {
      states = this.registryStates();
    }
    if (args.graph_id) {
      states = states.filter((s) => s.graphId === args.graph_id);
    }

    const entries = listPendingApprovals(states);
    const scopedArgs: GraphStatusArgs = { ...args };

    if (args.format === "json") {
      return this.paginate(
        JSON.stringify(
          {
            scope,
            pending_approvals: entries.map((e) => ({
              graph_id: e.graphId,
              node_id: e.nodeId,
              agent: e.agent,
              ...(e.blockedSince !== undefined ? { blocked_since: e.blockedSince } : {}),
              ...(e.approvalPayloadSummary !== undefined
                ? { approval_payload_summary: e.approvalPayloadSummary }
                : {}),
              approve_call: e.approveCall,
            })),
            count: entries.length,
          },
          null,
          2,
        ),
        scopedArgs,
      );
    }

    if (entries.length === 0) {
      // Honest empty state: distinguishes a genuinely empty store.
      if (scope === "persisted" && scan.count === 0) {
        return (
          `No pending approvals.\n\n` + this.persistedEmptyNote(scan)
        );
      }
      return `Pending approvals (0)  [scope: ${scope}]\n  no pending approvals`;
    }

    const lines: string[] = [`Pending approvals (${entries.length})  [scope: ${scope}]`];
    for (const e of entries) {
      const since = e.blockedSince !== undefined ? new Date(e.blockedSince).toISOString() : "—";
      lines.push(`  ${e.nodeId}  (graph: ${e.graphId})`);
      lines.push(`    agent: ${e.agent}`);
      lines.push(`    blocked-since: ${since}`);
      lines.push(`    approve: ${e.approveCall}`);
      if (e.approvalPayloadSummary !== undefined) {
        lines.push(`    payload: ${e.approvalPayloadSummary}`);
      }
    }
    return this.paginate(lines.join("\n"), scopedArgs);
  }

  /** Honest-empty note for a persisted store that yielded no hydrated graph. */
  private persistedEmptyNote(scan: PersistedStateScan): string {
    if (scan.count === 0) {
      return (
        `No persisted graphs found under ${scan.stateDirectory}. Run a graph to a ` +
        `persisted checkpoint to enable cross-session (scope=persisted) queries.`
      );
    }
    // Files present but none hydrated — corrupt / version-mismatched reads.
    return (
      `Persisted graphs: none hydrated — ${scan.skipped} file(s) skipped ` +
      `(${scan.skippedFiles.join(", ")}).`
    );
  }

  /** No-target list for persisted/all scope: persisted graphs are shown, and an
   * empty store yields an explicit honest-empty note. */
  private renderScopedGraphList(scope: GraphStatusScope): string {
    const scan = this.persistedScan();
    const states = scope === "persisted" ? scan.loaded : this.collectAllStates();
    if (states.length === 0) {
      if (scope === "persisted") return this.persistedEmptyNote(scan);
      return "No graphs exist. Call graph_create to open a graph registry slot.";
    }
    const lines = states.map((s) => `  ${s.graphId}\t[phase: ${s.phase}]\t${s.nodes.size} nodes`);
    const header =
      scope === "persisted" ? `Persisted graphs (${states.length}):` : `Graphs (${states.length}):`;
    return `${header}\n${lines.join("\n")}`;
  }

  /**
   * Cross-session aggregate render (scope persisted/all, no target, with a
   * filter / group_by / include_budget view active). Every node row carries its
   * owning graph so cross-graph identity stays unambiguous. All data reads REAL
   * recorded state (registry or persisted) — never fabricated rows.
   */
  private renderCrossSession(args: GraphStatusArgs, scope: GraphStatusScope): string {
    const scan = this.persistedScan();
    const states = scope === "persisted" ? scan.loaded : this.collectAllStates();

    if (states.length === 0) {
      if (scope === "persisted") return this.persistedEmptyNote(scan);
      return "No graphs exist. Call graph_create to open a graph registry slot.";
    }

    const query: StatusQuery = {
      query: args.query,
      status: args.status,
      agent: args.agent,
      from_date: args.from_date,
      to_date: args.to_date,
    };
    const hasFilter =
      query.query !== undefined ||
      query.status !== undefined ||
      query.agent !== undefined ||
      query.from_date !== undefined ||
      query.to_date !== undefined;

    if (args.group_by) {
      return this.renderCrossSessionGroups(states, args, query, hasFilter);
    }

    // Cross-session node rows: filter each graph's nodes, tagged with their graph.
    const rows: Array<{ graphId: string; node: NodeRuntimeState }> = [];
    for (const s of states) {
      const matched = hasFilter ? filterNodes(s.nodes, query) : [...s.nodes.values()];
      for (const n of matched) rows.push({ graphId: s.graphId, node: n });
    }

    const budget = args.include_budget ? this.crossSessionBudget(states) : undefined;
    const capped = args.limit && args.limit > 0 ? rows.slice(0, args.limit) : rows;

    if (args.format === "json") {
      return this.paginate(
        JSON.stringify(
          {
            scope,
            graphs: states.map((s) => ({
              graph_id: s.graphId,
              phase: s.phase,
              node_count: s.nodes.size,
            })),
            nodes: capped.map((r) => ({
              graph_id: r.graphId,
              node_id: r.node.nodeId,
              status: r.node.status,
              agent: r.node.agent,
              ...(r.node.dispatchSessionId
                ? { dispatch_session_id: r.node.dispatchSessionId }
                : {}),
              ...(r.node.dispatchTaskId
                ? { dispatch_task_id: r.node.dispatchTaskId }
                : {}),
            })),
            budget,
          },
          null,
          2,
        ),
        args,
      );
    }

    const lines: string[] = [`Graphs (${states.length})  [scope: ${scope}]`];
    lines.push("  NODE                  GRAPH                STATUS      AGENT");
    for (const r of capped) {
      lines.push(
        `  ${r.node.nodeId.padEnd(20)} ${r.graphId.padEnd(20)} ` +
          `${r.node.status.padEnd(11)} ${r.node.agent}`,
      );
    }
    if (budget) {
      lines.push("");
      lines.push(
        `  Budget (${states.length} graphs) — sessions: ${budget.sessionsSpawned}, ` +
          `tokens: ${budget.totalInputTokens}/${budget.totalOutputTokens}, ` +
          `cost: ${budget.totalCost.toFixed(4)}`,
      );
    }
    return this.paginate(lines.join("\n"), args);
  }

  /** `group_by` buckets across sessions: completed nodes from every graph in
   * scope are merged into one bucket list keyed by hour/day/agent. */
  private renderCrossSessionGroups(
    states: EngineState[],
    args: GraphStatusArgs,
    query: StatusQuery,
    hasFilter: boolean,
  ): string {
    const mode = args.group_by!;
    const merged = new Map<
      string,
      { count: number; nodes: Array<{ graph_id: string; node_id: string }> }
    >();
    for (const s of states) {
      const nodeMap = hasFilter
        ? new Map(filterNodes(s.nodes, query).map((n) => [n.nodeId, n]))
        : s.nodes;
      for (const b of groupCompletedNodes(nodeMap, mode)) {
        let m = merged.get(b.key);
        if (!m) {
          m = { count: 0, nodes: [] };
          merged.set(b.key, m);
        }
        m.count += b.count;
        for (const nid of b.nodes) m.nodes.push({ graph_id: s.graphId, node_id: nid });
      }
    }
    const buckets = [...merged.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, m]) => ({ key, count: m.count, nodes: m.nodes }));

    if (args.format === "json") {
      return this.paginate(
        JSON.stringify({ scope: args.scope, group_by: mode, graphs: states.length, buckets }, null, 2),
        args,
      );
    }
    const lines: string[] = [
      `Graphs (${states.length})  [grouped by ${mode}, scope: ${args.scope}]`,
    ];
    if (buckets.length === 0) {
      lines.push("  (no completed nodes)");
      return lines.join("\n");
    }
    for (const b of buckets) {
      lines.push(`  ${b.key}: ${b.count} node(s)`);
      for (const n of b.nodes) lines.push(`    ${n.graph_id}::${n.node_id}`);
    }
    return lines.join("\n");
  }

  /** Sum the cumulative budget consumption across the graphs in scope. */
  private crossSessionBudget(states: EngineState[]): GraphBudgetState {
    const total: GraphBudgetState = {
      sessionsSpawned: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    };
    for (const s of states) {
      total.sessionsSpawned += s.budget.sessionsSpawned;
      total.totalInputTokens += s.budget.totalInputTokens;
      total.totalOutputTokens += s.budget.totalOutputTokens;
      total.totalCost += s.budget.totalCost;
    }
    return total;
  }

  /** Resolve a single graph target for persisted/all scope (registry wins for
   * `all`; persisted store only for `persisted`). */
  private resolveState(graphId: string, scope: GraphStatusScope): EngineState {
    if (scope === "all") {
      const entry = this.registry.get(graphId);
      if (entry) return entry.runtime.status();
    }
    const found = this.persistedScan().loaded.find((s) => s.graphId === graphId);
    if (found) return found;
    throw new Error(
      `graph_status: graph "${graphId}" not found in ${scope} scope.`,
    );
  }

  /** Find the graph owning a node/loop across registry + persisted states. */
  private resolveOwningScoped(
    nodeId?: string,
    loopId?: string,
    scope: GraphStatusScope = "session",
  ): string {
    const matches = new Set<string>();
    const consider = (states: EngineState[]): void => {
      for (const s of states) {
        if (nodeId && s.nodes.has(nodeId)) matches.add(s.graphId);
        if (loopId && s.loopGroups.has(loopId)) matches.add(s.graphId);
      }
    };
    if (scope !== "persisted") {
      const registryStates: EngineState[] = [];
      for (const [, e] of this.registry) registryStates.push(e.runtime.status());
      consider(registryStates);
    }
    consider(this.persistedScan().loaded);
    const list = [...matches];
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      throw new Error(
        `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} exists in ` +
          `multiple graphs (${list.join(", ")}); specify graph_id to disambiguate.`,
      );
    }
    throw new Error(
      `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} not found in any graph.`,
    );
  }

  /** Targeted (graph_id/node_id/loop_id) render for persisted/all scope. */
  private renderScopedTarget(args: GraphStatusArgs, scope: GraphStatusScope): string {
    const graphId = args.graph_id
      ? args.graph_id
      : this.resolveOwningScoped(args.node_id, args.loop_id, scope);
    const state = this.resolveState(graphId, scope);
    const scopedArgs: GraphStatusArgs = { ...args, graph_id: graphId };

    if (args.export_path) {
      return this.exportForState(state, state.graphDeclaration, args);
    }
    if (args.loop_id) {
      return this.renderLoop(state, args.loop_id, scopedArgs);
    }
    if (args.node_id) {
      return this.renderNode(state, args.node_id, scopedArgs);
    }
    const nodeFilter = this.buildNodeFilter(state, scopedArgs);
    return this.renderGraph(state, scopedArgs, nodeFilter);
  }


  /**
   * Build the set of node ids matching the active filter/query args, or return
   * `undefined` when no filter is present (the renderer then shows all nodes).
   * The matching is delegated entirely to the pure `status-queries.ts` module.
   */
  private buildNodeFilter(state: EngineState, args: GraphStatusArgs): Set<string> | undefined {
    const query: StatusQuery = {
      query: args.query,
      status: args.status,
      agent: args.agent,
      from_date: args.from_date,
      to_date: args.to_date,
    };
    const hasFilter =
      query.query !== undefined ||
      query.status !== undefined ||
      query.agent !== undefined ||
      query.from_date !== undefined ||
      query.to_date !== undefined;
    if (!hasFilter) return undefined;
    const matched = filterNodes(state.nodes, query);
    return new Set(matched.map((n) => n.nodeId));
  }

  /**
   * Materialize the node set narrowed to `nodeFilter` as a `Map<nodeId, node>`
   * (or the whole state node map when no filter is active). Used by the
   * `group_by` view, which needs a keyed node set rather than an id list.
   */
  private visibleNodeMap(
    state: EngineState,
    nodeFilter?: Set<string>,
  ): ReadonlyMap<string, NodeRuntimeState> {
    if (!nodeFilter) return state.nodes;
    const map = new Map<string, NodeRuntimeState>();
    for (const id of nodeFilter) {
      const node = state.nodes.get(id);
      if (node) map.set(id, node);
    }
    return map;
  }

  // ── graph_cancel ───────────────────────────────────────────────────────────

  async graph_cancel(args: GraphCancelArgs): Promise<GraphCancelResult> {
    const entry = this.getEntry(args.graph_id);

    // No target → whole-graph cancel (existing behavior): every node is retired.
    if (!args.node_id && !args.loop_id) {
      await entry.runtime.cancel();
      const state = entry.runtime.status();
      // After the lifecycle fix, cancelled nodes are transitioned Cancelled→Done;
      // filter by Done status with a cancellation error reason to identify them.
      const cancelled = [...state.nodes.values()]
        .filter((n) => n.status === NodeStatus.Done && n.errorReason?.startsWith("cancelled"))
        .map((n) => n.nodeId)
        .sort();
      return { cancelled, graph_id: args.graph_id };
    }

    // Scoped target → the real scoped / cascade primitive. A loop target is
    // resolved to its member node ids first (an indivisible bounded cycle), then
    // handed to EngineRuntime.cancelNodes. Default cascade: true for a loop
    // target, false for a bare node_id — an explicit args.cascade always wins.
    // The reported set is the ACTUAL cancelled set from the CancelScopeReport,
    // never a post-hoc filter of a whole-graph teardown.
    const state = entry.runtime.status();
    const targetIds = args.loop_id
      ? this.loopNodeIds(state, args.loop_id)
      : [args.node_id as string];
    const cascade = args.cascade ?? args.loop_id !== undefined;
    const report = entry.runtime.cancelNodes(targetIds, { cascade });

    return { cancelled: report.cancelled.sort(), graph_id: args.graph_id };
  }

  // ── graph_approve / graph_reject ───────────────────────────────────────────

  /**
   * Resolve a blocked `needs_approval` node with a human decision.
   *
   * This is the parent-facing HITL surface that Phase C migrates
   * `dispatch_approve` / `dispatch_reject` onto (GAP-2). It routes import-only
   * to the engine's public `approveNode` / `rejectNode` on the registry's live
   * runtime — the same runtime `graph_run` left paused at the blocked node.
   *
   * `approve` completes the gate and runs the forward `answer` data flow;
   * `reject` re-enters the node (loop-group member) or escalates it (no loop),
   * per the engine's `rejectNode` semantics. Idempotent by engine guard: a
   * decision on an already-resolved node is a no-op reported as-is.
   *
   * No new engine logic here — this is a thin routing surface over the public
   * {@link EngineRuntime} API (protected engine files are untouched).
   */
  async graph_approve(args: GraphApproveArgs): Promise<GraphApproveResult> {
    const entry = await this.resolveApprovalEntry(args.graph_id, args.node_id);
    const runtime = entry.runtime;

    if (args.action === "approve") {
      await runtime.approveNode(args.node_id, args.payload);
    } else {
      await runtime.rejectNode(args.node_id, args.reason);
    }

    // Read live state after the decision advanced the graph.
    const state = runtime.status();
    const node = state.nodes.get(args.node_id);
    return {
      graph_id: args.graph_id,
      node_id: args.node_id,
      action: args.action,
      node_status: node ? node.status : "unknown",
      phase: state.phase,
    };
  }

  // ── Status renderers ───────────────────────────────────────────────────────

  private renderGraph(
    state: EngineState,
    args: GraphStatusArgs,
    nodeFilter?: Set<string>,
  ): string {
    const visibleNodes = (): NodeRuntimeState[] =>
      nodeFilter
        ? [...nodeFilter].map((id) => state.nodes.get(id)).filter(
            (n): n is NodeRuntimeState => n !== undefined,
          )
        : [...state.nodes.values()];
    // `group_by` is a distinct view mode: bucket completed nodes and return the
    // bucket list (it takes precedence over the row render, regardless of format).
    if (args.group_by) {
      return this.appendFlagSections(
        this.renderGroups(state, args, nodeFilter),
        state,
        args,
      );
    }
    switch (args.format ?? "summary") {
      case "json": {
        // F6 observability: when the graph's durable event log carries
        // `notification_degraded` markers, surface them on the snapshot. The
        // conditional spread keeps the output byte-identical otherwise.
        const degradedStatuses = this.notificationDegradedStatuses(state.graphId);
        const snapshot = {
          graph_id: state.graphId,
          phase: state.phase,
          nodes: limitNodes(visibleNodes(), args.limit).map((n) =>
            this.nodeSummary(state, n, args),
          ),
          budget: args.include_budget ? this.budgetSummary(state) : undefined,
          loops: args.include_loops
            ? [...state.loopGroups.values()].map((l) =>
                this.loopSummary(state, l, this.loopNodeIds(state, l.id)),
              )
            : undefined,
          metrics: args.include_metrics ? this.metricsSummary(state) : undefined,
          ...(degradedStatuses.length > 0
            ? {
                notification_degraded: true,
                notification_degraded_statuses: degradedStatuses,
              }
            : {}),
        };
        // C-WIRE: merge structured flag data (round/checkpoint/artifacts/evidence/
        // stream) onto the snapshot. No-op when none are set (byte-identical).
        this.mergeFlagData(snapshot, state, args);
        // Monitor M8/M9: every JSON output flows through paginate so
        // max_chars/offset/tail apply, with an explicit truncation marker when
        // content is dropped (see {@link paginate}).
        return this.paginate(JSON.stringify(snapshot, null, 2), args);
      }
      case "tree":
        return this.appendFlagSections(
          this.renderTree(state, nodeFilter, args.depth),
          state,
          args,
        );
      case "summary":
      default:
        return this.appendFlagSections(
          this.renderSummary(state, args, nodeFilter),
          state,
          args,
        );
    }
  }

  /**
   * The `group_by` view: bucket COMPLETED nodes over their `completedAt` (hour /
   * day / agent) and return the bucket list with counts. Delegated to the pure
   * `status-queries.ts` `groupCompletedNodes` — uncompleted nodes are excluded
   * honestly, never invented into a bucket.
   */
  private renderGroups(
    state: EngineState,
    args: GraphStatusArgs,
    nodeFilter?: Set<string>,
  ): string {
    const buckets = groupCompletedNodes(this.visibleNodeMap(state, nodeFilter), args.group_by!);
    if (args.format === "json") {
      return this.paginate(
        JSON.stringify(
          {
            group_by: args.group_by,
            graph_id: state.graphId,
            buckets: buckets.map((b) => ({ key: b.key, count: b.count, nodes: b.nodes })),
          },
          null,
          2,
        ),
        args,
      );
    }
    const lines: string[] = [];
    lines.push(`Graph "${state.graphId}"  [grouped by ${args.group_by}]`);
    if (buckets.length === 0) {
      lines.push("  (no completed nodes)");
      return lines.join("\n");
    }
    for (const b of buckets) {
      lines.push(`  ${b.key}: ${b.count} node(s)`);
      lines.push(`    ${b.nodes.join(", ")}`);
    }
    return lines.join("\n");
  }

  private renderSummary(
    state: EngineState,
    args: GraphStatusArgs,
    nodeFilter?: Set<string>,
  ): string {
    const nodes = nodeFilter
      ? [...nodeFilter].map((id) => state.nodes.get(id)).filter(
          (n): n is NodeRuntimeState => n !== undefined,
        )
      : [...state.nodes.values()];
    const lines: string[] = [];
    lines.push(`Graph "${state.graphId}"  [phase: ${state.phase}]`);
    lines.push("  NODE                  STATUS      AGENT");
    for (const n of limitNodes(nodes, args.limit)) {
      // Liveness (subtask 7 display): stall marker on the row ONLY for RUNNING
      // nodes that have a recorded stallStatus. Non-running nodes and nodes
      // without recorded liveness keep the row byte-identical to legacy output.
      const stall =
        n.status === NodeStatus.Running && n.liveness?.stallStatus
          ? `  [stall: ${n.liveness.stallStatus}]`
          : "";
      lines.push(
        `  ${n.nodeId.padEnd(20)} ${n.status.padEnd(11)} ${n.agent}${stall}`,
      );
    }
    if (args.include_budget) {
      lines.push("");
      lines.push(`  Budget — sessions: ${state.budget.sessionsSpawned}, ` +
        `tokens: ${state.budget.totalInputTokens}/${state.budget.totalOutputTokens}, ` +
        `cost: ${state.budget.totalCost.toFixed(4)}`);
    }
    if (args.include_loops && state.loopGroups.size > 0) {
      lines.push("");
      lines.push("  Loops:");
      for (const l of state.loopGroups.values()) {
        const mode = this.loopDeclMode(state, l.id);
        lines.push(
          `    ${l.id}  [${l.traversalCount}/${l.maxTraversals}]` +
            `${mode !== undefined ? `  mode=${mode}` : ""}` +
            `  nodes: ${this.loopNodeIds(state, l.id).join(", ")}`,
        );
      }
    }
    if (args.include_metrics) {
      lines.push("");
      lines.push(`  Metrics — ${this.metricsSummary(state)}`);
    }
    // F6 observability: append an explicit hint when the graph's durable event
    // log records a degraded notification seam (no emperor session resolved).
    // Absent stateDir / log file / marker → nothing is appended (byte-compat).
    const degradedStatuses = this.notificationDegradedStatuses(state.graphId);
    if (degradedStatuses.length > 0) {
      lines.push("");
      for (const status of degradedStatuses) {
        lines.push(
          `  ⚠ notification degraded: ${status} notification could not reach the orchestrator (no emperor session resolved)`,
        );
      }
    }
    return this.paginate(lines.join("\n"), args);
  }

  private renderNode(state: EngineState, nodeId: string, args: GraphStatusArgs): string {
    const node = state.nodes.get(nodeId);
    if (!node) {
      throw new Error(`graph_status: unknown node "${nodeId}" in graph "${state.graphId}".`);
    }
    if (args.format === "json") {
      // JSON node view (monitor M8): serialize the shared nodeSummary — which
      // honors include_output by adding an `output` field with the node's
      // materialized result text — and merge node-scoped C-WIRE observability
      // data (checkpoints / artifacts / evidence / signal stream), mirroring the
      // text render's appendFlagSections scoping. Paginated like every other
      // JSON output so max_chars/offset/tail apply.
      const summary = this.nodeSummary(state, node, args);
      this.mergeFlagData(summary, state, { ...args, node_id: nodeId });
      return this.paginate(JSON.stringify(summary, null, 2), args);
    }
    const lines: string[] = [];
    lines.push(`Node "${nodeId}"`);
    lines.push(`  status: ${node.status}`);
    lines.push(`  agent: ${node.agent}`);
    lines.push(`  needs_approval: ${node.needsApproval}`);
    lines.push(`  loop_group: ${node.loopGroupId ?? "-"}`);
    lines.push(`  traversal_count: ${node.traversalCount}`);
    lines.push(`  retry_count: ${node.retryCount}`);
    if (node.dispatchSessionId) lines.push(`  dispatch_session_id: ${node.dispatchSessionId}`);
    if (node.dispatchTaskId) lines.push(`  dispatch_task_id: ${node.dispatchTaskId}`);
    if (node.errorReason) lines.push(`  error: ${node.errorReason}`);
    if (args.include_progress) {
      const prog = this.progressForNode(state, node);
      if (prog.recorded) {
        const stamp = prog.lastSignalAt
          ? `  (last_signal_at: ${new Date(prog.lastSignalAt).toISOString()})`
          : "";
        lines.push(`  progress: ${JSON.stringify(prog.payload)}${stamp}`);
      } else {
        lines.push("  progress: none recorded");
      }
    }
    if (args.include_budget) {
      lines.push(`  budget — sessions: ${node.sessionsSpawned}, tokens: ` +
        `${node.tokensConsumed.inputTokens}/${node.tokensConsumed.outputTokens}, ` +
        `cost: ${node.tokensConsumed.cost.toFixed(4)}`);
    }
    if (args.include_output && node.result) {
      lines.push("  output:");
      lines.push(this.paginate(GraphToolSet.resultText(node.result), args).replace(/^/gm, "    "));
    }
    // Liveness (subtask 7 display): running nodes ALWAYS show their recorded
    // liveness; non-running nodes only when include_liveness is set. Nodes with
    // NO recorded liveness get NO block at all (honest-empty — never a
    // placeholder). Sub-lines are emitted only for fields actually present.
    if (node.liveness && (node.status === NodeStatus.Running || args.include_liveness)) {
      lines.push("  liveness:");
      if (node.liveness.lastActivityAt !== undefined) {
        lines.push(`    last_activity: ${new Date(node.liveness.lastActivityAt).toISOString()}`);
        lines.push(`    idle_ms: ${Date.now() - node.liveness.lastActivityAt}`);
      }
      if (node.liveness.heartbeatSource) {
        lines.push(`    heartbeat_source: ${node.liveness.heartbeatSource}`);
      }
      if (node.liveness.stallStatus) {
        lines.push(`    stall_status: ${node.liveness.stallStatus}`);
      }
    }
    // C-WIRE: append the node-scoped observability sections (checkpoints /
    // artifacts / evidence / signal stream). `include_history` / `round` in a
    // node view resolve to the node's own loop group rounds when no explicit
    // loop_id was given. No-ops unless a C-WIRE flag is set (byte-identical).
    const scoped: GraphStatusArgs = { ...args, node_id: nodeId };
    if (
      (args.include_history || args.round !== undefined) &&
      args.loop_id === undefined
    ) {
      scoped.loop_id = node.loopGroupId;
    }
    return this.appendFlagSections(lines.join("\n"), state, scoped);
  }

  private renderLoop(state: EngineState, loopId: string, args: GraphStatusArgs): string {
    const loop = state.loopGroups.get(loopId);
    if (!loop) {
      throw new Error(`graph_status: unknown loop group "${loopId}" in graph "${state.graphId}".`);
    }
    if (args.format === "json") {
      const summary = this.loopSummary(state, loop, this.loopNodeIds(state, loopId));
      // C-WIRE: merge loop-scoped round history into the loop JSON when asked.
      this.mergeFlagData(summary, state, { ...args, loop_id: loopId });
      return this.paginate(JSON.stringify(summary, null, 2), args);
    }
    const lines: string[] = [];
    lines.push(`Loop "${loopId}"`);
    lines.push(`  traversals: ${loop.traversalCount}/${loop.maxTraversals}`);
    lines.push(`  nodes: ${this.loopNodeIds(state, loopId).join(", ")}`);
    // Loop mode surfaced only when explicitly declared (default render stays
    // byte-identical). 'inherit' documents that rounds re-dispatch within the
    // same engine state (no per-round session isolation).
    const mode = this.loopDeclMode(state, loopId);
    if (mode === "inherit") {
      lines.push(`  mode: inherit  (rounds re-dispatch within the same engine state)`);
    }
    if (loop.consecutiveStale) {
      lines.push(`  consecutive_stale: ${loop.consecutiveStale}`);
    }
    for (const nodeId of this.loopNodeIds(state, loopId)) {
      const node = state.nodes.get(nodeId);
      if (node) {
        lines.push(`    ${nodeId.padEnd(18)} ${node.status}`);
      }
    }
    return this.appendFlagSections(lines.join("\n"), state, { ...args, loop_id: loopId });
  }

  // ── C-WIRE observability flags (subtask 3) ─────────────────────────────────

  /**
   * True when any of the seven C-WIRE observability flags is active. When none
   * are set, `appendFlagSections` / `mergeFlagData` are no-ops and the base
   * render is returned byte-identical to legacy output.
   */
  private flagSectionsActive(args: GraphStatusArgs): boolean {
    return (
      args.include_history ||
      args.round !== undefined ||
      args.include_checkpoint ||
      args.include_artifacts ||
      args.include_evidence ||
      args.stream ||
      args.since !== undefined
    );
  }

  /**
   * Append the honest text sections produced by any active C-WIRE flag onto a
   * base render, separated by a blank line. Returns `base` unchanged when no
   * flag is active. Every section reads REAL recorded data or an explicit
   * honest-empty note — never fabricated rows.
   */
  private appendFlagSections(
    base: string,
    state: EngineState,
    args: GraphStatusArgs,
  ): string {
    if (!this.flagSectionsActive(args)) return base;
    const sections: string[] = [];
    if (args.include_history || args.round !== undefined) {
      sections.push(this.renderRoundHistory(state, args));
    }
    if (args.include_checkpoint) {
      sections.push(this.renderCheckpoints(state, args));
    }
    if (args.include_artifacts || args.include_evidence) {
      sections.push(this.renderArtifactsEvidence(state, args));
    }
    if (args.stream || args.since !== undefined) {
      sections.push(this.renderSignalStream(state, args));
    }
    return [base, ...sections].join("\n\n");
  }

  /**
   * Merge structured C-WIRE flag data onto a JSON snapshot object (json
   * formats). No-op when no flag is active, so the snapshot stays
   * byte-identical otherwise. Data is extracted from the same genuine engine
   * fields as the text renderers.
   */
  private mergeFlagData(
    target: Record<string, unknown>,
    state: EngineState,
    args: GraphStatusArgs,
  ): void {
    if (!this.flagSectionsActive(args)) return;
    if (args.include_history || args.round !== undefined) {
      target.round_history = this.loopRoundEntries(state, args);
    }
    if (args.include_checkpoint) {
      target.checkpoints = this.checkpointEntries(state, args.node_id);
    }
    if (args.include_artifacts || args.include_evidence) {
      target.artifacts_evidence = this.artifactsEvidenceEntries(
        state,
        args,
        args.node_id,
      );
    }
    if (args.stream || args.since !== undefined) {
      target.signal_stream = this.signalStreamEntries(state, args, args.node_id);
    }
  }

  /**
   * Extract the per-loop round history from `LoopGroupRuntimeState.rounds[]`,
   * scoped to one loop (when `args.loop_id`) and optionally filtered to a single
   * `args.round`. Sorted ascending by round index. `rounds` is OPTIONAL-ADDITIVE
   * — absent (or empty) until a round is recorded; never fabricated.
   */
  private loopRoundEntries(
    state: EngineState,
    args: GraphStatusArgs,
  ): Array<{ loop_id: string; rounds: RoundHistoryEntry[]; requested_round?: number }> {
    const groups = args.loop_id
      ? [...state.loopGroups.values()].filter((l) => l.id === args.loop_id)
      : [...state.loopGroups.values()];
    return groups.map((l) => {
      const rounds = [...(l.rounds ?? [])].sort((a, b) => a.round - b.round);
      const filtered =
        args.round !== undefined
          ? rounds.filter((r) => r.round === args.round)
          : rounds;
      return { loop_id: l.id, rounds: filtered, requested_round: args.round };
    });
  }

  /**
   * Extract per-node lifecycle checkpoints from `EngineState.checkpointHistory`
   * (`Record<nodeId, CheckpointRecord[]>` — the ordered, append-only list),
   * scoped to a node when `nodeId` is given. When a node has no recorded history
   * yet, falls back to `EngineState.checkpoints` (`Record<nodeId, CheckpointRecord>`)
   * for backward compat so the latest snapshot still surfaces. Absent until a
   * checkpoint is recorded (subtask 2 / subtask 7).
   */
  private checkpointEntries(
    state: EngineState,
    nodeId?: string,
  ): Array<{ node_id: string; checkpoints: CheckpointRecord[] }> {
    const out: Array<{ node_id: string; checkpoints: CheckpointRecord[] }> = [];
    const ids = new Set([
      ...Object.keys(state.checkpoints ?? {}),
      ...Object.keys(state.checkpointHistory ?? {}),
    ]);
    for (const id of ids) {
      if (nodeId !== undefined && id !== nodeId) continue;
      const history = state.checkpointHistory?.[id];
      // Prefer the ordered history when present; else fall back to the single
      // latest checkpoint (backward compat with the pre-history `checkpoints` record).
      const cps =
        history && history.length > 0
          ? [...history]
          : state.checkpoints?.[id]
            ? [state.checkpoints[id]]
            : [];
      if (cps.length === 0) continue;
      out.push({ node_id: id, checkpoints: cps });
    }
    return out;
  }

  /**
   * Extract per-node artifacts / evidence from `NodeRuntimeState.artifacts[]` /
   * `.evidence[]`, scoped to a node when `nodeId` is given. Nodes with no
   * recorded array for a requested flag are omitted from that entry (honest
   * absence — never invented values).
   */
  private artifactsEvidenceEntries(
    state: EngineState,
    args: GraphStatusArgs,
    nodeId?: string,
  ): Array<{ node_id: string; artifacts?: string[]; evidence?: string[] }> {
    const out: Array<{ node_id: string; artifacts?: string[]; evidence?: string[] }> = [];
    for (const n of state.nodes.values()) {
      if (nodeId !== undefined && n.nodeId !== nodeId) continue;
      const entry: { node_id: string; artifacts?: string[]; evidence?: string[] } = {
        node_id: n.nodeId,
      };
      if (args.include_artifacts && n.artifacts && n.artifacts.length > 0) {
        entry.artifacts = [...n.artifacts];
      }
      if (args.include_evidence && n.evidence && n.evidence.length > 0) {
        entry.evidence = [...n.evidence];
      }
      // Honest omission: a node with no recorded data for any requested flag is
      // not invented into the list (mirrors the text renderer).
      if (entry.artifacts === undefined && entry.evidence === undefined) continue;
      out.push(entry);
    }
    return out;
  }

  /**
   * Extract per-node timestamped signal-event histories from
   * `SignalLedgerEntry.history[]`, scoped to a node when `nodeId` is given.
   * When `args.since` is a valid ISO-8601 timestamp, events strictly before it
   * are filtered out; an INVALID `since` throws (aligned with the
   * from_date/to_date filter surface). Sorted ascending by `atMs`. An
   * absent/empty `history` yields an empty event list — the caller surfaces the
   * honest "no events" note.
   */
  private signalStreamEntries(
    state: EngineState,
    args: GraphStatusArgs,
    nodeId?: string,
  ): Array<{ node_id: string; events: SignalLedgerEvent[] }> {
    // Monitor L2: an invalid `since` THROWS (via the shared toEpochMs, the same
    // throw pattern as from_date/to_date) instead of silently ignoring the bound
    // — a garbage timestamp must never silently broaden a stream.
    const sinceMs = args.since !== undefined ? toEpochMs(args.since) : undefined;
    const out: Array<{ node_id: string; events: SignalLedgerEvent[] }> = [];
    for (const [id, ledger] of state.signalLedger) {
      if (nodeId !== undefined && id !== nodeId) continue;
      const events = [...(ledger.history ?? [])]
        .filter((e) => sinceMs === undefined || e.atMs >= sinceMs)
        .sort((a, b) => a.atMs - b.atMs);
      out.push({ node_id: id, events });
    }
    return out;
  }

  /** Text section: per-loop round history (`include_history` / `round`). */
  private renderRoundHistory(state: EngineState, args: GraphStatusArgs): string {
    const lines = ["## Loop Round History"];
    const entries = this.loopRoundEntries(state, args);
    if (entries.length === 0) {
      lines.push("  no loop rounds recorded");
      return lines.join("\n");
    }
    for (const e of entries) {
      lines.push(`Loop "${e.loop_id}"`);
      if (e.rounds.length === 0) {
        lines.push(
          e.requested_round !== undefined
            ? `  round ${e.requested_round}: not recorded`
            : "  no rounds recorded",
        );
        continue;
      }
      for (const r of e.rounds) {
        const done =
          r.completedAt !== undefined
            ? ` -> ${new Date(r.completedAt).toISOString()}`
            : "";
        lines.push(
          `  round ${r.round}  [traversal ${r.traversalCount}]  status ${r.status}  ` +
            `started ${new Date(r.startedAt).toISOString()}${done}`,
        );
        lines.push(`    nodes: ${r.nodeIds.join(", ")}`);
      }
    }
    return lines.join("\n");
  }

  /** Text section: per-node lifecycle checkpoints (`include_checkpoint`). */
  private renderCheckpoints(state: EngineState, args: GraphStatusArgs): string {
    const lines = ["## Checkpoints"];
    const entries = this.checkpointEntries(state, args.node_id);
    if (entries.length === 0) {
      lines.push("  no checkpoint recorded");
      return lines.join("\n");
    }
    for (const e of entries) {
      for (const cp of e.checkpoints) {
        lines.push(
          `  ${e.node_id}  [${cp.status}]  at ${new Date(cp.at).toISOString()}` +
            (cp.note !== undefined ? `  note: ${cp.note}` : ""),
        );
      }
    }
    return lines.join("\n");
  }

  /** Text section: per-node artifacts / evidence (`include_artifacts` / `include_evidence`). */
  private renderArtifactsEvidence(state: EngineState, args: GraphStatusArgs): string {
    const lines = ["## Artifacts / Evidence"];
    const entries = this.artifactsEvidenceEntries(state, args, args.node_id);
    let any = false;
    for (const e of entries) {
      if (!e.artifacts && !e.evidence) continue;
      any = true;
      lines.push(`Node "${e.node_id}"`);
      if (e.artifacts) lines.push(`  artifacts: ${e.artifacts.join(", ")}`);
      if (e.evidence) lines.push(`  evidence: ${e.evidence.join(", ")}`);
    }
    if (!any) {
      lines.push("  no artifacts / evidence recorded");
    }
    return lines.join("\n");
  }

  /** Text section: timestamped signal-event history (`stream` / `since`). */
  private renderSignalStream(state: EngineState, args: GraphStatusArgs): string {
    const lines = ["## Signal Stream"];
    const entries = this.signalStreamEntries(state, args, args.node_id);
    let any = false;
    for (const e of entries) {
      if (e.events.length === 0) continue;
      any = true;
      lines.push(`Node "${e.node_id}"`);
      for (const ev of e.events) {
        lines.push(
          `  ${new Date(ev.atMs).toISOString()}  ${ev.signal}` +
            `  [${ev.source}]` +
            (ev.payload !== undefined ? `  ${JSON.stringify(ev.payload)}` : ""),
        );
      }
    }
    if (!any) {
      lines.push(
        args.since !== undefined
          ? `  no events since ${args.since}`
          : "  no events recorded",
      );
    }
    return lines.join("\n");
  }

  private renderTree(state: EngineState, nodeFilter?: Set<string>, depth?: number): string {
    // Visible node ids: the filter set, or every node when no filter is active.
    const visible = nodeFilter
      ? new Set([...nodeFilter].filter((id) => state.nodes.has(id)))
      : new Set(state.nodes.keys());
    // Child adjacency from edges; render BFS from roots — restricted to visible nodes.
    const children = new Map<string, string[]>();
    for (const id of visible) children.set(id, []);
    for (const edge of state.graphDeclaration.edges) {
      if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
      const list = children.get(edge.from) ?? [];
      list.push(edge.to);
      children.set(edge.from, list);
    }
    const roots = state.graphDeclaration.nodes
      .filter((n) => visible.has(n.id))
      .filter((n) => !state.graphDeclaration.edges.some((e) => e.to === n.id && visible.has(e.from)))
      .map((n) => n.id);

    // Depth cutoff: `undefined` means full depth (byte-identical to legacy).
    // `d > maxDepth` is always false when maxDepth is undefined, so the pruned
    // nodes are never marked visited and are simply absent from the output.
    const maxDepth = depth;
    const lines: string[] = [];
    lines.push(`Graph "${state.graphId}" [${state.phase}]`);
    const visited = new Set<string>();
    const render = (id: string, prefix: string, d: number): void => {
      if (maxDepth !== undefined && d > maxDepth) return;
      if (visited.has(id)) {
        // Back-edge within a loop group — already rendered upstream. Annotate
        // it and stop so tree rendering never recurses on the cycle.
        const n = state.nodes.get(id);
        lines.push(`${prefix}${id} ${n ? `[${n.status}] (back-edge)` : "(back-edge)"}`);
        return;
      }
      visited.add(id);
      const node = state.nodes.get(id);
      const label = node ? `${node.nodeId} [${node.status}]` : id;
      lines.push(`${prefix}${label}`);
      for (const child of children.get(id) ?? []) {
        render(child, `${prefix}  `, d + 1);
      }
    };
    for (const root of roots) {
      if (!visited.has(root)) render(root, "", 0);
    }
    return lines.join("\n");
  }

  // ── Status helpers ─────────────────────────────────────────────────────────

  /**
   * Serialize a graph declaration to YAML and write it to `exportPath`
   * atomically: write to a sibling `<path>.<pid>.tmp` file, then rename it into
   * place. Renaming is atomic on POSIX filesystems, so a reader never observes
   * a partially-written target. Returns a human-readable confirmation that
   * includes the serialized YAML.
   */
  private exportGraph(declaration: GraphDeclaration, exportPath: string): string {
    const serialized = serializeGraphDeclaration(declaration);
    this.writeAtomic(exportPath, serialized);
    return (
      `Exported graph declaration (${declaration.nodes.length} nodes, ` +
      `${declaration.edges.length} edges, ` +
      `${(declaration.loop_groups ?? []).length} loop groups) to ${exportPath}\n` +
      serialized
    );
  }

  /**
   * Mode-dependent `export_path` handling for graph_status. Works from a state
   * + declaration so both live (registry) and hydrated (persisted) graphs share
   * the same export logic. Three mutually exclusive modes, resolved by
   * specificity (node_id is the most specific):
   *   1. `node_id` set       -> export the node's materialized result text,
   *                             read from `MaterializedResultRef.sidecarPath`
   *                             via {@link resultText} (dispatch_export-style).
   *                             Throws when the node has no materialized result.
   *   2. `include_metrics`   -> export a metrics JSON snapshot reusing
   *                             {@link metricsSummary} / {@link budgetSummary}
   *                             (dispatch_metrics-style).
   *   3. neither             -> export the owning graph declaration to YAML
   *                             (existing {@link exportGraph} behaviour).
   * Every mode writes atomically via {@link writeAtomic}.
   */
  private exportForState(
    state: EngineState,
    declaration: GraphDeclaration,
    args: GraphStatusArgs,
  ): string {
    const exportPath = args.export_path as string;

    // Mode 1 — node result export (most specific).
    if (args.node_id) {
      const node = state.nodes.get(args.node_id);
      if (!node) {
        throw new Error(
          `graph_status: unknown node "${args.node_id}" in graph "${state.graphId}".`,
        );
      }
      if (!node.result) {
        throw new Error(
          `graph_status: node "${args.node_id}" has no materialized result to export.`,
        );
      }
      const text = GraphToolSet.resultText(node.result);
      this.writeAtomic(exportPath, text);
      return (
        `Exported node "${args.node_id}" result (${text.length} chars) to ${exportPath}\n` +
        text
      );
    }

    // Mode 2 — metrics JSON snapshot export.
    if (args.include_metrics) {
      const serialized = JSON.stringify(this.metricsSnapshot(state), null, 2);
      this.writeAtomic(exportPath, serialized);
      return `Exported graph metrics snapshot to ${exportPath}\n${serialized}`;
    }

    // Mode 3 — declaration YAML export (unchanged).
    return this.exportGraph(declaration, exportPath);
  }

  /**
   * Build a structured metrics JSON snapshot for the `export_path` +
   * `include_metrics` mode. Reuses {@link metricsSummary} (the human-readable
   * phase/status summary) and {@link budgetSummary} (graph + per-node budget),
   * plus a machine-readable `node_counts` breakdown keyed by status — the
   * graph-level analogue of a dispatch_metrics snapshot. All data is derived
   * from the live engine state, never fabricated.
   */
  private metricsSnapshot(state: EngineState) {
    const counts: Record<string, number> = {};
    for (const n of state.nodes.values()) {
      counts[n.status] = (counts[n.status] ?? 0) + 1;
    }
    return {
      graph_id: state.graphId,
      phase: state.phase,
      summary: this.metricsSummary(state),
      node_counts: counts,
      budget: this.budgetSummary(state),
    };
  }

  /**
   * Atomically write `content` to `exportPath`: write to a sibling
   * `<path>.<pid>.tmp` file, then rename it into place. Renaming is atomic on
   * POSIX filesystems, so a reader never observes a partially-written target
   * and no `.tmp` artifact remains after a successful write.
   */
  private writeAtomic(exportPath: string, content: string): void {
    const tmpPath = `${exportPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, exportPath);
  }

  private nodeSummary(state: EngineState, n: NodeRuntimeState, args: GraphStatusArgs) {
    const progress = args.include_progress ? this.progressForNode(state, n) : undefined;
    return {
      node_id: n.nodeId,
      status: n.status,
      agent: n.agent,
      needs_approval: n.needsApproval,
      loop_group: n.loopGroupId,
      traversal_count: n.traversalCount,
      retry_count: n.retryCount,
      ...(n.dispatchSessionId
        ? { dispatch_session_id: n.dispatchSessionId }
        : {}),
      ...(n.dispatchTaskId
        ? { dispatch_task_id: n.dispatchTaskId }
        : {}),
      error: n.errorReason,
      ...(progress && progress.recorded
        ? {
            progress: progress.payload,
            // Monitor L1: this timestamp is the node's LAST SIGNAL time of ANY
            // type (`SignalLedgerEntry.lastSignalAt`), not a progress-specific
            // stamp — named accordingly.
            last_signal_at: progress.lastSignalAt,
          }
        : {}),
      // Monitor M9: surface the node's materialized result text as an `output`
      // field, only when include_output was requested.
      ...(args.include_output && n.result
        ? { output: GraphToolSet.resultText(n.result) }
        : {}),
      // Liveness (subtask 7 display): merge snake_case liveness fields when the
      // node has RECORDED liveness AND (it is running OR include_liveness is
      // set). Running nodes always surface liveness; non-running nodes only on
      // request. Nodes without recorded liveness add NO keys (byte-identical
      // output preserved). Sub-fields are emitted only when actually present.
      ...(n.liveness && (n.status === NodeStatus.Running || args.include_liveness)
        ? (() => {
            const liv = n.liveness!;
            const liveness: Record<string, unknown> = {};
            if (liv.lastActivityAt !== undefined) {
              liveness.last_activity_at = liv.lastActivityAt;
              liveness.idle_ms = Date.now() - liv.lastActivityAt;
            }
            if (liv.heartbeatSource) liveness.heartbeat_source = liv.heartbeatSource;
            if (liv.stallStatus) liveness.stall_status = liv.stallStatus;
            if (liv.stallWarnedAt !== undefined) liveness.stall_warned_at = liv.stallWarnedAt;
            if (liv.stallReason !== undefined) liveness.stall_reason = liv.stallReason;
            return liveness;
          })()
        : {}),
    };
  }

  /**
   * Extract a node's recorded `progress` signal, if any, from the engine state.
   *
   * The graph engine records every signal a node emits into both
   * `node.signalsObserved[type]` and the graph-level `state.signalLedger[nodeId]`
   * (`signal-bridge.ts:record`). `progress` is an INFO signal (one of
   * `INFO_SIGNALS`), so — when a node emitted progress during execution — its
   * latest payload is genuinely available here. Note this is the **latest**
   * payload per node, not a timestamped multi-event history (the design's
   * `dispatch_stream`-style `since`-based history is unbacked — see
   * {@link UNSUPPORTED_GRAPH_STATUS_FLAGS} `stream`/`since`).
   */
  private progressForNode(state: EngineState, node: NodeRuntimeState) {
    const recorded = node.signalsObserved["progress"] !== undefined;
    const payload = recorded ? node.signalsObserved["progress"] : undefined;
    // Monitor L1: `lastSignalAt` is the node's LAST SIGNAL time of ANY type —
    // the graph-level `SignalLedgerEntry.lastSignalAt` (updated by
    // signal-bridge.ts:record on every signal, progress or not), NOT a
    // progress-specific stamp. It rides along with the progress payload so a
    // consumer gets a recency anchor, but it is named for what it actually is.
    const lastSignalAt = state.signalLedger.get(node.nodeId)?.lastSignalAt;
    return { recorded, payload, lastSignalAt };
  }

  private budgetSummary(state: EngineState) {
    return {
      graph: state.budget,
      nodes: [...state.nodes.values()].map((n) => ({
        node_id: n.nodeId,
        sessions: n.sessionsSpawned,
        tokens: {
          input: n.tokensConsumed.inputTokens,
          output: n.tokensConsumed.outputTokens,
        },
        cost: n.tokensConsumed.cost,
      })),
    };
  }

  private loopSummary(state: EngineState, l: LoopGroupRuntimeState, nodeIds: string[]) {
    const mode = this.loopDeclMode(state, l.id);
    return {
      loop_id: l.id,
      traversals: `${l.traversalCount}/${l.maxTraversals}`,
      nodes: nodeIds,
      termination: l.termination,
      consecutive_stale: l.consecutiveStale,
      // Loop mode surfaced only when explicitly declared (default stays
      // byte-identical): 'inherit' records rounds share the same engine state.
      ...(mode !== undefined ? { mode } : {}),
    };
  }

  private metricsSummary(state: EngineState): string {
    const counts = new Map<string, number>();
    for (const n of state.nodes.values()) {
      counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
    }
    const parts = [...counts.entries()]
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    return `phase=${state.phase} ${parts}`;
  }

  /** Apply max_chars / offset / tail pagination to a string output.
   *
   * Monitor L3: when truncation actually drops content, a `…[truncated: N more
   * chars]` marker is APPENDED to the tail of the returned text (N = the number
   * of chars NOT included in the result), so a consumer can tell the output was
   * cut and by how much. The marker is emitted for both tail mode (head
   * dropped) and head mode (tail dropped) — the returned slice is always
   * `max_chars` chars, the marker rides after it. No truncation → no marker
   * (byte-identical to legacy output). */
  private paginate(text: string, args: GraphStatusArgs): string {
    const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
    if (maxChars <= 0 || text.length <= maxChars) {
      return args.offset ? text.slice(args.offset) : text;
    }
    const slice = args.tail
      ? text.slice(Math.max(0, text.length - maxChars))
      : text.slice(args.offset ?? 0, (args.offset ?? 0) + maxChars);
    const dropped = text.length - slice.length;
    return `${slice}\n…[truncated: ${dropped} more chars]`;
  }

  /**
   * Resolve the member node ids of a loop group from the graph **declaration**.
   * The runtime {@link LoopGroupRuntimeState} does not carry the member list;
   * it lives on `graphDeclaration.loop_groups`.
   */
  private loopNodeIds(state: EngineState, loopId: string): string[] {
    const group = state.graphDeclaration.loop_groups?.find((g) => g.id === loopId);
    return group ? [...group.nodes] : [];
  }

  /**
   * Resolve a loop group's declared session-isolation `mode` from the graph
   * **declaration**. Like the member list, the mode lives on
   * `graphDeclaration.loop_groups` (the runtime {@link LoopGroupRuntimeState}
   * does not carry it). Returns `undefined` when unset — callers must omit it
   * from output to keep the default render byte-identical.
   */
  private loopDeclMode(state: EngineState, loopId: string): LoopMode | undefined {
    const group = state.graphDeclaration.loop_groups?.find((g) => g.id === loopId);
    return group?.mode;
  }

  /**
   * Find the graph that owns a given node or loop id. Used when graph_status is
   * called with `node_id`/`loop_id` but no `graph_id` (tool-merge-map.md §2.2
   * makes `graph_id` conditional). Throws a clear error when not found or when
   * the id is ambiguous across multiple graphs.
   */
  private resolveOwningGraph(nodeId?: string, loopId?: string): string {
    const matches: string[] = [];
    if (nodeId) {
      for (const [id, entry] of this.registry) {
        if (entry.runtime.status().nodes.has(nodeId)) matches.push(id);
      }
    } else if (loopId) {
      for (const [id, entry] of this.registry) {
        if (entry.runtime.status().loopGroups.has(loopId)) matches.push(id);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} exists in ` +
          `multiple graphs (${matches.join(", ")}); specify graph_id to disambiguate.`,
      );
    }
    throw new Error(
      `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} not found in any graph.`,
    );
  }

  /** Read a materialized node result from its sidecar file, best-effort. */
  private static resultText(ref: MaterializedResultRef): string {
    if (ref.fetchError) return `[fetch error: ${ref.fetchError}]`;
    try {
      return existsSync(ref.sidecarPath) ? readFileSync(ref.sidecarPath, "utf8") : "";
    } catch {
      return "";
    }
  }
}

/** Statuses that count as genuinely "active" for graph_run's active_nodes list.
 *  Excludes Pending — a pending node has not been dispatched yet and is not
 *  "active" in any meaningful sense (it may never become active if the graph
 *  deadlocks). Pending nodes appear in the separate `pending_nodes` field. */
const GRAPH_RUN_ACTIVE_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  NodeStatus.Ready,
  NodeStatus.Running,
  NodeStatus.Blocked,
]);

/** Statuses that count as genuinely "in-flight" for the session-level
 *  {@link GraphToolSet.hasInflightGraphsForSession} query: a node that has been
 *  dispatched (`running`) or is queued for dispatch (`ready`). Excludes Blocked
 *  — a `needs_approval` gate waits on the human, so auto-continue must freeze
 *  through the existing gated path instead of treating the graph as inflight. */
const GRAPH_INFLIGHT_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  NodeStatus.Ready,
  NodeStatus.Running,
]);

/**
 * Construct an imperative `graph_*` tool set bound to a dispatch manager.
 *
 * Subtask 6 wraps each public method below with a zod `args` schema and a
 * `defineTool` registration. The methods throw descriptive {@link Error}s on
 * invalid input; the wrapper is responsible for converting those into
 * agent-visible tool output.
 */
export function createGraphToolSet(deps?: GraphToolSetDeps): GraphToolSet {
  return new GraphToolSet(deps);
}

// Re-export the engine phase/status enums for callers that render status text.
export { EnginePhase, NodeStatus };

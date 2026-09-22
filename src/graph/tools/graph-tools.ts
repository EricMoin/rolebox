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
 * - The stateless render / format half — tree + summary renderers, pagination,
 *   the C-WIRE flag entry extractors, declaration lookups — lives in
 *   `./status-render.ts` (Y30), so this module keeps the registry, the deps and
 *   the engine assembly. The public toolset contract is unchanged.
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
 * 5. `graph_cancel` — the engine's {@link EngineRuntime.cancel} retires every
 *    cancellable node for a whole-graph cancel (plus the teardown, terminal
 *    transition and persistence flush), and {@link EngineRuntime.cancelNodes}
 *    is the real node/loop-scoped primitive (a loop target expands to its full
 *    member set, and `cascade` walks the forward closure). Both branches
 *    project the engine's FULL authoritative `CancelScopeReport` — retired
 *    (`cancelled`), expanded (`target`), left-alone (`skipped`), unknown
 *    (`unknown`) and the best-effort `cancelCalls` hand-offs — so the tool
 *    layer never reverse-infers "what was cancelled" from `errorReason` text.
 * 6. **Observed & confirmed:** `engine-state.registerNode`
 *    (`src/graph/engine/engine-state.ts:222-225`) correctly calls
 *    `resolveJoinStrategy(config.join)` to propagate the node's declared join
 *    (default `"all"`) into `NodeRuntimeState.joinStrategy`. The join config
 *    written by this tool therefore flows through correctly — no engine-side
 *    hard-coding remains.
 *
 * Design reference: `.rolebox/design/tool-merge-map.md` §2.2.
 */

import type { DispatchManager } from "../../dispatch/core/manager.ts";
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
} from "../../types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
  LoopGroupRuntimeState,
} from "../../types.engine-v2.ts";
import {
  createEngine,
  type EngineRuntime,
  type ApproveReport,
  type RejectReport,
  type CancelScopeReport,
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
  buildPropagatedBlockedText,
  type GraphCompletionHandler,
  type GraphStallHandler,
  type GraphTerminalHandler,
  graphParentContext,
  type DispatchParentContext,
  AdoptPlanRefusalError,
  planAdoptionRefusal,
} from "../engine/index.ts";
import {
  buildDeclaredOutcomeGraph,
  declaredGraphResult,
  GraphDeclareRefusedError,
  OutcomeProtocolUnavailableError,
  persistDeclaredGraph,
  readExistingDeclaredGraph,
  type DeclaredOutcomeGraph,
  type GraphDeclareArgs,
  type GraphDeclareResult,
} from "./declare-graph.ts";
import {
  submitDeclaredOutcome,
  type GraphSubmitOutcomeArgs,
  type GraphSubmitOutcomeResult,
} from "./submit-outcome.ts";
import type { OutcomeDispatchSeam } from "../outcome/runtime.ts";
import type { ValidatorRegistry } from "../outcome/validators.ts";
import type { ContractRegistry } from "../contracts/resolve.ts";
import type { ISessionClient } from "../../platform/ports/session-client.ts";
import { enqueueNotify } from "../../dispatch/notification.ts";
import { createSubLogger } from "../../logger.ts";
import { errorText } from "../../utils/error-text.ts";
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
  type GroupByMode,
  type StatusQuery,
} from "./status-queries.ts";
import {
  scanPersistedStates,
  type PersistedStateScan,
} from "./persisted-state.ts";
// Stateless render / format helpers extracted from this module (Y30). They
// carry no registry, deps or engine wiring — the stateful surface stays below.
import {
  artifactsEvidenceEntries,
  budgetSummary,
  buildNodeFilter,
  checkpointEntries,
  crossSessionBudget,
  crossSessionViewRequested,
  flagData,
  flagSectionsActive,
  loopDeclMode,
  loopNodeIds,
  loopRoundEntries,
  metricsSummary,
  paginate,
  persistedEmptyNote,
  progressForNode,
  renderTree,
  resultText,
  shallowCloneDeclaration,
  signalStreamEntries,
  visibleNodeMap,
  writeAtomic,
  type GraphBudgetSummary,
  type GraphFlagData,
  type GraphLoopSummary,
} from "./status-render.ts";

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
 * One DECLARED graph (C1): a v3 declaration that was parsed, compiled and bound
 * to a persisted engine state under the outcome protocol — plus whether that
 * state actually reached the on-disk store.
 *
 * Declared graphs are deliberately NOT entries of the legacy
 * {@link GraphToolSet.registry}: they have no legacy runtime, and every legacy
 * operation on one is refused by {@link GraphToolSet.getEntry} instead of being
 * answered from a fabricated engine.
 */
interface DeclaredGraphEntry {
  readonly graph: DeclaredOutcomeGraph;
  readonly persisted: boolean;
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
  /**
   * Optional session-chain resolver (platform-injected). Given a session id,
   * returns the ordered chain of sessions from that session UP to the
   * OUTERMOST live session (`[sessionId, parent, ..., outermost]`), or
   * `undefined` / a single-element chain when the session has no tracked
   * dispatcher parent.
   *
   * Consumed only by nested blocked-gate propagation: when a graph at any
   * nesting depth reaches the quiescent-blocked phase, the toolset delivers a
   * {@link buildPropagatedBlockedText} reminder to `chain.at(-1)` (the user's
   * orchestrator session) so the human can `graph_approve` there — the
   * subagent session that invoked the nested graph may already be dead. Absent
   * (opencode/Pi, or any caller without a parent-session index) → no
   * propagation: single-level graphs behave exactly as before.
   *
   * The dsh plugin wires this from
   * `DshDispatchAdapter.resolveSessionChain` (its dispatch-parent index).
   */
  resolveSessionChain?: (sessionId: string) => string[] | undefined;
  /**
   * Optional installed CONTRACT capability (C1). A v3 declaration's node
   * `contractRef` resolves against it during `graph_declare`; absent means no
   * contract is installed, so a node that declares a ref is refused as
   * `unresolved-contract` rather than bound to something unverified.
   */
  contracts?: ContractRegistry;
  /**
   * Optional dispatch seam the OUTCOME run path launches a node through
   * (`graph_submit_outcome`). Executing the node's agent is the deferred
   * effect-EXECUTION work, so the default is a no-op: the dispatch effect is
   * durably recorded `pending`/`started` and a later recovery reconciles it.
   */
  outcomeDispatch?: OutcomeDispatchSeam;
  /**
   * Optional installed validator implementations for outcome-protocol graphs.
   * The plan pins every acceptance requirement at an exact
   * `{ validator, version }`; a requirement with no registered implementation is
   * REFUSED rather than skipped, so absent means an EMPTY registry — a plan whose
   * gates need a capability this process does not have can never read as
   * accepted.
   */
  outcomeValidators?: ValidatorRegistry;
  /**
   * Root every outcome evidence reference must resolve inside. Defaults to
   * `directory` (the same working directory graph dispatches use).
   */
  outcomeArtifactRoot?: string;
  /**
   * Epoch-millisecond clock for an outcome submission. Time is an explicit
   * protocol input, so a caller may pin it; absent → the runtime reads
   * `Date.now()`. The receipt records exactly this value.
   */
  outcomeNow?: number;
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
  /**
   * Present when a node retry was requested (`node_id` + `retry`/`modify_prompt`).
   *
   * The engine's {@link RetryReport} projected field-for-field: `node_id` ←
   * `target`, `re_dispatched` ← `reDispatched`, and `reset` / `ready` /
   * `superseded_task_ids` ← `reset` / `ready` / `supersededTaskIds` verbatim
   * (engine order preserved, not re-sorted). `reset` is the target plus its
   * transitive downstream (all forced back to `pending`), `ready` is the node
   * ids left in the frontier for immediate dispatch, and
   * `superseded_task_ids` are the previous dispatch task ids the reset cleared
   * — the engine unregisters their termination subscriptions; they are NOT
   * cancellation requests. The old `retry_pending` flag is gone (the retry is
   * always handled inline).
   */
  retry?: {
    node_id: string;
    re_dispatched: number;
    reset: string[];
    ready: string[];
    superseded_task_ids: string[];
  };
}

/**
 * Result of `graph_cancel` — the engine's {@link CancelScopeReport} (contract
 * C7) projected for the tool surface.
 *
 * Every list is the engine's own answer for the teardown it performed, never
 * re-derived from `errorReason` text or a status diff. `cancelled` keeps its
 * established ascending sort; the other lists are sorted too, so the JSON answer
 * is deterministic regardless of node-map iteration order.
 */
export interface GraphCancelResult {
  graph_id: string;
  /**
   * Node ids actually retired to `cancelled → done` by this call
   * ({@link CancelScopeReport.cancelled}). Sorted.
   */
  cancelled: string[];
  /**
   * The effective target set the engine expanded the request into
   * ({@link CancelScopeReport.target}): the requested ids plus, for any target
   * that is a loop-group member, that group's full member set. Sorted.
   */
  target: string[];
  /**
   * Ids inside the cancellation scope the engine hit but left untouched because
   * they were not cancellable — already `completed`, `blocked`, or terminal
   * (`escalate` / `timeout` / `cancelled` / `done`)
   * ({@link CancelScopeReport.skipped}). Sorted.
   */
  skipped: string[];
  /**
   * Requested ids that name no node of the graph
   * ({@link CancelScopeReport.unknown}). Always empty for a whole-graph cancel,
   * whose target set is the live node map. Sorted.
   */
  unknown: string[];
  /**
   * Dispatch task ids handed to the cancel seam's `cancelTask`
   * ({@link CancelScopeReport.cancelCalls}) — BEST-EFFORT hand-offs, not
   * acknowledgements: the engine fires and forgets the cancellation, so a task
   * id here means "teardown was requested", never "the task has stopped".
   * Sorted.
   */
  cancelCalls: string[];
}

/**
 * Project a {@link CancelScopeReport} into the sorted, JSON-facing
 * {@link GraphCancelResult} lists. Every list is copied — the engine's report is
 * never mutated.
 *
 * `unknown` (E4): the engine reports "requested id that names no node" in its
 * own `CancelScopeReport.unknown` list — `skipped` now means only "exists, but
 * not cancellable". The projection reads that field directly; the tool layer
 * never re-derives it (an id absent from the node map is the engine's answer,
 * not the tool's second opinion).
 */
function projectCancelReport(
  report: CancelScopeReport,
): Pick<
  GraphCancelResult,
  "cancelled" | "target" | "skipped" | "unknown" | "cancelCalls"
> {
  return {
    cancelled: [...report.cancelled].sort(),
    target: [...report.target].sort(),
    skipped: [...report.skipped].sort(),
    unknown: [...report.unknown].sort(),
    cancelCalls: [...report.cancelCalls].sort(),
  };
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
  /**
   * Whether the decision actually resolved the node, taken from the engine's
   * own report ({@link ApproveReport.applied} / {@link RejectReport.kind}) —
   * the authority on whether the transition happened, so the answer stays
   * correct even if the node changes status between the call and the read.
   * `true` only when the node was `blocked` and the decision was applied;
   * `false` marks an idempotent no-op (already-resolved / never-blocked
   * node), so callers do not mistake the echoed live `node_status` for a
   * decision that took effect. For a sequential single decision this matches
   * the status observed before the call.
   */
  applied: boolean;
  /**
   * Reject lane only — which lane the engine's RejectReport took: `escalate`
   * (no loop group to re-open), `revise` (re-entered `ready` with the feedback
   * merged into the prompt), or `already_resolved` (idempotent replay).
   * Undefined on the approve lane, whose ApproveReport carries no lane
   * discriminator; `applied` is derived from the SAME report
   * (`kind !== "already_resolved"`), so the two can never disagree.
   */
  kind?: "escalate" | "revise" | "already_resolved";
  /**
   * Present only with `kind: "already_resolved"`: the status the node actually
   * had when the no-op reject replay arrived (RejectReport.actualStatus).
   * Undefined on every genuine rejection lane.
   */
  actual_status?: NodeStatus;
}

// ── graph_status JSON result shapes (Y27) ───────────────────────────────────

/**
 * One node row of the `graph_status` JSON snapshot — the typed shape of
 * {@link GraphToolSet.nodeSummary}. Optional keys are emitted only when their
 * source data is present, so the serialized shape is unchanged from the
 * pre-typing implementation; the difference is that a rename or a removed key
 * now fails to compile instead of silently changing the JSON output.
 */
export interface GraphNodeSummary extends GraphFlagData {
  node_id: string;
  status: NodeStatus;
  agent: string;
  needs_approval: boolean;
  loop_group: string | undefined;
  traversal_count: number;
  retry_count: number;
  dispatch_session_id?: string;
  dispatch_task_id?: string;
  error: string | undefined;
  progress?: unknown;
  last_signal_at?: number;
  output?: string;
  last_activity_at?: number;
  idle_ms?: number;
  heartbeat_source?: string;
  stall_status?: string;
  stall_warned_at?: number;
  stall_reason?: string;
}

/**
 * The `graph_status` JSON snapshot (format=json, graph-scoped). Built as a
 * typed object — the C-WIRE flag keys arrive through {@link flagData} spread at
 * the call site, and `budget` / `loops` / `metrics` are conditionally
 * spread, so no key is ever written as an explicit `undefined` that only
 * `JSON.stringify` happens to drop. The key names are the public JSON
 * contract and must not change.
 */
export interface GraphStatusSnapshot extends GraphFlagData {
  graph_id: string;
  phase: string;
  nodes: GraphNodeSummary[];
  budget?: GraphBudgetSummary;
  loops?: GraphLoopSummary[];
  metrics?: string;
  notification_degraded?: boolean;
  notification_degraded_statuses?: string[];
}

// ── Tool set ─────────────────────────────────────────────────────────────────

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
 * A graph-terminal observation delivered to {@link GraphToolSet.subscribeGraphTerminal}
 * observers. `sessionId` is the graph's invoking session (the session whose
 * tool call ran the graph), which lets an observer correlate a nested graph
 * with the dispatch task that spawned its agent. `failed` is true when the
 * terminal graph carries at least one escalated or timed-out node.
 * `isBlocked` is true for the quiescent-blocked (HITL gate) terminal, and
 * `blockedNodeIds` names the `needs_approval` node(s) awaiting a human decision
 * (`[]` for a non-blocked terminal). `phase` is the graph phase at emission.
 */
export interface GraphTerminalObservation {
  graphId: string;
  sessionId?: string;
  failed: boolean;
  /** True when the graph is quiescent-blocked on a `needs_approval` gate. */
  isBlocked: boolean;
  /** The graph phase at emission time. */
  phase: string;
  /** The blocked `needs_approval` node ids (empty for a non-blocked terminal). */
  blockedNodeIds: string[];
}

/** Observer callback for {@link GraphToolSet.subscribeGraphTerminal}. */
export type GraphTerminalObserver = (info: GraphTerminalObservation) => void;

/**
 * The imperative `graph_*` tool set bound to a dispatch manager and a single
 * in-memory graph registry. Construct once per session (or per graph batch);
 * {@link graph_create} opens a registry slot that the other tools mutate.
 */
export class GraphToolSet {
  private readonly registry = new Map<string, GraphEntry>();

  /**
   * Declared (v3, outcome-protocol) graphs by graph id (C1). A separate map on
   * purpose: these graphs have no legacy runtime, and keeping them out of
   * {@link registry} means no engine-state consumer (status aggregation, the
   * in-flight queries, the terminal observers) can observe one as a legacy
   * graph. Every legacy operation resolves ids through {@link getEntry}, which
   * refuses a declared id BEFORE consulting the legacy registry.
   */
  private readonly declaredGraphs = new Map<string, DeclaredGraphEntry>();

  /**
   * Graph-terminal observers. Consumed by the dsh dispatch adapter to hold an
   * outer dispatch open until a graph the dispatched agent launched from its
   * own session reaches a terminal state (nested-graph propagation). Empty by
   * default — no observer, no behavior change.
   */
  private readonly graphTerminalObservers = new Set<GraphTerminalObserver>();

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
    // field). Its parameter is the same three-value union, so the kind is
    // forwarded as-is — no widening assertion at this boundary (Y32).
    new GraphEventRecorder(this.deps.stateDir).notificationDegraded(graphId, kind);
  }

  /**
   * Read-only helper backing the graph_status degraded hint: read the graph's
   * durable event log (`.rolebox/state/graph-events-{hash}.ndjson`) and return
   * the deduped `status` values of any `notification_degraded` events
   * (`"completion"` / `"terminal"` / `"stall"`), in file order. Empty when no stateDir is
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
    // Always wire the observed terminal handler so this toolset's terminal
    // observers (nested-graph settlement) fire for rebuilt engines too, not
    // just the engine graph_run builds.
    options.onGraphTerminal = (event: GraphTerminalEvent): void => {
      this.notifyGraphTerminal(invokingSessionId, event);
      terminal?.(event);
    };
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
    // Parent context (graph-scoped budget key + optional live parent session)
    // is needed on every dispatch path, not just the manager-backed bridge.
    // The dsh path injects `dispatch` with no manager; without this it would
    // fall through to the engine's self-built fallback (engine-advance.ts),
    // losing the invoking session id on the rebuild/adoptPrior paths.
    if (this.deps.manager || this.deps.dispatch) {
      options.parentContext = this.parentContext(graphId, invokingSessionId);
    }
    const runtime = createEngine(declaration, options);
    runtime.provision();
    return runtime;
  }

  private parentContext(
    graphId: string,
    invokingSessionId?: string,
  ): DispatchParentContext {
    return graphParentContext({
      graphId,
      directory: this.deps.directory ?? ".",
      // Real live parent handle for adapters (dsh) that require one; omitted
      // when absent so opencode/Pi contexts stay byte-identical.
      ...(invokingSessionId !== undefined
        ? { parentSessionId: invokingSessionId }
        : {}),
    });
  }

  /**
   * Refuse a legacy operation on a DECLARED (outcome-protocol) graph.
   *
   * DECLARED GRAPHS ARE NOT LEGACY GRAPHS. This build has no registered handler
   * for the outcome protocol, so every legacy operation on a declared graph —
   * run, dry-run, construction, cancel, approve, targeted status — refuses
   * HERE, before a node is read or dispatched, and never falls back to the
   * legacy signal protocol. Nothing about a declared graph is fabricated into a
   * legacy runtime.
   *
   * A declared graph outlives this process: `declaredGraphs` is empty after a
   * restart while the persisted plan is still on disk, so a registry miss also
   * consults the store. That keeps the refusal the SAME missing-handler error
   * instead of the misleading "call graph_create first" — which would now open
   * a fresh LEGACY graph under a suffixed id rather than resume this one. The
   * probe runs only when neither the declared map nor the legacy registry knows
   * the id, so a registered legacy graph pays no I/O.
   */
  private refuseDeclaredGraph(graphId: string): void {
    const declared = this.declaredGraphs.get(graphId);
    if (declared !== undefined) {
      throw new OutcomeProtocolUnavailableError(
        declared.graph.graphId,
        declared.graph.plan.planRevision,
      );
    }
    if (this.registry.has(graphId)) return;
    const onDisk = readExistingDeclaredGraph(this.deps.stateDir, graphId);
    if (onDisk.kind === "declared") {
      throw new OutcomeProtocolUnavailableError(graphId, onDisk.planRevision);
    }
  }

  /**
   * Whether `graphId` is already reserved by a record this process cannot see.
   *
   * `registry` and `declaredGraphs` are process-local, so a declared plan
   * persisted by a PREVIOUS process owns its id only on disk. `graph_create`
   * must reserve that id too — otherwise it hands back an id whose first legacy
   * save overwrites the persisted plan (execution protocol, compiled plan and
   * plan binding all gone, with the loader then reporting a perfectly valid
   * legacy record).
   *
   * `declared` and `unreadable` reserve the id. `unreadable` includes a file
   * whose slugified path belongs to a DIFFERENT graph id (`"a/b"` and
   * `"a b"` share `engine-a-b.json`): the record cannot be shown to belong to
   * this id, so it is reserved rather than risked. `legacy` deliberately does
   * NOT reserve — an id whose on-disk record is a legacy graph this build can
   * resume is the normal same-id resume path. `absent`, and a toolset with no
   * state directory, reserve nothing.
   */
  private idReservedOnDisk(graphId: string): boolean {
    const onDisk = readExistingDeclaredGraph(this.deps.stateDir, graphId);
    return onDisk.kind === "declared" || onDisk.kind === "unreadable";
  }

  /** Look up a graph entry or throw a descriptive error. */
  private getEntry(graphId: string): GraphEntry {
    this.refuseDeclaredGraph(graphId);
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
    // A declared graph has no legacy approval gate and is not resumable under
    // the legacy protocol, so the missing-handler refusal comes FIRST — never
    // the generic "does not exist" error, and never a fabricated entry.
    this.refuseDeclaredGraph(graphId);
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
      // A throwing adoptPrior is contained (logged), never surfaced raw —
      // EXCEPT an explicit B8 plan refusal: continuing here would register a
      // rebuilt engine whose persisted plan was silently dropped (and whose
      // `blocked` gate may no longer be authoritative), so the refusal is
      // rethrown for the approval tool to surface. The engine was built from
      // the persisted declaration, so this path cannot actually disagree with
      // itself — the rethrow is the honest behaviour if it ever does.
      try {
        await runtime.adoptPrior(found);
      } catch (err) {
        log.warn(
          `graph-tools: adoptPrior (approval recovery) failed for graph "${graphId}": ${errorText(err)}`,
        );
        if (err instanceof AdoptPlanRefusalError) throw err;
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
   * The toolset never retains a reference to a caller-supplied object: the
   * construction tools copy every object / array they receive before it enters
   * the candidate declaration (Y31), so the validated declaration stored here
   * cannot be mutated afterwards through the caller's `args`.
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
      // B8: an extension CHANGES the declaration by construction, so a prior
      // state that carries a pinned plan identity (executionProtocolVersion /
      // compiledPlan / planBinding) cannot be adopted across it. Refuse BEFORE
      // the rebuild replaces the live runtime — dispose the freshly built
      // engine (it must not leak dispatch listeners) and throw the actionable
      // refusal, leaving the previous registry entry as the consistent
      // runtime. Nothing is silently dropped, and the same check applies even
      // when the prior state has no node progress, because a rebuild that
      // adopted nothing would still lose the plan.
      const refusal = planAdoptionRefusal(priorState, graphId, candidate);
      if (refusal !== null) {
        runtime.dispose();
        throw refusal;
      }
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
            `graph-tools: adoptPrior failed for graph "${graphId}": ${errorText(err)}`,
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
      // Copy: the committed declaration must not alias the caller's object
      // (Y31) — a later mutation of `args.budget` would otherwise rewrite the
      // structurally-validated declaration held by the registry.
      declaration.budget = { ...budget };
    }

    // Generate a unique graph id. Deterministic for tests when a single graph
    // is created; collision-free for multiple graphs via a suffix counter.
    // A declared (outcome-protocol) graph owns its id just as a legacy one
    // does, so the collision loop reserves both namespaces — and the persisted
    // store too (idReservedOnDisk), because `declaredGraphs` is empty in a
    // fresh process while the declared plan is still on disk: a legacy graph
    // can never be created over a declared graph's identity, in this process or
    // in the next one.
    let graphId = name.trim();
    let seq = 2;
    while (
      this.registry.has(graphId) ||
      this.declaredGraphs.has(graphId) ||
      this.idReservedOnDisk(graphId)
    ) {
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
      // Copy: never retain the caller's JoinConfig object (Y31).
      node.join = { ...args.join };
    }
    const budget: NodeBudgetSpec = { ...(args.budget ?? {}) };
    if (args.timeout_ms !== undefined) budget.timeout_ms = args.timeout_ms;
    if (args.max_retries !== undefined) budget.max_retries = args.max_retries;
    if (Object.keys(budget).length > 0) node.budget = budget;

    const candidate = shallowCloneDeclaration(entry.declaration);
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
      // Copy: never retain the caller's array (Y31) — the same discipline the
      // retry / loop-nodes fields already follow below and above.
      edge.signal_filter = [...args.signal_filter];
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
        mapping.fields = [...args.data_passthrough_include];
      }
      if (args.data_passthrough_exclude && args.data_passthrough_exclude.length > 0) {
        mapping.exclude = [...args.data_passthrough_exclude];
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

    const candidate = shallowCloneDeclaration(entry.declaration);
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
    if (args.mode === "inherit") {
      loop.mode = "inherit";
    }

    const candidate = shallowCloneDeclaration(entry.declaration);
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

  // ── graph_declare ──────────────────────────────────────────────────────────

  /**
   * Declare a v3 graph: parse, compile, and — on success — BIND the compiled
   * plan, its plan binding and the outcome-protocol identity to a persisted
   * engine state (C1).
   *
   * This is the first producer of a compiled plan. It does NOT execute, and it
   * cannot: the outcome protocol has no registered handler in this build.
   *
   * Refusals (all typed {@link GraphDeclareRefusedError}s carrying structured
   * diagnostics — nothing is persisted on any of them):
   * - the authored value is not a strict v3 declaration (unknown key, wrong
   *   type, bad loop limits, …);
   * - the declaration does not compile;
   * - compilation returned a NON-EXECUTABLE DRAFT (unresolved acceptance
   *   capabilities), named entry by entry — a draft is never persisted as if it
   *   were executable;
   * - `graph_id` disagrees with the declaration's `name`;
   * - the id already names a LEGACY graph (the execution protocol is pinned per
   *   graph and is never switched in place);
   * - the id already names a declared graph with DIFFERENT content. An
   *   UNCHANGED re-declaration deliberately PRESERVES the stored plan and its
   *   persisted state instead (the B8 adoption rule: a compiled plan is bound
   *   to the declaration it was compiled from);
   * - a PERSISTED record already owns the id (a previous process declared it):
   *   identical plan content preserves it in place, different content refuses,
   *   a legacy record refuses, and a file this build cannot read refuses rather
   *   than risk overwriting a plan it cannot see. The record is never
   *   overwritten silently.
   *
   * The invoking session / agent are accepted for tool-layer signature symmetry
   * and deliberately UNUSED: a declared graph dispatches nothing, so it has no
   * notification seam to target.
   */
  graph_declare(
    args: GraphDeclareArgs,
    _invokingSessionId?: string,
    _agent?: string,
  ): GraphDeclareResult {
    const built = buildDeclaredOutcomeGraph({
      declaration: args.declaration,
      ...(args.graph_id === undefined ? {} : { graphId: args.graph_id }),
      ...(args.supported_validators === undefined
        ? {}
        : { supportedValidators: args.supported_validators }),
      ...(this.deps.contracts === undefined
        ? {}
        : { contracts: this.deps.contracts }),
    });

    // A graph id belongs to exactly ONE execution protocol. A legacy graph is
    // never converted in place (protocol conversion is a separate, explicit
    // operation), and a declared graph is never extended by the legacy
    // construction tools — getEntry refuses those first.
    const legacy = this.registry.get(built.graphId);
    if (legacy !== undefined) {
      throw new GraphDeclareRefusedError(
        "legacy-graph-conflict",
        `graph_declare refused: graph "${built.graphId}" already exists as a LEGACY (v2) graph. ` +
          "The execution protocol is pinned per graph/plan revision and is never switched in " +
          "place; declare the v3 graph under a different name instead.",
      );
    }

    const existing = this.declaredGraphs.get(built.graphId);
    if (existing !== undefined) {
      if (existing.graph.declarationDigest !== built.declarationDigest) {
        throw new GraphDeclareRefusedError(
          "declaration-changed",
          `graph_declare refused: graph "${built.graphId}" is already declared from a DIFFERENT ` +
            `declaration (stored digest ${existing.graph.declarationDigest}, incoming digest ` +
            `${built.declarationDigest}, stored plan revision ${existing.graph.plan.planRevision}). ` +
            "A compiled plan is bound to the declaration it was compiled from, so a changed " +
            "declaration is neither adopted over it nor allowed to silently drop it. Declare " +
            "under a new graph name; replacing a plan is a separate replanning decision.",
        );
      }
      // UNCHANGED declaration: preserve the stored plan and its persisted state
      // — never rebuild (and never rewrite the file) for identical content.
      return declaredGraphResult(existing.graph, {
        persisted: existing.persisted,
        preserved: true,
      });
    }

    // No in-memory entry — but a PREVIOUS process may have persisted a record
    // under this id. It is never overwritten silently: the same plan content is
    // preserved in place, different content refuses, a legacy record refuses,
    // and a file this build cannot read refuses rather than risk destroying a
    // plan it cannot see. (In-process the comparison is the declaration digest,
    // B8's rule; across a restart the declaration itself is not persisted, so
    // the comparison is the persisted plan revision — the only identity on
    // disk. Both refuse rather than drop.)
    const onDisk = readExistingDeclaredGraph(this.deps.stateDir, built.graphId);
    if (onDisk.kind === "legacy") {
      throw new GraphDeclareRefusedError(
        "legacy-graph-conflict",
        `graph_declare refused: graph "${built.graphId}" already owns a LEGACY (v2) state ` +
          "file in this store, and the execution protocol is pinned per graph/plan revision " +
          "and is never switched in place; declare the v3 graph under a different name instead.",
      );
    }
    if (onDisk.kind === "unreadable") {
      throw new GraphDeclareRefusedError(
        "persisted-state-unreadable",
        `graph_declare refused: ${onDisk.reason}. Resolve or move that file before ` +
          `declaring graph "${built.graphId}" — it is never overwritten blindly.`,
      );
    }
    if (onDisk.kind === "declared") {
      if (onDisk.planRevision !== built.plan.planRevision) {
        throw new GraphDeclareRefusedError(
          "declaration-changed",
          `graph_declare refused: graph "${built.graphId}" already owns a PERSISTED compiled ` +
            `plan (revision ${onDisk.planRevision}) and the incoming declaration compiles to ` +
            `${built.plan.planRevision}. The persisted plan is authoritative for the declaration ` +
            "it was compiled from — it is neither overwritten nor silently dropped. Declare " +
            "under a new graph name; replacing a plan is a separate replanning decision.",
        );
      }
      // Same plan content: PRESERVE the file (no write) and register the entry.
      this.declaredGraphs.set(built.graphId, { graph: built, persisted: true });
      return declaredGraphResult(built, { persisted: true, preserved: true });
    }

    const persisted = persistDeclaredGraph(built, this.deps.stateDir);
    this.declaredGraphs.set(built.graphId, { graph: built, persisted });
    return declaredGraphResult(built, { persisted, preserved: false });
  }

  // ── graph_submit_outcome ───────────────────────────────────────────────────

  /**
   * Submit one worker proposal to a DECLARED graph's outcome run path (C3c).
   *
   * This is the model-facing `submit_outcome` capability of the outcome
   * protocol, and it is the ONLY completion source for such a graph: an
   * accepted outcome committed through this ingress is what settles a node.
   * There is no legacy completion on this path — a declared graph has no legacy
   * runtime instance, every legacy entry point refuses it
   * ({@link refuseDeclaredGraph}), and no severity-ranked signal is read, merged
   * or synthesized into an answer here.
   *
   * The caller supplies the minimum a worker knows: graph, node, outcome, the
   * attempt credential its dispatch request carried, optional data, optional
   * evidence references. Attempt id, submission id and plan revision are NOT
   * accepted; {@link submitDeclaredOutcome} resolves the node's contract from
   * the graph's PERSISTED compiled plan and the outcome runtime resolves the
   * attempt from the credential's persisted binding and derives the submission
   * id from the proposal's canonical digest. An extra key on the caller's
   * object is never read.
   *
   * Refusals that must be repaired and retried are RETURNED in the result
   * (`refusals`), together with a rejected decision's per-requirement outcomes.
   * A graph this ingress does not serve at all — an unknown id, a LEGACY v2
   * graph, a plan that never reached the store — throws
   * {@link OutcomeSubmissionRefusedError} BEFORE a ledger is opened, so nothing
   * is written.
   */
  async graph_submit_outcome(
    args: GraphSubmitOutcomeArgs,
    _invokingSessionId?: string,
    _agent?: string,
  ): Promise<GraphSubmitOutcomeResult> {
    return submitDeclaredOutcome(
      {
        workspaceDir: this.deps.stateDir,
        graphId: args.graph_id,
        declaredInMemory: this.declaredGraphs.has(args.graph_id),
        legacyInMemory: this.registry.has(args.graph_id),
      },
      args,
      {
        ...(this.deps.outcomeDispatch === undefined
          ? {}
          : { dispatch: this.deps.outcomeDispatch }),
        ...(this.deps.outcomeValidators === undefined
          ? {}
          : { validators: this.deps.outcomeValidators }),
        artifactRoot: this.deps.outcomeArtifactRoot ?? this.deps.directory ?? ".",
        ...(this.deps.outcomeNow === undefined
          ? {}
          : { now: this.deps.outcomeNow }),
      },
    );
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
    // Always wire a terminal handler: besides the graph-notify reminder
    // (when configured), it feeds this toolset's terminal observers so a
    // nested graph's settlement can be observed by the dispatch layer. The
    // observers are notified BEFORE the notifier so a deferred outer dispatch
    // is settled even when no emperor session is resolvable.
    const observedTerminal = (event: GraphTerminalEvent): void => {
      this.notifyGraphTerminal(sessionId, event);
      terminal?.(event);
    };
    const runtime = createEngine(entry.declaration, {
      manager: this.deps.manager,
      graphId: args.graph_id,
      parentContext: this.parentContext(args.graph_id, sessionId),
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
      onGraphTerminal: observedTerminal,
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
            // Full RetryReport projection (A2): every engine field reaches the
            // caller verbatim, so the answer cannot silently drop `ready` (the
            // frontier set) or the superseded dispatch task ids.
            retry: {
              node_id: retryReport.target,
              re_dispatched: retryReport.reDispatched,
              reset: retryReport.reset,
              ready: retryReport.ready,
              superseded_task_ids: retryReport.supersededTaskIds,
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

  /**
   * Whether the given session owns at least one graph whose engine has NOT
   * reached a terminal phase — i.e. its phase is still `executing`. Unlike
   * {@link hasInflightGraphsForSession}, a quiescent-blocked graph (a
   * `needs_approval` gate awaiting the human) still counts: a dispatched
   * subagent that launched a nested graph must not be reported terminal while
   * that graph is unsettled for ANY reason, including a HITL gate.
   *
   * Consumed by the dsh dispatch adapter's nested-graph settlement guard so an
   * outer node stays `running` (and its failure never silently becomes a
   * success) until the nested graph it launched reaches a terminal state.
   */
  hasExecutingGraphsForSession(sessionID: string): boolean {
    for (const entry of this.registry.values()) {
      if (entry.invokingSessionId !== sessionID) continue;
      if (entry.runtime.status().phase === EnginePhase.Executing) return true;
    }
    return false;
  }

  /**
   * Subscribe to graph-terminal events for every graph this toolset runs.
   * Returns an unsubscribe function. Used by the dsh dispatch adapter to learn
   * when a nested graph launched from a dispatched agent's session settles, so
   * the outer dispatch can be settled from the nested graph's outcome rather
   * than from the agent's (premature) turn completion.
   */
  subscribeGraphTerminal(observer: GraphTerminalObserver): () => void {
    this.graphTerminalObservers.add(observer);
    return () => {
      this.graphTerminalObservers.delete(observer);
    };
  }

  /**
   * Fan a terminal event out to every registered observer. Best-effort: a
   * throwing observer must never corrupt the engine's terminal transition
   * (mirrors the `onGraphTerminal` notifier convention). A no-op with no
   * observers registered.
   *
   * For the quiescent-blocked terminal it also propagates the approval request
   * up the session chain to the outermost live session (see
   * {@link GraphToolSetDeps.resolveSessionChain}) so a nested `needs_approval`
   * gate reaches the user's orchestrator session — not just the (possibly
   * dead) subagent session that invoked the nested graph.
   */
  private notifyGraphTerminal(
    sessionId: string | undefined,
    event: GraphTerminalEvent,
  ): void {
    const blockedNodeIds = event.isBlocked
      ? this.blockedNodeIdsFor(event.graphId)
      : [];
    const info: GraphTerminalObservation = {
      graphId: event.graphId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      failed:
        event.nodeStatusSummaries.escalate > 0 ||
        event.nodeStatusSummaries.timeout > 0,
      isBlocked: event.isBlocked,
      phase: event.phase,
      blockedNodeIds,
    };
    for (const observer of [...this.graphTerminalObservers]) {
      try {
        observer(info);
      } catch {
        // A throwing observer must not break the terminal transition.
      }
    }
    if (event.isBlocked && sessionId) {
      this.propagateBlockedGate(sessionId, event, blockedNodeIds);
    }
  }

  /**
   * Read the ids of the currently `blocked` nodes in a graph's live runtime.
   * Empty when the graph is unknown (e.g. the terminal fired before the
   * registry entry was replaced) — never fabricated.
   */
  private blockedNodeIdsFor(graphId: string): string[] {
    const entry = this.registry.get(graphId);
    if (!entry) return [];
    const ids: string[] = [];
    for (const node of entry.runtime.status().nodes.values()) {
      if (node.status === NodeStatus.Blocked) ids.push(node.nodeId);
    }
    return ids;
  }

  /**
   * Deliver a blocked-gate reminder to the OUTERMOST live session on the
   * invoking session's chain. A no-op when no resolver is wired (opencode/Pi),
   * when the chain has no parent (single-level graph — the graph's own invoking
   * session already received the terminal reminder), or when no session client
   * is configured. Delivery is fire-and-forget, serialized per target session
   * via {@link enqueueNotify}; a failure is logged and never breaks the
   * terminal transition.
   */
  private propagateBlockedGate(
    invokingSessionId: string,
    event: GraphTerminalEvent,
    blockedNodeIds: string[],
  ): void {
    const resolve = this.deps.resolveSessionChain;
    if (!resolve) return;
    const chain = resolve(invokingSessionId);
    if (!chain || chain.length <= 1) return;
    const outermost = chain[chain.length - 1];
    if (!outermost || outermost === invokingSessionId) return;
    const src = this.deps.graphNotify;
    if (src === undefined || typeof src === "function") return;
    const text = buildPropagatedBlockedText({
      graphId: event.graphId,
      phase: event.phase,
      blockedNodeIds,
      chain,
    });
    void enqueueNotify(outermost, async () => {
      try {
        await src.sessionClient.prompt(outermost, {
          parts: [{ type: "text", text }],
          noReply: false,
        });
        return true;
      } catch (err) {
        log.warn(
          `graph-tools: failed to propagate blocked gate for graph "${event.graphId}" to outermost session "${outermost}": ${errorText(err)}`,
        );
        return false;
      }
    });
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
          `graph-tools: getNodeIdForSession threw for graph "${graphId}" (session "${sessionId}") — skipped: ${errorText(err)}`,
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
        if (crossSessionViewRequested(args)) {
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
    const nodeFilter: Set<string> | undefined = buildNodeFilter(state, args);
    return this.renderGraph(state, args, nodeFilter);
  }

  // ── Cross-session (persisted/all) helpers ─────────────────────────────────

  /** Scan the on-disk engine-state store under `stateDir` (default cwd). */
  private persistedScan(): PersistedStateScan {
    return scanPersistedStates(this.deps.stateDir ?? process.cwd());
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
      return paginate(
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
          `No pending approvals.\n\n` + persistedEmptyNote(scan)
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
    return paginate(lines.join("\n"), scopedArgs);
  }

  /** No-target list for persisted/all scope: persisted graphs are shown, and an
   * empty store yields an explicit honest-empty note. */
  private renderScopedGraphList(scope: GraphStatusScope): string {
    const scan = this.persistedScan();
    const states = scope === "persisted" ? scan.loaded : this.collectAllStates();
    if (states.length === 0) {
      if (scope === "persisted") return persistedEmptyNote(scan);
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
      if (scope === "persisted") return persistedEmptyNote(scan);
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

    const budget = args.include_budget ? crossSessionBudget(states) : undefined;
    const capped = args.limit && args.limit > 0 ? rows.slice(0, args.limit) : rows;

    if (args.format === "json") {
      return paginate(
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
    return paginate(lines.join("\n"), args);
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
      return paginate(
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
    const nodeFilter = buildNodeFilter(state, scopedArgs);
    return this.renderGraph(state, scopedArgs, nodeFilter);
  }


  // ── graph_cancel ───────────────────────────────────────────────────────────

  async graph_cancel(args: GraphCancelArgs): Promise<GraphCancelResult> {
    const entry = this.getEntry(args.graph_id);

    // No target → whole-graph cancel (existing behavior): every cancellable node
    // is retired. The reported report is the engine's authoritative
    // CancelScopeReport (contract C7) — never a post-hoc filter of the
    // `errorReason` text. The old filter (`status === Done &&
    // errorReason.startsWith("cancelled")`) double-counted a node that an
    // earlier scoped cancel had already retired, and would silently answer `[]`
    // if the engine ever reworded the reason (Y29).
    if (!args.node_id && !args.loop_id) {
      const report = await entry.runtime.cancel();
      return {
        graph_id: args.graph_id,
        ...projectCancelReport(report),
      };
    }

    // Scoped target → the real scoped / cascade primitive. A loop target is
    // resolved to its member node ids first (an indivisible bounded cycle), then
    // handed to EngineRuntime.cancelNodes. Default cascade: true for a loop
    // target, false for a bare node_id — an explicit args.cascade always wins.
    // The reported sets are the ACTUAL CancelScopeReport of this scoped call,
    // never a post-hoc filter of a whole-graph teardown. Node ids are stable for
    // the lifetime of an engine state (a cancel never removes a node), so this
    // snapshot resolves the loop target before the cancel.
    const state = entry.runtime.status();
    const targetIds = args.loop_id
      ? loopNodeIds(state, args.loop_id)
      : [args.node_id as string];
    const cascade = args.cascade ?? args.loop_id !== undefined;
    const report = entry.runtime.cancelNodes(targetIds, { cascade });

    return {
      graph_id: args.graph_id,
      ...projectCancelReport(report),
    };
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

    // `applied` comes from the engine's own report — the primitive that
    // performed (or refused) the transition is the authority, so a no-op
    // decision is reported honestly instead of being inferred from a status
    // snapshot taken before the call. The reject lane additionally projects
    // the report's `kind` (escalate / revise / already_resolved) and, for an
    // idempotent replay, the status the node actually had — the report carried
    // them all along (A3).
    let applied: boolean;
    let kind: GraphApproveResult["kind"];
    let actualStatus: NodeStatus | undefined;
    if (args.action === "approve") {
      applied = (await runtime.approveNode(args.node_id, args.payload)).applied;
    } else {
      const report = await runtime.rejectNode(args.node_id, args.reason);
      applied = report.kind !== "already_resolved";
      kind = report.kind;
      if (report.kind === "already_resolved") actualStatus = report.actualStatus;
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
      applied,
      // Conditional spreads: the approve answer keeps exactly its previous
      // keys, and `actual_status` accompanies `already_resolved` only.
      ...(kind !== undefined ? { kind } : {}),
      ...(actualStatus !== undefined ? { actual_status: actualStatus } : {}),
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
        const snapshot: GraphStatusSnapshot = {
          graph_id: state.graphId,
          phase: state.phase,
          nodes: limitNodes(visibleNodes(), args.limit).map((n) =>
            this.nodeSummary(state, n, args),
          ),
          // Conditional spreads: an unset flag leaves its key out entirely
          // instead of writing an explicit `undefined` that only
          // JSON.stringify happens to drop (Y27).
          ...(args.include_budget ? { budget: budgetSummary(state) } : {}),
          ...(args.include_loops
            ? {
                loops: [...state.loopGroups.values()].map((l) =>
                  this.loopSummary(state, l, loopNodeIds(state, l.id)),
                ),
              }
            : {}),
          ...(args.include_metrics ? { metrics: metricsSummary(state) } : {}),
          ...(degradedStatuses.length > 0
            ? {
                notification_degraded: true,
                notification_degraded_statuses: degradedStatuses,
              }
            : {}),
          // C-WIRE: the structured flag data (round history / checkpoints /
          // artifacts+evidence / signal stream) is spread from the pure
          // `flagData` helper. Empty when no flag is set (byte-identical).
          ...flagData(state, args),
        };
        // Monitor M8/M9: every JSON output flows through paginate so
        // max_chars/offset/tail apply, with an explicit truncation marker when
        // content is dropped (see {@link paginate}).
        return paginate(JSON.stringify(snapshot, null, 2), args);
      }
      case "tree":
        return this.appendFlagSections(
          renderTree(state, nodeFilter, args.depth),
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
    const buckets = groupCompletedNodes(visibleNodeMap(state, nodeFilter), args.group_by!);
    if (args.format === "json") {
      return paginate(
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
        const mode = loopDeclMode(state, l.id);
        lines.push(
          `    ${l.id}  [${l.traversalCount}/${l.maxTraversals}]` +
            `${mode !== undefined ? `  mode=${mode}` : ""}` +
            `  nodes: ${loopNodeIds(state, l.id).join(", ")}`,
        );
      }
    }
    if (args.include_metrics) {
      lines.push("");
      lines.push(`  Metrics — ${metricsSummary(state)}`);
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
    return paginate(lines.join("\n"), args);
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
      const summary: GraphNodeSummary = {
        ...this.nodeSummary(state, node, args),
        ...flagData(state, { ...args, node_id: nodeId }),
      };
      return paginate(JSON.stringify(summary, null, 2), args);
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
      const prog = progressForNode(state, node);
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
      lines.push(paginate(resultText(node.result), args).replace(/^/gm, "    "));
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
      const summary: GraphLoopSummary = {
        ...this.loopSummary(state, loop, loopNodeIds(state, loopId)),
        // C-WIRE: loop-scoped round history merges into the loop JSON when asked.
        ...flagData(state, { ...args, loop_id: loopId }),
      };
      return paginate(JSON.stringify(summary, null, 2), args);
    }
    const lines: string[] = [];
    lines.push(`Loop "${loopId}"`);
    lines.push(`  traversals: ${loop.traversalCount}/${loop.maxTraversals}`);
    lines.push(`  nodes: ${loopNodeIds(state, loopId).join(", ")}`);
    // Loop mode surfaced only when explicitly declared (default render stays
    // byte-identical). 'inherit' documents that rounds re-dispatch within the
    // same engine state (no per-round session isolation).
    const mode = loopDeclMode(state, loopId);
    if (mode === "inherit") {
      lines.push(`  mode: inherit  (rounds re-dispatch within the same engine state)`);
    }
    if (loop.consecutiveStale) {
      lines.push(`  consecutive_stale: ${loop.consecutiveStale}`);
    }
    for (const nodeId of loopNodeIds(state, loopId)) {
      const node = state.nodes.get(nodeId);
      if (node) {
        lines.push(`    ${nodeId.padEnd(18)} ${node.status}`);
      }
    }
    return this.appendFlagSections(lines.join("\n"), state, { ...args, loop_id: loopId });
  }

  // ── C-WIRE observability flags (subtask 3) ─────────────────────────────────

  /**
   * Append the honest text sections produced by any active C-WIRE flag onto a
   * base render, separated by a blank line. Returns `base` unchanged when no
   * flag is active (see `flagSectionsActive` in status-render.ts). Every
   * section reads REAL recorded data or an explicit honest-empty note — never
   * fabricated rows.
   */
  private appendFlagSections(
    base: string,
    state: EngineState,
    args: GraphStatusArgs,
  ): string {
    if (!flagSectionsActive(args)) return base;
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

  /** Text section: per-loop round history (`include_history` / `round`). */
  private renderRoundHistory(state: EngineState, args: GraphStatusArgs): string {
    const lines = ["## Loop Round History"];
    const entries = loopRoundEntries(state, args);
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
    const entries = checkpointEntries(state, args.node_id);
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
    const entries = artifactsEvidenceEntries(state, args, args.node_id);
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
    const entries = signalStreamEntries(state, args, args.node_id);
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
    writeAtomic(exportPath, serialized);
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
      const text = resultText(node.result);
      writeAtomic(exportPath, text);
      return (
        `Exported node "${args.node_id}" result (${text.length} chars) to ${exportPath}\n` +
        text
      );
    }

    // Mode 2 — metrics JSON snapshot export.
    if (args.include_metrics) {
      const serialized = JSON.stringify(this.metricsSnapshot(state), null, 2);
      writeAtomic(exportPath, serialized);
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
      summary: metricsSummary(state),
      node_counts: counts,
      budget: budgetSummary(state),
    };
  }

  private nodeSummary(
    state: EngineState,
    n: NodeRuntimeState,
    args: GraphStatusArgs,
  ): GraphNodeSummary {
    const progress = args.include_progress ? progressForNode(state, n) : undefined;
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
        ? { output: resultText(n.result) }
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

  private loopSummary(
    state: EngineState,
    l: LoopGroupRuntimeState,
    nodeIds: string[],
  ): GraphLoopSummary {
    const mode = loopDeclMode(state, l.id);
    return {
      loop_id: l.id,
      traversals: `${l.traversalCount}/${l.maxTraversals}`,
      nodes: nodeIds,
      consecutive_stale: l.consecutiveStale,
      // Loop mode surfaced only when explicitly declared (default stays
      // byte-identical): 'inherit' records rounds share the same engine state.
      ...(mode !== undefined ? { mode } : {}),
    };
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

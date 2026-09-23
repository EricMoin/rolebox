/**
 * Graph Execution Engine v2 — `graph_*` tool logic (outcome run path)
 *
 * Version: 3.0
 * Date: 2026-09-23
 *
 * The TOOL LOGIC layer of the shipped `graph_*` surface. The legacy
 * construction/execution entries (`graph_create`, `graph_add_node`,
 * `graph_add_edge`, `graph_add_loop`, `graph_run`, `graph_cancel`,
 * `graph_approve`) and the in-memory engine registry behind them were deleted
 * with the legacy runtime; what remains is the surface a declared
 * (outcome-protocol) graph needs:
 *
 *     graph_declare, graph_submit_outcome, graph_audit, graph_status
 *
 * - `graph_declare` parses/compiles/binds a v3 declaration and persists its
 *   compiled plan (see `./declare-graph.ts`). The declared graphs this process
 *   holds live in {@link GraphToolSet}'s `declaredGraphs` map — NOT in a legacy
 *   runtime registry, and the toolset never builds an engine.
 * - `graph_submit_outcome` is the ONLY completion source for such a graph (see
 *   `./submit-outcome.ts`).
 * - `graph_audit` reads the store without writing (see `../audit/drain-audit.ts`).
 * - `graph_status` renders a declared or persisted graph's recorded state. Its
 *   status/summary/tree/flag renderers are unchanged and operate on the same
 *   {@link EngineState} container every record uses.
 *
 * This module contains **no zod schemas and no tool registration** — those live
 * in `./index.ts`. It exports the factory {@link createGraphToolSet}, whose
 * methods take plain object parameters and return plain (JSON-serializable)
 * values.
 *
 * The stateless render / format half — tree + summary renderers, pagination,
 * the C-WIRE flag entry extractors, declaration lookups — lives in
 * `./status-render.ts`.
 */

import type {
  EngineState,
  NodeRuntimeState,
  LoopGroupRuntimeState,
} from "../../types.engine-v2.ts";
import {
  buildDeclaredOutcomeGraph,
  declaredGraphResult,
  GraphDeclareRefusedError,
  persistDeclaredGraph,
  readExistingDeclaredGraph,
  retiredDeclaredRecord,
  type DeclaredOutcomeGraph,
  type GraphDeclareArgs,
  type GraphDeclareResult,
} from "./declare-graph.ts";
import {
  submitDeclaredOutcome,
  type GraphSubmitOutcomeArgs,
  type GraphSubmitOutcomeResult,
} from "./submit-outcome.ts";
import type { OutcomeDispatchAdapter } from "../outcome/runtime.ts";
import type { CredentialIsolationCapability } from "../outcome/credential-isolation.ts";
import type { HostIdentityCapability } from "../outcome/host-identity.ts";
import type { ValidatorRegistry } from "../outcome/validators.ts";
import {
  auditGraphStore,
  type DrainAuditReport,
} from "../audit/drain-audit.ts";
import type { ContractRegistry } from "../contracts/resolve.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import { engineStateDir } from "../persistence/engine-persistence.ts";
import { readCredentialIsolationAdapter } from "../outcome/credential-isolation.ts";
import { createSubLogger } from "../../logger.ts";
import { errorText } from "../../utils/error-text.ts";
import type { GraphControlResult } from "../control/application.ts";
import type { RunControlRecord } from "../ledger/types.ts";
import {
  runGraphControlEntry,
  type GraphControlEntryArgs,
} from "./control-entry.ts";
import {
  EnginePhase,
  NodeStatus,
} from "../../constants.ts";
import {
  filterNodes,
  groupCompletedNodes,
  limitNodes,
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
  controlLine,
  controlMarker,
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
  skippedGraphsNote,
  visibleNodeMap,
  writeAtomic,
  type GraphBudgetSummary,
  type GraphFlagData,
  type GraphLoopSummary,
} from "./status-render.ts";

// Module logger (exported so tests can spy on the degradation warnings, F6).
export const log = createSubLogger("graph:tools");

// ── Declared-graph registry ──────────────────────────────────────────────────

/**
 * One DECLARED graph: a v3 declaration that was parsed, compiled and bound to a
 * persisted engine state under the outcome protocol — plus whether that state
 * actually reached the on-disk store.
 *
 * Declared graphs are the toolset's ONLY graph registry: there is no legacy
 * runtime entry beside them.
 */
interface DeclaredGraphEntry {
  readonly graph: DeclaredOutcomeGraph;
  readonly persisted: boolean;
}

/**
 * One store scan, indexed for the declared-graph views: the scan itself plus
 * the readable stored records by graph id.
 *
 * The distinction is load-bearing (A19). A declared graph with NO stored record
 * is still an in-memory fact — the declaration snapshot is the only position
 * that exists and it may be reported. A stored record the scan SKIPPED (its
 * definition or its run state failed a gate), or a store the scan could not
 * read at all, is NOT "no record": the graph has a recorded position and this
 * build cannot read it, so no position may be invented for it in any scope.
 */
interface DeclaredStoreView {
  readonly scan: PersistedStateScan;
  readonly recorded: Map<string, EngineState>;
}

/**
 * Options for constructing a {@link GraphToolSet}.
 *
 * Every dependency is an OUTCOME-path dependency. The legacy options
 * (`manager`, `dispatch`, `graphNotify`, `nodeStaleTimeoutMs`,
 * `livenessFeed`, `resolveSessionChain`) were deleted with the runtime that
 * read them.
 */
export interface GraphToolSetDeps {
  /** Working directory for graph dispatches and the artifact root default. */
  directory?: string;
  /** Workspace whose `.rolebox/state` holds the graph records. */
  stateDir?: string;
  /**
   * Installed CONTRACT capability. A v3 declaration's node `contractRef`
   * resolves against it during `graph_declare`; absent means no contract is
   * installed, so a node that declares a ref is refused as
   * `unresolved-contract` rather than bound to something unverified.
   */
  contracts?: ContractRegistry;
  /**
   * HOST-INSTALLED completion-policy capability.
   *
   * `graph_declare` resolves a declaration's `completion_policy` REQUEST
   * against it (a natural mapping is denied, authorized or reported as a draft
   * reason), and `graph_submit_outcome` corroborates the policy a persisted
   * plan pinned before it settles anything. It is a TOOLSET dependency and
   * deliberately never a tool argument: the same call that requests a policy
   * revision must not be able to authorize it.
   */
  completionPolicies?: CompletionPolicyRegistry;
  /**
   * HOST credential-isolation capability — the production enablement condition
   * of the OUTCOME run path's dispatch of attempt credentials.
   *
   * A TOOLSET dependency, never a tool argument. Without it
   * `graph_submit_outcome` refuses with `credential-isolation-unavailable`
   * before it opens a ledger: the durable state records only a digest, and only
   * the host can store the credential itself and deliver it per attempt. With
   * it, the ingress opens the ledger at the adapter's declared
   * `credentialStoreRoot`.
   */
  credentialIsolation?: CredentialIsolationCapability;
  /**
   * HOST invocation-identity capability — the ADDITIONAL constraint a host may
   * declare on top of per-attempt credentials.
   *
   * A TOOLSET dependency, never a tool argument. With a readable capability,
   * `graph_submit_outcome` records the host identity of the dispatching
   * invocation on every attempt the run path arms, and a settlement must come
   * from the same host attribution (`host-identity-mismatch` /
   * `host-identity-absent`). ABSENT is legal and preserves the behavior this
   * path had before the rule existed; a capability this build cannot read
   * refuses the ingress before it opens a ledger
   * (`host-identity-unavailable`).
   */
  hostIdentity?: HostIdentityCapability;
  /**
   * The HOST dispatch adapter the OUTCOME run path starts a node through, with
   * the create channel and the execution query. A TOOLSET dependency, never a
   * tool argument.
   *
   * REQUIRED IN PRACTICE for a declared graph to run: without one the ingress
   * refuses with `dispatch-unavailable` before it opens a ledger. There is
   * deliberately no no-op default — it would accept outcomes and record
   * successor dispatches no host ever created.
   */
  outcomeDispatch?: OutcomeDispatchAdapter;
  /**
   * Installed validator implementations for outcome-protocol graphs. The plan
   * pins every acceptance requirement at an exact `{ validator, version }`; a
   * requirement with no registered implementation is REFUSED rather than
   * skipped, so absent means an EMPTY registry — a plan whose gates need a
   * capability this process does not have can never read as accepted.
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
  /**
   * HOST seam invoked after `graph_declare` has persisted (or preserved) a
   * declaration's compiled plan.
   *
   * A declared graph is NOT dispatched by the tool that declares it: the plan
   * reaches the store here, and the host that owns the run path performs the
   * graph's FIRST EXECUTION (or a restart resume) through the outcome runtime's
   * own entry. This seam is how that host learns the plan exists — without it a
   * declared graph has no in-flight state and nothing ever arms a node.
   *
   * The invoking session and agent are forwarded because a host that enables
   * the invocation-identity capability has to attribute the attempts this first
   * execution arms to the invocation that declared the graph; the callback is
   * invoked synchronously here and may return a promise the host manages itself
   * (never awaited by the toolset).
   */
  onGraphDeclared?: (
    graphId: string,
    invokingSessionId?: string,
    agent?: string,
  ) => void;
}

// ── Tool parameter shapes (plain objects — index.ts wraps with zod) ─────────


export type GraphStatusFormat = "summary" | "tree" | "json";

/**
 * Session-scope of a `graph_status` query.
 *
 * - `session` — the DECLARED graphs this process holds (the default): a graph
 *   declared here is registered in memory and persisted at declaration time.
 * - `persisted` — only graphs hydrated from the on-disk engine-state store
 *   (`stateDir/.rolebox/state/engine-*.json`) — a cross-session view over
 *   graphs written by earlier sessions or other processes.
 * - `all` — the declared graphs PLUS persisted ones; on a `graphId` collision
 *   the in-memory declared entry wins.
 */
export type GraphStatusScope = "session" | "persisted" | "all";

export interface GraphStatusArgs {
  graph_id?: string;
  node_id?: string;
  loop_id?: string;
  format?: GraphStatusFormat;
  /** Scope of the query (see {@link GraphStatusScope}). When `persisted` or
   * `all`, the scanned persisted EngineStates are merged into the render/query
   * pipeline so the no-target list, query/status/agent/from_date/to_date filter,
   * `group_by` buckets, and `include_budget` aggregation all read across
   * sessions. An empty store yields an explicit honest-empty note — never
   * fabricated rows. */
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
  max_chars?: number;
  offset?: number;
  tail?: boolean;
  /** When set, atomically write an export to this path and return a
   * confirmation instead of a status render. Mode-dependent: a `node_id` writes
   * that node's materialized result text, `include_metrics` writes a metrics
   * JSON snapshot. */
  export_path?: string;
}

/** JSON-primitive per-node projection for the `graph_status` output. */
export interface GraphNodeSummary extends GraphFlagData {
  node_id: string;
  status: NodeStatus;
  agent: string;
  /**
   * The RUN's durable control fact when a trusted command stopped it (P3 item
   * 1). Present only when the run carries one: a node whose recorded status is
   * still `running` says so here, beside the stop that ended the run, instead
   * of reading as work that is still moving.
   */
  control?: GraphControlSummary;
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
  /**
   * The run's durable control fact when a trusted command STOPPED it (P3 item
   * 1, plan §5 A09). Present ONLY when the run carries one, and additive: the
   * `phase` key keeps the phase the store records, so a reader can tell a
   * still-executing run from a stopped one without this surface rewriting a
   * fact the store holds.
   */
  control?: GraphControlSummary;
  budget?: GraphBudgetSummary;
  loops?: GraphLoopSummary[];
  metrics?: string;
}

/** The run-level control fact, as the `graph_status` JSON contract carries it. */
export interface GraphControlSummary {
  command: string;
  reason: string;
  decided_at: number;
  decided_by_session?: string;
  decided_by_agent?: string;
}

/** Project one stored run-control record onto the JSON contract above. */
function controlSummary(control: RunControlRecord): GraphControlSummary {
  return {
    command: control.command,
    reason: control.reason,
    decided_at: control.decidedAt,
    ...(control.decidedBy === undefined
      ? {}
      : { decided_by_session: control.decidedBy.sessionId }),
    ...(control.decidedBy?.agentId === undefined
      ? {}
      : { decided_by_agent: control.decidedBy.agentId }),
  };
}
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
// ── Tool set ─────────────────────────────────────────────────────────────────

/**
 * The imperative `graph_*` tool set: declared (outcome-protocol) graphs plus
 * the read-only status/audit surface over the persisted store. There is no
 * legacy engine and no construction registry — `graph_declare` is the only
 * write entry point.
 */
export class GraphToolSet {
  /**
   * Declared graphs by graph id. A declared graph outlives this process: the
   * map is empty after a restart while the persisted plan is still on disk, so
   * status/audit read the store as the cross-session authority.
   */
  private readonly declaredGraphs = new Map<string, DeclaredGraphEntry>();

  constructor(private readonly deps: GraphToolSetDeps = {}) {}


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
   * - the id already names a declared graph with DIFFERENT content. An
   *   UNCHANGED re-declaration deliberately PRESERVES the stored plan and its
   *   persisted state instead (the B8 adoption rule: a compiled plan is bound
   *   to the declaration it was compiled from);
   * - a PERSISTED record already owns the id (a previous process declared it):
   *   identical plan content preserves it in place, different content refuses,
   *   and a file this build cannot read (a deleted protocol, a foreign record)
   *   refuses rather than risk overwriting a plan it cannot see. The record is
   *   never overwritten silently.
   *
   * After the plan is persisted (or an identical persisted plan is preserved),
   * the host's `onGraphDeclared` seam is invoked with the graph id and the
   * invoking session / agent. The declared graph itself is not dispatched here:
   * the host that owns the outcome run path performs the first execution (or a
   * restart resume) through that seam. A throwing seam never fails the
   * declaration — the plan is already durable, and the failure is logged.
   */
  graph_declare(
    args: GraphDeclareArgs,
    invokingSessionId?: string,
    agent?: string,
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
      ...(this.deps.completionPolicies === undefined
        ? {}
        : { completionPolicies: this.deps.completionPolicies }),
    });

    // The host's declaration seam: fire-and-report, never fail the declaration.
    // The plan is already durable when this runs, so a host that cannot start
    // the run reports that through its own channel; a throwing seam must not
    // make a persisted declaration look refused.
    const declared = (result: GraphDeclareResult): GraphDeclareResult => {
      try {
        this.deps.onGraphDeclared?.(result.graph_id, invokingSessionId, agent);
      } catch (err) {
        log.warn(
          `graph_declare: onGraphDeclared seam threw for graph "${result.graph_id}" — ` +
            `the declaration stands: ${errorText(err)}`,
        );
      }
      return result;
    };

    // A graph id belongs to exactly ONE store record, and the retired per-graph
    // v2 container is not one of them.
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
      return declared(
        declaredGraphResult(existing.graph, {
          persisted: existing.persisted,
          preserved: true,
        }),
      );
    }

    // No in-memory entry — but a PREVIOUS process may have persisted a record
    // under this id. It is never overwritten silently: the same plan content is
    // preserved in place, different content refuses, and a file this build cannot
    // read refuses rather than risk destroying a plan it cannot see. (In-process
    // the comparison is the declaration digest,
    // B8's rule; across a restart the declaration itself is not persisted, so
    // the comparison is the persisted plan revision — the only identity on
    // disk. Both refuse rather than drop.)
    // A RETIRED per-graph container for THIS graph refuses first: this build
    // neither reads nor rewrites it, and declaring over it would leave a record
    // the operator can still see stranded beside a new run (plan §3.6, §P6.4).
    const retired = retiredDeclaredRecord(this.deps.stateDir, built.graphId);
    if (retired !== undefined) {
      throw new GraphDeclareRefusedError(
        "persisted-state-unreadable",
        `graph_declare refused: a retired per-graph engine-state container for graph ` +
          `"${built.graphId}" is still present at ${retired.path}. That record belongs to a ` +
          "layout this build no longer writes and has NO decoder for, so it is neither read " +
          "as a declaration nor overwritten. Inventory and archive it (or declare the graph " +
          "under a new name); the declaration is refused rather than allowed to strand it.",
      );
    }
    const onDisk = readExistingDeclaredGraph(this.storeDirectory(), built.graphId);
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
      return declared(declaredGraphResult(built, { persisted: true, preserved: true }));
    }

    const persisted = persistDeclaredGraph(built, this.storeDirectory());
    this.declaredGraphs.set(built.graphId, { graph: built, persisted });
    return declared(declaredGraphResult(built, { persisted, preserved: false }));
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
   *
   * THE SECOND PARAMETER IS THE CALL'S OWN SESSION, NOT AN ARGUMENT. The
   * canonical facade passes the session the platform attributed to THIS tool
   * call; the ingress threads it as the call context the attempt's confirmed
   * worker binding is checked against (P2 item 2). It is never read from the
   * args object, an extra key on which is never read at all, and a caller that
   * omits it while a worker capability is installed gets the fail-closed
   * `host-worker-absent` answer instead of a submission settled on its
   * credential alone.
   */
  async graph_submit_outcome(
    args: GraphSubmitOutcomeArgs,
    invokingSessionId?: string,
    _agent?: string,
  ): Promise<GraphSubmitOutcomeResult> {
    return submitDeclaredOutcome(
      {
        workspaceDir: this.deps.stateDir,
        graphId: args.graph_id,
        declaredInMemory: this.declaredGraphs.has(args.graph_id),
      },
      args,
      {
        // THE CALL'S OWN SESSION (P2 item 2). The canonical facade passes the
        // session the platform adapter attributed to THIS tool call; the
        // ingress compares it with the child session the host confirmed for
        // the attempt, captures the value synchronously, and never re-reads an
        // ambient holder after an await. A caller that passes none (a direct
        // toolset call with no platform context) gets the fail-closed
        // `host-worker-absent` answer when a worker capability is installed.
        ...(invokingSessionId === undefined ? {} : { invokingSessionId }),
        ...(this.deps.outcomeDispatch === undefined
          ? {}
          : { dispatch: this.deps.outcomeDispatch }),
        ...(this.deps.outcomeValidators === undefined
          ? {}
          : { validators: this.deps.outcomeValidators }),
        ...(this.deps.completionPolicies === undefined
          ? {}
          : { completionPolicies: this.deps.completionPolicies }),
        ...(this.deps.credentialIsolation === undefined
          ? {}
          : { credentialIsolation: this.deps.credentialIsolation }),
        ...(this.deps.hostIdentity === undefined
          ? {}
          : { hostIdentity: this.deps.hostIdentity }),
        artifactRoot: this.deps.outcomeArtifactRoot ?? this.deps.directory ?? ".",
        ...(this.deps.outcomeNow === undefined
          ? {}
          : { now: this.deps.outcomeNow }),
      },
    );
  }
  // ── graph_control ──────────────────────────────────────────────────────────

  /**
   * THE ONE EXPLICIT CONTROL ENTRY (P3 item 1): apply one trusted lifecycle
   * command to a declared graph's run.
   *
   * The command types are explicit (never inferred from a payload or a worker
   * field), the store is the workspace's ONE store, and the PRINCIPAL is the
   * session the platform attributed to THIS call — the second parameter, exactly
   * like the submission ingress — never a value on `args`. The permission rule,
   * the idempotency rules and every refusal belong to the control application
   * service; this method only resolves the store directory the rest of this
   * toolset already resolves and hands the command over.
   */
  graph_control(
    args: GraphControlEntryArgs,
    invokingSessionId?: string,
    agent?: string,
  ): GraphControlResult {
    return runGraphControlEntry(
      {
        storeDirectory: this.storeDirectory(),
        ...(this.deps.outcomeNow === undefined ? {} : { now: this.deps.outcomeNow }),
      },
      args,
      invokingSessionId,
      agent,
    );
  }

  // ── graph_status ───────────────────────────────────────────────────────────

  graph_status(args: GraphStatusArgs): string {
    const scope: GraphStatusScope = args.scope ?? "session";
    const noTarget = !args.graph_id && !args.node_id && !args.loop_id;

    // ── Cross-session views (scope persisted/all) ─────────────────────────────
    // Merge the scanned persisted EngineStates into the render/query pipeline:
    // the no-target list shows persisted graphs, and a filter/group_by/
    // include_budget view aggregates across sessions.
    if (scope !== "session") {
      if (noTarget) {
        // A filter/group/budget view without a target = a cross-session aggregate.
        if (crossSessionViewRequested(args)) {
          return this.renderCrossSession(args, scope);
        }
        return this.renderScopedGraphList(scope);
      }
      // Targeted (graph_id / node_id / loop_id) — resolve across declared + store.
      return this.renderScopedTarget(args, scope);
    }

    // ── Session scope: the DECLARED graphs this process holds ─────────────────
    if (noTarget) {
      if (this.declaredGraphs.size === 0) {
        return "No declared graphs exist. Call graph_declare to declare one.";
      }
      return this.renderDeclaredSessionList();
    }

    // Resolve the owning graph. Prefer an explicit graph_id; otherwise search
    // the declared graphs for the one that contains the requested node / loop.
    const graphId = args.graph_id
      ? args.graph_id
      : this.resolveOwningGraph(args.node_id, args.loop_id);
    const state = this.resolveDeclaredState(graphId);

    // export_path: mode-dependent export to the target path (see exportForState).
    if (args.export_path) {
      return this.exportForState(state, args);
    }

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

  /**
   * One scan of the workspace's graph store, indexed by graph id: the readable
   * stored records (each one a declared graph's own durable record, advanced by
   * the host and the submission ingress as the run commits) plus the scan's
   * verdict, so a stored-but-unreadable graph is distinguishable from a graph
   * with no stored record at all (see {@link liveDeclaredState}).
   */
  private storeView(scan: PersistedStateScan = this.persistedScan()): DeclaredStoreView {
    return { scan, recorded: new Map(scan.loaded.map((s) => [s.graphId, s])) };
  }

  /**
   * Whether the scan found a stored record for `graphId` that it could not
   * read: the id is in the skipped set, or the store itself is unreadable (in
   * which case no stored record can be ruled out).
   */
  private storedButUnreadable(graphId: string, view: DeclaredStoreView): boolean {
    return view.scan.blocked !== undefined || view.scan.skippedGraphs.includes(graphId);
  }

  /**
   * The readable state of a declared graph, or `undefined` when the store holds
   * a record for it that this build cannot READ.
   *
   * The in-memory snapshot is what `graph_declare` built; the run's position is
   * written back into the graph's own persisted record as it advances. When a
   * readable record exists it IS that graph's state, and a declaration with no
   * stored record at all has only the snapshot — that fallback stays.
   *
   * A record the scan SKIPPED is different: the graph has a recorded position
   * and this build cannot read it, so the declaration snapshot is NOT its
   * position and `undefined` is how every caller refuses to invent one (A19).
   * The callers then take the honest path — the skipped-id note for a list, the
   * by-name "stored at … but this build cannot read it" refusal for a target,
   * the same answers `scope=persisted` gives.
   */
  private liveDeclaredState(
    entry: DeclaredGraphEntry,
    view: DeclaredStoreView,
  ): EngineState | undefined {
    const base = entry.graph.state;
    const recorded = view.recorded.get(base.graphId);
    if (recorded !== undefined) return recorded;
    if (this.storedButUnreadable(base.graphId, view)) return undefined;
    return base;
  }

  /**
   * The refusal for a graph the store holds but this build cannot read, shared
   * by EVERY scope so session, persisted and all answer the same way (A19):
   * the store's own verdict when the whole store is unreadable, otherwise the
   * by-name refusal that `graph_audit` corroborates.
   */
  private unreadableGraphError(graphId: string, scan: PersistedStateScan): Error {
    if (scan.blocked !== undefined) {
      return new Error(
        `graph_status: the graph store at ${scan.storeDirectory} cannot be read: ${scan.blocked}.`,
      );
    }
    return new Error(
      `graph_status: graph "${graphId}" is stored at ${scan.storeDirectory} but this build ` +
        "cannot read it (a stored definition or its run state failed a gate). " +
        "graph_audit names the blocker; no position is reported for it.",
    );
  }

  /** Resolve a DECLARED graph's state, or throw the missing/unreadable error. */
  private resolveDeclaredState(graphId: string): EngineState {
    const entry = this.declaredGraphs.get(graphId);
    if (!entry) {
      throw new Error(
        `graph "${graphId}" is not a declared graph in this process. Call graph_declare first, ` +
          "or query scope=persisted for a graph another process declared.",
      );
    }
    const view = this.storeView();
    const state = this.liveDeclaredState(entry, view);
    if (state !== undefined) return state;
    throw this.unreadableGraphError(graphId, view.scan);
  }

  /**
   * The session list: every declared graph's recorded position, in declaration
   * order.
   *
   * A declared graph whose stored record this build cannot read is NOT shown
   * with its declaration snapshot — that snapshot is the declaration-time
   * position (`idle`, every node `pending`), and printing it for a graph that
   * really ran is the fabricated position A19 forbids. When nothing is readable
   * the honest note names the skipped definitions; when some graphs are
   * readable the skipped ids are still named beside them.
   */
  private renderDeclaredSessionList(): string {
    const view = this.storeView();
    const rows: Array<{ id: string; state: EngineState }> = [];
    const unreadable: string[] = [];
    for (const [id, entry] of this.declaredGraphs) {
      const state = this.liveDeclaredState(entry, view);
      if (state === undefined) {
        unreadable.push(id);
        continue;
      }
      rows.push({ id, state });
    }
    if (rows.length === 0) return persistedEmptyNote(view.scan);
    const lines = rows.map(
      (row) =>
        `  ${row.id}\t[phase: ${row.state.phase}]${controlMarker(
          view.scan.controls.get(row.id),
        )}\t${row.state.nodes.size} nodes`,
    );
    if (unreadable.length > 0) lines.push(skippedGraphsNote(unreadable));
    return `Graphs (${rows.length}):\n${lines.join("\n")}`;
  }

  /** The declared graphs' READABLE states, in declaration order. A stored graph
   * whose record this build cannot read is not among them (A19). */
  private declaredStates(): EngineState[] {
    const view = this.storeView();
    const out: EngineState[] = [];
    for (const [, entry] of this.declaredGraphs) {
      const state = this.liveDeclaredState(entry, view);
      if (state !== undefined) out.push(state);
    }
    return out;
  }

  /**
   * The directory holding this workspace's ONE graph store.
   *
   * EXACTLY the resolution the submission ingress and the host use: the
   * credential-isolation adapter's declared root when the host declares one
   * (the SHIPPED configuration — the store lives outside the workspace on
   * purpose), the workspace state directory otherwise. One function, so the
   * declaration, the status scan and the audit can never address two different
   * stores.
   */
  private storeDirectory(): string | undefined {
    const isolation = readCredentialIsolationAdapter(this.deps.credentialIsolation);
    if (isolation !== undefined) return isolation.credentialStoreRoot;
    if (this.deps.stateDir === undefined) return undefined;
    return engineStateDir(this.deps.stateDir);
  }

  /** Scan the workspace's graph store (see {@link storeDirectory}). */
  private persistedScan(): PersistedStateScan {
    return scanPersistedStates(
      this.storeDirectory() ?? engineStateDir(this.deps.stateDir ?? process.cwd()),
    );
  }

  /**
   * The durable control fact that stopped one graph's run, or `undefined`
   * (P3 item 1).
   *
   * Read from the SAME store scan the status views already perform, so a status
   * render can name the stop beside the recorded phase instead of presenting a
   * stopped run as one that is still executing. A graph whose control row is
   * unreadable is not in the scan's `loaded` set at all: it is refused by the
   * scan's own skipped-graph note rather than rendered as an unchecked run.
   */
  private runControlOf(graphId: string): RunControlRecord | undefined {
    return this.persistedScan().controls.get(graphId);
  }

  /** Declared states followed by persisted states, deduped by graphId (a
   * declared graph wins) — the node set the `all` scope aggregates over. A
   * stored graph this build cannot read contributes nothing: neither the
   * fabricated declaration snapshot nor a half-decoded row (A19). */
  private collectAllStates(): EngineState[] {
    const view = this.storeView();
    const seen = new Set<string>();
    const out: EngineState[] = [];
    for (const [, entry] of this.declaredGraphs) {
      const s = this.liveDeclaredState(entry, view);
      if (s === undefined) continue;
      if (!seen.has(s.graphId)) {
        seen.add(s.graphId);
        out.push(s);
      }
    }
    for (const p of view.recorded.values()) {
      if (!seen.has(p.graphId)) {
        seen.add(p.graphId);
        out.push(p);
      }
    }
    return out;
  }

  /**
   * The honest answer for a scope that yielded no readable graph.
   *
   * A scope that read the store and found definitions it cannot decode is NOT
   * "no graphs": `persistedEmptyNote` names the skipped definitions, and it is
   * the answer for `all` as well as `persisted` (an `all` query over a damaged
   * store must not claim the workspace holds nothing). Only a store that truly
   * holds no graph gets the `graph_declare` line.
   */
  private emptyScopeNote(scan: PersistedStateScan, scope: GraphStatusScope): string {
    if (scope === "persisted" || scan.blocked !== undefined || scan.skipped > 0) {
      return persistedEmptyNote(scan);
    }
    return "No graphs exist. Call graph_declare to declare one, which starts its entry nodes.";
  }

  /** No-target list for persisted/all scope: persisted graphs are shown, and an
   * empty store yields an explicit honest-empty note. */
  private renderScopedGraphList(scope: GraphStatusScope): string {
    const scan = this.persistedScan();
    const states = scope === "persisted" ? scan.loaded : this.collectAllStates();
    if (states.length === 0) return this.emptyScopeNote(scan, scope);
    const lines = states.map(
      (s) =>
        `  ${s.graphId}\t[phase: ${s.phase}]${controlMarker(
          scan.controls.get(s.graphId),
        )}\t${s.nodes.size} nodes`,
    );
    // Readable rows exist, but the store also holds definitions this build
    // cannot read: name them rather than dropping a graph the audit and the
    // boot sweep call blocked (A19).
    if (scan.skipped > 0) lines.push(skippedGraphsNote(scan.skippedGraphs));
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

    if (states.length === 0) return this.emptyScopeNote(scan, scope);

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
            graphs: states.map((s) => {
              const control = scan.controls.get(s.graphId);
              return {
                graph_id: s.graphId,
                phase: s.phase,
                node_count: s.nodes.size,
                ...(control === undefined ? {} : { control: controlSummary(control) }),
              };
            }),
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

  /**
   * Resolve a single graph target for persisted/all scope (a declared graph
   * wins for `all`; persisted store only for `persisted`).
   *
   * A graph the store HOLDS but this build cannot read is refused BY NAME
   * rather than answered as "not found": the audit and the boot sweep already
   * call that condition unreadable, and no position may be invented for it
   * (A19). Genuinely unknown ids keep the not-found error.
   */
  private resolveState(graphId: string, scope: GraphStatusScope): EngineState {
    const scan = this.persistedScan();
    const view = this.storeView(scan);
    if (scope === "all") {
      const entry = this.declaredGraphs.get(graphId);
      // A declared graph resolves through its LIVE record, never the
      // declaration snapshot the registry holds — and never a snapshot for a
      // record this build cannot read: that gets the same by-name refusal every
      // other scope gives (A19).
      if (entry) {
        const state = this.liveDeclaredState(entry, view);
        if (state !== undefined) return state;
        throw this.unreadableGraphError(graphId, scan);
      }
    }
    const found = view.recorded.get(graphId);
    if (found) return found;
    if (scan.blocked !== undefined || scan.skippedGraphs.includes(graphId)) {
      throw this.unreadableGraphError(graphId, scan);
    }
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
      // Ownership is DECLARATION content, so it resolves from each declared
      // graph's own node/loop set even when its stored position is unreadable:
      // the state resolution below then refuses by name instead of reporting
      // the graph as absent (A19).
      for (const [, entry] of this.declaredGraphs) consider([entry.graph.state]);
    }
    const scan = this.persistedScan();
    consider(scan.loaded);
    const list = [...matches];
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      throw new Error(
        `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} exists in ` +
          `multiple graphs (${list.join(", ")}); specify graph_id to disambiguate.`,
      );
    }
    // The id may belong to a stored definition this build cannot read — a store
    // whose verdict is 'absent' is the only case where the store can be ruled
    // out as the owner (A19).
    const unreadable =
      scan.blocked !== undefined
        ? `the store at ${scan.storeDirectory} cannot be read: ${scan.blocked}`
        : scan.skipped > 0
          ? `${scan.skipped} stored definition(s) this build cannot read ` +
            `(${scan.skippedGraphs.join(", ")})`
          : undefined;
    throw new Error(
      `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} not found in any ` +
        `readable graph.` +
        (unreadable === undefined
          ? ""
          : ` The store may hold it in ${unreadable}; graph_audit names the blocker.`),
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
      return this.exportForState(state, args);
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
    // THE DURABLE CONTROL FACT (P3 item 1, A09). A stopped run keeps its
    // recorded phase — the store holds both facts — so the phase line carries
    // the stop beside it and the detail line below names the command, the
    // reason and the instant it was decided. Read once, used by every format.
    const control = this.runControlOf(state.graphId);
    switch (args.format ?? "summary") {
      case "json": {
        const snapshot: GraphStatusSnapshot = {
          graph_id: state.graphId,
          phase: state.phase,
          nodes: limitNodes(visibleNodes(), args.limit).map((n) =>
            this.nodeSummary(state, n, args),
          ),
          // Conditional spreads: an unset flag leaves its key out entirely
          // instead of writing an explicit `undefined` that only
          // JSON.stringify happens to drop (Y27).
          ...(control === undefined ? {} : { control: controlSummary(control) }),
          ...(args.include_budget ? { budget: budgetSummary(state) } : {}),
          ...(args.include_loops
            ? {
                loops: [...state.loopGroups.values()].map((l) =>
                  this.loopSummary(state, l, loopNodeIds(state, l.id)),
                ),
              }
            : {}),
          ...(args.include_metrics ? { metrics: metricsSummary(state) } : {}),
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
          renderTree(state, nodeFilter, args.depth, control),
          state,
          args,
        );
      case "summary":
      default:
        return this.appendFlagSections(
          this.renderSummary(state, args, nodeFilter, control),
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
    control?: RunControlRecord,
  ): string {
    const nodes = nodeFilter
      ? [...nodeFilter].map((id) => state.nodes.get(id)).filter(
          (n): n is NodeRuntimeState => n !== undefined,
        )
      : [...state.nodes.values()];
    const lines: string[] = [];
    lines.push(
      `Graph "${state.graphId}"  [phase: ${state.phase}]${controlMarker(control)}`,
    );
    // THE STOP, SPELLED OUT (P3 item 1, A09): a stopped run renders the command,
    // the caller's reason and the decided instant right under its header, so
    // `executing` beside it can never be read as "still moving".
    if (control !== undefined) lines.push(controlLine(control));
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
    return paginate(lines.join("\n"), args);
  }

  private renderNode(state: EngineState, nodeId: string, args: GraphStatusArgs): string {
    const node = state.nodes.get(nodeId);
    if (!node) {
      throw new Error(`graph_status: unknown node "${nodeId}" in graph "${state.graphId}".`);
    }
    // THE RUN'S CONTROL FACT (P3 item 1, A09), read once for both formats: a
    // node's own status is a recorded fact and is never rewritten, but a
    // stopped run names the stop here so `running` is not read as "still
    // moving".
    const control = this.runControlOf(state.graphId);
    if (args.format === "json") {
      // JSON node view (monitor M8): serialize the shared nodeSummary — which
      // honors include_output by adding an `output` field with the node's
      // materialized result text — and merge node-scoped C-WIRE observability
      // data (checkpoints / artifacts / evidence / signal stream), mirroring the
      // text render's appendFlagSections scoping. Paginated like every other
      // JSON output so max_chars/offset/tail apply.
      const summary: GraphNodeSummary = {
        ...this.nodeSummary(state, node, args),
        ...(control === undefined ? {} : { control: controlSummary(control) }),
        ...flagData(state, { ...args, node_id: nodeId }),
      };
      return paginate(JSON.stringify(summary, null, 2), args);
    }
    const lines: string[] = [];
    lines.push(`Node "${nodeId}"`);
    if (control !== undefined) lines.push(controlLine(control));
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
   * Mode-dependent `export_path` handling for graph_status. Works from a state
   * so a declared (in-memory) and a hydrated (persisted) graph share the same
   * export logic. Two mutually exclusive modes, resolved by specificity
   * (node_id is the most specific):
   *   1. `node_id` set     -> export the node's materialized result text,
   *                             read from `MaterializedResultRef.sidecarPath`
   *                             via {@link resultText} (dispatch_export-style).
   *                             Throws when the node has no materialized result.
   *   2. `include_metrics` -> export a metrics JSON snapshot reusing
   *                             {@link metricsSummary} / {@link budgetSummary}
   *                             (dispatch_metrics-style).
   * Every mode writes atomically via {@link writeAtomic}.
   */
  private exportForState(state: EngineState, args: GraphStatusArgs): string {
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

    throw new Error(
      "graph_status: export_path needs a mode — pass node_id to export that node's " +
        "materialized result, or include_metrics to export a metrics snapshot. A " +
        "declared graph's declaration is authored by graph_declare, not re-serialized here.",
    );
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
   * Find the DECLARED graph that owns a given node or loop id. Used when
   * graph_status is called with `node_id`/`loop_id` but no `graph_id`.
   * Throws a clear error when not found or when the id is ambiguous across
   * multiple declared graphs.
   */
  private resolveOwningGraph(nodeId?: string, loopId?: string): string {
    const matches: string[] = [];
    for (const [id, entry] of this.declaredGraphs) {
      const state = entry.graph.state;
      const owns = nodeId
        ? state.nodes.has(nodeId)
        : loopId
          ? state.loopGroups.has(loopId)
          : false;
      if (owns) matches.push(id);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} exists in ` +
          `multiple graphs (${matches.join(", ")}); specify graph_id to disambiguate.`,
      );
    }
    throw new Error(
      `graph_status: ${nodeId ? `node "${nodeId}"` : `loop "${loopId}"`} not found in any declared graph.`,
    );
  }


  // ── graph_audit ────────────────────────────────────────────────────────────

  /**
   * Audit the on-disk graph store READ-ONLY (E stage entry): which graphs are
   * terminal, which are still in flight, and which cannot be read at all.
   *
   * The audit is STORE-level, not registry-level: it reads the same
   * `engine-*.json` set the startup sweep scans under the configured
   * `stateDir` (default cwd) plus the acceptance ledger's read-only open, and
   * it NEVER writes — no engine save, no ledger commit, no effect transition,
   * no schema initialization. The report is the evidence release gate the
   * legacy runtime's deletion was gated on (docs/graph-outcome-protocol.md
   * § "Implementation order and release gates"), and its verdict requires BOTH
   * halves: no blocker AND nothing in flight.
   */
  async graph_audit(): Promise<DrainAuditReport> {
    return auditGraphStore({
      directory: this.deps.stateDir ?? process.cwd(),
      // The SAME store the declaration, the submission ingress and the host
      // use (see `storeDirectory`), so the audit reads the records the run
      // actually wrote instead of reporting a healthy graph as "store absent".
      ...(this.storeDirectory() === undefined
        ? {}
        : { ledgerDirectory: this.storeDirectory() }),
      // The retired per-graph containers live where the WORKSPACE kept them,
      // which in the shipped configuration is not the store root: they are
      // reported from there, never read.
      retiredRecordDirectory: engineStateDir(this.deps.stateDir ?? process.cwd()),
    });
  }
}

/**
 * Construct the `graph_*` tool set.
 *
 * `index.ts` wraps each public method with a zod `args` schema and a
 * `defineTool` registration. The methods throw descriptive {@link Error}s on
 * invalid input; the wrapper converts those into agent-visible tool output.
 */
export function createGraphToolSet(deps?: GraphToolSetDeps): GraphToolSet {
  return new GraphToolSet(deps);
}

// Re-export the engine phase/status enums for callers that render status text.
export { EnginePhase, NodeStatus };
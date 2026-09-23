/**
 * Graph store — the ONE schema of the workspace-scoped authoritative database
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE SCHEMA IS THE UNIFIED SUBSTRATE. Before P1 item 3 the workspace kept
 * THREE durable authorities — the acceptance ledger
 * (`graph-acceptance-ledger.sqlite`: receipts, accepted events, pending effects,
 * run state), the host store (`rolebox-host-store.sqlite`: execution bindings
 * and credential records) and a whole-file JSON record of each graph's declaring
 * invocation (`host-invocation-origins.json`). Two of them committed on their
 * own and each called itself atomic, so no single transaction could make "the
 * acceptance, its effect and the host's bind to that effect" true together.
 * This module declares ONE file, ONE schema and ONE format identity for all
 * three: every table below lives in {@link GRAPH_STORE_FILE}, and
 * `GraphStore` is the one boundary that writes them.
 *
 * WHY THE FILE NAME IS THE LEDGER'S. The file name is durable identity, not
 * presentation: pointing this build at a different name would make every
 * committed receipt, accepted event and effect row an `absent` store, which is
 * exactly the "lost database is not a new graph" failure the plan forbids
 * (`A19`) and could re-dispatch work an earlier process already created. The
 * ledger's file already carries the strictest layout gate and the one
 * transaction boundary the protocol verified, so the converged store keeps that
 * identity and gains the tables it was missing. The retired host-store file is
 * NOT read, NOT converted and NOT treated as absent (see
 * {@link RETIRED_AUTHORITY_FILES} and `format.ts`).
 *
 * THE FORMAT VERSION IS THE LEDGER'S, BUMPED. `LEDGER_FORMAT_VERSION` moved to
 * 2 when the converged layout arrived: a version-1 file holds five of the ten
 * tables and none of the host records, and reading it as this build's store
 * would answer `absent` for every execution binding it never carried. It moved
 * to 3 with the RUN IDENTITY and the TRUSTED CONTROL records (P3 item 1): a
 * version-2 file holds neither, so it could not answer "which run is this, and
 * was it stopped by a trusted command?" — reading it as this build's store
 * would report every controlled run as merely executing. It moves to 4 with the
 * RUN-SCOPED layout (P3 item 2): a version-3 file keys the graph state, the
 * effects and the runs by GRAPH, which is exactly the one-run-per-graph
 * assumption re-execution makes false, so reading it as this build's store would
 * answer a later run's reader with the earlier run's effects and decisions.
 * Every older version is refused as an older format this build registers no
 * migration for (`unsupported`), never widened in place, never downgraded.
 *
 * EVERY UNIQUENESS THE PROTOCOL NEEDS IS STRUCTURAL, not a code path:
 * - one row per `(graph_id, effect_id)` (primary key of the execution table);
 * - `created` is impossible without a non-empty execution id (the CHECK);
 * - every claim of that row carries a GENERATION (`owner_generation`, minted at 1
 *   and raised by one on each ownership transition), so a superseded claim's
 *   late write is refused by the conditional update rather than applied;
 * - the last write a row refused — a stale confirmation, a divergent execution,
 *   an unproven delivery failure — is recorded on the row with a count, so the
 *   refusal outlives the process that asked;
 * - one credential record per `(graph_id, node_id, attempt_id)` (primary key),
 *   and a `retained` record cannot exist without a value (the CHECK);
 * - one accepted event per `(graph_id, attempt_id)` (primary key) — the same
 *   key carries at most one accepted RESULT;
 * - one receipt per `(graph_id, attempt_id, submission_id)` (primary key) — the
 *   submission idempotency key;
 * - one TRUSTED CONTROL DECISION per `(graph_id, run_id, node_id, attempt_id,
 *   command)` (primary key) — an attempt carries at most one STOPPING fact
 *   (`failure`/`cancel`/`timeout`/`budget-stop`) and at most one successor
 *   command (`retry`), which is what lets the attempt a retry SUPERSEDED keep
 *   the failure that prompted it while the retry itself stays idempotent on
 *   that attempt — and ONE run-level control fact per RUN, claimed by a
 *   conditional update so a racing second command cannot replace the command
 *   that stopped the run first;
 * - one immutable definition per graph, one run STATE per run, one run identity
 *   per `(graph, run)` with a graph-local `run_seq` whose greatest value is the
 *   CURRENT run, one re-execution decision per terminal run, and one declaring
 *   invocation per graph.
 *
 * Dependency leaf: this module imports only the ledger port (for the shared
 * format identity) and two path/utility helpers; no record model and no driver.
 */

import { join } from "node:path";

import { LEDGER_FORMAT_VERSION } from "../ledger/types.ts";
import { workspaceHash } from "../../utils/state-paths.ts";

// ── File and format identity ────────────────────────────────────────────────

/** The one authoritative store file a workspace owns. */
export const GRAPH_STORE_FILE = "graph-acceptance-ledger.sqlite" as const;

/**
 * The layout this build writes. It is the ledger's format identity because the
 * file IS the ledger's file — one number, one gate, one refusal.
 */
export const GRAPH_STORE_FORMAT_VERSION = LEDGER_FORMAT_VERSION;

/**
 * Authority files a PREVIOUS shape kept beside this store.
 *
 * They are not read, not converted and not deleted: a non-empty one makes the
 * workspace's host records `unsupported` rather than `absent`, because
 * answering `absent` for execution bindings that exist only there is what lets
 * a recovery create a second execution for one effect (`A04`/`A05`). The
 * one-time inventory and archive of such records is a later work package's job
 * (`§P6.4`); until then the honest answer is an explicit block that names the
 * file.
 */
export const RETIRED_AUTHORITY_FILES = Object.freeze([
  "rolebox-host-store.sqlite",
  "host-invocation-origins.json",
] as const);
/**
 * The PREFIX/SUFFIX pair of a retired authority a previous shape wrote one file
 * PER GRAPH under. The v2 engine-state container (`engine-<slug>.json`) held the
 * plan binding, the compiled plan, the execution-protocol identity and the
 * declared per-node fields of one graph, and `persistence/outcome-projection.ts`
 * used to overlay run progress on it. P1 item 5 stops writing it, so a root that
 * still holds one is exactly the "an existing record is never `absent`" case
 * {@link RETIRED_AUTHORITY_FILES} covers: a container this build has no decoder
 * for, whose graphs an operator must inventory and archive before that root
 * becomes a store (the gate that combines the two lists lives in `format.ts`).
 */
export const RETIRED_AUTHORITY_PREFIX = "engine-" as const;

/** The extension companions of {@link RETIRED_AUTHORITY_PREFIX}. */
export const RETIRED_AUTHORITY_SUFFIX = ".json" as const;

/**
 * The store root for one workspace, under the host's OWN data directory.
 *
 * The root is deliberately NOT inside the workspace: a dispatched worker runs
 * with the workspace as its root, so keeping the host's state beside it would
 * hand every worker the directory (never a defense by itself — see
 * `credential-vault.ts` — but the one path-shaped part of the boundary this
 * build can choose). The entry points pass their own data directory in, so this
 * module stays free of CLI/platform layering.
 */
export function graphStoreRoot(dataDir: string, workspaceDir: string): string {
  return join(dataDir, "host", workspaceHash(workspaceDir));
}

/** The authoritative store file inside `directory`. */
export function graphStoreFilePath(directory: string): string {
  return join(directory, GRAPH_STORE_FILE);
}

// ── Tables ──────────────────────────────────────────────────────────────────

/**
 * Every table this format version owns, by role.
 *
 * The names are the ones the two converged substrates already used wherever a
 * test or an operator could have learned them, so the file this build writes is
 * recognizable to a reader of the previous shape and no durable name moved
 * silently.
 */
export const GRAPH_STORE_TABLES = Object.freeze({
  /** The ONE format identity of the file. */
  meta: "ledger_meta",
  /** Receipts — the submission idempotency key. */
  receipts: "ledger_receipts",
  /** The accepted-event stream. */
  acceptedEvents: "ledger_accepted_events",
  /** The effect ledger (intent + lifecycle status). */
  pendingEffects: "ledger_pending_effects",
  /** The current run-state body of one graph. */
  graphState: "ledger_graph_state",
  /** The accepted business result of one settled attempt. */
  acceptedResults: "graph_accepted_results",
  /** The immutable graph definition and its compiled-plan snapshot. */
  definitions: "graph_definitions",
  /** The host's dispatch-execution bindings (pending/creating/created). */
  executions: "host_dispatch_executions",
  /** The host's per-attempt credential RECORDS (never values by default). */
  credentials: "host_attempt_credentials",
  /** The declaring invocation of one graph. */
  origins: "graph_invocation_origins",
  /** The runs of one graph, oldest first; the greatest run_seq is current. */
  runs: "graph_runs",
  /** The trusted control decisions and the run's control fact (P3 item 1). */
  controlDecisions: "graph_control_decisions",
  /** The trusted orders to re-execute a terminal run (P3 item 2). */
  runReexecutions: "graph_run_reexecutions",
});

/** The ledger's own table names, as the ledger port's reader knows them. */
export const GRAPH_STORE_LEDGER_TABLES = Object.freeze({
  meta: GRAPH_STORE_TABLES.meta,
  receipts: GRAPH_STORE_TABLES.receipts,
  acceptedEvents: GRAPH_STORE_TABLES.acceptedEvents,
  pendingEffects: GRAPH_STORE_TABLES.pendingEffects,
  graphState: GRAPH_STORE_TABLES.graphState,
});

/**
 * One DDL statement per table, in creation order.
 *
 * `IF NOT EXISTS` is deliberate: two processes may open a brand-new root at
 * the same moment (a host capability and the acceptance ledger are opened
 * independently), and the loser of that race must no-op and then VERIFY the file
 * rather than fail on an already-created table. Creation never happens for a
 * file that already holds user tables — `format.ts` decides that — so this
 * clause can never widen an existing store.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.meta} (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     format_version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.receipts} (
     graph_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     submission_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     proposal_digest TEXT NOT NULL,
     decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
     committed_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, attempt_id, submission_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.acceptedEvents} (
     graph_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     submission_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     outcome_id TEXT NOT NULL,
     accepted_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, attempt_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.pendingEffects} (
     graph_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     effect_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'done', 'failed')),
     PRIMARY KEY (graph_id, effect_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.graphState} (
     graph_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     body TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, run_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.acceptedResults} (
     graph_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     payload TEXT NOT NULL,
     accepted_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, attempt_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.definitions} (
     graph_id TEXT NOT NULL,
     declaration_digest TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     declaration TEXT NOT NULL,
     plan TEXT NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.executions} (
     graph_id TEXT NOT NULL,
     effect_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'creating', 'created')),
     owner_id TEXT NOT NULL,
     owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
     execution_id TEXT,
     task_id TEXT,
     claimed_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     released_at INTEGER,
     refused_kind TEXT CHECK (refused_kind IS NULL OR refused_kind IN ('stale-confirmation', 'conflicting-execution', 'unproven-failure')),
     refused_owner_id TEXT,
     refused_generation INTEGER CHECK (refused_generation IS NULL OR refused_generation >= 1),
     refused_execution_id TEXT,
     refused_at INTEGER,
     refused_count INTEGER NOT NULL DEFAULT 0 CHECK (refused_count >= 0),
     PRIMARY KEY (graph_id, effect_id),
     CHECK ((state = 'created') = (execution_id IS NOT NULL)),
     CHECK ((refused_kind IS NULL) = (refused_at IS NULL)),
     CHECK (released_at IS NULL OR state = 'pending')
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.credentials} (
     graph_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     retention TEXT NOT NULL CHECK (retention IN ('retained', 'not-retained')),
     credential TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, node_id, attempt_id),
     CHECK ((retention = 'retained') = (credential IS NOT NULL))
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.origins} (
     graph_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     agent TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id)
   )`,
  // THE RUN IDENTITIES (P3 items 1-2). One row per `(graph, run)`, written
  // INSIDE the transaction that commits the run's first state snapshot, so a run
  // identity without the state it names is unrepresentable. `run_seq` orders a
  // graph's runs and is UNIQUE within the graph: the greatest sequence is the
  // CURRENT run (what `readRun` answers), and a re-execution can only append
  // `run_seq + 1`, so two successors for one run are unrepresentable rather
  // than merely refused. `plan_revision` is part of the run's identity, not a
  // property of the graph: a superseded run's receipts keep addressing the
  // revision they were accepted under.
  //
  // Each row also carries the run's CONTROL FACT: the first trusted command
  // recorded for that run, claimed by a conditional update
  // (`WHERE control_command IS NULL`) so a racing second command is told which
  // command stopped the run instead of replacing it. The CHECK group makes a
  // half-written control fact (a command with no reason, no time or no
  // principal) unrepresentable.
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.runs} (
     graph_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     run_seq INTEGER NOT NULL CHECK (run_seq >= 1),
     plan_revision TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     control_command TEXT CHECK (control_command IS NULL OR control_command IN ('failure', 'cancel', 'timeout', 'retry', 'budget-stop')),
     control_reason TEXT,
     control_decided_at INTEGER,
     control_decided_by_session TEXT,
     control_decided_by_agent TEXT,
     PRIMARY KEY (graph_id, run_id),
     UNIQUE (graph_id, run_seq),
     CHECK ((control_command IS NULL) = (control_reason IS NULL)),
     CHECK ((control_command IS NULL) = (control_decided_at IS NULL)),
     CHECK ((control_command IS NULL) = (control_decided_by_session IS NULL)),
     CHECK (control_decided_by_agent IS NULL OR control_decided_by_session IS NOT NULL)
   )`,
  // THE TRUSTED CONTROL DECISIONS (P3 items 1-2). The primary key is
  // `(graph, run, node, attempt, command)`, so an attempt can never carry two
  // facts of the SAME command while a `retry` — a SUCCESSOR command, not a
  // competing terminal fact — is recordable beside the `failure`/`timeout`/
  // `cancel` that prompted it. The retry's `successor_attempt_id` is the link
  // to the attempt it minted, and the CHECK makes a retry without a successor
  // (or a successor on another command) unrepresentable.
  // `decided_by_session` is the principal the permission rule compared; the
  // agent is recorded when the host attributed one.
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.controlDecisions} (
     graph_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     command TEXT NOT NULL CHECK (command IN ('failure', 'cancel', 'timeout', 'retry', 'budget-stop')),
     reason TEXT NOT NULL,
     decided_at INTEGER NOT NULL,
     decided_by_session TEXT,
     decided_by_agent TEXT,
     successor_attempt_id TEXT,
     PRIMARY KEY (graph_id, run_id, node_id, attempt_id, command),
     CHECK ((command = 'retry') = (successor_attempt_id IS NOT NULL)),
     CHECK (decided_by_agent IS NULL OR decided_by_session IS NOT NULL)
   )`,
  // THE RE-EXECUTION DECISIONS (P3 item 2). One row per terminal run a trusted
  // principal ordered re-executed: it names the run, the reason, the time and
  // the principal, and — once the successor committed — WHICH run succeeded it.
  // It is a DECISION, never a run: it carries no state, no attempt and no plan,
  // so it cannot be read as a second run table. The order is durable before any
  // run is minted (the same shape a dispatch intent has), and the successor link
  // is written exactly once, inside the transaction that mints the successor, so
  // an executed order can never be replayed into a second run.
  `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES.runReexecutions} (
     graph_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     reason TEXT NOT NULL,
     decided_at INTEGER NOT NULL,
     decided_by_session TEXT,
     decided_by_agent TEXT,
     successor_run_id TEXT,
     successor_started_at INTEGER,
     PRIMARY KEY (graph_id, run_id),
     CHECK ((successor_run_id IS NULL) = (successor_started_at IS NULL)),
     CHECK (decided_by_agent IS NULL OR decided_by_session IS NOT NULL)
   )`,
];

// ── Expected column shapes ──────────────────────────────────────────────────

/**
 * One column this format version writes, as the shape gate expects it.
 *
 * `affinity` is SQLite's storage class rather than the spelled type, so the
 * gate compares what a column MEANS: `TEXT` and `VARCHAR` name the same
 * column, `BLOB` where this format writes `TEXT` does not. `primaryKey` is
 * the column's position in the PRIMARY KEY (0 = not part of it), which is how
 * the uniqueness the protocol needs is verified as STRUCTURAL rather than
 * trusted; `notNull` mirrors the declaration.
 */
export interface GraphStoreColumn {
  readonly name: string;
  readonly affinity: "text" | "integer";
  readonly primaryKey: number;
  readonly notNull: boolean;
}

/**
 * The exact column shape of every table this format version writes.
 *
 * The gate compares a store against THIS, not against table names alone: a
 * table can be missing, renamed, retyped or keyless, and the first statement
 * against it would then fail with a raw driver error instead of the typed
 * refusal a foreign store gets. Columns are matched by NAME — every query
 * addresses columns by name, so order is not identity — and the list is
 * exhaustive, because this format writes exactly these columns and an extra one
 * is a reshape too. The `id` of the meta table is an `INTEGER PRIMARY KEY`,
 * the rowid alias SQLite reports as nullable; the gate records the declaration,
 * not the intent.
 */
export const GRAPH_STORE_COLUMNS: Readonly<
  Record<keyof typeof GRAPH_STORE_TABLES, readonly GraphStoreColumn[]>
> = Object.freeze({
  meta: [
    { name: "id", affinity: "integer", primaryKey: 1, notNull: false },
    { name: "format_version", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  receipts: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "submission_id", affinity: "text", primaryKey: 3, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "proposal_digest", affinity: "text", primaryKey: 0, notNull: true },
    { name: "decision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "committed_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  acceptedEvents: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "submission_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "outcome_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "accepted_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  pendingEffects: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "run_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "effect_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "kind", affinity: "text", primaryKey: 0, notNull: true },
    { name: "payload", affinity: "text", primaryKey: 0, notNull: true },
    { name: "created_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "status", affinity: "text", primaryKey: 0, notNull: true },
  ],
  graphState: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "body", affinity: "text", primaryKey: 0, notNull: true },
    { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  acceptedResults: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "payload", affinity: "text", primaryKey: 0, notNull: true },
    { name: "accepted_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  definitions: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "declaration_digest", affinity: "text", primaryKey: 0, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "declaration", affinity: "text", primaryKey: 0, notNull: true },
    { name: "plan", affinity: "text", primaryKey: 0, notNull: true },
    { name: "recorded_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  executions: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "effect_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "state", affinity: "text", primaryKey: 0, notNull: true },
    { name: "owner_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "owner_generation", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "execution_id", affinity: "text", primaryKey: 0, notNull: false },
    { name: "task_id", affinity: "text", primaryKey: 0, notNull: false },
    { name: "claimed_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "released_at", affinity: "integer", primaryKey: 0, notNull: false },
    { name: "refused_kind", affinity: "text", primaryKey: 0, notNull: false },
    { name: "refused_owner_id", affinity: "text", primaryKey: 0, notNull: false },
    { name: "refused_generation", affinity: "integer", primaryKey: 0, notNull: false },
    { name: "refused_execution_id", affinity: "text", primaryKey: 0, notNull: false },
    { name: "refused_at", affinity: "integer", primaryKey: 0, notNull: false },
    { name: "refused_count", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  credentials: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "node_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 3, notNull: true },
    { name: "retention", affinity: "text", primaryKey: 0, notNull: true },
    { name: "credential", affinity: "text", primaryKey: 0, notNull: false },
    { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  origins: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "session_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "agent", affinity: "text", primaryKey: 0, notNull: false },
    { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  runs: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "run_seq", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "started_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "control_command", affinity: "text", primaryKey: 0, notNull: false },
    { name: "control_reason", affinity: "text", primaryKey: 0, notNull: false },
    { name: "control_decided_at", affinity: "integer", primaryKey: 0, notNull: false },
    { name: "control_decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
    { name: "control_decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
  ],
  controlDecisions: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "node_id", affinity: "text", primaryKey: 3, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 4, notNull: true },
    { name: "command", affinity: "text", primaryKey: 5, notNull: true },
    { name: "reason", affinity: "text", primaryKey: 0, notNull: true },
    { name: "decided_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
    { name: "decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
    { name: "successor_attempt_id", affinity: "text", primaryKey: 0, notNull: false },
  ],
  runReexecutions: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "reason", affinity: "text", primaryKey: 0, notNull: true },
    { name: "decided_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
    { name: "decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
    { name: "successor_run_id", affinity: "text", primaryKey: 0, notNull: false },
    { name: "successor_started_at", affinity: "integer", primaryKey: 0, notNull: false },
  ],
});

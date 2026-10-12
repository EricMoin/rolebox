import { join } from "node:path";

import { LEDGER_FORMAT_VERSION, STOPPING_CONTROL_COMMANDS } from "../ledger/types.ts";
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
  workerChannels: "host_worker_channels",
  executionObservations: "host_execution_observations",
  /** The runs of one graph, oldest first; the greatest run_seq is current. */
  runs: "graph_runs",
  /** The trusted control decisions and the run's control fact (P3 item 1). */
  controlDecisions: "graph_control_decisions",
  /** The trusted orders to re-execute a terminal run (P3 item 2). */
  runReexecutions: "graph_run_reexecutions",
  /** The durable approval requests and their trusted decisions (P3 item 3). */
  approvalRequests: "graph_approval_requests",
  /** The dispatch budget reservations and their recorded usage (P3 item 3). */
  budgetReservations: "graph_dispatch_reservations",
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
 * The STOPPING control commands as the SQL `IN` list the store's guards spell.
 *
 * THE LIST IS DERIVED, NOT RE-SPELLED. {@link STOPPING_CONTROL_COMMANDS} is the
 * one owner of the classification, but SQL cannot import a TypeScript array, so
 * the literal is generated here ONCE from that owner and interpolated at every
 * guard site. A command added to the classification therefore reaches every
 * guard in the same edit; a second hand-written list is exactly how a store
 * ends up committing contradictory terminal facts about one attempt. The
 * members are closed literals of the control vocabulary, so the interpolation
 * cannot carry anything a submission supplied.
 */
export const STOPPING_CONTROL_COMMAND_SQL: string = STOPPING_CONTROL_COMMANDS
  .map((command) => `'${command}'`)
  .join(", ");

// ── The column catalog: one spelling of every column ────────────────────────

/**
 * SQLite's storage class — the one vocabulary the catalog, the generated DDL
 * and the format gate all name.
 *
 * It is deliberately NOT the spelled type: the gate compares what a column
 * MEANS (`TEXT` and `VARCHAR` name the same column). `numeric` is the class a
 * REAL/DOUBLE/DECIMAL column has and is what the budget rows' cost columns
 * declare: a monetary amount is not a count, and forcing it into an INTEGER
 * column would truncate exactly the fraction a real overrun is reported in.
 */
type GraphStoreAffinity = "text" | "integer" | "numeric";

/**
 * ONE column, stated ONCE.
 *
 * This is the source of truth the store slice was missing: the DDL text for a
 * column and the {@link GraphStoreColumn} shape the format gate compares are
 * BOTH derived from an entry of this shape, so a column cannot exist in one
 * spelling and not the other. `columnDefinitionOf` below spells the DDL from
 * `name`, `affinity`, `notNull`, `primaryKey` and the entry's own constraints;
 * `catalogOf` projects the same fields into the gate's expectation. A
 * DDL-only column edit — the change that used to make this build refuse the
 * store it had just created — is no longer expressible.
 *
 * The fields the gate does not consume are exactly the DDL's own remainder:
 * `checks` is the column's CHECK expressions verbatim, `defaultSql` the literal
 * a DEFAULT clause spells, and `inlinePrimaryKey` says that the SINGLE key
 * clause of `ledger_meta`, `host_worker_channels` and
 * `host_execution_observations` is spelled on the column line rather than as a
 * table constraint. No field restates another: the key's POSITION is
 * `primaryKey` and the flag only says WHERE its clause is spelled, which is the
 * pair the catalog-consistency test pins.
 */
interface GraphStoreColumnSpec {
  /** The one name every spelling of this column uses. */
  readonly name: string;
  /** SQLite's storage class; `columnDefinitionOf` spells its SQL type. */
  readonly affinity: GraphStoreAffinity;
  /** Position in the table's PRIMARY KEY (0 = not part of it). */
  readonly primaryKey: number;
  /** Whether the column declaration carries NOT NULL. */
  readonly notNull: boolean;
  /** The column's CHECK expressions, verbatim and in declaration order. */
  readonly checks?: readonly string[];
  /** The literal a DEFAULT clause spells; absent = no DEFAULT clause. */
  readonly defaultSql?: string;
  /** True when this column's PRIMARY KEY is spelled on its own line. */
  readonly inlinePrimaryKey?: boolean;
}

/**
 * ONE table's catalog: its columns and the clauses that are not a column.
 *
 * `constraints` carries the table-level clauses that are neither a column nor a
 * CHECK, in declaration order (only `runs` has one, its `UNIQUE`), and `checks`
 * the table-level CHECK expressions. The PRIMARY KEY clause is deliberately NOT
 * here: `createTableStatementOf` generates it from the columns' `primaryKey`
 * positions, so the key's order and the column declarations cannot disagree.
 */
interface GraphStoreTableSpec {
  readonly columns: readonly GraphStoreColumnSpec[];
  readonly constraints?: readonly string[];
  readonly checks?: readonly string[];
}

/**
 * The column catalog of every table this format version writes.
 *
 * THE ONE SPELLING. {@link SCHEMA_STATEMENTS} and {@link GRAPH_STORE_COLUMNS}
 * are both generated from this object; nothing else in this module names a
 * column. `satisfies` checks every entry against {@link GraphStoreTableSpec} and
 * the key set against {@link GRAPH_STORE_TABLES}, so a missing table or a
 * mistyped field is a compile error, while `as const` keeps every column name a
 * literal for {@link GraphStoreColumnName} to be derived from.
 */
const GRAPH_STORE_TABLE_SPECS = {
  meta: {
    columns: [
      { name: "id", affinity: "integer", primaryKey: 1, notNull: false, inlinePrimaryKey: true, checks: ["id = 1"] },
      { name: "format_version", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "store_id", affinity: "text", primaryKey: 0, notNull: true },
    ],
  },
  receipts: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "submission_id", affinity: "text", primaryKey: 3, notNull: true },
      { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
      { name: "proposal_digest", affinity: "text", primaryKey: 0, notNull: true },
      { name: "decision", affinity: "text", primaryKey: 0, notNull: true, checks: ["decision IN ('accepted', 'rejected')"] },
      { name: "committed_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  acceptedEvents: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "submission_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
      { name: "outcome_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "accepted_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  pendingEffects: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "effect_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "kind", affinity: "text", primaryKey: 0, notNull: true },
      { name: "payload", affinity: "text", primaryKey: 0, notNull: true },
      { name: "created_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "status", affinity: "text", primaryKey: 0, notNull: true, checks: ["status IN ('pending', 'started', 'done', 'failed')"] },
    ],
  },
  graphState: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
      { name: "body", affinity: "text", primaryKey: 0, notNull: true },
      { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  acceptedResults: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
      { name: "payload", affinity: "text", primaryKey: 0, notNull: true },
      // The retained artifact revisions, as JSON text. NULLABLE on purpose: an
      // acceptance that retained none is a legitimate row, and `NULL` says so
      // rather than an empty array pretending the question was answered.
      { name: "artifacts", affinity: "text", primaryKey: 0, notNull: false },
      { name: "accepted_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  definitions: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "declaration_digest", affinity: "text", primaryKey: 0, notNull: true },
      { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
      { name: "declaration", affinity: "text", primaryKey: 0, notNull: true },
      { name: "plan", affinity: "text", primaryKey: 0, notNull: true },
      { name: "recorded_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  executions: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "effect_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "state", affinity: "text", primaryKey: 0, notNull: true, checks: ["state IN ('pending', 'creating', 'created')"] },
      { name: "owner_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "owner_generation", affinity: "integer", primaryKey: 0, notNull: true, checks: ["owner_generation >= 1"] },
      { name: "execution_id", affinity: "text", primaryKey: 0, notNull: false },
      { name: "task_id", affinity: "text", primaryKey: 0, notNull: false },
      { name: "claimed_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "released_at", affinity: "integer", primaryKey: 0, notNull: false },
      { name: "refused_kind", affinity: "text", primaryKey: 0, notNull: false, checks: ["refused_kind IS NULL OR refused_kind IN ('stale-confirmation', 'conflicting-execution', 'unproven-failure')"] },
      { name: "refused_owner_id", affinity: "text", primaryKey: 0, notNull: false },
      { name: "refused_generation", affinity: "integer", primaryKey: 0, notNull: false, checks: ["refused_generation IS NULL OR refused_generation >= 1"] },
      { name: "refused_execution_id", affinity: "text", primaryKey: 0, notNull: false },
      { name: "refused_at", affinity: "integer", primaryKey: 0, notNull: false },
      { name: "refused_count", affinity: "integer", primaryKey: 0, notNull: true, defaultSql: "0", checks: ["refused_count >= 0"] },
    ],
    checks: ["(state = 'created') = (execution_id IS NOT NULL)", "(refused_kind IS NULL) = (refused_at IS NULL)", "released_at IS NULL OR state = 'pending'"],
  },
  credentials: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "node_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 3, notNull: true },
      { name: "retention", affinity: "text", primaryKey: 0, notNull: true, checks: ["retention IN ('retained', 'not-retained')"] },
      { name: "credential", affinity: "text", primaryKey: 0, notNull: false },
      { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
    checks: ["(retention = 'retained') = (credential IS NOT NULL)"],
  },
  origins: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "session_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "agent", affinity: "text", primaryKey: 0, notNull: false },
      { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  workerChannels: {
    columns: [
      { name: "token_digest", affinity: "text", primaryKey: 1, notNull: true, inlinePrimaryKey: true },
      { name: "session_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "agent", affinity: "text", primaryKey: 0, notNull: true },
    ],
    checks: ["length(token_digest) = 64", "length(session_id) > 0"],
  },
  executionObservations: {
    columns: [
      { name: "execution_id", affinity: "text", primaryKey: 1, notNull: true, inlinePrimaryKey: true },
      { name: "outcome", affinity: "text", primaryKey: 0, notNull: true, checks: ["outcome IN ('completed', 'failed')"] },
      { name: "reason", affinity: "text", primaryKey: 0, notNull: true },
      { name: "observed_at", affinity: "integer", primaryKey: 0, notNull: true },
    ],
  },
  runs: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "run_seq", affinity: "integer", primaryKey: 0, notNull: true, checks: ["run_seq >= 1"] },
      { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
      { name: "started_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "control_command", affinity: "text", primaryKey: 0, notNull: false, checks: ["control_command IS NULL OR control_command IN ('failure', 'cancel', 'timeout', 'retry', 'budget-stop', 'approval-request', 'approve', 'reject')"] },
      { name: "control_reason", affinity: "text", primaryKey: 0, notNull: false },
      { name: "control_decided_at", affinity: "integer", primaryKey: 0, notNull: false },
      { name: "control_decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
      { name: "control_decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
    ],
    constraints: ["UNIQUE (graph_id, run_seq)"],
    checks: ["(control_command IS NULL) = (control_reason IS NULL)", "(control_command IS NULL) = (control_decided_at IS NULL)", "(control_command IS NULL) = (control_decided_by_session IS NULL)", "control_decided_by_agent IS NULL OR control_decided_by_session IS NOT NULL"],
  },
  controlDecisions: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "node_id", affinity: "text", primaryKey: 3, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 4, notNull: true },
      { name: "command", affinity: "text", primaryKey: 5, notNull: true, checks: ["command IN ('failure', 'cancel', 'timeout', 'retry', 'budget-stop', 'approval-request', 'approve', 'reject')"] },
      { name: "reason", affinity: "text", primaryKey: 0, notNull: true },
      { name: "decided_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
      { name: "decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
      { name: "successor_attempt_id", affinity: "text", primaryKey: 0, notNull: false },
    ],
    checks: ["(command = 'retry') = (successor_attempt_id IS NOT NULL)", "decided_by_agent IS NULL OR decided_by_session IS NOT NULL"],
  },
  runReexecutions: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "reason", affinity: "text", primaryKey: 0, notNull: true },
      { name: "decided_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
      { name: "decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
      { name: "successor_run_id", affinity: "text", primaryKey: 0, notNull: false },
      { name: "successor_started_at", affinity: "integer", primaryKey: 0, notNull: false },
    ],
    checks: ["(successor_run_id IS NULL) = (successor_started_at IS NULL)", "decided_by_agent IS NULL OR decided_by_session IS NOT NULL"],
  },
  approvalRequests: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "node_id", affinity: "text", primaryKey: 3, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 4, notNull: true },
      { name: "status", affinity: "text", primaryKey: 0, notNull: true, checks: ["status IN ('pending', 'approved', 'rejected', 'expired')"] },
      { name: "reason", affinity: "text", primaryKey: 0, notNull: true },
      { name: "requested_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "requested_by_session", affinity: "text", primaryKey: 0, notNull: false },
      { name: "requested_by_agent", affinity: "text", primaryKey: 0, notNull: false },
      { name: "approver_session_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "authority", affinity: "text", primaryKey: 0, notNull: true },
      { name: "expires_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "decided_by_session", affinity: "text", primaryKey: 0, notNull: false },
      { name: "decided_by_agent", affinity: "text", primaryKey: 0, notNull: false },
      { name: "decided_at", affinity: "integer", primaryKey: 0, notNull: false },
      { name: "decision_reason", affinity: "text", primaryKey: 0, notNull: false },
    ],
    checks: ["(status = 'pending') = (decided_at IS NULL)", "(status = 'pending') = (decision_reason IS NULL)", "(status <> 'approved' AND status <> 'rejected') OR decided_by_session IS NOT NULL", "(requested_by_agent IS NULL) OR (requested_by_session IS NOT NULL)", "decided_by_agent IS NULL OR decided_by_session IS NOT NULL", "length(approver_session_id) > 0"],
  },
  budgetReservations: {
    columns: [
      { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
      { name: "run_id", affinity: "text", primaryKey: 2, notNull: true },
      { name: "node_id", affinity: "text", primaryKey: 3, notNull: true },
      { name: "attempt_id", affinity: "text", primaryKey: 4, notNull: true },
      { name: "effect_id", affinity: "text", primaryKey: 0, notNull: true },
      { name: "status", affinity: "text", primaryKey: 0, notNull: true, checks: ["status IN ('reserved', 'reconciled', 'released')"] },
      { name: "checked_duration_ms", affinity: "integer", primaryKey: 0, notNull: false, checks: ["checked_duration_ms IS NULL OR checked_duration_ms >= 0"] },
      { name: "checked_input_tokens", affinity: "integer", primaryKey: 0, notNull: false, checks: ["checked_input_tokens IS NULL OR checked_input_tokens >= 0"] },
      { name: "checked_output_tokens", affinity: "integer", primaryKey: 0, notNull: false, checks: ["checked_output_tokens IS NULL OR checked_output_tokens >= 0"] },
      { name: "checked_cost_usd", affinity: "numeric", primaryKey: 0, notNull: false, checks: ["checked_cost_usd IS NULL OR checked_cost_usd >= 0"] },
      { name: "reserved_executions", affinity: "integer", primaryKey: 0, notNull: true, checks: ["reserved_executions >= 0"] },
      { name: "reserved_duration_ms", affinity: "integer", primaryKey: 0, notNull: true, checks: ["reserved_duration_ms >= 0"] },
      { name: "reserved_input_tokens", affinity: "integer", primaryKey: 0, notNull: true, checks: ["reserved_input_tokens >= 0"] },
      { name: "reserved_output_tokens", affinity: "integer", primaryKey: 0, notNull: true, checks: ["reserved_output_tokens >= 0"] },
      { name: "reserved_cost_usd", affinity: "numeric", primaryKey: 0, notNull: true, checks: ["reserved_cost_usd >= 0"] },
      { name: "used_executions", affinity: "integer", primaryKey: 0, notNull: false, checks: ["used_executions IS NULL OR used_executions >= 0"] },
      { name: "used_duration_ms", affinity: "integer", primaryKey: 0, notNull: false, checks: ["used_duration_ms IS NULL OR used_duration_ms >= 0"] },
      { name: "used_input_tokens", affinity: "integer", primaryKey: 0, notNull: false, checks: ["used_input_tokens IS NULL OR used_input_tokens >= 0"] },
      { name: "used_output_tokens", affinity: "integer", primaryKey: 0, notNull: false, checks: ["used_output_tokens IS NULL OR used_output_tokens >= 0"] },
      { name: "used_cost_usd", affinity: "numeric", primaryKey: 0, notNull: false, checks: ["used_cost_usd IS NULL OR used_cost_usd >= 0"] },
      { name: "reserved_at", affinity: "integer", primaryKey: 0, notNull: true },
      { name: "settled_at", affinity: "integer", primaryKey: 0, notNull: false },
    ],
    checks: ["(status = 'reserved') = (settled_at IS NULL)", "(status = 'reconciled') = (used_executions IS NOT NULL)", "(status = 'reconciled') = (used_duration_ms IS NOT NULL)", "(status = 'reconciled') = (used_input_tokens IS NOT NULL)", "(status = 'reconciled') = (used_output_tokens IS NOT NULL)", "(status = 'reconciled') = (used_cost_usd IS NOT NULL)"],
  },
} as const satisfies Readonly<Record<keyof typeof GRAPH_STORE_TABLES, GraphStoreTableSpec>>;

// ── Derived column identity ─────────────────────────────────────────────────

/**
 * Every column name this format version writes, as a CLOSED union derived from
 * the catalog above.
 *
 * `GraphStoreColumn.name` used to be a bare `string`, so every query list, every
 * reader and every caller could name any column at all and the compiler said
 * nothing. Now the only names in the type are the ones the catalog declares: a
 * column added to the DDL without a catalog entry — or renamed in one spelling
 * only — cannot be spelled, because there is no second spelling to edit.
 */
export type GraphStoreColumnName =
  (typeof GRAPH_STORE_TABLE_SPECS)[keyof typeof GRAPH_STORE_TABLE_SPECS]["columns"][number]["name"];

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
  readonly name: GraphStoreColumnName;
  /** SQLite's storage class; see {@link GraphStoreAffinity}. */
  readonly affinity: GraphStoreAffinity;
  readonly primaryKey: number;
  readonly notNull: boolean;
}

// ── The DDL and the expectation, both generated from the catalog ────────────

/** SQLite's storage class → the SQL type this format's DDL spells for it. */
const SQL_TYPE_OF_AFFINITY = {
  text: "TEXT",
  integer: "INTEGER",
  numeric: "REAL",
} as const satisfies Readonly<Record<GraphStoreAffinity, string>>;

/** `role`'s catalog entry, keeping this table's literal column names. */
function tableSpecOf<Role extends keyof typeof GRAPH_STORE_TABLES>(
  role: Role,
): (typeof GRAPH_STORE_TABLE_SPECS)[Role] {
  return GRAPH_STORE_TABLE_SPECS[role];
}

/**
 * One column line of a CREATE TABLE, assembled from its catalog entry.
 *
 * The clause order is the one this format has always written: name, SQL type,
 * NOT NULL, an inline PRIMARY KEY, DEFAULT, then the column's CHECKs. Nothing
 * is decided twice — every clause is a field of `column`.
 */
function columnDefinitionOf(column: GraphStoreColumnSpec, inlinePrimaryKey: boolean): string {
  const definition = [`${column.name} ${SQL_TYPE_OF_AFFINITY[column.affinity]}`];
  if (column.notNull) definition.push("NOT NULL");
  if (inlinePrimaryKey) definition.push("PRIMARY KEY");
  if (column.defaultSql !== undefined) definition.push(`DEFAULT ${column.defaultSql}`);
  for (const check of column.checks ?? []) definition.push(`CHECK (${check})`);
  return definition.join(" ");
}

/**
 * The CREATE TABLE statement of `role`, generated from its catalog entry.
 *
 * The PRIMARY KEY clause is GENERATED: the columns carrying a `primaryKey`
 * position are emitted in position order, unless the entry declares its single
 * key inline (`ledger_meta.id`, `host_worker_channels.token_digest`,
 * `host_execution_observations.execution_id` — the three tables whose key
 * clause is spelled on the column line). The table-level clauses then follow in
 * their declaration order, the CHECKs last.
 */
function createTableStatementOf(role: keyof typeof GRAPH_STORE_TABLES): string {
  const spec: GraphStoreTableSpec = GRAPH_STORE_TABLE_SPECS[role];
  const lines: string[] = [];
  for (const column of spec.columns) {
    lines.push(`     ${columnDefinitionOf(column, column.inlinePrimaryKey === true)}`);
  }
  if (!spec.columns.some((column) => column.inlinePrimaryKey === true)) {
    const key = spec.columns
      .filter((column) => column.primaryKey > 0)
      .sort((left, right) => left.primaryKey - right.primaryKey)
      .map((column) => column.name);
    lines.push(`     PRIMARY KEY (${key.join(", ")})`);
  }
  for (const constraint of spec.constraints ?? []) lines.push(`     ${constraint}`);
  for (const check of spec.checks ?? []) lines.push(`     CHECK (${check})`);
  return `CREATE TABLE IF NOT EXISTS ${GRAPH_STORE_TABLES[role]} (\n${lines.join(",\n")}\n   )`;
}

/** `role`'s columns, projected from the catalog into the gate's expectation. */
function catalogOf<Role extends keyof typeof GRAPH_STORE_TABLES>(
  role: Role,
): readonly GraphStoreColumn[] {
  const spec = tableSpecOf(role);
  return Object.freeze(
    spec.columns.map(
      (column): GraphStoreColumn => ({
        name: column.name,
        affinity: column.affinity,
        primaryKey: column.primaryKey,
        notNull: column.notNull,
      }),
    ),
  );
}

/**
 * One DDL statement per table, in creation order, GENERATED from the catalog.
 *
 * `IF NOT EXISTS` is deliberate: two processes may open a brand-new root at
 * the same moment (a host capability and the acceptance ledger are opened
 * independently), and the loser of that race must no-op and then VERIFY the file
 * rather than fail on an already-created table. Creation never happens for a
 * file that already holds user tables — `format.ts` decides that — so this
 * clause can never widen an existing store.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  createTableStatementOf("meta"),
  createTableStatementOf("receipts"),
  createTableStatementOf("acceptedEvents"),
  createTableStatementOf("pendingEffects"),
  createTableStatementOf("graphState"),
  createTableStatementOf("acceptedResults"),
  createTableStatementOf("definitions"),
  createTableStatementOf("executions"),
  createTableStatementOf("credentials"),
  createTableStatementOf("executionObservations"),
  createTableStatementOf("workerChannels"),
  createTableStatementOf("origins"),
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
  createTableStatementOf("runs"),
  // THE TRUSTED CONTROL DECISIONS (P3 items 1-2). The primary key is
  // `(graph, run, node, attempt, command)`, so an attempt can never carry two
  // facts of the SAME command while a `retry` — a SUCCESSOR command, not a
  // competing terminal fact — is recordable beside the `failure`/`timeout`/
  // `cancel` that prompted it. The retry's `successor_attempt_id` is the link
  // to the attempt it minted, and the CHECK makes a retry without a successor
  // (or a successor on another command) unrepresentable.
  // `decided_by_session` is the principal the permission rule compared; the
  // agent is recorded when the host attributed one.
  createTableStatementOf("controlDecisions"),
  // THE RE-EXECUTION DECISIONS (P3 item 2). One row per terminal run a trusted
  // principal ordered re-executed: it names the run, the reason, the time and
  // the principal, and — once the successor committed — WHICH run succeeded it.
  // It is a DECISION, never a run: it carries no state, no attempt and no plan,
  // so it cannot be read as a second run table. The order is durable before any
  // run is minted (the same shape a dispatch intent has), and the successor link
  // is written exactly once, inside the transaction that mints the successor, so
  // an executed order can never be replayed into a second run.
  createTableStatementOf("runReexecutions"),
  // THE DURABLE APPROVAL REQUESTS (P3 item 3). One row per ATTEMPT: the row is
  // the pause, its status is the answer, and the acceptance gate reads exactly
  // this row. `status` is `pending` until a trusted decision records one of the
  // three terminal answers, and every terminal status is written by a
  // CONDITIONAL UPDATE of the `pending` row (`WHERE status = 'pending'`), so a
  // repeated or competing decision writes NOTHING and is answered with the fact
  // that stands. The CHECK group makes a half-written decision — a status with
  // no approver, time or reason, or a `pending` row carrying one —
  // unrepresentable. `approver_session_id` is the ONLY session whose decision
  // resolves the request; `expires_at` is the explicit deadline expiry is
  // measured against, never a clock read by the store.
  createTableStatementOf("approvalRequests"),
  // THE DISPATCH BUDGET RESERVATIONS (P3 item 3, the budget). ONE row per ARMED
  // DISPATCH, keyed by the attempt it authorizes, so the reservation is the
  // attempt's own fact and a repeated reservation replays. The row carries three
  // kinds of numbers that must not be confused: `checked_*` is the CEILING the
  // declaration authorized (NULL = the declaration declared none for that
  // dimension), `reserved_*` is how much of it this dispatch CLAIMED, and
  // `used_*` is the REAL usage once the host reports it. The status is the
  // reconciliation state machine: `reserved` (the claim is outstanding),
  // `reconciled` (real usage recorded — the only status that carries `used_*`)
  // or `released` (the attempt ended with NO usage report; its claim is
  // withdrawn and its consumption stays UNKNOWN rather than being recorded as
  // zero). Every used/checked number is constrained non-negative, and the CHECK
  // group makes a half-written row — a status without its settlement time, or a
  // `reconciled` row without its used amounts — unrepresentable.
  createTableStatementOf("budgetReservations"),
];

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
 *
 * GENERATED from {@link GRAPH_STORE_TABLE_SPECS}: the same entries that spell
 * the DDL, so the file this build creates is the file it accepts, and a column
 * the file carries but the catalog does not is refused BY NAME with the table
 * it was found in.
 */
export const GRAPH_STORE_COLUMNS: Readonly<
  Record<keyof typeof GRAPH_STORE_TABLES, readonly GraphStoreColumn[]>
> = Object.freeze({
  meta: catalogOf("meta"),
  receipts: catalogOf("receipts"),
  acceptedEvents: catalogOf("acceptedEvents"),
  pendingEffects: catalogOf("pendingEffects"),
  graphState: catalogOf("graphState"),
  acceptedResults: catalogOf("acceptedResults"),
  definitions: catalogOf("definitions"),
  executions: catalogOf("executions"),
  credentials: catalogOf("credentials"),
  executionObservations: catalogOf("executionObservations"),
  workerChannels: catalogOf("workerChannels"),
  origins: catalogOf("origins"),
  runs: catalogOf("runs"),
  controlDecisions: catalogOf("controlDecisions"),
  runReexecutions: catalogOf("runReexecutions"),
  approvalRequests: catalogOf("approvalRequests"),
  budgetReservations: catalogOf("budgetReservations"),
});

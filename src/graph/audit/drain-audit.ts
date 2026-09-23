/**
 * Graph Execution Engine v2 — Read-only drain / migration audit (E stage entry)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The AUDIT half of release-gate step 5 (docs/graph-outcome-protocol.md
 * § "Implementation order and release gates": "Drain or explicitly migrate
 * legacy executions, then remove payload-based decisions from the new engine and
 * retire legacy execution support"). Retiring the legacy execution path is only
 * safe when no graph still depends on it, and "no graph" is a CLAIM that needs
 * evidence. This module produces that evidence: one total, read-only inventory
 * of the persisted graph store, in which every graph is
 *
 * - `terminal` — readable and quiescent: the record takes no further step;
 * - `in-flight` — readable and still owed work: the legacy engine (protocol 1)
 *   could still advance it, or the outcome run path (protocol 2) has not
 *   finished it; or
 * - `blocked` — the record cannot be read, or its version is unknown (a
 *   storage format or execution protocol with no installed capability), or it
 *   is INTACT but not executable until a registered storage migration commits.
 *   Every blocked entry is a BLOCKER for the drain decision and is listed
 *   individually — it is never folded into a count and never ignored.
 *
 * STRICTLY READ-ONLY, BY CONSTRUCTION. Nothing here writes a graph, a state
 * row, a ledger row or a file: the engine-state files are read as text and
 * classified by the same total loader the startup sweep uses, and the outcome
 * protocol's run state is read through `SqliteAcceptanceLedger.openReadOnly`
 * — an open that does not create the directory, does not create the file, never
 * initializes a schema, and holds a connection on which SQLite itself refuses
 * every write. A store the open cannot read without changing — a WAL-mode
 * ledger, whose read-only open would rewrite its `-shm` side file — is refused
 * before any connection exists and reported as a `ledger-refused` blocker, so
 * the no-write promise holds for every store, not only the ones this build
 * writes. A store that does not exist is `absent`, which is a reading and
 * never a licence to initialize one — and for a protocol-2 record it is not a
 * blocker either: nothing was ever committed, so the graph's first execution is
 * still owed and the run path (not the audit) is what creates the store.
 * `tests/graph/drain-audit.test.ts` proves
 * the zero-write property the hard way: every file under the audited workspace
 * is hashed and mtime-compared before and after a full audit over mixed
 * records, including the SQLite ledger.
 *
 * THE UNIVERSE IS THE ENGINE-STATE STORE — the same `engine-*.json` set the
 * startup sweep scans (`engineStateDir(directory)`, i.e.
 * `<directory>/.rolebox/state`). One file is one graph, and its
 * `executionProtocolVersion` is the identity the loader BOUND (the format-2
 * decoder backfills the legacy identity for a record written before the field
 * existed, so an old file reports protocol 1 rather than `undefined`). The
 * outcome protocol keeps its run state in the acceptance ledger rather than in
 * that file, so a protocol-2 entry is classified from the ledger's
 * `graphState` row — the state is read against the graph's SAVED compiled plan
 * with the same strict, versioned reader the run path uses.
 *
 * TERMINAL MEANS QUIESCENT, AND THE PHASE IS ALWAYS REPORTED. A legacy record
 * is terminal exactly when its phase is `complete` — the rule the sweep
 * already uses to decide it has nothing to resume. An outcome record is
 * terminal when its phase is `complete` OR `stopped`: a stopped run is
 * deliberately NOT `complete` (it was cut short by a declared hard limit or
 * progress threshold), but it refuses every further advance and launches
 * nothing on recovery, so it takes no further step and is migration-quiescent.
 * The entry carries the exact `phase` and, for a stop, its reason and
 * description, so "cut short" is never read as "finished" and the audit's
 * judgement stays checkable.
 *
 * IN-FLIGHT IS MORE THAN "NOT TERMINAL". A readable entry is in flight when it
 * is not quiescent: a legacy record in `idle`/`executing` (the legacy engine
 * could advance it), an outcome record in `ready`/`executing`, or a declared
 * outcome graph whose ledger holds no state row yet — including a ledger STORE
 * that does not exist at all, which nothing has ever committed to. Its first
 * execution is still owed: the sweep would create the store and start the graph
 * from the saved plan. The entry names the
 * WORK, not just the phase: a legacy entry carries its per-status node counts
 * and the ids of nodes the engine has not settled; an outcome entry carries
 * every node the persisted state records as in flight, with its attempt, and
 * every effect still `pending` or `started`.
 *
 * UNSETTLED EFFECTS ARE REPORTED FOR EVERY READABLE OUTCOME GRAPH, terminal or
 * not. An effect a process left `started` is real outstanding work even when
 * the graph around it finished, so it is listed rather than filtered by phase —
 * and it holds the verdict below open even when the graph count alone would
 * look drained.
 *
 * THE VERDICT IS NOT A COUNT. `drained` requires BOTH halves: no blocker AND
 * no in-flight graph AND no unsettled effect. A store with zero non-terminal
 * graphs but one unreadable record, or one `started` effect nobody settled, is
 * NOT drained — it is `blocked` or `in-flight` respectively. That is the whole
 * point of the report: "nothing looked non-terminal" is not evidence that the
 * legacy path is unused.
 *
 * THE IN-FLIGHT SET IS DECIDABLE, NOT MERELY COUNTED (E gate, step 1). "Six
 * graphs are in flight" cannot be acted on; "six records with nothing queued
 * and no state update for 9 to 13 days" can. Every readable in-flight entry
 * carries a `staleness` block — the record's own last update, its age, the
 * threshold that was applied, the queue facts and the inference — and `totals`
 * splits the in-flight count into `staleLocks` / `activelyExecuting`. It is an
 * INFERENCE with a stated basis, never a write: a stale lock is reported, never
 * resolved, and the verdict rules above are unchanged.
 *
 * THE QUEUE FACTS ARE FILE FACTS. A legacy entry's frontier and deferred
 * completions are read from the record's PERSISTED FILE — the raw text the
 * loader just validated — never from the hydrated state, which deliberately
 * resets `pendingCompletions` at the trust boundary
 * (`deserializeEngineState`, R2(c)) and therefore cannot answer whether the
 * process that wrote the file still had completions deferred. That reset is
 * UNCHANGED and is not this audit's to change: recovery still refuses to resume
 * from a persisted deferred queue (the completions describe a critical section
 * no live process holds). The file is the authority for the REPORT and for the
 * stale-lock criterion only.
 *
 * The creation side is owned elsewhere and named here because the two together
 * decide the gate: `src/graph/tools/legacy-creation-gate.ts` refuses a NEW
 * durable protocol-1 record at the tool ingress unless the host declares
 * `allowNewLegacyGraphs`, so the population this audit drains cannot grow
 * silently.
 *
 * Dependency note: this module reads the loader, the ledger's read-only open and
 * the outcome state reader, and imports no run path. It dispatches nothing,
 * recovers nothing, migrates nothing and compiles nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../constants.ts";
import { errorText } from "../../utils/error-text.ts";
import type { EngineState } from "../../types.engine-v2.ts";
import type { CompiledPlan } from "../compiler/plan.ts";
import {
  readOutcomeGraphState,
  describeOutcomeStop,
  OutcomeStateError,
  type OutcomeGraphState,
  type OutcomeStop,
} from "../outcome/graph-state.ts";
import {
  ledgerFilePath,
  SqliteAcceptanceLedger,
  type AcceptanceLedgerReader,
  type LedgerReadOpenResult,
} from "../ledger/sqlite-ledger.ts";
import type {
  EffectStatus,
  GraphStateRecord,
  PendingEffectRecord,
} from "../ledger/types.ts";
import {
  DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
  LEGACY_SIGNAL_PROTOCOL,
  OUTCOME_PROTOCOL,
  type ExecutionProtocolRegistry,
} from "../protocol/execution-protocol.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStateDir,
  loadEngineStateForResume,
  type EngineLoadDimension,
  type EngineLoadResult,
} from "../engine/engine-persistence.ts";
import type { StorageFormatRegistry } from "../persistence/storage-format.ts";

// ── Blocker vocabulary ──────────────────────────────────────────────────────

/**
 * Everything that makes one graph unusable as drain evidence. A CLOSED
 * vocabulary: each code names one condition the audit decided from the record
 * itself, so a caller branches on the code instead of parsing a message.
 *
 * - `state-store-unreadable` — the engine-state DIRECTORY could not be listed;
 *   nothing was audited at all.
 * - `read-error` — one `engine-*.json` exists but could not be read.
 * - `loader-failure` — the total loader threw on one file (containment).
 * - `loader-absent` — the raw-text loader answered `absent`, which is not a
 *   reading it can produce; recorded instead of skipped.
 * - `corrupt-record` — a recognized representation violates its schema,
 *   digest or binding invariants. `dimension` names the violated axis.
 * - `unsupported-version` — a well-formed version/capability with no installed
 *   handler: a storage format no decoder reads, or an execution protocol no
 *   handler owns. `dimension` names the axis.
 * - `migration-required` — an INTACT recognized snapshot with a registered
 *   storage conversion that has not been committed. It is not corrupt and it is
 *   not executable, so it blocks the drain until it is converted.
 * - `unclassified-protocol` — the record loaded as VALID under a registered
 *   protocol this audit has no terminality rule for. Guessing would be worse
 *   than refusing: an unknown protocol's phase vocabulary is not ours to read.
 * - `missing-persisted-plan` / `missing-plan-binding` /
 *   `plan-binding-mismatch` — a protocol-2 record whose plan identity is
 *   absent or self-contradicting; the same rules recovery applies, re-checked
 *   here so the audit never trusts a state handed in from elsewhere.
 * - `ledger-refused` / `ledger-unreadable` — the acceptance ledger exists but
 *   this build may not read it (foreign / unknown / newer / older / reshaped
 *   format), or could not open it. A protocol-2 record's state is in that store,
 *   so the graph is a blocker.
 * - `state-plan-mismatch` / `state-version-unsupported` / `state-malformed`
 *   / `state-unreadable` — the ledger's state row for this graph is not the
 *   state the strict reader accepts: bound to another plan revision, written in
 *   a body version this build has no reader for, malformed, or refused by an
 *   unexpected error — including a ledger row (or effect-row) read the store's
 *   own gate threw on, which is contained here rather than escaping.
 */
export type DrainAuditBlockerCode =
  | "state-store-unreadable"
  | "read-error"
  | "loader-failure"
  | "loader-absent"
  | "corrupt-record"
  | "unsupported-version"
  | "migration-required"
  | "unclassified-protocol"
  | "missing-persisted-plan"
  | "missing-plan-binding"
  | "plan-binding-mismatch"
  | "ledger-refused"
  | "ledger-unreadable"
  | "state-plan-mismatch"
  | "state-version-unsupported"
  | "state-malformed"
  | "state-unreadable";

/** The axis a blocker belongs to, when one owns it. */
export type DrainAuditBlockerDimension =
  | EngineLoadDimension
  | "ledger"
  | "outcome-state";

/** One reason a graph cannot be used as drain evidence. */
export interface DrainAuditBlocker {
  readonly code: DrainAuditBlockerCode;
  /** The axis that owns the condition; absent when none does. */
  readonly dimension?: DrainAuditBlockerDimension;
  /** What was found. Wording is not API; the code is. */
  readonly detail: string;
  /** The `engine-*.json` file the blocker was observed in, when per-file. */
  readonly file?: string;
  /** The graph id, when the record was readable enough to name one. */
  readonly graphId?: string;
}

// ── Report model ────────────────────────────────────────────────────────────

/** The protocol an entry is bound to, as far as the audit could read it. */
export type DrainAuditProtocol = "legacy-signal" | "outcome" | "unknown";

/** The three-way classification the drain decision reads. */
export type DrainAuditClassification = "terminal" | "in-flight" | "blocked";

/**
 * How long a readable in-flight record must have gone without a state update
 * before the audit will call it a STALE LOCK rather than work that may still be
 * moving. It is the whole threshold — nothing else in this module hard-codes an
 * idle duration — and every entry reports the value that was applied
 * ({@link DrainAuditStalenessFacts.staleAfterMs}), so a reader can recompute the
 * classification by hand instead of trusting it.
 *
 * THE BASIS, stated so it can be argued with rather than guessed at:
 *
 * - A live engine writes its state SYNCHRONOUSLY on every critical mutation
 *   (node lifecycle, phase, frontier, checkpoint, approval), so the only window
 *   in which a running graph produces no state update is while a dispatched
 *   task is executing. Silence is therefore evidence, not noise.
 * - The build's own liveness rule is that a `running` node past its staleness
 *   deadline is dead: `DEFAULT_NODE_STALE_TIMEOUT_MS` is 15 minutes and the
 *   tool surface configures it on every engine it builds, persisting a
 *   `timeout` transition when it fires. A record older than that deadline,
 *   with nothing queued, is one whose own watchdog never fired — which is what
 *   a process that is no longer alive looks like.
 * - 24 hours is 96x that default deadline. The multiple is deliberate: a node
 *   may declare a `budget.timeout_ms` longer than the default, and a single
 *   long dispatch is the one legitimate reason for silence, so the threshold is
 *   set far above any plausible single task rather than just above the default.
 * - It is a JUDGEMENT, not a protocol invariant, and it is not derived from the
 *   store it is applied to. For the reading that motivated it — records 9 to 13
 *   days old — it is decisive with two orders of magnitude to spare, and a
 *   caller that disagrees passes its own value through
 *   {@link DrainAuditOptions.staleAfterMs} rather than editing this module.
 */
export const STALE_LOCK_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a readable in-flight record looks dead or may still be moving.
 *
 * This is an INFERENCE from the facts below, never a rewrite: the audit reads
 * the store and changes nothing, so a `stale-lock` verdict resolves no lock,
 * re-dispatches nothing and deletes nothing. It answers one question and only
 * that one — "is any live process plausibly advancing this record?":
 *
 * - `stale-lock` — nothing is queued (for a legacy record, no frontier and no
 *   deferred completion IN THE PERSISTED FILE — see
 *   {@link DrainAuditStalenessFacts.pendingCompletionsEmpty}; for an outcome
 *   record, no armed attempt and no unsettled effect) AND the last state update
 *   is at least {@link STALE_LOCK_IDLE_THRESHOLD_MS} old. No live run is
 *   advancing it.
 * - `actively-executing` — something is queued OR the last update is inside
 *   the threshold. The audit REFUSES to call this dead; that is not the same as
 *   observing a live process, and the facts that decided it stay on the entry.
 */
export type DrainAuditStaleness = "stale-lock" | "actively-executing";

/**
 * The staleness reading for one readable in-flight record: the inference, the
 * threshold applied, and every fact it was drawn from.
 *
 * Present exactly on a readable `in-flight` entry — never on a `terminal` one
 * (it takes no further step, so there is no lock to judge) and never on a
 * `blocked` one (nothing about it is known well enough to infer anything; the
 * blocker is the answer). The queue facts are the queue vocabulary of the
 * entry's OWN protocol: `frontier` / `pendingCompletions`, read from the
 * record's PERSISTED FILE, for a legacy record (its hydrated state cannot answer
 * that question — the field notes below say why); an outcome entry already
 * carries `armed` / `unsettledEffects`.
 */
export interface DrainAuditStalenessFacts {
  /** Epoch ms of the record's own last state update, as persisted. */
  readonly lastUpdatedAt: number;
  /**
   * How long ago that was, in ms. Clamped at 0: a timestamp in the future
   * (clock skew between the writing and reading process) is reported as "just
   * now", never as a negative age that would read as ancient.
   */
  readonly idleMs: number;
  /** The threshold this entry was classified against. */
  readonly staleAfterMs: number;
  readonly staleness: DrainAuditStaleness;
  /** Whether the record holds work the engine has not consumed. */
  readonly hasQueuedWork: boolean;
  /**
   * Legacy only: whether the record's PERSISTED FILE holds an empty dispatch
   * frontier. File fact — see {@link pendingCompletionsEmpty}. Absent only when
   * the file carried no readable queue arrays, in which case the record is
   * conservatively reported as queued and no size is invented.
   */
  readonly frontierEmpty?: boolean;
  /** Legacy only: how many nodes that persisted frontier holds. */
  readonly frontierSize?: number;
  /**
   * Legacy only: whether the record's PERSISTED FILE defers no completion. Read
   * from the raw record text the loader just validated — never from the hydrated
   * state, because the deserializer DELIBERATELY resets the field at the trust
   * boundary (R2(c): it describes the critical section of the process that wrote
   * the file, and hydrating it would resurrect completions nobody can replay).
   * Reading the file keeps the REPORT faithful and the inference safe: a record
   * whose file still lists a deferred completion is never called a stale lock,
   * even though recovery would not resume from that queue. The reset itself is
   * unchanged — this field describes the store, never what a recovery may replay.
   */
  readonly pendingCompletionsEmpty?: boolean;
  /** Legacy only: how many completions the persisted file defers (see above). */
  readonly pendingCompletionsSize?: number;
}

/** One node the persisted outcome state records as in flight. */
export interface DrainAuditArmedNode {
  readonly nodeId: string;
  /** The attempt a submission must settle (never the credential). */
  readonly attemptId: string;
}

/** One effect the ledger still records `pending` or `started`. */
export interface DrainAuditEffect {
  readonly effectId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly status: EffectStatus;
}

/** The persisted stop an outcome run ended on. */
export interface DrainAuditStop {
  readonly reason: string;
  /** The one shared formatter's description of the stop. */
  readonly summary: string;
}

/** One graph's audited record. */
export interface DrainAuditEntry {
  /** The `engine-*.json` file this entry was read from. */
  readonly file: string;
  /** The graph id, when the record was readable enough to name one. */
  readonly graphId?: string;
  /**
   * The execution-protocol identity the loader BOUND to this record. Absent
   * only when the record could not be loaded far enough to bind one (a
   * blocked, unreadable entry) — never guessed.
   */
  readonly executionProtocolVersion?: number;
  readonly protocol: DrainAuditProtocol;
  readonly classification: DrainAuditClassification;
  /** The persisted phase, exactly as recorded (legacy or outcome vocabulary). */
  readonly phase?: string;
  /** The plan revision, for a protocol-2 record that names one. */
  readonly planRevision?: string;
  /** Legacy only: node count per lifecycle status. */
  readonly nodeStatusCounts?: Readonly<Record<string, number>>;
  /** Legacy only: nodes the engine has not settled (`completed` / `done`). */
  readonly unsettledNodeIds?: readonly string[];
  /** Outcome only: nodes the persisted state records as in flight. */
  readonly armed?: readonly DrainAuditArmedNode[];
  /** Outcome only: effects still `pending` or `started`. */
  readonly unsettledEffects?: readonly DrainAuditEffect[];
  /** Outcome only: present exactly when the run ended on a declared stop. */
  readonly stop?: DrainAuditStop;
  /**
   * Outcome only: whether the ledger holds a state row for this graph. `false`
   * means the first execution is still owed, not that the state was lost and
   * not that it is unreadable — a state this build cannot read is a blocker.
   */
  readonly hasState?: boolean;
  /**
   * In-flight only: the stale-lock inference and the facts behind it. Absent on
   * a terminal entry (quiescent, so no lock exists) and on a blocked one
   * (unreadable, so nothing may be inferred).
   */
  readonly staleness?: DrainAuditStalenessFacts;
  /** Every blocker code observed for this entry, in report order. */
  readonly blockerCodes: readonly DrainAuditBlockerCode[];
}

/** The store-level reading the report is built on. */
export type DrainAuditLedgerStatus = "opened" | "absent" | "refused" | "unreadable";

/** Counts, including the ones the three-way partition does NOT carry. */
export interface DrainAuditTotals {
  /** `engine-*.json` files found in the store. */
  readonly files: number;
  /** Readable and quiescent. */
  readonly terminal: number;
  /** Readable with work still owed. */
  readonly inFlight: number;
  /** Unreadable, version-unknown, or intact-but-migration-required. */
  readonly blocked: number;
  /** Of the in-flight entries, those bound to the LEGACY signal protocol. */
  readonly legacyInFlight: number;
  /** Of the in-flight entries, those bound to the outcome protocol. */
  readonly outcomeInFlight: number;
  /**
   * Of the in-flight entries, those the staleness inference calls
   * `stale-lock`: nothing queued and no state update for at least the applied
   * threshold. A count of READABLE records, not a write: the audit resolves no
   * lock and retires nothing.
   */
  readonly staleLocks: number;
  /**
   * Of the in-flight entries, those it refuses to call dead — something is
   * queued or the last update is inside the threshold. `staleLocks` and this
   * field always sum to {@link inFlight}, which is what makes the pair
   * checkable rather than merely informative.
   */
  readonly activelyExecuting: number;
  /** Unsettled effects across every outcome entry, terminal included. */
  readonly unsettledEffects: number;
  /** Blocker count per code, over the whole report. */
  readonly blockersByCode: Readonly<Record<string, number>>;
}

/**
 * The drain verdict.
 *
 * `drained` requires all three: no blocker, no in-flight graph and no
 * unsettled effect. `blocked` wins over `in-flight`: an unreadable record
 * could be anything, and the drain decision must resolve it before it can be
 * called safe.
 */
export type DrainAuditVerdict = "drained" | "in-flight" | "blocked";

/** The whole audit. Every array is in deterministic store order. */
export interface DrainAuditReport {
  /** The workspace directory audited. */
  readonly directory: string;
  /** The engine-state directory actually read (`.rolebox/state`). */
  readonly stateDirectory: string;
  /** The acceptance-ledger file path (reported even when it is absent). */
  readonly ledgerFilePath: string;
  readonly ledger: DrainAuditLedgerStatus;
  /** One entry per `engine-*.json`, sorted by file name. */
  readonly entries: readonly DrainAuditEntry[];
  /** Every blocker, store-level and per-entry, in report order. */
  readonly blockers: readonly DrainAuditBlocker[];
  readonly totals: DrainAuditTotals;
  readonly verdict: DrainAuditVerdict;
  /** `true` exactly when the verdict is `drained`. */
  readonly drained: boolean;
}

/** Inputs for {@link auditGraphStore}. */
export interface DrainAuditOptions {
  /** Workspace directory whose `.rolebox/state` store is audited. */
  readonly directory: string;
  /** Storage-format capabilities; defaults to the shipped registry. */
  readonly storageFormatRegistry?: StorageFormatRegistry;
  /** Execution-protocol capabilities; defaults to the shipped registry. */
  readonly protocolRegistry?: ExecutionProtocolRegistry;
  /**
   * Injected ledger open, for a caller that owns the store handle or a test
   * that must exercise a refusal. Absent → the real read-only open
   * ({@link SqliteAcceptanceLedger.openReadOnly}) is used, and the handle it
   * returns is closed before the audit resolves.
   */
  readonly openLedger?: (directory: string) => Promise<LedgerReadOpenResult>;
  /**
   * Read "now" for the staleness inference; defaults to `Date.now`. Injected
   * by a caller (or a test) that must classify against a fixed instant instead
   * of the wall clock — the audit is read-only either way.
   */
  readonly now?: () => number;
  /**
   * Override the idle threshold the staleness inference applies; defaults to
   * {@link STALE_LOCK_IDLE_THRESHOLD_MS}. The value actually used is reported on
   * every classified entry, so an override is visible in the report and a
   * reviewer can recompute the classification.
   */
  readonly staleAfterMs?: number;
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Matches the per-graph engine-state filenames the store writes. */
const ENGINE_STATE_FILENAME = /^engine-.+\.json$/;

/** The node statuses that count as SETTLED for the legacy run. */
const SETTLED_NODE_STATUSES: readonly string[] = Object.freeze([
  NodeStatus.Completed,
  NodeStatus.Done,
]);

/** Is this a file the engine-state store owns? */
function isEngineStateFile(name: string): boolean {
  return ENGINE_STATE_FILENAME.test(name);
}

/** One blocker, with the file (and graph, when known) it belongs to. */
function blocker(
  code: DrainAuditBlockerCode,
  detail: string,
  where: { readonly file?: string; readonly graphId?: string },
  dimension?: DrainAuditBlockerDimension,
): DrainAuditBlocker {
  return Object.freeze({
    code,
    ...(dimension === undefined ? {} : { dimension }),
    detail,
    ...(where.file === undefined ? {} : { file: where.file }),
    ...(where.graphId === undefined ? {} : { graphId: where.graphId }),
  });
}

/**
 * A blocked entry: a record the audit could not classify into terminal or
 * in-flight — unreadable, version-unknown, or intact-but-migration-required.
 * It carries no phase, protocol or work, because the audit has none to report:
 * guessing would be worse than the blocker.
 */
function blockedFileEntry(
  file: string,
  codes: readonly DrainAuditBlockerCode[],
): DrainAuditEntry {
  return Object.freeze({
    file,
    protocol: "unknown" as const,
    classification: "blocked" as const,
    blockerCodes: Object.freeze([...codes]),
  });
}

/** Project one effect row into the report's own shape. */
function toAuditEffect(effect: PendingEffectRecord): DrainAuditEffect {
  return Object.freeze({
    effectId: effect.effectId,
    attemptId: effect.attemptId,
    kind: effect.kind,
    status: effect.status,
  });
}

/** Project one persisted stop into the report's own shape. */
function toAuditStop(stop: OutcomeStop): DrainAuditStop {
  return Object.freeze({
    reason: stop.reason,
    summary: describeOutcomeStop(stop),
  });
}

// ── Entry classification ────────────────────────────────────────────────────

/**
 * One record's queue, in the vocabulary its own protocol keeps it in. Internal:
 * the report exposes the facts through {@link DrainAuditStalenessFacts} and the
 * entry's protocol-specific work fields, never as this alias.
 */
interface EntryQueue {
  /** Whether the record holds work the engine has not consumed. */
  readonly hasQueuedWork: boolean;
  /**
   * Legacy only: the dispatch frontier, reported as size + emptiness. Elements
   * are never read — for a FILE-sourced queue they are whatever arrays the
   * loader's required-shape gate accepted — so they are typed `unknown` rather
   * than reinterpreted (or filtered, which would make the reported size differ
   * from the file's).
   */
  readonly frontier?: readonly unknown[];
  /** Legacy only: completions deferred on the unlock queue (see above). */
  readonly pendingCompletions?: readonly unknown[];
}

/** Everything a classification pass may add to an entry. */
interface EntryBody {
  readonly graphId?: string;
  readonly protocol: DrainAuditProtocol;
  readonly classification: DrainAuditClassification;
  readonly phase?: string;
  readonly planRevision?: string;
  readonly nodeStatusCounts?: Readonly<Record<string, number>>;
  readonly unsettledNodeIds?: readonly string[];
  readonly armed?: readonly DrainAuditArmedNode[];
  readonly unsettledEffects?: readonly DrainAuditEffect[];
  readonly stop?: DrainAuditStop;
  readonly hasState?: boolean;
  /** The record's own last state-update timestamp, when it holds one. */
  readonly lastUpdatedAt?: number;
  /** The record's queue, when it holds one. Internal — never reported as-is. */
  readonly queue?: EntryQueue;
  readonly blockerCodes: readonly DrainAuditBlockerCode[];
  /**
   * Per-code detail that OVERRIDES the generic sentence, for a blocker whose
   * concrete cause (a contained error's text, say) is evidence the caller
   * should see. Absent codes fall back to {@link describeEntryBlocker}.
   */
  readonly blockerDetails?: Readonly<
    Partial<Record<DrainAuditBlockerCode, string>>
  >;
}

/**
 * The legacy protocol's queue as the record's PERSISTED FILE carries it.
 *
 * The hydrated `EngineState` cannot answer this question: `deserializeEngineState`
 * deliberately resets `pendingCompletions` (R2(c): it describes the critical
 * section of the process that wrote the file), so reading the loaded state would
 * report an empty queue for a file that queued completions — exactly the record
 * the drain must never call a stale lock. The audit already holds the raw record
 * text and the loader has already validated it against the format's
 * required-shape gate, which REQUIRES both fields to be arrays, so this is the
 * file's own fact rather than a second interpretation of it.
 *
 * Returns `undefined` when the text carries no readable queue arrays. The
 * caller must then treat the queue as UNPROVABLE, never as empty.
 */
function persistedLegacyQueue(raw: string): EntryQueue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as {
    readonly frontier?: unknown;
    readonly pendingCompletions?: unknown;
  };
  const { frontier, pendingCompletions } = record;
  if (!Array.isArray(frontier) || !Array.isArray(pendingCompletions)) {
    return undefined;
  }
  return Object.freeze({
    hasQueuedWork: frontier.length > 0 || pendingCompletions.length > 0,
    frontier,
    pendingCompletions,
  });
}

/**
 * The queue of a valid legacy record whose raw text carried no readable queue
 * arrays. Unreachable for the shipped format-2 decoder — its required-shape gate
 * rejects a file without both arrays (`hasRequiredShape`) — but a future
 * decoder that binds the legacy protocol to another layout lands here, and the
 * audit then REFUSES to call the queue empty: "the file says queued → never
 * stale" cannot be satisfied by a queue nobody could read, so the record stays
 * `actively-executing` with no size fields invented for it.
 */
const UNPROVABLE_LEGACY_QUEUE: EntryQueue = Object.freeze({
  hasQueuedWork: true,
});

/** The outcome protocol's queue: armed attempts and unsettled effects. */
function outcomeQueue(armedCount: number, effectCount: number): EntryQueue {
  return Object.freeze({ hasQueuedWork: armedCount > 0 || effectCount > 0 });
}

/**
 * The queue of an outcome record that was declared but never started. Its queue
 * is the FIRST EXECUTION ITSELF: the run path starts the graph from the saved
 * plan at any time, so the record is not a dead lock and must never be reported
 * as one. No frontier exists to report — there is no engine state yet — so only
 * `hasQueuedWork` is carried.
 */
const UNSTARTED_OUTCOME_QUEUE: EntryQueue = Object.freeze({
  hasQueuedWork: true,
});

/**
 * Decide one in-flight record's staleness — the SINGLE owner of the rule.
 *
 * `stale-lock` requires BOTH halves: nothing queued and no state update for at
 * least the threshold. Either half alone keeps the entry
 * `actively-executing`, because the audit must not call a record dead on
 * evidence that does not support it.
 */
function stalenessFacts(
  lastUpdatedAt: number,
  queue: EntryQueue,
  now: number,
  staleAfterMs: number,
): DrainAuditStalenessFacts {
  const idleMs = Math.max(0, now - lastUpdatedAt);
  const staleness: DrainAuditStaleness =
    queue.hasQueuedWork || idleMs < staleAfterMs
      ? "actively-executing"
      : "stale-lock";
  return Object.freeze({
    lastUpdatedAt,
    idleMs,
    staleAfterMs,
    staleness,
    hasQueuedWork: queue.hasQueuedWork,
    ...(queue.frontier === undefined
      ? {}
      : {
          frontierEmpty: queue.frontier.length === 0,
          frontierSize: queue.frontier.length,
        }),
    ...(queue.pendingCompletions === undefined
      ? {}
      : {
          pendingCompletionsEmpty: queue.pendingCompletions.length === 0,
          pendingCompletionsSize: queue.pendingCompletions.length,
        }),
  });
}

/**
 * Classify one VALID legacy-protocol record.
 *
 * Terminal exactly when the phase is `complete` — the sweep's own rule. Every
 * other phase is in flight, and the entry carries the work: per-status counts
 * plus the ids of nodes the engine has not settled (`completed`/`done`).
 */
function classifyLegacy(
  state: EngineState,
  persistedQueue: EntryQueue | undefined,
): EntryBody {
  const nodeStatusCounts: Record<string, number> = {};
  const unsettledNodeIds: string[] = [];
  for (const node of state.nodes.values()) {
    nodeStatusCounts[node.status] = (nodeStatusCounts[node.status] ?? 0) + 1;
    if (!SETTLED_NODE_STATUSES.includes(node.status)) {
      unsettledNodeIds.push(node.nodeId);
    }
  }
  unsettledNodeIds.sort();
  return {
    graphId: state.graphId,
    protocol: "legacy-signal",
    classification: state.phase === EnginePhase.Complete ? "terminal" : "in-flight",
    phase: state.phase,
    nodeStatusCounts: Object.freeze(nodeStatusCounts),
    unsettledNodeIds: Object.freeze(unsettledNodeIds),
    lastUpdatedAt: state.updatedAt,
    queue: persistedQueue ?? UNPROVABLE_LEGACY_QUEUE,
    blockerCodes: [],
  };
}

/**
 * Read one graph's unsettled effects, CONTAINED.
 *
 * A ledger read can THROW: the store's own row gate refuses a hand-edited or
 * foreign row instead of returning it. The audit must report that as a blocker
 * for the entry and never let it escape — totality is what makes the report
 * evidence rather than a crash waiting for a bad row.
 */
function readUnsettledEffects(
  ledger: AcceptanceLedgerReader,
  graphId: string,
):
  | { readonly ok: true; readonly effects: readonly DrainAuditEffect[] }
  | { readonly ok: false; readonly reason: string } {
  try {
    const rows = ledger.pendingEffects(graphId);
    return { ok: true, effects: Object.freeze(rows.map(toAuditEffect)) };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * Classify one VALID outcome-protocol record.
 *
 * The plan identity is re-checked here (the same three rules recovery applies)
 * before the ledger is read, because a state handed to this function from
 * anywhere else must get the same guarantee. The ledger's state row is then
 * read through the strict versioned reader against the SAVED plan: a state this
 * build cannot read is a BLOCKER, never a clean start and never a guess.
 */
function classifyOutcome(
  state: EngineState,
  ledger: AcceptanceLedgerReader | undefined,
  ledgerBlocker: DrainAuditBlockerCode | undefined,
): EntryBody {
  const plan: CompiledPlan | undefined = state.compiledPlan;
  if (plan === undefined) {
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      blockerCodes: ["missing-persisted-plan"],
    };
  }
  const binding = state.planBinding;
  if (binding === undefined) {
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      planRevision: plan.planRevision,
      blockerCodes: ["missing-plan-binding"],
    };
  }
  if (plan.graphId !== state.graphId || plan.planRevision !== binding.planRevision) {
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      planRevision: plan.planRevision,
      blockerCodes: ["plan-binding-mismatch"],
    };
  }
  if (ledger === undefined) {
    // An ABSENT ledger file is not an unreadable one: `openReadOnly` answers
    // `absent` without creating it, and only a refusal or a failed open carries
    // a store-level blocker. Nothing was ever committed here, so the graph's
    // first execution is still owed — the same shape as "no state row yet", and
    // the run path (never the audit) is what creates the store and starts it.
    // Reporting a blocker here would invent an unreadable record that does not
    // exist and stall the drain on a graph that only needs its first execution.
    if (ledgerBlocker === undefined) {
      return {
        graphId: state.graphId,
        protocol: "outcome",
        classification: "in-flight",
        planRevision: plan.planRevision,
        hasState: false,
        armed: Object.freeze([]),
        unsettledEffects: Object.freeze([]),
        lastUpdatedAt: state.updatedAt,
        queue: UNSTARTED_OUTCOME_QUEUE,
        blockerCodes: [],
      };
    }
    // The store EXISTS but is not one this build may read; this record's run
    // state lives in it, so the entry inherits the store-level blocker.
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      planRevision: plan.planRevision,
      blockerCodes: [ledgerBlocker],
    };
  }

  let record: GraphStateRecord | undefined;
  try {
    record = ledger.readGraphState(state.graphId);
  } catch (error) {
    // The ledger's own row gate refused a row (a hand-edited or foreign store):
    // contained as a blocker, never thrown past the audit.
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      planRevision: plan.planRevision,
      blockerCodes: ["state-unreadable"],
      blockerDetails: {
        "state-unreadable":
          "graph " + JSON.stringify(state.graphId) + " has a ledger state row " +
          "this build could not read (" + errorText(error) + ")",
      },
    };
  }
  const effects = readUnsettledEffects(ledger, state.graphId);
  if (!effects.ok) {
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      planRevision: plan.planRevision,
      hasState: record !== undefined,
      blockerCodes: ["state-unreadable"],
      blockerDetails: {
        "state-unreadable":
          "graph " + JSON.stringify(state.graphId) + " has effect rows this " +
          "build could not read (" + effects.reason + ")",
      },
    };
  }
  if (record === undefined) {
    // No state row: the graph was declared but never started, so its first
    // execution is still owed. That is in flight, NOT blocked — nothing about
    // the record is unreadable.
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "in-flight",
      planRevision: plan.planRevision,
      hasState: false,
      armed: Object.freeze([]),
      unsettledEffects: effects.effects,
      lastUpdatedAt: state.updatedAt,
      queue: UNSTARTED_OUTCOME_QUEUE,
      blockerCodes: [],
    };
  }

  let outcomeState: OutcomeGraphState;
  try {
    outcomeState = readOutcomeGraphState(record, plan);
  } catch (error) {
    const code: DrainAuditBlockerCode =
      error instanceof OutcomeStateError
        ? error.problem === "state-plan-mismatch"
          ? "state-plan-mismatch"
          : error.problem === "unsupported-state-version"
            ? "state-version-unsupported"
            : "state-malformed"
        : "state-unreadable";
    return {
      graphId: state.graphId,
      protocol: "outcome",
      classification: "blocked",
      planRevision: plan.planRevision,
      hasState: true,
      blockerCodes: [code],
    };
  }

  const armed: DrainAuditArmedNode[] = [];
  for (const node of outcomeState.nodes) {
    if (node.status === "dispatched" && node.attemptId !== undefined) {
      armed.push(Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId }));
    }
  }
  const quiescent =
    outcomeState.phase === "complete" || outcomeState.phase === "stopped";
  return {
    graphId: state.graphId,
    protocol: "outcome",
    classification: quiescent ? "terminal" : "in-flight",
    phase: outcomeState.phase,
    planRevision: outcomeState.planRevision,
    hasState: true,
    armed: Object.freeze(armed),
    unsettledEffects: effects.effects,
    lastUpdatedAt: record.updatedAt,
    queue: outcomeQueue(armed.length, effects.effects.length),
    ...(outcomeState.stop === undefined
      ? {}
      : { stop: toAuditStop(outcomeState.stop) }),
    blockerCodes: [],
  };
}

/**
 * Classify one VALID record under a protocol this audit has no terminality rule
 * for. The record is readable and the loader bound it, but its phase vocabulary
 * is not this audit's to interpret: guessing "terminal" would let an unknown
 * protocol's work be retired silently, so the entry is a blocker.
 */
function classifyUnknownProtocol(state: EngineState): EntryBody {
  return {
    graphId: state.graphId,
    protocol: "unknown",
    classification: "blocked",
    blockerCodes: ["unclassified-protocol"],
  };
}

// ── Entry assembly ──────────────────────────────────────────────────────────

/** Turn a loaded file into one entry plus the blockers it produced. */
function entryForLoadResult(
  file: string,
  loaded: EngineLoadResult,
  ledger: AcceptanceLedgerReader | undefined,
  ledgerBlocker: DrainAuditBlockerCode | undefined,
  now: number,
  staleAfterMs: number,
  /**
   * The legacy queue as the RAW record carries it. `undefined` for a non-legacy
   * record — an outcome record's queue is its ledger's `armed`/`unsettledEffects`,
   * and its carrier state is built with an empty frontier that nothing advances,
   * so these legacy fields are not its queue — and for a legacy record whose file
   * carried no readable queue arrays (then the queue is unprovable, never empty
   * — see {@link UNPROVABLE_LEGACY_QUEUE}).
   */
  persistedQueue: EntryQueue | undefined,
): {
  readonly entry: DrainAuditEntry;
  readonly blockers: readonly DrainAuditBlocker[];
} {
  if (loaded.kind === "absent") {
    // Defensive: the raw-text loader can never answer `absent`, and a file that
    // vanished is the read error arm above. Recorded, never skipped.
    const detail =
      "the loader answered absent for a file read from the store — the raw-text " +
      "loader cannot produce that reading, so the record is unresolved";
    return {
      entry: blockedFileEntry(file, ["loader-absent"]),
      blockers: [blocker("loader-absent", detail, { file })],
    };
  }
  if (loaded.kind === "corrupt") {
    const detail = "corrupt " + loaded.dimension + ": " + loaded.reason;
    return {
      entry: blockedFileEntry(file, ["corrupt-record"]),
      blockers: [blocker("corrupt-record", detail, { file }, loaded.dimension)],
    };
  }
  if (loaded.kind === "unsupported") {
    const detail = "unsupported " + loaded.dimension + ": " + loaded.detail;
    return {
      entry: blockedFileEntry(file, ["unsupported-version"]),
      blockers: [
        blocker("unsupported-version", detail, { file }, loaded.dimension),
      ],
    };
  }
  if (loaded.kind === "migration-required") {
    const detail =
      "migration-required storage: " + loaded.from + " -> " + loaded.to +
      "; the snapshot is intact but not executable until that registered " +
      "conversion commits";
    return {
      entry: blockedFileEntry(file, ["migration-required"]),
      blockers: [blocker("migration-required", detail, { file }, "storage")],
    };
  }

  const state = loaded.state;
  const body =
    loaded.executionProtocol === LEGACY_SIGNAL_PROTOCOL
      ? classifyLegacy(state, persistedQueue)
      : loaded.executionProtocol === OUTCOME_PROTOCOL
        ? classifyOutcome(state, ledger, ledgerBlocker)
        : classifyUnknownProtocol(state);
  // The queue facts are INPUTS to the inference, not part of the report: the
  // staleness block projects them, and a legacy entry's own work fields already
  // surface the same frontier. Dropped here rather than duplicated as a second
  // shape that could drift.
  const { lastUpdatedAt, queue, ...reportable } = body;
  const staleness =
    body.classification === "in-flight" &&
    lastUpdatedAt !== undefined &&
    queue !== undefined
      ? stalenessFacts(lastUpdatedAt, queue, now, staleAfterMs)
      : undefined;
  const entry = Object.freeze({
    file,
    ...reportable,
    ...(staleness === undefined ? {} : { staleness }),
    executionProtocolVersion: loaded.executionProtocol,
    blockerCodes: Object.freeze([...body.blockerCodes]),
  });
  return {
    entry,
    blockers: body.blockerCodes.map((code) =>
      blocker(
        code,
        body.blockerDetails?.[code] ?? describeEntryBlocker(code, state.graphId),
        { file, graphId: state.graphId },
        blockerDimensionFor(code),
      ),
    ),
  };
}

/** The axis a per-entry blocker code belongs to, when one owns it. */
function blockerDimensionFor(
  code: DrainAuditBlockerCode,
): DrainAuditBlockerDimension | undefined {
  if (code === "ledger-refused" || code === "ledger-unreadable") return "ledger";
  if (
    code === "state-plan-mismatch" ||
    code === "state-version-unsupported" ||
    code === "state-malformed" ||
    code === "state-unreadable"
  ) {
    return "outcome-state";
  }
  return undefined;
}

/** One honest sentence for a per-entry blocker, derived from its code. */
function describeEntryBlocker(
  code: DrainAuditBlockerCode,
  graphId: string,
): string {
  switch (code) {
    case "missing-persisted-plan":
      return (
        "graph " + JSON.stringify(graphId) +
        " is bound to the outcome protocol but its record carries no compiled " +
        "plan — the plan is the run's topology authority, so its state cannot " +
        "be read without one"
      );
    case "missing-plan-binding":
      return (
        "graph " + JSON.stringify(graphId) +
        " carries a persisted compiled plan but no plan binding — a declared " +
        "graph is always written with both"
      );
    case "plan-binding-mismatch":
      return (
        "graph " + JSON.stringify(graphId) +
        " carries a compiled plan whose revision the plan binding does not " +
        "corroborate"
      );
    case "unclassified-protocol":
      return (
        "graph " + JSON.stringify(graphId) +
        " loaded under a registered execution protocol this audit has no " +
        "terminality rule for — a protocol's phase vocabulary is not guessable " +
        "from outside it"
      );
    case "ledger-refused":
      return (
        "graph " + JSON.stringify(graphId) +
        " keeps its run state in the acceptance ledger, which exists but is " +
        "not a store this build may read"
      );
    case "ledger-unreadable":
      return (
        "graph " + JSON.stringify(graphId) +
        " keeps its run state in the acceptance ledger, which could not be " +
        "opened for reading"
      );
    case "state-plan-mismatch":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a state row bound to a different graph or plan revision than the " +
        "plan its record carries"
      );
    case "state-version-unsupported":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a state row written in a body version this build has no reader " +
        "for — refusing it rather than reading it partially"
      );
    case "state-malformed":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a state row that is not the shape its declared body version " +
        "defines"
      );
    case "state-unreadable":
      return (
        "graph " + JSON.stringify(graphId) +
        " has a state row the strict reader could not process (an unexpected " +
        "error was contained)"
      );
    default:
      // The remaining codes carry their own engine-load detail in the loader
      // verdict; this path is not reachable for them.
      return "graph " + JSON.stringify(graphId) + ": " + code;
  }
}

// ── The audit ───────────────────────────────────────────────────────────────

/**
 * Audit one workspace's persisted graph store, READ-ONLY.
 *
 * TOTAL: a missing store is an empty report, an unreadable directory is one
 * store-level blocker, and every per-file failure is contained as its own
 * entry. Nothing is thrown for a state of the store; a thrown exception here
 * would be a bug in the audit, not a fact about a graph.
 */
export async function auditGraphStore(
  options: DrainAuditOptions,
): Promise<DrainAuditReport> {
  const stateDirectory = engineStateDir(options.directory);
  const filePath = ledgerFilePath(stateDirectory);
  const storageFormats =
    options.storageFormatRegistry ?? DEFAULT_STORAGE_FORMAT_REGISTRY;
  const protocols =
    options.protocolRegistry ?? DEFAULT_EXECUTION_PROTOCOL_REGISTRY;
  const openLedger = options.openLedger ?? SqliteAcceptanceLedger.openReadOnly;
  // "Now" is read ONCE: every entry in one report is classified against the
  // same instant, so two entries with the same age cannot land on opposite sides
  // of the threshold because the audit took a while.
  const now = (options.now ?? Date.now)();
  const staleAfterMs = options.staleAfterMs ?? STALE_LOCK_IDLE_THRESHOLD_MS;

  const blockers: DrainAuditBlocker[] = [];
  const entries: DrainAuditEntry[] = [];

  // 1. The ledger, opened READ-ONLY and never created. Opening it first is
  //    deliberate: a refusal is a store-level blocker that every protocol-2
  //    entry inherits, and an absent store is a fact about the whole report.
  let ledger: AcceptanceLedgerReader | undefined;
  let ledgerStatus: DrainAuditLedgerStatus;
  let ledgerBlocker: DrainAuditBlockerCode | undefined;
  let opened: LedgerReadOpenResult;
  try {
    opened = await openLedger(stateDirectory);
  } catch (error) {
    opened = {
      kind: "unreadable",
      filePath,
      reason: "the read-only ledger open threw: " + errorText(error),
    };
  }
  if (opened.kind === "opened") {
    ledger = opened.ledger;
    ledgerStatus = "opened";
  } else if (opened.kind === "absent") {
    ledgerStatus = "absent";
  } else if (opened.kind === "refused") {
    ledgerStatus = "refused";
    ledgerBlocker = "ledger-refused";
    blockers.push(
      blocker(
        "ledger-refused",
        "acceptance ledger " + opened.filePath + " is not a store this build " +
          "may read (" + opened.problem + "): " + opened.message,
        {},
        "ledger",
      ),
    );
  } else {
    ledgerStatus = "unreadable";
    ledgerBlocker = "ledger-unreadable";
    blockers.push(
      blocker(
        "ledger-unreadable",
        "acceptance ledger " + opened.filePath +
          " could not be opened read-only: " + opened.reason,
        {},
        "ledger",
      ),
    );
  }

  // 2. List the engine-state store. A missing directory is an empty store; any
  //    other listing failure means NOTHING was audited, which is its own
  //    blocker rather than an empty (and therefore "drained") report.
  let files: string[] = [];
  try {
    files = readdirSync(stateDirectory, { encoding: "utf-8" })
      .filter(isEngineStateFile)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      blockers.push(
        blocker(
          "state-store-unreadable",
          "the engine-state store " + stateDirectory +
            " could not be listed: " + errorText(error),
          {},
          "storage",
        ),
      );
    }
  }

  try {
    // 3. Read and classify every record. The loader is total over raw text and
    //    the read itself is contained, so one hostile file cannot hide the
    //    rest of the store.
    for (const file of files) {
      const path = join(stateDirectory, file);
      let raw: string;
      try {
        raw = readFileSync(path, "utf-8");
      } catch (error) {
        entries.push(blockedFileEntry(file, ["read-error"]));
        blockers.push(
          blocker(
            "read-error",
            file + " exists but could not be read: " + errorText(error),
            { file },
          ),
        );
        continue;
      }
      let loaded: EngineLoadResult;
      try {
        loaded = loadEngineStateForResume(raw, path, storageFormats, protocols);
      } catch (error) {
        entries.push(blockedFileEntry(file, ["loader-failure"]));
        blockers.push(
          blocker(
            "loader-failure",
            "the loader threw on " + file + " (it is total by contract): " +
              errorText(error),
            { file },
          ),
        );
        continue;
      }
      // The staleness criterion's legacy queue facts come from the RAW record,
      // never from the hydrated state: hydration deliberately resets
      // `pendingCompletions` at the trust boundary (`deserializeEngineState`,
      // R2(c)), so a loaded record reports an empty deferred queue even when the
      // file queued one. The raw text the loader just validated is the authority
      // for the REPORT and the stale-lock criterion; the reset is unchanged and
      // recovery still does not resume from that queue.
      const persistedQueue =
        loaded.kind === "valid" &&
        loaded.executionProtocol === LEGACY_SIGNAL_PROTOCOL
          ? persistedLegacyQueue(raw)
          : undefined;
      const audited = entryForLoadResult(
        file,
        loaded,
        ledger,
        ledgerBlocker,
        now,
        staleAfterMs,
        persistedQueue,
      );
      entries.push(audited.entry);
      blockers.push(...audited.blockers);
    }
  } finally {
    // The audit owns the handle only when it opened it.
    if (options.openLedger === undefined) ledger?.close();
  }

  // 4. Counts. The three-way partition is the headline; the protocol split and
  //    the effect count are what the drain decision actually turns on.
  let terminal = 0;
  let inFlight = 0;
  let blocked = 0;
  let legacyInFlight = 0;
  let outcomeInFlight = 0;
  let staleLocks = 0;
  let activelyExecuting = 0;
  let unsettledEffects = 0;
  const blockersByCode: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.classification === "terminal") terminal += 1;
    else if (entry.classification === "in-flight") {
      inFlight += 1;
      if (entry.protocol === "legacy-signal") legacyInFlight += 1;
      if (entry.protocol === "outcome") outcomeInFlight += 1;
      // Every in-flight entry is readable, so every one of them carries the
      // inference: the pair sums to inFlight by construction.
      if (entry.staleness?.staleness === "stale-lock") staleLocks += 1;
      else activelyExecuting += 1;
    } else blocked += 1;
    unsettledEffects += entry.unsettledEffects?.length ?? 0;
  }
  for (const entry of blockers) {
    blockersByCode[entry.code] = (blockersByCode[entry.code] ?? 0) + 1;
  }

  // 5. The verdict. NOT a count: every half is required.
  const verdict: DrainAuditVerdict =
    blockers.length > 0
      ? "blocked"
      : inFlight > 0 || unsettledEffects > 0
        ? "in-flight"
        : "drained";

  return Object.freeze({
    directory: options.directory,
    stateDirectory,
    ledgerFilePath: filePath,
    ledger: ledgerStatus,
    entries: Object.freeze(entries),
    blockers: Object.freeze(blockers),
    totals: Object.freeze({
      files: files.length,
      terminal,
      inFlight,
      blocked,
      legacyInFlight,
      outcomeInFlight,
      staleLocks,
      activelyExecuting,
      unsettledEffects,
      blockersByCode: Object.freeze(blockersByCode),
    }),
    verdict,
    drained: verdict === "drained",
  });
}

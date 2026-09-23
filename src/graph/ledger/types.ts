/**
 * Graph Execution Engine v2 — Durable acceptance ledger: record model and port
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The durable half of the outcome protocol's submission path
 * (docs/graph-outcome-protocol.md § "Submission and acceptance" and § "State,
 * storage, and effects"): the records an accepted submission commits, and the
 * PORT every substrate implements so the store stays swappable.
 *
 * What this module owns:
 * - `ReceiptRecord` — one committed decision per logical submission, keyed by
 *   `(graphId, attemptId, submissionId)`. That key is the idempotency key: the
 *   same key with the same normalized proposal returns the PERSISTED receipt,
 *   the same key with a different digest is a conflict, and a distinct terminal
 *   submission for an attempt that already settled is refused. All three rules
 *   are encoded in {@link CommitResult}.
 * - `AcceptedEventRecord` — the accepted-event stream, with AT MOST ONE event
 *   per `(graphId, attemptId)`: accepting a second terminal outcome for one
 *   execution is impossible by construction, not by convention.
 * - `PendingEffectRecord` — the effect ledger. Effects carry a STABLE id and a
 *   status, so a process that dies between the commit and the work can list
 *   what a previous process left `pending` or `started` and reconcile by id.
 *   Nothing in this module (or in the shipped store) EXECUTES an effect; it
 *   records one.
 *
 * {@link AcceptanceLedger} is the port. `ledgerFormatVersion` names the
 * durable layout the implementation writes, and every method is SYNCHRONOUS so
 * it can join a caller-supplied transaction. `runInTransaction` is the
 * documented EXTENSION POINT for the ONE atomic boundary the protocol requires
 * — acceptance receipt + accepted event + engine state change + pending effects
 * committed together — and it exposes the same write surface inside the
 * caller's transaction: {@link GraphStateRecord} IS that engine state for an
 * outcome-protocol graph, so `writeGraphState` joins the acceptance batch
 * instead of landing beside it (C3b).
 *
 * THE GRAPH STATE IS THE ONLY ENGINE STATE THIS PORT CARRIES. The legacy v2
 * run path and its file persistence were deleted with the legacy runtime;
 * nothing here reads or writes a legacy snapshot, and no module imports this
 * ledger for one.
 *
 * Timestamps are EPOCH MILLISECONDS supplied by the CALLER. Time is an explicit
 * input to the protocol (docs § "State, storage, and effects"), so the store
 * never reads a clock and a commit is reproducible from its batch alone.
 *
 * Dependency leaf: this module imports nothing (not even a type), so any
 * implementation, reducer or recovery module may depend on it without a cycle —
 * the same rationale as `storage-format.ts` / `execution-protocol.ts`.
 */

// ── Format identity ─────────────────────────────────────────────────────────

/**
 * The ledger layout this build writes.
 *
 * It is a named identity rather than a bare literal because the durable layout
 * is versioned independently of the records it holds: a store may only open a
 * file whose version row says EXACTLY this value, and an unknown, newer or
 * older version is refused rather than recreated or downgraded.
 *
 * VERSION 2 IS THE CONVERGED STORE (P1 item 3). The ledger's file became the
 * workspace's ONE authoritative store — the graph definition, the run state,
 * the accepted results, the host's execution bindings, the credential records
 * and the declaring-invocation record now live in the SAME database — so the
 * layout genuinely changed. A version-1 file holds five of the ten tables and
 * none of the host records; reading it as this build's store would answer
 * "no execution binding" for every effect it never carried, which is what lets
 * a recovery create a second execution for one effect. This build registers NO
 * migration, so a version-1 file is refused by name (`older-format`), never
 * widened in place and never downgraded.
 *
 * VERSION 3 ADDS THE RUN IDENTITY AND THE TRUSTED CONTROL RECORDS (P3 item 1).
 * A version-2 file holds neither `graph_runs` nor `graph_control_decisions`,
 * so it could not answer "which run is this, and was it stopped by a trusted
 * command?" — reading it as this build's store would report every controlled
 * run as merely executing. Same rule, same answer: refused by name, never
 * widened, never migrated (plan §3.6).
 *
 * VERSION 4 MAKES THE RUN THE SCOPING KEY (P3 item 2). A version-3 file keys the
 * graph state by GRAPH and holds runs one-per-graph, which is exactly the
 * assumption re-executing a terminal graph makes false: its `pendingEffects`
 * and `controlDecisions` reads answer every row of the GRAPH, so a later run's
 * recovery would be offered the earlier run's dispatches and cancellations. The
 * run id becomes part of the graph-state key, an explicit column of every
 * effect, and the `(graph, run)` pair of the run table; the control decision's
 * key gains the command so a `retry` can be recorded beside the fact it
 * supersedes. Same rule, same answer: refused by name, never widened, never
 * migrated (plan §3.6).
 */
export const LEDGER_FORMAT_VERSION = 4;

// ── Records ─────────────────────────────────────────────────────────────────

/**
 * One committed decision for one logical submission.
 *
 * The triple `(graphId, attemptId, submissionId)` is the submission's stable
 * idempotency key. `proposalDigest` is the digest of the normalized proposal
 * as the protocol computed it; a repeated key with the SAME digest is a replay,
 * with a DIFFERENT digest a conflict. `decision` is terminal for the
 * submission: a rejected proposal writes its receipt but does not enter the
 * accepted-event stream and does not settle the attempt.
 */
export interface ReceiptRecord {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  /** The plan revision the attempt is bound to. */
  readonly planRevision: string;
  /** Digest of the normalized proposal this decision was taken over. */
  readonly proposalDigest: string;
  readonly decision: "accepted" | "rejected";
  /** Epoch milliseconds, supplied by the caller. */
  readonly committedAt: number;
}

/**
 * One accepted outcome, appended to the accepted-event stream.
 *
 * At most ONE event may exist per `(graphId, attemptId)`: settlement is
 * single-shot, so a later submission can never overwrite the accepted result.
 * A rejected decision produces no event at all.
 */
export interface AcceptedEventRecord {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly planRevision: string;
  /** The accepted outcome identifier the plan routes on. */
  readonly outcomeId: string;
  /** Epoch milliseconds, supplied by the caller. */
  readonly acceptedAt: number;
}

/**
 * The lifecycle status of one effect.
 *
 * `pending` and `started` are UNSETTLED — a restart lists both, because an
 * effect a dead process left `started` still needs reconciliation. `done` and
 * `failed` are TERMINAL: a settled effect is never listed for resume and is
 * never rewound.
 */
export type EffectStatus = "pending" | "started" | "done" | "failed";

/**
 * One durable effect, keyed by `(graphId, effectId)`.
 *
 * The id is STABLE across processes (docs § "State, storage, and effects":
 * dispatch creation must support lookup/reconciliation by effect ID across the
 * crash-after-launch window). `payload` is opaque to the store, which persists
 * its JSON projection so an effect written by one process is readable by the
 * next.
 */
export interface PendingEffectRecord {
  readonly graphId: string;
  /**
   * The RUN this effect belongs to (P3 item 2, G3). Every effect is work one
   * run's state authorized, so a re-executed graph's successor run can never be
   * answered with the superseded run's rows — the run-scoped reads
   * ({@link AcceptanceLedgerTx.pendingEffects}) filter by exactly this value.
   *
   * ABSENT MEANS "THE RUN THAT IS CURRENT WHEN THIS ROW IS WRITTEN", and that is
   * a resolution the STORE performs inside the writing transaction, never a
   * default that invents a run: a write whose graph has no run identity, or
   * whose resolved run is not the graph's current run, is REFUSED by name
   * rather than filed under a run nobody can address. A reader always finds a
   * value here, because every committed row was resolved before it was written.
   */
  readonly runId?: string;
  readonly effectId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly payload: unknown;
  /** Epoch milliseconds, supplied by the caller. */
  readonly createdAt: number;
  readonly status: EffectStatus;
}

// ── Graph state ─────────────────────────────────────────────────────────────

/**
 * The largest graph-state body this ledger stores, in UTF-8 bytes.
 *
 * A state snapshot that cannot be stored must fail the transaction that would
 * have committed it rather than be truncated into a smaller, dishonest one. The
 * bound is checked BEFORE a row is written, so an oversized body rolls the
 * whole acceptance transaction back — receipt, accepted event and pending
 * effects included — and never leaves a half-committed batch.
 */
export const GRAPH_STATE_MAX_BYTES = 4_194_304;

/**
 * The persisted state snapshot of one outcome-protocol graph.
 *
 * This is the state half of the protocol's single atomic boundary
 * (docs/graph-outcome-protocol.md § "State, storage, and effects"): the runtime
 * holds a state, hands it here, and the caller's acceptance transaction writes
 * it together with the receipt, the accepted event and the pending effects.
 * There is deliberately no separate JSON file for such a graph — a state that
 * commits beside its acceptance instead of with it is exactly the failure mode
 * this record exists to remove.
 *
 * `body` is the state as the runtime holds it and the store persists its JSON
 * text; `planRevision` pins the snapshot to the compiled plan it belongs to, so
 * a state can never be read as the state of another revision. `updatedAt` is
 * epoch milliseconds supplied by the CALLER — time is an explicit input, so the
 * store never reads a clock.
 *
 * ONE row per `(graph, run)`: writing a snapshot REPLACES that run's previous
 * one (a run's current position is a value, not a log), and the replacement is
 * as atomic as the insert. A RE-EXECUTION does not replace anything: it mints a
 * NEW run whose own row is written, so the superseded run's last position stays
 * readable under its own id (P3 item 2, G3).
 */
export interface GraphStateRecord {
  readonly graphId: string;
  /**
   * The RUN whose position this snapshot records (P3 item 2, G3). A run's state
   * is written once per step and NEVER rewritten after the run is superseded:
   * re-executing a terminal graph mints a NEW run with its OWN snapshot, so the
   * superseded run's last position stays readable
   * ({@link RunControlLedger.readGraphStateOf}) instead of being overwritten by
   * the successor.
   *
   * ABSENT MEANS "THE RUN THAT IS CURRENT WHEN THIS ROW IS WRITTEN", resolved by
   * the store inside the writing transaction exactly like
   * {@link PendingEffectRecord.runId}: a graph with no run identity, or a write
   * aimed at a run that is no longer current, is REFUSED by name rather than
   * filed against a run the graph does not address any more.
   */
  readonly runId?: string;
  /** The compiled-plan revision this snapshot belongs to. */
  readonly planRevision: string;
  /** The state body; the store persists its JSON text verbatim. */
  readonly body: unknown;
  /** Epoch milliseconds, supplied by the caller. */
  readonly updatedAt: number;
}

// ── Run identity and trusted control (P3 item 1) ────────────────────────────

/**
 * The lifecycle/control commands this format can RECORD.
 *
 * The durable vocabulary is closed and spelled here (a SQL CHECK cannot import
 * a TypeScript union), and it is the same five commands the domain's
 * `ControlCommand` names (`src/graph/domain/model.ts`). None of them is a
 * business outcome: a failure, a cancellation, a timeout, a retry and a budget
 * stop are decided by the trusted control path, never derived from a submitted
 * payload (plan §3.4).
 *
 * A command being SPELLABLE is not a promise that this build applies it: the
 * control application refuses a command whose own semantics have not been
 * implemented yet, by name, instead of recording an intent nothing will honour.
 */
export type ControlCommandName =
  | "failure"
  | "cancel"
  | "timeout"
  | "retry"
  | "budget-stop";

/** The control commands this format records, in canonical order. */
export const CONTROL_COMMAND_NAMES: readonly ControlCommandName[] = Object.freeze([
  "failure",
  "cancel",
  "timeout",
  "retry",
  "budget-stop",
]);

/**
 * The trusted invocation that decided, as the host attributed it.
 *
 * `sessionId` is what the permission rule compares (the declaring principal's
 * session); `agentId` is recorded when the host attributes one. Both are
 * non-secret attribution, never a credential.
 */
export interface ControlPrincipalRecord {
  readonly sessionId: string;
  readonly agentId?: string;
}

/**
 * One run's IDENTITY: the execution of one logical graph the run path began.
 *
 * `runId` is minted once when the run's first state snapshot is committed,
 * inside the SAME transaction, so a run identity without the state it names is
 * unrepresentable. The key is `(graph_id, run_id)` — ONE row per RUN, not per
 * graph — and `run_seq` orders a graph's runs: the greatest sequence is the
 * CURRENT run (what {@link RunControlLedger.readRun} answers), while a
 * re-executed graph's earlier runs stay addressable by their own id with their
 * own plan revision, state, effects and receipts (P3 item 2, G3).
 */
export interface RunIdentityRecord {
  readonly graphId: string;
  readonly runId: string;
  /** Epoch milliseconds the run's first snapshot was committed at. */
  readonly startedAt: number;
  /**
   * The compiled-plan revision this run executes (P3 item 2). Recorded WITH the
   * run identity, so a superseded run's receipts and state keep addressing the
   * revision they were accepted under even after a later run executes a
   * different one. `planRevision` is therefore part of a run's identity, not a
   * property of the graph.
   */
  readonly planRevision: string;
}

/**
 * One run identity as the STORE holds it: the caller's record plus the
 * graph-local sequence the store allocated.
 *
 * `runSeq` orders the runs of one graph (the CURRENT run is the one with the
 * greatest sequence) and makes re-execution deterministic without reading a
 * clock: a successor is `runSeq + 1`, and the unique key `(graphId, runSeq)`
 * makes two racing successors unrepresentable.
 */
export interface StoredRunIdentity extends RunIdentityRecord {
  readonly runSeq: number;
}

/**
 * The durable TRUSTED DECISION that one terminal run is to be re-executed as a
 * new run (P3 item 2; plan §4 "终态图重新执行：创建新 run，保留旧 run 和回执").
 *
 * Owns: which run the trusted principal ordered re-executed, why, when, who
 * decided, and — once the re-execution has run — WHICH run succeeded it. The
 * row is a DECISION, not a run: it names no attempt, mints no attempt and
 * carries no plan, so it can never be read as a second run table. The successor
 * run row is the run; this row is the authorization the successor was created
 * under, which is why the successor link is written exactly once, inside the
 * transaction that mints the successor.
 *
 * WHY IT EXISTS AT ALL. The order and the execution are two commits (the order
 * is durable before any run is minted, exactly as a dispatch intent is durable
 * before any create), so a process that dies between them leaves a row a later
 * window — the boot sweep, the next `startDeclaredGraph` — can HONOUR instead
 * of a command nothing would ever finish.
 */
export interface RunReexecutionRecord {
  readonly graphId: string;
  /** The TERMINAL run this decision orders re-executed. */
  readonly runId: string;
  readonly reason: string;
  /** Epoch milliseconds the trusted decision was taken at. */
  readonly decidedAt: number;
  readonly decidedBy?: ControlPrincipalRecord;
  /**
   * The run minted to succeed {@link runId}, present exactly once the
   * re-execution committed. Absent means the order is still OWED.
   */
  readonly successorRunId?: string;
  /** Epoch milliseconds the successor run's first snapshot was committed at. */
  readonly successorStartedAt?: number;
}

/** The verdict of recording one re-execution decision. */
export type RunReexecutionWriteResult =
  | { readonly kind: "recorded"; readonly reexecution: RunReexecutionRecord }
  | {
      /** The same order is already recorded; nothing was written. */
      readonly kind: "replayed";
      readonly reexecution: RunReexecutionRecord;
    };

/**
 * One durable TRUSTED CONTROL DECISION for one attempt (P3 item 1).
 *
 * Owns: which {@link ControlCommandName} a trusted principal applied to one
 * attempt of one run, why, when, and who decided. An ATTEMPT carries at most
 * one control decision — the primary key is the attempt — exactly as it
 * carries at most one accepted event: two competing terminal facts for one
 * execution are unrepresentable rather than merely refused.
 * Writers: the control application service and ONLY it. A worker's submission
 * cannot reach this record: control is never derived from a submitted payload.
 */
export interface ControlDecisionRecord {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly command: ControlCommandName;
  readonly reason: string;
  /** Epoch milliseconds, supplied by the caller. */
  readonly decidedAt: number;
  /** The trusted invocation that decided, when the host attributes one. */
  readonly decidedBy?: ControlPrincipalRecord;
  /**
   * The attempt a `retry` MINTED in place of {@link attemptId} (P3 item 2).
   * Present EXACTLY for a retry: the decision is recorded against the attempt it
   * SUPERSEDES (which is what makes a repeated retry of that attempt a replay
   * instead of a second attempt), so this field is the durable link from the
   * superseded attempt to its successor. It is the identity a replay answers
   * with, and the reason a retried attempt can be named after the fact without
   * reading the run state.
   */
  readonly successorAttemptId?: string;
}

/**
 * The RUN-level control fact: the FIRST trusted command recorded for a run.
 *
 * It is written with the decision that produced it, in ONE transaction, and it
 * is never replaced — a later command for a DIFFERENT attempt (a second node's
 * failure; a cancel issued after a failure, which records its intent on every
 * in-flight attempt that carries no decision yet) is still recorded per
 * attempt, while an attempt that ALREADY carries a command is never
 * re-labelled and the run keeps the command that stopped it first. That is the
 * deterministic rule a repeated or racing command is resolved by, and it is
 * what a status/recovery reader asks instead of re-deriving a stop from
 * whichever decision happens to be read last.
 */
export interface RunControlRecord {
  readonly graphId: string;
  readonly runId: string;
  readonly command: ControlCommandName;
  readonly reason: string;
  /** Epoch milliseconds the stopping command was decided at. */
  readonly decidedAt: number;
  readonly decidedBy?: ControlPrincipalRecord;
}

/** One control write: the decision, plus the run state to set when unclaimed. */
export interface RunControlWrite {
  readonly decision: ControlDecisionRecord;
  /**
   * The run's control to SET when the run has none. The write is conditional on
   * the run still being unclaimed, so a racing second command never replaces
   * the first — it is told which command already stopped the run instead.
   *
   * ABSENT MEANS "THIS DECISION DOES NOT CLAIM THE RUN". A `retry` is the one
   * command that does not: it supersedes an attempt, it does not end the run,
   * so claiming the run's stop fact would make the successor attempt
   * unsettleable (every settlement path refuses a controlled run). Omitting it
   * records the decision and leaves the run's own control fact exactly as it
   * stands.
   */
  readonly runControl?: RunControlRecord;
}

/**
 * The verdict of one control-decision write.
 *
 * - `recorded` — the attempt carried no control decision: the decision row and
 *   (when the run was unclaimed) the run's control fact were written.
 * - `replayed` — the SAME command is already recorded for this attempt:
 *   nothing was written and the PERSISTED decision is returned.
 * - `conflict` — this attempt already carries a DIFFERENT command: nothing was
 *   written and the existing decision is returned. One attempt, one control
 *   fact.
 * - `settled` — the attempt has an ACCEPTED EVENT: nothing was written, because
 *   a settled attempt is never re-labelled by a control command. This check is
 *   part of the INSERT itself (a conditional `INSERT ... WHERE NOT EXISTS`), so
 *   it decides against the committed store rather than against a value read
 *   earlier in the transaction. The acceptance side carries the SYMMETRIC rule
 *   in the same shape: the FIRST statement of its batch write is a receipt
 *   INSERT conditioned on the run having no control fact, so NEITHER side
 *   decides from a read that precedes its write. Whichever of an acceptance and
 *   a control decision commits FIRST is therefore the fact that stands, at any
 *   concurrency, and the loser writes NOTHING.
 */
export type RunControlWriteResult =
  | {
      readonly kind: "recorded";
      readonly decision: ControlDecisionRecord;
      /**
       * The run's control fact AFTER the write — the one that stands, which is
       * the FIRST command recorded and therefore not necessarily this call's.
       * `undefined` when the run has none and this call did not claim one (a
       * retry), and when the graph holds no run row at all.
       */
      readonly runControl: RunControlRecord | undefined;
    }
  | {
      readonly kind: "replayed";
      readonly decision: ControlDecisionRecord;
      readonly runControl: RunControlRecord | undefined;
    }
  | {
      readonly kind: "conflict";
      readonly existing: ControlDecisionRecord;
      readonly runControl: RunControlRecord | undefined;
    }
  | {
      readonly kind: "settled";
      /** The attempt that had already settled when the write was attempted. */
      readonly attemptId: string;
      readonly runControl: RunControlRecord | undefined;
    };

/**
 * The RUN-IDENTITY and TRUSTED-CONTROL surface of a substrate.
 *
 * It is OPTIONAL on the transaction surface (`runs` below) for one reason:
 * the ledger port is implemented by substrates that predate control (a test
 * double, a read-only reader), and a substrate that cannot hold a control
 * record cannot have one — the run path reports no control stop for it rather
 * than inventing one, and the control entry refuses by name with no store to
 * write. A substrate that DOES implement it owns the uniqueness rules above.
 */
export interface RunControlLedger {
  /** The CURRENT run identity of one graph, or `undefined`. */
  readRun(graphId: string): StoredRunIdentity | undefined;
  /** Record a run identity, or return the one already recorded (idempotent). */
  mintRun(record: RunIdentityRecord): StoredRunIdentity;
  /**
   * ONE SUPERSEDED RUN, BY ITS OWN ID (P3 item 2).
   *
   * `readRun` answers the run a graph is executing NOW; this answers any run the
   * graph EVER executed, which is what makes an old run's receipts and state
   * addressable after a re-execution instead of merely "not the current one".
   */
  readRunOf(graphId: string, runId: string): StoredRunIdentity | undefined;
  /** Every run of one graph, oldest first (ascending `runSeq`). */
  runsOf(graphId: string): readonly StoredRunIdentity[];
  /**
   * Mint the SUCCESSOR of one run, conditional on that run still being the
   * graph's current one.
   *
   * This is the ONLY way a graph gets a second run, and it is deliberately a
   * separate operation from {@link mintRun}: `mintRun` is the idempotent
   * first-execution mint (a racing second caller is answered the first run), so
   * folding re-execution into it would make every repeated first-execution mint
   * a new run. `afterRunId` is the CURRENT run this successor supersedes: the
   * insert lands only while that run is still current, so two racers cannot both
   * mint a successor, and `undefined` means the graph moved on and NOTHING was
   * written.
   */
  mintNextRun(
    record: RunIdentityRecord,
    afterRunId: string,
  ): StoredRunIdentity | undefined;
  /** The run-level control fact of one graph's current run, or `undefined`. */
  readRunControl(graphId: string): RunControlRecord | undefined;
  /** The run-level control fact of ONE named run, or `undefined`. */
  readRunControlOf(graphId: string, runId: string): RunControlRecord | undefined;
  /** One run's re-execution decision, or `undefined`. */
  readReexecution(graphId: string, runId: string): RunReexecutionRecord | undefined;
  /**
   * Record the trusted order to re-execute one run. IDEMPOTENT on
   * `(graphId, runId)`: a repeated order REPLAYS the persisted decision (with
   * the successor it already minted, if any) and writes nothing.
   */
  recordReexecution(record: RunReexecutionRecord): RunReexecutionWriteResult;
  /**
   * Link the successor run to the order that authorized it, ONCE.
   *
   * Conditional on the order still being owed (`successor_run_id IS NULL`), so
   * a racing second executor loses and writes nothing. Called INSIDE the
   * transaction that mints the successor, so an order is never marked executed
   * without the run it names.
   */
  markReexecutionExecuted(
    graphId: string,
    runId: string,
    successorRunId: string,
    successorStartedAt: number,
  ): boolean;
  /** The control decision one attempt carries, or `undefined`. */
  readControlDecision(
    graphId: string,
    runId: string,
    nodeId: string,
    attemptId: string,
  ): ControlDecisionRecord | undefined;
  /**
   * The decision one attempt carries FOR ONE COMMAND, or `undefined`.
   *
   * The retry's idempotency key (P3 item 2): a retry is identified by the
   * attempt it SUPERSEDES, so the read that decides "record or replay" is
   * exactly this triple — and a repeated retry of that attempt must replay the
   * decision that minted its successor rather than minting another.
   */
  readControlCommandDecision(
    graphId: string,
    runId: string,
    nodeId: string,
    attemptId: string,
    command: ControlCommandName,
  ): ControlDecisionRecord | undefined;
  /**
   * The control decisions of ONE run, in decision order.
   *
   * RUN-SCOPED (G3). A command is a fact about one run's attempt, and a graph
   * that has been re-executed has more than one run: answering with every
   * decision of the GRAPH would hand a later run's reader the earlier run's
   * cancellations, retries and failures as if they belonged to the run it is
   * asking about. `runId` omitted means the graph's CURRENT run. A graph with
   * no run row at all has exactly one implicit run, so its decisions are
   * answered in full — that case is not a second run, it is the same run before
   * its identity was minted.
   */
  controlDecisions(
    graphId: string,
    runId?: string,
  ): readonly ControlDecisionRecord[];
  /** Record one decision and, when the run is unclaimed, its control fact. */
  writeControlDecision(write: RunControlWrite): RunControlWriteResult;
  /**
   * Take the store's WRITE LOCK for one graph's control path, inside the
   * caller's transaction, WITHOUT recording anything.
   *
   * WHY A LOCK IS AN OPERATION. A control command reads the graph definition,
   * the run, the state and the accepted events before it writes, and SQLite
   * refuses a shared-to-reserved lock PROMOTION immediately (`database is
   * locked`) when another connection already holds the write lock — it does not
   * wait on `busy_timeout`. Making the transaction's FIRST statement a write
   * turns that failure into a WAIT, so two commands racing for one attempt
   * serialize and the loser reads the winner's committed row and answers
   * `conflict`/`settled` rather than dying on a driver error. The statement
   * changes no value, so a surrounding transaction that rolls back leaves no
   * trace of it. A substrate without the control surface needs no lock.
   */
  lockControlWrite(graphId: string): void;
  /**
   * Claim one run's control fact with no attempt decision beside it.
   *
   * The run-wide case a cancel reaches when NOTHING is in flight: the run fact
   * IS the whole decision (a graph with every entry dispatch refused has no
   * attempt to name and still must be stoppable). Conditional on the run being
   * unclaimed, exactly like {@link RunControlLedger.writeControlDecision}, and
   * it answers with the fact that stands — this call's claim, or the first one.
   */
  claimRunControl(control: RunControlRecord): RunControlRecord | undefined;
}

// ── Commit surface ──────────────────────────────────────────────────────────

/** The idempotency key of one logical submission. */
export interface SubmissionKey {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
}

/**
 * One atomic acceptance batch: the receipt, its accepted event, and the pending
 * effects the acceptance produces.
 *
 * `acceptedEvent` is REQUIRED for an `accepted` decision and FORBIDDEN for a
 * `rejected` one — a rejected proposal does not enter the accepted-event stream
 * or settle the attempt. Every effect enters the batch `pending`: a started or
 * terminal effect is a transition, not part of the acceptance commit.
 */
export interface AcceptanceBatch {
  readonly receipt: ReceiptRecord;
  readonly acceptedEvent?: AcceptedEventRecord;
  readonly effects?: readonly PendingEffectRecord[];
}

/**
 * The verdict of one `commitAccepted`, encoding the protocol's idempotency
 * rules verbatim:
 *
 * - `committed` — the submission key and the attempt were both unclaimed: the
 *   receipt, the accepted event and every pending effect were written in ONE
 *   transaction that has ALREADY committed when this verdict is returned.
 * - `replayed` — the SAME logical submission (`graphId + attemptId +
 *   submissionId`) with the SAME `proposalDigest`: nothing is written and the
 *   PERSISTED receipt is returned exactly as it was first committed.
 * - `conflict` — the same submission key with a DIFFERENT digest: nothing is
 *   written, and the key stays bound to the proposal already committed under
 *   it.
 * - `settled` — the attempt already has an accepted event and this is a
 *   distinct terminal submission: nothing is written and the accepted result
 *   is never overwritten. `reason` names the settlement.
 * - `controlled` — the RUN has a trusted control fact (P3 item 1) and this
 *   batch belongs to it: nothing is written. CONTROL IS NOT OUTCOME (§3.4), so
 *   a controlled run commits no acceptance at all — no receipt, no accepted
 *   event, no state advance and no successor effect — and the fact that stopped
 *   the run is returned instead. It is the STRUCTURAL half of the rule the run
 *   path applies by name (`control-stopped`) before it settles: the check is the
 *   FIRST statement of the batch write, inside the committing transaction and
 *   against the COMMITTED store, so whichever of control and acceptance COMMITS
 *   first is the fact that stands and the loser writes nothing.
 * - `run-superseded` — the batch's attempt belongs to a run that is NO LONGER
 *   the graph's current run, so that run was superseded (P3 item 2,
 *   re-execution): nothing is written. A closed run's attempts accept nothing,
 *   exactly like a controlled run's.
 */
export type CommitResult =
  | { readonly kind: "committed"; readonly receipt: ReceiptRecord }
  | { readonly kind: "replayed"; readonly receipt: ReceiptRecord }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "settled"; readonly reason: string }
  | {
      readonly kind: "controlled";
      /** The run-level control fact that refused this acceptance. */
      readonly control: RunControlRecord;
      readonly reason: string;
    }
  | {
      /**
       * The ATTEMPT was SUPERSEDED by a trusted `retry`: nothing was written.
       *
       * The check is part of the FIRST statement of the batch write (a receipt
       * INSERT conditioned on no `retry` decision existing for this attempt), so
       * it decides against the COMMITTED store, not against a value read before
       * the write. A retry therefore can never race an acceptance into "both
       * facts landed": whichever commits first stands, and a retried attempt
       * accepts nothing afterwards — its result would belong to an execution the
       * node no longer holds, and the successor attempt carries the node
       * forward.
       */
      readonly kind: "superseded";
      /** The retry decision that superseded this attempt. */
      readonly decision: ControlDecisionRecord;
      readonly reason: string;
    }
  | {
      /**
       * The attempt belongs to a run the graph has SUPERSEDED (P3 item 2,
       * re-execution): nothing was written.
       *
       * A run-scoped retry closes the run it replaces and mints a successor, so
       * the closed run's attempts can never settle afterwards — their results
       * would be new terminal facts about a run whose receipts are already the
       * record of what it accepted. The check is part of the FIRST statement of
       * the batch write (a receipt INSERT conditioned on the attempt's own
       * dispatch effect being filed under the graph's CURRENT run), so it decides
       * against the COMMITTED store and a re-execution and a late acceptance can
       * never both land for one attempt, in either order.
       *
       * The attempt is bound to its run by the dispatch effect rows the
       * acceptance core itself settles: an attempt is armed by writing its effect
       * in the same transaction that records it, so an attempt that reached a
       * real acceptance always has one. An attempt with no effect row anywhere is
       * not attributable to a closed run by this store and is not refused here.
       *
       * A row filed under the reserved PRE-RUN generation (the implicit run of a
       * substrate that never minted one) IS attributable once the graph holds a
       * run identity: the graph has replaced the generation that row belonged
       * to, and `runId` reports the reserved id rather than inventing a run.
       */
      readonly kind: "run-superseded";
      /**
       * The run the attempt belongs to — no longer the graph's current run; the
       * reserved pre-run id when the attempt's effect was filed before the graph
       * had a run identity.
       */
      readonly runId: string;
      readonly reason: string;
    };

/**
 * The verdict of one effect status transition.
 *
 * - `transitioned` — the row moved to the requested status. The transition and
 *   the run/terminal fences are ONE conditional statement, so this verdict is
 *   reported only when that statement really changed a row.
 * - `unchanged` — the row already had that status; nothing was written.
 * - `refused` — nothing was written, for one of two reasons: the row is
 *   TERMINAL and the request would rewind it (a settled effect is never
 *   restarted — new work gets a new effect id), or the row belongs to a run —
 *   or to the reserved pre-run generation — the graph has SUPERSEDED, whose
 *   effects are immutable. `effect` is the row as it stands, with the status it
 *   kept; the reason names which fence refused it.
 * - `missing` — no such effect in that graph; nothing was written.
 */
export type EffectTransition =
  | { readonly kind: "transitioned"; readonly effect: PendingEffectRecord }
  | { readonly kind: "unchanged"; readonly effect: PendingEffectRecord }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly effect: PendingEffectRecord;
    }
  | { readonly kind: "missing"; readonly reason: string };

// ── Port ────────────────────────────────────────────────────────────────────

/**
 * The ledger's write surface, as seen INSIDE a transaction.
 *
 * A caller's `runInTransaction` callback receives this object instead of the
 * ledger itself, and it deliberately exposes every read and write the port
 * has — reads see the transaction's own uncommitted writes, and the engine
 * state write that lands with the reducer joins the same transaction through
 * this surface.
 */
export interface AcceptanceLedgerTx {
  /** Commit one batch atomically; see {@link CommitResult}. */
  commitAccepted(batch: AcceptanceBatch): CommitResult;
  /**
   * The persisted state snapshot of one graph's CURRENT RUN, or `undefined`
   * when the graph has never written one. Inside a transaction this reads the
   * transaction's own uncommitted snapshot, which is what makes a reducer's
   * transition a function of the state the acceptance is actually committing
   * against.
   *
   * RUN-SCOPED (G3). A graph that has been re-executed has more than one
   * snapshot, and the run path always acts on the run the graph is executing
   * NOW; a superseded run's snapshot stays readable through the control
   * surface's own `readGraphStateOf`, never through this one.
   */
  readGraphState(graphId: string): GraphStateRecord | undefined;
  /**
   * Write (or replace) one graph's state snapshot.
   *
   * Called INSIDE the caller's transaction so the state and the acceptance share
   * one boundary. A body that cannot be stored — unrepresentable as JSON, or
   * beyond {@link GRAPH_STATE_MAX_BYTES} — throws and fails the WHOLE
   * transaction: the batch that already wrote its receipt and event rolls back
   * with it, and no half-committed batch survives.
   */
  writeGraphState(record: GraphStateRecord): void;
  /** The persisted receipt for a submission key, or `undefined`. */
  lookupReceipt(key: SubmissionKey): ReceiptRecord | undefined;
  /** Every accepted event of one graph, in accepted order. */
  acceptedEvents(graphId: string): readonly AcceptedEventRecord[];
  /**
   * The UNSETTLED effects of ONE RUN — rows still `pending` or `started`.
   * Terminal effects are never listed; that stream IS the resume set.
   *
   * RUN-SCOPED (G3). An effect is work one run's state authorized, and a graph
   * that has been re-executed has more than one run: answering with every
   * unsettled effect of the GRAPH would offer a later run's recovery the earlier
   * run's dispatches, and — because a superseded attempt's effect is
   * deliberately never rewound — could report the older run's abandoned work as
   * this run's. `runId` omitted means the graph's CURRENT run. A graph with no
   * run row has one implicit run and is answered in full.
   */
  pendingEffects(graphId: string, runId?: string): readonly PendingEffectRecord[];
  /**
   * The attempts of one RUN whose cancellation the PLATFORM CONFIRMED — the
   * `done` cancel effects, which are terminal and therefore absent from
   * {@link pendingEffects}.
   *
   * WHY A SEPARATE READ. A confirmed cancellation is the one fact that accounts
   * for an external execution the run abandoned: the dispatch effect stays
   * unsettled (a cancel never rewinds it), so the only evidence that the
   * execution is over is this row. A run may be re-executed when every
   * unsettled dispatch is either superseded, settled, or covered here — and a
   * caller that had to infer it from the unsettled set alone would never see it.
   * `runId` omitted means the graph's current run.
   */
  confirmedCancelAttempts(graphId: string, runId?: string): readonly string[];
  /**
   * Write one NEW effect as the durable INTENT of work the transaction is
   * about to do — the atomic half of the outcome protocol's dispatch window.
   *
   * Called inside the SAME transaction as the state change the effect belongs
   * to, so a run that records a successor cannot commit the state without the
   * intent to start it (or the intent without the state that corroborates it).
   *
   * AN INTENT WRITE NEVER REWINDS A ROW. A row that already exists under
   * `(graphId, effectId)` is left EXACTLY as it is, whatever its status: a
   * second writer that raced this one must not move a `started` or terminal
   * effect back to `pending` and turn its settled history into a fresh
   * launch. The caller that needs a transition uses `markEffectStarted` /
   * `markEffectDone` / `markEffectFailed`, which carry their own terminal
   * guard.
   */
  writeEffect(record: PendingEffectRecord): void;
  markEffectStarted(graphId: string, effectId: string): EffectTransition;
  markEffectDone(graphId: string, effectId: string): EffectTransition;
  markEffectFailed(graphId: string, effectId: string): EffectTransition;
  /**
   * The run identity and trusted-control records of this substrate, or
   * `undefined` when it holds none.
   *
   * OPTIONAL, AND ABSENT IS NOT NEUTRAL. A substrate without this surface
   * cannot hold a control decision, so the run path reads NO control stop from
   * it (there is nothing to read) — while the control ENTRY refuses by name,
   * because a command it cannot record must not look applied. The shipped
   * store implements it; a focused test double need not.
   */
  readonly runs?: RunControlLedger;
}

/**
 * The durable acceptance ledger PORT.
 *
 * Implementations own a durable substrate and must provide:
 * - ATOMIC commit: every write of a batch commits together or not at all, and
 *   `committed` is never returned for an uncommitted batch.
 * - IDEMPOTENT replay, conflict and settlement rules exactly as
 *   {@link CommitResult} states them.
 * - RESTART SEMANTICS: a new instance over the same store sees the same rows,
 *   and `pendingEffects` answers what a previous process left unsettled.
 * - A FORMAT GATE: a store whose format version is unknown, newer or older —
 *   or that is not this ledger at all, down to the columns of its tables — is
 *   refused, never recreated or downgraded.
 * - A CLOSED ledger refuses further use with a clear error, and `close` is
 *   idempotent.
 */
export interface AcceptanceLedger extends AcceptanceLedgerTx {
  /** The ledger layout this implementation writes. */
  readonly ledgerFormatVersion: number;
  /**
   * Run `fn` inside ONE transaction and return its result after COMMIT.
   *
   * This is the protocol's single atomic boundary: the receipt, the accepted
   * event, the graph state change and the pending effects commit together, and
   * the callback receives the same write surface so `writeGraphState` joins the
   * acceptance batch rather than landing beside it. The callback MUST be
   * synchronous — a callback that returns a promise would run its writes outside
   * the transaction — and a nested call is refused rather than silently becoming
   * a savepoint.
   *
   * A rejection inside the callback rolls EVERYTHING back, including a batch the
   * callback already committed, so a state that cannot be stored can never leave
   * a receipt, an event or an effect behind.
   */
  runInTransaction<R>(fn: (tx: AcceptanceLedgerTx) => R): R;
  /** Close the substrate. Idempotent; a closed ledger refuses further use. */
  close(): void;
}

/**
 * Graph store — the ONE authoritative, workspace-scoped store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE CONVERGENCE. P1 item 3 forbids keeping two mutually dependent databases
 * that each commit and each claim atomicity. This class is the single durable
 * authority a workspace gets: one SQLite file
 * ({@link GRAPH_STORE_FILE}), one schema ({@link GRAPH_STORE_TABLES}), one
 * format gate ({@link verifyStore}) and ONE transaction boundary
 * ({@link GraphStore.transaction}) over
 *
 * - the graph definition and its compiled-plan snapshot,
 * - the run state,
 * - receipts, accepted events and accepted results,
 * - the effect ledger,
 * - the host's dispatch-execution bindings,
 * - the per-attempt credential RECORDS,
 * - and each graph's declaring invocation.
 *
 * The last three used to live in `rolebox-host-store.sqlite` and
 * `host-invocation-origins.json`. They are TABLES HERE NOW, and the modules
 * that used to own them (`execution-index.ts`, `credential-vault.ts`,
 * `invocation-origins.ts`) are typed facades over THIS store, so a worker's
 * acceptance, the effect it authorizes and the host binding that effect
 * produces can be written in one transaction instead of two that a crash can
 * separate.
 *
 * ONE TRANSACTION INTERFACE. {@link GraphStore.transaction} takes the whole
 * read/write surface — every table above — and is the only place a caller can
 * obtain it. It refuses a nested call by name (`nested-transaction`) instead of
 * silently becoming a savepoint with a different rollback scope, and it refuses
 * an async callback (`async-transaction`) because the driver's transaction
 * commits synchronously: an async callback would run its writes outside the
 * boundary. A compound operation the store performs on its own (the acceptance
 * commit, a create-right claim, a definition write) goes through
 * {@link GraphStore.joinOrBegin}, which JOINS an open transaction when there is
 * one and opens the single boundary otherwise — the same rule the ledger's
 * `commitAccepted` already applied, now shared by the host records too.
 *
 * NOTHING BLOCKING RUNS INSIDE A TRANSACTION. The store performs SQL only: no
 * file read, no command, no host API call is made from any method here, so the
 * boundary the plan requires (`§3.1`) stays a boundary over durable rows.
 *
 * ONE CONNECTION PER FILE PER PROCESS, REFERENCE COUNTED. Every store opened
 * over one file in one process shares that file's connection, because the run
 * path writes a host record (the attempt credential) INSIDE the acceptance
 * transaction: two connections to a rollback-journal SQLite file cannot overlap
 * that way — the second one's write would wait on a transaction that cannot
 * finish while the same thread is still running the reducer. Sharing the
 * connection puts those writes in ONE transaction; sharing the transaction
 * depth puts a second handle's compound write in that same transaction instead
 * of a second one. Cross-process behaviour is unchanged (a separate process has
 * its own connection and its own REAL transaction), `busy_timeout` is raised so
 * two processes over one file serialize instead of failing with `SQLITE_BUSY`,
 * and WAL is NOT enabled — the driver's default rollback journal is the
 * configuration the ledger already verified. Nothing here is a module-level
 * SINGLETON the caller cannot escape: a store closes its borrow on `close`,
 * and the last one closes the connection.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  createDatabase,
  createDatabaseSync,
  type DatabaseDriver,
} from "../../memory/db-driver.ts";
import { errorText } from "../../utils/error-text.ts";
import type {
  AcceptanceLedgerTx,
  AcceptedEventRecord,
  ApprovalDecideResult,
  ApprovalDecisionWrite,
  ApprovalLedger,
  ApprovalRaiseResult,
  ApprovalRequestRecord,
  ApprovalRequestStatus,
  BudgetLedger,
  BudgetReleaseInput,
  BudgetReleaseResult,
  BudgetReservationRecord,
  BudgetReserveInput,
  BudgetReserveResult,
  BudgetUsageInput,
  BudgetUsageResult,
  BudgetNodeUsage,
  CommitResult,
  ControlCommandName,
  ControlDecisionRecord,
  ControlPrincipalRecord,
  EffectTransition,
  GraphStateRecord,
  PendingEffectRecord,
  ReceiptRecord,
  RunControlLedger,
  RunControlRecord,
  RunControlWrite,
  RunControlWriteResult,
  RunIdentityRecord,
  RunReexecutionRecord,
  RunReexecutionWriteResult,
  StoredRunIdentity,
  SubmissionKey,
} from "../ledger/types.ts";
import {
  GraphStoreClosedError,
  GraphStoreFormatError,
  GraphStoreWriteError,
} from "./errors.ts";
import {
  emptyStoreRefusal,
  initializeStore,
  readStoreDirectory,
  retiredAuthorityRefusal,
  verifyStore,
} from "./format.ts";
import { BudgetTables } from "./budget-tables.ts";
import { encodeJsonBody } from "./json.ts";
import { LedgerTables } from "./ledger-tables.ts";
import {
  GRAPH_STORE_FORMAT_VERSION,
  GRAPH_STORE_TABLES,
  graphStoreFilePath,
} from "./schema.ts";
import type { HostExecutionRefusal } from "../host/execution-index.ts";
import type {
  AcceptedResultRecord,
  CredentialRecordIdentity,
  CredentialRetention,
  DefinitionWriteResult,
  ExecutionBindingRecord,
  ExecutionClaim,
  ExecutionConfirmation,
  ExecutionIdentity,
  ExecutionNotCreated,
  ExecutionRefusalKind,
  GraphAcceptanceBatch,
  GraphDefinitionRecord,
  InvocationOriginRecord,
  RetainedCredential,
  StoreEffectKey,
} from "./records.ts";

// ── Transaction surface ─────────────────────────────────────────────────────

/**
 * Everything one transaction may read and write.
 *
 * It EXTENDS the ledger port's own transaction surface, so a caller that
 * already holds an `AcceptanceLedgerTx` callback keeps working unchanged while
 * a caller that needs the host records gets them from the same object — one
 * interface, one commit, no second boundary to forget.
 */
export interface GraphStoreTx extends AcceptanceLedgerTx {
  /** The persisted definition of one graph, or `undefined`. */
  readDefinition(graphId: string): GraphDefinitionRecord | undefined;
  /** Write one graph's definition, preserving an unchanged one; see the verdict. */
  writeDefinition(record: GraphDefinitionRecord): DefinitionWriteResult;
  /** The accepted result of one settled attempt, or `undefined`. */
  readAcceptedResult(graphId: string, attemptId: string): AcceptedResultRecord | undefined;
  /** Write one accepted result; an existing result for the attempt is never replaced. */
  writeAcceptedResult(record: AcceptedResultRecord): void;
  /** Take the create right for one effect, or learn that it is held. */
  claimExecution(effect: StoreEffectKey, ownerId: string, now: number, leaseMs: number): ExecutionClaim;
  /** Record that the create request is about to be handed to the platform. */
  markExecutionCreating(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean;
  /** Record the execution the platform CONFIRMED, fenced by (ownerId, generation). */
  confirmExecution(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    execution: ExecutionIdentity,
    now: number,
  ): ExecutionConfirmation;
  /** Drop this (owner, generation)'s claim, ONLY with a not-created proof. */
  releaseExecution(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    proof: ExecutionNotCreated,
    now: number,
  ): boolean;
  /** Record a delivery failure that proved nothing; the claim is KEPT. */
  recordUnprovenFailure(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    now: number,
  ): void;
  /** One effect's binding row, or `undefined`. */
  readExecution(effect: StoreEffectKey): ExecutionBindingRecord | undefined;
  /** Upsert one attempt's credential RECORD; the value only when retained. */
  rememberCredential(
    identity: CredentialRecordIdentity,
    retention: CredentialRetention,
    credential: string | null,
    now: number,
  ): void;
  /** What the durable record says about one attempt's value. Never the value. */
  readCredentialRetention(identity: CredentialRecordIdentity): CredentialRetention | undefined;
  /** Drop one attempt's credential record. Idempotent. */
  forgetCredential(identity: CredentialRecordIdentity): void;
  /** Every RETAINED credential row. Never a listing API on the vault itself. */
  retainedCredentials(): readonly RetainedCredential[];
  /** Record one graph's declaring invocation; returns whether it CHANGED. */
  recordInvocationOrigin(graphId: string, origin: InvocationOriginRecord, now: number): boolean;
  /** The invocation that declared one graph, or `undefined`. */
  readInvocationOrigin(graphId: string): InvocationOriginRecord | undefined;
  /** Every graph id the origin table holds, sorted. */
  invocationOriginGraphIds(): readonly string[];
  /** Every graph id the store holds an immutable definition for, sorted. */
  definitionGraphIds(): readonly string[];
}

/** One row of an arbitrary query result, as a field bag. */
type Row = Readonly<Record<string, unknown>>;

/**
 * ONE CONNECTION PER STORE FILE PER PROCESS — and the transaction domain.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SECOND AUTHORITY. The workspace's host
 * records and its acceptance records are now in ONE database, and the run path
 * writes a host record INSIDE the acceptance transaction: the reducer mints an
 * attempt credential and remembers it while the state that records its digest is
 * being committed. Two connections to a rollback-journal SQLite file cannot do
 * that — the second connection's write waits on the first's transaction, which
 * cannot finish while the run path is still running its own JavaScript
 * synchronously. Sharing ONE connection per file makes the write land INSIDE the
 * caller's transaction, which is strictly what "one transaction boundary" means:
 * the credential record, the receipt, the accepted event, the effect and the run
 * state commit together, and they roll back together.
 *
 * `depth` lives HERE rather than on a store instance for the same reason: the
 * OPEN TRANSACTION belongs to the connection, so a second store object over the
 * same file must JOIN it rather than try to open its own. Cross-process
 * behaviour is unchanged — a separate process has its own map and its own real
 * SQLite transaction — and the read-only and read/write views take separate
 * entries because they are separate open modes.
 *
 * The map is reference counted: the connection closes when the last store over
 * it closes, so a test that opens and closes a store repeatedly does not leak.
 */
interface SharedConnection {
  readonly db: DatabaseDriver;
  /** How many live stores address this connection. */
  refs: number;
  /** Transaction nesting depth on THIS connection. */
  depth: number;
}

/** The open connections of this process, by path and mode. */
const CONNECTIONS = new Map<string, SharedConnection>();

/** Whether a value can be awaited (a transaction callback must not be). */
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  if (!("then" in value)) return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}

/** Name what was received for a diagnostic, without throwing on the value. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  return typeof value;
}

// ── The store ───────────────────────────────────────────────────────────────

/**
 * The authoritative store of one workspace.
 *
 * Construct it with {@link GraphStore.openFile} (or its async twin, used by the
 * acceptance ledger's own `create`): both run the SAME format gate, so the host
 * records and the acceptance records are always opened as one file.
 */
export class GraphStore {
  private readonly connection: SharedConnection;
  /** The registry key of this connection, or `undefined` for a private one. */
  private readonly connectionKey: string | undefined;
  private readonly db: DatabaseDriver;
  private readonly filePath: string;
  private readonly ledger: LedgerTables;
  private readonly runsView: RunControlLedger;
  private readonly approvalsView: ApprovalLedger;
  private readonly budgetTables: BudgetTables;
  private readonly budgetView: BudgetLedger;
  private readonly txView: GraphStoreTx;
  private closed = false;

  private constructor(
    connection: SharedConnection,
    connectionKey: string | undefined,
    filePath: string,
  ) {
    this.connection = connection;
    this.connectionKey = connectionKey;
    this.db = connection.db;
    this.filePath = filePath;
    this.ledger = new LedgerTables(
      connection.db,
      filePath,
      (work) => this.joinOrBegin(work),
      // The run-control fact is read through THIS store: the acceptance rule
      // (a controlled run accepts nothing) is evaluated on the same connection
      // and inside the same transaction as the batch it refuses. It is the
      // CURRENT run's fact (G3): a superseded run's stop refuses nothing in the
      // run that succeeded it.
      (graphId) => this.readRunControl(graphId),
      // Every effect and state row is filed under the graph's current run, and
      // the resolution happens inside the writing transaction.
      (graphId) => this.readRun(graphId)?.runId,
      // The inverse acceptance rule (P3 item 2): an attempt a trusted retry
      // SUPERSEDED accepts nothing, checked in the same boundary as the batch.
      (graphId, attemptId) => this.readSupersedingRetry(graphId, attemptId),
      // THE APPROVAL GATE, in the same boundary (P3 item 3): an attempt paused
      // on a request that is not `approved` accepts nothing. The read goes
      // through THIS store, so the gate sees the row a control command wrote in
      // the very transaction that is committing the batch.
      (graphId, attemptId) => this.blockingApproval(graphId, attemptId),
    );
    // THE RUN/CONTROL SURFACE IS ONE OBJECT, bound to this store. It is built
    // before the transaction view because that view hands the SAME object out
    // (see `runs` below), so a caller inside a transaction and a caller holding
    // the store address one interface and one boundary.
    this.runsView = Object.freeze({
      readRun: (graphId: string): StoredRunIdentity | undefined => this.readRun(graphId),
      mintRun: (record: RunIdentityRecord): StoredRunIdentity => this.mintRun(record),
      readRunOf: (graphId: string, runId: string): StoredRunIdentity | undefined =>
        this.readRunOf(graphId, runId),
      runsOf: (graphId: string): readonly StoredRunIdentity[] => this.runsOf(graphId),
      mintNextRun: (
        record: RunIdentityRecord,
        afterRunId: string,
      ): StoredRunIdentity | undefined => this.mintNextRun(record, afterRunId),
      readRunControl: (graphId: string): RunControlRecord | undefined =>
        this.readRunControl(graphId),
      readRunControlOf: (graphId: string, runId: string): RunControlRecord | undefined =>
        this.readRunControlOf(graphId, runId),
      readReexecution: (graphId: string, runId: string): RunReexecutionRecord | undefined =>
        this.readReexecution(graphId, runId),
      recordReexecution: (record: RunReexecutionRecord): RunReexecutionWriteResult =>
        this.recordReexecution(record),
      markReexecutionExecuted: (
        graphId: string,
        runId: string,
        successorRunId: string,
        successorStartedAt: number,
      ): boolean =>
        this.markReexecutionExecuted(graphId, runId, successorRunId, successorStartedAt),
      readControlDecision: (
        graphId: string,
        runId: string,
        nodeId: string,
        attemptId: string,
      ): ControlDecisionRecord | undefined =>
        this.readControlDecision(graphId, runId, nodeId, attemptId),
      readControlCommandDecision: (
        graphId: string,
        runId: string,
        nodeId: string,
        attemptId: string,
        command: ControlCommandName,
      ): ControlDecisionRecord | undefined =>
        this.readControlCommandDecision(graphId, runId, nodeId, attemptId, command),
      controlDecisions: (
        graphId: string,
        runId?: string,
      ): readonly ControlDecisionRecord[] => this.controlDecisions(graphId, runId),
      writeControlDecision: (write: RunControlWrite): RunControlWriteResult =>
        this.writeControlDecision(write),
      claimRunControl: (control: RunControlRecord): RunControlRecord | undefined =>
        this.claimRunControl(control),
      lockControlWrite: (graphId: string): void => this.lockControlWrite(graphId),
    });
    // THE APPROVAL SURFACE IS ONE OBJECT TOO (P3 item 3), built before the
    // transaction view because that view hands the SAME object out: a caller
    // inside a transaction and a caller holding the store address one interface
    // and one boundary, and the acceptance gate reads the request through the
    // very rows a raising command wrote in the same transaction.
    this.approvalsView = Object.freeze({
      readApprovalRequest: (graphId: string, attemptId: string): ApprovalRequestRecord | undefined =>
        this.readApprovalRequest(graphId, attemptId),
      approvalRequestsOf: (graphId: string, runId?: string): readonly ApprovalRequestRecord[] =>
        this.approvalRequestsOf(graphId, runId),
      blockingApproval: (graphId: string, attemptId: string): ApprovalRequestRecord | undefined =>
        this.blockingApproval(graphId, attemptId),
      raiseApprovalRequest: (record: ApprovalRequestRecord): ApprovalRaiseResult =>
        this.raiseApprovalRequest(record),
      decideApprovalRequest: (write: ApprovalDecisionWrite): ApprovalDecideResult =>
        this.decideApprovalRequest(write),
      expireDueApprovals: (graphId: string, at: number, reason: string): readonly ApprovalRequestRecord[] =>
        this.expireDueApprovals(graphId, at, reason),
      expireRunApprovals: (
        graphId: string,
        runId: string,
        at: number,
        reason: string,
      ): readonly ApprovalRequestRecord[] => this.expireRunApprovals(graphId, runId, at, reason),
    });
    // THE BUDGET SURFACE (P3 item 3). The dispatch reservations are ordinary
    // rows of THIS database, written through THIS connection and THIS boundary:
    // the runtime claims one inside the transaction that arms an attempt, so a
    // dispatch that committed without its claim does not exist, and a restart
    // reads the claims a previous process made.
    this.budgetTables = new BudgetTables(
      connection.db,
      filePath,
      (work) => this.joinOrBegin(work),
      (graphId) => this.readRun(graphId)?.runId,
    );
    this.budgetView = Object.freeze({
      reserveDispatch: (input: BudgetReserveInput): BudgetReserveResult =>
        this.budgetTables.reserveDispatch(input),
      reconcileUsage: (input: BudgetUsageInput): BudgetUsageResult =>
        this.budgetTables.reconcileUsage(input),
      releaseReservation: (input: BudgetReleaseInput): BudgetReleaseResult =>
        this.budgetTables.releaseReservation(input),
      readReservation: (
        graphId: string,
        attemptId: string,
        runId?: string,
      ): BudgetReservationRecord | undefined =>
        this.budgetTables.readReservation(graphId, attemptId, runId),
      reservationsOf: (
        graphId: string,
        runId?: string,
      ): readonly BudgetReservationRecord[] =>
        this.budgetTables.reservationsOf(graphId, runId),
      budgetUsageOf: (graphId: string, runId?: string): readonly BudgetNodeUsage[] =>
        this.budgetTables.budgetUsageOf(graphId, runId),
    });
    this.txView = Object.freeze({
      commitAccepted: (batch: GraphAcceptanceBatch): CommitResult =>
        this.commitAccepted(batch),
      readGraphState: (graphId: string): GraphStateRecord | undefined =>
        this.readGraphState(graphId),
      writeGraphState: (record: GraphStateRecord): void =>
        this.writeGraphState(record),
      writeEffect: (record: PendingEffectRecord): void =>
        this.writeEffect(record),
      lookupReceipt: (key: SubmissionKey): ReceiptRecord | undefined =>
        this.lookupReceipt(key),
      acceptedEvents: (graphId: string): readonly AcceptedEventRecord[] =>
        this.acceptedEvents(graphId),
      pendingEffects: (
        graphId: string,
        runId?: string,
      ): readonly PendingEffectRecord[] => this.pendingEffects(graphId, runId),
      confirmedCancelAttempts: (
        graphId: string,
        runId?: string,
      ): readonly string[] => this.confirmedCancelAttempts(graphId, runId),
      markEffectStarted: (graphId: string, effectId: string): EffectTransition =>
        this.markEffectStarted(graphId, effectId),
      markEffectDone: (graphId: string, effectId: string): EffectTransition =>
        this.markEffectDone(graphId, effectId),
      markEffectFailed: (graphId: string, effectId: string): EffectTransition =>
        this.markEffectFailed(graphId, effectId),
      readDefinition: (graphId: string): GraphDefinitionRecord | undefined =>
        this.readDefinition(graphId),
      writeDefinition: (record: GraphDefinitionRecord): DefinitionWriteResult =>
        this.writeDefinition(record),
      readAcceptedResult: (
        graphId: string,
        attemptId: string,
      ): AcceptedResultRecord | undefined =>
        this.readAcceptedResult(graphId, attemptId),
      writeAcceptedResult: (record: AcceptedResultRecord): void =>
        this.writeAcceptedResult(record),
      claimExecution: (
        effect: StoreEffectKey,
        ownerId: string,
        now: number,
        leaseMs: number,
      ): ExecutionClaim => this.claimExecution(effect, ownerId, now, leaseMs),
      markExecutionCreating: (
        effect: StoreEffectKey,
        ownerId: string,
        generation: number,
        now: number,
      ): boolean => this.markExecutionCreating(effect, ownerId, generation, now),
      confirmExecution: (
        effect: StoreEffectKey,
        ownerId: string,
        generation: number,
        execution: ExecutionIdentity,
        now: number,
      ): ExecutionConfirmation =>
        this.confirmExecution(effect, ownerId, generation, execution, now),
      releaseExecution: (
        effect: StoreEffectKey,
        ownerId: string,
        generation: number,
        proof: ExecutionNotCreated,
        now: number,
      ): boolean => this.releaseExecution(effect, ownerId, generation, proof, now),
      recordUnprovenFailure: (
        effect: StoreEffectKey,
        ownerId: string,
        generation: number,
        now: number,
      ): void => this.recordUnprovenFailure(effect, ownerId, generation, now),
      readExecution: (effect: StoreEffectKey): ExecutionBindingRecord | undefined =>
        this.readExecution(effect),
      rememberCredential: (
        identity: CredentialRecordIdentity,
        retention: CredentialRetention,
        credential: string | null,
        now: number,
      ): void => this.rememberCredential(identity, retention, credential, now),
      readCredentialRetention: (
        identity: CredentialRecordIdentity,
      ): CredentialRetention | undefined => this.readCredentialRetention(identity),
      forgetCredential: (identity: CredentialRecordIdentity): void =>
        this.forgetCredential(identity),
      retainedCredentials: (): readonly RetainedCredential[] =>
        this.retainedCredentials(),
      recordInvocationOrigin: (
        graphId: string,
        origin: InvocationOriginRecord,
        now: number,
      ): boolean => this.recordInvocationOrigin(graphId, origin, now),
      readInvocationOrigin: (
        graphId: string,
      ): InvocationOriginRecord | undefined => this.readInvocationOrigin(graphId),
      invocationOriginGraphIds: (): readonly string[] =>
        this.invocationOriginGraphIds(),
      definitionGraphIds: (): readonly string[] => this.definitionGraphIds(),
      runs: this.runsView,
      approvals: this.approvalsView,
      budget: this.budgetView,
    });
  }

  // ── Open ──────────────────────────────────────────────────────────────────

  /**
   * Open (or initialize) the store inside `root` — the SYNCHRONOUS twin.
   *
   * A host capability is constructed synchronously (an entry's own setup), so
   * this exists beside {@link openFileAsync} with identical behaviour: the
   * directory is created 0700 when absent, a genuinely absent store is
   * initialized in one transaction and VERIFIED afterwards, and an existing
   * file is verified and refused when it is not this build's store.
   *
   * A NON-EMPTY RETIRED AUTHORITY beside the path (`rolebox-host-store.sqlite`,
   * `host-invocation-origins.json`) is refused rather than initialized over:
   * this build does not convert those records, and answering "no execution
   * binding" for what they hold is what licenses a second execution for one
   * effect.
   */
  static openFile(root: string): GraphStore {
    return GraphStore.openAt(root, false);
  }

  /** Open (or initialize) the store inside `root` — the ASYNC twin. */
  static async openFileAsync(root: string): Promise<GraphStore> {
    return GraphStore.openAt(root, true);
  }

  /**
   * Verify an ALREADY OPEN, READ-ONLY connection and adopt it.
   *
   * The one caller is the read-only path (`load.ts` and the ledger's own
   * `openReadOnly`): both must run the SAME gate as the write path and must
   * never create, initialize or change the file, so the connection is opened
   * read-only by the caller and verified here. A refusal is thrown as the
   * store's format error; the caller closes the connection it still owns.
   */
  static openReadOnlyVerified(
    connection: SharedConnection,
    connectionKey: string,
    filePath: string,
  ): GraphStore {
    connection.db.exec("PRAGMA busy_timeout = 5000");
    try {
      verifyStore(connection.db, filePath);
    } catch (error) {
      // A refused read-only open must not leak the borrowed connection.
      GraphStore.releaseConnection(connection, connectionKey);
      throw error;
    }
    return new GraphStore(connection, connectionKey, filePath);
  }

  /** Borrow the process's read-only connection for one store file, synchronously. */
  static acquireReadOnlyConnection(filePath: string): BorrowedConnection {
    const key = "ro\u0000" + resolvePath(filePath);
    return {
      connection: GraphStore.acquireConnection(key, () =>
        createDatabaseSync(filePath, { readonly: true }),
      ),
      key,
    };
  }

  /** Borrow the process's read-only connection for one store file, asynchronously. */
  static async acquireReadOnlyConnectionAsync(
    filePath: string,
  ): Promise<BorrowedConnection> {
    const key = "ro\u0000" + resolvePath(filePath);
    const existing = CONNECTIONS.get(key);
    if (existing !== undefined) {
      existing.refs += 1;
      return { connection: existing, key };
    }
    const db = await createDatabase(filePath, { readonly: true });
    const connection: SharedConnection = { db, refs: 1, depth: 0 };
    CONNECTIONS.set(key, connection);
    return { connection, key };
  }

  /**
   * Open a private in-memory store with the SAME schema (durability: "memory").
   *
   * Never shared: `":memory:"` names a DIFFERENT database per connection, so a
   * caller that wants several capabilities on one process-only store opens one
   * `openMemory()` and injects it (see `OutcomeHost`).
   */
  static openMemory(): GraphStore {
    const connection: SharedConnection = {
      db: createDatabaseSync(":memory:"),
      refs: 1,
      depth: 0,
    };
    try {
      connection.db.exec("PRAGMA busy_timeout = 5000");
      initializeStore(connection.db, ":memory:");
      verifyStore(connection.db, ":memory:");
    } catch (error) {
      connection.db.close();
      if (error instanceof GraphStoreFormatError) throw error;
      throw new GraphStoreFormatError(
        "incomplete-store",
        ":memory:",
        "graph-store: the in-memory store could not be initialized (" +
          errorText(error) +
          ")",
        undefined,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    return new GraphStore(connection, undefined, ":memory:");
  }

  /** Shared open path for the sync and async factories. */
  private static openAt(root: string, async: true): Promise<GraphStore>;
  private static openAt(root: string, async: false): GraphStore;
  private static openAt(root: string, async: boolean): GraphStore | Promise<GraphStore> {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const reading = readStoreDirectory(root);
    if (reading.kind === "retired") throw retiredAuthorityRefusal(reading);
    const filePath = reading.filePath;
    // A ZERO-BYTE authoritative file is refused BEFORE the connection exists:
    // opening it with SQLite writes a fresh database header into it, which
    // would silently convert "damaged store" into "initialized store".
    if (reading.kind === "store" && reading.empty) {
      throw emptyStoreRefusal(filePath);
    }
    // A file that is already there is NEVER initialized, whatever it holds: the
    // gate below refuses a foreign or reshaped store.
    const initialize = reading.kind === "absent";
    const key = "rw\u0000" + resolvePath(filePath);
    if (async) {
      // The existing shared connection is reused even on the async path: the
      // open is still awaited so the async factory's shape is unchanged.
      const existing = CONNECTIONS.get(key);
      if (existing !== undefined) {
        existing.refs += 1;
        return Promise.resolve(
          GraphStore.openVerified(existing, key, filePath, initialize),
        );
      }
      return createDatabase(filePath).then((db) => {
        const connection: SharedConnection = { db, refs: 1, depth: 0 };
        CONNECTIONS.set(key, connection);
        return GraphStore.openVerified(connection, key, filePath, initialize);
      });
    }
    return GraphStore.openVerified(
      GraphStore.acquireConnection(key, () => createDatabaseSync(filePath)),
      key,
      filePath,
      initialize,
    );
  }

  /** The open-time gate, shared by every opener: verify, or create then verify. */
  private static openVerified(
    connection: SharedConnection,
    connectionKey: string | undefined,
    filePath: string,
    initialize: boolean,
  ): GraphStore {
    const db = connection.db;
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      if (initialize) initializeStore(db, filePath);
      verifyStore(db, filePath);
    } catch (error) {
      GraphStore.releaseConnection(connection, connectionKey);
      if (error instanceof GraphStoreFormatError) throw error;
      throw new GraphStoreFormatError(
        "incomplete-store",
        filePath,
        "graph-store: " +
          filePath +
          " could not be opened as this build's graph store (" +
          errorText(error) +
          ") — refusing to treat a file this build cannot read as a new store",
        undefined,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    return new GraphStore(connection, connectionKey, filePath);
  }

  /**
   * Borrow the process's connection for `key`, opening one when it is the
   * first. The borrow is reference counted; {@link releaseConnection} returns
   * it.
   */
  private static acquireConnection(
    key: string,
    open: () => DatabaseDriver,
  ): SharedConnection {
    const existing = CONNECTIONS.get(key);
    if (existing !== undefined) {
      existing.refs += 1;
      return existing;
    }
    const connection: SharedConnection = { db: open(), refs: 1, depth: 0 };
    CONNECTIONS.set(key, connection);
    return connection;
  }

  /** Return one borrow; the LAST one closes the connection. */
  private static releaseConnection(
    connection: SharedConnection,
    key: string | undefined,
  ): void {
    if (key === undefined) {
      try {
        connection.db.close();
      } catch {
        // A release failure cannot replace the caller's own outcome.
      }
      return;
    }
    connection.refs -= 1;
    if (connection.refs > 0) return;
    CONNECTIONS.delete(key);
    try {
      connection.db.close();
    } catch {
      // A release failure cannot replace the caller's own outcome.
    }
  }

  /** The file this store owns, or `":memory:"`. */
  get path(): string {
    return this.filePath;
  }

  /** Whether this store outlives the process. */
  get durable(): boolean {
    return this.filePath !== ":memory:";
  }

  /** The format this store writes and verifies. */
  get formatVersion(): number {
    return GRAPH_STORE_FORMAT_VERSION;
  }

  // ── Low-level surface (the host facades and focused probes) ───────────────

  /** Run one statement. */
  run(sql: string, ...params: unknown[]): void {
    this.assertOpen("run");
    this.db.run(sql, ...params);
  }

  /** One row, or `undefined`. */
  get(sql: string, ...params: unknown[]): Row | undefined {
    this.assertOpen("get");
    const row = this.db.query(sql).get(...params);
    return typeof row === "object" && row !== null && !Array.isArray(row)
      ? (row as Row)
      : undefined;
  }

  /** Every row. */
  all(sql: string, ...params: unknown[]): Row[] {
    this.assertOpen("all");
    const rows = this.db.query(sql).all(...params);
    const out: Row[] = [];
    for (const row of rows) {
      if (typeof row === "object" && row !== null && !Array.isArray(row)) {
        out.push(row as Row);
      }
    }
    return out;
  }

  /**
   * SQLite's own count of rows the last statement changed on THIS connection.
   * The conditional transitions depend on it, so the driver's `run` (which
   * discards the count) is not used for them.
   */
  changes(): number {
    this.assertOpen("changes");
    const row = this.get("SELECT changes() AS changed");
    const changed = row?.["changed"];
    return typeof changed === "number" ? changed : 0;
  }

  // ── The ONE transaction boundary ──────────────────────────────────────────

  /**
   * Run `fn` inside ONE transaction and return its result after COMMIT.
   *
   * This is the protocol's single atomic boundary, and the ONLY way a caller
   * obtains the store's write surface: the receipt, the accepted event, the
   * accepted result, the run-state change, the pending effects, the graph
   * definition and every host record commit together or not at all. The
   * callback MUST be synchronous — a promise would run its writes outside the
   * transaction — and a nested call is REFUSED rather than silently becoming a
   * savepoint whose rollback scope differs.
   */
  transaction<R>(fn: (tx: GraphStoreTx) => R): R {
    this.assertOpen("runInTransaction");
    if (this.connection.depth > 0) {
      throw new GraphStoreWriteError(
        "nested-transaction",
        "graph-store: runInTransaction is not re-entrant — the store boundary is ONE transaction, and a nested call is refused rather than silently becoming a savepoint whose rollback scope differs",
      );
    }
    return this.inTransaction(() => {
      const result = fn(this.txView);
      if (isThenable(result)) {
        throw new GraphStoreWriteError(
          "async-transaction",
          "graph-store: the runInTransaction callback returned a promise — the transaction commits synchronously, so an async callback would run its writes OUTSIDE the atomic boundary; pass a synchronous callback",
        );
      }
      return result;
    });
  }

  /**
   * Run `work` inside the OPEN transaction when there is one, and inside the
   * single transaction otherwise.
   *
   * A compound store operation (an acceptance commit, a create-right claim, a
   * definition write) is atomic on its own AND joins a caller's boundary
   * instead of opening a second one — the rule the ledger's `commitAccepted`
   * already applied, now shared by every table this store owns.
   */
  joinOrBegin<R>(work: () => R): R {
    this.assertOpen("joinOrBegin");
    if (this.connection.depth > 0) return work();
    return this.inTransaction(work);
  }

  /**
   * Wrap one synchronous callback in the driver's transaction.
   *
   * The depth lives on the CONNECTION, so a store object that borrowed the same
   * connection sees the open transaction and joins it instead of opening a
   * second one over the same file.
   */
  private inTransaction<R>(work: () => R): R {
    this.connection.depth += 1;
    try {
      return this.db.transaction(work)();
    } finally {
      this.connection.depth -= 1;
    }
  }

  // ── Ledger records (the port's own surface, delegated) ────────────────────

  /** Commit one acceptance batch atomically; see {@link CommitResult}. */
  commitAccepted(batch: GraphAcceptanceBatch): CommitResult {
    this.assertOpen("commitAccepted");
    return this.ledger.commitAccepted(batch);
  }

  /** The persisted state snapshot of one graph, or `undefined`. */
  readGraphState(graphId: string): GraphStateRecord | undefined {
    this.assertOpen("readGraphState");
    return this.ledger.readGraphState(graphId);
  }

  /** ONE run's state snapshot, by its own id. */
  readGraphStateOf(graphId: string, runId: string): GraphStateRecord | undefined {
    this.assertOpen("readGraphStateOf");
    return this.ledger.readGraphStateOf(graphId, runId);
  }

  /** Write (or replace) one graph's state snapshot. */
  writeGraphState(record: GraphStateRecord): void {
    this.assertOpen("writeGraphState");
    this.ledger.writeGraphState(record);
  }

  /** The persisted receipt for a submission key, or `undefined`. */
  lookupReceipt(key: SubmissionKey): ReceiptRecord | undefined {
    this.assertOpen("lookupReceipt");
    return this.ledger.lookupReceipt(key);
  }

  /** Every accepted event of one graph, in accepted order. */
  acceptedEvents(graphId: string): readonly AcceptedEventRecord[] {
    this.assertOpen("acceptedEvents");
    return this.ledger.acceptedEvents(graphId);
  }

  /** The UNSETTLED effects of one graph — rows still `pending` or `started`. */
  pendingEffects(graphId: string, runId?: string): readonly PendingEffectRecord[] {
    this.assertOpen("pendingEffects");
    return this.ledger.pendingEffects(graphId, runId);
  }

  /** The attempts of one run whose cancellation the PLATFORM CONFIRMED. */
  confirmedCancelAttempts(graphId: string, runId?: string): readonly string[] {
    this.assertOpen("confirmedCancelAttempts");
    return this.ledger.confirmedCancelAttempts(graphId, runId);
  }

  /** Write one NEW effect as the durable INTENT of work about to be done. */
  writeEffect(record: PendingEffectRecord): void {
    this.assertOpen("writeEffect");
    this.ledger.writeEffect(record);
  }

  markEffectStarted(graphId: string, effectId: string): EffectTransition {
    this.assertOpen("markEffectStarted");
    return this.ledger.markEffectStarted(graphId, effectId);
  }

  markEffectDone(graphId: string, effectId: string): EffectTransition {
    this.assertOpen("markEffectDone");
    return this.ledger.markEffectDone(graphId, effectId);
  }

  markEffectFailed(graphId: string, effectId: string): EffectTransition {
    this.assertOpen("markEffectFailed");
    return this.ledger.markEffectFailed(graphId, effectId);
  }

  // ── Accepted result ───────────────────────────────────────────────────────

  /** Write one accepted result; an existing result for the attempt is never replaced. */
  writeAcceptedResult(record: AcceptedResultRecord): void {
    this.assertOpen("writeAcceptedResult");
    this.ledger.writeAcceptedResult(record);
  }

  /** The accepted result of one settled attempt, or `undefined`. */
  readAcceptedResult(
    graphId: string,
    attemptId: string,
  ): AcceptedResultRecord | undefined {
    this.assertOpen("readAcceptedResult");
    return this.ledger.readAcceptedResult(graphId, attemptId);
  }

  // ── Graph definition ──────────────────────────────────────────────────────

  /**
   * Write one graph's immutable definition, or preserve/refuse the stored one.
   *
   * The rule is the declaration path's own (`declaration-changed`): an
   * unchanged digest with the same plan revision is PRESERVED without a write,
   * and a different one is refused WITHOUT a write — a definition a run may be
   * executing is never replaced in place.
   */
  writeDefinition(record: GraphDefinitionRecord): DefinitionWriteResult {
    this.assertOpen("writeDefinition");
    assertDefinitionShape(record);
    return this.joinOrBegin(() => {
      const current = this.readDefinition(record.graphId);
      if (current !== undefined) {
        return current.declarationDigest === record.declarationDigest &&
          current.planRevision === record.planRevision
          ? { kind: "preserved", definition: current }
          : { kind: "changed", definition: current };
      }
      try {
        this.db.run(
          `INSERT INTO ${GRAPH_STORE_TABLES.definitions}
             (graph_id, declaration_digest, plan_revision, declaration, plan, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          record.graphId,
          record.declarationDigest,
          record.planRevision,
          encodeJsonBody(
            record.declaration,
            `the declaration of graph ${record.graphId}`,
            "unrepresentable-record",
          ),
          encodeJsonBody(
            record.plan,
            `the compiled plan of graph ${record.graphId}`,
            "unrepresentable-record",
          ),
          record.recordedAt,
        );
      } catch (error) {
        if (error instanceof GraphStoreWriteError) throw error;
        throw new GraphStoreWriteError(
          "write-rejected",
          `graph-store: the store rejected the definition of graph ${record.graphId} (${errorText(error)}) — the transaction rolled back, so nothing from it was committed`,
        );
      }
      return { kind: "recorded" as const };
    });
  }

  /** The persisted definition of one graph, or `undefined`. */
  readDefinition(graphId: string): GraphDefinitionRecord | undefined {
    this.assertOpen("readDefinition");
    const row = this.db
      .query(
        `SELECT graph_id, declaration_digest, plan_revision, declaration, plan, recorded_at
         FROM ${GRAPH_STORE_TABLES.definitions}
         WHERE graph_id = ?`,
      )
      .get(graphId);
    if (row === undefined || row === null) return undefined;
    const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.definitions);
    return {
      graphId: readStoreText(entry, "graph_id", this.filePath, GRAPH_STORE_TABLES.definitions),
      declarationDigest: readStoreText(
        entry,
        "declaration_digest",
        this.filePath,
        GRAPH_STORE_TABLES.definitions,
      ),
      planRevision: readStoreText(
        entry,
        "plan_revision",
        this.filePath,
        GRAPH_STORE_TABLES.definitions,
      ),
      declaration: readStoreJson(
        entry,
        "declaration",
        this.filePath,
        GRAPH_STORE_TABLES.definitions,
      ),
      plan: readStoreJson(entry, "plan", this.filePath, GRAPH_STORE_TABLES.definitions),
      recordedAt: readStoreEpoch(
        entry,
        "recorded_at",
        this.filePath,
        GRAPH_STORE_TABLES.definitions,
      ),
    };
  }

  /**
   * Every graph id this store holds an immutable DEFINITION for, sorted.
   *
   * The declared-graph read paths enumerate through this: a graph this build
   * can run is one whose definition is in the store, so the listing is the
   * "which graphs exist" answer the retired per-graph container used to give by
   * its file names. It reads the primary key only — a caller that needs the
   * definition calls {@link readDefinition}.
   */
  definitionGraphIds(): readonly string[] {
    this.assertOpen("definitionGraphIds");
    const rows = this.db
      .query(`SELECT graph_id FROM ${GRAPH_STORE_TABLES.definitions}`)
      .all();
    const ids: string[] = [];
    for (const row of rows) {
      const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.definitions);
      ids.push(
        readStoreText(entry, "graph_id", this.filePath, GRAPH_STORE_TABLES.definitions),
      );
    }
    return Object.freeze(ids.sort());
  }

  // ── Host execution bindings ───────────────────────────────────────────────

  /**
   * Take the right to create this effect's execution, or be told it is held.
   *
   * ONE transaction, THREE outcomes: the effect is new (`claimed`), this
   * instance already holds it (`claimed`, idempotent), or another
   * claim/execution owns it (`held`). A `pending` claim whose lease expired is
   * taken over INSIDE the transaction with a conditional update, so two
   * instances racing for the same stale claim cannot both win. The primary key
   * `(graph_id, effect_id)` is the cross-instance uniqueness the create-once
   * rule needs.
   *
   * THE CLAIM GENERATION IS MINTED HERE (P2 item 3). A fresh row starts at 1 and
   * every ownership transition raises it by one, so the generation identifies
   * the CLAIM rather than the owner: a process restarted under the same owner id
   * presents a generation the row has moved past, and every later conditional
   * write it attempts is refused. The claimed answer reports it; the store never
   * hands out a claim without one.
   *
   * A RELEASED CLAIM IS FREE IMMEDIATELY. A claim released after a PROVEN
   * not-created (`released_at` set) can be taken over by the next claimant
   * without waiting for the lease: by the proof that released it, no execution
   * exists and nobody is mid-handoff. A live claim is still taken over only once
   * its lease has lapsed.
   */
  claimExecution(
    effect: StoreEffectKey,
    ownerId: string,
    now: number,
    leaseMs: number,
  ): ExecutionClaim {
    this.assertOpen("claimExecution");
    return this.joinOrBegin(() => {
      // The insert is FIRST and IGNORES a conflict, so the transaction takes
      // the write lock before it reads: a racing instance's insert either wins
      // (this one reads the winner's row and is told "held") or waits on the
      // lock. Inserting after a read would let a deferred transaction see a
      // stale snapshot and fail on promotion instead of answering.
      this.db.run(
        `INSERT OR IGNORE INTO ${GRAPH_STORE_TABLES.executions} (graph_id, effect_id, attempt_id, state, owner_id, owner_generation, execution_id, task_id, claimed_at, updated_at, released_at)
         VALUES (?, ?, ?, 'pending', ?, 1, NULL, NULL, ?, ?, NULL)`,
        effect.graphId,
        effect.effectId,
        effect.attemptId,
        ownerId,
        now,
        now,
      );
      const row = this.readExecution(effect);
      if (row === undefined) {
        throw new GraphStoreWriteError(
          "write-rejected",
          "graph-store: the execution binding for effect " +
            JSON.stringify(effect.effectId) +
            " could not be written or read back — refusing to report a claim this store does not hold",
        );
      }
      if (row.state !== "pending") return heldClaim(row);
      if (row.ownerId === ownerId) {
        return Object.freeze({
          kind: "claimed" as const,
          ownerId,
          generation: row.generation,
        });
      }
      if (row.releasedAt === undefined && row.claimedAt + leaseMs > now) return heldClaim(row);
      // ONE conditional takeover, naming the claim it observed: a racing
      // instance wins or loses this statement, and the generation moves with it.
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.executions}
            SET owner_id = ?, owner_generation = owner_generation + 1, claimed_at = ?, updated_at = ?, released_at = NULL
          WHERE graph_id = ? AND effect_id = ? AND state = 'pending' AND owner_id = ? AND owner_generation = ? AND released_at IS ` +
          (row.releasedAt === undefined ? "NULL" : "NOT NULL"),
        ownerId,
        now,
        now,
        effect.graphId,
        effect.effectId,
        row.ownerId,
        row.generation,
      );
      if (this.changes() === 1) {
        const claimed = this.readExecution(effect);
        return Object.freeze({
          kind: "claimed" as const,
          ownerId,
          generation: claimed?.generation ?? row.generation + 1,
        });
      }
      const after = this.readExecution(effect);
      return after === undefined
        ? Object.freeze({ kind: "claimed" as const, ownerId, generation: row.generation + 1 })
        : heldClaim(after);
    });
  }

  /**
   * Record that the create request is ABOUT TO BE handed to the platform.
   *
   * Called BEFORE the delivery, never after: the row must say `creating` for
   * the whole window in which the platform may have received the request, so a
   * crash inside that window leaves `unknown` rather than a claim that looks
   * safely retryable.
   *
   * FENCED BY THE CLAIM. The row must be THIS `(owner_id, owner_generation)`'s
   * pending claim: a superseded claim cannot hand anything over, and the
   * conditional update is what decides. A claim that was released is re-armed
   * here too (`released_at` is cleared in the same statement), because handing a
   * request over is exactly what a released claim has not done yet.
   */
  markExecutionCreating(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    this.assertOpen("markExecutionCreating");
    this.db.run(
      `UPDATE ${GRAPH_STORE_TABLES.executions}
          SET state = 'creating', released_at = NULL, updated_at = ?
        WHERE graph_id = ? AND effect_id = ? AND owner_id = ? AND owner_generation = ? AND state = 'pending'`,
      now,
      effect.graphId,
      effect.effectId,
      ownerId,
      generation,
    );
    return this.changes() === 1;
  }

  /**
   * Record the host execution the platform CONFIRMED.
   *
   * The execution id is required and non-empty: `created` is the one state a
   * lookup reports as a fact, so it may only be written with the fact — the
   * store's own CHECK makes the alternative unrepresentable.
   *
   * FENCED, AND THE REFUSAL IS KEPT (P2 item 3). The conditional update names
   * the CLAIM that is confirming — `(owner_id, owner_generation)` — and the row
   * must be that claim's `creating` row. A confirmation from an owner whose
   * claim was taken over, or from a process that never held one, writes NOTHING;
   * the attempt (kind, owner, generation, execution id, instant) is recorded on
   * the row with `refused_count` raised, so a stale write is diagnosable after
   * the fact instead of being dropped on the floor.
   *
   * The verdict distinguishes the idempotent re-report (`replayed`: the same
   * execution the row already records) from a DIVERGENT execution (`conflict`:
   * two executions for one stable effect id, reported and recorded rather than
   * overwritten).
   */
  confirmExecution(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    execution: ExecutionIdentity,
    now: number,
  ): ExecutionConfirmation {
    this.assertOpen("confirmExecution");
    if (typeof execution.executionId !== "string" || execution.executionId.length === 0) {
      throw new GraphStoreWriteError(
        "invalid-record",
        "graph-store: refusing to record effect " +
          JSON.stringify(effect.effectId) +
          " as created without a non-empty host execution id — 'created' is the host's " +
          "confirmed fact, and a state that claims one without naming the execution " +
          "cannot be reconciled against the platform",
      );
    }
    return this.joinOrBegin(() => {
      // THE CONDITIONAL WRITE GOES FIRST, AND THAT ORDER IS THE POINT.
      // A transaction that READS first and writes afterwards has to PROMOTE its
      // shared lock to a reserved one, and while a racing process holds the
      // store's write lock SQLite refuses that promotion IMMEDIATELY — the busy
      // handler never runs — so this statement raised `database is locked` from a
      // real second process instead of waiting its turn. It is the only
      // read-then-write statement on the dispatch path, and the one a claim race
      // exercises hardest. Writing first takes the reserved lock the way
      // `claimExecution`'s leading `INSERT OR IGNORE` does, so a contended
      // confirmation waits on `busy_timeout` and then decides on the row. The
      // WHERE clause is the whole fence: a replayed, conflicting or stale
      // confirmation changes nothing, so the read below still classifies the
      // row the caller was refused by.
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.executions} SET state = 'created', execution_id = ?, task_id = ?, updated_at = ?
         WHERE graph_id = ? AND effect_id = ? AND owner_id = ? AND owner_generation = ? AND state = 'creating'`,
        execution.executionId,
        execution.taskId ?? null,
        now,
        effect.graphId,
        effect.effectId,
        ownerId,
        generation,
      );
      if (this.changes() === 1) {
        return Object.freeze({ kind: "confirmed" as const, execution: identityOf(execution) });
      }
      // The write applied to NO row, so this call left the row untouched and the
      // read below only classifies WHY it was refused.
      const row = this.readExecution(effect);
      if (row === undefined) return Object.freeze({ kind: "absent" as const });
      const current = row.ownerId === ownerId && row.generation === generation;
      if (current && row.state === "created" && row.execution !== undefined) {
        if (row.execution.executionId === execution.executionId) {
          return Object.freeze({ kind: "replayed" as const, execution: row.execution });
        }
        this.recordExecutionRefusal(
          effect,
          "conflicting-execution",
          ownerId,
          generation,
          execution.executionId,
          now,
        );
        return Object.freeze({
          kind: "conflict" as const,
          recorded: row.execution,
          reported: identityOf(execution),
        });
      }
      if (!current || row.state !== "creating") {
        this.recordExecutionRefusal(
          effect,
          "stale-confirmation",
          ownerId,
          generation,
          execution.executionId,
          now,
        );
        return Object.freeze({
          kind: "fenced" as const,
          reason: fencedReason(row, ownerId, generation),
          state: row.state,
          ownerId: row.ownerId,
          generation: row.generation,
          attemptedOwnerId: ownerId,
          attemptedGeneration: generation,
        });
      }
      // Unreachable on this transaction's own connection: the write above names
      // exactly this claim and this state, and a failed write still took the
      // reserved lock, so no other process can move the row in between. Kept
      // total — a conditional write that applied to no row is a refusal, never a
      // reported success.
      return Object.freeze({
        kind: "fenced" as const,
        reason:
          "the conditional confirmation applied to no row — the claim stopped being the row's current one",
        state: row.state,
        ownerId: row.ownerId,
        generation: row.generation,
        attemptedOwnerId: ownerId,
        attemptedGeneration: generation,
      });
    });
  }

  /**
   * Record a delivery failure that proved NOTHING about whether an execution
   * exists, WITHOUT touching the claim (P2 item 4).
   *
   * The row stays exactly as it was — `creating`, every lookup answering
   * `unknown` — and the failure is recorded as an `unproven-failure` refusal so
   * the reason a re-dispatch did not happen is durable rather than inferred. An
   * asynchronous rejection and a timeout take this path; only a proven
   * not-created releases the claim (see {@link releaseExecution}).
   */
  recordUnprovenFailure(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    now: number,
  ): void {
    this.assertOpen("recordUnprovenFailure");
    this.recordExecutionRefusal(
      effect,
      "unproven-failure",
      ownerId,
      generation,
      undefined,
      now,
    );
  }

  /**
   * Record one refused write on a row, without changing its claim or its state.
   *
   * The last refusal is kept (`refused_*`) with a count, so "this row refused
   * owner A's claim 3 for execution X at T" survives the process that asked.
   * `generation` 0 — the caller held no claim at all — is stored as NULL, which
   * is what the column's own CHECK allows.
   */
  private recordExecutionRefusal(
    effect: StoreEffectKey,
    kind: ExecutionRefusalKind,
    ownerId: string,
    generation: number,
    executionId: string | undefined,
    now: number,
  ): void {
    this.db.run(
      `UPDATE ${GRAPH_STORE_TABLES.executions}
          SET refused_kind = ?, refused_owner_id = ?, refused_generation = ?, refused_execution_id = ?, refused_at = ?, refused_count = refused_count + 1
        WHERE graph_id = ? AND effect_id = ?`,
      kind,
      ownerId,
      generation >= 1 ? generation : null,
      executionId ?? null,
      now,
      effect.graphId,
      effect.effectId,
    );
  }

  /**
   * Drop this claim after a delivery that PROVED no execution was created.
   *
   * THE PROOF IS AN ARGUMENT, NOT A CONVENTION (P2 item 4). There is no
   * overload without it and this method refuses one at runtime, so a caller
   * cannot drop a create right on an unproven failure: an asynchronous rejection
   * or a timeout has to report itself with {@link recordUnprovenFailure}, which
   * keeps the claim.
   *
   * THE ROW IS KEPT, NOT DELETED. Its identity, its confirmed-execution history
   * and its refusal record stay readable, the claim becomes `pending` with
   * `released_at` set (every reader answers `absent`), and the generation moves
   * on. Keeping the row is what fences a LATE confirmation from the claim this
   * release ended: it presents the old generation, the store finds a newer one,
   * and the write is refused and recorded rather than binding a second
   * execution. A `created` row is never released — that execution exists.
   */
  releaseExecution(
    effect: StoreEffectKey,
    ownerId: string,
    generation: number,
    proof: ExecutionNotCreated,
    now: number,
  ): boolean {
    this.assertOpen("releaseExecution");
    if (proof === undefined || proof.kind !== "not-created") {
      throw new GraphStoreWriteError(
        "invalid-record",
        "graph-store: refusing to release the create right of effect " +
          JSON.stringify(effect.effectId) +
          " without a not-created proof — 'the create failed' and 'no execution exists' are " +
          "different facts, and only the second one licenses a later create",
      );
    }
    this.db.run(
      `UPDATE ${GRAPH_STORE_TABLES.executions}
          SET state = 'pending', released_at = ?, owner_generation = owner_generation + 1, execution_id = NULL, task_id = NULL, updated_at = ?
        WHERE graph_id = ? AND effect_id = ? AND owner_id = ? AND owner_generation = ? AND state IN ('pending', 'creating')`,
      now,
      now,
      effect.graphId,
      effect.effectId,
      ownerId,
      generation,
    );
    return this.changes() === 1;
  }

  /** One effect's binding row, or `undefined`. */
  readExecution(effect: StoreEffectKey): ExecutionBindingRecord | undefined {
    this.assertOpen("readExecution");
    const row = this.db
      .query(
        `SELECT graph_id, effect_id, attempt_id, state, owner_id, owner_generation, execution_id, task_id, claimed_at, updated_at,
                released_at, refused_kind, refused_owner_id, refused_generation, refused_execution_id, refused_at, refused_count
         FROM ${GRAPH_STORE_TABLES.executions} WHERE graph_id = ? AND effect_id = ?`,
      )
      .get(effect.graphId, effect.effectId);
    if (row === undefined || row === null) return undefined;
    const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.executions);
    const table = GRAPH_STORE_TABLES.executions;
    const state = entry["state"];
    if (state !== "pending" && state !== "creating" && state !== "created") {
      throw new GraphStoreFormatError(
        "malformed-row",
        this.filePath,
        `graph-store: the execution binding for effect ${JSON.stringify(effect.effectId)} carries state ${describeValue(state)}, which is not pending, creating or created — refusing to read it approximately`,
        state,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    const executionId = entry["execution_id"];
    const taskId = entry["task_id"];
    const execution =
      typeof executionId === "string" && executionId.length > 0
        ? Object.freeze({
            executionId,
            ...(typeof taskId === "string" && taskId.length > 0 ? { taskId } : {}),
          })
        : undefined;
    const generation = readStoreEpoch(entry, "owner_generation", this.filePath, table);
    if (generation < 1) {
      throw new GraphStoreFormatError(
        "malformed-row",
        this.filePath,
        `graph-store: the execution binding for effect ${JSON.stringify(effect.effectId)} carries claim generation ${String(generation)}, which is not a claim this store mints — refusing to read it approximately`,
        generation,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    const releasedAt = readOptionalStoreEpoch(entry, "released_at", this.filePath, table);
    if (releasedAt !== undefined && state !== "pending") {
      throw new GraphStoreFormatError(
        "malformed-row",
        this.filePath,
        `graph-store: the execution binding for effect ${JSON.stringify(effect.effectId)} is ${state} and carries a release instant — a released claim is pending, so refusing to read it approximately`,
        state,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    return Object.freeze({
      graphId: readStoreText(entry, "graph_id", this.filePath, table),
      effectId: readStoreText(entry, "effect_id", this.filePath, table),
      attemptId: readStoreText(entry, "attempt_id", this.filePath, table),
      state,
      ownerId: readStoreText(entry, "owner_id", this.filePath, table),
      generation,
      ...(execution === undefined ? {} : { execution }),
      ...(releasedAt === undefined ? {} : { releasedAt }),
      ...refusalOf(entry, effect, this.filePath, table),
      claimedAt: readStoreEpoch(entry, "claimed_at", this.filePath, table),
      updatedAt: readStoreEpoch(entry, "updated_at", this.filePath, table),
    });
  }

  // ── Credential records ────────────────────────────────────────────────────

  /**
   * Upsert one attempt's credential RECORD.
   *
   * The row is keyed by `(graphId, nodeId, attemptId)` — the runtime's own
   * attempt identity — and the store's CHECK makes `retained` without a value
   * unrepresentable. The DEFAULT deployment passes `"not-retained"` with a
   * NULL value: the binding is durable, the credential is not, which is what
   * lets a recovery say "this attempt's credential was not retained" instead of
   * inventing one.
   */
  rememberCredential(
    identity: CredentialRecordIdentity,
    retention: CredentialRetention,
    credential: string | null,
    now: number,
  ): void {
    this.assertOpen("rememberCredential");
    requireStoreIdentifier(identity.graphId, "credential.graphId");
    requireStoreIdentifier(identity.nodeId, "credential.nodeId");
    requireStoreIdentifier(identity.attemptId, "credential.attemptId");
    if (retention === "retained" && (typeof credential !== "string" || credential.length === 0)) {
      throw new GraphStoreWriteError(
        "invalid-record",
        `graph-store: refusing to record attempt ${JSON.stringify(identity.attemptId)} as retained without a credential value — the CHECK would reject the row, and a retained record that holds nothing reads as a deliverable attempt`,
      );
    }
    this.db.run(
      `INSERT INTO ${GRAPH_STORE_TABLES.credentials}
         (graph_id, node_id, attempt_id, retention, credential, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (graph_id, node_id, attempt_id) DO UPDATE SET
         retention = excluded.retention,
         credential = excluded.credential,
         updated_at = excluded.updated_at`,
      identity.graphId,
      identity.nodeId,
      identity.attemptId,
      retention,
      retention === "retained" ? credential : null,
      now,
    );
  }

  /**
   * What the durable store records for one attempt: `"retained"` (the value is
   * on disk), `"not-retained"` (the attempt is recorded, the value is not), or
   * `undefined` (no record at all). A DIAGNOSTIC: it never returns the value.
   */
  readCredentialRetention(
    identity: CredentialRecordIdentity,
  ): CredentialRetention | undefined {
    this.assertOpen("readCredentialRetention");
    const row = this.db
      .query(
        `SELECT retention FROM ${GRAPH_STORE_TABLES.credentials}
         WHERE graph_id = ? AND node_id = ? AND attempt_id = ?`,
      )
      .get(identity.graphId, identity.nodeId, identity.attemptId);
    if (row === undefined || row === null) return undefined;
    const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.credentials);
    const retention = entry["retention"];
    return retention === "retained" || retention === "not-retained"
      ? retention
      : undefined;
  }

  /** Drop one attempt's credential record. Idempotent. */
  forgetCredential(identity: CredentialRecordIdentity): void {
    this.assertOpen("forgetCredential");
    this.db.run(
      `DELETE FROM ${GRAPH_STORE_TABLES.credentials} WHERE graph_id = ? AND node_id = ? AND attempt_id = ?`,
      identity.graphId,
      identity.nodeId,
      identity.attemptId,
    );
  }

  /**
   * Read every RETAINED credential back.
   *
   * A row whose value is not a usable credential is refused as a whole rather
   * than dropped: an attempt silently missing from the vault is exactly the
   * state a recovery must not see.
   */
  retainedCredentials(): readonly RetainedCredential[] {
    this.assertOpen("retainedCredentials");
    const rows = this.db
      .query(
        `SELECT graph_id, node_id, attempt_id, credential FROM ${GRAPH_STORE_TABLES.credentials}
         WHERE retention = 'retained'`,
      )
      .all();
    const out: RetainedCredential[] = [];
    for (const row of rows) {
      const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.credentials);
      const credential = entry["credential"];
      if (typeof credential !== "string" || credential.length === 0) {
        throw new GraphStoreFormatError(
          "malformed-row",
          this.filePath,
          "graph-store: the credential table holds a retained row with no usable value — refusing the whole table rather than dropping one attempt's credential",
          credential,
          GRAPH_STORE_FORMAT_VERSION,
        );
      }
      out.push(
        Object.freeze({
          identity: Object.freeze({
            graphId: readStoreText(entry, "graph_id", this.filePath, GRAPH_STORE_TABLES.credentials),
            nodeId: readStoreText(entry, "node_id", this.filePath, GRAPH_STORE_TABLES.credentials),
            attemptId: readStoreText(
              entry,
              "attempt_id",
              this.filePath,
              GRAPH_STORE_TABLES.credentials,
            ),
          }),
          credential,
        }),
      );
    }
    return Object.freeze(out);
  }

  // ── Declaring invocation ──────────────────────────────────────────────────

  /**
   * Record one graph's declaring invocation; returns whether the record
   * CHANGED.
   *
   * One entry per graph id: recording the same attribution again changes
   * nothing, and a DIFFERENT attribution REPLACES it — a re-declaration from a
   * new session is the newer invocation, and a later dispatch must be
   * attributed to the session that is actually running the graph. The module
   * that owns the vocabulary validates the origin before calling; the store
   * enforces the shape the table declares.
   */
  recordInvocationOrigin(
    graphId: string,
    origin: InvocationOriginRecord,
    now: number,
  ): boolean {
    this.assertOpen("recordInvocationOrigin");
    assertOriginShape(graphId, origin, now);
    return this.joinOrBegin(() => {
      const current = this.readInvocationOrigin(graphId);
      if (current !== undefined && sameOrigin(current, origin)) return false;
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.origins} (graph_id, session_id, agent, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (graph_id) DO UPDATE SET
           session_id = excluded.session_id,
           agent = excluded.agent,
           updated_at = excluded.updated_at`,
        graphId,
        origin.sessionId,
        origin.agent ?? null,
        now,
      );
      return true;
    });
  }

  /** The invocation that declared this graph, or `undefined`. */
  readInvocationOrigin(graphId: string): InvocationOriginRecord | undefined {
    this.assertOpen("readInvocationOrigin");
    const row = this.db
      .query(
        `SELECT graph_id, session_id, agent FROM ${GRAPH_STORE_TABLES.origins} WHERE graph_id = ?`,
      )
      .get(graphId);
    if (row === undefined || row === null) return undefined;
    const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.origins);
    const sessionId = readStoreText(
      entry,
      "session_id",
      this.filePath,
      GRAPH_STORE_TABLES.origins,
    );
    const agent = entry["agent"];
    return Object.freeze(
      typeof agent === "string" && agent.length > 0
        ? { sessionId, agent }
        : { sessionId },
    );
  }

  /** Every graph id this table holds an origin for, sorted. */
  invocationOriginGraphIds(): readonly string[] {
    this.assertOpen("invocationOriginGraphIds");
    const rows = this.db
      .query(`SELECT graph_id FROM ${GRAPH_STORE_TABLES.origins}`)
      .all();
    const ids: string[] = [];
    for (const row of rows) {
      const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.origins);
      ids.push(readStoreText(entry, "graph_id", this.filePath, GRAPH_STORE_TABLES.origins));
    }
    return Object.freeze(ids.sort());
  }

  // ── Run identity and trusted control (P3 item 1) ───────────────────────────

  /**
   * The run identity and control surface, as the ledger port exposes it.
   *
   * The SAME object the transaction surface hands out, so a caller inside a
   * transaction and a caller holding the store write through one interface and
   * one boundary.
   */
  get runs(): RunControlLedger {
    this.assertOpen("runs");
    return this.runsView;
  }

  /**
   * The trusted-approval surface, as the ledger port exposes it (P3 item 3).
   *
   * The SAME object the transaction surface hands out, so the acceptance gate, a
   * control command and a reader all address one boundary — and the gate reads a
   * row a raising command wrote in the very transaction that is committing.
   */
  get approvals(): ApprovalLedger {
    this.assertOpen("approvals");
    return this.approvalsView;
  }

  /**
   * The dispatch BUDGET surface, as the ledger port exposes it (P3 item 3).
   *
   * The SAME object the transaction surface hands out, so the claim a dispatch
   * is authorized by, the reconciliation against real usage and the read a
   * report is built from all address one interface and one boundary. Exposed on
   * the STORE (not only inside a transaction) because the read side — a report,
   * a query — must stay available without opening a write boundary.
   */
  get budget(): BudgetLedger {
    this.assertOpen("budget");
    return this.budgetView;
  }

  /**
   * Record one run identity, or return the one already recorded.
   *
   * IDEMPOTENT BY CONSTRUCTION: `ON CONFLICT DO NOTHING` then a read, so two
   * processes that raced the same graph's first execution agree on ONE run id —
   * the first writer's — instead of each minting its own. The caller mints the
   * candidate id; the store decides which one is the run's.
   */
  mintRun(record: RunIdentityRecord): StoredRunIdentity {
    this.assertOpen("mintRun");
    assertRunShape(record);
    return this.joinOrBegin(() => {
      // FIRST-WINS ON THE FIRST RUN, and ONLY on the first: the insert lands
      // only while the graph has NO run at all, so two processes that raced this
      // graph's first execution agree on ONE run id instead of each minting its
      // own — while a mint issued after a re-execution is answered the CURRENT
      // run rather than appending a third identity. A successor run is minted
      // exclusively through `mintNextRun`, which is conditional on the run it
      // supersedes.
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.runs}
           (graph_id, run_id, run_seq, plan_revision, started_at)
         SELECT ?, ?, 1, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${GRAPH_STORE_TABLES.runs} WHERE graph_id = ?
         )`,
        record.graphId,
        record.runId,
        record.planRevision,
        record.startedAt,
        record.graphId,
      );
      const stored = this.readRun(record.graphId);
      if (stored === undefined) {
        throw new GraphStoreWriteError(
          "invalid-record",
          "graph-store: run identity of graph " +
            JSON.stringify(record.graphId) +
            " disappeared between the mint and the read — the run was not recorded",
        );
      }
      return stored;
    });
  }

  /**
   * Mint the SUCCESSOR of one run, conditional on that run still being current.
   *
   * ONE row per `(graph, run_seq)` makes two successors for one run
   * unrepresentable, and the `WHERE` makes the winner the process that observed
   * the run it supersedes: a racer whose `afterRunId` is no longer the graph's
   * current run writes NOTHING and is answered `undefined` — never a second
   * run, and never a silent adoption of the winner's. The sequence is read and
   * incremented INSIDE this transaction, whose first statement takes the write
   * lock, so the read cannot be stale.
   */
  mintNextRun(
    record: RunIdentityRecord,
    afterRunId: string,
  ): StoredRunIdentity | undefined {
    this.assertOpen("mintNextRun");
    assertRunShape(record);
    return this.joinOrBegin(() => {
      // THE WRITE LOCK FIRST, exactly as the control path does: this operation
      // reads the current run and then writes, and SQLite refuses a
      // shared-to-reserved PROMOTION immediately when another connection holds
      // the write lock. The statement changes no value.
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.runs}
         SET started_at = started_at
         WHERE graph_id = ?`,
        record.graphId,
      );
      const current = this.readRun(record.graphId);
      if (current === undefined || current.runId !== afterRunId) return undefined;
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.runs}
           (graph_id, run_id, run_seq, plan_revision, started_at)
         VALUES (?, ?, ?, ?, ?)`,
        record.graphId,
        record.runId,
        current.runSeq + 1,
        record.planRevision,
        record.startedAt,
      );
      return this.readRunOf(record.graphId, record.runId);
    });
  }

  /** The CURRENT run identity of one graph, or `undefined`. */
  readRun(graphId: string): StoredRunIdentity | undefined {
    this.assertOpen("readRun");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, run_seq, plan_revision, started_at
         FROM ${GRAPH_STORE_TABLES.runs}
         WHERE graph_id = ?
         ORDER BY run_seq DESC LIMIT 1`,
      )
      .get(graphId);
    if (row === undefined || row === null) return undefined;
    return this.runIdentityOfRow(row);
  }

  /** One SUPERSEDED run, by its own id, or `undefined`. */
  readRunOf(graphId: string, runId: string): StoredRunIdentity | undefined {
    this.assertOpen("readRunOf");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, run_seq, plan_revision, started_at
         FROM ${GRAPH_STORE_TABLES.runs}
         WHERE graph_id = ? AND run_id = ?`,
      )
      .get(graphId, runId);
    if (row === undefined || row === null) return undefined;
    return this.runIdentityOfRow(row);
  }

  /** Every run of one graph, oldest first. */
  runsOf(graphId: string): readonly StoredRunIdentity[] {
    this.assertOpen("runsOf");
    const rows = this.db
      .query(
        `SELECT graph_id, run_id, run_seq, plan_revision, started_at
         FROM ${GRAPH_STORE_TABLES.runs}
         WHERE graph_id = ?
         ORDER BY run_seq`,
      )
      .all(graphId);
    const runs: StoredRunIdentity[] = [];
    for (const row of rows) {
      runs.push(this.runIdentityOfRow(row));
    }
    return Object.freeze(runs);
  }

  /** Project one `graph_runs` row onto the run identity. */
  private runIdentityOfRow(row: unknown): StoredRunIdentity {
    const table = GRAPH_STORE_TABLES.runs;
    const entry = asStoreRow(row, this.filePath, table);
    return Object.freeze({
      graphId: readStoreText(entry, "graph_id", this.filePath, table),
      runId: readStoreText(entry, "run_id", this.filePath, table),
      runSeq: readStoreInteger(entry, "run_seq", this.filePath, table),
      planRevision: readStoreText(entry, "plan_revision", this.filePath, table),
      startedAt: readStoreEpoch(entry, "started_at", this.filePath, table),
    });
  }

  /** The run-level control fact of one graph's CURRENT run, or `undefined`. */
  readRunControl(graphId: string): RunControlRecord | undefined {
    this.assertOpen("readRunControl");
    const run = this.readRun(graphId);
    if (run === undefined) return undefined;
    return this.readRunControlOf(graphId, run.runId);
  }

  /**
   * The run-level control fact of ONE named run, or `undefined`.
   *
   * The read that keeps a superseded run's stop addressable (G3): a run's
   * control fact belongs to that run, never to the graph, so a later run is not
   * answered with the command that stopped the earlier one.
   */
  readRunControlOf(graphId: string, runId: string): RunControlRecord | undefined {
    this.assertOpen("readRunControlOf");
    const row = this.db
      .query(
        `SELECT run_id, control_command, control_reason, control_decided_at,
                control_decided_by_session, control_decided_by_agent
         FROM ${GRAPH_STORE_TABLES.runs}
         WHERE graph_id = ? AND run_id = ? AND control_command IS NOT NULL`,
      )
      .get(graphId, runId);
    if (row === undefined || row === null) return undefined;
    const table = GRAPH_STORE_TABLES.runs;
    const entry = asStoreRow(row, this.filePath, table);
    return Object.freeze({
      graphId,
      runId: readStoreText(entry, "run_id", this.filePath, table),
      command: readControlCommand(entry, "control_command", this.filePath, table),
      reason: readStoreText(entry, "control_reason", this.filePath, table),
      decidedAt: readStoreEpoch(entry, "control_decided_at", this.filePath, table),
      ...readDecidedBy(
        entry,
        "control_decided_by_session",
        "control_decided_by_agent",
        this.filePath,
        table,
      ),
    });
  }

  /**
   * The `retry` decision that superseded ONE attempt, or `undefined`.
   *
   * An attempt is retried at most once, so this is a single row and the
   * acceptance core asks it inside the transaction that would otherwise settle
   * the superseded attempt.
   */
  readSupersedingRetry(
    graphId: string,
    attemptId: string,
  ): ControlDecisionRecord | undefined {
    this.assertOpen("readSupersedingRetry");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
                decided_by_session, decided_by_agent, successor_attempt_id
         FROM ${GRAPH_STORE_TABLES.controlDecisions}
         WHERE graph_id = ? AND attempt_id = ? AND command = 'retry'
         ORDER BY decided_at DESC LIMIT 1`,
      )
      .get(graphId, attemptId);
    if (row === undefined || row === null) return undefined;
    return readControlDecisionRow(
      asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.controlDecisions),
      this.filePath,
    );
  }

  /** The control decision one attempt carries, or `undefined`. */
  readControlDecision(
    graphId: string,
    runId: string,
    nodeId: string,
    attemptId: string,
  ): ControlDecisionRecord | undefined {
    this.assertOpen("readControlDecision");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
                decided_by_session, decided_by_agent, successor_attempt_id
         FROM ${GRAPH_STORE_TABLES.controlDecisions}
         WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ?
         ORDER BY decided_at, rowid LIMIT 1`,
      )
      .get(graphId, runId, nodeId, attemptId);
    if (row === undefined || row === null) return undefined;
    return readControlDecisionRow(
      asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.controlDecisions),
      this.filePath,
    );
  }

  /**
   * The control decision ONE ATTEMPT carries FOR ONE COMMAND, or `undefined`.
   *
   * The retry's idempotency key is exactly this triple: a repeated retry of the
   * same attempt must REPLAY the decision that minted its successor instead of
   * minting another.
   */
  readControlCommandDecision(
    graphId: string,
    runId: string,
    nodeId: string,
    attemptId: string,
    command: ControlCommandName,
  ): ControlDecisionRecord | undefined {
    this.assertOpen("readControlCommandDecision");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
                decided_by_session, decided_by_agent, successor_attempt_id
         FROM ${GRAPH_STORE_TABLES.controlDecisions}
         WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ? AND command = ?`,
      )
      .get(graphId, runId, nodeId, attemptId, command);
    if (row === undefined || row === null) return undefined;
    return readControlDecisionRow(
      asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.controlDecisions),
      this.filePath,
    );
  }

  /**
   * The control decisions of ONE RUN, in decision order.
   *
   * RUN-SCOPED (G3): `runId` omitted means the graph's CURRENT run, and a graph
   * with no run row has exactly one implicit run and is answered in full.
   */
  controlDecisions(graphId: string, runId?: string): readonly ControlDecisionRecord[] {
    this.assertOpen("controlDecisions");
    const scope = runId ?? this.readRun(graphId)?.runId;
    const rows =
      scope === undefined
        ? this.db
            .query(
              `SELECT graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
                      decided_by_session, decided_by_agent, successor_attempt_id
               FROM ${GRAPH_STORE_TABLES.controlDecisions}
               WHERE graph_id = ? ORDER BY decided_at, rowid`,
            )
            .all(graphId)
        : this.db
            .query(
              `SELECT graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
                      decided_by_session, decided_by_agent, successor_attempt_id
               FROM ${GRAPH_STORE_TABLES.controlDecisions}
               WHERE graph_id = ? AND run_id = ? ORDER BY decided_at, rowid`,
            )
            .all(graphId, scope);
    const decisions: ControlDecisionRecord[] = [];
    for (const row of rows) {
      decisions.push(
        readControlDecisionRow(
          asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.controlDecisions),
          this.filePath,
        ),
      );
    }
    return Object.freeze(decisions);
  }

  /**
   * Record one control decision, and the run's control fact when it is
   * unclaimed — in ONE boundary (`joinOrBegin`), so the decision and the run
   * fact a reader combines them from commit together.
   *
   * THREE CONDITIONAL RULES, all structural:
   * - THE ATTEMPT: a row already exists under the decision's key. The SAME
   *   command is a REPLAY (the persisted decision is returned, nothing is
   *   written); a DIFFERENT command is a CONFLICT and nothing is written. An
   *   attempt therefore never carries two control facts.
   * - THE ACCEPTANCE: the INSERT carries its own `WHERE NOT EXISTS (accepted
   *   event for this attempt)`, so an attempt that settled through the
   *   acceptance core is reported `settled` and NOTHING is written — decided
   *   against the committed store at the moment of the write, not against a
   *   value read earlier in the transaction. That is what makes a control
   *   command race an acceptance deterministically, and the acceptance side
   *   carries the SYMMETRIC rule: `commitAccepted` refuses a batch whose run
   *   already has a control fact (verdict `controlled`, nothing written), and
   *   the run path refuses the same fact by name before it settles. Whichever
   *   COMMITS first is the fact that stands, the loser writes nothing, and one
   *   attempt can never carry both an accepted event and a control decision.
   * - THE RUN: the control fact is claimed by `WHERE control_command IS NULL`.
   *   A second command — an identical repeat after an unrelated decision, or a
   *   different command for another attempt — never replaces the first; the
   *   caller is handed the run fact that actually stands. The claim runs ONLY
   *   after the decision itself landed, so a refused command never stops a run.
   */
  writeControlDecision(write: RunControlWrite): RunControlWriteResult {
    this.assertOpen("writeControlDecision");
    assertControlWriteShape(write);
    return this.joinOrBegin(() => {
      const key = write.decision;
      // THE DECISIVE WRITE IS THE FIRST STATEMENT, and both halves of its rule
      // are inside it: the row lands only when no accepted event exists for this
      // attempt AT THIS MOMENT, and `OR IGNORE` keeps the attempt's primary key
      // as the other half. Being FIRST also matters for concurrency: a write
      // statement takes SQLite's RESERVED lock immediately, so a racing writer
      // WAITS on `busy_timeout` instead of failing a shared-to-reserved lock
      // PROMOTION after a read — the "database is locked" failure a
      // read-then-write shape produces cross-process (reproduced by
      // `tests/graph/graph-store-cross-process.test.ts`). A row that does not
      // land is CLASSIFIED from the committed store by the re-read below.
      this.db.run(
        `INSERT OR IGNORE INTO ${GRAPH_STORE_TABLES.controlDecisions}
           (graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
            decided_by_session, decided_by_agent, successor_attempt_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${GRAPH_STORE_TABLES.acceptedEvents}
           WHERE graph_id = ? AND attempt_id = ?
         )
         AND NOT (
           ? IN ('failure', 'cancel', 'timeout', 'budget-stop')
           AND EXISTS (
             SELECT 1 FROM ${GRAPH_STORE_TABLES.controlDecisions}
             WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ?
               AND command IN ('failure', 'cancel', 'timeout', 'budget-stop')
               AND command <> ?
           )
         )`,
        key.graphId,
        key.runId,
        key.nodeId,
        key.attemptId,
        key.command,
        key.reason,
        key.decidedAt,
        key.decidedBy?.sessionId ?? null,
        key.decidedBy?.agentId ?? null,
        key.successorAttemptId ?? null,
        key.graphId,
        key.attemptId,
        key.command,
        key.graphId,
        key.runId,
        key.nodeId,
        key.attemptId,
        key.command,
      );
      if (this.changes() === 0) {
        // NOTHING LANDED. Three facts of the COMMITTED store explain it, and
        // they are read back here rather than assumed: this attempt already
        // carries THIS command (a replay), it carries ANOTHER STOPPING command
        // (a conflict), or it SETTLED through the acceptance core.
        const raced = this.readControlCommandDecision(
          key.graphId,
          key.runId,
          key.nodeId,
          key.attemptId,
          key.command,
        );
        if (raced !== undefined) {
          return Object.freeze({
            kind: "replayed" as const,
            decision: raced,
            runControl: this.readRunControl(key.graphId),
          });
        }
        const competing = this.readStoppingControlDecision(
          key.graphId,
          key.runId,
          key.nodeId,
          key.attemptId,
          key.command,
        );
        return Object.freeze(
          competing === undefined
            ? {
                kind: "settled" as const,
                attemptId: key.attemptId,
                runControl: this.readRunControl(key.graphId),
              }
            : {
                kind: "conflict" as const,
                existing: competing,
                runControl: this.readRunControl(key.graphId),
              },
        );
      }
      const claimed = write.runControl;
      if (claimed !== undefined) {
        this.db.run(
          `UPDATE ${GRAPH_STORE_TABLES.runs}
           SET control_command = ?, control_reason = ?, control_decided_at = ?,
               control_decided_by_session = ?, control_decided_by_agent = ?
           WHERE graph_id = ? AND run_id = ? AND control_command IS NULL`,
          claimed.command,
          claimed.reason,
          claimed.decidedAt,
          claimed.decidedBy?.sessionId ?? null,
          claimed.decidedBy?.agentId ?? null,
          claimed.graphId,
          claimed.runId,
        );
        // THE STORED FACT IS THE ANSWER, not the value this call proposed: a
        // racing command may have claimed the run between the read and the
        // update, and reporting this call's candidate would name a command that
        // is not the one that stands. A run row that is not there at all is an
        // inconsistency, not a fact to invent.
        const stored = this.readRunControl(key.graphId);
        if (stored === undefined) {
          throw new GraphStoreWriteError(
            "invalid-record",
            "graph-store: control decision for graph " +
              JSON.stringify(key.graphId) +
              " was recorded, but the store holds no run control fact for it — the run " +
              "identity is missing and the decision was rolled back",
          );
        }
        return Object.freeze({
          kind: "recorded" as const,
          decision: key,
          runControl: stored,
        });
      }
      // A DECISION THAT DOES NOT CLAIM THE RUN (a retry): the run keeps the fact
      // it has — which may be the failure the retry succeeds — and the answer
      // reports whatever stands rather than a candidate.
      return Object.freeze({
        kind: "recorded" as const,
        decision: key,
        runControl: this.readRunControl(key.graphId),
      });
    });
  }

  /**
   * One attempt's STOPPING control decision for a command OTHER than `except`.
   *
   * The `conflict` half of "one attempt, one stopping fact": a failure, a
   * cancellation, a timeout and a budget stop are competing terminal decisions
   * about one attempt, while a `retry` is a SUCCESSOR command recorded beside
   * them and never a competitor.
   */
  private readStoppingControlDecision(
    graphId: string,
    runId: string,
    nodeId: string,
    attemptId: string,
    except: ControlCommandName,
  ): ControlDecisionRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, run_id, node_id, attempt_id, command, reason, decided_at,
                decided_by_session, decided_by_agent, successor_attempt_id
         FROM ${GRAPH_STORE_TABLES.controlDecisions}
         WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ?
           AND command IN ('failure', 'cancel', 'timeout', 'budget-stop')
           AND command <> ?
         ORDER BY decided_at, rowid LIMIT 1`,
      )
      .get(graphId, runId, nodeId, attemptId, except);
    if (row === undefined || row === null) return undefined;
    return readControlDecisionRow(
      asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.controlDecisions),
      this.filePath,
    );
  }

  /**
   * Take the store's WRITE LOCK for one graph's control path, and record
   * nothing.
   *
   * A control command reads before it writes, and SQLite refuses a
   * shared-to-reserved lock PROMOTION immediately when another connection holds
   * the write lock (it does not wait on `busy_timeout`) — the
   * `database is locked` failure two racing commands produced cross-process
   * before this method existed. The UPDATE below is the transaction's FIRST
   * write, so RESERVED is taken before any read; it writes the value that is
   * already there, so a transaction that rolls back leaves no trace, and a
   * missing run row (the graph has no run yet) still takes the lock: the
   * statement is a write whether or not it matches a row.
   */
  lockControlWrite(graphId: string): void {
    this.assertOpen("lockControlWrite");
    requireStoreIdentifier(graphId, "control.graphId");
    this.joinOrBegin(() => {
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.runs}
         SET started_at = started_at
         WHERE graph_id = ?`,
        graphId,
      );
    });
  }

  /**
   * Claim one run's control fact when the run is unclaimed, and answer with the
   * fact that stands.
   *
   * The conditional UPDATE is the whole rule: a second command never replaces
   * the first, and a caller always learns which command actually stopped the
   * run. `undefined` means the run row is not there at all — a caller mints a
   * run identity before it controls one, so that is an inconsistency to report,
   * not a claim to record.
   */
  claimRunControl(control: RunControlRecord): RunControlRecord | undefined {
    this.assertOpen("claimRunControl");
    assertRunControlShape(control);
    return this.joinOrBegin(() => {
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.runs}
         SET control_command = ?, control_reason = ?, control_decided_at = ?,
             control_decided_by_session = ?, control_decided_by_agent = ?
         WHERE graph_id = ? AND run_id = ? AND control_command IS NULL`,
        control.command,
        control.reason,
        control.decidedAt,
        control.decidedBy?.sessionId ?? null,
        control.decidedBy?.agentId ?? null,
        control.graphId,
        control.runId,
      );
      return this.readRunControlOf(control.graphId, control.runId);
    });
  }

  // ── Terminal-run re-execution (P3 item 2) ──────────────────────────────────

  /**
   * One run's trusted re-execution decision, or `undefined`.
   *
   * The read that makes an ORDER durable independently of the run it produced:
   * a process that dies between the decision and the mint leaves this row, and
   * the next window (the tool call's own follow-up, the boot sweep) HONOURS it
   * instead of a command nothing would finish.
   */
  readReexecution(graphId: string, runId: string): RunReexecutionRecord | undefined {
    this.assertOpen("readReexecution");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, reason, decided_at, decided_by_session,
                decided_by_agent, successor_run_id, successor_started_at
         FROM ${GRAPH_STORE_TABLES.runReexecutions}
         WHERE graph_id = ? AND run_id = ?`,
      )
      .get(graphId, runId);
    if (row === undefined || row === null) return undefined;
    return readReexecutionRow(
      asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.runReexecutions),
      this.filePath,
    );
  }

  /**
   * Record one trusted order to re-execute a run, or replay the one recorded.
   *
   * IDEMPOTENT ON `(graph, run)`: the primary key makes two orders for one run
   * unrepresentable, so a repeated order REPLAYS the persisted decision —
   * including the successor it already minted — and writes nothing. That is what
   * makes a repeated run-scoped retry safe: it cannot become a second new run.
   */
  recordReexecution(record: RunReexecutionRecord): RunReexecutionWriteResult {
    this.assertOpen("recordReexecution");
    assertReexecutionShape(record);
    return this.joinOrBegin(() => {
      const existing = this.readReexecution(record.graphId, record.runId);
      if (existing !== undefined) {
        return Object.freeze({ kind: "replayed" as const, reexecution: existing });
      }
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.runReexecutions}
           (graph_id, run_id, reason, decided_at, decided_by_session, decided_by_agent,
            successor_run_id, successor_started_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
        record.graphId,
        record.runId,
        record.reason,
        record.decidedAt,
        record.decidedBy?.sessionId ?? null,
        record.decidedBy?.agentId ?? null,
      );
      const stored = this.readReexecution(record.graphId, record.runId);
      if (stored === undefined) {
        throw new GraphStoreWriteError(
          "invalid-record",
          "graph-store: the re-execution decision of run " +
            JSON.stringify(record.runId) +
            " disappeared between the write and the read — nothing was recorded",
        );
      }
      return Object.freeze({ kind: "recorded" as const, reexecution: stored });
    });
  }

  /**
   * Link the successor run to the order that authorized it, ONCE.
   *
   * Conditional on the order still being OWED (`successor_run_id IS NULL`), so a
   * racing second executor's link lands nothing and it must roll back the run it
   * tried to mint. Called INSIDE the transaction that mints the successor, so an
   * order is never marked executed without the run it names.
   */
  markReexecutionExecuted(
    graphId: string,
    runId: string,
    successorRunId: string,
    successorStartedAt: number,
  ): boolean {
    this.assertOpen("markReexecutionExecuted");
    requireStoreIdentifier(successorRunId, "reexecution.successorRunId");
    requireStoreEpoch(successorStartedAt, "reexecution.successorStartedAt");
    return this.joinOrBegin(() => {
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.runReexecutions}
         SET successor_run_id = ?, successor_started_at = ?
         WHERE graph_id = ? AND run_id = ? AND successor_run_id IS NULL`,
        successorRunId,
        successorStartedAt,
        graphId,
        runId,
      );
      return this.changes() === 1;
    });
  }

  // ── Trusted approval (P3 item 3) ───────────────────────────────────────────

  /**
   * ONE ATTEMPT'S approval request, or `undefined`. Inside a transaction it
   * reads that transaction's own uncommitted row, which is what makes a
   * decision and the gate that reads it one boundary.
   */
  readApprovalRequest(graphId: string, attemptId: string): ApprovalRequestRecord | undefined {
    this.assertOpen("readApprovalRequest");
    const row = this.db
      .query(
        `SELECT graph_id, run_id, node_id, attempt_id, status, reason, requested_at,
                requested_by_session, requested_by_agent, approver_session_id, expires_at,
                decided_by_session, decided_by_agent, decided_at, decision_reason
         FROM ${GRAPH_STORE_TABLES.approvalRequests}
         WHERE graph_id = ? AND attempt_id = ?
         ORDER BY requested_at, rowid LIMIT 1`,
      )
      .get(graphId, attemptId);
    if (row === undefined || row === null) return undefined;
    return readApprovalRow(
      asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.approvalRequests),
      this.filePath,
    );
  }

  /**
   * Every request of ONE RUN — the graph's CURRENT run when `runId` is omitted,
   * exactly like {@link controlDecisions} — in raise order.
   */
  approvalRequestsOf(graphId: string, runId?: string): readonly ApprovalRequestRecord[] {
    this.assertOpen("approvalRequestsOf");
    const scope = runId ?? this.readRun(graphId)?.runId;
    const rows =
      scope === undefined
        ? this.db
            .query(
              `SELECT graph_id, run_id, node_id, attempt_id, status, reason, requested_at,
                      requested_by_session, requested_by_agent, approver_session_id, expires_at,
                      decided_by_session, decided_by_agent, decided_at, decision_reason
               FROM ${GRAPH_STORE_TABLES.approvalRequests}
               WHERE graph_id = ? ORDER BY requested_at, rowid`,
            )
            .all(graphId)
        : this.db
            .query(
              `SELECT graph_id, run_id, node_id, attempt_id, status, reason, requested_at,
                      requested_by_session, requested_by_agent, approver_session_id, expires_at,
                      decided_by_session, decided_by_agent, decided_at, decision_reason
               FROM ${GRAPH_STORE_TABLES.approvalRequests}
               WHERE graph_id = ? AND run_id = ? ORDER BY requested_at, rowid`,
            )
            .all(graphId, scope);
    const requests: ApprovalRequestRecord[] = [];
    for (const row of rows) {
      requests.push(
        readApprovalRow(
          asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.approvalRequests),
          this.filePath,
        ),
      );
    }
    return Object.freeze(requests);
  }

  /**
   * The request that BLOCKS one attempt's acceptance, or `undefined`.
   *
   * The gate is a PURE FUNCTION OF THE PERSISTED STATUS: `approved` opens it,
   * and `pending` / `rejected` / `expired` hold it. Time is deliberately NOT
   * part of this read — a deadline that has passed does not open a gate by
   * itself; only a recorded decision can, and the sweep (or a decision attempt)
   * is what records the expiry. An attempt with no request is not gated, which
   * is the shipped behavior for every graph that raises none.
   */
  blockingApproval(graphId: string, attemptId: string): ApprovalRequestRecord | undefined {
    const request = this.readApprovalRequest(graphId, attemptId);
    if (request === undefined || request.status === "approved") return undefined;
    return request;
  }

  /**
   * Raise one PENDING approval request — the durable pause.
   *
   * TWO CONDITIONAL RULES IN THE ONE INSERT, both decided against the COMMITTED
   * store rather than a value read earlier: the row lands only when the attempt
   * has NO ACCEPTED EVENT (a settled attempt cannot be paused, and a request and
   * an acceptance can therefore never both land for one attempt, whichever
   * commits first) and only when no request exists under the attempt's key (a
   * repeated raise REPLAYS the persisted request instead of writing a second
   * one). Being the first statement also takes SQLite's RESERVED lock
   * immediately, so a racing acceptance WAITS rather than failing a lock
   * promotion. A row that does not land is CLASSIFIED from the committed store
   * by the re-read below, never assumed.
   */
  raiseApprovalRequest(record: ApprovalRequestRecord): ApprovalRaiseResult {
    this.assertOpen("raiseApprovalRequest");
    assertApprovalRequestShape(record);
    return this.joinOrBegin(() => {
      this.db.run(
        `INSERT OR IGNORE INTO ${GRAPH_STORE_TABLES.approvalRequests}
           (graph_id, run_id, node_id, attempt_id, status, reason, requested_at,
            requested_by_session, requested_by_agent, approver_session_id, expires_at)
         SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${GRAPH_STORE_TABLES.acceptedEvents}
           WHERE graph_id = ? AND attempt_id = ?
         )`,
        record.graphId,
        record.runId,
        record.nodeId,
        record.attemptId,
        record.reason,
        record.requestedAt,
        record.requestedBy?.sessionId ?? null,
        record.requestedBy?.agentId ?? null,
        record.approverSessionId,
        record.expiresAt,
        record.graphId,
        record.attemptId,
      );
      const stored = this.readApprovalRequest(record.graphId, record.attemptId);
      if (stored === undefined) {
        // NOTHING LANDED AND NO ROW EXISTS: the guard found an accepted event,
        // so the attempt had already settled when this statement ran.
        return Object.freeze({ kind: "settled" as const, attemptId: record.attemptId });
      }
      if (this.changes() === 0) {
        return Object.freeze({ kind: "replayed" as const, request: stored });
      }
      return Object.freeze({ kind: "raised" as const, request: stored });
    });
  }

  /**
   * Apply one trusted decision to a PENDING request — one conditional UPDATE.
   *
   * THE CONDITION IS THE RULE: `WHERE status = 'pending'` makes the FIRST
   * decision the only one (a decided request is never re-decided), and the
   * verdict is classified from the row as it stands afterwards: the same
   * decision replayed, a different terminal status (`conflict`), or a deadline
   * that had already passed when the decision arrived (`expired`, materialized
   * by THIS statement so the expiry is durable even though the approval was
   * refused). An `expired` row is terminal like the other two.
   */
  decideApprovalRequest(write: ApprovalDecisionWrite): ApprovalDecideResult {
    this.assertOpen("decideApprovalRequest");
    assertApprovalDecisionShape(write);
    return this.joinOrBegin(() => {
      const status: ApprovalRequestStatus = write.command === "approve" ? "approved" : "rejected";
      // THE WRITE LOCK FIRST: this operation reads (does the request exist? is
      // its deadline past?) and then writes, and a read-then-write promotion is
      // what SQLite refuses immediately under another connection's write lock.
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.approvalRequests}
         SET status = status
         WHERE graph_id = ? AND attempt_id = ?`,
        write.graphId,
        write.attemptId,
      );
      const existing = this.readApprovalRequest(write.graphId, write.attemptId);
      if (existing === undefined) return Object.freeze({ kind: "absent" as const });
      if (existing.status === status) {
        return Object.freeze({ kind: "replayed" as const, request: existing });
      }
      if (existing.status !== "pending") {
        return Object.freeze({ kind: "conflict" as const, request: existing });
      }
      if (existing.expiresAt <= write.decidedAt) {
        // THE DEADLINE PASSED BEFORE THE DECISION ARRIVED. The expiry is
        // materialized HERE and now, by the same conditional update the sweep
        // uses, so an expired request is never approved afterwards and the
        // outcome is durable even if nothing else ever sweeps.
        this.db.run(
          `UPDATE ${GRAPH_STORE_TABLES.approvalRequests}
           SET status = 'expired', decided_at = ?, decision_reason = ?
           WHERE graph_id = ? AND attempt_id = ? AND status = 'pending'`,
          write.decidedAt,
          APPROVAL_DEADLINE_REASON,
          write.graphId,
          write.attemptId,
        );
        const expired = this.readApprovalRequest(write.graphId, write.attemptId);
        if (expired === undefined) {
          throw new GraphStoreWriteError(
            "invalid-record",
            "graph-store: the approval request of attempt " +
              JSON.stringify(write.attemptId) +
              " disappeared between the expiry and the read — nothing was recorded",
          );
        }
        return Object.freeze({ kind: "expired" as const, request: expired });
      }
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.approvalRequests}
         SET status = ?, decided_by_session = ?, decided_by_agent = ?, decided_at = ?,
             decision_reason = ?
         WHERE graph_id = ? AND attempt_id = ? AND status = 'pending'`,
        status,
        write.decidedBy.sessionId,
        write.decidedBy.agentId ?? null,
        write.decidedAt,
        write.reason,
        write.graphId,
        write.attemptId,
      );
      const decided = this.readApprovalRequest(write.graphId, write.attemptId);
      if (decided === undefined || decided.status !== status) {
        throw new GraphStoreWriteError(
          "invalid-record",
          "graph-store: approval decision " +
            JSON.stringify(write.command) +
            " for attempt " +
            JSON.stringify(write.attemptId) +
            " did not land although the request was pending — nothing was recorded",
        );
      }
      return Object.freeze({ kind: "decided" as const, request: decided });
    });
  }

  /**
   * Take the APPROVAL table's write lock for one graph, and record nothing.
   *
   * THE FIRST STATEMENT OF EVERY SWEEP. Both sweeps read the due rows and then
   * update them, and a transaction that reads before it writes must PROMOTE its
   * shared lock to reserved — which SQLite refuses IMMEDIATELY while another
   * connection holds the write lock ("database is locked", with no
   * `busy_timeout` wait), so two hosts booting one workspace while a request
   * was due could reject the boot with a raw driver error instead of recording
   * the expiry. The UPDATE below is a write whether or not it matches a row: it
   * sets the value that is already there, so a transaction that rolls back
   * leaves no trace, and RESERVED is taken before the first read.
   */
  private lockApprovalWrite(graphId: string): void {
    this.db.run(
      `UPDATE ${GRAPH_STORE_TABLES.approvalRequests}
       SET status = status
       WHERE graph_id = ?`,
      graphId,
    );
  }

  /**
   * Materialize the expiry of every pending request of one GRAPH whose deadline
   * has passed at `at`, and answer the rows this call expired.
   *
   * IDEMPOTENT AND TERMINAL: a request is expired at most once (the conditional
   * UPDATE only touches `pending` rows), and a request whose deadline has not
   * passed is untouched. The `at` is the caller's explicit input, so expiry is
   * reproducible from the call alone and a test drives it by moving `at`, never
   * by waiting on a clock.
   */
  expireDueApprovals(graphId: string, at: number, reason: string): readonly ApprovalRequestRecord[] {
    this.assertOpen("expireDueApprovals");
    requireStoreEpoch(at, "approval.at");
    requireStoreIdentifier(reason, "approval.reason");
    return this.joinOrBegin(() => {
      this.lockApprovalWrite(graphId);
      const due = this.approvalRows(graphId, "pending", at);
      if (due.length === 0) return Object.freeze([]);
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.approvalRequests}
         SET status = 'expired', decided_at = ?, decision_reason = ?
         WHERE graph_id = ? AND status = 'pending' AND expires_at <= ?`,
        at,
        reason,
        graphId,
        at,
      );
      const expired: ApprovalRequestRecord[] = [];
      for (const request of due) {
        const row = this.readApprovalRequest(graphId, request.attemptId);
        if (row !== undefined) expired.push(row);
      }
      return Object.freeze(expired);
    });
  }

  /**
   * Expire every still-PENDING request of ONE RUN, whatever its deadline.
   *
   * The run-stopping commands call this INSIDE their own transaction: a stopped
   * run's pause can never be answered into a settlement (the run is controlled),
   * so leaving the row `pending` would let a later approval read as a live
   * decision about work that can no longer proceed. The expiry writes ONLY the
   * status, the decision time and the reason: the stopping principal is NOT
   * recorded on this row (`decided_by_session` is written by
   * `decideApprovalRequest` alone), and WHO stopped the run is recoverable from
   * the control-decision stream, not from the request row.
   */
  expireRunApprovals(
    graphId: string,
    runId: string,
    at: number,
    reason: string,
  ): readonly ApprovalRequestRecord[] {
    this.assertOpen("expireRunApprovals");
    requireStoreIdentifier(runId, "approval.runId");
    requireStoreEpoch(at, "approval.at");
    requireStoreIdentifier(reason, "approval.reason");
    return this.joinOrBegin(() => {
      this.lockApprovalWrite(graphId);
      const due = this.approvalRows(graphId, "pending", undefined, runId);
      if (due.length === 0) return Object.freeze([]);
      this.db.run(
        `UPDATE ${GRAPH_STORE_TABLES.approvalRequests}
         SET status = 'expired', decided_at = ?, decision_reason = ?
         WHERE graph_id = ? AND run_id = ? AND status = 'pending'`,
        at,
        reason,
        graphId,
        runId,
      );
      const expired: ApprovalRequestRecord[] = [];
      for (const request of due) {
        const row = this.readApprovalRequest(graphId, request.attemptId);
        if (row !== undefined) expired.push(row);
      }
      return Object.freeze(expired);
    });
  }

  /** Pending (and optionally already-due) request rows of one graph. */
  private approvalRows(
    graphId: string,
    status: ApprovalRequestStatus,
    dueAt?: number,
    runId?: string,
  ): readonly ApprovalRequestRecord[] {
    const rows =
      dueAt === undefined
        ? this.db
            .query(
              `SELECT attempt_id FROM ${GRAPH_STORE_TABLES.approvalRequests}
               WHERE graph_id = ? AND status = ?${runId === undefined ? "" : " AND run_id = ?"}
               ORDER BY requested_at, rowid`,
            )
            .all(...(runId === undefined ? [graphId, status] : [graphId, status, runId]))
        : this.db
            .query(
              `SELECT attempt_id FROM ${GRAPH_STORE_TABLES.approvalRequests}
               WHERE graph_id = ? AND status = ? AND expires_at <= ?${runId === undefined ? "" : " AND run_id = ?"}
               ORDER BY requested_at, rowid`,
            )
            .all(
              ...(runId === undefined
                ? [graphId, status, dueAt]
                : [graphId, status, dueAt, runId]),
            );
    const requests: ApprovalRequestRecord[] = [];
    for (const row of rows) {
      const entry = asStoreRow(row, this.filePath, GRAPH_STORE_TABLES.approvalRequests);
      const attemptId = readStoreText(entry, "attempt_id", this.filePath, GRAPH_STORE_TABLES.approvalRequests);
      const request = this.readApprovalRequest(graphId, attemptId);
      if (request !== undefined) requests.push(request);
    }
    return Object.freeze(requests);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Refuse any use of a closed store with a clear, typed error. */
  private assertOpen(operation: string): void {
    if (this.closed) throw new GraphStoreClosedError(operation);
  }

  /**
   * Release this store's borrow of the connection. Idempotent.
   *
   * The connection closes when the LAST store over it closes, so a caller may
   * hold one store per graph and one per host capability over one file without
   * any of them pulling the connection out from under another.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    GraphStore.releaseConnection(this.connection, this.connectionKey);
  }
}

// ── Row readers ─────────────────────────────────────────────────────────────

/** Read one row-shaped answer, or refuse what the driver returned instead. */
function asStoreRow(value: unknown, path: string, table: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} is not a row — refusing to read it approximately`,
      value,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  return value as Record<string, unknown>;
}

/** Read one TEXT column as a non-empty string. */
function readStoreText(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} carries ${column} as ${describeValue(value)}, not a non-empty string — refusing to read it approximately`,
      value,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  return value;
}

/** Read one INTEGER column as epoch milliseconds. */
function readStoreEpoch(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} carries ${column} as ${describeValue(value)}, not epoch milliseconds — refusing to read it approximately`,
      value,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  return value;
}

/** Read one INTEGER column that is not a timestamp, or refuse it by name. */
function readStoreInteger(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} carries ${column} as ${describeValue(value)}, not a safe integer — refusing to read it approximately`,
      value,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  return value;
}

/** Read one JSON body column and parse its TEXT value. */
function readStoreJson(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): unknown {
  const text = readStoreText(row, column, path, table);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} carries ${column} that is not readable JSON (${errorText(error)}) — refusing to read it approximately`,
      text,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
}

// ── Shape checks ────────────────────────────────────────────────────────────

/** Read one control-command column as the closed vocabulary this format writes. */
function readControlCommand(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): ControlCommandName {
  const value = row[column];
  if (
    value === "failure" ||
    value === "cancel" ||
    value === "timeout" ||
    value === "retry" ||
    value === "budget-stop" ||
    value === "approval-request" ||
    value === "approve" ||
    value === "reject"
  ) {
    return value;
  }
  throw new GraphStoreFormatError(
    "malformed-row",
    path,
    `graph-store: a ${table} row of ${path} carries a control command of ${describeValue(value)}, which is not one this format records — refusing to read it approximately`,
    value,
    GRAPH_STORE_FORMAT_VERSION,
  );
}

/**
 * Read the principal columns of a control row.
 *
 * The session is the identity the permission rule compared; the agent is
 * recorded only when the host attributed one, and an agent without a session is
 * unrepresentable (the DDL says so) and therefore refused here as malformed.
 */
function readDecidedBy(
  row: Record<string, unknown>,
  sessionColumn: string,
  agentColumn: string,
  path: string,
  table: string,
): { readonly decidedBy?: ControlPrincipalRecord } {
  const session = row[sessionColumn];
  const agent = row[agentColumn];
  if (session === null || session === undefined) {
    if (agent !== null && agent !== undefined) {
      throw new GraphStoreFormatError(
        "malformed-row",
        path,
        `graph-store: a ${table} row of ${path} records an agent with no deciding session — refusing to read it approximately`,
        agent,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    return {};
  }
  if (typeof session !== "string" || session.length === 0) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} carries ${sessionColumn} as ${describeValue(session)}, not a non-empty session — refusing to read it approximately`,
      session,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if (typeof agent === "string" && agent.length > 0) {
    return { decidedBy: Object.freeze({ sessionId: session, agentId: agent }) };
  }
  return { decidedBy: Object.freeze({ sessionId: session }) };
}

/** Read one control-decision row. */
function readControlDecisionRow(
  row: Record<string, unknown>,
  path: string,
): ControlDecisionRecord {
  const table = GRAPH_STORE_TABLES.controlDecisions;
  const command = readControlCommand(row, "command", path, table);
  // The successor link is present EXACTLY for a retry (the DDL's CHECK says so),
  // so a row that disagrees with its own command is refused rather than read
  // approximately: a retry whose successor was lost could never answer which
  // attempt it minted, and another command carrying one would name an attempt it
  // never created.
  const successor = row["successor_attempt_id"];
  const successorAttemptId =
    typeof successor === "string" && successor.length > 0 ? successor : undefined;
  if (command === "retry" && successorAttemptId === undefined) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} records a retry with no successor attempt — refusing to read it approximately`,
      successor,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if (command !== "retry" && successor !== null && successor !== undefined) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} records command ${command} with a successor attempt — refusing to read it approximately`,
      successor,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  return Object.freeze({
    graphId: readStoreText(row, "graph_id", path, table),
    runId: readStoreText(row, "run_id", path, table),
    nodeId: readStoreText(row, "node_id", path, table),
    attemptId: readStoreText(row, "attempt_id", path, table),
    command,
    reason: readStoreText(row, "reason", path, table),
    decidedAt: readStoreEpoch(row, "decided_at", path, table),
    ...(successorAttemptId === undefined ? {} : { successorAttemptId }),
    ...readDecidedBy(row, "decided_by_session", "decided_by_agent", path, table),
  });
}

/**
 * Read one `graph_approval_requests` row.
 *
 * STRICT, like every other row reader here: the status must be one this format
 * writes, a non-`pending` row MUST carry the decision time and reason and a
 * `pending` row MUST carry neither (the DDL's CHECKs say so; a hand-edited or
 * foreign row that disagrees is refused rather than read approximately), and an
 * `approved` or `rejected` row MUST name the approver that decided it — an
 * approval with no principal would be a decision nobody took.
 */
function readApprovalRow(
  row: Record<string, unknown>,
  path: string,
): ApprovalRequestRecord {
  const table = GRAPH_STORE_TABLES.approvalRequests;
  const status = readApprovalStatus(row, path, table);
  const decidedAt = readOptionalStoreEpoch(row, "decided_at", path, table);
  const decisionReason = readOptionalStoreText(row, "decision_reason", path, table);
  const decidedBy = readDecidedBy(row, "decided_by_session", "decided_by_agent", path, table);
  if (status === "pending") {
    if (decidedAt !== undefined || decisionReason !== undefined || decidedBy.decidedBy !== undefined) {
      throw new GraphStoreFormatError(
        "malformed-row",
        path,
        `graph-store: a ${table} row of ${path} is pending yet carries a decision — refusing to read it approximately`,
        status,
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
  } else if (decidedAt === undefined || decisionReason === undefined) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} is ${status} with no decision time or reason — refusing to read it approximately`,
      status,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if ((status === "approved" || status === "rejected") && decidedBy.decidedBy === undefined) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} is ${status} with no deciding approver — refusing to read it approximately`,
      status,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  const requestedBy = readDecidedBy(
    row,
    "requested_by_session",
    "requested_by_agent",
    path,
    table,
  );
  return Object.freeze({
    graphId: readStoreText(row, "graph_id", path, table),
    runId: readStoreText(row, "run_id", path, table),
    nodeId: readStoreText(row, "node_id", path, table),
    attemptId: readStoreText(row, "attempt_id", path, table),
    status,
    reason: readStoreText(row, "reason", path, table),
    requestedAt: readStoreEpoch(row, "requested_at", path, table),
    approverSessionId: readStoreText(row, "approver_session_id", path, table),
    expiresAt: readStoreEpoch(row, "expires_at", path, table),
    ...(requestedBy.decidedBy === undefined ? {} : { requestedBy: requestedBy.decidedBy }),
    ...(decidedBy.decidedBy === undefined ? {} : { decidedBy: decidedBy.decidedBy }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(decisionReason === undefined ? {} : { decisionReason }),
  });
}

/** Read one approval status, or refuse a value this format does not write. */
function readApprovalStatus(
  row: Record<string, unknown>,
  path: string,
  table: string,
): ApprovalRequestStatus {
  const value = row["status"];
  if (value === "pending" || value === "approved" || value === "rejected" || value === "expired") {
    return value;
  }
  throw new GraphStoreFormatError(
    "malformed-row",
    path,
    `graph-store: a ${table} row of ${path} carries an approval status of ${describeValue(value)}, which is not one this format records — refusing to read it approximately`,
    value,
    GRAPH_STORE_FORMAT_VERSION,
  );
}

/**
 * The reason text one deadline expiry records.
 *
 * ONE constant for both drivers — the deadline sweep and a decision that arrives
 * after the deadline — so the row reads the same whichever path materialized it.
 * The deadline itself is the row's own `expires_at`, so the text does not repeat
 * it and cannot go stale against it.
 */
export const APPROVAL_DEADLINE_REASON =
  "the approval deadline passed before a decision was recorded";

/** Refuse an approval request that violates the record model before it is stored. */
function assertApprovalRequestShape(record: ApprovalRequestRecord): void {
  requireStoreIdentifier(record.graphId, "approval.graphId");
  requireStoreIdentifier(record.runId, "approval.runId");
  requireStoreIdentifier(record.nodeId, "approval.nodeId");
  requireStoreIdentifier(record.attemptId, "approval.attemptId");
  requireStoreIdentifier(record.reason, "approval.reason");
  requireStoreIdentifier(record.approverSessionId, "approval.approverSessionId");
  requireStoreEpoch(record.requestedAt, "approval.requestedAt");
  requireStoreEpoch(record.expiresAt, "approval.expiresAt");
  if (record.status !== "pending") {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: an approval request is RAISED as pending; " +
        JSON.stringify(record.status) +
        " is a decision and is written by the decision path, never by the raise",
    );
  }
  assertPrincipalShape(record.requestedBy, "approval.requestedBy");
}

/** Refuse an approval decision that violates the record model before it is stored. */
function assertApprovalDecisionShape(write: ApprovalDecisionWrite): void {
  requireStoreIdentifier(write.graphId, "approval.graphId");
  requireStoreIdentifier(write.runId, "approval.runId");
  requireStoreIdentifier(write.nodeId, "approval.nodeId");
  requireStoreIdentifier(write.attemptId, "approval.attemptId");
  requireStoreIdentifier(write.reason, "approval.reason");
  requireStoreEpoch(write.decidedAt, "approval.decidedAt");
  if (write.command !== "approve" && write.command !== "reject") {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: " +
        JSON.stringify(write.command) +
        " is not an approval decision command — only approve and reject resolve a request",
    );
  }
  assertPrincipalShape(write.decidedBy, "approval.decidedBy");
  if (write.decidedBy === undefined) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: an approval decision without a deciding principal is a decision nobody took, so it is not recorded",
    );
  }
}

/** Read one `graph_run_reexecutions` row. */
function readReexecutionRow(
  row: Record<string, unknown>,
  path: string,
): RunReexecutionRecord {
  const table = GRAPH_STORE_TABLES.runReexecutions;
  const successor = row["successor_run_id"];
  const startedAt = row["successor_started_at"];
  const hasSuccessor = typeof successor === "string" && successor.length > 0;
  if (hasSuccessor !== (typeof startedAt === "number")) {
    throw new GraphStoreFormatError(
      "malformed-row",
      path,
      `graph-store: a ${table} row of ${path} carries a half-written successor (run id ${describeValue(successor)}, started at ${describeValue(startedAt)}) — refusing to read it approximately`,
      successor,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  return Object.freeze({
    graphId: readStoreText(row, "graph_id", path, table),
    runId: readStoreText(row, "run_id", path, table),
    reason: readStoreText(row, "reason", path, table),
    decidedAt: readStoreEpoch(row, "decided_at", path, table),
    ...readDecidedBy(row, "decided_by_session", "decided_by_agent", path, table),
    ...(hasSuccessor
      ? {
          successorRunId: successor as string,
          successorStartedAt: readStoreEpoch(row, "successor_started_at", path, table),
        }
      : {}),
  });
}

/** Refuse a run CONTROL fact that violates the record model before it is stored. */
function assertRunControlShape(control: RunControlRecord): void {
  requireStoreIdentifier(control.graphId, "runControl.graphId");
  requireStoreIdentifier(control.runId, "runControl.runId");
  requireStoreIdentifier(control.reason, "runControl.reason");
  requireStoreEpoch(control.decidedAt, "runControl.decidedAt");
  assertPrincipalShape(control.decidedBy, "runControl.decidedBy");
}

/** Refuse a run row that violates the record model before it is stored. */
function assertRunShape(record: RunIdentityRecord): void {
  requireStoreIdentifier(record.graphId, "run.graphId");
  requireStoreIdentifier(record.runId, "run.runId");
  requireStoreIdentifier(record.planRevision, "run.planRevision");
  requireStoreEpoch(record.startedAt, "run.startedAt");
}

/** Refuse a control write that violates the record model before it is stored. */
function assertControlWriteShape(write: RunControlWrite): void {
  const decision = write.decision;
  const control = write.runControl;
  if (control !== undefined) {
    if (decision.graphId !== control.graphId || decision.runId !== control.runId) {
      throw new GraphStoreWriteError(
        "invalid-record",
        "graph-store: the control decision names run " +
          JSON.stringify(decision.graphId + "/" + decision.runId) +
          " while the run control fact names " +
          JSON.stringify(control.graphId + "/" + control.runId) +
          " — the write was not made",
      );
    }
    if (decision.command !== control.command) {
      throw new GraphStoreWriteError(
        "invalid-record",
        "graph-store: the control decision records " +
          JSON.stringify(decision.command) +
          " while the run control fact records " +
          JSON.stringify(control.command) +
          " — one write cannot record two commands, so nothing was written",
      );
    }
    requireStoreIdentifier(control.reason, "control.reason");
    requireStoreEpoch(control.decidedAt, "control.decidedAt");
    assertPrincipalShape(control.decidedBy, "control.decidedBy");
  }
  requireStoreIdentifier(decision.graphId, "control.graphId");
  requireStoreIdentifier(decision.runId, "control.runId");
  requireStoreIdentifier(decision.nodeId, "control.nodeId");
  requireStoreIdentifier(decision.attemptId, "control.attemptId");
  requireStoreIdentifier(decision.reason, "control.reason");
  requireStoreEpoch(decision.decidedAt, "control.decidedAt");
  assertPrincipalShape(decision.decidedBy, "control.decidedBy");
  // THE SUCCESSOR LINK IS PART OF THE RETRY'S SHAPE (the DDL's CHECK says the
  // same): a retry that named no successor could never answer which attempt it
  // minted, and a successor on another command would name an attempt that
  // command never created.
  if (decision.command === "retry") {
    requireStoreIdentifier(decision.successorAttemptId, "control.successorAttemptId");
  } else if (decision.successorAttemptId !== undefined) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: the control decision records command " +
        JSON.stringify(decision.command) +
        " with successor attempt " +
        JSON.stringify(decision.successorAttemptId) +
        " — only a retry mints an attempt, so nothing was written",
    );
  }
}

/** Refuse a re-execution decision that violates the record model. */
function assertReexecutionShape(record: RunReexecutionRecord): void {
  requireStoreIdentifier(record.graphId, "reexecution.graphId");
  requireStoreIdentifier(record.runId, "reexecution.runId");
  requireStoreIdentifier(record.reason, "reexecution.reason");
  requireStoreEpoch(record.decidedAt, "reexecution.decidedAt");
  assertPrincipalShape(record.decidedBy, "reexecution.decidedBy");
  if (record.successorRunId !== undefined) {
    requireStoreIdentifier(record.successorRunId, "reexecution.successorRunId");
    requireStoreEpoch(record.successorStartedAt, "reexecution.successorStartedAt");
  } else if (record.successorStartedAt !== undefined) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: the re-execution decision of run " +
        JSON.stringify(record.runId) +
        " carries a successor start time without a successor run — nothing was written",
    );
  }
}

/** Refuse a principal that is not a session with an optional non-empty agent. */
function assertPrincipalShape(
  principal: ControlPrincipalRecord | undefined,
  field: string,
): void {
  if (principal === undefined) return;
  requireStoreIdentifier(principal.sessionId, field + ".sessionId");
  if (
    principal.agentId !== undefined &&
    (typeof principal.agentId !== "string" || principal.agentId.length === 0)
  ) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: " +
        field +
        ".agentId is " +
        describeValue(principal.agentId) +
        ", not a non-empty agent — the record was not written",
    );
  }
}

/** Refuse a definition row that violates the record model before it is stored. */
function assertDefinitionShape(record: GraphDefinitionRecord): void {
  requireStoreIdentifier(record.graphId, "definition.graphId");
  requireStoreIdentifier(record.declarationDigest, "definition.declarationDigest");
  requireStoreIdentifier(record.planRevision, "definition.planRevision");
  requireStoreEpoch(record.recordedAt, "definition.recordedAt");
}

/** Refuse an origin row that violates the record model before it is stored. */
function assertOriginShape(
  graphId: string,
  origin: InvocationOriginRecord,
  now: number,
): void {
  requireStoreIdentifier(graphId, "origin.graphId");
  requireStoreIdentifier(origin.sessionId, "origin.sessionId");
  if (
    origin.agent !== undefined &&
    (typeof origin.agent !== "string" || origin.agent.length === 0)
  ) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: origin.agent is " + describeValue(origin.agent) + ", not a non-empty string — the origin was not written",
    );
  }
  requireStoreEpoch(now, "origin.updatedAt");
}

/** Refuse a field that is not a non-empty identifier. */
function requireStoreIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphStoreWriteError(
      "invalid-record",
      `graph-store: ${field} is ${describeValue(value)}, not a non-empty identifier — the record was not written`,
    );
  }
}

/** Refuse a timestamp that is not epoch milliseconds. */
function requireStoreEpoch(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GraphStoreWriteError(
      "invalid-record",
      `graph-store: ${field} is ${describeValue(value)}, not epoch milliseconds (a safe integer) — the record was not written`,
    );
  }
}

/** The explicit refusal the create-once rule needs. */
function heldClaim(row: ExecutionBindingRecord): ExecutionClaim {
  return Object.freeze({ kind: "held" as const, row });
}

/** One host execution identity, normalized (the task id only when it is named). */
function identityOf(execution: ExecutionIdentity): ExecutionIdentity {
  return Object.freeze({
    executionId: execution.executionId,
    ...(typeof execution.taskId === "string" && execution.taskId.length > 0
      ? { taskId: execution.taskId }
      : {}),
  });
}

/** Why one confirmation was fenced, as host-authored (credential-free) text. */
function fencedReason(
  row: ExecutionBindingRecord,
  ownerId: string,
  generation: number,
): string {
  if (row.ownerId !== ownerId) {
    return (
      "the row belongs to owner " +
      JSON.stringify(row.ownerId) +
      " and not to " +
      JSON.stringify(ownerId)
    );
  }
  if (row.generation !== generation) {
    return (
      "the row belongs to claim " +
      String(row.generation) +
      " of this owner and not to the presented claim " +
      String(generation)
    );
  }
  return (
    "the row is " +
    JSON.stringify(row.state) +
    ", not 'creating' — a confirmation records the execution a claim handed over"
  );
}

/**
 * The refusal one row carries, as the projection reads it, or nothing to add.
 *
 * The group is all-or-nothing: a row that names a refusal KIND without recording
 * when it happened (or the reverse) is a half-written record and is refused by
 * name. `refused_generation` is NULL when the refused write held no claim, and
 * the projection reports that as 0.
 */
function refusalOf(
  entry: Record<string, unknown>,
  effect: StoreEffectKey,
  filePath: string,
  table: string,
): { readonly refused?: HostExecutionRefusal } {
  const kind = readOptionalStoreText(entry, "refused_kind", filePath, table);
  const at = readOptionalStoreEpoch(entry, "refused_at", filePath, table);
  if ((kind === undefined) !== (at === undefined)) {
    throw new GraphStoreFormatError(
      "malformed-row",
      filePath,
      `graph-store: the execution binding for effect ${JSON.stringify(effect.effectId)} carries half a refusal record (kind ${describeValue(kind)}, at ${describeValue(at)}) — refusing to read it approximately`,
      kind ?? at,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if (kind === undefined || at === undefined) return Object.freeze({});
  if (
    kind !== "stale-confirmation" &&
    kind !== "conflicting-execution" &&
    kind !== "unproven-failure"
  ) {
    throw new GraphStoreFormatError(
      "malformed-row",
      filePath,
      `graph-store: the execution binding for effect ${JSON.stringify(effect.effectId)} records refusal kind ${describeValue(kind)}, which this build does not write — refusing to read it approximately`,
      kind,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  const ownerId = readOptionalStoreText(entry, "refused_owner_id", filePath, table);
  if (ownerId === undefined) {
    throw new GraphStoreFormatError(
      "malformed-row",
      filePath,
      `graph-store: the execution binding for effect ${JSON.stringify(effect.effectId)} records a refusal without the owner that asked — refusing to read it approximately`,
      kind,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  const generation = readOptionalStoreEpoch(entry, "refused_generation", filePath, table);
  const executionId = readOptionalStoreText(entry, "refused_execution_id", filePath, table);
  const count = readStoreEpoch(entry, "refused_count", filePath, table);
  return Object.freeze({
    refused: Object.freeze({
      kind,
      ownerId,
      generation: generation ?? 0,
      ...(executionId === undefined ? {} : { executionId }),
      at,
      count,
    }),
  });
}

/** Read one nullable TEXT column, or `undefined` when SQL NULL. */
function readOptionalStoreText(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return readStoreText(row, column, path, table);
}

/** Read one nullable INTEGER column, or `undefined` when SQL NULL. */
function readOptionalStoreEpoch(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return readStoreEpoch(row, column, path, table);
}

/** One borrow of a shared connection: the entry and the registry key. */
export interface BorrowedConnection {
  readonly connection: SharedConnection;
  readonly key: string;
}

/** The absolute spelling of one store path, so two callers share one connection. */
function resolvePath(filePath: string): string {
  return resolve(filePath);
}

/** Whether two origins name the same invocation. */
function sameOrigin(
  left: InvocationOriginRecord,
  right: InvocationOriginRecord,
): boolean {
  return left.sessionId === right.sessionId && left.agent === right.agent;
}

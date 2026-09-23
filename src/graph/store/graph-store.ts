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
  CommitResult,
  EffectTransition,
  GraphStateRecord,
  PendingEffectRecord,
  ReceiptRecord,
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
    this.ledger = new LedgerTables(connection.db, filePath, (work) =>
      this.joinOrBegin(work),
    );
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
      pendingEffects: (graphId: string): readonly PendingEffectRecord[] =>
        this.pendingEffects(graphId),
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
  pendingEffects(graphId: string): readonly PendingEffectRecord[] {
    this.assertOpen("pendingEffects");
    return this.ledger.pendingEffects(graphId);
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

/**
 * Graph Execution Engine v2 — the SQLite substrate of {@link AcceptanceLedger}
 *
 * Version: 2.0
 * Date: 2026-09-23
 *
 * THE LEDGER IS NOW A FACADE OVER THE WORKSPACE'S ONE GRAPH STORE. P1 item 3
 * converged the three durable substrates — this ledger, `host-store.sqlite` and
 * `host-invocation-origins.json` — into `src/graph/store/**`, one SQLite file
 * with one schema and one transaction boundary. This module keeps everything a
 * caller already imports:
 *
 * - the port implementation {@link SqliteAcceptanceLedger}, with the SAME
 *   `create` / `openReadOnly` / `commitAccepted` / `runInTransaction` surface;
 * - the format identity and the table names (`LEDGER_FORMAT_VERSION`,
 *   `LEDGER_TABLES`, `LEDGER_FILE_NAME`, `ledgerFilePath`);
 * - the refusal types under their existing names and `problem` identifiers
 *   (`LedgerFormatError`, `LedgerWriteError`, `LedgerClosedError`), which are
 *   now the store's own classes re-exported — the SAME objects, so
 *   `instanceof` keeps meaning what it meant.
 *
 * WHAT MOVED, AND WHY IT IS NOT A BEHAVIOUR CHANGE. The record model, the
 * replay/conflict/settled rules, the JSON representability and size gates, the
 * conditional effect transitions and the open-time format gate all live in
 * `src/graph/store/` now, unchanged in substance: this file no longer holds a
 * second copy, so the acceptance rules cannot drift from the store that commits
 * them. The one deliberate difference is that the format it gates is the
 * CONVERGED layout (version 2), so a version-1 file is refused as an older
 * format this build registers no migration for.
 *
 * THE TRANSACTION IS STILL ONE BOUNDARY. `runInTransaction` delegates to
 * `GraphStore.runInTransaction`, so the reducer's read, its conditional check,
 * the receipt/event/result commit and the effect write share one transaction —
 * and a nested call is refused by name rather than becoming a savepoint.
 *
 * RESTART IS A READ. A new instance over the same file sees identical rows, and
 * `pendingEffects` answers what a previous process left `pending` or
 * `started` — that listing IS the resume path. Effects are bookkeeping only:
 * nothing here executes, dispatches or reconciles one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { errorText } from "../../utils/error-text.ts";
import { GraphStore } from "../store/graph-store.ts";
import {
  GraphStoreFormatError,
  type GraphStoreFormatProblem,
} from "../store/errors.ts";
import { isWalStore } from "../store/format.ts";
import {
  GRAPH_STORE_FILE,
  GRAPH_STORE_LEDGER_TABLES,
  GRAPH_STORE_TABLES,
} from "../store/schema.ts";
import {
  LEDGER_FORMAT_VERSION,
  type AcceptanceBatch,
  type AcceptanceLedger,
  type AcceptanceLedgerTx,
  type AcceptedEventRecord,
  type BudgetLedger,
  type CommitResult,
  type EffectTransition,
  type GraphStateRecord,
  type PendingEffectRecord,
  type ReceiptRecord,
  type RunControlLedger,
  type SubmissionKey,
} from "./types.ts";

// ── Re-exported identity (unchanged names, unchanged values) ────────────────

/** The file name the ledger always owned; it is the store's file now. */
export const LEDGER_FILE_NAME = GRAPH_STORE_FILE;

/**
 * The ledger file path for a directory.
 *
 * The DIRECTORY is the injection point — `create` takes it, derives this path,
 * and opens one connection — so a test uses `mkdtempSync` and two graphs may
 * keep separate stores without a process-wide singleton.
 */
export function ledgerFilePath(directory: string): string {
  return join(directory, LEDGER_FILE_NAME);
}

/** The ledger's own tables, as this store names them. */
export const LEDGER_TABLES = GRAPH_STORE_LEDGER_TABLES;

/** Every table the converged store owns, for a reader that needs the whole set. */
export const LEDGER_STORE_TABLES = GRAPH_STORE_TABLES;

export { LEDGER_FORMAT_VERSION };

/**
 * The store's refusals, under the names the ledger always exported — the SAME
 * classes and the SAME `problem` identifiers, so `instanceof` and every
 * existing assertion keep their meaning.
 */
export {
  GraphStoreClosedError as LedgerClosedError,
  GraphStoreFormatError as LedgerFormatError,
  GraphStoreWriteError as LedgerWriteError,
} from "../store/errors.ts";
export type LedgerFormatProblem = GraphStoreFormatProblem;
export type { GraphStoreWriteProblem as LedgerWriteProblem } from "../store/errors.ts";

// ── Read-only access ────────────────────────────────────────────────────────

/**
 * The READ-ONLY half of the acceptance ledger: exactly the reads a consumer
 * that must not change the store needs.
 *
 * It is a distinct type rather than a flag on {@link AcceptanceLedger} so a
 * read-only consumer (the drain audit) cannot reach a write at all: the handle
 * a read-only open answers is typed as this, and the connection underneath
 * refuses a write at the SQLite layer as well. Both halves of that are the
 * point — the type says what the caller may do, the connection says what the
 * process may do.
 *
 * {@link SqliteAcceptanceLedger} satisfies it structurally, so one
 * implementation serves both surfaces and the read rules cannot drift.
 */
export interface AcceptanceLedgerReader {
  /** The persisted state snapshot of one graph, or `undefined`. */
  readGraphState(graphId: string): GraphStateRecord | undefined;
  /**
   * The effects of one RUN still `pending` or `started`; `runId` omitted means
   * the graph's current run (G3).
   */
  pendingEffects(graphId: string, runId?: string): readonly PendingEffectRecord[];
  /** The attempts of one run whose cancellation the PLATFORM CONFIRMED. */
  confirmedCancelAttempts(graphId: string, runId?: string): readonly string[];
  /** Close the substrate. Idempotent. */
  close(): void;
}

/**
 * What {@link SqliteAcceptanceLedger.openReadOnly} produced.
 *
 * TOTAL: every way an existing ledger can fail to be readable is a value, never
 * a throw, because the audit this serves must report an unreadable store as a
 * BLOCKER instead of crashing on it. An ABSENT store (no file at all) is
 * deliberately its own kind: it is not an unreadable record, and a read-only
 * open must never create the file that would turn it into one.
 */
export type LedgerReadOpenResult =
  | {
      readonly kind: "opened";
      readonly filePath: string;
      readonly ledger: AcceptanceLedgerReader;
    }
  /** No ledger file exists — nothing has ever been committed here. */
  | { readonly kind: "absent"; readonly filePath: string }
  /**
   * The file exists and is a SQLite store, but not one this build may read:
   * unknown / newer / older format, a foreign store, or a reshaped layout. The
   * file is left exactly as it was found.
   */
  | {
      readonly kind: "refused";
      readonly filePath: string;
      readonly problem: LedgerFormatProblem;
      readonly message: string;
    }
  /** The file exists but could not be opened or read (I/O, permissions, …). */
  | { readonly kind: "unreadable"; readonly filePath: string; readonly reason: string };

// ── The ledger ──────────────────────────────────────────────────────────────

/**
 * The durable acceptance ledger over the workspace's ONE graph store.
 *
 * Build one with {@link SqliteAcceptanceLedger.create}, which opens the store
 * file in the directory it is given and runs the format gate — there is no
 * module-level connection and no singleton, so the substrate is injectable and a
 * test owns its own temp directory.
 */
export class SqliteAcceptanceLedger implements AcceptanceLedger {
  readonly ledgerFormatVersion: number = LEDGER_FORMAT_VERSION;

  /**
   * The RUN IDENTITY and TRUSTED CONTROL surface (P3 item 1).
   *
   * A pure delegation to the store, exactly like every other method here: the
   * run path reads the run's control fact through the port it already holds, so
   * a controlled run is refused by the SAME code that settles an outcome, and
   * the control service writes through the SAME connection and boundary.
   * Nothing about the rules lives here.
   */
  readonly runs: RunControlLedger;

  /**
   * The dispatch BUDGET surface (P3 item 3).
   *
   * A pure delegation to the store, like `runs` above: the run path claims its
   * dispatch's share of the node's declared ceilings through the port it already
   * holds, reconciles real usage through the same boundary, and a restart reads
   * the claims a previous process made. Nothing about the rules lives here, and
   * the field is REQUIRED (not optional) because a ledger this build opens can
   * always hold a claim — a plan that declares a ceiling refuses to dispatch
   * when the surface is missing, and an absent property on the shipped ledger
   * would make every budgeted graph refuse.
   */
  readonly budget: BudgetLedger;

  private readonly store: GraphStore;

  private constructor(store: GraphStore) {
    this.store = store;
    this.runs = store.runs;
    this.budget = store.budget;
  }

  /**
   * Open (or initialize) the store file in `directory`.
   *
   * A directory with no store gets the schema and its version row in one
   * transaction; an existing store is opened only when its format version is
   * exactly the one this build writes and every table's columns, affinities,
   * nullability and PRIMARY KEY are the ones this format writes. Every refusal
   * closes the handle and leaves the file untouched.
   */
  static async create(directory: string): Promise<SqliteAcceptanceLedger> {
    return new SqliteAcceptanceLedger(await GraphStore.openFileAsync(directory));
  }

  /** The file this ledger's store owns. */
  get filePath(): string {
    return this.store.path;
  }

  /**
   * Open an EXISTING store READ-ONLY, or report why it cannot be read.
   *
   * The audit's entry point, and deliberately NOT a variant of {@link create}:
   * nothing here may change the store. The directory is not created, the file
   * is not created, the schema is never initialized, and the connection is
   * opened read-only, so a write attempted later fails at the SQLite layer
   * instead of landing. A store that does not exist answers `absent` — the
   * honest reading of "nothing has been committed here", and never a licence to
   * initialize one.
   *
   * An existing file passes the SAME format gate the read/write opener applies
   * (version identity first, then every table's columns, affinities,
   * nullability and PRIMARY KEY), and a refusal is returned as data, with the
   * file left exactly as it was found. TOTAL: a throwing open or an unexpected
   * failure is `unreadable` rather than an exception, because the audit must
   * report such a store as a blocker instead of crashing on it.
   *
   * A WAL-MODE STORE IS REFUSED BEFORE ANY CONNECTION EXISTS. A read-only
   * SQLite open of a WAL database still attaches to — and rewrites — its
   * `-shm` shared-memory side file, so reading one would change the store this
   * open promises not to touch. {@link isWalStore} decides the journal mode
   * from the file header, which is a plain read; the store and its side files
   * are left exactly as found, and the refusal is the named problem
   * `wal-journal-mode`.
   */
  static async openReadOnly(directory: string): Promise<LedgerReadOpenResult> {
    const filePath = ledgerFilePath(directory);
    if (!existsSync(filePath)) return { kind: "absent", filePath };

    if (isWalStore(filePath)) {
      return {
        kind: "refused",
        filePath,
        problem: "wal-journal-mode",
        message:
          `acceptance-ledger: ${filePath} is a WAL-mode SQLite store; a ` +
          "read-only open would attach to and rewrite its -shm side file, so " +
          "this build refuses to read it rather than change the store it reads",
      };
    }

    let borrowed;
    try {
      borrowed = await GraphStore.acquireReadOnlyConnectionAsync(filePath);
    } catch (error) {
      return { kind: "unreadable", filePath, reason: errorText(error) };
    }
    try {
      const store = GraphStore.openReadOnlyVerified(
        borrowed.connection,
        borrowed.key,
        filePath,
      );
      return { kind: "opened", filePath, ledger: new SqliteAcceptanceLedger(store) };
    } catch (error) {
      if (error instanceof GraphStoreFormatError) {
        return {
          kind: "refused",
          filePath,
          problem: error.problem,
          message: error.message,
        };
      }
      return { kind: "unreadable", filePath, reason: errorText(error) };
    }
  }

  // ── Commit ────────────────────────────────────────────────────────────────

  /**
   * Commit one acceptance batch atomically.
   *
   * The protocol rules are evaluated in order — replay, conflict, settled — and
   * only a batch that clears all three reaches the write, inside ONE
   * transaction, whose verdict is returned only after it committed.
   */
  commitAccepted(batch: AcceptanceBatch): CommitResult {
    return this.store.commitAccepted(batch);
  }

  // ── Graph state ───────────────────────────────────────────────────────────

  /** The persisted state snapshot of one graph, or `undefined`. */
  readGraphState(graphId: string): GraphStateRecord | undefined {
    return this.store.readGraphState(graphId);
  }

  /** Write (or replace) one graph's state snapshot inside the caller's transaction. */
  writeGraphState(record: GraphStateRecord): void {
    this.store.writeGraphState(record);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  lookupReceipt(key: SubmissionKey): ReceiptRecord | undefined {
    return this.store.lookupReceipt(key);
  }

  acceptedEvents(graphId: string): readonly AcceptedEventRecord[] {
    return this.store.acceptedEvents(graphId);
  }

  /**
   * The UNSETTLED effects of one RUN — rows still `pending` or `started`.
   *
   * RUN-SCOPED (G3): `runId` omitted means the graph's CURRENT run. A graph with
   * no run row has one implicit run and is answered in full.
   */
  pendingEffects(graphId: string, runId?: string): readonly PendingEffectRecord[] {
    return this.store.pendingEffects(graphId, runId);
  }

  /** The attempts of one run whose cancellation the PLATFORM CONFIRMED. */
  confirmedCancelAttempts(graphId: string, runId?: string): readonly string[] {
    return this.store.confirmedCancelAttempts(graphId, runId);
  }

  /**
   * Write one new effect as the durable intent of work this transaction is
   * about to do. `ON CONFLICT DO NOTHING` is the rule: a repeated writer never
   * rewinds a `started` or terminal row to `pending`.
   */
  writeEffect(record: PendingEffectRecord): void {
    this.store.writeEffect(record);
  }

  // ── Effect lifecycle ──────────────────────────────────────────────────────

  markEffectStarted(graphId: string, effectId: string): EffectTransition {
    return this.store.markEffectStarted(graphId, effectId);
  }

  markEffectDone(graphId: string, effectId: string): EffectTransition {
    return this.store.markEffectDone(graphId, effectId);
  }

  markEffectFailed(graphId: string, effectId: string): EffectTransition {
    return this.store.markEffectFailed(graphId, effectId);
  }

  // ── Transaction extension point ───────────────────────────────────────────

  /**
   * Run `fn` inside ONE transaction and return its result after COMMIT.
   *
   * Delegates to the store, which is the single boundary for every table the
   * workspace keeps — the acceptance records AND the host records — so a caller
   * can commit an acceptance, its effects and the host binding they authorize
   * together. The callback MUST be synchronous and it must not call
   * `runInTransaction` again: both are refused by name.
   */
  runInTransaction<R>(fn: (tx: AcceptanceLedgerTx) => R): R {
    return this.store.transaction(fn);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Close the connection. Idempotent; a second close is a no-op. */
  close(): void {
    this.store.close();
  }
}

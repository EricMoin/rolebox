/**
 * Graph store — the load verdict (P1 item 6)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE LOAD RESULT IS EXACTLY ONE OF `absent` / `valid` / `corrupt` /
 * `unsupported`, and `migration-required` only where a REGISTERED conversion
 * exists. This module is the one place that answers which, and it is total: an
 * unreadable file is a verdict, never a throw, because the caller has to be able
 * to report a damaged store instead of crashing on it.
 *
 * THE GATE ORDER IS THE POINT, and it is the order the persisted-state loader
 * and the ledger audit already use:
 * 1. a NON-EMPTY RETIRED authority beside the path, with no store of this
 *    build's, is `unsupported` — not `absent`: this build registers no
 *    conversion for those records and must not answer "no execution binding"
 *    for what they hold;
 * 2. no authoritative file at all is `absent` — the ONLY verdict a caller may
 *    initialize from;
 * 3. a ZERO-BYTE file is `corrupt` BEFORE any connection exists, because opening
 *    it would write a database header into it;
 * 4. a WAL-journal store is `unsupported` before any connection exists, because
 *    even a read-only open attaches to and rewrites its `-shm` side file;
 * 5. otherwise the format gate decides: a well-formed version discriminator this
 *    build has no decoder for (newer, older, unknown) is `unsupported`; a file
 *    that is not this store, or whose layout violates the format it claims, is
 *    `corrupt`; a file that passes is `valid` with an OPEN, READ-ONLY handle.
 *
 * A `valid` handle is read-only BY CONSTRUCTION: the connection refuses a write
 * at the SQLite layer, so "loading never changes the store" is structural. The
 * write path is `GraphStore.openFile`, which runs the same gate and may
 * initialize ONLY an `absent` store.
 *
 * NO `migration-required` IS EVER PRODUCED. This slice registers no conversion
 * capability, so the branch is uninhabited (`Migration = never`): the honest
 * answer for a format this build cannot read is `unsupported`, and the honest
 * answer for a body that violates its own format is `corrupt`.
 *
 * Dependency leaf of the store: this module reads the file, the gate and the
 * domain verdict vocabulary, and touches no record type.
 */

import { errorText } from "../../utils/error-text.ts";
import type { DomainLoadResult } from "../domain/load-result.ts";
import { GraphStoreFormatError } from "./errors.ts";
import {
  isWalStore,
  readStoreDirectory,
  type StoreDirectoryReading,
} from "./format.ts";
import { GraphStore, type BorrowedConnection } from "./graph-store.ts";

/**
 * The verdict of loading one workspace's authoritative store.
 *
 * `value` is the open, read-only store when the verdict is `valid`; the other
 * branches carry no handle. `Migration` is `never` because no conversion is
 * registered — see the module header.
 */
export type GraphStoreLoadResult = DomainLoadResult<GraphStore, never>;

/** Load the store inside `root` read-only, asynchronously. */
export async function loadGraphStore(root: string): Promise<GraphStoreLoadResult> {
  const reading = readDirectory(root);
  if (isVerdict(reading)) return reading;
  let borrowed: BorrowedConnection;
  try {
    borrowed = await GraphStore.acquireReadOnlyConnectionAsync(reading.filePath);
  } catch (error) {
    return unreadable(reading.filePath, error);
  }
  return finish(borrowed, reading);
}

/** Load the store inside `root` read-only, synchronously. */
export function loadGraphStoreSync(root: string): GraphStoreLoadResult {
  const reading = readDirectory(root);
  if (isVerdict(reading)) return reading;
  let borrowed: BorrowedConnection;
  try {
    borrowed = GraphStore.acquireReadOnlyConnection(reading.filePath);
  } catch (error) {
    return unreadable(reading.filePath, error);
  }
  return finish(borrowed, reading);
}

/**
 * The checks that need no connection.
 *
 * The three early verdicts are returned as values; only a present, non-empty,
 * non-WAL file is handed on to the opener — and the caller must not open
 * anything earlier, because opening a zero-byte path writes a header into it.
 */
function readDirectory(
  root: string,
): Extract<StoreDirectoryReading, { kind: "store" }> | GraphStoreLoadResult {
  const reading = readStoreDirectory(root);
  if (reading.kind === "retired") {
    return {
      kind: "unsupported",
      dimension: "storage",
      detail:
        "this root holds " +
        reading.files.join(", ") +
        " — a retired authority this build neither reads nor converts; its " +
        "records must be inventoried and archived before the workspace's store " +
        "can be initialized here",
    };
  }
  if (reading.kind === "absent") return { kind: "absent" };
  if (reading.empty) {
    return {
      kind: "corrupt",
      dimension: "storage",
      reason:
        reading.filePath + " exists and is zero bytes — a damaged store, never a new run",
    };
  }
  if (isWalStore(reading.filePath)) {
    return {
      kind: "unsupported",
      dimension: "storage",
      detail:
        reading.filePath +
        " is a WAL-mode SQLite store; a read-only open would attach to and " +
        "rewrite its -shm side file, so this build refuses to read it rather " +
        "than change the store it reads",
    };
  }
  return reading;
}

/** Whether the directory reading already decided the verdict. */
function isVerdict(
  value: Extract<StoreDirectoryReading, { kind: "store" }> | GraphStoreLoadResult,
): value is GraphStoreLoadResult {
  return !("kind" in value) || value.kind !== "store";
}

/** Verify a borrowed read-only connection and turn the outcome into a verdict. */
function finish(
  borrowed: BorrowedConnection,
  reading: Extract<StoreDirectoryReading, { kind: "store" }>,
): GraphStoreLoadResult {
  try {
    const store = GraphStore.openReadOnlyVerified(
      borrowed.connection,
      borrowed.key,
      reading.filePath,
    );
    // Verified: the handle's connection cannot write at all.
    return { kind: "valid", value: store };
  } catch (error) {
    if (error instanceof GraphStoreFormatError) return fromProblem(error);
    return unreadable(reading.filePath, error);
  }
}

/** Map one gate refusal onto the domain verdict vocabulary. */
function fromProblem(error: GraphStoreFormatError): GraphStoreLoadResult {
  if (
    error.problem === "newer-format" ||
    error.problem === "older-format" ||
    error.problem === "wal-journal-mode"
  ) {
    return { kind: "unsupported", dimension: "storage", detail: error.message };
  }
  return { kind: "corrupt", dimension: "storage", reason: error.message };
}

/** A file that exists but could not be read at all. */
function unreadable(filePath: string, error: unknown): GraphStoreLoadResult {
  return {
    kind: "corrupt",
    dimension: "storage",
    reason: filePath + " could not be read (" + errorText(error) + ")",
  };
}

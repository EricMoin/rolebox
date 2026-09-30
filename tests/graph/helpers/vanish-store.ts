/**
 * Make a store's authoritative DATABASE PATH stop existing — the fence
 * `GraphStore` raises when the file it was opened over is gone.
 *
 * WHAT EACH FAMILY REALLY ALLOWS. A store holds its database open, and the two
 * families disagree about what an open file lets the filesystem do:
 *
 * - The POSIX family unlinks an open file happily: the entry goes, the handle
 *   keeps the blocks, and the store's next read notices its path is gone.
 * - Windows refuses BOTH the unlink and a move of the entry. SQLite opens its
 *   database with `FILE_SHARE_READ | FILE_SHARE_WRITE` and deliberately WITHOUT
 *   `FILE_SHARE_DELETE` (os_win.c, `winOpen`), so an unlink of the entry comes
 *   back `EBUSY`, and a rename needs DELETE access to the very file whose handle
 *   refuses to share it and comes back `EPERM`.
 *
 * The fallback this helper used to reach for — moving the store ROOT aside, on
 * the theory that an open file shares its own file object and not its parent
 * directory's — is NOT platform-expressible either, and windows-latest proved
 * it: run 36673190424 reported
 *   `EPERM: operation not permitted, rename
 *    'C:\...\graph-identity-voTcv8' -> 'C:\...\graph-store-vanished-SFlTz4\graph-identity-voTcv8'`
 * and the same refusal for two `graph-channel-*\store` roots, while each store
 * was open.
 *
 * So this helper no longer promises a disappearance. It ATTEMPTS the operations
 * whose outcome the platform decides and REPORTS what happened: `removed` when
 * the path is gone, and the errno the OS answered with when it is not. Each
 * caller then asserts the truth its own platform can have — the fence where the
 * disappearance is permitted, and the refusal plus the surviving, still-serving
 * store where it is not. A caller that sees `removed === false` has learned a
 * fact about the platform, not a failure of this helper.
 *
 * A tree a move put aside deliberately stays in the OS temp directory rather
 * than being cleaned up here: whether it can be removed at all is a property of
 * the open handle, and turning that into a teardown failure of this helper would
 * hide the fact the caller asked for. The scratch directory a REFUSED move
 * created IS removed, because nothing was moved into it.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { storeIdentityPath } from "../../../src/graph/store/identity.ts";
import { graphStoreFilePath } from "../../../src/graph/store/schema.ts";

/** One operation the OS refused while this helper tried to make the path go away. */
export interface StoreRemovalRefusal {
  /** Which filesystem operation was refused. */
  readonly operation: "unlink" | "rename-entry" | "rename-root";
  /** The errno the OS reported (`EBUSY`/`EPERM` on Windows, `EACCES`/`EPERM` where a directory denies it). */
  readonly code: string;
}

/** What an attempt to make a store's database path stop existing did. */
export interface StoreRemovalAttempt {
  /** Whether the database path no longer resolves. */
  readonly removed: boolean;
  /** Where the entry (or the root that held it) was moved, when a move is what removed the path. */
  readonly movedTo?: string;
  /** The operations the platform refused, in the order they were tried. */
  readonly refusals: readonly StoreRemovalRefusal[];
}

/** The errno of a refused filesystem operation, without trusting the error shape. */
function refusalCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
}

/** A directory outside every tree a test removes, for entries moved out of the way. */
function asideDirectory(): string {
  return mkdtempSync(join(tmpdir(), "graph-store-vanished-"));
}

/** Discard the scratch directory a REFUSED move created; nothing was moved into it. */
function discardAsideIfUnused(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: an empty scratch directory is not worth failing a report over.
  }
}

/**
 * Try to make the store's DATABASE ENTRY stop existing: the unlink every
 * platform is asked for first, then a move of the entry itself.
 *
 * The unlink is what a POSIX filesystem performs under the open handle; Windows
 * refuses both operations and this says so instead of throwing.
 */
export function attemptStoreEntryRemoval(storeRoot: string): StoreRemovalAttempt {
  const file = graphStoreFilePath(storeRoot);
  const refusals: StoreRemovalRefusal[] = [];
  try {
    unlinkSync(file);
  } catch (error) {
    refusals.push({ operation: "unlink", code: refusalCode(error) });
  }
  if (!existsSync(file)) return { removed: true, refusals };

  const aside = asideDirectory();
  const moved = join(aside, basename(file));
  try {
    renameSync(file, moved);
  } catch (error) {
    refusals.push({ operation: "rename-entry", code: refusalCode(error) });
  }
  if (!existsSync(file)) return { removed: true, movedTo: moved, refusals };
  discardAsideIfUnused(aside);
  return { removed: false, refusals };
}

/**
 * Try to make the database path disappear by moving the whole STORE ROOT aside
 * and recreating it holding everything it held except the database (the identity
 * marker, for a graph store).
 *
 * A root has no open handle of its own, so the POSIX family moves it while the
 * database inside stays open — the path the store was opened over disappears and
 * the store's next read fences. windows-latest refuses the move of a root whose
 * store is open (`EPERM`, run 36673190424), and `removed === false` reports
 * exactly that, leaving the root as it was.
 */
export function attemptStoreRootMoveAside(storeRoot: string): StoreRemovalAttempt {
  const file = graphStoreFilePath(storeRoot);
  const marker = storeIdentityPath(file);
  const markerBytes = existsSync(marker) ? readFileSync(marker) : undefined;
  const aside = asideDirectory();
  const movedRoot = join(aside, basename(storeRoot));
  try {
    renameSync(storeRoot, movedRoot);
  } catch (error) {
    discardAsideIfUnused(aside);
    return { removed: false, refusals: [{ operation: "rename-root", code: refusalCode(error) }] };
  }
  mkdirSync(storeRoot, { recursive: true });
  if (markerBytes !== undefined) writeFileSync(marker, markerBytes);
  if (existsSync(file)) {
    throw new Error(
      `could not make ${file} disappear: the entry is still there after moving ${storeRoot} aside`,
    );
  }
  return { removed: true, movedTo: movedRoot, refusals: [] };
}

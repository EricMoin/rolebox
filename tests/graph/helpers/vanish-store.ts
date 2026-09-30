/**
 * Make a store's authoritative DATABASE PATH disappear while the store holds it
 * open — the fence `GraphStore` raises when the file it was opened over is gone.
 *
 * WHY THIS IS NOT ONE `rmSync`. On Windows an open handle decides what may
 * happen to the entry: SQLite opens its database file with
 * `FILE_SHARE_READ | FILE_SHARE_WRITE` and deliberately WITHOUT
 * `FILE_SHARE_DELETE` (os_win.c, `winOpen`), so while the store is open the path
 * cannot be unlinked (`EBUSY`/`EPERM`) AND cannot be renamed either — a move
 * needs DELETE access to the very file whose handle refuses to share it. What
 * the handle does NOT hold is the containing directory: an open file shares its
 * file object, not its parent's, and `MoveFileEx` moves "an existing file or
 * directory, including its children" — which is why a Windows updater can rename
 * the folder around a locked DLL. Moving that directory is what makes the
 * database path disappear.
 *
 * The recreated root carries the identity marker back, so the directory keeps
 * the shape the store's own reader classifies — "a bound store whose database is
 * missing" — which is the same verdict the POSIX unlink produces. The moved tree
 * stays in the OS temp directory on purpose: the handle that refused the unlink
 * keeps refusing its removal, and retrying the removal here would turn a
 * deliberate disappearance into a teardown failure.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { storeIdentityPath } from "../../../src/graph/store/identity.ts";
import { graphStoreFilePath } from "../../../src/graph/store/schema.ts";

/** A path outside every tree a test removes, for the entries moved out of the way. */
function asideDirectory(): string {
  return mkdtempSync(join(tmpdir(), "graph-store-vanished-"));
}

/**
 * Move a whole store root out of the way and recreate it holding everything it
 * held except the database — the step Windows needs, because the entry itself
 * cannot be unlinked or renamed while the store's handle holds it.
 *
 * Exported because it is the branch a POSIX filesystem never reaches on its own
 * (it CAN unlink an open file), so the test that pins the fence for the
 * refusing platform calls this directly instead of pretending the platform
 * refused. Returns the path the root was moved to.
 */
export function moveStoreRootAside(storeRoot: string): string {
  const file = graphStoreFilePath(storeRoot);
  const marker = storeIdentityPath(file);
  const markerBytes = existsSync(marker) ? readFileSync(marker) : undefined;
  const movedRoot = join(asideDirectory(), basename(storeRoot));
  renameSync(storeRoot, movedRoot);
  mkdirSync(storeRoot, { recursive: true });
  if (markerBytes !== undefined) writeFileSync(marker, markerBytes);
  if (existsSync(file)) {
    throw new Error(
      `could not make ${file} disappear: the entry is still there after moving ${storeRoot} aside`,
    );
  }
  return movedRoot;
}

/**
 * Make `<storeRoot>`'s authoritative database path stop existing, and leave the
 * directory in place holding whatever it held besides the database (the identity
 * marker, for a graph store).
 *
 * Returns the path the database entry was moved to, when the platform refused to
 * unlink it, so a caller can name it in a diagnostic.
 */
export function vanishStoreDatabase(storeRoot: string): string | undefined {
  const file = graphStoreFilePath(storeRoot);
  // POSIX (and any platform that can unlink an open file): the entry is simply
  // gone, which is what every assertion written against this helper expects.
  try {
    unlinkSync(file);
  } catch {
    // Windows with a live handle: the entry survives the unlink attempt.
  }
  if (!existsSync(file)) return undefined;

  // A move of the FILE is tried before the directory, because it is the smaller
  // intervention wherever a platform allows it; on Windows the same sharing mode
  // that refused the unlink refuses this too.
  const aside = asideDirectory();
  try {
    renameSync(file, join(aside, basename(file)));
  } catch {
    // Expected on Windows while the store is open.
  }
  if (!existsSync(file)) return join(aside, basename(file));

  // Neither the unlink nor a move of the entry could remove the path, so the
  // directory itself is moved: it has no open handle of its own.
  return moveStoreRootAside(storeRoot);
}

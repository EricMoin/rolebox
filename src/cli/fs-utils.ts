import { renameSync, rmSync, cpSync, mkdirSync, accessSync, constants, lstatSync } from "node:fs";

function notWritableHint(dir: string): string {
  return `directory ${dir} is not writable; set ROLEBOX_CONFIG_DIR / ROLEBOX_DATA_DIR or fix permissions`;
}

function notADirectoryHint(dir: string): string {
  return `path ${dir} exists but is not a directory`;
}

function componentNotADirectoryHint(dir: string): string {
  return `cannot create ${dir}: a path component is not a directory`;
}

// A Map, not an object literal: err.code is an arbitrary string carried by an
// arbitrary thrown value, so an inherited key like "constructor" must read as
// unclassified rather than resolve to an Object.prototype member.
const DIR_ERROR_HINTS = new Map<string, (dir: string) => string>([
  ["EACCES", notWritableHint],
  ["EPERM", notWritableHint],
  ["EROFS", notWritableHint],
  ["EEXIST", notADirectoryHint],
  ["ENOTDIR", componentNotADirectoryHint],
]);

/** Return the errno `code` carried by an unknown thrown value, if any. */
function fsErrorCode(err: unknown): string | undefined {
  if (err == null || typeof err !== "object" || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

/**
 * The error to throw for an errno raised while creating or checking `dir`, or
 * undefined when the original error should propagate unchanged; the original
 * error is kept as `cause`.
 */
function dirError(dir: string, err: unknown): Error | undefined {
  const code = fsErrorCode(err);
  const hint = code === undefined ? undefined : DIR_ERROR_HINTS.get(code);
  return hint === undefined ? undefined : new Error(hint(dir), { cause: err });
}

/**
 * Recursively create `dir` (if needed) and verify it is writable and
 * searchable. Fails with a clear, actionable message instead of surfacing an
 * opaque EACCES/EPERM/EROFS/EEXIST/ENOTDIR.
 */
export function ensureWritableDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw dirError(dir, err) ?? err;
  }
  try {
    // Creating an entry needs write AND search permission on the directory, so
    // W_OK alone would accept e.g. mode 0o200 and fail later on the first write.
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (err) {
    throw dirError(dir, err) ?? err;
  }
}

function assertDestinationAbsent(src: string, dest: string): void {
  // lstatSync does not follow the final path component, so a dangling symlink
  // still counts as an existing destination; existsSync follows it, reports the
  // destination as absent, and lets the rename or copy destroy the link.
  if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`moveDir refuses to move ${src} onto ${dest}: the destination already exists`);
  }
}

/**
 * Move a directory.
 *
 * The destination must not exist: moveDir never merges into or overwrites an
 * existing destination, whatever device either path lives on, so destination
 * semantics do not depend on the filesystem layout.
 *
 * On Linux, `renameSync()` fails with EXDEV when src and dest are on different
 * filesystems (e.g. `/tmp` tmpfs vs `~/.local/share`). This helper attempts the
 * fast same-device rename first, then falls back to a recursive copy followed by
 * source deletion. That fallback is NOT atomic: on failure the source is left
 * intact and the partial destination this call created is removed, so moveDir
 * never leaves a half-copied tree behind. Relative symlink targets are
 * preserved verbatim.
 */
export function moveDir(src: string, dest: string): void {
  assertDestinationAbsent(src, dest);
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    if (fsErrorCode(err) !== "EXDEV") throw err;
    // Re-assert the guard immediately before copying: a destination that appeared
    // after the check above must not be silently merged into by cpSync.
    assertDestinationAbsent(src, dest);
    try {
      // verbatimSymlinks keeps relative symlink targets relative. Node's default
      // (false) rewrites them to absolute paths inside the source tree, which is
      // then deleted, leaving broken links in the moved tree. Bun preserves them
      // either way, so this is a no-op on the shipped runtime.
      cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    } catch (copyErr) {
      // The destination did not exist before this call, so everything under it
      // was created by the failed copy: remove it rather than leave it partial.
      try { rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw copyErr;
    }
    rmSync(src, { recursive: true, force: true });
  }
}

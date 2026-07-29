import { renameSync, rmSync, cpSync, mkdirSync, accessSync, constants } from "node:fs";

const NOT_WRITABLE_HINT =
  "directory %s is not writable; set ROLEBOX_CONFIG_DIR / ROLEBOX_DATA_DIR or fix permissions";

function isEACCES(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EACCES"
  );
}

/**
 * Recursively create `dir` (if needed) and verify it is writable.
 * Fails with a clear, actionable message instead of surfacing an opaque EACCES.
 */
export function ensureWritableDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (isEACCES(err)) {
      throw new Error(NOT_WRITABLE_HINT.replace("%s", dir));
    }
    throw err;
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch (err) {
    if (isEACCES(err)) {
      throw new Error(NOT_WRITABLE_HINT.replace("%s", dir));
    }
    throw err;
  }
}

/**
 * Move a directory, falling back to copy+delete on cross-device rename (EXDEV).
 *
 * On Linux, `renameSync()` fails with EXDEV when src and dest are on different
 * filesystems (e.g. `/tmp` tmpfs vs `~/.local/share`). This helper attempts the
 * fast same-device rename first, then falls back to recursive copy + delete.
 */
export function moveDir(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "EXDEV") {
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

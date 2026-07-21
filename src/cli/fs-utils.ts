import { renameSync, rmSync, cpSync } from "node:fs";

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

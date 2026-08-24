import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Monotonic per-process counter — part of the per-write unique temp path. */
let tmpSeq = 0;

/**
 * Build a collision-free sibling temp path for `target`.
 *
 * The temp name is unique per write (`target.<pid>.<seq>.<rand>.tmp`), so
 * concurrent writers to the same target never share one temp file. Sharing a
 * single `target.tmp` allowed an in-flight async write to race a later write's
 * `unlink` + `rename` sequence, letting a stale write land last (or throw
 * ENOENT on rename).
 */
export function uniqueTmpPath(target: string): string {
  tmpSeq += 1;
  return `${target}.${process.pid}.${tmpSeq}.${Math.random().toString(36).slice(2)}.tmp`;
}

/**
 * Atomically replace `target` with `content`: write a unique sibling `.tmp`
 * file, unlink the existing target, then rename the tmp into place. Parent
 * directories are created as needed. Rename is atomic on POSIX, so readers
 * never observe a partially written file.
 */
export function atomicWriteSync(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = uniqueTmpPath(target);
  try {
    writeFileSync(tmp, content, "utf-8");
    // target may not exist (first write or previous crash left no file) — ENOENT is expected and safe to ignore
    try { unlinkSync(target); } catch {}
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup so a failed write never leaves an orphan `.tmp`
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Async variant of {@link atomicWriteSync}. */
export async function atomicWrite(target: string, content: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = uniqueTmpPath(target);
  try {
    await writeFile(tmp, content, "utf-8");
    // target may not exist (first write or previous crash left no file) — ENOENT is expected and safe to ignore
    try { unlinkSync(target); } catch {}
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup so a failed write never leaves an orphan `.tmp`
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

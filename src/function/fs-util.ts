import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomically replace `target` with `content`: write a sibling `.tmp` file,
 * unlink the existing target, then rename the tmp into place. Parent
 * directories are created as needed. Rename is atomic on POSIX, so readers
 * never observe a partially written file.
 */
export function atomicWriteSync(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  try { unlinkSync(target); } catch {}
  renameSync(tmp, target);
}

/** Async variant of {@link atomicWriteSync}. */
export async function atomicWrite(target: string, content: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  await writeFile(tmp, content, "utf-8");
  try { unlinkSync(target); } catch {}
  renameSync(tmp, target);
}

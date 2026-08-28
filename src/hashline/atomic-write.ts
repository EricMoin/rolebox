import { writeFile, rename, unlink, readFile, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { canonicalizeFileText, computeFileVersion } from "./hash.ts";
import { normalizeLockKey } from "./path-lock.ts";

/**
 * D16: resolve the path the atomic replace must land on.
 *
 * A symlink target: rename() over the link path would replace the SYMLINK
 * itself with a regular file, destroying the link and stranding the edit.
 * `realpath` follows the link chain, so the rename replaces the TARGET's
 * directory entry and the link survives (write-through).
 *
 * A hardlinked file: realpath returns the path itself (hardlinks are not
 * resolved), and rename() over it would detach this directory entry from the
 * shared inode — the OTHER name keeps the pre-edit content. Atomic replace of
 * an inode's data without breaking links is impossible on POSIX, so a file
 * with nlink > 1 is written IN PLACE (writeFile truncates the existing inode,
 * preserving it) — both names observe the edit. Trade-off: in-place writes
 * are not atomic (no rename); documented in Caveats.
 *
 * A non-existent path (to-be-created file): nothing to resolve — return as-is.
 */
async function resolveWriteTarget(
  filePath: string
): Promise<{ target: string; inPlace: boolean }> {
  let resolved: string;
  try {
    resolved = await realpath(filePath);
  } catch {
    return { target: filePath, inPlace: false };
  }
  const st = await stat(resolved);
  return { target: resolved, inPlace: st.nlink > 1 };
}

/**
 * Write content to a file atomically.
 * Writes to a temp file first, then renames to the target path.
 * This ensures the file is never in a partially-written state.
 * If the process crashes between write and rename, the original file is intact.
 *
 * Durability note: no fsync is performed. This protects against torn or partial
 * writes within the process — it does not guarantee the data survives power loss.
 *
 * D16: through a symlink the rename lands on the link's TARGET (the link
 * survives, the target updates); a hardlinked file (nlink > 1) is written in
 * place so the shared inode observes the edit.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const { target, inPlace } = await resolveWriteTarget(filePath);
  if (inPlace) {
    await writeFile(target, content, "utf-8");
    return;
  }
  const tmpPath = join(dirname(target), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, target); // atomic on same filesystem
  } catch (error) {
    // Clean up temp file if anything went wrong
    try { await unlink(tmpPath); } catch { /* ignore cleanup errors */ }
    throw error;
  }
}

/**
 * Batch write: write all files to temp first, then rename each into place.
 *
 * NOT a cross-file transaction. Each individual rename is atomic on the same
 * filesystem, but the batch as a whole is best-effort: a failure or crash
 * between renames leaves earlier files updated and later files untouched —
 * there is no rollback of already-renamed files. "No partial updates" does not
 * hold across the batch.
 *
 * D16: every entry resolves its write target exactly like atomicWriteFile —
 * symlinks are replaced at the link target, hardlinked files (nlink > 1) are
 * written in place during the temp phase.
 */
export async function atomicWriteBatch(writes: Array<{ filePath: string; content: string }>): Promise<void> {
  // Defensive: reject duplicate target paths. Renaming the same path twice in
  // one batch would silently overwrite the first entry's content. Keys are
  // realpath-normalized (D15), so symlink/hardlink aliases collide too.
  const seen = new Set<string>();
  for (const { filePath } of writes) {
    const key = normalizeLockKey(filePath);
    if (seen.has(key)) {
      throw new Error(`atomicWriteBatch: duplicate target path "${filePath}"`);
    }
    seen.add(key);
  }

  const temps: string[] = [];
  const renames: Array<{ tmp: string; target: string }> = [];
  try {
    for (const { filePath, content } of writes) {
      const { target, inPlace } = await resolveWriteTarget(filePath);
      if (inPlace) {
        // Hardlink: write through to the shared inode now (non-atomic, but the
        // only way to keep both names observing the edit).
        await writeFile(target, content, "utf-8");
        continue;
      }
      const tmpPath = join(dirname(target), `.${randomBytes(8).toString("hex")}.tmp`);
      await writeFile(tmpPath, content, "utf-8");
      temps.push(tmpPath);
      renames.push({ tmp: tmpPath, target });
    }
    // All temps written successfully — now rename all
    for (const { tmp, target } of renames) {
      await rename(tmp, target);
    }
  } catch (error) {
    // Clean up any remaining temps (already-renamed files are kept)
    for (const tmp of temps) {
      try { await unlink(tmp); } catch { /* ignore cleanup errors */ }
    }
    throw error;
  }
}

/**
 * Pre-write best-effort CAS: re-read the file and confirm it still matches the
 * content version observed earlier. Returns a human-readable conflict
 * description, or null when the file is unchanged (or, for a to-be-created
 * file, still absent).
 *
 * `expectedVersion === null` means the file did not exist during the read phase
 * and is expected to be created — any existing file at this point is a conflict.
 *
 * This is best-effort only: it does not lock the file against other processes,
 * so a file changed between this check and the subsequent rename is not
 * detected. It is NOT a strict cross-process CAS.
 */
export async function verifyFileUnchanged(filePath: string, expectedVersion: string | null): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      if (expectedVersion === null) {
        return null; // file still absent, as expected for creation
      }
      return `File ${filePath} was deleted since the edit was computed (expected version ${expectedVersion}). Re-read the file with hashline_read and retry.`;
    }
    throw err;
  }
  const actualVersion = computeFileVersion(canonicalizeFileText(raw).content);
  if (expectedVersion === null) {
    return `File ${filePath} now exists but was expected to be created (found version ${actualVersion}). Re-read the file with hashline_read and retry.`;
  }
  if (actualVersion !== expectedVersion) {
    return `File version mismatch for ${filePath}: expected ${expectedVersion}, got ${actualVersion}. The file changed while the edit was being computed. Re-read the file with hashline_read to get the current version, then retry.`;
  }
  return null;
}

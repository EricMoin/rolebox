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
 * Batch write, executed in three passes (D1):
 *
 *   RESOLVE — compute resolveWriteTarget for every entry up front.
 *   STAGE   — write temp files for every non-inPlace entry only; NO in-place
 *             writes yet, so a staging failure leaves ZERO user-visible writes.
 *   COMMIT  — in ORIGINAL batch order, rename each staged temp / writeFile each
 *             in-place member.
 *
 * NOT a cross-file transaction. Each individual rename is atomic on the same
 * filesystem, but the batch as a whole is best-effort: a failure or crash
 * during COMMIT leaves earlier files updated and later files untouched — there
 * is no rollback of already-committed renames. "No partial updates" does not
 * hold across the commit phase. A failure during STAGE, by contrast, leaves
 * every file unmodified (nothing is committed until all temps are staged).
 *
 * Failures are reported as a structured BatchWriteError carrying the list of
 * filePaths whose content landed (`written`), the failing entry's filePath
 * (`failed`), and which phase failed (`phase`).
 *
 * D16: every entry resolves its write target exactly like atomicWriteFile —
 * symlinks are replaced at the link target, hardlinked files (nlink > 1) are
 * written in place. In-place members are committed during COMMIT (in batch
 * order), not during STAGE.
 */
export class BatchWriteError extends Error {
  /** filePaths whose content landed (temp renamed or in-place written) before the failure. */
  readonly written: string[];
  /** the failing entry's filePath. */
  readonly failed: string;
  /** which pass the failure occurred in. */
  readonly phase: "staging" | "commit";

  constructor(opts: { written: string[]; failed: string; phase: "staging" | "commit"; cause: unknown }) {
    const causeMsg = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    const writtenList = opts.written.length > 0 ? opts.written.join(", ") : "none";
    super(
      `atomicWriteBatch ${opts.phase} phase failed on "${opts.failed}": ${causeMsg} (written: ${writtenList}).`
    );
    this.name = "BatchWriteError";
    this.written = opts.written;
    this.failed = opts.failed;
    this.phase = opts.phase;
  }
}

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

  // RESOLVE: compute the write target for every entry before touching disk.
  const resolved: Array<{ filePath: string; content: string; target: string; inPlace: boolean }> = [];
  for (const { filePath, content } of writes) {
    const { target, inPlace } = await resolveWriteTarget(filePath);
    resolved.push({ filePath, content, target, inPlace });
  }

  // STAGE: write temp files for non-inPlace entries only. In-place members are
  // deliberately deferred to COMMIT so a staging failure leaves zero writes.
  const temps: string[] = [];
  const staged = new Map<string, { tmp: string; target: string }>();
  for (const entry of resolved) {
    if (entry.inPlace) continue;
    const tmpPath = join(dirname(entry.target), `.${randomBytes(8).toString("hex")}.tmp`);
    temps.push(tmpPath);
    try {
      await writeFile(tmpPath, entry.content, "utf-8");
    } catch (error) {
      await cleanupTemps(temps);
      throw new BatchWriteError({ written: [], failed: entry.filePath, phase: "staging", cause: error });
    }
    staged.set(entry.filePath, { tmp: tmpPath, target: entry.target });
  }

  // COMMIT: in original batch order — rename staged temp / writeFile in-place.
  const written: string[] = [];
  for (const entry of resolved) {
    try {
      if (entry.inPlace) {
        // Hardlink: write through to the shared inode (non-atomic, but the only
        // way to keep both names observing the edit).
        await writeFile(entry.target, entry.content, "utf-8");
      } else {
        const s = staged.get(entry.filePath)!;
        await rename(s.tmp, s.target); // atomic on same filesystem
      }
      written.push(entry.filePath);
    } catch (error) {
      await cleanupTemps(temps);
      throw new BatchWriteError({ written, failed: entry.filePath, phase: "commit", cause: error });
    }
  }
}

/** Unlink staged temp files, ignoring cleanup errors (renamed temps are gone). */
async function cleanupTemps(temps: string[]): Promise<void> {
  for (const tmp of temps) {
    try { await unlink(tmp); } catch { /* ignore cleanup errors */ }
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
    // D6: non-ENOENT read failures (e.g. EISDIR when the file was replaced by a
    // directory, EACCES) carry no path in Bun's own message. Wrap with the path
    // so the caller can tell WHICH file failed.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Pre-write re-check failed for ${filePath}: ${msg}. Re-read the file with hashline_read and retry.`);
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

import { writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";

/**
 * Write content to a file atomically.
 * Writes to a temp file first, then renames to the target path.
 * This ensures the file is never in a partially-written state.
 * If the process crashes between write and rename, the original file is intact.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath); // atomic on same filesystem
  } catch (error) {
    // Clean up temp file if anything went wrong
    try { await unlink(tmpPath); } catch { /* ignore cleanup errors */ }
    throw error;
  }
}

/**
 * Batch atomic write: write all files to temp first, then rename all.
 * If any write fails, clean up all temps — no partial updates.
 */
export async function atomicWriteBatch(writes: Array<{ filePath: string; content: string }>): Promise<void> {
  const temps: string[] = [];
  try {
    for (const { filePath, content } of writes) {
      const tmpPath = join(dirname(filePath), `.${randomBytes(8).toString("hex")}.tmp`);
      await writeFile(tmpPath, content, "utf-8");
      temps.push(tmpPath);
    }
    // All temps written successfully — now rename all
    for (let i = 0; i < temps.length; i++) {
      await rename(temps[i], writes[i].filePath);
    }
  } catch (error) {
    // Clean up any remaining temps (already-renamed files are kept)
    for (const tmp of temps) {
      try { await unlink(tmp); } catch { /* ignore cleanup errors */ }
    }
    throw error;
  }
}

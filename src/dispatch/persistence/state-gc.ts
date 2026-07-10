import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("state-gc");

/** Default retention period: 7 days */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove expired dispatch state files from the given directory.
 *
 * Scans for files matching `dispatch-*.json` and `dispatch-*.json.lock`,
 * removing any whose mtime exceeds the retention period.
 *
 * This function is designed to be called fire-and-forget at startup.
 * It never throws — all errors are logged as warnings.
 *
 * @param stateDir  Absolute path to the state directory
 * @param retentionMs  How long to keep files (default: 7 days)
 * @returns Number of files removed
 */
export async function cleanExpiredState(
  stateDir: string,
  retentionMs?: number,
): Promise<{ removed: number }> {
  const retention = retentionMs ?? getRetentionFromEnv() ?? DEFAULT_RETENTION_MS;
  const cutoff = Date.now() - retention;
  let removed = 0;

  try {
    const entries = await readdir(stateDir);
    const dispatchFiles = entries.filter(
      (f) => f.startsWith("dispatch-") && (f.endsWith(".json") || f.endsWith(".json.lock")),
    );

    for (const file of dispatchFiles) {
      try {
        const filePath = join(stateDir, file);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
          removed++;
        }
      } catch (err) {
        // Individual file failure — skip and continue
        log.warn("GC: failed to process file", { file, error: String(err) });
      }
    }

    if (removed > 0) {
      log.info("GC: cleaned expired state files", { removed, total: dispatchFiles.length, stateDir });
    }
  } catch (err) {
    // Directory not found or permission error — not fatal
    log.warn("GC: could not scan state directory", { stateDir, error: String(err) });
  }

  return { removed };
}

/**
 * Read retention period from environment variable.
 * ROLEBOX_STATE_RETENTION_DAYS accepts a positive number (days).
 */
function getRetentionFromEnv(): number | undefined {
  const raw = process.env.ROLEBOX_STATE_RETENTION_DAYS;
  if (raw === undefined || raw === "") return undefined;
  const days = Number(raw);
  if (Number.isNaN(days) || days <= 0) return undefined;
  return days * 24 * 60 * 60 * 1000;
}

import { writeFileSync, readFileSync, mkdirSync, unlinkSync, renameSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const RESULT_FENCE = "result";
export const DEFAULT_MAX_RESULT_CHARS = 16_000;

export interface ExtractResult {
  result: string;
  hadFence: boolean;
}

export interface WindowOpts {
  maxChars: number;
  offset?: number;
  limit?: number;
  tail?: boolean;
}

export interface WindowResult {
  text: string;
  truncated: boolean;
  totalChars: number;
  returnedChars: number;
  nextOffset?: number;
}

export interface EnvelopeOpts {
  truncated: boolean;
  returnedChars: number;
  totalChars: number;
  nextOffset?: number;
  spilledFile?: string;
}

export function extractResultBlock(fullText: string): ExtractResult {
  const lines = fullText.split("\n");
  let inFence = false;
  let fenceContent: string[] = [];
  let lastFenceContent: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence && line.trim() === "```result") {
      inFence = true;
      fenceContent = [];
    } else if (inFence && line.trim() === "```") {
      lastFenceContent = fenceContent.join("\n");
      inFence = false;
    } else if (inFence) {
      fenceContent.push(line);
    }
  }

  if (lastFenceContent !== null) {
    return { result: lastFenceContent, hadFence: true };
  }
  return { result: fullText, hadFence: false };
}

export function applyWindow(text: string, opts: WindowOpts): WindowResult {
  if (opts.tail) {
    const start = Math.max(0, text.length - opts.maxChars);
    const result = text.slice(start);
    return {
      text: result,
      truncated: result.length < text.length,
      totalChars: text.length,
      returnedChars: result.length,
    };
  }

  const offset = opts.offset ?? 0;
  const limit = Math.min(opts.limit ?? opts.maxChars, opts.maxChars);

  if (offset >= text.length) {
    return {
      text: "",
      truncated: false,
      totalChars: 0,
      returnedChars: 0,
    };
  }

  const totalFromOffset = text.length - offset;
  const result = text.slice(offset, offset + limit);
  const truncated = result.length < totalFromOffset;

  return {
    text: result,
    truncated,
    totalChars: totalFromOffset,
    returnedChars: result.length,
    nextOffset: truncated ? offset + result.length : undefined,
  };
}

export function spillToFile(taskId: string, fullText: string, dir: string): string {
  const resultsDir = join(dir, ".rolebox", "state", "results");
  mkdirSync(resultsDir, { recursive: true });

  const target = join(resultsDir, `${taskId}.txt`);
  const tmp = target + ".tmp";

  writeFileSync(tmp, fullText, "utf-8");
  try {
    unlinkSync(target);
  } catch {}
  renameSync(tmp, target);

  return target;
}

export function formatResultEnvelope(opts: EnvelopeOpts): string {
  const parts: string[] = [];

  parts.push(`[result ${opts.returnedChars}/${opts.totalChars} chars]`);

  if (opts.truncated) {
    parts.push(`(truncated)`);
  }

  if (opts.nextOffset !== undefined) {
    parts.push(`next_offset=${opts.nextOffset}`);
  }

  if (opts.spilledFile) {
    parts.push(`file=${opts.spilledFile}`);
    parts.push(`use offset/limit or read the file`);
  }

  return parts.join(" ");
}

/**
 * Read a window from a sidecar file by CHARACTER offset and limit.
 *
 * `offset` and `limit` follow the `applyWindow` contract: both are character
 * counts (UTF-16 code units), never byte offsets. The file is read in full
 * and sliced by character, so multi-byte UTF-8 content (CJK, emoji, etc.)
 * is never split mid-sequence: returned windows are always precise
 * contiguous character slices with no replacement characters.
 *
 * @param sidecarPath - Absolute path to the sidecar file
 * @param offset - Character offset to start reading
 * @param limit - Maximum number of characters to return
 * @returns The windowed substring, or `null` if file is missing (ENOENT)
 */
export function readSidecarWindow(
  sidecarPath: string,
  offset: number,
  limit: number,
): string | null {
  try {
    if (!existsSync(sidecarPath)) return null;

    const fullText = readFileSync(sidecarPath, "utf-8");

    if (offset >= fullText.length) return "";

    return fullText.slice(offset, offset + limit);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read the last N characters from a sidecar file (tail mode).
 *
 * `tailChars` is a character count (UTF-16 code units), never a byte count.
 * The file is read in full and sliced by character, so multi-byte UTF-8
 * content (CJK, emoji, etc.) is never split mid-sequence and the result is
 * always exactly `tailChars` characters when the file is long enough.
 *
 * @param sidecarPath - Absolute path to the sidecar file
 * @param tailChars - Number of characters to read from the end
 * @returns The last N characters, or `null` if file is missing
 */
export function readSidecarTail(
  sidecarPath: string,
  tailChars: number,
): string | null {
  try {
    if (!existsSync(sidecarPath)) return null;

    const fullText = readFileSync(sidecarPath, "utf-8");

    if (tailChars >= fullText.length) return fullText;

    return fullText.slice(fullText.length - tailChars);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Apply windowing (offset/limit or tail) directly from a sidecar file.
 * Falls back to returning `null` when the sidecar file is missing.
 *
 * This is the sidecar-aware variant of `applyWindow`.  The sidecar stores
 * the full session text; `totalChars` comes from `MaterializedResultRef.totalChars`.
 * `offset`, `limit`, `maxChars`, and `nextOffset` all follow the character
 * (UTF-16 code unit) contract of `applyWindow` — multi-byte UTF-8 content is
 * sliced precisely, never by byte.
 *
 * @param sidecarPath - Absolute path to the sidecar file
 * @param opts - Windowing options (offset, limit, tail, maxChars)
 * @param totalChars - Total character count of the materialized text
 * @returns A WindowResult, or `null` if the sidecar file is missing
 */
export function applySidecarWindow(
  sidecarPath: string,
  opts: WindowOpts,
  totalChars: number,
): WindowResult | null {
  try {
    if (opts.tail) {
      const tailText = readSidecarTail(sidecarPath, opts.maxChars);
      if (tailText === null) return null;
      return {
        text: tailText,
        truncated: tailText.length < totalChars,
        totalChars,
        returnedChars: tailText.length,
      };
    }

    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? opts.maxChars, opts.maxChars);

    const windowText = readSidecarWindow(sidecarPath, offset, limit);
    if (windowText === null) return null;

    const totalFromOffset = Math.max(0, totalChars - offset);
    const truncated = windowText.length < totalFromOffset;

    return {
      text: windowText,
      truncated,
      totalChars: totalFromOffset,
      returnedChars: windowText.length,
      nextOffset: truncated ? offset + windowText.length : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Check whether a sidecar file exists on disk.
 */
export function resultSidecarExists(sidecarPath: string): boolean {
  return existsSync(sidecarPath);
}

/**
 * Build the filesystem path for a result sidecar file.
 */
export function resultSidecarPath(taskId: string, dir: string): string {
  return join(dir, ".rolebox", "state", "results", `${taskId}.txt`);
}

/**
 * Write result text to a sidecar file atomically.
 * Reuses the atomic-write pattern (`.tmp` + `unlinkSync` + `renameSync`).
 * Creates parent directories as needed.
 * Returns the absolute path to the written file.
 */
export function writeResultSidecar(taskId: string, fullText: string, dir: string): string {
  return spillToFile(taskId, fullText, dir);
}

/**
 * Read result text from a sidecar file.
 * Returns `null` when the file does not exist (ENOENT) — never throws for missing files.
 */
export function readResultSidecar(sidecarPath: string): string | null {
  try {
    return readFileSync(sidecarPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

// ── Orphan sidecar cleanup ──────────────────────────────────────────

/**
 * Default retention period for orphan sidecar result files (24 hours).
 * Sidecar files are eligible for cleanup when the owning DispatchTask no longer
 * exists and the file's mtime is older than this threshold.
 */
export const ORPHAN_SIDECAR_RETENTION_MS = 86_400_000; // 24 hours

/**
 * Scan the result sidecar directory and delete orphan files — sidecar files
 * whose corresponding DispatchTask no longer exists and whose mtime exceeds
 * the retention threshold.
 *
 * @param dir          Workspace directory (containing .rolebox/state/results/)
 * @param knownTasks   Known active task IDs (from the in-memory tasks map).
 *                     Files for unknown task IDs are eligible for deletion.
 * @param retentionMs  Retention period in ms (defaults to 24h)
 * @returns            Number of orphan files cleaned
 */
export function cleanupOrphanSidecars(
  dir: string,
  knownTasks: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  retentionMs: number = ORPHAN_SIDECAR_RETENTION_MS,
): number {
  const resultsDir = join(dir, ".rolebox", "state", "results");
  let files: string[];
  try {
    files = readdirSync(resultsDir);
  } catch {
    // Directory does not exist — nothing to clean
    return 0;
  }

  const now = Date.now();
  let cleaned = 0;

  for (const file of files) {
    if (!file.endsWith(".txt")) continue;

    // Extract taskId from filename (e.g., "task-abc.txt" -> "task-abc")
    const taskId = file.slice(0, -4);

    // Skip if the task is still active
    if (knownTasks instanceof Map) {
      if (knownTasks.has(taskId)) continue;
    } else {
      if ((knownTasks as ReadonlySet<string>).has(taskId)) continue;
    }

    const filePath = join(resultsDir, file);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      // File vanished since readdir — skip
      continue;
    }

    if (now - mtimeMs > retentionMs) {
      try {
        unlinkSync(filePath);
        cleaned++;
      } catch {
        // Ignore race conditions
      }
    }
  }

  return cleaned;
}

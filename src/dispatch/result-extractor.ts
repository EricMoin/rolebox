import { writeFileSync, readFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
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
  const resultsDir = join(dir, "state", "results");
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
 * Build the filesystem path for a result sidecar file.
 */
export function resultSidecarPath(taskId: string, dir: string): string {
  return join(dir, "state", "results", `${taskId}.txt`);
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

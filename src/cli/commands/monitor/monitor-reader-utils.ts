import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── Shared utility functions ─────────────────────────────────────────

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Try to read and parse a JSON file. Returns null when the file does not
 * exist or cannot be parsed. Never throws.
 */
export function tryReadJson(filePath: string): unknown | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") return null;
    const message =
      err instanceof SyntaxError
        ? `Malformed JSON in ${filePath}: ${err.message}`
        : `Failed to read ${filePath}: ${(err as Error).message}`;
    console.warn(`[monitor-reader] ${message}`);
    return null;
  }
}

/**
 * List all state files in `stateDir` that start with `prefix` and end with
 * `.json`. Returns an empty array when the directory does not exist.
 */
export function listStateFiles(stateDir: string, prefix: string): string[] {
  try {
    return readdirSync(stateDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => join(stateDir, f));
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") return [];
    console.warn(`[monitor-reader] Failed to list ${stateDir}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * List all NDJSON state files in `stateDir` that start with `prefix` and end
 * with `.ndjson`. Returns an empty array when the directory does not exist.
 */
export function listNDJSONFiles(stateDir: string, prefix: string): string[] {
  try {
    return readdirSync(stateDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".ndjson"))
      .map((f) => join(stateDir, f));
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") return [];
    console.warn(`[monitor-reader] Failed to list ${stateDir}: ${(err as Error).message}`);
    return [];
  }
}

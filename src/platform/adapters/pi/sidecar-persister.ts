/**
 * Pi Sidecar Persister — append-only JSONL persistence for Pi child
 * process session events.
 *
 * Each parsed JSON event from the Pi CLI is appended to a sidecar file
 * at `.rolebox/pi-sessions/{sessionId}.jsonl`. On recovery, these files
 * are scanned and replayed to reconstruct in-memory session state.
 *
 * The notify-dedup file is also stored in the same directory for
 * persistent deduplication of parent notifications across restarts.
 *
 * @module
 */

import {
  appendFile,
  readFile,
  unlink,
  mkdir,
  writeFile,
} from "node:fs/promises";
import {
  readdirSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, extname, basename } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

const SIDECAR_DIR_NAME = ".rolebox/pi-sessions";
const NOTIFY_DEDUP_FILE = "notify-dedup.json";

// ── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the sidecar directory path.
 * Uses process.cwd()/.rolebox/pi-sessions by default.
 */
export function getSidecarDir(): string {
  return join(process.cwd(), SIDECAR_DIR_NAME);
}

/**
 * Resolve the sidecar file path for a given session ID.
 */
export function getSidecarPath(sessionId: string): string {
  return join(getSidecarDir(), `${sessionId}.jsonl`);
}

/**
 * Resolve the notify-dedup file path.
 */
export function getNotifyDedupPath(): string {
  return join(getSidecarDir(), NOTIFY_DEDUP_FILE);
}

// ── Directories ─────────────────────────────────────────────────────────────

/**
 * Ensure the sidecar directory exists.
 */
async function ensureSidecarDir(): Promise<void> {
  const dir = getSidecarDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Ensure the sidecar directory exists synchronously.
 */
function ensureSidecarDirSync(): void {
  const dir = getSidecarDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Append / Read / Cleanup ─────────────────────────────────────────────────

/**
 * Append a single JSON event to the session sidecar file.
 * Creates the directory and file if needed. Best-effort — never throws.
 */
export async function appendEvent(
  sessionId: string,
  event: unknown,
): Promise<void> {
  try {
    await ensureSidecarDir();
    const line = JSON.stringify(event) + "\n";
    await appendFile(getSidecarPath(sessionId), line, "utf-8");
  } catch {
    // Best-effort persistence — logging is left to the caller.
  }
}

/**
 * Read all JSON lines from a session sidecar file.
 * Returns an array of parsed JSON objects, or null if the file does not exist.
 * Corrupt lines are skipped.
 */
export async function readSession(
  sessionId: string,
): Promise<unknown[] | null> {
  const filePath = getSidecarPath(sessionId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const events: unknown[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Corrupt line — skip and continue.
      }
    }
    return events;
  } catch {
    return null;
  }
}

/**
 * Delete the sidecar file for a session. Best-effort — never throws.
 */
export async function cleanup(sessionId: string): Promise<void> {
  try {
    await unlink(getSidecarPath(sessionId));
  } catch {
    // File may not exist or may already be cleaned up.
  }
}

// ── Orphan scanning ─────────────────────────────────────────────────────────

/**
 * Scan the sidecar directory for orphaned session sidecar files.
 * Returns an array of session IDs (filename without .jsonl extension),
 * excluding the notify-dedup file.
 */
export function scanOrphanedSessions(): string[] {
  const dir = getSidecarDir();
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const sessions: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === NOTIFY_DEDUP_FILE) continue;
    if (extname(entry.name) !== ".jsonl") continue;
    sessions.push(basename(entry.name, ".jsonl"));
  }
  return sessions;
}

// ── Notification dedup persistence ──────────────────────────────────────────

/**
 * Load the notification dedup set from disk.
 * Returns an empty Set if the file does not exist or is corrupt.
 */
export function loadNotifyDedup(): Set<string> {
  const filePath = getNotifyDedupPath();
  if (!existsSync(filePath)) return new Set();

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return new Set(data.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // Corrupt file — return empty Set.
  }
  return new Set();
}

/**
 * Persist the notification dedup set to disk.
 * Best-effort — never throws.
 */
export async function persistNotifyDedup(set: Set<string>): Promise<void> {
  try {
    await ensureSidecarDir();
    await writeFile(getNotifyDedupPath(), JSON.stringify([...set]), "utf-8");
  } catch {
    // Best-effort persistence.
  }
}

/**
 * Synchronously persist the notification dedup set to disk.
 * Used in process exit handlers where async operations may not complete.
 */
export function persistNotifyDedupSync(set: Set<string>): void {
  try {
    ensureSidecarDirSync();
    writeFileSync(getNotifyDedupPath(), JSON.stringify([...set]), "utf-8");
  } catch {
    // Best-effort persistence.
  }
}

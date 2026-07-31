import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createSubLogger } from "../logger.ts";
import { acquireStateLock } from "../dispatch/concurrency/state-lock.ts";
import { stateDirFor } from "../utils/state-paths.ts";

const log = createSubLogger("recovery:startup-check");

/**
 * Known state file version range. Any version field outside 1–99 is treated
 * as unrecognised and the file is quarantined. This is intentionally broad
 * to span dispatch, metrics, and graph stores without coupling to each
 * store's exact version enum.
 */
const KNOWN_VERSION_MIN = 1;
const KNOWN_VERSION_MAX = 99;

// ── Quarantine ──────────────────────────────────────────────────────────────

/**
 * Read a state file and validate its structure.
 *
 * - **Invalid JSON** → quarantined
 * - **Missing or non‑integer `version`** → quarantined
 * - **Version outside 1‑99** → quarantined
 * - **Valid file** → returned as‑is
 * - **File does not exist (ENOENT)** → `null` (not corrupt, not quarantined)
 *
 * @param filePath – Absolute path to the state file.
 * @param reason   – Human‑readable context for the log warning.
 * @returns `filePath` on success, `null` if quarantined or missing.
 */
export function quarantineCorruptFile(filePath: string, reason: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return null; // File does not exist — not corrupt
    }
    return doQuarantine(filePath, `read error: ${(err as Error).message} (${reason})`);
  }

  // Try to parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return doQuarantine(filePath, `invalid JSON (${reason})`);
  }

  // Must be an object
  if (typeof parsed !== "object" || parsed === null) {
    return doQuarantine(filePath, `not a JSON object (${reason})`);
  }

  const obj = parsed as Record<string, unknown>;

  // Must have a numeric integer version field
  if (obj.version === undefined || typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
    return doQuarantine(filePath, `missing or non-integer version field (${reason})`);
  }

  // Must be within known range
  if (obj.version < KNOWN_VERSION_MIN || obj.version > KNOWN_VERSION_MAX) {
    return doQuarantine(filePath, `unrecognised version ${obj.version} (${reason})`);
  }

  return filePath;
}

/**
 * Move a corrupt file to the quarantine directory.
 *
 * Target: `{parentDir}/quarantine/{filename}.{ISO‑timestamp}.corrupt`
 *
 * @returns Always `null` so callers can `return doQuarantine(...)`.
 */
function doQuarantine(filePath: string, reason: string): null {
  const quarantineDir = join(dirname(filePath), "quarantine");
  mkdirSync(quarantineDir, { recursive: true });

  // ISO-like timestamp safe for filenames (no colons)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = basename(filePath) ?? "unknown";
  const dest = join(quarantineDir, `${baseName}.${timestamp}.corrupt`);

  try {
    renameSync(filePath, dest);
    log.warn(`Quarantined corrupt state file`, { reason, from: filePath, to: dest });
  } catch (err) {
    log.error(`Failed to quarantine corrupt state file`, { reason, from: filePath, error: err });
  }
  return null;
}

// ── Orphaned tmp cleanup ────────────────────────────────────────────────────

/**
 * Scan `dir` for orphaned `.tmp` files left by interrupted atomic writes and
 * delete each one. Logs every deletion at `warn` level.
 *
 * If `dir` does not exist, the call is a silent no‑op.
 */
export function orphanTmpCleanup(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // Directory does not exist — nothing to clean
  }

  let removed = 0;
  for (const entry of entries) {
    if (entry.endsWith(".tmp")) {
      const fullPath = join(dir, entry);
      try {
        rmSync(fullPath, { force: true });
        log.warn(`Removed orphaned tmp file`, { path: fullPath });
        removed++;
      } catch (err) {
        log.warn(`Failed to remove orphaned tmp file`, { path: fullPath, error: err });
      }
    }
  }
  return removed;
}

// ── Stale lock breaking ─────────────────────────────────────────────────────

/**
 * Scan the `.rolebox/state/` directory for state (`.json`) files and
 * acquire‑then‑immediately‑release the lock for each.
 *
 * Because {@link acquireStateLock} already detects stale locks (dead PID and
 * overwrites them), this is sufficient to break any leftover locks from a
 * previous crash or unclean shutdown. Locks held by live processes are left
 * untouched.
 *
 * If the state directory does not exist yet, the call is a silent no‑op.
 */
export function breakStaleLocks(): number {
  const stateDir = stateDirFor(process.cwd());

  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return 0; // Directory does not exist — nothing to break
  }

  let broken = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const statePath = join(stateDir, entry);
    try {
      const lock = acquireStateLock(statePath);
      if (lock.ok) {
        log.info(`Acquired (and released) lock for ${entry} — stale lock was broken`);
        lock.release();
        broken++;
      }
      // !lock.ok → lock held by a live process; leave it alone
    } catch (err) {
      log.warn(`Error checking lock for ${entry}`, err);
    }
  }
  return broken;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

// ── StartupHealth and StartupChecker ─────────────────────────────────────────

export interface StartupHealth {
  /** true when no state files were corrupted */
  healthy: boolean;
  /** Filenames of state files that were quarantined */
  quarantined: string[];
  /** Number of stale/abandoned locks that were broken */
  staleLocksBroken: number;
  /** Number of orphaned .tmp files cleaned up */
  orphanTmpsRemoved: number;
  /** Human-readable warning messages collected during the check */
  warnings: string[];
}

/**
 * Glob‑like patterns for known state files that StartupChecker scans.
 * Any `.json` file matching one of these prefixes is considered a known state
 * file and will be validated. Files that do not match are ignored.
 */
const STATE_FILE_PATTERNS: ReadonlyArray<(name: string) => boolean> = [
  (n) => n.startsWith("loops-") && n.endsWith(".json"),
  (n) => n.startsWith("fnstate-") && n.endsWith(".json"),
  (n) => n.startsWith("dispatch-tasks-") && n.endsWith(".json"),
  (n) => n.startsWith("metrics-") && n.endsWith(".json"),
];

function isKnownStateFile(name: string): boolean {
  return STATE_FILE_PATTERNS.some((match) => match(name));
}

/**
 * Run startup consistency checks on known state files and the workspace.
 *
 * Scans `stateDir` for known state file patterns, validates each via
 * {@link quarantineCorruptFile}, cleans orphaned `.tmp` files from `dir`,
 * and breaks stale/abandoned locks.
 */
export class StartupChecker {
  static checkAll(dir: string, stateDir: string): StartupHealth {
    const warnings: string[] = [];
    const quarantined: string[] = [];

    // 1. Scan and validate known state files
    let entries: string[];
    try {
      entries = readdirSync(stateDir);
    } catch {
      entries = [];
    }

    for (const entry of entries.filter(isKnownStateFile)) {
      const fullPath = join(stateDir, entry);
      const result = quarantineCorruptFile(fullPath, "startup-check");
      if (result === null) {
        // null means quarantined or ENOENT (race). Check if original path exists.
        try {
          if (!existsSync(fullPath)) {
            quarantined.push(entry);
          }
        } catch {
          // Permission error — treat conservatively
        }
      } else {
        log.debug("State file validated", { file: entry });
      }
    }

    for (const q of quarantined) {
      warnings.push(`Quarantined corrupt state file: ${q}`);
    }

    // 2. Clean up orphaned .tmp files
    const orphanTmpsRemoved = orphanTmpCleanup(dir);
    if (orphanTmpsRemoved > 0) {
      warnings.push(`Cleaned up ${orphanTmpsRemoved} orphaned tmp file(s)`);
    }

    // 3. Break stale locks
    const staleLocksBroken = breakStaleLocks();
    if (staleLocksBroken > 0) {
      warnings.push(`Broke ${staleLocksBroken} stale lock(s)`);
    }

    return {
      healthy: quarantined.length === 0,
      quarantined,
      staleLocksBroken,
      orphanTmpsRemoved,
      warnings,
    };
  }
}

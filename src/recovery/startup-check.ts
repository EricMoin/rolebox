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
  return quarantineIfInvalid(filePath, reason, true);
}

/**
 * Read a *versionless* state file (e.g. `recovery-*.json`) and validate only
 * that it is a JSON‑parseable object. No `version` field is required, so a file
 * with a different shape is not treated as corrupt.
 *
 * - **Invalid JSON** → quarantined
 * - **Not a JSON object (primitive / null)** → quarantined
 * - **Any JSON object** → returned as‑is (no version check)
 * - **File does not exist (ENOENT)** → `null` (not corrupt, not quarantined)
 *
 * @param filePath – Absolute path to the state file.
 * @param reason   – Human‑readable context for the log warning.
 * @returns `filePath` on success, `null` if quarantined or missing.
 */
export function quarantineVersionlessFile(filePath: string, reason: string): string | null {
  return quarantineIfInvalid(filePath, reason, false);
}

/**
 * Shared quarantine logic for both version-gated and versionless state files.
 *
 * @param requireVersion – When `true`, a missing / non‑integer / out‑of‑range
 *                         `version` field causes quarantine. When `false`, any
 *                         JSON object is accepted regardless of shape.
 */
function quarantineIfInvalid(
  filePath: string,
  reason: string,
  requireVersion: boolean,
): string | null {
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

  if (requireVersion) {
    const obj = parsed as Record<string, unknown>;

    // Must have a numeric integer version field
    if (obj.version === undefined || typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
      return doQuarantine(filePath, `missing or non-integer version field (${reason})`);
    }

    // Must be within known range
    if (obj.version < KNOWN_VERSION_MIN || obj.version > KNOWN_VERSION_MAX) {
      return doQuarantine(filePath, `unrecognised version ${obj.version} (${reason})`);
    }
  }

  return filePath;
}

/**
 * Move a corrupt file to the quarantine directory.
 *
 * Target: `{parentDir}/quarantine/{filename}.{ISO‑timestamp}.corrupt`
 *
 * Total function — never throws. If the quarantine directory cannot be created
 * or the rename fails, it falls back to an outright `rmSync` of the corrupt
 * file so startup is never wedged.
 *
 * @returns Always `null` so callers can `return doQuarantine(...)`.
 */
function doQuarantine(filePath: string, reason: string): null {
  const quarantineDir = join(dirname(filePath), "quarantine");

  // mkdirSync can throw (permission denied, read-only FS, disk full). Fall back
  // to outright removal so a corrupt file can never wedge startup.
  try {
    mkdirSync(quarantineDir, { recursive: true });
  } catch (err) {
    log.warn(`Quarantine dir creation failed; removing corrupt file instead`, {
      reason,
      from: filePath,
      error: (err as Error).message,
    });
    try {
      rmSync(filePath, { force: true });
    } catch (rmErr) {
      log.error(`Failed to remove corrupt state file`, { reason, from: filePath, error: rmErr });
    }
    return null;
  }

  // ISO-like timestamp safe for filenames (no colons)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = basename(filePath) ?? "unknown";
  const dest = join(quarantineDir, `${baseName}.${timestamp}.corrupt`);

  try {
    renameSync(filePath, dest);
    log.warn(`Quarantined corrupt state file`, { reason, from: filePath, to: dest });
  } catch (err) {
    // Rename failed (cross-device move / permission issue) — fall back to
    // outright removal so the corrupt file cannot wedge startup.
    log.warn(`Quarantine rename failed; removing corrupt file instead`, {
      reason,
      from: filePath,
      error: err,
    });
    try {
      rmSync(filePath, { force: true });
    } catch (rmErr) {
      log.error(`Failed to remove corrupt state file`, { reason, from: filePath, error: rmErr });
    }
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
 * Scan the given state directory for stale locks and break them.
 *
 * Two complementary passes:
 *
 * 1. **Direct `*.lock` scan** — read each lock file and delete it when its
 *    recorded PID is dead (ESRCH) or the file is unparseable. This also
 *    catches orphan lock files whose paired `*.json` no longer exists.
 * 2. **Acquire‑then‑release each state (`*.json`)** — {@link acquireStateLock}
 *    reclaims any lock whose holder is dead or whose age exceeds the stale
 *    timeout, and the immediate `release()` deletes the reclaimed lock file.
 *    Only locks that already existed on disk are counted, so creating and
 *    deleting a fresh lock for an otherwise unlocked file does not inflate the
 *    count (the direct scan in pass 1 already handled the dead‑PID cases).
 *
 * Locks held by live processes are left untouched.
 *
 * @param stateDir – Absolute path to the `.rolebox/state/` directory. Passed
 *                   explicitly so callers control which workspace is checked.
 * @returns The number of stale locks broken.
 */
export function breakStaleLocks(stateDir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return 0; // Directory does not exist — nothing to break
  }

  let broken = 0;

  // Pass 1: delete leftover *.lock files whose recorded PID is dead (or that
  // are unreadable — a corrupt lock is definitionally stale).
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const lockFile = join(stateDir, entry);
    const pid = readLockPid(lockFile);
    if (pid === null || pidIsAlive(pid) === false) {
      try {
        rmSync(lockFile, { force: true });
        log.info(`Removed stale lock file ${entry} (${pid === null ? "unreadable" : `dead pid ${pid}`})`);
        broken++;
      } catch (err) {
        log.warn(`Failed to remove stale lock file ${entry}`, err);
      }
    }
    // pid alive / unverifiable → leave the lock alone
  }

  // Pass 2: acquire-then-release the lock for each state (*.json) file.
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const lockFile = join(stateDir, entry + ".lock");
    // If no lock existed before this call, acquiring would just create (then
    // release would delete) a fresh lock — that is not a stale lock, so skip it
    // to avoid inflating the count. Pass 1 already removed any dead-PID lock.
    if (!existsSync(lockFile)) continue;

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

/**
 * Read the `pid` field from a lock file. Returns `null` when the file is
 * missing, unreadable, or does not carry a numeric `pid`.
 */
function readLockPid(lockFile: string): number | null {
  try {
    const raw = readFileSync(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number"
    ) {
      return (parsed as Record<string, unknown>).pid as number;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe whether a PID is alive. Total function (never throws): returns `true`
 * (alive), `false` (definitively dead — ESRCH), or `null` (unverifiable — a
 * non‑ESRCH errno such as EPERM from a recycled/restricted PID).
 */
function pidIsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    return null;
  }
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
 * Filename predicates for **version‑gated** known state files. Any `.json`
 * file matching one of these prefixes is validated by
 * {@link quarantineCorruptFile}, which requires a valid `version` field.
 *
 * Every store that writes these files persists an integer `version` field:
 * - `loops-`        → LoopStore
 * - `fnstate-`      → function runtime store
 * - `dispatch-`     → TaskStore (task-store.ts:258, `dispatch-{dirHash}.json`)
 * - `metrics-`      → metrics persister
 * - `engine-`       → per-graph engine state (engine-persistence.ts:480)
 * - `collaboration-`→ collaboration store (collaboration-store.ts:129)
 * - `budget-`       → budget tracker (budget-tracker.ts:281)
 */
const VERSION_GATED_STATE_FILE_PATTERNS: ReadonlyArray<(name: string) => boolean> = [
  (n) => n.startsWith("loops-") && n.endsWith(".json"),
  (n) => n.startsWith("fnstate-") && n.endsWith(".json"),
  (n) => n.startsWith("dispatch-") && n.endsWith(".json"),
  (n) => n.startsWith("metrics-") && n.endsWith(".json"),
  (n) => n.startsWith("engine-") && n.endsWith(".json"),
  (n) => n.startsWith("collaboration-") && n.endsWith(".json"),
  (n) => n.startsWith("budget-") && n.endsWith(".json"),
];

/**
 * Filename predicates for **versionless** known state files. `recovery-*.json`
 * (RecoveryStateStore, state.ts:60) carries no `version` field, so it is
 * validated by {@link quarantineVersionlessFile} — JSON‑parseable object only.
 */
const VERSIONLESS_STATE_FILE_PATTERNS: ReadonlyArray<(name: string) => boolean> = [
  (n) => n.startsWith("recovery-") && n.endsWith(".json"),
];

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

    // 1. Scan and validate known state files. Version-gated prefixes require a
    //    valid `version` field; versionless prefixes (recovery-) only require a
    //    JSON-parseable object.
    let entries: string[];
    try {
      entries = readdirSync(stateDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const fullPath = join(stateDir, entry);
      let kept: boolean;
      if (VERSIONLESS_STATE_FILE_PATTERNS.some((match) => match(entry))) {
        kept = quarantineVersionlessFile(fullPath, "startup-check") !== null;
      } else if (VERSION_GATED_STATE_FILE_PATTERNS.some((match) => match(entry))) {
        kept = quarantineCorruptFile(fullPath, "startup-check") !== null;
      } else {
        continue; // Unknown filename — not a known state file, ignore.
      }

      if (!kept) {
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

    // 2. Clean up orphaned .tmp files in both the workspace dir and the state
    //    dir (atomic writes stage their temp files next to the state file).
    const orphanTmpsRemoved = orphanTmpCleanup(stateDir) + orphanTmpCleanup(dir);
    if (orphanTmpsRemoved > 0) {
      warnings.push(`Cleaned up ${orphanTmpsRemoved} orphaned tmp file(s)`);
    }

    // 3. Break stale locks in the state dir
    const staleLocksBroken = breakStaleLocks(stateDir);
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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createSubLogger } from "../../logger.ts";
import { atomicWriteSync } from "../../function/fs-util.ts";

const log = createSubLogger("state-lock");

interface LockData {
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
}

/** Default stale lock timeout: 5 minutes (300,000 ms). */
export const StaleLockTimeoutMs = 300_000;

interface LockResult {
  ok: boolean;
  heldByPid?: number;
  release(): void;
}

function lockPath(statePath: string): string {
  return statePath + ".lock";
}

function readLockFile(path: string): LockData | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number" &&
      typeof (parsed as Record<string, unknown>).startedAt === "number"
    ) {
      return parsed as LockData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe whether a PID is alive.
 *
 * Returns `true` (alive), `false` (definitively dead — ESRCH), or `null`
 * (unverifiable — the kill syscall failed with a non-ESRCH error such as EPERM
 * from a recycled PID now owned by another user, or a restricted process).
 * This function is total: it never rethrows, so lock acquisition can never
 * wedge startup on an unexpected errno.
 */
function pidAlive(pid: number): boolean | null {
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
    // Non-ESRCH errno (EPERM, EINVAL, etc.): PID state cannot be verified.
    // Fall through to the staleness check rather than throwing.
    return null;
  }
}

function writeNewLock(path: string): LockData {
  const data: LockData = { pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() };
  atomicWriteSync(path, JSON.stringify(data));
  return data;
}

function releaseLock(path: string, ownedPid: number, ownedStartedAt: number): void {
  const existing = readLockFile(path);
  if (
    existing &&
    existing.pid === ownedPid &&
    existing.startedAt === ownedStartedAt
  ) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export function acquireStateLock(statePath: string): LockResult {
  const lp = lockPath(statePath);

  if (!existsSync(lp)) {
    const data = writeNewLock(lp);
    return {
      ok: true,
      release: () => releaseLock(lp, data.pid, data.startedAt),
    };
  }

  const existing = readLockFile(lp);
  if (!existing) {
    const data = writeNewLock(lp);
    return {
      ok: true,
      release: () => releaseLock(lp, data.pid, data.startedAt),
    };
  }

  // Reclaim only when the PID is definitively dead. If pidAlive is unverifiable
  // (null) or throws unexpectedly, we do NOT reclaim here — we fall through to
  // the staleness check below, so a recycled/restricted PID can never wedge
  // startup by blocking the definitive-dead path.
  let pidIsDead = false;
  try {
    pidIsDead = pidAlive(existing.pid) === false;
  } catch {
    // Defensive: pidAlive is total, but guard against any unexpected throw so
    // acquireStateLock itself remains a total, never-throw function.
    pidIsDead = false;
  }
  if (pidIsDead) {
    const data = writeNewLock(lp);
    return {
      ok: true,
      release: () => releaseLock(lp, data.pid, data.startedAt),
    };
  }

  // Stale lock recovery: pid alive or unverifiable, but lock age exceeds timeout
  if (Date.now() - existing.startedAt > StaleLockTimeoutMs) {
    log.warn(`Stale lock reclaimed: "${statePath}" held by pid ${existing.pid} for >${StaleLockTimeoutMs}ms`);
    const data = writeNewLock(lp);
    return {
      ok: true,
      release: () => releaseLock(lp, data.pid, data.startedAt),
    };
  }

  log.warn(`Lock contention: "${statePath}" held by pid ${existing.pid} since ${new Date(existing.startedAt).toISOString()}`);
  return {
    ok: false,
    heldByPid: existing.pid,
    release: () => {},
  };
}

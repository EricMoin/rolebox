import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createSubLogger } from "../../logger.ts";

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

function pidAlive(pid: number): boolean {
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
    throw err;
  }
}

function writeNewLock(path: string): LockData {
  const data: LockData = { pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() };
  writeFileSync(path, JSON.stringify(data), "utf-8");
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

  if (!pidAlive(existing.pid)) {
    const data = writeNewLock(lp);
    return {
      ok: true,
      release: () => releaseLock(lp, data.pid, data.startedAt),
    };
  }

  // Stale lock recovery: pid alive but lock age exceeds timeout
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

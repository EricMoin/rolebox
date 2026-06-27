import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

interface LockData {
  pid: number;
  startedAt: number;
}

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
  const data: LockData = { pid: process.pid, startedAt: Date.now() };
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

  return {
    ok: false,
    heldByPid: existing.pid,
    release: () => {},
  };
}

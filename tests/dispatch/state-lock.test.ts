import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireStateLock } from "../../src/dispatch/state-lock";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  dirs.length = 0;
});

function makePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "state-lock-test-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

describe("acquireStateLock", () => {
  it("acquires lock on first call — ok:true, release unlinks", () => {
    const path = makePath();
    const lock = acquireStateLock(path);
    expect(lock.ok).toBe(true);
    expect(lock.heldByPid).toBeUndefined();
    expect(existsSync(path + ".lock")).toBe(true);

    // Verify lock file contents
    const raw = readFileSync(path + ".lock", "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.startedAt).toBe("number");

    // Release
    lock.release();
    expect(existsSync(path + ".lock")).toBe(false);
  });

  it("second acquire on same path with live pid returns ok:false", () => {
    const path = makePath();
    const lock1 = acquireStateLock(path);
    expect(lock1.ok).toBe(true);

    const lock2 = acquireStateLock(path);
    expect(lock2.ok).toBe(false);
    expect(lock2.heldByPid).toBe(process.pid);

    lock1.release();
    // lock2.release() should be safe (no-op on non-owned lock)
  });

  it("stale lock takeover: dead pid lock is reclaimed", () => {
    const path = makePath();

    // Write a lock file with a dead pid (99999 is unlikely to exist)
    const lockFile = path + ".lock";
    writeFileSync(lockFile, JSON.stringify({ pid: 99999, startedAt: Date.now() }), "utf-8");

    const lock = acquireStateLock(path);
    expect(lock.ok).toBe(true);

    // Verify new lock file has our pid
    const raw = readFileSync(lockFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);

    lock.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("release is idempotent — calling twice does not throw", () => {
    const path = makePath();
    const lock = acquireStateLock(path);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("release is safe on non-owned lock", () => {
    const path = makePath();
    const lock1 = acquireStateLock(path);
    const lock2 = acquireStateLock(path);
    expect(lock2.ok).toBe(false);
    // release on a non-owned lock should not unlink the real lock
    expect(() => lock2.release()).not.toThrow();
    expect(existsSync(path + ".lock")).toBe(true);
    lock1.release();
  });

  it("corrupt lock file is treated as absent — fresh acquire succeeds", () => {
    const path = makePath();
    // Write garbage
    writeFileSync(path + ".lock", "not-json", "utf-8");

    const lock = acquireStateLock(path);
    expect(lock.ok).toBe(true);

    // Verify fresh lock file
    const raw = readFileSync(path + ".lock", "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);

    lock.release();
  });
});

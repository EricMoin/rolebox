import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  acquirePathLock,
  acquirePathLocks,
  normalizeLockKey,
  withPathLock,
  withPathLocks,
} from "../../src/hashline/path-lock.ts";

// ── normalizeLockKey ───────────────────────────────────────────────

describe("normalizeLockKey", () => {
  it("resolves relative paths and .. segments", () => {
    const expected = resolve("./a.txt");
    const fold = process.platform === "darwin" || process.platform === "win32";
    expect(normalizeLockKey("./a.txt")).toBe(fold ? expected.toLowerCase() : expected);
    expect(normalizeLockKey("dir/../a.txt")).toBe(fold ? resolve("a.txt").toLowerCase() : resolve("a.txt"));
  });

  it("folds case on darwin/win32 (case-insensitive platforms), keeps it on POSIX", () => {
    const upper = normalizeLockKey("/tmp/HashLineTest.txt");
    const lower = normalizeLockKey("/tmp/hashlinetest.txt");
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(upper).toBe(lower);
    } else {
      expect(upper).not.toBe(lower);
    }
  });
});

// ── acquirePathLock / withPathLock ────────────────────────────────

describe("acquirePathLock", () => {
  it("serializes same-key acquisitions in FIFO order", async () => {
    const order: string[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    let signalEntered: () => void = () => {};
    const entered = new Promise<void>((res) => {
      signalEntered = res;
    });

    const first = withPathLock("/tmp/fifo-a.txt", async () => {
      order.push("first:start");
      signalEntered();
      await gate;
      order.push("first:end");
    });

    // Deterministic: wait until the first holder is inside the critical section.
    await entered;

    const second = withPathLock("/tmp/fifo-a.txt", async () => {
      order.push("second");
    });

    // The second must not run while the first holds the lock.
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseGate();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not block acquisitions on a different key", async () => {
    const lockA = await acquirePathLock("/tmp/key-a.txt");
    const lockB = await acquirePathLock("/tmp/key-b.txt");
    lockB.release();
    lockA.release();
    // If distinct keys shared a queue, the second acquire would never resolve
    // and this test would time out (framework default, no sleep coordination).
  });

  it("release is idempotent — N releases hand off to the next waiter exactly once", async () => {
    const lock1 = await acquirePathLock("/tmp/idem-a.txt");
    const order: string[] = [];
    const two = acquirePathLock("/tmp/idem-a.txt").then((l) => {
      order.push("two");
      l.release();
    });
    const three = acquirePathLock("/tmp/idem-a.txt").then((l) => {
      order.push("three");
      l.release();
    });

    lock1.release();
    lock1.release(); // no-op
    lock1.release(); // no-op
    await Promise.all([two, three]);
    expect(order).toEqual(["two", "three"]);
  });

  it("withPathLock releases the lock when the guarded function throws", async () => {
    await expect(
      withPathLock("/tmp/throw-a.txt", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The lock must be released — a new acquisition proceeds without hanging.
    const next = await acquirePathLock("/tmp/throw-a.txt");
    next.release();
  });

  it("manual acquire/release still hands off after a simulated error in the held section", async () => {
    const lock = await acquirePathLock("/tmp/held-error.txt");
    try {
      throw new Error("simulated");
    } catch {
      // simulated failure inside the held section
    }
    lock.release();
    const next = await acquirePathLock("/tmp/held-error.txt");
    next.release();
  });
});

// ── acquirePathLocks / withPathLocks ──────────────────────────────

describe("acquirePathLocks", () => {
  it("acquires multiple paths and releases them all", async () => {
    const lock = await acquirePathLocks(["/tmp/multi-a.txt", "/tmp/multi-b.txt", "/tmp/multi-c.txt"]);
    lock.release();
    lock.release(); // idempotent
    // All three keys must be free again.
    const a = await acquirePathLock("/tmp/multi-a.txt");
    const b = await acquirePathLock("/tmp/multi-b.txt");
    const c = await acquirePathLock("/tmp/multi-c.txt");
    a.release();
    b.release();
    c.release();
  });

  it("deduplicates duplicate keys so it cannot self-deadlock", async () => {
    const lock = await acquirePathLocks(["/tmp/dup-key.txt", "/tmp/dup-key.txt", "./tmp/dup-key.txt"]);
    lock.release();
    // A fresh acquisition on the same key must succeed (no leaked held lock).
    const next = await acquirePathLock("/tmp/dup-key.txt");
    next.release();
  });

  it("acquires overlapping batches in sorted order without deadlock (A,B vs B,A)", async () => {
    // Batch 1 in reversed order, batch 2 in forward order. Sorted acquisition
    // makes both contend on the same global order, so batch 2 waits for batch 1.
    const lock1 = await acquirePathLocks(["/tmp/ol-b.txt", "/tmp/ol-a.txt"]);

    let batch2Entered = false;
    const batch2 = acquirePathLocks(["/tmp/ol-a.txt", "/tmp/ol-b.txt"]).then((lock2) => {
      batch2Entered = true;
      lock2.release();
    });

    // batch2 cannot enter while batch1 holds both keys.
    await Promise.resolve();
    expect(batch2Entered).toBe(false);

    lock1.release();
    await batch2;
    expect(batch2Entered).toBe(true);
  });

  it("withPathLocks releases every lock when the guarded function throws", async () => {
    await expect(
      withPathLocks(["/tmp/multi-err-a.txt", "/tmp/multi-err-b.txt"], async () => {
        throw new Error("batch boom");
      }),
    ).rejects.toThrow("batch boom");

    // Both keys must be free again.
    const a = await acquirePathLock("/tmp/multi-err-a.txt");
    const b = await acquirePathLock("/tmp/multi-err-b.txt");
    a.release();
    b.release();
  });
});

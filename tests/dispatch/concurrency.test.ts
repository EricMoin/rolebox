import { describe, it, expect } from "bun:test";
import { ConcurrencyManager } from "../../src/dispatch/concurrency.ts";

describe("ConcurrencyManager", () => {
  it("acquire within limit resolves immediately", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      const r = cm.acquireBackground("test");
      expect(r.outcome).toBe("acquired");
    }
    expect(cm.getActiveCount("test")).toBe(5);
  });

  it("acquire at limit blocks", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }
    const r = cm.acquireBackground("test");
    expect(r.outcome).toBe("queued");
    if (r.outcome !== "queued") throw new Error("expected queued");
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), 100),
    );
    await expect(Promise.race([r.promise, timeout])).rejects.toThrow(
      "timed out",
    );
  });

  it("release unblocks waiting acquire", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }
    const r = cm.acquireBackground("test");
    expect(r.outcome).toBe("queued");
    if (r.outcome !== "queued") throw new Error("expected queued");
    cm.release("test");
    await expect(r.promise).resolves.toBeUndefined();
  });

  it("different keys are independent", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("a");
    }
    const r = cm.acquireBackground("b");
    expect(r.outcome).toBe("acquired");
  });

  it("getActiveCount returns correct value", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    expect(cm.getActiveCount("test")).toBe(0);
    cm.acquireBackground("test");
    expect(cm.getActiveCount("test")).toBe(1);
    cm.acquireBackground("test");
    expect(cm.getActiveCount("test")).toBe(2);
    cm.acquireBackground("test");
    expect(cm.getActiveCount("test")).toBe(3);
    cm.release("test");
    expect(cm.getActiveCount("test")).toBe(2);
  });

  it("release when nothing held is safe", () => {
    const cm = new ConcurrencyManager(5);

    // Release on a key that was never touched
    expect(() => cm.release("never-used")).not.toThrow();

    // Double-release on a fresh key
    cm.release("also-fresh");
    cm.release("also-fresh");
    expect(cm.getActiveCount("also-fresh")).toBe(0);
  });

  it("release with active=0 and no waiters returns to 0", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    cm.acquireBackground("test");
    cm.release("test");
    cm.release("test");
    expect(cm.getActiveCount("test")).toBe(0);
  });

  it("double-release amplification prevented — cancelled waiter handling", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }
    expect(cm.getActiveCount("test")).toBe(5);
    const h1 = cm.acquireCancelable("test");
    const h2 = cm.acquireCancelable("test");
    cm.release("test");
    await h1.promise;
    expect(cm.getActiveCount("test")).toBe(5);
    cm.release("test");
    await h2.promise;
    expect(cm.getActiveCount("test")).toBe(5);
  });

  it("forceOccupyBackground clamps to limit and returns actual count", () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    expect(cm.forceOccupyBackground("k", 10)).toBe(5);
    expect(cm.getActiveCount("k")).toBe(5);
    expect(cm.getLimit("k")).toBe(5);
    expect(cm.forceOccupyBackground("k", 3)).toBe(0);
    expect(cm.getActiveCount("k")).toBe(5);
  });

  it("cancelAcquire prevents cancelled waiter from being served", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }
    const { cancel } = cm.acquireCancelable("test");
    cancel();
    cm.release("test");
    expect(cm.getActiveCount("test")).toBe(4);
  });

  it("idempotent cancel", async () => {
    const cm = new ConcurrencyManager(5, 10, 0);
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }
    const { cancel } = cm.acquireCancelable("test");
    expect(() => cancel()).not.toThrow();
    expect(() => cancel()).not.toThrow();
    const h2 = cm.acquireCancelable("test");
    cm.release("test");
    await h2.promise;
    expect(() => h2.cancel()).not.toThrow();
  });

  // ── T8: reserved sync lane ────────────────────────────────────

  it("acquireBackground within background limit resolves immediately", async () => {
    const cm = new ConcurrencyManager(5, 10, 1);
    for (let i = 0; i < 4; i++) {
      const r = cm.acquireBackground("test");
      expect(r.outcome).toBe("acquired");
    }
    expect(cm.getActiveCount("test")).toBe(4);
  });

  it("acquireBackground at background limit blocks", async () => {
    const cm = new ConcurrencyManager(5, 10, 1);
    for (let i = 0; i < 4; i++) {
      cm.acquireBackground("test");
    }
    expect(cm.getActiveCount("test")).toBe(4);
    const r = cm.acquireBackground("test");
    expect(r.outcome).toBe("queued");
    if (r.outcome !== "queued") throw new Error("expected queued");
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), 100),
    );
    await expect(Promise.race([r.promise, timeout])).rejects.toThrow("timed out");
  });

  it("acquireSync can use reserved slot when background is full", async () => {
    const cm = new ConcurrencyManager(5, 10, 1);
    for (let i = 0; i < 4; i++) {
      cm.acquireBackground("test");
    }
    expect(cm.getActiveCount("test")).toBe(4);
    const { promise: syncP } = cm.acquireSync("test");
    await expect(syncP).resolves.toBeUndefined();
    expect(cm.getActiveCount("test")).toBe(5);
  });

  it("forceOccupyBackground clamps to limit-reserved", () => {
    const cm = new ConcurrencyManager(5, 10, 2); // limit=5, reserved=2, bgLimit=3
    expect(cm.forceOccupyBackground("k", 10)).toBe(3);
    expect(cm.getActiveCount("k")).toBe(3);
    expect(cm.forceOccupyBackground("k", 3)).toBe(0);
    expect(cm.getActiveCount("k")).toBe(3);
    // Reserved slots are still free: sync should be able to acquire
    const { promise: syncP } = cm.acquireSync("k");
    expect(cm.getActiveCount("k")).toBe(4); // sync used one reserved slot
  });

  it("getReserved returns default for unset slots", () => {
    const cm = new ConcurrencyManager(5, 10, 3);
    expect(cm.getReserved("never-used")).toBe(3);
  });

  it("setReserved updates per-slot reservation", () => {
    const cm = new ConcurrencyManager(5, 10, 1);
    cm.setReserved("test", 2);
    expect(cm.getReserved("test")).toBe(2);
  });

  it("setSlotReserved is alias for setReserved", () => {
    const cm = new ConcurrencyManager(5, 10, 1);
    cm.setSlotReserved("test", 3);
    expect(cm.getReserved("test")).toBe(3);
  });

  it("release promotes background waiters after sync acquire", async () => {
    const cm = new ConcurrencyManager(3, 10, 1);
    for (let i = 0; i < 2; i++) {
      cm.acquireBackground("test");
    }
    const { promise: syncP } = cm.acquireSync("test");
    await syncP;
    expect(cm.getActiveCount("test")).toBe(3);
    const r = cm.acquireBackground("test");
    expect(r.outcome).toBe("queued");
    if (r.outcome !== "queued") throw new Error("expected queued");
    cm.release("test");
    await r.promise;
    expect(cm.getActiveCount("test")).toBe(3);
  });

  it("acquireBackground bounded queue works like acquireCancelable", async () => {
    const cm = new ConcurrencyManager(2, 1, 1);
    const r1 = cm.acquireBackground("test");
    expect(r1.outcome).toBe("acquired");
    const r2 = cm.acquireBackground("test");
    expect(r2.outcome).toBe("queued");
    if (r2.outcome !== "queued") throw new Error("expected queued");
    const r3 = cm.acquireBackground("test");
    expect(r3.outcome).toBe("full");
    if (r3.outcome !== "full") throw new Error("expected full");
    expect(r3.error).toBeInstanceOf(Error);
    expect(r3.error.message).toContain("Queue is full");
    cm.release("test");
    await r2.promise;
    expect(cm.getActiveCount("test")).toBe(1);
  });

  // ── Discriminated outcome contract tests ────────────────────

  it("acquireBackground returns acquired when bg slot is free", async () => {
    const cm = new ConcurrencyManager(5, 10, 1);
    const result = cm.acquireBackground("test");
    expect(result.outcome).toBe("acquired");
    expect(cm.getActiveCount("test")).toBe(1);
  });

  it("acquireBackground returns queued with cancel when bg full", async () => {
    const cm = new ConcurrencyManager(5, 10, 1); // bgLimit=4
    // Fill 4 bg slots
    for (let i = 0; i < 4; i++) {
      const r = cm.acquireBackground("test");
      expect(r.outcome).toBe("acquired");
    }
    const result = cm.acquireBackground("test");
    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") throw new Error("expected queued");
    expect(result.promise).toBeInstanceOf(Promise);
    expect(typeof result.cancel).toBe("function");
    // Cancel it
    result.cancel();
    // Release one slot — should not promote the cancelled waiter
    cm.release("test");
    expect(cm.getActiveCount("test")).toBe(3); // released one, cancelled waiter didn't activate
  });

  it("acquireBackground returns full outcome when queue saturated", () => {
    const cm = new ConcurrencyManager(2, 1, 0); // limit=2, bgLimit=2, maxQueueDepth=1
    // Fill 2 bg slots
    cm.acquireBackground("test"); // acquired
    cm.acquireBackground("test"); // acquired
    // Enqueue 1 waiter (hits maxQueueDepth)
    const q = cm.acquireBackground("test");
    expect(q.outcome).toBe("queued");
    // Next should be "full"
    const r = cm.acquireBackground("test");
    expect(r.outcome).toBe("full");
    if (r.outcome !== "full") throw new Error("expected full");
    expect(r.error).toBeInstanceOf(Error);
    expect(r.error.depth).toBeGreaterThanOrEqual(0);
    expect(r.error.limit).toBeGreaterThanOrEqual(0);
    expect(r.error.retryAfter).toBeGreaterThan(0);
    // Clean up — cancel the queued one
    q.cancel!();
  });
});

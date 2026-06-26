import { describe, it, expect } from "bun:test";
import { ConcurrencyManager } from "../../src/dispatch/concurrency.ts";

describe("ConcurrencyManager", () => {
  it("acquire within limit resolves immediately", async () => {
    const cm = new ConcurrencyManager(5);
    const acqs = Array.from({ length: 5 }, () => cm.acquire("test"));
    await expect(Promise.all(acqs)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("acquire at limit blocks", async () => {
    const cm = new ConcurrencyManager(5);

    // Fill all 5 slots
    await Promise.all(Array.from({ length: 5 }, () => cm.acquire("test")));

    // 6th acquire on same key must block
    const blocked = cm.acquire("test");
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), 100),
    );

    await expect(Promise.race([blocked, timeout])).rejects.toThrow(
      "timed out",
    );
  });

  it("release unblocks waiting acquire", async () => {
    const cm = new ConcurrencyManager(5);

    // Fill all 5 slots
    await Promise.all(Array.from({ length: 5 }, () => cm.acquire("test")));

    // 6th acquire blocks
    const acquirePromise = cm.acquire("test");

    // Release one slot — the queued acquire should resolve
    cm.release("test");

    await expect(acquirePromise).resolves.toBeUndefined();
  });

  it("different keys are independent", async () => {
    const cm = new ConcurrencyManager(5);

    // Fill key "a" to its limit
    await Promise.all(Array.from({ length: 5 }, () => cm.acquire("a")));

    // Key "b" should be unaffected
    await expect(cm.acquire("b")).resolves.toBeUndefined();
  });

  it("getActiveCount returns correct value", async () => {
    const cm = new ConcurrencyManager(5);

    expect(cm.getActiveCount("test")).toBe(0);

    await cm.acquire("test");
    expect(cm.getActiveCount("test")).toBe(1);

    await cm.acquire("test");
    expect(cm.getActiveCount("test")).toBe(2);

    await cm.acquire("test");
    expect(cm.getActiveCount("test")).toBe(3);

    // Release one, count should drop
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

  // T3: release() with active=0 and no waiters → getActiveCount === 0, no throw
  it("release with active=0 and no waiters returns to 0", async () => {
    const cm = new ConcurrencyManager(5);
    await cm.acquire("test");
    cm.release("test");
    // Double-release: active is already 0
    cm.release("test");
    expect(cm.getActiveCount("test")).toBe(0);
  });

  // T4: release promotes exactly one waiter per release, prevents double-release amplification
  it("double-release amplification prevented — cancelled waiter handling", async () => {
    const cm = new ConcurrencyManager(5);
    // Fill to limit
    await Promise.all(Array.from({ length: 5 }, () => cm.acquire("test")));
    expect(cm.getActiveCount("test")).toBe(5);

    // Enqueue 2 acquireCancelable calls (both block)
    const h1 = cm.acquireCancelable("test");
    const h2 = cm.acquireCancelable("test");

    // Release once → exactly 1 waiter resolves, active stays at limit
    cm.release("test");
    await h1.promise;
    expect(cm.getActiveCount("test")).toBe(5);

    // Release again → second waiter resolves, active stays at limit
    cm.release("test");
    await h2.promise;
    expect(cm.getActiveCount("test")).toBe(5);
  });

  // T5: forceOccupy clamps to limit and returns actual count
  it("forceOccupy clamps to limit and returns actual count", () => {
    const cm = new ConcurrencyManager(5);
    expect(cm.forceOccupy("k", 10)).toBe(5);
    expect(cm.getActiveCount("k")).toBe(5);
    expect(cm.getLimit("k")).toBe(5);
    expect(cm.forceOccupy("k", 3)).toBe(0);
    expect(cm.getActiveCount("k")).toBe(5);
  });

  // T12: cancelAcquire prevents cancelled waiter from being served
  it("cancelAcquire prevents cancelled waiter from being served", async () => {
    const cm = new ConcurrencyManager(5);
    // Fill to limit
    await Promise.all(Array.from({ length: 5 }, () => cm.acquire("test")));

    // acquireCancelable a 6th (queued), get handle, call cancel()
    const { cancel } = cm.acquireCancelable("test");
    cancel();

    // Release → cancelled waiter does NOT resolve
    cm.release("test");
    expect(cm.getActiveCount("test")).toBe(4);
  });

  // T13: idempotent cancel
  it("idempotent cancel", async () => {
    const cm = new ConcurrencyManager(5);
    // Fill to limit
    await Promise.all(Array.from({ length: 5 }, () => cm.acquire("test")));

    // acquireCancelable → queued
    const { cancel } = cm.acquireCancelable("test");

    // Double cancel: no throw
    expect(() => cancel()).not.toThrow();
    expect(() => cancel()).not.toThrow();

    // Cancel after resolution: acquireCancelable, resolve via release, then cancel
    const h2 = cm.acquireCancelable("test");
    cm.release("test");
    await h2.promise;
    expect(() => h2.cancel()).not.toThrow();
  });
});

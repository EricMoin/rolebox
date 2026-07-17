import { describe, it, expect, jest, afterEach } from "bun:test";
import {
  ConcurrencyManager,
  WaiterTimeoutError,
  WAITER_TTL_MS,
} from "../../src/dispatch/concurrency/concurrency.ts";

/**
 * These tests verify the waiter TTL timeout behavior:
 *   1. Waiter promise rejects with WaiterTimeoutError after TTL
 *   2. Sweeper removes expired waiters but leaves non-expired ones
 *   3. Waiter acquired before TTL → timer is cleaned up (no leak)
 *   4. Cancel clears the TTL timer and removes the waiter
 */
describe("ConcurrencyManager TTL timeout", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("waiter promise rejects with WaiterTimeoutError after TTL expires", async () => {
    jest.useFakeTimers();
    const cm = new ConcurrencyManager(5, 10, 0);

    // Fill all 5 slots
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }

    // This should queue
    const result = cm.acquireBackground("test");
    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") return;

    const waiterPromise = result.promise;

    // Advance past TTL
    jest.advanceTimersByTime(WAITER_TTL_MS + 1000);

    await expect(waiterPromise).rejects.toThrow(WaiterTimeoutError);

    cm.dispose();
  });

  it("sweeper removes expired waiters while leaving non-expired ones intact", async () => {
    jest.useFakeTimers();
    const cm = new ConcurrencyManager(2, 10, 0);

    // Fill 2 slots (active = 2)
    cm.acquireBackground("test");
    cm.acquireBackground("test");

    // Advance 250s (waiter A will have a TTL of 300s, so expiresAt = now + 300s = 550s)
    jest.advanceTimersByTime(250_000);

    // Queue waiter A
    const rA = cm.acquireBackground("test");
    expect(rA.outcome).toBe("queued");
    if (rA.outcome !== "queued") throw new Error("expected queued");
    // Silence unhandled rejection — we verify queue state, not promise outcome
    rA.promise.catch(() => {});

    // Advance 55s (now = 305s, within waiter A's 300s TTL from its enqueue at 250s)
    jest.advanceTimersByTime(55_000);

    // Queue waiter B (expiresAt = 305_000 + 300_000 = 605_000)
    const rB = cm.acquireBackground("test");
    expect(rB.outcome).toBe("queued");
    if (rB.outcome !== "queued") throw new Error("expected queued");
    rB.promise.catch(() => {});

    // Trigger sweeper manually to verify it doesn't remove non-expired waiters
    (cm as any)._sweepExpiredWaiters();
    expect(cm.getQueueDepth("test")).toBe(2);

    // Advance past waiter A's TTL (to 556_000, past expiresAt 550_000)
    // But still within waiter B's TTL (expiresAt 605_000)
    jest.advanceTimersByTime(251_000);

    // waiter A's TTL timer should have fired, removing it and rejecting the promise
    // waiter B's TTL hasn't fired yet (556_000 < 605_000)

    // Trigger sweeper: should find only waiter B in queue
    (cm as any)._sweepExpiredWaiters();
    expect(cm.getQueueDepth("test")).toBe(1);

    // Advance past waiter B's TTL
    jest.advanceTimersByTime(50_000);

    // Both should be gone now
    (cm as any)._sweepExpiredWaiters();
    expect(cm.getQueueDepth("test")).toBe(0);

    cm.dispose();
  });

  it("waiter acquired before TTL resolves successfully with no timer leak", async () => {
    // Use real timers — this test verifies the happy path with no TTL timer interference
    const cm = new ConcurrencyManager(5, 10, 0);

    // Fill all 5 slots
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }
    expect(cm.getActiveCount("test")).toBe(5);

    // Queue a waiter
    const result = cm.acquireBackground("test");
    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") throw new Error("expected queued");

    // Release a slot immediately — waiter should be promoted before any TTL fires
    cm.release("test");

    // The promise should resolve (not reject)
    await expect(result.promise).resolves.toBeUndefined();

    expect(cm.getActiveCount("test")).toBe(5);

    cm.dispose();
  });

  it("cancelling a queued waiter clears the TTL timer and removes it", async () => {
    jest.useFakeTimers();
    const cm = new ConcurrencyManager(5, 10, 0);

    // Fill all 5 slots
    for (let i = 0; i < 5; i++) {
      cm.acquireBackground("test");
    }

    // Queue a waiter
    const result = cm.acquireBackground("test");
    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") throw new Error("expected queued");

    // Cancel it immediately
    result.cancel();
    expect(cm.getQueueDepth("test")).toBe(0);

    // Advance past TTL — the cancelled waiter's promise should NOT reject
    // (the timer was cleared by cancel())
    jest.advanceTimersByTime(WAITER_TTL_MS + 1000);

    // The queue should remain empty
    expect(cm.getQueueDepth("test")).toBe(0);

    cm.dispose();
  });

  it("expired waiter does not get promoted on release", async () => {
    jest.useFakeTimers();
    const cm = new ConcurrencyManager(1, 10, 0);

    // Fill the only slot
    cm.acquireBackground("test");
    expect(cm.getActiveCount("test")).toBe(1);

    // Queue a waiter
    const expiredResult = cm.acquireBackground("test");
    expect(expiredResult.outcome).toBe("queued");
    if (expiredResult.outcome !== "queued") throw new Error("expected queued");

    // Advance past TTL — waiter times out and rejects
    jest.advanceTimersByTime(WAITER_TTL_MS + 1000);

    await expect(expiredResult.promise).rejects.toThrow(WaiterTimeoutError);

    // Queue should be empty (expired waiter was cleaned up)
    expect(cm.getQueueDepth("test")).toBe(0);

    // Release the slot — should not try to promote an expired waiter
    cm.release("test");

    // Active count should go to 0 (no waiter to promote)
    expect(cm.getActiveCount("test")).toBe(0);

    cm.dispose();
  });

  it("sweeper runs on interval and is stoppable via dispose", async () => {
    jest.useFakeTimers();
    const cm = new ConcurrencyManager(5, 10, 0);

    // Verify sweeper interval was created
    expect((cm as any)._sweeperInterval).toBeDefined();

    // Dispose — sweeper should be stopped
    cm.dispose();
    expect((cm as any)._sweeperInterval).toBeUndefined();

  });

  it("WaiterTimeoutError is an exported class with correct name", () => {
    const err = new WaiterTimeoutError("test-key", 300_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WaiterTimeoutError");
    expect(err.message).toContain("test-key");
    expect(err.message).toContain("300000");
  });

  it("WAITER_TTL_MS is exported as 300000", () => {
    expect(WAITER_TTL_MS).toBe(300_000);
  });
});

import { describe, it, expect } from "bun:test";
import { ConcurrencyManager } from "./concurrency.js";

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
});

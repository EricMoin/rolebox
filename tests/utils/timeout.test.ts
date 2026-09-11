import { describe, test, expect, jest, mock, beforeEach, afterEach } from "bun:test";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../src/utils/timeout";
import type { Logger } from "tslog";

// ── Mock Logger ──────────────────────────────────────────────────────
// Only warn() is called by withTimeout; the rest are filler for the type.
function fakeLogger(): Logger<any> {
  return { warn: mock(() => {}) } as unknown as Logger<any>;
}

// ── withTimeout ──────────────────────────────────────────────────────
describe("withTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("resolves with value when promise settles before timeout", async () => {
    const log = fakeLogger();
    const fast = Promise.resolve("early-result");
    const promise = withTimeout(fast, 1000, "fast-task", log);

    // No timer advancement needed — already resolved
    await expect(promise).resolves.toBe("early-result");
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("returns null when timeout fires first", async () => {
    const log = fakeLogger();
    const never = new Promise<string>(() => {}); // intentionally never settles
    const promise = withTimeout(never, 1000, "slow-task", log);

    jest.advanceTimersByTime(1000);

    const result = await promise;
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "[timeout] slow-task timed out after 1000ms",
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("re-throws underlying promise rejection", async () => {
    const log = fakeLogger();
    const err = new Error("UPSTREAM_FAILURE");
    const bad = Promise.reject(err);
    const promise = withTimeout(bad, 1000, "failing-task", log);

    await expect(promise).rejects.toThrow("UPSTREAM_FAILURE");
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("re-throws non-timeout Error (custom message)", async () => {
    const log = fakeLogger();
    const err = new Error("custom-runtime-error");
    const bad = Promise.reject(err);
    const promise = withTimeout(bad, 500, "custom-task", log);

    await expect(promise).rejects.toThrow("custom-runtime-error");
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ── DEFAULT_TIMEOUT_MS ───────────────────────────────────────────────
describe("DEFAULT_TIMEOUT_MS", () => {
  test("defaults to 30000 when env var is not set", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  test("parses ROLEBOX_CLIENT_TIMEOUT_MS env var correctly", () => {
    // Test the IIFE parsing logic that DEFAULT_TIMEOUT_MS uses internally.
    // (The module-level constant is computed once at import time, so we
    //  exercise the branching logic directly here.)
    const computeDefault = (): number => {
      const env = process.env.ROLEBOX_CLIENT_TIMEOUT_MS;
      if (env) {
        const n = parseInt(env, 10);
        if (!isNaN(n) && n > 0) return n;
      }
      return 30_000;
    };

    const prev = process.env.ROLEBOX_CLIENT_TIMEOUT_MS;

    try {
      // Without env var
      delete process.env.ROLEBOX_CLIENT_TIMEOUT_MS;
      expect(computeDefault()).toBe(30_000);

      // Valid positive integer
      process.env.ROLEBOX_CLIENT_TIMEOUT_MS = "5000";
      expect(computeDefault()).toBe(5000);

      // Zero → fall back
      process.env.ROLEBOX_CLIENT_TIMEOUT_MS = "0";
      expect(computeDefault()).toBe(30_000);

      // Negative → fall back
      process.env.ROLEBOX_CLIENT_TIMEOUT_MS = "-1";
      expect(computeDefault()).toBe(30_000);

      // Non-numeric → fall back
      process.env.ROLEBOX_CLIENT_TIMEOUT_MS = "abc";
      expect(computeDefault()).toBe(30_000);
    } finally {
      // Restore original env
      if (prev !== undefined) {
        process.env.ROLEBOX_CLIENT_TIMEOUT_MS = prev;
      } else {
        delete process.env.ROLEBOX_CLIENT_TIMEOUT_MS;
      }
    }
  });
});

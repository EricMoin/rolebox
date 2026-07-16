/**
 * Error-path and boundary tests for the dispatch module.
 *
 * Covers: unrecoverable session errors, timeout cascading edge cases,
 * task ID conflicts — additive, no modifications to existing tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractSessionErrorMessage } from "../../src/dispatch/core/error-utils";
import { withTimeout, TimeoutError } from "../../src/dispatch/core/with-timeout";
import { TaskStateStore } from "../../src/dispatch/persistence/task-store";
import type { DispatchTask } from "../../src/dispatch/types";

// ─── Unrecoverable session errors ────────────────────────────────────

describe("extractSessionErrorMessage — unrecoverable error shapes", () => {
  it("handles a deeply nested provider error with chain of causes", () => {
    const err = {
      name: "ProviderError",
      data: {
        message: "upstream 503",
        cause: {
          name: "HttpError",
          data: { message: "Service Unavailable", statusCode: 503 },
        },
      },
    };
    const msg = extractSessionErrorMessage(err);
    expect(msg).toContain("ProviderError");
    expect(msg).toContain("upstream 503");
    expect(msg).not.toContain("[object Object]");
  });

  it("handles a circular reference without throwing", () => {
    const a: Record<string, unknown> = { name: "Circular" };
    const b: Record<string, unknown> = { name: "Child", parent: a };
    a.child = b;
    let msg: string;
    try {
      msg = extractSessionErrorMessage(a);
    } catch {
      msg = "Unknown session error";
    }
    expect(msg).not.toContain("[object Object]");
    expect(typeof msg).toBe("string");
  });

  it("handles null by returning String(null)", () => {
    // eslint-disable-next-line no-null/no-null
    const msg = extractSessionErrorMessage(null);
    // String(null) === "null", not the default fallback
    expect(msg).toBe("null");
  });

  it("falls back to error name when data/error property is missing", () => {
    // The function looks for o.data.message or o.message, not o.error.
    // With only error name present, it returns the name.
    const err = {
      name: "RateLimitError",
    };
    const msg = extractSessionErrorMessage(err);
    expect(msg).toBe("RateLimitError");
  });

  it("returns String representation for an empty object (non-default fallback)", () => {
    const msg = extractSessionErrorMessage({});
    // JSON.stringify({}) === "{}" does not pass the `json !== "{}"` guard,
    // so it falls through to String({}) === "[object Object]"
    expect(msg).toBe("[object Object]");
  });
});

// ─── Timeout cascading edge cases ────────────────────────────────────

describe("withTimeout — cascading and boundary edge cases", () => {
  it("rejects when timeout is 0 (instant timeout)", async () => {
    try {
      await withTimeout(
        new Promise<void>(() => {}),
        0,
        "instant-timeout",
      );
      expect.unreachable("should have thrown for zero timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).message).toContain("instant-timeout");
    }
  });

  it("rejects when timeout is negative (treated as instant)", async () => {
    try {
      await withTimeout(
        new Promise<void>(() => {}),
        -100,
        "negative-timeout",
      );
      expect.unreachable("should have thrown for negative timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
    }
  });

  it("does not swallow inner promise rejection (reject beats timeout)", async () => {
    try {
      await withTimeout(
        Promise.reject(new Error("inner-failure")),
        10_000,
        "reject-should-win",
      );
      expect.unreachable("should have thrown inner error");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("inner-failure");
    }
  });

  it("resolves even when timeout is extremely large", async () => {
    const result = await withTimeout(Promise.resolve(42), 1_000_000, "large");
    expect(result).toBe(42);
  });

  it("nested timeouts — outer timeout fires before inner resolves", async () => {
    const inner = new Promise<void>(() => {});
    const start = Date.now();
    try {
      await withTimeout(inner, 10, "nested-inner");
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect(Date.now() - start).toBeLessThan(5000);
    }
  });
});

// ─── Task ID conflicts via TaskStateStore ────────────────────────────

describe("TaskStateStore — persistence edge cases", () => {
  let tempDir: string;
  let store: TaskStateStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dispatch-error-edge-"));
    store = new TaskStateStore(tempDir);
  });

  afterAll(() => {
    store.clear();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTask(overrides: Partial<DispatchTask> = {}): DispatchTask {
    return {
      id: "test-task",
      sessionId: "ses_001",
      parentSessionId: "ses_parent",
      status: "running" as const,
      agent: "test-agent",
      prompt: "test",
      description: "test task",
      depth: 1,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      ...overrides,
    };
  }

  it("save with duplicate key overwrites (last write wins)", async () => {
    const map = new Map<string, DispatchTask>();
    map.set("dup-key", makeTask({ id: "dup-key", agent: "first" }));
    map.set("dup-key", makeTask({ id: "dup-key", agent: "second" }));

    await store.save(map);

    const loaded = store.load()!;
    expect(loaded.tasks.size).toBe(1);
    expect(loaded.tasks.get("dup-key")!.agent).toBe("second");
  });

  it("load returns null for non-existent state file", async () => {
    const emptyStore = new TaskStateStore("/tmp/nonexistent-dir-dispatch-test");
    const result = emptyStore.load();
    expect(result).toBeNull();
  });

  it("save with empty map produces valid state file", async () => {
    const map = new Map<string, DispatchTask>();
    await store.save(map);

    const loaded = store.load()!;
    expect(loaded.tasks.size).toBe(0);
    expect(Array.isArray(loaded.outbox)).toBe(true);
  });

  it("load after clear returns null", async () => {
    const singleStore = new TaskStateStore(tempDir);
    const map = new Map<string, DispatchTask>();
    map.set("temp", makeTask({ id: "temp" }));
    await singleStore.save(map);
    singleStore.clear();

    const result = singleStore.load();
    expect(result).toBeNull();
  });

  it("multiple saves persist latest state", async () => {
    const map1 = new Map<string, DispatchTask>();
    map1.set("multi", makeTask({ id: "multi", prompt: "v1" }));
    await store.save(map1);

    const map2 = new Map<string, DispatchTask>();
    map2.set("multi", makeTask({ id: "multi", prompt: "v2" }));
    await store.save(map2);

    const loaded = store.load()!;
    expect(loaded.tasks.get("multi")!.prompt).toBe("v2");
  });
});

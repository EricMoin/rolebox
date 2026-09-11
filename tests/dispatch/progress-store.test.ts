import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryProgressStore } from "../../src/dispatch/progress/progress-store.ts";
import type { ProgressEvent } from "../../src/dispatch/types.progress.ts";
import { DEFAULT_PROGRESS_TTL_MS, MAX_PROGRESS_EVENTS_PER_TASK } from "../../src/dispatch/config.ts";

/**
 * Helper: create a progress event with a given timestamp offset from now.
 */
function makeEvent(
  taskId: string,
  stage: string,
  message: string,
  offsetMs: number = 0,
  percentage?: number,
): ProgressEvent {
  const timestamp = new Date(Date.now() + offsetMs).toISOString();
  return {
    task_id: taskId,
    stage,
    message,
    timestamp,
    ...(percentage !== undefined ? { percentage } : {}),
  };
}

function makeStore(): InMemoryProgressStore {
  const dir = mkdtempSync(join(tmpdir(), "progress-store-test-"));
  return new InMemoryProgressStore(dir);
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // already cleaned up
    }
  }
  dirs.length = 0;
});

describe("InMemoryProgressStore", () => {
  describe("addProgressEvent and getProgressStream", () => {
    it("stores and retrieves events for a single task", () => {
      const store = makeStore();
      const evt = makeEvent("task_1", "research", "researching...");
      store.addProgressEvent("task_1", evt);

      const stream = store.getProgressStream("task_1");
      expect(stream).toHaveLength(1);
      expect(stream[0].stage).toBe("research");
      expect(stream[0].message).toBe("researching...");
    });

    it("returns events in chronological order", () => {
      const store = makeStore();
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "first", -2000));
      store.addProgressEvent("task_1", makeEvent("task_1", "b", "second", -1000));
      store.addProgressEvent("task_1", makeEvent("task_1", "c", "third", 0));

      const stream = store.getProgressStream("task_1");
      expect(stream).toHaveLength(3);
      expect(stream[0].message).toBe("first");
      expect(stream[1].message).toBe("second");
      expect(stream[2].message).toBe("third");
    });

    it("returns empty array for unknown task", () => {
      const store = makeStore();
      expect(store.getProgressStream("nonexistent")).toEqual([]);
    });

    it("returns a copy (not the internal array)", () => {
      const store = makeStore();
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "first"));
      const stream = store.getProgressStream("task_1");
      // Mutating the returned copy should not affect the store
      stream.push({ task_id: "injected", stage: "x", message: "x", timestamp: new Date().toISOString() });
      expect(store.getProgressStream("task_1")).toHaveLength(1);
    });
  });

  describe("since filtering", () => {
    it("returns events after a given timestamp", () => {
      const store = makeStore();
      const e1 = makeEvent("task_1", "a", "early", -5000);
      const e2 = makeEvent("task_1", "b", "middle", -2000);
      const e3 = makeEvent("task_1", "c", "late", 0);

      store.addProgressEvent("task_1", e1);
      store.addProgressEvent("task_1", e2);
      store.addProgressEvent("task_1", e3);

      // Use a timestamp between e2 and e3
      const midpoint = new Date(Date.now() - 1000).toISOString();
      const filtered = store.getProgressStream("task_1", midpoint);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].message).toBe("late");
    });

    it("returns all events when since is undefined", () => {
      const store = makeStore();
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "first"));
      store.addProgressEvent("task_1", makeEvent("task_1", "b", "second"));

      const all = store.getProgressStream("task_1", undefined);
      expect(all).toHaveLength(2);
    });

    it("excludes the exact boundary (strictly greater)", () => {
      const store = makeStore();
      const now = new Date();
      const e1: ProgressEvent = {
        task_id: "task_1",
        stage: "a",
        message: "exact",
        timestamp: now.toISOString(),
      };
      store.addProgressEvent("task_1", e1);

      const result = store.getProgressStream("task_1", now.toISOString());
      expect(result).toHaveLength(0);
    });
  });

  describe("ring buffer cap", () => {
    it("drops oldest events when exceeding MAX_PROGRESS_EVENTS_PER_TASK", () => {
      const store = makeStore();
      const overflow = MAX_PROGRESS_EVENTS_PER_TASK + 50;

      for (let i = 0; i < overflow; i++) {
        store.addProgressEvent("task_1", makeEvent("task_1", "step", `event-${i}`, i));
      }

      const stream = store.getProgressStream("task_1");
      expect(stream).toHaveLength(MAX_PROGRESS_EVENTS_PER_TASK);

      // Oldest 50 should be dropped; event-0 should not exist
      const messages = stream.map((e) => e.message);
      expect(messages[0]).toBe(`event-${50}`);
      expect(messages[messages.length - 1]).toBe(`event-${overflow - 1}`);
      expect(messages.includes("event-0")).toBe(false);
      expect(messages.includes("event-49")).toBe(false);
    });
  });

  describe("clearProgress", () => {
    it("removes all events for a task", () => {
      const store = makeStore();
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "first"));
      store.addProgressEvent("task_1", makeEvent("task_1", "b", "second"));

      store.clearProgress("task_1");
      expect(store.getProgressStream("task_1")).toEqual([]);
    });

    it("does not affect other tasks", () => {
      const store = makeStore();
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "first"));
      store.addProgressEvent("task_2", makeEvent("task_2", "b", "second"));

      store.clearProgress("task_1");
      expect(store.getProgressStream("task_1")).toEqual([]);
      expect(store.getProgressStream("task_2")).toHaveLength(1);
    });

    it("is idempotent on already-cleared task", () => {
      const store = makeStore();
      expect(() => store.clearProgress("nonexistent")).not.toThrow();
    });
  });

  describe("cleanupExpired", () => {
    it("removes events older than ttlMs", () => {
      const store = makeStore();
      const oldEvent = makeEvent("task_1", "old", "this is old", -200_000); // 200s ago
      const freshEvent = makeEvent("task_1", "fresh", "this is new", 0);

      store.addProgressEvent("task_1", oldEvent);
      store.addProgressEvent("task_1", freshEvent);

      // ttl = 100s — old event should be removed, fresh should remain
      store.cleanupExpired(100_000);

      const stream = store.getProgressStream("task_1");
      expect(stream).toHaveLength(1);
      expect(stream[0].message).toBe("this is new");
    });

    it("removes entire task entry when all events are expired", () => {
      const store = makeStore();
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "only event", -200_000));

      store.cleanupExpired(100_000);

      expect(store.getProgressStream("task_1")).toEqual([]);
      expect(store.taskCount).toBe(0);
    });

    it("uses DEFAULT_PROGRESS_TTL_MS when no argument given", () => {
      const store = makeStore();
      // Default ttl = 300s. Events within that range should survive.
      store.addProgressEvent("task_1", makeEvent("task_1", "a", "recent", -100_000));
      store.cleanupExpired();

      const stream = store.getProgressStream("task_1");
      expect(stream).toHaveLength(1);
    });
  });

  describe("task isolation", () => {
    it("multiple tasks do not interfere", () => {
      const store = makeStore();
      store.addProgressEvent("task_a", makeEvent("task_a", "a1", "alpha-1"));
      store.addProgressEvent("task_a", makeEvent("task_a", "a2", "alpha-2"));
      store.addProgressEvent("task_b", makeEvent("task_b", "b1", "beta-1"));
      store.addProgressEvent("task_c", makeEvent("task_c", "c1", "gamma-1"));

      expect(store.getProgressStream("task_a")).toHaveLength(2);
      expect(store.getProgressStream("task_b")).toHaveLength(1);
      expect(store.getProgressStream("task_c")).toHaveLength(1);
      expect(store.getProgressStream("task_d")).toEqual([]);
    });

    it("cleanupExpired on one task does not affect others", () => {
      const store = makeStore();
      store.addProgressEvent("task_a", makeEvent("task_a", "old", "old-a", -200_000));
      store.addProgressEvent("task_b", makeEvent("task_b", "fresh", "fresh-b", 0));

      store.cleanupExpired(100_000);

      expect(store.getProgressStream("task_a")).toEqual([]);
      expect(store.getProgressStream("task_b")).toHaveLength(1);
    });

    it("clearProgress on one task does not affect others", () => {
      const store = makeStore();
      store.addProgressEvent("task_a", makeEvent("task_a", "a1", "alpha"));
      store.addProgressEvent("task_b", makeEvent("task_b", "b1", "beta"));

      store.clearProgress("task_a");

      expect(store.getProgressStream("task_a")).toEqual([]);
      expect(store.getProgressStream("task_b")).toHaveLength(1);
    });
  });

  describe("disk spill (optional crash recovery)", () => {
    it("flushes events to disk sync", () => {
      const dir = mkdtempSync(join(tmpdir(), "progress-disk-test-"));
      dirs.push(dir);
      const store = new InMemoryProgressStore(dir);

      store.addProgressEvent("task_disk", makeEvent("task_disk", "write", "writing to disk"));
      store.flushSync();

      const progressDir = join(dir, ".rolebox", "state", "progress");
      const filePath = join(progressDir, "task_disk.json");
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as ProgressEvent[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].stage).toBe("write");
    });

    it("clearProgress writes empty array to disk", () => {
      const dir = mkdtempSync(join(tmpdir(), "progress-disk-clear-"));
      dirs.push(dir);
      const store = new InMemoryProgressStore(dir);

      store.addProgressEvent("task_clr", makeEvent("task_clr", "a", "before clear"));
      store.flushSync();

      store.clearProgress("task_clr");

      const progressDir = join(dir, ".rolebox", "state", "progress");
      const filePath = join(progressDir, "task_clr.json");
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as ProgressEvent[];
      expect(parsed).toEqual([]);
    });

    it("no .tmp file remains after write", () => {
      const dir = mkdtempSync(join(tmpdir(), "progress-tmp-check-"));
      dirs.push(dir);
      const store = new InMemoryProgressStore(dir);

      store.addProgressEvent("task_tmp", makeEvent("task_tmp", "x", "no temp"));
      store.flushSync();

      const progressDir = join(dir, ".rolebox", "state", "progress");
      expect(existsSync(join(progressDir, "task_tmp.json.tmp"))).toBe(false);
    });
  });

  describe("setDirectory", () => {
    it("updates the base directory for disk writes", () => {
      const dirA = mkdtempSync(join(tmpdir(), "progress-dir-a-"));
      const dirB = mkdtempSync(join(tmpdir(), "progress-dir-b-"));
      dirs.push(dirA, dirB);

      const store = new InMemoryProgressStore(dirA);
      store.addProgressEvent("task_dir", makeEvent("task_dir", "a", "in dir a"));
      store.flushSync();

      // Events were written to dirA
      expect(existsSync(join(dirA, ".rolebox", "state", "progress", "task_dir.json"))).toBe(true);

      // Change directory
      store.setDirectory(dirB);
      store.addProgressEvent("task_dir", makeEvent("task_dir", "b", "in dir b"));
      store.flushSync();

      // Now events are written to dirB
      expect(existsSync(join(dirB, ".rolebox", "state", "progress", "task_dir.json"))).toBe(true);
    });
  });

  describe("sweeper lifecycle", () => {
    it("startSweeper / stopSweeper do not throw", () => {
      const store = makeStore();
      expect(() => store.startSweeper()).not.toThrow();
      expect(() => store.stopSweeper()).not.toThrow();
    });

    it("startSweeper is idempotent", () => {
      const store = makeStore();
      store.startSweeper();
      expect(() => store.startSweeper()).not.toThrow();
      store.stopSweeper();
    });
  });
});

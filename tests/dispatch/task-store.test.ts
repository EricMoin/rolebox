import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { DispatchTask } from "../../src/dispatch/types";

let currentDataDir = "";

mock.module("../../src/cli/paths", () => ({
  getDataDir: () => currentDataDir,
}));

import { TaskStateStore } from "../../src/dispatch/task-store";

function makeTask(overrides?: Partial<DispatchTask>): DispatchTask {
  const now = new Date();
  return {
    id: "bg_test1234",
    sessionId: "ses_test",
    parentSessionId: "ses_parent",
    status: "running",
    agent: "test-agent",
    prompt: "test prompt",
    description: "test",
    startedAt: now,
    progress: { lastUpdate: now, toolCalls: 0 },
    ...overrides,
  };
}

function createTestStore(): { store: TaskStateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "task-store-test-"));
  currentDataDir = dir;
  const store = new TaskStateStore(dir);
  return { store, dir };
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  dirs.length = 0;
  currentDataDir = "";
});

function stateFilePath(dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  return join(currentDataDir || dir, "state", `dispatch-${hash}.json`);
}

describe("TaskStateStore", () => {
  describe("save() and load() round-trip", () => {
    it("persists and retrieves a single task", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask();
      const tasks = new Map([[task.id, task]]);
      await store.save(tasks);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(1);

      const t = loaded!.get(task.id);
      expect(t).toBeDefined();
      expect(t!.id).toBe(task.id);
      expect(t!.status).toBe("running");
      expect(t!.sessionId).toBe("ses_test");
      expect(t!.parentSessionId).toBe("ses_parent");
      expect(t!.agent).toBe("test-agent");
      expect(t!.prompt).toBe("test prompt");
      expect(t!.description).toBe("test");
      expect(t!.startedAt).toBeInstanceOf(Date);
      expect(t!.progress.lastUpdate).toBeInstanceOf(Date);
      expect(t!.progress.toolCalls).toBe(0);
    });

    it("persists and retrieves multiple tasks with different statuses", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task1 = makeTask({ id: "bg_001", status: "running" });
      const task2 = makeTask({ id: "bg_002", status: "completed", completedAt: new Date() });
      const task3 = makeTask({ id: "bg_003", status: "error", error: "something broke" });

      const tasks = new Map([
        [task1.id, task1],
        [task2.id, task2],
        [task3.id, task3],
      ]);
      await store.save(tasks);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(3);

      expect(loaded!.get("bg_001")!.status).toBe("running");
      expect(loaded!.get("bg_002")!.status).toBe("completed");
      expect(loaded!.get("bg_002")!.completedAt).toBeInstanceOf(Date);
      expect(loaded!.get("bg_003")!.status).toBe("error");
      expect(loaded!.get("bg_003")!.error).toBe("something broke");
    });
  });

  describe("load() with missing or empty state", () => {
    it("returns null when no file exists", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const result = store.load();
      expect(result).toBeNull();
    });
  });

  describe("multi-instance isolation", () => {
    it("two stores with different directories do not share state", async () => {
      const dirA = mkdtempSync(join(tmpdir(), "task-store-test-a-"));
      const dirB = mkdtempSync(join(tmpdir(), "task-store-test-b-"));
      dirs.push(dirA, dirB);

      currentDataDir = dirA;
      const storeA = new TaskStateStore(dirA);
      currentDataDir = dirB;
      const storeB = new TaskStateStore(dirB);

      currentDataDir = dirA;
      const taskA = makeTask({ id: "bg_only_in_a" });
      await storeA.save(new Map([[taskA.id, taskA]]));

      currentDataDir = dirA;
      expect(storeA.load()?.size).toBe(1);

      currentDataDir = dirB;
      expect(storeB.load()).toBeNull();
    });
  });

  describe("atomic write produces a valid file", () => {
    it("creates a state file with correct schema", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask();
      await store.save(new Map([[task.id, task]]));

      const path = stateFilePath(dir);
      expect(existsSync(path)).toBe(true);

      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed.version).toBe(2);
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect(parsed.tasks.length).toBe(1);

      const st = parsed.tasks[0];
      expect(typeof st.id).toBe("string");
      expect(typeof st.startedAt).toBe("string");
      expect(typeof st.progress.lastUpdate).toBe("string");
    });
  });

  describe("corrupt file handling", () => {
    it("returns null when state file contains invalid JSON", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "this is not json", "utf-8");

      const result = store.load();
      expect(result).toBeNull();
    });
  });

  describe("version mismatch handling", () => {
    it("returns null when state file has unexpected schema version", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 42, tasks: [] }), "utf-8");

      const result = store.load();
      expect(result).toBeNull();
    });
  });

  describe("v1→v2 migration", () => {
    it("loads v1 state file, auto-adds defaults, and saves as v2", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      // Write a v1 state file manually
      const v1File = {
        version: 1,
        tasks: [
          {
            id: "bg_v1task",
            sessionId: "ses_v1task",
            parentSessionId: "ses_parent",
            status: "running",
            agent: "helper",
            prompt: "work",
            description: "v1 task",
            startedAt: new Date().toISOString(),
            progress: {
              lastUpdate: new Date().toISOString(),
              toolCalls: 3,
            },
          },
        ],
      };

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(v1File), "utf-8");

      // Load — should auto-add defaults and re-save as v2
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(1);
      const t = loaded!.get("bg_v1task")!;
      expect(t.id).toBe("bg_v1task");
      expect(t.status).toBe("running");
      expect(t.progress.toolCalls).toBe(3);
      // v1→v2 defaults
      expect(t.concurrencyKey).toBe("default");
      expect(t.continuationOf).toBeUndefined();
      expect(t.messageCountAtStart).toBe(0);

      // Wait for the fire-and-forget async v1→v2 migration save to complete
      await new Promise((r) => setTimeout(r, 50));

      // Verify disk file is now v2
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(2);
      expect(parsed.tasks[0].concurrencyKey).toBe("default");
      expect(parsed.tasks[0].messageCountAtStart).toBe(0);
    });

    it("loads v1 state file with multiple tasks, all get defaults", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const v1File = {
        version: 1,
        tasks: [
          {
            id: "bg_v1a",
            sessionId: "ses_a",
            parentSessionId: "ses_parent",
            status: "running",
            agent: "a",
            prompt: "pa",
            startedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 0 },
          },
          {
            id: "bg_v1b",
            sessionId: "ses_b",
            parentSessionId: "ses_parent",
            status: "completed",
            agent: "b",
            prompt: "pb",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 5 },
          },
        ],
      };

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(v1File), "utf-8");

      const loaded = store.load();
      expect(loaded!.size).toBe(2);

      for (const t of loaded!.values()) {
        expect(t.concurrencyKey).toBe("default");
        expect(t.continuationOf).toBeUndefined();
        expect(t.messageCountAtStart).toBe(0);
      }
    });
  });

  describe("clear()", () => {
    it("deletes state file and subsequent load returns null", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask();
      await store.save(new Map([[task.id, task]]));
      expect(store.load()).not.toBeNull();

      store.clear();

      const after = store.load();
      expect(after).toBeNull();
    });

    it("is idempotent when called on a clean store", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      expect(() => store.clear()).not.toThrow();
      expect(store.load()).toBeNull();
    });
  });
});

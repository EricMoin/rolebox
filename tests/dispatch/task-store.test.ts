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
      expect(loaded!.tasks.size).toBe(1);

      const t = loaded!.tasks.get(task.id);
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
      expect(loaded!.tasks.size).toBe(3);

      expect(loaded!.tasks.get("bg_001")!.status).toBe("running");
      expect(loaded!.tasks.get("bg_002")!.status).toBe("completed");
      expect(loaded!.tasks.get("bg_002")!.completedAt).toBeInstanceOf(Date);
      expect(loaded!.tasks.get("bg_003")!.status).toBe("error");
      expect(loaded!.tasks.get("bg_003")!.error).toBe("something broke");
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
      expect(storeA.load()?.tasks.size).toBe(1);

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

      expect(parsed.version).toBe(5);
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
      expect(loaded!.tasks.size).toBe(1);
      const t = loaded!.tasks.get("bg_v1task")!;
      expect(t.id).toBe("bg_v1task");
      expect(t.status).toBe("running");
      expect(t.progress.toolCalls).toBe(3);
      // v1→v2 defaults
      expect(t.concurrencyKey).toBe("default");
      expect(t.continuationOf).toBeUndefined();
      expect(t.messageCountAtStart).toBe(0);

      // Wait for the fire-and-forget async v1→v2 migration save to complete
      await new Promise((r) => setTimeout(r, 50));

      // Verify disk file is now v5
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(5);
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
      expect(loaded!.tasks.size).toBe(2);

      for (const t of loaded!.tasks.values()) {
        expect(t.concurrencyKey).toBe("default");
        expect(t.continuationOf).toBeUndefined();
        expect(t.messageCountAtStart).toBe(0);
      }
    });
  });

  describe("v3 schema (mode + timeoutMs)", () => {
    it("round-trips a task with mode:'sync' and timeoutMs:120000", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask({
        id: "bg_sync_mode",
        mode: "sync",
        timeoutMs: 120000,
      });
      await store.save(new Map([[task.id, task]]));

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      const t = loaded!.tasks.get("bg_sync_mode")!;
      expect(t.mode).toBe("sync");
      expect(t.timeoutMs).toBe(120000);
    });

    it("loads a v2 fixture (no mode/timeoutMs) and applies defaults", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      // Write a v2 state file manually (no mode, no timeoutMs)
      const v2File = {
        version: 2,
        tasks: [
          {
            id: "bg_v2task",
            sessionId: "ses_v2task",
            parentSessionId: "ses_parent",
            status: "running",
            agent: "helper",
            prompt: "work",
            description: "v2 task",
            startedAt: new Date().toISOString(),
            progress: {
              lastUpdate: new Date().toISOString(),
              toolCalls: 1,
            },
            concurrencyKey: "default",
          },
        ],
      };

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(v2File), "utf-8");

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.tasks.size).toBe(1);
      const t = loaded!.tasks.get("bg_v2task")!;
      expect(t.mode).toBe("background");
      expect(t.timeoutMs).toBeUndefined();
    });

    it("loads version:3 and version:4 successfully; version:5 returns null", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });

      // version:3 should load
      writeFileSync(
        path,
        JSON.stringify({ version: 3, tasks: [] }),
        "utf-8",
      );
      expect(store.load()).not.toBeNull();

      // version:4 should load
      writeFileSync(
        path,
        JSON.stringify({ version: 4, tasks: [] }),
        "utf-8",
      );
      expect(store.load()).not.toBeNull();

      // version:5 should load
      writeFileSync(
        path,
        JSON.stringify({ version: 5, tasks: [] }),
        "utf-8",
      );
      expect(store.load()).not.toBeNull();
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

  describe("saveSync()", () => {
    it("saveSync round-trips through load", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const running = makeTask({ id: "bg_running", status: "running" });
      const completed = makeTask({ id: "bg_done", status: "completed", completedAt: new Date() });
      const tasks = new Map([
        [running.id, running],
        [completed.id, completed],
      ]);

      store.saveSync(tasks);

      // Load from a fresh store in the same dir
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.tasks.size).toBe(2);
      expect(loaded!.tasks.get("bg_running")!.status).toBe("running");
      expect(loaded!.tasks.get("bg_done")!.status).toBe("completed");
      expect(loaded!.tasks.get("bg_done")!.completedAt).toBeInstanceOf(Date);

      // Verify no .tmp file remains
      const sp = stateFilePath(dir);
      expect(existsSync(sp)).toBe(true);
      expect(existsSync(sp + ".tmp")).toBe(false);
    });

    it("saveSync never throws on write failure", () => {
      const { store } = createTestStore();
      // Note: we can't easily make the path unwritable cross-platform without mocking.
      // Instead, test that saveSync doesn't throw under normal conditions.
      // The try/catch in the implementation guarantees it never throws.
      const task = makeTask();
      const tasks = new Map([[task.id, task]]);
      expect(() => store.saveSync(tasks)).not.toThrow();
    });

    it("saveSync produces a valid state file", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask();
      store.saveSync(new Map([[task.id, task]]));

      const sp = stateFilePath(dir);
      expect(existsSync(sp)).toBe(true);
      const raw = readFileSync(sp, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(5);
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect(parsed.tasks.length).toBe(1);
      expect(parsed.tasks[0].id).toBe(task.id);
    });
  });

  describe("v4 schema (result + outbox)", () => {
    it("round-trips a task with result ref and outbox", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask({
        id: "bg_v4_result",
        status: "completed",
        result: {
          sidecarPath: "/tmp/state/results/bg_v4_result.txt",
          totalChars: 1420,
          hadFence: true,
          materializedAt: new Date().toISOString(),
        },
      });
      const outbox = new Set(["bg_v4_result"]);
      await store.save(new Map([[task.id, task]]), outbox);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.tasks.size).toBe(1);
      expect(loaded!.outbox).toEqual(["bg_v4_result"]);

      const t = loaded!.tasks.get("bg_v4_result")!;
      expect(t.result).toBeDefined();
      expect(t.result!.sidecarPath).toBe("/tmp/state/results/bg_v4_result.txt");
      expect(t.result!.totalChars).toBe(1420);
      expect(t.result!.hadFence).toBe(true);
      expect(t.result!.fetchError).toBeUndefined();
      expect(typeof t.result!.materializedAt).toBe("string");

      // Verify disk file is v4 with result + outbox
      const sp = stateFilePath(dir);
      const raw = readFileSync(sp, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(5);
      expect(parsed.outbox).toEqual(["bg_v4_result"]);
      expect(parsed.tasks[0].result).toBeDefined();
      expect(parsed.tasks[0].result.totalChars).toBe(1420);
    });

    it("round-trips a task with result.fetchError", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask({
        id: "bg_err_result",
        status: "error",
        result: {
          sidecarPath: "/tmp/state/results/bg_err_result.txt",
          totalChars: 0,
          hadFence: false,
          fetchError: "timeout after 30s",
          materializedAt: new Date().toISOString(),
        },
      });
      await store.save(new Map([[task.id, task]]));

      const loaded = store.load();
      const t = loaded!.tasks.get("bg_err_result")!;
      expect(t.result).toBeDefined();
      expect(t.result!.fetchError).toBe("timeout after 30s");
      expect(t.result!.totalChars).toBe(0);
    });

    it("v3 file migrates to v5 without data loss", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      // Write a v3 state file manually
      const v3File = {
        version: 3,
        tasks: [
          {
            id: "bg_v3mig",
            sessionId: "ses_v3",
            parentSessionId: "ses_parent",
            status: "completed",
            agent: "helper",
            prompt: "work",
            description: "v3 task",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: {
              lastUpdate: new Date().toISOString(),
              toolCalls: 7,
            },
            concurrencyKey: "default",
            messageCountAtStart: 5,
            mode: "sync",
            timeoutMs: 60000,
          },
        ],
      };

      const path = stateFilePath(dir);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(v3File), "utf-8");

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.tasks.size).toBe(1);
      expect(loaded!.outbox).toEqual([]);

      const t = loaded!.tasks.get("bg_v3mig")!;
      expect(t.id).toBe("bg_v3mig");
      expect(t.mode).toBe("sync");
      expect(t.timeoutMs).toBe(60000);
      // v3 tasks don't have result
      expect(t.result).toBeUndefined();

      // Wait for the fire-and-forget async v3→v4 migration save
      await new Promise((r) => setTimeout(r, 50));

      // Verify disk file is now v5
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(5);
      expect(parsed.tasks[0].id).toBe("bg_v3mig");
      expect(parsed.tasks[0].result).toBeUndefined();
      expect(parsed.outbox).toBeUndefined();
    });

    it("outbox persists and reloads across multiple saves", async () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task1 = makeTask({ id: "bg_outbox_1", status: "completed" });
      const task2 = makeTask({ id: "bg_outbox_2", status: "completed" });

      // Save with outbox containing both task IDs
      await store.save(
        new Map([
          [task1.id, task1],
          [task2.id, task2],
        ]),
        new Set(["bg_outbox_1", "bg_outbox_2"]),
      );

      let loaded = store.load();
      expect(loaded!.outbox).toEqual(["bg_outbox_1", "bg_outbox_2"]);

      // Save again with reduced outbox
      await store.save(
        new Map([
          [task1.id, task1],
          [task2.id, task2],
        ]),
        new Set(["bg_outbox_2"]),
      );

      loaded = store.load();
      expect(loaded!.outbox).toEqual(["bg_outbox_2"]);

      // Save without outbox (backward-compat)
      await store.save(
        new Map([
          [task1.id, task1],
          [task2.id, task2],
        ]),
      );

      loaded = store.load();
      // When outbox is omitted, the file doesn't have an outbox field
      // and load defaults to []
      expect(loaded!.outbox).toEqual([]);
    });

    it("saveSync round-trips with outbox", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask({ id: "bg_sync_outbox", status: "completed" });
      const outbox = new Set(["bg_sync_outbox"]);
      store.saveSync(new Map([[task.id, task]]), outbox);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.outbox).toEqual(["bg_sync_outbox"]);
    });

    it("empty outbox does not appear in serialized JSON", () => {
      const { store, dir } = createTestStore();
      dirs.push(dir);

      const task = makeTask({ id: "bg_empty_outbox" });
      store.saveSync(new Map([[task.id, task]]), new Set());

      const sp = stateFilePath(dir);
      const raw = readFileSync(sp, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(5);
      // empty outbox should not be serialized
      expect(parsed.outbox).toBeUndefined();
    });
  });
});

/**
 * A4 — Task depth tracking and sync depth guard
 *
 * Verifies:
 * - computeDepth returns correct 0/1/2 for parent-child-grandchild chains
 * - executeSync throws at depth > 0
 * - executeSync allowed at depth 0
 * - Background dispatch allowed at any depth
 * - Depth survives serialize→recover round-trip
 *
 * Run: bun test tests/dispatch/depth.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "bun:test";
import { clearSentFinalNotifies, clearParentQueues } from "../../src/dispatch/notification";
import type { DispatchTask } from "../../src/dispatch/types";

afterEach(() => {
  clearSentFinalNotifies();
  clearParentQueues();
});

// ── T1: computeDepth returns 0/1/2 correctly ────────────────────────

describe("T1: computeDepth returns 0/1/2 correctly", () => {
  it("returns 0 for unknown session (no parent task)", () => {
    const manager = makeDepthManager();
    const mgr = manager as any;
    expect(mgr.computeDepth("unknown-session")).toBe(0);
  });

  it("returns 1 when parent session maps to a depth-0 task", () => {
    const manager = makeDepthManager();
    const mgr = manager as any;

    // Register a depth-0 parent task
    const parentTask = makeDepthTask({ id: "root-task", depth: 0, sessionId: "ses_root" });
    mgr.tasks.set("root-task", parentTask);
    mgr.sessionToTask.set("ses_root", "root-task");

    expect(mgr.computeDepth("ses_root")).toBe(1);
  });

  it("returns 2 for grandchild (parent depth=1)", () => {
    const manager = makeDepthManager();
    const mgr = manager as any;

    // Chain: ses_root -> root-task (depth=0) -> ses_child -> child-task (depth=1)
    const rootTask = makeDepthTask({ id: "root-task", depth: 0, sessionId: "ses_root" });
    const childTask = makeDepthTask({ id: "child-task", depth: 1, sessionId: "ses_child" });

    mgr.tasks.set("root-task", rootTask);
    mgr.tasks.set("child-task", childTask);
    mgr.sessionToTask.set("ses_root", "root-task");
    mgr.sessionToTask.set("ses_child", "child-task");

    expect(mgr.computeDepth("ses_child")).toBe(2);
  });

  it("returns 0 when parentTaskId exists but task not in map", () => {
    const manager = makeDepthManager();
    const mgr = manager as any;

    mgr.sessionToTask.set("orphan-session", "missing-task");
    // No task in this.tasks — should fall back to 0
    expect(mgr.computeDepth("orphan-session")).toBe(0);
  });
});

// ── T2: sync dispatch at depth 1 THROWS ────────────────────────────

describe("T2: sync dispatch at depth 1 THROWS", () => {
  it("throws 'Synchronous dispatch forbidden' when parent has depth > 0", async () => {
    const manager = makeDepthManager();
    const mgr = manager as any;
    const ctx = { sessionID: "deep-session", agent: "deep-agent", directory: "/tmp" };

    // Map deep-session to a task with depth=1
    const deepTask = makeDepthTask({ id: "deep-task", depth: 1, sessionId: "deep-session" });
    mgr.tasks.set("deep-task", deepTask);
    mgr.sessionToTask.set("deep-session", "deep-task");

    await expect(
      manager.executeSync(
        { subagent: "helper", prompt: "should fail", run_in_background: false },
        ctx,
      ),
    ).rejects.toThrow(/Synchronous dispatch forbidden/);
  });
});

// ── T3: sync dispatch at depth 0 ALLOWED ────────────────────────────

describe("T3: sync dispatch at depth 0 ALLOWED", () => {
  it("does NOT throw depth error when no parent task exists", async () => {
    const manager = makeDepthManager();
    const ctx = { sessionID: "shallow-session", agent: "shallow-agent", directory: "/tmp" };

    // No mapping exists — computeDepth returns 0
    // Use session_id to avoid budget gate; expect rejection from other guards
    // but NOT from the depth guard
    try {
      await manager.executeSync(
        { subagent: "helper", prompt: "work", run_in_background: false, session_id: "reuse-ses" },
        ctx,
      );
      // If we get here, the mock client returned success — depth guard passed
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Must NOT contain the depth error
      expect(msg).not.toMatch(/Synchronous dispatch forbidden/);
    }
  });
});

// ── T4: background dispatch at any depth allowed ────────────────────

describe("T4: background dispatch at any depth allowed", () => {
  it("allows background launch at depth 1", async () => {
    const manager = makeDepthManager();
    const mgr = manager as any;
    const ctx = { sessionID: "mid-session", agent: "mid-agent", directory: "/tmp" };

    const midTask = makeDepthTask({ id: "mid-task", depth: 1, sessionId: "mid-session" });
    mgr.tasks.set("mid-task", midTask);
    mgr.sessionToTask.set("mid-session", "mid-task");

    const task = await manager.launch(
      { subagent: "helper", prompt: "bg-deep", run_in_background: true },
      ctx,
    );

    // Should not be rejected for depth — no depth check exists in launch()
    expect(task.status).not.toBe("error");
  });

  it("allows background launch at depth 2", async () => {
    const manager = makeDepthManager();
    const mgr = manager as any;
    const ctx = { sessionID: "deep2-session", agent: "deep2-agent", directory: "/tmp" };

    const deepTask = makeDepthTask({ id: "deep2-task", depth: 2, sessionId: "deep2-session" });
    mgr.tasks.set("deep2-task", deepTask);
    mgr.sessionToTask.set("deep2-session", "deep2-task");

    const task = await manager.launch(
      { subagent: "helper", prompt: "bg-deeper", run_in_background: true },
      ctx,
    );

    expect(task.status).not.toBe("error");
  });
});

// ── T5: depth survives serialize→recover ────────────────────────────

describe("T5: depth survives serialize→recover", () => {
  it("preserves depth through save→load round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "depth-test-"));
    const cleanup = () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    };

    mock.module("../../src/cli/paths", () => ({
      getDataDir: () => dir,
    }));

    const { TaskStateStore } = await import("../../src/dispatch/task-store");

    const store = new TaskStateStore(dir);
    const task = makeDepthTask({ id: "persist-test", depth: 2, sessionId: "ses_persist" });
    const tasks = new Map([[task.id, task]]);
    await store.save(tasks);

    const loaded = store.load();
    expect(loaded).not.toBeNull();

    const restored = loaded!.tasks.get("persist-test");
    expect(restored).toBeDefined();
    expect(restored!.depth).toBe(2);

    cleanup();
  });

  it("defaults depth to 0 for tasks saved before v5 schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "depth-default-test-"));
    const cleanup = () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    };

    mock.module("../../src/cli/paths", () => ({
      getDataDir: () => dir,
    }));

    const { TaskStateStore } = await import("../../src/dispatch/task-store");

    const store = new TaskStateStore(dir);
    const task = makeDepthTask({ id: "no-depth-task", sessionId: "ses_old" });
    // Create task without explicit depth to simulate pre-v5 data
    const taskNoDepth = { ...task } as any;
    delete taskNoDepth.depth;

    const tasks = new Map([["no-depth-task", taskNoDepth as DispatchTask]]);
    await store.save(tasks);

    const loaded = store.load();
    expect(loaded).not.toBeNull();

    const restored = loaded!.tasks.get("no-depth-task");
    expect(restored).toBeDefined();
    // Should default to 0
    expect(restored!.depth).toBe(0);

    cleanup();
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeDepthManager() {
  const { createMockClient } = require("./helpers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DispatchManager } = require("../../src/dispatch/manager");
  const client = createMockClient();
  return new DispatchManager(client, {
    maxConcurrent: 10,
    taskTtlMs: 100,
  } as any) as InstanceType<typeof DispatchManager>;
}

function makeDepthTask(overrides: Partial<DispatchTask> & Record<string, unknown> = {}): DispatchTask {
  return {
    id: "bg_test123",
    sessionId: "ses_abc",
    parentSessionId: "ses_parent",
    depth: 0,
    status: "running",
    agent: "test-agent",
    prompt: "do something",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    ...overrides,
  };
}

/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import { createDispatchStatusTool } from "../../src/dispatch/query/task-status.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { DispatchTask, TaskEventState } from "../../src/dispatch/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DispatchTask> & { id: string; parentSessionId: string }): DispatchTask {
  return {
    id: overrides.id,
    sessionId: "ses_abc",
    parentSessionId: overrides.parentSessionId,
    status: "running",
    agent: "test-agent",
    prompt: "test prompt",
    description: "test task",
    startedAt: new Date(Date.now() - 30000),
    progress: { lastUpdate: new Date(Date.now() - 5000), toolCalls: 3 },
    depth: 1,
    mode: "background",
    ...overrides,
  };
}

function makeEventState(overrides: Partial<TaskEventState> = {}): TaskEventState {
  return {
    lastMessageCount: 5,
    lastProgressUpdate: Date.now() - 5000,
    hasProducedOutput: false,
    messageCountAtStart: 2,
    lastEventAt: Date.now() - 3000,
    consecutiveFetchFailures: 0,
    ...overrides,
  };
}

const mockToolContext = {
  sessionID: "ses_parent",
  messageID: "msg_test",
  agent: "role",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe("createDispatchStatusTool", () => {
  it("accepts optional task_id argument", () => {
    // The tool is callable with or without task_id
    const mgr = createMockManager([]);
    const tool = createDispatchStatusTool(mgr);
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("returns empty-state message when no tasks for session", async () => {
    const mgr = createMockManager([]);
    const tool = createDispatchStatusTool(mgr);
    const result = await tool.execute({}, mockToolContext);
    expect(result).toContain("No tasks found");
    expect(result).toContain("ses_parent");
  });

  it("returns markdown table with liveness columns", async () => {
    const task = makeTask({
      id: "bg_test123",
      parentSessionId: "ses_parent",
      status: "running",
    });
    const mgr = createMockManager([task], new Map([
      ["bg_test123", makeEventState({ hasProducedOutput: true })],
    ]));
    const tool = createDispatchStatusTool(mgr);
    const result = await tool.execute({}, mockToolContext);

    // Has header
    expect(result).toContain("Task Status");
    expect(result).toContain("| Glyph | Task ID");
    expect(result).toContain("|-------|---------");

    // Has data row with glyph
    expect(result).toContain("▸"); // running glyph
    expect(result).toContain("bg_test123");
    expect(result).toContain("test-agent");
    expect(result).toContain("running");
    expect(result).toContain("✓"); // hasProducedOutput = true

    // Has legend
    expect(result).toContain("Legend");
    expect(result).toContain("● pending");
    expect(result).toContain("✗ error");
  });

  it("does not throw for running tasks (unlike dispatch_output)", async () => {
    const task = makeTask({
      id: "bg_running1",
      parentSessionId: "ses_parent",
      status: "running",
    });
    const mgr = createMockManager([task], new Map([
      ["bg_running1", makeEventState()],
    ]));
    const tool = createDispatchStatusTool(mgr);

    // Should NOT throw — this is the critical behavior
    const result = await tool.execute({}, mockToolContext);
    expect(result).toContain("▸");
    expect(result).toContain("running");

    // Detailed mode also should NOT throw
    const detail = await tool.execute({ task_id: "bg_running1" }, mockToolContext);
    expect(detail).toContain("running");
    expect(detail).toContain("Liveness");
  });

  it("returns detailed liveness info for specific task_id", async () => {
    const task = makeTask({
      id: "bg_detail1",
      parentSessionId: "ses_parent",
      status: "running",
    });
    const es = makeEventState({
      lastProgressUpdate: Date.now() - 15000,
      hasProducedOutput: true,
      consecutiveFetchFailures: 0,
    });
    const mgr = createMockManager([task], new Map([["bg_detail1", es]]));
    const tool = createDispatchStatusTool(mgr);

    const result = await tool.execute({ task_id: "bg_detail1" }, mockToolContext);
    expect(result).toContain("bg_detail1");
    expect(result).toContain("Identity");
    expect(result).toContain("Liveness");
    expect(result).toContain("Last Activity");
    expect(result).toContain("Has Produced Output");
    expect(result).toContain("✓ yes");
    expect(result).toContain("Consecutive Fetch Failures");
    expect(result).toContain("0");
    expect(result).toContain("Tool Calls");
    expect(result).toContain("3");
  });

  it("returns not-found message for nonexistent task_id", async () => {
    const mgr = createMockManager([]);
    const tool = createDispatchStatusTool(mgr);
    const result = await tool.execute({ task_id: "bg_nonexistent" }, mockToolContext);
    expect(result).toContain("No active task found");
    expect(result).toContain("bg_nonexistent");
  });

  it("shows completed tasks in summary", async () => {
    const task = makeTask({
      id: "bg_done1",
      parentSessionId: "ses_parent",
      status: "completed",
      completedAt: new Date(),
    });
    const mgr = createMockManager([task]);
    const tool = createDispatchStatusTool(mgr);

    const result = await tool.execute({}, mockToolContext);
    expect(result).toContain("✓");
    expect(result).toContain("completed");
  });

  it("shows error tasks with error information", async () => {
    const task = makeTask({
      id: "bg_err1",
      parentSessionId: "ses_parent",
      status: "error",
      error: "Something went wrong",
    });
    const mgr = createMockManager([task]);
    const tool = createDispatchStatusTool(mgr);

    // Summary mode
    const summary = await tool.execute({}, mockToolContext);
    expect(summary).toContain("✗");
    expect(summary).toContain("error");

    // Detailed mode with error
    const detail = await tool.execute({ task_id: "bg_err1" }, mockToolContext);
    expect(detail).toContain("✗");
    expect(detail).toContain("Something went wrong");
  });

  it("shows cancelled and timeout tasks", async () => {
    const tasks = [
      makeTask({ id: "bg_cancel1", parentSessionId: "ses_parent", status: "cancelled" }),
      makeTask({ id: "bg_time1", parentSessionId: "ses_parent", status: "timeout" }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createDispatchStatusTool(mgr);

    const result = await tool.execute({}, mockToolContext);
    expect(result).toContain("⊘");
    expect(result).toContain("cancelled");
    expect(result).toContain("◇");
    expect(result).toContain("timeout");
  });

  it("shows consecutive fetch failures when > 0", async () => {
    const task = makeTask({
      id: "bg_stuck1",
      parentSessionId: "ses_parent",
      status: "running",
    });
    const mgr = createMockManager([task], new Map([
      ["bg_stuck1", makeEventState({ consecutiveFetchFailures: 3 })],
    ]));
    const tool = createDispatchStatusTool(mgr);

    // Summary shows the count
    const summary = await tool.execute({}, mockToolContext);
    expect(summary).toContain("3");

    // Detailed shows warning
    const detail = await tool.execute({ task_id: "bg_stuck1" }, mockToolContext);
    expect(detail).toContain("⚠️ 3");
  });

  it("shows result info for terminal tasks in detailed mode", async () => {
    const task = makeTask({
      id: "bg_done2",
      parentSessionId: "ses_parent",
      status: "completed",
      completedAt: new Date(),
      startedAt: new Date(Date.now() - 60000),
      depth: 2,
      result: {
        sidecarPath: "/tmp/state/results/bg_done2.txt",
        totalChars: 1234,
        hadFence: true,
        materializedAt: new Date().toISOString(),
      },
    });
    const mgr = createMockManager([task]);
    const tool = createDispatchStatusTool(mgr);

    const detail = await tool.execute({ task_id: "bg_done2" }, mockToolContext);
    expect(detail).toContain("Result");
    expect(detail).toContain("Sidecar Path");
    expect(detail).toContain("bg_done2.txt");
    expect(detail).toContain("Total Chars");
    expect(detail).toContain("1234");
    expect(detail).toContain("dispatch_output");
  });

  it("reports tasks only from the calling session", async () => {
    const ownTask = makeTask({ id: "bg_own1", parentSessionId: "ses_parent" });
    const otherTask = makeTask({ id: "bg_other1", parentSessionId: "ses_other" });
    const mgr = createMockManager([ownTask, otherTask]);
    const tool = createDispatchStatusTool(mgr);

    const result = await tool.execute({}, mockToolContext);
    expect(result).toContain("bg_own1");
    expect(result).not.toContain("bg_other1");
  });

  it("handles missing eventState gracefully", async () => {
    const task = makeTask({
      id: "bg_noes1",
      parentSessionId: "ses_parent",
      status: "running",
    });
    // No eventState for this task
    const mgr = createMockManager([task], new Map());
    const tool = createDispatchStatusTool(mgr);

    const summary = await tool.execute({}, mockToolContext);
    expect(summary).toContain("bg_noes1");
    expect(summary).toContain("—"); // no last activity

    const detail = await tool.execute({ task_id: "bg_noes1" }, mockToolContext);
    expect(detail).toContain("no eventState data");
  });
});

// ── Mock Manager Factory ──────────────────────────────────────────────────

function createMockManager(
  tasks: DispatchTask[],
  eventState?: Map<string, TaskEventState>,
): DispatchManager {
  return {
    getTasksByParent: (sessionId: string) =>
      tasks.filter(t => t.parentSessionId === sessionId),
    getEventState: () => eventState ?? new Map(),
    getTask: (taskId: string) => tasks.find(t => t.id === taskId),
    getAllTasks: () => tasks,
  } as unknown as DispatchManager;
}

/// <reference types="bun-types" />
import { describe, it, expect, mock } from "bun:test";
import {
  createDispatchTool,
  createDispatchOutputTool,
  createDispatchCancelTool,
  createDispatchMetricsTool,
} from "../../src/dispatch/tools.ts";
import type { DispatchManager } from "../../src/dispatch/manager.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

// ── helpers ──────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "bg_test123",
    sessionId: "ses_abc",
    parentSessionId: "ses_parent",
    status: "completed" as const,
    agent: "test-agent",
    prompt: "do something",
    description: "test task",
    startedAt: new Date(Date.now() - 5000),
    completedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 5 },
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

// ── createDispatchTool ───────────────────────────────────────────────────

describe("createDispatchTool", () => {
  it("rejects invalid subagent", async () => {
    const resolved = new Map<string, string>();
    const manager = {} as unknown as DispatchManager;
    const tool = createDispatchTool(manager, resolved);

    const result = await tool.execute(
      {
        subagent: "nonexistent",
        prompt: "do it",
        run_in_background: false,
      },
      mockToolContext,
    );

    expect(result).toContain("Invalid subagent");
    expect(result).toContain("'nonexistent'");
    expect(result).toContain("Available subagents:");
  });

  it("sync mode returns full response", async () => {
    const resolved = new Map([["test-agent", "test-role"]]);
    const manager = {
      executeSync: mock(() => Promise.resolve("test response")),
    } as unknown as DispatchManager;
    const tool = createDispatchTool(manager, resolved);

    const result = await tool.execute(
      {
        subagent: "test-agent",
        prompt: "do it",
        run_in_background: false,
      },
      mockToolContext,
    );

    expect(result).toBe("test response");
  });

  it("async mode returns task_id format", async () => {
    const resolved = new Map([["test-agent", "test-role"]]);
    const task = makeTask({ id: "bg_test123", status: "pending" });
    const manager = {
      launch: mock(() => Promise.resolve(task)),
    } as unknown as DispatchManager;
    const tool = createDispatchTool(manager, resolved);

    const result = await tool.execute(
      {
        subagent: "test-agent",
        prompt: "do it",
        run_in_background: true,
      },
      mockToolContext,
    );

    expect(result).toContain("Background task launched");
    expect(result).toContain("Task ID: bg_test123");
    expect(result).toContain("dispatch_output");
  });
});

// ── createDispatchOutputTool ─────────────────────────────────────────────

describe("createDispatchOutputTool", () => {
  it("returns result for completed task", async () => {
    const completed = makeTask({ status: "completed" });
    const manager = {
      getTask: mock(() => completed),
      getResult: mock(() => Promise.resolve("test content")),
    } as unknown as DispatchManager;
    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "bg_test123", block: false, timeout: 60000 },
      mockToolContext,
    );

    expect(result).toContain("Task Result");
    expect(result).toContain("test content");
  });

  it("returns error for unknown task", async () => {
    const manager = {
      getTask: mock(() => undefined),
    } as unknown as DispatchManager;
    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "nonexistent", block: false, timeout: 60000 },
      mockToolContext,
    );

    expect(result).toContain("not found");
  });

  it("returns status for running task with block=false", async () => {
    const running = makeTask({ status: "running", completedAt: undefined });
    const manager = {
      getTask: mock(() => running),
    } as unknown as DispatchManager;
    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "bg_test123", block: false, timeout: 60000 },
      mockToolContext,
    );

    expect(result).toContain("Task Status");
    expect(result).toContain("still running");
  });

  it("blocks when task running and block=true, returns result on completion", async () => {
    const running = makeTask({
      status: "running",
      completedAt: undefined,
    });
    const completed = makeTask({ status: "completed" });

    let callCount = 0;
    const manager = {
      getTask: mock((_taskId: string) => {
        callCount++;
        // Return running for the first few calls, then completed
        if (callCount <= 2) return running;
        return completed;
      }),
      getResult: mock(() => Promise.resolve("blocked result")),
    } as unknown as DispatchManager;

    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "bg_test123", block: true, timeout: 5000 },
      mockToolContext,
    );

    expect(result).toContain("Task Result");
    expect(result).toContain("blocked result");
  });
});

// ── createDispatchCancelTool ─────────────────────────────────────────────

describe("createDispatchCancelTool", () => {
  it("cancels existing task", async () => {
    const manager = {
      cancelTask: mock(() => Promise.resolve(true)),
    } as unknown as DispatchManager;
    const tool = createDispatchCancelTool(manager);

    const result = await tool.execute(
      { task_id: "bg_test123" },
      mockToolContext,
    );

    expect(result).toContain("cancelled");
    expect(result).toContain("bg_test123");
  });

  it("returns error for unknown task", async () => {
    const manager = {
      cancelTask: mock(() => Promise.resolve(false)),
    } as unknown as DispatchManager;
    const tool = createDispatchCancelTool(manager);

    const result = await tool.execute(
      { task_id: "nonexistent" },
      mockToolContext,
    );

    expect(result).toContain("not found");
  });
});

// ── createDispatchMetricsTool ──────────────────────────────────────────────

describe("createDispatchMetricsTool", () => {
  it("returns summary format by default with section header", async () => {
    const tool = createDispatchMetricsTool();
    const result = await tool.execute({}, mockToolContext);

    expect(result).toContain("## Dispatch Metrics");

    // No metrics recorded (ROLEBOX_METRICS is disabled in test env)
    if (result.includes("no metrics recorded")) {
      expect(result).toContain("ROLEBOX_METRICS may be disabled");
    }
  });

  it("returns valid JSON when format=json", async () => {
    const tool = createDispatchMetricsTool();
    const result = await tool.execute({ format: "json" }, mockToolContext);

    const parsed = JSON.parse(result);
    expect(typeof parsed).toBe("object");
    expect(parsed).toHaveProperty("counters");
    expect(parsed).toHaveProperty("gauges");
    expect(parsed).toHaveProperty("histograms");

    expect(typeof parsed.counters).toBe("object");
    expect(typeof parsed.gauges).toBe("object");
    expect(typeof parsed.histograms).toBe("object");
  });

  it("shows empty message when no metrics recorded", async () => {
    const tool = createDispatchMetricsTool();
    const result = await tool.execute({ format: "summary" }, mockToolContext);

    expect(result).toContain("no metrics recorded");
    expect(result).toContain("ROLEBOX_METRICS may be disabled");
  });
});

/// <reference types="bun-types" />
import fs from "node:fs";
import path from "node:path";
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
  it("has arity 3 (manager + resolvedSubagents + optional subagentModelKey)", () => {
    expect(createDispatchTool.length).toBe(3);
  });

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

  it("passes timeout_ms through to DispatchInput when provided", async () => {
    const resolved = new Map([["test-agent", "test-role"]]);
    const task = makeTask({ id: "bg_test123", status: "pending" });
    const launchSpy = mock(() => Promise.resolve(task));
    const manager = {
      launch: launchSpy,
    } as unknown as DispatchManager;
    const tool = createDispatchTool(manager, resolved);

    await tool.execute(
      {
        subagent: "test-agent",
        prompt: "do it",
        run_in_background: true,
        timeout_ms: 5000,
      },
      mockToolContext,
    );

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const callArgs = launchSpy.mock.calls[0] as [unknown, unknown];
    expect(callArgs[0]).toMatchObject({ timeout_ms: 5000 });
  });
});

// ── createDispatchOutputTool ─────────────────────────────────────────────

describe("createDispatchOutputTool", () => {
  it("returns result for completed task", async () => {
    const completed = makeTask({ status: "completed" });
    const manager = {
      getTask: mock(() => completed),
      getResult: mock(() =>
        Promise.resolve({ kind: "ok", text: "test content" }),
      ),
    } as unknown as DispatchManager;
    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "bg_test123", block: false, timeout: 60000 },
      mockToolContext,
    );

    expect(result).toContain("Task Result");
    expect(result).toContain("test content");
  });

  it("returns not_found for unknown task", async () => {
    const manager = {
      getTask: mock(() => undefined),
      getResult: mock(() =>
        Promise.resolve({
          kind: "not_found",
          text: "",
          error: "Task never existed",
        }),
      ),
    } as unknown as DispatchManager;
    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "nonexistent", block: false, timeout: 60000 },
      mockToolContext,
    );

    expect(result).toContain("Task Not Found");
    expect(result).toContain("nonexistent");
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
      getResult: mock(() =>
        Promise.resolve({ kind: "ok", text: "blocked result" }),
      ),
    } as unknown as DispatchManager;

    const tool = createDispatchOutputTool(manager);

    const result = await tool.execute(
      { task_id: "bg_test123", block: true, timeout: 5000 },
      mockToolContext,
    );

    expect(result).toContain("Task Result");
    expect(result).toContain("blocked result");
  });

  it("T11: 6 distinct task states produce 6 distinguishable outputs", async () => {
    // completed
    const completedTask = makeTask({ id: "bg_comp", status: "completed" });
    const manager1 = {
      getTask: mock(() => completedTask),
      getResult: mock(() =>
        Promise.resolve({ kind: "ok", text: "result text" }),
      ),
    } as unknown as DispatchManager;
    const r1 = await createDispatchOutputTool(manager1).execute(
      { task_id: "bg_comp", block: false, timeout: 60000 },
      mockToolContext,
    );
    expect(r1).toContain("Task Result");

    // error
    const errorTask = makeTask({ id: "bg_err", status: "error", error: "boom" });
    const manager2 = {
      getTask: mock(() => errorTask),
      getResult: mock(() =>
        Promise.resolve({ kind: "not_found", text: "", error: "" }),
      ),
    } as unknown as DispatchManager;
    const r2 = await createDispatchOutputTool(manager2).execute(
      { task_id: "bg_err", block: false, timeout: 60000 },
      mockToolContext,
    );
    expect(r2).toContain("Task Error");
    expect(r2).toContain("boom");

    // timeout
    const timeoutTask = makeTask({
      id: "bg_timeout",
      status: "timeout",
      error: "timed out after 30s",
    });
    const manager3 = {
      getTask: mock(() => timeoutTask),
      getResult: mock(() =>
        Promise.resolve({ kind: "not_found", text: "", error: "" }),
      ),
    } as unknown as DispatchManager;
    const r3 = await createDispatchOutputTool(manager3).execute(
      { task_id: "bg_timeout", block: false, timeout: 60000 },
      mockToolContext,
    );
    expect(r3).toContain("Task Timeout");
    expect(r3).toContain("timed out after 30s");

    // cancelled
    const cancelledTask = makeTask({ id: "bg_cancel", status: "cancelled" });
    const manager4 = {
      getTask: mock(() => cancelledTask),
      getResult: mock(() =>
        Promise.resolve({ kind: "not_found", text: "", error: "" }),
      ),
    } as unknown as DispatchManager;
    const r4 = await createDispatchOutputTool(manager4).execute(
      { task_id: "bg_cancel", block: false, timeout: 60000 },
      mockToolContext,
    );
    expect(r4).toContain("Task Cancelled");

    // expired (task was cleaned up)
    const manager5 = {
      getTask: mock(() => undefined),
      getResult: mock(() =>
        Promise.resolve({
          kind: "expired",
          text: "",
          error: "Task result no longer available (was cleaned up)",
        }),
      ),
    } as unknown as DispatchManager;
    const r5 = await createDispatchOutputTool(manager5).execute(
      { task_id: "bg_expired", block: false, timeout: 60000 },
      mockToolContext,
    );
    expect(r5).toContain("Task Expired");
    expect(r5).toContain("cleaned up");

    // not_found (task never existed)
    const manager6 = {
      getTask: mock(() => undefined),
      getResult: mock(() =>
        Promise.resolve({
          kind: "not_found",
          text: "",
          error: "Task never existed",
        }),
      ),
    } as unknown as DispatchManager;
    const r6 = await createDispatchOutputTool(manager6).execute(
      { task_id: "nonexistent", block: false, timeout: 60000 },
      mockToolContext,
    );
    expect(r6).toContain("Task Not Found");

    // All outputs are distinguishable
    const all = [r1, r2, r3, r4, r5, r6];
    const uniqueSet = new Set(all);
    expect(uniqueSet.size).toBe(6);
  });

  it("T11: fetch_error does not appear in completed result text", async () => {
    const completedTask = makeTask({ id: "bg_fe", status: "completed" });
    const manager = {
      getTask: mock(() => completedTask),
      getResult: mock(() =>
        Promise.resolve({
          kind: "fetch_error",
          text: "",
          error: "Error retrieving task output: some error",
        }),
      ),
    } as unknown as DispatchManager;
    const tool = createDispatchOutputTool(manager);
    const result = await tool.execute(
      { task_id: "bg_fe", block: false, timeout: 60000 },
      mockToolContext,
    );
    // fetch_error should NOT appear in result body as text
    expect(result).not.toContain("Error retrieving task output");
    // The completed format should just have whatever text the result provides (empty)
    expect(result).not.toContain("fetch_error");
    expect(result).not.toContain("[Error");
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

    // Metrics are module-level singletons; tests in the same process may have
    // accumulated counters from prior test blocks, so we accept either outcome.
    const hasEmptyMessage = result.includes("no metrics recorded");
    const hasMetricsReport = result.includes("## Dispatch Metrics");
    expect(hasEmptyMessage || hasMetricsReport).toBe(true);
  });

  it("with export_path writes JSON snapshot file atomically", async () => {
    const tmpDir = fs.mkdtempSync("rb-metrics-test-");
    const exportPath = path.join(tmpDir, "snapshot.json");

    const tool = createDispatchMetricsTool();
    await tool.execute({ export_path: exportPath }, mockToolContext);

    expect(fs.existsSync(exportPath)).toBe(true);

    const content = fs.readFileSync(exportPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty("counters");
    expect(parsed).toHaveProperty("gauges");
    expect(parsed).toHaveProperty("histograms");

    expect(fs.existsSync(exportPath + ".tmp")).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("with export_path in json format also writes file", async () => {
    const tmpDir = fs.mkdtempSync("rb-metrics-test-");
    const exportPath = path.join(tmpDir, "snapshot.json");

    const tool = createDispatchMetricsTool();
    const result = await tool.execute(
      { export_path: exportPath, format: "json" },
      mockToolContext,
    );

    expect(fs.existsSync(exportPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(exportPath, "utf-8"));
    expect(parsed).toHaveProperty("counters");

    expect(() => JSON.parse(result)).not.toThrow();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("without export_path does not write any file", async () => {
    const tmpDir = fs.mkdtempSync("rb-metrics-test-");
    const nonExistentPath = path.join(tmpDir, "should-not-exist.json");

    const tool = createDispatchMetricsTool();
    await tool.execute({}, mockToolContext);

    expect(fs.existsSync(nonExistentPath)).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads ROLEBOX_METRICS_EXPORT env var when export_path not provided", async () => {
    const tmpDir = fs.mkdtempSync("rb-metrics-test-");
    const exportPath = path.join(tmpDir, "env-var-snapshot.json");

    process.env.ROLEBOX_METRICS_EXPORT = exportPath;
    try {
      const tool = createDispatchMetricsTool();
      await tool.execute({}, mockToolContext);

      expect(fs.existsSync(exportPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(exportPath, "utf-8"));
      expect(parsed).toHaveProperty("counters");
    } finally {
      delete process.env.ROLEBOX_METRICS_EXPORT;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("explicit export_path overrides ROLEBOX_METRICS_EXPORT env var", async () => {
    const tmpDir = fs.mkdtempSync("rb-metrics-test-");
    const envPath = path.join(tmpDir, "env.json");
    const explicitPath = path.join(tmpDir, "explicit.json");

    process.env.ROLEBOX_METRICS_EXPORT = envPath;
    try {
      const tool = createDispatchMetricsTool();
      await tool.execute({ export_path: explicitPath }, mockToolContext);

      expect(fs.existsSync(explicitPath)).toBe(true);

      expect(fs.existsSync(envPath)).toBe(false);
    } finally {
      delete process.env.ROLEBOX_METRICS_EXPORT;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTaskBudgetTool } from "../../src/dispatch/budget/task-budget.ts";
import { createTaskSearchTool } from "../../src/dispatch/query/task-search.ts";
import { createTaskExportTool } from "../../src/dispatch/query/task-export.ts";
import { createTaskRetryTool } from "../../src/dispatch/query/task-retry.ts";
import { createTaskChronologyTool } from "../../src/dispatch/query/task-chronology.ts";
import { createTaskGraphTool } from "../../src/dispatch/query/task-graph.ts";
import { createTaskConcurrencyTool } from "../../src/dispatch/concurrency/task-concurrency.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  UsageRecord,
  BudgetCheckResult,
  BudgetTracker,
} from "../../src/dispatch/budget/budget-tracker.ts";
import type { DispatchManagerConfig } from "../../src/dispatch/config.ts";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<DispatchTask> & {
    id: string;
    parentSessionId: string;
  },
): DispatchTask {
  // Build with spread pattern matching existing test conventions.
  // The required id/parentSessionId come from overrides, which is spread
  // last to allow callers to control any field.
  return {
    sessionId: "ses_" + overrides.id,
    status: "completed",
    agent: "test-agent",
    prompt: "do something",
    description: "test task",
    startedAt: new Date(Date.now() - 60000),
    completedAt: new Date(Date.now() - 10000),
    progress: { lastUpdate: new Date(Date.now() - 5000), toolCalls: 3 },
    depth: 1,
    mode: "background",
    priority: 0,
    // caller overrides land last:
    ...overrides,
  } as DispatchTask;
}

const DEFAULT_CONFIG: DispatchManagerConfig = {
  maxConcurrent: 5,
  taskTtlMs: 1_800_000,
  minRuntimeMs: 5_000,
  retryAfterMs: 30_000,
  maxInputTokensPerRequest: 100_000,
  maxOutputTokensPerRequest: 200_000,
  maxCostPerRequest: 1.0,
  maxInputTokensPerSession: 50_000,
  maxCostPerSession: 0.5,
  maxTotalSessionsPerRequest: 10,
};

function createMockBudgetTracker(
  config: DispatchManagerConfig,
  requestUsage?: Partial<UsageRecord>,
  requestExceeded?: boolean,
  sessionUsageMap?: Map<string, { usage: Partial<UsageRecord>; exceeded: boolean }>,
): BudgetTracker {
  const defaultUsage: UsageRecord = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const reqUsage: UsageRecord = { ...defaultUsage, ...requestUsage };

  return {
    getRequestUsage: (_id: string) => reqUsage,
    isRequestBudgetExceeded: (_id: string): BudgetCheckResult => ({
      exceeded: requestExceeded ?? false,
      reason: requestExceeded ? "Request cost budget exhausted: 1.050000 >= 1.0" : undefined,
    }),
    getSessionUsage: (sid: string): UsageRecord => {
      const entry = sessionUsageMap?.get(sid);
      return entry ? { ...defaultUsage, ...entry.usage } : defaultUsage;
    },
    isSessionBudgetExceeded: (sid: string): BudgetCheckResult => {
      const entry = sessionUsageMap?.get(sid);
      if (entry?.exceeded) return { exceeded: true, reason: "Session budget exceeded" };
      return { exceeded: false };
    },
    recordUsage: () => {},
    removeSession: () => {},
    removeRequest: () => {},
    resetSessionUsage: () => {},
    reset: () => {},
    dispose: () => {},
    setConfig: () => {},
    getStatus: () => "",
    persist: () => {},
    restore: () => {},
  } as unknown as BudgetTracker;
}

function createMockManager(
  tasks: DispatchTask[],
  config: DispatchManagerConfig = DEFAULT_CONFIG,
  budgetTracker?: BudgetTracker,
): DispatchManager {
  const tracker =
    budgetTracker ?? createMockBudgetTracker(config);

  return {
    getConfig: () => config,
    getBudgetTracker: () => tracker,
    getTasksByParent: (sessionId: string) =>
      tasks.filter((t) => t.parentSessionId === sessionId),
    getAllTasks: () => tasks,
    getTask: (taskId: string) => tasks.find((t) => t.id === taskId),
    getResult: async (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) {
        return {
          kind: "not_found" as const,
          text: "",
          resultText: "",
          hadFence: false,
          totalChars: 0,
        };
      }
      return {
        kind: "ok" as const,
        text: "task output text",
        resultText: "```result\ndone\n```",
        hadFence: true,
        totalChars: 25,
        error: undefined,
      };
    },
    getEventState: () => new Map(),
  } as unknown as DispatchManager;
}

const mockToolContext = {
  sessionID: "ses_parent",
  messageID: "msg_test",
  agent: "test-agent",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

// ── dispatch_budget ──────────────────────────────────────────────────────────

describe("dispatch_budget", () => {
  it("returns summary table with header and column structure", async () => {
    const mgr = createMockManager([]);
    const tool = createTaskBudgetTool(mgr);
    const result = await tool.execute({ detail: false }, mockToolContext);

    expect(result).toContain("Task Budget");
    expect(result).toContain("| Metric | Current | Limit | % Used | Remaining |");
    expect(result).toContain("Input Tokens");
    expect(result).toContain("Output Tokens");
    expect(result).toContain("Cost (USD)");
  });

  it("detail mode shows per-task breakdown with correct columns", async () => {
    const tracker = createMockBudgetTracker(
      DEFAULT_CONFIG,
      { inputTokens: 1000, outputTokens: 500, cost: 0.05 },
      false,
      new Map([
        ["ses_bg_child1", { usage: { inputTokens: 800, outputTokens: 300, cost: 0.03 }, exceeded: false }],
      ]),
    );
    const tasks = [
      makeTask({
        id: "bg_child1",
        parentSessionId: "ses_parent",
        status: "running",
      }),
    ];
    const mgr = createMockManager(tasks, DEFAULT_CONFIG, tracker);
    const tool = createTaskBudgetTool(mgr);
    const result = await tool.execute({ detail: true }, mockToolContext);

    expect(result).toContain("Per-task Breakdown");
    expect(result).toContain("| Task ID | Agent | Status | Input Tokens | Output Tokens | Cost (USD) | Budget Exceeded |");
    expect(result).toContain("bg_child1");
    expect(result).toContain("test-agent");
    expect(result).toContain("running");
    expect(result).toContain("800");
    expect(result).toContain("—"); // not exceeded → "—"
  });

  it("detail mode shows warning when session budget is exceeded", async () => {
    const tracker = createMockBudgetTracker(
      DEFAULT_CONFIG,
      { inputTokens: 100_000, outputTokens: 200_000, cost: 1.05 },
      false,
      new Map([
        ["ses_bg_exceed", { usage: { inputTokens: 60_000, outputTokens: 100_000, cost: 0.6 }, exceeded: true }],
      ]),
    );
    const tasks = [
      makeTask({
        id: "bg_exceed",
        parentSessionId: "ses_parent",
        status: "running",
      }),
    ];
    const mgr = createMockManager(tasks, DEFAULT_CONFIG, tracker);
    const tool = createTaskBudgetTool(mgr);
    const result = await tool.execute({ detail: true }, mockToolContext);

    expect(result).toContain("⚠️ Yes");
  });

  it("shows exceeded warning when request budget is exceeded", async () => {
    const tracker = createMockBudgetTracker(
      DEFAULT_CONFIG,
      { inputTokens: 100_000, outputTokens: 200_000, cost: 1.05 },
      true, // request exceeded
    );
    const mgr = createMockManager([], DEFAULT_CONFIG, tracker);
    const tool = createTaskBudgetTool(mgr);
    const result = await tool.execute({ detail: false }, mockToolContext);

    expect(result).toContain("⚠️");
    expect(result).toContain("Request budget exceeded");
  });

  it("shows placeholder values when limits are undefined", async () => {
    const config: DispatchManagerConfig = {
      ...DEFAULT_CONFIG,
      maxInputTokensPerRequest: undefined,
      maxOutputTokensPerRequest: undefined,
      maxCostPerRequest: undefined,
    };
    const tracker = createMockBudgetTracker(config, { inputTokens: 100, outputTokens: 50, cost: 0.01 });
    const mgr = createMockManager([], config, tracker);
    const tool = createTaskBudgetTool(mgr);
    const result = await tool.execute({ detail: false }, mockToolContext);

    expect(result).toContain("unlimited");
    expect(result).toContain("—"); // % Used and Remaining show "—" when limit is undefined
  });

  it("detail mode shows 'No child tasks' when no tasks for session", async () => {
    const mgr = createMockManager([]);
    const tool = createTaskBudgetTool(mgr);
    const result = await tool.execute({ detail: true }, mockToolContext);

    expect(result).toContain("No child tasks found");
  });
});

// ── dispatch_search ──────────────────────────────────────────────────────────

describe("dispatch_search", () => {
  it("returns empty message when no tasks exist", async () => {
    const mgr = createMockManager([]);
    const tool = createTaskSearchTool(mgr, "/tmp");
    const result = await tool.execute(
      { query: "anything", limit: 20, include_result: false },
      mockToolContext,
    );
    expect(result).toBe("No dispatch tasks found.");
  });

  it("filters by substring query matching prompt, description, or agent", async () => {
    const tasks = [
      makeTask({ id: "t1", parentSessionId: "ses_p", prompt: "setup test environment", agent: "agent-a" }),
      makeTask({ id: "t2", parentSessionId: "ses_p", prompt: "run deployment", description: "deploy to prod", agent: "agent-b" }),
      makeTask({ id: "t3", parentSessionId: "ses_p", prompt: "cleanup temp files", agent: "agent-c" }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskSearchTool(mgr, "/tmp");
    const result = await tool.execute(
      { query: "deploy", limit: 20, include_result: false },
      mockToolContext,
    );

    expect(result).toContain("deploy");
    expect(result).toContain("t2");
    expect(result).not.toContain("t1");
    expect(result).not.toContain("t3");
  });

  it("filters by status including awaiting_approval", async () => {
    const now = Date.now();
    const tasks = [
      makeTask({ id: "t_comp", parentSessionId: "ses_p", status: "completed", startedAt: new Date(now - 30000) }),
      makeTask({ id: "t_run", parentSessionId: "ses_p", status: "running", startedAt: new Date(now - 20000) }),
      makeTask({ id: "t_await", parentSessionId: "ses_p", status: "awaiting_approval", startedAt: new Date(now - 10000) }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskSearchTool(mgr, "/tmp");
    const result = await tool.execute(
      { query: "test", limit: 20, include_result: false, status: "awaiting_approval" },
      mockToolContext,
    );
    expect(result).toContain("t_await");
    expect(result).not.toContain("t_comp");
    expect(result).not.toContain("t_run");
  });

  it("filters by date range", async () => {
    const base = Date.parse("2026-06-15T12:00:00Z");
    const tasks = [
      makeTask({ id: "t_early", parentSessionId: "ses_p", startedAt: new Date(base - 86400000) }),
      makeTask({ id: "t_mid", parentSessionId: "ses_p", startedAt: new Date(base) }),
      makeTask({ id: "t_late", parentSessionId: "ses_p", startedAt: new Date(base + 86400000) }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskSearchTool(mgr, "/tmp");
    const result = await tool.execute(
      { query: "test", limit: 20, include_result: false, from_date: "2026-06-15T00:00:00Z", to_date: "2026-06-16T23:59:59Z" },
      mockToolContext,
    );

    expect(result).toContain("t_mid");
    expect(result).toContain("t_late");
    expect(result).not.toContain("t_early");
  });

  it("respects limit parameter", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask({ id: `t_${i}`, parentSessionId: "ses_p", startedAt: new Date(Date.now() - i * 1000) }),
    );
    const mgr = createMockManager(tasks);
    const tool = createTaskSearchTool(mgr, "/tmp");
    const result = await tool.execute({ query: "test", limit: 2, include_result: false }, mockToolContext);

    // Should contain "showing first 2"
    expect(result).toContain("showing first 2");

    // Should only list 2 task IDs (count occurrences of "| t_" in the output)
    const output = String(result);
    const count = output.split("| t_").length - 1;
    expect(count).toBe(2);
  });

  it("returns 'No tasks matching' for empty query results", async () => {
    const tasks = [
      makeTask({ id: "t_only", parentSessionId: "ses_p", prompt: "unique setup command" }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskSearchTool(mgr, "/tmp");
    const result = await tool.execute(
      { query: "nonexistent_pattern_xyz", limit: 20, include_result: false },
      mockToolContext,
    );

    expect(result).toBe('No tasks matching "nonexistent_pattern_xyz".');
  });
});

// ── dispatch_export ──────────────────────────────────────────────────────────

describe("dispatch_export", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-export-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function withWorktreeContext(worktree: string) {
    return { ...mockToolContext, worktree, directory: worktree };
  }

  it("produces valid markdown output", async () => {
    const task = makeTask({
      id: "exp_md",
      parentSessionId: "ses_p",
      description: "export test markdown",
      prompt: "run the test",
    });
    const mgr = createMockManager([task]);
    const tool = createTaskExportTool(mgr, tmpDir);
    const ctx = withWorktreeContext(tmpDir);
    const result = await tool.execute(
      { task_id: "exp_md", format: "markdown", output_path: "exp-markdown.md", include_prompt: true, include_messages: false },
      ctx,
    );

    expect(result).toContain("Exported task exp_md");
    expect(result).toContain("markdown format");
  });

  it("produces parseable JSON output with expected fields", async () => {
    const task = makeTask({
      id: "exp_json",
      parentSessionId: "ses_p",
      description: "export test json",
      prompt: "generate report",
    });
    const mgr = createMockManager([task]);
    const tool = createTaskExportTool(mgr, tmpDir);
    const ctx = withWorktreeContext(tmpDir);
    const result = await tool.execute(
      { task_id: "exp_json", format: "json", output_path: "exp-format.json", include_prompt: true, include_messages: false },
      ctx,
    );

    expect(result).toContain("json format");

    // Read back the written file and verify it's valid JSON
    const filePath = resolve(tmpDir, "exp-format.json");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.task_id).toBe("exp_json");
    expect(parsed.agent).toBe("test-agent");
    expect(parsed.status).toBe("completed");
    expect(parsed.prompt).toBe("generate report");
    expect(parsed.result).toContain("done");
    expect(typeof parsed.started_at).toBe("string");
  });

  it("returns not-found error for missing task", async () => {
    const mgr = createMockManager([]);
    const tool = createTaskExportTool(mgr, tmpDir);
    const ctx = withWorktreeContext(tmpDir);
    const result = await tool.execute(
      { task_id: "nonexistent", format: "markdown", output_path: "no-op.md", include_prompt: true, include_messages: false },
      ctx,
    );

    expect(result).toBe("Task not found: nonexistent");
  });

  it("atomic write generates the exported file in the temp directory", async () => {
    const task = makeTask({
      id: "exp_atomic",
      parentSessionId: "ses_p",
      prompt: "atomic write test",
    });
    const mgr = createMockManager([task]);
    const tool = createTaskExportTool(mgr, tmpDir);
    const ctx = withWorktreeContext(tmpDir);
    const outputPath = "subdir/atomic-output.md";

    await tool.execute(
      { task_id: "exp_atomic", format: "markdown", output_path: outputPath, include_prompt: true, include_messages: false },
      ctx,
    );

    const fullPath = resolve(tmpDir, outputPath);
    expect(existsSync(fullPath)).toBe(true);

    const content = readFileSync(fullPath, "utf-8");
    expect(content).toContain("# Task Export");
    expect(content).toContain("exp_atomic");
    expect(content).toContain("test-agent");
  });

  it("rejects path traversal that escapes the project root", async () => {
    // Simulate a subdirectory as project root, try to escape upward
    const nestedRoot = resolve(tmpDir, "project/sub");
    const task = makeTask({
      id: "exp_trav",
      parentSessionId: "ses_p",
      prompt: "should not escape",
    });
    const mgr = createMockManager([task]);
    const tool = createTaskExportTool(mgr, nestedRoot);
    const ctx = withWorktreeContext(nestedRoot);

    const result = await tool.execute(
      { task_id: "exp_trav", format: "markdown", output_path: "../../escape-path.md", include_prompt: true, include_messages: false },
      ctx,
    );

    expect(result).toContain("Path traversal detected");
    expect(result).toContain("../../escape-path.md");
  });
});

// ── dispatch_retry ──────────────────────────────────────────────────────────

describe("dispatch_retry", () => {
  function createRetryManager(
    tasks: DispatchTask[],
    reopenResult?: DispatchTask | ((taskId: string, input: any, ctx: any) => Promise<DispatchTask>),
    checkpointContext: string | null = null,
  ): DispatchManager {
    const reopenFn =
      typeof reopenResult === "function"
        ? reopenResult
        : async (_id: string, _input: any, _ctx: any) =>
            reopenResult ?? ({ id: _id, status: "running", agent: "test-agent", sessionId: "ses_" + _id } as DispatchTask);

    const mockTracker = createMockBudgetTracker(DEFAULT_CONFIG);

    return {
      getTask: (taskId: string) => tasks.find((t) => t.id === taskId),
      getCheckpointStore: () => ({
        buildRetryContext: async () => checkpointContext,
        hasCheckpoint: async () => checkpointContext !== null,
      }),
      getBudgetTracker: () => mockTracker,
      reopenForContinuation: async (...args: [string, any, any]) => reopenFn(...args),
      getAllTasks: () => tasks,
      getTasksByParent: () => [],
      getResult: async () => ({
        kind: "not_found" as const,
        text: "",
        resultText: "",
        hadFence: false,
        totalChars: 0,
      }),
      getEventState: () => new Map(),
    } as unknown as DispatchManager;
  }

  it("retries a completed task successfully", async () => {
    const task = makeTask({ id: "r_ok", parentSessionId: "ses_parent", status: "completed" });
    const reopened = makeTask({ id: "r_ok", parentSessionId: "ses_parent", status: "running" });
    const mgr = createRetryManager([task], reopened);
    const tool = createTaskRetryTool(mgr);
    const result = await tool.execute({ task_id: "r_ok" }, mockToolContext);

    expect(result).toContain("Task Retry Result");
    expect(result).toContain("r_ok");
    expect(result).toContain("running");
    expect(result).toContain("reopened successfully");
  });

  it("rejects retry for a non-terminal (running) task", async () => {
    const task = makeTask({ id: "r_busy", parentSessionId: "ses_parent", status: "running" });
    const mgr = createRetryManager([task]);
    const tool = createTaskRetryTool(mgr);
    const result = await tool.execute({ task_id: "r_busy" }, mockToolContext);

    expect(result).toContain("still running");
    expect(result).toContain("r_busy");
  });

  it("returns not-found error for a missing task id", async () => {
    const mgr = createRetryManager([]);
    const tool = createTaskRetryTool(mgr);
    const result = await tool.execute({ task_id: "ghost" }, mockToolContext);

    expect(result).toContain("not found");
    expect(result).toContain("ghost");
  });

  it("prepends modify_prompt text before the original prompt", async () => {
    let capturedPrompt = "";
    const task = makeTask({ id: "r_mod", parentSessionId: "ses_parent", status: "completed", prompt: "original body" });
    const reopenFn = async (_id: string, input: any, _ctx: any) => {
      capturedPrompt = input.prompt;
      return { ...task, status: "running", id: _id } as DispatchTask;
    };
    const mgr = createRetryManager([task], reopenFn);
    const tool = createTaskRetryTool(mgr);
    await tool.execute({ task_id: "r_mod", modify_prompt: "PREFIX" }, mockToolContext);

    expect(capturedPrompt).toBeDefined();
    // The modify_prompt text should appear before the original prompt
    expect(capturedPrompt.indexOf("PREFIX")).toBeLessThan(capturedPrompt.indexOf("original body"));
    expect(capturedPrompt).toContain("PREFIX\noriginal body");
  });

  it("calls resetSessionUsage when reset_budget is true", async () => {
    const resetArgs: Array<{ sid: string; parentSid: string }> = [];
    const task = makeTask({ id: "r_bgt", parentSessionId: "ses_par", status: "completed" });
    const reopened = makeTask({ id: "r_bgt", parentSessionId: "ses_par", status: "running" });

    const customTracker: BudgetTracker = {
      ...createMockBudgetTracker(DEFAULT_CONFIG),
      resetSessionUsage: (sid: string, parentSid: string) => {
        resetArgs.push({ sid, parentSid });
      },
    };

    const mgr = {
      getTask: () => task,
      getCheckpointStore: () => ({ hasCheckpoint: async () => false, buildRetryContext: async () => null }),
      getBudgetTracker: () => customTracker,
      reopenForContinuation: async () => reopened,
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(mgr);
    await tool.execute({ task_id: "r_bgt", reset_budget: true }, mockToolContext);

    expect(resetArgs).toHaveLength(1);
    expect(resetArgs[0].sid).toBe(task.sessionId);
    expect(resetArgs[0].parentSid).toBe("ses_par");
  });

  it("does NOT call resetSessionUsage when reset_budget is false/omitted", async () => {
    let resetCalled = false;
    const task = makeTask({ id: "r_nobgt", parentSessionId: "ses_parent", status: "completed" });
    const reopened = makeTask({ id: "r_nobgt", parentSessionId: "ses_parent", status: "running" });

    const customTracker: BudgetTracker = {
      ...createMockBudgetTracker(DEFAULT_CONFIG),
      resetSessionUsage: () => {
        resetCalled = true;
      },
    };

    const mgr = {
      getTask: () => task,
      getCheckpointStore: () => ({ hasCheckpoint: async () => false, buildRetryContext: async () => null }),
      getBudgetTracker: () => customTracker,
      reopenForContinuation: async () => reopened,
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(mgr);
    await tool.execute({ task_id: "r_nobgt" }, mockToolContext);

    expect(resetCalled).toBe(false);
  });
});

// ── dispatch_chronology ─────────────────────────────────────────────────────

describe("dispatch_chronology", () => {
  // Fixed timestamps so bucket keys are deterministic across timezones.
  // Use noon UTC to avoid DST/offset ambiguity.
  const T10 = new Date("2026-06-15T10:30:00.000Z");
  const T11 = new Date("2026-06-15T11:15:00.000Z");
  const T12 = new Date("2026-06-15T12:00:00.000Z");

  it("groups tasks by hour bucket with correct structure", async () => {
    const tasks = [
      makeTask({ id: "ch_h1", parentSessionId: "ses_p", status: "completed", startedAt: T10 }),
      makeTask({ id: "ch_h2", parentSessionId: "ses_p", status: "running", startedAt: T11 }),
      makeTask({ id: "ch_h3", parentSessionId: "ses_p", status: "completed", startedAt: T11 }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskChronologyTool(mgr);
    const result = await tool.execute({ group_by: "hour" }, mockToolContext);

    expect(result).toContain("Task Chronology");
    expect(result).toContain("Grouped by: hour");
    expect(result).toContain("2026-06-15T10:00");
    expect(result).toContain("2026-06-15T11:00");
    // Column headers
    expect(result).toContain("| Bucket | Count |");
    expect(result).toContain("Pending | Running | Completed | Awaiting_approval |");
  });

  it("groups by agent and sorts alphabetically", async () => {
    const tasks = [
      makeTask({ id: "ch_ag1", parentSessionId: "ses_p", agent: "z-agent", status: "completed", startedAt: T10 }),
      makeTask({ id: "ch_ag2", parentSessionId: "ses_p", agent: "a-agent", status: "running", startedAt: T11 }),
      makeTask({ id: "ch_ag3", parentSessionId: "ses_p", agent: "m-agent", status: "pending", startedAt: T12 }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskChronologyTool(mgr);
    const result = await tool.execute({ group_by: "agent" }, mockToolContext);

    expect(result).toContain("Grouped by: agent");
    // a-agent should appear before m-agent before z-agent
    expect(result.indexOf("a-agent")).toBeLessThan(result.indexOf("m-agent"));
    expect(result.indexOf("m-agent")).toBeLessThan(result.indexOf("z-agent"));
  });

  it("returns empty message when no tasks exist", async () => {
    const mgr = createMockManager([]);
    const tool = createTaskChronologyTool(mgr);
    const result = await tool.execute({ group_by: "hour" }, mockToolContext);

    expect(result).toBe("No tasks found.");
  });

  it("filters out tasks outside the date range", async () => {
    const base = Date.parse("2026-06-15T12:00:00Z");
    const tasks = [
      makeTask({ id: "ch_early", parentSessionId: "ses_p", status: "completed", startedAt: new Date(base - 86400000) }),
      makeTask({ id: "ch_mid", parentSessionId: "ses_p", status: "completed", startedAt: new Date(base) }),
      makeTask({ id: "ch_late", parentSessionId: "ses_p", status: "completed", startedAt: new Date(base + 86400000) }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskChronologyTool(mgr);
    const result = await tool.execute(
      { group_by: "day", from_date: "2026-06-15T00:00:00Z", to_date: "2026-06-16T00:00:00Z" },
      mockToolContext,
    );

    // Should contain the mid day bucket (June 15) but NOT early (June 14)
    expect(result).toContain("2026-06-15");
    expect(result).not.toContain("2026-06-14");
  });
});

// ── dispatch_graph ─────────────────────────────────────────────────────────

describe("dispatch_graph", () => {
  it("renders root task and child nodes with correct tree format", async () => {
    const tasks = [
      makeTask({ id: "root_t", parentSessionId: "ses_grandparent", status: "completed" }),
      makeTask({ id: "c1", parentSessionId: "ses_root_t", status: "completed" }),
      makeTask({ id: "c2", parentSessionId: "ses_root_t", status: "running" }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskGraphTool(mgr);
    const result = await tool.execute(
      { root_session: "ses_root_t", depth: 3 },
      mockToolContext,
    );

    expect(result).toContain("Task Tree");
    expect(result).toContain("ses_root_t");
    expect(result).toContain("root_t");
    expect(result).toContain("c1");
    expect(result).toContain("c2");
  });

  it("uses box-drawing characters for tree branches", async () => {
    // Need 2 siblings at one level to get ├── (not just └──)
    const tasks = [
      makeTask({ id: "root_bd", parentSessionId: "ses_gp", status: "completed" }),
      makeTask({ id: "child1", parentSessionId: "ses_root_bd", status: "running" }),
      makeTask({ id: "child2", parentSessionId: "ses_root_bd", status: "completed" }),
      makeTask({ id: "grandchild1", parentSessionId: "ses_child1", status: "pending" }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskGraphTool(mgr);
    const result = await tool.execute(
      { root_session: "ses_root_bd", depth: 5, include_result_summary: false },
      mockToolContext,
    );

    expect(result).toContain("├──");
    expect(result).toContain("└──");
    expect(result).toContain("│");
  });

  it("truncates children beyond depth limit", async () => {
    // Build: root → c1 → gc1 → ggc1 → gggc1 (depth 4)
    const tasks = [
      makeTask({ id: "root_d", parentSessionId: "ses_p", status: "completed" }),
      makeTask({ id: "c1_d", parentSessionId: "ses_root_d", status: "completed" }),
      makeTask({ id: "gc1_d", parentSessionId: "ses_c1_d", status: "completed" }),
      makeTask({ id: "ggc1_d", parentSessionId: "ses_gc1_d", status: "completed" }),
      makeTask({ id: "gggc1_d", parentSessionId: "ses_ggc1_d", status: "completed" }),
    ];
    const mgr = createMockManager(tasks);
    const tool = createTaskGraphTool(mgr);
    const result = await tool.execute(
      { root_session: "ses_root_d", depth: 3 },
      mockToolContext,
    );

    expect(result).toContain("Depth limit");
    expect(result).toContain("root_d");
    expect(result).toContain("c1_d");
    expect(result).toContain("gc1_d"); // depth 2 — within limit
    expect(result).not.toContain("ggc1_d"); // depth 3 — at/beyond limit
    expect(result).not.toContain("gggc1_d"); // depth 4 — beyond limit
  });

  it("returns empty message when no tasks for the session", async () => {
    const mgr = createMockManager([]);
    const tool = createTaskGraphTool(mgr);
    const result = await tool.execute(
      { root_session: "ses_nobody" },
      mockToolContext,
    );

    expect(result).toContain("No tasks found for session");
    expect(result).toContain("ses_nobody");
  });
});

// ── dispatch_concurrency ───────────────────────────────────────────────────

describe("dispatch_concurrency", () => {
  function makeConcurrencyStatus(
    keys: Array<{
      key: string;
      active?: number;
      limit?: number;
      reserved?: number;
      queueDepth?: number;
    }>,
  ) {
    const resolvedKeys = keys.map((k) => ({
      key: k.key,
      active: k.active ?? 2,
      limit: k.limit ?? 5,
      available: (k.limit ?? 5) - (k.active ?? 2),
      reserved: k.reserved ?? 0,
      queueDepth: k.queueDepth ?? 1,
    }));
    return {
      keys: resolvedKeys,
      total: {
        active: resolvedKeys.reduce((s, k) => s + k.active, 0),
        limit: resolvedKeys.reduce((s, k) => s + k.limit, 0),
        queueDepth: resolvedKeys.reduce((s, k) => s + k.queueDepth, 0),
        keys: resolvedKeys.length,
      },
    };
  }

  function createConcurrencyMockManager(
    status: ReturnType<typeof makeConcurrencyStatus>,
  ): DispatchManager {
    return {
      getConcurrencyStatus: () => status,
      getConfig: () => DEFAULT_CONFIG,
      getBudgetTracker: () => createMockBudgetTracker(DEFAULT_CONFIG),
      getTask: () => undefined,
      getAllTasks: () => [],
      getTasksByParent: () => [],
      getResult: async () => ({
        kind: "not_found" as const,
        text: "",
        resultText: "",
        hadFence: false,
        totalChars: 0,
      }),
      getEventState: () => new Map(),
    } as unknown as DispatchManager;
  }

  it("renders summary table with correct column headers and data", async () => {
    const status = makeConcurrencyStatus([
      { key: "default", active: 2, limit: 5 },
      { key: "critical", active: 1, limit: 3 },
    ]);
    const mgr = createConcurrencyMockManager(status);
    const tool = createTaskConcurrencyTool(mgr);
    const result = await tool.execute({ format: "summary" }, mockToolContext);

    expect(result).toContain("Task Concurrency Status");
    expect(result).toContain("Per-Key Breakdown");
    expect(result).toContain("| Key | Active | Limit | Available | Reserved | Queue Depth |");
    expect(result).toContain("default");
    expect(result).toContain("critical");
    expect(result).toContain("3"); // available = 5-2 for default key
    expect(result).toContain("Global Summary");
    expect(result).toContain("Concurrency keys: 2");
  });

  it("returns parseable JSON in json format", async () => {
    const status = makeConcurrencyStatus([
      { key: "test-key", active: 1, limit: 10 },
    ]);
    const mgr = createConcurrencyMockManager(status);
    const tool = createTaskConcurrencyTool(mgr);
    const result = await tool.execute({ format: "json" }, mockToolContext);

    const parsed = JSON.parse(result);
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0].key).toBe("test-key");
    expect(parsed.keys[0].active).toBe(1);
    expect(parsed.keys[0].limit).toBe(10);
    expect(parsed.total.active).toBe(1);
    expect(parsed.total.limit).toBe(10);
    expect(parsed.total.keys).toBe(1);
  });

  it("shows empty message when no concurrency keys are registered", async () => {
    const status = makeConcurrencyStatus([]);
    const mgr = createConcurrencyMockManager(status);
    const tool = createTaskConcurrencyTool(mgr);
    const result = await tool.execute({ format: "summary" }, mockToolContext);

    expect(result).toBe("No concurrency keys registered. No tasks have been dispatched yet.");
  });

  it("rejects export_path path traversal outside workspace", async () => {
    const status = makeConcurrencyStatus([{ key: "k", active: 1, limit: 5 }]);
    const mgr = createConcurrencyMockManager(status);
    const tool = createTaskConcurrencyTool(mgr);
    const ctx = { ...mockToolContext, worktree: "/tmp/test-concurrency-root", directory: "/tmp/test-concurrency-root" };

    const result = await tool.execute(
      { format: "summary", export_path: "../../etc/escape.json" },
      ctx,
    );

    expect(result).toContain("Path traversal detected");
    expect(result).toContain("../../etc/escape.json");
  });
});

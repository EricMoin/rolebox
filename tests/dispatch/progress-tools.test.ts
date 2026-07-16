/// <reference types="bun-types" />
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createDispatchProgressTool,
  createDispatchStreamTool,
  clearAllEmittedThresholds,
} from "../../src/dispatch/progress/progress-tools.ts";
import { InMemoryProgressStore } from "../../src/dispatch/progress/progress-store.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { ProgressEvent } from "../../src/dispatch/types.progress.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "bg_test123",
    sessionId: "ses_abc",
    parentSessionId: "ses_parent",
    status: "running" as const,
    agent: "test-agent",
    prompt: "do something",
    description: "test task",
    startedAt: new Date(Date.now() - 5000),
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

/**
 * Creates a minimal DispatchManager mock with an InMemoryProgressStore.
 * Callers can override methods on the returned object.
 */
function createMockManager(overrides?: {
  sendProgressMilestone?: (taskId: string, text: string) => Promise<void>;
}): DispatchManager {
  const dir = mkdtempSync(join(tmpdir(), "progress-tools-test-"));
  const progressStore = new InMemoryProgressStore(dir);

  const manager = {
    getProgressStore: () => progressStore,
    getTask: mock((taskId: string) => {
      if (taskId === "bg_test123") return makeTask();
      if (taskId === "bg_unknown") return undefined;
      return makeTask({ id: taskId });
    }),
    sendProgressMilestone: mock(
      overrides?.sendProgressMilestone ??
        (async (_taskId: string, _text: string) => {}),
    ),
  } as unknown as DispatchManager;

  return manager;
}

const tempDirs: string[] = [];

afterEach(() => {
  // Clean up emitted thresholds between tests
  clearAllEmittedThresholds();

  // Clean up temp dirs
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // already cleaned up
    }
  }
  tempDirs.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("dispatch_progress tool", () => {
  it("adds a progress event to the store", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);
    const store = manager.getProgressStore();

    const result = await tool.execute(
      {
        task_id: "bg_test123",
        stage: "researching",
        message: "looking up docs",
      },
      mockToolContext,
    );

    expect(result).toBe("Progress recorded: researching");

    const stream = store.getProgressStream("bg_test123");
    expect(stream).toHaveLength(1);
    expect(stream[0].stage).toBe("researching");
    expect(stream[0].message).toBe("looking up docs");
    expect(stream[0].task_id).toBe("bg_test123");
    expect(stream[0].percentage).toBeUndefined();
    expect(typeof stream[0].timestamp).toBe("string");
  });

  it("includes percentage when provided", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);
    const store = manager.getProgressStore();

    const result = await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 30,
        stage: "implementing",
        message: "writing code",
      },
      mockToolContext,
    );

    expect(result).toBe("Progress recorded: implementing (30%)");

    const stream = store.getProgressStream("bg_test123");
    expect(stream).toHaveLength(1);
    expect(stream[0].percentage).toBe(30);
    expect(stream[0].stage).toBe("implementing");
  });

  it("accepts 0% percentage", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 0,
        stage: "starting",
        message: "beginning task",
      },
      mockToolContext,
    );

    expect(result).toBe("Progress recorded: starting (0%)");
  });

  it("accepts 100% percentage", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 100,
        stage: "done",
        message: "task complete",
      },
      mockToolContext,
    );

    expect(result).toBe("Progress recorded: done (100%)");
  });

  it("stores multiple events chronologically", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);
    const store = manager.getProgressStore();

    await tool.execute(
      { task_id: "bg_test123", stage: "research", message: "first" },
      mockToolContext,
    );
    await tool.execute(
      { task_id: "bg_test123", stage: "implement", message: "second" },
      mockToolContext,
    );
    await tool.execute(
      { task_id: "bg_test123", stage: "verify", message: "third" },
      mockToolContext,
    );

    const stream = store.getProgressStream("bg_test123");
    expect(stream).toHaveLength(3);
    expect(stream[0].stage).toBe("research");
    expect(stream[1].stage).toBe("implement");
    expect(stream[2].stage).toBe("verify");

    // Timestamps should be in order
    expect(stream[0].timestamp <= stream[1].timestamp).toBe(true);
    expect(stream[1].timestamp <= stream[2].timestamp).toBe(true);
  });
});

describe("dispatch_stream tool", () => {
  it("returns events for the correct task", async () => {
    const manager = createMockManager();
    const progressTool = createDispatchProgressTool(manager);
    const streamTool = createDispatchStreamTool(manager);

    // Add events for two different tasks
    await progressTool.execute(
      { task_id: "bg_test123", stage: "research", message: "task A" },
      mockToolContext,
    );
    await progressTool.execute(
      { task_id: "bg_other", stage: "build", message: "task B" },
      mockToolContext,
    );

    const resultA = await streamTool.execute(
      { task_id: "bg_test123" },
      mockToolContext,
    );
    expect(resultA).toContain("task A");
    expect(resultA).not.toContain("task B");

    const resultB = await streamTool.execute(
      { task_id: "bg_other" },
      mockToolContext,
    );
    expect(resultB).toContain("task B");
  });

  it("returns empty result for unknown task", async () => {
    const manager = createMockManager();
    const streamTool = createDispatchStreamTool(manager);

    const result = await streamTool.execute(
      { task_id: "bg_unknown" },
      mockToolContext,
    );
    expect(result).toContain("No progress events found");
    expect(result).toContain("bg_unknown");
  });

  it("returns empty result when no events exist for known task", async () => {
    const manager = createMockManager();
    const streamTool = createDispatchStreamTool(manager);

    const result = await streamTool.execute(
      { task_id: "bg_test123" },
      mockToolContext,
    );
    expect(result).toContain("No progress events since");
  });

  it("filters with since timestamp", async () => {
    const manager = createMockManager();
    const progressTool = createDispatchProgressTool(manager);
    const streamTool = createDispatchStreamTool(manager);

    await progressTool.execute(
      { task_id: "bg_test123", stage: "early", message: "early event" },
      mockToolContext,
    );

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));

    await progressTool.execute(
      { task_id: "bg_test123", stage: "late", message: "late event" },
      mockToolContext,
    );

    const stream = manager.getProgressStore().getProgressStream("bg_test123");
    expect(stream).toHaveLength(2);

    // Use the first event's timestamp as the filter
    const sinceTs = stream[0].timestamp;
    const filtered = await streamTool.execute(
      { task_id: "bg_test123", since: sinceTs },
      mockToolContext,
    );
    expect(filtered).toContain("late event");
    expect(filtered).not.toContain("early event");
  });

  it("returns formatted markdown table", async () => {
    const manager = createMockManager();
    const progressTool = createDispatchProgressTool(manager);
    const streamTool = createDispatchStreamTool(manager);

    await progressTool.execute(
      {
        task_id: "bg_test123",
        percentage: 50,
        stage: "midway",
        message: "halfway there",
      },
      mockToolContext,
    );

    const result = await streamTool.execute(
      { task_id: "bg_test123" },
      mockToolContext,
    );
    expect(result).toContain("## Progress Events");
    expect(result).toContain("| Timestamp");
    expect(result).toContain("| Stage");
    expect(result).toContain("midway");
    expect(result).toContain("50");
    expect(result).toContain("1 event(s) returned");
  });
});

describe("milestone notification thresholds", () => {
  beforeEach(() => {
    clearAllEmittedThresholds();
  });

  it("emits milestone at 25%", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 25,
        stage: "quarter",
        message: "25% done",
      },
      mockToolContext,
    );

    expect(sendMilestone).toHaveBeenCalledTimes(1);
    const callText = sendMilestone.mock.calls[0][1];
    expect(callText).toContain("25%");
    expect(callText).toContain("Progress Milestone");
    expect(callText).toContain("bg_test123");
  });

  it("emits milestones at 25%, 50%, 75%, 100% progressively", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    // Report 25%
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 25,
        stage: "stage1",
        message: "25%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(1);
    expect(sendMilestone.mock.calls[0][1]).toContain("25%");

    // Report 50%
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 50,
        stage: "stage2",
        message: "50%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(2);
    expect(sendMilestone.mock.calls[1][1]).toContain("50%");

    // Report 75%
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 75,
        stage: "stage3",
        message: "75%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(3);
    expect(sendMilestone.mock.calls[2][1]).toContain("75%");

    // Report 100%
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 100,
        stage: "stage4",
        message: "100%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(4);
    expect(sendMilestone.mock.calls[3][1]).toContain("100%");
  });

  it("does not re-emit already crossed thresholds", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    // Report 60% — should cross 25% and 50% milestones
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 60,
        stage: "progress",
        message: "60%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(2);

    // Report 60% again — no new milestones
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 60,
        stage: "progress",
        message: "still 60%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(2);

    // Report 80% — should cross 75% milestone
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 80,
        stage: "progress",
        message: "80%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(3);
  });

  it("skips milestone when percentage is not provided", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    await tool.execute(
      {
        task_id: "bg_test123",
        stage: "working",
        message: "no percentage",
      },
      mockToolContext,
    );

    expect(sendMilestone).not.toHaveBeenCalled();
  });

  it("treats 0% as before any threshold (no milestone)", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 0,
        stage: "start",
        message: "starting",
      },
      mockToolContext,
    );

    expect(sendMilestone).not.toHaveBeenCalled();
  });

  it("crosses multiple thresholds in a single update (e.g., 0% -> 80%)", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    // Jump from 0% to 80% — should cross 25%, 50%, 75%
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 80,
        stage: "big_jump",
        message: "jumped to 80%",
      },
      mockToolContext,
    );

    // Should emit 3 milestones: 25%, 50%, 75%
    expect(sendMilestone).toHaveBeenCalledTimes(3);
  });

  it("isolates milestones per task_id", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    // Task A reaches 25%
    await tool.execute(
      {
        task_id: "task_a",
        percentage: 25,
        stage: "a",
        message: "a 25%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(1);

    // Task B reaches 25% — should also emit
    await tool.execute(
      {
        task_id: "task_b",
        percentage: 25,
        stage: "b",
        message: "b 25%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(2);
  });

  it("resets milestone tracking when clearAllEmittedThresholds is called", async () => {
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    const manager = createMockManager({
      sendProgressMilestone: sendMilestone,
    });
    const tool = createDispatchProgressTool(manager);

    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 25,
        stage: "initial",
        message: "first 25%",
      },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(1);

    // Reset thresholds
    clearAllEmittedThresholds();

    // Same percentage again — should re-emit
    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 25,
        stage: "rerun",
        message: "second 25%",
      },
      mockToolContext,
    );
    // The milestone sends to manager, but the tool still emits
    expect(sendMilestone).toHaveBeenCalledTimes(2);
  });
});

describe("edge cases", () => {
  it("stores event with percentage at boundary 100", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);
    const store = manager.getProgressStore();

    const result = await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 100,
        stage: "done",
        message: "complete",
      },
      mockToolContext,
    );
    expect(result).toContain("100%");

    const stream = store.getProgressStream("bg_test123");
    expect(stream).toHaveLength(1);
    expect(stream[0].percentage).toBe(100);
  });

  it("stores event with percentage at boundary 0", async () => {
    const manager = createMockManager();
    const tool = createDispatchProgressTool(manager);
    const store = manager.getProgressStore();

    await tool.execute(
      {
        task_id: "bg_test123",
        percentage: 0,
        stage: "start",
        message: "beginning",
      },
      mockToolContext,
    );

    const stream = store.getProgressStream("bg_test123");
    expect(stream[0].percentage).toBe(0);
  });

  it("stores events correctly for multiple tasks", async () => {
    const manager = createMockManager();
    const progressTool = createDispatchProgressTool(manager);
    const streamTool = createDispatchStreamTool(manager);
    const store = manager.getProgressStore();

    await progressTool.execute(
      { task_id: "task_1", stage: "a1", message: "task1 first" },
      mockToolContext,
    );
    await progressTool.execute(
      { task_id: "task_2", stage: "b1", message: "task2 first" },
      mockToolContext,
    );
    await progressTool.execute(
      { task_id: "task_1", stage: "a2", message: "task1 second" },
      mockToolContext,
    );

    expect(store.getProgressStream("task_1")).toHaveLength(2);
    expect(store.getProgressStream("task_2")).toHaveLength(1);
  });
});

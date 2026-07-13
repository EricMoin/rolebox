/// <reference types="bun-types" />
import { describe, it, expect, mock } from "bun:test";

import { createTaskRetryTool } from "../../src/dispatch/query/task-retry.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { CheckpointStore, CheckpointData } from "../../src/dispatch/types.checkpoint.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "bg_test-retry-1",
    sessionId: "ses_original",
    parentSessionId: "ses_parent",
    status: "error",
    agent: "test-agent",
    prompt: "original task prompt",
    description: "test task for retry",
    startedAt: new Date(Date.now() - 5000),
    completedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 3 },
    ...overrides,
  };
}

function makeCheckpointData(overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    task_id: "bg_test-retry-1",
    checkpoint_id: "cp_abc_1234",
    phase: "implementation",
    completed_items: ["Setup project", "Define types"],
    remaining_items: ["Write tests", "Verify"],
    created_at: new Date().toISOString(),
    ttl_ms: 86_400_000,
    ...overrides,
  };
}

const mockToolContext: CanonicalToolContext = {
  sessionID: "ses_parent",
  messageID: "msg_test",
  agent: "role",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("task_retry with checkpoint integration", () => {
  it("injects checkpoint context into the retry prompt when a checkpoint exists", async () => {
    // Build checkpoint data with known content
    const checkpointData = makeCheckpointData({
      phase: "implementation",
      completed_items: ["Setup project", "Define types"],
      remaining_items: ["Write tests", "Verify"],
    });

    // Mock: buildRetryContext returns a markdown string
    const mockStore: CheckpointStore = {
      buildRetryContext: mock(() =>
        Promise.resolve(
          [
            "## Checkpoint Resume Context",
            "",
            "**Phase:** implementation",
            "**Checkpoint ID:** cp_abc_1234",
            "",
            "### Completed Items",
            "- Setup project",
            "- Define types",
            "",
            "### Remaining Items",
            "- Write tests",
            "- Verify",
            "",
            "---",
            "Resume from this checkpoint. Do NOT redo completed items.",
          ].join("\n"),
        ),
      ),
      saveCheckpoint: mock(() => Promise.resolve()),
      getLatestCheckpoint: mock(() => Promise.resolve(checkpointData)),
      listCheckpoints: mock(() => Promise.resolve([checkpointData])),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupExpired: mock(() => Promise.resolve()),
    };

    // Track what prompt is sent to reopenForContinuation
    let capturedPrompt = "";

    const manager: DispatchManager = {
      getTask: mock(() => makeTask({ id: "bg_test-retry-1" })),
      getCheckpointStore: () => mockStore,
      reopenForContinuation: mock(
        (
          _taskId: string,
          input: { prompt: string },
          _parentCtx: unknown,
        ) => {
          capturedPrompt = input.prompt;
          return Promise.resolve(
            makeTask({
              id: "bg_test-retry-1",
              status: "running",
              sessionId: "ses_continued",
            }),
          );
        },
      ),
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_test-retry-1",
      },
      mockToolContext,
    );

    // Verify the retry was successful
    expect(result).toContain("Task Retry Result");
    expect(result).toContain("bg_test-retry-1");
    expect(result).toContain("running");

    // Verify that the checkpoint context was injected into the prompt
    expect(capturedPrompt).toContain("## Checkpoint Resume Context");
    expect(capturedPrompt).toContain("**Phase:** implementation");
    expect(capturedPrompt).toContain("Setup project");
    expect(capturedPrompt).toContain("Define types");
    expect(capturedPrompt).toContain("Write tests");
    expect(capturedPrompt).toContain("Verify");
    expect(capturedPrompt).toContain("Do NOT redo completed items");

    // Verify the original prompt is still present after the checkpoint context
    expect(capturedPrompt).toContain("original task prompt");

    // Verify the checkpoint context is prepended, not appended
    const checkpointIdx = capturedPrompt.indexOf("## Checkpoint Resume Context");
    const originalIdx = capturedPrompt.indexOf("original task prompt");
    expect(checkpointIdx).toBeLessThan(originalIdx);
  });

  it("does NOT inject checkpoint context when no checkpoint exists", async () => {
    // Mock: buildRetryContext returns null (no checkpoint)
    const mockStore: CheckpointStore = {
      buildRetryContext: mock(() => Promise.resolve(null)),
      saveCheckpoint: mock(() => Promise.resolve()),
      getLatestCheckpoint: mock(() => Promise.resolve(null)),
      listCheckpoints: mock(() => Promise.resolve([])),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupExpired: mock(() => Promise.resolve()),
    };

    let capturedPrompt = "";

    const manager: DispatchManager = {
      getTask: mock(() => makeTask({ id: "bg_test-retry-2" })),
      getCheckpointStore: () => mockStore,
      reopenForContinuation: mock(
        (
          _taskId: string,
          input: { prompt: string },
          _parentCtx: unknown,
        ) => {
          capturedPrompt = input.prompt;
          return Promise.resolve(
            makeTask({
              id: "bg_test-retry-2",
              status: "running",
            }),
          );
        },
      ),
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_test-retry-2",
      },
      mockToolContext,
    );

    // Verify the retry was successful
    expect(result).toContain("Task Retry Result");
    expect(result).toContain("running");

    // Verify the prompt is the original — no checkpoint context prepended
    expect(capturedPrompt).toBe("original task prompt");
    expect(capturedPrompt).not.toContain("## Checkpoint Resume Context");
    expect(capturedPrompt).not.toContain("Do NOT redo completed items");
  });

  it("checkpoint context is injected before the modify_prompt when both are present", async () => {
    const mockStore: CheckpointStore = {
      buildRetryContext: mock(() =>
        Promise.resolve("## Checkpoint Resume Context\n\n**Phase:** test"),
      ),
      saveCheckpoint: mock(() => Promise.resolve()),
      getLatestCheckpoint: mock(() => Promise.resolve(makeCheckpointData())),
      listCheckpoints: mock(() => Promise.resolve([makeCheckpointData()])),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupExpired: mock(() => Promise.resolve()),
    };

    let capturedPrompt = "";

    const manager: DispatchManager = {
      getTask: mock(() => makeTask({ id: "bg_test-retry-3" })),
      getCheckpointStore: () => mockStore,
      reopenForContinuation: mock(
        (_taskId: string, input: { prompt: string }, _parentCtx: unknown) => {
          capturedPrompt = input.prompt;
          return Promise.resolve(
            makeTask({ id: "bg_test-retry-3", status: "running" }),
          );
        },
      ),
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(manager);

    await tool.execute(
      {
        task_id: "bg_test-retry-3",
        modify_prompt: "USER MODIFICATION: focus on the backend only",
      },
      mockToolContext,
    );

    // Checkpoint context should come first, then --- separator, then modify_prompt, then original prompt
    const checkpointIdx = capturedPrompt.indexOf("## Checkpoint Resume Context");
    const modifyIdx = capturedPrompt.indexOf("USER MODIFICATION");
    const originalIdx = capturedPrompt.indexOf("original task prompt");

    expect(checkpointIdx).toBeLessThan(modifyIdx);
    expect(modifyIdx).toBeLessThan(originalIdx);
  });

  it("calls buildRetryContext on the checkpoint store exactly once", async () => {
    const buildRetrySpy = mock(() => Promise.resolve(null));

    const mockStore: CheckpointStore = {
      buildRetryContext: buildRetrySpy,
      saveCheckpoint: mock(() => Promise.resolve()),
      getLatestCheckpoint: mock(() => Promise.resolve(null)),
      listCheckpoints: mock(() => Promise.resolve([])),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupExpired: mock(() => Promise.resolve()),
    };

    const manager: DispatchManager = {
      getTask: mock(() => makeTask({ id: "bg_test-retry-4" })),
      getCheckpointStore: () => mockStore,
      reopenForContinuation: mock(() =>
        Promise.resolve(makeTask({ id: "bg_test-retry-4", status: "running" })),
      ),
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(manager);

    await tool.execute(
      {
        task_id: "bg_test-retry-4",
      },
      mockToolContext,
    );

    expect(buildRetrySpy).toHaveBeenCalledTimes(1);
    expect(buildRetrySpy).toHaveBeenCalledWith("bg_test-retry-4");
  });

  it("still works normally when the task is not found (no checkpoint interaction)", async () => {
    // This test verifies that early-exit paths don't touch the checkpoint store
    const buildRetrySpy = mock(() => Promise.resolve(null));

    const mockStore: CheckpointStore = {
      buildRetryContext: buildRetrySpy,
      saveCheckpoint: mock(() => Promise.resolve()),
      getLatestCheckpoint: mock(() => Promise.resolve(null)),
      listCheckpoints: mock(() => Promise.resolve([])),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupExpired: mock(() => Promise.resolve()),
    };

    const manager: DispatchManager = {
      getTask: mock(() => undefined), // task not found
      getCheckpointStore: () => mockStore,
    } as unknown as DispatchManager;

    const tool = createTaskRetryTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_nonexistent",
      },
      mockToolContext,
    );

    expect(result).toContain("not found");
    // buildRetryContext should NOT have been called because we exited early
    expect(buildRetrySpy).not.toHaveBeenCalled();
  });
});

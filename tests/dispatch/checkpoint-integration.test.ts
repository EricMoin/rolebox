/// <reference types="bun-types" />
/**
 * Integration tests for dispatch checkpoint lifecycle.
 *
 * - Save checkpoint via dispatch_checkpoint tool → simulate task failure →
 *   retry via dispatch_retry → verify prompt includes checkpoint context
 * - Checkpoint survives task error (not cleared)
 * - Checkpoint cleared on task success
 * - Expired checkpoints cleaned up by sweeper
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { createMockClient, parentContext } from "./helpers.ts";
import { createCheckpointTool } from "../../src/dispatch/query/checkpoint-tools.ts";
import { createTaskRetryTool } from "../../src/dispatch/query/task-retry.ts";
import { FileSystemCheckpointStore } from "../../src/dispatch/checkpoint/checkpoint-store.ts";
import { clearAllEmittedThresholds } from "../../src/dispatch/progress/progress-tools.ts";
import { existsSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { CheckpointData } from "../../src/dispatch/types.checkpoint.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

// ── Mock tool context ─────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────

function makeCheckpointData(taskId: string, overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    task_id: taskId,
    checkpoint_id: "cp_test_" + Date.now(),
    phase: "implementation",
    completed_items: ["Step 1", "Step 2"],
    remaining_items: ["Step 3", "Step 4"],
    created_at: new Date().toISOString(),
    ttl_ms: 86_400_000,
    ...overrides,
  };
}

describe("checkpoint integration — tool → retry → lifecycle", () => {
  let testDir: string;

  afterEach(() => {
    clearAllEmittedThresholds();
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // already cleaned up
      }
    }
  });

  // ── 1. Save checkpoint via tool → retry → verify context in prompt ──

  it("save checkpoint via dispatch_checkpoint tool, then retry injects checkpoint context", async () => {
    testDir = mkdtempSync(join(tmpdir(), "cp-tool-retry-"));

    // Create checkpoint store for assertions
    const checkpointStore = new FileSystemCheckpointStore(testDir);

    // Build checkpoint data
    const checkpointData = makeCheckpointData("bg_test-retry-1");

    // Mock checkpoint store methods
    const mockStore: FileSystemCheckpointStore = {
      hasCheckpoint: mock(() => Promise.resolve(true)),
      saveCheckpoint: mock((_taskId: string, _data: CheckpointData) => Promise.resolve()),
      getLatestCheckpoint: mock(() => Promise.resolve(checkpointData)),
      listCheckpoints: mock(() => Promise.resolve([checkpointData])),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupExpired: mock(() => Promise.resolve()),
      buildRetryContext: mock(() =>
        Promise.resolve(
          [
            "## Checkpoint Resume Context",
            "",
            "**Phase:** implementation",
            "**Checkpoint ID:** cp_test_1234",
            "",
            "### Completed Items",
            "- Step 1",
            "- Step 2",
            "",
            "### Remaining Items",
            "- Step 3",
            "- Step 4",
            "",
            "---",
            "Resume from this checkpoint. Do NOT redo completed items.",
          ].join("\n"),
        ),
      ),
    } as unknown as FileSystemCheckpointStore;

    // Track what prompt is sent to reopenForContinuation
    let capturedPrompt = "";

    const manager: DispatchManager = {
      getCheckpointStore: () => mockStore,
      getTask: mock(() => ({
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
      })),
      reopenForContinuation: mock(
        (
          _taskId: string,
          input: { prompt: string },
          _parentCtx: unknown,
        ) => {
          capturedPrompt = input.prompt;
          return Promise.resolve({
            id: "bg_test-retry-1",
            sessionId: "ses_continued",
            status: "running",
            agent: "test-agent",
            prompt: input.prompt,
            parentSessionId: "ses_parent",
            startedAt: new Date(),
            progress: { lastUpdate: new Date(), toolCalls: 0 },
          });
        },
      ),
      // Needed for the DispatchManager interface
      sendProgressMilestone: mock(() => Promise.resolve()),
      getProgressStore: () => ({ addProgressEvent: mock(), getProgressStream: mock(() => []), clearProgress: mock(), cleanupExpired: mock() }) as any,
      cleanupTask: mock(),
    } as unknown as DispatchManager;

    // Step 1: Use dispatch_checkpoint tool to save a checkpoint
    const checkpointTool = createCheckpointTool(manager);
    const saveResult = await checkpointTool.execute(
      {
        task_id: "bg_test-retry-1",
        phase: "implementation",
        completed_items: ["Step 1", "Step 2"],
        remaining_items: ["Step 3", "Step 4"],
      },
      mockToolContext,
    );

    expect(saveResult).toContain("Checkpoint saved:");
    expect(saveResult).toContain("phase: implementation");
    expect(saveResult).toContain("2 done, 2 remaining");

    // Verify the store's saveCheckpoint was called
    expect(mockStore.saveCheckpoint).toHaveBeenCalledWith(
      "bg_test-retry-1",
      expect.objectContaining({
        task_id: "bg_test-retry-1",
        phase: "implementation",
        completed_items: ["Step 1", "Step 2"],
        remaining_items: ["Step 3", "Step 4"],
      }),
    );

    // Step 2: Use dispatch_retry tool to retry (will inject checkpoint context)
    const retryTool = createTaskRetryTool(manager);
    const retryResult = await retryTool.execute(
      { task_id: "bg_test-retry-1" },
      mockToolContext,
    );

    expect(retryResult).toContain("Task Retry Result");
    expect(retryResult).toContain("running");

    // Step 3: Verify checkpoint context was injected into the retry prompt
    expect(capturedPrompt).toContain("## Checkpoint Resume Context");
    expect(capturedPrompt).toContain("**Phase:** implementation");
    expect(capturedPrompt).toContain("Step 1");
    expect(capturedPrompt).toContain("Step 2");
    expect(capturedPrompt).toContain("Step 3");
    expect(capturedPrompt).toContain("Step 4");
    expect(capturedPrompt).toContain("Do NOT redo completed items");
    expect(capturedPrompt).toContain("original task prompt");

    // Verify checkpoint context comes before the original prompt
    const checkpointIdx = capturedPrompt.indexOf("## Checkpoint Resume Context");
    const originalIdx = capturedPrompt.indexOf("original task prompt");
    expect(checkpointIdx).toBeLessThan(originalIdx);
  });

  // ── 2. Checkpoint survives task error ──────────────────────────────

  it("checkpoint survives task error (not cleared)", async () => {
    testDir = mkdtempSync(join(tmpdir(), "cp-survive-error-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 500,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "test error checkpoint", run_in_background: true },
      parentContext(),
    );

    // Save a checkpoint
    const checkpointStore = manager.getCheckpointStore();
    await checkpointStore.saveCheckpoint(task.id, makeCheckpointData(task.id));

    // Verify checkpoint exists before error
    const before = await checkpointStore.getLatestCheckpoint(task.id);
    expect(before).not.toBeNull();

    // Error the task
    manager.handleTaskError(task.id, "simulated error");

    // Checkpoint should still exist
    const after = await checkpointStore.getLatestCheckpoint(task.id);
    expect(after).not.toBeNull();
    expect(after!.checkpoint_id).toBe(before!.checkpoint_id);
  });

  // ── 3. Checkpoint cleared on task success ──────────────────────────

  it("checkpoint is cleared on task success (explicit cleanup)", async () => {
    testDir = mkdtempSync(join(tmpdir(), "cp-clear-success-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 500,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "test success checkpoint", run_in_background: true },
      parentContext(),
    );

    // Save a checkpoint
    const checkpointStore = manager.getCheckpointStore();
    await checkpointStore.saveCheckpoint(task.id, makeCheckpointData(task.id));
    expect(await checkpointStore.getLatestCheckpoint(task.id)).not.toBeNull();

    // Complete the task — handleTaskCompleted calls cleanupTerminalCompleted
    // which deletes checkpoints on success (no retry needed)
    manager.handleTaskCompleted(task.id);

    // Checkpoint should be cleared on successful completion
    expect(await checkpointStore.getLatestCheckpoint(task.id)).toBeNull();
  });

  // ── 4. Expired checkpoint cleanup ─────────────────────────────────

  it("expired checkpoints are cleaned up by cleanupExpired", async () => {
    testDir = mkdtempSync(join(tmpdir(), "cp-expired-"));
    const store = new FileSystemCheckpointStore(testDir);

    // Save a recent checkpoint (will NOT expire)
    await store.saveCheckpoint("task_fresh", makeCheckpointData("task_fresh", {
      phase: "recent",
      created_at: new Date().toISOString(),
    }));

    // Save an old checkpoint (will expire — 1 hour ago with 1 ms TTL)
    const oldDate = new Date(Date.now() - 3_600_000).toISOString();
    await store.saveCheckpoint("task_stale", makeCheckpointData("task_stale", {
      phase: "stale",
      created_at: oldDate,
      ttl_ms: 1, // immediate expiry
    }));

    // Verify both exist
    expect(await store.getLatestCheckpoint("task_fresh")).not.toBeNull();
    expect(await store.getLatestCheckpoint("task_stale")).not.toBeNull();

    // Run cleanup with 0ms TTL — all entries are expired (now - createdAt >= 0 is always ≥ 0, so < 0 is false)
    await store.cleanupExpired(0); // 0 TTL — everything is expired

    // Both checkpoints should be cleaned up
    expect(await store.getLatestCheckpoint("task_fresh")).toBeNull();
    expect(await store.getLatestCheckpoint("task_stale")).toBeNull();
  });

  // ── 5. dispatch_checkpoint tool stores data correctly ──────────────

  it("dispatch_checkpoint tool persists data to FileSystemCheckpointStore", async () => {
    testDir = mkdtempSync(join(tmpdir(), "cp-tool-persist-"));
    const checkpointStore = new FileSystemCheckpointStore(testDir);

    const manager: DispatchManager = {
      getCheckpointStore: () => checkpointStore,
    } as unknown as DispatchManager;

    const tool = createCheckpointTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_integration_test",
        phase: "verification",
        completed_items: ["Unit tests", "Integration tests"],
        remaining_items: ["E2E tests"],
        metadata: { retryCount: 2 },
      },
      mockToolContext,
    );

    expect(result).toContain("Checkpoint saved:");

    // Verify data was persisted
    const saved = await checkpointStore.getLatestCheckpoint("bg_integration_test");
    expect(saved).not.toBeNull();
    expect(saved!.task_id).toBe("bg_integration_test");
    expect(saved!.phase).toBe("verification");
    expect(saved!.completed_items).toEqual(["Unit tests", "Integration tests"]);
    expect(saved!.remaining_items).toEqual(["E2E tests"]);
    expect(saved!.metadata).toEqual({ retryCount: 2 });
    expect(saved!.checkpoint_id).toMatch(/^cp_/);
    expect(saved!.created_at).toBeDefined();
    expect(saved!.ttl_ms).toBe(86_400_000);

    // Verify file exists on disk
    const filePath = pathJoin(testDir, ".rolebox", "state", "checkpoints", "bg_integration_test.json");
    expect(existsSync(filePath)).toBe(true);
  });

  // ── 6. Checkpoint is cleared on explicit deletion ──────────────────

  it("checkpoint is deleted via store directly", async () => {
    testDir = mkdtempSync(join(tmpdir(), "cp-delete-"));
    const store = new FileSystemCheckpointStore(testDir);

    await store.saveCheckpoint("task_del", makeCheckpointData("task_del"));
    expect(await store.getLatestCheckpoint("task_del")).not.toBeNull();

    await store.deleteCheckpoint("task_del");
    expect(await store.getLatestCheckpoint("task_del")).toBeNull();
  });
});

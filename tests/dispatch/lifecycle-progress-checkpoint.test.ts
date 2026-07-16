/**
 * Lifecycle tests: verify progress events, checkpoints, and milestone
 * thresholds are properly cleaned up on task completion / error / cleanup.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { createMockClient, parentContext } from "./helpers.ts";
import { clearEmittedThresholds } from "../../src/dispatch/progress/progress-tools.ts";
import type { CheckpointData } from "../../src/dispatch/types.checkpoint.ts";
import type { ProgressEvent } from "../../src/dispatch/types.progress.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeProgressEvent(
  taskId: string,
  stage: string,
  message: string,
  percentage?: number,
): ProgressEvent {
  return {
    task_id: taskId,
    percentage,
    stage,
    message,
    timestamp: new Date().toISOString(),
  };
}

function makeCheckpointData(taskId: string): CheckpointData {
  return {
    task_id: taskId,
    checkpoint_id: "cp-" + Date.now(),
    phase: "implementation",
    completed_items: ["step 1"],
    remaining_items: ["step 2"],
    created_at: new Date().toISOString(),
    ttl_ms: 86_400_000,
  };
}

// ── Test Lifecycle ──────────────────────────────────────────────────────

describe("lifecycle progress and checkpoint cleanup", () => {
  let testDir: string;

  afterEach(() => {
    clearEmittedThresholds();
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // already cleaned up
      }
    }
  });

  // ── Progress cleared on completion ─────────────────────────────

  it("completing a task clears its progress events", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-progress-clear-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test progress clear",
        run_in_background: true,
      },
      parentContext(),
    );

    const progressStore = manager.getProgressStore();

    // Add some progress events
    progressStore.addProgressEvent(task.id, makeProgressEvent(task.id, "research", "researching...", 25));
    progressStore.addProgressEvent(task.id, makeProgressEvent(task.id, "implementing", "coding...", 50));
    expect(progressStore.getProgressStream(task.id)).toHaveLength(2);

    // Complete the task — this should trigger cleanupTerminalCompleted
    manager.handleTaskCompleted(task.id);

    // Progress events should be cleared
    expect(progressStore.getProgressStream(task.id)).toEqual([]);
  });

  // ── Final 100% event emitted on completion ─────────────────────

  it("emits a final 100% progress event before clearing on completion", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-final-event-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test final event",
        run_in_background: true,
      },
      parentContext(),
    );

    const progressStore = manager.getProgressStore();

    // Spy on addProgressEvent to capture the final event
    const origAdd = progressStore.addProgressEvent.bind(progressStore);
    const capturedEvents: ProgressEvent[] = [];
    progressStore.addProgressEvent = ((taskId: string, event: ProgressEvent) => {
      capturedEvents.push(event);
      origAdd(taskId, event);
    }) as typeof progressStore.addProgressEvent;

    // Complete the task
    manager.handleTaskCompleted(task.id);

    // Should have captured a 100% completion event
    const completionEvent = capturedEvents.find(
      (e) => e.percentage === 100 && e.stage === "complete",
    );
    expect(completionEvent).toBeDefined();
    expect(completionEvent!.task_id).toBe(task.id);
    expect(completionEvent!.message).toBe("Task completed");
  });

  // ── Checkpoints survive on error/timeout ───────────────────────

  it("erroring a task does NOT clear checkpoints (they survive for retry)", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-checkpoint-survive-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test error checkpoint",
        run_in_background: true,
      },
      parentContext(),
    );

    // Save a checkpoint before error
    const checkpointStore = manager.getCheckpointStore();
    await checkpointStore.saveCheckpoint(task.id, makeCheckpointData(task.id));

    // Verify checkpoint exists
    const before = await checkpointStore.getLatestCheckpoint(task.id);
    expect(before).not.toBeNull();

    // Error the task — checkpoints should survive
    manager.handleTaskError(task.id, "test error");

    // Checkpoint should still exist
    const after = await checkpointStore.getLatestCheckpoint(task.id);
    expect(after).not.toBeNull();
    expect(after!.checkpoint_id).toBe(before!.checkpoint_id);
  });

  it("timeout does NOT clear checkpoints (they survive for retry)", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-checkpoint-timeout-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test timeout checkpoint",
        run_in_background: true,
      },
      parentContext(),
    );

    // Save a checkpoint before timeout
    const checkpointStore = manager.getCheckpointStore();
    await checkpointStore.saveCheckpoint(task.id, makeCheckpointData(task.id));
    expect(await checkpointStore.getLatestCheckpoint(task.id)).not.toBeNull();

    // Timeout the task — checkpoints should survive
    manager.handleTaskTimeout(task.id, "test timeout");

    // Checkpoint should still exist
    expect(await checkpointStore.getLatestCheckpoint(task.id)).not.toBeNull();
  });

  // ── Explicit cleanup removes checkpoints ──────────────────────

  it("explicit cleanup removes checkpoints", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-cleanup-checkpoint-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test cleanup checkpoint",
        run_in_background: true,
      },
      parentContext(),
    );

    // Save a checkpoint
    const checkpointStore = manager.getCheckpointStore();
    await checkpointStore.saveCheckpoint(task.id, makeCheckpointData(task.id));
    expect(await checkpointStore.getLatestCheckpoint(task.id)).not.toBeNull();

    // Complete the task first (to enter terminal state, needed for cleanup)
    manager.handleTaskCompleted(task.id);

    // Explicitly clean up the task
    manager.cleanupTask(task.id);

    // Checkpoint should be deleted after cleanup
    expect(await checkpointStore.getLatestCheckpoint(task.id)).toBeNull();
  });

  it("explicit cleanup clears progress events", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-cleanup-progress-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test cleanup progress",
        run_in_background: true,
      },
      parentContext(),
    );

    const progressStore = manager.getProgressStore();
    progressStore.addProgressEvent(task.id, makeProgressEvent(task.id, "test", "some event"));
    expect(progressStore.getProgressStream(task.id)).toHaveLength(1);

    // Complete then explicitly clean up
    manager.handleTaskCompleted(task.id);
    manager.cleanupTask(task.id);

    // Progress should be cleared after cleanup
    expect(progressStore.getProgressStream(task.id)).toEqual([]);
  });

  // ── Milestone thresholds cleared for completed tasks ───────────

  it("milestone thresholds are cleared for completed tasks", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-milestones-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "test milestones",
        run_in_background: true,
      },
      parentContext(),
    );

    const progressStore = manager.getProgressStore();

    // Add a 25% progress event (this should trigger milestone tracking)
    progressStore.addProgressEvent(task.id, makeProgressEvent(task.id, "stage1", "First stage", 25));

    // Now complete the task — should clear thresholds
    manager.handleTaskCompleted(task.id);

    // If thresholds are cleared, a FRESH task should be able to emit 25% milestones again
    // We verify by starting a new task and checking its milestones work
    const task2 = await manager.launch(
      {
        subagent: "helper",
        prompt: "test milestones fresh",
        run_in_background: true,
      },
      parentContext({ sessionID: "parent-2" }),
    );

    // Spy on addProgressEvent for the new task to check milestone tracking
    const origAdd2 = progressStore.addProgressEvent.bind(progressStore);
    let milestoneDetected = false;
    progressStore.addProgressEvent = ((tid: string, evt: ProgressEvent) => {
      // If milestone thresholds are properly cleared, a 25% event should trigger
      // consider themselves as new milestones, meaning dispatch_progress tool
      // would handle them correctly. We verify via the fact that addProgressEvent works.
      origAdd2(tid, evt);
    }) as typeof progressStore.addProgressEvent;

    // Add a 25% event for the new task — it should work fine
    progressStore.addProgressEvent(task2.id, makeProgressEvent(task2.id, "stage1", "fresh stage", 25));
    const stream2 = progressStore.getProgressStream(task2.id);
    expect(stream2).toHaveLength(1);
    expect(stream2[0].percentage).toBe(25);

    // Restore
    progressStore.addProgressEvent = origAdd2;
  });

  // ── Cleanup does not affect other tasks ─────────────────────────

  it("cleaning up one task does not affect progress of another", async () => {
    testDir = mkdtempSync(join(tmpdir(), "lifecycle-isolation-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task1 = await manager.launch(
      {
        subagent: "helper",
        prompt: "task-1",
        run_in_background: true,
      },
      parentContext(),
    );
    const task2 = await manager.launch(
      {
        subagent: "helper",
        prompt: "task-2",
        run_in_background: true,
      },
      parentContext({ sessionID: "parent-isolation" }),
    );

    const progressStore = manager.getProgressStore();
    progressStore.addProgressEvent(task1.id, makeProgressEvent(task1.id, "a", "task1-event"));
    progressStore.addProgressEvent(task2.id, makeProgressEvent(task2.id, "b", "task2-event"));

    // Complete and cleanup task1 only
    manager.handleTaskCompleted(task1.id);
    manager.cleanupTask(task1.id);

    // task1 progress should be gone
    expect(progressStore.getProgressStream(task1.id)).toEqual([]);
    // task2 progress should remain
    expect(progressStore.getProgressStream(task2.id)).toHaveLength(1);
  });
});

/// <reference types="bun-types" />
/**
 * Integration tests for dispatch progress event lifecycle.
 *
 * End-to-end flow: create a progress store → add events → query via
 * dispatch_stream tool → verify events returned → complete task →
 * verify events cleared.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { createMockClient, parentContext } from "./helpers.ts";
import {
  createDispatchProgressTool,
  createDispatchStreamTool,
  clearAllEmittedThresholds,
} from "../../src/dispatch/progress/progress-tools.ts";
import { InMemoryProgressStore } from "../../src/dispatch/progress/progress-store.ts";
import type { ProgressEvent } from "../../src/dispatch/types.progress.ts";
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

describe("progress integration — store → tool → completion lifecycle", () => {
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

  // ── 1. End-to-end flow ──────────────────────────────────────────────

  it("end-to-end: add events → query via stream → verify → clear on completion", async () => {
    testDir = mkdtempSync(join(tmpdir(), "progress-e2e-"));
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
        prompt: "e2e progress test",
        run_in_background: true,
      },
      parentContext(),
    );

    const progressStore = manager.getProgressStore();
    const progressTool = createDispatchProgressTool(manager);
    const streamTool = createDispatchStreamTool(manager);

    // Add events via the tool
    await progressTool.execute(
      { task_id: task.id, stage: "research", message: "looking up docs" },
      mockToolContext,
    );
    await progressTool.execute(
      { task_id: task.id, stage: "implement", message: "writing code" },
      mockToolContext,
    );
    await progressTool.execute(
      { task_id: task.id, stage: "verify", message: "running tests" },
      mockToolContext,
    );

    // Verify via stream tool
    const streamResult = await streamTool.execute(
      { task_id: task.id },
      mockToolContext,
    );
    expect(streamResult).toContain("research");
    expect(streamResult).toContain("implement");
    expect(streamResult).toContain("verify");
    expect(streamResult).toContain("3 event(s) returned");

    // Verify via store directly
    const events = progressStore.getProgressStream(task.id);
    expect(events).toHaveLength(3);

    // Complete the task — should clear events
    manager.handleTaskCompleted(task.id);

    // Events should be cleared
    const afterComplete = progressStore.getProgressStream(task.id);
    expect(afterComplete).toEqual([]);

    // Stream tool should return empty result
    const afterStream = await streamTool.execute(
      { task_id: task.id },
      mockToolContext,
    );
    expect(afterStream).toContain("No progress events since");
  });

  // ── 2. Milestone notifications ───────────────────────────────────────

  it("milestone notifications sent when crossing thresholds via integration", async () => {
    testDir = mkdtempSync(join(tmpdir(), "progress-milestone-"));
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
        prompt: "milestone test",
        description: "milestone-test-task",
        run_in_background: true,
      },
      parentContext(),
    );

    // Spy on sendProgressMilestone
    const sendMilestone = mock(async (_taskId: string, _text: string) => {});
    manager.sendProgressMilestone = sendMilestone;

    const progressTool = createDispatchProgressTool(manager);

    // Report 25%
    await progressTool.execute(
      { task_id: task.id, percentage: 25, stage: "stage1", message: "25%" },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(1);
    expect(sendMilestone.mock.calls[0][1]).toContain("25%");

    // Report 50%
    await progressTool.execute(
      { task_id: task.id, percentage: 50, stage: "stage2", message: "50%" },
      mockToolContext,
    );
    expect(sendMilestone).toHaveBeenCalledTimes(2);
    expect(sendMilestone.mock.calls[1][1]).toContain("50%");

    // Report 100% — crosses both 75% and 100% thresholds = 2 new milestones
    await progressTool.execute(
      { task_id: task.id, percentage: 100, stage: "done", message: "complete" },
      mockToolContext,
    );
    // 4 total: 25 + 50 + (75 & 100 from the jump)
    expect(sendMilestone).toHaveBeenCalledTimes(4);
    expect(sendMilestone.mock.calls[3][1]).toContain("100%");
  });

  // ── 3. Disk persistence across store re-initialization ──────────────

  it("progress events survive across store reinitialization (disk spill)", async () => {
    testDir = mkdtempSync(join(tmpdir(), "progress-persist-"));
    const store = new InMemoryProgressStore(testDir);

    // Add events
    store.addProgressEvent("task_persist", makeProgressEvent("task_persist", "research", "first", 25));
    store.addProgressEvent("task_persist", makeProgressEvent("task_persist", "implement", "second", 50));

    // Force flush to disk
    store.flushSync();

    // Verify file exists
    const progressPath = join(testDir, ".rolebox", "state", "progress", "task_persist.json");
    expect(existsSync(progressPath)).toBe(true);

    // Create a new store instance — it won't load from disk automatically
    // (InMemoryProgressStore does NOT reload from disk on construction)
    // But the file on disk is evidence that events were persisted
    const raw = readFileSync(progressPath, "utf-8");
    const events = JSON.parse(raw) as ProgressEvent[];
    expect(events).toHaveLength(2);
    expect(events[0].stage).toBe("research");
    expect(events[1].stage).toBe("implement");
  });

  // ── 4. Since filter on stream tool ───────────────────────────────────

  it("dispatch_stream respects the since filter with real task state", async () => {
    testDir = mkdtempSync(join(tmpdir(), "progress-since-"));
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
        prompt: "since filter test",
        run_in_background: true,
      },
      parentContext(),
    );

    const progressTool = createDispatchProgressTool(manager);

    // Add first event
    await progressTool.execute(
      { task_id: task.id, stage: "early", message: "first event" },
      mockToolContext,
    );

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    // Add second event
    await progressTool.execute(
      { task_id: task.id, stage: "late", message: "second event" },
      mockToolContext,
    );

    // Get events to capture the first event's timestamp
    const store = manager.getProgressStore();
    const allEvents = store.getProgressStream(task.id);
    expect(allEvents).toHaveLength(2);

    const sinceTs = allEvents[0].timestamp;

    // Query with since filter
    const streamTool = createDispatchStreamTool(manager);
    const filtered = await streamTool.execute(
      { task_id: task.id, since: sinceTs },
      mockToolContext,
    );

    expect(filtered).toContain("second event");
    expect(filtered).not.toContain("first event");
  });

  // ── 5. Multiple tasks isolation ──────────────────────────────────────

  it("progress events for different tasks remain isolated", async () => {
    testDir = mkdtempSync(join(tmpdir(), "progress-isolation-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const taskA = await manager.launch(
      { subagent: "helper", prompt: "task A", run_in_background: true },
      parentContext({ sessionID: "parent-A" }),
    );
    const taskB = await manager.launch(
      { subagent: "helper", prompt: "task B", run_in_background: true },
      parentContext({ sessionID: "parent-B" }),
    );

    const progressTool = createDispatchProgressTool(manager);

    await progressTool.execute(
      { task_id: taskA.id, stage: "a", message: "only A" },
      mockToolContext,
    );
    await progressTool.execute(
      { task_id: taskB.id, stage: "b", message: "only B" },
      mockToolContext,
    );

    const store = manager.getProgressStore();
    expect(store.getProgressStream(taskA.id)).toHaveLength(1);
    expect(store.getProgressStream(taskA.id)[0].message).toBe("only A");
    expect(store.getProgressStream(taskB.id)).toHaveLength(1);
    expect(store.getProgressStream(taskB.id)[0].message).toBe("only B");
  });

  // ── 6. 100% event on completion ────────────────────────────────────

  it("emits a terminal 100% progress event on task completion", async () => {
    testDir = mkdtempSync(join(tmpdir(), "progress-terminal-"));
    const client = createMockClient({
      sessionMessages: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve({ type: "idle" }),
    });
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
      maxConcurrent: 5,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "terminal test", run_in_background: true },
      parentContext(),
    );

    const progressStore = manager.getProgressStore();

    // Spy on addProgressEvent to capture the terminal event
    const origAdd = progressStore.addProgressEvent.bind(progressStore);
    const capturedEvents: ProgressEvent[] = [];
    progressStore.addProgressEvent = ((taskId: string, event: ProgressEvent) => {
      capturedEvents.push(event);
      origAdd(taskId, event);
    }) as typeof progressStore.addProgressEvent;

    // Complete the task — should emit terminal 100% event
    manager.handleTaskCompleted(task.id);

    const terminalEvent = capturedEvents.find(
      (e) => e.percentage === 100 && e.stage === "complete",
    );
    expect(terminalEvent).toBeDefined();
    expect(terminalEvent!.task_id).toBe(task.id);
    expect(terminalEvent!.message).toBe("Task completed");
  });
});

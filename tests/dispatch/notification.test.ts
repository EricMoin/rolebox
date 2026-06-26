import { describe, it, expect, mock, afterEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchTask, NotificationPayload } from "../../src/dispatch/types";
import { buildNotificationText, notifyParent } from "../../src/dispatch/notification";

// ── helpers ──────────────────────────────────────────────────────

function createTask(overrides?: Partial<DispatchTask>): DispatchTask {
  return {
    id: "bg_test123",
    sessionId: "child-session-1",
    parentSessionId: "parent-session-1",
    status: "completed",
    agent: "helper",
    prompt: "do work",
    description: "Test task description",
    startedAt: new Date(Date.now() - 5000),
    completedAt: new Date(),
    progress: {
      lastUpdate: new Date(),
      toolCalls: 3,
    },
    ...overrides,
  };
}

function createClient() {
  return {
    session: {
      promptAsync: mock(() => Promise.resolve({ data: undefined, error: undefined })),
    },
  } as unknown as OpencodeClient;
}

// ── tests: buildNotificationText ─────────────────────────────────

describe("buildNotificationText", () => {
  it("intermediate format when remainingTasks > 0 — contains [BACKGROUND TASK COMPLETED]", () => {
    const payload: NotificationPayload = {
      taskId: "bg_abc",
      description: "code review task",
      duration: "3.2s",
      status: "completed",
      remainingTasks: 2,
    };

    const text = buildNotificationText(payload);

    expect(text).toContain("<system-reminder>");
    expect(text).toContain("[BACKGROUND TASK COMPLETED]");
    expect(text).toContain("**ID:** bg_abc");
    expect(text).toContain("**Description:** code review task");
    expect(text).toContain("**Duration:** 3.2s");
    expect(text).toContain("**Status:** completed");
    expect(text).toContain("2 task(s) still in progress");
    expect(text).toContain("</system-reminder>");
    expect(text).not.toContain("[ALL BACKGROUND TASKS COMPLETE]");
  });

  it("final format when remainingTasks === 0 — contains [ALL BACKGROUND TASKS COMPLETE]", () => {
    const payload: NotificationPayload = {
      taskId: "bg_abc",
      description: "lint fix",
      duration: "12.5s",
      status: "completed",
      remainingTasks: 0,
    };

    const text = buildNotificationText(payload);

    expect(text).toContain("<system-reminder>");
    expect(text).toContain("[ALL BACKGROUND TASKS COMPLETE]");
    expect(text).toContain("**Completed:**");
    expect(text).toContain("lint fix (12.5s)");
    expect(text).toContain("All background tasks have finished");
    expect(text).toContain("</system-reminder>");
    expect(text).not.toContain("[BACKGROUND TASK COMPLETED]");
  });

  it("falls back to taskId when description is undefined", () => {
    const payload: NotificationPayload = {
      taskId: "bg_xyz",
      description: undefined,
      duration: "1.0s",
      status: "error",
      remainingTasks: 0,
    };

    const text = buildNotificationText(payload);

    expect(text).toContain("bg_xyz (1.0s)");
  });

  it("intermediate format uses description as label in remaining message", () => {
    const payload: NotificationPayload = {
      taskId: "bg_task1",
      description: "lint check",
      duration: "2.1s",
      status: "completed",
      remainingTasks: 3,
    };

    const text = buildNotificationText(payload);

    expect(text).toContain("3 task(s) still in progress");
    expect(text).toContain("lint check");
  });
});

// ── tests: notifyParent ──────────────────────────────────────────

describe("notifyParent", () => {
  afterEach(() => {
    mock.restore();
  });

  it("calls promptAsync with notification text containing [BACKGROUND TASK COMPLETED] for intermediate", async () => {
    const client = createClient();
    const task = createTask({ status: "completed" });

    await notifyParent(client, task, 2);

    // Wait for serial queue promise chain to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    const callArgs = (client.session.promptAsync as ReturnType<typeof mock>).mock.calls[0][0];
    expect(callArgs.path.id).toBe("parent-session-1");
    expect(callArgs.body.parts[0].type).toBe("text");
    expect(callArgs.body.parts[0].text).toContain("[BACKGROUND TASK COMPLETED]");
    expect(callArgs.body.parts[0].text).toContain(task.id);
    expect(callArgs.body.noReply).toBe(true);
  });

  it("calls promptAsync with noReply: false for final notification (remainingCount === 0)", async () => {
    const client = createClient();
    const task = createTask({ status: "completed" });

    await notifyParent(client, task, 0);

    await new Promise((r) => setTimeout(r, 10));

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    const callArgs = (client.session.promptAsync as ReturnType<typeof mock>).mock.calls[0][0];
    expect(callArgs.body.parts[0].text).toContain("[ALL BACKGROUND TASKS COMPLETE]");
    expect(callArgs.body.noReply).toBe(false);
  });

  it("includes task ID, description, duration, and status in notification text", async () => {
    const client = createClient();
    const task = createTask({
      id: "bg_check123",
      description: "Running type check",
      status: "completed",
      startedAt: new Date(Date.now() - 30_000),
      completedAt: new Date(),
    });

    await notifyParent(client, task, 1);

    await new Promise((r) => setTimeout(r, 10));

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);

    const callArgs = (client.session.promptAsync as ReturnType<typeof mock>).mock.calls[0][0];
    const text: string = callArgs.body.parts[0].text;

    expect(text).toContain("bg_check123");
    expect(text).toContain("Running type check");
    expect(text).toContain("completed");
    // duration should be computed from startedAt to completedAt — 30s
    expect(text).toContain("30.0s");
  });

  it("does not throw when promptAsync fails", async () => {
    const client = {
      session: {
        promptAsync: mock(() => Promise.reject(new Error("network error"))),
      },
    } as unknown as OpencodeClient;

    const task = createTask();

    await notifyParent(client, task, 0);

    await new Promise((r) => setTimeout(r, 10));

    // should not have thrown — error is caught internally
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("serial queue continues after rejection — next notify to same parent still runs", async () => {
    const client = createClient();
    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    // First call rejects (simulates promptAsync failure)
    promptAsyncMock.mockImplementationOnce(() => Promise.reject(new Error("network error")));

    const task1 = createTask({ id: "first" });
    const task2 = createTask({ id: "second" });

    await notifyParent(client, task1, 2);
    await notifyParent(client, task2, 0);

    await new Promise((r) => setTimeout(r, 10));

    // Both notifies should have been attempted; second one not blocked by first rejection
    expect(promptAsyncMock).toHaveBeenCalledTimes(2);
  });

  it("resolves remainingCount at send time — enqueue with inflight=2, send with inflight=0 → ALL COMPLETE", async () => {
    const client = createClient();
    const task = createTask({ status: "completed" });

    let inflight = 2;

    // Enqueue notification with callback that reads inflight at send time.
    // At enqueue time inflight=2, but by the time doNotify fires inflight=0.
    notifyParent(client, task, () => inflight);

    // Synchronously drop inflight before any microtask fires.
    inflight = 0;

    // Enqueue a second notification to ensure serial queue flushes both.
    const task2 = createTask({ id: "task-2" });
    notifyParent(client, task2, () => inflight);

    await new Promise((r) => setTimeout(r, 10));

    const calls = (client.session.promptAsync as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(2);

    // Both notifications were resolved at send time (inflight=0).
    expect(calls[0][0].body.parts[0].text).toContain("[ALL BACKGROUND TASKS COMPLETE]");
    expect(calls[1][0].body.parts[0].text).toContain("[ALL BACKGROUND TASKS COMPLETE]");
  });

  it("notifications to the same parent execute in FIFO order", async () => {
    const client = createClient();
    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    const taskA = createTask({ id: "task-A", description: "first" });
    const taskB = createTask({ id: "task-B", description: "second" });
    const taskC = createTask({ id: "task-C", description: "third" });

    // Fire all three in quick succession (same tick) — same parent session
    notifyParent(client, taskA, 2);
    notifyParent(client, taskB, 1);
    notifyParent(client, taskC, 0);

    await new Promise((r) => setTimeout(r, 10));

    expect(promptAsyncMock).toHaveBeenCalledTimes(3);

    // Verify FIFO order: calls[0]/calls[1] use intermediate format (task ID in **ID:**)
    // calls[2] uses final format (description in `- description (duration)`)
    const calls = (promptAsyncMock as ReturnType<typeof mock>).mock.calls;
    expect(calls[0][0].body.parts[0].text).toContain("task-A");
    expect(calls[1][0].body.parts[0].text).toContain("task-B");
    expect(calls[2][0].body.parts[0].text).toContain("third");
  });
});

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
});

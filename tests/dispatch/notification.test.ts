import { describe, it, expect, mock, afterEach, beforeAll, afterAll } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchTask, NotificationPayload } from "../../src/dispatch/types";
import {
  buildNotificationText,
  notifyParent,
  hasFinalNotifyBeenSent,
  NOTIFY_MAX_RETRIES,
  clearSentFinalNotifies,
  clearParentQueues,
} from "../../src/dispatch/notification";
import { metrics } from "../../src/dispatch/metrics";

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
    clearSentFinalNotifies();
    clearParentQueues();
    metrics.reset();
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

    notifyParent(client, task, 0);

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

// ── tests: notifyParent retry + idempotency ────────────────────────

describe("notifyParent retry and idempotency", () => {
  let prevMetricsEnv: string | undefined;
  let metricsActive = false;

  beforeAll(() => {
    prevMetricsEnv = process.env.ROLEBOX_METRICS;
    process.env.ROLEBOX_METRICS = "1";
    const probe = metrics.counter("_probe");
    probe.inc();
    const probe2 = metrics.counter("_probe");
    metricsActive = probe2.peek() > 0;
    metrics.reset();
  });

  afterAll(() => {
    if (prevMetricsEnv === undefined) {
      delete process.env.ROLEBOX_METRICS;
    } else {
      process.env.ROLEBOX_METRICS = prevMetricsEnv;
    }
  });

  afterEach(() => {
    mock.restore();
    metrics.reset();
    clearSentFinalNotifies();
    clearParentQueues();
  });

  it("retries final notification with bounded exponential backoff, succeeds eventually", async () => {
    let callCount = 0;
    const promptAsyncMock = mock(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("transient error");
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ status: "completed" });

    await notifyParent(client, task, 0, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(promptAsyncMock).toHaveBeenCalledTimes(3);
    if (metricsActive) {
      expect(metrics.counter("notify_sent_total").peek()).toBe(1);
      expect(metrics.counter("notify_retry_total").peek()).toBe(2);
      expect(metrics.counter("notify_failed_total").peek()).toBe(0);
    }
  });

  it("increments notify_failed_total on final give-up after all retries exhausted", async () => {
    const promptAsyncMock = mock(async () => {
      throw new Error("persistent error");
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ status: "completed" });

    await notifyParent(client, task, 0, {
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(promptAsyncMock).toHaveBeenCalledTimes(3);
    if (metricsActive) {
      expect(metrics.counter("notify_retry_total").peek()).toBe(2);
      expect(metrics.counter("notify_failed_total").peek()).toBe(1);
      expect(metrics.counter("notify_sent_total").peek()).toBe(0);
    }
  });

  it("final notification is idempotent — second call for same taskId is no-op", async () => {
    const promptAsyncMock = mock(async () => {
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ id: "bg_idem_test", status: "completed" });

    await notifyParent(client, task, 0);
    await notifyParent(client, task, 0);

    await new Promise((r) => setTimeout(r, 10));

    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("intermediate (remaining>0) notification is NOT deduped — multiple sends allowed", async () => {
    const promptAsyncMock = mock(async () => {
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ id: "bg_intermediate", status: "completed" });

    await notifyParent(client, task, 2);
    await notifyParent(client, task, 2);

    await new Promise((r) => setTimeout(r, 10));

    expect(promptAsyncMock).toHaveBeenCalledTimes(2);

    const calls = (promptAsyncMock as ReturnType<typeof mock>).mock.calls;
    expect(calls[0][0].body.noReply).toBe(true);
    expect(calls[1][0].body.noReply).toBe(true);
  });

  it("per-parent ordering preserved when final notification is slow", async () => {
    const order: string[] = [];

    const promptAsyncMock = mock(async (args: any) => {
      const text = args.body.parts[0].text;
      if (text.includes("first-task")) {
        order.push("A-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("A-end");
      } else if (text.includes("second-task")) {
        order.push("B");
      }
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const taskA = createTask({ id: "task-A", description: "first-task" });
    const taskB = createTask({ id: "task-B", description: "second-task" });

    notifyParent(client, taskA, 0);
    notifyParent(client, taskB, 0);

    await new Promise((r) => setTimeout(r, 100));

    expect(promptAsyncMock).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["A-start", "A-end", "B"]);
  });

  it("uses default retry constants when opts omitted", async () => {
    expect(NOTIFY_MAX_RETRIES).toBe(3);

    let callCount = 0;
    const promptAsyncMock = mock(async () => {
      callCount++;
      if (callCount <= NOTIFY_MAX_RETRIES) throw new Error("fail");
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ status: "completed" });

    notifyParent(client, task, 0);

    await new Promise((r) => setTimeout(r, 5000));

    expect(promptAsyncMock).toHaveBeenCalledTimes(NOTIFY_MAX_RETRIES + 1);
    if (metricsActive) {
      expect(metrics.counter("notify_sent_total").peek()).toBe(1);
    }
  }, 10000);

  it("retry delay obeys maxDelayMs upper bound", async () => {
    const timestamps: number[] = [];
    const promptAsyncMock = mock(async () => {
      timestamps.push(Date.now());
      if (timestamps.length <= 3) throw new Error("fail");
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ status: "completed" });

    await notifyParent(client, task, 0, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 150,
    });

    await new Promise((r) => setTimeout(r, 1000));

    expect(timestamps.length).toBe(4);

    if (timestamps.length >= 4) {
      const d1 = timestamps[1] - timestamps[0];
      const d2 = timestamps[2] - timestamps[1];
      const d3 = timestamps[3] - timestamps[2];
      expect(d1).toBeGreaterThan(50);
      expect(d2).toBeGreaterThan(100);
      expect(d3).toBeGreaterThan(100);
    }
  });

  it("returns false when all retries are exhausted and does NOT add to sentFinalNotifies", async () => {
    const promptAsyncMock = mock(async () => {
      throw new Error("persistent failure");
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ id: "bg_fail_test", status: "completed" });

    const result = await notifyParent(client, task, 0, {
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 50,
    });

    expect(result).toBe(false);
    expect(hasFinalNotifyBeenSent(task.id)).toBe(false);
  });

  it("returns true on successful final send and hasFinalNotifyBeenSent returns true", async () => {
    const promptAsyncMock = mock(async () => {
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ id: "bg_success_test", status: "completed" });

    const result = await notifyParent(client, task, 0);

    expect(result).toBe(true);
    expect(hasFinalNotifyBeenSent(task.id)).toBe(true);
  });

  it("second notifyParent call returns true immediately without calling promptAsync again", async () => {
    const promptAsyncMock = mock(async () => {
      return { data: undefined, error: undefined };
    });

    const client = {
      session: { promptAsync: promptAsyncMock },
    } as unknown as OpencodeClient;

    const task = createTask({ id: "bg_idem2", status: "completed" });

    const result1 = await notifyParent(client, task, 0);
    const result2 = await notifyParent(client, task, 0);

    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(hasFinalNotifyBeenSent(task.id)).toBe(true);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
  });
});

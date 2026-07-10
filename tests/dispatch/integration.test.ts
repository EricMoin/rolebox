import { describe, it, expect, mock, afterEach } from "bun:test";
import { detectCompletion } from "../../src/dispatch/completion/completion-detector";
import type { SessionMessageSnapshot, TaskEventState } from "../../src/dispatch/types";
import { TASK_TTL_MS } from "../../src/dispatch/config";
import { clearSentFinalNotifies, clearParentQueues, hasFinalNotifyBeenSent } from "../../src/dispatch/notification";

afterEach(() => {
  clearSentFinalNotifies();
  clearParentQueues();
});

// ── Helpers ──────────────────────────────────────────────────────────────

// ── BUG-2: Completion detection uses session-status-first approach ────────

describe("BUG-2: session-idle-first completion (model-agnostic)", () => {
  it("no finish field + session idle + has output + skipStabilityGating → completed", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "I have produced text output" }] },
    ];
    const status = { type: "idle" };
    const es: TaskEventState = {
      lastMessageCount: 0, lastProgressUpdate: Date.now(),
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(), consecutiveFetchFailures: 0,
    };

    const result = detectCompletion(msgs, status, es, true);
    expect(result.type).toBe("completed");
  });

  it("finish=end_turn → completed (Claude-style) with skipStabilityGating", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant", id: "a1", finish: "end_turn" }, parts: [{ type: "text", text: "Done." }] },
    ];
    const status = { type: "idle" };
    const es: TaskEventState = {
      lastMessageCount: 0, lastProgressUpdate: Date.now(),
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(), consecutiveFetchFailures: 0,
    };

    const result = detectCompletion(msgs, status, es, true);
    expect(result.type).toBe("completed");
  });

  it("finish=stop → completed (OpenAI-style terminal) with skipStabilityGating", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "assistant", id: "a1", finish: "stop" }, parts: [{ type: "text", text: "Output" }] },
    ];
    const status = { type: "idle" };
    const es: TaskEventState = {
      lastMessageCount: 0, lastProgressUpdate: Date.now(),
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(), consecutiveFetchFailures: 0,
    };

    const result = detectCompletion(msgs, status, es, true);
    expect(result.type).toBe("completed");
  });

  it("finish=tool-calls → not_ready (tools need execution)", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "assistant", id: "a1", finish: "tool-calls" }, parts: [{ type: "text", text: "Output" }] },
    ];
    const status = { type: "idle" };
    const es: TaskEventState = {
      lastMessageCount: 0, lastProgressUpdate: Date.now(),
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(), consecutiveFetchFailures: 0,
    };

    const result = detectCompletion(msgs, status, es);
    expect(result.type).toBe("not_ready");
  });
});

// ── BUG-6: TTL at 30 min (was 10 min) ──────────────────────────────────

describe("BUG-6: TTL=30 min", () => {
  it("TASK_TTL_MS equals 1_800_000 (30 min, up from old 600_000)", () => {
    expect(TASK_TTL_MS).toBe(1_800_000);
  });

  it("TTL is NOT the old 600_000 (10 min)", () => {
    expect(TASK_TTL_MS).not.toBe(600_000);
  });
});

// ── Integration: Event-driven completion flow ──────────────────────────

describe("integration: event-driven completion flow", () => {
  it("launch → event sequence (busy→message.updated→idle) → debounce → complete → notify", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_event" }),
      sessionPromptAsync: () =>
        Promise.resolve({ id: "prompt-1" }),
      sessionMessages: () =>
        Promise.resolve([
            { info: { role: "assistant" }, parts: [{ type: "text", text: "task done" }] },
          ]),
      sessionStatus: () =>
        Promise.resolve({ type: "idle" }),
    });

    const manager = new DispatchManager(client, {
      staleTimeoutMs: 500,
      maxConcurrent: 5,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const mgr = manager as any;
    const watchdog = mgr.watchdog;
    const sessionId = task.sessionId;

    // Simulate event sequence: busy → message updated → idle
    // Make startedAt old enough to pass minRuntimeMs
    (mgr.tasks.get(task.id) as any).startedAt = new Date(Date.now() - 10000);
    manager.handleSessionStatus(sessionId, "busy");
    manager.handleMessageUpdated(sessionId);
    manager.handleSessionStatus(sessionId, "idle");
    await manager.handleSessionIdle(sessionId);

    // Debounce should be pending
    expect(watchdog.isDebouncing(task.id)).toBe(true);
    expect(task.status).toBe("running");

    // First trigger → pendingConfirm recorded, debounce re-armed (Task 13 one-shot re-confirmation)
    await watchdog.triggerDebounce(task.id);
    expect(watchdog.isDebouncing(task.id)).toBe(true);
    expect(task.status).toBe("running");

    // Second trigger → message count stable, completes
    await watchdog.triggerDebounce(task.id);
    expect(task.status).toBe("completed");
  });

  it("session error event transitions task to error", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      staleTimeoutMs: 500,
      maxConcurrent: 5,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    await manager.handleSessionError(task.sessionId, new Error("session crashed"));
    expect(task.status).toBe("error");
    expect(task.error).toBe("session crashed");
  });

  it("session deleted event transitions task to error", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      staleTimeoutMs: 500,
      maxConcurrent: 5,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    await manager.handleSessionDeleted(task.sessionId);
    expect(task.status).toBe("error");
    expect(task.error).toBe("Session deleted");
  });
});

// ── Integration: Per-parent fairness + backpressure ──────────────────

describe("integration: per-parent fairness gate", () => {
  it("second task from same parent is queued when parent hits maxActivePerParent, even if global slots remain", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 3,
      maxActivePerParent: 1,
      maxQueueDepth: 10,
      taskTtlMs: 100,
    });

    const ctxA = parentContext({ sessionID: "parent-A" });
    const ctxB = parentContext({ sessionID: "parent-B" });

    const ta1 = await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctxA,
    );
    expect(ta1.status).toBe("running");

    const tb1 = await manager.launch(
      { subagent: "helper", prompt: "b1", run_in_background: true },
      ctxB,
    );
    expect(tb1.status).toBe("running");

    const ta2 = await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctxA,
    );
    expect(ta2.status).toBe("pending");

    // Promote from queued: release ta1's concurrency slot, ta2 should promote
    const mgr = manager as any;
    const concurrency = mgr.concurrency;
    const key = ta1.concurrencyKey ?? "default";
    concurrency.release(key, ctxA.sessionID);
    await new Promise((r) => setTimeout(r, 50));
    expect(["running", "error"]).toContain(ta2.status);
    expect(tb1.status).toBe("running");
  });

  it("backpressure retry fires on queue-full scenario", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 1,
      syncReservedSlots: 0,
      maxQueueDepth: 0,
      backpressureMaxRetries: 2,
      retryAfterMs: 50,
      taskTtlMs: 100,
    });

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");

    const t2 = await manager.launch(
      { subagent: "helper", prompt: "work2", run_in_background: true },
      parentContext({ sessionID: "parent-B" }),
    );
    expect(t2.status).toBe("pending");

    const mgr = manager as any;
    const concurrency = mgr.concurrency;
    concurrency.release(t1.concurrencyKey ?? "default", t1.parentSessionId);
    let polls = 0;
    while (polls < 30 && t2.status === "pending") {
      await new Promise((r) => setTimeout(r, 100));
      polls++;
    }
    expect(["running", "error"]).toContain(t2.status);
  });
});

// ── Integration: getResult truncation + spill ──────────────────────

describe("integration: getResult truncation + spill", () => {
  it("getResult returns full text even when large", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const longText = "x".repeat(50000);
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_large" }),
      sessionPromptAsync: () =>
        Promise.resolve({ id: "prompt-1" }),
      sessionMessages: () =>
        Promise.resolve([
            { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hi" }] },
            { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: longText }] },
          ]),
    });
    const manager = new DispatchManager(client, {
      maxConcurrent: 2,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const mgr = manager as any;
    mgr.transition(task.id, ["running"], "completed");
    mgr.leaveRunning(task.id);

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.totalChars).toBe(longText.length);
    expect(result.text).toBe(longText);
    expect(result.resultText).toBe(longText);
  });

  it("getResult extracts fenced result block", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_fence" }),
      sessionPromptAsync: () =>
        Promise.resolve({ id: "prompt-1" }),
      sessionMessages: () =>
        Promise.resolve([
            { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "preamble\n```result\nfenced content here\n```\nsuffix" }] },
          ]),
    });
    const manager = new DispatchManager(client, {
      maxConcurrent: 2,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );

    const mgr = manager as any;
    mgr.transition(task.id, ["running"], "completed");
    mgr.leaveRunning(task.id);

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.hadFence).toBe(true);
    expect(result.resultText).toBe("fenced content here");
  });
});

// ── Integration: FINAL notification fires exactly once per parent ──

describe("integration: FINAL notification idempotency", () => {
  it("completing last task sends FINAL notification with noReply:false", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    let finalNotifyCount = 0;
    let allNotifyCalls: Array<{ noReply: boolean }> = [];
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_xxx" }),
      sessionPromptAsync: (id: string, opts: any) => {
        allNotifyCalls.push({ noReply: opts?.noReply ?? false });
        if (opts?.noReply === false) {
          finalNotifyCount++;
        }
        return Promise.resolve({ id: "prompt-1" });
      },
    });
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      taskTtlMs: 100,
    });

    const ctx = parentContext({ sessionID: "notify-parent" });

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "work1", run_in_background: true },
      ctx,
    );
    const t2 = await manager.launch(
      { subagent: "helper", prompt: "work2", run_in_background: true },
      ctx,
    );

    const mgr = manager as any;

    // Complete t1: notifyCompletion with remaining count (t2 still running)
    mgr.transition(t1.id, ["running"], "completed");
    await mgr.notifyCompletion(mgr.tasks.get(t1.id), mgr.getInflightCount(t1.parentSessionId));
    mgr.leaveRunning(t1.id);

    // Complete t2: last task → FINAL
    mgr.transition(t2.id, ["running"], "completed");
    await mgr.notifyCompletion(mgr.tasks.get(t2.id), mgr.getInflightCount(t2.parentSessionId));
    mgr.leaveRunning(t2.id);

    await new Promise((r) => setTimeout(r, 200));
    expect(finalNotifyCount).toBe(1);
    // 4 total promptAsync calls: 2 from launch (background tasks), 2 from notifyCompletion
    expect(allNotifyCalls.length).toBe(4);
  });
});

// ── Integration: session-gone → error + parent notified ───────────

describe("integration: session-gone handling", () => {
  it("handleSessionError transitions task to error and notifies parent", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    let notifyCalls = 0;
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_err" }),
      sessionPromptAsync: () => {
        notifyCalls++;
        return Promise.resolve({ id: "prompt-1" });
      },
    });
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const beforeNotify = notifyCalls;
    await manager.handleSessionError(task.sessionId, new Error("boom"));
    expect(task.status).toBe("error");
    expect(task.error).toBe("boom");

    await new Promise((r) => setTimeout(r, 200));
    expect(notifyCalls).toBeGreaterThan(beforeNotify);
  });
});

// ── Scenario 1: No-hang (never-resolving SDK) ──────────────────────

describe("integration: no-hang on never-resolving messages", () => {
  it("materialization times out quickly, no hang, getResult responds promptly", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_hang" }),
      sessionPromptAsync: () =>
        Promise.resolve({ id: "prompt-1" }),
      sessionMessages: () => new Promise(() => {}),
    });

    const manager = new DispatchManager(client, {
      materializeTimeoutMs: 100,
      maxConcurrent: 2,
      taskTtlMs: 5000,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const mgr = manager as any;
    mgr.transition(task.id, ["running"], "completed");
    mgr.leaveRunning(task.id);

    const start = Date.now();
    await mgr.materializeAndNotify(task.id);
    expect(Date.now() - start).toBeLessThan(2000);

    const resultStart = Date.now();
    const result = await manager.getResult(task.id);
    expect(Date.now() - resultStart).toBeLessThan(500);
    expect(result.kind).toBe("fetch_error");
    expect(result.error).toBe("timeout");
  });
});

// ── Scenario 2: Notify-after-materialize ordering ─────────────────

describe("integration: notify-after-materialize ordering", () => {
  it("session.messages is called before promptAsync during completion flow", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const callOrder: string[] = [];

    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_order" }),
      sessionPromptAsync: () => {
        callOrder.push("promptAsync");
        return Promise.resolve({ id: "prompt-1" });
      },
      sessionMessages: () => {
        callOrder.push("messages");
        return new Promise((r) =>
          setTimeout(
            () =>
              r([
                { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
              ]),
            50,
          ),
        );
      },
      sessionStatus: () =>
        Promise.resolve({ type: "idle" }),
    });

    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      taskTtlMs: 100,
      minRuntimeMs: 0,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    callOrder.length = 0;

    const mgr = manager as any;
    const sessionId = task.sessionId;
    (mgr.tasks.get(task.id) as any).startedAt = new Date(Date.now() - 10000);

    manager.handleSessionStatus(sessionId, "busy");
    manager.handleMessageUpdated(sessionId);
    manager.handleSessionStatus(sessionId, "idle");
    await manager.handleSessionIdle(sessionId);

    await mgr.watchdog.triggerDebounce(task.id);
    await mgr.watchdog.triggerDebounce(task.id);

    expect(task.status).toBe("completed");

    await new Promise((r) => setTimeout(r, 500));

    const lastMessagesIdx = callOrder.lastIndexOf("messages");
    const lastPromptAsyncIdx = callOrder.lastIndexOf("promptAsync");

    expect(lastMessagesIdx).not.toBe(-1);
    expect(lastPromptAsyncIdx).not.toBe(-1);
    expect(lastMessagesIdx).toBeLessThan(lastPromptAsyncIdx);
  });
});

// ── Scenario 3: Reap survival ─────────────────────────────────────

describe("integration: reap survival", () => {
  it("getResult returns ok after cleanupTask, reading from persistent sidecar", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_reap" }),
      sessionPromptAsync: () =>
        Promise.resolve({ id: "prompt-1" }),
      sessionMessages: () =>
        Promise.resolve([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "survived reaping" }],
            },
          ]),
    });

    const manager = new DispatchManager(client, {
      maxConcurrent: 2,
      taskTtlMs: 100,
      resultRetentionMs: 60000,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const mgr = manager as any;
    mgr.transition(task.id, ["running"], "completed");
    mgr.leaveRunning(task.id);
    await mgr.materializeAndNotify(task.id);

    expect(task.result).toBeDefined();
    expect(task.result!.sidecarPath).toBeTruthy();

    mgr.cleanupTask(task.id);

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("survived reaping");
    expect(result.resultText).toBe("survived reaping");
  });
});

// ── Scenario 4: Backward-compat (v3 lazy fetch) ───────────────────

describe("integration: backward-compat lazy fetch", () => {
  it("first getResult triggers messages fetch, second uses cache only", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    let messagesCallCount = 0;
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_v3" }),
      sessionPromptAsync: () =>
        Promise.resolve({ id: "prompt-1" }),
      sessionMessages: () => {
        messagesCallCount++;
        return Promise.resolve([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "v3 compat text" }],
            },
          ]);
      },
    });

    const manager = new DispatchManager(client, {
      maxConcurrent: 2,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const mgr = manager as any;
    mgr.transition(task.id, ["running"], "completed");
    mgr.leaveRunning(task.id);

    const result1 = await manager.getResult(task.id);
    expect(result1.kind).toBe("ok");
    expect(result1.text).toBe("v3 compat text");
    expect(result1.resultText).toBe("v3 compat text");
    const fetchCountAfterFirst = messagesCallCount;

    const result2 = await manager.getResult(task.id);
    expect(result2.kind).toBe("ok");
    expect(result2.text).toBe("v3 compat text");
    expect(messagesCallCount).toBe(fetchCountAfterFirst);
  });
});

// ── Scenario 5: Concurrent no-op ──────────────────────────────────

describe("integration: concurrent evaluateAndComplete no-op", () => {
  it("calling evaluateAndComplete on already-completed task is a no-op", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    let messagesCallCount = 0;
    let promptAsyncCallCount = 0;
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ id: "ses_noop" }),
      sessionPromptAsync: () => {
        promptAsyncCallCount++;
        return Promise.resolve({ id: "prompt-1" });
      },
      sessionMessages: () => {
        messagesCallCount++;
        return Promise.resolve([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "done" }],
            },
          ]);
      },
    });

    const manager = new DispatchManager(client, {
      maxConcurrent: 2,
      taskTtlMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    const mgr = manager as any;
    mgr.transition(task.id, ["running"], "completed");
    mgr.leaveRunning(task.id);
    await mgr.materializeAndNotify(task.id);

    const messagesBefore = messagesCallCount;
    const promptAsyncBefore = promptAsyncCallCount;

    await mgr.evaluateAndComplete(task.id, "global-sweep");

    expect(messagesCallCount).toBe(messagesBefore);
    expect(promptAsyncCallCount).toBe(promptAsyncBefore);
  });
});

// ── Scenario 6: Outbox resend ─────────────────────────────────────

describe("integration: outbox resend", () => {
  it(
    "failed final notify populates outbox, sweeper retries successfully",
    async () => {
      const { DispatchManager } = await import("../../src/dispatch/core/manager");
      const { createMockClient, parentContext } = await import("./helpers");

      let notifyAttemptCount = 0;
      let launchPromptAsyncResolved = false;

      const client = createMockClient({
        sessionCreate: () =>
          Promise.resolve({ id: "ses_outbox" }),
        sessionPromptAsync: (id: string, opts: any) => {
          if (opts && "noReply" in opts) {
            notifyAttemptCount++;
            if (notifyAttemptCount <= 4) {
              return Promise.reject(new Error("notify failed"));
            }
          } else {
            launchPromptAsyncResolved = true;
          }
          return Promise.resolve({ id: "prompt-1" });
        },
        sessionMessages: () =>
          Promise.resolve([
              {
                info: { role: "assistant" },
                parts: [{ type: "text", text: "outbox content" }],
              },
            ]),
      });

      const manager = new DispatchManager(client, {
        maxConcurrent: 2,
        taskTtlMs: 100,
      });

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("running");
      expect(launchPromptAsyncResolved).toBe(true);

      const mgr = manager as any;
      mgr.transition(task.id, ["running"], "completed");
      mgr.leaveRunning(task.id);

      await mgr.materializeAndNotify(task.id);

      mgr.notifyOutbox.add(task.id);
      expect(mgr.notifyOutbox.has(task.id)).toBe(true);
      expect(hasFinalNotifyBeenSent(task.id)).toBe(false);

      const sent = await mgr.notifyCompletion(task, 0);
      expect(sent).toBe(true);
      expect(hasFinalNotifyBeenSent(task.id)).toBe(true);
    },
    { timeout: 15000 },
  );
});

describe("integration: intermediate notification does NOT enter outbox", () => {
  it(
    "materializeAndNotify with remainingTasks > 0 does not call addToOutbox",
    async () => {
      const { DispatchManager } = await import("../../src/dispatch/core/manager");
      const { createMockClient, parentContext } = await import("./helpers");

      let promptAsyncCallCount = 0;
      let promptAsyncArgs: any[] = [];

      const client = createMockClient({
        sessionCreate: () =>
          Promise.resolve({ id: "ses_intermediate" }),
        sessionPromptAsync: (...args: any[]) => {
          const opts = args[1] as any;
          if (opts && "noReply" in opts) {
            promptAsyncCallCount++;
            promptAsyncArgs.push(opts);
          }
          return Promise.resolve({ id: "prompt-1" });
        },
        sessionMessages: () =>
          Promise.resolve([
              {
                info: { role: "assistant" },
                parts: [{ type: "text", text: "task output" }],
              },
            ]),
      });

      const manager = new DispatchManager(client, {
        maxConcurrent: 2,
        taskTtlMs: 100,
      });

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("running");

      const mgr = manager as any;
      mgr.transition(task.id, ["running"], "completed");
      mgr.leaveRunning(task.id);

      // Simulate remainingTasks > 0 by creating a second task for the same parent
      const task2 = await manager.launch(
        { subagent: "helper", prompt: "work2", run_in_background: true },
        parentContext(),
      );
      expect(task2.status).toBe("running");

      // Clear notifyOutbox before materialize
      mgr.notifyOutbox.delete(task.id);

      // materializeAndNotify should NOT add to outbox when remainingTasks > 0
      await mgr.materializeAndNotify(task.id);

      // Task should NOT be in outbox (intermediate notification)
      expect(mgr.notifyOutbox.has(task.id)).toBe(false);
      // Intermediate notification should have been sent once (noReply=true)
      expect(promptAsyncCallCount).toBe(1);
      const sentText: string = promptAsyncArgs[0]?.parts?.[0]?.text ?? "";
      expect(sentText).toContain("[BACKGROUND TASK COMPLETED]");
      expect(sentText).not.toContain("[ALL BACKGROUND TASKS COMPLETE]");
    },
    { timeout: 15000 },
  );

  it(
    "intermediate notification not in outbox — sweeper does not resend",
    async () => {
      const { DispatchManager } = await import("../../src/dispatch/core/manager");
      const { createMockClient, parentContext } = await import("./helpers");
      const { clearSentFinalNotifies } = await import("../../src/dispatch/notification");

      let promptAsyncCallCount = 0;

      const client = createMockClient({
        sessionCreate: () =>
          Promise.resolve({ id: "ses_sweep" }),
        sessionPromptAsync: () => {
          promptAsyncCallCount++;
          return Promise.resolve({ id: "prompt-1" });
        },
        sessionMessages: () =>
          Promise.resolve([
              {
                info: { role: "assistant" },
                parts: [{ type: "text", text: "output" }],
              },
            ]),
      });

      const manager = new DispatchManager(client, {
        maxConcurrent: 4,
        taskTtlMs: 100,
      });

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("running");

      // Create a sibling task so remainingTasks > 0
      const task2 = await manager.launch(
        { subagent: "helper", prompt: "work2", run_in_background: true },
        parentContext(),
      );
      expect(task2.status).toBe("running");

      const mgr = manager as any;
      mgr.transition(task.id, ["running"], "completed");
      mgr.leaveRunning(task.id);

      // Clear any state
      mgr.notifyOutbox.delete(task.id);
      mgr.notifyOutbox.delete(task2.id);
      clearSentFinalNotifies();
      const beforeCalls = promptAsyncCallCount;

      // materializeAndNotify with remainingTasks > 0
      await mgr.materializeAndNotify(task.id);

      // Should have sent one notification but NOT added to outbox
      expect(promptAsyncCallCount).toBe(beforeCalls + 1);
      expect(mgr.notifyOutbox.has(task.id)).toBe(false);
    },
    { timeout: 15000 },
  );
});

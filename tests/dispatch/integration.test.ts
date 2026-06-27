import { describe, it, expect } from "bun:test";
import { detectCompletion } from "../../src/dispatch/completion-detector";
import type { SessionMessageSnapshot, TaskEventState } from "../../src/dispatch/types";
import { TASK_TTL_MS } from "../../src/dispatch/config";

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
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(),
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
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(),
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
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(),
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
      hasProducedOutput: true, messageCountAtStart: 0, lastEventAt: Date.now(),
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
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ data: { id: "ses_event" }, error: undefined }),
      sessionPromptAsync: () =>
        Promise.resolve({ data: undefined, error: undefined }),
      sessionMessages: () =>
        Promise.resolve({
          data: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "task done" }] },
          ],
          error: undefined,
        }),
      sessionStatus: () =>
        Promise.resolve({
          data: { ses_event: { type: "idle" } },
          error: undefined,
        }),
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

    // Trigger the debounce → task completes
    await watchdog.triggerDebounce(task.id);
    expect(task.status).toBe("completed");
  });

  it("session error event transitions task to error", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
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
    expect(task.error).toBe("Task error event received");
  });

  it("session deleted event transitions task to error", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
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

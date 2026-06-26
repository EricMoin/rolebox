import { describe, it, expect, mock, afterEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { DispatchManager } from "../../src/dispatch/manager";

// ── helpers ──────────────────────────────────────────────────────

function createMockClient(overrides?: {
  sessionCreate?: () => unknown;
  sessionPrompt?: () => unknown;
  sessionPromptAsync?: () => unknown;
  sessionMessages?: () => unknown;
  sessionStatus?: () => unknown;
  sessionAbort?: () => unknown;
  sessionGet?: () => unknown;
}) {
  return {
    session: {
      create: mock(
        overrides?.sessionCreate ??
          (() =>
            Promise.resolve({
              data: { id: "test-session-1" },
              error: undefined,
            })),
      ),
      prompt: mock(
        overrides?.sessionPrompt ??
          (() =>
            Promise.resolve({
              data: {
                parts: [
                  { type: "text" as const, text: "Hello from subagent" },
                ],
              },
              error: undefined,
            })),
      ),
      promptAsync: mock(
        overrides?.sessionPromptAsync ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
      messages: mock(
        overrides?.sessionMessages ??
          (() =>
            Promise.resolve({
              data: [],
              error: undefined,
            })),
      ),
      status: mock(
        overrides?.sessionStatus ??
          (() =>
            Promise.resolve({
              data: {},
              error: undefined,
            })),
      ),
      abort: mock(
        overrides?.sessionAbort ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
      get: mock(
        overrides?.sessionGet ??
          (() =>
            Promise.resolve({
              data: { id: "test-session-1" },
              error: undefined,
            })),
      ),
    },
  } as unknown as OpencodeClient;
}

function parentContext() {
  return {
    sessionID: "parent-session-1",
    agent: "parent-agent",
    directory: "/tmp/test",
  };
}

const fastConfig = {
  staleTimeoutMs: 500,
  maxConcurrent: 5,
  taskTtlMs: 100,
};

// ── tests ────────────────────────────────────────────────────────

describe("DispatchManager", () => {
  afterEach(() => {
    mock.restore();
  });

  // ── 1. launch() ──────────────────────────────────────────────

  it("launch() creates a task and registers with global poller when run_in_background is true", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "do background work",
        run_in_background: true,
        description: "bg task",
      },
      parentContext(),
    );

    expect(task.id).toMatch(/^bg_/);
    expect(task.status).toBe("running");
    expect(task.sessionId).toBe("test-session-1");
    expect(task.parentSessionId).toBe("parent-session-1");
    expect(task.agent).toBe("helper");
    expect(task.prompt).toBe("do background work");
    expect(task.description).toBe("bg task");
    expect(task.startedAt).toBeInstanceOf(Date);

    // Verify client calls
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("launch() handles session create failure with error status", async () => {
    const client = createMockClient({
      sessionCreate: () => {
        throw new Error("create failed");
      },
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "fail",
        run_in_background: true,
      },
      parentContext(),
    );

    expect(task.status).toBe("error");
    expect(task.error).toBe("create failed");
  });

  // ── 2. executeSync() ─────────────────────────────────────────

  it("executeSync() creates session, prompts, and returns result text", async () => {
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: {
            parts: [
              { type: "text" as const, text: "Result line 1." },
              { type: "text" as const, text: "Result line 2." },
            ],
          },
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client);

    const result = await manager.executeSync(
      {
        subagent: "reviewer",
        prompt: "review this",
        run_in_background: false,
      },
      parentContext(),
    );

    expect(result).toBe("Result line 1.Result line 2.");
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("executeSync() returns empty string when response is undefined", async () => {
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve({
          data: undefined,
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client);

    const result = await manager.executeSync(
      {
        subagent: "reviewer",
        prompt: "review",
        run_in_background: false,
      },
      parentContext(),
    );

    expect(result).toBe("");
  });

  // ── 3. cancelTask() ──────────────────────────────────────────

  it("cancelTask() aborts session and updates status to cancelled", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "work",
        run_in_background: true,
      },
      parentContext(),
    );

    const result = await manager.cancelTask(task.id);

    expect(result).toBe(true);
    expect(task.status).toBe("cancelled");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("cancelTask() returns false for unknown task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const result = await manager.cancelTask("nonexistent-task");
    expect(result).toBe(false);
  });

  it("cancelTask() returns false for completed task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.status = "completed";

    const result = await manager.cancelTask(task.id);
    expect(result).toBe(false);
    expect(taskRef.status).toBe("completed"); // unchanged
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("cancelTask() returns false for errored task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.status = "error";

    const result = await manager.cancelTask(task.id);
    expect(result).toBe(false);
    expect(taskRef.status).toBe("error"); // unchanged
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("cancelTask() returns false for cancelled task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.status = "cancelled";

    const result = await manager.cancelTask(task.id);
    expect(result).toBe(false);
    expect(taskRef.status).toBe("cancelled"); // unchanged
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("cancelTask() returns false for timed out task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.status = "timeout";

    const result = await manager.cancelTask(task.id);
    expect(result).toBe(false);
    expect(taskRef.status).toBe("timeout"); // unchanged
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("cancelTask() returns false when notification is in-flight", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );

    (manager as any).pendingNotifications.add(task.id);

    const result = await manager.cancelTask(task.id);
    expect(result).toBe(false);
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  // ── 4. getResult() ───────────────────────────────────────────

  it("getResult() extracts text from assistant messages", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "user" as const },
              parts: [{ type: "text" as const, text: "prompt" }],
            },
            {
              info: { role: "assistant" as const },
              parts: [
                { type: "text" as const, text: "Analysis:" },
                { type: "text" as const, text: "Complete." },
              ],
            },
          ],
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client);

    // launch a task so getResult has a session to query
    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "analyze",
        run_in_background: false,
      },
      parentContext(),
    );

    const result = await manager.getResult(task.id);
    expect(result).toBe("Analysis:Complete.");
  });

  it("getResult() returns empty string for unknown task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const result = await manager.getResult("unknown");
    expect(result).toBe("");
  });

  it("getResult() returns error indicator string when messages API returns error", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: undefined,
          error: { message: "session expired" },
        }),
    });
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "analyze",
        run_in_background: false,
      },
      parentContext(),
    );

    const result = await manager.getResult(task.id);
    expect(result).toContain("[Error");
    expect(result).not.toBe("");
  });

  // ── 5. getTask() ─────────────────────────────────────────────

  it("getTask() returns undefined for unknown task", () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    expect(manager.getTask("nonexistent")).toBeUndefined();
  });

  it("getTask() returns the correct task by id", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "work",
        run_in_background: false,
      },
      parentContext(),
    );

    const found = manager.getTask(task.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);
    expect(found!.agent).toBe("helper");
  });

  // ── 6. getTasksByParent() ────────────────────────────────────

  it("getTasksByParent() returns only tasks for the given parent session", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const ctx1 = { sessionID: "parent-1", agent: "a", directory: "/tmp" };
    const ctx2 = { sessionID: "parent-2", agent: "b", directory: "/tmp" };

    const t1 = await manager.launch(
      { subagent: "h1", prompt: "p1", run_in_background: false },
      ctx1,
    );
    const t2 = await manager.launch(
      { subagent: "h2", prompt: "p2", run_in_background: false },
      ctx1,
    );
    await manager.launch(
      { subagent: "h3", prompt: "p3", run_in_background: false },
      ctx2,
    );

    const parent1Tasks = manager.getTasksByParent("parent-1");
    expect(parent1Tasks.length).toBe(2);
    expect(parent1Tasks.map((t) => t.id).sort()).toEqual(
      [t1.id, t2.id].sort(),
    );

    const parent2Tasks = manager.getTasksByParent("parent-2");
    expect(parent2Tasks.length).toBe(1);

    const emptyTasks = manager.getTasksByParent("parent-3");
    expect(emptyTasks.length).toBe(0);
  });

  // ── 7. cleanupTask() ─────────────────────────────────────────

  it("cleanupTask() removes task from store", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );

    expect(manager.getTask(task.id)).toBeDefined();
    manager.cleanupTask(task.id);
    expect(manager.getTask(task.id)).toBeUndefined();
  });

  // ── 8. handleSessionIdle() ────────────────────────────────────

  it("handleSessionIdle swallows messages API error", async () => {
    const client = createMockClient({
      sessionMessages: () => Promise.reject(new Error("network failure")),
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.sessionId = "some-session-id";
    taskRef.status = "running";
    taskRef.startedAt = new Date(Date.now() - 10000);

    await expect(manager.handleSessionIdle("some-session-id")).resolves.toBeUndefined();
    expect(taskRef.status).toBe("running");
  });

  // ── 9. bounded cleanedUpTasks ─────────────────────────────

  it("does not grow unbounded (FIFO eviction at 500)", () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    // Directly populate cleanedUpTasks through cleanupTask
    // by first populating the tasks map so cleanupTask can delete them
    const mgr = manager as any;
    const taskIds: string[] = [];
    for (let i = 0; i < 600; i++) {
      const tid = `task_${i}`;
      taskIds.push(tid);
      mgr.tasks.set(tid, { id: tid });
      manager.cleanupTask(tid);
    }

    const cleaned = mgr.cleanedUpTasks as string[];
    expect(cleaned.length).toBe(500);

    // Most recent 500 entries should still be recognized
    for (let i = 100; i < 600; i++) {
      expect(cleaned.includes(taskIds[i])).toBe(true);
    }

    // Oldest entries (first 100) should have been evicted
    for (let i = 0; i < 100; i++) {
      expect(cleaned.includes(taskIds[i])).toBe(false);
    }
  });

  // ── 10. double-completion guard ──────────────────────────────

  describe("double-completion guard", () => {
    it("handleTaskCompleted twice does not double-release concurrency", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      const mgr = manager as any;
      const concurrencyKey = "default";

      expect(mgr.concurrency.getActiveCount(concurrencyKey)).toBe(1);

      mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount(concurrencyKey)).toBe(0);

      mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount(concurrencyKey)).toBe(0);
    });

    it("handleTaskCompleted on error-status task is no-op", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      const mgr = manager as any;
      const t = mgr.tasks.get(task.id);
      t.status = "error";
      t.completedAt = new Date("2024-01-01");
      const origCompletedAt = t.completedAt;

      mgr.handleTaskCompleted(task.id);
      expect(t.status).toBe("error");
      expect(t.completedAt).toBe(origCompletedAt);
    });

    it("handleTaskError on completed-status task is no-op", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      const mgr = manager as any;
      mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");

      mgr.handleTaskError(task.id, "some error");
      expect(task.status).toBe("completed");
      expect(task.error).toBeUndefined();
    });

    it("handleTaskTimeout on cancelled-status task is no-op", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      const mgr = manager as any;
      mgr.handleTaskCompleted(task.id);

      const t = mgr.tasks.get(task.id);
      t.status = "cancelled";
      t.completedAt = new Date("2024-01-01");
      const origCompletedAt = t.completedAt;

      mgr.handleTaskTimeout(task.id, "timeout reason");
      expect(t.status).toBe("cancelled");
      expect(t.completedAt).toBe(origCompletedAt);
    });
  });
});

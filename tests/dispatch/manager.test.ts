import { describe, it, expect, mock, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/manager";
import { TaskStateStore } from "../../src/dispatch/task-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockClient, parentContext } from "./helpers";
import { metrics } from "../../src/dispatch/metrics";

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

  // ── 2b. executeSync() hardened ───────────────────────────────

  it("T7: executeSync acquires slot from shared concurrency pool", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, { ...fastConfig, syncTimeoutMs: 5000 });
    const mgr = manager as any;

    // Fill all slots with non-releasing acquires
    await Promise.all(Array.from({ length: 5 }, () => mgr.concurrency.acquire("default")));
    expect(mgr.concurrency.getActiveCount("default")).toBe(5);

    // executeSync will block since pool is full
    const syncPromise = manager.executeSync(
      { subagent: "sync-test", prompt: "hello", run_in_background: false },
      parentContext(),
    );

    // Release one slot — sync should acquire it
    mgr.concurrency.release("default");

    const result = await syncPromise;
    expect(result).toBe("Hello from subagent");
    // After completion, sync released its slot: 4 bg + 0 sync = 4
    expect(mgr.concurrency.getActiveCount("default")).toBe(4);
  });

  it("T8: executeSync prompt timeout releases slot and aborts session", async () => {
    const client = createMockClient({
      sessionPrompt: () => new Promise<never>(() => {}), // never resolves
      sessionAbort: () => Promise.resolve({ data: undefined, error: undefined }),
    });
    const manager = new DispatchManager(client, { ...fastConfig, syncTimeoutMs: 20 });
    const mgr = manager as any;

    await expect(
      manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ),
    ).rejects.toThrow(/timed out/);

    expect(mgr.concurrency.getActiveCount("default")).toBe(0);
    expect(client.session.abort).toHaveBeenCalled();
  });

  it("T9: executeSync acquire timeout cancels orphaned waiter", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, { ...fastConfig, syncTimeoutMs: 20 });
    const mgr = manager as any;

    // Fill pool to limit
    await Promise.all(Array.from({ length: 5 }, () => mgr.concurrency.acquire("default")));
    expect(mgr.concurrency.getActiveCount("default")).toBe(5);

    // executeSync will time out waiting for a slot
    await expect(
      manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ),
    ).rejects.toThrow(/concurrency slot/);

    // Pool should still have 5 active (no slot leaked)
    expect(mgr.concurrency.getActiveCount("default")).toBe(5);

    // Release one — should not hand it to the cancelled sync waiter
    mgr.concurrency.release("default");
    expect(mgr.concurrency.getActiveCount("default")).toBe(4);
  });

  it("T10: executeSync shares concurrency pool with background tasks", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, { ...fastConfig, syncTimeoutMs: 50 });
    const mgr = manager as any;

    // Fill 4 background + 1 sync = 5 total (at limit)
    await Promise.all(Array.from({ length: 4 }, () => mgr.concurrency.acquire("default")));

    // sync acquires 5th slot
    const syncPromise = manager.executeSync(
      { subagent: "sync-test", prompt: "hello", run_in_background: false },
      parentContext(),
    );
    const result = await syncPromise;
    expect(result).toBe("Hello from subagent");
    // Sync released its slot
    expect(mgr.concurrency.getActiveCount("default")).toBe(4);
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

  it("cleanupTask → getResult() returns empty string for cleaned-up task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );

    const tid = task.id;
    manager.cleanupTask(tid);
    expect(manager.getTask(tid)).toBeUndefined();

    const result = await manager.getResult(tid);
    expect(result).toBe("");
  });

  it("cleanupTask FIFO trim at 501 entries keeps size 500 and evicts oldest", () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const taskIds: string[] = [];
    for (let i = 0; i < 501; i++) {
      const tid = `fifo_task_${i}`;
      taskIds.push(tid);
      mgr.tasks.set(tid, { id: tid });
      manager.cleanupTask(tid);
    }

    const cleaned = mgr.cleanedUpTasks as Set<string>;
    expect(cleaned.size).toBe(500);
    expect(cleaned.has(taskIds[0])).toBe(false);
    expect(cleaned.has(taskIds[500])).toBe(true);
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

    const cleaned = mgr.cleanedUpTasks as Set<string>;
    expect(cleaned.size).toBe(500);

    // Most recent 500 entries should still be recognized
    for (let i = 100; i < 600; i++) {
      expect(cleaned.has(taskIds[i])).toBe(true);
    }

    // Oldest entries (first 100) should have been evicted
    for (let i = 0; i < 100; i++) {
      expect(cleaned.has(taskIds[i])).toBe(false);
    }
  });

  // ── 9b. inflight counter ─────────────────────────────────────

  describe("inflight counter", () => {
    it("tracks remaining tasks per parent, decrements on completion", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const ctx = parentContext();
      const mgr = manager as any;

      const t1 = await manager.launch(
        { subagent: "h", prompt: "p1", run_in_background: true },
        ctx,
      );
      const t2 = await manager.launch(
        { subagent: "h", prompt: "p2", run_in_background: true },
        ctx,
      );
      const t3 = await manager.launch(
        { subagent: "h", prompt: "p3", run_in_background: true },
        ctx,
      );

      expect(mgr.inflightByParent.get("parent-session-1")).toBe(3);

      // Complete first
      mgr.handleTaskCompleted(t1.id);
      expect(mgr.inflightByParent.get("parent-session-1")).toBe(2);

      // Complete second
      mgr.handleTaskCompleted(t2.id);
      expect(mgr.inflightByParent.get("parent-session-1")).toBe(1);

      // Complete third — counter cleaned up at 0
      mgr.handleTaskCompleted(t3.id);
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();
    });

    it("handles multiple parents independently", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const ctx1 = { sessionID: "parent-A", agent: "a", directory: "/tmp" };
      const ctx2 = { sessionID: "parent-B", agent: "b", directory: "/tmp" };

      const tA = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx1,
      );
      const tB1 = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx2,
      );
      const tB2 = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx2,
      );

      expect(mgr.inflightByParent.get("parent-A")).toBe(1);
      expect(mgr.inflightByParent.get("parent-B")).toBe(2);

      mgr.handleTaskCompleted(tA.id);
      expect(mgr.inflightByParent.get("parent-A")).toBeUndefined();
      expect(mgr.inflightByParent.get("parent-B")).toBe(2);

      mgr.handleTaskCompleted(tB1.id);
      expect(mgr.inflightByParent.get("parent-B")).toBe(1);
    });

    it("decrements on task error", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const ctx = parentContext();
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx,
      );
      expect(mgr.inflightByParent.get("parent-session-1")).toBe(1);

      mgr.handleTaskError(task.id, "something broke");
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();
    });

    it("decrements on task timeout", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const ctx = parentContext();
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx,
      );
      expect(mgr.inflightByParent.get("parent-session-1")).toBe(1);

      mgr.handleTaskTimeout(task.id, "timed out");
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();
    });

    it("decrements on cancel", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const ctx = parentContext();
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx,
      );
      expect(mgr.inflightByParent.get("parent-session-1")).toBe(1);

      await manager.cancelTask(task.id);
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();
    });

    it("does not double-decrement on double-completion", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const ctx = parentContext();
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx,
      );
      expect(mgr.inflightByParent.get("parent-session-1")).toBe(1);

      mgr.handleTaskCompleted(task.id);
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();

      // Second completion is no-op (transition fails), counter stays gone
      mgr.handleTaskCompleted(task.id);
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();
    });

    it("reverts inflight count when launch fails after reaching running", async () => {
      const client = createMockClient({
        sessionPromptAsync: () => Promise.reject(new Error("promptAsync failed")),
      });
      const manager = new DispatchManager(client, fastConfig);
      const ctx = parentContext();
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        ctx,
      );

      expect(task.status).toBe("error");
      expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();
    });

    it("getInflight returns 0 for unknown parent", () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      expect(mgr.getInflight("nonexistent-parent")).toBe(0);
    });
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

  // ── 11. handleSessionIdle race-guard ──────────────────────────

  describe("handleSessionIdle race-guard", () => {
    it("poller wins during session.idle async gap — idle no-ops, single release", async () => {
      const client = createMockClient();
      // Deferred promise that idle will await
      let resolveMessages!: (v: any) => void;
      const deferred = new Promise<any>((r) => { resolveMessages = r; });

      const sessionMessagesMock = mock(() => deferred);
      client.session.messages = sessionMessagesMock;

      const manager = new DispatchManager(client, fastConfig);

      // Launch a task
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      const mgr = manager as any;
      const t = mgr.tasks.get(task.id);
      t.sessionId = "idle-session";
      t.startedAt = new Date(Date.now() - 10000);

      // Call handleSessionIdle — it will suspend at messages await
      const idlePromise = manager.handleSessionIdle("idle-session");

      // While suspended, poller completes via handleTaskCompleted
      mgr.handleTaskCompleted(task.id);
      expect(t.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);

      // Now resolve the deferred — idle resumes
      resolveMessages({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      });
      await idlePromise;

      // After idle resumes: status still completed, concurrency still 0 (no double-release)
      expect(t.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);
    });

    it("second handleSessionIdle for same task is a no-op", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      const mgr = manager as any;
      const t = mgr.tasks.get(task.id);
      t.sessionId = "idle-session-2";
      t.startedAt = new Date(Date.now() - 10000);

      // Set mock messages to return valid output
      client.session.messages = mock(() => Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      }));

      // First idle — should complete the task
      await manager.handleSessionIdle("idle-session-2");
      expect(t.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);

      // Second idle — should no-op (no throw, no state change)
      await manager.handleSessionIdle("idle-session-2");
      expect(t.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);
    });
  });

  // ── 12. pool-rejected cleanup ──────────────────────────────────

  describe("pool-rejected cleanup", () => {
    it("rejected task is scheduled for cleanup and notified", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1 });
      const mgr = manager as any;

      // Fill the single slot
      await mgr.concurrency.acquire("default");

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(task.status).toBe("error");
      expect(task.error).toContain("Pool is full");
      expect(task.completedAt).toBeInstanceOf(Date);

      // Verify cleanup was scheduled
      expect(mgr.cleanupTimers.has(task.id)).toBe(true);

      const timer = mgr.cleanupTimers.get(task.id);
      expect(timer).toBeDefined();

      // Clean up
      mgr.concurrency.release("default");
      clearTimeout(timer);
    });

    it("pool-rejected does not consume a concurrency slot", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1 });
      const mgr = manager as any;

      // Fill the single slot
      await mgr.concurrency.acquire("default");
      expect(mgr.concurrency.getActiveCount("default")).toBe(1);

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(task.status).toBe("error");
      // Still exactly 1 — rejected task never acquired
      expect(mgr.concurrency.getActiveCount("default")).toBe(1);

      mgr.concurrency.release("default");
    });
  });

  // ── 13. gauge leak prevention (requires ROLEBOX_METRICS=1) ────

  describe("gauge leak prevention", () => {
    it("gauge returns to baseline after handleTaskCompleted", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(g.peek()).toBe(baseline + 1);
      mgr.handleTaskCompleted(task.id);
      expect(g.peek()).toBe(baseline);
    });

    it("gauge returns to baseline after handleTaskError", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(g.peek()).toBe(baseline + 1);
      mgr.handleTaskError(task.id, "something broke");
      expect(g.peek()).toBe(baseline);
    });

    it("gauge returns to baseline after handleTaskTimeout", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(g.peek()).toBe(baseline + 1);
      mgr.handleTaskTimeout(task.id, "timed out");
      expect(g.peek()).toBe(baseline);
    });

    it("gauge returns to baseline after cancelTask", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(g.peek()).toBe(baseline + 1);
      await manager.cancelTask(task.id);
      expect(g.peek()).toBe(baseline);
    });

    it("gauge returns to baseline after launch catch (promptAsync failure)", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient({
        sessionPromptAsync: () => Promise.reject(new Error("promptAsync failed")),
      });
      const manager = new DispatchManager(client, fastConfig);
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(task.status).toBe("error");
      expect(g.peek()).toBe(baseline);
    });

    it("pool-rejected does not affect inflight gauge", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1 });
      const mgr = manager as any;
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      const t1 = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(g.peek()).toBe(baseline + 1);

      const t2 = await manager.launch(
        { subagent: "h", prompt: "p2", run_in_background: true },
        parentContext(),
      );

      expect(t2.status).toBe("error");
      expect(t2.error).toContain("Pool is full");
      expect(g.peek()).toBe(baseline + 1);

      mgr.handleTaskCompleted(t1.id);
      expect(g.peek()).toBe(baseline);
    });
  });
});

// ── 11. recover() ─────────────────────────────────────────────

describe("recover()", () => {
  function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "manager-recover-test-"));
  }

  it("recover() with no persisted state is a no-op", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    await manager.recover();

    expect(manager.getTask("nonexistent")).toBeUndefined();
  });

  it("recover() restores running tasks and re-registers them with poller", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();

    // Manually persist tasks via TaskStateStore
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const runningTask: DispatchTask = {
      id: "bg_recovered",
      sessionId: "ses_alive",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "helper",
      prompt: "work",
      description: "recovered task",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(runningTask.id, runningTask);
    store.save(tasks);

    // Create manager simulating restart
    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    // Running task should be in memory
    const loaded = manager.getTask("bg_recovered");
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("running");

    // Poller should have the running task registered
    expect((manager as any).poller.getTaskCount()).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() marks dead sessions as error", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionGet: () =>
        Promise.resolve({ data: undefined, error: undefined }),
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const runningTask: DispatchTask = {
      id: "bg_dead",
      sessionId: "ses_dead",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "helper",
      prompt: "work",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(runningTask.id, runningTask);
    store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    const loaded = manager.getTask("bg_dead");
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("Session lost");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() handles session.get API error gracefully", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionGet: () => {
        throw new Error("connection failed");
      },
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const runningTask: DispatchTask = {
      id: "bg_err",
      sessionId: "ses_err",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "helper",
      prompt: "work",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(runningTask.id, runningTask);
    store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    const loaded = manager.getTask("bg_err");
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("verification failed");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() silently removes pending tasks", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const pendingTask: DispatchTask = {
      id: "bg_pending",
      sessionId: "ses_pending",
      parentSessionId: "ses_parent",
      status: "pending",
      agent: "helper",
      prompt: "work",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(pendingTask.id, pendingTask);
    store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    // Pending task is silently removed (no error, just absent)
    expect(manager.getTask("bg_pending")).toBeUndefined();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover with running tasks within limit registers all with poller", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    for (let i = 0; i < 3; i++) {
      const t: DispatchTask = {
        id: `bg_rec_${i}`,
        sessionId: `ses_${i}`,
        parentSessionId: "ses_parent",
        status: "running",
        agent: "helper",
        prompt: "work",
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(t.id, t);
    }
    store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.concurrency.getActiveCount("default")).toBe(3);
    expect(mgr.poller.getTaskCount()).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(manager.getTask(`bg_rec_${i}`)?.status).toBe("running");
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover with more running tasks than limit errors excess tasks", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    for (let i = 0; i < 6; i++) {
      const t: DispatchTask = {
        id: `bg_over_${i}`,
        sessionId: `ses_${i}`,
        parentSessionId: "ses_parent",
        status: "running",
        agent: "helper",
        prompt: "work",
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(t.id, t);
    }
    store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.poller.getTaskCount()).toBe(5);
    expect(mgr.concurrency.getActiveCount("default")).toBe(5);

    let errorCount = 0;
    for (let i = 0; i < 6; i++) {
      const t = manager.getTask(`bg_over_${i}`);
      if (t?.status === "error" && t.error?.includes("Exceeded concurrency limit")) {
        errorCount++;
      }
    }
    expect(errorCount).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inflight counter reflects recovered running tasks", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    for (let i = 0; i < 3; i++) {
      const t: DispatchTask = {
        id: `bg_inf_${i}`,
        sessionId: `ses_${i}`,
        parentSessionId: "ses_parent",
        status: "running",
        agent: "helper",
        prompt: "work",
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(t.id, t);
    }
    store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.inflightByParent.get("ses_parent")).toBe(3);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

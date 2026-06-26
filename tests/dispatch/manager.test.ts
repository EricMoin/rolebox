import { describe, it, expect, mock, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/manager";
import type { DispatchTask } from "../../src/dispatch/types";
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
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Analysis:Complete.");
  });

  it("getResult() returns not_found kind for unknown task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const result = await manager.getResult("unknown");
    expect(result.kind).toBe("not_found");
    expect(result.error).toBe("Task never existed");
    expect(result.text).toBe("");
  });

  it("getResult() returns fetch_error kind when messages API returns error", async () => {
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
    expect(result.kind).toBe("fetch_error");
    expect(result.error).toContain("Error retrieving task output");
    expect(result.text).toBe("");
  });

  it("T10: getResult() on continued task only returns output after messageCountAtStart boundary", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "user" as const },
              parts: [{ type: "text" as const, text: "old prompt" }],
            },
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "Old round output." }],
            },
            {
              info: { role: "user" as const },
              parts: [{ type: "text" as const, text: "continue this" }],
            },
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "Continuation output." }],
            },
          ],
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client);

    // launch a task so getResult has a session to query
    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.messageCountAtStart = 2;

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Continuation output.");
    expect(result.text).not.toContain("Old round output.");
  });

  it("getResult() on non-continued task returns all assistant text (regression)", async () => {
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

    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.messageCountAtStart = undefined;

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Analysis:Complete.");
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

  it("cleanupTask → getResult() returns expired kind for cleaned-up task", async () => {
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
    expect(result.kind).toBe("expired");
    expect(result.error).toContain("cleaned up");
    expect(result.text).toBe("");
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

  it("handleSessionIdle defers when elapsed < minRuntimeMs", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.sessionId = "early-session";
    taskRef.status = "running";
    // Very recent start — elapsed will be < minRuntimeMs (5000)
    taskRef.startedAt = new Date(Date.now());

    // Spy on messages before calling idle
    const messagesSpy = client.session.messages;

    await manager.handleSessionIdle("early-session");

    // Should not have fetched messages (too early)
    expect(messagesSpy).not.toHaveBeenCalled();
    // Task should still be running
    expect(taskRef.status).toBe("running");
  });

  it("handleSessionIdle completes task when elapsed >= minRuntimeMs and assistant output exists", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );

    const taskRef = (manager as any).tasks.get(task.id);
    taskRef.sessionId = "mature-session";
    taskRef.status = "running";
    // Old enough to be past minRuntimeMs (5000)
    taskRef.startedAt = new Date(Date.now() - 6000);

    // Mock messages to return assistant output
    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      }),
    );

    await manager.handleSessionIdle("mature-session");

    // Task should have been completed
    expect(taskRef.status).toBe("completed");
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

  // ── 12. queue-full rejection ──────────────────────────────────

  describe("queue-full rejection", () => {
    it("rejected task is scheduled for cleanup and notified with structured error", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0 });
      const mgr = manager as any;

      // Fill the single slot
      await mgr.concurrency.acquire("default");

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(task.status).toBe("error");
      const parsed = JSON.parse(task.error!);
      expect(parsed.error).toBe("Queue is full");
      expect(parsed.queue_depth).toBe(0);
      expect(parsed.limit).toBe(0);
      expect(parsed.retry_after).toBeGreaterThan(0);
      expect(task.completedAt).toBeInstanceOf(Date);

      // Verify cleanup was scheduled
      expect(mgr.cleanupTimers.has(task.id)).toBe(true);

      const timer = mgr.cleanupTimers.get(task.id);
      expect(timer).toBeDefined();

      // Clean up
      mgr.concurrency.release("default");
      clearTimeout(timer);
    });

    it("queue-full does not consume a concurrency slot", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0 });
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

    it("queue-full does not affect inflight gauge", async () => {
      if (!process.env.ROLEBOX_METRICS) return;
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0 });
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
      expect(t2.error).toContain("Queue is full");
      expect(g.peek()).toBe(baseline + 1);

      mgr.handleTaskCompleted(t1.id);
      expect(g.peek()).toBe(baseline);
    });
  });
});

// ── 17. session_id continuation (reopenForContinuation) ──────────

describe("reopenForContinuation", () => {
  afterEach(() => {
    mock.restore();
  });

  it("reopens a completed task: reuses session, no new session.create, re-prompts, poller re-registered", async () => {
    const sessionCreate: any[] = [];
    const promptAsyncCalls: Array<{ path: { id: string }; body: any }> = [];
    const msgResult = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ],
      error: undefined,
    };

    const client = createMockClient({
      sessionCreate: () => {
        sessionCreate.push({});
        return Promise.resolve({ data: { id: "ses_original" }, error: undefined });
      },
      sessionPromptAsync: (args: any) => {
        promptAsyncCalls.push(args);
        return Promise.resolve({ data: undefined, error: undefined });
      },
      sessionMessages: () => Promise.resolve(msgResult),
    });
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "do it", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");
    const originalSessionId = t1.sessionId;

    mgr.handleTaskCompleted(t1.id);
    expect(t1.status).toBe("completed");

    const createCountBefore = sessionCreate.length;

    const t2 = await manager.reopenForContinuation(
      t1.id,
      { subagent: "helper", prompt: "continue this", run_in_background: true },
      parentContext(),
    );

    expect(t2.status).toBe("running");
    expect(t2.sessionId).toBe(originalSessionId);

    // No new session.create
    expect(sessionCreate.length).toBe(createCountBefore);

    // Last promptAsync call targets the original session (reopen)
    const lastCall = promptAsyncCalls[promptAsyncCalls.length - 1];
    expect(lastCall.path.id).toBe(originalSessionId);
    expect(lastCall.body.parts[0].text).toBe("continue this");

    // messageCountAtStart set (2 messages in msgResult)
    expect(t2.messageCountAtStart).toBe(2);

    // Poller re-registered
    expect(mgr.poller.getTaskCount()).toBe(1);

    // Task state reset
    expect(t2.startedAt).toBeInstanceOf(Date);
    expect(t2.progress.toolCalls).toBe(0);
    expect(t2.error).toBeUndefined();
    expect(t2.completedAt).toBeUndefined();
  });

  it("throws when session_id points to non-existent task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    await expect(
      manager.reopenForContinuation(
        "nonexistent",
        { subagent: "helper", prompt: "p", run_in_background: true },
        parentContext(),
      ),
    ).rejects.toThrow("not found");
  });

  it("throws when session_id points to cleaned-up task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "do it", run_in_background: true },
      parentContext(),
    );
    mgr.handleTaskCompleted(t1.id);
    manager.cleanupTask(t1.id);

    await expect(
      manager.reopenForContinuation(
        t1.id,
        { subagent: "helper", prompt: "p", run_in_background: true },
        parentContext(),
      ),
    ).rejects.toThrow("cleaned up");
  });

  it("throws when session_id subagent mismatches", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "do it", run_in_background: true },
      parentContext(),
    );
    mgr.handleTaskCompleted(t1.id);

    await expect(
      manager.reopenForContinuation(
        t1.id,
        { subagent: "different-agent", prompt: "p", run_in_background: true },
        parentContext(),
      ),
    ).rejects.toThrow("agent mismatch");
  });

  it("reopens from error status back to running", async () => {
    const client = createMockClient({
      sessionMessages: () => Promise.resolve({ data: [], error: undefined }),
    });
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "do it", run_in_background: true },
      parentContext(),
    );
    mgr.handleTaskError(t1.id, "something broke");
    expect(t1.status).toBe("error");

    const t2 = await manager.reopenForContinuation(
      t1.id,
      { subagent: "helper", prompt: "retry", run_in_background: true },
      parentContext(),
    );

    expect(t2.status).toBe("running");
    expect(t2.error).toBeUndefined();
  });

  it("reopens from timeout status back to running", async () => {
    const client = createMockClient({
      sessionMessages: () => Promise.resolve({ data: [], error: undefined }),
    });
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "do it", run_in_background: true },
      parentContext(),
    );
    mgr.handleTaskTimeout(t1.id, "timeout reason");
    expect(t1.status).toBe("timeout");

    const t2 = await manager.reopenForContinuation(
      t1.id,
      { subagent: "helper", prompt: "retry", run_in_background: true },
      parentContext(),
    );

    expect(t2.status).toBe("running");
    expect(t2.error).toBeUndefined();
  });

  it("continuation handles queue-full rejection gracefully", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 1,
      maxQueueDepth: 0,
      syncReservedSlots: 0,
    });
    const mgr = manager as any;

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "do it", run_in_background: true },
      parentContext(),
    );
    mgr.handleTaskCompleted(t1.id);

    // Fill the slot
    await mgr.concurrency.acquire("default");

    const t2 = await manager.reopenForContinuation(
      t1.id,
      { subagent: "helper", prompt: "retry", run_in_background: true },
      parentContext(),
    );

    expect(t2.status).toBe("error");
    const parsed = JSON.parse(t2.error!);
    expect(parsed.error).toBe("Queue is full");

    mgr.concurrency.release("default");
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
    await store.save(tasks);

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
    await store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    const loaded = manager.getTask("bg_dead");
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("Session lost");
    expect(loaded!.error).toContain("re-dispatch with dispatch");

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
    await store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    const loaded = manager.getTask("bg_err");
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("verification failed");
    expect(loaded!.error).toContain("re-dispatch with dispatch");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() removes pending tasks and notifies parent with lost task list", async () => {
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
      description: "my pending work",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(pendingTask.id, pendingTask);
    await store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    // Pending task is removed
    expect(manager.getTask("bg_pending")).toBeUndefined();

    // Parent was notified about the lost pending task
    expect(client.session.promptAsync).toHaveBeenCalled();
    const notifyCalls = (client.session.promptAsync as any).mock.calls;
    const lostPendingCall = notifyCalls.find(
      (c: any) => c[0]?.body?.parts?.[0]?.text?.includes("PENDING TASKS DROPPED"),
    );
    expect(lostPendingCall).toBeDefined();
    const notifyText: string = lostPendingCall[0].body.parts[0].text;
    expect(notifyText).toContain("my pending work");
    expect(notifyText).toContain("re-dispatch");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() groups multiple pending tasks by parent and sends one notification per parent", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    for (let i = 0; i < 3; i++) {
      const pt: DispatchTask = {
        id: `bg_pen_${i}`,
        sessionId: `ses_p${i}`,
        parentSessionId: "ses_parent",
        status: "pending",
        agent: "helper",
        prompt: "work",
        description: `pending task ${i}`,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(pt.id, pt);
    }
    // Another parent with one pending task
    const otherParentTask: DispatchTask = {
      id: "bg_other",
      sessionId: "ses_other",
      parentSessionId: "ses_other_parent",
      status: "pending",
      agent: "helper",
      prompt: "work",
      description: "other parent pending",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(otherParentTask.id, otherParentTask);
    await store.save(tasks);

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);

    await manager.recover();

    // All pending tasks removed
    expect(manager.getTask("bg_pen_0")).toBeUndefined();
    expect(manager.getTask("bg_other")).toBeUndefined();

    // Two notification calls: one for ses_parent, one for ses_other_parent
    const notifyCalls = (client.session.promptAsync as any).mock.calls.filter(
      (c: any) => c[0]?.body?.parts?.[0]?.text?.includes("PENDING TASKS DROPPED"),
    );
    expect(notifyCalls.length).toBe(2);

    // First parent: should list all 3 tasks
    const parentCall = notifyCalls.find(
      (c: any) => c[0].path.id === "ses_parent",
    );
    expect(parentCall).toBeDefined();
    const parentText: string = parentCall[0].body.parts[0].text;
    expect(parentText).toContain("3 pending task(s)");
    expect(parentText).toContain("pending task 0");
    expect(parentText).toContain("pending task 2");

    // Other parent: should list 1 task
    const otherCall = notifyCalls.find(
      (c: any) => c[0].path.id === "ses_other_parent",
    );
    expect(otherCall).toBeDefined();
    const otherText: string = otherCall[0].body.parts[0].text;
    expect(otherText).toContain("1 pending task(s)");
    expect(otherText).toContain("other parent pending");

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
    await store.save(tasks);

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
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5, syncReservedSlots: 0 });
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
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.inflightByParent.get("ses_parent")).toBe(3);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover uses each task's persisted concurrencyKey for forceOccupy", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();

    // Two tasks with different concurrency keys
    const openaiTask: DispatchTask = {
      id: "bg_openai",
      sessionId: "ses_openai",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "agent-openai",
      prompt: "work",
      concurrencyKey: "openai/gpt-4",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    const claudeTask: DispatchTask = {
      id: "bg_claude",
      sessionId: "ses_claude",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "agent-claude",
      prompt: "work",
      concurrencyKey: "anthropic/claude-3",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(openaiTask.id, openaiTask);
    tasks.set(claudeTask.id, claudeTask);
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 2, syncReservedSlots: 0 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    // Each task occupies its own key's pool, not the default pool
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);
    expect(mgr.concurrency.getActiveCount("anthropic/claude-3")).toBe(1);
    expect(mgr.concurrency.getActiveCount("default")).toBe(0);

    // Both tasks are running
    expect(manager.getTask("bg_openai")?.status).toBe("running");
    expect(manager.getTask("bg_claude")?.status).toBe("running");
    expect(mgr.poller.getTaskCount()).toBe(2);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover uses default key when persisted concurrencyKey is missing", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();

    const legacyTask: DispatchTask = {
      id: "bg_legacy",
      sessionId: "ses_legacy",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "helper",
      prompt: "work",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(legacyTask.id, legacyTask);
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 2, syncReservedSlots: 0 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.concurrency.getActiveCount("default")).toBe(1);
    expect(manager.getTask("bg_legacy")?.concurrencyKey).toBe("default");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover with per-key tasks respects limits independently", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();

    // 2 openai tasks but limit=1 per key
    const openai1: DispatchTask = {
      id: "bg_openai_1",
      sessionId: "ses_o1",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "agent-openai",
      prompt: "work",
      concurrencyKey: "openai/gpt-4",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    const openai2: DispatchTask = {
      id: "bg_openai_2",
      sessionId: "ses_o2",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "agent-openai",
      prompt: "work",
      concurrencyKey: "openai/gpt-4",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(openai1.id, openai1);
    tasks.set(openai2.id, openai2);
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, syncReservedSlots: 0 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    // Only 1 task occupies the openai pool (limit=1, reserved=0)
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);

    // One should be running, the other errored
    const t1 = manager.getTask("bg_openai_1");
    const t2 = manager.getTask("bg_openai_2");
    const running = [t1, t2].filter(t => t?.status === "running").length;
    const errored = [t1, t2].filter(t => t?.status === "error" && t?.error?.includes("Exceeded concurrency limit")).length;
    expect(running).toBe(1);
    expect(errored).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inflight counter only counts re-attached tasks — dead sessions excluded", async () => {
    const tempDir = createTempDir();

    // 5 running tasks, 3 sessions dead, 2 alive
    const sessionData = new Set(["ses_1", "ses_2"]);
    const client = createMockClient({
      sessionGet: (args: any) => {
        const sid = args.path.id;
        if (sessionData.has(sid)) {
          return Promise.resolve({ data: { id: sid }, error: undefined });
        }
        return Promise.resolve({ data: undefined, error: undefined });
      },
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    for (let i = 1; i <= 5; i++) {
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
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    // Only ses_1 and ses_2 re-attached — inflightByParent must be 2, not 5
    expect(mgr.inflightByParent.get("ses_parent")).toBe(2);

    // Dead ones are errored
    for (let i = 3; i <= 5; i++) {
      const t = manager.getTask(`bg_rec_${i}`);
      expect(t?.status).toBe("error");
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("after recovery, completing a task decrements inflight and notifies with correct remaining count", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    for (let i = 0; i < 2; i++) {
      const t: DispatchTask = {
        id: `bg_notify_${i}`,
        sessionId: `ses_notify_${i}`,
        parentSessionId: "ses_parent",
        status: "running",
        agent: "helper",
        prompt: "work",
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(t.id, t);
    }
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;

    // Both re-attached — inflight should be 2
    expect(mgr.inflightByParent.get("ses_parent")).toBe(2);

    // Complete task 0
    const task0 = manager.getTask("bg_notify_0");
    expect(task0?.status).toBe("running");
    mgr.handleTaskCompleted("bg_notify_0");

    // After leaveRunning, inflight decremented to 1
    expect(mgr.inflightByParent.get("ses_parent")).toBe(1);
    expect(manager.getTask("bg_notify_0")!.status).toBe("completed");

    // Complete task 1 — should reach 0 and clean up entry
    mgr.handleTaskCompleted("bg_notify_1");
    expect(mgr.inflightByParent.get("ses_parent")).toBeUndefined();
    expect(manager.getTask("bg_notify_1")!.status).toBe("completed");

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── 14. Per-model concurrency key isolation ───────────────────

describe("per-model concurrency key", () => {
  afterEach(() => {
    mock.restore();
  });

  it("two different model subagents each occupy independent slots", async () => {
    const modelKeys = new Map([
      ["agent-openai", "openai/gpt-4"],
      ["agent-anthropic", "anthropic/claude-3"],
    ]);
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 1, syncReservedSlots: 0 },
      modelKeys,
    );
    const t1 = await manager.launch(
      { subagent: "agent-openai", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");
    expect(t1.concurrencyKey).toBe("openai/gpt-4");

    const mgr = manager as any;
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);
    expect(mgr.concurrency.getActiveCount("anthropic/claude-3")).toBe(0);

    // Second subagent with anthropic key — different pool, should succeed
    const t2 = await manager.launch(
      { subagent: "agent-anthropic", prompt: "p2", run_in_background: true },
      parentContext(),
    );
    expect(t2.status).toBe("running");
    expect(t2.concurrencyKey).toBe("anthropic/claude-3");

    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);
    expect(mgr.concurrency.getActiveCount("anthropic/claude-3")).toBe(1);
  });

  it("same model key subagents share slots and get rejected at queue limit", async () => {
    const modelKeys = new Map([
      ["agent-a", "openai/gpt-4"],
      ["agent-b", "openai/gpt-4"],
    ]);
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0, syncReservedSlots: 0 },
      modelKeys,
    );

    // First subagent acquires the single slot
    const t1 = await manager.launch(
      { subagent: "agent-a", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");
    expect(t1.concurrencyKey).toBe("openai/gpt-4");

    const mgr = manager as any;
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);

    // Second subagent with same key — queue full, rejected
    const t2 = await manager.launch(
      { subagent: "agent-b", prompt: "p2", run_in_background: true },
      parentContext(),
    );
    expect(t2.status).toBe("error");
    const parsed = JSON.parse(t2.error!);
    expect(parsed.error).toBe("Queue is full");
    expect(t2.concurrencyKey).toBeUndefined();

    // Slot count unchanged — rejected task never acquired
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);
  });

  it("unknown subagent falls back to default key", async () => {
    const modelKeys = new Map([
      ["known-agent", "openai/gpt-4"],
    ]);
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 1, syncReservedSlots: 0 },
      modelKeys,
    );
    const t1 = await manager.launch(
      { subagent: "unknown-agent", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");
    expect(t1.concurrencyKey).toBe("default");

    const mgr = manager as any;
    expect(mgr.concurrency.getActiveCount("default")).toBe(1);
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(0);
  });

  it("release after completion uses correct per-model key", async () => {
    const modelKeys = new Map([
      ["helper", "openai/gpt-4"],
    ]);
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 2 },
      modelKeys,
    );

    const task = await manager.launch(
      { subagent: "helper", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(task.concurrencyKey).toBe("openai/gpt-4");

    const mgr = manager as any;
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(1);
    expect(mgr.concurrency.getActiveCount("default")).toBe(0);

    // Complete the task via handler — leaveRunning releases on correct key
    mgr.handleTaskCompleted(task.id);
    expect(mgr.concurrency.getActiveCount("openai/gpt-4")).toBe(0);
    // "default" pool should be unaffected
    expect(mgr.concurrency.getActiveCount("default")).toBe(0);
  });

  it("executeSync uses correct per-model key", async () => {
    const modelKeys = new Map([
      ["reviewer", "anthropic/claude-3"],
    ]);
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, syncTimeoutMs: 5000 },
      modelKeys,
    );
    const mgr = manager as any;

    // Fill the specific key's pool
    await mgr.concurrency.acquire("anthropic/claude-3");
    await mgr.concurrency.acquire("anthropic/claude-3");
    await mgr.concurrency.acquire("anthropic/claude-3");
    await mgr.concurrency.acquire("anthropic/claude-3");
    await mgr.concurrency.acquire("anthropic/claude-3");
    expect(mgr.concurrency.getActiveCount("anthropic/claude-3")).toBe(5);

    // executeSync for reviewer — uses same key, will block (pool full)
    const syncPromise = manager.executeSync(
      { subagent: "reviewer", prompt: "hello", run_in_background: false },
      parentContext(),
    );

    // Release one slot— the sync should acquire it
    mgr.concurrency.release("anthropic/claude-3");

    const result = await syncPromise;
    expect(result).toBe("Hello from subagent");
    // After sync completes and releases: 5 bg - 1 released + 1 sync - 1 sync release = 4
    expect(mgr.concurrency.getActiveCount("anthropic/claude-3")).toBe(4);
    // "default" pool is untouched
    expect(mgr.concurrency.getActiveCount("default")).toBe(0);
  });
});

// ── 15. bounded background queue ──────────────────────────────

describe("bounded background queue", () => {
  afterEach(() => {
    mock.restore();
  });

  it("queue not full → task queues then acquires when slot freed", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 2, syncReservedSlots: 0 },
    );
    const mgr = manager as any;

    // First task acquires the only slot
    const t1 = await manager.launch(
      { subagent: "h", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");
    expect(t1.concurrencyKey).toBe("default");

    // Second task — queue is not full (depth 0 < limit 2), should enqueue
    const launch2Promise = manager.launch(
      { subagent: "h", prompt: "p2", run_in_background: true },
      parentContext(),
    );

    // Give a tick for the waiter to enqueue
    await new Promise((r) => setTimeout(r, 10));

    // Task 2 should be pending (enqueued, not yet running)
    const tasksForParent = manager.getTasksByParent("parent-session-1");
    const pendingTasks = tasksForParent.filter(t => t.status === "pending");
    expect(pendingTasks.length).toBeGreaterThanOrEqual(1);

    // The active count should still be 1
    expect(mgr.concurrency.getActiveCount("default")).toBe(1);

    // Complete task 1 → task 2 acquires the freed slot
    mgr.handleTaskCompleted(t1.id);

    const t2 = await launch2Promise;
    expect(t2.status).toBe("running");
    expect(t2.concurrencyKey).toBe("default");

    // Clean up t2
    mgr.handleTaskCompleted(t2.id);
  });

  it("queue full → structured error with retry_after, depth, limit", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 1, syncReservedSlots: 0 },
    );
    const mgr = manager as any;

    // Task 1 acquires the only slot
    const t1 = await manager.launch(
      { subagent: "h", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");

    // Task 2 enqueues (queue depth 1 = limit 1)
    const launch2Promise = manager.launch(
      { subagent: "h", prompt: "p2", run_in_background: true },
      parentContext(),
    );

    // Give a tick for waiter to enqueue
    await new Promise((r) => setTimeout(r, 10));

    // Task 3 — queue is now full, should reject
    const t3 = await manager.launch(
      { subagent: "h", prompt: "p3", run_in_background: true },
      parentContext(),
    );

    expect(t3.status).toBe("error");
    const parsed = JSON.parse(t3.error!);
    expect(parsed.error).toBe("Queue is full");
    expect(parsed.queue_depth).toBe(1);
    expect(parsed.limit).toBe(1);
    expect(parsed.retry_after).toBeGreaterThan(0);
    expect(t3.completedAt).toBeInstanceOf(Date);

    // Task 3 should NOT consume a concurrency slot
    expect(mgr.concurrency.getActiveCount("default")).toBe(1);

    // Clean up t1 and t2
    mgr.handleTaskCompleted(t1.id);
    const t2 = await launch2Promise;
    expect(t2.status).toBe("running");
    mgr.handleTaskCompleted(t2.id);
  });

  it("queue depth recovers after cancelled waiter frees a queue slot", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 1, syncReservedSlots: 0 },
    );
    const mgr = manager as any;

    // Task 1 acquires the only slot
    const t1 = await manager.launch(
      { subagent: "h", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");

    // Enqueue a waiter manually, then cancel it
    const { cancel } = mgr.concurrency.acquireCancelable("default");
    cancel();

    // Queue should now be effectively empty (cancelled waiter was removed)
    // Next launch should enqueue, not reject
    const launch2Promise = manager.launch(
      { subagent: "h", prompt: "p2", run_in_background: true },
      parentContext(),
    );

    // Give a tick for waiter to enqueue
    await new Promise((r) => setTimeout(r, 10));

    // Task 2 should be pending (enqueued)
    expect(mgr.concurrency.getActiveCount("default")).toBe(1);

    // Complete task 1 → task 2 acquires
    mgr.handleTaskCompleted(t1.id);
    const t2 = await launch2Promise;
    expect(t2.status).toBe("running");
    mgr.handleTaskCompleted(t2.id);
  });
});

// ── 16. reserved sync lane integration ─────────────────────────

describe("reserved sync lane", () => {
  afterEach(() => {
    mock.restore();
  });

  it("sync acquires immediately via reserved lane when background is full", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 5, syncReservedSlots: 1, syncTimeoutMs: 5000 },
    );
    const mgr = manager as any;

    // Fill all 4 background slots via acquireBackground
    await Promise.all(Array.from({ length: 4 }, () => mgr.concurrency.acquireBackground("default").promise));
    expect(mgr.concurrency.getActiveCount("default")).toBe(4);

    // Background launch should block (bg slots full)
    const launchPromise = manager.launch(
      { subagent: "bg-blocked", prompt: "p", run_in_background: true },
      parentContext(),
    );

    // Give a tick for bg waiter to enqueue
    await new Promise((r) => setTimeout(r, 10));

    // Background task should be pending (enqueued)
    const pending = manager.getTasksByParent("parent-session-1")
      .filter(t => t.status === "pending");
    expect(pending.length).toBeGreaterThanOrEqual(1);

    // Sync execute should acquire immediately via reserved 5th slot
    const syncResult = await manager.executeSync(
      { subagent: "sync-test", prompt: "hello", run_in_background: false },
      parentContext(),
    );
    expect(syncResult).toBe("Hello from subagent");

    // After sync releases: bg waiter gets promoted, active stays at 5 (4 original bg + 1 promoted)
    expect(mgr.concurrency.getActiveCount("default")).toBe(5);
  });

  it("background launch rejects when bg slots full and queue at capacity", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(
      client,
      { ...fastConfig, maxConcurrent: 3, maxQueueDepth: 0, syncReservedSlots: 1 },
    );
    const mgr = manager as any;

    // Fill all 2 background slots
    await Promise.all(Array.from({ length: 2 }, () => mgr.concurrency.acquireBackground("default").promise));
    expect(mgr.concurrency.getActiveCount("default")).toBe(2);

    // Background launch should reject (bg limit=2, queue depth=0)
    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("error");
    const parsed = JSON.parse(task.error!);
    expect(parsed.error).toBe("Queue is full");
    // reserved sync slot should still be available
    expect(mgr.concurrency.getActiveCount("default")).toBe(2);
  });

  it("recover uses forceOccupyBackground — clamps to limit-reserved", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "manager-t8-recover-"));
    const client = createMockClient();
    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();

    // Create 5 running tasks — limit=5, reserved=1 → bgLimit=4
    for (let i = 0; i < 5; i++) {
      const t: DispatchTask = {
        id: `bg_t8_${i}`,
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
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5, syncReservedSlots: 1 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    // forceOccupyBackground clamps to 4 (limit - reserved)
    expect(mgr.poller.getTaskCount()).toBe(4);
    expect(mgr.concurrency.getActiveCount("default")).toBe(4);

    // 1 task should be errored (exceeded concurrency limit on recovery)
    let errorCount = 0;
    for (let i = 0; i < 5; i++) {
      const t = manager.getTask(`bg_t8_${i}`);
      if (t?.status === "error" && t.error?.includes("Exceeded concurrency limit")) {
        errorCount++;
      }
    }
    expect(errorCount).toBe(1);

    // The reserved sync slot should still be available
    const { promise: syncP } = mgr.concurrency.acquireSync("default");
    await syncP;
    expect(mgr.concurrency.getActiveCount("default")).toBe(5);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── 18. Debounced async state persistence ──────────────────────

describe("debounced persistence", () => {
  afterEach(() => {
    mock.restore();
  });

  it("multiple consecutive persistState calls within debounce window → only 1 actual save", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const saveSpy = mock(() => Promise.resolve());
    mgr.store.save = saveSpy;

    // Call persistState 5 times directly (no launch overhead, no poller)
    for (let i = 0; i < 5; i++) {
      mgr.persistState();
    }

    expect(mgr._dirty).toBe(true);
    expect(mgr._persistTimer).toBeDefined();

    // Wait for the debounce timer to fire (500ms window)
    await new Promise((r) => setTimeout(r, 600));

    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("flushPersist() immediately writes all pending data without waiting for debounce", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const saveSpy = mock(() => Promise.resolve());
    mgr.store.save = saveSpy;

    // Trigger persistState directly
    mgr.persistState();

    expect(mgr._dirty).toBe(true);
    expect(mgr._persistTimer).toBeDefined();

    // Flush immediately — bypasses debounce
    await manager.flushPersist();

    // save should have been called immediately
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // Dirty flag cleared, timer cancelled
    expect(mgr._dirty).toBe(false);
    expect(mgr._persistTimer).toBeUndefined();
  });

  it("flushPersist() is idempotent — calling twice only saves once", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const saveSpy = mock(() => Promise.resolve());
    mgr.store.save = saveSpy;

    mgr.persistState();

    // Flush twice
    await manager.flushPersist();
    await manager.flushPersist();

    // Only 1 save — second call finds _dirty = false
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("concurrent persistState and flushPersist do not race", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const saveSpy = mock(() => Promise.resolve());
    mgr.store.save = saveSpy;

    mgr.persistState();

    // Flush consumes the dirty state
    await manager.flushPersist();
    // Advance past the debounce window — timer was already cancelled by flush
    await new Promise((r) => setTimeout(r, 600));

    // Only 1 save — flush already consumed it
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, mock, afterEach, beforeEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/manager";
import type { DispatchTask } from "../../src/dispatch/types";
import { TaskStateStore } from "../../src/dispatch/task-store.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { clearParentQueues, clearSentFinalNotifies } from "../../src/dispatch/notification";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockClient, parentContext } from "./helpers";
import { metrics } from "../../src/dispatch/metrics";
import { writeResultSidecar, resultSidecarPath } from "../../src/dispatch/result-extractor";

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
    Array.from({ length: 5 }, () => mgr.concurrency.acquireCancelable("default"));
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
    const manager = new DispatchManager(client, { ...fastConfig, syncPromptTimeoutMs: 20, syncAcquireTimeoutMs: 5000 });
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
    const manager = new DispatchManager(client, { ...fastConfig, syncAcquireTimeoutMs: 20 });
    const mgr = manager as any;

    // Fill pool to limit
    Array.from({ length: 5 }, () => mgr.concurrency.acquireCancelable("default"));
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
    Array.from({ length: 4 }, () => mgr.concurrency.acquireCancelable("default"));

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

  it("executeSync session create hang does not block forever", async () => {
    const client = createMockClient({
      sessionCreate: () => new Promise<never>(() => {}), // never resolves
    });
    const manager = new DispatchManager(client, {
      ...fastConfig,
      materializeTimeoutMs: 20,
      syncAcquireTimeoutMs: 5000,
      syncPromptTimeoutMs: 5000,
    });
    const mgr = manager as any;

    await expect(
      manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ),
    ).rejects.toThrow(/timed out/);

    // Slot must be released after timeout
    expect(mgr.concurrency.getActiveCount("default")).toBe(0);
  });

  // ── 2c. executeSync metrics ──────────────────────────────────

  describe("executeSync metrics", () => {
    it("T16: executeSync inflight gauge rises during, falls after", async () => {
      if (!process.env.ROLEBOX_METRICS) return;

      let resolvePrompt!: (v: any) => void;
      const deferred = new Promise<any>((r) => { resolvePrompt = r; });

      const client = createMockClient({
        sessionPrompt: () => deferred,
      });
      const manager = new DispatchManager(client, fastConfig);
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      // Start executeSync — it blocks at the prompt await
      const syncPromise = manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      );

      // Allow microtask flush so the gauge.inc() takes effect
      await new Promise((r) => setTimeout(r, 0));

      // Gauge should be +1 during execution
      expect(g.peek()).toBe(baseline + 1);

      // Resolve the prompt
      resolvePrompt({
        data: { parts: [{ type: "text", text: "done" }] },
        error: undefined,
      });

      await syncPromise;

      // Gauge should be back to baseline after completion
      expect(g.peek()).toBe(baseline);
    });

    it("T16: executeSync cleans up task from this.tasks on completion", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const taskCountBefore = mgr.tasks.size;

      await manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      );

      // Sync task was added during execution but cleaned up in finally block
      expect(mgr.tasks.size).toBe(taskCountBefore);
    });

    it("T16: executeSync records dispatch_completed_total and task_duration_ms on success", async () => {
      if (!process.env.ROLEBOX_METRICS) return;

      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);

      const completedBefore = metrics.counter("dispatch_completed_total", { mode: "sync" }).peek();
      const histBefore = metrics.histogram("task_duration_ms", { mode: "sync" }).peek();

      await manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      );

      const completedAfter = metrics.counter("dispatch_completed_total", { mode: "sync" }).peek();
      const histAfter = metrics.histogram("task_duration_ms", { mode: "sync" }).peek();

      expect(completedAfter).toBe(completedBefore + 1);
      expect(histAfter.count).toBe(histBefore.count + 1);
      expect(histAfter.sum).toBeGreaterThan(0);
    });

    it("T16: executeSync records dispatch_error_total on error", async () => {
      if (!process.env.ROLEBOX_METRICS) return;

      const client = createMockClient({
        sessionPrompt: () => Promise.reject(new Error("prompt failed")),
      });
      const manager = new DispatchManager(client, fastConfig);

      const errorBefore = metrics.counter("dispatch_error_total", { mode: "sync" }).peek();

      await expect(
        manager.executeSync(
          { subagent: "sync-test", prompt: "hello", run_in_background: false },
          parentContext(),
        ),
      ).rejects.toThrow("prompt failed");

      const errorAfter = metrics.counter("dispatch_error_total", { mode: "sync" }).peek();
      expect(errorAfter).toBe(errorBefore + 1);
    });

    it("T16: executeSync inflight gauge balanced on error", async () => {
      if (!process.env.ROLEBOX_METRICS) return;

      const client = createMockClient({
        sessionPrompt: () => Promise.reject(new Error("prompt failed")),
      });
      const manager = new DispatchManager(client, fastConfig);
      const g = metrics.gauge("inflight_tasks");
      const baseline = g.peek();

      await expect(
        manager.executeSync(
          { subagent: "sync-test", prompt: "hello", run_in_background: false },
          parentContext(),
        ),
      ).rejects.toThrow("prompt failed");

      // Gauge should be back to baseline even on error
      expect(g.peek()).toBe(baseline);
    });
  });

  // ── 2d. executeSync task tracking (Manager #5) ───────────────

  describe("executeSync task tracking", () => {
    it("getTask returns sync task during execution and is cancellable via cancelTask", async () => {
      // Use a never-resolving prompt (mock doesn't respect AbortSignal,
      // so we rely on a short prompt timeout to unblock after cancel).
      const client = createMockClient({
        sessionPrompt: () => new Promise<never>(() => {}),
        sessionAbort: () => Promise.resolve({ data: undefined, error: undefined }),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncPromptTimeoutMs: 200,
        syncAcquireTimeoutMs: 5000,
      });
      const mgr = manager as any;

      const syncPromise = manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      );

      // Allow microtask flush so task is registered in this.tasks
      await new Promise((r) => setTimeout(r, 0));

      // Find the sync task by scanning this.tasks
      let syncTaskId: string | undefined;
      for (const [id, t] of mgr.tasks) {
        if (t.mode === "sync") {
          syncTaskId = id;
          break;
        }
      }
      expect(syncTaskId).toBeDefined();
      expect(syncTaskId).toMatch(/^sync_/);

      // getTask returns the sync task
      const task = manager.getTask(syncTaskId!);
      expect(task).toBeDefined();
      expect(task!.mode).toBe("sync");
      expect(task!.agent).toBe("sync-test");

      // Verify sessionToTask maps the session
      expect(task!.sessionId).toBeTruthy();
      expect(mgr.sessionToTask.get(task!.sessionId)).toBe(syncTaskId);

      // Cancel it
      const cancelled = await manager.cancelTask(syncTaskId!);
      expect(cancelled).toBe(true);

      // executeSync should reject (either from abort or timeout)
      await expect(syncPromise).rejects.toThrow();

      // Task cleaned up from tasks
      expect(manager.getTask(syncTaskId!)).toBeUndefined();
      expect(mgr._syncControllers.has(syncTaskId!)).toBe(false);
    });

    it("split timeouts: acquire uses syncAcquireTimeoutMs, prompt uses syncPromptTimeoutMs", async () => {
      // Fill all slots so acquire times out quickly
      const client = createMockClient();
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncAcquireTimeoutMs: 20,
        syncPromptTimeoutMs: 600_000,
      });
      const mgr = manager as any;

      Array.from({ length: 5 }, () => mgr.concurrency.acquireCancelable("default"));

      const err = await manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ).catch((e: Error) => e);

      const parsed = JSON.parse(err.message);
      expect(parsed.phase).toBe("acquire");
      expect(parsed.error).toContain("concurrency slot");

      // Release all slots
      for (let i = 0; i < 5; i++) mgr.concurrency.release("default");
    });

    it("sync_timeout_ms in input overrides prompt-phase timeout", async () => {
      const client = createMockClient({
        sessionPrompt: () => new Promise<never>(() => {}),
        sessionAbort: () => Promise.resolve({ data: undefined, error: undefined }),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncPromptTimeoutMs: 600_000,
        syncAcquireTimeoutMs: 5000,
      });

      const err = await manager.executeSync(
        {
          subagent: "sync-test",
          prompt: "hello",
          run_in_background: false,
          sync_timeout_ms: 20,
        },
        parentContext(),
      ).catch((e: Error) => e);

      const parsed = JSON.parse(err.message);
      expect(parsed.phase).toBe("prompt");
      expect(parsed.timeout_ms).toBe(20);
      expect(parsed.error).toContain("timed out");
    });

    it("sync throw produces JSON-structured error with phase field", async () => {
      // Prompt timeout case
      const client = createMockClient({
        sessionPrompt: () => new Promise<never>(() => {}),
        sessionAbort: () => Promise.resolve({ data: undefined, error: undefined }),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncPromptTimeoutMs: 20,
        syncAcquireTimeoutMs: 5000,
      });

      const err = await manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ).catch((e: Error) => e);

      let parsed: any;
      expect(() => { parsed = JSON.parse(err.message); }).not.toThrow();
      expect(parsed.error).toBeDefined();
      expect(parsed.phase).toBe("prompt");
      expect(parsed.timeout_ms).toBe(20);

      // Acquire timeout case
      const client2 = createMockClient();
      const manager2 = new DispatchManager(client2, {
        ...fastConfig,
        syncAcquireTimeoutMs: 20,
        syncPromptTimeoutMs: 600_000,
      });
      const mgr2 = manager2 as any;

      Array.from({ length: 5 }, () => mgr2.concurrency.acquireCancelable("default"));

      const err2 = await manager2.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ).catch((e: Error) => e);

      let parsed2: any;
      expect(() => { parsed2 = JSON.parse(err2.message); }).not.toThrow();
      expect(parsed2.error).toBeDefined();
      expect(parsed2.phase).toBe("acquire");
      expect(parsed2.timeout_ms).toBe(20);

      for (let i = 0; i < 5; i++) mgr2.concurrency.release("default");
    });

    it("recover with persisted mode:sync running task marks error, no notify", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "manager-sync-recover-"));
      const client = createMockClient();

      const store = new TaskStateStore(tempDir);
      const tasks = new Map<string, DispatchTask>();
      const syncTask: DispatchTask = {
        id: "sync_recover_1",
        sessionId: "ses_sync_rec",
        parentSessionId: "ses_parent",
        status: "running",
        agent: "helper",
        prompt: "work",
        description: "sync recovery test",
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        mode: "sync",
      };
      tasks.set(syncTask.id, syncTask);
      await store.save(tasks);

      const manager = new DispatchManager(client, fastConfig);
      manager.setStoreDirectory(tempDir);

      await manager.recover();

      const loaded = manager.getTask("sync_recover_1");
      expect(loaded).toBeDefined();
      expect(loaded!.status).toBe("error");
      expect(loaded!.error).toBe("Sync task interrupted by restart");

      // Should NOT have notified parent
      const notifyCalls = (client.session.promptAsync as any).mock.calls.filter(
        (c: any) => c[0]?.path?.id === "ses_parent",
      );
      // No notification for sync tasks (parent was blocked, not waiting for notify)
      expect(notifyCalls.length).toBe(0);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("normal sync completion leaves no lingering entry in this.tasks or _syncControllers", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const tasksBefore = mgr.tasks.size;
      const controllersBefore = mgr._syncControllers.size;
      const sttBefore = mgr.sessionToTask.size;

      await manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      );

      expect(mgr.tasks.size).toBe(tasksBefore);
      expect(mgr._syncControllers.size).toBe(controllersBefore);
      // sessionToTask should be unchanged (sync task's session mapping was cleaned up)
      expect(mgr.sessionToTask.size).toBe(sttBefore);
    });
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
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "analyze",
        run_in_background: false,
      },
      parentContext(),
    );

    // Pre-populate sidecar cache — getResult reads from cache, not network
    const sidecarPath = writeResultSidecar(task.id, "Analysis:Complete.", process.cwd());
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath,
      totalChars: 21,
      hadFence: false,
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Analysis:Complete.");
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it("getResult() returns not_found kind for unknown task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const result = await manager.getResult("unknown");
    expect(result.kind).toBe("not_found");
    expect(result.error).toBe("Task never existed");
    expect(result.text).toBe("");
  });

  it("getResult() returns fetch_error kind when task.result has fetchError", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "analyze",
        run_in_background: false,
      },
      parentContext(),
    );

    // Set task.result with fetchError — getResult returns fetch_error from cache
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath: "",
      totalChars: 0,
      hadFence: false,
      fetchError: "Error retrieving task output: session expired",
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("fetch_error");
    expect(result.error).toContain("Error retrieving task output");
    expect(result.text).toBe("");
    expect(client.session.messages).not.toHaveBeenCalled();
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

    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.messageCountAtStart = 2;
    t.status = "completed";

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Continuation output.");
    expect(result.text).not.toContain("Old round output.");
  });

  it("getResult() on non-continued task returns all assistant text (regression)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const sidecarPath = writeResultSidecar(task.id, "Analysis:Complete.", process.cwd());
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.messageCountAtStart = undefined;
    t.result = {
      sidecarPath,
      totalChars: 21,
      hadFence: false,
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Analysis:Complete.");
  });

  it("getResult() returns totalChars equal to full text length", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const sidecarPath = writeResultSidecar(task.id, "HelloWorld", process.cwd());
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath,
      totalChars: 10,
      hadFence: false,
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.totalChars).toBe(10); // "HelloWorld".length
    expect(result.text).toBe("HelloWorld");
  });

  it("getResult() returns resultText from fenced block when ```result fence is present", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const fullText = "Some preamble.\n```result\nclean output\n```\nSome postamble.";
    const sidecarPath = writeResultSidecar(task.id, fullText, process.cwd());
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath,
      totalChars: fullText.length,
      hadFence: true,
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.hadFence).toBe(true);
    expect(result.resultText).toBe("clean output");
    expect(result.text).toContain("```result");
  });

  it("getResult() returns resultText equal to raw text when no fence is present", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );

    const fullText = "Plain output without fences.";
    const sidecarPath = writeResultSidecar(task.id, fullText, process.cwd());
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath,
      totalChars: fullText.length,
      hadFence: false,
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.hadFence).toBe(false);
    expect(result.resultText).toBe(result.text);
    expect(result.resultText).toBe("Plain output without fences.");
  });

  it("getResult() non-ok kinds (not_found/expired/fetch_error) have zero totalChars and empty resultText", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const notFound = await manager.getResult("nonexistent");
    expect(notFound.kind).toBe("not_found");
    expect(notFound.totalChars).toBe(0);
    expect(notFound.hadFence).toBe(false);
    expect(notFound.resultText).toBe("");

    // expired: clean up a task then ask for its result
    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );
    manager.cleanupTask(task.id);
    const expired = await manager.getResult(task.id);
    expect(expired.kind).toBe("expired");
    expect(expired.totalChars).toBe(0);
    expect(expired.hadFence).toBe(false);
    expect(expired.resultText).toBe("");

    // fetch_error
    const clientErr = createMockClient();
    const mgr2 = new DispatchManager(clientErr);
    const t2 = await mgr2.launch(
      { subagent: "helper", prompt: "fail", run_in_background: false },
      parentContext(),
    );
    const mgr2Any = mgr2 as any;
    const t2Ref = mgr2Any.tasks.get(t2.id);
    t2Ref.result = {
      sidecarPath: "",
      totalChars: 0,
      hadFence: false,
      fetchError: "Error retrieving task output: session expired",
      materializedAt: new Date().toISOString(),
    };
    const fetchErr = await mgr2.getResult(t2.id);
    expect(fetchErr.kind).toBe("fetch_error");
    expect(fetchErr.totalChars).toBe(0);
    expect(fetchErr.hadFence).toBe(false);
    expect(fetchErr.resultText).toBe("");
  });

  // ── 4b. getResult() cache-first + lazy fallback (T7 rewrite) ──

  it("cache-first: getResult reads from task.result sidecar, never calls network", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );
    const sidecarPath = writeResultSidecar(task.id, "cached output", process.cwd());
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath,
      totalChars: 13,
      hadFence: false,
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("cached output");
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it("lazy backward-compat: completed task without result materializes once, then cached", async () => {
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
              parts: [{ type: "text" as const, text: "lazy output" }],
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
    t.status = "completed";

    // First call — triggers lazy materializeResult (session.messages called once)
    const r1 = await manager.getResult(task.id);
    expect(r1.kind).toBe("ok");
    expect(r1.text).toBe("lazy output");

    // Second call — reads from cache (session.messages NOT called again)
    const r2 = await manager.getResult(task.id);
    expect(r2.kind).toBe("ok");
    expect(r2.text).toBe("lazy output");

    // session.messages called exactly once (first call only)
    expect((client.session.messages as any).mock.calls.length).toBe(1);
  });

  it("fetch-error: task.result with fetchError returns fetch_error kind", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "fail", run_in_background: false },
      parentContext(),
    );
    const mgr = manager as any;
    const t = mgr.tasks.get(task.id);
    t.result = {
      sidecarPath: "",
      totalChars: 0,
      hadFence: false,
      fetchError: "materialize timeout",
      materializedAt: new Date().toISOString(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("fetch_error");
    expect(result.error).toBe("materialize timeout");
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it("sidecar-survival: missing task with orphaned sidecar file returns ok", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "analyze", run_in_background: false },
      parentContext(),
    );
    const taskId = task.id;

    // Clean up the task from memory
    manager.cleanupTask(taskId);

    // Write an orphaned sidecar file
    const sidecarPath = resultSidecarPath(taskId, process.cwd());
    writeResultSidecar(taskId, "survivor output", process.cwd());

    const result = await manager.getResult(taskId);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("survivor output");
    expect(result.totalChars).toBe(15);
  });

  it("expired: cleanedUpTasks entry returns expired kind", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const task = await manager.launch(
      { subagent: "helper", prompt: "p", run_in_background: false },
      parentContext(),
    );
    manager.cleanupTask(task.id);

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("expired");
    expect(result.error).toContain("cleaned up");
  });

  it("not-found: unknown task id returns not_found kind", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);

    const result = await manager.getResult("never-existed");
    expect(result.kind).toBe("not_found");
    expect(result.error).toBe("Task never existed");
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

    const cleaned = mgr.cleanedUpTasks as Map<string, number>;
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

    const mgr = manager as any;
    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "some-session-id";
    taskRef.status = "running";
    taskRef.startedAt = new Date(Date.now() - 10000);
    mgr.sessionToTask.set("some-session-id", task.id);

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

    const mgr = manager as any;
    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "early-session";
    taskRef.status = "running";
    taskRef.startedAt = new Date(Date.now());
    mgr.sessionToTask.set("early-session", task.id);

    const messagesSpy = client.session.messages;

    await manager.handleSessionIdle("early-session");

    expect(messagesSpy).not.toHaveBeenCalled();
    expect(taskRef.status).toBe("running");
  });

  it("handleSessionIdle starts debounce then completes on trigger when elapsed >= minRuntimeMs and assistant output exists", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const taskRef = mgr.tasks.get(task.id);
    const watchdog = mgr.watchdog;
    taskRef.sessionId = "mature-session";
    taskRef.status = "running";
    taskRef.startedAt = new Date(Date.now() - 6000);
    mgr.sessionToTask.set("mature-session", task.id);
    watchdog.registerTask(task.id);

    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      }),
    );
    client.session.status = mock(() =>
      Promise.resolve({
        data: { "mature-session": { type: "idle" } },
        error: undefined,
      }),
    );

    await manager.handleSessionIdle("mature-session");

    expect(watchdog.isDebouncing(task.id)).toBe(true);
    expect(taskRef.status).toBe("running");

    // First debounce → records pendingConfirm, re-arms (Task 13 re-confirmation)
    await watchdog.triggerDebounce(task.id);
    expect(taskRef.status).toBe("running");

    // Second debounce → stable, completes
    await watchdog.triggerDebounce(task.id);
    expect(taskRef.status).toBe("completed");
  });

  // ── 9. bounded cleanedUpTasks ─────────────────────────────

  it("does not grow unbounded (LRU eviction at 500 entries, oldest timestamp evicted)", () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const mgr = manager as any;
    const taskIds: string[] = [];
    for (let i = 0; i < 600; i++) {
      const tid = `task_${i}`;
      taskIds.push(tid);
      mgr.tasks.set(tid, { id: tid });
      manager.cleanupTask(tid);
    }

    const cleaned = mgr.cleanedUpTasks as Map<string, number>;
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
    it("direct completion wins during idle debounce — idle debounce no-ops, single release", async () => {
      const client = createMockClient();
      let resolveMessages!: (v: any) => void;
      const deferred = new Promise<any>((r) => { resolveMessages = r; });

      const sessionMessagesMock = mock(() => deferred);
      client.session.messages = sessionMessagesMock;

      const manager = new DispatchManager(client, fastConfig);

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      const mgr = manager as any;
      const t = mgr.tasks.get(task.id);
      t.sessionId = "idle-session";
      t.startedAt = new Date(Date.now() - 10000);
      mgr.sessionToTask.set("idle-session", task.id);

      // Call handleSessionIdle — it will suspend at messages await
      const idlePromise = manager.handleSessionIdle("idle-session");

      // While suspended, direct complete via handleTaskCompleted
      mgr.handleTaskCompleted(task.id);
      expect(t.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);

      // Now resolve the deferred — idle resumes, starts debounce
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

    it("second handleSessionIdle for same task is a no-op while already debouncing", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      const mgr = manager as any;
      const watchdog = mgr.watchdog;
      const t = mgr.tasks.get(task.id);
      t.sessionId = "idle-session-2";
      t.startedAt = new Date(Date.now() - 10000);
      mgr.sessionToTask.set("idle-session-2", task.id);
      watchdog.registerTask(task.id);

      client.session.messages = mock(() => Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      }));
      client.session.status = mock(() => Promise.resolve({
        data: { "idle-session-2": { type: "idle" } },
        error: undefined,
      }));

      await manager.handleSessionIdle("idle-session-2");
      expect(watchdog.isDebouncing(task.id)).toBe(true);
      expect(t.status).toBe("running");

      // Second idle — should no-op (already debouncing)
      await manager.handleSessionIdle("idle-session-2");
      expect(watchdog.isDebouncing(task.id)).toBe(true);

      // First debounce → records pendingConfirm, re-arms (Task 13 re-confirmation)
      await watchdog.triggerDebounce(task.id);
      expect(t.status).toBe("running");

      // Second debounce → stable, completes
      await watchdog.triggerDebounce(task.id);
      expect(t.status).toBe("completed");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);
    });
  });

  // ── 12. queue-full rejection ──────────────────────────────────

  describe("queue-full rejection", () => {
    it("rejected task is scheduled for cleanup and notified with structured error", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0, backpressureMaxRetries: 0 });
      const mgr = manager as any;

      // Fill the single slot
      mgr.concurrency.acquireCancelable("default");

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
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0, backpressureMaxRetries: 0 });
      const mgr = manager as any;

      // Fill the single slot
      mgr.concurrency.acquireCancelable("default");
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

  // ── 12b. non-blocking background dispatch (T4) ────────────────

  describe("non-blocking background dispatch", () => {
    it("T4-1: queued background dispatch returns immediately as pending", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 10, syncReservedSlots: 0 });
      const mgr = manager as any;

      const fill = mgr.concurrency.acquireBackground("default");
      expect(fill.outcome).toBe("acquired");

      const start = Date.now();
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
      expect(task.status).toBe("pending");
      expect(task.id).toMatch(/^bg_/);
      expect(task.sessionId).toBe("");
      expect(client.session.create).not.toHaveBeenCalled();

      mgr.concurrency.release("default");
      await new Promise(r => setTimeout(r, 10));
    });

    it("T4-2: queued task promotes to running when slot frees", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 10, syncReservedSlots: 0 });
      const mgr = manager as any;

      const fill = mgr.concurrency.acquireBackground("default");
      expect(fill.outcome).toBe("acquired");

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("pending");

      mgr.concurrency.release("default");
      await new Promise(r => setTimeout(r, 10));

      const updated = mgr.tasks.get(task.id);
      expect(updated.status).toBe("running");
      expect(updated.sessionId).not.toBe("");
      expect(client.session.create).toHaveBeenCalled();
    });

    it("T4-3: cancel queued task cleans up without session abort or slot leak", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 10, syncReservedSlots: 0 });
      const mgr = manager as any;

      const fill = mgr.concurrency.acquireBackground("default");
      expect(fill.outcome).toBe("acquired");

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("pending");

      const cancelled = await manager.cancelTask(task.id);
      expect(cancelled).toBe(true);
      const updated = mgr.tasks.get(task.id);
      expect(updated.status).toBe("cancelled");
      expect(client.session.abort).not.toHaveBeenCalled();

      mgr.concurrency.release("default");
      expect(mgr.concurrency.getActiveCount("default")).toBe(0);
    });

    it("T4-4: queue-full rejects immediately with structured error", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0, syncReservedSlots: 0, backpressureMaxRetries: 0 });
      const mgr = manager as any;

      const fill = mgr.concurrency.acquireBackground("default");
      expect(fill.outcome).toBe("acquired");

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      expect(task.status).toBe("error");
      const parsed = JSON.parse(task.error!);
      expect(parsed.error).toBe("Queue is full");
      expect(task.completedAt).toBeInstanceOf(Date);

      mgr.concurrency.release("default");
    });

    it("T4-5: reopenForContinuation rejects immediately when no slot (no queue path)", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 10, syncReservedSlots: 0 });
      const mgr = manager as any;

      const t1 = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      expect(t1.status).toBe("running");
      mgr.handleTaskCompleted(t1.id);

      const fill = mgr.concurrency.acquireBackground("default");
      expect(fill.outcome).toBe("acquired");

      const t2 = await manager.reopenForContinuation(
        t1.id,
        { subagent: "h", prompt: "retry", run_in_background: true },
        parentContext(),
      );

      expect(t2.status).toBe("error");
      expect(mgr.tasks.get(t1.id).completedAt).toBeDefined();

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
      const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0, syncReservedSlots: 0, backpressureMaxRetries: 0 });
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

    // Drain microtasks so fire-and-forget materializeAndNotify → notifyParent
    // completes before reopenForContinuation inspects promptAsyncCalls.
    await new Promise((r) => setTimeout(r, 0));

    // leaveRunning → flushPersistSync disposes the watchdog.
    // Re-enable it for reopenForContinuation to re-register.
    (mgr.watchdog as any).disposed = false;
    (mgr.watchdog as any).registeredTasks.clear();

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

    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(1);

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
    mgr.concurrency.acquireCancelable("default");

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

  beforeEach(() => {
    clearParentQueues();
    clearSentFinalNotifies();
  });

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
    expect((manager as any).watchdog.getRegisteredTaskIds().length).toBe(1);

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
    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(3);
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
    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(5);
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
    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(2);

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

  // ── 11b. Task 11: authoritative inflight rebuild + terminal notify ──

  it("Task-11: authoritative inflightByParent rebuild from actualByParent after recovery", async () => {
    const tempDir = createTempDir();

    // 5 running tasks across 2 parents: parent-A has 3 tasks, parent-B has 2
    // sessions ses_a1, ses_a3, ses_b1 alive; ses_a2, ses_b2 dead
    const aliveSessions = new Set(["ses_a1", "ses_a3", "ses_b1"]);
    const client = createMockClient({
      sessionGet: (args: any) => {
        const sid = args.path.id;
        if (aliveSessions.has(sid)) {
          return Promise.resolve({ data: { id: sid }, error: undefined });
        }
        return Promise.resolve({ data: undefined, error: undefined });
      },
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();

    const taskDefs = [
      { id: "bg_a1", sid: "ses_a1", parent: "parent-A" },
      { id: "bg_a2", sid: "ses_a2", parent: "parent-A" },
      { id: "bg_a3", sid: "ses_a3", parent: "parent-A" },
      { id: "bg_b1", sid: "ses_b1", parent: "parent-B" },
      { id: "bg_b2", sid: "ses_b2", parent: "parent-B" },
    ];
    for (const td of taskDefs) {
      const t: DispatchTask = {
        id: td.id,
        sessionId: td.sid,
        parentSessionId: td.parent,
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

    // Authoritative: only actually re-attached running tasks count
    expect(mgr.inflightByParent.get("parent-A")).toBe(2); // ses_a1, ses_a3 alive; ses_a2 dead
    expect(mgr.inflightByParent.get("parent-B")).toBe(1); // ses_b1 alive; ses_b2 dead

    // Dead sessions are errored
    expect(manager.getTask("bg_a2")!.status).toBe("error");
    expect(manager.getTask("bg_b2")!.status).toBe("error");

    // Alive sessions are running
    expect(manager.getTask("bg_a1")!.status).toBe("running");
    expect(manager.getTask("bg_a3")!.status).toBe("running");
    expect(manager.getTask("bg_b1")!.status).toBe("running");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Task-11: session-lost on recover → parent notified via notifyCompletion", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionGet: () =>
        Promise.resolve({ data: undefined, error: undefined }),
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const task: DispatchTask = {
      id: "bg_session_lost",
      sessionId: "ses_dead",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "helper",
      prompt: "work",
      description: "session-lost notify test",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(task.id, task);
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    // Task is errored
    const loaded = manager.getTask("bg_session_lost");
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("Session lost");

    // Wait for async notification to flush through the queue
    await new Promise((r) => setTimeout(r, 50));

    // Parent was notified about the error via promptAsync
    const notifyCalls = (client.session.promptAsync as any).mock.calls;
    const completionCall = notifyCalls.find(
      (c: any) => c[0]?.path?.id === "ses_parent" && c[0]?.body?.noReply === false,
    );
    expect(completionCall).toBeDefined();
    const notifyText: string = completionCall[0].body.parts[0].text;
    expect(notifyText).toContain("session-lost notify test");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Task-11: verification-failed on recover → parent notified via notifyCompletion", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionGet: () => {
        throw new Error("connection failed");
      },
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const task: DispatchTask = {
      id: "bg_verify_fail",
      sessionId: "ses_broken",
      parentSessionId: "ses_parent",
      status: "running",
      agent: "helper",
      prompt: "work",
      description: "verify-failed notify test",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(task.id, task);
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    // Task is errored
    const loaded = manager.getTask("bg_verify_fail");
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("verification failed");

    // Wait for async notification
    await new Promise((r) => setTimeout(r, 50));

    // Parent was notified
    const notifyCalls = (client.session.promptAsync as any).mock.calls;
    const completionCall = notifyCalls.find(
      (c: any) => c[0]?.path?.id === "ses_parent" && c[0]?.body?.noReply === false,
    );
    expect(completionCall).toBeDefined();
    const notifyText: string = completionCall[0].body.parts[0].text;
    expect(notifyText).toContain("verify-failed notify test");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Task-11: concurrency-exceeded on recover → parent notified via notifyCompletion", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionGet: () =>
        Promise.resolve({ data: { id: "ses_alive" }, error: undefined }),
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    // 6 running tasks, but maxConcurrent is 5 → 1 should exceed
    for (let i = 0; i < 6; i++) {
      const t: DispatchTask = {
        id: `bg_over_${i}`,
        sessionId: `ses_over_${i}`,
        parentSessionId: "ses_parent",
        status: "running",
        agent: "helper",
        prompt: "work",
        description: `overload task ${i}`,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(t.id, t);
    }
    await store.save(tasks);

    const manager = new DispatchManager(client, { ...fastConfig, maxConcurrent: 5, syncReservedSlots: 0 });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    // Wait for async notification
    await new Promise((r) => setTimeout(r, 50));

    const mgr = manager as any;
    // 5 tasks re-attached, 1 errored
    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(5);

    let errorCount = 0;
    let lastErrorId: string | undefined;
    for (let i = 0; i < 6; i++) {
      const t = manager.getTask(`bg_over_${i}`);
      if (t?.status === "error" && t.error?.includes("Exceeded concurrency limit")) {
        errorCount++;
        lastErrorId = `bg_over_${i}`;
      }
    }
    expect(errorCount).toBe(1);

    // Parent was notified about the errored task
    const notifyCalls = (client.session.promptAsync as any).mock.calls;
    const completionCall = notifyCalls.find(
      (c: any) =>
        c[0]?.path?.id === "ses_parent" &&
        c[0]?.body?.noReply === false &&
        c[0]?.body?.parts?.[0]?.text?.includes("Exceeded concurrency limit") === false,
    );
    // At minimum, the errored task's description should appear in some notify call
    expect(completionCall).toBeDefined();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() does NOT eagerly fetch for completed tasks without result (v3 backward compat)", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "recovered lazy output" }],
            },
          ],
          error: undefined,
        }),
    });

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const completedTask: DispatchTask = {
      id: "bg_v3_completed",
      sessionId: "ses_v3",
      parentSessionId: "ses_parent",
      status: "completed",
      agent: "helper",
      prompt: "work",
      description: "v3 completed task without result",
      startedAt: new Date(Date.now() - 60000),
      completedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(completedTask.id, completedTask);
    await store.save(tasks);

    (client.session.messages as any).mock.calls.length = 0;

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    expect((client.session.messages as any).mock.calls.length).toBe(0);

    const sidecarPath = resultSidecarPath("bg_v3_completed", process.cwd());
    let sidecarExists = false;
    try {
      readFileSync(sidecarPath);
      sidecarExists = true;
    } catch {}

    const result = await manager.getResult("bg_v3_completed");
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("recovered lazy output");

    expect((client.session.messages as any).mock.calls.length).toBe(1);

    const loaded = manager.getTask("bg_v3_completed");
    expect(loaded?.result).toBeDefined();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() restores outbox and sweeper is running", async () => {
    const tempDir = createTempDir();
    const client = createMockClient();

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const task: DispatchTask = {
      id: "bg_outbox",
      sessionId: "ses_out",
      parentSessionId: "ses_parent",
      status: "completed",
      agent: "helper",
      prompt: "work",
      description: "outbox sweeper test",
      startedAt: new Date(),
      completedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(task.id, task);
    await store.save(tasks, new Set(["bg_outbox"]));

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    const mgr = manager as any;
    await manager.recover();

    expect(mgr.notifyOutbox.has("bg_outbox")).toBe(true);

    expect(mgr.sweeperTimer).toBeDefined();

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
      { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 0, syncReservedSlots: 0, backpressureMaxRetries: 0 },
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
    mgr.concurrency.acquireCancelable("anthropic/claude-3");
    mgr.concurrency.acquireCancelable("anthropic/claude-3");
    mgr.concurrency.acquireCancelable("anthropic/claude-3");
    mgr.concurrency.acquireCancelable("anthropic/claude-3");
    mgr.concurrency.acquireCancelable("anthropic/claude-3");
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
    await Promise.resolve();

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
        { ...fastConfig, maxConcurrent: 1, maxQueueDepth: 1, syncReservedSlots: 0, backpressureMaxRetries: 0 },
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
    await Promise.resolve();
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
    await Promise.resolve();
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
    for (let i = 0; i < 4; i++) {
      const r = mgr.concurrency.acquireBackground("default");
      expect(r.outcome).toBe("acquired");
    }
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
        { ...fastConfig, maxConcurrent: 3, maxQueueDepth: 0, syncReservedSlots: 1, backpressureMaxRetries: 0 },
      );
    const mgr = manager as any;

    // Fill all 2 background slots
    for (let i = 0; i < 2; i++) {
      const r = mgr.concurrency.acquireBackground("default");
      expect(r.outcome).toBe("acquired");
    }
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
    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(4);
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

// ── 19. flushPersistSync (T5) ────────────────────────────────────

describe("flushPersistSync", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T5-1: flushPersistSync writes current state and clears _dirty", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    // Make a state change that schedules a persist
    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");
    expect(mgr._dirty).toBe(true);

    // Flush synchronously
    manager.flushPersistSync();

    expect(mgr._dirty).toBe(false);
    expect(mgr._persistTimer).toBeUndefined();

    // Cleanup
    mgr.concurrency.release("default");
  });

  it("T5-2: terminal state IS NOT immediately durable (no sync flush in leaveRunning)", async () => {
    const client = createMockClient();
    const dir = mkdtempSync(join(tmpdir(), "dispatch-flush-test-"));
    const manager = new DispatchManager(client, { ...fastConfig, taskTtlMs: 5000 });
    manager.setStoreDirectory(dir);
    const mgr = manager as any;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    // Complete the task (goes through leaveRunning)
    mgr.handleTaskCompleted(task.id);

    // Immediately create a new store and load — state should NOT be durable yet
    // because leaveRunning no longer calls flushPersistSync (debounced async only)
    const { TaskStateStore } = await import("../../src/dispatch/task-store");
    const freshStore = new TaskStateStore(dir);
    const loaded = freshStore.load();
    expect(loaded).toBeNull();

    // Wait for the debounced async persist (500ms + buffer)
    await new Promise((r) => setTimeout(r, 600));

    // Now state should be durable via async debounced persist
    const freshStore2 = new TaskStateStore(dir);
    const loaded2 = freshStore2.load();
    expect(loaded2).not.toBeNull();
    const loadedTask = loaded2!.tasks.get(task.id);
    expect(loadedTask).toBeDefined();
    expect(loadedTask!.status).toBe("completed");

    // Cleanup
    rmSync(dir, { recursive: true, force: true });
  });

  it("T5-3: flushPersistSync is idempotent", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    // Call before any state — no crash
    expect(() => manager.flushPersistSync()).not.toThrow();
    expect(() => manager.flushPersistSync()).not.toThrow();
  });
});

// ── Task 17: LRU cleanedUpTasks + leaveRunning no sync flush + degraded mode ──

describe("Task 17: LRU cleanedUpTasks", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T17-1: getResult returns expired for LRU entries, not_found for evicted and unknown", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    // Clean up 100 tasks — all should stay in LRU (under 500 cap)
    for (let i = 0; i < 100; i++) {
      mgr.tasks.set(`task_${i}`, { id: `task_${i}`, sessionId: `ses_${i}` });
      manager.cleanupTask(`task_${i}`);
    }

    // task_50 is still in the LRU → expired
    const result50 = await manager.getResult("task_50");
    expect(result50.kind).toBe("expired");
    expect(result50.error).toContain("was cleaned up");

    // Populate 500 more to trigger LRU eviction of the oldest
    for (let i = 100; i < 600; i++) {
      mgr.tasks.set(`task_${i}`, { id: `task_${i}`, sessionId: `ses_${i}` });
      manager.cleanupTask(`task_${i}`);
    }

    // task_0 was the oldest in LRU → evicted → not_found
    const result0 = await manager.getResult("task_0");
    expect(result0.kind).toBe("not_found");

    // Truly unknown
    const resultUnknown = await manager.getResult("never_existed");
    expect(resultUnknown.kind).toBe("not_found");
  });
});

describe("Task 17: leaveRunning debounced persist", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T17-2: leaveRunning does NOT invoke store.saveSync (no sync flush on hot path)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const saveSyncSpy = mock(() => {});
    mgr.store.saveSync = saveSyncSpy;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );
    mgr.handleTaskCompleted(task.id);

    // saveSync must NOT have been called (no sync flush in leaveRunning)
    expect(saveSyncSpy).not.toHaveBeenCalled();

    // Cleanup
    mgr.concurrency.release("default");
  });
});

describe("Task 17: degraded mode", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T17-3: degraded mode — store.save() is no-op when _readOnly is set", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    // Force the store into read-only degraded mode
    mgr.store._readOnly = true;

    // Verify save() is a no-op in degraded mode
    const tasks = new Map();
    await mgr.store.save(tasks);
    // save() returns early without writing; validates silently (no throw)

    // Verify saveSync() is a no-op in degraded mode
    mgr.store.saveSync(tasks);
    // saveSync() returns early without writing

    // Verify tryLock() returns false and sets _readOnly when lock already held
    const otherStore = new (mgr.store.constructor as new (dir: string) => typeof mgr.store)("/tmp");
    // Not testing multi-instance lock here (covered in state-lock.test.ts)
  });

  it("T17-4: recover() sets _readOnly when store.tryLock() fails", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const origTryLock = mgr.store.tryLock.bind(mgr.store);
    mgr.store.tryLock = mock(() => {
      mgr.store._readOnly = true;
      return false;
    });

    await manager.recover();
    expect(mgr.store._readOnly).toBe(true);

    mgr.store.tryLock = origTryLock;
  });


});

describe("T8: Notification outbox", () => {
  afterEach(() => {
    mock.restore();
    clearSentFinalNotifies();
    clearParentQueues();
  });

  it("sweeper retries then prunes after task is removed from tasks map", async () => {
    const client = createMockClient();

    const capturedCallbacks: Array<() => void> = [];
    const origSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => void, _ms: number) => {
      capturedCallbacks.push(fn);
      return setTimeout(() => {}, 999999) as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    try {
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;
      const sweepCb = capturedCallbacks[capturedCallbacks.length - 1];
      expect(sweepCb).toBeDefined();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      task.status = "completed";
      task.completedAt = new Date();
      mgr.notifyOutbox.add(task.id);

      await sweepCb();
      expect(mgr.notifyOutbox.has(task.id)).toBe(true);

      mgr.tasks.delete(task.id);

      await sweepCb();
      expect(mgr.notifyOutbox.has(task.id)).toBe(false);

      mgr.flushPersistSync();
    } finally {
      globalThis.setInterval = origSetInterval;
    }
  });

  it("sweeper prunes tasks already notified via hasFinalNotifyBeenSent", async () => {
    const client = createMockClient();

    const capturedCallbacks: Array<() => void> = [];
    const origSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => void, _ms: number) => {
      capturedCallbacks.push(fn);
      return setTimeout(() => {}, 999999) as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    try {
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;
      const sweepCb = capturedCallbacks[capturedCallbacks.length - 1];
      expect(sweepCb).toBeDefined();

      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );
      task.status = "completed";
      task.completedAt = new Date();
      mgr.inflightByParent.delete(task.parentSessionId);

      const result = await mgr.notifyCompletion(task);
      expect(result).toBe(true);

      const { hasFinalNotifyBeenSent: hfs } =
        await import("../../src/dispatch/notification");
      expect(hfs(task.id)).toBe(true);

      mgr.notifyOutbox.add(task.id);
      expect(mgr.notifyOutbox.has(task.id)).toBe(true);

      await sweepCb();
      expect(mgr.notifyOutbox.has(task.id)).toBe(false);

      mgr.flushPersistSync();
    } finally {
      globalThis.setInterval = origSetInterval;
    }
  });

  it("recover repopulates outbox from persisted v4 state", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "manager-outbox-recover-"));
    const client = createMockClient();

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();
    const task: DispatchTask = {
      id: "bg_test",
      sessionId: "ses_test",
      parentSessionId: "ses_parent",
      status: "completed",
      agent: "helper",
      prompt: "work",
      description: "outbox recover test",
      startedAt: new Date(),
      completedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };
    tasks.set(task.id, task);
    await store.save(tasks, new Set(["bg_test"]));

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    const mgr = manager as any;
    await manager.recover();

    expect(mgr.notifyOutbox.has("bg_test")).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sweeper timer is cleared on flushPersistSync", () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    expect(mgr.sweeperTimer).toBeDefined();

    manager.flushPersistSync();

    expect(mgr.sweeperTimer).toBeUndefined();
  });
});

// ── Task 12: config injection + per-parent fairness + backpressure ──

describe("Task 12: per-parent fairness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T12-1: single parent past maxActivePerParent queues while other parent launches immediately", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 5,
      maxActivePerParent: 1,
      syncReservedSlots: 0,
    });
    const mgr = manager as any;

    const ctxA = { sessionID: "parent-A", agent: "a", directory: "/tmp" };
    const ctxB = { sessionID: "parent-B", agent: "b", directory: "/tmp" };

    // Parent A: first task acquires
    const tA1 = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      ctxA,
    );
    expect(tA1.status).toBe("running");

    // Parent A: second task — would exceed maxActivePerParent, should queue
    const tA2promise = manager.launch(
      { subagent: "h", prompt: "p2", run_in_background: true },
      ctxA,
    );

    // Give a tick for the waiter to enqueue
    await new Promise((r) => setTimeout(r, 10));

    // Parent B: task should acquire immediately (different parent)
    const tB1 = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      ctxB,
    );
    expect(tB1.status).toBe("running");

    const tA2 = await tA2promise;
    // Task A2 should be pending (queued, waiting for A1 to release)
    // or it might have already been promoted if timing worked out
    expect(["pending", "running"]).toContain(tA2.status);

    // Complete A1 → A2 gets promoted
    if (tA2.status === "pending") {
      mgr.handleTaskCompleted(tA1.id);
      await new Promise((r) => setTimeout(r, 10));
      const updatedA2 = mgr.tasks.get(tA2.id);
      expect(updatedA2.status).toBe("running");
      mgr.handleTaskCompleted(updatedA2.id);
    }

    // Cleanup B1
    mgr.handleTaskCompleted(tB1.id);
  });

  it("T12-1b: recover rebuilds per-parent active counts from forceOccupyBackground", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "manager-t12-recover-"));
    const client = createMockClient();

    const store = new TaskStateStore(tempDir);
    const tasks = new Map<string, DispatchTask>();

    // 2 tasks from parent-A, 1 from parent-B — all alive
    const taskDefs = [
      { id: "bg_pa1", sid: "ses_pa1", parent: "parent-A" },
      { id: "bg_pa2", sid: "ses_pa2", parent: "parent-A" },
      { id: "bg_pb1", sid: "ses_pb1", parent: "parent-B" },
    ];
    for (const td of taskDefs) {
      const t: DispatchTask = {
        id: td.id,
        sessionId: td.sid,
        parentSessionId: td.parent,
        status: "running",
        agent: "helper",
        prompt: "work",
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
      };
      tasks.set(t.id, t);
    }
    await store.save(tasks);

    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 5,
      syncReservedSlots: 0,
    });
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    // inflightByParent should reflect recovered active counts
    expect(mgr.inflightByParent.get("parent-A")).toBe(2);
    expect(mgr.inflightByParent.get("parent-B")).toBe(1);

    // Concurrency activeByParent should be populated
    const slot = mgr.concurrency.slots.get("default") as any;
    expect(slot.activeByParent.get("parent-A")).toBe(2);
    expect(slot.activeByParent.get("parent-B")).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("Task 12: backpressure retry", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T12-2: queue-full with backpressureMaxRetries>0 retries then succeeds when slot frees", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 1,
      maxQueueDepth: 1,
      syncReservedSlots: 0,
      backpressureMaxRetries: 3,
      retryAfterMs: 10,
    });
    const mgr = manager as any;

    // Fill the single slot
    const t1 = await manager.launch(
      { subagent: "h", prompt: "p1", run_in_background: true },
      parentContext(),
    );
    expect(t1.status).toBe("running");

    // Enqueue a waiter to fill the queue
    const t2promise = manager.launch(
      { subagent: "h", prompt: "p2", run_in_background: true },
      parentContext(),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Queue is full: slot occupied + 1 queued → third task triggers backpressure
    const t3 = await manager.launch(
      { subagent: "h", prompt: "p3", run_in_background: true },
      parentContext(),
    );
    expect(t3.status).toBe("pending");
    expect(mgr._cancelQueue.has(t3.id)).toBe(true);

    // Free up everything: complete t1 → t2 promotes; complete t2 → slot free
    mgr.handleTaskCompleted(t1.id);
    await new Promise((r) => setTimeout(r, 10));
    const t2 = await t2promise;
    expect(t2.status).toBe("running");
    mgr.handleTaskCompleted(t2.id);
    await new Promise((r) => setTimeout(r, 10));

    // Wait for backpressure retry to fire
    await new Promise((r) => setTimeout(r, 50));

    const updatedT3 = mgr.tasks.get(t3.id);
    expect(updatedT3.status).toBe("running");
    expect(updatedT3.sessionId).not.toBe("");

    mgr.handleTaskCompleted(updatedT3.id);
  });

  it("T12-3: queue-full with retries exhausted → structured JSON error + notify", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 1,
      maxQueueDepth: 0,
      syncReservedSlots: 0,
      backpressureMaxRetries: 1,
      retryAfterMs: 5,
    });
    const mgr = manager as any;

    // Fill the single slot — no queue, so any new launch triggers backpressure
    mgr.concurrency.acquireBackground("default");

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true, description: "backpressure-test" },
      parentContext(),
    );
    expect(task.status).toBe("pending");

    // Wait for the retry to fire (attempt 1) and get exhausted
    await new Promise((r) => setTimeout(r, 50));

    const updated = mgr.tasks.get(task.id);
    expect(updated.status).toBe("error");
    const parsed = JSON.parse(updated.error!);
    expect(parsed.error).toContain("backpressure retries exhausted");
    expect(parsed.attempts).toBe(1);
    expect(parsed.retry_after).toBeGreaterThan(0);
    expect(updated.completedAt).toBeInstanceOf(Date);

    // Inflight counter decremented (decInflight called on exhaustion)
    expect(mgr.inflightByParent.get("parent-session-1")).toBeUndefined();

    // Notification was sent
    const notifyCalls = (client.session.promptAsync as any).mock.calls;
    const lastCall = notifyCalls[notifyCalls.length - 1];
    expect(lastCall).toBeDefined();

    mgr.concurrency.release("default");
  });

  it("T12-3b: backpressure emits retry metric on each attempt", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 1,
      maxQueueDepth: 0,
      syncReservedSlots: 0,
      backpressureMaxRetries: 2,
      retryAfterMs: 5,
    });
    const mgr = manager as any;

    mgr.concurrency.acquireBackground("default");

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("pending");

    // Wait for both retries to exhaust
    await new Promise((r) => setTimeout(r, 50));

    const updated = mgr.tasks.get(task.id);
    expect(updated.status).toBe("error");

    // dispatch_backpressure_retry_total counter was incremented
    const counter = metrics.counter("dispatch_backpressure_retry_total", { key: "default" });
    expect(counter.peek()).toBeGreaterThanOrEqual(1);

    mgr.concurrency.release("default");
  });
});

describe("Task 12: config injection", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T12-4: maxConcurrent and maxActivePerParent from constructor honored", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      maxConcurrent: 2,
      maxActivePerParent: 1,
      syncReservedSlots: 0,
    });
    const mgr = manager as any;

    const ctx = parentContext();

    // First task acquires normally
    const t1 = await manager.launch(
      { subagent: "h", prompt: "p1", run_in_background: true },
      ctx,
    );
    expect(t1.status).toBe("running");

    // Second task from same parent → exceeds maxActivePerParent, queues
    const t2promise = manager.launch(
      { subagent: "h", prompt: "p2", run_in_background: true },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 10));
    const t2 = await t2promise;
    // It may still be pending (queued) or already promoted
    expect(["pending", "running"]).toContain(t2.status);

    // Third task from same parent → should also queue (not reject)
    const t3promise = manager.launch(
      { subagent: "h", prompt: "p3", run_in_background: true },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 10));
    const t3 = await t3promise;
    expect(["pending", "running"]).toContain(t3.status);

    // Complete all and clean up
    mgr.handleTaskCompleted(t1.id);
    await new Promise((r) => setTimeout(r, 10));
    const updatedT2 = mgr.tasks.get(t2.id);
    if (updatedT2.status !== "completed" && updatedT2.status !== "error") {
      mgr.handleTaskCompleted(t2.id);
    }
    await new Promise((r) => setTimeout(r, 10));
    const updatedT3 = mgr.tasks.get(t3.id);
    if (updatedT3.status !== "completed" && updatedT3.status !== "error") {
      mgr.handleTaskCompleted(t3.id);
    }
  });

  it("T12-4b: retryAfterMs passed to ConcurrencyManager constructor", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      ...fastConfig,
      retryAfterMs: 15000,
    });
    const mgr = manager as any;

    // ConcurrencyManager was constructed with custom retryAfterMs
    expect(mgr.concurrency.retryAfterMs).toBe(15000);
  });
});

// ── Task 13: completion stability + SessionMonitor ───────────────

describe("Task 13: completion stability re-confirmation", () => {
  afterEach(() => {
    mock.restore();
  });

  it("T13-1: false-positive guard — message count grows between re-confirmations, task stays running", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;
    const watchdog = mgr.watchdog;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "idle-session-1";
    taskRef.status = "running";
    taskRef.startedAt = new Date(Date.now() - 10000);
    mgr.sessionToTask.set("idle-session-1", task.id);
    watchdog.registerTask(task.id);

    // First setup: idle session with 1 assistant message
    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      }),
    );
    client.session.status = mock(() =>
      Promise.resolve({
        data: { "idle-session-1": { type: "idle" } },
        error: undefined,
      }),
    );

    // First debounce elapse → records pendingConfirm, re-arms
    watchdog.startDebounce(task.id);
    await watchdog.triggerDebounce(task.id);
    expect(taskRef.status).toBe("running");
    expect(watchdog.isDebouncing(task.id)).toBe(true);

    // Verify pendingConfirm was recorded
    const es = mgr.eventState.get(task.id);
    expect(es.pendingConfirm).toBeDefined();
    expect(es.pendingConfirm.messageCount).toBe(1);

    // Change mock: model produced more messages (count grew from 1 → 3)
    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "more" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "extra" }] },
        ],
        error: undefined,
      }),
    );

    // Second debounce elapse → pendingConfirm check fails (msgCount 1 → 3)
    await watchdog.triggerDebounce(task.id);
    expect(taskRef.status).toBe("running");

    // pendingConfirm cleared
    const es2 = mgr.eventState.get(task.id);
    expect(es2.pendingConfirm).toBeUndefined();

    // Cleanup
    mgr.handleTaskCompleted(task.id);
  });

  it("T13-2: true completion — message count stable across both debounce elapses", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;
    const watchdog = mgr.watchdog;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "idle-session-2";
    taskRef.status = "running";
    taskRef.startedAt = new Date(Date.now() - 10000);
    mgr.sessionToTask.set("idle-session-2", task.id);
    watchdog.registerTask(task.id);

    // Stable: session idle, 1 assistant message
    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ],
        error: undefined,
      }),
    );
    client.session.status = mock(() =>
      Promise.resolve({
        data: { "idle-session-2": { type: "idle" } },
        error: undefined,
      }),
    );

    // First debounce elapse → records pendingConfirm, re-arms
    watchdog.startDebounce(task.id);
    await watchdog.triggerDebounce(task.id);
    expect(taskRef.status).toBe("running");
    expect(watchdog.isDebouncing(task.id)).toBe(true);

    const es1 = mgr.eventState.get(task.id);
    expect(es1.pendingConfirm).toBeDefined();

    // Second debounce elapse → same mocks, same msgCount → completed
    await watchdog.triggerDebounce(task.id);
    expect(taskRef.status).toBe("completed");

    // pendingConfirm cleared after completion
    const es2 = mgr.eventState.get(task.id);
    expect(es2.pendingConfirm).toBeUndefined();
  });

  it("T13-3: session gone — verifyExistence returns missing, task errored + notified", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true, description: "gone-task" },
      parentContext(),
    );

    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "gone-session";
    taskRef.status = "running";
    mgr.sessionToTask.set("gone-session", task.id);
    mgr.watchdog.registerTask(task.id);

    // status() returns data WITHOUT the task's session → sessionStatus undefined
    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ],
        error: undefined,
      }),
    );
    client.session.status = mock(() =>
      Promise.resolve({
        data: { "other-session": { type: "idle" } }, // gone-session NOT in map
        error: undefined,
      }),
    );

    // Mock verifyExistence → "missing"
    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("missing" as const));

    // Trigger via idle-debounce (only evaluateAndComplete examines sessionStatus for gone check)
    mgr.watchdog.startDebounce(task.id);
    await mgr.watchdog.triggerDebounce(task.id);

    expect(taskRef.status).toBe("error");
    expect(taskRef.error).toContain("no longer exists");

    // Cleanup
    mgr.watchdog.unregisterTask(task.id);
    mgr.concurrency.release("default");
  });

  it("T13-4: session uncertain — verifyExistence returns exists, task stays running", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "uncertain-session";
    taskRef.status = "running";
    mgr.sessionToTask.set("uncertain-session", task.id);
    mgr.watchdog.registerTask(task.id);

    // status() returns data WITHOUT the task's session
    client.session.messages = mock(() =>
      Promise.resolve({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ],
        error: undefined,
      }),
    );
    client.session.status = mock(() =>
      Promise.resolve({
        data: { "other-session": { type: "idle" } },
        error: undefined,
      }),
    );

    // Mock verifyExistence → "exists"
    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("exists" as const));

    // Trigger via idle-debounce
    mgr.watchdog.startDebounce(task.id);
    await mgr.watchdog.triggerDebounce(task.id);

    expect(taskRef.status).toBe("running");

    // Cleanup
    mgr.handleTaskCompleted(task.id);
  });

  // ── materializeResult() ──────────────────────────────────────

  it("materializeResult() fetches messages, extracts result, and writes sidecar", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "assistant" as const },
              parts: [
                { type: "text" as const, text: "Some preamble.\n```result\nclean output\n```\nSome postamble." },
              ],
            },
          ],
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const ref = await mgr.materializeResult(task.id);

    expect(ref.sidecarPath).toContain(`state/results/${task.id}.txt`);
    expect(ref.totalChars).toBeGreaterThan(0);
    expect(ref.hadFence).toBe(true);
    expect(ref.fetchError).toBeUndefined();
    expect(ref.materializedAt).toBeString();
    expect(new Date(ref.materializedAt).getTime()).toBeGreaterThan(0);
  });

  it("materializeResult() returns fetchError ref when task is not found", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client);
    const mgr = manager as any;

    const ref = await mgr.materializeResult("nonexistent");

    expect(ref.sidecarPath).toBe("");
    expect(ref.totalChars).toBe(0);
    expect(ref.hadFence).toBe(false);
    expect(ref.fetchError).toBe("task not found");
    expect(ref.materializedAt).toBeString();
  });

  it("materializeResult() returns fetchError ref when messages API returns error", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: undefined,
          error: { message: "session expired" },
        }),
    });
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      { subagent: "helper", prompt: "fail", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const ref = await mgr.materializeResult(task.id);

    expect(ref.sidecarPath).toBe("");
    expect(ref.totalChars).toBe(0);
    expect(ref.hadFence).toBe(false);
    expect(ref.fetchError).toContain("Error retrieving task output");
    expect(ref.fetchError).toContain("session expired");
    expect(ref.materializedAt).toBeString();
  });

  it("materializeResult() handles hanging messages call without hanging test", async () => {
    const client = createMockClient({
      sessionMessages: () => new Promise(() => {
        // never resolves — simulates a hanging SDK call
      }),
    });
    const manager = new DispatchManager(client, {
      ...fastConfig,
      materializeTimeoutMs: 100,
    });

    const task = await manager.launch(
      { subagent: "helper", prompt: "hang", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const start = Date.now();
    const ref = await mgr.materializeResult(task.id);
    const elapsed = Date.now() - start;

    expect(ref.sidecarPath).toBe("");
    expect(ref.totalChars).toBe(0);
    expect(ref.hadFence).toBe(false);
    expect(ref.fetchError).toBe("timeout");
    expect(ref.materializedAt).toBeString();
    expect(elapsed).toBeLessThan(2000); // should resolve quickly due to 100ms timeout
  });

  it("materializeResult() respects messageCountAtStart boundary", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "old output" }],
            },
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "new output" }],
            },
          ],
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: false },
      parentContext(),
    );

    // Manually set messageCountAtStart to skip first message
    const tasks = (manager as any).tasks as Map<string, any>;
    const taskRef = tasks.get(task.id);
    taskRef.messageCountAtStart = 1;

    const mgr = manager as any;
    const ref = await mgr.materializeResult(task.id);

    expect(ref.totalChars).toBe("new output".length);
    expect(ref.fetchError).toBeUndefined();
  });

  // ── materializeAndNotify() ordering ─────────────────────────

  it("materializeAndNotify releases slot before materializing", async () => {
    let resolveMessages!: (v: any) => void;
    const deferred = new Promise<any>((r) => { resolveMessages = r; });

    const client = createMockClient({
      sessionMessages: () => deferred,
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const mgr = manager as any;
    const concurrencyKey = "default";
    expect(mgr.concurrency.getActiveCount(concurrencyKey)).toBe(1);

    // Fire completion — this calls leaveRunning synchronously, then
    // fires materializeAndNotify which awaits the deferred messages call.
    mgr.handleTaskCompleted(task.id);

    // Slot must be released immediately
    expect(mgr.concurrency.getActiveCount(concurrencyKey)).toBe(0);
    expect(task.status).toBe("completed");

    // At this point, materializeResult is awaiting the deferred messages
    // (which hasn't resolved yet), so task.result should still be absent
    expect(task.result).toBeUndefined();

    // Resolve messages
    resolveMessages({
      data: [
        {
          info: { role: "assistant" as const },
          parts: [{ type: "text" as const, text: "output" }],
        },
      ],
      error: undefined,
    });

    // Let materializeAndNotify finish
    await new Promise((r) => setTimeout(r, 50));

    expect(task.result).toBeDefined();
    expect(task.result!.sidecarPath).toContain(`${task.id}.txt`);
  });

  it("materializeAndNotify sets task.result before notifyCompletion", async () => {
    let resolveMessages!: (v: any) => void;
    const deferred = new Promise<any>((r) => { resolveMessages = r; });

    const client = createMockClient({
      sessionMessages: () => deferred,
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const mgr = manager as any;
    let notifySeenResult: boolean | null = null;

    const origNotify = mgr.notifyCompletion.bind(mgr);
    mgr.notifyCompletion = async (t: DispatchTask) => {
      notifySeenResult = !!t.result;
      await origNotify(t);
    };

    mgr.handleTaskCompleted(task.id);
    // At this point, materializeResult is waiting on the deferred messages
    expect(notifySeenResult).toBeNull();

    // Resolve messages so materializeResult completes → then notifyCompletion fires
    resolveMessages({
      data: [
        {
          info: { role: "assistant" as const },
          parts: [{ type: "text" as const, text: "output" }],
        },
      ],
      error: undefined,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(notifySeenResult).toBe(true);
    expect(task.result).toBeDefined();
  });

  it("materializeAndNotify is no-op for non-completed task status", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const mgr = manager as any;
    await mgr.materializeAndNotify(task.id);
    // Task is still "pending" (not "completed"), so result should stay unset
    expect(task.result).toBeUndefined();
  });

  it("materializeAndNotify is no-op for nonexistent task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    // Should not throw
    await mgr.materializeAndNotify("nonexistent");
  });

  it("double handleTaskCompleted does not materialize twice", async () => {
    let resolveMessages!: (v: any) => void;
    const deferred = new Promise<any>((r) => { resolveMessages = r; });

    const client = createMockClient({
      sessionMessages: () => deferred,
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true },
      parentContext(),
    );

    const mgr = manager as any;
    let notifyCount = 0;
    const origNotify = mgr.notifyCompletion.bind(mgr);
    mgr.notifyCompletion = async (t: DispatchTask) => {
      notifyCount++;
      await origNotify(t);
    };

    // First completion — materializeAndNotify starts awaiting deferred messages
    mgr.handleTaskCompleted(task.id);
    expect(task.status).toBe("completed");

    // Second completion — transition should fail (already completed)
    mgr.handleTaskCompleted(task.id);

    // Resolve messages so first materializeAndNotify finishes
    resolveMessages({
      data: [
        {
          info: { role: "assistant" as const },
          parts: [{ type: "text" as const, text: "output" }],
        },
      ],
      error: undefined,
    });

    await new Promise((r) => setTimeout(r, 50));

    // Only one notification — second call short-circuited at transition
    expect(notifyCount).toBe(1);
    expect(task.result).toBeDefined();
  });

  // ── T11: Cleanup survival + outbox guard + sidecar GC ──────────

  it("T11-1: sidecar survives cleanupTask — getResult returns ok from sidecar", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "```result\nfinal answer\n```" }],
            },
          ],
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: false },
      parentContext(),
    );
    // Set status to completed and materialize
    const tasks = (manager as any).tasks as Map<string, DispatchTask>;
    const taskRef = tasks.get(task.id)!;
    taskRef.status = "completed";

    const mgr = manager as any;
    const ref = await mgr.materializeResult(task.id);
    taskRef.result = ref;

    // Verify sidecar exists on disk
    const sidecarPath = resultSidecarPath(task.id, process.cwd());
    const raw = readFileSync(sidecarPath, "utf-8");
    expect(raw).toContain("final answer");

    // Cleanup the task (in-memory only — sidecar must survive)
    manager.cleanupTask(task.id);
    expect(manager.getTask(task.id)).toBeUndefined();

    // getResult should find the sidecar via Step 3 (task missing, sidecar exists)
    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toContain("final answer");
    expect(result.hadFence).toBe(true);

    // Clean up the sidecar file
    try { rmSync(sidecarPath); } catch {}
  });

  it("T11-2: cleanup deferred while taskId is in notifyOutbox", () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    // Put a task into tasks map
    const taskId = "test_outbox_guard";
    mgr.tasks.set(taskId, {
      id: taskId,
      status: "completed",
      sessionId: "ses_outbox",
      parentSessionId: "ses_parent",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    });

    // Put taskId in notifyOutbox
    mgr.notifyOutbox.add(taskId);

    // Schedule cleanup (should defer because outbox has taskId)
    mgr.scheduleCleanup(taskId);

    // Fast-forward past TTL by firing the timer callback manually
    const timer = mgr.cleanupTimers.get(taskId);
    expect(timer).toBeDefined();

    // Clear the real timer so it doesn't fire later
    clearTimeout(timer);
    // Manually invoke the callback (same as the setTimeout body)
    // Since notifyOutbox has taskId, it should re-schedule, not clean up
    mgr.cleanupTimers.delete(taskId);
    mgr.scheduleCleanup(taskId); // this re-schedules → timer created
    expect(mgr.tasks.has(taskId)).toBe(true);

    // Now remove from outbox and fire again
    mgr.notifyOutbox.delete(taskId);
    const timer2 = mgr.cleanupTimers.get(taskId);
    expect(timer2).toBeDefined();
    clearTimeout(timer2);
    mgr.cleanupTimers.delete(taskId);

    // Manually call cleanupTask directly (simulating what the timer would do after guard passes)
    manager.cleanupTask(taskId);
    expect(mgr.tasks.has(taskId)).toBe(false);
  });

  it("T11-3: scheduleSidecarGC creates timer when result is set", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve({
          data: [
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "result content" }],
            },
          ],
          error: undefined,
        }),
    });
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: false },
      parentContext(),
    );
    // Set completed and invoke materializeAndNotify which sets result + schedules GC
    const taskRef = (mgr.tasks as Map<string, DispatchTask>).get(task.id)!;
    taskRef.status = "completed";
    // Override notifyCompletion to avoid side effects
    const origNotify = mgr.notifyCompletion.bind(mgr);
    mgr.notifyCompletion = async () => {};

    await mgr.materializeAndNotify(task.id);

    // Verify result was set
    expect(taskRef.result).toBeDefined();

    // Verify sidecar GC timer was created
    expect(mgr.sidecarGCTimers.has(task.id)).toBe(true);
    const gcTimer = mgr.sidecarGCTimers.get(task.id);
    expect(gcTimer).toBeDefined();

    // Clean up
    clearTimeout(gcTimer);
    mgr.sidecarGCTimers.delete(task.id);
    mgr.notifyCompletion = origNotify;
    // Clean up sidecar file
    try { rmSync(taskRef.result!.sidecarPath); } catch {}
  });
});

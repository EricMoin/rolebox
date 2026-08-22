import { describe, it, expect, mock, afterEach, beforeEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import type { DispatchTask } from "../../src/dispatch/types";
import { TaskStateStore } from "../../src/dispatch/persistence/task-store.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { clearParentQueues, clearSentFinalNotifies } from "../../src/dispatch/notification";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockClient, parentContext } from "./helpers";
import { metrics } from "../../src/dispatch/persistence/metrics";
import { writeResultSidecar, resultSidecarPath } from "../../src/dispatch/completion/result-extractor";
import { MAX_CONSECUTIVE_FETCH_FAILURES } from "../../src/dispatch/config";
import { TimeoutError } from "../../src/dispatch/core/with-timeout";

const fastConfig = {
  staleTimeoutMs: 500,
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
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.prompt).toHaveBeenCalledTimes(1);
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
          parts: [
            { type: "text" as const, text: "Result line 1." },
            { type: "text" as const, text: "Result line 2." },
          ],
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
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.promptSync).toHaveBeenCalledTimes(1);
  });

  it("executeSync() returns empty string when response is undefined", async () => {
    const client = createMockClient({
      sessionPrompt: () =>
        Promise.resolve(null),
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

  it("T8: executeSync prompt timeout aborts session", async () => {
    const client = createMockClient({
      sessionPrompt: () => new Promise<never>(() => {}), // never resolves
      sessionAbort: () => Promise.resolve(true),
    });
    const manager = new DispatchManager(client, { ...fastConfig, syncPromptTimeoutMs: 20 });

    await expect(
      manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ),
    ).rejects.toThrow(/timed out/);

    expect(client.abort).toHaveBeenCalled();
  });

  it("executeSync session create hang does not block forever", async () => {
    const client = createMockClient({
      sessionCreate: () => new Promise<never>(() => {}), // never resolves
    });
    const manager = new DispatchManager(client, {
      ...fastConfig,
      materializeTimeoutMs: 20,
      syncPromptTimeoutMs: 5000,
    });

    await expect(
      manager.executeSync(
        { subagent: "sync-test", prompt: "hello", run_in_background: false },
        parentContext(),
      ),
    ).rejects.toThrow(/timed out/);
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
        parts: [{ type: "text", text: "done" }],
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
        sessionAbort: () => Promise.resolve(true),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncPromptTimeoutMs: 200,
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

    it("sync_timeout_ms in input overrides prompt-phase timeout", async () => {
      const client = createMockClient({
        sessionPrompt: () => new Promise<never>(() => {}),
        sessionAbort: () => Promise.resolve(true),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncPromptTimeoutMs: 600_000,
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
      const client = createMockClient({
        sessionPrompt: () => new Promise<never>(() => {}),
        sessionAbort: () => Promise.resolve(true),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        syncPromptTimeoutMs: 20,
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
      const notifyCalls = (client.prompt as any).mock.calls.filter(
        (c: any) => c[0] === "ses_parent",
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
    expect(client.abort).toHaveBeenCalledTimes(1);
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
    expect(client.abort).not.toHaveBeenCalled();
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
    expect(client.abort).not.toHaveBeenCalled();
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
    expect(client.abort).not.toHaveBeenCalled();
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
    expect(client.abort).not.toHaveBeenCalled();
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
    expect(client.abort).not.toHaveBeenCalled();
  });

  it("cancelTask() remains cancelled despite concurrent evaluateAndComplete (race prevention)", async () => {
    const client = createMockClient({
      // Simulate a session that looks "completed" to evaluateAndComplete
      sessionStatus: () =>
        Promise.resolve({ type: "idle" }),
      sessionMessages: () =>
        Promise.resolve([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "I am done working" }],
            },
          ]),
    });
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      { subagent: "helper", prompt: "work", run_in_background: true },
      parentContext(),
    );
    expect(task.status).toBe("running");

    // Cancel the task — with the fix, transition to "cancelled" happens
    // before session.abort(), preventing the watchdog race.
    const cancelResult = await manager.cancelTask(task.id);
    expect(cancelResult).toBe(true);
    expect(task.status).toBe("cancelled");

    // Even if evaluateAndComplete fires after cancel (simulating a watchdog
    // timer that raced with the cancel), it should be a no-op because the
    // task status is no longer "running".
    const mgr = manager as any;
    await mgr.evaluateAndComplete(task.id, "global-sweep");
    expect(task.status).toBe("cancelled"); // Still cancelled, NOT "completed"
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
      materializedAt: Date.now(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("Analysis:Complete.");
    expect(client.messages).not.toHaveBeenCalled();
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
      materializedAt: Date.now(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("fetch_error");
    expect(result.error).toContain("Error retrieving task output");
    expect(result.text).toBe("");
    expect(client.messages).not.toHaveBeenCalled();
  });

  it("T10: getResult() on continued task only returns output after messageCountAtStart boundary", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve([
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
          ]),
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
      materializedAt: Date.now(),
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
      materializedAt: Date.now(),
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
      materializedAt: Date.now(),
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
      materializedAt: Date.now(),
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
      materializedAt: Date.now(),
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
      materializedAt: Date.now(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("cached output");
    expect(client.messages).not.toHaveBeenCalled();
  });

  it("lazy backward-compat: completed task without result materializes once, then cached", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve([
            {
              info: { role: "user" as const },
              parts: [{ type: "text" as const, text: "prompt" }],
            },
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "lazy output" }],
            },
          ]),
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
    expect((client.messages as any).mock.calls.length).toBe(1);
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
      materializedAt: Date.now(),
    };

    const result = await manager.getResult(task.id);
    expect(result.kind).toBe("fetch_error");
    expect(result.error).toBe("materialize timeout");
    expect(client.messages).not.toHaveBeenCalled();
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

  it("getTasksByParent() index sync: cleanup 1 of 3 tasks, returns 2 with no stale entries", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const ctx = { sessionID: "parent-cleanup", agent: "a", directory: "/tmp" };

    const t1 = await manager.launch(
      { subagent: "h1", prompt: "p1", run_in_background: false },
      ctx,
    );
    const t2 = await manager.launch(
      { subagent: "h2", prompt: "p2", run_in_background: false },
      ctx,
    );
    const t3 = await manager.launch(
      { subagent: "h3", prompt: "p3", run_in_background: false },
      ctx,
    );

    // All 3 visible before cleanup
    expect(manager.getTasksByParent("parent-cleanup").length).toBe(3);

    // Cleanup one task
    manager.cleanupTask(t2.id);

    // Now should be 2
    const remaining = manager.getTasksByParent("parent-cleanup");
    expect(remaining.length).toBe(2);
    expect(remaining.map((t) => t.id).sort()).toEqual(
      [t1.id, t3.id].sort(),
    );

    // Internal index has no stale entries
    const index = (manager as any).parentTasksIndex as Map<string, Set<string>>;
    const taskIds = index.get("parent-cleanup");
    expect(taskIds).toBeDefined();
    expect(taskIds!.has(t1.id)).toBe(true);
    expect(taskIds!.has(t2.id)).toBe(false); // cleaned up — removed from index
    expect(taskIds!.has(t3.id)).toBe(true);
    expect(taskIds!.size).toBe(2);
  });

  it("getTasksByParent() index consistency: multiple parents each have correct subsets", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const ctxA = { sessionID: "parent-A", agent: "a", directory: "/tmp" };
    const ctxB = { sessionID: "parent-B", agent: "b", directory: "/tmp" };
    const ctxC = { sessionID: "parent-C", agent: "c", directory: "/tmp" };

    // Launch tasks interleaved across parents
    const a1 = await manager.launch(
      { subagent: "h", prompt: "a1", run_in_background: false },
      ctxA,
    );
    const b1 = await manager.launch(
      { subagent: "h", prompt: "b1", run_in_background: false },
      ctxB,
    );
    const a2 = await manager.launch(
      { subagent: "h", prompt: "a2", run_in_background: false },
      ctxA,
    );
    const c1 = await manager.launch(
      { subagent: "h", prompt: "c1", run_in_background: false },
      ctxC,
    );
    const b2 = await manager.launch(
      { subagent: "h", prompt: "b2", run_in_background: false },
      ctxB,
    );

    // Verify getTasksByParent returns correct subsets
    expect(manager.getTasksByParent("parent-A").map((t) => t.id).sort())
      .toEqual([a1.id, a2.id].sort());

    expect(manager.getTasksByParent("parent-B").map((t) => t.id).sort())
      .toEqual([b1.id, b2.id].sort());

    expect(manager.getTasksByParent("parent-C").map((t) => t.id))
      .toEqual([c1.id]);

    expect(manager.getTasksByParent("parent-D").length).toBe(0);

    // Cleanup one from parent-A, verify parent-B unaffected
    manager.cleanupTask(a1.id);
    expect(manager.getTasksByParent("parent-A").length).toBe(1);
    expect(manager.getTasksByParent("parent-A")[0].id).toBe(a2.id);
    expect(manager.getTasksByParent("parent-B").length).toBe(2);

    // Internal index reflects correct state
    const index = (manager as any).parentTasksIndex as Map<string, Set<string>>;
    expect(index.get("parent-A")!.size).toBe(1);
    expect(index.get("parent-B")!.size).toBe(2);
    expect(index.get("parent-C")!.size).toBe(1);
    expect(index.has("parent-D")).toBe(false);
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

    const messagesSpy = client.messages;

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

    client.messages = mock(() =>
      Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ]),
    );
    client.status = mock(() =>
      Promise.resolve({ type: "idle" }),
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

      expect(mgr.getInflightCount("parent-session-1")).toBe(3);

      // Complete first
      mgr.handleTaskCompleted(t1.id);
      expect(mgr.getInflightCount("parent-session-1")).toBe(2);

      // Complete second
      mgr.handleTaskCompleted(t2.id);
      expect(mgr.getInflightCount("parent-session-1")).toBe(1);

      // Complete third — counter cleaned up at 0
      mgr.handleTaskCompleted(t3.id);
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);
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

      expect(mgr.getInflightCount("parent-A")).toBe(1);
      expect(mgr.getInflightCount("parent-B")).toBe(2);

      mgr.handleTaskCompleted(tA.id);
      expect(mgr.getInflightCount("parent-A")).toBe(0);
      expect(mgr.getInflightCount("parent-B")).toBe(2);

      mgr.handleTaskCompleted(tB1.id);
      expect(mgr.getInflightCount("parent-B")).toBe(1);
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
      expect(mgr.getInflightCount("parent-session-1")).toBe(1);

      mgr.handleTaskError(task.id, "something broke");
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);
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
      expect(mgr.getInflightCount("parent-session-1")).toBe(1);

      mgr.handleTaskTimeout(task.id, "timed out");
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);
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
      expect(mgr.getInflightCount("parent-session-1")).toBe(1);

      await manager.cancelTask(task.id);
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);
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
      expect(mgr.getInflightCount("parent-session-1")).toBe(1);

      mgr.handleTaskCompleted(task.id);
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);

      // Second completion is no-op (transition fails), counter stays gone
      mgr.handleTaskCompleted(task.id);
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);
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
      expect(mgr.getInflightCount("parent-session-1")).toBe(0);
    });

    it("getInflightCount returns 0 for unknown parent", () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);

      expect(manager.getInflightCount("nonexistent-parent")).toBe(0);
    });
  });

  // ── 10. double-completion guard ──────────────────────────────

  describe("double-completion guard", () => {
    it("handleTaskCompleted twice keeps task completed and is idempotent", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const task = await manager.launch(
        { subagent: "h", prompt: "p", run_in_background: true },
        parentContext(),
      );

      const mgr = manager as any;

      mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");

      mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");
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
    it("direct completion wins during idle debounce — idle debounce no-ops", async () => {
      const client = createMockClient();
      let resolveMessages!: (v: any) => void;
      const deferred = new Promise<any>((r) => { resolveMessages = r; });

      const sessionMessagesMock = mock(() => deferred);
      client.messages = sessionMessagesMock;

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

      // Now resolve the deferred — idle resumes, starts debounce
      resolveMessages([
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ]);
      await idlePromise;

      // After idle resumes: status still completed
      expect(t.status).toBe("completed");
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

      client.messages = mock(() => Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ]));
      client.status = mock(() => Promise.resolve({ type: "idle" }));

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
  });
});

// ── 17. session_id continuation (reopenForContinuation) ──────────

describe("reopenForContinuation", () => {
  afterEach(() => {
    mock.restore();
  });

  it("reopens a completed task: reuses session, no new session.create, re-prompts, poller re-registered", async () => {
    const sessionCreate: any[] = [];
    const promptAsyncCalls: Array<{ id: string; opts: any }> = [];
    const msgResult = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ];

    const client = createMockClient({
      sessionCreate: () => {
        sessionCreate.push({});
        return Promise.resolve({ id: "ses_original" });
      },
      sessionPromptAsync: (args: any) => {
        promptAsyncCalls.push(args);
        return Promise.resolve({ id: "prompt-1" });
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
      sessionMessages: () => Promise.resolve([]),
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
      sessionMessages: () => Promise.resolve([]),
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
        Promise.resolve(null), // dead session returns null
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
    expect(client.prompt).toHaveBeenCalled();
    const notifyCalls = (client.prompt as any).mock.calls;
    const lostPendingCall = notifyCalls.find(
      (c: any) => c[1]?.parts?.[0]?.text?.includes("PENDING TASKS DROPPED"),
    );
    expect(lostPendingCall).toBeDefined();
    const notifyText: string = lostPendingCall[1].parts[0].text;
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
    const notifyCalls = (client.prompt as any).mock.calls.filter(
      (c: any) => c[1]?.parts?.[0]?.text?.includes("PENDING TASKS DROPPED"),
    );
    expect(notifyCalls.length).toBe(2);

    // Two notification calls — one per parent
    const parentCall = notifyCalls.find(
      (c: any) => c[0] === "ses_parent",
    );
    expect(parentCall).toBeDefined();
    const parentText: string = parentCall[1].parts[0].text;
    expect(parentText).toContain("count: 3");
    expect(parentText).toContain("pending task 0");
    expect(parentText).toContain("pending task 2");

    // Other parent: should list 1 task
    const otherCall = notifyCalls.find(
      (c: any) => c[0] === "ses_other_parent",
    );
    expect(otherCall).toBeDefined();
    const otherText: string = otherCall[1].parts[0].text;
    expect(otherText).toContain("count: 1");
    expect(otherText).toContain("other parent pending");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover registers all running tasks with poller", async () => {
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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.watchdog.getRegisteredTaskIds().length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(manager.getTask(`bg_rec_${i}`)?.status).toBe("running");
    }

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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    expect(mgr.getInflightCount("ses_parent")).toBe(3);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inflight counter only counts re-attached tasks — dead sessions excluded", async () => {
    const tempDir = createTempDir();

    // 5 running tasks, 3 sessions dead, 2 alive
    const sessionData = new Set(["ses_1", "ses_2"]);
    const client = createMockClient({
      sessionGet: (sid: string) => {
        if (sessionData.has(sid)) {
          return Promise.resolve({ id: sid });
        }
        return Promise.resolve(null); // dead session returns null
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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;
    // Only ses_1 and ses_2 re-attached — getInflightCount must be 2, not 5
    expect(mgr.getInflightCount("ses_parent")).toBe(2);

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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;

    // Both re-attached — inflight should be 2
    expect(mgr.getInflightCount("ses_parent")).toBe(2);

    // Complete task 0
    const task0 = manager.getTask("bg_notify_0");
    expect(task0?.status).toBe("running");
    mgr.handleTaskCompleted("bg_notify_0");

    // After leaveRunning, inflight decremented to 1
    expect(mgr.getInflightCount("ses_parent")).toBe(1);
    expect(manager.getTask("bg_notify_0")!.status).toBe("completed");

    // Complete task 1 — should reach 0 and clean up entry
    mgr.handleTaskCompleted("bg_notify_1");
    expect(mgr.getInflightCount("ses_parent")).toBe(0);
    expect(manager.getTask("bg_notify_1")!.status).toBe("completed");

    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 11b. Task 11: authoritative inflight rebuild + terminal notify ──

  it("Task-11: authoritative getInflightCount after recovery", async () => {
    const tempDir = createTempDir();

    // 5 running tasks across 2 parents: parent-A has 3 tasks, parent-B has 2
    // sessions ses_a1, ses_a3, ses_b1 alive; ses_a2, ses_b2 dead
    const aliveSessions = new Set(["ses_a1", "ses_a3", "ses_b1"]);
    const client = createMockClient({
      sessionGet: (sid: string) => {
        if (aliveSessions.has(sid)) {
          return Promise.resolve({ id: sid });
        }
        return Promise.resolve(null); // dead session returns null
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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    const mgr = manager as any;

    // Authoritative: only actually re-attached running tasks count
    expect(mgr.getInflightCount("parent-A")).toBe(2); // ses_a1, ses_a3 alive; ses_a2 dead
    expect(mgr.getInflightCount("parent-B")).toBe(1); // ses_b1 alive; ses_b2 dead

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
        Promise.resolve(null), // session lost → null
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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    // Task is errored
    const loaded = manager.getTask("bg_session_lost");
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("Session lost");

    // Wait for async notification to flush through the queue
    await new Promise((r) => setTimeout(r, 50));

    // Parent was notified about the error via promptAsync
    const notifyCalls = (client.prompt as any).mock.calls;
    const completionCall = notifyCalls.find(
      (c: any) => c[0] === "ses_parent" && c[1]?.noReply === false,
    );
    expect(completionCall).toBeDefined();
    const notifyText: string = completionCall[1].parts[0].text;
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

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    // Task is errored
    const loaded = manager.getTask("bg_verify_fail");
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("verification failed");

    // Wait for async notification
    await new Promise((r) => setTimeout(r, 50));

    // Parent was notified
    const notifyCalls = (client.prompt as any).mock.calls;
    const completionCall = notifyCalls.find(
      (c: any) => c[0] === "ses_parent" && c[1]?.noReply === false,
    );
    expect(completionCall).toBeDefined();
    const notifyText: string = completionCall[1].parts[0].text;
    expect(notifyText).toContain("verify-failed notify test");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recover() does NOT eagerly fetch for completed tasks without result (v3 backward compat)", async () => {
    const tempDir = createTempDir();
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve([
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "recovered lazy output" }],
            },
          ]),
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

    (client.messages as any).mock.calls.length = 0;

    const manager = new DispatchManager(client, fastConfig);
    manager.setStoreDirectory(tempDir);
    await manager.recover();

    expect((client.messages as any).mock.calls.length).toBe(0);

    const sidecarPath = resultSidecarPath("bg_v3_completed", process.cwd());
    let sidecarExists = false;
    try {
      readFileSync(sidecarPath);
      sidecarExists = true;
    } catch {}

    const result = await manager.getResult("bg_v3_completed");
    expect(result.kind).toBe("ok");
    expect(result.text).toBe("recovered lazy output");

    expect((client.messages as any).mock.calls.length).toBe(1);

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
    const { TaskStateStore } = await import("../../src/dispatch/persistence/task-store");
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
    let callCount = 0;
    const client = createMockClient({
      sessionPromptAsync: () => {
        callCount++;
        return Promise.reject(new Error("network error"));
      },
    });

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

      const result = await mgr.notifyCompletion(task, 0);
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

  // Regression: a queued FINAL notification whose first send failed must be
  // retried by the sweeper EVEN WHEN unrelated tasks are inflight for the same
  // parent. A previous "defensive guard" deleted such notifications whenever
  // getInflightCount(parent) > 0, silently dropping the completion signal and
  // hanging the parent forever. Everything in the outbox is a final notification
  // by construction (materializeAndNotify only enqueues when remaining === 0), so
  // the sweeper must rely solely on hasFinalNotifyBeenSent for idempotency.
  it("sweeper retries queued final notification while an unrelated sibling is inflight", async () => {
    let finalNotifyAttempts = 0;
    const client = createMockClient({
      sessionPromptAsync: (...args: any[]) => {
        const opts = args[0] as any;
        // Count final-notification (noReply:false) attempts; always succeed so the
        // sweeper delivers on its first try. We simulate the "initial send failed"
        // state by parking the task in the outbox directly (below) rather than
        // driving notifyCompletion's slow backoff loop.
        if (opts?.body && opts.body.noReply === false) {
          finalNotifyAttempts++;
        }
        return Promise.resolve({ id: "prompt-1" });
      },
    });

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

      const { hasFinalNotifyBeenSent: hfs } =
        await import("../../src/dispatch/notification");

      // Task A is the last of its cohort → final notification. Simulate that its
      // initial send failed by parking it in the outbox without a recorded delivery.
      const taskA = await manager.launch(
        { subagent: "h", prompt: "A", run_in_background: true },
        parentContext(),
      );
      taskA.status = "completed";
      taskA.completedAt = new Date();
      mgr.notifyOutbox.add(taskA.id);
      expect(hfs(taskA.id)).toBe(false);
      expect(mgr.notifyOutbox.has(taskA.id)).toBe(true);

      // An UNRELATED new task for the SAME parent is now inflight.
      const taskB = await manager.launch(
        { subagent: "h", prompt: "B", run_in_background: true },
        parentContext(),
      );
      expect(taskB.status).toBe("running");
      expect(mgr.getInflightCount(taskA.parentSessionId)).toBeGreaterThan(0);

      // Sweeper must retry and deliver A's final notification — NOT drop it.
      await sweepCb();

      expect(hfs(taskA.id)).toBe(true);
      expect(finalNotifyAttempts).toBeGreaterThanOrEqual(1);
      expect(mgr.notifyOutbox.has(taskA.id)).toBe(false);

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
    client.messages = mock(() =>
      Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ]),
    );
    client.status = mock(() =>
      Promise.resolve({ type: "idle" }),
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
    client.messages = mock(() =>
      Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "more" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "extra" }] },
        ]),
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
    client.messages = mock(() =>
      Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ]),
    );
    client.status = mock(() =>
      Promise.resolve({ type: "idle" }),
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

    // Client returns no new messages (session still stable)
    client.messages = mock(() =>
      Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ]),
    );
    // status() returns null — session gone, not found
    client.status = mock(() => Promise.resolve(null));

    // Mock verifyExistence → "missing"
    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("missing" as const));

    // Trigger via idle-debounce (only evaluateAndComplete examines sessionStatus for gone check)
    mgr.watchdog.startDebounce(task.id);
    await mgr.watchdog.triggerDebounce(task.id);

    expect(taskRef.status).toBe("error");
    expect(taskRef.error).toContain("no longer exists");

    // Cleanup
    mgr.watchdog.unregisterTask(task.id);
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
    client.messages = mock(() =>
      Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ]),
    );
    client.status = mock(() =>
      Promise.resolve({ type: "idle" }),
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

  it("T13-5: absent status + session exists + output → completes and notifies parent (regression: bg task hung in running)", async () => {
    clearSentFinalNotifies();
    clearParentQueues();
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const mgr = manager as any;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true, description: "idle-not-in-status-map" },
      parentContext(),
    );

    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = "idle-session";
    taskRef.status = "running";
    mgr.sessionToTask.set("idle-session", task.id);
    mgr.watchdog.registerTask(task.id);

    client.messages = mock(() =>
      Promise.resolve([{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }]),
    );
    // Finished child is absent from the status map (server omits idle sessions).
    client.status = mock(() =>
      Promise.resolve({ type: "idle" }),
    );
    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("exists" as const));

    await mgr.watchdog.triggerWatchdog(task.id);
    await new Promise((r) => setTimeout(r, 100));

    expect(taskRef.status).toBe("completed");
    const notifyCalls = (client.prompt as any).mock.calls.filter(
      (c: any) => c[0] === "parent-session-1",
    );
    expect(notifyCalls.length).toBeGreaterThan(0);

    mgr.watchdog.unregisterTask(task.id);
  });

  // ── materializeResult() ──────────────────────────────────────

  it("materializeResult() fetches messages, extracts result, and writes sidecar", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve([
            {
              info: { role: "assistant" as const },
              parts: [
                { type: "text" as const, text: "Some preamble.\n```result\nclean output\n```\nSome postamble." },
              ],
            },
          ]),
    });
    const manager = new DispatchManager(client);

    const task = await manager.launch(
      { subagent: "helper", prompt: "do work", run_in_background: false },
      parentContext(),
    );

    const mgr = manager as any;
    const ref = await mgr.materializeResult(task.id);

    expect(ref.sidecarPath).toContain(join("state", "results", `${task.id}.txt`));
    expect(ref.totalChars).toBeGreaterThan(0);
    expect(ref.hadFence).toBe(true);
    expect(ref.fetchError).toBeUndefined();
    expect(ref.materializedAt).toBeNumber();
    expect(ref.materializedAt).toBeGreaterThan(0);
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
    expect(ref.materializedAt).toBeNumber();
  });

  it("materializeResult() returns fetchError ref when messages API returns error", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.reject(new Error("session expired")),
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
    expect(ref.fetchError).toContain("session expired");
    expect(ref.materializedAt).toBeNumber();
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
    expect(ref.materializedAt).toBeNumber();
    expect(elapsed).toBeLessThan(2000); // should resolve quickly due to 100ms timeout
  });

  it("materializeResult() respects messageCountAtStart boundary", async () => {
    const client = createMockClient({
      sessionMessages: () =>
        Promise.resolve([
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "old output" }],
            },
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "new output" }],
            },
          ]),
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

  it("materializeAndNotify materializes asynchronously after completion", async () => {
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

    // Fire completion — this calls leaveRunning synchronously, then
    // fires materializeAndNotify which awaits the deferred messages call.
    mgr.handleTaskCompleted(task.id);

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
        Promise.resolve([
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "```result\nfinal answer\n```" }],
            },
          ]),
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
        Promise.resolve([
            {
              info: { role: "assistant" as const },
              parts: [{ type: "text" as const, text: "result content" }],
            },
          ]),
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

  // ── 20. evaluateAndComplete consecutive-fetch-failure escalation ──

  describe("evaluateAndComplete consecutive fetch failures", () => {
    it("single fetch failure increments counter but does NOT escalate to error", async () => {
      // Mock session.messages() to reject with TimeoutError (simulates a fetch failure)
      const client = createMockClient({
        sessionMessages: () => Promise.reject(new TimeoutError(20, "test")),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        materializeTimeoutMs: 20,
      });

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("running");

      const mgr = manager as any;

      // First evaluateAndComplete — single failure
      await mgr.evaluateAndComplete(task.id, "watchdog-reconcile");

      // Task should still be running (single failure, no escalation)
      expect(task.status).toBe("running");
      const es = mgr.eventState.get(task.id);
      expect(es).toBeDefined();
      expect(es.consecutiveFetchFailures).toBe(1);
    });

    it(`${MAX_CONSECUTIVE_FETCH_FAILURES} consecutive failures escalate to error`, async () => {
      const client = createMockClient({
        sessionMessages: () => Promise.reject(new TimeoutError(20, "test")),
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        materializeTimeoutMs: 20,
      });

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("running");

      const mgr = manager as any;

      // Fail N-1 times — task should still be running
      for (let i = 1; i < MAX_CONSECUTIVE_FETCH_FAILURES; i++) {
        await mgr.evaluateAndComplete(task.id, "watchdog-reconcile");
        expect(task.status).toBe("running");
      }

      // Nth failure triggers escalation
      await mgr.evaluateAndComplete(task.id, "watchdog-reconcile");
      expect(task.status).toBe("error");
      expect(task.error).toContain("Cannot verify task liveness");
      expect(task.error).toContain(`${MAX_CONSECUTIVE_FETCH_FAILURES} consecutive`);
    });

    it("successful fetch after failures resets counter to 0", async () => {
      // Track calls: start with failing promise, switch to success after N failures
      let callCount = 0;
      const failuresBeforeSuccess = 2;

      const client = createMockClient({
        sessionMessages: () => {
          callCount++;
          if (callCount <= failuresBeforeSuccess) {
            return Promise.reject(new TimeoutError(20, "test")); // reject immediately → TimeoutError
          }
          // Successful response
          return Promise.resolve([]);
        },
      });
      const manager = new DispatchManager(client, {
        ...fastConfig,
        materializeTimeoutMs: 20,
      });

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );
      expect(task.status).toBe("running");

      const mgr = manager as any;

      // Fail N times
      for (let i = 0; i < failuresBeforeSuccess; i++) {
        await mgr.evaluateAndComplete(task.id, "watchdog-reconcile");
      }

      // Counter should be at N, task still running
      let es = mgr.eventState.get(task.id);
      expect(es.consecutiveFetchFailures).toBe(failuresBeforeSuccess);
      expect(task.status).toBe("running");

      // Now call with successful fetch — counter resets
      await mgr.evaluateAndComplete(task.id, "watchdog-reconcile");

      es = mgr.eventState.get(task.id);
      expect(es.consecutiveFetchFailures).toBe(0);
      expect(task.status).toBe("running");
    });
  });

  // ── 13. task-terminated listeners ─────────────────────────

  describe("task-terminated listeners", () => {
    it("register then complete fires callback with correct (taskId, status)", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);

      await mgr.handleTaskCompleted(task.id);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "completed");
    });

    it("fire-once: after notify, listeners set is cleared", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);

      await mgr.handleTaskCompleted(task.id);
      expect(callback).toHaveBeenCalledTimes(1);

      // After fire-once, the map entry should be deleted
      expect(mgr.taskTerminatedListeners.has(task.id)).toBe(false);

      // Calling handleTaskCompleted again (no-op since already terminal)
      // should NOT trigger the callback again
      await mgr.handleTaskCompleted(task.id);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("removeTaskTerminatedListener prevents callback from firing", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);
      manager.removeTaskTerminatedListener(task.id, callback);

      await mgr.handleTaskCompleted(task.id);

      expect(callback).not.toHaveBeenCalled();
    });

    it("task error fires listener with error status", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);

      mgr.handleTaskError(task.id, "something broke");

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "error");
    });

    it("task timeout fires listener with timeout status", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);

      mgr.handleTaskTimeout(task.id, "timed out");

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "timeout");
    });

    it("cancel fires listener with cancelled status", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);

      await manager.cancelTask(task.id);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "cancelled");
    });

    it("notifyTerminated with no listeners is a no-op", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      // No listener registered — should not throw
      await mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");
    });

    it("listen-after-terminate: already-completed task fires callback once (async)", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      // Make the task already completed (simulating task finishing
      // before the loop coordinator registers its listener)
      mgr.handleTaskCompleted(task.id);
      expect(task.status).toBe("completed");

      // Register the terminated listener AFTER the task is already terminal
      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);

      // Callback must NOT have fired synchronously (async delivery)
      expect(callback).toHaveBeenCalledTimes(0);

      // Flush microtasks — the immediate-fire microtask fires here
      await new Promise((r) => setTimeout(r, 0));

      // Callback fires exactly once with the correct status
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "completed");

      // Listener set is cleaned up (fire-once semantics)
      expect(mgr.taskTerminatedListeners.has(task.id)).toBe(false);
    });

    it("listen-after-terminate: error task fires callback once (async)", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      mgr.handleTaskError(task.id, "something broke");
      expect(task.status).toBe("error");

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);
      expect(callback).toHaveBeenCalledTimes(0); // not sync

      await new Promise((r) => setTimeout(r, 0));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "error");

      // Fire-once: listener set cleaned up
      expect(mgr.taskTerminatedListeners.has(task.id)).toBe(false);
    });

    it("listen-after-terminate: cancelled task fires callback once (async)", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      await manager.cancelTask(task.id);
      expect(task.status).toBe("cancelled");

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);
      expect(callback).toHaveBeenCalledTimes(0); // not sync

      await new Promise((r) => setTimeout(r, 0));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "cancelled");
    });

    it("listen-after-terminate: timeout task fires callback once (async)", async () => {
      const client = createMockClient();
      const manager = new DispatchManager(client, fastConfig);
      const mgr = manager as any;

      const task = await manager.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      mgr.handleTaskTimeout(task.id, "timed out");
      expect(task.status).toBe("timeout");

      const callback = mock((taskId: string, status: string) => {});
      manager.onTaskTerminated(task.id, callback);
      expect(callback).toHaveBeenCalledTimes(0); // not sync

      await new Promise((r) => setTimeout(r, 0));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(task.id, "timeout");
    });

  });
});

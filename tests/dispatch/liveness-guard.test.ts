/**
 * Liveness-guard tests for the completion evaluator's terminal-error paths.
 *
 * A `session.error` / `session.deleted` event (or a burst of SDK fetch
 * failures) can be transient while the underlying sub-agent session is still
 * alive and producing output. The completion evaluator must re-check session
 * liveness before committing a terminal `error` transition:
 *
 *   - When the session still verifies `exists`, the task stays `running` and
 *     the watchdog remains registered (no terminal notification, no
 *     monitoring unregistration).
 *   - When the session verifies `missing`, the genuine-failure path is
 *     preserved and the task transitions to `error`.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import { createMockClient, parentContext } from "./helpers";

describe("completion-evaluator liveness guard", () => {
  const fastConfig = {
    staleTimeoutMs: 500,
    taskTtlMs: 100,
  };

  afterEach(() => {
    mock.restore();
  });

  /** Launch a background task and pin it to a controlled session in running state. */
  async function launchPinnedRunningTask(client: ReturnType<typeof createMockClient>, sessionId: string) {
    const manager = new DispatchManager(client as never, fastConfig);
    const mgr = manager as any;

    const task = await manager.launch(
      { subagent: "h", prompt: "p", run_in_background: true, description: "liveness-guard" },
      parentContext(),
    );

    const taskRef = mgr.tasks.get(task.id);
    taskRef.sessionId = sessionId;
    taskRef.status = "running";
    mgr.sessionToTask.set(sessionId, task.id);
    mgr.watchdog.registerTask(task.id);

    return { manager, mgr, task };
  }

  it("transient session.error while session verifies 'exists' keeps the task running + watchdog registered", async () => {
    const client = createMockClient();
    const sessionId = "transient-error-session";

    // Session still exists AND is actively busy — a transient execution error.
    (client.status as any).mockImplementation(() => Promise.resolve({ type: "busy" }));
    (client.messages as any).mockImplementation(() =>
      Promise.resolve([
        { info: { role: "assistant", id: "m1" }, parts: [{ type: "text", text: "still working" }] },
      ]),
    );

    const { manager, mgr, task } = await launchPinnedRunningTask(client, sessionId);

    // Mock verifyExistence → "exists" (session still alive).
    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("exists" as const));

    // Emit a session.error event for the pinned session.
    await manager.handleSessionError(sessionId, new Error("transient provider hiccup"));

    // Task must NOT be latched into error — it stays running.
    expect(task.status).toBe("running");

    // Watchdog must still be registered (monitoring NOT unregistered).
    expect(mgr.watchdog.getRegisteredTaskIds()).toContain(task.id);

    // No terminal notification listeners were fired/cleared for the task.
    const listeners = mgr.taskTerminatedListeners.get(task.id);
    expect(listeners?.size ?? 0).toBe(0);

    // Cleanup
    mgr.watchdog.unregisterTask(task.id);
  });

  it("genuine session.error while session verifies 'missing' still errors the task (genuine-failure path preserved)", async () => {
    const client = createMockClient();
    const sessionId = "genuine-error-session";

    const { manager, mgr, task } = await launchPinnedRunningTask(client, sessionId);

    // Session is genuinely gone — verifyExistence → "missing".
    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("missing" as const));

    await manager.handleSessionError(sessionId, new Error("fatal"));

    expect(task.status).toBe("error");
    expect(task.error).toContain("fatal");
    // Watchdog is unregistered for a terminal error.
    expect(mgr.watchdog.getRegisteredTaskIds()).not.toContain(task.id);

    // Cleanup
    mgr.watchdog.unregisterTask(task.id);
  });

  it("transient session.deleted while session verifies 'exists' keeps the task running + watchdog registered", async () => {
    const client = createMockClient();
    const sessionId = "transient-deleted-session";

    // Session still exists and is idle — the delete event was spurious.
    (client.status as any).mockImplementation(() => Promise.resolve({ type: "idle" }));
    (client.messages as any).mockImplementation(() =>
      Promise.resolve([
        { info: { role: "assistant", id: "m1" }, parts: [{ type: "text", text: "output" }] },
      ]),
    );

    const { manager, mgr, task } = await launchPinnedRunningTask(client, sessionId);

    mgr.sessionMonitor.verifyExistence = mock(() => Promise.resolve("exists" as const));

    await manager.handleSessionDeleted(sessionId);

    expect(task.status).toBe("running");
    expect(mgr.watchdog.getRegisteredTaskIds()).toContain(task.id);

    // Cleanup
    mgr.watchdog.unregisterTask(task.id);
  });
});

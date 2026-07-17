import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { handleSessionIdle, evaluateAndComplete } from "../../src/dispatch/completion/completion-evaluator";
import { TaskWatchdogManager } from "../../src/dispatch/core/watchdog";
import type { TaskLifecycleDeps } from "../../src/dispatch/core/lifecycle-shared";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import type { DispatchTask, TaskEventState } from "../../src/dispatch/types";
import {
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
  BACKGROUND_STALE_TIMEOUT_MS,
} from "../../src/dispatch/config";

// ── Factory helpers ──────────────────────────────────────────────────────────

function createTask(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "task-default",
    sessionId: "ses-default",
    parentSessionId: "ses-parent",
    depth: 0,
    status: "running",
    agent: "test-agent",
    prompt: "test prompt",
    startedAt: new Date(0), // long ago — bypass minRuntimeMs check
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    ...overrides,
  };
}

function createEventState(overrides: Partial<TaskEventState> = {}): TaskEventState {
  return {
    lastMessageCount: 0,
    lastProgressUpdate: Date.now(),
    hasProducedOutput: false,
    messageCountAtStart: 0,
    lastEventAt: Date.now(),
    consecutiveFetchFailures: 0,
    ...overrides,
  };
}

// Simulated session message with assistant text output.
const ASSISTANT_MESSAGE = {
  info: { role: "assistant", id: "msg-1" },
  parts: [{ type: "text", text: "Here is my response with content." }],
};

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Fixture {
  deps: TaskLifecycleDeps;
  watchdog: TaskWatchdogManager;
  sessionId: string;
  taskId: string;
}

/**
 * Create a test fixture for handleSessionIdle tests.
 *
 * @param inflightCount  Number of child tasks with parentSessionId === sessionId and status="running"
 */
function createFixture(inflightCount: number = 0): Fixture {
  const sessionId = "ses-inflight-test";
  const taskId = "task-inflight-test";

  const watchdog = new TaskWatchdogManager(
    {
      onReconcile: () => {},
      onSweep: () => {},
      onDebounceElapsed: () => {},
    },
    {
      watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
      globalSweepIntervalMs: GLOBAL_SWEEP_INTERVAL_MS,
      idleDebounceMs: IDLE_DEBOUNCE_MS,
    },
  );

  // ── Tasks map ──────────────────────────────────────────────────────────
  const tasks = new Map<string, DispatchTask>();

  // The main task — its session is the one that fires session.idle
  tasks.set(
    taskId,
    createTask({
      id: taskId,
      sessionId,
      startedAt: new Date(0),
    }),
  );

  // Inflight child tasks: their parentSessionId matches sessionId,
  // which is what getInflightCount(d, sessionId) checks.
  for (let i = 0; i < inflightCount; i++) {
    const childId = `child-task-${i}`;
    tasks.set(
      childId,
      createTask({
        id: childId,
        sessionId: `child-ses-${i}`,
        parentSessionId: sessionId, // <— this is what getInflightCount counts
        status: "running",
      }),
    );
  }

  // ── Lookup maps ────────────────────────────────────────────────────────
  const sessionToTask = new Map<string, string>();
  sessionToTask.set(sessionId, taskId);

  const eventState = new Map<string, TaskEventState>();
  eventState.set(taskId, createEventState());

  const deferredIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Client ─────────────────────────────────────────────────────────────
  const client = {
    messages: mock((_id: string, _options?: unknown) =>
      Promise.resolve([ASSISTANT_MESSAGE]),
    ),
  } as unknown as ISessionClient;

  // ── Config: minRuntimeMs=0 so the early-return gate is always bypassed ─
  const config = {
    minRuntimeMs: 0,
    materializeTimeoutMs: 10000,
  } as TaskLifecycleDeps["config"];

  // Register the task so watchdog methods (isDebouncing, startDebounce) work
  watchdog.registerTask(taskId);

  // Maps for O(1) inflight counters (must match tasks)
  const inflightByParent = new Map<string, number>();
  const oldestStartedAtByParent = new Map<string, number>();
  if (inflightCount > 0) {
    inflightByParent.set(sessionId, inflightCount);
    let oldestMs = Infinity;
    for (const [, t] of tasks) {
      if (t.parentSessionId === sessionId && (t.status === "running" || t.status === "pending")) {
        oldestMs = Math.min(oldestMs, t.startedAt.getTime());
      }
    }
    if (oldestMs < Infinity) oldestStartedAtByParent.set(sessionId, oldestMs);
  }

  const deps = {
    sessionToTask,
    tasks,
    eventState,
    watchdog,
    client,
    config,
    deferredIdleTimers,
    inflightByParent,
    oldestStartedAtByParent,
  } as unknown as TaskLifecycleDeps;

  return { deps, watchdog, sessionId, taskId };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("inflight dispatch guard in handleSessionIdle", () => {
  afterEach(() => {
    mock.restore();
  });

  // ── Scenario (a) ──────────────────────────────────────────────────────

  it("skips debounce when getInflightCount > 0", async () => {
    const { deps, watchdog, sessionId } = createFixture(2);

    const startDebounceSpy = spyOn(watchdog, "startDebounce");

    await handleSessionIdle(deps, sessionId);

    // Debounce should NOT be started when there are inflight children
    expect(startDebounceSpy).not.toHaveBeenCalled();
  });

  it("skips debounce when inflight is 0 but guard check passes (sanity — no inflight, no skip)", async () => {
    // This is more of a sanity check: with 0 inflight, the guard should
    // NOT block debounce from starting.
    const { deps, watchdog, sessionId } = createFixture(0);

    const startDebounceSpy = spyOn(watchdog, "startDebounce");

    await handleSessionIdle(deps, sessionId);

    expect(startDebounceSpy).toHaveBeenCalledTimes(1);
    expect(startDebounceSpy).toHaveBeenCalledWith("task-inflight-test");
  });

  // ── Scenario (b) ──────────────────────────────────────────────────────

  it("proceeds normally when inflight = 0", async () => {
    const { deps, watchdog, sessionId } = createFixture(0);

    const startDebounceSpy = spyOn(watchdog, "startDebounce");

    await handleSessionIdle(deps, sessionId);

    // When no inflight children, debounce should start
    expect(startDebounceSpy).toHaveBeenCalledTimes(1);
    expect(startDebounceSpy).toHaveBeenCalledWith("task-inflight-test");
  });

  it("cancels debounce skip when inflight drops to 0 (sanity cross-check)", async () => {
    // Verify that with the same fixture but inflight = 1, debounce IS skipped
    const { deps, watchdog, sessionId, taskId } = createFixture(1);

    // Register the watchdog test hook so we can verify the task is registered
    expect(watchdog.getRegisteredTaskIds()).toContain(taskId);

    const startDebounceSpy = spyOn(watchdog, "startDebounce");

    await handleSessionIdle(deps, sessionId);

    // Should skip debounce — inflight = 1
    expect(startDebounceSpy).not.toHaveBeenCalled();
  });

  // ── Scenario (c) ──────────────────────────────────────────────────────

  it("eventually starts debounce when inflight drops to 0 on subsequent idle", async () => {
    // Phase 1: inflight = 2 → debounce should be skipped
    const { deps, watchdog, sessionId } = createFixture(2);
    const startDebounceSpy = spyOn(watchdog, "startDebounce");

    await handleSessionIdle(deps, sessionId);

    // First call with inflight > 0 should NOT start debounce
    expect(startDebounceSpy).not.toHaveBeenCalled();

    // Phase 2: simulate subagent tasks completing — change their status to "completed"
    // Also update the O(1) inflight map to match (in production, transition() does this).
    const child1 = deps.tasks.get("child-task-0")!;
    child1.status = "completed";
    const child2 = deps.tasks.get("child-task-1")!;
    child2.status = "completed";
    deps.inflightByParent!.delete(sessionId);
    deps.oldestStartedAtByParent!.delete(sessionId);

    // Second call with inflight = 0 SHOULD start debounce
    await handleSessionIdle(deps, sessionId);

    expect(startDebounceSpy).toHaveBeenCalledTimes(1);
    expect(startDebounceSpy).toHaveBeenCalledWith("task-inflight-test");
  });

  // ── Edge case: unknown session ───────────────────────────────────────────

  it("is no-op for unknown session", async () => {
    const { deps, watchdog } = createFixture(0);

    const startDebounceSpy = spyOn(watchdog, "startDebounce");

    // Call with a session that has no mapping
    await handleSessionIdle(deps, "ses-nonexistent");

    expect(startDebounceSpy).not.toHaveBeenCalled();
  });
});

// ── Stale-timeout safety tests for evaluateAndComplete ─────────────────────

describe("stale-timeout safety in evaluateAndComplete", () => {
  const BASE_TIME = 1_000_000_000;
  const STALE_MS = 100;

  afterEach(() => {
    mock.restore();
  });

  interface EvalFixture {
    deps: TaskLifecycleDeps;
    watchdog: TaskWatchdogManager;
    sessionId: string;
    taskId: string;
  }

  /**
   * Create fixture for evaluateAndComplete tests.
   * client.status returns "busy" so detectCompletion returns not_ready.
   *
   * @param inflightCount      Number of child tasks (parentSessionId === sessionId)
   * @param childStartOffset   Offset from BASE_TIME for child startedAt
   * @param progressOffset     Offset from BASE_TIME for lastProgressUpdate
   */
  function createEvalFixture(
    inflightCount: number = 0,
    childStartOffset: number = -10,
    progressOffset: number = -10,
  ): EvalFixture {
    const sessionId = "ses-eval-stale";
    const taskId = "task-eval-stale";

    const watchdog = new TaskWatchdogManager(
      { onReconcile: () => {}, onSweep: () => {}, onDebounceElapsed: () => {} },
      {
        watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
        globalSweepIntervalMs: GLOBAL_SWEEP_INTERVAL_MS,
        idleDebounceMs: IDLE_DEBOUNCE_MS,
      },
    );

    const tasks = new Map<string, DispatchTask>();

    // Main task started at BASE_TIME
    tasks.set(taskId, createTask({ id: taskId, sessionId, startedAt: new Date(BASE_TIME) }));

    // Inflight child tasks
    for (let i = 0; i < inflightCount; i++) {
      const childId = `eval-child-${i}`;
      tasks.set(
        childId,
        createTask({
          id: childId,
          sessionId: `child-ses-${i}`,
          parentSessionId: sessionId,
          status: "running",
          startedAt: new Date(BASE_TIME + childStartOffset),
        }),
      );
    }

    const sessionToTask = new Map<string, string>();
    sessionToTask.set(sessionId, taskId);

    const eventState = new Map<string, TaskEventState>();
    eventState.set(
      taskId,
      createEventState({
        hasProducedOutput: true,
        lastProgressUpdate: BASE_TIME + progressOffset,
        lastEventAt: BASE_TIME,
      }),
    );

    const deferredIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Client returns "busy" -> detectCompletion returns { type: "not_ready" }
    const client = {
      messages: mock(() => Promise.resolve([])),
      status: mock(() => Promise.resolve({ type: "busy" })),
    } as unknown as ISessionClient;

    const config = {
      minRuntimeMs: 0,
      materializeTimeoutMs: 10000,
      backgroundStaleTimeoutMs: STALE_MS,
    } as TaskLifecycleDeps["config"];

    watchdog.registerTask(taskId);

    // Maps for O(1) inflight counters (must match tasks)
    const inflightByParent = new Map<string, number>();
    const oldestStartedAtByParent = new Map<string, number>();
    if (inflightCount > 0) {
      inflightByParent.set(sessionId, inflightCount);
      let oldestMs = Infinity;
      for (const [, t] of tasks) {
        if (t.parentSessionId === sessionId && (t.status === "running" || t.status === "pending")) {
          oldestMs = Math.min(oldestMs, t.startedAt.getTime());
        }
      }
      if (oldestMs < Infinity) oldestStartedAtByParent.set(sessionId, oldestMs);
    }

    const deps = {
      tasks,
      sessionToTask,
      eventState,
      watchdog,
      client,
      config,
      deferredIdleTimers,
      inflightByParent,
      oldestStartedAtByParent,
      // Supporting mocks for timeout path
      pendingNotifications: new Set<string>(),
      sendNotification: mock(() => Promise.resolve(true)),
      concurrency: { release: mock(() => {}) },
      persistState: mock(() => {}),
      cleanupTimers: new Map(),
      notifyOutbox: new Set<string>(),
      addToOutbox: mock(() => {}),
      cleanupTask: mock(() => {}),
      sessionMonitor: { verifyExistence: mock(() => Promise.resolve("exists" as const)) },
      progressStore: { addProgressEvent: mock(() => {}), clearProgress: mock(() => {}) },
      clearEmittedThresholds: mock(() => {}),
      deleteTaskCheckpoint: mock(() => Promise.resolve()),
      taskTerminatedListeners: new Map(),
      sidecarGCTimers: new Map(),
      cancelQueue: new Map(),
      syncControllers: new Map(),
      completedSyncSessions: new Map(),
      sessionsByRequest: new Map(),
      cleanedUpTasks: new Map(),
      subagentModelKey: new Map(),
      directory: "/tmp",
    } as unknown as TaskLifecycleDeps;

    return { deps, watchdog, sessionId, taskId };
  }

  // ── Test (a) ──────────────────────────────────────────────────────────

  it("(a) refreshes lastProgressUpdate when all inflight children are healthy", async () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(BASE_TIME);
    try {
      // 2 children, both started 10ms ago (<= 100ms staleMs), lastProgressUpdate recent
      const { deps, taskId } = createEvalFixture(2, -10, -10);

      await evaluateAndComplete(deps, taskId, "global-sweep");

      // Task stays running - inflight guard prevents timeout
      expect(deps.tasks.get(taskId)?.status).toBe("running");
      // lastProgressUpdate refreshed to BASE_TIME (= mocked Date.now())
      expect(deps.eventState.get(taskId)?.lastProgressUpdate).toBe(BASE_TIME);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // ── Test (b) ──────────────────────────────────────────────────────────

  it("(b) times out parent when stale children cannot prevent natural staleness", async () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(BASE_TIME);
    try {
      // 1 child started 200ms ago (> 100ms staleMs) - stale
      // lastProgressUpdate is 200ms ago - triggers "Task stalled" before inflight guard
      const { deps, taskId } = createEvalFixture(1, -200, -200);

      await evaluateAndComplete(deps, taskId, "global-sweep");

      // "Task stalled" fires first - stale children don't block parent timeout
      expect(deps.tasks.get(taskId)?.status).toBe("timeout");
      expect(deps.tasks.get(taskId)?.error).toContain("Task stalled");
    } finally {
      nowSpy.mockRestore();
    }
  });

  // ── Test (c) ──────────────────────────────────────────────────────────

  it("(c) preserves existing timeout behavior when inflight = 0 (no regression)", async () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(BASE_TIME);
    try {
      // No inflight children, lastProgressUpdate is 200ms ago (> staleMs)
      const { deps, taskId } = createEvalFixture(0, 0, -200);

      await evaluateAndComplete(deps, taskId, "global-sweep");

      // Normal "Task stalled" timeout fires
      expect(deps.tasks.get(taskId)?.status).toBe("timeout");
      expect(deps.tasks.get(taskId)?.error).toContain("Task stalled");
    } finally {
      nowSpy.mockRestore();
    }
  });
});

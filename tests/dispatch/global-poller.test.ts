import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { GlobalPoller, type GlobalPollerDeps } from "../../src/dispatch/global-poller";
import { SessionMonitor } from "../../src/dispatch/session-monitor";
import type { SessionMessageSnapshot, TaskPollState } from "../../src/dispatch/types";
import { MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, DEFAULT_MAX_CONCURRENT } from "../../src/dispatch/config";

const TASK_A = "task-a";
const TASK_B = "task-b";
const SESSION_A = "session-a";
const SESSION_B = "session-b";

function noop(): void {}

function idleMsg(): SessionMessageSnapshot {
  return { info: { role: "assistant", id: "m1", finish: "end_turn" }, parts: [] };
}

function pollState(overrides?: Partial<TaskPollState>): TaskPollState {
  return {
    consecutiveMissedPolls: 0, stableIdlePolls: 0, lastMessageCount: 0,
    lastProgressUpdate: Date.now(), hasProducedOutput: false, ...overrides,
  };
}

function sdkResult<T>(data: T) {
  return Promise.resolve({ data, error: undefined });
}

function sdkError() {
  return Promise.resolve({ data: undefined, error: { status: 500, message: "fail" } });
}

interface Mocks {
  statusFn: ReturnType<typeof mock>;
  messagesFn: ReturnType<typeof mock>;
  getFn: ReturnType<typeof mock>;
  completionDetector: ReturnType<typeof mock>;
  onCompleted: ReturnType<typeof mock>;
  onError: ReturnType<typeof mock>;
  onTimeout: ReturnType<typeof mock>;
  client: OpencodeClient;
  sessionMonitor: SessionMonitor;
  capturedTimeoutMs: number;
  setTimeoutCalled: boolean;
  setIntervalCalled: boolean;
  origSetTimeout: typeof globalThis.setTimeout;
  origSetInterval: typeof globalThis.setInterval;
}

function setupMocks(): Mocks {
  const statusFn = mock((_opts?: unknown) => sdkResult({}));
  const messagesFn = mock((_opts?: unknown) => sdkResult([idleMsg()]));
  const getFn = mock((_opts?: unknown) => sdkResult({ id: "s", title: "t" }));
  const completionDetector = mock(() => ({ type: "not_ready" as const }));
  const onCompleted = mock(noop);
  const onError = mock(noop);
  const onTimeout = mock(noop);

  const client = {
    session: {
      status: statusFn,
      messages: messagesFn,
      get: getFn,
    },
  } as unknown as OpencodeClient;

  const sessionMonitor = new SessionMonitor();
  let capturedTimeoutMs = 0;
  let setTimeoutCalled = false;
  let setIntervalCalled = false;
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    capturedTimeoutMs = ms ?? 0;
    setTimeoutCalled = true;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.setInterval = (() => {
    setIntervalCalled = true;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  return {
    statusFn, messagesFn, getFn, completionDetector, onCompleted, onError, onTimeout,
    client, sessionMonitor, capturedTimeoutMs, setTimeoutCalled, setIntervalCalled,
    origSetTimeout, origSetInterval,
    get capturedTimeoutValue() { return capturedTimeoutMs; },
    get setTimeoutWasCalled() { return setTimeoutCalled; },
    get setIntervalWasCalled() { return setIntervalCalled; },
  };
}

function restoreTimers(m: Mocks): void {
  globalThis.setTimeout = m.origSetTimeout;
  globalThis.setInterval = m.origSetInterval;
}

function makePoller(m: Mocks, configOverrides?: Partial<{ maxConcurrent: number }>) {
  return new GlobalPoller(m.client, {
    pollIntervalMs: 3000, staleTimeoutMs: 2700000, minRuntimeMs: 5000,
    maxConcurrent: configOverrides?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    taskTtlMs: 1800000,
  }, {
    completionDetector: m.completionDetector as unknown as typeof import("../../src/dispatch/completion-detector").detectCompletion,
    sessionMonitor: m.sessionMonitor,
    onTaskCompleted: m.onCompleted,
    onTaskError: m.onError,
    onTaskTimeout: m.onTimeout,
  });
}

async function runCycle(poller: GlobalPoller): Promise<void> {
  await (poller as unknown as { _pollCycle(): Promise<void> })._pollCycle();
}

// ───────────────────────────────────────────────────────────────────────

describe("GlobalPoller", () => {
  let m: Mocks;

  beforeEach(() => {
    m = setupMocks();
  });

  afterEach(() => {
    restoreTimers(m);
  });

  describe("lifecycle", () => {
    it("1. auto-starts on first registerTask", () => {
      const p = makePoller(m);
      expect(p.isRunning()).toBe(false);
      p.registerTask(TASK_A, SESSION_A);
      expect(p.isRunning()).toBe(true);
    });

    it("2. auto-stops on last unregisterTask", () => {
      const p = makePoller(m);
      p.registerTask(TASK_A, SESSION_A);
      expect(p.isRunning()).toBe(true);
      p.unregisterTask(TASK_A);
      expect(p.isRunning()).toBe(false);
    });

    it("3. does not stop when other tasks remain after unregister", () => {
      const p = makePoller(m);
      p.registerTask(TASK_A, SESSION_A);
      p.registerTask(TASK_B, SESSION_B);
      p.unregisterTask(TASK_A);
      expect(p.isRunning()).toBe(true);
      expect(p.getTaskCount()).toBe(1);
    });
  });

  describe("single status() call", () => {
    it("4. single status() call for 5 tasks", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "busy" },
      }));
      for (let i = 0; i < 5; i++) {
        p.registerTask(`task-${i}`, `session-${i}`);
      }
      await runCycle(p);
      expect(m.statusFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("session gone", () => {
    it("5. gone then missing → onTaskError called", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({}));
      p.registerTask(TASK_A, SESSION_A);

      // Simulate 3+ missed polls to reach "gone" threshold
      for (let i = 0; i < 3; i++) {
        await runCycle(p);
      }

      m.getFn.mockImplementation(() => Promise.resolve({
        data: undefined, error: { status: 404, message: "Not found" },
      }));
      await runCycle(p);

      expect(m.onError).toHaveBeenCalledWith(TASK_A, "Session disappeared");
      expect(p.getTaskCount()).toBe(0);
    });
  });

  describe("busy session", () => {
    it("6. busy session resets stability and does not trigger callbacks", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "busy" },
      }));
      p.registerTask(TASK_A, SESSION_A);
      await runCycle(p);

      expect(m.onCompleted).toHaveBeenCalledTimes(0);
      expect(m.onError).toHaveBeenCalledTimes(0);
      expect(m.onTimeout).toHaveBeenCalledTimes(0);
      expect(m.completionDetector).toHaveBeenCalledTimes(0);
    });
  });

  describe("stability detection", () => {
    it("7. completes after MIN_STABILITY_POLLS stabilizing signals", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "stabilizing" as const }));
      p.registerTask(TASK_A, SESSION_A);

      // Stability cycles: "stabilizing" increments stableIdlePolls each time
      // After 3 stabilizing cycles → completed
      for (let i = 0; i < 3; i++) {
        await runCycle(p);
      }

      expect(m.onCompleted).toHaveBeenCalledWith(TASK_A);
      expect(p.getTaskCount()).toBe(0);
    });
  });

  describe("adaptive interval", () => {
    it("8. high load → MIN_POLL_INTERVAL_MS (500ms)", async () => {
      const p = makePoller(m, { maxConcurrent: 5 });
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "busy" },
      }));
      for (let i = 0; i < 5; i++) {
        p.registerTask(`task-${i}`, `session-${i}`);
      }
      await runCycle(p);
      expect(m.capturedTimeoutValue).toBe(MIN_POLL_INTERVAL_MS);
    });

    it("9. low load → MAX_POLL_INTERVAL_MS (5000ms)", async () => {
      const p = makePoller(m, { maxConcurrent: 5 });
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "busy" },
      }));
      p.registerTask(TASK_A, SESSION_A);
      await runCycle(p);
      expect(m.capturedTimeoutValue).toBe(MAX_POLL_INTERVAL_MS);
    });

    it("9b. maxConcurrent=0 does not produce NaN", async () => {
      const p = makePoller(m, { maxConcurrent: 0 });
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "busy" },
      }));
      p.registerTask(TASK_A, SESSION_A);
      await runCycle(p);
      const interval = (p as any)._intervalMs;
      expect(Number.isFinite(interval)).toBe(true);
      expect(interval).toBeGreaterThanOrEqual(MIN_POLL_INTERVAL_MS);
      expect(interval).toBeLessThanOrEqual(MAX_POLL_INTERVAL_MS);
    });
  });

  describe("error from completion detector", () => {
    it("10. error signal → onTaskError called", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({
        type: "error" as const, message: "detector failure",
      }));
      p.registerTask(TASK_A, SESSION_A);
      await runCycle(p);

      expect(m.onError).toHaveBeenCalledWith(TASK_A, "detector failure");
      expect(p.getTaskCount()).toBe(0);
    });
  });

  describe("setTimeout not setInterval", () => {
    it("11. uses setTimeout, never setInterval", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "busy" },
      }));
      p.registerTask(TASK_A, SESSION_A);
      await runCycle(p);

      expect(m.setTimeoutWasCalled).toBe(true);
      expect(m.setIntervalCalled).toBe(false);
    });
  });

  describe("message fetch caching", () => {
    it("12. skips message fetch when status key unchanged", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "stabilizing" as const }));
      p.registerTask(TASK_A, SESSION_A);

      await runCycle(p);
      expect(m.messagesFn).toHaveBeenCalledTimes(1);

      await runCycle(p);
      // Status key unchanged → should skip fetch
      expect(m.messagesFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("timeout: never produced output", () => {
    it("13. onTaskTimeout when never produced output", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "not_ready" as const }));
      p.registerTask(TASK_A, SESSION_A);

      // Force the registeredAt timestamp far in the past
      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      task.registeredAt = Date.now() - 4_000_000; // 4M ms > MESSAGE_STALENESS_TIMEOUT_MS (3.6M ms)
      task.pollState.hasProducedOutput = false;

      await runCycle(p);

      expect(m.onTimeout).toHaveBeenCalledWith(TASK_A, "Never produced output");
      expect(p.getTaskCount()).toBe(0);
    });
  });

  describe("multiple tasks with different statuses", () => {
    it("14. only completing task triggers callback, busy task unaffected", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
        [SESSION_B]: { type: "busy" },
      }));
      // Task A: idle → will go through detection
      // Task B: busy → just progress update
      p.registerTask(TASK_A, SESSION_A);
      p.registerTask(TASK_B, SESSION_B);

      // Task A: three cycles of stabilizing → completes
      m.completionDetector.mockImplementation(
        (_msgs: unknown, status: unknown, _ps: unknown) => {
          // B is busy, won't reach detector
          return { type: "stabilizing" as const };
        });

      await runCycle(p); // stableIdlePolls=1
      await runCycle(p); // stableIdlePolls=2
      await runCycle(p); // stableIdlePolls=3 → completed

      expect(m.onCompleted).toHaveBeenCalledWith(TASK_A);
      expect(m.onCompleted).toHaveBeenCalledTimes(1);
      // Task B should still be registered
      expect(p.getTaskCount()).toBe(1);
    });
  });

  describe("auto-stop when all tasks complete", () => {
    it("15. poller stops after last task completion", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "completed" as const }));

      p.registerTask(TASK_A, SESSION_A);
      expect(p.isRunning()).toBe(true);

      await runCycle(p);

      expect(m.onCompleted).toHaveBeenCalledWith(TASK_A);
      expect(p.isRunning()).toBe(false);
      expect(p.getTaskCount()).toBe(0);
    });
  });

  describe("registerTask idempotency", () => {
    it("16. registering same taskId twice does not duplicate", () => {
      const p = makePoller(m);
      p.registerTask(TASK_A, SESSION_A);
      p.registerTask(TASK_A, "different-session");
      expect(p.getTaskCount()).toBe(1);
    });
  });

  describe("messages fetch failure (Bug #6)", () => {
    it("17. updates lastProgressUpdate on messages fetch error to prevent false timeout", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      // First cycle: fetch succeeds to set up prevStatusKey
      p.registerTask(TASK_A, SESSION_A);
      m.messagesFn.mockImplementation(() => sdkResult([idleMsg()]));
      await runCycle(p);

      // Second cycle: mock messages to fail (force needsFetch via "uncertain" status)
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "uncertain" },
      }));
      m.messagesFn.mockImplementation(() => sdkError());

      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      const staleTimeoutMs = 2700000;
      task.pollState.lastProgressUpdate = Date.now() - staleTimeoutMs + 1000; // 1s from stale
      task.pollState.hasProducedOutput = true;

      await runCycle(p);

      // Should NOT have timed out — lastProgressUpdate was refreshed
      expect(m.onTimeout).toHaveBeenCalledTimes(0);
      // lastProgressUpdate should be updated close to now
      expect(task.pollState.lastProgressUpdate).toBeGreaterThan(Date.now() - 1000);
    });
  });

  describe("per-task timeout", () => {
    it("18. per-task timeout triggers on schedule — never produced output", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "not_ready" as const }));
      p.registerTask(TASK_A, SESSION_A, undefined, 500); // 500ms per-task timeout

      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState; timeoutMs?: number }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      task.registeredAt = Date.now() - 600; // 600ms ago > 500ms timeout
      task.pollState.hasProducedOutput = false;

      await runCycle(p);

      expect(m.onTimeout).toHaveBeenCalledWith(TASK_A, "Never produced output");
      expect(p.getTaskCount()).toBe(0);
    });

    it("19. background default timeout used when no per-task timeout set", async () => {
      // BACKGROUND_STALE_TIMEOUT_MS = 900_000 (15 min)
      // This test uses a very small timeout via config override to keep tests fast
      const p = new GlobalPoller(m.client, {
        pollIntervalMs: 3000, staleTimeoutMs: 2700000, minRuntimeMs: 5000,
        maxConcurrent: DEFAULT_MAX_CONCURRENT, taskTtlMs: 1800000,
        backgroundStaleTimeoutMs: 2000, // 2s for fast test
      }, {
        completionDetector: m.completionDetector as unknown as typeof import("../../src/dispatch/completion-detector").detectCompletion,
        sessionMonitor: m.sessionMonitor,
        onTaskCompleted: m.onCompleted,
        onTaskError: m.onError,
        onTaskTimeout: m.onTimeout,
      });
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "not_ready" as const }));
      p.registerTask(TASK_A, SESSION_A); // no per-task timeout

      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState; timeoutMs?: number }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      task.registeredAt = Date.now() - 3000; // 3s ago > 2s background default
      task.pollState.hasProducedOutput = false;

      await runCycle(p);

      expect(m.onTimeout).toHaveBeenCalledWith(TASK_A, "Never produced output");
      expect(p.getTaskCount()).toBe(0);
    });

    it("20. per-task timeout overrides background default", async () => {
      const p = new GlobalPoller(m.client, {
        pollIntervalMs: 3000, staleTimeoutMs: 2700000, minRuntimeMs: 5000,
        maxConcurrent: DEFAULT_MAX_CONCURRENT, taskTtlMs: 1800000,
        backgroundStaleTimeoutMs: 2000, // 2s background default
      }, {
        completionDetector: m.completionDetector as unknown as typeof import("../../src/dispatch/completion-detector").detectCompletion,
        sessionMonitor: m.sessionMonitor,
        onTaskCompleted: m.onCompleted,
        onTaskError: m.onError,
        onTaskTimeout: m.onTimeout,
      });
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "not_ready" as const }));
      p.registerTask(TASK_A, SESSION_A, undefined, 500); // per-task 500ms overrides 2s

      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState; timeoutMs?: number }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      task.registeredAt = Date.now() - 600; // 600ms > 500ms per-task, < 2s background
      task.pollState.hasProducedOutput = false;

      await runCycle(p);

      expect(m.onTimeout).toHaveBeenCalledWith(TASK_A, "Never produced output");
      expect(p.getTaskCount()).toBe(0);
    });

    it("21. per-task timeout applies to stalled tasks too", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "not_ready" as const }));
      p.registerTask(TASK_A, SESSION_A, undefined, 500); // 500ms per-task timeout

      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState; timeoutMs?: number }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      task.pollState.hasProducedOutput = true;
      task.pollState.lastProgressUpdate = Date.now() - 600; // stalled 600ms > 500ms limit

      await runCycle(p);

      expect(m.onTimeout).toHaveBeenCalledWith(TASK_A, "Task stalled");
      expect(p.getTaskCount()).toBe(0);
    });

    it("22. task with timeout > elapsed does NOT timeout", async () => {
      const p = makePoller(m);
      m.statusFn.mockImplementation(() => sdkResult({
        [SESSION_A]: { type: "idle" },
      }));
      m.completionDetector.mockImplementation(() => ({ type: "not_ready" as const }));
      p.registerTask(TASK_A, SESSION_A, undefined, 5000); // 5s timeout

      const taskMap = (p as unknown as { tasks: Map<string, { registeredAt: number; pollState: TaskPollState; timeoutMs?: number }> }).tasks;
      const task = taskMap.get(TASK_A)!;
      task.registeredAt = Date.now() - 1000; // only 1s elapsed < 5s timeout
      task.pollState.hasProducedOutput = false;

      await runCycle(p);

      expect(m.onTimeout).toHaveBeenCalledTimes(0);
      expect(p.getTaskCount()).toBe(1);
    });
  });
});

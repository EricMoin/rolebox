import { describe, it, expect, mock, afterEach } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";

// ── Race Simulator Adapter ─────────────────────────────────────────────────
//
// This adapter's registerTerminatedListener fires the callback synchronously
// for the second worker (task-2), simulating the race condition where
// onTaskTerminated fires an immediate-fire notification during the _advancing
// critical section of round 1's onWorkerCompleted.

function createRaceSimAdapter(): {
  adapter: IDispatchAdapter;
  calls: string[];
} {
  const calls: string[] = [];
  let taskCounter = 0;

  const adapter: IDispatchAdapter = {
    dispatchRound: mock(
      async () => {
        taskCounter += 1;
        const taskId = `task-${taskCounter}`;
        calls.push(`dispatchRound:${taskId}`);
        return {
          workerTaskId: taskId,
          workerSessionId: `session-${taskCounter}`,
        };
      },
    ),

    getRoundResult: mock(
      async (_taskId: string) => {
        calls.push(`getRoundResult:${_taskId}`);
        return { text: "ok", hadError: false };
      },
    ),

    cancelRound: mock(async () => {
      calls.push("cancelRound");
    }),

    readOriginSummary: mock(
      async () => {
        calls.push("readOriginSummary");
        return "Round summary for tests.";
      },
    ),

    getLastMessageId: mock(
      async () => {
        calls.push("getLastMessageId");
        return "msg-boundary";
      },
    ),

    injectNote: mock(
      async () => {
        calls.push("injectNote");
      },
    ),

    registerTerminatedListener: mock(
      (
        _taskId: string,
        callback: (taskId: string, status: string) => void,
      ) => {
        calls.push(`registerTerminatedListener:${_taskId}`);
        // Fire synchronously for worker 2 to simulate the race:
        // onTaskTerminated fires immediately during _registerWorkerListener,
        // which runs INSIDE the _advancing section of worker 1's completion.
        if (_taskId === "task-2") {
          callback(_taskId, "completed");
        }
        return callback;
      },
    ),

    removeTerminatedListener: mock(
      () => {
        calls.push("removeTerminatedListener");
      },
    ),

    getTaskStatus: mock(
      async () => {
        return "completed";
      },
    ),
  };

  return { adapter, calls };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("push-chain race condition", () => {
  afterEach(() => {
    mock.restore();
  });

  it("round-2 completion that arrives during round-1 _advancing section is still processed", async () => {
    const { adapter, calls } = createRaceSimAdapter();
    const coordinator = new LoopCoordinator(adapter);

    // Register a loop with 3 iterations
    coordinator.register({
      originSessionId: "race-origin",
      agent: "test-agent",
      prompt: "do work",
      mode: "inherit",
      iterations: 3,
    });

    // Self-start microtask dispatches round 1
    await new Promise((r) => setTimeout(r, 0));

    const state1 = coordinator.getLoopState("race-origin")!;
    expect(state1.phase).toBe("awaiting_worker");
    expect(state1.activeWorkerTaskId).toBe("task-1");

    // Call onWorkerCompleted("task-1") — this enters the _advancing
    // critical section, dispatches round 2, then calls
    // _registerWorkerListener for worker 2. Our mock fires the
    // terminated listener SYNCHRONOUSLY for worker 2, which calls
    // onWorkerCompleted("task-2") while _advancing is still held.
    await coordinator.onWorkerCompleted("task-1");

    // Drain microtasks to let any deferred completion be processed
    await new Promise((r) => setTimeout(r, 0));

    const state2 = coordinator.getLoopState("race-origin")!;

    // KEY ASSERTION: The loop should have advanced through round 2.
    //
    // Pre-fix behavior: The _advancing guard silently drops worker 2's
    // completion. The loop stays at round 2, phase "awaiting_worker",
    // with activeWorkerTaskId = "task-2", and never advances.
    // Assertion fails because current <= 2 or phase != "awaiting_worker"
    // with the wrong task ID.
    //
    // Post-fix behavior: The deferred completion queue catches worker 2's
    // completion and drains it after _advancing clears. The loop advances
    // to round 3 (phase "awaiting_worker", activeWorkerTaskId = "task-3").
    expect(state2.current).toBeGreaterThanOrEqual(3);
    expect(state2.phase).toBe("awaiting_worker");
    expect(state2.activeWorkerTaskId).toBe("task-3");

    // Verify 3 dispatch rounds happened (rounds 1, 2, 3)
    const dispatchCalls = calls.filter((c) => c.startsWith("dispatchRound"));
    expect(dispatchCalls.length).toBe(3);
    expect(dispatchCalls).toEqual([
      "dispatchRound:task-1",
      "dispatchRound:task-2",
      "dispatchRound:task-3",
    ]);

    // Verify 3 getRoundResult calls (results for rounds 1 and 2)
    const resultCalls = calls.filter((c) =>
      c.startsWith("getRoundResult"),
    );
    expect(resultCalls.length).toBe(2);
    expect(resultCalls).toEqual([
      "getRoundResult:task-1",
      "getRoundResult:task-2",
    ]);

    // Verify registerTerminatedListener was called for all dispatched workers.
    // worker 1 (from _kickoffFromActivating), worker 2 (from worker 1's
    // _advanceFromSummarizing), and worker 3 (from the deferred completion
    // which processes worker 2's completion and dispatches worker 3).
    const listenerCalls = calls.filter((c) =>
      c.startsWith("registerTerminatedListener"),
    );
    expect(listenerCalls.length).toBe(3);
    expect(listenerCalls).toEqual([
      "registerTerminatedListener:task-1",
      "registerTerminatedListener:task-2",
      "registerTerminatedListener:task-3",
    ]);
  });

  it("pre-existing existing tests still pass alongside race test", async () => {
    // This is a smoke test to ensure the basic push-chain still works
    // even with the deferred completion mechanism.
    const { adapter, calls } = createRaceSimAdapter();
    const coordinator = new LoopCoordinator(adapter);

    coordinator.register({
      originSessionId: "origin-1",
      agent: "test-agent",
      prompt: "do work",
      mode: "inherit",
      iterations: 3,
    });

    await new Promise((r) => setTimeout(r, 0));

    // Normal single-step progression (no race)
    await coordinator.onWorkerCompleted("task-1");
    await new Promise((r) => setTimeout(r, 0));

    const state1 = coordinator.getLoopState("origin-1")!;
    expect(state1.current).toBeGreaterThanOrEqual(2);

    // Complete round 2
    await coordinator.onWorkerCompleted("task-2");
    await new Promise((r) => setTimeout(r, 0));

    // Complete round 3
    await coordinator.onWorkerCompleted("task-3");
    await new Promise((r) => setTimeout(r, 0));

    const state2 = coordinator.getLoopState("origin-1")!;
    expect(state2.phase).toBe("complete");

    // If we got here, the push chain still works end-to-end
    expect(state2.current).toBe(4);
  });
});

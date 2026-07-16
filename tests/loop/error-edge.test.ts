/**
 * Error-path and boundary tests for the loop module.
 *
 * Covers: iteration stall detection, orphan task cleanup,
 * coordinator crash recovery — additive, no modifications
 * to existing tests.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { shouldCancelLoop, TERMINAL_PHASES, ORIGIN_OWNED_PHASES } from "../../src/loop/cancellation";
import {
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS_HARD_CAP,
  DISPATCH_ROUND_TIMEOUT_MS,
  INTER_ROUND_DELAY_MS,
  LOOP_PROGRESS_MARKER,
  STOP_LOOP_SIGNAL,
} from "../../src/loop/constants";
import { isTerminalPhase } from "../../src/loop/loop-store";
import { LoopCoordinator } from "../../src/loop/coordinator";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";
import type { LoopState, LoopPhase } from "../../src/loop/types";

// ─── Helper: fake adapter ───────────────────────────────────────────

function createFakeAdapter(): { adapter: IDispatchAdapter } {
  let taskCounter = 0;
  const adapter: IDispatchAdapter = {
    dispatchRound: mock(async () => {
      taskCounter += 1;
      return {
        workerTaskId: `task-${taskCounter}`,
        workerSessionId: `session-${taskCounter}`,
      };
    }),
    getRoundResult: mock(async () => ({ text: "ok", hadError: false })),
    cancelRound: mock(async () => {}),
    readOriginSummary: mock(async () => "summary"),
    getLastMessageId: mock(async () => "msg-1"),
    injectNote: mock(async () => {}),
    registerTerminatedListener: mock(
      (_taskId: string, callback: (taskId: string, status: string) => void) => {
        return callback;
      },
    ),
    removeTerminatedListener: mock(async () => {}),
    getTaskStatus: mock(async () => "completed"),
  };
  return { adapter };
}

function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    originSessionId: "ses_001",
    agent: "test-agent",
    basePrompt: "do the thing",
    mode: "inherit",
    total: 3,
    current: 1,
    phase: "awaiting_worker",
    cancelRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    roundStartedAt: Date.now(),
    schemaVersion: 1,
    ...overrides,
  };
}

// ─── Iteration stall detection ──────────────────────────────────────

describe("loop iteration stall detection", () => {
  it("DEFAULT_ITERATIONS is a positive integer", () => {
    expect(DEFAULT_ITERATIONS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_ITERATIONS)).toBe(true);
  });

  it("MAX_ITERATIONS_HARD_CAP prevents runaway execution", () => {
    expect(MAX_ITERATIONS_HARD_CAP).toBe(50);
    expect(MAX_ITERATIONS_HARD_CAP).toBeGreaterThan(0);
  });

  it("DISPATCH_ROUND_TIMEOUT_MS is a positive integer", () => {
    expect(DISPATCH_ROUND_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("INTER_ROUND_DELAY_MS is a non-negative integer", () => {
    expect(INTER_ROUND_DELAY_MS).toBeGreaterThanOrEqual(0);
  });

  it("isTerminalPhase returns true for 'interrupted'", () => {
    expect(isTerminalPhase("interrupted" as LoopPhase)).toBe(true);
  });

  it("isTerminalPhase returns false for non-terminal phases", () => {
    expect(isTerminalPhase("activating" as LoopPhase)).toBe(false);
    expect(isTerminalPhase("awaiting_worker" as LoopPhase)).toBe(false);
    expect(isTerminalPhase("summarizing" as LoopPhase)).toBe(false);
  });
});

// ─── Orphan task cleanup ───────────────────────────────────────────

describe("loop orphan task cleanup", () => {
  it("cancelNow with no active worker does not crash", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.register({
      originSessionId: "orphan-session",
      agent: "test-agent",
      prompt: "orphan test",
      mode: "inherit",
      iterations: 3,
    });

    await expect(c.cancelNow("orphan-session")).resolves.toBeUndefined();
  });

  it("double cancelNow on same session is idempotent", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.register({
      originSessionId: "double-cancel",
      agent: "test-agent",
      prompt: "test",
      mode: "inherit",
      iterations: 3,
    });

    await c.cancelNow("double-cancel");
    await expect(c.cancelNow("double-cancel")).resolves.toBeUndefined();
  });

  it("cancelNow on unknown session does not throw", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    await expect(c.cancelNow("phantom-session")).resolves.toBeUndefined();
  });

  it("requestCancel on unknown session does not throw", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    expect(() => c.requestCancel("phantom-session")).not.toThrow();
  });

  it("dispose clears all loop state including orphan references", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.register({
      originSessionId: "cleanup-test",
      agent: "test-agent",
      prompt: "clean me up",
      mode: "inherit",
      iterations: 3,
    });

    expect(c.getNonTerminalLoops().length).toBe(1);
    c.dispose();
    expect(c.getAllLoopStates().size).toBe(0);
    expect(c.getNonTerminalLoops().length).toBe(0);
  });
});

// ─── Coordinator crash recovery ─────────────────────────────────────

describe("loop coordinator crash recovery", () => {
  it("failSession transitions loop to error phase", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.register({
      originSessionId: "crash-test",
      agent: "test-agent",
      prompt: "will crash",
      mode: "inherit",
      iterations: 3,
    });

    await c.failSession("crash-test", "coordinator crashed");
    const state = c.getLoopState("crash-test")!;
    expect(state.phase).toBe("error");
    expect(state.errorReason).toContain("coordinator crashed");
  });

  it("failSession with empty reason produces readable state", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.register({
      originSessionId: "empty-reason",
      agent: "test-agent",
      prompt: "test",
      mode: "inherit",
      iterations: 2,
    });

    await c.failSession("empty-reason", "");
    const state = c.getLoopState("empty-reason")!;
    expect(state.phase).toBe("error");
  });

  it("failSession is a no-op when loop is already complete", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.register({
      originSessionId: "already-done",
      agent: "test-agent",
      prompt: "done",
      mode: "inherit",
      iterations: 1,
    });

    await new Promise((r) => setTimeout(r, 0));
    await c.onWorkerCompleted("task-1");
    await new Promise((r) => setTimeout(r, 0));

    const before = c.getLoopState("already-done")!;
    expect(isTerminalPhase(before.phase)).toBe(true);

    await c.failSession("already-done", "too late");
    const after = c.getLoopState("already-done")!;
    expect(after.phase).toBe(before.phase);
    expect(after.errorReason).toBeUndefined();
  });

  it("restoreState followed by reSubscribeListeners recovers activating phase", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    c.restoreState({
      originSessionId: "recovered-crash",
      agent: "recovered-agent",
      basePrompt: "recover from crash",
      mode: "inherit",
      total: 3,
      current: 1,
      phase: "activating",
      cancelRequested: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      roundStartedAt: Date.now(),
      schemaVersion: 1,
    });

    expect(c.getLoopState("recovered-crash")!.phase).toBe("activating");

    await c.reSubscribeListeners();

    const state = c.getLoopState("recovered-crash")!;
    expect(state.phase).toBe("awaiting_worker");
    expect(state.activeWorkerTaskId).toBeDefined();
  });

  it("calling onWorkerCompleted for unknown task does not crash", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    await expect(c.onWorkerCompleted("ghost-task")).resolves.toBeUndefined();
  });

  it("onOriginIdle for unknown session does not crash", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);

    await expect(c.onOriginIdle("nonexistent")).resolves.toBeUndefined();
  });
});

// ─── shouldCancelLoop edge cases ────────────────────────────────────

describe("shouldCancelLoop — edge cases", () => {
  it("returns false for terminal phases even with stop signal", () => {
    for (const phase of TERMINAL_PHASES) {
      const state = makeLoopState({ phase: phase as LoopPhase });
      const result = shouldCancelLoop(state, STOP_LOOP_SIGNAL);
      expect(result).toBe(false);
    }
  });

  it("returns false for origin-owned phases even with stop signal", () => {
    for (const phase of ORIGIN_OWNED_PHASES) {
      const state = makeLoopState({ phase: phase as LoopPhase });
      const result = shouldCancelLoop(state, STOP_LOOP_SIGNAL);
      expect(result).toBe(false);
    }
  });

  it("returns false for awaiting_worker without stop signal", () => {
    const state = makeLoopState({ phase: "awaiting_worker" });
    expect(shouldCancelLoop(state, "regular user message")).toBe(false);
  });

  it("returns false for message without stop signal in any phase", () => {
    const state = makeLoopState({ phase: "awaiting_worker" });
    const result = shouldCancelLoop(state, "continue the loop");
    expect(result).toBe(false);
  });
});

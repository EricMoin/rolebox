import { describe, it, expect, mock, afterEach } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import { ADVANCING_LOCK_TIMEOUT_MS } from "../../src/loop/constants";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";

// ── Fake Adapter ─────────────────────────────────────────────────────────

function createFakeAdapter(): { adapter: IDispatchAdapter } {
  let taskCounter = 0;

  const adapter: IDispatchAdapter = {
    dispatchRound: mock(
      async () => {
        taskCounter += 1;
        return {
          workerTaskId: `task-${taskCounter}`,
          workerSessionId: `session-${taskCounter}`,
        };
      },
    ),

    getRoundResult: mock(
      async () => ({ text: "worker output", hadError: false }),
    ),

    cancelRound: mock(async () => {}),

    readOriginSummary: mock(
      async () => "Round summary for sweeper test.",
    ),

    getLastMessageId: mock(
      async () => "msg-boundary",
    ),

    injectNote: mock(async () => {}),

    registerTerminatedListener: mock(
      (_taskId: string, callback: (taskId: string, status: string) => void) => callback,
    ),

    removeTerminatedListener: mock(() => {}),

    getTaskStatus: mock(async () => "completed"),
  };

  return { adapter };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("_advancing stale lock sweeper", () => {
  afterEach(() => {
    mock.restore();
  });

  it("sweeps a stale lock older than ADVANCING_LOCK_TIMEOUT_MS", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
      _sweepStaleLocks: () => void;
    };

    // Inject a lock that was acquired 40 seconds ago (well beyond the 30s timeout)
    coord._advancing.set("stale-session", Date.now() - ADVANCING_LOCK_TIMEOUT_MS - 10_000);

    // Trigger the sweeper manually
    coord._sweepStaleLocks();

    // The stale lock should be removed
    expect(coord._advancing.has("stale-session")).toBe(false);
    // The stale lock counter should be incremented
    expect(coord._staleLockCount).toBe(1);
  });

  it("does NOT sweep a fresh lock within timeout", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
      _sweepStaleLocks: () => void;
    };

    // Inject a lock acquired just now
    coord._advancing.set("fresh-session", Date.now());

    coord._sweepStaleLocks();

    // Fresh lock should remain
    expect(coord._advancing.has("fresh-session")).toBe(true);
    expect(coord._staleLockCount).toBe(0);
  });

  it("does NOT sweep a recently acquired lock within timeout boundary", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
      _sweepStaleLocks: () => void;
    };

    // Inject a lock acquired just at the boundary (max non-stale age)
    coord._advancing.set("boundary-session", Date.now() - ADVANCING_LOCK_TIMEOUT_MS);

    coord._sweepStaleLocks();

    // Exactly at the boundary is NOT stale (strictly greater than)
    expect(coord._advancing.has("boundary-session")).toBe(true);
    expect(coord._staleLockCount).toBe(0);
  });

  it("only sweeps the stale lock among mixed fresh/stale entries", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
      _sweepStaleLocks: () => void;
    };

    // Inject a mix of stale and fresh locks
    coord._advancing.set("stale-1", Date.now() - 60_000);
    coord._advancing.set("fresh-1", Date.now());
    coord._advancing.set("stale-2", Date.now() - 45_000);
    coord._advancing.set("fresh-2", Date.now() - 5_000);

    coord._sweepStaleLocks();

    // Stale locks removed
    expect(coord._advancing.has("stale-1")).toBe(false);
    expect(coord._advancing.has("stale-2")).toBe(false);
    // Fresh locks remain
    expect(coord._advancing.has("fresh-1")).toBe(true);
    expect(coord._advancing.has("fresh-2")).toBe(true);
    // Counter = 2 stale swept
    expect(coord._staleLockCount).toBe(2);
  });

  it("getAdvancingLockState reports active and stale counts", () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
      _sweepStaleLocks: () => void;
    };

    // No locks
    expect(c.getAdvancingLockState()).toEqual({ activeLocks: 0, staleLocks: 0 });

    // Acquire a fresh lock
    coord._advancing.set("active-1", Date.now());
    expect(c.getAdvancingLockState()).toEqual({ activeLocks: 1, staleLocks: 0 });

    // Acquire another
    coord._advancing.set("active-2", Date.now());
    expect(c.getAdvancingLockState()).toEqual({ activeLocks: 2, staleLocks: 0 });

    // Simulate some stale sweeps
    coord._staleLockCount = 3;
    expect(c.getAdvancingLockState()).toEqual({ activeLocks: 2, staleLocks: 3 });
  });

  it("after stale lock is swept, loop operations can proceed normally", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
      _sweepStaleLocks: () => void;
    };

    // Simulate an abandoned lock (e.g., from a crash during _advancing)
    coord._advancing.set("ghost-session", Date.now() - 60_000);

    // Sweeper cleans it up
    coord._sweepStaleLocks();
    expect(coord._advancing.has("ghost-session")).toBe(false);
    expect(coord._staleLockCount).toBe(1);

    // Now register a new loop — must still work
    c.register({
      originSessionId: "origin-after-sweep",
      agent: "test-agent",
      prompt: "Continue after stale lock cleanup",
      mode: "inherit",
      iterations: 3,
    });

    // Flush microtask queue for self-start kickoff
    await new Promise((r) => setTimeout(r, 0));

    const state = c.getLoopState("origin-after-sweep")!;
    expect(state.phase).toBe("awaiting_worker");
    expect(state.activeWorkerTaskId).toBe("task-1");
    expect(state.current).toBe(1);

    // Complete round 1 — push chain should work
    await c.onWorkerCompleted("task-1");
    await new Promise((r) => setTimeout(r, 0));

    const state2 = c.getLoopState("origin-after-sweep")!;
    expect(state2.current).toBe(2);
    expect(state2.phase).toBe("awaiting_worker");
  });

  it("sweeper runs on the configured interval and clears stale locks", async () => {
    const { adapter } = createFakeAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _advancing: Map<string, number>;
      _staleLockCount: number;
    };

    // Inject a stale lock
    coord._advancing.set("interval-stale", Date.now() - 60_000);
    expect(coord._advancing.has("interval-stale")).toBe(true);

    // Wait for the sweeper interval to fire (SWEEPER_INTERVAL_MS = 15s)
    // We use a shorter synthetic wait: piggyback on the setInterval by
    // waiting just over the interval. Since the sweeper clears intervals
    // on dispose, we clean up after ourselves.
    await new Promise((r) => setTimeout(r, 16_000));

    // The sweeper should have cleared the stale lock
    expect(coord._advancing.has("interval-stale")).toBe(false);
    expect(coord._staleLockCount).toBe(1);

    // Cleanup
    c.dispose();
  }, 20_000); // 20s timeout for the interval-based test
});

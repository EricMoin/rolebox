/**
 * Realistic listener-timing tests for the loop push chain.
 *
 * These tests drive loops exclusively through the stateful fake adapter's
 * terminated-listener path — the same async setTimeout-tick delivery the real
 * DispatchManager uses — and assert the coordinator's guard + deferral
 * mechanics (src/loop/coordinator.ts) hold under that timing:
 *
 * - completion is delivered asynchronously (never synchronously),
 * - a task's listener fires at most once,
 * - stale completions are rejected by the onWorkerCompleted guards,
 * - a completion arriving while the _advancing critical section is held is
 *   deferred into _pendingCompletions and drained exactly once,
 * - onOriginIdle never advances the loop (advancement is push-chain only).
 */

import { describe, it, expect } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import {
  createStatefulAdapter,
  settle,
  type StatefulAdapterCall,
} from "./helpers/stateful-adapter";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";

/** workerTaskId of every getRoundResult call, in call order. */
function getResultTaskIds(calls: StatefulAdapterCall[]): string[] {
  return calls
    .filter((call) => call.method === "getRoundResult")
    .map((call) => call.args[0] as string);
}

/**
 * Stateful adapter whose getRoundResult waits 30ms before delegating.
 * Used by the deferral test to hold the _advancing critical section open with
 * real async latency — deliberately NOT the synchronous-fire-at-registration
 * trick used by push-chain-race.test.ts.
 */
function createSlowResultAdapter() {
  const bundle = createStatefulAdapter();
  const adapter: IDispatchAdapter = {
    ...bundle.adapter,
    async getRoundResult(workerTaskId: string) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return bundle.adapter.getRoundResult(workerTaskId);
    },
  };
  return { ...bundle, adapter };
}

describe("execution timing of the loop push chain", () => {
  it("a) async listener fire still advances the loop to completion", async () => {
    // Regression intent: the real DispatchManager delivers terminated events
    // asynchronously (the fake mirrors this with a setTimeout(0) tick). The
    // push chain must advance purely from those async fires — no synchronous
    // invocation, no manual onWorkerCompleted.
    const { adapter, calls, dispatchedTasks, completeTask } =
      createStatefulAdapter();
    const c = new LoopCoordinator(adapter);
    try {
      c.register({
        originSessionId: "a-origin",
        agent: "test-agent",
        prompt: "do work",
        mode: "inherit",
        iterations: 3,
      });
      // Self-start kickoff (coordinator.ts:344) dispatches round 1.
      await settle();
      const state1 = c.getLoopState("a-origin")!;
      expect(state1.phase).toBe("awaiting_worker");
      expect(state1.activeWorkerTaskId).toBe("task-1");

      // Cross a microtask boundary before completing — delivery must still be
      // async (setTimeout(0) in the fake), never synchronous.
      await Promise.resolve();
      completeTask("task-1");
      await settle();
      expect(c.getLoopState("a-origin")!.current).toBe(2);

      completeTask("task-2");
      await settle();
      expect(c.getLoopState("a-origin")!.current).toBe(3);

      completeTask("task-3");
      await settle();
      const state2 = c.getLoopState("a-origin")!;
      expect(state2.phase).toBe("complete");
      expect(state2.current).toBe(4);

      expect(dispatchedTasks).toEqual(["task-1", "task-2", "task-3"]);
      // getRoundResult exactly once per task, in dispatch order.
      expect(getResultTaskIds(calls)).toEqual(["task-1", "task-2", "task-3"]);
    } finally {
      c.dispose();
    }
  });

  it("b) double-fire of the same task's listener advances exactly once", async () => {
    // Regression intent: fire-once listener semantics (stateful-adapter.ts:98-111)
    // plus the coordinator guards (coordinator.ts:369-387) must collapse any
    // duplicate completion for the same task into exactly one advance.
    const { adapter, calls, dispatchedTasks, completeTask } =
      createStatefulAdapter();
    const c = new LoopCoordinator(adapter);
    try {
      c.register({
        originSessionId: "b-origin",
        agent: "test-agent",
        prompt: "do work",
        mode: "inherit",
        iterations: 2,
      });
      await settle();
      expect(c.getLoopState("b-origin")!.activeWorkerTaskId).toBe("task-1");

      // (i) Two back-to-back completes before any settle: the fake's registry
      // deletes the listener before firing, so the second call schedules
      // nothing.
      completeTask("task-1");
      completeTask("task-1");
      await settle();

      // (ii) A direct duplicate completion for the already-processed task:
      // guard (1) — the _workerToOrigin mapping was deleted (coordinator.ts:410)
      // — rejects it before anything can advance.
      await c.onWorkerCompleted("task-1");

      const state = c.getLoopState("b-origin")!;
      expect(state.current).toBe(2);
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-2");
      expect(dispatchedTasks).toEqual(["task-1", "task-2"]);
      expect(getResultTaskIds(calls)).toEqual(["task-1"]);
    } finally {
      c.dispose();
    }
  });

  it("c) stale-task completeTask is a no-op — no double-advance", async () => {
    // Regression intent: completing a task whose listener already fired (or
    // calling onWorkerCompleted for it directly) must not advance the loop a
    // second time. Guards at coordinator.ts:369 (mapping gone) and :384 (task
    // id mismatch) reject the stale call, and the chain stays uncorrupted for
    // the remaining rounds.
    const { adapter, calls, dispatchedTasks, completeTask } =
      createStatefulAdapter();
    const c = new LoopCoordinator(adapter);
    try {
      c.register({
        originSessionId: "c-origin",
        agent: "test-agent",
        prompt: "do work",
        mode: "inherit",
        iterations: 3,
      });
      await settle();
      completeTask("task-1");
      await settle();
      expect(c.getLoopState("c-origin")!.current).toBe(2);

      // Stale: task-1's listener already fired and was removed, and the direct
      // onWorkerCompleted is rejected by the guards.
      completeTask("task-1");
      await c.onWorkerCompleted("task-1");

      let state = c.getLoopState("c-origin")!;
      expect(state.current).toBe(2);
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-2");
      expect(getResultTaskIds(calls)).toEqual(["task-1"]);

      // The stale calls must not have corrupted the chain: remaining rounds
      // complete normally through the push chain.
      completeTask("task-2");
      await settle();
      completeTask("task-3");
      await settle();
      state = c.getLoopState("c-origin")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);
      expect(dispatchedTasks).toEqual(["task-1", "task-2", "task-3"]);
      expect(getResultTaskIds(calls)).toEqual(["task-1", "task-2", "task-3"]);
    } finally {
      c.dispose();
    }
  });

  it("d) completion arriving while _advancing is held is deferred and drained exactly once", async () => {
    // Regression intent: a completion that lands inside the previous round's
    // _advancing critical section must be queued (coordinator.ts:397-404) and
    // re-processed exactly once after the section exits (finally, :450-465) —
    // NOT dropped, NOT double-advanced. Unlike push-chain-race.test.ts (which
    // fires synchronously at registration), this holds the section open with
    // real async latency inside getRoundResult.
    const { adapter, calls, dispatchedTasks, completeTask } =
      createSlowResultAdapter();
    const c = new LoopCoordinator(adapter);
    const coord = c as unknown as {
      _pendingCompletions: Map<string, string[]>;
    };
    try {
      c.register({
        originSessionId: "d-origin",
        agent: "test-agent",
        prompt: "do work",
        mode: "inherit",
        iterations: 2,
      });
      await settle();
      expect(c.getLoopState("d-origin")!.activeWorkerTaskId).toBe("task-1");

      // Enter the critical section WITHOUT awaiting: the lock is acquired
      // synchronously (coordinator.ts:406) before getRoundResult's 30ms wait.
      const processing = c.onWorkerCompleted("task-1");

      // Complete task-1 while the section is held. The setTimeout(0) listener
      // fire lands inside the section; the guards still pass (task-1 is still
      // active), so the duplicate completion is DEFERRED, not dropped.
      completeTask("task-1");
      await settle();
      expect(coord._pendingCompletions.get("d-origin")).toEqual(["task-1"]);

      // Section exits: the finally block drains the queue via queueMicrotask;
      // the drained completion then no-ops on guard (1) (mapping deleted at
      // coordinator.ts:410), so the loop advanced exactly once.
      await processing;
      await settle();
      expect(coord._pendingCompletions.get("d-origin")).toEqual([]);

      const state = c.getLoopState("d-origin")!;
      expect(state.current).toBe(2);
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-2");
      expect(dispatchedTasks).toEqual(["task-1", "task-2"]);
      expect(getResultTaskIds(calls)).toEqual(["task-1"]);
    } finally {
      c.dispose();
    }
  });

  it("e) onOriginIdle never advances the loop", async () => {
    // Regression intent: onOriginIdle is a no-op switch (coordinator.ts:349-366);
    // every advance must come from the terminated-listener push chain
    // (completeTask → listener → onWorkerCompleted → _advanceFromSummarizing).
    const { adapter, calls, dispatchedTasks, completeTask } =
      createStatefulAdapter();
    const c = new LoopCoordinator(adapter);
    try {
      c.register({
        originSessionId: "e-origin",
        agent: "test-agent",
        prompt: "do work",
        mode: "inherit",
        iterations: 3,
      });
      await settle();
      let state = c.getLoopState("e-origin")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.current).toBe(1);

      await c.onOriginIdle("e-origin");
      state = c.getLoopState("e-origin")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.current).toBe(1);

      // Only a terminated-listener completion advances the loop.
      completeTask("task-1");
      await settle();
      expect(c.getLoopState("e-origin")!.current).toBe(2);

      await c.onOriginIdle("e-origin");
      state = c.getLoopState("e-origin")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.current).toBe(2);

      completeTask("task-2");
      await settle();
      expect(c.getLoopState("e-origin")!.current).toBe(3);

      completeTask("task-3");
      await settle();
      state = c.getLoopState("e-origin")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);

      // Idle on the completed loop is also a no-op.
      await c.onOriginIdle("e-origin");
      state = c.getLoopState("e-origin")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);

      // Every dispatch/advance came from a terminated-listener completion.
      expect(dispatchedTasks).toEqual(["task-1", "task-2", "task-3"]);
      expect(getResultTaskIds(calls)).toEqual(["task-1", "task-2", "task-3"]);
    } finally {
      c.dispose();
    }
  });
});

/**
 * Termination-precedence tests for the loop coordinator.
 *
 * Locks the precedence and boundary semantics of loop termination, driven
 * end-to-end through the stateful adapter (tests/loop/helpers/stateful-adapter.ts)
 * so round completions flow through the same fire-once terminated-listener
 * push chain as production:
 *
 *  1. (a) The iteration cap beats a pending cancel request. handleSummary
 *     (src/loop/worker-dispatch.ts) checks `current > total` BEFORE
 *     `cancelRequested`, so a cancel that arrives while the final round is in
 *     flight still yields phase "complete" — no extra dispatch happens.
 *  2. (b) A mid-loop cancel request with rounds remaining is honored at the
 *     NEXT summarize boundary: phase "cancelled", and no further dispatch.
 *  3. (c) /stop-loop (STOP_LOOP_SIGNAL via shouldCancelOnUserMessage) during
 *     awaiting_worker sets cancelRequested; the in-flight round still
 *     completes and the loop terminates as "cancelled".
 *  4. (d) shouldCancelOnUserMessage returns false during origin-owned phases
 *     (summarizing, activating) — cancellation is rejected and the loop
 *     continues running.
 *  5. (e) cancelNow during awaiting_worker cancels immediately: cancelRound
 *     is called with the active task id, the terminated listener is removed,
 *     and phase becomes "cancelled".
 *  6. (f) A failed round (failTask → hadError) terminates the loop as
 *     "error" with exactly one dispatchRound — no further rounds launch.
 */
import { describe, it, expect } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import { STOP_LOOP_SIGNAL } from "../../src/loop/constants";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";
import {
  createStatefulAdapter,
  settle,
} from "./helpers/stateful-adapter";

const ORIGIN = "origin-1";

/** Register a fresh loop on `c` with the given iteration count. */
function registerLoop(c: LoopCoordinator, iterations: number): void {
  const result = c.register({
    originSessionId: ORIGIN,
    agent: "test-agent",
    prompt: "do the thing",
    mode: "inherit",
    iterations,
  });
  expect(result).toEqual({ ok: true });
}

describe("loop termination precedence (stateful adapter)", () => {
  it("(a) iteration cap beats cancelRequested — final phase 'complete'", async () => {
    const { adapter, dispatchedTasks, completeTask } = createStatefulAdapter();
    const c = new LoopCoordinator(adapter);

    registerLoop(c, 3);
    await settle(); // self-start kickoff → round 1 (task-1)
    completeTask("task-1");
    await settle(); // → round 2 (task-2)
    completeTask("task-2");
    await settle(); // → round 3 (task-3)

    // Cancel is requested while the FINAL round is still in flight.
    const beforeCancel = c.getLoopState(ORIGIN)!;
    expect(beforeCancel.phase).toBe("awaiting_worker");
    expect(beforeCancel.current).toBe(3);

    c.requestCancel(ORIGIN);
    expect(c.getLoopState(ORIGIN)!.cancelRequested).toBe(true);

    // The final round completes normally. handleSummary checks the cap
    // (current > total) BEFORE cancelRequested, so the loop must end as
    // "complete", not "cancelled".
    completeTask("task-3");
    await settle();

    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("complete");
    expect(state.current).toBe(4);
    // Cap wins: exactly the requested 3 rounds, no extra dispatch despite
    // the pending cancel flag.
    expect(dispatchedTasks).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("(b) mid-loop cancelRequested → 'cancelled' at next summarize boundary, no further dispatch", async () => {
    const { adapter, dispatchedTasks, completeTask } = createStatefulAdapter();
    const c = new LoopCoordinator(adapter);

    registerLoop(c, 5);
    await settle(); // round 1 (task-1)
    completeTask("task-1");
    await settle(); // → round 2 (task-2), current = 2

    // Cancel while rounds remain — the loop keeps waiting for the in-flight
    // round; cancellation is applied at the next summarize boundary.
    c.requestCancel(ORIGIN);
    expect(c.getLoopState(ORIGIN)!.cancelRequested).toBe(true);

    completeTask("task-2");
    await settle();

    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("cancelled");
    // current was incremented inside handleSummary before the cancel check.
    expect(state.current).toBe(3);
    // No further dispatch: round 3 was never launched.
    expect(dispatchedTasks).toEqual(["task-1", "task-2"]);
  });

  it("(c) STOP_LOOP_SIGNAL during awaiting_worker sets cancelRequested → 'cancelled' after current round completes", async () => {
    const { adapter, dispatchedTasks, completeTask } = createStatefulAdapter();
    const c = new LoopCoordinator(adapter);

    registerLoop(c, 3);
    await settle(); // round 1 (task-1) in flight

    // /stop-loop message during awaiting_worker → cancellation requested.
    const decided = c.shouldCancelOnUserMessage(ORIGIN, STOP_LOOP_SIGNAL);
    expect(decided).toBe(true);
    expect(c.getLoopState(ORIGIN)!.cancelRequested).toBe(true);

    // The in-flight round completes normally; termination happens at the
    // summarize boundary as "cancelled", and no further round is dispatched.
    completeTask("task-1");
    await settle();

    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("cancelled");
    expect(dispatchedTasks).toEqual(["task-1"]);
  });

  it("(d) STOP_LOOP_SIGNAL during summarizing → false, loop continues", async () => {
    const { adapter, completeTask, dispatchedTasks } = createStatefulAdapter();

    // Gate readOriginSummary so the push chain parks in "summarizing",
    // giving the test a deterministic window to observe that phase.
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((r) => {
      releaseSummary = r;
    });
    let markSummaryCalled!: () => void;
    const summaryCalled = new Promise<void>((r) => {
      markSummaryCalled = r;
    });

    const gatedAdapter: IDispatchAdapter = {
      ...adapter,
      readOriginSummary: async (
        originSessionId: string,
        sinceMessageId?: string,
      ) => {
        markSummaryCalled();
        await summaryGate;
        return adapter.readOriginSummary(originSessionId, sinceMessageId);
      },
    };

    const c = new LoopCoordinator(gatedAdapter);
    registerLoop(c, 3);
    await settle(); // round 1 (task-1) in flight

    completeTask("task-1");
    await summaryCalled; // chain parked inside handleSummary
    expect(c.getLoopState(ORIGIN)!.phase).toBe("summarizing");

    // Origin-owned phases reject cancellation: no flag set, false returned.
    const decided = c.shouldCancelOnUserMessage(ORIGIN, STOP_LOOP_SIGNAL);
    expect(decided).toBe(false);
    expect(c.getLoopState(ORIGIN)!.cancelRequested).toBe(false);

    // Releasing the gate lets the loop proceed to round 2 — untouched.
    releaseSummary();
    await settle();

    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("awaiting_worker");
    expect(dispatchedTasks).toEqual(["task-1", "task-2"]);
  });

  it("(d) STOP_LOOP_SIGNAL during activating → false, loop still starts", async () => {
    const { adapter, dispatchedTasks } = createStatefulAdapter();
    const c = new LoopCoordinator(adapter);

    registerLoop(c, 3);
    // register() sets phase "activating" synchronously; the kickoff is
    // scheduled on a microtask, so no settle is needed to observe it.
    expect(c.getLoopState(ORIGIN)!.phase).toBe("activating");

    const decided = c.shouldCancelOnUserMessage(ORIGIN, STOP_LOOP_SIGNAL);
    expect(decided).toBe(false);
    expect(c.getLoopState(ORIGIN)!.cancelRequested).toBe(false);

    // The kickoff proceeds normally — the loop is not cancelled.
    await settle();
    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("awaiting_worker");
    expect(dispatchedTasks).toEqual(["task-1"]);
  });

  it("(e) cancelNow during awaiting_worker → immediate 'cancelled', cancelRound(active task), listener removed", async () => {
    const { adapter, calls, dispatchedTasks, completeTask } =
      createStatefulAdapter();
    const c = new LoopCoordinator(adapter);

    registerLoop(c, 3);
    await settle(); // round 1 (task-1) in flight
    expect(c.getLoopState(ORIGIN)!.activeWorkerTaskId).toBe("task-1");

    await c.cancelNow(ORIGIN);

    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("cancelled");
    expect(state.cancelRequested).toBe(true);

    // cancelRound was invoked with the in-flight task id (and only once).
    const cancelCalls = calls.filter((cc) => cc.method === "cancelRound");
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].args).toEqual(["task-1"]);

    // The terminated listener for the active task was removed.
    const removeCalls = calls.filter(
      (cc) => cc.method === "removeTerminatedListener",
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0].args[0]).toBe("task-1");

    // Nothing further is dispatched, and completing the cancelled task has
    // no effect on the already-terminal loop.
    completeTask("task-1");
    await settle();
    expect(dispatchedTasks).toEqual(["task-1"]);
    expect(c.getLoopState(ORIGIN)!.phase).toBe("cancelled");
  });

  it("(f) failTask mid-loop → phase 'error', exactly one dispatchRound", async () => {
    const { adapter, dispatchedTasks, failTask } = createStatefulAdapter();
    const c = new LoopCoordinator(adapter);

    registerLoop(c, 3);
    await settle(); // round 1 (task-1) in flight

    // failTask records the failure; drive onWorkerCompleted directly to
    // advance the push chain (matching the stateful adapter contract).
    failTask("task-1", "worker exploded");
    await c.onWorkerCompleted("task-1");

    const state = c.getLoopState(ORIGIN)!;
    expect(state.phase).toBe("error");
    expect(state.errorReason).toBe("worker exploded");
    // The failed round is recorded as error; no further rounds launched.
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds![0].status).toBe("error");
    expect(dispatchedTasks).toEqual(["task-1"]);
  });
});

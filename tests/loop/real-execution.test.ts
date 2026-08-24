/**
 * Real-execution push-chain tests.
 *
 * Drives the REAL production push chain exclusively through the stateful
 * adapter's `completeTask`, which simulates DispatchManager.onTaskTerminated:
 *
 *   completeTask(taskId)
 *     → registered terminated listener (fire-once, setTimeout-ticked)
 *       → coordinator.onWorkerCompleted(taskId)
 *         → getRoundResult → summarize (handleSummary)
 *           → next dispatchRound or finalizeLoop
 *
 * `onWorkerCompleted` is NEVER called directly in these tests — every round
 * transition happens because the adapter's terminated listener fired.
 *
 * Register input used throughout:
 *   { originSessionId: "origin-exec", agent: "test-agent",
 *     prompt: "Do the thing", mode: "inherit", iterations: 3 }
 */

/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import { LOOP_PROGRESS_MARKER } from "../../src/loop/constants";
import {
  createStatefulAdapter,
  settle,
  type StatefulAdapterBundle,
} from "./helpers/stateful-adapter";

const REGISTER_INPUT = {
  originSessionId: "origin-exec",
  agent: "test-agent",
  prompt: "Do the thing",
  mode: "inherit" as const,
  iterations: 3,
};

/**
 * Drive `roundCount` rounds to completion through the stateful adapter's
 * fire-once terminated listeners. After `settle()` (self-start kickoff), round
 * 1 is dispatched and its listener registered; each `completeTask` fires that
 * listener, which push-chains into the next dispatch (or finalize on the last
 * round) — exactly like DispatchManager notifying a real completion.
 */
async function driveRounds(
  bundle: StatefulAdapterBundle,
  coordinator: LoopCoordinator,
  roundCount: number,
): Promise<void> {
  await settle(); // self-start kickoff → dispatch round 1 + register listener
  for (let i = 0; i < roundCount; i++) {
    const taskId = bundle.dispatchedTasks[i]!;
    bundle.completeTask(taskId); // fires the registered terminated listener
    await settle(); // drain the chained setTimeout/microtask push chain
  }
}

describe("real push chain via stateful adapter completeTask", () => {
  it("(a) iterations=3 dispatches exactly 3 rounds, all completed, sessions pairwise distinct", async () => {
    const bundle = createStatefulAdapter();
    const c = new LoopCoordinator(bundle.adapter);

    c.register(REGISTER_INPUT);
    await settle(); // self-start kickoff → round 1

    // Progression check: the push chain advances one round per completion.
    expect(c.getLoopState("origin-exec")!.phase).toBe("awaiting_worker");
    expect(c.getLoopState("origin-exec")!.current).toBe(1);
    expect(c.getLoopState("origin-exec")!.activeWorkerTaskId).toBe("task-1");

    bundle.completeTask("task-1");
    await settle();
    expect(c.getLoopState("origin-exec")!.current).toBe(2);
    expect(c.getLoopState("origin-exec")!.activeWorkerTaskId).toBe("task-2");

    bundle.completeTask("task-2");
    await settle();
    expect(c.getLoopState("origin-exec")!.current).toBe(3);
    expect(c.getLoopState("origin-exec")!.activeWorkerTaskId).toBe("task-3");

    bundle.completeTask("task-3");
    await settle();

    // Exactly 3 rounds dispatched — no extra dispatch after finalize.
    expect(bundle.dispatchedTasks).toEqual(["task-1", "task-2", "task-3"]);
    expect(bundle.dispatchedSessions).toEqual(["session-1", "session-2", "session-3"]);

    const state = c.getLoopState("origin-exec")!;
    expect(state.rounds).toHaveLength(3);
    for (const round of state.rounds!) {
      expect(round.status).toBe("completed");
    }
    expect(state.current).toBe(4);
    expect(state.phase).toBe("complete");

    // Session freshness: 3 rounds used 3 pairwise-distinct worker sessions.
    const sessions = state.rounds!.map((r) => r.workerSessionId);
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions).size).toBe(3);
    expect(sessions).toEqual(["session-1", "session-2", "session-3"]);
  });

  it("(b) iterations=1 completes after one round", async () => {
    const bundle = createStatefulAdapter();
    const c = new LoopCoordinator(bundle.adapter);

    c.register({ ...REGISTER_INPUT, iterations: 1 });
    await driveRounds(bundle, c, 1);

    expect(bundle.dispatchedTasks).toEqual(["task-1"]);

    const state = c.getLoopState("origin-exec")!;
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds![0]!.status).toBe("completed");
    expect(state.current).toBe(2); // incremented past total → terminal
    expect(state.phase).toBe("complete");
  });

  it("(c) getRoundResult called task-1/task-2/task-3 in order; completion note lists all sessions", async () => {
    const bundle = createStatefulAdapter();
    const c = new LoopCoordinator(bundle.adapter);

    c.register(REGISTER_INPUT);
    await driveRounds(bundle, c, 3);

    // Per-round result identity: one getRoundResult per task, in dispatch order.
    const resultCalls = bundle.calls.filter((call) => call.method === "getRoundResult");
    expect(resultCalls.map((call) => call.args[0])).toEqual(["task-1", "task-2", "task-3"]);

    // Completion note (finalizeLoop Rounds summary) contains all three session ids.
    const injectCalls = bundle.calls.filter((call) => call.method === "injectNote");
    const completionNote = injectCalls.find(
      (call) =>
        typeof call.args[1] === "string" &&
        (call.args[1] as string).includes("loop complete"),
    );
    expect(completionNote).not.toBeUndefined();

    const note = completionNote!.args[1] as string;
    expect(note).toContain(LOOP_PROGRESS_MARKER);
    expect(note).toContain("Rounds:");
    expect(note).toContain("r1:session-1");
    expect(note).toContain("r2:session-2");
    expect(note).toContain("r3:session-3");
    expect(note).toContain("session-1");
    expect(note).toContain("session-2");
    expect(note).toContain("session-3");
  });

  it("(d) inherit mode seeds round K+1 prompt with 'Summary for round K'", async () => {
    const bundle = createStatefulAdapter();
    const c = new LoopCoordinator(bundle.adapter);

    c.register(REGISTER_INPUT); // mode: inherit
    await driveRounds(bundle, c, 3);

    const dispatchCalls = bundle.calls.filter((call) => call.method === "dispatchRound");
    expect(dispatchCalls).toHaveLength(3);

    // Round 1 has no seed (no summary yet).
    const round1Prompt = (dispatchCalls[0]!.args[0] as { prompt: string }).prompt;
    expect(round1Prompt).toBe("Do the thing");

    // Round 2 is seeded with round 1's summary.
    const round2Prompt = (dispatchCalls[1]!.args[0] as { prompt: string }).prompt;
    expect(round2Prompt).toContain("Summary for round 1");
    expect(round2Prompt).toContain("---");
    expect(round2Prompt).toContain("Do the thing");

    // Round 3 is seeded with round 2's summary.
    const round3Prompt = (dispatchCalls[2]!.args[0] as { prompt: string }).prompt;
    expect(round3Prompt).toContain("Summary for round 2");
    expect(round3Prompt).toContain("---");
    expect(round3Prompt).toContain("Do the thing");
  });

  it("(e) fresh mode does NOT seed round K+1 prompt", async () => {
    const bundle = createStatefulAdapter();
    const c = new LoopCoordinator(bundle.adapter);

    c.register({ ...REGISTER_INPUT, mode: "fresh" });
    await driveRounds(bundle, c, 3);

    const dispatchCalls = bundle.calls.filter((call) => call.method === "dispatchRound");
    expect(dispatchCalls).toHaveLength(3);

    for (const call of dispatchCalls) {
      const prompt = (call.args[0] as { prompt: string }).prompt;
      expect(prompt).toBe("Do the thing");
      expect(prompt).not.toContain("---");
      expect(prompt).not.toContain("Summary for round");
    }
  });

  it("(f) loop-started note injected exactly once across the whole run", async () => {
    const bundle = createStatefulAdapter();
    const c = new LoopCoordinator(bundle.adapter);

    c.register(REGISTER_INPUT);
    await driveRounds(bundle, c, 3);

    const startedNotes = bundle.calls.filter(
      (call) =>
        call.method === "injectNote" &&
        typeof call.args[1] === "string" &&
        (call.args[1] as string).includes("loop started"),
    );
    expect(startedNotes).toHaveLength(1);

    const note = startedNotes[0]!.args[1] as string;
    expect(note).toContain(LOOP_PROGRESS_MARKER);
    expect(note).toContain("3 rounds");
    expect(note).toContain("inherit");
  });
});

import { describe, it, expect, mock } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";
import type { LoopState } from "../../src/loop/types";
import { LOOP_PROGRESS_MARKER, SEED_CHAR_CAP } from "../../src/loop/constants";

// ── Fake Adapter ─────────────────────────────────────────────────────────

interface FakeAdapterCall {
  method: string;
  args: unknown[];
}

function createFakeAdapter(
  overrides?: Partial<{
    dispatchRoundResult: { workerTaskId: string; workerSessionId: string };
    getRoundResultResult: {
      text: string;
      hadError: boolean;
      errorReason?: string;
    };
    readOriginSummaryResult: string;
    lastMessageId: string | undefined;
  }>,
): { adapter: IDispatchAdapter; calls: FakeAdapterCall[] } {
  const calls: FakeAdapterCall[] = [];
  let taskCounter = 0;
  let msgIdCounter = 0;

  const adapter: IDispatchAdapter = {
    dispatchRound: mock(
      async (_input: {
        originSessionId: string;
        agent: string;
        prompt: string;
        description?: string;
      }) => {
        taskCounter += 1;
        const taskId = `task-${taskCounter}`;
        calls.push({
          method: "dispatchRound",
          args: [_input],
        });
        return overrides?.dispatchRoundResult ?? {
          workerTaskId: taskId,
          workerSessionId: `session-${taskCounter}`,
        };
      },
    ),

    getRoundResult: mock(
      async (_workerTaskId: string) => {
        calls.push({
          method: "getRoundResult",
          args: [_workerTaskId],
        });
        return overrides?.getRoundResultResult ?? {
          text: "worker output",
          hadError: false,
        };
      },
    ),

    cancelRound: mock(async (_workerTaskId: string) => {
      calls.push({ method: "cancelRound", args: [_workerTaskId] });
    }),

    readOriginSummary: mock(
      async (_originSessionId: string, _sinceMessageId?: string) => {
        calls.push({
          method: "readOriginSummary",
          args: [_originSessionId, _sinceMessageId],
        });
        return overrides?.readOriginSummaryResult ??
          "Round 1 summary: completed successfully.";
      },
    ),

    getLastMessageId: mock(
      async (_originSessionId: string) => {
        calls.push({
          method: "getLastMessageId",
          args: [_originSessionId],
        });
        if (overrides?.lastMessageId !== undefined) {
          return overrides.lastMessageId;
        }
        msgIdCounter += 1;
        return `msg-${msgIdCounter}`;
      },
    ),

    injectNote: mock(
      async (_sessionId: string, _text: string) => {
        calls.push({ method: "injectNote", args: [_sessionId, _text] });
      },
    ),

    registerTerminatedListener: mock(
      (
        _taskId: string,
        _callback: (taskId: string, status: string) => void,
      ) => {
        calls.push({
          method: "registerTerminatedListener",
          args: [_taskId, _callback],
        });
        // Fire-once semantics: returns the same callback
        return _callback;
      },
    ),

    removeTerminatedListener: mock(
      (
        _taskId: string,
        _callback: (taskId: string, status: string) => void,
      ) => {
        calls.push({
          method: "removeTerminatedListener",
          args: [_taskId, _callback],
        });
      },
    ),
  };

  return { adapter, calls };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const REGISTER_INPUT = {
  originSessionId: "origin-1",
  agent: "test-agent",
  prompt: "Do the thing",
  mode: "inherit" as const,
  iterations: 3,
};

/** Flush microtask queue to let self-start kickoff from register complete */
function flushMicrotask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("LoopCoordinator", () => {
  describe("register", () => {
    it("creates a LoopState with phase=activating", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);

      const state = c.getLoopState("origin-1")!;
      expect(state).not.toBeUndefined();
      expect(state.phase).toBe("activating");
      expect(state.originSessionId).toBe("origin-1");
      expect(state.agent).toBe("test-agent");
      expect(state.basePrompt).toBe("Do the thing");
      expect(state.mode).toBe("inherit");
      expect(state.total).toBe(3);
      expect(state.current).toBe(1);
      expect(state.cancelRequested).toBe(false);
      expect(state.activeWorkerTaskId).toBeUndefined();
      expect(state.activeWorkerSessionId).toBeUndefined();
      expect(state.lastSummary).toBeUndefined();
      expect(state.schemaVersion).toBeGreaterThan(0);
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.updatedAt).toBeGreaterThan(0);
      expect(state.roundStartedAt).toBeGreaterThan(0);
    });

    it("is idempotent for the same originSessionId", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      const first = c.getLoopState("origin-1")!;

      c.register({
        ...REGISTER_INPUT,
        iterations: 999,
      });
      const second = c.getLoopState("origin-1")!;

      expect(second.total).toBe(first.total);
      expect(second.iterations).toBeUndefined?.() ??
        expect(second.total).toBe(3);
    });
  });

  describe("self-start from register", () => {
    it("dispatches round 1 and transitions to awaiting_worker", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      // Wait for the self-start microtask (_kickoffFromActivating) to complete
      await flushMicrotask();

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-1");
      expect(state.activeWorkerSessionId).toBe("session-1");

      const dispatchCall = calls.find(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCall).not.toBeUndefined();

      const input = dispatchCall!.args[0] as {
        originSessionId: string;
        agent: string;
        prompt: string;
        description?: string;
      };
      expect(input.originSessionId).toBe("origin-1");
      expect(input.agent).toBe("test-agent");
      expect(input.prompt).toBe("Do the thing");
      expect(input.description).toContain("round 1/3");
    });

    it("injects a loop-started note on the first round only", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      const startedNotes = calls.filter(
        (call) =>
          call.method === "injectNote" &&
          typeof call.args[1] === "string" &&
          (call.args[1] as string).includes("loop started"),
      );
      expect(startedNotes.length).toBe(1);
      expect((startedNotes[0]!.args[1] as string)).toContain(LOOP_PROGRESS_MARKER);
      expect((startedNotes[0]!.args[1] as string)).toContain("3 rounds");
      expect((startedNotes[0]!.args[1] as string)).toContain("inherit");
    });

    it("does NOT inject loop-started note on round 2+", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask(); // dispatch round 1
      await c.onWorkerCompleted("task-1"); // push chain: dispatch round 2
      // onOriginIdle is now a no-op since push chain already advanced (phase=awaiting_worker)
      await c.onOriginIdle("origin-1");

      const startedNotes = calls.filter(
        (call) =>
          call.method === "injectNote" &&
          typeof call.args[1] === "string" &&
          (call.args[1] as string).includes("loop started"),
      );
      expect(startedNotes.length).toBe(1);
    });

    it("no-ops for unknown originSessionId", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      await c.onOriginIdle("nonexistent");

      expect(calls.filter((c) => c.method === "dispatchRound").length).toBe(0);
    });

    it("registers terminated listener after dispatching round 1", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      const regCalls = calls.filter(
        (call) => call.method === "registerTerminatedListener",
      );
      expect(regCalls.length).toBe(1);
      expect(regCalls[0]!.args[0]).toBe("task-1");
      // args[1] is the callback function
      expect(typeof regCalls[0]!.args[1]).toBe("function");
    });
  });

  describe("self-driving push chain", () => {
    it("triggers onWorkerCompleted via terminated listener and advances phase", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      const state1 = c.getLoopState("origin-1")!;
      expect(state1.phase).toBe("awaiting_worker");

      // Capture the registered terminated listener callback
      const regCalls = calls.filter(
        (call) => call.method === "registerTerminatedListener",
      );
      const listener = regCalls[0]!.args[1] as (
        taskId: string,
        status: string,
      ) => void;

      // Invoke the listener (simulating DispatchManager firing terminated event).
      // The callback calls onWorkerCompleted fire-and-forget, so we yield
      // to drain the microtask queue before checking state.
      listener("task-1", "completed");
      await new Promise((r) => setTimeout(r, 0));

      const state2 = c.getLoopState("origin-1")!;
      // Push chain: listener -> onWorkerCompleted -> _advanceFromSummarizing -> dispatch round 2
      expect(state2.phase).toBe("awaiting_worker");
      expect(state2.current).toBe(2);
      expect(state2.activeWorkerTaskId).toBe("task-2");

      // Also verify getRoundResult was called (push chain started)
      const getResultCalls = calls.filter(
        (call) => call.method === "getRoundResult",
      );
      expect(getResultCalls.length).toBe(1);
      expect(getResultCalls[0]!.args[0]).toBe("task-1");
    });

    it("error in push chain calls failLoop", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      // Make getRoundResult throw to simulate push-chain error
      const mockGetResult = adapter.getRoundResult as ReturnType<typeof mock>;
      mockGetResult.mockImplementation(async () => {
        throw new Error("push-chain boom");
      });

      await c.onWorkerCompleted("task-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("error");
      expect(state.errorReason).toContain("push-chain boom");

      // failLoop injects an error note
      const injectCalls = calls.filter((c) => c.method === "injectNote");
      const errorNote = injectCalls.find(
        (c) =>
          typeof c.args[1] === "string" &&
          (c.args[1] as string).includes("push-chain boom"),
      );
      expect(errorNote).not.toBeUndefined();
    });
  });

  describe("onWorkerCompleted", () => {
    it("transitions awaiting_worker through push chain to next round", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      const state1 = c.getLoopState("origin-1")!;
      expect(state1.phase).toBe("awaiting_worker");

      await c.onWorkerCompleted("task-1");

      const state2 = c.getLoopState("origin-1")!;
      // Push chain: onWorkerCompleted → _advanceFromSummarizing → dispatch round 2
      expect(state2.phase).toBe("awaiting_worker");
      expect(state2.activeWorkerTaskId).toBe("task-2");
      expect(state2.activeWorkerSessionId).toBe("session-2");
      expect(state2.current).toBe(2);

      const getResultCall = calls.find(
        (call) => call.method === "getRoundResult",
      );
      expect(getResultCall).not.toBeUndefined();
      expect(getResultCall!.args[0]).toBe("task-1");
    });

    it("transitions to error phase when worker fails", async () => {
      const { adapter, calls } = createFakeAdapter({
        getRoundResultResult: {
          text: "",
          hadError: true,
          errorReason: "boom",
        },
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();
      await c.onWorkerCompleted("task-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("error");
      expect(state.errorReason).toBe("boom");

      const injectCalls = calls.filter((call) => call.method === "injectNote");
      const errorNote = injectCalls.find(
        (c) => typeof c.args[1] === "string" && (c.args[1] as string).includes("boom"),
      );
      expect(errorNote).not.toBeUndefined();
      expect((errorNote!.args[1] as string)).toContain(LOOP_PROGRESS_MARKER);
      expect((errorNote!.args[1] as string)).toContain("boom");
    });

    it("no-ops for unknown workerTaskId", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      await c.onWorkerCompleted("nonexistent");

      expect(calls.filter((c) => c.method === "getRoundResult").length).toBe(0);
    });

    it("no-ops if phase is not awaiting_worker", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      // Still in activating phase, not awaiting_worker
      await c.onWorkerCompleted("task-1");

      expect(calls.filter((c) => c.method === "getRoundResult").length).toBe(0);
    });
  });

  describe("push-chain advance through summarizing", () => {
    it("captures summary and advances to next round", async () => {
      const { adapter, calls } = createFakeAdapter({
        readOriginSummaryResult: "Round 1 output summary.",
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // iterations=3
      await flushMicrotask(); // self-start → dispatch round 1
      await c.onWorkerCompleted("task-1"); // push chain: summarize → dispatch round 2

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.current).toBe(2);
      expect(state.lastSummary).toBe("Round 1 output summary.");

      // Should have dispatched round 2 (via push chain, no onOriginIdle needed)
      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(2);

      // Round 2 prompt should include seed
      const round2Input = dispatchCalls[1]!.args[0] as { prompt: string };
      expect(round2Input.prompt).toContain("Round 1 output summary.");
      expect(round2Input.prompt).toContain("---");
      expect(round2Input.prompt).toContain("Do the thing");
    });

    it("does not prepend seed in fresh mode", async () => {
      const { adapter, calls } = createFakeAdapter({
        readOriginSummaryResult: "Round 1 output summary.",
      });
      const c = new LoopCoordinator(adapter);

      c.register({
        ...REGISTER_INPUT,
        mode: "fresh",
      });
      await flushMicrotask(); // self-start → dispatch round 1
      await c.onWorkerCompleted("task-1"); // push chain: summarize → dispatch round 2

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(2);

      const round2Input = dispatchCalls[1]!.args[0] as { prompt: string };
      expect(round2Input.prompt).toBe("Do the thing");
      expect(round2Input.prompt).not.toContain("---");
    });
  });

  describe("iterations control", () => {
    it("iterations=1 runs one worker round then completes", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, iterations: 1 });
      await flushMicrotask(); // self-start → dispatch
      await c.onWorkerCompleted("task-1"); // push chain: summarize → finalize (current 2 > total 1)

      // onOriginIdle is a no-op (phase is already complete)
      await c.onOriginIdle("origin-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(2);

      const injectCalls = calls.filter((call) => call.method === "injectNote");
      const completeNote = injectCalls.find(
        (c) => typeof c.args[1] === "string" && (c.args[1] as string).includes("loop complete"),
      );
      expect(completeNote).not.toBeUndefined();
      expect((completeNote!.args[1] as string)).toContain("loop complete");
    });

    it("iterations=3 runs three worker+summary cycles", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // iterations=3

      // Round 1 — self-start then onWorkerCompleted push-chains round 2
      await flushMicrotask(); // self-start → dispatch
      await c.onWorkerCompleted("task-1"); // push chain: dispatch round 2
      await c.onOriginIdle("origin-1"); // no-op (phase=awaiting_worker)

      // Round 2 — onWorkerCompleted push-chains round 3
      await c.onWorkerCompleted("task-2"); // push chain: dispatch round 3
      await c.onOriginIdle("origin-1"); // no-op (phase=awaiting_worker)

      // Round 3 — onWorkerCompleted push-chains finalize
      await c.onWorkerCompleted("task-3"); // push chain: finalize complete
      await c.onOriginIdle("origin-1"); // no-op (phase=complete)

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(3);

      const injectCalls = calls.filter((call) => call.method === "injectNote");
      const completeNote = injectCalls.find(
        (c) => typeof c.args[1] === "string" && (c.args[1] as string).includes("loop complete"),
      );
      expect(completeNote).not.toBeUndefined();
      expect((completeNote!.args[1] as string)).toContain("loop complete");
    });
  });

  describe("cancellation", () => {
    it("requestCancel sets flag", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      c.requestCancel("origin-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.cancelRequested).toBe(true);
    });

    it("cancel during summarizing finalizes as cancelled via push chain", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask(); // self-start → dispatch round 1
      // Cancel BEFORE onWorkerCompleted. The push chain inside onWorkerCompleted
      // will check cancelRequested in _advanceFromSummarizing → handleSummary and
      // finalize as cancelled instead of dispatching the next round.
      c.requestCancel("origin-1");
      await c.onWorkerCompleted("task-1"); // push chain: sees cancelRequested → finalize cancelled

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("cancelled");

      const injectCalls = calls.filter((call) => call.method === "injectNote");
      const cancelNote = injectCalls.find(
        (c) => typeof c.args[1] === "string" && (c.args[1] as string).includes("loop cancelled"),
      );
      expect(cancelNote).not.toBeUndefined();
      expect((cancelNote!.args[1] as string)).toContain("loop cancelled");
    });

    it("cancelNow removes terminated listener and cancels round", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();
      expect(c.getLoopState("origin-1")!.phase).toBe("awaiting_worker");

      // Clear prior calls so we isolate cancelNow side effects
      calls.length = 0;

      await c.cancelNow("origin-1");

      // removeTerminatedListener should be called for cleanup
      const remCalls = calls.filter(
        (call) => call.method === "removeTerminatedListener",
      );
      expect(remCalls.length).toBe(1);
      expect(remCalls[0]!.args[0]).toBe("task-1");
      expect(typeof remCalls[0]!.args[1]).toBe("function");

      // cancelNow also cancels the active round
      const cancelCalls = calls.filter(
        (call) => call.method === "cancelRound",
      );
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0]!.args[0]).toBe("task-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("cancelled");
    });
  });

  describe("re-entrancy lock", () => {
    it("prevents overlapping transitions on same origin", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      // Self-start via microtask
      await flushMicrotask();

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("awaiting_worker");

      // Push chain: onWorkerCompleted chains into _advanceFromSummarizing,
      // which dispatches round 2.
      await c.onWorkerCompleted("task-1");

      // Fire two onOriginIdle calls concurrently (both are no-ops now)
      await Promise.all([
        c.onOriginIdle("origin-1"),
        c.onOriginIdle("origin-1"),
      ]);

      // Should have advanced exactly once to round 2 (via push chain)
      expect(state.current).toBe(2);
    });
  });

  describe("isActiveLoopOrigin", () => {
    it("returns true for non-terminal phases", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      expect(c.isActiveLoopOrigin("origin-1")).toBe(true);
    });

    it("returns false for terminal phases", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, iterations: 1 });
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: finalize complete
      await c.onOriginIdle("origin-1"); // no-op (phase is complete)

      expect(c.isActiveLoopOrigin("origin-1")).toBe(false);
    });

    it("returns false for unknown session", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      expect(c.isActiveLoopOrigin("nonexistent")).toBe(false);
    });
  });

  describe("isLoopSession", () => {
    it("returns true for origin session", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      expect(c.isLoopSession("origin-1")).toBe(true);
    });

    it("returns true for active worker session", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      expect(c.isLoopSession("session-1")).toBe(true);
    });

    it("returns false for unknown session", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      expect(c.isLoopSession("nonexistent")).toBe(false);
    });
  });

  describe("failSession", () => {
    it("fails loop via origin session ID", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      const before = c.getLoopState("origin-1")!;
      expect(before.phase).toBe("awaiting_worker");

      await c.failSession("origin-1", "something went wrong");

      const after = c.getLoopState("origin-1")!;
      expect(after.phase).toBe("error");
      expect(after.errorReason).toMatch(/something went wrong/);
    });

    it("no-ops when loop is already terminal", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, iterations: 1 });
      await flushMicrotask();
      await c.onWorkerCompleted("task-1");
      await new Promise((r) => setTimeout(r, 0));

      const before = c.getLoopState("origin-1")!;
      expect(before.phase).toBe("complete");

      await c.failSession("origin-1", "too late");

      const after = c.getLoopState("origin-1")!;
      expect(after.phase).toBe("complete");
      expect(after.errorReason).toBeUndefined();
    });

    it("falls back via _workerToOrigin when called with worker task ID", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      // After dispatch, _workerToOrigin maps task-1 → origin-1
      // Calling failSession with the task ID triggers the fallback
      await c.failSession("task-1", "worker error");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("error");
      expect(state.errorReason).toMatch(/worker error/);
    });

    it("no-ops for unknown session with no _workerToOrigin mapping", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      // "unknown-42" is not an origin session, worker task, or worker session
      // The fallback returns undefined → no-op
      await c.failSession("unknown-42", "nobody home");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).not.toBe("error");
    });
  });

  describe("getAllLoopStates", () => {
    it("returns a copy of all loops", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      c.register({
        originSessionId: "origin-2",
        agent: "agent-2",
        prompt: "task 2",
        mode: "fresh",
        iterations: 2,
      });

      const all = c.getAllLoopStates();
      expect(all.size).toBe(2);
      expect(all.has("origin-1")).toBe(true);
      expect(all.has("origin-2")).toBe(true);
    });
  });

  describe("getNonTerminalLoops", () => {
    it("filters out terminal loops", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, iterations: 1 });
      c.register({
        originSessionId: "origin-2",
        agent: "agent-2",
        prompt: "task 2",
        mode: "fresh",
        iterations: 5,
      });

      // Complete origin-1 (push chain finalizes on worker completion)
      await flushMicrotask();
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1"); // no-op

      const nonTerminal = c.getNonTerminalLoops();
      expect(nonTerminal.length).toBe(1);
      expect(nonTerminal[0]!.originSessionId).toBe("origin-2");
    });
  });

  describe("dispose", () => {
    it("clears all state", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      c.dispose();

      expect(c.getLoopState("origin-1")).toBeUndefined();
      expect(c.getAllLoopStates().size).toBe(0);
      expect(c.getNonTerminalLoops().length).toBe(0);
    });
  });

  describe("seed threading", () => {
    it("chains summaries across rounds", async () => {
      let summaryCount = 0;
      const { adapter } = createFakeAdapter({
        readOriginSummaryResult: "default",
      });

      // Override readOriginSummary to return incrementing summaries
      const origReadSummary = adapter.readOriginSummary;
      (adapter as Record<string, unknown>).readOriginSummary = mock(
        async () => {
          summaryCount += 1;
          return `Summary for round ${summaryCount}.`;
        },
      );

      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // iterations=3

      // Round 1: onWorkerCompleted push-chains round 2
      await flushMicrotask();
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1"); // no-op

      // Round 2: onWorkerCompleted push-chains round 3
      await c.onWorkerCompleted("task-2");
      await c.onOriginIdle("origin-1"); // no-op

      // Round 3: onWorkerCompleted push-chains finalize
      await c.onWorkerCompleted("task-3");
      await c.onOriginIdle("origin-1"); // no-op

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.lastSummary).toBe("Summary for round 3.");

      // Verify seed was threaded: dispatch calls for rounds 2 and 3
      // should have included previous summary
      const dispatchCalls = (
        adapter.dispatchRound as ReturnType<typeof mock>
      ).mock.calls;
      expect(dispatchCalls.length).toBe(3);

      // Round 2 prompt should have round 1 summary
      const round2Args = dispatchCalls[1] as [
        { prompt: string },
      ];
      expect(round2Args[0].prompt).toContain("Summary for round 1.");

      // Round 3 prompt should have round 2 summary
      const round3Args = dispatchCalls[2] as [
        { prompt: string },
      ];
      expect(round3Args[0].prompt).toContain("Summary for round 2.");
    });
  });

  describe("summary capture", () => {
    it("round 1 has no seed or boundary after register", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);

      const state = c.getLoopState("origin-1")!;
      expect(state.lastSummary).toBeUndefined();
      expect(state.summaryBoundaryMessageId).toBeUndefined();
    });

    it("records summaryBoundaryMessageId before push chain advances", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: sets boundary, then dispatches round 2

      const state = c.getLoopState("origin-1")!;
      expect(state.summaryBoundaryMessageId).toBe("msg-1");

      const lastMsgIdCalls = calls.filter(
        (call) => call.method === "getLastMessageId",
      );
      expect(lastMsgIdCalls.length).toBe(1);
      expect(lastMsgIdCalls[0]!.args[0]).toBe("origin-1");
    });

    it("passes sinceMessageId boundary to readOriginSummary via push chain", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();        // self-start → dispatch
      await c.onWorkerCompleted("task-1");     // push chain: summarize + advance (boundary=msg-1)
      await c.onOriginIdle("origin-1");        // no-op

      const readCalls = calls.filter(
        (call) => call.method === "readOriginSummary",
      );
      expect(readCalls.length).toBe(1);
      expect(readCalls[0]!.args[0]).toBe("origin-1");
      expect(readCalls[0]!.args[1]).toBe("msg-1");
    });

    it("only captures summary after boundary across rounds", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // iterations=3

      // Round 1: boundary=msg-1, push chain reads summary with sinceMessageId=msg-1
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: dispatch round 2
      await c.onOriginIdle("origin-1"); // no-op

      // Round 2: boundary=msg-2, push chain reads summary with sinceMessageId=msg-2
      await c.onWorkerCompleted("task-2"); // push chain: dispatch round 3
      await c.onOriginIdle("origin-1"); // no-op

      // Round 3: boundary=msg-3
      await c.onWorkerCompleted("task-3"); // push chain: finalize complete
      await c.onOriginIdle("origin-1"); // no-op

      // Each readOriginSummary should have a distinct sinceMessageId
      const readCalls = calls.filter(
        (call) => call.method === "readOriginSummary",
      );
      expect(readCalls.length).toBe(3);
      expect(readCalls[0]!.args[1]).toBe("msg-1");
      expect(readCalls[1]!.args[1]).toBe("msg-2");
      expect(readCalls[2]!.args[1]).toBe("msg-3");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);
    });

    it("caps lastSummary at SEED_CHAR_CAP", async () => {
      const longSummary = "x".repeat(SEED_CHAR_CAP + 500);
      const { adapter } = createFakeAdapter({
        readOriginSummaryResult: longSummary,
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: caps summary
      await c.onOriginIdle("origin-1"); // no-op

      const state = c.getLoopState("origin-1")!;
      expect(state.lastSummary!.length).toBe(SEED_CHAR_CAP);
      // tail slice: should contain the last SEED_CHAR_CAP chars
      expect(state.lastSummary).toBe("x".repeat(SEED_CHAR_CAP));
    });

    it("inherit mode threads seed with boundary-isolated summary", async () => {
      const { adapter, calls } = createFakeAdapter({
        readOriginSummaryResult: "isolated round 1 result.",
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // mode=inherit, iterations=3
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: captures summary, dispatches round 2 with seed
      await c.onOriginIdle("origin-1"); // no-op

      const state = c.getLoopState("origin-1")!;
      expect(state.lastSummary).toBe("isolated round 1 result.");

      // Round 2 dispatch should include seed
      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(2);
      const round2Input = dispatchCalls[1]!.args[0] as { prompt: string };
      expect(round2Input.prompt).toContain("isolated round 1 result.");
      expect(round2Input.prompt).toContain("---");
      expect(round2Input.prompt).toContain("Do the thing");
    });

    it("fresh mode does not thread seed and still records boundary", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, mode: "fresh" });
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: captures summary, dispatches round 2 without seed
      await c.onOriginIdle("origin-1"); // no-op

      const state = c.getLoopState("origin-1")!;
      // lastSummary is still captured (for monitoring/recovery)
      expect(state.lastSummary).not.toBeUndefined();

      // But round 2 dispatch should NOT include seed
      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(2);
      const round2Input = dispatchCalls[1]!.args[0] as { prompt: string };
      expect(round2Input.prompt).toBe("Do the thing");
      expect(round2Input.prompt).not.toContain("---");
    });

    it("passes the captured message boundary to readOriginSummary", async () => {
      const { adapter, calls } = createFakeAdapter({
        lastMessageId: "msg-boundary",
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await flushMicrotask();
      await c.onWorkerCompleted("task-1"); // push chain: uses msg-boundary for readOriginSummary
      await c.onOriginIdle("origin-1"); // no-op

      const readCalls = calls.filter(
        (call) => call.method === "readOriginSummary",
      );
      expect(readCalls.length).toBe(1);
      expect(readCalls[0]!.args[1]).toBe("msg-boundary");
    });
  });

  // ── New tests for self-driven semantics ───────────────────────────────

  describe("self-driven semantics", () => {
    it("self-start fires first round without onOriginIdle", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      // Do NOT call onOriginIdle — self-start microtask should fire autonomously
      await flushMicrotask();

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-1");

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(1);
    });

    it("self-start error propagation → phase: error", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      // Make dispatchRound throw during the self-start microtask
      const mockDispatch = adapter.dispatchRound as ReturnType<typeof mock>;
      mockDispatch.mockImplementation(async () => {
        throw new Error("self-start boom");
      });

      c.register(REGISTER_INPUT);
      await flushMicrotask();

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("error");
      expect(state.errorReason).toContain("self-start boom");

      // failLoop injects an error note
      const injectCalls = calls.filter((c) => c.method === "injectNote");
      const errorNote = injectCalls.find(
        (c) =>
          typeof c.args[1] === "string" &&
          (c.args[1] as string).includes("self-start boom"),
      );
      expect(errorNote).not.toBeUndefined();
    });

    it("reSubscribeListeners handles activating phase", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      // Simulate a restored loop stuck in activating phase
      c.restoreState({
        originSessionId: "recovered-activating",
        agent: "test-agent",
        basePrompt: "recover",
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

      await c.reSubscribeListeners();

      // reSubscribeListeners calls _kickoffFromActivating directly (not via microtask),
      // so the phase should be awaiting_worker after await returns.
      const state = c.getLoopState("recovered-activating")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-1");
    });

    it("onOriginIdle no-ops for activating phase", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);

      // Phase is still activating (microtask not yet fired)
      expect(c.getLoopState("origin-1")!.phase).toBe("activating");

      // Call onOriginIdle WITHOUT await to prove it runs synchronously as a no-op
      // (awaiting would drain microtasks and trigger the self-start kickoff)
      c.onOriginIdle("origin-1");
      // Phase should still be activating — onOriginIdle is a no-op
      expect(c.getLoopState("origin-1")!.phase).toBe("activating");

      // Only the self-start microtask advances the loop
      await flushMicrotask();
      expect(c.getLoopState("origin-1")!.phase).toBe("awaiting_worker");
    });
  });
});

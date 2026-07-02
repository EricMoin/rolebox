import { describe, it, expect, mock } from "bun:test";
import { LoopCoordinator } from "../../src/loop/coordinator";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";
import type { LoopState } from "../../src/loop/types";
import { LOOP_PROGRESS_MARKER } from "../../src/loop/constants";

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
  }>,
): { adapter: IDispatchAdapter; calls: FakeAdapterCall[] } {
  const calls: FakeAdapterCall[] = [];
  let taskCounter = 0;

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

    injectNote: mock(
      async (_sessionId: string, _text: string) => {
        calls.push({ method: "injectNote", args: [_sessionId, _text] });
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

  describe("onOriginIdle — activating", () => {
    it("dispatches round 1 and transitions to awaiting_worker", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");

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

    it("no-ops for unknown originSessionId", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      await c.onOriginIdle("nonexistent");

      expect(calls.filter((c) => c.method === "dispatchRound").length).toBe(0);
    });
  });

  describe("onWorkerCompleted", () => {
    it("transitions awaiting_worker → summarizing on success", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");

      const state1 = c.getLoopState("origin-1")!;
      expect(state1.phase).toBe("awaiting_worker");

      await c.onWorkerCompleted("task-1");

      const state2 = c.getLoopState("origin-1")!;
      expect(state2.phase).toBe("summarizing");
      expect(state2.activeWorkerTaskId).toBeUndefined();

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
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("error");
      expect(state.errorReason).toBe("boom");

      const injectCall = calls.find((call) => call.method === "injectNote");
      expect(injectCall).not.toBeUndefined();
      expect((injectCall!.args[1] as string)).toContain(LOOP_PROGRESS_MARKER);
      expect((injectCall!.args[1] as string)).toContain("boom");
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

  describe("onOriginIdle — summarizing", () => {
    it("captures summary and advances to next round", async () => {
      const { adapter, calls } = createFakeAdapter({
        readOriginSummaryResult: "Round 1 output summary.",
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // iterations=3
      await c.onOriginIdle("origin-1"); // activating → dispatch round 1
      await c.onWorkerCompleted("task-1"); // → summarizing
      await c.onOriginIdle("origin-1"); // summarizing → capture + advance

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.current).toBe(2);
      expect(state.lastSummary).toBe("Round 1 output summary.");

      // Should have dispatched round 2
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
      await c.onOriginIdle("origin-1"); // activating → dispatch round 1
      await c.onWorkerCompleted("task-1"); // → summarizing
      await c.onOriginIdle("origin-1"); // summarizing → capture + advance

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
      await c.onOriginIdle("origin-1"); // activating → dispatch
      await c.onWorkerCompleted("task-1"); // → summarizing
      await c.onOriginIdle("origin-1"); // summarizing → capture + finalize

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(2);

      const injectCall = calls.find((call) => call.method === "injectNote");
      expect(injectCall).not.toBeUndefined();
      expect((injectCall!.args[1] as string)).toContain("loop complete");
    });

    it("iterations=3 runs three worker+summary cycles", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT); // iterations=3

      // Round 1
      await c.onOriginIdle("origin-1"); // activating → dispatch
      await c.onWorkerCompleted("task-1"); // → summarizing
      await c.onOriginIdle("origin-1"); // capturing → dispatch round 2

      // Round 2
      await c.onWorkerCompleted("task-2"); // → summarizing
      await c.onOriginIdle("origin-1"); // capturing → dispatch round 3

      // Round 3
      await c.onWorkerCompleted("task-3"); // → summarizing
      await c.onOriginIdle("origin-1"); // capturing → finalize

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(3);

      const injectCall = calls.find((call) => call.method === "injectNote");
      expect(injectCall).not.toBeUndefined();
      expect((injectCall!.args[1] as string)).toContain("loop complete");
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

    it("cancel during summarizing finalizes as cancelled", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1"); // activating → dispatch
      await c.onWorkerCompleted("task-1"); // → summarizing
      c.requestCancel("origin-1");
      await c.onOriginIdle("origin-1"); // summarizing → finalize

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("cancelled");

      const injectCall = calls.find((call) => call.method === "injectNote");
      expect(injectCall).not.toBeUndefined();
      expect((injectCall!.args[1] as string)).toContain("loop cancelled");
    });
  });

  describe("re-entrancy lock", () => {
    it("prevents overlapping transitions on same origin", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);

      // Fire two onOriginIdle calls concurrently
      await Promise.all([
        c.onOriginIdle("origin-1"),
        c.onOriginIdle("origin-1"),
      ]);

      // Only one dispatch should have happened
      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("awaiting_worker");

      // Also verify re-entrancy on onWorkerCompleted
      await c.onWorkerCompleted("task-1"); // → summarizing

      // Fire two onOriginIdle + onWorkerCompleted concurrently
      await Promise.all([
        c.onOriginIdle("origin-1"),
        c.onOriginIdle("origin-1"),
      ]);

      // Should have advanced exactly once to round 2
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
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

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
      await c.onOriginIdle("origin-1");

      expect(c.isLoopSession("session-1")).toBe(true);
    });

    it("returns false for unknown session", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      expect(c.isLoopSession("nonexistent")).toBe(false);
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

      // Complete origin-1
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

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

      // Round 1
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

      // Round 2
      await c.onWorkerCompleted("task-2");
      await c.onOriginIdle("origin-1");

      // Round 3
      await c.onWorkerCompleted("task-3");
      await c.onOriginIdle("origin-1");

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
});

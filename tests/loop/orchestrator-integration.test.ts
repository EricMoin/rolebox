import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { LoopCoordinator, shouldCancelLoop } from "../../src/loop/coordinator";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter";
import type { LoopState, LoopMode } from "../../src/loop/types";
import { LoopStore } from "../../src/loop/loop-store";
import { LOOP_PROGRESS_MARKER, SEED_CHAR_CAP } from "../../src/loop/constants";
import {
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
} from "../../src/dispatch/notification";
import {
  activeLoopManager,
  pendingCorrections,
  userMessagedSessions,
  loopManagerMap,
  managerMap,
  createPluginHooks,
} from "../../src/core/composition";

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
        calls.push({ method: "dispatchRound", args: [_input] });
        return (
          overrides?.dispatchRoundResult ?? {
            workerTaskId: taskId,
            workerSessionId: `session-${taskCounter}`,
          }
        );
      },
    ),

    getRoundResult: mock(async (_workerTaskId: string) => {
      calls.push({ method: "getRoundResult", args: [_workerTaskId] });
      return (
        overrides?.getRoundResultResult ?? {
          text: "worker output",
          hadError: false,
        }
      );
    }),

    cancelRound: mock(async (_workerTaskId: string) => {
      calls.push({ method: "cancelRound", args: [_workerTaskId] });
    }),

    readOriginSummary: mock(
      async (_originSessionId: string, _sinceMessageId?: string) => {
        calls.push({
          method: "readOriginSummary",
          args: [_originSessionId, _sinceMessageId],
        });
        return (
          overrides?.readOriginSummaryResult ??
          "Round summary: completed successfully."
        );
      },
    ),

    getLastMessageId: mock(async (_originSessionId: string) => {
      calls.push({ method: "getLastMessageId", args: [_originSessionId] });
      if (overrides?.lastMessageId !== undefined) {
        return overrides.lastMessageId;
      }
      msgIdCounter += 1;
      return `msg-${msgIdCounter}`;
    }),

    injectNote: mock(async (_sessionId: string, _text: string) => {
      calls.push({ method: "injectNote", args: [_sessionId, _text] });
    }),
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

const AGENT = "test-agent";

// ── Plugin mock client (minimal) ─────────────────────────────────────────

function pluginMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-child" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({
          data: { parts: [{ type: "text", text: "ok" }] },
          error: undefined,
        }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: "test" }, error: undefined }),
      ),
      delete: mock(() =>
        Promise.resolve({ data: true, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Orchestrator Integration", () => {
  beforeEach(() => {
    mock.restore();
  });

  // ── Scenario 1: |loop:1| runs one worker round then completes ────────

  describe("Scenario 1: |loop:1| single round → complete", () => {
    it("activates via onOriginIdle, dispatches once, completes after summary", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, iterations: 1 });
      const initial = c.getLoopState("origin-1")!;
      expect(initial.phase).toBe("activating");
      expect(initial.current).toBe(1);

      await c.onOriginIdle("origin-1");

      const afterActivate = c.getLoopState("origin-1")!;
      expect(afterActivate.phase).toBe("awaiting_worker");
      expect(afterActivate.activeWorkerTaskId).toBe("task-1");
      expect(afterActivate.activeWorkerSessionId).toBe("session-1");

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(1);

      await c.onWorkerCompleted("task-1");

      const afterWorker = c.getLoopState("origin-1")!;
      expect(afterWorker.phase).toBe("summarizing");
      expect(afterWorker.activeWorkerTaskId).toBeUndefined();

      await c.onOriginIdle("origin-1");

      const final = c.getLoopState("origin-1")!;
      expect(final.phase).toBe("complete");
      expect(final.current).toBe(2);

      const allDispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(allDispatchCalls.length).toBe(1);

      const injectCalls = calls.filter(
        (call) => call.method === "injectNote",
      );
      const completeInject = injectCalls.find((call) =>
        (call.args[1] as string).includes("loop complete"),
      );
      expect(completeInject).not.toBeUndefined();
    });

    it("no-ops onOriginIdle for terminal phase", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, iterations: 1 });
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

      const preCalls = calls.length;
      await c.onOriginIdle("origin-1");
      expect(calls.length).toBe(preCalls);
    });
  });

  // ── Scenario 2: |loop:3| inherit threads seeds ───────────────────────

  describe("Scenario 2: |loop:3| inherit seeds", () => {
    it("threads round K summary into round K+1 prompt", async () => {
      const { adapter, calls } = createFakeAdapter({
        readOriginSummaryResult:
          "Round 1 summary: fixed bug in auth module.",
      });

      let summaryCallCount = 0;
      const summaries = [
        "Round 1 summary: fixed auth bug.",
        "Round 2 summary: added tests for auth.",
        "Round 3 summary: all auth work complete.",
      ];
      const origReadSummary = adapter.readOriginSummary;
      (adapter as Record<string, unknown>).readOriginSummary = mock(
        async () => {
          const s = summaries[summaryCallCount % summaries.length]!;
          summaryCallCount += 1;
          return s;
        },
      );

      const c = new LoopCoordinator(adapter);
      c.register(REGISTER_INPUT);

      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

      await c.onWorkerCompleted("task-2");
      await c.onOriginIdle("origin-1");

      await c.onWorkerCompleted("task-3");
      await c.onOriginIdle("origin-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");
      expect(state.current).toBe(4);

      // Exactly 3 dispatches
      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(3);

      const r1Input = dispatchCalls[0]!.args[0] as { prompt: string };
      expect(r1Input.prompt).toBe("Do the thing");

      const r2Input = dispatchCalls[1]!.args[0] as { prompt: string };
      expect(r2Input.prompt).toContain("Round 1 summary: fixed auth bug.");
      expect(r2Input.prompt).toContain("---");
      expect(r2Input.prompt).toContain("Do the thing");

      const r3Input = dispatchCalls[2]!.args[0] as { prompt: string };
      expect(r3Input.prompt).toContain("Round 2 summary: added tests for auth.");
      expect(r3Input.prompt).toContain("---");
      expect(r3Input.prompt).toContain("Do the thing");
    });

    it("exactly 3 dispatches for 3-round inherit loop", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);
      c.register(REGISTER_INPUT);

      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

      await c.onWorkerCompleted("task-2");
      await c.onOriginIdle("origin-1");

      await c.onWorkerCompleted("task-3");
      await c.onOriginIdle("origin-1");

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(3);
      expect(c.getLoopState("origin-1")!.phase).toBe("complete");
    });
  });

  // ── Scenario 3: |loop:2| fresh does not thread seeds ─────────────────

  describe("Scenario 3: |loop:2| fresh no seeds", () => {
    it("each round prompt equals basePrompt with no seed threading", async () => {
      const { adapter, calls } = createFakeAdapter({
        readOriginSummaryResult: "Round 1 output: done.",
      });
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, mode: "fresh", iterations: 2 });

      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

      await c.onWorkerCompleted("task-2");
      await c.onOriginIdle("origin-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("complete");

      const dispatchCalls = calls.filter(
        (call) => call.method === "dispatchRound",
      );
      expect(dispatchCalls.length).toBe(2);

      const r1Input = dispatchCalls[0]!.args[0] as { prompt: string };
      expect(r1Input.prompt).toBe("Do the thing");

      const r2Input = dispatchCalls[1]!.args[0] as { prompt: string };
      expect(r2Input.prompt).toBe("Do the thing");
      expect(r2Input.prompt).not.toContain("---");
      expect(r2Input.prompt).not.toContain("Round 1 output");
    });

    it("still captures lastSummary for monitoring (fresh mode)", async () => {
      const { adapter } = createFakeAdapter({
        readOriginSummaryResult: "fresh round summary.",
      });
      const c = new LoopCoordinator(adapter);

      c.register({ ...REGISTER_INPUT, mode: "fresh", iterations: 2 });
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");
      await c.onOriginIdle("origin-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.lastSummary).toBe("fresh round summary.");
    });
  });

  // ── Scenario 4: Cancellation during awaiting_worker ──────────────────

  describe("Scenario 4: Cancellation during awaiting_worker", () => {
    it("cancelRequested during awaiting_worker finalizes as cancelled after worker completes", async () => {
      const { adapter, calls } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");

      expect(c.getLoopState("origin-1")!.phase).toBe("awaiting_worker");

      c.requestCancel("origin-1");
      expect(c.getLoopState("origin-1")!.cancelRequested).toBe(true);

      await c.onWorkerCompleted("task-1");

      const afterWorker = c.getLoopState("origin-1")!;
      expect(afterWorker.phase).toBe("summarizing");

      await c.onOriginIdle("origin-1");

      const final = c.getLoopState("origin-1")!;
      expect(final.phase).toBe("cancelled");

      const injectCalls = calls.filter(
        (call) => call.method === "injectNote",
      );
      const cancelInject = injectCalls.find((call) =>
        (call.args[1] as string).includes("loop cancelled"),
      );
      expect(cancelInject).not.toBeUndefined();
    });

    it("cancelRequested between rounds (after summary) finalizes as cancelled", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);

      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");

      c.requestCancel("origin-1");

      await c.onOriginIdle("origin-1");

      expect(c.getLoopState("origin-1")!.phase).toBe("cancelled");
    });
  });

  // ── Scenario 5: System re-prompt during summarizing does NOT cancel ──

  describe("Scenario 5: System re-prompt during summarizing does NOT cancel", () => {
    it("shouldCancelOnUserMessage returns false for dispatch marker during summarizing", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");

      const systemText = `${DISPATCH_COMPLETION_MARKER} task done`;
      const result = c.shouldCancelOnUserMessage("origin-1", systemText);
      expect(result).toBe(false);
      expect(c.getLoopState("origin-1")!.cancelRequested).toBe(false);
    });

    it("shouldCancelLoop returns false for dispatch markers in any phase", () => {
      const loop: LoopState = {
        originSessionId: "test",
        agent: "a",
        basePrompt: "p",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "awaiting_worker",
        cancelRequested: false,
        startedAt: 1,
        updatedAt: 1,
        roundStartedAt: 1,
        schemaVersion: 1,
      };

      expect(shouldCancelLoop(loop, DISPATCH_COMPLETION_MARKER)).toBe(false);
      expect(shouldCancelLoop(loop, DISPATCH_ALL_COMPLETE_MARKER)).toBe(false);
      expect(shouldCancelLoop(loop, DISPATCH_RECOVERY_MARKER)).toBe(false);
      expect(
        shouldCancelLoop(
          loop,
          `<system-reminder>\n${DISPATCH_COMPLETION_MARKER}\n...`,
        ),
      ).toBe(false);
    });

    it("shouldCancelLoop returns false for summarizing phase with any text", () => {
      const loop: LoopState = {
        originSessionId: "test",
        agent: "a",
        basePrompt: "p",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "summarizing",
        cancelRequested: false,
        startedAt: 1,
        updatedAt: 1,
        roundStartedAt: 1,
        schemaVersion: 1,
      };

      expect(shouldCancelLoop(loop, "stop the loop")).toBe(false);
      expect(shouldCancelLoop(loop, "cancel")).toBe(false);
    });

    it("shouldCancelLoop returns false for activating phase", () => {
      const loop: LoopState = {
        originSessionId: "test",
        agent: "a",
        basePrompt: "p",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "activating",
        cancelRequested: false,
        startedAt: 1,
        updatedAt: 1,
        roundStartedAt: 1,
        schemaVersion: 1,
      };

      expect(shouldCancelLoop(loop, "stop")).toBe(false);
    });

    it("shouldCancelLoop returns false for terminal phases", () => {
      const terminalPhases = [
        "complete",
        "cancelled",
        "error",
        "interrupted",
      ] as const;
      for (const phase of terminalPhases) {
        const loop: LoopState = {
          originSessionId: "test",
          agent: "a",
          basePrompt: "p",
          mode: "inherit",
          total: 3,
          current: 1,
          phase,
          cancelRequested: false,
          startedAt: 1,
          updatedAt: 1,
          roundStartedAt: 1,
          schemaVersion: 1,
        };
        expect(shouldCancelLoop(loop, "stop")).toBe(false);
      }
    });

    it("shouldCancelOnUserMessage returns false for unknown session", () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      const result = c.shouldCancelOnUserMessage(
        "nonexistent",
        "stop the loop",
      );
      expect(result).toBe(false);
    });
  });

  // ── Scenario 6: Worker error stops the loop ──────────────────────────

  describe("Scenario 6: Worker error stops loop", () => {
    it("transitions to error phase and injects error note", async () => {
      const { adapter, calls } = createFakeAdapter({
        getRoundResultResult: {
          text: "",
          hadError: true,
          errorReason: "worker crash",
        },
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");

      const state = c.getLoopState("origin-1")!;
      expect(state.phase).toBe("error");
      expect(state.errorReason).toBe("worker crash");

      const injectCalls = calls.filter(
        (call) => call.method === "injectNote",
      );
      expect(injectCalls.length).toBeGreaterThanOrEqual(1);
      const errorInject = injectCalls.find((call) =>
        (call.args[1] as string).includes("error"),
      );
      expect(errorInject).not.toBeUndefined();
      expect((errorInject!.args[1] as string)).toContain(LOOP_PROGRESS_MARKER);
      expect((errorInject!.args[1] as string)).toContain("worker crash");
    });

    it("no further dispatch after error", async () => {
      const { adapter, calls } = createFakeAdapter({
        getRoundResultResult: {
          text: "",
          hadError: true,
          errorReason: "fatal",
        },
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");

      const preDispatchCount = calls.filter(
        (call) => call.method === "dispatchRound",
      ).length;
      await c.onOriginIdle("origin-1");

      const postDispatchCount = calls.filter(
        (call) => call.method === "dispatchRound",
      ).length;
      expect(postDispatchCount).toBe(preDispatchCount);
    });

    it("isActiveLoopOrigin returns false for error phase", async () => {
      const { adapter } = createFakeAdapter({
        getRoundResultResult: {
          text: "",
          hadError: true,
          errorReason: "fatal",
        },
      });
      const c = new LoopCoordinator(adapter);

      c.register(REGISTER_INPUT);
      await c.onOriginIdle("origin-1");
      await c.onWorkerCompleted("task-1");

      expect(c.isActiveLoopOrigin("origin-1")).toBe(false);
    });
  });

  // ── Scenario 7: Nested-loop rejection ────────────────────────────────

  describe("Scenario 7: Nested-loop rejection", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-oi-nested-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks({ resolvedRoles: [], client, roleFunctionsMap: new Map(), roleGraphMap: new Map(), directory: tmpDir });
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("isLoopSession returns true for worker session (basis for nested loop detection)", async () => {
      expect(activeLoopManager).not.toBeUndefined();

      activeLoopManager!.register({
        originSessionId: "origin-nested",
        agent: AGENT,
        prompt: "run the loop",
        mode: "fresh",
        iterations: 3,
      });

      await activeLoopManager!.onOriginIdle("origin-nested");
      const loop = activeLoopManager!.getLoopState("origin-nested")!;
      const workerSessionId = loop.activeWorkerSessionId!;

      expect(activeLoopManager!.isLoopSession("origin-nested")).toBe(true);
      expect(workerSessionId).toBeTruthy();
      expect(activeLoopManager!.isLoopSession(workerSessionId)).toBe(true);
      expect(activeLoopManager!.isLoopSession("nonexistent")).toBe(false);
    });

    it("rejects |loop| activation on an active loop origin session", async () => {
      activeLoopManager!.register({
        originSessionId: "origin-reject",
        agent: AGENT,
        prompt: "run the loop",
        mode: "fresh",
        iterations: 2,
      });

      // Try activating another |loop| on the same origin session
      const output = {
        parts: [
          {
            type: "text" as const,
            text: "|loop:5| nested loop attempt",
          },
        ],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: "origin-reject" },
        output,
      );

      const correction = pendingCorrections.get("origin-reject");
      expect(correction).toContain("Nested loops are not supported");
    });
  });

  // ── Scenario 8: Crash/restart recovery ───────────────────────────────

  describe("Scenario 8: Crash/restart recovery", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-oi-recovery-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("recovers awaiting_worker with running worker → stays awaiting_worker", async () => {
      const store = new LoopStore(tmpDir);

      const persisted: LoopState = {
        originSessionId: "origin-rec-1",
        agent: "test-agent",
        basePrompt: "recover me",
        mode: "inherit",
        total: 3,
        current: 2,
        phase: "awaiting_worker",
        activeWorkerTaskId: "task-abc",
        activeWorkerSessionId: "session-abc",
        lastSummary: "previous summary",
        cancelRequested: false,
        startedAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
        roundStartedAt: Date.now() - 30000,
        schemaVersion: 1,
      };

      const loops = new Map<string, LoopState>();
      loops.set("origin-rec-1", persisted);
      await store.save(loops);

      const loaded = store.load()!;
      expect(loaded.size).toBe(1);

      const reconciled = await store.reconcile(loaded, async (_taskId) => ({
        status: "running",
        exists: true,
      }));

      expect(reconciled.size).toBe(1);
      const state = reconciled.get("origin-rec-1")!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-abc");
    });

    it("recovers awaiting_worker with completed worker → summarizing", async () => {
      const store = new LoopStore(tmpDir);

      const persisted: LoopState = {
        originSessionId: "origin-rec-2",
        agent: "test-agent",
        basePrompt: "recover me",
        mode: "fresh",
        total: 2,
        current: 1,
        phase: "awaiting_worker",
        activeWorkerTaskId: "task-done",
        activeWorkerSessionId: "session-done",
        cancelRequested: false,
        startedAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
        roundStartedAt: Date.now() - 30000,
        schemaVersion: 1,
      };

      const loops = new Map<string, LoopState>();
      loops.set("origin-rec-2", persisted);
      await store.save(loops);

      const loaded = store.load()!;
      await store.reconcile(loaded, async (_taskId) => ({
        status: "completed",
        exists: true,
      }));

      const state = loaded.get("origin-rec-2")!;
      expect(state.phase).toBe("summarizing");
    });

    it("recovers awaiting_worker with lost worker → interrupted", async () => {
      const store = new LoopStore(tmpDir);

      const persisted: LoopState = {
        originSessionId: "origin-rec-3",
        agent: "test-agent",
        basePrompt: "recover me",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "awaiting_worker",
        activeWorkerTaskId: "task-lost",
        activeWorkerSessionId: "session-lost",
        cancelRequested: false,
        startedAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
        roundStartedAt: Date.now() - 30000,
        schemaVersion: 1,
      };

      const loops = new Map<string, LoopState>();
      loops.set("origin-rec-3", persisted);
      await store.save(loops);

      const loaded = store.load()!;
      await store.reconcile(loaded, async (_taskId) => ({
        status: "unknown",
        exists: false,
      }));

      const state = loaded.get("origin-rec-3")!;
      expect(state.phase).toBe("interrupted");
      expect(state.errorReason).toContain("lost");
    });

    it("recovers awaiting_worker with errored worker → interrupted", async () => {
      const store = new LoopStore(tmpDir);

      const persisted: LoopState = {
        originSessionId: "origin-rec-4",
        agent: "test-agent",
        basePrompt: "recover me",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "awaiting_worker",
        activeWorkerTaskId: "task-err",
        activeWorkerSessionId: "session-err",
        cancelRequested: false,
        startedAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
        roundStartedAt: Date.now() - 30000,
        schemaVersion: 1,
      };

      const loops = new Map<string, LoopState>();
      loops.set("origin-rec-4", persisted);
      await store.save(loops);

      const loaded = store.load()!;
      await store.reconcile(loaded, async (_taskId) => ({
        status: "error",
        exists: true,
      }));

      const state = loaded.get("origin-rec-4")!;
      expect(state.phase).toBe("interrupted");
      expect(state.errorReason).toContain("error");
    });

    it("prunes terminal loops during reconcile", async () => {
      const store = new LoopStore(tmpDir);

      const complete: LoopState = {
        originSessionId: "origin-complete",
        agent: "a",
        basePrompt: "p",
        mode: "inherit",
        total: 1,
        current: 2,
        phase: "complete",
        cancelRequested: false,
        startedAt: 1,
        updatedAt: 1,
        roundStartedAt: 1,
        schemaVersion: 1,
      };

      const active: LoopState = {
        originSessionId: "origin-active",
        agent: "a",
        basePrompt: "p",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "awaiting_worker",
        activeWorkerTaskId: "task-live",
        cancelRequested: false,
        startedAt: 1,
        updatedAt: 1,
        roundStartedAt: 1,
        schemaVersion: 1,
      };

      const loops = new Map<string, LoopState>();
      loops.set("origin-complete", complete);
      loops.set("origin-active", active);
      await store.save(loops);

      const loaded = store.load()!;
      expect(loaded.size).toBe(2);

      await store.reconcile(loaded, async (_taskId) => ({
        status: "running",
        exists: true,
      }));

      expect(loaded.size).toBe(1);
      expect(loaded.has("origin-active")).toBe(true);
      expect(loaded.has("origin-complete")).toBe(false);
    });

    it("recovers loop without activeWorkerTaskId → interrupted", async () => {
      const store = new LoopStore(tmpDir);

      const persisted: LoopState = {
        originSessionId: "origin-no-worker",
        agent: "a",
        basePrompt: "p",
        mode: "inherit",
        total: 3,
        current: 1,
        phase: "awaiting_worker",
        cancelRequested: false,
        startedAt: 1,
        updatedAt: 1,
        roundStartedAt: 1,
        schemaVersion: 1,
      };

      const loops = new Map<string, LoopState>();
      loops.set("origin-no-worker", persisted);
      await store.save(loops);

      const loaded = store.load()!;
      await store.reconcile(loaded, async (_taskId) => ({
        status: "unknown",
        exists: false,
      }));

      const state = loaded.get("origin-no-worker")!;
      expect(state.phase).toBe("interrupted");
      expect(state.errorReason).toContain("No active worker task");
    });

    it("restoreState feeds recovered loop into coordinator", async () => {
      const { adapter } = createFakeAdapter();
      const c = new LoopCoordinator(adapter);

      const recovered: LoopState = {
        originSessionId: "origin-restored",
        agent: "test-agent",
        basePrompt: "resume this",
        mode: "inherit",
        total: 5,
        current: 3,
        phase: "awaiting_worker",
        activeWorkerTaskId: "task-resume",
        activeWorkerSessionId: "session-resume",
        lastSummary: "round 2 done",
        cancelRequested: false,
        startedAt: Date.now() - 120000,
        updatedAt: Date.now() - 60000,
        roundStartedAt: Date.now() - 60000,
        schemaVersion: 1,
      };

      c.restoreState(recovered);

      const state = c.getLoopState("origin-restored")!;
      expect(state).not.toBeUndefined();
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-resume");
      expect(state.current).toBe(3);
      expect(state.total).toBe(5);
      expect(state.lastSummary).toBe("round 2 done");

      expect(c.isLoopSession("origin-restored")).toBe(true);
      expect(c.isLoopSession("session-resume")).toBe(true);
    });
  });
});

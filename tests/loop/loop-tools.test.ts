/// <reference types="bun-types" />
import { describe, it, expect, mock } from "bun:test";
import {
  createLoopStatusTool,
  createLoopCancelTool,
  createLoopOutputTool,
  createLoopHistoryTool,
  createLoopListTool,
} from "../../src/loop/loop-tools";
import type { LoopState, LoopPhase, RoundRecord } from "../../src/loop/types";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import type { CanonicalToolContext } from "../../src/platform/types";
import type { Message } from "../../src/session/types";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const TERMINAL_PHASES = new Set<LoopPhase>([
  "complete",
  "cancelled",
  "error",
  "interrupted",
]);

const DEFAULT_MAX_RESULT_CHARS = 16_000;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal mock tool context. */
const CTX: CanonicalToolContext = {
  sessionID: "test-session",
  messageID: "msg-001",
  agent: "test-agent",
  directory: "/tmp/test",
  worktree: "/tmp/test",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

function makeRound(overrides?: Partial<RoundRecord>): RoundRecord {
  return {
    round: 1,
    workerTaskId: "task-1",
    workerSessionId: "worker-session-1",
    startedAt: Date.now() - 60_000,
    completedAt: Date.now(),
    durationMs: 60_000,
    status: "completed",
    ...overrides,
  };
}

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    originSessionId: "origin-1",
    agent: "test-agent",
    basePrompt: "Do the thing",
    mode: "inherit",
    total: 3,
    current: 1,
    phase: "awaiting_worker",
    cancelRequested: false,
    startedAt: Date.now() - 120_000,
    updatedAt: Date.now(),
    roundStartedAt: Date.now() - 60_000,
    activeWorkerTaskId: "task-1",
    activeWorkerSessionId: "worker-session-1",
    rounds: [makeRound()],
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a mock LoopCoordinator backed by a shared Map of LoopState.
 * Mutations to the map (e.g., from cancelNow) are reflected in subsequent
 * getLoopState / getAllLoopState calls, matching real coordinator behavior.
 */
function createMockCoordinator(initialStates?: Map<string, LoopState>) {
  const states = new Map(initialStates ?? []);

  function findOriginBySessionId(sid: string): string | undefined {
    if (states.has(sid)) return sid;
    for (const [oid, s] of states) {
      if (s.activeWorkerSessionId === sid) return oid;
      if (s.rounds?.some((r) => r.workerSessionId === sid)) return oid;
    }
    return undefined;
  }

  function getDescendants(originSessionId: string): LoopState[] {
    const descendants: LoopState[] = [];
    const collect = (parentId: string) => {
      for (const [id, state] of states) {
        if (state.parentLoopId === parentId) {
          descendants.push(state);
          collect(id);
        }
      }
    };
    collect(originSessionId);
    return descendants;
  }

  function cancelRecursive(loopId: string) {
    const state = states.get(loopId);
    if (
      state &&
      !TERMINAL_PHASES.has(state.phase) &&
      state.phase !== "finalizing"
    ) {
      state.phase = "cancelled";
      state.cancelRequested = true;
      state.updatedAt = Date.now();
    }
    for (const [childId, childState] of states) {
      if (
        childState.parentLoopId === loopId &&
        !TERMINAL_PHASES.has(childState.phase) &&
        childState.phase !== "finalizing"
      ) {
        cancelRecursive(childId);
      }
    }
  }

  return {
    states,
    mock: {
      getLoopState: mock((id: string) => states.get(id)),
      getAllLoopStates: mock(() => new Map(states)),
      cancelNow: mock(async (sid: string) => {
        const oid = findOriginBySessionId(sid);
        if (oid) {
          cancelRecursive(oid);
        }
      }),
      getLoopAncestors: mock((originSessionId: string) => {
        const ancestors: LoopState[] = [];
        let current: string | undefined =
          states.get(originSessionId)?.parentLoopId;
        while (current) {
          const ancestor = states.get(current);
          if (!ancestor) break;
          ancestors.push(ancestor);
          current = ancestor.parentLoopId;
        }
        return ancestors;
      }),
      getLoopDescendants: mock((originSessionId: string) =>
        getDescendants(originSessionId),
      ),
      getAdvancingLockState: mock(() => ({ activeLocks: 0, staleLocks: 0 })),
    },
  };
}

/** Create a mock ISessionClient. */
function createMockSessionClient(
  sessions: Map<string, Message[]> = new Map(),
): ISessionClient {
  return {
    list: mock(async () => []),
    get: mock(async () => null),
    messages: mock(async (id: string) => sessions.get(id) ?? []),
    children: mock(async () => []),
    todo: mock(async () => []),
    diff: mock(async () => []),
    fork: mock(async () => null),
    status: mock(async () => null),
    prompt: mock(async () => ({ id: "note-1" })),
    promptSync: mock(async () => null),
    create: mock(async () => null),
    abort: mock(async () => false),
  };
}

/** Build a single assistant text message. */
function makeAssistantMsg(text: string): Message {
  return {
    info: {
      id: "msg-1",
      sessionID: "worker-session-1",
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [
      {
        id: "part-1",
        sessionID: "worker-session-1",
        messageID: "msg-1",
        type: "text",
        text,
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// loop_status
// ═══════════════════════════════════════════════════════════════════════════

describe("loop_status", () => {
  it("returns detailed status for origin session ID", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState()]]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("## Loop Status");
    expect(result).toContain("`origin-1`");
    expect(result).toContain("test-agent");
    expect(result).toContain("awaiting_worker");
    expect(result).toContain("1/3");
    expect(result).toContain("`worker-session-1`");
    expect(result).toContain("### Rounds");
    expect(result).toContain("completed");
  });

  it("finds loop by active worker session ID", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        ["origin-1", makeState({ activeWorkerSessionId: "worker-active" })],
      ]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "worker-active" }, CTX);

    expect(result).toContain("`origin-1`");
    expect(result).toContain("Matched Via");
    expect(result).toContain("active worker");
  });

  it("finds loop by completed round worker session ID", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            activeWorkerSessionId: undefined,
            activeWorkerTaskId: undefined,
            rounds: [
              makeRound({ round: 1, workerSessionId: "worker-round-1" }),
            ],
          }),
        ],
      ]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "worker-round-1" },
      CTX,
    );

    expect(result).toContain("`origin-1`");
    expect(result).toContain("Matched Via");
    expect(result).toContain("completed round worker");
  });

  it("returns error for unknown session ID", async () => {
    const { mock: coordinator } = createMockCoordinator();
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "nonexistent" }, CTX);

    expect(result).toBe("No loop found for session: nonexistent");
  });

  it("returns aggregate metrics JSON when no session_id given", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        ["origin-1", makeState({ phase: "awaiting_worker" })],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            phase: "complete",
            agent: "agent-2",
          }),
        ],
      ]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = (await tool.execute({}, CTX)) as string;

    const parsed = JSON.parse(result);
    expect(parsed.totalLoops).toBe(2);
    expect(parsed.activeLoops).toBe(1);
    expect(parsed.terminalLoops).toBe(1);
    expect(parsed.byPhase["awaiting_worker"]).toBe(1);
    expect(parsed.byPhase["complete"]).toBe(1);
    expect(parsed.advancingLockState).toEqual({
      activeLocks: 0,
      staleLocks: 0,
    });
  });

  it("returns 'No loops tracked.' when aggregate with empty state", async () => {
    const { mock: coordinator } = createMockCoordinator();
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({}, CTX);

    expect(result).toBe("No loops tracked.");
  });

  it("shows error reason when phase is error", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            phase: "error",
            errorReason: "something broke",
            activeWorkerSessionId: undefined,
          }),
        ],
      ]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("something broke");
  });

  it("includes last summary when present", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            lastSummary: "Round 1 completed successfully.",
            activeWorkerSessionId: undefined,
          }),
        ],
      ]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("### Last Summary");
    expect(result).toContain("Round 1 completed successfully.");
  });

  it("shows cancel-requested indicator", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState({ cancelRequested: true })]]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("⛔");
  });

  it("shows Parent Loop row when parentLoopId is set", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "child-1",
          makeState({
            originSessionId: "child-1",
            parentLoopId: "parent-loop-session-id-12345",
            agent: "child-agent",
          }),
        ],
      ]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "child-1" }, CTX);

    expect(result).toContain("## Loop Status");
    expect(result).toContain("Parent Loop");
    expect(result).toContain("parent-loop-sessi...");
  });

  it("does not show Parent Loop row when parentLoopId is unset", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState()]]),
    );
    const tool = createLoopStatusTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).not.toContain("Parent Loop");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loop_cancel
// ═══════════════════════════════════════════════════════════════════════════

describe("loop_cancel", () => {
  it("cancels a running loop by origin session ID", async () => {
    const { mock: coordinator, states } = createMockCoordinator(
      new Map([["origin-1", makeState({ phase: "awaiting_worker" })]]),
    );
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("Loop cancelled");
    expect(result).toContain("phase: cancelled");
    expect(states.get("origin-1")!.phase).toBe("cancelled");
    expect(states.get("origin-1")!.cancelRequested).toBe(true);
  });

  it("does not alter phase of already-terminal loop", async () => {
    const { mock: coordinator, states } = createMockCoordinator(
      new Map([["origin-1", makeState({ phase: "complete" })]]),
    );
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(states.get("origin-1")!.phase).toBe("complete");
    expect(result).toContain("Loop cancelled");
    expect(result).toContain("phase: complete");
  });

  it("cancels by worker session ID (resolved via activeWorkerSessionId)", async () => {
    const { mock: coordinator, states } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            activeWorkerSessionId: "worker-active",
            phase: "awaiting_worker",
          }),
        ],
      ]),
    );
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute({ session_id: "worker-active" }, CTX);

    expect(result).toContain("Loop cancelled");
    expect(result).toContain("phase: cancelled");
    expect(states.get("origin-1")!.phase).toBe("cancelled");
  });

  it("cancels by worker session ID (resolved via completed round)", async () => {
    const { mock: coordinator, states } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            activeWorkerSessionId: undefined,
            rounds: [
              makeRound({ round: 1, workerSessionId: "worker-round-1" }),
            ],
            phase: "awaiting_worker",
          }),
        ],
      ]),
    );
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "worker-round-1" },
      CTX,
    );

    expect(result).toContain("Loop cancelled");
    expect(states.get("origin-1")!.phase).toBe("cancelled");
  });

  it("returns error for unknown session ID", async () => {
    const { mock: coordinator } = createMockCoordinator();
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute({ session_id: "nonexistent" }, CTX);

    expect(result).toContain("No active loop found for session");
    expect(result).toContain("nonexistent");
  });

  it("reports cascaded descendant count after cancelNow", async () => {
    const { mock: coordinator, states } = createMockCoordinator(
      new Map([
        [
          "parent-1",
          makeState({
            originSessionId: "parent-1",
            phase: "awaiting_worker",
            parentLoopId: undefined,
          }),
        ],
        [
          "child-a",
          makeState({
            originSessionId: "child-a",
            phase: "awaiting_worker",
            agent: "child-agent",
            parentLoopId: "parent-1",
          }),
        ],
        [
          "child-b",
          makeState({
            originSessionId: "child-b",
            phase: "awaiting_worker",
            agent: "child-agent-b",
            parentLoopId: "parent-1",
          }),
        ],
        [
          "grandchild",
          makeState({
            originSessionId: "grandchild",
            phase: "dispatching",
            agent: "grandchild-agent",
            parentLoopId: "child-a",
          }),
        ],
      ]),
    );
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute({ session_id: "parent-1" }, CTX);

    expect(result).toContain("Loop cancelled");
    expect(result).toContain("cascaded to 3 descendant loop(s)");
    expect(states.get("parent-1")!.phase).toBe("cancelled");
    expect(states.get("child-a")!.phase).toBe("cancelled");
    expect(states.get("child-b")!.phase).toBe("cancelled");
    expect(states.get("grandchild")!.phase).toBe("cancelled");
  });

  it("does not report cascade count when no descendants", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState({ phase: "awaiting_worker" })]]),
    );
    const tool = createLoopCancelTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("Loop cancelled");
    expect(result).not.toContain("cascaded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loop_output
// ═══════════════════════════════════════════════════════════════════════════

describe("loop_output", () => {
  it("reads worker messages and applies default max_chars window", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ rounds: [makeRound({ workerSessionId: "ws-1" })] }),
        ],
      ]),
    );
    const workerText = "Hello from worker session. " + "x".repeat(100);
    const sessionClient = createMockSessionClient(
      new Map([["ws-1", [makeAssistantMsg(workerText)]]]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("## Loop Output");
    expect(result).toContain("Hello from worker session");
    expect(result).toContain("[result");
    expect(result).toContain("chars]");
  });

  it("applies offset pagination", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ rounds: [makeRound({ workerSessionId: "ws-1" })] }),
        ],
      ]),
    );
    const workerText = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const sessionClient = createMockSessionClient(
      new Map([["ws-1", [makeAssistantMsg(workerText)]]]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: 5, offset: 10 },
      CTX,
    );

    expect(result).toContain("KLMNO");
    expect(result).toContain("next_offset=15");
  });

  it("applies tail mode", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ rounds: [makeRound({ workerSessionId: "ws-1" })] }),
        ],
      ]),
    );
    const workerText = "START_" + "x".repeat(1000) + "_END";
    const sessionClient = createMockSessionClient(
      new Map([["ws-1", [makeAssistantMsg(workerText)]]]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: 50, offset: 0, tail: true },
      CTX,
    );

    // Should contain the tail end (last 50 chars)
    expect(result).toContain("x".repeat(46) + "_END");
  });

  it("truncates text exceeding max_chars", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ rounds: [makeRound({ workerSessionId: "ws-1" })] }),
        ],
      ]),
    );
    const workerText = "A".repeat(DEFAULT_MAX_RESULT_CHARS + 1000);
    const sessionClient = createMockSessionClient(
      new Map([["ws-1", [makeAssistantMsg(workerText)]]]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("(truncated)");
    expect(result).toContain("next_offset=");
  });

  it("returns metadata-only when no sessionClient", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ rounds: [makeRound({ workerSessionId: "ws-1" })] }),
        ],
      ]),
    );
    const tool = createLoopOutputTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("## Loop Output");
    expect(result).toContain("No session client available");
    expect(result).toContain("session_read");
  });

  it("retrieves output for a specific round number", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            current: 3,
            rounds: [
              makeRound({
                round: 1,
                workerSessionId: "ws-round-1",
                workerTaskId: "task-1",
              }),
              makeRound({
                round: 2,
                workerSessionId: "ws-round-2",
                workerTaskId: "task-2",
              }),
              makeRound({
                round: 3,
                workerSessionId: "ws-round-3",
                workerTaskId: "task-3",
              }),
            ],
          }),
        ],
      ]),
    );
    const sessionClient = createMockSessionClient(
      new Map([["ws-round-2", [makeAssistantMsg("Round 2 output")]]]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      {
        session_id: "origin-1",
        round: 2,
        max_chars: DEFAULT_MAX_RESULT_CHARS,
        offset: 0,
      },
      CTX,
    );

    expect(result).toContain("Round 2 output");
    expect(result).toContain("round 2");
  });

  it("returns error for non-existent round number", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState()]]),
    );
    const tool = createLoopOutputTool(coordinator as any);

    const result = await tool.execute(
      {
        session_id: "origin-1",
        round: 99,
        max_chars: DEFAULT_MAX_RESULT_CHARS,
        offset: 0,
      },
      CTX,
    );

    expect(result).toContain("Round 99 not found");
  });

  it("returns error for unknown session ID", async () => {
    const { mock: coordinator } = createMockCoordinator();
    const tool = createLoopOutputTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "nonexistent", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("No loop found for session");
  });

  it("finds output by active worker session ID", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ activeWorkerSessionId: "worker-active-2", rounds: [] }),
        ],
      ]),
    );
    const sessionClient = createMockSessionClient(
      new Map([
        ["worker-active-2", [makeAssistantMsg("active worker output")]],
      ]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "worker-active-2", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("active worker output");
    expect(result).toContain("Matched Via");
    expect(result).toContain("active worker");
  });

  it("shows message when no worker session available", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            phase: "activating",
            activeWorkerSessionId: undefined,
            activeWorkerTaskId: undefined,
            rounds: [],
          }),
        ],
      ]),
    );
    const tool = createLoopOutputTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("No worker session available yet");
  });

  it("shows fallback when worker has no output text", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            rounds: [makeRound({ workerSessionId: "ws-empty" })],
          }),
        ],
      ]),
    );
    const sessionClient = createMockSessionClient(
      new Map([["ws-empty", []]]),
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("(no output text from worker session)");
  });

  it("does not crash when messages() throws", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            rounds: [makeRound({ workerSessionId: "ws-broken" })],
          }),
        ],
      ]),
    );
    const sessionClient = createMockSessionClient();
    (sessionClient.messages as ReturnType<typeof mock>).mockImplementation(
      async () => {
        throw new Error("session inaccessible");
      },
    );
    const tool = createLoopOutputTool(coordinator as any, sessionClient);

    const result = await tool.execute(
      { session_id: "origin-1", max_chars: DEFAULT_MAX_RESULT_CHARS, offset: 0 },
      CTX,
    );

    expect(result).toContain("## Loop Output");
    expect(result).toContain("`origin-1`");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loop_history
// ═══════════════════════════════════════════════════════════════════════════

describe("loop_history", () => {
  it("returns all rounds for a loop", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            current: 3,
            rounds: [
              makeRound({
                round: 1,
                workerSessionId: "ws-1",
                workerTaskId: "t1",
              }),
              makeRound({
                round: 2,
                workerSessionId: "ws-2",
                workerTaskId: "t2",
                status: "error",
                durationMs: 5000,
              }),
              makeRound({
                round: 3,
                workerSessionId: "ws-3",
                workerTaskId: "t3",
                status: "running",
              }),
            ],
          }),
        ],
      ]),
    );
    const tool = createLoopHistoryTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("## Loop Round History");
    expect(result).toContain("`origin-1`");
    expect(result).toContain("test-agent");
    expect(result).toContain("ws-1");
    expect(result).toContain("ws-2");
    expect(result).toContain("ws-3");
    expect(result).toContain("error");
    expect(result).toContain("completed");
    expect(result).toContain("running");
  });

  it("filters by specific round number", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            rounds: [
              makeRound({ round: 1, workerSessionId: "ws-1" }),
              makeRound({ round: 2, workerSessionId: "ws-2" }),
            ],
          }),
        ],
      ]),
    );
    const tool = createLoopHistoryTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "origin-1", round: 2 },
      CTX,
    );

    expect(result).toContain("ws-2");
    expect(result).not.toContain("ws-1");
  });

  it("returns error for unknown session ID", async () => {
    const { mock: coordinator } = createMockCoordinator();
    const tool = createLoopHistoryTool(coordinator as any);

    const result = await tool.execute({ session_id: "nonexistent" }, CTX);

    expect(result).toContain("No loop found for session");
  });

  it("returns message when loop has no completed rounds", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState({ phase: "activating", rounds: [] })]]),
    );
    const tool = createLoopHistoryTool(coordinator as any);

    const result = await tool.execute({ session_id: "origin-1" }, CTX);

    expect(result).toContain("no completed rounds yet");
  });

  it("returns message when filtered round does not exist", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState({ rounds: [makeRound({ round: 1 })] })]]),
    );
    const tool = createLoopHistoryTool(coordinator as any);

    const result = await tool.execute(
      { session_id: "origin-1", round: 99 },
      CTX,
    );

    expect(result).toContain("No round 99 found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loop_list
// ═══════════════════════════════════════════════════════════════════════════

describe("loop_list", () => {
  it("lists all loops in markdown table", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            phase: "awaiting_worker",
            current: 2,
            agent: "agent-a",
          }),
        ],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            phase: "complete",
            agent: "agent-b",
            current: 4,
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute({ format: "summary" }, CTX);

    expect(result).toContain("## Loop List");
    expect(result).toContain("Total: 2 loop(s)");
    expect(result).toContain("agent-a");
    expect(result).toContain("agent-b");
    expect(result).toContain("awaiting_worker");
    expect(result).toContain("complete");
    expect(result).toContain("loop_status");
    expect(result).toContain("loop_history");
  });

  it("filters by running phase", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ phase: "awaiting_worker", agent: "agent-a" }),
        ],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            phase: "dispatching",
            agent: "agent-b",
          }),
        ],
        [
          "origin-3",
          makeState({
            originSessionId: "origin-3",
            phase: "complete",
            agent: "agent-c",
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute(
      { format: "summary", phase: "running" },
      CTX,
    );

    expect(result).toContain("awaiting_worker");
    expect(result).toContain("dispatching");
    expect(result).not.toContain("complete");
    expect(result).not.toContain("agent-c");
  });

  it("filters by terminal phase", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ phase: "awaiting_worker", agent: "agent-a" }),
        ],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            phase: "error",
            agent: "agent-b",
            errorReason: "boom",
          }),
        ],
        [
          "origin-3",
          makeState({
            originSessionId: "origin-3",
            phase: "cancelled",
            agent: "agent-c",
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute(
      { format: "summary", phase: "terminal" },
      CTX,
    );

    expect(result).not.toContain("awaiting_worker");
    expect(result).toContain("error");
    expect(result).toContain("cancelled");
    expect(result).toContain("agent-b");
    expect(result).toContain("agent-c");
  });

  it("filters by agent name (case-insensitive substring)", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        ["origin-1", makeState({ agent: "Test-Agent" })],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            agent: "other-worker",
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute(
      { format: "summary", agent: "test" },
      CTX,
    );

    expect(result).toContain("Test-Agent");
    expect(result).not.toContain("other-worker");
  });

  it("combines phase and agent filters", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            phase: "awaiting_worker",
            agent: "foo-agent",
          }),
        ],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            phase: "complete",
            agent: "foo-agent",
          }),
        ],
        [
          "origin-3",
          makeState({
            originSessionId: "origin-3",
            phase: "awaiting_worker",
            agent: "bar-agent",
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute(
      { format: "summary", phase: "running", agent: "foo" },
      CTX,
    );

    expect(result).toContain("foo-agent");
    expect(result).toContain("awaiting_worker");
    expect(result).not.toContain("bar-agent");
    expect(result).not.toContain("complete");
  });

  it("returns JSON format when requested", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({ total: 5, current: 3, phase: "awaiting_worker" }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = (await tool.execute({ format: "json" }, CTX)) as string;

    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].sessionId).toBe("origin-1");
    expect(parsed[0].agent).toBe("test-agent");
    expect(parsed[0].phase).toBe("awaiting_worker");
    expect(parsed[0].rounds).toBe("3/5");
  });

  it("returns empty message when no loops match filters", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([["origin-1", makeState({ phase: "complete" })]]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute(
      { format: "summary", phase: "running" },
      CTX,
    );

    expect(result).toContain("No loops found");
    expect(result).toContain("phase=running");
  });

  it("returns empty message when no loops at all", async () => {
    const { mock: coordinator } = createMockCoordinator();
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute({ format: "summary" }, CTX);

    expect(result).toContain("No loops found");
  });

  it("shows cancel-requested flag on running loops", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "origin-1",
          makeState({
            phase: "awaiting_worker",
            cancelRequested: true,
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute({ format: "summary" }, CTX);

    expect(result).toContain("⛔");
  });

  it("renders tree indentation when parentLoopId relationships exist", async () => {
    const baseTime = Date.now();
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "root-loop",
          makeState({
            originSessionId: "root-loop",
            phase: "awaiting_worker",
            agent: "root-agent",
            startedAt: baseTime,
          }),
        ],
        [
          "child-a",
          makeState({
            originSessionId: "child-a",
            phase: "dispatching",
            agent: "child-agent",
            parentLoopId: "root-loop",
            startedAt: baseTime + 1000,
          }),
        ],
        [
          "child-b",
          makeState({
            originSessionId: "child-b",
            phase: "awaiting_worker",
            agent: "child-agent-b",
            parentLoopId: "root-loop",
            startedAt: baseTime + 2000,
          }),
        ],
        [
          "grandchild",
          makeState({
            originSessionId: "grandchild",
            phase: "dispatching",
            agent: "grandchild-agent",
            parentLoopId: "child-a",
            startedAt: baseTime + 1500,
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute({ format: "summary" }, CTX);

    expect(result).toContain("## Loop List");
    expect(result).toContain("Total: 4 loop(s)");

    // Root has no tree prefix
    expect(result).toContain("root-loop");
    // Children should have tree connectors
    expect(result).toContain("├──");
    expect(result).toContain("└──");
    // Grandchild should be nested deeper
    expect(result).toContain("│");
  });

  it("renders flat table when no parentLoopId relationships exist", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        ["origin-1", makeState({ phase: "awaiting_worker" })],
        [
          "origin-2",
          makeState({
            originSessionId: "origin-2",
            phase: "complete",
            agent: "agent-b",
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = await tool.execute({ format: "summary" }, CTX);

    // No tree characters when no parentLoopId
    expect(result).not.toContain("├──");
    expect(result).not.toContain("└──");
    expect(result).not.toContain("│");
  });

  it("JSON output includes parentLoopId field", async () => {
    const { mock: coordinator } = createMockCoordinator(
      new Map([
        [
          "root-loop",
          makeState({
            originSessionId: "root-loop",
            phase: "awaiting_worker",
          }),
        ],
        [
          "child-loop",
          makeState({
            originSessionId: "child-loop",
            phase: "dispatching",
            agent: "child-agent",
            parentLoopId: "root-loop",
          }),
        ],
      ]),
    );
    const tool = createLoopListTool(coordinator as any);

    const result = (await tool.execute({ format: "json" }, CTX)) as string;
    const parsed = JSON.parse(result);

    expect(parsed.length).toBe(2);

    const root = parsed.find((e: any) => e.sessionId === "root-loop");
    const child = parsed.find((e: any) => e.sessionId === "child-loop");

    expect(root.parentLoopId).toBeNull();
    expect(child.parentLoopId).toBe("root-loop");
  });
});

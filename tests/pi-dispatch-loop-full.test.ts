/**
 * Pi Dispatch + Loop Full Integration Tests.
 *
 * Covers dispatch and loop behavior on the Pi platform:
 *   A. Dispatch — DispatchAdapter methods, notification triggers, task lifecycle
 *   B. Loop — LoopCoordinator state machine (register, phase transitions,
 *      cancel, recovery) with mocked IDispatchAdapter
 *
 * Uses mock adapters per the existing test pattern (pi-notification-session.test.ts,
 * pi-full-lifecycle.test.ts). No real Pi CLI processes are spawned.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PiNotificationSessionClient } from "../src/platform/adapters/pi/notification-session.ts";
import { LoopCoordinator } from "../src/loop/coordinator.ts";
import { LoopStore } from "../src/loop/loop-store.ts";
import { DispatchAdapter, type IDispatchAdapter } from "../src/loop/dispatch-adapter.ts";
import { LOOP_PROGRESS_MARKER, LOOP_STATE_SCHEMA_VERSION } from "../src/loop/constants.ts";
import type { LoopState, LoopPhase, LoopMode } from "../src/loop/types.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Poll the coordinator until the loop reaches a target phase, or timeout.
 * Returns the current phase at each check — useful for debugging failures.
 */
async function waitForPhase(
  coordinator: LoopCoordinator,
  originSessionId: string,
  targetPhase: LoopPhase | LoopPhase[],
  timeoutMs = 5000,
): Promise<LoopPhase> {
  const targets = Array.isArray(targetPhase) ? targetPhase : [targetPhase];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loop = coordinator.getLoopState(originSessionId);
    const phase = loop?.phase ?? ("unknown" as LoopPhase);
    if (targets.includes(phase)) return phase;
    await new Promise((r) => setTimeout(r, 20));
  }
  const loop = coordinator.getLoopState(originSessionId);
  throw new Error(
    `Timed out waiting for phase ${targets.join("|")}; current=${loop?.phase ?? "null"}`,
  );
}

/**
 * Mock Pi ExtensionAPI with recorded sendMessage / sendUserMessage calls.
 */
function createMockPi(): {
  sendMessage: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
} {
  return {
    sendMessage: mock((_message: any, _opts?: any) => {}),
    sendUserMessage: mock((_text: string) => {}),
  };
}

/**
 * Mock inner ISessionClient (PiProcessSessionAdapter) with a processes map.
 */
function createMockInner(processIds: string[] = []): ISessionClient & {
  processes: Map<string, unknown>;
} {
  const processes = new Map<string, unknown>();
  for (const id of processIds) {
    processes.set(id, { proc: null, messages: [], exitCode: 0 });
  }

  return {
    processes,
    list: mock(async (_dir?: string) => []),
    get: mock(async (_id: string, _dir?: string) => null),
    messages: mock(async (_id: string, _opts?: { directory?: string; limit?: number }) => []),
    children: mock(async (_id: string, _dir?: string) => []),
    todo: mock(async (_id: string, _dir?: string) => []),
    diff: mock(async (_id: string, _opts?: { directory?: string; messageID?: string }) => []),
    fork: mock(async (_id: string, _opts?: { directory?: string; messageID?: string }) => null),
    status: mock(async (_id: string, _dir?: string) => null),
    prompt: mock(async (_id: string, _opts: any) => ({ id: _id })),
    promptSync: mock(async (_id: string, _opts: any) => ({ parts: [{ type: "text", text: "response" }] })),
    create: mock(async (_opts: { directory: string; agent?: string; parentID?: string }) => null),
    abort: mock(async (_id: string) => true),
  };
}

function createMockLogger(): Logger<ILogObj> {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger<ILogObj>;
}

// ── Mock IDispatchAdapter factory ──────────────────────────────────────────

interface MockDispatchAdapter extends IDispatchAdapter {
  dispatchRoundCalls: Array<{
    originSessionId: string;
    agent: string;
    prompt: string;
    description?: string;
    timeoutMs?: number;
    taskId: string;
    sessionId: string;
  }>;
  /** Derived from the injectNote mock call log (getter). */
  readonly injectNoteCalls: Array<{ sessionId: string; text: string }>;
  cancelRoundCalls: string[];
  terminatedCallbacks: Map<string, (taskId: string, status: string) => void>;
  /** Simulate a worker completing — invokes the registered terminated callback. */
  _triggerWorkerCompleted(taskId: string, status?: string): void;
  /** Reset all call tracking. */
  _reset(): void;
  /** Override the next getRoundResult return value. */
  _nextResult: { text: string; hadError: boolean; errorReason?: string };
  /** Override the next getTaskStatus return value. */
  _nextTaskStatus: string;
  /** Custom readOriginSummary return. */
  _summaryText: string;
}

function createMockDispatchAdapter(): MockDispatchAdapter {
  let nextTaskId = 0;
  let nextSessionId = 0;
  const dispatchRoundCalls: Array<{
    originSessionId: string;
    agent: string;
    prompt: string;
    description?: string;
    timeoutMs?: number;
    taskId: string;
    sessionId: string;
  }> = [];
  const cancelRoundCalls: string[] = [];
  const terminatedCallbacks = new Map<string, (taskId: string, status: string) => void>();
  let nextResult = { text: "Worker result text", hadError: false, errorReason: undefined as string | undefined };
  let nextTaskStatus = "running";
  let summaryText = "Summary from completed round";

  const injectNoteMock = mock(async (_sessionId: string, _text: string) => {});

  const adapter: MockDispatchAdapter = {
    dispatchRoundCalls,
    injectNoteCalls: [],
    cancelRoundCalls,
    terminatedCallbacks,

    get _nextResult() { return nextResult; },
    set _nextResult(v) { nextResult = v; },
    get _nextTaskStatus() { return nextTaskStatus; },
    set _nextTaskStatus(v) { nextTaskStatus = v; },
    get _summaryText() { return summaryText; },
    set _summaryText(v) { summaryText = v; },

    _triggerWorkerCompleted(taskId: string, status: string = "completed") {
      const cb = terminatedCallbacks.get(taskId);
      if (cb) {
        terminatedCallbacks.delete(taskId);
        cb(taskId, status);
      }
    },

    _reset() {
      dispatchRoundCalls.length = 0;
      cancelRoundCalls.length = 0;
      terminatedCallbacks.clear();
      nextResult = { text: "Worker result text", hadError: false, errorReason: undefined };
      nextTaskStatus = "running";
      summaryText = "Summary from completed round";
    },

    async dispatchRound(input) {
      const taskId = `task-${++nextTaskId}`;
      const sessionId = `ses-${++nextSessionId}`;
      dispatchRoundCalls.push({ ...input, taskId, sessionId });
      return { workerTaskId: taskId, workerSessionId: sessionId };
    },

    async getRoundResult(_workerTaskId: string) {
      return { ...nextResult };
    },

    async cancelRound(workerTaskId: string) {
      cancelRoundCalls.push(workerTaskId);
    },

    async readOriginSummary(_originSessionId: string, _sinceMessageId?: string) {
      return summaryText;
    },

    async getLastMessageId(originSessionId: string) {
      return `msg-last-${originSessionId}`;
    },

    injectNote: injectNoteMock,

    registerTerminatedListener(
      taskId: string,
      callback: (taskId: string, status: string) => void,
    ) {
      terminatedCallbacks.set(taskId, callback);
      return callback;
    },

    removeTerminatedListener(taskId: string, _callback: (taskId: string, status: string) => void) {
      terminatedCallbacks.delete(taskId);
    },

    async getTaskStatus(_taskId: string) {
      return nextTaskStatus;
    },
  };

  // Bridge injectNoteCalls to the mock's call log for assertion convenience
  Object.defineProperty(adapter, "injectNoteCalls", {
    get() {
      return injectNoteMock.mock.calls.map((call: any[]) => ({
        sessionId: call[0],
        text: call[1],
      }));
    },
  });

  return adapter;
}

// ════════════════════════════════════════════════════════════════════════════
//  Section A: Dispatch — Notification & DispatchAdapter
// ════════════════════════════════════════════════════════════════════════════

describe("PI Dispatch — Notification & DispatchAdapter", () => {
  // ── A.1: Sync dispatch notification (triggerTurn: true) ──────────────────

  it("sync dispatch: prompt with noReply:false sends triggerTurn:true", async () => {
    const inner = createMockInner();
    const pi = createMockPi();
    const log = createMockLogger();
    const client = new PiNotificationSessionClient(inner as any, pi as any, log);

    const result = await client.prompt("external-1", {
      parts: [{ type: "text", text: "sync dispatch result" }],
      noReply: false,
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "sync dispatch result", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
    expect(inner.prompt).not.toHaveBeenCalled();
  });

  // ── A.2: Background dispatch intermediate notification (triggerTurn: false) ──

  it("background dispatch: prompt with noReply:true sends triggerTurn:false (intermediate notification)", async () => {
    const inner = createMockInner();
    const pi = createMockPi();
    const log = createMockLogger();
    const client = new PiNotificationSessionClient(inner as any, pi as any, log);

    const result = await client.prompt("external-1", {
      parts: [{ type: "text", text: "background task dispatched" }],
      noReply: true,
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "background task dispatched", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  // ── A.3: Loop final notification (fromLoop:true, noReply:false → triggerTurn:true) ──

  it("loop final: fromLoop:true + noReply:false sends triggerTurn:true", async () => {
    const inner = createMockInner();
    const pi = createMockPi();
    const log = createMockLogger();
    const client = new PiNotificationSessionClient(inner as any, pi as any, log);

    const result = await client.prompt("external-1", {
      parts: [{ type: "text", text: "[loop-progress] loop complete]\nRounds: r1:ses-abc(2.0s,completed)" }],
      noReply: false,
      fromLoop: true,
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "rolebox-inject",
        content: "[loop-progress] loop complete]\nRounds: r1:ses-abc(2.0s,completed)",
        display: true,
        details: { source: "rolebox-dispatch" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  // ── A.4: Loop progress silent (fromLoop:true, noReply:true → triggerTurn:false) ──

  it("loop progress: fromLoop:true + noReply:true sends triggerTurn:false (silent)", async () => {
    const inner = createMockInner();
    const pi = createMockPi();
    const log = createMockLogger();
    const client = new PiNotificationSessionClient(inner as any, pi as any, log);

    const result = await client.prompt("external-1", {
      parts: [{ type: "text", text: "[loop-progress] round 1/3 completed, session=ses-1, duration=2.0s]" }],
      noReply: true,
      fromLoop: true,
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "rolebox-inject",
        content: "[loop-progress] round 1/3 completed, session=ses-1, duration=2.0s]",
        display: true,
        details: { source: "rolebox-dispatch" },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  // ── A.5: Legacy Pi fallback (sendUserMessage) ───────────────────────────

  it("falls back to sendUserMessage when sendMessage is unavailable (legacy Pi)", async () => {
    const inner = createMockInner();
    const legacyPi = {
      sendUserMessage: mock((_text: string) => {}),
    } as any;
    const log = createMockLogger();
    const client = new PiNotificationSessionClient(inner as any, legacyPi, log);

    const result = await client.prompt("external-1", {
      parts: [{ type: "text", text: "legacy dispatch" }],
    });

    expect(legacyPi.sendUserMessage).toHaveBeenCalledWith("legacy dispatch");
    expect(result).toEqual({ id: "external-1" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section B: DispatchAdapter — dispatch round, cancel, result
// ════════════════════════════════════════════════════════════════════════════

describe("PI Dispatch — DispatchAdapter", () => {
  // ── B.1: injectNote calls client.prompt with fromLoop:true, noReply:true ─

  it("injectNote calls client.prompt with fromLoop:true and noReply:true", async () => {
    const inner = createMockInner();
    const pi = createMockPi();
    const log = createMockLogger();
    const client = new PiNotificationSessionClient(inner as any, pi as any, log);

    // Simulate what DispatchAdapter.injectNote() does
    await client.prompt("origin-1", {
      noReply: true,
      fromLoop: true,
      parts: [{ type: "text", text: "[loop-progress] loop started: 3 rounds, inherit mode]" }],
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "rolebox-inject",
        content: "[loop-progress] loop started: 3 rounds, inherit mode]",
        display: true,
        details: { source: "rolebox-dispatch" },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  });

  // ── B.2: DispatchAdapter.dispatchRound launches background task ─────────

  it("DispatchAdapter.dispatchRound launches a background task via dispatchManager", async () => {
    const dispatchManager = {
      launch: mock(async (_input: any, _ctx: any) => ({
        id: "task-dispatch-1",
        sessionId: "ses-dispatch-1",
      })),
    } as any;
    const client = {
      prompt: mock(async () => ({ id: "x" })),
      messages: mock(async () => []),
    } as any;

    const adapter = new DispatchAdapter(dispatchManager, client, "/tmp/test");

    const result = await adapter.dispatchRound({
      originSessionId: "origin-1",
      agent: "test-agent",
      prompt: "Execute task",
      description: "Round 1/3",
      timeoutMs: 30000,
    });

    expect(result.workerTaskId).toBe("task-dispatch-1");
    expect(result.workerSessionId).toBe("ses-dispatch-1");
    expect(dispatchManager.launch).toHaveBeenCalledTimes(1);

    const launchCall = (dispatchManager.launch as ReturnType<typeof mock>).mock.calls[0];
    expect(launchCall[0].subagent).toBe("test-agent");
    expect(launchCall[0].prompt).toBe("Execute task");
    expect(launchCall[0].run_in_background).toBe(true);
    expect(launchCall[0].noParentInherit).toBe(true);
    expect(launchCall[0].timeout_ms).toBe(30000);
  });

  // ── B.3: DispatchAdapter.getRoundResult maps dispatch result ────────────

  it("DispatchAdapter.getRoundResult returns text, hadError, errorReason", async () => {
    const dispatchManager = {
      getResult: mock(async (_taskId: string) => ({
        kind: "ok",
        text: "Round output here",
        error: undefined,
      })),
    } as any;
    const client = {
      messages: mock(async () => []),
    } as any;
    const adapter = new DispatchAdapter(dispatchManager, client, "/tmp/test");

    const result = await adapter.getRoundResult("task-1");
    expect(result.text).toBe("Round output here");
    expect(result.hadError).toBe(false);
    expect(result.errorReason).toBeUndefined();
  });

  // ── B.4: DispatchAdapter.getRoundResult with error ──────────────────────

  it("DispatchAdapter.getRoundResult detects hadError from dispatch error", async () => {
    const dispatchManager = {
      getResult: mock(async (_taskId: string) => ({
        kind: "ok",
        text: "",
        error: "Sub-agent crashed",
      })),
    } as any;
    const client = {
      messages: mock(async () => []),
    } as any;
    const adapter = new DispatchAdapter(dispatchManager, client, "/tmp/test");

    const result = await adapter.getRoundResult("task-err");
    expect(result.hadError).toBe(true);
    expect(result.errorReason).toBe("Sub-agent crashed");
  });

  // ── B.5: DispatchAdapter.cancelRound calls cancelTask ───────────────────

  it("DispatchAdapter.cancelRound calls dispatchManager.cancelTask", async () => {
    const dispatchManager = {
      cancelTask: mock(async (_taskId: string) => true),
    } as any;
    const client = { messages: mock(async () => []) } as any;
    const adapter = new DispatchAdapter(dispatchManager, client, "/tmp/test");

    await adapter.cancelRound("task-to-cancel");
    expect(dispatchManager.cancelTask).toHaveBeenCalledWith("task-to-cancel");
  });

  // ── B.6: DispatchAdapter.getTaskStatus returns task status ──────────────

  it("DispatchAdapter.getTaskStatus returns status from dispatchManager", async () => {
    const dispatchManager = {
      getTask: mock((_taskId: string) => ({ status: "running" })),
    } as any;
    const client = { messages: mock(async () => []) } as any;
    const adapter = new DispatchAdapter(dispatchManager, client, "/tmp/test");

    const status = await adapter.getTaskStatus("task-running");
    expect(status).toBe("running");
  });

  // ── B.7: DispatchAdapter.getTaskStatus returns undefined for unknown task ─

  it("DispatchAdapter.getTaskStatus returns undefined for unknown task", async () => {
    const dispatchManager = {
      getTask: mock((_taskId: string) => undefined),
    } as any;
    const client = { messages: mock(async () => []) } as any;
    const adapter = new DispatchAdapter(dispatchManager, client, "/tmp/test");

    const status = await adapter.getTaskStatus("nonexistent");
    expect(status).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section C: LoopCoordinator — state machine, phase transitions, cancel
// ════════════════════════════════════════════════════════════════════════════

describe("PI Loop — LoopCoordinator State Machine", () => {
  let adapter: MockDispatchAdapter;
  let coordinator: LoopCoordinator;

  beforeEach(() => {
    adapter = createMockDispatchAdapter();
    coordinator = new LoopCoordinator(adapter, { delayMs: 0 });
  });

  afterEach(() => {
    coordinator.dispose();
  });

  // ── C.1: register creates loop in activating, self-kickoff → awaiting_worker ──

  it("register creates loop with activating phase and self-kickoffs to awaiting_worker", async () => {
    coordinator.register({
      originSessionId: "origin-c1",
      agent: "test-agent",
      prompt: "Do the task",
      mode: "inherit",
      iterations: 3,
    });

    // Phase should transition: activating → dispatching → awaiting_worker
    // (driven by _kickoffFromActivating on microtask)
    const finalPhase = await waitForPhase(coordinator, "origin-c1", "awaiting_worker");

    // Drain microtasks — injectNote for loop-started marker runs after phase is set
    await new Promise((r) => setTimeout(r, 50));

    expect(finalPhase).toBe("awaiting_worker");

    const loop = coordinator.getLoopState("origin-c1")!;
    expect(loop.agent).toBe("test-agent");
    expect(loop.total).toBe(3);
    expect(loop.current).toBe(1);
    expect(loop.mode).toBe("inherit");
    expect(loop.cancelRequested).toBe(false);
    expect(loop.schemaVersion).toBe(LOOP_STATE_SCHEMA_VERSION);
    expect(loop.activeWorkerTaskId).toBeDefined();
    expect(loop.rounds).toHaveLength(1);
    expect(loop.rounds![0].status).toBe("running");

    // Dispatch adapter was called exactly once for the first round
    expect(adapter.dispatchRoundCalls).toHaveLength(1);
    expect(adapter.dispatchRoundCalls[0].agent).toBe("test-agent");
    expect(adapter.dispatchRoundCalls[0].description).toBe("Loop round 1/3");

    // injectNote for loop-started marker
    // LOOP_PROGRESS_MARKER is "[loop-progress" (no trailing "]"); the "]" comes
    // from the string literal appended to the marker.
    const startedNotes = adapter.injectNoteCalls.filter(
      (c) => c.text.includes("loop started"),
    );
    expect(startedNotes).toHaveLength(1);
  });

  // ── C.2: Full 2-round loop — complete phase transitions ─────────────────

  it("completes a 2-round loop with correct phase transitions and progress markers", async () => {
    coordinator.register({
      originSessionId: "origin-c2",
      agent: "loop-agent",
      prompt: "Process item",
      mode: "inherit",
      iterations: 2,
    });

    // Wait for kickoff to complete → round 1 awaiting_worker
    await waitForPhase(coordinator, "origin-c2", "awaiting_worker");

    let loop = coordinator.getLoopState("origin-c2")!;
    expect(loop.phase).toBe("awaiting_worker");
    expect(loop.current).toBe(1);

    // ── Complete round 1 ──
    const taskId1 = loop.activeWorkerTaskId!;
    adapter._triggerWorkerCompleted(taskId1, "completed");

    // onWorkerCompleted runs async via fire-and-forget (no await in callback).
    // Wait for the full push-chain: getRoundResult → injectNote → _advanceFromSummarizing
    // → handleSummary (current++, phase=dispatching) → dispatchRound (phase=awaiting_worker)
    await new Promise((r) => setTimeout(r, 100));
    await waitForPhase(coordinator, "origin-c2", "awaiting_worker");

    loop = coordinator.getLoopState("origin-c2")!;
    expect(loop.current).toBe(2);
    expect(loop.phase).toBe("awaiting_worker");
    expect(loop.rounds).toHaveLength(2);
    expect(loop.rounds![0].status).toBe("completed");
    expect(loop.rounds![0].completedAt).toBeDefined();
    expect(loop.rounds![1].status).toBe("running");

    // injectNote for round-1 progress marker
    const round1Notes = adapter.injectNoteCalls.filter(
      (c) => c.text.includes("round 1/2"),
    );
    expect(round1Notes).toHaveLength(1);

    // ── Complete round 2 (final) ──
    const taskId2 = loop.activeWorkerTaskId!;
    adapter._triggerWorkerCompleted(taskId2, "completed");

    // Round 2 completes → summarizing → finalizing → complete
    await waitForPhase(coordinator, "origin-c2", "complete");

    loop = coordinator.getLoopState("origin-c2")!;
    expect(loop.phase).toBe("complete");
    expect(loop.current).toBe(3); // incremented past total
    expect(loop.rounds).toHaveLength(2);
    expect(loop.rounds![1].status).toBe("completed");

    // Final note with loop complete marker
    const finalNotes = adapter.injectNoteCalls.filter(
      (c) => c.text.includes("loop complete]"),
    );
    expect(finalNotes).toHaveLength(1);
  });

  // ── C.3: Loop state transitions through real phase names ────────────────

  it("loop state transitions through activating → dispatching → awaiting_worker → summarizing → complete", async () => {
    coordinator.register({
      originSessionId: "origin-c3",
      agent: "phase-agent",
      prompt: "Run phase test",
      mode: "fresh",
      iterations: 1,
    });

    // After kickoff, should be awaiting_worker via dispatching
    let phase = await waitForPhase(coordinator, "origin-c3", "awaiting_worker");
    expect(phase).toBe("awaiting_worker");

    let loop = coordinator.getLoopState("origin-c3")!;

    // Complete the single round
    adapter._triggerWorkerCompleted(loop.activeWorkerTaskId!, "completed");

    // Should transition: awaiting_worker → summarizing → finalizing → complete
    phase = await waitForPhase(coordinator, "origin-c3", "complete");
    expect(phase).toBe("complete");

    loop = coordinator.getLoopState("origin-c3")!;
    expect(loop.current).toBe(2); // 1 → 2 (past total of 1)
    expect(loop.phase).toBe("complete");
  });

  // ── C.4: Phase type validity — all states match LoopPhase union ─────────

  it("all loop phases are valid LoopPhase values", () => {
    coordinator.register({
      originSessionId: "origin-c4",
      agent: "t",
      prompt: "p",
      mode: "inherit",
      iterations: 1,
    });

    const loop = coordinator.getLoopState("origin-c4")!;

    // Valid initial phase
    const validPhases: LoopPhase[] = [
      "activating", "dispatching", "awaiting_worker", "summarizing",
      "finalizing", "complete", "cancelled", "interrupted", "error",
    ];
    expect(validPhases).toContain(loop.phase);

    // After register, phase is activating (before kickoff microtask)
    // but since register uses Promise.resolve().then, it might already be
    // dispatching. Either is valid at this point.
    expect(["activating", "dispatching", "awaiting_worker"]).toContain(loop.phase);
  });

  // ── C.5: cancelNow cancels loop and active round ────────────────────────

  it("cancelNow cancels an active loop and its worker round", async () => {
    coordinator.register({
      originSessionId: "origin-c5",
      agent: "cancel-agent",
      prompt: "Work to cancel",
      mode: "inherit",
      iterations: 5,
    });

    // Wait for round 1 to be dispatched
    await waitForPhase(coordinator, "origin-c5", "awaiting_worker");

    let loop = coordinator.getLoopState("origin-c5")!;
    expect(loop.phase).toBe("awaiting_worker");

    // ── Cancel the loop ──
    await coordinator.cancelNow("origin-c5");

    // Drain microtasks so injectNote completes
    await new Promise((r) => setTimeout(r, 50));

    loop = coordinator.getLoopState("origin-c5")!;
    expect(loop.phase).toBe("cancelled");
    expect(loop.cancelRequested).toBe(true);

    // cancelRound should have been called for the active worker
    expect(adapter.cancelRoundCalls.length).toBeGreaterThanOrEqual(1);

    // Final cancel note injected
    const cancelNotes = adapter.injectNoteCalls.filter(
      (c) => c.text.includes("loop cancelled]"),
    );
    expect(cancelNotes).toHaveLength(1);
  });

  // ── C.6: requestCancel sets cancelRequested flag ────────────────────────

  it("requestCancel sets cancelRequested flag without immediate cancellation", () => {
    coordinator.register({
      originSessionId: "origin-c6",
      agent: "req-cancel-agent",
      prompt: "p",
      mode: "inherit",
      iterations: 3,
    });

    coordinator.requestCancel("origin-c6");

    const loop = coordinator.getLoopState("origin-c6")!;
    expect(loop.cancelRequested).toBe(true);
    // Should NOT be in a terminal phase yet — requestCancel is non-blocking
    expect(["activating", "dispatching", "awaiting_worker"]).toContain(loop.phase);
  });

  // ── C.7: NonTerminalLoops filter correctly ──────────────────────────────

  it("getNonTerminalLoops returns only non-terminal loops", async () => {
    coordinator.register({
      originSessionId: "origin-c7",
      agent: "t",
      prompt: "p",
      mode: "inherit",
      iterations: 1,
    });

    await waitForPhase(coordinator, "origin-c7", "awaiting_worker");

    const loop = coordinator.getLoopState("origin-c7")!;
    adapter._triggerWorkerCompleted(loop.activeWorkerTaskId!, "completed");
    await waitForPhase(coordinator, "origin-c7", "complete");

    // After completion, getNonTerminalLoops should be empty
    const nonTerminal = coordinator.getNonTerminalLoops();
    expect(nonTerminal).toHaveLength(0);
  });

  // ── C.8: getAllLoopStates returns all loops including terminal ──────────

  it("getAllLoopStates returns all loops including completed ones", async () => {
    coordinator.register({
      originSessionId: "origin-c8",
      agent: "t",
      prompt: "p",
      mode: "inherit",
      iterations: 1,
    });

    await waitForPhase(coordinator, "origin-c8", "awaiting_worker");

    const loop = coordinator.getLoopState("origin-c8")!;
    adapter._triggerWorkerCompleted(loop.activeWorkerTaskId!, "completed");
    await waitForPhase(coordinator, "origin-c8", "complete");

    const allLoops = coordinator.getAllLoopStates();
    expect(allLoops.has("origin-c8")).toBe(true);
    expect(allLoops.get("origin-c8")!.phase).toBe("complete");
  });

  // ── C.9: shouldCancelOnUserMessage detects stop-loop signal ─────────────

  it("shouldCancelOnUserMessage detects [rolebox:stop-loop] in awaiting_worker phase", async () => {
    coordinator.register({
      originSessionId: "origin-c9",
      agent: "t",
      prompt: "p",
      mode: "inherit",
      iterations: 5,
    });

    await waitForPhase(coordinator, "origin-c9", "awaiting_worker");

    const shouldCancel = coordinator.shouldCancelOnUserMessage(
      "origin-c9",
      "[rolebox:stop-loop]",
    );
    expect(shouldCancel).toBe(true);

    const loop = coordinator.getLoopState("origin-c9")!;
    expect(loop.cancelRequested).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section D: LoopStore — persistence and recovery
// ════════════════════════════════════════════════════════════════════════════

describe("PI Loop — LoopStore Persistence & Recovery", () => {
  let tmpDir: string;
  let store: LoopStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-test-"));
    store = new LoopStore(tmpDir);
  });

  afterEach(() => {
    store.dispose();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── D.1: save/load round-trip preserves all LoopState fields ─────────────

  it("save/load round-trip preserves LoopState fields", async () => {
    const now = Date.now();
    const state: LoopState = {
      originSessionId: "origin-d1",
      agent: "persist-agent",
      basePrompt: "Test prompt",
      mode: "fresh",
      total: 5,
      current: 2,
      phase: "awaiting_worker",
      activeWorkerTaskId: "task-worker-1",
      activeWorkerSessionId: "ses-worker-1",
      lastSummary: "Summary of round 1",
      summaryBoundaryMessageId: "msg-boundary-1",
      cancelRequested: false,
      startedAt: now,
      updatedAt: now,
      roundStartedAt: now,
      rounds: [
        {
          round: 1,
          workerTaskId: "task-worker-1",
          workerSessionId: "ses-worker-1",
          startedAt: now - 60000,
          completedAt: now - 30000,
          durationMs: 30000,
          status: "completed",
        },
      ],
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    const map = new Map<string, LoopState>();
    map.set("origin-d1", state);

    await store.save(map);
    // Wait for debounce (200ms)
    await new Promise((r) => setTimeout(r, 250));

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.has("origin-d1")).toBe(true);

    const restored = loaded!.get("origin-d1")!;
    expect(restored.originSessionId).toBe("origin-d1");
    expect(restored.agent).toBe("persist-agent");
    expect(restored.basePrompt).toBe("Test prompt");
    expect(restored.mode).toBe("fresh");
    expect(restored.total).toBe(5);
    expect(restored.current).toBe(2);
    expect(restored.phase).toBe("awaiting_worker");
    expect(restored.activeWorkerTaskId).toBe("task-worker-1");
    expect(restored.activeWorkerSessionId).toBe("ses-worker-1");
    expect(restored.lastSummary).toBe("Summary of round 1");
    expect(restored.rounds).toHaveLength(1);
    expect(restored.rounds![0].status).toBe("completed");
    expect(restored.schemaVersion).toBe(LOOP_STATE_SCHEMA_VERSION);
  });

  // ── D.2: load returns null when no saved state exists ───────────────────

  it("load returns null when no state file exists", () => {
    const result = store.load();
    expect(result).toBeNull();
  });

  // ── D.3: saveSync writes state synchronously ────────────────────────────

  it("saveSync persists state for immediate read-back", () => {
    const state: LoopState = {
      originSessionId: "origin-d3",
      agent: "sync-agent",
      basePrompt: "Sync prompt",
      mode: "inherit",
      total: 3,
      current: 1,
      phase: "activating",
      cancelRequested: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      roundStartedAt: Date.now(),
      rounds: [],
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    const map = new Map<string, LoopState>();
    map.set("origin-d3", state);
    store.saveSync(map);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.get("origin-d3")!.phase).toBe("activating");
  });

  // ── D.4: reconcile removes terminal loops and preserves awaiting_worker ──

  it("reconcile removes terminal-phase loops and preserves awaiting_worker", async () => {
    const now = Date.now();
    const terminalState: LoopState = {
      originSessionId: "terminal-1",
      agent: "t", basePrompt: "p", mode: "inherit",
      total: 1, current: 1, phase: "complete",
      cancelRequested: false,
      startedAt: now, updatedAt: now, roundStartedAt: now,
      rounds: [], schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };
    const awaitingState: LoopState = {
      originSessionId: "awaiting-1",
      agent: "t", basePrompt: "p", mode: "inherit",
      total: 2, current: 1, phase: "awaiting_worker",
      activeWorkerTaskId: "task-aw-1",
      cancelRequested: false,
      startedAt: now, updatedAt: now, roundStartedAt: now,
      rounds: [], schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    const map = new Map<string, LoopState>();
    map.set("terminal-1", terminalState);
    map.set("awaiting-1", awaitingState);

    const reconciled = await store.reconcile(map, async (taskId: string) => ({
      status: "running",
      exists: true,
    }));

    // Terminal removed
    expect(reconciled.has("terminal-1")).toBe(false);
    // Awaiting preserved
    expect(reconciled.has("awaiting-1")).toBe(true);
    expect(reconciled.get("awaiting-1")!.phase).toBe("awaiting_worker");
  });

  // ── D.5: recovery — restoreState + reSubscribeListeners ─────────────────

  it("restoreState + reSubscribeListeners recovers awaiting_worker loop", async () => {
    const adapter = createMockDispatchAdapter();
    const coordinator = new LoopCoordinator(adapter, { delayMs: 0 });

    // Simulate a persisted loop in awaiting_worker phase
    const now = Date.now();
    const recoveredState: LoopState = {
      originSessionId: "origin-recover",
      agent: "recover-agent",
      basePrompt: "Recover me",
      mode: "inherit",
      total: 1,
      current: 1,
      phase: "awaiting_worker",
      activeWorkerTaskId: "task-recover-1",
      activeWorkerSessionId: "ses-recover-1",
      cancelRequested: false,
      startedAt: now,
      updatedAt: now,
      roundStartedAt: now,
      rounds: [
        {
          round: 1,
          workerTaskId: "task-recover-1",
          workerSessionId: "ses-recover-1",
          startedAt: now,
          status: "running",
        },
      ],
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    // Set task status to completed — worker finished while coordinator was down
    adapter._nextTaskStatus = "completed";

    coordinator.restoreState(recoveredState);

    // Verify state is restored
    const restored = coordinator.getLoopState("origin-recover")!;
    expect(restored.phase).toBe("awaiting_worker");
    expect(restored.activeWorkerTaskId).toBe("task-recover-1");

    // reSubscribeListeners should detect completed worker and advance
    await coordinator.reSubscribeListeners();

    // After reSubscribe + completed worker → phase should advance to complete
    await waitForPhase(coordinator, "origin-recover", "complete", 3000);

    // Drain microtasks for injectNote calls
    await new Promise((r) => setTimeout(r, 50));

    const finalLoop = coordinator.getLoopState("origin-recover")!;
    expect(finalLoop.phase).toBe("complete");

    // injectNote should have been called (progress + complete markers)
    const progressNotes = adapter.injectNoteCalls.filter(
      (c) => c.text.includes("[loop-progress"),
    );
    expect(progressNotes.length).toBeGreaterThanOrEqual(1);

    coordinator.dispose();
  });
});

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  createPluginHooks,
  activeLoopManager,
  pendingCorrections,
  userMessagedSessions,
  loopManagerMap,
  managerMap,
} from "../../src/core/composition";
import { STOP_LOOP_SIGNAL } from "../../src/loop/constants";
import { LoopService } from "../../src/core/services/loop-service";
import { hookState } from "../../src/hooks/state";
import type { LoopState } from "../../src/loop/types";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session.ts";

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

const AGENT = "test-agent";

describe("LoopManager integration", () => {
  beforeEach(() => {
    mock.restore();
  });

  describe("Same-origin loop exclusivity", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-recur-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks({ resolvedRoles: [], session: new OpencodeSessionAdapter(client), roleFunctionsMap: new Map(), roleGraphMap: new Map(), directory: tmpDir });
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("rejects |loop| on a session that already has an active loop (same-origin exclusivity)", async () => {
      const sid = "ses_recursion";

      const output1 = {
        parts: [{ type: "text" as const, text: "|loop:3| first loop" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output1,
      );
      expect(activeLoopManager?.isLoopSession(sid)).toBe(true);

      const output2 = {
        parts: [{ type: "text" as const, text: "|loop:5| nested loop attempt" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output2,
      );

      const correction = pendingCorrections.get(sid);
      expect(correction).toContain("loop already active for this session");
    });

    it("does not block |loop| on a fresh non-loop session", async () => {
      const sid = "ses_fresh_loop";

      const output = {
        parts: [{ type: "text" as const, text: "|loop:2| start fresh" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output,
      );

      expect(activeLoopManager?.isLoopSession(sid)).toBe(true);
      const correction = pendingCorrections.get(sid);
      expect(correction ?? "").not.toContain("loop already active for this session");
    });
  });

  describe("Cancellation via user message", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-cancel-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks({ resolvedRoles: [], session: new OpencodeSessionAdapter(client), roleFunctionsMap: new Map(), roleGraphMap: new Map(), directory: tmpDir });
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("shouldCancelOnUserMessage marks cancelRequested on genuine user message", async () => {
      const sid = "ses_cancel_001";

      activeLoopManager!.register({
        originSessionId: sid,
        agent: AGENT,
        prompt: "do the loop thing",
        mode: "fresh",
        iterations: 5,
      });

      // Set phase to awaitable state for cancellation
      const loopState = activeLoopManager!.getLoopState(sid)!;
      loopState.phase = "awaiting_worker";

      const output = {
        parts: [{ type: "text" as const, text: STOP_LOOP_SIGNAL }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output,
      );

      expect(activeLoopManager!.getLoopState(sid)!.cancelRequested).toBe(true);
      expect(userMessagedSessions.has(sid)).toBe(true);
    });
  });
});

// ── Integration: dispose+init round advancement ──────────────────────────────
//
// Subtask 3 — end-to-end verification that a registered loop survives
// LoopService.dispose() + LoopService.init() (simulating hot-reload) and
// advances from round 1 to round 2 via the reSubscribeListeners → _advanceFromSummarizing
// path.  This is the E2E proof that subtask 1's hookState cleanup fix enables
// cross-lifecycle loop progression.

/**
 * Create a complete mock suite for testing LoopService dispose+init.
 *
 * Two layers are mocked:
 *  1. dispatchManager — provides launch/getTask/getResult/listener registration
 *  2. OpencodeClient (ctx.client) — feeds OpencodeSessionAdapter for
 *     readOriginSummary / injectNote
 *
 * A `tasks` map tracks dispatched worker tasks across both lifecycles so
 * the second init's reconcile query returns the correct status.
 */
function createDisposeInitMocks(tmpDir: string) {
  const tasks = new Map<string, { id: string; status: string; sessionId: string }>();
  let taskCounter = 0;

  // ── DispatchManager mock ──────────────────────────────────────────────
  const dispatchManager = {
    getTask: mock((taskId: string) => tasks.get(taskId)),
    launch: mock(async (_input: unknown, _opts: unknown) => {
      taskCounter++;
      const id = `task-${taskCounter}`;
      const sessionId = `session-${taskCounter}`;
      tasks.set(id, { id, status: "running", sessionId });
      return { id, sessionId };
    }),
    getResult: mock(async (_taskId: string) => ({
      kind: "ok" as const,
      text: "worker output",
      error: undefined,
    })),
    cancelTask: mock(async () => {}),
    onTaskTerminated: mock((_taskId: string, cb: (taskId: string, status: string) => void) => cb),
    removeTaskTerminatedListener: mock(() => {}),
  };

  // ── DispatchService mock ──────────────────────────────────────────────
  const dispatchService = {
    health: mock(() => ({ status: "healthy" })),
    getDispatchManager: mock(() => dispatchManager),
  };

  // ── PluginCore mock ───────────────────────────────────────────────────
  const core = {
    getService: mock((name: string) =>
      name === "dispatch-service" ? dispatchService : undefined,
    ),
    getServices: mock(() => new Map()),
    restartService: mock(() => Promise.resolve()),
    isDegraded: mock(() => false),
  };

  // ── OpencodeClient mock ───────────────────────────────────────────────
  // OpencodeSessionAdapter wraps this client; we must match its call shapes.
  const client = {
    session: {
      messages: mock((_opts: unknown) =>
        Promise.resolve({
          data: [
            {
              info: {
                id: "msg-1",
                sessionID: "origin",
                role: "assistant" as const,
                time: { created: Date.now() },
              },
              parts: [
                {
                  id: "p1",
                  sessionID: "origin",
                  messageID: "msg-1",
                  type: "text" as const,
                  text: "Round output for summary.",
                },
              ],
            },
          ],
          error: undefined,
        }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: { id: "note-1" }, error: undefined }),
      ),
      // Stubs — not called by the tested paths but required by
      // OpencodeSessionAdapter constructor signature
      create: mock(() => Promise.resolve({ data: null, error: undefined })),
      prompt: mock(() => Promise.resolve({ data: { parts: [] }, error: undefined })),
      status: mock(() => Promise.resolve({ data: {}, error: undefined })),
      abort: mock(() => Promise.resolve({ data: true, error: undefined })),
      get: mock(() => Promise.resolve({ data: null, error: undefined })),
      delete: mock(() => Promise.resolve({ data: true, error: undefined })),
      list: mock(() => Promise.resolve({ data: [], error: undefined })),
      children: mock(() => Promise.resolve({ data: [], error: undefined })),
      todo: mock(() => Promise.resolve({ data: [], error: undefined })),
      diff: mock(() => Promise.resolve({ data: [], error: undefined })),
      fork: mock(() => Promise.resolve({ data: null, error: undefined })),
    },
  } as unknown as OpencodeClient;

  // ── PluginContext mock (cast-broad, same pattern as loop-service-dispose.test.ts) ──
  const sessionAdapter = new OpencodeSessionAdapter(client);
  const ctx = {
    directory: tmpDir,
    rawDirectory: tmpDir,
    core,
    session: sessionAdapter,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    bus: { on: mock(() => {}), emit: mock(() => {}), off: mock(() => {}) },
  } as any;

  return { ctx, dispatchManager, tasks, client };
}

/** Wait for microtask queue to drain (self-start kickoff / promise scheduling). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("LoopService dispose+init round advancement", () => {
  let svc: LoopService;
  let tmpDir: string;
  let mocks: ReturnType<typeof createDisposeInitMocks>;

  beforeEach(() => {
    svc = new LoopService();
    tmpDir = mkdtempSync(join(tmpdir(), "loop-dispose-init-"));
    hookState.loopManagerMap.clear();
    hookState.loopStoreMap.clear();
    hookState.activeLoopManager = undefined;
    mocks = createDisposeInitMocks(tmpDir);
  });

  afterEach(() => {
    hookState.loopManagerMap.clear();
    hookState.loopStoreMap.clear();
    hookState.activeLoopManager = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("survives dispose+init and advances from round 1 to round 2", async () => {
    const { ctx, dispatchManager, tasks } = mocks;
    const ORIGIN_SID = "advance-origin";

    // ═══════════════════════════════════════════════════════════════════
    // Phase 1 — First init: create coordinator, register loop, dispatch
    //            round 1
    // ═══════════════════════════════════════════════════════════════════
    await svc.init(ctx);
    const firstCoordinator = svc.getLoopManager();

    firstCoordinator.register({
      originSessionId: ORIGIN_SID,
      agent: "test-agent",
      prompt: "Do the loop work",
      mode: "inherit",
      iterations: 3,
    });

    // Self-start microtask dispatches round 1
    await flushMicrotasks();

    let state: LoopState = firstCoordinator.getLoopState(ORIGIN_SID)!;
    expect(state.phase).toBe("awaiting_worker");
    expect(state.current).toBe(1);
    expect(state.activeWorkerTaskId).toBe("task-1");
    // Round 1 dispatch was recorded
    expect(state.rounds?.length).toBe(1);
    expect(state.rounds![0]!.round).toBe(1);

    // ═══════════════════════════════════════════════════════════════════
    // Phase 2 — dispose + mock round-1 as completed + re-init
    // ═══════════════════════════════════════════════════════════════════
    await svc.dispose();

    // Verify hookState cleanup (subtask 1 fix)
    expect(hookState.loopManagerMap.has(tmpDir)).toBe(false);
    expect(hookState.loopStoreMap.has(tmpDir)).toBe(false);
    expect(hookState.activeLoopManager).toBeUndefined();

    // Mark task-1 as completed so reconcile promotes phase to summarizing
    const task1 = tasks.get("task-1");
    expect(task1).toBeDefined();
    task1!.status = "completed";

    // Second init: loads persisted state, reconciles, re-subscribes,
    // and advances the loop through summarizing → dispatching round 2.
    await svc.init(ctx);
    // The init() call awaits reSubscribeListeners, which calls
    // _advanceFromSummarizing synchronously inside its await —
    // no additional microtask flush needed for this path.

    // ═══════════════════════════════════════════════════════════════════
    // Phase 3 — Assert the loop advanced to round 2
    // ═══════════════════════════════════════════════════════════════════
    const secondCoordinator = svc.getLoopManager();

    // Ensures a fresh LoopCoordinator was created (not stale fast-path)
    expect(secondCoordinator).not.toBe(firstCoordinator);

    state = secondCoordinator.getLoopState(ORIGIN_SID)!;
    expect(state).toBeDefined();
    expect(state.phase).toBe("awaiting_worker");
    expect(state.current).toBe(2);
    expect(state.activeWorkerTaskId).toBe("task-2");
    // Round 2 record should exist
    expect(state.rounds?.length).toBe(2);
    expect(state.rounds![1]!.round).toBe(2);

    // Verify dispatch was called for both rounds
    const launchCalls = (dispatchManager.launch as ReturnType<typeof mock>).mock
      .calls;
    expect(launchCalls.length).toBe(2);

    // [loop-progress] note was injected once (only on round 1)
    const injectCalls = (
      mocks.client.session.promptAsync as ReturnType<typeof mock>
    ).mock.calls;
    const progressNotes = injectCalls.filter(
      ([args]: any[]) =>
        args.body?.parts?.[0]?.text?.includes("[loop-progress"),
    );
    expect(progressNotes.length).toBe(1);
  });

  it("stays at awaiting_worker when task is still running after dispose+init", async () => {
    const { ctx, tasks } = mocks;
    const ORIGIN_SID = "still-running-origin";

    // First init: register loop, dispatch round 1
    await svc.init(ctx);
    const coordinator = svc.getLoopManager();
    coordinator.register({
      originSessionId: ORIGIN_SID,
      agent: "test-agent",
      prompt: "still running",
      mode: "fresh",
      iterations: 3,
    });
    await flushMicrotasks();

    const state1 = coordinator.getLoopState(ORIGIN_SID)!;
    expect(state1.phase).toBe("awaiting_worker");
    expect(state1.activeWorkerTaskId).toBe("task-1");

    // Dispose without marking task completed — status stays "running"
    await svc.dispose();

    // Re-init: reconcile sees task-1 as "running" → keeps phase
    // "awaiting_worker"; reSubscribeListeners re-subscribes listener.
    await svc.init(ctx);

    const state2 = svc.getLoopManager().getLoopState(ORIGIN_SID)!;
    expect(state2).toBeDefined();
    expect(state2.phase).toBe("awaiting_worker");
    expect(state2.current).toBe(1);
    expect(state2.activeWorkerTaskId).toBe("task-1");
    // Verify that onTaskTerminated was called to re-subscribe
    const regCalls = (
      mocks.dispatchManager.onTaskTerminated as ReturnType<typeof mock>
    ).mock.calls;
    expect(regCalls.length).toBe(2); // first init + re-subscribe
    expect(regCalls[1]![0]).toBe("task-1");
  });
});

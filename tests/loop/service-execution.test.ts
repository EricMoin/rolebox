/**
 * Simulated E2E through the hook path: `|loop:2|` fed into `hooks["chat.message"]`
 * drives a real `createPluginHooks` stack (real `PluginCore` + `LoopService` +
 * `DispatchAdapter` + `OpencodeSessionAdapter`) against a stateful
 * `DispatchManager` mock and a stateful opencode client mock.
 *
 * The DispatchManager mock is injected via `hookState.managerMap` (keyed by the
 * raw directory), so `DispatchService.init` reuses it instead of constructing a
 * real manager — the rest of the stack is production code. The loop then runs
 * the real push chain: kickoff dispatches task-1/session-1, firing its stored
 * fire-once terminated listener advances to task-2/session-2, and firing that
 * one finalizes the loop.
 *
 * Also asserts (against src/loop/dispatch-adapter.ts) that `dispatchRound`
 * forwards `timeoutMs` into `DispatchInput.timeout_ms` when provided.
 */

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
import { hookState } from "../../src/hooks/state";
import { functionSessionState } from "../../src/function/session-state";
import { DispatchAdapter } from "../../src/loop/dispatch-adapter";
import { DISPATCH_ROUND_TIMEOUT_MS, LOOP_PROGRESS_MARKER } from "../../src/loop/constants";
import type { DispatchInput, DispatchTask } from "../../src/dispatch/types";
import type { DispatchManager } from "../../src/dispatch/core/manager";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session";

const AGENT = "test-agent";

/** Drain the microtask queue (self-start kickoff / promise scheduling). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Poll until `cond()` is true or the deadline passes. Returns success. */
async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  intervalMs = 20,
): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

// ── Stateful DispatchManager + client mocks ────────────────────────────────

interface PromptAsyncCall {
  path: { id: string };
  body: { parts: Array<{ type: string; text: string }>; noReply?: boolean };
}

interface StatefulDispatchMocks {
  dispatchManager: Record<string, unknown>;
  /** taskId → fire-once terminated callback registered by the coordinator. */
  terminatedListeners: Map<string, (taskId: string, status: string) => void>;
  /** Every DispatchInput passed to launch, in order. */
  launchInputs: DispatchInput[];
  /** {id, sessionId} returned by each launch call, in order. */
  launchResults: Array<{ taskId: string; sessionId: string }>;
  /** Every promptAsync call (injected notes), in order. */
  promptAsyncCalls: PromptAsyncCall[];
  /** Session ids returned by client.session.create, in order. */
  createdSessionIds: string[];
  client: OpencodeClient;
}

/**
 * Build a stateful DispatchManager mock plus an opencode client mock.
 *
 * - launch: allocates distinct `task-N` / `session-N` per call (the worker
 *   sessions in the loop flow come from here, not from client.session.create).
 * - onTaskTerminated: stores the callback per task and returns it; NEVER fires
 *   at registration (matches the real DispatchManager).
 * - getResult: returns per-task text `Result for task-N`.
 * - cancelTask: marks the task cancelled.
 * - client.session.create: returns DISTINCT `child-N` ids per call (deliberately
 *   unlike pluginMockClient, which returns a constant "test-child").
 */
function createStatefulDispatchMocks(): StatefulDispatchMocks {
  const tasks = new Map<string, { id: string; sessionId: string; status: string }>();
  const terminatedListeners = new Map<string, (taskId: string, status: string) => void>();
  const launchInputs: DispatchInput[] = [];
  const launchResults: Array<{ taskId: string; sessionId: string }> = [];
  const promptAsyncCalls: PromptAsyncCall[] = [];
  const createdSessionIds: string[] = [];

  let taskSeq = 0;
  let childSeq = 0;

  const dispatchManager = {
    launch: mock(async (input: DispatchInput, _parent: unknown): Promise<DispatchTask> => {
      taskSeq += 1;
      const id = `task-${taskSeq}`;
      const sessionId = `session-${taskSeq}`;
      tasks.set(id, { id, sessionId, status: "running" });
      launchInputs.push(input);
      launchResults.push({ taskId: id, sessionId });
      return {
        id,
        sessionId,
        parentSessionId: "origin",
        depth: 0,
        status: "running",
        agent: input.subagent,
        prompt: input.prompt,
        description: input.description,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      };
    }),
    getResult: mock(async (taskId: string) => {
      const text = `Result for ${taskId}`;
      return {
        kind: "ok" as const,
        text,
        resultText: text,
        hadFence: false,
        totalChars: text.length,
      };
    }),
    cancelTask: mock(async (taskId: string) => {
      const t = tasks.get(taskId);
      if (t) t.status = "cancelled";
      return true;
    }),
    onTaskTerminated: mock((taskId: string, cb: (taskId: string, status: string) => void) => {
      // Store only — never fire at registration (matches DispatchManager).
      terminatedListeners.set(taskId, cb);
      return cb;
    }),
    removeTaskTerminatedListener: mock((taskId: string, cb: (taskId: string, status: string) => void) => {
      if (terminatedListeners.get(taskId) === cb) terminatedListeners.delete(taskId);
    }),
    getTask: mock((taskId: string) => tasks.get(taskId)),
    updateDispatchConfigs: mock(() => {}),
    // Used during service init (ExtensionService bridges recovery snapshots /
    // concurrency policies into the manager) — no-ops for the mock.
    setRecoverySnapshotProvider: mock(() => {}),
    setConcurrencyManager: mock(() => {}),
    getConfig: mock(() => ({ maxConcurrent: 4 })),
    dispose: mock(async () => {}),
    flushPersistSync: mock(() => {}),
  };

  const client = {
    session: {
      create: mock((_args: unknown) => {
        childSeq += 1;
        const id = `child-${childSeq}`;
        createdSessionIds.push(id);
        return Promise.resolve({ data: { id }, error: undefined });
      }),
      promptAsync: mock((args: PromptAsyncCall) => {
        promptAsyncCalls.push(args);
        // opencode promptAsync returns HTTP 204 (void data) on success.
        return Promise.resolve({ data: undefined, error: undefined });
      }),
      prompt: mock(() => Promise.resolve({ data: { parts: [] }, error: undefined })),
      messages: mock(() => Promise.resolve({ data: [], error: undefined })),
      status: mock(() => Promise.resolve({ data: {}, error: undefined })),
      abort: mock(() => Promise.resolve({ data: undefined, error: undefined })),
      get: mock(() => Promise.resolve({ data: { id: "origin" }, error: undefined })),
      delete: mock(() => Promise.resolve({ data: true, error: undefined })),
      list: mock(() => Promise.resolve({ data: [], error: undefined })),
      children: mock(() => Promise.resolve({ data: [], error: undefined })),
      todo: mock(() => Promise.resolve({ data: [], error: undefined })),
      diff: mock(() => Promise.resolve({ data: [], error: undefined })),
      fork: mock(() => Promise.resolve({ data: null, error: undefined })),
    },
  } as unknown as OpencodeClient;

  return {
    dispatchManager,
    terminatedListeners,
    launchInputs,
    launchResults,
    promptAsyncCalls,
    createdSessionIds,
    client,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Loop service E2E via chat.message hook", () => {
  let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
  let tmpDir: string;
  let sid: string;
  let mocks: StatefulDispatchMocks;

  beforeEach(async () => {
    mock.restore();
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-service-exec-"));
    pendingCorrections.clear();
    userMessagedSessions.clear();
    mocks = createStatefulDispatchMocks();
    // Inject the stateful DispatchManager mock — DispatchService.init reuses it
    // from hookState.managerMap instead of building a real manager.
    hookState.managerMap.set(tmpDir, mocks.dispatchManager as unknown as DispatchManager);
    hooks = await createPluginHooks({
      resolvedRoles: [],
      session: new OpencodeSessionAdapter(mocks.client),
      roleFunctionsMap: new Map(),
      roleGraphMap: new Map(),
      directory: tmpDir,
    });
  });

  afterEach(() => {
    void hooks?.dispose?.();
    loopManagerMap.clear();
    hookState.loopStoreMap.clear();
    managerMap.clear();
    hookState.activeLoopManager = undefined;
    hookState.sessionAgentRegistry.clear();
    hookState.autoActivatedSessions.clear();
    pendingCorrections.clear();
    userMessagedSessions.clear();
    if (sid) functionSessionState.clear(sid);
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  /** Simulate DispatchManager.onTaskTerminated: invoke the stored fire-once listener. */
  function fireTerminated(taskId: string, status = "completed"): void {
    const cb = mocks.terminatedListeners.get(taskId);
    expect(cb).toBeDefined();
    cb!(taskId, status);
  }

  it(
    "runs |loop:2| end-to-end: 2 distinct worker sessions, complete phase, completion note",
    async () => {
      sid = "ses_service_exec";
      const output = {
        parts: [{ type: "text" as const, text: "|loop:2| do the work" }],
      };
      await hooks["chat.message"]({ agent: AGENT, sessionID: sid }, output);
      await flushMicrotasks();

      // ── Kickoff dispatched round 1 ────────────────────────────────
      expect(activeLoopManager).toBeDefined();
      let state = activeLoopManager!.getLoopState(sid)!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-1");
      expect(state.activeWorkerSessionId).toBe("session-1");
      expect(mocks.launchInputs.length).toBe(1);

      // ── Round 1 completes → push chain dispatches round 2 ─────────
      fireTerminated("task-1");
      // The coordinator applies the inter-round delay (INTER_ROUND_DELAY_MS),
      // so wait for the second dispatch instead of a bare microtask flush.
      const advanced = await waitFor(() => mocks.launchInputs.length === 2, 6_000);
      expect(advanced).toBe(true);
      await flushMicrotasks();
      state = activeLoopManager!.getLoopState(sid)!;
      expect(state.phase).toBe("awaiting_worker");
      expect(state.activeWorkerTaskId).toBe("task-2");
      expect(state.activeWorkerSessionId).toBe("session-2");

      // ── Round 2 completes → loop finalizes ─────────────────────────
      fireTerminated("task-2");
      const done = await waitFor(
        () => activeLoopManager!.getLoopState(sid)?.phase === "complete",
        3_000,
      );
      expect(done).toBe(true);
      await flushMicrotasks();

      // ── Assertions ─────────────────────────────────────────────────
      const final = activeLoopManager!.getLoopState(sid)!;
      expect(final.phase).toBe("complete");
      expect(final.current).toBe(3);

      // Exactly 2 worker sessions created, with DISTINCT ids.
      expect(mocks.launchInputs.length).toBe(2);
      expect(mocks.launchResults.length).toBe(2);
      expect(mocks.launchResults[0]!.sessionId).not.toBe(
        mocks.launchResults[1]!.sessionId,
      );

      // rounds[] length 2, both completed, distinct workerSessionIds.
      const rounds = final.rounds!;
      expect(rounds.length).toBe(2);
      expect(rounds.map((r) => r.status)).toEqual(["completed", "completed"]);
      expect(rounds[0]!.workerSessionId).not.toBe(rounds[1]!.workerSessionId);
      expect(new Set(rounds.map((r) => r.workerSessionId)).size).toBe(2);

      // A completion note naming both round sessions was injected.
      const notes = mocks.promptAsyncCalls.map((c) => c.body.parts[0]!.text);
      const completion = notes.find((t) => t.includes("loop complete"));
      expect(completion).toBeDefined();
      expect(completion!).toContain(LOOP_PROGRESS_MARKER);
      expect(completion!).toContain("session-1");
      expect(completion!).toContain("session-2");

      // The real DispatchAdapter forwarded the round timeout into
      // DispatchInput.timeout_ms (see src/loop/dispatch-adapter.ts).
      for (const input of mocks.launchInputs) {
        expect(input.timeout_ms).toBe(DISPATCH_ROUND_TIMEOUT_MS);
        expect(input.run_in_background).toBe(true);
        expect(input.noParentInherit).toBe(true);
        expect(input.subagent).toBe(AGENT);
      }
      expect(mocks.launchInputs[0]!.description).toBe("Loop round 1/2");
      expect(mocks.launchInputs[1]!.description).toBe("Loop round 2/2");
    },
    { timeout: 15_000 },
  );

  it("client mock create returns distinct session ids (unlike pluginMockClient's constant id)", async () => {
    const create = mocks.client.session.create as unknown as (
      args: unknown,
    ) => Promise<{ data: { id: string } | null; error?: unknown }>;

    const r1 = await create({});
    const r2 = await create({});

    expect(r1.data?.id).toBeDefined();
    expect(r2.data?.id).toBeDefined();
    expect(r1.data!.id).not.toBe(r2.data!.id);
    expect(mocks.createdSessionIds.length).toBe(2);
    expect(new Set(mocks.createdSessionIds).size).toBe(2);
  });
});

describe("DispatchAdapter timeout_ms forwarding", () => {
  it("spreads timeoutMs into DispatchInput.timeout_ms only when provided", async () => {
    const launch = mock(async (input: DispatchInput): Promise<DispatchTask> => ({
      id: "task-x",
      sessionId: "session-x",
      parentSessionId: "origin",
      depth: 0,
      status: "running",
      agent: input.subagent,
      prompt: input.prompt,
      description: input.description,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    }));
    const adapter = new DispatchAdapter(
      { launch } as unknown as DispatchManager,
      {} as ISessionClient,
    );

    await adapter.dispatchRound({
      originSessionId: "origin",
      agent: AGENT,
      prompt: "p",
      timeoutMs: 42_000,
    });
    await adapter.dispatchRound({ originSessionId: "origin", agent: AGENT, prompt: "p" });

    const calls = (launch as ReturnType<typeof mock>).mock.calls as Array<[DispatchInput]>;
    expect(calls.length).toBe(2);
    expect(calls[0]![0].timeout_ms).toBe(42_000);
    expect(calls[1]![0].timeout_ms).toBeUndefined();
  });
});

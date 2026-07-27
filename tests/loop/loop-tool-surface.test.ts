/// <reference types="bun-types" />

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopService } from "../../src/core/services/loop-service.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { LoopCoordinator } from "../../src/loop/coordinator.ts";
import { createLoopTools } from "../../src/loop/loop-tools.ts";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import { hookState } from "../../src/hooks/state.ts";
import { __resetForTest } from "../../src/logger.ts";

const LOOP_KEYS = [
  "loop_start",
  "loop_status",
  "loop_list",
  "loop_history",
  "loop_output",
  "loop_cancel",
];

function toolContext() {
  return {
    sessionID: "sess-loop-surface-test",
    messageID: "",
    agent: "primary",
    directory: "/tmp",
    worktree: "",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

/** Minimal session client backed by an in-memory message store. */
function makeSessionClient(messages: any[] = []): ISessionClient {
  return {
    list: async () => [],
    get: async () => null,
    messages: async () => messages,
    children: async () => [],
    todo: async () => [],
    diff: async () => [],
    fork: async () => null,
    status: async () => null,
    prompt: async () => {},
    subscribe: async () => () => {},
  } as unknown as ISessionClient;
}

/** Mock IDispatchAdapter so the coordinator's async first-round kickoff resolves cleanly. */
function makeAdapter(): IDispatchAdapter {
  return {
    dispatchRound: async () => ({
      workerTaskId: "task-1",
      workerSessionId: "worker-1",
    }),
    getRoundResult: async () => ({ text: "done", hadError: false }),
    cancelRound: async () => {},
    readOriginSummary: async () => "",
    getLastMessageId: async () => undefined,
    injectNote: async () => {},
    registerTerminatedListener: () => (() => {}),
    removeTerminatedListener: () => {},
    getTaskStatus: async () => "completed",
  };
}

/**
 * Healthy LoopService context (mirrors loop-service-dispose.test.ts). Only
 * init()-accessed properties are populated. No loop_start is executed against
 * this instance, so the fire-and-forget kickoff is never triggered here.
 */
function createMockContext(tmpDir: string) {
  const mockDispatchManager = { getTask: mock(() => undefined) };
  const mockDispatchService = {
    health: mock(() => ({ status: "healthy" })),
    getDispatchManager: mock(() => mockDispatchManager),
  };
  const mockCore = {
    getService: mock((name: string) =>
      name === "dispatch-service" ? mockDispatchService : undefined,
    ),
    getServices: mock(() => new Map()),
    restartService: mock(() => Promise.resolve()),
    isDegraded: mock(() => false),
  };
  return {
    directory: tmpDir,
    rawDirectory: tmpDir,
    core: mockCore,
    client: { session: {} },
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    bus: { on: mock(() => {}), emit: mock(() => {}), off: mock(() => {}) },
  } as any;
}

describe("loop tool surface (opencode path)", () => {
  beforeEach(() => __resetForTest());
  afterEach(() => {
    mock.restore();
    __resetForTest();
  });

  it("ToolService.getTools() contains the six loop_* tools when loop service is healthy", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "loop-surface-"));
    try {
      hookStateReset();
      const svc = new LoopService();
      await svc.init(createMockContext(tmpDir));

      // Exact ToolService.init() assembly: loopToolsOverride from
      // LoopService.getLoopTools() is merged by buildCanonicalTools.
      const tools = buildCanonicalTools({
        sessionClient: makeSessionClient(),
        resolvedRoles: [],
        directory: tmpDir,
        capabilities: { platformId: "opencode", hasSessionCreate: true } as any,
        dispatchToolsOverride: {} as any,
        loopToolsOverride: svc.getLoopTools() as Record<string, any>,
        extraTools: {},
      });

      for (const key of LOOP_KEYS) {
        expect(tools[key]).toBeDefined();
      }
    } finally {
      hookStateReset();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loop tools are CanonicalToolDefs with execute handlers from a healthy LoopService", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "loop-surface-"));
    try {
      hookStateReset();
      const svc = new LoopService();
      await svc.init(createMockContext(tmpDir));

      const contributed = svc.getLoopTools() as Record<string, any>;
      for (const key of LOOP_KEYS) {
        expect(contributed[key]).toBeDefined();
        expect(typeof (contributed[key] as any).execute).toBe("function");
        expect((contributed[key] as any).args).toBeDefined();
        expect((contributed[key] as any).description).toBeTruthy();
      }
    } finally {
      hookStateReset();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("degraded LoopService returns stub loop_* tools (graceful degradation)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "loop-surface-"));
    try {
      hookStateReset();
      const svc = new LoopService();
      // No dispatch-service → service degrades during init.
      await svc.init({
        directory: tmpDir,
        rawDirectory: tmpDir,
        core: { getService: mock(() => undefined) },
        client: { session: {} },
      } as any);

      expect(svc.isDegraded()).toBe(true);
      const tools = svc.getLoopTools() as Record<string, any>;
      for (const key of LOOP_KEYS) {
        expect(tools[key]).toBeDefined();
        const result = await tools[key].execute({}, toolContext());
        expect(result).toContain("not available");
      }
    } finally {
      hookStateReset();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loop_start registers a loop; loop_list/loop_status/loop_cancel round-trip", async () => {
    const coordinator = new LoopCoordinator(makeAdapter());
    const sessionClient = makeSessionClient();
    const tools = createLoopTools(coordinator, sessionClient);

    for (const key of LOOP_KEYS) {
      expect(tools[key]).toBeDefined();
    }

    // ── loop_start registers the origin loop (non-blocking) ─────────
    const startResult = await (tools.loop_start as any).execute(
      { prompt: "fix the bug", iterations: 3 },
      toolContext(),
    );
    expect(startResult).toContain("Loop started");
    expect(startResult).toContain("sess-loop-surface-test");

    const originId = toolContext().sessionID;

    // ── loop_list shows the registered loop ─────────────────────────
    const listResult = await (tools.loop_list as any).execute({});
    expect(listResult).toContain("Loop List");
    expect(listResult).toContain("sess-loop-surface-test");

    // ── loop_status shows round state ───────────────────────────────
    const statusResult = await (tools.loop_status as any).execute(
      { session_id: originId },
      toolContext(),
    );
    expect(statusResult).toContain("Loop Status");
    expect(statusResult).toContain(originId);

    // ── loop_history: no completed rounds yet (phase reflecting kickoff) ──
    const historyResult = await (tools.loop_history as any).execute(
      { session_id: originId },
      toolContext(),
    );
    expect(historyResult).toContain(originId);

    // ── loop_cancel cancels the loop ────────────────────────────────
    const cancelResult = await (tools.loop_cancel as any).execute(
      { session_id: originId },
      toolContext(),
    );
    expect(cancelResult).toContain("Loop cancelled");
  });
});

function hookStateReset() {
  // Clear the shared hook-state caches so repeated LoopService init in tests
  // creates fresh coordinators (mirrors loop-service-dispose.test.ts).
  hookState.loopManagerMap.clear();
  hookState.loopStoreMap.clear();
  hookState.activeLoopManager = undefined;
}

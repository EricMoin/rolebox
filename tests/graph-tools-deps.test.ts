/**
 * graphTools deps wiring tests (subtask 2).
 *
 * Verifies that the graphTools in-flight query reaches the assembled HookDeps
 * on BOTH platforms, backed by the SAME GraphToolSet instance that powers the
 * graph_* tools:
 *   1. buildCanonicalTools binds a prebuilt GraphToolSet (single registry —
 *      the mechanism tool-service / PiLightweightServiceStack rely on).
 *   2. ToolService (opencode) constructs + exposes the toolset; the graph_*
 *      tools and getGraphToolSet() observe the same registry (and hook-service
 *      assembles deps.graphTools from it — see hook-service.ts deps assembly).
 *   3. PiLightweightServiceStack constructs + exposes the toolset; the
 *      compiled graph_* tools and getGraphToolSet() observe the same registry.
 *   4. createPiHookPipeline (Pi) wires deps.graphTools from its options, and
 *      stays backward compatible when no toolset is supplied.
 *
 * @module
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";

import type { OpencodeClient } from "@opencode-ai/sdk";
import { buildCanonicalTools } from "../src/platform/tool-assembly.ts";
import { defaultCapabilities } from "../src/platform/capabilities.ts";
import { createGraphToolSet } from "../src/graph/tools/index.ts";
import { PluginCore } from "../src/core/plugin-core.ts";
import { HotReloadService } from "../src/core/services/hot-reload-service.ts";
import { DispatchService } from "../src/core/services/dispatch-service.ts";
import { LoopService } from "../src/core/services/loop-service.ts";
import { LspService } from "../src/core/services/lsp-service.ts";
import { NotificationService } from "../src/core/services/notification-service.ts";
import { SessionService } from "../src/core/services/session-service.ts";
import { RecoveryService } from "../src/core/services/recovery-service.ts";
import { ExtensionService } from "../src/core/services/extension-service.ts";
import { ToolService } from "../src/core/services/tool-service.ts";
import { HookService } from "../src/core/services/hook-service.ts";
import { HealthMonitorService } from "../src/core/services/health-monitor-service.ts";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import { createPiHookPipeline } from "../src/platform/adapters/pi/hook-pipeline.ts";
import { PiEventBridge } from "../src/platform/adapters/pi/event-bridge.ts";
import { OpencodeSessionAdapter } from "../src/platform/adapters/opencode/session.ts";
import type { ResolvedRole, ResolvedFunction } from "../src/types.ts";
import { RoleMode } from "../src/constants.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { LoopCoordinator } from "../src/loop/coordinator.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeDispatchManager(): DispatchManager {
  return {
    getTasksByParent: () => [],
    getTask: () => undefined,
    getEventState: () => new Map(),
    // The graph engine constructs a BudgetBridge from the manager's budget
    // tracker when building an engine (graph_create → createEngine), so a
    // tracker-shaped stub is required even for non-dispatch construction.
    getBudgetTracker: () => ({
      isRequestBudgetExceeded: () => ({ exceeded: false }),
      getRequestUsage: () => ({ tokens: 0 }),
      getStatus: () => ({}),
    }) as never,
  } as unknown as DispatchManager;
}

function makeSessionClient(): ISessionClient {
  return {
    list: async () => [],
    messages: async () => [],
    prompt: async () => ({ id: "s" }),
    create: async () => null,
    get: async () => null,
    status: async () => ({ type: "idle" }),
  } as unknown as ISessionClient;
}

function makeLoopManager(): LoopCoordinator {
  return {
    isActiveLoopOrigin: () => false,
    isLoopSession: () => false,
    getLoopState: () => undefined,
  } as unknown as LoopCoordinator;
}

function makeRole(): ResolvedRole {
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A test role",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

function makePrimaryRole(): ResolvedRole {
  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
    } as never,
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

function makeMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
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
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

const NO_GRAPHS = "No graphs exist. Call graph_create to open a graph registry slot.";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-gtd-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  mock.restore();
});

// ── (1) buildCanonicalTools reuses a prebuilt toolset ───────────────────────

describe("buildCanonicalTools — graphTools reuse", () => {
  it("binds the graph_* tools to the prebuilt GraphToolSet (single registry)", async () => {
    const prebuilt = createGraphToolSet({ manager: makeDispatchManager() });
    const tools = buildCanonicalTools({
      resolvedRoles: [makeRole()],
      directory: process.cwd(),
      capabilities: defaultCapabilities(),
      dispatchManager: makeDispatchManager(),
      graphTools: prebuilt,
    });

    // graph_create through the assembled tool writes into the PREBUILT registry.
    const result = await (tools.graph_create as never as {
      execute: (args: unknown, ctx: unknown) => Promise<string>;
    }).execute({ name: "shared" }, { sessionID: "s1" });
    expect(result).toContain("shared");
    expect(prebuilt.graph_status({})).toContain("shared");

    // A fresh toolset is untouched → the tools did NOT construct their own.
    expect(createGraphToolSet().graph_status({})).toBe(NO_GRAPHS);
  });

  it("falls back to an internal toolset when no graphTools option is supplied (backward compatible)", async () => {
    const tools = buildCanonicalTools({
      resolvedRoles: [makeRole()],
      directory: process.cwd(),
      capabilities: defaultCapabilities(),
      dispatchManager: makeDispatchManager(),
    });
    await (tools.graph_create as never as {
      execute: (args: unknown, ctx: unknown) => Promise<string>;
    }).execute({ name: "internal" }, { sessionID: "s1" });
    expect(tools.graph_status).toBeDefined();
  });
});

// ── (2) ToolService — opencode assembly path ────────────────────────────────

describe("ToolService — opencode graphTools path", () => {
  it("constructs the toolset, exposes it via getGraphToolSet(), and the graph_* tools share its registry", async () => {
    const client = makeMockClient();
    const core = new PluginCore();
    core.registerService(new HotReloadService());
    core.registerService(new DispatchService());
    core.registerService(new LoopService());
    core.registerService(new LspService());
    core.registerService(new NotificationService());
    core.registerService(new SessionService());
    core.registerService(new RecoveryService());
    core.registerService(new ExtensionService());
    core.registerService(new ToolService());
    core.registerService(new HookService());
    core.registerService(new HealthMonitorService());

    await core.init({
      session: new OpencodeSessionAdapter(client),
      resolvedRoles: [makePrimaryRole()],
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      roleGraphMap: new Map(),
      rawDirectory: tmpDir,
      directory: tmpDir,
      core,
      bus: core.getBus(),
    });

    try {
      const toolService = core.getService<ToolService>("tool-service")!;
      const toolset = toolService.getGraphToolSet();
      expect(toolset).toBeDefined();
      expect(typeof toolset!.hasInflightGraphsForSession).toBe("function");
      // No in-flight graphs for any session on a fresh toolset.
      expect(toolset!.hasInflightGraphsForSession("s1")).toBe(false);

      // graph_create through the assembled tools writes into the SAME toolset
      // that hook-service reads via getGraphToolSet() → deps.graphTools.
      await (toolService.getTools().graph_create as never as {
        execute: (args: unknown, ctx: unknown) => Promise<string>;
      }).execute({ name: "probe" }, { sessionID: "s1" });
      expect(toolset!.graph_status({})).toContain("probe");

      // The full assembly (hook-service included) initialized without error —
      // its deps.graphTools came from toolService.getGraphToolSet().
      expect(core.getService<HookService>("hook-service")).toBeDefined();
    } finally {
      await core.dispose();
    }
  });
});

// ── (3) PiLightweightServiceStack — Pi toolset ownership ────────────────────

describe("PiLightweightServiceStack — Pi graphTools path", () => {
  it("constructs the toolset, exposes it via getGraphToolSet(), and the compiled graph_* tools share its registry", async () => {
    const registered: string[] = [];
    const mockPi = {
      registerTool: (t: { name: string }) => {
        registered.push(t.name);
      },
      on: () => {},
    };
    const stack = new PiLightweightServiceStack(
      mockPi as never,
      [makeRole()],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeDispatchManager(),
      undefined,
      process.cwd(),
    );

    const toolset = stack.getGraphToolSet();
    expect(toolset).toBeDefined();
    expect(typeof toolset!.hasInflightGraphsForSession).toBe("function");

    await stack.init();
    expect(registered).toContain("graph_create");

    // The compiled graph_create tool writes into the SAME toolset.
    const compiled = stack.getHandlers().tool as Record<string, unknown>;
    const graphCreate = compiled.graph_create as {
      execute: (
        callId: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    await graphCreate.execute("call-1", { name: "pi-probe" }, undefined, undefined, {
      sessionID: "s1",
    });
    expect(toolset!.graph_status({})).toContain("pi-probe");
  });

  it("exposes no toolset when no dispatch manager is supplied (graph gating parity)", () => {
    const stack = new PiLightweightServiceStack(
      { on: () => {} } as never,
      [makeRole()],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // no dispatch manager → no graph tools, no toolset
      undefined,
      process.cwd(),
    );
    expect(stack.getGraphToolSet()).toBeUndefined();
  });
});

// ── (4) createPiHookPipeline — Pi HookDeps assembly ─────────────────────────

describe("createPiHookPipeline — deps.graphTools wiring", () => {
  it("wires deps.graphTools from the shared toolset option", async () => {
    const toolset = createGraphToolSet();
    const bridge = new PiEventBridge();
    const pipeline = await createPiHookPipeline({
      eventBridge: bridge,
      session: makeSessionClient(),
      resolvedRoles: [makeRole()],
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      roleGraphMap: new Map(),
      dispatchManager: makeDispatchManager(),
      loopManager: makeLoopManager(),
      graphTools: toolset,
      dir: tmpDir,
    });

    try {
      expect(pipeline.deps.graphTools).toBe(toolset);
      expect(typeof pipeline.deps.graphTools!.hasInflightGraphsForSession).toBe("function");
      expect(pipeline.deps.graphTools!.hasInflightGraphsForSession("s1")).toBe(false);
    } finally {
      await pipeline.dispose();
    }
  });

  it("omits deps.graphTools when no toolset is supplied (backward compatible)", async () => {
    const bridge = new PiEventBridge();
    const pipeline = await createPiHookPipeline({
      eventBridge: bridge,
      session: makeSessionClient(),
      resolvedRoles: [makeRole()],
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      roleGraphMap: new Map(),
      dispatchManager: makeDispatchManager(),
      loopManager: makeLoopManager(),
      dir: tmpDir,
    });

    try {
      expect(pipeline.deps.graphTools).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  });
});

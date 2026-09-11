/**
 * Pi ↔ opencode tool-surface parity tests (Subtask S11).
 *
 * Asserts that the shared opencode tool surface — the tools ToolService
 * registers on the opencode platform (src/core/services/tool-service.ts:56-107)
 * — is a SUBSET of the tools PiLightweightServiceStack registers on Pi
 * (src/pi-extension.ts:912-967), and that parity is currently EXACT: every
 * shared tool is registered on Pi, and Pi registers nothing outside the
 * documented surface.
 *
 * Documented exceptions — intentionally withheld on BOTH platforms:
 *   - dispatch_*  — bare dispatch calls bypass graph budget accounting,
 *     approval gates, and loop caps (orchestration is graph-only)
 *   - loop_*      — graph_add_loop replaces the bare loop tools
 *   - task_retry  — re-dispatches outside the graph engine (bare-dispatch risk)
 *
 * Documented opencode-only tool (NOT part of the shared surface):
 *   - asset_hot_reload — HotReloadService is a PluginCore service; Pi runs
 *     PiLightweightServiceStack instead and deliberately omits it
 *     (src/pi-extension.ts:917-918)
 *
 * Documented Pi-only tool (NOT part of the shared surface):
 *   - load_role_skill — skill-loading tool registered only on Pi via
 *     pi-extension.ts extraTools (src/pi-extension.ts:952-953); opencode has
 *     its own native skill tool and never registers it
 *     (src/asset/skill-tool.ts:156-159)
 *
 * The Pi side is wired EXACTLY as src/pi-extension.ts wires it (same
 * factories, same overrides, same dispatchManager gate), so the assertions
 * pin the real platform wiring, not a synthetic setup.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import { buildCanonicalTools } from "../src/platform/tool-assembly.ts";
import { defaultCapabilities } from "../src/platform/capabilities.ts";
import { createTaskTools } from "../src/dispatch/query/task-tools.ts";
import { createMemoryUpdateTool } from "../src/memory/tools.ts";
import { createFunctionGraphTool } from "../src/function/function-graph.ts";
import { createSkillComposeTool } from "../src/asset/skill-compose.ts";
import { createLoadRoleSkillTool } from "../src/asset/skill-tool.ts";
import { createContextAssembleTool } from "../src/dispatch/query/context-assemble.ts";
import {
  createAllLspTools,
  LspClientManager,
  LspDocumentManager,
} from "../src/lsp/index.ts";
import type { ResolvedRole } from "../src/types.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { CanonicalToolDef } from "../src/platform/types.ts";

// ── The shared opencode tool surface (the parity contract) ──────────────────

/**
 * Every tool the opencode platform registers, minus opencode-only extras
 * (asset_hot_reload) and the withheld dispatch_* / loop_* / task_retry
 * namespaces.
 *
 * Groups and their registration sites on opencode:
 *   1. Core intersection set   — src/platform/tool-assembly.ts:91-104
 *   2. Session tools           — src/platform/tool-assembly.ts:107-121
 *   3. graph_* engine tools    — src/platform/tool-assembly.ts:160-166
 *   4. task_* surface          — src/core/services/tool-service.ts:87-90
 *      (createTaskTools minus task_retry)
 *   5. Opencode extras shared  — src/core/services/tool-service.ts:91-106
 *      (memory_update, function_graph, skill_compose, context_assemble;
 *      LSP derived below from the shared createAllLspTools factory)
 */
const OPENCODE_SURFACE: readonly string[] = [
  // 1. Core standalone + asset/reference tools (always registered)
  "hashline_read",
  "hashline_edit",
  "memory_write",
  "memory_recall",
  "memory_list",
  "web_search",
  "web_read",
  "web_fetch",
  "signal",
  "interactive_terminal",
  "asset_search",
  "asset_inspect",
  "asset_validate",
  "reference_search",
  // 2. Session tools (registered when a session client is present — always
  //    on both platforms: opencode via SessionService, Pi via PiSessionAdapter)
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "session_diff",
  "session_fork",
  // 3. Graph Execution Engine v2 tools (gated on dispatchManager — both
  //    platforms thread the live DispatchManager)
  "graph_create",
  "graph_add_node",
  "graph_add_edge",
  "graph_add_loop",
  "graph_run",
  "graph_status",
  "graph_cancel",
  "graph_approve",
  // 4. Restored legacy task_* surface (task_retry withheld — see above)
  "task_search",
  "task_budget",
  "task_graph",
  "task_chronology",
  "task_export",
  // 5. Opencode-side extras forwarded to Pi (pi-extension.ts:928-942 mirrors
  //    tool-service.ts:91-106)
  "memory_update",
  "function_graph",
  "skill_compose",
  "context_assemble",
];

/** Withheld on BOTH platforms — documented exceptions to the parity surface. */
const WITHHELD_ON_BOTH: readonly string[] = [
  // dispatch_* — graph-superseded; bare dispatch bypasses graph budget/approval
  "dispatch",
  "dispatch_output",
  "dispatch_cancel",
  "dispatch_metrics",
  "dispatch_status",
  // loop_* — graph_add_loop replaces the bare loop tools
  "loop_start",
  "loop_status",
  "loop_output",
  "loop_history",
  "loop_cancel",
  // task_retry — re-dispatches outside the graph engine (bare-dispatch risk)
  "task_retry",
];

/** Opencode-only tool — deliberately NOT part of the shared surface. */
const OPENCODE_ONLY: readonly string[] = ["asset_hot_reload"];

/**
 * Pi-only tool — registered on Pi but deliberately NOT part of the shared
 * surface (opencode has its own native skill tool, so the name only exists
 * on the Pi platform; wired via pi-extension.ts:952-953).
 */
const PI_ONLY: readonly string[] = ["load_role_skill"];

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeRole(): ResolvedRole {
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A test role for Pi parity tests",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/**
 * Minimal dispatch-manager stub. Construction of the task/graph tool
 * factories never calls manager methods (they are only touched inside
 * execute()); the union of stubs from pi-graph-wiring.test.ts and
 * pi-extras.test.ts covers every construction path.
 */
function makeDispatchManager(): DispatchManager {
  return {
    getAllTasks: () => [],
    getTasksByParent: () => [],
    getTask: () => undefined,
    getEventState: () => new Map(),
  } as unknown as DispatchManager;
}

/** Minimal session-client stub (context_assemble only reads list/messages). */
function makeSessionClient(): ISessionClient {
  return {
    list: async () => [],
    messages: async () => [],
  } as unknown as ISessionClient;
}

// ── Pi wiring mirror (src/pi-extension.ts:912-967) ───────────────────────────

let clientManager: LspClientManager;
let docManager: LspDocumentManager;
let lspNames: string[];

/** taskTools exactly as pi-extension.ts:912 builds them (task_retry omitted). */
function buildTaskTools(): Record<string, CanonicalToolDef> {
  const { task_retry: _omittedTaskRetry, ...taskTools } = createTaskTools(
    makeDispatchManager(),
    process.cwd(),
  );
  void _omittedTaskRetry;
  return taskTools;
}

/** extraTools exactly as pi-extension.ts:928-942 forwards them. */
function buildExtraTools(): Record<string, CanonicalToolDef> {
  const role = makeRole();
  return {
    memory_update: createMemoryUpdateTool(),
    function_graph: createFunctionGraphTool([role]),
    skill_compose: createSkillComposeTool([role]),
    context_assemble: createContextAssembleTool({
      dispatchManager: makeDispatchManager(),
      sessionClient: makeSessionClient(),
      resolvedRoles: [role],
      directory: process.cwd(),
    }),
    ...createAllLspTools(clientManager, docManager),
  };
}

/**
 * The Pi-side extraTools mirror (pi-extension.ts:948-964): the shared extras
 * plus the Pi-only load_role_skill tool. opencode's tool-service.ts never
 * registers load_role_skill (it has a native skill tool), so this builder is
 * used ONLY for the Pi stack — never for the shared-surface self-check.
 */
function buildPiExtraTools(): Record<string, CanonicalToolDef> {
  return {
    ...buildExtraTools(),
    load_role_skill: createLoadRoleSkillTool([makeRole()]),
  };
}

/**
 * The full shared surface the parity contract pins: the explicit opencode
 * surface plus the live lsp_* names (both platforms consume the identical
 * createAllLspTools factory, so lsp parity is structural).
 */
function sharedSurface(): string[] {
  return [...OPENCODE_SURFACE, ...lspNames];
}

/**
 * Initialize the Pi stack with the real pi-extension.ts wiring (taskTools,
 * extraTools, dispatchManager gate) and capture every registered tool name.
 */
async function initPiStack(): Promise<{ registeredNames: string[]; count: number }> {
  const registeredNames: string[] = [];
  const mockPi = {
    registerTool: (toolDef: any) => {
      registeredNames.push(toolDef.name);
    },
    on: () => {},
  };

  const stack = new PiLightweightServiceStack(
    mockPi,
    [makeRole()],
    undefined, // sessionDir
    undefined, // dispatchTools (disabled — graph-only orchestration)
    undefined, // loopTools (disabled — graph_add_loop replaces loop_*)
    buildTaskTools(), // taskTools (task_retry withheld)
    buildPiExtraTools(), // extraTools (shared extras + Pi-only load_role_skill + lsp_*)
    makeDispatchManager(), // dispatchManager — gates the eight graph_* tools
    undefined, // graphNotifyClient (defaults to the Pi session adapter)
    process.cwd(), // stateDir (engine-state persistence)
  );

  const count = await stack.init();
  return { registeredNames, count };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Pi ↔ opencode tool-surface parity (S11)", () => {
  beforeAll(() => {
    // Constructed exactly as src/pi-extension.ts:925-926 does — the two
    // platform-agnostic LSP managers; LspService is not involved.
    clientManager = new LspClientManager(process.cwd());
    docManager = new LspDocumentManager();
    lspNames = Object.keys(createAllLspTools(clientManager, docManager));
  });

  afterAll(async () => {
    // Dispose the LSP managers (mirrors the pi-extension shutdown sequence);
    // both calls are no-ops on a fresh manager and must never throw.
    try {
      docManager.closeAll(clientManager);
    } catch {
      // already disposed
    }
    try {
      await clientManager.shutdownAll();
    } catch {
      // already disposed
    }
  });

  it("the documented shared surface is exactly what the canonical builder emits (contract self-check)", () => {
    // Re-assemble the shared surface from the same factories both platforms
    // consume (buildCanonicalTools + shared overrides, minus asset_hot_reload)
    // and pin the documented list to the real assembly output.
    const assembled = buildCanonicalTools({
      resolvedRoles: [makeRole()],
      directory: process.cwd(),
      sessionClient: makeSessionClient() as unknown as ISessionClient,
      capabilities: defaultCapabilities(),
      dispatchManager: makeDispatchManager(),
      taskToolsOverride: buildTaskTools() as never,
      extraTools: buildExtraTools() as never,
      stateDir: process.cwd(),
    });
    const assembledKeys = Object.keys(assembled).sort();
    const surface = sharedSurface().sort();

    expect(surface).toEqual(assembledKeys);
  });

  it("registers the full shared opencode tool surface on Pi (surface ∪ PI_ONLY ⊆ Pi)", async () => {
    const { registeredNames, count } = await initPiStack();
    const expected = [...sharedSurface(), ...PI_ONLY];

    // The documented surface ∪ PI_ONLY has no duplicate names (so the
    // exact-count assertion below cannot pass vacuously).
    expect(new Set(expected).size).toBe(expected.length);

    for (const name of expected) {
      expect(registeredNames).toContain(name);
    }

    expect(count).toBe(expected.length);
  });

  it("registers nothing outside surface ∪ PI_ONLY (exact parity, no undocumented extras)", async () => {
    const { registeredNames } = await initPiStack();
    const surfaceSet = new Set(sharedSurface());
    const piOnlySet = new Set(PI_ONLY);

    for (const name of registeredNames) {
      expect(surfaceSet.has(name) || piOnlySet.has(name)).toBe(true);
    }
    expect(registeredNames.length).toBe(surfaceSet.size + piOnlySet.size);
  });

  it("withholds the documented exceptions on Pi (dispatch_*, loop_*, task_retry, asset_hot_reload)", async () => {
    const { registeredNames } = await initPiStack();

    for (const name of [...WITHHELD_ON_BOTH, ...OPENCODE_ONLY]) {
      expect(registeredNames).not.toContain(name);
    }
  });

  it("the documented surface itself excludes the withheld names and the opencode-only/Pi-only tools (contract self-check)", () => {
    const surface = new Set(sharedSurface());

    for (const name of [...WITHHELD_ON_BOTH, ...OPENCODE_ONLY, ...PI_ONLY]) {
      expect(surface.has(name)).toBe(false);
    }
  });
});

/**
 * Pi service stack — `extraTools` channel tests (Subtask S2).
 *
 * Verifies the optional `extraTools?: Record<string, CanonicalToolDef>`
 * constructor param (7th positional arg, after taskTools):
 *   1. init() merges the extra tools into the assembled surface via
 *      buildCanonicalTools({ extraTools }) — all four register through
 *      pi.registerTool with their canonical names (memory_update,
 *      function_graph, skill_compose, context_assemble).
 *   2. Each extra tool executes with a mock CanonicalToolContext.
 *   3. dispatch_* and loop_* stay disabled (bare-dispatch prevention holds
 *      when extraTools is present).
 *
 * Mirrors the opencode-side wiring at src/core/services/tool-service.ts:91-106,
 * restricted to the four Pi-eligible tools (LSP + asset_hot_reload are
 * opencode-only and intentionally not forwarded).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import {
  createMemoryUpdateTool,
  createMemoryWriteTool,
} from "../src/memory/tools.ts";
import { createFunctionGraphTool } from "../src/function/function-graph.ts";
import { createSkillComposeTool } from "../src/asset/skill-compose.ts";
import { createContextAssembleTool } from "../src/dispatch/query/context-assemble.ts";
import { SkillScope, FunctionSource } from "../src/constants.ts";
import type {
  ResolvedRole,
  ResolvedSkill,
  ResolvedFunction,
  ResolvedReference,
} from "../src/types.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";

// ── Expected tool surface ───────────────────────────────────────────────────

/** The four extra tools this channel forwards (mirrors tool-service.ts:91-106). */
const EXTRA_TOOL_NAMES = [
  "memory_update",
  "function_graph",
  "skill_compose",
  "context_assemble",
];

/** Legacy no-manager tool set (mirrors tests/pi-service-stack.test.ts). */
const REQUIRED_TOOLS = [
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
  "reference_search",
  "session_list",
  "session_read",
  "session_info",
  "session_diff",
  "session_fork",
];

const OPTIONAL_TOOLS = ["asset_validate", "session_search"];

const DISPATCH_TOOLS_WITHHELD = [
  "dispatch",
  "dispatch_output",
  "dispatch_cancel",
  "dispatch_metrics",
  "dispatch_status",
];

const LOOP_TOOLS_WITHHELD = [
  "loop_start",
  "loop_status",
  "loop_output",
  "loop_history",
  "loop_cancel",
];

const BASE_TOOL_COUNT = REQUIRED_TOOLS.length + OPTIONAL_TOOLS.length; // 20

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Role carrying one function and one skill so the function_graph,
 * skill_compose, and context_assemble tools have something to render/match.
 */
function makeRole(): ResolvedRole {
  const references: ResolvedReference[] = [];
  const skills: ResolvedSkill[] = [
    {
      name: "graph-visualiser",
      description: "Renders dependency graphs for the rolebox graph engine",
      scope: SkillScope.Rolebox,
      filePath: "/skills/graph-visualiser/SKILL.md",
      references,
    },
  ];
  const functions: ResolvedFunction[] = [
    {
      name: "render-graph",
      description: "Renders the function dependency graph for a role",
      content: "Renders dependency graphs.",
      filePath: "/functions/render-graph.md",
      source: FunctionSource.RoleLocal,
      requires: ["hashline_read"],
      produces: "graph-render",
    },
  ];
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A test role for Pi extraTools tests",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills,
    functions,
    references,
    subagents: [],
  };
}

/** Mock CanonicalToolContext (the shape tools receive from the platform). */
function makeContext(dir: string): CanonicalToolContext {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test-agent",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

/**
 * Minimal dispatch-manager stub for context_assemble's task source.
 * The tool only calls getAllTasks() when it exists (typeof guard) — and the
 * graph/loop toolset is NOT created because the stack gets no dispatchManager.
 */
function makeDispatchManager(): DispatchManager {
  return { getAllTasks: () => [] } as unknown as DispatchManager;
}

/**
 * Minimal session-client stub for context_assemble's session source.
 * The tool only calls list() and messages().
 */
function makeSessionClient(): ISessionClient {
  return {
    list: async () => [],
    messages: async () => [],
  } as unknown as ISessionClient;
}

/** Build the exact extraTools record pi-extension.ts forwards. */
function buildExtraTools() {
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
  };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("PiLightweightServiceStack extraTools channel", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-extras-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // already removed
    }
  });

  it("registers the 4 extra tools via pi.registerTool and keeps dispatch_*/loop_* disabled", async () => {
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
      undefined, // taskTools
      buildExtraTools(), // extraTools
    );

    const count = await stack.init();

    // Additive merge: legacy 19-tool surface + the 4 extra tools = 23.
    expect(count).toBe(BASE_TOOL_COUNT + EXTRA_TOOL_NAMES.length);

    for (const name of EXTRA_TOOL_NAMES) {
      expect(registeredNames).toContain(name);
    }

    // dispatch_*/loop_* stay withheld even with extraTools present.
    for (const name of [...DISPATCH_TOOLS_WITHHELD, ...LOOP_TOOLS_WITHHELD]) {
      expect(registeredNames).not.toContain(name);
    }

    // No tools beyond the known surface.
    const allKnown = new Set([
      ...REQUIRED_TOOLS,
      ...OPTIONAL_TOOLS,
      ...EXTRA_TOOL_NAMES,
    ]);
    for (const name of registeredNames) {
      expect(allKnown.has(name)).toBe(true);
    }
  });

  it("memory_update executes with a mock CanonicalToolContext", async () => {
    const ctx = makeContext(tempDir);

    // Seed a memory through the shared write tool so update has a target.
    const writeTool = createMemoryWriteTool();
    const writeResult = (await writeTool.execute(
      {
        title: "Pi Extra Memory",
        content: "original content",
        scope: "role",
        category: "note",
        relevance: "medium",
      },
      ctx,
    )) as string;
    const idMatch = writeResult.match(/ID:\s*(\S+)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const updateTool = createMemoryUpdateTool();
    const result = await updateTool.execute(
      { id, content: "updated content" },
      ctx,
    );
    expect(result).toBe(`Memory ${id} updated.`);

    // Non-existent id fails gracefully (no throw).
    const missing = await updateTool.execute(
      { id: "does-not-exist", title: "nope" },
      ctx,
    );
    expect(missing).toContain("not found");
  });

  it("function_graph executes with a mock CanonicalToolContext", async () => {
    const tool = createFunctionGraphTool([makeRole()]);
    const result = await tool.execute(
      { focus: "dependencies" },
      makeContext(tempDir),
    );
    expect(result).toContain("Function Dependency Graph");
    expect(result).toContain("render-graph");
    expect(result).toContain("hashline_read");
  });

  it("skill_compose executes with a mock CanonicalToolContext", async () => {
    const tool = createSkillComposeTool([makeRole()]);
    const result = await tool.execute(
      { skill_names: ["graph-visualiser"], check_conflicts: true },
      makeContext(tempDir),
    );
    expect(result).toContain("Skill Composition Analysis");
    expect(result).toContain("graph-visualiser");
  });

  it("context_assemble executes with a mock CanonicalToolContext", async () => {
    const tool = createContextAssembleTool({
      dispatchManager: makeDispatchManager(),
      sessionClient: makeSessionClient(),
      resolvedRoles: [makeRole()],
      directory: tempDir,
    });
    const result = await tool.execute(
      {
        topic: "graph",
        sources: ["memory", "task", "asset", "session"],
        max_tokens: 1000,
      },
      makeContext(tempDir),
    );
    // Asset source matches the role's "graph-visualiser" skill / "render-graph" fn.
    expect(result).toContain("Assembled Context");
    expect(result).toContain("Asset Matches");
    expect(result).toContain("graph-visualiser");
  });
});

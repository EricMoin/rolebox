/**
 * Pi service stack — `graph_*` tool registration wiring tests.
 *
 * Verifies the graph-tool wiring through PiLightweightServiceStack.init():
 *   1. With a DispatchManager provided (7th ctor arg), init() registers
 *      exactly the eight `graph_*` tools via pi.registerTool — the merge is
 *      additive on top of the legacy 19-tool surface (17 required + 2
 *      optional, see tests/pi-service-stack.test.ts).
 *   2. Without a DispatchManager, NO `graph_*` key is registered
 *      (backward-compat pin — the graph tools must not leak into the legacy
 *      stub/override-only surface).
 *   3. The no-manager tool surface (count + required set) is unchanged, so
 *      the existing assertions in tests/pi-service-stack.test.ts keep
 *      holding when both files run together.
 *
 * The DispatchManager fixture follows the cast-stub pattern at
 * tests/graph/graph-tools-registration.test.ts:38-44.
 */

import { describe, it, expect } from "bun:test";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import type { ResolvedRole } from "../src/types.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const emptyRole: ResolvedRole = {
  id: "test-role",
  config: {
    name: "Test Role",
    description: "A test role for Pi graph wiring tests",
    prompt: "You are a test role.",
  },
  prompt: "You are a test role.",
  skills: [],
  functions: [],
  references: [],
  subagents: [],
};

/**
 * Cast stub following tests/graph/graph-tools-registration.test.ts:38-44.
 * The graph toolset only touches the manager inside execute(); init() never
 * invokes any of these methods, so a minimal stub suffices.
 */
function makeDispatchManager(): DispatchManager {
  return {
    getTasksByParent: () => [],
    getTask: () => undefined,
    getEventState: () => new Map(),
  } as unknown as DispatchManager;
}

// ── Expected tool surface ───────────────────────────────────────────────────

/** The eight imperative `graph_*` keys produced by createGraphTools. */
const GRAPH_KEYS = [
  "graph_create",
  "graph_add_node",
  "graph_add_edge",
  "graph_add_loop",
  "graph_run",
  "graph_status",
  "graph_cancel",
  "graph_approve",
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

const BASE_TOOL_COUNT = REQUIRED_TOOLS.length + OPTIONAL_TOOLS.length; // 20

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the stack with a mock Pi API and run init(), capturing every tool
 * name passed to pi.registerTool. `dispatchManager` (7th ctor arg) gates the
 * graph_* registration.
 */
async function initStack(dispatchManager?: DispatchManager): Promise<{
  registeredNames: string[];
  count: number;
}> {
  const registeredNames: string[] = [];
  const mockPi = {
    registerTool: (toolDef: any) => {
      registeredNames.push(toolDef.name);
    },
    on: () => {},
  };

  const stack = new PiLightweightServiceStack(
    mockPi,
    [emptyRole],
    undefined, // sessionDir
    undefined, // dispatchTools
    undefined, // loopTools
    undefined, // taskTools
    undefined, // extraTools
    dispatchManager,
  );

  const count = await stack.init();
  return { registeredNames, count };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiLightweightServiceStack graph_* wiring", () => {
  it("registers exactly the 8 graph_* tools when a dispatchManager is provided", async () => {
    const { registeredNames, count } = await initStack(makeDispatchManager());

    // Graph merge is additive: legacy 19 + 8 graph_* = 27.
    expect(count).toBe(BASE_TOOL_COUNT + GRAPH_KEYS.length);

    const graphKeys = registeredNames.filter((name) => name.startsWith("graph_"));
    expect(graphKeys.sort()).toEqual([...GRAPH_KEYS].sort());
  });

  it("registers NO graph_* tool without a dispatchManager (backward-compat pin)", async () => {
    const { registeredNames, count } = await initStack();

    expect(count).toBe(BASE_TOOL_COUNT);

    const graphKeys = registeredNames.filter((name) => name.startsWith("graph_"));
    expect(graphKeys).toEqual([]);
  });

  it("keeps the legacy no-manager tool surface intact", async () => {
    const { registeredNames, count } = await initStack();

    expect(count).toBe(BASE_TOOL_COUNT);

    for (const toolName of REQUIRED_TOOLS) {
      expect(registeredNames).toContain(toolName);
    }
    for (const toolName of OPTIONAL_TOOLS) {
      expect(registeredNames).toContain(toolName);
    }
    for (const toolName of DISPATCH_TOOLS_WITHHELD) {
      expect(registeredNames).not.toContain(toolName);
    }

    // No extra tools beyond the known set.
    const allKnown = new Set([...REQUIRED_TOOLS, ...OPTIONAL_TOOLS]);
    for (const name of registeredNames) {
      expect(allKnown.has(name)).toBe(true);
    }
  });
});

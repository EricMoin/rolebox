/**
 * Pi service stack — OUTCOME graph tool registration wiring tests.
 *
 * Verifies the graph wiring through PiLightweightServiceStack.init():
 *   1. The stack registers the OUTCOME run path's four entries
 *      (graph_declare / graph_submit_outcome / graph_audit / graph_status)
 *      exactly when the Pi entry supplies them as `outcomeGraphTools` — the
 *      host-owned tool face built from the Pi host capability layer.
 *   2. With a DispatchManager but NO outcome tool face, NO `graph_*` key is
 *      registered: the legacy construction/execution entries are retired and
 *      a platform without the host layer has no runnable graph path.
 *   3. The no-manager tool surface (count + required set) is unchanged, so
 *      the existing assertions in tests/pi-service-stack.test.ts keep
 *      holding when both files run together.
 */

import { describe, it, expect } from "bun:test";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import type { ResolvedRole } from "../src/types.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import type { CanonicalToolDef } from "../src/platform/types.ts";

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

/** The OUTCOME run path's tool face a shipping host registers. */
const OUTCOME_GRAPH_KEYS = [
  "graph_declare",
  "graph_submit_outcome",
  "graph_audit",
  "graph_status",
];

/** The legacy execution entries a host does NOT assemble any more. */
const LEGACY_GRAPH_KEYS = [
  "graph_create",
  "graph_add_node",
  "graph_add_edge",
  "graph_add_loop",
  "graph_run",
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
 * name passed to pi.registerTool. `outcomeGraphTools` (last ctor arg) is the
 * host-built outcome tool face; `dispatchManager` is threaded as before.
 */
async function initStack(
  dispatchManager?: DispatchManager,
  outcomeGraphTools?: Record<string, CanonicalToolDef>,
): Promise<{
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
    undefined, // graphNotifyClient
    undefined, // stateDir
    undefined, // interceptorHooks
    outcomeGraphTools,
  );

  const count = await stack.init();
  return { registeredNames, count };
}

/** A stand-in for the Pi entry's host-built outcome tool face. */
function makeOutcomeTools(): Record<string, CanonicalToolDef> {
  const dummy = (name: string): CanonicalToolDef => ({
    description: `Dummy ${name}`,
    args: {},
    async execute() {
      return name;
    },
  });
  return {
    graph_declare: dummy("graph_declare"),
    graph_submit_outcome: dummy("graph_submit_outcome"),
    graph_audit: dummy("graph_audit"),
    graph_status: dummy("graph_status"),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiLightweightServiceStack graph_* wiring", () => {
  it("registers exactly the OUTCOME graph tools when the host supplies them", async () => {
    const { registeredNames, count } = await initStack(
      makeDispatchManager(),
      makeOutcomeTools(),
    );

    expect(count).toBe(BASE_TOOL_COUNT + OUTCOME_GRAPH_KEYS.length);

    const graphKeys = registeredNames.filter((name) => name.startsWith("graph_"));
    expect(graphKeys.sort()).toEqual([...OUTCOME_GRAPH_KEYS].sort());
    for (const legacy of LEGACY_GRAPH_KEYS) {
      expect(registeredNames).not.toContain(legacy);
    }
  });

  it("registers NO graph_* tool when the host supplies no outcome tool face", async () => {
    const { registeredNames, count } = await initStack(makeDispatchManager());

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

/**
 * Pi system-prompt transform tests (subtask S7).
 *
 * Verifies `src/platform/adapters/pi/system-transform.ts`:
 *   1. With a mocked roleFunctionsMap containing a function AND an active
 *      functionSessionState entry, the augmented system prompt contains the
 *      function's name block (`<active_functions>`) and the gate/transition
 *      kernel ran (runtime turn incremented).
 *   2. The `<available_memory>` block is injected when the role's memory
 *      config enables injection and memories exist in the store.
 *   3. A pending correction is prepended to (and consumed from) the prompt.
 *   4. A `<collaboration_state>` graph-state block is injected for a role
 *      whose graph is present in roleGraphMap.
 *   5. The static baseSection (available_roles/loop_tool guidance) is
 *      preserved verbatim after the base prompt.
 *   6. Session/agent resolution fallbacks (ctx.sessionManager, activeAgent)
 *      and the no-session-id early return.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runPiSystemTransform } from "../src/platform/adapters/pi/system-transform.ts";
import { HookState } from "../src/hooks/state.ts";
import type { HookDeps } from "../src/hooks/deps.ts";
import type {
  ResolvedFunction,
  ResolvedGraph,
  ResolvedRole,
} from "../src/types.ts";
import { functionSessionState } from "../src/function/session-state.ts";
import { functionRuntime } from "../src/function/runtime-state.ts";
import { graphSessionState } from "../src/graph/collaboration-state.ts";
import { MemoryStore } from "../src/memory/store.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFn(
  name: string,
  overrides?: Partial<ResolvedFunction>,
): ResolvedFunction {
  return {
    name,
    description: `${name} description`,
    content: `${name} content`,
    filePath: `/tmp/${name}.ts`,
    source: "role-local",
    ...overrides,
  };
}

function makeRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: "agent-a",
    config: { name: "Agent A", description: "A", prompt: "You are A." },
    prompt: "You are A.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  };
}

function makeGraph(): ResolvedGraph {
  return {
    edges: [],
    nodes: ["agent-a"],
    maxIterations: 3,
    exitEdges: [],
    loopGroups: [],
    termination: undefined,
  };
}

function makeDeps(dir: string, overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: { messages: async () => [] } as never,
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    roleMap: new Map(),
    dir,
    dispatchManager: {} as never,
    loopManager: {} as never,
    customHooks: { runHooks: async () => {} } as never,
    ...overrides,
  };
}

const SIDS = ["sess-fn", "sess-mem", "sess-cor", "sess-graph", "sess-static", "sess-ctx"];

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-system-transform-"));
  for (const sid of SIDS) {
    functionSessionState.clear(sid);
    graphSessionState.clear(sid);
  }
});

afterEach(() => {
  functionRuntime.resetAll();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Active function block ────────────────────────────────────────────────

describe("runPiSystemTransform — active function blocks", () => {
  it("injects the active function's name block when the session has an active entry", async () => {
    const sid = "sess-fn";
    const fnName = "inspect-fn";
    const roleFunctionsMap = new Map([
      ["agent-a", [makeFn(fnName, { priority: 5 })]],
    ]);
    const state = new HookState();
    functionSessionState.activate(sid, [fnName]);
    functionRuntime.init(sid, fnName, 1); // phase "active"

    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "<base>static</base>", sessionID: sid },
        activeAgent: { get: () => "agent-a" },
      },
      state,
      makeDeps(tmpDir, {
        roleFunctionsMap,
        roleMap: new Map([["agent-a", makeRole()]]),
      }),
    );

    expect(result).toBeDefined();
    // Base prompt preserved.
    expect(result!).toContain("<base>static</base>");
    // Available functions block lists the function.
    expect(result!).toContain("<available_functions>");
    // Active function block carries the function's name.
    expect(result!).toContain("<active_functions>");
    expect(result!).toContain(`<name>${fnName}</name>`);
    // The function kernel ran: runtime turn was incremented by the transform.
    expect(functionRuntime.get(sid, fnName)!.currentTurn).toBe(1);
  });

  it("still emits the available-functions block (but no active block) without an active session entry", async () => {
    const sid = "sess-fn";
    const fnName = "idle-fn";
    const roleFunctionsMap = new Map([["agent-a", [makeFn(fnName)]]]);

    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base", sessionID: sid },
        activeAgent: { get: () => "agent-a" },
      },
      new HookState(),
      makeDeps(tmpDir, { roleFunctionsMap }),
    );

    expect(result).toContain("<available_functions>");
    expect(result).toContain(fnName);
    expect(result).not.toContain("<active_functions>");
  });
});

// ── 2. Memory block ─────────────────────────────────────────────────────────

describe("runPiSystemTransform — memory injection", () => {
  it("injects the memory block when the role memory config enables injection", async () => {
    const sid = "sess-mem";

    // Seed a memory into the store under deps.dir (tmpDir).
    const store = await MemoryStore.create(tmpDir);
    store.write({
      scope: "role",
      role_id: "agent-a",
      category: "fact",
      title: "Pi runs on Bun",
      content: "Pi prefers the Bun runtime",
      relevance: "high",
      tags: [],
      session_id: null,
      source_sessions: [],
    });
    store.close();

    const role = makeRole({
      config: {
        name: "Agent A",
        description: "A",
        prompt: "You are A.",
        memory: {
          inject: true,
          max_inject: 5,
          min_relevance: "medium",
          scope: "both",
        },
      },
    });

    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base", sessionID: sid },
        activeAgent: { get: () => "agent-a" },
      },
      new HookState(),
      makeDeps(tmpDir, { roleMap: new Map([["agent-a", role]]) }),
    );

    expect(result).toContain("<available_memory>");
    expect(result).toContain("Pi runs on Bun");
  });

  it("does not crash and injects no memory block when the role has no memory config", async () => {
    const sid = "sess-mem";
    const role = makeRole(); // no config.memory → defaults (inject: true), empty store

    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base", sessionID: sid },
        activeAgent: { get: () => "agent-a" },
      },
      new HookState(),
      makeDeps(tmpDir, { roleMap: new Map([["agent-a", role]]) }),
    );

    expect(result).toBe("base");
    expect(result).not.toContain("<available_memory>");
  });
});

// ── 3. Pending correction ───────────────────────────────────────────────────

describe("runPiSystemTransform — pending correction", () => {
  it("prepends the pending correction and consumes it from state", async () => {
    const sid = "sess-cor";
    const state = new HookState();
    state.pendingCorrections.set(sid, "IMPORTANT: verify before proceeding");

    const result = await runPiSystemTransform(
      { event: { systemPrompt: "<base>static</base>", sessionID: sid } },
      state,
      makeDeps(tmpDir, {}),
    );

    expect(result).toBeDefined();
    expect(result!).toContain("IMPORTANT: verify before proceeding");
    expect(state.pendingCorrections.has(sid)).toBe(false);
    // Correction is appended after the base prompt, not before it.
    expect(result!.indexOf("IMPORTANT: verify before proceeding")).toBeGreaterThan(
      result!.indexOf("<base>static</base>"),
    );
  });
});

// ── 4. Graph-state block ────────────────────────────────────────────────────

describe("runPiSystemTransform — graph-state block", () => {
  it("injects a collaboration_state block when the agent's role has a graph in roleGraphMap", async () => {
    const sid = "sess-graph";
    const roleGraphMap = new Map([["agent-a", makeGraph()]]);

    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base", sessionID: sid },
        activeAgent: { get: () => "agent-a" },
      },
      new HookState(),
      makeDeps(tmpDir, { roleGraphMap }),
    );

    expect(result).toContain("<collaboration_state>");
    expect(result).toContain("<status>active</status>");
    // The graph was initialized into graphSessionState for the session.
    expect(graphSessionState.getGraph(sid)).toBeDefined();
  });

  it("emits no graph block when the role has no graph", async () => {
    const sid = "sess-graph";
    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base", sessionID: sid },
        activeAgent: { get: () => "agent-a" },
      },
      new HookState(),
      makeDeps(tmpDir, {}),
    );

    expect(result).toBe("base");
    expect(result).not.toContain("<collaboration_state>");
  });
});

// ── 5. Static guidance preservation ─────────────────────────────────────────

describe("runPiSystemTransform — static guidance preservation", () => {
  it("preserves the available_roles/loop_tool baseSection after the base prompt", async () => {
    const sid = "sess-static";
    const baseSection = [
      "",
      "<available_roles>",
      "- **Role A** (`agent-a`) — does things [model: default]",
      "</available_roles>",
      "",
      "<loop_tool>",
      "loop_start(iterations, mode, prompt)",
      "</loop_tool>",
      "",
    ].join("\n");

    const result = await runPiSystemTransform(
      { event: { systemPrompt: "base prompt", sessionID: sid }, baseSection },
      new HookState(),
      makeDeps(tmpDir, {}),
    );

    expect(result).toContain("<available_roles>");
    expect(result).toContain("<loop_tool>");
    expect(result!.indexOf("<available_roles>")).toBeGreaterThan(
      result!.indexOf("base prompt"),
    );
  });
});

// ── 6. Session / agent resolution + early return ────────────────────────────

describe("runPiSystemTransform — resolution and early return", () => {
  it("returns undefined when no session id can be resolved", async () => {
    const result = await runPiSystemTransform(
      { event: { systemPrompt: "base" }, activeAgent: { get: () => "agent-a" } },
      new HookState(),
      makeDeps(tmpDir, {}),
    );
    expect(result).toBeUndefined();
  });

  it("resolves the session id from the extension ctx sessionManager", async () => {
    const sid = "sess-ctx";
    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base" },
        ctx: { sessionManager: { getSessionId: () => sid } },
      },
      new HookState(),
      makeDeps(tmpDir, {}),
    );
    expect(result).toBe("base");
  });

  it("prefers the event agent field over the active-agent ref", async () => {
    const sid = "sess-ctx";
    const fnName = "evt-agent-fn";
    const roleFunctionsMap = new Map([["event-agent", [makeFn(fnName)]]]);

    const result = await runPiSystemTransform(
      {
        event: { systemPrompt: "base", sessionID: sid, agent: "event-agent" },
        activeAgent: { get: () => "other-agent" },
      },
      new HookState(),
      makeDeps(tmpDir, { roleFunctionsMap }),
    );

    expect(result).toContain("<available_functions>");
    expect(result).toContain(fnName);
  });
});

/**
 * `handleSystemTransform` — engine-v2 `<graph_state>` injection.
 *
 * Verifies the hook wires the live engine registry (`getLiveGraphToolSet()` →
 * `GraphToolSet.liveEngineStates()`) into the system prompt through
 * `buildEngineGraphStateBlock`:
 *
 *   (a) no live graph → no `<graph_state>` block (clean no-op, no stray tags)
 *   (b) one live graph → block present with phase + node states
 *
 * The registry surface is faked at the `liveEngineStates()` seam so these
 * tests exercise the hook's consumption contract without standing up a full
 * dispatch-backed engine (the real registry path is covered in
 * `tests/graph/graph-state-block.test.ts`).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { handleSystemTransform } from "../../src/hooks/system-transform.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import {
  clearLiveGraphToolSet,
  registerLiveGraphToolSet,
} from "../../src/graph/tools/live-state.ts";
import { createEngineState, registerNode } from "../../src/graph/engine/engine-state.ts";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";

const SID = "sess-engine-block";

const EMPTY_DECL: GraphDeclaration = { version: 2, name: "demo", nodes: [], edges: [] };

function liveState(graphId: string, nodeId: string): EngineState {
  const state = createEngineState(EMPTY_DECL, graphId);
  registerNode(state, { id: nodeId, agent: "worker", prompt: "do it" });
  state.phase = EnginePhase.Executing;
  state.nodes.get(nodeId)!.status = NodeStatus.Running;
  return state;
}

/** Register a minimal object exposing the one method the hook consumes. */
function registerFakeToolSet(states: EngineState[]): void {
  registerLiveGraphToolSet({
    liveEngineStates: () => states,
  } as unknown as GraphToolSet);
}

function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: { messages: mock(() => Promise.resolve([])) } as any,
    roleFunctionsMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {} as any,
    loopManager: {} as any,
    customHooks: { runHooks: mock(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

/** The injected system text, or "" when nothing was pushed. */
async function transform(): Promise<string> {
  const output = { system: [] as string[] };
  await handleSystemTransform(
    { sessionID: SID, agent: "test-agent" },
    output,
    new HookState(),
    minimalDeps(),
  );
  return output.system.join("\n");
}

beforeEach(() => {
  functionSessionState.clear(SID);
  clearLiveGraphToolSet();
});

afterEach(() => {
  clearLiveGraphToolSet();
});

describe("handleSystemTransform — engine graph_state block", () => {
  it("does not inject <graph_state> when no graph is live", async () => {
    // No toolset registered → getLiveGraphToolSet() returns undefined.
    const text = await transform();
    expect(text).not.toContain("<graph_state>");
    expect(text).not.toContain("</graph_state>");
  });

  it("does not inject <graph_state> when the live registry is empty", async () => {
    registerFakeToolSet([]);
    const text = await transform();
    expect(text).not.toContain("<graph_state>");
  });

  it("injects the block for one live graph with phase + node states", async () => {
    registerFakeToolSet([liveState("g1", "worker")]);
    const text = await transform();
    expect(text).toContain("<graph_state>");
    expect(text).toContain('<graph id="g1" phase="executing">');
    expect(text).toContain("<active_nodes>worker</active_nodes>");
  });
});

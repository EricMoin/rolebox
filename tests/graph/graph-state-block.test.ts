/**
 * Graph Execution Engine v2 — `<graph_state>` system-prompt block tests.
 *
 * Covers the pure renderer (`buildEngineGraphStateBlock`) and its integration
 * with the live registry surface (`GraphToolSet.liveEngineStates()`):
 *
 *   (a) no live graph        → "" (no block, no stray tags)
 *   (b) one live graph       → block carries phase + active/pending node state
 *   (c) loop groups / blocked nodes / multiple graphs / escaping
 */

import { describe, it, expect } from "bun:test";
import { buildEngineGraphStateBlock } from "../../src/graph/engine/graph-state-block.ts";
import { createEngineState, registerNode } from "../../src/graph/engine/engine-state.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function decl(name = "demo"): GraphDeclaration {
  return { version: 2, name, nodes: [], edges: [] };
}

/** A state with the named nodes registered (all start `pending`). */
function stateWith(
  graphId: string,
  name: string,
  nodeIds: string[],
): EngineState {
  const state = createEngineState(decl(name), graphId);
  for (const id of nodeIds) {
    registerNode(state, { id, agent: "worker-agent", prompt: "do the thing" });
  }
  return state;
}

// ── (a) No live graph ───────────────────────────────────────────────────────

describe("buildEngineGraphStateBlock — no live graph", () => {
  it("returns an empty string for an empty snapshot list", () => {
    expect(buildEngineGraphStateBlock([])).toBe("");
  });

  it("never emits a stray <graph_state> tag when there is no graph", () => {
    const block = buildEngineGraphStateBlock([]);
    expect(block).not.toContain("<graph_state>");
    expect(block).not.toContain("</graph_state>");
    expect(block).toBe("");
  });
});

// ── (b) One live graph ──────────────────────────────────────────────────────

describe("buildEngineGraphStateBlock — one live graph", () => {
  it("renders the graph id, name, phase and node states", () => {
    const state = stateWith("g1", "demo", ["worker", "queued", "gate"]);
    state.phase = EnginePhase.Executing;
    state.nodes.get("worker")!.status = NodeStatus.Running;
    // "queued" stays pending; "gate" is blocked awaiting approval.
    const gate = state.nodes.get("gate")!;
    gate.status = NodeStatus.Blocked;
    gate.needsApproval = true;

    const block = buildEngineGraphStateBlock([state]);

    expect(block).toContain("<graph_state>");
    expect(block).toContain("</graph_state>");
    expect(block).toContain('<graph id="g1" phase="executing">');
    expect(block).toContain("<name>demo</name>");
    expect(block).toContain("<active_nodes>worker</active_nodes>");
    expect(block).toContain("<pending_nodes>queued</pending_nodes>");
    expect(block).toContain("<blocked_nodes>");
    expect(block).toContain('<node id="gate" needs_approval="true">awaiting human approval</node>');
  });

  it("renders 'none' for empty active/pending sets and omits optional sections", () => {
    const state = stateWith("g2", "empty", []);

    const block = buildEngineGraphStateBlock([state]);

    expect(block).toContain("<active_nodes>none</active_nodes>");
    expect(block).toContain("<pending_nodes>none</pending_nodes>");
    expect(block).not.toContain("<loop_groups>");
    expect(block).not.toContain("<blocked_nodes>");
  });

  it("renders loop-group traversal counts from runtime state", () => {
    const state = stateWith("g3", "looper", ["impl"]);
    state.loopGroups.set("revise", {
      id: "revise",
      maxTraversals: 5,
      traversalCount: 2,
      startTimeMs: 0,
      consecutiveStale: 0,
    });

    const block = buildEngineGraphStateBlock([state]);

    expect(block).toContain("<loop_groups>");
    expect(block).toContain('<loop id="revise" traversals="2/5" />');
  });

  it("uses the blocked node's errorReason when present", () => {
    const state = stateWith("g4", "blocked", ["gate"]);
    const gate = state.nodes.get("gate")!;
    gate.status = NodeStatus.Blocked;
    gate.errorReason = "token budget exceeded";

    const block = buildEngineGraphStateBlock([state]);

    expect(block).toContain("token budget exceeded");
  });
});

// ── (c) Multiple graphs + escaping ──────────────────────────────────────────

describe("buildEngineGraphStateBlock — multiple graphs", () => {
  it("renders one <graph> element per snapshot", () => {
    const a = stateWith("ga", "first", ["a1"]);
    const b = stateWith("gb", "second", ["b1"]);

    const block = buildEngineGraphStateBlock([a, b]);

    expect(block.match(/<graph /g)?.length).toBe(2);
    expect(block).toContain('<graph id="ga"');
    expect(block).toContain('<graph id="gb"');
  });

  it("escapes XML-special characters in user-supplied names", () => {
    const state = stateWith("g5", '<evil & "co">', ["n"]);

    const block = buildEngineGraphStateBlock([state]);

    expect(block).toContain("<name>&lt;evil &amp; &quot;co&quot;&gt;</name>");
    expect(block).not.toContain("<evil");
  });
});

// ── Integration: real registry surface ──────────────────────────────────────

describe("buildEngineGraphStateBlock — live registry integration", () => {
  it("renders a graph created through the real GraphToolSet registry", () => {
    const ts = createGraphToolSet();
    const created = ts.graph_create({ name: "demo" });
    ts.graph_add_node({
      graph_id: created.graph_id,
      id: "worker",
      agent: "tester",
      prompt: "do it",
    });

    const states = ts.liveEngineStates();
    expect(states.length).toBe(1);

    const block = buildEngineGraphStateBlock(states);
    expect(block).toContain(`<graph id="${created.graph_id}" phase="idle">`);
    expect(block).toContain("<name>demo</name>");
    // A freshly provisioned root node is `ready` → surfaced under pending.
    expect(block).toContain("<pending_nodes>worker</pending_nodes>");
  });
});

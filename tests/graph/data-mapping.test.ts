/**
 * Graph v2 — data_passthrough (exclude / max_chars) transform tests.
 *
 * Covers:
 *   1. The pure {@link applyDataMapping} transform (truncation, artifact
 *      exclusion, JSON key exclusion, identity no-op).
 *   2. Engine integration: the advance engine applies an edge's
 *      `data_passthrough` per-edge before recording the upstream result, so a
 *      downstream fan-in node sees the transformed payload.
 */

import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EdgePayload } from "../../src/types.engine-v2.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { applyDataMapping } from "../../src/graph/engine/data-mapping-transform.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";

function makePayload(overrides: Partial<EdgePayload> = {}): EdgePayload {
  return {
    fromNode: "A",
    fromSignal: "answer",
    result: "",
    artifacts: [],
    budgetConsumed: { tokens: 0, cost: 0, sessions: 0 },
    ...overrides,
  };
}

// ── Pure transform ─────────────────────────────────────────────────────────

describe("applyDataMapping (pure)", () => {
  it("returns the payload by reference for no mapping / no applicable field", () => {
    const p = makePayload({ result: "abc" });
    expect(applyDataMapping(p, undefined)).toBe(p);
    expect(applyDataMapping(p, {})).toBe(p);
    expect(applyDataMapping(p, { maxChars: 1000 })).toBe(p); // no truncation needed
  });

  it("truncates result to maxChars characters", () => {
    const p = makePayload({ result: "abcdefghijk" });
    const out = applyDataMapping(p, { maxChars: 5 });
    expect(out.result).toBe("abcde");
    expect(out).not.toBe(p); // cloned when changed
    // original untouched (pure)
    expect(p.result).toBe("abcdefghijk");
  });

  it("removes artifact paths matching an excluded name (full path or basename)", () => {
    const p = makePayload({
      artifacts: ["out/report.md", "internal.json", "src/keep.ts"],
    });
    const out = applyDataMapping(p, { exclude: ["internal.json"] });
    expect(out.artifacts).toEqual(["out/report.md", "src/keep.ts"]);
    // basename match
    const byBase = applyDataMapping(p, { exclude: ["report.md"] });
    expect(byBase.artifacts).toEqual(["internal.json", "src/keep.ts"]);
    // original untouched
    expect(p.artifacts).toHaveLength(3);
  });

  it("drops excluded top-level keys from a parseable JSON result", () => {
    const p = makePayload({ result: JSON.stringify({ ok: true, secret: "x", keep: 1 }) });
    const out = applyDataMapping(p, { exclude: ["secret"] });
    expect(JSON.parse(out.result)).toEqual({ ok: true, keep: 1 });
  });

  it("leaves non-object / malformed JSON results untouched by key-stripping", () => {
    const notObj = applyDataMapping(makePayload({ result: "[1,2,3]" }), { exclude: ["a"] });
    expect(notObj.result).toBe("[1,2,3]");
    const malformed = applyDataMapping(makePayload({ result: "{nope" }), { exclude: ["a"] });
    expect(malformed.result).toBe("{nope");
  });

  it("preserves identity when key-stripping removes nothing", () => {
    const p = makePayload({ result: JSON.stringify({ a: 1 }) });
    // "missing" is not a key in the object → no change → same reference.
    expect(applyDataMapping(p, { exclude: ["missing"] })).toBe(p);
  });
});

// ── Engine integration: per-edge transform on the answer path ──────────────

/** Minimal fake dispatch port (records dispatched node ids, resolves immediately). */
class FakeDispatch implements NodeDispatchPort {
  calls: string[] = [];
  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    const task: DispatchTask = {
      id: `task-${node.nodeId}`,
      sessionId: `sess-${node.nodeId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    return Promise.resolve(task);
  }
}

function linearGraphWithEdge(edge: GraphDeclaration["edges"][number]): GraphDeclaration {
  return {
    version: 2,
    name: "dt-linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [edge],
  };
}

describe("engine integration — max_chars", () => {
  it("truncates the downstream node's collected upstream payload.result", async () => {
    const decl = linearGraphWithEdge({
      from: "A",
      to: "B",
      type: "always",
      data_passthrough: { maxChars: 4 },
    });
    const state = createEngineState(decl, "g-1");
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
    });

    await engine.onNodeSignalEmitted("A", "answer", "abcdefghij");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    const recorded = state.nodes.get("B")!.upstreamResults.get("A")!;
    expect(recorded.result).toBe("abcd");
  });
});

describe("engine integration — exclude from merged fan-in", () => {
  it("drops the excluded JSON key from the fan-in node's collected result", async () => {
    // A and B both fan into F; only A's edge excludes the `secret` key.
    const decl: GraphDeclaration = {
      version: 2,
      name: "dt-fanin",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
        { id: "F", agent: "a3", prompt: "p3", join: { strategy: "all" } },
      ],
      edges: [
        { from: "A", to: "F", type: "always", data_passthrough: { exclude: ["secret"] } },
        { from: "B", to: "F", type: "always" },
      ],
    };
    const state = createEngineState(decl, "g-1");
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
    });

    // Both roots dispatch; A then answers with a JSON object containing secret.
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", JSON.stringify({ ok: true, secret: "x" }));
    await engine.onNodeSignalEmitted("B", "answer", JSON.stringify({ note: "plain" }));

    // A's payload was transformed at the A->F edge; B's was not.
    const aResult = state.nodes.get("F")!.upstreamResults.get("A")!.result;
    expect(JSON.parse(aResult)).toEqual({ ok: true });
    const bResult = state.nodes.get("F")!.upstreamResults.get("B")!.result;
    expect(JSON.parse(bResult)).toEqual({ note: "plain" });

    // The per-source results collected on the fan-in node contain neither a
    // `secret` key nor the excluded source data.
    const collected = [...state.nodes.get("F")!.upstreamResults.values()];
    expect(collected).toHaveLength(2);
    expect(JSON.stringify(collected.map((p) => p.result))).not.toContain("secret");
  });

  it("applies different transforms per edge leaving the same source", async () => {
    // Single source A fanning to two targets with different max_chars each.
    const decl: GraphDeclaration = {
      version: 2,
      name: "dt-twoedge",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
        { id: "C", agent: "a3", prompt: "p3" },
      ],
      edges: [
        { from: "A", to: "B", type: "always", data_passthrough: { maxChars: 3 } },
        { from: "A", to: "C", type: "always", data_passthrough: { maxChars: 6 } },
      ],
    };
    const state = createEngineState(decl, "g-1");
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
    });

    await engine.onNodeSignalEmitted("A", "answer", "abcdefghij");
    expect(state.nodes.get("B")!.upstreamResults.get("A")!.result).toBe("abc");
    expect(state.nodes.get("C")!.upstreamResults.get("A")!.result).toBe("abcdef");
  });
});

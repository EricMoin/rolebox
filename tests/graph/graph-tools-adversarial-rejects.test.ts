/**
 * Graph Execution Engine v2 — Adversarial Tool-Construction Rejection Matrix
 *
 * Test-only coverage expansion (phase: graph-engine test coverage). Exercises
 * the imperative `graph_*` construction tools against adversarial inputs a
 * model can send — inputs that must be rejected EITHER by an up-front
 * client-side guard in graph-tools.ts OR by the structural validator at
 * commit time (validator-v2.ts) — and asserts the atomicity invariant: a
 * failed construction call never mutates the registry declaration.
 *
 * Every rejection case asserts BOTH:
 *   1. the thrown message (regex-anchored to the production error text), and
 *   2. `ts["getEntry"](graph_id).declaration` is unchanged after the failed
 *      call (the registry snapshot pattern used in graph-tools.test.ts).
 *
 * The tool set is constructed WITHOUT a dispatch manager — a bare
 * GraphToolSet({}) suffices because every case here is construction-only
 * (no graph_run, so no engine timers are ever started and no dispose is
 * required — the staleness watcher starts on run()/recover(), not on build).
 *
 * No production code under src/ is modified; nothing here edits the engine.
 */

import { describe, it, expect } from "bun:test";
import {
  createGraphToolSet,
  type GraphToolSet,
} from "../../src/graph/tools/graph-tools";

// ── helpers ───────────────────────────────────────────────────────────────

/** JSON snapshot of the registry declaration — the atomicity probe. */
function declarationSnapshot(ts: GraphToolSet, graphId: string): string {
  return JSON.stringify(ts["getEntry"](graphId).declaration);
}

/**
 * Seed a minimal VALID acyclic topology (entry -> a -> b). Shared by the
 * loop-group rejection cases so the only failure under test is the targeted
 * rule — a freshly created graph is otherwise empty.
 */
function seedAcyclicTopology(ts: GraphToolSet, graphId: string): void {
  ts.graph_add_node({
    graph_id: graphId,
    id: "entry",
    agent: "agent-entry",
    prompt: "seed",
  });
  ts.graph_add_node({ graph_id: graphId, id: "a", agent: "agent-a", prompt: "p" });
  ts.graph_add_node({ graph_id: graphId, id: "b", agent: "agent-b", prompt: "p" });
  ts.graph_add_edge({ graph_id: graphId, from: "entry", to: "a", type: "always" });
  ts.graph_add_edge({ graph_id: graphId, from: "a", to: "b", type: "always" });
}

/**
 * Assert that `fn` throws and that the thrown message matches every pattern.
 * Returns the message so callers can assert on its exact text when needed.
 */
function expectThrows(fn: () => unknown, patterns: RegExp[]): string {
  let message = "";
  try {
    fn();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  for (const pattern of patterns) {
    expect(message).toMatch(pattern);
  }
  return message;
}

// ── (a) graph_add_loop — max_traversals guard ─────────────────────────────

describe("graph_add_loop — max_traversals guard", () => {
  it("rejects max_traversals 0 and -1 (guard fires before commit)", () => {
    for (const maxTraversals of [0, -1]) {
      const ts = createGraphToolSet();
      const { graph_id } = ts.graph_create({ name: "loop-bad-traversals" });
      seedAcyclicTopology(ts, graph_id);
      const before = declarationSnapshot(ts, graph_id);

      // graph-tools.ts:1058 — `max_traversals < 1` guard, thrown up front
      // (before any candidate is built), so the registry is never touched.
      const message = expectThrows(
        () =>
          ts.graph_add_loop({
            graph_id,
            id: "lg",
            nodes: ["a", "b"],
            max_traversals: maxTraversals,
          }),
        [/max_traversals >= 1/],
      );
      expect(message).toContain(`loop group "lg"`);

      // Atomicity: declaration byte-identical; no loop group was committed.
      expect(declarationSnapshot(ts, graph_id)).toBe(before);
      expect(ts["getEntry"](graph_id).declaration.loop_groups).toBeUndefined();
    }
  });
});

// ── (b) graph_add_edge — on_condition guard ───────────────────────────────

describe("graph_add_edge — on_condition guard", () => {
  it('rejects type "on_condition" without a "condition"', () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cond-missing" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    const before = declarationSnapshot(ts, graph_id);

    // graph-tools.ts:1005 — `on_condition` without a condition, thrown up
    // front before the candidate edge is even built.
    const message = expectThrows(
      () => ts.graph_add_edge({ graph_id, from: "a", to: "b", type: "on_condition" }),
      [/no "condition"/],
    );
    expect(message).toContain('edge "a -> b" is type "on_condition"');

    // Atomicity: no edge was committed.
    expect(declarationSnapshot(ts, graph_id)).toBe(before);
    expect(ts["getEntry"](graph_id).declaration.edges).toHaveLength(0);
  });
});

// ── (c) needs_approval node — always outgoing edge (commit-time reject) ───

describe("needs_approval node — outgoing always edge", () => {
  it("rejects at commit via checkApprovalNodeOutgoing (atomic)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "approval-gate" });
    ts.graph_add_node({
      graph_id,
      id: "gate",
      agent: "agent-gate",
      prompt: "Approve the output.",
      needs_approval: true,
    });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    const before = declarationSnapshot(ts, graph_id);

    // The edge itself passes the graph_add_edge client-side guards; the
    // rejection surfaces from commit → validateGraphDeclaration →
    // checkApprovalNodeOutgoing (validator-v2.ts:218) at graph-tools.ts:860.
    const message = expectThrows(
      () => ts.graph_add_edge({ graph_id, from: "gate", to: "b", type: "always" }),
      [
        /failed structural validation/,
        /needs_approval: true/,
        /approval nodes may only have "on_signal" or "on_condition" outgoing edges/,
      ],
    );
    expect(message).toContain('edge "gate -> b" is type "always"');

    // Atomicity: the failed commit left the registry declaration untouched —
    // the always edge was never committed.
    expect(declarationSnapshot(ts, graph_id)).toBe(before);
    expect(ts["getEntry"](graph_id).declaration.edges).toHaveLength(0);
  });
});

// ── (d) loop group over an acyclic node set (commit-time reject) ──────────

describe("graph_add_loop — acyclic node set", () => {
  it("rejects a loop group that does not induce a cycle (atomic)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "loop-acyclic" });
    // entry -> a -> b: a valid DAG. Declaring a "loop" over {a, b} induces
    // only the acyclic edge a -> b, so checkCycleContainment 4a fires.
    seedAcyclicTopology(ts, graph_id);
    const before = declarationSnapshot(ts, graph_id);

    const message = expectThrows(
      () =>
        ts.graph_add_loop({ graph_id, id: "lg", nodes: ["a", "b"], max_traversals: 3 }),
      [/failed structural validation/, /do not form a directed cycle/],
    );
    expect(message).toContain('loop group "lg" declares nodes [a, b]');

    // Atomicity: no loop group was committed.
    expect(declarationSnapshot(ts, graph_id)).toBe(before);
    expect(ts["getEntry"](graph_id).declaration.loop_groups).toBeUndefined();
  });
});

// ── (e) loop group referencing an undeclared node (commit-time reject) ────

describe("graph_add_loop — undeclared node reference", () => {
  it("rejects a loop group naming a ghost node (atomic)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "loop-ghost" });
    seedAcyclicTopology(ts, graph_id);
    const before = declarationSnapshot(ts, graph_id);

    // checkLoopGroupNodeRefs (validator-v2.ts:164) fires. Note: because the
    // ghost node cannot appear in any edge (edges require declared endpoints),
    // the induced subgraph also cannot form a cycle — so the thrown message
    // may legitimately carry BOTH errors. We anchor on the refs rule.
    const message = expectThrows(
      () =>
        ts.graph_add_loop({
          graph_id,
          id: "lg",
          nodes: ["a", "ghost"],
          max_traversals: 3,
        }),
      [/failed structural validation/, /references undeclared node "ghost"/],
    );
    expect(message).toContain('loop group "lg" references undeclared node "ghost"');

    // Atomicity: no loop group was committed.
    expect(declarationSnapshot(ts, graph_id)).toBe(before);
    expect(ts["getEntry"](graph_id).declaration.loop_groups).toBeUndefined();
  });
});

// ── (f) graph_create — name collision suffixing ───────────────────────────

describe("graph_create — name collision suffixing", () => {
  it("assigns unique suffixed ids across three collisions", () => {
    const ts = createGraphToolSet();
    const first = ts.graph_create({ name: "collide" });
    const second = ts.graph_create({ name: "collide" });
    const third = ts.graph_create({ name: "collide" });
    expect(first.graph_id).toBe("collide");
    expect(second.graph_id).toBe("collide-2");
    // Third collision — each registry slot stays independently addressable.
    expect(third.graph_id).toBe("collide-3");
  });
});

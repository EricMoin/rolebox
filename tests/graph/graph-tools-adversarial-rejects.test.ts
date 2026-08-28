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
 * The one exception is the graph_run execution-gate rejection case, where
 * graph_run refuses the graph BEFORE building an engine — the throw happens
 * in the fresh-build validation gate, so no engine/timers are ever created
 * there either.
 *
 * No production code under src/ is modified; nothing here edits the engine.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  createGraphToolSet,
  type GraphToolSet,
} from "../../src/graph/tools/graph-tools";
import { createGraphTools } from "../../src/graph/tools/index";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance";

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

// ── (g) join quorum numeric bounds (commit-time reject via validator rule 9) ─

describe("join quorum bounds — validator rule 9", () => {
  it("rejects quorum 0, negative, and fractional at node-add (atomic)", () => {
    for (const quorum of [0, -1, 1.5]) {
      const ts = createGraphToolSet();
      const { graph_id } = ts.graph_create({ name: "bad-quorum" });
      const before = declarationSnapshot(ts, graph_id);

      // validator-v2.ts checkJoinQuorumBounds — a non-positive-integer quorum
      // would let the fan-in join be satisfied with ZERO upstream answers.
      const message = expectThrows(
        () =>
          ts.graph_add_node({
            graph_id,
            id: "sink",
            agent: "agent-s",
            prompt: "p",
            join: { strategy: "quorum", quorum },
          }),
        [/failed structural validation/, /quorum must be a positive integer/],
      );
      expect(message).toContain('node "sink"');

      // Atomicity: the node was never committed.
      expect(declarationSnapshot(ts, graph_id)).toBe(before);
      expect(ts["getEntry"](graph_id).declaration.nodes).toHaveLength(0);
    }
  });

  it("rejects quorum exceeding the node's in-degree once its first incoming edge exists (atomic)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "quorum-arity" });
    ts.graph_add_node({ graph_id, id: "U1", agent: "agent-u", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "U2", agent: "agent-u", prompt: "p" });
    // Accepted at add time: in-degree is 0 and the arity upper bound is
    // DEFERRED for incremental construction (validator rule 9).
    ts.graph_add_node({
      graph_id,
      id: "sink",
      agent: "agent-s",
      prompt: "p",
      join: { strategy: "quorum", quorum: 5 },
    });
    const before = declarationSnapshot(ts, graph_id);

    // The FIRST incoming edge makes the unsatisfiable quorum visible:
    // quorum:5 > in-degree 1 → commit-time reject, atomic.
    const message = expectThrows(
      () => ts.graph_add_edge({ graph_id, from: "U1", to: "sink", type: "always" }),
      [/failed structural validation/, /exceeds its in-degree \(1\)/],
    );
    expect(message).toContain('node "sink"');

    // Atomicity: the edge was never committed.
    expect(declarationSnapshot(ts, graph_id)).toBe(before);
    expect(ts["getEntry"](graph_id).declaration.edges).toHaveLength(0);
  });
});

// ── (h) per-node budget numeric bounds (commit-time reject via validator rule 10) ─

describe("per-node budget bounds — validator rule 10", () => {
  it("rejects negative budget.timeout_ms and non-nonnegative-integer budget.max_retries (atomic)", () => {
    const cases: { budget: Record<string, number>; patterns: RegExp[] }[] = [
      { budget: { timeout_ms: -1 }, patterns: [/failed structural validation/, /budget.timeout_ms must be a non-negative/] },
      { budget: { max_retries: -1 }, patterns: [/failed structural validation/, /budget.max_retries must be a non-negative integer/] },
      { budget: { max_retries: 1.5 }, patterns: [/failed structural validation/, /budget.max_retries must be a non-negative integer/] },
    ];
    for (const { budget, patterns } of cases) {
      const ts = createGraphToolSet();
      const { graph_id } = ts.graph_create({ name: "bad-budget" });
      const before = declarationSnapshot(ts, graph_id);

      const message = expectThrows(
        () =>
          ts.graph_add_node({
            graph_id,
            id: "a",
            agent: "agent-a",
            prompt: "p",
            budget,
          }),
        patterns,
      );
      expect(message).toContain('node "a"');

      // Atomicity: the node was never committed.
      expect(declarationSnapshot(ts, graph_id)).toBe(before);
      expect(ts["getEntry"](graph_id).declaration.nodes).toHaveLength(0);
    }
  });

  it("rejects negative top-level timeout_ms / max_retries args (atomic)", () => {
    for (const extra of [{ timeout_ms: -1 }, { max_retries: -1 }]) {
      const ts = createGraphToolSet();
      const { graph_id } = ts.graph_create({ name: "bad-arg" });
      const before = declarationSnapshot(ts, graph_id);

      // graph-tools.ts merges the top-level args into node.budget, so the
      // same validator rule 10 fires.
      const message = expectThrows(
        () =>
          ts.graph_add_node({
            graph_id,
            id: "a",
            agent: "agent-a",
            prompt: "p",
            ...extra,
          }),
        [/failed structural validation/],
      );
      expect(message).toContain('node "a"');

      expect(declarationSnapshot(ts, graph_id)).toBe(before);
      expect(ts["getEntry"](graph_id).declaration.nodes).toHaveLength(0);
    }
  });

  it("accepts timeout_ms 0 as the documented disable-watchdog opt-out (budget form AND top-level arg)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "timeout-zero" });
    ts.graph_add_node({
      graph_id,
      id: "a",
      agent: "agent-a",
      prompt: "p",
      budget: { timeout_ms: 0 },
    });
    ts.graph_add_node({
      graph_id,
      id: "b",
      agent: "agent-b",
      prompt: "p",
      timeout_ms: 0,
    });
    const state = ts["getEntry"](graph_id).runtime.status();
    // 0 is the documented per-node "disable staleness" sentinel
    // (engine-recovery.test.ts pins the runtime behavior) — it must stay valid.
    expect(state.graphDeclaration.nodes[0].budget).toEqual({ timeout_ms: 0 });
    expect(state.graphDeclaration.nodes[1].budget).toEqual({ timeout_ms: 0 });
  });

  it("accepts a valid quorum:1 and quorum:2 nodes without incoming edges (incremental construction)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "ok-quorum" });
    ts.graph_add_node({
      graph_id,
      id: "q1",
      agent: "agent-a",
      prompt: "p",
      join: { strategy: "quorum", quorum: 1 },
    });
    // quorum:2 with no incoming edges yet — upper bound deferred (rule 9).
    ts.graph_add_node({
      graph_id,
      id: "q2",
      agent: "agent-b",
      prompt: "p",
      join: { strategy: "quorum", quorum: 2 },
    });
    const state = ts["getEntry"](graph_id).runtime.status();
    expect(state.graphDeclaration.nodes).toHaveLength(2);
  });
});

// ── (i) zod primary guard — join quorum + budget bounds ────────────────────

describe("zod primary guard — graph_add_node args schema", () => {
  // Assemble the full args schema the platform compiles from
  // (createGraphTools wraps each GraphToolSet method with zod).
  const { graph_add_node } = createGraphTools(undefined, { directory: "/tmp" });
  const addNodeSchema = z.object(graph_add_node.args as z.ZodRawShape);

  function rejects(patch: Record<string, unknown>): void {
    const res = addNodeSchema.safeParse({
      graph_id: "g",
      id: "n",
      agent: "a",
      prompt: "p",
      ...patch,
    });
    expect(res.success).toBe(false);
  }

  it("rejects quorum 0, negative, and fractional", () => {
    for (const quorum of [0, -1, 1.5]) {
      rejects({ join: { strategy: "quorum", quorum } });
    }
  });

  it("rejects negative timeout_ms (budget and top-level) and negative/fractional max_retries", () => {
    rejects({ budget: { timeout_ms: -1 } });
    rejects({ timeout_ms: -1 });
    rejects({ budget: { max_retries: -1 } });
    rejects({ max_retries: -1 });
    rejects({ max_retries: 1.5 });
  });

  it("accepts timeout_ms 0 (documented sentinel) and a positive-integer quorum", () => {
    expect(
      addNodeSchema.safeParse({
        graph_id: "g",
        id: "n",
        agent: "a",
        prompt: "p",
        budget: { timeout_ms: 0 },
        timeout_ms: 0,
        join: { strategy: "quorum", quorum: 1 },
      }).success,
    ).toBe(true);
    expect(
      addNodeSchema.safeParse({
        graph_id: "g",
        id: "n",
        agent: "a",
        prompt: "p",
        join: { strategy: "quorum", quorum: 2 },
      }).success,
    ).toBe(true);
  });
});

// ── (j) on_condition edge — condition-vocabulary rule (validator rule 3b) ──

describe("graph_add_edge — on_condition condition vocabulary", () => {
  it("rejects an on_condition edge whose condition is not in the registered vocabulary (atomic)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cond-unknown" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    const before = declarationSnapshot(ts, graph_id);

    // Bug #1 repro: the condition name is extracted with the resolver's
    // CALL_RE pattern; "totally_made_up_condition_xyz" has no `name(arg)`
    // shape, so the whole string is the name — and it is not in
    // KNOWN_CONDITIONS. The rejection surfaces at commit →
    // validateGraphDeclaration → checkEdgeConditionVocabulary
    // (validator-v2.ts, rule 3b).
    const message = expectThrows(
      () =>
        ts.graph_add_edge({
          graph_id,
          from: "a",
          to: "b",
          type: "on_condition",
          condition: "totally_made_up_condition_xyz",
        }),
      [/failed structural validation/, /unknown condition "totally_made_up_condition_xyz"/],
    );
    expect(message).toContain('edge from="a" -> "b" is type "on_condition"');

    // Atomicity: the failed commit left the registry declaration untouched.
    expect(declarationSnapshot(ts, graph_id)).toBe(before);
    expect(ts["getEntry"](graph_id).declaration.edges).toHaveLength(0);
  });

  it("accepts an on_condition edge whose condition is in the registered vocabulary", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cond-known" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });

    // `signal_observed(answer)` matches the CALL_RE `name(arg)` pattern with
    // name `signal_observed` ∈ KNOWN_CONDITIONS — accepted at commit.
    const res = ts.graph_add_edge({
      graph_id,
      from: "a",
      to: "b",
      type: "on_condition",
      condition: "signal_observed(answer)",
    });
    expect(res.type).toBe("on_condition");
    expect(ts["getEntry"](graph_id).declaration.edges).toHaveLength(1);
    expect(ts["getEntry"](graph_id).declaration.edges[0].condition).toBe(
      "signal_observed(answer)",
    );
  });
});

// ── (k) graph_run execution-mode validation gate ─────────────────────────

describe("graph_run — execution-mode validation", () => {
  it("dry_run reports valid=false with the uncontained self-loop cycle error", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dry-selfloop" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    // Self-loop is construct-valid (only a WARNING in construct mode — the
    // builder may declare a loop group afterwards), so commit succeeds.
    ts.graph_add_edge({ graph_id, from: "a", to: "a", type: "always" });

    // Bug #2 repro: dry_run validates under execution severity → the
    // uncontained revise-free self-loop is promoted to an ERROR.
    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.phase).toBe("invalid");
    expect(r.validation?.valid).toBe(false);
    const cycleError = r.validation?.errors.find(
      (msg) => msg.includes("cycle detected") && msg.includes("deadlocks at runtime"),
    );
    expect(cycleError).toBeDefined();
    expect(cycleError).toContain("[a]");
    expect(cycleError).toContain("not contained in any declared loop group");
  });

  it("rejects execution of an uncontained always-cycle before any node is dispatched", async () => {
    let dispatched = 0;
    const seam: NodeDispatchPort = {
      async executeNode() {
        dispatched += 1;
        return { id: `t${dispatched}`, sessionId: `s${dispatched}` } as never;
      },
    };
    const ts = createGraphToolSet({ dispatch: seam });
    const { graph_id } = ts.graph_create({ name: "run-uncontained-cycle" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    // a ⇄ b always-cycle: construct-valid (WARNINGs only) — the graph builds,
    // but a real run must refuse it.
    ts.graph_add_edge({ graph_id, from: "a", to: "b", type: "always" });
    ts.graph_add_edge({ graph_id, from: "b", to: "a", type: "always" });

    await expect(ts.graph_run({ graph_id })).rejects.toThrow(
      /cycle detected/,
    );
    // The rejection names the graph id and lists the validation errors.
    await expect(ts.graph_run({ graph_id })).rejects.toThrow(
      /failed execution validation/,
    );
    // Zero nodes dispatched: the gate throws BEFORE createEngine runs, so no
    // engine is ever built and no root node is launched.
    expect(dispatched).toBe(0);
  });
});

/**
 * Graph Execution Engine v2 — Warning pass-through semantics of the commit path
 *
 * Pins the tool-facing contract implemented in `commit()` at
 * src/graph/tools/graph-tools.ts:854-906: construction tools surface ONLY
 * fatal validation errors (commit throws when `validation.valid` is false);
 * `validation.warnings` are NEVER surfaced at construction time. The single
 * observable channel for warnings is an explicit `graph_run({ dry_run: true })`
 * (graph-tools.ts:1109-1120), which returns the full validation result —
 * `valid` / `errors` / `warnings` — verbatim.
 *
 * A model building a graph therefore gets construction feedback ONLY for
 * ERRORS; structural WARNINGS (e.g. an uncovered cycle) require an explicit
 * dry_run to surface. `graph_status` renders exclusively from EngineState
 * (graph-tools.ts:2063-2123) and never consults validator warnings — the
 * observability gap pinned in case (a) below.
 *
 * These tests pin that contract for four topologies so any future change that
 * (1) starts throwing or logging on warnings at construction time, (2) starts
 * dropping warnings from the dry_run result, or (3) surfaces warnings through
 * graph_status breaks loudly here.
 */

import { describe, it, expect } from "bun:test";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools";

// ── (a) 2-node always-cycle A<->B with NO loop group ───────────────────────

describe("warning pass-through — 2-node always-cycle A<->B, no loop group", () => {
  it("accepts the cycle at construction, surfaces the uncovered-cycle warning on dry_run, and hides it from graph_status", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cycle-ab" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "B", agent: "agent-b", prompt: "p" });

    // The cycle-forming edges are a WARNING (not an error) in validator-v2
    // (src/graph/validator-v2.ts:448-460) — commit must NOT throw. Assert the
    // returned edge ids so a no-op/silent-drop would also fail.
    const first = ts.graph_add_edge({ graph_id, from: "A", to: "B", type: "always" });
    expect(first.edge_id).toBe("A->B");
    const second = ts.graph_add_edge({ graph_id, from: "B", to: "A", type: "always" });
    expect(second.edge_id).toBe("B->A");

    // dry_run is the ONLY channel that surfaces the warning — verbatim.
    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.phase).toBe("validating");
    expect(r.validation?.valid).toBe(true);
    expect(r.validation?.errors).toEqual([]);
    expect(r.validation?.warnings).toContain(
      "cycle detected involving node(s) [A, B] that are not contained in any declared loop group",
    );

    // graph_status never consults validator warnings — pin the observability
    // gap: neither the summary nor the json render mentions the cycle warning.
    const summary = ts.graph_status({ graph_id });
    expect(summary).not.toContain("cycle detected");
    expect(summary).not.toContain("not contained in any declared loop group");
    const json = ts.graph_status({ graph_id, format: "json" });
    expect(json).not.toContain("cycle detected");
    expect(json).not.toContain("not contained in any declared loop group");
  });
});

// ── (b) single-node self-loop A->A with NO loop group ───────────────────────

describe("warning pass-through — single-node self-loop A->A, no loop group", () => {
  it("accepts the self-loop at construction and surfaces the uncovered-cycle warning on dry_run", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "self-loop" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "p" });

    // A self-loop is an SCC of size 1 — validator-v2 flags it via Tarjan
    // selfLoop detection (src/graph/validator-v2.ts:487, 537-540) as a WARNING.
    const edge = ts.graph_add_edge({ graph_id, from: "A", to: "A", type: "always" });
    expect(edge.edge_id).toBe("A->A");

    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.validation?.valid).toBe(true);
    expect(r.validation?.errors).toEqual([]);
    expect(r.validation?.warnings).toContain(
      "cycle detected involving node(s) [A] that are not contained in any declared loop group",
    );
  });
});

// ── (c) needs_approval sink node with NO outgoing edges ─────────────────────

describe("warning pass-through — needs_approval sink with no outgoing edges", () => {
  it("accepts a dangling approval gate with no warning — the validator has no rule for it", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "approval-sink" });
    ts.graph_add_node({ graph_id, id: "producer", agent: "agent-producer", prompt: "p" });
    // A needs_approval node that nothing leaves: structurally a sink. Rule 6
    // (validator-v2.ts:218-241) only forbids type:"always" OUTGOING edges from
    // approval nodes — zero outgoing edges is fine and produces no diagnostic.
    ts.graph_add_node({
      graph_id,
      id: "gate",
      agent: "agent-gate",
      prompt: "p",
      needs_approval: true,
    });
    const edge = ts.graph_add_edge({
      graph_id,
      from: "producer",
      to: "gate",
      type: "on_signal",
      signal_filter: ["answer"],
    });
    expect(edge.edge_id).toBe("producer->gate");

    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.validation?.valid).toBe(true);
    expect(r.validation?.errors).toEqual([]);
    // A dangling approval gate is structurally fine — NO warnings at all.
    expect(r.validation?.warnings).toEqual([]);
  });
});

// ── (d) two fully disconnected components / orphan topology ─────────────────

describe("warning pass-through — disconnected / orphan topology", () => {
  it("accepts two fully disconnected components with no warning", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "disconnected" });
    ts.graph_add_node({ graph_id, id: "a1", agent: "agent-a1", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "a2", agent: "agent-a2", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b1", agent: "agent-b1", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b2", agent: "agent-b2", prompt: "p" });
    ts.graph_add_edge({ graph_id, from: "a1", to: "a2", type: "always" });
    ts.graph_add_edge({ graph_id, from: "b1", to: "b2", type: "always" });

    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.validation?.valid).toBe(true);
    expect(r.validation?.errors).toEqual([]);
    // validator-v2 has NO disconnected/orphan rule — contrast with the LEGACY
    // validator (tests/graph/validator.test.ts:188-224), which warns
    // "Disconnected node ..." / "Orphan agent ..." for the same topology.
    expect(r.validation?.warnings).toEqual([]);
  });

  it("accepts isolated orphan nodes with no warning", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "orphans" });
    // Zero edges — every node is a root AND an orphan. No cycles, no
    // disconnected-component rule in validator-v2 → no warnings.
    ts.graph_add_node({ graph_id, id: "orphan-1", agent: "agent-o1", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "orphan-2", agent: "agent-o2", prompt: "p" });

    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.validation?.valid).toBe(true);
    expect(r.validation?.errors).toEqual([]);
    expect(r.validation?.warnings).toEqual([]);
  });
});

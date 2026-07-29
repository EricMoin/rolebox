/**
 * Graph Model v2 — Serialization Round-Trip Test
 *
 * Phase 4, Subtask 3 (graph serialization round-trip). Implements the roadmap
 * test standard #2 "serialize a built graph and re-parse it":
 *
 *   build topology (imperative tools)
 *     → graph_status({ export_path }) serializes the owning declaration to YAML
 *     → importGraphFromFile (the existing parser-v2 + validator-v2 path)
 *     → assert the round-tripped declaration is structurally identical
 *
 * The topology is a review-team-plus flow: planner fans out to implementer and
 * tester, which both fan in to a reviewer, which signals answer to an approval
 * gate (needs_approval) or revise_needed back to the workers via a bounded
 * review-cycle loop group.
 *
 *   planner ─┬→ implementer ─┬→ reviewer ─→ approval-gate (needs_approval)
 *            └→ tester ──────┘        └→ implementer / tester (revise_needed)
 *   loop group: review-cycle = [implementer, tester, reviewer]
 *
 * Deserialization goes through the existing parser-v2 path only
 * (`importGraphFromFile` → `parseGraph` → `validateGraphDeclaration`) — no new
 * parser is written.
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphToolSet, GraphToolSet } from "../../src/graph/tools/graph-tools";
import { importGraphFromFile } from "../../src/graph/parser-v2";
import { serializeGraphDeclaration } from "../../src/graph/serialize";
import type { GraphDeclaration } from "../../src/types.graph-v2";

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Build the 5-node / 7-edge review-team-plus topology via the imperative
 * graph_* construction API: planner fans out to implementer + tester, both fan
 * in to a reviewer, which signals answer to an approval gate (needs_approval)
 * or revise_needed back to the workers, bounded by a review-cycle loop group.
 */
function buildReviewTeamPlus(ts: GraphToolSet, graphId: string): void {
  ts.graph_add_node({
    graph_id: graphId,
    id: "planner",
    agent: "emperor--chancellor",
    prompt: "Design the implementation plan.",
  });

  ts.graph_add_node({
    graph_id: graphId,
    id: "implementer",
    agent: "emperor--jinyiwei--backend",
    prompt: "Implement the feature.",
  });

  ts.graph_add_node({
    graph_id: graphId,
    id: "tester",
    agent: "emperor--jinyiwei--test",
    prompt: "Write and run the tests.",
  });

  // Reviewer is a fan-in of implementer + tester.
  ts.graph_add_node({
    graph_id: graphId,
    id: "reviewer",
    agent: "emperor--validator",
    prompt: "Review the implementation and tests. Signal answer or revise_needed.",
    join: { strategy: "all" },
  });

  // Terminal human-approval gate.
  ts.graph_add_node({
    graph_id: graphId,
    id: "approval-gate",
    agent: "emperor--jinyiwei",
    prompt: "Approve the final output.",
    needs_approval: true,
  });

  // Fan-out from the planner.
  ts.graph_add_edge({ graph_id: graphId, from: "planner", to: "implementer", type: "always" });
  ts.graph_add_edge({ graph_id: graphId, from: "planner", to: "tester", type: "always" });
  // Fan-in to the reviewer (both on_signal answer).
  ts.graph_add_edge({
    graph_id: graphId,
    from: "implementer",
    to: "reviewer",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "tester",
    to: "reviewer",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  // Review-cycle back-edges to the workers.
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "implementer",
    type: "on_signal",
    signal_filter: ["revise_needed"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "tester",
    type: "on_signal",
    signal_filter: ["revise_needed"],
  });
  // Answer path to the approval gate.
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "approval-gate",
    type: "on_signal",
    signal_filter: ["answer"],
  });

  // Bounded loop group over the revision cycle.
  ts.graph_add_loop({
    graph_id: graphId,
    id: "review-cycle",
    nodes: ["implementer", "tester", "reviewer"],
    max_traversals: 5,
  });
}

/** Make a unique temp dir for export artifacts (cleaned up after). */
function tempExportDir(): string {
  return mkdtempSync(join(tmpdir(), "graph-roundtrip-"));
}

// ── unit: serializeGraphDeclaration ───────────────────────────────────────

describe("serializeGraphDeclaration", () => {
  it("wraps the declaration in a `graph:` envelope and round-trips via parseGraph", () => {
    const d: GraphDeclaration = {
      version: 2,
      name: "probe",
      nodes: [{ id: "a", agent: "agent-a", prompt: "p" }],
      edges: [],
    };
    const yaml = serializeGraphDeclaration(d);
    expect(yaml.trimStart().startsWith("graph:")).toBe(true);
    expect(yaml).toContain("version: 2");
    expect(yaml).toContain("agent-a");
  });
});

// ── full round-trip via graph_status(export_path) ─────────────────────────

describe("graph serialization round-trip (roadmap standard #2)", () => {
  it("exports a built review-team-plus graph to YAML and re-parses it via parser-v2", () => {
    const dir = tempExportDir();
    const exportPath = join(dir, "review-team-plus.yaml");
    try {
      const ts = createGraphToolSet();
      const { graph_id } = ts.graph_create({ name: "review-team-plus" });
      buildReviewTeamPlus(ts, graph_id);

      // Export via graph_status(export_path) — the owning entry's declaration
      // is serialized to YAML and written atomically.
      const confirmation = ts.graph_status({ graph_id, export_path: exportPath });
      expect(confirmation).toContain("Exported graph declaration");
      expect(confirmation).toContain(exportPath);
      // The file must exist and contain a real YAML document envelope.
      expect(existsSync(exportPath)).toBe(true);
      expect(readFileSync(exportPath, "utf8").trimStart().startsWith("graph:")).toBe(true);

      // Deserialize via the existing parser-v2 path.
      const roundtripped = importGraphFromFile(exportPath);
      expect(roundtripped).not.toBeNull();

      // Structural fidelity of the round-tripped declaration.
      expect(roundtripped!.version).toBe(2);
      expect(roundtripped!.name).toBe("review-team-plus");

      // Node count 5.
      expect(roundtripped!.nodes).toHaveLength(5);
      expect(roundtripped!.nodes.map((n) => n.id)).toEqual(
        ["planner", "implementer", "tester", "reviewer", "approval-gate"],
      );

      // Edge count 7.
      expect(roundtripped!.edges).toHaveLength(7);

      // Loop group count 1, with the revision-cycle membership preserved.
      expect(roundtripped!.loop_groups).toHaveLength(1);
      expect(roundtripped!.loop_groups![0].id).toBe("review-cycle");
      expect(roundtripped!.loop_groups![0].max_traversals).toBe(5);
      expect(roundtripped!.loop_groups![0].nodes).toEqual(
        ["implementer", "tester", "reviewer"],
      );

      // Reviewer fan-in join survives the round trip.
      const reviewer = roundtripped!.nodes.find((n) => n.id === "reviewer")!;
      expect(reviewer.join).toEqual({ strategy: "all" });

      // on_signal signal filters survive the round trip.
      const backEdge = roundtripped!.edges.find((e) => e.from === "reviewer" && e.to === "implementer")!;
      expect(backEdge.type).toBe("on_signal");
      expect(backEdge.signal_filter).toEqual(["revise_needed"]);

      // Terminal node (no outgoing edges) is the approval gate, needs_approval true.
      const sinks = roundtripped!.nodes.filter(
        (n) => !roundtripped!.edges.some((e) => e.from === n.id),
      );
      expect(sinks).toHaveLength(1);
      expect(sinks[0].id).toBe("approval-gate");
      expect(sinks[0].needs_approval).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

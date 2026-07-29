import { describe, it, expect } from "bun:test";
import { convertCollaborationToGraphDeclaration } from "../../src/graph/collaboration-bridge";
import { graphDeclarationToResolvedGraph } from "../../src/graph/collaboration-bridge";
import { PARENT_NODE } from "../../src/constants";
import { expandTemplate } from "../../src/graph/templates";
import { parseFlow, mergeEdges } from "../../src/graph/edge-parser";
import { hasCycle } from "../../src/graph/graph-utils";
import type { CollaborationConfig, FlowEdge } from "../../src/types";
import type { GraphDeclaration } from "../../src/types.graph-v2";

const OPTS = { parentAgentId: "emperor--parent", name: "test-graph" };

// ── Helpers ──────────────────────────────────────────────────────────────

/** Agent (non-terminal) node ids in first-seen order. */
function agentNodeIds(decl: GraphDeclaration): string[] {
  return decl.nodes
    .filter((n) => n.id !== PARENT_NODE)
    .map((n) => n.id);
}

/** `from->to` keys of every edge in a set of FlowEdges. */
function edgeKeys(edges: FlowEdge[]): string[] {
  return edges.map((e) => `${e.from}->${e.to}`);
}

/** `from->to` keys of every edge declaration in the produced graph. */
function declEdgeKeys(decl: GraphDeclaration): string[] {
  return decl.edges.map((e) => `${e.from}->${e.to}`);
}

/**
 * Independent topology oracle derived from a `collaboration:` config using the
 * same public graph primitives the legacy parser used (template expansion,
 * flow merge, cycle defaulting). `parseCollaboration` itself is gone, so this
 * reconstruction — fed through the v2 converter + bridge — is the new
 * lossless-equivalence reference.
 */
function expectedTopology(collab: CollaborationConfig): {
  nodes: string[];
  edgeKeys: string[];
  maxIterations: number;
} {
  const agents = collab.agents ?? [];
  let templateEdges: FlowEdge[] = [];
  if (collab.topology !== undefined && agents.length > 0) {
    templateEdges = expandTemplate(collab.topology, agents);
  }
  const edges = mergeEdges(templateEdges, parseFlow(collab.flow));

  const nodeSet = new Set<string>();
  for (const e of edges) {
    if (e.from !== PARENT_NODE) nodeSet.add(e.from);
    if (e.to !== PARENT_NODE) nodeSet.add(e.to);
  }

  const maxIterations =
    typeof collab.max_iterations === "number" &&
    Number.isFinite(collab.max_iterations)
      ? Math.max(0, collab.max_iterations)
      : hasCycle(edges)
        ? 3
        : 0;

  return { nodes: [...nodeSet], edgeKeys: edgeKeys(edges), maxIterations };
}

/** Find the single terminal approval node (id === PARENT_NODE). */
function terminalNode(decl: GraphDeclaration) {
  return decl.nodes.find((n) => n.id === PARENT_NODE);
}

// ── Lossless equivalence via the v2→v1 bridge ───────────────────────────

describe("convertCollaborationToGraphDeclaration — lossless equivalence", () => {
  const cases: { name: string; collab: CollaborationConfig }[] = [
    {
      name: "pipeline template",
      collab: {
        topology: "pipeline",
        agents: ["a", "b", "c"],
        max_iterations: 5,
      },
    },
    {
      name: "review-loop template (explicit cap)",
      collab: {
        topology: "review-loop",
        agents: ["coder", "reviewer"],
        max_iterations: 4,
      },
    },
    {
      name: "review-loop template (default cap)",
      collab: { topology: "review-loop", agents: ["a", "b"] },
    },
    {
      name: "star template",
      collab: { topology: "star", agents: ["x", "y", "z"], max_iterations: 2 },
    },
  ];

  for (const { name, collab } of cases) {
    it(`${name} — node count, edge direction, and loop cap identical to the legacy oracle`, () => {
      const decl = convertCollaborationToGraphDeclaration(collab, OPTS);
      const expected = expectedTopology(collab);

      // Node count: agent nodes (excluding the terminal approval node) must
      // equal the resolved graph's node set, independent of order.
      expect([...agentNodeIds(decl)].sort()).toEqual(
        [...expected.nodes].sort(),
      );

      // Edge direction: every FlowEdge (including parent entry/exit) survives
      // as a directed on_signal edge, independent of order.
      expect([...declEdgeKeys(decl)].sort()).toEqual(
        [...expected.edgeKeys].sort(),
      );

      // The bridge reconstructs the same legacy ResolvedGraph topology.
      const bridged = graphDeclarationToResolvedGraph(decl);
      expect(bridged).not.toBeNull();
      expect([...bridged!.nodes].sort()).toEqual([...expected.nodes].sort());
      expect([...bridged!.edges.map((e) => `${e.from}->${e.to}`)].sort()).toEqual(
        [...expected.edgeKeys].sort(),
      );
      expect(bridged!.maxIterations).toBe(expected.maxIterations);

      // Loop cap: if loops exist, each loop group's max_traversals equals the
      // resolved maxIterations; acyclic graphs emit no loop groups.
      if (decl.loop_groups !== undefined) {
        expect(decl.loop_groups!.length).toBeGreaterThan(0);
        for (const group of decl.loop_groups!) {
          expect(group.max_traversals).toBe(expected.maxIterations);
        }
      }
    });
  }

  it("review-team-custom/role.yaml flow — lossless node count, edge direction, loop cap", () => {
    // Mirrors examples/review-team-custom/role.yaml `collaboration:` block.
    // The real YAML `flow` mixes string edges with object edges; the runtime
    // parser (parseFlow) accepts both, so the wider shape is cast to the
    // narrower CollaborationConfig type.
    const collab = {
      flow: [
        "parent -> researcher",
        "researcher -> writer: research findings",
        "writer -> editor: draft content",
        { from: "editor", to: "writer", label: "revision requests" },
        { from: "editor", to: "parent", label: "approved", exit: true },
      ],
      max_iterations: 2,
    } as unknown as CollaborationConfig;

    const decl = convertCollaborationToGraphDeclaration(collab, OPTS);
    const expected = expectedTopology(collab);

    expect([...agentNodeIds(decl)].sort()).toEqual(["editor", "researcher", "writer"]);
    expect([...declEdgeKeys(decl)].sort()).toEqual(
      [...expected.edgeKeys].sort(),
    );

    // editor<->writer forms one loop group; cap = max_iterations = 2.
    expect(decl.loop_groups).toHaveLength(1);
    expect(decl.loop_groups![0].nodes.sort()).toEqual(["editor", "writer"]);
    expect(decl.loop_groups![0].max_traversals).toBe(2);
  });
});

// ── Terminal approval node (PARENT_NODE and exit:true collapse) ─────────

describe("terminal approval node", () => {
  it("PARENT_NODE sentinel produces a single needs_approval:true node bound to parentAgentId", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "pipeline", agents: ["a", "b"] },
      OPTS,
    );
    const terminal = terminalNode(decl);
    expect(terminal).toBeDefined();
    expect(terminal!.agent).toBe("emperor--parent");
    expect(terminal!.needs_approval).toBe(true);

    // Exactly one terminal node exists.
    expect(decl.nodes.filter((n) => n.id === PARENT_NODE)).toHaveLength(1);
  });

  it("exit:true edge that does NOT point to parent also collapses into the approval node", () => {
    const collab: CollaborationConfig = {
      flow: [
        { from: "parent", to: "a" },
        { from: "a", to: "b", exit: true },
      ],
    };
    const decl = convertCollaborationToGraphDeclaration(collab, OPTS);
    const terminal = terminalNode(decl);
    expect(terminal).toBeDefined();
    expect(terminal!.needs_approval).toBe(true);
    expect(terminal!.agent).toBe("emperor--parent");

    // The exit:true edge keeps its direction (a->b) and the terminal node
    // still exists because of the parent entry edge + exit edge.
    expect(declEdgeKeys(decl)).toEqual(["parent->a", "a->b"]);
  });

  it("agent nodes are never marked needs_approval", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "review-loop", agents: ["coder", "reviewer"] },
      OPTS,
    );
    for (const node of agentNodeIds(decl)) {
      const cfg = decl.nodes.find((n) => n.id === node)!;
      expect(cfg.needs_approval).toBeUndefined();
      expect(cfg.agent).toBe(node);
    }
  });
});

// ── Loop cap equals max_iterations ───────────────────────────────────────

describe("loop cap == max_iterations", () => {
  it("review-loop without max_iterations defaults each loop group to 3", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "review-loop", agents: ["a", "b"] },
      OPTS,
    );
    expect(decl.loop_groups).toHaveLength(1);
    expect(decl.loop_groups![0].max_traversals).toBe(3);
  });

  it("review-loop with max_iterations propagates it to every loop group", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "review-loop", agents: ["a", "b"], max_iterations: 7 },
      OPTS,
    );
    expect(decl.loop_groups![0].max_traversals).toBe(7);
  });

  it("negative max_iterations is clamped to 0 (matching parser.ts:82-89)", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "review-loop", agents: ["a", "b"], max_iterations: -3 },
      OPTS,
    );
    expect(decl.loop_groups![0].max_traversals).toBe(0);
  });

  it("acyclic graphs (pipeline, star) emit no loop groups", () => {
    const pipeline = convertCollaborationToGraphDeclaration(
      { topology: "pipeline", agents: ["a", "b", "c"] },
      OPTS,
    );
    const star = convertCollaborationToGraphDeclaration(
      { topology: "star", agents: ["a", "b"] },
      OPTS,
    );
    expect(pipeline.loop_groups).toBeUndefined();
    expect(star.loop_groups).toBeUndefined();
  });
});

// ── Declaration shape ────────────────────────────────────────────────────

describe("declaration shape", () => {
  it("carries version 2 and the provided name", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "pipeline", agents: ["a"] },
      OPTS,
    );
    expect(decl.version).toBe(2);
    expect(decl.name).toBe("test-graph");
  });

  it("maps every edge to on_signal with signal_filter ['answer']", () => {
    const decl = convertCollaborationToGraphDeclaration(
      { topology: "pipeline", agents: ["a", "b"] },
      OPTS,
    );
    for (const edge of decl.edges) {
      expect(edge.type).toBe("on_signal");
      expect(edge.signal_filter).toEqual(["answer"]);
    }
  });

  it("propagates collaboration termination to the graph and loop groups", () => {
    const collab: CollaborationConfig = {
      topology: "review-loop",
      agents: ["a", "b"],
      termination: { any_of: [{ max_iterations: 4 }, { converged: "b" }] },
    };
    const decl = convertCollaborationToGraphDeclaration(collab, OPTS);
    expect(decl.termination?.any_of).toEqual([
      { max_iterations: 4 },
      { converged: "b" },
    ]);
    expect(decl.loop_groups![0].termination?.any_of).toEqual([
      { max_iterations: 4 },
      { converged: "b" },
    ]);
  });
});

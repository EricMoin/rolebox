import { describe, it, expect } from "bun:test";
import { parseCollaboration } from "./graph-parser";
import type { FlowEdge } from "./types";

function edge(from: string, to: string, extras?: Partial<FlowEdge>): FlowEdge {
  return { from, to, ...extras };
}

describe("parseCollaboration", () => {
  // ─── Invalid / edge-case inputs ──────────────────────────────────────

  describe("invalid raw inputs", () => {
    it("returns null for null", () => {
      expect(parseCollaboration(null, [])).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(parseCollaboration(undefined, [])).toBeNull();
    });

    it("returns null for non-object (string)", () => {
      expect(parseCollaboration("pipeline", [])).toBeNull();
    });

    it("returns null for non-object (number)", () => {
      expect(parseCollaboration(42, [])).toBeNull();
    });

    it("returns null for empty object with no edges", () => {
      expect(parseCollaboration({}, ["a"])).toBeNull();
    });

    it("returns null for unknown topology", () => {
      expect(
        parseCollaboration(
          { topology: "mesh", agents: ["a", "b"] },
          ["a", "b"],
        ),
      ).toBeNull();
    });
  });

  // ─── Template-only ──────────────────────────────────────────────────

  describe("template-only", () => {
    it("resolves pipeline with two agents", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a", "b"] },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "parent", { exit: true }),
      ]);
      expect(result!.nodes).toEqual(["a", "b"]);
      expect(result!.template).toBe("pipeline");
      expect(result!.maxIterations).toBe(0);
      expect(result!.exitEdges).toEqual([
        edge("b", "parent", { exit: true }),
      ]);
    });

    it("resolves review-loop with two agents", () => {
      const result = parseCollaboration(
        { topology: "review-loop", agents: ["coder", "reviewer"] },
        ["coder", "reviewer"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "coder"),
        edge("coder", "reviewer"),
        edge("reviewer", "coder", { label: "loop" }),
        edge("reviewer", "parent", { label: "exit", exit: true }),
      ]);
      expect(result!.nodes).toEqual(["coder", "reviewer"]);
      expect(result!.template).toBe("review-loop");
      expect(result!.maxIterations).toBe(3);
      expect(result!.exitEdges).toEqual([
        edge("reviewer", "parent", { label: "exit", exit: true }),
      ]);
    });

    it("resolves star with three agents", () => {
      const result = parseCollaboration(
        { topology: "star", agents: ["a", "b", "c"] },
        ["a", "b", "c"],
      );
      expect(result).not.toBeNull();
      expect(result!.nodes.sort()).toEqual(["a", "b", "c"]);
      expect(result!.template).toBe("star");
      expect(result!.maxIterations).toBe(0);
      expect(result!.exitEdges).toHaveLength(3);
    });

    it("handles single agent pipeline", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a"] },
        ["a"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
      ]);
      expect(result!.nodes).toEqual(["a"]);
    });

    it("returns null when topology set but agents empty", () => {
      expect(
        parseCollaboration(
          { topology: "pipeline", agents: [] },
          ["a", "b"],
        ),
      ).toBeNull();
    });

    it("returns null when topology set but agents missing", () => {
      expect(
        parseCollaboration(
          { topology: "pipeline" },
          ["a", "b"],
        ),
      ).toBeNull();
    });

    it("returns null when agents include unknown nodes", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a", "b"] },
        ["a"],
      );
      expect(result).toBeNull();
    });
  });

  // ─── Flow-only ──────────────────────────────────────────────────────

  describe("flow-only", () => {
    it("parses string edges: simple chain", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", "a -> b", "b -> parent"],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "parent", { exit: true }),
      ]);
      expect(result!.nodes).toEqual(["a", "b"]);
      expect(result!.template).toBeUndefined();
      expect(result!.maxIterations).toBe(0);
      expect(result!.exitEdges).toHaveLength(1);
    });

    it("parses labeled string edges", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> coder",
            "coder -> reviewer: handoff label",
            "reviewer -> parent: final",
          ],
        },
        ["coder", "reviewer"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "coder"),
        edge("coder", "reviewer", { label: "handoff label" }),
        edge("reviewer", "parent", { label: "final", exit: true }),
      ]);
    });

    it("parses object edges", () => {
      const result = parseCollaboration(
        {
          flow: [
            { from: "parent", to: "a" },
            { from: "a", to: "b", label: "pass" },
            { from: "b", to: "parent", exit: true },
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "b", { label: "pass" }),
        edge("b", "parent", { exit: true }),
      ]);
      expect(result!.exitEdges).toHaveLength(1);
    });

    it("parses mixed string and object edges in flow", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { from: "a", to: "b", label: "to review" },
            "b -> parent",
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "b", { label: "to review" }),
        edge("b", "parent", { exit: true }),
      ]);
    });

    it("handles exit: true on object edge to non-parent", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { from: "a", to: "b", exit: true },
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.exitEdges).toEqual([
        edge("a", "b", { exit: true }),
      ]);
    });

    it("warns and skips malformed string edge", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            "not a valid edge",
            "a -> parent",
          ],
        },
        ["a"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
      ]);
    });

    it("returns null when flow has no entry from parent", () => {
      const result = parseCollaboration(
        {
          flow: ["a -> b", "b -> parent"],
        },
        ["a", "b"],
      );
      expect(result).toBeNull();
    });

    it("returns null when flow references unknown agent", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", "a -> unknown", "unknown -> parent"],
        },
        ["a"],
      );
      expect(result).toBeNull();
    });
  });

  // ─── Mixed: template + flow ─────────────────────────────────────────

  describe("mixed template + flow", () => {
    it("appends flow edges to template edges", () => {
      const result = parseCollaboration(
        {
          topology: "pipeline",
          agents: ["a", "b"],
          flow: [{ from: "b", to: "c", label: "extra" }, "c -> parent"],
        },
        ["a", "b", "c"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toContainEqual(
        edge("b", "c", { label: "extra" }),
      );
      expect(result!.nodes.sort()).toEqual(["a", "b", "c"]);
    });

    it("flow edge overrides template edge with same from→to", () => {
      const result = parseCollaboration(
        {
          topology: "pipeline",
          agents: ["a", "b"],
          flow: [
            { from: "a", to: "b", label: "custom label" },
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      const abEdge = result!.edges.find(
        (e) => e.from === "a" && e.to === "b",
      );
      expect(abEdge).toBeDefined();
      expect(abEdge!.label).toBe("custom label");
    });

    it("flow edge can add exit to a non-terminal template edge", () => {
      const result = parseCollaboration(
        {
          topology: "pipeline",
          agents: ["a", "b"],
          flow: [
            { from: "a", to: "b", exit: true },
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      const abEdge = result!.exitEdges.find(
        (e) => e.from === "a" && e.to === "b",
      );
      expect(abEdge).toBeDefined();
    });

    it("flow can redirect template output to different agent", () => {
      const result = parseCollaboration(
        {
          topology: "pipeline",
          agents: ["a", "b", "c"],
          flow: [
            "b -> d",
            "d -> parent: done",
          ],
        },
        ["a", "b", "c", "d"],
      );
      expect(result).not.toBeNull();
      expect(result!.nodes.sort()).toEqual(["a", "b", "c", "d"]);
      expect(result!.exitEdges.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── maxIterations ──────────────────────────────────────────────────

  describe("maxIterations", () => {
    it("defaults to 0 for acyclic pipeline", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a", "b"] },
        ["a", "b"],
      );
      expect(result!.maxIterations).toBe(0);
    });

    it("defaults to 3 for review-loop (has cycle)", () => {
      const result = parseCollaboration(
        { topology: "review-loop", agents: ["a", "b"] },
        ["a", "b"],
      );
      expect(result!.maxIterations).toBe(3);
    });

    it("uses user-specified value when provided", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          max_iterations: 5,
        },
        ["a", "b"],
      );
      expect(result!.maxIterations).toBe(5);
    });

    it("respects user-specified zero", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          max_iterations: 0,
        },
        ["a", "b"],
      );
      expect(result!.maxIterations).toBe(0);
    });

    it("defaults to 3 for flow with cycle", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            "a -> b",
            "b -> a",
            "b -> parent",
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.maxIterations).toBe(3);
    });
  });

  // ─── Exit edges identification ──────────────────────────────────────

  describe("exit edge identification", () => {
    it("identifies edges to parent as exit", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a"] },
        ["a"],
      );
      expect(result!.exitEdges).toEqual([
        edge("a", "parent", { exit: true }),
      ]);
    });

    it("identifies object edges with exit: true", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { from: "a", to: "b", exit: true },
          ],
        },
        ["a", "b"],
      );
      expect(result!.exitEdges).toContainEqual(
        edge("a", "b", { exit: true }),
      );
    });

    it("review-loop has one exit edge", () => {
      const result = parseCollaboration(
        { topology: "review-loop", agents: ["a", "b"] },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.exitEdges).toHaveLength(1);
      expect(result!.exitEdges[0].to).toBe("parent");
    });

    it("star has N exit edges for N agents", () => {
      const result = parseCollaboration(
        { topology: "star", agents: ["a", "b", "c"] },
        ["a", "b", "c"],
      );
      expect(result!.exitEdges).toHaveLength(3);
    });
  });

  // ─── Node set building ──────────────────────────────────────────────

  describe("node building", () => {
    it("excludes parent from nodes", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a"] },
        ["a"],
      );
      expect(result!.nodes).not.toContain("parent");
    });

    it("deduplicates nodes", () => {
      const result = parseCollaboration(
        { topology: "star", agents: ["a"] },
        ["a"],
      );
      expect(result!.nodes).toEqual(["a"]);
    });

    it("collects all agents from flow edges", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> x", "x -> y", "y -> z", "z -> parent"],
        },
        ["x", "y", "z"],
      );
      expect(result!.nodes.sort()).toEqual(["x", "y", "z"]);
    });
  });

  // ─── String edge parsing edge cases ─────────────────────────────────

  describe("string edge parsing", () => {
    it("parses edge without spaces around arrow", () => {
      const result = parseCollaboration(
        {
          flow: ["parent->a", "a->b", "b->parent"],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toHaveLength(3);
    });

    it("parses edge with extra whitespace", () => {
      const result = parseCollaboration(
        {
          flow: ["  parent  ->  a  :  start here  "],
        },
        ["a"],
      );
      expect(result).toBeNull();
    });

    it("handles label with special characters", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            "a -> b: review: needs changes!",
            "b -> parent: done",
          ],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      const abEdge = result!.edges.find(
        (e) => e.from === "a" && e.to === "b",
      );
      expect(abEdge!.label).toBe("review: needs changes!");
    });

    it("handles label being just colon (empty label)", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", "a -> b:", "b -> parent"],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      const abEdge = result!.edges.find(
        (e) => e.from === "a" && e.to === "b",
      );
      expect(abEdge!.label).toBeUndefined();
    });

    it("parses agent names with hyphens", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> my-agent",
            "my-agent -> other-thing",
            "other-thing -> parent",
          ],
        },
        ["my-agent", "other-thing"],
      );
      expect(result).not.toBeNull();
      expect(result!.nodes.sort()).toEqual(["my-agent", "other-thing"]);
    });
  });

  // ─── Object edge parsing edge cases ─────────────────────────────────

  describe("object edge parsing", () => {
    it("rejects object edge missing from field", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { to: "parent" } as unknown as FlowEdge,
          ],
        },
        ["a"],
      );
      expect(result).toBeNull();
    });

    it("rejects object edge missing to field", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { from: "a" } as unknown as FlowEdge,
            "a -> parent",
          ],
        },
        ["a"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toHaveLength(2);
    });

    it("rejects object edge with empty from string", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { from: "", to: "parent" },
          ],
        },
        ["a"],
      );
      expect(result).toBeNull();
    });

    it("ignores non-boolean exit field", () => {
      const result = parseCollaboration(
        {
          flow: [
            "parent -> a",
            { from: "a", to: "parent", exit: "yes" as unknown as boolean },
          ],
        },
        ["a"],
      );
      expect(result).not.toBeNull();
      expect(result!.exitEdges).toHaveLength(1);
    });
  });

  // ─── CollaborationConfig with max_iterations ────────────────────────

  describe("collaboration config max_iterations", () => {
    it("reads max_iterations from config", () => {
      const result = parseCollaboration(
        {
          topology: "pipeline",
          agents: ["a"],
          max_iterations: 10,
        },
        ["a"],
      );
      expect(result!.maxIterations).toBe(10);
    });

    it("ignores negative max_iterations (treats as user value)", () => {
      const result = parseCollaboration(
        {
          topology: "pipeline",
          agents: ["a"],
          max_iterations: -1,
        },
        ["a"],
      );
      expect(result!.maxIterations).toBe(-1);
    });
  });

  // ─── Orphan warnings (non-fatal from validator) ─────────────────────

  describe("orphan agent warnings", () => {
    it("still returns graph when availableSubagentNames has extra agents", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a", "b"] },
        ["a", "b", "orphan"],
      );
      expect(result).not.toBeNull();
    });
  });

  // ─── Handle flow entries that are not string/object ─────────────────

  describe("flow entry type handling", () => {
    it("skips number entries in flow", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", 42 as unknown as string, "a -> parent"],
        },
        ["a"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toHaveLength(2);
    });

    it("skips null entries in flow", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", null as unknown as string, "a -> parent"],
        },
        ["a"],
      );
      expect(result).not.toBeNull();
      expect(result!.edges).toHaveLength(2);
    });
  });
});

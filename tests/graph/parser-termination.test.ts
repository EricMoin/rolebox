import { describe, it, expect } from "bun:test";
import { parseCollaboration } from "../../src/graph/parser";
import type { FlowEdge } from "../../src/types";

function edge(from: string, to: string, extras?: Partial<FlowEdge>): FlowEdge {
  return { from, to, ...extras };
}

describe("parseCollaboration — termination block", () => {
  // ─── any_of parsing ──────────────────────────────────────────────────

  describe("any_of", () => {
    it("parses any_of with 3 conditions", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["coder", "reviewer"],
          termination: {
            any_of: [
              { max_iterations: 5 },
              { timeout_ms: 60000 },
              { result_matches: { agent: "reviewer", contains: "APPROVED" } },
            ],
          },
        },
        ["coder", "reviewer"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination).toBeDefined();
      expect(result!.termination!.config.any_of).toBeDefined();
      expect(result!.termination!.config.any_of!.length).toBe(3);
      expect(result!.termination!.config.all_of).toBeUndefined();
    });

    it("parses any_of with mixed condition types", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["coder", "reviewer"],
          termination: {
            any_of: [
              { max_iterations: 2 },
              { converged: "reviewer" },
              { stuck: { repeats: 3 } },
              { timeout_ms: 30000 },
              {
                result_matches: {
                  agent: "reviewer",
                  regex: "PASS",
                  score_gte: 80,
                  no_changes: true,
                },
              },
            ],
          },
        },
        ["coder", "reviewer"],
      );
      expect(result).not.toBeNull();
      const conditions = result!.termination!.config.any_of!;
      expect(conditions.length).toBe(5);

      // max_iterations
      expect(conditions[0]).toEqual({ max_iterations: 2 });
      // converged
      expect(conditions[1]).toEqual({ converged: "reviewer" });
      // stuck
      expect(conditions[2]).toEqual({ stuck: { repeats: 3 } });
      // timeout_ms
      expect(conditions[3]).toEqual({ timeout_ms: 30000 });
      // result_matches
      const rm = (conditions[4] as { result_matches: Record<string, unknown> })
        .result_matches;
      expect(rm.agent).toBe("reviewer");
      expect(rm.regex).toBe("PASS");
      expect(rm.score_gte).toBe(80);
      expect(rm.no_changes).toBe(true);
    });
  });

  // ─── all_of parsing ──────────────────────────────────────────────────

  describe("all_of", () => {
    it("parses all_of with 2 conditions", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["coder", "reviewer"],
          termination: {
            all_of: [
              { max_iterations: 10 },
              { result_matches: { agent: "reviewer", regex: "DONE" } },
            ],
          },
        },
        ["coder", "reviewer"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination).toBeDefined();
      expect(result!.termination!.config.all_of).toBeDefined();
      expect(result!.termination!.config.all_of!.length).toBe(2);
      expect(result!.termination!.config.any_of).toBeUndefined();
    });

    it("supports both any_of and all_of simultaneously", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["coder", "reviewer"],
          termination: {
            any_of: [{ max_iterations: 5 }],
            all_of: [{ converged: "reviewer" }],
          },
        },
        ["coder", "reviewer"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination!.config.any_of!.length).toBe(1);
      expect(result!.termination!.config.all_of!.length).toBe(1);
    });
  });

  // ─── Individual condition types ──────────────────────────────────────

  describe("individual condition types", () => {
    it("parses max_iterations condition", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: { any_of: [{ max_iterations: 7 }] },
        },
        ["a", "b"],
      );
      expect(result!.termination!.config.any_of![0])
        .toEqual({ max_iterations: 7 });
    });

    it("parses timeout_ms condition", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: { any_of: [{ timeout_ms: 120000 }] },
        },
        ["a", "b"],
      );
      expect(result!.termination!.config.any_of![0])
        .toEqual({ timeout_ms: 120000 });
    });

    it("parses converged condition", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: { any_of: [{ converged: "a" }] },
        },
        ["a", "b"],
      );
      expect(result!.termination!.config.any_of![0])
        .toEqual({ converged: "a" });
    });

    it("parses result_matches condition", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [
              {
                result_matches: {
                  agent: "b",
                  contains: "LGTM",
                  regex: "ok",
                  score_gte: 90,
                  no_changes: false,
                },
              },
            ],
          },
        },
        ["a", "b"],
      );
      const rm = (
        result!.termination!.config.any_of![0] as {
          result_matches: Record<string, unknown>;
        }
      ).result_matches;
      expect(rm.agent).toBe("b");
      expect(rm.contains).toBe("LGTM");
      expect(rm.regex).toBe("ok");
      expect(rm.score_gte).toBe(90);
      expect(rm.no_changes).toBe(false);
    });

    it("parses stuck condition", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: { any_of: [{ stuck: { repeats: 3 } }] },
        },
        ["a", "b"],
      );
      expect(result!.termination!.config.any_of![0])
        .toEqual({ stuck: { repeats: 3 } });
    });
  });

  // ─── max_iterations precedence (root vs per-loop) ────────────────────

  describe("max_iterations precedence", () => {
    it("root max_iterations acts as global cap when no termination", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          max_iterations: 10,
        },
        ["a", "b"],
      );
      expect(result!.maxIterations).toBe(10);
      expect(result!.termination).toBeUndefined();
    });

    it("root max_iterations acts as global cap alongside termination", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          max_iterations: 10,
          termination: {
            any_of: [{ max_iterations: 5 }],
          },
        },
        ["a", "b"],
      );
      // Root max_iterations = global safety cap
      expect(result!.maxIterations).toBe(10);
      // Condition max_iterations = per-loop cap in termination config
      expect(result!.termination!.config.any_of![0])
        .toEqual({ max_iterations: 5 });
    });

    it("termination max_iterations alone without root", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ max_iterations: 8 }],
          },
        },
        ["a", "b"],
      );
      // Root falls back to cycle default (3) since no root max_iterations
      expect(result!.maxIterations).toBe(3);
      // Condition still preserved
      expect(result!.termination!.config.any_of![0])
        .toEqual({ max_iterations: 8 });
    });
  });

  // ─── Invalid agent ref → warning ─────────────────────────────────────

  describe("agent reference validation", () => {
    it("warns on result_matches with unknown agent (non-fatal)", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ result_matches: { agent: "unknown_agent" } }],
          },
        },
        ["a", "b"],
      );
      // Should still return a graph (warn, not hard fail)
      expect(result).not.toBeNull();
      // The condition should still be present (best-effort parse)
      expect(result!.termination!.config.any_of!.length).toBe(1);
    });

    it("warns on converged referencing unknown agent (non-fatal)", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ converged: "nonexistent" }],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination!.config.any_of!.length).toBe(1);
    });

    it("valid agents in result_matches pass silently", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ result_matches: { agent: "a" } }],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination!.config.any_of!.length).toBe(1);
    });

    it("valid agents in converged pass silently", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ converged: "b" }],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination!.config.any_of!.length).toBe(1);
    });
  });

  // ─── Unknown condition key → logged + skipped ────────────────────────

  describe("unknown condition keys", () => {
    it("skips condition with completely unknown key", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [
              { max_iterations: 5 },
              { unknown_future_cond: { foo: "bar" } } as Record<
                string,
                unknown
              >,
              { stuck: { repeats: 2 } },
            ],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      // The unknown condition should be skipped; 2 valid ones remain
      expect(result!.termination!.config.any_of!.length).toBe(2);
    });

    it("skips condition with extra unknown key alongside a known one", () => {
      // Condition objects with extra properties should still parse the known keys
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [
              {
                max_iterations: 5,
                unknown_extra: "ignored",
              } as Record<string, unknown>,
            ],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      const cond = result!.termination!.config.any_of![0];
      expect(cond).toHaveProperty("max_iterations", 5);
    });

    it("empty any_of array after filtering all unknown conditions", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [
              { foo: "bar" } as Record<string, unknown>,
              { baz: 123 } as Record<string, unknown>,
            ],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      // All filtered out → any_of empty or undefined
      const anyOf = result!.termination!.config.any_of;
      expect(anyOf).toBeDefined();
      expect(anyOf!.length).toBe(0);
    });
  });

  // ─── No termination → undefined ──────────────────────────────────────

  describe("no termination config", () => {
    it("returns termination === undefined for configs without termination", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          max_iterations: 3,
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination).toBeUndefined();
    });

    it("returns termination === undefined for flow-only configs", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", "a -> b", "b -> parent"],
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination).toBeUndefined();
    });

    it("legacy pipeline → termination undefined, loopGroups empty", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a", "b"] },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination).toBeUndefined();
      expect(result!.loopGroups).toEqual([]);
    });

    it("legacy review-loop → termination undefined, loopGroups has detected groups", () => {
      const result = parseCollaboration(
        { topology: "review-loop", agents: ["a", "b"] },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      // No termination config but loopGroups still detected by SCC
      expect(result!.termination).toBeUndefined();
      // review-loop has a cycle → should have at least one loop group
      expect(result!.loopGroups.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Legacy fixture unchanged ────────────────────────────────────────

  describe("legacy fixtures unchanged", () => {
    it("legacy pipeline edges/nodes unchanged", () => {
      const result = parseCollaboration(
        { topology: "pipeline", agents: ["a", "b"] },
        ["a", "b"],
      );
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

    it("legacy review-loop edges/nodes unchanged", () => {
      const result = parseCollaboration(
        { topology: "review-loop", agents: ["coder", "reviewer"] },
        ["coder", "reviewer"],
      );
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

    it("legacy flow-only edges/nodes unchanged", () => {
      const result = parseCollaboration(
        {
          flow: ["parent -> a", "a -> b", "b -> parent"],
        },
        ["a", "b"],
      );
      expect(result!.edges).toEqual([
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "parent", { exit: true }),
      ]);
      expect(result!.nodes).toEqual(["a", "b"]);
      expect(result!.template).toBeUndefined();
      expect(result!.maxIterations).toBe(0);
    });
  });

  // ─── Loop groups in termination ──────────────────────────────────────

  describe("loop groups with termination", () => {
    it("attaches loopGroups to ResolvedTermination", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: { any_of: [{ max_iterations: 5 }] },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      expect(result!.termination).toBeDefined();
      // termination.loopGroups should contain the detected groups
      expect(result!.termination!.loopGroups.length).toBeGreaterThanOrEqual(
        1,
      );
      // ResolvedGraph.loopGroups should match
      expect(result!.loopGroups).toEqual(
        result!.termination!.loopGroups,
      );
    });

    it("per-loop max_iterations from condition when present", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ max_iterations: 7 }],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      // When termination max_iterations exists, loopGroups should pick it up
      const lg = result!.termination!.loopGroups[0];
      expect(lg.maxIterations).toBe(7);
    });

    it("per-loop max_iterations undefined when condition uses different type", () => {
      const result = parseCollaboration(
        {
          topology: "review-loop",
          agents: ["a", "b"],
          termination: {
            any_of: [{ timeout_ms: 30000 }],
          },
        },
        ["a", "b"],
      );
      expect(result).not.toBeNull();
      // No max_iterations in conditions → loopGroup maxIterations undefined
      const lg = result!.termination!.loopGroups[0];
      expect(lg.maxIterations).toBeUndefined();
    });
  });
});

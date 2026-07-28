/**
 * Graph Execution Engine v2 — Adopt-prior topology reconciliation
 *
 * Regression suite for defect A: when nodes are added BEFORE their edges (the
 * normal construction-tool order), `adoptPriorNodeStates` overwrites
 * `provision()`'s correct `Pending` assignment with a stale prior `Ready`,
 * then the frontier-correction block re-adds the node to the frontier.
 *
 * The fix (subtask 1): `computeInDegrees` canonically encodes the edge filters,
 * and `adoptPriorNodeStates` gained a post-adoption reconciliation pass that
 * demotes any node adopted as `Ready` whose in-degree is now > 0 back to
 * `Pending` and removes it from the frontier.
 *
 * These tests exercise the genuine `provision()` + `adoptPrior()` flow — the
 * exact path the construction tools (`graph_add_node` + `graph_add_edge`)
 * take.  Each test must genuinely FAIL if the post-adoption reconciliation
 * pass were reverted.
 */

import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import {
  createEngineState,
  provision,
  isInFrontier,
} from "../../src/graph/engine/engine-state.ts";
import { adoptPriorNodeStates } from "../../src/graph/engine/engine-recovery.ts";

// ── Fixture builders ──────────────────────────────────────────────────────

/**
 * Build a fully-provisioned engine state from a declaration.
 * This mirrors the first half of `GraphToolSet.buildEngine()`.
 */
function buildState(decl: GraphDeclaration, graphId: string) {
  const s = createEngineState(decl, graphId);
  provision(s);
  return s;
}

/**
 * Simulate the construction-tool adoption flow: provision a fresh target
 * state (current declaration — edges present), then adopt per-node progress
 * from a prior state (earlier declaration — edges absent, so every node was
 * a root).
 *
 * Returns the target state AFTER adoption (the post-adoption reconciliation
 * pass runs inside `adoptPriorNodeStates`).
 */
function adopt(
  priorDecl: GraphDeclaration,
  targetDecl: GraphDeclaration,
): ReturnType<typeof buildState> {
  const prior = buildState(priorDecl, "g-adopt");
  const target = buildState(targetDecl, "g-adopt");
  adoptPriorNodeStates(target, prior);
  return target;
}

// ── Test cases ────────────────────────────────────────────────────────────

describe("adoptPrior topology reconciliation", () => {
  // ── Case (a): Sequential construction (the exact reported bug) ──────────

  describe("sequential construction — nodes before edges", () => {
    /**
     * Prior declaration: nodes A, B, C with NO edges.
     * After provision(): all three are roots → all Ready, frontier = [A,B,C].
     */
    const priorDecl: GraphDeclaration = {
      version: 2,
      name: "seq-prior",
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B", agent: "a", prompt: "pB" },
        { id: "C", agent: "a", prompt: "pC" },
      ],
      edges: [],
    };

    /**
     * Target declaration: same nodes + edge A→B.
     * After provision(): A in-degree 0 → Ready; B in-degree 1 → Pending;
     * C in-degree 0 → Ready.  Frontier = [A, C].
     */
    const targetDecl: GraphDeclaration = {
      version: 2,
      name: "seq-target",
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B", agent: "a", prompt: "pB" },
        { id: "C", agent: "a", prompt: "pC" },
      ],
      edges: [{ from: "A", to: "B", type: "always" }],
    };

    it("A is Ready and in the frontier (true root)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("A")!.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(target, "A")).toBe(true);
    });

    it("B is Pending and NOT in the frontier (demoted by reconciliation)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("B")!.status).toBe(NodeStatus.Pending);
      expect(isInFrontier(target, "B")).toBe(false);
    });

    it("C is Ready and in the frontier (unaffected root)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("C")!.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(target, "C")).toBe(true);
    });
  });

  // ── Case (b): Diamond / fan-in ─────────────────────────────────────────

  describe("diamond / fan-in — four-node dependency graph", () => {
    /**
     * In-degree derivation (from `computeInDegrees` rules):
     *
     *   - `isReviseBackEdge` check: none of the edges have signal_filter
     *     "revise_needed" → all edges are counted.
     *   - `isIntraLoopGroupAlwaysEdge` check: no loop groups declared → no
     *     intra-loop-group exclusions.
     *
     *   Edge A→B1  → B1's in-degree += 1  (B1: 1)
     *   Edge A→B2  → B2's in-degree += 1  (B2: 1)
     *   Edge B1→C  → C's in-degree += 1   (C: 1)
     *   Edge B2→C  → C's in-degree += 1   (C: 2)
     *
     *   Therefore:
     *     A  — in-degree 0 → Ready  (only true root)
     *     B1 — in-degree 1 → Pending
     *     B2 — in-degree 1 → Pending
     *     C  — in-degree 2 → Pending
     *   Frontier: [A]
     */
    const priorDecl: GraphDeclaration = {
      version: 2,
      name: "diamond-prior",
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B1", agent: "a", prompt: "pB1" },
        { id: "B2", agent: "a", prompt: "pB2" },
        { id: "C", agent: "a", prompt: "pC" },
      ],
      edges: [],
    };

    const targetDecl: GraphDeclaration = {
      version: 2,
      name: "diamond-target",
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B1", agent: "a", prompt: "pB1" },
        { id: "B2", agent: "a", prompt: "pB2" },
        { id: "C", agent: "a", prompt: "pC" },
      ],
      edges: [
        { from: "A", to: "B1", type: "always" },
        { from: "A", to: "B2", type: "always" },
        { from: "B1", to: "C", type: "always" },
        { from: "B2", to: "C", type: "always" },
      ],
    };

    it("A is Ready and in the frontier (sole root, in-degree 0)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("A")!.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(target, "A")).toBe(true);
    });

    it("B1 is Pending and NOT in the frontier (in-degree 1 from A)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("B1")!.status).toBe(NodeStatus.Pending);
      expect(isInFrontier(target, "B1")).toBe(false);
    });

    it("B2 is Pending and NOT in the frontier (in-degree 1 from A)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("B2")!.status).toBe(NodeStatus.Pending);
      expect(isInFrontier(target, "B2")).toBe(false);
    });

    it("C is Pending and NOT in the frontier (in-degree 2, fan-in sink)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("C")!.status).toBe(NodeStatus.Pending);
      expect(isInFrontier(target, "C")).toBe(false);
    });
  });

  // ── Case (c): Multi-root (guards against over-correction) ──────────────

  describe("multi-root — guards against over-correction", () => {
    /**
     * Nodes A, B, C with only edge A→B.
     *
     * In-degree:
     *   A  — 0 → Ready
     *   B  — 1 (from A) → Pending
     *   C  — 0 → Ready  (legitimate root — must NOT be demoted)
     *
     * Frontier: [A, C] — both must dispatch concurrently.
     *
     * If the fix ever over-corrects (e.g., by demoting all nodes adopted
     * as Ready regardless of in-degree), C would be incorrectly demoted
     * and this test would fail.
     */
    const priorDecl: GraphDeclaration = {
      version: 2,
      name: "multiroot-prior",
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B", agent: "a", prompt: "pB" },
        { id: "C", agent: "a", prompt: "pC" },
      ],
      edges: [],
    };

    const targetDecl: GraphDeclaration = {
      version: 2,
      name: "multiroot-target",
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B", agent: "a", prompt: "pB" },
        { id: "C", agent: "a", prompt: "pC" },
      ],
      edges: [{ from: "A", to: "B", type: "always" }],
    };

    it("A is Ready and in the frontier (root, in-degree 0)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("A")!.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(target, "A")).toBe(true);
    });

    it("C is Ready and in the frontier (legitimate root, in-degree 0 — must NOT be over-corrected)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("C")!.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(target, "C")).toBe(true);
    });

    it("B is Pending and NOT in the frontier (in-degree 1, downstream)", () => {
      const target = adopt(priorDecl, targetDecl);
      expect(target.nodes.get("B")!.status).toBe(NodeStatus.Pending);
      expect(isInFrontier(target, "B")).toBe(false);
    });
  });
});

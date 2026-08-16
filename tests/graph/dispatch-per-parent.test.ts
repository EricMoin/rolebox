/**
 * Graph Execution Engine — graph-node dispatch is NOT per-parent capped on graphId.
 *
 * Regression for Approach C. `graphParentContext` sets
 * `maxActivePerParent: Number.POSITIVE_INFINITY`, so a graph's nodes — all of
 * which share `parentSessionId = graphId` (the dispatch subsystem's per-parent
 * fairness key) — are never throttled by the dispatch config's per-parent
 * default (`maxActivePerParent = 3`). graphId is a request/budget scope, not a
 * real session needing per-parent protection; concurrency is engine-managed
 * (frontier, loop max_traversals, per-node budgets).
 *
 * Real-session parents (legacy dispatch_* tools) build contexts WITHOUT
 * `maxActivePerParent`, so task-launcher falls back to the config default and
 * per-parent fairness is unchanged — verified by the negative control below
 * and the existing dispatch suite (concurrency/manager/integration).
 *
 * These tests drive the REAL DispatchManager → task-launcher path over the
 * stub ISessionClient from tests/dispatch/helpers.ts (same rig as
 * engine-monitor-s6.test.ts) — a fake NodeDispatchPort would silently pass
 * regardless of the concurrency wiring.
 */

import { describe, it, expect } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import {
  DispatchBridge,
  graphParentContext,
} from "../../src/graph/engine/dispatch-bridge";
import {
  createEngineState,
  registerNode,
} from "../../src/graph/engine/engine-state";
import type { GraphDeclaration } from "../../src/types.graph-v2";
import { createMockClient, parentContext } from "../dispatch/helpers";

const WORKDIR = "/work/dir-for-dispatch-per-parent";
const GRAPH_ID = "g-per-parent";

/**
 * Config with headroom for 4+ concurrent sessions (maxConcurrent 6, no sync
 * reservation) while leaving `maxActivePerParent` at its DEFAULT of 3 — so the
 * only binder at 4 launches is the per-parent cap.
 */
const config = {
  maxConcurrent: 6,
  syncReservedSlots: 0,
  taskTtlMs: 60_000,
};

/** Minimal N-node declaration. All nodes share the same graphId parent. */
function multiNodeDecl(count: number): GraphDeclaration {
  return {
    version: 2,
    name: "per-parent",
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `N${i}`,
      agent: `agent-${i}`,
      prompt: `p${i}`,
    })),
    edges: [],
  };
}

describe("graphParentContext", () => {
  it("returns a context whose per-parent concurrency cap is unbounded", () => {
    const ctx = graphParentContext({ graphId: GRAPH_ID, directory: WORKDIR });

    expect(ctx.sessionID).toBe(GRAPH_ID);
    expect(ctx.maxActivePerParent).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Approach C — graph nodes are not per-parent capped on graphId", () => {
  it("launches 4+ independent background nodes concurrently under DEFAULT maxActivePerParent=3", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, config);
    const bridge = new DispatchBridge(manager);
    try {
      // Sanity: the per-parent default (3) is genuinely in effect — the
      // unbounded cap must come from the graph parent context, not config.
      expect(manager.getConfig().maxActivePerParent).toBe(3);

      const state = createEngineState(multiNodeDecl(4), GRAPH_ID);
      const ctx = graphParentContext({ graphId: GRAPH_ID, directory: WORKDIR });

      const tasks = [];
      for (const nodeDecl of state.graphDeclaration.nodes) {
        const node = registerNode(state, nodeDecl);
        tasks.push(await bridge.executeNode(node, ctx));
      }

      // All four nodes reach "running" concurrently — >3 sessions from one
      // parent (graphId) despite the per-parent config default of 3.
      expect(tasks.length).toBe(4);
      expect(tasks.every((t) => t.status === "running")).toBe(true);
      expect(tasks.filter((t) => t.status === "running").length).toBeGreaterThan(3);
      expect(manager.getInflightCount(GRAPH_ID)).toBe(4);
    } finally {
      await manager.dispose();
    }
  });

  it("real session parents keep the config per-parent cap (3 running, 1 queued) — negative control", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, config);
    const bridge = new DispatchBridge(manager);
    try {
      // Real-session shape: NO maxActivePerParent field → task-launcher falls
      // back to the config default (3), preserving per-parent fairness.
      const ctx = parentContext();
      const input = { subagent: "helper", prompt: "work", run_in_background: true };

      const tasks = [];
      for (let i = 0; i < 4; i++) {
        tasks.push(await bridge.launch(input, ctx));
      }

      expect(tasks.filter((t) => t.status === "running").length).toBe(3);
      expect(tasks.filter((t) => t.status === "pending").length).toBe(1);
      expect(manager.getInflightCount(ctx.sessionID)).toBe(3);
    } finally {
      await manager.dispose();
    }
  });
});

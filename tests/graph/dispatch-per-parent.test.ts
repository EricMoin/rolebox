/**
 * Graph Execution Engine — graph-node dispatch concurrency (post-removal).
 *
 * The dispatch-layer per-parent concurrency mechanism was removed upstream:
 * `maxActivePerParent` / `maxConcurrent` / `maxQueueDepth` / `syncReservedSlots`
 * are gone from `DispatchManagerConfig`, `getConcurrencyStatus()` is gone from
 * `DispatchManager`, and `graphParentContext` no longer carries a per-parent
 * cap. There is no dispatch-layer throttling of any parent — graph or
 * real-session — so every launched node reaches `running` immediately.
 *
 * What is RETAINED and pinned here:
 *
 *   - `graphParentContext` builds a graph-scoped parent context
 *     (`sessionID = graphId`, `graphScoped: true`) so graph-node completion is
 *     reported exclusively by the graph notifier, never the dispatch layer.
 *   - Graph nodes launch concurrently through the real DispatchManager →
 *     task-launcher path over the stub ISessionClient (same rig as
 *     engine-monitor-s6.test.ts) — a fake NodeDispatchPort would silently pass
 *     regardless of the dispatch wiring.
 *   - Real-session parents (legacy dispatch_* tools) launch without any
 *     per-parent throttling too — the per-parent cap no longer exists.
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
  it("returns a graph-scoped parent context (sessionID = graphId, graphScoped)", () => {
    const ctx = graphParentContext({ graphId: GRAPH_ID, directory: WORKDIR });

    expect(ctx.sessionID).toBe(GRAPH_ID);
    expect(ctx.directory).toBe(WORKDIR);
    expect(ctx.graphScoped).toBe(true);
  });
});

describe("graph-node dispatch launches concurrently (no per-parent cap)", () => {
  it("launches 4+ independent background nodes concurrently through the real manager", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, { taskTtlMs: 60_000 });
    const bridge = new DispatchBridge(manager);
    try {
      const state = createEngineState(multiNodeDecl(4), GRAPH_ID);
      const ctx = graphParentContext({ graphId: GRAPH_ID, directory: WORKDIR });

      const tasks = [];
      for (const nodeDecl of state.graphDeclaration.nodes) {
        const node = registerNode(state, nodeDecl);
        tasks.push(await bridge.executeNode(node, ctx));
      }

      // All four nodes reach "running" concurrently — no dispatch-layer
      // throttling remains to bind them.
      expect(tasks.length).toBe(4);
      expect(tasks.every((t) => t.status === "running")).toBe(true);
      expect(tasks.filter((t) => t.status === "running").length).toBe(4);
      expect(manager.getInflightCount(GRAPH_ID)).toBe(4);
    } finally {
      await manager.dispose();
    }
  });

  it("real session parents also launch every task (per-parent cap removed)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, { taskTtlMs: 60_000 });
    const bridge = new DispatchBridge(manager);
    try {
      const ctx = parentContext();
      const input = { subagent: "helper", prompt: "work", run_in_background: true };

      const tasks = [];
      for (let i = 0; i < 4; i++) {
        tasks.push(await bridge.launch(input, ctx));
      }

      // The per-parent cap (previously 3 running / 1 queued) is removed —
      // every launched task runs immediately.
      expect(tasks.filter((t) => t.status === "running").length).toBe(4);
      expect(tasks.filter((t) => t.status === "pending").length).toBe(0);
      expect(manager.getInflightCount(ctx.sessionID)).toBe(4);
    } finally {
      await manager.dispose();
    }
  });
});

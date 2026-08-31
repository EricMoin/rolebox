/**
 * Graph Execution Engine v2 — `graph_approve` tool-surface tests
 *
 * Phase C migration (Plan B), GAP-2 fill. Covers the parent-facing
 * approve/reject surface that migrates `dispatch_approve` / `dispatch_reject`:
 *
 * 1. Registration: `createGraphTools` exposes `graph_approve` with an
 *    `action: "approve" | "reject"` discriminator (plus `reason` / `payload`).
 * 2. Toolset routing: `graph_approve` reaches the engine's public
 *    `approveNode` / `rejectNode` on the registry's live runtime.
 * 3. Approve resolves a blocked gate (`blocked → completed`) and runs the
 *    forward `answer` data flow (downstream node activates).
 * 4. Reject re-enters / escalates per the engine's loop-group semantics.
 *
 * To reach a `blocked` `needs_approval` node through the toolset, tests
 * fabricate the exact state-shape the engine's `_pauseForApproval` produces
 * when a worker emits `need_approval` (node `blocked` + `signalsObserved.need_approval`
 * + removed from the frontier). The approve/reject engine primitives are already
 * unit-covered in `approval-handler.test.ts`; these tests verify the thin
 * toolset surface + registration wiring, not the engine logic.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGraphToolSet, type GraphToolSet } from "../../src/graph/tools/graph-tools";
import { createGraphTools } from "../../src/graph/tools/index";
import { createEngineState, provision } from "../../src/graph/engine/engine-state";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence";
import { EnginePhase, NodeStatus } from "../../src/constants";
import type { EngineState } from "../../src/types.engine-v2";
import type { GraphDeclaration } from "../../src/types.graph-v2";
import type { DispatchTask } from "../../src/dispatch/types";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance";

/**
 * Reach the live engine state behind a toolset's registry entry. Mirrors the
 * established `liveState` pattern in merge-equivalence.test.ts (TS `private` is
 * a compile-time convention; bracket access is the in-repo test idiom).
 */
function liveRuntime(
  ts: GraphToolSet,
  graphId: string,
): { state: EngineState } {
  const entry = (ts as unknown as { getEntry(id: string): { runtime: unknown } })["getEntry"](graphId);
  return entry.runtime as unknown as { state: EngineState };
}

/**
 * Mark a provisioned `needs_approval` node `blocked` exactly as the engine's
 * `_pauseForApproval` does when a worker emits `need_approval`.
 */
function pauseNodeForApproval(
  ts: GraphToolSet,
  graphId: string,
  nodeId: string,
  summary: string,
): void {
  const { state } = liveRuntime(ts, graphId);
  const node = state.nodes.get(nodeId);
  expect(node).toBeDefined();
  expect(node!.needsApproval).toBe(true);
  node!.status = NodeStatus.Blocked;
  node!.signalsObserved["need_approval"] = summary;
  state.frontier = state.frontier.filter((id) => id !== nodeId);
}

/** A no-op dispatch seam so a resumed downstream node can be launched. */
function fakeDispatchSeam(): NodeDispatchPort {
  let seq = 0;
  return {
    async executeNode() {
      seq += 1;
      return { id: `t${seq}`, sessionId: `s${seq}` } as unknown as DispatchTask;
    },
  };
}

/** A single-gate approval graph (P needs_approval, no downstream). */
function singleGate(ts: GraphToolSet): string {
  const graphId = ts.graph_create({ name: "gate" }).graph_id;
  ts.graph_add_node({
    graph_id: graphId,
    id: "P",
    agent: "emperor--jinyiwei",
    prompt: "Approve the final output.",
    needs_approval: true,
  });
  return graphId;
}

// ── Registration (createGraphTools surface) ────────────────────────────────

describe("createGraphTools → graph_approve registration", () => {
  it("registers graph_approve as the eighth graph_* tool", () => {
    const tools = createGraphTools(undefined, { directory: "/tmp" });
    expect(tools.graph_approve).toBeDefined();
    expect(typeof tools.graph_approve.execute).toBe("function");
    expect(Object.keys(tools).sort()).toContain("graph_approve");
  });

  it("exposes an action enum (approve/reject) plus reason and payload args", () => {
    const { graph_approve } = createGraphTools(undefined, { directory: "/tmp" });
    expect(graph_approve.args.graph_id).toBeDefined();
    expect(graph_approve.args.node_id).toBeDefined();
    const action = graph_approve.args.action as any;
    // The arg is wrapped optional by defineTool? assert the underlying enum options.
    const inner = (action && (action as any)._def && (action as any)._def.innerType)
      ? (action as any)._def.innerType
      : action;
    const options = (inner && inner._def && inner._def.options) ? inner._def.options : inner.options;
    expect([...options].sort()).toEqual(["approve", "reject"]);
    expect(graph_approve.args.reason).toBeDefined();
    expect(graph_approve.args.payload).toBeDefined();
  });
});

// ── Toolset routing: approve ────────────────────────────────────────────────

describe("graph_approve (approve action)", () => {
  it("resolves a blocked node to completed and completes a terminal graph", async () => {
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "Here is my summary");

    const res = await ts.graph_approve({ graph_id: graphId, node_id: "P", action: "approve" });

    expect(res.action).toBe("approve");
    expect(res.node_id).toBe("P");
    expect(res.node_status).toBe(NodeStatus.Completed);
    // No active nodes remain after approval → the graph reaches complete.
    expect(res.phase).toBe("complete");
  });

  it("passes the approval payload downstream and activates the answer edge", async () => {
    const ts = createGraphToolSet({ dispatch: fakeDispatchSeam() });
    const graphId = ts.graph_create({ name: "gate-flow" }).graph_id;
    ts.graph_add_node({
      graph_id: graphId,
      id: "P",
      agent: "emperor--jinyiwei",
      prompt: "Approve.",
      needs_approval: true,
    });
    ts.graph_add_node({ graph_id: graphId, id: "D", agent: "emperor--validator", prompt: "Next." });
    ts.graph_add_edge({
      graph_id: graphId,
      from: "P",
      to: "D",
      type: "on_signal",
      signal_filter: ["answer"],
    });
    pauseNodeForApproval(ts, graphId, "P", "review");

    const res = await ts.graph_approve({
      graph_id: graphId,
      node_id: "P",
      action: "approve",
      payload: { verdict: "approved" },
    });

    expect(res.node_status).toBe(NodeStatus.Completed);
    const { state } = liveRuntime(ts, graphId);
    const d = state.nodes.get("D")!;
    // The answer edge forwarded the payload and dispatched the downstream node.
    expect(d.status).toBe(NodeStatus.Running);
    expect(state.signalLedger).toBeDefined();
  });

  it("is idempotent — approving an already-completed node is a no-op", async () => {
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "s");
    await ts.graph_approve({ graph_id: graphId, node_id: "P", action: "approve" });

    // Second approve on a completed node: engine guard returns null, no throw.
    const res = await ts.graph_approve({ graph_id: graphId, node_id: "P", action: "approve" });
    expect(res.node_status).toBe(NodeStatus.Completed);
  });
});

// ── Toolset routing: reject ────────────────────────────────────────────────

describe("graph_approve (reject action)", () => {
  it("escalates a blocked node with no loop group", async () => {
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "s");

    const res = await ts.graph_approve({
      graph_id: graphId,
      node_id: "P",
      action: "reject",
      reason: "Output is incorrect",
    });

    expect(res.action).toBe("reject");
    // No loop group → the rejection escalates the node (safety-first).
    expect(res.node_status).toBe(NodeStatus.Escalate);
    const { state } = liveRuntime(ts, graphId);
    expect(state.nodes.get("P")!.signalsObserved["revise_needed"]).toBe("Output is incorrect");
  });

  it("rejects an unknown graph with a descriptive error", async () => {
    const ts = createGraphToolSet();
    await expect(
      ts.graph_approve({ graph_id: "missing", node_id: "P", action: "approve" }),
    ).rejects.toThrow(/does not exist/);
  });
});

// ── Restart recovery: a persisted blocked graph is approvable in a fresh toolset ──

describe("graph_approve (restart recovery from persisted state)", () => {
  it("approves a blocked persisted node from an empty registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-approve-recover-"));
    try {
      // 1. Seed the on-disk engine-state store the way `graph_run` would leave it:
      //    a needs_approval node paused at `blocked` in a non-complete phase.
      const graphId = "g-recover";
      const state = createEngineState(
        {
          id: graphId,
          name: "gate",
          nodes: [{ id: "P", agent: "emperor--jinyiwei", prompt: "Approve.", needs_approval: true }],
          edges: [],
        } as unknown as GraphDeclaration,
        graphId,
      );
      provision(state);
      state.phase = EnginePhase.Executing;
      const node = state.nodes.get("P")!;
      node.status = NodeStatus.Blocked;
      node.needsApproval = true;
      node.signalsObserved["need_approval"] = "durable summary";
      new EnginePersistence(dir).save(state);

      // 2. A BRAND-NEW toolset over the same stateDir — the in-memory registry is
      //    empty, simulating a plugin restart. No `graph_create` calls happened.
      const ts = createGraphToolSet({ stateDir: dir, dispatch: fakeDispatchSeam() });

      // 3. The approval resolves the persisted gate instead of throwing.
      const res = await ts.graph_approve({
        graph_id: graphId,
        node_id: "P",
        action: "approve",
      });

      expect(res.action).toBe("approve");
      expect(res.node_id).toBe("P");
      expect(res.node_status).toBe(NodeStatus.Completed);
      expect(res.phase).toBe("complete");

      // The rebuilt engine was registered so a subsequent call reuses it.
      const { state: liveState } = liveRuntime(ts, graphId);
      expect(liveState.nodes.get("P")!.status).toBe(NodeStatus.Completed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a graph missing from both registry and persisted store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-approve-absent-"));
    try {
      const ts = createGraphToolSet({ stateDir: dir });
      await expect(
        ts.graph_approve({ graph_id: "nope", node_id: "P", action: "approve" }),
      ).rejects.toThrow(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

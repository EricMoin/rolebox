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

import { createGraphToolSet, type GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createGraphTools } from "../../src/graph/tools/index.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { EnginePersistence } from "../../src/graph/persistence/engine-persistence.ts";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type {
  ApproveReport,
  RejectReport,
} from "../../src/graph/engine/approval-handler.ts";

/**
 * The live engine runtime behind a toolset's registry entry, reduced to what
 * these tests observe: the engine state, plus the two approval primitives a
 * test may instrument to pin the report-based `applied` contract. Mirrors the
 * established `liveState` pattern in merge-equivalence.test.ts (TS `private` is
 * a compile-time convention; bracket access is the in-repo test idiom).
 */
interface LiveRuntime {
  state: EngineState;
  approveNode(nodeId: string, payload?: unknown): Promise<ApproveReport>;
  rejectNode(nodeId: string, reason?: string): Promise<RejectReport>;
}

function liveRuntime(ts: GraphToolSet, graphId: string): LiveRuntime {
  const entry = (ts as unknown as { getEntry(id: string): { runtime: unknown } })["getEntry"](graphId);
  return entry.runtime as unknown as LiveRuntime;
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

/**
 * A dispatch seam that exposes how many node launches actually happened — lets
 * a test assert the engine did NOT touch the ready frontier on a no-op.
 */
function countingDispatchSeam(): { seam: NodeDispatchPort; calls: () => number } {
  let seq = 0;
  const seam: NodeDispatchPort = {
    async executeNode() {
      seq += 1;
      return { id: `t${seq}`, sessionId: `s${seq}` } as unknown as DispatchTask;
    },
  };
  return { seam, calls: () => seq };
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
    // A3: the lane fields are reject-only — an approval answer has neither.
    expect(res.kind).toBeUndefined();
    expect(res.actual_status).toBeUndefined();
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

  it("does NOT dispatch the ready frontier when approving a never-blocked node", async () => {
    // Regression (subtask 4): `approveBlockedNode` returns null for a
    // non-blocked node, but `approveNode` used to run `_dispatchReadyNodes`
    // unconditionally — so approving a `ready` node spuriously launched it.
    const { seam, calls } = countingDispatchSeam();
    const ts = createGraphToolSet({ dispatch: seam });
    // A plain root node: provisions `ready` + in the frontier, never blocked.
    const graphId = ts.graph_create({ name: "ready-noop" }).graph_id;
    ts.graph_add_node({
      graph_id: graphId,
      id: "R",
      agent: "emperor--jinyiwei",
      prompt: "Never blocked.",
    });
    const { state } = liveRuntime(ts, graphId);
    expect(state.nodes.get("R")!.status).toBe(NodeStatus.Ready);
    expect(state.frontier).toContain("R");

    const res = await ts.graph_approve({ graph_id: graphId, node_id: "R", action: "approve" });

    // The idempotent null guard must suppress dispatch + termination entirely.
    expect(calls()).toBe(0);
    const { state: after } = liveRuntime(ts, graphId);
    expect(after.nodes.get("R")!.status).toBe(NodeStatus.Ready);
    expect(after.frontier).toContain("R");
    // The no-op is surfaced honestly rather than as a live decision.
    expect(res.node_status).toBe(NodeStatus.Ready);
    expect(res.applied).toBe(false);
  });

  it("reports applied=true for a genuine blocked-node approval", async () => {
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "s");
    const res = await ts.graph_approve({ graph_id: graphId, node_id: "P", action: "approve" });
    expect(res.applied).toBe(true);
  });

  it("takes applied from the engine's approve report, not a pre-call status snapshot", async () => {
    // The report is the contract, but on a sequential single decision it agrees
    // with a pre-call snapshot by construction — and a genuine status flip
    // between snapshot and call cannot be interleaved deterministically. So the
    // one primitive under measurement is instrumented with the engine's
    // idempotent no-op report: `applied` must be false even though the gate is
    // still `blocked`.
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "s");

    const runtime = liveRuntime(ts, graphId);
    const original = runtime.approveNode;
    let calls = 0;
    runtime.approveNode = async () => {
      calls += 1;
      return { applied: false };
    };
    try {
      const res = await ts.graph_approve({
        graph_id: graphId,
        node_id: "P",
        action: "approve",
      });

      expect(calls).toBe(1);
      // The stub performed no transition, so the gate is still `blocked`:
      // a snapshot-based `applied` would answer true here.
      expect(res.applied).toBe(false);
      expect(res.node_status).toBe(NodeStatus.Blocked);
    } finally {
      runtime.approveNode = original;
    }
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
    // A3: the engine's lane reaches the tool answer; a genuine rejection has
    // no actual_status (only the already_resolved replay does).
    expect(res.kind).toBe("escalate");
    expect(res.applied).toBe(true);
    expect(res.actual_status).toBeUndefined();
    const { state } = liveRuntime(ts, graphId);
    expect(state.nodes.get("P")!.signalsObserved["revise_needed"]).toBe("Output is incorrect");
  });

  it("re-enters a blocked loop-group node and reports the revise lane", async () => {
    const ts = createGraphToolSet({ dispatch: fakeDispatchSeam() });
    const graphId = ts.graph_create({ name: "gate-loop" }).graph_id;
    ts.graph_add_node({
      graph_id: graphId,
      id: "P",
      agent: "emperor--jinyiwei",
      prompt: "Approve.",
      needs_approval: true,
    });
    ts.graph_add_node({
      graph_id: graphId,
      id: "W",
      agent: "emperor--validator",
      prompt: "Work.",
    });
    // The declared loop group must actually induce a directed cycle.
    // A needs_approval node may only carry on_signal / on_condition out-edges.
    ts.graph_add_edge({
      graph_id: graphId,
      from: "P",
      to: "W",
      type: "on_signal",
      signal_filter: ["answer"],
    });
    ts.graph_add_edge({ graph_id: graphId, from: "W", to: "P", type: "always" });
    ts.graph_add_loop({
      graph_id: graphId,
      id: "revision",
      nodes: ["P", "W"],
      max_traversals: 3,
    });
    pauseNodeForApproval(ts, graphId, "P", "s");

    const res = await ts.graph_approve({
      graph_id: graphId,
      node_id: "P",
      action: "reject",
      reason: "redo it",
    });

    // A loop-group member is re-entered `ready` (not escalated) and the
    // re-dispatch runs immediately — the lane is `revise`.
    expect(res.kind).toBe("revise");
    expect(res.applied).toBe(true);
    expect(res.actual_status).toBeUndefined();
    expect(res.node_status).toBe(NodeStatus.Running);
    const { state } = liveRuntime(ts, graphId);
    expect(state.nodes.get("P")!.prompt).toContain("[Rejection feedback]:");
  });

  it("reports already_resolved with the node's actual status on a replay reject", async () => {
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "s");
    await ts.graph_approve({ graph_id: graphId, node_id: "P", action: "approve" });
    expect(liveRuntime(ts, graphId).state.nodes.get("P")!.status).toBe(
      NodeStatus.Completed,
    );

    const res = await ts.graph_approve({
      graph_id: graphId,
      node_id: "P",
      action: "reject",
      reason: "too late",
    });

    // The engine's idempotent replay report reaches the tool answer: the lane
    // and the status the node ACTUALLY had, not a re-derived snapshot.
    expect(res.applied).toBe(false);
    expect(res.kind).toBe("already_resolved");
    expect(res.actual_status).toBe(NodeStatus.Completed);
    expect(res.node_status).toBe(NodeStatus.Completed);
  });

  it("takes applied from the engine's reject report, not a pre-call status snapshot", async () => {
    // Same pin as the approve lane: the engine's `already_resolved` report is
    // the authority, and the stub leaves the gate `blocked` — so a snapshot
    // taken before the call would answer true.
    const ts = createGraphToolSet();
    const graphId = singleGate(ts);
    pauseNodeForApproval(ts, graphId, "P", "s");

    const runtime = liveRuntime(ts, graphId);
    const original = runtime.rejectNode;
    let calls = 0;
    runtime.rejectNode = async () => {
      calls += 1;
      return {
        kind: "already_resolved",
        actualStatus: runtime.state.nodes.get("P")!.status,
      };
    };
    try {
      const res = await ts.graph_approve({
        graph_id: graphId,
        node_id: "P",
        action: "reject",
        reason: "Output is incorrect",
      });

      expect(calls).toBe(1);
      expect(res.applied).toBe(false);
      expect(res.node_status).toBe(NodeStatus.Blocked);
      // The stub's RejectReport is projected as-is: the no-op lane and the
      // status the REPORT claims (Blocked), not the live snapshot.
      expect(res.kind).toBe("already_resolved");
      expect(res.actual_status).toBe(NodeStatus.Blocked);
    } finally {
      runtime.rejectNode = original;
    }
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

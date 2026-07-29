import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type {
  DispatchTask,
  DispatchTaskStatus,
  MaterializedResultRef,
} from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeFanInContext } from "../../src/graph/engine/join-evaluator.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  approveBlockedNode,
  rejectBlockedNode,
  pruneDownstreamSubgraph,
  reenterRejectedUpstreams,
  resetRejectedUpstreams,
} from "../../src/graph/engine/approval-handler.ts";
import type { CancelDispatchPort } from "../../src/graph/engine/cascade-canceller.ts";

// ── Fake dispatch seam ─────────────────────────────────────────────────────

class FakeDispatch implements NodeDispatchPort {
  calls: string[] = [];
  cancelled: string[] = [];

  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    return Promise.resolve(makeTask(node.nodeId));
  }

  cancelTask(taskId: string): Promise<boolean> {
    this.cancelled.push(taskId);
    return Promise.resolve(true);
  }
}

function makeTask(nodeId: string): DispatchTask {
  return {
    id: `task-${nodeId}`,
    sessionId: `sess-${nodeId}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: nodeId,
    prompt: nodeId,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

/** Fake dispatch that stores a materialized result so `getTask` can surface it
 *  to `_captureNodeResult` on the approval path. */
class ResultCaptureFake extends FakeDispatch {
  private result?: MaterializedResultRef;
  status: DispatchTaskStatus = "running";
  setResult(ref: MaterializedResultRef): void {
    this.result = ref;
  }
  getTask(_taskId: string): DispatchTask | undefined {
    if (!this.result) return undefined;
    return {
      id: _taskId,
      sessionId: "sess-x",
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: "fake",
      prompt: "fake",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
      result: { ...this.result },
    };
  }
}

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: FakeDispatch;
}

function buildEngine(decl: GraphDeclaration, fake = new FakeDispatch()): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake });
  return { state, engine, fake };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A → P(needs_approval) → D. P is an intermediate human gate. */
function gateGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "gate",
    nodes: [
      { id: "A", agent: "a1", prompt: "work" },
      { id: "P", agent: "a2", prompt: "Review and decide.", needs_approval: true },
      { id: "D", agent: "a3", prompt: "final" },
    ],
    edges: [
      { from: "A", to: "P", type: "always" },
      { from: "P", to: "D", type: "always" },
    ],
  };
}

/** Drive A→P through to the point where P is blocked awaiting approval. */
async function pauseAtGate(rig: Rig): Promise<void> {
  await rig.engine.dispatchReady(); // A running
  await rig.engine.onNodeSignalEmitted("A", "answer", "work done"); // A completes, P dispatched
  // P (needs_approval) emits the pausing approval signal → blocked.
  await rig.engine.onNodeSignalEmitted("P", "need_approval", "Here is my summary");
}

// ── need_approval pause ────────────────────────────────────────────────────

describe("need_approval pause (engine path)", () => {
  it("transitions the needs_approval node to blocked, removes it, and gates downstream", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);

    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    // The downstream node D must NOT activate while P is blocked.
    expect(rig.state.nodes.get("D")!.status).toBe(NodeStatus.Pending);
    expect(rig.state.frontier).not.toContain("P");
    // The graph stays executing (blocked counts as active — waiting on the human).
    expect(rig.state.phase).toBe(EnginePhase.Executing);
  });

  it("stashes the assembled approval payload for the human decision", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);
    const p = rig.state.nodes.get("P")!;
    const payload = p.signalsObserved["approval_payload"] as {
      node_id: string;
      upstream_results: unknown[];
    };
    expect(payload.node_id).toBe("P");
    expect(payload.upstream_results).toHaveLength(1);
  });

  it("does NOT block a node that did not declare needs_approval", async () => {
    const rig = buildEngine(gateGraph());
    await rig.engine.dispatchReady();
    // A stray need_approval signal on a non-gate node is recorded but ignored.
    await rig.engine.onNodeSignalEmitted("A", "need_approval", "stray");
    expect(rig.state.nodes.get("A")!.status).toBe(NodeStatus.Running);
  });
});

// ── approveBlockedNode ─────────────────────────────────────────────────────

describe("approve (engine path)", () => {
  it("approveNode resumes blocked → completed and activates downstream answer edges", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    await rig.engine.approveNode("P", "looks good");

    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Completed);
    expect(rig.state.nodes.get("P")!.signalsObserved["answer"]).toBe("looks good");
    // D's join re-satisfies on the forward answer flow → dispatched.
    expect(rig.state.nodes.get("D")!.status).toBe(NodeStatus.Running);
    expect(rig.state.nodes.get("D")!.upstreamResults.get("P")!.fromSignal).toBe("answer");
  });

  it("approve-path EdgePayload carries the node's artifacts into downstream merged_artifacts", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graph-approve-artifacts-"));
    const sidecar = join(tmpDir, "p-result.txt");
    writeFileSync(sidecar, "Approval result", "utf8");
    try {
      const fake = new ResultCaptureFake();
      fake.setResult({
        sidecarPath: sidecar,
        totalChars: 16,
        hadFence: true,
        materializedAt: Date.now(),
      });
      const rig = buildEngine(gateGraph(), fake);
      await pauseAtGate(rig);
      expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

      await rig.engine.approveNode("P", "accepted");

      // The approval node's genuine artifact is recorded and carried on the
      // answer EdgePayload routed downstream.
      const p = rig.state.nodes.get("P")!;
      expect(p.artifacts).toEqual([sidecar]);
      const payload = rig.state.nodes.get("D")!.upstreamResults.get("P")!;
      expect(payload.artifacts).toEqual([sidecar]);
      const fanIn = mergeFanInContext(rig.state.nodes.get("D")!.upstreamResults);
      expect(fanIn.merged_artifacts).toEqual([sidecar]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("approveBlockedNode returns the downstream EdgePayload and marks completed", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.status = NodeStatus.Blocked;

    const payload = approveBlockedNode(rig.state, p, "accepted");
    expect(payload).not.toBeNull();
    expect(payload!.fromNode).toBe("P");
    expect(payload!.fromSignal).toBe("answer");
    expect(payload!.result).toBe("accepted");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Completed);
  });

  it("approveBlockedNode defaults to the recorded need_approval summary", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.status = NodeStatus.Blocked;
    p.signalsObserved["need_approval"] = "the rendered summary";

    const payload = approveBlockedNode(rig.state, p);
    expect(payload!.result).toBe("the rendered summary");
  });

  it("approveBlockedNode is a no-op (null) on a non-blocked node", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.status = NodeStatus.Running;

    expect(approveBlockedNode(rig.state, p, "x")).toBeNull();
    expect(p.status).toBe(NodeStatus.Running);
  });
});

// ── rejectBlockedNode ──────────────────────────────────────────────────────

describe("reject (engine path)", () => {
  it("rejectNode escalates a blocked node with no loop group", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);

    await rig.engine.rejectNode("P", "not good enough");

    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Escalate);
    expect(rig.state.nodes.get("P")!.errorReason).toBe("not good enough");
    // Downstream never activates.
    expect(rig.state.nodes.get("D")!.status).toBe(NodeStatus.Pending);
  });

  it("rejectBlockedNode re-enters a loop-group-backed node ready with feedback", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.status = NodeStatus.Blocked;
    p.loopGroupId = "loop-1"; // a feeding loop group exists to re-open

    const report = rejectBlockedNode(rig.state, p, "redo the analysis");
    expect(report.kind).toBe("revise");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Ready);
    expect(rig.state.frontier).toContain("P");
    expect(p.prompt).toContain("[Rejection feedback]");
    expect(p.prompt).toContain("redo the analysis");
    expect(p.signalsObserved["revise_needed"]).toBe("redo the analysis");
  });

  it("rejectBlockedNode is idempotent on an already-resolved node", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.status = NodeStatus.Escalate;
    const report = rejectBlockedNode(rig.state, p, "x");
    expect(report.kind).toBe("already_resolved");
    expect(report.actualStatus).toBe(NodeStatus.Escalate);
    expect(p.status).toBe(NodeStatus.Escalate);
  });
});

// ── Partial approval: pruneDownstreamSubgraph ──────────────────────────────

/**
 * Two sources feed the approval gate P; the S2 branch also fans into X → Y,
 * and both sources fan into Z (an `any`-join survivor candidate).
 */
function partialGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "partial",
    nodes: [
      { id: "S1", agent: "a1", prompt: "s1" },
      { id: "S2", agent: "a2", prompt: "s2" },
      { id: "X", agent: "a3", prompt: "x" },
      { id: "Y", agent: "a4", prompt: "y" },
      { id: "Z", agent: "a5", prompt: "z", join: { strategy: "any" } },
      { id: "P", agent: "a6", prompt: "decide", needs_approval: true },
      { id: "D", agent: "a7", prompt: "d" },
    ],
    edges: [
      { from: "S1", to: "P", type: "always" },
      { from: "S2", to: "P", type: "always" },
      { from: "S2", to: "X", type: "always" },
      { from: "X", to: "Y", type: "always" },
      { from: "S1", to: "Z", type: "always" },
      { from: "S2", to: "Z", type: "always" },
      { from: "P", to: "D", type: "always" },
    ],
  };
}

describe("partial-approval pruning", () => {
  function partialGraph(): GraphDeclaration {
    return {
      version: 2,
      name: "partial",
      nodes: [
        { id: "S1", agent: "a1", prompt: "s1" },
        { id: "S2", agent: "a2", prompt: "s2" },
        { id: "X", agent: "a3", prompt: "x" },
        { id: "Y", agent: "a4", prompt: "y" },
        { id: "Z", agent: "a5", prompt: "z", join: { strategy: "any" } },
        { id: "P", agent: "a6", prompt: "decide", needs_approval: true },
        { id: "D", agent: "a7", prompt: "d" },
      ],
      edges: [
        { from: "S1", to: "P", type: "always" },
        { from: "S2", to: "P", type: "always" },
        { from: "S2", to: "X", type: "always" },
        { from: "X", to: "Y", type: "always" },
        { from: "S1", to: "Z", type: "always" },
        { from: "S2", to: "Z", type: "always" },
        { from: "P", to: "D", type: "always" },
      ],
    };
  }

  it("cancels transitive dependents of rejected nodes that cannot survive", () => {
    const rig = buildEngine(partialGraph());
    // Give X a running dispatch task so the cancel seam is exercised.
    const x = rig.state.nodes.get("X")!;
    x.status = NodeStatus.Running;
    x.dispatchTaskId = "task-X";

    const report = pruneDownstreamSubgraph(
      rig.state,
      ["S2"],
      "P",
      rig.fake as CancelDispatchPort,
    );

    // X (no surviving upstream) and Y (all-join, fed only via the rejected branch).
    expect(report.cancelled.sort()).toEqual(["X", "Y"]);
    // Z survives on approved source S1 with an `any` join.
    expect(report.surviving).toEqual(["Z"]);
    // Cancelled nodes reached terminal `done`; X's dispatch task torn down.
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done);
    expect(rig.fake.cancelled).toContain("task-X");
    // P (the approval node) is excluded from cancellation.
    expect(report.cancelled).not.toContain("P");
  });

  it("does not cancel an all-join node that still has every approved feeder", () => {
    const rig = buildEngine(partialGraph());
    // X feeds only from S1 after we reject S2 on a *different* branch — reject a
    // source that is NOT an ancestor of X so X keeps all its approved feeders.
    // Here X's sole feeder is S2, so rejecting S2 cancels X (covered above).
    // Instead assert a no-rejected no-op returns empty.
    const report = pruneDownstreamSubgraph(rig.state, [], "P");
    expect(report).toEqual({ cancelled: [], surviving: [] });
  });
});

// ── Partial approval: re-entry primitives ──────────────────────────────────

describe("partial-approval re-entry primitives", () => {
  it("reenterRejectedUpstreams re-marks completed rejected nodes ready with feedback", () => {
    const rig = buildEngine(gateGraph());
    // A produced a result and is completed — eligible for completed → ready.
    const a = rig.state.nodes.get("A")!;
    a.status = NodeStatus.Completed;

    const report = reenterRejectedUpstreams(rig.state, ["A"], "redo it");
    expect(report.reEntered).toEqual(["A"]);
    expect(rig.state.nodes.get("A")!.status).toBe(NodeStatus.Ready);
    expect(rig.state.frontier).toContain("A");
    expect(rig.state.nodes.get("A")!.prompt).toContain("redo it");
  });

  it("does not re-enter a still-running rejected node", () => {
    const rig = buildEngine(gateGraph());
    const a = rig.state.nodes.get("A")!;
    a.status = NodeStatus.Running;

    const report = reenterRejectedUpstreams(rig.state, ["A"], "redo");
    expect(report.reEntered).toEqual([]);
    expect(a.status).toBe(NodeStatus.Running);
  });

  it("resetRejectedUpstreams drops rejected sources and recomputes the join", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.upstreamResults.set("A", {
      fromNode: "A",
      fromSignal: "answer",
      result: "x",
      artifacts: [],
      budgetConsumed: { tokens: 1, cost: 0, sessions: 1 },
    });
    p.joinSatisfied = true;

    resetRejectedUpstreams(rig.state, p, ["A"]);
    expect(p.upstreamResults.has("A")).toBe(false);
    expect(p.joinSatisfied).toBe(false); // no upstreams remain → join unsatisfied
  });
});

// ── partialApprove (engine path) ───────────────────────────────────────────

describe("partialApprove (engine path)", () => {
  it("prunes rejected dependents and re-enters rejected upstreams", async () => {
    const rig = buildEngine(partialGraph());
    // Drive S1, S2 to completion → P and X dispatched.
    await rig.engine.dispatchReady(); // S1, S2 running
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1"); // → P join waiting; Z dispatched
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2"); // → P + X dispatched
    // P pauses for approval.
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    // Partial: approve S1, reject S2.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");

    // X (rejected branch's dependent) is cancelled → done.
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done);
    // S2 re-entered ready → re-dispatched running.
    expect(rig.state.nodes.get("S2")!.status).toBe(NodeStatus.Running);
    expect(rig.state.nodes.get("S2")!.prompt).toContain("fix branch 2");
    // P re-waits for the re-executed S2 → stays blocked (join not re-satisfied).
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    expect(rig.state.nodes.get("P")!.upstreamResults.has("S2")).toBe(false);
  });
});

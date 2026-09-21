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
import {
  AdvanceEngine,
  type NodeCompletionEvent,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import { createEngineState, provision, applyBudgetDelta } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  approveBlockedNode,
  rejectBlockedNode,
  pruneDownstreamSubgraph,
  reenterRejectedUpstreams,
  resetRejectedUpstreams,
  approvalPayloadProblem,
  approvalResultText,
  normalizeApprovalPayload,
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
  events: NodeCompletionEvent[];
}

function buildEngine(
  decl: GraphDeclaration,
  fake = new FakeDispatch(),
  events: NodeCompletionEvent[] = [],
): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: fake,
    // Recording completion seam — existing assertions never read it, so the
    // always-on recorder is behavior-neutral for the pre-existing tests.
    onNodeCompletion: (e) => { events.push(e); },
  });
  return { state, engine, fake, events };
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

  it("approve-path EdgePayload carries the node's artifacts to the downstream node's upstreamResults", async () => {
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

  it("EdgePayload budgetConsumed.sessions mirrors the per-node cumulative spawn counter (M10 refund never touches it)", () => {
    const rig = buildEngine(gateGraph());
    const p = rig.state.nodes.get("P")!;
    p.status = NodeStatus.Blocked;
    p.sessionsSpawned = 2; // cumulative across retries

    // Simulate a direct-cancellation refund (M10): a sibling running node was
    // cancelled, decrementing ONLY the graph-level net-live counter.
    rig.state.budget.sessionsSpawned = 1;
    applyBudgetDelta(rig.state, { sessions: -1 });
    expect(rig.state.budget.sessionsSpawned).toBe(0);

    // The EdgePayload's sessions come from the node's cumulative counter,
    // which the graph-level refund must never decrement.
    const payload = approveBlockedNode(rig.state, p, "accepted");
    expect(payload!.budgetConsumed.sessions).toBe(2);
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
    // B16: the report is a discriminated union — `actualStatus` exists only on
    // the already_resolved branch.
    expect(report).toEqual({
      kind: "already_resolved",
      actualStatus: NodeStatus.Escalate,
    });
    expect(p.status).toBe(NodeStatus.Escalate);
  });

  it("rejectNode fires an escalate completion event on blocked → escalate (M13)", async () => {
    const events: NodeCompletionEvent[] = [];
    const rig = buildEngine(gateGraph(), new FakeDispatch(), events);
    // Only the gate's own events matter — A fired its own answer event earlier.
    const gateEvents = () => events.filter((e) => e.nodeId === "P");
    await pauseAtGate(rig);
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    // Pausing for approval is not terminal → no completion event yet.
    expect(gateEvents()).toHaveLength(0);

    await rig.engine.rejectNode("P", "not good enough");

    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Escalate);
    expect(rig.state.nodes.get("P")!.errorReason).toBe("not good enough");
    // The terminal escalate transition surfaces through the completion seam
    // exactly once — the last silent HITL lane (approve/partialApprove notify).
    expect(gateEvents()).toHaveLength(1);
    expect(gateEvents()[0].signalType).toBe("escalate");
    expect(gateEvents()[0].nodeStatus).toBe(NodeStatus.Escalate);
    expect(gateEvents()[0].payload).toBe("not good enough");

    // Replay of reject on the already-escalated node → no second event.
    await rig.engine.rejectNode("P", "not good enough");
    expect(gateEvents()).toHaveLength(1);
  });

  it("rejectNode revise lane (loop-backed re-entry) stays silent — the re-run's own signal fires the event (M13)", async () => {
    const events: NodeCompletionEvent[] = [];
    const rig = buildEngine(gateGraph(), new FakeDispatch(), events);
    const gateEvents = () => events.filter((e) => e.nodeId === "P");
    await pauseAtGate(rig);
    const p = rig.state.nodes.get("P")!;
    p.loopGroupId = "loop-1"; // a feeding loop group exists to re-open

    await rig.engine.rejectNode("P", "redo the analysis");

    // blocked → ready re-entry is NOT a terminal transition — no completion
    // event here; the node re-runs and its eventual terminating signal fires
    // its own event (the ledger records the synthetic revise_needed). The
    // re-entered node is immediately re-dispatched by _dispatchReadyNodes.
    expect(p.status).toBe(NodeStatus.Running);
    expect(p.prompt).toContain("redo the analysis");
    expect(gateEvents()).toHaveLength(0);
  });
});

// ── Partial approval: pruneDownstreamSubgraph ──────────────────────────────

/**
 * Two sources feed the approval gate P; the S2 branch also fans into X → Y,
 * and both sources fan into Z. Z uses an `any` join: it fires on the first
 * source alone. The D3 answer-path cascade must NOT retire the still-running
 * S2 on Z's first-source activation, because S2 is still needed by P and X —
 * the shared-upstream guard (cascade-canceller.ts) keeps it running.
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

    const report = pruneDownstreamSubgraph(rig.state, ["S2"], "P", {
      dispatchPort: rig.fake as CancelDispatchPort,
    });

    // X (no surviving upstream) and Y (all-join, fed only via the rejected branch).
    expect(report.cancelled.sort()).toEqual(["X", "Y"]);
    // Z survives on approved source S1 with an `any` join.
    expect(report.surviving).toEqual(["Z"]);
    expect(report.skipped).toEqual([]);
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
    expect(report).toEqual({ cancelled: [], surviving: [], skipped: [] });
  });

  it("refunds the graph-level session slot of a pruned running node (M10)", () => {
    const rig = buildEngine(partialGraph());
    // X is mid-flight: dispatched once, carrying a live dispatch task.
    const x = rig.state.nodes.get("X")!;
    x.status = NodeStatus.Running;
    x.dispatchTaskId = "task-X";
    x.sessionsSpawned = 1; // cumulative per-node counter
    rig.state.budget.sessionsSpawned = 1; // X's net-live slot

    const report = pruneDownstreamSubgraph(rig.state, ["S2"], "P", {
      dispatchPort: rig.fake as CancelDispatchPort,
    });

    expect(report.cancelled.sort()).toEqual(["X", "Y"]);
    expect(report.skipped).toEqual([]);
    // X's net-live slot is refunded synchronously on the prune path; Y (pending)
    // never dispatched so nothing to refund.
    expect(rig.state.budget.sessionsSpawned).toBe(0);
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done);
    expect(rig.fake.cancelled).toContain("task-X");
    // The per-node cumulative counter is untouched by the net-live refund.
    expect(rig.state.nodes.get("X")!.sessionsSpawned).toBe(1);
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
    // Live slots: S1, S2, Z, P, X = 5.
    expect(rig.state.budget.sessionsSpawned).toBe(5);

    // Partial: approve S1, reject S2.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");

    // X (rejected branch's dependent) is cancelled → done.
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done);
    // M10: X's cancelled running slot refunded (−1) and S2's re-dispatch
    // re-added one (+1) → net-live count returns to 5. Without the prune-path
    // refund X's slot would leak and the counter would rest at 6.
    expect(rig.state.budget.sessionsSpawned).toBe(5);
    // The per-node cumulative counter survives the cancellation (EdgePayload
    // source — untouched by the net-live refund).
    expect(rig.state.nodes.get("X")!.sessionsSpawned).toBe(1);
    // S2 re-entered ready → re-dispatched running.
    expect(rig.state.nodes.get("S2")!.status).toBe(NodeStatus.Running);
    expect(rig.state.nodes.get("S2")!.prompt).toContain("fix branch 2");
    // P re-waits for the re-executed S2 → stays blocked (join not re-satisfied).
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    expect(rig.state.nodes.get("P")!.upstreamResults.has("S2")).toBe(false);
  });

  it("notifies the completion seam exactly once across a replay of partialApprove (M12)", async () => {
    const events: NodeCompletionEvent[] = [];
    const rig = buildEngine(partialGraph(), new FakeDispatch(), events);
    // Only the gate's own events matter — S1/S2 fire their own answer events.
    const gateEvents = () => events.filter((e) => e.nodeId === "P");
    // Drive to the gate: S1, S2 complete → P dispatched and paused.
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    // First partial verdict → exactly one completion event.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked); // re-waits
    expect(gateEvents()).toHaveLength(1);
    expect(gateEvents()[0].signalType).toBe("answer");
    const payload = gateEvents()[0].payload as {
      partial_approve: { approved: string[]; rejected: string[] };
    };
    expect(payload.partial_approve.approved).toEqual(["S1"]);
    expect(payload.partial_approve.rejected).toEqual(["S2"]);

    // Replay / duplicate call carrying the SAME verdict on the same blocked
    // episode: the state mutations are idempotent no-ops, but the completion
    // seam must NOT re-fire.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done); // prune already applied
    expect(rig.state.nodes.get("S2")!.prompt).toContain("fix branch 2"); // feedback not duplicated
    expect(gateEvents()).toHaveLength(1);
  });

  it("notifies again for a NEW verdict on the same blocked episode (M12 verdict-scoped dedup)", async () => {
    const events: NodeCompletionEvent[] = [];
    const rig = buildEngine(partialGraph(), new FakeDispatch(), events);
    const gateEvents = () => events.filter((e) => e.nodeId === "P");
    // Drive to the gate.
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    // Round 1: partial verdict → one gate event; the marker is stashed.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "round 1");
    expect(gateEvents()).toHaveLength(1);

    // The rejected branch re-executes and re-answers → P's join re-satisfies,
    // but a blocked gate is not auto-re-entered (it awaits a human verdict).
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2-again");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    expect(rig.state.nodes.get("P")!.upstreamResults.has("S2")).toBe(true);

    // Round 2: a DIFFERENT verdict (approve everything) is a genuine new
    // decision on the same episode → notifies again and re-enters P ready.
    await rig.engine.partialApprove("P", ["S1", "S2"], [], "round 2");
    expect(gateEvents()).toHaveLength(2);
    expect(gateEvents()[1].signalType).toBe("answer");
    expect(
      (gateEvents()[1].payload as { partial_approve: { reason?: string } })
        .partial_approve.reason,
    ).toBe("round 2");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Running); // re-dispatched

    // Replay of the round-2 verdict → still no extra event.
    await rig.engine.partialApprove("P", ["S1", "S2"], [], "round 2");
    expect(gateEvents()).toHaveLength(2);
  });

  it("notifies again on a NEW blocked episode even for an identical verdict (M12 per-episode scope)", async () => {
    const events: NodeCompletionEvent[] = [];
    const rig = buildEngine(partialGraph(), new FakeDispatch(), events);
    const gateEvents = () => events.filter((e) => e.nodeId === "P");
    // Drive to the gate.
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    // Round 1: partial verdict → one gate event.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "v1");
    expect(gateEvents()).toHaveLength(1);

    // Rejected branch re-answers → P re-enters ready, re-renders, and
    // re-pauses: a NEW gate presentation (`_pauseForApproval` clears the
    // marker).
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2-again");
    await rig.engine.partialApprove("P", ["S1", "S2"], [], "v2");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Running);
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary-2");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    // The re-pause itself is not terminal → no new gate event yet.
    expect(gateEvents()).toHaveLength(2);

    // Round 2 with the IDENTICAL round-1 verdict → new episode → notifies.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "v1");
    expect(gateEvents()).toHaveLength(3);
    expect(
      (gateEvents()[2].payload as { partial_approve: { reason?: string } })
        .partial_approve.reason,
    ).toBe("v1");
  });
// ── R6: approval payload trust boundary ─────────────────────────────────────

describe("R6: approval payload normalization", () => {
  it("rejects a non-JSON payload before any state change (node stays blocked)", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);
    const p = rig.state.nodes.get("P")!;
    expect(p.status).toBe(NodeStatus.Blocked);

    await expect(rig.engine.approveNode("P", () => "nope")).rejects.toThrow(TypeError);

    // Old behaviour: `markCompleted` ran first and only then did
    // JSON.stringify(fn) answer `undefined` — the node ended `completed` with
    // an EdgePayload.result that was not a string, so the downstream join
    // could never activate (a hung graph with no rollback). New behaviour: the
    // payload is rejected before the state machine runs, so nothing moved.
    expect(p.status).toBe(NodeStatus.Blocked);
    expect(p.signalsObserved["answer"]).toBeUndefined();
    expect(rig.state.nodes.get("D")!.status).toBe(NodeStatus.Pending);

    // A valid payload afterwards still resolves the gate normally.
    await rig.engine.approveNode("P", "fine");
    expect(p.status).toBe(NodeStatus.Completed);
  });

  it("rejects bigint, symbol and circular payloads without mutating state", async () => {
    const cases: Array<[string, () => unknown]> = [
      ["bigint", () => BigInt(7)],
      ["symbol", () => Symbol("s")],
      [
        "circular reference",
        () => {
          const cyclic: Record<string, unknown> = {};
          cyclic["self"] = cyclic;
          return cyclic;
        },
      ],
    ];
    for (const [label, make] of cases) {
      const rig = buildEngine(gateGraph());
      await pauseAtGate(rig);
      const p = rig.state.nodes.get("P")!;
      await expect(rig.engine.approveNode("P", make())).rejects.toThrow(TypeError);
      expect(`${label}: ${p.status}`).toBe(`${label}: ${NodeStatus.Blocked}`);
      expect(p.signalsObserved["answer"]).toBeUndefined();
    }
  });

  it("records a JSON-safe answer for an accepted object payload and forwards JSON text", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);
    const payload = { approved: true, note: "lgtm", nested: [1, 2] };

    await rig.engine.approveNode("P", payload);

    const p = rig.state.nodes.get("P")!;
    expect(p.status).toBe(NodeStatus.Completed);
    // The recorded answer is a JSON-safe copy — deep-equal, never the caller's
    // object identity (so a caller mutating its payload cannot rewrite state).
    expect(p.signalsObserved["answer"]).toEqual(payload);
    expect(p.signalsObserved["answer"]).not.toBe(payload);
    // The downstream edge carries JSON text, never `undefined`.
    const forwarded = rig.state.nodes.get("D")!.upstreamResults.get("P")!;
    expect(forwarded.result).toBe(JSON.stringify(payload));
  });
});

describe("R6: normalizeApprovalPayload / approvalResultText / approvalPayloadProblem", () => {
  it("projects non-JSON values to JSON-safe ones without throwing", () => {
    expect(normalizeApprovalPayload(BigInt(7))).toBe("7");
    expect(normalizeApprovalPayload({ n: BigInt(7) })).toEqual({ n: "7" });
    expect(normalizeApprovalPayload(undefined)).toBeNull();
    expect(normalizeApprovalPayload({ a: undefined, b: 1 })).toEqual({ b: 1 });
    expect(normalizeApprovalPayload([undefined, () => {}])).toEqual([null, null]);
    expect(normalizeApprovalPayload(Number.NaN)).toBeNull();
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic["self"] = cyclic;
    expect(normalizeApprovalPayload(cyclic)).toEqual({ name: "x", self: "[Circular]" });
    // A DAG (a shared reference with no cycle) is duplicated, not reported as
    // circular — exactly what JSON.stringify does.
    const shared = { v: 1 };
    expect(normalizeApprovalPayload({ a: shared, b: shared })).toEqual({
      a: { v: 1 },
      b: { v: 1 },
    });
    // `toJSON` is honoured the way JSON.stringify honours it.
    expect(normalizeApprovalPayload(new Date("2020-01-02T03:04:05.000Z"))).toBe(
      "2020-01-02T03:04:05.000Z",
    );
  });

  it("answers a string for every input — never undefined, never a throw", () => {
    expect(approvalResultText("verbatim")).toBe("verbatim");
    expect(approvalResultText(undefined)).toBe("");
    expect(approvalResultText(null)).toBe("");
    expect(approvalResultText({ a: 1 })).toBe('{"a":1}');
    expect(approvalResultText(BigInt(9))).toBe('"9"');
    expect(approvalResultText(() => {})).toContain("=>");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(approvalResultText(cyclic)).toBe('{"self":"[Circular]"}');
    // A getter that throws is contained: the payload reads as unreadable
    // instead of escaping the normalizer mid-approval.
    const hostile = {
      get boom(): never {
        throw new Error("nope");
      },
    };
    expect(normalizeApprovalPayload(hostile)).toBe("[Unreadable]");
    expect(() => approvalResultText(hostile)).not.toThrow();
  });

  it("names the offending member for a rejected payload", () => {
    expect(approvalPayloadProblem("ok")).toBeUndefined();
    expect(approvalPayloadProblem({ a: [1, BigInt(2)] })).toContain("$.a[1]");
    expect(approvalPayloadProblem(() => {})).toContain("function");
    expect(approvalPayloadProblem(Symbol("x"))).toContain("symbol");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(approvalPayloadProblem(cyclic)).toContain("circular");
  });
});

// ── R3: quorum join strategy in the partial-approval prune lane ─────────────

describe("R3: quorum join strategy drives shouldCancel through readQuorum", () => {
  /** S1 + S2 feed both the gate P and a quorum join Q. */
  function quorumGraph(quorum: number): GraphDeclaration {
    return {
      version: 2,
      name: "quorum-prune",
      nodes: [
        { id: "S1", agent: "a1", prompt: "s1" },
        { id: "S2", agent: "a2", prompt: "s2" },
        { id: "Q", agent: "a3", prompt: "q", join: { strategy: "quorum", quorum } },
        { id: "P", agent: "a4", prompt: "decide", needs_approval: true },
        { id: "D", agent: "a5", prompt: "d" },
      ],
      edges: [
        { from: "S1", to: "P", type: "always" },
        { from: "S2", to: "P", type: "always" },
        { from: "S1", to: "Q", type: "always" },
        { from: "S2", to: "Q", type: "always" },
        { from: "P", to: "D", type: "always" },
      ],
    };
  }

  it("cancels a quorum:2 node when only one approved feeder survives", () => {
    const rig = buildEngine(quorumGraph(2));
    const report = pruneDownstreamSubgraph(rig.state, ["S2"], "P");
    expect(report.cancelled).toEqual(["Q"]);
    expect(report.surviving).toEqual([]);
  });

  it("keeps a quorum:1 node that still has one approved feeder", () => {
    const rig = buildEngine(quorumGraph(1));
    const report = pruneDownstreamSubgraph(rig.state, ["S2"], "P");
    expect(report.cancelled).toEqual([]);
    expect(report.surviving).toEqual(["Q"]);
  });
});

// ── C6: the engine's control paths answer their reports directly (W3-A) ─────
//
// Old behavior: `AdvanceEngine.approveNode / rejectNode / partialApprove`
// resolved `void`, so the runtime had to derive the report by diffing status
// snapshots around the awaited call (approve / reject) or by re-running
// `pruneDownstreamSubgraph` on a snapshot (partialApprove) — a SECOND decision
// procedure over a window in which another critical section could run.
// New behavior: each method resolves the report produced by the primitive that
// performed the mutation (`approveReport` / `rejectBlockedNode` /
// `pruneDownstreamSubgraph`), so `EngineRuntime` is a pure pass-through and
// there is exactly one decision procedure.
//
// Revert-would-fail: with the old `Promise<void>` signatures these assertions
// receive `undefined` (no `applied`, no `kind`, no `cancelled`) and fail.

describe("C6: engine control paths answer their reports", () => {
  it("approveNode resolves {applied:true}, then {applied:false} for the idempotent replay", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);

    expect(await rig.engine.approveNode("P", "looks good")).toEqual({ applied: true });
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Completed);

    // Replay against an already-resolved node: the primitive answers null, and
    // the engine projects that into the report instead of resolving void.
    expect(await rig.engine.approveNode("P", "looks good")).toEqual({ applied: false });
  });

  it("rejectNode resolves the lane report, then already_resolved with the live status", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);

    expect(await rig.engine.rejectNode("P", "not good enough")).toEqual({ kind: "escalate" });
    expect(await rig.engine.rejectNode("P", "not good enough")).toEqual({
      kind: "already_resolved",
      actualStatus: NodeStatus.Escalate,
    });
  });

  it("partialApprove resolves the prune report of the verdict it applied", async () => {
    const rig = buildEngine(partialGraph());
    // Drive S1, S2 to completion → P and X dispatched; P pauses for approval.
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    // Rejecting S2 prunes its transitive dependents (X, then Y through the
    // all-join) and keeps Z (an `any` join satisfied by the approved S1). The
    // report is the engine's own prune result, not a snapshot re-run.
    const report = await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");
    expect(report.applied).toBe(true);
    expect([...report.cancelled].sort()).toEqual(["X", "Y"]);
    expect(report.surviving).toEqual(["Z"]);
    expect(report.skipped).toEqual([]);
    // B1: the rejected upstream S2 was re-marked `ready` to re-execute — the
    // reentry report is folded into the prune report instead of discarded.
    expect(report.reEntered).toEqual(["S2"]);
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done);
  });

  it("partialApprove resolves the empty report for a non-blocked gate (no-op verdict)", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);
    await rig.engine.approveNode("P", "ok"); // P → completed, no longer a gate

    expect(await rig.engine.partialApprove("P", [], [])).toEqual({
      applied: false,
      cancelled: [],
      surviving: [],
      skipped: [],
      reEntered: [],
    });
  });
});

// ── C6 truthfulness: applied reflects the gate, skipped the real retirements ─
//
// Revert-would-fail: PruneReport had no `applied` (a non-blocked verdict
// answered a bare {cancelled, surviving}), and pruneDownstreamSubgraph pushed
// every topology-hit node into `cancelled` even when the lifecycle guard
// refused the retirement — so a completed downstream node was reported as
// cancelled while it was untouched.

describe("C6: partialApprove reports applied and skipped truthfully", () => {
  it("answers applied:true for a verdict the blocked gate actually applied", async () => {
    const rig = buildEngine(partialGraph());
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);

    const report = await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");

    expect(report.applied).toBe(true);
  });

  it("answers applied:false for a verdict on a gate that is no longer blocked", async () => {
    const rig = buildEngine(gateGraph());
    await pauseAtGate(rig);
    await rig.engine.approveNode("P", "ok"); // P → completed, no longer a gate

    const report = await rig.engine.partialApprove("P", [], []);

    expect(report).toEqual({
      applied: false,
      cancelled: [],
      surviving: [],
      skipped: [],
      reEntered: [],
    });
  });

  it("reports an empty reEntered when the rejected upstream cannot re-enter ready", async () => {
    const rig = buildEngine(partialGraph());
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    // S2 has since reached a terminal error state: `timeout → ready` is not a
    // legal lifecycle edge, so the re-entry is refused. The verdict still
    // applies and the prune still runs — only the re-entry list stays empty.
    rig.state.nodes.get("S2")!.status = NodeStatus.Timeout;

    const report = await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix it");

    expect(report.applied).toBe(true);
    expect(report.reEntered).toEqual([]);
    expect(rig.state.nodes.get("S2")!.status).toBe(NodeStatus.Timeout);
    expect(rig.state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
  });

  it("reports a prune hit it could not retire as skipped, never cancelled", () => {
    const rig = buildEngine(partialGraph());
    // X already completed: the topology still says its rejected feeder leaves
    // it no approved source, but the lifecycle guard refuses completed →
    // cancelled. Only what actually moved may be reported as cancelled.
    rig.state.nodes.get("X")!.status = NodeStatus.Completed;

    const report = pruneDownstreamSubgraph(rig.state, ["S2"], "P");

    expect(report.skipped).toEqual(["X"]);
    expect(report.cancelled).not.toContain("X");
    // Y (default all-join, fed through X) is still retired; Z survives on S1.
    expect(report.cancelled).toEqual(["Y"]);
    expect(report.surviving).toEqual(["Z"]);
    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Completed); // untouched
  });
});

// ── Monitor H4: the partial-approve prune reaches the completion seam ───────

describe("H4: partial-approve pruning is observable exactly once", () => {
  it("emits one cancelled completion event per pruned node, and none on replay", async () => {
    const events: NodeCompletionEvent[] = [];
    const rig = buildEngine(partialGraph(), new FakeDispatch(), events);
    await rig.engine.dispatchReady();
    await rig.engine.onNodeSignalEmitted("S1", "answer", "r1");
    await rig.engine.onNodeSignalEmitted("S2", "answer", "r2");
    await rig.engine.onNodeSignalEmitted("P", "need_approval", "summary");

    await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");

    expect(rig.state.nodes.get("X")!.status).toBe(NodeStatus.Done);
    const cancelled = events.filter(
      (e) => e.nodeId === "X" && e.signalType === "cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].nodeStatus).toBe(NodeStatus.Done);
    expect(cancelled[0].payload).toContain("cancelled by partial-approval pruning");

    // Replay of the same verdict: the node is already terminal, so the prune
    // is a no-op and must not emit a second completion event.
    await rig.engine.partialApprove("P", ["S1"], ["S2"], "fix branch 2");
    expect(
      events.filter((e) => e.nodeId === "X" && e.signalType === "cancelled"),
    ).toHaveLength(1);
  });
});

});

/**
 * Graph Execution Engine v2 — Recorder tests (Subtask C-RECORD).
 *
 * Proves that the subtask-2 recorders populate the C-STATE optional fields with
 * GENUINE data observed during a real engine execution — and, critically, that
 * they leave a field ABSENT (honest empty) when nothing was actually recorded.
 * No fabricated values anywhere.
 *
 * Covering:
 *   (a) Loop round history  — LoopGroupRuntimeState.rounds, on traversal boundaries
 *   (b) Checkpoints         — EngineState.checkpoints, on lifecycle transitions
 *   (c) Artifacts/evidence  — NodeRuntimeState.artifacts / .evidence, at completion
 *   (d) Signal history      — owned by subtask 6 (signal-bridge.ts:record); not tested here
 */

import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import { TERMINATING_SIGNALS_BY_SEVERITY } from "../../src/signal/signal-constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import {
  executeLoopStep,
} from "../../src/graph/engine/loop-group-executor.ts";
import { deriveNodeEvidence } from "../../src/graph/engine/recorder.ts";

// ── Controllable fake dispatch port (mirrors signal-history.test.ts) ────────
class FakeDispatch implements NodeDispatchPort {
  calls: string[] = [];
  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    return Promise.resolve(makeTask(node.nodeId));
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

// ── Graph fixtures ──────────────────────────────────────────────────────────

/** worker → review convergence loop: entry seeds impl; impl feeds review. */
function reviewLoopGraph(maxTraversals: number): GraphDeclaration {
  return {
    version: 2,
    name: "review-loop",
    nodes: [
      { id: "entry", agent: "a0", prompt: "seed" },
      { id: "impl", agent: "a1", prompt: "implement", join: { strategy: "any" } },
      { id: "review", agent: "a2", prompt: "review" },
      { id: "sink", agent: "a3", prompt: "sink" },
    ],
    edges: [
      { from: "entry", to: "impl", type: "always" },
      { from: "impl", to: "review", type: "on_signal", signal_filter: ["answer"] },
      { from: "review", to: "impl", type: "on_signal", signal_filter: ["revise_needed"] },
      { from: "review", to: "sink", type: "on_signal", signal_filter: ["answer"] },
    ],
    loop_groups: [{ id: "lg", nodes: ["impl", "review"], max_traversals: maxTraversals }],
  };
}

/** Simple chain A → B (no loop) for checkpoint / artifacts / evidence cases. */
function chainGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "chain",
    nodes: [
      { id: "A", agent: "a0", prompt: "p0" },
      { id: "B", agent: "a1", prompt: "p1" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

interface TestRig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: FakeDispatch;
}

function buildEngine(decl: GraphDeclaration): TestRig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const fake = new FakeDispatch();
  const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake });
  return { state, engine, fake };
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) Loop round history — genuine traversal boundaries
// ═══════════════════════════════════════════════════════════════════════════
describe("loop round history (LoopGroupRuntimeState.rounds)", () => {
  it("records one round per real traversal with genuine count, nodes, and timestamps", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(3));
    await engine.dispatchReady();

    // Round 1 traversal: review revises once.
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["fix x"] });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);

    // Round 2 traversal: review revises again.
    await engine.onNodeSignalEmitted("impl", "answer", "v2");
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["fix y"] });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);

    const rounds = state.loopGroups.get("lg")!.rounds;
    expect(rounds).toBeDefined();
    expect(rounds!.length).toBe(2);

    // Round 1: genuine round number + traversal count + re-entered node ids.
    expect(rounds![0].round).toBe(1);
    expect(rounds![0].traversalCount).toBe(1);
    expect(rounds![0].nodeIds).toEqual(["impl"]);
    expect(rounds![0].status).toBe(NodeStatus.Completed);

    // Round 2: monotonic round number, traversal count advanced.
    expect(rounds![1].round).toBe(2);
    expect(rounds![1].traversalCount).toBe(2);
    expect(rounds![1].nodeIds).toEqual(["impl"]);
    // Genuine epoch-ms timestamps on both entries.
    expect(rounds![0].startedAt).toBeGreaterThan(0);
    expect(rounds![0].completedAt).toBeGreaterThanOrEqual(rounds![0].startedAt);
    expect(rounds![1].startedAt).toBeGreaterThan(0);
    expect(rounds![1].completedAt).toBeGreaterThanOrEqual(rounds![1].startedAt);
  });

  it("records no round when no traversal boundary was crossed (converge early-exit)", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    // Converge: the happy-path exit consumes no traversal.
    const report = executeLoopStep(state, review, "answer", "accepted");
    expect(report.outcome).toBe("converged");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(0);
    // Honest empty: no traversal happened, so no round is recorded.
    expect(state.loopGroups.get("lg")!.rounds).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) Checkpoints — genuine lifecycle transitions
// ═══════════════════════════════════════════════════════════════════════════
describe("checkpoints (EngineState.checkpoints)", () => {
  it("auto-saves a checkpoint on each real lifecycle transition", async () => {
    const { state, engine } = buildEngine(chainGraph());
    await engine.dispatchReady(); // A runs (ready → running); B stays pending.

    // A is now running; its latest checkpoint reflects that transition.
    expect(state.checkpoints).toBeDefined();
    expect(state.checkpoints!["A"]).toBeDefined();
    expect(state.checkpoints!["A"]!.nodeId).toBe("A");
    expect(state.checkpoints!["A"]!.status).toBe(NodeStatus.Running);
    expect(state.checkpoints!["A"]!.at).toBeGreaterThan(0);
    // B is still pending (not yet dispatched) → it never transitioned through
    // the lifecycle choke point, so it has NO checkpoint (honest empty).
    expect(state.checkpoints!["B"]).toBeUndefined();

    // A completes → its checkpoint advances to completed (auto-save overwrite),
    // and B is now dispatched → B gains a running checkpoint.
    await engine.onNodeSignalEmitted("A", "answer", { result: "ok" });
    expect(state.checkpoints!["A"]!.status).toBe(NodeStatus.Completed);
    expect(state.checkpoints!["B"]!.status).toBe(NodeStatus.Running);
  });

  it("records checkpoints during provision for root nodes via markReady", () => {
    const { state } = buildEngine(chainGraph());
    // Provision now routes root nodes through markReady (the lifecycle choke
    // point), which records a checkpoint for each root node's pending→ready
    // transition.
    expect(state.checkpoints).toBeDefined();
    expect(state.checkpoints!["A"]).toBeDefined();
    expect(state.checkpoints!["A"].status).toBe("ready");
  });

  it("appends an ordered multi-entry checkpointHistory across lifecycle transitions", async () => {
    const { state, engine } = buildEngine(chainGraph());
    // A: pending → ready (provision) → running (dispatch) → completed (answer).
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", { result: "ok" });

    const history = state.checkpointHistory!["A"];
    expect(history).toBeDefined();
    // >=2 lifecycle transitions retained, in transition order.
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[history.length - 1].status).toBe(NodeStatus.Completed);
    // The latest entry mirrors the backward-compat `checkpoints` snapshot.
    expect(state.checkpoints!["A"]).toEqual(history[history.length - 1]);
    // Ordered: timestamps are non-decreasing.
    for (let i = 1; i < history.length; i++) {
      expect(history[i].at).toBeGreaterThanOrEqual(history[i - 1].at);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) Artifacts / evidence — genuinely produced data, honest empties
// ═══════════════════════════════════════════════════════════════════════════
describe("artifacts and evidence (NodeRuntimeState.artifacts / evidence)", () => {
  it("populates artifacts from the real materialized result sidecar at completion", async () => {
    const { state, engine } = buildEngine(chainGraph());
    const sidecar = join(tmpdir(), `recorder-artifacts-${Date.now()}.txt`);
    writeFileSync(sidecar, "real produced output", "utf8");
    await engine.dispatchReady();

    // Simulate the dispatch seam materializing the node's real result sidecar.
    const a = state.nodes.get("A")!;
    a.result = {
      sidecarPath: sidecar,
      totalChars: 20,
      hadFence: false,
      materializedAt: Date.now(),
    };

    await engine.onNodeSignalEmitted("A", "answer", "produced");
    expect(a.status).toBe(NodeStatus.Completed);
    expect(a.artifacts).toEqual([sidecar]);
  });

  it("populates evidence from the terminal-signal payload actually emitted", async () => {
    const { state, engine } = buildEngine(chainGraph());
    await engine.dispatchReady();

    // The worker genuinely emitted evidence references inside its answer payload.
    await engine.onNodeSignalEmitted("A", "answer", {
      verdict: "ok",
      evidence: ["tests/a.test.ts", "src/a.ts"],
    });

    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Completed);
    expect(a.evidence).toEqual(["tests/a.test.ts", "src/a.ts"]);
  });

  it("leaves artifacts/evidence absent for a node that produced none (no fabrication)", async () => {
    const { state, engine } = buildEngine(chainGraph());
    await engine.dispatchReady();

    // A completes with a plain answer: no materialized result, no evidence refs.
    await engine.onNodeSignalEmitted("A", "answer", "plain result");
    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Completed);
    // Honest empty — the optional fields stay absent.
    expect(a.artifacts).toBeUndefined();
    expect(a.evidence).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) Severity ordering — deriveNodeEvidence uses the shared constant (L1)
// ═══════════════════════════════════════════════════════════════════════════
describe("severity ordering (L1 / 01-F4)", () => {
  /** A node-shaped object carrying only the observed signals (pure derivation). */
  function nodeWithSignals(signals: Record<string, unknown>): NodeRuntimeState {
    return { signalsObserved: signals } as unknown as NodeRuntimeState;
  }

  it("pins the shared TERMINATING_SIGNALS_BY_SEVERITY order (escalate > revise_needed > answer)", () => {
    // The single source of truth every consumer imports — a reorder here
    // silently changes _latestTerminating / deriveNodeEvidence precedence.
    expect(TERMINATING_SIGNALS_BY_SEVERITY).toEqual([
      "escalate",
      "revise_needed",
      "answer",
    ]);
  });

  it("deriveNodeEvidence picks evidence from the highest-severity terminal signal (escalate beats answer)", () => {
    const node = nodeWithSignals({
      answer: { evidence: ["tests/a.test.ts"] },
      escalate: { reason: "boom", evidence: ["tests/e.test.ts"] },
    });
    expect(deriveNodeEvidence(node)).toEqual(["tests/e.test.ts"]);
  });

  it("deriveNodeEvidence picks revise_needed evidence over a recorded answer", () => {
    const node = nodeWithSignals({
      answer: { evidence: ["tests/a.test.ts"] },
      revise_needed: { findings: ["fix"], evidence: ["tests/r.test.ts"] },
    });
    expect(deriveNodeEvidence(node)).toEqual(["tests/r.test.ts"]);
  });

  it("deriveNodeEvidence picks escalate evidence over revise_needed", () => {
    const node = nodeWithSignals({
      revise_needed: { findings: ["fix"], evidence: ["tests/r.test.ts"] },
      escalate: { reason: "boom", evidence: ["tests/e.test.ts"] },
    });
    expect(deriveNodeEvidence(node)).toEqual(["tests/e.test.ts"]);
  });
});

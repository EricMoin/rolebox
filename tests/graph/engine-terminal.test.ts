/**
 * Graph Execution Engine v2 — Graph-Terminal Notification Seam
 *
 * Verifies the optional `onGraphTerminal` DI callback:
 * - fires EXACTLY ONCE per terminal transition (GRAPH COMPLETE / GRAPH
 *   BLOCKED);
 * - carries the correct `{ graphId, phase, nodeStatusSummaries, isBlocked }`;
 * - GRAPH COMPLETE fires after phase transitions to `complete` with all nodes
 *   in terminal states;
 * - GRAPH BLOCKED fires when no scheduler-active (running/ready/pending) nodes
 *   remain but ≥1 blocked `needs_approval` node exists — WITHOUT a phase
 *   transition;
 * - dedupe: blocked and complete use separate guards — a blocked fire followed
 *   later by approval-resume and eventual completion MAY fire complete;
 * - is a strict no-op when not supplied (engine behavior unchanged);
 * - a throwing consumer must not corrupt the advancing critical section
 *   (mirrors `_notifyCompletion` conventions).
 *
 * The engine stays role-agnostic: it only packages the immutable facts.
 */

import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type GraphTerminalEvent,
} from "../../src/graph/engine/engine-advance.ts";

// ── Fake dispatch seam (injectable into AdvanceEngine) ─────────────────────

class FakeDispatch implements NodeDispatchPort {
  executeNode(
    _node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve(makeTask());
  }
}

let taskSeq = 0;
function makeTask(): DispatchTask {
  taskSeq += 1;
  return {
    id: `task-${taskSeq}`,
    sessionId: `sess-${taskSeq}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: "a",
    prompt: "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Single-node graph (root, no downstream). */
function singleNode(
  id = "A",
  agent = "a1",
  extra: Partial<GraphDeclaration["nodes"][number]> = {},
): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: "p1", ...extra }],
    edges: [],
  };
}

/** Two-node linear graph: A → B. */
function linearGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

/**
 * Unrooted always-cycle: a ⇄ b with NO loop group. Every node has in-degree
 * ≥1 and there is no `always`-edge exclusion (no loop group), so provision
 * leaves both nodes pending and the frontier empty — a runtime deadlock.
 */
function unrootedCycleGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "unrooted-cycle",
    nodes: [
      { id: "a", agent: "a1", prompt: "p1" },
      { id: "b", agent: "a2", prompt: "p2" },
    ],
    edges: [
      { from: "a", to: "b", type: "always" },
      { from: "b", to: "a", type: "always" },
    ],
  };
}

/**
 * Unprotected always-cycle reachable from a root: root → A, A ⇄ B, NO loop
 * group. `root` is the sole graph root; A's join needs both `root` and `B`,
 * and B is only fed by A — an unsatisfiable cycle once root completes.
 */
function rootCycleGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "root-cycle",
    nodes: [
      { id: "root", agent: "r", prompt: "pr" },
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [
      { from: "root", to: "A", type: "always" },
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "A", type: "always" },
    ],
  };
}

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  events: GraphTerminalEvent[];
}

/**
 * Build an advance engine over a graph with a recording `onGraphTerminal`
 * seam. `events` is the shared recorder the assertions read.
 */
function buildEngine(
  decl: GraphDeclaration,
  events: GraphTerminalEvent[],
  opts: { noSeam?: boolean } = {},
): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: new FakeDispatch(),
    ...(opts.noSeam ? {} : { onGraphTerminal: (e) => events.push(e) }),
  });
  return { state, engine, events };
}

// ── GRAPH COMPLETE ──────────────────────────────────────────────────────────

describe("onGraphTerminal COMPLETE", () => {
  it("fires once when all nodes complete — isBlocked=false", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "done");

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.graphId).toBe("g-1");
    expect(e.phase).toBe(EnginePhase.Complete);
    expect(e.nodeStatusSummaries.completed).toBe(1);
    expect(e.nodeStatusSummaries.escalate).toBe(0);
    expect(e.nodeStatusSummaries.timeout).toBe(0);
    expect(e.nodeStatusSummaries.blocked).toBe(0);
    expect(e.nodeStatusSummaries.running).toBe(0);
    expect(e.isBlocked).toBe(false);
  });

  it("fires once for a linear chain that finishes", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine } = buildEngine(linearGraph(), events);

    await engine.dispatchReady(); // dispatches A (root), B is pending
    // Complete A → B becomes ready + dispatched → complete B
    await engine.onNodeSignalEmitted("A", "answer", "A-result");
    await engine.onNodeSignalEmitted("B", "answer", "B-result");

    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(events[0].nodeStatusSummaries.completed).toBe(2);
    expect(events[0].phase).toBe(EnginePhase.Complete);
  });

  it("captures escalate and timeout counts in summary", async () => {
    const events: GraphTerminalEvent[] = [];
    const decl: GraphDeclaration = {
      version: 2,
      name: "mixed",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
      ],
      edges: [],
    };
    const { engine, state } = buildEngine(decl, events);

    // Dispatch both roots.
    await engine.dispatchReady();
    // A completes normally, B escalates.
    await engine.onNodeSignalEmitted("A", "answer", "ok");
    await engine.onNodeSignalEmitted("B", "escalate", { reason: "boom" });

    expect(events).toHaveLength(1);
    expect(events[0].nodeStatusSummaries.completed).toBe(1);
    expect(events[0].nodeStatusSummaries.escalate).toBe(1);
  });

  it("does NOT fire when graph has scheduler-active nodes", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine } = buildEngine(linearGraph(), events);

    await engine.dispatchReady();
    // Only A completes — B is still running/ready → not terminal.
    await engine.onNodeSignalEmitted("A", "answer", "A-result");

    expect(events).toHaveLength(0); // B is still active
  });

  it("does NOT double-fire across multiple _checkTermination calls", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "done");
    expect(events).toHaveLength(1);

    // Re-emit the same signal (deferred-completion replay) — no second terminal event.
    await engine.onNodeSignalEmitted("A", "answer", "done");
    expect(events).toHaveLength(1);
  });
});

// ── GRAPH BLOCKED ───────────────────────────────────────────────────────────

describe("onGraphTerminal BLOCKED", () => {
  it("fires when only blocked nodes remain — isBlocked=true, no phase transition", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine, state } = buildEngine(
      singleNode("G", "g1", { needs_approval: true }),
      events,
    );

    await engine.dispatchReady();
    // Worker emits need_approval → node transitions running → blocked.
    await engine.onNodeSignalEmitted("G", "need_approval", "please review");

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.isBlocked).toBe(true);
    expect(e.phase).toBe(EnginePhase.Executing); // no phase transition!
    expect(e.nodeStatusSummaries.blocked).toBe(1);
    expect(e.nodeStatusSummaries.completed).toBe(0);
    expect(e.nodeStatusSummaries.running).toBe(0);
    expect(e.graphId).toBe("g-1");
  });

  it("fires BLOCKED for mixed terminal + blocked scenario", async () => {
    const events: GraphTerminalEvent[] = [];
    const decl: GraphDeclaration = {
      version: 2,
      name: "mixed",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "G", agent: "g1", prompt: "p2", needs_approval: true },
      ],
      edges: [],
    };
    const { engine } = buildEngine(decl, events);

    await engine.dispatchReady();
    // A completes, G becomes blocked.
    await engine.onNodeSignalEmitted("A", "answer", "ok");
    await engine.onNodeSignalEmitted("G", "need_approval", "review");

    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(true);
    expect(events[0].nodeStatusSummaries.completed).toBe(1);
    expect(events[0].nodeStatusSummaries.blocked).toBe(1);
    expect(events[0].phase).toBe(EnginePhase.Executing);
  });

  it("does NOT fire BLOCKED when scheduler-active nodes remain", async () => {
    const events: GraphTerminalEvent[] = [];
    const decl: GraphDeclaration = {
      version: 2,
      name: "dual",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "G", agent: "g1", prompt: "p2", needs_approval: true },
      ],
      edges: [],
    };
    const { engine } = buildEngine(decl, events);

    await engine.dispatchReady(); // both A and G dispatched
    // G becomes blocked — but A is still running.
    await engine.onNodeSignalEmitted("G", "need_approval", "review");

    // A is still scheduler-active → no terminal event yet.
    expect(events).toHaveLength(0);
  });

  it("blocked → approve → complete fires BOTH blocked and complete events", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine } = buildEngine(
      singleNode("G", "g1", { needs_approval: true }),
      events,
    );

    await engine.dispatchReady();
    // Blocked event fires.
    await engine.onNodeSignalEmitted("G", "need_approval", "please review");
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(true);

    // Human approves → node completes → complete event fires.
    await engine.approveNode("G", "accepted");
    expect(events).toHaveLength(2);
    expect(events[1].isBlocked).toBe(false);
    expect(events[1].phase).toBe(EnginePhase.Complete);
    expect(events[1].nodeStatusSummaries.completed).toBe(1);
    expect(events[1].nodeStatusSummaries.blocked).toBe(0);
  });

  it("does NOT double-fire the blocked event", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine } = buildEngine(
      singleNode("G", "g1", { needs_approval: true }),
      events,
    );

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("G", "need_approval", "please review");
    expect(events).toHaveLength(1);

    // Re-emit the same signal — dedupe gate blocks second fire.
    await engine.onNodeSignalEmitted("G", "need_approval", "please review");
    expect(events).toHaveLength(1);
  });
});

// ── Runtime deadlock termination ────────────────────────────────────────────
//
// An unsatisfiable graph — one whose pending node(s) can never be satisfied by
// a running/ready upstream, a blocked gate, or a deferred completion — would
// otherwise leave the engine stuck in `executing` forever ([GRAPH COMPLETE]
// never fires). The deadlock guard escalates every pending node and terminates
// the graph as `complete`.

describe("runtime deadlock termination", () => {
  it("deadlock-terminates an unrooted always-cycle after dispatchReady", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine, state } = buildEngine(unrootedCycleGraph(), events);

    // No roots → frontier empty, all nodes pending → no dispatch possible.
    await engine.dispatchReady();

    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Escalate);
    // Deadlock termination is a completion, not a block.
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(events[0].nodeStatusSummaries.escalate).toBe(2);
    expect(events[0].nodeStatusSummaries.completed).toBe(0);
  });

  it("deadlock-terminates an unprotected cycle reachable from a root after root answer", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine, state } = buildEngine(rootCycleGraph(), events);

    await engine.dispatchReady(); // dispatch the sole root
    expect(state.nodes.get("root")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Pending);

    // root answers → A's join (root + B) is unsatisfiable (B is only fed by A)
    // → after root completes there is no active upstream → deadlock detected.
    await engine.onNodeSignalEmitted("root", "answer", "seed");

    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(events[0].nodeStatusSummaries.escalate).toBe(2);
    expect(events[0].nodeStatusSummaries.completed).toBe(1); // root completed
  });

  it("does NOT deadlock-terminate a graph with an escalated node and a pending downstream", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine, state } = buildEngine(linearGraph(), events);

    await engine.dispatchReady();
    // A escalates; B is a single-input downstream that stays pending. The
    // graph is in an ERROR state (an escalate is present) — the deadlock guard
    // must NOT force-complete it. Phase stays executing.
    await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom" });

    expect(state.phase).toBe(EnginePhase.Executing);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Pending);
    expect(events).toHaveLength(0);
  });

  it("does NOT deadlock-terminate a graph that still has a running node", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine, state } = buildEngine(linearGraph(), events);

    await engine.dispatchReady(); // A running, B pending
    // A answers → B becomes ready + running → a scheduler-active node remains.
    await engine.onNodeSignalEmitted("A", "answer", "A-result");

    expect(state.phase).toBe(EnginePhase.Executing);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    expect(events).toHaveLength(0);
  });
});

// ── No-op and safety ────────────────────────────────────────────────────────

describe("onGraphTerminal safety", () => {
  it("is a strict no-op when the callback is not supplied", async () => {
    const events: GraphTerminalEvent[] = [];
    const { engine, state } = buildEngine(singleNode("A", "a1"), events, {
      noSeam: true,
    });

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "done");

    // Engine still advanced the graph to complete.
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(events).toHaveLength(0); // no callback registered → nothing recorded
  });

  it("a throwing consumer does not corrupt the advancing critical section", async () => {
    const state = createEngineState(singleNode("A", "a1"), "g-1");
    provision(state);
    const bridge = new SignalBridge();
    const engine = new AdvanceEngine({
      state,
      signalBridge: bridge,
      dispatch: new FakeDispatch(),
      onGraphTerminal: () => {
        throw new Error("notifier exploded");
      },
    });

    await engine.dispatchReady();
    // The throwing notifier must not prevent the node transition / phase
    // transition / lock release.
    await engine.onNodeSignalEmitted("A", "answer", "x");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.advancingLock).toBe(false);
  });

  it("a throwing consumer on blocked path does not corrupt advancement", async () => {
    const state = createEngineState(
      singleNode("G", "g1", { needs_approval: true }),
      "g-1",
    );
    provision(state);
    const bridge = new SignalBridge();
    const engine = new AdvanceEngine({
      state,
      signalBridge: bridge,
      dispatch: new FakeDispatch(),
      onGraphTerminal: () => {
        throw new Error("blocked notifier exploded");
      },
    });

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("G", "need_approval", "please review");
    expect(state.nodes.get("G")!.status).toBe(NodeStatus.Blocked);
    expect(state.phase).toBe(EnginePhase.Executing); // blocked — no phase transition
    expect(state.advancingLock).toBe(false);
  });
});

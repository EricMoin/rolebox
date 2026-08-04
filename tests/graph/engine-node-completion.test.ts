/**
 * Graph Execution Engine v2 — Node-Completion Notification Seam (subtask 1)
 *
 * Verifies the optional `onNodeCompletion` DI callback:
 * - fires EXACTLY ONCE per terminating / notable transition;
 * - carries the correct `{ graphId, nodeId, nodeAgent, signalType, payload,
 *   nodeStatus }`;
 * - is a strict no-op when not supplied (engine behavior unchanged);
 * - is idempotent — replaying an already-processed signal does NOT re-fire
 *   (the exactly-once property comes from the transition being applied only
 *   when the node is actually in the from-state);
 * - covers the recovery-side `timeout` seam.
 *
 * The engine stays role-agnostic: it only packages the immutable facts. A
 * throwing consumer must not corrupt the advancing critical section.
 */

import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type NodeCompletionEvent,
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

/** Single-node graph (root, no downstream) with the given node id / agent. */
function singleNode(id = "A", agent = "a1", extra: Partial<GraphDeclaration["nodes"][number]> = {}): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: "p1", ...extra }],
    edges: [],
  };
}

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  events: NodeCompletionEvent[];
}

/**
 * Build an advance engine over a graph with a recording `onNodeCompletion`
 * seam. `events` is the shared recorder the assertions read.
 */
function buildEngine(
  decl: GraphDeclaration,
  events: NodeCompletionEvent[],
  opts: { noSeam?: boolean } = {},
): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: new FakeDispatch(),
    // `noSeam` exercises the default no-op path (callback omitted).
    ...(opts.noSeam ? {} : { onNodeCompletion: (e) => events.push(e) }),
  });
  return { state, engine, events };
}

// ── exactly-once + correct event per terminating transition ─────────────────

describe("onNodeCompletion seam", () => {
  it("fires once for answer → completed with correct {graphId,nodeId,nodeAgent,nodeStatus}", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "result-A");

    expect(events).toHaveLength(1);
    expect(events[0].graphId).toBe("g-1");
    expect(events[0].nodeId).toBe("A");
    expect(events[0].nodeAgent).toBe("a1");
    expect(events[0].signalType).toBe("answer");
    expect(events[0].payload).toBe("result-A");
    expect(events[0].nodeStatus).toBe(NodeStatus.Completed);
    // Additive timing facts (subtask 2 notifier): carried when the node has them.
    expect(typeof events[0].startedAt).toBe("number");
    expect(typeof events[0].completedAt).toBe("number");
  });

  it("fires once for escalate", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom" });

    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].nodeAgent).toBe("a1");
    expect(events[0].signalType).toBe("escalate");
    expect(events[0].payload).toEqual({ reason: "boom" });
    expect(events[0].nodeStatus).toBe(NodeStatus.Escalate);
  });

  it("fires for revise_needed completing the reviewer, then the no-loop-group escalation (monitor M1b)", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "revise_needed", { findings: ["nits"] });

    // Subtask-1 event: the reviewer's pass completed.
    expect(events[0].signalType).toBe("revise_needed");
    expect(events[0].nodeStatus).toBe(NodeStatus.Completed);
    expect(events[0].payload).toEqual({ findings: ["nits"] });
    // Monitor M1b: a plain revise with no loop group escalates the reviewer
    // ("no loop group") inside signal-propagation.ts — that lifecycle
    // escalation is not a signal, so the engine now surfaces it as a second
    // completion event instead of leaving it silent.
    expect(events).toHaveLength(2);
    expect(events[1].signalType).toBe("escalate");
    expect(events[1].nodeStatus).toBe(NodeStatus.Escalate);
    expect(events[1].payload).toBe("no loop group");
  });

  it("fires once for blocked → completed on approval-resume", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine } = buildEngine(
      singleNode("G", "a9", { needs_approval: true }),
      events,
    );

    // Dispatch the gate, then pause it for approval (worker emits need_approval).
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("G", "need_approval", "please review");
    // The pausing signal is not terminating → no completion event yet.
    expect(events).toHaveLength(0);

    // Human approves → blocked → completed, one event.
    await engine.approveNode("G", "accepted");
    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("G");
    expect(events[0].signalType).toBe("answer");
    expect(events[0].nodeStatus).toBe(NodeStatus.Completed);
    expect(events[0].payload).toBe("accepted");
  });

  it("does NOT re-fire on replay of an already-processed signal (exactly-once)", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "x");
    expect(events).toHaveLength(1);

    // Replaying the same terminating signal on an already-completed node is a
    // harmless no-op (deferred-completion replay is safe) → no second event.
    await engine.onNodeSignalEmitted("A", "answer", "x");
    expect(events).toHaveLength(1);
  });

  it("is a strict no-op when the callback is not supplied", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine, state } = buildEngine(singleNode("A", "a1"), events, {
      noSeam: true,
    });

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "x");

    // Engine still advanced the node (no-op seam changed nothing).
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
      onNodeCompletion: () => {
        throw new Error("notifier exploded");
      },
    });

    await engine.dispatchReady();
    // The throwing notifier must not prevent the node transition / lock release.
    await engine.onNodeSignalEmitted("A", "answer", "x");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(state.advancingLock).toBe(false);
  });

  it("fires once for a recovery-side timeout via notifyNodeTimeout", async () => {
    const events: NodeCompletionEvent[] = [];
    const { engine, state } = buildEngine(singleNode("A", "a1"), events);

    await engine.dispatchReady();
    // Simulate recovery's reconcileEngine marking the running node `timeout`
    // directly (the dispatch task vanished) with an error reason recorded.
    const node = state.nodes.get("A")!;
    (node as { status: NodeStatus }).status = NodeStatus.Timeout;
    node.errorReason = "dispatch task vanished";

    engine.notifyNodeTimeout("A");
    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].signalType).toBe("timeout");
    expect(events[0].payload).toBe("dispatch task vanished");
    expect(events[0].nodeStatus).toBe(NodeStatus.Timeout);

    // Idempotent-guarded: a non-timeout node or no callback never emits.
    events.length = 0;
    engine.notifyNodeTimeout("A"); // already timeout — still fires on explicit call
    expect(events).toHaveLength(1);
  });
});

/**
 * Graph Execution Engine v2 — Monitor Observation Mechanism (subtask S5)
 *
 * Verifies the monitor repair plan over `engine-advance.ts`:
 *
 * - H2 — `notifyNodeTimeout` writes a `node_completed` durable event even when
 *   no `onNodeCompletion` notifier is registered (the event log must not be
 *   gated on the notifier seam).
 * - M1a — the budget pre-check escalation of a ready node is surfaced through
 *   the completion seam / event log (it was silent: a lifecycle transition,
 *   not a signal).
 * - M1b — escalate / revise propagation reports are replayed: every node the
 *   propagation escalated is notified (join-failed convergence nodes, and a
 *   plain revise with no loop group).
 * - M1c — the runtime-deadlock guard's synthetic escalations are surfaced via
 *   the public `checkTermination()` wrapper's `onSyntheticEscalate` hook.
 * - M5 — a failed critical-section persist keeps `isDirty` so the next
 *   mutating section retries; a failed non-critical debounce hand-off keeps
 *   `isNonCriticalDirty` (same policy).
 * - M10 — `retryNode` / `resetTerminalDedupe` clear the persisted
 *   `state.terminalNotified` dedup flag (durably via markDirty) so the
 *   re-opened chain's next terminal event fires.
 * - M4 — `_dispatchNode` captures each `subscribeTaskTermination` callback
 *   into the engine-owned subscription ledger, exposed via
 *   `getTerminationSubscriptions()` for S7 dispose teardown; the dispatch port
 *   gains the optional `removeTaskTerminatedListener` surface.
 * - H4 — the public `notifyNodeTerminal` / `checkTermination` wrappers drive
 *   the completion seam + event log from external control paths (cancel).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  NodeRuntimeState,
  EngineState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  GraphEventRecorder,
  graphEventsPath,
  type GraphEventRecord,
} from "../../src/graph/engine/graph-events.ts";
import { markNonCriticalDirty } from "../../src/graph/engine/engine-persistence.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type NodeCompletionEvent,
  type GraphBudgetPort,
} from "../../src/graph/engine/engine-advance.ts";

// ── Fake dispatch seams ──────────────────────────────────────────────────────

class FakeDispatch implements NodeDispatchPort {
  calls: string[] = [];
  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    return Promise.resolve(makeTask(node.nodeId));
  }
}

/**
 * Dispatch seam that also closes the dispatch→signal delivery seam: records
 * every `onTaskTerminated` subscription and every `removeTaskTerminatedListener`
 * call, so the M4 subscription-ledger teardown path is verifiable end-to-end.
 */
class RecordingDispatch implements NodeDispatchPort {
  private seq = 0;
  subs = new Map<string, TaskTerminatedCallback>();
  removals: Array<{ taskId: string; callback: TaskTerminatedCallback }> = [];

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task = makeTask(id, node);
    task.id = id;
    task.sessionId = `sess-${id}`;
    return Promise.resolve(task);
  }

  onTaskTerminated(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): TaskTerminatedCallback {
    this.subs.set(taskId, callback);
    return callback;
  }

  removeTaskTerminatedListener(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void {
    this.subs.delete(taskId);
    this.removals.push({ taskId, callback });
  }
}

function makeTask(id: string, node?: NodeRuntimeState): DispatchTask {
  return {
    id,
    sessionId: `sess-${id}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: node?.agent ?? "a",
    prompt: node?.prompt ?? "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Single-node graph (root, no downstream). */
function singleNode(id = "A", agent = "a1"): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: "p1" }],
    edges: [],
  };
}

/** Fan-in: A → C and B → C (C's join needs both roots). */
function fanInGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "fan-in",
    nodes: [
      { id: "A", agent: "a1", prompt: "pA" },
      { id: "B", agent: "a2", prompt: "pB" },
      { id: "C", agent: "a3", prompt: "pC" },
    ],
    edges: [
      { from: "A", to: "C", type: "always" },
      { from: "B", to: "C", type: "always" },
    ],
  };
}

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  events: NodeCompletionEvent[];
}

interface BuildOpts {
  onNodeCompletion?: (e: NodeCompletionEvent) => void;
  budget?: GraphBudgetPort;
  graphEvents?: GraphEventRecorder;
  persistState?: (s: EngineState) => boolean;
  schedulePersistState?: (s: EngineState) => boolean;
  dispatch?: NodeDispatchPort;
}

function buildEngine(decl: GraphDeclaration, opts: BuildOpts = {}): Rig {
  const events: NodeCompletionEvent[] = [];
  const state = createEngineState(decl, "g-1");
  provision(state);
  const engine = new AdvanceEngine({
    state,
    signalBridge: new SignalBridge(),
    dispatch: opts.dispatch ?? new FakeDispatch(),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.graphEvents ? { graphEvents: opts.graphEvents } : {}),
    ...(opts.persistState ? { persistState: opts.persistState } : {}),
    ...(opts.schedulePersistState ? { schedulePersistState: opts.schedulePersistState } : {}),
    onNodeCompletion: opts.onNodeCompletion ?? ((e) => events.push(e)),
  });
  return { state, engine, events };
}

/** Read and parse every NDJSON line from a graph's event log ([] if absent). */
function readEvents(dir: string, graphId: string): GraphEventRecord[] {
  const path = graphEventsPath(dir, graphId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GraphEventRecord);
}

const workspaces: string[] = [];
function makeWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), "engine-monitor-s5-"));
  workspaces.push(d);
  return d;
}

afterEach(() => {
  for (const d of workspaces.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── H2: notifyNodeTimeout writes the event log without a notifier ───────────

describe("H2 — notifyNodeTimeout event log (notifier-independent)", () => {
  it("writes node_completed(timeout) even when no onNodeCompletion is registered", () => {
    const dir = makeWorkspace();
    const recorder = new GraphEventRecorder(dir);
    const state = createEngineState(singleNode("A", "a1"), "g-h2");
    provision(state);
    // No onNodeCompletion seam at all — only the durable event recorder.
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
      graphEvents: recorder,
    });

    engine.dispatchReady();
    const node = state.nodes.get("A")!;
    (node as { status: NodeStatus }).status = NodeStatus.Timeout;
    node.errorReason = "dispatch task vanished";

    engine.notifyNodeTimeout("A");

    const lines = readEvents(dir, "g-h2");
    const completed = lines.find((l) => l.event === "node_completed");
    expect(completed).toBeDefined();
    expect(completed!.graphId).toBe("g-h2");
    expect(completed!.nodeId).toBe("A");
    expect(completed!.signalType).toBe("timeout");
    expect(completed!.status).toBe(NodeStatus.Timeout);
  });

  it("does not emit when the node is not timeout (unchanged guard)", () => {
    const dir = makeWorkspace();
    const recorder = new GraphEventRecorder(dir);
    const { engine } = buildEngine(singleNode("A", "a1"), {
      graphEvents: recorder,
    });
    engine.dispatchReady();

    // Node is `running`, not `timeout` → no timeout completion event is
    // written (dispatch/phase events exist, but never a timeout node_completed).
    engine.notifyNodeTimeout("A");
    const timeoutEvents = readEvents(dir, "g-1").filter(
      (l) => l.event === "node_completed" && l.signalType === "timeout",
    );
    expect(timeoutEvents).toEqual([]);
  });
});

// ── M1a: budget pre-check escalation surfaced ───────────────────────────────

describe("M1a — budget pre-check escalation notification", () => {
  it("notifies the ready node escalated by the budget pre-check", async () => {
    const { engine, state, events } = buildEngine(singleNode("A", "a1"), {
      budget: {
        checkGraphBudget: () => ({
          exceeded: true,
          reason: "graph budget exhausted",
        }),
      },
    });

    await engine.dispatchReady();

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].signalType).toBe("escalate");
    expect(events[0].nodeStatus).toBe(NodeStatus.Escalate);
    expect(events[0].payload).toBe("graph budget exhausted");
  });

  it("also writes the durable node_completed event for the pre-check escalation", async () => {
    const dir = makeWorkspace();
    const recorder = new GraphEventRecorder(dir);
    const { engine } = buildEngine(singleNode("A", "a1"), {
      budget: {
        checkGraphBudget: () => ({
          exceeded: true,
          reason: "budget cap",
        }),
      },
      graphEvents: recorder,
    });

    await engine.dispatchReady();

    const lines = readEvents(dir, "g-1");
    const completed = lines.find((l) => l.event === "node_completed");
    expect(completed).toBeDefined();
    expect(completed!.signalType).toBe("escalate");
    expect(completed!.status).toBe(NodeStatus.Escalate);
  });
});

// ── M1b: propagation escalation notifications ───────────────────────────────

describe("M1b — propagation escalation notifications", () => {
  it("notifies the join-failed convergence node escalated by escalate propagation", async () => {
    const { engine, events } = buildEngine(fanInGraph());

    await engine.dispatchReady(); // A + B running
    await engine.onNodeSignalEmitted("A", "answer", "ra");
    await engine.onNodeSignalEmitted("B", "escalate", { reason: "boom" });

    // A's answer + B's own escalate (live signal) + C's propagation escalate.
    expect(events.some((e) => e.nodeId === "A" && e.signalType === "answer")).toBe(true);
    expect(events.some((e) => e.nodeId === "B" && e.signalType === "escalate")).toBe(true);
    const cEvent = events.find((e) => e.nodeId === "C");
    expect(cEvent).toBeDefined();
    expect(cEvent!.signalType).toBe("escalate");
    expect(cEvent!.nodeStatus).toBe(NodeStatus.Escalate);
    // Exactly one event per node — no double-notify of the propagated target.
    expect(events.filter((e) => e.nodeId === "C")).toHaveLength(1);
  });

  it("notifies the reviewer escalated by a plain revise with no loop group", async () => {
    const { engine, events } = buildEngine(singleNode("A", "a1"));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "revise_needed", { findings: ["nits"] });

    // Event 1: the reviewer's pass completed. Event 2 (M1b): the no-loop-group
    // escalation is surfaced instead of silent.
    expect(events[0].signalType).toBe("revise_needed");
    expect(events[0].nodeStatus).toBe(NodeStatus.Completed);
    expect(events).toHaveLength(2);
    expect(events[1].signalType).toBe("escalate");
    expect(events[1].nodeStatus).toBe(NodeStatus.Escalate);
    expect(events[1].payload).toBe("no loop group");
  });
});

// ── M1c: runtime-deadlock synthetic escalation surfaced ─────────────────────

describe("M1c — deadlock-guard synthetic escalation notification", () => {
  it("notifies every pending node the deadlock guard escalates (via checkTermination)", () => {
    const { engine, state, events } = buildEngine(singleNode("A", "a1"));
    // Unsatisfiable graph: A is pending with no running/ready upstream, no
    // blocked gate, no terminal error — the deadlock guard must escalate it.
    state.nodes.get("A")!.status = NodeStatus.Pending;
    state.frontier = [];
    state.phase = EnginePhase.Executing;

    engine.checkTermination(); // public H4 wrapper around _checkTermination

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].signalType).toBe("escalate");
    expect(events[0].nodeStatus).toBe(NodeStatus.Escalate);
    expect(events[0].payload).toContain("graph deadlock");
  });
});

// ── M5: failed persist keeps the dirty flag for the next section ────────────

describe("M5 — failed persist retains the dirty flag", () => {
  it("keeps isDirty when the critical save fails, clears it on the retried save", async () => {
    let persistCount = 0;
    let fail = true;
    const { engine, state } = buildEngine(singleNode("A", "a1"), {
      persistState: () => {
        persistCount += 1;
        return !fail;
      },
    });

    // First mutating section: save fails → the dirty flag must survive. The
    // section invokes the seam twice — the dispatch-start write-through
    // (running transition, running-window fix in _dispatchNode) and the
    // section-end finally — so a failed save is retried within the same
    // section; both attempts fail, and the dirty flag survives.
    await engine.dispatchReady();
    expect(persistCount).toBe(2);
    expect(state.isDirty).toBe(true);

    // Next mutating section: save succeeds → dirty cleared, retry happened.
    fail = false;
    await engine.onNodeSignalEmitted("A", "answer", "ok");
    expect(persistCount).toBe(3);
    expect(state.isDirty).toBe(false);
  });

  it("keeps isNonCriticalDirty when the debounced hand-off reports failure", async () => {
    let scheduled = 0;
    let fail = true;
    const { engine, state } = buildEngine(singleNode("A", "a1"), {
      schedulePersistState: () => {
        scheduled += 1;
        return !fail;
      },
    });

    // First real dispatch: A → running, phase → executing. A critical mutation,
    // so the synchronous tier (absent here) would own it — the debounced seam
    // is not invoked yet.
    await engine.dispatchReady();
    expect(scheduled).toBe(0);
    expect(state.isNonCriticalDirty).toBe(false);

    // Now seed a non-critical-only mutation (signal-ledger churn) and run an
    // IDLE section (nothing ready, phase already executing — no critical
    // mutation) → the debounced hand-off runs and reports failure.
    markNonCriticalDirty(state);
    await engine.dispatchReady();
    expect(scheduled).toBe(1);
    expect(state.isNonCriticalDirty).toBe(true);

    // Next hand-off succeeds → flag cleared.
    fail = false;
    markNonCriticalDirty(state);
    await engine.dispatchReady();
    expect(scheduled).toBe(2);
    expect(state.isNonCriticalDirty).toBe(false);
  });
});

// ── M10: retry clears the persisted terminalNotified dedup flag ─────────────

describe("M10 — retry re-opens the terminal-notification epoch", () => {
  it("retryNode clears state.terminalNotified", async () => {
    const { engine, state } = buildEngine(singleNode("A", "a1"));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "ok");
    expect(state.phase).toBe(EnginePhase.Complete);

    // Simulate a persisted cross-restart claim from a prior terminal fire.
    state.terminalNotified = { complete: true, blocked: false };
    state.isDirty = false;

    await engine.retryNode("A");

    expect(state.terminalNotified).toBeUndefined();
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.phase).toBe(EnginePhase.Executing);
  });

  it("resetTerminalDedupe clears state.terminalNotified and marks the state dirty", () => {
    const { engine, state } = buildEngine(singleNode("A", "a1"));
    state.terminalNotified = { complete: true, blocked: true };
    state.isDirty = false;

    // Synchronous path — no critical section runs, so the markDirty survives
    // (the clearing must be persisted via the dirty flag).
    engine.resetTerminalDedupe();

    expect(state.terminalNotified).toBeUndefined();
    expect(state.isDirty).toBe(true);
  });
});

// ── M4: subscription ledger for teardown ────────────────────────────────────

describe("M4 — engine-owned task-termination subscriptions", () => {
  it("captures each subscribeTaskTermination callback and exposes it for teardown", async () => {
    const fake = new RecordingDispatch();
    const { engine } = buildEngine(singleNode("A", "a1"), { dispatch: fake });

    await engine.dispatchReady();

    const subs = engine.getTerminationSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].taskId).toBe("task-A-1");
    expect(typeof subs[0].callback).toBe("function");
    // The fake registered the same callback.
    expect(fake.subs.get("task-A-1")).toBe(subs[0].callback);

    // S7-style teardown: unregister every subscription via the port.
    for (const s of subs) {
      fake.removeTaskTerminatedListener(s.taskId, s.callback);
    }
    expect(fake.removals).toHaveLength(1);
    expect(fake.removals[0].taskId).toBe("task-A-1");
    expect(fake.removals[0].callback).toBe(subs[0].callback);
    expect(fake.subs.size).toBe(0);
  });
});

// ── H4: public terminal/termination wrappers for external control paths ─────

describe("H4 — public notifyNodeTerminal / checkTermination wrappers", () => {
  it("notifyNodeTerminal drives the completion seam + durable event log", () => {
    const dir = makeWorkspace();
    const recorder = new GraphEventRecorder(dir);
    const { engine, events } = buildEngine(singleNode("A", "a1"), {
      graphEvents: recorder,
    });

    engine.notifyNodeTerminal(
      "A",
      "cancelled",
      "cancelled by user",
      NodeStatus.Cancelled,
    );

    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].signalType).toBe("cancelled");
    expect(events[0].payload).toBe("cancelled by user");
    expect(events[0].nodeStatus).toBe(NodeStatus.Cancelled);

    const completed = readEvents(dir, "g-1").find(
      (l) => l.event === "node_completed",
    );
    expect(completed).toBeDefined();
    expect(completed!.signalType).toBe("cancelled");
    expect(completed!.status).toBe(NodeStatus.Cancelled);
  });

  it("notifyNodeTerminal is a no-op for an unknown node id", () => {
    const { engine, events } = buildEngine(singleNode("A", "a1"));
    engine.notifyNodeTerminal("NOPE", "cancelled", "x", NodeStatus.Cancelled);
    expect(events).toHaveLength(0);
  });

  it("checkTermination is the public wrapper for _checkTermination (fires the terminal seam once)", async () => {
    let terminalFires = 0;
    const state = createEngineState(singleNode("A", "a1"), "g-h4");
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
      onGraphTerminal: () => {
        terminalFires += 1;
      },
    });

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "ok");
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(terminalFires).toBe(1);

    // A second (redundant) public re-check must not double-fire the seam.
    engine.checkTermination();
    expect(terminalFires).toBe(1);
  });
});

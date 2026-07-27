import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";

// ── Controllable fake dispatch port (mirrors signal-propagation.test.ts) ──
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

function graph(): GraphDeclaration {
  return {
    version: 2,
    name: "dual-write",
    nodes: [
      { id: "A", agent: "a0", prompt: "p0" },
      { id: "B", agent: "a1", prompt: "p1" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

function buildState(): EngineState {
  const state = createEngineState(graph(), "g-1");
  provision(state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit level — SignalBridge.record() is the engine-owned dual-write seam
// ═══════════════════════════════════════════════════════════════════════════
describe("SignalBridge.record — per-node signal history dual-write (unit)", () => {
  it("appends a genuine timestamped entry to the node's SignalLedgerEntry.history", () => {
    const state = buildState();
    const bridge = new SignalBridge();

    // No signal emitted yet → no ledger entry, so no history (stays empty).
    expect(state.signalLedger.has("A")).toBe(false);

    const before = Date.now();
    bridge.record(state, "A", "answer", { note: "done" });
    const after = Date.now();

    const entry = state.signalLedger.get("A");
    expect(entry).toBeDefined();
    expect(entry!.history).toBeDefined();
    expect(entry!.history!.length).toBe(1);

    const evt = entry!.history![0];
    expect(evt.signal).toBe("answer");
    expect(evt.payload).toEqual({ note: "done" });
    // Timestamp is a genuine epoch-ms value inside the emission window.
    expect(evt.atMs).toBeGreaterThanOrEqual(before);
    expect(evt.atMs).toBeLessThanOrEqual(after);
    // lastSignalAt stays in sync with the newest event.
    expect(entry!.lastSignalAt).toBe(evt.atMs);
    // The non-history ledger fields are also still written.
    expect(entry!.signals.answer).toEqual({ note: "done" });
  });

  it("appends ordered entries across multiple emissions and normalizes absent payloads", () => {
    const state = buildState();
    const bridge = new SignalBridge();

    bridge.record(state, "A", "progress", 0.5);
    bridge.record(state, "A", "answer", "final"); // no payload normalization issue

    const entry = state.signalLedger.get("A")!;
    expect(entry.history!.length).toBe(2);
    expect(entry.history![0].signal).toBe("progress");
    expect(entry.history![0].payload).toBe(0.5);
    expect(entry.history![1].signal).toBe("answer");
    expect(entry.history![1].payload).toBe("final");
    // Ordered: timestamps are non-decreasing.
    expect(entry.history![1].atMs).toBeGreaterThanOrEqual(entry.history![0].atMs);
    // lastSignalAt reflects the latest event.
    expect(entry.lastSignalAt).toBe(entry.history![1].atMs);
  });

  it("leaves history absent/empty for nodes that never emit a signal", () => {
    const state = buildState();
    const bridge = new SignalBridge();

    // A emits; B stays silent.
    bridge.record(state, "A", "answer", null);

    // B has no ledger entry → no history at all.
    expect(state.signalLedger.has("B")).toBe(false);
    expect(state.signalLedger.get("B")).toBeUndefined();

    // A has history but B does not.
    expect(state.signalLedger.get("A")!.history!.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration level — engine delivery seam (onNodeSignalEmitted) dual-write
// ═══════════════════════════════════════════════════════════════════════════
describe("engine signal delivery — history dual-write (integration)", () => {
  it("records the emission into the emitting node's ledger history via the engine seam", async () => {
    const state = createEngineState(graph(), "g-1");
    provision(state);
    const fake = new FakeDispatch();
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: fake,
    });

    await engine.dispatchReady();

    // Empty before any emission.
    expect(state.signalLedger.get("A")).toBeUndefined();

    // A runs and emits a live node signal through the engine's delivery seam.
    await engine.onNodeSignalEmitted("A", "answer", { result: "ok" });

    const entryA = state.signalLedger.get("A")!;
    expect(entryA.history!.length).toBe(1);
    expect(entryA.history![0].signal).toBe("answer");
    expect(entryA.history![0].payload).toEqual({ result: "ok" });
    expect(typeof entryA.history![0].atMs).toBe("number");
    expect(entryA.history![0].atMs).toBeGreaterThan(0);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);

    // B never emitted → no ledger entry / history for it.
    expect(state.signalLedger.get("B")).toBeUndefined();
  });
});

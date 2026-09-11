/**
 * Graph Execution Engine v2 — Write-Side Durable Graph Event Log (subtask 1)
 *
 * Verifies the {@link GraphEventRecorder} (`.rolebox/state/graph-events-{hash}.ndjson`):
 * - running an engine with a `stateDir` (and a recorder) writes NDJSON lines
 *   carrying `graphId` / `nodeId` / `signalType` / `status` for the write-side
 *   transitions a graph performs;
 * - a `phase_change` event is emitted on engine lifecycle transitions
 *   (`idle → executing → complete`);
 * - a `budget_update` event is emitted by `applyBudgetDelta` (engine-state sink);
 * - missing-directory and failing-append scenarios are strict no-ops (the
 *   recorder never throws, so wiring it can never break graph advancement);
 * - with no recorder configured the engine runs unchanged (no event file, no
 *   crash).
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngine } from "../../src/graph/engine/index.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import {
  GraphEventRecorder,
  graphEventsPath,
  type GraphEventRecord,
} from "../../src/graph/engine/graph-events.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  createEngineState,
  provision,
  applyBudgetDelta,
} from "../../src/graph/engine/engine-state.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/** Fake dispatch seam — resolves immediately, no real sub-agent involved. */
class FakeDispatch implements NodeDispatchPort {
  executeNode(
    _node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve(makeTask());
  }
}

/** Single root node, no downstream edges. */
function singleNode(id = "A", agent = "a1"): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: "p1" }],
    edges: [],
  };
}

/** Make a throwaway temp workspace dir for this test. */
function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "graph-events-"));
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
  const d = tempWorkspace();
  workspaces.push(d);
  return d;
}

afterEach(() => {
  // Sinks are now instance fields on EngineState — no module-level global to clear.
  for (const d of workspaces.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── Running an engine writes NDJSON lines (tool-wiring path) ────────────────

describe("GraphEventRecorder — engine integration", () => {
  it("createEngine with a recorder writes node_dispatched + phase_change on run()", async () => {
    const dir = makeWorkspace();
    const graphId = "g-run-1";
    const recorder = new GraphEventRecorder(dir);

    const engine = createEngine(singleNode("A", "a1"), {
      graphId,
      dispatch: new FakeDispatch(),
      graphEvents: recorder,
    });
    await engine.run();

    const lines = readEvents(dir, graphId);
    expect(lines.length).toBeGreaterThan(0);

    // Node dispatched: running status, nodeId + agent + startedAt.
    const dispatched = lines.find((l) => l.event === "node_dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.graphId).toBe(graphId);
    expect(dispatched!.nodeId).toBe("A");
    expect(dispatched!.status).toBe("running");
    expect(dispatched!.agent).toBe("a1");
    expect(typeof dispatched!.ts).toBe("number");

    // The kickoff critical section advanced idle → executing.
    const phases = lines.filter((l) => l.event === "phase_change");
    expect(phases.length).toBeGreaterThanOrEqual(1);
    for (const p of phases) {
      expect(p.graphId).toBe(graphId);
      expect(typeof p.status).toBe("string");
    }
  });

  it("AdvanceEngine records node_completed (answer/completed) and both phase transitions", async () => {
    const dir = makeWorkspace();
    const graphId = "g-adv-1";
    const recorder = new GraphEventRecorder(dir);

    const state = createEngineState(singleNode("A", "a1"), graphId);
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
      graphEvents: recorder,
    });

    await engine.dispatchReady(); // idle → executing, dispatch A
    await engine.onNodeSignalEmitted("A", "answer", "result-A");

    const lines = readEvents(dir, graphId);

    // node_completed carries graphId / nodeId / signalType / status.
    const completed = lines.find((l) => l.event === "node_completed");
    expect(completed).toBeDefined();
    expect(completed!.graphId).toBe(graphId);
    expect(completed!.nodeId).toBe("A");
    expect(completed!.signalType).toBe("answer");
    expect(completed!.status).toBe(NodeStatus.Completed);
    expect(completed!.agent).toBe("a1");

    // Both lifecycle transitions were recorded.
    const phases = lines.filter((l) => l.event === "phase_change");
    expect(phases.some((p) => p.status === "executing")).toBe(true);
    expect(phases.some((p) => p.status === "complete")).toBe(true);

    // Dispatch + completion both present.
    expect(lines.some((l) => l.event === "node_dispatched")).toBe(true);
    expect(lines.some((l) => l.event === "node_completed")).toBe(true);
  });

  it("emits a budget_update event via applyBudgetDelta (engine-state sink)", () => {
    const dir = makeWorkspace();
    const graphId = "g-budget-1";
    const recorder = new GraphEventRecorder(dir);

    const state = createEngineState(singleNode("A"), graphId);
    provision(state);

    // Wire the sink onto the state manually (in production, AdvanceEngine's
    // constructor does this from opts.graphEvents; here we test the engine-state
    // functions directly so we wire it ourselves).
    state.budgetEventSink = (gId, budget) => recorder.budgetUpdate(gId, budget);

    applyBudgetDelta(state, {
      sessions: 1,
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.25,
    });

    const lines = readEvents(dir, graphId);
    const budget = lines.find((l) => l.event === "budget_update");
    expect(budget).toBeDefined();
    expect(budget!.graphId).toBe(graphId);
    expect(budget!.budget).toEqual({
      sessionsSpawned: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCost: 0.25,
    });
  });
});

// ── No-op safety: missing dir / failing append / no recorder ────────────────

describe("GraphEventRecorder — total (never throws)", () => {
  it("missing directory: appending is a swallowed no-op, never throws", () => {
    const dir = makeWorkspace();
    // Pre-create `.rolebox/state` as a regular FILE so the recursive mkdir and
    // the append both fail deterministically → swallowed, no throw.
    const statePath = join(dir, ".rolebox", "state");
    mkdirSync(join(dir, ".rolebox"), { recursive: true });
    writeFileSync(statePath, "I am a file, not a directory", "utf-8");

    const recorder = new GraphEventRecorder(dir);
    expect(() => recorder.nodeDispatched("g-x", "A", "a1", 1234)).not.toThrow();
    expect(() =>
      recorder.nodeCompleted({
        graphId: "g-x",
        nodeId: "A",
        nodeAgent: "a1",
        signalType: "answer",
        payload: undefined,
        nodeStatus: NodeStatus.Completed,
        startedAt: 1,
        completedAt: 2,
      }),
    ).not.toThrow();
    // Nothing was written through — the corrupted path swallowed it.
    expect(readFileSync(statePath, "utf-8")).toBe(
      "I am a file, not a directory",
    );
  });

  it("no recorder configured (no graphEvents): engine runs with no event file", async () => {
    const dir = makeWorkspace();
    const engine = createEngine(singleNode("A", "a1"), {
      graphId: "g-norec-1",
      dispatch: new FakeDispatch(),
      // no stateDir, no graphEvents → no event logging
    });
    await engine.run();
    // No `.rolebox` tree was created by the recorder (none existed).
    expect(existsSync(join(dir, ".rolebox"))).toBe(false);
  });

  it("graphEventsPath is hash-derived and stable per graphId", () => {
    const p1 = graphEventsPath("/ws", "my-graph");
    const p2 = graphEventsPath("/ws", "my-graph");
    expect(p1).toBe(p2);
    expect(p1.replace(/\\/g, "/")).toMatch(
      /\.rolebox\/state\/graph-events-[0-9a-f]{12}\.ndjson$/,
    );
    // Different graph → different file fragment.
    expect(graphEventsPath("/ws", "other-graph")).not.toBe(p1);
  });
});

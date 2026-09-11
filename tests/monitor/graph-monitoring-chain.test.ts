import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import { createEngineState } from "../../src/graph/engine/engine-state.ts";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence.ts";
import { GraphEventRecorder } from "../../src/graph/engine/graph-events.ts";
import type { NodeCompletionEvent } from "../../src/graph/engine/engine-advance.ts";
import { readMonitorSnapshot } from "../../src/cli/commands/monitor/monitor-reader.ts";
import { renderHuman } from "../../src/cli/commands/renderer/layout.ts";
import { GraphEventPoll } from "../../src/tui/events.ts";
import { computeFilteredActivity } from "../../src/tui/logic.ts";
import { stripAnsi } from "../../src/cli/format.ts";
import { stateDirFor } from "../../src/utils/state-paths.ts";

/**
 * Cross-cutting graph-monitoring integration test (subtask 8).
 *
 * Exercises the FULL chain with real write-side primitives:
 *
 *   GraphEventRecorder + EnginePersistence (write side)
 *     → graph-events-*.ndjson + engine-*.json on disk
 *     → monitor readers (readMonitorSnapshot → engineGraphs / graphEvents)
 *     → renderHuman → renderGraphs panel (CLI)
 *     → TUI logic (GraphEventPoll incremental reader + computeFilteredActivity)
 *
 * The write side is real (not hand-written fixtures): the NDJSON event log is
 * produced by GraphEventRecorder and the engine snapshot by
 * EnginePersistence.save, so this proves the writer's on-disk format is
 * reader-compatible end to end.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graph-monitoring-chain-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  return stateDirFor(dir);
}

// ── Fixture: a runnable engine state persisted via the real store ─────────

function declaration(): GraphDeclaration {
  return {
    version: 2,
    name: "graph-integ",
    nodes: [
      { id: "A", agent: "ui-worker", prompt: "render" },
      { id: "B", agent: "backend-worker", prompt: "compile" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
    loop_groups: [{ id: "lg1", nodes: ["A", "B"], max_traversals: 3 }],
  };
}

function buildEngineState(graphId: string, startedAt: number): EngineState {
  const state = createEngineState(declaration(), graphId);
  state.phase = EnginePhase.Executing;
  state.startedAt = startedAt;
  state.updatedAt = startedAt + 5000;

  state.nodes.set("A", {
    nodeId: "A",
    agent: "ui-worker",
    prompt: "render",
    needsApproval: false,
    status: NodeStatus.Completed,
    signalsObserved: { answer: { ok: true } },
    sessionsSpawned: 1,
    tokensConsumed: { inputTokens: 1500, outputTokens: 900, cost: 0.0123 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: true,
    traversalCount: 0,
    startedAt,
    completedAt: startedAt + 3000,
    retryCount: 0,
  });

  state.nodes.set("B", {
    nodeId: "B",
    agent: "backend-worker",
    prompt: "compile",
    needsApproval: false,
    status: NodeStatus.Ready,
    signalsObserved: {},
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: false,
    traversalCount: 0,
    startedAt,
    retryCount: 0,
  });

  state.loopGroups.set("lg1", {
    id: "lg1",
    maxTraversals: 3,
    traversalCount: 1,
    startTimeMs: startedAt,
    consecutiveStale: 0,
  });

  state.budget = {
    sessionsSpawned: 1,
    totalInputTokens: 1500,
    totalOutputTokens: 900,
    totalCost: 0.0123,
  };

  state.frontier = ["B"];

  return state;
}

/**
 * Write both sides with the REAL write-side primitives (subtasks 1 / 2):
 * the engine snapshot via EnginePersistence and the event log via
 * GraphEventRecorder. Returns the shared graph id.
 */
function writeGraphData(graphId: string, startedAt: number): void {
  new EnginePersistence(dir).save(buildEngineState(graphId, startedAt));

  const recorder = new GraphEventRecorder(dir);
  const now = Date.now();
  recorder.nodeDispatched(graphId, "A", "ui-worker", now);
  recorder.nodeCompleted({
    graphId,
    nodeId: "A",
    nodeAgent: "ui-worker",
    signalType: "answer",
    payload: { ok: true },
    nodeStatus: NodeStatus.Completed,
    startedAt: now,
    completedAt: now + 3000,
  } satisfies NodeCompletionEvent);
  recorder.phaseChange(graphId, EnginePhase.Idle, EnginePhase.Executing);
  recorder.budgetUpdate(graphId, buildEngineState(graphId, startedAt).budget);
}

// ── Stdout capture for renderHuman ──────────────────────────────────────

function captureStdout(fn: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return logs;
}

// ── The full chain ──────────────────────────────────────────────────────

describe("graph monitoring chain (write → readers → render → TUI)", () => {
  it("round-trips a persisted engine + NDJSON event log through the whole pipeline", () => {
    const graphId = "graph-integ";
    const startedAt = Date.now() - 60_000;
    writeGraphData(graphId, startedAt);

    // ── Leg 1: readers → MonitorSnapshot fields ───────────────────────────
    const snapshot = readMonitorSnapshot(dir);

    // engineGraphs: the persisted engine is surfaced (unfiltered), matching id.
    expect(snapshot.engineGraphs).toHaveLength(1);
    const graph = snapshot.engineGraphs[0]!;
    expect(graph.graphId).toBe(graphId);
    expect(graph.phase).toBe(EnginePhase.Executing);
    expect(graph.nodeCount).toBe(2);
    expect(graph.nodeStatusCounts[NodeStatus.Completed]).toBe(1);
    expect(graph.nodeStatusCounts[NodeStatus.Ready]).toBe(1);
    expect(graph.budget.sessionsSpawned).toBe(1);
    expect(graph.frontier).toEqual(["B"]);
    expect(graph.loopGroups).toHaveLength(1);
    // Per-node projection carries agent + status + signal provenance.
    expect(graph.nodes.find((n) => n.nodeId === "A")?.signalType).toBe("answer");

    // graphEvents: the NDJSON log (written by GraphEventRecorder) is read back.
    expect(snapshot.graphEvents).toBeDefined();
    const events = snapshot.graphEvents!;
    expect(events.length).toBeGreaterThan(0);
    const completed = events.find((e) => e.event === "node_completed");
    expect(completed).toBeDefined();
    expect(completed!.graphId).toBe(graphId);
    expect(completed!.nodeId).toBe("A");
    expect(completed!.signalType).toBe("answer");
    expect(completed!.agent).toBe("ui-worker");
    // The full write-side vocabulary round-trips (budget_update included).
    const kinds = new Set(events.map((e) => e.event));
    expect(kinds.has("node_dispatched")).toBe(true);
    expect(kinds.has("node_completed")).toBe(true);
    expect(kinds.has("phase_change")).toBe(true);
    expect(kinds.has("budget_update")).toBe(true);

    // ── Leg 2: renderHuman → Graphs panel ────────────────────────────────
    const lines = captureStdout(() => {
      renderHuman(snapshot, false, 0);
    });
    const clean = stripAnsi(lines.join("\n"));
    expect(clean).toContain("Graphs");
    expect(clean).toContain(graphId);
    expect(clean).toContain("ui-worker");
    expect(clean).toContain("completed:1");
    expect(clean).toContain("node_completed");
    expect(clean).toContain("answer");

    // ── Leg 3a: TUI incremental GraphEventPoll over the same NDJSON ──────
    const poll = new GraphEventPoll(stateDir());
    const tuEvents = poll.poll();
    // budget_update has no TUI surface → it is skipped; the other three map.
    expect(tuEvents.some((e) => e.type === "graph_node_start")).toBe(true);
    expect(tuEvents.some((e) => e.type === "graph_node_end")).toBe(true);
    expect(tuEvents.some((e) => e.type === "graph_signal")).toBe(true);
    // Incremental: a second poll sees nothing new (monotonic offset).
    expect(poll.poll()).toEqual([]);
    // The node_end event carries the terminating signal back.
    const end = tuEvents.find((e) => e.type === "graph_node_end")!;
    expect(end.graphId).toBe(graphId);

    // ── Leg 3b: TUI activity filtering surfaces the engine graph ────────
    const activity = computeFilteredActivity({
      snapshot,
      stateDirPresent: true,
      sessionScope: new Set(),
      currentSessionId: "session-x",
      filterText: "",
    });
    expect(activity.engineGraphs.map((g) => g.graphId)).toContain(graphId);
    // Text filter still applies to engine graphs by graphId.
    const filtered = computeFilteredActivity({
      snapshot,
      stateDirPresent: true,
      sessionScope: new Set(),
      currentSessionId: "session-x",
      filterText: "no-match",
    });
    expect(filtered.engineGraphs).toEqual([]);
  });

  it("yields empty engineGraphs / graphEvents when the state dir has neither", () => {
    // No engine-*.json, no graph-events-*.ndjson → honest empty surface.
    const snapshot = readMonitorSnapshot(dir);
    expect(snapshot.engineGraphs).toEqual([]);
    expect(snapshot.graphEvents).toEqual([]);
  });
});

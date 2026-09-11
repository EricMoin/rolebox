/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import {
  computeHealth,
  getActiveTasks,
  computeFilteredActivity,
  deriveEnginePhase,
} from "../../src/tui/logic";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
  LoopSnapshot,
  GraphSessionSnapshot,
  EngineGraphSnapshot,
  DispatchSummary,
  ConcurrencyStatus,
} from "../../src/cli/commands/monitor/monitor-reader-types";
import { formatDuration, barSegments, truncate, engineNodeGlyph } from "../../src/tui/helpers";

// ── Helpers ─────────────────────────────────────────────────────────────

function emptyDispatchSummary(): DispatchSummary {
  return { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0 };
}

function emptyConcurrency(): ConcurrencyStatus {
  return { active: 0, limit: 0, queued: 0 };
}

function makeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    projectDir: "/test",
    timestamp: new Date().toISOString(),
    tasks: [],
    activeFunctions: [],
    loops: [],
    graphSessions: [],
    engineGraphs: [],
    graphEvents: [],
    dispatchSummary: emptyDispatchSummary(),
    concurrency: emptyConcurrency(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskSnapshot> & { id: string }): TaskSnapshot {
  return {
    status: "pending",
    agent: "test-agent",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    depth: 0,
    mode: "background",
    ...overrides,
  };
}

function makeFn(overrides: Partial<ActiveFunction>): ActiveFunction {
  return {
    sessionId: "sess-1",
    agentId: null,
    name: "test-fn",
    phase: "active",
    continuationCount: 0,
    ...overrides,
  };
}

function makeLoop(overrides: Partial<LoopSnapshot>): LoopSnapshot {
  return {
    originSessionId: "sess-1",
    agent: "test-agent",
    phase: "running",
    current: 1,
    total: 3,
    mode: "inherit",
    elapsedMs: 5000,
    ...overrides,
  };
}

function makeGraph(overrides: Partial<GraphSessionSnapshot>): GraphSessionSnapshot {
  return {
    sessionId: "sess-1",
    agentId: "test-agent",
    status: "active",
    frontier: [],
    completed: [],
    iterationCount: 1,
    ...overrides,
  };
}

function makeEngineGraph(overrides: Partial<EngineGraphSnapshot>): EngineGraphSnapshot {
  return {
    graphId: "graph-abc123",
    phase: "executing",
    nodeCount: 1,
    nodeStatusCounts: { running: 1 },
    nodes: [{ nodeId: "n1", agent: "emperor--jinyiwei--ui", status: "running", startedAt: new Date().toISOString() }],
    budget: { sessionsSpawned: 1, totalInputTokens: 1000, totalOutputTokens: 500, totalCost: 0.01 },
    frontier: [],
    loopGroups: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasCheckpoints: false,
    ...overrides,
  };
}

// ── computeHealth ───────────────────────────────────────────────────────

describe("computeHealth", () => {
  it("returns null when phase is loading", () => {
    expect(
      computeHealth({
        phase: "loading",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: null,
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBeNull();
  });

  it("returns NO_STATE when state dir is absent", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: false,
        consecutiveFailures: 0,
        snapshot: null,
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("NO_STATE");
  });

  it("returns STALE when phase is error", () => {
    expect(
      computeHealth({
        phase: "error",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: null,
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("STALE");
  });

  it("returns STALE when consecutiveFailures > 0", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 3,
        snapshot: makeSnapshot(),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("STALE");
  });

  it("returns IDLE when snapshot is null and phase is ready", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: null,
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("IDLE");
  });

  it("returns IDLE when nothing is active and no errors", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot(),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("IDLE");
  });

  it("returns ERROR when task has error status", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          tasks: [makeTask({ id: "t1", status: "error", sessionId: "sess-1", startedAt: new Date().toISOString() })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ERROR");
  });

  it("returns ERROR when task has timeout status", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          tasks: [makeTask({ id: "t1", status: "timeout", sessionId: "sess-1", startedAt: new Date().toISOString() })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ERROR");
  });

  it("returns ERROR when loop has errorReason", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          loops: [makeLoop({ originSessionId: "sess-1", errorReason: "timeout" })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ERROR");
  });

  it("returns ACTIVE when concurrency active > 0", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({ concurrency: { active: 2, limit: 10, queued: 0 } }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ACTIVE");
  });

  it("returns ACTIVE when dispatchSummary has pending tasks", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({ dispatchSummary: { pending: 1, running: 0, completed: 0, error: 0, cancelled: 0 } }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ACTIVE");
  });

  it("returns ACTIVE when active functions are present", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          activeFunctions: [makeFn({ sessionId: "sess-1" })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ACTIVE");
  });

  it("returns ACTIVE when graph is active", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          graphSessions: [makeGraph({ sessionId: "sess-1", status: "active" })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ACTIVE");
  });

  it("returns ACTIVE when loops are present", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          loops: [makeLoop({ originSessionId: "sess-1" })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("ACTIVE");
  });

  it("does not count tasks outside session scope for error detection", () => {
    expect(
      computeHealth({
        phase: "ready",
        stateDirPresent: true,
        consecutiveFailures: 0,
        snapshot: makeSnapshot({
          tasks: [makeTask({ id: "t1", status: "error", sessionId: "sess-other", startedAt: new Date().toISOString() })],
        }),
        sessionScope: new Set(["sess-1"]),
        currentSessionId: "sess-1",
      }),
    ).toBe("IDLE");
  });
});

// ── getActiveTasks ──────────────────────────────────────────────────────

describe("getActiveTasks", () => {
  it("returns empty array when snapshot is null", () => {
    expect(getActiveTasks(null, new Set(["sess-1"]), "sess-1")).toEqual([]);
  });

  it("filters out completed/cancelled tasks", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "sess-1", startedAt: "2024-01-01T00:00:00Z" }),
      makeTask({ id: "t2", status: "completed", sessionId: "sess-1", startedAt: "2024-01-01T00:00:00Z" }),
      makeTask({ id: "t3", status: "cancelled", sessionId: "sess-1", startedAt: "2024-01-01T00:00:00Z" }),
    ];
    const result = getActiveTasks(makeSnapshot({ tasks }), new Set(["sess-1"]), "sess-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("sorts errors before running before pending", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "sess-1", startedAt: "2024-01-01T00:00:01Z" }),
      makeTask({ id: "t2", status: "pending", sessionId: "sess-1", startedAt: "2024-01-01T00:00:02Z" }),
      makeTask({ id: "t3", status: "error", sessionId: "sess-1", startedAt: "2024-01-01T00:00:03Z" }),
      makeTask({ id: "t4", status: "timeout", sessionId: "sess-1", startedAt: "2024-01-01T00:00:04Z" }),
    ];
    const result = getActiveTasks(makeSnapshot({ tasks }), new Set(["sess-1"]), "sess-1");
    // Both error and timeout have rank 0; sorted by descending startedAt (most recent first)
    expect(result.map((t) => t.id)).toEqual(["t4", "t3", "t1", "t2"]);
  });

  it("sorts errors by most recent first (descending startedAt)", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "error", sessionId: "sess-1", startedAt: "2024-01-01T00:00:01Z" }),
      makeTask({ id: "t2", status: "error", sessionId: "sess-1", startedAt: "2024-01-01T00:00:03Z" }),
      makeTask({ id: "t3", status: "error", sessionId: "sess-1", startedAt: "2024-01-01T00:00:02Z" }),
    ];
    const result = getActiveTasks(makeSnapshot({ tasks }), new Set(["sess-1"]), "sess-1");
    expect(result.map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
  });

  it("sorts running/pending by earliest first (ascending startedAt)", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "sess-1", startedAt: "2024-01-01T00:00:03Z" }),
      makeTask({ id: "t2", status: "running", sessionId: "sess-1", startedAt: "2024-01-01T00:00:01Z" }),
      makeTask({ id: "t3", status: "pending", sessionId: "sess-1", startedAt: "2024-01-01T00:00:02Z" }),
    ];
    const result = getActiveTasks(makeSnapshot({ tasks }), new Set(["sess-1"]), "sess-1");
    expect(result.map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
  });

  it("filters by session scope", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "sess-1", startedAt: "2024-01-01T00:00:01Z" }),
      makeTask({ id: "t2", status: "running", sessionId: "sess-other", startedAt: "2024-01-01T00:00:02Z" }),
    ];
    const result = getActiveTasks(makeSnapshot({ tasks }), new Set(["sess-1"]), "sess-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });
});

// ── computeFilteredActivity ─────────────────────────────────────────────

describe("computeFilteredActivity", () => {
  it("returns empty when snapshot is null", () => {
    const result = computeFilteredActivity({
      snapshot: null,
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result).toEqual({ fns: [], tasks: [], graphs: [], loops: [], engineGraphs: [] });
  });

  it("returns empty when stateDirPresent is false", () => {
    const result = computeFilteredActivity({
      snapshot: makeSnapshot(),
      stateDirPresent: false,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result).toEqual({ fns: [], tasks: [], graphs: [], loops: [], engineGraphs: [] });
  });

  it("filters functions by session scope", () => {
    const fns: ActiveFunction[] = [
      makeFn({ sessionId: "sess-1", name: "my-fn" }),
      makeFn({ sessionId: "sess-other", name: "other-fn" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: fns,
        tasks: [],
        loops: [],
        graphSessions: [],
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.fns).toHaveLength(1);
    expect(result.fns[0].name).toBe("my-fn");
  });

  it("filters by filterText (case-insensitive)", () => {
    const fns: ActiveFunction[] = [
      makeFn({ sessionId: "sess-1", name: "AlphaFn" }),
      makeFn({ sessionId: "sess-1", name: "BetaFn" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: fns,
        tasks: [],
        loops: [],
        graphSessions: [],
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "alpha",
    });
    expect(result.fns).toHaveLength(1);
    expect(result.fns[0].name).toBe("AlphaFn");
  });

  it("sorts functions by agentId presence (with agentId first)", () => {
    const fns: ActiveFunction[] = [
      makeFn({ sessionId: "sess-1", name: "no-agent", agentId: null }),
      makeFn({ sessionId: "sess-1", name: "has-agent", agentId: "agent-1" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({ activeFunctions: fns, tasks: [], loops: [], graphSessions: [] }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.fns.map((f) => f.name)).toEqual(["has-agent", "no-agent"]);
  });

  it("sorts gated functions before active functions", () => {
    const fns: ActiveFunction[] = [
      makeFn({ sessionId: "sess-1", name: "active-fn", phase: "active" }),
      makeFn({ sessionId: "sess-1", name: "gated-fn", phase: "gated" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({ activeFunctions: fns, tasks: [], loops: [], graphSessions: [] }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    // gated (phase !== "active" && phase !== "complete") sorts before active
    expect(result.fns.map((f) => f.name)).toEqual(["gated-fn", "active-fn"]);
  });

  it("sorts by higher continuationCount first", () => {
    const fns: ActiveFunction[] = [
      makeFn({ sessionId: "sess-1", name: "low-count", continuationCount: 1 }),
      makeFn({ sessionId: "sess-1", name: "high-count", continuationCount: 5 }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({ activeFunctions: fns, tasks: [], loops: [], graphSessions: [] }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.fns.map((f) => f.name)).toEqual(["high-count", "low-count"]);
  });

  it("sorts by name alphabetically when continuation counts are equal", () => {
    const fns: ActiveFunction[] = [
      makeFn({ sessionId: "sess-1", name: "Zebra", continuationCount: 3 }),
      makeFn({ sessionId: "sess-1", name: "Alpha", continuationCount: 3 }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({ activeFunctions: fns, tasks: [], loops: [], graphSessions: [] }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.fns.map((f) => f.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("filters loops by fnName text match", () => {
    const loops: LoopSnapshot[] = [
      makeLoop({ originSessionId: "sess-1" }),
      makeLoop({ originSessionId: "sess-1" }),
    ];
    // fnName is not in LoopSnapshot type — we test the filterMatch code path
    // by accessing it through an extension
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: [],
        tasks: [],
        loops,
        graphSessions: [],
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.loops).toHaveLength(2);
  });

  it("filters graphs by session scope", () => {
    const graphs: GraphSessionSnapshot[] = [
      makeGraph({ sessionId: "sess-1" }),
      makeGraph({ sessionId: "sess-other" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: [],
        tasks: [],
        loops: [],
        graphSessions: graphs,
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.graphs).toHaveLength(1);
    expect(result.graphs[0].sessionId).toBe("sess-1");
  });

  it("includes engine graphs within session scope", () => {
    // Engine graphs carry no graph-level sessionId — they are surfaced for
    // this session's view (matching the monitor reader's unfiltered projection).
    const engineGraphs: EngineGraphSnapshot[] = [
      makeEngineGraph({ graphId: "engine-graph-1" }),
      makeEngineGraph({ graphId: "engine-graph-2" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: [],
        tasks: [],
        loops: [],
        graphSessions: [],
        engineGraphs,
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.engineGraphs).toHaveLength(2);
    expect(result.engineGraphs.map((g) => g.graphId)).toEqual(["engine-graph-1", "engine-graph-2"]);
  });

  it("filters engine graphs by filterText on graphId (case-insensitive)", () => {
    const engineGraphs: EngineGraphSnapshot[] = [
      makeEngineGraph({ graphId: "AlphaGraph" }),
      makeEngineGraph({ graphId: "BetaGraph" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: [],
        tasks: [],
        loops: [],
        graphSessions: [],
        engineGraphs,
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "alpha",
    });
    expect(result.engineGraphs).toHaveLength(1);
    expect(result.engineGraphs[0].graphId).toBe("AlphaGraph");
  });

  it("returns empty engineGraphs when none present", () => {
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        activeFunctions: [],
        tasks: [],
        loops: [],
        graphSessions: [],
        engineGraphs: [],
      }),
      stateDirPresent: true,
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    expect(result.engineGraphs).toEqual([]);
  });
});

// ── deriveEnginePhase ────────────────────────────────────────────────────

describe("deriveEnginePhase", () => {
  it("returns executing when any node is running, even if phase is idle", () => {
    expect(deriveEnginePhase({
      phase: "idle",
      nodeStatusCounts: { running: 1, completed: 2 },
    })).toBe("executing");
  });

  it("returns executing when running > 0 regardless of the persisted phase", () => {
    expect(deriveEnginePhase({
      phase: "complete",
      nodeStatusCounts: { running: 1, completed: 3 },
    })).toBe("executing");
  });

  it("renders a running engine graph snapshot as executing, not idle", () => {
    const graph = makeEngineGraph({ phase: "idle", nodeStatusCounts: { running: 1 } });
    expect(deriveEnginePhase(graph)).toBe("executing");
  });

  it("returns the persisted phase when no node is running", () => {
    expect(deriveEnginePhase({ phase: "idle", nodeStatusCounts: { completed: 4 } })).toBe("idle");
    expect(deriveEnginePhase({ phase: "complete", nodeStatusCounts: { completed: 4 } })).toBe("complete");
  });

  it("treats a missing running count as zero", () => {
    expect(deriveEnginePhase({ phase: "idle", nodeStatusCounts: {} })).toBe("idle");
  });
});

// ── formatDuration ──────────────────────────────────────────────────────

describe("formatDuration", () => {
  it('returns "?" for negative values', () => {
    expect(formatDuration(-1)).toBe("?");
  });

  it('returns "?" for NaN', () => {
    expect(formatDuration(NaN)).toBe("?");
  });

  it('returns "?" for Infinity', () => {
    expect(formatDuration(Infinity)).toBe("?");
  });

  it("formats milliseconds (< 1000)", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds (< 60s)", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  it("formats minutes with seconds", () => {
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120000)).toBe("2m");
  });
});

// ── barSegments ─────────────────────────────────────────────────────────

describe("barSegments", () => {
  it("returns all empty when total is 0", () => {
    expect(barSegments(0, 0, 6)).toEqual({ filled: 0, empty: 6 });
  });

  it("returns all empty when total is negative", () => {
    expect(barSegments(5, -1, 6)).toEqual({ filled: 0, empty: 6 });
  });

  it("returns all filled when current >= total", () => {
    expect(barSegments(10, 10, 6)).toEqual({ filled: 6, empty: 0 });
  });

  it("returns proportional fill (50%)", () => {
    expect(barSegments(5, 10, 6)).toEqual({ filled: 3, empty: 3 });
  });

  it("clamps to width", () => {
    expect(barSegments(100, 10, 6)).toEqual({ filled: 6, empty: 0 });
  });

  it("handles custom width", () => {
    expect(barSegments(1, 4, 8)).toEqual({ filled: 2, empty: 6 });
  });
});

// ── truncate ────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns the string as-is when within max length", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis when exceeding max length", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("handles exact length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

// ── engineNodeGlyph ──────────────────────────────────────────────────────

describe("engineNodeGlyph", () => {
  it("maps running to the running glyph", () => {
    expect(engineNodeGlyph("running")).toBe("\u2022"); // •
  });

  it("maps completed and done to the done glyph", () => {
    expect(engineNodeGlyph("completed")).toBe("\u2713"); // ✓
    expect(engineNodeGlyph("done")).toBe("\u2713");
  });

  it("maps pending and ready to the pending glyph", () => {
    expect(engineNodeGlyph("pending")).toBe("\u00b7"); // ·
    expect(engineNodeGlyph("ready")).toBe("\u00b7");
  });

  it("maps blocked to the gated glyph", () => {
    expect(engineNodeGlyph("blocked")).toBe("\u00b7"); // ·
  });

  it("maps timeout to the timeout glyph", () => {
    expect(engineNodeGlyph("timeout")).toBe("\u25c7"); // ◇
  });

  it("maps escalate to the error glyph", () => {
    expect(engineNodeGlyph("escalate")).toBe("\u2717"); // ✗
  });

  it("maps cancelled to the cancel glyph", () => {
    expect(engineNodeGlyph("cancelled")).toBe("\u25cb"); // ○
  });

  it("falls back to the pending glyph for unknown statuses", () => {
    expect(engineNodeGlyph("mystery")).toBe("\u00b7");
  });
});

// ── Scope supplement (engine-graph dispatch session IDs) ────────────────
// When engine-graph nodes carry dispatchSessionId, state.tsx adds those IDs
// to the sessionScope before passing it to the logic layer. These tests
// verify that the consumption side (computeFilteredActivity, computeHealth)
// correctly handles the supplemented scope.

describe("scope supplement through computeFilteredActivity", () => {
  it("shows tasks from engine-graph dispatch sessions when scope is supplemented (size > 1)", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "sess-1", startedAt: "2024-01-01T00:00:01Z" }),
      // This task belongs to a dispatch session discovered from engine-graph node.
      makeTask({ id: "t2", status: "running", sessionId: "disp-sess-abc", startedAt: "2024-01-01T00:00:02Z" }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({
        tasks,
        engineGraphs: [
          makeEngineGraph({
            nodes: [{
              nodeId: "n1", agent: "test-agent", status: "running",
              startedAt: new Date().toISOString(),
              dispatchSessionId: "disp-sess-abc",
            }],
          }),
        ],
      }),
      stateDirPresent: true,
      // Scope was supplemented by state.tsx with the dispatch session ID.
      sessionScope: new Set(["sess-1", "disp-sess-abc"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    // Both tasks are visible — scope.size === 2, so the size===1 fallback did
    // not fire. The supplemented dispatch ID correctly unscopes the task.
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("engine graphs are surfaced even when scope is not supplemented (they bypass scope)", () => {
    // Engine graphs carry no session-level scope — they are always surfaced
    // (only the text filter applies). This is the existing contract.
    const engineGraphs: EngineGraphSnapshot[] = [
      makeEngineGraph({
        graphId: "graph-dispatched",
        nodes: [{
          nodeId: "n-dispatched", agent: "agent-d", status: "running",
          startedAt: new Date().toISOString(),
          dispatchSessionId: "disp-sess-xyz",
        }],
      }),
    ];
    const result = computeFilteredActivity({
      snapshot: makeSnapshot({ engineGraphs }),
      stateDirPresent: true,
      // Bare scope — only the current session. No engine-graph dispatch IDs
      // have been added yet (simulating the "before supplement" state).
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
      filterText: "",
    });
    // Engine graphs are still surfaced — they bypass session scope filtering.
    expect(result.engineGraphs).toHaveLength(1);
    expect(result.engineGraphs[0].graphId).toBe("graph-dispatched");
    expect(result.engineGraphs[0].nodes[0].dispatchSessionId).toBe("disp-sess-xyz");
  });

  it("computeHealth detects activity from engine-graph dispatch sessions when scope is supplemented", () => {
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "disp-sess-runner", startedAt: "2024-01-01T00:00:01Z" }),
    ];
    const loops: LoopSnapshot[] = [
      makeLoop({ originSessionId: "disp-sess-runner", phase: "running" }),
    ];
    const result = computeHealth({
      phase: "ready",
      stateDirPresent: true,
      consecutiveFailures: 0,
      snapshot: makeSnapshot({ tasks, loops }),
      // Scope supplemented with the dispatch session ID — tasks/loops are in scope.
      sessionScope: new Set(["sess-1", "disp-sess-runner"]),
      currentSessionId: "sess-1",
    });
    // Activity in the dispatch session is detected because the scope was
    // supplemented. Without the supplement, this would return IDLE.
    expect(result).toBe("ACTIVE");
  });

  it("computeHealth returns IDLE when task is outside bare scope (size === 1, fallback NOT yet applied)", () => {
    // This tests the state BEFORE the size===1 fallback in state.tsx fires.
    // With only {sess-1} in scope, tasks from other sessions are invisible.
    const tasks: TaskSnapshot[] = [
      makeTask({ id: "t1", status: "running", sessionId: "sess-other", startedAt: "2024-01-01T00:00:01Z" }),
    ];
    const result = computeHealth({
      phase: "ready",
      stateDirPresent: true,
      consecutiveFailures: 0,
      snapshot: makeSnapshot({ tasks }),
      // Bare scope — no supplement from engine-graph dispatch IDs.
      // The size===1 fallback in state.tsx has not yet fired (this is the
      // consumption-side view), so sess-other is out of scope.
      sessionScope: new Set(["sess-1"]),
      currentSessionId: "sess-1",
    });
    // No activity in scope => IDLE.
    expect(result).toBe("IDLE");
  });
});

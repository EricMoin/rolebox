import { describe, it, expect } from "bun:test";
import { stripAnsi } from "../../../src/cli/format";
import type {
  MonitorSnapshot,
  LoopSnapshot,
  EngineGraphSnapshot,
  GraphEvent,
} from "../../../src/cli/commands/monitor/monitor-reader";

// ── Helpers ─────────────────────────────────────────────────

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

function makeMonitorSnapshot(
  overrides?: Partial<MonitorSnapshot>,
): MonitorSnapshot {
  return {
    projectDir: "/fake/project",
    timestamp: "2025-01-01T00:00:00.000Z",
    tasks: [],
    activeFunctions: [],
    loops: [],
    graphSessions: [],
    engineGraphs: [],
    graphEvents: [],
    dispatchSummary: {
      pending: 0,
      running: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
    },
    concurrency: { active: 0, limit: 0, queued: 0 },
    ...overrides,
  };
}

function makeGraph(): EngineGraphSnapshot {
  return {
    graphId: "graph-abc123",
    phase: "executing",
    agentId: "ui-worker",
    nodeCount: 4,
    nodeStatusCounts: { ready: 1, running: 2, completed: 1 },
    nodes: [],
    budget: {
      sessionsSpawned: 4,
      totalInputTokens: 1500,
      totalOutputTokens: 900,
      totalCost: 0.0123,
    },
    frontier: ["backend.compile", "ui.render"],
    loopGroups: [],
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:01:00.000Z",
    hasCheckpoints: false,
  };
}

function makeEvents(): GraphEvent[] {
  const now = Date.now();
  return [
    {
      ts: now - 5000,
      graphId: "graph-abc123",
      event: "node_dispatched",
      nodeId: "backend.compile",
      status: "running",
      agent: "ui-worker",
    },
    {
      ts: now - 2000,
      graphId: "graph-abc123",
      event: "node_completed",
      nodeId: "ui.render",
      status: "done",
      signalType: "answer",
      agent: "ui-worker",
    },
    // Event for a different graph — must not leak into this graph's rows.
    {
      ts: now - 1000,
      graphId: "graph-other",
      event: "phase_change",
      status: "complete",
    },
  ];
}

// ── renderGraphs ────────────────────────────────────────────

describe("renderGraphs", () => {
  it("renders graph rows when engineGraphs is populated", async () => {
    const { renderGraphs } = await import("../../../src/cli/commands/renderer/status-format");

    const lines = captureStdout(() => {
      renderGraphs(makeMonitorSnapshot({
        engineGraphs: [makeGraph()],
        graphEvents: makeEvents(),
      }));
    });

    expect(lines.length).toBeGreaterThan(0);
    const clean = stripAnsi(lines.join("\n"));

    // Section title + panel
    expect(clean).toContain("Graphs");

    // Graph identity + phase glyph + agent
    expect(clean).toContain("graph-abc123");
    expect(clean).toContain("ui-worker");

    // Node status counts
    expect(clean).toContain("running:2");
    expect(clean).toContain("completed:1");

    // Budget
    expect(clean).toContain("sess 4");
    expect(clean).toContain("tok 2.4k");
    expect(clean).toContain("$0.01");

    // Frontier preview (short names)
    expect(clean).toContain("backend");
    expect(clean).toContain("ui");

    // Graph events (node signals) for this graph
    expect(clean).toContain("node_dispatched");
    expect(clean).toContain("node_completed");
    expect(clean).toContain("answer");

    // Other graph's events are not leaked in
    expect(clean).not.toContain("graph-other");
    expect(clean).not.toContain("phase_change");
  });

  it("suppresses the section when engineGraphs is empty", async () => {
    const { renderGraphs } = await import("../../../src/cli/commands/renderer/status-format");

    const lines = captureStdout(() => {
      renderGraphs(makeMonitorSnapshot());
    });

    expect(lines).toEqual([]);
  });

  it("suppresses even when graphEvents exist but no engine graphs", async () => {
    const { renderGraphs } = await import("../../../src/cli/commands/renderer/status-format");

    const lines = captureStdout(() => {
      renderGraphs(makeMonitorSnapshot({ graphEvents: makeEvents() }));
    });

    expect(lines).toEqual([]);
  });
});

// ── renderHuman integration ─────────────────────────────────

describe("renderHuman graph wiring", () => {
  it("emits the Graphs panel after Orchestration when populated", async () => {
    const { renderHuman } = await import("../../../src/cli/commands/renderer/layout");

    // A live loop so the Orchestration panel renders too (it is suppressed
    // when loops + graphSessions are both empty).
    const loop: LoopSnapshot = {
      originSessionId: "s1",
      activeWorkerSessionId: "s2",
      agent: "primary",
      phase: "active",
      current: 2,
      total: 5,
      mode: "inherit",
      elapsedMs: 1000,
    };

    const lines = captureStdout(() => {
      renderHuman(
        makeMonitorSnapshot({ loops: [loop], engineGraphs: [makeGraph()], graphEvents: makeEvents() }),
        false,
        0,
      );
    });

    const clean = stripAnsi(lines.join("\n"));
    expect(clean).toContain("Graphs");
    expect(clean).toContain("graph-abc123");
    expect(clean).toContain("node_completed");

    // Graphs panel appears after the Orchestration panel in output order
    const orchIdx = clean.indexOf("Orchestration");
    const graphIdx = clean.indexOf("Graphs");
    expect(orchIdx).toBeGreaterThanOrEqual(0);
    expect(graphIdx).toBeGreaterThan(orchIdx);
  });

  it("omits the Graphs panel when engineGraphs is empty", async () => {
    const { renderHuman } = await import("../../../src/cli/commands/renderer/layout");

    const lines = captureStdout(() => {
      renderHuman(makeMonitorSnapshot(), false, 0);
    });

    const clean = stripAnsi(lines.join("\n"));
    expect(clean).not.toContain("Graphs");
  });
});

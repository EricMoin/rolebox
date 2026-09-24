import { graphStoreRoot } from "../../src/graph/store/schema.ts";
import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readMonitorSnapshot } from "../../src/cli/commands/monitor/monitor-reader.ts";

let tmpDir: string;
let previousData: string | undefined;

beforeEach(() => {
  previousData = process.env.ROLEBOX_DATA_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-reader-test-"));
  process.env.ROLEBOX_DATA_DIR = join(tmpDir, "data");
});

afterEach(() => {
  if (previousData === undefined) delete process.env.ROLEBOX_DATA_DIR; else process.env.ROLEBOX_DATA_DIR = previousData;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, ".rolebox", "state");
}

/** Write a JSON state file directly into the state dir. */
function writeStateFile(filename: string, contents: string): string {
  const path = join(stateDir(), filename);
  writeFileSync(path, contents, "utf-8");
  return path;
}

/** Write an NDJSON state file (one JSON object per line). */
function writeNDJSONFile(filename: string, lines: unknown[]): string {
  const path = join(stateDir(), filename);
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf-8");
  return path;
}

// ── Hand-authored state-file builders ─────────────────────────────────

async function writeGraph(graphId = "demo-graph") {
  const app = GraphApplication.open({ workspaceDir: tmpDir, storeRoot: graphStoreRoot(process.env.ROLEBOX_DATA_DIR!, tmpDir), env: {}, deliver: () => {} });
  try {
    await app.tools.graph_declare_and_start({ declaration: { version: 3, name: graphId,
      nodes: [{ id: "n1", agent: "worker", prompt: "build", outcomes: [{ id: "done" }] }], edges: [] } }, "parent");
  } finally { app.close(); }
}

/** Build a dispatch file whose live task session does NOT match the graphId. */
function buildDispatchFile(): Record<string, unknown> {
  return {
    version: 1,
    tasks: [
      {
        id: "engine-task-1",
        sessionId: "engine-session-1",
        status: "running",
        agent: "emperor--jinyiwei--backend",
        startedAt: "2026-07-27T00:00:00.000Z",
        depth: 0,
        mode: "sync",
      },
    ],
  };
}

/** Build an fnstate file with a live active function on a dispatch session. */
function buildFnStateFile(): Record<string, unknown> {
  return {
    version: 1,
    sessions: [
      {
        sessionId: "engine-session-1",
        fns: [
          {
            name: "buildSomething",
            state: { phase: "active", continuationCount: 2, currentTurn: 3, activatedAtTurn: 1 },
          },
        ],
      },
    ],
  };
}

/** Build a loops file with a non-terminal loop on a dispatch session. */
function buildLoopsFile(): Record<string, unknown> {
  return {
    version: 1,
    loops: [
      {
        id: "loop-1",
        state: {
          originSessionId: "engine-session-1",
          agent: "emperor--jinyiwei",
          phase: "running",
          current: 1,
          total: 5,
          mode: "inherit",
          startedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      },
    ],
  };
}

describe("readMonitorSnapshot — engine graph integration", () => {
  it("surfaces a persisted engine graph in engineGraphs even when no dispatch task sessionId matches its graphId", async () => {
    mkdirSync(stateDir(), { recursive: true });
    await writeGraph();

    // A live dispatch task whose sessionId differs from the graphId: under the
    // legacy liveSessions filter this graph would be hidden; it must surface.
    writeStateFile("dispatch-x.json", JSON.stringify(buildDispatchFile()));

    const snap = readMonitorSnapshot(tmpDir);

    // Engine graph present and projected.
    expect(snap.engineGraphs).toHaveLength(1);
    const g = snap.engineGraphs[0];
    expect(g.graphId).toBe("demo-graph");
    expect(g.phase).toBe("executing");
    expect(g.nodes.map((n) => n.nodeId)).toEqual(["n1"]);

    // Legacy dispatch surface unchanged.
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0].id).toBe("engine-task-1");
    expect(snap.tasks[0].status).toBe("running");
  });

  it("surfaces an engine graph even when there is no dispatch task file at all", async () => {
    mkdirSync(stateDir(), { recursive: true });
    await writeGraph("solo-graph");

    const snap = readMonitorSnapshot(tmpDir);

    expect(snap.engineGraphs).toHaveLength(1);
    expect(snap.engineGraphs[0].graphId).toBe("solo-graph");
    // No dispatch activity to leak into the legacy surface.
    expect(snap.tasks).toEqual([]);
    expect(snap.dispatchSummary).toEqual({ pending: 0, running: 0, completed: 0, error: 0, cancelled: 0 });
  });

  it("reads durable graph events into graphEvents (chronological, most recent window)", async () => {
    mkdirSync(stateDir(), { recursive: true });
    await writeGraph();
    writeNDJSONFile("graph-events-aaa.ndjson", [
      { ts: 100, graphId: "demo-graph", event: "phase_change", status: "executing" },
      { ts: 200, graphId: "demo-graph", nodeId: "n1", event: "node_dispatched", status: "running", agent: "emperor--jinyiwei--backend", startedAt: 150 },
    ]);

    const snap = readMonitorSnapshot(tmpDir);
    expect(snap.graphEvents.map((e) => e.ts)).toEqual([100, 200]);
    expect(snap.graphEvents[1].event).toBe("node_dispatched");
    expect(snap.graphEvents[1].nodeId).toBe("n1");
  });
});

describe("readMonitorSnapshot — legacy surfaces unchanged", () => {
  it("keeps dispatch, activeFunctions, and loops live-filtered behavior", async () => {
    mkdirSync(stateDir(), { recursive: true });
    writeStateFile("dispatch-x.json", JSON.stringify(buildDispatchFile()));
    writeStateFile("fnstate-x.json", JSON.stringify(buildFnStateFile()));
    writeStateFile("loops-x.json", JSON.stringify(buildLoopsFile()));
    await writeGraph();

    const snap = readMonitorSnapshot(tmpDir);

    // Legacy dispatch surface.
    expect(snap.tasks).toHaveLength(1);
    expect(snap.activeFunctions).toHaveLength(1);
    expect(snap.activeFunctions[0].name).toBe("buildSomething");
    expect(snap.activeFunctions[0].agentId).toBe("emperor--jinyiwei--backend");

    // Legacy loops cross-filtered by liveSessions.
    expect(snap.loops).toHaveLength(1);
    expect(snap.loops[0].originSessionId).toBe("engine-session-1");
    // Legacy graph sessions are no longer sourced from graph- files.
    expect(snap.graphSessions).toEqual([]);

    // Engine graph still surfaced alongside the legacy surfaces.
    expect(snap.engineGraphs).toHaveLength(1);
    expect(snap.engineGraphs[0].graphId).toBe("demo-graph");
  });

  it("filters legacy loops to live sessions while keeping engine graphs", async () => {
    mkdirSync(stateDir(), { recursive: true });
    // Engine graph with a live-ish node, plus a legacy loop file whose
    // session is NOT live (no dispatch task running).
    await writeGraph();
    writeStateFile("loops-x.json", JSON.stringify(buildLoopsFile()));

    const snap = readMonitorSnapshot(tmpDir);

    // Legacy surfaces cross-filtered to live sessions → dropped (no live task).
    expect(snap.tasks).toEqual([]);
    expect(snap.activeFunctions).toEqual([]);
    expect(snap.loops).toEqual([]);
    expect(snap.graphSessions).toEqual([]);

    // Engine graphs are NOT filtered by liveSessions → still surfaced.
    expect(snap.engineGraphs).toHaveLength(1);
    expect(snap.engineGraphs[0].graphId).toBe("demo-graph");
  });
});

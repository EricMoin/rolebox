import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock state-hash to return a predictable value
mock.module("../../../src/cli/state-hash", () => ({
  stateFileHash: () => "testhash123456",
}));

const KNOWN_HASH = "testhash123456";
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-reader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, ".rolebox", "state");
}

async function importReader() {
  return await import("../../../src/cli/commands/monitor-reader");
}

describe("readMonitorSnapshot", () => {
  it("returns empty state when no files exist", async () => {
    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.projectDir).toBe(tmpDir);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.activeFunctions).toEqual([]);
    expect(() => new Date(snapshot.timestamp)).not.toThrow();
    expect(new Date(snapshot.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("reads a mix of running, completed, and error tasks", async () => {
    const now = Date.now();
    mkdirSync(stateDir(), { recursive: true });

    const dispatchTasks = [
      {
        id: "t1",
        sessionId: "ses_1",
        parentSessionId: "ses_p",
        status: "running",
        agent: "emperor--chancellor",
        description: "Global planning",
        prompt: "plan the work",
        startedAt: new Date(now - 32000).toISOString(),
        progress: { lastUpdate: new Date().toISOString(), toolCalls: 5 },
        depth: 0,
        mode: "background",
      },
      {
        id: "t2",
        sessionId: "ses_2",
        parentSessionId: "ses_p",
        status: "completed",
        agent: "emperor--jinyiwei",
        description: "Login module",
        prompt: "implement login",
        startedAt: new Date(now - 135000).toISOString(),
        completedAt: new Date(now - 5000).toISOString(),
        progress: { lastUpdate: new Date().toISOString(), toolCalls: 10 },
        depth: 0,
        mode: "background",
      },
      {
        id: "t3",
        sessionId: "ses_3",
        parentSessionId: "ses_p",
        status: "error",
        agent: "emperor--chancellor",
        description: "Tech selection",
        prompt: "select tech",
        startedAt: new Date(now - 64000).toISOString(),
        completedAt: new Date(now - 1000).toISOString(),
        error: "context length exceeded",
        progress: { lastUpdate: new Date().toISOString(), toolCalls: 3 },
        depth: 1,
        mode: "background",
      },
    ];

    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({ version: 5, tasks: dispatchTasks }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.tasks.length).toBe(3);

    // Running task
    const running = snapshot.tasks.find((t) => t.id === "t1")!;
    expect(running.status).toBe("running");
    expect(running.agent).toBe("emperor--chancellor");
    expect(running.description).toBe("Global planning");
    expect(running.depth).toBe(0);
    expect(running.mode).toBe("background");
    expect(running.error).toBeUndefined();
    expect(running.durationMs).toBeGreaterThan(30000);

    // Completed task
    const completed = snapshot.tasks.find((t) => t.id === "t2")!;
    expect(completed.status).toBe("completed");
    expect(completed.agent).toBe("emperor--jinyiwei");
    expect(completed.description).toBe("Login module");
    expect(completed.durationMs).toBeGreaterThan(100000);

    // Error task
    const errorTask = snapshot.tasks.find((t) => t.id === "t3")!;
    expect(errorTask.status).toBe("error");
    expect(errorTask.error).toBe("context length exceeded");
    expect(errorTask.depth).toBe(1);
  });

  it("resolves active functions with agentId from graph", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Dispatch file — provides sessionAgentMap for ses_graph
    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_graph",
            parentSessionId: "ses_p",
            status: "running",
            agent: "researcher",
            prompt: "research",
            startedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 1 },
            depth: 0,
            mode: "background",
          },
        ],
      }),
    );

    // FnState file — ses_graph has active fn, ses_unknown has active fn, ses_done has complete fn
    writeFileSync(
      join(stateDir(), `fnstate-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_graph",
            fns: [{ name: "analyze", state: { phase: "active", continuationCount: 3 } }],
          },
          {
            sessionId: "ses_unknown",
            fns: [{ name: "think", state: { phase: "active", continuationCount: 1 } }],
          },
          {
            sessionId: "ses_done",
            fns: [{ name: "old", state: { phase: "complete", continuationCount: 5 } }],
          },
        ],
      }),
    );

    // Graph file — maps ses_graph to "researcher"
    writeFileSync(
      join(stateDir(), `graph-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_graph",
            agentId: "researcher",
            state: { frontier: [], completed: [], iterationCount: 0, status: "active" },
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.activeFunctions.length).toBe(2);

    const graphFn = snapshot.activeFunctions.find((f) => f.sessionId === "ses_graph")!;
    expect(graphFn.agentId).toBe("researcher");
    expect(graphFn.name).toBe("analyze");
    expect(graphFn.phase).toBe("active");
    expect(graphFn.continuationCount).toBe(3);

    const unknownFn = snapshot.activeFunctions.find((f) => f.sessionId === "ses_unknown")!;
    expect(unknownFn.agentId).toBeNull();
    expect(unknownFn.name).toBe("think");
    expect(unknownFn.continuationCount).toBe(1);

    // ses_done should not appear (phase is "complete")
    expect(snapshot.activeFunctions.find((f) => f.sessionId === "ses_done")).toBeUndefined();
  });

  it("resolves agentId from dispatch when graph file is missing", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Dispatch file — provides sessionAgentMap for ses_graph
    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_graph",
            parentSessionId: "ses_p",
            status: "running",
            agent: "researcher",
            prompt: "research",
            startedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 1 },
            depth: 0,
            mode: "background",
          },
        ],
      }),
    );

    // FnState file (same as TC3 but without graph)
    writeFileSync(
      join(stateDir(), `fnstate-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_graph",
            fns: [{ name: "analyze", state: { phase: "active", continuationCount: 3 } }],
          },
          {
            sessionId: "ses_unknown",
            fns: [{ name: "think", state: { phase: "active", continuationCount: 1 } }],
          },
          {
            sessionId: "ses_done",
            fns: [{ name: "old", state: { phase: "complete", continuationCount: 5 } }],
          },
        ],
      }),
    );

    // No graph file at all

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.activeFunctions.length).toBe(2);

    const graphFn = snapshot.activeFunctions.find((f) => f.sessionId === "ses_graph")!;
    expect(graphFn.agentId).toBe("researcher"); // resolved from dispatch

    const unknownFn = snapshot.activeFunctions.find((f) => f.sessionId === "ses_unknown")!;
    expect(unknownFn.agentId).toBeNull(); // not in dispatch, not in graph
  });

  it("returns empty tasks on malformed dispatch JSON", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      "not valid json{{{",
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.activeFunctions).toEqual([]);
  });

  it("returns empty activeFunctions when all fnstate phases are non-active", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Valid dispatch with 1 running task
    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_run",
            parentSessionId: "ses_p",
            status: "running",
            agent: "researcher",
            prompt: "work",
            startedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 1 },
            depth: 0,
            mode: "background",
          },
        ],
      }),
    );

    // FnState with only complete/gated phases
    writeFileSync(
      join(stateDir(), `fnstate-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_run",
            fns: [{ name: "analyze", state: { phase: "complete", continuationCount: 3 } }],
          },
          {
            sessionId: "ses_other",
            fns: [{ name: "think", state: { phase: "gated", continuationCount: 1 } }],
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.tasks.length).toBe(1);
    expect(snapshot.tasks[0].id).toBe("t1");
    expect(snapshot.activeFunctions).toEqual([]);
  });
});

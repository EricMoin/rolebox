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
  return await import("../../../src/cli/commands/monitor/monitor-reader");
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

    expect(snapshot.activeFunctions.length).toBe(1);

    const graphFn = snapshot.activeFunctions.find((f) => f.sessionId === "ses_graph")!;
    expect(graphFn.agentId).toBe("researcher");
    expect(graphFn.name).toBe("analyze");
    expect(graphFn.phase).toBe("active");
    expect(graphFn.continuationCount).toBe(3);

    // ses_unknown should NOT appear (no running dispatch task for it)
    expect(snapshot.activeFunctions.find((f) => f.sessionId === "ses_unknown")).toBeUndefined();

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

    expect(snapshot.activeFunctions.length).toBe(1);

    const graphFn = snapshot.activeFunctions.find((f) => f.sessionId === "ses_graph")!;
    expect(graphFn.agentId).toBe("researcher"); // resolved from dispatch

    // ses_unknown should NOT appear (no running dispatch task for it)
    expect(snapshot.activeFunctions.find((f) => f.sessionId === "ses_unknown")).toBeUndefined();
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

  it("populates resultPreview when tailChars > 0 and sidecar exists", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const fullOutput = "Hello world, this is a long task output with many characters.";
    writeFileSync(join(resultsDir, "t1.txt"), fullOutput);

    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_1",
            parentSessionId: "ses_p",
            status: "completed",
            agent: "researcher",
            prompt: "research",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 3 },
            depth: 0,
            mode: "background",
            result: {
              sidecarPath: join(resultsDir, "t1.txt"),
              totalChars: fullOutput.length,
              hadFence: false,
              materializedAt: Date.now(),
            },
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();

    // With tailChars=20, should get last 20 chars
    const snapshot = readMonitorSnapshot(tmpDir, 20);
    const task = snapshot.tasks[0];
    expect(task.resultPreview).toBe(fullOutput.slice(-20));
    expect(task.resultTotalChars).toBe(fullOutput.length);

    // With tailChars=0 (default), no preview
    const snapshotNoTail = readMonitorSnapshot(tmpDir);
    expect(snapshotNoTail.tasks[0].resultPreview).toBeUndefined();
    expect(snapshotNoTail.tasks[0].resultTotalChars).toBeUndefined();

    // With tailChars larger than content, returns full content
    const snapshotFull = readMonitorSnapshot(tmpDir, 9999);
    expect(snapshotFull.tasks[0].resultPreview).toBe(fullOutput);
  });

  it("resultPreview is undefined when sidecar file is missing", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_1",
            parentSessionId: "ses_p",
            status: "completed",
            agent: "researcher",
            prompt: "research",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 3 },
            depth: 0,
            mode: "background",
            result: {
              sidecarPath: "/nonexistent/path/t1.txt",
              totalChars: 100,
              hadFence: false,
              materializedAt: Date.now(),
            },
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir, 50);
    expect(snapshot.tasks[0].resultPreview).toBeUndefined();
    expect(snapshot.tasks[0].resultTotalChars).toBe(100);
  });

  it("resultPreview falls back to rebuilt path when sidecarPath is empty", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const fullOutput = "Fallback content that should be found via rebuilt path.";
    writeFileSync(join(resultsDir, "t1.txt"), fullOutput);

    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_1",
            parentSessionId: "ses_p",
            status: "completed",
            agent: "researcher",
            prompt: "research",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 3 },
            depth: 0,
            mode: "background",
            result: {
              sidecarPath: "",
              totalChars: fullOutput.length,
              hadFence: false,
              materializedAt: Date.now(),
            },
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir, 20);
    const task = snapshot.tasks[0];
    expect(task.resultPreview).toBe(fullOutput.slice(-20));
    expect(task.resultTotalChars).toBe(fullOutput.length);
  });

  it("resultPreview falls back to rebuilt path when result field is missing", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const fullOutput = "Output found via rebuilt path without result field.";
    writeFileSync(join(resultsDir, "t1.txt"), fullOutput);

    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_1",
            parentSessionId: "ses_p",
            status: "completed",
            agent: "researcher",
            prompt: "research",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 3 },
            depth: 0,
            mode: "background",
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir, 20);
    const task = snapshot.tasks[0];
    expect(task.resultPreview).toBe(fullOutput.slice(-20));
    expect(task.resultTotalChars).toBe(fullOutput.length);
  });

  it("filters only complete-phase functions; gated and active are included", async () => {
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
          },
          {
            id: "t2",
            sessionId: "ses_other",
            parentSessionId: "ses_p",
            status: "running",
            agent: "researcher",
            prompt: "more work",
            startedAt: new Date().toISOString(),
            progress: { lastUpdate: new Date().toISOString(), toolCalls: 1 },
            depth: 0,
            mode: "background",
          },
        ]
      }),
    );

    // FnState with complete (filtered), gated (included), and active (included)
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
            fns: [
              { name: "think", state: { phase: "gated", continuationCount: 1 } },
              { name: "act", state: { phase: "active", continuationCount: 0 } },
            ],
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.tasks.length).toBe(2);
    expect(snapshot.tasks.find((t) => t.id === "t1")).toBeDefined();
    // "complete" is filtered out; "gated" and "active" are included.
    expect(snapshot.activeFunctions.length).toBe(2);
    expect(snapshot.activeFunctions.map((f) => f.name).sort()).toEqual(["act", "think"]);
    expect(snapshot.activeFunctions.every((f) => f.phase !== "complete")).toBe(true);
  });

  it("backward compat: snapshot without metrics file still returns valid snapshot", async () => {
    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.projectDir).toBe(tmpDir);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.activeFunctions).toEqual([]);
    // New optional fields should be undefined when no data exists
    expect(snapshot.metrics).toBeUndefined();
    expect(snapshot.metricsRecentEvents).toBeUndefined();
    expect(snapshot.notifications).toBeUndefined();
  });

  it("readMonitorSnapshot includes metrics + notifications when present", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Write a metrics file
    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: {
          counters: { dispatch_rejected_total: { value: 3 } },
          gauges: { inflight_tasks: { value: 2 } },
          histograms: {},
        },
      }),
    );

    // Write a notifications state file
    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        enabled: true,
        quietHours: { enabled: false, ranges: [] },
        throttle: { windowMs: 3000, maxPerWindow: 3 },
        recentEvents: [
          { ts: new Date().toISOString(), type: "dispatch_complete" },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.metrics).toBeDefined();
    expect(snapshot.metrics!.counters.dispatch_rejected_total.value).toBe(3);
    expect(snapshot.metrics!.gauges.inflight_tasks.value).toBe(2);

    expect(snapshot.notifications).toBeDefined();
    expect(snapshot.notifications!.enabled).toBe(true);
    expect(snapshot.notifications!.quietHoursActive).toBe(false);
    expect(snapshot.notifications!.recentEvents.length).toBe(1);
    expect(snapshot.notifications!.recentEvents[0].type).toBe("dispatch_complete");
    expect(snapshot.notifications!.throttleStats).toBeDefined();
    expect(snapshot.notifications!.throttleStats!.windowMs).toBe(3000);
  });

  it("filters out stale functions/graphs when all tasks are completed", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // All tasks are completed — no live sessions
    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t1",
            sessionId: "ses_done",
            parentSessionId: "ses_p",
            status: "completed",
            agent: "researcher",
            startedAt: new Date(Date.now() - 100000).toISOString(),
            completedAt: new Date(Date.now() - 50000).toISOString(),
            depth: 0,
            mode: "background",
          },
        ],
      }),
    );

    // Stale fnstate data with non-complete functions
    writeFileSync(
      join(stateDir(), `fnstate-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_done",
            fns: [{ name: "staleFn", state: { phase: "active", continuationCount: 1 } }],
          },
        ],
      }),
    );

    // Stale graph data with "active" status
    writeFileSync(
      join(stateDir(), `graph-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_done",
            agentId: "researcher",
            state: { frontier: [], completed: [], iterationCount: 1, status: "active" },
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    // Active functions should be empty (no live tasks)
    expect(snapshot.activeFunctions).toEqual([]);
    // Graph sessions should be filtered out (no live tasks)
    expect(snapshot.graphSessions).toEqual([]);
  });

  it("filters functions/graphs by live dispatch task sessions", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // One running task and one completed task
    writeFileSync(
      join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 5,
        tasks: [
          {
            id: "t_running",
            sessionId: "ses_active",
            parentSessionId: "ses_p",
            status: "running",
            agent: "researcher",
            startedAt: new Date().toISOString(),
            depth: 0,
            mode: "background",
          },
          {
            id: "t_completed",
            sessionId: "ses_done",
            parentSessionId: "ses_p",
            status: "completed",
            agent: "researcher",
            startedAt: new Date(Date.now() - 100000).toISOString(),
            completedAt: new Date(Date.now() - 50000).toISOString(),
            depth: 0,
            mode: "background",
          },
        ],
      }),
    );

    writeFileSync(
      join(stateDir(), `fnstate-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_active",
            fns: [{ name: "liveFn", state: { phase: "active", continuationCount: 2 } }],
          },
          {
            sessionId: "ses_done",
            fns: [{ name: "staleFn", state: { phase: "active", continuationCount: 1 } }],
          },
        ],
      }),
    );

    writeFileSync(
      join(stateDir(), `graph-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "ses_active",
            agentId: "researcher",
            state: { frontier: [], completed: [], iterationCount: 0, status: "active" },
          },
          {
            sessionId: "ses_done",
            agentId: "researcher",
            state: { frontier: [], completed: [], iterationCount: 2, status: "active" },
          },
        ],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    // Only the function from ses_active should appear
    expect(snapshot.activeFunctions.length).toBe(1);
    expect(snapshot.activeFunctions[0].sessionId).toBe("ses_active");
    expect(snapshot.activeFunctions[0].name).toBe("liveFn");

    // Only the graph session from ses_active should appear
    expect(snapshot.graphSessions.length).toBe(1);
    expect(snapshot.graphSessions[0].sessionId).toBe("ses_active");
    expect(snapshot.graphSessions[0].status).toBe("active");
  });
});

describe("readMetricsSnapshot", () => {
  it("returns metrics from valid metrics file", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: {
          counters: { test_counter: { value: 42 } },
          gauges: { test_gauge: { value: 7 } },
          histograms: { test_hist: { buckets: { "100": 5, "500": 3 }, sum: 800, count: 8 } },
        },
      }),
    );

    const { readMetricsSnapshot } = await importReader();
    const result = readMetricsSnapshot(stateDir());

    expect(result).not.toBeNull();
    expect(result!.counters.test_counter.value).toBe(42);
    expect(result!.gauges.test_gauge.value).toBe(7);
    expect(result!.histograms.test_hist.count).toBe(8);
  });

  it("returns null when no metrics file exists", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const { readMetricsSnapshot } = await importReader();
    const result = readMetricsSnapshot(stateDir());
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      "not valid json{{{",
    );

    const { readMetricsSnapshot } = await importReader();
    const result = readMetricsSnapshot(stateDir());
    expect(result).toBeNull();
  });

  it("returns null when metrics field is missing from file", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({ version: 1, timestamp: new Date().toISOString() }),
    );

    const { readMetricsSnapshot } = await importReader();
    const result = readMetricsSnapshot(stateDir());
    expect(result).toBeNull();
  });

  it("reads NDJSON event log and returns recent events", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Write metrics JSON (needed for the snapshot to not be null)
    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
      }),
    );

    // Write NDJSON event log with 3 lines
    const eventLines = [
      JSON.stringify({ ts: new Date(1000).toISOString(), counters: { c: { value: 1 } }, gauges: { g: { value: 2 } } }),
      JSON.stringify({ ts: new Date(2000).toISOString(), counters: { c: { value: 2 } }, gauges: { g: { value: 3 } } }),
      JSON.stringify({ ts: new Date(3000).toISOString(), counters: { c: { value: 3 } }, gauges: { g: { value: 4 } } }),
    ].join("\n") + "\n";

    writeFileSync(
      join(stateDir(), `metrics-events-${KNOWN_HASH}.ndjson`),
      eventLines,
    );

    const { readMetricsRecentEvents } = await importReader();
    const events = readMetricsRecentEvents(stateDir());

    expect(events.length).toBe(3);
    expect(events[0].counters).toBeDefined();
    expect(events[2].gauges).toBeDefined();
  });
});

describe("readRecoveryMetrics", () => {
  it("returns recovery metrics from valid metrics file with recovery key", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: {
          counters: { test: { value: 1 } },
          gauges: {},
          histograms: {},
        },
        recovery: {
          totalAttempts: 42,
          successfulRecoveries: 30,
          abortedChains: 5,
          exhaustedChains: 7,
          byCategory: {
            session_error: { attempts: 20, successes: 15 },
            json_error: { attempts: 10, successes: 8 },
          },
          byStrategy: {
            retry: { attempts: 25, successes: 20 },
            compact: { attempts: 5, successes: 3 },
          },
          errorTypeFrequency: {
            ContextLengthExceeded: 10,
            JSONParseError: 5,
          },
        },
      }),
    );

    const { readRecoveryMetrics } = await importReader();
    const result = readRecoveryMetrics(stateDir());

    expect(result).not.toBeNull();
    expect(result!.totalAttempts).toBe(42);
    expect(result!.successfulRecoveries).toBe(30);
    expect(result!.abortedChains).toBe(5);
    expect(result!.exhaustedChains).toBe(7);
    expect(result!.byCategory.session_error.attempts).toBe(20);
    expect(result!.byStrategy.retry.attempts).toBe(25);
    expect(result!.errorTypeFrequency.ContextLengthExceeded).toBe(10);
  });

  it("returns null when no metrics file exists", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const { readRecoveryMetrics } = await importReader();
    const result = readRecoveryMetrics(stateDir());
    expect(result).toBeNull();
  });

  it("returns null when metrics file has no recovery key", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
      }),
    );

    const { readRecoveryMetrics } = await importReader();
    const result = readRecoveryMetrics(stateDir());
    expect(result).toBeNull();
  });

  it("returns null on malformed recovery data (missing fields)", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
        recovery: { totalAttempts: "not-a-number" },
      }),
    );

    const { readRecoveryMetrics } = await importReader();
    const result = readRecoveryMetrics(stateDir());
    expect(result).toBeNull();
  });

  it("returns null when recovery field is not an object", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
        recovery: "just a string",
      }),
    );

    const { readRecoveryMetrics } = await importReader();
    const result = readRecoveryMetrics(stateDir());
    expect(result).toBeNull();
  });

  it("readMonitorSnapshot includes recovery data when present", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
        recovery: {
          totalAttempts: 10,
          successfulRecoveries: 6,
          abortedChains: 2,
          exhaustedChains: 2,
          byCategory: {},
          byStrategy: {},
          errorTypeFrequency: {},
        },
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.recovery).toBeDefined();
    expect(snapshot.recovery!.totalAttempts).toBe(10);
    expect(snapshot.recovery!.successfulRecoveries).toBe(6);
  });

  it("readMonitorSnapshot does not include recovery when absent", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Write a valid metrics file without recovery key
    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.recovery).toBeUndefined();
  });
});


describe("readNotificationState", () => {
  it("returns notification state when file is present", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        enabled: true,
        quietHours: { enabled: true, ranges: [{ start: "22:00", end: "07:00" }] },
        throttle: { windowMs: 5000, maxPerWindow: 5 },
        recentEvents: [
          { ts: new Date().toISOString(), type: "idle" },
        ],
      }),
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());

    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.quietHoursActive).toBe(true);
    expect(result!.recentEvents.length).toBe(1);
    expect(result!.recentEvents[0].type).toBe("idle");
    expect(result!.throttleStats).toBeDefined();
    expect(result!.throttleStats!.windowMs).toBe(5000);
    expect(result!.throttleStats!.recentCount).toBe(5);
  });

  it("returns null when no notification file exists", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      "not valid json{{{",
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());
    expect(result).toBeNull();
  });

  it("handles non-object JSON gracefully", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify("just a string"),
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());
    expect(result).toBeNull();
  });
});

describe("readTaskDetail", () => {
  it("returns task detail for existing sidecar", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "This is a task result with some content for testing.";
    writeFileSync(join(resultsDir, "task-123.txt"), content);

    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "task-123");

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe(content);
    expect(detail!.totalChars).toBe(content.length);
    expect(detail!.offset).toBe(0);
    expect(detail!.truncated).toBe(false);
    expect(detail!.task.id).toBe("task-123");
    expect(detail!.task.resultFullText).toBe(content);
    expect(detail!.task.resultTotalChars).toBe(content.length);
  });

  it("returns null when sidecar file is missing", async () => {
    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "nonexistent-task");
    expect(detail).toBeNull();
  });

  it("applies offset/limit for pagination", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "0123456789ABCDEF";
    writeFileSync(join(resultsDir, "paginated-task.txt"), content);

    const { readTaskDetail } = await importReader();

    // offset=5, limit=5
    const detail = readTaskDetail(tmpDir, "paginated-task", 5, 5);
    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("56789");
    expect(detail!.offset).toBe(5);
    expect(detail!.limit).toBe(5);
    expect(detail!.totalChars).toBe(content.length);
    expect(detail!.truncated).toBe(true);
  });

  it("returns empty string when offset exceeds content length", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "Short content";
    writeFileSync(join(resultsDir, "offset-beyond.txt"), content);

    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "offset-beyond", 999);

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("");
    expect(detail!.truncated).toBe(false);
    expect(detail!.totalChars).toBe(content.length);
  });

  it("limit larger than remaining text returns only remaining", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "Hello World Test";
    writeFileSync(join(resultsDir, "limit-large.txt"), content);

    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "limit-large", 6, 999);

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("World Test");
    expect(detail!.offset).toBe(6);
    expect(detail!.limit).toBe(999);
    expect(detail!.totalChars).toBe(content.length);
    expect(detail!.truncated).toBe(false);
  });

  it("offset + limit exceeding text returns content from offset to end", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    writeFileSync(join(resultsDir, "offset-limit-exceed.txt"), content);

    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "offset-limit-exceed", 20, 20);

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("UVWXYZ");
    expect(detail!.offset).toBe(20);
    expect(detail!.limit).toBe(20);
    expect(detail!.totalChars).toBe(content.length);
    expect(detail!.truncated).toBe(false);
  });
});

describe("readMetricsSnapshot (extended)", () => {
  it("returns metrics with all types populated (counters + gauges + histograms)", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: {
          counters: {
            dispatch_total: { value: 10 },
            dispatch_completed_total: { value: 7 },
            dispatch_error_total: { value: 2 },
          },
          gauges: {
            inflight_tasks: { value: 3 },
            concurrency_queued: { value: 1 },
            concurrency_active: { value: 2 },
            concurrency_limit: { value: 5 },
          },
          histograms: {
            task_duration_ms: { buckets: { "100": 5, "500": 3, "1000": 1 }, sum: 1200, count: 9 },
            queue_wait_ms: { buckets: { "50": 8, "100": 4, "250": 1 }, sum: 350, count: 13 },
          },
        },
      }),
    );

    const { readMetricsSnapshot } = await importReader();
    const result = readMetricsSnapshot(stateDir());

    expect(result).not.toBeNull();
    expect(Object.keys(result!.counters).length).toBe(3);
    expect(result!.counters.dispatch_total.value).toBe(10);
    expect(result!.counters.dispatch_completed_total.value).toBe(7);
    expect(Object.keys(result!.gauges).length).toBe(4);
    expect(result!.gauges.inflight_tasks.value).toBe(3);
    expect(Object.keys(result!.histograms).length).toBe(2);
    expect(result!.histograms.task_duration_ms.count).toBe(9);
    expect(result!.histograms.task_duration_ms.sum).toBe(1200);
    expect(result!.histograms.queue_wait_ms.buckets["50"]).toBe(8);
  });
});

describe("readMetricsRecentEvents (extended)", () => {
  it("respects maxEventLines limit", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Write metrics JSON (needed for the snapshot to not be null)
    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
      }),
    );

    const eventLines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ ts: new Date(i * 1000).toISOString(), counters: { c: { value: i } }, gauges: { g: { value: i } } }),
    ).join("\n") + "\n";

    writeFileSync(
      join(stateDir(), `metrics-events-${KNOWN_HASH}.ndjson`),
      eventLines,
    );

    const { readMetricsRecentEvents } = await importReader();
    const events = readMetricsRecentEvents(stateDir(), 10);

    expect(events.length).toBe(10);
    // Should be the last 10 events
    expect(events[0].counters).toBeDefined();
    // Last event should have the highest counter value
    const lastVal = (events[events.length - 1].counters as Record<string, { value: number }>).c.value;
    expect(lastVal).toBe(99);
  });

  it("skips malformed lines and returns only valid JSON", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: { counters: {}, gauges: {}, histograms: {} },
      }),
    );

    const eventLines = [
      JSON.stringify({ ts: new Date(1000).toISOString(), counters: { c: { value: 1 } }, gauges: {} }),
      "this is not json{{{",
      "",
      JSON.stringify({ ts: new Date(2000).toISOString(), counters: { c: { value: 2 } }, gauges: {} }),
      "also bad",
      JSON.stringify({ ts: new Date(3000).toISOString(), counters: { c: { value: 3 } }, gauges: {} }),
    ].join("\n") + "\n";

    writeFileSync(
      join(stateDir(), `metrics-events-${KNOWN_HASH}.ndjson`),
      eventLines,
    );

    const { readMetricsRecentEvents } = await importReader();
    const events = readMetricsRecentEvents(stateDir(), 20);

    expect(events.length).toBe(3);
    expect(events[0].counters).toBeDefined();
    expect(events[1].counters).toBeDefined();
    expect(events[2].counters).toBeDefined();
  });

  it("returns empty array when no NDJSON file exists", async () => {
    mkdirSync(stateDir(), { recursive: true });
    const { readMetricsRecentEvents } = await importReader();
    const events = readMetricsRecentEvents(stateDir());
    expect(events).toEqual([]);
  });
});

describe("readNotificationState (extended)", () => {
  it("returns notification with partial fields (missing throttle)", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        enabled: true,
        quietHours: { enabled: false, ranges: [] },
        recentEvents: [],
      }),
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());

    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.quietHoursActive).toBe(false);
    expect(result!.throttleStats).toBeUndefined();
    expect(result!.recentEvents).toEqual([]);
  });

  it("returns notification with all fields populated", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        enabled: true,
        quietHours: { enabled: true, ranges: [{ start: "22:00", end: "07:00" }] },
        throttle: { windowMs: 3000, maxPerWindow: 5 },
        recentEvents: [
          { ts: "2025-01-01T00:00:00.000Z", type: "start" },
          { ts: "2025-01-01T01:00:00.000Z", type: "complete" },
          { ts: "2025-01-01T02:00:00.000Z", type: "error" },
        ],
      }),
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());

    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.quietHoursActive).toBe(true);
    expect(result!.throttleStats).toBeDefined();
    expect(result!.throttleStats!.recentCount).toBe(5);
    expect(result!.throttleStats!.windowMs).toBe(3000);
    expect(result!.recentEvents.length).toBe(3);
    expect(result!.recentEvents[0].type).toBe("start");
    expect(result!.recentEvents[2].type).toBe("error");
  });

  it("returns notification with default enabled when field is missing", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        quietHours: { enabled: false },
        recentEvents: [],
      }),
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());

    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true); // default
    expect(result!.quietHoursActive).toBe(false);
  });

  it("skips malformed recent events in notification file", async () => {
    mkdirSync(stateDir(), { recursive: true });

    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        enabled: true,
        recentEvents: [
          { ts: "2025-01-01T00:00:00.000Z", type: "good" },
          { ts: "2025-01-01T01:00:00.000Z" }, // missing type
          { type: "no-ts" }, // missing ts
          "just a string",
          42,
        ],
      }),
    );

    const { readNotificationState } = await importReader();
    const result = readNotificationState(stateDir());

    expect(result).not.toBeNull();
    expect(result!.recentEvents.length).toBe(1);
    expect(result!.recentEvents[0].type).toBe("good");
  });
});

describe("readTaskDetail (extended)", () => {
  it("returns offset beyond text length gracefully", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "Hello";
    writeFileSync(join(resultsDir, "offset-past-end.txt"), content);

    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "offset-past-end", 100);

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("");
    expect(detail!.totalChars).toBe(content.length);
    expect(detail!.offset).toBe(100);
    expect(detail!.truncated).toBe(false);
  });

  it("limit larger than total text returns full text from offset", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "Short";
    writeFileSync(join(resultsDir, "limit-over.txt"), content);

    const { readTaskDetail } = await importReader();
    const detail = readTaskDetail(tmpDir, "limit-over", 0, 9999);

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("Short");
    expect(detail!.totalChars).toBe(5);
    expect(detail!.truncated).toBe(false);
  });

  it("offset + limit exceeding text returns window", async () => {
    const resultsDir = join(stateDir(), "results");
    mkdirSync(resultsDir, { recursive: true });

    const content = "A quick brown fox jumps over the lazy dog";
    writeFileSync(join(resultsDir, "offset-limit-window.txt"), content);

    const { readTaskDetail } = await importReader();
    // offset=20, limit=50 but text is only 42 chars — should return chars 20..41
    const detail = readTaskDetail(tmpDir, "offset-limit-window", 20, 50);

    expect(detail).not.toBeNull();
    expect(detail!.fullText).toBe("mps over the lazy dog");
    expect(detail!.offset).toBe(20);
    expect(detail!.totalChars).toBe(content.length);
    expect(detail!.truncated).toBe(false);
  });

  it("readMonitorSnapshot includes metrics + events + notifications when present", async () => {
    mkdirSync(stateDir(), { recursive: true });

    // Write a metrics file
    writeFileSync(
      join(stateDir(), `metrics-${KNOWN_HASH}.json`),
      JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        metrics: {
          counters: { dispatch_total: { value: 5 } },
          gauges: { inflight_tasks: { value: 1 } },
          histograms: { task_duration_ms: { buckets: { "100": 1 }, sum: 50, count: 1 } },
        },
      }),
    );

    // Write NDJSON events
    const eventContent = JSON.stringify({ ts: new Date().toISOString(), counters: { c: { value: 1 } }, gauges: {} }) + "\n";
    writeFileSync(
      join(stateDir(), `metrics-events-${KNOWN_HASH}.ndjson`),
      eventContent,
    );

    // Write notifications
    writeFileSync(
      join(stateDir(), `notifications-${KNOWN_HASH}.json`),
      JSON.stringify({
        enabled: true,
        quietHours: { enabled: false },
        recentEvents: [{ ts: new Date().toISOString(), type: "test" }],
      }),
    );

    const { readMonitorSnapshot } = await importReader();
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.metrics).toBeDefined();
    expect(snapshot.metrics!.counters.dispatch_total.value).toBe(5);
    expect(snapshot.metricsRecentEvents).toBeDefined();
    expect(snapshot.metricsRecentEvents!.length).toBe(1);
    expect(snapshot.notifications).toBeDefined();
    expect(snapshot.notifications!.enabled).toBe(true);
  });
});

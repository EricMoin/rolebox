import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock state-hash for predictable filenames (same pattern as monitor-reader.test.ts)
mock.module("../../../src/cli/state-hash", () => ({
  stateFileHash: () => "testhash123456",
}));

const KNOWN_HASH = "testhash123456";
let tmpDir: string;
let origCwd: string;

function stateDir(): string {
  return join(tmpDir, "rolebox", "state");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-cmd-test-"));
  process.env.XDG_DATA_HOME = tmpDir;
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────

function captureLogs(
  fn: () => Promise<void>,
): { logs: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  return {
    logs,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
      }
    },
  };
}

async function importMonitor() {
  return await import("../../../src/cli/commands/monitor");
}

function writeDispatch(tasks: unknown[]) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    join(stateDir(), `dispatch-${KNOWN_HASH}.json`),
    JSON.stringify({ version: 5, tasks }),
  );
}

function writeFnState(sessions: unknown[]) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    join(stateDir(), `fnstate-${KNOWN_HASH}.json`),
    JSON.stringify({ version: 1, sessions }),
  );
}

function makeTask(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
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
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("monitor", () => {
  it("shows header and empty state in default mode", async () => {
    const { monitor } = await importMonitor();
    const { logs, run } = captureLogs(() => monitor(false, false, false, 2000));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("rolebox monitor ·");
    expect(allOutput).toContain("No dispatch activity recorded.");
    expect(allOutput).toContain("No active functions.");
  });

  it("outputs valid JSON with --json flag", async () => {
    writeDispatch([makeTask()]);
    writeFnState([
      {
        sessionId: "s1",
        fns: [{ name: "analyze", state: { phase: "active", continuationCount: 2 } }],
      },
    ]);

    const { monitor } = await importMonitor();
    const { logs, run } = captureLogs(() => monitor(false, true, false, 2000));
    await run();

    const parsed = JSON.parse(logs[0]);
    expect(parsed).toHaveProperty("projectDir");
    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("tasks");
    expect(parsed).toHaveProperty("activeFunctions");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].status).toBe("running");
    expect(parsed.activeFunctions).toHaveLength(1);
  });

  it("shows only active tasks by default", async () => {
    writeDispatch([
      makeTask({ id: "t1", status: "running", description: "Global planning" }),
      makeTask({
        id: "t2",
        sessionId: "ses_2",
        status: "completed",
        agent: "emperor--jinyiwei",
        description: "Login module",
        startedAt: new Date(Date.now() - 135000).toISOString(),
        completedAt: new Date(Date.now() - 5000).toISOString(),
      }),
    ]);

    const { monitor } = await importMonitor();
    const { logs, run } = captureLogs(() => monitor(false, false, false, 2000));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("emperor--chancellor");
    expect(allOutput).not.toContain("emperor--jinyiwei");
  });

  it("shows all tasks with --all flag", async () => {
    writeDispatch([
      makeTask({ id: "t1", status: "running", description: "Global planning" }),
      makeTask({
        id: "t2",
        sessionId: "ses_2",
        status: "completed",
        agent: "emperor--jinyiwei",
        description: "Login module",
        startedAt: new Date(Date.now() - 135000).toISOString(),
        completedAt: new Date(Date.now() - 5000).toISOString(),
      }),
    ]);

    const { monitor } = await importMonitor();
    const { logs, run } = captureLogs(() => monitor(false, false, true, 2000));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("emperor--chancellor");
    expect(allOutput).toContain("emperor--jinyiwei");
  });

  it("shows error details for errored tasks", async () => {
    writeDispatch([
      makeTask({
        id: "t3",
        status: "error",
        sessionId: "ses_3",
        description: "Tech selection",
        startedAt: new Date(Date.now() - 64000).toISOString(),
        error: "context length exceeded",
        depth: 1,
      }),
    ]);

    const { monitor } = await importMonitor();
    const { logs, run } = captureLogs(() => monitor(false, false, false, 2000));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("context length exceeded");
  });

  it("outputs valid JSON for empty state", async () => {
    const { monitor } = await importMonitor();
    const { logs, run } = captureLogs(() => monitor(false, true, false, 2000));
    await run();

    const parsed = JSON.parse(logs[0]);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.activeFunctions).toEqual([]);
  });
});

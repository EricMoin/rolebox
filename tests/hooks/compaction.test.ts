import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleCompacting } from "../../src/hooks/compaction.ts";
import { readRuntimeState } from "../../src/hooks/state-reader.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "compaction-test-"));
}

function writeStateFile(stateDir: string, prefix: string, content: object): void {
  mkdirSync(stateDir, { recursive: true });
  // Use a fixed hash suffix for the test
  writeFileSync(join(stateDir, `${prefix}-testhash123.json`), JSON.stringify(content, null, 2), "utf-8");
}

// ── State Reader Tests ──────────────────────────────────────────────────────

describe("readRuntimeState", () => {
  it("returns empty state when .rolebox/state/ does not exist", () => {
    const dir = makeTempDir();
    try {
      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toEqual([]);
      expect(state.graphSessions).toEqual([]);
      expect(state.functionSessions).toEqual([]);
      expect(state.loops).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty state for an empty state directory", () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, ".rolebox", "state"), { recursive: true });
      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toEqual([]);
      expect(state.graphSessions).toEqual([]);
      expect(state.functionSessions).toEqual([]);
      expect(state.loops).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads dispatch tasks from state file", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", {
        version: 5,
        tasks: [
          {
            id: "bg_abc123",
            agent: "emperor--jinyiwei",
            status: "running",
            startedAt: "2026-07-04T10:30:00Z",
          },
          {
            id: "bg_def456",
            agent: "emperor--validator",
            status: "pending",
          },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toHaveLength(2);
      expect(state.dispatchTasks[0]).toEqual({
        id: "bg_abc123",
        agent: "emperor--jinyiwei",
        status: "running",
        startedAt: "2026-07-04T10:30:00Z",
      });
      expect(state.dispatchTasks[1]).toEqual({
        id: "bg_def456",
        agent: "emperor--validator",
        status: "pending",
        startedAt: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads graph sessions from state file", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "graph", {
        version: 2,
        sessions: [
          {
            sessionId: "sess_001",
            agentId: "emperor--chancellor",
            state: {
              frontier: ["step2"],
              completed: ["step1"],
              iterationCount: 1,
              status: "active",
              terminationReason: null,
            },
          },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.graphSessions).toHaveLength(1);
      expect(state.graphSessions[0]).toMatchObject({
        sessionId: "sess_001",
        agentId: "emperor--chancellor",
        frontierLength: 1,
        completedLength: 1,
        iterationCount: 1,
        status: "active",
        terminationReason: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads function state from fnstate file", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "fnstate", {
        version: 1,
        sessions: [
          {
            sessionId: "sess_001",
            fns: [
              { name: "plan", state: { phase: "active" } },
              { name: "execute", state: { phase: "complete" } },
            ],
          },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.functionSessions).toHaveLength(1);
      expect(state.functionSessions[0].sessionId).toBe("sess_001");
      expect(state.functionSessions[0].functions).toHaveLength(2);
      expect(state.functionSessions[0].functions[0]).toEqual({
        name: "plan",
        phase: "active",
      });
      expect(state.functionSessions[0].functions[1]).toEqual({
        name: "execute",
        phase: "complete",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads loop state from loops file", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "loops", {
        version: 1,
        loops: [
          {
            id: "loop_001",
            state: {
              agent: "emperor--chancellor",
              current: 2,
              total: 5,
              phase: "awaiting_worker",
            },
          },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.loops).toHaveLength(1);
      expect(state.loops[0]).toEqual({
        id: "loop_001",
        agent: "emperor--chancellor",
        current: 2,
        total: 5,
        phase: "awaiting_worker",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gracefully handles corrupt JSON in state files", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "dispatch-testhash123.json"),
        "this is not valid json",
        "utf-8",
      );
      writeFileSync(
        join(stateDir, "graph-testhash123.json"),
        "{invalid",
        "utf-8",
      );

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toEqual([]);
      expect(state.graphSessions).toEqual([]);
      expect(state.functionSessions).toEqual([]);
      expect(state.loops).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads all state types from a fully populated state directory", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", {
        version: 5,
        tasks: [{ id: "bg_1", agent: "agent-a", status: "running", startedAt: "2026-01-01T00:00:00Z" }],
      });
      writeStateFile(stateDir, "graph", {
        version: 2,
        sessions: [{ sessionId: "s1", agentId: "agent-b", state: { frontier: [], completed: [], iterationCount: 0, status: "complete" } }],
      });
      writeStateFile(stateDir, "fnstate", {
        version: 1,
        sessions: [{ sessionId: "s1", fns: [{ name: "fn1", state: { phase: "active" } }] }],
      });
      writeStateFile(stateDir, "loops", {
        version: 1,
        loops: [{ id: "l1", state: { agent: "agent-c", current: 1, total: 3, phase: "dispatching" } }],
      });

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toHaveLength(1);
      expect(state.graphSessions).toHaveLength(1);
      expect(state.functionSessions).toHaveLength(1);
      expect(state.loops).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Compaction Hook Tests ───────────────────────────────────────────────────

describe("handleCompacting", () => {
  it("injects runtime state context when state files exist", async () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", {
        version: 5,
        tasks: [{ id: "bg_abc123", agent: "emperor--jinyiwei", status: "running", startedAt: "2026-07-04T10:30:00Z" }],
      });
      writeStateFile(stateDir, "graph", {
        version: 2,
        sessions: [{ sessionId: "s1", agentId: "chancellor", state: { frontier: ["s2"], completed: ["s1"], iterationCount: 1, status: "active" } }],
      });
      writeStateFile(stateDir, "loops", {
        version: 1,
        loops: [{ id: "l1", state: { agent: "reviewer", current: 2, total: 5, phase: "awaiting_worker" } }],
      });

      const output = { context: [] as string[], prompt: undefined as string | undefined };
      await handleCompacting({ sessionID: "test-session" }, output, dir);

      expect(output.context).toHaveLength(1);
      const text = output.context[0];

      // Verify key content
      expect(text).toContain("## Rolebox Runtime State (preserve across compaction)");
      expect(text).toContain("bg_abc123");
      expect(text).toContain("emperor--jinyiwei");
      expect(text).toContain("running");
      expect(text).toContain("chancellor");
      expect(text).toContain("l1");
      expect(text).toContain("reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces no context when no state files exist", async () => {
    const dir = makeTempDir();
    try {
      const output = { context: [] as string[], prompt: undefined as string | undefined };
      await handleCompacting({ sessionID: "test-session" }, output, dir);

      expect(output.context).toEqual([]);
      expect(output.prompt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not crash on corrupt state files", async () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "dispatch-testhash123.json"), "corrupt json", "utf-8");
      writeFileSync(join(stateDir, "graph-testhash123.json"), "{invalid", "utf-8");

      const output = { context: [] as string[], prompt: undefined as string | undefined };
      await handleCompacting({ sessionID: "test-session" }, output, dir);

      // No crash — output context should be empty since both files are corrupt
      expect(output.context).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not modify output.prompt", async () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", {
        version: 5,
        tasks: [{ id: "bg_1", agent: "a", status: "running" }],
      });

      const output = { context: [] as string[], prompt: undefined as string | undefined };
      await handleCompacting({ sessionID: "test-session" }, output, dir);

      expect(output.prompt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

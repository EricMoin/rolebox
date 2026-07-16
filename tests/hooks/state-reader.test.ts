import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRuntimeState } from "../../src/hooks/state-reader.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "state-reader-test-"));
}

function writeStateFile(stateDir: string, prefix: string, content: object): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${prefix}-testhash123.json`), JSON.stringify(content, null, 2), "utf-8");
}

// ── Permission: defensive reading ────────────────────────────────────────────

describe("readRuntimeState — defensive / permission checks", () => {
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

  it("returns empty state for empty state directory", () => {
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

  it("gracefully handles corrupt JSON files", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "dispatch-test.json"), "not valid json", "utf-8");
      writeFileSync(join(stateDir, "graph-test.json"), "{invalid, json}", "utf-8");

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toEqual([]);
      expect(state.graphSessions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Dispatch state edge cases ────────────────────────────────────────────────

describe("readRuntimeState — dispatch state edges", () => {
  it("handles null tasks field", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", { version: 5, tasks: null });

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles tasks with missing fields", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", {
        version: 5,
        tasks: [
          { id: "t1" }, // no agent, status, startedAt
          { agent: "agent-a" }, // no id, status
          {}, // completely empty
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toHaveLength(3);
      expect(state.dispatchTasks[0].id).toBe("t1");
      expect(state.dispatchTasks[0].agent).toBe("unknown");
      expect(state.dispatchTasks[0].status).toBe("unknown");
      expect(state.dispatchTasks[0].startedAt).toBeUndefined();
      expect(state.dispatchTasks[1].id).toBe("unknown");
      expect(state.dispatchTasks[2].id).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Graph state edge cases ───────────────────────────────────────────────────

describe("readRuntimeState — graph state edges", () => {
  it("handles null sessions field", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "graph", { version: 2, sessions: null });

      const state = readRuntimeState(dir);
      expect(state.graphSessions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles sessions with null state", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "graph", {
        version: 2,
        sessions: [
          { sessionId: "s1", agentId: "a", state: null },
          { sessionId: "s2", agentId: "b", state: { frontier: [], completed: [], iterationCount: 0 } },
        ],
      });

      const state = readRuntimeState(dir);
      // null state sessions should be filtered out
      expect(state.graphSessions).toHaveLength(1);
      expect(state.graphSessions[0].sessionId).toBe("s2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles sessions with missing fields", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "graph", {
        version: 2,
        sessions: [
          { sessionId: "s1", agentId: "a", state: { frontier: null, completed: null } },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.graphSessions).toHaveLength(1);
      expect(state.graphSessions[0].frontierLength).toBe(0);
      expect(state.graphSessions[0].completedLength).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles sessions with unknown status", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "graph", {
        version: 2,
        sessions: [
          { sessionId: "s1", agentId: "a", state: { frontier: [], completed: [], iterationCount: 0, status: "unknown_really" } },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.graphSessions).toHaveLength(1);
      // Unknown status should get a fallback emoji
      expect(state.graphSessions[0].statusEmoji).toBe("?");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Function state edge cases ────────────────────────────────────────────────

describe("readRuntimeState — function state edges", () => {
  it("handles null sessions field", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "fnstate", { version: 1, sessions: null });

      const state = readRuntimeState(dir);
      expect(state.functionSessions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles sessions with null fns", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "fnstate", {
        version: 1,
        sessions: [
          { sessionId: "s1", fns: null },
          { sessionId: "s2", fns: [{ name: "fn1", state: { phase: "active" } }] },
        ],
      });

      const state = readRuntimeState(dir);
      // s1 should be filtered out (fns is null)
      expect(state.functionSessions).toHaveLength(1);
      expect(state.functionSessions[0].sessionId).toBe("s2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles fns with null name", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "fnstate", {
        version: 1,
        sessions: [
          {
            sessionId: "s1",
            fns: [
              { name: null, state: { phase: "active" } },
              { name: "fn2", state: { phase: "complete" } },
            ],
          },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.functionSessions).toHaveLength(1);
      expect(state.functionSessions[0].functions).toHaveLength(1); // null-name filtered out
      expect(state.functionSessions[0].functions[0].name).toBe("fn2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles fns with missing state", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "fnstate", {
        version: 1,
        sessions: [
          {
            sessionId: "s1",
            fns: [
              { name: "fn1" }, // no state
              { name: "fn2", state: null },
            ],
          },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.functionSessions).toHaveLength(1);
      expect(state.functionSessions[0].functions).toHaveLength(2);
      expect(state.functionSessions[0].functions[0].phase).toBe("unknown");
      expect(state.functionSessions[0].functions[1].phase).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Loop state edge cases ───────────────────────────────────────────────────

describe("readRuntimeState — loop state edges", () => {
  it("handles null loops field", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "loops", { version: 1, loops: null });

      const state = readRuntimeState(dir);
      expect(state.loops).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles loops with null state", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "loops", {
        version: 1,
        loops: [
          { id: "l1", state: null },
          { id: "l2", state: { agent: "agent-a", current: 1, total: 3, phase: "dispatching" } },
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.loops).toHaveLength(1);
      expect(state.loops[0].id).toBe("l2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles loops with missing fields", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "loops", {
        version: 1,
        loops: [
          { id: "l1", state: {} }, // empty state
        ],
      });

      const state = readRuntimeState(dir);
      expect(state.loops).toHaveLength(1);
      expect(state.loops[0].agent).toBe("unknown");
      expect(state.loops[0].current).toBe(0);
      expect(state.loops[0].total).toBe(0);
      expect(state.loops[0].phase).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Full read tests ──────────────────────────────────────────────────────────

describe("readRuntimeState — full reads", () => {
  it("reads all four state types from files", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      writeStateFile(stateDir, "dispatch", { version: 5, tasks: [{ id: "t1", agent: "a", status: "running" }] });
      writeStateFile(stateDir, "graph", { version: 2, sessions: [{ sessionId: "s1", agentId: "b", state: { frontier: [], completed: [], iterationCount: 0, status: "active" } }] });
      writeStateFile(stateDir, "fnstate", { version: 1, sessions: [{ sessionId: "s2", fns: [{ name: "fn1", state: { phase: "active" } }] }] });
      writeStateFile(stateDir, "loops", { version: 1, loops: [{ id: "l1", state: { agent: "c", current: 1, total: 5, phase: "dispatching" } }] });

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toHaveLength(1);
      expect(state.graphSessions).toHaveLength(1);
      expect(state.functionSessions).toHaveLength(1);
      expect(state.loops).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles non-JSON files in state directory", () => {
    const dir = makeTempDir();
    try {
      const stateDir = join(dir, ".rolebox", "state");
      mkdirSync(stateDir, { recursive: true });
      // Non-JSON files should be ignored
      writeFileSync(join(stateDir, "README.md"), "# state directory", "utf-8");
      writeFileSync(join(stateDir, "data.bin"), Buffer.from([0, 1, 2]), "utf-8");

      const state = readRuntimeState(dir);
      expect(state.dispatchTasks).toEqual([]);
      expect(state.graphSessions).toEqual([]);
      expect(state.functionSessions).toEqual([]);
      expect(state.loops).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

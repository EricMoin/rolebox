import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { GraphExecutionState } from "../../src/graph/state";

let currentDataDir = "";

mock.module("../../src/cli/paths", () => ({
  getDataDir: () => currentDataDir,
}));

import { GraphStore } from "../../src/graph/graph-store";

function makeState(overrides?: Partial<GraphExecutionState>): GraphExecutionState {
  return {
    frontier: ["agent-a"],
    completed: [],
    iterationCount: 0,
    status: "active",
    ...overrides,
  };
}

function makeSessions(): Map<string, { agentId: string; state: GraphExecutionState }> {
  const map = new Map<string, { agentId: string; state: GraphExecutionState }>();
  map.set("session-1", {
    agentId: "orchestrator",
    state: makeState({ frontier: ["agent-a"], completed: [], iterationCount: 0 }),
  });
  map.set("session-2", {
    agentId: "orchestrator",
    state: makeState({
      frontier: ["agent-c"],
      completed: ["agent-a", "agent-b"],
      iterationCount: 2,
      status: "active",
    }),
  });
  return map;
}

function stateFilePath(dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  return join(currentDataDir, "state", `graph-${hash}.json`);
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  dirs.length = 0;
  currentDataDir = "";
});

function createTestStore(): { store: GraphStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "graph-store-test-"));
  currentDataDir = dir;
  dirs.push(dir);
  const store = new GraphStore(dir);
  return { store, dir };
}

describe("GraphStore", () => {
  describe("save/load round-trip", () => {
    it("saves sessions and loads them back with identical state", async () => {
      const { store, dir } = createTestStore();
      const original = makeSessions();

      await store.save(original);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      if (!loaded) return;

      expect(loaded.size).toBe(original.size);
      for (const [sessionId, entry] of original) {
        const loadedEntry = loaded.get(sessionId);
        expect(loadedEntry).toBeDefined();
        expect(loadedEntry!.agentId).toBe(entry.agentId);
        expect(loadedEntry!.state).toEqual(entry.state);
      }
    });

    it("load in a fresh store returns identical state", async () => {
      const { store: store1, dir } = createTestStore();
      const original = makeSessions();
      await store1.save(original);

      const store2 = new GraphStore(dir);
      const loaded = store2.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(original.size);
    });

    it("returns null when file does not exist", () => {
      const { store } = createTestStore();
      expect(store.load()).toBeNull();
    });

    it("returns null when file contains corrupt JSON", () => {
      const { store, dir } = createTestStore();
      const sp = stateFilePath(dir);
      mkdirSync(join(sp, ".."), { recursive: true });
      writeFileSync(sp, "not valid json {", "utf-8");
      expect(store.load()).toBeNull();
    });

    it("returns null when version is unsupported", () => {
      const { store, dir } = createTestStore();
      const sp = stateFilePath(dir);
      mkdirSync(join(sp, ".."), { recursive: true });
      writeFileSync(sp, JSON.stringify({ version: 99, sessions: [] }), "utf-8");
      expect(store.load()).toBeNull();
    });

    it("returns null when file is missing sessions array", () => {
      const { store, dir } = createTestStore();
      const sp = stateFilePath(dir);
      mkdirSync(join(sp, ".."), { recursive: true });
      writeFileSync(sp, JSON.stringify({ version: 1, notSessions: [] }), "utf-8");
      expect(store.load()).toBeNull();
    });
  });

  describe("saveSync", () => {
    it("saves synchronously and is loadable", () => {
      const { store, dir } = createTestStore();
      const sessions = makeSessions();
      store.saveSync(sessions);

      const store2 = new GraphStore(dir);
      const loaded = store2.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(sessions.size);
    });

    it("does not leave .tmp file behind after write", async () => {
      const { store, dir } = createTestStore();
      await store.save(makeSessions());

      const { existsSync } = require("node:fs");
      expect(existsSync(stateFilePath(dir) + ".tmp")).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes the state file", async () => {
      const { store, dir } = createTestStore();
      await store.save(makeSessions());

      const { existsSync } = require("node:fs");
      expect(existsSync(stateFilePath(dir))).toBe(true);

      store.clear();
      expect(existsSync(stateFilePath(dir))).toBe(false);
    });

    it("does not throw when file does not exist", () => {
      const { store } = createTestStore();
      expect(() => store.clear()).not.toThrow();
    });
  });

  describe("empty sessions", () => {
    it("saves and loads an empty session map", async () => {
      const { store } = createTestStore();
      await store.save(new Map());
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.size).toBe(0);
    });
  });

  describe("overwrite", () => {
    it("overwrites existing state file on second save", async () => {
      const { store } = createTestStore();
      const first = new Map<string, { agentId: string; state: GraphExecutionState }>();
      first.set("s1", { agentId: "a1", state: makeState({ completed: ["x"] }) });
      await store.save(first);

      const second = new Map<string, { agentId: string; state: GraphExecutionState }>();
      second.set("s2", { agentId: "a2", state: makeState({ completed: ["y"] }) });
      await store.save(second);

      const loaded = store.load();
      expect(loaded!.size).toBe(1);
      expect(loaded!.has("s1")).toBe(false);
      expect(loaded!.get("s2")!.agentId).toBe("a2");
    });
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────
 * Sub-task 7: RecoveryStateStore unit tests
 *
 * Covers: load/save roundtrip, recordAttempt with deduplication,
 * updateChainState create/merge, delete, flushSync, loadAll.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RecoveryStateStore } from "../../src/recovery/state.ts";
import type { RecoveryState, RecoveryAttempt, RecoveryMetricsSnapshot } from "../../src/recovery/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* cleanup race */ }
  }
  tmpDirs.length = 0;
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "state-test-"));
  tmpDirs.push(d);
  return d;
}

function makeAttempt(overrides?: Partial<RecoveryAttempt>): RecoveryAttempt {
  return {
    category: "session_error",
    errorType: "test_error",
    timestamp: Date.now(),
    chainPosition: 0,
    strategy: "retry",
    result: "retry",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("RecoveryStateStore", () => {
  it("load returns null for non-existent session", () => {
    const store = new RecoveryStateStore(tmpDir());
    const state = store.load("nonexistent");
    expect(state).toBeNull();
  });

  it("saveSync + load roundtrip with non-empty state", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const state: RecoveryState = {
      sessionID: "sync-session",
      attempts: [makeAttempt({ strategy: "retry" })],
      activeChains: {},
      metrics: {
        totalAttempts: 1,
        successfulRecoveries: 0,
        abortedChains: 0,
        exhaustedChains: 0,
        byCategory: {},
        byStrategy: {},
        errorTypeFrequency: {},
      },
    };
    store.saveSync("sync-session", state);

    const loaded = store.load("sync-session");
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionID).toBe("sync-session");
    expect(loaded!.attempts).toHaveLength(1);
    expect(loaded!.attempts[0].strategy).toBe("retry");
  });

  it("saveSync writes immediately and load reads it back", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const state: RecoveryState = {
      sessionID: "sync-session",
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0,
        successfulRecoveries: 0,
        abortedChains: 0,
        exhaustedChains: 0,
        byCategory: {},
        byStrategy: {},
        errorTypeFrequency: {},
      },
    };
    store.saveSync("sync-session", state);

    const loaded = store.load("sync-session");
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionID).toBe("sync-session");
  });

  it("recordAttempt creates new state and persists via flushSync", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const attempt = makeAttempt({ strategy: "retry" });

    store.recordAttempt("fresh-session", attempt);
    store.flushSync();

    const loaded = store.load("fresh-session");
    expect(loaded).not.toBeNull();
    expect(loaded!.attempts).toHaveLength(1);
    expect(loaded!.attempts[0].strategy).toBe("retry");
  });

  it("recordAttempt deduplicates by timestamp+strategy", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const ts = 1234567890;
    const attempt = makeAttempt({ timestamp: ts, strategy: "dedup-test" });

    // Record same attempt twice
    store.recordAttempt("dedup-session", attempt);
    store.recordAttempt("dedup-session", attempt);
    store.flushSync();

    const loaded = store.load("dedup-session");
    expect(loaded).not.toBeNull();
    expect(loaded!.attempts).toHaveLength(1);
  });

  it("updateChainState creates new chain entry (verified via saveSync+load)", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);

    // updateChainState uses async save; pre-populate with saveSync for test determinism
    const initialState: RecoveryState = {
      sessionID: "chain-session",
      attempts: [],
      activeChains: {},
      metrics: { totalAttempts: 0, successfulRecoveries: 0, abortedChains: 0, exhaustedChains: 0, byCategory: {}, byStrategy: {}, errorTypeFrequency: {} },
    };
    store.saveSync("chain-session", initialState);

    // Now updateChainState will load+modify+save (async). Use flushSync to force persistence.
    store.updateChainState("chain-session", "session_error", { currentStep: 0, startTime: 1000, totalAttempts: 1 });
    store.flushSync();

    const state = store.load("chain-session");
    expect(state).not.toBeNull();
    expect(state!.activeChains["session_error"]).toBeDefined();
    expect(state!.activeChains["session_error"].currentStep).toBe(0);
    expect(state!.activeChains["session_error"].startTime).toBe(1000);
    expect(state!.activeChains["session_error"].totalAttempts).toBe(1);
  });

  it("updateChainState merges with existing chain entry", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);

    // Pre-populate with a chain entry via saveSync (not updateChainState)
    const initialState: RecoveryState = {
      sessionID: "merge-session",
      attempts: [],
      activeChains: {
        edit_error: { currentStep: 0, startTime: 500, totalAttempts: 0 },
      },
      metrics: { totalAttempts: 0, successfulRecoveries: 0, abortedChains: 0, exhaustedChains: 0, byCategory: {}, byStrategy: {}, errorTypeFrequency: {} },
    };
    store.saveSync("merge-session", initialState);

    // Now updateChainState should load from disk, merge, and write
    store.updateChainState("merge-session", "edit_error", { currentStep: 1, totalAttempts: 2 });
    store.flushSync();

    const state = store.load("merge-session");
    expect(state).not.toBeNull();
    expect(state!.activeChains["edit_error"].currentStep).toBe(1); // updated
    expect(state!.activeChains["edit_error"].startTime).toBe(500); // preserved from original
    expect(state!.activeChains["edit_error"].totalAttempts).toBe(2);
  });

  it("updateChainState supports multiple chains simultaneously", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);

    // First update writes initial state for session_error
    store.updateChainState("multi-session", "session_error", { currentStep: 1, totalAttempts: 2 });
    // Flush to ensure the first write is on disk before the second reads it
    store.flushSync();

    // Second update should load the state and add a second chain
    store.updateChainState("multi-session", "edit_error", { currentStep: 0, totalAttempts: 1 });
    store.flushSync();

    const state = store.load("multi-session");
    expect(state).not.toBeNull();
    expect(Object.keys(state!.activeChains)).toHaveLength(2);
    expect(state!.activeChains["session_error"].currentStep).toBe(1);
    expect(state!.activeChains["edit_error"].currentStep).toBe(0);
  });

  it("delete removes state file and cleans dirty map", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const state: RecoveryState = {
      sessionID: "delete-me",
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0,
        successfulRecoveries: 0,
        abortedChains: 0,
        exhaustedChains: 0,
        byCategory: {},
        byStrategy: {},
        errorTypeFrequency: {},
      },
    };
    store.saveSync("delete-me", state);
    expect(store.load("delete-me")).not.toBeNull();

    store.delete("delete-me");
    expect(store.load("delete-me")).toBeNull();
  });

  it("delete on non-existent session does not throw", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    expect(() => store.delete("never-existed")).not.toThrow();
  });

  it("flushSync drains dirty map by writing all pending states synchronously", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const state1: RecoveryState = {
      sessionID: "s1",
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0, successfulRecoveries: 0, abortedChains: 0, exhaustedChains: 0,
        byCategory: {}, byStrategy: {}, errorTypeFrequency: {},
      },
    };
    const state2: RecoveryState = {
      sessionID: "s2",
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0, successfulRecoveries: 0, abortedChains: 0, exhaustedChains: 0,
        byCategory: {}, byStrategy: {}, errorTypeFrequency: {},
      },
    };

    store.save("s1", state1);
    store.save("s2", state2);
    store.flushSync();

    expect(store.load("s1")).not.toBeNull();
    expect(store.load("s2")).not.toBeNull();
  });

  it("loadAll returns empty map (placeholder)", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const all = store.loadAll();
    expect(all).toBeInstanceOf(Map);
    expect(all.size).toBe(0);
  });

  it("handles corrupt JSON gracefully (returns null)", () => {
    const dir = tmpDir();
    // Write a corrupt state file directly
    const filePath = join(dir, ".rolebox", "state", "recovery-corrupt.json");
    mkdirSync(join(dir, ".rolebox", "state"), { recursive: true });
    writeFileSync(filePath, "not-json{{{", "utf-8");

    const store = new RecoveryStateStore(dir);
    const result = store.load("corrupt");
    expect(result).toBeNull();
  });

  it("save accepts state with empty attempts", () => {
    const dir = tmpDir();
    const store = new RecoveryStateStore(dir);
    const state: RecoveryState = {
      sessionID: "empty-attempts",
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0,
        successfulRecoveries: 0,
        abortedChains: 0,
        exhaustedChains: 0,
        byCategory: {},
        byStrategy: {},
        errorTypeFrequency: {},
      },
    };
    store.saveSync("empty-attempts", state);
    const loaded = store.load("empty-attempts");
    expect(loaded).not.toBeNull();
    expect(loaded!.attempts).toEqual([]);
  });
});

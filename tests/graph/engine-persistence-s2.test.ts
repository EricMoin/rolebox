/**
 * Monitor observation mechanism — S2 persistence-layer fixes
 *
 * Covers the three S2 changes in `engine-persistence.ts`:
 *   - M5: `save()` / `flush()` / `_write()` report success via a boolean;
 *     a failed debounced (`scheduleSave`) write retains the pending state so
 *     the next flush/save retries it — a write failure is never silently
 *     swallowed and never drops dirty state.
 *   - H3: `cloneCheckpointHistory` is exported for hydrate/adopt reuse.
 *   - M10: `terminalNotified` is serialized (cloned) and restored, tolerating
 *     files authored before the field existed (stays `undefined`).
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import { createEngineState } from "../../src/graph/engine/engine-state.ts";
import {
  EnginePersistence,
  NON_CRITICAL_DEBOUNCE_MS,
  serializeEngineState,
  deserializeEngineState,
  engineStatePath,
  cloneCheckpointHistory,
  type EnginePersistenceFile,
} from "../../src/graph/engine/engine-persistence.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function declaration(): GraphDeclaration {
  return {
    version: 2,
    name: "s2",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

function baseState(graphId: string): EngineState {
  const state = createEngineState(declaration(), graphId);
  state.phase = EnginePhase.Executing;
  return state;
}

/**
 * Block the state directory: `.rolebox` exists as a plain file, so
 * `mkdirSync(".rolebox/state", { recursive: true })` inside `_write()` throws
 * ENOTDIR — a deterministic, reversible write failure.
 */
function blockStateDir(dir: string): void {
  writeFileSync(join(dir, ".rolebox"), "blocked");
}

function unblockStateDir(dir: string): void {
  rmSync(join(dir, ".rolebox"), { force: true });
}

// ── M5: write-failure signaling + retry ─────────────────────────────────────

describe("M5 — persistence write failure signaling", () => {
  it("save() returns false on a failed write, and a later retry succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      const state = baseState("g-s2-1");

      // Blocked state dir → the write fails, reported as `false` (not thrown).
      blockStateDir(dir);
      expect(store.save(state)).toBe(false);
      expect(existsSync(engineStatePath(dir, "g-s2-1"))).toBe(false);

      // Unblock and retry → the retry succeeds and the file reaches disk.
      unblockStateDir(dir);
      expect(store.save(state)).toBe(true);
      expect(existsSync(engineStatePath(dir, "g-s2-1"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flush() reports the drain result and retains the pending state on failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      const state = baseState("g-s2-2");

      blockStateDir(dir);
      store.scheduleSave(state);

      // Drain fails → flush() returns false, and the pending state is retained.
      expect(store.flush()).toBe(false);
      expect(existsSync(engineStatePath(dir, "g-s2-2"))).toBe(false);

      // The retained pending state survives: once unblocked, flush() retries OK.
      unblockStateDir(dir);
      expect(store.flush()).toBe(true);
      expect(existsSync(engineStatePath(dir, "g-s2-2"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flush() with nothing pending reports success (no-op)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      expect(store.flush()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed debounced (scheduleSave) timer write retains the state for retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      const state = baseState("g-s2-3");

      blockStateDir(dir);
      store.scheduleSave(state);

      // Let the debounce window elapse — the timer write fails silently,
      // but the pending state is NOT dropped.
      await new Promise((r) => setTimeout(r, NON_CRITICAL_DEBOUNCE_MS + 150));
      expect(existsSync(engineStatePath(dir, "g-s2-3"))).toBe(false);

      // Retry through flush(): still blocked → failure reported.
      expect(store.flush()).toBe(false);

      // Unblock → the retained pending state is still writable.
      unblockStateDir(dir);
      expect(store.flush()).toBe(true);
      expect(existsSync(engineStatePath(dir, "g-s2-3"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── H3: cloneCheckpointHistory export ───────────────────────────────────────

describe("H3 — exported cloneCheckpointHistory", () => {
  it("deep-clones history records and passes undefined through", () => {
    const history = {
      A: [
        { nodeId: "A", status: NodeStatus.Ready, at: 1 },
        { nodeId: "A", status: NodeStatus.Completed, at: 2, note: "ok" },
      ],
      B: [{ nodeId: "B", status: NodeStatus.Running, at: 3 }],
    };

    const cloned = cloneCheckpointHistory(history)!;
    expect(cloned).toEqual(history);
    // Defensive copies, not aliases.
    expect(cloned).not.toBe(history);
    expect(cloned.A).not.toBe(history.A);
    expect(cloned.A[0]).not.toBe(history.A[0]);
    // undefined in → undefined out (no fabrication).
    expect(cloneCheckpointHistory(undefined)).toBeUndefined();
  });
});

// ── M10: terminalNotified serialization ─────────────────────────────────────

describe("M10 — terminalNotified persistence", () => {
  it("round-trips terminalNotified losslessly through save → load", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      const state = baseState("g-s2-4");
      state.terminalNotified = { complete: true, blocked: false };

      // DTO carries a cloned snapshot.
      const dto = serializeEngineState(state);
      expect(dto.terminalNotified).toEqual({ complete: true, blocked: false });

      store.save(state);
      const loaded = store.load("g-s2-4")!;
      expect(loaded.terminalNotified).toEqual({ complete: true, blocked: false });

      // DTO-level lossless: serialize(load(save(state))) === serialize(state).
      expect(serializeEngineState(loaded)).toEqual(dto);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the { complete: false, blocked: true } combination", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      const state = baseState("g-s2-5");
      state.terminalNotified = { complete: false, blocked: true };

      store.save(state);
      expect(store.load("g-s2-5")!.terminalNotified).toEqual({
        complete: false,
        blocked: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file authored WITHOUT terminalNotified deserializes to undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-s2-"));
    try {
      const store = new EnginePersistence(dir);
      const state = baseState("g-s2-6");
      expect(state.terminalNotified).toBeUndefined();
      store.save(state);

      // The authored file genuinely lacks the field.
      const raw = JSON.parse(readFileSync(engineStatePath(dir, "g-s2-6"), "utf-8"));
      expect(raw.terminalNotified).toBeUndefined();

      // Hydration tolerates the absence — no fabricated default.
      const loaded = store.load("g-s2-6")!;
      expect(loaded.terminalNotified).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deserializeEngineState restores when present, tolerates when absent", () => {
    const file: EnginePersistenceFile = {
      version: 2,
      graphId: "g-pure",
      phase: EnginePhase.Complete,
      graphDeclaration: declaration(),
      nodes: {},
      edges: {},
      loopGroups: {},
      frontier: [],
      budget: {
        sessionsSpawned: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
      },
      signalLedger: {},
      startedAt: 1,
      updatedAt: 2,
      advancingLock: false,
      pendingCompletions: [],
      terminalNotified: { complete: true, blocked: true },
    };

    // Present → restored as a fresh object.
    const state = deserializeEngineState(file);
    expect(state.terminalNotified).toEqual({ complete: true, blocked: true });

    // Absent → undefined (no default object fabricated).
    const { terminalNotified: _tn, ...without } = file;
    const state2 = deserializeEngineState(without as EnginePersistenceFile);
    expect(state2.terminalNotified).toBeUndefined();
  });
});

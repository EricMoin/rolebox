import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  EnginePersistence,
  ENGINE_PERSISTENCE_VERSION,
  NON_CRITICAL_DEBOUNCE_MS,
  serializeEngineState,
  deserializeEngineState,
  loadEngineStateFromJson,
  engineStatePath,
  markDirty,
  clearDirty,
  shouldPersist,
} from "../../src/graph/engine/engine-persistence.ts";
import { createEngine } from "../../src/graph/engine/index.ts";
import {
  checkGraphTermination,
  type GraphTerminalEvent,
  type TerminationContext,
} from "../../src/graph/engine/engine-termination.ts";
import { AdvanceEngine, type NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import { SignalBridge, type SignalType } from "../../src/graph/engine/signal-bridge.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

// ── Test double: a fake dispatch seam (mirrors engine-index.test.ts) ────────

class FakeDispatch implements NodeDispatchPort {
  executeNode(
    _node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve({
      id: "task-1",
      sessionId: "sess-1",
      parentSessionId: "g-1",
      depth: 1,
      status: "running",
      agent: "a1",
      prompt: "p1",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    });
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function richDeclaration(): GraphDeclaration {
  return {
    version: 2,
    name: "rich",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2", needs_approval: true, join: { strategy: "quorum", quorum: 1 } },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
    loop_groups: [
      { id: "lg1", nodes: ["A", "B"], max_traversals: 3, termination: { any_of: [{ converged: "done" }] } },
    ],
    budget: { max_total_cost_usd: 0.1 },
  };
}

/**
 * Build a fully-populated EngineState exercising every serialized shape:
 * nodes with nested Maps (upstreamResults) and plain records (signalsObserved,
 * tokensConsumed, result), edges with artifacts + budgetConsumed, loop groups
 * with termination + fingerprint, the signal ledger, frontier, budget,
 * advancingLock, and pendingCompletions.
 */
function buildRichState(): EngineState {
  const state = createEngineState(richDeclaration(), "graph-1");
  state.phase = EnginePhase.Executing;
  state.startedAt = 100;
  state.updatedAt = 250;

  state.nodes.set("A", {
    nodeId: "A",
    agent: "a1",
    prompt: "p1",
    needsApproval: false,
    status: NodeStatus.Completed,
    dispatchTaskId: "t-A",
    dispatchSessionId: "s-A",
    result: {
      sidecarPath: "/tmp/res-A.txt",
      totalChars: 5,
      hadFence: true,
      materializedAt: "2026-07-25T00:00:00.000Z",
    },
    signalsObserved: { answer: "done", progress: { step: 1 } },
    sessionsSpawned: 2,
    tokensConsumed: { inputTokens: 10, outputTokens: 5, cost: 0.15 },
    upstreamResults: new Map([
      [
        "X",
        {
          fromNode: "X",
          fromSignal: "answer",
          result: "x",
          artifacts: ["/x.txt"],
          budgetConsumed: { tokens: 1, cost: 0.01, sessions: 1 },
        },
      ],
    ]),
    joinStrategy: "all",
    joinSatisfied: false,
    loopGroupId: "lg1",
    traversalCount: 2,
    startedAt: 100,
    completedAt: 200,
    retryCount: 1,
  });

  state.nodes.set("B", {
    nodeId: "B",
    agent: "a2",
    prompt: "p2",
    needsApproval: true,
    status: NodeStatus.Ready,
    signalsObserved: {},
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    joinStrategy: { quorum: 1 },
    joinSatisfied: true,
    loopGroupId: "lg1",
    traversalCount: 0,
    startedAt: 150,
    retryCount: 0,
  });

  state.loopGroups.set("lg1", {
    id: "lg1",
    maxTraversals: 3,
    traversalCount: 2,
    startTimeMs: 100,
    termination: { any_of: [{ converged: "done" }] },
    convergenceFingerprint: "fp123",
    consecutiveStale: 1,
  });

  state.signalLedger.set("A", { signals: { answer: "done" }, lastSignalAt: 200 });

  state.frontier = ["B"];
  state.budget = { sessionsSpawned: 3, totalInputTokens: 12, totalOutputTokens: 7, totalCost: 0.25 };
  state.advancingLock = true;
  state.pendingCompletions = ["A"];

  return state;
}

function singleNodeDeclaration(): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("EnginePersistence", () => {
  let dir: string;
  let store: EnginePersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-persist-"));
    store = new EnginePersistence(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dirty flag: a round-trip save → load does NOT carry isDirty", () => {
    // Set isDirty on a rich state to simulate a mutated state before save.
    const state = buildRichState();
    state.isDirty = true;

    // The DTO-level serialize should NOT include isDirty (it is never persisted).
    const dto = serializeEngineState(state);
    expect((dto as unknown as Record<string, unknown>).isDirty).toBeUndefined();

    // Persist and reload.
    store.save(state);
    const loaded = store.load("graph-1")!;
    // The loaded state must NOT carry the dirty flag — it's a runtime-only field
    // that is always reset to clean (false) after deserialization.
    expect(loaded.isDirty).toBe(false);
  });

  it("dirty flag: a fresh state from createEngineState has no isDirty", () => {
    const state = createEngineState(singleNodeDeclaration(), "graph-1");
    // Fresh states are clean — isDirty is explicitly false in createEngineState.
    expect(state.isDirty).toBe(false);
  });

  it("lossless round-trip: every field survives save → load", () => {
    const state = buildRichState();
    store.save(state);
    const loaded = store.load("graph-1");

    expect(loaded).not.toBeNull();
    const l = loaded!;

    // Top-level scalars + collections.
    expect(l.graphId).toBe("graph-1");
    expect(l.phase).toBe(EnginePhase.Executing);
    expect(l.startedAt).toBe(100);
    expect(l.updatedAt).toBe(250);
    expect(l.advancingLock).toBe(true);
    expect(l.pendingCompletions).toEqual(["A"]);
    expect(l.frontier).toEqual(["B"]);
    expect(l.graphDeclaration).toEqual(richDeclaration());

    // Maps are reconstructed as real Maps.
    expect(l.nodes instanceof Map).toBe(true);
    expect(l.loopGroups instanceof Map).toBe(true);
    expect(l.signalLedger instanceof Map).toBe(true);

    // Budget.
    expect(l.budget).toEqual({
      sessionsSpawned: 3,
      totalInputTokens: 12,
      totalOutputTokens: 7,
      totalCost: 0.25,
    });

    // Node A — nested Map (upstreamResults), result ref, tokens, signals.
    const a = l.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Completed);
    expect(a.dispatchTaskId).toBe("t-A");
    expect(a.dispatchSessionId).toBe("s-A");
    expect(a.result).toEqual({
      sidecarPath: "/tmp/res-A.txt",
      totalChars: 5,
      hadFence: true,
      materializedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(a.signalsObserved).toEqual({ answer: "done", progress: { step: 1 } });
    expect(a.tokensConsumed).toEqual({ inputTokens: 10, outputTokens: 5, cost: 0.15 });
    expect(a.upstreamResults instanceof Map).toBe(true);
    expect(a.upstreamResults.get("X")).toEqual({
      fromNode: "X",
      fromSignal: "answer",
      result: "x",
      artifacts: ["/x.txt"],
      budgetConsumed: { tokens: 1, cost: 0.01, sessions: 1 },
    });
    expect(a.traversalCount).toBe(2);
    expect(a.loopGroupId).toBe("lg1");

    // Node B — quorum join strategy object + needsApproval.
    const b = l.nodes.get("B")!;
    expect(b.needsApproval).toBe(true);
    expect(b.joinStrategy).toEqual({ quorum: 1 });
    expect(b.joinSatisfied).toBe(true);

    // Edges: the dead `state.edges` map is gone (D3) — the loaded state must
    // not carry an `edges` member at all.
    expect("edges" in l).toBe(false);

    // Loop groups — termination + fingerprint + staleness.
    expect(l.loopGroups.get("lg1")).toEqual({
      id: "lg1",
      maxTraversals: 3,
      traversalCount: 2,
      startTimeMs: 100,
      termination: { any_of: [{ converged: "done" }] },
      convergenceFingerprint: "fp123",
      consecutiveStale: 1,
    });

    // Signal ledger.
    expect(l.signalLedger.get("A")).toEqual({ signals: { answer: "done" }, lastSignalAt: 200 });
  });

  it("is lossless at the DTO level: serialize(load(save(state))) === serialize(state)", () => {
    const state = buildRichState();
    const dtoBefore = serializeEngineState(state);
    store.save(state);
    const loaded = store.load("graph-1")!;
    expect(serializeEngineState(loaded)).toEqual(dtoBefore);
  });

  it("does not mutate the input state during save", () => {
    const state = buildRichState();
    const before = JSON.stringify(serializeEngineState(state));
    store.save(state);
    expect(JSON.stringify(serializeEngineState(state))).toBe(before);
  });

  it("writes atomically: state file present, no leftover .tmp", () => {
    store.save(buildRichState());
    const path = engineStatePath(dir, "graph-1");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    // File is valid JSON with the version header.
    const raw = loadEngineStateFromJson(readFileSync(path, "utf-8"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf-8")).version).toBe(
      ENGINE_PERSISTENCE_VERSION,
    );
  });

  it("returns null for a missing state file (clean start)", () => {
    expect(store.load("never-written")).toBeNull();
  });

  it("returns null for a corrupt JSON file", () => {
    const path = engineStatePath(dir, "graph-1");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not valid json !!");
    expect(store.load("graph-1")).toBeNull();
  });

  it("returns null on a schema-version mismatch", () => {
    const path = engineStatePath(dir, "graph-1");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, graphId: "graph-1", phase: "idle" }),
    );
    expect(store.load("graph-1")).toBeNull();
  });

  // ── Total hydration: parseable-but-field-incomplete v2 files ───────────────
  //
  // A v2 file that passes the version gate but is missing a required field must
  // return `null` (never throw). Previously deserializeEngineState threw a
  // TypeError on Object.entries(file.nodes) / spread of undefined — making the
  // graph permanently unrecoverable (re-failing every restart). Missing
  // required fields are treated as CORRUPT, not as a migration point; the
  // version stays 2.

  /** Serialize a rich state and strip one top-level required field. */
  function v2FileWithout(field: string): string {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const { [field]: _stripped, ...rest } = dto;
    return JSON.stringify(rest);
  }

  it("returns null (not throw) for a v2 file missing `nodes`", () => {
    const path = engineStatePath(dir, "graph-1");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, v2FileWithout("nodes"));
    expect(() => store.load("graph-1")).not.toThrow();
    expect(store.load("graph-1")).toBeNull();
  });

  it("returns null (not throw) for a v2 file missing `frontier`", () => {
    const path = engineStatePath(dir, "graph-2");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, v2FileWithout("frontier"));
    expect(() => store.load("graph-2")).not.toThrow();
    expect(store.load("graph-2")).toBeNull();
  });

  it("returns null (not throw) for a v2 file missing `pendingCompletions`", () => {
    const path = engineStatePath(dir, "graph-3");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, v2FileWithout("pendingCompletions"));
    expect(() => store.load("graph-3")).not.toThrow();
    expect(store.load("graph-3")).toBeNull();
  });

  it("treats non-object/array required fields as corrupt (null), never throws", () => {
    const path = engineStatePath(dir, "graph-4");
    mkdirSync(join(path, ".."), { recursive: true });
    // `budget` is required to be an object; a scalar is structurally invalid.
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    writeFileSync(path, JSON.stringify({ ...dto, budget: "not-an-object" }));
    expect(() => store.load("graph-4")).not.toThrow();
    expect(store.load("graph-4")).toBeNull();
  });

  // ── hasRequiredShape completeness (review 05-F2 / M15) ────────────────────
  //
  // hasRequiredShape must ALSO gate `graphDeclaration` (an object) and the
  // scalar lifecycle fields `startedAt`/`updatedAt` (numbers) / `advancingLock`
  // (boolean). A v2 file missing `graphDeclaration` previously passed the gate
  // and let hydrateEngineState's clearUndeclaredLoopGroupIds throw a TypeError
  // OUTSIDE the load try/catch — breaking the "never throws / permanently
  // recoverable" contract. Missing/wrong-typed versions of these fields are
  // CORRUPT (null), never a migration point.

  it("returns null (not throw) for a v2 file missing `graphDeclaration`", () => {
    const path = engineStatePath(dir, "graph-decl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, v2FileWithout("graphDeclaration"));
    expect(() => store.load("graph-decl")).not.toThrow();
    expect(store.load("graph-decl")).toBeNull();
  });

  it("returns null (not throw) for a v2 file missing `startedAt` / `updatedAt`", () => {
    const path = engineStatePath(dir, "graph-ts");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, v2FileWithout("startedAt"));
    expect(() => store.load("graph-ts")).not.toThrow();
    expect(store.load("graph-ts")).toBeNull();

    const path2 = engineStatePath(dir, "graph-ts2");
    mkdirSync(join(path2, ".."), { recursive: true });
    writeFileSync(path2, v2FileWithout("updatedAt"));
    expect(() => store.load("graph-ts2")).not.toThrow();
    expect(store.load("graph-ts2")).toBeNull();
  });

  it("returns null (not throw) for a v2 file missing `advancingLock`", () => {
    const path = engineStatePath(dir, "graph-lock");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, v2FileWithout("advancingLock"));
    expect(() => store.load("graph-lock")).not.toThrow();
    expect(store.load("graph-lock")).toBeNull();
  });

  it("treats wrong-typed lifecycle scalars as corrupt: advancingLock string / startedAt string / graphDeclaration array", () => {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;

    const badLock = engineStatePath(dir, "graph-badlock");
    mkdirSync(join(badLock, ".."), { recursive: true });
    writeFileSync(badLock, JSON.stringify({ ...dto, advancingLock: "yes" }));
    expect(() => store.load("graph-badlock")).not.toThrow();
    expect(store.load("graph-badlock")).toBeNull();

    const badTs = engineStatePath(dir, "graph-badts");
    mkdirSync(join(badTs, ".."), { recursive: true });
    writeFileSync(badTs, JSON.stringify({ ...dto, startedAt: "100" }));
    expect(() => store.load("graph-badts")).not.toThrow();
    expect(store.load("graph-badts")).toBeNull();

    const badDecl = engineStatePath(dir, "graph-baddecl");
    mkdirSync(join(badDecl, ".."), { recursive: true });
    writeFileSync(
      badDecl,
      JSON.stringify({ ...dto, graphDeclaration: ["not", "an", "object"] }),
    );
    expect(() => store.load("graph-baddecl")).not.toThrow();
    expect(store.load("graph-baddecl")).toBeNull();
  });

  // ── load(): only ENOENT is a clean start (review 05-F6 / L22) ─────────────
  //
  // A non-ENOENT read failure (EACCES / EISDIR / ...) means the state file
  // EXISTS but is unreadable — treating it as "no state" would silently
  // re-provision a graph whose completed nodes would be re-executed. `load()`
  // must rethrow these so the caller surfaces them explicitly.

  it("rethrows a non-ENOENT read failure (EISDIR) instead of returning null", () => {
    // A DIRECTORY at the state-file path makes readFileSync fail with EISDIR —
    // the file exists but cannot be read as a file.
    const path = engineStatePath(dir, "graph-1");
    mkdirSync(path, { recursive: true });
    expect(() => store.load("graph-1")).toThrow();
  });

  it("still returns null for ENOENT (clean start) — a missing file is not an error", () => {
    expect(store.load("never-written")).toBeNull();
  });

  it("loadEngineStateFromJson is total: a deep structurally-invalid v2 file returns null", () => {
    // Passes the required-field gate (all top-level fields present) but a
    // nested edge payload inside a node's `upstreamResults` is malformed —
    // `artifacts` is absent, which makes deserializeEngineState's
    // cloneEdgePayload throw on `[...p.artifacts]`.
    // The try/catch containment must return null, never throw.
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const nodes = dto.nodes as Record<string, Record<string, unknown>>;
    const upstream = nodes["A"]!.upstreamResults as Record<
      string,
      Record<string, unknown>
    >;
    const poisoned = {
      ...dto,
      nodes: {
        ...nodes,
        A: {
          ...nodes["A"],
          upstreamResults: {
            X: {
              fromNode: upstream["X"].fromNode,
              fromSignal: upstream["X"].fromSignal,
              result: upstream["X"].result,
              budgetConsumed: upstream["X"].budgetConsumed,
              // `artifacts` deliberately absent → structural invalidity
            },
          },
        },
      },
    };
    expect(() => loadEngineStateFromJson(JSON.stringify(poisoned))).not.toThrow();
    expect(loadEngineStateFromJson(JSON.stringify(poisoned))).toBeNull();
  });

  it("serializeEngineState no longer writes the legacy `edges` key (D3)", () => {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    expect(dto.edges).toBeUndefined();
  });

  it("a legacy v2 file with an extra top-level `edges` key still loads (backward compat)", () => {
    // Files authored before the D3 dead-field removal carry a top-level
    // `edges` object. It must be tolerated (passes the required-shape gate)
    // and ignored — never hydrated back onto the live state.
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const legacy = {
      ...dto,
      edges: {
        "A->B": {
          fromNode: "A",
          fromSignal: "answer",
          result: "res",
          artifacts: ["/a.txt"],
          budgetConsumed: { tokens: 3, cost: 0.05, sessions: 1 },
        },
      },
    };
    const loaded = loadEngineStateFromJson(JSON.stringify(legacy));
    expect(loaded).not.toBeNull();
    expect("edges" in loaded!).toBe(false);
    // The rest of the state hydrates normally.
    expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Completed);
  });

  it("scheduleSave writes on flush() (debounced non-critical path)", () => {
    const state = buildRichState();
    store.scheduleSave(state);
    expect(existsSync(engineStatePath(dir, "graph-1"))).toBe(false);
    store.flush();
    expect(existsSync(engineStatePath(dir, "graph-1"))).toBe(true);
  });

  it("sanitizes unsafe graph-id characters in the filename slug", () => {
    // "a b/c:d" → every unsafe char (space, "/", ":") becomes "-".
    expect(engineStatePath(dir, "a b/c:d").endsWith("engine-a-b-c-d.json")).toBe(true);
    // A safe id passes through verbatim.
    expect(engineStatePath(dir, "graph-1").endsWith("engine-graph-1.json")).toBe(true);
  });
});

// ── EnginePersistence.dispose(): teardown for a replaced / discarded runtime ──
//
// Review 05-F1/F3 (M14/ML1): a runtime that is disposed must cancel its
// pending debounced write — flushing stale state over the successor runtime's
// newer state on the shared state file is the exact stale-write race the
// review flagged. dispose() therefore cancels the debounce timer AND drops the
// pending-to-flush state (it never flushes).

describe("EnginePersistence.dispose()", () => {
  let dir: string;
  let store: EnginePersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-persist-dispose-"));
    store = new EnginePersistence(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("cancels a pending debounced write — a later flush() is a no-op (M14)", () => {
    const state = buildRichState();
    store.scheduleSave(state);
    // Debounced: nothing on disk until flush() / the timer fires.
    expect(existsSync(engineStatePath(dir, "graph-1"))).toBe(false);

    store.dispose();
    // The pending state was DROPPED — even an explicit flush must not write.
    store.flush();
    expect(existsSync(engineStatePath(dir, "graph-1"))).toBe(false);
  });

  it("clears the debounce timer — nothing lands after the window elapses", async () => {
    const state = buildRichState();
    store.scheduleSave(state);
    store.dispose();
    // Wait beyond the debounce window: the timer was cleared on dispose, so the
    // stale state must never reach disk.
    await new Promise((r) => setTimeout(r, NON_CRITICAL_DEBOUNCE_MS + 50));
    expect(existsSync(engineStatePath(dir, "graph-1"))).toBe(false);
  });

  it("prevents a stale debounced write from overwriting newer state (M14 race model)", async () => {
    // Old runtime's persistence has a pending non-critical write...
    const oldStore = new EnginePersistence(dir);
    const stale = buildRichState();
    oldStore.scheduleSave(stale);

    // ...while the new runtime has already written its NEWER state to the
    // SAME file (graph-tools commit path: new runtime adopts + writes first,
    // old runtime disposes after).
    const newer = buildRichState();
    newer.budget = {
      sessionsSpawned: 9,
      totalInputTokens: 90,
      totalOutputTokens: 50,
      totalCost: 1.5,
    };
    new EnginePersistence(dir).save(newer);

    // Old runtime disposed — its pending write is cancelled, never flushed.
    oldStore.dispose();

    // After the debounce window, the on-disk state still reflects the NEWER
    // write — the stale pending write never landed on top of it.
    await new Promise((r) => setTimeout(r, NON_CRITICAL_DEBOUNCE_MS + 50));
    const loaded = new EnginePersistence(dir).load("graph-1")!;
    expect(loaded.budget.sessionsSpawned).toBe(9);
    expect(loaded.budget.totalCost).toBe(1.5);
  });

  it("is idempotent — a second dispose is a no-op", () => {
    store.scheduleSave(buildRichState());
    store.dispose();
    expect(() => store.dispose()).not.toThrow();
  });

  it("is a no-op when nothing is pending", () => {
    expect(() => store.dispose()).not.toThrow();
  });
});

describe("write-through persistence hook (Q2 Option A)", () => {
  it("persists engine state after an advancement critical section (run/provision)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-hook-"));
    try {
      const engine = createEngine(singleNodeDeclaration(), {
        graphId: "g-hook-1",
        dispatch: new FakeDispatch(),
        stateDir: dir,
      });
      await engine.run(); // provision + dispatchReady → critical section → finally persist
      const path = engineStatePath(dir, "g-hook-1");
      expect(existsSync(path)).toBe(true);
      const loaded = new EnginePersistence(dir).load("g-hook-1");
      expect(loaded).not.toBeNull();
      // The critical transition (idle → executing, node ready → running) is persisted.
      expect(loaded!.phase).toBe(EnginePhase.Executing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Subtask 1: optional-additive runtime fields + persistence ───────────────
//
// The seven previously-unbacked graph_status flags (round, include_checkpoint,
// include_history, include_artifacts, include_evidence, stream, since) get
// OPTIONAL-ADDITIVE backing stores. All new fields are optional and default to
// undefined — the version stays 2 and existing v2 files WITHOUT the fields must
// still load. Genuine values are recorded by subtask 2 (separate).

/** Populate every new optional-additive field on a rich engine state. */
function populateAdditiveFields(state: EngineState): void {
  // EngineState.checkpoints (include_checkpoint)
  state.checkpoints = {
    A: { nodeId: "A", status: NodeStatus.Completed, at: 200, note: "ok" },
    B: { nodeId: "B", status: NodeStatus.Ready, at: 150 },
  };

  // EngineState.checkpointHistory (include_checkpoint — append-only traceability)
  state.checkpointHistory = {
    A: [
      { nodeId: "A", status: NodeStatus.Ready, at: 100 },
      { nodeId: "A", status: NodeStatus.Running, at: 150 },
      { nodeId: "A", status: NodeStatus.Completed, at: 200, note: "ok" },
    ],
    B: [{ nodeId: "B", status: NodeStatus.Ready, at: 150 }],
  };

  // NodeRuntimeState.artifacts / evidence (include_artifacts / include_evidence)
  const a = state.nodes.get("A")!;
  a.artifacts = ["/out/a.ts", "/out/a.md"];
  a.evidence = ["/ev/a.test.ts"];
  // NodeRuntimeState.resultText (subtask 2): stashed materialized-result text.
  a.resultText = "stashed text for A";
  const b = state.nodes.get("B")!;
  b.evidence = [];

  // LoopGroupRuntimeState.rounds (round)
  state.loopGroups.get("lg1")!.rounds = [
    { round: 1, traversalCount: 1, nodeIds: ["A"], status: NodeStatus.Completed, startedAt: 100, completedAt: 200 },
    { round: 2, traversalCount: 2, nodeIds: ["A"], status: NodeStatus.Completed, startedAt: 300 },
  ];

  // SignalLedgerEntry.history (include_history / stream / since)
  state.signalLedger.get("A")!.history = [
    { signal: "progress", payload: { step: 1 }, atMs: 150, source: "dispatch" },
    { signal: "answer", atMs: 200, source: "dispatch" },
  ];
}

describe("EnginePersistence — subtask 1 optional-additive fields", () => {
  let dir: string;
  let store: EnginePersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-persist-additive-"));
    store = new EnginePersistence(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("(a) backward compat: a v2 file WITHOUT the new fields loads successfully", () => {
    // buildRichState() never sets the new fields, so the serialized file is a
    // v2 file authored exactly as it would have been before subtask 1.
    store.save(buildRichState());
    const raw = readFileSync(engineStatePath(dir, "graph-1"), "utf-8");
    const parsed = JSON.parse(raw);
    // Version is still 2 — no bump.
    expect(parsed.version).toBe(ENGINE_PERSISTENCE_VERSION);
    expect(parsed.version).toBe(2);
    // The old-shaped file genuinely lacks the new fields.
    expect(parsed.checkpoints).toBeUndefined();
    expect(parsed.checkpointHistory).toBeUndefined();
    expect(parsed.nodes.A.artifacts).toBeUndefined();
    expect(parsed.nodes.A.evidence).toBeUndefined();
    expect(parsed.nodes.A.resultText).toBeUndefined();
    expect(parsed.loopGroups.lg1.rounds).toBeUndefined();
    expect(parsed.signalLedger.A.history).toBeUndefined();

    // The version gate still admits it (version===2) and hydration succeeds.
    const loaded = store.load("graph-1");
    expect(loaded).not.toBeNull();
    const l = loaded!;
    // New fields default to undefined — not fabricated.
    expect(l.checkpoints).toBeUndefined();
    expect(l.checkpointHistory).toBeUndefined();
    expect(l.nodes.get("A")!.artifacts).toBeUndefined();
    expect(l.nodes.get("A")!.evidence).toBeUndefined();
    expect(l.nodes.get("A")!.resultText).toBeUndefined();
    expect(l.loopGroups.get("lg1")!.rounds).toBeUndefined();
    expect(l.signalLedger.get("A")!.history).toBeUndefined();
    // Pre-existing fields are untouched.
    expect(l.phase).toBe(EnginePhase.Executing);
    expect(l.nodes.get("A")!.status).toBe(NodeStatus.Completed);
  });

  it("(b) round-trips losslessly: a v2 file WITH the new fields loads intact", () => {
    const state = buildRichState();
    populateAdditiveFields(state);
    const dtoBefore = serializeEngineState(state);
    store.save(state);
    const loaded = store.load("graph-1")!;

    // DTO-level lossless equality across the whole container.
    expect(serializeEngineState(loaded)).toEqual(dtoBefore);
    // Version unchanged.
    expect(dtoBefore.version).toBe(ENGINE_PERSISTENCE_VERSION);

    // Checkpoints survive as real records.
    expect(loaded.checkpoints).toEqual({
      A: { nodeId: "A", status: NodeStatus.Completed, at: 200, note: "ok" },
      B: { nodeId: "B", status: NodeStatus.Ready, at: 150 },
    });

    // Append-only checkpoint history survives in order (traceability).
    expect(loaded.checkpointHistory).toEqual({
      A: [
        { nodeId: "A", status: NodeStatus.Ready, at: 100 },
        { nodeId: "A", status: NodeStatus.Running, at: 150 },
        { nodeId: "A", status: NodeStatus.Completed, at: 200, note: "ok" },
      ],
      B: [{ nodeId: "B", status: NodeStatus.Ready, at: 150 }],
    });

    // Per-node artifacts / evidence survive (including the empty evidence array).
    expect(loaded.nodes.get("A")!.artifacts).toEqual(["/out/a.ts", "/out/a.md"]);
    expect(loaded.nodes.get("A")!.evidence).toEqual(["/ev/a.test.ts"]);
    expect(loaded.nodes.get("B")!.evidence).toEqual([]);
    // The stashed result-text snapshot survives (recovered nodes keep their text).
    expect(loaded.nodes.get("A")!.resultText).toBe("stashed text for A");

    // Loop-group round history survives in order.
    expect(loaded.loopGroups.get("lg1")!.rounds).toEqual([
      { round: 1, traversalCount: 1, nodeIds: ["A"], status: NodeStatus.Completed, startedAt: 100, completedAt: 200 },
      { round: 2, traversalCount: 2, nodeIds: ["A"], status: NodeStatus.Completed, startedAt: 300 },
    ]);

    // Signal-event history survives in order.
    expect(loaded.signalLedger.get("A")!.history).toEqual([
      { signal: "progress", payload: { step: 1 }, atMs: 150, source: "dispatch" },
      { signal: "answer", atMs: 200, source: "dispatch" },
    ]);
  });
});

// ── Dirty-flag helpers (engine-persistence.ts contract) ─────────────────────

describe("dirty-flag helpers (markDirty / clearDirty / shouldPersist)", () => {
  it("markDirty sets isDirty true, shouldPersist reflects it", () => {
    const state = createEngineState(singleNodeDeclaration(), "g-helpers-1");
    expect(state.isDirty).toBe(false);
    expect(shouldPersist(state)).toBe(false);

    markDirty(state);
    expect(state.isDirty).toBe(true);
    expect(shouldPersist(state)).toBe(true);
  });

  it("clearDirty resets isDirty to false after markDirty", () => {
    const state = createEngineState(singleNodeDeclaration(), "g-helpers-2");
    markDirty(state);
    expect(shouldPersist(state)).toBe(true);

    clearDirty(state);
    expect(state.isDirty).toBe(false);
    expect(shouldPersist(state)).toBe(false);
  });

  it("deserialized state starts clean (isDirty is false, never resurrected)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-helpers-"));
    try {
      const localStore = new EnginePersistence(dir);
      const state = buildRichState();
      state.isDirty = true; // simulate dirt before save
      localStore.save(state);
      const loaded = localStore.load("graph-1")!;
      // isDirty must NOT survive the round-trip — it is runtime-only.
      expect(loaded.isDirty).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Dirty-flag durability: state is complete after persist ──────────────────

describe("dirty-flag durability", () => {
  it("after engine.run(), persisted state is complete and isDirty is false on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-dirt-durable-"));
    try {
      const engine = createEngine(singleNodeDeclaration(), {
        graphId: "g-dirt-durable-1",
        dispatch: new FakeDispatch(),
        stateDir: dir,
      });
      await engine.run();

      // The state is persisted at the end of the critical section.
      const path = engineStatePath(dir, "g-dirt-durable-1");
      expect(existsSync(path)).toBe(true);

      // Load the persisted state: it must be complete and clean.
      const loaded = new EnginePersistence(dir).load("g-dirt-durable-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe(EnginePhase.Executing);
      expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Running);
      // isDirty must not survive serialization — it is runtime-only.
      expect(loaded!.isDirty).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dispatch section persists the running snapshot and the launch snapshot, then idle sections produce zero extra writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-dirt-once-"));
    try {
      let persistCount = 0;
      const state = createEngineState(singleNodeDeclaration(), "g-dirt-once-1");
      provision(state);
      const signalBridge = new SignalBridge();
      const engine = new AdvanceEngine({
        state,
        signalBridge,
        dispatch: new FakeDispatch(),
        persistState: (s) => {
          persistCount++;
          // Persist to disk inside the mock to match real behavior.
          new EnginePersistence(dir).save(s);
        },
      });

      // Dispatch the root → exactly 2 persists: the dispatch-start
      // write-through (status=running hits disk before the dispatch task
      // resolves — closes the false-completed window) and the section-end
      // write (dispatchTaskId/dispatchSessionId + budget, the launch snapshot).
      await engine.dispatchReady();
      expect(persistCount).toBe(2);

      // Verify the persisted file on disk is complete.
      const loaded1 = new EnginePersistence(dir).load("g-dirt-once-1");
      expect(loaded1).not.toBeNull();
      expect(loaded1!.phase).toBe(EnginePhase.Executing);
      expect(loaded1!.nodes.get("A")!.status).toBe(NodeStatus.Running);
      expect(loaded1!.isDirty).toBe(false);

      // Run 5 idle sections → zero additional persists.
      for (let i = 0; i < 5; i++) {
        await engine.dispatchReady();
      }
      expect(persistCount).toBe(2);

      // The on-disk state remains unchanged (no further writes).
      const loaded2 = new EnginePersistence(dir).load("g-dirt-once-1");
      expect(loaded2).not.toBeNull();
      expect(loaded2!.phase).toBe(EnginePhase.Executing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Subtask 7 revision: dirty-flag batching optimization + durability ────────
//
// The optimization must fire: idle critical sections (nothing ready, no
// mutations) must produce ZERO extra persists. And durability must be preserved:
// a section whose only mutation is a recorded signal must still persist,
// because signalLedger / signalsObserved are durable graph state.

describe("dirty-flag batching: optimization fires on idle sections", () => {
  it("idle dispatchReady sections produce zero extra writes", async () => {
    const state = createEngineState(singleNodeDeclaration(), "g-opt-1");
    provision(state); // root "A" becomes ready, in frontier

    let persistCount = 0;
    const signalBridge = new SignalBridge();

    const engine = new AdvanceEngine({
      state,
      signalBridge,
      dispatch: new FakeDispatch(),
      persistState: () => {
        persistCount++;
      },
    });

    // First dispatch: dispatches the ready root → 2 persists (dispatch-start
    // write-through of the `running` transition + the section-end launch
    // snapshot — see the running-window fix in _dispatchNode).
    await engine.dispatchReady();
    expect(persistCount).toBe(2);

    // Five idle dispatches: nothing ready, frontier empty, lock acquire is
    // non-dirtying, drainPendingCompletions is empty → zero extra persists.
    const N = 5;
    for (let i = 0; i < N; i++) {
      await engine.dispatchReady();
    }
    expect(persistCount).toBe(2);
  });
});

describe("two-tier persistence: signal-only mutations are non-critical (debounced)", () => {
  it("signalBridge.record() sets isNonCriticalDirty (not isDirty) and routes through schedulePersistState", async () => {
    const state = createEngineState(singleNodeDeclaration(), "g-sig-1");
    provision(state);

    let criticalPersistCount = 0;
    let debouncedScheduleCount = 0;
    const signalBridge = new SignalBridge();

    const engine = new AdvanceEngine({
      state,
      signalBridge,
      dispatch: new FakeDispatch(),
      persistState: () => {
        criticalPersistCount++;
      },
      schedulePersistState: () => {
        debouncedScheduleCount++;
      },
    });

    // Dispatch the root first so the node is running and frontier is empty.
    // The dispatch section invokes the critical seam twice (dispatch-start
    // running write-through + section-end launch snapshot).
    await engine.dispatchReady();
    expect(criticalPersistCount).toBe(2);

    // Record a non-terminating signal — writes signalLedger history +
    // node.signalsObserved. Under Q2 Option A this is NON-critical churn:
    // it sets isNonCriticalDirty (not the critical isDirty).
    signalBridge.record(state, "A", "progress" as SignalType, { step: 1 });
    expect(state.isDirty).toBe(false);
    expect(state.isNonCriticalDirty).toBe(true);

    // An idle section sees ONLY non-critical churn → schedules a debounced
    // write instead of a synchronous one. The critical seam is NOT invoked.
    await engine.dispatchReady();
    expect(criticalPersistCount).toBe(2);
    expect(debouncedScheduleCount).toBe(1);
    // The non-critical flag is cleared after being handed to the debounce.
    expect(state.isNonCriticalDirty).toBe(false);
  });
});

// ── Q2 Option A: two-tier persistence wiring ─────────────────────────────────
//
// Three behaviors must hold:
//   (1) debounced non-critical write coalescing;
//   (2) critical transitions still write synchronously;
//   (3) flush-on-terminate leaves the on-disk state complete.

describe("two-tier persistence (Q2 Option A)", () => {
  it("(1) debounced non-critical writes coalesce: only the most recent state is flushed", () => {
    const localDir = mkdtempSync(join(tmpdir(), "engine-persist-coalesce-"));
    try {
      const localStore = new EnginePersistence(localDir);
      // First non-critical mutation schedules the debounce.
      const s1 = buildRichState();
      localStore.scheduleSave(s1);
      // A second non-critical mutation coalesces into the same debounce window —
      // the debounce timer is not restarted and the most recent state wins.
      const s2 = buildRichState();
      s2.budget = {
        sessionsSpawned: 9,
        totalInputTokens: 90,
        totalOutputTokens: 50,
        totalCost: 1.5,
      };
      localStore.scheduleSave(s2);

      // Debounced: nothing written until flush() / the timer fires.
      expect(existsSync(engineStatePath(localDir, "graph-1"))).toBe(false);

      localStore.flush();
      expect(existsSync(engineStatePath(localDir, "graph-1"))).toBe(true);

      // The flushed write reflects the most recent state (coalesced, not doubled).
      const loaded = localStore.load("graph-1")!;
      expect(loaded.budget.sessionsSpawned).toBe(9);
      expect(loaded.budget.totalCost).toBe(1.5);
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  it("(2) critical transitions still write synchronously (never the debounce)", async () => {
    const state = createEngineState(singleNodeDeclaration(), "g-crit-sync-1");
    provision(state);

    let criticalCount = 0;
    let scheduleCount = 0;
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: new FakeDispatch(),
      persistState: () => {
        criticalCount++;
      },
      schedulePersistState: () => {
        scheduleCount++;
      },
    });

    // dispatchReady runs a critical section with critical mutations (idle →
    // executing, root ready → running). The critical seam fires twice per
    // dispatch section: the dispatch-start write-through (running transition)
    // plus the section-end finally — never the debounced tier.
    await engine.dispatchReady();
    expect(criticalCount).toBe(2);
    expect(scheduleCount).toBe(0);
    // The state itself reflects the critical transition.
    expect(state.phase).toBe(EnginePhase.Executing);
  });

  it("(3) flush-on-terminate leaves the on-disk state complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-flush-term-"));
    try {
      const store = new EnginePersistence(dir);
      const state = createEngineState(singleNodeDeclaration(), "g-flush-term-1");
      provision(state);
      const signalBridge = new SignalBridge();
      const engine = new AdvanceEngine({
        state,
        signalBridge,
        dispatch: new FakeDispatch(),
        persistState: (s) => store.save(s),
        schedulePersistState: (s) => store.scheduleSave(s),
        flushPersistState: () => store.flush(),
      });

      // Dispatch the root → running (critical save).
      await engine.dispatchReady();
      // Non-critical churn recorded outside any critical section.
      signalBridge.record(state, "A", "progress" as SignalType, { step: 1 });
      expect(state.isNonCriticalDirty).toBe(true);

      // Complete the graph: answer → running → completed → termination → complete.
      await engine.onNodeSignalEmitted("A", "answer", "done");
      expect(state.phase).toBe(EnginePhase.Complete);

      // flush-on-terminate guarantees the on-disk state is complete — including
      // the pending non-critical churn recorded above.
      const loaded = store.load("g-flush-term-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe(EnginePhase.Complete);
      expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Completed);
      expect(loaded!.signalLedger.get("A")!.signals.progress).toEqual({ step: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Bug 3 part a: snapshotEngineState must preserve terminalNotified ─────────
//
// snapshotEngineState (src/graph/engine/index.ts) did NOT serialize
// state.terminalNotified. The graph-tools rebuild path reads the prior run via
// status() (a snapshot — graph-tools.ts:875) and hands it to
// adoptPriorNodeStates (engine-recovery.ts:762-764), which copied `undefined` —
// discarding the persisted-layer terminal claim and defeating the two-layer
// exact-once terminal guard (engine-termination.ts) on the adopt/rebuild path.
// The snapshot must now carry the flags object (shallow copy), both when absent
// (undefined, never fabricated) and when claimed ({ complete: true }).

describe("snapshotEngineState preserves terminalNotified (bug 3 part a)", () => {
  /** Fresh per-instance dedupe context (mirrors engine-termination-s4.test.ts). */
  function freshCtx(): TerminationContext {
    return { terminalComplete: false, terminalBlocked: false };
  }

  /** Quiesce a single-node graph so checkGraphTermination sees a terminal state. */
  function quiesce(state: EngineState, nodeId = "A"): void {
    const node = state.nodes.get(nodeId);
    if (!node) throw new Error(`node ${nodeId} not found`);
    node.status = NodeStatus.Completed;
    state.frontier = [];
  }

  it("keeps terminalNotified undefined when it was never claimed (never fabricated)", () => {
    const engine = createEngine(singleNodeDeclaration(), { graphId: "g-snap-m10-fresh" });
    expect(engine.status().terminalNotified).toBeUndefined();
  });

  it("carries a claimed { complete: true } flags object through status() → adoptPrior → status()", async () => {
    // Stage 1: a prior run reaches terminal completion — the two-layer guard
    // claims the persisted flag on the live state (fireGraphTerminal).
    const state = createEngineState(singleNodeDeclaration(), "g-snap-m10-prior");
    provision(state);
    state.phase = EnginePhase.Executing;
    quiesce(state);
    const events: GraphTerminalEvent[] = [];
    checkGraphTermination(state, (e) => events.push(e), freshCtx());
    expect(events).toHaveLength(1);
    expect(state.terminalNotified).toEqual({ complete: true, blocked: false });

    // Stage 2: the running engine serves a snapshot (graph-tools.ts:875) —
    // pre-fix this snapshot dropped the claim (snapshotEngineState omission).
    const prior = createEngine(singleNodeDeclaration(), { graphId: "g-snap-m10-served" });
    await prior.adoptPrior(state);
    const priorSnapshot = prior.status();
    expect(priorSnapshot.terminalNotified).toEqual({ complete: true, blocked: false });

    // Stage 3: a fresh rebuild adopts the SNAPSHOT (graph-tools.ts:886/1283) —
    // its own snapshot must still carry the claim.
    const rebuilt = createEngine(singleNodeDeclaration(), { graphId: "g-snap-m10-rebuilt" });
    await rebuilt.adoptPrior(priorSnapshot);
    expect(rebuilt.status().terminalNotified).toEqual({ complete: true, blocked: false });
  });
});

// ── Atomic write: no ENOENT read window (rename-over) ────────────────────────
//
// `_write` replaces the destination with a single atomic `renameSync(tmp,
// filePath)`. The pre-fix sequence unlink-then-rename left the path ABSENT
// between the two syscalls — a concurrent reader (the TUI polling
// engine-*.json) could observe ENOENT and drop the graph for a tick. This test
// hammers writes from the main thread while a worker thread loops reads, and
// asserts the reader never observes the path missing. With rename-over the
// invariant holds deterministically (the destination always holds either the
// previous or the new snapshot); the unlink window made it fail repeatedly.

describe("atomic write: no ENOENT read window (rename-over)", () => {
  it("a concurrent reader never observes the state file missing while writes are in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-atomic-"));
    try {
      const store = new EnginePersistence(dir);
      const state = buildRichState();
      const path = engineStatePath(dir, "graph-1");

      // First write creates the destination; every subsequent write must
      // replace it atomically (rename-over), never unlink-then-rename.
      store.save(state);

      // Reader worker: tight open/close loop until the main thread clears the
      // stop flag; tallies every ENOENT observation. `openSync` is a leaner
      // syscall than `readFileSync` (no read/parse), so the reader samples the
      // destination path fast enough to hit the unlink→rename gap the pre-fix
      // write left between two syscalls.
      const code = `
        const { parentPort, workerData } = require("node:worker_threads");
        const fs = require("node:fs");
        let enoent = 0;
        let reads = 0;
        while (Atomics.load(workerData.ctrl, 0) === 0) {
          let fd;
          try {
            fd = fs.openSync(workerData.path, "r");
          } catch (e) {
            if (e.code === "ENOENT") enoent++;
          } finally {
            if (fd !== undefined) {
              fs.closeSync(fd);
              reads++;
            }
          }
        }
        parentPort.postMessage({ enoent, reads });
      `;
      const saba = new SharedArrayBuffer(4);
      const ctrl = new Int32Array(saba);
      const worker = new Worker(code, {
        eval: true,
        workerData: { path, ctrl },
      });

      // Hammer writes while the reader races them. Rename-over never removes
      // the path, so the reader must observe zero ENOENT.
      for (let i = 0; i < 2000; i++) {
        store.save(state);
      }
      Atomics.store(ctrl, 0, 1); // stop the reader
      const { enoent, reads } = await new Promise<{ enoent: number; reads: number }>(
        (resolve) => worker.once("message", resolve),
      );
      await worker.terminate();

      expect(reads).toBeGreaterThan(0); // the reader genuinely raced the writes
      expect(enoent).toBe(0);           // rename-over never exposes ENOENT
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── R2: out-of-vocabulary persisted enums are corrupt (null), never hydrated ─
//
// A corrupt-but-shape-valid file (`status: "bogus"` / `joinStrategy: "bogus"` /
// `phase: "bogus"`) previously hydrated unchecked and crashed LATER with a
// TypeError in `canTransitionNode` (node-lifecycle.ts —
// `VALID_NODE_TRANSITIONS[from]` on undefined). The load path must reject
// out-of-vocabulary enum values up front: `loadEngineStateFromJson` returns
// null (the documented corrupt-to-null contract), and `deserializeEngineState`
// (whose contract returns a state) throws rather than hydrate an invalid enum.

describe("R2 — out-of-vocabulary persisted enums are corrupt (null)", () => {
  /** Serialize the rich state with one node-level field overridden. */
  function fileWithNodeField(field: string, value: unknown): string {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const nodes = dto.nodes as Record<string, Record<string, unknown>>;
    return JSON.stringify({
      ...dto,
      nodes: { ...nodes, A: { ...nodes["A"], [field]: value } },
    });
  }

  it("returns null from loadEngineStateFromJson when a node status is 'bogus'", () => {
    const raw = fileWithNodeField("status", "bogus");
    expect(() => loadEngineStateFromJson(raw)).not.toThrow();
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("returns null when a node status is outside NODE_STATUS_VALUES (case mismatch)", () => {
    expect(loadEngineStateFromJson(fileWithNodeField("status", "RUNNING"))).toBeNull();
  });

  it("returns null when a node joinStrategy is a bogus string (not in JOIN_STRATEGY_VALUES)", () => {
    expect(loadEngineStateFromJson(fileWithNodeField("joinStrategy", "bogus"))).toBeNull();
  });

  it("returns null when a node joinStrategy object lacks a positive-integer quorum", () => {
    for (const bad of [
      { quorum: 0 },
      { quorum: -2 },
      { quorum: 1.5 },
      { quorum: "2" },
      { quorum: NaN },
    ]) {
      expect(loadEngineStateFromJson(fileWithNodeField("joinStrategy", bad))).toBeNull();
    }
    // A valid positive-integer quorum still loads.
    expect(
      loadEngineStateFromJson(fileWithNodeField("joinStrategy", { quorum: 2 })),
    ).not.toBeNull();
  });

  it("returns null when file.phase is 'bogus'", () => {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const raw = JSON.stringify({ ...dto, phase: "bogus" });
    expect(() => loadEngineStateFromJson(raw)).not.toThrow();
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("a valid file still hydrates with exact enum values", () => {
    const loaded = loadEngineStateFromJson(
      JSON.stringify(serializeEngineState(buildRichState())),
    );
    expect(loaded).not.toBeNull();
    const l = loaded!;
    expect(l.phase).toBe(EnginePhase.Executing);
    expect(l.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(l.nodes.get("A")!.joinStrategy).toBe("all");
    expect(l.nodes.get("B")!.status).toBe(NodeStatus.Ready);
    expect(l.nodes.get("B")!.joinStrategy).toEqual({ quorum: 1 });
  });

  it("deserializeEngineState's defensive path throws on an invalid enum (never hydrates)", () => {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const nodes = dto.nodes as Record<string, Record<string, unknown>>;
    const poisoned = {
      ...dto,
      nodes: { ...nodes, A: { ...nodes["A"], status: "bogus" } },
    } as unknown as Parameters<typeof deserializeEngineState>[0];
    expect(() => deserializeEngineState(poisoned)).toThrow(/not a valid NodeStatus/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
  PlanBinding,
} from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  EnginePersistence,
  ENGINE_PERSISTENCE_VERSION,
  NON_CRITICAL_DEBOUNCE_MS,
  serializeEngineState,
  deserializeEngineState,
  loadEngineStateFromJson,
  loadEngineStateForResume,
  verifyPersistedPlan,
  verifyPersistedCompiledPlan,
  verifyPersistedPlanBinding,
  engineStatePath,
  markDirty,
  clearDirty,
  shouldPersist,
} from "../../src/graph/engine/engine-persistence.ts";
import {
  classifyStorageFormat,
  createStorageFormatRegistry,
  CURRENT_STORAGE_FORMAT,
  STORAGE_FORMAT_V2,
  type StorageFormatDecoder,
  type StorageFormatMigration,
} from "../../src/graph/persistence/storage-format.ts";
import {
  classifyExecutionProtocol,
  createExecutionProtocolRegistry,
  LEGACY_EXECUTION_PROTOCOL_REGISTRY,
  LEGACY_SIGNAL_PROTOCOL,
  OUTCOME_PROTOCOL,
  type ExecutionProtocolRegistry,
} from "../../src/graph/protocol/execution-protocol.ts";
import {
  contractDigest,
  type ContractRef,
  type ContractSnapshot,
} from "../../src/graph/contracts/contract-definition.ts";
import { createContractRegistry } from "../../src/graph/contracts/resolve.ts";
import { compileGraph } from "../../src/graph/compiler/compile.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  createPersistedCompiledPlan,
  type CompiledPlan,
  type PersistedCompiledPlan,
} from "../../src/graph/compiler/plan.ts";
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
      { id: "lg1", nodes: ["A", "B"], max_traversals: 3 },
    ],
    budget: { max_total_cost_usd: 0.1 },
  };
}

/**
 * Build a fully-populated EngineState exercising every serialized shape:
 * nodes with nested Maps (upstreamResults) and plain records (signalsObserved,
 * tokensConsumed, result), edges with artifacts + budgetConsumed, loop groups
 * with fingerprint, the signal ledger, frontier, budget,
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
      materializedAt: Date.parse("2026-07-25T00:00:00.000Z"),
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
    // R2(c): the persisted file still carries the crashed process's
    // critical-section fields, but hydration resets them — this process holds
    // no lock and has no in-memory deferred queue to replay. Every other field
    // survives the round trip (see the assertions below).
    expect(l.advancingLock).toBe(false);
    expect(l.pendingCompletions).toEqual([]);
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
      materializedAt: Date.parse("2026-07-25T00:00:00.000Z"),
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

    // Loop groups — fingerprint + staleness.
    expect(l.loopGroups.get("lg1")).toEqual({
      id: "lg1",
      maxTraversals: 3,
      traversalCount: 2,
      startTimeMs: 100,
      convergenceFingerprint: "fp123",
      consecutiveStale: 1,
    });

    // Signal ledger.
    expect(l.signalLedger.get("A")).toEqual({ signals: { answer: "done" }, lastSignalAt: 200 });
  });

  it("is lossless at the DTO level after one normalizing hydration (R2(c) fixpoint)", () => {
    const state = buildRichState();
    const dtoBefore = serializeEngineState(state);
    store.save(state);
    const loaded = store.load("graph-1")!;
    // The FIRST hydration normalizes only the runtime-only critical-section
    // fields (R2(c)) and materializes the bound execution-protocol identity
    // (B3) — every other serialized field must be lossless.
    expect(serializeEngineState(loaded)).toEqual({
      ...dtoBefore,
      advancingLock: false,
      pendingCompletions: [],
      executionProtocolVersion: LEGACY_SIGNAL_PROTOCOL,
    });
    // From the second generation on, the round trip is an exact fixpoint.
    store.save(loaded);
    const reloaded = store.load("graph-1")!;
    expect(serializeEngineState(reloaded)).toEqual(serializeEngineState(loaded));
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

    // DTO-level lossless equality across the whole container, except for the
    // runtime-only critical-section fields reset by R2(c) and the
    // execution-protocol identity the format-2 decoder backfills (B3).
    expect(serializeEngineState(loaded)).toEqual({
      ...dtoBefore,
      advancingLock: false,
      pendingCompletions: [],
      executionProtocolVersion: LEGACY_SIGNAL_PROTOCOL,
    });
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
    return { terminalComplete: false, terminalBlocked: false, terminalEpoch: 0 };
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
    checkGraphTermination(state, (e) => { events.push(e); }, freshCtx());
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

// ── R2: node-level required-field gate (trust boundary) ─────────────────────
//
// The top-level gate used to prove only that `nodes` was an object, so a
// `{ status, joinStrategy }` stub passed every gate and hydrated. A missing
// `tokensConsumed` then became `{}` through `{ ...undefined }` and the three
// budget-bridge `>=` comparisons against a declared `max_total_*` were all
// false — a silent budget-gate shutdown. These tests pin the new
// corrupt-to-clean-start behaviour: a node missing a required field no longer
// loads (previously it "barely loaded").

describe("R2 — node-level required fields are corrupt (null), never hydrated", () => {
  /** Serialize the rich state with one node-level entry mutated/removed. */
  function fileWithNodeEntry(
    mutate: (node: Record<string, unknown>) => Record<string, unknown>,
  ): string {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const nodes = dto.nodes as Record<string, Record<string, unknown>>;
    return JSON.stringify({
      ...dto,
      nodes: { ...nodes, A: mutate({ ...nodes["A"] }) },
    });
  }

  it("returns null when a node is missing tokensConsumed (the budget-gate hole)", () => {
    const raw = fileWithNodeEntry((node) => {
      delete node.tokensConsumed;
      return node;
    });
    expect(() => loadEngineStateFromJson(raw)).not.toThrow();
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("returns null when tokensConsumed is empty or has a non-numeric counter", () => {
    for (const tokens of [
      {},
      { inputTokens: 1, outputTokens: 2 },
      { inputTokens: "1", outputTokens: 2, cost: 0 },
    ]) {
      expect(
        loadEngineStateFromJson(
          fileWithNodeEntry((n) => ({ ...n, tokensConsumed: tokens })),
        ),
      ).toBeNull();
    }
  });

  it("returns null when agent / prompt / needsApproval are missing or wrongly typed", () => {
    expect(
      loadEngineStateFromJson(
        fileWithNodeEntry((n) => {
          delete n.agent;
          return n;
        }),
      ),
    ).toBeNull();
    expect(
      loadEngineStateFromJson(fileWithNodeEntry((n) => ({ ...n, prompt: 42 }))),
    ).toBeNull();
    expect(
      loadEngineStateFromJson(
        fileWithNodeEntry((n) => ({ ...n, needsApproval: "yes" })),
      ),
    ).toBeNull();
  });

  it("returns null when signalsObserved / upstreamResults are not objects", () => {
    expect(
      loadEngineStateFromJson(
        fileWithNodeEntry((n) => ({ ...n, signalsObserved: [] })),
      ),
    ).toBeNull();
    expect(
      loadEngineStateFromJson(
        fileWithNodeEntry((n) => {
          delete n.upstreamResults;
          return n;
        }),
      ),
    ).toBeNull();
  });

  it("deserializeEngineState's defensive path throws (never legalizes a partial node)", () => {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const nodes = dto.nodes as Record<string, Record<string, unknown>>;
    const poisoned = {
      ...dto,
      nodes: {
        ...nodes,
        A: { status: "completed", joinStrategy: "all" },
      },
    } as unknown as Parameters<typeof deserializeEngineState>[0];
    expect(() => deserializeEngineState(poisoned)).toThrow(
      /is missing a required field/,
    );
  });

  it("a complete node still hydrates (a valid file is unaffected)", () => {
    const loaded = loadEngineStateFromJson(
      JSON.stringify(serializeEngineState(buildRichState())),
    );
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes.get("A")!.tokensConsumed).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.15,
    });
  });

  it("carries the node's declared budget through the DTO (declared field, not spread-only)", () => {
    const state = buildRichState();
    state.nodes.get("A")!.budget = { timeout_ms: 1234, max_input_tokens: 99 };
    const dto = serializeEngineState(state);
    // The old hand-mirrored DTO did not declare `budget`; it survived only via
    // the untyped `...rest` spread. The derived DTO declares it, so the
    // staleness watcher's per-node `timeout_ms` is covered by contract.
    expect(dto.nodes["A"]!.budget).toEqual({
      timeout_ms: 1234,
      max_input_tokens: 99,
    });
    expect(deserializeEngineState(dto).nodes.get("A")!.budget).toEqual({
      timeout_ms: 1234,
      max_input_tokens: 99,
    });
  });
});

// ── R2(c): runtime-only critical-section fields are reset on hydration ──────

describe("R2(c) — advancingLock / pendingCompletions reset on hydration", () => {
  it("persists the crash-time lock/queue for diagnostics but hydrates them reset", () => {
    const state = buildRichState(); // advancingLock=true, pendingCompletions=["A"]
    const dto = serializeEngineState(state);
    expect(dto.advancingLock).toBe(true);
    expect(dto.pendingCompletions).toEqual(["A"]);

    const loaded = deserializeEngineState(dto);
    expect(loaded.advancingLock).toBe(false);
    expect(loaded.pendingCompletions).toEqual([]);
  });
});

// ── C1/R2: legacy bare joinStrategy "quorum" is normalized with a warning ────

describe("C1 — persisted joinStrategy normalization at the trust boundary", () => {
  /** Capture console.warn output around one call. */
  function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = original;
    }
  }

  /** Serialize the rich state with node A's joinStrategy overridden. */
  function withJoinStrategy(joinStrategy: unknown): string {
    const dto = serializeEngineState(buildRichState()) as unknown as Record<
      string,
      unknown
    >;
    const nodes = dto.nodes as Record<string, Record<string, unknown>>;
    return JSON.stringify({
      ...dto,
      nodes: {
        ...nodes,
        A: { ...nodes["A"], joinStrategy },
      },
    });
  }

  it('normalizes a legacy bare "quorum" to { quorum: 1 } and logs the downgrade', () => {
    const { result, warnings } = captureWarnings(() =>
      loadEngineStateFromJson(withJoinStrategy("quorum")),
    );
    expect(result).not.toBeNull();
    expect(result!.nodes.get("A")!.joinStrategy).toEqual({ quorum: 1 });
    expect(
      warnings.some(
        (w) => w.includes('legacy bare "quorum"') && w.includes('node "A"'),
      ),
    ).toBe(true);
  });

  it("still rejects a genuinely unknown joinStrategy string", () => {
    // `JOIN_STRATEGY_VALUES` must NOT be used to admit arbitrary members — the
    // declaration vocabulary contains "quorum", the persistence boundary does
    // not accept it verbatim.
    expect(loadEngineStateFromJson(withJoinStrategy("bogus"))).toBeNull();
  });

  it("admits 'all' / 'any' / a positive-integer quorum object unchanged", () => {
    const all = loadEngineStateFromJson(withJoinStrategy("all"));
    expect(all!.nodes.get("A")!.joinStrategy).toBe("all");
    const any = loadEngineStateFromJson(withJoinStrategy("any"));
    expect(any!.nodes.get("A")!.joinStrategy).toBe("any");
    const quorum = loadEngineStateFromJson(withJoinStrategy({ quorum: 3 }));
    expect(quorum!.nodes.get("A")!.joinStrategy).toEqual({ quorum: 3 });
  });
});

// ── Structured load results: loadEngineStateForResume (B stage) ─────────────
//
// The legacy loader answers one `null` for four different situations: no file,
// a corrupt file, an unsupported storage format, and a recognized file that
// needs a format migration. `loadEngineStateForResume` keeps them
// distinguishable WITHOUT changing the accepted input set — with the default
// registry exactly the same files hydrate as before — and
// `loadEngineStateFromJson` stays the null-shaped compatibility shell, so
// every existing caller keeps its exact behavior.

describe("loadEngineStateForResume — structured, non-collapsing load results", () => {
  /** The raw on-disk text of a rich, valid v2 snapshot. */
  function validRaw(): string {
    return JSON.stringify(serializeEngineState(buildRichState()));
  }

  /** The valid snapshot with its `version` field replaced (or stripped). */
  function rawWithVersion(version: unknown): string {
    const dto: Record<string, unknown> = JSON.parse(validRaw());
    if (version === undefined) {
      delete dto.version;
    } else {
      dto.version = version;
    }
    return JSON.stringify(dto);
  }

  /**
   * The valid snapshot with its `version` replaced by a RAW JSON number token.
   * Needed for values JSON.stringify cannot emit (Infinity becomes `null`).
   * The placeholder is a unique quoted string, so exactly one token is swapped.
   */
  function rawWithVersionLiteral(token: string): string {
    const dto: Record<string, unknown> = JSON.parse(validRaw());
    dto.version = "__VERSION_TOKEN__";
    const raw = JSON.stringify(dto).replace('"__VERSION_TOKEN__"', token);
    expect(raw).toContain('"version":' + token);
    return raw;
  }

  it("a serialized snapshot still carries storage format version 2 (writer unchanged)", () => {
    expect(JSON.parse(validRaw()).version).toBe(2);
    expect(STORAGE_FORMAT_V2).toBe(2);
    expect(CURRENT_STORAGE_FORMAT).toBe(STORAGE_FORMAT_V2);
    expect(DEFAULT_STORAGE_FORMAT_REGISTRY.decoders.map((d) => d.format)).toEqual([2]);
  });

  it("valid: a round trip through serializeEngineState reports storageFormat 2", () => {
    const result = loadEngineStateForResume(validRaw());
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.storageFormat).toBe(CURRENT_STORAGE_FORMAT);
      expect(result.state.graphId).toBe("graph-1");
      const nodeA = result.state.nodes.get("A");
      expect(nodeA?.status).toBe(NodeStatus.Completed);
      // The compatibility shell returns exactly the same hydrated state.
      expect(loadEngineStateFromJson(validRaw())).toEqual(result.state);
    }
  });

  it("corrupt JSON: kind 'corrupt' with a reason, and the shell still returns null", () => {
    const raw = "{ not valid json !!";
    expect(() => loadEngineStateForResume(raw)).not.toThrow();
    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("corrupt shape: a v2 file missing `nodes` is corrupt, not absent/unsupported", () => {
    const dto: Record<string, unknown> = JSON.parse(validRaw());
    const { nodes: _nodes, ...incomplete } = dto;
    const raw = JSON.stringify(incomplete);
    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.reason).toContain("required field");
    }
    // The shell maps it to the same null it always did.
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("corrupt shape: a missing / non-numeric version is corrupt (no format discriminator)", () => {
    for (const raw of [rawWithVersion(undefined), rawWithVersion("2")]) {
      const result = loadEngineStateForResume(raw);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        expect(result.dimension).toBe("storage");
      }
      expect(loadEngineStateFromJson(raw)).toBeNull();
    }
  });

  it("illegal version identifiers are corrupt(storage) — never unsupported", () => {
    // A version identifier MUST be a positive safe integer. Every non-legal
    // value is a malformed discriminator: corrupt(storage), with a reason that
    // names what was received. The compatibility shell still answers null for
    // each, so the set of files that LOAD is unchanged.
    const cases: { label: string; raw: string; reason: string }[] = [
      { label: "missing", raw: rawWithVersion(undefined), reason: "is missing" },
      { label: "null", raw: rawWithVersion(null), reason: "is null" },
      { label: '"2"', raw: rawWithVersion("2"), reason: 'the string "2"' },
      {
        label: "2.5",
        raw: rawWithVersion(2.5),
        reason: "the non-integer number 2.5",
      },
      { label: "0", raw: rawWithVersion(0), reason: "the non-positive number 0" },
      {
        label: "-1",
        raw: rawWithVersion(-1),
        reason: "the non-positive number -1",
      },
      {
        label: "2**53",
        raw: rawWithVersion(2 ** 53),
        reason: "the unsafe integer 9007199254740992",
      },
      {
        // JSON has no Infinity token; `1e999` is a legal JSON number that
        // JSON.parse converts to Infinity.
        label: "Infinity",
        raw: rawWithVersionLiteral("1e999"),
        reason: "is Infinity",
      },
    ];
    const reasons: string[] = [];
    for (const c of cases) {
      const result = loadEngineStateForResume(c.raw);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        expect(result.dimension).toBe("storage");
        expect(result.reason).toContain(c.reason);
        reasons.push(result.reason);
      }
      expect(loadEngineStateFromJson(c.raw)).toBeNull();
    }
    // The diagnostics distinguish the cases instead of collapsing them.
    expect(new Set(reasons).size).toBe(cases.length);

    // An unknown but LEGAL identifier stays unsupported(storage)...
    const unknown = loadEngineStateForResume(rawWithVersion(7));
    expect(unknown.kind).toBe("unsupported");
    if (unknown.kind === "unsupported") {
      expect(unknown.dimension).toBe("storage");
      expect(unknown.detail).toBe("7");
    }
    expect(loadEngineStateFromJson(rawWithVersion(7))).toBeNull();
    // ...and format 2 still loads.
    expect(loadEngineStateForResume(validRaw()).kind).toBe("valid");
  });

  it("unrecognized numeric version: unsupported(storage) carrying the raw format", () => {
    const raw = rawWithVersion(7);
    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.dimension).toBe("storage");
      expect(result.detail).toBe("7"); // the RAW value, as found on disk
    }
    // Version 1 is likewise unsupported (never hydrated under a numeric rule).
    expect(loadEngineStateForResume(rawWithVersion(1)).kind).toBe("unsupported");
    // The shell collapses the non-valid kinds to null — the compat proof.
    expect(loadEngineStateFromJson(raw)).toBeNull();
    expect(loadEngineStateFromJson(rawWithVersion(1))).toBeNull();
  });

  it("migration-required: an injected MIGRATION CAPABILITY whose validateSource accepts the source", () => {
    // A registered migration capability — not list membership — is what makes
    // version 7 migratable. The body is deliberately NOT a v2 shape: proof
    // that a source format is not validated against the TARGET layout (it
    // belongs to the other format, and the conversion owns the rest).
    const raw = JSON.stringify({ version: 7 });
    const registry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: DEFAULT_STORAGE_FORMAT_REGISTRY.decoders,
      migrations: [
        {
          from: 7,
          to: STORAGE_FORMAT_V2,
          validateSource: () => ({ ok: true }),
          migrate: (parsed) => parsed,
        },
      ],
    });
    const result = loadEngineStateForResume(raw, undefined, registry);
    expect(result.kind).toBe("migration-required");
    if (result.kind === "migration-required") {
      expect(result.dimension).toBe("storage");
      expect(result.from).toBe(7);
      expect(result.to).toBe(STORAGE_FORMAT_V2);
    }
    // Same input under the shipped registry: unsupported — no decoder and no
    // migration capability is installed for 7.
    expect(loadEngineStateForResume(raw).kind).toBe("unsupported");
    // The shell returns null for the migration-required file too.
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("migration semantics: a source that fails its OWN validation is corrupt, never migration-required", () => {
    const raw = JSON.stringify({ version: 7 });
    const registry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: DEFAULT_STORAGE_FORMAT_REGISTRY.decoders,
      migrations: [
        {
          from: 7,
          to: STORAGE_FORMAT_V2,
          validateSource: () => ({
            ok: false,
            reason: "format 7 requires a root object",
          }),
          migrate: (parsed) => parsed,
        },
      ],
    });
    const result = loadEngineStateForResume(raw, undefined, registry);
    // NOT migration-required: there is no safe conversion to promise for a
    // body that violates the format it claims to be.
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.dimension).toBe("storage");
      // The SOURCE-validation reason is surfaced, and the diagnostic names the
      // source format whose check failed.
      expect(result.reason).toContain("format 7 requires a root object");
      expect(result.reason).toContain("migration source (format 7)");
    }
    // The null-shaped shell collapses it like every other corrupt file.
    expect(loadEngineStateFromJson(raw)).toBeNull();
  });

  it("migration semantics: a validateSource that THROWS is corrupt, not a loader failure", () => {
    const raw = JSON.stringify({ version: 7 });
    const registry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: DEFAULT_STORAGE_FORMAT_REGISTRY.decoders,
      migrations: [
        {
          from: 7,
          to: STORAGE_FORMAT_V2,
          validateSource: () => {
            throw new Error("boom");
          },
          migrate: (parsed) => parsed,
        },
      ],
    });
    // Total hydration holds even for a hostile capability: the loader contains
    // the throw instead of letting it escape as a loader failure.
    expect(() => loadEngineStateForResume(raw, undefined, registry)).not.toThrow();
    const result = loadEngineStateForResume(raw, undefined, registry);
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.dimension).toBe("storage");
      expect(result.reason).toContain("validateSource threw: boom");
    }
  });

  it("classifyStorageFormat is pure and capability-driven (never a numeric rule)", () => {
    // A value that is not a positive safe integer is an ILLEGAL identifier →
    // `invalid`, carrying the raw value. 0 / -1 / 2**53 are the cases the old
    // rule mismapped to `unsupported`: malformed discriminators, not unknown
    // formats.
    for (const raw of [undefined, null, "2", 2.5, 0, -1, 2 ** 53, {}, [], true]) {
      const verdict = classifyStorageFormat(raw, DEFAULT_STORAGE_FORMAT_REGISTRY);
      expect(verdict.kind).toBe("invalid");
      if (verdict.kind === "invalid") {
        expect(verdict.value).toBe(raw);
      }
    }
    // NaN needs its own comparison (and never arrives through JSON text:
    // JSON has no NaN token, so the classifier is the boundary that owns it).
    expect(classifyStorageFormat(NaN, DEFAULT_STORAGE_FORMAT_REGISTRY)).toEqual({
      kind: "invalid",
      value: NaN,
    });
    expect(
      classifyStorageFormat(Infinity, DEFAULT_STORAGE_FORMAT_REGISTRY),
    ).toEqual({ kind: "invalid", value: Infinity });
    expect(
      classifyStorageFormat(-Infinity, DEFAULT_STORAGE_FORMAT_REGISTRY).kind,
    ).toBe("invalid");
    // 2 → the registered format-2 DECODER, carried by the verdict.
    const decodable = classifyStorageFormat(
      STORAGE_FORMAT_V2,
      DEFAULT_STORAGE_FORMAT_REGISTRY,
    );
    expect(decodable.kind).toBe("decodable");
    if (decodable.kind === "decodable") {
      expect(decodable.format).toBe(STORAGE_FORMAT_V2);
      expect(decodable.decoder).toBe(
        DEFAULT_STORAGE_FORMAT_REGISTRY.decoders[0],
      );
    }
    // 1 is in NEITHER capability set — no "less than current" rule.
    expect(
      classifyStorageFormat(1, DEFAULT_STORAGE_FORMAT_REGISTRY),
    ).toEqual({ kind: "unsupported", format: 1 });
    // The shipped registry registers no migrations.
    expect(DEFAULT_STORAGE_FORMAT_REGISTRY.migrations).toEqual([]);
    // An injected migration CAPABILITY is what makes the branch reachable —
    // and the verdict carries that capability, not just the number.
    const migration: StorageFormatMigration = {
      from: 1,
      to: STORAGE_FORMAT_V2,
      validateSource: () => ({ ok: true }),
      migrate: (parsed) => parsed,
    };
    const withMigration = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: DEFAULT_STORAGE_FORMAT_REGISTRY.decoders,
      migrations: [migration],
    });
    const migratable = classifyStorageFormat(1, withMigration);
    expect(migratable.kind).toBe("migratable");
    if (migratable.kind === "migratable") {
      expect(migratable.from).toBe(1);
      expect(migratable.to).toBe(STORAGE_FORMAT_V2);
      expect(migratable.migration).toBe(migration);
    }
  });

  it("the default registry is deeply frozen: both capability arrays reject mutation", () => {
    expect(Object.isFrozen(DEFAULT_STORAGE_FORMAT_REGISTRY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STORAGE_FORMAT_REGISTRY.decoders)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STORAGE_FORMAT_REGISTRY.migrations)).toBe(
      true,
    );
    // The registered capability itself is frozen too — a decoder cannot be
    // swapped after the registry that installed it exists.
    expect(Object.isFrozen(DEFAULT_STORAGE_FORMAT_REGISTRY.decoders[0])).toBe(
      true,
    );

    // bun runs modules in strict mode, so a write to a frozen array throws
    // (TypeError). A runtime that silently ignored it instead would leave the
    // array unchanged — either way the loader's accepted set must not move;
    // widening support stays the injectable `registry` parameter's job.
    let threw = false;
    try {
      Object.assign(DEFAULT_STORAGE_FORMAT_REGISTRY.decoders, [
        { format: 3, decode: () => ({ kind: "invalid", reason: "no" }) },
      ]);
      Object.assign(DEFAULT_STORAGE_FORMAT_REGISTRY.migrations, []);
    } catch {
      threw = true;
    }
    const arraysUnchanged =
      DEFAULT_STORAGE_FORMAT_REGISTRY.decoders.length === 1 &&
      DEFAULT_STORAGE_FORMAT_REGISTRY.decoders[0].format === STORAGE_FORMAT_V2 &&
      DEFAULT_STORAGE_FORMAT_REGISTRY.migrations.length === 0;
    expect(threw || arraysUnchanged).toBe(true);
    expect(DEFAULT_STORAGE_FORMAT_REGISTRY.decoders.map((d) => d.format)).toEqual(
      [STORAGE_FORMAT_V2],
    );
    expect(DEFAULT_STORAGE_FORMAT_REGISTRY.migrations).toEqual([]);
    // Observable classification is unchanged: the rejected write did not make
    // 3 decodable or migratable.
    expect(
      classifyStorageFormat(3, DEFAULT_STORAGE_FORMAT_REGISTRY),
    ).toEqual({ kind: "unsupported", format: 3 });
  });

  it("capability, not membership: a registered decoder for format 9 is ROUTED TO, not reported unsupported", () => {
    // The body is not a v2 shape at all — proof that the loader dispatched to
    // the registered decoder instead of validating it against format 2.
    const state = buildRichState();
    // B3: a decoded record must resolve its own protocol identity. This test
    // decoder stands in for a format whose record carries one explicitly —
    // only the format-2 decoder may BACKFILL the legacy identity, and the
    // absent-identity probe lives in the execution-protocol describe below.
    state.executionProtocolVersion = LEGACY_SIGNAL_PROTOCOL;
    const decoder: StorageFormatDecoder = {
      format: 9,
      decode: () => ({ kind: "ok", state }),
    };
    const registry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: [...DEFAULT_STORAGE_FORMAT_REGISTRY.decoders, decoder],
    });
    const routed = loadEngineStateForResume(
      JSON.stringify({ version: 9, anything: true }),
      undefined,
      registry,
    );
    expect(routed.kind).toBe("valid");
    if (routed.kind === "valid") {
      expect(routed.storageFormat).toBe(9);
      expect(routed.state).toBe(state);
    }

    // The decoder's OWN invalid verdict reaches the caller as corrupt(storage)
    // — a rejected body is corrupt data, not a missing capability.
    const rejecting: StorageFormatDecoder = {
      format: 10,
      decode: () => ({
        kind: "invalid",
        reason: "format 10 needs a root object",
      }),
    };
    const rejectingRegistry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: [...DEFAULT_STORAGE_FORMAT_REGISTRY.decoders, rejecting],
    });
    const rejected = loadEngineStateForResume(
      JSON.stringify({ version: 10 }),
      undefined,
      rejectingRegistry,
    );
    expect(rejected.kind).toBe("corrupt");
    if (rejected.kind === "corrupt") {
      expect(rejected.dimension).toBe("storage");
      expect(rejected.reason).toBe("format 10 needs a root object");
    }

    // A version with NEITHER capability stays unsupported: a number alone
    // never becomes support, even in a registry that installs other formats.
    expect(
      loadEngineStateForResume(
        JSON.stringify({ version: 7 }),
        undefined,
        registry,
      ),
    ).toEqual({ kind: "unsupported", dimension: "storage", detail: "7" });
  });
});

// ── B2: the factory refuses capability sets that would make support ambiguous ─

describe("createStorageFormatRegistry — capability registration (B2)", () => {
  /** A decoder capability for one format; the body itself is irrelevant here. */
  function decoder(format: number): StorageFormatDecoder {
    return {
      format,
      decode: () => ({
        kind: "invalid",
        reason: `format ${format} body rejected`,
      }),
    };
  }

  /** A migration capability from `from` to `to` that accepts any source. */
  function migration(from: number, to: number): StorageFormatMigration {
    return {
      from,
      to,
      validateSource: () => ({ ok: true }),
      migrate: (parsed) => parsed,
    };
  }

  it("rejects a duplicate decoder format — one format has one decode owner", () => {
    expect(() =>
      createStorageFormatRegistry({
        current: STORAGE_FORMAT_V2,
        decoders: [decoder(STORAGE_FORMAT_V2), decoder(STORAGE_FORMAT_V2)],
      }),
    ).toThrow(/duplicate decoder/);
  });

  it("rejects a duplicate migration source — one source has one converter", () => {
    expect(() =>
      createStorageFormatRegistry({
        current: STORAGE_FORMAT_V2,
        decoders: [decoder(STORAGE_FORMAT_V2)],
        migrations: [
          migration(1, STORAGE_FORMAT_V2),
          migration(1, STORAGE_FORMAT_V2),
        ],
      }),
    ).toThrow(/duplicate migration source/);
  });

  it("rejects a migration whose target has no decoder — a dead-end conversion", () => {
    expect(() =>
      createStorageFormatRegistry({
        current: STORAGE_FORMAT_V2,
        decoders: [decoder(STORAGE_FORMAT_V2)],
        migrations: [migration(1, 9)],
      }),
    ).toThrow(/no decoder/);
  });

  it("rejects a format that is both decodable and a migration source", () => {
    expect(() =>
      createStorageFormatRegistry({
        current: STORAGE_FORMAT_V2,
        decoders: [decoder(STORAGE_FORMAT_V2), decoder(7)],
        migrations: [migration(7, STORAGE_FORMAT_V2)],
      }),
    ).toThrow(/both decodable and a migration source/);
  });
});

// ── EnginePersistence.loadForResume: the store keeps the kinds apart ────────

describe("EnginePersistence.loadForResume — non-collapsing store results", () => {
  let dir: string;
  let store: EnginePersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-persist-resume-"));
    store = new EnginePersistence(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps ENOENT to absent, corrupt text to corrupt, and a valid file to valid", () => {
    expect(store.loadForResume("never-written").kind).toBe("absent");

    const corruptPath = engineStatePath(dir, "graph-corrupt");
    mkdirSync(join(corruptPath, ".."), { recursive: true });
    writeFileSync(corruptPath, "{ not valid json !!");
    expect(store.loadForResume("graph-corrupt").kind).toBe("corrupt");

    store.save(buildRichState());
    const valid = store.loadForResume("graph-1");
    expect(valid.kind).toBe("valid");
    if (valid.kind === "valid") {
      expect(valid.storageFormat).toBe(CURRENT_STORAGE_FORMAT);
      expect(valid.state.graphId).toBe("graph-1");
    }
    // The legacy null-only method keeps its exact contract.
    expect(store.load("graph-1")).not.toBeNull();
  });

  it("rethrows a non-ENOENT read failure (EISDIR) instead of reporting absent", () => {
    const path = engineStatePath(dir, "graph-dir");
    mkdirSync(path, { recursive: true });
    expect(() => store.loadForResume("graph-dir")).toThrow();
  });
});

// ── Execution-protocol identity (B3): bound at load, refused when unregistered ─
//
// The protocol axis is decided by exact handler REGISTRATION, never by
// comparing a persisted number with a latest-version constant. The format-2
// decoder is the only component allowed to backfill the legacy identity for an
// absent field (format 2 IS the legacy layout); every other identity — and any
// illegal value — is refused at load, so a protocol-2 graph is never run under
// legacy rules.

describe("loadEngineStateForResume — execution-protocol identity (B3)", () => {
  /** The raw on-disk text of a rich, valid v2 snapshot (no protocol field). */
  function validRaw(): string {
    return JSON.stringify(serializeEngineState(buildRichState()));
  }

  /** The valid snapshot with its protocol field set (or removed). */
  function rawWithProtocol(protocol: unknown): string {
    const dto: Record<string, unknown> = JSON.parse(validRaw());
    if (protocol === undefined) {
      delete dto.executionProtocolVersion;
    } else {
      dto.executionProtocolVersion = protocol;
    }
    return JSON.stringify(dto);
  }

  it("absence backfills legacy: a v2 file without the field binds protocol 1", () => {
    const raw = validRaw();
    expect(
      (JSON.parse(raw) as Record<string, unknown>).executionProtocolVersion,
    ).toBeUndefined();
    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      // The loader answers the BOUND protocol...
      expect(result.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      // ...and the hydrated state carries it explicitly.
      expect(result.state.executionProtocolVersion).toBe(LEGACY_SIGNAL_PROTOCOL);
      // Acceptance is unchanged: the compatibility shell still returns the
      // same state, so no existing caller loses a resume.
      expect(loadEngineStateFromJson(raw)).toEqual(result.state);
      expect(loadEngineStateFromJson(raw)).not.toBeNull();
    }
  });

  it("explicit legacy: a file carrying executionProtocolVersion 1 loads identically", () => {
    const explicit = loadEngineStateForResume(
      rawWithProtocol(LEGACY_SIGNAL_PROTOCOL),
    );
    expect(explicit.kind).toBe("valid");
    if (explicit.kind === "valid") {
      expect(explicit.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      expect(explicit.state.executionProtocolVersion).toBe(
        LEGACY_SIGNAL_PROTOCOL,
      );
    }
    // Backfilled and explicit legacy hydrate to the SAME state.
    expect(
      loadEngineStateFromJson(rawWithProtocol(LEGACY_SIGNAL_PROTOCOL)),
    ).toEqual(loadEngineStateFromJson(validRaw()));
  });

  it("unregistered protocol: protocol 2 is refused at load, never run under legacy rules", () => {
    const raw = rawWithProtocol(OUTCOME_PROTOCOL);
    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      // The first reachable use of the EXECUTION dimension: the storage
      // dimension stays what it is.
      expect(result.dimension).toBe("execution");
      expect(result.detail).toBe(String(OUTCOME_PROTOCOL));
    }
    // Nothing hydrates and the shell refuses: the LOAD boundary is the gate.
    expect(loadEngineStateFromJson(raw)).toBeNull();
    // Naming the identity does not make it runnable: no handler is registered
    // for it, and the verdict carries a number, not a capability.
    expect(
      classifyExecutionProtocol(OUTCOME_PROTOCOL, LEGACY_EXECUTION_PROTOCOL_REGISTRY),
    ).toEqual({ kind: "unsupported", version: OUTCOME_PROTOCOL });
    expect(
      LEGACY_EXECUTION_PROTOCOL_REGISTRY.handlers.map((h) => h.version),
    ).toEqual([LEGACY_SIGNAL_PROTOCOL]);
  });

  it("illegal identities are corrupt(execution) with distinct reasons, shell null", () => {
    const cases: { label: string; raw: string; reason: string }[] = [
      { label: "0", raw: rawWithProtocol(0), reason: "is the non-positive number 0" },
      { label: "-1", raw: rawWithProtocol(-1), reason: "is the non-positive number -1" },
      { label: "1.5", raw: rawWithProtocol(1.5), reason: "is the non-integer number 1.5" },
      { label: '"1"', raw: rawWithProtocol("1"), reason: "is the string" },
      { label: "null", raw: rawWithProtocol(null), reason: "is null" },
      {
        label: "2**53",
        raw: rawWithProtocol(2 ** 53),
        reason: "is the unsafe integer 9007199254740992",
      },
    ];
    const reasons: string[] = [];
    for (const c of cases) {
      const result = loadEngineStateForResume(c.raw);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        expect(result.dimension).toBe("execution");
        expect(result.reason).toContain(c.reason);
        reasons.push(result.reason);
      }
      // The shell refuses every one of them — acceptance is not widened.
      expect(loadEngineStateFromJson(c.raw)).toBeNull();
    }
    // Each defect reads differently: distinct diagnostics, not one reason.
    expect(new Set(reasons).size).toBe(cases.length);
    // The storage discriminator is untouched: a legal v2 file still loads.
    expect(loadEngineStateForResume(validRaw()).kind).toBe("valid");
  });

  it("a non-legacy decoder does NOT inherit the backfill: an absent identity is corrupt", () => {
    // Format 8 is a registered capability whose record carries no protocol
    // identity. Only the format-2 decoder may infer the legacy protocol, so
    // this must be corrupt(execution) — never a silent legacy run.
    const state = buildRichState(); // deliberately no executionProtocolVersion
    const decoder: StorageFormatDecoder = {
      format: 8,
      decode: () => ({ kind: "ok", state }),
    };
    const registry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: [...DEFAULT_STORAGE_FORMAT_REGISTRY.decoders, decoder],
    });
    const result = loadEngineStateForResume(
      JSON.stringify({ version: 8 }),
      undefined,
      registry,
    );
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.dimension).toBe("execution");
      expect(result.reason).toContain("execution protocol version is missing");
    }
  });

  it("round-trip: a hydrated state re-serialized and re-loaded keeps protocol 1", () => {
    const first = loadEngineStateForResume(validRaw());
    expect(first.kind).toBe("valid");
    if (first.kind !== "valid") return;
    const reserialized = JSON.stringify(serializeEngineState(first.state));
    // The identity is durable state, not a load-time decoration.
    expect(
      (JSON.parse(reserialized) as Record<string, unknown>).executionProtocolVersion,
    ).toBe(LEGACY_SIGNAL_PROTOCOL);
    const second = loadEngineStateForResume(reserialized);
    expect(second.kind).toBe("valid");
    if (second.kind === "valid") {
      expect(second.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
    }
  });

  it("additive only: a state that never bound an identity serializes exactly as before", () => {
    // A fresh state has no identity, so the writer emits NO key at all and the
    // on-disk JSON text is unchanged. ENGINE_PERSISTENCE_VERSION stays 2.
    const dto: Record<string, unknown> = JSON.parse(
      JSON.stringify(serializeEngineState(buildRichState())),
    );
    expect("executionProtocolVersion" in dto).toBe(false);
    expect(dto.version).toBe(ENGINE_PERSISTENCE_VERSION);
    expect(ENGINE_PERSISTENCE_VERSION).toBe(2);
  });

  it("empty handler registry: even protocol 1 becomes unsupported — no membership shortcut", () => {
    const empty = createExecutionProtocolRegistry({ handlers: [] });
    expect(classifyExecutionProtocol(LEGACY_SIGNAL_PROTOCOL, empty)).toEqual({
      kind: "unsupported",
      version: LEGACY_SIGNAL_PROTOCOL,
    });
    // The format-2 backfill only NAMES the identity; it installs no handler,
    // so the load is still refused under a registry that has none.
    const result = loadEngineStateForResume(
      validRaw(),
      undefined,
      DEFAULT_STORAGE_FORMAT_REGISTRY,
      empty,
    );
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.dimension).toBe("execution");
      expect(result.detail).toBe("1");
    }
    // Under the shipped registry the same file is valid — the only difference
    // is that a handler is installed.
    expect(loadEngineStateForResume(validRaw()).kind).toBe("valid");
  });

  it("totality: a throwing handler probe is contained as corrupt(execution)", () => {
    const hostile: ExecutionProtocolRegistry = {
      handlers: [
        {
          get version(): number {
            throw new Error("probe exploded");
          },
        },
      ],
    };
    const raw = validRaw();
    expect(() =>
      loadEngineStateForResume(
        raw,
        undefined,
        DEFAULT_STORAGE_FORMAT_REGISTRY,
        hostile,
      ),
    ).not.toThrow();
    const result = loadEngineStateForResume(
      raw,
      undefined,
      DEFAULT_STORAGE_FORMAT_REGISTRY,
      hostile,
    );
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") {
      expect(result.dimension).toBe("execution");
      expect(result.reason).toContain("probe exploded");
    }
  });
});

// ── Execution-protocol registry: registration legality and frozen membership ─

describe("createExecutionProtocolRegistry — handler registration (B3)", () => {
  it("rejects a duplicate version — one exact protocol has one handler", () => {
    expect(() =>
      createExecutionProtocolRegistry({
        handlers: [{ version: 1 }, { version: 1 }],
      }),
    ).toThrow(/duplicate handler/);
  });

  it("rejects a version that is not a positive safe integer", () => {
    for (const version of [0, -1, 1.5, 2 ** 53]) {
      expect(() =>
        createExecutionProtocolRegistry({ handlers: [{ version }] }),
      ).toThrow(/positive safe integer/);
    }
    expect(() =>
      createExecutionProtocolRegistry({ handlers: [{ version: NaN }] }),
    ).toThrow(/positive safe integer/);
    expect(() =>
      createExecutionProtocolRegistry({
        handlers: [{ version: Number.POSITIVE_INFINITY }],
      }),
    ).toThrow(/positive safe integer/);
  });

  it("is deeply frozen and rejects in-place widening", () => {
    const registry = createExecutionProtocolRegistry({
      handlers: [{ version: LEGACY_SIGNAL_PROTOCOL }],
    });
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.handlers)).toBe(true);
    expect(Object.isFrozen(registry.handlers[0])).toBe(true);
    let threw = false;
    try {
      Object.assign(registry.handlers, [{ version: OUTCOME_PROTOCOL }]);
    } catch {
      threw = true;
    }
    const unchanged =
      registry.handlers.length === 1 &&
      registry.handlers[0].version === LEGACY_SIGNAL_PROTOCOL;
    expect(threw || unchanged).toBe(true);
    // Observable classification is unchanged: the rejected write did not make
    // the reserved identity runnable.
    expect(classifyExecutionProtocol(OUTCOME_PROTOCOL, registry)).toEqual({
      kind: "unsupported",
      version: OUTCOME_PROTOCOL,
    });
    // The shipped registry is frozen the same way.
    expect(Object.isFrozen(LEGACY_EXECUTION_PROTOCOL_REGISTRY)).toBe(true);
    expect(Object.isFrozen(LEGACY_EXECUTION_PROTOCOL_REGISTRY.handlers)).toBe(
      true,
    );
    expect(
      Object.isFrozen(LEGACY_EXECUTION_PROTOCOL_REGISTRY.handlers[0]),
    ).toBe(true);
  });

  it("classifyExecutionProtocol carries the matched handler (capability, not a number)", () => {
    const verdict = classifyExecutionProtocol(
      LEGACY_SIGNAL_PROTOCOL,
      LEGACY_EXECUTION_PROTOCOL_REGISTRY,
    );
    expect(verdict.kind).toBe("bound");
    if (verdict.kind === "bound") {
      expect(verdict.version).toBe(LEGACY_SIGNAL_PROTOCOL);
      // Identity is preserved: the verdict carries the SAME frozen handler.
      expect(verdict.handler).toBe(
        LEGACY_EXECUTION_PROTOCOL_REGISTRY.handlers[0],
      );
    }
    // Illegal values are invalid with the RAW value — never unsupported.
    for (const raw of [undefined, null, "1", 1.5, 0, -1, 2 ** 53, {}, [], true]) {
      const invalid = classifyExecutionProtocol(
        raw,
        LEGACY_EXECUTION_PROTOCOL_REGISTRY,
      );
      expect(invalid.kind).toBe("invalid");
      if (invalid.kind === "invalid") {
        expect(invalid.value).toBe(raw);
      }
    }
    // A legal number with no handler is unsupported — the reserved identity
    // included.
    expect(
      classifyExecutionProtocol(
        OUTCOME_PROTOCOL,
        LEGACY_EXECUTION_PROTOCOL_REGISTRY,
      ),
    ).toEqual({ kind: "unsupported", version: OUTCOME_PROTOCOL });
  });
});

// ── EnginePersistence: the protocol identity survives the store boundary ─────

describe("EnginePersistence.loadForResume — protocol identity through the store (B3)", () => {
  let dir: string;
  let store: EnginePersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-persist-proto-"));
    store = new EnginePersistence(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an existing v2 file with no protocol field loads valid with executionProtocol 1", () => {
    store.save(buildRichState());
    const result = store.loadForResume("graph-1");
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      expect(result.state.executionProtocolVersion).toBe(LEGACY_SIGNAL_PROTOCOL);
    }
    // The legacy null-only shell still returns the state.
    expect(store.load("graph-1")).not.toBeNull();
  });

  it("a persisted protocol-2 file is refused at the store boundary and not run", () => {
    store.save(buildRichState());
    const path = engineStatePath(dir, "graph-1");
    const dto: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
    dto.executionProtocolVersion = OUTCOME_PROTOCOL;
    writeFileSync(path, JSON.stringify(dto), "utf-8");

    const result = store.loadForResume("graph-1");
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.dimension).toBe("execution");
      expect(result.detail).toBe("2");
    }
    // Nothing hydrates and nothing is rewritten: the snapshot keeps its
    // identity instead of being silently downgraded to legacy.
    expect(store.load("graph-1")).toBeNull();
    expect(
      (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>)
        .executionProtocolVersion,
    ).toBe(OUTCOME_PROTOCOL);
  });
});

// ── B6: the persisted plan binding — written, verified at load, never repaired ─

describe("loadEngineStateForResume — persisted plan binding (B6)", () => {
  const CONTRACT_BODY = { outcomes: ["revise", "accepted"], policy: "strict" };
  const CONTRACT_SNAPSHOT: ContractSnapshot = {
    ref: {
      id: "contract.review",
      revision: "1",
      digest: contractDigest(CONTRACT_BODY),
    },
    body: CONTRACT_BODY,
  };
  const CONTRACT_REGISTRY = createContractRegistry({
    contracts: [CONTRACT_SNAPSHOT],
  });

  /** A one-node v3 declaration whose node binds the fixture contract. */
  function boundDeclaration(): GraphDeclarationV3 {
    return {
      version: 3,
      name: "graph-bound",
      nodes: [
        {
          id: "review",
          agent: "agent.review",
          prompt: "Review.",
          outcomes: [{ id: "accepted" }],
          contractRef: CONTRACT_SNAPSHOT.ref,
        },
      ],
      edges: [],
    };
  }

  /** Compile the fixture declaration — the plan is the binding's source. */
  function boundPlan(): CompiledPlan {
    const result = compileGraph(boundDeclaration(), {
      contracts: CONTRACT_REGISTRY,
    });
    if (!result.ok) {
      throw new Error(
        "the binding fixture must compile: " +
          result.errors.map((error) => error.code).join(", "),
      );
    }
    return result.plan;
  }

  /**
   * Derive the persistable binding from a compiled plan.
   *
   * Since B7 the revision is the COMPILED PLAN's own content address — the
   * same value `compiledPlan.planRevision` carries — and NOT a digest of this
   * record's binding body. The B6 rule that hashed
   * `{ contractSnapshots, nodeBindings }` is deleted, not renamed: one name
   * means one identity. A binding that stands ALONE keeps the revision as a
   * foreign key the load cannot resolve (there is no plan body to recompute it
   * from); when both records are present the load requires them to agree.
   */
  function bindingFromPlan(plan: CompiledPlan): PlanBinding {
    const nodeBindings: Record<string, ContractRef> = {};
    for (const node of plan.nodes) {
      if (node.contractRef !== undefined) {
        nodeBindings[node.id] = node.contractRef;
      }
    }
    return {
      planRevision: plan.planRevision,
      contractSnapshots: plan.contractSnapshots,
      nodeBindings,
    };
  }

  const plan = boundPlan();
  const binding = bindingFromPlan(plan);
  const contractKey = CONTRACT_SNAPSHOT.ref.digest;

  /** A state whose node set contains the binding's one bound node. */
  function boundState(): EngineState {
    const state = createEngineState(
      {
        version: 2,
        name: "graph-bound",
        nodes: [{ id: "review", agent: "agent.review", prompt: "Review." }],
        edges: [],
      },
      "graph-bound",
    );
    provision(state);
    state.planBinding = binding;
    return state;
  }

  /** The serialized on-disk text of the bound state. */
  function boundRaw(): string {
    return JSON.stringify(serializeEngineState(boundState()));
  }

  /** The mutable binding shape a tamper case edits. */
  interface MutableBinding {
    planRevision?: string;
    contractSnapshots: Record<string, ContractSnapshot>;
    nodeBindings: Record<string, ContractRef>;
  }

  /**
   * Parse the valid bound file, let `mutate` tamper with it, and re-serialize.
   * A fixture file without a binding would make a tamper case unsatisfiable, so
   * that is asserted before the mutation.
   */
  function tamperedRaw(mutate: (binding: MutableBinding) => void): string {
    const file = JSON.parse(boundRaw()) as { planBinding: MutableBinding };
    const planBinding: MutableBinding | undefined = file.planBinding;
    if (planBinding === undefined) {
      throw new Error("the fixture file must carry a planBinding");
    }
    mutate(planBinding);
    return JSON.stringify(file);
  }

  it("round-trips a compiler-produced binding: serialize -> load -> valid, deep-equal", () => {
    const state = boundState();
    expect(state.planBinding).toEqual(binding);
    // B7 re-meaning: the revision IS the compiled plan's content address —
    // not a digest of the binding body the state happens to carry.
    expect(binding.planRevision).toBe(plan.planRevision);

    const raw = boundRaw();
    expect("planBinding" in (JSON.parse(raw) as Record<string, unknown>)).toBe(
      true,
    );

    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.storageFormat).toBe(CURRENT_STORAGE_FORMAT);
      expect(result.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      // The reloaded binding is deep-equal to the one the plan produced.
      expect(result.state.planBinding).toEqual(binding);
    }
    // The null-only compatibility shell still returns the same state.
    const shell = loadEngineStateFromJson(raw);
    expect(shell).not.toBeNull();
    expect(shell?.planBinding).toEqual(binding);
  });

  it("round-trips a binding whose contract body carries -0: the writer's output is loadable", () => {
    // -0 is the one value JSON text cannot preserve: JSON.stringify(-0) is "0".
    // The canonical digest is JSON-stable for it, so the state a writer
    // produces from a -0 body re-hashes to the SAME revision and digest at
    // load. Without that, this binding would serialize as 0 and be refused as
    // corrupt(contract) — a writer producing its own unloadable state.
    const body = { threshold: -0, label: "z" };
    const snapshot: ContractSnapshot = {
      ref: { id: "contract.zero", revision: "1", digest: contractDigest(body) },
      body,
    };
    const compiled = compileGraph(
      {
        version: 3,
        name: "graph-zero",
        nodes: [
          {
            id: "review",
            agent: "agent.review",
            prompt: "Review.",
            outcomes: [{ id: "accepted" }],
            contractRef: snapshot.ref,
          },
        ],
        edges: [],
      },
      { contracts: createContractRegistry({ contracts: [snapshot] }) },
    );
    if (!compiled.ok) {
      throw new Error(
        "the -0 fixture must compile: " +
          compiled.errors.map((error) => error.code).join(", "),
      );
    }
    const zeroBinding = bindingFromPlan(compiled.plan);
    const state = createEngineState(
      {
        version: 2,
        name: "graph-zero",
        nodes: [{ id: "review", agent: "agent.review", prompt: "Review." }],
        edges: [],
      },
      "graph-zero",
    );
    provision(state);
    state.planBinding = zeroBinding;

    const raw = JSON.stringify(serializeEngineState(state));
    // The writer stores JSON's own text: the sign of zero is gone.
    expect(raw).toContain('"threshold":0');

    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      const reloaded =
        result.state.planBinding?.contractSnapshots[snapshot.ref.digest];
      expect(reloaded?.ref).toEqual(snapshot.ref);
      // -0 and 0 are the same JSON value, which is why the digest conflates
      // them: the reloaded body is the STORED body, and it verifies.
      expect(reloaded?.body).toEqual({ threshold: 0, label: "z" });
      expect(result.state.planBinding?.planRevision).toBe(
        zeroBinding.planRevision,
      );
    }
    expect(loadEngineStateFromJson(raw)).not.toBeNull();
  });

  // Since B7 a LONE binding's planRevision is a foreign key into a plan record
  // the state does not carry, so it is only required to be a non-empty string
  // here; the B6 binding-body digest rule is gone. Agreement between the two
  // records is covered by the B7 suite below.
  it("tampering (a)-(d) is corrupt(contract) with a distinct reason and shell null", () => {
    const cases: { label: string; raw: string; reason: string }[] = [
      {
        label: "(a) empty planRevision",
        raw: tamperedRaw((b) => {
          b.planRevision = "";
        }),
        reason: 'planRevision is "", not a non-empty string',
      },
      {
        label: "(a) missing planRevision",
        raw: tamperedRaw((b) => {
          delete b.planRevision;
        }),
        reason: "planRevision is undefined, not a non-empty string",
      },
      {
        label: "(b) snapshot body no longer hashes to its key",
        raw: tamperedRaw((b) => {
          b.contractSnapshots[contractKey] = {
            ref: CONTRACT_SNAPSHOT.ref,
            body: { tampered: true },
          };
        }),
        reason: `contract snapshot "${contractKey}" body hashes to`,
      },
      {
        label: "(b) snapshot ref.digest disagrees with its key",
        raw: tamperedRaw((b) => {
          b.contractSnapshots[contractKey] = {
            ref: { ...CONTRACT_SNAPSHOT.ref, digest: "0".repeat(64) },
            body: CONTRACT_SNAPSHOT.body,
          };
        }),
        reason: "declares ref.digest",
      },
      {
        label: "(b) one (id, revision) identity carries two digests",
        raw: tamperedRaw((b) => {
          // The shape createContractRegistry refuses: a second digest for the
          // SAME (id, revision). The node is rebound to the new digest so the
          // snapshot and binding rules all pass, and ONLY the
          // identity-uniqueness rule can catch this file.
          const otherBody = { ...CONTRACT_BODY, policy: "lenient" };
          const otherDigest = contractDigest(otherBody);
          b.contractSnapshots[otherDigest] = {
            ref: { ...CONTRACT_SNAPSHOT.ref, digest: otherDigest },
            body: otherBody,
          };
          b.nodeBindings["review"] = {
            ...CONTRACT_SNAPSHOT.ref,
            digest: otherDigest,
          };
        }),
        reason: "one exact (id, revision) identity has exactly one snapshot",
      },
      {
        label: "(c) bound digest is not in contractSnapshots",
        raw: tamperedRaw((b) => {
          b.contractSnapshots = {};
        }),
        reason: "which contractSnapshots does not contain",
      },
      {
        label: "(c) bound ref differs from the snapshot ref",
        raw: tamperedRaw((b) => {
          b.nodeBindings["review"] = {
            ...CONTRACT_SNAPSHOT.ref,
            id: "contract.other",
          };
        }),
        reason: "but the snapshot at digest",
      },
      {
        label: "(d) binding names a node the state does not declare",
        raw: tamperedRaw((b) => {
          b.nodeBindings["ghost"] = { ...CONTRACT_SNAPSHOT.ref };
        }),
        reason: 'node id "ghost", which the persisted state does not declare',
      },
    ];

    const reasons: string[] = [];
    for (const c of cases) {
      const result = loadEngineStateForResume(c.raw);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        // The contract dimension's first producer: each failure is attributed
        // to the binding gate, never folded into the storage axis.
        expect(result.dimension).toBe("contract");
        expect(result.reason).toContain(c.reason);
        reasons.push(result.reason);
      }
      // Non-executable: the null-only shell refuses every tampered file too.
      expect(loadEngineStateFromJson(c.raw)).toBeNull();
    }
    // Every check reads differently — a collapsed reason would hide which
    // invariant a file broke.
    expect(new Set(reasons).size).toBe(cases.length);
    // The untampered file still loads: the refusal is caused by the tampering.
    expect(loadEngineStateForResume(boundRaw()).kind).toBe("valid");
  });

  it("a present but malformed binding is corrupt(contract), never ignored", () => {
    const cases: { label: string; bindingValue: unknown; reason: string }[] = [
      { label: "null", bindingValue: null, reason: "not a record of" },
      { label: "number", bindingValue: 7, reason: "not a record of" },
      {
        label: "array contractSnapshots",
        bindingValue: {
          planRevision: "x",
          contractSnapshots: [],
          nodeBindings: {},
        },
        reason: "contractSnapshots is not a record",
      },
      {
        label: "string nodeBindings",
        bindingValue: {
          planRevision: "x",
          contractSnapshots: {},
          nodeBindings: "nope",
        },
        reason: "nodeBindings is not a record",
      },
    ];
    for (const c of cases) {
      const dto: Record<string, unknown> = JSON.parse(boundRaw());
      dto.planBinding = c.bindingValue;
      const raw = JSON.stringify(dto);
      const result = loadEngineStateForResume(raw);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        expect(result.dimension).toBe("contract");
        expect(result.reason).toContain(c.reason);
      }
      expect(loadEngineStateFromJson(raw)).toBeNull();
    }
  });

  it("an absent binding is legal: no key is written and the load is unchanged", () => {
    const state = buildRichState();
    expect(state.planBinding).toBeUndefined();
    const raw = JSON.stringify(serializeEngineState(state));
    // The writer emits NO key at all, so a graph without a binding serializes
    // exactly as it did before this field existed.
    expect(raw).not.toContain('"planBinding"');
    expect(JSON.parse(raw).version).toBe(ENGINE_PERSISTENCE_VERSION);
    expect(ENGINE_PERSISTENCE_VERSION).toBe(2);

    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.storageFormat).toBe(CURRENT_STORAGE_FORMAT);
      // The B3 protocol backfill is untouched by this slice.
      expect(result.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      expect(result.state.planBinding).toBeUndefined();
    }
    expect(loadEngineStateFromJson(raw)).not.toBeNull();
  });

  it("totality: a hostile binding is corrupt(contract), never a throw", () => {
    // JSON TEXT cannot carry a getter, a Proxy or a cycle, so these shapes are
    // only reachable in memory: the registered format-2 decoder (the exact
    // object the loader routes to) and the verification step it calls are
    // driven directly here.
    const decoder = DEFAULT_STORAGE_FORMAT_REGISTRY.decoders[0];
    expect(decoder.format).toBe(STORAGE_FORMAT_V2);
    const nodeIds: ReadonlySet<string> = new Set(["review"]);

    const hostile: {
      label: string;
      boom: string;
      arm: (snapshot: Record<string, unknown>) => void;
    }[] = [
      {
        label: "throwing getter on the snapshot body",
        boom: "boom-body",
        arm: (snapshot) => {
          Object.defineProperty(snapshot, "body", {
            get() {
              throw new Error("boom-body");
            },
            enumerable: true,
            configurable: true,
          });
        },
      },
      {
        label: "cyclic body",
        boom: "reference cycle",
        arm: (snapshot) => {
          const cycle: Record<string, unknown> = {};
          cycle.self = cycle;
          snapshot.body = cycle;
        },
      },
      {
        label: "Proxy body",
        boom: "boom-proxy",
        arm: (snapshot) => {
          snapshot.body = new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error("boom-proxy");
              },
            },
          );
        },
      },
      {
        label: "BigInt body (unrepresentable to the canonical digest)",
        boom: "BigInt",
        arm: (snapshot) => {
          snapshot.body = 1n;
        },
      },
      {
        label: "function body (executable, never contract data)",
        boom: "function",
        arm: (snapshot) => {
          snapshot.body = () => "not contract data";
        },
      },
    ];

    for (const c of hostile) {
      const file: Record<string, unknown> = JSON.parse(boundRaw());
      const rawBinding = file.planBinding;
      if (rawBinding === undefined) {
        throw new Error("the fixture file must carry a planBinding");
      }
      const planBinding = rawBinding as {
        contractSnapshots: Record<string, Record<string, unknown>>;
      };
      const snapshot = planBinding.contractSnapshots[contractKey];
      expect(snapshot).toBeDefined();
      c.arm(snapshot);

      // The exported verification step: a corrupt verdict, never an escape.
      expect(() =>
        verifyPersistedPlanBinding(planBinding, nodeIds),
      ).not.toThrow();
      const verdict = verifyPersistedPlanBinding(planBinding, nodeIds);
      expect(verdict.kind).toBe("corrupt");
      if (verdict.kind === "corrupt") {
        expect(verdict.dimension).toBe("contract");
        expect(verdict.reason).toContain(contractKey);
        expect(verdict.reason).toContain(c.boom);
      }

      // The registered decoder contains it as well and marks the axis the
      // loader maps onto corrupt(contract) for every tamper case above.
      expect(() => decoder.decode(file)).not.toThrow();
      const decoded = decoder.decode(file);
      expect(decoded.kind).toBe("invalid");
      if (decoded.kind === "invalid") {
        expect(decoded.dimension).toBe("contract");
        expect(decoded.reason).toContain(contractKey);
      }
    }
  });

  it("through the store: a verified binding survives save -> loadForResume, a tampered one is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-binding-"));
    try {
      const store = new EnginePersistence(dir);
      expect(store.save(boundState())).toBe(true);
      const loaded = store.loadForResume("graph-bound");
      expect(loaded.kind).toBe("valid");
      if (loaded.kind === "valid") {
        expect(loaded.state.planBinding).toEqual(binding);
      }

      // Tamper the file in place: the same gates run at the store boundary, the
      // snapshot is preserved rather than repaired, and the shell refuses it.
      // The tamper breaks a rule that still exists — a snapshot body that no
      // longer hashes to its key — not the deleted binding-body revision rule.
      const path = engineStatePath(dir, "graph-bound");
      const file = JSON.parse(readFileSync(path, "utf-8")) as {
        planBinding: {
          contractSnapshots: Record<string, { ref: ContractRef; body: unknown }>;
        };
      };
      const storedSnapshot = file.planBinding.contractSnapshots[contractKey];
      if (storedSnapshot === undefined) {
        throw new Error("the fixture file must carry the contract snapshot");
      }
      storedSnapshot.body = { tampered: true };
      writeFileSync(path, JSON.stringify(file), "utf-8");

      const refused = store.loadForResume("graph-bound");
      expect(refused.kind).toBe("corrupt");
      if (refused.kind === "corrupt") {
        expect(refused.dimension).toBe("contract");
      }
      expect(store.load("graph-bound")).toBeNull();
      expect(
        (
          JSON.parse(readFileSync(path, "utf-8")) as {
            planBinding: {
              contractSnapshots: Record<string, { body: unknown }>;
            };
          }
        ).planBinding.contractSnapshots[contractKey]?.body,
      ).toEqual({ tampered: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── B7: the persisted compiled plan — written, verified, cross-checked ──────

describe("loadEngineStateForResume — persisted compiled plan (B7)", () => {
  const REVIEW_BODY = { outcomes: ["revise", "accepted"], policy: "strict" };
  const APPLY_BODY = { outcomes: ["done"], policy: "lenient" };
  const REVIEW_SNAPSHOT: ContractSnapshot = {
    ref: {
      id: "contract.review",
      revision: "1",
      digest: contractDigest(REVIEW_BODY),
    },
    body: REVIEW_BODY,
  };
  const APPLY_SNAPSHOT: ContractSnapshot = {
    ref: {
      id: "contract.apply",
      revision: "2",
      digest: contractDigest(APPLY_BODY),
    },
    body: APPLY_BODY,
  };
  const CONTRACTS = createContractRegistry({
    contracts: [REVIEW_SNAPSHOT, APPLY_SNAPSHOT],
  });

  /** A two-node v3 declaration: review --accepted--> apply, both contracted. */
  function planDeclaration(): GraphDeclarationV3 {
    return {
      version: 3,
      name: "graph-plan",
      nodes: [
        {
          id: "review",
          agent: "agent.review",
          prompt: "Review.",
          outcomes: [{ id: "revise" }, { id: "accepted" }],
          completion: { mode: "natural", outcome: "accepted" },
          contractRef: REVIEW_SNAPSHOT.ref,
        },
        {
          id: "apply",
          agent: "agent.apply",
          prompt: "Apply.",
          outcomes: [{ id: "done" }],
          contractRef: APPLY_SNAPSHOT.ref,
        },
      ],
      edges: [{ from: "review", to: "apply", outcome: "accepted" }],
    };
  }

  /** Compile the fixture declaration — the plan record source. */
  function compiledPlan(): CompiledPlan {
    const result = compileGraph(planDeclaration(), { contracts: CONTRACTS });
    if (!result.ok) {
      throw new Error(
        "the plan fixture must compile: " +
          result.errors.map((error) => error.code).join(", "),
      );
    }
    return result.plan;
  }

  const plan = compiledPlan();
  const record: PersistedCompiledPlan = createPersistedCompiledPlan(plan);
  const binding: PlanBinding = {
    planRevision: plan.planRevision,
    contractSnapshots: plan.contractSnapshots,
    nodeBindings: record.nodeBindings,
  };
  const reviewKey = REVIEW_SNAPSHOT.ref.digest;
  const planNodeIds: ReadonlySet<string> = new Set(["review", "apply"]);

  /** A state whose runtime nodes match the plan topology node ids. */
  function planState(): EngineState {
    const state = createEngineState(
      {
        version: 2,
        name: "graph-plan",
        nodes: [
          { id: "review", agent: "agent.review", prompt: "Review." },
          { id: "apply", agent: "agent.apply", prompt: "Apply." },
        ],
        edges: [{ from: "review", to: "apply", type: "always" }],
      },
      "graph-plan",
    );
    provision(state);
    state.compiledPlan = record;
    state.planBinding = binding;
    return state;
  }

  /** The serialized on-disk text of the state carrying both records. */
  function planRaw(): string {
    return JSON.stringify(serializeEngineState(planState()));
  }

  /** The mutable record shapes a tamper case edits. */
  interface MutablePlanRecord {
    graphId?: string;
    declarationVersion?: number;
    planRevision?: string;
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
    loopGroups: Record<string, unknown>[];
    contractSnapshots: Record<string, unknown>;
    nodeBindings: Record<string, unknown>;
    /** Extra own keys a fidelity case adds to test the writer's copy. */
    [extra: string]: unknown;
  }

  interface MutablePlanFile {
    compiledPlan: MutablePlanRecord;
    planBinding: {
      planRevision?: string;
      contractSnapshots: Record<string, ContractSnapshot>;
      nodeBindings: Record<string, ContractRef>;
      /** Extra own keys a fidelity case adds to test the writer's copy. */
      [extra: string]: unknown;
    };
  }

  /**
   * Recompute a record plan revision over its OWN body, the way the load does.
   * A tamper case that must isolate an inner rule (topology, contracts) calls
   * this, so the failure it observes is the rule under test rather than the
   * identity gate that a body change would otherwise trip first.
   */
  function revisionOf(record: MutablePlanRecord): string {
    return contractDigest({
      graphId: record.graphId,
      declarationVersion: record.declarationVersion,
      nodes: record.nodes,
      edges: record.edges,
      loopGroups: record.loopGroups,
      contractSnapshots: record.contractSnapshots,
    });
  }

  /** Parse the valid plan file, tamper with it, and re-serialize. */
  function tamperedPlanRaw(mutate: (file: MutablePlanFile) => void): string {
    const file = JSON.parse(planRaw()) as MutablePlanFile;
    mutate(file);
    return JSON.stringify(file);
  }

  it("round-trips a compiler-produced plan record: serialize -> load -> valid, deep-equal", () => {
    // The record carries the COMPILER's own content address, computed over the
    // plan body — no second digest and no recomputation at production time.
    expect(record.planRevision).toBe(plan.planRevision);
    expect(record.planRevision).toBe(
      contractDigest({
        graphId: plan.graphId,
        declarationVersion: plan.declarationVersion,
        nodes: plan.nodes,
        edges: plan.edges,
        loopGroups: plan.loopGroups,
        contractSnapshots: plan.contractSnapshots,
      }),
    );
    // The node->contract index is a projection of the plan nodes.
    expect(record.nodeBindings).toEqual({
      review: REVIEW_SNAPSHOT.ref,
      apply: APPLY_SNAPSHOT.ref,
    });

    const raw = planRaw();
    expect("compiledPlan" in (JSON.parse(raw) as Record<string, unknown>)).toBe(
      true,
    );
    expect("planBinding" in (JSON.parse(raw) as Record<string, unknown>)).toBe(
      true,
    );

    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.storageFormat).toBe(CURRENT_STORAGE_FORMAT);
      expect(result.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      expect(result.state.compiledPlan).toEqual(record);
      expect(result.state.planBinding).toEqual(binding);
    }
    const shell = loadEngineStateFromJson(raw);
    expect(shell).not.toBeNull();
    expect(shell?.compiledPlan).toEqual(record);
    expect(shell?.planBinding).toEqual(binding);
  });

  it("the writer keeps a load-valid record key-for-key: it never drops a key its revision addresses", () => {
    // The plan revision addresses the body AS PERSISTED — contractDigest hashes
    // Object.keys, unknown own keys included. A record the load ACCEPTED
    // therefore has to survive serialize -> load: a closed-field defensive copy
    // in the writer would drop an unknown key while keeping the revision, and
    // the writer's own output would be refused as corrupt(contract) on the next
    // load (the B7 review's falsification case).
    const withExtras = tamperedPlanRaw((file) => {
      const planRecord = file.compiledPlan;
      planRecord.futureField = "kept";
      planRecord.nodes[0].futureField = "kept";
      const outcome = (
        planRecord.nodes[0].outcomes as Record<string, unknown>[]
      )[0];
      outcome.futureField = "kept";
      // Nodes are in id order, so find the bound node by id rather than index.
      const reviewNode = planRecord.nodes.find((node) => node.id === "review");
      if (reviewNode === undefined) {
        throw new Error("the fixture must declare node review");
      }
      reviewNode.contractRef = {
        ...REVIEW_SNAPSHOT.ref,
        futureField: "kept",
      };
      planRecord.edges[0].futureField = "kept";
      // A loop group the topology accepts — its members and both routes are
      // declared by the fixture — so the record stays load-valid with one.
      planRecord.loopGroups.push({
        id: "revision",
        nodes: ["review", "apply"],
        maxTraversals: 2,
        continuationOutcome: "revise",
        exitOutcome: "done",
        futureField: "kept",
      });
      planRecord.contractSnapshots[reviewKey] = {
        ...(planRecord.contractSnapshots[reviewKey] as Record<string, unknown>),
        futureField: "kept",
      };
      planRecord.nodeBindings["review"] = {
        ...REVIEW_SNAPSHOT.ref,
        futureField: "kept",
      };
      file.planBinding.futureField = "kept";
      // The revision is recomputed over the tampered body and the binding is
      // moved with it, so the file is load-valid and the only thing under test
      // is the writer's copy.
      const recomputed = revisionOf(planRecord);
      planRecord.planRevision = recomputed;
      file.planBinding.planRevision = recomputed;
    });

    const first = loadEngineStateForResume(withExtras);
    expect(first.kind).toBe("valid");
    if (first.kind !== "valid") return;
    // Vacuity guard: the unknown keys really are in the ACCEPTED record.
    const accepted = JSON.parse(
      JSON.stringify(first.state.compiledPlan),
    ) as Record<string, unknown>;
    expect(accepted.futureField).toBe("kept");
    expect(
      (accepted.nodes as Record<string, unknown>[])[0].futureField,
    ).toBe("kept");
    expect(
      (accepted.loopGroups as Record<string, unknown>[])[0].futureField,
    ).toBe("kept");

    // Rewriting the accepted state must produce a file the SAME gate accepts,
    // record for record: if the copy had projected the body, the unchanged
    // revision would no longer address the rewritten one.
    const rewritten = JSON.stringify(serializeEngineState(first.state));
    const second = loadEngineStateForResume(rewritten);
    expect(second.kind).toBe("valid");
    if (second.kind === "valid") {
      expect(second.state.compiledPlan).toEqual(first.state.compiledPlan);
      expect(second.state.planBinding).toEqual(first.state.planBinding);
    }
    expect(loadEngineStateFromJson(rewritten)).not.toBeNull();
  });

  it("the store round-trip keeps both records and verifies them", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-persist-plan-"));
    try {
      const store = new EnginePersistence(dir);
      expect(store.save(planState())).toBe(true);
      const loaded = store.loadForResume("graph-plan");
      expect(loaded.kind).toBe("valid");
      if (loaded.kind === "valid") {
        expect(loaded.state.compiledPlan).toEqual(record);
        expect(loaded.state.planBinding).toEqual(binding);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the exported gates verify a compiler-produced record alone and together with the binding", () => {
    expect(
      verifyPersistedCompiledPlan(record, "graph-plan", planNodeIds),
    ).toEqual({ kind: "verified" });
    expect(
      verifyPersistedPlan(record, binding, "graph-plan", planNodeIds),
    ).toEqual({ kind: "verified" });
    // Absent means absent — the gate fabricates nothing.
    expect(
      verifyPersistedCompiledPlan(undefined, "graph-plan", planNodeIds),
    ).toEqual({ kind: "absent" });
    expect(
      verifyPersistedPlan(undefined, undefined, "graph-plan", planNodeIds),
    ).toEqual({ kind: "absent" });
  });

  it("an absent plan record is legal: no key is written and the previous acceptance is unchanged", () => {
    const state = buildRichState();
    expect(state.compiledPlan).toBeUndefined();
    const raw = JSON.stringify(serializeEngineState(state));
    // The writer emits NO key at all, so a graph without a compiled plan
    // serializes exactly as it did before this field existed.
    expect(raw).not.toContain('"compiledPlan"');
    expect(raw).not.toContain('"planBinding"');
    expect(JSON.parse(raw).version).toBe(ENGINE_PERSISTENCE_VERSION);
    expect(ENGINE_PERSISTENCE_VERSION).toBe(2);

    const result = loadEngineStateForResume(raw);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.storageFormat).toBe(CURRENT_STORAGE_FORMAT);
      expect(result.executionProtocol).toBe(LEGACY_SIGNAL_PROTOCOL);
      expect(result.state.compiledPlan).toBeUndefined();
      expect(result.state.planBinding).toBeUndefined();
    }
    expect(loadEngineStateFromJson(raw)).not.toBeNull();
  });

  it("either record alone is legal and verified; only both together must agree", () => {
    // Plan record without a binding: the complete durable plan, verified from
    // its own body.
    const planOnly = planState();
    planOnly.planBinding = undefined;
    const rawPlanOnly = JSON.stringify(serializeEngineState(planOnly));
    expect(rawPlanOnly).toContain('"compiledPlan"');
    expect(rawPlanOnly).not.toContain('"planBinding"');
    const planResult = loadEngineStateForResume(rawPlanOnly);
    expect(planResult.kind).toBe("valid");
    if (planResult.kind === "valid") {
      expect(planResult.state.compiledPlan).toEqual(record);
      expect(planResult.state.planBinding).toBeUndefined();
    }

    // Binding without a plan record: the B6 record, verified on its own terms.
    // Its planRevision is a foreign key no plan body is present to resolve, so
    // the load verifies the snapshots and node bindings and ACCEPTS it —
    // refusing a lone binding would silently drop the set B6 accepted.
    const bindingOnly = planState();
    bindingOnly.compiledPlan = undefined;
    const rawBindingOnly = JSON.stringify(serializeEngineState(bindingOnly));
    expect(rawBindingOnly).not.toContain('"compiledPlan"');
    expect(rawBindingOnly).toContain('"planBinding"');
    const bindingResult = loadEngineStateForResume(rawBindingOnly);
    expect(bindingResult.kind).toBe("valid");
    if (bindingResult.kind === "valid") {
      expect(bindingResult.state.planBinding).toEqual(binding);
      expect(bindingResult.state.compiledPlan).toBeUndefined();
    }
    // The exported gate agrees: with no plan record to compare against, the
    // lone binding verifies.
    expect(
      verifyPersistedPlan(undefined, binding, "graph-plan", planNodeIds),
    ).toEqual({ kind: "verified" });
  });

  it("tampering each verified plan rule is corrupt(contract) with a distinct reason and shell null", () => {
    const cases: { label: string; raw: string; reason: string }[] = [
      {
        label: "planRevision does not address the persisted body",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.planRevision = "0".repeat(64);
        }),
        reason: "is not the digest (",
      },
      {
        label: "plan graphId is not the state graphId",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.graphId = "graph-other";
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason: "is not the persisted graphId",
      },
      {
        label: "plan snapshot body no longer hashes to its key",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.contractSnapshots[reviewKey] = {
            ref: REVIEW_SNAPSHOT.ref,
            body: { tampered: true },
          };
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason: `compiled plan contract snapshot "${reviewKey}" body hashes to`,
      },
      {
        label: "duplicate node id",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.nodes.push({ ...file.compiledPlan.nodes[0] });
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason: "(duplicate-node-id)",
      },
      {
        label: "edge to an unknown node",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.edges.push({
            from: "review",
            to: "ghost",
            outcome: "accepted",
          });
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason: "(unknown-edge-endpoint)",
      },
      {
        label: "edge outcome its source does not declare",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.edges.push({
            from: "apply",
            to: "review",
            outcome: "accepted",
          });
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason: "(unknown-outcome-reference)",
      },
      {
        label: "topology declares a node the state does not",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.nodes[1].id = "ghost";
          file.compiledPlan.edges = [];
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason:
          'declares node id "ghost", which the persisted state does not declare',
      },
      {
        label: "plan index disagrees with the node contractRef",
        raw: tamperedPlanRaw((file) => {
          // The plan revision does NOT cover nodeBindings, so a rebound index
          // is invisible to the identity gate — the projection rule refuses it
          // even though the ref names a snapshot the plan really pins.
          file.compiledPlan.nodeBindings["review"] = { ...APPLY_SNAPSHOT.ref };
        }),
        reason: "but the node declares",
      },
      {
        label: "plan index binds a node the topology does not declare",
        raw: tamperedPlanRaw((file) => {
          file.compiledPlan.nodes = file.compiledPlan.nodes.filter(
            (node) => node.id !== "apply",
          );
          file.compiledPlan.edges = [];
          file.compiledPlan.planRevision = revisionOf(file.compiledPlan);
        }),
        reason: "which its topology does not declare",
      },
      {
        label: "binding planRevision disagrees with the plan",
        raw: tamperedPlanRaw((file) => {
          file.planBinding.planRevision = "f".repeat(64);
        }),
        reason: "does not equal the compiled plan planRevision",
      },
      {
        label: "binding references a digest the plan does not pin",
        raw: tamperedPlanRaw((file) => {
          const body = { extra: true };
          const digest = contractDigest(body);
          file.planBinding.contractSnapshots[digest] = {
            ref: { id: "contract.extra", revision: "1", digest },
            body,
          };
        }),
        reason: "which the compiled plan contractSnapshots does not contain",
      },
      {
        label: "binding binds a node to a different ref than the plan",
        raw: tamperedPlanRaw((file) => {
          file.planBinding.nodeBindings["review"] = { ...APPLY_SNAPSHOT.ref };
        }),
        reason: "but the compiled plan binds it to",
      },
    ];

    const reasons: string[] = [];
    for (const c of cases) {
      const result = loadEngineStateForResume(c.raw);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        // Every plan-record failure is attributed to the contract gate, never
        // folded into the storage axis.
        expect(result.dimension).toBe("contract");
        expect(result.reason).toContain(c.reason);
        reasons.push(result.reason);
      }
      // Non-executable: the null-only shell refuses every tampered file too.
      expect(loadEngineStateFromJson(c.raw)).toBeNull();
    }
    // Every check reads differently — a collapsed reason would hide which
    // invariant a file broke.
    expect(new Set(reasons).size).toBe(cases.length);
    // The untampered file still loads: the refusal is caused by the tampering.
    expect(loadEngineStateForResume(planRaw()).kind).toBe("valid");
  });

  it("totality: a hostile plan record is corrupt(contract), never a throw", () => {
    // JSON TEXT cannot carry a getter, a Proxy or a cycle, so these shapes are
    // only reachable in memory: the registered format-2 decoder (the exact
    // object the loader routes to) and the exported gate are driven directly.
    const decoder = DEFAULT_STORAGE_FORMAT_REGISTRY.decoders[0];
    expect(decoder.format).toBe(STORAGE_FORMAT_V2);

    const hostile: {
      label: string;
      boom: string;
      arm: (record: MutablePlanRecord) => void;
    }[] = [
      {
        label: "throwing getter on a node id",
        boom: "boom-id",
        arm: (record) => {
          Object.defineProperty(record.nodes[0], "id", {
            get() {
              throw new Error("boom-id");
            },
            enumerable: true,
            configurable: true,
          });
        },
      },
      {
        label: "cyclic contract body",
        boom: "reference cycle",
        arm: (record) => {
          const cycle: Record<string, unknown> = {};
          cycle.self = cycle;
          record.contractSnapshots[reviewKey] = {
            ref: REVIEW_SNAPSHOT.ref,
            body: cycle,
          };
        },
      },
      {
        label: "BigInt in the plan body",
        boom: "BigInt",
        arm: (record) => {
          record.nodes[0].prompt = 1n;
        },
      },
    ];

    for (const c of hostile) {
      const file = JSON.parse(planRaw()) as MutablePlanFile;
      c.arm(file.compiledPlan);

      // The exported gate: a corrupt verdict, never an escape.
      expect(() =>
        verifyPersistedPlan(
          file.compiledPlan,
          file.planBinding,
          "graph-plan",
          planNodeIds,
        ),
      ).not.toThrow();
      const verdict = verifyPersistedPlan(
        file.compiledPlan,
        file.planBinding,
        "graph-plan",
        planNodeIds,
      );
      expect(verdict.kind).toBe("corrupt");
      if (verdict.kind === "corrupt") {
        expect(verdict.dimension).toBe("contract");
        expect(verdict.reason).toContain(c.boom);
      }

      // The registered decoder contains it as well and marks the axis the
      // loader maps onto corrupt(contract).
      expect(() => decoder.decode(file)).not.toThrow();
      const decoded = decoder.decode(file);
      expect(decoded.kind).toBe("invalid");
      if (decoded.kind === "invalid") {
        expect(decoded.dimension).toBe("contract");
      }
    }
  });
});


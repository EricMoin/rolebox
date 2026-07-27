/**
 * Graph Execution Engine v2 — Engine State Persistence
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * The unified on-disk store for {@link EngineState}. Serializes the whole
 * engine container — including the `Map` fields — into a plain, versioned JSON
 * file that a later `recover()` can hydrate back into a live engine.
 *
 * Scope:
 * - `save(state)` — write-through, synchronous, atomic (`.tmp` + `renameSync`).
 *   Called from the advancement critical section's `finally` block for
 *   crash-safe persistence of critical transitions (node lifecycle, graph
 *   phase, frontier).
 * - `load(graphId)` — read + validate; returns `null` for a missing file or a
 *   schema-version mismatch (clean start / migration point), mirroring
 *   `TaskStateStore.load()` (`src/dispatch/persistence/task-store.ts:125`).
 * - `scheduleSave(state)` — debounced (500ms) write for non-critical updates
 *   (budget samples, signal-ledger churn). Per implementation-roadmap Q2
 *   Option A: critical transitions write through; noisy updates coalesce.
 *
 * Design reference:
 * - `.rolebox/design/engine-state-machine.md` §4 (persistence model, atomic
 *   write pattern, versioned header).
 * - `.rolebox/design/implementation-roadmap.md` Q2 Option A (write-through for
 *   critical, debounce for non-critical).
 * - Atomic pattern mirrored from `src/dispatch/persistence/task-store.ts:101-108`
 *   and `persist-helpers.ts` (pattern reference only — those files are not
 *   modified).
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EnginePhase } from "../../constants.ts";
import type { GraphDeclaration } from "../../types.graph-v2.ts";
import type {
  CheckpointRecord,
  EdgePayload,
  EngineState,
  GraphBudgetState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
  SignalLedgerEntry,
} from "../../types.engine-v2.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** Schema version of the persisted engine state file. */
export const ENGINE_PERSISTENCE_VERSION = 2 as const;

/** Debounce window for non-critical state writes (ms). See Q2 Option A. */
export const NON_CRITICAL_DEBOUNCE_MS = 500 as const;

/** Characters allowed verbatim in the per-graph filename slug. */
const SAFE_SLUG = /[^A-Za-z0-9._-]/g;

// ── Serialization DTO types ─────────────────────────────────────────────────

/**
 * Flat, JSON-safe projection of {@link NodeRuntimeState}: the only structural
 * field (`upstreamResults: Map`) is flattened to a plain `Record`. Every other
 * field is already JSON-primitive (nested records/objects) and passes through.
 */
export interface NodeRuntimeStateDTO {
  nodeId: string;
  agent: string;
  prompt: string;
  needsApproval: boolean;
  status: string;
  dispatchTaskId?: string;
  dispatchSessionId?: string;
  result?: {
    sidecarPath: string;
    totalChars: number;
    hadFence: boolean;
    fetchError?: string;
    materializedAt: string;
  };
  signalsObserved: Record<string, unknown>;
  sessionsSpawned: number;
  tokensConsumed: { inputTokens: number; outputTokens: number; cost: number };
  upstreamResults: Record<string, EdgePayload>;
  joinStrategy: string | { quorum: number };
  joinSatisfied: boolean;
  loopGroupId?: string;
  traversalCount: number;
  startedAt: number;
  completedAt?: number;
  retryCount: number;
  errorReason?: string;
  // OPTIONAL-ADDITIVE (subtask 1): JSON-primitive, absent → undefined.
  artifacts?: string[];
  evidence?: string[];
}

/** Top-level on-disk schema (versioned). `Map` fields are plain `Record`s. */
export interface EnginePersistenceFile {
  version: typeof ENGINE_PERSISTENCE_VERSION;
  graphId: string;
  phase: EnginePhase;
  graphDeclaration: GraphDeclaration;
  nodes: Record<string, NodeRuntimeStateDTO>;
  edges: Record<string, EdgePayload>;
  loopGroups: Record<string, LoopGroupRuntimeState>;
  frontier: string[];
  budget: GraphBudgetState;
  signalLedger: Record<string, SignalLedgerEntry>;
  startedAt: number;
  updatedAt: number;
  advancingLock: boolean;
  pendingCompletions: string[];
  // OPTIONAL-ADDITIVE (subtask 1): absent in files authored before this field.
  checkpoints?: Record<string, CheckpointRecord>;
}

// ── Clone helpers (defensive deep-enough copies) ───────────────────────────

function cloneEdgePayload(p: EdgePayload): EdgePayload {
  return {
    ...p,
    artifacts: [...p.artifacts],
    budgetConsumed: { ...p.budgetConsumed },
  };
}

function cloneBudgetState(b: GraphBudgetState): GraphBudgetState {
  return { ...b };
}

function cloneLoopGroup(g: LoopGroupRuntimeState): LoopGroupRuntimeState {
  return {
    ...g,
    termination: g.termination ? { ...g.termination } : undefined,
    rounds: g.rounds ? g.rounds.map((r) => ({ ...r })) : undefined,
  };
}

function cloneSignalLedgerEntry(e: SignalLedgerEntry): SignalLedgerEntry {
  return {
    ...e,
    signals: { ...e.signals },
    history: e.history ? e.history.map((h) => ({ ...h })) : undefined,
  };
}

function cloneCheckpoints(
  c: Record<string, CheckpointRecord> | undefined,
): Record<string, CheckpointRecord> | undefined {
  if (!c) return undefined;
  const out: Record<string, CheckpointRecord> = {};
  for (const [id, record] of Object.entries(c)) {
    out[id] = { ...record };
  }
  return out;
}

// ── Serialize / Deserialize (pure, exportable for tests) ────────────────────

/** Flatten a live {@link EngineState} into the versioned, JSON-safe DTO. */
export function serializeEngineState(state: EngineState): EnginePersistenceFile {
  const nodes: Record<string, NodeRuntimeStateDTO> = {};
  for (const [id, n] of state.nodes) {
    const { upstreamResults, ...rest } = n;
    const ur: Record<string, EdgePayload> = {};
    for (const [fromId, payload] of upstreamResults) {
      ur[fromId] = cloneEdgePayload(payload);
    }
    nodes[id] = {
      ...rest,
      signalsObserved: { ...n.signalsObserved },
      tokensConsumed: { ...n.tokensConsumed },
      result: n.result ? { ...n.result } : undefined,
      artifacts: n.artifacts ? [...n.artifacts] : undefined,
      evidence: n.evidence ? [...n.evidence] : undefined,
      upstreamResults: ur,
    };
  }

  const edges: Record<string, EdgePayload> = {};
  for (const [key, p] of state.edges) {
    edges[key] = cloneEdgePayload(p);
  }

  const loopGroups: Record<string, LoopGroupRuntimeState> = {};
  for (const [id, g] of state.loopGroups) {
    loopGroups[id] = cloneLoopGroup(g);
  }

  const signalLedger: Record<string, SignalLedgerEntry> = {};
  for (const [id, e] of state.signalLedger) {
    signalLedger[id] = cloneSignalLedgerEntry(e);
  }

  return {
    version: ENGINE_PERSISTENCE_VERSION,
    graphId: state.graphId,
    phase: state.phase,
    graphDeclaration: state.graphDeclaration,
    nodes,
    edges,
    loopGroups,
    frontier: [...state.frontier],
    budget: cloneBudgetState(state.budget),
    signalLedger,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    advancingLock: state.advancingLock,
    pendingCompletions: [...state.pendingCompletions],
    checkpoints: cloneCheckpoints(state.checkpoints),
  };
}

/** Hydrate a live {@link EngineState} from a versioned, plain DTO. */
export function deserializeEngineState(file: EnginePersistenceFile): EngineState {
  const nodes = new Map<string, NodeRuntimeState>();
  for (const [id, dto] of Object.entries(file.nodes)) {
    const upstreamResults = new Map<string, EdgePayload>();
    for (const [fromId, payload] of Object.entries(dto.upstreamResults ?? {})) {
      upstreamResults.set(fromId, cloneEdgePayload(payload));
    }
    const { upstreamResults: _ur, ...rest } = dto;
    nodes.set(id, {
      ...rest,
      signalsObserved: { ...(rest.signalsObserved ?? {}) },
      tokensConsumed: {
        ...(rest.tokensConsumed as NodeRuntimeState["tokensConsumed"]),
      },
      result: rest.result ? { ...rest.result } : undefined,
      upstreamResults,
    } as NodeRuntimeState);
  }

  const edges = new Map<string, EdgePayload>();
  for (const [key, p] of Object.entries(file.edges)) {
    edges.set(key, cloneEdgePayload(p));
  }

  const loopGroups = new Map<string, LoopGroupRuntimeState>();
  for (const [id, g] of Object.entries(file.loopGroups)) {
    loopGroups.set(id, cloneLoopGroup(g));
  }

  const signalLedger = new Map<string, SignalLedgerEntry>();
  for (const [id, e] of Object.entries(file.signalLedger)) {
    signalLedger.set(id, cloneSignalLedgerEntry(e));
  }

  return {
    phase: file.phase,
    graphId: file.graphId,
    graphDeclaration: file.graphDeclaration,
    nodes,
    edges,
    loopGroups,
    frontier: [...file.frontier],
    budget: cloneBudgetState(file.budget),
    signalLedger,
    startedAt: file.startedAt,
    updatedAt: file.updatedAt,
    advancingLock: file.advancingLock,
    pendingCompletions: [...file.pendingCompletions],
    checkpoints: cloneCheckpoints(file.checkpoints),
  } as EngineState;
}

// ── Path helpers ────────────────────────────────────────────────────────────

/**
 * Build a safe on-disk slug from a `graphId`. Graph ids are generated as
 * `"{name}-{timestamp}-{seq}"`, but the leading `name` is user/declaration
 * controlled and may contain characters that are unsafe in a filename — so the
 * slug strips everything outside `[A-Za-z0-9._-]`.
 */
export function engineStateSlug(graphId: string): string {
  return graphId.replace(SAFE_SLUG, "-");
}

/** Absolute path to a graph's engine state file: `.rolebox/state/engine-{slug}.json`. */
export function engineStatePath(directory: string, graphId: string): string {
  return join(
    directory,
    ".rolebox",
    "state",
    `engine-${engineStateSlug(graphId)}.json`,
  );
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * File-backed store for a single graph's engine state.
 *
 * Construct with a workspace directory (defaults to `process.cwd()`); the
 * state file lives under `.rolebox/state/`. The `directory` is injectable so
 * tests can point at a throwaway temp dir and never touch the real state tree.
 *
 * Writes are synchronous and atomic (`.tmp` + `renameSync`), the same crash-safe
 * pattern as `task-store.ts:101-108`. `save` never throws — a failed write is
 * logged as a warning and the engine continues in memory (write-through must
 * not break the advancement critical section).
 */
export class EnginePersistence {
  private readonly directory: string;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private pendingWrite?: { state: EngineState };

  constructor(directory?: string) {
    this.directory = directory ?? process.cwd();
  }

  /**
   * Write-through save of the current engine state. Synchronous and atomic.
   * Intended for the advancement critical section's `finally` block so that
   * critical transitions (node lifecycle, phase, frontier) survive a crash.
   */
  save(state: EngineState): void {
    this._cancelDebounce();
    this._write(state);
  }

  /**
   * Debounced save (500ms) for non-critical updates. Multiple rapid mutations
   * are coalesced into a single atomic write. A final `save`/`flush` is still
   * required to guarantee durability before process exit.
   */
  scheduleSave(state: EngineState): void {
    this._writeOnFlush = state; // coalesce to the most recent state
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const s = this._writeOnFlush;
      this._writeOnFlush = undefined;
      if (s) this._write(s);
    }, NON_CRITICAL_DEBOUNCE_MS);
  }

  /** Force-flush any pending debounced write immediately (process-exit safety). */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    const s = this._writeOnFlush;
    this._writeOnFlush = undefined;
    if (s) this._write(s);
  }

  /**
   * Load a graph's persisted engine state.
   *
   * Returns `null` (clean start / caller should provision a fresh engine) when:
   * - the state file does not exist (ENOENT);
   * - the JSON is corrupt / not an object;
   * - the schema version does not match `ENGINE_PERSISTENCE_VERSION`.
   */
  load(graphId: string): EngineState | null {
    const filePath = engineStatePath(this.directory, graphId);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      // ENOENT — first run / never persisted. Clean start.
      return null;
    }
    return loadEngineStateFromJson(raw, filePath);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _writeOnFlush?: EngineState;

  private _cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this._writeOnFlush = undefined;
  }

  /** Serialize → mkdir → write `.tmp` → unlink existing → rename. Never throws. */
  private _write(state: EngineState): void {
    const filePath = engineStatePath(this.directory, state.graphId);
    const stateDir = join(filePath, "..");
    try {
      const json = JSON.stringify(serializeEngineState(state), null, 2);
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, json, "utf-8");
      try {
        unlinkSync(filePath);
      } catch {
        // No existing file — fine.
      }
      renameSync(tmp, filePath);
    } catch (err) {
      // write-through must never break the engine: degrade gracefully in memory.
      logWarn(`engine-persist: save failed for graph "${state.graphId}": ${String(err)}`);
    }
  }
}

// ── Standalone load (exported for direct, testable use) ─────────────────────

/**
 * Parse a raw state-file string and return the hydrated {@link EngineState},
 * or `null` when it is not a valid version-`2` engine state file. Shared by
 * {@link EnginePersistence.load} so the version/malformation gate is testable
 * without touching the filesystem.
 */
export function loadEngineStateFromJson(
  raw: string,
  _sourceLabel?: string,
): EngineState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON
  }
  if (!parsed || typeof parsed !== "object") return null;
  const file = parsed as Partial<EnginePersistenceFile>;
  // Version gate — a mismatched schema is a migration/clean-start point.
  if (file.version !== ENGINE_PERSISTENCE_VERSION) return null;
  if (typeof file.graphId !== "string") return null;
  if (typeof file.phase !== "string") return null;
  return deserializeEngineState(file as EnginePersistenceFile);
}

/** Minimal, dependency-free warning logger (no createSubLogger import cycle). */
function logWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

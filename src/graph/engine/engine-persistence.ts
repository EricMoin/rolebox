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
 *   The durability path for **critical** transitions (node lifecycle, graph
 *   phase, frontier, checkpoint records, approval state), invoked from the
 *   advancement critical section's `finally` block.
 * - `scheduleSave(state)` — debounced (500ms) write path for **non-critical**
 *   churn only: signal-ledger history updates and budget / per-node
 *   tokensConsumed counters. Multiple rapid mutations coalesce into a single
 *   atomic write.
 * - `flush()` — force-drain a pending debounced write. Runs when the engine
 *   reaches a terminal phase (`complete`), so no debounced write is lost.
 * - `dispose()` — teardown for a runtime that is being replaced / discarded.
 *   Cancels the debounce timer and DROPS the pending write (no flush): the
 *   disposed runtime's state is stale relative to the successor runtime, so
 *   flushing it would overwrite newer state (review 05-F1/F3, M14/ML1).
 * - `load(graphId)` — read + validate; returns `null` for a missing file (only
 *   ENOENT) or a schema-version mismatch (clean start / migration point),
 *   mirroring `TaskStateStore.load()` (`src/dispatch/persistence/task-store.ts:125`).
 *   Any other read failure is rethrown — an unreadable state file is an
 *   explicit error, never a silent clean start (review 05-F6, L22).
 *
 * Two-tier durability policy (Q2 Option A): critical mutations write through
 * synchronously so a crash never loses node/phase/frontier progress; non-critical
 * churn (signal history, budget/token counters) is debounced to avoid a sync
 * write on every high-frequency update. A critical `save` always cancels any
 * pending debounced write (the sync write already contains the latest state),
 * so the two tiers stay consistent.
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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EnginePhase } from "../../constants.ts";
import type { GraphDeclaration } from "../../types.graph-v2.ts";
import type {
  CheckpointRecord,
  EdgePayload,
  EngineState,
  GraphBudgetState,
  LoopGroupRuntimeState,
  NodeLivenessState,
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

// ── Dirty-flag helpers (write-through batching) ──────────────────────────────

/**
 * Mark the engine state as mutated. Every critical mutation site MUST call
 * this after mutating any persistent field (node lifecycle, phase, frontier,
 * budget, signal ledger, loop group state, checkpoints, etc.). The
 * advancement critical section's `finally` block only persists when the flag
 * is set, avoiding redundant writes on idle sections.
 *
 * This function is the official choke-point — callers never set
 * `state.isDirty` directly. The field is deliberately omitted from the
 * serialization DTO so a deserialized (recovered) state always starts clean.
 */
export function markDirty(state: EngineState): void {
  state.isDirty = true;
}

/**
 * Clear the dirty flag after a successful persist. Called in the advancement
 * critical section's `finally` block immediately after `persistState?.`.
 * The state is now durably on disk and the flag is reset so the next idle
 * section does not re-persist.
 */
export function clearDirty(state: EngineState): void {
  state.isDirty = false;
}

/**
 * Whether the engine state has unpersisted mutations. When `false`, the
 * advancement critical section's `finally` block skips the `persistState?.`
 * call — the section was idle (no mutations occurred).
 */
export function shouldPersist(state: EngineState): boolean {
  return state.isDirty;
}

/**
 * Mark the engine state as carrying **non-critical** churn (signal-ledger
 * history updates, budget / per-node tokensConsumed counters). Unlike
 * {@link markDirty}, this does NOT require a synchronous write-through — the
 * advancement critical section's `finally` block routes a section whose only
 * mutations were non-critical through the debounced write path instead.
 *
 * The official choke-point for non-critical mutations — callers never set
 * `state.isNonCriticalDirty` directly. The field is omitted from the
 * serialization DTO so a deserialized (recovered) state always starts clean.
 */
export function markNonCriticalDirty(state: EngineState): void {
  state.isNonCriticalDirty = true;
}

/**
 * Clear the non-critical dirty flag after the mutation has been accounted for
 * (either coalesced into a synchronous write or handed to the debounced path).
 * Called in the advancement critical section's `finally` block alongside
 * {@link clearDirty}.
 */
export function clearNonCriticalDirty(state: EngineState): void {
  state.isNonCriticalDirty = false;
}

/**
 * Whether the engine state has unpersisted **non-critical** churn. When
 * `true` and the critical {@link shouldPersist} flag is `false`, the
 * advancement critical section's `finally` block schedules a debounced write
 * instead of a synchronous one.
 */
export function shouldPersistNonCritical(state: EngineState): boolean {
  return state.isNonCriticalDirty;
}

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
    materializedAt: number;
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
  // OPTIONAL-ADDITIVE (node-anomaly-detection subtask 1): heartbeat / stall
  // carrier — JSON-primitive throughout, absent → undefined. Mirrors the
  // artifacts/evidence pattern (files authored before the field lack it).
  liveness?: NodeLivenessState;
}

/** Top-level on-disk schema (versioned). `Map` fields are plain `Record`s. */
export interface EnginePersistenceFile {
  version: typeof ENGINE_PERSISTENCE_VERSION;
  graphId: string;
  phase: EnginePhase;
  graphDeclaration: GraphDeclaration;
  nodes: Record<string, NodeRuntimeStateDTO>;
  /**
   * LEGACY READ-COMPAT — the dead `EngineState.edges` map was removed (D3),
   * so new files never carry this key. It is retained here (optional) so
   * files authored before the removal — which DO carry a top-level `edges`
   * object — still pass the required-shape gate and hydrate cleanly. The key
   * is tolerated and ignored: it is never written and never hydrated back
   * onto a live state.
   */
  edges?: Record<string, EdgePayload>;
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
  // OPTIONAL-ADDITIVE (subtask 7): append-only per-node checkpoint history.
  // Absent in files authored before this field — deserialize defaults to absent.
  checkpointHistory?: Record<string, CheckpointRecord[]>;
  // OPTIONAL-ADDITIVE (monitor M10): cross-restart termination-notification
  // dedup flags. Absent in files authored before this field — deserialize
  // leaves it undefined (no fabricated default object).
  terminalNotified?: { complete: boolean; blocked: boolean };
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

/**
 * Deep-enough clone of the append-only per-node checkpoint history map.
 *
 * Exported (H3) so `hydrate` / `adopt` paths outside this module can reuse the
 * same defensive-copy semantics instead of reimplementing per-record spread.
 */
export function cloneCheckpointHistory(
  c: Record<string, CheckpointRecord[]> | undefined,
): Record<string, CheckpointRecord[]> | undefined {
  if (!c) return undefined;
  const out: Record<string, CheckpointRecord[]> = {};
  for (const [id, records] of Object.entries(c)) {
    out[id] = records.map((r) => ({ ...r }));
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
      // OPTIONAL-ADDITIVE (node-anomaly-detection subtask 1): clone the
      // liveness carrier so the DTO never aliases the live state's object.
      // Absent → undefined (files authored before the field existed).
      liveness: n.liveness ? { ...n.liveness } : undefined,
      upstreamResults: ur,
    };
  }

  // D3: the dead `state.edges` map is gone — the persisted file deliberately
  // carries no `edges` key (legacy files with one are tolerated on load, see
  // `EnginePersistenceFile.edges`).

  const loopGroups: Record<string, LoopGroupRuntimeState> = {};
  for (const [id, g] of state.loopGroups) {
    loopGroups[id] = cloneLoopGroup(g);
  }

  const signalLedger: Record<string, SignalLedgerEntry> = {};
  for (const [id, e] of state.signalLedger) {
    signalLedger[id] = cloneSignalLedgerEntry(e);
  }

  // isDirty is deliberately NOT serialized — it is a runtime-only flag.
  // The persisted snapshot never carries it, so a recovered state always
  // starts clean (isDirty = false), preventing stale-flag resurrection.
  return {
    version: ENGINE_PERSISTENCE_VERSION,
    graphId: state.graphId,
    phase: state.phase,
    graphDeclaration: state.graphDeclaration,
    nodes,
    loopGroups,
    frontier: [...state.frontier],
    budget: cloneBudgetState(state.budget),
    signalLedger,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    advancingLock: state.advancingLock,
    pendingCompletions: [...state.pendingCompletions],
    checkpoints: cloneCheckpoints(state.checkpoints),
    checkpointHistory: cloneCheckpointHistory(state.checkpointHistory),
    // OPTIONAL-ADDITIVE (monitor M10): cross-restart termination-notification
    // dedup flags are durable graph state — cloned, never aliased. Absent →
    // undefined (files authored before the field existed).
    terminalNotified: state.terminalNotified
      ? { ...state.terminalNotified }
      : undefined,
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
      // OPTIONAL-ADDITIVE (node-anomaly-detection subtask 1): carry the
      // liveness carrier back as a fresh object (no shared reference with the
      // parsed DTO). Absent → undefined — old v2 files stay loadable.
      liveness: rest.liveness ? { ...rest.liveness } : undefined,
      upstreamResults,
    } as NodeRuntimeState);
  }

  // D3: a legacy `file.edges` extra key (present in files authored before the
  // dead-field removal) is deliberately NOT hydrated onto the live state —
  // `EngineState` no longer has an `edges` member, and nothing reads it.

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
    loopGroups,
    frontier: [...file.frontier],
    budget: cloneBudgetState(file.budget),
    signalLedger,
    startedAt: file.startedAt,
    updatedAt: file.updatedAt,
    advancingLock: file.advancingLock,
    pendingCompletions: [...file.pendingCompletions],
    checkpoints: cloneCheckpoints(file.checkpoints),
    // OPTIONAL-ADDITIVE (subtask 7): absent in files authored before this field.
    // Deserialization tolerates the absence and leaves it undefined (no fabrication).
    checkpointHistory: cloneCheckpointHistory(file.checkpointHistory),
    // OPTIONAL-ADDITIVE (monitor M10): absent in files authored before this
    // field. Tolerated — stays undefined, no default object is fabricated.
    terminalNotified: file.terminalNotified
      ? { ...file.terminalNotified }
      : undefined,
    // isDirty / isNonCriticalDirty are runtime-only — a recovered state always
    // starts clean.
    isDirty: false,
    isNonCriticalDirty: false,
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
 * logged as a warning and reported via the boolean return so the caller can
 * gate `clearDirty` on the outcome (M5); a write failure never silently drops
 * the pending state. Two-tier policy: critical transitions use the synchronous
 * {@link save}; non-critical churn uses the debounced {@link scheduleSave} and
 * is drained by {@link flush} on terminal phases — a replaced / discarded
 * runtime calls {@link dispose} instead (cancels the debounce, drops the
 * pending write, never flushes stale state).
 */
export class EnginePersistence {
  private readonly directory: string;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(directory?: string) {
    this.directory = directory ?? process.cwd();
  }

  /**
   * Write-through save of the current engine state. Synchronous and atomic.
   * Intended for the advancement critical section's `finally` block so that
   * critical transitions (node lifecycle, phase, frontier) survive a crash.
   *
   * A critical `save` also cancels any pending debounced write — the sync write
   * already contains the latest state, so coalescing the non-critical churn into
   * it is safe (see the two-tier policy in the class header).
   *
   * Returns `true` when the state reached disk, `false` on a failed write
   * (never throws). Callers that gate `clearDirty` on the outcome use this to
   * keep the dirty flag set so a later section retries the persist.
   */
  save(state: EngineState): boolean {
    this._cancelDebounce();
    return this._write(state);
  }

  /**
   * Debounced save (500ms) for **non-critical** updates — signal-ledger history
   * updates and budget / per-node tokensConsumed counters. Multiple rapid
   * mutations are coalesced into a single atomic write of the most recent
   * state. A final {@link save} / {@link flush} is still required to guarantee
   * durability before process exit (flush-on-terminate is wired into the
   * engine when a section reaches a terminal phase). A runtime that is
   * replaced / discarded must call {@link dispose} — which cancels the
   * debounce and drops the pending write rather than flushing stale state.
   *
   * If the debounce timer's write fails, the pending state is RETAINED so the
   * next {@link flush} / {@link save} retries it — a failed debounced write is
   * never silently dropped (M5).
   */
  scheduleSave(state: EngineState): void {
    this._writeOnFlush = state; // coalesce to the most recent state
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const s = this._writeOnFlush;
      this._writeOnFlush = undefined;
      if (!s) return;
      if (!this._write(s)) {
        // Write failed — keep the pending state so the next flush()/save()
        // retries it instead of losing the mutation.
        this._writeOnFlush = s;
      }
    }, NON_CRITICAL_DEBOUNCE_MS);
  }

  /**
   * Force-drain a pending debounced write synchronously. Companion to
   * {@link scheduleSave} — runs when the engine reaches a terminal phase
   * (`complete`) or the runtime is disposed / replaced so no debounced
   * non-critical write is lost. A no-op when no debounced write is pending.
   *
   * Returns `true` when there was nothing pending or the drain write reached
   * disk, `false` when the drain write failed — in which case the pending
   * state is RETAINED for a later retry (M5).
   */
  flush(): boolean {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    const s = this._writeOnFlush;
    this._writeOnFlush = undefined;
    if (!s) return true; // nothing pending — nothing to fail
    const ok = this._write(s);
    if (!ok) {
      // Retain the pending state so a later flush()/save() can retry it.
      this._writeOnFlush = s;
    }
    return ok;
  }

  /**
   * Teardown entry point (review 05-F1/F3, M14/ML1): cancel any pending
   * debounce timer and DROP the pending-to-flush state — the runtime owning
   * this store is being disposed / replaced, so its state is stale relative to
   * whatever writes the successor runtime has already performed. Unlike
   * {@link flush}, this deliberately does NOT write: flushing a stale snapshot
   * over the new runtime's state is the exact stale-write race the review
   * flagged (the "flush-on-replace" contract in the class header only applies
   * when the engine itself reaches a terminal phase — a dispose is not that
   * path).
   *
   * Idempotent — a second dispose is a no-op. After dispose, a late
   * {@link scheduleSave} would re-arm the timer, so callers must not keep
   * using a disposed store.
   */
  dispose(): void {
    this._cancelDebounce();
  }

  /**
   * Load a graph's persisted engine state.
   *
   * Returns `null` (clean start / caller should provision a fresh engine) when:
   * - the state file does not exist (ENOENT);
   * - the JSON is corrupt / not an object;
   * - the schema version does not match `ENGINE_PERSISTENCE_VERSION`;
   * - the file is structurally invalid / missing a required field (total
   *   hydration — this method NEVER throws, so `recover()` can rely on `null`
   *   meaning "no valid persisted state").
   *
   * Non-ENOENT READ failures are NOT clean starts (review 05-F6 / L22): an
   * unreadable-but-present state file (EACCES, EISDIR, ...) is rethrown so the
   * caller surfaces the error explicitly instead of silently re-provisioning a
   * graph whose completed nodes would be re-executed. The engine's `recover()`
   * wraps this call in its own try/catch and logs the failure, matching the
   * failure accounting of `recoverInterruptedGraphs` (engine-startup.ts).
   */
  load(graphId: string): EngineState | null {
    const filePath = engineStatePath(this.directory, graphId);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      // ENOENT — first run / never persisted. Clean start.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      // Anything else means the file EXISTS but is unreadable — treat it as an
      // explicit failure, never as "no state" (an EACCES/EISDIR file is not a
      // clean start; treating it as one would re-execute completed nodes).
      throw err;
    }
    try {
      return loadEngineStateFromJson(raw, filePath);
    } catch {
      // Defensive containment: hydration must never throw past `load()`. A
      // structurally invalid file surfaces as `null` (clean start), never as a
      // crash that would make the graph permanently unrecoverable.
      return null;
    }
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

  /**
   * Serialize → mkdir → write `.tmp` → atomic rename-over the destination.
   *
   * The destination is replaced by a single `renameSync(tmp, filePath)` —
   * POSIX rename-over is atomic, so a concurrent reader (e.g. the TUI polling
   * engine-*.json) can never observe the path missing mid-write: the
   * destination always holds either the previous snapshot or the new one.
   * The former unlink-then-rename sequence opened an ENOENT read window
   * between the two syscalls that made the TUI drop the graph for a tick.
   *
   * Returns `true` on success, `false` on failure. Never throws — write-through
   * must not break the advancement critical section, so a failed write degrades
   * gracefully in memory, is surfaced through the boolean (no longer silently
   * swallowed, M5), and is left to the caller to retry.
   */
  private _write(state: EngineState): boolean {
    const filePath = engineStatePath(this.directory, state.graphId);
    const stateDir = join(filePath, "..");
    try {
      const json = JSON.stringify(serializeEngineState(state), null, 2);
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, json, "utf-8");
      // Atomic replace in one step: rename-over the destination, no separate
      // unlink. A reader with no open descriptor always sees either the
      // previous snapshot or the new one — never ENOENT.
      renameSync(tmp, filePath);
      return true;
    } catch (err) {
      // write-through must never break the engine: degrade gracefully in memory,
      // but report the failure so callers can gate clearDirty / retry (M5).
      logWarn(`engine-persist: save failed for graph "${state.graphId}": ${String(err)}`);
      return false;
    }
  }
}

// ── Standalone load (exported for direct, testable use) ─────────────────────

/**
 * Parse a raw state-file string and return the hydrated {@link EngineState},
 * or `null` when it is not a valid version-`2` engine state file. Shared by
 * {@link EnginePersistence.load} so the version/malformation gate is testable
 * without touching the filesystem.
 *
 * **Total hydration**: this function NEVER throws. A file that is corrupt JSON,
 * a schema-version mismatch, missing a required field, or structurally invalid
 * at any deeper level returns `null` (the documented corrupt-to-null contract
 * in the class header — `load()` doc at `EnginePersistence.load`). A
 * parseable-but-field-incomplete file must never make recovery throw, because
 * that would leave the graph permanently unrecoverable (re-failing every
 * restart). Missing required fields are treated as CORRUPT, not as a
 * migration point — `ENGINE_PERSISTENCE_VERSION` stays `2`.
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
  // Required-field gate — a parseable-but-structurally-incomplete file is
  // treated as corrupt. Absent fields would make deserializeEngineState throw
  // on Object.entries / array-spread (see the module finding); gating presence
  // here keeps the corrupt-to-null contract total (never throws).
  if (!hasRequiredShape(file)) return null;
  try {
    return deserializeEngineState(file as EnginePersistenceFile);
  } catch {
    // Deep structural invalidity (malformed nested shapes) is still corrupt —
    // contained to `null`, never thrown past the loader.
    return null;
  }
}

/**
 * Structural presence gate for the required fields of a v2 engine-state file.
 *
 * Beyond the collection/array fields, this also gates `graphDeclaration` (an
 * object — a missing declaration would otherwise let deserializeEngineState
 * return a state whose `graphDeclaration` is `undefined`, and
 * `hydrateEngineState`'s `clearUndeclaredLoopGroupIds` would throw a TypeError
 * OUTSIDE the load try/catch, breaking the "never throws / permanently
 * recoverable" contract — review 05-F2 / M15) and the scalar lifecycle fields
 * `startedAt` / `updatedAt` (numbers) / `advancingLock` (boolean) — `undefined`
 * timestamps would propagate into staleness math as `NaN` comparisons that
 * never fire, silently disabling node timeout detection.
 */
function hasRequiredShape(file: Partial<EnginePersistenceFile>): boolean {
  return (
    isPlainObject(file.graphDeclaration) &&
    isPlainObject(file.nodes) &&
    // D3: `file.edges` is NOT required — new files never carry it (the dead
    // field was removed). A legacy `edges` extra key is tolerated and ignored.
    isPlainObject(file.loopGroups) &&
    isPlainObject(file.signalLedger) &&
    Array.isArray(file.frontier) &&
    Array.isArray(file.pendingCompletions) &&
    isPlainObject(file.budget) &&
    typeof file.startedAt === "number" &&
    typeof file.updatedAt === "number" &&
    typeof file.advancingLock === "boolean"
  );
}

/** A JSON object (non-null, non-array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minimal, dependency-free warning logger (no createSubLogger import cycle). */
function logWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

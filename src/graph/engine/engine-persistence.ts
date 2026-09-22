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
 *   ENOENT), a schema-version mismatch, a file whose nodes fail the R2
 *   node-level field gate, or an out-of-vocabulary enum (clean start /
 *   migration point),
 *   mirroring `TaskStateStore.load()` (`src/dispatch/persistence/task-store.ts:125`).
 *   Any other read failure is rethrown — an unreadable state file is an
 *   explicit error, never a silent clean start (review 05-F6, L22).
 * - `loadForResume(graphId)` — the same read + validate path with the non-valid
 *   outcomes kept distinguishable ({@link EngineLoadResult}: absent / corrupt /
 *   unsupported / migration-required / valid). Added for the startup sweep,
 *   which must report those cases differently instead of collapsing them into
 *   one `null` (docs/graph-outcome-protocol.md § Version ownership and load
 *   contract). `load()` delegates to it and stays the null-only compatibility
 *   wrapper.
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

import { ENGINE_PHASE_VALUES, NODE_STATUS_VALUES } from "../../constants.ts";
import { errorText } from "../../utils/error-text.ts";
import type {
  CheckpointRecord,
  EdgePayload,
  EngineState,
  GraphBudgetState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
  PlanBinding,
  ResolvedJoinStrategy,
  SignalLedgerEntry,
} from "../../types.engine-v2.ts";
import {
  contractDigest,
  contractRefsEqual,
  isContractRef,
  type ContractRef,
} from "../contracts/contract-definition.ts";
import {
  classifyStorageFormat,
  createStorageFormatRegistry,
  STORAGE_FORMAT_V2,
  type StorageDecodeResult,
  type StorageFormatDecoder,
  type StorageFormatMigration,
  type StorageFormatRegistry,
} from "../persistence/storage-format.ts";
import {
  classifyExecutionProtocol,
  LEGACY_EXECUTION_PROTOCOL_REGISTRY,
  LEGACY_SIGNAL_PROTOCOL,
  type ExecutionProtocolRegistry,
  type ExecutionProtocolVerdict,
} from "../protocol/execution-protocol.ts";
import { logWarn } from "./log-warn.ts";
import {
  inspectCompiledTopology,
  NON_EXECUTABLE_PLAN_CODE,
  readPlanExecutability,
  type CompiledNode,
  type PersistedCompiledPlan,
} from "../compiler/plan.ts";

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
 * Runtime fields whose representation is NOT directly JSON-safe and therefore
 * needs an explicit projection in the DTO. Today the only one is
 * `upstreamResults` (`Map` → plain `Record`).
 */
type NodeRuntimeStateProjectedKeys = "upstreamResults";

/**
 * Flat, JSON-safe projection of {@link NodeRuntimeState}.
 *
 * R2 (trust boundary): the DTO is DERIVED from the runtime type (mapped type)
 * instead of hand-mirrored. A field added to / removed from
 * {@link NodeRuntimeState} now flows into the DTO automatically, so it cannot
 * silently drift out of the persistence contract: `serializeNodeDTO`'s
 * `satisfies` check and the key-coverage assertions below fail to compile
 * instead. `upstreamResults` is the only field whose runtime representation
 * (`Map`) needs flattening; every other field is already JSON-primitive and
 * passes through unchanged.
 */
export type NodeRuntimeStateDTO = Omit<
  NodeRuntimeState,
  NodeRuntimeStateProjectedKeys
> & {
  upstreamResults: Record<string, EdgePayload>;
};

/** Compile-time helper: asserts a derived key set is exactly empty. */
type AssertNoExcessKeys<T extends never> = T;

// R2 type-level completeness assertion. Both `Exclude`s resolve to `never`
// while the mapped DTO is faithful:
// - the first proves the DTO omits NO runtime field (every key of
//   `NodeRuntimeState` is a key of the DTO);
// - the second proves the DTO invents no field the runtime type lacks.
// Adding a field to `NodeRuntimeState` and excluding it from the DTO without
// re-declaring it here makes these assignments fail to compile.
type _NodeDtoCoverage = AssertNoExcessKeys<
  Exclude<keyof NodeRuntimeState, keyof NodeRuntimeStateDTO>
>;
type _NodeDtoNoExtras = AssertNoExcessKeys<
  Exclude<keyof NodeRuntimeStateDTO, keyof NodeRuntimeState>
>;

/**
 * `EngineState` keys that are NOT part of the JSON-safe container file:
 * runtime-only dirty flags, the two non-serializable event sinks, and the
 * three `Map` collections that are re-declared below in their flat JSON form.
 *
 * `advancingLock` / `pendingCompletions` are deliberately NOT in this list:
 * they remain in the file (crash diagnostics / legacy read-compat) but are
 * reset to their initial values on hydration — see `deserializeEngineState`.
 */
type EngineStateNonSerializedKeys =
  | "nodes"
  | "loopGroups"
  | "signalLedger"
  | "isDirty"
  | "isNonCriticalDirty"
  | "phaseEventSink"
  | "budgetEventSink";

/**
 * Top-level on-disk schema (versioned). `Map` fields are plain `Record`s.
 *
 * R2: like the node DTO, this is DERIVED from {@link EngineState} — the
 * `Omit` removes only the runtime-only / re-shaped keys above, so a new
 * persisted field on `EngineState` cannot be forgotten here.
 */
export type EnginePersistenceFile = {
  version: typeof ENGINE_PERSISTENCE_VERSION;
} & Omit<EngineState, EngineStateNonSerializedKeys> & {
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
    signalLedger: Record<string, SignalLedgerEntry>;
  };

// R2 type-level completeness assertion for the container: every
// PERSISTED `EngineState` key is covered by the file DTO. The runtime-only
// keys (dirty flags, event sinks) are legitimately absent from the file, so
// they are excluded from the check — every other runtime field must be
// reachable through the `Omit` + re-declarations. Fails to compile if a
// persisted runtime field is dropped from both.
type EngineStateRuntimeOnlyKeys =
  | "isDirty"
  | "isNonCriticalDirty"
  | "phaseEventSink"
  | "budgetEventSink";
type _FileDtoCoverage = AssertNoExcessKeys<
  Exclude<
    Exclude<keyof EngineState, EngineStateRuntimeOnlyKeys>,
    keyof EnginePersistenceFile
  >
>;

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

/**
 * Defensive DEEP copy of one persisted plan binding (B6; B8 makes it deep).
 *
 * `structuredClone` copies every own key of the record — including a key the
 * binding model does not declare, and including a `__proto__` own property,
 * which it preserves as an own data property rather than letting it land on the
 * prototype — and it copies nested containers all the way down. Source and
 * result therefore share NO object: a body the target later mutates cannot
 * rewrite the source's content (and vice versa), which is exactly the guarantee
 * hydration and adoption need.
 *
 * The values are JSON data: `contractDigest` accepted every body of a
 * VERIFIED binding, so a plan record the load admitted is cloneable. This
 * helper is also used by the writer, where the same property holds — and where
 * a copy that shared a body reference would let a caller edit the DTO it was
 * handed and the live state behind it at once.
 *
 * For the binding, key preservation is fidelity only (its `planRevision`
 * addresses the compiled plan, not this body); {@link clonePersistedCompiledPlan}
 * states why the same rule is load-bearing for the plan record.
 */
export function clonePlanBinding(binding: PlanBinding): PlanBinding {
  return structuredClone(binding);
}

/**
 * Defensive DEEP copy of one persisted compiled-plan record (B7; deep since B8).
 *
 * Same discipline and same guarantee as {@link clonePlanBinding}:
 * `structuredClone` copies the whole record — every own key, declared or not,
 * and every nested container — so neither the serializer, a hydrated engine nor
 * an adopting engine ever aliases the record it copied. Key preservation is
 * load-bearing rather than cosmetic: `planRevision` addresses the body AS
 * PERSISTED (`contractDigest` hashes `Object.keys`), so a closed-field
 * projection would drop an own key while keeping the revision, and the writer's
 * own output would be refused as `corrupt(contract)` on the next load.
 */
export function clonePersistedCompiledPlan(
  plan: PersistedCompiledPlan,
): PersistedCompiledPlan {
  return structuredClone(plan);
}

// ── Serialize / Deserialize (pure, exportable for tests) ────────────────────

/**
 * Project one live {@link NodeRuntimeState} into its JSON-safe DTO.
 *
 * R2: field-by-field instead of a `...rest` spread. The trailing `satisfies`
 * makes the DTO's `satisfies`-checked field set the authority: adding a field
 * to {@link NodeRuntimeState} and forgetting it here is a compile error rather
 * than a silent `JSON.stringify` drop / reshape. `budget` is carried
 * explicitly (it used to ride the untyped spread while being absent from the
 * hand-mirrored DTO declaration) so the per-node declared ceilings survive a
 * recovery round trip *by contract*, not by accident.
 */
export function serializeNodeDTO(n: NodeRuntimeState): NodeRuntimeStateDTO {
  const upstreamResults: Record<string, EdgePayload> = {};
  for (const [fromId, payload] of n.upstreamResults) {
    upstreamResults[fromId] = cloneEdgePayload(payload);
  }
  return {
    nodeId: n.nodeId,
    agent: n.agent,
    prompt: n.prompt,
    needsApproval: n.needsApproval,
    status: n.status,
    dispatchTaskId: n.dispatchTaskId,
    dispatchSessionId: n.dispatchSessionId,
    result: n.result ? { ...n.result } : undefined,
    // OPTIONAL-ADDITIVE (subtask 2): stashed result-text snapshot, a plain
    // JSON-primitive string. Absent → undefined (no fabrication).
    resultText: n.resultText,
    signalsObserved: { ...n.signalsObserved },
    sessionsSpawned: n.sessionsSpawned,
    tokensConsumed: { ...n.tokensConsumed },
    upstreamResults,
    joinStrategy: n.joinStrategy,
    joinSatisfied: n.joinSatisfied,
    loopGroupId: n.loopGroupId,
    traversalCount: n.traversalCount,
    startedAt: n.startedAt,
    completedAt: n.completedAt,
    retryCount: n.retryCount,
    // OPTIONAL-ADDITIVE (escalate-retry backoff): epoch-ms deadline until
    // which a re-marked-ready retry node's dispatch is withheld. Carried so a
    // restart never re-dispatches early. Absent → undefined.
    retryBackoffUntil: n.retryBackoffUntil,
    errorReason: n.errorReason,
    // OPTIONAL-ADDITIVE (subtask 1): JSON-primitive arrays, cloned so the DTO
    // never aliases the live state's arrays. Absent → undefined.
    artifacts: n.artifacts ? [...n.artifacts] : undefined,
    evidence: n.evidence ? [...n.evidence] : undefined,
    // NodeRuntimeState.budget — declared per-node ceilings (the staleness
    // watcher reads `budget.timeout_ms` off a recovered node).
    budget: n.budget ? { ...n.budget } : undefined,
    // OPTIONAL-ADDITIVE (node-anomaly-detection subtask 1): cloned liveness
    // carrier — JSON-primitive throughout. Absent → undefined.
    liveness: n.liveness ? { ...n.liveness } : undefined,
  } satisfies NodeRuntimeStateDTO;
}

/** Flatten a live {@link EngineState} into the versioned, JSON-safe DTO. */
export function serializeEngineState(state: EngineState): EnginePersistenceFile {
  const nodes: Record<string, NodeRuntimeStateDTO> = {};
  for (const [id, n] of state.nodes) {
    nodes[id] = serializeNodeDTO(n);
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
    // OPTIONAL-ADDITIVE (B3 execution protocol): the bound protocol identity,
    // written only when the state actually holds one. A state that never set
    // the field produces NO key at all — the object and its JSON text are
    // exactly what the previous writer produced — while a hydrated legacy
    // state keeps the identity its decoder backfilled across the round trip.
    ...(state.executionProtocolVersion !== undefined
      ? { executionProtocolVersion: state.executionProtocolVersion }
      : {}),
    // OPTIONAL-ADDITIVE (B6 plan binding): the persisted contract binding of
    // the compiled plan, written only when the state actually holds one. A
    // state that never carried one produces NO key at all — its object and its
    // JSON text are exactly what the previous writer produced — while a
    // hydrated graph keeps the binding its decoder verified across the round
    // trip. The compiled topology is not part of this field (see PlanBinding).
    ...(state.planBinding !== undefined
      ? { planBinding: clonePlanBinding(state.planBinding) }
      : {}),
    // OPTIONAL-ADDITIVE (B7 compiled plan): the durable compiled-plan record,
    // written only when the state actually holds one. A state that never
    // carried one produces NO key at all — its object and its JSON text are
    // exactly what the previous writer produced — while a hydrated graph keeps
    // the record its decoder verified across the round trip.
    //
    // RECOVERY DOES NOT READ THIS FIELD: the engine still resumes from the
    // retained `graphDeclaration` (see `EngineState.compiledPlan`). The record
    // is written and verified so its identity and its rules exist before a
    // producer or a recovery switch depends on them.
    ...(state.compiledPlan !== undefined
      ? { compiledPlan: clonePersistedCompiledPlan(state.compiledPlan) }
      : {}),
  };
}

/** Hydrate a live {@link EngineState} from a versioned, plain DTO. */
export function deserializeEngineState(file: EnginePersistenceFile): EngineState {
  // R2 defensive gate: direct callers cannot hydrate out-of-vocabulary enums.
  // This function's contract returns a state (not `null`), so a violation
  // THROWS — the never-throw loader (`loadEngineStateFromJson`) pre-validates
  // and maps the same violation to `null` instead, keeping its containment
  // try/catch total (see below).
  assertValidEnums(file);
  const nodes = new Map<string, NodeRuntimeState>();
  for (const [id, dto] of Object.entries(file.nodes)) {
    // R2 defensive gate (same rule as the never-throw loader's
    // `hasRequiredShape`, which maps the violation to `null` instead): this
    // function's contract returns a state, so a node missing a required field
    // THROWS rather than hydrating a partial node whose `tokensConsumed` /
    // `signalsObserved` would silently become `{}`.
    if (!hasRequiredNodeShape(dto)) {
      throw new Error(
        `engine-persist: node "${id}" is missing a required field (need agent / prompt / needsApproval / signalsObserved / upstreamResults / tokensConsumed with numeric inputTokens+outputTokens+cost)`,
      );
    }
    const upstreamResults = new Map<string, EdgePayload>();
    for (const [fromId, payload] of Object.entries(dto.upstreamResults ?? {})) {
      upstreamResults.set(fromId, cloneEdgePayload(payload));
    }
    const { upstreamResults: _ur, ...rest } = dto;
    // C1 consumer side: normalize the persisted join strategy into the runtime
    // vocabulary. A legacy bare "quorum" (persisted by builds that admitted
    // `JOIN_STRATEGY_VALUES` wholesale) carries no count, so it is normalized
    // to { quorum: 1 } — the historical runtime default — WITH a warning.
    // Anything else out of vocabulary was already rejected by assertValidEnums
    // (load → null); this function's contract returns a state, so it throws.
    const rawJoinStrategy: unknown = rest.joinStrategy;
    const joinStrategy = normalizeJoinStrategy(rawJoinStrategy);
    if (joinStrategy === undefined) {
      throw new Error(
        `engine-persist: node "${id}" joinStrategy is not valid (expected "all", "any", or a { quorum: positive-int } object)`,
      );
    }
    if (rawJoinStrategy === LEGACY_BARE_QUORUM_JOIN_STRATEGY) {
      logWarn(
        `engine-persist: node "${id}" carried the legacy bare "quorum" joinStrategy — normalizing to { quorum: 1 } (the old value carried no count)`,
      );
    }
    // R2: no assertion closes this object literal. `tokensConsumed` is a
    // straight clone of the DTO field (the derived DTO types it as the runtime
    // `UsageRecord`, so the old `as NodeRuntimeState["tokensConsumed"]` cast
    // that legalized a missing/partial value is gone), and the required-shape
    // gate above proved the field is a `{ inputTokens, outputTokens, cost }`
    // object of numbers before hydration.
    const node: NodeRuntimeState = {
      ...rest,
      joinStrategy,
      signalsObserved: { ...rest.signalsObserved },
      tokensConsumed: { ...rest.tokensConsumed },
      result: rest.result ? { ...rest.result } : undefined,
      // OPTIONAL-ADDITIVE (node-anomaly-detection subtask 1): carry the
      // liveness carrier back as a fresh object (no shared reference with the
      // parsed DTO). Absent → undefined — old v2 files stay loadable.
      liveness: rest.liveness ? { ...rest.liveness } : undefined,
      // OPTIONAL-ADDITIVE (subtask 2): carry the stashed result-text snapshot
      // back (a JSON-primitive string — no clone needed). Absent → undefined —
      // old v2 files stay loadable and the EdgePayload result fallback yields
      // '' for them (the stashed text is stashed again at next completion).
      resultText: rest.resultText,
      // OPTIONAL-ADDITIVE (escalate-retry backoff): carry the withheld-dispatch
      // deadline back (JSON-primitive number — no clone needed). Absent →
      // undefined — old v2 files stay loadable and their Ready nodes dispatch
      // immediately (no backoff was ever declared for them).
      retryBackoffUntil: rest.retryBackoffUntil,
      upstreamResults,
    };
    nodes.set(id, node);
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

  // R2: the container is assembled as an explicitly typed object literal (no
  // `as EngineState`). Excess-property / missing-field checking now runs at
  // the hydration boundary, so a field the DTO forgot to hydrate is a compile
  // error instead of a silently `undefined` runtime member.
  const state: EngineState = {
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
    // R2(c): `advancingLock` / `pendingCompletions` are persisted for crash
    // diagnostics + legacy read-compat, but they describe a critical section of
    // the process that WROTE the file. This process has no section running and
    // no in-memory deferred queue, so hydrating them would resurrect a lock
    // nobody holds / completions nobody can replay (the same reset
    // `clearStaleCriticalSection` applies post-hydrate, now enforced at the
    // trust boundary itself).
    advancingLock: false,
    pendingCompletions: [],
    checkpoints: cloneCheckpoints(file.checkpoints),
    // OPTIONAL-ADDITIVE (subtask 7): absent in files authored before this field.
    // Deserialization tolerates the absence and leaves it undefined (no fabrication).
    checkpointHistory: cloneCheckpointHistory(file.checkpointHistory),
    // OPTIONAL-ADDITIVE (monitor M10): absent in files authored before this
    // field. Tolerated — stays undefined, no default object is fabricated.
    terminalNotified: file.terminalNotified
      ? { ...file.terminalNotified }
      : undefined,
    // OPTIONAL-ADDITIVE (B3 execution protocol): carried through verbatim, NOT
    // defaulted here. This function is a pure DTO→state projection; the
    // format-2 decoder owns the one legitimate backfill (see
    // STORAGE_FORMAT_V2_DECODER) and the loader owns classification, so an
    // absent value stays absent until the decoder resolves it.
    executionProtocolVersion: file.executionProtocolVersion,
    // OPTIONAL-ADDITIVE (B6 plan binding): carried through VERBATIM, never
    // copied, defaulted or inspected here. This function is a pure DTO→state
    // projection; the format-2 decoder owns the verification, and that gate is
    // total for a hostile binding (a getter or Proxy that throws while being
    // read). Touching the binding's internals here would duplicate the gate and
    // relabel its contract failures as storage hydration failures.
    planBinding: file.planBinding,
    // OPTIONAL-ADDITIVE (B7 compiled plan): carried through VERBATIM for the
    // same reason as the binding above — this function is a pure DTO→state
    // projection, and the format-2 decoder owns the verification, which is
    // total for a hostile record (a getter or Proxy that throws while being
    // read). Touching the plan internals here would duplicate that gate and
    // relabel its contract failures as storage hydration failures.
    compiledPlan: file.compiledPlan,
    // isDirty / isNonCriticalDirty are runtime-only — a recovered state always
    // starts clean.
    isDirty: false,
    isNonCriticalDirty: false,
  };
  return state;
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

// ── Structured load results (storage-format-aware) ──────────────────────────

/**
 * Version axis a non-executable load result is attributed to.
 *
 * `storage` describes the on-disk storage format; `execution` describes the
 * graph's execution protocol, whose identity the format-2 decoder resolves and
 * the loader then classifies against the protocol registry. The two are
 * separate axes on purpose — an unregistered protocol is not a storage
 * mismatch, and an unreadable format is not a protocol mismatch. `contract`
 * is the axis of a persisted plan binding (B6) or compiled-plan record (B7)
 * that fails verification: the format-2 decoder observes it and the loader
 * reports it, so a bad record can never read as a storage defect. `capability`
 * remains the reserved
 * vocabulary for the later capability gate
 * (docs/graph-outcome-protocol.md § "Structured loading results"), so that
 * mismatch can never be conflated with today's three.
 */
export type EngineLoadDimension =
  | "storage"
  | "execution"
  | "contract"
  | "capability";

/**
 * Outcome of {@link loadEngineStateForResume} / {@link EnginePersistence.loadForResume}.
 *
 * The legacy load path answers a single `null` for four different situations —
 * no file, a corrupt file, an unsupported storage format, and a recognized file
 * that requires a format migration. Callers that must ACT differently (the
 * startup sweep) need those separated; callers that only need "state or clean
 * start" keep using {@link EnginePersistence.load}, which collapses every
 * non-`valid` kind to `null` exactly as before.
 *
 * Every non-`valid` result is non-executable by contract: none may reach
 * `adoptPrior`, dispatch, or automatic fresh-engine provisioning.
 *
 * - `valid` — every gate passed; `storageFormat` is the classified format the
 *   state was hydrated from (today always `STORAGE_FORMAT_V2`) and
 *   `executionProtocol` is the bound protocol identity (today always
 *   `LEGACY_SIGNAL_PROTOCOL` — the only registered handler). The hydrated
 *   state carries the same identity explicitly.
 * - `absent` — no state file exists (ENOENT only). Creation of a graph is a
 *   separate explicit action, never implied by a load.
 * - `corrupt` — a recognized representation violates its schema, required
 *   shape, enum vocabulary, format discriminator, protocol identity, or
 *   persisted plan record (binding and/or compiled plan). `dimension` names
 *   the violated axis
 *   ({@link EngineLoadDimension}). The file is preserved; it is never rerun as
 *   fresh.
 * - `unsupported` — a well-formed discriminator with no installed capability:
 *   a storage format with no decoder and no registered migration
 *   (`storage`), or a legal execution protocol with no registered handler
 *   (`execution`). It needs compatible code, never an inferred default.
 * - `migration-required` — a recognized storage format has a registered
 *   conversion path but cannot execute until that conversion is committed. The
 *   source body has already passed the migration's own `validateSource` gate;
 *   a source that fails it is `corrupt`, not migration-required.
 */
export type EngineLoadResult =
  | {
      kind: "valid";
      state: EngineState;
      storageFormat: number;
      /**
       * The exact protocol the loader BOUND to this graph — the registered
       * handler's version, never a latest-version constant. The caller runs
       * the state under this identity or refuses it; it never substitutes a
       * different one.
       */
      executionProtocol: number;
    }
  | { kind: "absent" }
  | { kind: "corrupt"; dimension: EngineLoadDimension; reason: string }
  | {
      kind: "unsupported";
      dimension: EngineLoadDimension;
      detail: string;
    }
  | {
      kind: "migration-required";
      dimension: "storage";
      from: number;
      to: number;
    };

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
   * Load a graph's persisted engine state WITHOUT collapsing the non-valid
   * outcomes. Same gates and same total-hydration contract as {@link load};
   * only the return shape differs. `load` answers `null` for all four
   * non-valid situations, so a caller cannot tell a clean start (missing file)
   * from a corrupt file, an unsupported storage format, or a snapshot that
   * requires a format migration. The startup sweep needs exactly that
   * distinction, so it uses this method.
   *
   * - ENOENT → `{ kind: "absent" }` (first run / never persisted).
   * - Any other read failure (EACCES / EISDIR / …) is RETHROWN: a file that
   *   EXISTS but cannot be read is an explicit error, never "no state" —
   *   treating it as absent would re-provision a graph whose completed nodes
   *   would then be re-executed (review 05-F6 / L22).
   * - Hydration failures come back as their {@link EngineLoadResult} kind
   *   (corrupt / unsupported / migration-required), attributed to their axis:
   *   a storage-format mismatch is `dimension: "storage"`, an unregistered or
   *   malformed execution-protocol identity is `dimension: "execution"`.
   *   Either way the result is non-executable and the file is preserved. The
   *   defensive containment catch is unreachable while
   *   `loadEngineStateForResume` stays total; it exists for the same reason as
   *   `load`'s and maps an impossible escape to `corrupt` instead of letting
   *   it crash the sweep.
   */
  loadForResume(graphId: string): EngineLoadResult {
    const filePath = engineStatePath(this.directory, graphId);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      // ENOENT — first run / never persisted. Absent, not corrupt.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "absent" };
      }
      // Anything else means the file EXISTS but is unreadable — an explicit
      // failure, never "no state" (see the method doc).
      throw err;
    }
    try {
      return loadEngineStateForResume(raw, filePath);
    } catch (err) {
      // Defensive containment: hydration must never throw past the store. A
      // structurally invalid file surfaces as `corrupt` (non-executable),
      // never as a crash that would make the graph permanently unrecoverable.
      return {
        kind: "corrupt",
        dimension: "storage",
        reason: `containment: ${errorText(err)}`,
      };
    }
  }

  /**
   * Load a graph's persisted engine state.
   *
   * Returns `null` (clean start / caller should provision a fresh engine) when:
   * - the state file does not exist (ENOENT);
   * - the JSON is corrupt / not an object;
   * - the schema version is not decodable under the storage-format registry
   *   (`DEFAULT_STORAGE_FORMAT_REGISTRY` registers exactly one decoder, for
   *   `STORAGE_FORMAT_V2` — the version `ENGINE_PERSISTENCE_VERSION` writes —
   *   and no migrations) — including a version that only a migration could
   *   convert;
   * - the file is structurally invalid / missing a required field (total
   *   hydration — this method NEVER throws, so `recover()` can rely on `null`
   *   meaning "no valid persisted state");
   * - the file carries an out-of-vocabulary enum value — `node.status` /
   *   `node.joinStrategy` / `file.phase` not in their runtime vocabularies
   *   (R2: a corrupt-but-shape-valid file must not hydrate and crash later in
   *   `canTransitionNode`);
   * - a node entry fails the R2 node-level field gate (`agent` / `prompt` /
   *   `needsApproval` / `signalsObserved` / `upstreamResults` /
   *   `tokensConsumed` with its three numeric counters) — a previously
   *   "barely loadable" stub node now yields a clean start.
   *
   * A legacy bare `joinStrategy: "quorum"` (no count) is NOT corrupt: it is
   * normalized to `{ quorum: 1 }` with a `logWarn` (contract C1) — see
   * `normalizeJoinStrategy`.
   *
   * This is the legacy null-only compatibility shell: it delegates to
   * {@link loadForResume} and projects every non-`valid` kind onto `null`, so
   * callers that treat "no valid state" as one clean-start signal keep their
   * exact behavior. A caller that must distinguish the kinds (the startup
   * sweep) uses {@link loadForResume} instead.
   *
   * Non-ENOENT READ failures are NOT clean starts (review 05-F6 / L22): an
   * unreadable-but-present state file (EACCES, EISDIR, ...) is rethrown so the
   * caller surfaces the error explicitly instead of silently re-provisioning a
   * graph whose completed nodes would be re-executed. The engine's `recover()`
   * wraps this call in its own try/catch and logs the failure, matching the
   * failure accounting of `recoverInterruptedGraphs` (engine-startup.ts).
   */
  load(graphId: string): EngineState | null {
    // Zero-behavior-change projection of the structured result: `valid` yields
    // the state, and absent / corrupt / unsupported / migration-required all
    // yield the same `null` this method always returned. Read errors still
    // propagate (loadForResume rethrows them).
    const result = this.loadForResume(graphId);
    return result.kind === "valid" ? result.state : null;
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
      logWarn(`engine-persist: save failed for graph "${state.graphId}": ${errorText(err)}`);
      return false;
    }
  }
}

// ── Persisted plan verification (B6 binding + B7 compiled plan) ─────────────

/**
 * Verdict of the load-side persisted-plan verification.
 *
 * - `absent` — neither a `planBinding` nor a `compiledPlan` is present. LEGAL:
 *   a legacy graph with no compiled plan. Nothing is verified and nothing is
 *   fabricated.
 * - `verified` — every gate passed for the record(s) that ARE present:
 *   `planRevision` is a non-empty string, every snapshot entry is content whose
 *   body hashes to its own digest key, every `(id, revision)` in the identity
 *   index maps to exactly one digest that has such proven content (two
 *   identities sharing one digest are legal), every bound ref resolves through
 *   that index and every bound node exists in the state — plus, for a
 *   compiled-plan record, that its whole body hashes to its `planRevision` and
 *   its topology satisfies the plan-level rules in `compiler/plan.ts`. When
 *   BOTH records are present they must also agree.
 * - `corrupt` — a persisted record violated one of those invariants. The
 *   `reason` names the failed check and the offending digest key / node id.
 *   This is the ONLY producer of the `contract` load dimension.
 */
export type PlanBindingVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "verified" }
  | {
      readonly kind: "corrupt";
      readonly dimension: "contract";
      readonly reason: string;
    };

/** Build a corrupt plan verdict — the `contract` axis is its only one. */
function contractCorrupt(reason: string): PlanBindingVerdict {
  return { kind: "corrupt", dimension: "contract", reason };
}

/** Describe a rejected persisted value for a diagnostic without ever throwing. */
function describeBindingValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  try {
    return String(value);
  } catch {
    return `a ${typeof value}`;
  }
}

/** A contract ref as a diagnostic token: `"id"@"revision" (digest "…")`. */
function describeContractRef(ref: ContractRef): string {
  return `${JSON.stringify(ref.id)}@${JSON.stringify(ref.revision)} (digest ${JSON.stringify(ref.digest)})`;
}

/**
 * The content + identity + node-binding rules, applied to ONE contract-bearing
 * record.
 *
 * This is the ONE owner of those rules: the B6 `planBinding` gate and the B7
 * compiled-plan gate both call it, so a rule cannot drift between the two
 * records and a load can never admit a record a compiler could not produce.
 * `label` names the record in every diagnostic ("plan binding" / "compiled
 * plan"), so a failure says which record broke the rule.
 *
 * B8 SPLIT CONTENT FROM IDENTITY. `contractSnapshots` is content only, keyed
 * by the canonical digest of its body; `contractIdentities` is the separate
 * `id` → `revision` → digest index. A node binding no longer matches "the
 * snapshot's ref" (there is none): it resolves THROUGH the identity index.
 *
 * Checks, in this order (the first failure wins):
 * (a) every `contractSnapshots` entry is a `{ body }` record keyed by digest D
 *     whose `contractDigest` is D — the B4 digest is REUSED, never
 *     re-implemented, and a body it rejects (a cycle, an accessor, an
 *     unrepresentable value, an oversized tree) is contained here. Content is
 *     deduplicated by digest, so two identities sharing one body are one entry
 *     and are NOT a violation;
 * (b) `contractIdentities` is a record of records: every `(id, revision)` maps
 *     to one non-empty digest, and that digest has a `contractSnapshots` entry
 *     (whose body (a) proved hashes back to the key). The nested shape makes
 *     "one identity, one digest" structural — ids and revisions are arbitrary
 *     persisted strings, so a concatenated flat key could collide — and two
 *     IDENTITIES MAY SHARE ONE DIGEST: that is the case this split exists for;
 * (c) every `nodeBindings` entry is a contract ref whose `(id, revision)` the
 *     identity index carries, whose `digest` the index maps it to, and whose
 *     digest has proven content through (a) + (b) — never by ordering;
 * (d) no `nodeBindings` key names a node the persisted state does not declare.
 *
 * It does NOT check `planRevision`: what that field addresses differs by record
 * (the plan body for a compiled plan, the plan revision for a binding), so each
 * caller owns its own identity check.
 */
function verifyContractRecord(
  value: Record<string, unknown>,
  nodeIds: ReadonlySet<string>,
  label: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const contractSnapshots = value.contractSnapshots;
  if (!isPlainObject(contractSnapshots)) {
    return {
      ok: false,
      reason: `${label} contractSnapshots is not a record keyed by contract digest`,
    };
  }
  const contractIdentities = value.contractIdentities;
  if (!isPlainObject(contractIdentities)) {
    return {
      ok: false,
      reason: `${label} contractIdentities is not a record keyed by contract id`,
    };
  }
  const nodeBindings = value.nodeBindings;
  if (!isPlainObject(nodeBindings)) {
    return {
      ok: false,
      reason: `${label} nodeBindings is not a record keyed by node id`,
    };
  }

  // (a) — content, digest-first, in key order, so a diagnostic is stable. The
  // set holds the digests whose body has PROVEN to hash to its own key.
  const provenDigests = new Set<string>();
  for (const digest of Object.keys(contractSnapshots).sort()) {
    try {
      const entry = contractSnapshots[digest];
      if (!isPlainObject(entry)) {
        return {
          ok: false,
          reason: `${label} contract snapshot ${JSON.stringify(digest)} is not a { body } record`,
        };
      }
      // Read the body ONCE: the digest and the stored body must come from the
      // same read, or a getter could pass one and answer another.
      const body = entry.body;
      const actual = contractDigest(body);
      if (actual !== digest) {
        return {
          ok: false,
          reason: `${label} contract snapshot ${JSON.stringify(digest)} body hashes to ${actual}, not its own key`,
        };
      }
      provenDigests.add(digest);
    } catch (err) {
      return {
        ok: false,
        reason: `${label} contract snapshot ${JSON.stringify(digest)} was rejected: ${errorText(err)}`,
      };
    }
  }

  // (b) — identity, id order then revision order. One identity has exactly one
  // digest by construction, and every digest it names must be proven content.
  for (const id of Object.keys(contractIdentities).sort()) {
    try {
      const revisions = contractIdentities[id];
      if (!isPlainObject(revisions)) {
        return {
          ok: false,
          reason: `${label} contract identity ${JSON.stringify(id)} is not a record keyed by revision`,
        };
      }
      for (const revision of Object.keys(revisions).sort()) {
        const digest = revisions[revision];
        if (typeof digest !== "string" || digest.length === 0) {
          return {
            ok: false,
            reason: `${label} contract identity ${JSON.stringify(id)}@${JSON.stringify(revision)} maps to ${describeBindingValue(digest)}, not a content digest`,
          };
        }
        if (!provenDigests.has(digest)) {
          return {
            ok: false,
            reason: `${label} contract identity ${JSON.stringify(id)}@${JSON.stringify(revision)} maps to digest ${JSON.stringify(digest)}, which contractSnapshots does not contain`,
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `${label} contract identity ${JSON.stringify(id)} was rejected: ${errorText(err)}`,
      };
    }
  }

  // (c) + (d) — one pass over the bound nodes, in node-id order.
  for (const nodeId of Object.keys(nodeBindings).sort()) {
    try {
      const boundRef = nodeBindings[nodeId];
      if (!isContractRef(boundRef)) {
        return {
          ok: false,
          reason: `${label} node binding ${JSON.stringify(nodeId)} is not a contract ref { id, revision, digest } of non-empty strings`,
        };
      }
      const revisions = contractIdentities[boundRef.id];
      const indexed =
        isPlainObject(revisions) && typeof revisions[boundRef.revision] === "string"
          ? revisions[boundRef.revision]
          : undefined;
      if (indexed === undefined) {
        return {
          ok: false,
          reason: `${label} node binding ${JSON.stringify(nodeId)} names contract ${describeContractRef(boundRef)}, which the contract identity index does not carry`,
        };
      }
      if (indexed !== boundRef.digest) {
        return {
          ok: false,
          reason: `${label} node binding ${JSON.stringify(nodeId)} declares digest ${JSON.stringify(boundRef.digest)}, but the contract identity index maps ${JSON.stringify(boundRef.id)}@${JSON.stringify(boundRef.revision)} to ${JSON.stringify(indexed)}`,
        };
      }
      if (!nodeIds.has(nodeId)) {
        return {
          ok: false,
          reason: `${label} node binding references node id ${JSON.stringify(nodeId)}, which the persisted state does not declare`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `${label} node binding ${JSON.stringify(nodeId)} was rejected: ${errorText(err)}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Verify one persisted plan binding (B6; re-meant by B7).
 *
 * This is the gate the format-2 decoder has always run for a `planBinding`,
 * and it is exported because JSON TEXT cannot express the shapes its totality
 * contract must survive (a getter that throws, a Proxy, a reference cycle), so
 * those cases are reachable only by calling this — or the registered format-2
 * decoder — with an in-memory value. It is PURE and TOTAL: every violation is a
 * `corrupt` verdict, and a throw is contained rather than passed on.
 *
 * `planRevision` is only required to be a non-empty string HERE: since B7 it is
 * the COMPILED PLAN content address — a foreign key into the `compiledPlan`
 * record — not a digest of this record's own body, so a binding that stands
 * alone has no body a load could recompute it from. When both records are
 * present, {@link verifyPersistedPlan} requires the two revisions to be equal.
 * The binding-body digest rule B6 applied is DELETED, not renamed: one name
 * never means two identities.
 *
 * Every other rule comes from {@link verifyContractRecord} — the single owner
 * of the content, identity and node-binding invariants. B8 changed that
 * record's SHAPE: snapshots are content only and a node binding resolves
 * through the `contractIdentities` index. Nothing in production writes a
 * binding yet, so no migration is written or required; an older-shape binding
 * is refused as `corrupt(contract)` rather than reinterpreted.
 */
export function verifyPersistedPlanBinding(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  if (value === undefined) return { kind: "absent" };
  try {
    if (!isPlainObject(value)) {
      return contractCorrupt(
        "plan binding is not a record of { planRevision, contractSnapshots, nodeBindings }",
      );
    }
    const planRevision = value.planRevision;
    if (typeof planRevision !== "string" || planRevision.length === 0) {
      return contractCorrupt(
        `plan binding planRevision is ${describeBindingValue(planRevision)}, not a non-empty string`,
      );
    }
    const record = verifyContractRecord(value, nodeIds, "plan binding");
    if (!record.ok) return contractCorrupt(record.reason);
    return { kind: "verified" };
  } catch (err) {
    // Totality backstop: a hostile container (a Proxy trap, a throwing getter
    // on the binding record itself) is corrupt contract data, never a loader
    // failure.
    return contractCorrupt(`plan binding verification failed: ${errorText(err)}`);
  }
}

/** The authoring grammar a compiled plan is always built from (B5). */
const COMPILED_DECLARATION_VERSION = 3;

/**
 * Verify one persisted compiled-plan record (B7) against its own body.
 *
 * Same contract as {@link verifyPersistedPlanBinding}: PURE and TOTAL, every
 * violation is `corrupt(contract)`, and a hostile record is contained rather
 * than thrown. Checks, in this order:
 * (a) shape — the record is an object, `planRevision` / `graphId` are non-empty
 *     strings, `graphId` is the persisted graph's own id, the declaration version
 *     is the grammar this build compiles (3), and `nodes` / `edges` /
 *     `loopGroups` are arrays;
 * (a2) executability — the record must be the plan this state may RUN. The
 *     `executability` field is read by the plan module's own reader; a DRAFT is
 *     refused by name (`plan-not-executable`) and a malformed value is refused
 *     as a malformed record. A draft's acceptance requirements were never
 *     resolved, so loading one as executable would run gates that were never
 *     checked (B9);
 * (b) topology — {@link inspectCompiledTopology} applies EVERY plan-level rule
 *     the compiler guarantees — unique node ids, at least one outcome per node,
 *     every edge endpoint declared, every edge outcome declared by its source,
 *     loop membership and routes, a positive traversal cap, a continuation
 *     outcome carried by an edge inside its group, cycle containment, the
 *     explicit non-empty and edge-consistent `terminalOutcomes` list, and a
 *     pinned acceptance version on every requirement of an executable plan —
 *     and every node id the topology declares must be one the persisted state
 *     declares;
 * (b2) index — `nodeBindings` is the projection of the plan nodes it claims to
 *     be: a node that declares a `contractRef` must appear with the same ref, a
 *     node that declares none must not appear, and every key must be a topology
 *     node id. The plan revision does not cover this field, so without the
 *     projection a rebinding could hide behind an otherwise valid snapshot;
 * (c) contracts — {@link verifyContractRecord} owns the content, identity and
 *     node-binding rules for the record;
 * (d) identity — `planRevision` is `contractDigest` over the record's own plan
 *     body (`graphId`, `declarationVersion`, `nodes`, `edges`, `loopGroups`,
 *     `contractSnapshots`, `contractIdentities`, `terminalOutcomes`,
 *     `executability`), recomputed here from the persisted values, so a tampered
 *     body or a revision copied from another plan is refused. `nodeBindings` is
 *     deliberately NOT part of that body: it is the projection checked in (b2).
 *
 * NOT proven here: the field-level schema of node and edge internals beyond
 * the ids, outcomes, contract refs and topology the rules read (a node agent,
 * prompt, completion policy, join or budget is opaque JSON covered by the plan
 * revision), and the deliberately partial topology rule set
 * (`inspectCompiledTopology` names the compiler rules it does not re-derive).
 * The plan is not an execution authority in this slice (recovery still resumes
 * from the declaration), so this gate proves identity and structure; a later
 * consumer that makes the plan authoritative must extend this gate rather than
 * trust it.
 */
export function verifyPersistedCompiledPlan(
  value: unknown,
  graphId: string,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  if (value === undefined) return { kind: "absent" };
  try {
    if (!isPlainObject(value)) {
      return contractCorrupt(
        "compiled plan record is not a record of { graphId, declarationVersion, planRevision, nodes, edges, loopGroups, contractSnapshots, nodeBindings }",
      );
    }
    const planRevision = value.planRevision;
    if (typeof planRevision !== "string" || planRevision.length === 0) {
      return contractCorrupt(
        `compiled plan planRevision is ${describeBindingValue(planRevision)}, not a non-empty string`,
      );
    }
    const recordGraphId = value.graphId;
    if (typeof recordGraphId !== "string" || recordGraphId.length === 0) {
      return contractCorrupt(
        `compiled plan graphId is ${describeBindingValue(recordGraphId)}, not a non-empty string`,
      );
    }
    if (recordGraphId !== graphId) {
      return contractCorrupt(
        `compiled plan graphId ${JSON.stringify(recordGraphId)} is not the persisted graphId ${JSON.stringify(graphId)}`,
      );
    }
    if (value.declarationVersion !== COMPILED_DECLARATION_VERSION) {
      return contractCorrupt(
        `compiled plan declarationVersion is ${describeBindingValue(value.declarationVersion)}, not the compiled grammar ${COMPILED_DECLARATION_VERSION}`,
      );
    }
    const nodes = value.nodes;
    const edges = value.edges;
    const loopGroups = value.loopGroups;
    if (!Array.isArray(nodes)) {
      return contractCorrupt("compiled plan nodes is not an array of compiled nodes");
    }
    if (!Array.isArray(edges)) {
      return contractCorrupt("compiled plan edges is not an array of compiled edges");
    }
    if (!Array.isArray(loopGroups)) {
      return contractCorrupt("compiled plan loopGroups is not an array of compiled loop groups");
    }

    // (a2) EXECUTABILITY — a persisted `compiledPlan` means "the plan this
    // state may run". A DRAFT never had its acceptance requirements resolved,
    // so it is refused BY NAME here instead of being loaded as executable; a
    // malformed value is refused as a malformed record. The reading is the plan
    // module's own, so the compiler's marker and this gate cannot drift.
    const executability = readPlanExecutability(value.executability);
    if (executability.kind !== "executable") {
      if (executability.kind === "draft") {
        return contractCorrupt(
          `compiled plan is not executable (${NON_EXECUTABLE_PLAN_CODE}): it is a DRAFT whose acceptance requirements were never resolved — a draft must not be loaded as an executable plan`,
        );
      }
      return contractCorrupt(
        `compiled plan executability is ${describeBindingValue(value.executability)}, not { kind: "executable" }`,
      );
    }

    // (b) TOPOLOGY — every plan-level rule, owned next to the plan shape.
    const topology = inspectCompiledTopology(
      nodes,
      edges,
      loopGroups,
      value.terminalOutcomes,
      value.executability,
    );
    if (topology.issues.length > 0) {
      const issue = topology.issues[0];
      return contractCorrupt(
        `compiled plan topology is inconsistent (${issue.code}): ${issue.message}`,
      );
    }
    const topologyNodeIds = new Set(topology.nodeIds);
    for (const nodeId of topology.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        return contractCorrupt(
          `compiled plan topology declares node id ${JSON.stringify(nodeId)}, which the persisted state does not declare`,
        );
      }
    }

    // (b2) INDEX — `nodeBindings` is the ONE record field the plan revision
    // does not cover, so it is checked as what the type says it is: the
    // projection of the plan nodes (`createPersistedCompiledPlan` builds it
    // with `nodeBindingsOf`). Every node that declares a `contractRef` must
    // appear with the SAME ref, a node that declares none must not appear, and
    // every key must be a topology node id — otherwise a rebinding could hide
    // behind an otherwise valid snapshot.
    const rawNodeBindings = value.nodeBindings;
    if (isPlainObject(rawNodeBindings)) {
      const indexKeys = Object.keys(rawNodeBindings);
      for (const raw of nodes) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const nodeRef = raw.contractRef;
        if (nodeRef === undefined) {
          if (indexKeys.includes(raw.id)) {
            return contractCorrupt(
              `compiled plan node binding ${JSON.stringify(raw.id)} binds a node that declares no contractRef`,
            );
          }
          continue;
        }
        if (!isContractRef(nodeRef)) {
          return contractCorrupt(
            `compiled plan node ${JSON.stringify(raw.id)} contractRef is not a contract ref { id, revision, digest } of non-empty strings`,
          );
        }
        const boundRef = rawNodeBindings[raw.id];
        if (!isContractRef(boundRef)) {
          return contractCorrupt(
            `compiled plan node ${JSON.stringify(raw.id)} declares a contractRef the nodeBindings index does not carry`,
          );
        }
        if (!contractRefsEqual(boundRef, nodeRef)) {
          return contractCorrupt(
            `compiled plan node binding ${JSON.stringify(raw.id)} is ${describeContractRef(boundRef)}, but the node declares ${describeContractRef(nodeRef)}`,
          );
        }
      }
      for (const nodeId of [...indexKeys].sort()) {
        if (!topologyNodeIds.has(nodeId)) {
          return contractCorrupt(
            `compiled plan node binding references node id ${JSON.stringify(nodeId)}, which its topology does not declare`,
          );
        }
      }
    }

    // (c) CONTRACTS — the same rules the persisted binding is held to.
    const contracts = verifyContractRecord(value, nodeIds, "compiled plan");
    if (!contracts.ok) return contractCorrupt(contracts.reason);

    // (d) IDENTITY — the compiler's own content address, recomputed over the
    // record's plan body. `contractDigest` is reused, never re-implemented.
    let bodyDigest: string;
    try {
      bodyDigest = contractDigest({
        graphId: recordGraphId,
        declarationVersion: value.declarationVersion,
        nodes,
        edges,
        loopGroups,
        contractSnapshots: value.contractSnapshots,
        contractIdentities: value.contractIdentities,
        terminalOutcomes: value.terminalOutcomes,
        executability: value.executability,
      });
    } catch (err) {
      return contractCorrupt(
        `compiled plan body was rejected by contractDigest: ${errorText(err)}`,
      );
    }
    if (bodyDigest !== planRevision) {
      return contractCorrupt(
        `compiled plan planRevision ${JSON.stringify(planRevision)} is not the digest (${bodyDigest}) of its plan body`,
      );
    }
    return { kind: "verified" };
  } catch (err) {
    return contractCorrupt(
      `compiled plan verification failed: ${errorText(err)}`,
    );
  }
}

/**
 * Verify everything a state persists about its compiled plan: the B7
 * `compiledPlan` record, the B6 `planBinding`, and their agreement when both
 * are present.
 *
 * Either record ALONE is legal and verified on its own terms: the plan record is
 * the complete durable plan (its identity is recomputed from its own body),
 * while a binding without a plan is the B6 record of a graph whose topology was
 * never persisted — its snapshots and node bindings are verified, and its
 * `planRevision` stays an unverifiable foreign key because no plan body is
 * present to recompute it from. Requiring both would refuse states this build
 * can still verify, and refusing a lone binding would silently drop the B6
 * accepted set.
 *
 * When BOTH are present they must AGREE, and disagreement is corrupt(contract):
 * the two records are projections of one compiled plan, so any difference means
 * one of them was tampered with or copied from another plan. See
 * {@link verifyPersistedPlanAgreement}.
 */
export function verifyPersistedPlan(
  compiledPlan: unknown,
  planBinding: unknown,
  graphId: string,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  const binding = verifyPersistedPlanBinding(planBinding, nodeIds);
  if (binding.kind === "corrupt") return binding;
  const plan = verifyPersistedCompiledPlan(compiledPlan, graphId, nodeIds);
  if (plan.kind === "corrupt") return plan;
  if (plan.kind === "absent" || binding.kind === "absent") {
    return plan.kind === "absent" ? binding : plan;
  }
  return verifyPersistedPlanAgreement(compiledPlan, planBinding);
}

/**
 * The agreement rules for a state that persists BOTH records.
 *
 * Reached only after both records passed their own gates, and still written as
 * a TOTAL function: the shape guards below can only fire for a shape the gates
 * would already have refused, and keeping them means a direct caller cannot
 * make this throw. Checks:
 * (a) the binding `planRevision` equals the plan `planRevision`;
 * (b) every contract digest the binding REFERENCES — its snapshot keys, its
 *     identity-index digests and its node binding refs — is one the plan pins;
 * (b2) the two identity indexes AGREE exactly: every `(id, revision)` the
 *     binding maps is mapped by the plan to the same digest, and every identity
 *     the plan maps is mapped by the binding. Both records are projections of
 *     ONE plan, so a missing or extra identity is a disagreement rather than a
 *     tolerated projection difference;
 * (c) every node the binding binds is bound by the plan to the SAME ref.
 */
function verifyPersistedPlanAgreement(
  compiledPlan: unknown,
  planBinding: unknown,
): PlanBindingVerdict {
  try {
    if (!isPlainObject(compiledPlan) || !isPlainObject(planBinding)) {
      return contractCorrupt(
        "compiled plan and plan binding are both present but not comparable records",
      );
    }
    const planRevision = compiledPlan.planRevision;
    const bindingRevision = planBinding.planRevision;
    if (bindingRevision !== planRevision) {
      return contractCorrupt(
        `plan binding planRevision ${JSON.stringify(bindingRevision)} does not equal the compiled plan planRevision ${JSON.stringify(planRevision)}`,
      );
    }
    const planSnapshots = compiledPlan.contractSnapshots;
    const bindingSnapshots = planBinding.contractSnapshots;
    const planIdentities = compiledPlan.contractIdentities;
    const bindingIdentities = planBinding.contractIdentities;
    const planBindings = compiledPlan.nodeBindings;
    const bindingBindings = planBinding.nodeBindings;
    if (
      !isPlainObject(planSnapshots) ||
      !isPlainObject(bindingSnapshots) ||
      !isPlainObject(planIdentities) ||
      !isPlainObject(bindingIdentities) ||
      !isPlainObject(planBindings) ||
      !isPlainObject(bindingBindings)
    ) {
      return contractCorrupt(
        "compiled plan and plan binding carry records the agreement check cannot compare",
      );
    }
    // (b) Every digest the binding references, read from EVERY kind of
    // reference — content keys, identity-index values and node binding refs: a
    // binding that keeps content or an identity the plan does not pin is a
    // projection that disagrees with its plan, whether or not a node still
    // binds it.
    const referenced = new Set<string>(Object.keys(bindingSnapshots));
    for (const revisions of Object.values(bindingIdentities)) {
      if (!isPlainObject(revisions)) continue;
      for (const digest of Object.values(revisions)) {
        if (typeof digest === "string" && digest.length > 0) {
          referenced.add(digest);
        }
      }
    }
    for (const boundRef of Object.values(bindingBindings)) {
      if (isContractRef(boundRef)) referenced.add(boundRef.digest);
    }
    for (const digest of [...referenced].sort()) {
      if (!Object.prototype.hasOwnProperty.call(planSnapshots, digest)) {
        return contractCorrupt(
          `plan binding references contract digest ${JSON.stringify(digest)}, which the compiled plan contractSnapshots does not contain`,
        );
      }
    }
    // (b2) The two identity indexes must agree EXACTLY. The binding is a
    // projection of the plan, so an identity only one of them maps is a
    // disagreement (a stale or tampered projection), not a legal difference —
    // and two identities sharing one digest still compare equal here.
    for (const id of Object.keys(bindingIdentities).sort()) {
      const bindingRevisions = bindingIdentities[id];
      const planRevisions = planIdentities[id];
      if (!isPlainObject(bindingRevisions) || !isPlainObject(planRevisions)) {
        return contractCorrupt(
          `plan binding contract identity ${JSON.stringify(id)} does not match the compiled plan identity index`,
        );
      }
      for (const revision of Object.keys(bindingRevisions).sort()) {
        const bindingDigest = bindingRevisions[revision];
        if (planRevisions[revision] !== bindingDigest) {
          return contractCorrupt(
            `plan binding maps contract ${JSON.stringify(id)}@${JSON.stringify(revision)} to ${describeBindingValue(bindingDigest)}, but the compiled plan maps it to ${describeBindingValue(planRevisions[revision])}`,
          );
        }
      }
      for (const revision of Object.keys(planRevisions).sort()) {
        if (!Object.prototype.hasOwnProperty.call(bindingRevisions, revision)) {
          return contractCorrupt(
            `compiled plan maps contract ${JSON.stringify(id)}@${JSON.stringify(revision)}, which the plan binding identity index does not carry`,
          );
        }
      }
    }
    for (const id of Object.keys(planIdentities).sort()) {
      if (!Object.prototype.hasOwnProperty.call(bindingIdentities, id)) {
        return contractCorrupt(
          `compiled plan carries contract identity ${JSON.stringify(id)}, which the plan binding identity index does not carry`,
        );
      }
    }
    // (c) The plan and the binding must bind each node to the same identity.
    for (const nodeId of Object.keys(bindingBindings).sort()) {
      const boundRef = bindingBindings[nodeId];
      if (!isContractRef(boundRef)) {
        return contractCorrupt(
          `plan binding node binding ${JSON.stringify(nodeId)} is not a contract ref`,
        );
      }
      const planRef = planBindings[nodeId];
      if (planRef === undefined) {
        return contractCorrupt(
          `plan binding binds node ${JSON.stringify(nodeId)}, which the compiled plan does not bind`,
        );
      }
      if (!isContractRef(planRef)) {
        return contractCorrupt(
          `compiled plan node binding ${JSON.stringify(nodeId)} is not a contract ref`,
        );
      }
      if (!contractRefsEqual(planRef, boundRef)) {
        return contractCorrupt(
          `plan binding binds node ${JSON.stringify(nodeId)} to ${describeContractRef(boundRef)}, but the compiled plan binds it to ${describeContractRef(planRef)}`,
        );
      }
    }
    return { kind: "verified" };
  } catch (err) {
    return contractCorrupt(
      `compiled plan / plan binding agreement check failed: ${errorText(err)}`,
    );
  }
}

// ── Format-2 decoder and the default registry (B2) ──────────────────────────

/**
 * The registered decoder for storage format 2 — the SINGLE owner of the v2
 * hydration gates.
 *
 * Every gate the loader used to run inline now lives in `decode`:
 * `graphId` / `phase` presence, the top-level + node-level required-shape gate,
 * the enum-vocabulary gate and `deserializeEngineState`. The method is TOTAL by
 * contract (the registry capability's documented promise): each rejection path
 * it owns answers `{ kind: "invalid", reason }` with the SAME diagnostic text
 * the legacy loader emitted, and the surrounding try/catch contains anything a
 * deeper malformation throws. It never returns a partial or unvalidated state,
 * and it never throws — the loader maps `invalid` onto `corrupt` on the axis
 * the verdict names: `storage` when it names none, and `contract` for a
 * persisted plan binding or compiled-plan record that fails verification (see
 * {@link verifyPersistedPlan}).
 *
 * It is ALSO the single owner of the one legitimate execution-protocol
 * BACKFILL: format 2 IS the legacy signal protocol, so when a validated v2
 * record carries no `executionProtocolVersion`, this decoder — and only this
 * decoder — infers {@link LEGACY_SIGNAL_PROTOCOL} and the hydrated state
 * carries it explicitly. A future format-3 decoder may not do the same: an
 * absent identity there is resolved by nobody, stays `undefined`, and the
 * loader reports `corrupt(execution)` — a new format never inherits the
 * legacy identity by default.
 *
 * Kept module-private: the only supported way to obtain it is through
 * {@link DEFAULT_STORAGE_FORMAT_REGISTRY}, which hands out the same frozen
 * object.
 */
const STORAGE_FORMAT_V2_DECODER: StorageFormatDecoder = {
  format: STORAGE_FORMAT_V2,
  decode(parsed: unknown): StorageDecodeResult {
    const file = parsed as Partial<EnginePersistenceFile>;
    try {
      if (typeof file.graphId !== "string") {
        return {
          kind: "invalid",
          reason: "graphId is missing or not a string",
        };
      }
      if (typeof file.phase !== "string") {
        return {
          kind: "invalid",
          reason: "phase is missing or not a string",
        };
      }
      // Required-field gate — a parseable-but-structurally-incomplete file is
      // treated as corrupt. Absent fields would make deserializeEngineState
      // throw on Object.entries / array-spread (see the module finding);
      // gating presence here keeps the total-hydration contract total.
      if (!hasRequiredShape(file)) {
        return {
          kind: "invalid",
          reason: "required field missing or wrong type",
        };
      }
      // R2: reject out-of-vocabulary enums BEFORE hydration — a
      // corrupt-but-shape-valid file (`status:'bogus'`) must surface as
      // corrupt, never as a state that crashes later in canTransitionNode.
      assertValidEnums(file);
      const state = deserializeEngineState(file as EnginePersistenceFile);
      // B6/B7 CONTRACT GATE — the persisted plan binding and the persisted
      // compiled-plan record are verified BEFORE this decoder may answer `ok`,
      // so a tampered, stale, hostile or mutually inconsistent record is
      // refused here and never becomes an executable state. EITHER record
      // being ABSENT is legal (a legacy graph with no compiled plan, or a plan
      // whose binding was never written) and skips the gates that need it. The
      // verdict's axis is carried on the decoder's `invalid` result, so the
      // loader reports corrupt(contract) instead of folding the failure into
      // the storage axis.
      const plan = verifyPersistedPlan(
        state.compiledPlan,
        state.planBinding,
        state.graphId,
        new Set(state.nodes.keys()),
      );
      if (plan.kind === "corrupt") {
        return {
          kind: "invalid",
          reason: plan.reason,
          dimension: "contract",
        };
      }
      // B3 BACKFILL — owned HERE, by the format-2 (legacy) decoder, and
      // nowhere else. If the record predates the field, format 2 IS the legacy
      // signal protocol, so the hydrated state is given that identity
      // explicitly; an explicit value is carried through untouched and the
      // loader classifies it (bound / unsupported / corrupt). A decoder for a
      // NEWER format deliberately does not do this, so a missing identity
      // there surfaces as corrupt(execution) rather than a silent legacy run.
      return {
        kind: "ok",
        state:
          state.executionProtocolVersion === undefined
            ? { ...state, executionProtocolVersion: LEGACY_SIGNAL_PROTOCOL }
            : state,
      };
    } catch (err) {
      // Deep structural invalidity (malformed nested shapes) or an
      // out-of-vocabulary enum value is still corrupt — contained here, never
      // thrown past the decoder or the loader.
      return {
        kind: "invalid",
        reason: `hydration failed: ${errorText(err)}`,
      };
    }
  },
};

/**
 * The registry this build ships: exactly one decoder (format 2) and no
 * migrations.
 *
 * `migrations` is intentionally empty — no on-disk predecessor format has a
 * registered conversion, and this delivery deliberately ships no migrator. It
 * stays a capability LIST rather than a hard-coded branch so a test (or a later
 * release) can install a real migration and exercise the `migration-required`
 * path without editing this module.
 *
 * Assembled HERE, not in `storage-format.ts`: that module owns the capability
 * vocabulary and must stay a runtime dependency leaf, while the format-2
 * decoder needs v2 hydration — which lives in this module. The registry is
 * deeply frozen by {@link createStorageFormatRegistry}, so its accepted set
 * cannot move after construction; widening support stays the injectable
 * `registry` parameter's job.
 */
export const DEFAULT_STORAGE_FORMAT_REGISTRY: StorageFormatRegistry =
  createStorageFormatRegistry({
    current: STORAGE_FORMAT_V2,
    decoders: [STORAGE_FORMAT_V2_DECODER],
    migrations: [],
  });

// ── Standalone load (exported for direct, testable use) ─────────────────────

/**
 * Diagnostic for an `invalid` storage-format verdict: name what was received.
 *
 * The cases are worded separately on purpose — a missing field, a quoted `"2"`,
 * a fractional `2.5`, `NaN` and `Infinity` are different defects, and the
 * startup report must not make them read alike.
 */
function invalidFormatReason(value: unknown): string {
  const expected = ": expected a positive safe integer";
  if (value === undefined) return `storage format version is missing${expected}`;
  if (value === null) return `storage format version is null${expected}`;
  if (typeof value === "string") {
    return `storage format version is the string ${JSON.stringify(value)}${expected}`;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return `storage format version is NaN${expected}`;
    if (value === Number.POSITIVE_INFINITY) {
      return `storage format version is Infinity${expected}`;
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return `storage format version is -Infinity${expected}`;
    }
    if (!Number.isInteger(value)) {
      return `storage format version is the non-integer number ${value}${expected}`;
    }
    if (value <= 0) {
      return `storage format version is the non-positive number ${value}${expected}`;
    }
    return `storage format version is the unsafe integer ${value}${expected}`;
  }
  if (Array.isArray(value)) {
    return `storage format version is an array${expected}`;
  }
  if (typeof value === "object") {
    return `storage format version is an object${expected}`;
  }
  return `storage format version is a ${typeof value}${expected}`;
}

/**
 * Diagnostic for an `invalid` execution-protocol verdict: name what was
 * received.
 *
 * The mirror of {@link invalidFormatReason} on the execution axis — the same
 * separate wording for a missing field, a quoted `"1"`, a fractional `1.5`,
 * a non-positive `0`, `NaN` and `Infinity`, so a malformed protocol identity
 * does not read like a malformed storage version.
 */
function invalidExecutionProtocolReason(value: unknown): string {
  const expected = ": expected a positive safe integer";
  if (value === undefined) {
    return `execution protocol version is missing${expected}`;
  }
  if (value === null) {
    return `execution protocol version is null${expected}`;
  }
  if (typeof value === "string") {
    return `execution protocol version is the string ${JSON.stringify(value)}${expected}`;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return `execution protocol version is NaN${expected}`;
    }
    if (value === Number.POSITIVE_INFINITY) {
      return `execution protocol version is Infinity${expected}`;
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return `execution protocol version is -Infinity${expected}`;
    }
    if (!Number.isInteger(value)) {
      return `execution protocol version is the non-integer number ${value}${expected}`;
    }
    if (value <= 0) {
      return `execution protocol version is the non-positive number ${value}${expected}`;
    }
    return `execution protocol version is the unsafe integer ${value}${expected}`;
  }
  if (Array.isArray(value)) {
    return `execution protocol version is an array${expected}`;
  }
  if (typeof value === "object") {
    return `execution protocol version is an object${expected}`;
  }
  return `execution protocol version is a ${typeof value}${expected}`;
}

/**
 * Classify one decoded protocol identity with containment.
 *
 * {@link classifyExecutionProtocol} is total for a well-formed registry, so
 * the `probe-failed` arm is unreachable today; it exists for the same reason
 * as {@link validateMigrationSource}: a handler probe is a registered
 * capability and COULD throw (a hostile or hand-built registry whose
 * `version` getter rejects), and the loader documents a total contract. A
 * throw maps onto `corrupt(execution)`: the file is preserved, the graph
 * stays non-executable, and an identity that could not be verified is never
 * bound to a handler and never silently run under legacy rules.
 */
function classifyProtocolContained(
  value: unknown,
  registry: ExecutionProtocolRegistry,
): ExecutionProtocolVerdict | { kind: "probe-failed"; reason: string } {
  try {
    return classifyExecutionProtocol(value, registry);
  } catch (err) {
    return { kind: "probe-failed", reason: errorText(err) };
  }
}

/**
 * Parse a raw state-file string and return a structured {@link EngineLoadResult}
 * that keeps every non-valid outcome distinguishable. Shared by
 * {@link EnginePersistence.loadForResume} so the full version / malformation
 * gate is testable without touching the filesystem.
 *
 * **Total hydration**: this function NEVER throws. A file that is corrupt JSON,
 * missing a usable version discriminator, structurally invalid at any deeper
 * level, or carrying an out-of-vocabulary enum value (`status` / `joinStrategy`
 * / `phase`) comes back as `corrupt`; a numeric version the registry does not
 * decode comes back as `unsupported` (storage) or `migration-required`. A
 * parseable-but-field-incomplete file must never make recovery throw, because
 * that would leave the graph permanently unrecoverable (re-failing every
 * restart). Missing required fields are treated as CORRUPT, not as a migration
 * point — `ENGINE_PERSISTENCE_VERSION` stays `2`.
 *
 * Gate order — the SAME accepted input set as the legacy null-shaped loader
 * for every file the legacy loader already accepted; the execution-protocol
 * gate (4) is the one new gate that can refuse a file it would have run:
 * 1. JSON.parse failure / non-object → `corrupt(storage)`;
 * 2. a `version` that is not a legal format identifier — missing, `null`, a
 *    string, a non-integer, a non-positive number, `NaN` / `Infinity`, or an
 *    integer outside the safe range — → `corrupt(storage)`, via the
 *    classifier's `invalid` verdict (a file with no usable discriminator is
 *    malformed, not an unsupported format);
 * 3. a legal identifier → {@link classifyStorageFormat} selects the registered
 *    CAPABILITY for it, and the loader dispatches on that capability — it never
 *    re-derives support from the number:
 *    - `decodable` → the registered decoder's `decode(parsed)` owns every gate
 *      of its own format (graphId / phase presence, the required-shape gate
 *      including its node level, the enum gate and hydration) and is total:
 *      `ok` → the protocol gate below; `invalid` → `corrupt(storage)`
 *      carrying the decoder's reason. The decoder also RESOLVES the record's
 *      execution-protocol identity — the format-2 decoder backfills
 *      `LEGACY_SIGNAL_PROTOCOL` when the field is absent, any other decoder
 *      leaves it unresolved — and VERIFIES the persisted plan records (the B6
 *      binding and the B7 compiled plan), marking the `invalid` verdict with
 *      the `contract` axis when one fails or the two disagree;
 *    - `migratable` → the registered migration's `validateSource(parsed)` runs
 *      FIRST: a rejected source is `corrupt(storage)` (the body violates the
 *      format it claims to be, so there is nothing safe to convert), and only
 *      an accepted source is `migration-required`. The body is never validated
 *      against the TARGET layout — that belongs to the conversion. Protocol
 *      selection for a conversion is pinned by the conversion itself, so no
 *      protocol identity is guessed here;
 *    - `unsupported` → `unsupported` carrying the raw value, WITHOUT validating
 *      the body ("Unknown, structurally valid storage version →
 *      `unsupported(storage)`; do not validate its body against today's
 *      layout").
 * 4. EXECUTION-PROTOCOL gate — the identity the decoder resolved is classified
 *    by {@link classifyExecutionProtocol} against the protocol registry, with
 *    the SAME legality rule as the storage classifier (positive safe integer,
 *    membership decides support):
 *    - `bound` → `valid{state, storageFormat, executionProtocol}`;
 *    - `invalid` → `corrupt(execution)` naming what was received; an
 *      unresolved identity (a future format that lacks the field) lands here
 *      too, so it is never guessed as legacy;
 *    - `unsupported` → `unsupported(execution)` carrying the legal version —
 *      a protocol without a registered handler is REFUSED, never run under
 *      legacy rules.
 *
 * `_sourceLabel` is retained for signature compatibility with the read path
 * (the file path) and is currently unused — the raw string is the whole input.
 */
export function loadEngineStateForResume(
  raw: string,
  _sourceLabel?: string,
  registry: StorageFormatRegistry = DEFAULT_STORAGE_FORMAT_REGISTRY,
  protocolRegistry: ExecutionProtocolRegistry = LEGACY_EXECUTION_PROTOCOL_REGISTRY,
): EngineLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "corrupt",
      dimension: "storage",
      reason: `corrupt JSON: ${errorText(err)}`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      kind: "corrupt",
      dimension: "storage",
      reason: "not a JSON object",
    };
  }
  const file = parsed as Partial<EnginePersistenceFile>;
  // Version gate — the classifier owns which values are legal format
  // identifiers; the loader only maps its verdict onto a load result. An
  // illegal identifier is a malformed discriminator, hence corrupt(storage) —
  // NOT a format this build does not support. `invalid` is handled explicitly
  // (no `default:`): a future verdict member must be classified here rather
  // than silently folded into one of today's outcomes.
  const verdict = classifyStorageFormat(file.version, registry);
  if (verdict.kind === "invalid") {
    return {
      kind: "corrupt",
      dimension: "storage",
      reason: invalidFormatReason(verdict.value),
    };
  }
  if (verdict.kind === "decodable") {
    // The registered decoder owns this exact format AND every gate that
    // decides whether the body is a member of it. Its total contract means a
    // rejected body is a DATA verdict (corrupt), never a missing capability.
    const decoded = verdict.decoder.decode(parsed);
    if (decoded.kind === "invalid") {
      return {
        kind: "corrupt",
        // The decoder OBSERVED the violation, so it owns the axis: a decoder
        // that names none rejected the body against its own format (the
        // historical storage verdict), while the format-2 decoder names
        // `contract` only when a persisted plan record fails verification.
        dimension: decoded.dimension ?? "storage",
        reason: decoded.reason,
      };
    }
    // EXECUTION-PROTOCOL gate (B3). The decoder resolved this format's
    // protocol identity; the classifier — the single owner of which protocol
    // identifiers are legal, and of whether one has a registered handler —
    // turns it into a verdict. The format-2 decoder backfills the legacy
    // identity for an absent field; a decoder for any other format resolves
    // nothing, so an absent value is a malformed identity here (corrupt),
    // never a silent legacy run.
    const protocol = classifyProtocolContained(
      decoded.state.executionProtocolVersion,
      protocolRegistry,
    );
    // Defensive arm, kept deliberately: classification is total for a
    // well-formed registry, but a hand-built / hostile one whose handler
    // probe throws must still surface as a non-executable load result
    // (corrupt execution), never as a crash that would make the graph
    // permanently unrecoverable.
    if (protocol.kind === "probe-failed") {
      return {
        kind: "corrupt",
        dimension: "execution",
        reason: `execution protocol handler probe threw: ${protocol.reason}`,
      };
    }
    if (protocol.kind === "invalid") {
      return {
        kind: "corrupt",
        dimension: "execution",
        reason: invalidExecutionProtocolReason(protocol.value),
      };
    }
    if (protocol.kind === "unsupported") {
      // A legal protocol identity with no registered handler: the file is
      // intact but this build has no decision rules for it — refuse, never
      // substitute the legacy handler.
      return {
        kind: "unsupported",
        dimension: "execution",
        detail: String(protocol.version),
      };
    }
    return {
      kind: "valid",
      state: decoded.state,
      storageFormat: verdict.format,
      executionProtocol: protocol.version,
    };
  }
  if (verdict.kind === "migratable") {
    // Source validation FIRST, before any migration promise: an intact source
    // is merely missing a capability (migration-required), while a source that
    // violates its own format is corrupt data. Collapsing the two would either
    // promise a conversion for garbage or report a build limitation as bad
    // data.
    const source = validateMigrationSource(verdict.migration, parsed);
    if (!source.ok) {
      return {
        kind: "corrupt",
        dimension: "storage",
        reason: `migration source (format ${verdict.from}) failed validation: ${source.reason}`,
      };
    }
    // The source passed ITS format's check. The body is still never validated
    // against today's layout — it belongs to the source format, and the
    // conversion owns the rest.
    return {
      kind: "migration-required",
      dimension: "storage",
      from: verdict.from,
      to: verdict.to,
    };
  }
  return {
    kind: "unsupported",
    dimension: "storage",
    detail: String(verdict.format),
  };
}

/**
 * Run a migration's `validateSource` with containment.
 *
 * `validateSource` is a registered capability, so it could throw; this loader
 * documents a total contract ("this function NEVER throws"). A throw is
 * therefore mapped onto the same `{ ok: false, reason }` shape a returned
 * rejection uses, keeping the caller's corrupt-vs-migration-required decision
 * intact and the diagnostic honest about what happened.
 */
function validateMigrationSource(
  migration: StorageFormatMigration,
  parsed: unknown,
): { ok: true } | { ok: false; reason: string } {
  try {
    return migration.validateSource(parsed);
  } catch (err) {
    return {
      ok: false,
      reason: `validateSource threw: ${errorText(err)}`,
    };
  }
}

/**
 * Legacy null-shaped compatibility wrapper around
 * {@link loadEngineStateForResume}.
 *
 * New callers that must distinguish `absent` / `corrupt` / `unsupported` /
 * `migration-required` should call {@link loadEngineStateForResume} (or
 * {@link EnginePersistence.loadForResume}) directly. This function exists only
 * so callers that treat "not a valid state" as one clean-start signal keep
 * their exact behavior: it is a strict projection of the structured result —
 * `valid` → the hydrated state, every other kind → `null`.
 *
 * Parse a raw state-file string and return the hydrated {@link EngineState},
 * or `null` when it is not a valid version-`2` engine state file. Shared by
 * {@link EnginePersistence.load} so the version/malformation gate is testable
 * without touching the filesystem.
 *
 * **Total hydration**: this function NEVER throws. A file that is corrupt JSON,
 * a schema-version mismatch, missing a required field, structurally invalid
 * at any deeper level, or carrying an out-of-vocabulary enum value (`status` /
 * `joinStrategy` / `phase`) returns `null` (the documented corrupt-to-null
 * contract in the class header — `load()` doc at `EnginePersistence.load`). A
 * parseable-but-field-incomplete file must never make recovery throw, because
 * that would leave the graph permanently unrecoverable (re-failing every
 * restart). Missing required fields are treated as CORRUPT, not as a
 * migration point — `ENGINE_PERSISTENCE_VERSION` stays `2`.
 */
export function loadEngineStateFromJson(
  raw: string,
  _sourceLabel?: string,
): EngineState | null {
  const result = loadEngineStateForResume(raw, _sourceLabel);
  return result.kind === "valid" ? result.state : null;
}

/**
 * Structural presence gate for the required fields of a v2 engine-state file.
 *
 * **Top level** — beyond the collection/array fields, this also gates
 * `graphDeclaration` (an object — a missing declaration would otherwise let
 * deserializeEngineState return a state whose `graphDeclaration` is
 * `undefined`, and `hydrateEngineState`'s `clearUndeclaredLoopGroupIds` would
 * throw a TypeError OUTSIDE the load try/catch, breaking the "never throws /
 * permanently recoverable" contract — review 05-F2 / M15) and the scalar
 * lifecycle fields `startedAt` / `updatedAt` (numbers) / `advancingLock`
 * (boolean) — `undefined` timestamps would propagate into staleness math as
 * `NaN` comparisons that never fire, silently disabling node timeout
 * detection.
 *
 * **Node level (R2)** — every node entry must carry the fields hydration and
 * the runtime depend on: `agent` / `prompt` (strings), `needsApproval`
 * (boolean), `signalsObserved` / `upstreamResults` (objects) and
 * `tokensConsumed` (an object with the three NUMERIC counters). A node missing
 * any of them is CORRUPT (clean start, `null`) instead of a "shape-valid"
 * node hydrated by the old `as NodeRuntimeState["tokensConsumed"]` cast: that
 * cast let `{ ...undefined }` turn the required `tokensConsumed` into `{}`,
 * after which `inputTokens + outputTokens` was `NaN` → `null` through a JSON
 * round trip → the three `>=` ceiling comparisons in budget-bridge.ts were all
 * false and a declared `max_total_*` graph silently lost its budget gate.
 *
 * Behaviour change (node report §compat): files that previously "barely
 * loaded" — a node missing these fields — now load as a clean start.
 */
function hasRequiredShape(file: Partial<EnginePersistenceFile>): boolean {
  if (
    !isPlainObject(file.graphDeclaration) ||
    !isPlainObject(file.nodes) ||
    // D3: `file.edges` is NOT required — new files never carry it (the dead
    // field was removed). A legacy `edges` extra key is tolerated and ignored.
    !isPlainObject(file.loopGroups) ||
    !isPlainObject(file.signalLedger) ||
    !Array.isArray(file.frontier) ||
    !Array.isArray(file.pendingCompletions) ||
    !isPlainObject(file.budget) ||
    typeof file.startedAt !== "number" ||
    typeof file.updatedAt !== "number" ||
    typeof file.advancingLock !== "boolean"
  ) {
    return false;
  }
  // R2 node-level gate — the top-level container check alone let a
  // `{ status, joinStrategy }` stub pass all three gates and hydrate.
  for (const node of Object.values(file.nodes)) {
    if (!hasRequiredNodeShape(node)) return false;
  }
  return true;
}

/**
 * Node-level presence/type gate for one persisted node DTO (R2).
 *
 * Mirrors the required (non-optional) fields of {@link NodeRuntimeState} whose
 * absence would silently produce a type-legal but semantically broken node:
 * `agent` / `prompt` / `needsApproval` (the node's identity + pausing flag),
 * `signalsObserved` / `upstreamResults` (spread-iterated during hydration)
 * and the `tokensConsumed` counters (the budget gate reads them). Optional
 * additive fields are deliberately NOT required here.
 */
function hasRequiredNodeShape(node: unknown): boolean {
  if (!isPlainObject(node)) return false;
  if (
    typeof node.agent !== "string" ||
    typeof node.prompt !== "string" ||
    typeof node.needsApproval !== "boolean" ||
    !isPlainObject(node.signalsObserved) ||
    !isPlainObject(node.upstreamResults)
  ) {
    return false;
  }
  const tokens = node.tokensConsumed;
  if (!isPlainObject(tokens)) return false;
  return (
    typeof tokens.inputTokens === "number" &&
    typeof tokens.outputTokens === "number" &&
    typeof tokens.cost === "number"
  );
}

/** A JSON object (non-null, non-array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Join-strategy vocabulary + enum validation (R2 / C1) ────────────────────

/**
 * Legacy bare `"quorum"` marker (contract C1).
 *
 * `JOIN_STRATEGY_VALUES` contains `"quorum"` as a *declaration* vocabulary
 * member, and older persistence builds accepted every member of it — so files
 * on disk may carry the bare string, which carries NO count. It is not
 * runtime-valid (`ResolvedJoinStrategy` has no bare `"quorum"` member): the
 * two consumption points disagreed on it (`evaluateJoin` fell through to the
 * `all` branch, `shouldCancel` to `any`), so it must never reach the runtime
 * again — it is normalized here instead.
 */
const LEGACY_BARE_QUORUM_JOIN_STRATEGY = "quorum";

/**
 * Normalize a persisted `joinStrategy` into the runtime vocabulary.
 *
 * - `"all"` / `"any"` → unchanged;
 * - a legacy bare `"quorum"` → `{ quorum: 1 }` (the historical runtime
 *   default — validator-v2's old `?? 1`); the caller logs the downgrade;
 * - `{ quorum: positive-int }` → unchanged;
 * - anything else (an unknown string, a non-positive / fractional / non-number
 *   quorum, `null`, an array, …) → `undefined` = out of vocabulary = corrupt.
 *
 * Deliberately does NOT consult `JOIN_STRATEGY_VALUES`: that set is the
 * *declaration* vocabulary and still contains `"quorum"`, which must not be
 * admitted at the persistence trust boundary.
 */
function normalizeJoinStrategy(v: unknown): ResolvedJoinStrategy | undefined {
  if (v === "all" || v === "any") return v;
  if (v === LEGACY_BARE_QUORUM_JOIN_STRATEGY) return { quorum: 1 };
  if (isPlainObject(v)) {
    // `isPlainObject` narrows to Record<string, unknown> — no assertion needed
    // (the previous implementation cast this same read).
    const q = v.quorum;
    if (typeof q === "number" && Number.isInteger(q) && q > 0) {
      return { quorum: q };
    }
  }
  return undefined;
}

/**
 * Whether a persisted `joinStrategy` value can be normalized into the runtime
 * vocabulary. A legacy bare `"quorum"` counts as valid — it is normalized to
 * `{ quorum: 1 }` on hydration (with a warning), never rejected as corrupt;
 * every other out-of-vocabulary value is corrupt.
 */
function isValidJoinStrategy(v: unknown): boolean {
  return normalizeJoinStrategy(v) !== undefined;
}

/**
 * Assert that every persisted enum-valued field is a member of its vocabulary.
 *
 * R2 (corrupt-but-shape-valid files): `deserializeEngineState` previously
 * hydrated `status: "bogus"` / `joinStrategy: "bogus"` / `phase: "bogus"`
 * unchecked, crashing LATER with a TypeError in `canTransitionNode`
 * (node-lifecycle.ts — `VALID_NODE_TRANSITIONS[from]` on `undefined`). This
 * gate rejects out-of-vocabulary values up front:
 * - every node `status` ∈ {@link NODE_STATUS_VALUES};
 * - every node `joinStrategy` ∈ `"all" | "any"` / a `{ quorum: positive-int }`
 *   object / the normalizable legacy bare `"quorum"`;
 * - `file.phase` ∈ {@link ENGINE_PHASE_VALUES}.
 *
 * Throws a descriptive Error on the first violation, so
 * `deserializeEngineState` (whose contract returns a hydrated state, not
 * `null`) cannot silently hydrate an invalid enum. The never-throw loader
 * calls this BEFORE deserializing and maps any violation to `null` (clean
 * start) — see `loadEngineStateFromJson`.
 */
function assertValidEnums(file: Partial<EnginePersistenceFile>): void {
  const phase = file.phase;
  if (phase === undefined || !ENGINE_PHASE_VALUES.includes(phase)) {
    throw new Error(
      `engine-persist: phase "${String(file.phase)}" is not a valid EnginePhase`,
    );
  }
  for (const [id, node] of Object.entries(file.nodes ?? {})) {
    if (!NODE_STATUS_VALUES.includes(node.status)) {
      throw new Error(
        `engine-persist: node "${id}" status "${String(node.status)}" is not a valid NodeStatus`,
      );
    }
    if (!isValidJoinStrategy(node.joinStrategy)) {
      throw new Error(
        `engine-persist: node "${id}" joinStrategy "${String(node.joinStrategy)}" is not valid (expected "all", "any", or a { quorum: positive-int } object)`,
      );
    }
  }
}


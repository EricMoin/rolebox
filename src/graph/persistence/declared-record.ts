/**
 * Graph persistence — reading a DECLARED graph out of the unified store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHAT CHANGED, AND WHY THIS MODULE EXISTS. Before P1 item 5 a declared graph
 * was described by TWO durable records: the v2 engine-state container
 * (`engine-<slug>.json`, written once by `graph_declare` and refreshed after
 * every settlement by `outcome-projection.ts`) and the workspace's acceptance
 * store. The container was what every operator surface read. P1 item 5 deletes
 * that container: the graph's immutable definition and its run state now live in
 * ONE place — the workspace's `graph-acceptance-ledger.sqlite` — and every read
 * path answers from there.
 *
 * TWO THINGS LIVE HERE, AND ONLY ONE OF THEM SURVIVES P5:
 *
 * 1. THE PERMANENT HALF — decoding a stored definition. {@link decodeStoredDefinition}
 *    is a pure function of one `graph_definitions` row: it re-parses the
 *    declaration through the strict v3 front end, re-derives the declaration
 *    digest, verifies the persisted compiled plan AND its binding through the
 *    SAME `verifyPersistedPlan` gate the retired container's loader applied, and
 *    returns the plan as the run path's topology authority. Nothing here is
 *    approximate: a row that fails any gate is a structured refusal, never a
 *    partially trusted graph.
 *
 * 2. THE TEMPORARY HALF — {@link declaredEngineStateOf}. The status renderers,
 *    the drain audit and the console still read the `EngineState` shape
 *    (`types.engine-v2.ts`), which the neutral model does not replace until P5
 *    collapses those consumers onto the new query model. This function is the
 *    PURE IN-MEMORY mapping plan §4 item 5 explicitly permits at the QUERY
 *    BOUNDARY: `EngineState` in memory, derived from the stored definition plus
 *    the stored run-state body. It WRITES NOTHING, it is NEVER read by recovery
 *    or by the run path, and it must be deleted with its consumers in P5 — see
 *    the marker on the function itself.
 *
 * WHAT IS DELIBERATELY NOT RECONSTRUCTED. The mapping carries the plan's own
 * per-node fields (agent, prompt, declared join, declared budget, approval flag)
 * and the run's recorded lifecycle position. It invents no attempt id, no
 * dispatch task id, no credential, no frontier and no signal ledger: those
 * containers were the v2 shape's own bookkeeping, the neutral model has a
 * different home for every one of them, and fabricating them here would recreate
 * exactly the retired shape the plan forbids.
 *
 * Dependency direction: this module reads the store, the compiler's plan
 * verifier and the outcome state's reader. It imports no tool, no host and no
 * audit module.
 */

import { errorText } from "../../utils/error-text.ts";
import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { GraphDeclaration } from "../../types.graph-v2.ts";
import type { EngineState, LoopGroupRuntimeState, NodeRuntimeState, PlanBinding } from "../../types.engine-v2.ts";
import type { GraphDeclarationV3 } from "../compiler/declaration-v3.ts";
import { parseGraphDeclarationV3 } from "../compiler/parse-declaration-v3.ts";
import { contractDigest } from "../contracts/contract-definition.ts";
import type { CompiledPlan, PersistedCompiledPlan } from "../compiler/plan.ts";
import { verifyPersistedPlan } from "./engine-persistence.ts";
import { createEngineState, registerNode } from "./declared-state.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
import {
  readOutcomeGraphState,
  type OutcomeGraphPhase,
  type OutcomeGraphState,
  type OutcomeNodeStatus,
} from "../outcome/graph-state.ts";
import type { GraphStateRecord } from "../ledger/types.ts";
import type { GraphDefinitionRecord } from "../store/records.ts";
import { loadGraphStoreSync, type GraphStoreLoadResult } from "../store/load.ts";
import type { GraphStore } from "../store/graph-store.ts";

// ── The stored definition ───────────────────────────────────────────────────

/**
 * One declared graph as the store holds it, decoded.
 *
 * This is the neutral model's definition view: the validated v3 declaration, the
 * digest that addresses it, and the compiled plan with the binding that
 * corroborates it. `graphId` is the declaration's own name (the v3 grammar
 * carries no separate identifier).
 */
export interface StoredDeclaredGraph {
  readonly graphId: string;
  /** The validated declaration, re-parsed from its stored JSON text. */
  readonly declaration: GraphDeclarationV3;
  /** Content digest of the declaration — the adoption key. */
  readonly declarationDigest: string;
  /** The immutable compiled plan. */
  readonly plan: CompiledPlan;
  /** The plan's durable record (the plan plus its node→contract index). */
  readonly record: PersistedCompiledPlan;
  /** The plan projection the run path pins (`planRevision` + contract indexes). */
  readonly binding: PlanBinding;
  /** Epoch milliseconds the definition row was recorded at. */
  readonly recordedAt: number;
}

/** One structured reason a stored definition could not be read. */
export interface StoredDefinitionIssue {
  readonly code:
    | "malformed-definition"
    | "unaddressable-declaration"
    | "declaration-changed"
    | "unrunnable-plan";
  readonly path: string;
  readonly message: string;
}

/** What decoding one stored definition produced. */
export type StoredDefinitionReading =
  | { readonly kind: "ok"; readonly declared: StoredDeclaredGraph }
  | { readonly kind: "refused"; readonly issues: readonly StoredDefinitionIssue[] };

/** One refusal, as a value (never a throw). */
function refuse(
  code: StoredDefinitionIssue["code"],
  path: string,
  message: string,
): StoredDefinitionReading {
  return { kind: "refused", issues: Object.freeze([{ code, path, message }]) };
}

/** Whether a value is a JSON object container (non-null, non-array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The node ids the plan's own body declares, read defensively.
 *
 * The plan is the TOPOLOGY AUTHORITY of a declared graph — there is no second
 * node list to cross-check it against any more — so the set the contract gate
 * resolves against is the plan's own. This is not circular: the verification
 * that consumes it recomputes the body digest, so a node cannot be added,
 * removed or rebound without the revision ceasing to name the body.
 */
function planNodeIds(plan: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!isRecord(plan) || !Array.isArray(plan.nodes)) return ids;
  for (const node of plan.nodes) {
    if (isRecord(node) && typeof node.id === "string" && node.id.length > 0) {
      ids.add(node.id);
    }
  }
  return ids;
}

/**
 * Decode one `graph_definitions` row into the neutral definition, or refuse.
 *
 * PURE and TOTAL: the row is JSON text the store already parsed, so every check
 * below is a value check and every failure is a structured refusal. The gates,
 * in order:
 *
 * 1. the row's own identity — a non-empty `graphId`, `declarationDigest` and
 *    `planRevision`, and a declaration whose `name` IS the graph id (the v3
 *    grammar carries no separate identifier, so a disagreement means the row was
 *    written by something that does not implement this grammar);
 * 2. the DECLARATION — re-parsed through the strict v3 front end, so an unknown
 *    key, a wrong type or a bad limit is refused by name. A stored declaration
 *    this build cannot re-read is not a definition it may run;
 * 3. CONTENT ADDRESSING — the recomputed `contractDigest` of the declaration
 *    must equal the stored `declarationDigest`. That digest is the adoption
 *    key (`graph_declare` preserves an unchanged declaration and refuses a
 *    changed one), so an unverifiable digest would make the rule unenforceable;
 * 4. the PLAN — `verifyPersistedPlan` runs the SAME gate the retired
 *    container's loader applied: the plan's executability marker (a DRAFT is
 *    refused by name), every topology rule, the contract content/identity
 *    indexes, the node→contract index as the projection of the nodes, the
 *    binding, and the agreement between the two records.
 *
 * Only after all four does the row become a {@link StoredDeclaredGraph}. The
 * single assertion at the end is the decode proper: the gate above proved the
 * value against the plan's own rules (including its content address), which is
 * the same guarantee `deserializeEngineState` gave the container.
 */
export function decodeStoredDefinition(
  row: GraphDefinitionRecord,
): StoredDefinitionReading {
  if (row.graphId.length === 0) {
    return refuse(
      "malformed-definition",
      "$.graph_id",
      "stored graph definition carries an empty graph id",
    );
  }
  if (row.declarationDigest.length === 0) {
    return refuse(
      "malformed-definition",
      "$.declaration_digest",
      `stored definition of graph ${JSON.stringify(row.graphId)} carries an empty declaration digest`,
    );
  }
  if (row.planRevision.length === 0) {
    return refuse(
      "malformed-definition",
      "$.plan_revision",
      `stored definition of graph ${JSON.stringify(row.graphId)} carries an empty plan revision`,
    );
  }

  const parsed = parseGraphDeclarationV3(row.declaration);
  if (!parsed.ok) {
    return refuse(
      "malformed-definition",
      "$.declaration",
      `stored declaration of graph ${JSON.stringify(row.graphId)} is not a strict v3 declaration: ` +
        parsed.errors
          .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
          .join("; "),
    );
  }
  const declaration = parsed.declaration;
  if (declaration.name !== row.graphId) {
    return refuse(
      "malformed-definition",
      "$.declaration.name",
      `stored definition is keyed by graph ${JSON.stringify(row.graphId)} but its declaration names ` +
        `${JSON.stringify(declaration.name)} — the v3 grammar carries no separate graph identifier`,
    );
  }

  let digest: string;
  try {
    digest = contractDigest(declaration);
  } catch (error) {
    return refuse(
      "unaddressable-declaration",
      "$.declaration_digest",
      `stored declaration of graph ${JSON.stringify(row.graphId)} cannot be content-addressed: ${errorText(error)}`,
    );
  }
  if (digest !== row.declarationDigest) {
    return refuse(
      "declaration-changed",
      "$.declaration_digest",
      `stored definition of graph ${JSON.stringify(row.graphId)} claims declaration digest ` +
        `${JSON.stringify(row.declarationDigest)}, but its declaration hashes to ${JSON.stringify(digest)} — ` +
        "the stored content is not the content the row is keyed by",
    );
  }

  const plan = row.plan;
  const nodeIds = planNodeIds(plan);
  const verdict = verifyPersistedPlan(plan, plan, row.graphId, nodeIds);
  if (verdict.kind !== "verified") {
    return refuse(
      "unrunnable-plan",
      "$.plan",
      `stored plan of graph ${JSON.stringify(row.graphId)} is not a runnable compiled plan: ` +
        (verdict.kind === "absent"
          ? "the row carries no plan at all"
          : verdict.reason),
    );
  }

  const record = plan as PersistedCompiledPlan;
  const binding: PlanBinding = {
    planRevision: record.planRevision,
    contractSnapshots: record.contractSnapshots,
    contractIdentities: record.contractIdentities,
    nodeBindings: record.nodeBindings,
  };
  if (binding.planRevision !== row.planRevision) {
    return refuse(
      "declaration-changed",
      "$.plan_revision",
      `stored definition of graph ${JSON.stringify(row.graphId)} is keyed by plan revision ` +
        `${JSON.stringify(row.planRevision)}, but its plan is ${JSON.stringify(binding.planRevision)}`,
    );
  }

  return {
    kind: "ok",
    declared: Object.freeze({
      graphId: row.graphId,
      declaration,
      declarationDigest: row.declarationDigest,
      plan: record,
      record,
      binding,
      recordedAt: row.recordedAt,
    }),
  };
}

// ── The TEMPORARY query-boundary mapping (P5 deletes this) ──────────────────

/** The engine node status one outcome node status projects to. */
const PROJECTED_NODE_STATUS: Readonly<Record<OutcomeNodeStatus, NodeStatus>> =
  Object.freeze({
    pending: NodeStatus.Pending,
    dispatched: NodeStatus.Running,
    settled: NodeStatus.Completed,
  });

/**
 * The engine phase one outcome phase projects to.
 *
 * `stopped` maps to `complete` because `EnginePhase` has no separate terminal
 * member and a stopped run takes no further step; the stop's own reason lives in
 * the run state and is reported by `graph_audit`, never rewritten here.
 */
const PROJECTED_PHASE: Readonly<Record<OutcomeGraphPhase, EnginePhase>> =
  Object.freeze({
    ready: EnginePhase.Idle,
    executing: EnginePhase.Executing,
    complete: EnginePhase.Complete,
    stopped: EnginePhase.Complete,
  });

/**
 * Build the `EngineState` container one stored definition declares, with every
 * node it declares in the `pending` position.
 *
 * The carrier declaration is EMPTY on purpose — no v2 declaration is fabricated
 * for a v3 graph. The per-node declared fields come from the plan, which is the
 * graph's topology authority.
 */
function declaredBaseState(declared: StoredDeclaredGraph): EngineState {
  const carrier: GraphDeclaration = {
    version: 2,
    name: declared.graphId,
    nodes: [],
    edges: [],
  };
  const state = createEngineState(carrier, declared.graphId);
  for (const node of declared.plan.nodes) {
    registerNode(state, {
      id: node.id,
      agent: node.agent,
      prompt: node.prompt,
      ...(node.join === undefined ? {} : { join: node.join }),
      ...(node.budget === undefined ? {} : { budget: node.budget }),
    });
  }
  state.executionProtocolVersion = OUTCOME_PROTOCOL;
  state.compiledPlan = declared.record;
  state.planBinding = declared.binding;
  state.startedAt = declared.recordedAt;
  state.updatedAt = declared.recordedAt;
  return state;
}

/**
 * TEMPORARY — P5 OWNS THE DELETION OF THIS FUNCTION AND ITS CALLERS.
 *
 * Project one run-state body onto the container its stored definition declares.
 *
 * PURE and TOTAL: every node the definition declares keeps its identity, agent,
 * prompt, join and budget, and only its lifecycle position is replaced by what
 * the run recorded. A node the run does not mention is carried through
 * untouched, and an attempt id is NEVER written into the container's
 * dispatch-task slot — the two are different identities and conflating them
 * would be a fabrication. A graph with no run-state row yet (declared, never
 * started) projects as `idle` with every node `pending`, which is a fact about
 * the run rather than a fabricated one.
 *
 * WHY IT IS PURE, AND WHAT THAT BUYS. It reads two in-memory values and returns
 * a third: no file handle, no store, no clock — `updatedAt` is the run-state
 * row's own recorded time, or the definition's when there is no row — and no
 * write of any kind. Nothing durable is created, so a projection can never become a
 * second authority, and losing it costs an operator nothing the store does not
 * still hold. Its callers are the read-only query paths only
 * (`tools/persisted-state.ts` via {@link listStoredEngineStates} and
 * `tools/graph-tools.ts` via the declared-graph session view); recovery and the
 * run path read {@link StoredDeclaredGraph.plan} directly and never this.
 */
export function declaredEngineStateOf(
  declared: StoredDeclaredGraph,
  runState: OutcomeGraphState | undefined,
  updatedAt: number,
): EngineState {
  const base = declaredBaseState(declared);
  if (runState === undefined) return base;

  const recorded = new Map(runState.nodes.map((node) => [node.nodeId, node]));
  const nodes = new Map<string, NodeRuntimeState>();
  for (const [id, node] of base.nodes) {
    const live = recorded.get(id);
    if (live === undefined) {
      nodes.set(id, node);
      continue;
    }
    const status = PROJECTED_NODE_STATUS[live.status];
    if (status === node.status) {
      nodes.set(id, node);
      continue;
    }
    nodes.set(id, {
      ...node,
      status,
      ...(status === NodeStatus.Completed &&
      live.settledAt !== undefined &&
      node.completedAt === undefined
        ? { completedAt: live.settledAt }
        : {}),
    });
  }

  const loopGroups = new Map<string, LoopGroupRuntimeState>();
  for (const [id, group] of base.loopGroups) {
    const traversals = runState.loopTraversals[id];
    loopGroups.set(
      id,
      traversals === undefined || traversals === group.traversalCount
        ? group
        : { ...group, traversalCount: traversals },
    );
  }

  return {
    ...base,
    phase: PROJECTED_PHASE[runState.phase],
    nodes,
    loopGroups,
    updatedAt,
    isDirty: false,
    isNonCriticalDirty: false,
  };
}

// ── Reading the store ───────────────────────────────────────────────────────

/**
 * What reading one graph's stored definition produced.
 *
 * `absent` is the ONLY branch a caller may start a graph from; every other one
 * is a refusal that names what the store actually holds — including the
 * `unsupported` / `corrupt` verdicts of the store itself, which is where a
 * retired per-graph container or a damaged authoritative file surfaces
 * (plan §P1.6: an existing record is never `absent`).
 */
export type DeclaredGraphStoreReading =
  | { readonly kind: "ok"; readonly declared: StoredDeclaredGraph }
  | { readonly kind: "absent" }
  | { readonly kind: "blocked"; readonly verdict: GraphStoreLoadResult }
  | { readonly kind: "refused"; readonly issues: readonly StoredDefinitionIssue[] };

/** Open the workspace store read-only and read one graph's definition. */
export function readStoredDefinition(
  storeDirectory: string,
  graphId: string,
): DeclaredGraphStoreReading {
  const loaded = loadGraphStoreSync(storeDirectory);
  if (loaded.kind !== "valid") return { kind: "blocked", verdict: loaded };
  const store: GraphStore = loaded.value;
  try {
    const row = store.readDefinition(graphId);
    if (row === undefined) return { kind: "absent" };
    const decoded = decodeStoredDefinition(row);
    return decoded.kind === "ok"
      ? { kind: "ok", declared: decoded.declared }
      : { kind: "refused", issues: decoded.issues };
  } finally {
    store.close();
  }
}

/** One stored graph's engine-state view, plus why a graph could not be read. */
export interface StoredEngineStateListing {
  /** The store verdict — `absent` for a workspace that never declared a graph. */
  readonly verdict: GraphStoreLoadResult;
  /** The decoded definitions, each projected to the query-boundary shape. */
  readonly states: readonly EngineState[];
  /** Graph ids whose definition the store holds but this build cannot read. */
  readonly skipped: readonly string[];
}

/**
 * List every declared graph the store holds, projected to the query-boundary
 * shape, most recently updated first.
 *
 * READ-ONLY and TOTAL: a missing store is an empty list, a store this build may
 * not read is reported by its verdict (never as "no graphs"), and a definition
 * that fails a gate is named in `skipped` instead of being approximated. The
 * projection it applies is the TEMPORARY one above.
 */
export function listStoredEngineStates(
  storeDirectory: string,
): StoredEngineStateListing {
  const loaded = loadGraphStoreSync(storeDirectory);
  if (loaded.kind !== "valid") {
    return { verdict: loaded, states: Object.freeze([]), skipped: Object.freeze([]) };
  }
  const store: GraphStore = loaded.value;
  const states: EngineState[] = [];
  const skipped: string[] = [];
  try {
    for (const graphId of store.definitionGraphIds()) {
      const row = store.readDefinition(graphId);
      if (row === undefined) {
        skipped.push(graphId);
        continue;
      }
      const decoded = decodeStoredDefinition(row);
      if (decoded.kind !== "ok") {
        skipped.push(graphId);
        continue;
      }
      const run = readStoredRunState(store, decoded.declared, graphId, skipped);
      states.push(
        declaredEngineStateOf(
          decoded.declared,
          run.state,
          run.updatedAt ?? decoded.declared.recordedAt,
        ),
      );
    }
  } finally {
    store.close();
  }
  states.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    verdict: loaded,
    states: Object.freeze(states),
    skipped: Object.freeze(skipped.slice().sort()),
  };
}

/**
 * The run-state body of one stored graph, decoded against its own plan.
 *
 * A row this build cannot decode is a SKIP, not a fabricated `idle` graph: the
 * definition is real and the run state is not, so the caller must be told the
 * graph could not be read rather than shown a pending one.
 */
function readStoredRunState(
  store: GraphStore,
  declared: StoredDeclaredGraph,
  graphId: string,
  skipped: string[],
): { readonly state: OutcomeGraphState | undefined; readonly updatedAt?: number } {
  let row: GraphStateRecord | undefined;
  try {
    row = store.readGraphState(graphId);
  } catch {
    skipped.push(graphId);
    return { state: undefined };
  }
  if (row === undefined) return { state: undefined };
  try {
    return { state: readOutcomeGraphState(row, declared.plan), updatedAt: row.updatedAt };
  } catch {
    skipped.push(graphId);
    return { state: undefined };
  }
}

/**
 * The run-state body one stored graph recorded, or a structured outcome.
 *
 * The host's first-execution path needs the PLAN, not the body, so it uses
 * {@link readStoredDefinition}; this exists for a caller that already holds the
 * decoded definition and wants the recorded position (the audit classifies
 * through it).
 */
export type StoredRunStateReading =
  | { readonly kind: "recorded"; readonly state: OutcomeGraphState; readonly updatedAt: number }
  | { readonly kind: "unstarted" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** Read and decode one graph's stored run-state body against its plan. */
export function readStoredRunStateOf(
  store: GraphStore,
  declared: StoredDeclaredGraph,
): StoredRunStateReading {
  let row: GraphStateRecord | undefined;
  try {
    row = store.readGraphState(declared.graphId);
  } catch (error) {
    return { kind: "unreadable", reason: errorText(error) };
  }
  if (row === undefined) return { kind: "unstarted" };
  try {
    return {
      kind: "recorded",
      state: readOutcomeGraphState(row, declared.plan),
      updatedAt: row.updatedAt,
    };
  } catch (error) {
    return { kind: "unreadable", reason: errorText(error) };
  }
}

// ── Naming a verdict ────────────────────────────────────────────────────────

/**
 * One sentence naming a store verdict, for a refusal that must not guess.
 *
 * ONE owner: the declaration path, the submission ingress, the host and the
 * scanner all report the same store state with the same words, so a refusal an
 * operator reads from `graph_declare` and one from `graph_audit` cannot drift.
 */
export function describeStoreVerdict(verdict: GraphStoreLoadResult): string {
  switch (verdict.kind) {
    case "absent":
      return "no store exists";
    case "valid":
      return "the store is readable";
    case "unsupported":
      return `unsupported ${verdict.dimension}: ${verdict.detail}`;
    case "corrupt":
      return `corrupt ${verdict.dimension}: ${verdict.reason}`;
    case "migration-required":
      return `migration-required ${verdict.dimension} from ${String(verdict.from)} to ${String(verdict.to)}`;
  }
}

/** One sentence naming why a stored definition could not be read. */
export function describeStoredReading(
  reading: Exclude<DeclaredGraphStoreReading, { kind: "ok" }>,
): string {
  switch (reading.kind) {
    case "absent":
      return "the store holds no definition for it";
    case "blocked":
      return describeStoreVerdict(reading.verdict);
    case "refused":
      return reading.issues
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join("; ");
  }
}

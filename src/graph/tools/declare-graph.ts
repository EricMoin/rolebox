/**
 * Graph Execution Engine v2 — `graph_declare` (C1 outcome-authoring ingress)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The FIRST PRODUCER of a compiled plan: a full v3 declaration in, a parsed +
 * compiled + persisted plan identity out
 * (docs/graph-outcome-protocol.md § "Implementation order and release gates",
 * step 3's first requirement).
 *
 * What it does, in order:
 * 1. PARSE the authored value through the strict v3 front-end
 *    (`compiler/parse-declaration-v3.ts`) — unknown keys, wrong types and bad
 *    limits are structured refusals, never a throw;
 * 2. COMPILE it (`compileGraph`) with the caller's capability options;
 * 3. REFUSE A DRAFT. A compilation with unresolved acceptance capabilities is
 *    structurally complete but NON-EXECUTABLE, and persisting it as if it were
 *    executable would run gates that were never checked (B9). The refusal names
 *    every unresolved entry;
 * 4. BIND the plan: the durable record (`PersistedCompiledPlan`), the plan
 *    BINDING (the plan's own revision plus the contract content/identity/
 *    node-binding projection) and the EXECUTION-PROTOCOL identity
 *    (`executionProtocolVersion = OUTCOME_PROTOCOL`) are written onto the
 *    graph's engine state, and the state is persisted through the existing
 *    store (`EnginePersistence`, the same version-2 layout and the same loader
 *    gates).
 *
 * THE BOUNDARY, STATED PLAINLY (C3b): the outcome protocol now HAS a registered
 * handler, and a declared graph runs through the outcome run path
 * (`src/graph/outcome/runtime.ts`) — entry nodes dispatched from THIS plan,
 * submissions accepted through the graph-scoped ingress, and the graph state
 * committed with the acceptance. The plan is persisted so that run path (and the
 * deferred restart-recovery slice) consumes THIS record. Every LEGACY entry
 * point still refuses the graph with {@link OutcomeProtocolUnavailableError}
 * instead of falling back to the legacy signal protocol, and restart recovery
 * for the outcome protocol is deferred. Nothing HERE dispatches, reduces or
 * accepts anything: this module only authors, compiles and persists.
 *
 * The state's `graphDeclaration` is a deliberately EMPTY legacy carrier: the
 * v3 declaration is not a v2 declaration, so none is fabricated. The compiled
 * plan is the graph's topology authority, and the state carries one pending
 * runtime node per compiled node so the persisted plan's node bindings verify
 * against the state that holds them (the B7 load gate requires every topology
 * node id to be a node the state declares).
 */

import { readFileSync } from "node:fs";
import { errorText } from "../../utils/error-text.ts";
import type { GraphDeclaration } from "../../types.graph-v2.ts";
import type { EngineState, PlanBinding } from "../../types.engine-v2.ts";
import { contractDigest } from "../contracts/contract-definition.ts";
import type { ContractRegistry } from "../contracts/resolve.ts";
import {
  compileGraph,
  type CompileIssue,
  type SupportedValidatorV3,
} from "../compiler/compile.ts";
import {
  parseGraphDeclarationV3,
  type DeclarationV3Issue,
} from "../compiler/parse-declaration-v3.ts";
import type { GraphDeclarationV3 } from "../compiler/declaration-v3.ts";
import {
  createPersistedCompiledPlan,
  type CompiledPlan,
  type CompiledUnresolvedRequirement,
  type PersistedCompiledPlan,
} from "../compiler/plan.ts";
import {
  LEGACY_SIGNAL_PROTOCOL,
  OUTCOME_PROTOCOL,
} from "../protocol/execution-protocol.ts";
import {
  EnginePersistence,
  engineStatePath,
} from "../engine/engine-persistence.ts";
import { createEngineState, registerNode } from "../engine/engine-state.ts";

// ── Args and result ─────────────────────────────────────────────────────────

/** Arguments accepted by `graph_declare` (the toolset method). */
export interface GraphDeclareArgs {
  /**
   * The v3 declaration, as JSON text or as an already-parsed JSON value.
   * Unknown keys, wrong types and malformed limits are refused with structured
   * codes — this ingress never guesses at a field the grammar does not declare.
   */
  declaration: unknown;
  /**
   * Optional graph id. The v3 grammar carries no separate identifier, so the
   * declaration's `name` IS the graph id; when supplied, this must equal it
   * (a mismatch is refused rather than silently choosing one).
   */
  graph_id?: string;
  /**
   * The validator capabilities this caller declares installed. An acceptance
   * requirement resolves only against these at an EXACT version; omitting the
   * list leaves every requirement unresolved, which compiles to a DRAFT and is
   * refused here.
   */
  supported_validators?: SupportedValidatorV3[];
}

/** What a successful `graph_declare` reports. */
export interface GraphDeclareResult {
  /** The graph id the plan is bound to (the declaration's own name). */
  graph_id: string;
  /** The compiled plan's content-addressed revision. */
  plan_revision: string;
  /** The resolved executability — a draft is refused, so this is executable. */
  executability: "executable";
  /** The authoring grammar the plan was compiled from — always 3. */
  declaration_version: 3;
  /** The execution protocol the graph is pinned to (`OUTCOME_PROTOCOL`). */
  execution_protocol: number;
  /** Compiled topology counts, for the caller's own reporting. */
  nodes: number;
  edges: number;
  loop_groups: number;
  terminal_outcomes: number;
  contract_bindings: number;
  /** Whether the engine state reached the on-disk store. */
  persisted: boolean;
  /**
   * Whether an IDENTICAL declaration re-declared over an existing declared
   * graph: the stored plan and its persisted state were preserved, not rebuilt
   * (the B8 "unchanged declaration preserves it" rule).
   */
  preserved: boolean;
  /**
   * Whether a run path exists for this graph. True since C3b: the outcome
   * protocol has a registered handler and the graph runs through the
   * graph-scoped outcome submission ingress — NOT through the legacy signal
   * entry points, which still refuse it.
   */
  runnable: boolean;
  /**
   * How the graph runs, verbatim. Names the outcome run path and the boundary
   * the legacy entry points keep: a caller must never interpret this graph with
   * severity-ranked signals.
   */
  run_path: string;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/** Why `graph_declare` refused. Stable identifiers; wording is not API. */
export type DeclareRefusalReason =
  /** The authored value is not a strict v3 declaration. */
  | "invalid-declaration"
  /** The declaration compiled, but only as a non-executable DRAFT. */
  | "draft-plan"
  /** `graph_id` was supplied and disagrees with the declaration's `name`. */
  | "graph-id-mismatch"
  /** The declaration cannot be content-addressed (digest size/depth bound). */
  | "unaddressable-declaration"
  /** The graph id already names a declared graph with DIFFERENT content. */
  | "declaration-changed"
  /** The graph id already names a legacy (v2) graph. */
  | "legacy-graph-conflict"
  /**
   * A state file already exists for the graph id but cannot be read as this
   * build's own declared-graph record — overwriting it could destroy a plan
   * this process cannot see.
   */
  | "persisted-state-unreadable";

/** One structured diagnostic carried by a refusal. */
export interface DeclareDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/**
 * A `graph_declare` refusal, as a typed error.
 *
 * It carries the STRUCTURED diagnostics (the front-end's issue codes, or the
 * compiler's compile codes) and, for a draft, the unresolved acceptance
 * entries, so a caller can branch on them instead of parsing the message. The
 * message is rendered from the same data for a human.
 */
export class GraphDeclareRefusedError extends Error {
  readonly reason: DeclareRefusalReason;
  readonly diagnostics: readonly DeclareDiagnostic[];
  readonly unresolved: readonly CompiledUnresolvedRequirement[];

  constructor(
    reason: DeclareRefusalReason,
    message: string,
    diagnostics: readonly DeclareDiagnostic[] = [],
    unresolved: readonly CompiledUnresolvedRequirement[] = [],
  ) {
    super(message);
    this.name = "GraphDeclareRefusedError";
    this.reason = reason;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.unresolved = Object.freeze([...unresolved]);
  }
}

/**
 * Why the outcome protocol is unavailable to a LEGACY entry point.
 *
 * Phrased here, once, so `graph_declare`'s result and the legacy refusal cannot
 * drift apart. Since C3b the graph IS runnable — through the outcome run path —
 * so this text states the two halves a caller must not confuse: the outcome
 * path exists, and the legacy signal path stays unreachable for this graph.
 */
export function outcomeProtocolUnavailableReason(
  graphId: string,
  planRevision: string,
): string {
  return (
    `graph "${graphId}" is declared under the outcome protocol ` +
    `(executionProtocolVersion ${OUTCOME_PROTOCOL}): it runs through the OUTCOME run ` +
    `path, whose ONLY completion source is the graph-scoped outcome submission that ` +
    `commits its state with the acceptance. This LEGACY entry point (run, dry-run, ` +
    `construction, cancel, approve or targeted status) cannot run it: the legacy signal ` +
    `protocol would interpret completions from severity-ranked signals, which is exactly ` +
    `what the outcome protocol forbids. Nothing was dispatched. The compiled plan ` +
    `(revision ${planRevision}) and its binding are the graph's topology authority, and ` +
    `this graph must never fall back to the legacy signal protocol.`
  );
}

/**
 * Refusal raised when a LEGACY operation (run / construct / cancel / status)
 * targets a graph DECLARED under the outcome protocol.
 *
 * It names the outcome run path that does own the graph and the persisted plan
 * revision, and it is thrown BEFORE any node is touched, so a declared graph can
 * never be dispatched under legacy rules. The name says what the caller tried to
 * use: the outcome protocol is unavailable to THIS entry point.
 */
export class OutcomeProtocolUnavailableError extends Error {
  readonly graphId: string;
  readonly planRevision: string;

  constructor(graphId: string, planRevision: string) {
    super(outcomeProtocolUnavailableReason(graphId, planRevision));
    this.name = "OutcomeProtocolUnavailableError";
    this.graphId = graphId;
    this.planRevision = planRevision;
  }
}

/** Refuse a declaration the strict front-end rejected. */
function refuseInvalidDeclaration(
  issues: readonly DeclarationV3Issue[],
): GraphDeclareRefusedError {
  const diagnostics = issues.map((entry) => ({
    code: entry.code,
    message: entry.message,
    path: entry.path,
  }));
  return new GraphDeclareRefusedError(
    "invalid-declaration",
    "graph_declare refused: the authored value is not a strict v3 declaration:\n" +
      renderDiagnostics(diagnostics),
    diagnostics,
  );
}

/** Refuse a declaration the compiler rejected. */
function refuseCompileErrors(
  errors: readonly CompileIssue[],
): GraphDeclareRefusedError {
  const diagnostics = errors.map((entry) => ({
    code: entry.code,
    message: entry.message,
    path: entry.path,
  }));
  return new GraphDeclareRefusedError(
    "invalid-declaration",
    "graph_declare refused: the v3 declaration does not compile:\n" +
      renderDiagnostics(diagnostics),
    diagnostics,
  );
}

/** Refuse a DRAFT: name every unresolved acceptance entry, then the next step. */
function refuseDraftPlan(
  graphId: string,
  unresolved: readonly CompiledUnresolvedRequirement[],
): GraphDeclareRefusedError {
  const lines = unresolved.map((entry) => {
    const version = entry.version === undefined ? "any version" : `version ${entry.version}`;
    return (
      `  - nodes.${entry.nodeId}: outcome "${entry.outcomeId}" requires validator ` +
      `"${entry.validator}" (${version}), which no declared capability resolves to an exact installed version`
    );
  });
  return new GraphDeclareRefusedError(
    "draft-plan",
    `graph_declare refused: "${graphId}" compiled to a NON-EXECUTABLE DRAFT — ` +
      `${unresolved.length} acceptance requirement(s) could not be resolved, so no plan was persisted:` +
      `\n${lines.join("\n")}\n` +
      "Supply supported_validators covering each requirement at its exact version " +
      "(or remove the requirement) and declare again. A draft is never persisted as executable.",
    [],
    unresolved,
  );
}

/** Render structured diagnostics as indented lines. */
function renderDiagnostics(diagnostics: readonly DeclareDiagnostic[]): string {
  return diagnostics
    .map((entry) => `  - [${entry.code}] ${entry.path}: ${entry.message}`)
    .join("\n");
}

// ── Building the declared graph ─────────────────────────────────────────────

/** Inputs to {@link buildDeclaredOutcomeGraph}. */
export interface BuildDeclaredOutcomeGraphInput {
  /** The authored v3 declaration (JSON text or a parsed value). */
  readonly declaration: unknown;
  /** Optional graph id; must equal the declaration's `name` when supplied. */
  readonly graphId?: string;
  /** The installed validator capabilities to resolve acceptance against. */
  readonly supportedValidators?: readonly SupportedValidatorV3[];
  /** The installed contract capability to resolve node `contractRef`s against. */
  readonly contracts?: ContractRegistry;
}

/**
 * The declared, compiled and state-bound graph — everything except the write to
 * disk, which {@link persistDeclaredGraph} owns so a caller can decide whether
 * the graph is worth persisting first.
 */
export interface DeclaredOutcomeGraph {
  readonly graphId: string;
  /** The validated declaration; its canonical digest is the adoption key. */
  readonly declaration: GraphDeclarationV3;
  /** `contractDigest` of the validated declaration (the B8 comparison key). */
  readonly declarationDigest: string;
  /** The immutable, content-addressed compiled plan. */
  readonly plan: CompiledPlan;
  /** The plan as the durable record `EngineState.compiledPlan` carries. */
  readonly record: PersistedCompiledPlan;
  /** The plan binding `EngineState.planBinding` carries (a plan projection). */
  readonly binding: PlanBinding;
  /** The engine state carrying protocol + plan + binding for this graph. */
  readonly state: EngineState;
}

/**
 * Parse, compile and bind a v3 declaration to an engine state.
 *
 * PURE except for reading the caller's inputs: no file is written here.
 * Refusals are {@link GraphDeclareRefusedError}s carrying structured
 * diagnostics — never a raw throw from the parser, the compiler or the digest.
 */
export function buildDeclaredOutcomeGraph(
  input: BuildDeclaredOutcomeGraphInput,
): DeclaredOutcomeGraph {
  const parsed = parseGraphDeclarationV3(input.declaration);
  if (!parsed.ok) throw refuseInvalidDeclaration(parsed.errors);
  const declaration = parsed.declaration;

  if (input.graphId !== undefined && input.graphId !== declaration.name) {
    throw new GraphDeclareRefusedError(
      "graph-id-mismatch",
      `graph_declare refused: graph_id "${input.graphId}" does not equal the declaration's ` +
        `name "${declaration.name}" — the v3 grammar carries no separate graph identifier, ` +
        "so the name IS the graph id.",
    );
  }

  const compiled = compileGraph(declaration, {
    ...(input.contracts === undefined ? {} : { contracts: input.contracts }),
    ...(input.supportedValidators === undefined
      ? {}
      : { supportedValidators: input.supportedValidators }),
  });
  if (!compiled.ok) throw refuseCompileErrors(compiled.errors);
  if (compiled.kind === "draft") {
    throw refuseDraftPlan(declaration.name, compiled.unresolved);
  }

  const plan = compiled.plan;
  const record = createPersistedCompiledPlan(plan);
  const binding: PlanBinding = {
    planRevision: plan.planRevision,
    contractSnapshots: plan.contractSnapshots,
    contractIdentities: plan.contractIdentities,
    nodeBindings: record.nodeBindings,
  };

  let declarationDigest: string;
  try {
    declarationDigest = contractDigest(declaration);
  } catch (error) {
    throw new GraphDeclareRefusedError(
      "unaddressable-declaration",
      `graph_declare refused: the declaration cannot be content-addressed, so an ` +
        `unchanged re-declaration could not be told from a changed one: ${errorText(error)}`,
    );
  }

  return Object.freeze({
    graphId: declaration.name,
    declaration,
    declarationDigest,
    plan,
    record,
    binding,
    state: buildDeclaredEngineState(plan, record, binding),
  });
}

/**
 * Build the engine state a declared graph is bound to.
 *
 * The legacy carrier declaration is EMPTY on purpose — no v2 declaration is
 * fabricated for a v3 graph. The state registers one pending runtime node per
 * compiled node (so the persisted plan's topology verifies against the state
 * holding it) and then pins the three identities: the execution protocol, the
 * compiled-plan record and the plan binding.
 */
function buildDeclaredEngineState(
  plan: CompiledPlan,
  record: PersistedCompiledPlan,
  binding: PlanBinding,
): EngineState {
  const carrier: GraphDeclaration = {
    version: 2,
    name: plan.graphId,
    nodes: [],
    edges: [],
  };
  const state = createEngineState(carrier, plan.graphId);
  for (const node of plan.nodes) {
    registerNode(state, {
      id: node.id,
      agent: node.agent,
      prompt: node.prompt,
      ...(node.join === undefined ? {} : { join: node.join }),
      ...(node.budget === undefined ? {} : { budget: node.budget }),
    });
  }
  state.executionProtocolVersion = OUTCOME_PROTOCOL;
  state.compiledPlan = record;
  state.planBinding = binding;
  state.updatedAt = Date.now();
  return state;
}


// ── The persisted record a re-declaration must not overwrite ────────────────

/** What an existing on-disk record says about a graph id. */
export type ExistingDeclaredGraph =
  /** No state file exists for the id: this is a first declaration. */
  | { readonly kind: "absent" }
  /** A declared graph, with the plan revision its file carries. */
  | { readonly kind: "declared"; readonly planRevision: string }
  /** A LEGACY (protocol 1 / pre-protocol) record owns the id. */
  | { readonly kind: "legacy" }
  /** A file exists but is not a readable record — never overwrite it blindly. */
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Read the existing persisted record for a graph id WITHOUT going through the
 * loader's protocol gate.
 *
 * The shipped loader refuses a protocol-2 state as `unsupported(execution)` by
 * design, so it cannot answer "the plan already on disk is revision R". This
 * function reads exactly that identity, and NOTHING else: it neither hydrates a
 * state nor verifies the plan (the loader owns that), so it must not be used as
 * a load path.
 *
 * TOTAL: every failure is a verdict. An unreadable, malformed or foreign file
 * is `unreadable` — a caller must refuse rather than overwrite a record it
 * could not understand.
 */
export function readExistingDeclaredGraph(
  stateDir: string | undefined,
  graphId: string,
): ExistingDeclaredGraph {
  if (stateDir === undefined) return { kind: "absent" };
  const path = engineStatePath(stateDir, graphId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return { kind: "absent" };
    return {
      kind: "unreadable",
      reason: `the existing state file at ${path} could not be read: ${errorText(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `the existing state file at ${path} is not valid JSON: ${errorText(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      kind: "unreadable",
      reason: `the existing state file at ${path} is not a JSON object`,
    };
  }
  if (parsed.graphId !== graphId) {
    return {
      kind: "unreadable",
      reason:
        `the state file at ${path} carries graphId ${describeValue(parsed.graphId)}, not ${JSON.stringify(graphId)}` +
        " — refusing to overwrite a record that belongs to another graph",
    };
  }
  const protocol = parsed.executionProtocolVersion;
  if (protocol === undefined || protocol === LEGACY_SIGNAL_PROTOCOL) {
    // An absent protocol in this layout IS the legacy protocol (the format-2
    // decoder's one legitimate backfill), so the id belongs to a legacy graph.
    return { kind: "legacy" };
  }
  if (protocol !== OUTCOME_PROTOCOL) {
    return {
      kind: "unreadable",
      reason: `the state file at ${path} carries executionProtocolVersion ${describeValue(protocol)}, which is neither the legacy nor the outcome protocol`,
    };
  }
  const plan = parsed.compiledPlan;
  if (!isRecord(plan)) {
    return {
      kind: "unreadable",
      reason: `the state file at ${path} is bound to the outcome protocol but carries no compiled-plan record`,
    };
  }
  const planRevision = plan.planRevision;
  if (typeof planRevision !== "string" || planRevision.length === 0) {
    return {
      kind: "unreadable",
      reason: `the state file at ${path} carries a compiled plan without a plan revision`,
    };
  }
  return { kind: "declared", planRevision };
}

/** Whether a read failure means "the file does not exist". */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Whether a value is a JSON object container (non-null, non-array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Name what was received for a diagnostic, without throwing on the value. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return typeof value;
}

/**
 * Persist a declared graph's engine state through the existing store.
 *
 * Returns `true` only when the state reached disk; `false` when no state
 * directory is configured (the graph is registered in memory only) or the
 * atomic write failed. The write is the SAME version-2 layout every other state
 * uses, so the existing loader gates apply to it unchanged — including the
 * execution-protocol gate, which REFUSES this protocol in this build.
 */
export function persistDeclaredGraph(
  graph: DeclaredOutcomeGraph,
  stateDir: string | undefined,
): boolean {
  if (stateDir === undefined) return false;
  return new EnginePersistence(stateDir).save(graph.state);
}

/** Build the successful tool result for a declared (or preserved) graph. */
export function declaredGraphResult(
  graph: DeclaredOutcomeGraph,
  options: { readonly persisted: boolean; readonly preserved: boolean },
): GraphDeclareResult {
  return {
    graph_id: graph.graphId,
    plan_revision: graph.plan.planRevision,
    executability: "executable",
    declaration_version: 3,
    execution_protocol: OUTCOME_PROTOCOL,
    nodes: graph.plan.nodes.length,
    edges: graph.plan.edges.length,
    loop_groups: graph.plan.loopGroups.length,
    terminal_outcomes: graph.plan.terminalOutcomes.length,
    contract_bindings: Object.keys(graph.record.nodeBindings).length,
    persisted: options.persisted,
    preserved: options.preserved,
    runnable: true,
    run_path: outcomeProtocolUnavailableReason(
      graph.graphId,
      graph.plan.planRevision,
    ),
  };
}

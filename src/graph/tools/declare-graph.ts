import { existsSync, statSync } from "node:fs";

import { errorText } from "../../utils/error-text.ts";
import { logWarn } from "../log-warn.ts";
import type { PlanBinding } from "../compiler/plan.ts";
import { contractDigest } from "../contracts/contract-definition.ts";
import type { ContractRegistry } from "../contracts/resolve.ts";
import {
  compileGraph,
  type CompileIssue,
  type SupportedValidatorV3,
} from "../compiler/compile.ts";
import {
  resolveDeclaredValidatorCapabilities,
  type DeclaredCapabilityIssue,
} from "../compiler/capability-set.ts";
import type {
  AcceptanceCapabilitySet,
  ValidatorRegistry,
} from "../outcome/validators.ts";

import {
  parseGraphDeclarationV3,
  type DeclarationV3Issue,
} from "../compiler/parse-declaration-v3.ts";
import type { GraphDeclarationV3 } from "../compiler/declaration-v3.ts";
import {
  createPersistedCompiledPlan,
  type CompiledPlan,
  type CompiledUnauthorizedCompletion,
  type CompiledUnresolvedRequirement,
  type PersistedCompiledPlan,
} from "../compiler/plan.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
import { engineStatePath } from "../persistence/paths.ts";
import {
  describeStoreVerdict,
  readStoredDefinition,
  type StoredDeclaredGraph,
} from "../persistence/declared-record.ts";
import { GraphStore } from "../store/graph-store.ts";
import { GraphStoreFormatError } from "../store/errors.ts";

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
   * The validator capabilities this caller asserts, as a NARROWING of the
   * host-installed set.
   *
   * This argument does NOT install anything: every entry must be substantiated
   * by a registration the host already installed (the same registry the run
   * path looks implementations up in), at the same exact version — or, when the
   * entry names no version, at the single installed version of that id. An
   * entry the host cannot substantiate refuses the declaration
   * (`validator-capability-not-installed`), and entries only ever narrow the
   * effective set. Omitting the list means EVERY installed capability is in
   * scope, never "no capabilities".
   */
  supported_validators?: SupportedValidatorV3[];
  // NOTE (D6): there is deliberately NO completion-policy argument here. A
  // caller-supplied capability would let the same call that REQUESTS a policy
  // revision also authorize it; the installed completion-policy capability is
  // a host dependency (GraphToolSetDeps), never a tool argument.
}

/** What a successful `graph_declare` reports. */
export interface GraphDeclareResult {
  start?: {
    readonly kind: "saved" | "started" | "resumed" | "refused" | "blocked";
    readonly phase?: string;
    readonly reason?: string;
    readonly dispatched?: readonly { nodeId: string; attemptId: string }[];
    readonly refusals?: readonly import("../outcome/runtime.ts").OutcomeRuntimeRefusal[];
    readonly divergences?: readonly import("../outcome/runtime.ts").OutcomeEffectDivergence[];
  };
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
   * Whether a run path exists for this graph. True: the outcome protocol has a
   * registered handler and the graph runs through the graph-scoped outcome
   * submission ingress.
   */
  runnable: boolean;
  /**
   * How the graph runs, verbatim. Names the outcome run path: a caller must
   * never interpret this graph with severity-ranked signals.
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
  /**
   * A `supported_validators` entry names a capability the host did not
   * install. A caller may narrow the installed set; it can never widen it.
   */
  | "validator-capability-not-installed"
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
  readonly unauthorizedCompletions: readonly CompiledUnauthorizedCompletion[];

  constructor(
    reason: DeclareRefusalReason,
    message: string,
    diagnostics: readonly DeclareDiagnostic[] = [],
    unresolved: readonly CompiledUnresolvedRequirement[] = [],
    unauthorizedCompletions: readonly CompiledUnauthorizedCompletion[] = [],
  ) {
    super(message);
    this.name = "GraphDeclareRefusedError";
    this.reason = reason;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.unresolved = Object.freeze([...unresolved]);
    this.unauthorizedCompletions = Object.freeze([...unauthorizedCompletions]);
  }
}

/**
 * How a declared graph runs, verbatim.
 *
 * Phrased here, once, so `graph_declare`'s result cannot drift from the run
 * path it names: the graph runs through the outcome run path, whose ONLY
 * completion source is the graph-scoped outcome submission that commits its
 * state with the acceptance. Severity-ranked signals never settle one of its
 * nodes.
 */
export function outcomeProtocolUnavailableReason(
  graphId: string,
  planRevision: string,
): string {
  return (
    `graph "${graphId}" is declared under the outcome protocol ` +
    `(executionProtocolVersion ${OUTCOME_PROTOCOL}): it runs through the OUTCOME run ` +
    `path, whose ONLY completion source is the graph-scoped outcome submission that ` +
    `commits its state with the acceptance. The compiled plan (revision ${planRevision}) ` +
    `and its binding are the graph's topology authority.`
  );
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

/**
 * Refuse a DRAFT: name every unresolved ACCEPTANCE entry and every
 * UNAUTHORIZED natural-completion mapping, then the next step for each.
 *
 * The two reason lists are different problems with different owners (a
 * caller-supplied validator capability versus a HOST-installed policy), so the
 * refusal renders them apart and only gives the guidance that applies.
 */
function refuseDraftPlan(
  graphId: string,
  unresolved: readonly CompiledUnresolvedRequirement[],
  unauthorizedCompletions: readonly CompiledUnauthorizedCompletion[],
): GraphDeclareRefusedError {
  const lines = [
    ...unresolved.map((entry) => {
      const version =
        entry.version === undefined ? "any version" : `version ${entry.version}`;
      const head =
        `  - nodes.${entry.nodeId}: outcome "${entry.outcomeId}" requires validator ` +
        `"${entry.validator}" (${version})`;
      // A22: an unresolved entry now has TWO possible owners. `reason` names a
      // missing CONCRETE capability (the outcome's declared schema is not
      // installed, or no trusted policy authorizes this exact mapping), while
      // its absence is the identity-level problem the caller fixes with
      // supported_validators. Rendering them apart keeps the guidance honest.
      return entry.reason === undefined
        ? `${head}, which no declared capability resolves to an exact installed version`
        : `${head}, but ${entry.reason}`;
    }),
    ...unauthorizedCompletions.map((entry) => {
      const requested =
        entry.request === undefined
          ? "the declaration requests no policy revision at all"
          : `the declaration requests policy "${entry.request.id}"@"${entry.request.revision}"`;
      return (
        `  - nodes.${entry.nodeId}: outcome "${entry.outcome}" asks for natural completion, but ` +
        `${requested} and the mapping is not authorized (${entry.code})`
      );
    }),
  ];
  const concrete = unresolved.some((entry) => entry.reason !== undefined);
  const guidance = [
    unresolved.length === 0
      ? undefined
      : concrete
        ? "have the HOST install the schema an outcome's data contract names, or authorize a trusted command for the exact (graph, node, outcome) mapping each command-exit requirement pins — a declaration resolves capabilities, it can never install one"
        : "Supply supported_validators covering each requirement at its exact version (or remove the requirement)",
    unauthorizedCompletions.length === 0
      ? undefined
      : "have the HOST install the exact completion-policy revision each mapping requests (a declaration may REQUEST a policy; it can never authorize one)",
  ].filter((part): part is string => part !== undefined);
  return new GraphDeclareRefusedError(
    "draft-plan",
    `graph_declare refused: "${graphId}" compiled to a NON-EXECUTABLE DRAFT — ` +
    `${unresolved.length} acceptance requirement(s) and ${unauthorizedCompletions.length} natural-completion mapping(s) are unresolved, so no plan was persisted:` +
    `\n${lines.join("\n")}\n` +
    guidance.join(", and ") +
    ". A draft is never persisted as executable.",
    [],
    unresolved,
    unauthorizedCompletions,
  );
}

/**
 * Refuse a `supported_validators` entry the host did not install.
 *
 * The refusal is raised BEFORE compilation, so nothing is compiled against an
 * unsubstantiated capability and nothing is persisted; every offending entry is
 * named with its stable code.
 */
function refuseUnsubstantiatedCapabilities(
  issues: readonly DeclaredCapabilityIssue[],
): GraphDeclareRefusedError {
  const lines = issues.map((entry) => "  - [" + entry.code + "] " + entry.message);
  return new GraphDeclareRefusedError(
    "validator-capability-not-installed",
    "graph_declare refused: supported_validators declares " +
    String(issues.length) +
    " validator capability(ies) this host did not install, so the declaration was not compiled:" +
    "\n" +
    lines.join("\n") +
    "\nThe installed capability set is the HOST's: a caller may narrow it, and can never add to it. " +
    "Remove the entry, or have the host install that exact registration (the same registry the run path resolves acceptance against).",
    issues.map((entry, index) => ({
      code: entry.code,
      message: entry.message,
      path: "supported_validators[" + String(index) + "]",
    })),
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
  /**
   * The HOST-INSTALLED validator capability: the same registry the run path
   * resolves a pinned requirement's implementation in. It is the SOURCE OF
   * TRUTH for what an acceptance requirement may pin, and every entry of
   * {@link supportedValidators} must be substantiated by it.
   *
   * OMITTED, this builder holds no host registry and uses
   * {@link supportedValidators} exactly as handed — the direct-embedding
   * contract for a caller that IS the assembler. The shipped compile entry
   * (`GraphToolSet.graph_declare`) ALWAYS supplies the registry (an empty one
   * when the host installed nothing), so on the product path a model-supplied
   * argument can never substitute for host authorization.
   */
  readonly installedValidators?: ValidatorRegistry;
  /**
   * THE CONCRETE half of the host's acceptance capability (A22): the schemas the
   * schema primitive registered and the exact command mappings a trusted policy
   * authorized. It comes from the SAME assembly that built
   * {@link installedValidators}, so the two cannot disagree about what this host
   * can substantiate.
   *
   * OMITTED, only validator IDENTITIES are resolved — the pre-A22 behaviour,
   * kept for the direct-embedding contract. The shipped compile entry always
   * supplies it, so a declaration whose data contract names an uninstalled
   * schema, or whose command-exit requirement has no authorized mapping, is a
   * non-executable DRAFT and is refused before anything is dispatched.
   */
  readonly installedAcceptanceCapabilities?: AcceptanceCapabilitySet;
  /**
   * The caller's NARROWING assertion over {@link installedValidators}: each
   * entry must be substantiated by an installed registration, and the effective
   * set is the declared subset. Never a way to install a capability.
   */
  readonly supportedValidators?: readonly SupportedValidatorV3[];
  /** The installed contract capability to resolve node `contractRef`s against. */
  readonly contracts?: ContractRegistry;
  /**
   * The HOST-INSTALLED completion-policy capability (D6). Deliberately an INPUT
   * to this builder and NEVER a `graph_declare` argument: a declaration may
   * request a policy revision, but only the host may install one, so the
   * capability can never be supplied by the same call that asks for it.
   */
  readonly completionPolicies?: CompletionPolicyRegistry;
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
  /** The immutable compiled plan saved with the declaration. */
  readonly record: PersistedCompiledPlan;
  /** The plan binding the run path pins (a plan projection). */
  readonly binding: PlanBinding;
  /**
   * The QUERY-BOUNDARY view of this declaration, for the caller that holds the
   * graph in memory for the length of one session (the `graph_status` session
   * scope). Derived, never persisted — see `persistence/declared-record.ts`.
   */
  readonly recordedAt: number;
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

  // THE CAPABILITY SET IS THE HOST'S WHEN ONE IS IN HAND (P4 item 1). The set
  // the compilation resolves requirements against is DERIVED from the installed
  // registry — the one the run path will look implementations up in — and a
  // caller's `supported_validators` may only narrow it. An entry the host
  // cannot substantiate refuses the declaration here, before anything is
  // compiled or persisted, so a plan can never pin a capability this process
  // does not have. With NO registry supplied this builder has nothing to check
  // against and uses the declared list as handed; the shipped tool path always
  // supplies one.
  let capabilities: readonly SupportedValidatorV3[] | undefined;
  if (input.installedValidators === undefined) {
    capabilities = input.supportedValidators;
  } else {
    const resolved = resolveDeclaredValidatorCapabilities(
      input.supportedValidators,
      input.installedValidators,
    );
    if (resolved.kind === "refused") {
      throw refuseUnsubstantiatedCapabilities(resolved.issues);
    }
    capabilities = resolved.capabilities;
  }

  const compiled = compileGraph(declaration, {
    ...(input.contracts === undefined ? {} : { contracts: input.contracts }),
    ...(capabilities === undefined ? {} : { supportedValidators: capabilities }),
    ...(input.completionPolicies === undefined
      ? {}
      : { completionPolicies: input.completionPolicies }),
    ...(input.installedAcceptanceCapabilities === undefined
      ? {}
      : { acceptanceCapabilities: input.installedAcceptanceCapabilities }),
  });
  if (!compiled.ok) throw refuseCompileErrors(compiled.errors);
  if (compiled.kind === "draft") {
    throw refuseDraftPlan(
      declaration.name,
      compiled.unresolved,
      compiled.unauthorizedCompletions,
    );
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

  const stored: StoredDeclaredGraph = Object.freeze({
    graphId: declaration.name,
    declaration,
    declarationDigest,
    plan,
    record,
    binding,
    recordedAt: Date.now(),
  });

  return Object.freeze({
    graphId: declaration.name,
    declaration,
    declarationDigest,
    plan,
    record,
    binding,
    recordedAt: stored.recordedAt,
  });
}


// ── The persisted record a re-declaration must not overwrite ────────────────

/** What an existing on-disk record says about a graph id. */
export type ExistingDeclaredGraph =
  /** No state file exists for the id: this is a first declaration. */
  | { readonly kind: "absent" }
  /** A declared graph, with the plan revision its file carries. */
  | { readonly kind: "declared"; readonly planRevision: string }
  /** A file exists but is not this build's declared-graph record — never
   * overwrite it blindly. */
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Read the store's existing definition for a graph id.
 *
 * This is the adoption path, not a load path: it answers exactly "does this
 * store already own a definition for this graph, and at which plan revision",
 * and NOTHING else. The plan's own verification belongs to
 * `persistence/declared-record.ts` and is what the run paths apply.
 *
 * TOTAL: every failure is a verdict, and NONE of them is `absent`. A store this
 * build may not read — a damaged authoritative file, a retired per-graph
 * container beside it, a format with no decoder — is `unreadable` with the
 * verdict named, because answering `absent` there is exactly what would
 * initialize a new run over records the operator can still see
 * (plan §P1.6, §3.6).
 *
 * @param storeDirectory - the directory holding
 *   `graph-acceptance-ledger.sqlite`, or `undefined` when the caller has no
 *   store configured (the graph is declared in memory only).
 */
export function readExistingDeclaredGraph(
  storeDirectory: string | undefined,
  graphId: string,
): ExistingDeclaredGraph {
  if (storeDirectory === undefined) return { kind: "absent" };
  const reading = readStoredDefinition(storeDirectory, graphId);
  switch (reading.kind) {
    case "ok":
      return { kind: "declared", planRevision: reading.declared.plan.planRevision };
    case "absent":
      return { kind: "absent" };
    case "blocked":
      // AN ABSENT STORE IS ABSENT. "No store and no retired authority beside it"
      // is the one reading a caller may start a graph from; every other verdict
      // is a refusal that names what is actually there.
      if (reading.verdict.kind === "absent") return { kind: "absent" };
      return {
        kind: "unreadable",
        reason:
          `the graph store at ${storeDirectory} cannot be read for graph ` +
          `${JSON.stringify(graphId)} (` +
          describeStoreVerdict(reading.verdict) +
          ")",
      };
    case "refused":
      return {
        kind: "unreadable",
        reason:
          `the graph store already holds a definition for ${JSON.stringify(graphId)} ` +
          `that this build cannot read: ` +
          reading.issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`).join("; "),
      };
  }
}

/**
 * The retired v2 container of one graph, if it is still on disk.
 *
 * The container (`<workspace>/.rolebox/state/engine-<slug>.json` in the old
 * layout) is what `graph_declare` used to write and the outcome projection used
 * to refresh. This build neither reads nor rewrites it (plan §3.6), so a
 * declaration that would leave one behind for the SAME graph is refused before
 * anything is written: the operator must inventory and archive it first
 * (plan §P6.4). A stale container for another graph is the audit's to report.
 *
 * @param stateDir - the WORKSPACE directory whose `.rolebox/state` held the
 *   container (not the store directory: in a host-declared configuration the
 *   store lives outside the workspace and the retired files do not).
 */
export function retiredDeclaredRecord(
  stateDir: string | undefined,
  graphId: string,
): { readonly path: string } | undefined {
  if (stateDir === undefined) return undefined;
  const path = engineStatePath(stateDir, graphId);
  try {
    if (existsSync(path) && statSync(path).size > 0) return { path };
  } catch {
    // A path that cannot be stat'ed is not evidence of a record; the store gate
    // reports what the store it was asked to open actually is.
  }
  return undefined;
}

/**
 * Record a declared graph's immutable definition in the unified store.
 *
 * Returns `true` when the definition is IN the store afterwards — either
 * because this call wrote it (`recorded`) or because the store already held the
 * same declaration digest and plan revision (`preserved`, the B8 adoption
 * rule) — and `false` when no store directory is configured (the graph is
 * registered in memory only), when the store's own gate refused to open, or
 * when the write failed. Nothing is ever written over a different definition:
 * `writeDefinition` refuses that in the store, and the caller has already run
 * {@link readExistingDeclaredGraph} to turn the refusal into a declared-graph
 * error rather than a silent overwrite.
 */
export function persistDeclaredGraph(
  graph: DeclaredOutcomeGraph,
  storeDirectory: string | undefined,
): boolean {
  if (storeDirectory === undefined) return false;
  let store: GraphStore;
  try {
    store = GraphStore.openFile(storeDirectory);
  } catch (error) {
    logDeclarePersistenceFailure(graph.graphId, error);
    return false;
  }
  try {
    store.writeDefinition({
      graphId: graph.graphId,
      declarationDigest: graph.declarationDigest,
      planRevision: graph.plan.planRevision,
      declaration: graph.declaration,
      plan: graph.record,
      recordedAt: Date.now(),
    });
    return true;
  } catch (error) {
    logDeclarePersistenceFailure(graph.graphId, error);
    return false;
  } finally {
    store.close();
  }
}

/**
 * Report a persistence failure without turning it into a thrown error.
 *
 * The tool result's `persisted` flag is how the caller learns the definition
 * did not reach the store; the refusal itself is decided BEFORE this point by
 * {@link readExistingDeclaredGraph}, so a failure here is a store-level problem
 * (a gate, a disk error) and is logged with its own text rather than masked.
 */
function logDeclarePersistenceFailure(graphId: string, error: unknown): void {
  const detail =
    error instanceof GraphStoreFormatError
      ? `the store refused it (${error.problem}): ${error.message}`
      : errorText(error);
  logWarn(
    `graph_declare: the definition of graph "${graphId}" did not reach the graph store: ${detail}`,
  );
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

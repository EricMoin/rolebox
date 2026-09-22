/**
 * Graph Execution Engine v2 — Graph Compiler (v3)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The compiler: `GraphDeclarationV3` in, `CompiledPlan` out, structurally. It
 * proves declared structure — outcome references, completion policies, loop
 * routes, contract resolution and (optionally) validator capability — and
 * nothing else. It does not execute, persist, load or wire anything, and it
 * never reinterprets a legacy v2 document
 * (docs/graph-outcome-protocol.md § "Compiler and runtime boundary").
 *
 * Two properties the rest of the pipeline depends on:
 * - TOTALITY. `compileGraph` answers a `CompileResult` for every input. A
 *   malformed declaration is an ERROR, never an exception: the structural guard
 *   and the deep readers only ever hand back diagnostics, and the whole
 *   compilation is wrapped so a value that throws while being read is reported
 *   as a compile error rather than escaping into the caller.
 * - DETERMINISM. Nodes are validated in id order, edges in
 *   (from, to, outcome) order and loop groups in id order, so warnings/errors
 *   have a stable order and the plan is canonical before `plan.ts` addresses
 *   it by content. The same content therefore always compiles to the same
 *   revision, whatever order the declaration wrote it in.
 *
 * Contract resolution is DELEGATED, never re-implemented: a node's
 * `contractRef` goes through B4's `resolveContractRef` against
 * `CompileOptions.contracts`, and a resolved snapshot lands in
 * `plan.contractSnapshots[digest]` while the node carries the exact ref. A node
 * WITHOUT a contractRef is legal in this slice; contracts become mandatory for
 * outcome nodes in a later slice, once load-time refusal exists.
 *
 * Dependencies: `declaration-v3.ts` (the grammar and its structural guard),
 * `plan.ts` (the immutable plan model and its ONE content-addressed revision)
 * and `contracts/` (the ONE digest and the resolution surface).
 */

import {
  isContractRef,
  type ContractRef,
  type ContractSnapshot,
} from "../contracts/contract-definition.ts";
import {
  resolveContractRef,
  type ContractRegistry,
} from "../contracts/resolve.ts";
import type { JoinConfig, NodeBudgetSpec } from "../../types.graph-v2.ts";
import {
  isGraphDeclarationV3,
  type AcceptanceRequirementV3,
  type GraphDeclarationV3,
  type LoopGroupDeclarationV3,
  type NodeDeclarationV3,
} from "./declaration-v3.ts";
import {
  createCompiledPlan,
  type CompiledCompletionPolicy,
  type CompiledEdge,
  type CompiledLoopGroup,
  type CompiledNode,
  type CompiledOutcome,
  type CompiledOutcomeData,
  type CompiledPlan,
} from "./plan.ts";

// ── Issues ──────────────────────────────────────────────────────────────────

/**
 * Stable error codes. The later load/refusal slices branch on these strings, so
 * they are part of the contract; message wording is not.
 */
export type CompileErrorCode =
  | "malformed-declaration"
  | "duplicate-node-id"
  | "unknown-edge-endpoint"
  | "missing-outcomes"
  | "duplicate-outcome-id"
  | "missing-edge-outcome"
  | "unknown-outcome-reference"
  | "natural-completion-unknown-outcome"
  | "duplicate-natural-completion"
  | "duplicate-loop-group-id"
  | "loop-group-missing-limits"
  | "unknown-loop-member"
  | "unknown-loop-exit-outcome"
  | "unknown-loop-continuation-outcome"
  | "loop-continuation-outside-group"
  | "unresolved-contract"
  | "contract-digest-mismatch"
  | "unsupported-validator";

/** Stable non-blocking warning codes. */
export type CompileWarningCode = "unused-outcome";

/** Every code `compileGraph` can report. */
export type CompileCode = CompileErrorCode | CompileWarningCode;

/** One machine-readable compilation issue. */
export interface CompileIssue {
  /** Stable code; see {@link compileGraph} for the rule each one names. */
  readonly code: CompileCode;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
  /** Declaration location, e.g. `nodes.review.outcomes[1]`. */
  readonly path: string;
}

/**
 * A validator capability the caller declares this build has installed.
 *
 * A bare capability (no version) covers every version of that validator; a
 * versioned capability covers exactly that version. A bare REQUIREMENT is
 * covered by any installed version. Matching is identity, never ordering — the
 * same capability-not-membership rule as the storage-format, execution-protocol
 * and contract registries.
 */
export interface SupportedValidatorV3 {
  /** Validator name. */
  readonly validator: string;
  /** Exact validator version, when the capability is versioned. */
  readonly version?: number;
}

/** Inputs the compiler needs beyond the declaration itself. */
export interface CompileOptions {
  /**
   * The installed contract capability. A node's `contractRef` resolves against
   * it; with no registry supplied, a node that declares a ref fails as
   * `unresolved-contract`.
   */
  readonly contracts?: ContractRegistry;
  /**
   * The installed validator capability. Omitted, acceptance requirements are
   * not capability-checked (unknown validators pass); provided, every
   * requirement must be covered or compilation fails as
   * `unsupported-validator`. An empty array therefore declares "no validators
   * installed" and refuses every requirement.
   */
  readonly supportedValidators?: readonly SupportedValidatorV3[];
}

/**
 * The compilation result: a plan with warnings, or the errors that prevented
 * one (with the warnings that were already known).
 */
export type CompileResult =
  | {
      readonly ok: true;
      readonly plan: CompiledPlan;
      readonly warnings: readonly CompileIssue[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly CompileIssue[];
      readonly warnings: readonly CompileIssue[];
    };

// ── Compiler ────────────────────────────────────────────────────────────────

/**
 * Compile a v3 declaration into an immutable plan.
 *
 * Rules, each with its stable code:
 * - `malformed-declaration` — not a v3 declaration at all, or a field shape
 *   wrong at any depth the structural guard does not police;
 * - `duplicate-node-id` — one node id has more than one declaration;
 * - `missing-outcomes` — a node declares no outcomes;
 * - `duplicate-outcome-id` — an outcome id is declared twice on one node;
 * - `unknown-edge-endpoint` — an edge names a node that is not declared;
 * - `missing-edge-outcome` — an edge binds no outcome (unreachable through the
 *   typed grammar, reachable through the structural guard);
 * - `unknown-outcome-reference` — an edge binds an outcome its SOURCE node
 *   does not declare;
 * - `natural-completion-unknown-outcome` — a natural policy names an outcome
 *   the node does not declare;
 * - `duplicate-natural-completion` — more than one natural claim reaches the
 *   compiler (only through an array-valued policy, which the shape-level guard
 *   deliberately lets through so this precise code can name it);
 * - `duplicate-loop-group-id` — one loop group id has more than one group;
 * - `loop-group-missing-limits` — `max_traversals` is absent or not a positive
 *   safe integer;
 * - `unknown-loop-member` — a loop group names an undeclared node;
 * - `unknown-loop-continuation-outcome` / `unknown-loop-exit-outcome` — a route
 *   outcome no member node declares;
 * - `loop-continuation-outside-group` — an edge carries the continuation
 *   outcome out of the group;
 * - `unresolved-contract` — a node's `contractRef` has no installed snapshot
 *   (or no registry was supplied);
 * - `contract-digest-mismatch` — the installed snapshot's body does not hash to
 *   the ref's digest;
 * - `unsupported-validator` — an acceptance requirement no declared capability
 *   covers (only when `supportedValidators` is provided);
 *
 * and the non-blocking warning `unused-outcome` — an outcome no edge binds and
 * that is not the natural-completion outcome. Warnings never block a plan.
 *
 * PURE and TOTAL: no I/O, no mutation of the declaration, and no exception for
 * any input.
 */
export function compileGraph(
  declaration: unknown,
  options?: CompileOptions,
): CompileResult {
  try {
    return compileDeclaration(declaration, options);
  } catch (error) {
    // TOTALITY, not optimism: reading a declaration (or a hand-rolled registry)
    // can throw — an accessor that raises, a Proxy with a hostile trap — and
    // `compileGraph` is the boundary where "malformed input" is defined, so
    // that becomes a diagnostic rather than an escape into the caller. The
    // escaped value is untrusted too, so the diagnostic formatter below is
    // guarded on every read: reporting the failure must not raise one.
    return failed(
      [
        issue(
          "malformed-declaration",
          `compilation aborted while reading the declaration: ${errorText(error)}`,
          "$",
        ),
      ],
      [],
    );
  }
}

/** Mutable issue accumulator for one compilation pass. */
interface IssueLog {
  readonly errors: CompileIssue[];
  readonly warnings: CompileIssue[];
}

/** One edge as read from the declaration, with the slot it came from. */
interface EdgeReading {
  /** Position in the declaration's `edges` array, for diagnostics. */
  readonly index: number;
  readonly from: string;
  readonly to: string;
  /** `null` when the edge binds no outcome at all. */
  readonly outcome: string | null;
}

/** What the completion policy of one node declares. */
type CompletionReading =
  | { readonly kind: "absent" }
  | { readonly kind: "explicit" }
  | { readonly kind: "natural"; readonly outcome: string }
  | { readonly kind: "duplicate-natural" }
  | { readonly kind: "invalid" };

/** Compile one guarded declaration. */
function compileDeclaration(
  declaration: unknown,
  options: CompileOptions | undefined,
): CompileResult {
  if (!isGraphDeclarationV3(declaration)) {
    return failed(
      [
        issue(
          "malformed-declaration",
          "not a v3 graph declaration: expected { version: 3, name, nodes: [...], edges: [...] } with optional loop_groups",
          "$",
        ),
      ],
      [],
    );
  }

  const log: IssueLog = { errors: [], warnings: [] };
  const nodesById = indexNodes(declaration, log);
  const declaredOutcomes = new Map<string, ReadonlySet<string>>();
  for (const node of nodesById.values()) {
    declaredOutcomes.set(node.id, declaredOutcomeIds(node));
  }
  const edges = readEdges(declaration);
  const boundOutcomes = boundOutcomeKeys(edges);
  const snapshots = new Map<string, ContractSnapshot>();

  const nodes: CompiledNode[] = [];
  for (const node of nodesById.values()) {
    nodes.push(
      compileNode(node, options, log, boundOutcomes, snapshots),
    );
  }
  const compiledEdges = compileEdges(edges, nodesById, declaredOutcomes, log);
  const loopGroups = compileLoopGroups(
    declaration,
    nodesById,
    declaredOutcomes,
    edges,
    log,
  );

  if (log.errors.length > 0) {
    return failed(log.errors, log.warnings);
  }
  return succeeded(
    createCompiledPlan({
      graphId: declaration.name,
      declarationVersion: 3,
      nodes,
      edges: compiledEdges,
      loopGroups,
      contractSnapshots: snapshotIndex(snapshots),
    }),
    log.warnings,
  );
}

// ── Nodes ───────────────────────────────────────────────────────────────────

/**
 * Index the declared nodes by id, reporting duplicate ids.
 *
 * The FIRST declaration of an id is the canonical one: it is what edges bind
 * against and what the plan carries. Duplicates are reported in id order (not
 * declaration order), so reordering a declaration cannot reorder its errors.
 */
function indexNodes(
  declaration: GraphDeclarationV3,
  log: IssueLog,
): Map<string, NodeDeclarationV3> {
  const indicesById = new Map<string, number[]>();
  declaration.nodes.forEach((node, index) => {
    const indices = indicesById.get(node.id);
    if (indices === undefined) {
      indicesById.set(node.id, [index]);
      return;
    }
    indices.push(index);
  });
  for (const id of [...indicesById.keys()].sort(compareText)) {
    const indices = indicesById.get(id);
    if (indices !== undefined && indices.length > 1) {
      log.errors.push(
        issue(
          "duplicate-node-id",
          `node id ${JSON.stringify(id)} is declared ${indices.length} times (at nodes[${indices.join("], nodes[")}]) — one node id has exactly one declaration`,
          nodePath(id),
        ),
      );
    }
  }
  const byId = new Map<string, NodeDeclarationV3>();
  for (const node of declaration.nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  return new Map(
    [...byId.entries()].sort(([a], [b]) => compareText(a, b)),
  );
}

/** Compile one node, reporting every defect at its own path. */
function compileNode(
  node: NodeDeclarationV3,
  options: CompileOptions | undefined,
  log: IssueLog,
  boundOutcomes: ReadonlySet<string>,
  snapshots: Map<string, ContractSnapshot>,
): CompiledNode {
  const base = nodePath(node.id);
  const outcomeEntries = compileOutcomes(node, options, log);
  const outcomes = outcomeEntries.map((entry) => entry.outcome);

  if (node.outcomes.length === 0) {
    log.errors.push(
      issue(
        "missing-outcomes",
        `node ${JSON.stringify(node.id)} declares no outcomes — a v3 node declares at least one`,
        base,
      ),
    );
  }

  const completion = readCompletionPolicy(node.completion);
  const planCompletion = toPlanCompletion(completion);
  if (completion.kind === "invalid") {
    log.errors.push(
      issue(
        "malformed-declaration",
        `completion policy of node ${JSON.stringify(node.id)} is not { mode: "explicit" } or { mode: "natural", outcome }`,
        `${base}.completion`,
      ),
    );
  } else if (completion.kind === "duplicate-natural") {
    log.errors.push(
      issue(
        "duplicate-natural-completion",
        `node ${JSON.stringify(node.id)} carries more than one natural-completion claim — a natural policy names exactly one outcome`,
        `${base}.completion`,
      ),
    );
  } else if (
    completion.kind === "natural" &&
    !outcomes.some((outcome) => outcome.id === completion.outcome)
  ) {
    log.errors.push(
      issue(
        "natural-completion-unknown-outcome",
        `natural completion of node ${JSON.stringify(node.id)} names outcome ${JSON.stringify(completion.outcome)}, which the node does not declare`,
        `${base}.completion`,
      ),
    );
  }

  const contractRef = bindContract(node, options, log, snapshots);

  const join = readJoin(node.join);
  if (node.join !== undefined && join === null) {
    log.errors.push(
      issue(
        "malformed-declaration",
        `join of node ${JSON.stringify(node.id)} is not a JoinConfig: { strategy: "all" | "any" } or { strategy: "quorum", quorum: N } with a positive integer N`,
        `${base}.join`,
      ),
    );
  }

  const budget = readBudget(node.budget);
  if (node.budget !== undefined && budget === null) {
    log.errors.push(
      issue(
        "malformed-declaration",
        `budget of node ${JSON.stringify(node.id)} carries a non-finite number in a budget field`,
        `${base}.budget`,
      ),
    );
  }

  for (const entry of outcomeEntries) {
    const outcome = entry.outcome;
    const natural =
      planCompletion !== undefined &&
      planCompletion.mode === "natural" &&
      planCompletion.outcome === outcome.id;
    if (!natural && !boundOutcomes.has(outcomeKey(node.id, outcome.id))) {
      log.warnings.push(
        issue(
          "unused-outcome",
          `outcome ${JSON.stringify(outcome.id)} of node ${JSON.stringify(node.id)} is never bound by an edge and is not the natural-completion outcome`,
          `${base}.outcomes[${entry.declaredIndex}]`,
        ),
      );
    }
  }

  return {
    id: node.id,
    agent: node.agent,
    prompt: node.prompt,
    outcomes,
    ...(planCompletion === undefined ? {} : { completion: planCompletion }),
    ...(contractRef === undefined ? {} : { contractRef }),
    ...(join === null ? {} : { join }),
    ...(budget === null ? {} : { budget }),
  };
}

/** One accepted outcome plus the declaration slot it came from. */
interface OutcomeEntry {
  readonly outcome: CompiledOutcome;
  /** Position in the node's declaration — the path a diagnostic points at. */
  readonly declaredIndex: number;
}

/**
 * Compile a node's outcomes in declaration order for DIAGNOSTICS, then sort the
 * accepted ones by id for the plan: outcomes are an addressable set, so
 * canonical order is id order regardless of how the declaration wrote them.
 * Each entry keeps its DECLARATION index, so a warning still points at the slot
 * the author wrote rather than at the canonical position.
 */
function compileOutcomes(
  node: NodeDeclarationV3,
  options: CompileOptions | undefined,
  log: IssueLog,
): OutcomeEntry[] {
  const base = nodePath(node.id);
  const accepted: OutcomeEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < node.outcomes.length; index++) {
    const path = `${base}.outcomes[${index}]`;
    const raw: unknown = node.outcomes[index];
    if (!isRecord(raw)) {
      log.errors.push(
        issue("malformed-declaration", `outcome at ${path} is not an object`, path),
      );
      continue;
    }
    const id = raw.id;
    if (!isNonEmptyString(id)) {
      log.errors.push(
        issue(
          "malformed-declaration",
          `outcome at ${path} has no non-empty string id`,
          path,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      log.errors.push(
        issue(
          "duplicate-outcome-id",
          `outcome id ${JSON.stringify(id)} is declared twice on node ${JSON.stringify(node.id)} — one outcome id has exactly one declaration`,
          path,
        ),
      );
      continue;
    }
    seen.add(id);

    const data = readOutcomeData(raw.data);
    if (raw.data !== undefined && data === null) {
      log.errors.push(
        issue(
          "malformed-declaration",
          `data contract at ${path}.data is not { schema, version? }`,
          `${path}.data`,
        ),
      );
    }

    accepted.push({
      outcome: {
        id,
        ...(data === null ? {} : { data }),
        acceptance: readAcceptance(raw.acceptance, path, options, log),
      },
      declaredIndex: index,
    });
  }
  return accepted.sort((a, b) =>
    compareText(a.outcome.id, b.outcome.id),
  );
}

/** Read one outcome's optional data contract. */
function readOutcomeData(raw: unknown): CompiledOutcomeData | null {
  if (!isRecord(raw)) return null;
  const schema = raw.schema;
  if (!isNonEmptyString(schema)) return null;
  const version = raw.version;
  if (version === undefined) return { schema };
  if (!isFiniteNumber(version)) return null;
  return { schema, version };
}

/**
 * Read an outcome's acceptance requirements, preserving their declared order
 * (they are an ordered gate sequence), and capability-check each one when the
 * caller declared installed validators.
 */
function readAcceptance(
  raw: unknown,
  outcomePath: string,
  options: CompileOptions | undefined,
  log: IssueLog,
): AcceptanceRequirementV3[] {
  if (raw === undefined) return [];
  const base = `${outcomePath}.acceptance`;
  if (!Array.isArray(raw)) {
    log.errors.push(
      issue(
        "malformed-declaration",
        `acceptance at ${base} is not an array of { validator, version? }`,
        base,
      ),
    );
    return [];
  }
  const acceptance: AcceptanceRequirementV3[] = [];
  for (let index = 0; index < raw.length; index++) {
    const path = `${base}[${index}]`;
    const requirement = readAcceptanceRequirement(raw[index]);
    if (requirement === null) {
      log.errors.push(
        issue(
          "malformed-declaration",
          `acceptance requirement at ${path} is not { validator, version? } with a non-empty validator and a finite version`,
          path,
        ),
      );
      continue;
    }
    const supported = options?.supportedValidators;
    if (supported !== undefined && !isValidatorSupported(requirement, supported)) {
      log.errors.push(
        issue(
          "unsupported-validator",
          `validator ${describeValidator(requirement)} is not installed: no declared supported validator covers it`,
          path,
        ),
      );
    }
    acceptance.push(requirement);
  }
  return acceptance;
}

/** Read one acceptance requirement, or `null` when it is not one. */
function readAcceptanceRequirement(
  raw: unknown,
): AcceptanceRequirementV3 | null {
  if (!isRecord(raw)) return null;
  const validator = raw.validator;
  if (!isNonEmptyString(validator)) return null;
  const version = raw.version;
  if (version === undefined) return { validator };
  if (!isFiniteNumber(version)) return null;
  return { validator, version };
}

/** Whether a declared capability covers a requirement (identity, not ordering). */
function isValidatorSupported(
  requirement: AcceptanceRequirementV3,
  supported: readonly SupportedValidatorV3[],
): boolean {
  return supported.some((capability) => {
    if (capability.validator !== requirement.validator) return false;
    if (requirement.version === undefined) return true;
    return (
      capability.version === undefined ||
      capability.version === requirement.version
    );
  });
}

/**
 * A node's declared outcome ids, including malformed elements' readable ids:
 * an edge that binds an id the node literally declares is not an unknown
 * reference, even when that outcome's own body is defective.
 */
function declaredOutcomeIds(node: NodeDeclarationV3): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const raw of node.outcomes) {
    if (isRecord(raw) && isNonEmptyString(raw.id)) ids.add(raw.id);
  }
  return ids;
}

// ── Completion policy ───────────────────────────────────────────────────────

/**
 * Read a node's completion policy.
 *
 * The grammar admits ONE policy object. An array is not one, but it is the only
 * shape in which a second natural claim can reach the compiler (the structural
 * guard checks the container, not the policy), so an array of natural claims is
 * named as `duplicate-natural-completion` and any other malformed container as
 * a plain malformation.
 */
function readCompletionPolicy(raw: unknown): CompletionReading {
  if (raw === undefined) return { kind: "absent" };
  if (Array.isArray(raw)) {
    let naturalClaims = 0;
    for (const candidate of raw) {
      if (!isRecord(candidate)) return { kind: "invalid" };
      if (candidate.mode === "explicit") continue;
      if (candidate.mode === "natural" && isNonEmptyString(candidate.outcome)) {
        naturalClaims += 1;
        continue;
      }
      return { kind: "invalid" };
    }
    return naturalClaims > 1
      ? { kind: "duplicate-natural" }
      : { kind: "invalid" };
  }
  if (!isRecord(raw)) return { kind: "invalid" };
  if (raw.mode === "explicit") return { kind: "explicit" };
  const outcome = raw.outcome;
  if (raw.mode === "natural" && isNonEmptyString(outcome)) {
    return { kind: "natural", outcome };
  }
  return { kind: "invalid" };
}

/** Project a valid completion reading into the plan's policy. */
function toPlanCompletion(
  reading: CompletionReading,
): CompiledCompletionPolicy | undefined {
  switch (reading.kind) {
    case "explicit":
      return { mode: "explicit" };
    case "natural":
      return { mode: "natural", outcome: reading.outcome };
    default:
      return undefined;
  }
}

// ── Join and budget ─────────────────────────────────────────────────────────

/** Read a node's optional fan-in config, or `null` when it is not one. */
function readJoin(raw: unknown): JoinConfig | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (raw.strategy === "all") return { strategy: "all" };
  if (raw.strategy === "any") return { strategy: "any" };
  if (raw.strategy === "quorum") {
    const quorum = raw.quorum;
    if (!isPositiveSafeInteger(quorum)) return null;
    return { strategy: "quorum", quorum };
  }
  return null;
}

/** Budget fields in the runtime vocabulary's declaration order. */
const BUDGET_FIELDS = [
  "max_input_tokens",
  "max_output_tokens",
  "max_cost_usd",
  "timeout_ms",
  "max_retries",
] as const satisfies readonly (keyof NodeBudgetSpec)[];

/**
 * Read a node's optional budget. Only the runtime's five numeric fields are
 * copied — compilation normalizes to the plan vocabulary, so a non-grammar
 * field is not carried into the plan. A non-finite value is malformed because
 * the canonical digest has no representation for it.
 */
function readBudget(raw: unknown): NodeBudgetSpec | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const budget: NodeBudgetSpec = {};
  for (const field of BUDGET_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!isFiniteNumber(value)) return null;
    budget[field] = value;
  }
  return budget;
}

// ── Contracts ───────────────────────────────────────────────────────────────

/**
 * Resolve a node's `contractRef` through B4's resolver and record the resolved
 * snapshot by digest, returning the binding the plan carries.
 *
 * The compiler never looks a contract up itself and never re-hashes a body: it
 * asks `resolveContractRef` and maps its four-way verdict onto the two compile
 * codes. A node with no ref is legal in this slice and simply has no binding.
 */
function bindContract(
  node: NodeDeclarationV3,
  options: CompileOptions | undefined,
  log: IssueLog,
  snapshots: Map<string, ContractSnapshot>,
): ContractRef | undefined {
  const raw: unknown = node.contractRef;
  if (raw === undefined) return undefined;
  const path = `${nodePath(node.id)}.contractRef`;
  if (!isContractRef(raw)) {
    log.errors.push(
      issue(
        "malformed-declaration",
        `contractRef at ${path} is not { id, revision, digest } with non-empty strings`,
        path,
      ),
    );
    return undefined;
  }
  const registry = options?.contracts;
  if (registry === undefined) {
    log.errors.push(
      issue(
        "unresolved-contract",
        `contract ${describeRef(raw)} cannot be resolved: no contract registry was supplied`,
        path,
      ),
    );
    return undefined;
  }

  let resolution;
  try {
    resolution = resolveContractRef(raw, registry);
  } catch (error) {
    log.errors.push(
      issue(
        "unresolved-contract",
        `contract ${describeRef(raw)} could not be resolved: ${errorText(error)}`,
        path,
      ),
    );
    return undefined;
  }

  switch (resolution.kind) {
    case "resolved":
      snapshots.set(raw.digest, resolution.snapshot);
      return { id: raw.id, revision: raw.revision, digest: raw.digest };
    case "unknown-contract":
      log.errors.push(
        issue(
          "unresolved-contract",
          `contract ${describeRef(raw)} is not installed: no contract with id ${JSON.stringify(resolution.id)}`,
          path,
        ),
      );
      return undefined;
    case "unknown-revision":
      log.errors.push(
        issue(
          "unresolved-contract",
          `contract ${describeRef(raw)} is not installed: id ${JSON.stringify(raw.id)} has no revision ${JSON.stringify(raw.revision)} — a revision is an exact identifier, never a range`,
          path,
        ),
      );
      return undefined;
    case "digest-mismatch":
      log.errors.push(
        issue(
          "contract-digest-mismatch",
          `contract ${JSON.stringify(raw.id)}@${JSON.stringify(raw.revision)} declares digest ${raw.digest} but the registered body hashes to ${resolution.actual}`,
          path,
        ),
      );
      return undefined;
  }
}

// ── Edges ───────────────────────────────────────────────────────────────────

/**
 * Read every edge, then validate them in canonical (from, to, outcome) order.
 *
 * The path names the edge's DECLARATION slot for a human, while the ORDER of
 * the issues is canonical, so reordering a declaration cannot reorder its
 * diagnostics.
 */
function readEdges(declaration: GraphDeclarationV3): EdgeReading[] {
  return declaration.edges.map((edge, index) => {
    const rawOutcome: unknown = edge.outcome;
    return {
      index,
      from: edge.from,
      to: edge.to,
      outcome: isNonEmptyString(rawOutcome) ? rawOutcome : null,
    };
  });
}

/** Canonical edge order: source, then target, then outcome. */
function compareEdgeReadings(a: EdgeReading, b: EdgeReading): number {
  return (
    compareText(a.from, b.from) ||
    compareText(a.to, b.to) ||
    compareText(a.outcome ?? "", b.outcome ?? "")
  );
}

/** Every (source node, outcome) pair an edge binds, for unused-outcome. */
function boundOutcomeKeys(edges: readonly EdgeReading[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const edge of edges) {
    if (edge.outcome !== null) keys.add(outcomeKey(edge.from, edge.outcome));
  }
  return keys;
}

/** Compile the edges in canonical order. */
function compileEdges(
  edges: readonly EdgeReading[],
  nodesById: ReadonlyMap<string, NodeDeclarationV3>,
  declaredOutcomes: ReadonlyMap<string, ReadonlySet<string>>,
  log: IssueLog,
): CompiledEdge[] {
  const compiled: CompiledEdge[] = [];
  for (const edge of [...edges].sort(compareEdgeReadings)) {
    const path = `edges[${edge.index}]`;
    const source = nodesById.get(edge.from);
    const target = nodesById.get(edge.to);
    if (source === undefined || target === undefined) {
      const unknown = [
        source === undefined ? `from ${JSON.stringify(edge.from)}` : "",
        target === undefined ? `to ${JSON.stringify(edge.to)}` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" and ");
      log.errors.push(
        issue(
          "unknown-edge-endpoint",
          `edge ${edge.index} names an undeclared ${unknown}`,
          path,
        ),
      );
    }
    if (edge.outcome === null) {
      log.errors.push(
        issue(
          "missing-edge-outcome",
          `edge ${edge.index} (from ${JSON.stringify(edge.from)} to ${JSON.stringify(edge.to)}) binds no outcome — every v3 control edge binds exactly one`,
          path,
        ),
      );
      continue;
    }
    if (
      source !== undefined &&
      !(declaredOutcomes.get(edge.from)?.has(edge.outcome) ?? false)
    ) {
      log.errors.push(
        issue(
          "unknown-outcome-reference",
          `edge ${edge.index} binds outcome ${JSON.stringify(edge.outcome)} which source node ${JSON.stringify(edge.from)} does not declare`,
          path,
        ),
      );
    }
    compiled.push({ from: edge.from, to: edge.to, outcome: edge.outcome });
  }
  return compiled;
}

// ── Loop groups ─────────────────────────────────────────────────────────────

/**
 * Index the declared loop groups by id (reporting duplicate ids) and compile
 * them in id order.
 */
function compileLoopGroups(
  declaration: GraphDeclarationV3,
  nodesById: ReadonlyMap<string, NodeDeclarationV3>,
  declaredOutcomes: ReadonlyMap<string, ReadonlySet<string>>,
  edges: readonly EdgeReading[],
  log: IssueLog,
): CompiledLoopGroup[] {
  const declared = declaration.loop_groups ?? [];
  const indicesById = new Map<string, number>();
  for (const group of declared) {
    indicesById.set(group.id, (indicesById.get(group.id) ?? 0) + 1);
  }
  for (const id of [...indicesById.keys()].sort(compareText)) {
    const count = indicesById.get(id) ?? 0;
    if (count > 1) {
      log.errors.push(
        issue(
          "duplicate-loop-group-id",
          `loop group id ${JSON.stringify(id)} is declared ${count} times — one loop group id has exactly one group`,
          `loop_groups.${id}`,
        ),
      );
    }
  }
  const byId = new Map<string, LoopGroupDeclarationV3>();
  for (const group of declared) {
    if (!byId.has(group.id)) byId.set(group.id, group);
  }
  return [...byId.values()]
    .sort((a, b) => compareText(a.id, b.id))
    .map((group) =>
      compileLoopGroup(group, nodesById, declaredOutcomes, edges, log),
    );
}

/** Compile one loop group: its cap, its members and its two declared routes. */
function compileLoopGroup(
  group: LoopGroupDeclarationV3,
  nodesById: ReadonlyMap<string, NodeDeclarationV3>,
  declaredOutcomes: ReadonlyMap<string, ReadonlySet<string>>,
  edges: readonly EdgeReading[],
  log: IssueLog,
): CompiledLoopGroup {
  const path = `loop_groups.${group.id}`;
  const hasLimits = isPositiveSafeInteger(group.max_traversals);
  if (!hasLimits) {
    log.errors.push(
      issue(
        "loop-group-missing-limits",
        `loop group ${JSON.stringify(group.id)} needs max_traversals as a positive safe integer, received ${describeValue(group.max_traversals)}`,
        path,
      ),
    );
  }

  const members: string[] = [];
  const memberSet = new Set<string>();
  for (let index = 0; index < group.nodes.length; index++) {
    const raw: unknown = group.nodes[index];
    if (!isNonEmptyString(raw) || !nodesById.has(raw)) {
      log.errors.push(
        issue(
          "unknown-loop-member",
          `loop group ${JSON.stringify(group.id)} names ${describeValue(raw)} as a member, which is not a declared node id`,
          `${path}.nodes[${index}]`,
        ),
      );
      continue;
    }
    if (!memberSet.has(raw)) {
      memberSet.add(raw);
      members.push(raw);
    }
  }

  const continuation = readRouteOutcome(
    group.continuation_outcome,
    `${path}.continuation_outcome`,
    "continuation",
    log,
  );
  const exit = readRouteOutcome(
    group.exit_outcome,
    `${path}.exit_outcome`,
    "exit",
    log,
  );

  if (
    continuation !== null &&
    !membersDeclareOutcome(members, declaredOutcomes, continuation)
  ) {
    log.errors.push(
      issue(
        "unknown-loop-continuation-outcome",
        `continuation outcome ${JSON.stringify(continuation)} is not declared by any member of loop group ${JSON.stringify(group.id)}`,
        `${path}.continuation_outcome`,
      ),
    );
  }
  if (exit !== null && !membersDeclareOutcome(members, declaredOutcomes, exit)) {
    log.errors.push(
      issue(
        "unknown-loop-exit-outcome",
        `exit outcome ${JSON.stringify(exit)} is not declared by any member of loop group ${JSON.stringify(group.id)}`,
        `${path}.exit_outcome`,
      ),
    );
  }

  if (continuation !== null) {
    // The continuation outcome must re-enter the group: an edge that carries it
    // to a node outside the member set is a structural escape, not a route.
    const reported = new Set<number>();
    for (const edge of edges) {
      if (edge.outcome !== continuation) continue;
      if (!memberSet.has(edge.from)) continue;
      if (memberSet.has(edge.to)) continue;
      if (reported.has(edge.index)) continue;
      reported.add(edge.index);
      log.errors.push(
        issue(
          "loop-continuation-outside-group",
          `edge ${edge.index} carries continuation outcome ${JSON.stringify(continuation)} of loop group ${JSON.stringify(group.id)} to ${JSON.stringify(edge.to)}, outside the group`,
          `edges[${edge.index}]`,
        ),
      );
    }
  }

  return {
    id: group.id,
    nodes: [...members].sort(compareText),
    maxTraversals: hasLimits ? group.max_traversals : 0,
    continuationOutcome: continuation ?? "",
    exitOutcome: exit ?? "",
  };
}

/** Read one required loop route outcome, or `null` when it is not one. */
function readRouteOutcome(
  raw: unknown,
  path: string,
  label: string,
  log: IssueLog,
): string | null {
  if (isNonEmptyString(raw)) return raw;
  log.errors.push(
    issue(
      "malformed-declaration",
      `${label} outcome at ${path} is ${describeValue(raw)}, not a non-empty outcome id`,
      path,
    ),
  );
  return null;
}

/** Whether any member node declares one outcome id. */
function membersDeclareOutcome(
  members: readonly string[],
  declaredOutcomes: ReadonlyMap<string, ReadonlySet<string>>,
  outcomeId: string,
): boolean {
  return members.some(
    (member) => declaredOutcomes.get(member)?.has(outcomeId) ?? false,
  );
}

// ── Snapshots and result assembly ───────────────────────────────────────────

/**
 * Build the plan's contract index, keyed by digest in digest order. Digest keys
 * are SHA-256 hex produced by `contractDigest`, so a prototype-shaped key
 * cannot occur.
 */
function snapshotIndex(
  snapshots: ReadonlyMap<string, ContractSnapshot>,
): Readonly<Record<string, ContractSnapshot>> {
  const index: Record<string, ContractSnapshot> = {};
  for (const digest of [...snapshots.keys()].sort(compareText)) {
    const snapshot = snapshots.get(digest);
    if (snapshot !== undefined) index[digest] = snapshot;
  }
  return index;
}

/** Assemble a successful result with a frozen issue list. */
function succeeded(
  plan: CompiledPlan,
  warnings: readonly CompileIssue[],
): CompileResult {
  return Object.freeze({
    ok: true as const,
    plan,
    warnings: Object.freeze([...warnings]),
  });
}

/** Assemble a failed result with frozen issue lists. */
function failed(
  errors: readonly CompileIssue[],
  warnings: readonly CompileIssue[],
): CompileResult {
  return Object.freeze({
    ok: false as const,
    errors: Object.freeze([...errors]),
    warnings: Object.freeze([...warnings]),
  });
}

/** Build one frozen issue. */
function issue(code: CompileCode, message: string, path: string): CompileIssue {
  return Object.freeze({ code, message, path });
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** The diagnostic path of a node. */
function nodePath(id: string): string {
  return `nodes.${id}`;
}

/** The flat key of one (source node, outcome) binding. */
function outcomeKey(nodeId: string, outcomeId: string): string {
  // A NUL separator cannot occur in either id, so two different pairs can never
  // collide in one flat key.
  return `${nodeId}\u0000${outcomeId}`;
}

/** UTF-16 code-unit order: locale-independent, so ids sort the same everywhere. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a value is a finite number the canonical digest can represent. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether a value is a positive safe integer (the capability-legality rule). */
function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

/** A contract ref as a diagnostic token: `"id"@"revision"`. */
function describeRef(ref: ContractRef): string {
  return `${JSON.stringify(ref.id)}@${JSON.stringify(ref.revision)}`;
}

/** A validator requirement as a diagnostic token. */
function describeValidator(requirement: AcceptanceRequirementV3): string {
  return requirement.version === undefined
    ? JSON.stringify(requirement.validator)
    : `${JSON.stringify(requirement.validator)} version ${requirement.version}`;
}

/** Describe an arbitrary value for a diagnostic without ever throwing or leaking. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "object") {
    return Array.isArray(value) ? "an array" : "an object";
  }
  try {
    return String(value);
  } catch {
    // A function whose `toString` raises is still describable by its type.
    return `a ${typeof value}`;
  }
}

/**
 * The message of a thrown value, for a diagnostic.
 *
 * TOTALITY: the value reaching this boundary is whatever escaped a declaration
 * read, so it can be hostile itself — a Proxy raises from `getPrototypeOf`,
 * which makes `instanceof` throw, and one that raises from `get` throws on a
 * `.message` read and again when coerced with `String`. Every step is
 * therefore guarded on its own: a diagnostic must never become the exception it
 * is reporting.
 */
function errorText(error: unknown): string {
  const message = readStringProperty(error, "message");
  if (message !== undefined) return message;
  try {
    return String(error);
  } catch {
    return "a thrown value that could not be described";
  }
}

/** Read one string-valued property from a possibly hostile value, or `undefined`. */
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  if (value === null) return undefined;
  try {
    const property: unknown = Reflect.get(value, key);
    return typeof property === "string" ? property : undefined;
  } catch {
    return undefined;
  }
}

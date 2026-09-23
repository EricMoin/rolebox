/**
 * Graph Execution Engine v2 — Authoring Grammar v3
 *
 * Version: 3.0
 * Date: 2026-09-22
 *
 * The v3 authoring grammar — the declaration shape `compile.ts` accepts — plus
 * the structural guard that turns malformed input into a compile error instead
 * of a throw. This module owns the grammar TYPES and the shallow shape check;
 * the deep rules (outcome references, completion policies, loop routes,
 * contract resolution, validator capability) belong to the compiler, and the
 * immutable result belongs to `plan.ts`
 * (docs/graph-outcome-protocol.md § "Compiler and runtime boundary").
 *
 * What v3 declares that v2 does not:
 * - Every node declares OUTCOMES. A node with none is a compile error, so
 *   routing never has to interpret a free-form payload field.
 * - Every control edge binds an outcome explicitly. There is deliberately no
 *   implicit "any signal" edge in this grammar: an edge that binds nothing
 *   cannot be compiled into a decision. Typed predicates are a LATER addition
 *   and have no field here yet.
 * - A node may map natural (runtime) completion to exactly one of its outcomes
 *   and attach acceptance requirements to each outcome. A graph REQUESTS a
 *   versioned completion-policy revision for those mappings; the request is
 *   never an authorization, because the installed policy — not the declaring
 *   worker — decides whether a mapping is granted.
 * - A loop group declares its continuation and exit outcomes instead of relying
 *   on an inferred marker, and may declare a progress POLICY — the comparison
 *   semantics, the comparison object and an explicit stagnation threshold.
 *
 * Compiling this grammar validates STRUCTURE only. A YAML/JSON authoring
 * front-end for it, plan persistence, binding compiled refs into runtime state,
 * load-time refusal, adapters/schema compatibility, the typed-predicate
 * vocabulary and any engine wiring are deferred to later slices. Legacy v2
 * documents are not this grammar: `GraphDeclaration.version` is still 2 for
 * them, and the v2 parser/validator/engine path is untouched by this module.
 *
 * Dependency-clean by construction: every import is TYPE-ONLY — the shared
 * `JoinConfig` / `NodeBudgetSpec` vocabulary from
 * `src/types.graph-v2.ts` and the canonical `ContractRef` identity from
 * `contracts/contract-definition.ts` — so the grammar reuses the runtime's
 * join/budget shapes and the resolver's exact ref type instead of declaring
 * second, drift-prone copies, and this module adds no runtime dependency at
 * all.
 */

import type { ContractRef } from "../contracts/contract-definition.ts";
import type { JoinConfig, NodeBudgetSpec } from "../../types.graph-v2.ts";

// ── Outcomes ────────────────────────────────────────────────────────────────

/**
 * The data contract of one outcome: the schema its payload is validated
 * against. `version` is an exact capability identity when a schema is
 * versioned; the compiler never orders or ranges it.
 */
export interface OutcomeDataV3 {
  /** Schema identity for the outcome's data payload. */
  schema: string;
  /** Exact schema version, when the schema is versioned. */
  version?: number;
}

/**
 * One acceptance requirement: a validator identity and, when the validator has
 * versions, the exact version that must be installed.
 *
 * An unsupported requirement is a COMPILE error when the caller declares its
 * installed validator capabilities
 * (`CompileOptions.supportedValidators`), never a runtime surprise: the
 * requirement is checked where the plan is built, before anything can run it.
 */
export interface AcceptanceRequirementV3 {
  /** Validator name, e.g. a schema or artifact-reference validator. */
  validator: string;
  /**
   * Exact validator version, when the validator is versioned. Never a minimum:
   * capability matching is identity, not ordering.
   */
  version?: number;
}

/**
 * One outcome a node can produce.
 *
 * Outcomes are an addressable SET: an edge binds one by id, and the compiler
 * sorts them by id in the compiled plan, so declaration order carries no
 * meaning. Duplicate ids within a node are a compile error — one outcome id has
 * exactly one declaration, otherwise an edge binding it would be ambiguous.
 */
export interface OutcomeDeclarationV3 {
  /** Unique outcome id within its node; edges bind outcomes by this id. */
  id: string;
  /** Optional data contract for the outcome payload. */
  data?: OutcomeDataV3;
  /**
   * Acceptance gates that must pass before the outcome is accepted. ORDER IS
   * MEANING: the requirements form a gate sequence, so the compiler preserves
   * the declared order in the plan.
   */
  acceptance?: AcceptanceRequirementV3[];
}

/**
 * How a node reaches a terminal state.
 *
 * - `explicit` — the agent must submit one of the node's declared outcomes.
 * - `natural` — runtime completion maps to EXACTLY the named outcome. A
 *   natural policy may produce ONLY that outcome: it is not a licence to emit
 *   any declared outcome, and the named outcome's acceptance requirements still
 *   apply — the policy changes where completion comes from, never which gates
 *   that outcome must pass.
 *
 * An ABSENT policy means the declaration leaves the policy open; what that
 * means at runtime is a later-slice decision, so the compiler preserves the
 * absence instead of inventing a default.
 */
export type CompletionPolicyV3 =
  | { mode: "explicit" }
  | { mode: "natural"; outcome: string };

/**
 * The completion-policy revision a graph REQUESTS for its natural completion
 * mappings.
 *
 * A request is not an authorization: it names a policy identity, and the
 * installed capability — a host-authorized, content-pinned selection
 * (`src/graph/policy/completion-policy.ts`) — decides whether that revision
 * exists and whether its rules grant each mapping. A declaration can therefore
 * ask for a revision that is merely present, unknown, or forbidden, and the
 * compiler answers a draft or a refusal rather than a grant it invented.
 * Naming a `digest` here would not add authority either (a declaration
 * cannot attest content), which is why the grammar has no such field.
 */
export interface CompletionPolicyRequestV3 {
  /** The policy declaration's id. */
  readonly id: string;
  /** The exact revision requested; an opaque immutable identifier. */
  readonly revision: string;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

/**
 * Role-agnostic v3 node: an {agent, prompt} tuple plus the outcomes it may
 * produce, its completion policy, and the resources it may consume.
 *
 * `contractRef` is OPTIONAL in this slice: a node without a contract is
 * structurally legal here, and contracts become mandatory for outcome nodes in
 * a later slice once the load boundary can refuse a missing binding. `join`
 * and `budget` reuse the runtime's own `JoinConfig` /
 * `NodeBudgetSpec` vocabulary rather than restating it.
 */
export interface NodeDeclarationV3 {
  /** Unique identifier within the graph. */
  id: string;
  /** Agent identifier (dispatchable subagent name). */
  agent: string;
  /** Prompt text executed by the agent. */
  prompt: string;
  /** The outcomes this node may produce; at least one is required. */
  outcomes: OutcomeDeclarationV3[];
  /** How runtime completion maps to an outcome; absent leaves the policy open. */
  completion?: CompletionPolicyV3;
  /** The exact contract revision this node is bound to, when it declares one. */
  contractRef?: ContractRef;
  /** Fan-in strategy for a convergence node (the runtime's own vocabulary). */
  join?: JoinConfig;
  /** Per-node resource budget (the runtime's own vocabulary). */
  budget?: NodeBudgetSpec;
}

// ── Edges ───────────────────────────────────────────────────────────────────

/**
 * One directed control edge.
 *
 * The outcome binding is REQUIRED by this type and by the compiler: every v3
 * edge routes on an outcome its SOURCE node declares, so there is no implicit
 * "any signal" edge and no severity-ranked fallback. Typed predicates are a
 * later addition; there is deliberately no predicate field here yet, and an
 * edge whose outcome is missing cannot be compiled into a decision.
 */
export interface EdgeDeclarationV3 {
  /** Source node ID. */
  from: string;
  /** Target node ID. */
  to: string;
  /** The outcome of `from` this edge routes on. */
  outcome: string;
}

// ── Loop groups ─────────────────────────────────────────────────────────────

/**
 * One loop group's optional PROGRESS policy: the comparison SEMANTICS, the
 * comparison OBJECT and an explicit stagnation threshold.
 *
 * Every part is declared, never inferred from a worker payload: the plan names
 * which evaluator owns the meaning of "changed" (and at which exact version),
 * which outcome-data field is compared across rounds, and how many consecutive
 * `unchanged` comparisons stop the run. Whether this build implements the
 * declared evaluator is a run-path refusal, not an authoring question.
 */
export interface ProgressPolicyV3 {
  /** The comparison semantics identity (e.g. `revision-token`). */
  evaluator: string;
  /** The exact version of that evaluator (positive safe integer). */
  version: number;
  /** The comparison object: the outcome-data field compared across rounds. */
  subject: string;
  /**
   * Consecutive `unchanged` comparisons that stop the run (positive safe
   * integer): the EXPLICIT stopping policy, never inferred from the payload.
   */
  max_unchanged: number;
}

/**
 * A bounded loop over a declared member set.
 *
 * `continuation_outcome` is the outcome that re-enters the loop, and an edge
 * carrying it must stay INSIDE the group; `exit_outcome` is the outcome that
 * leaves it. Both must be declared by a member node, and `max_traversals` is
 * a hard positive cap. A group that leaves any of the three open is a
 * structural defect, not a runtime policy question, so the compiler rejects it.
 *
 * Members are a SET: the plan sorts them by id, because membership — not the
 * order the ids happen to be written in — is what the group declares.
 */
export interface LoopGroupDeclarationV3 {
  /** Unique identifier for this loop group. */
  id: string;
  /** Node IDs that participate in the loop. */
  nodes: string[];
  /** Hard cap on the number of cycle traversals (positive safe integer). */
  max_traversals: number;
  /** The outcome declared by a member that re-enters the loop. */
  continuation_outcome: string;
  /** The outcome declared by a member that leaves the loop. */
  exit_outcome: string;
  /**
   * Optional progress policy: what the loop compares across completed rounds
   * and when repetition stops it. Absent means the loop declares no comparison,
   * so its continuations are bounded by `max_traversals` alone. The declared
   * subject is REQUIRED on every continuation submission once a policy is
   * declared — a submission without it is refused for repair.
   */
  progress?: ProgressPolicyV3;
}

// ── Declaration ─────────────────────────────────────────────────────────────

/**
 * Root declaration of a v3 graph.
 *
 * `version: 3` is the authoring-format tag the compiler checks; it is NOT
 * the storage format, the execution protocol or a contract revision, and it is
 * never compared with those identities
 * (docs/graph-outcome-protocol.md § "Definitions, locations, and comparison
 * owners"). The v2 authoring grammar and the parser/validator/engine path that
 * read it were deleted with the legacy runtime on 2026-09-23; this build reads
 * grammar 3 only.
 */
export interface GraphDeclarationV3 {
  /** Authoring grammar version — always 3 for this type. */
  version: 3;
  /**
   * Human-readable graph name. The compiler uses it as the plan's `graphId`:
   * this grammar carries no separate graph identifier yet, so the name is the
   * only graph identity a declaration provides.
   */
  name: string;
  /** All nodes in the graph, in declaration order (order is not topology). */
  nodes: NodeDeclarationV3[];
  /** Directed control edges; every edge binds an outcome of its source node. */
  edges: EdgeDeclarationV3[];
  /** Bounded-cycle loop groups (optional). */
  loop_groups?: LoopGroupDeclarationV3[];
  /**
   * The completion-policy revision this graph requests for its natural
   * completion mappings.
   *
   * OPTIONAL, because a graph whose nodes all complete explicitly needs no
   * authorization. A node that maps natural completion to an outcome WITHOUT
   * this request cannot be authorized — there is nothing to resolve — so it
   * compiles to a NON-EXECUTABLE DRAFT naming that mapping; it is never
   * silently downgraded to `explicit`, which would change what the author
   * asked for and hide the missing authorization.
   */
  completion_policy?: CompletionPolicyRequestV3;
}

// ── Structural guard ────────────────────────────────────────────────────────

/**
 * Structural guard for a v3 declaration.
 *
 * SHALLOW BY DESIGN, and sound only to the depth it checks: it validates the
 * root shape (`version`, `name`, the `nodes`/`edges` arrays and
 * the optional `loop_groups` array) and each node, edge and loop group at
 * the level the compiler needs in order to read a field safely. The DEEP rules
 * stay in the compiler, which owns their precise diagnostics and their stable
 * codes — a guard that validated everything could only answer "malformed",
 * collapsing "this edge binds no outcome" and "this loop group has no cap" into
 * one opaque failure.
 *
 * Two deliberate omissions, each with its own compiler code:
 * - an edge's `outcome` is NOT required here, so an unbound edge is reported
 *   as `missing-edge-outcome` instead of a generic malformation;
 * - a loop group's `max_traversals`, `continuation_outcome` and
 *   `exit_outcome` are NOT required here, so an open limit or an unknown
 *   route is reported as `loop-group-missing-limits` /
 *   `unknown-loop-*-outcome`.
 *
 * `completion` is checked at the shape level only (a non-null object). The
 * grammar admits one policy object; an array is not one, but it is the shape in
 * which a second natural claim can reach the compiler, which is why the
 * compiler — not this guard — names `duplicate-natural-completion`.
 *
 * The guard only READS properties; `compileGraph` wraps it, so a value that
 * throws while being read becomes a compile error rather than an escape.
 */
export function isGraphDeclarationV3(
  value: unknown,
): value is GraphDeclarationV3 {
  if (!isRecord(value)) return false;
  if (value.version !== 3) return false;
  if (!isNonEmptyString(value.name)) return false;
  if (!Array.isArray(value.nodes) || !value.nodes.every(isNodeDeclarationV3)) {
    return false;
  }
  if (!Array.isArray(value.edges) || !value.edges.every(isEdgeDeclarationV3)) {
    return false;
  }
  if (
    value.loop_groups !== undefined &&
    (!Array.isArray(value.loop_groups) ||
      !value.loop_groups.every(isLoopGroupDeclarationV3))
  ) {
    return false;
  }
  // Shape level only, like every other optional root field: a non-object can
  // never be a policy request, while a record with wrong fields is the
  // compiler's own diagnostic at its own path.
  if (
    value.completion_policy !== undefined &&
    !isObjectContainer(value.completion_policy)
  ) {
    return false;
  }
  return true;
}

/**
 * Shape check for one node. Requires the identity and content fields the
 * compiler reads without a further check; an outcome ELEMENT is deliberately
 * left to the compiler, so a malformed one is reported at its own path instead
 * of failing the whole declaration.
 */
function isNodeDeclarationV3(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (typeof value.agent !== "string") return false;
  if (typeof value.prompt !== "string") return false;
  if (!Array.isArray(value.outcomes)) return false;
  if (value.completion !== undefined && !isObjectContainer(value.completion)) {
    return false;
  }
  if (value.contractRef !== undefined && !isObjectContainer(value.contractRef)) {
    return false;
  }
  if (value.join !== undefined && !isObjectContainer(value.join)) return false;
  if (value.budget !== undefined && !isObjectContainer(value.budget)) {
    return false;
  }
  return true;
}

/**
 * Shape check for one edge. `outcome` is deliberately absent from this list
 * (see the guard doc): the compiler needs to see an unbound edge to name it.
 */
function isEdgeDeclarationV3(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.from)) return false;
  if (!isNonEmptyString(value.to)) return false;
  return true;
}

/**
 * Shape check for one loop group. The traversal cap and the two route outcomes
 * are deliberately absent from this list (see the guard doc): each has its own
 * compiler diagnostic.
 */
function isLoopGroupDeclarationV3(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!Array.isArray(value.nodes)) return false;
  return true;
}

/** Whether a value is a non-null object container (arrays included). */
function isObjectContainer(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

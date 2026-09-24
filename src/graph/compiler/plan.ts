/**
 * Graph Execution Engine v2 — Compiled Plan
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The immutable, content-addressed result of compiling a v3 declaration: what a
 * runtime, a loader or a receipt store pins when it refers to "the plan" of a
 * graph. This module owns the plan SHAPE, its content-addressed
 * `planRevision`, the deep-freeze discipline that makes both durable, and the
 * ONE plan-level invariant inspector every boundary applies — the compiler over
 * its own output and the load gate over the persisted record
 * (docs/graph-outcome-protocol.md § "Concrete durable representation").
 *
 * - `planRevision` is CONTENT-ADDRESSED: the B4 `contractDigest` of the
 *   normalized plan BODY, which is every field except the revision itself. The
 *   same declaration therefore compiles to the same revision, a content change
 *   anywhere in the body changes it, and no second digest implementation
 *   exists.
 * - The plan is DEEPLY frozen: the outer object, every array, every node,
 *   outcome, edge, loop group and contract snapshot, and the snapshot bodies.
 *   There is NO `Map` anywhere in the plan — a frozen object holding a `Map`
 *   is not deeply immutable — so lookups are readonly arrays plus the frozen
 *   `contractSnapshots` index.
 * - `contractSnapshots` is keyed by CONTRACT DIGEST, not by node, and holds
 *   CONTENT only: the plan records each distinct contract CONTENT once, and a
 *   node's binding is its exact `contractRef`, whose digest is that key. A
 *   load-side verifier can therefore recompute the body digest and require the
 *   key an identity resolves to to equal it, instead of trusting a stored ref.
 * - `contractIdentities` is the IDENTITY side of the same contracts:
 *   `id` → `revision` → content digest. Content is deduplicated by digest
 *   while identity stays an explicit index, so two `(id, revision)` identities
 *   whose bodies are byte-identical share one snapshot entry and both resolve
 *   (B8). A single `ref` on the content entry could not express that: it would
 *   have to name one identity and silently drop the other.
 * - `terminalOutcomes` is the EXPLICIT TERMINAL of the plan: every
 *   (node, outcome) pair whose declaring node has NO outbound edge for it, in
 *   canonical order. A graph expresses its exits by this computed list instead
 *   of by the absence of an edge alone, the list is part of the body (so
 *   `planRevision` covers it), and the inspector requires it to be non-empty
 *   and to agree with the edges (B9).
 * - `executability` separates an EXECUTABLE plan from a DRAFT: an executable
 *   plan pins every acceptance requirement to an exact validator version AND
 *   every natural completion to an authorized policy revision, a draft records
 *   which requirements are unresolved and which natural mappings are
 *   unauthorized. The load gate refuses a persisted draft; this module's
 *   inspector accepts both as well-formed plans (B9, extended by D6).
 * - `completionAuthorizations` PINS natural completion (D6): a mapping the
 *   compiler authorized names the exact policy revision whose rule granted it,
 *   and `completionPolicySnapshots` / `completionPolicyIdentities` carry that
 *   revision's CONTENT and IDENTITY inside the plan body — the same
 *   content/identity split the contracts use — so the authorization travels
 *   with the plan and can be verified from the plan alone. The inspector
 *   requires every natural mapping of an executable plan to be pinned, and
 *   every pinned policy to be corroborated by the content and identity the body
 *   carries.
 *
 * Canonicalization is the COMPILER's responsibility (`compile.ts` sorts nodes,
 * edges, loop groups and outcome ids before calling the builder); the builder
 * hashes exactly the body it is given, so a caller that skips that ordering
 * gets the revision of the body it actually passed, not of a re-ordered one.
 *
 * B5 delivered this module COMPILE-ONLY. B7 adds the DURABLE record
 * (`PersistedCompiledPlan`) and the plan-level topology invariant check a load
 * applies when it has only the compiled body (`inspectCompiledTopology`).
 * B8 splits contracts into CONTENT (deduplicated by digest) and IDENTITY (the
 * `contractIdentities` index inside the plan body), so two identities sharing
 * one body are representable and verify; the record SHAPE changes and, because
 * nothing in production writes one yet, no migration is written or required.
 * B9 makes `inspectCompiledTopology` the SINGLE owner of every plan-level
 * invariant — node outcomes, edge references, loop membership and routes,
 * CONTINUATION PATHS, CYCLE CONTAINMENT, EXPLICIT TERMINALS and acceptance
 * PINNING — and puts the compiler's own output under it, so the writer cannot
 * produce a plan its reader would refuse by convention alone.
 * Nothing PRODUCES a record at graph creation yet and nothing consumes one:
 * recovery still resumes from the retained declaration, and the producer, the
 * recovery switch and adapters/schema compatibility are later slices
 * (docs/graph-outcome-protocol.md § "Version ownership and load contract").
 *
 * Dependencies: `contract-definition.ts` (the ONE `contractDigest` and the
 * contract identities), `../cycle-detection.ts` (the ONE Tarjan SCC shared with
 * the v2 validator) plus a TYPE-ONLY import of the shared `JoinConfig` /
 * `NodeBudgetSpec` vocabulary — the same reuse rule the grammar follows, so the
 * plan cannot drift from the runtime's own join and budget shapes. No engine,
 * parser, protocol or loader module is a dependency.
 */

import {
  contractDigest,
  type ContractContentSnapshot,
  type ContractIdentityIndex,
  type ContractRef,
} from "../contracts/contract-definition.ts";
import type { JoinConfig, NodeBudgetSpec } from "../../types.graph-v2.ts";
import {
  isCompletionPolicyRef,
  readCompletionAuthorizationIssueCode,
  readCompletionPolicyBody,
  type CompletionAuthorizationIssueCode,
  type CompletionPolicyBody,
  type CompletionPolicyIdentityIndex,
  type CompletionPolicyRef,
} from "../policy/completion-policy.ts";
import {
  isCyclicComponent,
  stronglyConnectedComponents,
} from "../cycle-detection.ts";

// ── Plan-side declarations ──────────────────────────────────────────────────

/**
 * The data contract of one compiled outcome. Structurally the v3 declaration's
 * `{ schema, version? }`; restated in the plan model so a plan never depends on
 * the authoring grammar module.
 */
export interface CompiledOutcomeData {
  /** Schema identity for the outcome's data payload. */
  readonly schema: string;
  /** Exact schema version, when the schema is versioned. */
  readonly version?: number;
}

/**
 * One acceptance requirement of a compiled outcome.
 *
 * In an EXECUTABLE plan `version` is ALWAYS present: it is the exact capability
 * version compilation RESOLVED, whether the declaration named one or the
 * installed capability supplied it. In a DRAFT it is the version the
 * declaration named, when it named one — the requirement is unresolved and is
 * listed in {@link CompiledPlanBody.executability}. A requirement therefore
 * never silently means "any version" (B9).
 */
export interface CompiledAcceptanceRequirement {
  /** Validator name. */
  readonly validator: string;
  /**
   * Exact validator version. Present on every requirement of an executable
   * plan; optional only while the requirement is unresolved in a draft.
   */
  readonly version?: number;
}

/**
 * One compiled outcome of a node.
 *
 * `acceptance` is ALWAYS present and is an empty array when the declaration
 * omitted it, so a consumer never has to read "absent" and "empty" as two
 * different meanings. Declared order is preserved: acceptance requirements are
 * an ordered gate sequence, not a set.
 */
export interface CompiledOutcome {
  /** Unique outcome id within its node. */
  readonly id: string;
  /** The outcome's data contract, when it declares one. */
  readonly data?: CompiledOutcomeData;
  /** Ordered acceptance gates; empty when the declaration declared none. */
  readonly acceptance: readonly CompiledAcceptanceRequirement[];
}

/**
 * How a compiled node reaches a terminal state. Structurally the v3
 * `CompletionPolicyV3`; restated so the plan model has no grammar dependency.
 *
 * `natural` may produce ONLY the named outcome, whose acceptance requirements
 * still apply. An absent policy (the field is missing) means the declaration
 * left the policy open — the compiler preserves that absence rather than
 * inventing a default.
 */
export type CompiledCompletionPolicy =
  | { readonly mode: "explicit" }
  | { readonly mode: "natural"; readonly outcome: string };

/**
 * One compiled node.
 *
 * `contractRef` is present exactly when the declaration bound a contract AND
 * that contract resolved; the snapshot it names is in
 * `CompiledPlan.contractSnapshots` under `contractRef.digest`. A node without
 * one is legal in this slice — contracts become mandatory for outcome nodes in
 * a later slice, once the load boundary can refuse a missing binding.
 */
export interface CompiledNode {
  /** Unique identifier within the graph. */
  readonly id: string;
  /** Agent identifier (dispatchable subagent name). */
  readonly agent: string;
  /** Prompt text executed by the agent. */
  readonly prompt: string;
  /** The node's outcomes, sorted by id (an outcome set, not a sequence). */
  readonly outcomes: readonly CompiledOutcome[];
  /** The declared completion policy; absent when the declaration left it open. */
  readonly completion?: CompiledCompletionPolicy;
  /** The exact resolved contract revision this node is bound to. */
  readonly contractRef?: ContractRef;
  /** Fan-in strategy (the runtime's own `JoinConfig` vocabulary). */
  readonly join?: JoinConfig;
  /** Per-node resource budget (the runtime's own `NodeBudgetSpec` vocabulary). */
  readonly budget?: NodeBudgetSpec;
}

/**
 * One compiled control edge: an outcome of `from` that routes to `to`.
 *
 * Both endpoints are declared node ids and `outcome` is declared by `from`;
 * the compiler refuses anything else, so a consumer never has to guess what an
 * unbound edge meant.
 */
export interface CompiledEdge {
  /** Source node ID. */
  readonly from: string;
  /** Target node ID. */
  readonly to: string;
  /** The source node's outcome this edge routes on. */
  readonly outcome: string;
}

/**
 * One loop group's declared PROGRESS policy: what a loop compares across
 * completed rounds, and when a run that keeps repeating itself must stop.
 *
 * Every part is DECLARED, never inferred from the worker's payload:
 * - `evaluator` — the comparison SEMANTICS (which evaluator owns the meaning of
 *   "changed"). The run path refuses an identity this build does not implement
 *   rather than comparing under semantics the plan did not declare;
 * - `version` — the EXACT version of that evaluator. A comparison whose
 *   persisted baseline was recorded under another version is `unknown`, never
 *   `unchanged` or `progressed`: the meaning may itself have changed;
 * - `subject` — the comparison OBJECT: the outcome-data field whose value is
 *   read (once, outside the acceptance transaction) and compared as a token;
 * - `maxUnchanged` — the EXPLICIT stagnation threshold: the number of
 *   consecutive `unchanged` comparisons at which the run stops with
 *   `progress-stalled`. It is a declared stopping policy, not a proof that the
 *   underlying task is impossible, and the group's hard `maxTraversals` cap
 *   still applies.
 *
 * The policy lives in the plan body, so `planRevision` covers it and an edited
 * declaration cannot silently change the semantics of an in-flight run.
 */
export interface CompiledProgressPolicy {
  /** The comparison semantics identity. */
  readonly evaluator: string;
  /** The exact evaluator version. */
  readonly version: number;
  /** The comparison object: the outcome-data field compared across rounds. */
  readonly subject: string;
  /** Consecutive `unchanged` comparisons that stop the run. */
  readonly maxUnchanged: number;
}

/**
 * One compiled loop group, with its hard cap, its two declared routes and its
 * optional progress policy.
 *
 * `nodes` is the member SET in id order (membership, not declaration order, is
 * what the group declares). `continuationOutcome` re-enters the loop and
 * `exitOutcome` leaves it; the compiler proved both are declared by a member.
 */
export interface CompiledLoopGroup {
  /** Unique loop group identifier. */
  readonly id: string;
  /** Member node IDs, sorted by id. */
  readonly nodes: readonly string[];
  /** Hard cap on cycle traversals (positive safe integer). */
  readonly maxTraversals: number;
  /** The member outcome that re-enters the loop. */
  readonly continuationOutcome: string;
  /** The member outcome that leaves the loop. */
  readonly exitOutcome: string;
  /**
   * The group's optional progress policy; absent means the loop declares no
   * comparison at all, so its continuations are never measured and the run is
   * bounded by the hard cap alone.
   */
  readonly progress?: CompiledProgressPolicy;
}

/**
 * One explicit terminal: an outcome of a node with NO outbound edge for it.
 *
 * The plan states its exits positively instead of leaving them to be inferred
 * from the absence of an edge. Order is canonical — node id, then outcome id —
 * and the list is part of the plan body, so `planRevision` covers it (B9).
 */
export interface CompiledTerminalOutcome {
  /** The terminating node. */
  readonly nodeId: string;
  /** The outcome the node terminates with. */
  readonly outcome: string;
}

/**
 * One acceptance requirement compilation could not pin to an exact installed
 * validator version. Only a DRAFT carries these; an executable plan has none.
 */
export interface CompiledUnresolvedRequirement {
  /** Node declaring the outcome. */
  readonly nodeId: string;
  /** Outcome carrying the requirement. */
  readonly outcomeId: string;
  /** Validator the requirement names. */
  readonly validator: string;
  /** The exact version the declaration named, when it named one. */
  readonly version?: number;
  /**
   * Why the requirement did not resolve, when the reason is NOT a missing
   * validator identity but a missing CONCRETE capability: the declared data
   * contract's schema is not installed, or no trusted command policy authorizes
   * a check for this graph/node/outcome (A22). Diagnostic text; not a contract.
   */
  readonly reason?: string;
}

/**
 * One natural-completion mapping the compiler AUTHORIZED, pinned to the exact
 * policy revision that granted it (D6).
 *
 * The mapping is the node's own declared one — graph, node and outcome are all
 * exact, and the outcome is the one the node's `completion` policy names.
 * `policy` is content-addressed: the body it names is in
 * {@link CompiledPlanBody.completionPolicySnapshots} under `policy.digest` and
 * its `(id, revision)` entry is in
 * {@link CompiledPlanBody.completionPolicyIdentities}, so the authorization is
 * verifiable from the plan alone.
 */
export interface CompiledCompletionAuthorization {
  /** The node whose natural completion was authorized. */
  readonly nodeId: string;
  /** The exact outcome that node's natural completion maps to. */
  readonly outcome: string;
  /** The exact policy revision whose rule granted the mapping. */
  readonly policy: CompletionPolicyRef;
}

/**
 * One natural-completion mapping compilation could NOT authorize (D6).
 *
 * Only a DRAFT carries these. The mapping is NOT rewritten to `explicit`: the
 * author asked for natural completion and the protocol answers that the
 * authorization is missing or not granted, rather than silently changing what
 * the graph declares. {@link CompiledUnauthorizedCompletion.code} is the
 * stable reason, so a caller never has to parse a message.
 */
export interface CompiledUnauthorizedCompletion {
  /** Node requesting the unauthorized mapping. */
  readonly nodeId: string;
  /** The outcome its natural completion would map to. */
  readonly outcome: string;
  /** The stable reason the mapping is not authorized. */
  readonly code: CompletionAuthorizationIssueCode;
  /** The exact policy revision the declaration requested, when it named one. */
  readonly request?: { readonly id: string; readonly revision: string };
}

/**
 * Whether a compiled plan may be executed.
 *
 * `executable` means every acceptance requirement resolved to an EXACT
 * installed validator version, recorded in the requirement itself, AND every
 * natural-completion mapping is pinned to an authorized policy revision (D6).
 * `draft` means at least one requirement could not be resolved (no capability
 * set was supplied) or at least one natural mapping is unauthorized — the plan
 * is structurally complete but NON-EXECUTABLE and carries what is missing:
 * `unresolved` for acceptance, `unauthorizedCompletions` for natural
 * completion. The distinction lives in the plan body, so `planRevision`
 * covers it, and the load gate refuses a persisted draft instead of treating
 * it as executable (B9).
 */
export type CompiledPlanExecutability =
  | { readonly kind: "executable" }
  | {
      readonly kind: "draft";
      readonly unresolved: readonly CompiledUnresolvedRequirement[];
      readonly unauthorizedCompletions: readonly CompiledUnauthorizedCompletion[];
    };

/**
 * The plan body: everything `planRevision` addresses. The revision is not part
 * of it, which is what makes the body the content and the revision its name.
 */
export interface CompiledPlanBody {
  /**
   * Graph identity. The v3 grammar carries no separate graph identifier yet,
   * so the compiler uses the declaration name — the same string a graph record
   * keys on. A dedicated id field is a later-grammar decision.
   */
  readonly graphId: string;
  /** The authoring grammar this plan was compiled from — always 3. */
  readonly declarationVersion: 3;
  /** Nodes in id order (canonical order is the compiler's contract). */
  readonly nodes: readonly CompiledNode[];
  /** Edges in (from, to, outcome) order. */
  readonly edges: readonly CompiledEdge[];
  /** Loop groups in id order. */
  readonly loopGroups: readonly CompiledLoopGroup[];
  /**
   * The resolved contract CONTENT this plan pins, keyed by its canonical
   * digest. Each distinct body appears once; a node binds one by carrying the
   * exact `contractRef` whose digest is the key. No entry carries an identity:
   * one body can belong to several identities, and the mapping lives in
   * {@link CompiledPlanBody.contractIdentities}.
   */
  readonly contractSnapshots: Readonly<Record<string, ContractContentSnapshot>>;
  /**
   * The contract IDENTITY index this plan pins: `id` → `revision` → the
   * digest of the content that identity resolved to. Every identity the plan
   * bound has exactly one entry (the compiler adds it once and never overwrites
   * another), and every digest it names has a `contractSnapshots` entry whose
   * body hashes to that digest. Two identities may share one digest.
   */
  readonly contractIdentities: ContractIdentityIndex;
  /**
   * The completion-policy CONTENT this plan pins (D6), keyed by the canonical
   * digest of the declaration body. Only policies an authorization actually
   * names appear, and each distinct body appears once; the identity side is
   * {@link CompiledPlanBody.completionPolicyIdentities}. Storing the body in
   * the plan is what makes an authorization checkable WITHOUT the registry that
   * compiled it — a load re-hashes the body instead of trusting a ref.
   */
  readonly completionPolicySnapshots: Readonly<Record<string, CompletionPolicyBody>>;
  /**
   * The completion-policy IDENTITY index this plan pins (D6):
   * `id` → `revision` → the digest of the body the authorization resolved to.
   * One identity has one revision entry (a republished revision is a different
   * digest, and the inspector refuses a disagreement rather than re-binding).
   */
  readonly completionPolicyIdentities: CompletionPolicyIdentityIndex;
  /**
   * Every natural-completion mapping this plan PINNED (D6), in node-id order.
   * An executable plan has one entry per natural mapping and no others; a draft
   * carries only the mappings that were authorized, and names the rest in
   * {@link CompiledPlanExecutability}.
   */
  readonly completionAuthorizations: readonly CompiledCompletionAuthorization[];
  /**
   * The plan's explicit terminal exits (B9): every (node, outcome) pair whose
   * declaring node carries no outbound edge for it, in canonical order. The
   * inspector requires the list to be non-empty and to agree with the edges, so
   * a graph that cannot terminate is refused rather than inferred.
   */
  readonly terminalOutcomes: readonly CompiledTerminalOutcome[];
  /** Whether this plan is executable, or a draft with what is unresolved. */
  readonly executability: CompiledPlanExecutability;
}

/**
 * The immutable compiled plan: the plan body plus the content-addressed
 * revision that names it. Deeply frozen by {@link createCompiledPlan}.
 */
export interface CompiledPlan extends CompiledPlanBody {
  /**
   * Content address of the plan body: `contractDigest` over every other field
   * of this plan. The same body always yields the same revision, and any
   * content change yields a different one.
   */
  readonly planRevision: string;
}

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Build the immutable plan from a normalized body: compute the
 * content-addressed revision, then deeply freeze the result.
 *
 * The builder TAKES OWNERSHIP of the body it is given: it freezes the caller's
 * containers in place rather than deep-copying them (the compiler assembles a
 * fresh body per compilation for exactly this reason, and the freeze is what
 * makes the revision durable — a body that could still move would make its own
 * name a lie). The body is hashed BEFORE it is frozen, so the revision always
 * names the full, un-truncated body.
 *
 * The builder does NOT re-sort or re-validate: canonical order and structural
 * validity are the compiler's contract, so a hand-built body is addressed
 * exactly as given.
 */
export function createCompiledPlan(body: CompiledPlanBody): CompiledPlan {
  const planRevision = contractDigest(body);
  const plan: CompiledPlan = { ...body, planRevision };
  freezeDeep(plan);
  return plan;
}

// ── The durable record (B7) ─────────────────────────────────────────────────

/**
 * The DURABLE form of a compiled plan: the whole in-memory plan — every body
 * field plus the compiler's own `planRevision` — and the explicit node→contract
 * index the B6 plan binding already carries.
 *
 * Nothing is dropped from {@link CompiledPlan}. Every value a plan body holds
 * is JSON data by construction — `contractDigest` refuses anything JSON cannot
 * carry — so the record IS the plan, not a narrower projection a reader would
 * have to reconstruct field by field.
 *
 * `nodeBindings` is not a second source of contract truth: it is DERIVED from
 * `nodes` (each node's `contractRef`) and persisted beside them so a load can
 * compare the plan against a persisted B6 binding entry by entry instead of
 * trusting the two records to agree. The index is deliberately OUTSIDE the
 * plan body, so a disagreement between a node's ref and its index entry does
 * not move `planRevision`; the load verifies the index AS the projection of
 * `nodes` (`verifyPersistedCompiledPlan`) precisely because the revision
 * cannot.
 *
 * The contract IDENTITY index is deliberately NOT a second such side index: it
 * lives inside the plan body (`CompiledPlanBody.contractIdentities`) and is
 * therefore covered by `planRevision`, so one plan pins both the content it
 * resolved and the identity each piece of content belongs to.
 */
export interface PersistedCompiledPlan extends CompiledPlan {
  /** Each bound node's exact contract reference, keyed by node id. */
  readonly nodeBindings: Readonly<Record<string, ContractRef>>;
}

/**
 * Project a compiled plan into its durable record.
 *
 * The revision is CARRIED, never recomputed: it is the compiler's content
 * address, and a producer that recomputed it could sign a body the compiler
 * never built. The LOAD side is what recomputes it — from the persisted body —
 * and refuses a record whose address does not match its content.
 *
 * The result is deeply frozen like the plan it came from, so the record cannot
 * move after its revision names it.
 */
export function createPersistedCompiledPlan(
  plan: CompiledPlan,
): PersistedCompiledPlan {
  const record: PersistedCompiledPlan = {
    ...plan,
    nodeBindings: nodeBindingsOf(plan.nodes),
  };
  freezeDeep(record);
  return record;
}

/**
 * The node→contract index of a plan's nodes: each node carrying a
 * `contractRef` contributes one entry keyed by its node id.
 *
 * Built through `Object.fromEntries` — a data property definition — so a
 * node id such as `__proto__` lands in the record instead of on its prototype.
 * Identity and order come from the nodes, so the index is a projection of the
 * plan, never a claim beside it.
 */
export function nodeBindingsOf(
  nodes: readonly CompiledNode[],
): Record<string, ContractRef> {
  const entries: [string, ContractRef][] = [];
  for (const node of nodes) {
    const ref = node.contractRef;
    if (ref === undefined) continue;
    entries.push([node.id, { ...ref }]);
  }
  return Object.fromEntries(entries);
}

// ── Plan-level invariants (B7; the rule set is B9's) ────────────────────────

/**
 * The plan-level rules a compiled plan must satisfy, in the compiler's own rule
 * vocabulary.
 *
 * This union is a SUBSET of the compiler's `CompileErrorCode`, not a parallel
 * vocabulary: `compile.ts` composes its error union from this type, so one
 * defect has one code on both sides of the pipeline and a new plan-level rule
 * cannot be named twice. The compiler runs this inspector over the body it
 * built and refuses its own output when the inspector rejects it; the load gate
 * runs the same inspector over the persisted body.
 *
 * Rules, each with its stable code:
 * - `malformed-topology` — a body whose nodes, edges, loop groups,
 *   terminalOutcomes or executability are not the records the rules read, so the
 *   rule set cannot be applied at all;
 * - `duplicate-node-id` / `missing-outcomes` — one node id has exactly one
 *   declaration, and a node declares at least one outcome;
 * - `unknown-edge-endpoint` / `unknown-outcome-reference` — every edge
 *   endpoint is a declared node and every edge outcome is declared by its
 *   source;
 * - `unknown-loop-member` / `unknown-loop-continuation-outcome` /
 *   `unknown-loop-exit-outcome` / `loop-group-missing-limits` — loop
 *   membership and both declared routes are real, with a positive traversal
 *   cap, and a declared progress policy is the record the comparison reads;
 * - `loop-continuation-without-edge` — a declared continuation outcome is
 *   carried by at least one edge that stays INSIDE the group, otherwise the
 *   loop can never continue;
 * - `cycle-not-in-loop-group` — every cycle in the compiled edge set lies
 *   inside a declared loop group (the same Tarjan SCC the v2 validator uses,
 *   from the ONE `../cycle-detection.ts` module);
 * - `missing-terminal-outcome` / `terminal-outcomes-inconsistent` — the
 *   plan states its terminal exits explicitly, the list is non-empty, and it is
 *   exactly the set of (node, outcome) pairs no outbound edge binds;
 * - `unpinned-validator-version` — an EXECUTABLE plan pins every acceptance
 *   requirement to an exact validator version. A draft is not held to this
 *   rule; the load gate refuses a draft outright instead.
 * - `missing-completion-authorization` — an EXECUTABLE plan pins every natural
 *   completion mapping to an authorization. A draft is not held to this rule;
 *   its unauthorized mappings are named by its own executability marker.
 * - `unknown-completion-authorization` — a pinned authorization names a
 *   mapping (node + outcome) the topology does not declare as that node's
 *   natural completion, so the plan claims authority it was never granted.
 * - `inconsistent-completion-policy` — a pinned authorization's policy content
 *   does not match the ref it carries: the body under `policy.digest` is
 *   missing or unreadable, does not hash to that digest, or the identity index
 *   maps the `(id, revision)` elsewhere. A ref is a claim the plan body must
 *   prove, never a label to be trusted.
 *
 * Two codes are defensive for the compiler's own output and are normally
 * reached only from the load side: `malformed-topology` and
 * `terminal-outcomes-inconsistent` cannot be produced by a well-formed
 * declaration, because the compiler assembles the body and derives the terminal
 * list itself.
 *
 * The rules the compiler proves that are NOT re-derived from a body —
 * `duplicate-outcome-id`, `natural-completion-unknown-outcome`,
 * `duplicate-natural-completion` and `loop-continuation-outside-group` — are
 * deliberately outside this set: they need the DECLARATION, and a persisted
 * body is checked for the invariants its own content proves.
 */
export type CompiledTopologyIssueCode =
  | "malformed-topology"
  | "duplicate-node-id"
  | "missing-outcomes"
  | "unknown-edge-endpoint"
  | "unknown-outcome-reference"
  | "unknown-loop-member"
  | "unknown-loop-continuation-outcome"
  | "unknown-loop-exit-outcome"
  | "loop-group-missing-limits"
  | "malformed-progress-policy"
  | "loop-continuation-without-edge"
  | "cycle-not-in-loop-group"
  | "missing-terminal-outcome"
  | "terminal-outcomes-inconsistent"
  | "unpinned-validator-version"
  | "missing-completion-authorization"
  | "unknown-completion-authorization"
  | "inconsistent-completion-policy";

/** One plan-topology rule violation. */
export interface CompiledTopologyIssue {
  readonly code: CompiledTopologyIssueCode;
  /** Diagnostic naming the offending node, edge or loop group. */
  readonly message: string;
}

/** What {@link inspectCompiledTopology} found in one plan. */
export interface CompiledTopologyInspection {
  /**
   * Violations in stable order — nodes, then edges, then loop groups, then
   * uncontained cycles, then terminals, then acceptance pinning, then
   * completion authorization.
   */
  readonly issues: readonly CompiledTopologyIssue[];
  /**
   * The node ids the topology declares, in plan order. First declaration wins:
   * a repeated id is an issue and contributes no second entry.
   */
  readonly nodeIds: readonly string[];
}

/**
 * The completion-authorization side of a plan body, as the inspector reads it.
 *
 * A SEPARATE input rather than fields read from `nodes`: the authorization is
 * an index BESIDE the topology (like the contract content/identity indexes),
 * not a property of one node, and keeping it explicit is what lets the caller
 * state truthfully whether the body carries one. OMITTED means "no
 * authorization is present in this body", which is the right default for a
 * caller that passes only a topology: an executable plan with a natural
 * mapping then reports `missing-completion-authorization` rather than passing
 * on an unchecked claim, and a body with no natural mapping is unaffected.
 */
export interface CompiledCompletionTopology {
  /** The plan body's `completionAuthorizations`, as persisted. */
  readonly authorizations: unknown;
  /** The plan body's `completionPolicySnapshots`, as persisted. */
  readonly snapshots: unknown;
  /** The plan body's `completionPolicyIdentities`, as persisted. */
  readonly identities: unknown;
}

/**
 * Check a compiled plan against EVERY plan-level invariant rule.
 *
 * The inputs are the plan body's fields AS PERSISTED, which is why every one of
 * them is `unknown`: a persisted record is untrusted input, so a malformed
 * element becomes a `malformed-topology` issue instead of an exception. The
 * function reads only the fields the rules need and makes no claim about the
 * rest — a node's prompt, budget or contract ref, or extra keys anywhere —
 * because those are covered by the plan's content address, not by a plan-level
 * rule.
 *
 * ONE implementation, applied at both boundaries: `compile.ts` runs it over
 * the body it assembled and refuses its own output when it rejects, and the
 * load gate runs it over the persisted body. The issue codes are the compiler's
 * own vocabulary (see {@link CompiledTopologyIssueCode}).
 *
 * Total for any value whose property reads do not throw; a caller that reads
 * hostile input contains a throwing read itself (the load gate maps it to
 * `corrupt(contract)`).
 */
export function inspectCompiledTopology(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  loopGroups: readonly unknown[],
  terminalOutcomes: unknown,
  executability: unknown,
  completion?: CompiledCompletionTopology,
): CompiledTopologyInspection {
  const issues: CompiledTopologyIssue[] = [];
  const nodeIds: string[] = [];
  const outcomeIdsByNode = new Map<string, ReadonlySet<string>>();
  const acceptanceByOutcome: {
    readonly nodeId: string;
    readonly outcomeId: string;
    readonly acceptance: unknown;
  }[] = [];
  const malformed = (message: string): void => {
    issues.push({ code: "malformed-topology", message });
  };

  nodes.forEach((raw, index) => {
    if (!isPlanRecord(raw) || !isText(raw.id)) {
      malformed(
        `nodes[${index}] is not a compiled node with a non-empty string id`,
      );
      return;
    }
    const nodeId = raw.id;
    if (outcomeIdsByNode.has(nodeId)) {
      issues.push({
        code: "duplicate-node-id",
        message: `node id ${JSON.stringify(nodeId)} is declared more than once in the compiled topology — one node id has exactly one declaration`,
      });
      return;
    }
    nodeIds.push(nodeId);
    const outcomeIds = new Set<string>();
    const rawOutcomes = raw.outcomes;
    if (!Array.isArray(rawOutcomes)) {
      malformed(`node ${JSON.stringify(nodeId)} has no outcomes array`);
    } else if (rawOutcomes.length === 0) {
      // (c) REQUIRED OUTCOMES — the same rule the compiler applies to a
      // declaration, re-derived from the body so a persisted empty list cannot
      // slip past a boundary that only the compiler guarded.
      issues.push({
        code: "missing-outcomes",
        message: `node ${JSON.stringify(nodeId)} declares no outcomes — a compiled node declares at least one`,
      });
    } else {
      rawOutcomes.forEach((outcome, outcomeIndex) => {
        if (!isPlanRecord(outcome) || !isText(outcome.id)) {
          malformed(
            `outcome ${outcomeIndex} of node ${JSON.stringify(nodeId)} has no non-empty string id`,
          );
          return;
        }
        outcomeIds.add(outcome.id);
        acceptanceByOutcome.push({
          nodeId,
          outcomeId: outcome.id,
          acceptance: outcome.acceptance,
        });
      });
    }
    outcomeIdsByNode.set(nodeId, outcomeIds);
  });
  const declaredNodeIds = new Set(nodeIds);

  const readableEdges: { from: string; to: string; outcome: string }[] = [];
  edges.forEach((raw, index) => {
    if (
      !isPlanRecord(raw) ||
      !isText(raw.from) ||
      !isText(raw.to) ||
      !isText(raw.outcome)
    ) {
      malformed(
        `edges[${index}] is not a compiled edge { from, to, outcome } of non-empty strings`,
      );
      return;
    }
    const { from, to, outcome } = raw;
    readableEdges.push({ from, to, outcome });
    const unknownEndpoints = [
      declaredNodeIds.has(from) ? "" : `from ${JSON.stringify(from)}`,
      declaredNodeIds.has(to) ? "" : `to ${JSON.stringify(to)}`,
    ]
      .filter((part) => part.length > 0)
      .join(" and ");
    if (unknownEndpoints.length > 0) {
      issues.push({
        code: "unknown-edge-endpoint",
        message: `edge from ${JSON.stringify(from)} to ${JSON.stringify(to)} names an undeclared ${unknownEndpoints}`,
      });
    }
    // Only a DECLARED source can be asked which outcomes it declares — the
    // compiler's own rule (an unknown endpoint is reported, not its outcome).
    if (
      declaredNodeIds.has(from) &&
      !(outcomeIdsByNode.get(from)?.has(outcome) ?? false)
    ) {
      issues.push({
        code: "unknown-outcome-reference",
        message: `edge from ${JSON.stringify(from)} to ${JSON.stringify(to)} binds outcome ${JSON.stringify(outcome)}, which source node ${JSON.stringify(from)} does not declare`,
      });
    }
  });

  /** Every node a declared loop group covers — the containment set. */
  const loopMembers = new Set<string>();

  loopGroups.forEach((raw, index) => {
    if (
      !isPlanRecord(raw) ||
      !isText(raw.id) ||
      !Array.isArray(raw.nodes) ||
      !isText(raw.continuationOutcome) ||
      !isText(raw.exitOutcome)
    ) {
      malformed(
        `loopGroups[${index}] is not a compiled loop group { id, nodes, maxTraversals, continuationOutcome, exitOutcome }`,
      );
      return;
    }
    const groupId = raw.id;
    if (!isPositiveSafeInteger(raw.maxTraversals)) {
      issues.push({
        code: "loop-group-missing-limits",
        message: `loop group ${JSON.stringify(groupId)} needs maxTraversals as a positive safe integer, received ${describeTopologyValue(raw.maxTraversals)}`,
      });
    }
    if (raw.progress !== undefined && readCompiledProgressPolicy(raw.progress) === undefined) {
      issues.push({
        code: "malformed-progress-policy",
        message: `loop group ${JSON.stringify(groupId)} declares a progress policy that is not { evaluator, version, subject, maxUnchanged } with non-empty ids, an exact version and a positive threshold`,
      });
    }
    const memberIds: string[] = [];
    const memberSet = new Set<string>();
    raw.nodes.forEach((member, memberIndex) => {
      if (!isText(member)) {
        malformed(
          `loopGroups[${index}].nodes[${memberIndex}] is not a non-empty node id`,
        );
        return;
      }
      if (!declaredNodeIds.has(member)) {
        issues.push({
          code: "unknown-loop-member",
          message: `loop group ${JSON.stringify(groupId)} names ${JSON.stringify(member)} as a member, which is not a topology node id`,
        });
        return;
      }
      if (!memberSet.has(member)) {
        memberSet.add(member);
        memberIds.push(member);
        loopMembers.add(member);
      }
    });
    const routes: readonly [string, string, CompiledTopologyIssueCode][] = [
      ["continuation", raw.continuationOutcome, "unknown-loop-continuation-outcome"],
      ["exit", raw.exitOutcome, "unknown-loop-exit-outcome"],
    ];
    for (const [route, outcome, code] of routes) {
      const declared = memberIds.some((member) =>
        outcomeIdsByNode.get(member)?.has(outcome) ?? false,
      );
      if (!declared) {
        issues.push({
          code,
          message: `loop group ${JSON.stringify(groupId)} declares ${route} outcome ${JSON.stringify(outcome)}, which none of its member nodes declare`,
        });
      }
      // (b) CONTINUATION PATH — a loop that declares how it continues must
      // actually have an edge carrying that outcome from a member to a member.
      // Checked only once the route is a real member outcome, so a bogus route
      // is reported once (as unknown-loop-continuation-outcome) rather than
      // cascading into a second issue.
      if (route === "continuation" && declared) {
        const carries = readableEdges.some(
          (edge) =>
            edge.outcome === outcome &&
            memberSet.has(edge.from) &&
            memberSet.has(edge.to),
        );
        if (!carries) {
          issues.push({
            code: "loop-continuation-without-edge",
            message: `loop group ${JSON.stringify(groupId)} declares continuation outcome ${JSON.stringify(outcome)}, but no edge carries it from one member to another — the loop can never continue`,
          });
        }
      }
    }
  });

  // (a) CYCLE CONTAINMENT — every cycle in the compiled edge set must lie
  // inside a declared loop group. The SCC computation is the SAME ONE the v2
  // validator uses (`../cycle-detection.ts`, imported), so the tree holds one
  // cycle semantics. Only edges between declared nodes are considered: an edge
  // with an undeclared endpoint is already reported above and cannot be part of
  // a contained cycle.
  const cycleEdges = readableEdges.filter(
    (edge) => declaredNodeIds.has(edge.from) && declaredNodeIds.has(edge.to),
  );
  const { components, selfLoop } = stronglyConnectedComponents(cycleEdges);
  const uncontained: string[][] = [];
  for (const component of components.values()) {
    if (!isCyclicComponent(component, selfLoop)) continue;
    if (component.every((nodeId) => loopMembers.has(nodeId))) continue;
    uncontained.push([...component].sort(compareText));
  }
  // Canonical order: sort the components by their sorted member lists, so a
  // reordered edge declaration cannot reorder these diagnostics.
  uncontained.sort((a, b) => compareText(a.join("\u0000"), b.join("\u0000")));
  for (const component of uncontained) {
    issues.push({
      code: "cycle-not-in-loop-group",
      message: `cycle involving node(s) [${component.join(", ")}] is not contained in any declared loop group`,
    });
  }

  // (d) EXPLICIT TERMINAL — the plan states its exits positively. The list is
  // DERIVED here with the same helper the compiler computes it with, so the
  // rule has one implementation for the writer and the reader.
  const derivedTerminals = terminalOutcomesOf(nodes, edges);
  const declaredTerminals = readTerminalOutcomeList(terminalOutcomes);
  if (derivedTerminals.length === 0) {
    issues.push({
      code: "missing-terminal-outcome",
      message:
        "every declared outcome is bound by an edge from its declaring node, so the plan declares no terminal exit — a graph must state how it terminates",
    });
  }
  if (declaredTerminals === null) {
    issues.push({
      code: "terminal-outcomes-inconsistent",
      message:
        "terminalOutcomes is not an array of { nodeId, outcome } records of non-empty strings",
    });
  } else if (!sameTerminalOutcomes(derivedTerminals, declaredTerminals)) {
    issues.push({
      code: "terminal-outcomes-inconsistent",
      message: `terminalOutcomes does not agree with the edges: the edges imply [${describeTerminalOutcomes(derivedTerminals)}], the plan declares [${describeTerminalOutcomes(declaredTerminals)}]`,
    });
  }

  // ACCEPTANCE PINNING — an executable plan names an exact validator version
  // for every acceptance requirement, so a plan can never LOOK executable
  // while carrying an unresolved gate. A draft is not held to this rule; the
  // load gate refuses it outright.
  const executabilityReading = readPlanExecutability(executability);
  if (executabilityReading.kind === "malformed") {
    malformed(
      'executability is not { kind: "executable" } or { kind: "draft", unresolved: [...] }',
    );
  } else if (executabilityReading.kind === "executable") {
    for (const entry of acceptanceByOutcome) {
      if (!Array.isArray(entry.acceptance)) {
        malformed(
          `outcome ${JSON.stringify(entry.outcomeId)} of node ${JSON.stringify(entry.nodeId)} has no acceptance array`,
        );
        continue;
      }
      entry.acceptance.forEach((requirement, requirementIndex) => {
        if (
          isPlanRecord(requirement) &&
          isText(requirement.validator) &&
          isFiniteNumber(requirement.version)
        ) {
          return;
        }
        issues.push({
          code: "unpinned-validator-version",
          message: `executable plan acceptance requirement ${requirementIndex} of outcome ${JSON.stringify(entry.outcomeId)} on node ${JSON.stringify(entry.nodeId)} is not pinned to an exact validator version`,
        });
      });
    }
  }

  // COMPLETION AUTHORIZATION (D6) — an executable plan's every natural mapping
  // is pinned to an exact policy revision whose CONTENT the plan body carries.
  // A pinned authorization is checked whatever the executability is (authority
  // the body cannot prove is a defect in a draft too), while completeness is
  // required only of an executable plan: a draft exists precisely because some
  // mapping could not be authorized.
  const naturalOutcomes = new Map<string, string>();
  for (const raw of nodes) {
    if (!isPlanRecord(raw) || !isText(raw.id)) continue;
    const completion = raw.completion;
    if (!isPlanRecord(completion) || completion.mode !== "natural") continue;
    if (!isText(completion.outcome)) continue;
    naturalOutcomes.set(raw.id, completion.outcome);
  }
  const rawAuthorizations = completion?.authorizations ?? [];
  if (!Array.isArray(rawAuthorizations)) {
    malformed(
      "completionAuthorizations is not an array of { nodeId, outcome, policy } records",
    );
  } else {
    const rawSnapshots = completion?.snapshots ?? {};
    const rawIdentities = completion?.identities ?? {};
    if (!isPlanRecord(rawSnapshots)) {
      malformed("completionPolicySnapshots is not a digest-keyed record");
    }
    if (!isPlanRecord(rawIdentities)) {
      malformed(
        "completionPolicyIdentities is not a policy id → revision → digest record",
      );
    }
    const authorizedPairs = new Set<string>();
    for (const raw of rawAuthorizations) {
      if (
        !isPlanRecord(raw) ||
        !isText(raw.nodeId) ||
        !isText(raw.outcome)
      ) {
        malformed(
          "a completion authorization is not { nodeId, outcome, policy } of non-empty strings",
        );
        continue;
      }
      const nodeId = raw.nodeId;
      const outcome = raw.outcome;
      const policy = raw.policy;
      if (!isCompletionPolicyRef(policy)) {
        malformed(
          `completion authorization of node ${JSON.stringify(nodeId)} is not pinned to a policy ref { id, revision, digest } of non-empty strings`,
        );
        continue;
      }
      const pair = terminalPairKey(nodeId, outcome);
      if (authorizedPairs.has(pair)) {
        malformed(
          `completion authorization for outcome ${JSON.stringify(outcome)} of node ${JSON.stringify(nodeId)} appears more than once — one mapping has one pinned authorization`,
        );
        continue;
      }
      authorizedPairs.add(pair);
      if (naturalOutcomes.get(nodeId) !== outcome) {
        issues.push({
          code: "unknown-completion-authorization",
          message: `plan pins an authorization for outcome ${JSON.stringify(outcome)} of node ${JSON.stringify(nodeId)}, which the topology does not declare as that node's natural completion`,
        });
      }
      const snapshot =
        isPlanRecord(rawSnapshots)
          ? ownValue(rawSnapshots, policy.digest)
          : undefined;
      const body = readCompletionPolicyBody(snapshot);
      if (body === undefined) {
        issues.push({
          code: "inconsistent-completion-policy",
          message: `completion authorization of node ${JSON.stringify(nodeId)} pins policy ${describeCompletionPolicyRef(policy)} at digest ${policy.digest}, but completionPolicySnapshots carries no readable declaration body under that digest`,
        });
      } else {
        let actual: string | undefined;
        try {
          actual = contractDigest(body);
        } catch {
          actual = undefined;
        }
        if (actual !== policy.digest) {
          issues.push({
            code: "inconsistent-completion-policy",
            message: `completion policy ${describeCompletionPolicyRef(policy)} is pinned at digest ${policy.digest}, but the body in completionPolicySnapshots hashes to ${String(actual)}`,
          });
        }
      }
      const revisions = isPlanRecord(rawIdentities)
        ? ownValue(rawIdentities, policy.id)
        : undefined;
      const identityDigest = isPlanRecord(revisions)
        ? ownValue(revisions, policy.revision)
        : undefined;
      if (identityDigest !== policy.digest) {
        issues.push({
          code: "inconsistent-completion-policy",
          message: `completion policy ${describeCompletionPolicyRef(policy)} is pinned at digest ${policy.digest}, but completionPolicyIdentities maps it to ${String(identityDigest)}`,
        });
      }
    }
    if (executabilityReading.kind === "executable") {
      for (const [nodeId, outcome] of [...naturalOutcomes].sort(([a], [b]) =>
        compareText(a, b),
      )) {
        if (authorizedPairs.has(terminalPairKey(nodeId, outcome))) continue;
        issues.push({
          code: "missing-completion-authorization",
          message: `executable plan node ${JSON.stringify(nodeId)} maps natural completion to outcome ${JSON.stringify(outcome)}, but the plan pins no authorized completion policy for that mapping`,
        });
      }
    }
  }

  return { issues, nodeIds };
}

/**
 * Read one progress policy as the plan defines it, or `undefined` when the
 * value is not one.
 *
 * ONE reader for the inspector and for any boundary that has to compare a
 * persisted value against the declaration: a policy is a record of
 * `{ evaluator, version, subject, maxUnchanged }` whose ids are non-empty
 * strings, whose version is a positive safe integer and whose threshold is a
 * positive safe integer. Extra keys are ignored, exactly as the rest of the
 * plan-level rules ignore fields they do not read (the plan's content address
 * covers them).
 */
export function readCompiledProgressPolicy(
  raw: unknown,
): CompiledProgressPolicy | undefined {
  if (!isPlanRecord(raw)) return undefined;
  const { evaluator, version, subject, maxUnchanged } = raw;
  if (!isText(evaluator)) return undefined;
  if (!isPositiveSafeInteger(version)) return undefined;
  if (!isText(subject)) return undefined;
  if (!isPositiveSafeInteger(maxUnchanged)) return undefined;
  return Object.freeze({ evaluator, version, subject, maxUnchanged });
}

/**
 * The explicit terminals a topology implies: every outcome of every node that no
 * edge FROM that node binds, in canonical (node id, outcome id) order.
 *
 * ONE derivation, used by the compiler to compute the plan body and by
 * {@link inspectCompiledTopology} to check it, so the writer and the reader
 * cannot disagree about what "terminal" means. Total over any readable
 * topology: unreadable elements contribute nothing.
 */
export function terminalOutcomesOf(
  nodes: readonly unknown[],
  edges: readonly unknown[],
): CompiledTerminalOutcome[] {
  const bound = new Set<string>();
  for (const raw of edges) {
    if (!isPlanRecord(raw)) continue;
    const { from, outcome } = raw;
    if (!isText(from) || !isText(outcome)) continue;
    bound.add(terminalPairKey(from, outcome));
  }
  const terminals: CompiledTerminalOutcome[] = [];
  const seen = new Set<string>();
  for (const raw of nodes) {
    if (!isPlanRecord(raw) || !isText(raw.id)) continue;
    const outcomeIds = new Set<string>();
    const rawOutcomes = raw.outcomes;
    if (!Array.isArray(rawOutcomes)) continue;
    for (const outcome of rawOutcomes) {
      if (isPlanRecord(outcome) && isText(outcome.id)) outcomeIds.add(outcome.id);
    }
    for (const outcomeId of [...outcomeIds].sort(compareText)) {
      const key = terminalPairKey(raw.id, outcomeId);
      if (bound.has(key) || seen.has(key)) continue;
      seen.add(key);
      terminals.push({ nodeId: raw.id, outcome: outcomeId });
    }
  }
  terminals.sort(compareTerminalOutcomes);
  return terminals;
}

/** The flat key of one (node, outcome) pair; NUL cannot occur in either id. */
function terminalPairKey(nodeId: string, outcome: string): string {
  return `${nodeId}\u0000${outcome}`;
}

/** Canonical terminal order: node id, then outcome id. */
function compareTerminalOutcomes(
  a: CompiledTerminalOutcome,
  b: CompiledTerminalOutcome,
): number {
  return compareText(a.nodeId, b.nodeId) || compareText(a.outcome, b.outcome);
}

/** Read a declared terminal list, or `null` when it is not a readable list. */
function readTerminalOutcomeList(
  raw: unknown,
): CompiledTerminalOutcome[] | null {
  if (!Array.isArray(raw)) return null;
  const list: CompiledTerminalOutcome[] = [];
  for (const element of raw) {
    if (
      !isPlanRecord(element) ||
      !isText(element.nodeId) ||
      !isText(element.outcome)
    ) {
      return null;
    }
    list.push({ nodeId: element.nodeId, outcome: element.outcome });
  }
  return list;
}

/** Whether a declared terminal list is exactly the set the edges imply. */
function sameTerminalOutcomes(
  derived: readonly CompiledTerminalOutcome[],
  declared: readonly CompiledTerminalOutcome[],
): boolean {
  if (derived.length !== declared.length) return false;
  const sorted = [...declared].sort(compareTerminalOutcomes);
  return derived.every((entry, index) => {
    const other = sorted[index];
    return (
      other !== undefined &&
      entry.nodeId === other.nodeId &&
      entry.outcome === other.outcome
    );
  });
}

/** Describe a terminal list for a diagnostic without ever throwing. */
function describeTerminalOutcomes(
  entries: readonly CompiledTerminalOutcome[],
): string {
  if (entries.length === 0) return "none";
  return entries
    .map((entry) => `${JSON.stringify(entry.nodeId)}.${JSON.stringify(entry.outcome)}`)
    .join(", ");
}

/**
 * The stable code a load reports when it refuses a non-executable plan record.
 *
 * Defined here, next to the field it describes, so the compiler's draft marker,
 * the inspector's shape rule and the load gate's refusal all name one thing.
 */
export const NON_EXECUTABLE_PLAN_CODE = "plan-not-executable" as const;

/** What a plan's `executability` field reads as. */
export type PlanExecutabilityReading =
  | { readonly kind: "executable" }
  | { readonly kind: "draft" }
  | { readonly kind: "malformed" };

/**
 * Read a plan's `executability` field.
 *
 * ONE reader for the inspector and the load gate: the inspector turns
 * `malformed` into `malformed-topology` and holds an executable plan to the
 * pinning rules, while the load gate refuses anything that is not
 * `executable` — a draft by `NON_EXECUTABLE_PLAN_CODE`, a malformed value as a
 * malformed record. The draft arm is read in full: both reason lists must be
 * present, at least one must be non-empty, every acceptance entry is shape-
 * checked as before, and every unauthorized completion is shape-checked AND
 * must carry one of the closed authorization issue codes, so a persisted
 * reason this build does not define is refused instead of read with an
 * invented meaning.
 */
export function readPlanExecutability(
  raw: unknown,
): PlanExecutabilityReading {
  if (!isPlanRecord(raw)) return { kind: "malformed" };
  const kind = raw.kind;
  if (kind === "executable") return { kind: "executable" };
  if (kind !== "draft") return { kind: "malformed" };
  const unresolved = raw.unresolved;
  const unauthorizedCompletions = raw.unauthorizedCompletions;
  if (!Array.isArray(unresolved) || !Array.isArray(unauthorizedCompletions)) {
    return { kind: "malformed" };
  }
  // A draft names at least one reason. A draft with BOTH lists empty would
  // claim non-executability without saying why, which no compiler produces and
  // no reader can act on.
  if (unresolved.length === 0 && unauthorizedCompletions.length === 0) {
    return { kind: "malformed" };
  }
  for (const entry of unresolved) {
    if (
      !isPlanRecord(entry) ||
      !isText(entry.nodeId) ||
      !isText(entry.outcomeId) ||
      !isText(entry.validator)
    ) {
      return { kind: "malformed" };
    }
    const version = entry.version;
    if (version !== undefined && !isFiniteNumber(version)) {
      return { kind: "malformed" };
    }
  }
  for (const entry of unauthorizedCompletions) {
    if (!isPlanRecord(entry) || !isText(entry.nodeId) || !isText(entry.outcome)) {
      return { kind: "malformed" };
    }
    // The reason vocabulary is CLOSED, exactly as the stop and progress
    // vocabularies are: a persisted reason this build does not define is
    // refused rather than read with a meaning its writer never had.
    if (readCompletionAuthorizationIssueCode(entry.code) === undefined) {
      return { kind: "malformed" };
    }
    const request = entry.request;
    if (request !== undefined) {
      if (
        !isPlanRecord(request) ||
        !isText(request.id) ||
        !isText(request.revision)
      ) {
        return { kind: "malformed" };
      }
    }
  }
  return { kind: "draft" };
}

/** A pinned policy ref as a diagnostic token: `"id"@"revision"`. */
function describeCompletionPolicyRef(ref: CompletionPolicyRef): string {
  return JSON.stringify(ref.id) + "@" + JSON.stringify(ref.revision);
}

/**
 * Read one own data property of a record, or `undefined`.
 *
 * OWN properties only: a digest or identity key such as `__proto__` must name
 * a missing entry rather than an inherited one, so a persisted index can never
 * corroborate a ref through the prototype chain.
 */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/** UTF-16 code-unit order: locale-independent, so ids sort the same everywhere. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Whether a value is a finite number (the canonical digest can represent it). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether a value is a non-null object (a persisted record member). */
function isPlanRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string (the only id shape a plan has). */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a value is a positive safe integer (a traversal cap). */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Describe a rejected traversal cap for a diagnostic without throwing. */
function describeTopologyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/**
 * Freeze a plan value in place, all the way down.
 *
 * Every container in a plan is one of: the plan object, an array, a node,
 * outcome, completion policy, data contract, acceptance requirement, edge, loop
 * group, ref, snapshot or snapshot body — all plain objects and arrays, and all
 * acyclic (the compiler resolved every contract through `contractDigest`,
 * which rejects a cycle before a snapshot can enter the plan). Freezing does
 * not stop at an already-frozen object: a caller-supplied snapshot that was
 * frozen only at its top level would otherwise leave its body editable, and the
 * body is exactly what the digest claims.
 */
function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return;
  }
  for (const key of Object.keys(value)) {
    freezeDeep((value as Record<string, unknown>)[key]);
  }
}

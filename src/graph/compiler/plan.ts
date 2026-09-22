/**
 * Graph Execution Engine v2 — Compiled Plan
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The immutable, content-addressed result of compiling a v3 declaration: what a
 * runtime, a loader or a receipt store pins when it refers to "the plan" of a
 * graph. This module owns the plan SHAPE, its content-addressed
 * `planRevision`, and the deep-freeze discipline that makes both durable
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
 * - `contractSnapshots` is keyed by CONTRACT DIGEST, not by node: the plan
 *   records each distinct contract CONTENT once, and a node's binding is its
 *   exact `contractRef`, whose digest is that key. A load-side verifier can
 *   therefore recompute the body digest and compare it with the ref instead of
 *   trusting either one.
 *
 * Canonicalization is the COMPILER's responsibility (`compile.ts` sorts nodes,
 * edges, loop groups and outcome ids before calling the builder); the builder
 * hashes exactly the body it is given, so a caller that skips that ordering
 * gets the revision of the body it actually passed, not of a re-ordered one.
 *
 * B5 delivered this module COMPILE-ONLY. B7 adds the DURABLE record
 * (`PersistedCompiledPlan`) and the plan-level topology invariant check a load
 * applies when it has only the compiled body (`inspectCompiledTopology`).
 * Nothing PRODUCES a record at graph creation yet and nothing consumes one:
 * recovery still resumes from the retained declaration, and the producer, the
 * recovery switch and adapters/schema compatibility are later slices
 * (docs/graph-outcome-protocol.md § "Version ownership and load contract").
 *
 * Dependencies: `contract-definition.ts` (the ONE `contractDigest` and the
 * contract identities) plus a TYPE-ONLY import of the shared `JoinConfig` /
 * `NodeBudgetSpec` vocabulary — the same reuse rule the grammar follows, so the
 * plan cannot drift from the runtime's own join and budget shapes, and the
 * import adds no runtime dependency at all. No engine, parser, protocol or
 * loader module is a dependency.
 */

import {
  contractDigest,
  type ContractRef,
  type ContractSnapshot,
} from "../contracts/contract-definition.ts";
import type { JoinConfig, NodeBudgetSpec } from "../../types.graph-v2.ts";

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
 * A bare requirement (no version) means "any installed version of this
 * validator"; a versioned requirement names exactly one capability.
 */
export interface CompiledAcceptanceRequirement {
  /** Validator name. */
  readonly validator: string;
  /** Exact validator version, when the requirement names one. */
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
 * One compiled loop group, with its hard cap and its two declared routes.
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
}

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
   * The resolved contract snapshots this plan pins, keyed by their content
   * digest. Each distinct contract CONTENT appears once; a node binds one by
   * carrying the exact `contractRef` whose digest is the key.
   */
  readonly contractSnapshots: Readonly<Record<string, ContractSnapshot>>;
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

// ── Plan-level topology invariants (B7) ─────────────────────────────────────

/**
 * The plan-level rules a persisted topology must satisfy, in the compiler's own
 * rule vocabulary.
 *
 * `compile.ts` refuses the equivalent DECLARATION-level defects before it
 * builds a body — `duplicate-node-id`, `unknown-edge-endpoint`,
 * `unknown-outcome-reference`, `unknown-loop-member`,
 * `unknown-loop-continuation-outcome`, `unknown-loop-exit-outcome` and
 * `loop-group-missing-limits` — so a compiler-produced body satisfies every
 * rule here by construction. A LOAD has only the body, so the plan-level rule
 * is stated once, here next to the shape it protects, rather than re-derived
 * from a declaration that may not be recompilable. `malformed-topology` is the
 * shape-level member: a body whose nodes, edges or loop groups are not the
 * records the rules read cannot be checked at all.
 *
 * COMPLETENESS IS NOT CLAIMED. The rules here are the ones the compiler proves
 * that a load can re-derive from the body; node-level rules it also enforces —
 * `missing-outcomes`, `duplicate-outcome-id`,
 * `natural-completion-unknown-outcome` — and
 * `loop-continuation-outside-group` are NOT re-derived, so this check is not a
 * full plan validator. A consumer that makes the plan authoritative must
 * extend it rather than read it as one.
 */
export type CompiledTopologyIssueCode =
  | "malformed-topology"
  | "duplicate-node-id"
  | "unknown-edge-endpoint"
  | "unknown-outcome-reference"
  | "unknown-loop-member"
  | "unknown-loop-continuation-outcome"
  | "unknown-loop-exit-outcome"
  | "loop-group-missing-limits";

/** One plan-topology rule violation. */
export interface CompiledTopologyIssue {
  readonly code: CompiledTopologyIssueCode;
  /** Diagnostic naming the offending node, edge or loop group. */
  readonly message: string;
}

/** What {@link inspectCompiledTopology} found in one plan body's topology. */
export interface CompiledTopologyInspection {
  /** Violations in stable order — nodes, then edges, then loop groups. */
  readonly issues: readonly CompiledTopologyIssue[];
  /**
   * The node ids the topology declares, in plan order. First declaration wins:
   * a repeated id is an issue and contributes no second entry.
   */
  readonly nodeIds: readonly string[];
}

/**
 * Check a compiled plan's topology against the rules the compiler guarantees.
 *
 * The three inputs are the plan body's topology fields AS PERSISTED, with
 * `unknown` element types on purpose: a persisted record is untrusted input,
 * so a malformed element becomes a `malformed-topology` issue instead of an
 * exception. The function reads only the fields the rules need and makes no
 * claim about the rest — a node's prompt, budget or contract ref, or extra
 * keys anywhere — because those are covered by the plan's content address, not
 * by a topology rule.
 *
 * Total for any value whose property reads do not throw; the load gate that
 * calls it contains a hostile read as `corrupt(contract)`.
 */
export function inspectCompiledTopology(
  nodes: readonly unknown[],
  edges: readonly unknown[],
  loopGroups: readonly unknown[],
): CompiledTopologyInspection {
  const issues: CompiledTopologyIssue[] = [];
  const nodeIds: string[] = [];
  const outcomeIdsByNode = new Map<string, ReadonlySet<string>>();
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
    } else {
      rawOutcomes.forEach((outcome, outcomeIndex) => {
        if (!isPlanRecord(outcome) || !isText(outcome.id)) {
          malformed(
            `outcome ${outcomeIndex} of node ${JSON.stringify(nodeId)} has no non-empty string id`,
          );
          return;
        }
        outcomeIds.add(outcome.id);
      });
    }
    outcomeIdsByNode.set(nodeId, outcomeIds);
  });
  const declaredNodeIds = new Set(nodeIds);

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
    const memberIds: string[] = [];
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
      memberIds.push(member);
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
    }
  });

  return { issues, nodeIds };
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

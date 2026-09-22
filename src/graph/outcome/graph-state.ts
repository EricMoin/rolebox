/**
 * Graph Execution Engine v2 — Outcome-protocol graph state (C3b)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The STATE half of the outcome run path (docs/graph-outcome-protocol.md
 * § "State, storage, and effects"): a deterministic model of an
 * outcome-protocol graph's progress, the strict reader that turns a persisted
 * `GraphStateRecord` back into it, and the PURE reducer that advances it from
 * one ACCEPTED outcome.
 *
 * THE STATE IS A VALUE, NOT A LOG. It answers exactly three questions — which
 * nodes have been dispatched, what attempt each is on, and which terminal
 * outcome settled the run — and nothing else. Business payloads, evidence and
 * validator results are deliberately NOT stored here: the receipt and the
 * accepted event are the durable record of what was accepted, and the protocol
 * bounds diagnostic retention rather than keeping sensitive raw data.
 *
 * THE CYCLE RULE. Every cycle in a compiled plan lies inside a declared loop
 * group (the compiler proves it). Re-entering a node that already settled is
 * therefore legal exactly when the edge stays inside one declared loop group:
 * an edge whose endpoints share a group is a loop path, and an edge that leaves
 * the group is the loop's exit. A settled target outside the source's group is
 * refused rather than silently reset, and the declared `continuationOutcome` is
 * what advances the group's bounded traversal counter — a cap that would be
 * exceeded refuses the whole acceptance instead of running one round past it.
 * A node may belong to SEVERAL declared loop groups, so the groups a
 * continuation advances are selected by DECLARATION — the groups that declare
 * this outcome as their continuation and contain the emitting node — never by
 * position: selecting the first group that merely contains the node can select a
 * group this outcome is not the continuation of, leaving the loop that was
 * actually re-entered unbounded. Every selected group advances, and any cap that
 * would be exceeded refuses.
 *
 * ATTEMPT IDENTITY. Attempt ids are minted HERE, from a graph-wide counter the
 * state carries, never supplied by a worker: `<nodeId>#<seq>`. A settled node
 * keeps the attempt that settled it, so a repeated submission derives the SAME
 * execution identity and replays the persisted decision instead of settling a
 * second time.
 *
 * READING IS STRICT AND TOTAL. `readOutcomeGraphState` accepts exactly the
 * shape this module's writer produces — the plan's node set in plan order, the
 * closed status vocabulary, attempt ids and counters where they are required,
 * and no unknown loop group — and refuses anything else with an
 * {@link OutcomeStateError}. A state this build cannot read is NEVER reset to a
 * clean start: the same "unknown is not fresh" discipline the storage and
 * protocol gates apply.
 *
 * Dependency leaf on the outcome side: the compiler's plan TYPES, the ledger's
 * record TYPE and the acceptance core's decision type, all type-only, so the
 * reducer can be tested without a ledger and the runtime can own the wiring.
 */

import type { CompiledNode, CompiledPlan } from "../compiler/plan.ts";
import type { GraphStateRecord } from "../ledger/types.ts";
import type { AcceptanceDecision } from "./acceptance.ts";

// ── The state model ─────────────────────────────────────────────────────────

/**
 * One node's lifecycle in an outcome-protocol run.
 *
 * - `pending` — declared by the plan, never dispatched. A node on a branch the
 *   run never takes stays here, which is why `pending` does NOT block
 *   completion.
 * - `dispatched` — an attempt is in flight and its outcome may be submitted.
 * - `settled` — an accepted terminal outcome ended this node's participation.
 */
export type OutcomeNodeStatus = "pending" | "dispatched" | "settled";

/** One node's persisted progress. */
export interface OutcomeNodeState {
  /** The plan node this progress belongs to. */
  readonly nodeId: string;
  readonly status: OutcomeNodeStatus;
  /**
   * The attempt this node's current (or settling) execution belongs to.
   * Present exactly when the node has been dispatched at least once: a
   * `pending` node has no attempt, and a `settled` node keeps the attempt that
   * settled it so a repeated submission can be bound to the SAME execution
   * identity.
   */
  readonly attemptId?: string;
  /** The graph-wide sequence number that minted {@link attemptId}. */
  readonly attemptSeq?: number;
  /** The accepted outcome that settled this node; present only when settled. */
  readonly outcomeId?: string;
  /** Epoch milliseconds this attempt was dispatched at. */
  readonly dispatchedAt?: number;
  /** Epoch milliseconds the accepted outcome settled this node at. */
  readonly settledAt?: number;
}

/**
 * The run phase of an outcome-protocol graph.
 *
 * `ready` — nothing dispatched and nothing settled. `executing` — at least one
 * attempt is in flight. `complete` — the run has started, nothing is in flight,
 * and every node that was ever dispatched has settled. A node the run never
 * reached stays `pending` and does not hold the graph open.
 */
export type OutcomeGraphPhase = "ready" | "executing" | "complete";

/**
 * The persisted state of one outcome-protocol graph.
 *
 * `nodes` is in PLAN order, always one entry per compiled node, so a reader can
 * compare state against plan position by position instead of trusting a keyed
 * map to be complete.
 */
export interface OutcomeGraphState {
  readonly graphId: string;
  /** The plan revision this snapshot is bound to. */
  readonly planRevision: string;
  readonly phase: OutcomeGraphPhase;
  /** Per-node progress, in plan node order. */
  readonly nodes: readonly OutcomeNodeState[];
  /** Loop-group traversal counters, keyed by declared loop group id. */
  readonly loopTraversals: Readonly<Record<string, number>>;
  /** The graph-wide attempt counter the last mint advanced. */
  readonly attemptSeq: number;
}

// ── Reading a persisted record ──────────────────────────────────────────────

/** Why a persisted graph-state body was refused. Stable identifiers. */
export type OutcomeStateProblem =
  /** The record names a different graph or plan revision than the plan in hand. */
  | "state-plan-mismatch"
  /** The body is not the state shape this build writes. */
  | "malformed-state";

/**
 * A persisted graph state that cannot be read as THIS build's state.
 *
 * Thrown instead of defaulting: a snapshot this build does not understand is
 * refused, never reset to a clean start and never overwritten blindly — the
 * state a later run would otherwise silently discard may be another build's
 * complete record.
 */
export class OutcomeStateError extends Error {
  readonly problem: OutcomeStateProblem;

  constructor(problem: OutcomeStateProblem, message: string) {
    super(message);
    this.name = "OutcomeStateError";
    this.problem = problem;
  }
}

/** Refuse a state body that is not the shape this module writes. */
function malformedState(detail: string): OutcomeStateError {
  return new OutcomeStateError(
    "malformed-state",
    "outcome-state: the persisted graph state is not the state this build writes: " +
      detail,
  );
}

/** Read one optional timestamp field, or refuse it. */
function readOptionalEpoch(
  raw: Record<string, unknown>,
  field: string,
  where: string,
): number | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedState(
      where + "." + field + " is " + describeValue(value) + ", not epoch milliseconds",
    );
  }
  return value;
}

/** Read one node's persisted progress against its plan declaration. */
function readNodeState(
  raw: unknown,
  expected: CompiledNode,
  index: number,
): OutcomeNodeState {
  const where = "nodes[" + index + "]";
  if (!isRecord(raw)) {
    throw malformedState(where + " is " + describeValue(raw) + ", not a node state record");
  }
  if (raw.nodeId !== expected.id) {
    throw malformedState(
      where + ".nodeId is " + describeValue(raw.nodeId) + ", but the plan declares " +
        JSON.stringify(expected.id) + " at position " + index +
        " — node progress is read in plan order",
    );
  }
  const status = raw.status;
  if (status !== "pending" && status !== "dispatched" && status !== "settled") {
    throw malformedState(
      where + ".status is " + describeValue(status) + ", not pending, dispatched or settled",
    );
  }
  const attemptId = raw.attemptId;
  const attemptSeq = raw.attemptSeq;
  const outcomeId = raw.outcomeId;
  const dispatchedAt = readOptionalEpoch(raw, "dispatchedAt", where);
  const settledAt = readOptionalEpoch(raw, "settledAt", where);
  if (status === "pending") {
    if (
      attemptId !== undefined ||
      attemptSeq !== undefined ||
      outcomeId !== undefined ||
      dispatchedAt !== undefined ||
      settledAt !== undefined
    ) {
      throw malformedState(
        where + " is pending but carries attempt, outcome or timestamp fields — a node that " +
          "was never dispatched has no attempt identity",
      );
    }
    return Object.freeze({ nodeId: expected.id, status: "pending" as const });
  }
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    throw malformedState(
      where + ".attemptId is " + describeValue(attemptId) + ", not a non-empty attempt id",
    );
  }
  if (
    typeof attemptSeq !== "number" ||
    !Number.isSafeInteger(attemptSeq) ||
    attemptSeq <= 0
  ) {
    throw malformedState(
      where + ".attemptSeq is " + describeValue(attemptSeq) + ", not a positive safe integer",
    );
  }
  if (dispatchedAt === undefined) {
    throw malformedState(where + " is " + status + " but carries no dispatchedAt timestamp");
  }
  if (status === "settled") {
    if (typeof outcomeId !== "string" || outcomeId.length === 0) {
      throw malformedState(
        where + ".outcomeId is " + describeValue(outcomeId) +
          ", not the non-empty outcome that settled the node",
      );
    }
    if (settledAt === undefined) {
      throw malformedState(where + " is settled but carries no settledAt timestamp");
    }
    return Object.freeze({
      nodeId: expected.id,
      status: "settled" as const,
      attemptId,
      attemptSeq,
      outcomeId,
      dispatchedAt,
      settledAt,
    });
  }
  if (outcomeId !== undefined || settledAt !== undefined) {
    throw malformedState(
      where + " is dispatched but carries a settled outcome or timestamp",
    );
  }
  return Object.freeze({
    nodeId: expected.id,
    status: "dispatched" as const,
    attemptId,
    attemptSeq,
    dispatchedAt,
  });
}

/** Read the loop traversal counters, refusing an undeclared group or a bad value. */
function readLoopTraversals(
  raw: unknown,
  plan: CompiledPlan,
): Readonly<Record<string, number>> {
  if (!isRecord(raw)) {
    throw malformedState("loopTraversals is " + describeValue(raw) + ", not a record of counters");
  }
  const declared = new Set(plan.loopGroups.map((group) => group.id));
  const counters: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) {
      throw malformedState(
        "loopTraversals names loop group " + JSON.stringify(key) +
          ", which plan revision " + plan.planRevision + " does not declare",
      );
    }
    const value = raw[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw malformedState(
        "loopTraversals[" + JSON.stringify(key) + "] is " + describeValue(value) +
          ", not a non-negative safe integer",
      );
    }
    counters[key] = value;
  }
  return Object.freeze(counters);
}

/**
 * Read one persisted record as this plan's state.
 *
 * STRICT and TOTAL: the identity fields must agree with the plan in hand, the
 * node list must be exactly the plan's nodes in plan order, and every field
 * must be the value the reducer would have written. Anything else throws an
 * {@link OutcomeStateError} — a state this build cannot read is never guessed
 * at, and never silently replaced.
 */
export function readOutcomeGraphState(
  record: GraphStateRecord,
  plan: CompiledPlan,
): OutcomeGraphState {
  if (record.graphId !== plan.graphId) {
    throw new OutcomeStateError(
      "state-plan-mismatch",
      "outcome-state: the persisted state belongs to graph " + JSON.stringify(record.graphId) +
        ", but the plan in hand is the compiled plan of " + JSON.stringify(plan.graphId),
    );
  }
  if (record.planRevision !== plan.planRevision) {
    throw new OutcomeStateError(
      "state-plan-mismatch",
      "outcome-state: the persisted state is bound to plan revision " +
        JSON.stringify(record.planRevision) + ", but the plan in hand is revision " +
        JSON.stringify(plan.planRevision) +
        " — a state is never read as the state of another revision",
    );
  }
  if (!isRecord(record.body)) {
    throw malformedState("the body is " + describeValue(record.body) + ", not a state record");
  }
  const body = record.body;
  const phase = body.phase;
  if (phase !== "ready" && phase !== "executing" && phase !== "complete") {
    throw malformedState(
      "phase is " + describeValue(phase) + ", not ready, executing or complete",
    );
  }
  const attemptSeq = body.attemptSeq;
  if (
    typeof attemptSeq !== "number" ||
    !Number.isSafeInteger(attemptSeq) ||
    attemptSeq < 0
  ) {
    throw malformedState(
      "attemptSeq is " + describeValue(attemptSeq) + ", not a non-negative safe integer",
    );
  }
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length !== plan.nodes.length) {
    throw malformedState(
      "nodes is " + (Array.isArray(rawNodes) ? rawNodes.length + " entries" : describeValue(rawNodes)) +
        ", but plan revision " + plan.planRevision + " declares " + plan.nodes.length +
        " node(s) — the state carries one entry per compiled node",
    );
  }
  const nodes = plan.nodes.map((node, index) => readNodeState(rawNodes[index], node, index));
  return Object.freeze({
    graphId: plan.graphId,
    planRevision: plan.planRevision,
    phase,
    nodes: Object.freeze(nodes),
    loopTraversals: readLoopTraversals(body.loopTraversals, plan),
    attemptSeq,
  });
}

/** Project one state into the durable record, timestamped by the caller. */
export function stateRecordOf(
  state: OutcomeGraphState,
  updatedAt: number,
): GraphStateRecord {
  return Object.freeze({
    graphId: state.graphId,
    planRevision: state.planRevision,
    body: state,
    updatedAt,
  });
}

// ── Entry nodes ─────────────────────────────────────────────────────────────

/**
 * The nodes a run may start from.
 *
 * An entry node is one no NON-LOOP edge targets. A loop's continuation edge is
 * excluded on purpose: a back edge can only fire after the loop started, so a
 * graph whose only inbound edge is its own continuation still has an entry
 * (otherwise a two-node loop would look unstartable). If the exclusion leaves
 * no entry at all, the graph declares no starting point and the runtime refuses
 * rather than picking one.
 */
export function entryNodesOf(plan: CompiledPlan): readonly CompiledNode[] {
  const loopEdges = new Set<string>();
  for (const group of plan.loopGroups) {
    const members = new Set(group.nodes);
    for (const edge of plan.edges) {
      if (
        edge.outcome === group.continuationOutcome &&
        members.has(edge.from) &&
        members.has(edge.to)
      ) {
        loopEdges.add(edge.from + "\u0000" + edge.to + "\u0000" + edge.outcome);
      }
    }
  }
  const targeted = new Set<string>();
  for (const edge of plan.edges) {
    if (loopEdges.has(edge.from + "\u0000" + edge.to + "\u0000" + edge.outcome)) continue;
    targeted.add(edge.to);
  }
  return Object.freeze(plan.nodes.filter((node) => !targeted.has(node.id)));
}

// ── The reducer ─────────────────────────────────────────────────────────────

/** Why an accepted outcome could not be applied to the state. */
export type OutcomeAdvanceRefusalCode =
  /** The decision names a node the plan does not declare. */
  | "unknown-node"
  /** The node is not currently dispatched, so it has no attempt to settle. */
  | "node-not-dispatched"
  /** The decision's attempt is not the node's current attempt. */
  | "attempt-mismatch"
  /** The outcome is not terminal and no edge routes it. */
  | "no-route"
  /** Applying this continuation would exceed the loop group's hard cap. */
  | "loop-limit-exceeded"
  /** The route re-enters a settled node outside its declared loop group. */
  | "reentry-outside-loop"
  /**
   * The state says an attempt settled and the ledger holds no accepted event
   * for it. Thrown by the run path's join, not by {@link advanceOutcomeGraph}:
   * it is the one disagreement the reducer cannot see on its own.
   */
  | "state-ledger-disagreement";

/**
 * An accepted outcome that must NOT advance the state.
 *
 * Thrown from inside the acceptance transaction, so the refusal rolls back the
 * receipt, the accepted event and every pending effect with it: a state that
 * cannot legally advance leaves the graph exactly where it was.
 */
export class OutcomeAdvanceRefusedError extends Error {
  readonly code: OutcomeAdvanceRefusalCode;

  constructor(code: OutcomeAdvanceRefusalCode, message: string) {
    super(message);
    this.name = "OutcomeAdvanceRefusedError";
    this.code = code;
  }
}

/** One successor the advance arms, ready to become a dispatch. */
export interface OutcomeDispatchIntent {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly prompt: string;
}

/** What one accepted outcome produced: the next state and what to dispatch. */
export interface OutcomeAdvance {
  readonly state: OutcomeGraphState;
  readonly dispatches: readonly OutcomeDispatchIntent[];
}

/** Inputs to {@link advanceOutcomeGraph}. */
export interface OutcomeAdvanceInput {
  readonly plan: CompiledPlan;
  readonly state: OutcomeGraphState;
  /** The accepted decision; its identity is the attempt being settled. */
  readonly decision: AcceptanceDecision;
  /** The clock, in epoch milliseconds. */
  readonly now: number;
}

/**
 * The loop group both endpoints of an edge belong to, if any.
 *
 * EXISTENCE, not selection: the re-entry rule asks whether the two nodes share
 * SOME declared loop group, so the first such group is a complete answer (see
 * {@link continuationGroups} for the selection a continuation counter needs).
 */
function sharedLoopGroup(
  plan: CompiledPlan,
  from: string,
  to: string,
): CompiledPlan["loopGroups"][number] | undefined {
  for (const group of plan.loopGroups) {
    if (group.nodes.includes(from) && group.nodes.includes(to)) return group;
  }
  return undefined;
}

/**
 * The loop groups one continuation outcome re-enters.
 *
 * A node may belong to more than one declared loop group, so "the group that
 * contains the emitting node" does not identify a single group. A group only
 * bounds THIS continuation when it declares this outcome as its
 * `continuationOutcome` AND contains the node that emitted it; every matching
 * group's counter advances, so no declared hard cap can be stepped over by
 * picking a different group that happens to share the node. The groups are
 * returned in the plan's own (id) order, so the refusal a caller sees for an
 * over-cap continuation is deterministic.
 */
function continuationGroups(
  plan: CompiledPlan,
  nodeId: string,
  outcomeId: string,
): readonly CompiledPlan["loopGroups"][number][] {
  return plan.loopGroups.filter(
    (group) =>
      group.continuationOutcome === outcomeId && group.nodes.includes(nodeId),
  );
}

/**
 * Apply one ACCEPTED outcome to the state.
 *
 * PURE: it reads the plan, the state and the decision, and returns the next
 * state plus the successors to arm. It never writes, never reads a clock of its
 * own and never re-validates the outcome (the acceptance core owns that).
 *
 * The rules, in order:
 * 1. the decision's node must be a plan node, currently dispatched, on the
 *    attempt the decision names — otherwise the acceptance does not describe
 *    the state in hand and the advance is refused;
 * 2. a terminal outcome settles the node and arms nothing;
 * 3. any other outcome must route somewhere (the plan's terminal list is the
 *    complement of its edges, so a non-terminal with no edge is a defect);
 * 4. a declared loop continuation advances that group's counter and refuses
 *    when the hard cap would be exceeded — one round past the cap is never run;
 * 5. every successor is armed with a FRESH attempt minted from the graph-wide
 *    counter; a settled successor is re-armed only when source and target share
 *    a declared loop group.
 */
export function advanceOutcomeGraph(input: OutcomeAdvanceInput): OutcomeAdvance {
  const { plan, state, decision, now } = input;
  const position = plan.nodes.findIndex((node) => node.id === decision.nodeId);
  if (position < 0) {
    throw new OutcomeAdvanceRefusedError(
      "unknown-node",
      "outcome-advance: the accepted decision names node " + JSON.stringify(decision.nodeId) +
        ", which plan revision " + plan.planRevision + " does not declare — nothing was applied",
    );
  }
  const current = state.nodes[position];
  if (current === undefined || current.nodeId !== decision.nodeId) {
    throw new OutcomeAdvanceRefusedError(
      "unknown-node",
      "outcome-advance: the state carries no progress for node " + JSON.stringify(decision.nodeId) +
        " — nothing was applied",
    );
  }
  if (current.status === "pending") {
    throw new OutcomeAdvanceRefusedError(
      "node-not-dispatched",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) +
        " was never dispatched, so its outcome cannot settle an attempt — nothing was applied",
    );
  }
  if (current.status === "settled") {
    throw new OutcomeAdvanceRefusedError(
      "node-not-dispatched",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) +
        " is already settled by outcome " + JSON.stringify(current.outcomeId ?? "") +
        " — a settled node is never advanced twice",
    );
  }
  if (current.attemptId !== decision.identity.attemptId) {
    throw new OutcomeAdvanceRefusedError(
      "attempt-mismatch",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) + " is on attempt " +
        JSON.stringify(current.attemptId ?? "") + ", but the accepted decision belongs to attempt " +
        JSON.stringify(decision.identity.attemptId) +
        " — a stale acceptance is refused rather than applied to a newer attempt",
    );
  }

  const node = plan.nodes[position];
  const nodes: OutcomeNodeState[] = state.nodes.map((entry) => ({ ...entry }));
  nodes[position] = Object.freeze({
    nodeId: current.nodeId,
    status: "settled" as const,
    ...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
    ...(current.attemptSeq === undefined ? {} : { attemptSeq: current.attemptSeq }),
    outcomeId: decision.outcomeId,
    ...(current.dispatchedAt === undefined ? {} : { dispatchedAt: current.dispatchedAt }),
    settledAt: now,
  });

  let loopTraversals = state.loopTraversals;
  let attemptSeq = state.attemptSeq;
  const dispatches: OutcomeDispatchIntent[] = [];

  const terminal = plan.terminalOutcomes.some(
    (entry) => entry.nodeId === decision.nodeId && entry.outcome === decision.outcomeId,
  );
  if (!terminal) {
    const successors = plan.edges.filter(
      (edge) => edge.from === decision.nodeId && edge.outcome === decision.outcomeId,
    );
    if (successors.length === 0) {
      throw new OutcomeAdvanceRefusedError(
        "no-route",
        "outcome-advance: outcome " + JSON.stringify(decision.outcomeId) + " of node " +
          JSON.stringify(decision.nodeId) + " is not a declared terminal and binds no edge — " +
          "the plan is inconsistent and nothing was applied",
      );
    }
    // Which loop this continuation re-enters is decided by the DECLARATION
    // (the groups that declare this outcome as their continuation), not by the
    // first group that happens to contain the emitting node. Every matching
    // group advances and the acceptance is refused when ANY of their caps would
    // be exceeded — a hard cap that a shared node could route around is not
    // hard. The counters are staged and assigned only once every cap has been
    // checked, so a refusal leaves the counters exactly as it found them.
    const groups = continuationGroups(plan, decision.nodeId, decision.outcomeId);
    if (groups.length > 0) {
      const next: Record<string, number> = { ...loopTraversals };
      for (const group of groups) {
        const traversals = (next[group.id] ?? 0) + 1;
        if (traversals > group.maxTraversals) {
          throw new OutcomeAdvanceRefusedError(
            "loop-limit-exceeded",
            "outcome-advance: loop group " + JSON.stringify(group.id) +
              " would reach traversal " + traversals + ", beyond its hard cap of " +
              group.maxTraversals +
              " — the acceptance is refused rather than run one round past the limit",
          );
        }
        next[group.id] = traversals;
      }
      loopTraversals = Object.freeze(next);
    }
    const armed = new Set<string>();
    for (const edge of successors) {
      if (armed.has(edge.to)) continue;
      armed.add(edge.to);
      const targetIndex = plan.nodes.findIndex((entry) => entry.id === edge.to);
      if (targetIndex < 0) {
        throw new OutcomeAdvanceRefusedError(
          "no-route",
          "outcome-advance: edge " + JSON.stringify(decision.nodeId) + " -> " +
            JSON.stringify(edge.to) + " names a node the plan does not declare",
        );
      }
      const target = nodes[targetIndex];
      if (target.status === "settled") {
        const shared = sharedLoopGroup(plan, decision.nodeId, edge.to);
        if (shared === undefined) {
          throw new OutcomeAdvanceRefusedError(
            "reentry-outside-loop",
            "outcome-advance: edge " + JSON.stringify(decision.nodeId) + " -> " +
              JSON.stringify(edge.to) + " re-enters a settled node, but the two do not share a " +
              "declared loop group — re-entry outside a declared loop is refused",
          );
        }
      }
      attemptSeq += 1;
      const attemptId = edge.to + "#" + attemptSeq;
      const targetNode = plan.nodes[targetIndex];
      nodes[targetIndex] = Object.freeze({
        nodeId: targetNode.id,
        status: "dispatched" as const,
        attemptId,
        attemptSeq,
        dispatchedAt: now,
      });
      dispatches.push(
        Object.freeze({
          nodeId: targetNode.id,
          attemptId,
          agent: targetNode.agent,
          prompt: targetNode.prompt,
        }),
      );
    }
  }

  const dispatched = nodes.some((entry) => entry.status === "dispatched");
  const attempted = nodes.some((entry) => entry.status !== "pending");
  const phase: OutcomeGraphPhase = dispatched
    ? "executing"
    : attempted
      ? "complete"
      : "ready";
  return Object.freeze({
    state: Object.freeze({
      graphId: state.graphId,
      planRevision: state.planRevision,
      phase,
      nodes: Object.freeze(nodes),
      loopTraversals,
      attemptSeq,
    }),
    dispatches: Object.freeze(dispatches),
  });
}

// ── Descriptions ────────────────────────────────────────────────────────────

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

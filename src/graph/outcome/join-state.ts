import { JoinStrategy } from "../../constants.ts";
import type { CompiledEdge, CompiledNode, CompiledPlan } from "../compiler/plan.ts";
import { readQuorum, resolveJoinStrategy } from "../join-strategy.ts";
import type { OutcomeArrival, OutcomeNodeState } from "./state-model.ts";
import { malformedState } from "./state-errors.ts";

/**
 * The LOOP CONTINUATION EDGES of one plan, keyed by the same
 * The LOOP CONTINUATION EDGES of one plan, keyed by the same `from\u0000to\u0000outcome`
 * spelling the arrival readers index edges by.
 * An edge is a continuation edge when one declared group whose continuation
 * outcome it carries contains BOTH of its endpoints. It is the group's own
 * back-edge: the route a member takes to ask for another round, not an
 * upstream result a consumer waits for.
 */
function loopContinuationEdgesOf(plan: CompiledPlan): ReadonlySet<string> {
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
  return loopEdges;
}

export function entryNodesOf(plan: CompiledPlan): readonly CompiledNode[] {
  const loopEdges = loopContinuationEdgesOf(plan);
  const targeted = new Set<string>();
  for (const edge of plan.edges) {
    if (loopEdges.has(edge.from + "\u0000" + edge.to + "\u0000" + edge.outcome)) continue;
    targeted.add(edge.to);
  }
  return Object.freeze(plan.nodes.filter((node) => !targeted.has(node.id)));
}

/**
 * The nodes a consumer's JOIN waits for: the sources of its in-edges, MINUS the
 * loop continuation edges of the declared loop groups they belong to.
 *
 * A continuation edge is a ROUTING edge, not a feeder. It says "another round
 * was asked for", and the member it points at is reached by that round — it is
 * not an upstream result the target consumes, and it can never precede the
 * target. Counting it would let a join node that also carries its own group's
 * back-edge demand an arrival from the node it must run BEFORE, which is
 * unsatisfiable by construction: the node would never be dispatched and the
 * declared loop could never be traversed. This is the SAME edge class
 * {@link entryNodesOf} already excludes when it decides which nodes are
 * dispatched at start, so both readers of "upstream" agree.
 *
 * Everything else is unchanged: a repeated (from, outcome) pair counts once, a
 * non-membership edge counts, and `join: "all"` still waits for every feeder
 * this function returns.
 */
export function feederSourcesOf(plan: CompiledPlan, targetId: string): readonly string[] {
  const loopEdges = loopContinuationEdgesOf(plan);
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const edge of plan.edges) {
    if (edge.to !== targetId || seen.has(edge.from)) continue;
    if (loopEdges.has(edge.from + "\u0000" + edge.to + "\u0000" + edge.outcome)) continue;
    seen.add(edge.from);
    sources.push(edge.from);
  }
  return sources;
}

export function materializeArrivals(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  suppressed?: ReadonlySet<string>,
): ReadonlyMap<string, readonly OutcomeArrival[]> {
  const entries = new Map<string, OutcomeNodeState>();
  for (const entry of nodes) entries.set(entry.nodeId, entry);
  const outgoing = new Map<string, CompiledEdge[]>();
  for (const edge of plan.edges) {
    const list = outgoing.get(edge.from);
    if (list === undefined) outgoing.set(edge.from, [edge]);
    else list.push(edge);
  }
  const arrivals = new Map<string, OutcomeArrival[]>();
  for (const node of plan.nodes) arrivals.set(node.id, []);
  for (const source of plan.nodes) {
    if (suppressed?.has(source.id)) continue;
    const entry = entries.get(source.id);
    if (entry === undefined || entry.status !== "settled") continue;
    const outcomeId = entry.outcomeId;
    const attemptId = entry.attemptId;
    if (outcomeId === undefined || attemptId === undefined) continue;
    const arrival: OutcomeArrival = Object.freeze({
      from: source.id,
      outcome: outcomeId,
      attemptId,
    });
    for (const edge of outgoing.get(source.id) ?? []) {
      if (edge.outcome !== outcomeId) continue;
      const list = arrivals.get(edge.to);
      if (list === undefined) continue;
      if (list.length > 0 && list[list.length - 1]?.from === source.id) continue;
      list.push(arrival);
    }
  }
  const frozen = new Map<string, readonly OutcomeArrival[]>();
  for (const [nodeId, list] of arrivals) frozen.set(nodeId, Object.freeze(list));
  return frozen;
}

/**
 * Whether one join is satisfied by a set of sources that have already arrived,
 * read against the feeder count of the declared strategy.
 *
 * The one reading of every strategy, shared by the arm decision
 * ({@link resolveArmSet}) and by the declare-time feasibility check: `all`
 * wants every feeder, `any` wants one, `quorum:N` wants N, and a node with no
 * feeder is never waited for. A reader asking "will this join EVER be
 * satisfied" passes the sources that can still arrive, which is the same
 * question the arm decision asks about the arrivals it has.
 */
export function joinSatisfiedBy(
  target: CompiledNode,
  arrived: ReadonlySet<string>,
  feeders: readonly string[],
): boolean {
  if (feeders.length === 0) return true;
  let count = 0;
  for (const feeder of feeders) {
    if (arrived.has(feeder)) count += 1;
  }
  const strategy = resolveJoinStrategy(target.join);
  if (typeof strategy === "object") {
    const quorum = readQuorum(strategy);
    return quorum !== undefined && count >= quorum;
  }
  if (strategy === JoinStrategy.Any) return count >= 1;
  return count === feeders.length;
}

export function joinSatisfiedFor(
  plan: CompiledPlan,
  target: CompiledNode,
  arrivals: readonly OutcomeArrival[],
): boolean {
  return joinSatisfiedBy(
    target,
    new Set(arrivals.map((arrival) => arrival.from)),
    feederSourcesOf(plan, target.id),
  );
}

export function resolveArmSet(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  armable: readonly CompiledNode[],
  notInFlight?: ReadonlySet<string>,
): ReadonlySet<string> {
  const entries = new Map<string, OutcomeNodeState>();
  for (const entry of nodes) entries.set(entry.nodeId, entry);
  const notArmed = new Set<string>();
  for (let round = 0; round <= armable.length; round += 1) {
    const suppressed = new Set<string>();
    for (const node of armable) {
      if (notArmed.has(node.id)) continue;
      if (notInFlight?.has(node.id) === true) continue;
      suppressed.add(node.id);
    }
    const arrivals = materializeArrivals(plan, nodes, suppressed);
    let grew = false;
    for (const node of armable) {
      if (notArmed.has(node.id)) continue;
      const entry = entries.get(node.id);
      const arrived = arrivals.get(node.id) ?? [];
      if (entry === undefined || !joinSatisfiedFor(plan, node, arrived)) {
        notArmed.add(node.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const armed = new Set<string>();
  for (const node of armable) {
    if (!notArmed.has(node.id)) armed.add(node.id);
  }
  return armed;
}

/**
 * The nodes a RUN can still reach: the ones already in flight, plus every node
 * some node still in play can still route to.
 *
 * A node is in play while it is DISPATCHED (it will settle) or while it could
 * still be dispatched (it is PENDING and a node in play can still route an edge
 * to it). A settled node is NOT in play: it routed the one outcome it settled
 * on, and only a declared loop can put it back in flight — which this reader
 * does not assume, so it reports a node whose arrivals can only come from
 * settled nodes as unreachable. That is the conservative direction: a run is
 * never told it has abandoned work it can still reach.
 */
function stillReachableNodes(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
): ReadonlySet<string> {
  const statusOf = new Map<string, OutcomeNodeState["status"]>();
  for (const entry of nodes) statusOf.set(entry.nodeId, entry.status);
  const reachable = new Set<string>();
  for (const node of plan.nodes) {
    if (statusOf.get(node.id) === "dispatched") reachable.add(node.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of plan.nodes) {
      if (reachable.has(node.id) || statusOf.get(node.id) === "settled") continue;
      const reachedBy = plan.edges.some(
        (edge) => edge.to === node.id && reachable.has(edge.from),
      );
      if (!reachedBy) continue;
      reachable.add(node.id);
      grew = true;
    }
  }
  return reachable;
}

/**
 * The PENDING nodes of this state that can never be dispatched, and the feeder
 * of each that can never arrive.
 *
 * A pending node is STRANDED when every feeder its join waits for is settled
 * and none of them is still reachable: a settled node routes the one outcome it
 * settled on, so the arrival the join waits for is already over. `blocked`
 * names, per stranded node, the feeder(s) whose arrival can never come — the
 * feeder set the runtime's own reader decides, so a loop continuation edge is
 * not counted as one.
 *
 * The result is EMPTY for a run that can still move: while an attempt is in
 * flight, or while any unsettled node can still route to a pending node, that
 * node is not stranded and nothing is reported. This is the declaration-side
 * question the runtime cannot answer for itself — whether the work a run still
 * holds is work it can still reach.
 */
export function unsatisfiablePendingNodes(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
): Readonly<Record<string, readonly string[]>> {
  const statusOf = new Map<string, OutcomeNodeState["status"]>();
  for (const entry of nodes) statusOf.set(entry.nodeId, entry.status);
  const reachable = stillReachableNodes(plan, nodes);
  const blocked: Record<string, readonly string[]> = {};
  for (const node of plan.nodes) {
    if (statusOf.get(node.id) !== "pending") continue;
    const lost: string[] = [];
    for (const feeder of feederSourcesOf(plan, node.id)) {
      if (reachable.has(feeder)) continue;
      lost.push(feeder);
    }
    if (lost.length === 0) continue;
    blocked[node.id] = Object.freeze(lost);
  }
  return Object.freeze(blocked);
}

export function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function sameArrivals(
  a: readonly OutcomeArrival[],
  b: readonly OutcomeArrival[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((arrival, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      arrival.from === other.from &&
      arrival.outcome === other.outcome &&
      arrival.attemptId === other.attemptId
    );
  });
}

function describeArrivals(arrivals: readonly OutcomeArrival[]): string {
  return (
    "[" +
    arrivals
      .map(
        (arrival) =>
          JSON.stringify(arrival.from + ":" + arrival.outcome + "@" + arrival.attemptId),
      )
      .join(", ") +
    "]"
  );
}

export function verifyArrivals(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
): void {
  const canonical = materializeArrivals(plan, nodes);
  nodes.forEach((entry, index) => {
    const expected = canonical.get(entry.nodeId) ?? [];
    const recorded = entry.arrivals ?? [];
    if (!sameArrivals(recorded, expected)) {
      throw malformedState(
        "nodes[" + index + "].arrivals is " + describeArrivals(recorded) +
        ", but the node entries and the plan's edges corroborate " +
        describeArrivals(expected) +
        " — the arrival list is refused rather than trusted or silently corrected",
      );
    }
  });
}


import { JoinStrategy } from "../../constants.ts";
import type { CompiledEdge, CompiledNode, CompiledPlan } from "../compiler/plan.ts";
import { readQuorum, resolveJoinStrategy } from "../join-strategy.ts";
import type { OutcomeArrival, OutcomeNodeState } from "./state-model.ts";
import { malformedState } from "./state-errors.ts";

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

function feederSourcesOf(plan: CompiledPlan, targetId: string): readonly string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const edge of plan.edges) {
    if (edge.to !== targetId || seen.has(edge.from)) continue;
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

function joinSatisfiedFor(
  plan: CompiledPlan,
  target: CompiledNode,
  arrivals: readonly OutcomeArrival[],
): boolean {
  const feeders = feederSourcesOf(plan, target.id);
  if (feeders.length === 0) return true;
  const arrived = new Set(arrivals.map((arrival) => arrival.from));
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


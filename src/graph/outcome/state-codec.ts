import type {
  CompiledNode,
  CompiledPlan,
  CompiledProgressPolicy
} from "../compiler/plan.ts";
import type { GraphStateRecord } from "../ledger/types.ts";
import {
  isAttemptCredentialDigest
} from "./attempt-credential.ts";
import {
  PROGRESS_VALUE_MAX_LENGTH, type OutcomeLoopProgress
} from "./progress.ts";
import {
  readHostInvocationIdentity,
  type HostInvocationIdentity,
} from "./host-identity.ts";
import {
  readInputRefusals as readPersistedInputRefusals,
  readResolvedInputs, type DownstreamInputRefusal,
  type ResolvedInput
} from "./inputs.ts";

import { type OutcomeNodeStatus, type OutcomeNodeState, type OutcomeArrival, type OutcomeGraphPhase, type OutcomeStopReason, type OutcomeLoopExhaustedStop, type OutcomeProgressStalledStop, type OutcomeStop, type OutcomeGraphState, CURRENT_OUTCOME_STATE_BODY, OUTCOME_STOP_REASONS } from "./state-model.ts";
import { malformedState, OutcomeStateError } from "./state-errors.ts";
import { verifyArrivals } from "./join-state.ts";
export type OutcomeStateBodyReading =
  | { readonly kind: "ok"; readonly state: OutcomeGraphState }
  | { readonly kind: "invalid"; readonly error: OutcomeStateError };

export interface OutcomeStateBodyReader {

  readonly format: number;

  read(body: Record<string, unknown>, plan: CompiledPlan): OutcomeStateBodyReading;
}

export interface OutcomeStateBodyRegistry {

  readonly current: number;

  readonly formats: readonly OutcomeStateBodyReader[];
}

export interface OutcomeStateBodyRegistryInput {

  readonly current: number;

  readonly formats: readonly OutcomeStateBodyReader[];
}

export function createOutcomeStateBodyRegistry(
  input: OutcomeStateBodyRegistryInput,
): OutcomeStateBodyRegistry {
  const installed = new Set<number>();
  for (const format of input.formats) {
    if (!Number.isSafeInteger(format.format) || format.format <= 0) {
      throw new Error(
        "state-body-format: " + describeValue(format.format) +
        " is not a legal state-body version — a version identifier is a positive safe integer",
      );
    }
    if (installed.has(format.format)) {
      throw new Error(
        "state-body-format: duplicate reader for body version " + format.format +
        " — one exact version has exactly one read owner",
      );
    }
    installed.add(format.format);
  }
  if (!installed.has(input.current)) {
    throw new Error(
      "state-body-format: the current body version " + describeValue(input.current) +
      " has no registered reader — a build cannot write a body it cannot read back",
    );
  }
  for (const format of input.formats) Object.freeze(format);
  return Object.freeze({
    current: input.current,
    formats: Object.freeze([...input.formats]),
  });
}

export type OutcomeStateBodyVerdict =
  | {
    readonly kind: "supported";
    readonly version: number;
    readonly reader: OutcomeStateBodyReader;
  }
  | { readonly kind: "unsupported"; readonly version: number }
  | { readonly kind: "invalid"; readonly value: unknown };

export function classifyOutcomeStateBody(
  version: unknown,
  registry: OutcomeStateBodyRegistry,
): OutcomeStateBodyVerdict {
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    return { kind: "invalid", value: version };
  }
  const reader = registry.formats.find((format) => format.format === version);
  if (reader !== undefined) {
    return { kind: "supported", version, reader };
  }
  return { kind: "unsupported", version };
}

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

function readDispatchIdentity(
  raw: Record<string, unknown>,
  where: string,
): HostInvocationIdentity | undefined {
  const value = raw.dispatchIdentity;
  if (value === undefined) return undefined;
  const identity = readHostInvocationIdentity(value);
  if (identity === undefined) {
    throw malformedState(where + ".dispatchIdentity is not a host invocation identity");
  }
  return identity;
}

function readBoundInputs(
  raw: Record<string, unknown>,
  where: string,
): readonly ResolvedInput[] | undefined {
  const value = raw.inputs;
  if (value === undefined) return undefined;
  const reading = readResolvedInputs(value, where + ".inputs");
  if (reading.kind === "malformed") throw malformedState(reading.message);
  return reading.entries;
}

function readNodeInputRefusals(
  raw: Record<string, unknown>,
  where: string,
): readonly DownstreamInputRefusal[] | undefined {
  const value = raw.inputRefusals;
  if (value === undefined) return undefined;
  const reading = readPersistedInputRefusals(value, where + ".inputRefusals");
  if (reading.kind === "malformed") throw malformedState(reading.message);
  return reading.refusals;
}

interface OutcomeStateLayout {

  readonly version: number;

  readonly keys: Readonly<Record<OutcomeNodeStatus, readonly string[]>>;

  readonly bodyKeys: readonly string[];

  readonly phases: readonly OutcomeGraphPhase[];


}

const OUTCOME_STATE_LAYOUT_V9: OutcomeStateLayout = Object.freeze({
  version: CURRENT_OUTCOME_STATE_BODY,
  bodyKeys: Object.freeze(["bodyVersion", "graphId", "planRevision", "phase", "nodes", "loopTraversals", "attemptSeq", "stop", "loopProgress"]),
  phases: Object.freeze(["ready", "executing", "complete", "stopped"] as const),
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status", "arrivals", "inputRefusals"]),
    dispatched: Object.freeze(["nodeId", "status", "attemptId", "attemptSeq", "attemptCredentialDigest", "dispatchedAt", "arrivals", "dispatchIdentity", "inputs", "inputRefusals"]),
    settled: Object.freeze(["nodeId", "status", "attemptId", "attemptSeq", "attemptCredentialDigest", "dispatchedAt", "settledAt", "outcomeId", "arrivals", "dispatchIdentity", "inputs", "inputRefusals"]),
  }),
});

function rejectUnknownNodeFields(
  raw: Record<string, unknown>,
  status: OutcomeNodeStatus,
  where: string,
  layout: OutcomeStateLayout,
): void {
  const defined = layout.keys[status];
  for (const key of Object.keys(raw)) {
    if (!defined.includes(key)) {
      throw malformedState(
        where + " carries field " + JSON.stringify(key) + ", which body version " +
        layout.version + " does not define for a " + status + " node — " +
        "an unknown field is refused rather than dropped",
      );
    }
  }
}

function readNodeState(
  raw: unknown,
  expected: CompiledNode,
  index: number,
  layout: OutcomeStateLayout,
  plan: CompiledPlan,
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
  rejectUnknownNodeFields(raw, status, where, layout);
  const attemptId = raw.attemptId;
  const attemptSeq = raw.attemptSeq;
  const attemptCredentialDigest = raw.attemptCredentialDigest;
  const dispatchIdentity = readDispatchIdentity(raw, where);
  const boundInputs = readBoundInputs(raw, where);
  const inputRefusals = readNodeInputRefusals(raw, where);
  const outcomeId = raw.outcomeId;
  const dispatchedAt = readOptionalEpoch(raw, "dispatchedAt", where);
  const settledAt = readOptionalEpoch(raw, "settledAt", where);
  const recordedArrivals = readArrivals(raw.arrivals, expected, where, plan);
  if (status === "pending") {
    if (
      attemptId !== undefined ||
      attemptSeq !== undefined ||
      attemptCredentialDigest !== undefined ||
      dispatchIdentity !== undefined ||
      outcomeId !== undefined ||
      dispatchedAt !== undefined ||
      settledAt !== undefined
    ) {
      throw malformedState(
        where + " is pending but carries attempt, credential, host binding, outcome or " +
        "timestamp fields — a node that was never dispatched has no attempt identity",
      );
    }
    return Object.freeze({
      nodeId: expected.id,
      status: "pending" as const,
      ...(recordedArrivals === undefined ? {} : { arrivals: recordedArrivals }),
      ...(inputRefusals === undefined ? {} : { inputRefusals }),
    });
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
  let credentialDigest: string | undefined;
  {
    if (!isAttemptCredentialDigest(attemptCredentialDigest)) {
      throw malformedState(
        where + ".attemptCredentialDigest is " + describeValue(attemptCredentialDigest) +
        ", not the sha256 digest body version " + layout.version + " requires on a " +
        status + " node — this build persists only the digest of an attempt " +
        "credential, so a record that carries anything else is refused rather " +
        "than read as a verifier it is not",
      );
    }
    credentialDigest = attemptCredentialDigest;
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
      ...(credentialDigest === undefined
        ? {}
        : { attemptCredentialDigest: credentialDigest }),
      ...(dispatchIdentity === undefined ? {} : { dispatchIdentity }),
      outcomeId,
      dispatchedAt,
      settledAt,
      ...(recordedArrivals === undefined ? {} : { arrivals: recordedArrivals }),
      ...(boundInputs === undefined ? {} : { inputs: boundInputs }),
      ...(inputRefusals === undefined ? {} : { inputRefusals }),
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
    ...(credentialDigest === undefined
      ? {}
      : { attemptCredentialDigest: credentialDigest }),
    ...(dispatchIdentity === undefined ? {} : { dispatchIdentity }),
    dispatchedAt,
    ...(recordedArrivals === undefined ? {} : { arrivals: recordedArrivals }),
    ...(boundInputs === undefined ? {} : { inputs: boundInputs }),
    ...(inputRefusals === undefined ? {} : { inputRefusals }),
  });
}

const OUTCOME_ARRIVAL_KEYS: readonly string[] = Object.freeze([
  "from",
  "outcome",
  "attemptId",
]);

function readArrivals(
  raw: unknown,
  expected: CompiledNode,
  where: string,
  plan: CompiledPlan,
): readonly OutcomeArrival[] {
  if (!Array.isArray(raw)) {
    throw malformedState(
      where + ".arrivals is " + describeValue(raw) +
      ", not the predecessor arrival list body version " + CURRENT_OUTCOME_STATE_BODY +
      " defines for every node",
    );
  }
  const arrivals: OutcomeArrival[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const at = where + ".arrivals[" + index + "]";
    if (!isRecord(entry)) {
      throw malformedState(at + " is " + describeValue(entry) + ", not an arrival record");
    }
    for (const key of Object.keys(entry)) {
      if (!OUTCOME_ARRIVAL_KEYS.includes(key)) {
        throw malformedState(
          at + " carries field " + JSON.stringify(key) +
          ", which an arrival does not define — an unknown field is refused rather than dropped",
        );
      }
    }
    const from = entry.from;
    const outcome = entry.outcome;
    const attemptId = entry.attemptId;
    if (typeof from !== "string" || from.length === 0) {
      throw malformedState(
        at + ".from is " + describeValue(from) + ", not a non-empty predecessor node id",
      );
    }
    if (typeof outcome !== "string" || outcome.length === 0) {
      throw malformedState(
        at + ".outcome is " + describeValue(outcome) + ", not a non-empty outcome id",
      );
    }
    if (typeof attemptId !== "string" || attemptId.length === 0) {
      throw malformedState(
        at + ".attemptId is " + describeValue(attemptId) +
        ", not the non-empty attempt that produced the arrival",
      );
    }
    if (seen.has(from)) {
      throw malformedState(
        at + " names predecessor " + JSON.stringify(from) +
        " a second time — a feeder holds at most one arrival at a join",
      );
    }
    seen.add(from);
    if (
      !plan.edges.some(
        (edge) => edge.from === from && edge.to === expected.id && edge.outcome === outcome,
      )
    ) {
      throw malformedState(
        at + " records outcome " + JSON.stringify(outcome) + " of node " + JSON.stringify(from) +
        " arriving at " + JSON.stringify(expected.id) + ", but plan revision " +
        plan.planRevision +
        " declares no such edge — an arrival no edge routes is refused rather than counted",
      );
    }
    arrivals.push(Object.freeze({ from, outcome, attemptId }));
  });
  return Object.freeze(arrivals);
}

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

const OUTCOME_LOOP_PROGRESS_KEYS: readonly string[] = Object.freeze([
  "loopGroupId",
  "evaluator",
  "version",
  "subject",
  "unchanged",
  "baseline",
]);

function readLoopProgress(
  raw: unknown,
  plan: CompiledPlan,
): Readonly<Record<string, OutcomeLoopProgress>> {
  if (!isRecord(raw)) {
    throw malformedState(
      "loopProgress is " + describeValue(raw) +
      ", not a record of per-loop-group progress (body version " +
      CURRENT_OUTCOME_STATE_BODY + " defines one entry per declared progress policy)",
    );
  }
  const policies = new Map<string, CompiledProgressPolicy>();
  for (const group of plan.loopGroups) {
    if (group.progress !== undefined) policies.set(group.id, group.progress);
  }
  const entries: Record<string, OutcomeLoopProgress> = {};
  for (const key of Object.keys(raw)) {
    const policy = policies.get(key);
    if (policy === undefined) {
      const declared = plan.loopGroups.some((group) => group.id === key);
      throw malformedState(
        "loopProgress names loop group " + JSON.stringify(key) +
        (declared
          ? ", which plan revision " + plan.planRevision +
          " declares WITHOUT a progress policy — a baseline no declaration asks for is " +
          "refused rather than read"
          : ", which plan revision " + plan.planRevision + " does not declare"),
      );
    }
    entries[key] = readLoopProgressEntry(raw[key], key, policy);
  }
  for (const group of plan.loopGroups) {
    if (group.progress === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(entries, group.id)) continue;
    throw malformedState(
      "loopProgress carries no entry for loop group " + JSON.stringify(group.id) +
      ", whose plan declares a progress policy — the writer records one progress entry per " +
      "declared policy, so a missing one cannot be told from a lost baseline",
    );
  }
  return Object.freeze(entries);
}

function readLoopProgressEntry(
  raw: unknown,
  groupId: string,
  policy: CompiledProgressPolicy,
): OutcomeLoopProgress {
  const where = "loopProgress[" + JSON.stringify(groupId) + "]";
  if (!isRecord(raw)) {
    throw malformedState(where + " is " + describeValue(raw) + ", not a progress record");
  }
  for (const key of Object.keys(raw)) {
    if (!OUTCOME_LOOP_PROGRESS_KEYS.includes(key)) {
      throw malformedState(
        where + " carries field " + JSON.stringify(key) +
        ", which a progress record does not define — an unknown field is refused rather than " +
        "dropped",
      );
    }
  }
  if (raw.loopGroupId !== groupId) {
    throw malformedState(
      where + ".loopGroupId is " + describeValue(raw.loopGroupId) +
      ", but the entry is keyed by " + JSON.stringify(groupId),
    );
  }
  const evaluator = readNonEmptyId(raw.evaluator, where, "evaluator");
  if (evaluator !== policy.evaluator) {
    throw malformedState(
      where + ".evaluator is " + JSON.stringify(evaluator) +
      ", but loop group " + JSON.stringify(groupId) + " declares the comparison semantics " +
      JSON.stringify(policy.evaluator) +
      " — a baseline recorded under another evaluator is refused rather than compared",
    );
  }
  const subject = readNonEmptyId(raw.subject, where, "subject");
  if (subject !== policy.subject) {
    throw malformedState(
      where + ".subject is " + JSON.stringify(subject) +
      ", but loop group " + JSON.stringify(groupId) + " declares " +
      JSON.stringify(policy.subject) + " as its comparison object",
    );
  }
  const version = readPositiveCount(raw.version, where, "version");
  const unchanged = raw.unchanged;
  if (typeof unchanged !== "number" || !Number.isSafeInteger(unchanged) || unchanged < 0) {
    throw malformedState(
      where + ".unchanged is " + describeValue(unchanged) + ", not a non-negative safe integer",
    );
  }
  const baseline = raw.baseline;
  if (baseline !== undefined) {
    if (
      typeof baseline !== "string" ||
      baseline.length === 0 ||
      baseline.length > PROGRESS_VALUE_MAX_LENGTH
    ) {
      throw malformedState(
        where + ".baseline is " +
        (typeof baseline === "string"
          ? baseline.length === 0
            ? "an empty string"
            : "a " + baseline.length + "-character string"
          : describeValue(baseline)) +
        ", not a revision token of 1 to " + PROGRESS_VALUE_MAX_LENGTH +
        " characters — a projection never records more than the bound, and prefixes are never " +
        "compared",
      );
    }
  }
  return Object.freeze({
    loopGroupId: groupId,
    evaluator,
    version,
    subject,
    unchanged,
    ...(baseline === undefined ? {} : { baseline }),
  });
}

function rejectUnknownBodyFields(
  body: Record<string, unknown>,
  layout: OutcomeStateLayout,
): void {
  for (const key of Object.keys(body)) {
    if (!layout.bodyKeys.includes(key)) {
      throw malformedState(
        "the body carries field " + JSON.stringify(key) + ", which body version " +
        layout.version +
        " does not define — an unknown field is refused rather than dropped; adding a " +
        "field is a new body version",
      );
    }
  }
}

function readStop(
  raw: unknown,
  phase: OutcomeGraphPhase,
  layout: OutcomeStateLayout,
  where: string,
): OutcomeStop | undefined {
  if (phase !== "stopped") {
    if (raw !== undefined) {
      throw malformedState(
        where + ".stop is present, but phase is " + describeValue(phase) +
        " — a stop record and the phase of `stopped` are the same fact written twice, and " +
        "this body states them differently",
      );
    }
    return undefined;
  }
  if (!isRecord(raw)) {
    throw malformedState(
      where + ".stop is " + describeValue(raw) +
      ", not the stop record a stopped run carries — a body that ended cannot leave the " +
      "reason unrecorded",
    );
  }
  const reason = readStopReason(raw.reason, where);
  switch (reason) {
    case "loop-exhausted":
      return readLoopExhaustedStop(raw, where);
    case "progress-stalled":
      return readProgressStalledStop(raw, where);
    default: {
      const unread: never = reason;
      throw malformedState(
        where + ".stop.reason is " + describeValue(unread) + ", which has no reader",
      );
    }
  }
}

function readStopReason(value: unknown, where: string): OutcomeStopReason {
  const declared = OUTCOME_STOP_REASONS.find((candidate) => candidate === value);
  if (declared === undefined) {
    throw malformedState(
      where + ".stop.reason is " + describeValue(value) + ", not a stop reason this build " +
      "defines — the vocabulary is closed and every member is a condition decided from the " +
      "plan and the state [" + OUTCOME_STOP_REASONS.join(", ") + "]",
    );
  }
  return declared;
}

const OUTCOME_LOOP_EXHAUSTED_STOP_KEYS: readonly string[] = Object.freeze([
  "reason",
  "loopGroupId",
  "nodeId",
  "outcomeId",
  "attemptId",
  "traversals",
  "maxTraversals",
  "stoppedAt",
]);

function readLoopExhaustedStop(
  raw: Record<string, unknown>,
  where: string,
): OutcomeLoopExhaustedStop {
  const at = where + ".stop";
  for (const key of Object.keys(raw)) {
    if (!OUTCOME_LOOP_EXHAUSTED_STOP_KEYS.includes(key)) {
      throw malformedState(
        at + " carries field " + JSON.stringify(key) +
        ", which a loop-exhausted stop does not define — an unknown field is refused rather " +
        "than dropped",
      );
    }
  }
  const loopGroupId = readNonEmptyId(raw.loopGroupId, at, "loopGroupId");
  const nodeId = readNonEmptyId(raw.nodeId, at, "nodeId");
  const outcomeId = readNonEmptyId(raw.outcomeId, at, "outcomeId");
  const attemptId = readNonEmptyId(raw.attemptId, at, "attemptId");
  const traversals = readPositiveCount(raw.traversals, at, "traversals");
  const maxTraversals = readPositiveCount(raw.maxTraversals, at, "maxTraversals");
  const stoppedAt = readOptionalEpoch(raw, "stoppedAt", at);
  if (stoppedAt === undefined) {
    throw malformedState(at + " carries no stoppedAt timestamp");
  }
  return Object.freeze({
    reason: "loop-exhausted" as const,
    loopGroupId,
    nodeId,
    outcomeId,
    attemptId,
    traversals,
    maxTraversals,
    stoppedAt,
  });
}

const OUTCOME_PROGRESS_STALLED_STOP_KEYS: readonly string[] = Object.freeze([
  "reason",
  "loopGroupId",
  "nodeId",
  "outcomeId",
  "attemptId",
  "unchanged",
  "maxUnchanged",
  "evaluator",
  "evaluatorVersion",
  "subject",
  "baseline",
  "stoppedAt",
]);

function readProgressStalledStop(
  raw: Record<string, unknown>,
  where: string,
): OutcomeProgressStalledStop {
  const at = where + ".stop";
  for (const key of Object.keys(raw)) {
    if (!OUTCOME_PROGRESS_STALLED_STOP_KEYS.includes(key)) {
      throw malformedState(
        at + " carries field " + JSON.stringify(key) +
        ", which a progress-stalled stop does not define — an unknown field is refused " +
        "rather than dropped",
      );
    }
  }
  const loopGroupId = readNonEmptyId(raw.loopGroupId, at, "loopGroupId");
  const nodeId = readNonEmptyId(raw.nodeId, at, "nodeId");
  const outcomeId = readNonEmptyId(raw.outcomeId, at, "outcomeId");
  const attemptId = readNonEmptyId(raw.attemptId, at, "attemptId");
  const unchanged = readPositiveCount(raw.unchanged, at, "unchanged");
  const maxUnchanged = readPositiveCount(raw.maxUnchanged, at, "maxUnchanged");
  const evaluator = readNonEmptyId(raw.evaluator, at, "evaluator");
  const evaluatorVersion = readPositiveCount(raw.evaluatorVersion, at, "evaluatorVersion");
  const subject = readNonEmptyId(raw.subject, at, "subject");
  const baseline = raw.baseline;
  if (
    typeof baseline !== "string" ||
    baseline.length === 0 ||
    baseline.length > PROGRESS_VALUE_MAX_LENGTH
  ) {
    throw malformedState(
      at + ".baseline is " + describeValue(baseline) +
      ", not the non-empty revision token the run stood still on",
    );
  }
  const stoppedAt = readOptionalEpoch(raw, "stoppedAt", at);
  if (stoppedAt === undefined) {
    throw malformedState(at + " carries no stoppedAt timestamp");
  }
  return Object.freeze({
    reason: "progress-stalled" as const,
    loopGroupId,
    nodeId,
    outcomeId,
    attemptId,
    unchanged,
    maxUnchanged,
    evaluator,
    evaluatorVersion,
    subject,
    baseline,
    stoppedAt,
  });
}

function readNonEmptyId(value: unknown, where: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformedState(
      where + "." + field + " is " + describeValue(value) + ", not a non-empty identifier",
    );
  }
  return value;
}

function readPositiveCount(value: unknown, where: string, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw malformedState(
      where + "." + field + " is " + describeValue(value) + ", not a positive safe integer",
    );
  }
  return value;
}

function verifyStop(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  loopTraversals: Readonly<Record<string, number>>,
  loopProgress: Readonly<Record<string, OutcomeLoopProgress>>,
  stop: OutcomeStop,
): void {
  switch (stop.reason) {
    case "loop-exhausted":
      verifyLoopExhaustedStop(plan, nodes, loopTraversals, stop);
      return;
    case "progress-stalled":
      verifyProgressStalledStop(plan, nodes, loopProgress, stop);
      return;
    default: {
      const unread: never = stop;
      throw malformedState(
        "the stop reason " + describeValue(unread) + " has no verifier",
      );
    }
  }
}

function verifyLoopExhaustedStop(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  loopTraversals: Readonly<Record<string, number>>,
  stop: OutcomeLoopExhaustedStop,
): void {
  const group = plan.loopGroups.find((entry) => entry.id === stop.loopGroupId);
  if (group === undefined) {
    throw malformedState(
      "the stop names loop group " + JSON.stringify(stop.loopGroupId) +
      ", which plan revision " + plan.planRevision + " does not declare",
    );
  }
  if (group.maxTraversals !== stop.maxTraversals) {
    throw malformedState(
      "the stop records a hard cap of " + stop.maxTraversals + " for loop group " +
      JSON.stringify(stop.loopGroupId) + ", but the plan declares " + group.maxTraversals,
    );
  }
  if (!group.nodes.includes(stop.nodeId)) {
    throw malformedState(
      "the stop names node " + JSON.stringify(stop.nodeId) + ", which is not a member of loop " +
      "group " + JSON.stringify(stop.loopGroupId),
    );
  }
  if (group.continuationOutcome !== stop.outcomeId) {
    throw malformedState(
      "the stop names outcome " + JSON.stringify(stop.outcomeId) + ", but loop group " +
      JSON.stringify(stop.loopGroupId) + " declares " +
      JSON.stringify(group.continuationOutcome) + " as its continuation",
    );
  }
  const entry = nodes.find((node) => node.nodeId === stop.nodeId);
  if (
    entry === undefined ||
    entry.status !== "settled" ||
    entry.outcomeId !== stop.outcomeId ||
    entry.attemptId !== stop.attemptId
  ) {
    throw malformedState(
      "the stop records attempt " + JSON.stringify(stop.attemptId) + " of node " +
      JSON.stringify(stop.nodeId) + " settling with outcome " +
      JSON.stringify(stop.outcomeId) + ", but the node entries do not " +
      "(entry: " + describeNodeEntry(entry) +
      ") — a stop no accepted outcome corroborates is refused rather than trusted",
    );
  }
  const recorded = loopTraversals[stop.loopGroupId] ?? 0;
  if (recorded !== stop.traversals) {
    throw malformedState(
      "the stop records " + stop.traversals + " traversal(s) of loop group " +
      JSON.stringify(stop.loopGroupId) + ", but loopTraversals records " + recorded,
    );
  }
  if (stop.traversals !== stop.maxTraversals) {
    throw malformedState(
      "the stop records traversal " + stop.traversals + " of a cap of " + stop.maxTraversals +
      " — a cap refused the round that would have EXCEEDED it, so the counter it stopped on " +
      "is the cap itself",
    );
  }
}

function verifyProgressStalledStop(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  loopProgress: Readonly<Record<string, OutcomeLoopProgress>>,
  stop: OutcomeProgressStalledStop,
): void {
  const group = plan.loopGroups.find((entry) => entry.id === stop.loopGroupId);
  if (group === undefined) {
    throw malformedState(
      "the stop names loop group " + JSON.stringify(stop.loopGroupId) +
      ", which plan revision " + plan.planRevision + " does not declare",
    );
  }
  const policy = group.progress;
  if (policy === undefined) {
    throw malformedState(
      "the stop is a progress-stalled stop on loop group " +
      JSON.stringify(stop.loopGroupId) +
      ", but the plan declares no progress policy for that group — a stop no declared " +
      "stopping policy can produce is refused rather than trusted",
    );
  }
  if (policy.maxUnchanged !== stop.maxUnchanged) {
    throw malformedState(
      "the stop records a stagnation threshold of " + stop.maxUnchanged + " for loop group " +
      JSON.stringify(stop.loopGroupId) + ", but the plan declares " + policy.maxUnchanged,
    );
  }
  if (policy.evaluator !== stop.evaluator) {
    throw malformedState(
      "the stop names evaluator " + JSON.stringify(stop.evaluator) +
      ", but loop group " + JSON.stringify(stop.loopGroupId) + " declares " +
      JSON.stringify(policy.evaluator),
    );
  }
  if (policy.subject !== stop.subject) {
    throw malformedState(
      "the stop names comparison subject " + JSON.stringify(stop.subject) +
      ", but loop group " + JSON.stringify(stop.loopGroupId) + " declares " +
      JSON.stringify(policy.subject),
    );
  }
  if (!group.nodes.includes(stop.nodeId)) {
    throw malformedState(
      "the stop names node " + JSON.stringify(stop.nodeId) + ", which is not a member of loop " +
      "group " + JSON.stringify(stop.loopGroupId),
    );
  }
  if (group.continuationOutcome !== stop.outcomeId) {
    throw malformedState(
      "the stop names outcome " + JSON.stringify(stop.outcomeId) + ", but loop group " +
      JSON.stringify(stop.loopGroupId) + " declares " +
      JSON.stringify(group.continuationOutcome) + " as its continuation",
    );
  }
  const entry = nodes.find((node) => node.nodeId === stop.nodeId);
  if (
    entry === undefined ||
    entry.status !== "settled" ||
    entry.outcomeId !== stop.outcomeId ||
    entry.attemptId !== stop.attemptId
  ) {
    throw malformedState(
      "the stop records attempt " + JSON.stringify(stop.attemptId) + " of node " +
      JSON.stringify(stop.nodeId) + " settling with outcome " +
      JSON.stringify(stop.outcomeId) + ", but the node entries do not " +
      "(entry: " + describeNodeEntry(entry) +
      ") — a stop no accepted outcome corroborates is refused rather than trusted",
    );
  }
  const progress = loopProgress[stop.loopGroupId];
  if (progress === undefined) {
    throw malformedState(
      "the stop names loop group " + JSON.stringify(stop.loopGroupId) +
      ", but loopProgress records no progress for it",
    );
  }
  if (
    progress.evaluator !== stop.evaluator ||
    progress.version !== stop.evaluatorVersion ||
    progress.subject !== stop.subject
  ) {
    throw malformedState(
      "the stop records the comparison under evaluator " + JSON.stringify(stop.evaluator) +
      " version " + stop.evaluatorVersion + " on subject " + JSON.stringify(stop.subject) +
      ", but loopProgress records " + JSON.stringify(progress.evaluator) + " version " +
      progress.version + " on subject " + JSON.stringify(progress.subject),
    );
  }
  if (progress.unchanged !== stop.unchanged) {
    throw malformedState(
      "the stop records " + stop.unchanged + " consecutive unchanged comparison(s) of loop " +
      "group " + JSON.stringify(stop.loopGroupId) + ", but loopProgress records " +
      progress.unchanged,
    );
  }
  if (progress.baseline !== stop.baseline) {
    throw malformedState(
      "the stop records the baseline " + JSON.stringify(stop.baseline) + " of loop group " +
      JSON.stringify(stop.loopGroupId) + ", but loopProgress records " +
      (progress.baseline === undefined ? "none" : JSON.stringify(progress.baseline)),
    );
  }
  if (stop.unchanged !== stop.maxUnchanged) {
    throw malformedState(
      "the stop records " + stop.unchanged + " unchanged comparison(s) of a threshold of " +
      stop.maxUnchanged +
      " — the declared policy stops the run AT the threshold, so the counter it stopped on " +
      "is the threshold itself",
    );
  }
}

function verifyProgress(
  plan: CompiledPlan,
  loopProgress: Readonly<Record<string, OutcomeLoopProgress>>,
  stop: OutcomeStop | undefined,
): void {
  const stalledBody = stop !== undefined && stop.reason === "progress-stalled";
  for (const group of plan.loopGroups) {
    const policy = group.progress;
    if (policy === undefined) continue;
    const entry = loopProgress[group.id];
    if (entry === undefined) {
      throw malformedState(
        "loopProgress carries no entry for loop group " + JSON.stringify(group.id) +
        ", whose plan declares a progress policy",
      );
    }
    if (entry.unchanged > policy.maxUnchanged) {
      throw malformedState(
        "loopProgress[" + JSON.stringify(group.id) + "].unchanged is " + entry.unchanged +
        ", above the declared stagnation threshold " + policy.maxUnchanged +
        " — the policy stops the run at the threshold, so no writer records more",
      );
    }
    if (!stalledBody && entry.unchanged === policy.maxUnchanged) {
      throw malformedState(
        "loopProgress[" + JSON.stringify(group.id) + "].unchanged stands on the declared " +
        "stagnation threshold " + policy.maxUnchanged +
        ", but the body carries no progress-stalled stop — a run that reached the threshold " +
        "stops there",
      );
    }
  }
}

export function describeOutcomeStop(stop: OutcomeStop): string {
  switch (stop.reason) {
    case "loop-exhausted":
      return (
        "loop group " + JSON.stringify(stop.loopGroupId) +
        " reached its hard cap (round " + stop.traversals + "/" + stop.maxTraversals +
        ") at attempt " + JSON.stringify(stop.attemptId)
      );
    case "progress-stalled":
      return (
        "loop group " + JSON.stringify(stop.loopGroupId) +
        " observed " + stop.unchanged + " consecutive unchanged revision(s) (threshold " +
        stop.maxUnchanged + ", evaluator " + JSON.stringify(stop.evaluator) + " version " +
        stop.evaluatorVersion + ", subject " + JSON.stringify(stop.subject) +
        ", baseline " + JSON.stringify(stop.baseline) + ") at attempt " +
        JSON.stringify(stop.attemptId)
      );
    default: {
      const unread: never = stop;
      return "unrecognized stop " + describeValue(unread);
    }
  }
}

function describeNodeEntry(entry: OutcomeNodeState | undefined): string {
  if (entry === undefined) return "none";
  return (
    entry.status +
    (entry.attemptId === undefined ? "" : " on " + entry.attemptId) +
    (entry.outcomeId === undefined ? "" : " by " + entry.outcomeId)
  );
}

function readStateBody(
  body: Record<string, unknown>,
  plan: CompiledPlan,
  layout: OutcomeStateLayout,
): OutcomeGraphState {
  rejectUnknownBodyFields(body, layout);
  if (body.graphId !== plan.graphId) {
    throw malformedState(
      "the body names graph " + describeValue(body.graphId) + ", but the record and the plan " +
      "name " + JSON.stringify(plan.graphId),
    );
  }
  if (body.planRevision !== plan.planRevision) {
    throw malformedState(
      "the body names plan revision " + describeValue(body.planRevision) +
      ", but the record and the plan name " + JSON.stringify(plan.planRevision),
    );
  }
  const phase = layout.phases.find((declared) => declared === body.phase);
  if (phase === undefined) {
    throw malformedState(
      "phase is " + describeValue(body.phase) + ", not " + layout.phases.join(", ") +
      " — the phase vocabulary of body version " + layout.version + " is closed",
    );
  }
  const stop = readStop(body.stop, phase, layout, "the body");
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
  const nodes = plan.nodes.map((node, index) =>
    readNodeState(rawNodes[index], node, index, layout, plan),
  );
  verifyArrivals(plan, nodes);
  const loopTraversals = readLoopTraversals(body.loopTraversals, plan);
  const loopProgress = readLoopProgress(body.loopProgress, plan);
  if (stop !== undefined) {
    verifyStop(plan, nodes, loopTraversals, loopProgress, stop);
  }
  verifyProgress(plan, loopProgress, stop);
  return Object.freeze({
    bodyVersion: layout.version,
    graphId: plan.graphId,
    planRevision: plan.planRevision,
    phase,
    nodes: Object.freeze(nodes),
    loopTraversals,
    attemptSeq,
    ...(stop === undefined ? {} : { stop }),
    loopProgress,
  });
}

function stateBodyReader(
  layout: OutcomeStateLayout,
): OutcomeStateBodyReader {
  return Object.freeze({
    format: layout.version,
    read(
      body: Record<string, unknown>,
      plan: CompiledPlan,
    ): OutcomeStateBodyReading {
      try {
        return { kind: "ok", state: readStateBody(body, plan, layout) };
      } catch (error) {
        if (error instanceof OutcomeStateError) {
          return { kind: "invalid", error };
        }
        throw error;
      }
    },
  });
}

const OUTCOME_STATE_BODY_V9_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V9);

export const DEFAULT_OUTCOME_STATE_BODY_REGISTRY: OutcomeStateBodyRegistry =
  createOutcomeStateBodyRegistry({
    current: CURRENT_OUTCOME_STATE_BODY,
    formats: [
      OUTCOME_STATE_BODY_V9_READER,
    ],
  });

export function readOutcomeGraphState(
  record: GraphStateRecord,
  plan: CompiledPlan,
  registry: OutcomeStateBodyRegistry = DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
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
  const verdict = classifyOutcomeStateBody(body.bodyVersion, registry);
  if (verdict.kind === "invalid") {
    throw malformedState(
      "bodyVersion is " + describeValue(verdict.value) +
      ", not a state-body version — a persisted state body declares the layout it was " +
      "written in, and this build writes body version " + registry.current,
    );
  }
  if (verdict.kind === "unsupported") {
    throw new OutcomeStateError(
      "unsupported-state-version",
      "outcome-state: the persisted graph state declares body version " + verdict.version +
      ", but this build has no reader for it (it reads body version " +
      registry.formats.map((format) => format.format).join(", ") +
      ") — the state is refused instead of being read partially and rewritten, so nothing " +
      "was resumed and no field was dropped",
    );
  }
  const reading = verdict.reader.read(body, plan);
  if (reading.kind === "invalid") throw reading.error;
  return reading.state;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

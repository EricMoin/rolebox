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
 * EVERY ATTEMPT IS ISSUED A CREDENTIAL, AND IT LIVES IN THE STATE ENTRY. The
 * nonce comes from the injected {@link AttemptCredentialSource} (the runtime
 * injects the platform CSPRNG; a test injects a deterministic source) and is
 * written into the attempt's own persisted entry, so the binding tuple —
 * `graphId` and `planRevision` from the body, `nodeId`, `attemptId` and the
 * nonce from the entry — is reconstructed from the STATE, never from a
 * submission. A settled node KEEPS the credential of the attempt that settled
 * it (exactly as it keeps the attempt id), which is what lets a repeated
 * submission resolve to the SAME attempt and replay its receipt. Reducer
 * purity is therefore "pure given its inputs": the minting source is one
 * explicit input, so a given source reproduces a given advance.
 *
 * READING IS STRICT, VERSIONED AND TOTAL. Every persisted body declares the
 * state-body version it was written in, and `readOutcomeGraphState` accepts
 * exactly the shape that version defines — the plan's node set in plan order,
 * the closed status vocabulary, attempt ids and counters where they are
 * required, no unknown loop group, and NO field the version does not define at
 * either the body or the node level — and refuses anything else with an
 * {@link OutcomeStateError}. A version this build has no reader for is refused
 * with `unsupported-state-version` rather than read partially: the fields this
 * build does not know would be silently dropped by the next state write, so
 * the version gate comes first and a state this build cannot read is NEVER
 * reset to a clean start — the same "unknown is not fresh" discipline the
 * storage and protocol gates apply.
 *
 * VERSION 2 ADDS THE ATTEMPT CREDENTIAL, AND VERSION 1 STAYS READABLE. A
 * version-1 body records no credential, so this module can still READ it (a
 * completed graph reports cleanly), but an ATTEMPT it records can never be
 * settled: the run path refuses a submission for a credential-less attempt and
 * recovery refuses to launch one, rather than granting an attempt a credential
 * it was never issued. There is deliberately no migrator: an attempt's
 * credential is issued once, at dispatch, and inventing one on read would
 * fabricate the very binding the credential exists to prove.
 *
 * Dependency leaf on the outcome side: the compiler's plan TYPES, the ledger's
 * record TYPE and the acceptance core's decision type, all type-only, so the
 * reducer can be tested without a ledger and the runtime can own the wiring.
 */

import type { CompiledNode, CompiledPlan } from "../compiler/plan.ts";
import type { GraphStateRecord } from "../ledger/types.ts";
import type { AcceptanceDecision } from "./acceptance.ts";
import {
  attemptCredentialBinding,
  mintAttemptCredential,
  type AttemptCredentialSource,
} from "./attempt-credential.ts";

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
  /**
   * The bearer credential the runtime issued to this attempt's worker, present
   * exactly when the attempt was dispatched by a build that issues one (body
   * version 2 and later).
   *
   * A settled node keeps the credential of the attempt that settled it, so a
   * repeated submission resolves back to that same attempt. A body version
   * that does not define this field records attempts with NO credential; the
   * run path refuses to settle or relaunch such an attempt instead of deriving
   * or inventing a value (see `attempt-credential.ts` for what a bearer
   * credential does and does not prove).
   */
  readonly attemptCredential?: string;
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
  /**
   * The state-body format this snapshot is written in. A reader dispatches on
   * this value: a version with no registered reader is refused, never read
   * partially and rewritten (see {@link classifyOutcomeStateBody}).
   */
  readonly bodyVersion: number;
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

// ── The state-body format ───────────────────────────────────────────────────

/**
 * The first versioned state-body layout — what this module's writer produces
 * today and what a persisted body declares as `bodyVersion: 1`.
 */
export const OUTCOME_STATE_BODY_V1 = 1 as const;

/**
 * The second versioned state-body layout: every `dispatched` and `settled`
 * node entry carries the runtime-issued `attemptCredential` the attempt's
 * worker must present when it submits an outcome.
 *
 * This is the layout this build writes. Version 1 stays readable (a reader is
 * installed for it) but its attempts carry no credential and therefore cannot
 * be settled by this build; no migrator exists, because a credential is issued
 * at dispatch and a value invented on read would not be the one the worker
 * holds.
 */
export const OUTCOME_STATE_BODY_V2 = 2 as const;

/**
 * The state-body format this build writes.
 *
 * The body version is its OWN axis, separate from the storage format
 * (`ENGINE_PERSISTENCE_VERSION`), the execution-protocol identity and the
 * contract revision: it identifies the LAYOUT of the state body, so adding a
 * field is declaring a new body version that a reader owns — never extending a
 * version in place.
 */
export const CURRENT_OUTCOME_STATE_BODY = OUTCOME_STATE_BODY_V2;

/**
 * What reading one state body with a registered reader produced.
 *
 * `ok` carries the hydrated state; `invalid` carries the
 * {@link OutcomeStateError} the reader's own shape check raised. TOTAL by
 * contract, like a `StorageFormatDecoder.decode`: the reader answers a DATA
 * verdict for every body and never throws, so a body it rejects is reported
 * instead of escaping as an exception the caller did not model. Only a
 * non-OutcomeStateError (a programming error) still propagates.
 */
export type OutcomeStateBodyReading =
  | { readonly kind: "ok"; readonly state: OutcomeGraphState }
  | { readonly kind: "invalid"; readonly error: OutcomeStateError };

/**
 * A registered reader for exactly ONE state-body format.
 *
 * `format` is the exact body version this reader owns and `read` hydrates
 * only that layout. A version is never support by itself: the registry stores
 * capabilities, not memberships.
 */
export interface OutcomeStateBodyReader {
  /** The exact state-body version this reader hydrates. */
  readonly format: number;
  /** Read one body of exactly this format — never throws. */
  read(body: Record<string, unknown>, plan: CompiledPlan): OutcomeStateBodyReading;
}

/**
 * Installable state-body support: the exact reading CAPABILITIES this build has.
 *
 * Capability — never a numeric comparison or a bare membership check — decides
 * support, so a build that reads `1` cannot accidentally accept `2` (or any
 * other number) under a "less than current" rule. No migration capability is
 * installed for state bodies: a version this build does not read is
 * `unsupported` and recovery is blocked, never converted. The
 * decodable/migratable exclusivity `storage-format.ts` enforces therefore has
 * no second capability kind to collide with here; a future state-body migrator
 * must be registered as its own capability, and a version must stay exactly one
 * of the two.
 */
export interface OutcomeStateBodyRegistry {
  /** The body version this build writes. */
  readonly current: number;
  /** The installed readers, one per exact body version. */
  readonly formats: readonly OutcomeStateBodyReader[];
}

/** Input accepted by {@link createOutcomeStateBodyRegistry}. */
export interface OutcomeStateBodyRegistryInput {
  /** The body version this build writes. */
  readonly current: number;
  /** The readers to install; at most one per body version. */
  readonly formats: readonly OutcomeStateBodyReader[];
}

/**
 * Build a deeply frozen state-body registry from explicit reading capabilities.
 *
 * Consistency is checked HERE rather than left to the reader, because each
 * violation is a programmer error with exactly one sensible owner:
 * - a version that is not a positive safe integer — a capability names an exact
 *   LEGAL version, and an illegal discriminator is never a capability;
 * - a duplicate reader format — one exact version has exactly one read owner,
 *   otherwise which body shape is accepted would depend on array order;
 * - a `current` version with no registered reader — a build cannot write a body
 *   it could not read back, so the format it writes must be one of its own
 *   capabilities.
 *
 * Deeply frozen: the outer object, both arrays (fresh copies, so the caller's
 * arrays cannot be mutated afterwards) and every capability object. An in-place
 * edit of a frozen registry throws in strict mode, so the accepted set a reader
 * sees cannot silently move after construction.
 *
 * Throws a descriptive `Error` on the first violation.
 */
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

/**
 * Verdict for one raw `bodyVersion` value.
 *
 * - `supported` — an exact registered reader hydrates this body version. The
 *   verdict CARRIES the reader, so the caller dispatches on a capability
 *   instead of re-deriving support from a number.
 * - `unsupported` — a LEGAL version identifier with no installed reader.
 *   `version` carries the number for diagnostics and the caller REFUSES: this
 *   build must not read the body partially and write the state back, because
 *   every field it does not know would be silently dropped.
 * - `invalid` — not a version identifier at all: missing, `null`, a string, a
 *   non-integer or non-positive number, `NaN` / `Infinity`, or an integer
 *   outside the safe range. `value` carries the RAW value because it may hold
 *   any type; the caller reports it as a malformed body, never as an
 *   unknown-but-well-formed version.
 */
export type OutcomeStateBodyVerdict =
  | {
      readonly kind: "supported";
      readonly version: number;
      readonly reader: OutcomeStateBodyReader;
    }
  | { readonly kind: "unsupported"; readonly version: number }
  | { readonly kind: "invalid"; readonly value: unknown };

/**
 * Classify one persisted body version against a registry of exact reading
 * capabilities.
 *
 * Rules (the first matching rule wins) — the same shape `classifyStorageFormat`
 * applies to the storage axis:
 * 1. a value that is not a positive safe integer — missing, `null`, a string,
 *    a non-integer, zero, negative, `NaN` / `Infinity`, or an integer outside
 *    the safe range — → `invalid`, carrying the raw value: an illegal
 *    discriminator names no body version at all, so the body is malformed
 *    rather than "a newer version";
 * 2. the version of a registered reader → `supported`, carrying that reader;
 * 3. anything else → `unsupported`: a legal version identifier this build has
 *    no reader for.
 *
 * PURE by contract: no I/O, no logging, never throws.
 */
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

// ── Reading a persisted record ──────────────────────────────────────────────

/** Why a persisted graph-state body was refused. Stable identifiers. */
export type OutcomeStateProblem =
  /** The record names a different graph or plan revision than the plan in hand. */
  | "state-plan-mismatch"
  /** The body declares a state-body version this build has no reader for. */
  | "unsupported-state-version"
  /**
   * The body is not the shape its declared state-body version defines —
   * including a field that version does not define, at the body or node level.
   */
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

/**
 * One state-body layout's node shape: the fields the version defines per
 * status, and whether it requires the attempt credential the run path checks a
 * submission against.
 */
interface OutcomeNodeLayout {
  /** The exact body version this layout belongs to, for diagnostics. */
  readonly version: number;
  /** The fields the version defines, exactly, per status. */
  readonly keys: Readonly<Record<OutcomeNodeStatus, readonly string[]>>;
  /**
   * `required` — every dispatched/settled entry must carry
   * `attemptCredential`; `forbidden` — the version does not define the field.
   */
  readonly credential: "required" | "forbidden";
}

/** The node fields body version 1 defines, exactly, per status. */
const OUTCOME_NODE_LAYOUT_V1: OutcomeNodeLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V1,
  credential: "forbidden" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "dispatchedAt",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
    ]),
  }),
});

/**
 * The node fields body version 2 defines: version 1's fields plus the
 * runtime-issued `attemptCredential`, which a dispatched or settled entry
 * MUST carry and a pending entry must not.
 */
const OUTCOME_NODE_LAYOUT_V2: OutcomeNodeLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V2,
  credential: "required" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "dispatchedAt",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
    ]),
  }),
});

/**
 * Refuse every node field the declared body version does not define for this
 * status.
 *
 * An unknown field is a shape this build cannot read, not something to skip: a
 * reader that ignored it would drop it from the state it writes back. Adding a
 * field is declaring a new body version.
 */
function rejectUnknownNodeFields(
  raw: Record<string, unknown>,
  status: OutcomeNodeStatus,
  where: string,
  layout: OutcomeNodeLayout,
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

/**
 * Read one node's persisted progress against its plan declaration, in the
 * layout of the body version that declared it.
 *
 * The attempt credential is read exactly where the layout requires it: a
 * version-2 dispatched/settled entry without one is MALFORMED (the writer of
 * that version always writes it), while a version-1 entry that carries one is
 * malformed too (the version does not define the field).
 */
function readNodeState(
  raw: unknown,
  expected: CompiledNode,
  index: number,
  layout: OutcomeNodeLayout,
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
  const attemptCredential = raw.attemptCredential;
  const outcomeId = raw.outcomeId;
  const dispatchedAt = readOptionalEpoch(raw, "dispatchedAt", where);
  const settledAt = readOptionalEpoch(raw, "settledAt", where);
  if (status === "pending") {
    if (
      attemptId !== undefined ||
      attemptSeq !== undefined ||
      attemptCredential !== undefined ||
      outcomeId !== undefined ||
      dispatchedAt !== undefined ||
      settledAt !== undefined
    ) {
      throw malformedState(
        where + " is pending but carries attempt, credential, outcome or timestamp fields — a " +
          "node that was never dispatched has no attempt identity",
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
  let credential: string | undefined;
  if (layout.credential === "required") {
    if (typeof attemptCredential !== "string" || attemptCredential.length === 0) {
      throw malformedState(
        where + ".attemptCredential is " + describeValue(attemptCredential) +
          ", not the non-empty attempt credential body version " + layout.version +
          " requires on a " + status + " node",
      );
    }
    credential = attemptCredential;
  } else if (attemptCredential !== undefined) {
    // Unreachable through rejectUnknownNodeFields; kept so the rule does not
    // depend on the key set alone.
    throw malformedState(
      where + " carries an attempt credential, which body version " + layout.version +
        " does not define",
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
      ...(credential === undefined ? {} : { attemptCredential: credential }),
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
    ...(credential === undefined ? {} : { attemptCredential: credential }),
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
 * The BODY-level fields every registered layout defines, exactly — what the
 * writer produces. Version 2 adds a NODE-level field only, so both layouts
 * share this list.
 */
const OUTCOME_STATE_BODY_V1_KEYS: readonly string[] = Object.freeze([
  "bodyVersion",
  "graphId",
  "planRevision",
  "phase",
  "nodes",
  "loopTraversals",
  "attemptSeq",
]);

/**
 * Refuse every body field the layouts this build reads do not define.
 *
 * An unknown field is a shape this build cannot read, not something to skip: a
 * reader that ignored it would drop it from the state it writes back. Adding a
 * field is declaring a new body version, and a version this build does not read
 * is refused before any field is examined. Every layout this build registers
 * defines the same BODY-level fields (version 2 adds a node-level field), so
 * this check is deliberately version-independent.
 */
function rejectUnknownBodyFields(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (!OUTCOME_STATE_BODY_V1_KEYS.includes(key)) {
      throw malformedState(
        "the body carries field " + JSON.stringify(key) + ", which the registered state-body " +
          "layouts do not define — an unknown field is refused rather than dropped; adding a " +
          "field is a new body version",
      );
    }
  }
}

/**
 * Read one body in the node layout its declared version owns — the shape that
 * version's writer produces.
 *
 * STRICT: every field must be the value that version's writer would have
 * written, at the body and the node level, and the plan's node list must match
 * position by position. Anything else throws an {@link OutcomeStateError} with
 * problem `malformed-state`. The total capability the registry installs turns
 * that throw into a reading, so this function is the RAW shape check.
 */
function readStateBody(
  body: Record<string, unknown>,
  plan: CompiledPlan,
  layout: OutcomeNodeLayout,
): OutcomeGraphState {
  rejectUnknownBodyFields(body);
  // The body carries the record's identity redundantly. A body that disagrees
  // with the plan is refused rather than read and rewritten with the plan's
  // value — silently correcting a field is the same class of loss as dropping
  // one.
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
  const nodes = plan.nodes.map((node, index) =>
    readNodeState(rawNodes[index], node, index, layout),
  );
  return Object.freeze({
    bodyVersion: layout.version,
    graphId: plan.graphId,
    planRevision: plan.planRevision,
    phase,
    nodes: Object.freeze(nodes),
    loopTraversals: readLoopTraversals(body.loopTraversals, plan),
    attemptSeq,
  });
}

/**
 * One read capability per registered layout: one exact version and one TOTAL
 * reader.
 *
 * The shape check raises its own {@link OutcomeStateError}; this wrapper turns
 * that refusal into the reading the registry contract promises, so a body the
 * reader rejects is reported as data. Anything that is not an
 * OutcomeStateError is a programming error and still propagates.
 */
function stateBodyReader(
  layout: OutcomeNodeLayout,
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

const OUTCOME_STATE_BODY_V1_READER = stateBodyReader(OUTCOME_NODE_LAYOUT_V1);
const OUTCOME_STATE_BODY_V2_READER = stateBodyReader(OUTCOME_NODE_LAYOUT_V2);

/**
 * The state-body capabilities this build installs: version 2 (what it writes)
 * and version 1 (readable, credential-less — its attempts are refused by the
 * run path, never migrated).
 */
export const DEFAULT_OUTCOME_STATE_BODY_REGISTRY: OutcomeStateBodyRegistry =
  createOutcomeStateBodyRegistry({
    current: CURRENT_OUTCOME_STATE_BODY,
    formats: [OUTCOME_STATE_BODY_V1_READER, OUTCOME_STATE_BODY_V2_READER],
  });

/**
 * Read one persisted record as this plan's state.
 *
 * STRICT, VERSIONED and TOTAL. The identity fields must agree with the plan in
 * hand; the body must declare a state-body version this build has a registered
 * reader for; and the body must be exactly the shape that version defines —
 * every field the value its writer would have written, at the body and the node
 * level, with no field the version does not define. Anything else throws an
 * {@link OutcomeStateError}: a version this build cannot read is refused with
 * `unsupported-state-version` rather than trimmed (the fields it does not know
 * would be lost on the next write), and a state this build cannot read is never
 * guessed at and never silently replaced.
 */
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
  | "state-ledger-disagreement"
  /**
   * The state was written in a body layout that cannot carry the attempt
   * credential this build issues for every attempt. The advance is refused
   * rather than converting the state into a newer layout: a version-1 attempt
   * has no credential, so nothing may settle it or re-arm over it.
   */
  | "unsupported-state-version";

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
  /** The credential minted for this fresh attempt (see {@link OutcomeAdvanceInput}). */
  readonly credential: string;
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
  /**
   * Mints the attempt credential for every attempt this advance arms. It is an
   * explicit input because minting is not derivable from the plan or the state:
   * the runtime injects its CSPRNG-backed source, a test injects a deterministic
   * one, and an advance is reproducible for a given source.
   */
  readonly mintCredential: AttemptCredentialSource;
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
 * PURE GIVEN ITS INPUTS: it reads the plan, the state, the decision and the
 * injected credential source, and returns the next state plus the successors to
 * arm. It never writes, never reads a clock of its own and never re-validates
 * the outcome (the acceptance core owns that). Reproducibility is stated
 * against the source: the same inputs and the same source produce the same
 * advance.
 *
 * The rules, in order:
 * 0. the state must be written in the CURRENT body layout — a version that
 *    cannot carry attempt credentials is refused instead of being advanced and
 *    rewritten in a newer one;
 * 1. the decision's node must be a plan node, currently dispatched, on the
 *    attempt the decision names — otherwise the acceptance does not describe
 *    the state in hand and the advance is refused;
 * 2. a terminal outcome settles the node and arms nothing;
 * 3. any other outcome must route somewhere (the plan's terminal list is the
 *    complement of its edges, so a non-terminal with no edge is a defect);
 * 4. a declared loop continuation advances that group's counter and refuses
 *    when the hard cap would be exceeded — one round past the cap is never run;
 * 5. every successor is armed with a FRESH attempt minted from the graph-wide
 *    counter AND a fresh credential from the injected source; a settled
 *    successor is re-armed only when source and target share a declared loop
 *    group.
 */
export function advanceOutcomeGraph(input: OutcomeAdvanceInput): OutcomeAdvance {
  const { plan, state, decision, now } = input;
  if (state.bodyVersion !== CURRENT_OUTCOME_STATE_BODY) {
    throw new OutcomeAdvanceRefusedError(
      "unsupported-state-version",
      "outcome-advance: the state was written in body version " + state.bodyVersion +
        ", which cannot carry the attempt credential this build issues for every attempt — " +
        "the state is refused rather than advanced and rewritten in body version " +
        CURRENT_OUTCOME_STATE_BODY,
    );
  }
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
    // The credential of the attempt that SETTLED the node is kept, exactly as
    // its attempt id is: a repeated submission must resolve back to this same
    // attempt (and its receipt), never to a newer one.
    ...(current.attemptCredential === undefined
      ? {}
      : { attemptCredential: current.attemptCredential }),
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
      // The credential is issued WITH the attempt and persisted on its entry,
      // so the binding a submission is checked against comes from the state —
      // never from the submission, and never re-derived from the attempt id.
      const credential = mintAttemptCredential(
        input.mintCredential,
        attemptCredentialBinding({
          graphId: plan.graphId,
          nodeId: targetNode.id,
          attemptId,
          planRevision: plan.planRevision,
        }),
      );
      nodes[targetIndex] = Object.freeze({
        nodeId: targetNode.id,
        status: "dispatched" as const,
        attemptId,
        attemptSeq,
        attemptCredential: credential,
        dispatchedAt: now,
      });
      dispatches.push(
        Object.freeze({
          nodeId: targetNode.id,
          attemptId,
          agent: targetNode.agent,
          prompt: targetNode.prompt,
          credential,
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
      // The guard above admitted only the current layout, so the advanced state
      // is written in it (a new attempt always carries a credential).
      bodyVersion: CURRENT_OUTCOME_STATE_BODY,
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

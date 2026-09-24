/**
 * Graph outcome — assembling a node's downstream input (§3.5, P4 item 5 / A17)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * A node declares WHICH accepted results it consumes; the compiler pins those
 * references (`CompiledInputRef`, refused unless they name a declared outcome of
 * an upstream node). This module is the other half: given those fixed references
 * and the facts the run actually holds, it decides what the node receives — or
 * REFUSES to dispatch it.
 *
 * PURE BY CONSTRUCTION. It reads no clock, no file and no store: the caller
 * supplies the settled attempt per node and a lookup that answers what that
 * attempt accepted. That keeps the RULES here (which every caller must apply
 * identically) separate from the I/O that fetches the facts.
 *
 * WHAT A RESOLVED INPUT CARRIES, AND WHY THE DATA IS PART OF IT. An input is
 * not a list of artifact identities: the consumer has to be able to answer what
 * the producer ACCEPTED, with a submission that carried no `data` at all kept
 * distinct from one that accepted JSON `null`, `{}` or `""` (D1's
 * {@link AcceptedData}). Both halves travel together — the accepted data and
 * the revisions the acceptance retained — and both are bound to the ATTEMPT
 * that produced them, so a later read never has to re-derive which attempt a
 * consumer received.
 *
 * THE RULES, and why each is a refusal rather than a fallback:
 *
 * - every declared input must name a node that SETTLED — an unaccepted
 *   dependency is not an absent value, it is a dispatch that would run against
 *   something nobody produced;
 * - the accepted OUTCOME must be the one the reference pinned. A producer that
 *   settled on a different declared outcome did not produce this consumer's
 *   input, and the plan's own routing already accounts for that branch;
 * - the accepted result must be READABLE. A row this build cannot decode — or a
 *   substrate that cannot answer at all — is a named refusal, never an empty
 *   value and never a partially read one: the consumer would otherwise run
 *   against a hole that looks like an input;
 * - the accepted result must have RETAINED the artifact the consumer needs. The
 *   mutable path a reference once named is never read here: by dispatch time it
 *   may hold a different revision, and delivering that is the whole defect this
 *   chain exists to make impossible;
 * - an artifact is addressed by (PRODUCER, reference), never by a bare
 *   reference. Two producers may each retain `report.txt` with different bytes,
 *   so "the first entry that retained this ref" would make what a consumer
 *   receives depend on list order. A producer with no entry, a producer that
 *   retained nothing for the reference, and one address that names more than one
 *   content identity are each a NAMED refusal instead.
 *
 * A blocked input is a BLOCKED DISPATCH, reported by name — never a node started
 * with a hole where its input should be.
 *
 * Dependency leaf: the compiler's reference type and nothing else.
 */

import type { CompiledInputRef } from "../compiler/plan.ts";
import type { ArtifactObjectRead } from "../store/artifacts.ts";
import type {
  AcceptedArtifact,
  AcceptedData,
  JsonValue,
} from "../domain/model.ts";

/** What one settled attempt accepted, as the caller can observe it. */
export interface AcceptedResultFacts {
  /** The outcome the attempt SETTLED on — the plan's routing identity. */
  readonly outcomeId: string;
  /**
   * The data the acceptance recorded, with its presence made explicit
   * ({@link AcceptedData}): `absent` for a submission that carried no `data`,
   * `value` for one that carried `null`, `{}`, `""` or anything else.
   */
  readonly payload: AcceptedData;
  /** The artifact revisions the acceptance retained. */
  readonly artifacts: readonly AcceptedArtifact[];
}

/**
 * What looking up one attempt's accepted result answered.
 *
 * THREE ANSWERS, because the caller's reaction differs and collapsing them
 * would guess: `facts` is what the attempt accepted, `none` is "this attempt
 * accepted nothing" (it never settled, or the substrate holds no row for it),
 * and `unreadable` is "the read could not be made" — a substrate that exposes
 * no read, a damaged row, or one whose read threw. The last one is a REFUSAL
 * rather than an absent value: handing a consumer an empty input where a
 * recorded result may exist is exactly the hole this chain forbids.
 *
 * Whether "the substrate holds no accepted results at all" is itself a gap the
 * caller must report is deliberately NOT decided here: this module reads the
 * answer it is given and never a store, so the caller that owns the read owns
 * that judgement.
 */
export type AcceptedResultReading =
  | { readonly kind: "facts"; readonly facts: AcceptedResultFacts }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * One declared input, resolved to the exact revision the acceptance recorded.
 *
 * `attemptId` is the identity every later read is bound to, so a consumer never
 * has to re-derive which attempt produced what it received, and `payload`
 * carries WHAT was accepted so the presence distinction survives all the way to
 * the consumer.
 */
export interface ResolvedInput {
  readonly from: string;
  readonly outcome: string;
  readonly attemptId: string;
  /** The accepted data of the producing attempt ({@link AcceptedData}). */
  readonly payload: AcceptedData;
  readonly artifacts: readonly AcceptedArtifact[];
}

/**
 * The refusal codes this build defines, in canonical order — the ONE source a
 * reader and a writer share, so a persisted refusal is validated against the
 * same closed vocabulary the assembler produces.
 */
export const DOWNSTREAM_INPUT_REFUSAL_CODES = Object.freeze([
  /** No settled attempt for the producer, or it recorded no accepted result. */
  "input-producer-unsettled",
  /** The producer settled on another declared outcome than the one pinned. */
  "input-outcome-mismatch",
  /** The acceptance retained no artifact for the reference. */
  "input-artifact-missing",
  /** A result is recorded (or a read is missing) and cannot be read (D6). */
  "input-result-unreadable",
] as const);

/** One named reason a declared input could not be resolved. */
export type DownstreamInputRefusalCode =
  (typeof DOWNSTREAM_INPUT_REFUSAL_CODES)[number];

/** Why one declared input could not be resolved. */
export interface DownstreamInputRefusal {
  readonly from: string;
  readonly outcome: string;
  readonly code: DownstreamInputRefusalCode;
  readonly message: string;
}

/** What a node's declared inputs assembled to. */
export type DownstreamInput =
  | { readonly kind: "resolved"; readonly entries: readonly ResolvedInput[] }
  | { readonly kind: "blocked"; readonly refusals: readonly DownstreamInputRefusal[] };

/**
 * Assemble one node's declared inputs, or refuse the dispatch.
 *
 * TOTAL: every way a declared input can fail is a named refusal, and ANY refusal
 * blocks — a node with three inputs and one missing one has no input at all.
 */
export function assembleDownstreamInput(
  inputs: readonly CompiledInputRef[],
  settledAttemptOf: (nodeId: string) => string | undefined,
  acceptedOf: (attemptId: string) => AcceptedResultReading,
): DownstreamInput {
  if (inputs.length === 0) {
    return { kind: "resolved", entries: Object.freeze([]) };
  }
  const entries: ResolvedInput[] = [];
  const refusals: DownstreamInputRefusal[] = [];
  for (const input of inputs) {
    const attemptId = settledAttemptOf(input.from);
    if (attemptId === undefined) {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-producer-unsettled" as const,
          message:
            "this node consumes the accepted result of " +
            JSON.stringify(input.from) +
            "/" +
            JSON.stringify(input.outcome) +
            ", but that node has no settled attempt — an unaccepted dependency is not an absent value, it is a dispatch that would run against something nobody produced",
        }),
      );
      continue;
    }
    const accepted = acceptedOf(attemptId);
    if (accepted.kind === "unreadable") {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-result-unreadable" as const,
          message:
            "attempt " +
            JSON.stringify(attemptId) +
            " of node " +
            JSON.stringify(input.from) +
            " could not be resolved to its accepted result: " +
            accepted.reason +
            " — a consumer is never handed an empty or half-read value where a recorded " +
            "result may exist, so the dispatch is refused instead",
        }),
      );
      continue;
    }
    if (accepted.kind === "none") {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-producer-unsettled" as const,
          message:
            "attempt " +
            JSON.stringify(attemptId) +
            " of node " +
            JSON.stringify(input.from) +
            " has no accepted result, so it produced nothing this node may consume",
        }),
      );
      continue;
    }
    const facts = accepted.facts;
    if (facts.outcomeId !== input.outcome) {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-outcome-mismatch" as const,
          message:
            "node " +
            JSON.stringify(input.from) +
            " settled on outcome " +
            JSON.stringify(facts.outcomeId) +
            ", not " +
            JSON.stringify(input.outcome) +
            " — a producer that settled on another declared outcome did not produce this consumer's input",
        }),
      );
      continue;
    }
    entries.push(
      Object.freeze({
        from: input.from,
        outcome: input.outcome,
        attemptId,
        payload: facts.payload,
        artifacts: facts.artifacts,
      }),
    );
  }
  if (refusals.length > 0) return { kind: "blocked", refusals: Object.freeze(refusals) };
  return { kind: "resolved", entries: Object.freeze(entries) };
}

/**
 * The address of one retained artifact: WHICH producer, and the reference it
 * declared.
 *
 * Both halves are required, and a bare reference is deliberately not
 * expressible: a reference alone does not identify a revision once two
 * producers can retain the same one.
 */
export interface ResolvedArtifactAddress {
  /** The node that produced the accepted result this artifact belongs to. */
  readonly from: string;
  /** The reference that producer's acceptance retained, exactly as declared. */
  readonly ref: string;
}

/**
 * Read one resolved input's retained artifact BYTES, addressed by
 * (producer, reference).
 *
 * Kept beside the assembly so a consumer has exactly one way to reach the bytes:
 * the identity the acceptance recorded, never the reference's path. A missing or
 * tampered object is the store's own named problem, returned unchanged.
 *
 * TOTAL: the two ways an address can fail to name exactly one revision — no
 * producer entry or no retained artifact for the reference, and the SAME address
 * retained under two content identities — are named problems rather than a
 * first-match answer, because a first match would let list order decide which
 * revision a consumer receives.
 */
export function readResolvedArtifact(
  entries: readonly ResolvedInput[],
  address: ResolvedArtifactAddress,
  readById: (artifactId: string) => ArtifactObjectRead,
): ArtifactObjectRead {
  let producerFound = false;
  let retained = false;
  let identity: string | undefined;
  let conflictingIdentity: string | undefined;
  for (const entry of entries) {
    if (entry.from !== address.from) continue;
    producerFound = true;
    for (const artifact of entry.artifacts) {
      if (artifact.ref !== address.ref) continue;
      retained = true;
      if (identity === undefined) {
        identity = artifact.artifactId;
      } else if (identity !== artifact.artifactId) {
        conflictingIdentity = artifact.artifactId;
      }
    }
  }
  if (!producerFound) {
    return {
      kind: "problem",
      reason:
        "no resolved input names producer " +
        JSON.stringify(address.from) +
        " — an artifact is addressed by (producer, reference), so a producer with no entry is refused rather than searched for the reference alone",
    };
  }
  if (!retained || identity === undefined) {
    return {
      kind: "problem",
      reason:
        "producer " +
        JSON.stringify(address.from) +
        " retained no artifact for reference " +
        JSON.stringify(address.ref) +
        " — a reference the acceptance did not retain is REFUSED, never resolved from the path",
    };
  }
  if (conflictingIdentity !== undefined) {
    return {
      kind: "problem",
      reason:
        "producer " +
        JSON.stringify(address.from) +
        " retained reference " +
        JSON.stringify(address.ref) +
        " under more than one content identity (" +
        identity +
        " and " +
        conflictingIdentity +
        ") — which revision a consumer would receive would depend on list order, so the ambiguous address is REFUSED rather than resolved by position",
    };
  }
  return readById(identity);
}

// ── The persisted shape of a bound input view ───────────────────────────────

/**
 * Whether a value is a non-array record.
 *
 * The state body carries the bound input view as JSON and the dispatch effect
 * payload carries it as JSON too, so BOTH readers below live here, beside the
 * type they materialize: one spelling of the wire shape means a body the state
 * reader accepts is exactly a payload the dispatch reader accepts.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a record carries exactly the named keys — no more, no fewer. */
function hasExactKeys(
  record: Record<string, unknown>,
  names: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}

/** The fields one {@link ResolvedInput} defines, exactly. */
const RESOLVED_INPUT_KEYS: readonly string[] = Object.freeze([
  "from",
  "outcome",
  "attemptId",
  "payload",
  "artifacts",
]);

/** The fields one {@link AcceptedArtifact} defines, exactly. */
const ACCEPTED_ARTIFACT_KEYS: readonly string[] = Object.freeze([
  "ref",
  "artifactId",
  "digest",
  "size",
]);

/** The fields one {@link DownstreamInputRefusal} defines, exactly. */
const DOWNSTREAM_INPUT_REFUSAL_KEYS: readonly string[] = Object.freeze([
  "from",
  "outcome",
  "code",
  "message",
]);

/** What reading a persisted bound-input list produced. */
export type ResolvedInputsReading =
  | { readonly kind: "ok"; readonly entries: readonly ResolvedInput[] }
  | { readonly kind: "malformed"; readonly message: string };

/** What reading a persisted refusal list produced. */
export type InputRefusalsReading =
  | { readonly kind: "ok"; readonly refusals: readonly DownstreamInputRefusal[] }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * Read a persisted BOUND INPUT VIEW — the list of accepted revisions an attempt
 * was armed with (D6) — from the JSON that carries it.
 *
 * TOTAL by contract: every shape it cannot read is a `malformed` verdict with a
 * message, never a throw and never a partial list, so the caller that owns the
 * refusal vocabulary (the state reader, the dispatch-payload reader) decides how
 * to refuse. `where` is the caller's path prefix, so a diagnostic names the
 * field in ITS container.
 *
 * The accepted data is read as the domain's presence envelope, checked EXACTLY:
 * a body carrying the bare payload of a pre-v7 format is refused rather than
 * read as a `value`, because "absent" and "null" would otherwise be
 * indistinguishable again on the way back in.
 */
export function readResolvedInputs(
  raw: unknown,
  where: string,
): ResolvedInputsReading {
  if (!Array.isArray(raw)) {
    return { kind: "malformed", message: where + " is " + describe(raw) + ", not a list" };
  }
  const entries: ResolvedInput[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const reading = readOneResolvedInput(raw[index], where + "[" + index + "]");
    if (reading.kind === "malformed") return reading;
    entries.push(reading.entry);
  }
  return { kind: "ok", entries: Object.freeze(entries) };
}

/** What reading one entry of a bound-input list produced. */
type ResolvedInputEntryReading =
  | { readonly kind: "ok"; readonly entry: ResolvedInput }
  | { readonly kind: "malformed"; readonly message: string };

/** Read exactly one {@link ResolvedInput}. */
function readOneResolvedInput(
  raw: unknown,
  at: string,
): ResolvedInputEntryReading {
  if (!isRecord(raw) || !hasExactKeys(raw, RESOLVED_INPUT_KEYS)) {
    return {
      kind: "malformed",
      message:
        at + " is " + describe(raw) + ", not the { " + RESOLVED_INPUT_KEYS.join(", ") +
        " } record a bound input is",
    };
  }
  const from = raw.from;
  const outcome = raw.outcome;
  const attemptId = raw.attemptId;
  if (
    typeof from !== "string" || from.length === 0 ||
    typeof outcome !== "string" || outcome.length === 0 ||
    typeof attemptId !== "string" || attemptId.length === 0
  ) {
    return {
      kind: "malformed",
      message:
        at + " carries a producer, outcome and attempt that are not all non-empty strings",
    };
  }
  const payload = readAcceptedData(raw.payload, at + ".payload");
  if (payload.kind === "malformed") return payload;
  const rawArtifacts = raw.artifacts;
  if (!Array.isArray(rawArtifacts)) {
    return {
      kind: "malformed",
      message:
        at + ".artifacts is " + describe(rawArtifacts) +
        ", not the list of retained revisions a bound input carries",
    };
  }
  const artifacts: AcceptedArtifact[] = [];
  for (let index = 0; index < rawArtifacts.length; index += 1) {
    const reading = readAcceptedArtifact(rawArtifacts[index], at + ".artifacts[" + index + "]");
    if (reading.kind === "malformed") return reading;
    artifacts.push(reading.artifact);
  }
  return {
    kind: "ok",
    entry: Object.freeze({
      from,
      outcome,
      attemptId,
      payload: payload.value,
      artifacts: Object.freeze(artifacts),
    }),
  };
}

/** What reading one persisted accepted-data envelope produced. */
type AcceptedDataValueReading =
  | { readonly kind: "ok"; readonly value: AcceptedData }
  | { readonly kind: "malformed"; readonly message: string };

/** What reading one persisted artifact revision produced. */
type AcceptedArtifactReading =
  | { readonly kind: "ok"; readonly artifact: AcceptedArtifact }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * Read the persisted accepted-data envelope.
 *
 * The `JsonValue` assertion is discharged by the boundary that produced the
 * value: this reader is reached through a state body or an effect payload the
 * ledger read back from its JSON column, so every reachable value is what
 * `JSON.parse` produced.
 */
function readAcceptedData(
  raw: unknown,
  at: string,
): AcceptedDataValueReading {
  if (!isRecord(raw)) {
    return {
      kind: "malformed",
      message:
        at + " is " + describe(raw) +
        ", not the accepted-data envelope this format writes ({\"kind\":\"absent\"} or " +
        "{\"kind\":\"value\",\"value\":…})",
    };
  }
  const kind = raw.kind;
  if (kind === "absent" && hasExactKeys(raw, ["kind"])) {
    return { kind: "ok", value: Object.freeze({ kind: "absent" as const }) };
  }
  if (kind === "value" && hasExactKeys(raw, ["kind", "value"])) {
    return {
      kind: "ok",
      value: Object.freeze({ kind: "value" as const, value: raw.value as JsonValue }),
    };
  }
  return {
    kind: "malformed",
    message:
      at + " carries keys [" +
      Object.keys(raw).map((key) => JSON.stringify(key)).join(", ") +
      "] with kind " + describe(kind) +
      ", not the accepted-data envelope this format writes ({\"kind\":\"absent\"} or " +
      "{\"kind\":\"value\",\"value\":…})",
  };
}

/** Read exactly one {@link AcceptedArtifact}. */
function readAcceptedArtifact(
  raw: unknown,
  at: string,
): AcceptedArtifactReading {
  if (!isRecord(raw) || !hasExactKeys(raw, ACCEPTED_ARTIFACT_KEYS)) {
    return {
      kind: "malformed",
      message:
        at + " is " + describe(raw) + ", not the { " + ACCEPTED_ARTIFACT_KEYS.join(", ") +
        " } record an accepted artifact revision is",
    };
  }
  const ref = raw.ref;
  const artifactId = raw.artifactId;
  const digest = raw.digest;
  const size = raw.size;
  if (
    typeof ref !== "string" || ref.length === 0 ||
    typeof artifactId !== "string" || artifactId.length === 0 ||
    typeof digest !== "string" || digest.length === 0 ||
    typeof size !== "number" || !Number.isSafeInteger(size) || size < 0
  ) {
    return {
      kind: "malformed",
      message:
        at + " carries a reference, identity, digest and size that are not a non-empty " +
        "string triple and a non-negative size",
    };
  }
  return { kind: "ok", artifact: Object.freeze({ ref, artifactId, digest, size }) };
}

/**
 * Read a persisted REFUSAL list — why a node's dispatch was not armed (D6).
 *
 * The code is checked against the closed vocabulary this build produces, so a
 * record carrying a code this build does not define is refused rather than
 * reported as a refusal nobody can interpret.
 */
export function readInputRefusals(
  raw: unknown,
  where: string,
): InputRefusalsReading {
  if (!Array.isArray(raw)) {
    return { kind: "malformed", message: where + " is " + describe(raw) + ", not a list" };
  }
  const refusals: DownstreamInputRefusal[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const at = where + "[" + index + "]";
    const entry: unknown = raw[index];
    if (!isRecord(entry) || !hasExactKeys(entry, DOWNSTREAM_INPUT_REFUSAL_KEYS)) {
      return {
        kind: "malformed",
        message:
          at + " is " + describe(entry) + ", not the { " +
          DOWNSTREAM_INPUT_REFUSAL_KEYS.join(", ") + " } record a named input refusal is",
      };
    }
    const from = entry.from;
    const outcome = entry.outcome;
    const message = entry.message;
    if (
      typeof from !== "string" || from.length === 0 ||
      typeof outcome !== "string" || outcome.length === 0 ||
      typeof message !== "string" || message.length === 0
    ) {
      return {
        kind: "malformed",
        message: at + " carries a producer, outcome and message that are not all non-empty strings",
      };
    }
    const rawCode = entry.code;
    const code =
      typeof rawCode === "string"
        ? DOWNSTREAM_INPUT_REFUSAL_CODES.find((declared) => declared === rawCode)
        : undefined;
    if (code === undefined) {
      return {
        kind: "malformed",
        message:
          at + ".code is " + describe(rawCode) + ", not " +
          DOWNSTREAM_INPUT_REFUSAL_CODES.join(", ") + " — the refusal vocabulary is closed",
      };
    }
    refusals.push(Object.freeze({ from, outcome, code, message }));
  }
  return { kind: "ok", refusals: Object.freeze(refusals) };
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}


/**
 * THE HOST-DERIVED completion channel: an outcome the WORKER'S OWN LAST TURN
 * declared, delivered by the HOST after an execution ended without presenting
 * an outcome, authenticated by the host's durable execution record and settled
 * WITHOUT a bearer credential.
 *
 * WHY THE CHANNEL EXISTS. A worker can stop producing — a timeout, a killed
 * process, a provider that returned no final submission — and its execution then
 * ends without an outcome ever reaching the runtime. The outcome is not
 * INVENTED to fill that gap: the worker's own final turn declared it, the host
 * reads the declaration from the turn it already holds, and this module is the
 * CLOSED envelope that carries it to the runtime. "An announcement is not an
 * outcome" still holds, because an announcement is exactly what crosses this
 * boundary: the PLAN decides whether the named outcome exists (an undeclared
 * outcome is refused by the acceptance core) and whether it passes its declared
 * gates (a failing gate is a REJECTION, and the attempt stays open).
 *
 * THREE PROPERTIES, EACH STRUCTURAL RATHER THAN CONVENTIONAL:
 * - CREDENTIAL-FREE. No proposal built here can carry a `credential`: the fact's
 *   shape has no such field, and an unknown key is refused BY NAME, so a value
 *   that tries to present a bearer alongside the declaration is refused before
 *   the plan, the authority or the ledger is consulted. The channel is
 *   authenticated by the host's own durable execution record instead — the same
 *   record the natural-completion channel corroborates against — which is what
 *   lets a lost bearer be irrelevant without being re-issued.
 * - HOST-AUTHENTICATED. The fact names the execution the host created for the
 *   attempt; the runtime settles only against the host's OWN record of that
 *   execution, never against the delivery's word.
 * - CLOSED. Exactly the seven keys below, one of which is the outcome the
 *   worker's turn declared. `data` is deliberately unconstrained: whether a
 *   payload is representable is the canonical digest's question, exactly as it
 *   is for an ordinary proposal, so this shape gate never judges it.
 *
 * NOTHING HERE CHOOSES AN OUTCOME. The fact carries the declared outcome id
 * verbatim; there is no default, no repair and no synthesis, and the runtime
 * refuses the channel outright for a node whose plan pinned a natural completion
 * (see `derived-completion-natural-node` in `runtime-contract.ts`).
 */
import { errorText } from "../../utils/error-text.ts";
import type { OutcomeProposal } from "./proposal.ts";
import { describeValue } from "./runtime-refusals.ts";

// ── The delivery envelope ───────────────────────────────────────────────────

/**
 * Where in the worker's own turn stream the declaration was read.
 *
 * Two non-negative indices, and nothing else: they are EVIDENCE of which turn
 * produced the outcome (so the host's derivation can be audited against the
 * turn it names), never a second outcome selector and never a payload.
 */
export interface HostDerivedDerivation {
  /** The index of the recorded event the declaration was read from. */
  readonly eventIndex: number;
  /** The index of the turn within that event. */
  readonly turnIndex: number;
}

/**
 * What the host's DERIVED-COMPLETION bridge delivers for one attempt.
 *
 * `nodeId` and `attemptId` name the attempt the fact is about — they are
 * resolved against the persisted state and the host's durable execution record
 * and are NEVER used to select an attempt — `executionId` is the execution the
 * host created for it, and `outcomeId` is the outcome the worker's own last
 * turn declared. `data` and `evidenceRefs` are the declaration's own payload
 * and references, carried through unjudged; `derivation` is the host's
 * indication of which turn declared it.
 *
 * THERE IS NO `credential`. This channel is authenticated by the host's durable
 * record of the execution, and a value offering a bearer is refused with the
 * unknown-key rule below rather than settled under whichever proof it presented.
 */
export interface HostDerivedCompletionFact {
  /** The node the attempt belongs to; never used to select an attempt. */
  readonly nodeId: string;
  /** The attempt that ended; resolved against the persisted state. */
  readonly attemptId: string;
  /** The host's own execution id for that attempt. */
  readonly executionId: string;
  /** The outcome the worker's OWN last turn declared. */
  readonly outcomeId: string;
  /** The declaration's payload, opaque here; the gates judge it. */
  readonly data?: unknown;
  /** The declaration's evidence references, in any order. */
  readonly evidenceRefs?: readonly string[];
  /** Which of the worker's turns declared the outcome, when the host says. */
  readonly derivation?: HostDerivedDerivation;
}

/** The keys a fact may carry; anything else is an unknown key. */
const FACT_KEYS: readonly string[] = [
  "nodeId",
  "attemptId",
  "executionId",
  "outcomeId",
  "data",
  "evidenceRefs",
  "derivation",
];

/** The keys a `derivation` may carry; anything else is an unknown key. */
const DERIVATION_KEYS: readonly string[] = ["eventIndex", "turnIndex"];

/** One shape violation of a raw host-derived delivery. */
export interface HostDerivedCompletionIssue {
  /** Stable code; the run path reports it as `malformed-host-derived-completion`. */
  readonly code: "malformed-host-derived-completion";
  /** Location, e.g. `$.credential` or `$.derivation.turnIndex`. */
  readonly path: string;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
}

/** The shape gate's verdict over an untrusted value. */
export type HostDerivedCompletionReading =
  | { readonly kind: "ok"; readonly fact: HostDerivedCompletionFact }
  | {
    readonly kind: "malformed";
    readonly issues: readonly HostDerivedCompletionIssue[];
  };

/**
 * Read an untrusted value as a {@link HostDerivedCompletionFact}.
 *
 * TOTAL: every rejection is a structured issue, and a property read that throws
 * (an accessor, a hostile Proxy) is contained as one more malformed issue
 * rather than escaping.
 *
 * The shape is CLOSED. `nodeId`, `attemptId`, `executionId` and `outcomeId`
 * must be non-empty strings, `evidenceRefs` — when supplied — must be an array
 * of non-empty strings, `derivation` — when supplied — must carry exactly two
 * non-negative safe integers, `data` is deliberately unconstrained, and any
 * other key is refused BY NAME. That last rule is the no-credential guarantee:
 * a `credential`, or any future field a caller tries to smuggle alongside the
 * declaration, is rejected here, before the plan, the authority or the ledger
 * is consulted — a fact that could carry a bearer would be a second submission
 * channel.
 */
export function readHostDerivedCompletionFact(
  value: unknown,
): HostDerivedCompletionReading {
  const issues: HostDerivedCompletionIssue[] = [];
  const malformed = (path: string, message: string): void => {
    issues.push({ code: "malformed-host-derived-completion", path, message });
  };
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        kind: "malformed",
        issues: [
          {
            code: "malformed-host-derived-completion",
            path: "$",
            message:
              "a host-derived completion is a record of { nodeId, attemptId, executionId, " +
              "outcomeId, data?, evidenceRefs?, derivation? }, received " +
              describeValue(value),
          },
        ],
      };
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!FACT_KEYS.includes(key)) {
        malformed(
          "$." + key,
          "unknown key " +
            JSON.stringify(key) +
            " — a host-derived completion carries only nodeId, attemptId, executionId, " +
            "outcomeId, data, evidenceRefs and derivation, and an unrecognized field is " +
            "refused rather than dropped: this channel is authenticated by the host's durable " +
            "execution record and never reads a bearer value, so a `credential` (or any other " +
            "smuggled field) is refused by name",
        );
      }
    }
    // Read each field EXACTLY ONCE into a local, so an accessor-backed record
    // cannot answer one value to the check and another to the construction.
    const nodeId = typeof record.nodeId === "string" ? record.nodeId : "";
    if (nodeId.length === 0) {
      malformed(
        "$.nodeId",
        "nodeId is " + describeValue(record.nodeId) + ", not a non-empty node id",
      );
    }
    const attemptId =
      typeof record.attemptId === "string" ? record.attemptId : "";
    if (attemptId.length === 0) {
      malformed(
        "$.attemptId",
        "attemptId is " +
          describeValue(record.attemptId) +
          ", not a non-empty attempt id",
      );
    }
    const executionId =
      typeof record.executionId === "string" ? record.executionId : "";
    if (executionId.length === 0) {
      malformed(
        "$.executionId",
        "executionId is " +
          describeValue(record.executionId) +
          ", not the non-empty host execution id the platform named",
      );
    }
    const outcomeId =
      typeof record.outcomeId === "string" ? record.outcomeId : "";
    if (outcomeId.length === 0) {
      malformed(
        "$.outcomeId",
        "outcomeId is " +
          describeValue(record.outcomeId) +
          ", not the outcome id the worker's own last turn declared",
      );
    }
    const rawRefs = record.evidenceRefs;
    const evidenceRefs: string[] = [];
    if (rawRefs !== undefined) {
      if (!Array.isArray(rawRefs)) {
        malformed(
          "$.evidenceRefs",
          "evidenceRefs is " +
            describeValue(rawRefs) +
            ", not an array of references",
        );
      } else {
        rawRefs.forEach((ref, index) => {
          if (typeof ref === "string" && ref.length > 0) {
            evidenceRefs.push(ref);
          } else {
            malformed(
              "$.evidenceRefs[" + index + "]",
              "evidenceRefs[" +
                index +
                "] is " +
                describeValue(ref) +
                ", not a non-empty reference",
            );
          }
        });
      }
    }
    const rawDerivation = record.derivation;
    let derivation: HostDerivedDerivation | undefined;
    if (rawDerivation !== undefined) {
      if (
        typeof rawDerivation !== "object" ||
        rawDerivation === null ||
        Array.isArray(rawDerivation)
      ) {
        malformed(
          "$.derivation",
          "derivation is " +
            describeValue(rawDerivation) +
            ", not the { eventIndex, turnIndex } record the host read the declaration from",
        );
      } else {
        const source = rawDerivation as Record<string, unknown>;
        for (const key of Object.keys(source)) {
          if (!DERIVATION_KEYS.includes(key)) {
            malformed(
              "$.derivation." + key,
              "unknown key " +
                JSON.stringify(key) +
                " — a derivation carries only eventIndex and turnIndex, the two positions of " +
                "the worker's own turn that declared the outcome",
            );
          }
        }
        const eventIndex = source.eventIndex;
        const turnIndex = source.turnIndex;
        const readable = (entry: unknown): entry is number =>
          typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
        if (!readable(eventIndex)) {
          malformed(
            "$.derivation.eventIndex",
            "eventIndex is " +
              describeValue(eventIndex) +
              ", not a non-negative safe integer",
          );
        }
        if (!readable(turnIndex)) {
          malformed(
            "$.derivation.turnIndex",
            "turnIndex is " +
              describeValue(turnIndex) +
              ", not a non-negative safe integer",
          );
        }
        if (readable(eventIndex) && readable(turnIndex)) {
          derivation = Object.freeze({ eventIndex, turnIndex });
        }
      }
    }
    // `data` is read once, and it is DELIBERATELY unconstrained: whether a
    // payload is representable is the canonical digest's question, not this
    // shape gate's, exactly as it is for a proposal.
    const data = record.data;
    if (issues.length > 0) return { kind: "malformed", issues };
    return {
      kind: "ok",
      fact: Object.freeze({
        nodeId,
        attemptId,
        executionId,
        outcomeId,
        ...(data === undefined ? {} : { data }),
        ...(rawRefs === undefined ? {} : { evidenceRefs: Object.freeze(evidenceRefs) }),
        ...(derivation === undefined ? {} : { derivation }),
      }),
    };
  } catch (error) {
    return {
      kind: "malformed",
      issues: [
        {
          code: "malformed-host-derived-completion",
          path: "$",
          message:
            "the host-derived completion could not be read (" + errorText(error) + ")",
        },
      ],
    };
  }
}

// ── The provenance namespace ────────────────────────────────────────────────

/**
 * The submission-key namespace of a host-derived settlement.
 *
 * The ordinary submission ingress derives `submission:<proposal digest>` and
 * the natural channel derives `natural-completion:<digest>`; a host-derived
 * settlement derives this prefix instead, so the three channels can never
 * produce the same key and the source is part of the persisted key rather than
 * a convention about it.
 */
export const HOST_DERIVED_SUBMISSION_PREFIX = "host-derived:";

/** The source this protocol records for a host-derived settlement. */
export const HOST_DERIVED_SOURCE = "host-derived" as const;

/**
 * The submission id of a host-derived settlement for one canonical proposal
 * digest — the content-addressed key the receipt and the accepted event
 * persist.
 */
export function hostDerivedSubmissionId(proposalDigest: string): string {
  return HOST_DERIVED_SUBMISSION_PREFIX + proposalDigest;
}

/**
 * Whether a submission id names a host-derived settlement.
 *
 * PURE and total: a value that is not a string, or that carries the prefix with
 * nothing after it, is not a host-derived key. This is the read-back half of the
 * representation: a receipt, an accepted event or a decision obtained from the
 * ledger answers "which channel settled this" through its `submissionId` alone.
 */
export function isHostDerivedSubmissionId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > HOST_DERIVED_SUBMISSION_PREFIX.length &&
    value.startsWith(HOST_DERIVED_SUBMISSION_PREFIX)
  );
}

// ── The proposal ────────────────────────────────────────────────────────────

/**
 * The proposal a host-derived fact feeds the SAME acceptance core every other
 * channel uses: the node, the outcome the worker's own last turn declared, and
 * — when the declaration carried them — its payload and evidence references.
 *
 * NEVER A CREDENTIAL. There is deliberately no `credential` parameter to pass:
 * this channel is authenticated by the host's durable execution record, and the
 * identity resolution it enters accepts exactly that proof. The outcome is the
 * DECLARATION's, verbatim: nothing here defaults, repairs or synthesizes one,
 * so the plan's declared outcomes and gates decide what happens next.
 */
export function hostDerivedProposalOf(
  fact: HostDerivedCompletionFact,
): OutcomeProposal {
  return Object.freeze({
    nodeId: fact.nodeId,
    outcomeId: fact.outcomeId,
    ...(fact.data === undefined ? {} : { data: fact.data }),
    ...(fact.evidenceRefs === undefined ? {} : { evidenceRefs: fact.evidenceRefs }),
  });
}

// ── The record ──────────────────────────────────────────────────────────────

/**
 * How one host-derived settlement is described to a caller — the attempt, the
 * outcome the WORKER'S OWN LAST TURN declared, the content-addressed submission
 * key this delivery addresses, and where the declaration was read from when the
 * host said.
 *
 * The key IS the provenance: it is the `host-derived:<digest>` id the acceptance
 * core derived for this delivery, so it is the persisted receipt's key exactly
 * when the ledger committed or replayed this settlement, and a different answer
 * (`not-committed`) says so through the result it accompanies.
 */
export interface HostDerivedSettlement {
  readonly source: typeof HOST_DERIVED_SOURCE;
  readonly nodeId: string;
  readonly attemptId: string;
  /** The outcome the worker's own last turn declared. */
  readonly outcomeId: string;
  /** The host-derived submission key the ledger persists. */
  readonly submissionId: string;
  /** Which of the worker's turns declared it, when the host reported one. */
  readonly derivation?: HostDerivedDerivation;
}

/**
 * The frozen record of one resolved host-derived settlement, derived from the
 * canonical proposal digest the acceptance core addressed the settlement by.
 * TOTAL: the submission key is {@link hostDerivedSubmissionId} of that digest —
 * the very key the run path derives for the same proposal and the ledger
 * persists — so a record cannot claim this channel while carrying an ordinary
 * submission key, and building one cannot fail after a settlement.
 */
export function hostDerivedSettlementOf(input: {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly outcomeId: string;
  /** Digest of the canonical host-derived proposal. */
  readonly proposalDigest: string;
  readonly derivation?: HostDerivedDerivation;
}): HostDerivedSettlement {
  return Object.freeze({
    source: HOST_DERIVED_SOURCE,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    outcomeId: input.outcomeId,
    submissionId: hostDerivedSubmissionId(input.proposalDigest),
    ...(input.derivation === undefined ? {} : { derivation: input.derivation }),
  });
}

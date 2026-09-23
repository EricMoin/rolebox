/**
 * Graph Execution Engine v2 — Natural completion: the attempt's completion
 * fact as a closed delivery envelope (stage D)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The INPUT half of the natural-completion settlement path
 * (docs/graph-outcome-protocol.md § "State, storage, and effects" and the D6
 * section): the only thing the host's dispatch completion bridge delivers when
 * a dispatched attempt REACHES ITS END, as opposed to a worker CLAIMING an
 * outcome through `graph_submit_outcome`.
 *
 * THE TRIGGER IS THE ATTEMPT'S COMPLETION FACT, NOT A SELF-REPORTED OUTCOME.
 * A delivery names the attempt it is about and presents that attempt's bearer
 * credential. The OUTCOME is never part of the envelope: it is resolved from
 * the plan's pinned natural-completion authorization, so a delivery cannot
 * choose which outcome settles the node. There is deliberately no `data`,
 * `evidenceRefs`, `outcomeId` or any other payload field — a completion fact
 * that could route a result would be a second submission channel wearing a
 * different name, and this module refuses one by construction: the key set is
 * CLOSED and an unknown key is a refusal, never a dropped field.
 *
 * WHAT THE CREDENTIAL PROVES, STATED HONESTLY. The credential is the bearer
 * nonce the runtime minted for the attempt (see `attempt-credential.ts`): it
 * proves POSSESSION of a capability the runtime issued for exactly one attempt,
 * so a guessed, tampered, superseded or other attempt's credential cannot
 * settle anything. It does NOT prove the presenter's identity — the worker and
 * the host bridge hold the same bearer token — and this module claims no more
 * than that. What the natural path protects is the OUTCOME and the PAYLOAD: a
 * delivery cannot pick an outcome the plan did not authorize, and it cannot
 * carry a result the declared acceptance gates would judge.
 *
 * NO HOST-SUPPLIED COMPLETION METADATA IS NEEDED. The envelope is exactly the
 * attempt identity and its proof because everything else is already durable:
 * the graph is the runtime's own `graphId`, the plan revision is the plan's
 * own content address, the dispatch effect id is derived from the attempt id
 * (`dispatch:<attemptId>`), and the outcome is the pinned authorization's.
 * A host that could only report "this attempt completed" therefore needs no
 * field beyond the two identity values and the credential — and this build
 * defines none.
 *
 * PROVENANCE IS A NAMESPACED SUBMISSION KEY. The natural-completion settlement
 * is the SAME logical-submission machinery the ordinary submission path uses
 * (one attempt, one proposal digest, one receipt, one accepted event), but its
 * submission key lives in its own namespace: `natural-completion:<digest>`
 * instead of `submission:<digest>`. The key is derived from the canonical
 * proposal digest, so it is content-addressed and stable across a repeated
 * delivery (which is what makes the ledger REPLAY the first receipt instead of
 * writing a second one), and the ordinary submission ingress — which always
 * derives `submission:<digest>` — can never mint it. The receipt row and the
 * accepted-event row persist that key verbatim, and the acceptance decision
 * carries it as `identity.submissionId`, so "this was a natural-completion
 * settlement, not a worker's claimed submission" is READABLE BACK from the
 * durable record without a second store, a log line or a payload convention.
 *
 * Dependency leaf: the only imports are the proposal shape (for the synthesized
 * submission the runtime feeds the SAME acceptance core) and the pinned policy
 * ref, so the run path, a reader or a test harness may depend on this module
 * without a cycle.
 */

import type { CompletionPolicyRef } from "../policy/completion-policy.ts";
import type { OutcomeProposal } from "./proposal.ts";

// ── The delivery envelope ───────────────────────────────────────────────────

/**
 * What the host's dispatch completion bridge delivers for one attempt.
 *
 * `nodeId` and `attemptId` name the attempt the completion fact is about —
 * they are checked against the credential's persisted binding and are NEVER
 * used to select an attempt — and `credential` is the attempt's bearer proof.
 * OPTIONAL at this boundary for the same reason a proposal's credential is: a
 * missing one is the run path's repairable `credential-missing` refusal, not a
 * shape this total gate can judge.
 */
export interface NaturalCompletionDelivery {
  /** The node whose attempt reached its natural completion. */
  readonly nodeId: string;
  /** The attempt that reached it; checked against the credential's binding. */
  readonly attemptId: string;
  /** The bearer credential the runtime issued for that attempt. */
  readonly credential?: string;
}

/** The keys a delivery may carry; anything else is an unknown key. */
const DELIVERY_KEYS: readonly string[] = ["nodeId", "attemptId", "credential"];

/** One shape violation of a raw delivery value. */
export interface NaturalCompletionDeliveryIssue {
  /** Stable code; the run path reports it as `malformed-natural-delivery`. */
  readonly code: "malformed-natural-delivery";
  /** Location, e.g. `$.data` or `$.attemptId`. */
  readonly path: string;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
}

/** The shape gate's verdict over an untrusted value. */
export type NaturalCompletionDeliveryReading =
  | { readonly kind: "ok"; readonly delivery: NaturalCompletionDelivery }
  | {
      readonly kind: "malformed";
      readonly issues: readonly NaturalCompletionDeliveryIssue[];
    };

/**
 * Read an untrusted value as a {@link NaturalCompletionDelivery}.
 *
 * TOTAL: every rejection is a structured issue, and a property read that throws
 * (an accessor, a hostile Proxy) is contained as one more malformed issue
 * rather than escaping.
 *
 * The shape is CLOSED. `nodeId` and `attemptId` must be non-empty strings,
 * `credential` — when supplied — must be a non-empty string, and any other key
 * is refused BY NAME. That last rule is the no-data-channel guarantee: an
 * `outcomeId`, a `data` payload, an `evidenceRefs` list or any future field a
 * caller tries to smuggle alongside the completion fact is rejected here,
 * before the plan, the credential or the ledger is consulted.
 */
export function readNaturalCompletionDelivery(
  value: unknown,
): NaturalCompletionDeliveryReading {
  const issues: NaturalCompletionDeliveryIssue[] = [];
  const malformed = (path: string, message: string): void => {
    issues.push({ code: "malformed-natural-delivery", path, message });
  };
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        kind: "malformed",
        issues: [
          {
            code: "malformed-natural-delivery",
            path: "$",
            message:
              "a natural-completion delivery is a record of { nodeId, attemptId, credential? }, received " +
              describeValue(value),
          },
        ],
      };
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!DELIVERY_KEYS.includes(key)) {
        malformed(
          "$." + key,
          "unknown key " +
            JSON.stringify(key) +
            " — a natural-completion delivery carries only nodeId, attemptId and the attempt " +
            "credential, and an unrecognized field is refused rather than dropped: a completion " +
            "fact is not a submission and has no channel for an outcome, a payload or evidence",
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
    let credential: string | undefined;
    if (record.credential !== undefined) {
      if (typeof record.credential === "string" && record.credential.length > 0) {
        credential = record.credential;
      } else {
        malformed(
          "$.credential",
          "credential is " +
            describeValue(record.credential) +
            ", not the non-empty attempt credential the runtime issued",
        );
      }
    }
    if (issues.length > 0) return { kind: "malformed", issues };
    return {
      kind: "ok",
      delivery: Object.freeze({
        nodeId,
        attemptId,
        ...(credential === undefined ? {} : { credential }),
      }),
    };
  } catch (error) {
    return {
      kind: "malformed",
      issues: [
        {
          code: "malformed-natural-delivery",
          path: "$",
          message:
            "the natural-completion delivery could not be read (" +
            errorText(error) +
            ")",
        },
      ],
    };
  }
}

// ── The provenance namespace ────────────────────────────────────────────────

/**
 * The submission-key namespace of a natural-completion settlement.
 *
 * The ordinary submission ingress derives `submission:<proposal digest>`
 * (see the run path's `submissionIdOf`); a natural completion derives this
 * prefix instead, so the two channels can never produce the same key and the
 * source is part of the persisted key rather than a convention about it.
 */
export const NATURAL_COMPLETION_SUBMISSION_PREFIX = "natural-completion:";

/** The source this protocol records for a natural-completion settlement. */
export const NATURAL_COMPLETION_SOURCE = "natural-completion" as const;

/**
 * The submission id of a natural-completion settlement for one canonical
 * proposal digest — the content-addressed key the receipt and the accepted
 * event persist.
 */
export function naturalCompletionSubmissionId(proposalDigest: string): string {
  return NATURAL_COMPLETION_SUBMISSION_PREFIX + proposalDigest;
}

/**
 * Whether a submission id names a natural-completion settlement.
 *
 * PURE and total: a value that is not a string, or that carries the prefix with
 * nothing after it, is not a natural-completion key. This is the read-back half
 * of the representation: a receipt, an accepted event or a decision obtained
 * from the ledger answers "which channel settled this" through its
 * `submissionId` alone.
 */
export function isNaturalCompletionSubmissionId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > NATURAL_COMPLETION_SUBMISSION_PREFIX.length &&
    value.startsWith(NATURAL_COMPLETION_SUBMISSION_PREFIX)
  );
}

// ── The record ──────────────────────────────────────────────────────────────

/**
 * How one natural-completion settlement is described to a caller — the attempt,
 * the outcome the PLAN authorized (never one a caller named), the exact policy
 * revision that authorized it, and the content-addressed submission key this
 * delivery addresses.
 *
 * The key IS the provenance: it is the `natural-completion:<digest>` id the
 * acceptance core derived for this delivery, so it is the persisted receipt's
 * key exactly when the ledger committed or replayed this settlement, and a
 * different answer (`not-committed`) says so through the result it accompanies.
 */
export interface NaturalCompletionSettlement {
  readonly source: typeof NATURAL_COMPLETION_SOURCE;
  readonly nodeId: string;
  readonly attemptId: string;
  /** The outcome the pinned authorization maps this node to. */
  readonly outcomeId: string;
  /** The natural-completion submission key the ledger persists. */
  readonly submissionId: string;
  /** The exact policy revision whose rule granted the mapping. */
  readonly policy: CompletionPolicyRef;
}

/**
 * The frozen record of one resolved natural-completion settlement, derived from
 * the canonical proposal digest the acceptance core addressed the settlement
 * by. TOTAL: the submission key is {`naturalCompletionSubmissionId`} of that
 * digest — the very key the run path derives for the same proposal and the
 * ledger persists — so a record cannot claim the natural channel while carrying
 * an ordinary submission key, and building one cannot fail after a settlement.
 */
export function naturalCompletionSettlementOf(input: {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly outcomeId: string;
  /** Digest of the canonical natural-completion proposal. */
  readonly proposalDigest: string;
  readonly policy: CompletionPolicyRef;
}): NaturalCompletionSettlement {
  return Object.freeze({
    source: NATURAL_COMPLETION_SOURCE,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    outcomeId: input.outcomeId,
    submissionId: naturalCompletionSubmissionId(input.proposalDigest),
    policy: input.policy,
  });
}

/**
 * The proposal the natural-completion settlement feeds the SAME acceptance
 * core: the node, the outcome the pinned authorization maps it to, and the
 * attempt's credential. No data is synthesized and no evidence is invented — an
 * outcome whose declared gates require a payload is judged on the empty
 * submission it actually is, and fails there rather than being exempted.
 */
export function naturalCompletionProposalOf(input: {
  readonly nodeId: string;
  readonly outcomeId: string;
  readonly credential: string | undefined;
}): OutcomeProposal {
  return Object.freeze({
    nodeId: input.nodeId,
    outcomeId: input.outcomeId,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

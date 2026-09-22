/**
 * Graph Execution Engine v2 — Outcome proposal: the worker-supplied submission
 * shape (C3a)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The INPUT half of the outcome protocol's submission path
 * (docs/graph-outcome-protocol.md § "Submission and acceptance"): the only
 * thing a graph worker supplies when it claims an outcome.
 *
 * PROVENANCE IS NOT IN THE PROPOSAL. `OutcomeProposal` carries an outcome
 * reference, the ATTEMPT CREDENTIAL the runtime issued to this worker, and the
 * worker's own data — no graph id, no attempt id, no submission id and no plan
 * revision. The runtime binds those from the AUTHENTICATED tool context, so a
 * worker cannot name (or overwrite) the execution its claim belongs to:
 * impersonating another graph, attempt or submission is impossible BY
 * CONSTRUCTION rather than by a validation rule a future caller could forget.
 * The same rule keeps a proposal from pinning a plan revision — an
 * agent-supplied revision could only ever be a claim, and the plan's own
 * content address is the authority.
 *
 * THE CREDENTIAL IS A BEARER CAPABILITY, NOT PROVENANCE. It is an opaque nonce
 * the runtime minted for one attempt (see `attempt-credential.ts`); a proposal
 * can carry it but cannot name the execution it belongs to. The RUN PATH
 * resolves the attempt from the credential's persisted binding and refuses a
 * credential that names no recorded attempt, so the field is never a way to
 * choose an attempt, only to prove possession of one that was already chosen
 * for this worker. It is part of the canonical form below, so two submissions
 * that differ only in their credential are different submissions: reusing an
 * old credential against a different attempt cannot collide with the original
 * submission's receipt.
 *
 * - `readOutcomeProposal` — the total shape gate at the external boundary. A
 *   proposal is a CLOSED record: an unknown key is refused rather than dropped
 *   silently, and every field is read into a fresh object, so an
 *   accessor-backed proposal cannot answer one value here and another later.
 * - `normalizeProposal` — the canonical, deeply frozen form. The envelope has a
 *   fixed key order, `data` is present exactly when it was supplied (an absent
 *   payload and an explicit `undefined` are the same thing: nothing), and
 *   `evidenceRefs` is a SET — de-duplicated and sorted by UTF-16 code unit
 *   order — so two proposals that differ only in key or reference order are the
 *   same submission.
 * - `proposalDigest` — the digest of that canonical form through the ONE
 *   canonical digest the protocol already owns (`contractDigest`); this module
 *   deliberately adds no second digest, and the digest cannot depend on key
 *   order because the canonical form sorts keys itself.
 *
 * Normalization takes ownership of the `data` tree exactly as
 * `createCompiledPlan` takes ownership of a plan body: it freezes the caller's
 * containers in place instead of deep-copying them. Freezing is what makes the
 * recorded digest durable — a submission whose data could still move would make
 * its own receipt a lie — and the freeze tracks the containers it has already
 * visited, so a cyclic payload terminates here and is then refused by the
 * digest instead of being followed forever.
 *
 * Dependency leaf: the single import is the contract digest, so the acceptance
 * core, a reducer or a tool boundary may depend on this module without a cycle.
 */

import { contractDigest } from "../contracts/contract-definition.ts";

// ── The proposal ────────────────────────────────────────────────────────────

/**
 * The ONLY shape a worker may supply.
 *
 * There is deliberately no graph, attempt, submission or plan-revision field:
 * those are runtime provenance, bound from the authenticated context by the
 * acceptance core, never accepted from the worker. A submission therefore
 * cannot impersonate another execution even if the payload claims to.
 */
export interface OutcomeProposal {
  /** The node whose outcome is claimed. */
  readonly nodeId: string;
  /** The outcome being claimed; it must be declared by that node. */
  readonly outcomeId: string;
  /**
   * The attempt credential the runtime issued to this worker when it was
   * dispatched. OPTIONAL at this boundary because a missing one is a
   * repairable submission refusal (`credential-missing` with
   * `$.credential`), not a shape this module can judge: whether a credential
   * is well-formed for the attempt it claims is the run path's question, and it
   * is answered against the persisted binding, never against the proposal.
   */
  readonly credential?: string;
  /** The outcome's payload, opaque here and checked by the outcome's gates. */
  readonly data?: unknown;
  /**
   * References to the artifacts this submission claims as evidence, in any
   * order. Order carries no meaning: normalization treats the list as a set.
   */
  readonly evidenceRefs?: readonly string[];
}

/**
 * The canonical form of a proposal: fixed key order, `data` present exactly
 * when supplied, `evidenceRefs` always present as a sorted, de-duplicated
 * list. Deeply frozen by {@link normalizeProposal}.
 */
export interface NormalizedOutcomeProposal {
  readonly nodeId: string;
  readonly outcomeId: string;
  /** Present exactly when the proposal carried one. */
  readonly credential?: string;
  readonly data?: unknown;
  readonly evidenceRefs: readonly string[];
}

/** The keys a proposal may carry; anything else is an unknown key. */
const PROPOSAL_KEYS: readonly string[] = [
  "nodeId",
  "outcomeId",
  "credential",
  "data",
  "evidenceRefs",
];

/** One shape violation of a raw proposal value. */
export interface ProposalShapeIssue {
  /** Stable code; the acceptance core reports it as `malformed-proposal`. */
  readonly code: "malformed-proposal";
  /** Location, e.g. `$.evidenceRefs[1]`. */
  readonly path: string;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
}

/** The shape gate's verdict over an untrusted value. */
export type OutcomeProposalReading =
  | { readonly kind: "ok"; readonly proposal: OutcomeProposal }
  | { readonly kind: "malformed"; readonly issues: readonly ProposalShapeIssue[] };

/**
 * Read an untrusted value as an {@link OutcomeProposal}.
 *
 * TOTAL: every rejection is a structured issue, and a property read that
 * throws (an accessor, a hostile Proxy) is contained as one more malformed
 * issue rather than escaping — this is the model-facing boundary, so an
 * exception here would be a bug in the boundary itself.
 *
 * The shape is CLOSED. `nodeId` and `outcomeId` must be non-empty strings,
 * `credential` — when supplied — must be a non-empty string (its VALUE is
 * opaque here; the run path decides whether it names a recorded attempt),
 * `evidenceRefs` must be an array of non-empty strings, and `data` is
 * deliberately unconstrained: representability is the digest's question, not
 * the shape gate's, so a payload JSON cannot carry is refused by
 * `unrepresentable-proposal` with the digest's own diagnostic.
 */
export function readOutcomeProposal(value: unknown): OutcomeProposalReading {
  const issues: ProposalShapeIssue[] = [];
  const malformed = (path: string, message: string): void => {
    issues.push({ code: "malformed-proposal", path, message });
  };
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        kind: "malformed",
        issues: [
          {
            code: "malformed-proposal",
            path: "$",
            message: `a proposal is a record of { nodeId, outcomeId, credential?, data?, evidenceRefs? }, received ${describeValue(value)}`,
          },
        ],
      };
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!PROPOSAL_KEYS.includes(key)) {
        malformed(
          `$.${key}`,
          `unknown key ${JSON.stringify(key)} — a proposal carries only nodeId, outcomeId, credential, data and evidenceRefs, and an unrecognized field is refused rather than dropped`,
        );
      }
    }
    // Read each field EXACTLY ONCE into a local, so an accessor-backed record
    // cannot answer one value to the check and another to the construction.
    const nodeId = typeof record.nodeId === "string" ? record.nodeId : "";
    if (nodeId.length === 0) {
      malformed(
        "$.nodeId",
        `nodeId is ${describeValue(record.nodeId)}, not a non-empty node id`,
      );
    }
    const outcomeId =
      typeof record.outcomeId === "string" ? record.outcomeId : "";
    if (outcomeId.length === 0) {
      malformed(
        "$.outcomeId",
        `outcomeId is ${describeValue(record.outcomeId)}, not a non-empty outcome id`,
      );
    }
    let credential: string | undefined;
    if (record.credential !== undefined) {
      if (isNonEmptyString(record.credential)) {
        credential = record.credential;
      } else {
        malformed(
          "$.credential",
          `credential is ${describeValue(record.credential)}, not the non-empty attempt credential the runtime issued`,
        );
      }
    }
    const rawRefs = record.evidenceRefs;
    const evidenceRefs: string[] = [];
    if (rawRefs !== undefined) {
      if (!Array.isArray(rawRefs)) {
        malformed(
          "$.evidenceRefs",
          `evidenceRefs is ${describeValue(rawRefs)}, not an array of references`,
        );
      } else {
        rawRefs.forEach((ref, index) => {
          if (typeof ref !== "string" || ref.length === 0) {
            malformed(
              `$.evidenceRefs[${index}]`,
              `an evidence reference is ${describeValue(ref)}, not a non-empty string`,
            );
            return;
          }
          evidenceRefs.push(ref);
        });
      }
    }
    if (issues.length > 0) {
      return { kind: "malformed", issues };
    }
    // Every field is a valid value here: a rejected one would have produced an
    // issue and returned above, so the envelope below is complete. `data` is
    // carried by reference and deliberately unconstrained — representability is
    // the digest's question, not this gate's.
    const data = record.data;
    return {
      kind: "ok",
      proposal: {
        nodeId,
        outcomeId,
        ...(credential === undefined ? {} : { credential }),
        ...(data === undefined ? {} : { data }),
        ...(rawRefs === undefined ? {} : { evidenceRefs }),
      },
    };
  } catch (error) {
    return {
      kind: "malformed",
      issues: [
        {
          code: "malformed-proposal",
          path: "$",
          message: `the proposal could not be read (${errorText(error)})`,
        },
      ],
    };
  }
}

// ── Canonical form and digest ───────────────────────────────────────────────

/**
 * Canonicalize a proposal: a fresh envelope with a fixed key order, the
 * `credential` present exactly when the proposal carried one, a copy of `data`
 * by reference, and `evidenceRefs` as a sorted, de-duplicated frozen list —
 * then freeze the whole result, including the `data` tree, in place.
 *
 * IDEMPOTENT: normalizing the canonical form returns an equal canonical form,
 * so a caller may normalize before or after handing a proposal on.
 * `undefined` data is dropped rather than carried as a key, because
 * `contractDigest` refuses `undefined` and "no payload" is one thing, not two.
 */
export function normalizeProposal(
  proposal: OutcomeProposal,
): NormalizedOutcomeProposal {
  const evidenceRefs =
    proposal.evidenceRefs === undefined
      ? []
      : [...new Set(proposal.evidenceRefs)].sort(compareText);
  const normalized: NormalizedOutcomeProposal = {
    nodeId: proposal.nodeId,
    outcomeId: proposal.outcomeId,
    ...(proposal.credential === undefined
      ? {}
      : { credential: proposal.credential }),
    ...(proposal.data === undefined ? {} : { data: proposal.data }),
    evidenceRefs,
  };
  freezeDeep(normalized, new Set());
  return normalized;
}

/**
 * The digest of a proposal's canonical form, through the ONE canonical digest
 * the protocol owns ({@link contractDigest}).
 *
 * Two proposals that differ only in property order or in evidence-reference
 * order therefore share a digest, and any content difference yields a
 * different one. Throws exactly where `contractDigest` throws: a payload the
 * canonical form cannot represent is refused BEFORE hashing, so a digest is
 * never taken over a truncated submission.
 */
export function proposalDigest(
  proposal: OutcomeProposal | NormalizedOutcomeProposal,
): string {
  return contractDigest(normalizeProposal(proposal));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The shape rule of an optional string field: absent, or a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** UTF-16 code-unit order: locale-independent, so refs sort the same everywhere. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Freeze a value in place, all the way down.
 *
 * `seen` holds every container already visited, so a cyclic or diamond-shaped
 * payload terminates instead of being followed forever; a cycle is frozen and
 * then refused by the digest, which is where representability belongs.
 */
function freezeDeep(value: unknown, seen: Set<object>): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
    return;
  }
  for (const key of Object.keys(value)) {
    freezeDeep((value as Record<string, unknown>)[key], seen);
  }
}

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

/**
 * Graph Execution Engine v2 — Acceptance: proposal -> validation -> decision ->
 * atomic acceptance (C3a)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The decision core of the outcome protocol's submission path
 * (docs/graph-outcome-protocol.md § "Submission and acceptance" and
 * § "Acceptance validators"). It consumes the committed compiled plan and the
 * committed acceptance ledger and adds nothing of its own: the plan supplies
 * the topology and the pinned gates, the ledger supplies the atomic commit and
 * the idempotency rules, `contractDigest` (through `proposalDigest`) supplies
 * the one digest, and the trusted context supplies provenance.
 *
 * THE SEQUENCE, and why it is shaped this way:
 *
 * 1. REFUSE what cannot be evaluated. A malformed proposal, an unknown node, an
 *    outcome its declaring node does not declare, a plan that is not executable
 *    (a draft), a plan revision that disagrees with the attempt's submitted
 *    binding, a graph identity that disagrees with the plan, a malformed effect
 *    batch or a clock that is not epoch milliseconds all produce STRUCTURED
 *    repair diagnostics and write NOTHING to the ledger.
 * 2. Normalize and digest the proposal. The canonical form and its digest are
 *    the submission's content identity; the receipt, every validation result and
 *    the commit recheck are all bound to it.
 * 3. Run the outcome's acceptance requirements through the registry OUTSIDE the
 *    transaction — reading artifacts must not hold the atomic boundary open —
 *    and bind every result to the proposal digest, the plan revision and the
 *    execution identity. A requirement with no registered implementation is a
 *    REFUSAL before any gate runs, never a silent skip; an implementation that
 *    throws is an `indeterminate` result.
 * 4. Decide: every required gate passing is `accepted`; ANY `fail` or ANY
 *    `indeterminate` is `rejected`. An indeterminate result never satisfies a
 *    required gate, and the decision carries the per-requirement outcomes for
 *    diagnostics.
 * 5. Commit through the ledger in ONE batch: an accepted decision writes the
 *    receipt, the accepted event and the pending effects together; a rejected
 *    one writes the receipt ONLY — no event, so the attempt stays open. The
 *    commit RECHECKS inside the transaction that the proposal digest, the plan
 *    revision and the execution identity still are the ones validation recorded,
 *    and refuses a superseded validation instead of settling a newer execution
 *    with stale evidence. A caller may JOIN that transaction with the graph
 *    state it reduces from the accepted decision ({@link AcceptanceJoin}): the
 *    state write commits with the batch, and it is skipped for a replay,
 *    conflict or settlement so no state advances twice.
 * 6. Return the decision AND the ledger verdict (`committed` / `replayed` /
 *    `conflict` / `settled`), so a repeated identical submission answers with
 *    the SAME persisted decision rather than a second row. Effects may be
 *    executed only when the verdict is `committed`; a `replayed` verdict
 *    carries the persisted receipt, and `conflict` / `settled` mean this
 *    submission's decision was NOT committed.
 *
 * TWO PHASES, ONE CALL. `validateSubmission` runs steps 1-4 and touches no
 * ledger; `commitSubmission` runs steps 5-6 and rechecks the binding it is
 * given; `submitOutcome` composes them for the ordinary caller. The split is
 * not a test seam — it is the boundary the protocol names: validation is
 * allowed to run outside the serialized commit, and making that explicit is
 * what lets the commit refuse a stale validation instead of trusting it.
 *
 * NO EFFECT RUNS HERE. This module records effects; executing them belongs to
 * the effect executor a later slice delivers, and the outcome run path
 * (`src/graph/outcome/runtime.ts`) is the only consumer that reads them back
 * today. Nothing under `src/graph/tools` or `src/dispatch` imports this
 * module: the outcome protocol has its OWN run path, and the legacy engine that
 * decided completions from severity-ranked signals was deleted with its
 * runtime.
 */

import type { GraphAcceptanceBatch } from "../store/records.ts";
import {
  readPlanExecutability,
  type CompiledNode,
  type CompiledOutcome,
  type CompiledPlan,
  type CompiledUnauthorizedCompletion,
  type CompiledUnresolvedRequirement,
} from "../compiler/plan.ts";
import type {
  AcceptanceBatch,
  AcceptanceLedger,
  AcceptanceLedgerTx,
  CommitResult,
  PendingEffectRecord,
  ReceiptRecord,
} from "../ledger/types.ts";
import {
  normalizeProposal,
  proposalDigest,
  readOutcomeProposal,
  type NormalizedOutcomeProposal,
  type OutcomeProposal,
} from "./proposal.ts";
import {
  validatorKeyText,
  type ExecutionIdentity,
  type ValidatorImplementation,
  type ValidatorKey,
  type ValidatorRegistry,
  type ValidationOutcome,
  type ArtifactEvidence,
} from "./validators.ts";

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * One pending effect the acceptance produces, as the caller describes it.
 *
 * The caller owns `effectId` — it is the STABLE id a later process uses to
 * look the effect up and reconcile it — and may name the attempt the effect is
 * work for (see {@link PendingEffectInput.attemptId}); `graphId`, `createdAt`
 * and the initial `pending` status come from the trusted context and the clock,
 * never from the caller's payload.
 */
export interface PendingEffectInput {
  /** Stable effect id, unique within the batch. */
  readonly effectId: string;
  /**
   * The attempt this effect is work for. OMITTED means the submitting
   * execution's own attempt, which is what an effect the submitting attempt
   * itself produces always is.
   *
   * AN ARMED SUCCESSOR IS WHY THIS FIELD EXISTS. An acceptance that settles
   * `work#1` and arms `review#2` produces a dispatch effect for `review#2`,
   * and the row must carry THAT attempt — the same one its `effectId` names —
   * so an attempt-scoped reader (the run's unsettled-effect fence, a superseded
   * run's acceptance guard) joins the row to the execution it describes instead
   * of to the settled feeder that decided to arm it.
   *
   * The value is written verbatim; the store's own row gate refuses a malformed
   * identifier. Nothing here checks that the named attempt belongs to this
   * graph, so a producer that names one must name the attempt the effect really
   * belongs to.
   */
  readonly attemptId?: string;
  /** Effect kind, e.g. the dispatch or notification it performs. */
  readonly kind: string;
  /** Opaque payload, stored verbatim; `null` when the effect carries nothing. */
  readonly payload: unknown;
}

/**
 * Everything the acceptance core is given.
 *
 * The `plan` and its revision are TRUSTED: the plan is the committed compiled
 * plan of this graph, and `submittedPlanRevision` is the revision the attempt
 * is bound to — carrying it separately is what makes their disagreement a
 * refusal rather than an implicit assumption. The `identity` is authenticated
 * runtime provenance. The `proposal` is the one untrusted value: it is typed
 * `unknown` on purpose, because the shape gate exists precisely to refuse a
 * value the worker got wrong.
 */
export interface AcceptanceRequest {
  /** The committed compiled plan this submission is judged against. */
  readonly plan: CompiledPlan;
  /** The plan revision the attempt is bound to (the submitted binding). */
  readonly submittedPlanRevision: string;
  /** The trusted execution this submission belongs to. */
  readonly identity: ExecutionIdentity;
  /** The worker-supplied proposal, untrusted. */
  readonly proposal: unknown;
  /** The installed validator implementations the plan's gates resolve against. */
  readonly validators: ValidatorRegistry;
  /** The root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The pending effects an ACCEPTED decision commits; ignored otherwise. */
  readonly effects?: readonly PendingEffectInput[];
  /** The clock, in epoch milliseconds. Time is an explicit input. */
  readonly now: number;
}

/** The request plus the ledger the decision is committed through. */
export interface SubmissionRequest extends AcceptanceRequest {
  readonly ledger: AcceptanceLedger;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * The stable code of one refusal — the structured repair vocabulary a
 * submission boundary reports. Wording of a message is not part of the
 * contract; these codes are.
 */
export type SubmissionRefusalCode =
  | "invalid-timestamp"
  | "malformed-effect"
  | "malformed-plan"
  | "non-executable-plan"
  | "plan-revision-mismatch"
  | "graph-mismatch"
  | "malformed-proposal"
  | "unknown-node"
  | "undeclared-outcome"
  | "unrepresentable-proposal"
  | "validator-not-registered"
  | "stale-validation";

/**
 * One reason a submission was refused. A refusal is NOT a rejection: no
 * receipt, no event and no effect is written, and the attempt stays exactly as
 * it was, so the caller can repair the input and submit again.
 */
export interface SubmissionRefusal {
  /** Stable code naming the rule that refused. */
  readonly code: SubmissionRefusalCode;
  /** Human-readable explanation. Wording is not part of the contract. */
  readonly message: string;
  /** Location of the problem, e.g. `$.evidenceRefs[1]` or `$.plan.executability`. */
  readonly path?: string;
}

// ── Decision ────────────────────────────────────────────────────────────────

/** One acceptance requirement's outcome, for diagnostics. */
export interface RequirementEvaluation {
  /** The exact validator identity the plan pinned. */
  readonly requirement: ValidatorKey;
  /** What that implementation answered. */
  readonly outcome: ValidationOutcome;
}

/**
 * The decision taken over one proposal, bound to the exact execution and plan
 * revision it was taken for.
 *
 * `requirements` carries every gate's outcome, so a rejection explains itself
 * without re-running anything. An outcome with no acceptance requirements is
 * accepted: "every required gate passed" is vacuously true when nothing is
 * required.
 */
export interface AcceptanceDecision {
  readonly kind: "accepted" | "rejected";
  /** The trusted execution the decision belongs to. */
  readonly identity: ExecutionIdentity;
  /** The plan revision the decision was taken under. */
  readonly planRevision: string;
  /** Digest of the canonical proposal the decision is about. */
  readonly proposalDigest: string;
  /** The node the proposal claimed. */
  readonly nodeId: string;
  /** The outcome the proposal claimed. */
  readonly outcomeId: string;
  /** Every required gate, in the plan's declared order. */
  readonly requirements: readonly RequirementEvaluation[];
}

/**
 * The immutable binding a validation result carries: WHICH proposal content,
 * plan revision and execution it is evidence for. The commit rechecks it, and
 * a mismatch is a refusal — that is how "superseded validation cannot settle a
 * newer execution" is enforced rather than assumed.
 */
export interface ValidationBinding {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly planRevision: string;
  readonly proposalDigest: string;
}

/** Build the binding for one (identity, plan revision, proposal digest) triple. */
export function bindingOf(
  identity: ExecutionIdentity,
  planRevision: string,
  proposalDigest: string,
): ValidationBinding {
  return Object.freeze({
    graphId: identity.graphId,
    attemptId: identity.attemptId,
    submissionId: identity.submissionId,
    planRevision,
    proposalDigest,
  });
}

/** Whether two bindings describe the same proposal, plan revision and execution. */
export function bindingsEqual(a: ValidationBinding, b: ValidationBinding): boolean {
  return (
    a.graphId === b.graphId &&
    a.attemptId === b.attemptId &&
    a.submissionId === b.submissionId &&
    a.planRevision === b.planRevision &&
    a.proposalDigest === b.proposalDigest
  );
}

/** What {@link validateSubmission} answered. */
export type SubmissionValidation =
  | {
      readonly kind: "validated";
      readonly decision: AcceptanceDecision;
      readonly binding: ValidationBinding;
      /**
       * What the acceptance must RETAIN if it commits (P4 item 5 / A17): the
       * normalized proposal's payload and the artifact revisions the gates
       * actually read.
       *
       * It is captured at VALIDATION time on purpose. Re-deriving it at commit
       * time would read the paths again, and a path is exactly what may have
       * changed in the window between the two — the "validated A, committed B"
       * defect this record exists to make impossible.
       *
       * Present only for an ACCEPTED decision.
       */
      readonly retained?: {
        readonly payload: unknown;
        readonly artifacts: readonly ArtifactEvidence[];
      };
    }
  | { readonly kind: "refused"; readonly refusals: readonly SubmissionRefusal[] };

/** The request {@link commitSubmission} is given: the live inputs, the ledger, the validation. */
export interface CommitSubmissionRequest extends AcceptanceRequest {
  readonly ledger: AcceptanceLedger;
  readonly validation: SubmissionValidation;
}

/**
 * What a submission produced.
 *
 * `refused` wrote nothing at all. `submitted` carries the decision and the
 * ledger's verdict: only `verdict.kind === "committed"` means this decision is
 * the persisted one and its effects may run.
 */
export type SubmissionResult =
  | { readonly kind: "refused"; readonly refusals: readonly SubmissionRefusal[] }
  | {
      readonly kind: "submitted";
      readonly decision: AcceptanceDecision;
      readonly verdict: CommitResult;
    };

// ── Joining the acceptance transaction ──────────────────────────────────────

/**
 * What an accepted decision produces BESIDES the batch itself.
 *
 * Both halves are computed inside the caller's acceptance transaction, against
 * the state and ledger rows that transaction can see, so the graph state joins
 * the acceptance instead of landing in a second write a crash could separate.
 */
export interface AcceptanceJoinResult {
  /**
   * Extra pending effects this acceptance produces (a successor dispatch, for
   * example). They are stamped with the clock and the trusted graph exactly like
   * the request's own effects, and they are written in the SAME transaction as
   * the batch — but through the standalone intent write, NOT inside the batch:
   * the batch's effects must all name the receipt's attempt (one batch describes
   * one submission), while an armed successor's dispatch names the ARMED
   * attempt, which is the whole point of the row. Written only when the batch
   * actually committed, so a replay, conflict or settlement writes none.
   */
  readonly effects?: readonly PendingEffectInput[];
  /**
   * The extra write that commits with the batch — the graph state. It is
   * invoked ONLY when the batch actually committed: a `replayed`,
   * `conflict` or `settled` verdict writes no state, so a repeated submission
   * cannot advance the state twice. A throw here rolls the whole transaction
   * back, including the batch the commit just wrote.
   */
  readonly settle?: (tx: AcceptanceLedgerTx) => void;
}

/**
 * A caller's join into the acceptance transaction.
 *
 * Runs INSIDE the transaction, after the live-binding recheck and BEFORE the
 * batch is written, and ONLY for an ACCEPTED decision — a rejected decision
 * writes its receipt and changes no state. A throw (a rule violation, a state
 * that cannot be stored) propagates out of `runInTransaction` with the whole
 * transaction rolled back, so the caller's refusal and the acceptance can never
 * disagree about what was written.
 */
export type AcceptanceJoin = (
  tx: AcceptanceLedgerTx,
  decision: AcceptanceDecision,
) => AcceptanceJoinResult;

// ── Step 1: the refusal gates ───────────────────────────────────────────────

/** What reading a request produced: an evaluable submission, or the refusals. */
type RequestReading =
  | {
      readonly kind: "ok";
      readonly proposal: OutcomeProposal;
      readonly node: CompiledNode;
      readonly outcome: CompiledOutcome;
    }
  | { readonly kind: "refused"; readonly refusals: readonly SubmissionRefusal[] };

/**
 * Apply every "cannot even be evaluated" rule to one request and collect ALL
 * violations, in a fixed order, so a caller repairs in one pass.
 */
function readRequest(request: AcceptanceRequest): RequestReading {
  const refusals: SubmissionRefusal[] = [];
  if (!Number.isSafeInteger(request.now)) {
    refusals.push({
      code: "invalid-timestamp",
      path: "$.now",
      message: `now is ${describeValue(request.now)}, not epoch milliseconds (a safe integer) — time is an explicit input and the receipt records exactly the value this call was given`,
    });
  }
  refusals.push(...effectRefusals(request.effects));
  refusals.push(...planRefusals(request));

  const reading = readOutcomeProposal(request.proposal);
  if (reading.kind === "malformed") {
    for (const issue of reading.issues) {
      refusals.push({
        code: "malformed-proposal",
        path: issue.path,
        message: issue.message,
      });
    }
    return { kind: "refused", refusals };
  }
  const proposal = reading.proposal;

  const node = nodeOf(request.plan, proposal.nodeId);
  if (node === undefined) {
    refusals.push({
      code: "unknown-node",
      path: "$.nodeId",
      message: `node ${JSON.stringify(proposal.nodeId)} is not declared by plan revision ${request.plan.planRevision} — an outcome can only be claimed on a node the compiled plan declares`,
    });
    return { kind: "refused", refusals };
  }
  const outcome = outcomeOf(node, proposal.outcomeId);
  if (outcome === undefined) {
    refusals.push({
      code: "undeclared-outcome",
      path: "$.outcomeId",
      message: `node ${JSON.stringify(node.id)} does not declare outcome ${JSON.stringify(proposal.outcomeId)}; it declares [${node.outcomes.map((entry) => JSON.stringify(entry.id)).join(", ")}]`,
    });
    return { kind: "refused", refusals };
  }

  // The compiled plan's own pinning rule, re-applied here: an executable plan
  // names an EXACT version for every requirement. A requirement without one has
  // no identity to look up, and "any version" is exactly the silent widening
  // the protocol forbids.
  outcome.acceptance.forEach((requirement, index) => {
    if (!isPositiveSafeInteger(requirement.version)) {
      refusals.push({
        code: "non-executable-plan",
        path: `$.outcome.acceptance[${index}]`,
        message: `acceptance requirement ${index} of outcome ${JSON.stringify(outcome.id)} on node ${JSON.stringify(node.id)} names validator ${JSON.stringify(requirement.validator)} without an exact version — an executable plan pins every requirement, and an unpinned gate is refused rather than widened to "any version"`,
      });
    }
  });

  if (refusals.length > 0) return { kind: "refused", refusals };
  return { kind: "ok", proposal, node, outcome };
}

/** The plan-level gates: executability, submitted revision, graph identity. */
function planRefusals(request: AcceptanceRequest): SubmissionRefusal[] {
  const refusals: SubmissionRefusal[] = [];
  const executability = readPlanExecutability(request.plan.executability);
  if (executability.kind === "draft") {
    // The reading classifies; the BODY carries what is unresolved, so the
    // refusal can name every reason the draft left open — acceptance gates
    // (B9) and unauthorized natural-completion mappings (D6) alike.
    const draft =
      request.plan.executability.kind === "draft"
        ? request.plan.executability
        : undefined;
    const unresolved = draft?.unresolved ?? [];
    const unauthorized = draft?.unauthorizedCompletions ?? [];
    refusals.push({
      code: "non-executable-plan",
      path: "$.plan.executability",
      message:
        `plan revision ${request.plan.planRevision} is a NON-EXECUTABLE DRAFT: ` +
        `${unresolved.length} acceptance requirement(s) did not resolve to an exact validator version (${describeUnresolved(unresolved)}), and ` +
        `${unauthorized.length} natural-completion mapping(s) are not authorized (${describeUnauthorizedCompletions(unauthorized)}) — a draft is refused outright and nothing was written`,
    });
  } else if (executability.kind === "malformed") {
    refusals.push({
      code: "malformed-plan",
      path: "$.plan.executability",
      message:
        `plan revision ${request.plan.planRevision} does not carry a readable executability marker ` +
        `(neither { kind: "executable" } nor { kind: "draft", unresolved: [...] }) — the plan cannot be shown to be executable, so nothing was written`,
    });
  }
  if (request.submittedPlanRevision !== request.plan.planRevision) {
    refusals.push({
      code: "plan-revision-mismatch",
      path: "$.submittedPlanRevision",
      message:
        `the submitted binding names plan revision ${JSON.stringify(request.submittedPlanRevision)}, but the plan supplied is ${JSON.stringify(request.plan.planRevision)} — ` +
        "a submission is judged against the revision its attempt is bound to, and nothing was written",
    });
  }
  if (request.identity.graphId !== request.plan.graphId) {
    refusals.push({
      code: "graph-mismatch",
      path: "$.identity.graphId",
      message:
        `the trusted execution names graph ${JSON.stringify(request.identity.graphId)}, but the plan supplied is the compiled plan of ${JSON.stringify(request.plan.graphId)} — ` +
        "provenance and plan must name one graph, and nothing was written",
    });
  }
  return refusals;
}

/** The effect-batch gates: ids and kinds are non-empty, ids are unique. */
function effectRefusals(
  effects: readonly PendingEffectInput[] | undefined,
): SubmissionRefusal[] {
  if (effects === undefined) return [];
  const refusals: SubmissionRefusal[] = [];
  if (!Array.isArray(effects)) {
    return [
      {
        code: "malformed-effect",
        path: "$.effects",
        message: `effects is ${describeValue(effects)}, not an array of pending effects`,
      },
    ];
  }
  const seen = new Set<string>();
  effects.forEach((effect, index) => {
    if (typeof effect.effectId !== "string" || effect.effectId.length === 0) {
      refusals.push({
        code: "malformed-effect",
        path: `$.effects[${index}].effectId`,
        message: `effect id is ${describeValue(effect.effectId)}, not a non-empty stable id`,
      });
    } else if (seen.has(effect.effectId)) {
      refusals.push({
        code: "malformed-effect",
        path: `$.effects[${index}].effectId`,
        message: `effect id ${JSON.stringify(effect.effectId)} appears twice in one batch — one stable id names one effect, and a duplicate would be refused by the store's own key anyway`,
      });
    } else {
      seen.add(effect.effectId);
    }
    if (typeof effect.kind !== "string" || effect.kind.length === 0) {
      refusals.push({
        code: "malformed-effect",
        path: `$.effects[${index}].kind`,
        message: `effect kind is ${describeValue(effect.kind)}, not a non-empty kind`,
      });
    }
  });
  return refusals;
}

// ── Steps 2-4: validate and decide (no ledger) ──────────────────────────────

/**
 * Normalize and digest the proposal, run every pinned acceptance requirement
 * outside any transaction, and decide.
 *
 * Writes nothing: a refusal is returned as structured diagnostics, and a
 * decision is returned as a value bound to the digest, plan revision and
 * execution identity the results were produced under. Nothing here reads a
 * clock or touches a ledger.
 */
export function validateSubmission(
  request: AcceptanceRequest,
): SubmissionValidation {
  const reading = readRequest(request);
  if (reading.kind === "refused") {
    return { kind: "refused", refusals: reading.refusals };
  }
  const { proposal, node, outcome } = reading;

  let normalized: NormalizedOutcomeProposal;
  let digest: string;
  try {
    normalized = normalizeProposal(proposal);
    digest = proposalDigest(normalized);
  } catch (error) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "unrepresentable-proposal",
          path: "$.data",
          message:
            `the proposal cannot be content-addressed, so no receipt could honestly be bound to it: ${errorText(error)}`,
        },
      ],
    };
  }

  const planRevision = request.plan.planRevision;
  const identity = freezeIdentity(request.identity);

  // Resolve EVERY implementation before running ANY of them: a requirement with
  // no registered implementation is a refusal, and running the others first
  // would make a partially checked submission look evaluated.
  const resolved: {
    readonly key: ValidatorKey;
    readonly implementation: ValidatorImplementation;
  }[] = [];
  const missing: SubmissionRefusal[] = [];
  outcome.acceptance.forEach((requirement, index) => {
    // The version is present: readRequest refused an unpinned requirement.
    if (!isPositiveSafeInteger(requirement.version)) return;
    const key: ValidatorKey = Object.freeze({
      id: requirement.validator,
      version: requirement.version,
    });
    const implementation = request.validators.lookup(key);
    if (implementation === undefined) {
      missing.push({
        code: "validator-not-registered",
        path: `$.outcome.acceptance[${index}]`,
        message:
          `acceptance requirement ${index} of outcome ${JSON.stringify(outcome.id)} pins validator ${validatorKeyText(key)}, and this build has no implementation registered at that exact identity — ` +
          `a required gate without an implementation is REFUSED, never skipped. Registered: ${describeKeys(request.validators.keys)}`,
      });
      return;
    }
    resolved.push({ key, implementation });
  });
  if (missing.length > 0) return { kind: "refused", refusals: missing };

  const requirements: RequirementEvaluation[] = resolved.map(
    ({ key, implementation }): RequirementEvaluation => {
      let result: ValidationOutcome;
      try {
        result = implementation({
          key,
          proposal: normalized,
          proposalDigest: digest,
          planRevision,
          identity,
          artifactRoot: request.artifactRoot,
          // THE PLAN'S OWN DATA CONTRACT (P4 item 2): the schema identity the
          // outcome declares is trusted plan content, so a payload-shape
          // validator resolves what the PLAN pinned rather than anything the
          // submission carried.
          ...(outcome.data === undefined
            ? {}
            : {
                dataContract: {
                  schema: outcome.data.schema,
                  ...(outcome.data.version === undefined
                    ? {}
                    : { version: outcome.data.version }),
                },
              }),
          now: request.now,
        });
      } catch (error) {
        // An implementation that throws is an INDETERMINATE result, not an
        // accident that decides the gate: the protocol's third answer exists
        // exactly for "the check could not be completed".
        result = {
          kind: "indeterminate",
          reason: `validator ${validatorKeyText(key)} threw (${errorText(error)}) — an indeterminate result never satisfies a required gate`,
        };
      }
      return Object.freeze({ requirement: key, outcome: result });
    },
  );

  const accepted = requirements.every(
    (entry) => entry.outcome.kind === "pass",
  );
  const decision: AcceptanceDecision = Object.freeze({
    kind: accepted ? "accepted" : "rejected",
    identity,
    planRevision,
    proposalDigest: digest,
    nodeId: node.id,
    outcomeId: outcome.id,
    requirements: Object.freeze(requirements),
  });
  // THE EVIDENCE THE GATES THEMSELVES PRODUCED, in requirement order. It comes
  // from the pass results rather than from a second read of the paths, so what
  // is retained is exactly what was judged.
  const evidence = requirements.flatMap((entry) =>
    entry.outcome.kind === "pass" ? (entry.outcome.evidence ?? []) : [],
  );
  return {
    kind: "validated",
    decision,
    binding: bindingOf(identity, planRevision, digest),
    ...(accepted
      ? {
          retained: Object.freeze({
            // A submission that carried no data is stored as `null`: an absent
            // payload is a VALUE here, not an unrepresentable one, and the
            // store's JSON gate refuses `undefined`.
            payload: normalized.data ?? null,
            artifacts: Object.freeze(evidence),
          }),
        }
      : {}),
  };
}

// ── Steps 5-6: the atomic commit ────────────────────────────────────────────

/** What one transaction attempt produced. */
type CommitAttempt =
  | { readonly kind: "committed"; readonly verdict: CommitResult }
  | { readonly kind: "stale"; readonly live: ValidationBinding | undefined };

/**
 * Commit a validation's decision through the ledger in ONE batch.
 *
 * The request is re-read first, so a commit that is handed inputs the gates
 * would now refuse gets the precise refusal. Then, INSIDE the transaction, the
 * live binding is re-derived from the request as it is at commit time and
 * compared with the binding validation recorded: a superseded proposal, plan
 * revision or execution is refused with nothing written, because validation ran
 * outside this boundary by design and its result is evidence for exactly the
 * inputs it saw.
 *
 * Accepted: receipt + accepted event + the submission's own pending effects in
 * one batch. Rejected: the receipt ONLY — no event, so the attempt stays open.
 *
 * The optional `join` runs inside that same transaction, after the recheck and
 * before the batch is written, and is where a caller's graph state joins the
 * acceptance: its effects (work for an attempt the acceptance ARMED) and its
 * `settle` write both run only after the batch actually committed, in the same
 * transaction. See {@link AcceptanceJoin}.
 */
export function commitSubmission(
  request: CommitSubmissionRequest,
  join?: AcceptanceJoin,
): SubmissionResult {
  const validation = request.validation;
  if (validation.kind === "refused") {
    return { kind: "refused", refusals: validation.refusals };
  }
  const reading = readRequest(request);
  if (reading.kind === "refused") {
    return { kind: "refused", refusals: reading.refusals };
  }

  const decision = validation.decision;
  // The payload and the retained artifact revisions the VALIDATION observed.
  // Absent when the decision was rejected, or when the plan's gates took no
  // artifact evidence — never synthesized at commit time, where the path may
  // already name different bytes.
  const retained = validation.retained;
  const now = request.now;
  const identity = request.identity;
  const effects = pendingEffectsOf(request.effects, identity, now);

  const attempt = request.ledger.runInTransaction((tx): CommitAttempt => {
    const live = liveBindingOf(request);
    if (live === undefined || !bindingsEqual(live, validation.binding)) {
      return { kind: "stale", live };
    }
    const receipt: ReceiptRecord = Object.freeze({
      graphId: identity.graphId,
      attemptId: identity.attemptId,
      submissionId: identity.submissionId,
      planRevision: live.planRevision,
      proposalDigest: live.proposalDigest,
      decision: decision.kind,
      committedAt: now,
    });
    // The join is computed INSIDE the transaction, before the batch exists, so
    // the state it reduces is the state the committing transaction sees and a
    // rule violation rolls back before anything is written. It is skipped for a
    // rejected decision: a receipt-only commit changes no graph state.
    const joined =
      decision.kind === "accepted" && join !== undefined
        ? join(tx, decision)
        : undefined;
    const batch: GraphAcceptanceBatch =
      decision.kind === "accepted"
        ? {
            receipt,
            acceptedEvent: Object.freeze({
              graphId: receipt.graphId,
              attemptId: receipt.attemptId,
              submissionId: receipt.submissionId,
              planRevision: receipt.planRevision,
              outcomeId: decision.outcomeId,
              acceptedAt: now,
            }),
            // THE BATCH CARRIES THE SUBMISSION'S OWN EFFECTS, and only those: the
            // store's batch gate refuses an effect whose attempt is not the
            // receipt's, which is the guarantee that one batch describes one
            // submission.
            effects,
            // THE ACCEPTED RESULT RIDES THE SAME BATCH (P4 item 5 / A17). The
            // payload and the artifact revisions this acceptance RETAINED commit
            // with the receipt, the event and the effects, so a result can never
            // be readable for an attempt whose receipt did not commit — and a
            // consumer resolves the revision THIS RECORD names, never the path
            // the reference once pointed at.
            ...(retained === undefined
              ? {}
              : {
                  acceptedResult: {
                    graphId: identity.graphId,
                    attemptId: identity.attemptId,
                    planRevision: receipt.planRevision,
                    payload: retained.payload,
                    artifacts: retained.artifacts,
                    acceptedAt: now,
                  },
                }),
          }
        : { receipt };
    const verdict = tx.commitAccepted(batch);
    // The state joins only a batch that actually COMMITTED: a replay, conflict
    // or settlement must not advance the state a second time.
    if (verdict.kind === "committed") {
      // AN ARMED SUCCESSOR'S EFFECT IS WRITTEN WITH THE ADVANCE (P3 item 2). It
      // is work for the attempt the acceptance ARMED, not for the submitting
      // attempt whose receipt this batch holds, so it cannot ride the
      // submission's batch without weakening the one-submission rule above. It
      // is written here instead — the SAME transaction, after the batch landed,
      // through the standalone intent write — under its own attempt id, which is
      // the same attempt its effect id names, so an attempt-scoped fence joins
      // the row to the execution it describes. The entry path writes its intents
      // the same way, beside the state they belong to.
      for (const effect of pendingEffectsOf(joined?.effects, identity, now)) {
        tx.writeEffect(effect);
      }
      joined?.settle?.(tx);
    }
    return { kind: "committed", verdict };
  });

  if (attempt.kind === "stale") {
    return {
      kind: "refused",
      refusals: [staleRefusal(validation.binding, attempt.live)],
    };
  }
  return { kind: "submitted", decision, verdict: attempt.verdict };
}

/**
 * Validate, then commit: the ordinary one-call entry point.
 *
 * The same request object is handed to both phases, so the commit's recheck
 * passes by construction for a caller that changes nothing between them.
 */
export function submitOutcome(
  request: SubmissionRequest,
  join?: AcceptanceJoin,
): SubmissionResult {
  const validation = validateSubmission({
    plan: request.plan,
    submittedPlanRevision: request.submittedPlanRevision,
    identity: request.identity,
    proposal: request.proposal,
    validators: request.validators,
    artifactRoot: request.artifactRoot,
    effects: request.effects,
    now: request.now,
  });
  return commitSubmission({ ...request, validation }, join);
}

// ── Commit helpers ──────────────────────────────────────────────────────────

/**
 * Re-derive the binding from the request's LIVE inputs: the proposal's
 * canonical digest as it is now, the plan's own revision and the trusted
 * identity. `undefined` means the proposal can no longer be digested at all.
 */
function liveBindingOf(request: AcceptanceRequest): ValidationBinding | undefined {
  const reading = readOutcomeProposal(request.proposal);
  if (reading.kind === "malformed") return undefined;
  try {
    return bindingOf(
      request.identity,
      request.plan.planRevision,
      proposalDigest(reading.proposal),
    );
  } catch {
    return undefined;
  }
}

/** Name exactly which recorded binding field no longer matches the live one. */
function staleRefusal(
  recorded: ValidationBinding,
  live: ValidationBinding | undefined,
): SubmissionRefusal {
  if (live === undefined) {
    return {
      code: "stale-validation",
      path: "$",
      message:
        "the proposal this commit was handed no longer has a canonical digest, so the recorded validation does not describe it — " +
        "validation runs outside the transaction, and a result that cannot be re-bound to the live inputs is refused; nothing was written",
    };
  }
  const differences: string[] = [];
  const fields: readonly (keyof ValidationBinding)[] = [
    "graphId",
    "attemptId",
    "submissionId",
    "planRevision",
    "proposalDigest",
  ];
  for (const field of fields) {
    if (recorded[field] !== live[field]) {
      differences.push(
        `${field} ${JSON.stringify(recorded[field])} -> ${JSON.stringify(live[field])}`,
      );
    }
  }
  return {
    code: "stale-validation",
    path: "$",
    message:
      `the recorded validation is STALE: ${differences.join(", ")} — ` +
      "validation runs outside the transaction, so the commit rechecks the digest, plan revision and execution identity it recorded and refuses to settle a newer execution with evidence gathered for an older one; nothing was written",
  };
}

/**
 * Stamp the caller's effect descriptions with trusted provenance.
 *
 * `graphId` comes from the execution identity, `createdAt` from the explicit
 * clock, and the status is always the initial `pending`: an acceptance commit
 * records work to be done, never work already started. The attempt is the
 * INPUT's own when it names one — a dispatch armed for a successor is work for
 * the ARMED attempt — and the submitting identity's attempt otherwise.
 */
function pendingEffectsOf(
  inputs: readonly PendingEffectInput[] | undefined,
  identity: ExecutionIdentity,
  now: number,
): readonly PendingEffectRecord[] {
  if (inputs === undefined) return Object.freeze([]);
  return Object.freeze(
    inputs.map((input): PendingEffectRecord =>
      Object.freeze({
        graphId: identity.graphId,
        effectId: input.effectId,
        attemptId: input.attemptId ?? identity.attemptId,
        kind: input.kind,
        payload: input.payload,
        createdAt: now,
        status: "pending" as const,
      }),
    ),
  );
}

/** A frozen copy of the trusted identity, so a later mutation cannot rewrite it. */
function freezeIdentity(identity: ExecutionIdentity): ExecutionIdentity {
  return Object.freeze({
    graphId: identity.graphId,
    attemptId: identity.attemptId,
    submissionId: identity.submissionId,
  });
}

// ── Lookups and descriptions ────────────────────────────────────────────────

/** The declared node with this id, or `undefined`. */
function nodeOf(plan: CompiledPlan, nodeId: string): CompiledNode | undefined {
  for (const node of plan.nodes) {
    if (node.id === nodeId) return node;
  }
  return undefined;
}

/** The declared outcome with this id on this node, or `undefined`. */
function outcomeOf(
  node: CompiledNode,
  outcomeId: string,
): CompiledOutcome | undefined {
  for (const outcome of node.outcomes) {
    if (outcome.id === outcomeId) return outcome;
  }
  return undefined;
}

/** Describe a draft's unresolved requirements without ever throwing. */
function describeUnresolved(
  unresolved: readonly CompiledUnresolvedRequirement[],
): string {
  return unresolved
    .map(
      (entry) =>
        `${entry.nodeId}.${entry.outcomeId}:${entry.validator}` +
        (entry.version === undefined ? "" : `@${entry.version}`),
    )
    .join(", ");
}

/** Describe a draft's unauthorized completions without ever throwing. */
function describeUnauthorizedCompletions(
  unauthorized: readonly CompiledUnauthorizedCompletion[],
): string {
  if (unauthorized.length === 0) return "none";
  return unauthorized
    .map(
      (entry) =>
        `${entry.nodeId}.${entry.outcome}:${entry.code}` +
        (entry.request === undefined
          ? ""
          : `@${entry.request.id}@${entry.request.revision}`),
    )
    .join(", ");
}

/** Describe a registry's installed keys for a refusal diagnostic. */
function describeKeys(keys: readonly ValidatorKey[]): string {
  if (keys.length === 0) return "none";
  return keys.map((key) => validatorKeyText(key)).join(", ");
}

/** Whether a value is a positive safe integer (the plan's pinning rule). */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

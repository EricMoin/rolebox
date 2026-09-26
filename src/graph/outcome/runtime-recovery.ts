/**
 * THE DISPATCH AND CREDENTIAL-RECOVERY COLLABORATOR of the outcome run path
 * (D8, plan §3.3).
 *
 * WHY IT EXISTS. Three jobs share ONE subject — an attempt whose execution may
 * or may not exist yet: launching the dispatches a transaction just committed,
 * reconciling the ones a process that is gone left unsettled, and resolving or
 * conditionally re-issuing the credential an attempt is settled with. They were
 * carried by the runtime class itself, which made the run path's own state
 * machine and its host seam one unit; here they are one collaborator with an
 * explicit constructor and no state beyond the identities and seams it is
 * handed.
 *
 * WHAT IT IS NOT. It owns no transition: it never advances the graph, never
 * decides an acceptance, and writes no state row except the ONE conditional
 * credential re-issue ({@link OutcomeDispatchRecovery.replaceAttemptCredential}),
 * which commits in its own transaction exactly as it did before. Every refusal
 * code, path and message travels back to the runtime unchanged.
 */
import { errorText } from "../../utils/error-text.ts";
import type { CompiledNode, CompiledPlan } from "../compiler/plan.ts";
import type { AcceptanceLedger, PendingEffectRecord } from "../ledger/types.ts";
import {
  attemptCredentialBinding,
  attemptCredentialDigest,
  isAttemptCredential,
  type AttemptCredentialSource,
} from "./attempt-credential.ts";
import {
  CREDENTIAL_ISOLATION_VERSION_V3,
  type CredentialIsolationStore,
} from "./credential-isolation.ts";
import {
  dispatchEffectIdOf,
  dispatchEffectKeyOf,
  type NormalizedOutcomeDispatch,
  type OutcomeDispatchEffectKey,
  type OutcomeDispatchRequest,
  type OutcomeDispatchTarget,
  type OutcomeExecutionLookup,
} from "./dispatch-effects.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  OutcomeAdvanceRefusedError,
  OutcomeStateError,
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeDispatchIntent,
  type OutcomeGraphState,
} from "./graph-state.ts";
import type { ResolvedInput } from "./inputs.ts";
import type {
  AttemptReissueClaim,
  AttemptCredentialReissueFence,
  OutcomeEffectDivergence,
  OutcomeReconciledEffect,
  OutcomeReconciledReason,
  OutcomeRuntimeRefusal,
} from "./runtime-contract.ts";
import {
  ledgerReadRefusal,
  refusalForStoppingDecision,
  runControl,
  stateRefusal,
  stoppingDecisionOf,
} from "./runtime-refusals.ts";
import {
  dispatchedNodeOf,
  readDispatchRequest,
  stateNodeOf,
} from "./runtime-readings.ts";

/** What the collaborator is given: the run path's identities and its three seams. */
export interface OutcomeDispatchRecoveryContext {
  readonly graphId: string;
  readonly planRevision: string;
  readonly plan: CompiledPlan;
  readonly ledger: AcceptanceLedger;
  /**
   * The host's dispatch adapter (D8). Absent means this runtime holds no seam an
   * execution could travel through, which {@link dispatchCapabilityRefusal}
   * refuses by name before anything is read or written.
   */
  readonly dispatch: NormalizedOutcomeDispatch | undefined;
  /** The host's create-right fence (plan §3.3); absent means no re-issue. */
  readonly reissueFence: AttemptCredentialReissueFence | undefined;
  /** The host store the credential of a recovered attempt is resolved from. */
  readonly credentialStore: CredentialIsolationStore | undefined;
  /**
   * The credential source the run path uses, wrapped so that every credential
   * it mints is adopted by the host's store before the state recording its
   * digest can be committed, so a re-issue and the verifier that supersedes the
   * old one are one commit.
   */
  readonly credentialSource: AttemptCredentialSource;
}

/**
 * The dispatch seam and the credential recovery of ONE outcome-protocol graph.
 *
 * The runtime constructs it once, from the same fields it reads today, and
 * delegates: {@link launch} after a commit that armed dispatches, {@link reconcile}
 * on a restart, {@link unsettledEffectReading} for every report, and the request
 * builders the reducer persists its effects with.
 */
export class OutcomeDispatchRecovery {
  private readonly graphId: string;
  private readonly planRevision: string;
  private readonly plan: CompiledPlan;
  private readonly ledger: AcceptanceLedger;
  private readonly dispatch: NormalizedOutcomeDispatch | undefined;
  private readonly reissueFence: AttemptCredentialReissueFence | undefined;
  private readonly credentialStore: CredentialIsolationStore | undefined;
  private readonly credentialSource: AttemptCredentialSource;

  constructor(context: OutcomeDispatchRecoveryContext) {
    this.graphId = context.graphId;
    this.planRevision = context.planRevision;
    this.plan = context.plan;
    this.ledger = context.ledger;
    this.dispatch = context.dispatch;
    this.reissueFence = context.reissueFence;
    this.credentialStore = context.credentialStore;
    this.credentialSource = context.credentialSource;
  }

  /**
   * Check that this runtime holds a dispatch adapter at all (D8).
   *
   * A no-op dispatcher is not a neutral stand-in: the effect ledger would
   * record an execution that nobody started and the worker would never receive
   * its attempt credential, while every durable surface reads as if the node
   * were running. Refusing by name — before any state is read or written, in
   * `start`, `resume` and `submit` alike — is what makes "a dispatch is only
   * recorded when a host can perform it" true by construction. Production
   * entries check the same condition before they open a ledger, so the common
   * case never reaches this guard.
   */
  dispatchCapabilityRefusal(): OutcomeRuntimeRefusal | undefined {
    if (this.dispatch !== undefined) return undefined;
    return {
      code: "dispatch-unavailable",
      message:
        "outcome-runtime: graph " +
        JSON.stringify(this.graphId) +
        " was given no dispatch adapter — a node's execution has to go somewhere, and a " +
        "no-op would let this runtime record a dispatch it never performed, so nothing is " +
        "started, resumed or settled",
    };
  }

  /**
   * Execute the dispatch effects a transaction THIS CALL committed (D8).
   *
   * THE ORDER IS UNCHANGED: the host is called in order and the first throw
   * stops the loop, so requests after it stay unlaunched exactly as before —
   * but now their effects are durable rows, not lost intentions. Each effect's
   * row is marked `started` AFTER its create returns: the status is a record of
   * a create that happened, never a substitute for one, so a crash inside the
   * call leaves a `pending` row a recovery can put to the host.
   *
   * WHY THIS PATH DOES NOT ASK THE HOST FIRST. Every request here belongs to an
   * effect the SAME transaction committed, under an attempt id minted in that
   * transaction, so no earlier process can have created it — there is no crash
   * window to resolve and the create is the first attempt, not a retry. The
   * reconciliation query exists for the OTHER path (`resume`), where the row
   * was written by a process that is gone.
   *
   * The one added rule is about what escapes: the host is the delivery channel
   * and necessarily receives each request's credential, so a failure text that
   * echoes the request it was given (a plausible adapter bug) must not become
   * the way that credential reaches a *report* — and for `submit` the caller
   * that would receive it is the submitting worker, which is not entitled to a
   * successor's credential. The message is therefore checked against the
   * launch set before it leaves this class.
   */
  launch(requests: readonly OutcomeDispatchRequest[]): void {
    try {
      for (const request of requests) {
        this.createExecution(request);
        // THE CREATE RETURNED, SO THE ROW MAY SAY SO. A row that cannot be
        // marked is a disagreement worth failing on: the execution exists and
        // the ledger does not record it, which a recovery would otherwise have
        // to re-derive from the host.
        const marked = this.markDispatchStarted(request.attemptId);
        if (marked !== undefined) throw new Error(marked.message);
      }
    } catch (error) {
      throw this.credentialSafeDispatchError(error, requests);
    }
  }

  /**
   * Ask the host to create one effect's execution.
   *
   * The request travels with the stable effect key, so a host that dedupes on
   * it satisfies the contract's idempotency rule without re-deriving the id.
   */
  createExecution(request: OutcomeDispatchRequest): void {
    const host = this.dispatch;
    if (host === undefined) {
      // Unreachable behind {@link dispatchCapabilityRefusal}; kept total so a
      // caller that bypasses the typed option gets the refusal, not a crash.
      throw new Error(this.dispatchCapabilityRefusal()?.message ?? "");
    }
    host.create(request, dispatchEffectKeyOf(this.graphId, request.attemptId));
  }

  /**
   * Record that one attempt's execution was created, or describe why the row
   * could not say so.
   *
   * `transitioned` and `unchanged` both mean the row now reads `started`.
   * `missing` means the effect row is not there at all and `refused` means a
   * terminal row would have to be rewound — both are state/ledger disagreements
   * about an execution the host may already have, so neither is swallowed.
   */
  markDispatchStarted(
    attemptId: string,
  ): OutcomeRuntimeRefusal | undefined {
    const effectId = dispatchEffectIdOf(attemptId);
    const transition = this.ledger.markEffectStarted(this.graphId, effectId);
    if (transition.kind === "transitioned" || transition.kind === "unchanged") {
      return undefined;
    }
    return {
      code: "state-ledger-disagreement",
      path: "$.effectId",
      message:
        "outcome-runtime: the dispatch effect " +
        JSON.stringify(effectId) +
        " of graph " +
        JSON.stringify(this.graphId) +
        " could not be marked started (" +
        transition.reason +
        ") — the host may already hold this execution, so the attempt is not " +
        "re-launched and the effect stays unsettled",
    };
  }

  /**
   * The error a failed dispatch launch is reported as, with every credential
   * the seam was handed removed from its message.
   *
   * The original name is carried over and the original value is attached as
   * `cause`, so an in-process caller that genuinely needs the unsanitized text
   * still has an explicit handle on it while the REPORTED message stays
   * credential-free. When nothing was replaced the original message is used
   * verbatim — sanitizing is visible, never silent.
   */
  credentialSafeDispatchError(
    error: unknown,
    requests: readonly OutcomeDispatchRequest[],
  ): Error {
    const raw = errorText(error);
    const sanitized = this.withoutCredentials(
      raw,
      requests.map((request) => request.credential),
    );
    const reported =
      sanitized === raw
        ? raw
        : "outcome-runtime: the dispatch seam failed and its message echoed an attempt " +
        "credential, which was removed from this report: " +
        sanitized;
    const wrapped = new Error(reported, { cause: error });
    if (error instanceof Error) wrapped.name = error.name;
    return wrapped;
  }

  /** Every given credential value in `text`, replaced by one fixed marker. */
  withoutCredentials(
    text: string,
    credentials: readonly string[],
  ): string {
    let out = text;
    for (const credential of credentials) {
      if (credential.length === 0 || !out.includes(credential)) continue;
      out = out.split(credential).join("[redacted attempt credential]");
    }
    return out;
  }

  /**
   * Resolve the unsettled dispatch effects the STATE corroborates (D8 resume).
   *
   * EVERY EFFECT GOES THROUGH THE SAME DECISION — ask the host, then act on its
   * answer — so a restart cannot resolve one crash window two different ways:
   *
   * - the host answers `created` → the execution exists. The row is marked
   *   `started` and reported as RECONCILED; the create is NEVER re-issued (a
   *   second create is exactly what could run one attempt twice);
   * - the host answers `absent` → the execution definitively does not exist
   *   (the crash-after-commit-before-launch window). It is created once, and the
   *   row is marked `started` only AFTER the create returns — the status
   *   records what happened, it is not a substitute for finding out;
   * - the host answers `unknown`, or there is no query capability at all →
   *   the runtime does not know whether the execution exists. NOTHING is
   *   launched and the effect is reported with `dispatch-unreconciled` as work
   *   for the host (or a human) to reconcile: re-issuing the create could
   *   execute an attempt twice, and reporting success would hide an attempt
   *   that never started.
   *
   * A row already `started` is NEVER re-created: a previous process recorded a
   * create that returned, and the report says so. If the host contradicts that
   * record with `absent`, the disagreement is REPORTED rather than acted on —
   * the stored fact and the host fact must be reconciled before either is
   * trusted with a second create.
   *
   * The STATE is the authority on the arm set — an effect the state does not
   * corroborate (wrong node, wrong attempt, node not dispatched) is never
   * launched and is reported as a refusal; it stays unsettled.
   */
  reconcile(
    state: OutcomeGraphState,
    /**
     * The instant this recovery runs at. It timestamps the one write recovery
     * performs — a §3.3 credential re-issue — so the state that records the new
     * verifier carries the same explicit time the caller supplied everywhere
     * else, never a clock read inside a transaction.
     */
    at: number,
  ):
    | {
      readonly launched: readonly OutcomeDispatchRequest[];
      readonly reconciled: readonly OutcomeReconciledEffect[];
      readonly divergences: readonly OutcomeEffectDivergence[];
      readonly refusals: readonly OutcomeRuntimeRefusal[];
      /**
       * Whether this pass REWROTE the persisted state by re-issuing a lost
       * attempt credential (§3.3). The caller re-reads the state it reports
       * when it did, so the reported state is the one that is stored.
       */
      readonly reissued: boolean;
    }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    let effects: readonly PendingEffectRecord[];
    try {
      effects = this.ledger.pendingEffects(this.graphId);
    } catch (error) {
      return { refusal: ledgerReadRefusal(this.graphId, error) };
    }
    const host = this.dispatch;
    if (host === undefined) {
      // Unreachable behind {@link dispatchCapabilityRefusal}; kept total so an
      // untyped caller gets the refusal rather than a crash.
      const unavailable = this.dispatchCapabilityRefusal();
      return {
        refusal:
          unavailable ?? {
            code: "dispatch-unavailable",
            message:
              "outcome-runtime: no dispatch adapter is installed for graph " +
              JSON.stringify(this.graphId),
          },
      };
    }
    const launched: OutcomeDispatchRequest[] = [];
    const reconciled: OutcomeReconciledEffect[] = [];
    const divergences: OutcomeEffectDivergence[] = [];
    const refusals: OutcomeRuntimeRefusal[] = [];
    let reissued = false;
    for (const effect of effects) {
      if (effect.kind !== "dispatch") continue;
      const reading = readDispatchRequest(
        effect.payload,
        this.graphId,
        this.planRevision,
      );
      if (reading.kind === "malformed") {
        refusals.push({
          code: "malformed-effect",
          path: "$.payload",
          message: reading.message,
        });
        continue;
      }
      const target = reading.target;
      const armed = dispatchedNodeOf(state, target.nodeId);
      if (armed === undefined || armed.attemptId !== target.attemptId) {
        // A SETTLED ATTEMPT IS A COMPLETE DISPATCH. The state records the node
        // settled on exactly this attempt, so its execution demonstrably ran
        // (a settlement is only possible with the credential the create handed
        // out) and the row is closed instead of reported as a disagreement.
        const recorded = stateNodeOf(state, target.nodeId);
        if (
          recorded !== undefined &&
          recorded.status === "settled" &&
          recorded.attemptId === target.attemptId
        ) {
          this.ledger.markEffectDone(this.graphId, effect.effectId);
          reconciled.push(
            this.reconciledEffectOf(effect.effectId, target.attemptId, "attempt-settled"),
          );
          continue;
        }
        refusals.push({
          code: "state-ledger-disagreement",
          path: "$.attemptId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", but the persisted state does not record that attempt as in flight — " +
            "the effect was not launched and stays unsettled",
        });
        continue;
      }
      // THE INPUT VIEW IS DELIVERED FROM THE PERSISTED STATE, NEVER RE-DERIVED
      // (D6). The binding was decided in the transaction that armed this attempt
      // and the state carries it verbatim, so a restarted process hands the
      // worker exactly what the arming process resolved — a loop round, a retry
      // or a re-execution that moved a producing node to a newer attempt cannot
      // rebind a consumer that is already in flight.
      //
      // AN ATTEMPT WITH NO BOUND VIEW FOR A NODE THAT DECLARES INPUTS IS NEVER
      // LAUNCHED (D6): it was armed by a body version that did not bind one, and
      // starting it would give the worker a hole where its input should be. The
      // refusal is reported here, before the credential is re-issued, so nothing
      // is prepared for an execution that must not exist.
      const declaredInputs = this.compiledNodeOf(target.nodeId)?.inputs ?? [];
      if (armed.inputs === undefined && declaredInputs.length > 0) {
        refusals.push({
          code: "dispatch-input-unbound",
          path: "$.attemptId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " targets node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", which DECLARES " +
            String(declaredInputs.length) +
            " input(s), but the persisted state entry for that attempt records no bound " +
            "input view — it was armed before this build bound inputs to the attempt, so " +
            "it is NOT launched with a hole where its input should be: the effect stays " +
            "unsettled and this node must be armed again under this build (a trusted " +
            "retry or a re-execution mints an attempt that carries the binding)",
        });
        continue;
      }
      // THE STATE ENTRY IS THE AUTHORITY for the delivered view: it is the record
      // the reader verifies and the one this decision has just been made
      // against. An entry armed by this build always carries a list — empty when
      // the node declares none.
      const boundInputs: readonly ResolvedInput[] = armed.inputs ?? Object.freeze([]);
      // THE BINDING IS READ FROM THE PERSISTED STATE, AND THE CREDENTIAL FROM
      // THE HOST'S STORE. The payload is credential-free on purpose and the
      // state records only the DIGEST, so the credential a recovered worker
      // receives is resolved from the capability that adopted it at mint time.
      // An attempt whose entry carries no digest (a body version that persisted
      // the credential itself, or none at all) and one whose credential the host
      // store can no longer produce are BOTH refused rather than launched
      // without a credential or granted a fresh one for a new execution.
      if (armed.attemptCredentialDigest === undefined) {
        refusals.push({
          code: "credential-missing",
          path: "$.attemptCredentialDigest",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " targets node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", but the persisted state entry for that attempt carries no attempt-credential " +
            "digest — a body version before this one persisted the credential itself and is " +
            "never re-delivered by this build, so the effect stays unsettled",
        });
        continue;
      }
      const key = dispatchEffectKeyOf(this.graphId, target.attemptId);
      // THE HOST'S OWN ANSWER IS READ BEFORE THE CREDENTIAL IS, because §3.3
      // makes it the CONDITION of re-issuing one: only a host that proves no
      // execution exists may have a lost credential replaced.
      const lookup = this.lookupExecution(key);
      const resolvedCredential = this.resolveStoredCredential(
        target.nodeId,
        target.attemptId,
      );
      let credential: string;
      if (resolvedCredential.kind === "resolved") {
        credential = resolvedCredential.credential;
      } else {
        const reissuedCredential = this.reissueLostCredential({
          effect,
          target,
          lookup,
          at,
          reason: resolvedCredential.reason,
          // The verifier recovery OBSERVED for this attempt. The re-issue
          // replaces exactly this generation and refuses if the recorded one
          // has already moved, so it can never overwrite a newer verifier.
          observedDigest: armed.attemptCredentialDigest,
        });
        if ("refusal" in reissuedCredential) {
          refusals.push(reissuedCredential.refusal);
          continue;
        }
        credential = reissuedCredential.credential;
        reissued = true;
      }

      if (effect.status === "started") {
        // THE ROW SAYS A CREATE RETURNED. Nothing is re-created either way; a
        // host that contradicts the record turns into a report, not a launch.
        if (lookup.kind === "absent") {
          refusals.push({
            code: "dispatch-unreconciled",
            path: "$.effectId",
            message:
              "outcome-runtime: dispatch effect " +
              JSON.stringify(effect.effectId) +
              " is recorded as started, but the host reports no execution for it — the " +
              "stored fact and the host fact disagree, so the effect is left exactly as it " +
              "is and reported for reconciliation rather than started a second time",
          });
          // THE DIVERGENCE IS ITS OWN REPORT (D9). The refusal above says what was
          // NOT done; this record names the disagreement itself (local record
          // ahead of the host), so a caller reading only divergences still sees
          // the contradiction instead of inferring it from a refusal code.
          divergences.push(
            this.divergenceOf(effect.effectId, target.attemptId, "started", "absent"),
          );
          continue;
        }
        reconciled.push(this.reconciledEffectOf(effect.effectId, target.attemptId, "recorded-started"));
        continue;
      }

      if (lookup.kind === "unknown") {
        refusals.push({
          code: "dispatch-unreconciled",
          path: "$.effectId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " (attempt " +
            JSON.stringify(target.attemptId) +
            ") was committed but its execution cannot be established: " +
            // The reason is host text and this refusal is a REPORT, so it is
            // sanitized against the attempt's own credential like every other
            // dispatch-failure report.
            this.withoutCredentials(lookup.reason, [credential]) +
            " — it was NOT launched and is reported as unsettled work for the host to " +
            "reconcile; a blind retry could run the attempt twice, and reporting success " +
            "would hide an attempt that never started",
        });
        continue;
      }

      if (lookup.kind === "created") {
        const marked = this.markDispatchStarted(target.attemptId);
        if (marked !== undefined) {
          refusals.push(marked);
          continue;
        }
        reconciled.push(this.reconciledEffectOf(effect.effectId, target.attemptId, "host-reported-created"));
        // AND THE DISAGREEMENT THAT WAS RECONCILED IS REPORTED AS ONE (D9): the
        // local row said `pending` while the host already had the execution, so
        // the row is marked and NEVER re-created. Reporting it here — rather than
        // only as a positive reconciliation — is what makes "the host was ahead"
        // observable instead of inferred.
        divergences.push(
          this.divergenceOf(effect.effectId, target.attemptId, "pending", "created"),
        );
        continue;
      }

      // A STOPPED ATTEMPT IS NEVER (RE-)LAUNCHED (P3 item 1). An attempt-scoped
      // stop leaves the RUN executing on purpose, so this recovery is reached
      // for a stopped attempt's unsettled effect — and a substrate whose query
      // proves ABSENCE would otherwise CREATE the execution again: an execution
      // for an attempt every acceptance refuses, which no decision could ever
      // settle and which the platform would run for nothing. The same
      // classification that guards acceptance
      // (`STOPPING_CONTROL_COMMANDS`) guards the launch, the effect stays
      // unsettled and VISIBLE, and the attempt is carried forward only by a
      // node-scoped `retry` (which mints a successor attempt with its own
      // effect). The refusal is classified against the run fact as it stands
      // NOW, exactly like the acceptance path (`refusalForStoppingDecision`):
      // the resume that reached this sweep read the run fact earlier, so a
      // run-wide command that claimed the run since then must not be reported
      // as an attempt-scoped stop of a live run.
      const stopping = stoppingDecisionOf(this.ledger, this.graphId, target.attemptId);
      if (stopping !== undefined) {
        refusals.push(
          refusalForStoppingDecision(
            this.graphId,
            stopping,
            runControl(this.ledger, this.graphId),
          ),
        );
        continue;
      }

      // ABSENT: the host confirms no execution exists, so this is the
      // commit-then-crash window and the create is the FIRST attempt, not a
      // retry. The row is marked started only after the create returned.
      try {
        this.createExecution(
          this.dispatchRequestOf(
            target.nodeId,
            target.attemptId,
            target.agent,
            target.prompt,
            boundInputs,
            credential,
          ),
        );
      } catch (error) {
        refusals.push({
          code: "dispatch-failed",
          path: "$.effectId",
          message:
            "outcome-runtime: the host threw while creating effect " +
            JSON.stringify(effect.effectId) +
            " (" +
            this.withoutCredentials(errorText(error), [credential]) +
            ") — the effect stays unsettled and is NOT reported as started; the next " +
            "recovery asks the host again before anything is created",
        });
        continue;
      }
      const marked = this.markDispatchStarted(target.attemptId);
      if (marked !== undefined) {
        refusals.push(marked);
        continue;
      }
      launched.push(
        this.dispatchRequestOf(
          target.nodeId,
          target.attemptId,
          target.agent,
          target.prompt,
          boundInputs,
          credential,
        ),
      );
    }
    return {
      launched: Object.freeze(launched),
      reconciled: Object.freeze(reconciled),
      divergences: Object.freeze(divergences),
      refusals: Object.freeze(refusals),
      reissued,
    };
  }

  /**
   * One restart divergence: the local effect status and the contradicting host
   * fact, with what this recovery did about it — `reconciled-started` when the
   * host was ahead and the row was marked without a create, and
   * `reported-unreconciled` when the record was ahead and nothing was changed.
   */
  divergenceOf(
    effectId: string,
    attemptId: string,
    local: "pending" | "started",
    host: "created" | "absent",
  ): OutcomeEffectDivergence {
    return Object.freeze({
      effectId,
      attemptId,
      local,
      host,
      resolution:
        local === "pending" && host === "created"
          ? ("reconciled-started" as const)
          : ("reported-unreconciled" as const),
    });
  }

  /**
   * Ask the HOST'S STORE for the credential one attempt was issued.
   *
   * This is the only way a recovery can obtain a credential: the durable state
   * records its digest, so no amount of reading the ledger yields a value a
   * worker could present or a create could deliver. The store is the version-2
   * half of the credential-isolation capability; a process that holds only the
   * version-1 declaration (or no capability at all) has no store, and an effect
   * it cannot re-deliver is reported as unsettled rather than launched.
   *
   * TOTAL, AND NEVER QUOTING THE STORE. A store that throws, or answers
   * something that is not a credential, is reported as `unavailable` — never
   * converted into a launch and never replaced by a freshly minted value. The
   * reason is RUNTIME-AUTHORED text naming the failure category: this is the one
   * component that legitimately holds credentials, so neither a thrown message
   * nor an answered value is ever copied into a report (both are exactly where a
   * credential could surface).
   */
  resolveStoredCredential(
    nodeId: string,
    attemptId: string,
  ):
    | { readonly kind: "resolved"; readonly credential: string }
    | { readonly kind: "unavailable"; readonly reason: string } {
    const store = this.credentialStore;
    if (store === undefined) {
      return Object.freeze({
        kind: "unavailable" as const,
        reason:
          "this process holds no version-" +
          CREDENTIAL_ISOLATION_VERSION_V3 +
          " credential-isolation capability with a { remember, resolve } store",
      });
    }
    let resolved: unknown;
    try {
      resolved = store.resolve(
        Object.freeze({ graphId: this.graphId, nodeId, attemptId }),
      );
    } catch {
      return Object.freeze({
        kind: "unavailable" as const,
        reason:
          "the host store threw while resolving it (its message is not quoted: this is " +
          "the component that legitimately holds credentials)",
      });
    }
    if (!isAttemptCredential(resolved)) {
      return Object.freeze({
        kind: "unavailable" as const,
        reason:
          "the host store did not answer a non-empty credential (the value is not " +
          "quoted for the same reason)",
      });
    }
    return Object.freeze({ kind: "resolved" as const, credential: resolved });
  }

  /**
   * ONE SPELLING OF THE CREDENTIAL-REISSUE REFUSAL (plan §3.3): every branch of
   * the policy below refuses for a different reason, but each one names the SAME
   * three things — the effect, its node and its attempt — and the branch's own
   * sentence is all that differs.
   */
  private reissueForbidden(
    effect: PendingEffectRecord,
    target: OutcomeDispatchTarget,
    path: "$.status" | "$.effectId",
    detail: string,
  ): OutcomeRuntimeRefusal {
    return {
      code: "credential-reissue-forbidden",
      path,
      message:
        "outcome-runtime: dispatch effect " +
        JSON.stringify(effect.effectId) +
        " names node " +
        JSON.stringify(target.nodeId) +
        " on attempt " +
        JSON.stringify(target.attemptId) +
        detail,
    };
  }

  /**
   * THE RESTART AUTHORIZATION POLICY (plan §3.3, P2 item 8).
 */
  reissueLostCredential(input: {
    readonly effect: PendingEffectRecord;
    readonly target: OutcomeDispatchTarget;
    readonly lookup: OutcomeExecutionLookup;
    readonly at: number;
    readonly reason: string;
    /**
     * The verifier recovery observed for this attempt. The replacement is
     * conditional on the recorded one still being this value.
     */
    readonly observedDigest: string;
  }): { readonly credential: string } | { readonly refusal: OutcomeRuntimeRefusal } {
    const effect = input.effect;
    const target = input.target;
    if (effect.status !== "pending") {
      return {
        refusal: this.reissueForbidden(effect, target, "$.status", " and is recorded " +
          JSON.stringify(effect.status) +
          ", so a create RETURNED for it and an execution may exist — a lost credential is " +
          "never replaced for an effect that was handed to the platform (the reason the host " +
          "store could not produce it: " +
          input.reason +
          "); the effect stays unsettled and is reported"),
      };
    }
    if (input.lookup.kind !== "absent") {
      return {
        refusal: this.reissueForbidden(effect, target, "$.effectId", ", its credential is gone (" +
          input.reason +
          "), and re-issuing one is permitted ONLY after the host proves no execution " +
          "exists. The host answered " +
          input.lookup.kind +
          (input.lookup.kind === "unknown" ? " (" + input.lookup.reason + ")" : "") +
          " — so the attempt is NOT re-issued and NOT re-delivered: a blind retry could run " +
          "it twice, and the block is reported rather than resolved by guessing"),
      };
    }
    // THE RE-ISSUE TAKES THE CREATE RIGHT BEFORE IT MINTS ANYTHING (plan §3.3).
    // The claim is the SAME conditional right the host's create takes, so while
    // this process holds it, a second recoverer is told `held` (or, through the
    // registry lookup, `unknown`) and cannot replace the verifier this process
    // is about to deliver. A host that installs no fence gets no re-issue.
    const key = dispatchEffectKeyOf(this.graphId, target.attemptId);
    const fence = this.reissueFence;
    if (fence === undefined) {
      return {
        refusal: this.reissueForbidden(effect, target, "$.effectId", ", its credential is gone (" +
          input.reason +
          "), and re-issuing one needs the host's CREATE-RIGHT fence — this runtime holds " +
          "none, so the attempt is NOT re-issued and NOT re-delivered: without the fence a " +
          "second recoverer could replace the verifier of an attempt this process is about " +
          "to dispatch, and the effect stays unsettled and is reported"),
      };
    }
    let claim: Extract<AttemptReissueClaim, { kind: "claimed" }>;
    try {
      const reading = fence.claim(key);
      if (reading.kind === "held") {
        return {
          refusal: this.reissueForbidden(effect, target, "$.effectId", ", its credential is gone (" +
            input.reason +
            "), and the create right for it is held elsewhere (" +
            reading.reason +
            ") — the re-issue is refused rather than overwriting a verifier another " +
            "recoverer may already have committed, so the effect stays unsettled and is " +
            "reported"),
        };
      }
      claim = reading;
    } catch (error) {
      return {
        refusal: this.reissueForbidden(effect, target, "$.effectId", ", its credential is gone (" +
          input.reason +
          "), and the host's create-right fence could not be read (" +
          errorText(error) +
          ") — nothing was re-issued and the effect stays unsettled"),
      };
    }
    const replaced = this.replaceAttemptCredential(
      target.nodeId,
      target.attemptId,
      input.at,
      input.observedDigest,
    );
    if ("refusal" in replaced) {
      // The claim was taken and NOTHING was handed to the platform, so giving
      // it back is a proof-backed release: no execution was created.
      try {
        fence.abandon(
          key,
          claim.ownerId,
          "the credential re-issue refused before any create was attempted",
        );
      } catch {
        // The refusal is already the answer; the claim lapses with its lease.
      }
      return replaced;
    }
    return { credential: replaced.credential };
  }

  /**
   * Adopt ONE new credential generation for an attempt and replace the digest
   * the persisted state verifies against, in ONE transaction.
   *
   * The two writes are one commit by construction: {@link credentialSource}
   * ADOPTS the freshly minted value into the host's store (the version-3
   * capability's `remember`) and the state write that records its digest joins
   * the SAME `runInTransaction` boundary, so a failed write leaves neither.
   * That is what makes the previous generation invalid rather than merely
   * superseded: the old digest is not kept anywhere, so the old credential
   * matches no recorded verifier and is refused by name.
   *
   * REFUSES WHAT IT CANNOT REPLACE: a state this build cannot read, a node the
   * plan does not declare, an entry whose attempt is not the named one, a node
   * that is not in flight, and a body layout that is not this build's current
   * one are all structured refusals — recovery never rewrites a record it could
   * not read, and never advances an older body version.
   *
   * THE REPLACEMENT IS CONDITIONAL ON THE OBSERVED GENERATION. The transaction
   * re-reads the recorded verifier and writes only while it is still the one
   * recovery observed; a verifier that moved in between is a structured
   * `credential-reissue-forbidden` refusal and NO write happens. Together with
   * the create-right fence this is what makes two re-issues over one store a
   * single-winner operation: the loser reports instead of overwriting the
   * winner's verifier.
   */
  replaceAttemptCredential(
    nodeId: string,
    attemptId: string,
    at: number,
    observedDigest: string,
  ): { readonly credential: string } | { readonly refusal: OutcomeRuntimeRefusal } {
    try {
      return this.ledger.runInTransaction(
        (tx): { readonly credential: string } | { readonly refusal: OutcomeRuntimeRefusal } => {
          const record = tx.readGraphState(this.graphId);
          if (record === undefined) {
            throw new OutcomeAdvanceRefusedError(
              "state-ledger-disagreement",
              "outcome-runtime: the state of graph " +
              JSON.stringify(this.graphId) +
              " disappeared between recovery's read and the credential re-issue — nothing " +
              "was re-issued",
            );
          }
          const state = readOutcomeGraphState(record, this.plan);
          if (state.bodyVersion !== CURRENT_OUTCOME_STATE_BODY) {
            throw new OutcomeAdvanceRefusedError(
              "unsupported-state-version",
              "outcome-runtime: graph " +
              JSON.stringify(this.graphId) +
              " records state body version " +
              String(state.bodyVersion) +
              ", which this build does not rewrite — the credential of a recovered attempt is " +
              "never re-issued into an older layout",
            );
          }
          const position = this.plan.nodes.findIndex((node) => node.id === nodeId);
          const current = position < 0 ? undefined : state.nodes[position];
          if (current === undefined || current.attemptId !== attemptId) {
            throw new OutcomeAdvanceRefusedError(
              "attempt-mismatch",
              "outcome-runtime: the credential re-issue was asked for node " +
              JSON.stringify(nodeId) +
              " attempt " +
              JSON.stringify(attemptId) +
              ", but the state records " +
              (current === undefined || current.attemptId === undefined
                ? "no such attempt"
                : "attempt " + JSON.stringify(current.attemptId)) +
              " — nothing was re-issued",
            );
          }
          if (current.status !== "dispatched" || current.attemptCredentialDigest === undefined) {
            throw new OutcomeAdvanceRefusedError(
              "node-not-dispatched",
              "outcome-runtime: node " +
              JSON.stringify(nodeId) +
              " is " +
              current.status +
              " (or records no credential digest), so its attempt is not one whose lost " +
              "credential this build re-issues — nothing was written",
            );
          }
          // THE CONDITIONAL WRITE (R1). The verifier is replaced only while it
          // is still the generation recovery OBSERVED; a value that moved in
          // between is reported, never overwritten.
          if (current.attemptCredentialDigest !== observedDigest) {
            return {
              refusal: {
                code: "credential-reissue-forbidden",
                path: "$.attemptCredentialDigest",
                message:
                  "outcome-runtime: node " +
                  JSON.stringify(nodeId) +
                  " attempt " +
                  JSON.stringify(attemptId) +
                  " was observed with one recorded credential verifier, but the state now " +
                  "records a DIFFERENT one — another recoverer re-issued this attempt's " +
                  "credential first, and this re-issue is refused rather than overwriting a " +
                  "verifier that may already belong to a dispatched worker",
              },
            };
          }
          const minted = this.credentialSource(
            attemptCredentialBinding({
              graphId: this.graphId,
              nodeId,
              attemptId,
              planRevision: this.planRevision,
            }),
          );
          const nodes = state.nodes.map((entry, index) =>
            index === position
              ? Object.freeze({
                ...entry,
                attemptCredentialDigest: attemptCredentialDigest(minted),
              })
              : entry,
          );
          tx.writeGraphState(
            stateRecordOf(Object.freeze({ ...state, nodes: Object.freeze(nodes) }), at),
          );
          return { credential: minted };
        },
      );
    } catch (error) {
      if (error instanceof OutcomeAdvanceRefusedError) {
        return {
          refusal: {
            code: error.code as OutcomeRuntimeRefusal["code"],
            path: "$.attemptCredentialDigest",
            message: error.message,
          },
        };
      }
      if (error instanceof OutcomeStateError) {
        return { refusal: stateRefusal(this.graphId, error) };
      }
      return {
        refusal: {
          code: "credential-missing",
          path: "$.attemptCredentialDigest",
          message:
            "outcome-runtime: the credential re-issue for node " +
            JSON.stringify(nodeId) +
            " attempt " +
            JSON.stringify(attemptId) +
            " could not be committed (" +
            // The failing call may be the HOST STORE (the mint adopts the value
            // there), so its own text is not quoted: this is one of the two
            // components that legitimately handle a credential.
            "the transaction rolled back) — nothing was re-issued and the effect stays " +
            "unsettled",
        },
      };
    }
  }

  /**
   * Ask the host whether one effect's execution exists, with a failure to
   * answer treated as the honest `unknown` rather than as a decision.
   *
   * A host whose lookup throws has not said "absent"; reporting that as a
   * launch would turn an unanswered question into a second execution.
   */
  lookupExecution(
    effect: OutcomeDispatchEffectKey,
  ): OutcomeExecutionLookup {
    const host = this.dispatch;
    if (host === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason: "no dispatch adapter is installed",
      });
    }
    try {
      return host.lookup(effect);
    } catch (error) {
      return Object.freeze({
        kind: "unknown" as const,
        reason: "the host lookup failed (" + errorText(error) + ")",
      });
    }
  }

  /** One reconciliation record, frozen like every other reported value. */
  reconciledEffectOf(
    effectId: string,
    attemptId: string,
    reason: OutcomeReconciledReason,
  ): OutcomeReconciledEffect {
    return Object.freeze({ effectId, attemptId, reason });
  }

  /**
   * Every effect the ledger still holds UNSETTLED (`pending` or `started`), or
   * a refusal when the ledger cannot answer.
   *
   * This is the reporting half of recovery: a `started` row a dead process
   * left behind is surfaced here, exactly as a `pending` row that could not be
   * launched is. Neither is ever dropped, and neither is silently rewound.
   */
  unsettledEffectReading():
    | readonly PendingEffectRecord[]
    | OutcomeRuntimeRefusal {
    try {
      return this.ledger.pendingEffects(this.graphId);
    } catch (error) {
      return ledgerReadRefusal(this.graphId, error);
    }
  }

  /**
   * The dispatch request one reducer intent becomes: runtime provenance plus the
   * credential the reducer minted for this attempt.
   */
  requestOf(intent: OutcomeDispatchIntent): OutcomeDispatchRequest {
    return this.dispatchRequestOf(
      intent.nodeId,
      intent.attemptId,
      intent.agent,
      intent.prompt,
      intent.inputs,
      intent.credential,
    );
  }

  /** The credential-free payload one reducer intent is persisted as. */
  dispatchPayloadOf(
    intent: OutcomeDispatchIntent,
  ): OutcomeDispatchTarget {
    return this.dispatchTargetOf(
      intent.nodeId,
      intent.attemptId,
      intent.agent,
      intent.prompt,
      intent.inputs,
    );
  }

  /**
   * The credential-free target one dispatch is persisted as.
   *
   * ONE SPELLING for the first dispatch and a successor: the effect payload of
   * an entry attempt and of a reducer intent are built by the same function, so
   * a recovery reads either one exactly the same way.
   */
  dispatchTargetOf(
    nodeId: string,
    attemptId: string,
    agent: string,
    prompt: string,
    inputs: readonly ResolvedInput[],
  ): OutcomeDispatchTarget {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      // ALWAYS PRESENT on a dispatch this build creates (D6): the empty list is
      // the resolved view of "this node declares no inputs", so an absent field
      // says only that the row was written before the binding existed.
      inputs,
    });
  }

  /** Build one dispatch target/request from the plan and the minted attempt. */
  dispatchRequestOf(
    nodeId: string,
    attemptId: string,
    agent: string,
    prompt: string,
    inputs: readonly ResolvedInput[],
    credential: string,
  ): OutcomeDispatchRequest {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      inputs,
      credential,
    });
  }

  /** The compiled node with this id, or `undefined` when the plan has none. */
  compiledNodeOf(nodeId: string): CompiledNode | undefined {
    return this.plan.nodes.find((node) => node.id === nodeId);
  }
}

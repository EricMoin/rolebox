/**
 * Graph Execution Engine v2 — Outcome-protocol restart recovery (C3c)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The RESTART half of the outcome protocol (docs/graph-outcome-protocol.md
 * § "State, storage, and effects"): given the PERSISTED engine state the loader
 * has already validated, read the SAVED compiled plan and its binding, and
 * continue the graph through the outcome run path
 * (`src/graph/outcome/runtime.ts` `resume`).
 *
 * THE SAVED PLAN IS THE AUTHORITY — THE SAME ONE THE FIRST EXECUTION USED. This
 * module never recompiles a declaration, never rebuilds a plan from a
 * declaration carrier and never reads a plan out of the ledger in place of the
 * persisted one: the plan is `state.compiledPlan` (the record
 * `graph_declare` wrote), and its revision must still agree with
 * `state.planBinding`, which is the plan identity the graph was bound to.
 * A revision the binding no longer names is REFUSED by name — recovery never
 * accepts a state, and never starts from scratch, under a plan the binding does
 * not corroborate.
 *
 * RECOVERY ALSO NEEDS THE POLICY THE PLAN PINNED (D6). A persisted executable
 * plan whose body pins natural-completion authorizations is only resumable in a
 * process that still holds the exact policy revisions it authorized: the
 * runtime corroborates every pinned ref against the injected capability before
 * it reads state or launches anything, and a missing/different policy is a
 * structured refusal that writes NOTHING. Recovery is therefore the boundary
 * where a revoked policy blocks the run explicitly, with the persisted state
 * preserved for a process that does have the capability.
 *
 * WHO OPENS THE LEDGER. The caller (the startup sweep, or a test) owns the
 * `AcceptanceLedger` handle and its lifetime; this module only reads through
 * it. That keeps the substrate injectable and keeps this module a composition
 * seam rather than a second store owner.
 *
 * Dependency note: this module may import the engine's persisted-state TYPE and
 * the loader's record types, but it imports no legacy runtime, so a declared
 * graph can never be recovered through the legacy path from here. The legacy
 * recovery guard is untouched: `EngineRuntime.recover()` still refuses any
 * protocol but the legacy one.
 */

import type { EngineState } from "../../types.engine-v2.ts";
import type { CompiledPlan } from "../compiler/plan.ts";
import type { AcceptanceLedger } from "../ledger/types.ts";
import type { ExecutionProtocolRegistry } from "../protocol/execution-protocol.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchAdapter,
  type OutcomeResumeResult,
  type OutcomeRuntimeRefusal,
} from "./runtime.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import type { CredentialIsolationCapability } from "./credential-isolation.ts";
import type { HostIdentityCapability } from "./host-identity.ts";
import type { ValidatorRegistry } from "./validators.ts";

// ── The saved plan and its binding ──────────────────────────────────────────

/** The persisted plan a recovery continues, with the revision it is bound to. */
export interface PersistedOutcomePlan {
  readonly graphId: string;
  /** The SAVED compiled plan — the same record the first execution ran. */
  readonly plan: CompiledPlan;
  /** The plan's own content-addressed revision. */
  readonly planRevision: string;
  /** The revision the graph's plan binding names (must equal `planRevision`). */
  readonly bindingRevision: string;
}

/** What reading a persisted outcome state's plan produced. */
export type PersistedOutcomePlanReading =
  | { readonly kind: "ok"; readonly plan: PersistedOutcomePlan }
  | { readonly kind: "refused"; readonly refusals: readonly OutcomeRuntimeRefusal[] };

/**
 * Read the SAVED plan and its binding out of a persisted outcome-protocol
 * state.
 *
 * TOTAL: every missing or disagreeing identity is a structured refusal, never a
 * throw and never an inferred default. In particular:
 * - no compiled plan → `missing-persisted-plan`: recovery has nothing to run
 *   and must not recompile anything;
 * - no plan binding → `unreadable-state`: a protocol-2 record is always
 *   written with its binding, so its absence means the record is not this
 *   build's;
 * - plan and binding naming different revisions → `plan-revision-mismatch`,
 *   naming both: the graph is never resumed under a plan its binding does not
 *   corroborate.
 *
 * The loader already verifies the two records against each other when it
 * hydrates (`verifyPersistedPlan`), so these checks are the recovery
 * boundary's OWN copy of the rule — a caller that hands this function a state
 * from anywhere else gets the same guarantee.
 */
export function readPersistedOutcomePlan(
  state: EngineState,
): PersistedOutcomePlanReading {
  const graphId = state.graphId;
  const compiled = state.compiledPlan;
  if (compiled === undefined) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "missing-persisted-plan",
          path: "$.compiledPlan",
          message:
            "outcome-recovery: graph " +
            JSON.stringify(graphId) +
            " is bound to the outcome protocol but its persisted record carries no compiled " +
            "plan — recovery continues the SAVED plan and never recompiles a declaration, so " +
            "there is nothing to resume from",
        },
      ],
    };
  }
  const binding = state.planBinding;
  if (binding === undefined) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "unreadable-state",
          path: "$.planBinding",
          message:
            "outcome-recovery: graph " +
            JSON.stringify(graphId) +
            " carries a persisted compiled plan but no plan binding — a declared graph is " +
            "always written with both, so this record is not the one this build writes and " +
            "recovery refuses to resume it",
        },
      ],
    };
  }
  if (compiled.graphId !== graphId) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "graph-mismatch",
          path: "$.compiledPlan.graphId",
          message:
            "outcome-recovery: the persisted compiled plan belongs to graph " +
            JSON.stringify(compiled.graphId) +
            ", but the state belongs to " +
            JSON.stringify(graphId) +
            " — refusing to resume a plan that does not describe this graph",
        },
      ],
    };
  }
  if (compiled.planRevision !== binding.planRevision) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "plan-revision-mismatch",
          path: "$.planBinding.planRevision",
          message:
            "outcome-recovery: graph " +
            JSON.stringify(graphId) +
            " carries a compiled plan at revision " +
            JSON.stringify(compiled.planRevision) +
            ", but its plan binding names revision " +
            JSON.stringify(binding.planRevision) +
            " — the binding no longer corroborates the plan, so nothing is resumed under " +
            "either revision",
        },
      ],
    };
  }
  return {
    kind: "ok",
    plan: Object.freeze({
      graphId,
      plan: compiled,
      planRevision: compiled.planRevision,
      bindingRevision: binding.planRevision,
    }),
  };
}

// ── The resume composition ──────────────────────────────────────────────────

/** Inputs to {@link resumePersistedOutcomeGraph}. */
export interface ResumePersistedOutcomeGraphOptions {
  /** The persisted engine state, already validated by the loader. */
  readonly state: EngineState;
  /** The durable ledger the graph's state and acceptance live in. */
  readonly ledger: AcceptanceLedger;
  /**
   * The HOST dispatch adapter (D8) recovery executes through: the create
   * channel plus the execution query that resolves a crash window. A bare seam
   * is the degenerate adapter — it can create but cannot be queried, so an
   * effect whose creation is unknown is reported rather than re-created.
   */
  readonly dispatch: OutcomeDispatchAdapter;
  /** The installed validator implementations the plan's gates resolve against. */
  readonly validators: ValidatorRegistry;
  /**
   * The HOST-INSTALLED completion-policy capability (D6). A persisted plan
   * that pins a natural-completion authorization is corroborated against it
   * before anything is resumed; WITHOUT it, such a plan is refused
   * (`completion-policy-unavailable`) and its state is left exactly as it is.
   * A plan that pins none does not need it.
   */
  readonly completionPolicies?: CompletionPolicyRegistry;
  /**
   * The HOST's credential-isolation capability (D7). The outcome run path this
   * seam continues refuses to start, resume or settle anything without it
   * (`credential-isolation-unavailable`): the durable state records only a
   * DIGEST, so the credential itself has to live in the host's store and be
   * re-delivered from it — which makes the capability the production enablement
   * condition and recovery one of its entry points. Recovery just forwards it;
   * the rule lives in `credential-isolation.ts`.
   */
  readonly credentialIsolation?: CredentialIsolationCapability;
  /**
   * The HOST's invocation-identity capability (D9). Recovery forwards it to the
   * outcome run path unchanged: a recovered attempt keeps the dispatch identity
   * its own state entry recorded, recovery NEVER re-binds it to the invocation
   * that happens to be recovering, and a FIRST execution performed here records
   * whatever identity the host reports for this sweep. A capability that is
   * present but unreadable is refused by the runtime (`host-identity-unavailable`)
   * with the state preserved. Absent → the identity binding is not enabled and
   * the path behaves exactly as it did before this rule.
   */
  readonly hostIdentity?: HostIdentityCapability;
  /** The root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The clock input, in epoch milliseconds; omitted → `Date.now()`. */
  readonly now?: number;
  /** The installed execution-protocol handlers; defaults to the shipped set. */
  readonly protocols?: ExecutionProtocolRegistry;
}

/**
 * Continue one persisted outcome-protocol graph through the outcome run path.
 *
 * The plan comes from the persisted record (never from a caller), the state
 * comes from the ledger inside {@link OutcomeGraphRuntime.resume}, and the
 * result distinguishes a FIRST EXECUTION (`started`: the graph had no state)
 * from a RESTART RECOVERY (`resumed`: it had one) without ever letting the two
 * paths read different plans. A graph with a state is never started from
 * scratch and a state bound to another revision is never accepted.
 */
export function resumePersistedOutcomeGraph(
  options: ResumePersistedOutcomeGraphOptions,
): OutcomeResumeResult {
  const reading = readPersistedOutcomePlan(options.state);
  if (reading.kind === "refused") {
    return { kind: "refused", refusals: reading.refusals };
  }
  const runtime = new OutcomeGraphRuntime({
    plan: reading.plan.plan,
    ledger: options.ledger,
    dispatch: options.dispatch,
    validators: options.validators,
    artifactRoot: options.artifactRoot,
    ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
    ...(options.completionPolicies === undefined
      ? {}
      : { completionPolicies: options.completionPolicies }),
    ...(options.credentialIsolation === undefined
      ? {}
      : { credentialIsolation: options.credentialIsolation }),
    ...(options.hostIdentity === undefined
      ? {}
      : { hostIdentity: options.hostIdentity }),
  });
  return runtime.resume(options.now);
}

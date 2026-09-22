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
  type OutcomeDispatchSeam,
  type OutcomeResumeResult,
  type OutcomeRuntimeRefusal,
} from "./runtime.ts";
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
  /** Where a launched dispatch goes. Called only from `resume`. */
  readonly dispatch: OutcomeDispatchSeam;
  /** The installed validator implementations the plan's gates resolve against. */
  readonly validators: ValidatorRegistry;
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
  });
  return runtime.resume(options.now);
}

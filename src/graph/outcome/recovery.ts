import type { StoredDeclaredGraph } from "../persistence/declared-record.ts";
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
export interface PersistedOutcomePlan {
  readonly graphId: string;
  readonly plan: CompiledPlan;
  readonly planRevision: string;
  readonly bindingRevision: string;
}
export type PersistedOutcomePlanReading =
  | { readonly kind: "ok"; readonly plan: PersistedOutcomePlan }
  | { readonly kind: "refused"; readonly refusals: readonly OutcomeRuntimeRefusal[] };
export function readPersistedOutcomePlan(
  state: Pick<StoredDeclaredGraph, "graphId" | "record" | "binding">,
): PersistedOutcomePlanReading {
  const graphId = state.graphId;
  const compiled = state.record;
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
  const binding = state.binding;
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
export interface ResumePersistedOutcomeGraphOptions {
  readonly state: Pick<StoredDeclaredGraph, "graphId" | "record" | "binding">;
  readonly ledger: AcceptanceLedger;
  readonly dispatch: OutcomeDispatchAdapter;
  readonly validators: ValidatorRegistry;
  readonly completionPolicies?: CompletionPolicyRegistry;
  readonly credentialIsolation?: CredentialIsolationCapability;
  readonly hostIdentity?: HostIdentityCapability;
  readonly artifactRoot: string;
  readonly now?: number;
  readonly protocols?: ExecutionProtocolRegistry;
}
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

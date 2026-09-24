import type { CompiledPlan } from "../compiler/plan.ts";
import { verifyCompletionPolicy, type CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import {
  DEFAULT_EXECUTION_PROTOCOL_REGISTRY, OUTCOME_PROTOCOL,
  classifyExecutionProtocol, isOutcomeProtocolHandler, type ExecutionProtocolRegistry,
} from "../protocol/execution-protocol.ts";
import type { OutcomeRuntimeRefusal } from "./runtime-contract.ts";
import { describeValue } from "./runtime-refusals.ts";

export function completionCapabilityRefusal(
  plan: CompiledPlan,
  registry: CompletionPolicyRegistry | undefined,
): OutcomeRuntimeRefusal | undefined {
  const authorizations = plan.completionAuthorizations ?? [];
  if (authorizations.length === 0) return undefined;
  if (registry === undefined) {
    return {
      code: "completion-policy-unavailable",
      path: "$.completionAuthorizations",
      message:
        "outcome-runtime: plan revision " +
        plan.planRevision +
        " pins " +
        authorizations.length +
        " natural-completion authorization(s) (" +
        describeAuthorizations(authorizations) +
        "), but this runtime was given no completion-policy capability — the " +
        "authorization a plan was compiled with is part of its semantics, so nothing " +
        "was started, resumed or settled",
    };
  }
  for (const authorization of authorizations) {
    const verified = verifyCompletionPolicy(authorization.policy, registry);
    switch (verified.kind) {
      case "resolved":
        continue;
      case "unknown-policy":
        return {
          code: "completion-policy-unknown",
          path: "$.completionAuthorizations",
          message:
            "outcome-runtime: node " +
            JSON.stringify(authorization.nodeId) +
            " pins completion policy " +
            describePolicyRef(authorization.policy) +
            ", whose id is not installed in this process — the pinned revision is a " +
            "missing capability, never a hint to run under another policy",
        };
      case "unknown-revision":
        return {
          code: "completion-policy-unknown-revision",
          path: "$.completionAuthorizations",
          message:
            "outcome-runtime: node " +
            JSON.stringify(authorization.nodeId) +
            " pins completion policy " +
            describePolicyRef(authorization.policy) +
            ", whose exact revision is not installed in this process",
        };
      case "digest-mismatch":
        return {
          code: "completion-policy-digest-mismatch",
          path: "$.completionAuthorizations",
          message:
            "outcome-runtime: node " +
            JSON.stringify(authorization.nodeId) +
            " pins completion policy " +
            describePolicyRef(authorization.policy) +
            " at digest " +
            authorization.policy.digest +
            ", but the installed declaration hashes to " +
            verified.actual +
            " — the plan's pinned content is the authority and it is never re-bound " +
            "to a republished revision",
        };
    }
  }
  return undefined;
}

export function protocolCapabilityRefusal(
  protocols: ExecutionProtocolRegistry | undefined,
): OutcomeRuntimeRefusal | undefined {
  const verdict = classifyExecutionProtocol(
    OUTCOME_PROTOCOL,
    protocols ?? DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
  );
  if (verdict.kind === "invalid") {
    return {
      code: "protocol-unavailable",
      message:
        "outcome-runtime: protocol " +
        OUTCOME_PROTOCOL +
        " is not a legal execution-protocol identifier (" +
        describeValue(verdict.value) +
        ")",
    };
  }
  if (verdict.kind === "unsupported") {
    return {
      code: "protocol-unavailable",
      message:
        "outcome-runtime: no execution-protocol handler is registered for protocol " +
        OUTCOME_PROTOCOL +
        " — a declared graph is never run under legacy rules",
    };
  }
  if (!isOutcomeProtocolHandler(verdict.handler)) {
    return {
      code: "protocol-unavailable",
      message:
        "outcome-runtime: the handler registered for protocol " +
        OUTCOME_PROTOCOL +
        " is not an outcome-protocol handler — its capability surface is not the accepted " +
        "outcome submission, so this runtime refuses to run the graph",
    };
  }
  if (
    verdict.handler.completion !== "accepted-outcome-submission" ||
    verdict.handler.legacyCompletion !== "unreachable"
  ) {
    return {
      code: "protocol-unavailable",
      message:
        "outcome-runtime: the handler registered for protocol " +
        OUTCOME_PROTOCOL +
        " does not declare the accepted-outcome submission as its ONLY completion source " +
        "with legacy completion unreachable — refusing to run",
    };
  }
  return undefined;
}

/** A pinned completion-policy ref as a diagnostic token: `"id"@"revision"`. */
function describePolicyRef(ref: {
  readonly id: string;
  readonly revision: string;
}): string {
  return JSON.stringify(ref.id) + "@" + JSON.stringify(ref.revision);
}

/** The pinned authorizations of a plan, for a diagnostic that must not throw. */
function describeAuthorizations(
  authorizations: readonly {
    readonly nodeId: string;
    readonly outcome: string;
    readonly policy: { readonly id: string; readonly revision: string };
  }[],
): string {
  return authorizations
    .map(
      (entry) =>
        entry.nodeId +
        "->" +
        entry.outcome +
        " by " +
        describePolicyRef(entry.policy),
    )
    .join(", ");
}

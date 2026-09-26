import type { CompiledPlan } from "../compiler/plan.ts";
import { attemptCredentialDigest } from "./attempt-credential.ts";
import type { OutcomeGraphState, OutcomeNodeState } from "./graph-state.ts";
import { hostIdentityCheckRefusal, type HostIdentityReading } from "./host-identity.ts";
import { readOutcomeProposal } from "./proposal.ts";
import type {
  HostCompletionExecution,
  OutcomeRuntimeRefusal,
} from "./runtime-contract.ts";
import {
  stateNodeOf,
  submissionIdOf,
  type SettlementSource,
} from "./runtime-readings.ts";
import type { ExecutionIdentity } from "./validators.ts";

/**
 * Derive the trusted execution identity of one submission.
 *
 * THE ORDER IS THE RULE: the credential is resolved against the persisted
 * state FIRST, and only the attempt it names is then handed to the acceptance
 * core. The node's CURRENT attempt is never consulted as a fallback — a
 * credential that names nothing, or names another node's attempt, is refused
 * outright, so a late submission cannot be re-bound to a newer attempt and a
 * crafted credential cannot select one. A well-formed proposal whose
 * credential resolves is bound to that recorded attempt (dispatched or
 * settled — a settled one is the replay path); a malformed one carries a
 * placeholder identity so the acceptance core — the owner of the proposal
 * shape gate — refuses it with its own diagnostics.
 *
 * AND THEN THE HOST IDENTITY IS CHECKED (D9), against the attempt's OWN
 * recorded dispatch identity: a submission from another host invocation is
 * refused by name before any gate runs and before anything is written.
 *
 * THE SOURCE LABELS THE SUBMISSION KEY, AND ONLY THE KEY. `source` decides
 * whether the content address is `submission:<digest>` or the
 * `natural-completion:` namespace; it never widens or narrows what the
 * credential may settle. `expectedAttemptId` is the natural channel's
 * cross-check: the delivery's own attempt NAME must agree with the attempt the
 * credential resolves to, so a credential can never be re-aimed at another
 * attempt by relabelling the delivery.
 */
export function resolveSettlementIdentity(
  context: {
    readonly graphId: string;
    readonly plan: CompiledPlan;
    readonly planRevision: string;
  },
  proposal: unknown,
  state: OutcomeGraphState,
  hostIdentity: HostIdentityReading,
  source: SettlementSource,
  expectedAttemptId?: string,
  hostCompletion?: HostCompletionExecution,
): ExecutionIdentity | { readonly refusal: OutcomeRuntimeRefusal } {
  const reading = readOutcomeProposal(proposal);
  if (reading.kind === "malformed") {
    return {
      graphId: context.graphId,
      attemptId: "unclaimed-attempt",
      submissionId: "unclaimed-submission",
    };
  }
  const index = context.plan.nodes.findIndex(
    (node) => node.id === reading.proposal.nodeId,
  );
  if (index < 0) {
    return {
      refusal: {
        code: "unknown-node",
        path: "$.nodeId",
        message:
          "outcome-runtime: node " +
          JSON.stringify(reading.proposal.nodeId) +
          " is not declared by plan revision " +
          context.planRevision +
          " — an outcome can only be claimed on a node the compiled plan declares",
      },
    };
  }
  // ── THE HOST-COMPLETION CHANNEL (P2 items 6/7) ─────────────────────────
  //
  // A host-authenticated completion resolves its attempt from the HOST'S OWN
  // durable execution record — already corroborated by the caller — and from
  // the attempt the PERSISTED STATE records for the named node. It never
  // reads, requires or fabricates a bearer credential: a restart that lost
  // the value must still be able to settle the execution the host created
  // (plan §3.3, "a trusted host completion must not depend on re-obtaining
  // the worker's bearer").
  if (hostCompletion !== undefined) {
    if (reading.proposal.credential !== undefined) {
      return {
        refusal: {
          code: "malformed-natural-delivery",
          path: "$.credential",
          message:
            "outcome-runtime: a host-completion delivery for node " +
            JSON.stringify(reading.proposal.nodeId) +
            " carries an attempt credential — this channel is authenticated by the host's " +
            "own durable execution record and never reads a bearer value, so the delivery is " +
            "refused instead of settling under whichever proof it happened to present",
        },
      };
    }
    if (expectedAttemptId === undefined) {
      return {
        refusal: {
          code: "attempt-mismatch",
          path: "$.attemptId",
          message:
            "outcome-runtime: a host completion for node " +
            JSON.stringify(reading.proposal.nodeId) +
            " names no attempt, so there is no execution the host's fact could belong to",
        },
      };
    }
    const recorded = stateNodeOf(state, reading.proposal.nodeId);
    if (recorded === undefined || recorded.attemptId !== expectedAttemptId) {
      return {
        refusal: {
          code: "attempt-mismatch",
          path: "$.attemptId",
          message:
            "outcome-runtime: the host reports attempt " +
            JSON.stringify(expectedAttemptId) +
            " of node " +
            JSON.stringify(reading.proposal.nodeId) +
            " finished, but the persisted state records " +
            (recorded === undefined || recorded.attemptId === undefined
              ? "no attempt for that node"
              : "attempt " + JSON.stringify(recorded.attemptId)) +
            " — a completion fact is never re-bound to the node's current attempt",
        },
      };
    }
    if (recorded.status === "pending") {
      return {
        refusal: {
          code: "node-not-dispatched",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " records attempt " +
            JSON.stringify(expectedAttemptId) +
            " while still pending, so no execution of it was ever dispatched for a host " +
            "completion to describe — nothing was settled",
        },
      };
    }
    // The host identity constraint applies to this channel too (D9): the
    // reference is the identity the DISPATCH recorded on the attempt, never
    // the invocation that happens to be observing the completion.
    const hostIdentityCheck = hostIdentityCheckRefusal(
      recorded.dispatchIdentity,
      hostIdentity,
    );
    if (hostIdentityCheck !== undefined) return { refusal: hostIdentityCheck };
    return {
      graphId: context.graphId,
      attemptId: expectedAttemptId,
      submissionId: submissionIdOf(proposal, source),
    };
  }

  const credential = reading.proposal.credential;
  if (credential === undefined) {
    return {
      refusal: {
        code: "credential-missing",
        path: "$.credential",
        message:
          "outcome-runtime: node " +
          JSON.stringify(reading.proposal.nodeId) +
          " was submitted without the attempt credential it was dispatched with — an outcome " +
          "is settled BY the attempt that holds the credential, and this runtime never " +
          "derives one from the node id; nothing was written",
      },
    };
  }
  // Resolve the attempt the credential was ISSUED for. The scan is over the
  // persisted binding — the DIGEST written on one attempt's entry — so the
  // comparison is "does this presented credential hash to a recorded
  // verifier", never "does it equal a stored copy of itself". It is never an
  // index into the node the proposal happens to name.
  const presented = attemptCredentialDigest(credential);
  let holder: OutcomeNodeState | undefined;
  for (const node of state.nodes) {
    if (node.attemptCredentialDigest === presented) {
      holder = node;
      break;
    }
  }
  if (holder === undefined) {
    return {
      refusal: {
        code: "credential-unknown",
        path: "$.credential",
        message:
          "outcome-runtime: the credential on this submission is not recorded by any attempt " +
          "of graph " +
          JSON.stringify(context.graphId) +
          " — no attempt's persisted DIGEST matches it, so it was never issued here, or " +
          "the attempt it was issued for has since been superseded (a body version that " +
          "persists the credential itself, or none at all, is never compared against a " +
          "presented value); the node's CURRENT attempt is never substituted for it, so " +
          "nothing was written",
      },
    };
  }
  if (holder.nodeId !== reading.proposal.nodeId) {
    return {
      refusal: {
        code: "credential-node-mismatch",
        path: "$.credential",
        message:
          "outcome-runtime: the credential was issued for node " +
          JSON.stringify(holder.nodeId) +
          ", but this submission claims node " +
          JSON.stringify(reading.proposal.nodeId) +
          " — a credential is bound to one node, and it is never re-aimed at another",
      },
    };
  }
  const attemptId = holder.attemptId;
  if (attemptId === undefined) {
    return {
      refusal: {
        code: "unreadable-state",
        path: "$.nodes[" + index + "].attemptId",
        message:
          "outcome-runtime: node " +
          JSON.stringify(reading.proposal.nodeId) +
          " records a credential on a " +
          holder.status +
          " entry but carries no attempt id — the binding cannot be resolved",
      },
    };
  }
  // THE DELIVERY'S ATTEMPT NAME MUST AGREE WITH THE CREDENTIAL'S ATTEMPT
  // (the natural-completion cross-check): the delivery says WHICH attempt
  // completed, and that name is checked against the attempt the credential
  // resolved to — never used to choose one. A credential issued for another
  // attempt of the SAME node is caught here rather than settling the attempt
  // the credential really belongs to.
  if (expectedAttemptId !== undefined && attemptId !== expectedAttemptId) {
    return {
      refusal: {
        code: "attempt-mismatch",
        path: "$.attemptId",
        message:
          "outcome-runtime: the delivery names attempt " +
          JSON.stringify(expectedAttemptId) +
          " of node " +
          JSON.stringify(reading.proposal.nodeId) +
          ", but its credential was issued for attempt " +
          JSON.stringify(attemptId) +
          " — a credential is bound to one attempt, and the delivery's name never selects it",
      },
    };
  }
  // THE HOST IDENTITY IS THE ADDITIONAL CONSTRAINT (D9), checked AFTER the
  // credential resolved the attempt and BEFORE any decision is taken. The
  // reference is the identity the DISPATCH recorded on this attempt's entry —
  // never the current invocation and never the node's current attempt — so an
  // attempt dispatched under no identity is unconstrained (the compatibility
  // rule) while an attempt that recorded one is settled only by a submission
  // the host attributes to the same invocation.
  const identityCheck = hostIdentityCheckRefusal(
    holder.dispatchIdentity,
    hostIdentity,
  );
  if (identityCheck !== undefined) return { refusal: identityCheck };
  return {
    graphId: context.graphId,
    attemptId,
    submissionId: submissionIdOf(proposal, source),
  };
}

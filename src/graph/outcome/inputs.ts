/**
 * Graph outcome — assembling a node's downstream input (§3.5, P4 item 5 / A17)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * A node declares WHICH accepted results it consumes; the compiler pins those
 * references (`CompiledInputRef`, refused unless they name a declared outcome of
 * an upstream node). This module is the other half: given those fixed references
 * and the facts the run actually holds, it decides what the node receives — or
 * REFUSES to dispatch it.
 *
 * PURE BY CONSTRUCTION. It reads no clock, no file and no store: the caller
 * supplies the settled attempt per node and a lookup that answers what that
 * attempt accepted. That keeps the RULES here (which every caller must apply
 * identically) separate from the I/O that fetches the facts.
 *
 * THE RULES, and why each is a refusal rather than a fallback:
 *
 * - every declared input must name a node that SETTLED — an unaccepted
 *   dependency is not an absent value, it is a dispatch that would run against
 *   something nobody produced;
 * - the accepted OUTCOME must be the one the reference pinned. A producer that
 *   settled on a different declared outcome did not produce this consumer's
 *   input, and the plan's own routing already accounts for that branch;
 * - the accepted result must have RETAINED the artifact the consumer needs. The
 *   mutable path a reference once named is never read here: by dispatch time it
 *   may hold a different revision, and delivering that is the whole defect this
 *   chain exists to make impossible.
 *
 * A blocked input is a BLOCKED DISPATCH, reported by name — never a node started
 * with a hole where its input should be.
 *
 * Dependency leaf: the compiler's reference type and nothing else.
 */

import type { CompiledInputRef } from "../compiler/plan.ts";
import type { ArtifactObjectRead } from "../store/artifacts.ts";
import type { AcceptedArtifact } from "../domain/model.ts";

/** What one settled attempt accepted, as the caller can observe it. */
export interface AcceptedResultFacts {
  /** The outcome the attempt SETTLED on — the plan's routing identity. */
  readonly outcomeId: string;
  /** The artifact revisions the acceptance retained. */
  readonly artifacts: readonly AcceptedArtifact[];
}

/**
 * One declared input, resolved to the exact revision the acceptance recorded.
 *
 * `attemptId` is the identity every later read is bound to, so a consumer never
 * has to re-derive which attempt produced what it received.
 */
export interface ResolvedInput {
  readonly from: string;
  readonly outcome: string;
  readonly attemptId: string;
  readonly artifacts: readonly AcceptedArtifact[];
}

/** Why one declared input could not be resolved. */
export interface DownstreamInputRefusal {
  readonly from: string;
  readonly outcome: string;
  readonly code:
    | "input-producer-unsettled"
    | "input-outcome-mismatch"
    | "input-artifact-missing";
  readonly message: string;
}

/** What a node's declared inputs assembled to. */
export type DownstreamInput =
  | { readonly kind: "resolved"; readonly entries: readonly ResolvedInput[] }
  | { readonly kind: "blocked"; readonly refusals: readonly DownstreamInputRefusal[] };

/**
 * Assemble one node's declared inputs, or refuse the dispatch.
 *
 * TOTAL: every way a declared input can fail is a named refusal, and ANY refusal
 * blocks — a node with three inputs and one missing one has no input at all.
 */
export function assembleDownstreamInput(
  inputs: readonly CompiledInputRef[],
  settledAttemptOf: (nodeId: string) => string | undefined,
  acceptedOf: (attemptId: string) => AcceptedResultFacts | undefined,
): DownstreamInput {
  if (inputs.length === 0) {
    return { kind: "resolved", entries: Object.freeze([]) };
  }
  const entries: ResolvedInput[] = [];
  const refusals: DownstreamInputRefusal[] = [];
  for (const input of inputs) {
    const attemptId = settledAttemptOf(input.from);
    if (attemptId === undefined) {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-producer-unsettled" as const,
          message:
            "this node consumes the accepted result of " +
            JSON.stringify(input.from) +
            "/" +
            JSON.stringify(input.outcome) +
            ", but that node has no settled attempt — an unaccepted dependency is not an absent value, it is a dispatch that would run against something nobody produced",
        }),
      );
      continue;
    }
    const accepted = acceptedOf(attemptId);
    if (accepted === undefined) {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-producer-unsettled" as const,
          message:
            "attempt " +
            JSON.stringify(attemptId) +
            " of node " +
            JSON.stringify(input.from) +
            " has no accepted result, so it produced nothing this node may consume",
        }),
      );
      continue;
    }
    if (accepted.outcomeId !== input.outcome) {
      refusals.push(
        Object.freeze({
          from: input.from,
          outcome: input.outcome,
          code: "input-outcome-mismatch" as const,
          message:
            "node " +
            JSON.stringify(input.from) +
            " settled on outcome " +
            JSON.stringify(accepted.outcomeId) +
            ", not " +
            JSON.stringify(input.outcome) +
            " — a producer that settled on another declared outcome did not produce this consumer's input",
        }),
      );
      continue;
    }
    entries.push(
      Object.freeze({
        from: input.from,
        outcome: input.outcome,
        attemptId,
        artifacts: accepted.artifacts,
      }),
    );
  }
  if (refusals.length > 0) return { kind: "blocked", refusals: Object.freeze(refusals) };
  return { kind: "resolved", entries: Object.freeze(entries) };
}

/**
 * Read one resolved input's retained artifact BYTES.
 *
 * Kept beside the assembly so a consumer has exactly one way to reach the bytes:
 * the identity the acceptance recorded, never the reference's path. A missing or
 * tampered object is the store's own named problem, returned unchanged.
 */
export function readResolvedArtifact(
  entries: readonly ResolvedInput[],
  ref: string,
  readById: (artifactId: string) => ArtifactObjectRead,
): ArtifactObjectRead {
  for (const entry of entries) {
    const retained = entry.artifacts.find((artifact) => artifact.ref === ref);
    if (retained !== undefined) return readById(retained.artifactId);
  }
  return {
    kind: "problem",
    reason:
      "no resolved input retained an artifact for reference " +
      JSON.stringify(ref) +
      " — a reference the acceptance did not retain is REFUSED, never resolved from the path",
  };
}

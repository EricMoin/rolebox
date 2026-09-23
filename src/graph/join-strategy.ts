/**
 * Graph Execution Engine v2 — Join strategy resolution (shared leaf)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The ONE resolver of a declared {@link JoinConfig} into the runtime
 * {@link ResolvedJoinStrategy} shape, and the ONE reader of a resolved quorum
 * count. It is a DEPENDENCY LEAF — it imports the constants vocabulary and
 * types only — because the two runtimes that once resolved the same declaration
 * vocabulary have collapsed into ONE: the legacy signal engine
 * (`src/graph/engine/join-evaluator.ts`) was deleted with its runtime, and the
 * outcome-protocol reducer (`src/graph/outcome/graph-state.ts`) is the only
 * reader left — deliberately free of file persistence.
 *
 * Keeping the resolution here means there is a single reading of one `join`
 * declaration — the deleted legacy evaluator's own doc comment called this
 * resolver "THE single source of truth for the join-strategy shape", and it
 * still is: only its location moved.
 */

import { JoinStrategy } from "../constants.ts";
import type { JoinConfig } from "../types.graph-v2.ts";
import type { ResolvedJoinStrategy } from "../types.engine-v2.ts";

// The runtime join-strategy type lives beside the field it types in
// types.engine-v2.ts (C1). It is re-exported here so every importer of this
// leaf keeps resolving `ResolvedJoinStrategy` from the module it thinks owns
// the strategy vocabulary.
export type { ResolvedJoinStrategy };

// ── Join strategy resolution ────────────────────────────────────────────────

/**
 * Pure resolver that projects a node's declared {@link JoinConfig} into the
 * runtime join-strategy shape. Absent `join` (or `strategy: all`) resolves to
 * "all".
 *
 * `any` resolves to the `JoinStrategy.Any` string value; `quorum:N` resolves to
 * `{ quorum: N }` (the required count lives on the {@link JoinConfig}, not the
 * strategy string). The default quorum is `1`.
 *
 * This is THE single source of truth for the join-strategy shape: it is used
 * both to populate the runtime field in `registerNode` and, via
 * `getJoinStrategy`, to drive `evaluateJoin` / `joinSatisfied` — so evaluation
 * and the runtime field can never diverge. The outcome-protocol reducer calls
 * this same function for the same reason.
 */
export function resolveJoinStrategy(join?: JoinConfig): ResolvedJoinStrategy {
  if (!join || join.strategy === JoinStrategy.All) {
    return JoinStrategy.All;
  }
  // `any` resolves to the strategy string value; evaluation decides when the
  // single-answer threshold is met.
  if (join.strategy === JoinStrategy.Any) {
    return JoinStrategy.Any;
  }
  // quorum:N — the quorum count lives on the JoinConfig, not the strategy string.
  // The declared discriminated union (C1) guarantees the count is present on
  // this branch; the widening below covers inputs the compiler cannot see
  // (hand-written JS callers, pre-normalization persisted state), where a
  // missing count still degrades to the documented default of 1. The
  // DECLARATION side may not lean on that default: validator-v2 rule 9
  // rejects `{ strategy: "quorum" }` without a count and parser-v2 refuses to
  // build one.
  //
  // Defensive clamp: a non-positive quorum would make `evaluateJoin` treat the
  // join as satisfied with ZERO upstream answers (a DAG-order violation).
  // Clamp to 1 so a broken input degrades to "any"-like semantics instead of
  // an early dispatch.
  const declaredQuorum: number | undefined = join.quorum;
  const quorum = declaredQuorum ?? 1;
  return { quorum: quorum >= 1 ? quorum : 1 };
}

/**
 * The required answer count of a resolved join strategy, or `undefined` for
 * the strategies that carry no count (`"all"` / `"any"`).
 *
 * Single reader for the quorum branch (C1): `evaluateJoin` and the approval
 * cancellation gate (`approval-handler.ts` `shouldCancel`) both read the count
 * through this function, so the two consumers cannot interpret the same
 * `{ quorum: N }` value differently. The outcome-protocol reducer reads it
 * here too.
 */
export function readQuorum(strategy: ResolvedJoinStrategy): number | undefined {
  return typeof strategy === "object" ? strategy.quorum : undefined;
}

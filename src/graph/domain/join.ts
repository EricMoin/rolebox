import { JoinStrategy } from "../../constants.ts";

// ── Join Model ──────────────────────────────────────────────────────────────

/**
 * Fan-in (convergence) configuration for nodes with multiple upstream edges.
 *
 * Convergence is a pure graph-theoretic mechanism. The join strategy
 * determines when all required upstream results are received. What the
 * node does with the merged input (validate, synthesize, approve) is
 * the agent's business — the engine only enforces the join.
 *
 * A DISCRIMINATED union (C1): `quorum` exists exactly on the `"quorum"`
 * branch, so a quorum strategy cannot be declared without its required-answer
 * count. The former optional `quorum?: number` made `{ strategy: "quorum" }`
 * type-check and then silently degrade to a count of 1 at runtime; the
 * declaration side (the deleted v2 validator's rule 9, and now the v3 parser)
 * rejects a missing count instead.
 *
 * Field ownership (P1): this is DECLARATION content. It is compiled into
 * `CompiledPlan` and a changed join is a new plan revision, never an in-place
 * edit of a running graph.
 */
export type JoinConfig =
  | {
    /** Wait for every upstream to signal `answer`. */
    strategy: "all";
  }
  | {
    /** Proceed as soon as one upstream signals `answer`. */
    strategy: "any";
  }
  | {
    /** Proceed when N upstreams signal `answer`. */
    strategy: "quorum";
    /**
     * Number of required answers (N in `quorum:N`). Must be a positive
     * integer; the v3 declaration parser enforces that (the deleted v2
     * validator additionally bounded it by the node's in-degree).
     */
    quorum: number;
  };

// ── Join Strategy (runtime) ─────────────────────────────────────────────────

/**
 * Runtime join strategy for a convergence node — the resolved projection of
 * the declaration's `JoinConfig` (C1).
 *
 * `"all"` / `"any"` stay strings; `quorum:N` becomes `{ quorum: N }` so the
 * required count travels with the strategy. The declared union forces
 * `quorum` to exist on the quorum branch, so a bare `"quorum"` string is not
 * representable at either boundary. `readQuorum` below is the single reader of
 * the count; the outcome-protocol reducer goes through it (its legacy callers
 * were deleted with the legacy runtime).
 *
 * Field ownership (P1): a resolved strategy is RUNTIME state, not a durable
 * record — the durable join facts are the `NodeAttempt` entries and their
 * `OutcomeArrival` list inside the run state body, which the reducer owns.
 * This type is never persisted on its own and never re-read as a declaration.
 */
export type ResolvedJoinStrategy = "all" | "any" | { quorum: number };

// ── Join strategy resolution ────────────────────────────────────────────────

/**
 * Pure resolver that projects a node's declared `JoinConfig` into the
 * runtime join-strategy shape. Absent `join` (or `strategy: all`) resolves to
 * "all".
 *
 * `any` resolves to the `JoinStrategy.Any` string value; `quorum:N` resolves to
 * `{ quorum: N }` (the required count lives on the `JoinConfig`, not the
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
  // DECLARATION side may not lean on that default: the v3 declaration parser
  // refuses a "quorum" strategy with no positive-integer count
  // (`readJoin` in parse-declaration-v3.ts), so no accepted declaration
  // reaches this default.
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
 * Single reader for the quorum branch (C1). The deleted legacy evaluator and
 * approval cancellation gate read the count through this function too; today
 * the outcome-protocol reducer (`src/graph/outcome/graph-state.ts`) is the
 * surviving reader, so a `{ quorum: N }` value still has exactly one
 * interpreter.
 */
export function readQuorum(strategy: ResolvedJoinStrategy): number | undefined {
  return typeof strategy === "object" ? strategy.quorum : undefined;
}

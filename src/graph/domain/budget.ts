/**
 * Graph domain — the neutral BUDGET vocabulary
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The declared limits and the consumption state, MOVED here from the retired v2
 * type containers: `NodeBudgetSpec` / `GraphBudgetSpec` from the v2 graph
 * declaration module and the consumption state (`GraphBudgetState`, whose
 * canonical name here is `BudgetState`) from the v2 engine-state module.
 * Exactly ONE definition of each concept exists; both retired modules re-export
 * these names instead of declaring them.
 *
 * Dependency leaf: this module imports nothing at all, so every layer may name
 * the budget vocabulary without dragging a retired container in.
 */

// ── Budget specs (declaration content) ──────────────────────────────────────

/**
 * Per-node resource budget (maps to DispatchManager per-session limits).
 *
 * Field ownership (P1): the SPEC is immutable definition content — the compiler
 * copies it into `CompiledPlan.nodes[].budget`, and a changed limit is a new
 * plan revision rather than an edit of a running graph.
 * Writers: the declaration/compile path only; no run, worker or recovery path
 * writes a spec.
 * Replaces: nothing — this is the same declared vocabulary the v3 declaration
 * grammar and the compiler already consume (`src/graph/compiler/compile.ts`
 * reads exactly these keys); only its home moved.
 */
export interface NodeBudgetSpec {
  /** Max input tokens for this node */
  max_input_tokens?: number;
  /** Max output tokens for this node */
  max_output_tokens?: number;
  /** Max cumulative cost for this node (USD) */
  max_cost_usd?: number;
  /** Wall-clock timeout for this node (ms) */
  timeout_ms?: number;
  /** Automatic retries on escalate */
  max_retries?: number;
}

/**
 * Graph-level resource budget (cumulative across all nodes).
 *
 * The orchestrating agent sub-allocates the graph budget to child nodes.
 * Overbooking is allowed (sum of per-node budgets may exceed graph budget),
 * but actual consumption is bounded by the graph budget.
 *
 * Field ownership (P1): declaration content, exactly as {@link NodeBudgetSpec}.
 * Writers: the declaration path only.
 * Replaces: nothing — the same declared vocabulary the RETIRED v2 declaration
 * carried (`GraphDeclaration.budget`), moved with its semantics intact; only
 * its home moved.
 * KNOWN FACT: no live compiler path reads this shape. The v3 grammar
 * (`GraphDeclarationV3`) declares NO graph-level budget, so only
 * {@link NodeBudgetSpec} is consumed today (per-node specs are compiled into the
 * plan). Whether the converged definition keeps a graph-level spec, and which
 * budget object enforces it, is a P3/P4 decision — this move deliberately
 * changes neither.
 */
export interface GraphBudgetSpec {
  /** Max total input tokens across all nodes */
  max_total_input_tokens?: number;
  /** Max total output tokens across all nodes */
  max_total_output_tokens?: number;
  /** Max total cost across all nodes (USD) */
  max_total_cost_usd?: number;
}

// ── Budget state (runtime consumption) ──────────────────────────────────────

/**
 * Cumulative graph-level budget consumption state.
 *
 * The counters an execution actually moved: dispatch sessions spawned and
 * tokens/cost consumed across all nodes of one run.
 *
 * Field ownership (P1)
 * Owns: the graph-level consumption counters of ONE run. It is the only
 * aggregate the store needs for a budget check; per-node mirrors are not a
 * second authority.
 * Writers: NO live writer today — the v2 container's `applyBudgetDelta` writer
 * was deleted with the legacy runtime, and the outcome run-state body carries no
 * budget field at all. The converged store's owner is the outcome reducer,
 * inside the acceptance transaction (the ledger's `runInTransaction` boundary),
 * so consumption advances with the state change that consumed it and never
 * beside it — that wiring is P3's.
 * Replaces: the `GraphBudgetState` field the retired v2 container carried on
 * `EngineState.budget` and the per-node
 * `NodeRuntimeState.tokensConsumed` / `sessionsSpawned` mirror that fed it.
 *
 * SCOPE (P3 budget): this is the RUN-LEVEL AGGREGATE of recorded usage — the
 * counters a report reduces to. It is NOT the enforcement model and it carries
 * NO limit: the durable reservations, the declared ceilings and the reconciliation
 * between them live in the store (one row per armed dispatch) and in the P3
 * vocabulary below, because a counter that is merely summed is not a gate.
 */
export interface BudgetState {
  /** Total dispatch sessions spawned across all nodes */
  sessionsSpawned: number;
  /** Total input tokens consumed across all nodes */
  totalInputTokens: number;
  /** Total output tokens consumed across all nodes */
  totalOutputTokens: number;
  /** Total cost consumed across all nodes (USD) */
  totalCost: number;
}

/**
 * The name this consumption state carried inside the retired v2 engine-state
 * container, kept as an alias so existing importers of that name keep resolving
 * — one definition, two names, never two shapes.
 */
export type GraphBudgetState = BudgetState;

// ── The P3 budget model: authorized limits, usage, and the refusal ──────────

/**
 * The LIMIT dimensions a compiled plan authorizes (P3 budget).
 *
 * A DIMENSION IS AUTHORIZED ONLY IF THE DECLARATION CAN SPELL IT. The v3
 * grammar's closed budget key set is
 * `max_input_tokens | max_output_tokens | max_cost_usd | timeout_ms | max_retries`
 * (`src/graph/compiler/parse-declaration-v3.ts`, `BUDGET_KEYS`); the four
 * dimensions below are exactly the four NUMERIC CEILINGS among them, mapped to
 * the names the runtime, the store and a report use.
 *
 * WHAT IS **NOT** AUTHORIZED, AND WHERE IT IS REFUSED RATHER THAN DEFAULTED:
 *
 * - An EXECUTION-COUNT ceiling. `max_retries` is a RETRY ceiling (its declared
 *   meaning is "automatic retries on escalate"), not a count of executions, and
 *   no other declaration field counts executions. This build therefore RECORDS
 *   the execution count as usage (one fact per armed dispatch) and enforces no
 *   count ceiling at all. A budget spec carrying a key outside the grammar's
 *   five is refused by name ({@link nodeBudgetLimitsOf}) instead of being
 *   silently ignored or defaulted to "unlimited".
 * - A GRAPH/run-level ceiling. {@link GraphBudgetSpec} exists as a vocabulary
 *   type moved from the retired v2 declaration, but the v3 grammar's ROOT_KEYS
 *   carry no `budget` key and NO live path reads that shape — so a run has no
 *   declared total ceiling and none is invented here. The run-level numbers a
 *   report shows are the SUM of the per-node facts, never a second ceiling.
 * - `max_retries` is accepted (the grammar allows it) and deliberately NOT
 *   turned into a budget limit: the v3 retry path is an explicit TRUSTED
 *   command, and a declared automatic-retry ceiling has no consumer in this
 *   build. That is a named gap, not a silently enforced limit.
 */
export type BudgetLimitKind =
  | "duration_ms"
  | "input_tokens"
  | "output_tokens"
  | "cost_usd";

/** Every authorized limit dimension, in canonical order. */
export const BUDGET_LIMIT_KINDS: readonly BudgetLimitKind[] = Object.freeze([
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cost_usd",
]);

/**
 * The declared ceilings of ONE node, as the compiled plan authorizes them.
 *
 * Every field is OPTIONAL and an absent field means the declaration declared no
 * ceiling for that dimension — it does NOT mean zero and it does NOT mean
 * unlimited-because-defaulted: absent is read as "nothing to enforce", which is
 * the declaration's own silence.
 */
export interface NodeBudgetLimits {
  /** `timeout_ms` — the wall-clock ceiling for this node's attempt. */
  readonly durationMs?: number;
  /** `max_input_tokens`. */
  readonly inputTokens?: number;
  /** `max_output_tokens`. */
  readonly outputTokens?: number;
  /** `max_cost_usd`. */
  readonly costUsd?: number;
}

/**
 * Recorded usage along every dimension, including the count that has NO
 * authorized ceiling.
 *
 * `executions` is a COUNT OF DISPATCHES, not a sum of anything the host
 * reports: one armed dispatch is one execution, which is why it is a fact even
 * when the host never reports a token count. The other four are zero only when
 * nothing was reported for that dimension; "not reported" is a different fact
 * and is carried by the reservation's own status, never by a zero here.
 */
export interface BudgetUsageAmounts {
  readonly executions: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** No usage at all — the state of a node nothing has been dispatched for. */
export const ZERO_BUDGET_USAGE: BudgetUsageAmounts = Object.freeze({
  executions: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
});

/** The sum of two usage readings, dimension by dimension. */
export function addBudgetUsage(
  left: BudgetUsageAmounts,
  right: BudgetUsageAmounts,
): BudgetUsageAmounts {
  return Object.freeze({
    executions: left.executions + right.executions,
    durationMs: left.durationMs + right.durationMs,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costUsd: left.costUsd + right.costUsd,
  });
}

/**
 * One dimension of one node whose RECORDED usage exceeds its DECLARED ceiling.
 *
 * `overBy` is the ACTUAL excess (`used - limit`), never clamped and never
 * rounded away: plan §4 P3 requires an external billing feedback delay to be
 * reported as the real overrun rather than as "no overrun". `limit` and `used`
 * are the two recorded facts the excess is derived from, so a reader can check
 * the arithmetic instead of trusting it.
 */
export interface BudgetOverrun {
  readonly nodeId: string;
  readonly kind: BudgetLimitKind;
  readonly limit: number;
  readonly used: number;
  /** `used - limit`, always > 0 for an overrun. */
  readonly overBy: number;
}

/**
 * Why a per-node budget spec is not one this build can enforce.
 *
 * The spec here is the PLAN's own `NodeBudgetSpec`, which the compiler copies
 * from the declaration. A value that reaches the runtime with a key the grammar
 * never authorizes cannot be enforced, and enforcing SOMETHING ELSE (ignoring
 * the key, or treating it as a default) would be exactly the silent widening
 * plan §7 forbids. It is refused by name.
 */
export interface BudgetLimitRefusal {
  readonly code: "budget-limit-unauthorized" | "budget-limit-invalid";
  /** The offending key, in the spec's own vocabulary. */
  readonly key: string;
  readonly message: string;
}

/** The verdict of reading one node's declared ceilings. */
export type BudgetLimitReading =
  | { readonly kind: "ok"; readonly limits: NodeBudgetLimits }
  | { readonly kind: "refused"; readonly refusal: BudgetLimitRefusal };

/** The budget keys the v3 grammar declares, and which of them this build reads. */
const AUTHORIZED_BUDGET_KEYS: ReadonlySet<string> = new Set([
  "max_input_tokens",
  "max_output_tokens",
  "max_cost_usd",
  "timeout_ms",
  "max_retries",
]);

/** The four keys that ARE ceiling dimensions; `max_retries` is accepted unread. */
const LIMIT_KEYS: ReadonlyMap<string, BudgetLimitKind> = new Map([
  ["max_input_tokens", "input_tokens"],
  ["max_output_tokens", "output_tokens"],
  ["max_cost_usd", "cost_usd"],
  ["timeout_ms", "duration_ms"],
]);

/**
 * Read one node's declared ceilings, or refuse the spec by name.
 *
 * TOTAL and non-throwing: the caller gets either the four authorized ceilings or
 * a named refusal, so a plan whose budget this build cannot read exactly is
 * blocked BEFORE anything is dispatched rather than run with a subset of its
 * declared limits. Values must be finite and non-negative — the parser already
 * enforces that for a declared graph, and this check exists so a spec assembled
 * by ANY other path (a host-built plan, a fixture) cannot smuggle in `NaN`,
 * `Infinity` or a negative ceiling that would make the store's comparison
 * vacuous.
 */
export function nodeBudgetLimitsOf(
  spec: NodeBudgetSpec | undefined,
): BudgetLimitReading {
  const limits: {
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  } = {};
  if (spec === undefined) return Object.freeze({ kind: "ok", limits: Object.freeze(limits) });
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return refusedLimit(
      "budget-limit-invalid",
      "$",
      "the per-node budget is not an object, so no declared ceiling could be read",
    );
  }
  const record = spec as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (!AUTHORIZED_BUDGET_KEYS.has(key)) {
      return refusedLimit(
        "budget-limit-unauthorized",
        key,
        "the v3 grammar authorizes no per-node budget key " +
          JSON.stringify(key) +
          " (it declares max_input_tokens / max_output_tokens / max_cost_usd / " +
          "timeout_ms / max_retries), so this build neither enforces it nor " +
          "defaults it — nothing was dispatched under a budget it cannot read",
      );
    }
    const dimension = LIMIT_KEYS.get(key);
    if (dimension === undefined) continue;
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return refusedLimit(
        "budget-limit-invalid",
        key,
        "the declared ceiling " +
          JSON.stringify(key) +
          " is not a finite non-negative number, so no honest comparison against " +
          "recorded usage exists — nothing was dispatched under it",
      );
    }
    if (dimension === "duration_ms") limits.durationMs = value;
    else if (dimension === "input_tokens") limits.inputTokens = value;
    else if (dimension === "output_tokens") limits.outputTokens = value;
    else limits.costUsd = value;
  }
  return Object.freeze({ kind: "ok", limits: Object.freeze(limits) });
}

/** One named budget-limit refusal. */
function refusedLimit(
  code: BudgetLimitRefusal["code"],
  key: string,
  message: string,
): BudgetLimitReading {
  return Object.freeze({
    kind: "refused" as const,
    refusal: Object.freeze({ code, key, message }),
  });
}

/** Whether the spec declares at least one enforceable ceiling. */
export function hasBudgetLimits(limits: NodeBudgetLimits): boolean {
  return (
    limits.durationMs !== undefined ||
    limits.inputTokens !== undefined ||
    limits.outputTokens !== undefined ||
    limits.costUsd !== undefined
  );
}

/**
 * Every dimension of one node whose recorded usage exceeds its declared
 * ceiling, with the ACTUAL excess.
 *
 * `>` rather than `>=`: the legacy v2 bridge treated "at the ceiling" as a
 * breach because it was a PRE-dispatch gate (no headroom left to start). An
 * overrun is a fact about usage that ALREADY happened, and usage exactly at the
 * ceiling did not exceed it — reporting it as an overrun would overstate the
 * bill. What "no headroom" stops is the next DISPATCH, and that rule lives in
 * the store's conditional reservation, not here.
 */
export function budgetOverrunsOf(
  nodeId: string,
  limits: NodeBudgetLimits,
  used: BudgetUsageAmounts,
): readonly BudgetOverrun[] {
  const out: BudgetOverrun[] = [];
  const compare = (kind: BudgetLimitKind, limit: number | undefined, value: number): void => {
    if (limit === undefined || value <= limit) return;
    out.push(
      Object.freeze({ nodeId, kind, limit, used: value, overBy: value - limit }),
    );
  };
  compare("duration_ms", limits.durationMs, used.durationMs);
  compare("input_tokens", limits.inputTokens, used.inputTokens);
  compare("output_tokens", limits.outputTokens, used.outputTokens);
  compare("cost_usd", limits.costUsd, used.costUsd);
  return Object.freeze(out);
}


// ── The report: declared limits against recorded usage ──────────────────────

/** One node's usage facts as a substrate records them (structural input). */
export interface BudgetNodeFacts {
  readonly nodeId: string;
  /** Every dispatch of this node in the run. */
  readonly executions: number;
  /** Recorded usage of the attempts whose usage was reported. */
  readonly used: BudgetUsageAmounts;
  /** Outstanding claims of dispatches that have not ended yet. */
  readonly reserved: BudgetUsageAmounts;
  /** Dispatches that ENDED with no usage report: usage unknown, not zero. */
  readonly unknownUsageAttempts: number;
}

/** One node's budget facts, as a report reads them. */
export interface BudgetReportNode {
  readonly nodeId: string;
  /** The ceilings the plan declares for this node; absent fields = none. */
  readonly limits: NodeBudgetLimits;
  /** Every dispatch of this node in the run. */
  readonly executions: number;
  readonly used: BudgetUsageAmounts;
  readonly reserved: BudgetUsageAmounts;
  readonly unknownUsageAttempts: number;
  /** Every dimension whose recorded usage exceeds its ceiling, with the excess. */
  readonly overruns: readonly BudgetOverrun[];
}

/**
 * The budget state of ONE RUN: the declared limits and the recorded usage.
 *
 * `totals.executions` counts every authorized dispatch, while
 * `totals.executions`, `reservedTotals.executions` and
 * `unknownUsageAttempts` account for them separately — so "no usage reported
 * yet" can never be read as "used nothing". `overruns` is the flattened list of
 * every node's overruns; it is empty exactly when nothing recorded exceeded a
 * declared ceiling.
 */
export interface BudgetReport {
  readonly graphId: string;
  /** The run the facts belong to; absent when the graph has never run. */
  readonly runId?: string;
  readonly planRevision: string;
  readonly nodes: readonly BudgetReportNode[];
  readonly totals: BudgetUsageAmounts;
  readonly reservedTotals: BudgetUsageAmounts;
  readonly unknownUsageAttempts: number;
  readonly overruns: readonly BudgetOverrun[];
}

/**
 * Build the report from the plan's declared limits and a substrate's rows.
 *
 * PURE and TOTAL: every plan node is reported (a node nothing dispatched shows
 * its ceilings and zeros, so "declared but unused" and "undeclared" never look
 * alike), the totals are the arithmetic of the rows, and every overrun is
 * recomputed here — `used - limit`, never clamped and never absorbed. The SAME
 * builder serves the runtime's own report and the control answer a
 * `budget-stop` carries, so the two can never disagree about what was
 * overspent.
 */
export function buildBudgetReport(input: {
  readonly graphId: string;
  readonly runId?: string;
  readonly planRevision: string;
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly limits: NodeBudgetLimits;
  }[];
  readonly usage: readonly BudgetNodeFacts[];
}): BudgetReport {
  const totals: {
    executions: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  } = { executions: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const reservedTotals = { ...totals };
  let unknownUsageAttempts = 0;
  const overruns: BudgetOverrun[] = [];
  const byNode = new Map(input.usage.map((entry) => [entry.nodeId, entry]));
  const nodes: BudgetReportNode[] = [];
  for (const node of input.nodes) {
    const own = byNode.get(node.nodeId);
    const used = own?.used ?? ZERO_BUDGET_USAGE;
    const reserved = own?.reserved ?? ZERO_BUDGET_USAGE;
    const nodeOverruns = budgetOverrunsOf(node.nodeId, node.limits, used);
    for (const overrun of nodeOverruns) overruns.push(overrun);
    // EVERY authorized dispatch, whatever its status: the three other counts
    // (reconciled, outstanding, unknown) partition this number.
    totals.executions += own?.executions ?? 0;
    totals.durationMs += used.durationMs;
    totals.inputTokens += used.inputTokens;
    totals.outputTokens += used.outputTokens;
    totals.costUsd += used.costUsd;
    reservedTotals.executions += reserved.executions;
    reservedTotals.durationMs += reserved.durationMs;
    reservedTotals.inputTokens += reserved.inputTokens;
    reservedTotals.outputTokens += reserved.outputTokens;
    reservedTotals.costUsd += reserved.costUsd;
    unknownUsageAttempts += own?.unknownUsageAttempts ?? 0;
    nodes.push(
      Object.freeze({
        nodeId: node.nodeId,
        limits: node.limits,
        executions: own?.executions ?? 0,
        used,
        reserved,
        unknownUsageAttempts: own?.unknownUsageAttempts ?? 0,
        overruns: nodeOverruns,
      }),
    );
  }
  return Object.freeze({
    graphId: input.graphId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    planRevision: input.planRevision,
    nodes: Object.freeze(nodes),
    totals: Object.freeze(totals),
    reservedTotals: Object.freeze(reservedTotals),
    unknownUsageAttempts,
    overruns: Object.freeze(overruns),
  });
}

/**
 * The RUN-LEVEL {@link BudgetState} a recorded usage reading reduces to.
 *
 * The legacy four counters are a VIEW of the P3 usage model, not a second
 * authority: `sessionsSpawned` is the execution count (one per armed dispatch),
 * and the three consumption counters are the recorded totals. Duration has no
 * legacy counter, so it is deliberately absent here rather than folded into one.
 */
export function budgetStateOf(usage: BudgetUsageAmounts): BudgetState {
  return Object.freeze({
    sessionsSpawned: usage.executions,
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    totalCost: usage.costUsd,
  });
}

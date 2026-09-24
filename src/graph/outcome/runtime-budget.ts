import type { CompiledPlan } from "../compiler/plan.ts";
import {
  buildBudgetReport, hasBudgetLimits, nodeBudgetLimitsOf, readRunBudget,
  type BudgetUsageAmounts, type NodeBudgetLimits,
} from "../domain/budget.ts";
import type { AcceptanceLedger, AcceptanceLedgerTx, BudgetUsageResult } from "../ledger/types.ts";
import { errorText } from "../../utils/error-text.ts";
import { dispatchEffectIdOf } from "./dispatch-effects.ts";
import { ledgerReadRefusal, readRuntimeClock, refused } from "./runtime-refusals.ts";
import type {
  OutcomeBudgetReading, OutcomeBudgetUsageEntry, OutcomeBudgetUsageOutcome,
  OutcomeBudgetUsageReport, OutcomeRuntimeRefusal,
} from "./runtime-contract.ts";

/** Budget claims join the caller's transaction; usage reconciliation owns its transaction. */
export class OutcomeRuntimeBudget {
  private readonly graphId: string;
  private readonly planRevision: string;
  private readonly budgetLimits: ReadonlyMap<string, NodeBudgetLimits>;
  private readonly budgetLimitRefusal: OutcomeRuntimeRefusal | undefined;
  private readonly declaresBudgetLimits: boolean;

  constructor(
    private readonly plan: CompiledPlan,
    private readonly ledger: AcceptanceLedger,
    private readonly clock: () => number,
  ) {
    this.graphId = plan.graphId;
    this.planRevision = plan.planRevision;
    const limits = new Map<string, NodeBudgetLimits>();
    let limitRefusal: OutcomeRuntimeRefusal | undefined;
    let declares = false;
    try {
      declares = readRunBudget(this.plan.budget)?.max_executions !== undefined;
    } catch (error) {
      limitRefusal = { code: "budget-limit-unauthorized", path: "$.budget", message: String(error) };
    }
    for (const node of this.plan.nodes) {
      const reading = nodeBudgetLimitsOf(node.budget);
      if (reading.kind === "refused") {
        limitRefusal ??= Object.freeze({
          code: "budget-limit-unauthorized" as const,
          path: "$.nodes." + node.id + ".budget." + reading.refusal.key,
          message:
            "outcome-runtime: the declared budget of node " +
            JSON.stringify(node.id) +
            " in plan revision " +
            this.planRevision +
            " is not one this build can enforce (" +
            reading.refusal.code +
            " on " +
            reading.refusal.key +
            "): " +
            reading.refusal.message,
        });
        continue;
      }
      limits.set(node.id, reading.limits);
      if (hasBudgetLimits(reading.limits)) declares = true;
    }
    this.budgetLimits = limits;
    this.budgetLimitRefusal = limitRefusal;
    this.declaresBudgetLimits = declares;
  }

  capabilityRefusal(): OutcomeRuntimeRefusal | undefined {
    if (this.budgetLimitRefusal !== undefined) return this.budgetLimitRefusal;
    if (!this.declaresBudgetLimits) return undefined;
    if (this.ledger.budget !== undefined) return undefined;
    return {
      code: "budget-unavailable",
      path: "$.nodes",
      message:
        "outcome-runtime: plan revision " +
        this.planRevision +
        " declares a per-node resource budget, and the substrate this runtime holds exposes " +
        "no budget surface — the ceilings could not be recorded as claims, so nothing was " +
        "started, resumed, advanced or settled under them",
    };
  }

  private limitsOfNode(nodeId: string): NodeBudgetLimits {
    return this.budgetLimits.get(nodeId) ?? Object.freeze({});
  }

  /** Reserve before committing the attempt, effect and credential; a refusal rolls them all back. */
  reserveDispatchIn(
    tx: AcceptanceLedgerTx,
    runId: string,
    nodeId: string,
    attemptId: string,
    at: number,
  ): OutcomeRuntimeRefusal | undefined {
    const budget = tx.budget;
    const limits = this.limitsOfNode(nodeId);
    if (budget === undefined) {
      if (!hasBudgetLimits(limits) && this.plan.budget?.max_executions === undefined) return undefined;
      return {
        code: "budget-unavailable",
        path: "$.nodes",
        message:
          "outcome-runtime: node " +
          JSON.stringify(nodeId) +
          " declares a resource budget and the substrate this transaction writes holds no " +
          "budget surface, so the dispatch was not authorized — a ceiling nothing can record " +
          "a claim against is a ceiling nothing enforces",
      };
    }
    const claimed = budget.reserveDispatch({
      maxExecutions: this.plan.budget?.max_executions,
      graphId: this.graphId,
      runId,
      nodeId,
      attemptId,
      effectId: dispatchEffectIdOf(attemptId),
      limits,
      at,
    });
    if (claimed.kind === "reserved" || claimed.kind === "replayed") return undefined;
    const reasons = claimed.exhausted.map((entry) => entry.message).join("; ");
    return {
      code: "budget-exhausted",
      path: "$.nodes." + nodeId + ".budget",
      message:
        "outcome-runtime: the dispatch of node " +
        JSON.stringify(nodeId) +
        " as attempt " +
        JSON.stringify(attemptId) +
        " was NOT authorized by the declared budget (" +
        reasons +
        ") — no attempt, state change, effect or credential record was written for it, and " +
        "an attempt already in flight is not affected: its own claim stands and it runs to " +
        "its settlement",
    };
  }

  /** Release before claiming successors; delayed usage still reconciles the released reservation. */
  releaseDispatchClaim(
    tx: AcceptanceLedgerTx,
    runId: string,
    nodeId: string,
    attemptId: string,
    at: number,
  ): void {
    tx.budget?.releaseReservation({
      graphId: this.graphId,
      runId,
      nodeId,
      attemptId,
      at,
    });
  }

  recordUsage(report: OutcomeBudgetUsageReport): OutcomeBudgetUsageOutcome {
    const malformed = this.usageReportProblem(report);
    if (malformed !== undefined) return refused([malformed]);
    const at = readRuntimeClock(this.clock, report.now);
    if (typeof at !== "number") return refused([at]);
    const budget = this.ledger.budget;
    if (budget === undefined) {
      return refused([
        {
          code: "budget-unavailable",
          path: "$.attempts",
          message:
            "outcome-runtime: graph " +
            JSON.stringify(this.graphId) +
            " holds no budget surface, so a usage report cannot be recorded against it",
        },
      ]);
    }
    // THE RUN THIS REPORT IS ADDRESSED TO: the run that is current when the bill
    // lands. It is the identity of last resort for an attempt that holds no claim
    // at all; an attempt that DOES hold one is settled against its own run by the
    // store, however long ago that run was superseded.
    let runId: string | undefined;
    try {
      runId = this.ledger.runs?.readRun(this.graphId)?.runId;
    } catch (error) {
      return refused([ledgerReadRefusal(this.graphId, error)]);
    }
    if (runId === undefined) {
      return refused([
        {
          code: "graph-not-started",
          path: "$.attempts",
          message:
            "outcome-runtime: graph " +
            JSON.stringify(this.graphId) +
            " has no run identity, so there is no run whose usage this report could be " +
            "recorded against — usage is a fact about a dispatch an attempt was authorized " +
            "for, and no attempt was",
        },
      ]);
    }
    const entries: OutcomeBudgetUsageEntry[] = [];
    try {
      this.ledger.runInTransaction((tx) => {
        const surface = tx.budget;
        if (surface === undefined) {
          throw new Error(
            "outcome-runtime: the transaction exposes no budget surface although the ledger does",
          );
        }
        for (const attempt of report.attempts) {
          const result = surface.reconcileUsage({
            graphId: this.graphId,
            runId,
            nodeId: attempt.nodeId,
            attemptId: attempt.attemptId,
            effectId: dispatchEffectIdOf(attempt.attemptId),
            usage: {
              executions: attempt.executions === undefined ? 1 : attempt.executions,
              durationMs: attempt.durationMs ?? 0,
              inputTokens: attempt.inputTokens ?? 0,
              outputTokens: attempt.outputTokens ?? 0,
              costUsd: attempt.costUsd ?? 0,
            },
            at,
          });
          entries.push(usageEntryOf(result));
        }
      });
    } catch (error) {
      return refused([
        {
          code: "unreadable-state",
          message:
            "outcome-runtime: the usage report for graph " +
            JSON.stringify(this.graphId) +
            " could not be recorded (" +
            errorText(error) +
            ") — the whole report was rolled back, so no partial reconciliation exists",
        },
      ]);
    }
    // The ANSWER describes the run the first settled fact belongs to — the
    // attempt's own claim decided that — falling back to the addressed run when
    // this report carried no attempts at all.
    const settledRunId = entries[0]?.runId ?? runId;
    const reading = this.budgetReport(settledRunId);
    if (reading.kind === "refused") return refused([reading.refusal]);
    return Object.freeze({
      kind: "recorded" as const,
      graphId: this.graphId,
      runId: settledRunId,
      at,
      entries: Object.freeze(entries),
      report: reading.report,
    });
  }

  private usageReportProblem(
    report: OutcomeBudgetUsageReport,
  ): OutcomeRuntimeRefusal | undefined {
    const fail = (path: string, detail: string): OutcomeRuntimeRefusal => ({
      code: "budget-usage-malformed",
      path,
      message:
        "outcome-runtime: the usage report for graph " +
        JSON.stringify(this.graphId) +
        " is not the closed record this protocol defines — " +
        detail +
        ", so nothing was recorded",
    });
    if (typeof report !== "object" || report === null || Array.isArray(report)) {
      return fail("$", "the report is not an object");
    }
    if (!Array.isArray(report.attempts)) {
      return fail("$.attempts", "attempts is not a list");
    }
    const amount = (value: unknown): boolean =>
      value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
    const count = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    for (let index = 0; index < report.attempts.length; index += 1) {
      const attempt = report.attempts[index];
      const path = "$.attempts[" + index + "]";
      if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) {
        return fail(path, "the entry is not an object");
      }
      if (typeof attempt.nodeId !== "string" || attempt.nodeId.length === 0) {
        return fail(path + ".nodeId", "nodeId is not a non-empty string");
      }
      if (typeof attempt.attemptId !== "string" || attempt.attemptId.length === 0) {
        return fail(path + ".attemptId", "attemptId is not a non-empty string");
      }
      if (!count(attempt.executions)) {
        return fail(path + ".executions", "executions is not a non-negative safe integer");
      }
      if (
        !amount(attempt.durationMs) ||
        !amount(attempt.inputTokens) ||
        !amount(attempt.outputTokens) ||
        !amount(attempt.costUsd)
      ) {
        return fail(path, "an amount is not a finite non-negative number");
      }
    }
    return undefined;
  }

  budgetReport(runId?: string): OutcomeBudgetReading {
    const budget = this.ledger.budget;
    if (budget === undefined) {
      return {
        kind: "refused",
        refusal: {
          code: "budget-unavailable",
          path: "$.nodes",
          message:
            "outcome-runtime: graph " +
            JSON.stringify(this.graphId) +
            " holds no budget surface, so it has no budget state to report",
        },
      };
    }
    let usage: readonly {
      readonly nodeId: string;
      readonly executions: number;
      readonly used: BudgetUsageAmounts;
      readonly reserved: BudgetUsageAmounts;
      readonly unknownUsageAttempts: number;
    }[];
    try {
      usage = budget.budgetUsageOf(this.graphId, runId);
    } catch (error) {
      return { kind: "refused", refusal: ledgerReadRefusal(this.graphId, error) };
    }
    let resolvedRunId: string | undefined = runId;
    if (resolvedRunId === undefined) {
      try {
        resolvedRunId = this.ledger.runs?.readRun(this.graphId)?.runId;
      } catch (error) {
        return { kind: "refused", refusal: ledgerReadRefusal(this.graphId, error) };
      }
    }
    // The ONE builder the control answer uses too: declared ceilings from the
    // plan, recorded usage from the rows, overruns recomputed — never clamped.
    return {
      kind: "report",
      report: buildBudgetReport({
        graphId: this.graphId,
        ...(resolvedRunId === undefined ? {} : { runId: resolvedRunId }),
        planRevision: this.planRevision,
        nodes: this.plan.nodes.map((node) => ({
          nodeId: node.id,
          limits: this.limitsOfNode(node.id),
        })),
        usage,
        runLimits: this.plan.budget,
      }),
    };
  }
}

function usageEntryOf(result: BudgetUsageResult): OutcomeBudgetUsageEntry {
  const reservation = result.reservation;
  const used = reservation.used;
  const base = {
    runId: reservation.runId,
    nodeId: reservation.nodeId,
    attemptId: reservation.attemptId,
    ...(used === undefined ? {} : { used }),
  };
  switch (result.kind) {
    case "reconciled":
      return Object.freeze({ ...base, outcome: "reconciled" as const });
    case "replayed":
      return Object.freeze({ ...base, outcome: "replayed" as const });
    case "recorded-late":
      return Object.freeze({ ...base, outcome: "recorded-late" as const });
    case "ignored":
      return Object.freeze({
        ...base,
        outcome: "ignored" as const,
        reason: result.reason,
      });
  }
}

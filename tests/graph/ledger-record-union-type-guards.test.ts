
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nodeBudgetLimitsOf,
  type BudgetUsageAmounts,
  type NodeBudgetLimits,
} from "../../src/graph/domain/budget.ts";
import type {
  BudgetReservationRecord,
  ControlCommandName,
  ControlDecisionRecord,
  NonRetryControlDecisionRecord,
  ReconciledBudgetReservationRecord,
  ReleasedBudgetReservationRecord,
  ReservedBudgetReservationRecord,
  RetryControlDecisionRecord,
} from "../../src/graph/ledger/types.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

const GRAPH = "guards.ledger";
const RUN = "guards.ledger@1";
const NODE = "work";
const ATTEMPT = "work#1";
const SUCCESSOR = "work#2";
const PLAN_REVISION = "plan.guards.ledger";
const NOW = 1_700_000_000_000;
const REASON = "the worker process died";

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-guards-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // Release the fixture's stores, then remove each tree ONCE — a removal that
  // throws must not leave the directory queued for the next sweep.
  removeTempTrees(tmpDirs);
});

/** One real retry decision, exactly as the store is asked to record it. */
function retryDecision(): {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly command: "retry";
  readonly reason: string;
  readonly decidedAt: number;
  readonly successorAttemptId: string;
} {
  return {
    graphId: GRAPH,
    runId: RUN,
    nodeId: NODE,
    attemptId: ATTEMPT,
    command: "retry",
    reason: REASON,
    decidedAt: NOW + 1,
    successorAttemptId: SUCCESSOR,
  };
}

// ── The type-level pins ─────────────────────────────────────────────────────

/** The four ceilings a fixture may declare, in the reading's own field names. */
type LimitFields = Pick<
  NodeBudgetLimits,
  "durationMs" | "inputTokens" | "outputTokens" | "costUsd"
>;

/**
 * Fixture ceilings go through the reader production uses: the brand on
 * `NodeBudgetLimits` (F-24) is written only by `nodeBudgetLimitsOf`, so a test
 * literal is not a substitute for reading a declared spec.
 */
function limitsOf(fields: LimitFields): NodeBudgetLimits {
  const reading = nodeBudgetLimitsOf({
    ...(fields.durationMs === undefined ? {} : { timeout_ms: fields.durationMs }),
    ...(fields.inputTokens === undefined ? {} : { max_input_tokens: fields.inputTokens }),
    ...(fields.outputTokens === undefined ? {} : { max_output_tokens: fields.outputTokens }),
    ...(fields.costUsd === undefined ? {} : { max_cost_usd: fields.costUsd }),
  });
  if (reading.kind !== "ok") throw new Error(reading.refusal.message);
  return reading.limits;
}

describe("F-17: ControlDecisionRecord is a discriminated union on `command`", () => {
  it("pins the two arms and the one that owns the successor link", () => {
    expectTypeOf<ControlDecisionRecord["command"]>().toEqualTypeOf<ControlCommandName>();
    // The two arms are SELECTED by the discriminant: `retry` is its own arm, and
    // every other command is the complementary one — which is why the selection
    // for them names `Exclude<ControlCommandName, "retry">` rather than one
    // command at a time (a concrete non-retry command does not select the arm,
    // because the arm carries all of them).
    expectTypeOf<Extract<ControlDecisionRecord, { readonly command: "retry" }>>()
      .toEqualTypeOf<RetryControlDecisionRecord>();
    expectTypeOf<
      Extract<ControlDecisionRecord, { readonly command: Exclude<ControlCommandName, "retry"> }>
    >().toEqualTypeOf<NonRetryControlDecisionRecord>();
    expectTypeOf<Extract<ControlDecisionRecord, { readonly command: "failure" }>>()
      .toEqualTypeOf<never>();

    // Every arm IS a decision, and the two are different types — one flat
    // interface with a union-typed `command` would make them equal.
    expectTypeOf<RetryControlDecisionRecord>().toExtend<ControlDecisionRecord>();
    expectTypeOf<NonRetryControlDecisionRecord>().toExtend<ControlDecisionRecord>();
    expectTypeOf<RetryControlDecisionRecord>().not.toEqualTypeOf<NonRetryControlDecisionRecord>();

    // The successor link is REQUIRED on exactly the retry arm, and addressable
    // (as `undefined`) on every other one — the access an existing reader
    // performs without narrowing.
    expectTypeOf<RetryControlDecisionRecord["successorAttemptId"]>().toEqualTypeOf<string>();
    expectTypeOf<NonRetryControlDecisionRecord["successorAttemptId"]>().toEqualTypeOf<undefined>();
    expectTypeOf<ControlDecisionRecord["successorAttemptId"]>()
      .toEqualTypeOf<string | undefined>();
  });

  it("refuses a retry with no successor and a successor on any other command", () => {
    // Every field BOTH arms carry, so the only reason a shape below fails is
    // the discriminant relation itself — not a missing unrelated field.
    type Fields = {
      readonly graphId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly reason: string;
      readonly decidedAt: number;
    };

    // A retry that minted no attempt can never answer which one it minted.
    expectTypeOf<Fields & { readonly command: "retry" }>()
      .not.toExtend<ControlDecisionRecord>();
    expectTypeOf<Fields & { readonly command: "retry"; readonly successorAttemptId: string }>()
      .toExtend<ControlDecisionRecord>();

    // A successor on another command names an attempt that command never made.
    expectTypeOf<Fields & { readonly command: "failure"; readonly successorAttemptId: string }>()
      .not.toExtend<ControlDecisionRecord>();
    expectTypeOf<Fields & { readonly command: "timeout"; readonly successorAttemptId: string }>()
      .not.toExtend<ControlDecisionRecord>();
    expectTypeOf<Fields & { readonly command: "approve"; readonly successorAttemptId: string }>()
      .not.toExtend<ControlDecisionRecord>();
    expectTypeOf<Fields & { readonly command: "failure" }>()
      .toExtend<ControlDecisionRecord>();
    expectTypeOf<Fields & { readonly command: "approve" }>()
      .toExtend<ControlDecisionRecord>();
  });
});

describe("F-17: BudgetReservationRecord is a discriminated union on `status`", () => {
  it("pins the three arms and the fields each status defines", () => {
    expectTypeOf<BudgetReservationRecord["status"]>()
      .toEqualTypeOf<"reserved" | "reconciled" | "released">();
    expectTypeOf<Extract<BudgetReservationRecord, { readonly status: "reserved" }>>()
      .toEqualTypeOf<ReservedBudgetReservationRecord>();
    expectTypeOf<Extract<BudgetReservationRecord, { readonly status: "reconciled" }>>()
      .toEqualTypeOf<ReconciledBudgetReservationRecord>();
    expectTypeOf<Extract<BudgetReservationRecord, { readonly status: "released" }>>()
      .toEqualTypeOf<ReleasedBudgetReservationRecord>();

    expectTypeOf<ReservedBudgetReservationRecord>().toExtend<BudgetReservationRecord>();
    expectTypeOf<ReconciledBudgetReservationRecord>().toExtend<BudgetReservationRecord>();
    expectTypeOf<ReleasedBudgetReservationRecord>().toExtend<BudgetReservationRecord>();
    expectTypeOf<ReservedBudgetReservationRecord>()
      .not.toEqualTypeOf<ReconciledBudgetReservationRecord>();
    expectTypeOf<ReconciledBudgetReservationRecord>()
      .not.toEqualTypeOf<ReleasedBudgetReservationRecord>();

    // `used` exists on exactly the reconciled arm...
    expectTypeOf<ReconciledBudgetReservationRecord["used"]>()
      .toEqualTypeOf<BudgetUsageAmounts>();
    expectTypeOf<ReservedBudgetReservationRecord["used"]>().toEqualTypeOf<undefined>();
    expectTypeOf<ReleasedBudgetReservationRecord["used"]>().toEqualTypeOf<undefined>();
    expectTypeOf<BudgetReservationRecord["used"]>()
      .toEqualTypeOf<BudgetUsageAmounts | undefined>();

    // ...and `settledAt` on exactly the two the claim has been settled in.
    expectTypeOf<ReservedBudgetReservationRecord["settledAt"]>().toEqualTypeOf<undefined>();
    expectTypeOf<ReconciledBudgetReservationRecord["settledAt"]>().toEqualTypeOf<number>();
    expectTypeOf<ReleasedBudgetReservationRecord["settledAt"]>().toEqualTypeOf<number>();
  });

  it("refuses a reconciled claim with no usage and a reserved one that carries it", () => {
    // Every field all three arms carry, so the only reason a shape below fails
    // is the status relation itself.
    type Fields = {
      readonly graphId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly effectId: string;
      readonly checked: NodeBudgetLimits;
      readonly reserved: BudgetUsageAmounts;
      readonly reservedAt: number;
    };

    // A reconciled row without its usage could not say what was spent.
    expectTypeOf<Fields & { readonly status: "reconciled"; readonly settledAt: number }>()
      .not.toExtend<BudgetReservationRecord>();
    expectTypeOf<
      Fields & { readonly status: "reconciled"; readonly used: BudgetUsageAmounts }
    >().not.toExtend<BudgetReservationRecord>();
    expectTypeOf<
      Fields & {
        readonly status: "reconciled";
        readonly used: BudgetUsageAmounts;
        readonly settledAt: number;
      }
    >().toExtend<BudgetReservationRecord>();

    // An outstanding claim carries no usage and no settlement time.
    expectTypeOf<Fields & { readonly status: "reserved"; readonly used: BudgetUsageAmounts }>()
      .not.toExtend<BudgetReservationRecord>();
    expectTypeOf<Fields & { readonly status: "reserved"; readonly settledAt: number }>()
      .not.toExtend<BudgetReservationRecord>();
    expectTypeOf<Fields & { readonly status: "reserved" }>()
      .toExtend<BudgetReservationRecord>();

    // A released claim is SETTLED but its usage stays UNKNOWN — never a
    // fabricated zero.
    expectTypeOf<
      Fields & {
        readonly status: "released";
        readonly used: BudgetUsageAmounts;
        readonly settledAt: number;
      }
    >().not.toExtend<BudgetReservationRecord>();
    expectTypeOf<Fields & { readonly status: "released"; readonly settledAt: number }>()
      .toExtend<BudgetReservationRecord>();
    expectTypeOf<Fields & { readonly status: "released" }>()
      .not.toExtend<BudgetReservationRecord>();
  });
});

// ── The runtime round-trips ─────────────────────────────────────────────────

describe("F-17: the tightened records still round-trip through the store", () => {
  it("writes, reads and re-reads a REAL retry decision with its successor", () => {
    const dir = makeDir();
    let store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({
        graphId: GRAPH,
        runId: RUN,
        startedAt: NOW,
        planRevision: PLAN_REVISION,
      });
      const written = store.runs.writeControlDecision({
        decision: {
          graphId: GRAPH,
          runId: RUN,
          nodeId: NODE,
          attemptId: ATTEMPT,
          command: "retry",
          reason: REASON,
          decidedAt: NOW + 1,
          successorAttemptId: SUCCESSOR,
        },
        // A node-scoped retry supersedes one attempt; it claims no run fact.
      });
      expect(written.kind).toBe("recorded");
      if (written.kind !== "recorded") return;
      // The recorded arm IS the retry arm, and the link it minted is the one
      // the writer hands back.
      expect(written.decision.command).toBe("retry");
      if (written.decision.command !== "retry") return;
      expectTypeOf(written.decision.successorAttemptId).toEqualTypeOf<string>();
      expect(written.decision.successorAttemptId).toBe(SUCCESSOR);

      // The row read back is the same decision, with the same values.
      expect(store.runs.readControlDecision(GRAPH, RUN, NODE, ATTEMPT)).toEqual(retryDecision());
      expect(
        store.runs
          .controlDecisions(GRAPH)
          .map((decision) => decision.command + ":" + (decision.successorAttemptId ?? "-")),
      ).toEqual(["retry:" + SUCCESSOR]);

      // ...and it SURVIVES a reopen: the link is a durable column, not a value
      // this process kept in memory.
      store.close();
      store = GraphStore.openFile(dir);
      const reread = store.runs.readControlDecision(GRAPH, RUN, NODE, ATTEMPT);
      expect(reread).toEqual(retryDecision());
      expect(reread?.command).toBe("retry");
      if (reread?.command === "retry") {
        expectTypeOf(reread.successorAttemptId).toEqualTypeOf<string>();
        expect(reread.successorAttemptId).toBe(SUCCESSOR);
      }
    } finally {
      store.close();
    }
  });

  it("writes, reads and re-reads a REAL reconciled reservation with its usage", () => {
    const dir = makeDir();
    let store = GraphStore.openFile(dir);
    try {
      store.transaction((tx) => {
        tx.runs?.mintRun({
          graphId: GRAPH,
          runId: RUN,
          startedAt: NOW,
          planRevision: PLAN_REVISION,
        });
        const budget = tx.budget;
        if (budget === undefined) {
          throw new Error("fixture: the shipped store exposes no budget surface");
        }
        const reserved = budget.reserveDispatch({
          graphId: GRAPH,
          runId: RUN,
          nodeId: NODE,
          attemptId: ATTEMPT,
          effectId: "dispatch:" + ATTEMPT,
          limits: limitsOf({ inputTokens: 1000 }),
          at: NOW + 1,
        });
        expect(reserved.kind).toBe("reserved");
        if (reserved.kind !== "reserved") return;
        // The row that was armed is the OUTSTANDING arm: no usage, no
        // settlement time — and the caller SEES that, not an optional field.
        expect(reserved.reservation.status).toBe("reserved");
        if (reserved.reservation.status === "reserved") {
          expectTypeOf(reserved.reservation.used).toEqualTypeOf<undefined>();
          expectTypeOf(reserved.reservation.settledAt).toEqualTypeOf<undefined>();
        }

        const reconciled = budget.reconcileUsage({
          graphId: GRAPH,
          runId: RUN,
          nodeId: NODE,
          attemptId: ATTEMPT,
          effectId: "dispatch:" + ATTEMPT,
          usage: {
            executions: 1,
            durationMs: 1200,
            inputTokens: 300,
            outputTokens: 40,
            costUsd: 0.25,
          },
          at: NOW + 2,
        });
        expect(reconciled.kind).toBe("reconciled");
        if (reconciled.kind !== "reconciled") return;
        const settled = reconciled.reservation;
        expect(settled.status).toBe("reconciled");
        if (settled.status !== "reconciled") {
          throw new Error("fixture: reconcileUsage did not answer with a reconciled row");
        }
        // The RECONCILED arm carries BOTH facts its status defines, with the
        // values the report supplied.
        expectTypeOf(settled.used).toEqualTypeOf<BudgetUsageAmounts>();
        expectTypeOf(settled.settledAt).toEqualTypeOf<number>();
        expect(settled.used.executions).toBe(1);
        expect(settled.used.durationMs).toBe(1200);
        expect(settled.used.inputTokens).toBe(300);
        expect(settled.used.outputTokens).toBe(40);
        expect(settled.used.costUsd).toBe(0.25);
        expect(settled.settledAt).toBe(NOW + 2);
      });

      // The row read back through the port is the reconciled arm, and narrowing
      // on `status` is what makes its usage total.
      const row = store.budget.readReservation(GRAPH, ATTEMPT, RUN);
      expect(row?.status).toBe("reconciled");
      if (row?.status !== "reconciled") {
        throw new Error("fixture: the reconciled reservation did not read back reconciled");
      }
      expectTypeOf(row.used).toEqualTypeOf<BudgetUsageAmounts>();
      expect(row.used.inputTokens).toBe(300);
      expect(row.settledAt).toBe(NOW + 2);
      expect(row.checked).toEqual(limitsOf({ inputTokens: 1000 }));
      expect(row.reserved.inputTokens).toBe(1000);

      // ...and it SURVIVES a reopen: `used_*` and `settled_at` are columns.
      store.close();
      store = GraphStore.openFile(dir);
      const reread = store.budget.readReservation(GRAPH, ATTEMPT, RUN);
      expect(reread?.status).toBe("reconciled");
      expect(reread?.used).toEqual({
        executions: 1,
        durationMs: 1200,
        inputTokens: 300,
        outputTokens: 40,
        costUsd: 0.25,
      });
      expect(reread?.settledAt).toBe(NOW + 2);
    } finally {
      store.close();
    }
  });
});

/**
 * F-24 (A-10) — `NodeBudgetLimits` is a READING, not a shape.
 *
 * The pre-fix interface was four OPTIONAL numbers, so `const limits:
 * NodeBudgetLimits = raw` compiled for a raw `Record<string, unknown>` and the
 * budget API (`hasBudgetLimits`, `budgetOverrunsOf`, the report builder) could
 * not require that `nodeBudgetLimitsOf` — the only reader that turns raw limits
 * into checked ones — had run. The fix brands the reader's output with a
 * module-private `unique symbol`, so only a value that came out of the reader
 * (or was extended from one) is a `NodeBudgetLimits`.
 *
 * WHY THIS FILE EXISTS. `bun test` is transpile-only, so the pre-fix probe
 * (`.rolebox/evidence/graph-type-audit/probe-index-to-optional.ts`) COMPILED
 * and its two assignments were exactly the defect. The authority for every
 * `expectTypeOf` pin below is `bun run typecheck:tests`; the runtime cases
 * beside them pin that a declared budget still reads and reserves exactly as it
 * did — the fix is type-level, and no persisted column, SQL or value moved.
 *
 * @module
 */

import { afterEach, describe, expect, expectTypeOf, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTempTrees } from "./helpers/temp-dirs.ts";
import {
  budgetOverrunsOf,
  hasBudgetLimits,
  nodeBudgetLimitsOf,
  type BudgetUsageAmounts,
  type NodeBudgetLimits,
  type NodeBudgetSpec,
} from "../../src/graph/domain/budget.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";

const GRAPH = "budget.limits-type-guards";
const RUN = "run-1";
const NODE = "work";
const ATTEMPT = "work#1";
const NOW = 1_700_000_000_000;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  removeTempTrees(tmpDirs);
});

describe("F-24 — only the reader produces NodeBudgetLimits", () => {
  it("refuses a raw record and the old all-optional shape at the type level", () => {
    // The audit's probe: this assignment compiled before the fix.
    expectTypeOf<Record<string, unknown>>().not.toExtend<NodeBudgetLimits>();
    // The pre-fix interface, spelled out: also accepted before the fix.
    expectTypeOf<{
      readonly durationMs?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
    }>().not.toExtend<NodeBudgetLimits>();
    // A partial literal — the most plausible way a caller used to invent one.
    expectTypeOf<{ readonly inputTokens: number }>().not.toExtend<NodeBudgetLimits>();
    // Even a COMPLETE ceiling literal is not a reading.
    expectTypeOf<{
      readonly durationMs: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
    }>().not.toExtend<NodeBudgetLimits>();
    // The other half of A-10: the reader's own input is UNTRUSTED, so that a
    // spec which merely looks like a limit bag is read rather than believed.
    expectTypeOf<Parameters<typeof nodeBudgetLimitsOf>[0]>().toEqualTypeOf<unknown>();
  });

  it("accepts what the reader returns, and still refuses an unmodelled raw spec", () => {
    const reading = nodeBudgetLimitsOf({ max_input_tokens: 1000, timeout_ms: 5, max_cost_usd: 0.5 });
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") return;
    expectTypeOf(reading.limits).toEqualTypeOf<NodeBudgetLimits>();
    expect(hasBudgetLimits(reading.limits)).toBe(true);
    expect(reading.limits.inputTokens).toBe(1000);
    expect(reading.limits.durationMs).toBe(5);
    expect(reading.limits.costUsd).toBe(0.5);
    // The brand is compile-time only: the value carries exactly the three
    // declared ceilings, nothing added and nothing renamed.
    expect(Object.keys(reading.limits).sort()).toEqual(["costUsd", "durationMs", "inputTokens"]);

    // A raw record still reaches the READER — and is refused by name there.
    const raw: Record<string, unknown> = { max_wall_ms: 1 };
    const refused = nodeBudgetLimitsOf(raw);
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.refusal.key).toBe("max_wall_ms");

    // The declared spec type keeps flowing in, and an empty spec reads empty.
    const spec: NodeBudgetSpec = { max_output_tokens: 7 };
    const fromSpec = nodeBudgetLimitsOf(spec);
    expect(fromSpec.kind).toBe("ok");
    if (fromSpec.kind !== "ok") return;
    expect(fromSpec.limits.outputTokens).toBe(7);
    expect(Object.keys(fromSpec.limits)).toEqual(["outputTokens"]);
    const none = nodeBudgetLimitsOf(undefined);
    expect(none.kind).toBe("ok");
    if (none.kind !== "ok") return;
    expect(hasBudgetLimits(none.limits)).toBe(false);
    expect(Object.keys(none.limits)).toEqual([]);
  });

  it("still reads, reserves and reports a declared budget exactly", () => {
    const root = makeTmpDir("budget-limits-guards-");
    const store = GraphStore.openFile(root);
    try {
      store.transaction((tx) => {
        tx.runs?.mintRun({ graphId: GRAPH, runId: RUN, startedAt: NOW, planRevision: "plan-1" });
      });
      const reading = nodeBudgetLimitsOf({ max_input_tokens: 1000 });
      expect(reading.kind).toBe("ok");
      if (reading.kind !== "ok") return;

      const claimed = store.budget.reserveDispatch({
        graphId: GRAPH,
        runId: RUN,
        nodeId: NODE,
        attemptId: ATTEMPT,
        effectId: "dispatch:" + ATTEMPT,
        limits: reading.limits,
        at: NOW + 1,
      });
      expect(claimed.kind).toBe("reserved");
      if (claimed.kind !== "reserved") return;
      // The ceilings the claim was checked against survive the round trip, and
      // the claim reserved exactly the declared amount.
      expect(claimed.reservation.checked).toEqual(reading.limits);
      expect(claimed.reservation.reserved.inputTokens).toBe(1000);
      expect(claimed.reservation.reserved.executions).toBe(1);

      const row = store.budget.readReservation(GRAPH, ATTEMPT, RUN);
      expect(row?.checked).toEqual(reading.limits);
      expect(row?.reserved.inputTokens).toBe(1000);

      // The overrun is the ACTUAL excess, recomputed from the same ceiling.
      const used: BudgetUsageAmounts = {
        executions: 1,
        durationMs: 0,
        inputTokens: 1600,
        outputTokens: 0,
        costUsd: 0,
      };
      expect(budgetOverrunsOf(NODE, reading.limits, used)).toEqual([
        { nodeId: NODE, kind: "input_tokens", limit: 1000, used: 1600, overBy: 600 },
      ]);
      expect(budgetOverrunsOf(NODE, reading.limits, { ...used, inputTokens: 1000 })).toEqual([]);
    } finally {
      store.close();
    }
  });
});

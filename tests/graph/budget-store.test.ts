/**
 * P3 item 3 — THE DURABLE DISPATCH BUDGET (store level)
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR. A dispatch's share of its node's declared
 * ceiling is claimed by ONE conditional write in the workspace's store, so two
 * dispatches racing for the last unit cannot both be authorized; the claim
 * survives a restart; reconciling it against the REAL usage records the actual
 * amount exactly once; a delayed bill is APPENDED rather than dropped; and a
 * report recomputes the ACTUAL overrun instead of clamping or absorbing it.
 *
 * THE SUBSTRATE IS THE SHIPPED ONE: the real GraphStore over a temp directory,
 * addressed through the same `budget` surface the ledger port exposes.
 *
 * STRENGTH: pure/unit + real store (one process). The RACE across real OS
 * processes is in `budget-restart-cross-process.test.ts`; nothing here is
 * real-host evidence.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGraphDeclarationV3 } from "../../src/graph/compiler/parse-declaration-v3.ts";
import {
  buildBudgetReport,
  nodeBudgetLimitsOf,
  type NodeBudgetLimits,
  type NodeBudgetSpec,
} from "../../src/graph/domain/budget.ts";
import type { BudgetLedger } from "../../src/graph/ledger/types.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";

const GRAPH = "budget.store";
const RUN = "run-1";
const NOW = 1_700_000_000_000;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/**
 * One budget transaction over the shipped store.
 *
 * The port's budget surface is OPTIONAL (a focused test double need not hold
 * claims), so the shipped store's own surface is narrowed ONCE here rather than
 * at every call: this fixture is about the real store, where the surface is
 * always installed.
 */
function withBudget<R>(store: GraphStore, work: (budget: BudgetLedger) => R): R {
  return store.transaction((tx) => {
    const budget = tx.budget;
    if (budget === undefined) {
      throw new Error("fixture: the shipped store exposes no budget surface");
    }
    return work(budget);
  });
}

/** One store with a minted run, as the run path leaves it before dispatching. */
function openStoreWithRun(): { readonly store: GraphStore; readonly root: string } {
  const root = makeTmpDir("budget-store-");
  const store = GraphStore.openFile(root);
  store.transaction((tx) => {
    tx.runs?.mintRun({
      graphId: GRAPH,
      runId: RUN,
      startedAt: NOW,
      planRevision: "plan-1",
    });
  });
  return { store, root };
}

/** One reservation input, with the amounts the case cares about. */
function reserveInput(
  attemptId: string,
  limits: NodeBudgetLimits,
  at = NOW + 1,
): Parameters<GraphStore["budget"]["reserveDispatch"]>[0] {
  return {
    graphId: GRAPH,
    runId: RUN,
    nodeId: "work",
    attemptId,
    effectId: "dispatch:" + attemptId,
    limits,
    at,
  };
}

/** One usage input with every accounting field filled. */
function usageInput(
  attemptId: string,
  usage: {
    readonly executions?: number;
    readonly durationMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  },
  at = NOW + 2,
): Parameters<GraphStore["budget"]["reconcileUsage"]>[0] {
  return {
    graphId: GRAPH,
    runId: RUN,
    nodeId: "work",
    attemptId,
    effectId: "dispatch:" + attemptId,
    usage: {
      ...(usage.executions === undefined ? {} : { executions: usage.executions }),
      durationMs: usage.durationMs ?? 0,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: usage.costUsd ?? 0,
    },
    at,
  };
}

describe("the dispatch budget — the claim is the conditional write", () => {
  it("reserves what is LEFT of each declared ceiling, and replays the same attempt", () => {
    const { store } = openStoreWithRun();
    try {
      const first = withBudget(store, (budget) =>
        budget.reserveDispatch(
          reserveInput("work#1", { inputTokens: 1000 }),
        ),
      );
      expect(first.kind).toBe("reserved");
      if (first.kind !== "reserved") return;
      expect(first.reservation.status).toBe("reserved");
      expect(first.reservation.checked.inputTokens).toBe(1000);
      expect(first.reservation.reserved.inputTokens).toBe(1000);
      // The execution COUNT is claimed even where no ceiling exists for it.
      expect(first.reservation.reserved.executions).toBe(1);

      // The SAME attempt is the idempotency key: nothing is claimed twice.
      const replay = withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000 }, NOW + 2)),
      );
      expect(replay.kind).toBe("replayed");
      if (replay.kind !== "replayed") return;
      expect(replay.reservation.reservedAt).toBe(NOW + 1);
      expect(
        store.budget.reservationsOf(GRAPH, RUN).length,
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  it("authorizes at most one dispatch against the last unit of a ceiling", () => {
    const { store } = openStoreWithRun();
    try {
      const first = withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000 })),
      );
      expect(first.kind).toBe("reserved");
      // A SECOND dispatch of the same node has no headroom: the first claim owns
      // the whole remaining ceiling because one attempt may consume all of it.
      const second = withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#2", { inputTokens: 1000 }, NOW + 2)),
      );
      expect(second.kind).toBe("exhausted");
      if (second.kind !== "exhausted") return;
      expect(second.exhausted.map((entry) => entry.kind)).toEqual(["input_tokens"]);
      expect(second.exhausted[0]?.limit).toBe(1000);
      expect(second.exhausted[0]?.committed).toBe(1000);
      // NOTHING was written for the refused dispatch.
      expect(
        store.budget.reservationsOf(GRAPH, RUN).map((row) => row.attemptId),
      ).toEqual(["work#1"]);
    } finally {
      store.close();
    }
  });

  it("reconciles against real usage exactly once, and frees the unspent remainder", () => {
    const { store } = openStoreWithRun();
    try {
      withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000 })),
      );
      // BEFORE reconciliation: the whole ceiling is claimed, usage is zero.
      const before = store.budget.budgetUsageOf(GRAPH, RUN);
      expect(before[0]?.reserved.inputTokens).toBe(1000);
      expect(before[0]?.used.inputTokens).toBe(0);
      expect(before[0]?.executions).toBe(1);

      const settled = withBudget(store, (budget) =>
        budget.reconcileUsage(usageInput("work#1", { inputTokens: 300 })),
      );
      expect(settled.kind).toBe("reconciled");
      // AFTER: the claim moved into usage; it is NOT still reserved, and it is
      // NOT counted twice (300, never 1300).
      const after = store.budget.budgetUsageOf(GRAPH, RUN);
      expect(after[0]?.reserved.inputTokens).toBe(0);
      expect(after[0]?.used.inputTokens).toBe(300);
      expect(after[0]?.executions).toBe(1);

      // The NEXT dispatch claims what is left (1000 - 300), not the ceiling.
      const next = withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#2", { inputTokens: 1000 }, NOW + 3)),
      );
      expect(next.kind).toBe("reserved");
      if (next.kind !== "reserved") return;
      expect(next.reservation.reserved.inputTokens).toBe(700);
    } finally {
      store.close();
    }
  });

  it("answers a repeated report as the replay, and a competing one as the standing fact", () => {
    const { store } = openStoreWithRun();
    try {
      withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000 })),
      );
      withBudget(store, (budget) =>
        budget.reconcileUsage(usageInput("work#1", { inputTokens: 300, costUsd: 0.5 })),
      );
      const replay = withBudget(store, (budget) =>
        budget.reconcileUsage(usageInput("work#1", { inputTokens: 300, costUsd: 0.5 }, NOW + 3)),
      );
      expect(replay.kind).toBe("replayed");

      const competing = withBudget(store, (budget) =>
        budget.reconcileUsage(usageInput("work#1", { inputTokens: 900 }, NOW + 4)),
      );
      expect(competing.kind).toBe("ignored");
      if (competing.kind !== "ignored") return;
      expect(competing.reservation.used?.inputTokens).toBe(300);
      expect(competing.reason).toContain("double count");
      const usage = store.budget.budgetUsageOf(GRAPH, RUN);
      expect(usage[0]?.used.inputTokens).toBe(300);
    } finally {
      store.close();
    }
  });

  it("records a delayed bill for an attempt it never reserved, without clamping", () => {
    const { store } = openStoreWithRun();
    try {
      const late = withBudget(store, (budget) =>
        budget.reconcileUsage(
          usageInput("work#7", { inputTokens: 5000, costUsd: 12.5, durationMs: 900 }),
        ),
      );
      expect(late.kind).toBe("recorded-late");
      if (late.kind !== "recorded-late") return;
      expect(late.reservation.checked).toEqual({});
      expect(late.reservation.reserved.executions).toBe(0);
      expect(late.reservation.used?.inputTokens).toBe(5000);
      expect(late.reservation.used?.costUsd).toBe(12.5);

      const usage = store.budget.budgetUsageOf(GRAPH, RUN);
      expect(usage[0]?.used.inputTokens).toBe(5000);
      expect(usage[0]?.used.costUsd).toBe(12.5);
      expect(usage[0]?.executions).toBe(1);
    } finally {
      store.close();
    }
  });

  it("releases a claim of a finished attempt, keeps its count, and still accepts a later bill", () => {
    const { store } = openStoreWithRun();
    try {
      withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000 })),
      );
      const released = withBudget(store, (budget) =>
        budget.releaseReservation({
          graphId: GRAPH,
          runId: RUN,
          nodeId: "work",
          attemptId: "work#1",
          at: NOW + 5,
        }),
      );
      expect(released.kind).toBe("released");
      const afterRelease = store.budget.budgetUsageOf(GRAPH, RUN);
      // The execution is COUNTED (it was dispatched); its consumption is UNKNOWN,
      // not zero: nothing was recorded as used and the claim no longer blocks.
      expect(afterRelease[0]?.executions).toBe(1);
      expect(afterRelease[0]?.reserved.inputTokens).toBe(0);
      expect(afterRelease[0]?.used.inputTokens).toBe(0);
      expect(afterRelease[0]?.unknownUsageAttempts).toBe(1);
      // The freed budget is available again.
      const next = withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#2", { inputTokens: 1000 }, NOW + 6)),
      );
      expect(next.kind).toBe("reserved");

      // DELAYED BILLING after the release still lands, and can exceed the ceiling.
      const late = withBudget(store, (budget) =>
        budget.reconcileUsage(usageInput("work#1", { inputTokens: 1500 }, NOW + 7)),
      );
      expect(late.kind).toBe("reconciled");
      const usage = store.budget.budgetUsageOf(GRAPH, RUN);
      const work = usage.find((entry) => entry.nodeId === "work");
      expect(work?.used.inputTokens).toBe(1500);
      expect(work?.unknownUsageAttempts).toBe(0);

      // A release of a RECONCILED row is the replay of the fact that stands: it
      // never erases recorded usage.
      const reReleased = withBudget(store, (budget) =>
        budget.releaseReservation({
          graphId: GRAPH,
          runId: RUN,
          nodeId: "work",
          attemptId: "work#1",
          at: NOW + 8,
        }),
      );
      expect(reReleased.kind).toBe("replayed");
      if (reReleased.kind !== "replayed") return;
      expect(reReleased.reservation.status).toBe("reconciled");
      expect(reReleased.reservation.used?.inputTokens).toBe(1500);
    } finally {
      store.close();
    }
  });

  it("reports the ACTUAL overrun from the recorded rows, never a clamped one", () => {
    const { store } = openStoreWithRun();
    try {
      withBudget(store, (budget) =>
        budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000, costUsd: 1 })),
      );
      withBudget(store, (budget) =>
        budget.reconcileUsage(
          usageInput("work#1", { inputTokens: 1500, costUsd: 1.25, durationMs: 7000 }),
        ),
      );
      const report = buildBudgetReport({
        graphId: GRAPH,
        runId: RUN,
        planRevision: "plan-1",
        nodes: [
          { nodeId: "work", limits: { inputTokens: 1000, costUsd: 1, durationMs: 5000 } },
        ],
        usage: store.budget.budgetUsageOf(GRAPH, RUN),
      });
      expect(report.overruns.map((entry) => entry.kind).sort()).toEqual([
        "cost_usd",
        "duration_ms",
        "input_tokens",
      ]);
      const tokens = report.overruns.find((entry) => entry.kind === "input_tokens");
      expect(tokens?.limit).toBe(1000);
      expect(tokens?.used).toBe(1500);
      expect(tokens?.overBy).toBe(500);
      const cost = report.overruns.find((entry) => entry.kind === "cost_usd");
      expect(cost?.overBy).toBeCloseTo(0.25, 10);
      // The DURABLE ROW carries both numbers, so the overrun is readable from the
      // record itself and not only from the derived report.
      const row = store.budget.readReservation(GRAPH, "work#1", RUN);
      expect(row?.checked.inputTokens).toBe(1000);
      expect(row?.used?.inputTokens).toBe(1500);
    } finally {
      store.close();
    }
  });

  it("keeps every claim and every recorded amount across a close and reopen", () => {
    const root = makeTmpDir("budget-store-reopen-");
    const first = GraphStore.openFile(root);
    first.transaction((tx) => {
      tx.runs?.mintRun({ graphId: GRAPH, runId: RUN, startedAt: NOW, planRevision: "plan-1" });
    });
    withBudget(first, (budget) =>
      budget.reserveDispatch(reserveInput("work#1", { inputTokens: 1000 })),
    );
    withBudget(first, (budget) =>
      budget.reconcileUsage(usageInput("work#1", { inputTokens: 400 }, NOW + 9)),
    );
    first.close();

    const second = GraphStore.openFile(root);
    try {
      const usage = second.budget.budgetUsageOf(GRAPH, RUN);
      expect(usage[0]?.used.inputTokens).toBe(400);
      expect(usage[0]?.executions).toBe(1);
      const row = second.budget.readReservation(GRAPH, "work#1", RUN);
      expect(row?.status).toBe("reconciled");
      expect(row?.used?.inputTokens).toBe(400);
    } finally {
      second.close();
    }
  });

  it("refuses a run that is not the graph's current one", () => {
    const { store } = openStoreWithRun();
    try {
      expect(() =>
        withBudget(store, (budget) =>
          budget.reserveDispatch({
            ...reserveInput("work#1", { inputTokens: 1000 }),
            runId: "run-other",
          }),
        ),
      ).toThrow(/not the graph's CURRENT run/);
      expect(store.budget.reservationsOf(GRAPH, RUN).length).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("the dispatch budget — which limits a plan authorizes", () => {
  it("reads exactly the four ceiling dimensions, and ignores max_retries", () => {
    const reading = nodeBudgetLimitsOf({
      max_input_tokens: 10,
      max_output_tokens: 20,
      max_cost_usd: 0.5,
      timeout_ms: 1000,
      max_retries: 2,
    });
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") return;
    expect(reading.limits).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.5,
      durationMs: 1000,
    });
  });

  it("refuses a limit key the v3 grammar never authorizes instead of defaulting it", () => {
    // The grammar refuses this key at the declaration boundary (checked below).
    // This is the SECOND boundary: a spec reaching the runtime or the control
    // path from any other writer is refused by name rather than silently
    // ignored and never defaulted into "unlimited".
    const spec: NodeBudgetSpec = JSON.parse('{"max_executions":5,"max_input_tokens":10}');
    const reading = nodeBudgetLimitsOf(spec);
    expect(reading.kind).toBe("refused");
    if (reading.kind !== "refused") return;
    expect(reading.refusal.code).toBe("budget-limit-unauthorized");
    expect(reading.refusal.key).toBe("max_executions");
  });

  it("has the declaration grammar refuse an execution-count ceiling by name", () => {
    const parsed = parseGraphDeclarationV3({
      version: 3,
      name: "budget.undeclared-limit",
      nodes: [
        {
          id: "work",
          agent: "agent.work",
          prompt: "Do the work.",
          outcomes: [{ id: "done" }],
          budget: { max_executions: 3 },
        },
      ],
      edges: [],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((issue) => issue.message.includes("max_executions"))).toBe(true);
    expect(parsed.errors.every((issue) => issue.path.startsWith("$"))).toBe(true);
  });
});

describe("the dispatch budget — the format gate", () => {
  it("refuses a store that predates the budget table", () => {
    const root = makeTmpDir("budget-store-old-format-");
    const store = GraphStore.openFile(root);
    store.close();
    // A version-5 file holds no reservation row, so it cannot answer "is this
    // dispatch's share already claimed?" — it is refused by name.
    const raw = GraphStore.openFile(root);
    raw.run(
      "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = 5 WHERE id = 1",
    );
    raw.close();
    expect(() => GraphStore.openFile(root)).toThrow(/format/);
  });
});

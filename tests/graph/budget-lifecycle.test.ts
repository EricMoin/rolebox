/**
 * P3 item 3 — THE DISPATCH BUDGET THROUGH THE SHIPPED RUN PATH AND CONTROL ENTRY
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR (plan §4 P3 budget, §5 A13):
 *
 * - a dispatch is CLAIMED against the node's declared ceilings inside the same
 *   transaction that arms it, and the claim is visible in the run's report;
 * - reconciliation against the platform's REAL usage moves the claim into usage
 *   exactly once — the counter after reserve -> reconcile is the reported amount,
 *   never the reservation plus the amount;
 * - a DELAYED bill that exceeds the ceiling is recorded as reported and the
 *   report shows the ACTUAL overrun, never a clamped one;
 * - an over-limit node stops NEW dispatch: a successor that cannot be claimed
 *   refuses the acceptance that would arm it, and a start whose entry cannot be
 *   claimed writes nothing at all;
 * - `budget-stop` is a real trusted control command through the SAME
 *   permissioned entry the other commands use: it claims the run's control fact,
 *   names the in-flight attempts, carries the run's budget state, and a repeated
 *   command replays;
 * - a worker's submission cannot forge usage or raise a ceiling.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real OutcomeHost over the workspace's one
 * SQLite store, the real `createGraphToolSet`, and the `graph_control` /
 * `graph_submit_outcome` tools bound by the very `OutcomeHost.bindTools` both
 * entries call.
 *
 * STRENGTH: adapter + real store, process-level. The cross-process restart and
 * the two-process race are in `budget-restart-cross-process.test.ts`; nothing
 * here is real-host evidence (no dsh/Pi SDK runs in this environment).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { BudgetReport } from "../../src/graph/domain/budget.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** ONE entry node whose declared ceiling is the whole budget of the test. */
const BUDGETED_ENTRY: GraphDeclarationV3 = {
  version: 3,
  name: "budget.entry",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done" }],
      budget: { max_input_tokens: 1000 },
    },
  ],
  edges: [],
};

/** work -> review, with the ceiling on the SUCCESSOR the acceptance arms. */
const BUDGETED_REVIEW: GraphDeclarationV3 = {
  version: 3,
  name: "budget.review",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "approve" }],
      budget: { max_input_tokens: 1000 },
    },
  ],
  edges: [{ from: "work", to: "review", outcome: "done" }],
};

/** A single entry node with NO headroom at all: the start cannot be claimed. */
const ZERO_ENTRY: GraphDeclarationV3 = {
  version: 3,
  name: "budget.zero-entry",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done" }],
      budget: { max_input_tokens: 0 },
    },
  ],
  edges: [],
};

/** work -> review, where the successor has no headroom when it is armed. */
const ZERO_SUCCESSOR: GraphDeclarationV3 = {
  version: 3,
  name: "budget.zero-successor",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "approve" }],
      budget: { max_input_tokens: 0 },
    },
  ],
  edges: [{ from: "work", to: "review", outcome: "done" }],
};

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

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

function makeContext(
  sessionID: string,
  agent: string,
  directory: string,
): CanonicalToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent,
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

interface BudgetFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatched: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly declarer: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

/** The shipped host assembly over one REAL declared graph, optionally started. */
async function openBudgetFixture(
  declaration: GraphDeclarationV3,
  options: { readonly start?: boolean } = {},
): Promise<BudgetFixture> {
  const dir = makeTmpDir("budget-lifecycle-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: dir,
    outcomeNow: NOW,
  });
  const fixture: BudgetFixture = {
    dir,
    storeRoot,
    host: opened,
    tools: opened.bindTools(createOutcomeGraphTools(toolset)),
    dispatched,
    graphId: declaration.name,
    declarer: "session.declarer",
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
  };
  const declared = String(
    await fixture.tools.graph_declare?.execute(
      { declaration },
      fixture.contextOf(fixture.declarer, "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("budget fixture: graph_declare refused: " + declared);
  }
  if (options.start !== false) {
    const started = await opened.startDeclaredGraph(declaration.name, {
      sessionId: fixture.declarer,
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("budget fixture: the graph did not start (" + started.kind + ")");
    }
  }
  return fixture;
}

/** One control answer, as the shipped tool renders it. */
interface ControlAnswer {
  readonly kind?: "applied" | "refused";
  readonly command?: string;
  readonly scope?: string;
  readonly refusals?: readonly { readonly code?: string; readonly message?: string }[];
  readonly decided?: readonly {
    readonly nodeId?: string;
    readonly attemptId?: string;
    readonly replayed?: boolean;
  }[];
  readonly runControl?: { readonly command?: string; readonly reason?: string };
  readonly unsettledEffects?: readonly { readonly effectId?: string }[];
  readonly budget?: BudgetReport;
}

/** Run one control command through the SHIPPED tool face. */
async function control(
  fixture: BudgetFixture,
  args: Record<string, unknown>,
  sessionID: string = fixture.declarer,
): Promise<ControlAnswer> {
  const raw = String(
    await fixture.tools.graph_control?.execute(
      args,
      fixture.contextOf(sessionID, "agent.declarer"),
    ),
  );
  return JSON.parse(raw) as ControlAnswer;
}

/** Submit one node's outcome through the SHIPPED ingress. */
async function submitOutcome(
  fixture: BudgetFixture,
  input: {
    readonly nodeId: string;
    readonly outcomeId: string;
    readonly data?: unknown;
  },
): Promise<{
  readonly decision?: string;
  readonly refusals?: readonly { readonly code?: string; readonly message?: string }[];
}> {
  const request = fixture.dispatched.find((entry) => entry.nodeId === input.nodeId);
  if (request === undefined) {
    throw new Error("budget fixture: no dispatch was recorded for " + input.nodeId);
  }
  const raw = String(
    await fixture.tools.graph_submit_outcome?.execute(
      {
        graph_id: fixture.graphId,
        node_id: input.nodeId,
        outcome_id: input.outcomeId,
        credential: request.credential,
        ...(input.data === undefined ? {} : { data: input.data }),
      },
      fixture.contextOf(childSessionOf(request.attemptId), "agent.worker"),
    ),
  );
  return JSON.parse(raw) as {
    readonly decision?: string;
    readonly refusals?: readonly { readonly code?: string }[];
  };
}

/** A fresh connection to the fixture's store. */
function storeOf(fixture: BudgetFixture): GraphStore {
  return GraphStore.openFile(fixture.storeRoot);
}

/** One table's row count, read with a fresh connection. */
function countOf(fixture: BudgetFixture, table: string): number {
  const store = storeOf(fixture);
  try {
    const row = store.all("SELECT COUNT(*) AS n FROM " + table)[0];
    const value = row?.["n"];
    return typeof value === "number" ? value : -1;
  } finally {
    store.close();
  }
}

/** The report of a reading that MUST have succeeded. */
function reportOf(reading: Awaited<ReturnType<OutcomeHost["budgetReportOf"]>>): BudgetReport {
  if (reading.kind !== "report") {
    throw new Error("budget fixture: the report was refused: " + reading.refusal.message);
  }
  return reading.report;
}

// ── The reserve half ────────────────────────────────────────────────────────

describe("the dispatch budget — reserve before dispatch", () => {
  it("claims the entry dispatch's share of the ceiling inside the arming transaction", async () => {
    const fixture = await openBudgetFixture(BUDGETED_ENTRY);
    try {
      const store = storeOf(fixture);
      try {
        const row = store.budget.readReservation(fixture.graphId, "work#1");
        expect(row?.status).toBe("reserved");
        expect(row?.nodeId).toBe("work");
        expect(row?.checked.inputTokens).toBe(1000);
        expect(row?.reserved.inputTokens).toBe(1000);
        expect(row?.reserved.executions).toBe(1);
      } finally {
        store.close();
      }

      const report = reportOf(await fixture.host.budgetReportOf(fixture.graphId));
      expect(report.planRevision.length).toBeGreaterThan(0);
      expect(report.nodes.map((node) => node.nodeId)).toEqual(["work"]);
      const work = report.nodes[0];
      expect(work?.limits.inputTokens).toBe(1000);
      expect(work?.executions).toBe(1);
      expect(work?.used.inputTokens).toBe(0);
      expect(work?.reserved.inputTokens).toBe(1000);
      expect(work?.unknownUsageAttempts).toBe(0);
      expect(report.overruns).toEqual([]);
      expect(report.totals.executions).toBe(1);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses the start of a graph whose entry node has no headroom, writing nothing", async () => {
    const fixture = await openBudgetFixture(ZERO_ENTRY, { start: false });
    try {
      const started = await fixture.host.startDeclaredGraph(fixture.graphId, {
        sessionId: fixture.declarer,
      });
      expect(started.kind).toBe("refused");
      if (started.kind !== "refused") return;
      expect(started.refusals[0]?.code).toBe("budget-exhausted");
      expect(started.refusals[0]?.message).toContain("input_tokens");
      // NOTHING survived the rolled-back transaction.
      expect(countOf(fixture, GRAPH_STORE_TABLES.runs)).toBe(0);
      expect(countOf(fixture, GRAPH_STORE_TABLES.graphState)).toBe(0);
      expect(countOf(fixture, GRAPH_STORE_TABLES.pendingEffects)).toBe(0);
      expect(countOf(fixture, GRAPH_STORE_TABLES.budgetReservations)).toBe(0);
      expect(countOf(fixture, GRAPH_STORE_TABLES.credentials)).toBe(0);
      expect(fixture.dispatched.length).toBe(0);
    } finally {
      fixture.host.close();
    }
  });

  it("stops arming a successor when its ceiling has no headroom, refusing the acceptance whole", async () => {
    const fixture = await openBudgetFixture(ZERO_SUCCESSOR);
    try {
      const submitted = await submitOutcome(fixture, { nodeId: "work", outcomeId: "done" });
      expect(submitted.decision).toBeUndefined();
      expect(submitted.refusals?.[0]?.code).toBe("budget-exhausted");
      // The upstream acceptance did NOT commit: no receipt, no accepted event, no
      // state advance and no successor effect.
      expect(countOf(fixture, GRAPH_STORE_TABLES.receipts)).toBe(0);
      expect(countOf(fixture, GRAPH_STORE_TABLES.acceptedEvents)).toBe(0);
      const store = storeOf(fixture);
      try {
        const state = store.readGraphState(fixture.graphId);
        const body = state?.body as { readonly nodes?: readonly { readonly nodeId?: string; readonly status?: string }[] } | undefined;
        expect(body?.nodes?.find((node) => node.nodeId === "work")?.status).toBe("dispatched");
        expect(body?.nodes?.find((node) => node.nodeId === "review")?.status).toBe("pending");
        expect(store.pendingEffects(fixture.graphId).map((effect) => effect.effectId)).toEqual([
          "dispatch:work#1",
        ]);
        // The settled feeder's own claim was rolled back with the transaction:
        // releasing it is part of the acceptance that did not commit.
        expect(store.budget.readReservation(fixture.graphId, "work#1")?.status).toBe("reserved");
      } finally {
        store.close();
      }
      expect(fixture.dispatched.map((request) => request.nodeId)).toEqual(["work"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The reconcile half ──────────────────────────────────────────────────────

describe("the dispatch budget — reconcile against real usage", () => {
  it("moves the claim into usage exactly once, and never double counts it", async () => {
    const fixture = await openBudgetFixture(BUDGETED_ENTRY);
    try {
      const first = await fixture.host.recordBudgetUsage(fixture.graphId, {
        attempts: [
          {
            nodeId: "work",
            attemptId: "work#1",
            inputTokens: 300,
            outputTokens: 40,
            costUsd: 0.25,
            durationMs: 1200,
          },
        ],
        now: NOW + 10,
      });
      expect(first.kind).toBe("recorded");
      if (first.kind !== "recorded") return;
      expect(first.entries[0]?.outcome).toBe("reconciled");
      const work = first.report.nodes[0];
      // AFTER reserve -> reconcile the counter is the REPORTED amount, not the
      // reservation plus the amount.
      expect(work?.used.inputTokens).toBe(300);
      expect(work?.used.outputTokens).toBe(40);
      expect(work?.used.costUsd).toBe(0.25);
      expect(work?.used.durationMs).toBe(1200);
      expect(work?.reserved.inputTokens).toBe(0);
      expect(work?.executions).toBe(1);
      expect(work?.unknownUsageAttempts).toBe(0);

      const repeated = await fixture.host.recordBudgetUsage(fixture.graphId, {
        attempts: [
          {
            nodeId: "work",
            attemptId: "work#1",
            inputTokens: 300,
            outputTokens: 40,
            costUsd: 0.25,
            durationMs: 1200,
          },
        ],
        now: NOW + 11,
      });
      expect(repeated.kind).toBe("recorded");
      if (repeated.kind !== "recorded") return;
      expect(repeated.entries[0]?.outcome).toBe("replayed");
      expect(repeated.report.nodes[0]?.used.inputTokens).toBe(300);

      const competing = await fixture.host.recordBudgetUsage(fixture.graphId, {
        attempts: [{ nodeId: "work", attemptId: "work#1", inputTokens: 900 }],
        now: NOW + 12,
      });
      expect(competing.kind).toBe("recorded");
      if (competing.kind !== "recorded") return;
      expect(competing.entries[0]?.outcome).toBe("ignored");
      expect(competing.report.nodes[0]?.used.inputTokens).toBe(300);
    } finally {
      fixture.host.close();
    }
  });

  it("records a delayed bill that exceeds the ceiling and reports the ACTUAL overrun", async () => {
    const fixture = await openBudgetFixture(BUDGETED_ENTRY);
    try {
      const recorded = await fixture.host.recordBudgetUsage(fixture.graphId, {
        attempts: [{ nodeId: "work", attemptId: "work#1", inputTokens: 1500 }],
        now: NOW + 20,
      });
      expect(recorded.kind).toBe("recorded");
      if (recorded.kind !== "recorded") return;
      const work = recorded.report.nodes[0];
      expect(work?.used.inputTokens).toBe(1500);
      expect(work?.overruns).toEqual([
        {
          nodeId: "work",
          kind: "input_tokens",
          limit: 1000,
          used: 1500,
          overBy: 500,
        },
      ]);
      expect(recorded.report.overruns.map((entry) => entry.overBy)).toEqual([500]);
      // The DURABLE record carries both numbers.
      const store = storeOf(fixture);
      try {
        const row = store.budget.readReservation(fixture.graphId, "work#1");
        expect(row?.checked.inputTokens).toBe(1000);
        expect(row?.used?.inputTokens).toBe(1500);
      } finally {
        store.close();
      }
      // A later read (a fresh connection, as another window sees it) still shows
      // the overrun: nothing absorbed it after the fact.
      const reread = reportOf(await fixture.host.budgetReportOf(fixture.graphId));
      expect(reread.overruns[0]?.overBy).toBe(500);
      expect(reread.totals.inputTokens).toBe(1500);
    } finally {
      fixture.host.close();
    }
  });

  it("cannot be forged by a worker's submission, which moves no usage and no ceiling", async () => {
    const fixture = await openBudgetFixture(BUDGETED_ENTRY);
    try {
      const submitted = await submitOutcome(fixture, {
        nodeId: "work",
        outcomeId: "done",
        data: {
          usage: { inputTokens: 999999, costUsd: 999 },
          budget: { max_input_tokens: 1_000_000 },
          max_input_tokens: 1_000_000,
        },
      });
      expect(submitted.decision).toBe("accepted");
      const report = reportOf(await fixture.host.budgetReportOf(fixture.graphId));
      const work = report.nodes.find((node) => node.nodeId === "work");
      // The declared ceiling is the PLAN's, and no usage was recorded: the
      // payload's claims reached nothing.
      expect(work?.limits.inputTokens).toBe(1000);
      expect(work?.used.inputTokens).toBe(0);
      expect(work?.reserved.inputTokens).toBe(0);
      expect(work?.executions).toBe(1);
      // The settled attempt's claim was RELEASED, not zeroed: its consumption is
      // unknown and is reported as such.
      expect(work?.unknownUsageAttempts).toBe(1);
      expect(report.overruns).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a retry that would claim a second share of a fully-claimed node", async () => {
    const fixture = await openBudgetFixture(BUDGETED_REVIEW);
    try {
      const submitted = await submitOutcome(fixture, { nodeId: "work", outcomeId: "done" });
      expect(submitted.decision).toBe("accepted");
      const before = reportOf(await fixture.host.budgetReportOf(fixture.graphId));
      expect(before.nodes.find((node) => node.nodeId === "review")?.reserved.inputTokens).toBe(
        1000,
      );

      const retried = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        node_id: "review",
        reason: "the attempt looks stuck",
      });
      expect(retried.kind).toBe("refused");
      expect(retried.refusals?.[0]?.code).toBe("budget-exhausted");
      // NOTHING was written: no retry decision, and the in-flight attempt stands.
      const store = storeOf(fixture);
      try {
        expect(
          store.runs
            .controlDecisions(fixture.graphId)
            .filter((decision) => decision.command === "retry").length,
        ).toBe(0);
        const state = store.readGraphState(fixture.graphId);
        const body = state?.body as { readonly nodes?: readonly { readonly nodeId?: string; readonly attemptId?: string }[] } | undefined;
        expect(body?.nodes?.find((node) => node.nodeId === "review")?.attemptId).toBe("review#2");
      } finally {
        store.close();
      }
    } finally {
      fixture.host.close();
    }
  });
});

// ── budget-stop: the trusted control command ────────────────────────────────

describe("the dispatch budget — budget-stop through the one control entry", () => {
  it("stops the run, names the in-flight attempts and carries the budget state", async () => {
    const fixture = await openBudgetFixture(BUDGETED_ENTRY);
    try {
      await fixture.host.recordBudgetUsage(fixture.graphId, {
        attempts: [{ nodeId: "work", attemptId: "work#1", inputTokens: 1500 }],
        now: NOW + 30,
      });
      const answer = await control(fixture, {
        graph_id: fixture.graphId,
        command: "budget-stop",
        reason: "the platform's bill exceeded the declared ceiling",
      });
      expect(answer.kind).toBe("applied");
      expect(answer.command).toBe("budget-stop");
      expect(answer.scope).toBe("run");
      expect(answer.runControl?.command).toBe("budget-stop");
      expect(answer.runControl?.reason).toBe(
        "the platform's bill exceeded the declared ceiling",
      );
      expect(answer.decided?.map((entry) => entry.attemptId)).toEqual(["work#1"]);
      expect(answer.decided?.[0]?.replayed).toBe(false);
      expect(answer.unsettledEffects?.map((effect) => effect.effectId)).toEqual([
        "dispatch:work#1",
      ]);
      // THE ANSWER CARRIES THE ACTUAL OVERRUN: a budget stop never reads as
      // "nothing was overspent".
      expect(answer.budget?.overruns).toHaveLength(1);
      expect(answer.budget?.overruns?.[0]?.overBy).toBe(500);
      expect(answer.budget?.nodes[0]?.limits.inputTokens).toBe(1000);

      // NEW DISPATCH AND SETTLEMENT ARE BOTH STOPPED.
      const submitted = await submitOutcome(fixture, { nodeId: "work", outcomeId: "done" });
      expect(submitted.decision).toBeUndefined();
      expect(submitted.refusals?.[0]?.code).toBe("control-stopped");

      // A REPEATED command replays the run fact that stands.
      const repeated = await control(fixture, {
        graph_id: fixture.graphId,
        command: "budget-stop",
        reason: "stop it again",
      });
      expect(repeated.kind).toBe("applied");
      expect(repeated.runControl?.command).toBe("budget-stop");
      expect(repeated.runControl?.reason).toBe(
        "the platform's bill exceeded the declared ceiling",
      );
      expect(repeated.decided?.[0]?.replayed).toBe(true);
      // ONE decision row for the attempt and ONE run control fact.
      const store = storeOf(fixture);
      try {
        expect(store.runs.controlDecisions(fixture.graphId).length).toBe(1);
        expect(store.runs.readRunControl(fixture.graphId)?.command).toBe("budget-stop");
      } finally {
        store.close();
      }
    } finally {
      fixture.host.close();
    }
  });

  it("is refused for a non-declarer and for a node-scoped call, writing nothing", async () => {
    const fixture = await openBudgetFixture(BUDGETED_ENTRY);
    try {
      const unauthorized = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "budget-stop",
          reason: "not mine to stop",
        },
        "session.someone-else",
      );
      expect(unauthorized.kind).toBe("refused");
      expect(unauthorized.refusals?.[0]?.code).toBe("control-not-authorized");

      const nodeScoped = await control(fixture, {
        graph_id: fixture.graphId,
        command: "budget-stop",
        node_id: "work",
        reason: "name a node on a run-wide command",
      });
      expect(nodeScoped.kind).toBe("refused");
      expect(nodeScoped.refusals?.[0]?.code).toBe("unknown-node");

      const store = storeOf(fixture);
      try {
        expect(store.runs.controlDecisions(fixture.graphId).length).toBe(0);
        expect(store.runs.readRunControl(fixture.graphId)).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      fixture.host.close();
    }
  });
});

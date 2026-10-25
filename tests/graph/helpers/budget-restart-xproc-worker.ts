import { spawnProcess } from "../../../scripts/node-process.ts";

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  nodeBudgetLimitsOf,
  type NodeBudgetLimits,
} from "../../../src/graph/domain/budget.ts";
import { OutcomeHost } from "../../../src/graph/host/outcome-host.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { runGraphControlEntry } from "../../../src/graph/tools/control-entry.ts";

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

/** The one graph this fixture drives: a BUDGETED entry node and a spare node. */
export const BUDGET_RESTART_GRAPH = "budget.restart-xproc";

/** The session that declares the graph and is therefore allowed to control it. */
export const BUDGET_RESTART_DECLARER = "session.declarer-budget";

/** A fixed epoch-ms instant, passed to every process, so nothing reads a clock. */
export const BUDGET_RESTART_AT = 1_700_000_000_000;

/** The declared input-token ceiling of the graph's entry node. */
export const BUDGET_RESTART_LIMIT = 1000;

/** The node the entry attempt runs as. */
export const BUDGET_RESTART_NODE = "work";

/** The node NOTHING dispatches at start: its ceiling is free for the race. */
export const BUDGET_RESTART_RACE_NODE = "spare";

// ── Argument access ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** The value of `--name`, or undefined. */
function arg(name: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The value of `--name`, refused when absent or empty. */
function required(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) {
    throw new Error("budget-restart-xproc-worker: --" + name + " is required");
  }
  return value;
}

/** The epoch-ms instant this process stamps its report with. */
function instant(): number {
  const raw = arg("now");
  const value = raw === undefined ? BUDGET_RESTART_AT : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("budget-restart-xproc-worker: --now must be epoch milliseconds");
  }
  return value;
}

/** Print the ONE report line this worker's parent parses. */
function report(fields: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ pid: process.pid, ok: true, ...fields }));
}

/** Busy-wait for a marker file to APPEAR, bounded by a deadline. */
async function waitForMarker(path: string, deadlineMs: number, what: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(
        "budget-restart-xproc-worker: timed out after " + deadlineMs + "ms waiting for " + what,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * The shipped host assembly over the store this fixture was pointed at.
 *
 * The platform delivery is INSTALLED (a resume of this graph may hand a cancel
 * to it) and confirms the execution it is given, exactly as the parent's own
 * fixture does — so a process that is asked to create something reports the
 * same facts the parent's process would.
 */
function openHost(storeRoot: string, workspaceDir: string): OutcomeHost {
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request, effect) => {
      host?.confirmExecution(effect, { executionId: "child-session:" + request.attemptId });
    },
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    clock: () => BUDGET_RESTART_AT,
  });
  host = opened;
  return opened;
}

/** The parts of a budget report this fixture reports. */
function summarise(report: { readonly nodes: readonly Record<string, unknown>[]; readonly totals: Record<string, unknown>; readonly overruns: readonly Record<string, unknown>[] }): Record<string, unknown> {
  return {
    totals: report.totals,
    overruns: report.overruns,
    nodes: report.nodes.map((node) => ({
      nodeId: node["nodeId"],
      limits: node["limits"],
      executions: node["executions"],
      used: node["used"],
      reserved: node["reserved"],
      unknownUsageAttempts: node["unknownUsageAttempts"],
      overruns: node["overruns"],
    })),
  };
}

/** Read one run's budget state through the host, or throw. */
async function readReport(
  host: OutcomeHost,
  graphId: string,
): Promise<Record<string, unknown>> {
  const reading = await host.budgetReportOf(graphId);
  if (reading.kind !== "report") {
    throw new Error("budget-restart-xproc-worker: the report was refused: " + reading.refusal.message);
  }
  return summarise(reading.report as unknown as Parameters<typeof summarise>[0]);
}

/** The durable reservation row of one attempt, as a plain object. */
function readRow(storeRoot: string, graphId: string, attemptId: string): Record<string, unknown> | undefined {
  const store = GraphStore.openFile(storeRoot);
  try {
    const row = store.budget.readReservation(graphId, attemptId);
    return row === undefined ? undefined : (JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
  } finally {
    store.close();
  }
}

// ── Modes ───────────────────────────────────────────────────────────────────

/** Resume the declared graph in a fresh process and report the claim it found. */
async function resume(storeRoot: string, workspaceDir: string, graphId: string): Promise<void> {
  const host = openHost(storeRoot, workspaceDir);
  try {
    const before = await readReport(host, graphId);
    const resumed = await host.startDeclaredGraph(graphId, {
      sessionId: BUDGET_RESTART_DECLARER,
      agent: "agent.declarer",
    });
    const after = await readReport(host, graphId);
    report({
      mode: "resume",
      kind: resumed.kind,
      refusals:
        resumed.kind === "refused" ? resumed.refusals.map((entry) => entry.code) : [],
      before,
      after,
      row: readRow(storeRoot, graphId, BUDGET_RESTART_NODE + "#1"),
    });
  } finally {
    host.close();
  }
}

/** Record real usage for one attempt, as the platform's bill would arrive. */
async function usage(storeRoot: string, workspaceDir: string, graphId: string): Promise<void> {
  const host = openHost(storeRoot, workspaceDir);
  try {
    const nodeId = arg("node") ?? BUDGET_RESTART_NODE;
    const attemptId = required("attempt");
    const recorded = await host.recordBudgetUsage(graphId, {
      attempts: [
        {
          nodeId,
          attemptId,
          inputTokens: Number(arg("input-tokens") ?? "0"),
          outputTokens: Number(arg("output-tokens") ?? "0"),
          costUsd: Number(arg("cost-usd") ?? "0"),
          durationMs: Number(arg("duration-ms") ?? "0"),
        },
      ],
      now: instant(),
    });
    if (recorded.kind === "refused") {
      throw new Error(
        "budget-restart-xproc-worker: the usage report was refused: " +
          recorded.refusals.map((entry) => entry.code).join(", "),
      );
    }
    report({
      mode: "usage",
      entries: recorded.entries.map((entry) => ({
        nodeId: entry.nodeId,
        attemptId: entry.attemptId,
        outcome: entry.outcome,
        used: entry.used,
      })),
      report: summarise(recorded.report as unknown as Parameters<typeof summarise>[0]),
      row: readRow(storeRoot, graphId, attemptId),
    });
  } finally {
    host.close();
  }
}

/** Apply budget-stop through the SHIPPED control entry, in a fresh process. */
function stop(storeRoot: string, graphId: string): void {
  const answer = runGraphControlEntry(
    { storeDirectory: storeRoot, now: instant() },
    {
      graph_id: graphId,
      command: "budget-stop",
      reason: arg("reason") ?? "the declared budget is spent",
    },
    BUDGET_RESTART_DECLARER,
    "agent.declarer",
  );
  const applied = answer.kind === "applied" ? answer : undefined;
  report({
    mode: "stop",
    kind: answer.kind,
    refusalCode:
      answer.kind === "refused" ? answer.refusals[0]?.code : undefined,
    command: applied?.command,
    scope: applied?.scope,
    runControl: applied?.runControl?.command,
    runControlReason: applied?.runControl?.reason,
    decided: applied?.decided.map((entry) => entry.attemptId),
    unsettledEffects: applied?.unsettledEffects.map((effect) => effect.effectId),
    budget: applied?.budget === undefined ? undefined : summarise(applied.budget as unknown as Parameters<typeof summarise>[0]),
  });
}

/**
 * Race a sibling for one node's last unit of ceiling.
 *
 * The barrier is a pair of marker files: this process writes
 * `ready-<id>.marker` and waits for `go.marker`, which the parent writes only
 * after BOTH siblings signalled ready — so the two claims begin from the same
 * instant and the store's conditional write decides.
 */
async function race(
  storeRoot: string,
  graphId: string,
  nodeId: string,
  id: string,
): Promise<void> {
  const markerDir = required("marker-dir");
  const limit = Number(arg("limit") ?? String(BUDGET_RESTART_LIMIT));
  const deadlineMs = Number(arg("deadline-ms") ?? "30000");
  const store = GraphStore.openFile(storeRoot);
  try {
    const run = store.runs.readRun(graphId);
    if (run === undefined) {
      throw new Error("budget-restart-xproc-worker: the graph has no current run to claim under");
    }
    const attemptId = nodeId + "#race-" + id;
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(markerDir, "ready-" + id + ".marker"), "ready"),
    );
    await waitForMarker(join(markerDir, "go.marker"), deadlineMs, "the parent's go marker");
    // The claim runs in its OWN single transaction (the store's budget surface
    // opens one when no transaction is open), so the barrier below releases two
    // real concurrent claims rather than a check beside a write.
    const claimed = store.budget.reserveDispatch({
      graphId,
      runId: run.runId,
      nodeId,
      attemptId,
      effectId: "dispatch:" + attemptId,
      limits: limitsOf({ inputTokens: limit }),
      at: instant(),
    });
    report({
      mode: "race",
      id,
      kind: claimed.kind,
      attemptId,
      reserved:
        claimed.kind === "reserved" ? claimed.reservation.reserved.inputTokens : undefined,
      exhausted:
        claimed.kind === "exhausted"
          ? claimed.exhausted.map((entry) => ({ kind: entry.kind, limit: entry.limit, committed: entry.committed }))
          : undefined,
    });
  } finally {
    store.close();
  }
}

/** Report the durable facts a later window reads. */
async function read(storeRoot: string, workspaceDir: string, graphId: string): Promise<void> {
  const host = openHost(storeRoot, workspaceDir);
  try {
    report({
      mode: "read",
      report: await readReport(host, graphId),
      row: readRow(storeRoot, graphId, BUDGET_RESTART_NODE + "#1"),
    });
  } finally {
    host.close();
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = required("mode");
  const storeRoot = required("root");
  const graphId = required("graph");
  if (mode === "resume") return resume(storeRoot, required("workspace"), graphId);
  if (mode === "usage") return usage(storeRoot, required("workspace"), graphId);
  if (mode === "stop") return stop(storeRoot, graphId);
  if (mode === "race") return race(storeRoot, graphId, required("node"), required("id"));
  if (mode === "read") return read(storeRoot, required("workspace"), graphId);
  throw new Error("budget-restart-xproc-worker: unknown --mode " + JSON.stringify(mode));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        pid: process.pid,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}

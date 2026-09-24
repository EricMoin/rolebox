/**
 * P3 item 3 — THE DISPATCH BUDGET ACROSS REAL PROCESSES
 * (plan §4 P3 "使用记录可恢复", §5 A13 "并行预算与重启 | 预留/对账不重计；超限停止新派发").
 *
 * WHY THIS FILE EXISTS. The lifecycle cases in budget-lifecycle.test.ts run in
 * ONE process: they prove the claim and the reconciliation are durable rows, but
 * the store object, the connection and the memory are shared. §4 asks for a
 * restart, and §P2 already fixed the shape a restart must take — a REAL process
 * exit and relaunch, never reopening an object.
 *
 * THE SHAPE. Every worker is
 * `Bun.spawn(process.execPath, <this directory>/helpers/budget-restart-xproc-worker.ts, …)`,
 * each prints ONE JSON report, and the parent asserts:
 *
 *   - PROCESS ONE (the parent): declares the graph and starts it. The entry
 *     dispatch's claim is now a row in the workspace's one SQLite store.
 *   - PROCESS TWO (`resume`): a fresh process resumes the declared graph and
 *     reports the claim it found — a restart must NOT re-count a reservation
 *     already made.
 *   - PROCESS THREE (`usage`): reconciles the platform's REAL usage for the
 *     attempt and reports the counters after reserve -> reconcile.
 *   - PROCESS FOUR (`usage`, the same numbers): the repeated report REPLAYS and
 *     adds nothing.
 *   - PROCESS FIVE (`usage` for an attempt the store never reserved): a DELAYED
 *     bill is APPENDED and the report shows the ACTUAL overrun.
 *   - PROCESS SIX (`stop`): `budget-stop` through the SHIPPED control entry, in
 *     yet another process, carrying the overrun in its answer.
 *   - PROCESS SEVEN (`read`): the durable facts a later window sees.
 *   - TWO MORE PROCESSES (`race`) race for one unclaimed node's last unit of
 *     ceiling from a marker barrier: exactly ONE is authorized.
 *
 * NO real-host evidence: real subprocesses over the real workspace SQLite store
 * is this environment's ceiling.
 *
 * PRIVACY. Store roots live under the OS temp directory; every report carries
 * ids, tokens, counts and booleans only — never a credential value, a real
 * home-directory path or a session transcript.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import {
  BUDGET_RESTART_AT,
  BUDGET_RESTART_DECLARER,
  BUDGET_RESTART_GRAPH,
  BUDGET_RESTART_LIMIT,
  BUDGET_RESTART_NODE,
  BUDGET_RESTART_RACE_NODE,
} from "./helpers/budget-restart-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/budget-restart-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;

/** How long the parent waits for both racers to signal ready. */
const BARRIER_DEADLINE_MS = 15_000;

/**
 * THE HARNESS BUDGET MUST EXCEED THIS FILE'S OWN CHILD DEADLINE, exactly as the
 * other cross-process slices carry it: a child that was merely SLOW would
 * otherwise have the CASE killed and its own diagnosis never written.
 */
setDefaultTimeout(CHILD_DEADLINE_MS + 15_000);

/**
 * The declaration: ONE budgeted entry node, plus a SECOND budgeted node that is
 * not an entry (it is armed only when `work` settles), so its ceiling is free
 * for the two-process race.
 */
function declaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: BUDGET_RESTART_GRAPH,
    nodes: [
      {
        id: BUDGET_RESTART_NODE,
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        budget: { max_input_tokens: BUDGET_RESTART_LIMIT },
      },
      {
        id: BUDGET_RESTART_RACE_NODE,
        agent: "agent.spare",
        prompt: "Spare capacity.",
        outcomes: [{ id: "done" }],
        budget: { max_input_tokens: BUDGET_RESTART_LIMIT },
      },
    ],
    edges: [{ from: BUDGET_RESTART_NODE, to: BUDGET_RESTART_RACE_NODE, outcome: "done" }],
  };
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** One child process's parsed report. */
interface WorkerReport {
  readonly ok?: boolean;
  readonly error?: string;
  readonly kind?: string;
  readonly mode?: string;
  readonly totals?: { readonly executions?: number; readonly inputTokens?: number };
  readonly overruns?: readonly { readonly kind?: string; readonly overBy?: number }[];
  readonly nodes?: readonly {
    readonly nodeId?: string;
    readonly executions?: number;
    readonly used?: { readonly inputTokens?: number };
    readonly reserved?: { readonly inputTokens?: number };
    readonly unknownUsageAttempts?: number;
    readonly limits?: { readonly inputTokens?: number };
    readonly overruns?: readonly { readonly overBy?: number }[];
  }[];
  readonly before?: WorkerReport;
  readonly after?: WorkerReport;
  readonly row?: {
    readonly status?: string;
    readonly checked?: { readonly inputTokens?: number };
    readonly used?: { readonly inputTokens?: number };
  };
  readonly entries?: readonly {
    readonly nodeId?: string;
    readonly attemptId?: string;
    readonly outcome?: string;
    readonly used?: { readonly inputTokens?: number };
  }[];
  readonly report?: WorkerReport;
  readonly refusals?: readonly string[];
  readonly refusalCode?: string;
  readonly command?: string;
  readonly scope?: string;
  readonly runControl?: string;
  readonly runControlReason?: string;
  readonly decided?: readonly string[];
  readonly unsettledEffects?: readonly string[];
  readonly budget?: WorkerReport;
  readonly id?: string;
  readonly attemptId?: string;
  readonly reserved?: number;
  readonly exhausted?: readonly { readonly kind?: string; readonly committed?: number }[];
}

/** Node entries of one report, by node id. */
function nodeOf(
  report: WorkerReport | undefined,
  nodeId: string,
): NonNullable<WorkerReport["nodes"]>[number] | undefined {
  return report?.nodes?.find((node) => node.nodeId === nodeId);
}

/** Launch the checked-in worker and parse its ONE report line. */
async function runWorker(
  mode: string,
  storeRoot: string,
  workspaceDir: string,
  extra: readonly string[] = [],
): Promise<WorkerReport> {
  const proc = Bun.spawn(
    [
      process.execPath,
      WORKER,
      "--mode",
      mode,
      "--root",
      storeRoot,
      "--workspace",
      workspaceDir,
      "--graph",
      BUDGET_RESTART_GRAPH,
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), CHILD_DEADLINE_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "budget-restart: worker " +
        mode +
        " printed no report (exit " +
        String(exitCode) +
        "): " +
        stderr.slice(0, 400),
    );
  }
  const report = JSON.parse(line) as WorkerReport;
  if (report.ok !== true) {
    throw new Error(
      "budget-restart: worker " + mode + " failed: " + String(report.error ?? line),
    );
  }
  return report;
}

/** The parent's shipped host over a REAL declared graph, started once. */
async function openParentFixture(): Promise<{
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly dispatched: OutcomeDispatchRequest[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "budget-restart-"));
  tmpDirs.push(dir);
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      host?.confirmExecution(effect, { executionId: "child-session:" + request.attemptId });
    },
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    clock: () => BUDGET_RESTART_AT,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: createValidatorRegistry([]),
    outcomeArtifactRoot: dir,
    outcomeNow: BUDGET_RESTART_AT,
  });
  const tools = opened.bindTools(createOutcomeGraphTools(toolset)) as Record<
    string,
    { execute: (args: unknown, context: unknown) => Promise<unknown> }
  >;
  const declared = String(
    await tools["graph_declare"]?.execute(
      { declaration: declaration() },
      {
        sessionID: BUDGET_RESTART_DECLARER,
        messageID: "m1",
        agent: "agent.declarer",
        directory: dir,
        worktree: dir,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      },
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("budget-restart: graph_declare refused: " + declared);
  }
  const started = await opened.startDeclaredGraph(BUDGET_RESTART_GRAPH, {
    sessionId: BUDGET_RESTART_DECLARER,
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("budget-restart: the graph did not start (" + started.kind + ")");
  }
  return { dir, storeRoot, host: opened, dispatched };
}

describe("the dispatch budget across real processes", () => {
  it("survives a restart without re-counting a claim, reconciles once, and reports the real overrun", async () => {
    const fixture = await openParentFixture();
    try {
      // THE PARENT's own start left the entry dispatch's claim durable.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const row = store.budget.readReservation(BUDGET_RESTART_GRAPH, BUDGET_RESTART_NODE + "#1");
        expect(row?.status).toBe("reserved");
        expect(row?.reserved.inputTokens).toBe(BUDGET_RESTART_LIMIT);
      } finally {
        store.close();
      }

      // PROCESS TWO: a fresh process resumes the graph and finds the claim.
      const resumed = await runWorker("resume", fixture.storeRoot, fixture.dir);
      expect(["started", "resumed"]).toContain(String(resumed.kind));
      expect(nodeOf(resumed.before, BUDGET_RESTART_NODE)?.executions).toBe(1);
      expect(nodeOf(resumed.before, BUDGET_RESTART_NODE)?.reserved?.inputTokens).toBe(
        BUDGET_RESTART_LIMIT,
      );
      // NOT RE-COUNTED: the resume added no claim for the same attempt.
      expect(nodeOf(resumed.after, BUDGET_RESTART_NODE)?.executions).toBe(1);
      expect(nodeOf(resumed.after, BUDGET_RESTART_NODE)?.reserved?.inputTokens).toBe(
        BUDGET_RESTART_LIMIT,
      );
      expect(resumed.row?.status).toBe("reserved");

      // PROCESS THREE: the real usage arrives and reconciles the claim.
      const settled = await runWorker("usage", fixture.storeRoot, fixture.dir, [
        "--attempt",
        BUDGET_RESTART_NODE + "#1",
        "--input-tokens",
        "300",
        "--now",
        String(BUDGET_RESTART_AT + 10),
      ]);
      expect(settled.entries?.[0]?.outcome).toBe("reconciled");
      expect(nodeOf(settled.report, BUDGET_RESTART_NODE)?.used?.inputTokens).toBe(300);
      expect(nodeOf(settled.report, BUDGET_RESTART_NODE)?.reserved?.inputTokens).toBe(0);
      expect(nodeOf(settled.report, BUDGET_RESTART_NODE)?.executions).toBe(1);
      expect(settled.row?.status).toBe("reconciled");
      expect(settled.row?.used?.inputTokens).toBe(300);
      expect(settled.row?.checked?.inputTokens).toBe(BUDGET_RESTART_LIMIT);

      // PROCESS FOUR: the same bill again REPLAYS and adds nothing.
      const replayed = await runWorker("usage", fixture.storeRoot, fixture.dir, [
        "--attempt",
        BUDGET_RESTART_NODE + "#1",
        "--input-tokens",
        "300",
        "--now",
        String(BUDGET_RESTART_AT + 11),
      ]);
      expect(replayed.entries?.[0]?.outcome).toBe("replayed");
      expect(nodeOf(replayed.report, BUDGET_RESTART_NODE)?.used?.inputTokens).toBe(300);

      // PROCESS FIVE: a DELAYED bill for an attempt nothing reserved is appended,
      // and the run's report shows the ACTUAL overrun (300 + 1500 against 1000).
      const late = await runWorker("usage", fixture.storeRoot, fixture.dir, [
        "--attempt",
        BUDGET_RESTART_NODE + "#2",
        "--input-tokens",
        "1500",
        "--now",
        String(BUDGET_RESTART_AT + 12),
      ]);
      expect(late.entries?.[0]?.outcome).toBe("recorded-late");
      const lateWork = nodeOf(late.report, BUDGET_RESTART_NODE);
      expect(lateWork?.used?.inputTokens).toBe(1800);
      expect(lateWork?.overruns?.[0]?.overBy).toBe(800);
      expect(late.report?.overruns?.[0]?.kind).toBe("input_tokens");

      // PROCESS SIX: budget-stop from yet another process carries the overrun.
      const stopped = await runWorker("stop", fixture.storeRoot, fixture.dir);
      expect(stopped.kind).toBe("applied");
      expect(stopped.command).toBe("budget-stop");
      expect(stopped.scope).toBe("run");
      expect(stopped.runControl).toBe("budget-stop");
      expect(stopped.decided).toEqual([BUDGET_RESTART_NODE + "#1"]);
      expect(stopped.budget?.overruns?.[0]?.overBy).toBe(800);

      // PROCESS SEVEN: the durable facts a later window reads.
      const final = await runWorker("read", fixture.storeRoot, fixture.dir);
      expect(final.report?.totals?.inputTokens).toBe(1800);
      expect(final.row?.status).toBe("reconciled");
      expect(final.row?.used?.inputTokens).toBe(300);
    } finally {
      fixture.host.close();
    }
  });

  it("authorizes exactly one of two processes racing for the last unit of a node's ceiling", async () => {
    const fixture = await openParentFixture();
    try {
      // The race runs in the child processes themselves. The barrier markers live
      // outside the store root so they cannot be mistaken for store files.
      const markerDir = join(fixture.dir, "barrier");
      mkdirSync(markerDir, { recursive: true });
      const launch = (id: string) =>
        Bun.spawn(
          [
            process.execPath,
            WORKER,
            "--mode",
            "race",
            "--root",
            fixture.storeRoot,
            "--workspace",
            fixture.dir,
            "--graph",
            BUDGET_RESTART_GRAPH,
            "--node",
            BUDGET_RESTART_RACE_NODE,
            "--id",
            id,
            "--limit",
            String(BUDGET_RESTART_LIMIT),
            "--marker-dir",
            markerDir,
            "--now",
            String(BUDGET_RESTART_AT + 20),
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      const racers = [
        { id: "a", proc: launch("a") },
        { id: "b", proc: launch("b") },
      ];
      const timer = setTimeout(() => {
        for (const racer of racers) racer.proc.kill();
      }, CHILD_DEADLINE_MS);

      // BOTH racers must be ready before the parent releases the barrier, so the
      // two claims really overlap instead of running one after the other.
      const readyDeadline = Date.now() + BARRIER_DEADLINE_MS;
      while (
        !existsSync(join(markerDir, "ready-a.marker")) ||
        !existsSync(join(markerDir, "ready-b.marker"))
      ) {
        if (Date.now() > readyDeadline) {
          for (const racer of racers) racer.proc.kill();
          throw new Error("budget-restart: the two racers never signalled ready");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(join(markerDir, "go.marker"), "go");

      const reports: WorkerReport[] = [];
      for (const racer of racers) {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(racer.proc.stdout).text(),
          new Response(racer.proc.stderr).text(),
          racer.proc.exited,
        ]);
        const line = stdout
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry.startsWith("{"))
          .pop();
        if (line === undefined) {
          throw new Error(
            "budget-restart: racer " +
              racer.id +
              " printed no report (exit " +
              String(exitCode) +
              "): " +
              stderr.slice(0, 300),
          );
        }
        const parsed = JSON.parse(line) as WorkerReport;
        if (parsed.ok !== true) {
          throw new Error(
            "budget-restart: racer " + racer.id + " failed: " + String(parsed.error ?? line),
          );
        }
        reports.push(parsed);
      }
      clearTimeout(timer);

      const kinds = reports.map((report) => report.kind).sort();
      expect(kinds).toEqual(["exhausted", "reserved"]);
      const winner = reports.find((report) => report.kind === "reserved");
      const loser = reports.find((report) => report.kind === "exhausted");
      if (winner === undefined || loser === undefined || winner.attemptId === undefined) {
        throw new Error(
          "budget-restart: the race did not produce exactly one winner and one loser",
        );
      }
      const winnerAttempt = winner.attemptId;
      expect(winner.reserved).toBe(BUDGET_RESTART_LIMIT);
      expect(loser.exhausted?.[0]?.kind).toBe("input_tokens");
      expect(loser.exhausted?.[0]?.committed).toBe(BUDGET_RESTART_LIMIT);

      // ONE row for the node, and it names the winner.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const rows = store.budget
          .reservationsOf(BUDGET_RESTART_GRAPH)
          .filter((row) => row.nodeId === BUDGET_RESTART_RACE_NODE);
        expect(rows.length).toBe(1);
        expect(rows[0]?.attemptId).toBe(winnerAttempt);
        expect(rows[0]?.reserved.inputTokens).toBe(BUDGET_RESTART_LIMIT);
      } finally {
        store.close();
      }
    } finally {
      fixture.host.close();
    }
  });
});

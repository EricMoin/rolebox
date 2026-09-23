/**
 * CROSS-PROCESS evidence for the P3 item 2 RETRY restart (plan §4 P3 "重启后继续",
 * §5 A11 "重试和终态重新执行：新 attempt/run；旧回执不变").
 *
 * WHY THIS FILE EXISTS. The retry is DECIDED in one OS process — the shipped
 * control entry records the decision, the successor attempt, its credential and
 * its dispatch effect, and NO follow-up honours it — and then HONOURED in another
 * process that opens its own connection to the same store and has never seen the
 * deciding process's memory. The tracked in-process case
 * (`run-reexecution.test.ts`, "hands a pending successor effect to the NEXT
 * host") replaces the host OBJECT and shares the connection, so it is not a
 * process boundary; this case is the real one §4 asks for.
 *
 * WHAT IS ASSERTED, AND BY WHOM. Every worker is
 * `Bun.spawn(process.execPath, <this directory>/helpers/retry-restart-xproc-worker.ts, …)`,
 * each prints ONE JSON report, and the parent asserts:
 *
 *   - PROCESS ONE (`seed`): declares and starts the graph (attempt `work#1`
 *     dispatched and confirmed), then applies a node-scoped `retry` through the
 *     shipped control entry → `applied`, scope `attempt`, successor `work#2`,
 *     and EXITS with the successor's effect still pending (the crash window).
 *   - PROCESS TWO (`resume`): a fresh host over the same store root launches
 *     `dispatch:work#2` exactly once, and the delivered credential is verified
 *     against the PERSISTED state digest (the value itself is never printed).
 *   - PROCESS THREE (`resume` again): nothing is launched a second time, and the
 *     superseded attempt's effect is still visible and unsettled.
 *   - THE PARENT, over its own store connection: one `retry` decision naming
 *     `work#2` as its successor, ONE run (a node-scoped retry stays on the run),
 *     the state on `work#2`, and the superseded effect untouched.
 *
 * NO real-host evidence: this is real subprocesses over the real workspace
 * SQLite store, which is the ceiling of this environment.
 *
 * PRIVACY. Store roots live under the OS temp directory; reports carry attempt
 * ids, counts, booleans and status tokens only — never a credential value, a
 * real home-directory path or a session transcript.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphStore } from "../../src/graph/store/graph-store.ts";
import {
  RETRY_RESTART_AT,
  RETRY_RESTART_GRAPH,
} from "./helpers/retry-restart-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/retry-restart-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;

/** The parent's deadline for one race-barrier round. */
const BARRIER_DEADLINE_MS = 15_000;

/**
 * The harness budget must exceed this file's own child deadline, so a merely
 * SLOW child is diagnosed by the case instead of being killed by Bun's default
 * 5s test budget (the same reasoning as `graph-store-cross-process.test.ts`).
 */
setDefaultTimeout(CHILD_DEADLINE_MS + 15_000);

interface WorkerReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly error?: string;
  readonly delivered?: readonly string[];
  readonly retryKind?: string;
  readonly retryScope?: string;
  readonly minted?: readonly string[];
  readonly runId?: string;
  readonly resumedKind?: string;
  readonly armed?: readonly string[];
  readonly unsettled?: readonly string[];
  readonly credentialVerified?: boolean;
  readonly settled?: string;
  readonly orderRecorded?: boolean;
  readonly control?: string;
  readonly racer?: string;
  readonly won?: boolean;
  readonly reason?: string;
  readonly successorRunId?: string;
}

/** One live child, kept so a case that throws early still kills it. */
interface Child {
  readonly pid: number;
  readonly kill: () => void;
}

const children: Child[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const child of children) child.kill();
  children.length = 0;
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // Under the OS temp dir; a leftover there is not a tracked file.
    }
  }
  tmpDirs.length = 0;
});

/**
 * One private workspace + store root. The GRAPH is declared by the seeding
 * WORKER, not here: the declaration records the declaring invocation, which is
 * what the control entry's permission rule compares — so the process that
 * retries must be the process that declared.
 */
function makeFixture(prefix: string): {
  readonly dir: string;
  readonly storeRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  return { dir, storeRoot };
}

/** One worker that has been spawned but whose report is not awaited yet. */
interface RunningWorker {
  readonly pid: number;
  readonly report: Promise<WorkerReport>;
}

/**
 * Spawn one REAL bun process running the worker fixture. The caller may await
 * `report` immediately (`runWorker`) or hold several racers and await them
 * together (`startWorker` + a barrier).
 */
function startWorker(
  id: string,
  mode: string,
  fixture: { readonly dir: string; readonly storeRoot: string },
  extra: readonly string[] = [],
): RunningWorker {
  const proc = Bun.spawn(
    [
      process.execPath,
      WORKER,
      "--mode",
      mode,
      "--root",
      fixture.storeRoot,
      "--workspace",
      fixture.dir,
      "--now",
      String(RETRY_RESTART_AT),
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = Bun.readableStreamToText(proc.stdout);
  const stderr = Bun.readableStreamToText(proc.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, CHILD_DEADLINE_MS);
  children.push({
    pid: proc.pid,
    kill: () => {
      try {
        proc.kill(9);
      } catch {
        // already exited
      }
    },
  });

  const report = (async (): Promise<WorkerReport> => {
    const code = await proc.exited;
    clearTimeout(timer);
    const [out, err] = await Promise.all([stdout, stderr]);
    if (timedOut) {
      throw new Error(
        "retry-restart worker " +
          id +
          " (pid " +
          String(proc.pid) +
          ") did not exit within " +
          String(CHILD_DEADLINE_MS) +
          "ms and was killed — stdout: " +
          out.trim() +
          " stderr: " +
          err.trim(),
      );
    }
    const line = out
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("{"))
      .pop();
    if (line === undefined) {
      throw new Error(
        "retry-restart worker " +
          id +
          " (pid " +
          String(proc.pid) +
          ") exited " +
          String(code) +
          " without a JSON result — stdout: " +
          out.trim() +
          " stderr: " +
          err.trim(),
      );
    }
    const parsed = JSON.parse(line) as WorkerReport;
    if (code !== 0 || parsed.ok !== true) {
      throw new Error(
        "retry-restart worker " +
          id +
          " (pid " +
          String(proc.pid) +
          ") exited " +
          String(code) +
          " with " +
          JSON.stringify(parsed) +
          " — stderr: " +
          err.trim(),
      );
    }
    return parsed;
  })();
  return { pid: proc.pid, report };
}

/** Spawn one worker and await its report. */
async function runWorker(
  id: string,
  mode: string,
  fixture: { readonly dir: string; readonly storeRoot: string },
  extra: readonly string[] = [],
): Promise<WorkerReport> {
  return await startWorker(id, mode, fixture, extra).report;
}

/** Wait until every named marker exists under `dir`, or fail with what is missing. */
async function waitForMarkers(dir: string, names: readonly string[]): Promise<void> {
  const deadline = Date.now() + BARRIER_DEADLINE_MS;
  for (;;) {
    const missing = names.filter((name) => !existsSync(join(dir, name)));
    if (missing.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        "the race barrier did not complete within " +
          String(BARRIER_DEADLINE_MS) +
          "ms; missing: " +
          missing.join(", "),
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("retry — decided in one process, honoured in the next", () => {
  it("launches the successor attempt ONCE after a REAL process restart, and keeps the superseded attempt visible", async () => {
    const fixture = makeFixture("retry-restart-xproc-");

    // ── PROCESS ONE: declare, start, retry — then EXIT with the successor
    // effect pending. No follow-up runs, which is the crash window.
    const seed = await runWorker("seed", "seed", fixture);
    expect(seed.pid).not.toBe(process.pid);
    expect(seed.delivered).toEqual(["work#1"]);
    expect(seed.retryKind).toBe("applied");
    expect(seed.retryScope).toBe("attempt");
    expect(seed.minted).toEqual(["work#2"]);
    expect(typeof seed.runId).toBe("string");

    // ── PROCESS TWO: a fresh host, its OWN connection, no memory of process
    // one. The durable retry is what it resumes from, and the successor's
    // effect is launched exactly once.
    const resumed = await runWorker("resume", "resume", fixture);
    expect(resumed.pid).not.toBe(seed.pid);
    expect(resumed.pid).not.toBe(process.pid);
    expect(resumed.resumedKind).toBe("resumed");
    expect(resumed.delivered).toEqual(["work#2"]);
    // THE DELIVERED CREDENTIAL IS THE ONE THE PERSISTED DIGEST WAS WRITTEN FOR:
    // a lost value is re-issued under the create-right fence (§3.3), never
    // invented, and the value itself is never printed.
    expect(resumed.credentialVerified).toBe(true);
    expect(resumed.armed).toEqual(["work#2"]);
    expect(resumed.unsettled).toEqual(["dispatch:work#1", "dispatch:work#2"]);

    // ── PROCESS THREE: the same resume again. The started successor effect is
    // NOT launched a second time, and the superseded effect is still visible.
    const again = await runWorker("resume", "resume", fixture);
    expect(again.pid).not.toBe(resumed.pid);
    expect(again.delivered).toEqual([]);
    expect(again.credentialVerified).toBe(true);
    expect(again.unsettled).toEqual(["dispatch:work#1", "dispatch:work#2"]);

    // ── THE PARENT'S OWN CONNECTION: the durable facts, read by a fourth
    // process that never dispatched anything.
    const store = GraphStore.openFile(fixture.storeRoot);
    try {
      // ONE run: a node-scoped retry replaces an attempt ON the run; only a
      // run-scoped retry mints a successor run.
      expect(store.runs.runsOf(RETRY_RESTART_GRAPH).map((run) => run.runSeq)).toEqual([1]);
      const decisions = store.runs.controlDecisions(RETRY_RESTART_GRAPH);
      expect(decisions.map((decision) => decision.command)).toEqual(["retry"]);
      expect(decisions[0]?.attemptId).toBe("work#1");
      expect(decisions[0]?.successorAttemptId).toBe("work#2");
      expect(store.runs.readRunControl(RETRY_RESTART_GRAPH)).toBeUndefined();
      // The run's CURRENT state is the successor attempt...
      const current = store.readGraphState(RETRY_RESTART_GRAPH);
      const currentRunId = current?.runId ?? "";
      expect(currentRunId.length).toBeGreaterThan(0);
      // ...and the superseded attempt's effect is still on the run, UNSETTLED:
      // nothing rewound it, hid it or settled it on the successor's behalf.
      const supersededEffect = store
        .pendingEffects(RETRY_RESTART_GRAPH)
        .find((effect) => effect.effectId === "dispatch:work#1");
      expect(supersededEffect).toMatchObject({
        attemptId: "work#1",
        status: "started",
      });
      // No receipt and no accepted event: a retry is not an outcome (§3.4).
      expect(store.acceptedEvents(RETRY_RESTART_GRAPH)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("terminal-graph re-execution — two REAL processes race the successor run", () => {
  it("lets exactly ONE mint the successor and consume the order, and the loser writes nothing", async () => {
    const fixture = makeFixture("retry-reexec-race-");
    const markerDir = join(fixture.dir, "markers");
    mkdirSync(markerDir, { recursive: true });

    // ── PROCESS ONE: complete run 1 through the shipped ingress and record the
    // run-scoped ORDER only. No follow-up runs, so the successor does not exist
    // yet — the crash window two re-executors would race in.
    const ordered = await runWorker("order", "order", fixture);
    expect(ordered.pid).not.toBe(process.pid);
    expect(ordered.settled).toBe("work#1");
    expect(ordered.orderRecorded).toBe(true);
    expect(ordered.control).toBe("retry");
    expect(ordered.successorRunId).toBeUndefined();

    // ── PROCESSES TWO AND THREE: both read the SAME current run and the SAME
    // owed order, signal ready, and only mint after the parent's go. The
    // conditionals — `mintNextRun` against the run it supersedes, and
    // `markReexecutionExecuted` against the order — are what decide, never a
    // sleep.
    const racerA = startWorker("mint-a", "mint-race", fixture, [
      "--marker-dir",
      markerDir,
      "--id",
      "a",
    ]);
    const racerB = startWorker("mint-b", "mint-race", fixture, [
      "--marker-dir",
      markerDir,
      "--id",
      "b",
    ]);
    await waitForMarkers(markerDir, ["ready-a.marker", "ready-b.marker"]);
    writeFileSync(join(markerDir, "go.marker"), "");
    const [first, second] = await Promise.all([racerA.report, racerB.report]);
    expect(first.pid).not.toBe(second.pid);
    expect(first.pid).not.toBe(process.pid);
    expect(second.pid).not.toBe(process.pid);

    const racers = [first, second];
    const winners = racers.filter((racer) => racer.won === true);
    expect(winners).toHaveLength(1);
    const loser = racers.find((racer) => racer.won !== true);
    // The loser names the CONDITIONAL that refused it: the run it superseded had
    // already moved, or the order was already consumed. Both mean the same
    // thing — exactly one re-execution — and neither wrote anything.
    expect(["current-run-moved", "order-already-consumed"]).toContain(loser?.reason ?? "");

    // ── THE PARENT'S OWN CONNECTION.
    const store = GraphStore.openFile(fixture.storeRoot);
    try {
      const runs = store.runs.runsOf(RETRY_RESTART_GRAPH);
      expect(runs.map((run) => run.runSeq)).toEqual([1, 2]);
      const firstRun = runs[0];
      const secondRun = runs[1];
      // ONE successor, and the order names it exactly once.
      expect(
        store.runs.readReexecution(RETRY_RESTART_GRAPH, firstRun?.runId ?? "")?.successorRunId,
      ).toBe(secondRun?.runId);
      expect(winners[0]?.successorRunId).toBe(secondRun?.runId);
      // THE LOSER WROTE NOTHING: no third run, the superseded run keeps its own
      // state and its own control fact, and run 1's accepted event is intact.
      expect(store.readGraphStateOf(RETRY_RESTART_GRAPH, firstRun?.runId ?? "")?.runId).toBe(
        firstRun?.runId,
      );
      expect(
        store.runs.readRunControlOf(RETRY_RESTART_GRAPH, firstRun?.runId ?? "")?.command,
      ).toBe("retry");
      expect(
        store.acceptedEvents(RETRY_RESTART_GRAPH).map((event) => event.attemptId),
      ).toEqual(["work#1"]);
    } finally {
      store.close();
    }
  });
});

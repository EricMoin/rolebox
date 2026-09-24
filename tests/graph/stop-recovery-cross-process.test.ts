/**
 * CROSS-PROCESS evidence for the P4.3 stop semantics: a run stopped by a DECLARED
 * cap or progress policy is RECOVERABLE, and the recovery is decided in a NEW OS
 * PROCESS (R5, gap G4).
 *
 * WHY THIS FILE EXISTS. R5 is implemented and pinned in one process; the P4.3
 * gap analysis found that no committed test drives a graph to loop-exhausted or
 * progress-stalled and then RECOVERS it — only a throwaway probe did, inside one
 * process. A stop a later process cannot read and re-execute is not recoverable,
 * so the deciding half and the honouring half run here in REAL separate
 * processes that share nothing but the store on disk:
 *
 *   - PROCESS ONE (stop-cap / stop-stalled): declares and starts the graph
 *     through the shipped tools, drives it until the DECLARED limit stops the
 *     run, reports the persisted stop and EXITS.
 *   - PROCESS TWO (recover): a fresh host over the same store root applies the
 *     shipped run-scoped retry through graph_control, lets the installed
 *     follow-up mint and start the successor run, and reports both runs.
 *   - THE PARENT, over its OWN store connection: two runs, the successor
 *     executing with NO stop, and the superseded run still stopped by the same
 *     reason, readable under its own run id.
 *
 * The two stopping halves are the two ways a run can end by its own declaration:
 * the HARD cap (max_traversals) and the SOFT exit (max_unchanged). Recovering a
 * run stopped by a trusted command is covered elsewhere
 * (run-reexecution.test.ts), so it is not repeated here.
 *
 * NO real-host evidence: these are real subprocesses over the real workspace
 * SQLite store, which is the ceiling of this environment.
 *
 * PRIVACY. Store roots live under the OS temp directory; reports carry attempt
 * ids, status tokens and reason codes only — never a credential value, a real
 * home-directory path or a session transcript.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphStore } from "../../src/graph/store/graph-store.ts";
import {
  STOP_RECOVERY_AT,
  STOP_RECOVERY_CAP_GRAPH,
  STOP_RECOVERY_STALLED_GRAPH,
} from "./helpers/stop-recovery-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/stop-recovery-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;

/**
 * The harness budget must exceed this file's own child deadline, so a merely
 * SLOW child is diagnosed by the case instead of being killed by Bun's default
 * budget (the same reasoning as graph-store-cross-process.test.ts).
 */
setDefaultTimeout(CHILD_DEADLINE_MS + 15_000);

interface WorkerReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly error?: string;
  readonly graphId?: string;
  readonly runId?: string;
  readonly phase?: string;
  readonly stopReason?: string;
  readonly stopAttempt?: string;
  readonly settled?: readonly string[];
  readonly kind?: string;
  readonly scope?: string;
  readonly refusal?: string;
  readonly fromRunId?: string;
  readonly successorRunId?: string;
  readonly successorPhase?: string;
  readonly successorHasStop?: boolean;
  readonly successorEntryAttempt?: string;
  readonly supersededRunId?: string;
  readonly supersededPhase?: string;
  readonly supersededStopReason?: string;
  readonly delivered?: readonly string[];
}

const children: { readonly pid: number; readonly kill: () => void }[] = [];
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

/** One private workspace + store root. */
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

/** Spawn one REAL bun process running the worker and await its report. */
async function runWorker(
  id: string,
  mode: string,
  fixture: { readonly dir: string; readonly storeRoot: string },
  extra: readonly string[] = [],
): Promise<WorkerReport> {
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
      String(STOP_RECOVERY_AT),
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
  const code = await proc.exited;
  clearTimeout(timer);
  const [out, err] = await Promise.all([stdout, stderr]);
  if (timedOut) {
    throw new Error(
      "stop-recovery worker " + id + " (pid " + String(proc.pid) +
        ") did not exit within " + String(CHILD_DEADLINE_MS) + "ms and was killed — stdout: " +
        out.trim() + " stderr: " + err.trim(),
    );
  }
  const line = out
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "stop-recovery worker " + id + " (pid " + String(proc.pid) + ") exited " +
        String(code) + " without a JSON result — stdout: " + out.trim() + " stderr: " + err.trim(),
    );
  }
  const parsed = JSON.parse(line) as WorkerReport;
  if (code !== 0 || parsed.ok !== true) {
    throw new Error(
      "stop-recovery worker " + id + " (pid " + String(proc.pid) + ") exited " +
        String(code) + " with " + JSON.stringify(parsed) + " — stderr: " + err.trim(),
    );
  }
  return parsed;
}

/** One run's persisted phase and stop reason, read with a fresh connection. */
function runBody(
  store: GraphStore,
  graphId: string,
  runId: string,
): { readonly phase: unknown; readonly stopReason: unknown; readonly hasStop: boolean } {
  const record = store.readGraphStateOf(graphId, runId);
  const body =
    typeof record?.body === "object" && record.body !== null
      ? (record.body as Record<string, unknown>)
      : {};
  const stop = body["stop"];
  return {
    phase: body["phase"],
    stopReason:
      typeof stop === "object" && stop !== null
        ? (stop as Record<string, unknown>)["reason"]
        : undefined,
    hasStop: stop !== undefined,
  };
}

describe("a stopped run is recovered by a NEW process (G4)", () => {
  it("re-executes a run stopped by the DECLARED cap, and keeps the old run's stop", async () => {
    const fixture = makeFixture("stop-recovery-cap-");

    // ── PROCESS ONE: declare, drive to the declared cap, EXIT on the stop.
    const stopped = await runWorker("stop-cap", "stop-cap", fixture);
    expect(stopped.pid).not.toBe(process.pid);
    expect(stopped.graphId).toBe(STOP_RECOVERY_CAP_GRAPH);
    expect(stopped.phase).toBe("stopped");
    expect(stopped.stopReason).toBe("loop-exhausted");
    expect(stopped.settled).toEqual(["work#1", "review#2", "work#3", "review#4"]);
    expect(typeof stopped.runId).toBe("string");

    // ── PROCESS TWO: a fresh host and its OWN connection recover the run.
    const recovered = await runWorker("recover-cap", "recover", fixture, [
      "--graph",
      STOP_RECOVERY_CAP_GRAPH,
    ]);
    expect(recovered.pid).not.toBe(stopped.pid);
    expect(recovered.pid).not.toBe(process.pid);
    expect(recovered.kind).toBe("applied");
    expect(recovered.scope).toBe("run");
    expect(recovered.refusal).toBeUndefined();
    expect(recovered.fromRunId).toBe(stopped.runId);
    expect(typeof recovered.successorRunId).toBe("string");
    expect(recovered.successorRunId).not.toBe(stopped.runId);
    // The successor is a RUN, not a rebranded stop: it is executing, it carries
    // no stop, and it dispatched a FRESH entry attempt.
    expect(recovered.successorPhase).toBe("executing");
    expect(recovered.successorHasStop).toBe(false);
    expect(recovered.successorEntryAttempt).toBe("work#5");
    expect(recovered.delivered).toEqual(["work#5"]);
    // The superseded run keeps its own stop, readable by its own id.
    expect(recovered.supersededRunId).toBe(stopped.runId);
    expect(recovered.supersededPhase).toBe("stopped");
    expect(recovered.supersededStopReason).toBe("loop-exhausted");

    // ── THE PARENT'S OWN CONNECTION, which never dispatched or recovered
    // anything: two runs, the successor executing with no stop, the superseded
    // run still stopped by the same declared cap.
    const store = GraphStore.openFile(fixture.storeRoot);
    try {
      expect(store.runs.runsOf(STOP_RECOVERY_CAP_GRAPH).map((run) => run.runSeq)).toEqual([1, 2]);
      const oldRun = runBody(store, STOP_RECOVERY_CAP_GRAPH, stopped.runId ?? "");
      expect(oldRun.phase).toBe("stopped");
      expect(oldRun.stopReason).toBe("loop-exhausted");
      const currentRunId = store.readGraphState(STOP_RECOVERY_CAP_GRAPH)?.runId ?? "";
      expect(currentRunId).toBe(recovered.successorRunId);
      const newRun = runBody(store, STOP_RECOVERY_CAP_GRAPH, currentRunId);
      expect(newRun.phase).toBe("executing");
      expect(newRun.hasStop).toBe(false);
    } finally {
      store.close();
    }
  });

  it("re-executes a run stopped by the DECLARED progress policy, and keeps the old run's stop", async () => {
    const fixture = makeFixture("stop-recovery-stalled-");

    // ── PROCESS ONE: the SOFT exit — a repeated revision reaches the declared
    // threshold after the first continuation was admitted.
    const stopped = await runWorker("stop-stalled", "stop-stalled", fixture);
    expect(stopped.pid).not.toBe(process.pid);
    expect(stopped.graphId).toBe(STOP_RECOVERY_STALLED_GRAPH);
    expect(stopped.phase).toBe("stopped");
    expect(stopped.stopReason).toBe("progress-stalled");
    expect(stopped.settled).toEqual(["work#1", "review#2", "work#3", "review#4"]);
    expect(typeof stopped.runId).toBe("string");

    // ── PROCESS TWO: the same recovery, for the other stopping reason.
    const recovered = await runWorker("recover-stalled", "recover", fixture, [
      "--graph",
      STOP_RECOVERY_STALLED_GRAPH,
    ]);
    expect(recovered.pid).not.toBe(stopped.pid);
    expect(recovered.kind).toBe("applied");
    expect(recovered.scope).toBe("run");
    expect(recovered.fromRunId).toBe(stopped.runId);
    expect(recovered.successorPhase).toBe("executing");
    expect(recovered.successorHasStop).toBe(false);
    expect(recovered.successorEntryAttempt).toBe("work#5");
    expect(recovered.delivered).toEqual(["work#5"]);
    expect(recovered.supersededPhase).toBe("stopped");
    expect(recovered.supersededStopReason).toBe("progress-stalled");

    const store = GraphStore.openFile(fixture.storeRoot);
    try {
      expect(store.runs.runsOf(STOP_RECOVERY_STALLED_GRAPH).map((run) => run.runSeq)).toEqual([
        1, 2,
      ]);
      const oldRun = runBody(store, STOP_RECOVERY_STALLED_GRAPH, stopped.runId ?? "");
      expect(oldRun.phase).toBe("stopped");
      expect(oldRun.stopReason).toBe("progress-stalled");
      const currentRunId = store.readGraphState(STOP_RECOVERY_STALLED_GRAPH)?.runId ?? "";
      const newRun = runBody(store, STOP_RECOVERY_STALLED_GRAPH, currentRunId);
      expect(newRun.phase).toBe("executing");
      expect(newRun.hasStop).toBe(false);
    } finally {
      store.close();
    }
  });
});

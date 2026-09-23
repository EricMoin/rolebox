/**
 * P2 item 6 — RESTART RECOVERY DRIVEN BY A REAL PROCESS BOUNDARY.
 *
 * Plan §4: "真实宿主重启测试不能仅关闭再打开同一个内存对象；至少用子进程退出与重新启动
 * 驱动边界". Closing and reopening an object in one process is NOT a restart: an
 * in-process "second host" still shares the module-level connection map, the
 * warm caches and the process's memory. Every case here spawns REAL
 * `bun` processes with `Bun.spawn(process.execPath, …)` — the pattern
 * `tests/graph/graph-store-cross-process.test.ts` established — so the process
 * that recovers has never seen the dispatching process's memory, its open
 * connections, or its credential values.
 *
 * WHAT IS PINNED (acceptance A07 and the §3.3 restart authorization):
 *
 * 1. The dispatching child starts the graph, hands the platform one execution
 *    and CONFIRMS the platform's real execution id, then EXITS. The vault's
 *    durable store keeps no credential value (the shipped default), so the
 *    recovering process cannot resolve one.
 * 2. A second child runs the boot sweep with the platform observation port. The
 *    binding is rebuilt from the host's durable record — the execution row plus
 *    the dispatch effect that names the node — and, because the platform reports
 *    the execution TERMINAL, the completion is applied IDEMPOTENTLY through the
 *    same acceptance core an announced completion uses. ONE accepted event.
 * 3. A third child repeats the sweep: nothing is completed twice, nothing is
 *    re-dispatched, and the host's execution row is unchanged.
 * 4. A fourth child settles the SAME completion directly (`host.complete`) with
 *    no observation port: the durable binding is enough, the settlement REPLAYS
 *    the persisted receipt, and the worker's bearer value — which this process
 *    never held — appears in no report.
 * 5. A child with NO observation port must not silently strand the attempt: the
 *    sweep reports an explicit per-effect refusal (`completion-unsettled`) and
 *    leaves the one accepted event count untouched.
 *
 * The same windows are covered in-process by `host-boundary.test.ts` (binding)
 * and `host-restart-authorization.test.ts` (authorization policy); THIS file is
 * the process-boundary evidence the plan requires.
 *
 * PRIVACY: every store root lives under the OS temp directory, every child
 * reports ids, counts, booleans and status tokens, and no case prints or asserts
 * a credential VALUE.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  XPROC_GRAPH_ID,
  persistXprocGraph,
} from "./helpers/host-restart-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/host-restart-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;
/** The parent's deadline for the dispatch marker (the barrier). */
const BARRIER_DEADLINE_MS = 15_000;
/** The platform's id for the execution the dispatching child creates. */
const PLATFORM_EXECUTION_ID = "platform-run-restart-xproc";

// ── Child processes ─────────────────────────────────────────────────────────

interface WorkerReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly error?: string;
  readonly delivered?: readonly string[];
  readonly retained?: boolean;
  readonly resolvable?: boolean;
  readonly started?: readonly string[];
  readonly resumed?: readonly string[];
  readonly refused?: readonly string[];
  readonly completed?: readonly string[];
  readonly divergences?: number;
  readonly effectRefusals?: readonly string[];
  readonly storeBlocked?: string | null;
  readonly kind?: string;
  readonly nodeId?: string | null;
  readonly settlementKind?: string | null;
  readonly replayed?: boolean | null;
  readonly record?: {
    readonly phase: string | null;
    readonly status: string | null;
    readonly attemptId: string | null;
    readonly outcomeId: string | null;
    readonly credentialDigest: string | null;
    readonly events: number;
    readonly pendingEffects: readonly string[];
    readonly graphId: string | null;
  };
  readonly executionRow?: {
    readonly state: string;
    readonly attemptId: string;
    readonly executionId: string | null;
    readonly taskId: string | null;
    readonly generation: number;
  } | null;
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

/** One private workspace + store root for a case, with the fixture graph in it. */
function makeFixture(prefix: string): {
  readonly dir: string;
  readonly storeRoot: string;
  readonly workspaceDir: string;
  readonly markerDir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  const storeRoot = join(dir, "host-store");
  const markerDir = join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  // The PARENT persists the graph, so no child ever has to declare it and the
  // dispatching child only dispatches.
  persistXprocGraph(storeRoot);
  return { dir, storeRoot, workspaceDir: dir, markerDir };
}

/** Spawn one REAL bun process running the worker fixture and await its report. */
async function runWorker(
  id: string,
  args: readonly string[],
): Promise<WorkerReport> {
  const proc = Bun.spawn([process.execPath, WORKER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
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
      "restart worker " +
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
      "restart worker " +
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
  const report = JSON.parse(line) as WorkerReport;
  if (code !== 0 || report.ok !== true) {
    throw new Error(
      "restart worker " +
        id +
        " (pid " +
        String(proc.pid) +
        ") exited " +
        String(code) +
        " with " +
        JSON.stringify(report) +
        " — stderr: " +
        err.trim(),
    );
  }
  return report;
}

/** Wait for the dispatch marker file, or fail with what is missing. */
async function waitForMarker(path: string, what: string): Promise<void> {
  const deadline = Date.now() + BARRIER_DEADLINE_MS;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() > deadline) {
      throw new Error(
        "the restart barrier did not complete within " +
          String(BARRIER_DEADLINE_MS) +
          "ms; missing: " +
          what,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/** `--key value` pairs every mode needs. */
function workerArgs(
  fixture: { readonly storeRoot: string; readonly workspaceDir: string },
  args: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [
    "--root",
    fixture.storeRoot,
    "--workspace",
    fixture.workspaceDir,
    "--graph",
    XPROC_GRAPH_ID,
  ];
  for (const [key, value] of Object.entries(args)) out.push("--" + key, value);
  return out;
}

// ── The restart ─────────────────────────────────────────────────────────────

describe("host restart — a real process boundary recovers the completion binding", () => {
  it("dispatches in one process, then rebuilds the binding, reads the terminal state and settles ONCE in others", async () => {
    const fixture = makeFixture("restart-xproc-");

    // ── PROCESS ONE: dispatch and confirm, then EXIT ─────────────────────
    const dispatched = await runWorker("dispatch", [
      ...workerArgs(fixture, {
        mode: "dispatch",
        execution: PLATFORM_EXECUTION_ID,
        "marker-dir": fixture.markerDir,
      }),
    ]);
    expect(dispatched.pid).not.toBe(process.pid);
    expect(dispatched.delivered).toEqual(["work#1"]);
    // THE SHIPPED DEFAULT: the attempt's record is durable, its credential
    // value is NOT — so the recovering process cannot resolve one.
    expect(dispatched.retained).toBe(false);
    expect(dispatched.resolvable).toBe(true);
    expect(dispatched.record?.status).toBe("dispatched");
    expect(dispatched.record?.events).toBe(0);
    expect(dispatched.record?.pendingEffects).toEqual(["dispatch:work#1@started"]);
    expect(dispatched.executionRow?.state).toBe("created");
    expect(dispatched.executionRow?.executionId).toBe(PLATFORM_EXECUTION_ID);

    // ── THE BARRIER: the recovery process starts only after the dispatch
    // process wrote its marker, so no sleep decides the outcome.
    await waitForMarker(
      join(fixture.markerDir, "dispatched-work#1.marker"),
      "the dispatching process's marker",
    );

    // ── PROCESS TWO: a FRESH process recovers, asked to READ the terminal
    // state of the confirmed execution.
    const recovered = await runWorker("recover-terminal", [
      ...workerArgs(fixture, { mode: "recover", observe: "terminal" }),
    ]);
    expect(recovered.pid).not.toBe(dispatched.pid);
    expect(recovered.pid).not.toBe(process.pid);
    // The binding was rebuilt from durable facts and the completion applied
    // idempotently: the sweep names the attempt it settled and dispatched
    // NOTHING of its own.
    expect(recovered.completed).toEqual([XPROC_GRAPH_ID + ":work#1:accepted"]);
    expect(recovered.delivered).toEqual([]);
    expect(recovered.refused).toEqual([]);
    // The attempt's credential VALUE did not survive the restart, so the run
    // path reports that it will not re-issue one for an effect the platform may
    // already have — and the completion settles the attempt anyway, through the
    // host's own execution record. Both facts are reported; neither is guessed.
    expect(recovered.effectRefusals).toEqual([
      XPROC_GRAPH_ID + ":credential-reissue-forbidden",
    ]);
    expect(recovered.record?.status).toBe("settled");
    expect(recovered.record?.attemptId).toBe("work#1");
    expect(recovered.record?.outcomeId).toBe("done");
    expect(recovered.record?.events).toBe(1);
    expect(recovered.record?.pendingEffects).toEqual([]);
    // NO SECOND EXECUTION: the host's row still names the SAME platform
    // execution the dispatching process confirmed.
    expect(recovered.executionRow?.state).toBe("created");
    expect(recovered.executionRow?.executionId).toBe(PLATFORM_EXECUTION_ID);

    // ── PROCESS THREE: the same sweep again. Nothing completes twice and
    // nothing is re-dispatched.
    const again = await runWorker("recover-again", [
      ...workerArgs(fixture, { mode: "recover", observe: "terminal" }),
    ]);
    expect(again.pid).not.toBe(recovered.pid);
    expect(again.completed).toEqual([]);
    expect(again.delivered).toEqual([]);
    expect(again.record?.events).toBe(1);
    expect(again.record?.status).toBe("settled");

    // ── PROCESS FOUR: settle the SAME completion directly, with NO
    // observation port — the durable binding alone must be enough, and the
    // persisted receipt must replay.
    const replayed = await runWorker("complete", [
      ...workerArgs(fixture, { mode: "complete", attempt: "work#1" }),
    ]);
    expect(replayed.pid).not.toBe(again.pid);
    expect(replayed.kind).toBe("settled");
    expect(replayed.nodeId).toBe("work");
    expect(replayed.settlementKind).toBe("accepted");
    expect(replayed.replayed).toBe(true);
    expect(replayed.delivered).toEqual([]);
    expect(replayed.record?.events).toBe(1);
  });

  it("reports an OBSERVABLE block, never a silent strand, when the platform cannot be asked", async () => {
    const fixture = makeFixture("restart-xproc-unobserved-");

    const dispatched = await runWorker("dispatch-unobserved", [
      ...workerArgs(fixture, {
        mode: "dispatch",
        execution: PLATFORM_EXECUTION_ID,
        "marker-dir": fixture.markerDir,
      }),
    ]);
    expect(dispatched.record?.status).toBe("dispatched");
    await waitForMarker(
      join(fixture.markerDir, "dispatched-work#1.marker"),
      "the dispatching process's marker",
    );

    // A host with NO execution-observation port (the shipped adapters' position
    // today) must not report the graph resumed-and-fine while the execution's
    // fate is unknown: the attempt is reported as explicitly unsettled.
    const unobserved = await runWorker("recover-unobserved", [
      ...workerArgs(fixture, { mode: "recover", observe: "none" }),
    ]);
    expect(unobserved.completed).toEqual([]);
    expect(unobserved.delivered).toEqual([]);
    expect(unobserved.refused).toEqual([]);
    // TWO refusals, both honest: the lost credential is never re-issued for an
    // effect the platform may already have, and the completion cannot be
    // observed. The attempt is unsettled and REPORTED, which is the difference
    // between a block and a silent strand.
    expect(unobserved.effectRefusals).toEqual([
      XPROC_GRAPH_ID + ":credential-reissue-forbidden",
      XPROC_GRAPH_ID + ":completion-unsettled",
    ]);
    // The attempt is EXACTLY where the dispatching process left it: in flight,
    // with no fabricated settlement and no re-dispatch.
    expect(unobserved.record?.status).toBe("dispatched");
    expect(unobserved.record?.attemptId).toBe("work#1");
    expect(unobserved.record?.events).toBe(0);
    expect(unobserved.record?.pendingEffects).toEqual(["dispatch:work#1@started"]);
    expect(unobserved.executionRow?.state).toBe("created");
    expect(unobserved.executionRow?.executionId).toBe(PLATFORM_EXECUTION_ID);

    // AND IT IS NOT STRANDED: once a process CAN read the platform's terminal
    // state, the very same attempt settles.
    const later = await runWorker("recover-later", [
      ...workerArgs(fixture, { mode: "recover", observe: "terminal" }),
    ]);
    expect(later.completed).toEqual([XPROC_GRAPH_ID + ":work#1:accepted"]);
    expect(later.record?.events).toBe(1);
  });
});

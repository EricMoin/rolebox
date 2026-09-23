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
 * 6. A confirmed execution the platform reports STILL RUNNING is not settled and
 *    not dropped: the sweep names it (with the platform's own execution id) in
 *    `awaitingCompletion` — the inventory a restarted host adapter re-subscribes
 *    to or keeps re-querying — and a LATER sweep that reads the same execution
 *    terminal settles the same attempt exactly once.
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
  readonly awaitingCompletion?: readonly {
    readonly graphId: string;
    readonly nodeId: string;
    readonly attemptId: string;
    readonly executionId: string;
    readonly status: string;
  }[];
  /** Whether the platform query port's asynchronous prime phase ran. */
  readonly primed?: boolean;
  /** What consuming the awaiting inventory established (F4). */
  readonly watching?: {
    readonly watched: readonly string[];
    readonly settled: readonly string[];
    readonly unwatched: readonly string[];
  };
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

  it("names a confirmed execution the platform reports RUNNING, then settles it once a later sweep reads it terminal", async () => {
    const fixture = makeFixture("restart-xproc-running-");

    // ── PROCESS ONE: dispatch and confirm, then EXIT ─────────────────────
    const dispatched = await runWorker("dispatch-running", [
      ...workerArgs(fixture, {
        mode: "dispatch",
        execution: PLATFORM_EXECUTION_ID,
        "marker-dir": fixture.markerDir,
      }),
    ]);
    expect(dispatched.pid).not.toBe(process.pid);
    expect(dispatched.executionRow?.state).toBe("created");
    await waitForMarker(
      join(fixture.markerDir, "dispatched-work#1.marker"),
      "the dispatching process's marker",
    );

    // ── PROCESS TWO: the platform says the execution has NOT finished. The
    // attempt must not be settled on that answer — and it must not be dropped
    // either: the sweep NAMES the confirmed execution it is still waiting on.
    const running = await runWorker("recover-running", [
      ...workerArgs(fixture, { mode: "recover", observe: "running" }),
    ]);
    expect(running.pid).not.toBe(dispatched.pid);
    expect(running.pid).not.toBe(process.pid);
    expect(running.completed).toEqual([]);
    expect(running.delivered).toEqual([]);
    expect(running.awaitingCompletion).toEqual([
      {
        graphId: XPROC_GRAPH_ID,
        nodeId: "work",
        attemptId: "work#1",
        executionId: PLATFORM_EXECUTION_ID,
        status: "running",
      },
    ]);
    // A RUNNING execution is not a refusal — it is work still in flight — so
    // the only per-effect refusal is the lost credential, which is never
    // re-issued for an effect the platform may already hold.
    expect(running.effectRefusals).toEqual([
      XPROC_GRAPH_ID + ":credential-reissue-forbidden",
    ]);
    // The attempt is EXACTLY where the dispatching process left it.
    expect(running.record?.status).toBe("dispatched");
    expect(running.record?.events).toBe(0);
    expect(running.record?.pendingEffects).toEqual(["dispatch:work#1@started"]);
    expect(running.executionRow?.state).toBe("created");
    expect(running.executionRow?.executionId).toBe(PLATFORM_EXECUTION_ID);

    // ── PROCESS THREE: the SAME attempt, now read as TERMINAL. The inventory is
    // what a host adapter re-subscribes to; the durable binding is what makes the
    // later observation settle it exactly once.
    const terminal = await runWorker("recover-running-terminal", [
      ...workerArgs(fixture, { mode: "recover", observe: "terminal" }),
    ]);
    expect(terminal.pid).not.toBe(running.pid);
    expect(terminal.completed).toEqual([XPROC_GRAPH_ID + ":work#1:accepted"]);
    expect(terminal.delivered).toEqual([]);
    expect(terminal.awaitingCompletion).toEqual([]);
    expect(terminal.record?.status).toBe("settled");
    expect(terminal.record?.events).toBe(1);
    expect(terminal.executionRow?.executionId).toBe(PLATFORM_EXECUTION_ID);
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
    // AND IT IS NAMED FOR THE HOST TO KEEP LISTENING TO (P2 item 6): the
    // confirmed execution is reported as AWAITED, by the platform's own id, so
    // a host adapter can re-subscribe or re-query instead of waiting for an
    // announcement a restarted process can no longer receive.
    expect(unobserved.awaitingCompletion).toEqual([
      {
        graphId: XPROC_GRAPH_ID,
        nodeId: "work",
        attemptId: "work#1",
        executionId: PLATFORM_EXECUTION_ID,
        status: "unknown",
      },
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

  it("W4: adopts the execution the platform names for a create whose confirmation never arrived, and settles it once", async () => {
    const fixture = makeFixture("restart-xproc-w4-");

    // ── PROCESS ONE: dispatch and NEVER confirm (the confirmation was lost),
    // then EXIT. The host's row is left `creating` with no execution id.
    const dispatched = await runWorker("dispatch-unconfirmed", [
      ...workerArgs(fixture, {
        mode: "dispatch",
        execution: PLATFORM_EXECUTION_ID,
        "marker-dir": fixture.markerDir,
        confirm: "no",
      }),
    ]);
    expect(dispatched.pid).not.toBe(process.pid);
    expect(dispatched.delivered).toEqual(["work#1"]);
    expect(dispatched.executionRow?.state).toBe("creating");
    expect(dispatched.executionRow?.executionId).toBeNull();
    await waitForMarker(
      join(fixture.markerDir, "dispatched-work#1.marker"),
      "the dispatching process's marker",
    );

    // ── PROCESS TWO: a FRESH process whose platform port can name the
    // execution, and which re-subscribes to it. The port answers only after
    // its prime phase ran, so this also proves the host primed it BEFORE the
    // synchronous resume asked.
    const recovered = await runWorker("recover-w4-watch", [
      ...workerArgs(fixture, {
        mode: "recover",
        observe: "running",
        query: "created",
        execution: PLATFORM_EXECUTION_ID,
        watch: "on",
      }),
    ]);
    expect(recovered.pid).not.toBe(dispatched.pid);
    expect(recovered.primed).toBe(true);
    // NO SECOND EXECUTION: the platform named the SAME one, and the recovery
    // delivered nothing.
    expect(recovered.delivered).toEqual([]);
    expect(recovered.awaitingCompletion).toEqual([
      {
        graphId: XPROC_GRAPH_ID,
        nodeId: "work",
        attemptId: "work#1",
        executionId: PLATFORM_EXECUTION_ID,
        status: "running",
      },
    ]);
    // THE AWAITING INVENTORY WAS CONSUMED: the platform's own channel was
    // established for the named execution, and the announced end settled the
    // attempt through the same acceptance core.
    expect(recovered.watching?.watched).toEqual([
      XPROC_GRAPH_ID + ":work#1:" + PLATFORM_EXECUTION_ID,
    ]);
    expect(recovered.watching?.unwatched).toEqual([]);
    expect(recovered.record?.status).toBe("settled");
    expect(recovered.record?.outcomeId).toBe("done");
    expect(recovered.record?.events).toBe(1);
    expect(recovered.record?.pendingEffects).toEqual([]);
    // THE DURABLE ROW IS NOT REWRITTEN: the fenced `creating` claim belonged to
    // the process that died, and the platform's name is the reading that
    // authenticated the completion — not a second local creation.
    expect(recovered.executionRow?.state).toBe("creating");
    expect(recovered.executionRow?.executionId).toBeNull();

    // ── PROCESS THREE: the same store again. One accepted event, nothing
    // re-created, nothing re-settled.
    const again = await runWorker("recover-w4-again", [
      ...workerArgs(fixture, {
        mode: "recover",
        observe: "terminal",
        query: "created",
        execution: PLATFORM_EXECUTION_ID,
      }),
    ]);
    expect(again.pid).not.toBe(recovered.pid);
    expect(again.delivered).toEqual([]);
    expect(again.completed).toEqual([]);
    expect(again.record?.events).toBe(1);
  });

  it("W3: a port that cannot prove non-existence leaves the create right held across real processes", async () => {
    const fixture = makeFixture("restart-xproc-w3-");

    const dispatched = await runWorker("dispatch-unconfirmed-w3", [
      ...workerArgs(fixture, {
        mode: "dispatch",
        execution: PLATFORM_EXECUTION_ID,
        "marker-dir": fixture.markerDir,
        confirm: "no",
      }),
    ]);
    expect(dispatched.executionRow?.state).toBe("creating");
    await waitForMarker(
      join(fixture.markerDir, "dispatched-work#1.marker"),
      "the dispatching process's marker",
    );

    // The platform's port is installed and answers UNKNOWN: the effect may
    // exist, so nothing may be released and nothing may be re-created.
    const blocked = await runWorker("recover-w3-unknown", [
      ...workerArgs(fixture, {
        mode: "recover",
        observe: "none",
        query: "unknown",
      }),
    ]);
    expect(blocked.delivered).toEqual([]);
    expect(blocked.completed).toEqual([]);
    expect(blocked.primed).toBe(true);
    expect(blocked.record?.events).toBe(0);
    expect(blocked.record?.status).toBe("dispatched");
    // The row is EXACTLY where the dead process left it, and the lost
    // credential is reported rather than re-issued.
    expect(blocked.executionRow?.state).toBe("creating");
    expect(blocked.executionRow?.executionId).toBeNull();
    expect(blocked.effectRefusals).toEqual([
      XPROC_GRAPH_ID + ":credential-reissue-forbidden",
    ]);
    expect(blocked.awaitingCompletion).toEqual([]);
  });
});

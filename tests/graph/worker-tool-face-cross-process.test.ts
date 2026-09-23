/**
 * A21 / plan §3.3 — the worker tool face across a REAL PROCESS BOUNDARY.
 *
 * WHY THIS FILE EXISTS. `worker-tool-face.test.ts` proves the boundary against
 * the store in ONE process: a second host object over the same file shares the
 * module-level connection map and that process's memory. The claim under test —
 * a worker's calls are judged by the host's own durable execution row, so a
 * process that never dispatched or confirmed anything still refuses it — is
 * only honestly established by a REAL process boundary. Every case here spawns
 * `bun` children with `Bun.spawn(process.execPath, …)` (the pattern
 * `graph-store-cross-process.test.ts` established), so the judging process has
 * never seen the dispatching process's memory, its connections or its
 * credential values.
 *
 * WHAT IS PINNED:
 *
 * 1. The dispatching child starts the declared graph, confirms the platform's
 *    execution for each attempt, and lets `alpha#1`'s OWN worker settle its
 *    attempt through the bound face (`decision: "accepted"`) — the delivery
 *    works, and the credential value never leaves that process.
 * 2. A SECOND child — a different pid, no memory of anything — refuses the
 *    SETTLED attempt's worker for `graph_status` and `graph_audit`: the effect
 *    is no longer pending, so the only fact that can bind the session is the
 *    durable EXECUTION row the store keeps after settlement (G-A21-restart).
 * 3. The same child refuses the STILL-OPEN attempt's worker too, from the same
 *    durable read.
 * 4. The refused `graph_declare` lands nowhere (`absent`), which is what makes
 *    the refusal a pre-body check and not a post-hoc report.
 * 5. The declaring session in that fresh process still gets the face — the
 *    boundary refuses a bound worker, not a tool.
 *
 * STRENGTH: cross-process (real OS processes, real SQLite store). Still NO
 * real dsh/Pi SDK run and NO OS/account/container boundary — the platform half
 * of A21 stays open and is reported, never claimed here.
 *
 * PRIVACY: store roots live under the OS temp directory; the children report
 * attempt ids, a stable refusal code and booleans only — never a credential
 * value.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_TOOL_FORBIDDEN_CODE } from "../../src/graph/host/outcome-host.ts";
import {
  XPROC_FACE_GRAPH_ID,
  XPROC_FACE_OPEN_ATTEMPT,
  XPROC_FACE_OTHER_ID,
  XPROC_FACE_SETTLED_ATTEMPT,
  persistWorkerFaceGraph,
} from "./helpers/worker-face-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/worker-face-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;

// ── The child's report ──────────────────────────────────────────────────────

interface CallReport {
  readonly refused: boolean;
  readonly code: string | null;
  readonly tool: string | null;
  readonly attempt_id: string | null;
  readonly granted_tools: readonly string[] | null;
  readonly leaks_store_root: boolean;
}

interface FaceReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly error?: string;
  readonly delivered?: readonly string[];
  readonly decision?: string | null;
  readonly settled?: { readonly status: CallReport; readonly audit: CallReport };
  readonly open?: { readonly status: CallReport };
  readonly worker_declare?: CallReport;
  readonly declared_other?: string;
  readonly declarer?: { readonly refused: boolean; readonly leaks_store_root: boolean };
}

// ── Fixture and child harness ───────────────────────────────────────────────

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
  // The PARENT persists the graph, so the children only dispatch and judge.
  persistWorkerFaceGraph(storeRoot);
  return { dir, storeRoot, workspaceDir: dir, markerDir };
}

/** Spawn one REAL bun process running the worker fixture and await its report. */
async function runWorker(
  id: string,
  args: readonly string[],
): Promise<FaceReport> {
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
      "face worker " +
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
      "face worker " +
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
  const report = JSON.parse(line) as FaceReport;
  if (code !== 0 || report.ok !== true) {
    throw new Error(
      "face worker " +
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

/** `--key value` pairs every mode needs. */
function workerArgs(
  fixture: { readonly storeRoot: string; readonly workspaceDir: string; readonly markerDir: string },
  extra: Readonly<Record<string, string>>,
): string[] {
  const args = [
    "--root",
    fixture.storeRoot,
    "--workspace",
    fixture.workspaceDir,
    "--marker-dir",
    fixture.markerDir,
  ];
  for (const [key, value] of Object.entries(extra)) args.push("--" + key, value);
  return args;
}

/** Assert one child's answer is exactly this boundary's refusal. */
function expectRefusal(
  report: CallReport | undefined,
  tool: string,
  attemptId: string,
): void {
  if (report === undefined) throw new Error("fixture: no report for " + tool);
  expect(report.refused).toBe(true);
  expect(report.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
  expect(report.tool).toBe(tool);
  expect(report.attempt_id).toBe(attemptId);
  expect(report.granted_tools).toEqual(["graph_submit_outcome"]);
  // No path check: the answer never names the store the caller must not read.
  expect(report.leaks_store_root).toBe(false);
}

// ── The case ────────────────────────────────────────────────────────────────

describe("the worker tool face judged by a process that never dispatched anything", () => {
  it("refuses a SETTLED attempt's worker, refuses the open one, and still lets the declarer work", async () => {
    const fixture = makeFixture("worker-face-xproc-");

    // 1. THE DISPATCHING PROCESS settles alpha#1 through its own worker and exits.
    const dispatched = await runWorker("dispatch", [
      ...workerArgs(fixture, { mode: "dispatch" }),
    ]);
    expect(dispatched.mode).toBe("dispatch");
    expect(dispatched.pid).not.toBe(process.pid);
    expect(dispatched.delivered).toEqual([XPROC_FACE_SETTLED_ATTEMPT, XPROC_FACE_OPEN_ATTEMPT]);
    expect(dispatched.decision).toBe("accepted");

    // 2. A FRESH PROCESS judges the same sessions. Its only source is the store.
    const judged = await runWorker("face", [...workerArgs(fixture, { mode: "face" })]);
    expect(judged.mode).toBe("face");
    expect(judged.pid).not.toBe(process.pid);
    expect(judged.pid).not.toBe(dispatched.pid);

    // The SETTLED attempt: its effect is no longer pending, so only the durable
    // execution row (reached through the accepted event) can bind the session.
    expectRefusal(judged.settled?.status, "graph_status", XPROC_FACE_SETTLED_ATTEMPT);
    expectRefusal(judged.settled?.audit, "graph_audit", XPROC_FACE_SETTLED_ATTEMPT);

    // The attempt that is still open is refused from the same durable read.
    expectRefusal(judged.open?.status, "graph_status", XPROC_FACE_OPEN_ATTEMPT);

    // The refused declaration is a PRE-BODY refusal: nothing landed.
    expectRefusal(judged.worker_declare, "graph_declare", XPROC_FACE_SETTLED_ATTEMPT);
    expect(judged.declared_other).toBe("absent");

    // 3. The boundary refuses a bound worker, not a tool: the declaring session
    // in the SAME fresh process still gets the face and sees the graph.
    expect(judged.declarer?.refused).toBe(false);
  });
});

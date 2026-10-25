import { spawnProcess, readableToText } from "../../scripts/node-process.ts";

import { afterEach, describe, expect, it } from "vitest";
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
  readonly declarer?: {
    readonly refused: boolean;
    readonly parsed: boolean;
    readonly graph_id: string | null;
    readonly nodes: readonly { readonly node_id: string; readonly status: string }[] | null;
    readonly leaks_store_root: boolean;
  };
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

async function runWorker(
  id: string,
  args: readonly string[],
): Promise<FaceReport> {
  const proc = spawnProcess([process.execPath, WORKER, ...args], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = readableToText(proc.stdout);
  const stderr = readableToText(proc.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, CHILD_DEADLINE_MS);
  children.push({
    pid: proc.pid,
    kill: () => {
      try {
        proc.kill("SIGKILL");
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
    // in the SAME fresh process still gets the face — and gets a REAL body for
    // the graph the DISPATCHING process declared, PARSED, not an error string
    // that merely carries the graph's name. The old check here asserted only
    // `refused === false`, which the plain-text "graph_status failed: graph
    // \"…\" is not a declared graph in this process" also satisfies (a
    // session-scope query in a process that never declared anything).
    expect(judged.declarer?.refused).toBe(false);
    expect(judged.declarer?.parsed).toBe(true);
    expect(judged.declarer?.graph_id).toBe(XPROC_FACE_GRAPH_ID);
    expect(judged.declarer?.nodes?.map((node) => node.node_id).sort()).toEqual(["alpha", "beta"]);
    // The position is the DURABLE one the dispatching process left: alpha#1's
    // outcome was accepted there, so alpha is `completed`; beta's attempt was
    // dispatched and never settled, so beta is `running`. A declaration
    // snapshot would read every node `pending`.
    expect(
      judged.declarer?.nodes?.map((node) => node.node_id + ":" + node.status).sort(),
    ).toEqual(["alpha:settled", "beta:dispatched"]);
    // The positive control's answer is a body, and it never names the store.
    expect(judged.declarer?.leaks_store_root).toBe(false);
  });
});

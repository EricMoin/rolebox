/**
 * P4.2 criterion 3 — THE SUCCESSOR'S PERSISTED INPUT BINDING SURVIVES A REAL OS
 * PROCESS BOUNDARY.
 *
 * WHY THIS FILE EXISTS. The committed regression for criterion 3
 * (`tests/graph/runtime-input-binding.test.ts`) rebuilds the runtime in the SAME
 * process: it destroys the durable fact the binding was made of first, which is
 * strong evidence for the RULE, but a second runtime object in one process still
 * shares the module map, the warm caches and the memory of the process that
 * armed the attempt. This case drives the same window across a real boundary,
 * following the harness `tests/graph/host-restart-cross-process.test.ts`
 * established: the test process arranges the crash window, and a spawned
 * `bun` child (a different OS process, asserted by pid) rebuilds the runtime
 * from the persisted state and continues the dispatch.
 *
 * WHAT IS PINNED:
 *
 * 1. The parent accepts the producer's result, retains revision A, and the
 *    acceptance arms the successor with a bound input view — then the
 *    successor's create throws before delivery, so the dispatch effect is left
 *    `pending` exactly as a crash between commit and delivery leaves it.
 * 2. The mutable source path is replaced with B after the acceptance, and the
 *    parent stops: everything the child works from is the store file.
 * 3. The child re-derives the plan from the same declaration, reads the
 *    persisted state, resumes, and re-dispatches the successor with the ORIGINAL
 *    accepted payload and revision A while the source path on disk holds B.
 * 4. The child's recovered binding is byte-equal to the one the parent
 *    persisted (compared against the parent's own JSON), and exactly one
 *    accepted event exists before and after.
 *
 * THE CHILD DECLARES `durableCredentialStore: "platform-isolated"`. Re-delivering
 * an attempt the parent minted needs a process that never held the credential to
 * resolve it, and the shipped default deliberately retains none. That declaration
 * is the host's assertion about an OS boundary this test process cannot provide:
 * this case exercises THE BINDING AND THE CONSUMPTION, and makes no claim about
 * vault isolation.
 *
 * Every store lives under the OS temp directory and is removed by `afterEach`;
 * no `.rolebox` path and no workspace store is touched. Reports carry ids,
 * digests, counts and booleans — never a credential value.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type {
  OutcomeDispatchHost,
  OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import type { ResolvedInput } from "../../src/graph/outcome/inputs.ts";
import { artifactIdOf, digestOf } from "../../src/graph/store/artifacts.ts";
import {
  INPUT_BINDING_A,
  INPUT_BINDING_B,
  INPUT_BINDING_NOW,
  INPUT_BINDING_PRODUCER,
  INPUT_BINDING_REF,
  INPUT_BINDING_SUCCESSOR,
  inputBindingFixture,
  inputBindingRuntime,
  openInputBindingVault,
  writeInputBindingSource,
} from "./helpers/input-binding-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/input-binding-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;

// ── Child processes ─────────────────────────────────────────────────────────

interface WorkerReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly error?: string;
  readonly graphId?: string;
  readonly planRevision?: string;
  readonly resumeKind?: string;
  readonly dispatchedAttempts?: readonly string[];
  readonly resumedAttempts?: readonly string[];
  readonly successorAttemptId?: string | null;
  readonly persistedBinding?: unknown;
  readonly deliveredBinding?: unknown;
  readonly persistedBindingJson?: string;
  readonly deliveredBindingJson?: string;
  readonly persistedMatchesParentBytes?: boolean;
  readonly deliveredMatchesParentBytes?: boolean;
  readonly deliveredArtifactDigest?: string | null;
  readonly deliveredArtifactProblem?: string | null;
  readonly sourceDigest?: string | null;
  readonly acceptedEvents?: number;
  readonly materializationKind?: string;
  readonly materializedFileDigest?: string | null;
  readonly materializedProblems?: readonly string[];
}

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

/** Spawn one REAL bun process running the worker fixture and await its report. */
async function runWorker(args: readonly string[]): Promise<WorkerReport> {
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
      "input-binding worker (pid " +
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
      "input-binding worker (pid " +
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
      "input-binding worker (pid " +
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

// ── The parent's arrangement ────────────────────────────────────────────────

interface Arranged {
  /** The binding the acceptance committed for the successor. */
  readonly bound: readonly ResolvedInput[];
  readonly graphId: string;
  readonly planRevision: string;
  readonly acceptedEvents: number;
  readonly pendingEffects: readonly string[];
}

/** The one binding this window must produce, spelled by the parent. */
function expectedBinding(): readonly ResolvedInput[] {
  const digest = digestOf(INPUT_BINDING_A);
  return [
    {
      from: "work",
      outcome: "done",
      attemptId: INPUT_BINDING_PRODUCER,
      payload: { kind: "value", value: { report: "A" } },
      artifacts: [
        {
          ref: INPUT_BINDING_REF,
          artifactId: artifactIdOf(digest),
          digest,
          size: INPUT_BINDING_A.length,
        },
      ],
    },
  ];
}

/**
 * Drive the crash window up to (and including) its commit: the acceptance
 * settles the producer and arms the successor, and the successor's create throws
 * before delivery, so the dispatch effect stays `pending` for the next process.
 *
 * The ledger and the vault are CLOSED before returning: the child must reach the
 * same file through its own connections, never through this process's.
 */
async function arrangeCrashWindow(dir: string): Promise<Arranged> {
  const fixture = inputBindingFixture(dir);
  const ledger = await SqliteAcceptanceLedger.create(dir);
  const vault = openInputBindingVault(dir);
  try {
    const delivered: OutcomeDispatchRequest[] = [];
    const runtime = inputBindingRuntime({
      ledger,
      fixture,
      dispatch: (request) => {
        if (request.attemptId === INPUT_BINDING_SUCCESSOR) {
          throw new Error("fixture: the successor's create threw before delivery");
        }
        delivered.push(request);
      },
      isolation: vault.capability(),
    });
    const started = runtime.start(INPUT_BINDING_NOW);
    if (started.kind !== "started") {
      throw new Error("fixture: the graph did not start: " + started.kind);
    }
    const producer = delivered[0];
    if (producer === undefined) throw new Error("fixture: the producer was not dispatched");
    let threw = false;
    try {
      runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          credential: producer.credential,
          evidenceRefs: [INPUT_BINDING_REF],
          data: { report: "A" },
        },
        INPUT_BINDING_NOW + 1,
      );
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("fixture: the successor's create did not throw");
    const state = runtime.state();
    if (state === undefined) throw new Error("fixture: no state was committed");
    const successor = state.nodes.find((node) => node.nodeId === "review");
    const bound = successor?.inputs;
    if (bound === undefined || bound.length !== 1) {
      throw new Error("fixture: the successor was not armed with a bound input view");
    }
    return {
      bound,
      graphId: runtime.graphId,
      planRevision: runtime.planRevision,
      acceptedEvents: ledger.acceptedEvents(runtime.graphId).length,
      pendingEffects: ledger
        .pendingEffects(runtime.graphId)
        .map((effect) => effect.effectId + "@" + effect.status),
    };
  } finally {
    vault.close();
    ledger.close();
  }
}

// ── The boundary ────────────────────────────────────────────────────────────

describe("the input binding survives a real process boundary (criterion 3)", () => {
  it("a NEW OS PROCESS delivers the ORIGINAL payload and revision from the persisted binding, with one accepted event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "input-binding-xproc-"));
    tmpDirs.push(dir);

    // ── THE PARENT ARRANGES THE WINDOW. A is written, the gate reads and
    // retains it, the acceptance commits the successor's binding — and the
    // successor's create throws, leaving its dispatch effect `pending`.
    writeInputBindingSource(dir, INPUT_BINDING_A);
    const arranged = await arrangeCrashWindow(dir);
    expect(arranged.bound).toEqual(expectedBinding());
    expect(arranged.pendingEffects).toEqual([
      "dispatch:" + INPUT_BINDING_SUCCESSOR + "@pending",
    ]);
    expect(arranged.acceptedEvents).toBe(1);

    // The parent's OWN spelling of the binding, for the child to compare byte
    // for byte across the boundary.
    const bindingPath = join(dir, "expected-binding.json");
    writeFileSync(bindingPath, JSON.stringify(arranged.bound));

    // ── THE MUTABLE SOURCE PATH NOW HOLDS SOMETHING ELSE. If the child selected
    // the latest bytes at this path instead of the accepted revision, it would
    // deliver B.
    writeInputBindingSource(dir, INPUT_BINDING_B);

    // ── THE SECOND OS PROCESS: its own connections, no state from this process.
    const child = await runWorker([
      "--mode",
      "resume",
      "--root",
      dir,
      "--expected-binding",
      bindingPath,
    ]);

    expect(child.pid).not.toBe(process.pid);
    expect(child.mode).toBe("resume");
    expect(child.error).toBeUndefined();
    expect(child.graphId).toBe(arranged.graphId);
    expect(child.planRevision).toBe(arranged.planRevision);
    expect(child.resumeKind).toBe("resumed");
    expect(child.dispatchedAttempts).toEqual([INPUT_BINDING_SUCCESSOR]);
    expect(child.resumedAttempts).toEqual([INPUT_BINDING_SUCCESSOR]);
    expect(child.successorAttemptId).toBe(INPUT_BINDING_SUCCESSOR);

    // THE RECOVERED BINDING IS THE ONE THE PARENT PERSISTED — byte-equal to the
    // parent's own JSON, and the re-dispatched request carries that same value.
    expect(child.persistedBinding).toEqual(arranged.bound);
    expect(child.deliveredBinding).toEqual(arranged.bound);
    expect(child.persistedMatchesParentBytes).toBe(true);
    expect(child.deliveredMatchesParentBytes).toBe(true);
    expect(child.deliveredBindingJson).toBe(child.persistedBindingJson);

    // THE ORIGINAL ACCEPTED PAYLOAD AND REVISION, read in the CHILD, while the
    // mutable source path on disk holds B.
    expect(child.deliveredArtifactProblem).toBeNull();
    expect(child.deliveredArtifactDigest).toBe(digestOf(INPUT_BINDING_A));
    expect(child.sourceDigest).toBe(digestOf(INPUT_BINDING_B));
    expect(child.deliveredArtifactDigest).not.toBe(child.sourceDigest);

    // AND THE VIEW A WORKER WOULD BE HANDED carries A's bytes.
    expect(child.materializedProblems).toEqual([]);
    expect(child.materializationKind).toBe("ready");
    expect(child.materializedFileDigest).toBe(digestOf(INPUT_BINDING_A));

    // EXACTLY ONE ACCEPTED EVENT: the child continued the dispatch without
    // accepting anything again.
    expect(child.acceptedEvents).toBe(1);
  });
});

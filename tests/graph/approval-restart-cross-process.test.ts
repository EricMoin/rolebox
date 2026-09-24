/**
 * P3 item 3 — THE APPROVAL RESTART, ACROSS REAL PROCESSES
 * (plan §4 P3 "重启后继续", §5 A12 "可恢复").
 *
 * WHY THIS FILE EXISTS. The lifecycle cases in approval-lifecycle.test.ts run in
 * ONE process: they prove the pause and the decision are durable rows, but the
 * store object, the connection and the memory are shared. §4 asks for a restart,
 * and §P2 already fixed the shape a restart must take — a REAL process exit and
 * relaunch, never reopening an object.
 *
 * THE SHAPE. Every worker is
 * `Bun.spawn(process.execPath, <this directory>/helpers/approval-restart-xproc-worker.ts, …)`,
 * each prints ONE JSON report, and the parent asserts:
 *
 *   - PROCESS ONE (`raise`): raises a pending request through the SHIPPED control
 *     entry and EXITS. The pause is now a row in the workspace's one SQLite store,
 *     and the process that wrote it is gone.
 *   - THE PARENT (a different OS process from process one): the worker's own
 *     submission for the paused attempt is refused `approval-pending` — the gate
 *     is read from the durable row, by a process that never raised it, and the
 *     payload it carries claims the approval in two different shapes.
 *   - PROCESS TWO (`approve`): a fresh process decides the persisted request as
 *     the session the request NAMES, and the gate opens.
 *   - THE PARENT: the same submission now settles, exactly once.
 *   - PROCESS THREE (`approve` again): a THIRD process repeats the decision and is
 *     answered the REPLAY — the decided row does not move, and no second decision
 *     is recorded.
 *   - A FOURTH process (`read`) reports the durable facts as a later window sees
 *     them: one request, one `approval-request` decision, one `approve` decision,
 *     one receipt, one accepted event.
 *
 * NO real-host evidence: real subprocesses over the real workspace SQLite store is
 * this environment's ceiling.
 *
 * PRIVACY. Store roots live under the OS temp directory; every report carries
 * attempt ids, status tokens, counts and booleans only — never a credential value,
 * a real home-directory path or a session transcript.
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
  APPROVAL_RESTART_APPROVER,
  APPROVAL_RESTART_AT,
  APPROVAL_RESTART_DEADLINE,
  APPROVAL_RESTART_DECLARER,
  APPROVAL_RESTART_GRAPH,
} from "./helpers/approval-restart-xproc-worker.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/approval-restart-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;

/**
 * THE HARNESS BUDGET MUST EXCEED THIS FILE'S OWN CHILD DEADLINE, exactly as the
 * other cross-process slices carry it: a child that was merely SLOW would
 * otherwise have the CASE killed and its own diagnosis never written.
 */
setDefaultTimeout(CHILD_DEADLINE_MS + 15_000);

/** The declaration the parent persists before spawning any worker. */
function declaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: APPROVAL_RESTART_GRAPH,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
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
  readonly status?: string;
  readonly replayed?: boolean;
  readonly refusalCode?: string;
  readonly decidedAt?: number;
  readonly decisionReason?: string;
  readonly decidedBy?: string;
  readonly attemptId?: string;
  readonly approverSessionId?: string;
  readonly expiresAt?: number;
  readonly requests?: number;
  readonly decisionCommands?: readonly string[];
  readonly acceptedEvents?: number;
  readonly receipts?: number;
  readonly rounds?: number;
  readonly raised?: number;
  readonly expired?: number;
  readonly errors?: readonly string[];
}

/** The child session the platform "created" for one attempt. */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

/** One launched child, with the timer that kills a child which overruns. */
interface LaunchedWorker {
  readonly proc: {
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<number>;
    kill: () => void;
  };
  readonly mode: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Launch the checked-in worker WITHOUT waiting for it (a barrier needs two). */
function spawnWorker(
  mode: string,
  storeRoot: string,
  extra: readonly string[] = [],
): LaunchedWorker {
  const proc = Bun.spawn(
    [
      process.execPath,
      WORKER,
      "--mode",
      mode,
      "--root",
      storeRoot,
      "--graph",
      APPROVAL_RESTART_GRAPH,
      "--attempt",
      "work#1",
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { proc, mode, timer: setTimeout(() => proc.kill(), CHILD_DEADLINE_MS) };
}

/** Await one launched child and parse its ONE report line. */
async function collectWorker(worker: LaunchedWorker): Promise<WorkerReport> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(worker.proc.stdout).text(),
    new Response(worker.proc.stderr).text(),
    worker.proc.exited,
  ]);
  clearTimeout(worker.timer);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "approval-restart: worker " +
        worker.mode +
        " printed no report (exit " +
        String(exitCode) +
        "): " +
        stderr.slice(0, 400),
    );
  }
  const report = JSON.parse(line) as WorkerReport;
  if (report.ok !== true) {
    throw new Error(
      "approval-restart: worker " + worker.mode + " failed: " + String(report.error ?? line),
    );
  }
  return report;
}

/** Launch the checked-in worker and parse its ONE report line. */
async function runWorker(
  mode: string,
  storeRoot: string,
  extra: readonly string[] = [],
): Promise<WorkerReport> {
  return collectWorker(spawnWorker(mode, storeRoot, extra));
}

/** The shipped host assembly this parent uses, over a REAL declared graph. */
async function openParentFixture(): Promise<{
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly tools: Record<string, { execute: (args: unknown, context: unknown) => Promise<unknown> }>;
  readonly dispatched: OutcomeDispatchRequest[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "approval-restart-"));
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
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: createValidatorRegistry([]),
    outcomeArtifactRoot: dir,
    outcomeNow: APPROVAL_RESTART_AT,
  });
  const tools = opened.bindTools(createOutcomeGraphTools(toolset)) as Record<
    string,
    { execute: (args: unknown, context: unknown) => Promise<unknown> }
  >;
  const context = (sessionID: string, agent: string) => ({
    sessionID,
    messageID: "m1",
    agent,
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  });
  const declared = String(
    await tools["graph_declare"]?.execute({ declaration: declaration() }, context(APPROVAL_RESTART_DECLARER, "agent.declarer")),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("approval-restart: graph_declare refused: " + declared);
  }
  const started = await opened.startDeclaredGraph(APPROVAL_RESTART_GRAPH, {
    sessionId: APPROVAL_RESTART_DECLARER,
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("approval-restart: the graph did not start (" + started.kind + ")");
  }
  return { dir, storeRoot, host: opened, tools, dispatched };
}

/** The parent's own submission of the paused attempt's outcome. */
async function submitWork(
  fixture: Awaited<ReturnType<typeof openParentFixture>>,
): Promise<{ readonly decision?: string; readonly refusals?: readonly { readonly code?: string }[] }> {
  const request = fixture.dispatched[0];
  if (request === undefined) throw new Error("approval-restart: no dispatch was recorded");
  const raw = String(
    await fixture.tools["graph_submit_outcome"]?.execute(
      {
        graph_id: APPROVAL_RESTART_GRAPH,
        node_id: "work",
        outcome_id: "done",
        credential: request.credential,
        // The payload claims the approval in the two shapes the original defect
        // class used. Neither is read by the gate.
        data: { approved: true, decision: "approved" },
      },
      {
        sessionID: childSessionOf(request.attemptId),
        messageID: "m1",
        agent: "agent.work",
        directory: fixture.dir,
        worktree: fixture.dir,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      },
    ),
  );
  return JSON.parse(raw) as { readonly decision?: string; readonly refusals?: readonly { readonly code?: string }[] };
}

describe("approval restart across real processes", () => {
  it("keeps a raised request readable and actionable, and never re-decides it", async () => {
    const fixture = await openParentFixture();
    try {
      // PROCESS ONE: the pause is raised by a process that then EXITS.
      const raised = await runWorker("raise", fixture.storeRoot);
      expect(raised.kind).toBe("applied");
      expect(raised.status).toBe("pending");
      expect(raised.attemptId).toBe("work#1");
      expect(raised.approverSessionId).toBe(APPROVAL_RESTART_APPROVER);
      expect(raised.expiresAt).toBe(APPROVAL_RESTART_DEADLINE);

      // THE PARENT — a different OS process — is held by the durable row, and its
      // payload's claims reach nothing.
      const held = await submitWork(fixture);
      expect(held.decision).toBeUndefined();
      expect(held.refusals?.[0]?.code).toBe("approval-pending");

      // PROCESS TWO: a fresh process decides the persisted request.
      const approved = await runWorker("approve", fixture.storeRoot, [
        "--now",
        String(APPROVAL_RESTART_AT + 1),
      ]);
      expect(approved.kind).toBe("applied");
      expect(approved.status).toBe("approved");
      expect(approved.decidedAt).toBe(APPROVAL_RESTART_AT + 1);
      expect(approved.decidedBy).toBe(APPROVAL_RESTART_APPROVER);
      expect(approved.replayed).toBe(false);

      // THE GATE IS OPEN FOR THE PARENT, and the attempt settles exactly once.
      const settled = await submitWork(fixture);
      expect(settled.decision).toBe("accepted");

      // PROCESS THREE: a repeated decision in ANOTHER process is the REPLAY, and
      // the decided row does not move.
      const repeated = await runWorker("approve", fixture.storeRoot, [
        "--now",
        String(APPROVAL_RESTART_AT + 2),
        "--reason",
        "signed off again",
      ]);
      expect(repeated.kind).toBe("applied");
      expect(repeated.status).toBe("approved");
      expect(repeated.replayed).toBe(true);
      expect(repeated.decidedAt).toBe(APPROVAL_RESTART_AT + 1);
      expect(repeated.decisionReason).toBe("reviewed and signed off");

      // PROCESS FOUR: the durable facts a LATER window reads.
      const final = await runWorker("read", fixture.storeRoot);
      expect(final.status).toBe("approved");
      expect(final.requests).toBe(1);
      expect(final.decisionCommands).toEqual(["approval-request", "approve"]);
      expect(final.acceptedEvents).toBe(1);
      expect(final.receipts).toBe(1);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses the worker's own approval claim in every process", async () => {
    const fixture = await openParentFixture();
    try {
      await runWorker("raise", fixture.storeRoot);
      // The parent's submission is refused BEFORE anything is written; the store
      // the NEXT process reads is unchanged: still one pending request, no receipt.
      const held = await submitWork(fixture);
      expect(held.refusals?.[0]?.code).toBe("approval-pending");
      const observed = await runWorker("read", fixture.storeRoot);
      expect(observed.status).toBe("pending");
      expect(observed.requests).toBe(1);
      expect(observed.decisionCommands).toEqual(["approval-request"]);
      expect(observed.acceptedEvents).toBe(0);
      expect(observed.receipts).toBe(0);

      // A decision made by a process that is NOT the named approver is refused by
      // name, and the request stays pending for the next window.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const store_decisions = store.runs.controlDecisions(APPROVAL_RESTART_GRAPH);
        expect(store_decisions.map((entry) => entry.command)).toEqual(["approval-request"]);
      } finally {
        store.close();
      }
    } finally {
      fixture.host.close();
    }
  });
});

// ── The sweep, under two real processes ─────────────────────────────────────

/** How many raise-then-sweep rounds each of the two children runs. */
const SWEEP_ROUNDS = 20;

/**
 * Wait until every barrier file exists, or fail after a safety deadline.
 *
 * The deadline is not an assertion: it only stops a broken child from hanging
 * the case. Nothing here measures how long a sweep takes.
 */
async function waitForFiles(paths: readonly string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() > deadline) {
      throw new Error("approval-restart: the sweep children never reached the barrier");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("approval sweep across real processes", () => {
  it("sweeps the same due requests from two processes with no lock failure", async () => {
    const fixture = await openParentFixture();
    try {
      // THE BARRIER. Both children open their OWN connection, declare
      // themselves ready, and then block; the parent releases them together, so
      // the two sweeps really overlap instead of merely being capable of it.
      const readyA = join(fixture.dir, "sweep-a.ready");
      const readyB = join(fixture.dir, "sweep-b.ready");
      const go = join(fixture.dir, "sweep.go");
      const extra = (ready: string): readonly string[] => [
        "--rounds",
        String(SWEEP_ROUNDS),
        "--ready",
        ready,
        "--go",
        go,
      ];
      const children = [
        spawnWorker("sweep-race", fixture.storeRoot, extra(readyA)),
        spawnWorker("sweep-race", fixture.storeRoot, extra(readyB)),
      ];
      await waitForFiles([readyA, readyB]);
      writeFileSync(go, "");
      const reports = await Promise.all(children.map((child) => collectWorker(child)));

      // NO CALL LOST ITS TURN TO THE LOCK. Before the sweep took the write lock
      // as its FIRST statement, a shared-to-reserved promotion under the other
      // connection was refused IMMEDIATELY — "database is locked", not a
      // busy-timeout wait — and the same failure rejected a host boot instead of
      // recording an expiry.
      for (const report of reports) {
        expect(report.errors).toEqual([]);
        expect(report.rounds).toBe(SWEEP_ROUNDS);
        expect(report.raised).toBe(SWEEP_ROUNDS);
      }

      // EVERY RAISED ROW WAS EXPIRED EXACTLY ONCE, by one process or the other:
      // the two sweeps PARTITION the due rows rather than both claiming one, so
      // the lock serializes them instead of letting a read race a write.
      const expired = reports.reduce((total, report) => total + (report.expired ?? -1), 0);
      expect(expired).toBe(2 * SWEEP_ROUNDS);

      // THE DURABLE FACTS a later window reads: every race row is terminal and
      // none was left pending by the losing sweep.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const races = store.approvals
          .approvalRequestsOf(APPROVAL_RESTART_GRAPH)
          .filter((request) => request.attemptId.startsWith("race#"));
        expect(races.length).toBe(2 * SWEEP_ROUNDS);
        expect(races.every((request) => request.status === "expired")).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      fixture.host.close();
    }
  });
});

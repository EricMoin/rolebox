/**
 * P3 item 2 — TERMINAL-GRAPH RE-EXECUTION: a NEW run, the old one untouched.
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR (plan §3.2 "终态图重新运行创建新 Run；节点重试创建新
 * Attempt", §4 "创建新 run，保留旧 run 和回执；修改有效 plan 形成新 revision，不能改写旧
 * attempt 的语义", §5 A11, and §8.5 G3):
 *
 * - a RUN-SCOPED retry records a durable trusted ORDER to re-execute a terminal run and
 *   CLOSES the run it supersedes (its control fact becomes `retry` when no other command
 *   stopped it first);
 * - the successor is a NEW RUN: a new run identity, the next graph-local `runSeq`, its own
 *   plan revision, its own state snapshot, and attempt ids that CONTINUE the graph-wide
 *   sequence — while the old run's row, state, receipts, accepted events, effects and
 *   decisions stay exactly as they were and stay readable by the old run's own id;
 * - a run that is still executing, or whose external work is unaccounted for, is REFUSED:
 *   re-executing a graph whose side effects may still be live is what §4 forbids;
 * - the ORDER is idempotent and outlives the process that decided it: the boot sweep
 *   honours an owed order, and a second sweep does not execute it twice;
 * - a changed effective plan forms a NEW revision: the successor's row and state record the
 *   revision it executes, and every earlier run keeps the revision its receipts were
 *   accepted under;
 * - G3 IS LIVE HERE: with TWO runs on one graph, the effect and control reads answer ONE
 *   run — the current one by default, any run by its own id.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real OutcomeHost over the workspace's one SQLite
 * store, the real toolset, and the `withCancelDelivery` follow-up both entries install.
 *
 * STRENGTH: adapter + real store, one process. The retry's RESTART half is additionally
 * driven across REAL OS processes by `tests/graph/retry-restart-cross-process.test.ts`,
 * which spawns the checked-in worker with `Bun.spawn(process.execPath, …)`. No real dsh/Pi
 * SDK runs here, so nothing in this file is real-host evidence.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost, withCancelDelivery } from "../../src/graph/host/outcome-host.ts";
import { attemptCredentialDigest } from "../../src/graph/outcome/attempt-credential.ts";
import type { OutcomeExecutionCancellation } from "../../src/graph/outcome/cancel.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { runGraphControlEntry } from "../../src/graph/tools/control-entry.ts";
import { createGraphToolSet, type GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../src/platform/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** One entry node: the smallest graph with a run worth replacing. */
const SOLO: GraphDeclarationV3 = {
  version: 3,
  name: "reexecute.solo",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

const FIXED_AT = 1_700_000_000_000;
const ORDER_AT = FIXED_AT + 1_000;
const REEXECUTE_AT = FIXED_AT + 2_000;

/**
 * A DETERMINISTIC credential source: the successor attempt's value is predictable, so a
 * test can prove a new credential was minted without ever printing one.
 */
const credentialSource = (binding: { readonly attemptId: string }): string =>
  "credential:" + binding.attemptId;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

function makeContext(sessionID: string, agent: string, directory: string): CanonicalToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent,
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

interface ReexecFixture {
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatched: OutcomeDispatchRequest[];
  readonly storeRoot: string;
  readonly workspaceDir: string;
  readonly graphId: string;
  readonly declarer: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

/**
 * One shipped assembly over a REAL declared graph.
 *
 * `cancelling` installs this host's platform cancel port: WITH it a trusted cancel is
 * PLATFORM-CONFIRMED (the effect becomes `done`, so the execution is accounted for and a
 * re-execution may proceed); WITHOUT it the cancel intent stays unconfirmed and the
 * external execution keeps blocking a re-execution.
 */
async function openReexecFixture(options: {
  readonly cancelling?: boolean;
} = {}): Promise<ReexecFixture> {
  const dir = makeTmpDir("run-reexecution-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const cancelPort: OutcomeExecutionCancellation | undefined =
    options.cancelling === true
      ? {
          async cancel() {
            return { kind: "confirmed" as const, reason: "the fake platform confirmed the abort" };
          },
        }
      : undefined;
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
    ...(cancelPort === undefined ? {} : { cancelExecution: cancelPort }),
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: createValidatorRegistry([]),
    outcomeArtifactRoot: dir,
    outcomeMintCredential: credentialSource,
  });
  const declarer = "session.declarer";
  const fixture: ReexecFixture = {
    host: opened,
    toolset,
    tools: opened.bindTools(withCancelDelivery(createOutcomeGraphTools(toolset), opened)),
    dispatched,
    storeRoot,
    workspaceDir: dir,
    graphId: SOLO.name,
    declarer,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
  };
  const declared = String(
    await fixture.tools.graph_declare.execute(
      { declaration: SOLO },
      fixture.contextOf(declarer, "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await opened.startDeclaredGraph(SOLO.name, {
    sessionId: declarer,
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return fixture;
}

/** One control answer, as the tool renders it. */
interface ControlAnswer {
  readonly kind?: "applied" | "refused";
  readonly graphId?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly scope?: "attempt" | "run";
  readonly minted?: readonly { readonly attemptId: string }[];
  readonly runControl?: { readonly command: string };
  readonly reexecution?: {
    readonly fromRunId: string;
    readonly order: {
      readonly runId: string;
      readonly reason: string;
      readonly successorRunId?: string;
    };
  };
  readonly refusals?: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
}

/** Run one command through the SHIPPED `graph_control` tool (and its follow-up). */
async function control(
  fixture: ReexecFixture,
  args: Record<string, unknown>,
): Promise<ControlAnswer> {
  const raw = String(
    await fixture.tools.graph_control.execute(
      args,
      fixture.contextOf(fixture.declarer, "agent.declarer"),
    ),
  );
  if (raw.startsWith("graph_control failed:")) {
    throw new Error("fixture: graph_control failed: " + raw);
  }
  return JSON.parse(raw) as ControlAnswer;
}

/** Settle `work` through the SHIPPED submission ingress. */
async function settleWork(fixture: ReexecFixture, attemptId: string): Promise<string> {
  const request = fixture.dispatched.find((candidate) => candidate.attemptId === attemptId);
  if (request === undefined) throw new Error("fixture: no dispatch for attempt " + attemptId);
  const raw = String(
    await fixture.tools.graph_submit_outcome.execute(
      {
        graph_id: fixture.graphId,
        node_id: "work",
        outcome_id: "done",
        credential: request.credential,
      },
      fixture.contextOf(childSessionOf(attemptId), "agent.work"),
    ),
  );
  const answer = JSON.parse(raw) as {
    readonly decision?: string;
    readonly refusals?: readonly { readonly code: string }[];
  };
  return (
    answer.decision ??
    "refused:" + (answer.refusals ?? []).map((refusal) => refusal.code).join(",")
  );
}

/** With one store connection: run the callback over the workspace's store. */
function withStore<T>(fixture: ReexecFixture, run: (store: GraphStore) => T): T {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/** The persisted entry of one node in ONE run's own snapshot. */
function nodeEntryOf(
  fixture: ReexecFixture,
  runId: string,
  nodeId: string,
): Record<string, unknown> {
  return withStore(fixture, (store) => {
    const record = store.readGraphStateOf(fixture.graphId, runId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : {};
    const nodes = Array.isArray(body["nodes"])
      ? (body["nodes"] as readonly Record<string, unknown>[])
      : [];
    const entry = nodes.find((node) => node["nodeId"] === nodeId);
    if (entry === undefined) throw new Error("fixture: no entry for " + nodeId + " in " + runId);
    return entry;
  });
}

/** Record ONLY the trusted order (no host follow-up), as a crash window would leave it. */
function orderReexecution(fixture: ReexecFixture): void {
  const answer = runGraphControlEntry(
    { storeDirectory: fixture.storeRoot, now: ORDER_AT },
    {
      graph_id: fixture.graphId,
      command: "retry",
      reason: "re-run the whole graph",
    },
    fixture.declarer,
    "agent.declarer",
  );
  if (answer.kind !== "applied") {
    throw new Error("fixture: the order was refused (" + JSON.stringify(answer.refusals) + ")");
  }
}

// ── The order and the new run ───────────────────────────────────────────────

describe("terminal-graph re-execution — a NEW run", () => {
  it("orders a successor run for a COMPLETE run, closes it, and the shipped follow-up mints the new run", async () => {
    const fixture = await openReexecFixture();
    try {
      expect(await settleWork(fixture, "work#1")).toBe("accepted");
      const firstRunId = withStore(fixture, (store) => store.runs.readRun(fixture.graphId)?.runId);
      if (firstRunId === undefined) throw new Error("fixture: the run was not minted");
      const firstState = withStore(fixture, (store) =>
        store.readGraphState(fixture.graphId),
      );

      const answer = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        reason: "re-run the whole graph",
      });

      expect(answer.kind).toBe("applied");
      expect(answer.command).toBe("retry");
      // A RUN-SCOPED retry acts on the RUN, mints no attempt itself, and records the
      // order with no successor yet: the successor is the follow-up's work.
      expect(answer.scope).toBe("run");
      expect(answer.minted).toEqual([]);
      expect(answer.runControl?.command).toBe("retry");
      expect(answer.reexecution?.fromRunId).toBe(firstRunId);
      expect(answer.reexecution?.order.reason).toBe("re-run the whole graph");
      expect(answer.reexecution?.order.successorRunId).toBeUndefined();

      const runs = withStore(fixture, (store) => store.runs.runsOf(fixture.graphId));
      expect(runs.map((run) => run.runSeq)).toEqual([1, 2]);
      const [first, second] = runs;
      expect(first?.runId).toBe(firstRunId);
      // THE OLD RUN IS CLOSED BY THE ORDER (first-wins: a cancel's fact is never replaced).
      expect(withStore(fixture, (store) => store.runs.readRunControlOf(fixture.graphId, firstRunId))?.command).toBe(
        "retry",
      );
      // THE ORDER IS CONSUMED EXACTLY ONCE, and names its successor.
      expect(
        withStore(fixture, (store) => store.runs.readReexecution(fixture.graphId, firstRunId))
          ?.successorRunId,
      ).toBe(second?.runId);
      expect(second?.planRevision).toBe(first?.planRevision);

      // THE SUCCESSOR IS A NEW RUN: its own identity, its own state snapshot, and an
      // attempt sequence that CONTINUES the graph-wide counter.
      expect(nodeEntryOf(fixture, second?.runId ?? "", "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#2",
        attemptSeq: 2,
      });
      // THE OLD RUN'S STATE IS UNTOUCHED, and the old receipt and accepted event are
      // still readable under the old run's own id.
      const oldState = withStore(fixture, (store) =>
        store.readGraphStateOf(fixture.graphId, firstRunId),
      );
      expect(oldState).toEqual(firstState);
      expect(nodeEntryOf(fixture, firstRunId, "work")).toMatchObject({
        status: "settled",
        attemptId: "work#1",
        outcomeId: "done",
      });
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([
        expect.objectContaining({ attemptId: "work#1", outcomeId: "done" }),
      ]);

      // THE OLD ATTEMPT'S SEMANTICS CANNOT BE REWRITTEN: its credential no longer
      // resolves (the run path reads the CURRENT run's state), so nothing can settle
      // the attempt the old run already accounted for.
      const oldCredential = fixture.dispatched.find(
        (request) => request.attemptId === "work#1",
      )?.credential;
      if (oldCredential === undefined) throw new Error("fixture: no dispatch for work#1");
      const stale = JSON.parse(
        String(
          await fixture.tools.graph_submit_outcome.execute(
            {
              graph_id: fixture.graphId,
              node_id: "work",
              outcome_id: "done",
              credential: oldCredential,
            },
            fixture.contextOf(childSessionOf("work#1"), "agent.work"),
          ),
        ),
      ) as { readonly decision?: string; readonly refusals?: readonly { readonly code: string }[] };
      expect(stale.decision).toBeUndefined();
      expect(stale.refusals?.map((refusal) => refusal.code)).toEqual(["credential-unknown"]);

      // AND THE SUCCESSOR IS LIVE: its worker settles the new attempt.
      expect(await settleWork(fixture, "work#2")).toBe("accepted");
    } finally {
      fixture.host.close();
    }
  });

  it("scopes the effect and control reads to ONE run when a graph has TWO (G3)", async () => {
    const fixture = await openReexecFixture({ cancelling: true });
    try {
      // A cancelled (platform-CONFIRMED) run: its dispatch effect stays unsettled —
      // a cancel never rewinds one — but the confirmed cancellation accounts for the
      // external execution, so a re-execution may proceed.
      const cancelled = await control(fixture, {
        graph_id: fixture.graphId,
        command: "cancel",
        reason: "stop it",
      });
      expect(cancelled.kind).toBe("applied");
      const firstRunId = withStore(fixture, (store) => store.runs.readRun(fixture.graphId)?.runId);
      if (firstRunId === undefined) throw new Error("fixture: the run was not minted");

      const ordered = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        reason: "re-run it",
      });
      expect(ordered.kind).toBe("applied");
      expect(ordered.scope).toBe("run");
      const runs = withStore(fixture, (store) => store.runs.runsOf(fixture.graphId));
      expect(runs.map((run) => run.runSeq)).toEqual([1, 2]);
      const secondRunId = runs[1]?.runId ?? "";

      // A decision ON the successor run, so the control read has a fact to scope in
      // BOTH directions instead of two empty lists.
      const stoppedAgain = await control(fixture, {
        graph_id: fixture.graphId,
        command: "failure",
        node_id: "work",
        reason: "the successor's worker died",
      });
      expect(stoppedAgain.kind).toBe("applied");

      withStore(fixture, (store) => {
        // EFFECTS ARE RUN-SCOPED. The old run still holds its unsettled dispatch (a
        // cancelled execution's effect is never rewound), and the CURRENT run's read
        // does NOT answer with it.
        expect(
          store.pendingEffects(fixture.graphId).map((effect) => effect.runId),
        ).toEqual([secondRunId]);
        expect(
          store.pendingEffects(fixture.graphId).map((effect) => effect.effectId),
        ).toEqual(["dispatch:work#2"]);
        expect(
          store.pendingEffects(fixture.graphId, firstRunId).map((effect) => effect.effectId),
        ).toEqual(["dispatch:work#1"]);
        // CONTROL DECISIONS ARE RUN-SCOPED, in both directions.
        expect(
          store.runs.controlDecisions(fixture.graphId).map((decision) => decision.runId),
        ).toEqual([secondRunId]);
        expect(
          store.runs.controlDecisions(fixture.graphId).map((decision) => decision.command),
        ).toEqual(["failure"]);
        expect(
          store.runs
            .controlDecisions(fixture.graphId, firstRunId)
            .map((decision) => decision.command),
        ).toEqual(["cancel"]);
        // THE RUN-LEVEL FACTS ARE RUN-SCOPED TOO, and the state reads follow.
        expect(store.runs.readRunControl(fixture.graphId)?.command).toBe("failure");
        expect(store.runs.readRunControlOf(fixture.graphId, firstRunId)?.command).toBe("cancel");
        expect(store.readGraphState(fixture.graphId)?.runId).toBe(secondRunId);
        expect(store.readGraphStateOf(fixture.graphId, firstRunId)?.runId).toBe(firstRunId);
      });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses an acceptance and an effect transition for a SUPERSEDED run at the STORE, naming the run", async () => {
    const fixture = await openReexecFixture({ cancelling: true });
    try {
      // A run closed by a platform-CONFIRMED cancel: its dispatch effect stays
      // UNSETTLED (a cancel never rewinds one) and the re-execution is allowed,
      // so the closed run holds an effect a late writer could still try to move.
      const cancelled = await control(fixture, {
        graph_id: fixture.graphId,
        command: "cancel",
        reason: "stop it",
      });
      expect(cancelled.kind).toBe("applied");
      const ordered = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        reason: "re-run it",
      });
      expect(ordered.kind).toBe("applied");
      const runs = withStore(fixture, (store) => store.runs.runsOf(fixture.graphId));
      expect(runs.map((run) => run.runSeq)).toEqual([1, 2]);
      const firstRunId = runs[0]?.runId ?? "";
      const secondRunId = runs[1]?.runId ?? "";
      const firstRevision = runs[0]?.planRevision ?? "";
      const oldState = withStore(fixture, (store) =>
        store.readGraphStateOf(fixture.graphId, firstRunId),
      );

      withStore(fixture, (store) => {
        // A CLOSED RUN ACCEPTS NOTHING. The attempt's own dispatch effect is
        // filed under run 1, so the batch write's own guard refuses it — no
        // receipt, no accepted event, no accepted result — and the verdict NAMES
        // the run the attempt belongs to.
        const verdict = store.commitAccepted({
          receipt: {
            graphId: fixture.graphId,
            attemptId: "work#1",
            submissionId: "submission:superseded-run",
            planRevision: firstRevision,
            proposalDigest: "digest:superseded-run",
            decision: "accepted",
            committedAt: ORDER_AT,
          },
          acceptedEvent: {
            graphId: fixture.graphId,
            attemptId: "work#1",
            submissionId: "submission:superseded-run",
            planRevision: firstRevision,
            outcomeId: "done",
            acceptedAt: ORDER_AT,
          },
        });
        expect(verdict.kind).toBe("run-superseded");
        if (verdict.kind !== "run-superseded") throw new Error("fixture: expected run-superseded");
        expect(verdict.runId).toBe(firstRunId);
        expect(verdict.reason).toContain(firstRunId);
        expect(
          store.lookupReceipt({
            graphId: fixture.graphId,
            attemptId: "work#1",
            submissionId: "submission:superseded-run",
          }),
        ).toBeUndefined();
        expect(store.acceptedEvents(fixture.graphId)).toEqual([]);
        expect(store.readAcceptedResult(fixture.graphId, "work#1")).toBeUndefined();

        // A SUPERSEDED RUN'S EFFECTS ARE IMMUTABLE TOO. The transition is
        // refused by name (naming both runs), and the row keeps the status it
        // had — an abandoned execution stays VISIBLE instead of being settled on
        // the successor's behalf.
        const transition = store.markEffectDone(fixture.graphId, "dispatch:work#1");
        expect(transition.kind).toBe("refused");
        if (transition.kind !== "refused") throw new Error("fixture: expected refused");
        expect(transition.effect.status).toBe("started");
        expect(transition.reason).toContain(firstRunId);
        expect(transition.reason).toContain(secondRunId);
        expect(
          store.pendingEffects(fixture.graphId, firstRunId).map((effect) => [
            effect.effectId,
            effect.status,
          ]),
        ).toEqual([["dispatch:work#1", "started"]]);

        // THE FENCE IS SCOPED, NOT BLANKET: the CURRENT run's attempt still
        // commits and its own effect still transitions.
        const successor = store.commitAccepted({
          receipt: {
            graphId: fixture.graphId,
            attemptId: "work#2",
            submissionId: "submission:current-run",
            planRevision: firstRevision,
            proposalDigest: "digest:current-run",
            decision: "accepted",
            committedAt: ORDER_AT + 1,
          },
          acceptedEvent: {
            graphId: fixture.graphId,
            attemptId: "work#2",
            submissionId: "submission:current-run",
            planRevision: firstRevision,
            outcomeId: "done",
            acceptedAt: ORDER_AT + 1,
          },
        });
        expect(successor.kind).toBe("committed");
        expect(store.markEffectDone(fixture.graphId, "dispatch:work#2").kind).toBe(
          "transitioned",
        );
      });

      // THE CLOSED RUN IS EXACTLY WHAT IT WAS: its state snapshot, its control
      // fact, its effect and (no) receipts. Only the CURRENT run moved.
      expect(
        withStore(fixture, (store) => store.readGraphStateOf(fixture.graphId, firstRunId)),
      ).toEqual(oldState);
      expect(
        withStore(
          fixture,
          (store) => store.runs.readRunControlOf(fixture.graphId, firstRunId)?.command,
        ),
      ).toBe("cancel");
      expect(withStore(fixture, (store) => store.readGraphState(fixture.graphId)?.runId)).toBe(
        secondRunId,
      );
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a run-scoped retry while the run is STILL EXECUTING, and writes nothing", async () => {
    const fixture = await openReexecFixture();
    try {
      const answer = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        reason: "too early",
      });
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("run-not-terminal");
      expect(answer.refusals?.[0]?.message).toContain("node-scoped");
      const runs = withStore(fixture, (store) => store.runs.runsOf(fixture.graphId));
      expect(runs).toHaveLength(1);
      expect(
        withStore(fixture, (store) =>
          store.runs.readReexecution(fixture.graphId, runs[0]?.runId ?? ""),
        ),
      ).toBeUndefined();
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a run-scoped retry while an external execution's fate is UNKNOWN, and names it", async () => {
    // No cancel port: the trusted cancel is durable but the platform never confirmed
    // it, so the execution it targets may still be live.
    const fixture = await openReexecFixture();
    try {
      const cancelled = await control(fixture, {
        graph_id: fixture.graphId,
        command: "cancel",
        reason: "stop it",
      });
      expect(cancelled.kind).toBe("applied");
      const answer = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        reason: "re-run it anyway",
      });
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("run-has-unsettled-effects");
      expect(answer.refusals?.[0]?.message).toContain("dispatch:work#1");
      // NOTHING WAS WRITTEN: no order, no successor run.
      expect(withStore(fixture, (store) => store.runs.runsOf(fixture.graphId))).toHaveLength(1);
      const runId = withStore(fixture, (store) => store.runs.readRun(fixture.graphId)?.runId) ?? "";
      expect(
        withStore(fixture, (store) => store.runs.readReexecution(fixture.graphId, runId)),
      ).toBeUndefined();
    } finally {
      fixture.host.close();
    }
  });
});
// ── The order is durable, and honoured exactly once ─────────────────────────

describe("terminal-graph re-execution — the order outlives its process", () => {
  it("replays a repeated order and is honoured by the boot sweep exactly once", async () => {
    const fixture = await openReexecFixture();
    try {
      expect(await settleWork(fixture, "work#1")).toBe("accepted");
      const firstRunId = withStore(fixture, (store) => store.runs.readRun(fixture.graphId)?.runId);
      if (firstRunId === undefined) throw new Error("fixture: the run was not minted");

      // The ORDER only — no host follow-up, which is the crash window a restart
      // leaves behind: the trusted decision is durable and the successor is owed.
      orderReexecution(fixture);
      orderReexecution(fixture);
      expect(withStore(fixture, (store) => store.runs.runsOf(fixture.graphId))).toHaveLength(1);
      const owed = withStore(fixture, (store) =>
        store.runs.readReexecution(fixture.graphId, firstRunId),
      );
      expect(owed).toMatchObject({ reason: "re-run the whole graph" });
      expect(owed?.successorRunId).toBeUndefined();

      // THE SWEEP IS THE WINDOW THAT HONOURS IT — and it says so in its own
      // bucket instead of reporting a re-executed graph as merely resumed.
      const first = await fixture.host.recoverDeclaredGraphs();
      const runs = withStore(fixture, (store) => store.runs.runsOf(fixture.graphId));
      expect(runs).toHaveLength(2);
      expect(first.reexecuted).toEqual([
        fixture.graphId + ":" + firstRunId + "->" + (runs[1]?.runId ?? ""),
      ]);
      expect(first.resumed.some((entry) => entry.startsWith(fixture.graphId + ":"))).toBe(false);
      expect(
        withStore(fixture, (store) => store.runs.readReexecution(fixture.graphId, firstRunId))
          ?.successorRunId,
      ).toBe(runs[1]?.runId);

      // A SECOND SWEEP DOES NOT EXECUTE IT AGAIN: the current run is the successor,
      // which carries no order of its own.
      const second = await fixture.host.recoverDeclaredGraphs();
      expect(second.reexecuted).toEqual([]);
      expect(withStore(fixture, (store) => store.runs.runsOf(fixture.graphId))).toHaveLength(2);
      expect(second.resumed).toEqual([fixture.graphId + ":executing"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── A changed effective plan forms a NEW revision ──────────────────────────

describe("terminal-graph re-execution — a changed plan is a NEW revision", () => {
  it("records the revision it executes while every earlier run keeps its own", async () => {
    const fixture = await openReexecFixture();
    try {
      expect(await settleWork(fixture, "work#1")).toBe("accepted");
      const firstRunId = withStore(fixture, (store) => store.runs.readRun(fixture.graphId)?.runId);
      if (firstRunId === undefined) throw new Error("fixture: the run was not minted");
      const firstReceipt = withStore(fixture, (store) =>
        store.lookupReceipt({
          graphId: fixture.graphId,
          attemptId: "work#1",
          submissionId: store.acceptedEvents(fixture.graphId)[0]?.submissionId ?? "",
        }),
      );
      if (firstReceipt === undefined) throw new Error("fixture: no receipt for work#1");
      orderReexecution(fixture);

      // THE SAME GRAPH ID, A DIFFERENT PLAN BODY: the compiled revision is
      // content-addressed, so an edited plan is a NEW revision rather than a new
      // meaning for the stored one.
      const changed = buildDeclaredOutcomeGraph({
        declaration: {
          ...SOLO,
          nodes: [
            {
              id: "work",
              agent: "agent.work",
              prompt: "Do the work, differently.",
              outcomes: [{ id: "done" }],
            },
          ],
        },
      });
      expect(changed.plan.planRevision).not.toBe(firstReceipt.planRevision);

      const ledger = await SqliteAcceptanceLedger.create(fixture.storeRoot);
      try {
        const runtime = new OutcomeGraphRuntime({
          plan: changed.plan,
          ledger,
          dispatch: () => undefined,
          validators: createValidatorRegistry([]),
          artifactRoot: fixture.workspaceDir,
          clock: () => REEXECUTE_AT,
          mintCredential: credentialSource,
          credentialIsolation: fixture.host.credentialIsolation,
        });
        const reexecuted = runtime.reexecute(REEXECUTE_AT);
        expect(reexecuted.kind).toBe("reexecuted");
        if (reexecuted.kind !== "reexecuted") {
          throw new Error("fixture: the re-execution was refused");
        }
        expect(reexecuted.planRevision).toBe(changed.plan.planRevision);
        expect(reexecuted.fromRunId).toBe(firstRunId);
        expect(reexecuted.runSeq).toBe(2);
        // The successor's attempt sequence CONTINUES, so no attempt id is reused.
        expect(reexecuted.state.nodes.map((node) => node.attemptId)).toEqual(["work#2"]);

        // THE ORDER IS CONSUMED: a second re-execution has nothing to authorize it.
        const again = runtime.reexecute(REEXECUTE_AT + 1);
        expect(again.kind).toBe("refused");
        if (again.kind !== "refused") throw new Error("fixture: expected a refusal");
        expect(again.refusals.map((refusal) => refusal.code)).toEqual([
          "reexecution-not-authorized",
        ]);
      } finally {
        ledger.close();
      }

      withStore(fixture, (store) => {
        const runs = store.runs.runsOf(fixture.graphId);
        expect(runs.map((run) => run.runSeq)).toEqual([1, 2]);
        // THE NEW RUN ROW AND STATE RECORD THE NEW REVISION...
        expect(runs[1]?.planRevision).toBe(changed.plan.planRevision);
        expect(store.readGraphState(fixture.graphId)?.planRevision).toBe(
          changed.plan.planRevision,
        );
        // ...AND THE OLD RUN KEEPS ITS OWN, in its row, its state and its receipt.
        expect(runs[0]?.planRevision).toBe(firstReceipt.planRevision);
        expect(store.readGraphStateOf(fixture.graphId, firstRunId)?.planRevision).toBe(
          firstReceipt.planRevision,
        );
        expect(store.lookupReceipt({
          graphId: fixture.graphId,
          attemptId: firstReceipt.attemptId,
          submissionId: firstReceipt.submissionId,
        })).toEqual(firstReceipt);
      });
    } finally {
      fixture.host.close();
    }
  });
});
// ── The retry survives a restart ───────────────────────────────────────────

describe("retry — restart continuity", () => {
  it("hands a pending successor effect to the NEXT host exactly once", async () => {
    const fixture = await openReexecFixture();
    const dir = fixture.workspaceDir;
    const storeRoot = fixture.storeRoot;
    const graphId = fixture.graphId;
    const declarer = fixture.declarer;
    let retried = false;
    try {
      // The ORDER/DECISION and the successor EFFECT are committed by the entry
      // alone; no follow-up runs, which is exactly the crash window a restart
      // leaves behind.
      const answer = runGraphControlEntry(
        {
          storeDirectory: storeRoot,
          now: ORDER_AT,
          credentialIsolation: fixture.host.credentialIsolation,
          mintCredential: credentialSource,
        },
        {
          graph_id: graphId,
          command: "retry",
          node_id: "work",
          reason: "supersede before the crash",
        },
        declarer,
        "agent.declarer",
      );
      expect(answer.kind).toBe("applied");
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual(["work#1"]);
      retried = true;
    } finally {
      fixture.host.close();
    }
    if (!retried) throw new Error("fixture: the retry was not applied");

    // A NEW host OBJECT over the same store root — one process, and (because the
    // store shares one connection per file in-process) the same connection. The
    // durable retry is what it resumes from, and the successor's effect is
    // launched ONCE. The real process boundary is a separate tracked case:
    // `tests/graph/retry-restart-cross-process.test.ts` spawns actual OS
    // processes, which is what §4 P3's "重启后继续" is measured with.
    const dispatched: OutcomeDispatchRequest[] = [];
    let reopened: OutcomeHost | undefined;
    const second = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request, effect) => {
        dispatched.push(request);
        reopened?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
      },
      validators: createValidatorRegistry([]),
      declareInvocationIdentity: false,
      workerSessionOf: (execution) => execution.executionId,
    });
    reopened = second;
    try {
      const resumed = await second.startDeclaredGraph(graphId, {
        sessionId: declarer,
        agent: "agent.declarer",
      });
      expect(resumed.kind).toBe("resumed");
      expect(dispatched.map((request) => request.attemptId)).toEqual(["work#2"]);
      // THE VALUE IS THE ONE THE STATE VERIFIES. The shipped vault keeps credential
      // VALUES in memory only, so a restart re-issues a lost one under the create-right
      // fence (§3.3); what matters is that the dispatched value is exactly the value the
      // persisted digest was written for — never a credential the store does not record.
      const deliveredCredential = dispatched[0]?.credential ?? "";
      expect(deliveredCredential.length).toBeGreaterThan(0);
      expect(
        withStore(fixture, (store) => {
          const record = store.readGraphState(graphId);
          const body =
            typeof record?.body === "object" && record.body !== null
              ? (record.body as Record<string, unknown>)
              : {};
          const nodes = Array.isArray(body["nodes"])
            ? (body["nodes"] as readonly Record<string, unknown>[])
            : [];
          return nodes.find((node) => node["attemptId"] === "work#2")?.[
            "attemptCredentialDigest"
          ];
        }),
      ).toBe(attemptCredentialDigest(deliveredCredential));
      // The superseded attempt's effect stays UNSETTLED and is reported: the
      // restart neither re-launches it nor hides it.
      if (resumed.kind !== "resumed") throw new Error("fixture: expected a resume");
      expect(
        resumed.unsettledEffects.map((effect) => effect.effectId).sort(),
      ).toEqual(["dispatch:work#1", "dispatch:work#2"]);
      expect(resumed.armed.map((node) => node.attemptId)).toEqual(["work#2"]);
    } finally {
      second.close();
    }

    const store = GraphStore.openFile(storeRoot);
    try {
      expect(store.runs.controlDecisions(graphId).map((decision) => decision.command)).toEqual([
        "retry",
      ]);
      expect(store.readGraphState(graphId)?.runId).toBeDefined();
    } finally {
      store.close();
    }
  });
});

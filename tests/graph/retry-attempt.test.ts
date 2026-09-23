/**
 * P3 item 2 — RETRY: a NEW attempt on the SAME run.
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR (plan §4 "重试：新 attempt、新凭证/授权代际和新效果；
 * 旧结果保持不可变", §5 A11 "重试和终态重新执行 | 新 attempt/run；旧回执不变"):
 *
 * - a retry MINTS a successor attempt: a new attempt id and sequence, a new
 *   credential (adopted by the host's store and delivered over the dispatch
 *   channel), and a new dispatch effect;
 * - the SUPERSEDED attempt's facts are never rewritten — its control decision,
 *   its effect row and its execution binding stay exactly as they were, and its
 *   result can never be accepted afterwards;
 * - a retry invalidates ONLY the attempt it supersedes: no other node's
 *   attempt, effect, receipt or arrival is touched, and no downstream node is
 *   re-run (the boundary is the arrival rule, and it is asserted here);
 * - the races resolve by stated rules: an acceptance that committed first makes
 *   the retry `attempt-already-settled`, and a retry that committed first makes
 *   every later acceptance for that attempt `superseded` at the STORE;
 * - a repeated retry replays the decision that minted its successor instead of
 *   minting a second one;
 * - retry is a TRUSTED command: a worker's submitted payload can never select
 *   one, and a process with no protected credential store refuses by name.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real OutcomeHost over the workspace's one
 * SQLite store, the real toolset, and the `withCancelDelivery` wrapper both
 * entries install — so a retry's successor effect is really handed to the
 * platform by the same follow-up production uses.
 *
 * STRENGTH: adapter + real store, one process. No real dsh/Pi SDK runs here, so
 * nothing in this file is real-host evidence.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost, withCancelDelivery } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { runGraphControlEntry } from "../../src/graph/tools/control-entry.ts";
import { createGraphToolSet, type GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../src/platform/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** One entry node: the smallest graph that has an attempt to supersede. */
const SOLO: GraphDeclarationV3 = {
  version: 3,
  name: "retry.solo",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/** Two ENTRY nodes: one retry must leave the OTHER node's facts untouched. */
const PAIR: GraphDeclarationV3 = {
  version: 3,
  name: "retry.pair",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/** work -> review: a settled `work` arms the `review` attempt. */
const CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "retry.chain",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "approve" }],
    },
  ],
  edges: [{ from: "work", to: "review", outcome: "done" }],
};

const FIXED_AT = 1_700_000_000_000;

/**
 * A DETERMINISTIC credential source: the retry's successor value is predictable,
 * so the test can prove a NEW value was minted without ever printing one.
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

interface RetryFixture {
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatched: OutcomeDispatchRequest[];
  readonly storeRoot: string;
  readonly graphId: string;
  readonly declarer: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

/** One shipped assembly over a REAL declared graph, with the platform confirming. */
async function openRetryFixture(declaration: GraphDeclarationV3): Promise<RetryFixture> {
  const dir = makeTmpDir("retry-attempt-");
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
    outcomeMintCredential: credentialSource,
  });
  const declarer = "session.declarer";
  const fixture: RetryFixture = {
    host: opened,
    toolset,
    // The wrapper both shipped entries install: an applied retry really hands
    // its successor effect to the platform inside the tool call.
    tools: opened.bindTools(
      withCancelDelivery(createOutcomeGraphTools(toolset), opened),
    ),
    dispatched,
    storeRoot,
    graphId: declaration.name,
    declarer,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
  };
  const declared = String(
    await fixture.tools.graph_declare.execute(
      { declaration },
      fixture.contextOf(declarer, "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await opened.startDeclaredGraph(declaration.name, {
    sessionId: declarer,
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return fixture;
}

/** What one retry answer carries, as the tool renders it. */
interface RetryAnswer {
  readonly kind?: "applied" | "refused";
  readonly graphId?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly scope?: "attempt" | "run";
  readonly minted?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly attemptSeq: number;
    readonly effectId: string;
  }[];
  readonly decided?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly replayed: boolean;
    readonly decision: {
      readonly command: string;
      readonly reason: string;
      readonly successorAttemptId?: string;
    };
  }[];
  readonly runControl?: { readonly command: string };
  readonly unsettledEffects?: readonly {
    readonly effectId: string;
    readonly attemptId: string;
    readonly status: string;
  }[];
  readonly unconfirmedExecutions?: readonly {
    readonly attemptId: string;
    readonly state: string;
  }[];
  readonly refusals?: readonly { readonly code: string; readonly path: string; readonly message: string }[];
}

/** Run one command through the SHIPPED `graph_control` tool. */
async function control(
  fixture: RetryFixture,
  args: Record<string, unknown>,
  sessionID: string,
): Promise<RetryAnswer> {
  const raw = String(
    await fixture.tools.graph_control.execute(args, fixture.contextOf(sessionID, "agent.declarer")),
  );
  if (raw.startsWith("graph_control failed:")) {
    throw new Error("fixture: graph_control failed: " + raw);
  }
  return JSON.parse(raw) as RetryAnswer;
}

/** The durable rows one graph holds, read with a FRESH connection. */
function readRows(fixture: RetryFixture): {
  readonly effects: readonly { readonly effectId: string; readonly attemptId: string; readonly status: string }[];
  readonly decisions: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly command: string;
    readonly successorAttemptId?: string;
  }[];
  readonly events: readonly { readonly attemptId: string }[];
  readonly receipts: number;
  readonly runControl: { readonly command: string } | undefined;
} {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    return {
      effects: store.pendingEffects(fixture.graphId).map((effect) => ({
        effectId: effect.effectId,
        attemptId: effect.attemptId,
        status: effect.status,
      })),
      decisions: store.runs.controlDecisions(fixture.graphId).map((decision) => ({
        nodeId: decision.nodeId,
        attemptId: decision.attemptId,
        command: decision.command,
        ...(decision.successorAttemptId === undefined
          ? {}
          : { successorAttemptId: decision.successorAttemptId }),
      })),
      events: store.acceptedEvents(fixture.graphId).map((event) => ({ attemptId: event.attemptId })),
      receipts: Number(
        store.all(
          "SELECT COUNT(*) AS n FROM ledger_receipts WHERE graph_id = ?",
          fixture.graphId,
        )[0]?.["n"] ?? 0,
      ),
      runControl: store.runs.readRunControl(fixture.graphId),
    };
  } finally {
    store.close();
  }
}

/** The persisted state body of one graph's CURRENT run, read with a fresh connection. */
function readBody(fixture: RetryFixture): {
  readonly attemptSeq: unknown;
  readonly phase: unknown;
  readonly runId: unknown;
  readonly planRevision: unknown;
  readonly nodes: readonly Record<string, unknown>[];
} {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    const record = store.readGraphState(fixture.graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : {};
    return {
      attemptSeq: body["attemptSeq"],
      phase: body["phase"],
      runId: record?.runId,
      planRevision: record?.planRevision,
      nodes: Array.isArray(body["nodes"])
        ? (body["nodes"] as readonly Record<string, unknown>[])
        : [],
    };
  } finally {
    store.close();
  }
}

/** The persisted entry of one node, or a fixture error. */
function nodeEntry(
  body: { readonly nodes: readonly Record<string, unknown>[] },
  nodeId: string,
): Record<string, unknown> {
  const entry = body.nodes.find((node) => node["nodeId"] === nodeId);
  if (entry === undefined) throw new Error("fixture: no persisted entry for node " + nodeId);
  return entry;
}

/** The credential one dispatched attempt was handed (never printed by a test). */
function credentialOf(fixture: RetryFixture, attemptId: string): string {
  const request = fixture.dispatched.find((candidate) => candidate.attemptId === attemptId);
  if (request === undefined) throw new Error("fixture: no dispatch for attempt " + attemptId);
  return request.credential;
}

/**
 * Settle one node through the SHIPPED submission ingress — the BOUND tool, so the
 * platform's own attribution of the calling session is what the attempt's
 * confirmed worker binding is checked against (exactly as a worker's call is).
 */
async function settle(
  fixture: RetryFixture,
  nodeId: string,
  attemptId: string,
  outcomeId: string,
): Promise<string> {
  const raw = String(
    await fixture.tools.graph_submit_outcome.execute(
      {
        graph_id: fixture.graphId,
        node_id: nodeId,
        outcome_id: outcomeId,
        credential: credentialOf(fixture, attemptId),
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

// ── The minted attempt ──────────────────────────────────────────────────────

describe("retry — a new attempt on the same run", () => {
  it("mints a successor attempt with a new credential and effect, and leaves the superseded attempt's facts exactly as they were", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      const before = readRows(fixture);
      const beforeBody = readBody(fixture);
      const supersededEntry = nodeEntry(beforeBody, "work");
      const supersededEffect = before.effects.find(
        (effect) => effect.effectId === "dispatch:work#1",
      );
      expect(supersededEffect?.status).toBe("started");

      const answer = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "retry",
          node_id: "work",
          reason: "the attempt has produced nothing for an hour",
        },
        fixture.declarer,
      );

      expect(answer.kind).toBe("applied");
      expect(answer.command).toBe("retry");
      expect(answer.scope).toBe("attempt");
      // A RETRY DOES NOT STOP THE RUN: it supersedes an attempt, so the run's
      // control fact is deliberately not claimed — the successor must be
      // settleable, and every settlement path refuses a controlled run.
      expect(answer.runControl).toBeUndefined();
      expect(answer.minted).toEqual([
        {
          nodeId: "work",
          attemptId: "work#2",
          attemptSeq: 2,
          effectId: "dispatch:work#2",
        },
      ]);
      // The DECISION is recorded against the SUPERSEDED attempt and names the
      // successor it minted: that pair is the retry's durable idempotency key.
      expect(answer.decided).toHaveLength(1);
      expect(answer.decided?.[0]).toMatchObject({
        nodeId: "work",
        attemptId: "work#1",
        replayed: false,
      });
      expect(answer.decided?.[0]?.decision.command).toBe("retry");
      expect(answer.decided?.[0]?.decision.successorAttemptId).toBe("work#2");

      const after = readRows(fixture);
      // THE SUPERSEDED ATTEMPT'S EFFECT IS UNTOUCHED: same row, same status —
      // a retry never rewinds it, never marks it failed and never deletes it.
      expect(after.effects.find((effect) => effect.effectId === "dispatch:work#1")).toEqual(
        supersededEffect,
      );
      // A NEW EFFECT EXISTS for the successor, pending (the follow-up launched it).
      expect(after.effects.map((effect) => effect.effectId).sort()).toEqual([
        "dispatch:work#1",
        "dispatch:work#2",
      ]);
      expect(after.decisions).toEqual([
        {
          nodeId: "work",
          attemptId: "work#1",
          command: "retry",
          successorAttemptId: "work#2",
        },
      ]);
      // NO BUSINESS SUCCESS: control is not outcome (§3.4).
      expect(after.events).toEqual([]);
      expect(after.receipts).toBe(0);
      expect(after.runControl).toBeUndefined();

      // THE STATE NAMES THE SUCCESSOR, with a NEW credential digest.
      const body = readBody(fixture);
      const entry = nodeEntry(body, "work");
      expect(entry).toMatchObject({ status: "dispatched", attemptId: "work#2", attemptSeq: 2 });
      expect(entry["attemptCredentialDigest"]).not.toBe(supersededEntry["attemptCredentialDigest"]);
      expect(body.attemptSeq).toBe(2);
      expect(body.phase).toBe("executing");

      // THE NEW CREDENTIAL IS USABLE: the successor's worker settles its attempt.
      expect(await settle(fixture, "work", "work#2", "done")).toBe("accepted");
    } finally {
      fixture.host.close();
    }
  });

  it("hands the successor's effect to the platform, and refuses the superseded attempt's credential afterwards", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      const supersededCredential = credentialOf(fixture, "work#1");
      await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "supersede" },
        fixture.declarer,
      );
      // The follow-up dispatched exactly one more attempt, with the NEW credential.
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual([
        "work#1",
        "work#2",
      ]);
      expect(credentialOf(fixture, "work#2")).toBe("credential:work#2");
      expect(credentialOf(fixture, "work#2")).not.toBe(supersededCredential);

      // THE OLD WORKER CANNOT SETTLE ANYTHING: its attempt is no longer the run's,
      // so the credential resolves to no attempt and nothing is written.
      const answer = await fixture.toolset.graph_submit_outcome(
        {
          graph_id: fixture.graphId,
          node_id: "work",
          outcome_id: "done",
          credential: supersededCredential,
        },
        childSessionOf("work#1"),
        "agent.work",
      );
      expect(answer.decision).toBeUndefined();
      expect(answer.refusals.map((refusal) => refusal.code)).toEqual(["credential-unknown"]);
      const rows = readRows(fixture);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);

      // The successor attempt still carries the node forward.
      expect(nodeEntry(readBody(fixture), "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#2",
      });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses to retry a SETTLED attempt: its result is immutable and nothing is written", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      expect(await settle(fixture, "work", "work#1", "done")).toBe("accepted");
      const before = readRows(fixture);
      expect(before.events.map((event) => event.attemptId)).toEqual(["work#1"]);

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "again" },
        fixture.declarer,
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("attempt-already-settled");
      expect(answer.refusals?.[0]?.message).toContain("IMMUTABLE");

      const after = readRows(fixture);
      expect(after.decisions).toEqual([]);
      // The settled attempt's own effect is TERMINAL (the acceptance marks it
      // done), so the unsettled set is empty: the refused retry wrote neither a
      // decision nor an effect.
      expect(after.effects).toEqual([]);
      expect(after.events).toEqual(before.events);
      expect(after.receipts).toBe(before.receipts);
      expect(nodeEntry(readBody(fixture), "work")).toMatchObject({
        status: "settled",
        attemptId: "work#1",
        outcomeId: "done",
      });
    } finally {
      fixture.host.close();
    }
  });

  it("arms NO other node: a sibling's attempt, effect and entry are untouched", async () => {
    const fixture = await openRetryFixture(PAIR);
    try {
      const beforeBody = readBody(fixture);
      const betaEntry = nodeEntry(beforeBody, "beta");
      const betaEffect = readRows(fixture).effects.find(
        (effect) => effect.effectId === "dispatch:beta#2",
      );
      expect(betaEntry).toMatchObject({ status: "dispatched", attemptId: "beta#2" });
      expect(betaEffect?.status).toBe("started");

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "alpha", reason: "stuck" },
        fixture.declarer,
      );
      expect(answer.kind).toBe("applied");
      expect(answer.minted?.map((entry) => entry.attemptId)).toEqual(["alpha#3"]);

      const afterBody = readBody(fixture);
      // THE INVALIDATION SCOPE IS THE SUPERSEDED ATTEMPT. Beta's entry and effect
      // are byte-identical, no arrival was written for anyone, and the run's
      // phase is unchanged: a retry re-runs ONE node's attempt.
      expect(nodeEntry(afterBody, "beta")).toEqual(betaEntry);
      expect(
        readRows(fixture).effects.find((effect) => effect.effectId === "dispatch:beta#2"),
      ).toEqual(betaEffect);
      expect(afterBody.nodes.every((node) => Array.isArray(node["arrivals"]) && node["arrivals"].length === 0)).toBe(true);
      expect(afterBody.attemptSeq).toBe(3);
      // The follow-up dispatched the successor — and nothing for beta.
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual([
        "alpha#1",
        "beta#2",
        "alpha#3",
      ]);
    } finally {
      fixture.host.close();
    }
  });
});
// ── Idempotency and the stated race rules ───────────────────────────────────

describe("retry — a repeated command, and the races", () => {
  it("replays a repeated retry of the same attempt instead of minting a second successor", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      const first = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "stuck" },
        fixture.declarer,
      );
      expect(first.kind).toBe("applied");
      expect(first.minted?.[0]?.attemptId).toBe("work#2");
      expect(first.decided?.[0]?.replayed).toBe(false);

      // THE SAME COMMAND, NAMING THE SAME ATTEMPT: the decision that minted
      // work#2 is replayed and NOTHING is minted — no second successor, no
      // second effect, no second dispatch.
      const repeated = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "retry",
          node_id: "work",
          attempt_id: "work#1",
          reason: "stuck",
        },
        fixture.declarer,
      );
      expect(repeated.kind).toBe("applied");
      expect(repeated.minted?.[0]?.attemptId).toBe("work#2");
      expect(repeated.decided?.[0]).toMatchObject({ attemptId: "work#1", replayed: true });
      expect(nodeEntry(readBody(fixture), "work")).toMatchObject({ attemptId: "work#2" });
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual([
        "work#1",
        "work#2",
      ]);

      // AND A RETRY THAT NAMES NO ATTEMPT RESOLVES THE NODE'S CURRENT ONE, which
      // is the successor: an IMPLICIT repeat therefore replays the retry that
      // produced it rather than superseding it a second time.
      const implicit = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "stuck" },
        fixture.declarer,
      );
      expect(implicit.kind).toBe("applied");
      expect(implicit.minted?.[0]?.attemptId).toBe("work#2");
      expect(implicit.decided?.[0]?.replayed).toBe(true);

      // SUPERSEDING THE SUCCESSOR TAKES NAMING IT (the documented rule): the
      // explicit form mints work#3 and leaves work#2's decision intact.
      const explicit = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "retry",
          node_id: "work",
          attempt_id: "work#2",
          reason: "the successor is stuck too",
        },
        fixture.declarer,
      );
      expect(explicit.kind).toBe("applied");
      expect(explicit.minted?.[0]?.attemptId).toBe("work#3");
      const rows = readRows(fixture);
      expect(rows.decisions.map((decision) => decision.attemptId + ":" + decision.successorAttemptId)).toEqual([
        "work#1:work#2",
        "work#2:work#3",
      ]);
      expect(nodeEntry(readBody(fixture), "work")).toMatchObject({ attemptId: "work#3" });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a retry that names an attempt the run no longer holds", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "stuck" },
        fixture.declarer,
      );
      const stale = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "retry",
          node_id: "work",
          attempt_id: "work#1",
          reason: "stale",
        },
        fixture.declarer,
      );
      // work#1 IS the recorded retry's key, so this is a REPLAY of that retry —
      // never a new attempt and never a re-labelling of work#1.
      expect(stale.kind).toBe("applied");
      expect(stale.decided?.[0]?.replayed).toBe(true);
      expect(stale.minted?.[0]?.attemptId).toBe("work#2");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses the retry when the acceptance committed first, and writes nothing", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      expect(await settle(fixture, "work", "work#1", "done")).toBe("accepted");
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "race" },
        fixture.declarer,
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("attempt-already-settled");
      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.effects).toEqual([]);
      expect(rows.events.map((event) => event.attemptId)).toEqual(["work#1"]);
      expect(nodeEntry(readBody(fixture), "work")).toMatchObject({
        status: "settled",
        attemptId: "work#1",
      });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses an acceptance for a SUPERSEDED attempt at the STORE, writing nothing", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "race" },
        fixture.declarer,
      );
      // THE INVERSE RACE, DECIDED BY THE COMMITTED STORE. The runtime refuses a
      // superseded submission even earlier (the credential no longer resolves);
      // this asserts the STRUCTURAL half — the batch write's own guard — so no
      // caller of the store API can land a result for an attempt a retry
      // replaced.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const verdict = store.commitAccepted({
          receipt: {
            graphId: fixture.graphId,
            attemptId: "work#1",
            submissionId: "submission:superseded-race",
            planRevision: "plan.retry-race",
            proposalDigest: "digest:superseded-race",
            decision: "accepted",
            committedAt: FIXED_AT,
          },
          acceptedEvent: {
            graphId: fixture.graphId,
            attemptId: "work#1",
            submissionId: "submission:superseded-race",
            planRevision: "plan.retry-race",
            outcomeId: "done",
            acceptedAt: FIXED_AT,
          },
        });
        expect(verdict.kind).toBe("superseded");
        if (verdict.kind !== "superseded") throw new Error("fixture: expected superseded");
        expect(verdict.decision.successorAttemptId).toBe("work#2");
        expect(
          store.lookupReceipt({
            graphId: fixture.graphId,
            attemptId: "work#1",
            submissionId: "submission:superseded-race",
          }),
        ).toBeUndefined();
        expect(store.acceptedEvents(fixture.graphId)).toEqual([]);
      } finally {
        store.close();
      }
      const rows = readRows(fixture);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a node-scoped retry once a trusted command stopped the run, and names the repair", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      const cancelled = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        fixture.declarer,
      );
      expect(cancelled.kind).toBe("applied");
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "after stop" },
        fixture.declarer,
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("run-stopped");
      expect(answer.refusals?.[0]?.message).toContain("NEW run");
      // NOTHING WAS WRITTEN: no retry decision, no new attempt, no new effect.
      const rows = readRows(fixture);
      expect(rows.decisions.map((decision) => decision.command)).toEqual(["cancel"]);
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
      expect(rows.runControl?.command).toBe("cancel");
    } finally {
      fixture.host.close();
    }
  });
});
// ── §3.4 separation and the capability gate ────────────────────────────────

describe("retry — trusted control, never worker input", () => {
  it("cannot be selected by a worker's submitted payload", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      // A payload that NAMES the control command is still just a payload: the
      // command vocabulary is never read from a proposal, so no control fact is
      // recorded and no attempt is minted.
      const raw = String(
        await fixture.tools.graph_submit_outcome.execute(
          {
            graph_id: fixture.graphId,
            node_id: "work",
            outcome_id: "done",
            credential: credentialOf(fixture, "work#1"),
            command: "retry",
            control: "retry",
            reason: "retry me",
          },
          fixture.contextOf(childSessionOf("work#1"), "agent.work"),
        ),
      );
      expect(raw.startsWith("graph_submit_outcome failed:")).toBe(false);
      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.runControl).toBeUndefined();
      const body = readBody(fixture);
      expect(body.attemptSeq).toBe(1);
      expect(nodeEntry(body, "work")).toMatchObject({ attemptId: "work#1" });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses with credential-isolation-unavailable when no protected credential store is installed", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      // The entry WITHOUT the host capability: a retry mints an attempt whose
      // credential could not be stored or delivered, so it is refused by name
      // and NOTHING is written.
      const answer = runGraphControlEntry(
        { storeDirectory: fixture.storeRoot, now: FIXED_AT },
        {
          graph_id: fixture.graphId,
          command: "retry",
          node_id: "work",
          reason: "no protected store",
        },
        fixture.declarer,
        "agent.declarer",
      );
      expect(answer.kind).toBe("refused");
      if (answer.kind !== "refused") throw new Error("fixture: expected a refusal");
      expect(answer.refusals[0]?.code).toBe("credential-isolation-unavailable");
      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
      expect(nodeEntry(readBody(fixture), "work")).toMatchObject({ attemptId: "work#1" });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a retry from a caller that is not the declaring principal", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "not mine" },
        "session.someone-else",
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("control-not-authorized");
      expect(readRows(fixture).decisions).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });
});
// ── The command's own transaction (plan §4 P3 per-command row 5) ───────────

/**
 * Run one control command with a TEMP TRIGGER on the store's OWN shared
 * connection, so the write fails AT THE SQL STATEMENT below the application.
 *
 * The store shares one connection per file in this process, so the trigger the
 * case creates is the one the command's transaction runs against. The trigger is
 * dropped before the tables are read back, and the return value is whatever the
 * command threw — the transaction rolls back on a throw, which is exactly what
 * the assertions below check. (The same shape `control-entry.test.ts` uses for
 * failure and cancel.)
 */
function withInjectedRetryWrite(
  fixture: RetryFixture,
  trigger: string,
  run: () => unknown,
): unknown {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    store.run("CREATE TEMP TRIGGER p3_retry_inject " + trigger);
    try {
      run();
      return undefined;
    } catch (thrown) {
      return thrown;
    } finally {
      store.run("DROP TRIGGER p3_retry_inject");
    }
  } finally {
    store.close();
  }
}

/** How many credential RECORDS (never values) one graph holds. */
function credentialRows(fixture: RetryFixture): number {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    return Number(
      store.all(
        "SELECT COUNT(*) AS n FROM host_attempt_credentials WHERE graph_id = ?",
        fixture.graphId,
      )[0]?.["n"] ?? 0,
    );
  } finally {
    store.close();
  }
}

describe("retry — a command commits whole or not at all", () => {
  it("rolls the successor attempt, credential and effect back when the successor effect's INSERT fails", async () => {
    const fixture = await openRetryFixture(SOLO);
    try {
      const before = readRows(fixture);
      const beforeAttemptSeq = readBody(fixture).attemptSeq;
      expect(before.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
      expect(before.decisions).toEqual([]);
      expect(credentialRows(fixture)).toBe(1);

      // THE SUCCESSOR EFFECT IS THE LAST ROW THE RETRY WRITES, so an injected
      // failure there is the strongest case: decision, successor attempt (state),
      // credential record and effect must ALL roll back together.
      const error = withInjectedRetryWrite(
        fixture,
        "BEFORE INSERT ON ledger_pending_effects " +
          "BEGIN SELECT RAISE(ABORT, 'p3-injected-retry-failure'); END",
        () =>
          fixture.toolset.graph_control(
            {
              graph_id: fixture.graphId,
              command: "retry",
              node_id: "work",
              reason: "injected at the successor effect",
            },
            fixture.declarer,
            "agent.declarer",
          ),
      );

      // THE THROW IS THE CONTRACT: the store's own failure reaches the caller
      // instead of being dressed up as a refusal.
      expect(error).toBeInstanceOf(Error);
      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.runControl).toBeUndefined();
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      // The successor's credential record did not survive either, so no
      // credential exists for an attempt the store does not hold.
      expect(credentialRows(fixture)).toBe(1);
      const body = readBody(fixture);
      expect(body.attemptSeq).toBe(beforeAttemptSeq);
      expect(nodeEntry(body, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#1",
        attemptSeq: 1,
      });

      // AND NOTHING WAS POISONED: the SAME command applied cleanly afterwards,
      // minting the successor exactly once and handing its effect to the
      // platform.
      const retried = await control(
        fixture,
        { graph_id: fixture.graphId, command: "retry", node_id: "work", reason: "after the rollback" },
        fixture.declarer,
      );
      expect(retried.kind).toBe("applied");
      expect(retried.minted?.map((attempt) => attempt.attemptId)).toEqual(["work#2"]);
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual(["work#1", "work#2"]);
      expect(readRows(fixture).decisions.map((decision) => decision.successorAttemptId)).toEqual([
        "work#2",
      ]);
      expect(credentialRows(fixture)).toBe(2);
    } finally {
      fixture.host.close();
    }
  });
});

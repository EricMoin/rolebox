/**
 * A21 / plan §3.3 — the graph tool face a DISPATCHED WORKER is judged by.
 *
 * THE CLAIM THIS FILE PROVES BY BEHAVIOUR, NOT BY A PATH CHECK. A dispatched
 * worker may do exactly what its handoff requires — settle its OWN attempt's
 * outcome through `graph_submit_outcome` — and nothing else of the graph face:
 * declaring or mutating a graph definition, reading the authoritative store and
 * controlling another attempt are the declaring/operating principal's
 * capabilities. The boundary is the host's own binding of the session the call
 * arrives from (the child session the platform created for the attempt), so it
 * is checked against a host FACT and not against a path, a flag or an argument
 * the caller chose.
 *
 * EVERY CASE DRIVES THE SHIPPED ASSEMBLY: the four `graph_*` tools from
 * `createOutcomeGraphTools` over a real `createGraphToolSet` and a real
 * `OutcomeHost` (file durability, the workspace's one SQLite store, the
 * shipped `declareInvocationIdentity: false` + `workerSessionOf` decision),
 * bound by the very `OutcomeHost.bindTools` the dsh and Pi entries call.
 *
 * WHAT IS ASSERTED ABOUT A REFUSAL. The answer is machine-readable
 * (`refused: true`, a stable code, the tool, the graph and the attempt) and the
 * AUTHORITATIVE RECORD is read back from the store afterwards: a refused
 * `graph_declare` declared nothing, a refused `graph_audit`/`graph_status`
 * returned no inventory and no store path, and the graph state is byte-identical
 * to its pre-call snapshot. The refusal is also shown to run BEFORE the tool
 * body: an INVALID declaration gets the boundary's answer, not the compiler's.
 *
 * THE POSITIVE PATH IS IN THIS FILE TOO (the delivery's whole purpose): the
 * worker's own `graph_submit_outcome` still settles its attempt, arms the
 * successor, and the successor's worker settles that — the flow still settles
 * end to end through the face the boundary judges.
 *
 * STRENGTH: adapter + real store, one process. No OS/account/container boundary
 * exists on this platform (that half is reported as a platform gap, never
 * claimed here), and no real dsh/Pi SDK runs in this environment.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  OutcomeHost,
  WORKER_GRANTED_GRAPH_TOOLS,
  WORKER_TOOL_FORBIDDEN_CODE,
} from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { readStoredDefinition } from "../../src/graph/persistence/declared-record.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../src/platform/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/**
 * Two ENTRY nodes: one start dispatches both, so one host holds two bound
 * workers at once — the population a cross-attempt call could try to reach.
 */
const FAN_OUT: GraphDeclarationV3 = {
  version: 3,
  name: "worker-face.fan-out",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/** work -> review, so an accepted outcome ARMS a successor attempt. */
const CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "worker-face.chain",
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

/** A graph no attempt in this file belongs to: the declaration a worker tries. */
const OTHER: GraphDeclarationV3 = {
  version: 3,
  name: "worker-face.other",
  nodes: [
    { id: "only", agent: "agent.other", prompt: "Do the other.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

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

interface FaceFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly graphId: string;
  readonly host: OutcomeHost;
  /** Every dispatch the run path handed to the platform, in order. */
  readonly dispatched: readonly OutcomeDispatchRequest[];
  /** THE SHIPPED FACE: `createOutcomeGraphTools` bound by `OutcomeHost.bindTools`. */
  readonly tools: Record<string, CanonicalToolDef>;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

/**
 * The shipped host assembly over a REAL declared graph: file durability, the
 * one workspace store, the platform's child-session derivation, and the tool
 * face bound exactly as both entries bind it.
 */
async function openFaceFixture(declaration: GraphDeclarationV3): Promise<FaceFixture> {
  const dir = makeTmpDir("worker-face-");
  const storeRoot = join(dir, "host-store");
  // The store root exists before the host opens it (the host's vault
  // writes under it). The DECLARATION itself is authored through the
  // SHIPPED `graph_declare`, exactly as a real declarer's session does
  // it, so the declarer-side cases below exercise a graph THIS PROCESS
  // declared rather than one a helper dropped on disk behind the face.
  mkdirSync(storeRoot, { recursive: true });
  const face = bindFaceOver(dir, storeRoot);
  const declarer = face.contextOf("session-declarer", "agent.declarer");
  const declared = String(await face.tools.graph_declare.execute({ declaration }, declarer));
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await face.host.startDeclaredGraph(declaration.name, {
    sessionId: "session-declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return { ...face, graphId: declaration.name };
}

/**
 * One host over an EXISTING store root, with the shipped face bound to it.
 *
 * Separate from {@link openFaceFixture} so a case can open a SECOND host over a
 * store a first host already dispatched into — the durable half of the worker
 * binding, read by a process that never confirmed those executions itself.
 */
function bindFaceOver(
  dir: string,
  storeRoot: string,
): {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly dispatched: OutcomeDispatchRequest[];
  readonly tools: Record<string, CanonicalToolDef>;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
} {
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      // The platform names the execution it created; the host records the fact.
      host?.confirmExecution(effect, {
        executionId: childSessionOf(request.attemptId),
      });
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: dir,
  });
  return {
    dir,
    storeRoot,
    host: opened,
    dispatched,
    tools: opened.bindTools(createOutcomeGraphTools(toolset)),
    contextOf: (sessionID: string, agent: string) => makeContext(sessionID, agent, dir),
  };
}

/** A canonical tool context, as a platform hands one to a tool call. */
function makeContext(
  sessionID: string,
  agent: string,
  directory: string,
): CanonicalToolContext {
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

interface GraphReading {
  /** The whole persisted state row, for a before/after snapshot. */
  readonly record: unknown;
  readonly body: Record<string, unknown> | undefined;
  readonly events: number;
}

/** Read the AUTHORITATIVE record with a fresh connection. */
async function readGraph(fixture: {
  readonly storeRoot: string;
  readonly graphId: string;
}): Promise<GraphReading> {
  const ledger = await SqliteAcceptanceLedger.create(fixture.storeRoot);
  try {
    const record = ledger.readGraphState(fixture.graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    return {
      record,
      body,
      events: ledger.acceptedEvents(fixture.graphId).length,
    };
  } finally {
    ledger.close();
  }
}

/** The persisted entry of one node, or a fixture error. */
function nodeOf(reading: GraphReading, nodeId: string): Record<string, unknown> {
  const nodes = reading.body?.["nodes"];
  if (!Array.isArray(nodes)) throw new Error("fixture: no nodes array persisted");
  for (const entry of nodes) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["nodeId"] === nodeId) return record;
  }
  throw new Error("fixture: no persisted entry for node " + nodeId);
}

/** The credential one dispatched attempt was handed. */
function credentialOf(
  fixture: FaceFixture,
  nodeId: string,
): string {
  const request = fixture.dispatched.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no dispatch for node " + nodeId);
  return request.credential;
}

/** One parsed refusal, as the boundary renders it. */
interface WorkerToolRefusal {
  readonly refused?: boolean;
  readonly code?: string;
  readonly tool?: string;
  readonly graph_id?: string;
  readonly attempt_id?: string;
  readonly granted_tools?: readonly string[];
  readonly message?: string;
}

/** Assert one call was refused by the worker boundary, for one named tool. */
async function expectWorkerRefusal(
  fixture: FaceFixture,
  tool: string,
  args: Record<string, unknown>,
  sessionID: string,
  agent: string,
  expected: { readonly graphId: string; readonly attemptId: string },
): Promise<string> {
  const def = fixture.tools[tool];
  if (def === undefined) throw new Error("fixture: no tool " + tool);
  const raw = String(await def.execute(args, fixture.contextOf(sessionID, agent)));
  const refusal = JSON.parse(raw) as WorkerToolRefusal;
  expect(refusal.refused).toBe(true);
  expect(refusal.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
  expect(refusal.tool).toBe(tool);
  expect(refusal.graph_id).toBe(expected.graphId);
  expect(refusal.attempt_id).toBe(expected.attemptId);
  expect(refusal.granted_tools).toEqual([...WORKER_GRANTED_GRAPH_TOOLS]);
  expect(refusal.message).toContain(WORKER_TOOL_FORBIDDEN_CODE);
  expect(refusal.message).toContain("graph_submit_outcome");
  return raw;
}

// ── The face ────────────────────────────────────────────────────────────────

describe("the shipped graph face — what a bound worker is granted", () => {
  it("keeps the declarer entries and grants a dispatched worker exactly the delivery channel", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      // THE GRANT IS AN ALLOW-LIST OF ONE, and every shipped entry — including
      // the trusted control entry (P3 item 1) — is still bound, so the declaring
      // session's face is unchanged and a worker is refused control by the SAME
      // boundary that refuses the other declarer entries.
      expect([...WORKER_GRANTED_GRAPH_TOOLS]).toEqual(["graph_submit_outcome"]);
      expect(Object.keys(fixture.tools).sort()).toEqual([
        "graph_audit",
        "graph_control",
        "graph_declare",
        "graph_status",
        "graph_submit_outcome",
      ]);
      // Both entry attempts are live and bound: the run path dispatched two
      // attempts and the platform confirmed each one's child session.
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual([
        "alpha#1",
        "beta#2",
      ]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The refusals ────────────────────────────────────────────────────────────

describe("a dispatched worker cannot reach the declarer/store face", () => {
  it("REFUSES graph_declare before the body runs and declares nothing", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      const before = await readGraph(fixture);

      // (a) A deliberately INVALID declaration: if the body had run, the answer
      // would be the compiler's own refusal. The boundary answers first, which
      // is what makes this a pre-body check rather than a post-hoc report.
      const raw = await expectWorkerRefusal(
        fixture,
        "graph_declare",
        { declaration: { version: 3 } },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );
      expect(raw).not.toContain("strict v3 declaration");
      expect(raw).not.toContain(fixture.storeRoot);

      // (b) A VALID declaration of a graph nobody declared: still nothing is
      // persisted — the store's definition table is read back directly.
      await expectWorkerRefusal(
        fixture,
        "graph_declare",
        { declaration: OTHER },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );
      expect(readStoredDefinition(fixture.storeRoot, OTHER.name).kind).toBe("absent");

      // The authoritative record of the graph the worker belongs to is
      // byte-identical: no declaration, no state move, no accepted event.
      expect(await readGraph(fixture)).toEqual(before);
    } finally {
      fixture.host.close();
    }
  });

  it("REFUSES graph_audit and graph_status, returning no inventory and no store path", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      const before = await readGraph(fixture);

      const auditRaw = await expectWorkerRefusal(
        fixture,
        "graph_audit",
        {},
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );
      // The inventory half: the audit's own vocabulary and the host store root
      // are NOT in the answer.
      expect(auditRaw).not.toContain("storeDirectory");
      expect(auditRaw).not.toContain(fixture.storeRoot);
      expect(auditRaw).not.toContain("drained");

      const statusRaw = await expectWorkerRefusal(
        fixture,
        "graph_status",
        { graph_id: FAN_OUT.name, format: "json" },
        childSessionOf("beta#2"),
        "agent.beta",
        { graphId: FAN_OUT.name, attemptId: "beta#2" },
      );
      expect(statusRaw).not.toContain(fixture.storeRoot);
      expect(statusRaw).not.toContain("node_id");

      expect(await readGraph(fixture)).toEqual(before);
    } finally {
      fixture.host.close();
    }
  });

  it("REFUSES graph_control before the body runs, so a worker cannot stop or fail a run", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      const before = await readGraph(fixture);

      // (a) A cancel the worker has no business issuing: the boundary answers
      // before the control service is reached, so the answer is the worker
      // refusal and NOT a control-application refusal.
      const cancelRaw = await expectWorkerRefusal(
        fixture,
        "graph_control",
        { graph_id: FAN_OUT.name, command: "cancel", reason: "a worker must not stop this" },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );
      expect(cancelRaw).not.toContain("control-not-authorized");
      expect(cancelRaw).not.toContain(fixture.storeRoot);

      // (b) A failure aimed at the caller's OWN attempt: still refused, because
      // a control decision is never derived from the worker that would benefit.
      await expectWorkerRefusal(
        fixture,
        "graph_control",
        {
          graph_id: FAN_OUT.name,
          command: "failure",
          node_id: "alpha",
          attempt_id: "alpha#1",
          reason: "a worker must not fail its own attempt",
        },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );

      // The authoritative record is untouched: no control decision, no run
      // control fact, the same state row and no accepted event.
      expect(await readGraph(fixture)).toEqual(before);
      const ledger = await SqliteAcceptanceLedger.create(fixture.storeRoot);
      try {
        expect(ledger.runs.controlDecisions(FAN_OUT.name)).toEqual([]);
        expect(ledger.runs.readRunControl(FAN_OUT.name)).toBeUndefined();
      } finally {
        ledger.close();
      }
    } finally {
      fixture.host.close();
    }
  });

  it("returns no attempt credential through the face — not even the caller's own", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      const alphaCredential = credentialOf(fixture, "alpha");
      const betaCredential = credentialOf(fixture, "beta");
      const worker = fixture.contextOf(childSessionOf("alpha#1"), "agent.alpha");

      const answers: string[] = [
        String(
          await fixture.tools.graph_status.execute(
            { graph_id: FAN_OUT.name, format: "json" },
            worker,
          ),
        ),
        String(await fixture.tools.graph_audit.execute({}, worker)),
        String(
          await fixture.tools.graph_declare.execute({ declaration: OTHER }, worker),
        ),
        // The one call the worker IS granted: its own attempt's submission.
        String(
          await fixture.tools.graph_submit_outcome.execute(
            {
              graph_id: FAN_OUT.name,
              node_id: "alpha",
              outcome_id: "done",
              credential: alphaCredential,
            },
            worker,
          ),
        ),
      ];
      // The credential VALUE is a bearer capability: the face never echoes it —
      // not the attempt's own and certainly not the OTHER attempt's. (The value
      // still lives in the host's vault FILE; keeping it out of a same-account
      // reader's reach is the platform half, reported, not claimed here.)
      for (const answer of answers) {
        expect(answer).not.toContain(alphaCredential);
        expect(answer).not.toContain(betaCredential);
      }
      expect(nodeOf(await readGraph(fixture), "alpha")["status"]).toBe("settled");
    } finally {
      fixture.host.close();
    }
  });

  it("keeps refusing a worker whose attempt has already SETTLED", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      const credential = credentialOf(fixture, "alpha");
      const accepted = JSON.parse(
        String(
          await fixture.tools.graph_submit_outcome.execute(
            {
              graph_id: fixture.graphId,
              node_id: "alpha",
              outcome_id: "done",
              credential,
            },
            fixture.contextOf(childSessionOf("alpha#1"), "agent.alpha"),
          ),
        ),
      ) as { decision?: string };
      expect(accepted.decision).toBe("accepted");
      expect(nodeOf(await readGraph(fixture), "alpha")["status"]).toBe("settled");

      // The session was bound as a worker and stays bound for this process: a
      // settled attempt's worker is still a worker.
      await expectWorkerRefusal(
        fixture,
        "graph_status",
        { graph_id: fixture.graphId },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: fixture.graphId, attemptId: "alpha#1" },
      );
    } finally {
      fixture.host.close();
    }
  });

  it("finds a worker bound by a PREVIOUS host over the same store (durable reverse lookup)", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    fixture.host.close();

    // A SECOND host over the same store, which never confirmed these
    // executions itself: the binding it judges by is the durable execution row
    // of the still-unsettled dispatch effect.
    const second = bindFaceOver(fixture.dir, fixture.storeRoot);
    try {
      await expectWorkerRefusal(
        { ...second, graphId: FAN_OUT.name },
        "graph_declare",
        { declaration: OTHER },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );
      expect(readStoredDefinition(fixture.storeRoot, OTHER.name).kind).toBe("absent");
    } finally {
      second.host.close();
    }
  });

  it("finds a worker whose attempt SETTLED before a restart (the effect is no longer pending)", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    const betaCredential = credentialOf(fixture, "beta");
    try {
      const accepted = JSON.parse(
        String(
          await fixture.tools.graph_submit_outcome.execute(
            {
              graph_id: fixture.graphId,
              node_id: "alpha",
              outcome_id: "done",
              credential: credentialOf(fixture, "alpha"),
            },
            fixture.contextOf(childSessionOf("alpha#1"), "agent.alpha"),
          ),
        ),
      ) as { decision?: string };
      expect(accepted.decision).toBe("accepted");
      expect(nodeOf(await readGraph(fixture), "alpha")["status"]).toBe("settled");
    } finally {
      fixture.host.close();
    }

    // The attempt SETTLED, so its dispatch effect is no longer pending: a
    // fresh host can only know this session was a worker from the durable
    // EXECUTION row the store keeps after settlement (a created row is never
    // released). A settled attempt's worker is still a worker.
    const second = bindFaceOver(fixture.dir, fixture.storeRoot);
    try {
      await expectWorkerRefusal(
        { ...second, graphId: FAN_OUT.name },
        "graph_status",
        { graph_id: FAN_OUT.name },
        childSessionOf("alpha#1"),
        "agent.alpha",
        { graphId: FAN_OUT.name, attemptId: "alpha#1" },
      );

      // ... and the boundary is not a blanket denial: the attempt that is
      // still open settles through the SAME fresh host, with the credential
      // the first host handed its worker. The delivery survives the restart
      // the boundary is judged across.
      const betaAccepted = JSON.parse(
        String(
          await second.tools.graph_submit_outcome.execute(
            {
              graph_id: FAN_OUT.name,
              node_id: "beta",
              outcome_id: "done",
              credential: betaCredential,
            },
            second.contextOf(childSessionOf("beta#2"), "agent.beta"),
          ),
        ),
      ) as { decision?: string; attempt_id?: string };
      expect(betaAccepted.decision).toBe("accepted");
      expect(betaAccepted.attempt_id).toBe("beta#2");
      expect(nodeOf(await readGraph({ ...second, graphId: FAN_OUT.name }), "beta")["status"]).toBe(
        "settled",
      );
    } finally {
      second.host.close();
    }
  });
});

// ── The boundary does not over-block ────────────────────────────────────────

describe("the boundary refuses only a bound worker", () => {
  it("leaves the declaring session and an unrelated session the full face", async () => {
    const fixture = await openFaceFixture(FAN_OUT);
    try {
      const declarer = fixture.contextOf("session-declarer", "agent.declarer");

      // The DECLARER keeps the status query and the inventory: the graph
      // this session declared resolves to its REAL position, PARSED — not
      // an error string that merely happens to carry the graph's name.
      const status = JSON.parse(
        String(
          await fixture.tools.graph_status.execute(
            { graph_id: FAN_OUT.name, format: "json" },
            declarer,
          ),
        ),
      ) as { graph_id?: string; nodes?: Array<{ node_id?: string; status?: string }> };
      expect(status.graph_id).toBe(FAN_OUT.name);
      expect(status.nodes?.map((node) => node.node_id).sort()).toEqual(["alpha", "beta"]);
      // The position is LIVE, not the declaration snapshot: both entry
      // attempts are running (a snapshot would read `pending`).
      expect(status.nodes?.map((node) => node.status)).toEqual(["dispatched", "dispatched"]);

      const audit = JSON.parse(String(await fixture.tools.graph_audit.execute({}, declarer))) as {
        verdict?: string;
      };
      expect(audit.verdict).toBeDefined();

      // ... and can still declare a NEW graph: the boundary is about the
      // worker principal, not about the tool.
      const declared = JSON.parse(
        String(await fixture.tools.graph_declare.execute({ declaration: OTHER }, declarer)),
      ) as { graph_id?: string };
      expect(declared.graph_id).toBe(OTHER.name);
      expect(readStoredDefinition(fixture.storeRoot, OTHER.name).kind).toBe("ok");

      // An UNRELATED session was never bound by this host, so this boundary
      // does not touch it. (Its SUBMISSIONS are the submission ingress's
      // business — tests/graph/submit-ingress-credentials.test.ts — not this
      // face's.) Its status read is a REAL body answer too, parsed.
      const unrelated = fixture.contextOf("unrelated-session", "unrelated-agent");
      const unrelatedStatus = JSON.parse(
        String(
          await fixture.tools.graph_status.execute(
            { graph_id: FAN_OUT.name, format: "json" },
            unrelated,
          ),
        ),
      ) as { graph_id?: string; nodes?: Array<{ node_id?: string }> };
      expect(unrelatedStatus.graph_id).toBe(FAN_OUT.name);
      expect(unrelatedStatus.nodes?.map((node) => node.node_id).sort()).toEqual([
        "alpha",
        "beta",
      ]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The positive path: the worker still settles its attempt ─────────────────

describe("the delivery still settles through the worker's own submission", () => {
  it("accepts the worker's graph_submit_outcome, arms the successor, and settles the chain", async () => {
    const fixture = await openFaceFixture(CHAIN);
    try {
      // work's own worker settles work.
      const workAccepted = JSON.parse(
        String(
          await fixture.tools.graph_submit_outcome.execute(
            {
              graph_id: fixture.graphId,
              node_id: "work",
              outcome_id: "done",
              credential: credentialOf(fixture, "work"),
            },
            fixture.contextOf(childSessionOf("work#1"), "agent.work"),
          ),
        ),
      ) as { decision?: string; attempt_id?: string };
      expect(workAccepted.decision).toBe("accepted");
      expect(workAccepted.attempt_id).toBe("work#1");

      // The acceptance ARMED the successor attempt under the same declaring
      // invocation, and the platform confirmed its child session.
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual([
        "work#1",
        "review#2",
      ]);
      const midway = await readGraph(fixture);
      expect(nodeOf(midway, "work")["status"]).toBe("settled");
      expect(nodeOf(midway, "review")["status"]).toBe("dispatched");

      // review's own worker settles review: the flow reaches its end through
      // the SAME face the boundary judges, with no second ingress.
      const reviewAccepted = JSON.parse(
        String(
          await fixture.tools.graph_submit_outcome.execute(
            {
              graph_id: fixture.graphId,
              node_id: "review",
              outcome_id: "approve",
              credential: credentialOf(fixture, "review"),
            },
            fixture.contextOf(childSessionOf("review#2"), "agent.review"),
          ),
        ),
      ) as { decision?: string; attempt_id?: string };
      expect(reviewAccepted.decision).toBe("accepted");
      expect(reviewAccepted.attempt_id).toBe("review#2");

      const settled = await readGraph(fixture);
      expect(settled.events).toBe(2);
      expect(nodeOf(settled, "work")["status"]).toBe("settled");
      expect(nodeOf(settled, "review")["status"]).toBe("settled");
      // The graph itself reached its terminal phase through those two
      // worker settlements.
      expect(settled.body?.["phase"]).toBe("complete");
    } finally {
      fixture.host.close();
    }
  });
});

/**
 * Counterexample 4, end to end through the SHIPPED submission ingress.
 *
 * THE DEFECT THIS PINS. The previous round's fourth reproduction was 'an
 * unrelated session / another attempt's credential reaches a settlement'. The
 * acceptance layer already refuses a changed execution identity and reads the
 * credential as an opaque non-empty string (tests/graph/acceptance.test.ts),
 * but no case drove the MODEL-FACING ingress over the real host layer: the
 * submission logic, the real OutcomeHost, the real OutcomeGraphRuntime and the
 * SQLite acceptance ledger. This file does exactly that and refuses, by name,
 * each way a credential can be wrong:
 *
 * 1. no credential at all                          -> credential-missing
 * 2. another node's LIVE credential                -> credential-node-mismatch
 * 3. a superseded attempt's credential             -> credential-unknown
 * 4. a tampered credential                         -> credential-unknown
 *
 * After EACH refusal the authoritative record is read back from the ledger and
 * compared with its pre-submission snapshot: the attempt is still open in the
 * graph state and no accepted event was appended.
 *
 * THE WORKER BINDING, WHICH REPLACED THAT BOUNDARY (P2 item 2). The shipped
 * entries still decline the D9 dispatch-identity capability — the declaring
 * invocation is attribution, not the worker's identity — but they now inject
 * the WORKER-identity capability, so a submission must arrive from the child
 * session the platform created for the attempt's worker. The boundary case
 * P0 pinned (an unrelated session accepted a correct credential, BECAUSE no
 * identity was declared) is therefore UPDATED DELIBERATELY at the bottom of
 * this file: the shipped tool face now refuses that call, and the
 * no-capability acceptance it used to assert stays a case of its own, so the
 * old behavior is documented rather than deleted.
 *
 * Every case runs in its own mkdtemp directory and closes its host in a
 * finally block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { HostDispatchInvocation } from "../../src/graph/host/dispatch-host.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { attemptCredentialDigest } from "../../src/graph/outcome/attempt-credential.ts";
import {
  HOST_WORKER_ABSENT_CODE,
  HOST_WORKER_SESSION_MISMATCH_CODE,
  HOST_WORKER_UNBOUND_CODE,
} from "../../src/graph/outcome/host-identity.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import {
  submitDeclaredOutcome,
  type GraphSubmitOutcomeArgs,
  type GraphSubmitOutcomeResult,
} from "../../src/graph/tools/submit-outcome.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/**
 * alpha and beta are BOTH entry nodes: one start dispatches both, so the vault
 * holds two live attempt credentials at once — the population a submission can
 * try to cross.
 */
const TWO_ENTRIES: GraphDeclarationV3 = {
  version: 3,
  name: "ingress.two-entries",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/**
 * work -> review -> (revise) -> work, so settling review's continuation arms a
 * SECOND attempt of work. That is a genuine superseded attempt — its credential
 * was really issued for work#1, and the persisted state has moved on to work#3.
 */
const ATTEMPT_LOOP: GraphDeclarationV3 = {
  version: 3,
  name: "ingress.attempt-loop",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "revise" }, { id: "approve" }],
    },
  ],
  edges: [
    { from: "work", to: "review", outcome: "done" },
    { from: "review", to: "work", outcome: "revise" },
  ],
  loop_groups: [
    {
      id: "revise-loop",
      nodes: ["work", "review"],
      max_traversals: 2,
      continuation_outcome: "revise",
      exit_outcome: "approve",
    },
  ],
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

/** What every fixture in this file offers to the shared read-back helpers. */
interface SubmissionFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly graphId: string;
  readonly host: OutcomeHost;
  readonly dispatched: readonly OutcomeDispatchRequest[];
}

interface IngressFixture extends SubmissionFixture {
  readonly invocations: readonly (HostDispatchInvocation | undefined)[];
}

/**
 * One DECLARED graph over a real host, started through the host's own entry.
 *
 * The host takes the SHIPPED configuration: declareInvocationIdentity false
 * (the dsh / Pi entries) and the default durableCredentialStore 'none', with
 * the default file durability. The graph is started through
 * startDeclaredGraph, which is the entry the declaration seam and the boot
 * sweep share, so the attempt and its credential are produced by the real run
 * path rather than assembled by the test.
 */
async function openIngressFixture(
  declaration: GraphDeclarationV3,
): Promise<IngressFixture> {
  const dir = makeTmpDir("submit-ingress-");
  const storeRoot = join(dir, "host-store");
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration }), storeRoot);
  const dispatched: OutcomeDispatchRequest[] = [];
  const invocations: (HostDispatchInvocation | undefined)[] = [];
  const host = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, _effect, invocation) => {
      dispatched.push(request);
      invocations.push(invocation);
    },
    validators: EMPTY_VALIDATORS,
    // THE SHIPPED DECISION (src/entries/dsh.ts): the host cannot substantiate
    // an invocation attribution for a worker's own tool call, so it declares
    // none. The bearer credential remains the binding.
    declareInvocationIdentity: false,
  });
  const started = await host.startDeclaredGraph(declaration.name, {
    sessionId: "session-declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return { dir, storeRoot, graphId: declaration.name, host, dispatched, invocations };
}

/** Submit through the REAL ingress with the deps the shipped toolset builds. */
function submit(
  fixture: IngressFixture,
  args: GraphSubmitOutcomeArgs,
): Promise<GraphSubmitOutcomeResult> {
  return submitDeclaredOutcome(
    { workspaceDir: fixture.dir, graphId: fixture.graphId, declaredInMemory: true },
    args,
    {
      dispatch: fixture.host.dispatch,
      validators: EMPTY_VALIDATORS,
      credentialIsolation: fixture.host.credentialIsolation,
      artifactRoot: fixture.dir,
      // NO hostIdentity: the shipped entry installs none (see the fixture).
    },
  );
}

/** The credential the vault holds for exactly one attempt, or a fixture error. */
function credentialOf(
  fixture: SubmissionFixture,
  nodeId: string,
  attemptId: string,
): string {
  const credential = fixture.host.credentials.resolve({
    graphId: fixture.graphId,
    nodeId,
    attemptId,
  });
  if (credential === undefined) {
    throw new Error("fixture: the vault holds no credential for " + nodeId + " " + attemptId);
  }
  return credential;
}

/** The credential one dispatch request carried, or a fixture error. */
function dispatchedCredential(
  fixture: SubmissionFixture,
  nodeId: string,
): string {
  const request = fixture.dispatched.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) {
    throw new Error("fixture: no dispatch request for node " + nodeId);
  }
  return request.credential;
}

interface PersistedReading {
  /** The whole state row, for a snapshot comparison. */
  readonly record: unknown;
  /** How many accepted events the graph has appended. */
  readonly events: number;
  /** The state body, for node-level assertions. */
  readonly body: Record<string, unknown> | undefined;
}

/** Read the AUTHORITATIVE record (the ledger) with a fresh connection. */
async function readPersisted(fixture: SubmissionFixture): Promise<PersistedReading> {
  const ledger = await SqliteAcceptanceLedger.create(fixture.storeRoot);
  try {
    const record = ledger.readGraphState(fixture.graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    return {
      record,
      events: ledger.acceptedEvents(fixture.graphId).length,
      body,
    };
  } finally {
    ledger.close();
  }
}

/** The persisted entry of one node, or a fixture error. */
function nodeEntryOf(
  reading: PersistedReading,
  nodeId: string,
): Record<string, unknown> {
  const nodes = reading.body?.["nodes"];
  if (!Array.isArray(nodes)) {
    throw new Error("fixture: the persisted state carries no nodes array");
  }
  for (const entry of nodes) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["nodeId"] === nodeId) return record;
  }
  throw new Error("fixture: the persisted state carries no entry for " + nodeId);
}

/** A canonical tool context, mirroring the registration test helper. */
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

// ── The four ways a credential can be wrong ─────────────────────────────────

describe("submission ingress over the real host — a wrong credential settles nothing", () => {
  it("refuses a submission that carries no credential (credential-missing) and leaves the record unchanged", async () => {
    const fixture = await openIngressFixture(TWO_ENTRIES);
    try {
      expect(fixture.invocations).toEqual([
        { sessionId: "session-declarer", agent: "agent.declarer" },
        { sessionId: "session-declarer", agent: "agent.declarer" },
      ]);
      const before = await readPersisted(fixture);

      const result = await submit(fixture, {
        graph_id: fixture.graphId,
        node_id: "alpha",
        outcome_id: "done",
      });

      expect(result.decision).toBeUndefined();
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-missing",
      ]);
      expect(result.refusals[0]?.path).toBe("$.credential");

      const after = await readPersisted(fixture);
      expect(after.events).toBe(0);
      expect(after.record).toEqual(before.record);
      const alpha = nodeEntryOf(after, "alpha");
      expect(alpha["status"]).toBe("dispatched");
      expect(alpha["attemptId"]).toBe("alpha#1");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses another node's live credential presented for this node (credential-node-mismatch) and leaves the record unchanged", async () => {
    const fixture = await openIngressFixture(TWO_ENTRIES);
    try {
      const betaCredential = dispatchedCredential(fixture, "beta");
      // POSITIVE CONTROL: the credential is a live, vault-held credential for
      // beta#2 — the refusal below is about the BINDING, not about a bogus value.
      expect(credentialOf(fixture, "beta", "beta#2")).toBe(betaCredential);
      const before = await readPersisted(fixture);

      const result = await submit(fixture, {
        graph_id: fixture.graphId,
        node_id: "alpha",
        outcome_id: "done",
        credential: betaCredential,
      });

      expect(result.decision).toBeUndefined();
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-node-mismatch",
      ]);

      const after = await readPersisted(fixture);
      expect(after.events).toBe(0);
      expect(after.record).toEqual(before.record);
      expect(nodeEntryOf(after, "alpha")["status"]).toBe("dispatched");
      expect(nodeEntryOf(after, "beta")["status"]).toBe("dispatched");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a SUPERSEDED attempt's credential (credential-unknown) and leaves the record unchanged", async () => {
    const fixture = await openIngressFixture(ATTEMPT_LOOP);
    try {
      // work#1 is armed; its credential is the real one the delivery carried.
      const firstWorkCredential = dispatchedCredential(fixture, "work");
      expect(credentialOf(fixture, "work", "work#1")).toBe(firstWorkCredential);

      // Advance the run through the SAME ingress: work's outcome arms review,
      // and review's continuation re-arms work as a NEW attempt.
      const workAccepted = await submit(fixture, {
        graph_id: fixture.graphId,
        node_id: "work",
        outcome_id: "done",
        credential: firstWorkCredential,
      });
      expect(workAccepted.decision).toBe("accepted");
      const reviewCredential = credentialOf(fixture, "review", "review#2");
      const reviewAccepted = await submit(fixture, {
        graph_id: fixture.graphId,
        node_id: "review",
        outcome_id: "revise",
        credential: reviewCredential,
      });
      expect(reviewAccepted.decision).toBe("accepted");

      // The state now records work's SECOND attempt, and its verifier is no
      // longer the first attempt's.
      const before = await readPersisted(fixture);
      expect(before.events).toBe(2);
      const work = nodeEntryOf(before, "work");
      expect(work["status"]).toBe("dispatched");
      expect(work["attemptId"]).toBe("work#3");
      const secondWorkCredential = credentialOf(fixture, "work", "work#3");
      expect(work["attemptCredentialDigest"]).toBe(
        attemptCredentialDigest(secondWorkCredential),
      );
      expect(work["attemptCredentialDigest"]).not.toBe(
        attemptCredentialDigest(firstWorkCredential),
      );

      // The FIRST attempt's credential is a real credential issued for this
      // node — and it is refused, because that attempt is superseded.
      const result = await submit(fixture, {
        graph_id: fixture.graphId,
        node_id: "work",
        outcome_id: "done",
        credential: firstWorkCredential,
      });
      expect(result.decision).toBeUndefined();
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-unknown",
      ]);

      const after = await readPersisted(fixture);
      expect(after.events).toBe(2);
      expect(after.record).toEqual(before.record);
      expect(nodeEntryOf(after, "work")["attemptId"]).toBe("work#3");
      expect(nodeEntryOf(after, "work")["status"]).toBe("dispatched");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a tampered credential (credential-unknown) and leaves the record unchanged", async () => {
    const fixture = await openIngressFixture(TWO_ENTRIES);
    try {
      const alphaCredential = dispatchedCredential(fixture, "alpha");
      expect(credentialOf(fixture, "alpha", "alpha#1")).toBe(alphaCredential);
      const tampered =
        alphaCredential[0] === "0"
          ? "1" + alphaCredential.slice(1)
          : "0" + alphaCredential.slice(1);
      expect(tampered).not.toBe(alphaCredential);
      const before = await readPersisted(fixture);

      const result = await submit(fixture, {
        graph_id: fixture.graphId,
        node_id: "alpha",
        outcome_id: "done",
        credential: tampered,
      });

      expect(result.decision).toBeUndefined();
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-unknown",
      ]);

      const after = await readPersisted(fixture);
      expect(after.events).toBe(0);
      expect(after.record).toEqual(before.record);
      const alpha = nodeEntryOf(after, "alpha");
      expect(alpha["status"]).toBe("dispatched");
      expect(alpha["attemptId"]).toBe("alpha#1");
    } finally {
      fixture.host.close();
    }
  });
});

// ── The worker binding: the child session the platform created ─────────────

interface WorkerFixture extends SubmissionFixture {
  /** The child session the platform "created", per attempt id. */
  readonly childSessions: ReadonlyMap<string, string>;
  /** Submit through the SHIPPED tool face, from one invocation context. */
  submit(
    args: Record<string, unknown>,
    invocation: { readonly sessionID: string; readonly agent: string },
  ): Promise<GraphSubmitOutcomeResult>;
}

/**
 * THE SHIPPED ASSEMBLY with a platform that names a real execution.
 *
 * `confirm` decides whether the delivery reports the execution the platform
 * created — the host fact `OutcomeHost.confirmExecution` records. The child
 * session is minted from the attempt id by the SAME one-line mapping the dsh
 * entry installs (`run.id` IS the published child session id), so every session
 * a case uses is a platform-minted id and never a string a submission chose.
 */
async function openWorkerFixture(
  declaration: GraphDeclarationV3,
  options: { readonly confirm: boolean },
): Promise<WorkerFixture> {
  const dir = makeTmpDir("submit-worker-");
  const storeRoot = join(dir, "host-store");
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration }), storeRoot);
  const dispatched: OutcomeDispatchRequest[] = [];
  const childSessions = new Map<string, string>();
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      if (!options.confirm) return;
      const childSession = "child-session:" + request.attemptId;
      childSessions.set(request.attemptId, childSession);
      host?.confirmExecution(effect, { executionId: childSession });
    },
    validators: EMPTY_VALIDATORS,
    // THE SHIPPED DECISION: the declaring invocation is attribution, not the
    // worker's identity.
    declareInvocationIdentity: false,
    // The platform's own child-session fact (the dsh entry's mapping).
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const started = await opened.startDeclaredGraph(declaration.name, {
    sessionId: "session-declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return {
    dir,
    storeRoot,
    graphId: declaration.name,
    host: opened,
    dispatched,
    childSessions,
    submit: async (args, invocation) => {
      // THE SHIPPED TOOL FACE: the same toolset, the same identity option and
      // the same per-call attribution the entries install.
      const toolset = createGraphToolSet({
        stateDir: dir,
        credentialIsolation: opened.credentialIsolation,
        hostIdentity: opened.workerIdentity,
        outcomeDispatch: opened.dispatch,
        outcomeValidators: EMPTY_VALIDATORS,
        outcomeArtifactRoot: dir,
      });
      const tools = opened.bindTools(createOutcomeGraphTools(toolset));
      const raw = await tools.graph_submit_outcome.execute(
        args,
        makeContext(invocation.sessionID, invocation.agent, dir),
      );
      return JSON.parse(String(raw)) as GraphSubmitOutcomeResult;
    },
  };
}

describe("the worker binding — a submission must arrive from the attempt's own worker", () => {
  it("refuses an unrelated session, then settles from the platform's child session", async () => {
    const fixture = await openWorkerFixture(TWO_ENTRIES, { confirm: true });
    try {
      const alphaCredential = dispatchedCredential(fixture, "alpha");
      expect(fixture.childSessions.get("alpha#1")).toBe("child-session:alpha#1");
      const before = await readPersisted(fixture);

      const refused = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential: alphaCredential,
        },
        { sessionID: "unrelated-session", agent: "unrelated-agent" },
      );
      expect(refused.decision).toBeUndefined();
      expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
        HOST_WORKER_SESSION_MISMATCH_CODE,
      ]);
      expect(refused.refusals[0]?.path).toBe("$.workerSession");
      expect(refused.attempt_id).toBeUndefined();

      // NOTHING was written by the refusal: same state row, no accepted event.
      const afterRefusal = await readPersisted(fixture);
      expect(afterRefusal.events).toBe(0);
      expect(afterRefusal.record).toEqual(before.record);
      expect(nodeEntryOf(afterRefusal, "alpha")["status"]).toBe("dispatched");

      // THE SAME CREDENTIAL FROM THE ATTEMPT'S OWN WORKER SETTLES IT.
      const accepted = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential: alphaCredential,
        },
        { sessionID: "child-session:alpha#1", agent: "agent.alpha" },
      );
      expect(accepted.decision).toBe("accepted");
      expect(accepted.attempt_id).toBe("alpha#1");
      expect(accepted.refusals).toEqual([]);

      const after = await readPersisted(fixture);
      expect(after.events).toBe(1);
      expect(nodeEntryOf(after, "alpha")["status"]).toBe("settled");
      expect(nodeEntryOf(after, "beta")["status"]).toBe("dispatched");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses an attempt whose execution the platform never confirmed (host-worker-unbound)", async () => {
    const fixture = await openWorkerFixture(TWO_ENTRIES, { confirm: false });
    try {
      const credential = dispatchedCredential(fixture, "alpha");
      const before = await readPersisted(fixture);
      const result = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential,
        },
        { sessionID: "child-session:alpha#1", agent: "agent.alpha" },
      );
      expect(result.decision).toBeUndefined();
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        HOST_WORKER_UNBOUND_CODE,
      ]);
      const after = await readPersisted(fixture);
      expect(after.events).toBe(0);
      expect(after.record).toEqual(before.record);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a call the host attributes no session to (host-worker-absent)", async () => {
    const fixture = await openWorkerFixture(TWO_ENTRIES, { confirm: true });
    try {
      const credential = dispatchedCredential(fixture, "alpha");
      const result = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential,
        },
        { sessionID: "", agent: "agent.alpha" },
      );
      expect(result.decision).toBeUndefined();
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        HOST_WORKER_ABSENT_CODE,
      ]);
      expect(nodeEntryOf(await readPersisted(fixture), "alpha")["status"]).toBe("dispatched");
    } finally {
      fixture.host.close();
    }
  });

  it("keeps the credential refusals' precise codes with the worker capability installed", async () => {
    const fixture = await openWorkerFixture(TWO_ENTRIES, { confirm: true });
    try {
      const betaCredential = dispatchedCredential(fixture, "beta");
      const cases: readonly [Record<string, unknown>, string, string][] = [
        [
          { graph_id: fixture.graphId, node_id: "alpha", outcome_id: "done" },
          "credential-missing",
          "child-session:alpha#1",
        ],
        [
          {
            graph_id: fixture.graphId,
            node_id: "alpha",
            outcome_id: "done",
            credential: betaCredential,
          },
          "credential-node-mismatch",
          "child-session:beta#2",
        ],
        [
          {
            graph_id: fixture.graphId,
            node_id: "alpha",
            outcome_id: "done",
            credential: "not-a-credential",
          },
          "credential-unknown",
          "child-session:alpha#1",
        ],
      ];
      for (const [args, code, sessionID] of cases) {
        const result = await fixture.submit(args, { sessionID, agent: "agent.alpha" });
        expect(result.decision).toBeUndefined();
        expect(result.refusals.map((refusal) => refusal.code)).toEqual([code]);
      }
      // Every refusal above is the CREDENTIAL's: the worker check yielded to the
      // more precise answer instead of masking it, and nothing was written.
      const after = await readPersisted(fixture);
      expect(after.events).toBe(0);
      expect(nodeEntryOf(after, "alpha")["status"]).toBe("dispatched");
      expect(nodeEntryOf(after, "beta")["status"]).toBe("dispatched");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses an OLD worker session for the re-armed attempt, and settles from the current worker", async () => {
    const fixture = await openWorkerFixture(ATTEMPT_LOOP, { confirm: true });
    try {
      const firstWork = dispatchedCredential(fixture, "work");
      const firstAccepted = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "work",
          outcome_id: "done",
          credential: firstWork,
        },
        { sessionID: "child-session:work#1", agent: "agent.work" },
      );
      expect(firstAccepted.decision).toBe("accepted");

      const reviewCredential = credentialOf(fixture, "review", "review#2");
      const reviewAccepted = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "review",
          outcome_id: "revise",
          credential: reviewCredential,
        },
        { sessionID: "child-session:review#2", agent: "agent.review" },
      );
      expect(reviewAccepted.decision).toBe("accepted");

      const before = await readPersisted(fixture);
      expect(nodeEntryOf(before, "work")["attemptId"]).toBe("work#3");
      const currentWork = credentialOf(fixture, "work", "work#3");
      expect(fixture.childSessions.get("work#3")).toBe("child-session:work#3");

      // THE OLD WORKER CANNOT SETTLE THE NEW ATTEMPT, even holding the new
      // attempt's own credential: the binding is per attempt, and a session is
      // not re-aimed at a later generation of the same node.
      const refused = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "work",
          outcome_id: "done",
          credential: currentWork,
        },
        { sessionID: "child-session:work#1", agent: "agent.work" },
      );
      expect(refused.decision).toBeUndefined();
      expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
        HOST_WORKER_SESSION_MISMATCH_CODE,
      ]);
      expect(await readPersisted(fixture)).toEqual(before);

      // The CURRENT attempt's own worker settles it.
      const accepted = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "work",
          outcome_id: "done",
          credential: currentWork,
        },
        { sessionID: "child-session:work#3", agent: "agent.work" },
      );
      expect(accepted.decision).toBe("accepted");
      expect(accepted.attempt_id).toBe("work#3");
    } finally {
      fixture.host.close();
    }
  });
});

// ── The boundary P0 pinned, deliberately updated ────────────────────────────

describe("the shipped path now binds an attempt by its credential AND its worker", () => {
  it("REFUSES a correct credential from an unrelated session, because the worker binding is declared", async () => {
    const fixture = await openWorkerFixture(TWO_ENTRIES, { confirm: true });
    try {
      const alphaCredential = dispatchedCredential(fixture, "alpha");
      const before = await readPersisted(fixture);

      // The call arrives through the SHIPPED tool face (the same toolset, the
      // same hostIdentity option and the same per-call attribution the entries
      // install) from a completely unrelated invocation.
      const refused = await fixture.submit(
        {
          graph_id: fixture.graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential: alphaCredential,
        },
        { sessionID: "unrelated-session", agent: "unrelated-agent" },
      );

      // P0's case asserted the ACCEPTANCE of exactly this shape, BECAUSE no
      // identity was declared. The shipped path now declares the worker
      // binding, so the boundary moved: the same call is REFUSED by name and
      // the authoritative record is untouched. The no-capability acceptance is
      // preserved as its own case below.
      expect(refused.decision).toBeUndefined();
      expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
        HOST_WORKER_SESSION_MISMATCH_CODE,
      ]);
      const after = await readPersisted(fixture);
      expect(after.events).toBe(0);
      expect(after.record).toEqual(before.record);
      expect(nodeEntryOf(after, "alpha")["status"]).toBe("dispatched");
      // The attempt itself still carries NO D9 dispatch identity: the
      // declaring invocation was never recorded as the worker's identity.
      expect(Object.prototype.hasOwnProperty.call(nodeEntryOf(after, "alpha"), "dispatchIdentity")).toBe(false);
    } finally {
      fixture.host.close();
    }
  });

  it("ACCEPTS a correct credential from any session when the host installs NO capability at all", async () => {
    const fixture = await openIngressFixture(TWO_ENTRIES);
    try {
      const alphaCredential = dispatchedCredential(fixture, "alpha");
      // THE PRE-EXISTING, HONEST BOUNDARY, kept as its own case: a host that
      // declares no identity capability gets no session check — the attempt
      // credential is the only binding, and this is ACCEPTED. Nothing about
      // the arriving invocation is recorded on the attempt.
      const toolset = createGraphToolSet({
        stateDir: fixture.dir,
        credentialIsolation: fixture.host.credentialIsolation,
        outcomeDispatch: fixture.host.dispatch,
        outcomeValidators: EMPTY_VALIDATORS,
      });
      const tools = fixture.host.bindTools(createOutcomeGraphTools(toolset));
      const raw = await tools.graph_submit_outcome.execute(
        {
          graph_id: fixture.graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential: alphaCredential,
        },
        makeContext("unrelated-session", "unrelated-agent", fixture.dir),
      );
      const result = JSON.parse(String(raw)) as GraphSubmitOutcomeResult;
      expect(result.decision).toBe("accepted");
      expect(result.refusals).toEqual([]);
      expect(result.attempt_id).toBe("alpha#1");

      const after = await readPersisted(fixture);
      const alpha = nodeEntryOf(after, "alpha");
      expect(alpha["status"]).toBe("settled");
      expect(Object.prototype.hasOwnProperty.call(alpha, "dispatchIdentity")).toBe(false);
    } finally {
      fixture.host.close();
    }
  });
});

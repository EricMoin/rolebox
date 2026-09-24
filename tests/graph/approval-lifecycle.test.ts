/**
 * P3 item 3 — THE TRUSTED APPROVAL LIFECYCLE
 * (plan §4 P3 "审批", §5 A12, §8.8).
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR, through the SHIPPED assembly (a real
 * OutcomeHost, the workspace's one SQLite store, the real createGraphToolSet and
 * the real graph_control / graph_submit_outcome tools bound by OutcomeHost):
 *
 * - a node's in-flight attempt can be PAUSED on a durable request, and the pause
 *   is the row, not a convention: every later assertion reads it back with a
 *   FRESH connection;
 * - a WORKER'S PAYLOAD CAN NEVER SATISFY THE GATE. The case below submits a
 *   payload carrying `approved: true` and a claim inside `data`, and the request
 *   is still pending afterwards and no receipt, accepted event or state advance
 *   was written;
 * - only the session the request NAMES may decide it: the DECLARING principal is
 *   refused by name when it named someone else, and a dispatched worker's call is
 *   refused before the tool body;
 * - repeats and races have ONE stated rule each: a repeated decision replays, a
 *   competing decision is refused with the status that stands, expiry is
 *   materialized by the deadline sweep and by a late decision, and a
 *   run-stopping command expires the pending requests of its run while an
 *   approval that already committed stands untouched;
 * - approval is CONTROL, never an outcome: no approval command writes a receipt,
 *   an accepted event or a state advance.
 *
 * STRENGTH: adapter + real store, process-level. The cross-process half of the
 * restart story lives in approval-restart-cross-process.test.ts; nothing here is
 * real-host evidence (no dsh/Pi SDK runs in this environment).
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import {
  createGraphToolSet,
  type GraphToolSet,
} from "../../src/graph/tools/graph-tools.ts";
import type { GraphControlEntryArgs } from "../../src/graph/tools/control-entry.ts";
import { runGraphControlEntry } from "../../src/graph/tools/control-entry.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../src/platform/types.ts";

setDefaultTimeout(30_000);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The one explicit instant every control command in this file is stamped with. */
const AT = 1_700_000_000_000;

/** The deadline the approval cases raise their requests with. */
const DEADLINE = AT + 60_000;

/** The session that declares (and therefore controls) the graph. */
const DECLARER = "session.declarer";

/** The session the requests in this file NAME as their approver. */
const APPROVER = "session.approver";

/** work -> review: an accepted outcome for work arms the review attempt. */
const CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "approval.chain",
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

/** Two ENTRY nodes: one start leaves two attempts in flight at once. */
const FAN_OUT: GraphDeclarationV3 = {
  version: 3,
  name: "approval.fan-out",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
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

/** The child session the platform "created" for one attempt. */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

interface ApprovalFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatched: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
  /** Move the HOST's clock, which is what the boot sweep measures deadlines by. */
  readonly setClock: (at: number) => void;
}

/** One shipped host assembly over a REAL declared and started graph. */
async function openFixture(declaration: GraphDeclarationV3): Promise<ApprovalFixture> {
  const dir = makeTmpDir("approval-lifecycle-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatched: OutcomeDispatchRequest[] = [];
  // THE HOST'S CLOCK IS A TEST INPUT, so the boot sweep's deadline arithmetic is
  // deterministic: nothing in this file waits on wall-clock time.
  let clockNow = AT;
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
    clock: () => clockNow,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: createValidatorRegistry([]),
    outcomeArtifactRoot: dir,
    // TIME IS AN EXPLICIT INPUT, exactly as it is on the wire: every control
    // command this fixture issues is stamped with the same instant, so a case's
    // expiry assertions are arithmetic on a constant, never a race with a clock.
    outcomeNow: AT,
  });
  const fixture: ApprovalFixture = {
    dir,
    storeRoot,
    host: opened,
    toolset,
    tools: opened.bindTools(createOutcomeGraphTools(toolset)),
    dispatched,
    graphId: declaration.name,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
    setClock: (value: number) => {
      clockNow = value;
    },
  };
  const declared = String(
    await fixture.tools.graph_declare.execute(
      { declaration },
      fixture.contextOf(DECLARER, "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await opened.startDeclaredGraph(declaration.name, {
    sessionId: DECLARER,
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
  readonly command?: string;
  readonly scope?: string;
  readonly runControl?: { readonly command: string } | undefined;
  readonly decided?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly replayed: boolean;
    readonly decision: { readonly command: string; readonly reason: string };
  }[];
  readonly approval?: {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly replayed: boolean;
    readonly request: {
      readonly status: string;
      readonly attemptId: string;
      readonly approverSessionId: string;
      readonly expiresAt: number;
      readonly requestedAt: number;
      readonly reason: string;
      readonly decidedAt?: number;
      readonly decisionReason?: string;
      readonly decidedBy?: { readonly sessionId: string };
    };
  };
  readonly expiredApprovals?: readonly {
    readonly attemptId: string;
    readonly status: string;
    readonly decisionReason?: string;
  }[];
  readonly refusals?: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
}

/** What one submit answered. */
interface SubmitAnswer {
  readonly decision?: string;
  readonly verdict?: string;
  readonly verdict_reason?: string;
  readonly refusals?: readonly { readonly code: string; readonly message: string }[];
  readonly phase?: string;
}

/** Run one command through the SHIPPED control entry (the same one the tool calls). */
function control(
  fixture: ApprovalFixture,
  args: GraphControlEntryArgs,
  sessionID: string,
  agent: string,
  now: number = AT,
): ControlAnswer {
  return JSON.parse(
    JSON.stringify(
      runGraphControlEntry(
        { storeDirectory: fixture.storeRoot, now },
        args,
        sessionID,
        agent,
      ),
    ),
  ) as ControlAnswer;
}

/** Run one command through the SHIPPED graph_control tool (schema + binding). */
async function controlTool(
  fixture: ApprovalFixture,
  args: GraphControlEntryArgs,
  sessionID: string,
  agent: string,
): Promise<ControlAnswer> {
  const raw = String(
    await fixture.tools.graph_control.execute(
      { ...args },
      fixture.contextOf(sessionID, agent),
    ),
  );
  // The host's worker boundary answers a dispatched worker with a plain refusal
  // string rather than a control answer, and that IS the fact under test: it is
  // reported as a refusal so the case can assert the code the boundary named.
  const parsed = parseAnswer(raw);
  if (parsed === undefined) {
    return { kind: "refused", refusals: [{ code: raw.split(":")[0] ?? raw, path: "$", message: raw }] };
  }
  return parsed;
}

/** Parse a tool answer, or `undefined` when it is a plain refusal string. */
function parseAnswer(raw: string): ControlAnswer | undefined {
  try {
    return JSON.parse(raw) as ControlAnswer;
  } catch {
    return undefined;
  }
}

/** Submit one node's outcome through the SHIPPED ingress. */
async function submit(
  fixture: ApprovalFixture,
  nodeId: string,
  outcomeId: string,
  extra: { readonly data?: unknown } = {},
): Promise<SubmitAnswer> {
  const raw = String(
    await fixture.tools.graph_submit_outcome.execute(
      {
        graph_id: fixture.graphId,
        node_id: nodeId,
        outcome_id: outcomeId,
        credential: credentialOf(fixture, nodeId),
        ...(extra.data === undefined ? {} : { data: extra.data }),
      },
      fixture.contextOf(childSessionOf(attemptOf(fixture, nodeId)), "agent." + nodeId),
    ),
  );
  try {
    return JSON.parse(raw) as SubmitAnswer;
  } catch {
    // A plain refusal string (the ingress reports an unreadable plan, a missing
    // store and the worker boundary this way) is surfaced as a refusal code, so a
    // failing case reports the engine's own words instead of a JSON parse error.
    return { refusals: [{ code: raw.split(":")[0] ?? raw, message: raw }] };
  }
}

/** The attempt id one node was dispatched on, as the dispatched request recorded it. */
function attemptOf(fixture: ApprovalFixture, nodeId: string): string {
  const request = fixture.dispatched.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no dispatch for node " + nodeId);
  return request.attemptId;
}

/** The credential one dispatched attempt was handed (never printed by a test). */
function credentialOf(fixture: ApprovalFixture, nodeId: string): string {
  const request = fixture.dispatched.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no dispatch for node " + nodeId);
  return request.credential;
}

/** Everything this file asserts about the durable facts, read with a FRESH connection. */
function readFacts(fixture: ApprovalFixture): {
  readonly runId: string | undefined;
  readonly requests: readonly {
    readonly attemptId: string;
    readonly nodeId: string;
    readonly status: string;
    readonly approverSessionId: string;
    readonly expiresAt: number;
    readonly requestedAt: number;
    readonly decidedAt?: number;
    readonly decisionReason?: string;
    readonly decidedBy?: { readonly sessionId: string };
    readonly requestedBy?: { readonly sessionId: string };
  }[];
  readonly control: { readonly command: string } | undefined;
  readonly decisions: readonly {
    readonly attemptId: string;
    readonly command: string;
    readonly reason: string;
    readonly decidedBy?: { readonly sessionId: string };
    readonly successorAttemptId?: string;
  }[];
  readonly events: readonly { readonly attemptId: string; readonly outcomeId: string }[];
  readonly receipts: number;
  readonly phase: string | undefined;
  readonly nodeStatus: string | undefined;
} {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    const run = store.runs.readRun(fixture.graphId);
    const record = store.readGraphState(fixture.graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const nodes = Array.isArray(body?.["nodes"])
      ? (body["nodes"] as readonly Record<string, unknown>[])
      : [];
    const work = nodes.find((node) => node["nodeId"] === "work");
    return {
      runId: run?.runId,
      requests: store.approvals.approvalRequestsOf(fixture.graphId),
      control: store.runs.readRunControl(fixture.graphId),
      decisions: store.runs.controlDecisions(fixture.graphId),
      events: store.acceptedEvents(fixture.graphId),
      receipts:
        (store.all(
          "SELECT COUNT(*) AS n FROM ledger_receipts WHERE graph_id = ?",
          fixture.graphId,
        )[0]?.["n"] as number) ?? -1,
      phase: typeof body?.["phase"] === "string" ? (body["phase"] as string) : undefined,
      nodeStatus:
        typeof work?.["status"] === "string" ? (work["status"] as string) : undefined,
    };
  } finally {
    store.close();
  }
}

/** The one request row, or a fixture error. */
function requestOf(facts: ReturnType<typeof readFacts>): ReturnType<typeof readFacts>["requests"][number] {
  const request = facts.requests[0];
  if (request === undefined) throw new Error("fixture: no approval request was recorded");
  return request;
}

/** Raise one request for work's current attempt through the shipped entry. */
function raise(
  fixture: ApprovalFixture,
  options: {
    readonly approver?: string;
    readonly expiresAt?: number;
    readonly sessionID?: string;
    readonly now?: number;
    readonly reason?: string;
    readonly nodeId?: string;
  } = {},
): ControlAnswer {
  return control(
    fixture,
    {
      graph_id: fixture.graphId,
      command: "approval-request",
      node_id: options.nodeId ?? "work",
      reason: options.reason ?? "hold the work for sign-off",
      approver_session_id: options.approver ?? APPROVER,
      expires_at: options.expiresAt ?? DEADLINE,
    },
    options.sessionID ?? DECLARER,
    "agent.declarer",
    options.now ?? AT,
  );
}

function decide(
  fixture: ApprovalFixture,
  command: "approve" | "reject",
  options: { readonly sessionID?: string; readonly now?: number; readonly reason?: string } = {},
): ControlAnswer {
  return control(
    fixture,
    {
      graph_id: fixture.graphId,
      command,
      node_id: "work",
      reason: options.reason ?? (command === "approve" ? "reviewed and accepted" : "not acceptable"),
    },
    options.sessionID ?? APPROVER,
    "agent.approver",
    options.now ?? AT,
  );
}

// ── The lifecycle ───────────────────────────────────────────────────────────

describe("graph_control — the approval request and its decision", () => {
  it("pauses the attempt on a durable request and opens the gate only on approval", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      const raised = raise(fixture);
      expect(raised.kind).toBe("applied");
      expect(raised.command).toBe("approval-request");
      expect(raised.scope).toBe("attempt");
      // THE RUN IS NOT STOPPED: an approval pause is not a control stop.
      expect(raised.runControl).toBeUndefined();
      expect(raised.approval?.request.status).toBe("pending");
      expect(raised.approval?.request.approverSessionId).toBe(APPROVER);
      expect(raised.approval?.request.expiresAt).toBe(DEADLINE);
      expect(raised.approval?.replayed).toBe(false);
      expect(raised.decided?.[0]).toMatchObject({
        nodeId: "work",
        attemptId: "work#1",
        replayed: false,
      });
      expect(raised.decided?.[0]?.decision.command).toBe("approval-request");

      // DURABLE, read with a fresh connection: the pause is the ROW.
      const paused = readFacts(fixture);
      expect(requestOf(paused).status).toBe("pending");
      expect(requestOf(paused).attemptId).toBe("work#1");
      expect(requestOf(paused).approverSessionId).toBe(APPROVER);
      expect(requestOf(paused).requestedBy?.sessionId).toBe(DECLARER);
      expect(paused.control).toBeUndefined();
      expect(paused.phase).toBe("executing");
      expect(paused.nodeStatus).toBe("dispatched");

      // THE WORKER'S SUBMISSION IS HELD — AND ITS PAYLOAD IS NOT CONSULTED.
      // This submission carries BOTH shapes the original defect class used: a
      // top-level claim inside the payload and an explicit "approved" field.
      const held = await submit(fixture, "work", "done", {
        data: { approved: true, decision: "approved", status: "approved" },
      });
      expect(held.decision).toBeUndefined();
      expect(held.refusals?.[0]?.code).toBe("approval-pending");
      expect(held.refusals?.[0]?.message).toContain(APPROVER);

      // NOTHING WAS WRITTEN BY THE HELD SUBMISSION, and the request is untouched.
      const stillPaused = readFacts(fixture);
      expect(stillPaused.receipts).toBe(0);
      expect(stillPaused.events).toEqual([]);
      expect(stillPaused.nodeStatus).toBe("dispatched");
      expect(requestOf(stillPaused).status).toBe("pending");

      // THE DECLARING PRINCIPAL MAY NOT DECIDE A REQUEST IT NAMED SOMEONE ELSE FOR.
      const refused = decide(fixture, "approve", { sessionID: DECLARER });
      expect(refused.kind).toBe("refused");
      expect(refused.refusals?.[0]?.code).toBe("approval-not-authorized");
      expect(readFacts(fixture).decisions.some((d) => d.command === "approve")).toBe(false);
      expect(requestOf(readFacts(fixture)).status).toBe("pending");

      // THE NAMED APPROVER DECIDES, AND ONLY THEN DOES THE ATTEMPT SETTLE.
      const approved = decide(fixture, "approve");
      expect(approved.kind).toBe("applied");
      expect(approved.approval?.request.status).toBe("approved");
      expect(approved.approval?.request.decidedBy?.sessionId).toBe(APPROVER);
      expect(approved.approval?.request.decidedAt).toBe(AT);
      expect(approved.approval?.request.decisionReason).toBe("reviewed and accepted");
      // APPROVAL IS NOT AN OUTCOME: the decision itself wrote no business success.
      expect(readFacts(fixture).events).toEqual([]);
      expect(readFacts(fixture).receipts).toBe(0);

      const settled = await submit(fixture, "work", "done");
      expect(settled.decision).toBe("accepted");
      const after = readFacts(fixture);
      expect(after.receipts).toBe(1);
      expect(after.events).toHaveLength(1);
      expect(after.nodeStatus).toBe("settled");
    } finally {
      fixture.host.close();
    }
  });

  it("replays a repeated decision and refuses the competing one, naming what stands", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);
      const first = decide(fixture, "approve");
      expect(first.kind).toBe("applied");
      const decidedAt = first.approval?.request.decidedAt;

      // A REPEATED APPROVAL IS A NO-OP ON AN ALREADY-DECIDED REQUEST.
      const repeated = decide(fixture, "approve", { reason: "same answer again" });
      expect(repeated.kind).toBe("applied");
      expect(repeated.approval?.replayed).toBe(true);
      expect(repeated.approval?.request.status).toBe("approved");
      expect(repeated.approval?.request.decidedAt).toBe(decidedAt);
      expect(repeated.approval?.request.decisionReason).toBe("reviewed and accepted");
      expect(repeated.decided?.[0]?.replayed).toBe(true);
      expect(readFacts(fixture).decisions.filter((d) => d.command === "approve")).toHaveLength(1);

      // THE OPPOSITE DECISION IS REFUSED, AND THE FACT THAT STANDS IS REPORTED.
      const contradicted = decide(fixture, "reject");
      expect(contradicted.kind).toBe("refused");
      expect(contradicted.refusals?.[0]?.code).toBe("approval-already-decided");
      expect(contradicted.refusals?.[0]?.message).toContain("approved");
      expect(contradicted.refusals?.[0]?.message).toContain(APPROVER);
      const facts = readFacts(fixture);
      expect(requestOf(facts).status).toBe("approved");
      expect(requestOf(facts).decidedAt).toBe(decidedAt);
      expect(facts.decisions.filter((d) => d.command === "reject")).toHaveLength(0);
    } finally {
      fixture.host.close();
    }
  });

  it("makes a rejection terminal: the attempt can never settle", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);
      const rejected = decide(fixture, "reject");
      expect(rejected.kind).toBe("applied");
      expect(rejected.approval?.request.status).toBe("rejected");

      const held = await submit(fixture, "work", "done", { data: { approved: true } });
      expect(held.refusals?.[0]?.code).toBe("approval-rejected");
      const facts = readFacts(fixture);
      expect(facts.receipts).toBe(0);
      expect(facts.events).toEqual([]);
      expect(facts.nodeStatus).toBe("dispatched");

      // A LATER APPROVAL CANNOT REWRITE THE REJECTION.
      const late = decide(fixture, "approve");
      expect(late.kind).toBe("refused");
      expect(late.refusals?.[0]?.code).toBe("approval-already-decided");
      expect(requestOf(readFacts(fixture)).status).toBe("rejected");
    } finally {
      fixture.host.close();
    }
  });
});

// ── Expiry ──────────────────────────────────────────────────────────────────

describe("graph_control — expiry is a durable, deterministic outcome", () => {
  it("materializes the deadline when a decision arrives too late, and never approves after", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);
      // THE DRIVER IS THE CALLER'S OWN at, NOT A CLOCK: the decision is stamped at
      // the deadline, so the outcome is arithmetic on two constants the test owns.
      const late = decide(fixture, "approve", { now: DEADLINE });
      expect(late.kind).toBe("refused");
      expect(late.refusals?.[0]?.code).toBe("approval-expired");
      expect(late.refusals?.[0]?.message).toContain(String(DEADLINE));

      // THE EXPIRY IS RECORDED DURABLY BY THAT REFUSED CALL.
      const facts = readFacts(fixture);
      expect(requestOf(facts).status).toBe("expired");
      expect(requestOf(facts).decidedAt).toBe(DEADLINE);
      expect(requestOf(facts).decisionReason).toContain("approval deadline");
      expect(requestOf(facts).decidedBy).toBeUndefined();

      // AN EXPIRED REQUEST IS NEVER APPROVED AFTERWARDS.
      const later = decide(fixture, "approve", { now: DEADLINE + 1000 });
      expect(later.kind).toBe("refused");
      expect(later.refusals?.[0]?.code).toBe("approval-already-decided");
      expect(later.refusals?.[0]?.message).toContain("expired");
      expect(requestOf(readFacts(fixture)).status).toBe("expired");

      // AND THE ATTEMPT CANNOT SETTLE THROUGH THE EXPIRED PAUSE.
      const held = await submit(fixture, "work", "done");
      expect(held.refusals?.[0]?.code).toBe("approval-expired");
      expect(readFacts(fixture).receipts).toBe(0);
    } finally {
      fixture.host.close();
    }
  });

  it("sweeps a due request on ANY authorized control command and reports the transition", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      // The sweep is graph-wide, so a request on alpha is due for a command about
      // beta. The SECOND raise is stamped past alpha's deadline.
      const alpha = control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "approval-request",
          node_id: "alpha",
          reason: "hold alpha",
          approver_session_id: APPROVER,
          expires_at: DEADLINE,
        },
        DECLARER,
        "agent.declarer",
        AT,
      );
      expect(alpha.approval?.request.status).toBe("pending");

      const beta = control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "approval-request",
          node_id: "beta",
          reason: "hold beta",
          approver_session_id: APPROVER,
          expires_at: DEADLINE + 60_000,
        },
        DECLARER,
        "agent.declarer",
        DEADLINE,
      );
      expect(beta.kind).toBe("applied");
      // THE ANSWER NAMES THE ROW WHOSE STATUS CHANGED — never a silent sweep.
      // Attempt ids are minted from a GRAPH-WIDE sequence, so the ids are read
      // from the dispatch record rather than assumed per node.
      const alphaAttempt = attemptOf(fixture, "alpha");
      const betaAttempt = attemptOf(fixture, "beta");
      expect(beta.expiredApprovals?.map((entry) => entry.attemptId)).toEqual([alphaAttempt]);
      expect(beta.expiredApprovals?.[0]?.status).toBe("expired");

      const requests = readFacts(fixture).requests;
      expect(requests.find((entry) => entry.attemptId === alphaAttempt)?.status).toBe("expired");
      expect(requests.find((entry) => entry.attemptId === betaAttempt)?.status).toBe("pending");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a malformed raise: no approver, no deadline, or a deadline already past", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      const noApprover = control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "approval-request",
          node_id: "work",
          reason: "hold",
          expires_at: DEADLINE,
        },
        DECLARER,
        "agent.declarer",
      );
      expect(noApprover.refusals?.[0]?.code).toBe("approval-request-malformed");

      const noDeadline = control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "approval-request",
          node_id: "work",
          reason: "hold",
          approver_session_id: APPROVER,
        },
        DECLARER,
        "agent.declarer",
      );
      expect(noDeadline.refusals?.[0]?.code).toBe("approval-request-malformed");

      const past = raise(fixture, { expiresAt: AT });
      expect(past.refusals?.[0]?.code).toBe("approval-request-malformed");

      // NOTHING WAS WRITTEN BY ANY OF THE THREE.
      expect(readFacts(fixture).requests).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── Races ───────────────────────────────────────────────────────────────────

describe("graph_control — approval racing a cancel or a completion", () => {
  it("expires a pending request when the run is stopped FIRST, and refuses the late approval", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);
      const cancelled = controlTool(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "cancel",
          reason: "stop the run",
        },
        DECLARER,
        "agent.declarer",
      );
      const answer = await cancelled;
      expect(answer.kind).toBe("applied");
      // THE STOP EXPIRES THE RUN'S PAUSES IN ITS OWN TRANSACTION, and says so.
      expect(answer.expiredApprovals?.map((entry) => entry.attemptId)).toEqual(["work#1"]);
      expect(requestOf(readFacts(fixture)).status).toBe("expired");

      const late = decide(fixture, "approve");
      expect(late.kind).toBe("refused");
      expect(late.refusals?.[0]?.code).toBe("approval-already-decided");
      expect(late.refusals?.[0]?.message).toContain("expired");
      expect(requestOf(readFacts(fixture)).status).toBe("expired");
    } finally {
      fixture.host.close();
    }
  });

  it("leaves an approval that committed FIRST standing when the cancel follows", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);
      const approved = decide(fixture, "approve");
      expect(approved.approval?.request.status).toBe("approved");

      const answer = await controlTool(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "cancel",
          reason: "stop the run after the sign-off",
        },
        DECLARER,
        "agent.declarer",
      );
      expect(answer.kind).toBe("applied");
      // A DECIDED REQUEST IS NOT RE-LABELLED: only PENDING rows are expired.
      expect(answer.expiredApprovals).toEqual([]);
      const facts = readFacts(fixture);
      expect(requestOf(facts).status).toBe("approved");
      expect(requestOf(facts).decidedAt).toBe(AT);
      expect(facts.control?.command).toBe("cancel");

      // The run is stopped, so the attempt cannot settle even though it was approved.
      const held = await submit(fixture, "work", "done");
      expect(held.refusals?.[0]?.code).toBe("control-stopped");
      expect(readFacts(fixture).receipts).toBe(0);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses to raise a request on an attempt that already settled", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      const settled = await submit(fixture, "work", "done");
      expect(settled.decision).toBe("accepted");
      const refused = raise(fixture);
      expect(refused.kind).toBe("refused");
      expect(refused.refusals?.[0]?.code).toBe("attempt-already-settled");
      expect(readFacts(fixture).requests).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses to raise a request on a run a trusted command already stopped", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const stopped = await controlTool(
        fixture,
        { graph_id: fixture.graphId, command: "timeout", node_id: "alpha", reason: "too slow" },
        DECLARER,
        "agent.declarer",
      );
      expect(stopped.kind).toBe("applied");
      const refused = raise(fixture, { nodeId: "alpha" });
      expect(refused.kind).toBe("refused");
      expect(refused.refusals?.[0]?.code).toBe("run-stopped");
    } finally {
      fixture.host.close();
    }
  });
});

// ── Permission ──────────────────────────────────────────────────────────────

describe("graph_control — who may decide an approval", () => {
  it("refuses an unrelated session, an unattributed call and a dispatched worker by name", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);

      // A DECISION IS AUTHORIZED BY ITS REQUEST: a session that is neither the
      // declarer nor the named approver is refused by the approval rule, not by
      // the declaring-principal rule — the request's own named approver is the
      // authority, and this caller is not it.
      const stranger = decide(fixture, "approve", { sessionID: "session.stranger" });
      expect(stranger.kind).toBe("refused");
      expect(stranger.refusals?.[0]?.code).toBe("approval-not-authorized");

      const unattributed = control(
        fixture,
        { graph_id: fixture.graphId, command: "approve", node_id: "work", reason: "sign off" },
        "",
        "",
      );
      expect(unattributed.kind).toBe("refused");
      expect(unattributed.refusals?.[0]?.code).toBe("control-principal-absent");

      // A DISPATCHED WORKER IS REFUSED BEFORE THE TOOL BODY RUNS — the host's own
      // worker boundary, not this service's permission rule. The answer is the
      // boundary's own shape, so the code it names is what is asserted.
      const workerRaw = String(
        await fixture.tools.graph_control.execute(
          {
            graph_id: fixture.graphId,
            command: "approve",
            node_id: "work",
            reason: "the worker approves itself",
          },
          fixture.contextOf(childSessionOf("work#1"), "agent.work"),
        ),
      );
      const worker = JSON.parse(workerRaw) as {
        readonly refused?: boolean;
        readonly code?: string;
      };
      expect(worker.refused).toBe(true);
      expect(worker.code).toBe("worker-tool-forbidden");

      // AND THE REQUEST IS STILL PENDING AFTER ALL FOUR ATTEMPTS.
      expect(requestOf(readFacts(fixture)).status).toBe("pending");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a decision when no request exists for the attempt", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      const refused = decide(fixture, "approve");
      expect(refused.kind).toBe("refused");
      expect(refused.refusals?.[0]?.code).toBe("approval-absent");
    } finally {
      fixture.host.close();
    }
  });

  it("expires a due request at BOOT, with no control command and no wall clock", async () => {
    const fixture = await openFixture(CHAIN);
    try {
      raise(fixture);
      expect(requestOf(readFacts(fixture)).status).toBe("pending");

      // THE PROCESS "RESTARTS" LATER: the host's clock is moved past the deadline
      // and the boot sweep is the only driver. The expiry is arithmetic on the
      // request's own expiresAt, never a sleep.
      fixture.setClock(DEADLINE + 5_000);
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.expiredApprovals).toEqual([fixture.graphId + ":work:work#1"]);

      const facts = readFacts(fixture);
      expect(requestOf(facts).status).toBe("expired");
      expect(requestOf(facts).decidedAt).toBe(DEADLINE + 5_000);
      expect(requestOf(facts).decisionReason).toContain("approval deadline");

      // IDEMPOTENT: a second boot finds nothing to expire.
      const again = await fixture.host.recoverDeclaredGraphs();
      expect(again.expiredApprovals).toEqual([]);
      expect(requestOf(readFacts(fixture)).status).toBe("expired");

      // AND THE EXPIRED PAUSE STILL HOLDS THE ATTEMPT: expiry is not approval.
      const held = await submit(fixture, "work", "done", { data: { approved: true } });
      expect(held.refusals?.[0]?.code).toBe("approval-expired");
    } finally {
      fixture.host.close();
    }
  });
});

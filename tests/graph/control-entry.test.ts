/**
 * P3 item 1 — THE ONE EXPLICIT CONTROL ENTRY (`graph_control`).
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR. A trusted lifecycle command is a durable
 * fact recorded by exactly one entry; the entry has explicit command types and a
 * PERMISSION check against the graph's declaring principal; a worker's payload
 * is never authority; a repeated or racing command has a deterministic outcome;
 * and a failure never becomes a business success.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real `OutcomeHost` (file durability, the
 * workspace's one SQLite store, the shipped `declareInvocationIdentity: false`
 * + `workerSessionOf` decision), a real `createGraphToolSet`, and the
 * `graph_control` tool from `createOutcomeGraphTools` bound by the very
 * `OutcomeHost.bindTools` both entries call. Every assertion about a refusal
 * also reads the AUTHORITATIVE record back with a fresh connection.
 *
 * STRENGTH: adapter + real store, process-level, and CROSS-PROCESS for the
 * inverse race and for the failure/timeout restart (real `Bun.spawnSync` OS
 * processes with their own store connections). No real dsh/Pi SDK runs in this
 * environment, so nothing here is real-host evidence.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import {
  createValidatorRegistry,
  type ValidatorImplementation,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import {
  createGraphToolSet,
  type GraphToolSet,
} from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../src/platform/types.ts";
import {
  CONTROL_REPORT_MARKER,
  XPROC_CONTROL_GRAPH_ID,
} from "./helpers/control-xproc-worker.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** The checked-in cross-process worker every inverse-race case spawns. */
const XPROC_WORKER = fileURLToPath(
  new URL("./helpers/graph-store-xproc-worker.ts", import.meta.url),
);

/** The checked-in HOST-level worker the failure/timeout restart cases spawn. */
const CONTROL_XPROC_WORKER = fileURLToPath(
  new URL("./helpers/control-xproc-worker.ts", import.meta.url),
);

/** One child process's deadline; a worker that overruns is killed by the harness. */
const CONTROL_CHILD_DEADLINE_MS = 30_000;

/**
 * THE HARNESS BUDGET MUST EXCEED THIS FILE'S OWN CHILD DEADLINE (the same rule
 * `cancel-delivery.test.ts` and `graph-store-cross-process.test.ts` carry). Bun's
 * default is 5000ms per test, so a child that was merely SLOW — spawn latency
 * under load, a `busy_timeout` wait on the shared store file — would have the
 * CASE killed and its own diagnosis never written. The budget below lets the
 * child deadline fire first, so what this file reports is always the control
 * behavior, never a harness timeout.
 */
setDefaultTimeout(CONTROL_CHILD_DEADLINE_MS + 15_000);

/** The one fixed instant the inverse-race worker stamps its decision with. */
const RACE_AT = 1_700_000_000_000;

/** The gate the inverse-race declaration names on `work`'s accepted outcome. */
const INVERSE_RACE_GATE = "gate.inverse-race";

/** work -> review: an accepted outcome for `work` arms the `review` attempt. */
const CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "control.chain",
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

/**
 * The same chain, with `work`'s accepted outcome behind a DECLARED GATE.
 *
 * The gate is what opens the inverse-race window: acceptance gates run OUTSIDE
 * the acceptance transaction, so the test's own implementation can have a REAL
 * second process commit a trusted control command between the run path's
 * pre-transaction check and its acceptance transaction.
 */
const GATED_CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "control.inverse-race",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [
        { id: "done", acceptance: [{ validator: INVERSE_RACE_GATE, version: 1 }] },
      ],
    },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "approve" }],
    },
  ],
  edges: [{ from: "work", to: "review", outcome: "done" }],
};

/** Two ENTRY nodes: one start leaves TWO attempts in flight at once. */
const FAN_OUT: GraphDeclarationV3 = {
  version: 3,
  name: "control.fan-out",
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

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
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

interface ControlFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  /** Every dispatch the run path handed to the platform, in order. */
  readonly dispatched: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly declarerSession: string | undefined;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

/**
 * One shipped host assembly over a REAL declared graph, with the platform's
 * confirmation under the test's control (`confirm: false` leaves every create
 * row `creating` — an UNCONFIRMED external task).
 */
async function openControlFixture(
  declaration: GraphDeclarationV3,
  options: {
    readonly confirm?: boolean;
    readonly declarerSession?: string | undefined;
    /**
     * One validator capability the declaration may name as an acceptance gate.
     * The interface is INSTALLED here (both on the host and on the toolset, as
     * the shipped assembly does) and DECLARED to `graph_declare` as a supported
     * validator, so the compiled plan is executable rather than a draft.
     */
    readonly gate?: {
      readonly validator: string;
      readonly version: number;
      readonly implementation: ValidatorImplementation;
    };
  } = {},
): Promise<ControlFixture> {
  const dir = makeTmpDir("control-entry-");
  const storeRoot = join(dir, "host-store");
  // The host's vault writes under its root, so the root exists before the open.
  mkdirSync(storeRoot, { recursive: true });
  const confirm = options.confirm ?? true;
  const validators: ValidatorRegistry =
    options.gate === undefined
      ? EMPTY_VALIDATORS
      : createValidatorRegistry([
          {
            id: options.gate.validator,
            version: options.gate.version,
            implementation: options.gate.implementation,
          },
        ]);
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      if (confirm) {
        // The platform names the execution it created; the host records the fact.
        host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
      }
    },
    validators,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: validators,
    outcomeArtifactRoot: dir,
  });
  const declarerSession =
    "declarerSession" in options ? options.declarerSession : "session.declarer";
  const fixture: ControlFixture = {
    dir,
    storeRoot,
    host: opened,
    toolset,
    tools: opened.bindTools(createOutcomeGraphTools(toolset)),
    dispatched,
    graphId: declaration.name,
    declarerSession,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
  };
  const declared = String(
    await fixture.tools.graph_declare.execute(
      {
        declaration,
        // A gated declaration is only executable when the caller declares the
        // capability it names; an undeclared gate compiles to a DRAFT and
        // `graph_declare` refuses it (never a runtime surprise).
        ...(options.gate === undefined
          ? {}
          : {
              supported_validators: [
                { validator: options.gate.validator, version: options.gate.version },
              ],
            }),
      },
      fixture.contextOf(declarerSession ?? "", "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await opened.startDeclaredGraph(declaration.name, {
    ...(declarerSession === undefined ? {} : { sessionId: declarerSession }),
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return fixture;
}

/** What one control answer carries, as the tool renders it. */
interface ControlAnswer {
  readonly kind?: "applied" | "refused";
  readonly graphId?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly decided?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly replayed: boolean;
    readonly decision: {
      readonly command: string;
      readonly reason: string;
      readonly decidedAt: number;
      readonly decidedBy?: { readonly sessionId: string; readonly agentId?: string };
    };
  }[];
  readonly runControl?: {
    readonly command: string;
    readonly reason: string;
    readonly decidedAt: number;
    readonly decidedBy?: { readonly sessionId: string; readonly agentId?: string };
  };
  readonly skipped?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly code?: string;
    readonly message?: string;
  }[];
  readonly unsettledEffects?: readonly { readonly effectId: string; readonly status: string }[];
  readonly unconfirmedExecutions?: readonly {
    readonly nodeId?: string;
    readonly attemptId: string;
    readonly effectId: string;
    readonly state: string;
  }[];
  readonly refusals?: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
}

/** Read the durable control rows of one graph with a FRESH connection. */
function readControlRows(fixture: ControlFixture): {
  readonly run: { readonly runId: string } | undefined;
  readonly control: { readonly command: string; readonly reason: string } | undefined;
  readonly decisions: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly command: string;
    readonly reason: string;
  }[];
  readonly events: readonly { readonly attemptId: string; readonly outcomeId: string }[];
  readonly effects: readonly { readonly effectId: string; readonly status: string }[];
  /** The host's EXECUTION row of every unsettled effect, read back. */
  readonly executions: readonly {
    readonly effectId: string;
    readonly state: "pending" | "creating" | "created";
  }[];
  readonly receipts: number;
} {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    const effects = store.pendingEffects(fixture.graphId);
    const executions = effects
      .filter((effect) => effect.kind === "dispatch")
      .flatMap((effect) => {
        const row = store.readExecution({
          graphId: fixture.graphId,
          effectId: effect.effectId,
          attemptId: effect.attemptId,
        });
        return row === undefined
          ? []
          : [{ effectId: effect.effectId, state: row.state }];
      });
    return {
      run: store.runs.readRun(fixture.graphId),
      control: store.runs.readRunControl(fixture.graphId),
      decisions: store.runs.controlDecisions(fixture.graphId),
      events: store.acceptedEvents(fixture.graphId),
      effects,
      executions,
      receipts:
        store.all(
          "SELECT COUNT(*) AS n FROM ledger_receipts WHERE graph_id = ?",
          fixture.graphId,
        )[0]?.["n"] as number,
    };
  } finally {
    store.close();
  }
}

/** The persisted state row of one graph, read with a fresh connection. */
function readState(fixture: ControlFixture): {
  readonly phase: unknown;
  readonly nodes: readonly Record<string, unknown>[];
} {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    const record = store.readGraphState(fixture.graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const nodes = Array.isArray(body?.["nodes"])
      ? (body["nodes"] as readonly Record<string, unknown>[])
      : [];
    return { phase: body?.["phase"], nodes };
  } finally {
    store.close();
  }
}

/** The persisted entry of one node. */
function nodeEntry(
  state: { readonly nodes: readonly Record<string, unknown>[] },
  nodeId: string,
): Record<string, unknown> {
  const entry = state.nodes.find((node) => node["nodeId"] === nodeId);
  if (entry === undefined) throw new Error("fixture: no persisted entry for node " + nodeId);
  return entry;
}

/** The fixture's declaring session, or a fixture error when it records none. */
function declarerOf(fixture: ControlFixture): string {
  if (fixture.declarerSession === undefined) {
    throw new Error("fixture: this graph records no declaring session");
  }
  return fixture.declarerSession;
}

/** The credential one dispatched attempt was handed (never printed by a test). */
function credentialOf(fixture: ControlFixture, nodeId: string): string {
  const request = fixture.dispatched.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no dispatch for node " + nodeId);
  return request.credential;
}

/**
 * Settle `work` through the SHIPPED submission ingress, which arms its successor.
 *
 * The control cases that must show a PRE-EXISTING accepted event untouched use
 * this: the rollback assertions are only meaningful when there was something the
 * command could have clobbered.
 */
async function settleWork(fixture: ControlFixture): Promise<void> {
  const raw = String(
    await fixture.tools.graph_submit_outcome.execute(
      {
        graph_id: fixture.graphId,
        node_id: "work",
        outcome_id: "done",
        credential: credentialOf(fixture, "work"),
      },
      fixture.contextOf(childSessionOf("work#1"), "agent.work"),
    ),
  );
  const answer = JSON.parse(raw) as { readonly decision?: string };
  if (answer.decision !== "accepted") {
    throw new Error("fixture: work did not settle (" + answer.decision + ")");
  }
}

/** The decision one attempt carries, or a fixture error. */
function decisionFor(
  rows: ReturnType<typeof readControlRows>,
  attemptId: string,
): ReturnType<typeof readControlRows>["decisions"][number] {
  const decision = rows.decisions.find((entry) => entry.attemptId === attemptId);
  if (decision === undefined) throw new Error("fixture: no control decision for " + attemptId);
  return decision;
}

// ── The commands ────────────────────────────────────────────────────────────

describe("graph_control — the trusted commands", () => {
  it("records a failure on the ATTEMPT and the RUN and writes no business success event", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const answer = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "failure",
          node_id: "work",
          reason: "the worker process died",
        },
        declarerOf(fixture),
      );

      expect(answer.kind).toBe("applied");
      expect(answer.command).toBe("failure");
      // The run identity is the run path's own — minted with the first snapshot —
      // and the decision is recorded against THAT run.
      expect(answer.runId?.startsWith(fixture.graphId + "@")).toBe(true);
      expect(answer.runControl?.command).toBe("failure");
      expect(answer.runControl?.reason).toBe("the worker process died");
      expect(answer.runControl?.decidedBy?.sessionId).toBe(declarerOf(fixture));
      expect(answer.runControl?.decidedBy?.agentId).toBe("agent.declarer");
      expect(answer.decided).toHaveLength(1);
      expect(answer.decided?.[0]).toMatchObject({ nodeId: "work", attemptId: "work#1", replayed: false });
      expect(answer.decided?.[0]?.decision.command).toBe("failure");
      // The execution the host DID confirm is not "unconfirmed"; the effect is
      // still unsettled and therefore reported.
      expect(answer.unconfirmedExecutions).toEqual([]);
      expect(answer.unsettledEffects?.map((effect) => effect.status)).toEqual(["started"]);

      const rows = readControlRows(fixture);
      expect(rows.run?.runId).toBe(answer.runId);
      expect(rows.control?.command).toBe("failure");
      expect(rows.control?.reason).toBe("the worker process died");
      expect(decisionFor(rows, "work#1").reason).toBe("the worker process died");

      // NO BUSINESS SUCCESS: no accepted event, no receipt, and the attempt
      // entry is exactly what the dispatch wrote.
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      const state = readState(fixture);
      expect(nodeEntry(state, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#1",
      });
      expect(nodeEntry(state, "review")).toMatchObject({ status: "pending" });
    } finally {
      fixture.host.close();
    }
  });

  it("records a timeout the same way, keeping its own reason", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const answer = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "timeout",
          node_id: "work",
          attempt_id: "work#1",
          reason: "the execution exceeded its declared time",
        },
        declarerOf(fixture),
      );
      expect(answer.kind).toBe("applied");
      expect(answer.runControl?.command).toBe("timeout");
      expect(answer.runControl?.reason).toBe("the execution exceeded its declared time");
      const rows = readControlRows(fixture);
      expect(rows.control?.command).toBe("timeout");
      expect(decisionFor(rows, "work#1").command).toBe("timeout");
      expect(rows.events).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("cancels a run and names every attempt still in flight", async () => {
    const fixture = await openControlFixture(FAN_OUT);
    try {
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "the operator stopped it" },
        declarerOf(fixture),
      );
      expect(answer.kind).toBe("applied");
      expect(answer.runControl?.command).toBe("cancel");
      expect(answer.skipped).toEqual([]);
      expect(answer.decided?.map((decision) => decision.attemptId).sort()).toEqual([
        "alpha#1",
        "beta#2",
      ]);

      const rows = readControlRows(fixture);
      expect(rows.control?.command).toBe("cancel");
      expect(rows.decisions.map((decision) => decision.command)).toEqual(["cancel", "cancel"]);
      // The effects stay exactly where the stop found them.
      expect(rows.effects).toHaveLength(2);
      expect(rows.events).toEqual([]);
      expect(readState(fixture).phase).toBe("executing");
    } finally {
      fixture.host.close();
    }
  });

  it("requires a node for a node-scoped command and refuses one for a run-wide command", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const missing = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", reason: "no node named" },
        declarerOf(fixture),
      );
      expect(missing.kind).toBe("refused");
      expect(missing.refusals?.[0]?.code).toBe("unknown-node");

      const extra = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", node_id: "work", reason: "still names one" },
        declarerOf(fixture),
      );
      expect(extra.kind).toBe("refused");
      expect(extra.refusals?.[0]?.code).toBe("unknown-node");

      // Nothing was recorded by either refusal.
      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
    } finally {
      fixture.host.close();
    }
  });
});

// ── Permission ──────────────────────────────────────────────────────────────

describe("graph_control — the permission check", () => {
  it("refuses a caller that is not the declaring principal, writing nothing", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "not mine to stop" },
        "session.intruder",
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("control-not-authorized");
      expect(answer.refusals?.[0]?.message).toContain("session.declarer");

      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(readState(fixture).phase).toBe("executing");
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a call that carries no platform attribution", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      // The tool wrapper forwards `context?.sessionID`; a platform that
      // attributes no session hands the entry `undefined`, which is what this
      // call presents — the SAME path, without inventing a context shape the
      // canonical type cannot express.
      const answer = fixture.toolset.graph_control(
        { graph_id: fixture.graphId, command: "cancel", reason: "no principal" },
        undefined,
        "agent.declarer",
      );
      expect(answer.kind).toBe("refused");
      if (answer.kind !== "refused") throw new Error("fixture: expected a refusal");
      expect(answer.refusals[0]?.code).toBe("control-principal-absent");
      expect(readControlRows(fixture).decisions).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a graph whose declaring invocation was never recorded", async () => {
    const fixture = await openControlFixture(CHAIN, { declarerSession: undefined });
    try {
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "who declared this?" },
        "session.anyone",
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("control-declarant-unknown");
      expect(readControlRows(fixture).decisions).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses every command when the process resolves no store to record it in", () => {
    const toolset = createGraphToolSet({});
    const answer = toolset.graph_control(
      { graph_id: "control.absent-store", command: "cancel", reason: "no store here" },
      "session.declarer",
    );
    expect(answer.kind).toBe("refused");
    if (answer.kind !== "refused") throw new Error("fixture: expected a refusal");
    expect(answer.refusals[0]?.code).toBe("store-unavailable");
  });
});

// ── Explicit command types ──────────────────────────────────────────────────

describe("graph_control — explicit command types only", () => {
  it("refuses retry and budget-stop by name instead of recording an intent", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      for (const command of ["retry", "budget-stop"] as const) {
        const answer = await control(
          fixture,
          { graph_id: fixture.graphId, command, node_id: "work", reason: "not implemented yet" },
          declarerOf(fixture),
        );
        expect(answer.kind).toBe("refused");
        expect(answer.refusals?.[0]?.code).toBe("command-unimplemented");
      }
      expect(readControlRows(fixture).decisions).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a graph the workspace's store does not hold", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const answer = await control(
        fixture,
        { graph_id: "control.never-declared", command: "cancel", reason: "unknown graph" },
        declarerOf(fixture),
      );
      expect(answer.kind).toBe("refused");
      expect(answer.refusals?.[0]?.code).toBe("graph-unknown");
    } finally {
      fixture.host.close();
    }
  });
});

// ── Idempotency and races ───────────────────────────────────────────────────

describe("graph_control — idempotency and races", () => {
  it("replays a repeated command and answers with the PERSISTED decision", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const first = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "work", reason: "first reason" },
        declarerOf(fixture),
      );
      expect(first.kind).toBe("applied");
      expect(first.decided?.[0]?.replayed).toBe(false);

      const second = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "work", reason: "a LATER reason" },
        declarerOf(fixture),
      );
      expect(second.kind).toBe("applied");
      expect(second.decided?.[0]?.replayed).toBe(true);
      // The PERSISTED decision governs: the replay does not rewrite the reason.
      expect(second.decided?.[0]?.decision.reason).toBe("first reason");
      expect(second.runControl?.reason).toBe("first reason");

      const rows = readControlRows(fixture);
      expect(rows.decisions).toHaveLength(1);
      expect(rows.decisions[0]?.reason).toBe("first reason");
      expect(rows.control?.reason).toBe("first reason");
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a DIFFERENT command for the same attempt and keeps the first fact", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "work", reason: "it failed" },
        declarerOf(fixture),
      );
      const competing = await control(
        fixture,
        { graph_id: fixture.graphId, command: "timeout", node_id: "work", reason: "and it timed out" },
        declarerOf(fixture),
      );
      expect(competing.kind).toBe("refused");
      expect(competing.refusals?.[0]?.code).toBe("control-already-decided");
      expect(competing.refusals?.[0]?.message).toContain("failure");

      const rows = readControlRows(fixture);
      expect(rows.decisions).toHaveLength(1);
      expect(rows.decisions[0]?.command).toBe("failure");
      expect(rows.control?.command).toBe("failure");
    } finally {
      fixture.host.close();
    }
  });

  it("lets the FIRST command stop the run and still records a later sibling's fact", async () => {
    const fixture = await openControlFixture(FAN_OUT);
    try {
      const first = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "alpha", reason: "alpha failed first" },
        declarerOf(fixture),
      );
      expect(first.kind).toBe("applied");
      expect(first.runControl?.reason).toBe("alpha failed first");

      const second = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "beta", reason: "beta failed later" },
        declarerOf(fixture),
      );
      expect(second.kind).toBe("applied");
      // The sibling's fact is recorded...
      expect(second.decided?.[0]?.attemptId).toBe("beta#2");
      expect(second.decided?.[0]?.decision.reason).toBe("beta failed later");
      // ...but the RUN keeps the command that stopped it FIRST.
      expect(second.runControl?.reason).toBe("alpha failed first");

      const rows = readControlRows(fixture);
      expect(rows.decisions).toHaveLength(2);
      expect(rows.control?.reason).toBe("alpha failed first");
    } finally {
      fixture.host.close();
    }
  });

  it("cancels the OTHER in-flight attempts after a failure, without re-labelling the failed one", async () => {
    for (const command of ["failure", "timeout"] as const) {
      // The failure stops the run but leaves its attempt DISPATCHED (by design),
      // and both creates are unconfirmed: the run still owes two external tasks.
      const fixture = await openControlFixture(FAN_OUT, { confirm: false });
      try {
        const stopped = await control(
          fixture,
          {
            graph_id: fixture.graphId,
            command,
            node_id: "alpha",
            reason: "alpha's execution ended first",
          },
          declarerOf(fixture),
        );
        expect(stopped.kind).toBe("applied");
        expect(stopped.decided?.map((entry) => entry.attemptId)).toEqual(["alpha#1"]);
        // Both unconfirmed external tasks are named by the stop itself.
        expect(
          stopped.unconfirmedExecutions?.map((entry) => entry.attemptId).sort(),
        ).toEqual(["alpha#1", "beta#2"]);

        const cancelled = await control(
          fixture,
          { graph_id: fixture.graphId, command: "cancel", reason: "stop the rest" },
          declarerOf(fixture),
        );
        // A LATER RUN-WIDE CANCEL IS NOT BLOCKED BY THE FAILED ATTEMPT. It
        // records its intent on every attempt that carries no fact yet, and the
        // attempt that already has one is a SKIPPED target — never re-labelled,
        // never a refusal of the whole command.
        expect(cancelled.kind).toBe("applied");
        expect(cancelled.command).toBe("cancel");
        expect(cancelled.decided?.map((entry) => entry.attemptId)).toEqual(["beta#2"]);
        expect(cancelled.decided?.[0]?.decision.command).toBe("cancel");
        expect(cancelled.skipped).toHaveLength(1);
        expect(cancelled.skipped?.[0]).toMatchObject({
          nodeId: "alpha",
          attemptId: "alpha#1",
          code: "control-already-decided",
        });
        // The run keeps the FIRST stop — the command that actually stopped it.
        expect(cancelled.runControl?.command).toBe(command);
        expect(cancelled.runControl?.reason).toBe("alpha's execution ended first");
        // The external tasks of BOTH attempts are still visible after the cancel.
        expect(
          cancelled.unconfirmedExecutions?.map((entry) => entry.attemptId).sort(),
        ).toEqual(["alpha#1", "beta#2"]);

        const rows = readControlRows(fixture);
        expect(rows.control?.command).toBe(command);
        expect(
          rows.decisions.map((entry) => entry.attemptId + ":" + entry.command).sort(),
        ).toEqual(["alpha#1:" + command, "beta#2:cancel"]);
        // NO BUSINESS SUCCESS: control is not an outcome, so the failure and the
        // cancel together wrote no accepted event and no receipt.
        expect(rows.events).toEqual([]);
        expect(rows.receipts).toBe(0);
        expect(nodeEntry(readState(fixture), "alpha")).toMatchObject({
          status: "dispatched",
          attemptId: "alpha#1",
        });
        expect(nodeEntry(readState(fixture), "beta")).toMatchObject({
          status: "dispatched",
          attemptId: "beta#2",
        });
      } finally {
        fixture.host.close();
      }
    }
  });

  it("is refused once the attempt settled through the acceptance core", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const submitted = JSON.parse(
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
      ) as { readonly decision?: string };
      expect(submitted.decision).toBe("accepted");

      const late = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "work", reason: "too late" },
        declarerOf(fixture),
      );
      expect(late.kind).toBe("refused");
      expect(late.refusals?.[0]?.code).toBe("attempt-already-settled");

      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(rows.events.map((event) => event.outcomeId)).toEqual(["done"]);
    } finally {
      fixture.host.close();
    }
  });

  it("stops a submission that arrives after the failure and never arms the successor", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const failed = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "work", reason: "the worker died" },
        declarerOf(fixture),
      );
      expect(failed.kind).toBe("applied");
      const dispatchesBefore = fixture.dispatched.length;

      const raw = String(
        await fixture.tools.graph_submit_outcome.execute(
          {
            graph_id: fixture.graphId,
            node_id: "work",
            outcome_id: "done",
            credential: credentialOf(fixture, "work"),
          },
          fixture.contextOf(childSessionOf("work#1"), "agent.work"),
        ),
      );
      const refused = JSON.parse(raw) as {
        readonly refusals?: readonly { readonly code: string }[];
      };
      expect(refused.refusals?.[0]?.code).toBe("control-stopped");

      const rows = readControlRows(fixture);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      expect(fixture.dispatched).toHaveLength(dispatchesBefore);
      expect(nodeEntry(readState(fixture), "review")).toMatchObject({ status: "pending" });
    } finally {
      fixture.host.close();
    }
  });

  it("refuses an attempt that is not the node's current one, and one with no attempt at all", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      const stale = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "failure",
          node_id: "work",
          attempt_id: "work#9",
          reason: "not the current attempt",
        },
        declarerOf(fixture),
      );
      expect(stale.kind).toBe("refused");
      expect(stale.refusals?.[0]?.code).toBe("attempt-not-current");

      const pending = await control(
        fixture,
        { graph_id: fixture.graphId, command: "failure", node_id: "review", reason: "not started" },
        declarerOf(fixture),
      );
      expect(pending.kind).toBe("refused");
      expect(pending.refusals?.[0]?.code).toBe("attempt-absent");

      expect(readControlRows(fixture).decisions).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The command's own transaction (plan §5 P3 acceptance row 5) ─────────────

/**
 * Run one control command with a TEMP TRIGGER on the store's OWN shared
 * connection, so the write fails AT THE SQL STATEMENT below the application.
 *
 * The store shares one connection per file in this process, so the trigger the
 * case creates is the one the tool's transaction runs against. The trigger is
 * dropped before the tables are read back, and the return value is whatever the
 * command threw — the transaction rolls back on a throw, which is exactly what
 * the assertions below check.
 */
function withInjectedControlWrite(
  fixture: ControlFixture,
  trigger: string,
  run: () => unknown,
): unknown {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    store.run("CREATE TEMP TRIGGER p3_control_inject " + trigger);
    try {
      run();
      return undefined;
    } catch (thrown) {
      return thrown;
    } finally {
      store.run("DROP TRIGGER p3_control_inject");
    }
  } finally {
    store.close();
  }
}

describe("graph_control — a command commits whole or not at all", () => {
  it("rolls a failure back whole when the decision INSERT fails, leaving the accepted predecessor untouched", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      await settleWork(fixture);
      const before = readControlRows(fixture);
      expect(before.events.map((event) => event.outcomeId)).toEqual(["done"]);
      expect(before.receipts).toBe(1);

      const error = withInjectedControlWrite(
        fixture,
        "BEFORE INSERT ON " +
          GRAPH_STORE_TABLES.controlDecisions +
          " BEGIN SELECT RAISE(ABORT, 'p3-injected-control-failure'); END",
        () =>
          fixture.toolset.graph_control(
            {
              graph_id: fixture.graphId,
              command: "failure",
              node_id: "review",
              reason: "injected at the decision INSERT",
            },
            declarerOf(fixture),
            "agent.declarer",
          ),
      );

      // THE THROW IS THE CONTRACT: the store's own failure reaches the caller
      // instead of being dressed up as a refusal.
      expect(error).toBeInstanceOf(Error);
      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      // UNTOUCHED: the accepted event, the receipt and the effects are exactly
      // what the acceptance and the dispatch committed before the command.
      expect(rows.events.map((event) => event.outcomeId)).toEqual(["done"]);
      expect(rows.receipts).toBe(1);
      expect(rows.effects).toEqual(before.effects);
    } finally {
      fixture.host.close();
    }
  });

  it("rolls a failure back whole when the RUN control UPDATE fails", async () => {
    const fixture = await openControlFixture(CHAIN);
    try {
      await settleWork(fixture);
      const before = readControlRows(fixture);

      const error = withInjectedControlWrite(
        fixture,
        "BEFORE UPDATE OF control_command ON " +
          GRAPH_STORE_TABLES.runs +
          " BEGIN SELECT RAISE(ABORT, 'p3-injected-control-failure'); END",
        () =>
          fixture.toolset.graph_control(
            {
              graph_id: fixture.graphId,
              command: "failure",
              node_id: "review",
              reason: "injected at the run control UPDATE",
            },
            declarerOf(fixture),
            "agent.declarer",
          ),
      );

      expect(error).toBeInstanceOf(Error);
      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(rows.events.map((event) => event.outcomeId)).toEqual(["done"]);
      expect(rows.receipts).toBe(1);
      expect(rows.effects).toEqual(before.effects);
    } finally {
      fixture.host.close();
    }
  });

  it("rolls a PARTIAL cancel back whole: the second decision's failure undoes the first", async () => {
    const fixture = await openControlFixture(FAN_OUT);
    try {
      const before = readControlRows(fixture);
      const error = withInjectedControlWrite(
        fixture,
        "BEFORE INSERT ON " +
          GRAPH_STORE_TABLES.controlDecisions +
          " WHEN NEW.attempt_id = 'beta#2' " +
          "BEGIN SELECT RAISE(ABORT, 'p3-injected-control-failure'); END",
        () =>
          fixture.toolset.graph_control(
            {
              graph_id: fixture.graphId,
              command: "cancel",
              reason: "injected on the second target",
            },
            declarerOf(fixture),
            "agent.declarer",
          ),
      );

      // ALPHA'S DECISION HAD LANDED when beta's INSERT failed; the rollback took
      // it with it, so a partially applied cancel is unrepresentable.
      expect(error).toBeInstanceOf(Error);
      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      expect(rows.effects).toEqual(before.effects);
    } finally {
      fixture.host.close();
    }
  });

  it("rolls a RUN-WIDE cancel back whole when the RUN control UPDATE fails", async () => {
    const fixture = await openControlFixture(FAN_OUT);
    try {
      const error = withInjectedControlWrite(
        fixture,
        "BEFORE UPDATE OF control_command ON " +
          GRAPH_STORE_TABLES.runs +
          " BEGIN SELECT RAISE(ABORT, 'p3-injected-control-failure'); END",
        () =>
          fixture.toolset.graph_control(
            {
              graph_id: fixture.graphId,
              command: "cancel",
              reason: "injected at the run control UPDATE",
            },
            declarerOf(fixture),
            "agent.declarer",
          ),
      );

      expect(error).toBeInstanceOf(Error);
      const rows = readControlRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(rows.events).toEqual([]);
      expect(rows.effects.map((effect) => effect.status)).toEqual(["started", "started"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The inverse race: a command that commits while a gate is running ────────

/** What the inverse-race worker (a REAL second OS process) reported. */
interface InverseRaceReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly verdict?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly attemptId?: string;
  readonly error?: string;
}

/**
 * Apply ONE control command through a REAL second OS process, SYNCHRONOUSLY.
 *
 * WHY SYNCHRONOUS. The acceptance gate runs outside the acceptance
 * transaction, so the only place a test can commit a command INSIDE that
 * window is a validator — and validation is synchronous by contract.
 * Bun.spawnSync starts a second bun process that opens the SAME store with
 * its OWN connection and commits the command before this submission's
 * transaction opens: exactly the interleaving the run path's pre-transaction
 * check cannot see.
 *
 * The command is applied through the STORE, not through the graph_control
 * tool: the child holds no host and no platform context, and this case is
 * about the RACE, not the permission check (that boundary has its own cases
 * above). The run identity is still the run path's own — the worker adopts
 * the id the store already holds.
 */
function applyControlFromAnotherProcess(options: {
  readonly storeRoot: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly reason: string;
}): InverseRaceReport {
  const result = Bun.spawnSync(
    [
      process.execPath,
      XPROC_WORKER,
      "--mode",
      "apply-control",
      "--root",
      options.storeRoot,
      "--graph",
      options.graphId,
      "--node",
      options.nodeId,
      "--attempt",
      options.attemptId,
      "--command",
      "failure",
      "--reason",
      options.reason,
      "--at",
      String(RACE_AT),
      "--session",
      "session.declarer",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "fixture: the inverse-race worker printed no JSON result (exit " +
        String(result.exitCode) +
        ", stderr: " +
        stderr.trim() +
        ")",
    );
  }
  return JSON.parse(line) as InverseRaceReport;
}

describe("graph_control — a trusted command that commits while a submission's gate runs", () => {
  it("refuses the in-flight submission with control-stopped, writes no success and arms no successor", async () => {
    // The gate needs the fixture's store root, and the fixture needs the gate to
    // build its host: the holder is filled as soon as the fixture exists, and the
    // implementation runs only when a submission is validated.
    const race: { fixture?: ControlFixture; child?: InverseRaceReport } = {};
    const fixture = await openControlFixture(GATED_CHAIN, {
      gate: {
        validator: INVERSE_RACE_GATE,
        version: 1,
        implementation: (request) => {
          const opened = race.fixture;
          if (opened === undefined) {
            throw new Error("fixture: the inverse-race fixture was not bound before the gate ran");
          }
          const child = applyControlFromAnotherProcess({
            storeRoot: opened.storeRoot,
            graphId: request.identity.graphId,
            nodeId: "work",
            attemptId: request.identity.attemptId,
            reason: "the worker process died while the gate was running",
          });
          race.child = child;
          if (child.verdict !== "recorded") {
            throw new Error(
              "fixture: the second process did not record the command: " + JSON.stringify(child),
            );
          }
          return { kind: "pass" };
        },
      },
    });
    race.fixture = fixture;
    try {
      const dispatchesBefore = fixture.dispatched.length;
      const raw = String(
        await fixture.tools.graph_submit_outcome.execute(
          {
            graph_id: fixture.graphId,
            node_id: "work",
            outcome_id: "done",
            credential: credentialOf(fixture, "work"),
          },
          fixture.contextOf(childSessionOf("work#1"), "agent.work"),
        ),
      );
      const refused = JSON.parse(raw) as {
        readonly refusals?: readonly { readonly code: string; readonly message: string }[];
      };
      // THE INVERSE RACE. The control fact committed while the gate ran — AFTER
      // the run path's pre-transaction check and BEFORE its acceptance
      // transaction — and the answer is the SAME named refusal a command that
      // commits before the gate produces. Without the in-transaction re-read,
      // this submission would commit a business success on a stopped run.
      expect(refused.refusals?.[0]?.code).toBe("control-stopped");
      expect(refused.refusals?.[0]?.message).toContain("failure");
      expect(race.child?.verdict).toBe("recorded");
      expect(race.child?.command).toBe("failure");

      const rows = readControlRows(fixture);
      // NO BUSINESS SUCCESS: no accepted event, no receipt, and the control fact
      // is the durable record of why.
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      expect(rows.control?.command).toBe("failure");
      expect(rows.control?.reason).toBe("the worker process died while the gate was running");
      expect(rows.decisions.map((entry) => entry.attemptId)).toEqual(["work#1"]);
      // The second process recorded the decision against THE RUN the run path
      // minted: it adopted the stored identity instead of minting a second one.
      expect(race.child?.runId).toBe(rows.run?.runId);
      expect(rows.run?.runId).not.toBe("");

      // THE ATTEMPT IS UNTOUCHED and THE PENDING SUCCESSOR IS NOT MIS-STARTED:
      // the rollback left the state exactly as the dispatch wrote it.
      const state = readState(fixture);
      expect(nodeEntry(state, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#1",
      });
      expect(nodeEntry(state, "review")).toMatchObject({ status: "pending" });
      expect(fixture.dispatched).toHaveLength(dispatchesBefore);

      // THE ROLLBACK LEFT NO TRACE OF THE SUCCESSOR. The join runs the reducer —
      // which mints the successor attempt's credential record inside the SAME
      // transaction — before the batch is written, so a rule that merely declined
      // to write the batch would still commit that minted record. The refusal
      // THROWS instead, so the only credential record the store holds is the one
      // the START transaction wrote for the attempt already in flight.
      const credentials = GraphStore.openFile(fixture.storeRoot);
      try {
        expect(
          credentials
            .all(
              "SELECT attempt_id FROM host_attempt_credentials WHERE graph_id = ? ORDER BY attempt_id",
              fixture.graphId,
            )
            .map((row) => row["attempt_id"]),
        ).toEqual(["work#1"]);
      } finally {
        credentials.close();
      }
    } finally {
      fixture.host.close();
    }
  });
});

// ── Unconfirmed external work ───────────────────────────────────────────────



describe("graph_control — an unconfirmed external task stays visible", () => {
  it("reports the execution the host never confirmed, across a boot sweep too", async () => {
    const fixture = await openControlFixture(CHAIN, { confirm: false });
    try {
      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it now" },
        declarerOf(fixture),
      );
      expect(answer.kind).toBe("applied");
      // The create was handed to the platform and NEVER confirmed, so an
      // external task may exist: it is named, with the state that says so.
      expect(answer.unconfirmedExecutions).toHaveLength(1);
      expect(answer.unconfirmedExecutions?.[0]).toMatchObject({
        nodeId: "work",
        attemptId: "work#1",
        state: "creating",
      });
      expect(answer.unsettledEffects).toHaveLength(1);

      const dispatchesBefore = fixture.dispatched.length;
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.unconfirmedExecutions).toHaveLength(1);
      expect(report.unconfirmedExecutions[0]).toMatchObject({
        graphId: fixture.graphId,
        nodeId: "work",
        attemptId: "work#1",
        state: "creating",
      });
      expect(fixture.dispatched).toHaveLength(dispatchesBefore);
      expect(report.effectRefusals.map((refusal) => refusal.code)).toContain("control-stopped");

      // And the durable rows are exactly as the stop left them: the EFFECT says
      // the create was handed over, and the host's EXECUTION row says it was
      // never confirmed — the fact the answer reports.
      const rows = readControlRows(fixture);
      expect(rows.control?.command).toBe("cancel");
      expect(rows.effects.map((effect) => effect.status)).toEqual(["started"]);
      expect(rows.executions.map((row) => row.state)).toEqual(["creating"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The failure/timeout restart across a REAL process boundary ──────────────

/** What the real child process reported after applying one control command. */
interface ControlRestartReport {
  readonly pid: number;
  readonly graphId: string;
  readonly command: string;
  readonly answer: {
    readonly kind?: string;
    readonly runControl?: { readonly command?: string };
  };
  readonly effects: readonly string[];
  readonly executions: readonly string[];
  readonly events: number;
  readonly receipts: number;
}

/**
 * Apply ONE control command through a REAL second OS process, SYNCHRONOUSLY.
 *
 * The child (tests/graph/helpers/control-xproc-worker.ts) declares and starts
 * the graph through the SHIPPED assembly, never confirms the create, applies
 * the trusted command, reads the durable rows with a fresh connection, writes
 * the reading to its marker and EXITS. This helper starts it, refuses a child
 * that did not exit cleanly, and answers what the child left behind — the
 * process boundary is real, not two connections in one process.
 */
function recordControlFromAnotherProcess(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly graphId: string;
  readonly command: "failure" | "timeout";
}): ControlRestartReport {
  const result = Bun.spawnSync(
    [
      process.execPath,
      CONTROL_XPROC_WORKER,
      "--dir",
      options.dir,
      "--store",
      options.storeRoot,
      "--graph",
      options.graphId,
      "--command",
      options.command,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(
      "fixture: the control-recording process exited " +
        String(result.exitCode) +
        " instead of applying the command (stderr: " +
        stderr.trim() +
        ")",
    );
  }
  return JSON.parse(
    readFileSync(join(options.dir, CONTROL_REPORT_MARKER), "utf8"),
  ) as ControlRestartReport;
}

describe("graph_control — a failure/timeout survives the recording PROCESS", () => {
  for (const command of ["failure", "timeout"] as const) {
    it("reports the " + command + " after a real relaunch, keeps the unconfirmed execution visible and settles nothing", async () => {
      const dir = makeTmpDir("control-xproc-restart-");
      const storeRoot = join(dir, "host-store");
      mkdirSync(storeRoot, { recursive: true });
      const graphId = XPROC_CONTROL_GRAPH_ID;

      // THE CHILD IS A REAL OS PROCESS, and the marker proves it: its pid is
      // not this process's, and its own fresh-connection reading is what it
      // leaves behind.
      const child = recordControlFromAnotherProcess({ dir, storeRoot, graphId, command });
      expect(child.pid).not.toBe(process.pid);
      expect(child.graphId).toBe(graphId);
      expect(child.command).toBe(command);
      expect(child.answer.kind).toBe("applied");
      expect(child.answer.runControl?.command).toBe(command);
      // The create was handed to the platform and NEVER confirmed, so the
      // execution row is `creating` — an external task that may exist.
      expect(child.executions).toEqual(["work#1=creating"]);
      expect(child.events).toBe(0);
      expect(child.receipts).toBe(0);

      // THE RELAUNCH: a FRESH host over the same store root runs the PRODUCTION
      // boot sweep, which is the only path a restart takes.
      const dispatches: OutcomeDispatchRequest[] = [];
      const relaunched = OutcomeHost.open({
        workspaceDir: dir,
        storeRoot,
        deliver: (request) => {
          dispatches.push(request);
        },
        validators: EMPTY_VALIDATORS,
        declareInvocationIdentity: false,
        workerSessionOf: (execution) => execution.executionId,
      });
      try {
        const report = await relaunched.recoverDeclaredGraphs();
        // THE STOP IS REPORTED: the fact outlives the process that decided it.
        expect(report.controlled).toEqual([graphId + ":" + command]);
        // THE UNCONFIRMED EXECUTION STAYS VISIBLE.
        expect(report.unconfirmedExecutions).toHaveLength(1);
        expect(report.unconfirmedExecutions[0]).toMatchObject({
          graphId,
          nodeId: "work",
          attemptId: "work#1",
          state: "creating",
        });
        // NOTHING IS DISPATCHED by the relaunch, and the effect the stop left
        // pending is refused by name instead of being re-created.
        expect(dispatches).toEqual([]);
        expect(report.effectRefusals.map((refusal) => refusal.code)).toContain("control-stopped");

        // NO SETTLEMENT IS POSSIBLE AFTER THE RESTART. The shipped ingress
        // refuses the stopped run by name whatever credential a late worker
        // presents, so the successor can never be armed.
        const relaunchedToolset = createGraphToolSet({
          stateDir: dir,
          credentialIsolation: relaunched.credentialIsolation,
          hostIdentity: relaunched.workerIdentity,
          outcomeDispatch: relaunched.dispatch,
          outcomeValidators: EMPTY_VALIDATORS,
          outcomeArtifactRoot: dir,
        });
        const tools = relaunched.bindTools(createOutcomeGraphTools(relaunchedToolset));
        const refused = JSON.parse(
          String(
            await tools.graph_submit_outcome.execute(
              {
                graph_id: graphId,
                node_id: "work",
                outcome_id: "done",
                credential: "credential.after-restart",
              },
              makeContext(childSessionOf("work#1"), "agent.work", dir),
            ),
          ),
        ) as { readonly refusals?: readonly { readonly code: string }[] };
        expect(refused.refusals?.[0]?.code).toBe("control-stopped");
        expect(dispatches).toEqual([]);

        const store = GraphStore.openFile(storeRoot);
        try {
          expect(store.runs.readRunControl(graphId)?.command).toBe(command);
          expect(
            store.runs.controlDecisions(graphId).map((decision) => decision.attemptId + ":" + decision.command),
          ).toEqual(["work#1:" + command]);
          expect(store.acceptedEvents(graphId)).toEqual([]);
        } finally {
          store.close();
        }
      } finally {
        relaunched.close();
      }
    });
  }
});

/** Call the SHIPPED `graph_control` tool and parse its JSON answer. */
async function control(
  fixture: ControlFixture,
  args: Record<string, unknown>,
  sessionID: string,
  agent = "agent.declarer",
): Promise<ControlAnswer> {
  const raw = String(
    await fixture.tools.graph_control.execute(args, fixture.contextOf(sessionID, agent)),
  );
  if (raw.startsWith("graph_control failed:")) {
    throw new Error("fixture: graph_control failed: " + raw);
  }
  return JSON.parse(raw) as ControlAnswer;
}

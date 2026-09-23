/**
 * P3 cancel — the durable intent, the platform delivery, and the two facts
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR.
 *
 * 1. `graph_control cancel` records the trusted decision AND the host records a
 *    cancel EFFECT, committed BEFORE the platform is asked anything, so a
 *    process that dies mid-cancel resumes with the intent visible.
 * 2. `requested` and `confirmed` are different facts: only the platform's own
 *    substantiation writes `done` and only it is reported as confirmed. A
 *    platform that cannot answer leaves the execution VISIBLE and unsettled.
 * 3. The races resolve by stated rules: a completion that commits first keeps
 *    its accepted result and no cancel is recorded for it; a cancel that commits
 *    first stops the run, refuses the later submission before the acceptance
 *    core, and never arms the successor; a repeated cancel replays the decision
 *    and never rewinds a confirmed effect.
 * 4. A cancelled run is never re-dispatched by the boot sweep, which instead
 *    DELIVERS the cancel intents a previous process left behind.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real `OutcomeHost` over the workspace's one
 * SQLite store, the real `createGraphToolSet`, and the `graph_control` tool of
 * `createOutcomeGraphTools` wired through the SAME `OutcomeHost.bindTools` +
 * `withCancelDelivery` pair both entries install. The platform is a fake cancel
 * port that answers from the test's script and reads the durable cancel effect
 * back INSIDE the ask — that read is what proves the intent was durable first.
 *
 * STRENGTH: adapter + real store, one process (the restart case is two host
 * instances over one store root, not two OS processes). No real dsh/Pi SDK runs
 * in this environment, so nothing here is real-host evidence.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  OutcomeHost,
  withCancelDelivery,
} from "../../src/graph/host/outcome-host.ts";
import {
  cancelEffectIdOf,
  type OutcomeExecutionCancelAnswer,
  type OutcomeExecutionCancelProbe,
  type OutcomeExecutionCancellation,
} from "../../src/graph/outcome/cancel.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
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

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** work -> review: an accepted outcome for `work` arms the `review` attempt. */
const CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "cancel.chain",
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
 * A SINGLE entry node: settling it completes the graph, so a cancel issued after
 * the completion finds NOTHING in flight — the case where the completion wins.
 */
const SOLO: GraphDeclarationV3 = {
  version: 3,
  name: "cancel.solo",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
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

/** What the durable rows held at the moment the platform was asked. */
interface CancelAskReading {
  readonly attemptId: string;
  /** The cancel effect's status INSIDE the ask (undefined when none existed). */
  readonly effect: string | undefined;
  /** The run's control command INSIDE the ask. */
  readonly runCommand: string | undefined;
}

interface FakeCancelPort {
  readonly port: OutcomeExecutionCancellation;
  readonly asked: OutcomeExecutionCancelProbe[];
  readonly atAsk: CancelAskReading[];
  answer:
    | OutcomeExecutionCancelAnswer
    | ((probe: OutcomeExecutionCancelProbe) => OutcomeExecutionCancelAnswer);
}

/**
 * A platform cancel port that answers from the test's script and reads the
 * durable cancel effect back through a FRESH connection INSIDE the ask.
 */
function createFakeCancelPort(storeRoot: string): FakeCancelPort {
  const asked: OutcomeExecutionCancelProbe[] = [];
  const atAsk: CancelAskReading[] = [];
  const fake: FakeCancelPort = {
    asked,
    atAsk,
    answer: {
      kind: "requested",
      reason: "the fake platform took the request and cannot confirm it",
    },
    port: Object.freeze({
      cancel: async (probe: OutcomeExecutionCancelProbe) => {
        asked.push(probe);
        let effect: string | undefined;
        let runCommand: string | undefined;
        try {
          const store = GraphStore.openFile(storeRoot);
          try {
            effect = store
              .pendingEffects(probe.effect.graphId)
              .find((row) => row.effectId === cancelEffectIdOf(probe.effect.attemptId))
              ?.status;
            runCommand = store.runs.readRunControl(probe.effect.graphId)?.command;
          } finally {
            store.close();
          }
        } catch {
          // A store the fake cannot read is "no reading", never a guess.
        }
        atAsk.push(Object.freeze({ attemptId: probe.effect.attemptId, effect, runCommand }));
        return typeof fake.answer === "function" ? fake.answer(probe) : fake.answer;
      },
    }),
  };
  return fake;
}

/** One shipped host assembly over a given store root, with a scripted platform. */
async function openHost(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly dispatches: OutcomeDispatchRequest[];
  readonly cancelPort?: OutcomeExecutionCancellation;
  readonly confirm?: boolean;
  /** Wire the cancel delivery into the tool face, as both shipped entries do. */
  readonly deliverOnControl?: boolean;
}): Promise<{
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
}> {
  const confirm = options.confirm ?? true;
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: options.dir,
    storeRoot: options.storeRoot,
    deliver: (request, effect) => {
      options.dispatches.push(request);
      if (confirm) {
        host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
      }
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    ...(options.cancelPort === undefined ? {} : { cancelExecution: options.cancelPort }),
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: options.dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: options.dir,
  });
  const raw = createOutcomeGraphTools(toolset);
  return {
    host: opened,
    toolset,
    tools: opened.bindTools(
      options.deliverOnControl === false ? raw : withCancelDelivery(raw, opened),
    ),
  };
}

interface CancelFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatches: OutcomeDispatchRequest[];
  readonly platform: FakeCancelPort;
  readonly graphId: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

async function openCancelFixture(
  declaration: GraphDeclarationV3,
  options: {
    readonly confirm?: boolean;
    readonly deliverOnControl?: boolean;
  } = {},
): Promise<CancelFixture> {
  const dir = makeTmpDir("cancel-delivery-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatches: OutcomeDispatchRequest[] = [];
  const platform = createFakeCancelPort(storeRoot);
  const opened = await openHost({
    dir,
    storeRoot,
    dispatches,
    cancelPort: platform.port,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.deliverOnControl === undefined
      ? {}
      : { deliverOnControl: options.deliverOnControl }),
  });
  const fixture: CancelFixture = {
    ...opened,
    dir,
    storeRoot,
    dispatches,
    platform,
    graphId: declaration.name,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
  };
  const declared = String(
    await fixture.tools.graph_declare.execute(
      { declaration },
      fixture.contextOf("session.declarer", "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await fixture.host.startDeclaredGraph(declaration.name, {
    sessionId: "session.declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return fixture;
}

// ── Reading the durable rows back ───────────────────────────────────────────

interface DurableRows {
  readonly run: { readonly runId: string } | undefined;
  readonly control: { readonly command: string; readonly reason: string } | undefined;
  readonly decisions: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly command: string;
    readonly reason: string;
  }[];
  /** Every UNSETTLED effect (pending/started) of the graph. */
  readonly effects: readonly {
    readonly effectId: string;
    readonly attemptId: string;
    readonly kind: string;
    readonly status: string;
  }[];
  /** Every CANCEL effect row, whatever its status (a terminal row included). */
  readonly cancelEffects: readonly {
    readonly effectId: string;
    readonly status: string;
  }[];
  readonly events: readonly { readonly attemptId: string; readonly outcomeId: string }[];
  readonly receipts: number;
}

/** Read the durable rows of one graph with a FRESH connection. */
function readRowsAt(storeRoot: string, graphId: string): DurableRows {
  const store = GraphStore.openFile(storeRoot);
  try {
    return {
      run: store.runs.readRun(graphId),
      control: store.runs.readRunControl(graphId),
      decisions: store.runs.controlDecisions(graphId),
      effects: store.pendingEffects(graphId),
      cancelEffects: store
        .all(
          "SELECT effect_id, status FROM " +
            GRAPH_STORE_TABLES.pendingEffects +
            " WHERE graph_id = ? AND kind = 'cancel' ORDER BY effect_id",
          graphId,
        )
        .map((row) => ({
          effectId: String(row["effect_id"]),
          status: String(row["status"]),
        })),
      events: store.acceptedEvents(graphId),
      receipts:
        store.all(
          "SELECT COUNT(*) AS n FROM " +
            GRAPH_STORE_TABLES.receipts +
            " WHERE graph_id = ?",
          graphId,
        )[0]?.["n"] as number,
    };
  } finally {
    store.close();
  }
}

function readRows(fixture: CancelFixture): DurableRows {
  return readRowsAt(fixture.storeRoot, fixture.graphId);
}

function decisionOf(rows: DurableRows, attemptId: string): DurableRows["decisions"][number] {
  const decision = rows.decisions.find((entry) => entry.attemptId === attemptId);
  if (decision === undefined) throw new Error("fixture: no control decision for " + attemptId);
  return decision;
}

function cancelRowOf(
  rows: DurableRows,
  attemptId: string,
): DurableRows["cancelEffects"][number] | undefined {
  return rows.cancelEffects.find((row) => row.effectId === cancelEffectIdOf(attemptId));
}

/** The credential one dispatched attempt was handed (never printed by a test). */
function credentialOf(fixture: CancelFixture, nodeId: string): string {
  const request = fixture.dispatches.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no dispatch for node " + nodeId);
  return request.credential;
}

/** Call a bound `graph_control` tool and parse its JSON answer. */
async function controlWith(
  tools: Record<string, CanonicalToolDef>,
  contextOf: (sessionID: string, agent: string) => CanonicalToolContext,
  args: Record<string, unknown>,
  sessionID: string,
  agent = "agent.declarer",
): Promise<Record<string, unknown>> {
  const raw = String(await tools.graph_control.execute(args, contextOf(sessionID, agent)));
  if (raw.startsWith("graph_control failed:")) {
    throw new Error("fixture: graph_control failed: " + raw);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function control(
  fixture: CancelFixture,
  args: Record<string, unknown>,
  sessionID: string,
  agent = "agent.declarer",
): Promise<Record<string, unknown>> {
  return controlWith(fixture.tools, fixture.contextOf, args, sessionID, agent);
}

/** Submit `work`'s `done` outcome from the child session the platform created. */
async function submitWork(fixture: CancelFixture): Promise<Record<string, unknown>> {
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
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The refusal codes of one tool answer. */
function refusalCodes(answer: Record<string, unknown>): readonly string[] {
  const refusals = answer["refusals"];
  if (!Array.isArray(refusals)) return [];
  return refusals.map((refusal) => String((refusal as { code?: unknown }).code));
}

// ── The intent and the platform delivery ────────────────────────────────────

describe("graph_control cancel — the durable intent and the platform delivery", () => {
  it("records the intent before the platform is asked, and confirms only what the platform substantiated", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason:
          "the fake platform disposed run child-session:work#1 and observed stopReason 'aborted'",
      };

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");
      expect((answer["runControl"] as { command?: string }).command).toBe("cancel");

      // ONE ask, for the execution the host recorded — and the durable intent was
      // ALREADY readable when the platform was asked: the run's control fact and a
      // started cancel effect, never a bare promise of one.
      expect(fixture.platform.asked).toHaveLength(1);
      const probe = fixture.platform.asked[0];
      expect(probe?.effect.effectId).toBe("dispatch:work#1");
      expect(probe?.nodeId).toBe("work");
      expect(probe?.execution?.executionId).toBe(childSessionOf("work#1"));
      expect(probe?.reason).toBe("the operator stopped it");
      expect(fixture.platform.atAsk).toEqual([
        { attemptId: "work#1", effect: "started", runCommand: "cancel" },
      ]);

      const rows = readRows(fixture);
      expect(rows.control?.command).toBe("cancel");
      expect(decisionOf(rows, "work#1").command).toBe("cancel");
      // CONFIRMED is a durable fact of its own: the cancel effect is `done`.
      expect(cancelRowOf(rows, "work#1")).toEqual({
        effectId: "cancel:work#1",
        status: "done",
      });
      // The dispatch effect is EXACTLY where the stop found it, and no business
      // success was written by the cancellation.
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);

      // A SECOND delivery re-reads the SAME durable fact and does not ask again.
      const replay = await fixture.host.deliverCancelIntents(fixture.graphId);
      expect(replay.entries).toHaveLength(1);
      expect(replay.entries[0]?.state).toBe("confirmed");
      expect(replay.entries[0]?.reason).toContain("previous delivery");
      expect(fixture.platform.asked).toHaveLength(1);
    } finally {
      fixture.host.close();
    }
  });

  it("never reports an unconfirmed cancel as cancelled, and asks again while it stays unconfirmed", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "requested",
        reason: "the fake platform handed the dispose on and cannot confirm the run ended",
      };

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");

      let rows = readRows(fixture);
      // REQUESTED, not confirmed: the effect stays started, so it stays in the
      // resume set and the graph keeps owing that external task.
      expect(cancelRowOf(rows, "work#1")).toEqual({
        effectId: "cancel:work#1",
        status: "started",
      });
      expect(rows.effects.map((effect) => effect.effectId).sort()).toEqual([
        "cancel:work#1",
        "dispatch:work#1",
      ]);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);

      const again = await fixture.host.deliverCancelIntents(fixture.graphId);
      expect(again.entries[0]?.state).toBe("requested");
      expect(again.entries[0]?.reason).toContain("has NOT confirmed it");
      // An unconfirmed request is RE-ASKED; it is never rounded into a cancel.
      expect(fixture.platform.asked).toHaveLength(2);

      rows = readRows(fixture);
      expect(cancelRowOf(rows, "work#1")?.status).toBe("started");
    } finally {
      fixture.host.close();
    }
  });

  it("answers unsupported when the host cannot name an execution, and keeps it visible", async () => {
    // confirm: false leaves the create row `creating`: an external task may exist
    // although the platform never named it, so it can be asked about but not
    // addressed — and the answer must never be "cancelled".
    const fixture = await openCancelFixture(CHAIN, { confirm: false });
    try {
      fixture.platform.answer = (probe) =>
        probe.execution === undefined
          ? {
              kind: "unsupported",
              reason: "the host named no execution, so there is nothing to cancel",
            }
          : { kind: "confirmed", reason: "unreachable in this fixture" };

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");
      expect(answer["unconfirmedExecutions"]).toHaveLength(1);

      expect(fixture.platform.asked).toHaveLength(1);
      expect(fixture.platform.asked[0]?.execution).toBeUndefined();
      const rows = readRows(fixture);
      expect(cancelRowOf(rows, "work#1")?.status).toBe("started");
      expect(rows.effects.find((effect) => effect.kind === "dispatch")?.status).toBe("started");
      expect(rows.events).toEqual([]);

      // The boot sweep keeps the unconfirmed execution visible AND names the
      // unconfirmed cancel; nothing became a completion.
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.unconfirmedExecutions).toHaveLength(1);
      expect(report.unconfirmedExecutions[0]).toMatchObject({
        graphId: fixture.graphId,
        attemptId: "work#1",
        state: "creating",
      });
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "unsupported" }),
      ]);
      expect(report.cancellations[0]?.reason).toContain(
        "offers no cancellation surface for this execution",
      );
    } finally {
      fixture.host.close();
    }
  });
});

// ── Deterministic races ─────────────────────────────────────────────────────

describe("graph_control cancel — deterministic races", () => {
  it("never re-labels an attempt that completed first: no cancel decision, effect or platform ask for it", async () => {
    // THE COMPLETION WINS THE ATTEMPT. SOLO has no successor, so once its single
    // entry settles there is nothing in flight: the run can still be stopped,
    // but the settled attempt is never re-labelled and its platform execution is
    // never cancelled.
    const fixture = await openCancelFixture(SOLO);
    try {
      const submitted = await submitWork(fixture);
      expect(submitted["decision"]).toBe("accepted");

      const late = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "too late for the attempt" },
        "session.declarer",
      );
      expect(late["kind"]).toBe("applied");
      expect(late["decided"]).toEqual([]);
      expect(late["skipped"]).toEqual([]);

      // THE DELIVERY FOLLOWS A DURABLE PER-ATTEMPT DECISION ONLY: none was
      // recorded, so there was no intent to hand anywhere and the platform was
      // never asked about the settled attempt.
      expect(fixture.platform.asked).toEqual([]);

      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.cancelEffects).toEqual([]);
      expect(rows.events.map((event) => event.outcomeId)).toEqual(["done"]);
      expect(rows.receipts).toBe(1);
      expect(rows.effects.map((effect) => effect.effectId)).toEqual([]);
      // The run's own stop fact is recorded — a cancel with nothing in flight is
      // still a stop — but it carries no attempt and no effect.
      expect(rows.control?.command).toBe("cancel");

      // The persisted node stays COMPLETED: the accepted result is the fact.
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.cancellations).toEqual([]);
      expect(fixture.platform.asked).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("stops the run when the cancel commits first, refuses the later submission, and arms no successor", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason: "the fake platform confirmed the abort",
      };
      const applied = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(applied["kind"]).toBe("applied");
      const dispatchesBefore = fixture.dispatches.length;

      const refused = await submitWork(fixture);
      expect(refusalCodes(refused)).toEqual(["control-stopped"]);

      const rows = readRows(fixture);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      expect(rows.control?.command).toBe("cancel");
      expect(cancelRowOf(rows, "work#1")?.status).toBe("done");
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);

      // The boot sweep REPORTS the stop and never starts a new attempt — and it
      // delivers the confirmed cancel intents once, not once per boot.
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);
      expect(fixture.platform.asked).toHaveLength(1);

      const second = await fixture.host.recoverDeclaredGraphs();
      expect(second.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);
      expect(fixture.platform.asked).toHaveLength(1);
    } finally {
      fixture.host.close();
    }
  });

  it("replays a repeated cancel and never rewinds the confirmed effect", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason: "the fake platform confirmed the abort",
      };
      const first = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "first reason" },
        "session.declarer",
      );
      expect(first["kind"]).toBe("applied");

      const second = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "second reason" },
        "session.declarer",
      );
      expect(second["kind"]).toBe("applied");
      const decided = second["decided"] as readonly { readonly replayed: boolean }[];
      expect(decided[0]?.replayed).toBe(true);
      // The run keeps the command that stopped it FIRST.
      expect((second["runControl"] as { reason?: string }).reason).toBe("first reason");

      // An already-confirmed cancel is not asked again: the platform is not
      // re-asked for a fact the store already holds.
      expect(fixture.platform.asked).toHaveLength(1);
      const rows = readRows(fixture);
      expect(rows.control?.reason).toBe("first reason");
      expect(cancelRowOf(rows, "work#1")?.status).toBe("done");
    } finally {
      fixture.host.close();
    }
  });

  it("never reads a terminal cancel effect this build does not write as a confirmation", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "requested",
        reason: "the fake platform cannot confirm the run ended",
      };
      await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        "session.declarer",
      );

      // A FOREIGN writer settles the cancel effect as `failed` — a state this
      // build never writes for a cancel.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const verdict = store.markEffectFailed(fixture.graphId, cancelEffectIdOf("work#1"));
        expect(verdict.kind).toBe("transitioned");
      } finally {
        store.close();
      }

      const report = await fixture.host.deliverCancelIntents(fixture.graphId);
      expect(report.entries).toHaveLength(1);
      // The platform is asked again (the external task may still run), the foreign
      // terminal row is NOT read as a confirmation, and it is reported by name.
      expect(fixture.platform.asked).toHaveLength(2);
      expect(report.entries[0]?.state).toBe("requested");
      expect(report.entries[0]?.reason).toContain("terminal 'failed'");

      const rows = readRows(fixture);
      expect(rows.cancelEffects).toEqual([{ effectId: "cancel:work#1", status: "failed" }]);
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── A crash mid-cancel, and the worker boundary ─────────────────────────────

describe("graph_control cancel — the window before delivery, and the worker boundary", () => {
  it("resumes with the intent visible after the recording host instance ends before delivery, and delivers it on the next boot", async () => {
    const dir = makeTmpDir("cancel-restart-");
    const storeRoot = join(dir, "host-store");
    mkdirSync(storeRoot, { recursive: true });
    const contextOf = (sessionID: string, agent: string) => makeContext(sessionID, agent, dir);

    // INSTANCE A: no cancel port and no delivery wiring — the window between the
    // durable decision and the platform call, at the point a process would die.
    // The crash is NOT driven here: this case closes one host instance and opens
    // another over the same store root IN ONE PROCESS (the file header says so).
    // What it pins is the ORDER — the intent is durable before any platform call
    // and the next boot delivers it — not a process boundary.
    const firstDispatches: OutcomeDispatchRequest[] = [];
    const a = await openHost({ dir, storeRoot, dispatches: firstDispatches, deliverOnControl: false });
    try {
      const declared = String(
        await a.tools.graph_declare.execute({ declaration: CHAIN }, contextOf("session.declarer", "agent.declarer")),
      );
      expect(declared.includes("graph_declare failed:")).toBe(false);
      const started = await a.host.startDeclaredGraph(CHAIN.name, {
        sessionId: "session.declarer",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");

      const answer = await controlWith(
        a.tools,
        contextOf,
        { graph_id: CHAIN.name, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");

      // THE INTENT IS DURABLE...
      const rows = readRowsAt(storeRoot, CHAIN.name);
      expect(rows.control?.command).toBe("cancel");
      expect(decisionOf(rows, "work#1").command).toBe("cancel");
      // ...and NO cancel effect exists: this host never reached a platform.
      expect(rows.cancelEffects).toEqual([]);
      // The unconfirmed external task is still named by the run path's own answer.
      expect(answer["unsettledEffects"]).toBeDefined();
    } finally {
      a.host.close();
    }

    // INSTANCE B: the same store root, with the platform cancel port installed.
    const platform = createFakeCancelPort(storeRoot);
    platform.answer = {
      kind: "confirmed",
      reason: "the fake platform confirmed the abort after the restart",
    };
    const secondDispatches: OutcomeDispatchRequest[] = [];
    const b = await openHost({
      dir,
      storeRoot,
      dispatches: secondDispatches,
      cancelPort: platform.port,
    });
    try {
      const report = await b.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([CHAIN.name + ":cancel"]);
      // The intent the previous host instance left behind is DELIVERED, and the
      // report says which fact the delivery established.
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(platform.asked).toHaveLength(1);
      expect(platform.asked[0]?.execution?.executionId).toBe(childSessionOf("work#1"));
      expect(platform.atAsk[0]).toEqual({
        attemptId: "work#1",
        effect: "started",
        runCommand: "cancel",
      });
      // The effect is confirmed now, and the cancelled run started NOTHING.
      expect(readRowsAt(storeRoot, CHAIN.name).cancelEffects).toEqual([
        { effectId: "cancel:work#1", status: "done" },
      ]);
      expect(secondDispatches).toEqual([]);

      // A SECOND boot re-reports the stop and asks nothing again.
      const secondBoot = await b.host.recoverDeclaredGraphs();
      expect(secondBoot.controlled).toEqual([CHAIN.name + ":cancel"]);
      expect(secondBoot.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(platform.asked).toHaveLength(1);
      expect(secondDispatches).toEqual([]);
    } finally {
      b.host.close();
    }
  });

  it("refuses a dispatched worker's control call before the tool body, so it can trigger no delivery", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      const raw = String(
        await fixture.tools.graph_control.execute(
          { graph_id: fixture.graphId, command: "cancel", reason: "a worker tries to stop the graph" },
          fixture.contextOf(childSessionOf("work#1"), "agent.work"),
        ),
      );
      const refused = JSON.parse(raw) as { readonly refused?: boolean; readonly code?: string };
      expect(refused.refused).toBe(true);
      expect(refused.code).toBe("worker-tool-forbidden");

      expect(fixture.platform.asked).toEqual([]);
      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(rows.cancelEffects).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });
});

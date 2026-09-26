/**
 * P2 part 2 — the OBSERVATION path at the shipped host assembly.
 *
 * The platform ports are pinned in `tests/platform/outcome-observation.test.ts`;
 * THIS file pins what the host does with them:
 *
 *   - F2 / W4: a create whose confirmation never arrived (the execution row stays
 *     `creating`) is matched to the execution the PLATFORM names for the same
 *     stable effect id — the SAME execution, and no second create. The local
 *     durable row is bound when this process still owns the claim, and is left
 *     exactly as the fence left it when it does not;
 *   - F4: the sweep's `awaitingCompletion` inventory is CONSUMED —
 *     `retainAwaitingCompletions` re-subscribes where the platform supports it and
 *     settles the announced end through the SAME completion bridge (idempotent by
 *     the ledger), reports what it cannot watch, and never settles an execution
 *     the platform reports as ended WITHOUT reaching its authorized outcome;
 *   - F3: the port is asked with the graph's own recorded invocation, and its
 *     asynchronous `prime` phase runs BEFORE the synchronous run path asks —
 *     the probe is the stable effect key the create carried;
 *   - DEFECT 2: a finished execution is settled by ONE entry, which asks the
 *     plan's own completion FIRST and then the outcome the WORKER'S OWN LAST
 *     TURN declared (`derivedOutcomeOf`). A declared reading settles through the
 *     derived channel; an absent reading, a throwing reader and a host with no
 *     reader at all leave the attempt unsettled and REPORTED, with no accepted
 *     event, no receipt and no fabricated outcome. The file also pins that a
 *     node-scoped `failure` is reported in `failedAttempts`, never in
 *     `controlled`: a failure ends ONE attempt, not the run.
 *
 * A FALSE `absent` IS THE DANGEROUS ANSWER (plan §8.3 O2): the "platform cannot
 * find it" case below asserts that the stranded claim is NOT released and the
 * attempt is NOT re-created.
 *
 * The declared graph has ONE node on purpose: a settled attempt must not arm a
 * successor, so every assertion here is about the attempt under test.
 *
 * PRIVACY: temp directories under the OS temp root, minted ids, no credential
 * values, no private paths.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type {
  HostCompletionWatchPort,
  HostDerivedOutcome,
  HostExecutionObservation,
} from "../../src/graph/host/outcome-host.ts";
import {
  HostExecutionIndex,
  type HostExecutionIdentity,
} from "../../src/graph/host/execution-index.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  dispatchEffectKeyOf,
  type OutcomeDispatchRequest,
  type OutcomeExecutionLookup,
  type OutcomeExecutionProbe,
} from "../../src/graph/outcome/dispatch-effects.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  AUTHORIZED,
  GRAPH_ID,
  POLICY_ID,
  POLICY_REVISION,
  makeTmpDir,
} from "./helpers/host-graph-fixture.ts";

const ATTEMPT_ID = "work#1";
const PLATFORM_EXECUTION_ID = "platform-execution-unconfirmed";

/**
 * The SAME one-node graph with NO natural completion pinned: the outcome is the
 * worker's own (`explicit`), so the plan's completion channel cannot settle it
 * and the derived channel is the only one that can.
 */
function submittedNodeDeclaration() {
  return {
    version: 3 as const,
    name: GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
    ],
    edges: [],
  };
}

/** One node completing naturally — the plan authorizes exactly this mapping. */
function singleNodeDeclaration() {
  return {
    version: 3 as const,
    name: GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        completion: { mode: "natural" as const, outcome: "done" },
      },
    ],
    edges: [],
    completion_policy: { id: POLICY_ID, revision: POLICY_REVISION },
  };
}

interface PlatformDouble {
  /** Whether the platform's query reports an execution at all. */
  present: boolean;
  /** What the terminal read answers. */
  observation: HostExecutionObservation;
  /** Every probe the port was asked to prime, in order. */
  probes: OutcomeExecutionProbe[];
  /** Every probe the synchronous lookup answered, in order. */
  asked: OutcomeExecutionProbe[];
  /** The call order, so "primed before asked" is assertable. */
  order: string[];
  /** The watch callback the host registered, when one was registered. */
  ended: (() => void) | undefined;
}

function makePlatform(state: Partial<PlatformDouble> = {}): PlatformDouble {
  return {
    present: true,
    observation: Object.freeze({ kind: "running" as const }),
    probes: [],
    asked: [],
    order: [],
    ended: undefined,
    ...state,
  };
}

/** The platform ports one host instance is given, plus the watch trigger. */
function portsFor(state: PlatformDouble): {
  query: {
    lookup(probe: OutcomeExecutionProbe): OutcomeExecutionLookup;
    prime(probes: readonly OutcomeExecutionProbe[]): Promise<void>;
  };
  observeExecution: (execution: { executionId: string }) => HostExecutionObservation;
  watchCompletion: HostCompletionWatchPort;
} {
  return {
    query: {
      lookup: (probe) => {
        state.asked.push(probe);
        state.order.push("lookup");
        return state.present
          ? Object.freeze({
              kind: "created" as const,
              execution: Object.freeze({ executionId: PLATFORM_EXECUTION_ID }),
            })
          : Object.freeze({
              kind: "unknown" as const,
              reason: "the platform cannot prove this execution never existed",
            });
      },
      prime: async (probes) => {
        state.probes.push(...probes);
        state.order.push("prime");
      },
    },
    observeExecution: () => state.observation,
    watchCompletion: (_entry, onEnded) => {
      state.ended = onEnded;
      return state.present ? "watching" : "unsupported";
    },
  };
}

const openHosts: OutcomeHost[] = [];
afterEach(() => {
  for (const host of openHosts.splice(0)) {
    try {
      host.close();
    } catch {
      // A closed host is closed.
    }
  }
});

function open(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly deliveries: OutcomeDispatchRequest[];
  readonly state: PlatformDouble;
  readonly installPorts?: boolean;
  readonly watch?: boolean;
  /** The platform's reading of a finished execution's own last turn (DEFECT 2). */
  readonly derivedOutcomeOf?: (execution: HostExecutionIdentity) => HostDerivedOutcome;
}): OutcomeHost {
  const ports = portsFor(options.state);
  const host = OutcomeHost.open({
    workspaceDir: options.dir,
    storeRoot: options.storeRoot,
    deliver: (request) => {
      options.deliveries.push(request);
    },
    declareInvocationIdentity: false,
    completionPolicies: AUTHORIZED,
    ...(options.installPorts === false
      ? {}
      : {
          query: ports.query,
          observeExecution: ports.observeExecution,
          ...(options.watch === true ? { watchCompletion: ports.watchCompletion } : {}),
        }),
    ...(options.derivedOutcomeOf === undefined
      ? {}
      : { derivedOutcomeOf: options.derivedOutcomeOf }),
  });
  openHosts.push(host);
  return host;
}

function fixture(prefix: string): { dir: string; storeRoot: string } {
  const dir = makeTmpDir(prefix);
  const storeRoot = join(dir, "host-store");
  persistDeclaredGraph(
    buildDeclaredOutcomeGraph({
      declaration: singleNodeDeclaration(),
      completionPolicies: AUTHORIZED,
    }),
    storeRoot,
  );
  return { dir, storeRoot };
}

/** The authoritative accepted-event count, from a fresh connection. */
async function acceptedEvents(storeRoot: string): Promise<number> {
  return (await acceptedRecords(storeRoot)).length;
}

/** Every accepted event of the graph, from a fresh connection. */
async function acceptedRecords(storeRoot: string) {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    return ledger.acceptedEvents(GRAPH_ID);
  } finally {
    ledger.close();
  }
}

/** Every receipt row of the graph's store — the acceptance's own record. */
function receiptCount(storeRoot: string): number {
  const store = GraphStore.openFile(storeRoot);
  try {
    return store.all("SELECT submission_id FROM " + GRAPH_STORE_TABLES.receipts).length;
  } finally {
    store.close();
  }
}

/** One explicit-mode fixture: no natural completion is pinned for the node. */
function submittedFixture(prefix: string): { dir: string; storeRoot: string } {
  const dir = makeTmpDir(prefix);
  const storeRoot = join(dir, "host-store");
  persistDeclaredGraph(
    buildDeclaredOutcomeGraph({ declaration: submittedNodeDeclaration() }),
    storeRoot,
  );
  return { dir, storeRoot };
}

/**
 * One NATURAL-completion fixture whose only attempt is CONFIRMED and still in
 * flight. The plan pins this node's outcome, so the plan's own completion
 * channel CAN settle it — which is what makes the ORDER of the one
 * finished-attempt entry assertable (the pinned channel is asked first, and the
 * worker's own last turn is never allowed to choose a different outcome).
 */
async function naturalAwaiting(
  prefix: string,
  derivedOutcomeOf?: (execution: HostExecutionIdentity) => HostDerivedOutcome,
): Promise<{ host: OutcomeHost; storeRoot: string }> {
  const { dir, storeRoot } = fixture(prefix);
  const first = open({
    dir,
    storeRoot,
    deliveries: [],
    state: makePlatform(),
    installPorts: false,
  });
  await first.startDeclaredGraph(GRAPH_ID, {
    sessionId: "session.declarer",
    agent: "agent.declarer",
  });
  first.confirmExecution(dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID), {
    executionId: PLATFORM_EXECUTION_ID,
  });
  first.close();

  const host = open({
    dir,
    storeRoot,
    deliveries: [],
    state: makePlatform({ observation: Object.freeze({ kind: "completed" as const }) }),
    ...(derivedOutcomeOf === undefined ? {} : { derivedOutcomeOf }),
  });
  return { host, storeRoot };
}

/** One dispatch, never confirmed, then the process exits. */
async function dispatchUnconfirmed(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly installPorts?: boolean;
  readonly state?: PlatformDouble;
}): Promise<void> {
  const host = open({
    dir: options.dir,
    storeRoot: options.storeRoot,
    deliveries: [],
    state: options.state ?? makePlatform(),
    ...(options.installPorts === undefined ? {} : { installPorts: options.installPorts }),
  });
  const started = await host.startDeclaredGraph(GRAPH_ID, {
    sessionId: "session.declarer",
    agent: "agent.declarer",
  });
  expect(started.kind).toBe("started");
  host.close();
}

/** Let the host's promise tail (a fired watch) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// ── F2 / W4 ─────────────────────────────────────────────────────────────────

describe("F2 — a create whose confirmation never arrived", () => {
  it("binds the execution the platform names when the claim is still this process's", async () => {
    const { dir, storeRoot } = fixture("host-observation-bind-");
    const state = makePlatform();
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = open({ dir, storeRoot, deliveries, state });

    const started = await host.startDeclaredGraph(GRAPH_ID, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    expect(started.kind).toBe("started");
    const effect = dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID);
    expect(deliveries.map((request) => request.attemptId)).toEqual([ATTEMPT_ID]);
    const before = HostExecutionIndex.open({ root: storeRoot });
    try {
      // The delivery never confirmed, so the create outcome is unknown.
      expect(before.read(effect)?.state).toBe("creating");
    } finally {
      before.close();
    }

    // THE PLATFORM'S ANSWER IS THE FACT THE LOST CALLBACK WOULD HAVE CARRIED:
    // this process still holds the claim, so the same conditional write a late
    // confirmation performs is applied, and the durable row now names it.
    expect(host.dispatch.lookup(effect)).toEqual({
      kind: "created",
      execution: { executionId: PLATFORM_EXECUTION_ID },
    });
    expect(host.dispatch.namedExecutionOf(effect)).toEqual({
      executionId: PLATFORM_EXECUTION_ID,
    });
    const after = HostExecutionIndex.open({ root: storeRoot });
    try {
      expect(after.read(effect)?.state).toBe("created");
      expect(after.read(effect)?.execution?.executionId).toBe(PLATFORM_EXECUTION_ID);
    } finally {
      after.close();
    }
  });

  it("finds the SAME execution after a restart without creating a second one, and settles it once", async () => {
    const { dir, storeRoot } = fixture("host-observation-w4-");
    const effect = dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID);
    await dispatchUnconfirmed({ dir, storeRoot, installPorts: false });

    // ── A FRESH HOST: the platform knows the execution, the local row does not.
    const deliveriesTwo: OutcomeDispatchRequest[] = [];
    const running = makePlatform();
    const hostTwo = open({ dir, storeRoot, deliveries: deliveriesTwo, state: running });
    const awaited = await hostTwo.recoverDeclaredGraphs();
    // NO SECOND CREATE, and the execution is NAMED for the host to keep
    // observing — the same platform execution, not a new one.
    expect(deliveriesTwo).toEqual([]);
    expect(awaited.awaitingCompletion).toHaveLength(1);
    const entry = awaited.awaitingCompletion[0];
    expect(entry?.graphId).toBe(GRAPH_ID);
    expect(entry?.nodeId).toBe("work");
    expect(entry?.attemptId).toBe(ATTEMPT_ID);
    expect(entry?.executionId).toBe(PLATFORM_EXECUTION_ID);
    expect(entry?.status).toBe("running");
    expect(entry?.reason).toContain("still running");
    // The platform's name is readable for the attempt even though the durable
    // row (fenced by the dead process's claim) was never rewritten.
    expect(hostTwo.dispatch.namedExecutionOf(effect)).toEqual({
      executionId: PLATFORM_EXECUTION_ID,
    });
    const indexTwo = HostExecutionIndex.open({ root: storeRoot });
    try {
      expect(indexTwo.read(effect)?.state).toBe("creating");
      expect(indexTwo.read(effect)?.execution?.executionId).toBeUndefined();
    } finally {
      indexTwo.close();
    }
    hostTwo.close();

    // ── A THIRD HOST: the platform now reports the execution COMPLETE. ───────
    const deliveriesThree: OutcomeDispatchRequest[] = [];
    const completed = makePlatform({
      observation: Object.freeze({ kind: "completed" as const }),
    });
    const hostThree = open({ dir, storeRoot, deliveries: deliveriesThree, state: completed });
    const settled = await hostThree.recoverDeclaredGraphs();
    expect(settled.completed).toEqual([GRAPH_ID + ":" + ATTEMPT_ID + ":accepted"]);
    expect(settled.awaitingCompletion).toEqual([]);
    expect(deliveriesThree).toEqual([]);
    expect(await acceptedEvents(storeRoot)).toBe(1);

    // A REPEATED SWEEP SETTLES NOTHING TWICE (the ledger replays the receipt).
    const again = await hostThree.recoverDeclaredGraphs();
    expect(again.completed).toEqual([]);
    expect(again.awaitingCompletion).toEqual([]);
    expect(deliveriesThree).toEqual([]);
    expect(await acceptedEvents(storeRoot)).toBe(1);
  });

  it("never blind-retries: an unprovable non-existence leaves the stranded claim held", async () => {
    const { dir, storeRoot } = fixture("host-observation-unknown-");
    const effect = dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID);
    await dispatchUnconfirmed({ dir, storeRoot, installPorts: false });

    // The platform cannot prove the execution never existed: it must answer
    // unknown, and the host must neither release the claim nor create again.
    const deliveriesTwo: OutcomeDispatchRequest[] = [];
    const unknown = makePlatform({ present: false });
    const hostTwo = open({ dir, storeRoot, deliveries: deliveriesTwo, state: unknown });
    const sweep = await hostTwo.recoverDeclaredGraphs();
    expect(deliveriesTwo).toEqual([]);
    expect(sweep.completed).toEqual([]);
    // The lost credential is reported (it is never re-issued for an effect the
    // platform may already hold) — the observable block.
    expect(sweep.effectRefusals.map((refusal) => refusal.code)).toContain(
      "credential-reissue-forbidden",
    );
    // AND THE CREATE PATH ITSELF REFUSES: a second execution for the stable
    // effect id is exactly what the create-once rule forbids.
    expect(() =>
      hostTwo.dispatch.create(
        {
          graphId: GRAPH_ID,
          planRevision: "rev-1",
          nodeId: "work",
          attemptId: ATTEMPT_ID,
          agent: "agent.work",
          prompt: "Do the work.",
          credential: "credential-fixture-2",
        },
        effect,
      ),
    ).toThrow();
    expect(deliveriesTwo).toEqual([]);
    expect(await acceptedEvents(storeRoot)).toBe(0);
  });

  it("does not let a platform that cannot prove non-existence block a create the host proved absent", async () => {
    const { dir, storeRoot } = fixture("host-observation-w2-");
    // ── INSTANCE ONE: the delivery refuses SYNCHRONOUSLY, which is the seam's
    // own proof that nothing was handed to the platform. The host releases its
    // claim with that proof and the effect stays `pending`.
    const hostOne = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {
        throw new Error("the platform refused the handover");
      },
      declareInvocationIdentity: false,
      completionPolicies: AUTHORIZED,
    });
    openHosts.push(hostOne);
    // The synchronous refusal propagates out of the starting call (it is the
    // start that failed) — the intent and the pending effect are already
    // committed, which is exactly the W2 window.
    let refused = false;
    try {
      await hostOne.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session.declarer",
        agent: "agent.declarer",
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    hostOne.close();

    // ── A FRESH HOST whose platform port is installed and answers UNKNOWN (it
    // cannot prove the execution never existed). The LOCAL durable registry
    // proves it was never handed over — the released create-right row — so the
    // absent answer stands, the lost credential is re-issued under the fence,
    // and the effect is created exactly once.
    const deliveries: OutcomeDispatchRequest[] = [];
    const cannotProve = makePlatform({ present: false });
    const hostTwo = open({ dir, storeRoot, deliveries, state: cannotProve });
    const sweep = await hostTwo.recoverDeclaredGraphs();
    expect(deliveries.map((request) => request.attemptId)).toEqual([ATTEMPT_ID]);
    expect(sweep.effectRefusals.map((refusal) => refusal.code)).toEqual([]);
  });
});

// ── F4 ──────────────────────────────────────────────────────────────────────

describe("F4 — the awaiting inventory is consumed", () => {
  /** One host over a store whose only attempt is confirmed and still running. */
  async function awaitingFixture(prefix: string): Promise<{
    host: OutcomeHost;
    deliveries: OutcomeDispatchRequest[];
    state: PlatformDouble;
    storeRoot: string;
  }> {
    const { dir, storeRoot } = fixture(prefix);
    const deliveriesOne: OutcomeDispatchRequest[] = [];
    const hostOne = open({
      dir,
      storeRoot,
      deliveries: deliveriesOne,
      state: makePlatform(),
      installPorts: false,
    });
    await hostOne.startDeclaredGraph(GRAPH_ID, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    hostOne.confirmExecution(dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID), {
      executionId: PLATFORM_EXECUTION_ID,
    });
    hostOne.close();

    const deliveries: OutcomeDispatchRequest[] = [];
    const state = makePlatform();
    const host = open({ dir, storeRoot, deliveries, state, watch: true });
    return { host, deliveries, state, storeRoot };
  }

  it("re-subscribes to a running execution and settles its announced end through the same bridge", async () => {
    const { host, deliveries, state, storeRoot } = await awaitingFixture(
      "host-observation-watch-",
    );
    const sweep = await host.recoverDeclaredGraphs();
    expect(sweep.awaitingCompletion.map((entry) => entry.executionId)).toEqual([
      PLATFORM_EXECUTION_ID,
    ]);

    // THE INVENTORY IS CONSUMED: the platform's own channel is established for
    // the named execution.
    const watching = await host.retainAwaitingCompletions(sweep.awaitingCompletion);
    expect(watching.watched).toEqual([
      GRAPH_ID + ":" + ATTEMPT_ID + ":" + PLATFORM_EXECUTION_ID,
    ]);
    expect(watching.unwatched).toEqual([]);
    expect(watching.settled).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(await acceptedEvents(storeRoot)).toBe(0);

    // The platform announces the end. The settlement runs through the bridge —
    // the SAME acceptance core — and the attempt settles exactly once.
    state.observation = Object.freeze({ kind: "completed" as const });
    state.ended?.();
    await settle();
    expect(await acceptedEvents(storeRoot)).toBe(1);

    // A SECOND announcement replays; nothing advances twice.
    state.ended?.();
    await settle();
    expect(await acceptedEvents(storeRoot)).toBe(1);
    expect(deliveries).toEqual([]);
  });

  it("reports an execution it cannot watch instead of pretending it is covered", async () => {
    const { host, state } = await awaitingFixture("host-observation-unwatched-");
    state.present = false;
    const sweep = await host.recoverDeclaredGraphs();
    const watching = await host.retainAwaitingCompletions(sweep.awaitingCompletion);
    expect(watching.watched).toEqual([]);
    expect(watching.settled).toEqual([]);
    expect(watching.unwatched).toHaveLength(1);
    expect(watching.unwatched[0]?.executionId).toBe(PLATFORM_EXECUTION_ID);
    // The platform offers no watch AND its read still says running: the
    // execution is reported as one nothing in this process is observing.
    expect(watching.unwatched[0]?.reason).toContain("offers no watch");
  });

  it("never settles an execution the platform reports as ENDED without its outcome", async () => {
    const { host, deliveries, state, storeRoot } = await awaitingFixture(
      "host-observation-failed-",
    );
    state.observation = Object.freeze({
      kind: "failed" as const,
      reason: "the worker run ended with status timeout",
    });
    const sweep = await host.recoverDeclaredGraphs();
    expect(sweep.completed).toEqual([]);
    // A NODE-SCOPED FAILURE IS NOT A RUN-LEVEL STOP: the run keeps executing, so
    // the sweep names the ATTEMPT it ended (with the command) and claims no run
    // control fact. Reporting `graph:failure` in `controlled` would tell every
    // reader the whole run had stopped.
    expect(sweep.controlled).toEqual([]);
    expect(sweep.failedAttempts).toEqual([
      GRAPH_ID + ":work:" + ATTEMPT_ID + ":failure",
    ]);
    expect(await acceptedEvents(storeRoot)).toBe(0);
    expect(deliveries).toEqual([]);
    // A failed end is not put in the listening inventory either: nothing is left
    // to watch, and the durable failure decision belongs to the control path.
    expect(sweep.awaitingCompletion).toEqual([]);

    // THE RE-QUERY BRANCH, with no watch established for the entry (the
    // platform cannot name the execution here). The case where the WATCH IS
    // established is pinned separately below.
    state.present = false;
    const watching = await host.retainAwaitingCompletions([
      {
        graphId: GRAPH_ID,
        nodeId: "work",
        attemptId: ATTEMPT_ID,
        executionId: PLATFORM_EXECUTION_ID,
        status: "running",
        reason: "the platform reports this execution still running",
      },
    ]);
    expect(watching.settled).toEqual([]);
    expect(watching.unwatched.map((entry) => entry.reason)).toEqual([
      expect.stringContaining("nothing left to watch"),
    ]);
  });

  it("never settles an announced end the platform does not report as a completion", async () => {
    const { host, deliveries, state, storeRoot } = await awaitingFixture(
      "host-observation-announced-failed-",
    );
    const sweep = await host.recoverDeclaredGraphs();
    const watching = await host.retainAwaitingCompletions(sweep.awaitingCompletion);
    // THE WATCH IS ESTABLISHED — this is the path the re-query case above does
    // not reach, and the one an announcement can arrive on.
    expect(watching.watched).toEqual([
      GRAPH_ID + ":" + ATTEMPT_ID + ":" + PLATFORM_EXECUTION_ID,
    ]);
    expect(watching.unwatched).toEqual([]);
    expect(state.ended).toBeDefined();

    // The platform announces the end, and its OWN read reports an end that is
    // NOT the authorized outcome (a timeout/error/cancel). An announcement is
    // not evidence of a completion, so nothing is settled — the settlement core
    // is never entered on a fabricated outcome.
    state.observation = Object.freeze({
      kind: "failed" as const,
      reason: "the worker run ended with status timeout",
    });
    state.ended?.();
    await settle();
    expect(await acceptedEvents(storeRoot)).toBe(0);

    // AND IT IS REPORTED, never silently dropped: the next recovery window
    // reads the same failed end and names the attempt `completion-unsettled`.
    const again = await host.recoverDeclaredGraphs();
    expect(again.completed).toEqual([]);
    expect(again.awaitingCompletion).toEqual([]);
    // STILL AN ATTEMPT-SCOPED FACT on the next window (the decision is durable
    // and replayed), and still NOT a run-level stop.
    expect(again.controlled).toEqual([]);
    expect(again.failedAttempts).toEqual([
      GRAPH_ID + ":work:" + ATTEMPT_ID + ":failure",
    ]);
    expect(deliveries).toEqual([]);
    expect(await acceptedEvents(storeRoot)).toBe(0);
  });

  it("does not settle an announcement the platform's own read still reports as running", async () => {
    const { host, deliveries, state, storeRoot } = await awaitingFixture(
      "host-observation-announced-race-",
    );
    const sweep = await host.recoverDeclaredGraphs();
    const watching = await host.retainAwaitingCompletions(sweep.awaitingCompletion);
    expect(watching.watched).toHaveLength(1);

    // The announcement races ahead of the platform's own record: the read still
    // says running, and "the platform said it is over" is not a completion.
    state.ended?.();
    await settle();
    expect(await acceptedEvents(storeRoot)).toBe(0);

    // The next window still names it as AWAITED — nothing was rounded into an
    // end — and nothing is created again.
    const again = await host.recoverDeclaredGraphs();
    expect(again.completed).toEqual([]);
    expect(again.awaitingCompletion.map((entry) => entry.executionId)).toEqual([
      PLATFORM_EXECUTION_ID,
    ]);
    expect(deliveries).toEqual([]);
    expect(await acceptedEvents(storeRoot)).toBe(0);
  });
});

// ── F3: priming before the synchronous window ────────────────────────────────

describe("F3 — the platform port is primed before the run path asks", () => {
  it("primes with the stable effect key and the graph's recorded invocation, then asks", async () => {
    const { dir, storeRoot } = fixture("host-observation-prime-");
    const deliveriesOne: OutcomeDispatchRequest[] = [];
    const hostOne = open({
      dir,
      storeRoot,
      deliveries: deliveriesOne,
      state: makePlatform(),
    });
    await hostOne.startDeclaredGraph(GRAPH_ID, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    hostOne.close();

    // A FRESH process recovers the graph: the port must be primed BEFORE the
    // synchronous resume asks, with the key the create carried and the
    // invocation the graph was declared under.
    const state = makePlatform();
    const hostTwo = open({ dir, storeRoot, deliveries: [], state });
    await hostTwo.startDeclaredGraph(GRAPH_ID, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    expect(state.probes).toEqual([
      {
        effect: dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID),
        invocation: { sessionId: "session.declarer", agent: "agent.declarer" },
      },
    ]);
    expect(state.order[0]).toBe("prime");
    expect(state.order).toContain("lookup");
    expect(state.order.indexOf("prime")).toBeLessThan(state.order.indexOf("lookup"));
  });
});

// ── DEFECT 2: ONE entry for a finished execution ────────────────────────────
//
// THE DEFECT THIS PINS SHUT. Both the sweep and the watch end at "this execution
// is over", and both used to ask ONLY the plan's pinned completion. An execution
// that ends WITHOUT one — a worker that answered in prose, a run whose tool call
// never arrived — had no channel at all, so the attempt stayed in flight
// forever. The entry now asks the plan FIRST and then the outcome the WORKER'S
// OWN LAST TURN declared, through the platform's reading port. The outcome is
// never chosen by the host: a declared reading is settled through the
// credential-free host-derived channel (the runtime authenticates it against the
// host's own confirmed execution and the plan decides), and every negative
// reading leaves the attempt unsettled and REPORTED.
//
// The graph here pins NO natural completion (the outcome is the worker's own), so
// the plan's own channel CANNOT settle it and the derived channel is the only
// one that can — which is exactly what makes these assertions about the new
// entry rather than about the old one.

/**
 * The `completion-unsettled` refusals of one sweep, in report order.
 *
 * The OTHER refusal a restarted host reports here is orthogonal to this entry:
 * the shipped vault keeps no credential VALUE, so the resume of an effect that
 * was handed to the platform reports `credential-reissue-forbidden` and leaves
 * it pending. These cases are about what the "the execution ended" entry did, so
 * they read their own refusal out of the report instead of asserting the whole
 * list.
 */
function completionUnsettled(
  refusals: readonly { readonly code: string; readonly message: string }[],
): readonly { readonly code: string; readonly message: string }[] {
  return refusals.filter((refusal) => refusal.code === "completion-unsettled");
}

/** The reading a finished worker's last turn published: one declaration. */
function declaredReading(outcomeId: string, data?: unknown): HostDerivedOutcome {
  return Object.freeze({
    kind: "declared" as const,
    outcomeId,
    ...(data === undefined ? {} : { data }),
    derivation: { eventIndex: 4, turnIndex: 6 },
  });
}

describe("DEFECT 2 — the worker's own last turn settles a finished execution", () => {
  /**
   * One explicit-mode graph whose only attempt is CONFIRMED and still in flight,
   * handed to a FRESH host that installs the reading port under test.
   */
  async function submittedAwaiting(
    prefix: string,
    derivedOutcomeOf?: (execution: HostExecutionIdentity) => HostDerivedOutcome,
    observation: HostExecutionObservation = Object.freeze({ kind: "completed" as const }),
  ): Promise<{
    host: OutcomeHost;
    deliveries: OutcomeDispatchRequest[];
    state: PlatformDouble;
    storeRoot: string;
  }> {
    const { dir, storeRoot } = submittedFixture(prefix);
    const deliveriesOne: OutcomeDispatchRequest[] = [];
    const hostOne = open({
      dir,
      storeRoot,
      deliveries: deliveriesOne,
      state: makePlatform(),
      installPorts: false,
    });
    await hostOne.startDeclaredGraph(GRAPH_ID, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    hostOne.confirmExecution(dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID), {
      executionId: PLATFORM_EXECUTION_ID,
    });
    hostOne.close();

    const deliveries: OutcomeDispatchRequest[] = [];
    const state = makePlatform({ observation });
    const host = open({
      dir,
      storeRoot,
      deliveries,
      state,
      ...(derivedOutcomeOf === undefined ? {} : { derivedOutcomeOf }),
    });
    return { host, deliveries, state, storeRoot };
  }

  it("settles a DECLARED last turn through the derived channel, and writes it once", async () => {
    const reads: string[] = [];
    const { host, deliveries, storeRoot } = await submittedAwaiting(
      "host-derived-declared-",
      (execution) => {
        reads.push(execution.executionId);
        return declaredReading("done", { answer: 42 });
      },
    );

    const sweep = await host.recoverDeclaredGraphs();
    // THE PLAN'S OWN CHANNEL CANNOT SETTLE THIS NODE (no natural completion is
    // pinned), so the attempt is settled by the outcome the WORKER'S OWN LAST
    // TURN declared — reported as `derived`, never as `completion`.
    expect(sweep.completed).toEqual([GRAPH_ID + ":" + ATTEMPT_ID + ":derived"]);
    // NOTHING was left unsettled: the attempt settled, so the entry reports no
    // `completion-unsettled` block for it.
    expect(completionUnsettled(sweep.effectRefusals)).toEqual([]);
    expect(sweep.awaitingCompletion).toEqual([]);
    // THE READER WAS ASKED ABOUT THE HOST'S OWN CONFIRMED EXECUTION — the id the
    // host recorded, never a caller-supplied value.
    expect(reads).toEqual([PLATFORM_EXECUTION_ID]);

    const accepted = await acceptedRecords(storeRoot);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.attemptId).toBe(ATTEMPT_ID);
    // THE OUTCOME IS THE WORKER'S OWN DECLARATION, not one the host picked.
    expect(accepted[0]?.outcomeId).toBe("done");
    // AND ITS PROVENANCE IS THE DERIVED CHANNEL'S KEY, so a reader can tell the
    // settlement came from the worker's own turn.
    expect(accepted[0]?.submissionId.startsWith("host-derived:")).toBe(true);

    // THE DECLARED PAYLOAD TRAVELLED WITH IT, unaltered.
    const ledger = await SqliteAcceptanceLedger.create(storeRoot);
    try {
      expect(ledger.readAcceptedResult(GRAPH_ID, ATTEMPT_ID)?.payload).toEqual({
        kind: "value",
        value: { answer: 42 },
      });
    } finally {
      ledger.close();
    }

    // A REPEATED WINDOW SETTLES NOTHING TWICE: the attempt is already settled.
    const again = await host.recoverDeclaredGraphs();
    expect(again.completed).toEqual([]);
    expect(again.awaitingCompletion).toEqual([]);
    expect((await acceptedRecords(storeRoot)).length).toBe(1);
    expect(deliveries).toEqual([]);
  });

  it("leaves the attempt unsettled and REPORTS an ABSENT last-turn reading", async () => {
    const { host, storeRoot } = await submittedAwaiting("host-derived-absent-", () =>
      Object.freeze({
        kind: "absent" as const,
        reason: "the final dsh turn carried no fenced json declaration",
      }),
    );

    const sweep = await host.recoverDeclaredGraphs();
    expect(sweep.completed).toEqual([]);
    expect(sweep.awaitingCompletion).toEqual([]);
    // REPORTED, not silently stranded: the attempt is named with the reader's
    // own reason, beside why the plan's own channel did not settle it.
    const unsettled = completionUnsettled(sweep.effectRefusals);
    expect(unsettled).toHaveLength(1);
    const message = unsettled[0]?.message ?? "";
    expect(message).toContain("ABSENT");
    expect(message).toContain("no fenced json declaration");
    expect(message).toContain(ATTEMPT_ID);
    // NO FABRICATED OUTCOME AND NO RECEIPT: nothing was accepted and nothing was
    // even decided.
    expect(await acceptedEvents(storeRoot)).toBe(0);
    expect(receiptCount(storeRoot)).toBe(0);
  });

  it("treats a THROWING reading port as unavailable, never as a settlement", async () => {
    const { host, storeRoot } = await submittedAwaiting("host-derived-throwing-", () => {
      throw new Error("the child session log could not be read");
    });

    const sweep = await host.recoverDeclaredGraphs();
    expect(sweep.completed).toEqual([]);
    const unsettled = completionUnsettled(sweep.effectRefusals);
    expect(unsettled).toHaveLength(1);
    // THE PORT IS TOTAL: a reader that throws has NOT answered, so it is
    // reported `unavailable` with its own text — never rounded into an outcome.
    const message = unsettled[0]?.message ?? "";
    expect(message).toContain("UNAVAILABLE");
    expect(message).toContain("the child session log could not be read");
    expect(await acceptedEvents(storeRoot)).toBe(0);
    expect(receiptCount(storeRoot)).toBe(0);
  });

  it("reports a host with NO reading port instead of inventing an outcome", async () => {
    const { host, storeRoot } = await submittedAwaiting("host-derived-noport-");

    const sweep = await host.recoverDeclaredGraphs();
    expect(sweep.completed).toEqual([]);
    const unsettled = completionUnsettled(sweep.effectRefusals);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]?.message).toContain(
      "installs no last-turn reading port",
    );
    expect(await acceptedEvents(storeRoot)).toBe(0);
    expect(receiptCount(storeRoot)).toBe(0);
  });

  it("settles a declared last turn from the watch path's terminal RE-QUERY too", async () => {
    // The execution is still running when the sweep looks, so it is named in the
    // awaiting inventory; no watch port is installed here, which is exactly the
    // branch that re-queries the platform once more.
    const { host, state, storeRoot } = await submittedAwaiting(
      "host-derived-requery-",
      () => declaredReading("done"),
      Object.freeze({ kind: "running" as const }),
    );
    const sweep = await host.recoverDeclaredGraphs();
    expect(sweep.awaitingCompletion.map((entry) => entry.executionId)).toEqual([
      PLATFORM_EXECUTION_ID,
    ]);
    expect(sweep.completed).toEqual([]);

    // The execution finishes; the host's own read now says so.
    state.observation = Object.freeze({ kind: "completed" as const });
    const watching = await host.retainAwaitingCompletions(sweep.awaitingCompletion);
    expect(watching.watched).toEqual([]);
    expect(watching.settled).toEqual([GRAPH_ID + ":" + ATTEMPT_ID + ":derived"]);
    expect(await acceptedEvents(storeRoot)).toBe(1);
  });

  it("REPORTS the derived channel as 'derived' through the public entry, and settles once", async () => {
    const reads: string[] = [];
    const { host, storeRoot } = await submittedAwaiting(
      "host-derived-entry-",
      (execution) => {
        reads.push(execution.executionId);
        return declaredReading("done", { answer: 42 });
      },
    );

    const report = await host.settleFinishedAttempt(GRAPH_ID, ATTEMPT_ID);
    expect(report.kind).toBe("settled");
    if (report.kind !== "settled") return;
    // THE CHANNEL IS NAMED. A worker-declared settlement is never reported as
    // the plan's own pinned completion, and the settlement record carries the
    // host-derived provenance key the ledger persisted.
    expect(report.channel).toBe("derived");
    if (report.channel !== "derived") return;
    expect(report.nodeId).toBe("work");
    expect(report.attemptId).toBe(ATTEMPT_ID);
    expect(report.settlement.source).toBe("host-derived");
    expect(report.settlement.outcomeId).toBe("done");
    expect(report.settlement.attemptId).toBe(ATTEMPT_ID);
    expect(report.settlement.submissionId.startsWith("host-derived:")).toBe(true);
    // THE READER WAS ASKED ABOUT THE HOST'S OWN CONFIRMED EXECUTION.
    expect(reads).toEqual([PLATFORM_EXECUTION_ID]);

    // A SECOND ANNOUNCEMENT SETTLES NOTHING: the entry is idempotent and names
    // the settlement that already stands, writing nothing.
    const again = await host.settleFinishedAttempt(GRAPH_ID, ATTEMPT_ID);
    expect(again.kind).toBe("already-settled");
    if (again.kind !== "already-settled") return;
    expect(again.attemptId).toBe(ATTEMPT_ID);
    expect(again.submissionId).toBe(report.settlement.submissionId);
    expect((await acceptedRecords(storeRoot)).length).toBe(1);
    expect(reads).toEqual([PLATFORM_EXECUTION_ID]);
  });

  it("asks the plan's OWN channel first: a pinned completion settles as 'completion' and the last turn is never consulted", async () => {
    const reads: string[] = [];
    const { host, storeRoot } = await naturalAwaiting(
      "host-natural-channel-",
      (execution) => {
        reads.push(execution.executionId);
        return declaredReading("other");
      },
    );

    const report = await host.settleFinishedAttempt(GRAPH_ID, ATTEMPT_ID);
    expect(report.kind).toBe("settled");
    if (report.kind !== "settled") return;
    expect(report.channel).toBe("completion");
    if (report.channel !== "completion") return;
    // THE SETTLEMENT IS THE PLAN'S OWN PINNED MAPPING — its submission key is
    // the natural channel's, never the host-derived one.
    expect(report.settlement.kind).toBe("accepted");
    if (report.settlement.kind !== "accepted") return;
    expect(report.settlement.completion.outcomeId).toBe("done");
    expect(report.settlement.completion.source).toBe("natural-completion");
    expect(
      report.settlement.completion.submissionId.startsWith("natural-completion:"),
    ).toBe(true);
    // THE WORKER'S OWN TURN WAS NEVER ASKED: the plan pinned this node's outcome
    // and a declaration must not override it.
    expect(reads).toEqual([]);
    const accepted = await acceptedRecords(storeRoot);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.outcomeId).toBe("done");
    expect(accepted[0]?.submissionId.startsWith("natural-completion:")).toBe(true);
  });

  it("keeps an outcome the PLAN does not declare unsettled, refused by name", async () => {
    const { host, storeRoot } = await submittedAwaiting("host-derived-undeclared-", () =>
      declaredReading("winner"),
    );

    const report = await host.settleFinishedAttempt(GRAPH_ID, ATTEMPT_ID);
    expect(report.kind).toBe("unsettled");
    if (report.kind !== "unsettled") return;
    expect(report.attemptId).toBe(ATTEMPT_ID);
    expect(report.nodeId).toBe("work");
    // THE PLAN DECIDES: the host never chooses an outcome, and one the plan does
    // not declare is refused by the acceptance core — by name, and before
    // anything is written.
    expect(report.refusals.map((refusal) => refusal.code)).toEqual([
      "undeclared-outcome",
    ]);
    // NO RECEIPT AND NO ACCEPTED EVENT: a refusal decides nothing.
    expect(await acceptedEvents(storeRoot)).toBe(0);
    expect(receiptCount(storeRoot)).toBe(0);
  });

  it("reports every other NEGATIVE reading as unsettled, with nothing written", async () => {
    for (const kind of ["ambiguous", "malformed", "unavailable"] as const) {
      const { host, storeRoot } = await submittedAwaiting(
        "host-derived-" + kind + "-",
        () => Object.freeze({ kind, reason: "the reading is " + kind }),
      );
      const report = await host.settleFinishedAttempt(GRAPH_ID, ATTEMPT_ID);
      expect(report.kind).toBe("unsettled");
      if (report.kind !== "unsettled") continue;
      // THE NEGATIVE KIND IS NAMED, with the reader's own reason: the answer is
      // reported, never repaired into an outcome.
      expect(report.reason).toContain(kind.toUpperCase());
      expect(report.reason).toContain("the reading is " + kind);
      expect(report.refusals).toEqual([]);
      expect(await acceptedEvents(storeRoot)).toBe(0);
      expect(receiptCount(storeRoot)).toBe(0);
    }
  });

  it("reports an UNOPENABLE graph as unsettled instead of throwing", async () => {
    const { host } = await submittedAwaiting("host-derived-unopenable-", () =>
      declaredReading("done"),
    );
    const report = await host.settleFinishedAttempt("graph.not-declared-here", ATTEMPT_ID);
    expect(report.kind).toBe("unsettled");
    if (report.kind !== "unsettled") return;
    expect(report.reason).toContain("could not be opened");
    expect(report.refusals).toEqual([]);
  });
});

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
 *     the probe is the stable effect key the create carried.
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
  HostExecutionObservation,
} from "../../src/graph/host/outcome-host.ts";
import { HostExecutionIndex } from "../../src/graph/host/execution-index.ts";
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
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    return ledger.acceptedEvents(GRAPH_ID).length;
  } finally {
    ledger.close();
  }
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
    const refusal = sweep.effectRefusals.find(
      (candidate) => candidate.code === "completion-unsettled",
    );
    expect(refusal?.message).toContain("ENDED without reaching");
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
    expect(
      again.effectRefusals.some((refusal) => refusal.code === "completion-unsettled"),
    ).toBe(true);
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

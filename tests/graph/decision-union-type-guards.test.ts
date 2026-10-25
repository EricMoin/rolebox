
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type {
  AcceptanceDecision,
  AcceptanceJoin,
  AcceptedDecision,
  RejectedDecision,
} from "../../src/graph/outcome/acceptance.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import type { OutcomeAdvanceInput } from "../../src/graph/outcome/graph-state.ts";
import type {
  AcceptanceLedger,
  PendingEffectRecord,
} from "../../src/graph/ledger/types.ts";
import type {
  OutcomeRuntimeRefusal,
  OutcomeSubmissionResult,
} from "../../src/graph/outcome/runtime-contract.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { ledgerReadRefusal } from "../../src/graph/outcome/runtime-refusals.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { removeTempTree } from "./helpers/temp-dirs.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EFFECT_READ_FAILURE = "the effect ledger could not be read (F-25 probe)";

/** work -> ship: one successor edge, one terminal outcome. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "graph.decision-union.linear",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done" }],
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship it.",
      outcomes: [{ id: "delivered" }],
    },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/**
 * work (done -> ship, abandoned -> nothing) -> ship. Settling work on
 * `abandoned` strands `ship`, which the runtime records as its own
 * `unreachable-pending-node` stop — the shape a stopped run is reported from.
 */
const BRANCHING: GraphDeclarationV3 = {
  version: 3,
  name: "graph.decision-union.branching",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done" }, { id: "abandoned" }],
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship it.",
      outcomes: [{ id: "delivered" }],
    },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

const GATE_ID = "gate.decision-union";
const GATE_VERSION = 1;

/** One node whose `done` outcome carries a gate the registry answers. */
const GATED: GraphDeclarationV3 = {
  version: 3,
  name: "graph.decision-union.gated",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [
        { id: "done", acceptance: [{ validator: GATE_ID, version: GATE_VERSION }] },
      ],
    },
  ],
  edges: [],
};

// ── The breakable ledger ────────────────────────────────────────────────────

/** The graph-wide effect read, made controllable for one case. */
interface EffectReadControl {
  /** Let `allowed` graph-wide reads through, then fail every later one. */
  breakAfter(allowed: number): void;
  /** Stop failing. */
  heal(): void;
  /**
   * Answer a legitimate inventory that carries a `code` field — the value the
   * old `"code" in value` probe could not tell from a refusal.
   */
  serveCodeCarryingInventory(): void;
}

/**
 * An EMPTY, otherwise legitimate inventory that carries a `code` field.
 *
 * NO record list needs a `code` field, and none declares one — which is exactly
 * why a discriminant on the READING, not a probe into the value, is the only
 * discrimination a reader can rely on. The old sites asked `"code" in value`,
 * answered true here, and reported this valid inventory as the reader's refusal.
 */
const CODE_CARRYING_INVENTORY: readonly PendingEffectRecord[] & { readonly code: string } =
  Object.freeze(Object.assign([], { code: "not-a-refusal" }));

/**
 * The ledger a case drives, with its GRAPH-WIDE effect read breakable.
 *
 * The run-scoped read (`pendingEffects(graphId, runId)`) always delegates: only
 * the one call the five F-25 sites make is affected, so everything else on the
 * path is the real store. A refused arm is therefore the reader's own refusal
 * for one genuinely unreadable read, not a fabricated value.
 */
function breakableLedger(ledger: SqliteAcceptanceLedger): {
  readonly ledger: AcceptanceLedger;
  readonly control: EffectReadControl;
} {
  let allowed = Number.POSITIVE_INFINITY;
  let codeCarrying = false;
  const proxy: AcceptanceLedger = new Proxy(ledger, {
    get(target, property): unknown {
      if (property === "pendingEffects") {
        return (graphId: string, runId?: string): readonly PendingEffectRecord[] => {
          if (runId !== undefined) return target.pendingEffects(graphId, runId);
          if (allowed <= 0) throw new Error(EFFECT_READ_FAILURE);
          allowed -= 1;
          if (codeCarrying) return CODE_CARRYING_INVENTORY;
          return target.pendingEffects(graphId);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    ledger: proxy,
    control: {
      breakAfter: (count) => {
        allowed = count;
      },
      heal: () => {
        allowed = Number.POSITIVE_INFINITY;
      },
      serveCodeCarryingInventory: () => {
        codeCarrying = true;
      },
    },
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface GraphFixture {
  readonly runtime: OutcomeGraphRuntime;
  readonly ledger: SqliteAcceptanceLedger;
  readonly control: EffectReadControl;
  /** Every request the scripted dispatch seam received, in order. */
  readonly requests: OutcomeDispatchRequest[];
  readonly graphId: string;
  /** The credential the given attempt was dispatched with. */
  credentialOf(attemptId: string): string;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTempTree(root);
});

/** The credential one dispatched attempt was launched with. */
function credentialOf(
  requests: readonly OutcomeDispatchRequest[],
  attemptId: string,
): string {
  const request = requests.find((entry) => entry.attemptId === attemptId);
  if (request === undefined) {
    throw new Error("fixture: attempt " + attemptId + " was never dispatched");
  }
  return request.credential;
}

/** One started-able runtime over a real file ledger in a temp root. */
async function withGraph<T>(
  declaration: GraphDeclarationV3,
  fn: (fixture: GraphFixture) => T | Promise<T>,
  options: {
    readonly validators?: ValidatorRegistry;
    readonly supportedValidators?: readonly {
      readonly validator: string;
      readonly version?: number;
    }[];
  } = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "decision-union-"));
  roots.push(dir);
  const ledger = await SqliteAcceptanceLedger.create(dir);
  try {
    const declared = buildDeclaredOutcomeGraph({
      declaration,
      ...(options.supportedValidators === undefined
        ? {}
        : { supportedValidators: [...options.supportedValidators] }),
    });
    const requests: OutcomeDispatchRequest[] = [];
    const breakable = breakableLedger(ledger);
    const runtime = new OutcomeGraphRuntime({
      plan: declared.plan,
      ledger: breakable.ledger,
      dispatch: (request) => {
        requests.push(request);
      },
      validators: options.validators ?? createValidatorRegistry([]),
      artifactRoot: dir,
      credentialIsolation: testHostCredentialIsolation(dir),
      clock: () => NOW,
      mintCredential: (binding) =>
        "test-credential:" + binding.nodeId + "#" + binding.attemptId,
    });
    return await fn({
      runtime,
      ledger,
      control: breakable.control,
      requests,
      graphId: declared.graphId,
      credentialOf: (attemptId) => credentialOf(requests, attemptId),
    });
  } finally {
    ledger.close();
  }
}

/** The refusal the runtime reports for the broken graph-wide effect read. */
function effectReadRefusal(graphId: string): OutcomeRuntimeRefusal {
  return ledgerReadRefusal(graphId, new Error(EFFECT_READ_FAILURE));
}

/** Claim the current run's control fact, as a run-wide command does. */
function claimRunControl(ledger: SqliteAcceptanceLedger, graphId: string): void {
  const run = ledger.runs?.readRun(graphId);
  if (run === undefined) throw new Error("fixture: the graph holds no run identity");
  ledger.runs?.claimRunControl({
    graphId,
    runId: run.runId,
    command: "cancel",
    reason: "the F-25 probe stops the run",
    decidedAt: NOW + 1,
    decidedBy: Object.freeze({ sessionId: "session.probe", agentId: "agent.probe" }),
  });
}

/** Start one run and settle `work` on the outcome that strands `ship`. */
function stopOnStrandedShip(
  fixture: Pick<GraphFixture, "runtime" | "credentialOf">,
): void {
  expect(fixture.runtime.start(NOW).kind).toBe("started");
  const settled = fixture.runtime.submit(
    { nodeId: "work", outcomeId: "abandoned", credential: fixture.credentialOf("work#1") },
    NOW + 1,
  );
  expect(settled.kind).toBe("accepted");
  const stop = fixture.runtime.state()?.stop;
  expect(stop?.reason).toBe("unreachable-pending-node");
}

// ── F-12: the decision union ────────────────────────────────────────────────

describe("F-12: the decision is a discriminated union and an advance requires its accepted arm", () => {
  it("pins the two arms and the accepted-only advance input", () => {
    // The union is discriminated by its own literal `kind` field.
    expectTypeOf<AcceptanceDecision["kind"]>().toEqualTypeOf<"accepted" | "rejected">();
    expectTypeOf<
      Extract<AcceptanceDecision, { readonly kind: "accepted" }>
    >().toEqualTypeOf<AcceptedDecision>();
    expectTypeOf<
      Extract<AcceptanceDecision, { readonly kind: "rejected" }>
    >().toEqualTypeOf<RejectedDecision>();
    // The arms are DIFFERENT types: one interface with a union-typed field would
    // make these equal.
    expectTypeOf<AcceptedDecision>().not.toEqualTypeOf<RejectedDecision>();
    expectTypeOf<RejectedDecision>().not.toExtend<AcceptedDecision>();
    // The advance input and the acceptance join accept the ACCEPTED arm...
    expectTypeOf<AcceptedDecision>().toExtend<OutcomeAdvanceInput["decision"]>();
    expectTypeOf<OutcomeAdvanceInput["decision"]>().toEqualTypeOf<AcceptedDecision>();
    expectTypeOf<Parameters<AcceptanceJoin>[1]>().toEqualTypeOf<AcceptedDecision>();
    // ...and REJECT the rejected one: this pin fails on the pre-fix bytes, where
    // `OutcomeAdvanceInput["decision"]` was the whole union.
    expectTypeOf<RejectedDecision>().not.toExtend<OutcomeAdvanceInput["decision"]>();
    // The runtime's answers carry the arm their variant names.
    expectTypeOf<
      Extract<OutcomeSubmissionResult, { readonly kind: "accepted" }>["decision"]
    >().toEqualTypeOf<AcceptedDecision>();
    expectTypeOf<
      Extract<OutcomeSubmissionResult, { readonly kind: "rejected" }>["decision"]
    >().toEqualTypeOf<RejectedDecision>();
  });

  it("still advances the plan on an accepted decision", async () => {
    await withGraph(LINEAR, ({ runtime, ledger, graphId, credentialOf }) => {
      expect(runtime.start(NOW).kind).toBe("started");
      const result = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf("work#1") },
        NOW + 1,
      );
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") {
        throw new Error("fixture: the submission was not accepted");
      }
      expect(result.decision.kind).toBe("accepted");
      expect(result.replayed).toBe(false);
      // The advance is exactly the one the accepted arm describes: work settled
      // on its outcome and ship armed, with the accepted event committed.
      const work = result.state.nodes.find((node) => node.nodeId === "work");
      expect(work?.status).toBe("settled");
      expect(work?.outcomeId).toBe("done");
      const ship = result.state.nodes.find((node) => node.nodeId === "ship");
      expect(ship?.status).toBe("dispatched");
      expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
    });
  });

  it("still refuses a rejected decision at runtime, leaving the attempt open", async () => {
    await withGraph(
      GATED,
      ({ runtime, ledger, graphId, credentialOf }) => {
        expect(runtime.start(NOW).kind).toBe("started");
        const before = runtime.state();
        const result = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf("work#1") },
          NOW + 1,
        );
        expect(result.kind).toBe("rejected");
        if (result.kind !== "rejected") {
          throw new Error("fixture: the submission was not rejected");
        }
        expect(result.decision.kind).toBe("rejected");
        expect(result.receipt.decision).toBe("rejected");
        // THE GUARD THE FINDING NAMES: the acceptance transaction ran no join for
        // a rejected decision, so the state is the one `start` wrote, no accepted
        // event exists, and the attempt is still the one in flight.
        expect(runtime.state()).toEqual(before);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
      },
      {
        validators: createValidatorRegistry([
          {
            id: GATE_ID,
            version: GATE_VERSION,
            implementation: () => ({
              kind: "fail",
              reason: "the probe gate fails this submission",
            }),
          },
        ]),
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
      },
    );
  });
});

// ── F-25 remainder: the five effect-inventory readings ──────────────────────

describe("F-25: every effect-inventory site reads a declared discriminant", () => {
  it("site A — reexecute: the value arm reports the successor's inventory", async () => {
    await withGraph(BRANCHING, (fixture) => {
      const { runtime, ledger, graphId } = fixture;
      stopOnStrandedShip(fixture);
      const run = ledger.runs?.readRun(graphId);
      if (run === undefined) throw new Error("fixture: the graph holds no run identity");
      ledger.runs?.recordReexecution({
        graphId,
        runId: run.runId,
        reason: "the F-25 probe re-executes the terminal run",
        decidedAt: NOW + 2,
      });
      const reexecuted = runtime.reexecute(NOW + 3);
      expect(reexecuted.kind).toBe("reexecuted");
      if (reexecuted.kind !== "reexecuted") {
        throw new Error("fixture: the re-execution was refused");
      }
      expect(reexecuted.dispatched.length).toBeGreaterThan(0);
      expect(reexecuted.unsettledEffects).toEqual(ledger.pendingEffects(graphId));
      expect(reexecuted.unsettledEffects.length).toBeGreaterThan(0);
    });
  });

  it("site A — reexecute: the refused arm leaves the inventory empty, as before", async () => {
    await withGraph(BRANCHING, (fixture) => {
      const { runtime, ledger, graphId, control, credentialOf } = fixture;
      stopOnStrandedShip(fixture);
      const run = ledger.runs?.readRun(graphId);
      if (run === undefined) throw new Error("fixture: the graph holds no run identity");
      ledger.runs?.recordReexecution({
        graphId,
        runId: run.runId,
        reason: "the F-25 probe re-executes the terminal run",
        decidedAt: NOW + 2,
      });
      control.breakAfter(0);
      const reexecuted = runtime.reexecute(NOW + 3);
      expect(reexecuted.kind).toBe("reexecuted");
      if (reexecuted.kind !== "reexecuted") {
        throw new Error("fixture: the re-execution was refused");
      }
      // The site's own contract, preserved: an unreadable graph-wide inventory
      // leaves the report with an EMPTY inventory rather than failing the
      // re-execution the transaction already committed.
      expect(reexecuted.dispatched.length).toBeGreaterThan(0);
      expect(reexecuted.unsettledEffects).toEqual([]);
      expect(credentialOf("work#2").length).toBeGreaterThan(0);
    });
  });

  it("site B — resume, first execution: same value, same refusal", async () => {
    await withGraph(LINEAR, ({ runtime, graphId, control }) => {
      control.breakAfter(0);
      expect(runtime.resume(NOW)).toEqual({
        kind: "refused",
        refusals: [effectReadRefusal(graphId)],
      });
    });
    await withGraph(LINEAR, ({ runtime, ledger, graphId }) => {
      const started = runtime.resume(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") throw new Error("fixture: the run did not start");
      expect(started.dispatched.length).toBeGreaterThan(0);
      expect(started.unsettledEffects).toEqual(ledger.pendingEffects(graphId));
    });
  });

  it("site C — resume, controlled run: same value, same refusal", async () => {
    await withGraph(LINEAR, ({ runtime, ledger, graphId, control }) => {
      runtime.start(NOW);
      claimRunControl(ledger, graphId);
      control.breakAfter(0);
      expect(runtime.resume(NOW + 2)).toEqual({
        kind: "refused",
        refusals: [effectReadRefusal(graphId)],
      });
      control.heal();
      const resumed = runtime.resume(NOW + 3);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") throw new Error("fixture: the run was not resumed");
      expect(resumed.control?.command).toBe("cancel");
      expect(resumed.unsettledEffects).toEqual(ledger.pendingEffects(graphId));
      expect(resumed.unsettledEffects.length).toBeGreaterThan(0);
    });
  });

  it("site D — resume, stopped run: same value, same refusal", async () => {
    await withGraph(BRANCHING, (fixture) => {
      const { runtime, ledger, graphId, control } = fixture;
      stopOnStrandedShip(fixture);
      control.breakAfter(0);
      expect(runtime.resume(NOW + 2)).toEqual({
        kind: "refused",
        refusals: [effectReadRefusal(graphId)],
      });
      control.heal();
      const resumed = runtime.resume(NOW + 3);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") throw new Error("fixture: the run was not resumed");
      expect(resumed.stop?.reason).toBe("unreachable-pending-node");
      expect(resumed.unsettledEffects).toEqual(ledger.pendingEffects(graphId));
    });
  });

  it("site E — a value that CARRIES a `code` is still read as the value", async () => {
    await withGraph(LINEAR, ({ runtime, graphId, control }) => {
      runtime.start(NOW);
      control.serveCodeCarryingInventory();
      const resumed = runtime.resume(NOW + 2);
      // The pre-fix probe (`"code" in effects`) answered TRUE for this valid
      // inventory and reported a refusal that was in fact a record list, so this
      // case fails on the pre-fix bytes. The declared discriminant cannot move a
      // value into the refusal arm.
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") throw new Error("fixture: the run was not resumed");
      expect(resumed.unsettledEffects).toEqual(CODE_CARRYING_INVENTORY);
      expect(resumed.unsettledEffects).toHaveLength(0);
    });
  });

  it("site E — resume, ordinary reconciliation: same value, same refusal", async () => {
    await withGraph(LINEAR, ({ runtime, ledger, graphId, control }) => {
      runtime.start(NOW);
      // The reconciliation makes the FIRST graph-wide read; the site under test
      // is the SECOND, the one the reconciled report is built from.
      control.breakAfter(1);
      expect(runtime.resume(NOW + 2)).toEqual({
        kind: "refused",
        refusals: [effectReadRefusal(graphId)],
      });
      control.heal();
      const resumed = runtime.resume(NOW + 3);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") throw new Error("fixture: the run was not resumed");
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.unsettledEffects).toEqual(ledger.pendingEffects(graphId));
      expect(resumed.unsettledEffects.length).toBeGreaterThan(0);
    });
  });
});

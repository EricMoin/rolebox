/**
 * The unified dispatch-effect executor (D8) — regression tests.
 *
 * The third slice of the outcome protocol makes the FIRST dispatch, a SUCCESSOR
 * dispatch and a restart recovery run through ONE persisted effect path. These
 * tests pin the two defects that path exists to remove, each reproduced end to
 * end before the fix:
 *
 * 1. GAP 1 — a first dispatch whose create threw before delivery left a state
 *    that read `executing` and NO dispatch effect at all, so a restart
 *    dispatched nothing, refused nothing and merely reported an armed node: a
 *    silent zero. Now the intent is committed in the SAME transaction as the
 *    starting state, and a recovery either puts the row to the host's execution
 *    query or REPORTS it as \`dispatch-unreconciled\` work — never silence.
 * 2. GAP 2 — a successor dispatch that SUCCEEDED left its effect \`pending\`,
 *    so the next process created the same attempt a second time (call count
 *    1 -> 2). Now the row is marked \`started\` only after the create returned,
 *    and a restart resolves it without a second create.
 *
 * Also pinned here: the three host answers (\`absent\` / \`created\` /
 * \`unknown\`) drive three DIFFERENT actions, a second resume is idempotent, and
 * a production entry with no dispatch adapter REFUSES (\`dispatch-unavailable\`)
 * instead of running a no-op that would record dispatches nobody performed.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import {
  buildDeclaredOutcomeGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchAdapter,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeExecutionLookup,
} from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import { engineStateDir } from "../../src/graph/persistence/engine-persistence.ts";
import { OutcomeSubmissionRefusedError } from "../../src/graph/tools/submit-outcome.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { hasNoAcceptanceRecords } from "./helpers/acceptance-records.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

/** work -> ship: one successor edge, one terminal outcome. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "effects.linear",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/** One credential per attempt, derived from the binding the runtime hands it. */
const CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "effect-credential:" + binding.nodeId + "#" + binding.attemptId;

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

function planOf() {
  return buildDeclaredOutcomeGraph({ declaration: LINEAR }).plan;
}

/** The dispatch manager surface the sweep touches for a declared graph. */
function idleManager(): DispatchManager {
  const surface: Partial<DispatchManager> = {
    getTask: (_taskId: string): DispatchTask | undefined => undefined,
    getTasksByParent: () => [],
    getEventState: () => new Map(),
  };
  return surface as DispatchManager;
}

/** Every effect row of one graph, as \`effectId@status\` in ledger order. */
function effectRows(ledger: SqliteAcceptanceLedger, graphId: string): string[] {
  return ledger
    .pendingEffects(graphId)
    .map((effect) => effect.effectId + "@" + effect.status);
}

/**
 * A host whose \`lookup\` answer is scripted per call and whose \`create\`
 * counts every attempt, so a test can assert CALL COUNTS rather than trust the
 * runtime's own report. \`create\` may be told to throw (before or after the
 * execution exists) — the two halves of the crash window.
 */
function scriptedHost(options: {
  readonly onLookup?: (key: OutcomeDispatchEffectKey, call: number) => OutcomeExecutionLookup;
  readonly onCreate?: (request: OutcomeDispatchRequest, call: number) => void;
}) {
  const creates: OutcomeDispatchRequest[] = [];
  const lookups: OutcomeDispatchEffectKey[] = [];
  const host = {
    create: (request: OutcomeDispatchRequest): void => {
      creates.push(request);
      options.onCreate?.(request, creates.length);
    },
    lookup: (key: OutcomeDispatchEffectKey): OutcomeExecutionLookup => {
      lookups.push(key);
      return (
        options.onLookup?.(key, lookups.length) ?? { kind: "unknown" as const, reason: "no script" }
      );
    },
  };
  return { host, creates, lookups };
}

/** A plain seam that never answers the query, plus its create call log. */
function bareSeam(onCreate?: (request: OutcomeDispatchRequest, call: number) => void) {
  const creates: OutcomeDispatchRequest[] = [];
  const seam = (request: OutcomeDispatchRequest): void => {
    creates.push(request);
    onCreate?.(request, creates.length);
  };
  return { seam, creates };
}

/**
 * Build one runtime over a ledger; every option the suite needs.
 *
 * THIS FILE'S HOST DECLARES A PLATFORM-ISOLATED STORE, because its cases are
 * ABOUT restart re-delivery: each `runtimeOver` call is a separate host process
 * over the same store root, and one of them has to produce the credential the
 * other minted. The honest default (`durableCredentialStore: "none"`) keeps no
 * value on disk, which is what the shipped entries take and what the dedicated
 * boundary tests pin; a fixture that never restarts uses the default.
 */
function runtimeOver(
  dir: string,
  ledger: SqliteAcceptanceLedger,
  dispatch: OutcomeDispatchAdapter | undefined,
): OutcomeGraphRuntime {
  return new OutcomeGraphRuntime({
    plan: planOf(),
    ledger,
    ...(dispatch === undefined ? {} : { dispatch }),
    validators: createValidatorRegistry([]),
    artifactRoot: dir,
    clock: () => NOW,
    mintCredential: CREDENTIAL_SOURCE,
    credentialIsolation: testHostCredentialIsolation(dir, {
      durableCredentialStore: "platform-isolated",
    }),
  });
}

// ── GAP 1: a first dispatch that threw before delivery ──────────────────────

describe("D8 — a first dispatch that threw before delivery", () => {
  it("leaves a durable effect and a recovery REPORTS it instead of silently dispatching nothing", async () => {
    const dir = makeTmpDir("effects-gap1-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const breaking = bareSeam((_request, call) => {
        if (call === 1) throw new Error("seam exploded before delivery");
      });
      const first = runtimeOver(dir, ledger, breaking.seam);
      let startOutcome = "returned";
      try {
        first.start(NOW);
      } catch (error) {
        startOutcome = error instanceof Error ? error.message : String(error);
      }
      expect(startOutcome).toContain("seam exploded before delivery");

      const record = ledger.readGraphState(graphId);
      expect(record).toBeDefined();
      const body = record?.body as { phase?: string } | undefined;
      // The state committed with the intent in ONE transaction: the run reads
      // as executing AND the effect row exists.
      expect(body?.phase).toBe("executing");
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@pending"]);
      // Because the create THREW, the row was never marked started: a status is
      // a record of a create that returned, never a substitute for one.
      console.log(
        "[probe:d8-gap1] after failed start effects=" +
          JSON.stringify(effectRows(ledger, graphId)) +
          " seamCalls=" +
          breaking.creates.length,
      );

      // RESTART. The query cannot be answered (a bare seam), so the effect is
      // REPORTED for reconciliation — not launched, and not silently dropped.
      const restartedSeam = bareSeam();
      const restarted = runtimeOver(dir, ledger, restartedSeam.seam);
      const resumed = restarted.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.armed).toEqual([{ nodeId: "work", attemptId: "work#1" }]);
      expect(resumed.unsettledEffects.map((effect) => effect.effectId + "@" + effect.status)).toEqual(
        ["dispatch:work#1@pending"],
      );
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.reconciled).toEqual([]);
      // NOT a silent zero: the reason the effect was not launched is reported.
      expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
        "dispatch-unreconciled",
      ]);
      expect(restartedSeam.creates).toEqual([]);
      console.log(
        "[probe:d8-gap1] after resume dispatched=" +
          resumed.dispatched.length +
          " refusals=" +
          JSON.stringify(resumed.refusals.map((refusal) => refusal.code)) +
          " effects=" +
          JSON.stringify(effectRows(ledger, graphId)) +
          " seamCalls=" +
          restartedSeam.creates.length,
      );
      // The row is unmoved: nothing rewound it and nothing invented a create.
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@pending"]);
    } finally {
      ledger.close();
    }
  });

  it("creates the attempt EXACTLY ONCE when the host confirms the execution is absent", async () => {
    const dir = makeTmpDir("effects-gap1-absent-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      // The host refuses the first create before creating anything, and its
      // query answers the truth: no execution exists.
      const failing = scriptedHost({
        onLookup: () => ({ kind: "absent" }),
        onCreate: (_request, call) => {
          if (call === 1) throw new Error("host refused before creating");
        },
      });
      const first = runtimeOver(dir, ledger, failing.host);
      expect(() => first.start(NOW)).toThrow("host refused before creating");
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@pending"]);

      const resumed = first.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.dispatched.map((request) => request.attemptId)).toEqual(["work#1"]);
      expect(resumed.reconciled).toEqual([]);
      expect(resumed.refusals).toEqual([]);
      expect(resumed.unsettledEffects.map((effect) => effect.effectId + "@" + effect.status)).toEqual(
        ["dispatch:work#1@started"],
      );
      // ONE create overall: the throw, then the confirmed-absent create.
      expect(failing.creates.length).toBe(2);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);
    } finally {
      ledger.close();
    }
  });

  it("does NOT create again when the host reports the execution already exists", async () => {
    const dir = makeTmpDir("effects-gap1-created-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      // The crash window in its other half: the execution WAS created and the
      // process died before recording it, so the row is still pending.
      const createdThenDied = scriptedHost({
        onLookup: () => ({ kind: "created" }),
        onCreate: () => {
          throw new Error("the create returned, then the process died");
        },
      });
      const first = runtimeOver(dir, ledger, createdThenDied.host);
      expect(() => first.start(NOW)).toThrow();
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@pending"]);

      const resumed = first.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.reconciled).toEqual([
        { effectId: "dispatch:work#1", attemptId: "work#1", reason: "host-reported-created" },
      ]);
      expect(resumed.refusals).toEqual([]);
      expect(resumed.unsettledEffects.map((effect) => effect.effectId + "@" + effect.status)).toEqual(
        ["dispatch:work#1@started"],
      );
      // The create was issued ONCE, at start; the recovery only recorded it.
      expect(createdThenDied.creates.length).toBe(1);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);

      // A SECOND resume asks again, changes nothing, and creates nothing.
      const second = first.resume(NOW + 2);
      expect(second.kind).toBe("resumed");
      if (second.kind !== "resumed") return;
      expect(second.dispatched).toEqual([]);
      expect(second.reconciled).toEqual([
        { effectId: "dispatch:work#1", attemptId: "work#1", reason: "recorded-started" },
      ]);
      expect(createdThenDied.creates.length).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("does NOT create when the host cannot answer, and says so", async () => {
    const dir = makeTmpDir("effects-gap1-unknown-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const unsure = scriptedHost({
        onLookup: () => ({ kind: "unknown", reason: "the control plane is unreachable" }),
        onCreate: (_request, call) => {
          if (call === 1) throw new Error("ambiguous failure");
        },
      });
      const first = runtimeOver(dir, ledger, unsure.host);
      expect(() => first.start(NOW)).toThrow();

      const resumed = first.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.reconciled).toEqual([]);
      expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
        "dispatch-unreconciled",
      ]);
      expect(resumed.refusals[0]?.message).toContain("the control plane is unreachable");
      expect(resumed.unsettledEffects.map((effect) => effect.effectId + "@" + effect.status)).toEqual(
        ["dispatch:work#1@pending"],
      );
      // ONE create: the ambiguous failure. An unknown answer is never a launch.
      expect(unsure.creates.length).toBe(1);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@pending"]);
    } finally {
      ledger.close();
    }
  });
});

// ── GAP 2: a successor dispatch that succeeded ──────────────────────────────

describe("D8 — a successor dispatch that succeeded", () => {
  it("is never created a second time across a restart (call count stays 1)", async () => {
    const dir = makeTmpDir("effects-gap2-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const before = bareSeam();
      const runtime = runtimeOver(dir, ledger, before.seam);
      runtime.start(NOW);
      const workCredential = before.creates.find(
        (request) => request.attemptId === "work#1",
      )?.credential;
      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: workCredential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      // The successor was created in-process, and its effect says so.
      expect(before.creates.map((request) => request.attemptId)).toEqual([
        "work#1",
        "ship#2",
      ]);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:ship#2@started"]);
      console.log(
        "[probe:d8-gap2] before restart creates=" +
          before.creates.length +
          " ship#2Creates=" +
          before.creates.filter((request) => request.attemptId === "ship#2").length +
          " effects=" +
          JSON.stringify(effectRows(ledger, graphId)),
      );

      // RESTART. The effect is started, so the query is never even needed to
      // know a create returned: nothing may be created again.
      const after = bareSeam();
      const restarted = runtimeOver(dir, ledger, after.seam);
      const resumed = restarted.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(after.creates).toEqual([]);
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.reconciled).toEqual([
        { effectId: "dispatch:ship#2", attemptId: "ship#2", reason: "recorded-started" },
      ]);
      expect(resumed.refusals).toEqual([]);
      expect(resumed.armed).toEqual([{ nodeId: "ship", attemptId: "ship#2" }]);
      console.log(
        "[probe:d8-gap2] after restart creates=" +
          after.creates.length +
          " totalShip#2Creates=" +
          before.creates.filter((request) => request.attemptId === "ship#2").length +
          " effects=" +
          JSON.stringify(effectRows(ledger, graphId)) +
          " reconciled=" +
          JSON.stringify(resumed.reconciled.map((effect) => effect.reason)),
      );
      // THE ASSERTION THE DEFECT FAILED: one create for ship#2, not two.
      expect(
        before.creates.filter((request) => request.attemptId === "ship#2").length +
          after.creates.filter((request) => request.attemptId === "ship#2").length,
      ).toBe(1);
      // And the settled attempt's effect is DONE — a terminal graph owes the
      // recovery nothing.
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:ship#2@started"]);
    } finally {
      ledger.close();
    }
  });

  it("settles each attempt's dispatch effect with the attempt", async () => {
    const dir = makeTmpDir("effects-lifecycle-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const seam = bareSeam();
      const runtime = runtimeOver(dir, ledger, seam.seam);
      runtime.start(NOW);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);

      runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          credential: seam.creates.find((request) => request.attemptId === "work#1")?.credential,
        },
        NOW + 1,
      );
      // work#1 settled -> its effect is done; ship#2 is armed and started.
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:ship#2@started"]);

      const last = runtime.submit(
        {
          nodeId: "ship",
          outcomeId: "delivered",
          credential: seam.creates.find((request) => request.attemptId === "ship#2")?.credential,
        },
        NOW + 2,
      );
      expect(last.kind).toBe("accepted");
      expect(effectRows(ledger, graphId)).toEqual([]);
    } finally {
      ledger.close();
    }
  });
});

// ── No dispatcher, no run ───────────────────────────────────────────────────

describe("D8 — a production entry with no dispatch adapter refuses", () => {
  it("refuses start, resume and submit in the runtime and writes nothing", async () => {
    const dir = makeTmpDir("effects-noadapter-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const runtime = runtimeOver(dir, ledger, undefined);
      for (const result of [runtime.start(NOW), runtime.resume(NOW), runtime.submit({}, NOW)]) {
        expect(result.kind).toBe("refused");
        if (result.kind !== "refused") continue;
        expect(result.refusals.map((refusal) => refusal.code)).toEqual([
          "dispatch-unavailable",
        ]);
      }
      expect(ledger.readGraphState(graphId)).toBeUndefined();
      expect(effectRows(ledger, graphId)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("refuses the submission ingress before opening a ledger", async () => {
    const dir = makeTmpDir("effects-noadapter-ingress-");
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });

    let caught: unknown;
    try {
      await ts.graph_submit_outcome({
        graph_id: declared.graph_id,
        node_id: "work",
        outcome_id: "done",
        credential: "any-credential",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OutcomeSubmissionRefusedError);
    expect((caught as OutcomeSubmissionRefusedError).reason).toBe("dispatch-unavailable");
    // The refusal happened BEFORE the acceptance path was used. The store FILE
    // exists already — the fixture's host capability owns the same database
    // (P1 item 3) — so the honest check is that no acceptance record was
    // written for the declared graph.
    expect(await hasNoAcceptanceRecords(engineStateDir(dir), declared.graph_id)).toBe(true);
  });
});

/**
 * Host identity binding and restart reconciliation (stage D, slice 4).
 *
 * WHAT THIS FILE PINS. The three capabilities the host adapter surface already
 * carried — a protected credential store, per-attempt credential delivery
 * (D7), and the create-plus-lookup dispatch channel (D8) — are joined by a
 * fourth: the host's INVOCATION IDENTITY. When a host declares one, the runtime
 * records the identity it dispatched an attempt under on that attempt's own
 * state entry, and a submission that settles the attempt must come from the
 * SAME host attribution. The identity is an ADDITIONAL constraint on top of the
 * bearer credential, never a replacement, and the core protocol depends on no
 * host.
 *
 * Covered here, all through real calls:
 * - the binding round trip: write (dispatch) -> restart (new runtime, same
 *   ledger) -> read (the identity hydrates back) -> write (the settlement's
 *   successor is recorded under the submitting invocation);
 * - a mismatched identity is refused by name and NOTHING is written (no
 *   receipt, no event, no state change), and the attempt stays settleable by
 *   its own invocation;
 * - an attempt that recorded a binding cannot be settled without the check:
 *   a host answering no identity is `host-identity-absent`, a judging process
 *   with no capability is `host-identity-unavailable`, and an UNREADABLE
 *   capability refuses the operation before anything is read or written;
 * - an attempt dispatched under NO host identity is UNCONSTRAINED — the
 *   compatibility rule that keeps this addition from blocking any existing
 *   path — and a runtime with no capability at all behaves exactly as it did
 *   before the rule existed;
 * - restart reconciliation reports every local/host contradiction in
 *   `divergences` (host-created over local-pending; host-absent over
 *   local-started), never re-dispatches, never drops, and a SECOND recovery is
 *   idempotent;
 * - the ingress and the startup sweep refuse an unreadable capability BEFORE
 *   they open a ledger.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { engineStateDir } from "../../src/graph/persistence/engine-persistence.ts";
import {
  LEDGER_FILE_NAME,
  SqliteAcceptanceLedger,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import {
  HOST_IDENTITY_ABSENT_CODE,
  HOST_IDENTITY_MISMATCH_CODE,
  HOST_IDENTITY_UNAVAILABLE_CODE,
  equalHostInvocationIdentity,
  hostIdentityCheckRefusal,
  hostIdentityRefusal,
  readCurrentHostIdentity,
  readHostIdentityCapability,
  readHostInvocationIdentity,
  type HostIdentityCapability,
  type HostInvocationIdentity,
} from "../../src/graph/outcome/host-identity.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeExecutionLookup,
} from "../../src/graph/outcome/dispatch-effects.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchAdapter,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { OutcomeSubmissionRefusedError } from "../../src/graph/tools/submit-outcome.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { testHostIdentity } from "./helpers/host-identity.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

/** work -> ship: one entry attempt, one successor attempt. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "host-identity.linear",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/** Two DISTINCT host invocations: same agent, different sessions. */
const ALICE: HostInvocationIdentity = Object.freeze({
  sessionId: "session-alice",
  agentId: "agent.work",
});
const BOB: HostInvocationIdentity = Object.freeze({
  sessionId: "session-bob",
  agentId: "agent.work",
});

/** One credential per attempt, derived from the binding the runtime hands it. */
const CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "identity-credential:" + binding.nodeId + "#" + binding.attemptId;

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

/**
 * A host whose `lookup` answer is scripted per call and whose `create` records
 * every request, so a test can assert CALL COUNTS rather than trust the
 * runtime's own report.
 */
function scriptedHost(options: {
  readonly onLookup?: (key: OutcomeDispatchEffectKey, call: number) => OutcomeExecutionLookup;
  readonly onCreate?: (request: OutcomeDispatchRequest, call: number) => void;
}) {
  const creates: OutcomeDispatchRequest[] = [];
  const lookups: OutcomeDispatchEffectKey[] = [];
  const host: OutcomeDispatchAdapter = {
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

/** A bare seam that creates (recording requests) but cannot be queried. */
function bareSeam(onCreate?: (request: OutcomeDispatchRequest, call: number) => void) {
  const creates: OutcomeDispatchRequest[] = [];
  const seam = (request: OutcomeDispatchRequest): void => {
    creates.push(request);
    onCreate?.(request, creates.length);
  };
  return { seam, creates };
}

/** Build one runtime over a ledger; identity and dispatch are the variables. */
function runtimeOver(
  dir: string,
  ledger: SqliteAcceptanceLedger,
  dispatch: OutcomeDispatchAdapter | undefined,
  hostIdentity?: HostIdentityCapability,
): OutcomeGraphRuntime {
  return new OutcomeGraphRuntime({
    plan: planOf(),
    ledger,
    ...(dispatch === undefined ? {} : { dispatch }),
    validators: createValidatorRegistry([]),
    artifactRoot: dir,
    clock: () => NOW,
    mintCredential: CREDENTIAL_SOURCE,
    // This file's restart cases compare two host PROCESSES over one store
    // root, so the credential the first minted has to survive: the fixture
    // declares a platform-isolated store. The shipped entries keep the honest
    // default (`"none"`), and the boundary tests pin that.
    credentialIsolation: testHostCredentialIsolation(dir, {
      durableCredentialStore: "platform-isolated",
    }),
    ...(hostIdentity === undefined ? {} : { hostIdentity }),
  });
}

/** Every effect row of one graph, as `effectId@status` in ledger order. */
function effectRows(ledger: SqliteAcceptanceLedger, graphId: string): string[] {
  return ledger
    .pendingEffects(graphId)
    .map((effect) => effect.effectId + "@" + effect.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The persisted state BODY one graph, as the raw record. */
function bodyOf(ledger: SqliteAcceptanceLedger, graphId: string): Record<string, unknown> {
  const record = ledger.readGraphState(graphId);
  if (record === undefined) throw new Error("fixture: the state row is missing");
  if (!isRecord(record.body)) throw new Error("fixture: the state body is not a record");
  return record.body;
}

/** One persisted node entry, by node id. */
function nodeEntryOf(
  body: Record<string, unknown>,
  nodeId: string,
): Record<string, unknown> {
  const nodes = body.nodes;
  if (!Array.isArray(nodes)) throw new Error("fixture: the body carries no nodes");
  for (const entry of nodes) {
    if (isRecord(entry) && entry.nodeId === nodeId) return entry;
  }
  throw new Error("fixture: no node entry for " + nodeId);
}

/** The credential one dispatched attempt carried, failing when it never ran. */
function credentialOf(
  requests: readonly OutcomeDispatchRequest[],
  attemptId: string,
): string {
  const found = requests.find((request) => request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: no dispatch request for attempt " +
        attemptId +
        " (dispatched: " +
        requests.map((request) => request.attemptId).join(", ") +
        ")",
    );
  }
  return found.credential;
}

// ── The capability reader (unit) ────────────────────────────────────────────

describe("D9 — the host identity capability is read strictly, and absence is legal", () => {
  it("accepts exactly a version-1 { version, id, current } capability", () => {
    const good = {
      version: 1 as const,
      id: "host:identity",
      current: () => ALICE,
    };
    const read = readHostIdentityCapability(good);
    expect(read).toBeDefined();
    expect(read?.id).toBe("host:identity");
    expect(read?.current()).toEqual(ALICE);
    // Deeply frozen, like every other capability value this build reads.
    expect(Object.isFrozen(read)).toBe(true);

    // The identity reader is equally strict about its own shape.
    expect(readHostInvocationIdentity({ sessionId: "s", agentId: "a" })).toEqual({
      sessionId: "s",
      agentId: "a",
    });
    expect(readHostInvocationIdentity({ sessionId: "s" })).toBeUndefined();
    expect(readHostInvocationIdentity({ sessionId: "s", agentId: "" })).toBeUndefined();
    expect(readHostInvocationIdentity({ sessionId: "s", agentId: "a", extra: 1 })).toBeUndefined();
    expect(readHostInvocationIdentity("session")).toBeUndefined();
  });

  it("refuses every declaration it cannot read instead of downgrading it", () => {
    for (const bad of [
      { version: 2, id: "host", current: () => ALICE },
      { version: 1, id: "", current: () => ALICE },
      { version: 1, id: "host", current: "not-a-function" },
      { version: 1, id: "host", current: () => ALICE, extra: true },
      { version: 1, current: () => ALICE },
      null,
      "host",
    ]) {
      expect(readHostIdentityCapability(bad)).toBeUndefined();
      const refusal = hostIdentityRefusal(bad);
      expect(refusal?.code).toBe(HOST_IDENTITY_UNAVAILABLE_CODE);
    }
    // ABSENT is not malformed: no capability means no constraint.
    expect(hostIdentityRefusal(undefined)).toBeUndefined();
    expect(readCurrentHostIdentity(undefined)).toEqual({ kind: "absent" });
    // A readable capability that answers NO identity says so, and does not throw.
    const silent = readCurrentHostIdentity({
      version: 1,
      id: "host",
      current: () => undefined,
    });
    expect(silent).toEqual({ kind: "none" });
    // A host that answers a NON-identity is refused, never treated as "none".
    const malformed = readCurrentHostIdentity({
      version: 1,
      id: "host",
      current: () => ({ sessionId: "s" }),
    });
    expect(malformed.kind).toBe("refused");
    if (malformed.kind === "refused") {
      expect(malformed.refusal.code).toBe(HOST_IDENTITY_UNAVAILABLE_CODE);
    }
    // A host that THROWS is likewise refused, not treated as "none".
    const throwing = readCurrentHostIdentity({
      version: 1,
      id: "host",
      current: () => {
        throw new Error("identity index unreachable");
      },
    });
    expect(throwing.kind).toBe("refused");
    if (throwing.kind === "refused") {
      expect(throwing.refusal.message).toContain("identity index unreachable");
    }
  });

  it("leaves an attempt that recorded NO identity unconstrained, whatever the host now says", () => {
    // The compatibility rule in one assertion: the reference is the DISPATCH
    // record, so no reading can constrain an attempt that recorded none.
    for (const reading of [
      { kind: "absent" as const },
      { kind: "none" as const },
      { kind: "identified" as const, identity: BOB },
      {
        kind: "refused" as const,
        refusal: {
          code: HOST_IDENTITY_UNAVAILABLE_CODE,
          path: "$.hostIdentity",
          message: "unreadable",
        },
      },
    ]) {
      expect(hostIdentityCheckRefusal(undefined, reading)).toBeUndefined();
    }
    expect(equalHostInvocationIdentity(ALICE, { ...ALICE })).toBe(true);
    expect(equalHostInvocationIdentity(ALICE, BOB)).toBe(false);
    expect(equalHostInvocationIdentity(undefined, undefined)).toBe(false);
  });
});

// ── The binding round trip ──────────────────────────────────────────────────

describe("D9 — an attempt is bound to the invocation that dispatched it", () => {
  it("records the dispatching identity, survives a restart, and arms the successor under the submitter", async () => {
    const dir = makeTmpDir("host-identity-roundtrip-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;

      // WRITE: one dispatch under ALICE.
      const alice = testHostIdentity(ALICE);
      const firstHost = scriptedHost({});
      const first = runtimeOver(dir, ledger, firstHost.host, alice.capability);
      const started = first.start(NOW);
      expect(started.kind).toBe("started");
      // The host was asked ONCE for the whole operation, not once per attempt.
      expect(alice.reads).toBe(1);
      const credential = credentialOf(firstHost.creates, "work#1");
      expect(nodeEntryOf(bodyOf(ledger, graphId), "work").dispatchIdentity).toEqual(ALICE);

      // RESTART: a new process over the same ledger. Recovery carries the
      // attempt's OWN record and never asks the host to re-bind it.
      const restartedHost = testHostIdentity(ALICE);
      const secondHost = scriptedHost({
        onLookup: () => ({ kind: "created" as const }),
      });
      const second = runtimeOver(
        dir,
        ledger,
        secondHost.host,
        restartedHost.capability,
      );
      const resumed = second.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(restartedHost.reads).toBe(0);
      expect(resumed.dispatched).toEqual([]);
      expect(secondHost.creates).toEqual([]);
      // The row was already `started` and the host agrees: no contradiction.
      expect(resumed.divergences).toEqual([]);
      expect(resumed.reconciled).toEqual([
        {
          effectId: "dispatch:work#1",
          attemptId: "work#1",
          reason: "recorded-started",
        },
      ]);

      // READ: the binding survives the restart on the hydrated state.
      const read = second.state();
      expect(read?.nodes.find((node) => node.nodeId === "work")?.dispatchIdentity).toEqual(
        ALICE,
      );

      // WRITE AGAIN: the settlement settles work and arms ship, recorded under
      // the invocation that submitted.
      const accepted = second.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 2,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;
      expect(accepted.dispatched.map((request) => request.attemptId)).toEqual(["ship#2"]);
      expect(restartedHost.reads).toBe(1);
      expect(nodeEntryOf(bodyOf(ledger, graphId), "ship").dispatchIdentity).toEqual(ALICE);
    } finally {
      ledger.close();
    }
  });

  it("refuses a submission from another invocation and writes NOTHING", async () => {
    const dir = makeTmpDir("host-identity-mismatch-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const host = testHostIdentity(ALICE);
      const seam = scriptedHost({});
      const runtime = runtimeOver(dir, ledger, seam.host, host.capability);
      runtime.start(NOW);
      const credential = credentialOf(seam.creates, "work#1");
      const before = ledger.readGraphState(graphId);

      // A DIFFERENT host invocation presents the same bearer credential.
      host.set(BOB);
      const refusedResult = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 1,
      );
      expect(refusedResult.kind).toBe("refused");
      if (refusedResult.kind !== "refused") return;
      expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
        HOST_IDENTITY_MISMATCH_CODE,
      ]);
      expect(refusedResult.refusals[0]?.message).toContain(ALICE.sessionId);
      expect(refusedResult.refusals[0]?.message).toContain(BOB.sessionId);
      // Nothing was written: no receipt, no accepted event, no state change.
      expect(ledger.acceptedEvents(graphId)).toEqual([]);
      expect(ledger.readGraphState(graphId)).toEqual(before);

      // The attempt is still in flight, and its OWN invocation still settles it.
      host.set(ALICE);
      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 2,
      );
      expect(accepted.kind).toBe("accepted");
    } finally {
      ledger.close();
    }
  });

  it("refuses a recorded binding the current invocation cannot be verified against", async () => {
    const dir = makeTmpDir("host-identity-unverifiable-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const host = testHostIdentity(ALICE);
      const seam = scriptedHost({});
      const runtime = runtimeOver(dir, ledger, seam.host, host.capability);
      runtime.start(NOW);
      const credential = credentialOf(seam.creates, "work#1");

      // (a) the host answers NO identity for this invocation.
      host.set(undefined);
      const absent = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 1,
      );
      expect(absent.kind).toBe("refused");
      if (absent.kind === "refused") {
        expect(absent.refusals.map((refusal) => refusal.code)).toEqual([
          HOST_IDENTITY_ABSENT_CODE,
        ]);
      }

      // (b) the judging process holds NO capability at all: an attempt that
      // recorded a binding is never settled without the check.
      const unboundProcess = runtimeOver(dir, ledger, scriptedHost({}).host);
      const noCapability = unboundProcess.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 2,
      );
      expect(noCapability.kind).toBe("refused");
      if (noCapability.kind === "refused") {
        expect(noCapability.refusals.map((refusal) => refusal.code)).toEqual([
          HOST_IDENTITY_UNAVAILABLE_CODE,
        ]);
        expect(noCapability.refusals[0]?.message).toContain(ALICE.sessionId);
      }
      expect(ledger.acceptedEvents(planOf().graphId)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("leaves an attempt dispatched under NO identity unconstrained, and binds only the successors", async () => {
    const dir = makeTmpDir("host-identity-none-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      // The host declares the capability but has no identity for the dispatch.
      const host = testHostIdentity(undefined);
      const seam = scriptedHost({});
      const runtime = runtimeOver(dir, ledger, seam.host, host.capability);
      runtime.start(NOW);
      const credential = credentialOf(seam.creates, "work#1");
      // Absence is recorded as absence: no field is invented.
      expect(nodeEntryOf(bodyOf(ledger, graphId), "work").dispatchIdentity).toBeUndefined();

      // A DIFFERENT invocation may settle it: there is no binding to violate,
      // which is exactly the behavior every existing path had.
      host.set(BOB);
      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      // The attempt THIS submission armed is bound to the submitting invocation.
      expect(nodeEntryOf(bodyOf(ledger, graphId), "ship").dispatchIdentity).toEqual(BOB);
    } finally {
      ledger.close();
    }
  });

  it("keeps every path unchanged when the host declares no identity capability", async () => {
    const dir = makeTmpDir("host-identity-absent-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      const seam = scriptedHost({});
      const runtime = runtimeOver(dir, ledger, seam.host);
      expect(runtime.start(NOW).kind).toBe("started");
      const credential = credentialOf(seam.creates, "work#1");
      expect(nodeEntryOf(bodyOf(ledger, graphId), "work").dispatchIdentity).toBeUndefined();

      const resumed = runtime.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.divergences).toEqual([]);

      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 2,
      );
      expect(accepted.kind).toBe("accepted");
      expect(nodeEntryOf(bodyOf(ledger, graphId), "ship").dispatchIdentity).toBeUndefined();
    } finally {
      ledger.close();
    }
  });
});

// ── An unreadable capability refuses the operation ──────────────────────────

describe("D9 — an unreadable capability refuses instead of running unconstrained", () => {
  const UNREADABLE: readonly unknown[] = [
    { version: 2, id: "host", current: () => ALICE },
    { version: 1, id: "", current: () => ALICE },
    { version: 1, id: "host", current: "not-a-function" },
    { version: 1, id: "host", current: () => ALICE, extra: true },
  ];

  it("refuses start, resume and submit in the runtime and writes nothing", async () => {
    for (const bad of UNREADABLE) {
      const dir = makeTmpDir("host-identity-bad-");
      const ledger = await SqliteAcceptanceLedger.create(dir);
      try {
        const runtime = runtimeOver(
          dir,
          ledger,
          scriptedHost({}).host,
          bad as HostIdentityCapability,
        );
        for (const result of [runtime.start(NOW), runtime.resume(NOW), runtime.submit({}, NOW)]) {
          expect(result.kind).toBe("refused");
          if (result.kind === "refused") {
            expect(result.refusals.map((refusal) => refusal.code)).toEqual([
              HOST_IDENTITY_UNAVAILABLE_CODE,
            ]);
          }
        }
        // The gate ran before any read or write: no state row exists at all.
        expect(ledger.readGraphState(planOf().graphId)).toBeUndefined();
      } finally {
        ledger.close();
      }
    }
  });

  it("refuses the ingress and the sweep before opening a ledger", async () => {
    const workspace = makeTmpDir("host-identity-ingress-");
    const ts = createGraphToolSet({
      stateDir: workspace,
      outcomeNow: NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(workspace)),
      outcomeDispatch: scriptedHost({}).host,
      hostIdentity: { version: 1, id: "host", current: "not-a-function" } as unknown as HostIdentityCapability,
    });
    const declared = ts.graph_declare({ declaration: LINEAR });

    let caught: unknown;
    try {
      await ts.graph_submit_outcome({
        graph_id: declared.graph_id,
        node_id: "work",
        outcome_id: "done",
        credential: "credential:work#work#1",
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof OutcomeSubmissionRefusedError)) {
      throw new Error("expected OutcomeSubmissionRefusedError, got " + String(caught));
    }
    expect(caught.reason).toBe("host-identity-unavailable");
    expect(caught.message).toContain(HOST_IDENTITY_UNAVAILABLE_CODE);
    // NOTHING was opened: the refusal precedes SqliteAcceptanceLedger.create.
    expect(existsSync(join(engineStateDir(workspace), LEDGER_FILE_NAME))).toBe(false);
  });

});

// ── Restart reconciliation reports its disagreements ────────────────────────

describe("D9 — restart reconciliation reports every local/host divergence", () => {
  it("reports host-created over local-pending, reconciles it, and never re-creates it", async () => {
    const dir = makeTmpDir("host-identity-divergence-created-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      // The first create throws AFTER the intent committed: the row stays
      // pending, which is the crash window the recovery has to resolve.
      const breaking = bareSeam((_request, call) => {
        if (call === 1) throw new Error("host refused before creating");
      });
      const first = runtimeOver(
        dir,
        ledger,
        breaking.seam,
        testHostIdentity(ALICE).capability,
      );
      expect(() => first.start(NOW)).toThrow("host refused before creating");
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@pending"]);

      // RESTART: the host reports the execution ALREADY EXISTS.
      const host = scriptedHost({ onLookup: () => ({ kind: "created" as const }) });
      const restarted = runtimeOver(
        dir,
        ledger,
        host.host,
        testHostIdentity(ALICE).capability,
      );
      const resumed = restarted.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.divergences).toEqual([
        {
          effectId: "dispatch:work#1",
          attemptId: "work#1",
          local: "pending",
          host: "created",
          resolution: "reconciled-started",
        },
      ]);
      expect(host.creates).toEqual([]);
      expect(resumed.dispatched).toEqual([]);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);

      // SECOND RECOVERY IS IDEMPOTENT: the rows now AGREE, nothing is
      // re-created, and the same fact is not reported as a fresh divergence.
      const again = restarted.resume(NOW + 2);
      expect(again.kind).toBe("resumed");
      if (again.kind !== "resumed") return;
      expect(again.divergences).toEqual([]);
      expect(again.dispatched).toEqual([]);
      expect(host.creates).toEqual([]);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);
    } finally {
      ledger.close();
    }
  });

  it("reports local-started against host-absent, changes nothing, and stays idempotent", async () => {
    const dir = makeTmpDir("host-identity-divergence-absent-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graphId = planOf().graphId;
      // A create that RETURNED: the row is genuinely `started` on disk.
      const first = runtimeOver(
        dir,
        ledger,
        scriptedHost({}).host,
        testHostIdentity(ALICE).capability,
      );
      expect(first.start(NOW).kind).toBe("started");
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);

      // The host contradicts the record: no execution exists for that id.
      const host = scriptedHost({ onLookup: () => ({ kind: "absent" as const }) });
      const restarted = runtimeOver(
        dir,
        ledger,
        host.host,
        testHostIdentity(ALICE).capability,
      );
      const before = ledger.readGraphState(graphId);
      const resumed = restarted.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.divergences).toEqual([
        {
          effectId: "dispatch:work#1",
          attemptId: "work#1",
          local: "started",
          host: "absent",
          resolution: "reported-unreconciled",
        },
      ]);
      expect(resumed.refusals.map((refusal) => refusal.code)).toContain(
        "dispatch-unreconciled",
      );
      // NOT re-created and NOT rewound.
      expect(host.creates).toEqual([]);
      expect(effectRows(ledger, graphId)).toEqual(["dispatch:work#1@started"]);
      expect(ledger.readGraphState(graphId)).toEqual(before);

      // The contradiction persists until a host fact resolves it, so a second
      // recovery reports it again — and still writes nothing.
      const again = restarted.resume(NOW + 2);
      expect(again.kind).toBe("resumed");
      if (again.kind !== "resumed") return;
      expect(again.divergences).toEqual(resumed.divergences);
      expect(host.creates).toEqual([]);
      expect(ledger.readGraphState(graphId)).toEqual(before);
    } finally {
      ledger.close();
    }
  });
});

/**
 * THE HOST BOUNDARY, pinned against the three defects that were reproduced
 * against the previous shape.
 *
 * The previous host layer kept an in-memory set and rewrote one JSON file, and
 * its capability declared `protectedCredentialStore: true` while the file was a
 * plain same-account read. Each case below is one of the reproductions, turned
 * into a regression test over the CURRENT host layer:
 *
 * 1. a same-account read of the whole host root yields NO credential value (the
 *    attempt's record is durable, the value is not), and the capability says so
 *    instead of claiming a store this build cannot protect;
 * 2. two host instances over one root cannot both create the same effect, and a
 *    crash inside the create window dispatches EXACTLY ONCE — with the three
 *    registry states (`pending` / `creating` / `created`) distinguishable at
 *    every step;
 * 3. instances writing interleaved records do not lose each other's rows (the
 *    whole-file-overwrite data loss), and a recovery that cannot produce a
 *    credential reports the attempt as not-retained rather than inventing one.
 *
 * A FOURTH CASE, added by the P0 convergence work, is the fifth counterexample
 * of the previous review round: a completion that arrives after a restart. The
 * completion bridge keeps its bindings in process memory, so a second host over
 * the same durable root reports the completion UNBOUND; the case pins that
 * honest fact — and the two things NOT fabricated — instead of claiming a
 * recovery this build does not have. Its section comment states which
 * acceptance-matrix entries stay open.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { HostCredentialVault } from "../../src/graph/host/credential-vault.ts";
import { HostOutcomeDispatch } from "../../src/graph/host/dispatch-host.ts";
import {
  HostExecutionIndex,
  hostExecutionNotCreated,
} from "../../src/graph/host/execution-index.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  dispatchEffectKeyOf,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
} from "../../src/graph/policy/completion-policy.ts";

const GRAPH_ID = "graph.host-boundary";
const WORK = { graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" } as const;
const REQUEST: OutcomeDispatchRequest = {
  graphId: GRAPH_ID,
  planRevision: "rev-1",
  nodeId: "work",
  attemptId: "work#1",
  agent: "agent.work",
  prompt: "Do the work.",
  credential: "cred-work-1",
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

describe("host boundary — the reproduced defects stay closed", () => {
  it("a same-account read of the whole host root yields no credential value", () => {
    const dir = makeTmpDir("host-boundary-read-");
    const vault = HostCredentialVault.open({ root: dir });
    const alpha = { graphId: GRAPH_ID, nodeId: "alpha", attemptId: "alpha#1" };
    const beta = { graphId: GRAPH_ID, nodeId: "beta", attemptId: "beta#1" };
    const alphaCredential = vault.mint({ ...alpha, planRevision: "rev-1", permission: "submit-outcome" });
    const betaCredential = vault.mint({ ...beta, planRevision: "rev-1", permission: "submit-outcome" });
    expect(alphaCredential).not.toBe(betaCredential);

    // POSITIVE CONTROL: the vault DOES hold the values for their own attempts,
    // so a clean reading below is evidence rather than a broken fixture.
    expect(vault.resolve(alpha)).toBe(alphaCredential);
    expect(vault.resolve(beta)).toBe(betaCredential);

    // THE READ: every byte of every file the host root holds. The previous
    // shape leaked BOTH credentials to exactly this read.
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(join(dir, file), "utf8");
      expect(bytes).not.toContain(alphaCredential);
      expect(bytes).not.toContain(betaCredential);
    }

    // A RESTART sees both attempts (the mapping is durable) and neither value;
    // the capability states the durable-store position instead of claiming a
    // protection this build cannot provide.
    const restarted = HostCredentialVault.open({ root: dir });
    expect(restarted.durableRecord(alpha)).toBe("not-retained");
    expect(restarted.durableRecord(beta)).toBe("not-retained");
    expect(restarted.resolve(alpha)).toBeUndefined();
    expect(restarted.resolve(beta)).toBeUndefined();
    const capability = restarted.capability();
    expect(capability.durableCredentialStore).toBe("none");
    // THE FALSE CLAIM IS GONE: nothing in this capability asserts a protected
    // credential store — the previous shape's `protectedCredentialStore: true`
    // was the statement a plain same-account read contradicted.
    expect(JSON.stringify(capability)).not.toContain("protectedCredentialStore");
  });

  it("two instances plus a crash window dispatch exactly once, with three states", () => {
    const dir = makeTmpDir("host-boundary-crash-");
    const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
    const deliveries: string[] = [];
    const registryA = HostExecutionIndex.open({ root: dir, ownerId: "host-a" });
    const registryB = HostExecutionIndex.open({ root: dir, ownerId: "host-b" });
    const owner = new HostOutcomeDispatch({
      executions: registryA,
      deliver: () => {
        deliveries.push("host-a");
      },
    });
    const other = new HostOutcomeDispatch({
      executions: registryB,
      deliver: () => {
        deliveries.push("host-b");
      },
    });

    // STATE 1 — pending: the create right is held and nothing is with the
    // platform, so no execution can exist yet.
    expect(registryA.claim(effect).kind).toBe("claimed");
    expect(registryA.read(effect)?.state).toBe("pending");
    // The other instance may not create while the right is held.
    expect(other.lookup(effect).kind).toBe("unknown");
    expect(() => other.create(REQUEST, effect)).toThrow();
    // The holder gives the right back — with a PROOF that nothing was created
    // (the store refuses a release without one) — and runs the real create path.
    expect(
      registryA.release(
        effect,
        "host-a",
        hostExecutionNotCreated("fixture: the holder withdrew before handing anything over"),
      ),
    ).toBe(true);

    // THE CRASH WINDOW: host-a hands the request over and dies before the
    // platform names the execution. Exactly ONE dispatch happened.
    owner.create(REQUEST, effect);
    expect(registryA.read(effect)?.state).toBe("creating");
    expect(deliveries).toEqual(["host-a"]);

    // STATE 2 — creating: every later reader is told the result is UNKNOWN, and
    // no instance creates a second execution.
    const afterCrash = other.lookup(effect);
    expect(afterCrash.kind).toBe("unknown");
    expect(() => other.create(REQUEST, effect)).toThrow();
    const reopened = new HostOutcomeDispatch({
      executions: HostExecutionIndex.open({ root: dir, ownerId: "host-c" }),
      deliver: () => {
        deliveries.push("host-c");
      },
    });
    expect(reopened.lookup(effect).kind).toBe("unknown");
    expect(() => reopened.create(REQUEST, effect)).toThrow();
    expect(deliveries).toEqual(["host-a"]);

    // STATE 3 — created: the platform names the execution, and only the CLAIM
    // that handed the request over may record it. The recovered instance
    // (host-c, which never held this claim) is REFUSED by the store's
    // conditional update — the G1 defect's adapter-level fence — and the stale
    // attempt is recorded on the row instead of being silently dropped.
    expect(reopened.confirmStarted(effect, { executionId: "dsh-run-42" })).toBe(false);
    expect(reopened.lookup(effect).kind).toBe("unknown");
    expect(owner.confirmStarted(effect, { executionId: "dsh-run-42" })).toBe(true);
    expect(reopened.lookup(effect).kind).toBe("created");
    const row = HostExecutionIndex.open({ root: dir, ownerId: "host-d" }).read(effect);
    expect(row?.state).toBe("created");
    expect(row?.execution?.executionId).toBe("dsh-run-42");
    expect(row?.ownerId).toBe("host-a");
    expect(row?.refused?.kind).toBe("stale-confirmation");
    expect(row?.refused?.ownerId).toBe("host-c");
    expect(row?.refused?.executionId).toBe("dsh-run-42");
    expect(row?.refused?.count).toBe(1);
  });

  it("a delivery that threw frees the right, so the next instance creates exactly once", () => {
    const dir = makeTmpDir("host-boundary-refused-");
    const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
    const deliveries: string[] = [];
    const failing = new HostOutcomeDispatch({
      executions: HostExecutionIndex.open({ root: dir, ownerId: "host-a" }),
      deliver: () => {
        deliveries.push("host-a");
        throw new Error("the platform refused before starting anything");
      },
    });
    const next = new HostOutcomeDispatch({
      executions: HostExecutionIndex.open({ root: dir, ownerId: "host-b" }),
      deliver: () => {
        deliveries.push("host-b");
      },
    });

    expect(() => failing.create(REQUEST, effect)).toThrow();
    // The execution demonstrably did not start: the effect is absent again, and
    // the OTHER instance is the one create.
    expect(next.lookup(effect).kind).toBe("absent");
    next.create(REQUEST, effect);
    expect(deliveries).toEqual(["host-a", "host-b"]);
    expect(next.confirmStarted(effect, { executionId: "dsh-run-1" })).toBe(true);
    expect(next.lookup(effect).kind).toBe("created");

    // THE CLAIM THAT WAS RELEASED CANNOT COME BACK: its owner holds no claim any
    // more, so a late confirmation of a different execution is fenced and
    // recorded rather than binding a second execution to next's row.
    expect(failing.confirmStarted(effect, { executionId: "dsh-run-0" })).toBe(false);
    const row = HostExecutionIndex.open({ root: dir, ownerId: "host-e" }).read(effect);
    expect(row?.state).toBe("created");
    expect(row?.ownerId).toBe("host-b");
    expect(row?.execution?.executionId).toBe("dsh-run-1");
    expect(row?.refused?.kind).toBe("stale-confirmation");
    expect(row?.refused?.ownerId).toBe("host-a");
    expect(row?.refused?.executionId).toBe("dsh-run-0");
    expect(row?.refused?.count).toBe(1);
  });

  it("interleaved instances lose neither credential values nor their mapping", () => {
    const dir = makeTmpDir("host-boundary-interleaved-");
    const x = { graphId: GRAPH_ID, nodeId: "x", attemptId: "x#1" };
    const y = { graphId: GRAPH_ID, nodeId: "y", attemptId: "y#1" };
    const z = { graphId: GRAPH_ID, nodeId: "z", attemptId: "z#1" };

    // THE REPRODUCED LOSS: two vaults over one root, interleaved writes, the
    // later writer rewriting the whole file from its own snapshot. y vanished.
    const retainedRoot = join(dir, "retained");
    const a = HostCredentialVault.open({
      root: retainedRoot,
      durableCredentialStore: "platform-isolated",
    });
    a.remember(x, "cred-x");
    const b = HostCredentialVault.open({
      root: retainedRoot,
      durableCredentialStore: "platform-isolated",
    });
    b.remember(y, "cred-y");
    a.remember(z, "cred-z");
    const reopened = HostCredentialVault.open({
      root: retainedRoot,
      durableCredentialStore: "platform-isolated",
    });
    expect(reopened.resolve(x)).toBe("cred-x");
    expect(reopened.resolve(y)).toBe("cred-y");
    expect(reopened.resolve(z)).toBe("cred-z");

    // WITH THE SHIPPED DEFAULT the same interleaving loses no MAPPING: every
    // attempt is recorded, none of the values is, and a recovery reports that
    // instead of inventing a credential.
    const defaultRoot = join(dir, "records");
    const c = HostCredentialVault.open({ root: defaultRoot });
    c.remember(x, "cred-x");
    const d = HostCredentialVault.open({ root: defaultRoot });
    d.remember(y, "cred-y");
    c.remember(z, "cred-z");
    const records = HostCredentialVault.open({ root: defaultRoot });
    expect(records.durableRecord(x)).toBe("not-retained");
    expect(records.durableRecord(y)).toBe("not-retained");
    expect(records.durableRecord(z)).toBe("not-retained");
    expect(records.resolve(x)).toBeUndefined();
    expect(records.resolve(y)).toBeUndefined();
    expect(records.resolve(z)).toBeUndefined();
  });
});

// ── A07: a completion that arrives after a restart ─────────────────────────
//
// THE MISSING BINDING IS GONE (P2 item 6). P0 pinned this case honestly: the
// completion bridge kept its bindings in an in-process `Map`, the only
// production bind site was the dispatch adapter, and a completion arriving after
// the process which dispatched the attempt exited had nothing to resolve — so it
// was reported UNBOUND. That pin belonged to acceptance entry A07 ("a natural
// completion received or queried after a host restart: the binding is recovered,
// not unbound, and accepted once"); the durable binding and the host-execution
// authentication below are what close it.
//
// HOW A BINDING IS REBUILT AFTER A RESTART. The host's OWN record — the ONE
// store's `host_dispatch_executions` row, keyed by the stable effect id
// `dispatch:<attemptId>`, plus the dispatch effect that names the node — is the
// authority; the bridge's map is only a cache of what THIS process delivered.
// The completion is then authenticated by the confirmed EXECUTION the record
// names, not by re-obtaining the worker's bearer value: the shipped vault keeps
// no credential value on disk at all (§3.3), and re-reading the worker's prompt
// is exactly what a trusted completion must not depend on.
//
// WHAT IS ASSERTED, EXACTLY: a genuinely different object graph over the same
// durable root settles the attempt the FIRST process dispatched; the settlement
// is accepted ONCE and a repeated observation replays the receipt without
// advancing anything; the record shows the node settled on its original attempt
// with exactly one accepted event; the restarted host creates NO second
// execution for the effect; and an attempt this host never delivered is still
// reported UNBOUND rather than guessed.
//
// The REAL process boundary for this scenario is in
// `tests/graph/host-restart-cross-process.test.ts`, which drives the same two
// windows with `Bun.spawn` workers.

const RESTART_GRAPH_ID = "graph.host-boundary.restart";
const RESTART_POLICY_ID = "policy.host-boundary.restart";
const RESTART_POLICY_REVISION = "1";

/**
 * The host's AUTHORIZATION of the restart graph's natural completion.
 *
 * A completion is only ever settled through the mapping the PLAN pinned and the
 * HOST authorized (D6): the fixture therefore declares `natural` completion and
 * installs the exact policy revision that grants it, so a host-observed
 * completion is the plan's own mapping rather than an outcome a caller chose.
 */
const RESTART_POLICY_BODY: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [
    { graphId: RESTART_GRAPH_ID, nodeId: "work", outcome: "done", decision: "allow" },
  ],
};

const RESTART_POLICIES = createCompletionPolicyRegistry({
  policies: [
    {
      ref: completionPolicyRefOf({
        id: RESTART_POLICY_ID,
        revision: RESTART_POLICY_REVISION,
        body: RESTART_POLICY_BODY,
      }),
      body: RESTART_POLICY_BODY,
    },
  ],
});

/** One node completing NATURALLY: the plan authorizes exactly this mapping. */
function restartDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: RESTART_GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        completion: { mode: "natural", outcome: "done" },
      },
    ],
    edges: [],
    completion_policy: { id: RESTART_POLICY_ID, revision: RESTART_POLICY_REVISION },
  };
}

interface RestartReading {
  readonly phase: string | undefined;
  readonly node: Record<string, unknown> | undefined;
  readonly events: number;
  readonly effects: readonly string[];
}

/** The AUTHORITATIVE record of the restart graph, read with a fresh connection. */
async function readRestartRecord(storeRoot: string): Promise<RestartReading> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    const record = ledger.readGraphState(RESTART_GRAPH_ID);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const entries = Array.isArray(body?.["nodes"]) ? (body["nodes"] as unknown[]) : [];
    let node: Record<string, unknown> | undefined;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      if ((entry as Record<string, unknown>)["nodeId"] === "work") {
        node = entry as Record<string, unknown>;
        break;
      }
    }
    return {
      phase: typeof body?.["phase"] === "string" ? (body["phase"] as string) : undefined,
      node,
      events: ledger.acceptedEvents(RESTART_GRAPH_ID).length,
      effects: ledger
        .pendingEffects(RESTART_GRAPH_ID)
        .map((effect) => effect.effectId + "@" + effect.status),
    };
  } finally {
    ledger.close();
  }
}

describe("host boundary — a completion after a restart is bound and settles once", () => {
  it("rebuilds the durable binding, settles without the worker bearer, and creates no second execution", async () => {
    const dir = makeTmpDir("host-boundary-restart-");
    const storeRoot = join(dir, "host-store");
    persistDeclaredGraph(
      buildDeclaredOutcomeGraph({
        declaration: restartDeclaration(),
        completionPolicies: RESTART_POLICIES,
      }),
      storeRoot,
    );
    const effect = dispatchEffectKeyOf(RESTART_GRAPH_ID, "work#1");
    const platformExecutionId = "platform-run-after-restart";

    // ── INSTANCE ONE: the host that dispatches the entry attempt ────────────
    const deliveriesOne: OutcomeDispatchRequest[] = [];
    const hostOne = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request) => {
        deliveriesOne.push(request);
      },
      // THE SHIPPED SHAPE: file durability, no durable credential value, and no
      // declaration of an identity capability the host cannot substantiate —
      // plus the one authorization this graph requires (its pinned completion
      // policy).
      declareInvocationIdentity: false,
      completionPolicies: RESTART_POLICIES,
    });
    let workerCredential = "";
    try {
      const started = await hostOne.startDeclaredGraph(RESTART_GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");
      expect(deliveriesOne.map((request) => request.attemptId)).toEqual(["work#1"]);
      workerCredential = deliveriesOne[0]?.credential ?? "";
      expect(workerCredential.length).toBeGreaterThan(0);
      // The platform named the execution it created; the host records the FACT.
      expect(
        hostOne.confirmExecution(effect, { executionId: platformExecutionId }),
      ).toBe(true);
      expect(hostOne.dispatch.lookup(effect).kind).toBe("created");
      // THE VALUE IS NOT ON DISK: the attempt's record is durable, its
      // credential is not. A restart therefore CANNOT settle this completion by
      // resolving the bearer value, which is exactly why the durable binding and
      // the host-execution proof below are the ones under test.
      expect(
        hostOne.credentials.durableRecord({
          graphId: RESTART_GRAPH_ID,
          nodeId: "work",
          attemptId: "work#1",
        }),
      ).toBe("not-retained");
    } finally {
      hostOne.close();
    }

    // ── INSTANCE TWO: NEW objects over the SAME root (a restart) ────────────
    const deliveriesTwo: OutcomeDispatchRequest[] = [];
    const hostTwo = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request) => {
        deliveriesTwo.push(request);
      },
      declareInvocationIdentity: false,
      // The graph's natural completion is a PLAN-LEVEL authorization (D6): a
      // host that does not install the exact policy revision the plan pinned
      // refuses to run the graph at all, and that refusal is asserted nowhere
      // here — the rest of this host is the shipped shape (file durability, no
      // durable credential value, no D9 declaration).
      completionPolicies: RESTART_POLICIES,
    });
    try {
      // A genuinely different object graph, not a reopened variable.
      expect(hostTwo).not.toBe(hostOne);
      expect(hostTwo.dispatch).not.toBe(hostOne.dispatch);
      expect(hostTwo.credentials).not.toBe(hostOne.credentials);

      // THE HOST FACT SURVIVES THE RESTART: the platform execution is still
      // recorded, by the id the platform minted rather than a local guess.
      expect(hostTwo.dispatch.lookup(effect).kind).toBe("created");
      const row = HostExecutionIndex.open({ root: storeRoot }).read(effect);
      expect(row?.state).toBe("created");
      expect(row?.execution?.executionId).toBe(platformExecutionId);
      expect(
        hostTwo.credentials.resolve({
          graphId: RESTART_GRAPH_ID,
          nodeId: "work",
          attemptId: "work#1",
        }),
      ).toBeUndefined();

      // ── THE COMPLETION ARRIVES AFTER THE RESTART ─────────────────────────
      const report = await hostTwo.complete(RESTART_GRAPH_ID, "work#1");
      // THE BINDING WAS REBUILT FROM DURABLE FACTS, so the completion is not
      // UNBOUND any more — and it is authenticated by the confirmed execution,
      // not by a bearer value this process never held.
      expect(report.kind).toBe("settled");
      if (report.kind !== "settled") return;
      expect(report.nodeId).toBe("work");
      expect(report.settlement.kind).toBe("accepted");
      if (report.settlement.kind !== "accepted") return;
      expect(report.settlement.replayed).toBe(false);
      expect(report.settlement.completion.outcomeId).toBe("done");
      expect(report.settlement.completion.attemptId).toBe("work#1");
      // The worker's bearer value is in NO field of the report: the host never
      // held it after the restart, and nothing fabricated it back.
      expect(JSON.stringify(report)).not.toContain(workerCredential);

      // ONE ACCEPTED EVENT, ON THE ORIGINAL ATTEMPT.
      const after = await readRestartRecord(storeRoot);
      expect(after.node?.["status"]).toBe("settled");
      expect(after.node?.["attemptId"]).toBe("work#1");
      expect(after.node?.["outcomeId"]).toBe("done");
      expect(after.events).toBe(1);
      expect(after.effects).toEqual([]);

      // A REPEATED OBSERVATION REPLAYS: no second settlement, no second event.
      const replay = await hostTwo.complete(RESTART_GRAPH_ID, "work#1");
      expect(replay.kind).toBe("settled");
      if (replay.kind !== "settled") return;
      expect(replay.settlement.kind).toBe("accepted");
      if (replay.settlement.kind !== "accepted") return;
      expect(replay.settlement.replayed).toBe(true);
      const final = await readRestartRecord(storeRoot);
      expect(final.events).toBe(1);

      // NO SECOND EXECUTION: the boot sweep re-visits the graph — now terminal —
      // and issues no create at all.
      const sweep = await hostTwo.recoverDeclaredGraphs();
      expect(sweep.started).toEqual([]);
      expect(sweep.refused).toEqual([]);
      expect(sweep.completed).toEqual([]);
      expect(sweep.divergences).toEqual([]);
      expect(sweep.effectRefusals).toEqual([]);
      expect(deliveriesTwo).toEqual([]);
      expect(hostTwo.dispatch.lookup(effect).kind).toBe("created");

      // AN ATTEMPT THIS HOST NEVER DELIVERED IS STILL UNBOUND. The durable
      // binding rebuilds what the host recorded, and nothing else: an attempt
      // with no row is reported, never guessed from its id.
      const ghost = await hostTwo.complete(RESTART_GRAPH_ID, "ghost#1");
      expect(ghost.kind).toBe("unbound");
    } finally {
      hostTwo.close();
    }
  });
});

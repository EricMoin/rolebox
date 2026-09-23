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

// ── The fifth counterexample: a completion that arrives after a restart ─────
//
// THE MISSING BINDING, PINNED HONESTLY. `HostDispatchCompletionBridge` keeps its
// attempt bindings in an in-process `Map` and the ONLY production bind site is
// the dispatch adapter, so a completion that arrives after the process which
// dispatched the attempt exited has no binding to resolve. The case below builds
// TWO genuinely different object graphs over ONE durable store root — a new
// vault, a new execution index, a new dispatch adapter and a new host — and asks
// the second to complete the attempt the first dispatched. It reports UNBOUND.
//
// WHAT IS ASSERTED, EXACTLY: the report is `unbound`; the persisted graph state
// still shows the attempt in flight with no accepted event (no fabricated
// completion); the host's durable FACT about the platform execution survives the
// restart; and the restarted host creates NO second execution for the effect —
// not on the completion, and not on the boot sweep either. The sweep's own
// per-effect refusal (`credential-missing`: the shipped vault keeps no
// credential VALUE on disk) is carried in the report rather than dropped.
//
// NOTHING HERE CLAIMS A RECOVERY THIS BUILD DOES NOT HAVE. Acceptance-matrix
// entries A06/A07 (the pending/creating/created restart windows; a completion
// after a host restart binding and settling once) stay OPEN until P2 provides a
// durable completion binding and a restart credential authorization; this case
// is the regression that must change shape when it does.

const RESTART_GRAPH_ID = "graph.host-boundary.restart";

/** One node with one explicit outcome: only a worker submission settles it. */
function restartDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: RESTART_GRAPH_ID,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
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

describe("host boundary — a completion after a restart has no durable binding", () => {
  it("reports the post-restart completion as UNBOUND, fabricates no completion and creates no second execution", async () => {
    const dir = makeTmpDir("host-boundary-restart-");
    const storeRoot = join(dir, "host-store");
    persistDeclaredGraph(
      buildDeclaredOutcomeGraph({ declaration: restartDeclaration() }),
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
      // THE SHIPPED CONFIGURATION: file durability, no durable credential value,
      // and no declaration of an identity capability the host cannot substantiate.
      declareInvocationIdentity: false,
    });
    try {
      const started = await hostOne.startDeclaredGraph(RESTART_GRAPH_ID, {
        sessionId: "session-declarer",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");
      expect(deliveriesOne.map((request) => request.attemptId)).toEqual(["work#1"]);
      // The platform named the execution it created; the host records the FACT.
      expect(
        hostOne.confirmExecution(effect, { executionId: platformExecutionId }),
      ).toBe(true);
      expect(hostOne.dispatch.lookup(effect).kind).toBe("created");
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

      // ── THE COMPLETION ARRIVES AFTER THE RESTART ─────────────────────────
      const report = await hostTwo.complete(RESTART_GRAPH_ID, "work#1");
      // THE HONEST FACT: this process holds no binding for the attempt, so the
      // completion bridge reports it UNBOUND — it never parses the attempt id
      // and never substitutes the node's current attempt.
      expect(report.kind).toBe("unbound");
      if (report.kind === "unbound") {
        expect(report.attemptId).toBe("work#1");
      }

      // NO FABRICATED COMPLETION: the authoritative record still shows the
      // attempt in flight, with no accepted event appended.
      const after = await readRestartRecord(storeRoot);
      expect(after.phase).toBe("executing");
      expect(after.node?.["attemptId"]).toBe("work#1");
      expect(after.node?.["status"]).toBe("dispatched");
      expect(after.events).toBe(0);

      // NO SECOND EXECUTION: the boot sweep re-visits the graph and issues no
      // create at all. The shipped vault keeps no credential VALUE, so the
      // attempt's effect is refused by name and stays unsettled rather than
      // being re-delivered with an invented credential.
      const sweep = await hostTwo.recoverDeclaredGraphs();
      expect(sweep.started).toEqual([]);
      expect(sweep.resumed).toEqual([RESTART_GRAPH_ID + ":executing"]);
      expect(sweep.refused).toEqual([]);
      expect(sweep.divergences).toEqual([]);
      expect(sweep.effectRefusals.map((refusal) => refusal.code)).toEqual([
        "credential-missing",
      ]);
      expect(deliveriesTwo).toEqual([]);

      // The effect is exactly where the first process left it: started, not
      // re-launched and not silently dropped.
      const final = await readRestartRecord(storeRoot);
      expect(final.effects).toEqual(["dispatch:work#1@started"]);
      expect(final.events).toBe(0);
      expect(hostTwo.dispatch.lookup(effect).kind).toBe("created");
    } finally {
      hostTwo.close();
    }
  });
});

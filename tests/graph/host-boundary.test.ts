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
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostCredentialVault } from "../../src/graph/host/credential-vault.ts";
import { HostOutcomeDispatch } from "../../src/graph/host/dispatch-host.ts";
import { HostExecutionIndex } from "../../src/graph/host/execution-index.ts";
import {
  dispatchEffectKeyOf,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";

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
    // The holder gives the right back and runs the real create path.
    expect(registryA.release(effect, "host-a")).toBe(true);

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

    // STATE 3 — created: the platform names the execution, and only then does
    // the registry answer with a fact.
    expect(reopened.confirmStarted(effect, { executionId: "dsh-run-42" })).toBe(true);
    expect(reopened.lookup(effect).kind).toBe("created");
    const row = HostExecutionIndex.open({ root: dir, ownerId: "host-d" }).read(effect);
    expect(row?.state).toBe("created");
    expect(row?.execution?.executionId).toBe("dsh-run-42");
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

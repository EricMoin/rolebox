/**
 * The SHIPPED host capability layer, driven end to end.
 *
 * `src/graph/host/**` is the host half of the outcome protocol the D7/D8/D9
 * slices deferred: a real credential store, a real execution index, a real
 * dispatch adapter, a real invocation-identity capability and the completion
 * bridge that turns an observed completion into `settleNatural`. This file
 * exercises them the way a host does — through the public runtime — and pins
 * the properties that make them worth having:
 *
 * 1. a credential is resolvable for EXACTLY the attempt it was issued, NO
 *    credential value is on disk by default, and only a host that declares a
 *    platform-isolated store can resolve one again after a restart;
 * 2. the execution registry distinguishes `pending` / `creating` / `created`,
 *    answers `created` only with a real host execution id, gives the create
 *    right to exactly one instance, and a memory-only registry never guesses
 *    `absent` for what an earlier process may have created;
 * 3. a dispatch adapter delivers at most once per stable effect id; a delivery
 *    that refused synchronously is released so exactly one recovery create can
 *    follow, while a failure that PROVES nothing (an asynchronous rejection, a
 *    timeout) keeps the claim and blocks;
 * 4. the completion bridge settles a full two-node graph through
 *    `settleNatural` — dispatches, natural completions, successor arming,
 *    accepted events and effect closure — idempotently, and it hands over a
 *    completion it cannot bind or cannot find a credential for INSTEAD of
 *    guessing;
 * 5. no report this layer returns carries a credential, and neither does the
 *    ledger the run wrote.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import {
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { readCredentialIsolationAdapter } from "../../src/graph/outcome/credential-isolation.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import { dispatchEffectKeyOf } from "../../src/graph/outcome/dispatch-effects.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
} from "../../src/graph/policy/completion-policy.ts";
import { HostCredentialVault } from "../../src/graph/host/credential-vault.ts";
import {
  HostExecutionIndex,
  hostExecutionNotCreated,
} from "../../src/graph/host/execution-index.ts";
import { GRAPH_STORE_FILE } from "../../src/graph/store/schema.ts";
import { HostOutcomeDispatch } from "../../src/graph/host/dispatch-host.ts";
import {
  createHostInvocationHolder,
  hostInvocationIdentity,
} from "../../src/graph/host/identity.ts";
import { HostDispatchCompletionBridge } from "../../src/graph/host/completion-bridge.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const GRAPH_ID = "graph.host-layer";
const POLICY_ID = "test.host-layer";
const POLICY_REVISION = "1";
const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** One credential per attempt, derived from the binding the runtime hands it. */
const TEST_CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "test-credential:" + binding.nodeId + "#" + binding.attemptId;

/** work -> ship, BOTH completing naturally, under the host's policy. */
function naturalDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        completion: { mode: "natural", outcome: "done" },
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
        completion: { mode: "natural", outcome: "shipped" },
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
    completion_policy: { id: POLICY_ID, revision: POLICY_REVISION },
  };
}

const POLICY_BODY: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [
    { graphId: GRAPH_ID, nodeId: "work", outcome: "done", decision: "allow" },
    { graphId: GRAPH_ID, nodeId: "ship", outcome: "shipped", decision: "allow" },
  ],
};

const AUTHORIZED = createCompletionPolicyRegistry({
  policies: [
    {
      ref: completionPolicyRefOf({
        id: POLICY_ID,
        revision: POLICY_REVISION,
        body: POLICY_BODY,
      }),
      body: POLICY_BODY,
    },
  ],
});

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

// ── The credential vault ────────────────────────────────────────────────────

describe("host credential vault — the credential lives here and nowhere else", () => {
  it("resolves a credential for exactly the attempt it was issued for", () => {
    const dir = makeTmpDir("host-vault-");
    try {
      const vault = HostCredentialVault.open({ root: dir });
      vault.remember({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" }, "cred-work-1");
      vault.remember({ graphId: GRAPH_ID, nodeId: "ship", attemptId: "ship#2" }, "cred-ship-2");
      expect(vault.size).toBe(2);

      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" }),
      ).toBe("cred-work-1");
      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "ship", attemptId: "ship#2" }),
      ).toBe("cred-ship-2");
      // Another attempt of the same node, another node, another graph: no
      // answer, because a credential is bound to ONE attempt.
      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#3" }),
      ).toBeUndefined();
      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "ship", attemptId: "work#1" }),
      ).toBeUndefined();
      expect(
        vault.resolve({ graphId: "other", nodeId: "work", attemptId: "work#1" }),
      ).toBeUndefined();

      // The capability it backs is a readable version-3 adapter whose store is
      // the vault's own two functions, and whose durable-store disclosure is
      // the honest default: nothing durable holds a value.
      const read = readCredentialIsolationAdapter(vault.capability());
      expect(read?.version).toBe(3);
      if (read?.version !== 3) return;
      expect(read.durableCredentialStore).toBe("none");
      expect(read.guarantees.digestOnlyPersistedState).toBe(true);
      expect(read.store.resolve({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" })).toBe(
        "cred-work-1",
      );

      // A non-credential is refused instead of stored: an attempt whose entry
      // holds garbage could never be delivered or settled.
      expect(() =>
        vault.remember({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#9" }, ""),
      ).toThrow();
      expect(vault.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps no credential value on disk by default, and a restart reports the loss", () => {
    const dir = makeTmpDir("host-vault-nodisk-");
    const identity = { graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" };
    try {
      const first = HostCredentialVault.open({ root: dir });
      first.remember(identity, "cred-work-1");
      expect(first.resolve(identity)).toBe("cred-work-1");

      // THE ENFORCED HALF OF THE BOUNDARY: the attempt is recorded durably, the
      // VALUE is not — so a same-account reader of the whole root obtains
      // nothing to present.
      expect(first.durableRecord(identity)).toBe("not-retained");
      for (const entry of readdirSync(dir)) {
        expect(readFileSync(join(dir, entry), "utf8")).not.toContain("cred-work-1");
      }

      // A SECOND host process over the same root — a restart — sees the attempt
      // and cannot produce the value: it reports the loss instead of inventing
      // one, and its capability says exactly that.
      const restarted = HostCredentialVault.open({ root: dir });
      expect(restarted.resolve(identity)).toBeUndefined();
      expect(restarted.has(identity)).toBe(false);
      expect(restarted.durableRecord(identity)).toBe("not-retained");
      expect(restarted.size).toBe(0);
      const capability = restarted.capability();
      expect(capability.durableCredentialStore).toBe("none");
      expect(readCredentialIsolationAdapter(capability)?.version).toBe(3);

      // A MEMORY-ONLY vault holds nothing across processes either: it can only
      // ever answer for what it remembered itself.
      const memory = HostCredentialVault.open({ root: dir, durability: "memory" });
      expect(memory.resolve(identity)).toBeUndefined();
      expect(memory.size).toBe(0);
      expect(readCredentialIsolationAdapter(memory.capability())?.version).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains values only for a host that declares a platform-isolated store", () => {
    const dir = makeTmpDir("host-vault-retained-");
    const identity = { graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" };
    try {
      const first = HostCredentialVault.open({
        root: dir,
        durableCredentialStore: "platform-isolated",
      });
      first.remember(identity, "cred-work-1");
      expect(first.durableRecord(identity)).toBe("retained");

      const restarted = HostCredentialVault.open({
        root: dir,
        durableCredentialStore: "platform-isolated",
      });
      expect(restarted.resolve(identity)).toBe("cred-work-1");
      expect(restarted.capability().durableCredentialStore).toBe("platform-isolated");

      // The contradiction is REFUSED rather than declared: a store that does
      // not outlive the process cannot be a durable credential store.
      expect(() =>
        HostCredentialVault.open({
          root: dir,
          durability: "memory",
          durableCredentialStore: "platform-isolated",
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a store file it cannot read instead of opening as empty", () => {
    const dir = makeTmpDir("host-vault-corrupt-");
    try {
      // The vault's records live in the workspace's ONE graph store now, so the
      // file a damaged store must be refused at is that store's file.
      writeFileSync(join(dir, GRAPH_STORE_FILE), "{ not json", "utf8");
      expect(() => HostCredentialVault.open({ root: dir })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The execution registry ──────────────────────────────────────────────────

describe("host execution registry — three states, one owner, a real host fact", () => {
  it("answers absent, then unknown while a create is in flight, then created only with an id", () => {
    const dir = makeTmpDir("host-index-states-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      const registry = HostExecutionIndex.open({ root: dir });
      // A durable registry wrote every create it ever made, so an effect with
      // no row is genuinely absent — which is what lets a recovery create once.
      expect(registry.lookup(effect).kind).toBe("absent");

      const claim = registry.claim(effect);
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      // PENDING: the right is held and nothing was handed to the platform, so
      // no execution can exist.
      expect(registry.read(effect)?.state).toBe("pending");
      expect(registry.lookup(effect).kind).toBe("absent");

      expect(registry.markCreating(effect, claim.ownerId)).toBe(true);
      // CREATING: the request is with the platform and its result is UNKNOWN.
      expect(registry.read(effect)?.state).toBe("creating");
      const unknown = registry.lookup(effect);
      expect(unknown.kind).toBe("unknown");
      if (unknown.kind === "unknown") expect(unknown.reason).toContain("UNKNOWN");

      // CREATED IS A HOST FACT, AND REQUIRES ONE.
      expect(() => registry.confirm(effect, { executionId: "" })).toThrow();
      expect(registry.confirm(effect, { executionId: "dsh-run-7" })).toBe(true);
      expect(registry.lookup(effect).kind).toBe("created");

      // The row survives a reopen WITH the host's own id, so a restart can
      // reconcile the effect against the platform instead of guessing.
      const reopened = HostExecutionIndex.open({ root: dir });
      expect(reopened.lookup(effect).kind).toBe("created");
      expect(reopened.read(effect)?.execution?.executionId).toBe("dsh-run-7");
      expect(reopened.has(effect)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the create right to exactly one of two instances and says so to the other", () => {
    const dir = makeTmpDir("host-index-owner-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      const first = HostExecutionIndex.open({ root: dir, ownerId: "host-a" });
      const second = HostExecutionIndex.open({ root: dir, ownerId: "host-b" });

      const owned = first.claim(effect);
      expect(owned.kind).toBe("claimed");
      const refused = second.claim(effect);
      expect(refused.kind).toBe("held");
      if (refused.kind !== "held") return;
      expect(refused.state).toBe("pending");
      expect(refused.ownerId).toBe("host-a");

      // The second instance is told it cannot tell — never "absent", which
      // would license a second create.
      const unknown = second.lookup(effect);
      expect(unknown.kind).toBe("unknown");
      if (unknown.kind === "unknown") {
        expect(unknown.reason).toContain("another host process");
      }
      // The first owner's own view is unaffected.
      expect(first.lookup(effect).kind).toBe("absent");

      // A delivery that threw releases the claim; from there the other
      // instance may create, and it is the ONLY create. The release carries the
      // PROOF the store demands — nothing was handed to the platform.
      expect(first.markCreating(effect, "host-a")).toBe(true);
      expect(
        first.release(
          effect,
          "host-a",
          hostExecutionNotCreated("fixture: the delivery never reached the platform"),
        ),
      ).toBe(true);
      expect(second.lookup(effect).kind).toBe("absent");
      const retaken = second.claim(effect);
      expect(retaken.kind).toBe("claimed");
      expect(second.size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes over only a stale PENDING claim, never a creating one", () => {
    const dir = makeTmpDir("host-index-lease-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      let clock = 1_000;
      const first = HostExecutionIndex.open({
        root: dir,
        ownerId: "host-a",
        leaseMs: 100,
        now: () => clock,
      });
      const second = HostExecutionIndex.open({
        root: dir,
        ownerId: "host-b",
        leaseMs: 100,
        now: () => clock,
      });
      expect(first.claim(effect).kind).toBe("claimed");
      expect(second.claim(effect).kind).toBe("held");

      clock = 1_200; // the claim's lease expired
      const taken = second.claim(effect);
      expect(taken.kind).toBe("claimed");
      if (taken.kind !== "claimed") return;
      expect(taken.ownerId).toBe("host-b");
      // The old owner lost the right: its transitions do not apply.
      expect(first.markCreating(effect, "host-a")).toBe(false);
      expect(second.markCreating(effect, "host-b")).toBe(true);

      // A claim that was handed to the platform is NEVER taken over, however
      // long it has been: the execution may exist.
      clock = 1_000_000;
      expect(second.claim(effect).kind).toBe("held");
      const resumed = second.lookup(effect);
      expect(resumed.kind).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not lose one instance's rows to another instance's writes", () => {
    const dir = makeTmpDir("host-index-interleaved-");
    try {
      const a = HostExecutionIndex.open({ root: dir, ownerId: "host-a" });
      const b = HostExecutionIndex.open({ root: dir, ownerId: "host-b" });
      const x = dispatchEffectKeyOf(GRAPH_ID, "x#1");
      const y = dispatchEffectKeyOf(GRAPH_ID, "y#1");
      const z = dispatchEffectKeyOf(GRAPH_ID, "z#1");
      // The reproduced defect: two live instances each rewrote the whole file
      // from their own snapshot, so the later writer erased the other's rows.
      expect(a.claim(x).kind).toBe("claimed");
      expect(b.claim(y).kind).toBe("claimed");
      expect(a.claim(z).kind).toBe("claimed");

      const reopened = HostExecutionIndex.open({ root: dir, ownerId: "host-c" });
      expect(reopened.size).toBe(3);
      for (const effect of [x, y, z]) expect(reopened.has(effect)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is unknown, never absent, when a memory-only registry cannot see an earlier process", () => {
    const dir = makeTmpDir("host-index-memory-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      const memory = HostExecutionIndex.open({ root: dir, durability: "memory" });
      const unknown = memory.lookup(effect);
      expect(unknown.kind).toBe("unknown");
      if (unknown.kind === "unknown") {
        expect(unknown.reason).toContain("in memory only");
      }
      const claim = memory.claim(effect);
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      expect(memory.markCreating(effect, claim.ownerId)).toBe(true);
      expect(memory.confirm(effect, { executionId: "pi-task-1", taskId: "pi-task-1" })).toBe(true);
      expect(memory.lookup(effect).kind).toBe("created");
      expect(memory.read(effect)?.execution?.taskId).toBe("pi-task-1");

      // A DURABLE registry over the same root sees none of it: the memory-only
      // rows never reached the store.
      const durable = HostExecutionIndex.open({ root: dir });
      expect(durable.lookup(effect).kind).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The dispatch adapter ────────────────────────────────────────────────────

describe("host dispatch adapter — create at most once, look up the host's fact", () => {
  it("delivers each effect exactly once and records the binding", () => {
    const dir = makeTmpDir("host-dispatch-");
    try {
      const deliveries: OutcomeDispatchRequest[] = [];
      const bindings: string[] = [];
      const host = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: dir }),
        deliver: (request) => {
          deliveries.push(request);
        },
        completions: {
          bind: (binding) => {
            bindings.push(binding.nodeId + "@" + binding.attemptId);
          },
        },
      });
      const request = {
        graphId: GRAPH_ID,
        planRevision: "rev-1",
        nodeId: "work",
        attemptId: "work#1",
        agent: "agent.work",
        prompt: "Do the work.",
        credential: "cred-work-1",
      };
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");

      host.create(request, effect);
      // The delivery is made, and the registry says the create is IN FLIGHT:
      // the platform has the request and has not named the execution yet.
      expect(deliveries).toHaveLength(1);
      expect(bindings).toEqual(["work@work#1"]);
      expect(host.lookup(effect).kind).toBe("unknown");

      // A second create for the SAME effect is REFUSED — the contract's
      // idempotency rule is enforced by the registry, not assumed of the caller.
      expect(() => host.create(request, effect)).toThrow();
      expect(deliveries).toHaveLength(1);

      // The platform names the execution, and only then is the effect created.
      expect(host.confirmStarted(effect, { executionId: "dsh-run-1" })).toBe(true);
      expect(host.lookup(effect).kind).toBe("created");
      expect(() => host.create(request, effect)).toThrow();
      expect(deliveries).toHaveLength(1);

      // A different attempt is a different effect and IS delivered.
      const second = dispatchEffectKeyOf(GRAPH_ID, "ship#2");
      host.create({ ...request, nodeId: "ship", attemptId: "ship#2" }, second);
      expect(deliveries.map((entry) => entry.attemptId)).toEqual(["work#1", "ship#2"]);
      expect(host.confirmStarted(second, { executionId: "dsh-run-2" })).toBe(true);
      expect(host.lookup(second).kind).toBe("created");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases a delivery that threw, so exactly one later create can follow", () => {
    const dir = makeTmpDir("host-dispatch-fail-");
    try {
      let attempts = 0;
      const host = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: dir }),
        deliver: (request) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("the platform refused " + JSON.stringify(request));
          }
        },
      });
      const request = {
        graphId: GRAPH_ID,
        planRevision: "rev-1",
        nodeId: "work",
        attemptId: "work#1",
        agent: "agent.work",
        prompt: "Do the work.",
        credential: "cred-work-1",
      };
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");

      expect(() => host.create(request, effect)).toThrow();
      // The execution demonstrably did not start, so the claim is released and
      // the effect is ABSENT again: a recovery creates exactly once rather than
      // never.
      expect(host.lookup(effect).kind).toBe("absent");
      host.create(request, effect);
      expect(attempts).toBe(2);
      expect(host.confirmStarted(effect, { executionId: "dsh-run-1" })).toBe(true);
      expect(host.lookup(effect).kind).toBe("created");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers nothing when ANOTHER instance owns the effect", () => {
    const dir = makeTmpDir("host-dispatch-owned-");
    try {
      const first = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: dir, ownerId: "host-a" }),
        deliver: () => undefined,
      });
      const secondDeliveries: OutcomeDispatchRequest[] = [];
      const second = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: dir, ownerId: "host-b" }),
        deliver: (request) => {
          secondDeliveries.push(request);
        },
      });
      const request = {
        graphId: GRAPH_ID,
        planRevision: "rev-1",
        nodeId: "work",
        attemptId: "work#1",
        agent: "agent.work",
        prompt: "Do the work.",
        credential: "cred-work-1",
      };
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");

      first.create(request, effect);
      expect(() => second.create(request, effect)).toThrow();
      expect(secondDeliveries).toEqual([]);
      expect(second.lookup(effect).kind).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a request that names another execution than the effect", () => {
    const dir = makeTmpDir("host-dispatch-mismatch-");
    try {
      let delivered = 0;
      const host = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: dir }),
        deliver: () => {
          delivered += 1;
        },
      });
      expect(() =>
        host.create(
          {
            graphId: GRAPH_ID,
            planRevision: "rev-1",
            nodeId: "work",
            attemptId: "work#2",
            agent: "agent.work",
            prompt: "Do the work.",
            credential: "cred-work-2",
          },
          dispatchEffectKeyOf(GRAPH_ID, "work#1"),
        ),
      ).toThrow();
      expect(delivered).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the create right when a failure proves nothing, and releases it only on a platform proof", () => {
    const dir = makeTmpDir("host-dispatch-unproven-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      const request: OutcomeDispatchRequest = {
        graphId: GRAPH_ID,
        planRevision: "rev-1",
        nodeId: "work",
        attemptId: "work#1",
        agent: "agent.work",
        prompt: "Do the work.",
        credential: "cred-work-1",
      };
      let platformSaysAbsent = false;
      const deliveries: OutcomeDispatchRequest[] = [];
      const index = HostExecutionIndex.open({ root: dir, ownerId: "host-a" });
      const host = new HostOutcomeDispatch({
        executions: index,
        deliver: (delivered) => {
          deliveries.push(delivered);
        },
        // A port that can only say "no answer" until the test flips it.
        query: () =>
          platformSaysAbsent
            ? { kind: "absent" }
            : { kind: "unknown", reason: "the control plane is unreachable" },
      });

      host.create(request, effect);
      expect(deliveries).toHaveLength(1);
      expect(index.read(effect)?.state).toBe("creating");

      // THE ASYNCHRONOUS FAILURE REPORT: no proof, so nothing is released and
      // nothing is re-dispatched — the row stays CREATING, every lookup answers
      // UNKNOWN, and the failure is recorded on the row.
      expect(index.release(effect, "host-a")).toBe(false);
      expect(index.read(effect)?.state).toBe("creating");
      expect(host.lookup(effect).kind).toBe("unknown");
      expect(index.read(effect)?.refused?.kind).toBe("unproven-failure");
      expect(index.read(effect)?.refused?.generation).toBe(1);
      expect(() => host.create(request, effect)).toThrow();
      expect(deliveries).toHaveLength(1);

      // THE PROOF: the platform's own query reports no execution, so the
      // stranded claim may be released and the attempt created EXACTLY once —
      // and the generation moves, which is what fences the old claim out.
      platformSaysAbsent = true;
      expect(host.lookup(effect).kind).toBe("absent");
      host.create(request, effect);
      expect(deliveries).toHaveLength(2);
      const adopted = index.read(effect);
      expect(adopted?.state).toBe("creating");
      expect(adopted?.generation).toBeGreaterThan(1);

      // The request is with the platform again: an honest port no longer calls
      // it absent, so the effect is unresolved rather than re-created.
      platformSaysAbsent = false;
      expect(host.lookup(effect).kind).toBe("unknown");
      expect(() => host.create(request, effect)).toThrow();
      expect(deliveries).toHaveLength(2);

      // And the platform's confirmation is accepted from the claim that made
      // the delivery, exactly as for a first dispatch.
      expect(host.confirmStarted(effect, { executionId: "dsh-run-9" })).toBe(true);
      expect(host.lookup(effect).kind).toBe("created");
      expect(index.read(effect)?.generation).toBe(adopted?.generation);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fences a late confirmation from a superseded claim and records the stale attempt", () => {
    const dir = makeTmpDir("host-dispatch-fence-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      const now = 1_700_000_000_000;
      const first = HostExecutionIndex.open({ root: dir, ownerId: "host-a", now: () => now });
      const second = HostExecutionIndex.open({ root: dir, ownerId: "host-b", now: () => now });

      const firstClaim = first.claim(effect);
      expect(firstClaim.kind).toBe("claimed");
      if (firstClaim.kind !== "claimed") return;
      expect(firstClaim.generation).toBe(1);
      expect(first.markCreating(effect, "host-a")).toBe(true);

      // THE PLATFORM PROVED the stranded claim empty, so the second instance
      // releases it BY THE CLAIM IT OBSERVED and takes over on a new generation.
      expect(
        second.releaseStale(
          effect,
          firstClaim,
          hostExecutionNotCreated("the platform proved this claim created nothing"),
        ),
      ).toBe(true);
      expect(first.read(effect)?.releasedAt).toBe(now);
      const secondClaim = second.claim(effect);
      expect(secondClaim.kind).toBe("claimed");
      if (secondClaim.kind !== "claimed") return;
      expect(secondClaim.generation).toBe(3);
      expect(second.markCreating(effect, "host-b")).toBe(true);
      expect(second.confirm(effect, { executionId: "task-b" })).toBe(true);

      // THE LATE CONFIRMATION: the first instance never learned it lost the
      // claim, so it reports the execution IT believed it created. The store's
      // conditional write refuses it and records it.
      const verdict = first.confirmExecution(effect, { executionId: "task-a-late" });
      expect(verdict.kind).toBe("fenced");
      if (verdict.kind !== "fenced") return;
      expect(verdict.attemptedOwnerId).toBe("host-a");
      expect(verdict.attemptedGeneration).toBe(1);
      expect(verdict.ownerId).toBe("host-b");
      expect(verdict.generation).toBe(3);
      expect(verdict.state).toBe("created");

      // THE NEW OWNER'S RECORD IS UNTOUCHED, and the stale attempt is durable.
      const row = second.read(effect);
      expect(row?.state).toBe("created");
      expect(row?.ownerId).toBe("host-b");
      expect(row?.generation).toBe(3);
      expect(row?.execution?.executionId).toBe("task-b");
      expect(row?.refused).toEqual({
        kind: "stale-confirmation",
        ownerId: "host-a",
        generation: 1,
        executionId: "task-a-late",
        at: now,
        count: 1,
      });

      // A SECOND refusal counts rather than overwriting the first silently.
      expect(first.confirm(effect, { executionId: "task-a-again" })).toBe(false);
      expect(second.read(effect)?.refused?.count).toBe(2);
      expect(second.read(effect)?.refused?.executionId).toBe("task-a-again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a first dispatch, a successor, a retry and a recovery through ONE create path", () => {
    const dir = makeTmpDir("host-dispatch-one-path-");
    try {
      const deliveries: string[] = [];
      const bindings: string[] = [];
      let platformSaysAbsent = false;
      const index = HostExecutionIndex.open({ root: dir, ownerId: "host-one" });
      const host = new HostOutcomeDispatch({
        executions: index,
        deliver: (request) => {
          deliveries.push(request.attemptId);
        },
        query: () =>
          platformSaysAbsent
            ? { kind: "absent" }
            : { kind: "unknown", reason: "no answer from the platform" },
        completions: {
          bind: (binding) => {
            bindings.push(binding.attemptId);
          },
        },
      });
      const requestOf = (nodeId: string, attemptId: string): OutcomeDispatchRequest => ({
        graphId: GRAPH_ID,
        planRevision: "rev-1",
        nodeId,
        attemptId,
        agent: "agent." + nodeId,
        prompt: "Do the work.",
        credential: "cred-" + attemptId,
      });
      const keyOf = (attemptId: string) => dispatchEffectKeyOf(GRAPH_ID, attemptId);

      // FIRST DISPATCH.
      host.create(requestOf("work", "work#1"), keyOf("work#1"));
      // SUCCESSOR: an accepted outcome armed ship, so ship is a NEW effect.
      host.create(requestOf("ship", "ship#2"), keyOf("ship#2"));
      // RETRY (P3's window): a new ATTEMPT of work is a new effect key too —
      // never the row the first attempt owns.
      host.create(requestOf("work", "work#3"), keyOf("work#3"));
      expect(deliveries).toEqual(["work#1", "ship#2", "work#3"]);
      expect(bindings).toEqual(["work#1", "ship#2", "work#3"]);
      expect(host.confirmStarted(keyOf("work#1"), { executionId: "dsh-run-1" })).toBe(true);
      expect(host.lookup(keyOf("work#1")).kind).toBe("created");
      expect(() => host.create(requestOf("work", "work#1"), keyOf("work#1"))).toThrow();
      expect(deliveries).toHaveLength(3);

      // RECOVERY: ship#2's create outcome was never confirmed and the failure
      // proved nothing, so the effect is BLOCKED — the same path, the same
      // steps. Only the platform's own proof frees it, and then the create
      // adopts the stranded claim and delivers ONE more time.
      expect(index.release(keyOf("ship#2"), "host-one")).toBe(false);
      expect(host.lookup(keyOf("ship#2")).kind).toBe("unknown");
      expect(() => host.create(requestOf("ship", "ship#2"), keyOf("ship#2"))).toThrow();
      expect(deliveries.filter((attempt) => attempt === "ship#2")).toHaveLength(1);

      platformSaysAbsent = true;
      expect(host.lookup(keyOf("ship#2")).kind).toBe("absent");
      host.create(requestOf("ship", "ship#2"), keyOf("ship#2"));
      expect(deliveries.filter((attempt) => attempt === "ship#2")).toHaveLength(2);
      expect(index.read(keyOf("ship#2"))?.generation).toBeGreaterThan(1);
      // The platform has the request again; an honest port stops claiming absence.
      platformSaysAbsent = false;
      expect(host.confirmStarted(keyOf("ship#2"), { executionId: "dsh-run-2" })).toBe(true);
      expect(host.lookup(keyOf("ship#2")).kind).toBe("created");

      // ONE ROW PER EFFECT, one delivery per attempt, and no effect created
      // twice without a proof.
      expect(index.size).toBe(3);
      for (const attempt of ["work#1", "ship#2", "work#3"]) {
        expect(index.read(keyOf(attempt))?.attemptId).toBe(attempt);
        expect(() => host.create(requestOf("work", attempt), keyOf(attempt))).toThrow();
      }
      expect(deliveries).toEqual(["work#1", "ship#2", "work#3", "ship#2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The identity capability ─────────────────────────────────────────────────

describe("host invocation identity — the invocation the host attributes now", () => {
  it("follows the holder and refuses half an identity", () => {
    const holder = createHostInvocationHolder();
    const identity = hostInvocationIdentity("session-1", "agent.work");
    expect(identity).toEqual({ sessionId: "session-1", agentId: "agent.work" });
    // "The same session" and "the same agent" are ONE attribution: a host that
    // knows only one of them has no comparable identity.
    expect(hostInvocationIdentity("session-1", "")).toBeUndefined();
    expect(hostInvocationIdentity("", "agent.work")).toBeUndefined();

    expect(holder.capability.current()).toBeUndefined();
    holder.set(identity);
    expect(holder.capability.current()).toEqual(identity);
    holder.clear();
    expect(holder.capability.current()).toBeUndefined();
    expect(holder.capability.version).toBe(1);
  });
});

// ── The completion bridge, end to end ───────────────────────────────────────

/** One host-driven run: the real runtime, the real host layer, a fake platform. */
interface HostRun {
  readonly runtime: OutcomeGraphRuntime;
  readonly ledger: SqliteAcceptanceLedger;
  readonly vault: HostCredentialVault;
  readonly bridge: HostDispatchCompletionBridge;
  readonly holder: ReturnType<typeof createHostInvocationHolder>;
  /** Every request the fake platform was handed, in delivery order. */
  readonly deliveries: OutcomeDispatchRequest[];
  readonly dir: string;
}

async function withHostRun<T>(
  fn: (run: HostRun) => Promise<T> | T,
  options: { readonly identity?: boolean } = {},
): Promise<T> {
  const dir = makeTmpDir("host-run-");
  const ledger = await SqliteAcceptanceLedger.create(dir);
  try {
    const plan = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    }).plan;
    const vault = HostCredentialVault.open({ root: join(dir, "host-store") });
    const deliveries: OutcomeDispatchRequest[] = [];
    const holder = createHostInvocationHolder();
    // The real host shape: the bridge takes a PROVIDER, because the production
    // entries build a runtime per operation over the graph's saved plan. The
    // adapter and the bridge are wired before the runtime exists.
    let runtime: OutcomeGraphRuntime | undefined;
    const bridge = new HostDispatchCompletionBridge({
      runtime: () => {
        if (runtime === undefined) {
          throw new Error("fixture: the runtime was asked for before it was built");
        }
        return runtime;
      },
      credentials: vault,
      clock: () => NOW,
    });
    const host = new HostOutcomeDispatch({
      executions: HostExecutionIndex.open({ root: join(dir, "host-store") }),
      deliver: (request) => {
        deliveries.push(request);
      },
      completions: bridge,
    });
    runtime = new OutcomeGraphRuntime({
      plan,
      ledger,
      dispatch: host,
      validators: EMPTY_VALIDATORS,
      artifactRoot: dir,
      clock: () => NOW,
      mintCredential: TEST_CREDENTIAL_SOURCE,
      credentialIsolation: vault.capability(),
      completionPolicies: AUTHORIZED,
      ...(options.identity === false ? {} : { hostIdentity: holder.capability }),
    });
    if (options.identity !== false) {
      holder.set(hostInvocationIdentity("session-1", "agent.work"));
    }
    return await fn({ runtime, ledger, vault, bridge, holder, deliveries, dir });
  } finally {
    ledger.close();
  }
}

describe("host completion bridge — a dispatched attempt settles through settleNatural", () => {
  it("runs a full graph: dispatch, natural completion, successor, terminal phase", async () => {
    await withHostRun(async ({ runtime, ledger, vault, bridge, deliveries, dir }) => {
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      // The host was handed the entry attempt and bound it.
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1"]);
      expect(bridge.bound).toBe(1);
      const workCredential = deliveries[0]?.credential ?? "";
      expect(workCredential.length).toBeGreaterThan(0);

      // THE COMPLETION: the platform observed work finish, so the host settles
      // the attempt's authorized outcome through the runtime's own channel.
      const first = await bridge.complete({ graphId: GRAPH_ID, attemptId: "work#1" });
      expect(first.kind).toBe("settled");
      if (first.kind !== "settled") return;
      expect(first.nodeId).toBe("work");
      expect(first.settlement.kind).toBe("accepted");
      if (first.settlement.kind !== "accepted") return;
      expect(first.settlement.replayed).toBe(false);
      // The settlement's provenance is the natural-completion namespace, so it
      // can never be confused with a worker's own submission.
      expect(first.settlement.completion.outcomeId).toBe("done");
      expect(first.settlement.completion.submissionId).toContain("natural-completion:");
      // The successor is armed and dispatched by the same acceptance — the host
      // learns that from its own delivery seam, not from the report: the
      // settlement the bridge returns carries no dispatch request, because a
      // dispatch request is the one thing that carries a credential.
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1", "ship#2"]);

      // THE SECOND COMPLETION finishes the graph.
      const second = await bridge.complete({ graphId: GRAPH_ID, attemptId: "ship#2" });
      expect(second.kind).toBe("settled");
      if (second.kind !== "settled") return;
      expect(second.settlement.kind).toBe("accepted");
      if (second.settlement.kind !== "accepted") return;
      expect(second.settlement.state.phase).toBe("complete");

      // A REPEATED observation replays the persisted receipt: no second
      // settlement, no second accepted event, no state advance.
      const replay = await bridge.complete({ graphId: GRAPH_ID, attemptId: "ship#2" });
      expect(replay.kind).toBe("settled");
      if (replay.kind !== "settled") return;
      expect(replay.settlement.kind).toBe("accepted");
      if (replay.settlement.kind !== "accepted") return;
      expect(replay.settlement.replayed).toBe(true);

      // STATE, EVENTS AND EFFECTS AGREE: both nodes settled on the attempts the
      // host dispatched, both attempts left an accepted event, and every
      // dispatch effect is closed.
      const state = runtime.state();
      expect(state?.phase).toBe("complete");
      expect(
        state?.nodes.map((node) => node.nodeId + ":" + node.status + "@" + String(node.attemptId)),
      ).toEqual(["ship:settled@ship#2", "work:settled@work#1"]);
      expect(
        ledger
          .acceptedEvents(GRAPH_ID)
          .map((event) => event.attemptId + ":" + event.outcomeId)
          .sort(),
      ).toEqual(["ship#2:shipped", "work#1:done"]);
      expect(ledger.pendingEffects(GRAPH_ID)).toEqual([]);

      // THE CREDENTIAL NEVER LEFT THE TWO CHANNELS IT BELONGS TO. It reached
      // the dispatch request and the vault; it is in no completion report, and
      // it is not in the ledger the run wrote.
      const reports = JSON.stringify([first, second, replay]);
      expect(reports).not.toContain(workCredential);
      const shipCredential = deliveries[1]?.credential ?? "";
      expect(shipCredential.length).toBeGreaterThan(0);
      expect(reports).not.toContain(shipCredential);
      expect(JSON.stringify(ledger.readGraphState(GRAPH_ID)?.body)).not.toContain(
        workCredential,
      );
      expect(readFileSync(ledgerFilePath(dir), "utf8")).not.toContain(workCredential);
      expect(readFileSync(ledgerFilePath(dir), "utf8")).not.toContain(shipCredential);

      // ...and the vault CAN produce each of them, for its own attempt only.
      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" }),
      ).toBe(workCredential);
      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "ship", attemptId: "ship#2" }),
      ).toBe(shipCredential);
      expect(
        vault.resolve({ graphId: GRAPH_ID, nodeId: "ship", attemptId: "work#1" }),
      ).toBeUndefined();
    });
  });

  it("reports a completion it cannot bind instead of guessing the node", async () => {
    await withHostRun(async ({ runtime, bridge }) => {
      runtime.start(NOW);
      const report = await bridge.complete({ graphId: GRAPH_ID, attemptId: "ghost#9" });
      expect(report.kind).toBe("unbound");
      if (report.kind !== "unbound") return;
      expect(report.reason).toContain("no recorded node");
    });
  });

  it("reports a completion whose credential the host no longer holds", async () => {
    await withHostRun(async ({ runtime, bridge }) => {
      runtime.start(NOW);
      // A host that restarted with a memory-only store bound the attempt again
      // but cannot produce its credential: the attempt is REPORTED, never
      // settled with a fabricated one.
      bridge.bind({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#7" });
      const report = await bridge.complete({ graphId: GRAPH_ID, attemptId: "work#7" });
      expect(report.kind).toBe("credential-unavailable");
      if (report.kind !== "credential-unavailable") return;
      expect(report.nodeId).toBe("work");
      expect(report.reason).toContain("fabricated credential");
      const state = runtime.state();
      expect(state?.nodes.find((node) => node.nodeId === "work")?.status).toBe("dispatched");
    });
  });

  it("re-delivers a crash-window effect exactly once across a host restart", async () => {
    const dir = makeTmpDir("host-restart-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const plan = buildDeclaredOutcomeGraph({
        declaration: naturalDeclaration(),
        completionPolicies: AUTHORIZED,
      }).plan;
      // FIRST PROCESS: the runtime commits the effect and the state, then the
      // platform refuses the delivery — the commit-then-crash window D8 exists
      // for. The adapter releases the claim, so the durable registry says
      // absent, and the ledger row stays pending.
      //
      // BOTH PROCESSES DECLARE A PLATFORM-ISOLATED STORE HERE, because the test
      // is ABOUT restart re-delivery: re-delivering a crash-window attempt needs
      // the credential the first process minted, and the honest default
      // (`durableCredentialStore: "none"`) keeps no value on disk. The shipped
      // entries take the default; a host with a real platform boundary opts in.
      const firstVault = HostCredentialVault.open({
        root: join(dir, "host-store"),
        durableCredentialStore: "platform-isolated",
      });
      const firstDeliveries: OutcomeDispatchRequest[] = [];
      const firstHost = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: join(dir, "host-store") }),
        deliver: (request) => {
          firstDeliveries.push(request);
          throw new Error("the platform died before the execution started");
        },
      });
      const firstRuntime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: firstHost,
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: TEST_CREDENTIAL_SOURCE,
        credentialIsolation: firstVault.capability(),
        completionPolicies: AUTHORIZED,
      });
      expect(() => firstRuntime.start(NOW)).toThrow();
      expect(ledger.pendingEffects(GRAPH_ID).map((effect) => effect.status)).toEqual([
        "pending",
      ]);

      // SECOND PROCESS: fresh vault, fresh index and a fresh runtime over the
      // same roots. The host looks the effect up, reports the truth (absent),
      // and the recovery creates it EXACTLY once.
      const secondVault = HostCredentialVault.open({
        root: join(dir, "host-store"),
        durableCredentialStore: "platform-isolated",
      });
      const deliveries: OutcomeDispatchRequest[] = [];
      const secondHost = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: join(dir, "host-store") }),
        deliver: (request, effect) => {
          deliveries.push(request);
          // The platform names the execution it created, so the registry holds
          // the host fact from here on.
          secondHost.confirmStarted(effect, { executionId: "task:" + request.attemptId });
        },
      });
      const secondRuntime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: secondHost,
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: TEST_CREDENTIAL_SOURCE,
        credentialIsolation: secondVault.capability(),
        completionPolicies: AUTHORIZED,
      });
      const resumed = secondRuntime.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.dispatched.map((request) => request.attemptId)).toEqual(["work#1"]);
      expect(resumed.reconciled).toEqual([]);
      expect(resumed.refusals).toEqual([]);
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1"]);
      // The credential the second process delivered is the one the FIRST
      // process minted, resolved from the durable vault — not a fresh one.
      expect(deliveries[0]?.credential).toBe(firstDeliveries[0]?.credential);
      expect(ledger.pendingEffects(GRAPH_ID).map((effect) => effect.status)).toEqual([
        "started",
      ]);

      // A SECOND recovery creates nothing: the durable index reports created.
      const thirdRuntime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: secondHost,
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: TEST_CREDENTIAL_SOURCE,
        credentialIsolation: secondVault.capability(),
        completionPolicies: AUTHORIZED,
      });
      const again = thirdRuntime.resume(NOW + 2);
      expect(again.kind).toBe("resumed");
      if (again.kind !== "resumed") return;
      expect(again.dispatched).toEqual([]);
      expect(deliveries).toHaveLength(1);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not re-dispatch when a memory-only index cannot vouch for the effect", async () => {
    const dir = makeTmpDir("host-restart-memory-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const plan = buildDeclaredOutcomeGraph({
        declaration: naturalDeclaration(),
        completionPolicies: AUTHORIZED,
      }).plan;
      const vault = HostCredentialVault.open({ root: join(dir, "host-store") });
      // FIRST PROCESS: the delivery throws, so the effect is committed and left
      // PENDING — the one state in which the host's answer decides whether the
      // attempt is dispatched again.
      const firstRuntime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: new HostOutcomeDispatch({
          executions: HostExecutionIndex.open({ root: join(dir, "host-store") }),
          deliver: () => {
            throw new Error("the platform refused the delivery");
          },
        }),
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: TEST_CREDENTIAL_SOURCE,
        credentialIsolation: vault.capability(),
        completionPolicies: AUTHORIZED,
      });
      expect(() => firstRuntime.start(NOW)).toThrow();
      expect(ledger.pendingEffects(GRAPH_ID).map((effect) => effect.status)).toEqual([
        "pending",
      ]);

      // SECOND PROCESS, MEMORY-ONLY INDEX: it cannot see whether an earlier
      // process created the execution, so it answers `unknown` rather than
      // `absent` and the recovery reports the effect instead of dispatching it
      // a second time.
      let redelivered = 0;
      const restarted = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: new HostOutcomeDispatch({
          executions: HostExecutionIndex.open({
            root: join(dir, "host-store"),
            durability: "memory",
          }),
          deliver: () => {
            redelivered += 1;
          },
        }),
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: TEST_CREDENTIAL_SOURCE,
        credentialIsolation: vault.capability(),
        completionPolicies: AUTHORIZED,
      });
      const resumed = restarted.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.dispatched).toEqual([]);
      expect(redelivered).toBe(0);
      expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
        "dispatch-unreconciled",
      ]);
      if (resumed.refusals[0] !== undefined) {
        expect(resumed.refusals[0].message).toContain("in memory only");
      }
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the settlement when the host's invocation is no longer the dispatching one", async () => {
    await withHostRun(async ({ runtime, bridge, holder }) => {
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      // The recorded binding is the dispatch's, so a completion judged with NO
      // invocation identity is refused by name rather than settled without the
      // check the host declared.
      holder.clear();
      const report = await bridge.complete({ graphId: GRAPH_ID, attemptId: "work#1" });
      expect(report.kind).toBe("settled");
      if (report.kind !== "settled") return;
      expect(report.settlement.kind).toBe("refused");
      if (report.settlement.kind !== "refused") return;
      expect(report.settlement.refusals.map((refusal) => refusal.code)).toEqual([
        "host-identity-absent",
      ]);
      // Nothing moved: the attempt is still the one in flight.
      expect(
        runtime.state()?.nodes.find((node) => node.nodeId === "work")?.status,
      ).toBe("dispatched");
    });
  });
});

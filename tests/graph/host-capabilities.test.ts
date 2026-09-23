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
 * 1. a credential is resolvable for EXACTLY the attempt it was issued, and a
 *    restart of the host process can still resolve it from the mirror file;
 * 2. the execution index answers `created` / `absent` / `unknown`, and a
 *    memory-only index never guesses `absent` for what an earlier process may
 *    have created;
 * 3. a dispatch adapter delivers at most once per stable effect id, and a
 *    delivery that threw leaves the effect un-recorded so exactly one recovery
 *    create can follow;
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  HOST_CREDENTIAL_MIRROR_FILE,
  HostCredentialVault,
} from "../../src/graph/host/credential-vault.ts";
import {
  HOST_EXECUTION_INDEX_FILE,
  HostExecutionIndex,
} from "../../src/graph/host/execution-index.ts";
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

      // The capability it backs is a readable version-2 adapter whose store is
      // the vault's own two functions.
      const read = readCredentialIsolationAdapter(vault.capability());
      expect(read?.version).toBe(2);
      if (read?.version !== 2) return;
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

  it("mirrors to a separate 0600 file so a restarted host can still re-deliver", () => {
    const dir = makeTmpDir("host-vault-restart-");
    try {
      const first = HostCredentialVault.open({ root: dir });
      first.remember({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" }, "cred-work-1");

      // A SECOND host process over the same root — a restart — resolves it from
      // the mirror file. The file is separate from every ledger and report.
      const restarted = HostCredentialVault.open({ root: dir });
      expect(
        restarted.resolve({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" }),
      ).toBe("cred-work-1");
      expect(readFileSync(join(dir, HOST_CREDENTIAL_MIRROR_FILE), "utf8")).toContain(
        "cred-work-1",
      );

      // A MEMORY-ONLY vault holds nothing across processes: it can only ever
      // answer for what it remembered itself. That is the honest trade the
      // module documents, pinned here so it cannot silently change.
      const memory = HostCredentialVault.open({ root: dir, durability: "memory" });
      expect(
        memory.resolve({ graphId: GRAPH_ID, nodeId: "work", attemptId: "work#1" }),
      ).toBeUndefined();
      expect(memory.size).toBe(0);
      expect(readCredentialIsolationAdapter(memory.capability())?.version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a mirror file it cannot read instead of opening as empty", () => {
    const dir = makeTmpDir("host-vault-corrupt-");
    try {
      writeFileSync(join(dir, HOST_CREDENTIAL_MIRROR_FILE), "{ not json", "utf8");
      expect(() => HostCredentialVault.open({ root: dir })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The execution index ─────────────────────────────────────────────────────

describe("host execution index — facts about what the host created", () => {
  it("answers created, absent and unknown without guessing", () => {
    const dir = makeTmpDir("host-index-");
    try {
      const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
      const durable = HostExecutionIndex.open({ root: dir });
      // A durable index wrote every create it ever made, so an unrecorded
      // effect is genuinely absent — which is what lets a recovery create once.
      expect(durable.lookup(effect).kind).toBe("absent");
      expect(durable.record(effect)).toBe(true);
      expect(durable.lookup(effect).kind).toBe("created");
      expect(durable.record(effect)).toBe(false);

      // A memory-only index cannot see an earlier process's creations, so it
      // says so rather than answering "absent" and risking a second execution.
      const memory = HostExecutionIndex.open({ root: dir, durability: "memory" });
      const unknown = memory.lookup(effect);
      expect(unknown.kind).toBe("unknown");
      if (unknown.kind === "unknown") {
        expect(unknown.reason).toContain("in memory only");
      }
      expect(memory.record(effect)).toBe(true);
      expect(memory.lookup(effect).kind).toBe("created");

      // The durable record survives a reopen.
      const reopened = HostExecutionIndex.open({ root: dir });
      expect(reopened.lookup(effect).kind).toBe("created");
      expect(readFileSync(join(dir, HOST_EXECUTION_INDEX_FILE), "utf8")).toContain(
        effect.effectId,
      );

      // Un-recording is the delivery-failure path: the effect becomes absent
      // again so a recovery can create it exactly once.
      durable.unrecord(effect);
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
      host.create(request, effect);
      // A second create for the SAME effect is a no-op — the contract's
      // idempotency rule is enforced here, not assumed of the caller.
      expect(deliveries).toHaveLength(1);
      expect(bindings).toEqual(["work@work#1"]);
      expect(host.lookup(effect).kind).toBe("created");

      // A different attempt is a different effect and IS delivered.
      const second = dispatchEffectKeyOf(GRAPH_ID, "ship#2");
      host.create({ ...request, nodeId: "ship", attemptId: "ship#2" }, second);
      expect(deliveries.map((entry) => entry.attemptId)).toEqual(["work#1", "ship#2"]);
      expect(host.lookup(second).kind).toBe("created");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un-records a delivery that threw, so exactly one later create can follow", () => {
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
      // The execution demonstrably did not start, so the effect is ABSENT
      // again: a recovery creates exactly once rather than never.
      expect(host.lookup(effect).kind).toBe("absent");
      host.create(request, effect);
      expect(attempts).toBe(2);
      expect(host.lookup(effect).kind).toBe("created");
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
      // for. The adapter un-records the effect, so the durable index says
      // absent, and the ledger row stays pending.
      const firstVault = HostCredentialVault.open({ root: join(dir, "host-store") });
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
      const secondVault = HostCredentialVault.open({ root: join(dir, "host-store") });
      const deliveries: OutcomeDispatchRequest[] = [];
      const secondHost = new HostOutcomeDispatch({
        executions: HostExecutionIndex.open({ root: join(dir, "host-store") }),
        deliver: (request) => {
          deliveries.push(request);
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

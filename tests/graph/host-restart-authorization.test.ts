/**
 * P2 items 6 and 8 — the parts of restart recovery that are decided IN PROCESS:
 * the three-surface agreement (G14) and the §3.3 restart-authorization policy.
 *
 * The process boundary itself is in host-restart-cross-process.test.ts; this
 * file covers what a single process can decide deterministically.
 *
 * G14 — THE CACHE IS NOT AN AUTHORITY. A runtime is opened once per graph and
 * kept. Before the fix, damaging the graph_definitions row AFTER the process had
 * cached its runtime left the boot sweep reporting "resumed:executing" while the
 * audit blocked and graph_status refused: three surfaces, three answers, one
 * graph. The cases below damage the row mid-process and require all three to say
 * BLOCKED — and they pin the store-level half too, where a store the format gate
 * refuses must not read as "this workspace has no graphs".
 *
 * §3.3 — RE-ISSUE ONLY ON A PROOF. A recovered attempt whose credential the host
 * cannot produce is re-issued ONLY when the effect was never handed over AND the
 * host proves no execution exists; the re-issued digest replaces the recorded
 * verifier in the same transaction that adopts the value, so the old generation
 * stops verifying. When the host's answer is "unknown", re-issue and re-delivery
 * are FORBIDDEN and the block is reported.
 *
 * PRIVACY: every fixture is a temp directory, no case prints or asserts a
 * credential VALUE, and the only credential facts asserted are digests and
 * booleans.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { auditGraphStore } from "../../src/graph/audit/drain-audit.ts";
import { HostCredentialVault } from "../../src/graph/host/credential-vault.ts";
import { HostOutcomeDispatch } from "../../src/graph/host/dispatch-host.ts";
import { HostExecutionIndex } from "../../src/graph/host/execution-index.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { attemptCredentialDigest } from "../../src/graph/outcome/attempt-credential.ts";
import { dispatchEffectKeyOf } from "../../src/graph/outcome/dispatch-effects.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../src/graph/tools/declare-graph.ts";
import { scanPersistedStates } from "../../src/graph/tools/persisted-state.ts";
import {
  XPROC_GRAPH_ID,
  XPROC_POLICIES,
  persistXprocGraph,
  xprocDeclaration,
} from "./helpers/host-restart-xproc-worker.ts";

const NOW = 1_700_000_000_000;

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

/** One node with one EXPLICIT outcome: only a worker submission settles it. */
function explicitDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.restart-explicit",
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };
}

/** The node entry of one graph, read from the store with a fresh connection. */
async function readNode(
  storeRoot: string,
  graphId: string,
): Promise<Record<string, unknown> | undefined> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    const record = ledger.readGraphState(graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const entries = Array.isArray(body?.["nodes"]) ? (body["nodes"] as unknown[]) : [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      if ((entry as Record<string, unknown>)["nodeId"] === "work") {
        return entry as Record<string, unknown>;
      }
    }
    return undefined;
  } finally {
    ledger.close();
  }
}

/** The node's recorded credential digest, or an absent answer. */
async function recordedDigest(
  storeRoot: string,
  graphId: string,
): Promise<string | undefined> {
  const node = await readNode(storeRoot, graphId);
  const digest = node?.["attemptCredentialDigest"];
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
}

/** The accepted-event count of one graph, read with a fresh connection. */
async function eventCount(storeRoot: string, graphId: string): Promise<number> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    return ledger.acceptedEvents(graphId).length;
  } finally {
    ledger.close();
  }
}

/** The effect statuses of one graph, read with a fresh connection. */
async function effectStatuses(storeRoot: string, graphId: string): Promise<readonly string[]> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    return ledger.pendingEffects(graphId).map((effect) => effect.effectId + "@" + effect.status);
  } finally {
    ledger.close();
  }
}

// ── G14: the three surfaces agree ───────────────────────────────────────────

describe("G14 — a definition damaged after the runtime was cached", () => {
  it("makes the audit, the status query and the boot sweep all report BLOCKED, not three answers", async () => {
    const dir = makeTmpDir("g14-definition-");
    const storeRoot = join(dir, "host-store");
    persistXprocGraph(storeRoot);

    const delivered: string[] = [];
    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request) => {
        delivered.push(request.attemptId);
      },
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      // CONTROL: the declaring process gives the graph its first execution, so
      // the runtime for it is now CACHED inside this process — and a second
      // sweep over the intact definition resumes it.
      const started = await host.startDeclaredGraph(XPROC_GRAPH_ID, {
        sessionId: "session.control",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");
      const control = await host.recoverDeclaredGraphs();
      expect(control.resumed).toEqual([XPROC_GRAPH_ID + ":executing"]);
      expect(control.refused).toEqual([]);
      expect(control.storeBlocked).toBeUndefined();

      // DAMAGE: the row stops naming the content it holds (a foreign writer or
      // corruption — the store itself refuses to REPLACE a definition in place).
      const store = GraphStore.openFile(storeRoot);
      try {
        store.run(
          "UPDATE graph_definitions SET plan_revision = ? WHERE graph_id = ?",
          "foreign-plan-revision",
          XPROC_GRAPH_ID,
        );
      } finally {
        store.close();
      }

      // SURFACE ONE: the boot sweep. The cached runtime must NOT be used: its
      // plan is no longer the one the store holds.
      const sweep = await host.recoverDeclaredGraphs();
      expect(sweep.resumed).toEqual([]);
      expect(sweep.started).toEqual([]);
      expect(sweep.refused).toHaveLength(1);
      expect(sweep.refused[0]).toContain(XPROC_GRAPH_ID);
      expect(sweep.storeBlocked).toBeUndefined();
      // The sweep dispatched nothing new for either visit.
      expect(delivered).toEqual(["work#1"]);

      // SURFACE TWO: the drain audit classifies the graph as BLOCKED. Its
      // ledger directory is stated explicitly because this fixture keeps the
      // store under the host root rather than the workspace's default.
      const audit = await auditGraphStore({
        directory: dir,
        ledgerDirectory: storeRoot,
        now: () => NOW,
      });
      expect(audit.verdict).toBe("blocked");
      expect(audit.totals.blocked).toBe(1);
      expect(audit.entries.map((entry) => entry.graphId)).toEqual([XPROC_GRAPH_ID]);
      expect(audit.entries[0]?.classification).toBe("blocked");

      // SURFACE THREE: the status/scan query SKIPS the graph by name instead of
      // projecting a position for it.
      const scan = scanPersistedStates(storeRoot);
      expect(scan.count).toBe(1);
      expect(scan.loaded).toEqual([]);
      expect(scan.skippedGraphs).toEqual([XPROC_GRAPH_ID]);
    } finally {
      host.close();
    }
  });

  it("refuses a definition row replaced with DIFFERENT content, even though it still decodes", async () => {
    const dir = makeTmpDir("g14-changed-");
    const storeRoot = join(dir, "host-store");
    persistXprocGraph(storeRoot);

    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      await host.recoverDeclaredGraphs();
      // A DIFFERENT plan revision written under the same graph id: the row may
      // still decode, but it is not the one the cached run path was opened from.
      // A foreign writer, not a legal update.
      const other = buildDeclaredOutcomeGraph({
        declaration: xprocDeclaration(),
        completionPolicies: XPROC_POLICIES,
      });
      const store = GraphStore.openFile(storeRoot);
      try {
        store.run(
          "UPDATE graph_definitions SET plan_revision = ? WHERE graph_id = ?",
          "foreign-plan-revision-" + other.plan.planRevision.slice(0, 8),
          XPROC_GRAPH_ID,
        );
      } finally {
        store.close();
      }
      const sweep = await host.recoverDeclaredGraphs();
      expect(sweep.resumed).toEqual([]);
      expect(sweep.refused).toHaveLength(1);
      expect(sweep.refused[0]).toContain("no longer readable");
    } finally {
      host.close();
    }
  });

  it("reports a store the format gate refuses instead of answering 'no graphs exist'", async () => {
    const dir = makeTmpDir("g14-store-");
    const storeRoot = join(dir, "host-store");
    persistXprocGraph(storeRoot);

    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      await host.recoverDeclaredGraphs();
      // The store stops being a format this build reads (an unknown version):
      // the audit and the status query already refuse that workspace, so the
      // sweep must not answer "nothing to do".
      const store = GraphStore.openFile(storeRoot);
      try {
        store.run("UPDATE ledger_meta SET format_version = 99");
      } finally {
        store.close();
      }
      const sweep = await host.recoverDeclaredGraphs();
      expect(sweep.started).toEqual([]);
      expect(sweep.resumed).toEqual([]);
      expect(sweep.refused).toEqual([]);
      expect(sweep.storeBlocked).toContain("unsupported");
    } finally {
      host.close();
    }
  });
});

// ── §3.3: the restart authorization policy ─────────────────────────────────

describe("§3.3 — a lost credential is re-issued only on a proven absence", () => {
  it("re-issues for an UNSTARTED effect the host proves absent, invalidating the old generation", async () => {
    const dir = makeTmpDir("reissue-allowed-");
    const storeRoot = join(dir, "host-store");
    persistXprocGraph(storeRoot);
    const effect = dispatchEffectKeyOf(XPROC_GRAPH_ID, "work#1");

    // ── PROCESS ONE: the delivery refuses SYNCHRONOUSLY, which is the seam's own
    // proof that nothing was handed to the platform.
    const firstDeliveries: string[] = [];
    const firstCredentials: string[] = [];
    const hostOne = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request) => {
        firstDeliveries.push(request.attemptId);
        firstCredentials.push(request.credential);
        throw new Error("platform refused the request before accepting it");
      },
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      await expect(
        hostOne.startDeclaredGraph(XPROC_GRAPH_ID, {
          sessionId: "session.one",
          agent: "agent.declarer",
        }),
      ).rejects.toThrow();
      // The effect is COMMITTED and never handed over; the create right was
      // released by the seam's proof.
      expect(firstDeliveries).toEqual(["work#1"]);
      expect(await effectStatuses(storeRoot, XPROC_GRAPH_ID)).toEqual([
        "dispatch:work#1@pending",
      ]);
      expect(hostOne.dispatch.lookup(effect).kind).toBe("absent");
    } finally {
      hostOne.close();
    }
    const digestBefore = await recordedDigest(storeRoot, XPROC_GRAPH_ID);
    expect(digestBefore).toBe(attemptCredentialDigest(firstCredentials[0] ?? ""));

    // ── PROCESS TWO: a NEW host over the same root cannot resolve the value (the
    // shipped store keeps none) and asks the host whether an execution exists.
    const secondDeliveries: string[] = [];
    const secondCredentials: string[] = [];
    const hostTwo = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request) => {
        secondDeliveries.push(request.attemptId);
        secondCredentials.push(request.credential);
      },
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      expect(
        hostTwo.credentials.resolve({
          graphId: XPROC_GRAPH_ID,
          nodeId: "work",
          attemptId: "work#1",
        }),
      ).toBeUndefined();
      const sweep = await hostTwo.recoverDeclaredGraphs();
      // RE-ISSUED AND RE-DELIVERED: the effect was never handed over and the
      // host proved no execution exists, so exactly one create follows.
      expect(sweep.effectRefusals).toEqual([]);
      expect(sweep.refused).toEqual([]);
      expect(sweep.resumed).toEqual([XPROC_GRAPH_ID + ":executing"]);
      expect(secondDeliveries).toEqual(["work#1"]);
      expect(secondCredentials[0]).not.toBe(firstCredentials[0]);
      expect(await effectStatuses(storeRoot, XPROC_GRAPH_ID)).toEqual([
        "dispatch:work#1@started",
      ]);
      // THE OLD GENERATION IS INVALIDATED: the recorded verifier is the NEW
      // credential's digest, so the superseded value matches nothing.
      const digestAfter = await recordedDigest(storeRoot, XPROC_GRAPH_ID);
      expect(digestAfter).not.toBe(digestBefore);
      expect(digestAfter).toBe(attemptCredentialDigest(secondCredentials[0] ?? ""));
      expect(digestBefore).not.toBe(attemptCredentialDigest(secondCredentials[0] ?? ""));
    } finally {
      hostTwo.close();
    }
  });

  it("FORBIDS re-issue and re-delivery when the host's answer is unknown", async () => {
    const dir = makeTmpDir("reissue-forbidden-");
    const plan = buildDeclaredOutcomeGraph({
      declaration: xprocDeclaration(),
      completionPolicies: XPROC_POLICIES,
    }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      // ── PROCESS ONE: the same synchronous refusal, but this host's execution
      // registry is MEMORY-ONLY, so a later process cannot see the row at all.
      const firstDeliveries: string[] = [];
      const firstIndex = HostExecutionIndex.open({ root: dir, durability: "memory" });
      const firstVault = HostCredentialVault.open({ root: dir, durability: "memory" });
      const firstRuntime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: new HostOutcomeDispatch({
          executions: firstIndex,
          deliver: (request) => {
            firstDeliveries.push(request.attemptId);
            throw new Error("platform refused the request before accepting it");
          },
        }),
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        credentialIsolation: firstVault.capability(),
        completionPolicies: XPROC_POLICIES,
      });
      expect(() => firstRuntime.start(NOW)).toThrow();
      expect(firstDeliveries).toEqual(["work#1"]);
      expect(await effectStatuses(dir, XPROC_GRAPH_ID)).toEqual([
        "dispatch:work#1@pending",
      ]);

      // ── PROCESS TWO: a fresh registry that never saw the row answers UNKNOWN
      // for the effect, and "the create failed" is not "no execution exists".
      const secondDeliveries: string[] = [];
      const secondIndex = HostExecutionIndex.open({ root: dir, durability: "memory" });
      const secondVault = HostCredentialVault.open({ root: dir, durability: "memory" });
      const secondRuntime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: new HostOutcomeDispatch({
          executions: secondIndex,
          deliver: (request) => {
            secondDeliveries.push(request.attemptId);
          },
        }),
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW + 1,
        credentialIsolation: secondVault.capability(),
        completionPolicies: XPROC_POLICIES,
      });
      const resumed = secondRuntime.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-reissue-forbidden",
      ]);
      expect(resumed.dispatched).toEqual([]);
      // NOTHING WAS RE-ISSUED AND NOTHING WAS RE-DELIVERED: the effect is
      // exactly where it was, and the recorded verifier did not move.
      expect(secondDeliveries).toEqual([]);
      expect(await effectStatuses(dir, XPROC_GRAPH_ID)).toEqual([
        "dispatch:work#1@pending",
      ]);
    } finally {
      ledger.close();
    }
  });

  it("never re-issues for an effect the platform may already hold", async () => {
    const dir = makeTmpDir("reissue-started-");
    const storeRoot = join(dir, "host-store");
    persistXprocGraph(storeRoot);

    const hostOne = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      const started = await hostOne.startDeclaredGraph(XPROC_GRAPH_ID, {
        sessionId: "session.one",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");
      // The create RETURNED, so an execution may exist. It is never confirmed,
      // which leaves the row "creating" — the honest "result unknown".
      expect(await effectStatuses(storeRoot, XPROC_GRAPH_ID)).toEqual([
        "dispatch:work#1@started",
      ]);
    } finally {
      hostOne.close();
    }

    const secondDeliveries: string[] = [];
    const hostTwo = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: (request) => {
        secondDeliveries.push(request.attemptId);
      },
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      const sweep = await hostTwo.recoverDeclaredGraphs();
      expect(sweep.effectRefusals.map((refusal) => refusal.code)).toEqual([
        "credential-reissue-forbidden",
      ]);
      expect(sweep.effectRefusals[0]?.message).toContain("started");
      expect(secondDeliveries).toEqual([]);
      expect(await effectStatuses(storeRoot, XPROC_GRAPH_ID)).toEqual([
        "dispatch:work#1@started",
      ]);
    } finally {
      hostTwo.close();
    }
  });
});

// ── A completion is applied, or reported — never fabricated ────────────────

describe("restart recovery — a completion is applied or reported, never fabricated", () => {
  it("does not settle an EXPLICIT node from a terminal execution: the plan authorized no mapping", async () => {
    const dir = makeTmpDir("explicit-terminal-");
    const storeRoot = join(dir, "host-store");
    const graphId = "graph.restart-explicit";
    persistDeclaredGraph(
      buildDeclaredOutcomeGraph({ declaration: explicitDeclaration() }),
      storeRoot,
    );
    const effect = dispatchEffectKeyOf(graphId, "work#1");

    const hostOne = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
    });
    try {
      const started = await hostOne.startDeclaredGraph(graphId, {
        sessionId: "session.one",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");
      expect(hostOne.confirmExecution(effect, { executionId: "exec-explicit" })).toBe(true);
    } finally {
      hostOne.close();
    }

    const hostTwo = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
      // The platform says the execution finished — and the plan still does not
      // authorize a natural completion for this node.
      observeExecution: () => Object.freeze({ kind: "terminal" as const }),
    });
    try {
      const sweep = await hostTwo.recoverDeclaredGraphs();
      expect(sweep.completed).toEqual([]);
      expect(sweep.refused).toEqual([]);
      expect(sweep.effectRefusals.map((refusal) => refusal.code)).toEqual([
        "credential-reissue-forbidden",
        "completion-unsettled",
      ]);
      expect(sweep.effectRefusals[1]?.message).toContain("natural-completion-unauthorized");
      // NOTHING WAS FABRICATED: the attempt is still in flight, with no accepted
      // event and no settlement.
      const node = await readNode(storeRoot, graphId);
      expect(node?.["status"]).toBe("dispatched");
      expect(node?.["attemptId"]).toBe("work#1");
      expect(await eventCount(storeRoot, graphId)).toBe(0);
    } finally {
      hostTwo.close();
    }
  });

  it("reports an attempt with no CONFIRMED execution as unbound instead of settling it", async () => {
    const dir = makeTmpDir("unconfirmed-");
    const storeRoot = join(dir, "host-store");
    persistXprocGraph(storeRoot);

    const hostOne = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      const started = await hostOne.startDeclaredGraph(XPROC_GRAPH_ID, {
        sessionId: "session.one",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");
      // No confirmExecution: the platform never named the execution, so the row
      // stays "creating" and there is no host fact to authenticate a completion.
    } finally {
      hostOne.close();
    }

    const hostTwo = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
      declareInvocationIdentity: false,
      completionPolicies: XPROC_POLICIES,
    });
    try {
      const report = await hostTwo.complete(XPROC_GRAPH_ID, "work#1");
      expect(report.kind).toBe("unbound");
      if (report.kind !== "unbound") return;
      expect(report.reason).toContain("no CONFIRMED host execution");
      const node = await readNode(storeRoot, XPROC_GRAPH_ID);
      expect(node?.["status"]).toBe("dispatched");
      expect(await eventCount(storeRoot, XPROC_GRAPH_ID)).toBe(0);
    } finally {
      hostTwo.close();
    }
  });
});

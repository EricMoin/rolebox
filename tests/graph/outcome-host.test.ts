/**
 * The shipped host assembly (`src/graph/host/outcome-host.ts`) driven the way a
 * real host drives it — through `startDeclaredGraph` and `complete`, not through
 * its parts.
 *
 * THE DEFECT THIS FILE PINS SHUT. The completion bridge's own test held an
 * invocation for the whole run, so it never exercised the production shape: a
 * completion is observed LATER, out of band, when no invocation is in effect.
 * The runtime still compares the host's current identity with the one recorded
 * when the attempt was armed, so a host that does not re-enter that attribution
 * gets `host-identity-absent` and the graph stops forever.
 *
 * It also pins the DECISION the shipped entries make about the identity
 * capability: a dispatched worker submits from its OWN invocation, so a host
 * that recorded a declaring identity would refuse the very submission its
 * delivery handoff asks the worker to make. The entries therefore declare no
 * identity, and the bearer credential remains the binding.
 *
 * The record the operator reads is covered by `outcome-projection.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { GraphSubmitOutcomeResult } from "../../src/graph/tools/submit-outcome.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import type { HostDispatchInvocation } from "../../src/graph/host/dispatch-host.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import {
  AUTHORIZED,
  EMPTY_VALIDATORS,
  GRAPH_ID,
  PLAIN_GRAPH_ID,
  makeTmpDir,
  naturalDeclaration,
  openHost,
  plainDeclaration,
} from "./helpers/host-graph-fixture.ts";

// ── An observed completion settles ──────────────────────────────────────────

describe("OutcomeHost.complete — an out-of-band completion settles", () => {
  it("settles with no invocation in effect and arms the successor", async () => {
    const dir = makeTmpDir("outcome-host-complete-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    persistDeclaredGraph(graph, dir);
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = openHost({ dir, storeRoot, deliveries, completionPolicies: AUTHORIZED });
    try {
      const started = await host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });
      expect(started.kind).toBe("started");
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1"]);
      const workCredential = deliveries[0]?.credential ?? "";
      expect(workCredential.length).toBeGreaterThan(0);

      // THE OBSERVATION ARRIVES LATER: no invocation is in effect any more.
      host.clearInvocation();
      const first = await host.complete(GRAPH_ID, "work#1");
      expect(first.kind).toBe("settled");
      if (first.kind !== "settled") return;
      expect(first.nodeId).toBe("work");
      expect(first.settlement.kind).toBe("accepted");
      if (first.settlement.kind !== "accepted") return;
      expect(first.settlement.replayed).toBe(false);
      // The successor was armed by the same acceptance — and its own binding
      // captured the attribution in effect during this settlement.
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1", "ship#2"]);

      host.clearInvocation();
      const second = await host.complete(GRAPH_ID, "ship#2");
      expect(second.kind).toBe("settled");
      if (second.kind !== "settled") return;
      expect(second.settlement.kind).toBe("accepted");
      if (second.settlement.kind !== "accepted") return;
      expect(second.settlement.state.phase).toBe("complete");

      // Neither report carries the bearer credential: it lives in the vault
      // and in the dispatch request, and in nothing this layer reports.
      const reports = JSON.stringify([first, second]);
      expect(reports).not.toContain(workCredential);
      const shipCredential = deliveries[1]?.credential ?? "";
      expect(shipCredential.length).toBeGreaterThan(0);
      expect(reports).not.toContain(shipCredential);
    } finally {
      host.close();
    }
  });
});

// ── The shipped hosts do not declare an identity they cannot substantiate ───

describe("the invocation-identity decision", () => {
  it("accepts a worker-attributed submission when the host declares no identity", async () => {
    const dir = makeTmpDir("outcome-host-optout-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({ declaration: plainDeclaration() });
    persistDeclaredGraph(graph, dir);
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = openHost({
      dir,
      storeRoot,
      deliveries,
      declareInvocationIdentity: false,
    });
    try {
      const started = await host.startDeclaredGraph(PLAIN_GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });
      expect(started.kind).toBe("started");
      const credential = deliveries[0]?.credential ?? "";
      expect(credential.length).toBeGreaterThan(0);

      const toolset = createGraphToolSet({
        stateDir: dir,
        credentialIsolation: host.credentialIsolation,
        outcomeDispatch: host.dispatch,
        outcomeValidators: EMPTY_VALIDATORS,
      });
      // The worker submits from ITS OWN invocation: the shipped host declares no
      // identity capability, so nothing refuses it — the credential still binds
      // the submission to the attempt it was issued for.
      host.setInvocation({ sessionId: "worker-session", agent: "agent.work" });
      const result: GraphSubmitOutcomeResult = await toolset.graph_submit_outcome({
        graph_id: PLAIN_GRAPH_ID,
        node_id: "work",
        outcome_id: "done",
        credential,
      });
      expect(result.decision).toBe("accepted");
      expect(result.refusals).toEqual([]);
      host.clearInvocation();
    } finally {
      host.close();
    }
  });

  it("refuses a submission from another invocation when the host does declare one", async () => {
    const dir = makeTmpDir("outcome-host-identity-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({ declaration: plainDeclaration() });
    persistDeclaredGraph(graph, dir);
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = openHost({ dir, storeRoot, deliveries });
    try {
      await host.startDeclaredGraph(PLAIN_GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });
      const credential = deliveries[0]?.credential ?? "";
      const toolset = createGraphToolSet({
        stateDir: dir,
        credentialIsolation: host.credentialIsolation,
        hostIdentity: host.hostIdentity,
        outcomeDispatch: host.dispatch,
        outcomeValidators: EMPTY_VALIDATORS,
      });
      host.setInvocation({ sessionId: "worker-session", agent: "agent.work" });
      const refused = await toolset.graph_submit_outcome({
        graph_id: PLAIN_GRAPH_ID,
        node_id: "work",
        outcome_id: "done",
        credential,
      });
      expect(refused.decision).toBeUndefined();
      expect(refused.refusals.map((refusal) => refusal.code)).toContain(
        "host-identity-mismatch",
      );

      // The same submission from the dispatching invocation is accepted.
      host.setInvocation({ sessionId: "session-1", agent: "agent.orchestrator" });
      const accepted = await toolset.graph_submit_outcome({
        graph_id: PLAIN_GRAPH_ID,
        node_id: "work",
        outcome_id: "done",
        credential,
      });
      expect(accepted.decision).toBe("accepted");
      host.clearInvocation();
    } finally {
      host.close();
    }
  });
});

// ── Every dispatch window names the graph's declaring invocation ────────────
//
// THE DEFECT THIS FILE PINS SHUT (second half). A successor is armed by an
// acceptance, and the acceptance that ends the FIRST node is observed out of
// band. The host therefore records the declaring invocation PER GRAPH and hands
// it to the delivery on every create — the entry attempt, a successor armed by a
// completion, and a restart sweep — instead of relying on a window's ambient
// attribution, which is exactly what the real platform adapters need to compose
// the worker under its parent.

describe("OutcomeHost — the declaring invocation travels with every dispatch", () => {
  it("names the same invocation for the entry attempt and the out-of-band successor", async () => {
    const dir = makeTmpDir("outcome-host-origin-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    persistDeclaredGraph(graph, dir);
    const deliveries: OutcomeDispatchRequest[] = [];
    const invocations: Array<HostDispatchInvocation | undefined> = [];
    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      durability: "memory",
      validators: EMPTY_VALIDATORS,
      completionPolicies: AUTHORIZED,
      deliver: (request, _effect, invocation) => {
        deliveries.push(request);
        invocations.push(invocation);
      },
    });
    try {
      await host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });
      expect(invocations).toEqual([
        { sessionId: "session-1", agent: "agent.orchestrator" },
      ]);

      // The completion arrives with NO invocation in effect: the entry
      // attempt's successor must still be dispatched under the declaring one.
      host.clearInvocation();
      const settled = await host.complete(GRAPH_ID, "work#1");
      expect(settled.kind).toBe("settled");
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1", "ship#2"]);
      expect(invocations).toEqual([
        { sessionId: "session-1", agent: "agent.orchestrator" },
        { sessionId: "session-1", agent: "agent.orchestrator" },
      ]);
    } finally {
      host.close();
    }
  });

  it("hands NO invocation when the declaring call named none", async () => {
    const dir = makeTmpDir("outcome-host-no-origin-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({ declaration: plainDeclaration() });
    persistDeclaredGraph(graph, dir);
    const invocations: Array<HostDispatchInvocation | undefined> = [];
    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      durability: "memory",
      validators: EMPTY_VALIDATORS,
      deliver: (_request, _effect, invocation) => {
        invocations.push(invocation);
      },
    });
    try {
      // No session named: nothing is recorded, and the delivery is handed
      // nothing. A platform then refuses the dispatch by name; the host never
      // fabricates a parent for it.
      const started = await host.startDeclaredGraph(PLAIN_GRAPH_ID);
      expect(started.kind).toBe("started");
      expect(invocations).toEqual([undefined]);
      // NOTHING was recorded as the graph's declaring invocation. The store
      // FILE exists either way — the acceptance ledger is durable regardless of
      // the host's capability durability — so the honest check reads the
      // record itself.
      const store = GraphStore.openFile(storeRoot);
      try {
        expect(store.readInvocationOrigin(PLAIN_GRAPH_ID)).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      host.close();
    }
  });

  it("re-arms a pending effect after a restart under the recorded origin", async () => {
    const dir = makeTmpDir("outcome-host-restart-origin-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({ declaration: plainDeclaration() });
    persistDeclaredGraph(graph, dir);

    // THE FIRST PROCESS: the platform cannot start the worker (no live parent),
    // so the delivery throws. The state and its dispatch effect are already
    // committed, the effect stays pending, and the execution index drops the
    // record it took — the crash window the contract exists for.
    const firstHost = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      durability: "file",
      // A RESTART CASE: the second host must re-deliver the credential the
      // first process minted, so this fixture declares a platform-isolated
      // store. The shipped entries keep the honest default ("none").
      durableCredentialStore: "platform-isolated",
      validators: EMPTY_VALIDATORS,
      deliver: () => {
        throw new Error("the platform has no live parent for this graph");
      },
    });
    try {
      let failure: unknown;
      try {
        await firstHost.startDeclaredGraph(PLAIN_GRAPH_ID, {
          sessionId: "session-1",
          agent: "agent.orchestrator",
        });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("no live parent");
    } finally {
      firstHost.close();
    }
    // The declaring invocation outlived the process that named it: it is a row
    // of the workspace's one graph store, beside the run state it belongs to.
    expect(existsSync(graphStoreFilePath(storeRoot))).toBe(true);

    // THE RESTARTED PROCESS: the sweep reads the graph's origin back from the
    // host's own record and re-arms the pending effect under it.
    const invocations: Array<HostDispatchInvocation | undefined> = [];
    const secondHost = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      durability: "file",
      // A RESTART CASE: the second host must re-deliver the credential the
      // first process minted, so this fixture declares a platform-isolated
      // store. The shipped entries keep the honest default ("none").
      durableCredentialStore: "platform-isolated",
      validators: EMPTY_VALIDATORS,
      deliver: (_request, _effect, invocation) => {
        invocations.push(invocation);
      },
    });
    try {
      const report = await secondHost.recoverDeclaredGraphs();
      expect(report.started).toEqual([]);
      expect(report.resumed).toEqual([PLAIN_GRAPH_ID + ":executing"]);
      expect(report.refused).toEqual([]);
      expect(report.effectRefusals).toEqual([]);
      expect(invocations).toEqual([
        { sessionId: "session-1", agent: "agent.orchestrator" },
      ]);
    } finally {
      secondHost.close();
    }
  });

  it("reports the per-effect refusal of a graph whose dispatch the platform refused", async () => {
    const dir = makeTmpDir("outcome-host-effect-refusal-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({ declaration: plainDeclaration() });
    persistDeclaredGraph(graph, dir);

    // The graph is left with a committed state and a pending effect by a
    // process whose platform refused the dispatch, and NO invocation was ever
    // recorded for it.
    const firstHost = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      durability: "file",
      // A RESTART CASE: the second host must re-deliver the credential the
      // first process minted, so this fixture declares a platform-isolated
      // store. The shipped entries keep the honest default ("none").
      durableCredentialStore: "platform-isolated",
      validators: EMPTY_VALIDATORS,
      deliver: () => {
        throw new Error("nothing can be started here");
      },
    });
    try {
      let failure: unknown;
      try {
        await firstHost.startDeclaredGraph(PLAIN_GRAPH_ID);
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("nothing can be started here");
    } finally {
      firstHost.close();
    }

    // The sweep visits the graph and the graph's own resume refuses the effect.
    // The fact is AGGREGATED into the report instead of being reported as a
    // bare resumed with the work silently still pending.
    const secondHost = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      durability: "file",
      // A RESTART CASE: the second host must re-deliver the credential the
      // first process minted, so this fixture declares a platform-isolated
      // store. The shipped entries keep the honest default ("none").
      durableCredentialStore: "platform-isolated",
      validators: EMPTY_VALIDATORS,
      deliver: () => {
        throw new Error("nothing can be started here either");
      },
    });
    try {
      const report = await secondHost.recoverDeclaredGraphs();
      expect(report.resumed).toEqual([PLAIN_GRAPH_ID + ":executing"]);
      expect(report.refused).toEqual([]);
      expect(report.effectRefusals.map((refusal) => refusal.graphId)).toEqual([
        PLAIN_GRAPH_ID,
      ]);
      expect(report.effectRefusals.map((refusal) => refusal.code)).toEqual([
        "dispatch-failed",
      ]);
      expect(report.effectRefusals[0]?.message).toContain("dispatch:work#1");
      expect(report.divergences).toEqual([]);
    } finally {
      secondHost.close();
    }
  });
});


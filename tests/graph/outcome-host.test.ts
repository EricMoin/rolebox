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
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { GraphSubmitOutcomeResult } from "../../src/graph/tools/submit-outcome.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
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

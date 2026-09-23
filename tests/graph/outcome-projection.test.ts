/**
 * The record the operator surfaces read: the graph's own persisted state, kept
 * in step with the acceptance ledger as the run advances.
 *
 * THE DEFECT THIS FILE PINS SHUT. The engine-state container was written once by
 * `graph_declare` and never updated, so a graph that had already COMPLETED still
 * rendered as `idle` with every node `pending` — on all three `graph_status`
 * scopes — while `graph_audit` opened the ledger at the workspace default instead
 * of the host-declared store root the run actually wrote, and reported the graph
 * as "ledger absent, in flight".
 *
 * The projection is a DERIVED VIEW written after the transaction commits (see
 * `src/graph/persistence/outcome-projection.ts`); the ledger stays the authority.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStatePath,
  loadEngineStateForResume,
} from "../../src/graph/persistence/engine-persistence.ts";
import { persistOutcomeProjection } from "../../src/graph/persistence/outcome-projection.ts";
import { SqliteAcceptanceLedger, ledgerFilePath } from "../../src/graph/ledger/sqlite-ledger.ts";
import { readOutcomeGraphState } from "../../src/graph/outcome/graph-state.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { scanPersistedStates } from "../../src/graph/tools/persisted-state.ts";
import {
  AUTHORIZED,
  EMPTY_VALIDATORS,
  GRAPH_ID,
  makeTmpDir,
  naturalDeclaration,
  openHost,
} from "./helpers/host-graph-fixture.ts";

describe("the projected graph record", () => {
  it("reports the finished run to graph_status and graph_audit", async () => {
    const dir = makeTmpDir("outcome-host-store-");
    const storeRoot = join(dir, "host-store");
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = openHost({ dir, storeRoot, deliveries, completionPolicies: AUTHORIZED });
    // The declaring toolset holds the host capabilities, so the declared graph
    // in its SESSION registry is the one the run then advances.
    const toolset = createGraphToolSet({
      stateDir: dir,
      credentialIsolation: host.credentialIsolation,
      outcomeDispatch: host.dispatch,
      outcomeValidators: EMPTY_VALIDATORS,
      completionPolicies: AUTHORIZED,
    });
    toolset.graph_declare({ declaration: naturalDeclaration() });
    try {
      await host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });
      const workCredential = deliveries[0]?.credential ?? "";
      host.clearInvocation();
      await host.complete(GRAPH_ID, "work#1");
      host.clearInvocation();
      await host.complete(GRAPH_ID, "ship#2");

      // THE RECORD ITSELF: the plan's own container carries the run's position.
      const recordPath = engineStatePath(dir, GRAPH_ID);
      const loaded = loadEngineStateForResume(
        readFileSync(recordPath, "utf-8"),
        recordPath,
        DEFAULT_STORAGE_FORMAT_REGISTRY,
      );
      expect(loaded.kind).toBe("valid");
      if (loaded.kind !== "valid") return;
      expect(loaded.state.phase).toBe("complete");
      expect(
        [...loaded.state.nodes.values()]
          .map((node) => node.nodeId + ":" + node.status)
          .sort(),
      ).toEqual(["ship:completed", "work:completed"]);
      const summaries = scanPersistedStates(dir).loaded;
      expect(summaries.map((state) => state.graphId + ":" + state.phase)).toEqual([
        GRAPH_ID + ":complete",
      ]);

      // SESSION, PERSISTED AND ALL SCOPES read the run, not the declaration
      // snapshot the toolset registered.
      const sessionStatus = toolset.graph_status({ graph_id: GRAPH_ID });
      expect(sessionStatus).toContain("[phase: complete]");
      expect(sessionStatus).toContain("completed");
      const allStatus = toolset.graph_status({ graph_id: GRAPH_ID, scope: "all" });
      expect(allStatus).toContain("[phase: complete]");
      const persistedStatus = toolset.graph_status({
        graph_id: GRAPH_ID,
        scope: "persisted",
      });
      expect(persistedStatus).toContain("[phase: complete]");

      // THE AUDIT OPENS THE HOST DECLARED LEDGER, not the workspace default.
      const audit = await toolset.graph_audit();
      expect(audit.ledger).toBe("opened");
      expect(audit.ledgerFilePath).toBe(ledgerFilePath(storeRoot));
      const entry = audit.entries.find(
        (candidate) => candidate.file === "engine-" + GRAPH_ID + ".json",
      );
      expect(entry?.protocol).toBe("outcome");
      expect(entry?.classification).toBe("terminal");
      expect(entry?.phase).toBe("complete");
      expect(audit.verdict).toBe("drained");

      // NO SURFACE CARRIES THE CREDENTIAL, and every surface is non-empty.
      expect(workCredential.length).toBeGreaterThan(0);
      expect(readFileSync(recordPath, "utf-8")).not.toContain(workCredential);
      expect(readFileSync(ledgerFilePath(storeRoot), "utf-8")).not.toContain(
        workCredential,
      );
      expect(sessionStatus).not.toContain(workCredential);
      expect(JSON.stringify(audit)).not.toContain(workCredential);
    } finally {
      host.close();
    }
  });

  it("leaves a graph whose record is absent untouched", async () => {
    const dir = makeTmpDir("outcome-projection-source-");
    const storeRoot = join(dir, "host-store");
    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    persistDeclaredGraph(graph, dir);
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = openHost({ dir, storeRoot, deliveries, completionPolicies: AUTHORIZED });
    try {
      await host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });
      const opened = await SqliteAcceptanceLedger.openReadOnly(storeRoot);
      expect(opened.kind).toBe("opened");
      if (opened.kind !== "opened") return;
      try {
        const record = opened.ledger.readGraphState(GRAPH_ID);
        if (record === undefined) throw new Error("fixture: no ledger state row");
        const state = readOutcomeGraphState(record, graph.plan);
        const empty = makeTmpDir("outcome-projection-absent-");
        expect(persistOutcomeProjection(empty, state)).toBe(false);
      } finally {
        opened.ledger.close();
      }
    } finally {
      host.close();
    }
  });
});

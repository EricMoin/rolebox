/**
 * The record the operator surfaces read after P1 item 5: the graph's own
 * DEFINITION and RUN STATE in the workspace's one store.
 *
 * REPLACED TEST. This file used to pin the v2 container's live projection — the
 * `engine-<slug>.json` record `graph_declare` wrote and
 * `persistence/outcome-projection.ts` refreshed after every settlement. Both
 * are deleted: a declared graph's durable record is now its immutable definition
 * row plus its run-state row in `graph-acceptance-ledger.sqlite`, and the query
 * paths derive their `EngineState` view from those in memory only. The USER
 * CAPABILITY the old file stood for is unchanged and is what the cases below
 * cover:
 *
 * - a graph that already ran renders its REAL position on every `graph_status`
 *   scope and in `graph_audit` — never as `idle`/every-node-`pending`;
 * - the audit reads the store the run actually wrote;
 * - NO surface and no durable byte carries an attempt credential value;
 * - and (new) a RETIRED per-graph container is refused rather than
 *   auto-initialized over or rewritten.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  buildDeclaredOutcomeGraph,
  GraphDeclareRefusedError,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { engineStateDir, engineStatePath } from "../../src/graph/persistence/engine-persistence.ts";
import { ledgerFilePath } from "../../src/graph/ledger/sqlite-ledger.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { loadGraphStoreSync } from "../../src/graph/store/load.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
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
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import type { GraphStateRecord } from "../../src/graph/ledger/types.ts";

describe("the stored graph record", () => {
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

      // NO v2 CONTAINER WAS EVER WRITTEN. The graph's whole durable record is
      // the store, and the retired path does not exist beside it.
      expect(existsSync(engineStatePath(dir, GRAPH_ID))).toBe(false);
      expect(existsSync(graphStoreFilePath(storeRoot))).toBe(true);

      // THE RECORD ITSELF: the store carries the run's position.
      const store = GraphStore.openFile(storeRoot);
      let stateRow;
      let definition;
      try {
        stateRow = store.readGraphState(GRAPH_ID);
        definition = store.readDefinition(GRAPH_ID);
      } finally {
        store.close();
      }
      expect(definition?.planRevision).toBe(
        buildDeclaredOutcomeGraph({
          declaration: naturalDeclaration(),
          completionPolicies: AUTHORIZED,
        }).plan.planRevision,
      );
      expect(stateRow).toBeDefined();
      expect(readPhase(stateRow)).toBe("complete");

      const summaries = scanPersistedStates(storeRoot).loaded;
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

      // THE AUDIT READS THE HOST DECLARED STORE, and classifies the graph from
      // its stored definition plus its run-state row.
      const audit = await toolset.graph_audit();
      expect(audit.ledger).toBe("opened");
      expect(audit.ledgerFilePath).toBe(ledgerFilePath(storeRoot));
      const entry = audit.entries.find((candidate) => candidate.graphId === GRAPH_ID);
      expect(entry?.protocol).toBe("outcome");
      expect(entry?.classification).toBe("terminal");
      expect(entry?.phase).toBe("complete");
      expect(audit.verdict).toBe("drained");

      // NO SURFACE CARRIES THE CREDENTIAL, and every surface is non-empty.
      expect(workCredential.length).toBeGreaterThan(0);
      expect(readFileSync(graphStoreFilePath(storeRoot), "utf-8")).not.toContain(
        workCredential,
      );
      expect(sessionStatus).not.toContain(workCredential);
      expect(JSON.stringify(audit)).not.toContain(workCredential);
    } finally {
      host.close();
    }
  });

  it("REFUSES a graph whose retired v2 container is still on disk, and never rewrites it", () => {
    const dir = makeTmpDir("outcome-projection-retired-");
    const storeRoot = join(dir, "host-store");
    // A container in the previous layout: the workspace state directory, with
    // the store somewhere else — the shipped shape.
    const retiredPath = engineStatePath(dir, GRAPH_ID);
    mkdirSync(engineStateDir(dir), { recursive: true });
    const retiredText = JSON.stringify({
      version: 2,
      graphId: GRAPH_ID,
      phase: "executing",
      executionProtocolVersion: 2,
      compiledPlan: { planRevision: "retired-revision" },
    });
    writeFileSync(retiredPath, retiredText, "utf-8");

    const toolset = createGraphToolSet({
      stateDir: dir,
      credentialIsolation: testHostCredentialIsolation(storeRoot),
      outcomeDispatch: () => undefined,
      outcomeValidators: EMPTY_VALIDATORS,
      completionPolicies: AUTHORIZED,
    });
    let caught: unknown;
    try {
      toolset.graph_declare({ declaration: naturalDeclaration() });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof GraphDeclareRefusedError)) {
      throw new Error("expected GraphDeclareRefusedError, got " + String(caught));
    }
    expect(caught.reason).toBe("persisted-state-unreadable");
    expect(caught.message).toContain("engine-" + GRAPH_ID + ".json");
    // The refusal is a refusal to ACT: the retired file is byte-identical and
    // the store holds NO definition for the graph. (The store file itself exists
    // because the host's credential-isolation capability opens it — that is the
    // shipped assembly, and it is why the assertion is about records.)
    expect(readFileSync(retiredPath, "utf-8")).toBe(retiredText);
    const loaded = loadGraphStoreSync(storeRoot);
    expect(
      loaded.kind === "valid" ? [...loaded.value.definitionGraphIds()] : [],
    ).toEqual([]);
    if (loaded.kind === "valid") loaded.value.close();
  });

  it("refuses a store that already holds a retired container rather than opening it", () => {
    const dir = makeTmpDir("outcome-projection-beside-");
    const storeRoot = join(dir, "host-store");
    // The container sits IN the store root: the store's own gate refuses before
    // a connection exists, so nothing can be read as "no graph".
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(join(storeRoot, "engine-" + GRAPH_ID + ".json"), "{}", "utf-8");

    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    expect(persistDeclaredGraph(graph, storeRoot)).toBe(false);
    expect(existsSync(graphStoreFilePath(storeRoot))).toBe(false);
  });

  it("agrees with the audit and the sweep that an unreadable run state is unreadable", async () => {
    const dir = makeTmpDir("outcome-host-unreadable-state-");
    const storeRoot = join(dir, "host-store");
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = openHost({ dir, storeRoot, deliveries, completionPolicies: AUTHORIZED });
    const declaring = createGraphToolSet({
      stateDir: dir,
      credentialIsolation: host.credentialIsolation,
      outcomeDispatch: host.dispatch,
      outcomeValidators: EMPTY_VALIDATORS,
      completionPolicies: AUTHORIZED,
    });
    declaring.graph_declare({ declaration: naturalDeclaration() });
    try {
      await host.startDeclaredGraph(GRAPH_ID, {
        sessionId: "session-1",
        agent: "agent.orchestrator",
      });

      // The run HAS a real recorded position; bind its run-state ROW to a
      // foreign plan revision — a foreign writer or corruption, the condition
      // A19 names. Nothing else about the record changes.
      const store = GraphStore.openFile(storeRoot);
      try {
        const recorded = store.readGraphState(GRAPH_ID);
        if (recorded === undefined) throw new Error("fixture: no run-state row");
        store.writeGraphState({ ...recorded, planRevision: "foreign-plan-revision" });
      } finally {
        store.close();
      }

      // A reader that does NOT hold the graph in its session registry: the
      // post-restart shape, where every answer must come from the store.
      const reader = createGraphToolSet({
        stateDir: dir,
        credentialIsolation: host.credentialIsolation,
        outcomeDispatch: () => undefined,
        outcomeValidators: EMPTY_VALIDATORS,
        completionPolicies: AUTHORIZED,
      });

      // SESSION: nothing is declared in this process, so no position is shown.
      expect(reader.graph_status({ scope: "session" })).not.toContain("[phase: idle]");

      // PERSISTED and ALL: the graph is stored but unreadable, so the answer
      // names the skipped definition instead of inventing an idle position.
      for (const scope of ["persisted", "all"] as const) {
        const list = reader.graph_status({ scope });
        expect(list).not.toContain("[phase: idle]");
        expect(list).toContain(GRAPH_ID);
        expect(list).not.toContain("No graphs exist");
      }

      // TARGETED: no position either — the refusal names the condition.
      let caught: unknown;
      try {
        reader.graph_status({ graph_id: GRAPH_ID, scope: "persisted" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toContain("cannot read it");
      expect(String(caught)).not.toContain("[phase: idle]");

      // THE DECLARING PROCESS — the graph is in THIS process's session
      // registry, so its declaration-time snapshot (phase idle, every node
      // pending) is present and must not stand in for the unreadable run. This
      // is the operator case the reader above deliberately does not cover.
      for (const scope of ["session", "persisted", "all"] as const) {
        const list = declaring.graph_status({ scope });
        expect(list).not.toContain("[phase: idle]");
        expect(list).toContain(GRAPH_ID);
        expect(list).not.toContain("No graphs exist");
      }
      // The session list is the SAME honest note scope=persisted gives.
      expect(declaring.graph_status({ scope: "session" })).toBe(
        declaring.graph_status({ scope: "persisted" }),
      );
      // A TARGET refuses by name from every scope, session included, with the
      // by-name refusal scope=persisted already gave.
      const refusals = new Map<string, string>();
      for (const scope of ["session", "persisted", "all"] as const) {
        let declaringCaught: unknown;
        try {
          declaring.graph_status({ graph_id: GRAPH_ID, scope });
        } catch (error) {
          declaringCaught = error;
        }
        expect(declaringCaught).toBeInstanceOf(Error);
        const text = String(declaringCaught);
        expect(text).toContain("cannot read it");
        expect(text).toContain("graph_audit names the blocker");
        expect(text).not.toContain("[phase: idle]");
        refusals.set(scope, text);
      }
      expect(refusals.get("session")).toBe(refusals.get("persisted"));
      expect(refusals.get("all")).toBe(refusals.get("persisted"));
      // NODE targeting resolves the owning graph from the DECLARATION (the node
      // set is declaration content) and then refuses the unreadable record — it
      // never prints the snapshot's pending row.
      let nodeCaught: unknown;
      try {
        declaring.graph_status({ node_id: "work", scope: "session" });
      } catch (error) {
        nodeCaught = error;
      }
      expect(String(nodeCaught)).toContain("cannot read it");
      expect(String(nodeCaught)).not.toContain("pending");

      // THE AUDIT names the same condition by blocker...
      const audit = await reader.graph_audit();
      expect(audit.ledger).toBe("opened");
      expect(audit.verdict).toBe("blocked");
      expect(audit.blockers.map((blocker) => blocker.code)).toContain("state-malformed");

      // ...and the BOOT SWEEP refuses the graph instead of re-running it.
      const report = await host.recoverDeclaredGraphs();
      expect(report.started).toEqual([]);
      expect(report.resumed).toEqual([]);
      expect(report.refused.join(" ")).toContain(GRAPH_ID + ": plan-revision-mismatch");
    } finally {
      host.close();
    }
  });
});

/** The phase one stored run-state row records, or `undefined`. */
function readPhase(row: GraphStateRecord | undefined): string | undefined {
  if (row === undefined) return undefined;
  const body: unknown = row.body;
  if (typeof body !== "object" || body === null) return undefined;
  const phase = (body as Record<string, unknown>)["phase"];
  return typeof phase === "string" ? phase : undefined;
}

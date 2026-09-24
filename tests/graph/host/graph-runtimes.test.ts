import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../../src/graph/tools/declare-graph.ts";
import { OutcomeHost } from "../../../src/graph/host/outcome-host.ts";
import { HostGraphRuntimes } from "../../../src/graph/host/graph-runtimes.ts";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../../src/graph/store/schema.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/runtime.ts";
import { EMPTY_VALIDATORS, NOW, PLAIN_GRAPH_ID, plainDeclaration } from "../helpers/host-graph-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "host-runtime-"));
  roots.push(root);
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: plainDeclaration() }), root);
  const options = { validators: EMPTY_VALIDATORS, artifactRoot: root, clock: () => NOW };
  return { root, options, runtimes: new HostGraphRuntimes(root, options) };
}

describe("host runtime lifecycle", () => {
  it("shares concurrent opens and releases the ledger synchronously on close", async () => {
    const { runtimes } = runtimeFixture();
    try {
      const [first, second] = await Promise.all([
        runtimes.get(PLAIN_GRAPH_ID), runtimes.get(PLAIN_GRAPH_ID),
      ]);
      expect(first).toBe(second);
      runtimes.close();
      expect(() => first.ledger.readGraphState(PLAIN_GRAPH_ID)).toThrow("closed");
      await expect(runtimes.get(PLAIN_GRAPH_ID)).rejects.toThrow("closed");
    } finally {
      runtimes.close();
    }
  });

  it("releases a ledger that finishes opening after close", async () => {
    const { root, runtimes } = runtimeFixture();
    const ledger = await SqliteAcceptanceLedger.create(root);
    const create = spyOn(SqliteAcceptanceLedger, "create").mockResolvedValue(ledger);
    try {
      const pending = runtimes.get(PLAIN_GRAPH_ID);
      runtimes.close();
      await expect(pending).rejects.toThrow("closed");
      expect(() => ledger.readGraphState(PLAIN_GRAPH_ID)).toThrow("closed");
    } finally {
      create.mockRestore();
      ledger.close();
      runtimes.close();
    }
  });

  it("releases the ledger when runtime construction fails", async () => {
    const { root, options, runtimes } = runtimeFixture();
    const ledger = await SqliteAcceptanceLedger.create(root);
    const create = spyOn(SqliteAcceptanceLedger, "create").mockResolvedValue(ledger);
    Object.defineProperty(options, "validators", {
      get: () => { throw new Error("capability unavailable"); },
    });
    try {
      await expect(runtimes.get(PLAIN_GRAPH_ID)).rejects.toThrow("capability unavailable");
      expect(() => ledger.readGraphState(PLAIN_GRAPH_ID)).toThrow("closed");
    } finally {
      create.mockRestore();
      ledger.close();
      runtimes.close();
    }
  });

  it("refuses a definition damaged while the first runtime is opening", async () => {
    const { root, runtimes } = runtimeFixture();
    const store = GraphStore.openFile(root);
    try {
      const pending = runtimes.get(PLAIN_GRAPH_ID);
      store.run(`UPDATE ${GRAPH_STORE_TABLES.definitions} SET declaration = '{}' WHERE graph_id = ?`, PLAIN_GRAPH_ID);
      await expect(pending).rejects.toThrow("no longer readable");
      expect(store.readGraphState(PLAIN_GRAPH_ID)).toBeUndefined();
    } finally {
      store.close();
      runtimes.close();
    }
  });

  it("opens a graph after an earlier missing-definition failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-runtime-"));
    roots.push(root);
    const deliveries: OutcomeDispatchRequest[] = [];
    const host = OutcomeHost.open({
      workspaceDir: root,
      storeRoot: root,
      validators: EMPTY_VALIDATORS,
      clock: () => NOW,
      deliver: (request) => { deliveries.push(request); },
    });
    try {
      await expect(host.startDeclaredGraph(PLAIN_GRAPH_ID)).rejects.toThrow("no readable stored definition");
      persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: plainDeclaration() }), root);
      const started = await host.startDeclaredGraph(PLAIN_GRAPH_ID);
      expect(started.kind).toBe("started");
      expect(deliveries.map((request) => request.attemptId)).toEqual(["work#1"]);
    } finally {
      host.close();
    }
  });
});

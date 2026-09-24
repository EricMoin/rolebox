/**
 * P1 item 4 — the START path's credential RECORD commits inside the ONE
 * boundary of the state snapshot and the dispatch effect it belongs to.
 *
 * THE REPRODUCED DEFECT THIS PINS. `OutcomeGraphRuntime.start` minted every
 * entry attempt's credential and had the host store adopt it BEFORE
 * `runInTransaction`, so a start that rolled back left a
 * `host_attempt_credentials` row for an attempt whose state and effect were
 * never written — one leaked record per entry attempt, and under
 * `durableCredentialStore: "platform-isolated"` the credential VALUE with it.
 * The comment at the mint claimed the opposite ("persisted on its entry in the
 * same transaction that records the dispatch"); the row count below is the
 * fact, not the comment.
 *
 * HOW THE FAILURE IS INJECTED. A TEMP TRIGGER on the store's own shared
 * connection makes the write fail AT THE SQL STATEMENT, below the application,
 * and the case compares every table the start touches. The production boot
 * sweep (`OutcomeHost.recoverDeclaredGraphs`) is the driver, and after the
 * trigger is dropped the SAME sweep runs again: the retry must start the graph
 * and record exactly ONE credential record for its one entry attempt, which is
 * what makes the rolled-back attempt observable as "nothing at all" rather
 * than "nothing except the credential".
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { HostCredentialVault } from "../../src/graph/host/credential-vault.ts";
import {
  OutcomeHost,
  type OutcomeHostRecoveryReport,
} from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { engineStateDir } from "../../src/graph/persistence/paths.ts";
import { GraphStore, GRAPH_STORE_TABLES } from "../../src/graph/store/index.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";

const NOW = 1_700_000_000_000;
const VALIDATORS = createValidatorRegistry([]);

/** work -> ship: ONE entry node and one successor edge. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "p1.start.credential",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

interface Fixture {
  readonly store: GraphStore;
  /** Run the production boot sweep the way a host restart does. */
  readonly sweep: () => Promise<OutcomeHostRecoveryReport>;
  /** Count the rows of one of the store's own tables. */
  readonly count: (table: string) => number;
  /** Every credential RECORD, with the value column as it stands on disk. */
  readonly credentialRows: () => readonly Readonly<Record<string, unknown>>[];
  readonly close: () => void;
}

/**
 * A declared graph in its own temp workspace, held open on the store's shared
 * connection so the case can inject a failure at a table's write.
 */
function fixture(dir: string): Fixture {
  const storeRoot = engineStateDir(dir);
  const store = GraphStore.openFile(storeRoot);
  const vault = HostCredentialVault.open({ root: storeRoot });
  const requests: OutcomeDispatchRequest[] = [];
  const toolSet = createGraphToolSet({
    stateDir: dir,
    outcomeNow: NOW,
    outcomeDispatch: (request: OutcomeDispatchRequest) => {
      requests.push(request);
    },
    outcomeValidators: VALIDATORS,
    credentialIsolation: vault.capability(),
  });
  toolSet.graph_declare({ declaration: LINEAR });
  return {
    store,
    sweep: async () => {
      const host = OutcomeHost.open({
        workspaceDir: dir,
        storeRoot,
        deliver: (request: OutcomeDispatchRequest) => {
          requests.push(request);
        },
        validators: VALIDATORS,
        clock: () => NOW,
        // FILE durability: the host's vault writes the real credential record
        // into the store under test, under the default "no value on disk".
        durability: "file",
      });
      try {
        return await host.recoverDeclaredGraphs();
      } finally {
        host.close();
      }
    },
    count: (table) => {
      const row = store.get("SELECT COUNT(*) AS n FROM " + table);
      const n = row?.["n"];
      return typeof n === "number" ? n : -1;
    },
    credentialRows: () => store.all("SELECT * FROM " + GRAPH_STORE_TABLES.credentials),
    close: () => {
      store.close();
      vault.close();
    },
  };
}

/**
 * Fail the start at ONE table's write, then retry after the failure is gone.
 * The first half is the contract: the store must hold NOTHING of the attempt —
 * not its state, not its effect and not its credential record.
 */
async function runInjectedStart(table: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graph-start-credential-"));
  const fx = fixture(dir);
  try {
    expect(fx.count(GRAPH_STORE_TABLES.credentials)).toBe(0);
    fx.store.run(
      "CREATE TEMP TRIGGER p1_start_inject BEFORE INSERT ON " +
        table +
        " BEGIN SELECT RAISE(ABORT, 'p1-injected-start-failure'); END",
    );
    const failed = await fx.sweep();
    fx.store.run("DROP TRIGGER p1_start_inject");
    // The sweep reports the graph it could not start rather than swallowing it.
    expect(failed.started).toEqual([]);
    expect(failed.resumed).toEqual([]);
    expect(failed.refused).toHaveLength(1);
    expect(failed.refused[0]).toContain(LINEAR.name);
    // ALL OR NOTHING: the rollback covers the credential record too. This is
    // the assertion the defect failed — the row used to survive the rollback.
    expect(fx.count(GRAPH_STORE_TABLES.graphState)).toBe(0);
    expect(fx.count(GRAPH_STORE_TABLES.pendingEffects)).toBe(0);
    expect(fx.count(GRAPH_STORE_TABLES.credentials)).toBe(0);

    // The retry, with no failure injected, is a FIRST execution of the same
    // one-entry graph: one snapshot, one effect and one credential record,
    // keyed by the attempt the snapshot names.
    const retried = await fx.sweep();
    expect(retried.refused).toEqual([]);
    expect(retried.started).toHaveLength(1);
    expect(fx.count(GRAPH_STORE_TABLES.graphState)).toBe(1);
    expect(fx.count(GRAPH_STORE_TABLES.pendingEffects)).toBe(1);
    const rows = fx.credentialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["graph_id"]).toBe(LINEAR.name);
    expect(rows[0]?.["node_id"]).toBe("work");
    expect(rows[0]?.["attempt_id"]).toBe("work#1");
    // The default durable store records the attempt and no value.
    expect(rows[0]?.["retention"]).toBe("not-retained");
    expect(rows[0]?.["credential"]).toBeNull();
  } finally {
    fx.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the START path's credential record", () => {
  it("rolls back with the snapshot when the state write fails", async () => {
    await runInjectedStart(GRAPH_STORE_TABLES.graphState);
  });

  it("rolls back with the snapshot when the effect write fails", async () => {
    await runInjectedStart(GRAPH_STORE_TABLES.pendingEffects);
  });
});

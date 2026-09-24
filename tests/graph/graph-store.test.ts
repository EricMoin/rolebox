/**
 * The workspace's ONE authoritative store — P1 items 3 and 6.
 *
 * What these cases pin:
 *
 * 1. ONE DATABASE HOLDS EVERYTHING. The graph definition, the run state, the
 *    receipts / accepted events / accepted results, the effects, the host
 *    execution bindings, the credential RECORDS and the declaring invocation
 *    are tables of ONE file — the file the acceptance ledger already owned —
 *    and the directory holds no second authority.
 * 2. ONE TRANSACTION. The acceptance, the effect it authorizes, the host's bind
 *    to that effect, the origin and the definition commit together and roll
 *    back together; a nested boundary is refused rather than becoming a
 *    savepoint.
 * 3. THE INVARIANTS ARE STRUCTURAL: one row per `(graphId, effectId)`,
 *    `created` impossible without a non-empty execution id, one credential
 *    record per `(graphId, nodeId, attemptId)`, one accepted event (and one
 *    accepted result) per `(graphId, attemptId)`, a replayed submission
 *    returning the PERSISTED receipt without advancing counts, and a different
 *    digest conflicting.
 * 4. THE FORMAT GATE: exactly `absent` / `valid` / `corrupt` /
 *    `unsupported`, with a zero-byte file, a foreign schema, a reshaped table,
 *    an unknown/newer/older version and a retired authority all REFUSED — never
 *    recreated, never widened, never auto-initialized into a new run, and a
 *    missing store distinguishable from a damaged one.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  type DatabaseDriver,
} from "../../src/memory/db-driver.ts";
import {
  GraphStore,
  GraphStoreFormatError,
  GraphStoreWriteError,
  loadGraphStore,
  loadGraphStoreSync,
  graphStoreFilePath,
  GRAPH_STORE_FILE,
  GRAPH_STORE_FORMAT_VERSION,
  GRAPH_STORE_TABLES,
  RETIRED_AUTHORITY_FILES,
  type AcceptedResultRecord,
  type GraphAcceptanceBatch,
  type GraphDefinitionRecord,
} from "../../src/graph/store/index.ts";
import { LEDGER_FORMAT_VERSION } from "../../src/graph/ledger/types.ts";

const NOW = 1_700_000_000_000;
const GRAPH = "graph.store";
const ATTEMPT = "work#1";
const EFFECT = { graphId: GRAPH, effectId: "dispatch:" + ATTEMPT, attemptId: ATTEMPT };

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = makeTmpDir("graph-store-");
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function batch(overrides: Partial<GraphAcceptanceBatch> = {}): GraphAcceptanceBatch {
  return {
    receipt: {
      graphId: GRAPH,
      attemptId: ATTEMPT,
      submissionId: "submission-1",
      planRevision: "rev-1",
      proposalDigest: "digest-a",
      decision: "accepted",
      committedAt: NOW,
    },
    acceptedEvent: {
      graphId: GRAPH,
      attemptId: ATTEMPT,
      submissionId: "submission-1",
      planRevision: "rev-1",
      outcomeId: "done",
      acceptedAt: NOW,
    },
    ...overrides,
  };
}

function result(overrides: Partial<AcceptedResultRecord> = {}): AcceptedResultRecord {
  return {
    graphId: GRAPH,
    attemptId: ATTEMPT,
    planRevision: "rev-1",
    payload: { kind: "value", value: { delivered: true, files: ["out/report.md"] } },
    acceptedAt: NOW,
    ...overrides,
  };
}

function definition(overrides: Partial<GraphDefinitionRecord> = {}): GraphDefinitionRecord {
  return {
    graphId: GRAPH,
    declarationDigest: "decl-digest-a",
    planRevision: "rev-1",
    declaration: { version: 3, name: GRAPH },
    plan: { planRevision: "rev-1", nodes: [{ id: "work" }] },
    recordedAt: NOW,
    ...overrides,
  };
}

/** The table names one store file holds, read through a raw second connection. */
async function storeTables(filePath: string): Promise<string[]> {
  const db: DatabaseDriver = await createDatabase(filePath);
  try {
    const names: string[] = [];
    for (const row of db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      if (typeof row === "object" && row !== null && "name" in row) {
        const name = (row as { readonly name?: unknown }).name;
        if (typeof name === "string") names.push(name);
      }
    }
    return names.sort();
  } finally {
    db.close();
  }
}

/** Run one statement through a raw second connection. */
async function tamper(filePath: string, run: (db: DatabaseDriver) => void): Promise<void> {
  const db: DatabaseDriver = await createDatabase(filePath);
  try {
    run(db);
  } finally {
    db.close();
  }
}

// ── One database, one transaction ───────────────────────────────────────────

describe("GraphStore — ONE workspace database", () => {
  it("keeps every record in one file and writes no second authority beside it", async () => {
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      try {
        const committed = store.transaction((tx) => {
          const verdict = tx.commitAccepted(
            batch({
              effects: [
                {
                  graphId: GRAPH,
                  effectId: EFFECT.effectId,
                  attemptId: ATTEMPT,
                  kind: "dispatch",
                  payload: { nodeId: "work" },
                  createdAt: NOW,
                  status: "pending",
                },
              ],
              acceptedResult: result(),
            }),
          );
          tx.writeGraphState({
            graphId: GRAPH,
            planRevision: "rev-1",
            body: { phase: "complete" },
            updatedAt: NOW,
          });
          tx.writeDefinition(definition());
          const claim = tx.claimExecution(EFFECT, "host-a", NOW, 60_000);
          expect(claim.kind).toBe("claimed");
          if (claim.kind !== "claimed") throw new Error("fixture: the claim was not granted");
          // The store MINTS the claim generation, and every later write names it.
          expect(claim.generation).toBe(1);
          // A confirmation before the claim marked the effect creating is
          // refused BY NAME (and recorded), never applied.
          expect(
            tx.confirmExecution(
              EFFECT,
              "host-a",
              claim.generation,
              { executionId: "dsh-run-1" },
              NOW,
            ).kind,
          ).toBe("fenced");
          expect(tx.markExecutionCreating(EFFECT, "host-a", claim.generation, NOW)).toBe(true);
          expect(
            tx.confirmExecution(
              EFFECT,
              "host-a",
              claim.generation,
              { executionId: "dsh-run-1" },
              NOW,
            ),
          ).toEqual({ kind: "confirmed", execution: { executionId: "dsh-run-1" } });
          tx.rememberCredential(
            { graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT },
            "not-retained",
            null,
            NOW,
          );
          expect(tx.recordInvocationOrigin(GRAPH, { sessionId: "session-1" }, NOW)).toBe(true);
          return verdict;
        });
        expect(committed.kind).toBe("committed");
      } finally {
        store.close();
      }

      // The ONE file holds the acceptance tables AND the host tables.
      const tables = await storeTables(graphStoreFilePath(dir));
      for (const table of Object.values(GRAPH_STORE_TABLES)) {
        expect(tables).toContain(table);
      }
      // The additional marker carries storage identity, never execution state.
      expect(readdirSync(dir).sort()).toEqual([GRAPH_STORE_FILE, "graph-store.identity"].sort());

      // A fresh process (a new connection) reads all of it back.
      const reopened = GraphStore.openFile(dir);
      try {
        expect(reopened.lookupReceipt({
          graphId: GRAPH,
          attemptId: ATTEMPT,
          submissionId: "submission-1",
        })?.decision).toBe("accepted");
        expect(reopened.acceptedEvents(GRAPH).length).toBe(1);
        expect(reopened.readAcceptedResult(GRAPH, ATTEMPT)?.payload).toEqual({
          kind: "value",
          value: { delivered: true, files: ["out/report.md"] },
        });
        expect(reopened.readGraphState(GRAPH)?.planRevision).toBe("rev-1");
        expect(reopened.readDefinition(GRAPH)?.declarationDigest).toBe("decl-digest-a");
        expect(reopened.readExecution(EFFECT)?.execution?.executionId).toBe("dsh-run-1");
        expect(
          reopened.readCredentialRetention({ graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT }),
        ).toBe("not-retained");
        expect(reopened.readInvocationOrigin(GRAPH)).toEqual({ sessionId: "session-1" });
      } finally {
        reopened.close();
      }
    });
  });

  it("commits the acceptance, its effect, the host binding and the origin in ONE transaction, and rolls them all back together", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        const failure = (() => {
          try {
            store.transaction((tx) => {
              tx.commitAccepted(
                batch({
                  effects: [
                    {
                      graphId: GRAPH,
                      effectId: EFFECT.effectId,
                      attemptId: ATTEMPT,
                      kind: "dispatch",
                      payload: { nodeId: "work" },
                      createdAt: NOW,
                      status: "pending",
                    },
                  ],
                }),
              );
              tx.claimExecution(EFFECT, "host-a", NOW, 60_000);
              tx.recordInvocationOrigin(GRAPH, { sessionId: "session-1" }, NOW);
              tx.writeDefinition(definition());
              throw new Error("caller aborted");
            });
          } catch (error) {
            return error;
          }
        })();
        expect(failure).toBeInstanceOf(Error);

        // ALL OR NOTHING: not one of the five records survived the rollback.
        expect(
          store.lookupReceipt({ graphId: GRAPH, attemptId: ATTEMPT, submissionId: "submission-1" }),
        ).toBeUndefined();
        expect(store.acceptedEvents(GRAPH)).toEqual([]);
        expect(store.pendingEffects(GRAPH)).toEqual([]);
        expect(store.readGraphState(GRAPH)).toBeUndefined();
        expect(store.readDefinition(GRAPH)).toBeUndefined();
        expect(store.readExecution(EFFECT)).toBeUndefined();
        expect(store.readInvocationOrigin(GRAPH)).toBeUndefined();

        // The same writes WITHOUT the abort land together.
        const verdict = store.transaction((tx) => {
          const committed = tx.commitAccepted(
            batch({
              effects: [
                {
                  graphId: GRAPH,
                  effectId: EFFECT.effectId,
                  attemptId: ATTEMPT,
                  kind: "dispatch",
                  payload: { nodeId: "work" },
                  createdAt: NOW,
                  status: "pending",
                },
              ],
            }),
          );
          tx.claimExecution(EFFECT, "host-a", NOW, 60_000);
          tx.recordInvocationOrigin(GRAPH, { sessionId: "session-1" }, NOW);
          tx.writeDefinition(definition());
          return committed;
        });
        expect(verdict.kind).toBe("committed");
        expect(store.pendingEffects(GRAPH).length).toBe(1);
        expect(store.readExecution(EFFECT)?.state).toBe("pending");
        expect(store.readInvocationOrigin(GRAPH)).toEqual({ sessionId: "session-1" });
        expect(store.readDefinition(GRAPH)?.planRevision).toBe("rev-1");
      } finally {
        store.close();
      }
    });
  });

  it("refuses a nested transaction and an async callback by name", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        const nested = (() => {
          try {
            store.transaction(() => store.transaction(() => 1));
          } catch (error) {
            return error;
          }
        })();
        expect(nested).toBeInstanceOf(GraphStoreWriteError);
        if (nested instanceof GraphStoreWriteError) {
          expect(nested.problem).toBe("nested-transaction");
        }

        const async = (() => {
          try {
            store.transaction(async () => 1);
          } catch (error) {
            return error;
          }
        })();
        expect(async).toBeInstanceOf(GraphStoreWriteError);
        if (async instanceof GraphStoreWriteError) {
          expect(async.problem).toBe("async-transaction");
        }
      } finally {
        store.close();
      }
    });
  });

  it("lets a host record written INSIDE an acceptance transaction roll back with it", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        // A CREDENTIAL WRITE INSIDE THE ACCEPTANCE TRANSACTION is the shipped
        // run path: the reducer mints the attempt credential and remembers it
        // while the state that records its digest is being committed. It works
        // because every store over one file shares ONE connection and ONE
        // transaction — and it rolls back with the acceptance when that fails.
        const failure = (() => {
          try {
            store.transaction((tx) => {
              tx.rememberCredential(
                { graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT },
                "not-retained",
                null,
                NOW,
              );
              throw new Error("caller aborted");
            });
          } catch (error) {
            return error;
          }
        })();
        expect(failure).toBeInstanceOf(Error);
        expect(
          store.readCredentialRetention({ graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT }),
        ).toBeUndefined();

        // Two store objects over one file share the OPEN transaction too: a
        // second handle's compound write joins instead of opening a second
        // boundary over the same file.
        const second = GraphStore.openFile(dir);
        try {
          store.transaction((tx) => {
            tx.rememberCredential(
              { graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT },
              "not-retained",
              null,
              NOW,
            );
            // A compound operation on the OTHER handle joins this transaction.
            const claim = second.claimExecution(EFFECT, "host-a", NOW, 60_000);
            expect(claim.kind).toBe("claimed");
            throw new Error("caller aborted");
          });
        } catch {
          // The abort is the point; the rows below prove it covered both handles.
        }
        expect(second.readExecution(EFFECT)).toBeUndefined();
        expect(
          second.readCredentialRetention({ graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT }),
        ).toBeUndefined();
        second.close();
      } finally {
        store.close();
      }
    });
  });
});

// ── The invariants, verbatim ────────────────────────────────────────────────

describe("GraphStore — the invariants P0 pinned", () => {
  it("keeps one row per (graphId, effectId) and gives the create right to one owner", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        expect(store.claimExecution(EFFECT, "host-a", NOW, 60_000).kind).toBe("claimed");
        const second = store.claimExecution(EFFECT, "host-b", NOW, 60_000);
        expect(second.kind).toBe("held");
        if (second.kind === "held") expect(second.row.ownerId).toBe("host-a");
        expect(store.all(`SELECT COUNT(*) AS n FROM ${GRAPH_STORE_TABLES.executions}`)[0]?.["n"]).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("makes 'created' impossible without a non-empty execution id", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        const claim = store.claimExecution(EFFECT, "host-a", NOW, 60_000);
        if (claim.kind !== "claimed") throw new Error("fixture: the claim was not granted");
        store.markExecutionCreating(EFFECT, "host-a", claim.generation, NOW);
        expect(() =>
          store.confirmExecution(EFFECT, "host-a", claim.generation, { executionId: "" }, NOW),
        ).toThrow(GraphStoreWriteError);
        expect(store.readExecution(EFFECT)?.state).toBe("creating");

        expect(
          store.confirmExecution(
            EFFECT,
            "host-a",
            claim.generation,
            { executionId: "dsh-run-1" },
            NOW,
          ).kind,
        ).toBe("confirmed");
        // The DDL CHECK makes the unrepresentable state unrepresentable even
        // for a direct SQL writer.
        expect(() =>
          store.run(
            `UPDATE ${GRAPH_STORE_TABLES.executions} SET state = 'created', execution_id = NULL WHERE graph_id = ? AND effect_id = ?`,
            GRAPH,
            EFFECT.effectId,
          ),
        ).toThrow();
      } finally {
        store.close();
      }
    });
  });

  it("keeps one credential record per (graphId, nodeId, attemptId) and no value for a not-retained one", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      const identity = { graphId: GRAPH, nodeId: "work", attemptId: ATTEMPT };
      try {
        store.rememberCredential(identity, "not-retained", null, NOW);
        store.rememberCredential(identity, "retained", "credential-value", NOW + 1);
        expect(
          store.all(`SELECT COUNT(*) AS n FROM ${GRAPH_STORE_TABLES.credentials}`)[0]?.["n"],
        ).toBe(1);
        expect(store.readCredentialRetention(identity)).toBe("retained");
        expect(store.retainedCredentials().length).toBe(1);

        // A retained record cannot exist without a value; a not-retained one
        // cannot carry one.
        expect(() => store.rememberCredential(identity, "retained", null, NOW)).toThrow(
          GraphStoreWriteError,
        );
        expect(() =>
          store.run(
            `UPDATE ${GRAPH_STORE_TABLES.credentials} SET credential = NULL WHERE graph_id = ?`,
            GRAPH,
          ),
        ).toThrow();

        store.forgetCredential(identity);
        expect(store.readCredentialRetention(identity)).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("keeps one accepted event per (graphId, attemptId) and replays the PERSISTED receipt without advancing", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        const first = store.commitAccepted(batch({ acceptedResult: result() }));
        expect(first.kind).toBe("committed");
        const committedAt = NOW;

        // The SAME submission key and digest: the persisted receipt is returned
        // and NOTHING advances.
        const replay = store.commitAccepted(
          batch({ receipt: { ...batch().receipt, committedAt: NOW + 5_000 } }),
        );
        expect(replay.kind).toBe("replayed");
        if (replay.kind === "replayed") expect(replay.receipt.committedAt).toBe(committedAt);
        expect(store.acceptedEvents(GRAPH).length).toBe(1);

        // A DIFFERENT digest under the same key is a conflict, not a rewrite.
        const conflict = store.commitAccepted(
          batch({
            receipt: { ...batch().receipt, proposalDigest: "digest-b" },
          }),
        );
        expect(conflict.kind).toBe("conflict");
        expect(
          store.lookupReceipt({ graphId: GRAPH, attemptId: ATTEMPT, submissionId: "submission-1" })
            ?.proposalDigest,
        ).toBe("digest-a");

        // A DISTINCT terminal submission for a settled attempt is refused: one
        // attempt carries at most one accepted event and one accepted result.
        const settled = store.commitAccepted(
          batch({
            receipt: {
              ...batch().receipt,
              submissionId: "submission-2",
              proposalDigest: "digest-c",
            },
            acceptedEvent: { ...batch().acceptedEvent!, submissionId: "submission-2" },
          }),
        );
        expect(settled.kind).toBe("settled");
        expect(store.readAcceptedResult(GRAPH, ATTEMPT)?.payload).toEqual({
          kind: "value",
          value: { delivered: true, files: ["out/report.md"] },
        });
      } finally {
        store.close();
      }
    });
  });

  it("never replaces an accepted result already committed for an attempt", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        store.commitAccepted(batch({ acceptedResult: result() }));
        store.writeAcceptedResult(
          result({ payload: { kind: "value", value: { delivered: false } } }),
        );
        expect(store.readAcceptedResult(GRAPH, ATTEMPT)?.payload).toEqual({
          kind: "value",
          value: { delivered: true, files: ["out/report.md"] },
        });
      } finally {
        store.close();
      }
    });
  });

  it("preserves an unchanged definition and refuses a changed one without writing", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        expect(store.writeDefinition(definition()).kind).toBe("recorded");
        expect(store.writeDefinition(definition()).kind).toBe("preserved");

        const changed = store.writeDefinition(
          definition({ declarationDigest: "decl-digest-b", planRevision: "rev-2" }),
        );
        expect(changed.kind).toBe("changed");
        if (changed.kind === "changed") {
          expect(changed.definition.planRevision).toBe("rev-1");
        }
        // The stored definition is the first one, untouched.
        expect(store.readDefinition(GRAPH)?.declarationDigest).toBe("decl-digest-a");
      } finally {
        store.close();
      }
    });
  });

  it("refuses a record the store's own model rejects before touching the file", async () => {
    await withTempDir((dir) => {
      const store = GraphStore.openFile(dir);
      try {
        expect(() =>
          store.writeDefinition(definition({ graphId: "" })),
        ).toThrow(GraphStoreWriteError);
        expect(() =>
          store.rememberCredential(
            { graphId: GRAPH, nodeId: "work", attemptId: "" },
            "retained",
            "value",
            NOW,
          ),
        ).toThrow(GraphStoreWriteError);
        expect(() =>
          store.recordInvocationOrigin(GRAPH, { sessionId: "" }, NOW),
        ).toThrow(GraphStoreWriteError);
        expect(
          store.all(`SELECT COUNT(*) AS n FROM ${GRAPH_STORE_TABLES.definitions}`)[0]?.["n"],
        ).toBe(0);
      } finally {
        store.close();
      }
    });
  });
});

// ── The format gate ─────────────────────────────────────────────────────────

describe("GraphStore — the format gate (P1 item 6)", () => {
  it("answers absent for a root that holds no store and no retired authority", async () => {
    await withTempDir(async (dir) => {
      const verdict = loadGraphStoreSync(dir);
      expect(verdict.kind).toBe("absent");
      // A load never creates the store it did not find.
      expect(readdirSync(dir)).toEqual([]);
      expect((await loadGraphStore(dir)).kind).toBe("absent");
    });
  });

  it("answers valid for a store this build wrote, and the handle cannot write", async () => {
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      expect(statSync(graphStoreFilePath(dir)).size).toBeGreaterThan(0);

      const verdict = await loadGraphStore(dir);
      expect(verdict.kind).toBe("valid");
      if (verdict.kind !== "valid") return;
      try {
        expect(verdict.value.formatVersion).toBe(GRAPH_STORE_FORMAT_VERSION);
        expect(verdict.value.formatVersion).toBe(LEDGER_FORMAT_VERSION);
        // Read-only BY CONSTRUCTION: the connection refuses the write.
        expect(() => verdict.value.run("DELETE FROM " + GRAPH_STORE_TABLES.receipts)).toThrow();
      } finally {
        verdict.value.close();
      }
    });
  });

  it("answers corrupt for a zero-byte file and never initializes over it", async () => {
    await withTempDir(async (dir) => {
      const filePath = graphStoreFilePath(dir);
      writeFileSync(filePath, "");
      const verdict = loadGraphStoreSync(dir);
      expect(verdict.kind).toBe("corrupt");
      expect(() => GraphStore.openFile(dir)).toThrow(GraphStoreFormatError);
      // Still zero bytes: the refusal did not write a database header into it.
      expect(statSync(filePath).size).toBe(0);
    });
  });

  it("answers corrupt for a foreign store and leaves it exactly as it was", async () => {
    await withTempDir(async (dir) => {
      await tamper(graphStoreFilePath(dir), (db) => {
        db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
        db.run("INSERT INTO unrelated (id, note) VALUES (1, 'kept')");
      });
      const verdict = loadGraphStoreSync(dir);
      expect(verdict.kind).toBe("corrupt");
      const error = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(GraphStoreFormatError);
      if (error instanceof GraphStoreFormatError) {
        expect(error.problem).toBe("foreign-store");
      }
      await tamper(graphStoreFilePath(dir), (db) => {
        const row = db.query("SELECT COUNT(*) AS n FROM unrelated").get();
        expect(row !== null && typeof row === "object" && "n" in row ? row.n : undefined).toBe(1);
      });
    });
  });

  it("answers corrupt for a reshaped table or a missing one, and refuses rather than rebuilding", async () => {
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.exec(
          "ALTER TABLE " + GRAPH_STORE_TABLES.acceptedEvents + " ADD COLUMN note TEXT",
        );
      });
      expect(loadGraphStoreSync(dir).kind).toBe("corrupt");
      const reshaped = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(reshaped).toBeInstanceOf(GraphStoreFormatError);
      if (reshaped instanceof GraphStoreFormatError) {
        expect(reshaped.problem).toBe("incomplete-store");
      }
    });

    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.exec("DROP TABLE " + GRAPH_STORE_TABLES.executions);
      });
      expect(loadGraphStoreSync(dir).kind).toBe("corrupt");
      // The missing table was NOT recreated by the refused open.
      expect(await storeTables(graphStoreFilePath(dir))).not.toContain(
        GRAPH_STORE_TABLES.executions,
      );
    });
  });

  it("refuses the PRE-P2 execution layout by name instead of widening it", async () => {
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      // THE LAYOUT BEFORE THE OWNER GENERATION: same table name and primary key,
      // no `owner_generation` and no refusal record. A pre-P2 process could have
      // written this file, and reading it as this build's layout would answer
      // "no claim generation" for every row.
      await tamper(graphStoreFilePath(dir), (db) => {
        db.exec(
          "ALTER TABLE " + GRAPH_STORE_TABLES.executions + " RENAME TO executions_pre_p2",
        );
        db.exec(
          "CREATE TABLE " +
            GRAPH_STORE_TABLES.executions +
            " (graph_id TEXT NOT NULL, effect_id TEXT NOT NULL, attempt_id TEXT NOT NULL, " +
            "state TEXT NOT NULL CHECK (state IN ('pending', 'creating', 'created')), " +
            "owner_id TEXT NOT NULL, execution_id TEXT, task_id TEXT, " +
            "claimed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
            "PRIMARY KEY (graph_id, effect_id), " +
            "CHECK ((state = 'created') = (execution_id IS NOT NULL)))",
        );
      });
      expect(loadGraphStoreSync(dir).kind).toBe("corrupt");
      const refused = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(refused).toBeInstanceOf(GraphStoreFormatError);
      if (refused instanceof GraphStoreFormatError) {
        expect(refused.problem).toBe("incomplete-store");
        expect(String(refused.message)).toContain("owner_generation is missing");
      }
      // REFUSED, NOT REBUILT: the file still holds the layout it had.
      await tamper(graphStoreFilePath(dir), (db) => {
        const names: string[] = [];
        for (const row of db
          .query("PRAGMA table_info(" + GRAPH_STORE_TABLES.executions + ")")
          .all()) {
          if (typeof row === "object" && row !== null && "name" in row) {
            const name = (row as { readonly name?: unknown }).name;
            if (typeof name === "string") names.push(name);
          }
        }
        expect(names).not.toContain("owner_generation");
      });
    });
  });

  it("answers unsupported for a newer format and for the older version-1 layout", async () => {
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.run(
          "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = ? WHERE id = 1",
          GRAPH_STORE_FORMAT_VERSION + 1,
        );
      });
      const newer = loadGraphStoreSync(dir);
      expect(newer.kind).toBe("unsupported");
      if (newer.kind === "unsupported") expect(newer.dimension).toBe("storage");

      const error = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(GraphStoreFormatError);
      if (error instanceof GraphStoreFormatError) {
        expect(error.problem).toBe("newer-format");
        expect(error.supported).toBe(GRAPH_STORE_FORMAT_VERSION);
      }
    });

    await withTempDir(async (dir) => {
      // A version-1 file is the PRE-CONVERGENCE ledger: five tables, no host
      // records. This build registers no migration, so it is refused — reading
      // it as "no execution binding" is exactly what would re-create an
      // execution an earlier process already made.
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.run(
          "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = 1 WHERE id = 1",
        );
      });
      expect(loadGraphStoreSync(dir).kind).toBe("unsupported");
      const error = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(GraphStoreFormatError);
      if (error instanceof GraphStoreFormatError) {
        expect(error.problem).toBe("older-format");
      }
    });
  });

  it("answers unsupported for a version-6 predecessor store, never corrupt", async () => {
    // THE PREDECESSOR IS A WELL-FORMED MEMBER OF A FORMAT THAT EXISTED. Version 6
    // stored the accepted payload as the BARE value the submission carried and
    // its accepted-results row had no `artifacts` column, so its rows cannot be
    // read as this build's accepted data. The verdict must name the VERSION —
    // never "corrupt", never migrated, never deleted, never re-executed.
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.run(
          "ALTER TABLE " +
            GRAPH_STORE_TABLES.acceptedResults +
            " DROP COLUMN artifacts",
        );
        db.run(
          "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = 6 WHERE id = 1",
        );
      });

      const verdict = loadGraphStoreSync(dir);
      expect(verdict.kind).toBe("unsupported");
      if (verdict.kind === "unsupported") expect(verdict.dimension).toBe("storage");

      const error = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(GraphStoreFormatError);
      if (error instanceof GraphStoreFormatError) {
        expect(error.problem).toBe("older-format");
        expect(error.found).toBe(6);
        expect(error.supported).toBe(LEDGER_FORMAT_VERSION);
      }

      // THE FILE IS LEFT EXACTLY AS IT WAS FOUND: still present, still stamped
      // 6, still without the column its build never wrote.
      expect(statSync(graphStoreFilePath(dir)).size).toBeGreaterThan(0);
      await tamper(graphStoreFilePath(dir), (db) => {
        expect(
          db
            .query(
              "SELECT format_version FROM " +
                GRAPH_STORE_TABLES.meta +
                " WHERE id = 1",
            )
            .get(),
        ).toEqual({ format_version: 6 });
        const names: string[] = [];
        for (const column of db
          .query("PRAGMA table_info(" + GRAPH_STORE_TABLES.acceptedResults + ")")
          .all()) {
          if (typeof column === "object" && column !== null && "name" in column) {
            const name = (column as { readonly name?: unknown }).name;
            if (typeof name === "string") names.push(name);
          }
        }
        expect(names).not.toContain("artifacts");
      });
    });

    // THE REAL-WORLD PREDECESSOR TOO: a store this branch's HEAD wrote carries
    // the `artifacts` column but the SAME bare-payload rows. The VERSION is the
    // identity that must answer — the layout alone cannot tell the two apart.
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.run(
          "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = 6 WHERE id = 1",
        );
      });
      expect(loadGraphStoreSync(dir).kind).toBe("unsupported");
    });

    // CONTRAST: the SAME dropped column with the CURRENT version stamped is a
    // reshaped store, and the layout check answers `corrupt` (incomplete-store).
    // The difference between the two verdicts is exactly the VERSION IDENTITY.
    await withTempDir(async (dir) => {
      const store = GraphStore.openFile(dir);
      store.close();
      await tamper(graphStoreFilePath(dir), (db) => {
        db.run(
          "ALTER TABLE " +
            GRAPH_STORE_TABLES.acceptedResults +
            " DROP COLUMN artifacts",
        );
      });
      const verdict = loadGraphStoreSync(dir);
      expect(verdict.kind).toBe("corrupt");
      const error = (() => {
        try {
          GraphStore.openFile(dir);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(GraphStoreFormatError);
      if (error instanceof GraphStoreFormatError) {
        expect(error.problem).toBe("incomplete-store");
      }
    });
  });

  it("answers unsupported for a retired authority beside the path, and refuses to initialize over it", async () => {
    for (const retired of RETIRED_AUTHORITY_FILES) {
      await withTempDir(async (dir) => {
        writeFileSync(join(dir, retired), "records this build does not convert", "utf8");
        const verdict = loadGraphStoreSync(dir);
        expect(verdict.kind).toBe("unsupported");
        if (verdict.kind === "unsupported") {
          expect(verdict.detail).toContain(retired);
        }
        expect(() => GraphStore.openFile(dir)).toThrow(GraphStoreFormatError);
        // No store was created beside the retired records.
        expect(readdirSync(dir)).toEqual([retired]);
      });
    }
  });

  it("never produces a migration-required verdict, because no conversion is registered", async () => {
    await withTempDir((dir) => {
      const verdict = loadGraphStoreSync(dir);
      expect(verdict.kind).toBe("absent");
      // The vocabulary has no inhabited migration branch here: the only
      // constructor demands a REGISTERED capability, and this slice registers
      // none, so every refusal above is `corrupt` or `unsupported`.
      expect(["absent", "valid", "corrupt", "unsupported"]).toContain(verdict.kind);
    });
  });
});

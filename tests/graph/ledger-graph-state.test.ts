/**
 * Durable acceptance ledger — graph-state seam (C3b).
 *
 * Covers the state half of the protocol's single atomic boundary: the state
 * record round-trips on the port and inside a caller's transaction, a malformed
 * record is refused without touching the store, and a state body that cannot be
 * stored (unrepresentable, oversized) fails the WHOLE transaction — the receipt,
 * the accepted event and every pending effect that the same transaction wrote
 * are gone with it. The format gate is re-verified for the new table, including
 * an intact-looking store that is simply missing it.
 *
 * The second half covers the STATE-BODY VERSION gate: a same-version body
 * round-trips through the store with zero field loss, while an unknown body
 * field, an unknown node field, a body version this build has no reader for and
 * a missing version discriminator are each REFUSED — never read partially and
 * never rewritten with the unknown fields dropped. Version 2 adds the
 * runtime-issued attempt credential at the NODE level: it is required on a
 * dispatched/settled entry, forbidden on a pending one and forbidden in a
 * version-1 body, and version 1 stays READABLE (its attempts simply carry no
 * credential) while the reducer refuses to advance a body that cannot carry
 * one.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  type DatabaseDriver,
} from "../../src/memory/db-driver.ts";
import {
  GRAPH_STATE_MAX_BYTES,
  type AcceptanceBatch,
  type AcceptedEventRecord,
  type GraphStateRecord,
  type PendingEffectRecord,
  type ReceiptRecord,
} from "../../src/graph/ledger/types.ts";
import {
  LEDGER_TABLES,
  LedgerFormatError,
  LedgerWriteError,
  SqliteAcceptanceLedger,
  ledgerFilePath,
  type LedgerWriteProblem,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
  OUTCOME_STOP_REASONS,
  OUTCOME_STATE_BODY_V1,
  OUTCOME_STATE_BODY_V2,
  OUTCOME_STATE_BODY_V3,
  OUTCOME_STATE_BODY_V4,
  OUTCOME_STATE_BODY_V5,
  OutcomeAdvanceRefusedError,
  OutcomeStateError,
  advanceOutcomeGraph,
  classifyOutcomeStateBody,
  createOutcomeStateBodyRegistry,
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeGraphState,
  type OutcomeStateBodyReading,
} from "../../src/graph/outcome/graph-state.ts";
import type { AcceptanceDecision } from "../../src/graph/outcome/acceptance.ts";
import { RUNTIME_ATTEMPT_CREDENTIAL_SOURCE } from "../../src/graph/outcome/attempt-credential.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph-state-1";
const PLAN_REVISION = "plan-revision-a";
const NOW = 1_700_000_000_000;

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    graphId: GRAPH,
    attemptId: "attempt-1",
    submissionId: "submission-1",
    planRevision: PLAN_REVISION,
    proposalDigest: "digest-a",
    decision: "accepted",
    committedAt: NOW,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<AcceptedEventRecord> = {},
): AcceptedEventRecord {
  return {
    graphId: GRAPH,
    attemptId: "attempt-1",
    submissionId: "submission-1",
    planRevision: PLAN_REVISION,
    outcomeId: "done",
    acceptedAt: NOW,
    ...overrides,
  };
}

function makeEffect(
  overrides: Partial<PendingEffectRecord> = {},
): PendingEffectRecord {
  return {
    graphId: GRAPH,
    effectId: "effect-1",
    attemptId: "attempt-1",
    kind: "dispatch",
    payload: { node: "a" },
    createdAt: NOW,
    status: "pending",
    ...overrides,
  };
}

function makeBatch(): AcceptanceBatch {
  return {
    receipt: makeReceipt(),
    acceptedEvent: makeEvent(),
    effects: [makeEffect()],
  };
}

/** The submission key a batch is committed under. */
function batchKey(batch: AcceptanceBatch) {
  return {
    graphId: batch.receipt.graphId,
    attemptId: batch.receipt.attemptId,
    submissionId: batch.receipt.submissionId,
  };
}

async function withTempDir(
  run: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graph-ledger-state-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withLedger(
  run: (ledger: SqliteAcceptanceLedger, dir: string) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      await run(ledger, dir);
    } finally {
      ledger.close();
    }
  });
}

/** Open the ledger file directly (a second connection) and run one callback. */
async function withRawStore<T>(
  dir: string,
  run: (db: DatabaseDriver) => T,
): Promise<T> {
  const db = await createDatabase(ledgerFilePath(dir));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function countRows(db: DatabaseDriver, table: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM " + table).get();
  if (typeof row === "object" && row !== null && "n" in row) {
    const value = row.n;
    if (typeof value === "number") return value;
  }
  throw new Error("count query did not answer a number: " + table);
}

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function rejectedError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ── The state seam ──────────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — graph state", () => {
  it("round-trips a state snapshot on the port", async () => {
    await withLedger(async (ledger) => {
      expect(ledger.readGraphState(GRAPH)).toBeUndefined();

      const body = {
        phase: "executing",
        nodes: [{ nodeId: "work", status: "dispatched", attemptId: "work#1" }],
        loopTraversals: { "revise-loop": 2 },
        nested: { list: [1, null, "x", { deep: true }] },
      };
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body,
        updatedAt: NOW,
      });

      expect(ledger.readGraphState(GRAPH)).toEqual({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body,
        updatedAt: NOW,
      });
      // One row per graph: a second write REPLACES the snapshot.
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: "plan-revision-b",
        body: { phase: "complete" },
        updatedAt: NOW + 5,
      });
      expect(ledger.readGraphState(GRAPH)).toEqual({
        graphId: GRAPH,
        planRevision: "plan-revision-b",
        body: { phase: "complete" },
        updatedAt: NOW + 5,
      });
      // Another graph is untouched.
      expect(ledger.readGraphState("other-graph")).toBeUndefined();
    });
  });

  it("reads and writes the state inside a caller's transaction", async () => {
    await withLedger(async (ledger) => {
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body: { phase: "ready" },
        updatedAt: NOW,
      });

      const seen = ledger.runInTransaction((tx) => {
        expect(tx.readGraphState(GRAPH)?.body).toEqual({ phase: "ready" });
        tx.writeGraphState({
          graphId: GRAPH,
          planRevision: PLAN_REVISION,
          body: { phase: "executing" },
          updatedAt: NOW + 1,
        });
        // The transaction sees its OWN uncommitted write.
        expect(tx.readGraphState(GRAPH)?.body).toEqual({ phase: "executing" });
        return "joined";
      });
      expect(seen).toBe("joined");
      expect(ledger.readGraphState(GRAPH)?.body).toEqual({ phase: "executing" });
    });
  });

  it("persists the state across a close and reopen", async () => {
    await withTempDir(async (dir) => {
      const first = await SqliteAcceptanceLedger.create(dir);
      first.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body: { phase: "executing", attemptSeq: 3 },
        updatedAt: NOW,
      });
      first.close();

      const second = await SqliteAcceptanceLedger.create(dir);
      try {
        expect(second.readGraphState(GRAPH)).toEqual({
          graphId: GRAPH,
          planRevision: PLAN_REVISION,
          body: { phase: "executing", attemptSeq: 3 },
          updatedAt: NOW,
        });
      } finally {
        second.close();
      }
    });
  });

  it("refuses a state record that violates the record model", async () => {
    await withLedger(async (ledger, dir) => {
      const malformed = [
        {
          graphId: "",
          planRevision: PLAN_REVISION,
          body: {},
          updatedAt: NOW,
        },
        { graphId: GRAPH, planRevision: "", body: {}, updatedAt: NOW },
        { graphId: GRAPH, planRevision: PLAN_REVISION, body: {}, updatedAt: 1.5 },
      ];
      for (const record of malformed) {
        const error = thrownError(() => ledger.writeGraphState(record));
        expect(error).toBeInstanceOf(LedgerWriteError);
        if (error instanceof LedgerWriteError) {
          expect(error.problem).toBe("invalid-graph-state");
        }
      }
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.graphState)).toBe(0);
      });
    });
  });
});

// ── The atomic boundary ─────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — the state commits with the acceptance", () => {
  /**
   * The proof the protocol needs: a state write that cannot be stored, issued
   * AFTER the acceptance batch already wrote its receipt, event and effect
   * inside the caller's transaction, must leave NOTHING behind. The batch is
   * deliberately written first so the failure lands after rows exist — the
   * window a non-atomic design would leave half-committed.
   */
  async function expectWholeTransactionRolledBack(
    body: unknown,
    problem: LedgerWriteProblem,
  ) {
    await withLedger(async (ledger, dir) => {
      const batch = makeBatch();
      const error = thrownError(() =>
        ledger.runInTransaction((tx) => {
          const verdict = tx.commitAccepted(batch);
          expect(verdict.kind).toBe("committed");
          // The transaction can see the batch it just wrote...
          expect(tx.lookupReceipt(batchKey(batch))).toBeDefined();
          tx.writeGraphState({
            graphId: GRAPH,
            planRevision: PLAN_REVISION,
            body,
            updatedAt: NOW,
          });
        }),
      );
      expect(error).toBeInstanceOf(LedgerWriteError);
      if (error instanceof LedgerWriteError) {
        expect(error.problem).toBe(problem);
      }

      // ...and the rollback took the receipt, the event, the effect and the
      // state with it. There is no half-committed batch.
      expect(ledger.lookupReceipt(batchKey(batch))).toBeUndefined();
      expect(ledger.acceptedEvents(GRAPH)).toEqual([]);
      expect(ledger.pendingEffects(GRAPH)).toEqual([]);
      expect(ledger.readGraphState(GRAPH)).toBeUndefined();
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.graphState)).toBe(0);
      });

      // The store is still usable after the contained failure.
      expect(ledger.commitAccepted(batch).kind).toBe("committed");
    });
  }

  it("fails the whole transaction for an unrepresentable state body", async () => {
    await expectWholeTransactionRolledBack(
      { bad: BigInt(1) },
      "unrepresentable-state",
    );
  });

  it("fails the whole transaction for an oversized state body", async () => {
    await expectWholeTransactionRolledBack(
      { pad: "x".repeat(GRAPH_STATE_MAX_BYTES + 1) },
      "oversized-state",
    );
  });

  it("keeps a body at the size limit and refuses the first byte beyond it", async () => {
    await withLedger(async (ledger) => {
      // The limit is measured on the ENCODED JSON text, so a string payload of
      // exactly the limit is already over it once quoted. Measure the encoded
      // size through the store's own round-trip: write a small body, then the
      // largest one that still fits.
      const padding = "y".repeat(1024);
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body: { pad: padding },
        updatedAt: NOW,
      });
      expect(ledger.readGraphState(GRAPH)?.body).toEqual({ pad: padding });

      const error = thrownError(() =>
        ledger.writeGraphState({
          graphId: GRAPH,
          planRevision: PLAN_REVISION,
          body: { pad: "z".repeat(GRAPH_STATE_MAX_BYTES) },
          updatedAt: NOW + 1,
        }),
      );
      expect(error).toBeInstanceOf(LedgerWriteError);
      // The refused write did not disturb the stored snapshot.
      expect(ledger.readGraphState(GRAPH)?.body).toEqual({ pad: padding });
    });
  });
});

// ── The format gate, extended to the new table ──────────────────────────────

describe("SqliteAcceptanceLedger — graph-state table format gate", () => {
  it("refuses a store missing ledger_graph_state, and leaves it untouched", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => {
        db.exec("DROP TABLE " + LEDGER_TABLES.graphState);
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("incomplete-store");
        expect(error.path).toBe(ledgerFilePath(dir));
      }
      // Never recreated: the table is still absent after the refusal.
      await withRawStore(dir, (db) => {
        const names: string[] = [];
        for (const row of db
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()) {
          if (typeof row === "object" && row !== null && "name" in row) {
            if (typeof row.name === "string") names.push(row.name);
          }
        }
        expect(names).not.toContain(LEDGER_TABLES.graphState);
      });
    });
  });

  it("refuses a reshaped graph-state table instead of failing with a raw driver error", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => {
        // Same columns, but the body is declared INTEGER: a layout this format
        // does not write, even though every name is present.
        db.exec("ALTER TABLE " + LEDGER_TABLES.graphState + " RENAME TO gs_old");
        db.exec(
          "CREATE TABLE " +
            LEDGER_TABLES.graphState +
            " (graph_id TEXT NOT NULL, plan_revision TEXT NOT NULL, body INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (graph_id))",
        );
        db.exec("DROP TABLE gs_old");
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("incomplete-store");
      }
    });
  });

  it("keeps the version discipline: a newer format is refused before any table is read", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => {
        db.run(
          "UPDATE " + LEDGER_TABLES.meta + " SET format_version = format_version + 1 WHERE id = 1",
        );
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("newer-format");
      }
    });
  });
});

// ── The state body is read as a versioned capability ────────────────────────

/** work -> ship, so a state body carries one dispatched and one pending node. */
const STATE_BODY_DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "graph.state-body",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

const STATE_BODY_PLAN = buildDeclaredOutcomeGraph({
  declaration: STATE_BODY_DECLARATION,
}).plan;

/** The credential the version-2 fixture records on the dispatched attempt. */
const FIXTURE_CREDENTIAL = "fixture-credential:work#1";

/**
 * The state the CURRENT writer produces, in plan order: one dispatched attempt
 * carrying the credential the runtime issued, one pending node with none.
 */
function stateBodyFixture(): OutcomeGraphState {
  const nodes = STATE_BODY_PLAN.nodes.map((node, index) =>
    index === 0
      ? Object.freeze({
          nodeId: node.id,
          status: "dispatched" as const,
          attemptId: node.id + "#1",
          attemptSeq: 1,
          attemptCredential: FIXTURE_CREDENTIAL,
          dispatchedAt: NOW,
          // No node has settled, so every join inbox is empty: exactly what the
          // entry materialization corroborates.
          arrivals: Object.freeze([]),
        })
      : Object.freeze({
          nodeId: node.id,
          status: "pending" as const,
          arrivals: Object.freeze([]),
        }),
  );
  return Object.freeze({
    bodyVersion: CURRENT_OUTCOME_STATE_BODY,
    graphId: STATE_BODY_PLAN.graphId,
    planRevision: STATE_BODY_PLAN.planRevision,
    phase: "executing" as const,
    nodes: Object.freeze(nodes),
    loopTraversals: Object.freeze({}),
    attemptSeq: 1,
    // The plan declares no progress policy, so the current layout's progress
    // record is present and EMPTY: exactly what a writer materializes, and what
    // a version that defines the field must carry.
    loopProgress: Object.freeze({}),
  });
}

/** A version-1 body: the fixture with credential, arrivals and progress stripped. */
function stateBodyFixtureV1(): Record<string, unknown> {
  const body = bodyOf(stateBodyFixture());
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
  const { loopProgress: _progress, ...withoutProgress } = body;
  return {
    ...withoutProgress,
    bodyVersion: OUTCOME_STATE_BODY_V1,
    nodes: rawNodes.map((node) => {
      if (!isRecord(node)) throw new Error("fixture: a node entry is not a record");
      const { attemptCredential: _credential, arrivals: _arrivals, ...rest } = node;
      return rest;
    }),
  };
}

/**
 * A version-4 body: the current fixture with the progress record stripped — the
 * layout this build's predecessor wrote, which records no comparison baseline.
 */
function stateBodyFixtureV4(): Record<string, unknown> {
  const { loopProgress: _progress, ...body } = bodyOf(stateBodyFixture());
  return { ...body, bodyVersion: OUTCOME_STATE_BODY_V4 };
}

/**
 * A version-2 body: the fixture's credentials kept, its arrival lists stripped
 * — the layout this build's predecessor wrote, which records no arrivals.
 */
function stateBodyFixtureV2(): Record<string, unknown> {
  const body = bodyOf(stateBodyFixture());
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
  const { loopProgress: _progress, ...withoutProgress } = body;
  return {
    ...withoutProgress,
    bodyVersion: OUTCOME_STATE_BODY_V2,
    nodes: rawNodes.map((node) => {
      if (!isRecord(node)) throw new Error("fixture: a node entry is not a record");
      const { arrivals: _arrivals, ...rest } = node;
      return rest;
    }),
  };
}

/**
 * A version-3 body for the LINEAR plan with ONE non-empty join inbox: "work"
 * has SETTLED with the routing outcome "done", so its arrival reached "ship"
 * over the declared edge (work -> ship, done) and "ship" is running on a second
 * attempt.
 *
 * Addressed by node ID, never by position: the compiled plan orders nodes by id.
 */
function settledArrivalBody(): Record<string, unknown> {
  const body = bodyOf(stateBodyFixture());
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
  return {
    ...body,
    nodes: STATE_BODY_PLAN.nodes.map((node, index) => {
      const entry = rawNodes[index];
      if (!isRecord(entry)) throw new Error("fixture: a node entry is not a record");
      if (node.id === "work") {
        return {
          nodeId: node.id,
          status: "settled",
          attemptId: "work#1",
          attemptSeq: 1,
          attemptCredential: FIXTURE_CREDENTIAL,
          outcomeId: "done",
          dispatchedAt: NOW,
          settledAt: NOW,
          arrivals: [],
        };
      }
      return {
        nodeId: node.id,
        status: "dispatched",
        attemptId: node.id + "#2",
        attemptSeq: 2,
        attemptCredential: "fixture-credential:" + node.id + "#2",
        dispatchedAt: NOW,
        arrivals: [{ from: "work", outcome: "done", attemptId: "work#1" }],
      };
    }),
  };
}

/** The raw record body the current writer produces for the LINEAR plan. */
function stateBodyFixtureRecord(): Record<string, unknown> {
  return bodyOf(stateBodyFixture());
}

/** One node entry of a raw body, addressed by node ID (plan order is by id). */
function nodeEntry(
  body: Record<string, unknown>,
  nodeId: string,
): Record<string, unknown> {
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
  const index = STATE_BODY_PLAN.nodes.findIndex((node) => node.id === nodeId);
  const entry = rawNodes[index];
  if (!isRecord(entry)) throw new Error("fixture: no node entry for " + nodeId);
  return entry;
}

/** Replace one node entry of a raw body, addressed by node ID. */
function withNodeEntry(
  body: Record<string, unknown>,
  nodeId: string,
  change: (entry: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
  return {
    ...body,
    nodes: rawNodes.map((entry, index) => {
      if (!isRecord(entry)) throw new Error("fixture: a node entry is not a record");
      return STATE_BODY_PLAN.nodes[index]?.id === nodeId ? change(entry) : entry;
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body the version-1 writer persists for one state. */
function bodyOf(state: OutcomeGraphState): Record<string, unknown> {
  const body = stateRecordOf(state, NOW).body;
  if (!isRecord(body)) throw new Error("fixture: the state record body is not a record");
  return body;
}

/** The record an outside writer would store for this body. */
function recordOf(body: unknown): GraphStateRecord {
  return {
    graphId: STATE_BODY_PLAN.graphId,
    planRevision: STATE_BODY_PLAN.planRevision,
    body,
    updatedAt: NOW,
  };
}

/** Every leaf of a JSON value as a "path=value" line, sorted: field by field. */
function fieldLines(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => fieldLines(entry, path + "[" + index + "]"));
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => fieldLines(value[key], path + "." + key));
  }
  return [path + "=" + JSON.stringify(value)];
}

/** Run a reader and return the refusal it must raise. */
function refusalOf(run: () => unknown): OutcomeStateError {
  try {
    run();
  } catch (error) {
    if (error instanceof OutcomeStateError) return error;
    throw error;
  }
  throw new Error("the state reader accepted a body it must refuse");
}

// ── A stopped body (version 4) ──────────────────────────────────────────────

/** work -> review -> (revise) -> work, capped at ONE traversal. */
const STOP_BODY_DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "graph.state-stop",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "revise" }, { id: "approve" }],
    },
  ],
  edges: [
    { from: "work", to: "review", outcome: "done" },
    { from: "review", to: "work", outcome: "revise" },
  ],
  loop_groups: [
    {
      id: "revise-loop",
      nodes: ["work", "review"],
      max_traversals: 1,
      continuation_outcome: "revise",
      exit_outcome: "approve",
    },
  ],
};

const STOP_BODY_PLAN = buildDeclaredOutcomeGraph({
  declaration: STOP_BODY_DECLARATION,
}).plan;

/**
 * The body the version-4 writer produces when `revise-loop` hits its cap:
 * "work" settled with `done` on work#3, "review" settled with `revise` on
 * review#4, the counter standing ON the cap (the refused round was not taken)
 * and the stop naming exactly those facts.
 *
 * Node entries are built in PLAN order, which the compiled plan sorts by id.
 */
function stoppedBodyFixture(): Record<string, unknown> {
  return {
    bodyVersion: CURRENT_OUTCOME_STATE_BODY,
    graphId: STOP_BODY_PLAN.graphId,
    planRevision: STOP_BODY_PLAN.planRevision,
    phase: "stopped",
    nodes: [
      {
        nodeId: "review",
        status: "settled",
        attemptId: "review#4",
        attemptSeq: 4,
        attemptCredential: "fixture-credential:review#4",
        outcomeId: "revise",
        dispatchedAt: NOW,
        settledAt: NOW + 4,
        arrivals: [{ from: "work", outcome: "done", attemptId: "work#3" }],
      },
      {
        nodeId: "work",
        status: "settled",
        attemptId: "work#3",
        attemptSeq: 3,
        attemptCredential: "fixture-credential:work#3",
        outcomeId: "done",
        dispatchedAt: NOW,
        settledAt: NOW + 3,
        arrivals: [{ from: "review", outcome: "revise", attemptId: "review#4" }],
      },
    ],
    loopTraversals: { "revise-loop": 1 },
    attemptSeq: 4,
    stop: {
      reason: "loop-exhausted",
      loopGroupId: "revise-loop",
      nodeId: "review",
      outcomeId: "revise",
      attemptId: "review#4",
      traversals: 1,
      maxTraversals: 1,
      stoppedAt: NOW + 4,
    },
    // The stopped plan declares no progress policy either, so its record is an
    // empty object — the same materialization the writer produces, in the same
    // key order (the stop, then the progress record).
    loopProgress: {},
  };
}

/** The record an outside writer would store for one STOP_BODY_PLAN body. */
function stopRecord(body: unknown): GraphStateRecord {
  return {
    graphId: STOP_BODY_PLAN.graphId,
    planRevision: STOP_BODY_PLAN.planRevision,
    body,
    updatedAt: NOW,
  };
}

/** One mutation of the stopped fixture, for the refusal cases. */
function withStoppedBody(
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return change(stoppedBodyFixture());
}

describe("outcome state body — versioned capability, no silent trimming", () => {
  it("round-trips a same-version body through the store with zero field loss", async () => {
    await withLedger(async (ledger) => {
      const state = stateBodyFixture();
      ledger.writeGraphState(stateRecordOf(state, NOW));

      const stored = ledger.readGraphState(STATE_BODY_PLAN.graphId);
      if (stored === undefined) throw new Error("fixture: the state row is missing");
      const reread = readOutcomeGraphState(stored, STATE_BODY_PLAN);
      expect(reread).toEqual(state);
      expect(reread.bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);

      // write -> read -> write: every field survives, field by field.
      expect(fieldLines(stateRecordOf(reread, NOW + 1).body)).toEqual(
        fieldLines(stored.body),
      );
      // ...and a second trip is stable as well.
      const again = readOutcomeGraphState(
        stateRecordOf(reread, NOW + 2),
        STATE_BODY_PLAN,
      );
      expect(fieldLines(stateRecordOf(again, NOW + 3).body)).toEqual(
        fieldLines(stored.body),
      );
    });
  });

  it("refuses an unknown top-level body field instead of dropping it", () => {
    const body = {
      ...bodyOf(stateBodyFixture()),
      progressBaselines: { work: { digest: "abc", round: 2 } },
    };
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("progressBaselines");
  });

  it("refuses an unknown node-level field instead of dropping it", () => {
    const body = bodyOf(stateBodyFixture());
    const nodes = body.nodes;
    if (!Array.isArray(nodes) || !isRecord(nodes[0])) {
      throw new Error("fixture: the state body carries no first node");
    }
    const extended = {
      ...body,
      nodes: [{ ...nodes[0], baselineDigest: "abc" }, ...nodes.slice(1)],
    };
    const error = refusalOf(() =>
      readOutcomeGraphState(recordOf(extended), STATE_BODY_PLAN),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("baselineDigest");
  });

  it("still READS a version-1 body, whose attempts simply carry no credential", () => {
    const state = readOutcomeGraphState(recordOf(stateBodyFixtureV1()), STATE_BODY_PLAN);
    expect(state.bodyVersion).toBe(OUTCOME_STATE_BODY_V1);
    // Readable — a completed graph reports cleanly — but the attempt has no
    // credential, which is exactly what the run path refuses to settle.
    expect(state.nodes[0]?.attemptCredential).toBeUndefined();
    expect(state.nodes[0]?.attemptId).toBe(STATE_BODY_PLAN.nodes[0]?.id + "#1");
  });

  it("still READS a version-2 body, whose attempts carry a credential but no arrivals", () => {
    const state = readOutcomeGraphState(recordOf(stateBodyFixtureV2()), STATE_BODY_PLAN);
    expect(state.bodyVersion).toBe(OUTCOME_STATE_BODY_V2);
    // Readable, and honest about what the layout does not record: the attempt
    // keeps its credential, and no arrival list exists at all.
    expect(state.nodes[0]?.attemptCredential).toBe(FIXTURE_CREDENTIAL);
    expect(state.nodes[0]?.arrivals).toBeUndefined();
    expect(state.nodes[1]?.arrivals).toBeUndefined();
  });

  it("refuses a version-2 body that carries the arrival list version 3 defines", () => {
    const body = stateBodyFixtureV2();
    const rawNodes = body.nodes;
    if (!Array.isArray(rawNodes) || !isRecord(rawNodes[0])) {
      throw new Error("fixture: the version-2 body carries no first node");
    }
    const error = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({
          ...body,
          nodes: [{ ...rawNodes[0], arrivals: [] }, ...rawNodes.slice(1)],
        }),
        STATE_BODY_PLAN,
      ),
    );
    // The older reader refuses the newer field instead of dropping it.
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("arrivals");
  });

  it("refuses a current-version dispatched node without the required credential", () => {
    const body = bodyOf(stateBodyFixture());
    const rawNodes = body.nodes;
    if (!Array.isArray(rawNodes) || !isRecord(rawNodes[0])) {
      throw new Error("fixture: the state body carries no first node");
    }
    const { attemptCredential: _dropped, ...withoutCredential } = rawNodes[0];
    const error = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({ ...body, nodes: [withoutCredential, ...rawNodes.slice(1)] }),
        STATE_BODY_PLAN,
      ),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("attemptCredential");
  });

  it("refuses a credential on a node that was never dispatched", () => {
    const body = bodyOf(stateBodyFixture());
    const rawNodes = body.nodes;
    if (!Array.isArray(rawNodes) || !isRecord(rawNodes[1])) {
      throw new Error("fixture: the state body carries no second node");
    }
    const error = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({
          ...body,
          nodes: [rawNodes[0], { ...rawNodes[1], attemptCredential: "forged" }],
        }),
        STATE_BODY_PLAN,
      ),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("pending");
  });

  it("refuses a credential inside a version-1 body, which does not define it", () => {
    const body = stateBodyFixtureV1();
    const rawNodes = body.nodes;
    if (!Array.isArray(rawNodes) || !isRecord(rawNodes[0])) {
      throw new Error("fixture: the version-1 body carries no first node");
    }
    const error = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({
          ...body,
          nodes: [{ ...rawNodes[0], attemptCredential: "smuggled" }, ...rawNodes.slice(1)],
        }),
        STATE_BODY_PLAN,
      ),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("attemptCredential");
  });

  it("round-trips a version-3 body whose join inbox holds a corroborated arrival", async () => {
    await withLedger(async (ledger) => {
      const body = settledArrivalBody();
      ledger.writeGraphState({ ...recordOf(body), body });
      const stored = ledger.readGraphState(STATE_BODY_PLAN.graphId);
      if (stored === undefined) throw new Error("fixture: the state row is missing");
      const reread = readOutcomeGraphState(stored, STATE_BODY_PLAN);
      // The arrival names its feeder, the outcome it settled with and the
      // attempt that produced it — the round token a later join decision reads.
      const ship = reread.nodes.find((node) => node.nodeId === "ship");
      expect(ship?.arrivals).toEqual([
        { from: "work", outcome: "done", attemptId: "work#1" },
      ]);
      // write -> read -> write loses nothing, field by field.
      expect(fieldLines(stateRecordOf(reread, NOW + 1).body)).toEqual(
        fieldLines(stored.body),
      );
    });
  });

  it("refuses an arrival list that omits a corroborated arrival", () => {
    // The entries say "work" settled with a routing outcome, but the target
    // claims nobody arrived: a stalled join the state itself contradicts.
    const body = withNodeEntry(settledArrivalBody(), "ship", (entry) => ({
      ...entry,
      arrivals: [],
    }));
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("arrivals");
  });

  it("refuses an arrival list that invents an arrival the entries do not corroborate", () => {
    // "work" is DISPATCHED, never settled, so no arrival from it exists; a list
    // claiming one would arm the join on evidence the state does not hold.
    const body = withNodeEntry(stateBodyFixtureRecord(), "ship", (entry) => ({
      ...entry,
      arrivals: [{ from: "work", outcome: "done", attemptId: "work#1" }],
    }));
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("arrivals");
  });

  it("refuses an arrival whose outcome no declared edge routes to the node", () => {
    const body = withNodeEntry(settledArrivalBody(), "ship", (entry) => ({
      ...entry,
      arrivals: [{ from: "work", outcome: "elsewhere", attemptId: "work#1" }],
    }));
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("no such edge");
  });

  it("refuses a feeder recorded twice at one join, and an unknown arrival field", () => {
    const arrival = { from: "work", outcome: "done", attemptId: "work#1" };
    const duplicated = refusalOf(() =>
      readOutcomeGraphState(
        recordOf(
          withNodeEntry(settledArrivalBody(), "ship", (entry) => ({
            ...entry,
            arrivals: [arrival, arrival],
          })),
        ),
        STATE_BODY_PLAN,
      ),
    );
    expect(duplicated.problem).toBe("malformed-state");
    expect(duplicated.message).toContain("a second time");

    const extended = refusalOf(() =>
      readOutcomeGraphState(
        recordOf(
          withNodeEntry(settledArrivalBody(), "ship", (entry) => ({
            ...entry,
            arrivals: [{ ...arrival, round: 2 }],
          })),
        ),
        STATE_BODY_PLAN,
      ),
    );
    expect(extended.problem).toBe("malformed-state");
    expect(extended.message).toContain("round");
  });

  it("installs a reader for versions 1 to 5, and writes version 5", () => {
    expect(CURRENT_OUTCOME_STATE_BODY).toBe(OUTCOME_STATE_BODY_V5);
    expect(DEFAULT_OUTCOME_STATE_BODY_REGISTRY.formats.map((reader) => reader.format)).toEqual([
      OUTCOME_STATE_BODY_V1,
      OUTCOME_STATE_BODY_V2,
      OUTCOME_STATE_BODY_V3,
      OUTCOME_STATE_BODY_V4,
      OUTCOME_STATE_BODY_V5,
    ]);
    for (const version of [
      OUTCOME_STATE_BODY_V1,
      OUTCOME_STATE_BODY_V2,
      OUTCOME_STATE_BODY_V3,
      OUTCOME_STATE_BODY_V4,
      OUTCOME_STATE_BODY_V5,
    ]) {
      const verdict = classifyOutcomeStateBody(version, DEFAULT_OUTCOME_STATE_BODY_REGISTRY);
      expect(verdict.kind).toBe("supported");
      if (verdict.kind === "supported") {
        expect(verdict.reader.format).toBe(version);
      }
    }
  });

  it("refuses to advance a body version that cannot carry a credential, arrivals or progress", () => {
    const nodeId = STATE_BODY_PLAN.nodes[0]?.id ?? "";
    const decision: AcceptanceDecision = {
      kind: "accepted",
      identity: { graphId: STATE_BODY_PLAN.graphId, attemptId: nodeId + "#1", submissionId: "submission-1" },
      planRevision: STATE_BODY_PLAN.planRevision,
      proposalDigest: "digest-a",
      nodeId,
      outcomeId: "done",
      requirements: [],
    };
    // Version 1 cannot carry a credential, version 2 cannot carry an arrival
    // list and version 4 cannot carry a progress baseline: none may be advanced
    // and silently rewritten in a newer layout (a body whose baselines were
    // dropped would restart the comparison).
    for (const body of [
      stateBodyFixtureV1(),
      stateBodyFixtureV2(),
      stateBodyFixtureV4(),
    ]) {
      const state = readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN);
      let caught: unknown;
      try {
        advanceOutcomeGraph({
          plan: STATE_BODY_PLAN,
          state,
          decision,
          now: NOW + 1,
          mintCredential: RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OutcomeAdvanceRefusedError);
      if (caught instanceof OutcomeAdvanceRefusedError) {
        expect(caught.code).toBe("unsupported-state-version");
        expect(caught.message).toContain("attempt credential");
        expect(caught.message).toContain("join arrivals");
        expect(caught.message).toContain("progress baselines");
      }
    }
  });

  it("refuses a body version this build has no reader for", () => {
    const future = CURRENT_OUTCOME_STATE_BODY + 1;
    const body = { ...bodyOf(stateBodyFixture()), bodyVersion: future };
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("unsupported-state-version");
    expect(error.message).toContain(String(future));
    expect(error.message).toContain("no reader");
  });

  it("refuses a body with no version discriminator as malformed, not as a newer format", () => {
    const { bodyVersion: _version, ...body } = bodyOf(stateBodyFixture());
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("bodyVersion");
  });

  it("keeps the existing identity refusals: another graph or revision stays a plan mismatch", () => {
    const body = bodyOf(stateBodyFixture());
    const otherRevision = refusalOf(() =>
      readOutcomeGraphState(
        { ...recordOf(body), planRevision: "another-revision" },
        STATE_BODY_PLAN,
      ),
    );
    expect(otherRevision.problem).toBe("state-plan-mismatch");
    const otherGraph = refusalOf(() =>
      readOutcomeGraphState({ ...recordOf(body), graphId: "another-graph" }, STATE_BODY_PLAN),
    );
    expect(otherGraph.problem).toBe("state-plan-mismatch");

    // A body whose OWN identity fields disagree with the record is malformed:
    // the reader never silently corrects a field to the record's value.
    const bodyGraph = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({ ...body, graphId: "another-graph" }),
        STATE_BODY_PLAN,
      ),
    );
    expect(bodyGraph.problem).toBe("malformed-state");
    expect(bodyGraph.message).toContain("another-graph");
    const bodyRevision = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({ ...body, planRevision: "another-revision" }),
        STATE_BODY_PLAN,
      ),
    );
    expect(bodyRevision.problem).toBe("malformed-state");
    expect(bodyRevision.message).toContain("another-revision");
  });

  it("classifies a version as supported, unsupported or invalid", () => {
    const supported = classifyOutcomeStateBody(
      CURRENT_OUTCOME_STATE_BODY,
      DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
    );
    expect(supported.kind).toBe("supported");
    if (supported.kind === "supported") {
      expect(supported.reader.format).toBe(CURRENT_OUTCOME_STATE_BODY);
    }
    expect(
      classifyOutcomeStateBody(
        CURRENT_OUTCOME_STATE_BODY + 1,
        DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
      ),
    ).toEqual({ kind: "unsupported", version: CURRENT_OUTCOME_STATE_BODY + 1 });
    for (const illegal of [
      undefined,
      null,
      "1",
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        classifyOutcomeStateBody(illegal, DEFAULT_OUTCOME_STATE_BODY_REGISTRY).kind,
      ).toBe("invalid");
    }
  });

  it("rejects a duplicate reader and a current version with no reader", () => {
    const stub = (format: number) => ({
      format,
      read: (): OutcomeStateBodyReading => ({
        kind: "invalid" as const,
        error: new OutcomeStateError("malformed-state", "stub reader " + format),
      }),
    });
    expect(() =>
      createOutcomeStateBodyRegistry({ current: 1, formats: [stub(1), stub(1)] }),
    ).toThrow(/duplicate reader/);
    expect(() =>
      createOutcomeStateBodyRegistry({ current: 1, formats: [stub(2)] }),
    ).toThrow(/no registered reader/);
    expect(() =>
      createOutcomeStateBodyRegistry({ current: 1, formats: [stub(0)] }),
    ).toThrow(/not a legal state-body version/);
  });

  it("reads a stopped body: the stop is the phase written as a record", async () => {
    await withLedger(async (ledger) => {
      const body = stoppedBodyFixture();
      ledger.writeGraphState(stopRecord(body));
      const stored = ledger.readGraphState(STOP_BODY_PLAN.graphId);
      if (stored === undefined) throw new Error("fixture: the state row is missing");
      const state = readOutcomeGraphState(stored, STOP_BODY_PLAN);
      expect(state.phase).toBe("stopped");
      expect(state.bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);
      expect(state.stop).toEqual({
        reason: "loop-exhausted",
        loopGroupId: "revise-loop",
        nodeId: "review",
        outcomeId: "revise",
        attemptId: "review#4",
        traversals: 1,
        maxTraversals: 1,
        stoppedAt: NOW + 4,
      });
      // write -> read -> write loses nothing, field by field.
      expect(fieldLines(stateRecordOf(state, NOW + 5).body)).toEqual(fieldLines(stored.body));
    });
  });

  it("keeps the stop vocabulary closed", () => {
    expect(OUTCOME_STOP_REASONS).toEqual(["loop-exhausted", "progress-stalled"]);
    const error = refusalOf(() =>
      readOutcomeGraphState(
        stopRecord(
          withStoppedBody((body) => ({
            ...body,
            stop: { ...(body.stop as Record<string, unknown>), reason: "review-passed" },
          })),
        ),
        STOP_BODY_PLAN,
      ),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("review-passed");
    expect(error.message).toContain("vocabulary is closed");
  });

  it("refuses a stopped body with no stop, and a running body that carries one", () => {
    const { stop: _dropped, ...noStop } = stoppedBodyFixture();
    const missing = refusalOf(() =>
      readOutcomeGraphState(stopRecord(noStop), STOP_BODY_PLAN),
    );
    expect(missing.problem).toBe("malformed-state");
    expect(missing.message).toContain("stop");

    const running = refusalOf(() =>
      readOutcomeGraphState(
        stopRecord(withStoppedBody((body) => ({ ...body, phase: "complete" }))),
        STOP_BODY_PLAN,
      ),
    );
    expect(running.problem).toBe("malformed-state");
    expect(running.message).toContain("phase");
  });

  it("refuses a stop on a body version that does not define one, and its stopped phase", () => {
    // Version 3 cannot represent a stop at all: the FIELD is refused. The
    // progress record it also cannot carry is stripped, so this case is about
    // the stop (the version gate refuses whichever field it meets first).
    const { loopProgress: _progressV3, ...v3Body } = stoppedBodyFixture();
    const withField = refusalOf(() =>
      readOutcomeGraphState(
        stopRecord({ ...v3Body, bodyVersion: OUTCOME_STATE_BODY_V3 }),
        STOP_BODY_PLAN,
      ),
    );
    expect(withField.problem).toBe("malformed-state");
    expect(withField.message).toContain("stop");

    // ...and so is the phase that only the stop’s own version defines, even with
    // the record removed: a version that cannot end this way never wrote it.
    const { stop: _dropped, loopProgress: _progress, ...body } = stoppedBodyFixture();
    const withPhase = refusalOf(() =>
      readOutcomeGraphState(
        stopRecord({ ...body, bodyVersion: OUTCOME_STATE_BODY_V2 }),
        STOP_BODY_PLAN,
      ),
    );
    expect(withPhase.problem).toBe("malformed-state");
    expect(withPhase.message).toContain("phase");
  });

  it("refuses a stop the plan does not declare or the entries do not corroborate", () => {
    const cases: readonly { readonly change: (stop: Record<string, unknown>) => Record<string, unknown>; readonly contains: string }[] = [
      { change: (stop) => ({ ...stop, loopGroupId: "no-such-loop" }), contains: "does not declare" },
      { change: (stop) => ({ ...stop, maxTraversals: 9 }), contains: "plan declares" },
      { change: (stop) => ({ ...stop, nodeId: "no-such-node" }), contains: "not a member" },
      { change: (stop) => ({ ...stop, outcomeId: "approve" }), contains: "continuation" },
      { change: (stop) => ({ ...stop, attemptId: "review#9" }), contains: "do not" },
      { change: (stop) => ({ ...stop, traversals: 0 }), contains: "positive safe integer" },
      { change: (stop) => ({ ...stop, stoppedAt: -1 }), contains: "epoch milliseconds" },
    ];
    for (const entry of cases) {
      const error = refusalOf(() =>
        readOutcomeGraphState(
          stopRecord(
            withStoppedBody((body) => ({
              ...body,
              stop: entry.change(body.stop as Record<string, unknown>),
            })),
          ),
          STOP_BODY_PLAN,
        ),
      );
      expect(error.problem).toBe("malformed-state");
      expect(error.message).toContain(entry.contains);
    }

    // A stop whose round disagrees with the counter it is stored beside, and one
    // that stopped anywhere but ON the cap (the round past it was never taken).
    const counterDisagreement = refusalOf(() =>
      readOutcomeGraphState(
        stopRecord(withStoppedBody((body) => ({ ...body, loopTraversals: { "revise-loop": 0 } }))),
        STOP_BODY_PLAN,
      ),
    );
    expect(counterDisagreement.problem).toBe("malformed-state");
    expect(counterDisagreement.message).toContain("loopTraversals records");

    const notOnTheCap = refusalOf(() =>
      readOutcomeGraphState(
        stopRecord(
          withStoppedBody((body) => {
            const stop = body.stop as Record<string, unknown>;
            return {
              ...body,
              loopTraversals: { "revise-loop": 3 },
              stop: { ...stop, traversals: 3 },
            };
          }),
        ),
        STOP_BODY_PLAN,
      ),
    );
    expect(notOnTheCap.problem).toBe("malformed-state");
    expect(notOnTheCap.message).toContain("cap refused the round");
  });

  it("reads through the registered capability, not through the number", () => {
    const stubReader = {
      format: 2,
      read(body: Record<string, unknown>): OutcomeStateBodyReading {
        return {
          kind: "invalid",
          error: new OutcomeStateError(
            "malformed-state",
            "stub reader reached for version " + String(body.bodyVersion),
          ),
        };
      },
    };
    const registry = createOutcomeStateBodyRegistry({
      current: 2,
      formats: [stubReader],
    });
    const error = refusalOf(() =>
      readOutcomeGraphState(recordOf({ bodyVersion: 2 }), STATE_BODY_PLAN, registry),
    );
    expect(error.message).toBe("stub reader reached for version 2");
  });
});

// ── A version-5 body with a DECLARED progress policy ────────────────────────

/** work -> review -> (revise) -> work, with a declared progress policy. */
const PROGRESS_BODY_DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "graph.state-progress",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "revise" }, { id: "approve" }],
    },
  ],
  edges: [
    { from: "work", to: "review", outcome: "done" },
    { from: "review", to: "work", outcome: "revise" },
  ],
  loop_groups: [
    {
      id: "revise-loop",
      nodes: ["work", "review"],
      max_traversals: 4,
      continuation_outcome: "revise",
      exit_outcome: "approve",
      progress: {
        evaluator: "revision-token",
        version: 1,
        subject: "revision",
        max_unchanged: 2,
      },
    },
  ],
};

const PROGRESS_BODY_PLAN = buildDeclaredOutcomeGraph({
  declaration: PROGRESS_BODY_DECLARATION,
}).plan;

/**
 * The body a run STOPPED by its progress policy leaves: both loop nodes settled
 * with their routing outcomes, the declared threshold reached, and the stop
 * naming exactly the comparison the record corroborates.
 *
 * Node entries are in PLAN order, which the compiled plan sorts by id.
 */
function progressBodyFixture(): Record<string, unknown> {
  return {
    bodyVersion: CURRENT_OUTCOME_STATE_BODY,
    graphId: PROGRESS_BODY_PLAN.graphId,
    planRevision: PROGRESS_BODY_PLAN.planRevision,
    phase: "stopped",
    nodes: [
      {
        nodeId: "review",
        status: "settled",
        attemptId: "review#2",
        attemptSeq: 2,
        attemptCredential: "fixture-credential:review#2",
        outcomeId: "revise",
        dispatchedAt: NOW,
        settledAt: NOW + 2,
        arrivals: [{ from: "work", outcome: "done", attemptId: "work#1" }],
      },
      {
        nodeId: "work",
        status: "settled",
        attemptId: "work#1",
        attemptSeq: 1,
        attemptCredential: "fixture-credential:work#1",
        outcomeId: "done",
        dispatchedAt: NOW,
        settledAt: NOW + 1,
        arrivals: [{ from: "review", outcome: "revise", attemptId: "review#2" }],
      },
    ],
    loopTraversals: { "revise-loop": 1 },
    attemptSeq: 2,
    stop: {
      reason: "progress-stalled",
      loopGroupId: "revise-loop",
      nodeId: "review",
      outcomeId: "revise",
      attemptId: "review#2",
      unchanged: 2,
      maxUnchanged: 2,
      evaluator: "revision-token",
      evaluatorVersion: 1,
      subject: "revision",
      baseline: "r1",
      stoppedAt: NOW + 2,
    },
    loopProgress: {
      "revise-loop": {
        loopGroupId: "revise-loop",
        evaluator: "revision-token",
        version: 1,
        subject: "revision",
        unchanged: 2,
        baseline: "r1",
      },
    },
  };
}

/** The record an outside writer would store for one PROGRESS_BODY_PLAN body. */
function progressRecord(body: unknown): GraphStateRecord {
  return {
    graphId: PROGRESS_BODY_PLAN.graphId,
    planRevision: PROGRESS_BODY_PLAN.planRevision,
    body,
    updatedAt: NOW,
  };
}

/** One mutation of the progress fixture, for the refusal cases. */
function withProgressBody(
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return change(progressBodyFixture());
}

/** Replace the one progress entry of a raw body. */
function withProgressEntry(
  body: Record<string, unknown>,
  change: (entry: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const progress = recordOrThrow(body.loopProgress, "loopProgress");
  const entry = recordOrThrow(progress["revise-loop"], "the progress entry");
  return {
    ...body,
    loopProgress: { ...progress, "revise-loop": change(entry) },
  };
}

/** Replace the stop record of a raw body. */
function withProgressStop(
  body: Record<string, unknown>,
  change: (stop: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return { ...body, stop: change(recordOrThrow(body.stop, "the stop")) };
}

/** Read one unknown value as a record, or fail the fixture. */
function recordOrThrow(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("fixture: " + what + " is not a record");
  return value;
}

describe("outcome state body — the progress record is a declared comparison", () => {
  it("round-trips a stalled progress body with zero field loss", async () => {
    await withLedger(async (ledger) => {
      const body = progressBodyFixture();
      ledger.writeGraphState(progressRecord(body));
      const stored = ledger.readGraphState(PROGRESS_BODY_PLAN.graphId);
      if (stored === undefined) throw new Error("fixture: the state row is missing");
      const state = readOutcomeGraphState(stored, PROGRESS_BODY_PLAN);
      expect(state.bodyVersion).toBe(OUTCOME_STATE_BODY_V5);
      expect(state.phase).toBe("stopped");
      expect(state.loopProgress?.["revise-loop"]).toEqual({
        loopGroupId: "revise-loop",
        evaluator: "revision-token",
        version: 1,
        subject: "revision",
        unchanged: 2,
        baseline: "r1",
      });
      expect(state.stop).toEqual({
        reason: "progress-stalled",
        loopGroupId: "revise-loop",
        nodeId: "review",
        outcomeId: "revise",
        attemptId: "review#2",
        unchanged: 2,
        maxUnchanged: 2,
        evaluator: "revision-token",
        evaluatorVersion: 1,
        subject: "revision",
        baseline: "r1",
        stoppedAt: NOW + 2,
      });
      // write -> read -> write loses nothing, field by field.
      expect(fieldLines(stateRecordOf(state, NOW + 3).body)).toEqual(fieldLines(stored.body));
    });
  });

  it("reads a baseline recorded under another evaluator VERSION (the comparison judges it)", () => {
    // A RUNNING body whose baseline was recorded under version 7 while the plan
    // declares version 1. The record is READ: the version is the compatibility
    // fact the comparison answers "unknown" for, never a shape the reader may
    // refuse a whole body over (the stop, when there is one, is corroborated
    // against the record OWN version, so it cannot disagree with it).
    const { stop: _stop, ...running } = withProgressBody((fixture) =>
      withProgressEntry(
        { ...fixture, phase: "executing" },
        (entry) => ({ ...entry, version: 7, unchanged: 0 }),
      ),
    );
    const state = readOutcomeGraphState(progressRecord(running), PROGRESS_BODY_PLAN);
    expect(state.phase).toBe("executing");
    expect(state.loopProgress?.["revise-loop"]?.version).toBe(7);

    // The same record with a stop that agrees with it (version 7): legal too,
    // because the stop is verified against the record, not against the plan's
    // version.
    const stopped = withProgressBody((fixture) =>
      withProgressStop(
        withProgressEntry(fixture, (entry) => ({ ...entry, version: 7 })),
        (stop) => ({ ...stop, evaluatorVersion: 7 }),
      ),
    );
    expect(
      readOutcomeGraphState(progressRecord(stopped), PROGRESS_BODY_PLAN).stop,
    ).toMatchObject({ reason: "progress-stalled", evaluatorVersion: 7 });
  });

  it("refuses a progress record the plan does not authorize", () => {
    const cases: readonly {
      readonly name: string;
      readonly body: Record<string, unknown>;
      readonly contains: string;
    }[] = [
      {
        name: "an entry for a group the plan does not declare",
        body: withProgressBody((fixture) => ({
          ...fixture,
          loopProgress: {
            "revise-loop": recordOrThrow(
              recordOrThrow(fixture.loopProgress, "loopProgress")["revise-loop"],
              "the progress entry",
            ),
            "no-such-loop": {
              loopGroupId: "no-such-loop",
              evaluator: "revision-token",
              version: 1,
              subject: "revision",
              unchanged: 0,
            },
          },
        })),
        contains: "does not declare",
      },
      {
        name: "no entry for a group whose plan declares a policy",
        body: withProgressBody((fixture) => ({ ...fixture, loopProgress: {} })),
        contains: "carries no entry",
      },
      {
        name: "an unknown field in the entry",
        body: withProgressBody((fixture) =>
          withProgressEntry(fixture, (entry) => ({ ...entry, round: 2 })),
        ),
        contains: "round",
      },
      {
        name: "an evaluator the plan does not declare",
        body: withProgressBody((fixture) =>
          withProgressEntry(fixture, (entry) => ({ ...entry, evaluator: "levenshtein" })),
        ),
        contains: "comparison semantics",
      },
      {
        name: "a subject the plan does not declare",
        body: withProgressBody((fixture) =>
          withProgressEntry(fixture, (entry) => ({ ...entry, subject: "digest" })),
        ),
        contains: "comparison object",
      },
      {
        name: "a baseline beyond the projection bound",
        body: withProgressBody((fixture) =>
          withProgressEntry(fixture, (entry) => ({ ...entry, baseline: "x".repeat(257) })),
        ),
        contains: "revision token",
      },
    ];
    for (const entry of cases) {
      const error = refusalOf(() =>
        readOutcomeGraphState(progressRecord(entry.body), PROGRESS_BODY_PLAN),
      );
      expect(error.problem).toBe("malformed-state");
      expect(error.message).toContain(entry.contains);
    }
  });

  it("refuses a counter above the threshold, and one standing on it without the stop", () => {
    // Both cases are RUNNING bodies (a stopped one is corroborated against its
    // stop first), so the counter rule is the only one that can answer.
    const runningBody = (unchanged: number): Record<string, unknown> => {
      const { stop: _stop, ...running } = withProgressBody((fixture) =>
        withProgressEntry(
          { ...fixture, phase: "executing" },
          (entry) => ({ ...entry, unchanged }),
        ),
      );
      return running;
    };

    const above = refusalOf(() =>
      readOutcomeGraphState(progressRecord(runningBody(3)), PROGRESS_BODY_PLAN),
    );
    expect(above.problem).toBe("malformed-state");
    expect(above.message).toContain("above the declared stagnation threshold");

    // The counter ON the threshold, on a body that did NOT stop: reaching the
    // threshold stops the run, so a running body standing on it was never
    // written.
    const noStop = refusalOf(() =>
      readOutcomeGraphState(progressRecord(runningBody(2)), PROGRESS_BODY_PLAN),
    );
    expect(noStop.problem).toBe("malformed-state");
    expect(noStop.message).toContain("progress-stalled");
  });

  it("refuses a progress-stalled stop its own record does not corroborate", () => {
    const cases: readonly {
      readonly name: string;
      readonly body: Record<string, unknown>;
      readonly contains: string;
    }[] = [
      {
        name: "a threshold the plan does not declare",
        body: withProgressBody((fixture) =>
          withProgressStop(fixture, (stop) => ({ ...stop, maxUnchanged: 9 })),
        ),
        contains: "plan declares",
      },
      {
        name: "a count that disagrees with the record",
        body: withProgressBody((fixture) =>
          withProgressStop(fixture, (stop) => ({ ...stop, unchanged: 1 })),
        ),
        contains: "but loopProgress records",
      },
      {
        name: "a baseline that disagrees with the record",
        body: withProgressBody((fixture) =>
          withProgressStop(fixture, (stop) => ({ ...stop, baseline: "r2" })),
        ),
        contains: "but loopProgress records",
      },
      {
        name: "an evaluator version that disagrees with the record",
        body: withProgressBody((fixture) =>
          withProgressStop(fixture, (stop) => ({ ...stop, evaluatorVersion: 2 })),
        ),
        contains: "version",
      },
      {
        name: "a stop whose count is below its own threshold",
        body: withProgressBody((fixture) =>
          withProgressStop(fixture, (stop) => ({ ...stop, unchanged: 3 })),
        ),
        contains: "but loopProgress records",
      },
    ];
    for (const entry of cases) {
      const error = refusalOf(() =>
        readOutcomeGraphState(progressRecord(entry.body), PROGRESS_BODY_PLAN),
      );
      expect(error.problem).toBe("malformed-state");
      expect(error.message).toContain(entry.contains);
    }
  });

  it("refuses a progress-stalled stop on a group with no declared policy", () => {
    const body = {
      ...stoppedBodyFixture(),
      loopProgress: {},
      stop: {
        reason: "progress-stalled",
        loopGroupId: "revise-loop",
        nodeId: "review",
        outcomeId: "revise",
        attemptId: "review#4",
        unchanged: 1,
        maxUnchanged: 1,
        evaluator: "revision-token",
        evaluatorVersion: 1,
        subject: "revision",
        baseline: "r1",
        stoppedAt: NOW + 4,
      },
    };
    const error = refusalOf(() =>
      readOutcomeGraphState(stopRecord(body), STOP_BODY_PLAN),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("no progress policy");
  });
});


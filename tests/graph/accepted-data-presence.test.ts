/// <reference types="bun-types" />

/**
 * Accepted data has an EXPLICIT presence, and a ceiling it never crosses (D1).
 *
 * A submission that carried no `data` key is `{ kind: "absent" }`; one that
 * carried JSON `null`, `{}` or `""` is `{ kind: "value", … }`. All four MUST
 * stay four DISTINCT persisted outcomes, readable back through the store: the
 * previous format stored the bare payload, so "no data" and "accepted null"
 * were the same bytes (`null`) and no reader could recover which of the two
 * the acceptance had recorded.
 *
 * The ceiling is enforced twice, and both gates are exercised here: the
 * acceptance path refuses an over-limit payload as STRUCTURED data (nothing at
 * all is written), and the store's own encoder refuses it again so a row is
 * never truncated to fit a column.
 *
 * Every case runs in its own temp directory; nothing writes to a real store.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { submitOutcome } from "../../src/graph/outcome/acceptance.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import type { AcceptedData } from "../../src/graph/domain/model.ts";
import { acceptedDataBytes } from "../../src/graph/store/json.ts";
import {
  ACCEPTED_DATA_MAX_BYTES,
  GraphStore,
  GraphStoreFormatError,
  GraphStoreWriteError,
  GRAPH_STORE_TABLES,
  graphStoreFilePath,
} from "../../src/graph/store/index.ts";
import { createDatabase } from "../../src/memory/db-driver.ts";

const GRAPH = "p42.presence";
const NODE = "work";
const NOW = 1_700_000_000_000;

const declaration = {
  version: 3,
  name: GRAPH,
  nodes: [
    {
      id: NODE,
      agent: "agent.worker",
      prompt: "Produce an outcome.",
      outcomes: [{ id: "done" }],
    },
  ],
  edges: [],
};

/** No acceptance requirement: the decision is accepted vacuously. */
const VALIDATORS = createValidatorRegistry([]);

/** One presence case: a complete proposal and the outcome it must persist. */
interface PresenceCase {
  readonly attemptId: string;
  readonly proposal: Record<string, unknown>;
  readonly expected: AcceptedData;
}

/** The four cases: no `data` key at all, then `null`, `{}` and `""`. */
const CASES: readonly PresenceCase[] = [
  {
    attemptId: "work#1",
    proposal: { nodeId: NODE, outcomeId: "done" },
    expected: { kind: "absent" },
  },
  {
    attemptId: "work#2",
    proposal: { nodeId: NODE, outcomeId: "done", data: null },
    expected: { kind: "value", value: null },
  },
  {
    attemptId: "work#3",
    proposal: { nodeId: NODE, outcomeId: "done", data: {} },
    expected: { kind: "value", value: {} },
  },
  {
    attemptId: "work#4",
    proposal: { nodeId: NODE, outcomeId: "done", data: "" },
    expected: { kind: "value", value: "" },
  },
];

async function withRoot(
  prefix: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One table's row count, read through a raw second connection. */
async function rawCount(dir: string, table: string): Promise<number> {
  const db = await createDatabase(graphStoreFilePath(dir));
  try {
    for (const row of db.query(`SELECT COUNT(*) AS n FROM ${table}`).all()) {
      if (typeof row === "object" && row !== null && !Array.isArray(row)) {
        const n = (row as Record<string, unknown>)["n"];
        if (typeof n === "number") return n;
      }
    }
    throw new Error("the store answered no count");
  } finally {
    db.close();
  }
}

/** The RAW payload texts of the accepted-results table, in attempt order. */
async function storedPayloadTexts(dir: string): Promise<string[]> {
  const db = await createDatabase(graphStoreFilePath(dir));
  try {
    const texts: string[] = [];
    for (const row of db
      .query(
        `SELECT payload FROM ${GRAPH_STORE_TABLES.acceptedResults} ORDER BY attempt_id`,
      )
      .all()) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
      const payload = (row as Record<string, unknown>)["payload"];
      if (typeof payload === "string") texts.push(payload);
    }
    return texts;
  } finally {
    db.close();
  }
}

describe("accepted data presence is explicit and bounded", () => {
  it("keeps absent, null, {} and \"\" as four distinct persisted outcomes", async () => {
    await withRoot("p42-presence-", async (dir) => {
      const graph = buildDeclaredOutcomeGraph({ declaration });
      const ledger = await SqliteAcceptanceLedger.create(dir);
      let closed = false;
      try {
        for (const entry of CASES) {
          const submitted = submitOutcome({
            plan: graph.plan,
            submittedPlanRevision: graph.binding.planRevision,
            identity: {
              graphId: GRAPH,
              attemptId: entry.attemptId,
              submissionId: `submission-${entry.attemptId}`,
            },
            proposal: entry.proposal,
            validators: VALIDATORS,
            artifactRoot: dir,
            ledger,
            now: NOW,
          });
          expect(submitted.kind).toBe("submitted");
        }

        // READ BACK THROUGH THE STORE: four proposals, four different answers.
        for (const entry of CASES) {
          expect(ledger.readAcceptedResult(GRAPH, entry.attemptId)?.payload).toEqual(
            entry.expected,
          );
        }
        ledger.close();
        closed = true;

        // THE PERSISTED BYTES ARE THE ENVELOPE, and they are pairwise distinct:
        // "distinguishable" is a property of the stored row, not of this
        // process's memory of what it submitted.
        const texts = await storedPayloadTexts(dir);
        expect(texts).toEqual([
          '{"kind":"absent"}',
          '{"kind":"value","value":null}',
          '{"kind":"value","value":{}}',
          '{"kind":"value","value":""}',
        ]);
        expect(new Set(texts).size).toBe(4);

        // A SECOND ledger over the same directory decodes the same four
        // outcomes — a restart reproduces them from the row alone.
        const reopened = await SqliteAcceptanceLedger.create(dir);
        try {
          for (const entry of CASES) {
            expect(
              reopened.readAcceptedResult(GRAPH, entry.attemptId)?.payload,
            ).toEqual(entry.expected);
          }
        } finally {
          reopened.close();
        }
      } finally {
        if (!closed) ledger.close();
      }
    });
  });

  it("refuses an over-limit payload at acceptance, by name, and writes nothing", async () => {
    await withRoot("p42-presence-limit-", async (dir) => {
      const graph = buildDeclaredOutcomeGraph({ declaration });
      const ledger = await SqliteAcceptanceLedger.create(dir);
      let closed = false;
      try {
        // The ceiling bounds the ENCODED envelope, so this payload is over it
        // while the proposal digest (a 1 MiB bound of its own) still reads it.
        const oversized = "x".repeat(ACCEPTED_DATA_MAX_BYTES + 1);
        const actualBytes = acceptedDataBytes({ kind: "value", value: oversized });
        expect(actualBytes).toBeGreaterThan(ACCEPTED_DATA_MAX_BYTES);

        const submitted = submitOutcome({
          plan: graph.plan,
          submittedPlanRevision: graph.binding.planRevision,
          identity: {
            graphId: GRAPH,
            attemptId: "work#9",
            submissionId: "submission-work#9",
          },
          proposal: { nodeId: NODE, outcomeId: "done", data: oversized },
          validators: VALIDATORS,
          artifactRoot: dir,
          ledger,
          now: NOW,
        });
        expect(submitted.kind).toBe("refused");
        if (submitted.kind !== "refused") return;
        expect(submitted.refusals.length).toBe(1);
        const refusal = submitted.refusals[0];
        expect(refusal?.code).toBe("oversized-accepted-data");
        // THE REFUSAL NAMES THE ACTUAL SIZE AND THE CEILING — and it never
        // reports a truncated payload as accepted.
        expect(refusal?.message).toContain(String(actualBytes));
        expect(refusal?.message).toContain(String(ACCEPTED_DATA_MAX_BYTES));
        expect(refusal?.path).toBe("$.data");

        // NOTHING WAS WRITTEN: no receipt, no accepted event, no result.
        expect(
          ledger.lookupReceipt({
            graphId: GRAPH,
            attemptId: "work#9",
            submissionId: "submission-work#9",
          }),
        ).toBeUndefined();
        expect(ledger.readAcceptedResult(GRAPH, "work#9")).toBeUndefined();
        expect(ledger.acceptedEvents(GRAPH)).toEqual([]);
        ledger.close();
        closed = true;

        expect(await rawCount(dir, GRAPH_STORE_TABLES.receipts)).toBe(0);
        expect(await rawCount(dir, GRAPH_STORE_TABLES.acceptedEvents)).toBe(0);
        expect(await rawCount(dir, GRAPH_STORE_TABLES.acceptedResults)).toBe(0);
      } finally {
        if (!closed) ledger.close();
      }
    });
  });

  it("refuses an over-limit accepted result in the store's own encoder", async () => {
    await withRoot("p42-presence-store-gate-", async (dir) => {
      const store = GraphStore.openFile(dir);
      try {
        // A payload of EXACTLY the ceiling in characters is already over it
        // once the envelope wraps it: the encoder measures the stored text.
        const atCeiling = "x".repeat(ACCEPTED_DATA_MAX_BYTES);
        expect(
          acceptedDataBytes({ kind: "value", value: atCeiling }),
        ).toBeGreaterThan(ACCEPTED_DATA_MAX_BYTES);

        let refused: unknown;
        try {
          store.writeAcceptedResult({
            graphId: GRAPH,
            attemptId: "work#8",
            planRevision: "rev-1",
            payload: { kind: "value", value: atCeiling },
            acceptedAt: NOW,
          });
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(GraphStoreWriteError);
        if (refused instanceof GraphStoreWriteError) {
          expect(refused.problem).toBe("oversized-accepted-data");
        }
        expect(store.readAcceptedResult(GRAPH, "work#8")).toBeUndefined();
      } finally {
        store.close();
      }
      expect(await rawCount(dir, GRAPH_STORE_TABLES.acceptedResults)).toBe(0);
    });
  });

  it("refuses a payload body that is not one of the two envelope members", async () => {
    await withRoot("p42-presence-malformed-", async (dir) => {
      const store = GraphStore.openFile(dir);
      try {
        store.writeAcceptedResult({
          graphId: GRAPH,
          attemptId: "work#7",
          planRevision: "rev-1",
          payload: { kind: "value", value: { accepted: true } },
          acceptedAt: NOW,
        });
      } finally {
        store.close();
      }

      // The bodies a PREVIOUS format (or a hand-edited file) can hold: the bare
      // payload, an envelope with the wrong member, an envelope with an extra
      // key. None of them is a value to guess at.
      const bodies = [
        "null",
        '"bare payload"',
        "{}",
        '{"kind":"value"}',
        '{"kind":"value","value":1,"extra":2}',
        '{"kind":"other","value":1}',
      ];
      for (const body of bodies) {
        const db = await createDatabase(graphStoreFilePath(dir));
        try {
          db.run(
            `UPDATE ${GRAPH_STORE_TABLES.acceptedResults} SET payload = ? WHERE attempt_id = ?`,
            body,
            "work#7",
          );
        } finally {
          db.close();
        }
        const reopened = GraphStore.openFile(dir);
        try {
          let refused: unknown;
          try {
            reopened.readAcceptedResult(GRAPH, "work#7");
          } catch (error) {
            refused = error;
          }
          expect(refused).toBeInstanceOf(GraphStoreFormatError);
          if (refused instanceof GraphStoreFormatError) {
            expect(refused.problem).toBe("malformed-row");
            expect(refused.message).toContain("accepted-data envelope");
          }
        } finally {
          reopened.close();
        }
      }

      // The legal row is still readable when its own body is restored.
      const db = await createDatabase(graphStoreFilePath(dir));
      try {
        db.run(
          `UPDATE ${GRAPH_STORE_TABLES.acceptedResults} SET payload = ? WHERE attempt_id = ?`,
          '{"kind":"value","value":{"accepted":true}}',
          "work#7",
        );
      } finally {
        db.close();
      }
      const reopened = GraphStore.openFile(dir);
      try {
        expect(reopened.readAcceptedResult(GRAPH, "work#7")?.payload).toEqual({
          kind: "value",
          value: { accepted: true },
        });
      } finally {
        reopened.close();
      }
    });
  });
});

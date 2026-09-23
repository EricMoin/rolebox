/**
 * A focused assertion shared by the ingress gate tests.
 *
 * WHY THIS EXISTS. "The refusal happened before the store was opened" used to be
 * checked by the ABSENCE of the ledger file. That is no longer a truthful check:
 * the workspace has ONE graph store now (P1 item 3), so the host capability a
 * fixture installs owns the same file the acceptance path would use — the file
 * legitimately exists before any submission is attempted. What the gate actually
 * promises is that the ingress wrote NO acceptance record, and that is what this
 * helper answers.
 *
 * TOTAL: a missing store, an unreadable one and a store with no rows for the
 * graph all answer `true`; only a store that holds a run state or an unsettled
 * effect for the graph answers `false`.
 */

import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";

/** Whether the store holds no acceptance record at all for one graph. */
export async function hasNoAcceptanceRecords(
  directory: string,
  graphId: string,
): Promise<boolean> {
  const opened = await SqliteAcceptanceLedger.openReadOnly(directory);
  if (opened.kind === "absent") return true;
  if (opened.kind !== "opened") return false;
  try {
    return (
      opened.ledger.readGraphState(graphId) === undefined &&
      opened.ledger.pendingEffects(graphId).length === 0
    );
  } finally {
    opened.ledger.close();
  }
}

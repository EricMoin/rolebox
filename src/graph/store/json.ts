/**
 * Graph store — the ONE JSON representability rule
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * Every JSON column the unified store writes (an effect payload, a run-state
 * body, an accepted result, a graph definition) is encoded HERE, so "what the
 * store can represent" is one rule rather than one rule per table. A value JSON
 * has no representation for — `undefined`, a function, a symbol, a BigInt, a
 * non-finite number, a reference cycle — throws BEFORE the row is inserted, so a
 * hostile body rolls the whole transaction back instead of storing a silently
 * truncated one.
 *
 * The rule is parameterized by `subject` (what the body belongs to, for the
 * diagnostic) and `problem` (the code the caller reports); the ledger's own
 * codes are unchanged.
 *
 * Dependency leaf: this module imports the store's error type and nothing else.
 */

import { errorText } from "../../utils/error-text.ts";
import { GraphStoreWriteError, type GraphStoreWriteProblem } from "./errors.ts";
import { GRAPH_STATE_MAX_BYTES } from "../ledger/types.ts";

/** Encode one JSON body for its TEXT column, or refuse it by name. */
export function encodeJsonBody(
  value: unknown,
  subject: string,
  problem: GraphStoreWriteProblem,
): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key: string, entry: unknown) => {
      if (
        entry === undefined ||
        typeof entry === "function" ||
        typeof entry === "symbol" ||
        typeof entry === "bigint"
      ) {
        throw new GraphStoreWriteError(
          problem,
          `acceptance-ledger: ${subject} contains ${
            entry === undefined ? "an undefined value" : `a ${typeof entry} value`
          }, which JSON cannot represent — nothing from this transaction was committed`,
        );
      }
      if (typeof entry === "number" && !Number.isFinite(entry)) {
        throw new GraphStoreWriteError(
          problem,
          `acceptance-ledger: ${subject} contains ${String(entry)}, which JSON cannot represent — nothing from this transaction was committed`,
        );
      }
      return entry;
    });
  } catch (error) {
    if (error instanceof GraphStoreWriteError) throw error;
    throw new GraphStoreWriteError(
      problem,
      `acceptance-ledger: ${subject} cannot be serialized as JSON (${errorText(error)}) — nothing from this transaction was committed`,
    );
  }
  if (typeof text !== "string") {
    throw new GraphStoreWriteError(
      problem,
      `acceptance-ledger: ${subject} has no JSON text — nothing from this transaction was committed`,
    );
  }
  return text;
}

/** Encode one effect payload for its TEXT column. */
export function encodePayload(payload: unknown, effectId: string): string {
  return encodeJsonBody(
    payload,
    `the payload of effect ${effectId}`,
    "unrepresentable-payload",
  );
}

/**
 * Encode one graph-state body for its TEXT column, enforcing the size bound.
 *
 * The byte length of the ENCODED text is what `GRAPH_STATE_MAX_BYTES` limits,
 * so the check measures exactly what would be stored; an oversized body is
 * refused before the row is written, and the caller's transaction rolls back
 * with it.
 */
export function encodeStateBody(body: unknown, graphId: string): string {
  const text = encodeJsonBody(
    body,
    `the state body of graph ${graphId}`,
    "unrepresentable-state",
  );
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > GRAPH_STATE_MAX_BYTES) {
    throw new GraphStoreWriteError(
      "oversized-state",
      `acceptance-ledger: the state body of graph ${graphId} is ${bytes} bytes, beyond the ${GRAPH_STATE_MAX_BYTES}-byte limit this ledger stores — nothing from this transaction was committed`,
    );
  }
  return text;
}

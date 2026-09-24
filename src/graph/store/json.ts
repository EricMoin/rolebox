import { errorText } from "../../utils/error-text.ts";
import { GraphStoreWriteError, type GraphStoreWriteProblem } from "./errors.ts";
import { GRAPH_STATE_MAX_BYTES } from "../ledger/types.ts";
import { ACCEPTED_DATA_MAX_BYTES } from "./records.ts";
import type { AcceptedData } from "../domain/model.ts";

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
          `acceptance-ledger: ${subject} contains ${entry === undefined ? "an undefined value" : `a ${typeof entry} value`
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

/**
 * Encode one accepted-data envelope for its TEXT column, enforcing the
 * accepted-data ceiling.
 *
 * The byte length of the ENCODED envelope is what `ACCEPTED_DATA_MAX_BYTES`
 * limits, so the check measures exactly what the row would hold — the
 * `{"kind":"absent"}` / `{"kind":"value","value":…}` wrapper included. An
 * over-limit payload is refused with its actual size and the ceiling, never
 * truncated and never accepted, and the transaction that carried it rolls back.
 */
export function encodeAcceptedData(
  payload: AcceptedData,
  attemptId: string,
): string {
  const text = encodeJsonBody(
    payload,
    `the accepted data of attempt ${attemptId}`,
    "unrepresentable-record",
  );
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > ACCEPTED_DATA_MAX_BYTES) {
    throw new GraphStoreWriteError(
      "oversized-accepted-data",
      `acceptance-ledger: the accepted data of attempt ${attemptId} is ${bytes} bytes, beyond the ${ACCEPTED_DATA_MAX_BYTES}-byte limit this store holds — nothing from this transaction was committed`,
    );
  }
  return text;
}

/**
 * The stored size of one accepted-data envelope, in UTF-8 bytes, measured by
 * the SAME encoding the row uses.
 *
 * The acceptance path uses this to refuse an over-limit payload as STRUCTURED
 * data before any transaction is opened; the encoder above remains the store's
 * own gate. `undefined` means JSON cannot represent the value at all — a
 * different problem with its own named refusal, and not this rule's to report.
 */
export function acceptedDataBytes(payload: AcceptedData): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return undefined;
  }
}

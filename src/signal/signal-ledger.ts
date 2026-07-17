import type { FnState } from "../function/runtime-state.ts";

/**
 * Signal ledger stored in FnState.kv['__signals_observed'].
 * The ledger is a `Record<string, unknown>` mapping each signal type to its
 * optional payload (or null when no payload was provided).
 *
 * @internal Use the exported helper functions to read/write the ledger.
 */
const LEDGER_KEY = "__signals_observed";

function readLedger(fnState: FnState): Record<string, unknown> {
  const existing = fnState.kv[LEDGER_KEY];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  return {};
}

function writeLedger(fnState: FnState, ledger: Record<string, unknown>): void {
  fnState.kv[LEDGER_KEY] = ledger;
}

/**
 * Record a signal in the function state ledger.
 *
 * - The signal type becomes a key in the ledger record.
 * - The payload (or null when absent) becomes the key's value.
 * - If the same signal type is recorded twice, the later call **overwrites**
 *   the previous payload.
 *
 * @param fnState  The function state to record the signal on.
 * @param type     One of the 8 defined signal types (answer, need_approval,
 *                 blocked, need_clarification, handoff, progress,
 *                 revise_needed, escalate).
 * @param payload  Optional payload to associate with the signal.
 */
export function recordSignal(fnState: FnState, type: string, payload?: unknown): void {
  const ledger = readLedger(fnState);
  ledger[type] = payload !== undefined ? payload : null;
  writeLedger(fnState, ledger);
}

/**
 * Check whether a signal of the given type has been recorded in the ledger.
 *
 * @param fnState  The function state to check.
 * @param type     The signal type to look up.
 * @returns `true` when the ledger contains an entry for `type`.
 */
export function hasSignal(fnState: FnState, type: string): boolean {
  const ledger = readLedger(fnState);
  return type in ledger;
}

/**
 * Retrieve the payload associated with a previously recorded signal.
 *
 * @param fnState  The function state to look up.
 * @param type     The signal type whose payload should be returned.
 * @returns The stored payload, or `undefined` when no signal of that type
 *          has been recorded.
 */
export function getSignalPayload(fnState: FnState, type: string): unknown | undefined {
  const ledger = readLedger(fnState);
  return ledger[type];
}

/**
 * Return the complete ledger record. Useful for serialization or debugging.
 */
export function readLedgerRecord(fnState: FnState): Record<string, unknown> {
  return { ...readLedger(fnState) };
}

/**
 * Remove a signal entry from the ledger.
 *
 * @param fnState  The function state to modify.
 * @param type     The signal type to remove.
 */
export function clearSignal(fnState: FnState, type: string): void {
  const ledger = readLedger(fnState);
  delete ledger[type];
  writeLedger(fnState, ledger);
}

/**
 * Remove all signal entries from the ledger.
 *
 * @param fnState  The function state to clear.
 */
export function clearAllSignals(fnState: FnState): void {
  fnState.kv[LEDGER_KEY] = {};
}

import { errorText } from "../../utils/error-text.ts";
import type { OutcomeRuntimeRefusal } from "./runtime-contract.ts";

export function readRuntimeClock(
  clock: () => number,
  override: number | undefined,
): number | OutcomeRuntimeRefusal {
  const at = override ?? clock();
  if (!Number.isSafeInteger(at)) {
    return {
      code: "invalid-timestamp",
      path: "$.now",
      message:
        "outcome-runtime: now is " +
        describeValue(at) +
        ", not epoch milliseconds — time is an explicit input and the receipt records " +
        "exactly the value this call was given",
    };
  }
  return at;
}

export function ledgerReadRefusal(graphId: string, error: unknown): OutcomeRuntimeRefusal {
  return {
    code: "unreadable-state",
    message:
      "outcome-runtime: the graph state of " +
      JSON.stringify(graphId) +
      " could not be read from the ledger (" +
      errorText(error) +
      ")",
  };
}

export function refused(refusals: readonly OutcomeRuntimeRefusal[]): {
  readonly kind: "refused";
  readonly refusals: readonly OutcomeRuntimeRefusal[];
} {
  return { kind: "refused", refusals };
}

export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

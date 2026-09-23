import { describe, it, expect } from "bun:test";
import { SIGNAL_KEY, asRecord, getSignal } from "../../src/graph/tools/signal-payload.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A node-shaped holder for the ledger under test (the parameter is structural). */
function node(
  signalsObserved: Record<string, unknown>,
): { signalsObserved: Record<string, unknown> } {
  return { signalsObserved };
}

/**
 * A node whose persisted ledger is malformed. Persisted state has no
 * compile-time link to the runtime type, so this shape is reachable from a
 * corrupt file; JSON.parse keeps the fixture assertion-free.
 */
function corruptLedgerNode(
  jsonFragment: string,
): { signalsObserved: Record<string, unknown> } {
  return JSON.parse(`{"signalsObserved":${jsonFragment}}`);
}

const isString = (v: unknown): v is string => typeof v === "string";
const isRecord = (v: unknown): v is Record<string, unknown> =>
  asRecord(v) !== undefined;

/** A caller-owned predicate: getSignal must not bring an interpretation of its own. */
const hasFindings = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && Array.isArray(v["findings"]) && v["findings"].length > 0;

// ── asRecord ────────────────────────────────────────────────────────────────

describe("asRecord", () => {
  it("returns the same object for a plain record", () => {
    const value = { verdict: "veto" };
    expect(asRecord(value)).toBe(value);
  });

  it("accepts class instances and null-prototype objects", () => {
    class Sample {
      field = 1;
    }
    const instance = new Sample();
    const fromInstance: unknown = asRecord(instance);
    expect(fromInstance).toBe(instance);

    const bare: unknown = Object.create(null);
    const fromBare: unknown = asRecord(bare);
    expect(fromBare).toBe(bare);
  });

  it("rejects arrays, null and primitives", () => {
    const values: unknown[] = [
      [],
      ["unresolved"],
      null,
      undefined,
      "text",
      42,
      0,
      false,
      true,
      Symbol("s"),
      10n,
    ];
    for (const value of values) {
      expect(asRecord(value)).toBeUndefined();
    }
  });

  it("rejects functions even when they carry properties", () => {
    const fn = Object.assign(() => {}, { then: () => {} });
    expect(asRecord(fn)).toBeUndefined();
  });
});

// ── SIGNAL_KEY ──────────────────────────────────────────────────────────────

describe("SIGNAL_KEY", () => {
  it("is the exact ledger vocabulary", () => {
    expect(SIGNAL_KEY).toEqual({
      answer: "answer",
      escalate: "escalate",
      reviseNeeded: "revise_needed",
      partialApprove: "partial_approve",
      progress: "progress",
    });
  });

  it("keeps literal value types", () => {
    const literal: "revise_needed" = SIGNAL_KEY.reviseNeeded;
    expect(literal).toBe("revise_needed");
  });
});

// ── getSignal ───────────────────────────────────────────────────────────────

describe("getSignal", () => {
  it("returns the stored payload when the guard accepts it", () => {
    const payload = { verdict: "revise" };
    const ledger = node({ revise_needed: payload });
    expect(getSignal(ledger, SIGNAL_KEY.reviseNeeded, isRecord)).toBe(payload);
  });

  it("answers undefined for a missing key", () => {
    expect(getSignal(node({}), SIGNAL_KEY.answer, isRecord)).toBeUndefined();
  });

  it("runs the guard instead of trusting the stored value", () => {
    expect(getSignal(node({ answer: 42 }), SIGNAL_KEY.answer, isString)).toBeUndefined();
    expect(getSignal(node({ answer: "ok" }), SIGNAL_KEY.answer, isString)).toBe("ok");
    expect(getSignal(node({ answer: null }), SIGNAL_KEY.answer, isRecord)).toBeUndefined();
  });

  it("accepts a caller-supplied predicate as the guard", () => {
    const ledger = node({ revise_needed: { findings: ["line 3"] } });
    const value = getSignal(ledger, SIGNAL_KEY.reviseNeeded, hasFindings);
    if (value === undefined) throw new Error("expected a payload with findings");
    expect(value["findings"]).toEqual(["line 3"]);
  });

  it("reads a non-signal stash key such as partial_approve", () => {
    expect(
      getSignal(node({ partial_approve: { approved: 1 } }), SIGNAL_KEY.partialApprove, isRecord),
    ).toEqual({ approved: 1 });
  });

  it("answers undefined for a corrupt ledger instead of throwing", () => {
    expect(getSignal(corruptLedgerNode("null"), SIGNAL_KEY.answer, isRecord)).toBeUndefined();
    expect(getSignal(corruptLedgerNode("[]"), SIGNAL_KEY.answer, isRecord)).toBeUndefined();
    expect(
      getSignal(corruptLedgerNode('"not-a-ledger"'), SIGNAL_KEY.answer, isRecord),
    ).toBeUndefined();
    expect(getSignal(corruptLedgerNode("42"), SIGNAL_KEY.answer, isRecord)).toBeUndefined();
  });

  it("looks the key up exactly, without case normalization", () => {
    expect(getSignal(node({ answer: "ok" }), "Answer", isString)).toBeUndefined();
    expect(getSignal(node({ answer: "ok" }), "answer", isString)).toBe("ok");
  });

  it("returns a stored marker object the guard accepts, interpreting nothing", () => {
    const marker = { __inferred: true };
    const value = getSignal(node({ answer: marker }), SIGNAL_KEY.answer, isRecord);
    expect(value).toBe(marker);
  });
});

import { describe, it, expect } from "bun:test";
import {
  SIGNAL_KEY,
  asRecord,
  extractReason,
  getSignal,
  hasUnresolvedPayload,
  isInferred,
  revisionText,
} from "../../src/graph/tools/signal-payload.ts";

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

// ── isInferred ──────────────────────────────────────────────────────────────

describe("isInferred", () => {
  it("accepts only the exact boolean marker", () => {
    expect(isInferred({ __inferred: true })).toBe(true);
    expect(isInferred({ __inferred: false })).toBe(false);
    expect(isInferred({ __inferred: 1 })).toBe(false);
    expect(isInferred({ __inferred: "true" })).toBe(false);
    expect(isInferred({})).toBe(false);
  });

  it("returns a real boolean for every payload it rejects", () => {
    // Regression against the expression this replaces, which answered the
    // falsy payload itself (e.g. "" or 0) instead of false.
    const values: unknown[] = [null, undefined, "", 0, false, "answer", 7];
    for (const value of values) {
      expect(isInferred(value)).toBe(false);
    }
  });

  it("does not accept the marker carried by an array", () => {
    const marked: unknown = Object.assign([], { __inferred: true });
    expect(isInferred(marked)).toBe(false);
  });
});

// ── hasUnresolvedPayload ────────────────────────────────────────────────────

describe("hasUnresolvedPayload", () => {
  it("detects non-empty unresolved / items / findings arrays", () => {
    expect(hasUnresolvedPayload({ unresolved: ["a"] })).toBe(true);
    expect(hasUnresolvedPayload({ items: [1, 2] })).toBe(true);
    expect(hasUnresolvedPayload({ findings: ["x"] })).toBe(true);
    expect(hasUnresolvedPayload({ unresolved: [], findings: ["x"] })).toBe(true);
  });

  it("ignores empty or non-array markers", () => {
    expect(hasUnresolvedPayload({ unresolved: [] })).toBe(false);
    expect(hasUnresolvedPayload({ items: [] })).toBe(false);
    expect(hasUnresolvedPayload({ findings: "fix it" })).toBe(false);
    expect(hasUnresolvedPayload({ unresolved: null })).toBe(false);
  });

  it("detects the veto / revise verdicts, case-sensitively", () => {
    expect(hasUnresolvedPayload({ verdict: "veto" })).toBe(true);
    expect(hasUnresolvedPayload({ verdict: "revise" })).toBe(true);
    expect(hasUnresolvedPayload({ verdict: "approve" })).toBe(false);
    expect(hasUnresolvedPayload({ verdict: "VETO" })).toBe(false);
    expect(hasUnresolvedPayload({ verdict: 1 })).toBe(false);
  });

  it("treats the synthetic-answer marker as resolved", () => {
    expect(hasUnresolvedPayload({ __inferred: true })).toBe(false);
  });

  it("rejects non-record payloads", () => {
    const values: unknown[] = [
      null,
      undefined,
      "unresolved",
      0,
      false,
      ["unresolved"],
      [],
    ];
    for (const value of values) {
      expect(hasUnresolvedPayload(value)).toBe(false);
    }
  });

  it("narrows the payload to a record the caller can index", () => {
    const payload: unknown = { verdict: "revise", findings: ["line 3"] };
    if (!hasUnresolvedPayload(payload)) {
      throw new Error("expected an unresolved payload");
    }
    // Compiles only because the predicate narrowed unknown to a record.
    const verdict: unknown = payload["verdict"];
    expect(verdict).toBe("revise");
  });
});

// ── extractReason ───────────────────────────────────────────────────────────

describe("extractReason", () => {
  it("returns a non-empty string payload verbatim", () => {
    expect(extractReason("boom")).toBe("boom");
  });

  it("answers undefined for an empty string payload", () => {
    expect(extractReason("")).toBeUndefined();
    expect(extractReason("") ?? "escalated").toBe("escalated");
  });

  it("reads reason, then error, then message", () => {
    expect(extractReason({ reason: "r" })).toBe("r");
    expect(extractReason({ error: "e" })).toBe("e");
    expect(extractReason({ message: "m" })).toBe("m");
    expect(extractReason({ reason: "r", error: "e", message: "m" })).toBe("r");
    expect(extractReason({ error: "e", message: "m" })).toBe("e");
    expect(extractReason({ message: "m", reason: 5 })).toBe("m");
  });

  it("keeps an empty reason, which the ?? default must not override", () => {
    expect(extractReason({ reason: "" })).toBe("");
    expect(extractReason({ reason: "" }) ?? "escalated").toBe("");
  });

  it("answers undefined when nothing is extractable", () => {
    const values: unknown[] = [
      null,
      undefined,
      42,
      true,
      [],
      ["reason"],
      {},
      { reason: 42 },
      { __inferred: true },
    ];
    for (const value of values) {
      expect(extractReason(value)).toBeUndefined();
    }
  });

  it("represents the call-site migration to the escalated default", () => {
    const values: unknown[] = [null, undefined, 42, {}, [], "", { __inferred: true }];
    for (const value of values) {
      expect(extractReason(value) ?? "escalated").toBe("escalated");
    }
  });
});

// ── revisionText ────────────────────────────────────────────────────────────

describe("revisionText", () => {
  it("uses a string payload verbatim", () => {
    expect(revisionText("redo the join")).toBe("redo the join");
    expect(revisionText("")).toBe("");
  });

  it("reads the first string-valued feedback key", () => {
    expect(revisionText({ findings: "fix the join" })).toBe("fix the join");
    expect(revisionText({ verdict: "veto" })).toBe("veto");
    expect(revisionText({ reason: "r" })).toBe("r");
    expect(revisionText({ feedback: "fb" })).toBe("fb");
    expect(revisionText({ review: "rv" })).toBe("rv");
  });

  it("prefers findings over the later keys", () => {
    expect(revisionText({ findings: "f", verdict: "v", reason: "r" })).toBe("f");
    expect(revisionText({ verdict: "v", reason: "r" })).toBe("v");
  });

  it("renders an all-string array as a bullet list", () => {
    expect(revisionText({ findings: ["a", "b"] })).toBe("- a\n- b");
    expect(revisionText({ findings: ["only"] })).toBe("- only");
    expect(revisionText({ findings: [] })).toBe("");
  });

  it("skips a mixed array and falls through to the JSON text", () => {
    expect(revisionText({ findings: ["a", 1] })).toBe('{"findings":["a",1]}');
  });

  it("falls back to JSON for records without feedback keys", () => {
    expect(revisionText({})).toBe("{}");
    expect(revisionText({ other: 1 })).toBe('{"other":1}');
    expect(revisionText({ __inferred: true })).toBe('{"__inferred":true}');
  });

  it("JSON-serializes non-record objects, arrays included", () => {
    expect(revisionText([1, 2])).toBe("[1,2]");
    expect(revisionText({ when: new Date(0) })).toBe(
      '{"when":"1970-01-01T00:00:00.000Z"}',
    );
  });

  it("answers undefined for payloads with no text", () => {
    const values: unknown[] = [null, undefined, 42, 0, false, true];
    for (const value of values) {
      expect(revisionText(value)).toBeUndefined();
    }
  });

  it("keeps the falsy-means-no-feedback convention", () => {
    const values: unknown[] = [null, 42, "", { findings: [] }, { findings: "" }];
    for (const value of values) {
      expect(revisionText(value)).toBeFalsy();
    }
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

  it("accepts a predicate from this module as the guard", () => {
    const ledger = node({ revise_needed: { findings: ["line 3"] } });
    const value = getSignal(ledger, SIGNAL_KEY.reviseNeeded, hasUnresolvedPayload);
    if (value === undefined) throw new Error("expected an unresolved payload");
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

  it("does not treat an inferred answer as absent", () => {
    const marker = { __inferred: true };
    const value = getSignal(node({ answer: marker }), SIGNAL_KEY.answer, isRecord);
    expect(value).toBe(marker);
    expect(isInferred(value)).toBe(true);
  });
});

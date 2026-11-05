/**
 * Runtime-boundary tests for extension-provided recovery patterns.
 *
 * Extension modules are untrusted JavaScript, so the bridge into the recovery
 * engine must validate categories and wrap match results instead of asserting
 * them. These tests drive the public guards and the adapter directly.
 */
import { describe, expect, it } from "vitest";

import { subscribeLogRecords } from "../../src/log/index.ts";
import type { LogRecord } from "../../src/log/types.ts";
import { adaptExtensionPattern } from "../../src/recovery/extension-pattern.ts";
import type { RecoveryError } from "../../src/recovery/types.ts";
import {
  RECOVERY_ERROR_CATEGORIES,
  isRecoveryError,
  isRecoveryErrorCategory,
} from "../../src/recovery/validation.ts";

const VALID_ERROR: RecoveryError = {
  category: "session_error",
  errorType: "test_type",
  message: "something went wrong",
  timestamp: 1_700_000_000_000,
};

/** A structurally valid module export, plus whatever the test overrides. */
function patternModule(overrides: { category?: unknown; match?: unknown } = {}) {
  return {
    name: "module-declared-name",
    category: "session_error",
    match: () => VALID_ERROR,
    ...overrides,
  };
}

describe("RECOVERY_ERROR_CATEGORIES", () => {
  it("is the closed set of seven recoverable categories", () => {
    expect(RECOVERY_ERROR_CATEGORIES).toHaveLength(7);
    expect(new Set(RECOVERY_ERROR_CATEGORIES).size).toBe(7);
  });

  it("accepts every declared category", () => {
    for (const category of RECOVERY_ERROR_CATEGORIES) {
      expect(isRecoveryErrorCategory(category)).toBe(true);
    }
  });

  it("rejects values that are not declared categories", () => {
    for (const value of ["custom", "", null, 42, undefined, {}, []]) {
      expect(isRecoveryErrorCategory(value)).toBe(false);
    }
  });
});

describe("isRecoveryError", () => {
  it("accepts a structurally valid RecoveryError", () => {
    expect(isRecoveryError(VALID_ERROR)).toBe(true);
  });

  it("ignores the optional raw payload", () => {
    expect(isRecoveryError({ ...VALID_ERROR, raw: { anything: true } })).toBe(true);
  });

  it("rejects missing or wrong required fields", () => {
    const missing = (key: keyof RecoveryError): unknown => {
      const copy: Record<string, unknown> = { ...VALID_ERROR };
      delete copy[key];
      return copy;
    };

    const invalid: unknown[] = [
      null,
      undefined,
      "not-an-error",
      42,
      true,
      { ...VALID_ERROR, category: "custom" },
      missing("category"),
      { ...VALID_ERROR, errorType: 42 },
      missing("errorType"),
      { ...VALID_ERROR, message: null },
      missing("message"),
      { ...VALID_ERROR, timestamp: "1" },
      missing("timestamp"),
    ];

    for (const value of invalid) {
      expect(isRecoveryError(value)).toBe(false);
    }
  });
});

describe("adaptExtensionPattern", () => {
  it("returns null for an unknown category", () => {
    expect(adaptExtensionPattern("custom-category", patternModule({ category: "custom" }))).toBeNull();
    expect(adaptExtensionPattern("empty-category", patternModule({ category: "" }))).toBeNull();
    expect(adaptExtensionPattern("numeric-category", patternModule({ category: 42 }))).toBeNull();
  });

  it("returns null when match is not a function", () => {
    expect(adaptExtensionPattern("no-match", patternModule({ match: undefined }))).toBeNull();
    expect(adaptExtensionPattern("string-match", patternModule({ match: "not callable" }))).toBeNull();
    expect(adaptExtensionPattern("object-match", patternModule({ match: {} }))).toBeNull();
  });

  it("registers under the extension entry name and returns a valid RecoveryError", () => {
    const pattern = adaptExtensionPattern("registry-entry-name", patternModule());
    expect(pattern).not.toBeNull();
    if (!pattern) return;

    expect(pattern.name).toBe("registry-entry-name");
    expect(pattern.name).not.toBe("module-declared-name");
    expect(pattern.category).toBe("session_error");
    expect(pattern.match("anything")).toEqual(VALID_ERROR);
  });

  it("forwards the raw error value to the module matcher", () => {
    const seen: unknown[] = [];
    const pattern = adaptExtensionPattern(
      "forwarding",
      patternModule({
        match: (error: unknown) => {
          seen.push(error);
          return VALID_ERROR;
        },
      }),
    );

    expect(pattern?.match("raw-error-value")).toEqual(VALID_ERROR);
    expect(seen).toEqual(["raw-error-value"]);
  });

  it("treats null and undefined match results as no match", () => {
    for (const result of [null, undefined]) {
      const pattern = adaptExtensionPattern("empty-result", patternModule({ match: () => result }));
      expect(pattern?.match("anything")).toBeNull();
    }
  });

  it("treats malformed match results as no match", () => {
    const malformed: unknown[] = [
      { category: "session_error", errorType: "test_type", message: "missing timestamp" },
      "not-an-error",
      true,
      42,
      [],
    ];

    for (const result of malformed) {
      const pattern = adaptExtensionPattern("malformed-result", patternModule({ match: () => result }));
      expect(pattern?.match("anything")).toBeNull();
    }
  });

  it("warns once per adapted pattern about an invalid match result", () => {
    const records: LogRecord[] = [];
    const unsubscribe = subscribeLogRecords((record) => {
      if (record.channel === "recovery:extension-pattern" && record.level === "warn") {
        records.push(record);
      }
    });

    try {
      const pattern = adaptExtensionPattern("warns-once", patternModule({ match: () => true }));
      expect(pattern?.match("first")).toBeNull();
      expect(pattern?.match("second")).toBeNull();
      expect(pattern?.match("third")).toBeNull();
    } finally {
      unsubscribe();
    }

    const invalidWarning = records.filter((record) =>
      record.message.includes("invalid RecoveryError"),
    );
    expect(invalidWarning).toHaveLength(1);
    expect(invalidWarning[0]?.fields.name).toBe("warns-once");
    expect(invalidWarning[0]?.fields.category).toBe("session_error");
  });
});

import { describe, it, expect } from "bun:test";
import * as types from "../../src/dispatch/types.ts";

/**
 * Smoke test for dispatch type modules.
 *
 * All exports from types.ts are TypeScript-only constructs
 * (type aliases and interfaces) that are erased at runtime.
 * The import itself verifies the module resolves and compiles
 * correctly — that is the primary value of this test.
 */

describe("dispatch types", () => {
  it("module exports exist as expected", () => {
    // At runtime, type-only exports are erased, so the module
    // namespace is empty.  The test passes because the import
    // succeeds — confirming the module path and TS compilation
    // are correct.
    expect(typeof types).toBe("object");
  });
});

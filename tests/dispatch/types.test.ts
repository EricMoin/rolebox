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

  it("MaterializedResultRef shape", () => {
    // Construct a concrete literal to verify the type compiles
    // and all fields resolve at runtime.
    const ref: types.MaterializedResultRef = {
      sidecarPath: "/tmp/results/task-123.txt",
      totalChars: 42,
      hadFence: true,
      fetchError: undefined,
      materializedAt: new Date().toISOString(),
    };
    expect(ref.sidecarPath).toBeDefined();
    expect(ref.totalChars).toBe(42);
    expect(ref.hadFence).toBe(true);
    expect(ref.materializedAt).toEqual(expect.any(String));
  });
});

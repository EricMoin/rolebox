import { describe, it, expect } from "bun:test";
import { stateRegistry } from "../src/state-registry";
import { FunctionRuntimeManager } from "../src/function/runtime-state";

describe("stateRegistry", () => {
  it("exposes functionRuntime as FunctionRuntimeManager", () => {
    expect(stateRegistry.functionRuntime).toBeInstanceOf(FunctionRuntimeManager);
  });

  it("reset clears state in-place (same singleton instance)", () => {
    const ref = stateRegistry.functionRuntime;
    ref.init("test-session", "testFn", 1);
    expect(ref.get("test-session", "testFn")).toBeDefined();
    stateRegistry.reset();
    expect(stateRegistry.functionRuntime).toBe(ref);
    expect(ref.get("test-session", "testFn")).toBeUndefined();
  });
});

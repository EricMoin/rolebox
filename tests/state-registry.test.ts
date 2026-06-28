import { describe, it, expect } from "bun:test";
import { stateRegistry } from "../src/state-registry";
import { FunctionRuntimeManager } from "../src/function/runtime-state";

describe("stateRegistry", () => {
  it("exposes functionRuntime as FunctionRuntimeManager", () => {
    expect(stateRegistry.functionRuntime).toBeInstanceOf(FunctionRuntimeManager);
  });

  it("reset creates a fresh FunctionRuntimeManager", () => {
    const old = stateRegistry.functionRuntime;
    stateRegistry.reset();
    expect(stateRegistry.functionRuntime).toBeInstanceOf(FunctionRuntimeManager);
    expect(stateRegistry.functionRuntime).not.toBe(old);
  });
});

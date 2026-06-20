import { describe, it, expect } from "bun:test";
import { FunctionSessionState } from "./session-state";

describe("FunctionSessionState", () => {
  it("activates and retrieves functions for a session", () => {
    const state = new FunctionSessionState();
    state.activate("ses1", ["plan"]);
    const active = state.getActive("ses1");
    expect(active.size).toBe(1);
    expect(active.has("plan")).toBe(true);
  });

  it("is idempotent — activating same function twice keeps size 1", () => {
    const state = new FunctionSessionState();
    state.activate("ses1", ["plan"]);
    state.activate("ses1", ["plan"]);
    expect(state.getActive("ses1").size).toBe(1);
  });

  it("accumulates multiple functions across activations", () => {
    const state = new FunctionSessionState();
    state.activate("ses1", ["plan"]);
    state.activate("ses1", ["review"]);
    const active = state.getActive("ses1");
    expect(active.size).toBe(2);
    expect(active.has("plan")).toBe(true);
    expect(active.has("review")).toBe(true);
  });

  it("returns empty set for unknown session (no throw)", () => {
    const state = new FunctionSessionState();
    const active = state.getActive("nonexistent");
    expect(active).toBeInstanceOf(Set);
    expect(active.size).toBe(0);
  });

  it("isolates sessions from each other", () => {
    const state = new FunctionSessionState();
    state.activate("ses1", ["plan"]);
    state.activate("ses2", ["review"]);
    expect(state.getActive("ses1").has("plan")).toBe(true);
    expect(state.getActive("ses1").has("review")).toBe(false);
    expect(state.getActive("ses2").has("review")).toBe(true);
    expect(state.getActive("ses2").has("plan")).toBe(false);
  });

  it("clear removes all functions for a session", () => {
    const state = new FunctionSessionState();
    state.activate("ses1", ["plan", "review"]);
    expect(state.getActive("ses1").size).toBe(2);
    state.clear("ses1");
    expect(state.getActive("ses1").size).toBe(0);
  });

  it("clear is no-op for unknown session", () => {
    const state = new FunctionSessionState();
    expect(() => state.clear("unknown")).not.toThrow();
  });

  it("isActive returns correct boolean", () => {
    const state = new FunctionSessionState();
    state.activate("ses1", ["plan"]);
    expect(state.isActive("ses1", "plan")).toBe(true);
    expect(state.isActive("ses1", "review")).toBe(false);
    expect(state.isActive("unknown", "plan")).toBe(false);
  });
});

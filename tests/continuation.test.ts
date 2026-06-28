import { describe, it, expect } from "bun:test";
import { decideContinuation } from "../src/function/continuation.ts";
import type { SafetyConfig } from "../src/function/continuation.ts";
import type { FnState } from "../src/function/runtime-state.ts";

function mockState(overrides: Partial<FnState> = {}): FnState {
  return {
    phase: "active",
    activatedAtTurn: 0,
    currentTurn: 10,
    evidenceObserved: {},
    toolsObserved: [],
    continuationCount: 0,
    cooldownUntilTurn: 0,
    gateSatisfied: false,
    kv: {},
    schemaVersion: 1,
    ...overrides,
  };
}

function defaultConfig(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    globalMaxTurns: 25,
    perFnMax: 5,
    ...overrides,
  };
}

describe("decideContinuation", () => {
  it("calls 1-5 with perFnMax 5 → shouldContinue true", () => {
    const st = mockState({ currentTurn: 0 });
    const cfg = defaultConfig({ perFnMax: 5 });

    for (let i = 1; i <= 5; i++) {
      st.currentTurn += 1;
      const result = decideContinuation({
        fnName: "test-fn",
        st,
        reason: "testing",
        cfg,
        totalContinuationsThisBurst: i - 1,
      });
      expect(result.shouldContinue).toBe(true);
      expect(result.reminder).toBeDefined();
    }
  });

  it("call 6 with perFnMax 5 → shouldContinue false, reason 'per-fn cap'", () => {
    const st = mockState({ continuationCount: 5 });
    const cfg = defaultConfig({ perFnMax: 5 });

    const result = decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 5,
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe("per-fn cap");
  });

  it("after 3rd continuation, cooldownUntilTurn = currentTurn + 1", () => {
    const st = mockState({ currentTurn: 10 });
    const cfg = defaultConfig({ perFnMax: 5 });

    // First continuation
    decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 0,
    });
    // Second continuation
    decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 1,
    });
    // Third continuation — triggers cooldown
    decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 2,
    });

    expect(st.continuationCount).toBe(3);
    expect(st.cooldownUntilTurn).toBe(11); // currentTurn (10) + 1
  });

  it("totalContinuationsThisBurst >= globalMaxTurns → false regardless", () => {
    const st = mockState();
    const cfg = defaultConfig({ globalMaxTurns: 25, perFnMax: 5 });

    const result = decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 25,
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe("global cap");
  });

  it("modelAskedQuestion=true → false", () => {
    const st = mockState();
    const cfg = defaultConfig();

    const result = decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 0,
      modelAskedQuestion: true,
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe("model asked a question");
  });

  it("lastTwoOutputsIdentical=true → false", () => {
    const st = mockState();
    const cfg = defaultConfig();

    const result = decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 0,
      lastTwoOutputsIdentical: true,
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe("loop detected");
  });

  it("currentTurn < cooldownUntilTurn → false", () => {
    const st = mockState({
      currentTurn: 5,
      cooldownUntilTurn: 10,
    });
    const cfg = defaultConfig();

    const result = decideContinuation({
      fnName: "test-fn",
      st,
      reason: "testing",
      cfg,
      totalContinuationsThisBurst: 0,
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe("cooldown");
  });

  it("reminder text contains counter and perFnMax", () => {
    const st = mockState();
    const cfg = defaultConfig({ perFnMax: 5 });

    const result = decideContinuation({
      fnName: "my-fn",
      st,
      reason: "still working",
      cfg,
      totalContinuationsThisBurst: 0,
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.reminder).toBeDefined();
    expect(result.reminder!).toContain("auto-continue");
    expect(result.reminder!).toContain("1/5");
    expect(result.reminder!).toContain("my-fn");
    expect(result.reminder!).toContain("still working");
  });
});

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../src/function/artifact-store.ts";
import { evaluateGateAndTransitions } from "../src/function/phase-machine.ts";
import type { ResolvedFunction } from "../src/types.ts";
import type { FnState } from "../src/function/runtime-state.ts";
import type { CondEnv } from "../src/function/conditions.ts";

function mockFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "test-fn",
    description: "test",
    content: "test content",
    filePath: "/fake/test-fn.md",
    source: "global" as ResolvedFunction["source"],
    ...overrides,
  };
}

function mockState(overrides: Partial<FnState> = {}): FnState {
  return {
    phase: "active",
    activatedAtTurn: 0,
    currentTurn: 0,
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

function mockEnv(overrides: Partial<CondEnv> = {}): CondEnv {
  const base: CondEnv = {
    sessionID: "test-session",
    fnName: "test-fn",
    state: mockState(),
    artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "phase-test-"))),
    requiredEvidence: [],
    userMessagedThisTurn: false,
  };
  return { ...base, ...overrides };
}

describe("evaluateGateAndTransitions", () => {
  it("fn with no gate → gateSatisfied stays false, no transitions", () => {
    const env = mockEnv();
    const fn = mockFn();
    expect(env.state.gateSatisfied).toBe(false);
    expect(env.state.phase).toBe("active");

    const result = evaluateGateAndTransitions(fn, env);
    expect(env.state.gateSatisfied).toBe(false);
    expect(env.state.phase).toBe("active");
    expect(result.activate).toEqual([]);
    expect(result.deactivate).toEqual([]);
  });

  it("fn with gate unmet → phase 'gated', gateSatisfied false", () => {
    const env = mockEnv();
    const fn = mockFn({ gate: "user_approval" });
    expect(env.state.gateSatisfied).toBe(false);

    const result = evaluateGateAndTransitions(fn, env);
    expect(env.state.gateSatisfied).toBe(false);
    expect(env.state.phase).toBe("gated");
    expect(result.activate).toEqual([]);
    expect(result.deactivate).toEqual([]);
  });

  it("fn with gate met (user_approval + artifact exists) → gateSatisfied true, phase 'active'", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("test-session", "plan", "content");
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: true });
      const fn = mockFn({
        gate: { all: ["user_approval", "artifact_exists(plan)"] },
      });
      expect(env.state.gateSatisfied).toBe(false);

      const result = evaluateGateAndTransitions(fn, env);
      expect(env.state.gateSatisfied).toBe(true);
      expect(env.state.phase).toBe("active");
      expect(result.activate).toEqual([]);
      expect(result.deactivate).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transitions when gate met → returns correct TransitionResult", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("test-session", "plan", "content");
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: true });
      const fn = mockFn({
        gate: { all: ["user_approval", "artifact_exists(plan)"] },
        transitions: [
          { when: "gate", activate: ["execute"], deactivate: ["plan"] },
        ],
      });

      const result = evaluateGateAndTransitions(fn, env);
      expect(env.state.gateSatisfied).toBe(true);
      expect(env.state.phase).toBe("active");
      expect(result.activate).toEqual(["execute"]);
      expect(result.deactivate).toEqual(["plan"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transitions with direct condition (not 'gate') → fires when condition met", () => {
    const env = mockEnv({ userMessagedThisTurn: true });
    const fn = mockFn({
      transitions: [
        { when: "user_approval", activate: ["review"], deactivate: [] },
      ],
    });

    const result = evaluateGateAndTransitions(fn, env);
    expect(result.activate).toEqual(["review"]);
    expect(result.deactivate).toEqual([]);
  });

  it("transitions with direct condition unmet → does not fire", () => {
    const env = mockEnv({ userMessagedThisTurn: false });
    const fn = mockFn({
      transitions: [
        { when: "user_approval", activate: ["review"], deactivate: [] },
      ],
    });

    const result = evaluateGateAndTransitions(fn, env);
    expect(result.activate).toEqual([]);
    expect(result.deactivate).toEqual([]);
  });

  it("multiple transitions → all that fire are collected", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("test-session", "plan", "content");
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: true });
      const fn = mockFn({
        gate: { all: ["user_approval", "artifact_exists(plan)"] },
        transitions: [
          { when: "gate", activate: ["execute"], deactivate: [] },
          { when: "user_approval", activate: ["notify"], deactivate: ["draft"] },
        ],
      });

      const result = evaluateGateAndTransitions(fn, env);
      expect(result.activate).toEqual(["execute", "notify"]);
      expect(result.deactivate).toEqual(["draft"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

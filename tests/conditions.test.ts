import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../src/function/artifact-store.ts";
import { evaluateCondition, KNOWN_CONDITIONS } from "../src/function/conditions.ts";
import type { CondEnv } from "../src/function/conditions.ts";
import type { FnState } from "../src/function/runtime-state.ts";

function mockEnv(overrides: Partial<CondEnv> = {}): CondEnv {
  const base: CondEnv = {
    sessionID: "test-session",
    fnName: "test-fn",
    state: {
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
    } satisfies FnState,
    artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "cond-test-"))),
    requiredEvidence: [],
    userMessagedThisTurn: false,
  };
  return { ...base, ...overrides };
}

describe("evaluateCondition", () => {
  it("user_approval → false when userMessagedThisTurn=false", () => {
    const env = mockEnv({ userMessagedThisTurn: false });
    expect(evaluateCondition("user_approval", env)).toBe(false);
  });

  it("user_approval → true when userMessagedThisTurn=true", () => {
    const env = mockEnv({ userMessagedThisTurn: true });
    expect(evaluateCondition("user_approval", env)).toBe(true);
  });

  it("artifact_exists(plan) → false when no artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "cond-test-"));
    try {
      const store = new ArtifactStore(dir);
      const env = mockEnv({ artifacts: store });
      expect(evaluateCondition("artifact_exists(plan)", env)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("artifact_exists(plan) → true after store.write", () => {
    const dir = mkdtempSync(join(tmpdir(), "cond-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("test-session", "plan", "content");
      const env = mockEnv({ artifacts: store });
      expect(evaluateCondition("artifact_exists(plan)", env)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan_todos_complete → false when kv.__todos has unchecked boxes", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        kv: { __todos: "- [ ] todo 1\n- [x] todo 2\n- [ ] todo 3" },
      },
    });
    expect(evaluateCondition("plan_todos_complete", env)).toBe(false);
  });

  it("plan_todos_complete → true when kv.__todos has no unchecked boxes", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        kv: { __todos: "- [x] all done" },
      },
    });
    expect(evaluateCondition("plan_todos_complete", env)).toBe(true);
  });

  it("plan_todos_complete → true when kv.__todos is empty string", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        kv: { __todos: "" },
      },
    });
    expect(evaluateCondition("plan_todos_complete", env)).toBe(true);
  });

  it("turn_count(3) → true when currentTurn-activatedAtTurn >= 3", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        activatedAtTurn: 0,
        currentTurn: 3,
      },
    });
    expect(evaluateCondition("turn_count(3)", env)).toBe(true);
  });

  it("turn_count(3) → false when currentTurn-activatedAtTurn < 3", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        activatedAtTurn: 0,
        currentTurn: 2,
      },
    });
    expect(evaluateCondition("turn_count(3)", env)).toBe(false);
  });

  it("state_eq(x=1) → true when kv.x === \"1\"", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        kv: { x: 1 },
      },
    });
    expect(evaluateCondition("state_eq(x=1)", env)).toBe(true);
  });

  it("state_eq(x=1) → false when kv.x is different", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        kv: { x: 2 },
      },
    });
    expect(evaluateCondition("state_eq(x=1)", env)).toBe(false);
  });

  it("{ all: [user_approval, artifact_exists(plan)] } → true when both true", () => {
    const dir = mkdtempSync(join(tmpdir(), "cond-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("test-session", "plan", "content");
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: true });
      expect(evaluateCondition({ all: ["user_approval", "artifact_exists(plan)"] }, env)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("{ all: [user_approval, artifact_exists(plan)] } → false when one is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cond-test-"));
    try {
      const store = new ArtifactStore(dir);
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: true });
      expect(evaluateCondition({ all: ["user_approval", "artifact_exists(plan)"] }, env)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("{ any: [user_approval, artifact_exists(plan)] } → true when at least one is true", () => {
    const dir = mkdtempSync(join(tmpdir(), "cond-test-"));
    try {
      const store = new ArtifactStore(dir);
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: true });
      expect(evaluateCondition({ any: ["user_approval", "artifact_exists(plan)"] }, env)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("{ any: [user_approval, artifact_exists(plan)] } → false when both false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cond-test-"));
    try {
      const store = new ArtifactStore(dir);
      const env = mockEnv({ artifacts: store, userMessagedThisTurn: false });
      expect(evaluateCondition({ any: ["user_approval", "artifact_exists(plan)"] }, env)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("{ not: user_approval } → inverts", () => {
    const env = mockEnv({ userMessagedThisTurn: false });
    expect(evaluateCondition({ not: "user_approval" }, env)).toBe(true);

    const env2 = mockEnv({ userMessagedThisTurn: true });
    expect(evaluateCondition({ not: "user_approval" }, env2)).toBe(false);
  });

  it("unknown condition \"frobnicate\" → false", () => {
    const env = mockEnv();
    expect(evaluateCondition("frobnicate", env)).toBe(false);
  });

  it("undefined condition → false", () => {
    const env = mockEnv();
    expect(evaluateCondition(undefined, env)).toBe(false);
  });

  it("evidence_met → false when requiredEvidence not in evidenceObserved", () => {
    const env = mockEnv({
      requiredEvidence: ["e1", "e2"],
      state: {
        ...mockEnv().state,
        evidenceObserved: { e1: true },
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(false);
  });

  it("evidence_met → true when all requiredEvidence observed", () => {
    const env = mockEnv({
      requiredEvidence: ["e1", "e2"],
      state: {
        ...mockEnv().state,
        evidenceObserved: { e1: true, e2: true },
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(true);
  });

  it("tool_observed → false when tool not observed", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        toolsObserved: [],
      },
    });
    expect(evaluateCondition("tool_observed(Bash)", env)).toBe(false);
  });

  it("tool_observed → true when tool was observed", () => {
    const env = mockEnv({
      state: {
        ...mockEnv().state,
        toolsObserved: ["Read", "Bash", "Write"],
      },
    });
    expect(evaluateCondition("tool_observed(Bash)", env)).toBe(true);
  });
});

describe("KNOWN_CONDITIONS", () => {
  it("contains exactly the 7 closed vocabulary entries", () => {
    expect(KNOWN_CONDITIONS.size).toBe(7);
    expect(KNOWN_CONDITIONS.has("user_approval")).toBe(true);
    expect(KNOWN_CONDITIONS.has("artifact_exists")).toBe(true);
    expect(KNOWN_CONDITIONS.has("plan_todos_complete")).toBe(true);
    expect(KNOWN_CONDITIONS.has("evidence_met")).toBe(true);
    expect(KNOWN_CONDITIONS.has("tool_observed")).toBe(true);
    expect(KNOWN_CONDITIONS.has("turn_count")).toBe(true);
    expect(KNOWN_CONDITIONS.has("state_eq")).toBe(true);
  });
});

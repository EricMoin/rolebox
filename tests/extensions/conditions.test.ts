import { describe, it, expect, beforeEach } from "bun:test";
import { registerCondition, evaluateCondition, KNOWN_CONDITIONS, type CondEnv } from "../../src/function/conditions";
import { functionRuntime } from "../../src/function/runtime-state";
import { ArtifactStore } from "../../src/function/artifact-store";

function makeEnv(): CondEnv {
  return {
    sessionID: "test-ses",
    fnName: "test-fn",
    state: functionRuntime.init("test-ses", "test-fn", 1),
    artifacts: new ArtifactStore("/tmp"),
    requiredEvidence: [],
    userMessagedThisTurn: false,
  };
}

describe("Function Conditions Registry", () => {
  it("built-in conditions exist in KNOWN_CONDITIONS", () => {
    expect(KNOWN_CONDITIONS.has("user_approval")).toBe(true);
    expect(KNOWN_CONDITIONS.has("artifact_exists")).toBe(true);
    expect(KNOWN_CONDITIONS.has("plan_todos_complete")).toBe(true);
    expect(KNOWN_CONDITIONS.has("evidence_met")).toBe(true);
    expect(KNOWN_CONDITIONS.has("tool_observed")).toBe(true);
    expect(KNOWN_CONDITIONS.has("turn_count")).toBe(true);
    expect(KNOWN_CONDITIONS.has("state_eq")).toBe(true);
  });

  it("registerCondition adds a custom condition to KNOWN_CONDITIONS", () => {
    registerCondition("my_custom_check", (_arg, _env) => true);
    expect(KNOWN_CONDITIONS.has("my_custom_check")).toBe(true);
  });

  it("registered condition is evaluable via evaluateCondition", () => {
    registerCondition("always_true", (_arg, _env) => true);
    registerCondition("always_false", (_arg, _env) => false);
    const env = makeEnv();
    expect(evaluateCondition("always_true", env)).toBe(true);
    expect(evaluateCondition("always_false", env)).toBe(false);
  });

  it("registered condition receives arg and env", () => {
    let receivedArg = "";
    let receivedSession = "";
    registerCondition("capture_args", (arg, env) => {
      receivedArg = arg;
      receivedSession = env.sessionID;
      return true;
    });
    const env = makeEnv();
    evaluateCondition("capture_args(hello)", env);
    expect(receivedArg).toBe("hello");
    expect(receivedSession).toBe("test-ses");
  });

  it("unknown condition evaluates to false", () => {
    const env = makeEnv();
    expect(evaluateCondition("nonexistent_condition", env)).toBe(false);
  });

  it("conditions compose with all/any/not", () => {
    registerCondition("yes", () => true);
    registerCondition("no", () => false);
    const env = makeEnv();
    expect(evaluateCondition({ all: ["yes", "yes"] }, env)).toBe(true);
    expect(evaluateCondition({ all: ["yes", "no"] }, env)).toBe(false);
    expect(evaluateCondition({ any: ["no", "yes"] }, env)).toBe(true);
    expect(evaluateCondition({ not: "yes" }, env)).toBe(false);
    expect(evaluateCondition({ not: "no" }, env)).toBe(true);
  });
});

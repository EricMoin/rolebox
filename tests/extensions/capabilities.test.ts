import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach } from "bun:test";
import {
  wrapConditionCapability,
  wrapObserveCapability,
  type ConditionCapability,
  type ObserveCapability,
} from "../../src/extensions/capabilities.ts";
import { registerCondition, evaluateCondition, type CondEnv } from "../../src/function/conditions.ts";
import { registerObserveHandler, runCustomObserve } from "../../src/function/observe.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import { ArtifactStore } from "../../src/function/artifact-store.ts";
import type { ResolvedFunction } from "../../src/types.ts";

// ── helpers ──────────────────────────────────────────────────────────

let tmpDir = "";

function makeEnv(overrides?: Partial<CondEnv>): CondEnv {
  // Unique temp dir per test run to avoid artifact collisions
  if (!tmpDir) {
    tmpDir = mkdtempSync(join(tmpdir(), "cap-test-"));
  }

  const state = functionRuntime.init("cap-test-session", "cap-fn", 1);
  // Pre-populate some state for testing
  state.evidenceObserved["req1"] = true;
  state.evidenceObserved["req2"] = false;
  state.toolsObserved.push("read_file", "write_file");
  state.kv["custom_key"] = "custom_value";
  state.kv["__todos"] = "- [ ] item1\n- [x] item2\n- [ ] item3";
  state.currentTurn = 5;
  state.activatedAtTurn = 1;

  return {
    sessionID: "cap-test-session",
    fnName: "cap-fn",
    state,
    artifacts: new ArtifactStore(tmpDir),
    requiredEvidence: ["req1", "req2"],
    userMessagedThisTurn: true,
    ...overrides,
  };
}

// ── ConditionCapability Tests ────────────────────────────────────────

describe("ConditionCapability", () => {
  let env: CondEnv;
  let cap: ConditionCapability;

  beforeEach(() => {
    env = makeEnv();
    cap = wrapConditionCapability(env);
  });

  it("exposes sessionID and fnName as properties", () => {
    expect(cap.sessionID).toBe("cap-test-session");
    expect(cap.fnName).toBe("cap-fn");
  });

  it("isUserMessagedThisTurn returns env.userMessagedThisTurn", () => {
    expect(cap.isUserMessagedThisTurn()).toBe(true);
    env.userMessagedThisTurn = false;
    expect(cap.isUserMessagedThisTurn()).toBe(false);
  });

  it("getTodosRemaining counts unchecked boxes from kv.__todos", () => {
    const remaining = cap.getTodosRemaining();
    expect(remaining).toBe(2); // "- [ ]" appears 2 times
  });

  it("getTodosRemaining falls back to artifact plan when kv is empty", () => {
    env.state.kv = {};
    // No plan artifact at /tmp either → 0
    expect(cap.getTodosRemaining()).toBe(0);
  });

  it("artifactExists delegates to env.artifacts.exists", () => {
    // "plan" doesn't exist yet
    expect(cap.artifactExists("plan")).toBe(false);
    env.artifacts.write(env.sessionID, "plan", "content");
    expect(cap.artifactExists("plan")).toBe(true);
  });

  it("isEvidenceMet returns true only when ALL required evidence is observed", () => {
    // req2 is false in setup
    expect(cap.isEvidenceMet(env.requiredEvidence)).toBe(false);
    env.state.evidenceObserved["req2"] = true;
    expect(cap.isEvidenceMet(env.requiredEvidence)).toBe(true);
  });

  it("wasToolObserved checks toolsObserved array", () => {
    expect(cap.wasToolObserved("read_file")).toBe(true);
    expect(cap.wasToolObserved("write_file")).toBe(true);
    expect(cap.wasToolObserved("nonexistent")).toBe(false);
  });

  it("getTurnsSinceActivation computes currentTurn - activatedAtTurn", () => {
    expect(cap.getTurnsSinceActivation()).toBe(4); // 5 - 1
  });

  it("getStateValue reads from kv store (stringified)", () => {
    expect(cap.getStateValue("custom_key")).toBe("custom_value");
    expect(cap.getStateValue("nonexistent")).toBeUndefined();
  });

  it("ConditionCapability does NOT expose state.kv directly", () => {
    // TypeScript prevents this at compile time; at runtime verify the shape
    const keys = Object.keys(cap);
    expect(keys).not.toContain("state");
    expect(keys).not.toContain("artifacts");
    expect(keys).not.toContain("requiredEvidence");
  });
});

// ── ObserveCapability Tests ──────────────────────────────────────────

describe("ObserveCapability", () => {
  it("wraps with only sessionID and eventName", () => {
    const cap = wrapObserveCapability(undefined, "ses-1", "my_event");
    expect(cap.sessionID).toBe("ses-1");
    expect(cap.eventName).toBe("my_event");
    expect(cap.toolName).toBeUndefined();
    expect(cap.toolArgs).toBeUndefined();
    expect(cap.toolOutput).toBeUndefined();
    expect(cap.lastAssistantText).toBeUndefined();
  });

  it("wraps with extras for tool-related events", () => {
    const cap = wrapObserveCapability(undefined, "ses-2", "tool_event", {
      toolName: "read_file",
      toolArgs: { path: "/tmp/test" },
      toolOutput: "content",
      lastAssistantText: "Let me read that file...",
    });
    expect(cap.sessionID).toBe("ses-2");
    expect(cap.eventName).toBe("tool_event");
    expect(cap.toolName).toBe("read_file");
    expect(cap.toolArgs).toEqual({ path: "/tmp/test" });
    expect(cap.toolOutput).toBe("content");
    expect(cap.lastAssistantText).toBe("Let me read that file...");
  });

  it("is a plain object with readonly-like properties", () => {
    const cap = wrapObserveCapability(undefined, "s", "e");
    // The TypeScript interface marks these as readonly, but at runtime
    // they are regular properties (no Object.defineProperty needed).
    expect(cap.sessionID).toBe("s");
    expect(cap.eventName).toBe("e");
  });
});

// ── Condition Extension with capability: true ────────────────────────

describe("Condition Extension Point — capability wrapping", () => {
  beforeEach(() => {
    // Clear registered conditions by removing all custom ones
    // We need to add test-specific conditions via registerCondition
  });

  it("capability: true module receives ConditionCapability (not raw CondEnv)", () => {
    let receivedCap: unknown = null;
    let receivedArg = "";

    // Simulate what ConditionExtensionPoint does for a capability module
    const env = makeEnv();
    const handler = (arg: string, _cap: unknown) => {
      receivedArg = arg;
      receivedCap = _cap;
      return true;
    };

    // Wrap like the extension point does
    const wrappedHandler = (arg: string, e: CondEnv): boolean => {
      const cap = wrapConditionCapability(e);
      return handler(arg, cap);
    };

    registerCondition("cap_condition_test", wrappedHandler);
    evaluateCondition("cap_condition_test(test_arg)", env);

    expect(receivedArg).toBe("test_arg");
    expect(receivedCap).toBeDefined();
    expect(receivedCap).toHaveProperty("sessionID", "cap-test-session");
    expect(receivedCap).toHaveProperty("fnName", "cap-fn");
    // Ensure ConditionCapability methods work
    const cap = receivedCap as ConditionCapability;
    expect(typeof cap.isUserMessagedThisTurn).toBe("function");
    expect(typeof cap.getTodosRemaining).toBe("function");
    expect(typeof cap.artifactExists).toBe("function");
    expect(typeof cap.isEvidenceMet).toBe("function");
    expect(typeof cap.wasToolObserved).toBe("function");
    expect(typeof cap.getTurnsSinceActivation).toBe("function");
    expect(typeof cap.getStateValue).toBe("function");
    // Explicitly verify raw CondEnv properties are NOT present
    expect(cap).not.toHaveProperty("state");
    expect(cap).not.toHaveProperty("artifacts");
    expect(cap).not.toHaveProperty("requiredEvidence");
  });

  it("legacy module (no capability flag) receives raw CondEnv as before", () => {
    let receivedEnv: unknown = null;

    // Direct registration without wrapping simulates legacy behavior
    const env = makeEnv();
    registerCondition("legacy_condition", (arg, e) => {
      receivedEnv = e;
      return arg === "pass";
    });

    evaluateCondition("legacy_condition(pass)", env);

    expect(receivedEnv).toBeDefined();
    // Legacy CondEnv has state, artifacts, requiredEvidence
    const e = receivedEnv as CondEnv;
    expect(e).toHaveProperty("state");
    expect(e).toHaveProperty("artifacts");
    expect(e).toHaveProperty("requiredEvidence");
    expect(e.sessionID).toBe("cap-test-session");
    expect(e.fnName).toBe("cap-fn");
  });
});

// ── Observe Extension with capability: true ──────────────────────────

describe("Observe Extension Point — capability wrapping", () => {
  it("capability: true module receives ObserveCapability via runCustomObserve", () => {
    let receivedCtx: unknown = null;
    let receivedSpec: unknown = null;

    // Register with capability flag like the extension point does
    registerObserveHandler(
      "cap_observe_event",
      (ctx, spec) => {
        receivedCtx = ctx;
        receivedSpec = spec;
        return ["injected"];
      },
      true, // capability = true → wrapping enabled
    );

    const fn: ResolvedFunction = {
      name: "obs-cap-fn",
      description: "test",
      content: "",
      filePath: "/tmp/test.md",
      source: "built-in" as any,
      observe: [{ on: "cap_observe_event", inject: "should-not-appear" }],
    };

    functionRuntime.init("obs-cap-ses", "obs-cap-fn", 1);

    const result = runCustomObserve({
      sessionID: "obs-cap-ses",
      eventName: "cap_observe_event",
      activeFns: [fn],
    });

    expect(receivedCtx).toBeDefined();
    const cap = receivedCtx as ObserveCapability;
    expect(cap.sessionID).toBe("obs-cap-ses");
    expect(cap.eventName).toBe("cap_observe_event");
    // The result from runCustomObserve should include the handler's return
    // (spec.inject is not used by runCustomObserve — only handler output)
    expect(result).toEqual(["injected"]);
  });

  it("legacy module (no capability flag) receives raw ctx unchanged", () => {
    let receivedCtx: unknown = null;

    registerObserveHandler(
      "legacy_observe_event",
      (ctx, _spec) => {
        receivedCtx = ctx;
        return ["legacy"];
      },
      false, // capability = false → raw ctx
    );

    const fn: ResolvedFunction = {
      name: "legacy-obs-fn",
      description: "test",
      content: "",
      filePath: "/tmp/test.md",
      source: "built-in" as any,
      observe: [{ on: "legacy_observe_event", inject: "legacy-inject" }],
    };

    functionRuntime.init("legacy-ses", "legacy-obs-fn", 1);

    const customCtx = { customField: "hello" };
    runCustomObserve({
      sessionID: "legacy-ses",
      eventName: "legacy_observe_event",
      activeFns: [fn],
      ctx: customCtx,
    });

    // With capability=false, the raw ctx is passed through unchanged
    expect(receivedCtx).toBe(customCtx);
    expect((receivedCtx as { customField: string }).customField).toBe("hello");
  });
});

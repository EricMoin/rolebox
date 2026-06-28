import { describe, it, expect } from "bun:test";
import { buildFunctionStateBlock, buildActiveArtifactBlock } from "../src/prompt-builder";
import type { FnState } from "../src/function/runtime-state";

describe("prompt builder function blocks", () => {
  it("buildFunctionStateBlock renders XML correctly", () => {
    const s: FnState = {
      phase: "active", activatedAtTurn: 0, currentTurn: 3,
      evidenceObserved: { lsp_diagnostics: true, test: false },
      toolsObserved: ["lsp_diagnostics"], continuationCount: 2,
      cooldownUntilTurn: 0, gateSatisfied: true, kv: {}, schemaVersion: 1,
    };
    const result = buildFunctionStateBlock("plan", s, 2);
    expect(result).toContain('<function_state name="plan">');
    expect(result).toContain("<phase>active</phase>");
    expect(result).toContain("<gate_satisfied>true</gate_satisfied>");
    expect(result).toContain("<todos_remaining>2</todos_remaining>");
    expect(result).toContain("<continuation>2</continuation>");
    expect(result).toContain("lsp_diagnostics=true");
    expect(result).toContain("test=false");
  });

  it("buildActiveArtifactBlock renders XML correctly", () => {
    const result = buildActiveArtifactBlock("plan", "BODY");
    expect(result).toContain('name="plan"');
    expect(result).toContain("BODY");
  });
});

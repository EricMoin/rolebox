import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildActiveArtifactBlock } from "../src/prompt-builder.ts";
import { ArtifactStore } from "../src/function/artifact-store.ts";
import { evaluateCondition } from "../src/function/conditions.ts";
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
    artifacts: new ArtifactStore(mkdtempSync(join(tmpdir(), "consume-test-"))),
    requiredEvidence: [],
    userMessagedThisTurn: false,
  };
  return { ...base, ...overrides };
}

describe("consumes artifact injection", () => {
  it("buildActiveArtifactBlock wraps content in <active_artifact> with name attr", () => {
    const block = buildActiveArtifactBlock("plan", "# My Plan\n\n- Step 1\n- Step 2");
    expect(block).toContain('<active_artifact name="plan">');
    expect(block).toContain("# My Plan");
    expect(block).toContain("- Step 1");
    expect(block).toContain("</active_artifact>");
  });

  it("ArtifactStore.read returns content for written artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "consume-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("session1", "plan", "design doc content");
      const content = store.read("session1", "plan");
      expect(content).toBe("design doc content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ArtifactStore.read returns null when no artifact exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "consume-test-"));
    try {
      const store = new ArtifactStore(dir);
      const content = store.read("session1", "plan");
      expect(content).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumes artifact: fn with consumes + written artifact → produces active_artifact block", () => {
    const dir = mkdtempSync(join(tmpdir(), "consume-test-"));
    try {
      const store = new ArtifactStore(dir);
      store.write("test-session", "plan", "the plan content");
      const content = store.read("test-session", "plan");
      expect(content).not.toBeNull();
      const block = buildActiveArtifactBlock("plan", content!);
      expect(block).toContain('<active_artifact name="plan">');
      expect(block).toContain("the plan content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumes artifact: fn with consumes but no artifact → no block produced", () => {
    const dir = mkdtempSync(join(tmpdir(), "consume-test-"));
    try {
      const store = new ArtifactStore(dir);
      const content = store.read("test-session", "plan");
      expect(content).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evidence_met condition", () => {
  it("evidence_met → false when requiredEvidence is empty and none observed", () => {
    const env = mockEnv({
      requiredEvidence: [],
      state: {
        ...mockEnv().state,
        evidenceObserved: {},
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(true); // empty → vacuously true via every()
  });

  it("evidence_met → false when required evidence not observed", () => {
    const env = mockEnv({
      requiredEvidence: ["lsp_diagnostics"],
      state: {
        ...mockEnv().state,
        evidenceObserved: {},
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(false);
  });

  it("evidence_met → false when some but not all required evidence observed", () => {
    const env = mockEnv({
      requiredEvidence: ["lsp_diagnostics", "build_pass"],
      state: {
        ...mockEnv().state,
        evidenceObserved: { lsp_diagnostics: true },
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(false);
  });

  it("evidence_met → true after all required evidence observed", () => {
    const env = mockEnv({
      requiredEvidence: ["lsp_diagnostics"],
      state: {
        ...mockEnv().state,
        evidenceObserved: { lsp_diagnostics: true },
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(true);
  });

  it("evidence_met → true after multiple evidence items all observed", () => {
    const env = mockEnv({
      requiredEvidence: ["lsp_diagnostics", "build_pass", "test_pass"],
      state: {
        ...mockEnv().state,
        evidenceObserved: { lsp_diagnostics: true, build_pass: true, test_pass: true },
      },
    });
    expect(evaluateCondition("evidence_met", env)).toBe(true);
  });
});

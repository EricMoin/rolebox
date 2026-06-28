/**
 * Golden-Path Integration Test
 *
 * Simulates the full plan→approve→execute→continue-until-done loop
 * using real stores (not mocks) to verify the agent workflow contract.
 *
 * Run: bun test tests/golden-path.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { ArtifactStore } from "../src/function/artifact-store";
import {
  FunctionRuntimeManager,
  type FnState,
  functionRuntime as singletonRt,
} from "../src/function/runtime-state";
import {
  evaluateCondition,
  type CondEnv,
} from "../src/function/conditions";
import { evaluateGateAndTransitions } from "../src/function/phase-machine";
import { decideContinuation } from "../src/function/continuation";
import { runToolObserve } from "../src/function/observe";
import { extractResultBlockNamed } from "../src/function/fence";
import { FunctionSessionState } from "../src/session-state";
import { buildActiveArtifactBlock } from "../src/prompt-builder";
import type { ResolvedFunction } from "../src/types";

// ─────── ResolvedFunction definitions matching our builtins ───────

const planFn: ResolvedFunction = {
  name: "plan",
  description: "Strategic planning — investigate, then produce a verifiable plan artifact, wait for approval",
  content: "You are now in PLANNING mode. Do not make changes yet. Investigate first, then plan.",
  filePath: "/fake/plan.md",
  source: "built-in",
  phase: "plan",
  priority: 20,
  produces: "plan",
  observe: [{ on: "tool_after", capture_artifact: "plan" }],
  gate: { all: ["artifact_exists(plan)", "user_approval"] },
  transitions: [{ when: "gate", activate: ["execute"], deactivate: ["plan"] }],
};

const executeFn: ResolvedFunction = {
  name: "execute",
  description: "Execute the approved plan with per-step verification, continue until all steps done",
  content: "You are now in EXECUTION mode. You have a plan. Implement it systematically.",
  filePath: "/fake/execute.md",
  source: "built-in",
  phase: "execute",
  priority: 20,
  consumes: "plan",
  requires_evidence: ["lsp_diagnostics", "test"],
  observe: [{ on: "tool_after", tool: "todowrite", sync_todos: true }],
  continue_until: { all: ["plan_todos_complete", "evidence_met"] },
  continue_max: 5,
};

// ─────── Helpers ────────────────────────────────────────────────────

function makeEnv(
  sessionID: string,
  fnName: string,
  state: FnState,
  artifacts: ArtifactStore,
  overrides: Partial<CondEnv> = {},
): CondEnv {
  return {
    sessionID,
    fnName,
    state,
    artifacts,
    requiredEvidence: [],
    userMessagedThisTurn: false,
    ...overrides,
  };
}

// ─────── Test Suite ─────────────────────────────────────────────────

describe("Golden Path: plan → approve → execute → continue-until-done", () => {
  let tmpDir: string;
  let artifacts: ArtifactStore;
  let sessions: FunctionSessionState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-gp-"));
    artifacts = new ArtifactStore(tmpDir);
    sessions = new FunctionSessionState();

    // Use singleton rt but clear state for this test
    singletonRt.setStoreDirectory(tmpDir);
    singletonRt.recover();
  });

  afterEach(() => {
    singletonRt.clearSession("gp-session");
    const dir = tmpDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ══════════════════════════════════════════════════════════════════
  // FULL GOLDEN PATH
  // ══════════════════════════════════════════════════════════════════

  it("completes the full golden-path loop with caps and recovery", () => {
    const SID = "gp-session";
    const transcript: string[] = [];
    const log = (msg: string) => transcript.push(msg);

    // ═══ STEP 1: User activates |plan| ═══
    log("[1] User sends: |plan| build X");
    sessions.activate(SID, ["plan"]);
    const planSt = singletonRt.init(SID, "plan", 1);
    planSt.currentTurn = 1;
    planSt.activatedAtTurn = 1;
    singletonRt.markDirty();
    expect(sessions.isActive(SID, "plan")).toBe(true);
    log("[1] ✓ plan activated, turn 1");

    // ═══ STEP 2: Model emits a ```plan block with - [ ] steps ═══
    log("[2] Model produces plan...");
    const assistantOutput = `I'll investigate and create a plan.

\`\`\`plan
Goal: Build X — a simple HTTP server.

Steps:
- [ ] 1. Create project scaffolding and install dependencies
- [ ] 2. Implement the HTTP server with error handling
- [ ] 3. Write unit tests for all endpoints
- [ ] 4. Run lsp_diagnostics and the test suite

Verification: lsp_diagnostics on all changed files, bun test passes.
\`\`\`

The plan is ready for your review.`;
    log("[2] ✓ plan block emitted with 4 steps");

    // ═══ STEP 3: Artifact captured via observe capture_artifact ═══
    const captured = extractResultBlockNamed(assistantOutput, "plan");
    expect(captured).not.toBeNull();
    artifacts.write(SID, "plan", captured!);
    expect(artifacts.exists(SID, "plan")).toBe(true);
    log("[3] ✓ artifact captured: plan → " + (captured!.length) + " chars");

    // Also track via runToolObserve (simulating real flow)
    runToolObserve({
      sessionID: SID,
      tool: "write",  // any tool fires plan's observe (no tool filter)
      activeFns: [planFn],
      artifacts,
      lastAssistantText: assistantOutput,
    });
    const planContent = artifacts.read(SID, "plan");
    expect(planContent).not.toBeNull();
    expect(planContent).toContain("Build X");
    log("[3] ✓ observe captured plan artifact");

    // ═══ STEP 4: Present artifact to user ═══
    expect(artifacts.read(SID, "plan")).toContain("- [ ] 1.");
    log("[4] ✓ plan artifact presentable to user");

    // ═══ STEP 5: User sends "approve" ═══
    log("[5] User sends 'approve' → userMessagedThisTurn = true");
    // New turn starts in system.transform
    planSt.currentTurn += 1;  // turn 2
    planSt.continuationCount = 0;  // reset on user message

    const planEnv = makeEnv(SID, "plan", planSt, artifacts, {
      userMessagedThisTurn: true,
    });

    // ═══ STEP 6: Gate satisfied → transitions ═══
    const tr = evaluateGateAndTransitions(planFn, planEnv);
    expect(planSt.gateSatisfied).toBe(true);
    expect(planSt.phase).toBe("active");
    expect(tr.activate).toContain("execute");
    expect(tr.deactivate).toContain("plan");
    log(`[6] ✓ gate satisfied: phase=${planSt.phase}, gate=${planSt.gateSatisfied}`);
    log(`[6] ✓ transitions: activate=${tr.activate}, deactivate=${tr.deactivate}`);

    // Apply transitions (plan deactivates itself, execute activates)
    sessions.activate(SID, tr.activate);
    sessions.deactivate(SID, "plan");
    expect(sessions.isActive(SID, "execute")).toBe(true);
    expect(sessions.isActive(SID, "plan")).toBe(false);
    log("[6] ✓ execute activated, plan deactivated");

    // ═══ STEP 7: Execute sees <active_artifact name="plan"> ═══
    const execSt = singletonRt.init(SID, "execute", 1);
    execSt.currentTurn = 2;
    execSt.activatedAtTurn = 2;
    singletonRt.markDirty();

    // Simulate system.transform injection of consumed artifact
    const injectedArtifact = buildActiveArtifactBlock("plan", planContent!);
    expect(injectedArtifact).toContain("<active_artifact");
    expect(injectedArtifact).toContain("Build X");
    log("[7] ✓ execute sees <active_artifact name=\"plan\">");

    // ═══ STEP 8: Model works — todowrite, lsp_diagnostics, test ═══
    log("[8] Model starts executing...");

    // 8a. Check off step 1
    runToolObserve({
      sessionID: SID,
      tool: "todowrite",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: `- [x] 1. Create project scaffolding and install dependencies\n- [ ] 2. Implement the HTTP server with error handling\n- [ ] 3. Write unit tests for all endpoints\n- [ ] 4. Run lsp_diagnostics and the test suite`,
    });
    expect(execSt.kv["__todos"]).toBeDefined();
    expect(execSt.kv["__todos"]).toContain("[x] 1.");
    expect(execSt.kv["__todos"]).toContain("[ ] 2.");

    // 8b. Run lsp_diagnostics after first change
    runToolObserve({
      sessionID: SID,
      tool: "lsp_diagnostics",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: null,
    });
    expect(execSt.evidenceObserved.lsp_diagnostics).toBe(true);

    // 8c. Check off step 2 & 3
    runToolObserve({
      sessionID: SID,
      tool: "todowrite",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: `- [x] 1. Create project scaffolding and install dependencies\n- [x] 2. Implement the HTTP server with error handling\n- [x] 3. Write unit tests for all endpoints\n- [ ] 4. Run lsp_diagnostics and the test suite`,
    });

    // 8d. Run test after changes
    runToolObserve({
      sessionID: SID,
      tool: "test",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: null,
    });
    expect(execSt.evidenceObserved.test).toBe(true);
    log("[8] ✓ 3 steps done, evidence: lsp_diagnostics=true, test=true");

    // ═══ STEP 9: Idle fires — continue_until checks ═══
    // Advance turn
    execSt.currentTurn += 1;  // turn 3

    const execEnv = makeEnv(SID, "execute", execSt, artifacts, {
      requiredEvidence: executeFn.requires_evidence ?? [],
    });

    // plan_todos_complete: still one unchecked
    const allDone = evaluateCondition(executeFn.continue_until!, execEnv);
    expect(allDone).toBe(false);  // [ ] 4. not yet checked
    log(`[9] ✓ idle: continue_until unmet (1 todo remaining, evidence met)`);

    // ═══ STEP 10: One continuation fires ═══
    const decision = decideContinuation({
      fnName: "execute",
      st: execSt,
      reason: "completion condition not yet met",
      cfg: { globalMaxTurns: 25, perFnMax: executeFn.continue_max ?? 5 },
      totalContinuationsThisBurst: 0,
    });
    expect(decision.shouldContinue).toBe(true);
    expect(decision.reminder).toContain("auto-continue");
    expect(decision.reminder).toContain("1/5");
    expect(execSt.continuationCount).toBe(1);
    log(`[10] ✓ continuation #${execSt.continuationCount} fired`);

    // Model completes last step
    runToolObserve({
      sessionID: SID,
      tool: "todowrite",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: `- [x] 1. Create project scaffolding and install dependencies\n- [x] 2. Implement the HTTP server with error handling\n- [x] 3. Write unit tests for all endpoints\n- [x] 4. Run lsp_diagnostics and the test suite`,
    });
    log("[10] ✓ last step checked off");

    // Run final lsp_diagnostics and test
    runToolObserve({
      sessionID: SID,
      tool: "lsp_diagnostics",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: null,
    });
    runToolObserve({
      sessionID: SID,
      tool: "test",
      activeFns: [executeFn],
      artifacts,
      lastAssistantText: null,
    });

    // ═══ STEP 10b: Next idle — condition now met ═══
    execSt.currentTurn += 1;  // turn 4
    const nowMet = evaluateCondition(executeFn.continue_until!, execEnv);
    expect(nowMet).toBe(true);
    execSt.phase = "complete";  // idle handler sets this
    singletonRt.markDirty();
    log("[10b] ✓ continue_until met → phase = complete");

    // ═══ STEP 11: Zero further continuations when phase=complete ═══
    // Simulate idle handler: it checks st.phase === "complete" and skips
    expect(execSt.phase).toBe("complete");
    log("[11] ✓ phase=complete → no further continuations would fire");

    // ═══ STEP 12: Caps respected ═══
    expect(execSt.continuationCount).toBe(1);
    expect(execSt.continuationCount).toBeLessThan(5);  // per-fn cap
    expect(execSt.continuationCount).toBeLessThan(25); // global cap
    log(`[12] ✓ caps respected: continuationCount=${execSt.continuationCount} < 5 (per-fn), < 25 (global)`);

    // ═══ STEP 13: Recovery after simulated restart ═══
    // Flush BEFORE any cap-busting mutations so recovery sees clean state
    log("[13] Simulating restart — flushing state...");
    singletonRt.flushSync();

    // Create a fresh runtime and recover from disk
    const recoveredRt = new FunctionRuntimeManager();
    recoveredRt.setStoreDirectory(tmpDir);
    recoveredRt.recover();

    const recSt = recoveredRt.get(SID, "execute");
    expect(recSt).toBeDefined();
    expect(recSt!.phase).toBe("complete");
    expect(recSt!.evidenceObserved.lsp_diagnostics).toBe(true);
    expect(recSt!.evidenceObserved.test).toBe(true);
    expect(recSt!.continuationCount).toBeGreaterThanOrEqual(1);
    expect(recSt!.kv["__todos"]).toBeDefined();

    // Also verify plan state recovered
    const recPlanSt = recoveredRt.get(SID, "plan");
    expect(recPlanSt).toBeDefined();
    expect(recPlanSt!.gateSatisfied).toBe(true);

    log("[13] ✓ recovery: execute phase=" + recSt!.phase +
      ", lsp_diagnostics=" + recSt!.evidenceObserved.lsp_diagnostics +
      ", test=" + recSt!.evidenceObserved.test);
    log("[13] ✓ recovery: plan gate_satisfied=" + recPlanSt!.gateSatisfied);

    // ═══ CAP-BUSTING VERIFICATION (post-recovery) ═══
    // Now test that per-fn cap blocks further continuations at the limit
    const cappedSt = singletonRt.init(SID + "-cap", "execute", 1);
    cappedSt.kv["__todos"] = "- [ ] pending";
    cappedSt.continuationCount = 5; // at limit
    const cappedDecision = decideContinuation({
      fnName: "execute",
      st: cappedSt,
      reason: "completion condition not yet met",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 1,
    });
    expect(cappedDecision.shouldContinue).toBe(false);
    expect(cappedDecision.reason).toBe("per-fn cap");
    log("[12b] ✓ per-fn cap blocks continuation at 5 (verified post-recovery)");

    // ── FINAL VERDICT ──
    const capsOk = execSt.continuationCount <= (executeFn.continue_max ?? 5);
    const recoveryOk = recSt!.phase === "complete" &&
      recSt!.evidenceObserved.lsp_diagnostics === true &&
      recSt!.evidenceObserved.test === true;
    const verdict = capsOk && recoveryOk ? "PASS" : "FAIL";

    const outputLines = [
      `Golden path [${verdict}] | caps respected [${capsOk ? "Y" : "N"}] | recovery [${recoveryOk ? "Y" : "N"}] | VERDICT: ${verdict}`,
      "─".repeat(60),
      ...transcript,
      "─".repeat(60),
      `FINAL: Golden path [${verdict}] | caps respected [${capsOk ? "Y" : "N"}] | recovery [${recoveryOk ? "Y" : "N"}] | VERDICT: ${verdict}`,
    ];

    const outputPath = join(
      import.meta.dir,
      "..",
      ".rolebox",
      "evidence",
      "final-qa",
      "golden-path.txt",
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, outputLines.join("\n"), "utf-8");

    log(`\nFINAL VERDICT: ${verdict}`);

    expect(capsOk).toBe(true);
    expect(recoveryOk).toBe(true);
    expect(verdict).toBe("PASS");
  });

  // ══════════════════════════════════════════════════════════════════
  // ADDITIONAL GATE/TRANSITION CHECKS
  // ══════════════════════════════════════════════════════════════════

  it("gate blocks when artifact missing even with user approval", () => {
    const SID = "gp-blocked";
    sessions.activate(SID, ["plan"]);
    const st = singletonRt.init(SID, "plan", 1);
    st.currentTurn = 1;

    const env = makeEnv(SID, "plan", st, artifacts, {
      userMessagedThisTurn: true,  // approved
      // but NO artifact written
    });

    evaluateGateAndTransitions(planFn, env);
    expect(st.gateSatisfied).toBe(false);  // blocked — no artifact
    expect(st.phase).toBe("gated");
  });

  it("gate blocks when artifact exists but no user approval", () => {
    const SID = "gp-no-approval";
    artifacts.write(SID, "plan", "Step 1\nStep 2");
    sessions.activate(SID, ["plan"]);
    const st = singletonRt.init(SID, "plan", 1);
    st.currentTurn = 1;

    const env = makeEnv(SID, "plan", st, artifacts, {
      userMessagedThisTurn: false,  // not approved
    });

    evaluateGateAndTransitions(planFn, env);
    expect(st.gateSatisfied).toBe(false);  // blocked — no approval
    expect(st.phase).toBe("gated");
  });

  it("plan_todos_complete only looks at __todos OR plan artifact", () => {
    const SID = "gp-todos-1";
    sessions.activate(SID, ["execute"]);
    const st = singletonRt.init(SID, "execute", 1);

    // No todo state at all → count = 0 → complete
    const env: CondEnv = {
      sessionID: SID,
      fnName: "execute",
      state: st,
      artifacts,
      requiredEvidence: [],
      userMessagedThisTurn: false,
    };
    expect(evaluateCondition("plan_todos_complete", env)).toBe(true);

    // With unchecked todo in kv
    st.kv["__todos"] = "- [ ] pending";
    expect(evaluateCondition("plan_todos_complete", env)).toBe(false);

    // With all checked
    st.kv["__todos"] = "- [x] done";
    expect(evaluateCondition("plan_todos_complete", env)).toBe(true);

    // Falls back to artifact if __todos missing
    st.kv["__todos"] = undefined;
    artifacts.write(SID, "plan", "- [ ] undone");
    expect(evaluateCondition("plan_todos_complete", env)).toBe(false);

    artifacts.write(SID, "plan", "- [x] all good");
    expect(evaluateCondition("plan_todos_complete", env)).toBe(true);
  });

  it("evidence_met requires all required_evidence tags observed", () => {
    const SID = "gp-evid";
    sessions.activate(SID, ["execute"]);
    const st = singletonRt.init(SID, "execute", 1);

    const env: CondEnv = {
      sessionID: SID,
      fnName: "execute",
      state: st,
      artifacts,
      requiredEvidence: ["lsp_diagnostics", "test"],
      userMessagedThisTurn: false,
    };

    expect(evaluateCondition("evidence_met", env)).toBe(false);

    st.evidenceObserved.lsp_diagnostics = true;
    expect(evaluateCondition("evidence_met", env)).toBe(false);

    st.evidenceObserved.test = true;
    expect(evaluateCondition("evidence_met", env)).toBe(true);
  });

  it("continue_until requires BOTH plan_todos_complete AND evidence_met", () => {
    const SID = "gp-both";
    sessions.activate(SID, ["execute"]);
    const st = singletonRt.init(SID, "execute", 1);
    st.kv["__todos"] = "- [x] all done";

    const env: CondEnv = {
      sessionID: SID,
      fnName: "execute",
      state: st,
      artifacts,
      requiredEvidence: ["lsp_diagnostics", "test"],
      userMessagedThisTurn: false,
    };

    // plan_todos_complete true, but evidence not met
    expect(evaluateCondition(executeFn.continue_until!, env)).toBe(false);

    // Add evidence
    st.evidenceObserved.lsp_diagnostics = true;
    st.evidenceObserved.test = true;

    // Both now met
    expect(evaluateCondition(executeFn.continue_until!, env)).toBe(true);
  });

  it("multiple continuations track cooldown correctly", () => {
    const SID = "gp-cooldown";
    sessions.activate(SID, ["execute"]);
    const st = singletonRt.init(SID, "execute", 1);
    st.currentTurn = 1;
    st.kv["__todos"] = "- [ ] pending";

    // First continuation
    const d1 = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 0,
    });
    expect(d1.shouldContinue).toBe(true);
    expect(st.continuationCount).toBe(1);
    expect(st.cooldownUntilTurn).toBe(0); // no cooldown yet

    // Second
    const d2 = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 1,
    });
    expect(d2.shouldContinue).toBe(true);
    expect(st.continuationCount).toBe(2);

    // Third → cooldown kicks in
    const d3 = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 2,
    });
    expect(d3.shouldContinue).toBe(true);
    expect(st.continuationCount).toBe(3);
    expect(st.cooldownUntilTurn).toBe(st.currentTurn + 1); // cooldown 1 turn

    // Fourth → still allowed but cooldown active → blocked on current turn
    st.currentTurn += 1; // advance to turn 2
    const d4 = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 3,
    });
    // cooldownUntilTurn = 2 (from turn 1 + 1), currentTurn = 2
    // cooldown: currentTurn < cooldownUntilTurn → only blocks if strictly less
    expect(d4.shouldContinue).toBe(true); // turn has passed cooldown

    // Fifth → extended cooldown
    const d5 = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 4,
    });
    expect(d5.shouldContinue).toBe(true);
    expect(st.continuationCount).toBe(5);
    expect(st.cooldownUntilTurn).toBe(st.currentTurn + 3);

    // Sixth → blocked by per-fn cap
    const d6 = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 25, perFnMax: 5 },
      totalContinuationsThisBurst: 5,
    });
    expect(d6.shouldContinue).toBe(false);
    expect(d6.reason).toBe("per-fn cap");
  });

  it("global cap prevents continuations beyond globalMaxTurns", () => {
    const SID = "gp-global-cap";
    sessions.activate(SID, ["execute"]);
    const st = singletonRt.init(SID, "execute", 1);
    st.kv["__todos"] = "- [ ] pending";

    const decision = decideContinuation({
      fnName: "execute", st,
      reason: "not done",
      cfg: { globalMaxTurns: 3, perFnMax: 10 },
      totalContinuationsThisBurst: 3,  // already at global cap
    });
    expect(decision.shouldContinue).toBe(false);
    expect(decision.reason).toBe("global cap");
  });
});

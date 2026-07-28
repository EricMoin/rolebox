import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sessionSignalLedger } from "../../src/signal/session-signal-ledger.ts";
import { mapDispatchStatusToSignal } from "../../src/graph/engine/engine-recovery.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal DispatchTask-shaped object for mapDispatchStatusToSignal testing. */
function minimalTask(status: "completed", overrides?: Partial<DispatchTask>): DispatchTask {
  return {
    id: "test-task",
    sessionId: "test-session",
    parentSessionId: "test-parent",
    depth: 1,
    status,
    agent: "test-agent",
    prompt: "test-prompt",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — revise_needed survives the pipeline
// ═══════════════════════════════════════════════════════════════════════════
describe("revise_needed survival through pipeline", () => {
  // Use a unique sessionID per test case to avoid cross-test pollution.
  const sessionID = "sess-survive-revise";

  beforeAll(() => {
    sessionSignalLedger.resetAll();
  });

  afterAll(() => {
    sessionSignalLedger.clearSession(sessionID);
  });

  it("records revise_needed into sessionSignalLedger (simulating bare subagent signal-tool)", () => {
    // Simulate signal-tool running in a session with NO active functions
    // (the "bare" subagent case). It still records at session level.
    sessionSignalLedger.record(sessionID, "revise_needed", {
      findings: ["output mismatch", "missing verification"],
      severity: "medium",
    });

    // Verify the signal is recorded and retrievable.
    expect(sessionSignalLedger.hasSignal(sessionID, "revise_needed")).toBe(true);
  });

  it("getTerminating returns revise_needed with the correct payload", () => {
    const term = sessionSignalLedger.getTerminating(sessionID);
    expect(term).not.toBeNull();
    expect(term!.type).toBe("revise_needed");
    expect(term!.payload).toEqual({
      findings: ["output mismatch", "missing verification"],
      severity: "medium",
    });
  });

  it("mapDispatchStatusToSignal preserves revise_needed (not hardcoded answer)", () => {
    // Step 1: Get the terminating signal from the session ledger.
    const term = sessionSignalLedger.getTerminating(sessionID)!;

    // Step 2: Build a task the way completion-evaluator would:
    //   task.terminatingSignal = getTerminatingSignal(taskId, task.sessionId) ?? undefined;
    // Then status="completed" + terminatingSignal populated.
    const task = minimalTask("completed", {
      sessionId: sessionID,
      terminatingSignal: { type: term.type, payload: term.payload },
    });

    // Step 3: mapDispatchStatusToSignal should return revise_needed, not answer.
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe("revise_needed");
    expect(sig!.payload).toEqual({
      findings: ["output mismatch", "missing verification"],
      severity: "medium",
    });
  });

  it("a revise_needed task's signal payload is preserved through mapDispatchStatusToSignal", () => {
    // Direct construction (bypass the ledger) — verify the mapping itself.
    const task = minimalTask("completed", {
      sessionId: sessionID,
      terminatingSignal: {
        type: "revise_needed",
        payload: { issue: "bad formatting" },
      },
    });
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "revise_needed",
      payload: { issue: "bad formatting" },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — Empty-ledger fallback
// ═══════════════════════════════════════════════════════════════════════════
describe("empty-ledger fallback — inferred answer", () => {
  const sessionID = "sess-empty-fallback";

  beforeAll(() => {
    sessionSignalLedger.resetAll();
    // Record nothing — ledger is empty for this session.
  });

  afterAll(() => {
    sessionSignalLedger.clearSession(sessionID);
  });

  it("getTerminating returns null when no signals recorded", () => {
    const term = sessionSignalLedger.getTerminating(sessionID);
    expect(term).toBeNull();
  });

  it("mapDispatchStatusToSignal returns inferred answer when task has no terminatingSignal", () => {
    // The completion evaluator sets terminatingSignal = getTerminating(...) ?? undefined.
    // When ledger is empty, getTerminating returns null, so terminatingSignal stays undefined.
    const task = minimalTask("completed", { sessionId: sessionID });
    // terminatingSignal is NOT explicitly set → undefined.
    expect(task.terminatingSignal).toBeUndefined();

    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "answer",
      payload: { __inferred: true },
    });
  });

  it("mapDispatchStatusToSignal returns inferred answer when no task is passed at all", () => {
    const sig = mapDispatchStatusToSignal("completed");
    expect(sig).toEqual({
      type: "answer",
      payload: { __inferred: true },
    });
  });

  it("a completed task with undefined terminatingSignal field still gets inferred answer", () => {
    // Explicitly set terminatingSignal to undefined (mirrors ?? undefined).
    const task = minimalTask("completed", {
      sessionId: sessionID,
      terminatingSignal: undefined,
    } as Partial<DispatchTask>);
    // The type system expects `terminatingSignal?:`, so undefined is valid.

    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "answer",
      payload: { __inferred: true },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — Severity ordering
// ═══════════════════════════════════════════════════════════════════════════
describe("terminating signal severity ordering", () => {
  const escalateSession = "sess-severity-all";
  const reviseSession = "sess-severity-answer-revise";
  const answerOnlySession = "sess-severity-answer";

  beforeAll(() => {
    sessionSignalLedger.resetAll();
  });

  afterAll(() => {
    sessionSignalLedger.clearSession(escalateSession);
    sessionSignalLedger.clearSession(reviseSession);
    sessionSignalLedger.clearSession(answerOnlySession);
  });

  it("escalate > revise_needed > answer: all three recorded → escalate wins", () => {
    // Record answer first, then revise_needed, then escalate — latter overwrites
    // the same-type slot (Map keyed by type) but all three coexist as distinct keys.
    sessionSignalLedger.record(escalateSession, "answer", { note: "done" });
    sessionSignalLedger.record(escalateSession, "revise_needed", { fix: "format" });
    sessionSignalLedger.record(escalateSession, "escalate", { reason: "crash" });

    // All three signals are present in the ledger.
    expect(sessionSignalLedger.hasSignal(escalateSession, "answer")).toBe(true);
    expect(sessionSignalLedger.hasSignal(escalateSession, "revise_needed")).toBe(true);
    expect(sessionSignalLedger.hasSignal(escalateSession, "escalate")).toBe(true);

    // Severity order: escalate > revise_needed > answer.
    const term = sessionSignalLedger.getTerminating(escalateSession);
    expect(term).not.toBeNull();
    expect(term!.type).toBe("escalate");
    expect(term!.payload).toEqual({ reason: "crash" });
  });

  it("answer + revise_needed → revise_needed wins", () => {
    sessionSignalLedger.record(reviseSession, "answer", { note: "done" });
    sessionSignalLedger.record(reviseSession, "revise_needed", { fix: "style" });

    expect(sessionSignalLedger.hasSignal(reviseSession, "answer")).toBe(true);
    expect(sessionSignalLedger.hasSignal(reviseSession, "revise_needed")).toBe(true);

    const term = sessionSignalLedger.getTerminating(reviseSession);
    expect(term).not.toBeNull();
    expect(term!.type).toBe("revise_needed");
    expect(term!.payload).toEqual({ fix: "style" });
  });

  it("answer only → answer wins", () => {
    sessionSignalLedger.record(answerOnlySession, "answer", { result: "ok" });

    const term = sessionSignalLedger.getTerminating(answerOnlySession);
    expect(term).not.toBeNull();
    expect(term!.type).toBe("answer");
    expect(term!.payload).toEqual({ result: "ok" });
  });

  it("revise_needed recorded after escalate → escalate still wins (severity order)", () => {
    // Even when recorded in reverse order, severity wins — the ledger
    // iterates TERMINATING_SIGNALS_BY_SEVERITY, not insertion order.
    const sid = "sess-reverse-order";
    sessionSignalLedger.record(sid, "revise_needed", { fix: "late" });
    sessionSignalLedger.record(sid, "escalate", { reason: "early" });

    const term = sessionSignalLedger.getTerminating(sid);
    expect(term).not.toBeNull();
    expect(term!.type).toBe("escalate");

    // Clean up this ad-hoc session.
    sessionSignalLedger.clearSession(sid);
  });
});

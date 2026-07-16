/**
 * ─────────────────────────────────────────────────────────────────────
 * Sub-task 7: metrics unit tests
 *
 * Covers RecoveryMetricsCollector: recordAttempt, recordChainOutcome,
 * recordErrorType, getSnapshot, flushTo, and reset.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { RecoveryMetricsCollector } from "../../src/recovery/metrics.ts";
import type { RecoveryMetricsSnapshot } from "../../src/recovery/types.ts";

describe("RecoveryMetricsCollector", () => {
  afterEach(() => {
    mock.restore();
  });

  it("starts with zeroed snapshots", () => {
    const metrics = new RecoveryMetricsCollector();
    const snap = metrics.getSnapshot();
    expect(snap.totalAttempts).toBe(0);
    expect(snap.successfulRecoveries).toBe(0);
    expect(snap.abortedChains).toBe(0);
    expect(snap.exhaustedChains).toBe(0);
    expect(snap.byCategory).toEqual({});
    expect(snap.byStrategy).toEqual({});
    expect(snap.errorTypeFrequency).toEqual({});
  });

  describe("recordAttempt", () => {
    it("increments totalAttempts counter", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordAttempt("session_error", "retry", "retry");
      metrics.recordAttempt("session_error", "retry", "success");
      expect(metrics.getSnapshot().totalAttempts).toBe(2);
    });

    it("tracks per-category attempts and successes", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordAttempt("session_error", "retry", "retry");
      metrics.recordAttempt("session_error", "compact", "retry");
      metrics.recordAttempt("session_error", "abort", "success");
      metrics.recordAttempt("edit_error", "remind_and_retry", "retry");

      const snap = metrics.getSnapshot();
      expect(snap.byCategory["session_error"]).toBeDefined();
      expect(snap.byCategory["session_error"].attempts).toBe(3);
      expect(snap.byCategory["session_error"].successes).toBe(1);
      expect(snap.byCategory["edit_error"]).toBeDefined();
      expect(snap.byCategory["edit_error"].attempts).toBe(1);
      expect(snap.byCategory["edit_error"].successes).toBe(0);
    });

    it("tracks per-strategy attempts and successes", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordAttempt("session_error", "retry", "retry");
      metrics.recordAttempt("session_error", "retry", "success");
      metrics.recordAttempt("session_error", "compact", "retry");

      const snap = metrics.getSnapshot();
      expect(snap.byStrategy["retry"]).toBeDefined();
      expect(snap.byStrategy["retry"].attempts).toBe(2);
      expect(snap.byStrategy["retry"].successes).toBe(1);
      expect(snap.byStrategy["compact"]).toBeDefined();
      expect(snap.byStrategy["compact"].attempts).toBe(1);
      expect(snap.byStrategy["compact"].successes).toBe(0);
    });

    it("handles many attempts across categories", () => {
      const metrics = new RecoveryMetricsCollector();
      for (let i = 0; i < 100; i++) {
        metrics.recordAttempt("session_error", "retry", "retry");
      }
      expect(metrics.getSnapshot().totalAttempts).toBe(100);
    });
  });

  describe("recordChainOutcome", () => {
    it("increments successfulRecoveries on recovered", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordChainOutcome("session_error", "recovered");
      expect(metrics.getSnapshot().successfulRecoveries).toBe(1);
    });

    it("increments abortedChains on aborted", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordChainOutcome("context_window", "aborted");
      expect(metrics.getSnapshot().abortedChains).toBe(1);
    });

    it("increments exhaustedChains on exhausted", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordChainOutcome("edit_error", "exhausted");
      expect(metrics.getSnapshot().exhaustedChains).toBe(1);
    });

    it("updates category successes on recovered", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordAttempt("session_error", "retry", "success");
      metrics.recordChainOutcome("session_error", "recovered");
      const snap = metrics.getSnapshot();
      expect(snap.byCategory["session_error"].successes).toBe(2); // one from attempt, one from chain
    });

    it("tracks multiple chain outcomes", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordChainOutcome("session_error", "recovered");
      metrics.recordChainOutcome("session_error", "recovered");
      metrics.recordChainOutcome("edit_error", "exhausted");
      metrics.recordChainOutcome("context_window", "aborted");

      const snap = metrics.getSnapshot();
      expect(snap.successfulRecoveries).toBe(2);
      expect(snap.exhaustedChains).toBe(1);
      expect(snap.abortedChains).toBe(1);
    });
  });

  describe("recordErrorType", () => {
    it("increments error type frequency", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordErrorType("timeout");
      metrics.recordErrorType("timeout");
      metrics.recordErrorType("api_error");
      const snap = metrics.getSnapshot();
      expect(snap.errorTypeFrequency["timeout"]).toBe(2);
      expect(snap.errorTypeFrequency["api_error"]).toBe(1);
    });

    it("starts at 1 for first occurrence of a type", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordErrorType("first_type");
      expect(metrics.getSnapshot().errorTypeFrequency["first_type"]).toBe(1);
    });
  });

  describe("flushTo", () => {
    it("writes snapshot to the provided store", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordAttempt("session_error", "retry", "success");
      metrics.recordChainOutcome("session_error", "recovered");

      let savedSessionID = "";
      let savedState: unknown = null;
      const store = {
        save(sessionID: string, state: unknown) {
          savedSessionID = sessionID;
          savedState = state;
        },
      };

      metrics.flushTo(store, "flush-session");
      expect(savedSessionID).toBe("flush-session");
      expect(savedState).toBeDefined();
      const typedState = savedState as { metrics: RecoveryMetricsSnapshot };
      expect(typedState.metrics.totalAttempts).toBe(1);
    });
  });

  describe("reset", () => {
    it("clears all accumulated metrics", () => {
      const metrics = new RecoveryMetricsCollector();
      metrics.recordAttempt("session_error", "retry", "success");
      metrics.recordChainOutcome("session_error", "recovered");
      metrics.recordErrorType("timeout");
      expect(metrics.getSnapshot().totalAttempts).toBeGreaterThan(0);

      metrics.reset();

      const snap = metrics.getSnapshot();
      expect(snap.totalAttempts).toBe(0);
      expect(snap.successfulRecoveries).toBe(0);
      expect(snap.byCategory).toEqual({});
      expect(snap.byStrategy).toEqual({});
      expect(snap.errorTypeFrequency).toEqual({});
    });
  });

  it("integrates all operations: record -> snapshot -> reset", () => {
    const metrics = new RecoveryMetricsCollector();

    // Record 3 attempts, 2 chain outcomes, 2 error types
    metrics.recordAttempt("session_error", "retry", "retry");
    metrics.recordAttempt("session_error", "compact", "success");
    metrics.recordAttempt("edit_error", "remind_and_retry", "retry");
    metrics.recordChainOutcome("session_error", "recovered");
    metrics.recordChainOutcome("edit_error", "exhausted");
    metrics.recordErrorType("timeout");
    metrics.recordErrorType("api_error");

    const snap = metrics.getSnapshot();
    expect(snap.totalAttempts).toBe(3);
    expect(snap.successfulRecoveries).toBe(1);
    expect(snap.exhaustedChains).toBe(1);
    expect(Object.keys(snap.byCategory)).toHaveLength(2);
    expect(Object.keys(snap.byStrategy)).toHaveLength(3);
    expect(Object.keys(snap.errorTypeFrequency)).toHaveLength(2);

    metrics.reset();
    expect(metrics.getSnapshot().totalAttempts).toBe(0);
  });
});

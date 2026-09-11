/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionSignalLedger,
  SIGNAL_TYPE,
} from "../../src/signal/session-signal-ledger.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function freshLedger(): SessionSignalLedger {
  return new SessionSignalLedger();
}

// ── record ─────────────────────────────────────────────────────────────────

describe("SessionSignalLedger.record", () => {
  let ledger: SessionSignalLedger;
  const SID = "s1";

  beforeEach(() => {
    ledger = freshLedger();
  });

  it("records a signal with payload", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { ok: true });
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.ANSWER)).toBe(true);
    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.type).toBe(SIGNAL_TYPE.ANSWER);
    expect(t!.payload).toEqual({ ok: true });
  });

  it("normalizes missing payload to null", () => {
    ledger.record(SID, SIGNAL_TYPE.PROGRESS);
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.PROGRESS)).toBe(true);
    const h = ledger.getTerminating(SID);
    expect(h).toBeNull(); // progress is not terminating
  });

  it("normalizes explicit undefined payload to null", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, undefined);
    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.payload).toBeNull();
  });

  it("overwrites previous signal of same type", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { attempt: 1 });
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { attempt: 2 });
    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.payload).toEqual({ attempt: 2 });
  });

  it("records multiple distinct signal types", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger.record(SID, SIGNAL_TYPE.NEED_APPROVAL, { a: 2 });
    ledger.record(SID, SIGNAL_TYPE.PROGRESS, { a: 3 });

    expect(ledger.hasSignal(SID, SIGNAL_TYPE.ANSWER)).toBe(true);
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.NEED_APPROVAL)).toBe(true);
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.PROGRESS)).toBe(true);
  });
});

// ── getTerminating ─────────────────────────────────────────────────────────

describe("SessionSignalLedger.getTerminating", () => {
  let ledger: SessionSignalLedger;
  const SID = "s1";

  beforeEach(() => {
    ledger = freshLedger();
  });

  it("returns null for unknown session", () => {
    expect(ledger.getTerminating("nonexistent")).toBeNull();
  });

  it("returns null when no terminating signal recorded", () => {
    ledger.record(SID, SIGNAL_TYPE.PROGRESS, { pct: 50 });
    ledger.record(SID, SIGNAL_TYPE.NEED_APPROVAL, {});
    expect(ledger.getTerminating(SID)).toBeNull();
  });

  it("returns answer when only answer is recorded", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { data: 1 });
    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.type).toBe(SIGNAL_TYPE.ANSWER);
    expect(t!.payload).toEqual({ data: 1 });
  });

  it("prefers escalate over revise_needed and answer", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger.record(SID, SIGNAL_TYPE.REVISE_NEEDED, { r: 1 });
    ledger.record(SID, SIGNAL_TYPE.ESCALATE, { e: 1 });

    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.type).toBe(SIGNAL_TYPE.ESCALATE);
    expect(t!.payload).toEqual({ e: 1 });
  });

  it("prefers revise_needed over answer", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger.record(SID, SIGNAL_TYPE.REVISE_NEEDED, { r: 1 });

    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.type).toBe(SIGNAL_TYPE.REVISE_NEEDED);
    expect(t!.payload).toEqual({ r: 1 });
  });

  it("escalate beats everything even when recorded first", () => {
    ledger.record(SID, SIGNAL_TYPE.ESCALATE, { e: 1 });
    ledger.record(SID, SIGNAL_TYPE.REVISE_NEEDED, { r: 1 });
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { a: 1 });

    const t = ledger.getTerminating(SID);
    expect(t).not.toBeNull();
    expect(t!.type).toBe(SIGNAL_TYPE.ESCALATE);
  });

  it("returns null when terminating signal was cleared", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger.clearSession(SID);
    expect(ledger.getTerminating(SID)).toBeNull();
  });
});

// ── getHitlSignal ──────────────────────────────────────────────────────────

describe("SessionSignalLedger.getHitlSignal", () => {
  let ledger: SessionSignalLedger;
  const SID = "s1";

  beforeEach(() => {
    ledger = freshLedger();
  });

  it("returns null for unknown session", () => {
    expect(ledger.getHitlSignal("nonexistent")).toBeNull();
  });

  it("returns null when no HITL signal recorded", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger.record(SID, SIGNAL_TYPE.PROGRESS, { p: 1 });
    expect(ledger.getHitlSignal(SID)).toBeNull();
  });

  it("returns need_approval when only need_approval is recorded", () => {
    ledger.record(SID, SIGNAL_TYPE.NEED_APPROVAL, { reason: "check" });
    const h = ledger.getHitlSignal(SID);
    expect(h).not.toBeNull();
    expect(h!.type).toBe(SIGNAL_TYPE.NEED_APPROVAL);
    expect(h!.payload).toEqual({ reason: "check" });
  });

  it("prefers need_approval over blocked and need_clarification", () => {
    ledger.record(SID, SIGNAL_TYPE.NEED_CLARIFICATION, { q: "what?" });
    ledger.record(SID, SIGNAL_TYPE.BLOCKED, { by: "tool" });
    ledger.record(SID, SIGNAL_TYPE.NEED_APPROVAL, { reason: "gate" });

    const h = ledger.getHitlSignal(SID);
    expect(h).not.toBeNull();
    expect(h!.type).toBe(SIGNAL_TYPE.NEED_APPROVAL);
    expect(h!.payload).toEqual({ reason: "gate" });
  });

  it("prefers blocked over need_clarification", () => {
    ledger.record(SID, SIGNAL_TYPE.NEED_CLARIFICATION, { q: "what?" });
    ledger.record(SID, SIGNAL_TYPE.BLOCKED, { by: "service" });

    const h = ledger.getHitlSignal(SID);
    expect(h).not.toBeNull();
    expect(h!.type).toBe(SIGNAL_TYPE.BLOCKED);
    expect(h!.payload).toEqual({ by: "service" });
  });

  it("returns null when HITL signal was cleared", () => {
    ledger.record(SID, SIGNAL_TYPE.NEED_APPROVAL, {});
    ledger.clearSession(SID);
    expect(ledger.getHitlSignal(SID)).toBeNull();
  });

  it("HITL priority is independent of record order", () => {
    ledger.record(SID, SIGNAL_TYPE.NEED_APPROVAL, {});
    ledger.record(SID, SIGNAL_TYPE.BLOCKED, {});
    // need_approval should win even if blocked was last
    ledger.record(SID, SIGNAL_TYPE.BLOCKED, { extra: true });
    const h = ledger.getHitlSignal(SID);
    expect(h!.type).toBe(SIGNAL_TYPE.NEED_APPROVAL);
  });
});

// ── hasSignal ──────────────────────────────────────────────────────────────

describe("SessionSignalLedger.hasSignal", () => {
  let ledger: SessionSignalLedger;
  const SID = "s1";

  beforeEach(() => {
    ledger = freshLedger();
  });

  it("returns false for unknown session", () => {
    expect(ledger.hasSignal("nonexistent", SIGNAL_TYPE.ANSWER)).toBe(false);
  });

  it("returns false for unrecorded type", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, {});
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.ESCALATE)).toBe(false);
  });

  it("returns true for recorded type", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, {});
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.ANSWER)).toBe(true);
  });

  it("returns false after clearSession", () => {
    ledger.record(SID, SIGNAL_TYPE.ANSWER, {});
    ledger.clearSession(SID);
    expect(ledger.hasSignal(SID, SIGNAL_TYPE.ANSWER)).toBe(false);
  });
});

// ── clearSession ───────────────────────────────────────────────────────────

describe("SessionSignalLedger.clearSession", () => {
  let ledger: SessionSignalLedger;

  beforeEach(() => {
    ledger = freshLedger();
  });

  it("removes all signals for the session", () => {
    ledger.record("s1", SIGNAL_TYPE.ANSWER, {});
    ledger.record("s1", SIGNAL_TYPE.PROGRESS, {});
    ledger.record("s1", SIGNAL_TYPE.NEED_APPROVAL, {});

    ledger.clearSession("s1");

    expect(ledger.hasSignal("s1", SIGNAL_TYPE.ANSWER)).toBe(false);
    expect(ledger.hasSignal("s1", SIGNAL_TYPE.PROGRESS)).toBe(false);
    expect(ledger.hasSignal("s1", SIGNAL_TYPE.NEED_APPROVAL)).toBe(false);
    expect(ledger.getTerminating("s1")).toBeNull();
    expect(ledger.getHitlSignal("s1")).toBeNull();
  });

  it("does not affect other sessions", () => {
    ledger.record("s1", SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger.record("s2", SIGNAL_TYPE.ESCALATE, { e: 1 });

    ledger.clearSession("s1");

    expect(ledger.hasSignal("s1", SIGNAL_TYPE.ANSWER)).toBe(false);
    expect(ledger.hasSignal("s2", SIGNAL_TYPE.ESCALATE)).toBe(true);
    expect(ledger.getTerminating("s2")!.type).toBe(SIGNAL_TYPE.ESCALATE);
  });

  it("is idempotent on unknown session", () => {
    expect(() => ledger.clearSession("nonexistent")).not.toThrow();
  });
});

// ── Multi-session isolation ────────────────────────────────────────────────

describe("SessionSignalLedger multi-session isolation", () => {
  let ledger: SessionSignalLedger;

  beforeEach(() => {
    ledger = freshLedger();
  });

  it("independent sessions do not interfere", () => {
    ledger.record("s1", SIGNAL_TYPE.ANSWER, { s: 1 });
    ledger.record("s2", SIGNAL_TYPE.ESCALATE, { s: 2 });

    expect(ledger.getTerminating("s1")!.type).toBe(SIGNAL_TYPE.ANSWER);
    expect(ledger.getTerminating("s2")!.type).toBe(SIGNAL_TYPE.ESCALATE);
  });

  it("hasSignal is scoped to session", () => {
    ledger.record("s1", SIGNAL_TYPE.ANSWER, {});
    ledger.record("s2", SIGNAL_TYPE.PROGRESS, {});

    expect(ledger.hasSignal("s1", SIGNAL_TYPE.ANSWER)).toBe(true);
    expect(ledger.hasSignal("s1", SIGNAL_TYPE.PROGRESS)).toBe(false);
    expect(ledger.hasSignal("s2", SIGNAL_TYPE.ANSWER)).toBe(false);
    expect(ledger.hasSignal("s2", SIGNAL_TYPE.PROGRESS)).toBe(true);
  });
});

// ── Persistence round-trip ─────────────────────────────────────────────────

describe("SessionSignalLedger persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-signalledger-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips signals through save and recover", () => {
    const ledger1 = freshLedger();
    ledger1.setStoreDirectory(tmpDir);
    ledger1.record("s1", SIGNAL_TYPE.ANSWER, { data: 42 });
    ledger1.record("s1", SIGNAL_TYPE.NEED_APPROVAL, { reason: "gate" });
    ledger1.flushSync();

    const ledger2 = freshLedger();
    ledger2.setStoreDirectory(tmpDir);
    ledger2.recover();

    expect(ledger2.hasSignal("s1", SIGNAL_TYPE.ANSWER)).toBe(true);
    expect(ledger2.hasSignal("s1", SIGNAL_TYPE.NEED_APPROVAL)).toBe(true);
    const t = ledger2.getTerminating("s1");
    expect(t).not.toBeNull();
    expect(t!.type).toBe(SIGNAL_TYPE.ANSWER);
    expect(t!.payload).toEqual({ data: 42 });
  });

  it("recover on a missing file yields empty state", () => {
    const ledger = freshLedger();
    ledger.setStoreDirectory(tmpDir);
    ledger.recover();
    // Should not throw; state is empty
    expect(ledger.getTerminating("any")).toBeNull();
  });

  it("clearSession persists correctly", () => {
    const ledger1 = freshLedger();
    ledger1.setStoreDirectory(tmpDir);
    ledger1.record("s1", SIGNAL_TYPE.ANSWER, {});
    ledger1.clearSession("s1");
    ledger1.flushSync();

    const ledger2 = freshLedger();
    ledger2.setStoreDirectory(tmpDir);
    ledger2.recover();

    expect(ledger2.hasSignal("s1", SIGNAL_TYPE.ANSWER)).toBe(false);
    expect(ledger2.getTerminating("s1")).toBeNull();
  });

  it("multiple sessions persist and recover together", () => {
    const ledger1 = freshLedger();
    ledger1.setStoreDirectory(tmpDir);
    ledger1.record("s1", SIGNAL_TYPE.ANSWER, { a: 1 });
    ledger1.record("s2", SIGNAL_TYPE.ESCALATE, { e: 2 });
    ledger1.flushSync();

    const ledger2 = freshLedger();
    ledger2.setStoreDirectory(tmpDir);
    ledger2.recover();

    expect(ledger2.getTerminating("s1")!.type).toBe(SIGNAL_TYPE.ANSWER);
    expect(ledger2.getTerminating("s2")!.type).toBe(SIGNAL_TYPE.ESCALATE);
  });
});

// ── resetAll ───────────────────────────────────────────────────────────────

describe("SessionSignalLedger.resetAll", () => {
  it("clears all in-memory sessions", () => {
    const ledger = freshLedger();
    ledger.record("s1", SIGNAL_TYPE.ANSWER, {});
    ledger.record("s2", SIGNAL_TYPE.ESCALATE, {});

    ledger.resetAll();

    expect(ledger.getTerminating("s1")).toBeNull();
    expect(ledger.getTerminating("s2")).toBeNull();
    expect(ledger.hasSignal("s1", SIGNAL_TYPE.ANSWER)).toBe(false);
  });

  it("does not throw on empty ledger", () => {
    const ledger = freshLedger();
    expect(() => ledger.resetAll()).not.toThrow();
  });
});

// ── Overwrite semantics (last-write-wins per type) ─────────────────────────

describe("SessionSignalLedger overwrite semantics", () => {
  it("last write wins for same type within same session", () => {
    const ledger = freshLedger();
    ledger.record("s1", SIGNAL_TYPE.ANSWER, { v: 1 });
    ledger.record("s1", SIGNAL_TYPE.ANSWER, { v: 2 });

    const t = ledger.getTerminating("s1");
    expect(t!.payload).toEqual({ v: 2 });
  });

  it("distinct types are independent within same session", () => {
    const ledger = freshLedger();
    ledger.record("s1", SIGNAL_TYPE.ANSWER, { v: 1 });
    ledger.record("s1", SIGNAL_TYPE.PROGRESS, { v: 2 });
    ledger.record("s1", SIGNAL_TYPE.ANSWER, { v: 10 });

    const t = ledger.getTerminating("s1");
    expect(t!.type).toBe(SIGNAL_TYPE.ANSWER);
    expect(t!.payload).toEqual({ v: 10 });
  });
});

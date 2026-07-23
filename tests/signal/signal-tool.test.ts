/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSignalTool } from "../../src/signal/signal-tool.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import { functionRuntime, type FnState } from "../../src/function/runtime-state.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import {
  recordSignal,
  hasSignal,
  getSignalPayload,
} from "../../src/signal/signal-ledger.ts";

// Minimal tool context for isolated tool tests
const makeContext = (sessionID = "test-session"): CanonicalToolContext => ({
  sessionID,
  messageID: "msg-001",
  agent: "test-agent",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
});

// The 8 signal type enum values
const SIGNAL_TYPES = [
  "answer",
  "need_approval",
  "blocked",
  "need_clarification",
  "handoff",
  "progress",
  "revise_needed",
  "escalate",
] as const;

// ── Standalone tool tests (no FSM dependency) ────────────────────────

describe("signal tool", () => {
  const tool = createSignalTool();
  const ctx = makeContext();

  // standalone tests expect no active functions — ensure other test suites
  // that may have activated functions on "test-session" don't contaminate us
  beforeEach(() => {
    functionSessionState.clear(ctx.sessionID);
  });

  it("returns a CanonicalToolDef with description, args, and execute", () => {
    expect(tool).toHaveProperty("description");
    expect(typeof tool.description).toBe("string");
    expect(tool).toHaveProperty("args");
    expect(tool).toHaveProperty("execute");
    expect(typeof tool.execute).toBe("function");
  });

  describe("all 8 signal types (no active functions)", () => {
    const noFnMsg = (type: string) => `signal: ${type} acknowledged (no active functions)`;

    for (const signalType of SIGNAL_TYPES) {
      it(`emits correct message for type "${signalType}"`, async () => {
        const result = await tool.execute({ type: signalType }, ctx);
        expect(result).toBe(noFnMsg(signalType));
      });
    }
  });

  it("does not throw for any signal type", async () => {
    for (const signalType of SIGNAL_TYPES) {
      const result = await tool.execute({ type: signalType }, ctx);
      expect(result).toBeDefined();
    }
  });

  describe("payload handling (optional, no active functions)", () => {
    it("works without a payload", async () => {
      const result = await tool.execute({ type: "answer" }, ctx);
      expect(result).toBe("signal: answer acknowledged (no active functions)");
    });

    it("works with an explicit payload", async () => {
      const result = await tool.execute(
        { type: "progress", payload: { percent: 50, message: "halfway" } },
        ctx,
      );
      expect(typeof result).toBe("string");
      expect(result).toContain("signal: progress acknowledged");
    });

    it("works with an empty payload", async () => {
      const result = await tool.execute(
        { type: "blocked", payload: {} },
        ctx,
      );
      expect(result).toContain("signal: blocked acknowledged");
    });
  });

  describe("return type is a string", () => {
    for (const signalType of SIGNAL_TYPES) {
      it(`returns a string for type "${signalType}"`, async () => {
        const result = await tool.execute({ type: signalType }, ctx);
        expect(typeof result).toBe("string");
      });
    }
  });

  it("zod schema rejects invalid signal types", () => {
    const result = tool.args.type.safeParse("invalid_signal");
    expect(result.success).toBe(false);
  });

  it("zod schema accepts all valid signal types", () => {
    for (const signalType of SIGNAL_TYPES) {
      const result = tool.args.type.safeParse(signalType);
      expect(result.success).toBe(true);
    }
  });
});

// ── FSM integration tests ────────────────────────────────────────────

describe("signal tool FSM integration", () => {
  let tmpDir: string;
  let sessionID: string;
  const tool = createSignalTool();

  beforeEach(() => {
    sessionID = "fsm-test-session";
    tmpDir = mkdtempSync(join(tmpdir(), "signal-fsm-"));
    functionRuntime.setStoreDirectory(tmpDir);
    functionRuntime.recover();

    // Activate a test function in the FSM
    functionRuntime.init(sessionID, "test-fn", 1);
    functionSessionState.activate(sessionID, ["test-fn"]);
  });

  afterEach(() => {
    functionRuntime.resetAll();
    functionSessionState.clear(sessionID);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records signal 'answer' with payload in the FnState ledger", async () => {
    const ctx = makeContext(sessionID);
    const payload = { data: 42, message: "done" };

    await tool.execute({ type: "answer", payload }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(hasSignal(st!, "answer")).toBe(true);
    expect(getSignalPayload(st!, "answer")).toEqual(payload);
  });

  it("signal 'answer' satisfies continue_until signal_observed(answer)", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "answer" }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(hasSignal(st!, "answer")).toBe(true);

    // The signal_observed condition should now return true
    const { evaluateCondition } = await import("../../src/function/conditions.ts");
    const env = {
      sessionID,
      fnName: "test-fn",
      state: st!,
      artifacts: new (await import("../../src/function/artifact-store.ts")).ArtifactStore(tmpDir),
      requiredEvidence: [] as string[],
      userMessagedThisTurn: false,
      workspaceDir: tmpDir,
    };
    expect(evaluateCondition("signal_observed(answer)", env)).toBe(true);
  });

  it("signal 'need_approval' sets paused evidence and gated phase", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "need_approval" }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved["paused"]).toBe(true);
    expect(st!.phase).toBe("gated");
  });

  it("signal 'blocked' sets paused evidence and gated phase", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "blocked" }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved["paused"]).toBe(true);
    expect(st!.phase).toBe("gated");
  });

  it("signal 'need_clarification' sets paused evidence and gated phase", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "need_clarification" }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved["paused"]).toBe(true);
    expect(st!.phase).toBe("gated");
  });

  it("signal 'progress' is informational and does NOT set paused evidence", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "progress", payload: { percent: 50 } }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(hasSignal(st!, "progress")).toBe(true);
    expect(getSignalPayload(st!, "progress")).toEqual({ percent: 50 });
    // progress must NOT set paused or change phase
    expect(st!.evidenceObserved["paused"]).toBeUndefined();
    expect(st!.phase).toBe("active"); // default phase
  });

  it("signal 'handoff' records target in ledger", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute(
      { type: "handoff", payload: { target: "backend", context: { task: "fix-bug" } } },
      ctx,
    );

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(hasSignal(st!, "handoff")).toBe(true);
    expect(getSignalPayload(st!, "handoff")).toEqual({ target: "backend", context: { task: "fix-bug" } });
  });

  it("signal 'escalate' records with payload", async () => {
    const ctx = makeContext(sessionID);
    const payload = { reason: "unrecoverable error", failed_attempts: 3 };

    await tool.execute({ type: "escalate", payload }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(hasSignal(st!, "escalate")).toBe(true);
    expect(getSignalPayload(st!, "escalate")).toEqual(payload);
  });

  it("multiple signal types accumulate in the ledger", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "progress", payload: { pct: 25 } }, ctx);
    await tool.execute({ type: "answer", payload: { result: "ok" } }, ctx);
    await tool.execute({ type: "need_approval", payload: { reason: "review" } }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(hasSignal(st!, "progress")).toBe(true);
    expect(hasSignal(st!, "answer")).toBe(true);
    expect(hasSignal(st!, "need_approval")).toBe(true);
    expect(getSignalPayload(st!, "progress")).toEqual({ pct: 25 });
    expect(getSignalPayload(st!, "answer")).toEqual({ result: "ok" });
    expect(getSignalPayload(st!, "need_approval")).toEqual({ reason: "review" });
  });

  it("later signal overwrites earlier payload for same type", async () => {
    const ctx = makeContext(sessionID);

    await tool.execute({ type: "answer", payload: { attempt: 1 } }, ctx);
    await tool.execute({ type: "answer", payload: { attempt: 2 } }, ctx);

    const st = functionRuntime.get(sessionID, "test-fn");
    expect(st).toBeDefined();
    expect(getSignalPayload(st!, "answer")).toEqual({ attempt: 2 });
  });

  it("signal recorded on all active functions", async () => {
    const ctx = makeContext(sessionID);
    functionRuntime.init(sessionID, "second-fn", 1);
    functionSessionState.activate(sessionID, ["second-fn"]);

    await tool.execute({ type: "answer", payload: { broadcast: true } }, ctx);

    const st1 = functionRuntime.get(sessionID, "test-fn");
    const st2 = functionRuntime.get(sessionID, "second-fn");
    expect(st1).toBeDefined();
    expect(st2).toBeDefined();
    expect(hasSignal(st1!, "answer")).toBe(true);
    expect(hasSignal(st2!, "answer")).toBe(true);
    expect(getSignalPayload(st1!, "answer")).toEqual({ broadcast: true });
    expect(getSignalPayload(st2!, "answer")).toEqual({ broadcast: true });
  });
});

// ── Signal ledger standalone unit tests ──────────────────────────────

describe("signal-ledger", () => {
  let state: FnState;

  beforeEach(() => {
    state = {
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
    };
  });

  it("recordSignal stores type→payload entry", () => {
    recordSignal(state, "answer", { data: 1 });
    expect(hasSignal(state, "answer")).toBe(true);
    expect(getSignalPayload(state, "answer")).toEqual({ data: 1 });
  });

  it("recordSignal stores null payload when none provided", () => {
    recordSignal(state, "progress");
    expect(hasSignal(state, "progress")).toBe(true);
    expect(getSignalPayload(state, "progress")).toBeNull();
  });

  it("hasSignal returns false for unrecorded type", () => {
    expect(hasSignal(state, "answer")).toBe(false);
  });

  it("getSignalPayload returns undefined for unrecorded type", () => {
    expect(getSignalPayload(state, "nonexistent")).toBeUndefined();
  });

  it("multiple signal types coexist in ledger", () => {
    recordSignal(state, "answer", { ok: true });
    recordSignal(state, "progress", { pct: 50 });
    recordSignal(state, "need_approval", { reason: "check" });

    expect(hasSignal(state, "answer")).toBe(true);
    expect(hasSignal(state, "progress")).toBe(true);
    expect(hasSignal(state, "need_approval")).toBe(true);
    expect(getSignalPayload(state, "answer")).toEqual({ ok: true });
    expect(getSignalPayload(state, "progress")).toEqual({ pct: 50 });
    expect(getSignalPayload(state, "need_approval")).toEqual({ reason: "check" });
  });

  it("overwrites existing payload on re-record", () => {
    recordSignal(state, "answer", { v1: true });
    recordSignal(state, "answer", { v2: true });
    expect(getSignalPayload(state, "answer")).toEqual({ v2: true });
  });
});

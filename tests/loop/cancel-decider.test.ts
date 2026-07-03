import { describe, it, expect } from "bun:test";
import { shouldCancelLoop } from "../../src/loop/coordinator";
import {
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
} from "../../src/dispatch/notification";
import { LOOP_PROGRESS_MARKER, STOP_LOOP_SIGNAL } from "../../src/loop/constants";
import type { LoopState } from "../../src/loop/types";

// ── helpers ────────────────────────────────────────────────────────

type Phase = LoopState["phase"];

function mockLoopState(phase: Phase, overrides?: Partial<LoopState>): LoopState {
  return {
    originSessionId: "origin-1",
    agent: "test-agent",
    basePrompt: "do the loop",
    mode: "fresh",
    total: 5,
    current: 2,
    phase,
    cancelRequested: false,
    startedAt: Date.now() - 30000,
    updatedAt: Date.now(),
    roundStartedAt: Date.now() - 15000,
    schemaVersion: 1,
    ...overrides,
  };
}

// ── system re-prompt (dispatch markers) ────────────────────────────

describe("shouldCancelLoop — dispatch system re-prompts", () => {
  const markers = [
    DISPATCH_COMPLETION_MARKER,
    DISPATCH_ALL_COMPLETE_MARKER,
    DISPATCH_RECOVERY_MARKER,
  ];

  for (const marker of markers) {
    it(`${marker} during awaiting_worker → false`, () => {
      const state = mockLoopState("awaiting_worker");
      expect(shouldCancelLoop(state, marker)).toBe(false);
    });

    it(`${marker} during summarizing → false`, () => {
      const state = mockLoopState("summarizing");
      expect(shouldCancelLoop(state, marker)).toBe(false);
    });

    it(`${marker} during dispatching → false`, () => {
      const state = mockLoopState("dispatching");
      expect(shouldCancelLoop(state, marker)).toBe(false);
    });
  }

  it("dispatch marker embedded in <system-reminder> XML → false", () => {
    const state = mockLoopState("awaiting_worker");
    const msg = [
      "<system-reminder>",
      DISPATCH_COMPLETION_MARKER,
      "**ID:** task-123",
      "**Status:** completed",
      "</system-reminder>",
    ].join("\n");
    expect(shouldCancelLoop(state, msg)).toBe(false);
  });

  it("ALL_COMPLETE with noReply:false re-prompt → false", () => {
    const state = mockLoopState("awaiting_worker");
    const msg = [
      "<system-reminder>",
      DISPATCH_ALL_COMPLETE_MARKER,
      "All background tasks have finished.",
      "</system-reminder>",
    ].join("\n");
    expect(shouldCancelLoop(state, msg)).toBe(false);
  });
});

// ── auto-continue injections ───────────────────────────────────────

describe("shouldCancelLoop — auto-continue", () => {
  it("[auto-continue during awaiting_worker → false", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "[auto-continue] continue from round")).toBe(false);
  });

  it("[auto-continue during dispatching → false", () => {
    const state = mockLoopState("dispatching");
    expect(shouldCancelLoop(state, "[auto-continue round 2")).toBe(false);
  });
});

// ── loop-progress markers ──────────────────────────────────────────

describe("shouldCancelLoop — loop-progress markers", () => {
  it("loop-progress during awaiting_worker → false", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "[loop-progress round 1/5 done]")).toBe(false);
  });

  it("loop-progress during summarizing → false", () => {
    const state = mockLoopState("summarizing");
    expect(shouldCancelLoop(state, "[loop-progress loop cancelled]")).toBe(false);
  });
});

// ── explicit stop-loop signal ──────────────────────────────────────

describe("shouldCancelLoop — stop-loop signal", () => {
  it("stop-loop signal during awaiting_worker → true", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, STOP_LOOP_SIGNAL)).toBe(true);
  });

  it("stop-loop signal during dispatching → true", () => {
    const state = mockLoopState("dispatching");
    expect(shouldCancelLoop(state, STOP_LOOP_SIGNAL)).toBe(true);
  });

  it("stop-loop signal embedded in longer message → true", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, `please ${STOP_LOOP_SIGNAL} now`)).toBe(true);
  });
});

// ── plain human messages no longer cancel ──────────────────────────

describe("shouldCancelLoop — plain human messages (no cancel)", () => {
  it("plain human message during awaiting_worker → false", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "stop the loop please")).toBe(false);
  });

  it("plain human message during dispatching → false", () => {
    const state = mockLoopState("dispatching");
    expect(shouldCancelLoop(state, "cancel everything")).toBe(false);
  });

  it("human message containing 'cancel' during awaiting_worker → false", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "I want to cancel this loop")).toBe(false);
  });
});

// ── human messages during origin-owned phases → no cancel ──────────

describe("shouldCancelLoop — origin-owned phases", () => {
  it("human message during activating → false", () => {
    const state = mockLoopState("activating");
    expect(shouldCancelLoop(state, "cancel the loop")).toBe(false);
  });

  it("human message during summarizing → false", () => {
    const state = mockLoopState("summarizing");
    expect(shouldCancelLoop(state, "stop it")).toBe(false);
  });

  it("human message during finalizing → false", () => {
    const state = mockLoopState("finalizing");
    expect(shouldCancelLoop(state, "cancel now")).toBe(false);
  });
});

// ── terminal phases → never cancel ─────────────────────────────────

describe("shouldCancelLoop — terminal phases", () => {
  const terminals: Phase[] = ["complete", "cancelled", "interrupted", "error"];

  for (const phase of terminals) {
    it(`human message during ${phase} → false`, () => {
      const state = mockLoopState(phase);
      expect(shouldCancelLoop(state, "stop the loop")).toBe(false);
    });

    it(`dispatch marker during ${phase} → false`, () => {
      const state = mockLoopState(phase);
      expect(shouldCancelLoop(state, DISPATCH_COMPLETION_MARKER)).toBe(false);
    });

    it(`auto-continue during ${phase} → false`, () => {
      const state = mockLoopState(phase);
      expect(shouldCancelLoop(state, "[auto-continue] next round")).toBe(false);
    });
  }
});

// ── edge cases ─────────────────────────────────────────────────────

describe("shouldCancelLoop — edge cases", () => {
  it("empty message during awaiting_worker → false (no stop signal)", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "")).toBe(false);
  });

  it("whitespace-only message during awaiting_worker → false", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "   ")).toBe(false);
  });

  it("stop signal during terminal phase → false", () => {
    const state = mockLoopState("complete");
    expect(shouldCancelLoop(state, STOP_LOOP_SIGNAL)).toBe(false);
  });

  it("stop signal during origin-owned phase → false", () => {
    const state = mockLoopState("activating");
    expect(shouldCancelLoop(state, STOP_LOOP_SIGNAL)).toBe(false);
  });
});

// ── LOOP_PROGRESS_MARKER as prefix ─────────────────────────────────

describe("shouldCancelLoop — LOOP_PROGRESS_MARKER prefix", () => {
  it("matches LOOP_PROGRESS_MARKER anywhere in message → false", () => {
    const state = mockLoopState("awaiting_worker");
    expect(shouldCancelLoop(state, "[loop-progress")).toBe(false);
    expect(shouldCancelLoop(state, `status: ${LOOP_PROGRESS_MARKER} round 2 done]`)).toBe(false);
  });
});

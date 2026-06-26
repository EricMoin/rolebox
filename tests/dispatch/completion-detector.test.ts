import { describe, it, expect } from "bun:test";
import { detectCompletion, extractAssistantError } from "../../src/dispatch/completion-detector.ts";
import type { SessionMessageSnapshot, TaskPollState } from "../../src/dispatch/types.ts";

// ── Test Helpers ──────────────────────────────────────────────────────

function msg(overrides: Partial<SessionMessageSnapshot["info"]> = {}, parts: SessionMessageSnapshot["parts"] = []): SessionMessageSnapshot {
  return {
    info: {
      role: "assistant",
      id: "msg_1",
      ...overrides,
    },
    parts,
  };
}

function pollState(overrides: Partial<TaskPollState> = {}): TaskPollState {
  return {
    consecutiveMissedPolls: 0,
    stableIdlePolls: 3,
    lastMessageCount: 1,
    lastProgressUpdate: Date.now(),
    hasProducedOutput: true,
    ...overrides,
  };
}

function idle() {
  return { type: "idle" as const };
}

// ── detectCompletion ─────────────────────────────────────────────────

describe("detectCompletion", () => {
  // ── Terminal / Successful Completion ──────────────────────────────

  it("returns completed when finish is end_turn, no pending tools, and stable polls are sufficient", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed with stableIdlePolls exactly at threshold", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed with stableIdlePolls above threshold", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      pollState({ stableIdlePolls: 5 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Session Status Gates ──────────────────────────────────────────

  it("returns not_ready when sessionStatus is undefined", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      undefined,
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when session is busy", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      { type: "busy" },
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when session is retry", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      { type: "retry" },
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns completed for unexpected session status (treated as idle-like)", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      { type: "unknown_status" },
      pollState(),
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Missing / Incomplete Messages ─────────────────────────────────

  it("returns not_ready when messages array is empty", () => {
    const result = detectCompletion([], idle(), pollState());
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when no assistant message exists in messages", () => {
    const result = detectCompletion(
      [{ info: { role: "user", id: "u1" }, parts: [] }],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  // ── Error Detection ───────────────────────────────────────────────

  it("returns error when last assistant has info.error set", () => {
    const result = detectCompletion(
      [msg({ error: "model rate-limited" })],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "error", message: "model rate-limited" });
  });

  it("returns error with extracted message from error object", () => {
    const result = detectCompletion(
      [msg({ error: { message: "context length exceeded" } })],
      idle(),
      pollState(),
    );
    expect(result).toEqual({
      type: "error",
      message: "context length exceeded",
    });
  });

  // ── Non-Terminal Finish Reasons ────────────────────────────────────

  it("returns not_ready when finish is tool-calls", () => {
    const result = detectCompletion(
      [msg({ finish: "tool-calls" })],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns completed when finish is stop (OpenAI-style terminal)", () => {
    const result = detectCompletion(
      [msg({ finish: "stop" })],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed when finish is length (session idle with output)", () => {
    const result = detectCompletion(
      [msg({ finish: "length" })],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed when finish is unknown (session idle with output)", () => {
    const result = detectCompletion(
      [msg({ finish: "unknown" })],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed when finish is undefined (session idle with output)", () => {
    const result = detectCompletion(
      [msg({})], // no finish field
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Tool Execution Guard ───────────────────────────────────────────

  it("returns not_ready when a tool part has state pending", () => {
    const result = detectCompletion(
      [
        msg({ finish: "end_turn" }, [
          { type: "tool", state: "pending" },
        ]),
      ],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when a tool part has state running", () => {
    const result = detectCompletion(
      [
        msg({ finish: "end_turn" }, [
          { type: "tool", state: "running" },
        ]),
      ],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("ignores non-tool parts when checking tool state", () => {
    const result = detectCompletion(
      [
        msg({ finish: "end_turn" }, [
          { type: "text", text: "done" },
        ]),
      ],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("allows completed tools (state complete) through", () => {
    const result = detectCompletion(
      [
        msg({ finish: "end_turn" }, [
          { type: "tool", state: "complete" },
        ]),
      ],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Stability Gating ──────────────────────────────────────────────

  it("returns stabilizing when stable idle polls are below threshold", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      pollState({ stableIdlePolls: 1 }),
    );
    expect(result).toEqual({ type: "stabilizing" });
  });

  it("returns stabilizing at threshold minus one", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      pollState({ stableIdlePolls: 2 }),
    );
    expect(result).toEqual({ type: "stabilizing" });
  });

  it("returns completed at exact threshold", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Multi-message Scenarios ────────────────────────────────────────

  it("uses the last assistant message when multiple exist", () => {
    const result = detectCompletion(
      [
        msg({ id: "first", finish: "tool-calls" }),
        msg({ id: "last", finish: "end_turn" }),
      ],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("detects error on last assistant even when earlier messages were fine", () => {
    const result = detectCompletion(
      [
        msg({ id: "first", finish: "end_turn" }),
        msg({ id: "last", error: "final message errored" }),
      ],
      idle(),
      pollState(),
    );
    expect(result).toEqual({ type: "error", message: "final message errored" });
  });

  it("skips non-assistant messages when scanning for last assistant", () => {
    const result = detectCompletion(
      [
        { info: { role: "user", id: "u1" }, parts: [] },
        { info: { role: "user", id: "u2" }, parts: [] },
        msg({ finish: "end_turn" }),
      ],
      idle(),
      pollState({ stableIdlePolls: 3 }),
    );
    expect(result).toEqual({ type: "completed" });
  });
});

// ── extractAssistantError ─────────────────────────────────────────────

describe("extractAssistantError", () => {
  it("returns Unknown error for falsy values", () => {
    expect(extractAssistantError(null)).toBe("Unknown error");
    expect(extractAssistantError(undefined)).toBe("Unknown error");
    expect(extractAssistantError(false)).toBe("Unknown error");
    expect(extractAssistantError(0)).toBe("Unknown error");
    expect(extractAssistantError("")).toBe("Unknown error");
  });

  it("returns the string directly when input is a string", () => {
    expect(extractAssistantError("API error")).toBe("API error");
    expect(extractAssistantError("timeout")).toBe("timeout");
  });

  it("returns error.message for Error instances", () => {
    expect(extractAssistantError(new Error("something broke"))).toBe(
      "something broke",
    );
  });

  it("returns obj.message when input is an object with message field", () => {
    expect(extractAssistantError({ message: "fail" })).toBe("fail");
  });

  it("returns obj.error when input has error field but no message", () => {
    expect(extractAssistantError({ error: "something went wrong" })).toBe(
      "something went wrong",
    );
  });

  it("prefers obj.message over obj.error when both exist", () => {
    expect(
      extractAssistantError({ message: "msg field", error: "err field" }),
    ).toBe("msg field");
  });

  it("JSON-stringifies objects without message or error fields", () => {
    const result = extractAssistantError({ code: 500, detail: "internal" });
    expect(result).toBe(JSON.stringify({ code: 500, detail: "internal" }));
  });

  it("converts numbers to strings", () => {
    expect(extractAssistantError(42)).toBe("42");
  });

  it("converts booleans to strings", () => {
    expect(extractAssistantError(true)).toBe("true");
  });
});

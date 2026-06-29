import { describe, it, expect } from "bun:test";
import { detectCompletion, extractAssistantError } from "../../src/dispatch/completion-detector.ts";
import type { SessionMessageSnapshot, TaskEventState } from "../../src/dispatch/types.ts";

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

function eventState(overrides: Partial<TaskEventState> = {}): TaskEventState {
  return {
    lastMessageCount: 1,
    lastProgressUpdate: Date.now(),
    hasProducedOutput: true,
    messageCountAtStart: 0,
    lastEventAt: Date.now(),
    ...overrides,
  };
}

function idle() {
  return { type: "idle" as const };
}

// ── detectCompletion ─────────────────────────────────────────────────

describe("detectCompletion", () => {
  // ── Terminal / Successful Completion ──────────────────────────────

  it("returns completed when finish is end_turn, no pending tools, and skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Session Status Gates ──────────────────────────────────────────

  it("treats absent session status as idle-equivalent: completed with output + skipStabilityGating (regression: task hung, parent never notified)", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      undefined,
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("treats absent session status as idle-equivalent: stabilizing without skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      undefined,
      eventState(),
    );
    expect(result).toEqual({ type: "stabilizing" });
  });

  it("returns not_ready when session status absent and no assistant output (startup guard)", () => {
    const result = detectCompletion(
      [],
      undefined,
      eventState({ hasProducedOutput: false }),
      true,
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when session is busy", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      { type: "busy" },
      eventState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when session is retry", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      { type: "retry" },
      eventState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns completed for unexpected session status (treated as idle-like) with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      { type: "unknown_status" },
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Missing / Incomplete Messages ─────────────────────────────────

  it("returns not_ready when messages array is empty", () => {
    const result = detectCompletion([], idle(), eventState());
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns not_ready when no assistant message exists in messages", () => {
    const result = detectCompletion(
      [{ info: { role: "user", id: "u1" }, parts: [] }],
      idle(),
      eventState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  // ── Error Detection ───────────────────────────────────────────────

  it("returns error when last assistant has info.error set", () => {
    const result = detectCompletion(
      [msg({ error: "model rate-limited" })],
      idle(),
      eventState(),
    );
    expect(result).toEqual({ type: "error", message: "model rate-limited" });
  });

  it("returns error with extracted message from error object", () => {
    const result = detectCompletion(
      [msg({ error: { message: "context length exceeded" } })],
      idle(),
      eventState(),
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
      eventState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("returns completed when finish is stop (OpenAI-style terminal) with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "stop" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed when finish is length (session idle with output) with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "length" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed when finish is unknown (session idle with output) with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({ finish: "unknown" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("returns completed when finish is undefined (session idle with output) with skipStabilityGating", () => {
    const result = detectCompletion(
      [msg({})], // no finish field
      idle(),
      eventState(),
      true,
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
      eventState(),
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
      eventState(),
    );
    expect(result).toEqual({ type: "not_ready" });
  });

  it("ignores non-tool parts when checking tool state with skipStabilityGating", () => {
    const result = detectCompletion(
      [
        msg({ finish: "end_turn" }, [
          { type: "text", text: "done" },
        ]),
      ],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  it("allows completed tools (state complete) through with skipStabilityGating", () => {
    const result = detectCompletion(
      [
        msg({ finish: "end_turn" }, [
          { type: "tool", state: "complete" },
        ]),
      ],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Stability Gating ──────────────────────────────────────────────

  it("returns stabilizing when stability gating is not skipped (default)", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      eventState(),
    );
    expect(result).toEqual({ type: "stabilizing" });
  });

  it("returns stabilizing when skipStabilityGating is not passed", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      eventState(),
    );
    expect(result).toEqual({ type: "stabilizing" });
  });

  it("returns completed when skipStabilityGating is explicitly true", () => {
    const result = detectCompletion(
      [msg({ finish: "end_turn" })],
      idle(),
      eventState(),
      true,
    );
    expect(result).toEqual({ type: "completed" });
  });

  // ── Multi-message Scenarios ────────────────────────────────────────

  it("uses the last assistant message when multiple exist with skipStabilityGating", () => {
    const result = detectCompletion(
      [
        msg({ id: "first", finish: "tool-calls" }),
        msg({ id: "last", finish: "end_turn" }),
      ],
      idle(),
      eventState(),
      true,
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
      eventState(),
    );
    expect(result).toEqual({ type: "error", message: "final message errored" });
  });

  it("skips non-assistant messages when scanning for last assistant with skipStabilityGating", () => {
    const result = detectCompletion(
      [
        { info: { role: "user", id: "u1" }, parts: [] },
        { info: { role: "user", id: "u2" }, parts: [] },
        msg({ finish: "end_turn" }),
      ],
      idle(),
      eventState(),
      true,
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

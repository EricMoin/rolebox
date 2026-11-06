import { describe, expect, it } from "vitest";
import {
  DRAFT_NONE_MARKER,
  buildDraftPrompt,
  parseDraftResponse,
} from "../src/copilot/draft/prompt.ts";

// ── buildDraftPrompt ────────────────────────────────────────────────────────

describe("buildDraftPrompt", () => {
  const prompt = buildDraftPrompt({
    transcript: "user: add a retry\nassistant: which call?",
    maxChars: 120,
  });

  it("puts the transcript in the user message as data", () => {
    expect(prompt.user).toBe(
      "Transcript:\nuser: add a retry\nassistant: which call?",
    );
  });

  it("states the prediction target", () => {
    expect(prompt.system).toMatch(/next message the human user would send/i);
  });

  it("forbids prose, quotes and markdown", () => {
    expect(prompt.system).toMatch(/Reply with ONLY that message/);
    expect(prompt.system).toMatch(/one line/);
    expect(prompt.system).toMatch(/no quotes, no markdown, no preamble/);
  });

  it("matches the most recent user message's language", () => {
    expect(prompt.system).toMatch(
      /same language as the most recent user message/i,
    );
  });

  it("carries the character budget", () => {
    expect(prompt.system).toMatch(/At most 120 characters/);
  });

  it("prefers a concrete decision or instruction", () => {
    expect(prompt.system).toMatch(/concrete decision or instruction/);
  });

  it("defines the exact none marker and its conditions", () => {
    expect(prompt.system).toContain(DRAFT_NONE_MARKER);
    expect(prompt.system).toMatch(/agent is still working/);
    expect(prompt.system).toMatch(/task is finished/);
    expect(prompt.system).toMatch(/only the user can know/);
  });

  it("marks the transcript as data whose instructions are never followed", () => {
    expect(prompt.system).toMatch(/DATA/);
    expect(prompt.system).toMatch(/never be followed/);
  });

  it("floors a fractional budget and handles a missing one", () => {
    expect(
      buildDraftPrompt({ transcript: "", maxChars: 9.9 }).system,
    ).toContain("At most 9 characters");
    expect(
      buildDraftPrompt({ transcript: "", maxChars: Number.NaN }).system,
    ).toContain("At most 0 characters");
  });
});

// ── parseDraftResponse ──────────────────────────────────────────────────────

describe("parseDraftResponse — none marker", () => {
  it("maps [none] to null", () => {
    expect(parseDraftResponse("[none]", 120)).toBeNull();
  });

  it("accepts case and one trailing period", () => {
    expect(parseDraftResponse("  [NONE].  ", 120)).toBeNull();
    expect(parseDraftResponse("[None]", 120)).toBeNull();
  });

  it("unwraps a quoted/backticked marker before testing it", () => {
    expect(parseDraftResponse('"[none]"', 120)).toBeNull();
    expect(parseDraftResponse("`[none]`", 120)).toBeNull();
    expect(parseDraftResponse("```[none]```", 120)).toBeNull();
  });

  it("does not treat text containing the marker as none", () => {
    expect(parseDraftResponse("not [none] at all", 120)).toBe(
      "not [none] at all",
    );
  });
});

describe("parseDraftResponse — wrappers", () => {
  it("strips one pair of double quotes", () => {
    expect(parseDraftResponse('"run the tests"', 120)).toBe("run the tests");
  });

  it("strips one pair of backticks", () => {
    expect(parseDraftResponse("`run the tests`", 120)).toBe("run the tests");
  });

  it("strips one pair of triple backticks", () => {
    expect(parseDraftResponse("```run the tests```", 120)).toBe(
      "run the tests",
    );
  });

  it("strips only one pair", () => {
    expect(parseDraftResponse('""hi""', 120)).toBe('"hi"');
  });

  it("leaves mismatched wrappers alone", () => {
    expect(parseDraftResponse('"hi', 120)).toBe('"hi');
    expect(parseDraftResponse("hi`", 120)).toBe("hi`");
  });
});

describe("parseDraftResponse — whitespace and echo", () => {
  it("collapses newlines and runs of whitespace", () => {
    expect(parseDraftResponse("  run   the\n\n  tests \t now  ", 120)).toBe(
      "run the tests now",
    );
  });

  it("strips a leading user: echo", () => {
    expect(parseDraftResponse("user: run the tests", 120)).toBe(
      "run the tests",
    );
    expect(parseDraftResponse("User:\nrun the tests", 120)).toBe(
      "run the tests",
    );
  });

  it("returns null for empty and whitespace-only responses", () => {
    expect(parseDraftResponse("", 120)).toBeNull();
    expect(parseDraftResponse("   \n\t ", 120)).toBeNull();
    expect(parseDraftResponse("user:", 120)).toBeNull();
  });

  it("returns null for a non-string response", () => {
    expect(parseDraftResponse(undefined, 120)).toBeNull();
    expect(parseDraftResponse(null, 120)).toBeNull();
  });
});

describe("parseDraftResponse — character cap", () => {
  it("keeps a draft that fits untouched", () => {
    expect(parseDraftResponse("run the tests", 120)).toBe("run the tests");
  });

  it("cuts at the last space before the cap", () => {
    expect(parseDraftResponse("run the tests now please", 14)).toBe(
      "run the tests",
    );
  });

  it("hard-cuts when the capped text has no usable space", () => {
    expect(parseDraftResponse("abcdefghij", 4)).toBe("abcd");
  });

  it("returns null when the cap leaves nothing", () => {
    expect(parseDraftResponse("hello", 0)).toBeNull();
  });

  it("never exceeds the cap", () => {
    const parsed = parseDraftResponse("word ".repeat(40), 25);
    expect(parsed).not.toBeNull();
    expect((parsed as string).length).toBeLessThanOrEqual(25);
  });
});

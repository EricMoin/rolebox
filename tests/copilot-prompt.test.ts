import { describe, it, expect } from "bun:test";
import { buildVerdictPrompt } from "../src/copilot/prompt.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

const TRANSCRIPT = "user: build the feature\nassistant: done, tests pass";

// ── buildVerdictPrompt ──────────────────────────────────────────────────

describe("buildVerdictPrompt", () => {
  it("stamps the session id into the role-identity header", () => {
    const p = buildVerdictPrompt({ sid: "sess-42", transcript: TRANSCRIPT });

    expect(p).toContain("[copilot-verdict-request]");
    expect(p).toContain("You are the copilot decision-maker for rolebox session sess-42");
    expect(p).toContain("The agent finished its turn and the session is idle.");
    expect(p).toContain(
      "Decide whether to inject a user message on the human's behalf to keep the workflow moving, or hand control back to the human.",
    );
  });

  it("emits the default advisory guidance when guidance is absent", () => {
    const p = buildVerdictPrompt({ sid: "s", transcript: "" });

    expect(p).toContain("## GUIDANCE (advisory)");
    // HITL / destructive-op caution
    expect(p).toContain(
      "When the assistant is asking for human approval (HITL / approval-pending)",
    );
    expect(p).toContain(
      "destructive operation (delete, overwrite, force-push, reset, migration), prefer hand_to_user",
    );
    // trivial-confirmation advance allowance
    expect(p).toContain(
      'When the assistant is blocked on a trivial confirmation or asks "should I continue?"',
    );
    expect(p).toContain("you may advance with a short, factual reply if you are confident");
    // no-fabrication rule
    expect(p).toContain("Never fabricate facts, tool results, or user intent");
    expect(p).toContain("never answer questions that need the human's own knowledge");
  });

  it("fully REPLACES the default guidance when custom guidance is present", () => {
    const custom =
      "Only advance when the last assistant message ends in a question the copilot can answer from the transcript.";

    const p = buildVerdictPrompt({ sid: "s", transcript: "", guidance: custom });

    // Custom text present…
    expect(p).toContain("## GUIDANCE (advisory)");
    expect(p).toContain(custom);
    // …and every line of the default block is gone (replace-if-present).
    expect(p).not.toContain("prefer hand_to_user");
    expect(p).not.toContain("should I continue?");
    expect(p).not.toContain("Never fabricate facts");
    expect(p).not.toContain("approval (HITL");
    expect(p).not.toContain("destructive operation");
  });

  it("embeds the transcript verbatim in the TRANSCRIPT section", () => {
    const p = buildVerdictPrompt({ sid: "s", transcript: TRANSCRIPT });

    expect(p).toContain("## TRANSCRIPT");
    expect(p).toContain(TRANSCRIPT);
  });

  it("embeds an empty transcript without dropping the TRANSCRIPT section", () => {
    const p = buildVerdictPrompt({ sid: "s", transcript: "" });

    expect(p).toContain("## TRANSCRIPT");
    expect(p).toContain("## VERDICT CONTRACT");
  });

  it("emits the verdict contract JSON text verbatim", () => {
    const p = buildVerdictPrompt({ sid: "s", transcript: "" });

    expect(p).toContain("## VERDICT CONTRACT");
    expect(p).toContain("Reply with EXACTLY one JSON object, nothing else");
    expect(p).toContain('{"advance": true|false, "replyText": "<text to inject as the user message, only if advance>"}');
    expect(p).toContain("advance: true -> inject replyText");
    expect(p).toContain("advance: false -> hand control to the human");
  });

  it("keeps the TRANSCRIPT and VERDICT CONTRACT sections when custom guidance replaces the default", () => {
    const p = buildVerdictPrompt({
      sid: "s",
      transcript: TRANSCRIPT,
      guidance: "custom policy",
    });

    expect(p).toContain(TRANSCRIPT);
    expect(p).toContain("## VERDICT CONTRACT");
    expect(p).toContain('"advance": true|false');
    expect(p).not.toContain("prefer hand_to_user");
  });

  it("orders sections: header -> guidance -> transcript -> verdict contract", () => {
    const p = buildVerdictPrompt({ sid: "s", transcript: TRANSCRIPT });

    const header = p.indexOf("[copilot-verdict-request]");
    const guidance = p.indexOf("## GUIDANCE (advisory)");
    const transcript = p.indexOf("## TRANSCRIPT");
    const contract = p.indexOf("## VERDICT CONTRACT");

    expect(header).toBeGreaterThanOrEqual(0);
    expect(guidance).toBeGreaterThan(header);
    expect(transcript).toBeGreaterThan(guidance);
    expect(contract).toBeGreaterThan(transcript);
  });
});

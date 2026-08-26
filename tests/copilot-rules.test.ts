// ── Copilot Rules: Unit Tests ───────────────────────────────────────
//
// Tests src/copilot/rules.ts (evaluateRules + default replies). Pure
// deterministic module — no session/injection side effects. Uses bun:test.
//
// Coverage:
//   1. Regex match (pattern tested against last assistant text)
//   2. Case-insensitive substring match (contains)
//   3. Both-criteria AND semantics (pattern + contains must BOTH match)
//   4. First-match-wins ordering
//   5. Per-action default replies (continue/blocked/done/skip)
//   6. Custom reply override
//   7. skip-consumes-decision vs no-match distinction
//   8. Invalid regex warn-and-skip (no throw, next rule still evaluated)
//   9. Empty rules array → null
//  10. Defensive: no match criteria / non-string input never throws

import { describe, it, expect } from "bun:test";
import {
  evaluateRules,
  DEFAULT_RULE_REPLIES,
  type RuleDecision,
} from "../src/copilot/rules";
import type { CopilotRule } from "../src/copilot/types";

// ── Default replies ─────────────────────────────────────────────────

describe("DEFAULT_RULE_REPLIES", () => {
  it("defines the expected default reply per action", () => {
    expect(DEFAULT_RULE_REPLIES).toEqual({
      continue: "Continue.",
      skip: "",
      blocked: "Blocked — end turn.",
      done: "Produce final output now.",
    });
  });
});

// ── Regex match ─────────────────────────────────────────────────────

describe("evaluateRules — regex (pattern)", () => {
  it("matches a plain regex against the last assistant text", () => {
    const rules: CopilotRule[] = [
      { id: "r1", match: { pattern: "tool.*error" }, action: "continue" },
    ];
    const decision = evaluateRules(rules, "the tool call produced an error now");
    expect(decision).toEqual({
      ruleId: "r1",
      action: "continue",
      reply: "Continue.",
    });
  });

  it("returns null when the regex does not match", () => {
    const rules: CopilotRule[] = [
      { id: "r1", match: { pattern: "\\d+ errors" }, action: "blocked" },
    ];
    expect(evaluateRules(rules, "no numbers here")).toBeNull();
  });

  it("is case-sensitive for regex patterns by default", () => {
    const rules: CopilotRule[] = [
      { id: "r1", match: { pattern: "ERROR" }, action: "blocked" },
    ];
    expect(evaluateRules(rules, "no error present")).toBeNull();
    expect(evaluateRules(rules, "an ERROR occurred")).not.toBeNull();
  });
});

// ── Contains match ──────────────────────────────────────────────────

describe("evaluateRules — contains (substring)", () => {
  it("matches a case-insensitive substring", () => {
    const rules: CopilotRule[] = [
      { id: "r1", match: { contains: "Need More Context" }, action: "done" },
    ];
    const decision = evaluateRules(rules, "I need more context to answer.");
    expect(decision).not.toBeNull();
    expect(decision!.ruleId).toBe("r1");
  });

  it("returns null when the substring is absent", () => {
    const rules: CopilotRule[] = [
      { id: "r1", match: { contains: "budget" }, action: "done" },
    ];
    expect(evaluateRules(rules, "no mention of costs")).toBeNull();
  });
});

// ── Both-criteria AND semantics ─────────────────────────────────────

describe("evaluateRules — pattern + contains (AND)", () => {
  const rules: CopilotRule[] = [
    {
      id: "and1",
      match: { pattern: "^.*tool.*$", contains: "failed" },
      action: "blocked",
    },
  ];

  it("matches when both criteria match", () => {
    expect(evaluateRules(rules, "the tool failed again")).toEqual({
      ruleId: "and1",
      action: "blocked",
      reply: "Blocked — end turn.",
    });
  });

  it("does not match when only the regex matches", () => {
    expect(evaluateRules(rules, "the tool succeeded")).toBeNull();
  });

  it("does not match when only the substring matches", () => {
    expect(evaluateRules(rules, "nothing failed here")).toBeNull();
  });
});

// ── First match wins ────────────────────────────────────────────────

describe("evaluateRules — first match wins", () => {
  it("returns the earliest matching rule in config order", () => {
    const rules: CopilotRule[] = [
      { id: "early", match: { contains: "stop" }, action: "continue" },
      { id: "late", match: { contains: "stop" }, action: "done" },
    ];
    const decision = evaluateRules(rules, "please stop here");
    expect(decision).not.toBeNull();
    expect(decision!.ruleId).toBe("early");
    expect(decision!.action).toBe("continue");
  });

  it("skips non-matching rules and hits the first matching one", () => {
    const rules: CopilotRule[] = [
      { id: "miss", match: { contains: "nope" }, action: "blocked" },
      { id: "hit", match: { contains: "hit" }, action: "done" },
    ];
    const decision = evaluateRules(rules, "hit it");
    expect(decision!.ruleId).toBe("hit");
  });
});

// ── Per-action default replies ──────────────────────────────────────

describe("evaluateRules — default replies per action", () => {
  it("continue defaults to \"Continue.\"", () => {
    const decision = evaluateRules(
      [{ id: "r", match: { contains: "x" }, action: "continue" }],
      "x",
    );
    expect(decision!.reply).toBe("Continue.");
  });

  it("blocked defaults to \"Blocked — end turn.\"", () => {
    const decision = evaluateRules(
      [{ id: "r", match: { contains: "x" }, action: "blocked" }],
      "x",
    );
    expect(decision!.reply).toBe("Blocked — end turn.");
  });

  it("done defaults to \"Produce final output now.\"", () => {
    const decision = evaluateRules(
      [{ id: "r", match: { contains: "x" }, action: "done" }],
      "x",
    );
    expect(decision!.reply).toBe("Produce final output now.");
  });

  it("skip defaults to an empty reply (reply is unused for skip)", () => {
    const decision = evaluateRules(
      [{ id: "r", match: { contains: "x" }, action: "skip" }],
      "x",
    );
    expect(decision!.reply).toBe("");
  });
});

// ── Custom reply override ───────────────────────────────────────────

describe("evaluateRules — custom reply override", () => {
  it("uses the rule's custom reply instead of the default", () => {
    const decision = evaluateRules(
      [{ id: "r", match: { contains: "go" }, action: "continue", reply: "Keep going!" }],
      "go",
    );
    expect(decision!.reply).toBe("Keep going!");
  });

  it("honors a custom reply even on a skip action", () => {
    const decision = evaluateRules(
      [{ id: "r", match: { contains: "go" }, action: "skip", reply: "swallow this" }],
      "go",
    );
    expect(decision).toEqual({
      ruleId: "r",
      action: "skip",
      reply: "swallow this",
    });
  });
});

// ── skip vs no-match distinction ────────────────────────────────────

describe("evaluateRules — skip consumes vs no match", () => {
  it("skip returns a decision (consume) — NOT null", () => {
    const rules: CopilotRule[] = [
      { id: "skip1", match: { contains: "internal" }, action: "skip" },
    ];
    const decision = evaluateRules(rules, "internal processing done");
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("skip");
    expect(decision!.ruleId).toBe("skip1");
  });

  it("no match at all returns null (fall through to next source)", () => {
    const rules: CopilotRule[] = [
      { id: "skip1", match: { contains: "internal" }, action: "skip" },
    ];
    expect(evaluateRules(rules, "unrelated text")).toBeNull();
  });
});

// ── Invalid regex warn-and-skip ─────────────────────────────────────

describe("evaluateRules — invalid regex", () => {
  it("skips a rule with an invalid regex without throwing", () => {
    const rules: CopilotRule[] = [
      { id: "bad", match: { pattern: "([unclosed" }, action: "blocked" },
    ];
    expect(() => evaluateRules(rules, "anything")).not.toThrow();
    expect(evaluateRules(rules, "anything")).toBeNull();
  });

  it("continues evaluating subsequent rules after an invalid regex", () => {
    const rules: CopilotRule[] = [
      { id: "bad", match: { pattern: "([unclosed" }, action: "blocked" },
      { id: "good", match: { contains: "later" }, action: "done" },
    ];
    const decision = evaluateRules(rules, "this comes later");
    expect(decision).not.toBeNull();
    expect(decision!.ruleId).toBe("good");
    expect(decision!.action).toBe("done");
  });

  it("an invalid regex still requires the contains criterion for AND rules", () => {
    // Bad regex → rule is skipped wholesale, even though contains matches.
    const rules: CopilotRule[] = [
      { id: "bad", match: { pattern: "([unclosed", contains: "needle" }, action: "done" },
    ];
    expect(evaluateRules(rules, "a needle in the haystack")).toBeNull();
  });
});

// ── Empty / degenerate inputs ───────────────────────────────────────

describe("evaluateRules — empty and degenerate inputs", () => {
  it("returns null for an empty rules array", () => {
    expect(evaluateRules([], "any text")).toBeNull();
  });

  it("does not throw on non-array rules input", () => {
    expect(() => evaluateRules(undefined as unknown as CopilotRule[], "x")).not.toThrow();
    expect(evaluateRules(undefined as unknown as CopilotRule[], "x")).toBeNull();
  });

  it("does not throw on non-string assistant text", () => {
    const rules: CopilotRule[] = [{ id: "r", match: { contains: "x" }, action: "done" }];
    expect(() => evaluateRules(rules, undefined as unknown as string)).not.toThrow();
    expect(evaluateRules(rules, undefined as unknown as string)).toBeNull();
  });

  it("skips a rule that has no match criteria at all", () => {
    const rules = [
      { id: "nope", match: {}, action: "continue" as const },
      { id: "yes", match: { contains: "hi" }, action: "done" as const },
    ];
    const decision = evaluateRules(rules, "hi there");
    expect(decision).not.toBeNull();
    expect(decision!.ruleId).toBe("yes");
  });
});

// ── Shape contract of the decision ──────────────────────────────────

describe("evaluateRules — decision shape", () => {
  it("returns a decision carrying ruleId, action, and reply", () => {
    const decision = evaluateRules(
      [{ id: "shaped", match: { pattern: "^ok$" }, action: "done" }],
      "ok",
    );
    const keys = decision ? Object.keys(decision).sort() : [];
    expect(keys).toEqual(["action", "reply", "ruleId"]);
    expect(decision).toMatchObject({
      ruleId: "shaped",
      action: "done",
      reply: "Produce final output now.",
    } satisfies Partial<RuleDecision>);
  });
});

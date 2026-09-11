// ── Copilot Config: Unit Tests ──────────────────────────────────────
//
// Tests src/copilot/config.ts (parseCopilotConfig + frozen defaults) and
// src/copilot/types.ts (action vocabulary). Uses bun:test syntax.
//
// Coverage:
//   1. Defaults when the block is absent / empty / non-object
//   2. Field coercion (string → boolean / number)
//   3. Malformed-rule warn-and-skip fallback (missing id, no match criteria)
//   4. Unknown action rejection
//   5. Duplicate rule id deduplication
//   6. LLM defaults (timeout 30000, window_size 20, max_chars 8000,
//      include_tools true) and llm-block validation
//   7. Frozen defaults are never mutated by parsing
//   8. Role-loader integration: a role.yaml with a copilot block loads
//      through discoverRoles without throwing and carries the block

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import {
  parseCopilotConfig,
  DEFAULT_COPILOT_CONFIG,
  DEFAULT_COPILOT_LLM_CONFIG,
  DEFAULT_COPILOT_TRANSCRIPT_CONFIG,
} from "../src/copilot/config";
import { COPILOT_ACTIONS } from "../src/copilot/types";
import { discoverRoles } from "../src/loader/role-loader";

// ── Action vocabulary ────────────────────────────────────────────────

describe("COPILOT_ACTIONS", () => {
  it("defines exactly the four supported actions", () => {
    expect([...COPILOT_ACTIONS]).toEqual(["continue", "skip", "blocked", "done"]);
  });
});

// ── Defaults when block absent / empty ───────────────────────────────

describe("parseCopilotConfig — defaults", () => {
  it("returns defaults for undefined input", () => {
    const config = parseCopilotConfig(undefined);
    expect(config.enabled).toBe(false);
    expect(config.rules).toEqual([]);
    expect(config.llm).toBeUndefined();
  });

  it("returns defaults for null input", () => {
    const config = parseCopilotConfig(null);
    expect(config.enabled).toBe(false);
    expect(config.rules).toEqual([]);
    expect(config.llm).toBeUndefined();
  });

  it("returns defaults for non-object input (string)", () => {
    const config = parseCopilotConfig("nope");
    expect(config.enabled).toBe(false);
    expect(config.rules).toEqual([]);
  });

  it("returns defaults for non-object input (array)", () => {
    const config = parseCopilotConfig([1, 2]);
    expect(config.enabled).toBe(false);
    expect(config.rules).toEqual([]);
  });

  it("returns defaults for an empty object", () => {
    const config = parseCopilotConfig({});
    expect(config.enabled).toBe(false);
    expect(config.rules).toEqual([]);
    expect(config.llm).toBeUndefined();
  });

  it("does not share the frozen default rules array", () => {
    const config = parseCopilotConfig({});
    expect(config.rules).not.toBe(DEFAULT_COPILOT_CONFIG.rules);
    config.rules.push({ id: "x", match: { contains: "a" }, action: "continue" });
    // The frozen default must be untouched
    expect(DEFAULT_COPILOT_CONFIG.rules).toEqual([]);
  });
});

// ── Field coercion ───────────────────────────────────────────────────

describe("parseCopilotConfig — field coercion", () => {
  it('coerces string "true" → boolean true for enabled', () => {
    const config = parseCopilotConfig({ enabled: "true" });
    expect(config.enabled).toBe(true);
  });

  it('coerces string "false" → boolean false for enabled', () => {
    const config = parseCopilotConfig({ enabled: "false" });
    expect(config.enabled).toBe(false);
  });

  it("keeps a boolean enabled as-is", () => {
    expect(parseCopilotConfig({ enabled: true }).enabled).toBe(true);
    expect(parseCopilotConfig({ enabled: false }).enabled).toBe(false);
  });

  it("falls back to default when enabled is an invalid type", () => {
    const config = parseCopilotConfig({ enabled: 42 });
    expect(config.enabled).toBe(false);
  });

  it("coerces numeric strings for llm.max_verdict_timeout_ms", () => {
    const config = parseCopilotConfig({ llm: { role: "verdict", max_verdict_timeout_ms: "45000" } });
    expect(config.llm!.max_verdict_timeout_ms).toBe(45000);
  });

  it("coerces numeric strings for transcript fields", () => {
    const config = parseCopilotConfig({
      llm: {
        role: "verdict",
        transcript: { window_size: "10", max_chars: "4000", include_tools: "false" },
      },
    });
    expect(config.llm!.transcript.window_size).toBe(10);
    expect(config.llm!.transcript.max_chars).toBe(4000);
    expect(config.llm!.transcript.include_tools).toBe(false);
  });
});

// ── Valid rules ──────────────────────────────────────────────────────

describe("parseCopilotConfig — valid rules", () => {
  it("parses a rule with a regex pattern match", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r1", match: { pattern: "^\\[done\\]" }, action: "done", reply: "wrap up" }],
    });
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]).toEqual({
      id: "r1",
      match: { pattern: "^\\[done\\]" },
      action: "done",
      reply: "wrap up",
    });
  });

  it("parses a rule with a contains match", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r2", match: { contains: "TODO" }, action: "continue" }],
    });
    expect(config.rules[0].match.contains).toBe("TODO");
    expect(config.rules[0].reply).toBeUndefined();
  });

  it("parses a rule with both pattern and contains", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r3", match: { pattern: "error", contains: "panic" }, action: "blocked" }],
    });
    expect(config.rules[0].match).toEqual({ pattern: "error", contains: "panic" });
  });

  it("parses all four action values", () => {
    const config = parseCopilotConfig({
      rules: [
        { id: "a", match: { contains: "1" }, action: "continue" },
        { id: "b", match: { contains: "2" }, action: "skip" },
        { id: "c", match: { contains: "3" }, action: "blocked" },
        { id: "d", match: { contains: "4" }, action: "done" },
      ],
    });
    expect(config.rules.map((r) => r.action)).toEqual(["continue", "skip", "blocked", "done"]);
  });
});

// ── Malformed-rule warn-and-skip ─────────────────────────────────────

describe("parseCopilotConfig — malformed rules are skipped", () => {
  it("skips a rule with a missing id", () => {
    const config = parseCopilotConfig({
      rules: [{ match: { contains: "x" }, action: "continue" }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips a rule with a blank id", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "  ", match: { contains: "x" }, action: "continue" }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips a rule with no match criteria (missing match block)", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r1", action: "continue" }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips a rule with an empty match block", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r1", match: {}, action: "continue" }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips a rule with blank pattern/contains strings", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r1", match: { pattern: "", contains: "" }, action: "continue" }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips a non-object rule entry", () => {
    const config = parseCopilotConfig({ rules: ["junk", 42, null] });
    expect(config.rules).toEqual([]);
  });

  it("keeps valid rules and skips malformed ones in the same array", () => {
    const config = parseCopilotConfig({
      rules: [
        { id: "good", match: { contains: "keep" }, action: "continue" },
        { id: "", match: { contains: "bad" }, action: "continue" },
        { id: "no-match", action: "continue" },
        { id: "good2", match: { contains: "keep2" }, action: "done" },
      ],
    });
    expect(config.rules.map((r) => r.id)).toEqual(["good", "good2"]);
  });

  it("drops duplicate rule ids (keeps the first occurrence)", () => {
    const config = parseCopilotConfig({
      rules: [
        { id: "dup", match: { contains: "first" }, action: "continue" },
        { id: "dup", match: { contains: "second" }, action: "done" },
      ],
    });
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].match.contains).toBe("first");
  });

  it("falls back to defaults when rules is not an array", () => {
    const config = parseCopilotConfig({ rules: { id: "not-an-array" } });
    expect(config.rules).toEqual([]);
  });
});

// ── Unknown action rejection ─────────────────────────────────────────

describe("parseCopilotConfig — unknown action rejection", () => {
  it("skips a rule with an unknown action string", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r1", match: { contains: "x" }, action: "fly" }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips a rule with a numeric action", () => {
    const config = parseCopilotConfig({
      rules: [{ id: "r1", match: { contains: "x" }, action: 3 }],
    });
    expect(config.rules).toEqual([]);
  });

  it("skips only the bad rule and keeps the good one", () => {
    const config = parseCopilotConfig({
      rules: [
        { id: "good", match: { contains: "ok" }, action: "skip" },
        { id: "bad", match: { contains: "no" }, action: "teleport" },
      ],
    });
    expect(config.rules.map((r) => r.id)).toEqual(["good"]);
  });
});

// ── LLM defaults ─────────────────────────────────────────────────────

describe("parseCopilotConfig — llm defaults", () => {
  it("applies llm defaults when only role is provided", () => {
    const config = parseCopilotConfig({ llm: { role: "verdict" } });
    expect(config.llm).toBeDefined();
    expect(config.llm!.role).toBe("verdict");
    expect(config.llm!.max_verdict_timeout_ms).toBe(30000);
    expect(config.llm!.transcript).toEqual({
      window_size: 20,
      max_chars: 8000,
      include_tools: true,
    });
    expect(config.llm!.guidance).toBeUndefined();
  });

  it("applies llm defaults for an empty transcript block", () => {
    const config = parseCopilotConfig({ llm: { role: "verdict", transcript: {} } });
    expect(config.llm!.transcript).toEqual({
      window_size: 20,
      max_chars: 8000,
      include_tools: true,
    });
  });

  it("honors explicit llm overrides", () => {
    const config = parseCopilotConfig({
      llm: {
        role: "verdict",
        max_verdict_timeout_ms: 5000,
        guidance: "be terse",
        transcript: { window_size: 5, max_chars: 1000, include_tools: false },
      },
    });
    expect(config.llm).toEqual({
      role: "verdict",
      max_verdict_timeout_ms: 5000,
      guidance: "be terse",
      transcript: { window_size: 5, max_chars: 1000, include_tools: false },
    });
  });

  it("ignores the llm block when role is missing", () => {
    const config = parseCopilotConfig({ llm: { max_verdict_timeout_ms: 1000 } });
    expect(config.llm).toBeUndefined();
  });

  it("ignores the llm block when role is not a string", () => {
    const config = parseCopilotConfig({ llm: { role: 42 } });
    expect(config.llm).toBeUndefined();
  });

  it("ignores a non-object llm block", () => {
    const config = parseCopilotConfig({ llm: "verdict" });
    expect(config.llm).toBeUndefined();
  });

  it("ignores a non-object transcript block", () => {
    const config = parseCopilotConfig({ llm: { role: "verdict", transcript: "big" } });
    expect(config.llm!.transcript).toEqual({
      window_size: 20,
      max_chars: 8000,
      include_tools: true,
    });
  });

  it("does not share the frozen transcript default object", () => {
    const config = parseCopilotConfig({ llm: { role: "verdict" } });
    expect(config.llm!.transcript).not.toBe(DEFAULT_COPILOT_TRANSCRIPT_CONFIG);
    config.llm!.transcript.window_size = 1;
    expect(DEFAULT_COPILOT_TRANSCRIPT_CONFIG.window_size).toBe(20);
  });
});

// ── Frozen defaults ──────────────────────────────────────────────────

describe("defaults are frozen", () => {
  it("DEFAULT_COPILOT_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_COPILOT_CONFIG)).toBe(true);
  });

  it("DEFAULT_COPILOT_LLM_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_COPILOT_LLM_CONFIG)).toBe(true);
  });

  it("DEFAULT_COPILOT_TRANSCRIPT_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_COPILOT_TRANSCRIPT_CONFIG)).toBe(true);
  });
});

// ── Role loader integration ──────────────────────────────────────────

describe("role loader — copilot block", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilot-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a role.yaml containing a copilot block without throwing", async () => {
    const roleDir = join(tmpDir, "copilot-role");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "role.yaml"),
      [
        "name: Copilot Role",
        "description: A role with copilot config",
        "prompt: You are a copilot role.",
        "copilot:",
        "  enabled: true",
        "  rules:",
        "    - id: stop-on-done",
        "      match:",
        "        contains: '[done]'",
        "      action: done",
        "    - id: ask-on-question",
        "      match:",
        "        pattern: '\\?\\s*$'",
        "      action: blocked",
        "  llm:",
        "    role: verdict-agent",
        "    max_verdict_timeout_ms: 15000",
        "    transcript:",
        "      window_size: 10",
        "",
      ].join("\n"),
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("copilot-role")!;
    expect(config.copilot).toBeDefined();
    // Raw block is carried through; full validation happens on consumption
    // via parseCopilotConfig (per-role parsing, pi-extension.ts:245-249 pattern).
    expect(parseCopilotConfig(config.copilot)).toEqual({
      enabled: true,
      rules: [
        { id: "stop-on-done", match: { contains: "[done]" }, action: "done" },
        { id: "ask-on-question", match: { pattern: "\\?\\s*$" }, action: "blocked" },
      ],
      llm: {
        role: "verdict-agent",
        max_verdict_timeout_ms: 15000,
        transcript: { window_size: 10, max_chars: 8000, include_tools: true },
      },
    });
  });

  it("loads roles without a copilot block normally", async () => {
    const roleDir = join(tmpDir, "plain-role");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "role.yaml"),
      "name: Plain\ndescription: No copilot\nprompt: You are plain.\n",
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(1);
    expect(roles.get("plain-role")!.copilot).toBeUndefined();
  });
});

// ── Worked example from docs/copilot.md ───────────────────────────────

describe("docs/copilot.md worked example", () => {
  it("parses the documented example YAML cleanly into the full expected shape", () => {
    // Mirrors the `copilot:` block in docs/copilot.md ("Worked Example").
    // Parsed through js-yaml (the role-loader's YAML path) and then
    // parseCopilotConfig. Any warn-and-skip would change the shape below.
    const block = `copilot:
  enabled: true
  rules:
    - id: done-marker
      match:
        contains: "[done]"
      action: done
      reply: "Wrap up and emit the final result."
    - id: ends-with-question
      match:
        pattern: '\\?\\s*$'
      action: blocked
    - id: stalled
      match:
        pattern: "as of my last knowledge"
        contains: "I cannot"
      action: continue
    - id: inconclusive
      match:
        contains: "inconclusive"
      action: skip
  llm:
    role: copilot-verdict
    max_verdict_timeout_ms: 15000
    guidance: "Prefer hand_to_user when the assistant requests human approval or is about to perform a destructive operation."
    transcript:
      window_size: 10
      max_chars: 4000
      include_tools: true`;
    const raw = (yaml.load(block) as { copilot: unknown }).copilot;

    expect(parseCopilotConfig(raw)).toEqual({
      enabled: true,
      rules: [
        {
          id: "done-marker",
          match: { contains: "[done]" },
          action: "done",
          reply: "Wrap up and emit the final result.",
        },
        { id: "ends-with-question", match: { pattern: "\\?\\s*$" }, action: "blocked" },
        {
          id: "stalled",
          match: { pattern: "as of my last knowledge", contains: "I cannot" },
          action: "continue",
        },
        { id: "inconclusive", match: { contains: "inconclusive" }, action: "skip" },
      ],
      llm: {
        role: "copilot-verdict",
        max_verdict_timeout_ms: 15000,
        guidance:
          "Prefer hand_to_user when the assistant requests human approval or is about to perform a destructive operation.",
        transcript: { window_size: 10, max_chars: 4000, include_tools: true },
      },
    });
  });
});

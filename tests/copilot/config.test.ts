import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import {
  DEFAULT_COPILOT_CONFIG,
  DEFAULT_COPILOT_DRAFT_CONFIG,
  composeCopilotConfig,
  parseCopilotConfig,
  parseCopilotDraftFragment,
} from "../../src/copilot/config.ts";
import { getRootLogger } from "../../src/logger.ts";
import { discoverRoles } from "../../src/loader/role-loader.ts";

// ── Helpers ──────────────────────────────────────────────────────────

const DRAFT_DEFAULTS = {
  enabled: false,
  timeout_ms: 4000,
  max_chars: 120,
  window_size: 40,
  transcript_max_chars: 24_000,
} as const;

/**
 * Capture warnings emitted on the `copilot-config` channel. The transport is
 * attached to the root logger the module-level sub-logger inherits from.
 */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  getRootLogger().attachTransport((entry) => {
    if (entry.channel !== "copilot-config" || entry.level !== "warn") return;
    const message = entry["0"];
    if (typeof message === "string") warnings.push(message);
  });
  return warnings;
}

// ── Defaults when the block is absent / empty ────────────────────────

describe("parseCopilotConfig — defaults", () => {
  it("returns draft defaults for undefined input", () => {
    expect(parseCopilotConfig(undefined)).toEqual({ draft: DRAFT_DEFAULTS });
  });

  it("stays silent when the block is absent", () => {
    const warnings = captureWarnings();

    expect(parseCopilotConfig(undefined)).toEqual({ draft: DRAFT_DEFAULTS });
    expect(warnings).toEqual([]);
  });

  it("returns draft defaults for null input", () => {
    expect(parseCopilotConfig(null)).toEqual({ draft: DRAFT_DEFAULTS });
  });

  it("returns draft defaults for non-object input (string)", () => {
    expect(parseCopilotConfig("nope")).toEqual({ draft: DRAFT_DEFAULTS });
  });

  it("returns draft defaults for non-object input (array)", () => {
    expect(parseCopilotConfig([1, 2])).toEqual({ draft: DRAFT_DEFAULTS });
  });

  it("returns draft defaults for an empty object", () => {
    expect(parseCopilotConfig({})).toEqual({ draft: DRAFT_DEFAULTS });
  });

  it("returns draft defaults for an empty draft block", () => {
    expect(parseCopilotConfig({ draft: {} })).toEqual({ draft: DRAFT_DEFAULTS });
  });

  it("never shares the frozen default objects", () => {
    const a = parseCopilotConfig({});
    const b = parseCopilotConfig({});

    expect(a).not.toBe(b);
    expect(a.draft).not.toBe(b.draft);
    expect(a.draft).not.toBe(DEFAULT_COPILOT_DRAFT_CONFIG);

    a.draft.enabled = true;
    expect(DEFAULT_COPILOT_DRAFT_CONFIG.enabled).toBe(false);
    expect(b.draft.enabled).toBe(false);
  });
});

// ── Field parsing / coercion ─────────────────────────────────────────

describe("parseCopilotConfig — draft fields", () => {
  it('coerces string "true" / "false" for enabled', () => {
    expect(parseCopilotConfig({ draft: { enabled: "true" } }).draft.enabled).toBe(true);
    expect(parseCopilotConfig({ draft: { enabled: "false" } }).draft.enabled).toBe(false);
  });

  it("keeps boolean enabled as-is", () => {
    expect(parseCopilotConfig({ draft: { enabled: true } }).draft.enabled).toBe(true);
    expect(parseCopilotConfig({ draft: { enabled: false } }).draft.enabled).toBe(false);
  });

  it("accepts numeric strings for the bounded fields", () => {
    const config = parseCopilotConfig({
      draft: {
        timeout_ms: "2000",
        max_chars: "80",
        window_size: "12",
        transcript_max_chars: "6000",
      },
    });

    expect(config.draft.timeout_ms).toBe(2000);
    expect(config.draft.max_chars).toBe(80);
    expect(config.draft.window_size).toBe(12);
    expect(config.draft.transcript_max_chars).toBe(6000);
  });

  it("keeps optional non-empty provider and model", () => {
    const config = parseCopilotConfig({
      draft: { provider: "example-provider", model: "example-model" },
    });

    expect(config.draft.provider).toBe("example-provider");
    expect(config.draft.model).toBe("example-model");
  });

  it("omits provider and model when they are absent", () => {
    const config = parseCopilotConfig({ draft: {} });
    expect(config.draft.provider).toBeUndefined();
    expect(config.draft.model).toBeUndefined();
  });
});

// ── Clamps ──────────────────────────────────────────────────────────

describe("parseCopilotConfig — clamps", () => {
  it("clamps every bounded field up to its minimum", () => {
    const config = parseCopilotConfig({
      draft: {
        timeout_ms: 1,
        max_chars: 1,
        window_size: 1,
        transcript_max_chars: 1,
      },
    });

    expect(config.draft.timeout_ms).toBe(200);
    expect(config.draft.max_chars).toBe(16);
    expect(config.draft.window_size).toBe(2);
    expect(config.draft.transcript_max_chars).toBe(500);
  });

  it("clamps every bounded field down to its maximum", () => {
    const config = parseCopilotConfig({
      draft: {
        timeout_ms: 999_999,
        max_chars: 999_999,
        window_size: 999_999,
        transcript_max_chars: 999_999,
      },
    });

    expect(config.draft.timeout_ms).toBe(10_000);
    expect(config.draft.max_chars).toBe(500);
    expect(config.draft.window_size).toBe(200);
    expect(config.draft.transcript_max_chars).toBe(128_000);
  });

  it("honors in-range values", () => {
    const config = parseCopilotConfig({
      draft: {
        timeout_ms: 2500,
        max_chars: 200,
        window_size: 10,
        transcript_max_chars: 8000,
      },
    });

    expect(config.draft).toEqual({
      ...DRAFT_DEFAULTS,
      timeout_ms: 2500,
      max_chars: 200,
      window_size: 10,
      transcript_max_chars: 8000,
    });
  });

  it("clamps numeric strings too", () => {
    const config = parseCopilotConfig({
      draft: { timeout_ms: "50", max_chars: "9000" },
    });

    expect(config.draft.timeout_ms).toBe(200);
    expect(config.draft.max_chars).toBe(500);
  });
});

// ── Legacy keys ─────────────────────────────────────────────────────

describe("parseCopilotConfig — legacy keys warn once and are ignored", () => {
  it("warns exactly once for each removed key", () => {
    const warnings = captureWarnings();

    const config = parseCopilotConfig({
      enabled: true,
      rules: [{ id: "r1", match: { contains: "x" }, action: "continue" }],
      llm: { role: "verdict" },
      draft: { enabled: true },
    });

    expect(warnings).toEqual([
      "copilot.enabled was removed; use copilot.draft",
      "copilot.rules was removed; use copilot.draft",
      "copilot.llm was removed; use copilot.draft",
    ]);
    expect(config).toEqual({ draft: { ...DRAFT_DEFAULTS, enabled: true } });
  });

  it("does not throw for malformed legacy values", () => {
    const warnings = captureWarnings();

    expect(() =>
      parseCopilotConfig({ enabled: 42, rules: "junk", llm: { role: 7 } }),
    ).not.toThrow();

    expect(warnings).toHaveLength(3);
  });

  it("does not warn when no legacy key is present", () => {
    const warnings = captureWarnings();
    parseCopilotConfig({ draft: { enabled: true } });
    expect(warnings).toEqual([]);
  });
});

// ── Malformed input ─────────────────────────────────────────────────

describe("parseCopilotConfig — malformed input falls back safely", () => {
  it("warns and uses defaults when the block is null", () => {
    const warnings = captureWarnings();

    expect(parseCopilotConfig(null)).toEqual({ draft: DRAFT_DEFAULTS });
    expect(warnings).toEqual([
      "Copilot config is not an object (got null); using defaults",
    ]);
  });

  it("names the kind of a null or array block in the warning", () => {
    const warnings = captureWarnings();

    parseCopilotConfig(null);
    parseCopilotConfig([1, 2]);

    expect(warnings).toEqual([
      "Copilot config is not an object (got null); using defaults",
      "Copilot config is not an object (got an array); using defaults",
    ]);
    for (const warning of warnings) expect(warning).toContain("is not an object");
  });

  it("warns for every non-object block except absence", () => {
    const warnings = captureWarnings();

    for (const raw of [null, [1, 2], "nope", 42, true]) {
      expect(parseCopilotConfig(raw)).toEqual({ draft: DRAFT_DEFAULTS });
    }

    expect(warnings).toEqual([
      "Copilot config is not an object (got null); using defaults",
      "Copilot config is not an object (got an array); using defaults",
      "Copilot config is not an object (got string); using defaults",
      "Copilot config is not an object (got number); using defaults",
      "Copilot config is not an object (got boolean); using defaults",
    ]);
  });

  it("warns and uses defaults when draft is not an object", () => {
    const warnings = captureWarnings();

    expect(parseCopilotConfig({ draft: "big" })).toEqual({ draft: DRAFT_DEFAULTS });
    expect(warnings).toEqual(['Invalid "draft" value; expected object, got string']);
  });

  it("warns and keeps the default for an invalid boolean", () => {
    const warnings = captureWarnings();

    expect(parseCopilotConfig({ draft: { enabled: 42 } }).draft.enabled).toBe(false);
    expect(warnings).toEqual(['Invalid "enabled" value; expected boolean, got number']);
  });

  it("warns and keeps the default for a non-numeric value", () => {
    const warnings = captureWarnings();

    const config = parseCopilotConfig({
      draft: { timeout_ms: "fast" },
    });

    expect(config.draft.timeout_ms).toBe(4000);
    expect(warnings).toEqual(['Invalid "timeout_ms" value; expected number, got string']);
  });

  it("warns and omits non-string provider / empty model", () => {
    const warnings = captureWarnings();

    const config = parseCopilotConfig({ draft: { provider: 42, model: "" } });

    expect(config.draft.provider).toBeUndefined();
    expect(config.draft.model).toBeUndefined();
    expect(warnings).toEqual([
      'Invalid "provider" value; expected non-empty string, got number',
      'Invalid "model" value; expected non-empty string, got string',
    ]);
  });
});

// ── Fragment parsing ────────────────────────────────────────────────

describe("parseCopilotDraftFragment — partial block", () => {
  it("keeps only the present, valid fields", () => {
    expect(
      parseCopilotDraftFragment({
        draft: { enabled: true, provider: "example-provider", timeout_ms: 2000 },
      }),
    ).toEqual({ enabled: true, provider: "example-provider", timeout_ms: 2000 });
  });

  it("returns an empty fragment for absent / empty blocks", () => {
    expect(parseCopilotDraftFragment({})).toEqual({});
    expect(parseCopilotDraftFragment({ draft: {} })).toEqual({});
    expect(parseCopilotDraftFragment(undefined)).toEqual({});
  });

  it("stays silent for an absent block but warns for other non-objects", () => {
    const absentWarnings = captureWarnings();

    expect(parseCopilotDraftFragment(undefined)).toEqual({});
    expect(absentWarnings).toEqual([]);

    const malformedWarnings = captureWarnings();

    for (const raw of [null, [1, 2], "nope", 42, true]) {
      expect(parseCopilotDraftFragment(raw)).toEqual({});
    }

    expect(malformedWarnings).toEqual([
      "Copilot config is not an object (got null); using defaults",
      "Copilot config is not an object (got an array); using defaults",
      "Copilot config is not an object (got string); using defaults",
      "Copilot config is not an object (got number); using defaults",
      "Copilot config is not an object (got boolean); using defaults",
    ]);
  });

  it("clamps bounded fields and omits an invalid draft value", () => {
    const warnings = captureWarnings();

    expect(
      parseCopilotDraftFragment({
        draft: { timeout_ms: 1, max_chars: 9000, window_size: 12 },
      }),
    ).toEqual({ timeout_ms: 200, max_chars: 500, window_size: 12 });

    expect(parseCopilotDraftFragment({ draft: "big" })).toEqual({});
    expect(warnings).toEqual([
      'Invalid "draft" value; expected object, got string',
    ]);
  });

  it("treats invalid fields as absent after one warning each", () => {
    const warnings = captureWarnings();

    expect(
      parseCopilotDraftFragment({
        draft: {
          enabled: 42,
          provider: 7,
          model: "",
          max_chars: "fast",
        },
      }),
    ).toEqual({});

    expect(warnings).toEqual([
      'Invalid "enabled" value; expected boolean, got number',
      'Invalid "provider" value; expected non-empty string, got number',
      'Invalid "model" value; expected non-empty string, got string',
      'Invalid "max_chars" value; expected number, got string',
    ]);
  });

  it("warns once per legacy key on the block and ignores it", () => {
    const warnings = captureWarnings();

    expect(
      parseCopilotDraftFragment({
        enabled: true,
        rules: [],
        llm: {},
        draft: { enabled: true },
      }),
    ).toEqual({ enabled: true });
    expect(warnings).toEqual([
      "copilot.enabled was removed; use copilot.draft",
      "copilot.rules was removed; use copilot.draft",
      "copilot.llm was removed; use copilot.draft",
    ]);
  });
});

// ── Composition / precedence ───────────────────────────────────────

describe("composeCopilotConfig — field-level precedence", () => {
  it("lets an earlier fragment win per field", () => {
    const composed = composeCopilotConfig([
      { enabled: true, timeout_ms: 2000 },
      { enabled: false, timeout_ms: 3000, model: "example-model" },
      { max_chars: 80 },
    ]);

    expect(composed.draft).toEqual({
      ...DRAFT_DEFAULTS,
      enabled: true,
      timeout_ms: 2000,
      max_chars: 80,
      model: "example-model",
    });
  });

  it("falls through missing fields to lower-precedence fragments", () => {
    const composed = composeCopilotConfig([
      { enabled: true },
      { provider: "project-provider" },
      { provider: "global-provider", model: "global-model" },
    ]);

    expect(composed.draft.provider).toBe("project-provider");
    expect(composed.draft.model).toBe("global-model");
  });

  it("treats enabled as three-state: present wins, absent inherits, default false", () => {
    expect(composeCopilotConfig([{ enabled: false }, { enabled: true }]).draft.enabled).toBe(false);
    expect(composeCopilotConfig([{ enabled: true }, { enabled: false }]).draft.enabled).toBe(true);
    expect(composeCopilotConfig([{}, { enabled: true }]).draft.enabled).toBe(true);
    expect(composeCopilotConfig([undefined, undefined]).draft.enabled).toBe(false);
  });

  it("lets an invalid higher-precedence value be supplied by a lower source", () => {
    const warnings = captureWarnings();
    const role = parseCopilotDraftFragment({
      draft: { enabled: "maybe", timeout_ms: "fast" },
    });
    expect(role).toEqual({});

    const composed = composeCopilotConfig([
      role,
      { enabled: true, timeout_ms: 2500, provider: "project-provider", model: "project-model" },
    ]);

    expect(composed.draft.enabled).toBe(true);
    expect(composed.draft.timeout_ms).toBe(2500);
    expect(warnings).toEqual([
      'Invalid "enabled" value; expected boolean, got string',
      'Invalid "timeout_ms" value; expected number, got string',
    ]);
  });

  it("ignores undefined fragments and returns fresh objects", () => {
    const a = composeCopilotConfig([undefined, undefined]);
    const b = composeCopilotConfig([undefined, undefined]);

    expect(a).toEqual({ draft: DRAFT_DEFAULTS });
    expect(a).not.toBe(b);
    expect(a.draft).not.toBe(b.draft);
    expect(a.draft).not.toBe(DEFAULT_COPILOT_DRAFT_CONFIG);

    a.draft.enabled = true;
    expect(DEFAULT_COPILOT_DRAFT_CONFIG.enabled).toBe(false);
    expect(b.draft.enabled).toBe(false);
  });

  it("keeps parseCopilotConfig equivalent to the single-fragment composition", () => {
    const raws: unknown[] = [
      undefined,
      null,
      "nope",
      {},
      { draft: {} },
      { draft: { enabled: true, provider: "example-provider", model: "example-model" } },
      { draft: { timeout_ms: 50, max_chars: "9000" } },
      { draft: "big" },
      { enabled: true, rules: "junk", draft: { enabled: false } },
    ];

    for (const raw of raws) {
      expect(parseCopilotConfig(raw)).toEqual(
        composeCopilotConfig([parseCopilotDraftFragment(raw)]),
      );
    }
  });
});

// ── Frozen defaults ─────────────────────────────────────────────────

describe("defaults are frozen", () => {
  it("DEFAULT_COPILOT_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_COPILOT_CONFIG)).toBe(true);
  });

  it("DEFAULT_COPILOT_DRAFT_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_COPILOT_DRAFT_CONFIG)).toBe(true);
  });
});

// ── Role loader integration ─────────────────────────────────────────

describe("role loader — copilot.draft block", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "copilot-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a role.yaml containing a draft block and parses it", async () => {
    const roleDir = join(tmpDir, "draft-role");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "role.yaml"),
      [
        "name: Draft Role",
        "description: A role with a copilot draft block",
        "prompt: You are a draft role.",
        "copilot:",
        "  draft:",
        "    enabled: true",
        "    provider: example-provider",
        "    model: example-model",
        "    timeout_ms: 2000",
        "    max_chars: 200",
        "    window_size: 10",
        "    transcript_max_chars: 8000",
        "",
      ].join("\n"),
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(1);

    const config = roles.get("draft-role")!;
    expect(config.copilot).toBeDefined();
    expect(parseCopilotConfig(config.copilot)).toEqual({
      draft: {
        enabled: true,
        provider: "example-provider",
        model: "example-model",
        timeout_ms: 2000,
        max_chars: 200,
        window_size: 10,
        transcript_max_chars: 8000,
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

// ── YAML worked example ─────────────────────────────────────────────

describe("copilot.draft YAML example", () => {
  it("parses a documented-style YAML block with defaults and clamps", () => {
    const block = `copilot:
  draft:
    enabled: true
    timeout_ms: 50
    max_chars: 80
    window_size: 12`;
    const raw = (yaml.load(block) as { copilot: unknown }).copilot;

    expect(parseCopilotConfig(raw)).toEqual({
      draft: {
        enabled: true,
        timeout_ms: 200,
        max_chars: 80,
        window_size: 12,
        transcript_max_chars: 24_000,
      },
    });
  });
});

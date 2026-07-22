/**
 * Tests for the model resolver (src/resolver/model-resolver.ts).
 *
 * Covers 18 unit tests + 9 integration tests as defined in the
 * model-placeholder-fallback strategy (Step 6):
 *
 * Unit tests (resolveModel / initModelResolver / loadModelAliases):
 *   1.  Known model → passthrough unchanged, no log
 *   2.  Model in aliases → resolved to aliased value
 *   3.  Model matches BOTH known + alias → known takes priority
 *   4.  Neither known nor aliased → passthrough + info log
 *   5.  Empty model string → passthrough, no log
 *   6.  Alias file missing → empty aliases, resolution falls through
 *   7.  Alias file malformed YAML → warn + empty aliases
 *   8.  Not initialized → warn + passthrough
 *   9.  initModelResolver called twice → always reloads from disk
 *  10.  initModelResolver with different configDir → reloads from new dir
 *  11.  Cache isolation via __resetForTest
 *  12.  Known models config missing → scanAvailableModels returns [], only aliases
 *  13.  Alias key is empty string → warn, skipped
 *  14.  Alias value is null → warn, skipped
 *  15.  Alias value is numeric → warn, skipped
 *  16.  Alias value is empty string → warn, skipped
 *  17.  Alias value is an array → warn, skipped
 *  18.  Valid aliases mixed with invalid entries → valid work, invalid skipped
 *
 * Integration tests (end-to-end via discoverRoles / bootstrapRoles):
 *   I1. Role with explicit model resolved via known models
 *   I2. Role without model field → model is absent/undefined
 *   I3. Inline subagent with explicit model resolved via alias
 *   I4. Nested subagent (3-levels) with alias at each level
 *   I5. File-based subagent with alias
 *   I6. Inline subagent without model inherits resolved parent model
 *   I7. File-based subagent without model inherits resolved parent model
 *   I8. Single-hop alias chain: A→B and B→C → resolveModel("A") returns "B"
 *   I9. Bootstrap-level init: bootstrapRoles() resolves model without explicit
 *       initModelResolver call
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Bun v1.3.14: override any stale mock.module(".../cli/model-utils", ...) leaked
// from sync.test.ts (which mocks scanAvailableModels → () => []).
mock.module("../src/cli/model-utils", () => ({
  ...require("../src/cli/model-utils"),
}));

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initModelResolver,
  resolveModel,
  __setLoggerForTest,
  __resetForTest,
} from "../src/resolver/model-resolver";
import { createSubLogger } from "../src/logger";

// ── Mock logger (captures warn + info into separate arrays) ──────────────

let capturedWarns: unknown[][] = [];
let capturedInfos: unknown[][] = [];

const mockLogger = {
  warn: (...args: unknown[]) => { capturedWarns.push(args); },
  info: (...args: unknown[]) => { capturedInfos.push(args); },
  debug: () => {},
  error: () => {},
  silly: () => {},
  trace: () => {},
  fatal: () => {},
  getSubLogger: () => ({} as never),
  attachTransport: () => {},
} as any;

beforeEach(() => {
  capturedWarns = [];
  capturedInfos = [];
  __resetForTest();
  __setLoggerForTest(mockLogger);
});

// ── Fixture helpers ──────────────────────────────────────────────────────

/**
 * Bare-bones opencode.jsonc with one provider + multiple models.
 *
 * The real `scanAvailableModels()` reads:
 *   provider.{providerKey}.models.{modelKey}
 * — note the extra `.models` nesting level (matching the opencode.jsonc schema).
 */
const OPencodeJsonc = (extraProvider?: string) => `{
  "provider": {
    "test-provider": {
      "models": {
        "model-one": { "name": "Model One" },
        "model-two": { "name": "Model Two" }
      }
    }${
      extraProvider
        ? `,\n    "extra-provider": {\n      "models": {\n        "extra-model": { "name": "Extra" }\n      }\n    }`
        : ""
    }
  }
}`;

/** Write {dir}/role_config.yaml with the given aliases object as YAML. */
function writeAliasYaml(dir: string, aliases: Record<string, unknown>): void {
  const lines = ["model_aliases:"];
  for (const [key, value] of Object.entries(aliases)) {
    if (value === null) {
      lines.push(`  ${JSON.stringify(key)}: null`);
    } else if (Array.isArray(value)) {
      lines.push(`  ${JSON.stringify(key)}:`);
      for (const item of value) {
        lines.push(`    - ${JSON.stringify(item)}`);
      }
    } else if (typeof value === "string") {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${value}`);
    }
  }
  writeFileSync(join(dir, "role_config.yaml"), lines.join("\n") + "\n", "utf-8");
}

function setupConfigDir(
  opencodeContent?: string,
  aliases?: Record<string, unknown>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "rolebox-mr-unit-"));
  if (opencodeContent !== undefined) {
    writeFileSync(join(dir, "opencode.jsonc"), opencodeContent, "utf-8");
  }
  if (aliases) {
    writeAliasYaml(dir, aliases);
  }
  return dir;
}

// ── Unit: resolveModel ───────────────────────────────────────────────────

describe("resolveModel", () => {
  // --- Test 1: Known model → passthrough unchanged, no log ---
  it("returns known model as-is (passthrough)", () => {
    const dir = setupConfigDir(OPencodeJsonc());
    initModelResolver(dir);

    const result = resolveModel("test-provider/model-one");

    expect(result).toBe("test-provider/model-one");
    expect(capturedWarns).toHaveLength(0);
    expect(capturedInfos).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 2: Model in aliases → resolved to aliased value ---
  it("resolves alias to its mapped value", () => {
    const dir = setupConfigDir(OPencodeJsonc(), {
      PLACEHOLDER: "test-provider/model-one",
    });
    initModelResolver(dir);

    const result = resolveModel("PLACEHOLDER");

    expect(result).toBe("test-provider/model-one");
    expect(capturedWarns).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 3: Model matches BOTH known + alias → known takes priority ---
  it("known model takes priority over alias when both match", () => {
    // "test-provider/model-one" is a known model AND also an alias key
    const dir = setupConfigDir(OPencodeJsonc(), {
      "test-provider/model-one": "test-provider/model-two",
    });
    initModelResolver(dir);

    const result = resolveModel("test-provider/model-one");

    // Known model wins → passthrough original (not the alias target)
    expect(result).toBe("test-provider/model-one");
    expect(capturedWarns).toHaveLength(0);
    expect(capturedInfos).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 4: Neither known nor aliased → passthrough + info log ---
  it("passthrough + info log when model is unrecognized", () => {
    const dir = setupConfigDir(OPencodeJsonc(), {
      PLACEHOLDER: "test-provider/model-one",
    });
    initModelResolver(dir);

    const result = resolveModel("UNKNOWN_MODEL_XYZ");

    expect(result).toBe("UNKNOWN_MODEL_XYZ");
    expect(capturedWarns).toHaveLength(0);
    expect(capturedInfos.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedInfos);
    expect(msg).toContain("UNKNOWN_MODEL_XYZ");
    expect(msg).toContain("role_config.yaml");
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 5: Empty model string → passthrough, no log ---
  it("returns empty string as-is with no log", () => {
    const dir = setupConfigDir(OPencodeJsonc());
    initModelResolver(dir);

    const result = resolveModel("");

    expect(result).toBe("");
    expect(capturedWarns).toHaveLength(0);
    expect(capturedInfos).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 5 extended: whitespace-only string → passthrough ---
  it("returns whitespace-only string as-is with no log", () => {
    const dir = setupConfigDir(OPencodeJsonc());
    initModelResolver(dir);

    const result = resolveModel("   ");

    expect(result).toBe("   ");
    expect(capturedWarns).toHaveLength(0);
    expect(capturedInfos).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 8: Not initialized → warn + passthrough ---
  it("warns and passes through when resolver is not initialized", () => {
    // __resetForTest already called in beforeEach, so resolver is uninitialized
    const result = resolveModel("some-model");

    expect(result).toBe("some-model");
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("not initialized");
    expect(msg).toContain("some-model");
  });

  // --- I8: Single-hop alias chain ---
  it("resolves only one alias hop (A→B stops at B, does not continue to B→C)", () => {
    const dir = setupConfigDir(OPencodeJsonc(), {
      A: "B",
      B: "test-provider/model-one",
    });
    initModelResolver(dir);

    // A → B (the first hop), NOT B → test-provider/model-one
    expect(resolveModel("A")).toBe("B");
    // B itself maps to test-provider/model-one
    expect(resolveModel("B")).toBe("test-provider/model-one");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Unit: loadModelAliases (via initModelResolver) ──────────────────────

describe("initModelResolver + loadModelAliases", () => {
  // --- Test 6: Alias file missing → empty aliases, resolution falls through ---
  it("treats missing role_config.yaml as empty aliases (no crash)", () => {
    const dir = setupConfigDir(OPencodeJsonc());
    initModelResolver(dir);

    // Resolver should still work — alias lookup falls through
    const result = resolveModel("nonexistent-alias");
    expect(result).toBe("nonexistent-alias");
    // No warn from missing alias file (loadModelAliases returns empty silently)
    expect(capturedWarns).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 7: Alias file malformed YAML → warn + empty aliases ---
  it("warns and returns empty aliases for malformed role_config.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-mr-unit-"));
    writeFileSync(join(dir, "opencode.jsonc"), OPencodeJsonc(), "utf-8");
    writeFileSync(join(dir, "role_config.yaml"), "::: not valid yaml ::: [[[", "utf-8");
    initModelResolver(dir);

    // Should not crash, aliases should be empty
    const result = resolveModel("anything");
    expect(result).toBe("anything");
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("Failed to parse");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 13: Empty alias key → warn, skipped ---
  it("skips empty-string alias key with warning", () => {
    const dir = setupConfigDir(OPencodeJsonc(), { "": "should-be-skipped" });
    initModelResolver(dir);

    const result = resolveModel("");
    // Empty string → passthrough (caught by empty guard before alias lookup)
    expect(result).toBe("");
    // But the alias loading should have warned about the empty key
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("empty alias key");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 14: Alias value is null → warn, skipped ---
  it("skips alias with null value with warning", () => {
    const dir = setupConfigDir(OPencodeJsonc(), { NULL_KEY: null });
    initModelResolver(dir);

    // Alias was skipped, so resolveModel falls through to info
    const result = resolveModel("NULL_KEY");
    expect(result).toBe("NULL_KEY");
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("NULL_KEY");
    expect(msg).toContain("must be a string");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 15: Alias value is numeric → warn, skipped ---
  it("skips alias with numeric value with warning", () => {
    const dir = setupConfigDir(OPencodeJsonc(), { NUM_KEY: 42 });
    initModelResolver(dir);

    const result = resolveModel("NUM_KEY");
    expect(result).toBe("NUM_KEY");
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("NUM_KEY");
    expect(msg).toContain("number");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 16: Alias value is empty string → warn, skipped ---
  it("skips alias with empty string value with warning", () => {
    const dir = setupConfigDir(OPencodeJsonc(), { EMPTY_VAL: "" });
    initModelResolver(dir);

    const result = resolveModel("EMPTY_VAL");
    expect(result).toBe("EMPTY_VAL");
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("EMPTY_VAL");
    expect(msg).toContain("empty");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 17: Alias value is array → warn, skipped ---
  it("skips alias with array value with warning", () => {
    const dir = setupConfigDir(OPencodeJsonc(), { ARR_KEY: ["one", "two"] });
    initModelResolver(dir);

    const result = resolveModel("ARR_KEY");
    expect(result).toBe("ARR_KEY");
    expect(capturedWarns.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(capturedWarns);
    expect(msg).toContain("ARR_KEY");
    expect(msg).toContain("must be a string");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 18: Valid aliases mixed with invalid → valid work, invalid skipped ---
  it("resolves valid aliases and skips invalid ones", () => {
    const dir = setupConfigDir(OPencodeJsonc(), {
      VALID_ONE: "test-provider/model-one",
      "": "empty-key-val",
      NULL_VAL: null,
      NUM_VAL: 99,
      EMPTY_VAL: "",
      ARR_VAL: ["a", "b"],
      VALID_TWO: "test-provider/model-two",
    });
    initModelResolver(dir);

    // Valid aliases should work
    expect(resolveModel("VALID_ONE")).toBe("test-provider/model-one");
    expect(resolveModel("VALID_TWO")).toBe("test-provider/model-two");

    // Invalid should fall through
    expect(resolveModel("NULL_VAL")).toBe("NULL_VAL");
    expect(resolveModel("NUM_VAL")).toBe("NUM_VAL");
    expect(resolveModel("EMPTY_VAL")).toBe("EMPTY_VAL");
    expect(resolveModel("ARR_VAL")).toBe("ARR_VAL");

    // Warnings for each invalid entry (5 invalid entries)
    expect(capturedWarns.length).toBeGreaterThanOrEqual(5);

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 9: initModelResolver called twice → always reloads ---
  it("reloads caches when initModelResolver is called twice with the same dir", () => {
    const dir = setupConfigDir(OPencodeJsonc(), { RELOAD: "test-provider/model-one" });

    // First init — alias resolves
    initModelResolver(dir);
    expect(resolveModel("RELOAD")).toBe("test-provider/model-one");

    // Modify the alias file on disk
    writeAliasYaml(dir, { RELOAD: "test-provider/model-two" });

    // Second init — should pick up the new value (no caching)
    initModelResolver(dir);
    expect(resolveModel("RELOAD")).toBe("test-provider/model-two");

    rmSync(dir, { recursive: true, force: true });
  });

  // --- Test 10: Different configDir → reloads from new directory ---
  it("reloads from new directory when configDir changes", () => {
    const dirA = setupConfigDir(OPencodeJsonc(), { SWITCH: "test-provider/model-one" });
    const dirB = setupConfigDir(OPencodeJsonc(), { SWITCH: "test-provider/model-two" });

    initModelResolver(dirA);
    expect(resolveModel("SWITCH")).toBe("test-provider/model-one");

    initModelResolver(dirB);
    expect(resolveModel("SWITCH")).toBe("test-provider/model-two");

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  // --- Test 11: Cache isolation via __resetForTest ---
  it("provides clean state after __resetForTest between init calls", () => {
    const dirA = setupConfigDir(OPencodeJsonc(), { ISO: "test-provider/model-one" });
    const dirB = setupConfigDir(OPencodeJsonc(), { ISO: "test-provider/model-two" });

    initModelResolver(dirA);
    expect(resolveModel("ISO")).toBe("test-provider/model-one");

    // Reset completely
    __resetForTest();
    __setLoggerForTest(mockLogger);
    capturedWarns = [];
    capturedInfos = [];

    initModelResolver(dirB);
    expect(resolveModel("ISO")).toBe("test-provider/model-two");

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  // --- Test 12: Known models config missing → only aliases used ---
  it("gracefully handles missing opencode.jsonc (empty known models)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-mr-unit-"));
    // No opencode.jsonc — only role_config.yaml
    writeAliasYaml(dir, { MY_ALIAS: "some-provider/some-model" });
    initModelResolver(dir);

    // Alias should still resolve
    expect(resolveModel("MY_ALIAS")).toBe("some-provider/some-model");

    // An arbitrary string falls through (no known models to match)
    expect(resolveModel("anything-else")).toBe("anything-else");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Integration tests (via discoverRoles / bootstrapRoles)
// ═════════════════════════════════════════════════════════════════════════

import { discoverRoles, __setLoggerForTest as setRoleLoaderLogger } from "../src/loader/role-loader";
import { bootstrapRoles } from "../src/resolver/bootstrap";

// ── Integration helpers ─────────────────────────────────────────────────

/**
 * Set up a combined config + role temp directory.
 *
 * Returns `{ configDir, roleDir, cleanup }`.
 *   - configDir  contains opencode.jsonc and role_config.yaml
 *   - roleDir    contains role.yaml ([subagents/]role.yaml subdirs)
 */
function setupIntegrationDirs(opts: {
  opencodeContent?: string;
  aliases?: Record<string, unknown>;
  roleYaml?: Record<string, string>;        // roleName → yaml content
  subagentYamls?: Record<string, Record<string, string>>; // roleName → { subName → yaml }
  extraDirs?: string[];                     // extra directories to create under roleDir
}): { configDir: string; roleDir: string; cleanup: () => void } {
  const configDir = mkdtempSync(join(tmpdir(), "rolebox-mr-int-config-"));
  const roleDir = mkdtempSync(join(tmpdir(), "rolebox-mr-int-roles-"));

  // Write opencode.jsonc
  if (opts.opencodeContent !== undefined) {
    writeFileSync(join(configDir, "opencode.jsonc"), opts.opencodeContent, "utf-8");
  }

  // Write role_config.yaml
  if (opts.aliases) {
    writeAliasYaml(configDir, opts.aliases);
  }

  // Write role YAML files
  if (opts.roleYaml) {
    for (const [roleName, content] of Object.entries(opts.roleYaml)) {
      const roleDirPath = join(roleDir, roleName);
      mkdirSync(roleDirPath, { recursive: true });
      writeFileSync(join(roleDirPath, "role.yaml"), content, "utf-8");
    }
  }

  // Write subagent role.yaml files
  if (opts.subagentYamls) {
    for (const [roleName, subs] of Object.entries(opts.subagentYamls)) {
      for (const [subName, content] of Object.entries(subs)) {
        const subDir = join(roleDir, roleName, "subagents", subName);
        mkdirSync(subDir, { recursive: true });
        writeFileSync(join(subDir, "role.yaml"), content, "utf-8");
      }
    }
  }

  // Create extra empty directories
  if (opts.extraDirs) {
    for (const d of opts.extraDirs) {
      mkdirSync(join(roleDir, d), { recursive: true });
    }
  }

  const cleanup = () => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(roleDir, { recursive: true, force: true });
  };

  return { configDir, roleDir, cleanup };
}

describe("integration: role model resolution", () => {
  // Silence the role-loader and subagent loggers (we don't need their output)
  beforeEach(() => {
    setRoleLoaderLogger(mockLogger as any);
  });

  // --- I1: Role with explicit model resolved via known models ---
  it("I1: resolves role model via known models (passthrough)", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      roleYaml: {
        engineer: [
          "name: Engineer",
          "description: Builds things",
          "prompt: You are an engineer.",
          "model: test-provider/model-one",
        ].join("\n"),
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    expect(roles.get("engineer")!.model).toBe("test-provider/model-one");
    cleanup();
  });

  // --- I2: Role without model field → model is absent/undefined ---
  it("I2: role without model field has no model property", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      roleYaml: {
        minimalist: [
          "name: Minimal",
          "description: No model field",
          "prompt: I have no model.",
        ].join("\n"),
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    const config = roles.get("minimalist")!;
    expect(config.model).toBeUndefined();
    cleanup();
  });
});

describe("integration: subagent model resolution", () => {
  beforeEach(() => {
    setRoleLoaderLogger(mockLogger as any);
  });

  // --- I3: Inline subagent with explicit model resolved via alias ---
  it("I3: resolves inline subagent model via alias", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      aliases: { SUB_MODEL: "test-provider/model-two" },
      roleYaml: {
        parent: [
          "name: Parent",
          "description: Has subagent",
          "prompt: I am the parent.",
          "subagents:",
          "  - name: Child",
          '    description: "Child agent"',
          '    prompt: "I am the child."',
          "    model: SUB_MODEL",
        ].join("\n"),
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    expect(config.subagents![0].model).toBe("test-provider/model-two");
    cleanup();
  });

  // --- I4: Nested subagent (3-levels) with alias at each level ---
  it("I4: resolves aliases in deeply nested subagents (3 levels)", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      aliases: {
        L1_MODEL: "test-provider/model-one",
        L2_MODEL: "test-provider/model-two",
        L3_MODEL: "test-provider/model-one",
      },
      roleYaml: {
        parent: [
          "name: Parent",
          "description: Root",
          "prompt: I am the parent.",
          "model: L1_MODEL",
          "subagents:",
          "  - name: Level2",
          '    description: "Level 2"',
          '    prompt: "I am level 2."',
          "    model: L2_MODEL",
          "    subagents:",
          "      - name: Level3",
          '        description: "Level 3"',
          '        prompt: "I am level 3."',
          "        model: L3_MODEL",
        ].join("\n"),
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    const parent = roles.get("parent")!;
    // Parent model
    expect(parent.model).toBe("test-provider/model-one");
    // Level 2
    expect(parent.subagents).toBeDefined();
    expect(parent.subagents!.length).toBe(1);
    expect(parent.subagents![0].model).toBe("test-provider/model-two");
    // Level 3
    expect(parent.subagents![0].subagents).toBeDefined();
    expect(parent.subagents![0].subagents!.length).toBe(1);
    expect(parent.subagents![0].subagents![0].model).toBe("test-provider/model-one");
    cleanup();
  });

  // --- I5: File-based subagent with alias ---
  it("I5: resolves file-based subagent model via alias", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      aliases: { FILE_MODEL: "test-provider/model-two" },
      roleYaml: {
        parent: [
          "name: Parent",
          "description: Has file-based subagent",
          "prompt: I am the parent.",
        ].join("\n"),
      },
      subagentYamls: {
        parent: {
          helper: [
            "name: Helper",
            "description: File-based helper",
            "prompt: I am a helper.",
            "model: FILE_MODEL",
          ].join("\n"),
        },
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    expect(config.subagents![0].name).toBe("Helper");
    expect(config.subagents![0].model).toBe("test-provider/model-two");
    cleanup();
  });
});

describe("integration: inheritance with resolved models", () => {
  beforeEach(() => {
    setRoleLoaderLogger(mockLogger as any);
  });

  // --- I6: Inline subagent without model inherits resolved parent model ---
  it("I6: inline subagent inherits resolved parent model", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      aliases: { PARENT_M: "test-provider/model-one" },
      roleYaml: {
        parent: [
          "name: Parent",
          "description: Has subagent",
          "prompt: I am the parent.",
          "model: PARENT_M",
          "subagents:",
          "  - name: Child",
          '    description: "Child inherits model"',
          '    prompt: "I am the child."',
          // No explicit model → should inherit parent's resolved model
        ].join("\n"),
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.model).toBe("test-provider/model-one");

    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    // Child should inherit the resolved parent model
    expect(config.subagents![0].model).toBe("test-provider/model-one");
    cleanup();
  });

  // --- I7: File-based subagent without model inherits resolved parent model ---
  it("I7: file-based subagent inherits resolved parent model", async () => {
    const { configDir, roleDir, cleanup } = setupIntegrationDirs({
      opencodeContent: OPencodeJsonc(),
      aliases: { PARENT_M2: "test-provider/model-two" },
      roleYaml: {
        parent: [
          "name: Parent",
          "description: Has file subagent",
          "prompt: I am the parent.",
          "model: PARENT_M2",
        ].join("\n"),
      },
      subagentYamls: {
        parent: {
          assistant: [
            "name: Assistant",
            "description: File-based child",
            "prompt: I am the assistant.",
            // No model → inherits from parent
          ].join("\n"),
        },
      },
    });

    initModelResolver(configDir);
    const roles = await discoverRoles(roleDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.model).toBe("test-provider/model-two");

    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    expect(config.subagents![0].name).toBe("Assistant");
    // File-based child should inherit the resolved parent model
    expect(config.subagents![0].model).toBe("test-provider/model-two");
    cleanup();
  });
});

describe("integration: bootstrap-level init", () => {
  beforeEach(() => {
    setRoleLoaderLogger(mockLogger as any);
  });

  // --- I9: bootstrapRoles initializes model resolver, role model resolved ---
  it("I9: bootstrapRoles resolves model without explicit initModelResolver call", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "rolebox-mr-int-config-"));
    const roleDir = mkdtempSync(join(tmpdir(), "rolebox-mr-int-roles-"));
    const skillsDir = mkdtempSync(join(tmpdir(), "rolebox-mr-int-skills-"));
    const builtinDir = mkdtempSync(join(tmpdir(), "rolebox-mr-int-builtin-"));

    // Set up config with known models + alias
    writeFileSync(join(configDir, "opencode.jsonc"), OPencodeJsonc(), "utf-8");
    writeAliasYaml(configDir, { BOOTSTRAP_ALIAS: "test-provider/model-one" });

    // Write a role using the alias
    const roleDirPath = join(roleDir, "test-role");
    mkdirSync(roleDirPath, { recursive: true });
    writeFileSync(
      join(roleDirPath, "role.yaml"),
      [
        "name: Test Role",
        "description: Bootstrap test",
        "prompt: I am a test role.",
        "model: BOOTSTRAP_ALIAS",
      ].join("\n"),
      "utf-8",
    );

    // Ensure resolver is NOT initialized before bootstrap
    __resetForTest();
    __setLoggerForTest(mockLogger);

    const roleFunctionsMap = new Map();
    const roleGraphMap = new Map();

    const result = await bootstrapRoles({
      roleboxDir: roleDir,
      globalSkillsDir: skillsDir,
      configDir,
      builtinDir,
      roleFunctionsMap,
      roleGraphMap,
    });

    expect(result.discovered).toBe(1);
    expect(result.resolved).toBe(1);

    // The resolved role should have the aliased model (not "BOOTSTRAP_ALIAS")
    const resolvedRole = result.resolvedRoles.find((r) => r.id === "test-role");
    expect(resolvedRole).toBeDefined();
    expect(resolvedRole!.config.model).toBe("test-provider/model-one");

    // Cleanup
    rmSync(configDir, { recursive: true, force: true });
    rmSync(roleDir, { recursive: true, force: true });
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });
});

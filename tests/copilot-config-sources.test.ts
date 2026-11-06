/**
 * Copilot config file-source tests.
 *
 * The readers are the boot-time half of the project/global fallback: missing
 * files are absent, malformed files warn and are absent, and reading never
 * throws or creates a file.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROJECT_CONFIG_RELATIVE_PATH,
  globalCopilotConfigPath,
  projectCopilotConfigPath,
  readCopilotFragmentFromJsonFile,
  readCopilotFragmentFromYamlFile,
} from "../src/copilot/config-sources.ts";
import { getRootLogger } from "../src/logger.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Capture warnings emitted on the `copilot-config` channel. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  getRootLogger().attachTransport((entry) => {
    if (entry.channel !== "copilot-config" || entry.level !== "warn") return;
    const message = entry["0"];
    if (typeof message === "string") warnings.push(message);
  });
  return warnings;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "copilot-config-sources-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a fixture file under the temp dir and return its absolute path. */
function fixture(name: string, contents: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, contents, "utf-8");
  return path;
}

// ── Paths ────────────────────────────────────────────────────────────

describe("config-sources — paths", () => {
  it("builds the project config path from the workspace", () => {
    expect(PROJECT_CONFIG_RELATIVE_PATH).toBe(join(".rolebox", "config.json"));
    expect(projectCopilotConfigPath("/path/to/project")).toBe(
      join("/path/to/project", ".rolebox", "config.json"),
    );
  });

  it("resolves the global path from the rolebox config home", () => {
    const previous = process.env.ROLEBOX_CONFIG_DIR;
    process.env.ROLEBOX_CONFIG_DIR = join(tmpDir, "config-home");
    try {
      expect(globalCopilotConfigPath()).toBe(
        join(tmpDir, "config-home", "config.yaml"),
      );
    } finally {
      if (previous === undefined) delete process.env.ROLEBOX_CONFIG_DIR;
      else process.env.ROLEBOX_CONFIG_DIR = previous;
    }
  });
});

// ── JSON ─────────────────────────────────────────────────────────────

describe("readCopilotFragmentFromJsonFile", () => {
  it("reads only the copilot key from a valid project config", () => {
    const path = fixture(
      "config.json",
      JSON.stringify({
        defaultRole: "reviewer",
        copilot: {
          draft: { enabled: true, provider: "example-provider", model: "example-model" },
        },
        computerUse: false,
      }),
    );

    expect(readCopilotFragmentFromJsonFile(path)).toEqual({
      enabled: true,
      provider: "example-provider",
      model: "example-model",
    });
  });

  it("returns undefined when the file has no copilot key", () => {
    const warnings = captureWarnings();
    const path = fixture("config.json", JSON.stringify({ defaultRole: "reviewer" }));

    expect(readCopilotFragmentFromJsonFile(path)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("returns an empty fragment for a valid but empty copilot block", () => {
    const path = fixture("config.json", JSON.stringify({ copilot: {} }));
    expect(readCopilotFragmentFromJsonFile(path)).toEqual({});
  });

  it("returns undefined for a missing file without creating it", () => {
    const warnings = captureWarnings();
    const path = join(tmpDir, "missing", "config.json");

    expect(readCopilotFragmentFromJsonFile(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(tmpDir, "missing"))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("warns and returns undefined for malformed JSON", () => {
    const warnings = captureWarnings();
    const path = fixture("config.json", "{not json");

    expect(readCopilotFragmentFromJsonFile(path)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Failed to parse copilot config");
  });

  it("warns and returns undefined for a non-object document", () => {
    for (const contents of ["[]", JSON.stringify("text"), "null", "42"]) {
      const warnings = captureWarnings();
      const path = fixture("config.json", contents);

      expect(readCopilotFragmentFromJsonFile(path)).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("is not an object");
    }
  });

  it("warns and returns undefined for a non-object copilot value", () => {
    const warnings = captureWarnings();
    const path = fixture("config.json", JSON.stringify({ copilot: "junk" }));

    expect(readCopilotFragmentFromJsonFile(path)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Invalid "copilot" value');
  });

  it("warns once per invalid field inside a valid JSON copilot block", () => {
    const warnings = captureWarnings();
    const path = fixture(
      "config.json",
      JSON.stringify({ copilot: { draft: { enabled: 42 } } }),
    );

    expect(readCopilotFragmentFromJsonFile(path)).toEqual({});
    expect(warnings).toEqual([
      'Invalid "enabled" value; expected boolean, got number',
    ]);
  });
});

// ── YAML ─────────────────────────────────────────────────────────────

describe("readCopilotFragmentFromYamlFile", () => {
  it("reads only the copilot key from a valid global config", () => {
    const path = fixture(
      "config.yaml",
      [
        "registries:",
        "  - name: example-registry",
        "    url: https://github.com/example/roles",
        "copilot:",
        "  draft:",
        "    enabled: true",
        "    timeout_ms: 2000",
        "    model: example-model",
        "",
      ].join("\n"),
    );

    expect(readCopilotFragmentFromYamlFile(path)).toEqual({
      enabled: true,
      timeout_ms: 2000,
      model: "example-model",
    });
  });

  it("returns undefined when the file has no copilot key", () => {
    const warnings = captureWarnings();
    const path = fixture("config.yaml", "registries: []\n");

    expect(readCopilotFragmentFromYamlFile(path)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("returns undefined for a missing file without creating it", () => {
    const warnings = captureWarnings();
    const path = join(tmpDir, "missing", "config.yaml");

    expect(readCopilotFragmentFromYamlFile(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("warns and returns undefined for malformed YAML", () => {
    const warnings = captureWarnings();
    const path = fixture("config.yaml", "a: [1, 2\n");

    expect(readCopilotFragmentFromYamlFile(path)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Failed to parse copilot config");
  });

  it("warns and returns undefined for a non-object document", () => {
    for (const contents of ["just-a-string\n", "null\n", "- one\n- two\n"]) {
      const warnings = captureWarnings();
      const path = fixture("config.yaml", contents);

      expect(readCopilotFragmentFromYamlFile(path)).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("is not an object");
    }
  });

  it("warns and returns undefined for a non-object copilot value", () => {
    const warnings = captureWarnings();
    const path = fixture("config.yaml", "copilot: nope\n");

    expect(readCopilotFragmentFromYamlFile(path)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Invalid "copilot" value');
  });

  it("reads a copilot block with legacy keys and warns for each", () => {
    const warnings = captureWarnings();
    const path = fixture(
      "config.yaml",
      [
        "copilot:",
        "  rules: []",
        "  draft:",
        "    enabled: true",
        "",
      ].join("\n"),
    );

    expect(readCopilotFragmentFromYamlFile(path)).toEqual({ enabled: true });
    expect(warnings).toEqual(["copilot.rules was removed; use copilot.draft"]);
  });
});

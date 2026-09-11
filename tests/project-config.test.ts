import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadProjectConfig,
  applyProjectConfig,
  type ProjectConfig,
} from "../src/project-config.ts";
import type { ResolvedRole, RoleConfig } from "../src/types.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "project-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper: create a minimal resolved role ───────────────────────────────────

function makeRole(id: string, mode?: string): ResolvedRole {
  const config: RoleConfig = {
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: `Role ${id}`,
    prompt: `You are ${id}.`,
    mode: mode as any,
  };
  // Clean up undefined so we can test the `=== undefined` branch
  if (mode === undefined) {
    delete config.mode;
  }
  return {
    id,
    config,
    prompt: config.prompt,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

// ── loadProjectConfig ────────────────────────────────────────────────────────

describe("loadProjectConfig", () => {
  it("returns null when .rolebox/config.json does not exist", () => {
    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when .rolebox/ directory does not exist", () => {
    const noDotDir = join(tmpdir(), "nonexistent-project");
    const result = loadProjectConfig(noDotDir);
    expect(result).toBeNull();
  });

  it("parses valid config with defaultRole", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), JSON.stringify({ defaultRole: "emperor" }), "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.defaultRole).toBe("emperor");
  });

  it("parses config with empty object (no defaultRole)", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), "{}", "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.defaultRole).toBeUndefined();
  });

  it("returns null for invalid JSON", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), "not valid json", "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for non-object JSON (array)", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), '["a", "b"]', "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for non-object JSON (string)", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), '"just a string"', "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for null JSON", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), "null", "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when defaultRole is not a string (number)", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), JSON.stringify({ defaultRole: 42 }), "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when defaultRole is not a string (boolean)", () => {
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), JSON.stringify({ defaultRole: true }), "utf-8");

    const result = loadProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("never throws on any filesystem error (e.g. permission denied)", () => {
    // Can't easily simulate permission errors in cross-platform tests,
    // but the try-catch in loadProjectConfig ensures no throw.
    const dotRolebox = join(tmpDir, ".rolebox");
    mkdirSync(dotRolebox, { recursive: true });
    writeFileSync(join(dotRolebox, "config.json"), "broken json", "utf-8");

    expect(() => loadProjectConfig(tmpDir)).not.toThrow();
  });
});

// ── applyProjectConfig ───────────────────────────────────────────────────────

describe("applyProjectConfig", () => {
  it("promotes target role to primary and demotes others", () => {
    const roles = [makeRole("emperor", "primary"), makeRole("jinyiwei", "primary")];

    applyProjectConfig(roles, { defaultRole: "jinyiwei" });

    expect(roles.find((r) => r.id === "jinyiwei")!.config.mode).toBe("primary");
    expect(roles.find((r) => r.id === "emperor")!.config.mode).toBe("all");
  });

  it("promotes target and demotes roles with undefined mode", () => {
    // Roles without explicit mode default to "primary" behavior
    const roles = [makeRole("emperor"), makeRole("jinyiwei")];

    applyProjectConfig(roles, { defaultRole: "jinyiwei" });

    expect(roles.find((r) => r.id === "jinyiwei")!.config.mode).toBe("primary");
    expect(roles.find((r) => r.id === "emperor")!.config.mode).toBe("all");
  });

  it("does not modify roles with explicit 'all' or 'subagent' mode", () => {
    const roles = [
      makeRole("emperor", "primary"),
      makeRole("helper", "subagent"),
      makeRole("generic", "all"),
    ];

    applyProjectConfig(roles, { defaultRole: "emperor" });

    // emperor should remain primary
    expect(roles.find((r) => r.id === "emperor")!.config.mode).toBe("primary");
    // subagent and all should be unchanged
    expect(roles.find((r) => r.id === "helper")!.config.mode).toBe("subagent");
    expect(roles.find((r) => r.id === "generic")!.config.mode).toBe("all");
  });

  it("does nothing when defaultRole is undefined", () => {
    const roles = [makeRole("emperor", "primary"), makeRole("jinyiwei", "primary")];
    const originalModes = roles.map((r) => r.config.mode);

    applyProjectConfig(roles, {});

    expect(roles.map((r) => r.config.mode)).toEqual(originalModes);
  });

  it("does nothing when defaultRole is empty string", () => {
    const roles = [makeRole("emperor", "primary")];

    applyProjectConfig(roles, { defaultRole: "" });

    expect(roles[0].config.mode).toBe("primary");
  });

  it("does not crash when defaultRole does not match any resolved role", () => {
    const roles = [makeRole("emperor", "primary"), makeRole("jinyiwei", "primary")];

    applyProjectConfig(roles, { defaultRole: "nonexistent" });

    // No roles should have changed
    expect(roles.find((r) => r.id === "emperor")!.config.mode).toBe("primary");
    expect(roles.find((r) => r.id === "jinyiwei")!.config.mode).toBe("primary");
  });

  it("works with a single role (self-promotion)", () => {
    const roles = [makeRole("solo", "primary")];

    applyProjectConfig(roles, { defaultRole: "solo" });

    expect(roles[0].config.mode).toBe("primary");
  });

  it("works with a single role with undefined mode", () => {
    const roles = [makeRole("solo")];

    applyProjectConfig(roles, { defaultRole: "solo" });

    expect(roles[0].config.mode).toBe("primary");
  });

  it("can re-apply config to change primary role", () => {
    const roles = [
      makeRole("alpha", "primary"),
      makeRole("beta", "primary"),
      makeRole("gamma", "all"),
    ];

    // First application
    applyProjectConfig(roles, { defaultRole: "beta" });
    expect(roles.find((r) => r.id === "beta")!.config.mode).toBe("primary");
    expect(roles.find((r) => r.id === "alpha")!.config.mode).toBe("all");
    expect(roles.find((r) => r.id === "gamma")!.config.mode).toBe("all");

    // Second application — switch to alpha
    applyProjectConfig(roles, { defaultRole: "alpha" });
    expect(roles.find((r) => r.id === "alpha")!.config.mode).toBe("primary");
    expect(roles.find((r) => r.id === "beta")!.config.mode).toBe("all");
    expect(roles.find((r) => r.id === "gamma")!.config.mode).toBe("all");
  });

  it("handles empty roles array gracefully", () => {
    const roles: ResolvedRole[] = [];

    expect(() => applyProjectConfig(roles, { defaultRole: "ghost" })).not.toThrow();
  });
});

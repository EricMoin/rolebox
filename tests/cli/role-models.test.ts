/**
 * Role-side model helpers — `scanRoleModels`, `isPlaceholderModel` and
 * `findPlaceholderRoles`.
 *
 * These read rolebox's own `role.yaml` files and classify models as
 * placeholders; per-harness catalog readers live in
 * tests/platform/model-catalog.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanRoleModels,
  isPlaceholderModel,
  findPlaceholderRoles,
} from "../../src/cli/role-models.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-role-models-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a `role.yaml` at `<roleDir>/<relative>` and return the role dir. */
function writeRole(roleDir: string, relative: string, content: string): void {
  const dir = join(roleDir, relative, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(roleDir, relative), content, "utf-8");
}

describe("scanRoleModels", () => {
  it("returns [] when the role directory does not exist", () => {
    expect(scanRoleModels(join(tmpDir, "missing-role"))).toEqual([]);
  });

  it("reads the root role.yaml and a nested subagent role.yaml", () => {
    const roleDir = join(tmpDir, "demo");
    writeRole(roleDir, "role.yaml", "name: demo\nmodel: openrouter/anthropic/claude-sonnet-4\n");
    writeRole(
      roleDir,
      "subagents/helper/role.yaml",
      "name: helper\nmodel: openrouter/openai/gpt-4o\n",
    );

    const entries = scanRoleModels(roleDir)
      .map((e) => ({ ...e, path: e.path.replace(roleDir, "<roleDir>") }))
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(entries).toEqual([
      { path: "<roleDir>/role.yaml", name: "demo", model: "openrouter/anthropic/claude-sonnet-4" },
      { path: "<roleDir>/subagents/helper/role.yaml", name: "helper", model: "openrouter/openai/gpt-4o" },
    ]);
  });

  it("defaults an absent name to 'unnamed' and an absent model to an empty string", () => {
    const roleDir = join(tmpDir, "no-fields");
    writeRole(roleDir, "role.yaml", "description: no name or model\n");

    const [entry] = scanRoleModels(roleDir);

    expect(entry.name).toBe("unnamed");
    expect(entry.model).toBe("");
  });

  it("skips a malformed role.yaml and still returns its siblings", () => {
    const roleDir = join(tmpDir, "mixed");
    writeRole(roleDir, "role.yaml", "name: [unterminated\n");
    writeRole(roleDir, "subagents/ok/role.yaml", "name: ok\nmodel: p/m\n");

    const entries = scanRoleModels(roleDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("ok");
  });

  it("skips a role.yaml whose document is not a mapping", () => {
    const roleDir = join(tmpDir, "scalar");
    writeRole(roleDir, "role.yaml", "just a scalar\n");

    expect(scanRoleModels(roleDir)).toEqual([]);
  });
});

describe("isPlaceholderModel", () => {
  const qualified = "openrouter/anthropic/claude-sonnet-4";

  it("matches knownModels against the original string, not the trimmed one", () => {
    expect(isPlaceholderModel(qualified, [qualified])).toBe(false);
    // A padded value is not a configured id and cannot resolve, so it stays
    // flagged instead of being trimmed into a membership match.
    expect(isPlaceholderModel(` ${qualified} `, [qualified])).toBe(true);
  });

  it("treats an empty known-model list as no information", () => {
    expect(isPlaceholderModel(qualified, [])).toBe(false);
    expect(isPlaceholderModel(` ${qualified} `, [])).toBe(false);
    expect(isPlaceholderModel(qualified, undefined)).toBe(false);
    expect(isPlaceholderModel(qualified, ["other/x"])).toBe(true);
  });

  it("still flags placeholder literals and bare names", () => {
    expect(isPlaceholderModel("TODO", [])).toBe(true);
    expect(isPlaceholderModel("CHANGE_ME", ["other/x"])).toBe(true);
    expect(isPlaceholderModel("gpt-4o", [])).toBe(true);
    expect(isPlaceholderModel("   ", [])).toBe(true);
  });
});

describe("findPlaceholderRoles", () => {
  it("flags only the roles whose model is unconfigured", () => {
    const roleDir = join(tmpDir, "flags");
    writeRole(roleDir, "role.yaml", "name: demo\nmodel: PLACEHOLDER\n");
    writeRole(roleDir, "subagents/ok/role.yaml", "name: ok\nmodel: openrouter/x\n");

    const flagged = findPlaceholderRoles(roleDir, ["openrouter/x"]);

    expect(flagged.map((e) => e.name)).toEqual(["demo"]);
  });

  it("does not flag a fully-qualified model when no known list is given", () => {
    const roleDir = join(tmpDir, "qualified");
    writeRole(roleDir, "role.yaml", "name: demo\nmodel: openrouter/x\n");

    expect(findPlaceholderRoles(roleDir)).toEqual([]);
  });
});

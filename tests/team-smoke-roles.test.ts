import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareTeamSmokeRoles } from "../scripts/team-smoke/roles.ts";

let root: string;
let source: string;
let workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rolebox-smoke-roles-"));
  source = join(root, "source");
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  for (const id of ["typescript-engineer", "ai-designer"]) {
    const directory = join(source, id);
    mkdirSync(join(directory, "skills", "discipline"), { recursive: true });
    mkdirSync(join(directory, "references"));
    mkdirSync(join(directory, "subagents", "worker"), { recursive: true });
    writeFileSync(join(directory, "role.yaml"), "name: Example\nprompt_file: PROMPT.md\nskills: [discipline]\nreferences:\n  local: references/local.md\nmodel: example-provider/model-name\n");
    writeFileSync(join(directory, "PROMPT.md"), "Keep this exact role prompt.\n");
    writeFileSync(join(directory, "skills", "discipline", "SKILL.md"), "---\nname: discipline\n---\nKeep the role workflow.\n");
    writeFileSync(join(directory, "references", "local.md"), "Fixture reference\n");
    writeFileSync(join(directory, "subagents", "worker", "role.yaml"), "name: Worker\nprompt: Private worker\n");
  }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("installed team smoke role snapshot", () => {
  it("preserves exact role bytes and all local assets without editing originals", () => {
    const original = readFileSync(join(source, "typescript-engineer", "role.yaml"));
    const result = prepareTeamSmokeRoles(workspace, { sourceRoleboxDir: source });
    expect(result.engineer.id).toBe("typescript-engineer");
    expect(result.designer.id).toBe("ai-designer");
    expect(result.engineer.childIds).toEqual(["typescript-engineer--worker"]);
    expect(result.designer.childIds).toEqual(["ai-designer--worker"]);
    expect(readFileSync(join(result.engineer.directory, "role.yaml"))).toEqual(original);
    expect(readFileSync(join(source, "typescript-engineer", "role.yaml"))).toEqual(original);
    expect(readFileSync(join(result.designer.directory, "PROMPT.md"), "utf8")).toBe("Keep this exact role prompt.\n");
    expect(existsSync(join(result.engineer.directory, "skills", "discipline", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.designer.directory, "references", "local.md"))).toBe(true);
  });

  it("rejects symlinks and external references before writing the destination", () => {
    const link = join(source, "typescript-engineer", "linked.md");
    symlinkSync(join(source, "ai-designer", "PROMPT.md"), link);
    expect(() => prepareTeamSmokeRoles(workspace, { sourceRoleboxDir: source })).toThrow("symbolic links");
    expect(existsSync(join(workspace, "roles"))).toBe(false);
    rmSync(link);
    writeFileSync(join(source, "typescript-engineer", "role.yaml"), "name: Example\nprompt_file: ../ai-designer/PROMPT.md\n");
    expect(() => prepareTeamSmokeRoles(workspace, { sourceRoleboxDir: source })).toThrow("external file dependency");
    expect(existsSync(join(workspace, "roles"))).toBe(false);
  });

  it("refuses global skill dependencies and keeps an existing destination intact", () => {
    const config = join(source, "ai-designer", "role.yaml");
    const original = readFileSync(config, "utf8");
    writeFileSync(config, original.replace("skills: [discipline]", "skills: [missing-global]"));
    expect(() => prepareTeamSmokeRoles(workspace, { sourceRoleboxDir: source })).toThrow("not bundled locally");
    writeFileSync(config, original);
    mkdirSync(join(workspace, "roles"));
    writeFileSync(join(workspace, "roles", "keep.txt"), "existing");
    expect(() => prepareTeamSmokeRoles(workspace, { sourceRoleboxDir: source })).toThrow("Unable to prepare");
    expect(readFileSync(join(workspace, "roles", "keep.txt"), "utf8")).toBe("existing");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FunctionSource, ReferenceScope } from "../../../../src/constants.ts";
import { prepareDshGraphWorkerExecutionPrompt, prepareDshGraphWorkerRolePrompt } from "../../../../src/platform/adapters/dsh/worker-prompt.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../../../src/types.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-worker-prompt-"));
  directories.push(directory);
  const refs = join(directory, "roles", "planner", "references");
  const skill = join(directory, "roles", "planner", "skills", "research");
  mkdirSync(refs, { recursive: true });
  mkdirSync(join(skill, "scripts"), { recursive: true });
  mkdirSync(join(refs, "theory"), { recursive: true });
  writeFileSync(join(refs, "schema.md"), "Strategy schema; also read ./examples.json");
  writeFileSync(join(refs, "examples.json"), '{"example":true}');
  writeFileSync(join(skill, "SKILL.md"), "Read scripts/check.sh beside this skill.");
  writeFileSync(join(skill, "scripts", "check.sh"), "printf checked", { mode: 0o700 });
  const planner: ResolvedSubAgent = {
    id: "coordinator--planner", parentId: "coordinator", inheritedFrom: {},
    config: { name: "Planner", description: "Plans", prompt: "You are the planner.", auto_activate: ["plan"] },
    prompt: "Legacy rendered prompt advertising graph_declare and Read",
    skills: [{ name: "research", description: "Research", scope: "rolebox", filePath: join(skill, "SKILL.md"), references: [] }],
    references: [{ name: "schema", description: "Schema", scope: ReferenceScope.Role, relativePath: "references/schema.md", filePath: join(refs, "schema.md") }],
    functions: [{ name: "plan", description: "Plan", content: "Return a Strategy.", filePath: "plan.md", source: FunctionSource.RoleLocal }],
    subagents: [],
  };
  const parent: ResolvedRole = {
    id: "coordinator", config: { name: "Coordinator", description: "Coordinates", prompt: "You are the coordinator." },
    prompt: "Coordinator rendered prompt", skills: [], references: [],
    functions: [{ name: "triage", description: "Route", content: "Dispatch more work.", filePath: "triage.md", source: FunctionSource.RoleLocal }],
    subagents: [planner],
  };
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  return { directory, workspace, planner, roles: [parent], refs, skill };
}

describe("DSH graph worker prompt", () => {
  it.each(["native", "discover", "code"] as const)("uses host and rolebox capabilities in %s mode", mode => {
    const f = fixture();
    const prompt = prepareDshGraphWorkerExecutionPrompt(f.roles, f.planner.id, f.workspace, [], { mode });
    expect(prompt).toContain("inherits the parent's authorized task tools");
    expect(prompt).toContain("Worker entry points are graph_submit_outcome");
    expect(prompt).toContain("Graph control tools and recursive agent dispatch remain unavailable");
    expect(prompt).toContain("Use them directly when exposed");
    expect(prompt).toContain("permissions and sandbox policy apply");
    expect(prompt).toContain("```json");
    expect(prompt).not.toContain("You are the planner.");
    expect(prompt).not.toContain("Return a Strategy.");
    expect(prompt).not.toContain("## Role instructions");
    expect(prompt).not.toContain("## Active functions");
    expect(prompt).not.toContain(f.refs);
    expect(prompt).not.toContain(f.skill);
    expect(prompt).not.toContain("graph_worker_exec");
    expect(prompt).not.toContain("disposable per-command");
    expect(prompt).not.toContain("private copies");
    if (mode !== "native") expect(prompt).toContain("list/search authorized host tools");
    if (mode === "code") expect(prompt).toContain("graph_worker_code to call them from JavaScript");
  });

  it("states the runtime fallback conditions without treating a refused submission as settlement", () => {
    const f = fixture();
    const prompt = prepareDshGraphWorkerExecutionPrompt(f.roles, f.planner.id, f.workspace);
    expect(prompt).toContain("completion is explicit or unspecified");
    expect(prompt).toContain("final turn completes normally without an accepted settlement");
    expect(prompt).toContain("exactly one fenced ```json block across that turn's assistant text");
    expect(prompt).toContain("Only outcome_id is required");
    expect(prompt).toContain("include no other keys or credential");
    expect(prompt).toContain("A prior rejected or refused submission does not disable this fallback");
    expect(prompt).toContain("authenticate the execution and apply the same outcome, schema and acceptance checks");
    expect(prompt).toContain("Failed or aborted turns are ineligible");
    expect(prompt).toContain("Natural-completion nodes use the plan's pinned outcome instead");
    expect(prompt).not.toContain("when no submission arrives");
    expect(prompt).not.toContain("If the tool call does not settle");
  });

  it("includes only the target role and its active functions", () => {
    const f = fixture();
    f.planner.functions.push({ name: "unused", description: "Other work", content: "Inactive instructions.",
      filePath: "unused.md", source: FunctionSource.RoleLocal });
    const prompt = prepareDshGraphWorkerRolePrompt(f.roles, f.planner.id);
    expect(prompt).toContain("## Role instructions\n\nYou are the planner.");
    expect(prompt).toContain("## Active functions");
    expect(prompt.match(/You are the planner\./g)).toHaveLength(1);
    expect(prompt.match(/Return a Strategy\./g)).toHaveLength(1);
    expect(prompt).not.toContain("Worker workspace:");
    expect(prompt).not.toContain("Worker entry points");
    expect(prompt).not.toContain("```json");
    for (const forbidden of ["You are the coordinator.", "triage", "Legacy rendered", "Inactive instructions.",
      "## Available functions", "## Available sub-agents", "## Available public agents"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("uses the role's original resource paths and normal loaders without copying bundles", () => {
    const f = fixture();
    const before = readdirSync(f.directory);
    const prompt = prepareDshGraphWorkerRolePrompt(f.roles, f.planner.id);
    expect(prompt).toContain("use load_role_skill if available");
    expect(prompt).toContain("Use load_reference with the listed name");
    expect(prompt).toContain(`Base directory: \`${f.refs}\``);
    expect(prompt).toContain("- `schema` — Schema");
    expect(prompt).toContain(`File: \`${join(f.skill, "SKILL.md")}\``);
    expect(readFileSync(join(f.refs, "examples.json"), "utf8")).toBe('{"example":true}');
    expect(existsSync(join(f.skill, "scripts", "check.sh"))).toBe(true);
    expect(readdirSync(f.directory)).toEqual(before);
  });

  it("locates nested references relative to their original resource directory", () => {
    const f = fixture();
    writeFileSync(join(f.refs, "theory", "deep.md"), "Nested theory");
    f.planner.references.push({ name: "theory/deep", description: "Nested theory", scope: ReferenceScope.Role,
      relativePath: "references/theory/deep.md", filePath: join(f.refs, "theory", "deep.md") });
    const prompt = prepareDshGraphWorkerRolePrompt(f.roles, f.planner.id);
    expect(prompt).toContain(`Base directory: \`${f.refs}\``);
    expect(prompt).toContain("- `theory/deep` — Nested theory");
  });

  it("states the workspace without promising a custom command runner", () => {
    const f = fixture();
    const prompt = prepareDshGraphWorkerExecutionPrompt(f.roles, f.planner.id, f.workspace);
    expect(prompt).toContain(`Worker workspace: ${f.workspace}.`);
    expect(prompt).not.toContain("## Role instructions");
    expect(prompt).not.toContain("Worker command boundary:");
  });

  it("refuses unknown agents and invalid workspaces", () => {
    const f = fixture();
    expect(() => prepareDshGraphWorkerExecutionPrompt(f.roles, "missing", f.workspace)).toThrow("not resolved");
    expect(() => prepareDshGraphWorkerRolePrompt(f.roles, "missing")).toThrow("not resolved");
    for (const workspace of ["", "   ", "relative/workspace"]) {
      expect(() => prepareDshGraphWorkerExecutionPrompt(f.roles, f.planner.id, workspace))
        .toThrow("The 'workspace' argument must be a non-blank absolute path");
    }
  });
});

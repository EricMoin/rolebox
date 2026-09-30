import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FunctionSource, ReferenceScope } from "../../../../src/constants.ts";
import { prepareDshGraphWorkerPrompt } from "../../../../src/platform/adapters/dsh/worker-prompt.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../../../src/types.ts";

/** The host resolves a session policy per attempt; these tests state one explicitly. */
const CONFINED = { kind: "confined", mode: "workspace-write", workspaceRoot: "/workspace/example" } as const;

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-worker-prompt-"));
  directories.push(directory);
  const refs = join(directory, "roles", "planner", "references");
  const skill = join(directory, "roles", "planner", "skills", "research");
  mkdirSync(refs, { recursive: true });
  mkdirSync(join(skill, "scripts"), { recursive: true });
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
  const inputDirectory = join(directory, "data", "inputs", "attempt");
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  return { directory, inputDirectory, workspace, planner, roles: [parent], refs, skill };
}

function resourcePaths(prompt: string) {
  return {
    reference: prompt.match(/<path>([^<]+)<\/path>/)![1],
    skill: prompt.match(/<location>([^<]+)<\/location>/)![1],
  };
}

describe("DSH graph worker prompt", () => {
  it("omits inactive function instructions that the worker cannot activate", () => {
    const f = fixture();
    f.planner.functions.push({
      name: "loop", description: "Orchestrate", content: "Inactive orchestration instructions.",
      filePath: "loop.md", source: FunctionSource.RoleLocal,
    });
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, CONFINED);
    expect(prompt).not.toContain("<available_functions>");
    expect(prompt).not.toContain("Inactive orchestration instructions.");
    expect(prompt).toContain("Return a Strategy.");
    expect(prompt).toContain("graph_submit_outcome");
  });

  it("uses only the target role and functions, with readable copies of its resources", () => {
    const f = fixture();
    f.planner.references.push({ ...f.planner.references[0] });
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, CONFINED);
    expect(prompt).toContain("You are the planner.");
    expect(prompt).toContain("<active_functions>");
    expect(prompt).toContain("Return a Strategy.");
    expect(prompt).toContain("Use graph_worker_exec to read");
    for (const forbidden of ["You are the coordinator.", "triage", "Legacy rendered", "graph_declare", "Use the Read tool", "Use the skill tool", "available_subagents"]) {
      expect(prompt).not.toContain(forbidden);
    }
    expect(prompt.match(/<reference>/g)).toHaveLength(1);
    const paths = resourcePaths(prompt);
    expect(paths.reference.startsWith(f.inputDirectory)).toBe(true);
    expect(paths.skill.startsWith(f.inputDirectory)).toBe(true);
    expect(readFileSync(paths.reference, "utf8")).toContain("Strategy schema");
    expect(readFileSync(join(dirname(paths.reference), "examples.json"), "utf8")).toBe('{"example":true}');
    expect(readFileSync(join(dirname(paths.skill), "scripts", "check.sh"), "utf8")).toBe("printf checked");
    writeFileSync(join(f.refs, "schema.md"), "changed after dispatch");
    expect(readFileSync(paths.reference, "utf8")).toContain("Strategy schema");
  });

  it("gives separate attempts independent resource copies", () => {
    const f = fixture();
    const first = resourcePaths(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, CONFINED));
    const secondRoot = join(f.directory, "data", "inputs", "another-attempt");
    const second = resourcePaths(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, secondRoot, CONFINED));
    expect(first.reference).not.toBe(second.reference);
    expect(second.reference.startsWith(secondRoot)).toBe(true);
  });

  it("fails before dispatch for missing agents or resources and removes partial copies", () => {
    const f = fixture();
    expect(() => prepareDshGraphWorkerPrompt(f.roles, "missing", f.inputDirectory, CONFINED)).toThrow("not resolved");
    expect(existsSync(f.inputDirectory)).toBe(false);
    rmSync(join(f.refs, "schema.md"));
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, CONFINED)).toThrow();
    expect(readdirSync(f.inputDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses resource links outside the declared bundle", () => {
    const f = fixture();
    const privateFile = join(f.directory, "private.txt");
    writeFileSync(privateFile, "unrelated file");
    symlinkSync(privateFile, join(f.skill, "escape.txt"));
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, CONFINED)).toThrow("escaping or cyclic");
    expect(readdirSync(f.inputDirectory)).toEqual([]);
  });

  it("states the boundary the host resolved for this attempt, not a fixed writable set", () => {
    const f = fixture();
    const confined = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory,
      { kind: "confined", mode: "workspace-write", workspaceRoot: "/workspace/example" });
    expect(confined).toContain("'workspace-write' mode with workspace root /workspace/example");
    expect(confined).toContain("cannot confine this attempt more narrowly than the session's mode");
    const unconfined = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory,
      { kind: "unconfined", mode: "danger-full-access" });
    expect(unconfined).toContain("'danger-full-access'");
    expect(unconfined).toContain("UNCONFINED");
    const refused = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory,
      { kind: "refused", reason: "this host exposes no sandbox policy service" });
    expect(refused).toContain("no host sandbox policy service is available to this attempt");
    expect(refused).toContain("is refused rather than run without the boundary the session authorized");
    for (const prompt of [confined, unconfined, refused]) {
      // The fenced-json fallback and the tool face survive every boundary state.
      expect(prompt).toContain("```json");
      expect(prompt).toContain("graph_submit_outcome");
      expect(prompt).not.toContain("boundary.md");
    }
  });
});

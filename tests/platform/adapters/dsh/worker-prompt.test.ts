import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FunctionSource, ReferenceScope } from "../../../../src/constants.ts";
import { prepareDshGraphWorkerPrompt } from "../../../../src/platform/adapters/dsh/worker-prompt.ts";
import { executeGraphWorkerCommand } from "../../../../src/platform/sandbox/worker-exec.ts";
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
  it("uses only the target role and functions, with readable copies of its resources", () => {
    const f = fixture();
    f.planner.references.push({ ...f.planner.references[0] });
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory);
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
    const first = resourcePaths(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory));
    const secondRoot = join(f.directory, "data", "inputs", "another-attempt");
    const second = resourcePaths(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, secondRoot));
    expect(first.reference).not.toBe(second.reference);
    expect(second.reference.startsWith(secondRoot)).toBe(true);
  });

  it("fails before dispatch for missing agents or resources and removes partial copies", () => {
    const f = fixture();
    expect(() => prepareDshGraphWorkerPrompt(f.roles, "missing", f.inputDirectory)).toThrow("not resolved");
    expect(existsSync(f.inputDirectory)).toBe(false);
    rmSync(join(f.refs, "schema.md"));
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory)).toThrow();
    expect(readdirSync(f.inputDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses resource links outside the declared bundle", () => {
    const f = fixture();
    const privateFile = join(f.directory, "private.txt");
    writeFileSync(privateFile, "unrelated file");
    symlinkSync(privateFile, join(f.skill, "escape.txt"));
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory)).toThrow("escaping or cyclic");
    expect(readdirSync(f.inputDirectory)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")("allows sandbox reads of delivered resources while denying writes and neighboring inputs", async () => {
    const f = fixture();
    const paths = resourcePaths(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory));
    const neighbor = join(f.directory, "data", "inputs", "neighbor.txt");
    writeFileSync(neighbor, "another attempt");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const run = (command: string) => executeGraphWorkerCommand({ command, workspace: f.workspace,
      dataDirectory: join(f.directory, "data"), inputPaths: [f.inputDirectory], timeoutMs: 10_000 });
    const read = await run(`cat ${quote(paths.reference)} ${quote(paths.skill)}`);
    expect(read.exitCode).toBe(0);
    expect(read.output).toContain("Strategy schema");
    expect(read.output).toContain("scripts/check.sh");
    expect((await run(`printf changed > ${quote(paths.reference)}`)).exitCode).not.toBe(0);
    expect((await run(`cat ${quote(neighbor)}`)).exitCode).not.toBe(0);
    expect((await run(`cat ${quote(join(f.refs, "schema.md"))}`)).exitCode).not.toBe(0);
    expect(readFileSync(paths.reference, "utf8")).toContain("Strategy schema");
  });
});

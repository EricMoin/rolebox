import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  const inputDirectory = join(directory, "data", "inputs", "attempt");
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  return { directory, inputDirectory, workspace, planner, roles: [parent], refs, skill };
}

/** How many times a pattern matches — a count, never a truthiness check on `match`. */
function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** The directory the reference block states once, shared by every entry. */
function referenceBase(prompt: string): string {
  expect(countMatches(prompt, /^Base directory: `/gm)).toBe(1);
  return prompt.match(/^Base directory: `([^`\n]+)`$/m)![1];
}

/**
 * The readable private copy a reference bullet advertises: the block states the
 * base once and each bullet names its own file below it (the resolver names a
 * reference after its path under `references/` without the extension). The path
 * is derived from the prompt, so this asserts the worker can actually reach the
 * copy — not merely that the prompt mentions a path.
 */
function referencePath(prompt: string, name: string): string {
  expect(countMatches(prompt, new RegExp("^- `" + name + "` — ", "gm"))).toBe(1);
  const copy = join(referenceBase(prompt), `${name}.md`);
  expect(existsSync(copy)).toBe(true);
  expect(readFileSync(copy, "utf8").length).toBeGreaterThan(0);
  return copy;
}

/** Every regular file under a directory tree — the private copies a worker may read. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("DSH graph worker prompt", () => {
  it("omits inactive function instructions that the worker cannot activate", () => {
    const f = fixture();
    f.planner.functions.push({
      name: "loop", description: "Orchestrate", content: "Inactive orchestration instructions.",
      filePath: "loop.md", source: FunctionSource.RoleLocal,
    });
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED);
    expect(prompt).not.toContain("## Available functions");
    expect(prompt).not.toContain("Inactive orchestration instructions.");
    expect(prompt).toContain("Return a Strategy.");
    expect(prompt).toContain("graph_submit_outcome");
  });

  it("uses only the target role and functions, with readable copies of its resources", () => {
    const f = fixture();
    f.planner.references.push({ ...f.planner.references[0] });
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED);
    expect(prompt).toContain("## Role instructions\n\nYou are the planner.");
    expect(prompt).toContain("You are the planner.");
    expect(prompt).toContain("## Active functions");
    expect(prompt).toContain("Return a Strategy.");
    expect(prompt).toContain("Use graph_worker_exec to read");
    for (const forbidden of ["You are the coordinator.", "triage", "Legacy rendered", "graph_declare", "Use the Read tool", "Use the skill tool", "## Available sub-agents"]) {
      expect(prompt).not.toContain(forbidden);
    }
    // Two identical references collapse into one rendered entry: one bullet,
    // no second `` `name`: `path` `` line, and the base stated once.
    expect(countMatches(prompt, /^- `schema` — /gm)).toBe(1);
    expect(prompt).not.toMatch(/^ {2}`schema`: /m);
    // The skill bullet carries name and description only; its private copy is
    // delivered under the attempt's input directory and readable from there.
    expect(prompt).toContain("## Available skills");
    expect(prompt).toContain("- `research` — Research");
    const reference = referencePath(prompt, "schema");
    // Base + the entry's own name land inside the attempt's delivery directory,
    // and the advertised file is the readable copy of the role's reference.
    expect(referenceBase(prompt).startsWith(f.inputDirectory)).toBe(true);
    expect(reference.startsWith(f.inputDirectory)).toBe(true);
    expect(readFileSync(reference, "utf8")).toContain("Strategy schema");
    expect(readFileSync(join(dirname(reference), "examples.json"), "utf8")).toBe('{"example":true}');
    const copies = filesUnder(f.inputDirectory);
    const skillCopy = copies.find((path) => basename(path) === "SKILL.md")!;
    expect(skillCopy.startsWith(f.inputDirectory)).toBe(true);
    expect(readFileSync(skillCopy, "utf8")).toBe("Read scripts/check.sh beside this skill.");
    expect(readFileSync(join(dirname(skillCopy), "scripts", "check.sh"), "utf8")).toBe("printf checked");
    writeFileSync(join(f.refs, "schema.md"), "changed after dispatch");
    expect(readFileSync(reference, "utf8")).toContain("Strategy schema");
  });

  it("locates every delivered reference from the base it states once", () => {
    const f = fixture();
    // A realistic bundle: a flat reference beside a nested one, all named below
    // `references/`. The block states that one directory and each bullet names
    // its own file below it, so every entry has to resolve to a readable copy.
    writeFileSync(join(f.refs, "theory", "deep.md"), "Nested theory; read ./examples.json beside it.");
    writeFileSync(join(f.refs, "theory", "examples.json"), '{"nested":true}');
    f.planner.references.push({
      name: "theory/deep", description: "Nested theory",
      scope: ReferenceScope.Role, relativePath: "references/theory/deep.md",
      filePath: join(f.refs, "theory", "deep.md"),
    });
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED);

    // One base line for both entries, one bullet per entry, no path line.
    expect(countMatches(prompt, /^Base directory: `/gm)).toBe(1);
    expect(countMatches(prompt, /^- `schema` — /gm)).toBe(1);
    expect(countMatches(prompt, /^- `theory\/deep` — /gm)).toBe(1);
    expect(prompt).not.toMatch(/^ {2}`/m);
    const flat = referencePath(prompt, "schema");
    const nested = referencePath(prompt, "theory/deep");
    expect(flat.startsWith(f.inputDirectory)).toBe(true);
    expect(nested.startsWith(f.inputDirectory)).toBe(true);
    expect(readFileSync(nested, "utf8")).toContain("Nested theory");
    expect(readFileSync(join(dirname(nested), "examples.json"), "utf8")).toBe('{"nested":true}');
    expect(nested).not.toBe(flat);
  });

  it("gives separate attempts independent resource copies", () => {
    const f = fixture();
    const first = referencePath(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED), "schema");
    const secondRoot = join(f.directory, "data", "inputs", "another-attempt");
    const second = referencePath(prepareDshGraphWorkerPrompt(f.roles, f.planner.id, secondRoot, f.workspace, CONFINED), "schema");
    expect(first).not.toBe(second);
    expect(second.startsWith(secondRoot)).toBe(true);
  });

  it("fails before dispatch for missing agents or resources and removes partial copies", () => {
    const f = fixture();
    expect(() => prepareDshGraphWorkerPrompt(f.roles, "missing", f.inputDirectory, f.workspace, CONFINED)).toThrow("not resolved");
    expect(existsSync(f.inputDirectory)).toBe(false);
    rmSync(join(f.refs, "schema.md"));
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED)).toThrow();
    expect(readdirSync(f.inputDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses resource links outside the declared bundle", () => {
    const f = fixture();
    const privateFile = join(f.directory, "private.txt");
    writeFileSync(privateFile, "unrelated file");
    symlinkSync(privateFile, join(f.skill, "escape.txt"));
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED)).toThrow("escaping or cyclic");
    expect(readdirSync(f.inputDirectory)).toEqual([]);
  });

  it("states the boundary the host resolved for this attempt, not a fixed writable set", () => {
    const f = fixture();
    const confined = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace,
      { kind: "confined", mode: "workspace-write", workspaceRoot: "/workspace/example" });
    expect(confined).toContain("'workspace-write' mode with workspace root /workspace/example");
    expect(confined).toContain("cannot confine this attempt more narrowly than the session's mode");
    const unconfined = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace,
      { kind: "unconfined", mode: "danger-full-access" });
    expect(unconfined).toContain("'danger-full-access'");
    expect(unconfined).toContain("UNCONFINED");
    const refused = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace,
      { kind: "refused", reason: "this host exposes no sandbox policy service" });
    expect(refused).toContain("no host sandbox policy service is available to this attempt");
    expect(refused).toContain("is refused rather than run without the boundary the session authorized");
    for (const prompt of [confined, unconfined, refused]) {
      // The fenced-json fallback, the tool face and the workspace fact survive
      // every boundary state — including the unconfined one, whose boundary block
      // names no path at all.
      expect(prompt).toContain("```json");
      expect(prompt).toContain("graph_submit_outcome");
      expect(prompt).not.toContain("boundary.md");
      expect(prompt).toContain(`every graph_worker_exec command runs with ${f.workspace} as its current directory`);
    }
  });

  it("states the workspace every command starts in, so a worker never has to cd into it", () => {
    const f = fixture();
    const prompt = prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, f.workspace, CONFINED);
    expect(prompt).toContain(`every graph_worker_exec command runs with ${f.workspace} as its current directory`);
    expect(prompt).toContain("and a relative path in the command resolves against it.");
    expect(prompt).toContain("Each call is a fresh shell, so a `cd` is not needed to reach this workspace");
    expect(prompt).toContain("use one only to run in a different directory.");
    // The workspace sentence lands after the boundary block and before the role
    // prompt, so a worker reads the directory before its instructions.
    expect(prompt.indexOf("Worker working directory:")).toBeGreaterThan(prompt.indexOf("Worker command boundary:"));
    expect(prompt.indexOf("Worker working directory:")).toBeLessThan(prompt.indexOf("## Role instructions"));
  });

  it("refuses a blank or relative workspace before it copies anything", () => {
    const f = fixture();
    for (const workspace of ["", "   ", "relative/workspace"]) {
      expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, workspace, CONFINED))
        .toThrow("The 'workspace' argument must be a non-blank absolute path");
    }
    expect(() => prepareDshGraphWorkerPrompt(f.roles, f.planner.id, f.inputDirectory, "relative/workspace", CONFINED))
      .toThrow('"relative/workspace"');
    expect(existsSync(f.inputDirectory)).toBe(false);
  });
});

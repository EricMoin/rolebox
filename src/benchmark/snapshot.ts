import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { DEFAULT_FUNCTIONS } from "../constants.ts";

export interface BenchmarkRoleSnapshot {
  roleId: string;
  digest: string;
  files: ReadonlyMap<string, Buffer>;
  executableFiles: ReadonlySet<string>;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 2048;

function localPath(base: string, name: string, boundary = base): string {
  const path = resolve(base, name);
  const rel = relative(boundary, path);
  if (isAbsolute(name) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Benchmark role dependencies must stay inside their role directory");
  }
  return path;
}

export async function snapshotBenchmarkRole(directory: string): Promise<BenchmarkRoleSnapshot> {
  const root = resolve(directory);
  const roleId = basename(root);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(roleId) || roleId.includes("--")) {
    throw new Error("Benchmark role directory must have a valid role identifier");
  }
  const files = new Map<string, Buffer>();
  const executableFiles = new Set<string>();
  let bytes = 0;
  async function collect(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Benchmark v1 requires role assets without symlinks");
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if ([".git", "node_modules", ".rolebox"].includes(name)) {
          throw new Error("Benchmark role bundles must not contain repository, dependency, or runtime state directories");
        }
        await collect(join(path, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("Benchmark role bundles only support regular files");
    if (bytes + stat.size > MAX_BYTES || files.size >= MAX_FILES) throw new Error("Benchmark role snapshot exceeds its size limit");
    const content = await readFile(path);
    bytes += content.length;
    if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new Error("Benchmark role snapshot exceeds its size limit");
    const name = relative(root, path).split(sep).join("/");
    files.set(name, content);
    if (stat.mode & 0o111) executableFiles.add(name);
  }
  await collect(root);
  const initial = new Map(files);
  const initialExecutable = new Set(executableFiles);
  files.clear();
  executableFiles.clear();
  bytes = 0;
  await collect(root);
  if (files.size !== initial.size || [...files].some(([name, content]) => !initial.get(name)?.equals(content) || executableFiles.has(name) !== initialExecutable.has(name))) {
    throw new Error("Role files changed while taking the snapshot; retry after saving finishes");
  }
  if (!files.has("role.yaml")) throw new Error("Benchmark target is missing role.yaml");

  const builtin = fileURLToPath(new URL("../../functions/", import.meta.url));
  function hasFile(path: string): boolean {
    return files.has(relative(root, path).split(sep).join("/"));
  }
  function parse(source: string): unknown {
    try { return yaml.load(source, { schema: yaml.JSON_SCHEMA }); }
    catch { throw new Error("Benchmark role metadata is not valid YAML"); }
  }
  async function inspect(config: unknown, base: string, promptBase = base, isRole = true, inlineDepth = 0): Promise<void> {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid benchmark role definition");
    const role = config as Record<string, unknown>;
    if (JSON.stringify(role).includes("{env:")) throw new Error("Benchmark v1 role snapshots do not support environment substitutions");
    for (const key of ["open_roles", "opencode_skills", "skills", "functions", "disable_functions", "subagents"]) {
      if (role[key] !== undefined && !Array.isArray(role[key])) throw new Error("Benchmark role list fields must be arrays");
    }
    if (isRole && (typeof role.name !== "string" || !role.name.trim() || (role.prompt_file === undefined && (typeof role.prompt !== "string" || !role.prompt.trim())))) {
      throw new Error("Benchmark roles and subagents require a name and a prompt or prompt_file");
    }
    if (isRole && inlineDepth > 0 && typeof role.name === "string" && role.name.includes("--")) {
      throw new Error("Benchmark subagent names must not contain the reserved separator");
    }
    if (Array.isArray(role.open_roles) && role.open_roles.length > 0) throw new Error("Benchmark v1 requires a self-contained role without open_roles");
    if (Array.isArray(role.opencode_skills) && role.opencode_skills.length > 0) throw new Error("Copy global skills into the benchmark role before running");
    if (role.prompt_file !== undefined) {
      if (typeof role.prompt_file !== "string" || !hasFile(localPath(promptBase, role.prompt_file, root))) {
        throw new Error("A benchmark role prompt_file is missing from its snapshot");
      }
      const prompt = files.get(relative(root, localPath(promptBase, role.prompt_file, root)).split(sep).join("/"))!;
      if (prompt.includes("{env:")) throw new Error("Benchmark v1 role snapshots do not support environment substitutions");
    }
    for (const name of Array.isArray(role.skills) ? role.skills : []) {
      if (typeof name !== "string") throw new Error("Invalid benchmark role skill name");
      const skill = localPath(join(base, "skills"), name);
      if (!hasFile(join(skill, "SKILL.md")) && !hasFile(`${skill}.md`)) throw new Error(`Missing local skill: ${name}`);
    }
    const functions = isRole ? [...new Set([...DEFAULT_FUNCTIONS, ...(Array.isArray(role.functions) ? role.functions : [])])].filter(name => !(Array.isArray(role.disable_functions) && role.disable_functions.includes(name))) : [];
    for (const name of functions) {
      if (typeof name !== "string") throw new Error("Invalid benchmark role function name");
      const fn = localPath(join(base, "functions"), `${name}.md`);
      if (!hasFile(fn)) {
        try {
          const builtinPath = localPath(builtin, `${name}.md`);
          const info = await lstat(builtinPath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Not a regular built-in function");
          if (bytes + info.size > MAX_BYTES || files.size >= MAX_FILES) throw new Error("Function snapshot exceeds size limit");
          const content = await readFile(builtinPath);
          bytes += content.length;
          if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new Error("Function snapshot exceeds size limit");
          files.set(relative(root, fn).split(sep).join("/"), content);
        }
        catch { throw new Error(`Missing local or built-in function: ${name}`); }
      }
    }
    if (role.references !== undefined && (!role.references || typeof role.references !== "object" || Array.isArray(role.references))) throw new Error("Benchmark references must be a mapping");
    if (role.references && typeof role.references === "object" && !Array.isArray(role.references)) {
      for (const value of Object.values(role.references)) {
        const ref = value && typeof value === "object" ? (value as Record<string, unknown>).path : undefined;
        const path = typeof value === "string" ? value : ref;
        if (typeof path !== "string" || !path) throw new Error("Benchmark references require a file path");
        if (!hasFile(localPath(base, path, root))) throw new Error("An explicit reference is missing from the role snapshot");
      }
    }
    for (const child of Array.isArray(role.subagents) ? role.subagents : []) {
      if (typeof child === "string") throw new Error("Benchmark v1 requires inline or role-local file-based subagents");
      const name = child && typeof child === "object" ? (child as Record<string, unknown>).name : undefined;
      const childDirectory = typeof name === "string" ? localPath(join(base, "subagents"), name.toLowerCase().replace(/\s+/g, "-")) : base;
      const namedDirectory = typeof name === "string" ? localPath(join(base, "subagents"), name) : base;
      const prefix = `${relative(root, childDirectory).split(sep).join("/")}/`;
      const namedPrefix = `${relative(root, namedDirectory).split(sep).join("/")}/`;
      const assets = [...files.keys()].some(path => path.startsWith(prefix)) ? childDirectory : [...files.keys()].some(path => path.startsWith(namedPrefix)) ? namedDirectory : base;
      const childPromptBase = inlineDepth >= 2 && typeof role.prompt_file === "string" ? dirname(localPath(promptBase, role.prompt_file, root)) : promptBase;
      await inspect(child, assets, childPromptBase, true, inlineDepth + 1);
    }
  }
  for (const [name, content] of files) {
    if (basename(name) === "role.yaml") await inspect(parse(content.toString("utf8")), dirname(join(root, name)), undefined, true, name === "role.yaml" ? 0 : 1);
    if (name.endsWith(".md")) {
      const frontmatter = content.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (frontmatter) {
        const metadata = parse(frontmatter[1]);
        if (metadata && typeof metadata === "object" && "references" in metadata) {
          await inspect({ references: (metadata as Record<string, unknown>).references }, dirname(join(root, name)), undefined, false);
        }
      }
    }
  }
  const hash = createHash("sha256");
  for (const [name, content] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(JSON.stringify([name, content.length, executableFiles.has(name)])).update(content);
  return { roleId, digest: hash.digest("hex"), files, executableFiles };
}

export async function materializeBenchmarkRole(snapshot: BenchmarkRoleSnapshot, rolesDirectory: string): Promise<void> {
  for (const [name, content] of snapshot.files) {
    const path = join(rolesDirectory, snapshot.roleId, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: snapshot.executableFiles.has(name) ? 0o500 : 0o400, flag: "wx" });
  }
}

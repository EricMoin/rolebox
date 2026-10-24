import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { getSyncTarget } from "../../src/cli/paths.ts";
import { parseFrontmatter } from "../../src/resolver/frontmatter.ts";

export interface TeamSmokeRole {
  id: string;
  sourceDir: string;
  directory: string;
  childIds: string[];
}

export interface TeamSmokeRoles {
  roleboxDir: string;
  engineer: TeamSmokeRole;
  designer: TeamSmokeRole;
}

class RoleSnapshotError extends Error {}

type Config = Record<string, unknown>;
interface Snapshot {
  id: string;
  sourceDir: string;
  files: Map<string, Buffer>;
  childIds: string[];
}

function record(value: unknown): value is Config {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function snapshotRole(sourceRoleboxDir: string, id: string): Snapshot {
  const sourceDir = join(sourceRoleboxDir, id);
  if (!lstatSync(sourceDir).isDirectory() || lstatSync(sourceDir).isSymbolicLink()) {
    throw new RoleSnapshotError("Team smoke requires materialized installed role directories");
  }
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new RoleSnapshotError("Team smoke role assets must not contain symbolic links");
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) throw new RoleSnapshotError("Team smoke role assets must be regular files");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new RoleSnapshotError("Team smoke role assets must be regular files");
        totalBytes += stat.size;
        if (totalBytes > 20 * 1024 * 1024 || files.size >= 1000) throw new RoleSnapshotError("Team smoke role snapshot exceeds its size limit");
        files.set(relative(sourceDir, path), readFileSync(fd));
      } finally { closeSync(fd); }
    }
  };
  walk(sourceDir);
  const localFile = (base: string, path: unknown): string => {
    if (typeof path !== "string" || !path || isAbsolute(path)) throw new RoleSnapshotError("Team smoke role dependencies must be relative local files");
    const resolved = resolve(base, path);
    if (!inside(sourceDir, resolved) || !files.has(relative(sourceDir, resolved))) {
      throw new RoleSnapshotError("Team smoke role has a missing or external file dependency");
    }
    return resolved;
  };
  const refs = (base: string, value: unknown) => {
    if (value === undefined) return;
    if (!record(value)) throw new RoleSnapshotError("Team smoke role references require an explicit local mapping");
    for (const entry of Object.values(value)) localFile(base, typeof entry === "string" ? entry : record(entry) ? entry.path : undefined);
  };
  const configAt = (directory: string): Config => {
    const bytes = files.get(relative(sourceDir, join(directory, "role.yaml")));
    if (!bytes) throw new RoleSnapshotError("A required team smoke role definition is missing");
    const config: unknown = yaml.load(bytes.toString("utf8"));
    if (!record(config)) throw new RoleSnapshotError("A team smoke role definition is invalid");
    return config;
  };
  const validateConfig = (config: Config, directory: string) => {
    if (/\{env:/.test(JSON.stringify(config))) throw new RoleSnapshotError("Team smoke roles must not resolve environment values into their configuration");
    if (config.prompt_file !== undefined) localFile(directory, config.prompt_file);
    else if (typeof config.prompt !== "string" || !config.prompt.trim()) throw new RoleSnapshotError("A team smoke role prompt is missing");
    refs(directory, config.references);
    if (config.opencode_skills !== undefined && (!Array.isArray(config.opencode_skills) || config.opencode_skills.length)) {
      throw new RoleSnapshotError("Team smoke roles must not depend on global skills");
    }
    if (config.skills !== undefined && !Array.isArray(config.skills)) throw new RoleSnapshotError("Team smoke role skills must be local names");
    for (const skill of (config.skills ?? []) as unknown[]) {
      if (typeof skill !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skill)) throw new RoleSnapshotError("Team smoke role skills must be local names");
      const candidates = [join(directory, "skills", skill, "SKILL.md"), join(directory, "skills", `${skill}.md`)];
      if (!candidates.some(path => files.has(relative(sourceDir, path)))) throw new RoleSnapshotError("A team smoke role skill is not bundled locally");
    }
    if (config.functions !== undefined && (!Array.isArray(config.functions) || config.functions.length)) {
      throw new RoleSnapshotError("Team smoke roles with custom function dependencies require an explicit fixture adapter");
    }
  };
  const childIds: string[] = [];
  const visit = (config: Config, directory: string, parentId: string, depth: number, discoverFiles = true) => {
    if (depth > 3) throw new RoleSnapshotError("Team smoke role nesting exceeds the supported depth");
    validateConfig(config, directory);
    const children = new Map<string, { config: Config; directory: string; discoverFiles: boolean }>();
    const prefix = relative(sourceDir, join(directory, "subagents"));
    for (const file of discoverFiles ? files.keys() : []) {
      const parts = relative(prefix, file).split(sep);
      if (parts.length !== 2 || parts[0] === ".." || parts[1] !== "role.yaml") continue;
      const childDirectory = join(sourceDir, dirname(file));
      const child = configAt(childDirectory);
      if (typeof child.name !== "string") throw new RoleSnapshotError("A team smoke child role name is invalid");
      children.set(child.name, { config: child, directory: childDirectory, discoverFiles: true });
    }
    if (config.subagents !== undefined && !Array.isArray(config.subagents)) throw new RoleSnapshotError("Team smoke child roles must be explicit definitions");
    for (const child of (config.subagents ?? []) as unknown[]) {
      if (!record(child) || typeof child.name !== "string") throw new RoleSnapshotError("A team smoke child role definition is invalid");
      children.set(child.name, { config: child, directory, discoverFiles: false });
    }
    for (const [name, child] of children) {
      if (!name.trim() || name.includes("--")) throw new RoleSnapshotError("A team smoke child role name is invalid");
      const childId = `${parentId}--${name.toLowerCase().replace(/\s+/g, "-")}`;
      childIds.push(childId);
      visit(child.config, child.directory, childId, depth + 1, child.discoverFiles);
    }
  };
  visit(configAt(sourceDir), sourceDir, id, 0);
  for (const [path, bytes] of files) {
    if (path.endsWith(".md")) refs(dirname(join(sourceDir, path)), parseFrontmatter(bytes.toString("utf8")).metadata.references);
  }
  return { id, sourceDir, files, childIds: [...new Set(childIds)].sort() };
}

/** Copy exact installed role bytes; callers keep the returned private paths out of logs. */
export function prepareTeamSmokeRoles(root: string, options: { sourceRoleboxDir?: string } = {}): TeamSmokeRoles {
  let created: string | undefined;
  try {
    const workspace = realpathSync(root);
    const sourceRoleboxDir = realpathSync(options.sourceRoleboxDir ?? getSyncTarget("dsh"));
    if (workspace === sourceRoleboxDir || inside(sourceRoleboxDir, workspace)) throw new RoleSnapshotError("Team smoke snapshots must be outside the installed role directory");
    const engineer = snapshotRole(sourceRoleboxDir, "typescript-engineer");
    const designer = snapshotRole(sourceRoleboxDir, "ai-designer");
    const roleboxDir = join(workspace, "roles");
    mkdirSync(roleboxDir, { mode: 0o700 });
    created = roleboxDir;
    const copy = (source: Snapshot): TeamSmokeRole => {
      const directory = join(roleboxDir, source.id);
      for (const [file, bytes] of source.files) {
        const destination = join(directory, file);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      }
      return { id: source.id, sourceDir: source.sourceDir, directory, childIds: source.childIds };
    };
    return { roleboxDir, engineer: copy(engineer), designer: copy(designer) };
  } catch (error) {
    if (created) rmSync(created, { recursive: true, force: true });
    if (error instanceof RoleSnapshotError) throw error;
    throw new RoleSnapshotError("Unable to prepare the isolated installed-role snapshot");
  }
}

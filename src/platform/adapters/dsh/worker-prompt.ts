import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildAgentPrompt, buildAvailableFunctionsBlock, buildFunctionBlock } from "../../../prompt/builder.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../../types.ts";
import type { DshWorkerCommandBoundary } from "./graph-worker.ts";

type WorkerRole = ResolvedRole | ResolvedSubAgent;

function findAgent(agents: readonly WorkerRole[], id: string): WorkerRole | undefined {
  for (const agent of agents) {
    if (agent.id === id) return agent;
    const nested = findAgent(agent.subagents, id);
    if (nested) return nested;
  }
  return undefined;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function copyResource(source: string, destination: string, root: string, ancestors = new Set<string>()): void {
  const actual = realpathSync(source);
  if (!inside(root, actual) || ancestors.has(actual)) {
    throw new Error("Worker resource contains an escaping or cyclic symbolic link");
  }
  const stat = statSync(actual);
  if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, readFileSync(actual), { flag: "wx", mode: 0o400 | (stat.mode & 0o100) });
    return;
  }
  if (!stat.isDirectory()) throw new Error("Worker resources must be regular files or directories");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const visited = new Set([...ancestors, actual]);
  for (const name of readdirSync(actual).sort()) {
    copyResource(join(actual, name), join(destination, name), root, visited);
  }
}

function referenceRoot(filePath: string): string {
  for (let directory = dirname(filePath); dirname(directory) !== directory; directory = dirname(directory)) {
    if (basename(directory) === "references") return directory;
  }
  return filePath;
}

/**
 * State the boundary the host resolves for THIS attempt. rolebox owns no OS
 * profile any more, so the prompt cannot promise a fixed writable set: a
 * confined mode names the host's mode and workspace root, an unconfined
 * session says so plainly, and an unavailable host service says the command will
 * be refused instead of implying a boundary that would not be applied.
 */
function boundaryBlock(boundary: DshWorkerCommandBoundary): string {
  const shell = "The shell is /bin/sh, not bash: process substitution <(...) is a syntax error, while brace expansion and arrays work.";
  const disposable = "HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME and TMPDIR are disposable per-command directories without credentials, so a command needing real credentials or host state (git push, gh, npm publish, authenticated API calls) cannot succeed.";
  const reported = "Every command result reports the effective mode and the enforcement the host achieved, and names the backend's denial signatures when that enforcement is partial, so a boundary denial is distinguishable from a command failure.";
  if (boundary.kind === "confined") {
    return `Worker command boundary: the host's session sandbox policy resolves this attempt to the '${boundary.mode}' mode with workspace root ${boundary.workspaceRoot}, ` +
      "and the host's confinement service applies that policy to every graph_worker_exec command. rolebox adds no profile of its own and cannot confine this attempt more narrowly than the session's mode. " +
      "A path the host's confinement denies is a boundary denial, not a failed task: work inside the paths the mode allows, or report the denial. " +
      `${reported} ${disposable} ${shell}`;
  }
  if (boundary.kind === "unconfined") {
    return "Worker command boundary: the host's session sandbox policy resolves this attempt to 'danger-full-access', so graph_worker_exec runs commands UNCONFINED — " +
      "no OS restriction beyond what the host session already authorizes, and rolebox does not narrow the mode the session granted. " +
      `${reported} ${disposable} ${shell}`;
  }
  return "Worker command boundary: no host sandbox policy service is available to this attempt " +
    `(${boundary.reason}), so every graph_worker_exec command is refused rather than run without the boundary the session authorized. ${shell}`;
}

/** Copy only this role's resource bundles into its attempt's sandbox-readable input directory. */
export function prepareDshGraphWorkerPrompt(roles: readonly ResolvedRole[], agentId: string, inputDirectory: string, boundary: DshWorkerCommandBoundary): string {
  const agent = findAgent(roles, agentId);
  if (!agent) throw new Error(`Graph worker agent is not resolved: ${agentId}`);
  mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
  const resourceDirectory = mkdtempSync(join(inputDirectory, "role-resources-"));
  try {
    const roots = new Map<string, string>();
    const deliver = (filePath: string, sourceRoot: string): string => {
      const root = resolve(sourceRoot);
      let destination = roots.get(root);
      if (!destination) {
        const token = createHash("sha256").update(root).digest("hex");
        destination = join(resourceDirectory, token, basename(root));
        copyResource(root, destination, realpathSync(root));
        roots.set(root, destination);
      }
      const copied = join(destination, relative(root, resolve(filePath)));
      if (!inside(destination, copied) || !lstatSync(copied).isFile()) {
        throw new Error("Worker resource was not delivered as a regular file");
      }
      return copied;
    };
    const skills = agent.skills.map(skill => ({
      ...skill,
      filePath: deliver(skill.filePath, dirname(skill.filePath)),
    }));
    const references = [...new Map(agent.references.map(ref => [resolve(ref.filePath), ref])).values()].map(ref => ({
      ...ref,
      filePath: deliver(ref.filePath, referenceRoot(ref.filePath)),
    }));
    const activeNames = new Set(agent.auto_activate ?? agent.config.auto_activate ?? []);
    const active = agent.functions.filter(fn => activeNames.has(fn.name));
    const available = agent.functions.filter(fn => !activeNames.has(fn.name));
    return [
      "You are a graph worker assigned to the role below. Complete only the dispatched task. " +
        "Your tools are graph_worker_exec and graph_submit_outcome. Use graph_worker_exec for all file reads, commands and permitted edits. " +
        "You cannot dispatch agents or inspect/control graph state. Resource paths below are private copies for this attempt. " +
        "Submit only a declared outcome using the host handoff; an accepted submission settles your attempt. A prose answer does not settle it. " +
        "If the tool call does not settle your attempt, end your final message with exactly one fenced ```json block of the form " +
        "{\"outcome_id\": \"<an outcome this node declares>\", \"data\": <the outcome payload>, \"evidence_refs\": [\"<path>\"]} " +
        "— the host reads your last turn's output when no submission arrives, and exactly one such block is required for it to be used.",
      boundaryBlock(boundary),

      buildAgentPrompt(agent.config, skills, { references, canDelegate: false, resourceTool: "graph_worker_exec" }),
      buildFunctionBlock(active),
      buildAvailableFunctionsBlock(available),
    ].filter(Boolean).join("\n\n");
  } catch (error) {
    rmSync(resourceDirectory, { recursive: true, force: true });
    throw error;
  }
}

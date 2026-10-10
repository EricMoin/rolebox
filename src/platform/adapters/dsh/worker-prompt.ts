import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildGraphWorkerRolePrompt,
  buildGraphWorkerToolGrantBlock,
  findGraphWorkerRole,
} from "../../../prompt/graph-worker.ts";
import type { ResolvedRole } from "../../../types.ts";
import type { DshWorkerCommandBoundary } from "./graph-worker.ts";
import { disposableEnvironmentHint, getSystem } from "../../system/index.ts";

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
  // Both facts are read from the detected system descriptor (src/platform/system/)
  // rather than written out here, so the prompt cannot promise one OS's shell or
  // variable names on a host where the runner applies another's.
  const system = getSystem();
  const shell = system.shellHint;
  const disposable = `${disposableEnvironmentHint(system)} are disposable per-command directories without credentials, so a command needing real credentials or host state (git push, gh, npm publish, authenticated API calls) cannot succeed.`;
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

/**
 * State the directory every command of THIS attempt runs in. The runner spawns
 * each `graph_worker_exec` command with the attempt's worker workspace as its
 * child `cwd`, so the prompt names that fact instead of leaving the model to
 * discover it — or to prefix every command with a `cd` into a directory it
 * already starts in.
 */
function workspaceBlock(workspace: string): string {
  return `Worker working directory: every graph_worker_exec command runs with ${workspace} as its current directory, ` +
    "and a relative path in the command resolves against it. Each call is a fresh shell, so a `cd` is not needed to reach " +
    "this workspace — use one only to run in a different directory.";
}

/**
 * Copy only this role's resource bundles into its attempt's sandbox-readable
 * input directory, and assemble the worker's system prompt.
 *
 * `workspace` is the directory every `graph_worker_exec` command of THIS attempt
 * runs in: the attempt's worker workspace, which the prompt states so the worker
 * neither has to discover it nor re-enter it on each call. It is REQUIRED and
 * validated here — a blank or relative path is a caller defect, never a reason to
 * fall back to this process's own working directory.
 *
 * `declaredTools` is the EXECUTING NODE's own grant (the v3 `tools?: string[]`
 * beyond the baseline), which the caller resolves for THIS attempt. Omitting it
 * — or passing the empty list — states the baseline restriction, which is what
 * an undeclared node keeps.
 */
export function prepareDshGraphWorkerPrompt(roles: readonly ResolvedRole[], agentId: string, inputDirectory: string, workspace: string, boundary: DshWorkerCommandBoundary, declaredTools?: readonly string[]): string {
  if (typeof workspace !== "string" || workspace.trim().length === 0 || !isAbsolute(workspace)) {
    throw new Error(`The 'workspace' argument must be a non-blank absolute path: ${JSON.stringify(workspace)}`);
  }
  const agent = findGraphWorkerRole(roles, agentId);
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
    // The sentence names the tools the boundary will actually grant: the two
    // baseline entries alone when the node declares none, and the node's
    // declared host tools as well when it does.
    const toolsSentence =
      declaredTools === undefined || declaredTools.length === 0
        ? "Your tools are graph_worker_exec and graph_submit_outcome. "
        : "Your tools are graph_worker_exec, graph_submit_outcome and the host tools this node declares. ";
    return [
      "You are a graph worker assigned to the role below. Complete only the dispatched task. " +
        toolsSentence + "Use graph_worker_exec for all file reads, commands and permitted edits. " +
        "You cannot dispatch agents or inspect/control graph state. Resource paths below are private copies for this attempt. " +
        "Submit only a declared outcome using the host handoff; an accepted submission settles your attempt. A prose answer does not settle it. " +
        "If the tool call does not settle your attempt, end your final message with exactly one fenced ```json block of the form " +
        "{\"outcome_id\": \"<an outcome this node declares>\", \"data\": <the outcome payload>, \"evidence_refs\": [\"<path>\"]} " +
        "— the host reads your last turn's output when no submission arrives, and exactly one such block is required for it to be used.",
      buildGraphWorkerToolGrantBlock(declaredTools),
      boundaryBlock(boundary),
      workspaceBlock(workspace),

      buildGraphWorkerRolePrompt(agent, { skills, references, resourceTool: "graph_worker_exec" }),
    ].filter(Boolean).join("\n\n");
  } catch (error) {
    rmSync(resourceDirectory, { recursive: true, force: true });
    throw error;
  }
}

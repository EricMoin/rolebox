import { isAbsolute } from "node:path";
import {
  buildGraphWorkerRolePrompt,
  buildGraphWorkerToolGrantBlock,
  findGraphWorkerRole,
} from "../../../prompt/graph-worker.ts";
import type { ResolvedRole } from "../../../types.ts";
import type { WorkerToolPresentation } from "../../../graph/domain/worker-tools.ts";

export function prepareDshGraphWorkerPrompt(
  roles: readonly ResolvedRole[], agentId: string, workspace: string,
  declaredTools?: readonly string[], presentation?: WorkerToolPresentation,
): string {
  if (typeof workspace !== "string" || workspace.trim().length === 0 || !isAbsolute(workspace)) {
    throw new Error(`The 'workspace' argument must be a non-blank absolute path: ${JSON.stringify(workspace)}`);
  }
  const agent = findGraphWorkerRole(roles, agentId);
  if (!agent) throw new Error(`Graph worker agent is not resolved: ${agentId}`);
  return [
    "You are a graph worker assigned to the role below. Complete the dispatched task using the host's native tools and rolebox capabilities. " +
      "You cannot dispatch agents or inspect/control graph state. " +
      "Submit only a declared outcome using the host handoff; an accepted submission settles your attempt. A prose answer does not settle it. " +
      "If the tool call does not settle your attempt, end your final message with exactly one fenced ```json block of the form " +
      "{\"outcome_id\": \"<an outcome this node declares>\", \"data\": <the outcome payload>, \"evidence_refs\": [\"<path>\"]} " +
      "— the host reads your last turn's output when no submission arrives, and exactly one such block is required for it to be used.",
    buildGraphWorkerToolGrantBlock(declaredTools, presentation),
    `Worker workspace: ${workspace}. Use the host's native command and file tools; their working-directory behavior, permissions and sandbox policy apply.`,
    buildGraphWorkerRolePrompt(agent, { resourceTool: "files" }),
  ].filter(Boolean).join("\n\n");
}

import { isAbsolute } from "node:path";
import {
  buildGraphWorkerRolePrompt,
  buildGraphWorkerToolGrantBlock,
  findGraphWorkerRole,
} from "../../../prompt/graph-worker.ts";
import type { ResolvedRole } from "../../../types.ts";
import type { WorkerToolPresentation } from "../../../graph/domain/worker-tools.ts";

export function prepareDshGraphWorkerRolePrompt(roles: readonly ResolvedRole[], agentId: string): string {
  const agent = findGraphWorkerRole(roles, agentId);
  if (!agent) throw new Error(`Graph worker agent is not resolved: ${agentId}`);
  return buildGraphWorkerRolePrompt(agent, { resourceTool: "files" });
}

export function prepareDshGraphWorkerExecutionPrompt(
  roles: readonly ResolvedRole[], agentId: string, workspace: string,
  declaredTools?: readonly string[], presentation?: WorkerToolPresentation,
): string {
  if (typeof workspace !== "string" || workspace.trim().length === 0 || !isAbsolute(workspace)) {
    throw new Error(`The 'workspace' argument must be a non-blank absolute path: ${JSON.stringify(workspace)}`);
  }
  const agent = findGraphWorkerRole(roles, agentId);
  if (!agent) throw new Error(`Graph worker agent is not resolved: ${agentId}`);
  return [
    buildGraphWorkerToolGrantBlock(declaredTools, presentation),
    `Worker workspace: ${workspace}. The host's working-directory behavior, permissions and sandbox policy apply.`,
    "JSON fallback applies only when completion is explicit or unspecified. If your final turn completes normally without an accepted settlement, " +
      "the host may derive an outcome from exactly one fenced ```json block across that turn's assistant text. Put it at the end of your final message: " +
      "{\"outcome_id\": \"<declared outcome>\", \"data\": <payload>, \"evidence_refs\": [\"<path>\"]}. " +
      "Only outcome_id is required; omit unused optional fields and include no other keys or credential. " +
      "A prior rejected or refused submission does not disable this fallback. The host must authenticate the execution and apply the same outcome, " +
      "schema and acceptance checks; correct any reported issues first. Failed or aborted turns are ineligible. " +
      "Natural-completion nodes use the plan's pinned outcome instead.",
  ].filter(Boolean).join("\n\n");
}

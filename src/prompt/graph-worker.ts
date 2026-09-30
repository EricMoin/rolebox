import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";
import { buildAgentPrompt, buildFunctionBlock, type AgentPromptOptions } from "./builder.ts";

type WorkerRole = ResolvedRole | ResolvedSubAgent;

export function findGraphWorkerRole(roles: readonly WorkerRole[], id: string): WorkerRole | undefined {
  for (const role of roles) {
    if (role.id === id) return role;
    const child = findGraphWorkerRole(role.subagents, id);
    if (child !== undefined) return child;
  }
  return undefined;
}

/** Workers cannot activate functions through the parent's conversation machinery. */
export function buildGraphWorkerFunctionBlock(role: WorkerRole): string {
  const active = new Set(role.auto_activate ?? role.config.auto_activate ?? []);
  return buildFunctionBlock(role.functions.filter(fn => active.has(fn.name)));
}

export function buildGraphWorkerRolePrompt(
  role: WorkerRole,
  options: Pick<AgentPromptOptions, "resourceTool" | "references"> & { skills?: WorkerRole["skills"] } = {},
): string {
  return [
    buildAgentPrompt(role.config, options.skills ?? role.skills, {
      references: options.references ?? role.references,
      resourceTool: options.resourceTool,
      canDelegate: false,
    }),
    buildGraphWorkerFunctionBlock(role),
  ].filter(Boolean).join("\n\n");
}

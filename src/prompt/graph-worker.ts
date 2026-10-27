import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";
import { workerPresentationTools, type WorkerToolPresentation } from "../graph/domain/worker-tools.ts";
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

export function buildGraphWorkerToolGrantBlock(
  _declaredTools: readonly string[] | undefined,
  presentation?: WorkerToolPresentation,
  baseline: readonly string[] = ["graph_submit_outcome", "graph_worker_exec"],
): string {
  const entries = [...baseline, ...workerPresentationTools(presentation)].join(", ");
  const guidance = presentation?.mode === "discover"
    ? " Use graph_worker_tools to list/search authorized host tools and describe a tool to load its schema before calling its exposed native entry point. Discovery cannot grant additional permissions."
    : presentation?.mode === "code"
      ? " Use graph_worker_tools to list/search authorized host tools and inspect their schemas, then graph_worker_code to call them from JavaScript. Discovery cannot grant additional permissions. Submit the outcome separately using graph_submit_outcome."
      : "";
  return "Task tools: this worker inherits the parent's authorized task tools. Use them directly when exposed. " +
    "Worker entry points are " + entries + ". Graph control tools and recursive agent dispatch remain unavailable." + guidance;
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

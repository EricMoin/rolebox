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

/**
 * STATE THE NODE'S TOOL GRANT IN THE WORKER'S OWN PROMPT.
 *
 * The grant is the v3 node field `tools?: string[]` — extra HOST tool names or
 * trailing-star prefixes (for example `computer_*`) beyond the worker baseline
 * `graph_submit_outcome` and `graph_worker_exec`. The boundary enforces exactly
 * this grant; the prompt states it so a worker does not spend a call learning it.
 *
 * ABSENT AND EMPTY ARE THE BASELINE, and the wording says so rather than
 * promising a list the host did not resolve: a worker told it has more tools
 * than it does is worse than one told the truth.
 */
export function buildGraphWorkerToolGrantBlock(
  declaredTools: readonly string[] | undefined,
  presentation?: WorkerToolPresentation,
  baseline: readonly string[] = ["graph_submit_outcome", "graph_worker_exec"],
): string {
  const entries = [...baseline, ...workerPresentationTools(presentation)].join(" and ");
  const guidance = presentation?.mode === "discover"
    ? " Use graph_worker_tools to list/search authorized capabilities and describe a tool to load its schema before calling it. Discovery cannot grant additional permissions."
    : presentation?.mode === "code"
      ? " Use graph_worker_tools to inspect authorized tool schemas, then graph_worker_code to call them from JavaScript. Submit the outcome separately using graph_submit_outcome."
      : "";
  if (declaredTools === undefined || declaredTools.length === 0) {
    return "Tool grant: this node declares no extra host tools, so the worker baseline stands — " +
      entries + " are the only tools you may call, and a call to any other tool is refused." + guidance;
  }
  return "Tool grant: beyond the worker baseline " + entries + ", this node declares the host tools " +
    declaredTools.join(", ") +
    ". A name ending in * grants every host tool whose name starts with that prefix; a call to any tool this node does not declare is refused. Graph control tools remain unavailable." + guidance;
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

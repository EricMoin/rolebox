import { findRoleAgent } from "../resolver/role-visibility.ts";
import type { ResolvedRole } from "../types.ts";
import type { CanonicalToolDef } from "./types.ts";

export type RoleForSession = (sessionID?: string) => string | undefined;

const ROLE_SCOPED_TOOLS = new Set([
  "asset_search", "asset_inspect", "asset_validate", "reference_search",
  "load_role_skill", "load_reference", "skill_compose", "graph_declare",
]);

function delegationRefusal(declaration: unknown, agentId: string, roles: ResolvedRole[]): string | undefined {
  const caller = findRoleAgent(roles, agentId);
  if (!caller) return undefined;
  let value = declaration;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (value === null || typeof value !== "object" || !("nodes" in value) || !Array.isArray(value.nodes)) return undefined;
  const allowed = new Set([...roles.map(role => role.id), ...caller.subagents.map(child => child.id)]);
  for (const node of value.nodes) {
    if (node === null || typeof node !== "object" || typeof node.agent !== "string") continue;
    if (!allowed.has(node.agent)) {
      return `graph_declare refused: agent '${node.agent}' is not a top-level role or a direct child of '${agentId}'.`;
    }
  }
  return undefined;
}

/** Attribute role-aware tools without replacing their host capability guards. */
export function bindRoleVisibility(
  tools: Record<string, CanonicalToolDef>,
  roles: ResolvedRole[],
  roleForSession?: RoleForSession,
): Record<string, CanonicalToolDef> {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!ROLE_SCOPED_TOOLS.has(name)) return [name, tool];
    return [name, {
      ...tool,
      async execute(input, context) {
        const suppliedAgent = context?.agent ?? "";
        const agent = findRoleAgent(roles, suppliedAgent) ? suppliedAgent
          : roleForSession?.(context?.sessionID) || suppliedAgent;
        if (name !== "graph_declare" && roleForSession && suppliedAgent && !findRoleAgent(roles, agent)) {
          return "Role assets require an active role for this session.";
        }
        if (name === "graph_declare") {
          const refusal = delegationRefusal(input.declaration, agent, roles);
          if (refusal) return refusal;
        }
        return tool.execute(input, agent === suppliedAgent ? context : { ...context, agent });
      },
    } satisfies CanonicalToolDef];
  }));
}

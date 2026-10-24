import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";

type Agent = ResolvedRole | ResolvedSubAgent;

export function findRoleAgent(roles: readonly Agent[], agentId: string): Agent | undefined {
  for (const role of roles) {
    if (role.id === agentId) return role;
    const child = findRoleAgent(role.subagents, agentId);
    if (child) return child;
  }
  return undefined;
}

/** Role assets include internal workflow details, so known actors see only their own tree. */
export function visibleRolesForAgent(roles: ResolvedRole[], agentId: string | undefined): ResolvedRole[] {
  const ownRole = agentId ? roles.find(role => findRoleAgent([role], agentId)) : undefined;
  if (ownRole) return [ownRole];
  // Preserve unattributed administrative inventory; host-bound calls must
  // establish an actor before reaching this compatibility path.
  return roles.map(role => ({ ...role, subagents: [] }));
}

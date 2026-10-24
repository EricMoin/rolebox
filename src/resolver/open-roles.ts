import type { ResolvedRole } from "../types.ts";
import { SUBAGENT_ID_SEPARATOR } from "../constants.ts";

/** Top-level role metadata. Legacy open-role names remain API-compatible. */
export interface OpenRoleEntry {
  roleId: string;
  name: string;
  description: string;
  /** Retained for compatibility; child roles are never exported. */
  exports: string[];
}

export function collectOpenRoles(
  resolvedRoles: readonly ResolvedRole[],
): Map<string, OpenRoleEntry> {
  const registry = new Map<string, OpenRoleEntry>();
  for (const role of resolvedRoles) {
    if (role.id.includes(SUBAGENT_ID_SEPARATOR)) continue;
    registry.set(role.id, {
      roleId: role.id,
      name: role.config.name ?? role.id,
      description: role.config.description ?? "",
      exports: [],
    });
  }
  return registry;
}

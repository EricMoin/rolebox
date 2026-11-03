import type { ResolvedRole } from "../../../types.ts";
import { findGraphWorkerRole } from "../../../prompt/graph-worker.ts";
import { roleGrantsComputerTool } from "../../../loader/computer-grants.ts";

/** Native capabilities stay host-owned; this policy narrows rolebox's own tool calls. */
export function codexRoleToolAllowed(roles: readonly ResolvedRole[], roleId: string, name: string): boolean {
  if (!roleId) return true;
  const role = findGraphWorkerRole(roles, roleId);
  if (!role) return false;
  const policy = role.config.permission;
  if (policy?.deny?.some(pattern => pattern === name ||
    (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))))) return false;
  return roleGrantsComputerTool(role.config.tools, name);
}

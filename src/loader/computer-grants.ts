/**
 * Role policy for computer tools. Tools are allowed by default; an exact rule
 * takes precedence over the longest matching trailing-star prefix. The global
 * registration gate and graph node grants remain independent restrictions.
 */

import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";

/** Kept independent of the computer driver stack; tests check registry parity. */
export const COMPUTER_TOOL_NAMES = [
  "computer_screenshot",
  "computer_windows",
  "computer_click",
  "computer_move",
  "computer_type",
  "computer_key",
  "computer_permissions",
  "computer_scroll",
  "computer_drag",
  "computer_focus",
  "computer_displays",
  "computer_status",
] as const;

export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];
export const COMPUTER_TOOL_PREFIX = "computer_";
export const COMPUTER_TOOL_WILDCARD = "computer_*";

/** Prefix matching also covers future members of the family. */
export function isComputerToolName(name: string): boolean {
  return name.startsWith(COMPUTER_TOOL_PREFIX);
}

export function isRegisteredComputerToolName(name: string): name is ComputerToolName {
  return (COMPUTER_TOOL_NAMES as readonly string[]).includes(name);
}

export function roleGrantsComputerTool(
  tools: Record<string, boolean> | undefined,
  toolName: string,
): boolean {
  if (tools === undefined) return true;
  if (tools[toolName] !== undefined) return tools[toolName] === true;
  const match = Object.keys(tools)
    .filter(pattern => pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined || tools[match] === true;
}

export function computerToolGrantHint(toolName: string): string {
  return `remove the disabling rule or set "${toolName}: true" in the role's role.yaml tools: map`;
}

export type ComputerGrantDecision =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: string };

function findRole(roles: readonly (ResolvedRole | ResolvedSubAgent)[], id: string): ResolvedRole | ResolvedSubAgent | undefined {
  for (const role of roles) {
    if (role.id === id) return role;
    const child = findRole(role.subagents, id);
    if (child) return child;
  }
  return undefined;
}

/** A base agent is allowed; a named role must resolve to its current config. */
export function decideComputerToolGrant(input: {
  toolName: string;
  roleId: string | null | undefined;
  roles: readonly ResolvedRole[];
}): ComputerGrantDecision {
  const { toolName, roleId, roles } = input;
  if (roleId === null || roleId === undefined || roleId.length === 0) return { granted: true };
  const role = findRole(roles, roleId);
  if (role === undefined) {
    return {
      granted: false,
      reason: `Computer use denied for role "${roleId}": the role is not in the resolved role set, so its policy for "${toolName}" cannot be checked.`,
    };
  }
  if (!roleGrantsComputerTool(role.config.tools, toolName)) {
    return {
      granted: false,
      reason: `Computer use denied for role "${roleId}": its role.yaml tools: map disables "${toolName}" — ${computerToolGrantHint(toolName)}.`,
    };
  }
  return { granted: true };
}

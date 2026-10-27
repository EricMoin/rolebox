/**
 * Role policy for browse tools. Tools are allowed by default; an exact rule
 * takes precedence over the longest matching trailing-star prefix. The global
 * registration gate and graph node grants remain independent restrictions.
 *
 * Mirrors `computer-grants.ts`: a role's `role.yaml` `tools:` map is the only
 * per-role source, an absent map allows the family, and a named role that the
 * resolved set does not contain is denied rather than assumed unrestricted.
 */

import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";

/** Kept independent of the browser driver stack; tests check registry parity. */
export const BROWSE_TOOL_NAMES = [
  "browse_status",
  "browse_open",
  "browse_snapshot",
  "browse_read",
  "browse_click",
  "browse_drag",
  "browse_type",
  "browse_press",
  "browse_select",
  "browse_hover",
  "browse_scroll",
  "browse_wait",
  "browse_eval",
  "browse_screenshot",
  "browse_upload",
  "browse_downloads",
  "browse_dialog",
  "browse_tabs",
  "browse_history",
  "browse_console",
  "browse_network",
  "browse_cookies",
  "browse_close",
] as const;

export type BrowseToolName = (typeof BROWSE_TOOL_NAMES)[number];
export const BROWSE_TOOL_PREFIX = "browse_";
export const BROWSE_TOOL_WILDCARD = "browse_*";

/** Prefix matching also covers future members of the family. */
export function isBrowseToolName(name: string): boolean {
  return name.startsWith(BROWSE_TOOL_PREFIX);
}

export function isRegisteredBrowseToolName(name: string): name is BrowseToolName {
  return (BROWSE_TOOL_NAMES as readonly string[]).includes(name);
}

export function roleGrantsBrowseTool(
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

export function browseToolGrantHint(toolName: string): string {
  return `remove the disabling rule or set "${toolName}: true" in the role's role.yaml tools: map`;
}

export type BrowseGrantDecision =
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
export function decideBrowseToolGrant(input: {
  toolName: string;
  roleId: string | null | undefined;
  roles: readonly ResolvedRole[];
}): BrowseGrantDecision {
  const { toolName, roleId, roles } = input;
  if (roleId === null || roleId === undefined || roleId.length === 0) return { granted: true };
  const role = findRole(roles, roleId);
  if (role === undefined) {
    return {
      granted: false,
      reason: `Browse use denied for role "${roleId}": the role is not in the resolved role set, so its policy for "${toolName}" cannot be checked.`,
    };
  }
  if (!roleGrantsBrowseTool(role.config.tools, toolName)) {
    return {
      granted: false,
      reason: `Browse use denied for role "${roleId}": its role.yaml tools: map disables "${toolName}" — ${browseToolGrantHint(toolName)}.`,
    };
  }
  return { granted: true };
}

import type { ResolvedRole, PermissionConfig } from "../types.ts";
import { RoleMode } from "../constants.ts";
import {
  COMPUTER_TOOL_NAMES,
  roleGrantsComputerTool,
} from "../loader/computer-grants.ts";
import {
  BROWSE_TOOL_NAMES,
  roleGrantsBrowseTool,
} from "../loader/browse-grants.ts";
import { resolveComputerUseGate } from "../loader/computer-use-gate.ts";
import { resolveBrowseUseGate } from "../loader/browse-use-gate.ts";

export interface RoleboxAgentConfig {
  prompt: string;
  mode: RoleMode;
  model?: string;
  description?: string;
  color?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  tools?: {
    [key: string]: boolean;
  };
  permission?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Inputs to {@link buildAgentConfig} that do not come from the role itself.
 *
 * Each is optional: a caller that passes nothing gets the config-file gates
 * resolved for the current workspace, which is what every production caller
 * (the opencode v1 config hook and the v2 agent transform) does.
 */
export interface BuildAgentConfigOptions {
  /**
   * The resolved GLOBAL computer-use gate. When omitted it is resolved from
   * the rolebox config surface (`~/.config/rolebox/config.yaml` and
   * `{workspace}/.rolebox/config.json`) through
   * {@link resolveComputerUseGate}. Tests and hosts pass it explicitly so a
   * developer's own config file can never decide the outcome.
   */
  computerUse?: boolean;
  /**
   * The resolved GLOBAL browse-use gate. Omitted → resolved through
   * {@link resolveBrowseUseGate} (explicit setting, else AUTO-detection of the
   * optional Playwright driver). OpenCode registers neither family, so this map
   * only carries explicit per-role denials — it never adds tools.
   */
  browseUse?: boolean;
  /**
   * Workspace root for the project-config lookup. Defaults to the workspace
   * registered by {@link setAgentConfigWorkspace} (the entry that owns the
   * plugin context registers it at boot), else `process.cwd()`.
   */
  workspaceDir?: string;
}

/**
 * Workspace hint for the project-config lookup.
 *
 * `buildAgentConfig` is called from hosts that do not pass a workspace (the
 * opencode v1 config hook, the v2 agent transform), yet the project config —
 * the `.rolebox/config.json` that can carry `computerUse: true` — lives under
 * the WORKSPACE, which is not guaranteed to be the process cwd. The entry that
 * owns the plugin context registers its directory here once at boot; an
 * explicitly passed `options.workspaceDir` always wins over the hint.
 */
let agentConfigWorkspace: string | undefined;

/** Register the workspace used by the default project-config lookup. */
export function setAgentConfigWorkspace(directory: string | undefined): void {
  agentConfigWorkspace = directory;
}

/** The registered workspace hint, or `undefined` when none was set. */
export function getAgentConfigWorkspace(): string | undefined {
  return agentConfigWorkspace;
}

function assignDefined<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      (target as Record<string, unknown>)[key] = value;
    }
  }
  return target;
}

/**
 * Transform rolebox's `{ allow?: string[], deny?: string[] }` permission format
 * into opencode's per-tool PermissionConfig: `{ read: "allow", bash: "deny", ... }`.
 *
 * Also passes through configs that are already in the new format (object with
 * string values like `{ read: "allow" }`) for forward-compatibility.
 */
export function transformPermission(
  perm: PermissionConfig | undefined,
): RoleboxAgentConfig["permission"] | undefined {
  if (!perm) return undefined;

  const hasAllow = Array.isArray(perm.allow);
  const hasDeny = Array.isArray(perm.deny);

  if (!hasAllow && !hasDeny) {
    return perm as RoleboxAgentConfig["permission"];
  }

  const result: Record<string, string> = {};

  if (hasAllow) {
    for (const tool of perm.allow!) {
      result[tool.toLowerCase()] = "allow";
    }
  }

  if (hasDeny) {
    for (const tool of perm.deny!) {
      result[tool.toLowerCase()] = "deny";
    }
  }

  return result as RoleboxAgentConfig["permission"];
}

/**
 * Materialize explicit computer-tool denials for hosts that consume exact tool
 * names. With the global gate off no family is registered, so the map is left
 * untouched. Roles with no restrictions retain their original map as well.
 */
export function withComputerUseDenials(
  tools: Record<string, boolean> | undefined,
  gateEnabled: boolean,
): Record<string, boolean> | undefined {
  if (!gateEnabled) return tools;
  const denied = COMPUTER_TOOL_NAMES.filter(name => !roleGrantsComputerTool(tools, name));
  if (denied.length === 0) return tools;
  const next: Record<string, boolean> = { ...(tools ?? {}) };
  for (const name of denied) next[name] = false;
  return next;
}

/**
 * Materialize explicit browse-tool denials for hosts that consume exact tool
 * names. Same contract as {@link withComputerUseDenials}: a gate that is off
 * means no family is registered, so the map is left untouched, and a role with
 * no browse restrictions keeps its original map (and its identity).
 *
 * OpenCode never registers the browse family, but it reads these maps as its
 * per-tool permission surface — so a role that disables `browse_click` still
 * cannot silently gain it if a future host registers the family.
 */
export function withBrowseUseDenials(
  tools: Record<string, boolean> | undefined,
  gateEnabled: boolean,
): Record<string, boolean> | undefined {
  if (!gateEnabled) return tools;
  const denied = BROWSE_TOOL_NAMES.filter(name => !roleGrantsBrowseTool(tools, name));
  if (denied.length === 0) return tools;
  const next: Record<string, boolean> = { ...(tools ?? {}) };
  for (const name of denied) next[name] = false;
  return next;
}

export function buildAgentConfig(
  resolved: ResolvedRole,
  options: BuildAgentConfigOptions = {},
): RoleboxAgentConfig {
  const { config } = resolved;
  const workspaceDir = options.workspaceDir ?? agentConfigWorkspace ?? process.cwd();
  const computerUse = options.computerUse ?? resolveComputerUseGate({ workspaceDir }).enabled;
  const browseUse = options.browseUse ?? resolveBrowseUseGate({ workspaceDir }).enabled;

  return assignDefined<RoleboxAgentConfig>(
    {
      prompt: resolved.prompt,
      mode: config.mode ?? RoleMode.Primary,
    },
    {
      model: config.model,
      description: config.description,
      color: config.color,
      variant: config.variant,
      temperature: config.temperature,
      top_p: config.top_p,
      tools: withBrowseUseDenials(withComputerUseDenials(config.tools, computerUse), browseUse),
      permission: transformPermission(config.permission),
    },
  );
}

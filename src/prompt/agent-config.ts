import type { ResolvedRole, PermissionConfig } from "../types.ts";
import { RoleMode } from "../constants.ts";
import {
  COMPUTER_TOOL_NAMES,
  roleGrantsComputerTool,
} from "../loader/computer-grants.ts";
import { resolveComputerUseGate } from "../loader/computer-use-gate.ts";

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
 * Both are optional: a caller that passes nothing gets the config-file gate
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
 * The agent-level `tools:` map a host receives.
 *
 * When the global gate is OFF the role's own map is returned UNCHANGED — the
 * family is not registered at all in that case, so there is nothing to deny and
 * the emitted config is byte-for-byte the pre-gate one. When the gate is ON,
 * every registered `computer_*` name the role does not grant is emitted as
 * `false`, the same `{name: boolean}` shape role.yaml already uses and the
 * opencode v2 transform already maps to a deny rule
 * (src/platform/adapters/opencode2/agents.ts `mapToolRuleset`). A role that
 * grants the family — one exact name or the `computer_*` wildcard — keeps its
 * own entries; a role that grants nothing ends up with all seven denied, so a
 * non-opting role never sees a callable computer tool on either opencode
 * version.
 */
export function withComputerUseDenials(
  tools: Record<string, boolean> | undefined,
  gateEnabled: boolean,
): Record<string, boolean> | undefined {
  if (!gateEnabled) return tools;
  const next: Record<string, boolean> = { ...(tools ?? {}) };
  for (const name of COMPUTER_TOOL_NAMES) {
    if (!roleGrantsComputerTool(tools, name)) next[name] = false;
  }
  return next;
}

export function buildAgentConfig(
  resolved: ResolvedRole,
  options: BuildAgentConfigOptions = {},
): RoleboxAgentConfig {
  const { config } = resolved;
  const computerUse =
    options.computerUse ??
    resolveComputerUseGate({
      workspaceDir: options.workspaceDir ?? agentConfigWorkspace ?? process.cwd(),
    }).enabled;

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
      tools: withComputerUseDenials(config.tools, computerUse),
      permission: transformPermission(config.permission),
    },
  );
}

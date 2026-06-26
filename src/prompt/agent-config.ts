import type { AgentConfig } from "@opencode-ai/sdk";
import type { ResolvedRole, PermissionConfig } from "../types.ts";
import { RoleMode } from "../constants.ts";

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
): AgentConfig["permission"] | undefined {
  if (!perm) return undefined;

  const hasAllow = Array.isArray(perm.allow);
  const hasDeny = Array.isArray(perm.deny);

  if (!hasAllow && !hasDeny) {
    return perm as AgentConfig["permission"];
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

  return result as AgentConfig["permission"];
}

export function buildAgentConfig(resolved: ResolvedRole): AgentConfig {
  const { config } = resolved;

  return assignDefined<AgentConfig>(
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
      tools: config.tools,
      permission: transformPermission(config.permission),
    },
  );
}

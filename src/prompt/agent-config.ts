import type { AgentConfig } from "@opencode-ai/sdk";
import type { ResolvedRole } from "../types.ts";
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
 * Build an SDK-compatible AgentConfig from a ResolvedRole.
 *
 * Only defined fields are included so that defaults in opencode itself
 * are not accidentally overwritten with empty strings or zero values.
 */
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
      permission: config.permission as AgentConfig["permission"],
    },
  );
}

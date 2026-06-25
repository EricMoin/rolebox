import type { AgentConfig } from "@opencode-ai/sdk";
import type { ResolvedRole } from "../types.js";
import { RoleMode } from "../constants.js";

/**
 * Build an SDK-compatible AgentConfig from a ResolvedRole.
 *
 * Only defined fields are included so that defaults in opencode itself
 * are not accidentally overwritten with empty strings or zero values.
 */
export function buildAgentConfig(resolved: ResolvedRole): AgentConfig {
  const { config } = resolved;

  const agent: AgentConfig = {
    prompt: resolved.prompt,
    mode: config.mode ?? RoleMode.Primary,
  };
  if (config.model !== undefined) {
    agent.model = config.model;
  }
  if (config.description !== undefined) {
    agent.description = config.description;
  }
  if (config.color !== undefined) {
    agent.color = config.color;
  }
  if (config.variant !== undefined) {
    agent.variant = config.variant;
  }
  if (config.temperature !== undefined) {
    agent.temperature = config.temperature;
  }
  if (config.top_p !== undefined) {
    agent.top_p = config.top_p;
  }
  if (config.tools !== undefined) {
    agent.tools = config.tools;
  }
  if (config.permission !== undefined) {
    agent.permission = config.permission as AgentConfig["permission"];
  }

  return agent;
}

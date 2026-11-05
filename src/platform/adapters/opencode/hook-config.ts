/**
 * The opencode `config` hook contribution — the host-side half of rolebox's
 * hook surface.
 *
 * The opencode config document (`config.agent`, `config.command`) is the
 * host's own shape, so the contribution that writes it lives here, next to the
 * other opencode adapters, instead of in the platform-neutral core. The core
 * only forwards the handler the hosting entry supplies (`extraHandlers`).
 *
 * @module
 */

import { buildAgentConfig, transformPermission, type RoleboxAgentConfig } from "../../../prompt/agent-config.ts";
import { RoleMode } from "../../../constants.ts";
import { STOP_LOOP_COMMAND, STOP_LOOP_SIGNAL } from "../../../loop/constants.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../../types.ts";

/**
 * Structural view of the opencode config document's fields this contribution
 * writes. The host owns the full type; only `agent` and `command` are read or
 * created here, and every other field travels through untouched.
 */
interface OpencodeConfigDocument {
  agent?: Record<string, unknown>;
  command?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Build the opencode `config` handler for a set of resolved roles.
 *
 * The returned handler registers one agent per role (plus every recursive
 * subagent), then defaults the stop-loop command when the host has not already
 * defined it. It mutates the host's config document in place, which is what
 * the host expects from a `config` hook.
 */
export function createOpencodeConfigHandler(
  resolvedRoles: ResolvedRole[],
): (config: Record<string, unknown>) => Promise<void> {
  return async (config) => {
    const document = config as OpencodeConfigDocument;

    function registerSubAgentConfigs(subagents: ResolvedSubAgent[], cfg: OpencodeConfigDocument): void {
      for (const sub of subagents) {
        const subAgentCfg: Record<string, unknown> = {
          prompt: sub.prompt,
          mode: RoleMode.Subagent,
          hidden: true,
        };
        if (sub.config.description) subAgentCfg.description = sub.config.description;
        if (sub.config.model) subAgentCfg.model = sub.config.model;
        if (sub.config.color) subAgentCfg.color = sub.config.color;
        if (sub.config.variant) subAgentCfg.variant = sub.config.variant;
        if (sub.config.temperature !== undefined) subAgentCfg.temperature = sub.config.temperature;
        if (sub.config.top_p !== undefined) subAgentCfg.top_p = sub.config.top_p;
        if (sub.config.tools) subAgentCfg.tools = sub.config.tools;
        if (sub.config.permission) subAgentCfg.permission = transformPermission(sub.config.permission);

        cfg.agent ??= {};
        cfg.agent[sub.id] = subAgentCfg as RoleboxAgentConfig;
        if (sub.subagents.length > 0) {
          registerSubAgentConfigs(sub.subagents, cfg);
        }
      }
    }

    for (const resolved of resolvedRoles) {
      const agentConfig = buildAgentConfig(resolved);
      document.agent ??= {};
      document.agent[resolved.id] = agentConfig;
      registerSubAgentConfigs(resolved.subagents, document);
    }

    document.command ??= {};
    const commands = document.command;
    if (!commands[STOP_LOOP_COMMAND]) {
      commands[STOP_LOOP_COMMAND] = {
        template: STOP_LOOP_SIGNAL,
        description: "Stop the active loop",
      };
    }
  };
}

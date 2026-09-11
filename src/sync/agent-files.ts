import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";
import { RoleMode } from "../constants.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type { AgentDefinition } from "../platform/types.ts";
import type { IAgentRegistrar } from "../platform/ports/agent-registrar.ts";
import type { PiAgentRegistrar } from "../platform/adapters/pi/agent-registrar.ts";
import { OpencodeAgentRegistrar } from "../platform/adapters/opencode/agent-registrar.ts";

const log = createSubLogger("sync");

/**
 * Collect all agents (primary roles + recursive subagents) from resolved roles
 * and convert them to canonical AgentDefinition format.
 */
function collectAgentDefinitions(resolvedRoles: ResolvedRole[]): AgentDefinition[] {
  function collectAllAgents(subagents: ResolvedSubAgent[]): AgentDefinition[] {
    const result: AgentDefinition[] = [];
    for (const sub of subagents) {
      result.push({
        id: sub.id,
        name: sub.config.name,
        description: sub.config.description,
        systemPrompt: sub.prompt,
        model: sub.config.model,
        mode: RoleMode.Subagent,
      });
      if (sub.subagents.length > 0) {
        result.push(...collectAllAgents(sub.subagents));
      }
    }
    return result;
  }

  const allAgents: AgentDefinition[] = [];
  for (const role of resolvedRoles) {
    allAgents.push({
      id: role.id,
      name: role.config.name,
      description: role.config.description,
      systemPrompt: role.prompt,
      model: role.config.model,
      mode: role.config.mode ?? RoleMode.Primary,
    });
    allAgents.push(...collectAllAgents(role.subagents));
  }
  return allAgents;
}

/**
 * Sync resolved agent definitions to the host platform via an IAgentRegistrar.
 *
 * Collects all agents (primary roles + recursive subagents), converts them to
 * canonical AgentDefinition format, passes them to the provided registrar, and
 * returns the diff summary.
 */
export async function syncAllAgents(
  resolvedRoles: ResolvedRole[],
  registrar: IAgentRegistrar,
): Promise<{ added: string[]; removed: string[]; unchanged: string[] }> {
  const allAgents = collectAgentDefinitions(resolvedRoles);
  try {
    const result = await registrar.sync(allAgents);
    log.info("Agent sync complete", result);
    return result;
  } catch (err) {
    log.warn("Failed to sync agents", { error: formatError(err) });
    return { added: [], removed: [], unchanged: [] };
  }
}

/**
 * Write agent definitions to ~/.claude/agents/ as fallback registration.
 *
 * @deprecated Use `syncAllAgents(resolvedRoles, new OpencodeAgentRegistrar())` instead.
 * Kept as a convenience alias for backward compatibility.
 */
export function syncAgentFiles(resolvedRoles: ResolvedRole[]): void {
  const registrar = new OpencodeAgentRegistrar();
  void syncAllAgents(resolvedRoles, registrar);
}

/**
 * Sync resolved agent definitions into a PiAgentRegistrar (in-memory registry).
 *
 * @deprecated Use `syncAllAgents(resolvedRoles, registrar)` instead.
 * Kept as a convenience alias for backward compatibility.
 */
export async function syncAgentFilesForPi(
  resolvedRoles: ResolvedRole[],
  registrar: PiAgentRegistrar,
): Promise<void> {
  await syncAllAgents(resolvedRoles, registrar);
}

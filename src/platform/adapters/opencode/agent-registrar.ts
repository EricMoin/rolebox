/**
 * OpencodeAgentRegistrar — IAgentRegistrar adapter for the opencode platform.
 *
 * Writes agent definition files to `~/.claude/agents/` as markdown files
 * tagged with the rolebox marker comment. This is the same file-writing
 * behavior previously implemented directly in `syncAgentFiles()`.
 *
 * Does NOT import from `@opencode-ai/plugin` or `@opencode-ai/sdk`.
 *
 * @module
 */

import path from "node:path";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import type { IAgentRegistrar } from "../../ports/agent-registrar.ts";
import type { AgentDefinition } from "../../types.ts";
import { ROLEBOX_AGENT_MARKER } from "../../../constants.ts";
import { agentsDir } from "../../../utils/paths.ts";
import { createSubLogger, formatError } from "../../../logger.ts";

const log = createSubLogger("sync");

/**
 * Serialize an AgentDefinition into the markdown file content expected by
 * opencode agent file discovery (oh-my-openagent reads `~/.claude/agents/*.md`).
 */
function serializeAgentFile(agent: AgentDefinition): string {
  const lines = [
    ROLEBOX_AGENT_MARKER,
    "---",
    `name: ${agent.name}`,
    `description: ${agent.description}`,
  ];
  if (agent.mode) lines.push(`mode: ${agent.mode}`);
  if (agent.model) lines.push(`model: ${agent.model}`);
  lines.push("---", "", agent.systemPrompt);
  return lines.join("\n");
}

/**
 * IAgentRegistrar implementation for the opencode platform.
 *
 * Writes agent definitions to `~/.claude/agents/{id}.md`. Uses the
 * ROLEBOX_AGENT_MARKER comment to identify files managed by rolebox,
 * allowing stale files to be cleaned up on subsequent syncs.
 */
export class OpencodeAgentRegistrar implements IAgentRegistrar {
  private readonly agentsDirPath: string;

  constructor(agentsDirOverride?: string) {
    this.agentsDirPath = agentsDirOverride ?? agentsDir();
  }

  async register(agentDefs: AgentDefinition[]): Promise<void> {
    this.ensureDirectory();
    for (const agent of agentDefs) {
      const filePath = this.agentPath(agent.id);
      const content = serializeAgentFile(agent);
      try {
        writeFileSync(filePath, content, "utf-8");
      } catch (err) {
        log.warn("Failed to write agent file", { file: filePath, error: formatError(err) });
      }
    }
  }

  async unregister(agentIds: string[]): Promise<void> {
    for (const id of agentIds) {
      const filePath = this.agentPath(id);
      try {
        if (existsSync(filePath)) {
          const text = readFileSync(filePath, "utf-8");
          if (text.includes(ROLEBOX_AGENT_MARKER)) {
            unlinkSync(filePath);
          }
        }
      } catch (err) {
        log.debug("Failed to unregister agent file", {
          path: filePath,
          error: formatError(err),
        });
      }
    }
  }

  async sync(
    agentDefs: AgentDefinition[],
  ): Promise<{ added: string[]; removed: string[]; unchanged: string[] }> {
    this.ensureDirectory();

    const newDefs = new Map(agentDefs.map((def) => [def.id, def]));
    const existingIds = new Set<string>();
    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    // Scan existing rolebox-managed files.
    try {
      const entries = readdirSync(this.agentsDirPath);
      for (const file of entries) {
        if (!file.endsWith(".md")) continue;
        const id = file.replace(/\.md$/, "");
        const filePath = path.join(this.agentsDirPath, file);
        try {
          const text = readFileSync(filePath, "utf-8");
          if (!text.includes(ROLEBOX_AGENT_MARKER)) continue;
          existingIds.add(id);

          const newDef = newDefs.get(id);
          if (!newDef) {
            unlinkSync(filePath);
            removed.push(id);
          } else {
            const expected = serializeAgentFile(newDef);
            if (text === expected) {
              unchanged.push(id);
            } else {
              added.push(id);
            }
          }
        } catch (err) {
          log.debug("Failed to read agent file", {
            path: filePath,
            error: formatError(err),
          });
        }
      }
    } catch (err) {
      log.debug("Failed to read agents directory", {
        dir: this.agentsDirPath,
        error: formatError(err),
      });
    }

    // Identify new agents (not seen in existing files).
    for (const def of agentDefs) {
      if (!existingIds.has(def.id)) {
        added.push(def.id);
      }
    }

    // Write all new/changed files.
    for (const id of added) {
      const def = newDefs.get(id)!;
      const filePath = this.agentPath(id);
      const content = serializeAgentFile(def);
      try {
        writeFileSync(filePath, content, "utf-8");
      } catch (err) {
        log.warn("Failed to write agent file", { file: filePath, error: formatError(err) });
      }
    }

    return { added, removed, unchanged };
  }

  async list(): Promise<string[]> {
    this.ensureDirectory();
    const result: string[] = [];
    try {
      const entries = readdirSync(this.agentsDirPath);
      for (const file of entries) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(this.agentsDirPath, file);
        try {
          const text = readFileSync(filePath, "utf-8");
          if (text.includes(ROLEBOX_AGENT_MARKER)) {
            result.push(file.replace(/\.md$/, ""));
          }
        } catch {
          // Skip unreadable files.
        }
      }
    } catch {
      // Directory may not exist yet.
    }
    return result.sort();
  }

  private ensureDirectory(): void {
    try {
      mkdirSync(this.agentsDirPath, { recursive: true });
    } catch (err) {
      log.debug("Failed to create agent directory", {
        dir: this.agentsDirPath,
        error: formatError(err),
      });
    }
  }

  private agentPath(agentId: string): string {
    return path.join(this.agentsDirPath, `${agentId}.md`);
  }
}

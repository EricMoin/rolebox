import path from "node:path";
import os from "node:os";
import { writeFileSync, readFileSync, mkdirSync, rmdirSync, readdirSync, unlinkSync, symlinkSync, lstatSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { AgentConfig } from "@opencode-ai/sdk";
import { discoverRoles } from "./role-loader.js";
import { resolveSkills } from "./skill-resolver.js";
import { resolveAllReferences } from "./reference-resolver.js";
import { resolveFunctions, applyParams } from "./function-resolver.js";
import { parseFunctionActivation } from "./function-parser.js";
import type { FunctionCall } from "./function-parser.js";
import { functionSessionState } from "./session-state.js";
import { buildAgentPrompt, buildFunctionBlock } from "./prompt-builder.js";
import { buildSubagentRoleBlock } from "./graph-prompt-builder.js";
import type { RoleConfig, ResolvedRole, ResolvedSubAgent, ResolvedSkill, ResolvedFunction, ResolvedReference, ResolvedGraph, GraphNodeRole } from "./types.js";
import { parseCollaboration } from "./graph-parser.js";

/**
 * Map of roleId → ResolvedFunction[] built at startup.
 * Exported so tests and hooks can query role-level function resolution.
 */
export const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

/**
 * Compute a subagent's role within a resolved collaboration graph.
 *
 * Matches the agent against graph edges by its child slug (the dashed,
 * lowercased name used in YAML collaboration config). Returns null when
 * the agent does not appear in any edge — its prompt is left unchanged.
 */
function computeNodeRole(
  graph: ResolvedGraph,
  agentId: string,
  childSlug: string,
): GraphNodeRole | null {
  const downstream = graph.edges
    .filter((e) => e.from === childSlug && e.to !== "parent")
    .map((e) => e.to);
  const upstream = graph.edges
    .filter((e) => e.to === childSlug && e.from !== "parent")
    .map((e) => e.from);
  const isEntryPoint = graph.edges.some(
    (e) => e.from === "parent" && e.to === childSlug,
  );
  const isExitPoint = graph.edges.some(
    (e) => e.from === childSlug && (e.to === "parent" || e.exit === true),
  );

  if (
    upstream.length === 0 &&
    downstream.length === 0 &&
    !isEntryPoint &&
    !isExitPoint
  ) {
    return null;
  }

  return { agentId, upstream, downstream, isEntryPoint, isExitPoint };
}

/**
 * Resolve all discovered roles into ResolvedRole objects.
 *
 * For each role in the Map:
 *  1. Gather both role-local skills (skills[]) and opencode-global skills
 *     (opencode_skills[]) into a single name list.
 *  2. Resolve those names to file paths via the 4-candidate priority system.
 *  3. Gather function names, filter disabled ones, and resolve function files.
 *  4. Build the final agent prompt with <available_skills> XML block.
 *  5. Return a ResolvedRole object for each successfully-resolved role.
 *
 * Errors from individual role resolution are caught and the failing role is
 * silently skipped (the returned array omits it).
 */
async function resolveAllRoles(
  roles: Map<string, RoleConfig>,
  roleboxDir: string,
  globalSkillsDir: string,
  configDir: string,
): Promise<ResolvedRole[]> {
  const resolved: ResolvedRole[] = [];

  for (const [roleId, config] of roles) {
    try {
      const roleDir = path.join(roleboxDir, roleId);

      // Combine both role-local and opencode-global skill names.
      const localSkills = config.skills ?? [];
      const globalSkills = config.opencode_skills ?? [];
      const allSkillNames = [...localSkills, ...globalSkills];

      let skills: ResolvedSkill[] = [];
      if (allSkillNames.length > 0) {
        skills = await resolveSkills(allSkillNames, roleDir, globalSkillsDir);
      }

      // Resolve role-level references (auto-discover + explicit declarations)
      const roleReferences = await resolveAllReferences(
        roleDir,
        "role",
        config.references as RoleConfig["references"],
      );

      // Aggregate skill-level references into a combined list for the role
      const skillReferences = skills.flatMap((s) => s.references);
      const allReferences = [...roleReferences, ...skillReferences];

      const globalFunctionsDir = path.join(configDir, "functions");
      const builtinDir = path.join(__dirname, "..", "functions");

      const functionNames = config.functions ?? ["plan", "execute"];
      const enabledFunctions = functionNames.filter(
        (fn) => !(config.disable_functions ?? []).includes(fn),
      );

      let functions: ResolvedFunction[] = [];
      if (enabledFunctions.length > 0) {
        functions = await resolveFunctions(enabledFunctions, roleDir, globalFunctionsDir, builtinDir);
      }

      // Process subagents: resolve skills, functions, prompts for each
      const resolvedSubagents: ResolvedSubAgent[] = [];
      if (config.subagents && config.subagents.length > 0) {
        for (const saConfig of config.subagents) {
          const childSlug = saConfig.name.toLowerCase().replace(/\s+/g, "-");
          const childId = `${roleId}--${childSlug}`;

          // File-based: try the normalized slug first, then the raw name for
          // backward-compat with directories named exactly like the YAML name.
          const slugDir = path.join(roleDir, "subagents", childSlug);
          const nameDir = path.join(roleDir, "subagents", saConfig.name);
          const saRoleDir = existsSync(slugDir)
            ? slugDir
            : existsSync(nameDir)
              ? nameDir
              : roleDir;

          // Resolve subagent skills
          const saLocalSkills = saConfig.skills ?? [];
          const saGlobalSkills = saConfig.opencode_skills ?? [];
          const saAllSkillNames = [...saLocalSkills, ...saGlobalSkills];
          let saSkills: ResolvedSkill[] = [];
          if (saAllSkillNames.length > 0) {
            saSkills = await resolveSkills(saAllSkillNames, saRoleDir, globalSkillsDir);
          }

          // Resolve subagent functions
          const saFunctionNames = saConfig.functions ?? ["plan", "execute"];
          const saEnabledFunctions = saFunctionNames.filter(
            (fn) => !(saConfig.disable_functions ?? []).includes(fn),
          );
          let saFunctions: ResolvedFunction[] = [];
          if (saEnabledFunctions.length > 0) {
            saFunctions = await resolveFunctions(
              saEnabledFunctions,
              saRoleDir,
              globalFunctionsDir,
              builtinDir,
            );
          }

          // Resolve subagent references: own + inherited from parent role + skill-level
          const saOwnRefs = await resolveAllReferences(saRoleDir, "role");
          const saSkillRefs = saSkills.flatMap((s) => s.references);
          const saReferences = [...roleReferences, ...saOwnRefs, ...saSkillRefs];

          const saPrompt = buildAgentPrompt(saConfig, saSkills, undefined, saReferences);

          // Store subagent functions in the global map
          roleFunctionsMap.set(childId, saFunctions);

          const inheritedFrom: Record<string, unknown> = {};
          const parentObj = config as unknown as Record<string, unknown>;
          const childObj = saConfig as unknown as Record<string, unknown>;
          const inheritableKeys = ["model", "color", "variant", "temperature", "top_p", "permission", "tools"] as const;
          for (const key of inheritableKeys) {
            if (parentObj[key] !== undefined && childObj[key] === parentObj[key]) {
              inheritedFrom[key] = parentObj[key];
            }
          }

          resolvedSubagents.push({
            id: childId,
            config: saConfig,
            prompt: saPrompt,
            skills: saSkills,
            functions: saFunctions,
            references: saReferences,
            parentId: roleId,
            inheritedFrom,
            subagents: [],
          });
        }
      }

      // Parse collaboration graph if configured
      let graph: ResolvedGraph | undefined;
      if (config.collaboration) {
        const subagentSlugNames = (config.subagents ?? []).map(sa =>
          sa.name.toLowerCase().replace(/\s+/g, "-")
        );
        const resolvedGraph = parseCollaboration(config.collaboration, subagentSlugNames);
        if (resolvedGraph) {
          graph = resolvedGraph;
        } else {
          console.warn(`[role-loader] Failed to parse collaboration graph for role "${roleId}" — role will load without graph`);
        }
      }

      // Inject collaboration role blocks into subagent prompts
      if (graph) {
        for (const sa of resolvedSubagents) {
          const childSlug = sa.config.name.toLowerCase().replace(/\s+/g, "-");
          const nodeRole = computeNodeRole(graph, sa.id, childSlug);
          if (nodeRole) {
            const roleBlock = buildSubagentRoleBlock(nodeRole);
            sa.prompt = `${sa.prompt}\n\n${roleBlock}`;
          }
        }
      }

      // Build parent prompt with subagent metadata injected
      const subagentMetadata = resolvedSubagents.map((sa) => ({
        id: sa.id,
        name: sa.config.name,
        description: sa.config.description,
      }));
      const prompt = buildAgentPrompt(config, skills, subagentMetadata, allReferences, graph);

      resolved.push({ id: roleId, config, prompt, skills, functions, references: allReferences, subagents: resolvedSubagents, graph });
      roleFunctionsMap.set(roleId, functions);
    } catch {
      // Silently skip roles that fail during resolution.
    }
  }

  return resolved;
}

/**
 * Build an SDK-compatible AgentConfig from a ResolvedRole.
 *
 * Only defined fields are included so that defaults in opencode itself
 * are not accidentally overwritten with empty strings or zero values.
 */
function buildAgentConfig(resolved: ResolvedRole): AgentConfig {
  const { config } = resolved;

  const agent: AgentConfig = {
    prompt: resolved.prompt,
    mode: config.mode ?? "primary",
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

/**
 * Marker prefix used in agent .md files to identify rolebox-managed agents.
 * This allows cleanup of stale agents when roles are removed from rolebox.
 */
const ROLEBOX_MARKER = "<!-- rolebox-managed -->";

/**
 * Write agent definitions to ~/.claude/agents/ as fallback registration.
 *
 * This ensures agents are discoverable by oh-my-openagent (which reads
 * from this directory) even though rolebox also registers them via the
 * standard config hook. Agents managed by rolebox are tagged with a
 * marker comment so they can be cleaned up if the role is removed.
 */
function syncAgentFiles(resolvedRoles: ResolvedRole[]): void {
  const agentsDir = path.join(os.homedir(), ".claude", "agents");

  try {
    mkdirSync(agentsDir, { recursive: true });
  } catch {
    return; // Can't write — skip silently
  }

  interface AgentEntry {
    id: string;
    name: string;
    description: string;
    prompt: string;
    mode: string;
    model?: string;
  }

  const allAgents: AgentEntry[] = [];
  for (const role of resolvedRoles) {
    allAgents.push({
      id: role.id,
      name: role.config.name,
      description: role.config.description,
      prompt: role.prompt,
      mode: role.config.mode ?? "primary",
      model: role.config.model,
    });
    for (const sub of role.subagents) {
      allAgents.push({
        id: sub.id,
        name: sub.config.name,
        description: sub.config.description,
        prompt: sub.prompt,
        mode: "subagent",
        model: sub.config.model,
      });
    }
  }

  try {
    const existing = readdirSync(agentsDir);
    for (const file of existing) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(agentsDir, file);
      try {
        const text = readFileSync(filePath, "utf-8");
        if (text.includes(ROLEBOX_MARKER)) {
          const roleId = file.replace(/\.md$/, "");
          if (!allAgents.some((a) => a.id === roleId)) {
            unlinkSync(filePath);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Directory not readable — skip cleanup
  }

  for (const agent of allAgents) {
    const lines = [
      ROLEBOX_MARKER,
      "---",
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `mode: ${agent.mode}`,
    ];
    if (agent.model) lines.push(`model: ${agent.model}`);
    lines.push("---", "", agent.prompt);

    const filePath = path.join(agentsDir, `${agent.id}.md`);
    try {
      writeFileSync(filePath, lines.join("\n"), "utf-8");
    } catch {
      // Skip if write fails
    }
  }
}

const ROLEBOX_SKILL_PREFIX = "rolebox--";

/**
 * Determine the opencode global config directory.
 * Respects XDG_CONFIG_HOME if set, otherwise defaults to ~/.config/opencode.
 */
function getOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "opencode");
  }
  return path.join(os.homedir(), ".config", "opencode");
}

function createSkillEntry(entryPath: string, filePath: string): void {
  const isDirectorySkill = path.basename(filePath).toLowerCase() === "skill.md";
  try {
    if (isDirectorySkill) {
      symlinkSync(path.dirname(filePath), entryPath);
    } else {
      mkdirSync(entryPath, { recursive: true });
      symlinkSync(filePath, path.join(entryPath, "SKILL.md"));
    }
  } catch {}
}

/**
 * Sync rolebox skills into ~/.config/opencode/skills/ for oh-my-openagent discovery.
 *
 * oh-my-openagent's loadSkillsFromDir treats symlinks as directories:
 * it resolves them and looks for SKILL.md inside. So:
 * - Directory skills (with SKILL.md): create symlink to the directory
 * - Single-file skills (.md): create a wrapper directory with SKILL.md symlink inside
 */
function syncSkillSymlinks(resolvedRoles: ResolvedRole[], globalSkillsDir: string): void {
  try {
    mkdirSync(globalSkillsDir, { recursive: true });
  } catch {
    return;
  }

  // Clean up stale rolebox entries
  try {
    const existing = readdirSync(globalSkillsDir);
    for (const entry of existing) {
      if (!entry.startsWith(ROLEBOX_SKILL_PREFIX)) continue;
      const entryPath = path.join(globalSkillsDir, entry);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(entryPath);
        } else if (stat.isDirectory()) {
          // Wrapper directory: remove SKILL.md symlink inside, then rmdir
          const inner = path.join(entryPath, "SKILL.md");
          try { unlinkSync(inner); } catch {}
          try { rmdirSync(entryPath); } catch {}
        }
      } catch {
        continue;
      }
    }
  } catch {}

  for (const role of resolvedRoles) {
    for (const skill of role.skills) {
      if (skill.scope !== "rolebox") continue;
      if (!existsSync(skill.filePath)) continue;

      const entryName = `${ROLEBOX_SKILL_PREFIX}${skill.name}`;
      const entryPath = path.join(globalSkillsDir, entryName);
      createSkillEntry(entryPath, skill.filePath);
    }
    for (const sub of role.subagents) {
      for (const skill of sub.skills) {
        if (skill.scope !== "rolebox") continue;
        if (!existsSync(skill.filePath)) continue;

        const entryName = `${ROLEBOX_SKILL_PREFIX}${sub.id}~${skill.name}`;
        const entryPath = path.join(globalSkillsDir, entryName);
        createSkillEntry(entryPath, skill.filePath);
      }
    }
  }
}

/**
 * OpenCode plugin for rolebox — define custom agent roles via YAML
 * configuration files with custom prompts, models, skills, and permissions.
 */
const RoleboxPlugin: Plugin = async (ctx) => {
  const configDir = getOpencodeConfigDir();
  // Prefer ctx.directory/rolebox if it exists (e.g. when ctx.directory IS the
  // config dir), otherwise fall back to the well-known config location.
  const ctxRoleboxDir = path.join(ctx.directory, "rolebox");
  const roleboxDir = existsSync(ctxRoleboxDir)
    ? ctxRoleboxDir
    : path.join(configDir, "rolebox");
  const globalSkillsDir = path.join(configDir, "skills");

  // Discover all roles from the rolebox directory.
  // Returns an empty Map when the directory does not exist or is empty.
  const roles = await discoverRoles(roleboxDir);

  // Resolve skills and build final prompts for every discovered role.
  const resolvedRoles = await resolveAllRoles(
    roles,
    roleboxDir,
    globalSkillsDir,
    configDir,
  );

  // Sync agent files to ~/.claude/agents/ for oh-my-openagent compatibility.
  syncAgentFiles(resolvedRoles);

  // Sync role skills as symlinks into ~/.config/opencode/skills/ so that
  // oh-my-openagent's skill tool can discover and load them.
  syncSkillSymlinks(resolvedRoles, globalSkillsDir);

  return {
    config: async (config) => {
      for (const resolved of resolvedRoles) {
        const agentConfig = buildAgentConfig(resolved);
        config.agent ??= {};
        config.agent[resolved.id] = agentConfig;

        for (const sub of resolved.subagents) {
          const subAgentCfg: Record<string, unknown> = {
            prompt: sub.prompt,
            mode: "subagent",
            hidden: true,
          };
          if (sub.config.description) subAgentCfg.description = sub.config.description;
          if (sub.config.model) subAgentCfg.model = sub.config.model;
          if (sub.config.color) subAgentCfg.color = sub.config.color;
          if (sub.config.variant) subAgentCfg.variant = sub.config.variant;
          if (sub.config.temperature !== undefined) subAgentCfg.temperature = sub.config.temperature;
          if (sub.config.top_p !== undefined) subAgentCfg.top_p = sub.config.top_p;
          if (sub.config.tools) subAgentCfg.tools = sub.config.tools;
          if (sub.config.permission) subAgentCfg.permission = sub.config.permission;

          config.agent[sub.id] = subAgentCfg as AgentConfig;
        }
      }
    },
    "chat.message": async (input, output) => {
      const textPartIndex = output.parts.findIndex(
        (p: { type: string; text?: string }) => p.type === "text" && "text" in p,
      );
      if (textPartIndex === -1) return;

      const part = output.parts[textPartIndex] as { type: string; text: string };
      const { functions: parsedFunctions, calls, cleanedText } = parseFunctionActivation(part.text);
      if (parsedFunctions.length === 0) return;

      part.text = cleanedText;

      const roleId = input.agent;
      const roleFunctions = roleId ? roleFunctionsMap.get(roleId) : null;

      if (roleFunctions) {
        const validNames = new Set(roleFunctions.map((f) => f.name));
        const validFunctions = parsedFunctions.filter((fn) => validNames.has(fn));
        const validCalls = calls.filter((c) => validNames.has(c.name));
        functionSessionState.activate(input.sessionID, validFunctions, validCalls);
      } else {
        functionSessionState.activate(input.sessionID, parsedFunctions, calls);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;

      const activeNames = functionSessionState.getActive(input.sessionID);
      if (activeNames.size === 0) return;

      const allFunctions: ResolvedFunction[] = [];
      for (const funcs of roleFunctionsMap.values()) {
        allFunctions.push(...funcs);
      }

      const seen = new Set<string>();
      const activeFunctions: ResolvedFunction[] = [];
      for (const fn of allFunctions) {
        if (activeNames.has(fn.name) && !seen.has(fn.name)) {
          // Apply parameter substitution if the function was called with args
          const call = functionSessionState.getCall(input.sessionID, fn.name);
          if (call && fn.params && Object.keys(call.args).length > 0) {
            activeFunctions.push({ ...fn, content: applyParams(fn, call) });
          } else {
            activeFunctions.push(fn);
          }
          seen.add(fn.name);
        }
      }

      if (activeFunctions.length === 0) return;

      const block = buildFunctionBlock(activeFunctions);
      output.system.push(block);
    },
  };
};

export default {
  id: "rolebox",
  server: RoleboxPlugin,
};

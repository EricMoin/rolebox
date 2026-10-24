import path from "node:path";
import { existsSync } from "node:fs";

import { resolveSkills } from "./skill-resolver.ts";
import { resolveAllReferences } from "./reference-resolver.ts";
import { resolveFunctions } from "../function/file-resolver.ts";
import { buildAgentPrompt } from "../prompt/builder.ts";
import { collectOpenRoles, type OpenRoleEntry } from "./open-roles.ts";
import { subagentDir, globalFunctionsPath } from "../utils/paths.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type { RoleConfig, ResolvedRole, ResolvedSubAgent, ResolvedSkill, ResolvedFunction, ResolvedReference, SubAgentConfig } from "../types.ts";
import { ReferenceScope, DEFAULT_FUNCTIONS, SUBAGENT_ID_SEPARATOR, INHERITABLE_FIELDS } from "../constants.ts";

const log = createSubLogger("orchestrator");

export interface ResolveContext {
  roleboxDir: string;
  globalSkillsDir: string;
  configDir: string;
  builtinDir: string;
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
}

interface ResolveAgentBundleInput {
  skillNames: string[];
  roleDir: string;
  globalSkillsDir: string;
  enabledFunctionNames: string[];
  globalFunctionsDir: string;
  builtinDir: string;
  referenceConfig?: RoleConfig["references"];
  baseReferences?: ResolvedReference[];
}

interface ResolveAgentBundleOutput {
  skills: ResolvedSkill[];
  functions: ResolvedFunction[];
  roleReferences: ResolvedReference[];
  references: ResolvedReference[];
}

async function resolveAgentBundle(
  input: ResolveAgentBundleInput,
): Promise<ResolveAgentBundleOutput> {
  const {
    skillNames,
    roleDir,
    globalSkillsDir,
    enabledFunctionNames,
    globalFunctionsDir,
    builtinDir,
    referenceConfig,
    baseReferences,
  } = input;

  const skills = skillNames.length > 0
    ? await resolveSkills(skillNames, roleDir, globalSkillsDir)
    : [];

  const functions = enabledFunctionNames.length > 0
    ? await resolveFunctions(enabledFunctionNames, roleDir, globalFunctionsDir, builtinDir)
    : [];

  const ownRoleRefs = await resolveAllReferences(roleDir, ReferenceScope.Role, referenceConfig);
  const skillRefs = skills.flatMap((s) => s.references);
  const references = [...(baseReferences ?? []), ...ownRoleRefs, ...skillRefs];

  return { skills, functions, roleReferences: ownRoleRefs, references };
}

async function resolveSubagents(
  parentFullId: string,
  configs: SubAgentConfig[],
  depth: number,
  roleId: string,
  roleDir: string,
  ctx: ResolveContext,
  roleReferences: ResolvedReference[],
  inheritedParent: RoleConfig,
): Promise<ResolvedSubAgent[]> {

  const globalFunctionsDir = globalFunctionsPath(ctx.configDir);

  const results = await Promise.all(
    configs.map(async (saConfig) => {
      const childSlug = saConfig.name.toLowerCase().replace(/\s+/g, "-");
      const childId = `${parentFullId}${SUBAGENT_ID_SEPARATOR}${childSlug}`;

      const slugDir = subagentDir(roleDir, childSlug);
      const nameDir = subagentDir(roleDir, saConfig.name);
      const saRoleDir = existsSync(slugDir)
        ? slugDir
        : existsSync(nameDir)
          ? nameDir
          : roleDir;
      const saLocalSkills = saConfig.skills ?? [];
      const saGlobalSkills = saConfig.opencode_skills ?? [];
      const saAllSkillNames = [...saLocalSkills, ...saGlobalSkills];
      const saFunctionNames = [...new Set([...DEFAULT_FUNCTIONS, ...(saConfig.functions ?? [])])];
      const saEnabledFunctions = saFunctionNames.filter(
        (fn) => !(saConfig.disable_functions ?? []).includes(fn),
      );

      const saBundle = await resolveAgentBundle({
        skillNames: saAllSkillNames,
        roleDir: saRoleDir,
        globalSkillsDir: ctx.globalSkillsDir,
        enabledFunctionNames: saEnabledFunctions,
        globalFunctionsDir,
        builtinDir: ctx.builtinDir,
        baseReferences: roleReferences,
      });
      const { skills: saSkills, functions: saFunctions, references: saReferences } = saBundle;

      // Resolve nested subagents first so we can include their metadata
      // in this subagent's prompt `## Available sub-agents` block.
      const resolvedChildren = saConfig.subagents?.length
        ? await resolveSubagents(
            childId,
            saConfig.subagents,
            depth + 1,
            roleId,
            saRoleDir,
            ctx,
            saReferences,
            saConfig as unknown as RoleConfig,
          )
        : [];

      const childMetadata = resolvedChildren.map(child => ({
        id: child.id,
        name: child.config.name,
        description: child.config.description,
      }));

      const saPrompt = buildAgentPrompt(saConfig, saSkills, {
        references: saReferences,
        canDelegate: saConfig.tools?.graph_declare !== false,
        ...(childMetadata.length > 0 ? { subagents: childMetadata } : {}),
      });

      ctx.roleFunctionsMap.set(childId, saFunctions);

      const inheritedFrom: Record<string, unknown> = {};
      const parentObj = inheritedParent as unknown as Record<string, unknown>;
      const childObj = saConfig as unknown as Record<string, unknown>;
      for (const key of INHERITABLE_FIELDS) {
        if (parentObj[key] !== undefined && childObj[key] === parentObj[key]) {
          inheritedFrom[key] = parentObj[key];
        }
      }

      return {
        id: childId,
        config: saConfig,
        prompt: saPrompt,
        skills: saSkills,
        functions: saFunctions,
        references: saReferences,
        parentId: parentFullId,
        inheritedFrom,
        subagents: resolvedChildren,
      };
    }),
  );

  return results;
}

/** Resolve top-level teammates, excluding the requesting role when known. */
export function resolvePublicAgents(
  _config: RoleConfig,
  openRegistry: Map<string, OpenRoleEntry>,
  roleId?: string,
): Array<{ id: string; name: string; description: string }> {
  return [...openRegistry.values()]
    .filter((entry) => entry.roleId !== roleId && !entry.roleId.includes(SUBAGENT_ID_SEPARATOR))
    .map((entry) => ({ id: entry.roleId, name: entry.name, description: entry.description }));
}

export async function resolveAllRoles(
  roles: Map<string, RoleConfig>,
  ctx: ResolveContext,
): Promise<ResolvedRole[]> {
  const resolved: ResolvedRole[] = [];

  for (const [roleId, config] of roles) {
    try {
      const roleDir = path.join(ctx.roleboxDir, roleId);

      const localSkills = config.skills ?? [];
      const globalSkills = config.opencode_skills ?? [];
      const allSkillNames = [...localSkills, ...globalSkills];

      const functionNames = [...new Set([...DEFAULT_FUNCTIONS, ...(config.functions ?? [])])];
      const enabledFunctions = functionNames.filter(
        (fn) => !(config.disable_functions ?? []).includes(fn),
      );

      const globalFunctionsDir = globalFunctionsPath(ctx.configDir);

      const bundle = await resolveAgentBundle({
        skillNames: allSkillNames,
        roleDir,
        globalSkillsDir: ctx.globalSkillsDir,
        enabledFunctionNames: enabledFunctions,
        globalFunctionsDir,
        builtinDir: ctx.builtinDir,
        referenceConfig: config.references as RoleConfig["references"],
      });
      const { skills, functions, roleReferences, references: allReferences } = bundle;

      const resolvedSubagents = config.subagents?.length
        ? await resolveSubagents(roleId, config.subagents, 0, roleId, roleDir, ctx, roleReferences, config)
        : [];

      resolved.push({
        id: roleId,
        config,
        prompt: config.prompt,
        skills,
        functions,
        references: allReferences,
        subagents: resolvedSubagents,
        ...(config.dispatch ? { dispatchConfig: config.dispatch as ResolvedRole["dispatchConfig"] } : {}),
        ...(Array.isArray(config.auto_activate)
          ? { auto_activate: config.auto_activate as string[] }
          : {}),
        ...(typeof config.locked === "boolean"
          ? { locked: config.locked as boolean }
          : {}),
      });
      ctx.roleFunctionsMap.set(roleId, functions);
    } catch (err) {
      log.error("Failed to process role, skipping", { roleId, error: formatError(err) });
    }
  }

  const openRegistry = collectOpenRoles(resolved);
  for (const role of resolved) {
    role.prompt = buildAgentPrompt(role.config, role.skills, {
      subagents: role.subagents.map((subagent) => ({
        id: subagent.id,
        name: subagent.config.name,
        description: subagent.config.description,
      })),
      references: role.references,
      canDelegate: role.config.tools?.graph_declare !== false,
      canTeam: true,
      publicAgents: resolvePublicAgents(role.config, openRegistry, role.id),
    });
  }

  return resolved;
}

import path from "node:path";
import { existsSync } from "node:fs";
import { resolveSkills } from "../skill-resolver.ts";
import { resolveAllReferences } from "../reference-resolver.ts";
import { resolveFunctions } from "../function-resolver.ts";
import { buildSubagentRoleBlock, parseCollaboration } from "../graph/index.ts";
import { buildAgentPrompt } from "../prompt-builder.ts";
import { subagentDir, globalFunctionsPath } from "../paths.ts";
import type { RoleConfig, ResolvedRole, ResolvedSubAgent, ResolvedSkill, ResolvedFunction, ResolvedGraph, GraphNodeRole } from "../types.ts";
import { ReferenceScope, DEFAULT_FUNCTIONS, SUBAGENT_ID_SEPARATOR, PARENT_NODE } from "../constants.ts";

export function computeNodeRole(
  graph: ResolvedGraph,
  agentId: string,
  childSlug: string,
): GraphNodeRole | null {
  const downstream = graph.edges
    .filter((e) => e.from === childSlug && e.to !== PARENT_NODE)
    .map((e) => e.to);
  const upstream = graph.edges
    .filter((e) => e.to === childSlug && e.from !== PARENT_NODE)
    .map((e) => e.from);
  const isEntryPoint = graph.edges.some(
    (e) => e.from === PARENT_NODE && e.to === childSlug,
  );
  const isExitPoint = graph.edges.some(
    (e) => e.from === childSlug && (e.to === PARENT_NODE || e.exit === true),
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

export interface ResolveContext {
  roleboxDir: string;
  globalSkillsDir: string;
  configDir: string;
  builtinDir: string;
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  roleGraphMap: Map<string, ResolvedGraph>;
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

      let skills: ResolvedSkill[] = [];
      if (allSkillNames.length > 0) {
        skills = await resolveSkills(allSkillNames, roleDir, ctx.globalSkillsDir);
      }

      const roleReferences = await resolveAllReferences(
        roleDir,
        ReferenceScope.Role,
        config.references as RoleConfig["references"],
      );

      const skillReferences = skills.flatMap((s) => s.references);
      const allReferences = [...roleReferences, ...skillReferences];

      const globalFunctionsDir = globalFunctionsPath(ctx.configDir);

      const functionNames = config.functions ?? [...DEFAULT_FUNCTIONS];
      const enabledFunctions = functionNames.filter(
        (fn) => !(config.disable_functions ?? []).includes(fn),
      );

      let functions: ResolvedFunction[] = [];
      if (enabledFunctions.length > 0) {
        functions = await resolveFunctions(enabledFunctions, roleDir, globalFunctionsDir, ctx.builtinDir);
      }

      const resolvedSubagents: ResolvedSubAgent[] = [];
      if (config.subagents && config.subagents.length > 0) {
        for (const saConfig of config.subagents) {
          const childSlug = saConfig.name.toLowerCase().replace(/\s+/g, "-");
          const childId = `${roleId}${SUBAGENT_ID_SEPARATOR}${childSlug}`;

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
          let saSkills: ResolvedSkill[] = [];
          if (saAllSkillNames.length > 0) {
            saSkills = await resolveSkills(saAllSkillNames, saRoleDir, ctx.globalSkillsDir);
          }

          const saFunctionNames = saConfig.functions ?? [...DEFAULT_FUNCTIONS];
          const saEnabledFunctions = saFunctionNames.filter(
            (fn) => !(saConfig.disable_functions ?? []).includes(fn),
          );
          let saFunctions: ResolvedFunction[] = [];
          if (saEnabledFunctions.length > 0) {
            saFunctions = await resolveFunctions(
              saEnabledFunctions,
              saRoleDir,
              globalFunctionsDir,
              ctx.builtinDir,
            );
          }

          const saOwnRefs = await resolveAllReferences(saRoleDir, ReferenceScope.Role);
          const saSkillRefs = saSkills.flatMap((s) => s.references);
          const saReferences = [...roleReferences, ...saOwnRefs, ...saSkillRefs];

          const saPrompt = buildAgentPrompt(saConfig, saSkills, { references: saReferences });

          ctx.roleFunctionsMap.set(childId, saFunctions);

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

      let graph: ResolvedGraph | undefined;
      if (config.collaboration) {
        const subagentSlugNames = (config.subagents ?? []).map(sa =>
          sa.name.toLowerCase().replace(/\s+/g, "-")
        );
        const resolvedGraph = parseCollaboration(config.collaboration, subagentSlugNames);
        if (resolvedGraph) {
          graph = resolvedGraph;
          ctx.roleGraphMap.set(roleId, resolvedGraph);
        } else {
          console.warn(`[role-loader] Failed to parse collaboration graph for role "${roleId}" — role will load without graph`);
        }
      }

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

      const subagentMetadata = resolvedSubagents.map((sa) => ({
        id: sa.id,
        name: sa.config.name,
        description: sa.config.description,
      }));
      const prompt = buildAgentPrompt(config, skills, { subagents: subagentMetadata, references: allReferences, graph });

      resolved.push({ id: roleId, config, prompt, skills, functions, references: allReferences, subagents: resolvedSubagents, graph });
      ctx.roleFunctionsMap.set(roleId, functions);
    } catch {
      // Silently skip roles that fail during resolution.
    }
  }

  return resolved;
}

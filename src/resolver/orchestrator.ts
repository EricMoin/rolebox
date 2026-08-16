import path from "node:path";
import { existsSync } from "node:fs";

import { resolveSkills } from "./skill-resolver.ts";
import { resolveAllReferences } from "./reference-resolver.ts";
import { resolveFunctions } from "../function/file-resolver.ts";
import { buildSubagentRoleBlock, SUBAGENT_RESULT_CONTRACT } from "../graph/prompt-builder.ts";
import { autoConvertCollaboration, graphDeclarationToResolvedGraph } from "../graph/collaboration-bridge.ts";
import { buildAgentPrompt } from "../prompt/builder.ts";
import { collectOpenRoles, type OpenRoleEntry } from "./open-roles.ts";
import { subagentDir, globalFunctionsPath } from "../utils/paths.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type { RoleConfig, ResolvedRole, ResolvedSubAgent, ResolvedSkill, ResolvedFunction, ResolvedReference, ResolvedGraph, GraphNodeRole, SubAgentConfig } from "../types.ts";
import { ReferenceScope, DEFAULT_FUNCTIONS, SUBAGENT_ID_SEPARATOR, PARENT_NODE } from "../constants.ts";

const log = createSubLogger("orchestrator");

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
      // in this subagent's prompt <available_subagents> block.
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
        ...(childMetadata.length > 0 ? { subagents: childMetadata } : {}),
      });

      ctx.roleFunctionsMap.set(childId, saFunctions);

      const inheritedFrom: Record<string, unknown> = {};
      const parentObj = inheritedParent as unknown as Record<string, unknown>;
      const childObj = saConfig as unknown as Record<string, unknown>;
      const inheritableKeys = ["model", "color", "variant", "temperature", "top_p", "permission", "tools"] as const;
      for (const key of inheritableKeys) {
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

/**
 * Build a minimal pre-resolution ResolvedRole stub from a raw RoleConfig.
 *
 * The open-role pre-pass in resolveAllRoles runs BEFORE subagents are resolved,
 * so it feeds collectOpenRoles these stubs: export names still resolve to full
 * `roleId--slug` ids against the raw subagent tree, using the exact slug
 * computation resolveSubagents applies (orchestrator.ts:118-119). The stub
 * carries no skills/functions/references — collectOpenRoles only reads the id,
 * the config (open/name/description/exports) and the subagent id/name tree.
 */
function stubResolvedRole(roleId: string, config: RoleConfig): ResolvedRole {
  const stubSubagent = (sa: SubAgentConfig, parentId: string): ResolvedSubAgent => {
    const slug = sa.name.toLowerCase().replace(/\s+/g, "-");
    const id = `${parentId}${SUBAGENT_ID_SEPARATOR}${slug}`;
    return {
      id,
      config: sa,
      prompt: sa.prompt,
      skills: [],
      functions: [],
      references: [],
      subagents: (sa.subagents ?? []).map((child) => stubSubagent(child, id)),
      parentId,
      inheritedFrom: {},
    };
  };
  return {
    id: roleId,
    config,
    prompt: config.prompt,
    skills: [],
    functions: [],
    references: [],
    subagents: (config.subagents ?? []).map((sa) => stubSubagent(sa, roleId)),
  };
}

/**
 * Resolve the <available_public_agents> metadata for a consumer role: every
 * producer id in config.open_roles that exists in the open-role registry
 * yields {id, name, description}. Unknown producer ids warn and are skipped;
 * duplicate declarations are collapsed.
 *
 * Exported so the hot-reload fast path can rebuild a role's prompt with the
 * same open-agents metadata after a skill-only reload (see
 * src/core/services/hot-reload-service.ts performFastReload).
 */
export function resolvePublicAgents(
  config: RoleConfig,
  openRegistry: Map<string, OpenRoleEntry>,
): Array<{ id: string; name: string; description: string }> {
  const agents: Array<{ id: string; name: string; description: string }> = [];
  const seen = new Set<string>();
  for (const producerId of config.open_roles ?? []) {
    if (seen.has(producerId)) continue;
    seen.add(producerId);
    const entry = openRegistry.get(producerId);
    if (entry === undefined) {
      log.warn(
        `Role "${config.name}" declares open_roles for "${producerId}", but no open role with that id was found`,
      );
      continue;
    }
    agents.push({ id: entry.roleId, name: entry.name, description: entry.description });
  }
  return agents;
}

export async function resolveAllRoles(
  roles: Map<string, RoleConfig>,
  ctx: ResolveContext,
): Promise<ResolvedRole[]> {
  const resolved: ResolvedRole[] = [];

  // Pre-pass: compute the open-role registry (roles with open: true plus their
  // resolved export ids) from the raw configs, BEFORE per-role resolution.
  // Consumer roles declaring open_roles: [producerId] then receive the
  // producer's metadata in <available_public_agents> inside the loop.
  const openRegistry = collectOpenRoles(
    Array.from(roles.entries(), ([roleId, config]) =>
      stubResolvedRole(roleId, config),
    ),
  );

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

      let graph: ResolvedGraph | undefined;
      if (config.collaboration) {
        const subagentSlugNames = (config.subagents ?? []).map(sa =>
          sa.name.toLowerCase().replace(/\s+/g, "-")
        );
        // Route the legacy `collaboration:` path through the v2 converter +
        // bridge, which reproduces the v1 ResolvedGraph the downstream prompt
        // and state builders consume.
        const declaration = autoConvertCollaboration(config.collaboration, {
          parentAgentId: roleId,
          roleName: config.name ?? roleId,
        });
        const resolvedGraph = graphDeclarationToResolvedGraph(declaration, {
          availableSubagentNames: subagentSlugNames,
        });
        if (resolvedGraph) {
          graph = resolvedGraph;
          ctx.roleGraphMap.set(roleId, resolvedGraph);
        } else {
          log.info("Failed to resolve collaboration graph", { roleId });
        }
      }

      if (graph) {
        for (const sa of resolvedSubagents) {
          const childSlug = sa.config.name.toLowerCase().replace(/\s+/g, "-");
          const nodeRole = computeNodeRole(graph, sa.id, childSlug);
          if (nodeRole) {
            const roleBlock = buildSubagentRoleBlock(nodeRole);
            sa.prompt = `${sa.prompt}\n\n${roleBlock}\n\n${SUBAGENT_RESULT_CONTRACT}`;
          }
        }
      }

      const subagentMetadata = resolvedSubagents.map((sa) => ({
        id: sa.id,
        name: sa.config.name,
        description: sa.config.description,
      }));
      const publicAgents = resolvePublicAgents(config, openRegistry);
      const prompt = buildAgentPrompt(config, skills, {
        subagents: subagentMetadata,
        references: allReferences,
        graph,
        ...(publicAgents.length > 0 ? { publicAgents } : {}),
      });

      resolved.push({
        id: roleId,
        config,
        prompt,
        skills,
        functions,
        references: allReferences,
        subagents: resolvedSubagents,
        graph,
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

  return resolved;
}

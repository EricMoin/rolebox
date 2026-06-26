/**
 * YAML role loader for rolebox.
 *
 * Scans a rolebox directory for role definitions (role.yaml files)
 * and returns a Map of parsed and validated RoleConfig objects keyed
 * by their directory name (roleId).
 *
 * Handles: YAML parsing, prompt_file loading, env var resolution,
 * graceful skip-on-error, and empty-directory / nonexistent-directory cases.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as pathResolve } from "node:path";
import fglob from "fast-glob";
import yaml from "js-yaml";
import { resolveEnvVarsDeep, resolveEnvVars } from "./env-resolver.ts";
import type { RoleConfig, SubAgentConfig } from "./types.ts";
import { RoleMode, ROLE_MODE_VALUES, SUBAGENT_ID_SEPARATOR } from "./constants.ts";

/**
 * Validate a role ID string.
 *
 * Rejects IDs that are empty or contain `--` (double dash), which would be
 * ambiguous in certain contexts (e.g. CLI argument parsing).
 *
 * @param id - The role ID to validate (typically a directory name).
 * @returns `true` if the ID is valid, `false` otherwise.
 */
export function validateRoleId(id: string): boolean {
  if (id === "") return false;
  return !id.includes(SUBAGENT_ID_SEPARATOR);
}

/**
 * Discover roles by scanning `roleboxDir` for subdirectories containing
 * `role.yaml` files. Only scans ONE level deep (roleboxDir/{role}/role.yaml).
 *
 * @param roleboxDir - Absolute path to the rolebox configuration directory.
 * @returns Map of roleId → RoleConfig for valid roles. Empty Map if no roles found.
 */
export async function discoverRoles(
  roleboxDir: string,
): Promise<Map<string, RoleConfig>> {
  const roles = new Map<string, RoleConfig>();

  let matches: string[];
  try {
    matches = await fglob("**/role.yaml", {
      cwd: roleboxDir,
      absolute: true,
      deep: 2,
    });
  } catch {
    // roleboxDir doesn't exist or glob fails — return empty Map silently
    return roles;
  }

  for (const yamlPath of matches) {
    const roleId = basename(dirname(yamlPath));

    if (!validateRoleId(roleId)) {
      console.warn(
        `[role-loader] Skipping "${roleId}": role ID must not contain "--"`,
      );
      continue;
    }

    try {
      const config = await loadOneRole(yamlPath, roleId);
      if (config !== null) {
        roles.set(roleId, config);
      }
    } catch {
      // Unexpected errors during loadOneRole; skip and continue
      console.warn(
        `[role-loader] Skipping "${roleId}": unexpected error during load`,
      );
    }
  }

  return roles;
}

/**
 * Merge parent RoleConfig defaults into a child SubAgentConfig.
 *
 * For each inheritable field, the child's explicit value takes priority.
 * If the child omits a field (undefined), the parent's value is used as
 * a fallback. Fields that are specific to the sub-agent (name, description,
 * prompt, prompt_file, skills, opencode_skills, functions, disable_functions)
 * are NEVER inherited from the parent.
 *
 * Inheritable fields: model, color, variant, temperature, top_p,
 * permission, tools.
 *
 * @param parent - The resolved parent role configuration.
 * @param child  - The raw sub-agent configuration from YAML or file discovery.
 * @returns A new SubAgentConfig with inherited defaults applied.
 */
export interface InheritanceResult {
  config: SubAgentConfig;
  inheritedFields: string[];
}

export function applyInheritance(
  parent: RoleConfig,
  child: SubAgentConfig,
): SubAgentConfig;
export function applyInheritance(
  parent: RoleConfig,
  child: SubAgentConfig,
  trackInheritance: true,
): InheritanceResult;
export function applyInheritance(
  parent: RoleConfig,
  child: SubAgentConfig,
  trackInheritance?: boolean,
): SubAgentConfig | InheritanceResult {
  const inheritedFields: string[] = [];

  const inheritableFields: Array<{ key: string; childVal: unknown; parentVal: unknown }> = [
    { key: "model", childVal: child.model, parentVal: parent.model },
    { key: "color", childVal: child.color, parentVal: parent.color },
    { key: "variant", childVal: child.variant, parentVal: parent.variant },
    { key: "temperature", childVal: child.temperature, parentVal: parent.temperature },
    { key: "top_p", childVal: child.top_p, parentVal: parent.top_p },
    { key: "permission", childVal: child.permission, parentVal: parent.permission },
    { key: "tools", childVal: child.tools, parentVal: parent.tools },
  ];

  const merged: Record<string, unknown> = {
    name: child.name,
    description: child.description,
    prompt: child.prompt,
    ...(child.prompt_file !== undefined
      ? { prompt_file: child.prompt_file }
      : {}),
    ...(child.skills !== undefined ? { skills: child.skills } : {}),
    ...(child.opencode_skills !== undefined
      ? { opencode_skills: child.opencode_skills }
      : {}),
    ...(child.functions !== undefined
      ? { functions: child.functions }
      : {}),
    ...(child.disable_functions !== undefined
      ? { disable_functions: child.disable_functions }
      : {}),
  };

  for (const { key, childVal, parentVal } of inheritableFields) {
    const resolved = childVal ?? parentVal;
    if (resolved !== undefined) {
      merged[key] = resolved;
    }
    if (childVal === undefined && parentVal !== undefined) {
      inheritedFields.push(key);
    }
  }

  const config = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  ) as unknown as SubAgentConfig;

  if (trackInheritance) {
    return { config, inheritedFields };
  }
  return config;
}

/**
 * Parse and validate a single role.yaml file.
 *
 * @returns RoleConfig on success, null if the role should be skipped
 *          (validation failure already logged via console.warn).
 */
async function loadOneRole(
  yamlPath: string,
  roleId: string,
): Promise<RoleConfig | null> {
  let raw: unknown;
  try {
    const content = await readFile(yamlPath, "utf-8");
    raw = yaml.load(content);
  } catch (err) {
    console.warn(
      `[role-loader] Skipping "${roleId}": invalid YAML — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (raw === null || raw === undefined || typeof raw !== "object") {
    console.warn(
      `[role-loader] Skipping "${roleId}": YAML does not contain an object`,
    );
    return null;
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== "string" || obj.name.trim() === "") {
    console.warn(
      `[role-loader] Skipping "${roleId}": missing or invalid "name" field`,
    );
    return null;
  }

  let prompt: string;
  if (typeof obj.prompt_file === "string" && obj.prompt_file.trim() !== "") {
    const promptFilePath = pathResolve(dirname(yamlPath), obj.prompt_file);
    try {
      prompt = await readFile(promptFilePath, "utf-8");
    } catch {
      console.warn(
        `[role-loader] Skipping "${roleId}": prompt_file "${obj.prompt_file}" not found`,
      );
      return null;
    }
  } else if (typeof obj.prompt === "string" && obj.prompt.trim() !== "") {
    prompt = obj.prompt;
  } else {
    console.warn(
      `[role-loader] Skipping "${roleId}": must provide "prompt" or "prompt_file"`,
    );
    return null;
  }

  prompt = resolveEnvVars(prompt);
  const resolved = resolveEnvVarsDeep(obj) as Record<string, unknown>;

  const rawSubagents = resolved.subagents;
  let validSubagents: SubAgentConfig[] = [];
  const seenSubagentNames = new Set<string>();
  if (Array.isArray(rawSubagents)) {
    for (const raw of rawSubagents) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;

      if (
        !entry.name ||
        typeof entry.name !== "string" ||
        entry.name.trim() === ""
      ) {
        console.warn(
          `[role-loader] Skipping subagent in "${roleId}": missing or invalid "name"`,
        );
        continue;
      }

      if (!validateRoleId(entry.name as string)) {
        console.warn(
          `[role-loader] Skipping subagent "${entry.name}" in "${roleId}": name must not contain "--"`,
        );
        continue;
      }

      if ("subagents" in entry) {
        console.warn(
          `[role-loader] Stripping nested "subagents" from subagent "${entry.name}" in "${roleId}"`,
        );
      }

      let subPrompt: string;
      if (
        typeof entry.prompt_file === "string" &&
        entry.prompt_file.trim() !== ""
      ) {
        const promptFilePath = pathResolve(
          dirname(yamlPath),
          entry.prompt_file,
        );
        try {
          subPrompt = await readFile(promptFilePath, "utf-8");
          subPrompt = resolveEnvVars(subPrompt);
        } catch {
          console.warn(
            `[role-loader] Skipping subagent "${entry.name}" in "${roleId}": prompt_file "${entry.prompt_file}" not found`,
          );
          continue;
        }
      } else if (
        typeof entry.prompt === "string" &&
        entry.prompt.trim() !== ""
      ) {
        subPrompt = entry.prompt;
      } else {
        console.warn(
          `[role-loader] Skipping subagent "${entry.name}" in "${roleId}": must provide "prompt" or "prompt_file"`,
        );
        continue;
      }

      const subagent: SubAgentConfig = {
        name: entry.name as string,
        description: (entry.description as string) ?? "",
        prompt: subPrompt,
        ...(typeof entry.prompt_file === "string"
          ? { prompt_file: entry.prompt_file }
          : {}),
        ...(typeof entry.model === "string"
          ? { model: entry.model }
          : {}),
        ...(typeof entry.color === "string"
          ? { color: entry.color }
          : {}),
        ...(typeof entry.variant === "string"
          ? { variant: entry.variant }
          : {}),
        ...(typeof entry.temperature === "number"
          ? { temperature: entry.temperature }
          : {}),
        ...(typeof entry.top_p === "number"
          ? { top_p: entry.top_p }
          : {}),
        ...(entry.permission != null &&
        typeof entry.permission === "object"
          ? {
              permission:
                entry.permission as SubAgentConfig["permission"],
            }
          : {}),
        ...(entry.tools != null && typeof entry.tools === "object"
          ? { tools: entry.tools as Record<string, boolean> }
          : {}),
        ...(Array.isArray(entry.skills)
          ? { skills: entry.skills as string[] }
          : {}),
        ...(Array.isArray(entry.opencode_skills)
          ? {
              opencode_skills:
                entry.opencode_skills as string[],
            }
          : {}),
        ...(Array.isArray(entry.functions)
          ? { functions: entry.functions as string[] }
          : {}),
        ...(Array.isArray(entry.disable_functions)
          ? {
              disable_functions:
                entry.disable_functions as string[],
            }
          : {}),
      };

      if (seenSubagentNames.has(subagent.name)) {
        console.warn(
          `[role-loader] Duplicate subagent name "${subagent.name}" in "${roleId}": later definition wins`,
        );
        validSubagents = validSubagents.filter((s) => s.name !== subagent.name);
      }
      seenSubagentNames.add(subagent.name);
      validSubagents.push(subagent);
    }
  }

  const roleDir = dirname(yamlPath);
  const fileBasedSubagents = await discoverFileBasedSubagents(roleDir, roleId);

  const mergedMap = new Map<string, SubAgentConfig>();
  for (const sa of validSubagents) {
    mergedMap.set(sa.name, sa);
  }
  for (const sa of fileBasedSubagents) {
    if (!mergedMap.has(sa.name)) {
      mergedMap.set(sa.name, sa);
    }
  }

  const mergedSubagents = mergedMap.size > 0 ? Array.from(mergedMap.values()) : undefined;

  const config: RoleConfig = {
    name: resolved.name as string,
    description: (resolved.description as string) ?? "",
    prompt,
    ...(typeof resolved.prompt_file === "string"
      ? { prompt_file: resolved.prompt_file }
      : {}),
    ...(typeof resolved.model === "string"
      ? { model: resolved.model }
      : {}),
    ...(typeof resolved.mode === "string" &&
      ROLE_MODE_VALUES.includes(resolved.mode as RoleMode)
      ? { mode: resolved.mode as RoleMode }
      : {}),
    ...(typeof resolved.color === "string"
      ? { color: resolved.color }
      : {}),
    ...(typeof resolved.variant === "string"
      ? { variant: resolved.variant }
      : {}),
    ...(Array.isArray(resolved.skills)
      ? { skills: resolved.skills as string[] }
      : {}),
    ...(Array.isArray(resolved.opencode_skills)
      ? { opencode_skills: resolved.opencode_skills as string[] }
      : {}),
    ...(resolved.permission != null && typeof resolved.permission === "object"
      ? { permission: resolved.permission as RoleConfig["permission"] }
      : {}),
    ...(resolved.tools != null && typeof resolved.tools === "object"
      ? { tools: resolved.tools as Record<string, boolean> }
      : {}),
    ...(typeof resolved.temperature === "number"
      ? { temperature: resolved.temperature }
      : {}),
    ...(typeof resolved.top_p === "number"
      ? { top_p: resolved.top_p }
      : {}),
    ...(Array.isArray(resolved.functions)
      ? { functions: resolved.functions as string[] }
      : {}),
    ...(Array.isArray(resolved.disable_functions)
      ? { disable_functions: resolved.disable_functions as string[] }
      : {}),
    ...(resolved.collaboration != null && typeof resolved.collaboration === "object"
      ? { collaboration: resolved.collaboration as RoleConfig["collaboration"] }
      : {}),
  };

  if (mergedSubagents) {
    config.subagents = mergedSubagents.map((sa) => applyInheritance(config, sa));
  }

  return config;
}

/**
 * Discover file-based subagents by scanning `{roleDir}/subagents/* / role.yaml`.
 *
 * Each matching directory is treated as a sub-agent definition. The directory
 * name becomes the sub-agent ID (used for logging / validation context), and
 * the role.yaml is parsed with the same rules as inline sub-agents.
 *
 * Non-existent or empty `subagents/` directories return an empty array
 * silently (not an error).
 *
 * @param roleDir - Absolute path to the role's directory (contains role.yaml).
 * @param roleId - Parent role ID (used for log messages only).
 * @returns Array of valid file-based sub-agent configs.
 */
async function discoverFileBasedSubagents(
  roleDir: string,
  roleId: string,
): Promise<SubAgentConfig[]> {
  let matches: string[];
  try {
    matches = await fglob("subagents/*/role.yaml", {
      cwd: roleDir,
      absolute: true,
      deep: 2,
    });
  } catch {
    // subagents/ doesn't exist or glob fails — silently return empty
    return [];
  }

  const subagents: SubAgentConfig[] = [];

  for (const yamlPath of matches) {
    const childId = basename(dirname(yamlPath));

    let raw: unknown;
    try {
      const content = await readFile(yamlPath, "utf-8");
      raw = yaml.load(content);
    } catch (err) {
      console.warn(
        `[role-loader] Skipping file-based subagent "${childId}" in "${roleId}": invalid YAML — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    if (raw === null || raw === undefined || typeof raw !== "object") {
      console.warn(
        `[role-loader] Skipping file-based subagent "${childId}" in "${roleId}": YAML does not contain an object`,
      );
      continue;
    }

    const entry = raw as Record<string, unknown>;

    // Validate name
    if (
      !entry.name ||
      typeof entry.name !== "string" ||
      entry.name.trim() === ""
    ) {
      console.warn(
        `[role-loader] Skipping file-based subagent "${childId}" in "${roleId}": missing or invalid "name"`,
      );
      continue;
    }

    // Validate name does not contain --
    if (!validateRoleId(entry.name as string)) {
      console.warn(
        `[role-loader] Skipping file-based subagent "${entry.name}" in "${roleId}": name must not contain "--"`,
      );
      continue;
    }

    // Reject nested subagents
    if ("subagents" in entry) {
      console.warn(
        `[role-loader] Stripping nested "subagents" from file-based subagent "${entry.name}" in "${roleId}"`,
      );
    }

    // Validate prompt (resolve prompt_file relative to subagent directory)
    const subagentDir = dirname(yamlPath);
    let subPrompt: string;
    let promptFilePath: string | undefined;
    if (
      typeof entry.prompt_file === "string" &&
      entry.prompt_file.trim() !== ""
    ) {
      promptFilePath = pathResolve(subagentDir, entry.prompt_file);
      try {
        subPrompt = await readFile(promptFilePath, "utf-8");
        subPrompt = resolveEnvVars(subPrompt);
      } catch {
        console.warn(
          `[role-loader] Skipping file-based subagent "${entry.name}" in "${roleId}": prompt_file "${entry.prompt_file}" not found`,
        );
        continue;
      }
    } else if (
      typeof entry.prompt === "string" &&
      entry.prompt.trim() !== ""
    ) {
      subPrompt = entry.prompt;
      subPrompt = resolveEnvVars(subPrompt);
    } else {
      console.warn(
        `[role-loader] Skipping file-based subagent "${entry.name}" in "${roleId}": must provide "prompt" or "prompt_file"`,
      );
      continue;
    }

    const subagent: SubAgentConfig = {
      name: entry.name as string,
      description: (entry.description as string) ?? "",
      prompt: subPrompt,
      ...(typeof entry.prompt_file === "string"
        ? { prompt_file: entry.prompt_file }
        : {}),
      ...(typeof entry.model === "string"
        ? { model: entry.model }
        : {}),
      ...(typeof entry.color === "string"
        ? { color: entry.color }
        : {}),
      ...(typeof entry.variant === "string"
        ? { variant: entry.variant }
        : {}),
      ...(typeof entry.temperature === "number"
        ? { temperature: entry.temperature }
        : {}),
      ...(typeof entry.top_p === "number"
        ? { top_p: entry.top_p }
        : {}),
      ...(entry.permission != null &&
      typeof entry.permission === "object"
        ? {
            permission:
              entry.permission as SubAgentConfig["permission"],
          }
        : {}),
      ...(entry.tools != null && typeof entry.tools === "object"
        ? { tools: entry.tools as Record<string, boolean> }
        : {}),
      ...(Array.isArray(entry.skills)
        ? { skills: entry.skills as string[] }
        : {}),
      ...(Array.isArray(entry.opencode_skills)
        ? {
            opencode_skills:
              entry.opencode_skills as string[],
          }
        : {}),
      ...(Array.isArray(entry.functions)
        ? { functions: entry.functions as string[] }
        : {}),
      ...(Array.isArray(entry.disable_functions)
        ? {
            disable_functions:
              entry.disable_functions as string[],
          }
        : {}),
    };

    subagents.push(subagent);
  }

  return subagents;
}

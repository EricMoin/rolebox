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
import { resolveEnvVarsDeep, resolveEnvVars } from "../resolver/env-resolver.ts";
import { resolveModel } from "../resolver/model-resolver.ts";
import type { RoleConfig, SubAgentConfig, DispatchRoleConfig } from "../types.ts";
import { RoleMode, ROLE_MODE_VALUES, SUBAGENT_ID_SEPARATOR, INHERITABLE_FIELDS, ROLE_YAML } from "../constants.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type { Logger, ILogObj } from "tslog";
import {
  resolveSubagentEntry,
  buildSubAgentFields,
  parseNestedSubagents,
  parseInlineSubagents,
  discoverFileBasedSubagents,
  setSubagentLogger,
} from "./subagents.ts";

let log: Logger<ILogObj> = createSubLogger("role-loader");

/** @internal Test seam — swap the module-level logger for a mock. */
export function __setLoggerForTest(mockLogger: Logger<ILogObj>): void {
  log = mockLogger;
  setSubagentLogger(mockLogger);
}

export function validateRoleId(id: string): boolean {
  if (id === "") return false;
  return !id.includes(SUBAGENT_ID_SEPARATOR);
}

// ── Public API ─────────────────────────────────────────────────────────

export async function discoverRoles(
  roleboxDir: string,
): Promise<Map<string, RoleConfig>> {
  const roles = new Map<string, RoleConfig>();

  let matches: string[];
  try {
    matches = await fglob(`**/${ROLE_YAML}`, {
      cwd: roleboxDir,
      absolute: true,
      deep: 2,
    });
  } catch {
    return roles;
  }

  for (const yamlPath of matches) {
    const roleId = basename(dirname(yamlPath));

    if (!validateRoleId(roleId)) {
      log.info(
              `Skipping "${roleId}": role ID must not contain "--". Rename the directory to avoid the "--" separator.`,
            );
      continue;
    }

    try {
      const config = await loadOneRole(yamlPath, roleId);
      if (config !== null) {
        roles.set(roleId, config);
      }
    } catch (err) {
      log.error(
        `Skipping "${roleId}": unexpected error during load`,
        formatError(err),
      );
    }
  }

  return roles;
}

// ── Inheritance ────────────────────────────────────────────────────────

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
    ...(child.subagents !== undefined
      ? { subagents: child.subagents }
      : {}),
    ...(child.auto_activate !== undefined
      ? { auto_activate: child.auto_activate }
      : {}),
    ...(child.locked !== undefined
      ? { locked: child.locked }
      : {}),
  };

  for (const key of INHERITABLE_FIELDS) {
    const childVal = (child as unknown as Record<string, unknown>)[key];
    const parentVal = (parent as unknown as Record<string, unknown>)[key];
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

// ── Dispatch parsing ───────────────────────────────────────────────────

function parseDispatchConfig(
  raw: Record<string, unknown> | null | undefined,
  roleId: string,
): DispatchRoleConfig | undefined {
  if (raw == null || typeof raw !== "object") return undefined;

  const validFields: Record<string, number> = {};
  const knownKeys = [
    "backgroundStaleTimeoutMs",
    "syncPromptTimeoutMs",
  ];

  for (const key of knownKeys) {
    const val = (raw as Record<string, unknown>)[key];
    if (val === undefined || val === null) continue;

    const num = Number(val);
    if (Number.isNaN(num) || num <= 0) {
      log.warn(`Skipping "${roleId}" dispatch.${key}: ${JSON.stringify(val)} — must be a positive number`);
      continue;
    }

    validFields[key] = num;
  }

  if (Object.keys(validFields).length === 0) return undefined;
  return validFields as unknown as DispatchRoleConfig;
}

// ── Single role loading ────────────────────────────────────────────────

async function parseAndValidateYaml(
  yamlPath: string,
  roleId: string,
): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    const content = await readFile(yamlPath, "utf-8");
    raw = yaml.load(content);
  } catch (err) {
    log.info(
      `Skipping "${roleId}": invalid YAML`,
      formatError(err),
    );
    return null;
  }

  if (raw === null || raw === undefined || typeof raw !== "object") {
    log.info(
      `Skipping "${roleId}": YAML does not contain an object`,
    );
    return null;
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== "string" || obj.name.trim() === "") {
    log.info(
      `Skipping "${roleId}": missing or invalid "name" field. Add a "name:" field to ${yamlPath}`,
    );
    return null;
  }

  return obj;
}

async function resolveRolePrompt(
  obj: Record<string, unknown>,
  yamlPath: string,
  roleId: string,
): Promise<string | null> {
  if (typeof obj.prompt_file === "string" && obj.prompt_file.trim() !== "") {
    const promptFilePath = pathResolve(dirname(yamlPath), obj.prompt_file);
    try {
      const content = await readFile(promptFilePath, "utf-8");
      return resolveEnvVars(content);
    } catch {
      log.info(
        `Skipping "${roleId}": prompt_file "${obj.prompt_file}" not found`,
      );
      return null;
    }
  }

  if (typeof obj.prompt === "string" && obj.prompt.trim() !== "") {
    return resolveEnvVars(obj.prompt);
  }

  log.info(
    `Skipping "${roleId}": must provide "prompt" or "prompt_file". Add either "prompt:" or "prompt_file:" to ${yamlPath}`,
  );
  return null;
}

function buildRoleConfig(
  resolved: Record<string, unknown>,
  prompt: string,
  dispatchConfig: DispatchRoleConfig | undefined,
): RoleConfig {
  return {
    name: resolved.name as string,
    description: (resolved.description as string) ?? "",
    prompt,
    ...(typeof resolved.prompt_file === "string"
      ? { prompt_file: resolved.prompt_file }
      : {}),
    ...(typeof resolved.model === "string"
      ? { model: resolveModel(resolved.model) }
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
    ...(resolved.references != null && typeof resolved.references === "object"
      ? { references: resolved.references as RoleConfig["references"] }
      : {}),
    ...(resolved.collaboration != null && typeof resolved.collaboration === "object"
      ? { collaboration: resolved.collaboration as RoleConfig["collaboration"] }
      : {}),
    ...(dispatchConfig ? { dispatch: dispatchConfig } : {}),
    ...(Array.isArray(resolved.auto_activate)
      ? { auto_activate: resolved.auto_activate as string[] }
      : {}),
    ...(typeof resolved.locked === "boolean"
      ? { locked: resolved.locked }
      : {}),
    ...(typeof resolved.open === "boolean"
      ? { open: resolved.open }
      : {}),
    ...(Array.isArray(resolved.exports)
      ? { exports: resolved.exports as string[] }
      : {}),
    ...(Array.isArray(resolved.open_roles)
      ? { open_roles: resolved.open_roles as string[] }
      : {}),
    ...(typeof resolved.version === "string"
      ? { version: resolved.version }
      : {}),
    ...(resolved.hooks != null && typeof resolved.hooks === "object"
      ? { hooks: resolved.hooks as RoleConfig["hooks"] }
      : {}),
  };
}

async function loadOneRole(
  yamlPath: string,
  roleId: string,
): Promise<RoleConfig | null> {
  const obj = await parseAndValidateYaml(yamlPath, roleId);
  if (obj === null) return null;

  const prompt = await resolveRolePrompt(obj, yamlPath, roleId);
  if (prompt === null) return null;

  const resolved = resolveEnvVarsDeep(obj) as Record<string, unknown>;

  const dispatchConfig = parseDispatchConfig(
    resolved.dispatch as Record<string, unknown> | null | undefined,
    roleId,
  );

  const validSubagents = await parseInlineSubagents(
    resolved.subagents,
    yamlPath,
    roleId,
  );

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

  const config = buildRoleConfig(resolved, prompt, dispatchConfig);

  const mergedSubagents = mergedMap.size > 0 ? Array.from(mergedMap.values()) : undefined;
  if (mergedSubagents) {
    config.subagents = mergedSubagents.map((sa) => applyInheritance(config, sa));
  }

  return config;
}

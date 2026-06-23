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
import { resolveEnvVarsDeep, resolveEnvVars } from "./env-resolver.js";
import type { RoleConfig } from "./types.js";

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
      ["primary", "subagent", "all"].includes(resolved.mode)
      ? { mode: resolved.mode as "primary" | "subagent" | "all" }
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
  };

  return config;
}

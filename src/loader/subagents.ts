/**
 * Subagent parsing logic extracted from role-loader.ts.
 *
 * Contains: resolveSubagentEntry, buildSubAgentFields, parseNestedSubagents,
 * parseInlineSubagents, discoverFileBasedSubagents.
 *
 * @internal — only imported by role-loader.ts
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as pathResolve } from "node:path";
import fglob from "fast-glob";
import yaml from "js-yaml";
import { resolveEnvVars } from "../resolver/env-resolver.ts";
import type { SubAgentConfig } from "../types.ts";
import { ROLE_YAML } from "../constants.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type { Logger, ILogObj } from "tslog";
import { validateRoleId } from "./role-loader.ts";

let log: Logger<ILogObj> = createSubLogger("role-loader");

/** @internal Test seam — swap the module-level logger for a mock. */
export function setSubagentLogger(mockLogger: Logger<ILogObj>): void {
  log = mockLogger;
}

// ── Shared subagent validation ─────────────────────────────────────────

/**
 * Validate a raw subagent entry's name and resolve its prompt.
 *
 * Returns the resolved prompt string on success, or `null` if the entry
 * should be skipped (validation failure already logged).
 *
 * This is the single source of truth for subagent name + prompt validation,
 * used by inline parsing, nested parsing, and file-based discovery.
 */
async function resolveSubagentEntry(
  entry: Record<string, unknown>,
  contextDir: string,
  context: string,
): Promise<string | null> {
  if (
    !entry.name ||
    typeof entry.name !== "string" ||
    entry.name.trim() === ""
  ) {
    log.info(`Skipping ${context}: missing or invalid "name"`);
    return null;
  }

  if (!validateRoleId(entry.name as string)) {
    log.info(
      `Skipping ${context} "${entry.name}": name must not contain "--"`,
    );
    return null;
  }

  if (
    typeof entry.prompt_file === "string" &&
    entry.prompt_file.trim() !== ""
  ) {
    const promptFilePath = pathResolve(contextDir, entry.prompt_file);
    try {
      const content = await readFile(promptFilePath, "utf-8");
      return resolveEnvVars(content);
    } catch {
      log.info(
        `Skipping ${context} "${entry.name}": prompt_file "${entry.prompt_file}" not found`,
      );
      return null;
    }
  }

  if (
    typeof entry.prompt === "string" &&
    entry.prompt.trim() !== ""
  ) {
    return resolveEnvVars(entry.prompt as string);
  }

  log.info(
    `Skipping ${context} "${entry.name}": must provide "prompt" or "prompt_file"`,
  );
  return null;
}

// ── Field builders ─────────────────────────────────────────────────────

function buildSubAgentFields(
  entry: Record<string, unknown>,
  resolvedPrompt: string,
): Omit<SubAgentConfig, "subagents"> {
  return {
    name: entry.name as string,
    description: (entry.description as string) ?? "",
    prompt: resolvedPrompt,
    ...(typeof entry.prompt_file === "string"
      ? { prompt_file: entry.prompt_file }
      : {}),
    ...(typeof entry.model === "string" ? { model: entry.model } : {}),
    ...(typeof entry.color === "string" ? { color: entry.color } : {}),
    ...(typeof entry.variant === "string"
      ? { variant: entry.variant }
      : {}),
    ...(typeof entry.temperature === "number"
      ? { temperature: entry.temperature }
      : {}),
    ...(typeof entry.top_p === "number" ? { top_p: entry.top_p } : {}),
    ...(entry.permission != null &&
    typeof entry.permission === "object"
      ? { permission: entry.permission as SubAgentConfig["permission"] }
      : {}),
    ...(entry.tools != null && typeof entry.tools === "object"
      ? { tools: entry.tools as Record<string, boolean> }
      : {}),
    ...(Array.isArray(entry.skills)
      ? { skills: entry.skills as string[] }
      : {}),
    ...(Array.isArray(entry.opencode_skills)
      ? { opencode_skills: entry.opencode_skills as string[] }
      : {}),
    ...(Array.isArray(entry.functions)
      ? { functions: entry.functions as string[] }
      : {}),
    ...(Array.isArray(entry.disable_functions)
      ? { disable_functions: entry.disable_functions as string[] }
      : {}),
    ...(Array.isArray(entry.auto_activate)
      ? { auto_activate: entry.auto_activate as string[] }
      : {}),
    ...(typeof entry.locked === "boolean"
      ? { locked: entry.locked }
      : {}),
  };
}

// ── Nested subagent parsing ────────────────────────────────────────────

async function parseNestedSubagents(
  rawArray: unknown[],
  parentDir: string,
): Promise<SubAgentConfig[]> {
  const subagents: SubAgentConfig[] = [];

  for (const raw of rawArray) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    const subPrompt = await resolveSubagentEntry(
      entry,
      parentDir,
      "nested subagent",
    );
    if (subPrompt === null) continue;

    const config: SubAgentConfig = {
      ...buildSubAgentFields(entry, subPrompt),
    };

    if (Array.isArray(entry.subagents)) {
      const nestedDir =
        typeof entry.prompt_file === "string"
          ? dirname(pathResolve(parentDir, entry.prompt_file as string))
          : parentDir;
      log.info(
        `Preserving nested "subagents" from subagent "${entry.name}"`,
      );
      config.subagents = await parseNestedSubagents(
        entry.subagents as unknown[],
        nestedDir,
      );
    }

    subagents.push(config);
  }

  return subagents;
}

// ── Inline subagent parsing ────────────────────────────────────────────

async function parseInlineSubagents(
  rawSubagents: unknown,
  yamlPath: string,
  roleId: string,
): Promise<SubAgentConfig[]> {
  if (!Array.isArray(rawSubagents)) return [];

  let validSubagents: SubAgentConfig[] = [];
  const seenSubagentNames = new Set<string>();

  for (const raw of rawSubagents) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    const subPrompt = await resolveSubagentEntry(
      entry,
      dirname(yamlPath),
      `subagent in "${roleId}"`,
    );
    if (subPrompt === null) continue;

    const subagent: SubAgentConfig = {
      ...buildSubAgentFields(entry, subPrompt),
    };

    if (Array.isArray(entry.subagents)) {
      log.info(
        `Preserving nested "subagents" from subagent "${entry.name}" in "${roleId}"`,
      );
      subagent.subagents = await parseNestedSubagents(
        entry.subagents as unknown[],
        dirname(yamlPath),
      );
    }

    if (seenSubagentNames.has(subagent.name)) {
      log.info(
        `Duplicate subagent name "${subagent.name}" in "${roleId}": later definition wins`,
      );
      validSubagents = validSubagents.filter((s) => s.name !== subagent.name);
    }
    seenSubagentNames.add(subagent.name);
    validSubagents.push(subagent);
  }

  return validSubagents;
}

// ── File-based subagent discovery ──────────────────────────────────────

async function discoverFileBasedSubagents(
  roleDir: string,
  roleId: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
): Promise<SubAgentConfig[]> {
  if (currentDepth >= maxDepth) return [];

  let matches: string[];
  try {
    matches = await fglob(`subagents/*/${ROLE_YAML}`, {
      cwd: roleDir,
      absolute: true,
      deep: 2,
    });
  } catch {
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
      log.info(
        `Skipping file-based subagent "${childId}" in "${roleId}": invalid YAML`,
        formatError(err),
      );
      continue;
    }

    if (raw === null || raw === undefined || typeof raw !== "object") {
      log.info(
        `Skipping file-based subagent "${childId}" in "${roleId}": YAML does not contain an object`,
      );
      continue;
    }

    const entry = raw as Record<string, unknown>;
    const subagentDir = dirname(yamlPath);

    const subPrompt = await resolveSubagentEntry(
      entry,
      subagentDir,
      `file-based subagent "${childId}" in "${roleId}"`,
    );
    if (subPrompt === null) continue;

    const subagent: SubAgentConfig = {
      ...buildSubAgentFields(entry, subPrompt),
    };

    if (Array.isArray(entry.subagents)) {
      log.info(
        `Preserving nested "subagents" from file-based subagent "${entry.name}" in "${roleId}"`,
      );
      subagent.subagents = await parseNestedSubagents(
        entry.subagents as unknown[],
        subagentDir,
      );
    }

    const fileBasedNested = await discoverFileBasedSubagents(
      subagentDir,
      roleId,
      maxDepth,
      currentDepth + 1,
    );

    if (fileBasedNested.length > 0) {
      const nestedMap = new Map<string, SubAgentConfig>();
      for (const sa of fileBasedNested) {
        nestedMap.set(sa.name, sa);
      }
      if (subagent.subagents) {
        for (const sa of subagent.subagents) {
          nestedMap.set(sa.name, sa);
        }
      }
      subagent.subagents = Array.from(nestedMap.values());
    }

    subagents.push(subagent);
  }

  return subagents;
}

export {
  resolveSubagentEntry,
  buildSubAgentFields,
  parseNestedSubagents,
  parseInlineSubagents,
  discoverFileBasedSubagents,
};

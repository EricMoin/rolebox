/**
 * Computer use is available by default. An explicit false in the host option,
 * global YAML config or project JSON config disables the family for that boot.
 * Invalid settings also disable it; a missing setting does not override another
 * source. Reading policy never creates or modifies a config file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { getConfigPath } from "../cli/config.ts";

export const COMPUTER_USE_CONFIG_KEY = "computerUse";
export const PROJECT_CONFIG_RELATIVE_PATH = join(".rolebox", "config.json");

export interface ComputerUseGateSources {
  /** Explicit false vetoes enablement from any other source. */
  hostOverride?: boolean | undefined;
  globalConfigPath?: string | undefined;
  projectConfigPath?: string | undefined;
  /** Defaults to process.cwd(). */
  workspaceDir?: string | undefined;
}

export interface ComputerUseGate {
  readonly enabled: boolean;
  readonly reason: string;
  /** Undefined means the source did not specify a setting. */
  readonly host: boolean | undefined;
  readonly globalConfig: boolean | undefined;
  readonly projectConfig: boolean | undefined;
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
}

/** Missing is distinct from disabled; any supplied non-boolean is disabled. */
export function computerUseFlagOf(value: unknown): boolean | undefined {
  return value === undefined ? undefined : value === true;
}

function configFlagOf(parsed: unknown): boolean | undefined {
  if (parsed === undefined) return undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (!Object.hasOwn(parsed, COMPUTER_USE_CONFIG_KEY)) return undefined;
  return computerUseFlagOf((parsed as Record<string, unknown>)[COMPUTER_USE_CONFIG_KEY]) ?? false;
}

function readConfigFlag(path: string, parse: (source: string) => unknown): boolean | undefined {
  try {
    return configFlagOf(parse(readFileSync(path, "utf-8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    return false;
  }
}

/** Missing files/settings are absent; unreadable or malformed config is disabled. */
export function readComputerUseFromYamlFile(path: string): boolean | undefined {
  return readConfigFlag(path, parseYaml);
}

export function readComputerUseFromJsonFile(path: string): boolean | undefined {
  return readConfigFlag(path, JSON.parse);
}

export function resolveComputerUseGate(sources: ComputerUseGateSources = {}): ComputerUseGate {
  const host = computerUseFlagOf(sources.hostOverride);
  const globalConfigPath = sources.globalConfigPath ?? getConfigPath();
  const workspaceDir = sources.workspaceDir ?? process.cwd();
  const projectConfigPath = sources.projectConfigPath ?? join(workspaceDir, PROJECT_CONFIG_RELATIVE_PATH);
  const globalConfig = readComputerUseFromYamlFile(globalConfigPath);
  const projectConfig = readComputerUseFromJsonFile(projectConfigPath);
  const settings = [
    { name: "the host plugin option", value: host },
    { name: globalConfigPath, value: globalConfig },
    { name: projectConfigPath, value: projectConfig },
  ];
  const disabledBy = settings.filter(setting => setting.value === false).map(setting => setting.name);
  const enabledBy = settings.filter(setting => setting.value === true).map(setting => setting.name);
  const enabled = disabledBy.length === 0;
  const reason = enabled
    ? enabledBy.length ? `Computer use ENABLED by ${enabledBy.join(", ")}.` : "Computer use ENABLED by default."
    : `Computer use is OFF: ${disabledBy.join(", ")} sets ${COMPUTER_USE_CONFIG_KEY}: false or contains an invalid setting. ` +
      "Every disabling setting must be cleared before the computer_* family can be registered.";
  return { enabled, reason, host, globalConfig, projectConfig, globalConfigPath, projectConfigPath };
}

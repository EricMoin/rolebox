/**
 * Browser use follows the explicit `browseUse` setting when one is configured,
 * and AUTO-DETECTION when none is: `playwright` is an optional dependency, so a
 * machine that never installed it gets no dead `browse_*` tool surface.
 *
 * - any explicit `false`, or an invalid/unreadable setting, disables the family
 *   for that boot (fail closed);
 * - any explicit `true` enables it, even when the driver is absent — the family
 *   is then registered so `browse_status` can report the missing dependency and
 *   its install guidance;
 * - with no explicit setting the gate is on exactly when `playwright` resolves
 *   from rolebox (`createRequire(...).resolve()`, which never loads the module).
 *
 * Reading policy never creates or modifies a config file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { getConfigPath } from "../cli/config.ts";
import { detectPlaywright, PLAYWRIGHT_GUIDANCE } from "../browse/availability.ts";
import { PROJECT_CONFIG_RELATIVE_PATH } from "./computer-use-gate.ts";

export const BROWSE_USE_CONFIG_KEY = "browseUse";

export interface BrowseUseGateSources {
  /** Explicit false vetoes enablement from any other source. */
  hostOverride?: boolean | undefined;
  globalConfigPath?: string | undefined;
  projectConfigPath?: string | undefined;
  /** Defaults to process.cwd(). */
  workspaceDir?: string | undefined;
  /**
   * The driver probe result. Omitted probes `playwright` from rolebox; a test
   * or host that already knows the answer passes it instead.
   */
  driverAvailable?: boolean | undefined;
}

/** Whether the optional driver can be reached, and where it resolved to. */
export interface BrowseUseDriver {
  readonly available: boolean;
  /** Absolute path of the resolved `playwright` entry point, when available. */
  readonly resolvedPath?: string;
}

export interface BrowseUseGate {
  readonly enabled: boolean;
  readonly reason: string;
  /** Undefined means the source did not specify a setting. */
  readonly host: boolean | undefined;
  readonly globalConfig: boolean | undefined;
  readonly projectConfig: boolean | undefined;
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly driver: BrowseUseDriver;
}

/** Missing is distinct from disabled; any supplied non-boolean is disabled. */
export function browseUseFlagOf(value: unknown): boolean | undefined {
  return value === undefined ? undefined : value === true;
}

function configFlagOf(parsed: unknown): boolean | undefined {
  if (parsed === undefined) return undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (!Object.hasOwn(parsed, BROWSE_USE_CONFIG_KEY)) return undefined;
  return browseUseFlagOf((parsed as Record<string, unknown>)[BROWSE_USE_CONFIG_KEY]) ?? false;
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
export function readBrowseUseFromYamlFile(path: string): boolean | undefined {
  return readConfigFlag(path, parseYaml);
}

export function readBrowseUseFromJsonFile(path: string): boolean | undefined {
  return readConfigFlag(path, JSON.parse);
}

/** Resolve the driver once, without loading it — a resolve() never evaluates. */
function resolveDriver(driverAvailable: boolean | undefined): BrowseUseDriver {
  if (driverAvailable === false) return { available: false };
  if (driverAvailable === true) return { available: true };
  const probe = detectPlaywright();
  return probe.resolvedPath === undefined
    ? { available: probe.available }
    : { available: probe.available, resolvedPath: probe.resolvedPath };
}

function driverDetail(driver: BrowseUseDriver): string {
  return driver.available
    ? driver.resolvedPath === undefined ? "the playwright driver resolves from rolebox" : `the playwright driver resolves to ${driver.resolvedPath}`
    : "the playwright driver is not resolvable from rolebox";
}

export function resolveBrowseUseGate(sources: BrowseUseGateSources = {}): BrowseUseGate {
  const host = browseUseFlagOf(sources.hostOverride);
  const globalConfigPath = sources.globalConfigPath ?? getConfigPath();
  const workspaceDir = sources.workspaceDir ?? process.cwd();
  const projectConfigPath = sources.projectConfigPath ?? join(workspaceDir, PROJECT_CONFIG_RELATIVE_PATH);
  const globalConfig = readBrowseUseFromYamlFile(globalConfigPath);
  const projectConfig = readBrowseUseFromJsonFile(projectConfigPath);
  const driver = resolveDriver(sources.driverAvailable);
  const settings = [
    { name: "the host plugin option", value: host },
    { name: globalConfigPath, value: globalConfig },
    { name: projectConfigPath, value: projectConfig },
  ];
  const disabledBy = settings.filter(setting => setting.value === false).map(setting => setting.name);
  const enabledBy = settings.filter(setting => setting.value === true).map(setting => setting.name);

  if (disabledBy.length > 0) {
    return {
      enabled: false,
      reason: `Browse use is OFF: ${disabledBy.join(", ")} sets ${BROWSE_USE_CONFIG_KEY}: false or contains an invalid setting. ` +
        "Every disabling setting must be cleared before the browse_* family can be registered.",
      host, globalConfig, projectConfig, globalConfigPath, projectConfigPath, driver,
    };
  }

  if (enabledBy.length > 0) {
    const reason = driver.available
      ? `Browse use ENABLED by ${enabledBy.join(", ")}; ${driverDetail(driver)}.`
      : `Browse use ENABLED by ${enabledBy.join(", ")} even though ${driverDetail(driver)}; the family is registered so ` +
        `browse_status reports the missing dependency. ${PLAYWRIGHT_GUIDANCE}`;
    return { enabled: true, reason, host, globalConfig, projectConfig, globalConfigPath, projectConfigPath, driver };
  }

  const reason = driver.available
    ? `Browse use ENABLED by auto-detection: no ${BROWSE_USE_CONFIG_KEY} setting is configured and ${driverDetail(driver)}.`
    : `Browse use is OFF: no ${BROWSE_USE_CONFIG_KEY} setting is configured and ${driverDetail(driver)}. ` +
      `Or set ${BROWSE_USE_CONFIG_KEY}: true to register the family anyway, in which case browse_status reports the ` +
      `missing dependency instead of the tools being absent. ${PLAYWRIGHT_GUIDANCE}`;
  return { enabled: driver.available, reason, host, globalConfig, projectConfig, globalConfigPath, projectConfigPath, driver };
}

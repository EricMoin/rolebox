/**
 * The GLOBAL computer-use gate — one resolution point, default OFF.
 *
 * Screen control is a capability the USER grants, not one a tool surface
 * assumes. Before any `computer_*` tool may even be registered, the host asks
 * this module whether computer use was enabled, and the answer is a boolean
 * plus the reason it is that boolean, so a boot log can state WHY the family is
 * absent instead of leaving an operator to guess.
 *
 * ── Sources (checked in this order, all of them, no short-circuit) ─────────
 *
 *  1. the HOST PLUGIN OPTION — `computerUse` on a host that already carries
 *     plugin options (the dsh plugin Config, the codex MCP entry options);
 *  2. the GLOBAL ROLEBOX CONFIG — `computerUse: true` in
 *     `~/.config/rolebox/config.yaml` (the file `src/cli/config.ts` owns; read
 *     directly here because `loadConfig()` is a CLIENT config parser that drops
 *     keys it does not model and CREATES the file when it is absent — neither
 *     behavior belongs on a read-only policy path);
 *  3. the PROJECT CONFIG — `computerUse: true` in
 *     `{workspace}/.rolebox/config.json` (the file `src/project-config.ts`
 *     reads; its `loadProjectConfig()` models only `defaultRole`, so the raw
 *     JSON is read here for the same reason).
 *
 * ENABLED means ANY source explicitly sets the key to the boolean `true`.
 * Absent everywhere — the default — means disabled. A non-boolean value (the
 * string `"true"`, `1`, `{}`) is NOT enablement: a config typo fails CLOSED.
 *
 * The host option is an assertion of enablement only. Every host option in
 * rolebox is schema-defaulted (`computerUse: z.boolean().default(false)` on
 * dsh), so `false` is indistinguishable from "unset" — it must not be able to
 * override a user's explicit config-file opt-in, and it can never broaden
 * anything by itself. Enabled-by-none is the only disabled answer.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { getConfigPath } from "../cli/config.ts";

/** The config key every surface spells the same way. */
export const COMPUTER_USE_CONFIG_KEY = "computerUse";

/** Project config path relative to the workspace root. */
export const PROJECT_CONFIG_RELATIVE_PATH = join(".rolebox", "config.json");

/**
 * Where the gate reads its inputs from.
 *
 * Every field is optional: the defaults are the real surfaces (the host has no
 * option, `~/.config/rolebox/config.yaml`, `{cwd}/.rolebox/config.json`). Tests
 * inject temp paths and a temp workspace so a developer's own config can never
 * decide a test outcome.
 */
export interface ComputerUseGateSources {
  /**
   * The host's own plugin option, when the host has one. `true` enables;
   * `false`/absent asserts nothing (see the module docstring on why `false`
   * cannot mean "force off").
   */
  hostOverride?: boolean | undefined;
  /** Global rolebox config file; defaults to `getConfigPath()`. */
  globalConfigPath?: string | undefined;
  /** Project config file; defaults to `{workspaceDir}/.rolebox/config.json`. */
  projectConfigPath?: string | undefined;
  /** Workspace root for the default project-config path; defaults to `process.cwd()`. */
  workspaceDir?: string | undefined;
}

/** The resolved gate: the decision, which sources made it, and why. */
export interface ComputerUseGate {
  /** Whether the family is enabled at all. `false` unless a source says `true`. */
  readonly enabled: boolean;
  /** One line stating the decision and the sources it came from. */
  readonly reason: string;
  /** The host plugin option asserted enablement. */
  readonly host: boolean;
  /** `computerUse: true` was read from the global config file. */
  readonly globalConfig: boolean;
  /** `computerUse: true` was read from the project config file. */
  readonly projectConfig: boolean;
  /** Paths actually consulted (for the boot log and for tests). */
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
}

/**
 * Strict enablement test: ONLY the boolean `true` enables. Anything else —
 * including `"true"` — leaves the family off.
 */
export function computerUseFlagOf(value: unknown): boolean {
  return value === true;
}

/**
 * Read `computerUse` from a YAML config file. Missing file, unreadable file,
 * malformed YAML, a non-object root — every failure is "absent" (false), never
 * a throw: a policy read must not take a boot down.
 */
export function readComputerUseFromYamlFile(path: string): boolean {
  try {
    const parsed: unknown = parseYaml(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return computerUseFlagOf((parsed as Record<string, unknown>)[COMPUTER_USE_CONFIG_KEY]);
  } catch {
    return false;
  }
}

/**
 * Read `computerUse` from a JSON config file, with the same absent-on-any-
 * failure discipline as {@link readComputerUseFromYamlFile}.
 */
export function readComputerUseFromJsonFile(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return computerUseFlagOf((parsed as Record<string, unknown>)[COMPUTER_USE_CONFIG_KEY]);
  } catch {
    return false;
  }
}

/**
 * Resolve the global computer-use gate.
 *
 * @param sources - Optional overrides; defaults are the real host surfaces.
 * @returns The decision with the reason and the paths consulted.
 */
export function resolveComputerUseGate(
  sources: ComputerUseGateSources = {},
): ComputerUseGate {
  const host = sources.hostOverride === true;
  const globalConfigPath = sources.globalConfigPath ?? getConfigPath();
  const workspaceDir = sources.workspaceDir ?? process.cwd();
  const projectConfigPath =
    sources.projectConfigPath ?? join(workspaceDir, PROJECT_CONFIG_RELATIVE_PATH);
  const globalConfig = readComputerUseFromYamlFile(globalConfigPath);
  const projectConfig = readComputerUseFromJsonFile(projectConfigPath);
  const enabled = host || globalConfig || projectConfig;

  if (!enabled) {
    return {
      enabled: false,
      reason:
        `Computer use is OFF: no source sets ${COMPUTER_USE_CONFIG_KEY}: true ` +
        `(host plugin option not asserted; ${globalConfigPath}; ${projectConfigPath}). ` +
        `Set it in one of those files — or pass the host option — to enable the computer_* family.`,
      host,
      globalConfig,
      projectConfig,
      globalConfigPath,
      projectConfigPath,
    };
  }

  const by: string[] = [];
  if (host) by.push("the host plugin option");
  if (globalConfig) by.push(globalConfigPath);
  if (projectConfig) by.push(projectConfigPath);
  return {
    enabled: true,
    reason: `Computer use ENABLED by ${by.join(", ")}.`,
    host,
    globalConfig,
    projectConfig,
    globalConfigPath,
    projectConfigPath,
  };
}

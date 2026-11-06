/**
 * Copilot draft config sources.
 *
 * Runtime `copilot.draft` settings are composed from three precedence sources:
 *
 *   1. the acting role's `copilot` block (`role.yaml`),
 *   2. the project file `<workspace>/.rolebox/config.json` (its `copilot` key),
 *   3. the global file `<rolebox-config-home>/config.yaml` (its `copilot` key,
 *      the path from {@link getConfigPath}).
 *
 * This module reads the two FILE sources once at boot. There is no watching:
 * edit a file and restart the host (or reload the plugin) to apply it.
 *
 * Missing files are simply absent. An unreadable or malformed file warns and is
 * treated as absent as well, so a broken project/global file can never fail the
 * boot; reading never creates or modifies a file. Only the top-level `copilot`
 * key is read — every other key in the file belongs to another subsystem.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { getConfigPath } from "../cli/config.ts";
import { createSubLogger } from "../logger.ts";
import type { Logger } from "../logger.ts";
import type { ILogObj } from "../logger.ts";
import { isObject } from "../notifications/config-parsers.ts";
import { parseCopilotDraftFragment } from "./config.ts";
import type { CopilotDraftFragment } from "./types.ts";

const log: Logger<ILogObj> = createSubLogger("copilot-config");

/** Workspace-relative path of the project config file. */
export const PROJECT_CONFIG_RELATIVE_PATH = join(".rolebox", "config.json");

// ── Paths ───────────────────────────────────────────────────────────

/**
 * Absolute project config path for one workspace
 * (`<workspace>/.rolebox/config.json`).
 *
 * @param workspace - Absolute path to the workspace root.
 * @returns The project config file path.
 */
export function projectCopilotConfigPath(workspace: string): string {
  return join(workspace, PROJECT_CONFIG_RELATIVE_PATH);
}

/**
 * Absolute global rolebox config path
 * (`<rolebox-config-home>/config.yaml`, resolved by the CLI paths module).
 *
 * @returns The global config file path.
 */
export function globalCopilotConfigPath(): string {
  return getConfigPath();
}

// ── File readers ────────────────────────────────────────────────────

/**
 * Read the `copilot` block from a JSON config file.
 *
 * Missing file → `undefined`. Unreadable, malformed JSON or a non-object
 * document/`copilot` value → one warning and `undefined`. Never throws and
 * never creates the file.
 *
 * @param path - Absolute path to the JSON config file.
 * @returns The parsed fragment, or `undefined` when there is nothing usable.
 */
export function readCopilotFragmentFromJsonFile(
  path: string,
): CopilotDraftFragment | undefined {
  return readCopilotFragment(path, JSON.parse);
}

/**
 * Read the `copilot` block from a YAML config file.
 *
 * Missing file → `undefined`. Unreadable, malformed YAML or a non-object
 * document/`copilot` value → one warning and `undefined`. Never throws and
 * never creates the file.
 *
 * @param path - Absolute path to the YAML config file.
 * @returns The parsed fragment, or `undefined` when there is nothing usable.
 */
export function readCopilotFragmentFromYamlFile(
  path: string,
): CopilotDraftFragment | undefined {
  return readCopilotFragment(path, parseYaml);
}

/** One missing-file check that never masks a real read failure. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Read + parse one file source. The `parse` seam keeps the JSON and YAML
 * readers identical apart from their decoder.
 */
function readCopilotFragment(
  path: string,
  parse: (source: string) => unknown,
): CopilotDraftFragment | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch (error) {
    // A missing file is the normal unconfigured case; don't warn for it.
    if (!isNotFound(error)) {
      log.warn(`Failed to read copilot config from ${path}`, {
        error: String(error),
      });
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    log.warn(`Failed to parse copilot config from ${path}`, {
      error: String(error),
    });
    return undefined;
  }

  if (!isObject(parsed)) {
    log.warn(`Copilot config in ${path} is not an object; ignoring`);
    return undefined;
  }
  if (!Object.hasOwn(parsed, "copilot")) return undefined;
  if (!isObject(parsed.copilot)) {
    log.warn(
      `Invalid "copilot" value in ${path}; expected object, got ${typeof parsed.copilot}`,
    );
    return undefined;
  }

  return parseCopilotDraftFragment(parsed.copilot);
}

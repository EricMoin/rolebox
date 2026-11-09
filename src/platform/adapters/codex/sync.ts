/**
 * Codex post-sync installation step.
 *
 * `rolebox sync codex` is not only a role-symlink sync: Codex is extended
 * through a local plugin marketplace, so the host-owned install step writes the
 * plugin bundle (manifest, MCP config, marketplace manifest, skills link),
 * registers it in the Codex `config.toml`, and syncs the native agent files.
 *
 * That step lives HERE, with the Codex adapter, and is invoked through the
 * platform descriptor's `postSync` hook (see src/platform/registry.ts) so the
 * neutral CLI never imports a Codex module or names Codex itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerCodexPlugin,
  resolveRoleboxPackageRoot,
  writeCodexPluginBundle,
} from "./plugin-bundle.ts";
import { syncCodexAgents } from "./agents.ts";
import { codexPlatformPaths } from "../../paths.ts";
import { initializeRoleboxRuntime, resolveRoleboxDirectories } from "../../factory.ts";

/**
 * Read the package version from the package.json at the resolved package
 * root, so the Codex plugin manifest is stamped with the real released
 * version instead of a hardcoded one.
 */
function readPackageVersion(packageRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
    version: string;
  };
  return pkg.version;
}

/**
 * The warning shown when the bundle points Codex at an MCP server entry that
 * does not exist yet. A source checkout that was never built still syncs —
 * Codex just cannot start the server until rolebox is built or reinstalled.
 */
export function codexServerEntryWarning(bundle: {
  serverEntry: string;
  serverEntryExists: boolean;
}): string | undefined {
  if (bundle.serverEntryExists) return undefined;
  return (
    `Warning: the Codex MCP server entry ${bundle.serverEntry} does not exist. ` +
    "Build or reinstall rolebox before starting Codex (for a source checkout, `npm run build`)."
  );
}

/** Options for {@link syncCodexTarget}. */
export interface SyncCodexTargetOptions {
  /** Sync target directory (`{codexHome}/rolebox`) the roles were deployed into. */
  syncTarget: string;
  /**
   * Emit one user-facing line. The CLI owns console output (the logging guard
   * reserves it for `src/cli`), so this adapter reports instead of printing.
   */
  report: (line: string, level?: "info" | "warn") => void;
}

/**
 * Install/refresh rolebox's Codex integration: write the plugin bundle,
 * register it in `config.toml`, then sync the native agent files. Idempotent
 * and safe to re-run.
 */
export async function syncCodexTarget(options: SyncCodexTargetOptions): Promise<void> {
  const packageRoot = resolveRoleboxPackageRoot(import.meta.url);
  const bundle = writeCodexPluginBundle({
    codexHome: codexPlatformPaths().configDir,
    packageRoot,
    version: readPackageVersion(packageRoot),
  });
  const entryWarning = codexServerEntryWarning(bundle);
  if (entryWarning !== undefined) options.report(entryWarning, "warn");
  try {
    registerCodexPlugin(bundle.configPath, bundle.marketplaceDir);
  } catch (error) {
    // The bundle is already on disk; name what did and did not happen before
    // failing, and say that a retry is safe (both steps are idempotent).
    options.report(
      `Codex plugin: wrote the marketplace directory ${bundle.marketplaceDir}, ` +
        `but registering it in ${bundle.configPath} failed: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "Fix the cause and re-run `rolebox sync codex` — the sync is safe to repeat.",
      "warn",
    );
    throw error;
  }
  options.report(`Codex plugin: registered ${bundle.marketplaceDir} in ${bundle.configPath}`);
  options.report("Codex plugin: install or refresh with `codex plugin add rolebox@rolebox`, then restart Codex");
  const directories = resolveRoleboxDirectories({ platformId: "codex" });
  const { resolvedRoles } = await initializeRoleboxRuntime({
    directories: { ...directories, roleboxDir: options.syncTarget },
    roleFunctionsMap: new Map(),
  });
  const agents = syncCodexAgents(resolvedRoles, { codexHome: directories.configDir });
  for (const warning of agents.warnings) options.report(`Warning: ${warning}`, "warn");
  options.report(`Codex agents: ${agents.agents.filter(agent => agent.parentId === undefined).length} public roles, ${agents.agents.filter(agent => agent.parentId !== undefined).length} private children; restart Codex to refresh native agents`);
}

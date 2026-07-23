import type { Plugin } from "@opencode-ai/plugin";
import { OpencodeAgentRegistrar } from "./platform/adapters/opencode/agent-registrar.ts";
import { syncSkillSymlinks } from "./sync/skill-symlinks.ts";
import { createPluginHooks } from "./core/composition.ts";
import { OpencodeSessionAdapter } from "./platform/adapters/opencode/session.ts";
export { loopManagerMap, activeLoopManager } from "./core/composition.js";
import { roleFunctionsMap, roleGraphMap } from "./resolver/registry.ts";
export { roleFunctionsMap, roleGraphMap } from "./resolver/registry.ts";
import { loadProjectConfig, applyProjectConfig } from "./project-config.ts";
import { PLUGIN_ID } from "./constants.ts";
import { createSubLogger, getLogFilePath, configureLogDirectory } from "./logger.ts";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "./platform/factory.ts";

const RoleboxPlugin: Plugin = async (ctx) => {
  configureLogDirectory(ctx.directory);

  const dirs = resolveRoleboxDirectories({
    workingDir: ctx.directory,
    platformId: "opencode",
  });

  const log = createSubLogger("init");

  const { resolvedRoles, discovered, resolved, skipped } =
    await initializeRoleboxRuntime({
      directories: dirs,
      roleFunctionsMap,
      roleGraphMap,
      registrar: new OpencodeAgentRegistrar(),
    });

  // Apply project-level config (`.rolebox/config.json`) if present
  const projectConfig = loadProjectConfig(ctx.directory);
  if (projectConfig?.defaultRole) {
    applyProjectConfig(resolvedRoles, projectConfig);
  }

  syncSkillSymlinks(resolvedRoles, dirs.globalSkillsDir);

  log.info("Plugin initialized", { discovered, resolved, skipped, logFile: getLogFilePath() });
  if (discovered === 0) {
    log.info("No roles found in rolebox directory");
  }

  return createPluginHooks({
    resolvedRoles,
    session: new OpencodeSessionAdapter(ctx.client),
    roleFunctionsMap,
    roleGraphMap,
    directory: ctx.directory,
    roleboxDir: dirs.roleboxDir,
    globalSkillsDir: dirs.globalSkillsDir,
    configDir: dirs.configDir,
    builtinDir: dirs.builtinDir,
  });
};

export default {
  id: PLUGIN_ID,
  server: RoleboxPlugin,
};

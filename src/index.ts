import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { syncAllAgents } from "./sync/agent-files.ts";
import { OpencodeAgentRegistrar } from "./platform/adapters/opencode/agent-registrar.ts";
import { syncSkillSymlinks } from "./sync/skill-symlinks.ts";
import { createPluginHooks } from "./core/composition.ts";
export { loopManagerMap, activeLoopManager } from "./core/composition.js";
import { roleFunctionsMap, roleGraphMap } from "./resolver/registry.ts";
export { roleFunctionsMap, roleGraphMap } from "./resolver/registry.ts";
import { bootstrapRoles } from "./resolver/bootstrap.ts";
import { PLUGIN_ID } from "./constants.ts";
import { createSubLogger, getLogFilePath, configureLogDirectory } from "./logger.ts";
import { getOpencodeConfigDir } from "./cli/paths.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RoleboxPlugin: Plugin = async (ctx) => {
  configureLogDirectory(ctx.directory);
  const configDir = getOpencodeConfigDir();
  const ctxRoleboxDir = path.join(ctx.directory, "rolebox");
  const roleboxDir = existsSync(ctxRoleboxDir)
    ? ctxRoleboxDir
    : path.join(configDir, "rolebox");
  const globalSkillsDir = path.join(configDir, "skills");
  const builtinDir = path.join(__dirname, "..", "functions");
  const log = createSubLogger("init");

  const { resolvedRoles, discovered, resolved, skipped } = await bootstrapRoles({
    roleboxDir,
    globalSkillsDir,
    configDir,
    builtinDir,
    roleFunctionsMap,
    roleGraphMap,
  });

  await syncAllAgents(resolvedRoles, new OpencodeAgentRegistrar());
  syncSkillSymlinks(resolvedRoles, globalSkillsDir);

  log.info("Plugin initialized", { discovered, resolved, skipped, logFile: getLogFilePath() });
  if (discovered === 0) {
    log.info("No roles found in rolebox directory");
  }

  return createPluginHooks({
    resolvedRoles,
    client: ctx.client,
    roleFunctionsMap,
    roleGraphMap,
    directory: ctx.directory,
    roleboxDir,
    globalSkillsDir,
    configDir,
    builtinDir,
  });
};

export default {
  id: PLUGIN_ID,
  server: RoleboxPlugin,
};

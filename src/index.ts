import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { discoverRoles } from "./role-loader.ts";
import { resolveAllRoles } from "./resolver/orchestrator.ts";
import { syncAgentFiles } from "./sync/agent-files.ts";
import { syncSkillSymlinks } from "./sync/skill-symlinks.ts";
import { createPluginHooks } from "./plugin-hooks.ts";
import type { ResolvedFunction, ResolvedGraph } from "./types.ts";
import { PLUGIN_ID } from "./constants.ts";
import { createSubLogger, getLogFilePath } from "./logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

export const roleGraphMap = new Map<string, ResolvedGraph>();

function getOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "opencode");
  }
  return path.join(os.homedir(), ".config", "opencode");
}

const RoleboxPlugin: Plugin = async (ctx) => {
  const configDir = getOpencodeConfigDir();
  const ctxRoleboxDir = path.join(ctx.directory, "rolebox");
  const roleboxDir = existsSync(ctxRoleboxDir)
    ? ctxRoleboxDir
    : path.join(configDir, "rolebox");
  const globalSkillsDir = path.join(configDir, "skills");
  const log = createSubLogger("init");

  const roles = await discoverRoles(roleboxDir);

  const resolvedRoles = await resolveAllRoles(roles, {
    roleboxDir,
    globalSkillsDir,
    configDir,
    builtinDir: path.join(__dirname, "..", "functions"),
    roleFunctionsMap,
    roleGraphMap,
  });

  syncAgentFiles(resolvedRoles);
  syncSkillSymlinks(resolvedRoles, globalSkillsDir);

  const discovered = roles.size;
  const resolved = resolvedRoles.length;
  const skipped = discovered - resolved;
  log.info("Plugin initialized", { discovered, resolved, skipped, logFile: getLogFilePath() });
  if (resolved === 0 && discovered > 0) {
    log.warn("All discovered roles failed to resolve — check role.yaml files");
  }
  if (discovered === 0) {
    log.info("No roles found in rolebox directory");
  }

  return createPluginHooks(resolvedRoles, ctx.client, roleFunctionsMap, roleGraphMap);
};

export default {
  id: PLUGIN_ID,
  server: RoleboxPlugin,
};

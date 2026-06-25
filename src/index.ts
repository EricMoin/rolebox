import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { discoverRoles } from "./role-loader.js";
import { resolveAllRoles } from "./resolver/orchestrator.js";
import { syncAgentFiles } from "./sync/agent-files.js";
import { syncSkillSymlinks } from "./sync/skill-symlinks.js";
import { createPluginHooks } from "./plugin-hooks.js";
import type { ResolvedFunction, ResolvedGraph } from "./types.js";

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

  return createPluginHooks(resolvedRoles, ctx.client, roleFunctionsMap, roleGraphMap);
};

export default {
  id: "rolebox",
  server: RoleboxPlugin,
};

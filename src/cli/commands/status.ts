import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadLock, loadConfig, getConfigPath, getLockPath } from "../config.js";
import { getSyncTarget, getRolePath } from "../paths.js";
import { fetchRegistryManifest } from "../registry-client.js";
import { compareVersions } from "./update.js";
import { SyncTarget, PLUGIN_ID } from "../../constants.js";
import {
  bold,
  dim,
  green,
  yellow,
  red,
  cyan,
  SYM_OK,
  SYM_FAIL,
  SYM_WARN,
  SYM_ARROW,
  printHeader,
  printField,
  checkSymlink,
  listSymlinks,
} from "../format.js";

interface StatusJson {
  version: string;
  config: { path: string; exists: boolean };
  registries: Array<{ name: string; url: string; default?: boolean }>;
  roles: Array<{
    role: string;
    registry: string;
    version: string;
    installedAt: string;
    synced: boolean;
    symlinkValid: boolean;
    latestVersion?: string;
  }>;
  opencode: {
    syncTarget: string;
    pluginRegistered: boolean;
    skillSymlinks: Array<{ name: string; valid: boolean }>;
  };
}

export async function status(args: string[]): Promise<void> {
  const checkUpdates = args.includes("-u") || args.includes("--check-updates");
  const jsonOutput = args.includes("--json");

  const pkg = JSON.parse(
    readFileSync(findPackageJson(), "utf-8"),
  ) as { version: string };

  const config = loadConfig();
  const lock = loadLock();
  const configPath = getConfigPath();
  const syncTarget = getSyncTarget(SyncTarget.Opencode);
  const opencodeConfigPath = getOpencodeConfigPath();

  const pluginRegistered = checkPluginRegistered(opencodeConfigPath);

  const roleStatuses = lock.roles.map((entry) => {
    const linkPath = join(syncTarget, entry.role);
    const sym = checkSymlink(linkPath, entry.role);
    return {
      ...entry,
      synced: sym.exists && sym.isSymlink,
      symlinkValid: sym.exists && sym.isSymlink && sym.targetExists,
    };
  });

  const skillSymlinks = listSymlinks(getOpencodeSkillsDir(), "rolebox--");

  let latestVersions: Record<string, string> = {};
  if (checkUpdates) {
    latestVersions = await fetchLatestVersions(config, lock.roles.map((r) => ({ role: r.role, registry: r.registry })));
  }

  if (jsonOutput) {
    const output: StatusJson = {
      version: pkg.version,
      config: { path: configPath, exists: existsSync(configPath) },
      registries: config.registries,
      roles: roleStatuses.map((r) => ({
        role: r.role,
        registry: r.registry,
        version: r.version,
        installedAt: r.installedAt,
        synced: r.synced,
        symlinkValid: r.symlinkValid,
        ...(latestVersions[r.role] ? { latestVersion: latestVersions[r.role] } : {}),
      })),
      opencode: {
        syncTarget,
        pluginRegistered,
        skillSymlinks: skillSymlinks.map((s) => ({
          name: s.name,
          valid: s.isSymlink && s.targetExists,
        })),
      },
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Header
  console.log("");
  console.log(`${bold("Rolebox")} ${dim("v" + pkg.version)}`);

  // Configuration
  printHeader("Configuration");
  printField("Config", shortenPath(configPath));
  printField("Registries", config.registries.map((r) => r.name + (r.default ? dim(" (default)") : "")).join(", "));

  // Installed Roles
  printHeader("Installed Roles");

  if (lock.roles.length === 0) {
    console.log(`  ${dim("No roles installed. Run")} ${cyan("rolebox install <role>")} ${dim("to get started.")}`);
  } else {
    for (const role of roleStatuses) {
      const statusIcon = role.symlinkValid ? SYM_OK : role.synced ? SYM_WARN : SYM_FAIL;
      const syncLabel = role.symlinkValid
        ? green("synced")
        : role.synced
          ? yellow("broken link")
          : dim("not synced");

      const namePart = role.role.padEnd(24);
      const versionPart = role.version.padEnd(8);
      const registryPart = dim(`(${role.registry})`);

      let line = `  ${statusIcon} ${namePart} ${versionPart} ${registryPart}  ${SYM_ARROW} ${syncLabel}`;

      if (checkUpdates && latestVersions[role.role]) {
        const latest = latestVersions[role.role];
        if (compareVersions(latest, role.version) > 0) {
          line += `  ${yellow("↑ " + latest + " available")}`;
        }
      }

      console.log(line);
    }
  }

  // OpenCode Integration
  printHeader("OpenCode Integration");
  printField("Plugin", pluginRegistered ? `${SYM_OK} registered` : `${SYM_FAIL} ${red("not found in opencode config")}`);
  printField("Sync target", shortenPath(syncTarget));

  const syncedCount = roleStatuses.filter((r) => r.symlinkValid).length;
  const totalCount = roleStatuses.length;
  if (totalCount > 0) {
    const syncSummary = syncedCount === totalCount
      ? green(`${syncedCount}/${totalCount} roles`)
      : yellow(`${syncedCount}/${totalCount} roles`);
    printField("Synced", syncSummary);
  }

  // Skill Symlinks
  if (skillSymlinks.length > 0) {
    console.log("");
    console.log(`  ${dim("Skill symlinks")} ${dim(`(${skillSymlinks.length}):`)}`)
    const broken = skillSymlinks.filter((s) => !s.targetExists || !s.isSymlink);
    const valid = skillSymlinks.filter((s) => s.isSymlink && s.targetExists);

    if (broken.length === 0) {
      console.log(`    ${SYM_OK} ${green("all valid")}`);
    } else {
      console.log(`    ${SYM_OK} ${valid.length} valid`);
      for (const b of broken) {
        console.log(`    ${SYM_FAIL} ${b.name} ${red("(broken)")}`);
      }
    }
  }

  // Hints
  const hints: string[] = [];
  const unsyncedRoles = roleStatuses.filter((r) => !r.synced);
  if (unsyncedRoles.length > 0) {
    hints.push(`Run ${cyan("rolebox sync opencode")} to sync ${unsyncedRoles.length} unsynced role(s).`);
  }
  if (!pluginRegistered) {
    hints.push(`Add ${cyan('"rolebox"')} to the "plugin" array in ${shortenPath(opencodeConfigPath)}.`);
  }

  if (hints.length > 0) {
    console.log("");
    for (const hint of hints) {
      console.log(`  ${SYM_WARN} ${hint}`);
    }
  }

  console.log("");
}

// ── Helpers ──────────────────────────────────────────────────────

function findPackageJson(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Could not find package.json");
}

function getOpencodeConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(homedir(), ".config");
  return join(base, "opencode", "opencode.jsonc");
}

function getOpencodeSkillsDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(homedir(), ".config");
  return join(base, "opencode", "skills");
}

function checkPluginRegistered(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const content = readFileSync(configPath, "utf-8");
    const stripped = stripJsonComments(content);
    const parsed = JSON.parse(stripped) as { plugin?: string[] };
    if (!Array.isArray(parsed.plugin)) return false;
    return parsed.plugin.some((p) => p === PLUGIN_ID || p.startsWith(`${PLUGIN_ID}@`));
  } catch {
    return false;
  }
}

function stripJsonComments(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      result += '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') {
          result += input[i] + (input[i + 1] || "");
          i += 2;
        } else {
          result += input[i];
          i++;
        }
      }
      if (i < input.length) { result += '"'; i++; }
    } else if (input[i] === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++;
    } else if (input[i] === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}

function shortenPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

async function fetchLatestVersions(
  config: { registries: Array<{ name: string; url: string }> },
  roles: Array<{ role: string; registry: string }>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const registryMap = new Map(config.registries.map((r) => [r.name, r]));

  const registriesToFetch = new Set(roles.map((r) => r.registry));

  for (const registryName of registriesToFetch) {
    const reg = registryMap.get(registryName);
    if (!reg) continue;

    try {
      const manifest = await fetchRegistryManifest(reg);
      for (const role of roles) {
        if (role.registry !== registryName) continue;
        const roleManifest = manifest.roles[role.role];
        if (roleManifest) {
          result[role.role] = roleManifest.version;
        }
      }
    } catch {
      // Non-fatal: skip version check for this registry
    }
  }

  return result;
}

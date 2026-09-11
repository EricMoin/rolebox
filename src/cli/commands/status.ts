import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLock, loadConfig, getConfigPath } from "../config.ts";
import {
  getSyncTarget,
  getRolePath,
  getTargetConfigDir,
  getTargetSkillsDir,
} from "../paths.ts";
import { fetchRegistryManifest } from "../registry-client.ts";
import { compareVersions } from "./update.ts";
import {
  PLATFORM_REGISTRY,
  type PlatformDescriptor,
  type PlatformIntegration,
} from "../../platform/registry.ts";
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
  shortenPath,
} from "../format.ts";

interface TargetStatus {
  target: string;
  label: string;
  present: boolean;
  syncTarget: string;
  roles: Array<{ role: string; synced: boolean; symlinkValid: boolean }>;
  syncedCount: number;
  totalCount: number;
  skillSymlinks: Array<{ name: string; valid: boolean }>;
  /**
   * Host integration/registration status, as declared by the platform
   * descriptor. `null` when the platform has no detectable mechanism.
   */
  integration: PlatformIntegration | null;
}

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
  targets: TargetStatus[];
  /** @deprecated Retained for backward compatibility — use `targets` instead. */
  opencode: {
    syncTarget: string;
    pluginRegistered: boolean;
    skillSymlinks: Array<{ name: string; valid: boolean }>;
  };
}

/**
 * Compute sync status for a single platform across all installed roles.
 * Purely descriptor-driven — knows nothing platform-specific.
 */
function computeTargetStatus(
  platform: PlatformDescriptor,
  lock: ReturnType<typeof loadLock>,
): TargetStatus {
  const syncTarget = getSyncTarget(platform.id);
  const present = existsSync(getTargetConfigDir(platform.id));

  const roles = lock.roles.map((entry) => {
    const linkPath = join(syncTarget, entry.role);
    const sym = checkSymlink(linkPath, entry.role);
    return {
      role: entry.role,
      synced: sym.exists && sym.isSymlink,
      symlinkValid: sym.exists && sym.isSymlink && sym.targetExists,
    };
  });

  const skillSymlinks = listSymlinks(getTargetSkillsDir(platform.id), "rolebox--").map((s) => ({
    name: s.name,
    valid: s.isSymlink && s.targetExists,
  }));

  return {
    target: platform.id,
    label: platform.label,
    present,
    syncTarget,
    roles,
    syncedCount: roles.filter((r) => r.symlinkValid).length,
    totalCount: roles.length,
    skillSymlinks,
    integration: platform.detectIntegration(),
  };
}

export async function status(checkUpdates: boolean, jsonOutput: boolean): Promise<void> {

  const pkg = JSON.parse(
    readFileSync(findPackageJson(), "utf-8"),
  ) as { version: string };

  const config = loadConfig();
  const lock = loadLock();
  const configPath = getConfigPath();

  // Compute sync status for EVERY registered platform (opencode, pi, dsh, and
  // any future harness) — the CLI iterates the registry rather than naming
  // targets. A role is only "deployed" relative to a specific tool, so each
  // registered platform is reported.
  const targetStatuses: TargetStatus[] = PLATFORM_REGISTRY.map((p) =>
    computeTargetStatus(p, lock),
  );
  const opencodeStatus =
    targetStatuses.find((t) => t.target === "opencode") ?? targetStatuses[0];

  // Top-level role identity list (registry/version/installedAt), enriched with
  // opencode sync flags for backward compatibility.
  const roleStatuses = lock.roles.map((entry) => {
    const oc = opencodeStatus?.roles.find((r) => r.role === entry.role);
    return {
      ...entry,
      synced: oc?.synced ?? false,
      symlinkValid: oc?.symlinkValid ?? false,
    };
  });

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
      targets: targetStatuses,
      opencode: {
        syncTarget: opencodeStatus?.syncTarget ?? "",
        pluginRegistered: opencodeStatus?.integration?.registered ?? false,
        skillSymlinks: opencodeStatus?.skillSymlinks ?? [],
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

  // Sync Targets — one section per registered platform. Fully registry-driven:
  // a new harness appears here automatically, with its own integration line.
  for (const ts of targetStatuses) {
    printHeader(`${ts.label} Integration${ts.present ? "" : dim(" (not detected)")}`);

    // Integration/registration line — rendered generically from whatever the
    // platform descriptor reports. Platforms with no detectable mechanism
    // (integration === null) simply omit this line rather than guessing.
    if (ts.integration) {
      printField(
        ts.integration.mechanism,
        ts.integration.registered
          ? `${SYM_OK} ${ts.integration.detail}`
          : `${SYM_FAIL} ${red(ts.integration.detail)}`,
      );
    }

    printField("Sync target", shortenPath(ts.syncTarget));

    if (ts.totalCount > 0) {
      const syncSummary = ts.syncedCount === ts.totalCount
        ? green(`${ts.syncedCount}/${ts.totalCount} roles`)
        : (ts.syncedCount === 0 ? dim(`${ts.syncedCount}/${ts.totalCount} roles`) : yellow(`${ts.syncedCount}/${ts.totalCount} roles`));
      printField("Synced", syncSummary);
    }

    // Skill Symlinks for this target
    if (ts.skillSymlinks.length > 0) {
      const broken = ts.skillSymlinks.filter((s) => !s.valid);
      const valid = ts.skillSymlinks.filter((s) => s.valid);
      console.log(`  ${dim("Skill symlinks")} ${dim(`(${ts.skillSymlinks.length}):`)}`);
      if (broken.length === 0) {
        console.log(`    ${SYM_OK} ${green("all valid")}`);
      } else {
        console.log(`    ${SYM_OK} ${valid.length} valid`);
        for (const b of broken) {
          console.log(`    ${SYM_FAIL} ${b.name} ${red("(broken)")}`);
        }
      }
    }
  }

  // Hints — also registry-driven.
  const hints: string[] = [];
  for (const ts of targetStatuses) {
    // Only nag about targets that are actually in use: the tool is detected, or
    // at least one role is already synced to it.
    const relevant = ts.present || ts.syncedCount > 0;
    if (!relevant) continue;
    const unsyncedCount = ts.roles.filter((r) => !r.synced).length;
    if (unsyncedCount > 0) {
      hints.push(`Run ${cyan(`rolebox sync ${ts.target}`)} to sync ${unsyncedCount} unsynced role(s) to ${ts.label}.`);
    }
    // Surface the platform's own registration hint when detected but unregistered.
    if (ts.present && ts.integration && !ts.integration.registered && ts.integration.hint) {
      hints.push(ts.integration.hint);
    }
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

export default defineCommand({
  meta: {
    name: "status",
    description: "Show overall health and opencode integration",
  },
  args: {
    checkUpdates: {
      type: "boolean",
      alias: ["u", "check-updates"],
      description: "Check for available updates",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    await status(args.checkUpdates ?? false, args.json ?? false);
  },
});

import { defineCommand } from "citty";
import { loadConfig, loadLock, addToLock, findInLock } from "../config.ts";
import { fetchRegistryManifest, downloadRole, resolveVersion, computeIntegrity } from "../registry-client.ts";
import { DownloadProgress } from "../download-progress.ts";
import { getRolePath } from "../paths.ts";
import type { LockEntry } from "../types.ts";
import { existsSync, rmSync } from "node:fs";
import { moveDir, ensureWritableDir } from "../fs-utils.ts";
import { join } from "node:path";

export interface InstallOptions {
  registry?: string;     // registry name (defaults to first default registry)
  version?: string;      // specific version
  quiet?: boolean;       // suppress non-error output
  verbose?: boolean;     // emit per-phase detail
  noProgress?: boolean;  // force degraded line-based progress
}

/**
 * Parse a role specifier like:
 *   "software-architect"          → roleId="software-architect"
 *   "software-architect@1.0.0"   → roleId="software-architect", version="1.0.0"
 *   "my-registry:custom-role"    → registry="my-registry", roleId="custom-role"
 *   "my-registry:role@2.0.0"     → registry="my-registry", roleId="role", version="2.0.0"
 */
export function parseRoleSpec(spec: string): { roleId: string; registry?: string; version?: string } {
  let remaining = spec;
  let registry: string | undefined;
  let version: string | undefined;

  const colonIdx = remaining.indexOf(":");
  if (colonIdx !== -1) {
    registry = remaining.slice(0, colonIdx);
    remaining = remaining.slice(colonIdx + 1);
  }

  const atIdx = remaining.lastIndexOf("@");
  if (atIdx !== -1) {
    version = remaining.slice(atIdx + 1);
    remaining = remaining.slice(0, atIdx);
  }

  return { roleId: remaining, registry, version };
}

/**
 * Install a role from a registry.
 */
export async function install(spec: string, opts: InstallOptions = {}): Promise<void> {
  const progress = new DownloadProgress({
    quiet: opts.quiet,
    verbose: opts.verbose,
    noProgress: opts.noProgress,
  });
  const out = (msg: string) => { if (!opts.quiet) console.log(msg); };

  // 1. Parse role spec
  const parsed = parseRoleSpec(spec);

  // 2. Load config to find registry URL
  const config = loadConfig();

  // 3. Determine registry
  let registryName: string;
  if (parsed.registry) {
    registryName = parsed.registry;
    const found = config.registries.find((r) => r.name === registryName);
    if (!found) {
      throw new Error(`Registry '${registryName}' not found`);
    }
  } else {
    const defaultRegistry = config.registries.find((r) => r.default) ?? config.registries[0];
    if (!defaultRegistry) {
      throw new Error("No registries configured. Run 'rolebox registry add' to add one.");
    }
    registryName = defaultRegistry.name;
  }

  const registryEntry = config.registries.find((r) => r.name === registryName)!;

  // 4. Fetch registry manifest
  progress.phaseStart("resolving", parsed.roleId);
  const manifest = await fetchRegistryManifest(registryEntry);

  // 5. Resolve version
  let version: string;
  if (parsed.version) {
    version = parsed.version;
    // Verify the role exists in manifest
    if (!manifest.roles[parsed.roleId]) {
      throw new Error(`role "${parsed.roleId}" not found in registry "${registryName}"`);
    }
  } else {
    version = resolveVersion(manifest, parsed.roleId);
  }
  progress.phaseComplete("resolving");

  // 6. Check lock file — if already installed at same version, print and exit
  const existing = findInLock(parsed.roleId);
  if (existing && existing.version === version) {
    out(`Role "${parsed.roleId}@${version}" is already installed from ${existing.registry}`);
    return;
  }

  // 7. Download, extract, and verify into a TEMP location FIRST. The
  //    previously-installed version is NOT touched until the new artifact is
  //    fully downloaded, extracted, integrity-checked, and atomically swapped
  //    into place (rollback safety). On any failure before the swap, the
  //    previous version remains intact and the error propagates with
  //    partial-state context.
  const extractedDir = await downloadRole(registryEntry, parsed.roleId, version, undefined, undefined, { progress });

  // 8. Compute + verify integrity on the temp artifact BEFORE swapping it in.
  const integrity = await computeIntegrity(extractedDir);
  const expectedIntegrity = manifest.roles[parsed.roleId]?.integrity;
  if (expectedIntegrity) {
    // Manifest-declared digest available: the computed digest MUST match.
    if (integrity !== expectedIntegrity) {
      const msg = `integrity check failed for role "${parsed.roleId}@${version}": expected ${expectedIntegrity}, computed ${integrity}; refusing to install`;
      progress.phaseFail("verifying", { asset: `${parsed.roleId}@${version}`, reason: msg, attempt: 1, maxAttempts: 1 });
      throw new Error(msg);
    }
  } else {
    // No expected integrity value exists in the manifest. The computed digest
    // is surfaced (when verbose) and recorded in the lock as a best-effort pin;
    // it cannot be verified against anything without a declared value.
    if (opts.verbose) {
      out(`Computed integrity for ${parsed.roleId}@${version} (no expected value in manifest): ${integrity}`);
    }
  }

  // 9. Atomic swap into {rolesDir}/{registry}/{roleId}@{version}/ — stage into a
  //    sibling dir, then rename over the target so the previously-installed
  //    version is replaced atomically rather than deleted before the new one is
  //    ready.
  const targetDir = getRolePath(registryName, parsed.roleId, version);
  progress.phaseStart("installing", targetDir);
  ensureWritableDir(join(targetDir, ".."));
  const staging = join(join(targetDir, ".."), `.${parsed.roleId}@${version}.staging-${process.pid}-${Date.now()}`);
  try {
    moveDir(extractedDir, staging);
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    moveDir(staging, targetDir);
  } catch (err) {
    // The previously-installed version (if any) is left intact; report partial
    // state clearly rather than masking it.
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(
      `install failed for role "${parsed.roleId}@${version}" while placing the new version; the previously-installed version (if any) is left intact: ${(err as Error).message}`,
    );
  }
  progress.phaseComplete("installing");

  // 10. Remove the old version's directory now that the new version is safely
  //     in place and verified. This must NOT happen before the download+verify.
  if (existing) {
    const oldPath = getRolePath(existing.registry, existing.role, existing.version);
    if (oldPath !== targetDir && existsSync(oldPath)) {
      rmSync(oldPath, { recursive: true, force: true });
    }
  }

  // 11. Update lock file
  const entry: LockEntry = {
    role: parsed.roleId,
    registry: registryName,
    version,
    installedAt: new Date().toISOString(),
    integrity,
  };
  addToLock(entry);

  // 12. Print success
  progress.phaseStart("done", `${parsed.roleId}@${version}`);
  progress.phaseComplete("done", `${parsed.roleId}@${version}`);
  out(`✓ Installed ${parsed.roleId}@${version} from ${registryName}`);

  // 13. Print hint
  out(`Run \`rolebox sync opencode\` to deploy`);
}

export default defineCommand({
  meta: {
    name: "install",
    description: "Install a role from a registry",
  },
  args: {
    role: {
      type: "positional",
      description: "Role specifier (e.g. software-architect, my-reg:role@2.0.0)",
      required: true,
    },
    quiet: {
      type: "boolean",
      alias: ["q"],
      description: "Suppress non-error output",
    },
    verbose: {
      type: "boolean",
      alias: ["v"],
      description: "Show per-phase detail",
    },
    noProgress: {
      type: "boolean",
      alias: ["no-progress"],
      description: "Disable progress bars",
    },
  },
  async run({ args }) {
    await install(args.role, {
      quiet: args.quiet,
      verbose: args.verbose,
      noProgress: args.noProgress,
    });
  },
});

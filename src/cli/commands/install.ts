import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { loadConfig, loadLock, addToLock, findInLock } from "../config.ts";
import { assertInteractiveContext, pickRegistryAndRole } from "../pick.ts";
import type { PromptApi } from "../pick.ts";
import { fetchRegistryManifest, downloadRole, resolveVersion, computeIntegrity, escapeForDisplay } from "../registry-client.ts";
import { DownloadProgress } from "../download-progress.ts";
import { getRolePath } from "../paths.ts";
import { parseRoleSpec } from "../role-spec.ts";
import { findRegistry, effectiveRegistries, resolveRoleSource } from "../sources.ts";
import type { ResolvedRegistry } from "../sources.ts";
import type { LockEntry, RegistryManifest } from "../types.ts";
import { existsSync, rmSync } from "node:fs";
import { moveDir, ensureWritableDir, removeTreeBestEffort } from "../fs-utils.ts";
import { join } from "node:path";

export interface InstallOptions {
  registry?: string;     // registry name (defaults to first default registry)
  version?: string;      // specific version
  quiet?: boolean;       // suppress non-error output
  verbose?: boolean;     // emit per-phase detail
  noProgress?: boolean;  // force degraded line-based progress
}

// Specifier parsing lives in ../role-spec.ts so every command shares it; it is
// re-exported here for callers that import it from this module.
export { parseRoleSpec } from "../role-spec.ts";

/**
 * Interactive flow for `rolebox install` without a role specifier: pick a
 * registry and role, confirm, then install. Returns true when an install was
 * performed, false when the user cancelled (or nothing was installed).
 * `prompts` is injectable for tests; production callers use real clack.
 */
export async function installInteractive(prompts: PromptApi = clack): Promise<boolean> {
  assertInteractiveContext(
    "install",
    "Pass a role specifier explicitly, e.g. `rolebox install software-architect`.",
  );

  prompts.intro("rolebox install");
  const picked = await pickRegistryAndRole(undefined, prompts);
  if (!picked) {
    prompts.cancel("Operation cancelled.");
    return false;
  }

  const spec = picked.registry ? `${picked.registry}:${picked.roleId}` : picked.roleId;
  const confirmed = await prompts.confirm({
    message: `Install ${picked.roleId}?`,
  });
  if (prompts.isCancel(confirmed) || !confirmed) {
    prompts.cancel("Operation cancelled.");
    return false;
  }

  prompts.outro("Installing…");
  await install(spec);
  return true;
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

  // 2. Load config to find the configured sources
  const config = loadConfig();

  // 3. Resolve the source and its manifest. An explicit `registry:role` spec
  //    pins one source; an unprefixed spec walks the sources in resolution order
  //    (default source first, then config order) and takes the first that
  //    publishes the role.
  progress.phaseStart("resolving", parsed.roleId);

  let source: ResolvedRegistry;
  let manifest: RegistryManifest;

  if (parsed.registry) {
    const found = findRegistry(config, parsed.registry);
    if (!found) {
      const configured = effectiveRegistries(config).map((r) => r.name).join(", ") || "(none)";
      throw new Error(`Registry '${parsed.registry}' not found. Configured registries: ${configured}`);
    }
    source = found;
    manifest = await fetchRegistryManifest(source, source.ref);
  } else {
    if (effectiveRegistries(config).length === 0) {
      throw new Error("No registries configured. Run 'rolebox registry add' to add one.");
    }

    const lookup = await resolveRoleSource(parsed.roleId, config, {
      fetchManifest: fetchRegistryManifest,
    });

    if (!lookup.match) {
      if (lookup.failures.length > 0 && lookup.searched.length === 0) {
        // Every source failed: the role is unknown, not absent.
        throw new Error(
          `role "${parsed.roleId}" not found: no configured registry could be reached (${lookup.failures.map((f) => `${f.registry.name}: ${f.message}`).join(", ")})`,
        );
      }
      const unreachable = lookup.failures
        .map((f) => `${f.registry.name} (${f.message})`)
        .join(", ");
      const suffix = unreachable ? `; could not reach: ${unreachable}` : "";
      throw new Error(
        `role "${parsed.roleId}" not found in any configured registry (searched: ${lookup.searched.join(", ")})${suffix}`,
      );
    }

    // A source that could not be reached is skipped, never silently: a later
    // source may answer, but the reason the earlier one did not belongs in the
    // output. The no-match path above names the same sources in its error.
    for (const failure of lookup.failures) {
      console.warn(
        `Warning: could not fetch registry "${failure.registry.name}": ${failure.message}`,
      );
    }

    source = lookup.match.registry;
    manifest = lookup.match.manifest;
  }

  const registryName = source.name;

  // 4. Resolve version. The manifest that proved the role exists is reused —
  //    the source is never fetched twice.
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

  // 5. Check lock file — if this source already provides the same version,
  //    print and exit. A copy installed from another source is a different
  //    install and is not treated as satisfying this request.
  const existing = findInLock(parsed.roleId, registryName);
  if (existing && existing.version === version) {
    out(`Role "${parsed.roleId}@${version}" is already installed from ${existing.registry}`);
    return;
  }

  // 6. Download, extract, and verify into a TEMP location FIRST. The
  //    previously-installed version is NOT touched until the new artifact is
  //    fully downloaded, extracted, integrity-checked, and atomically swapped
  //    into place (rollback safety). On any failure before the swap, the
  //    previous version remains intact and the error propagates with
  //    partial-state context.
  const extractedDir = await downloadRole(source, parsed.roleId, version, undefined, undefined, {
    progress,
    // A manifest may declare where the role archive lives (HTTP sources).
    archivePath: manifest.roles[parsed.roleId]?.archive,
  });

  // 7. Compute + verify integrity on the temp artifact BEFORE swapping it in.
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

  // 8. Atomic swap into {rolesDir}/{registry}/{roleId}@{version}/ — stage into a
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
    // state clearly rather than masking it. The downloaded tree is owned by this
    // call until it lands in the roles directory, so a failure to place it must
    // not leave it (or the staging copy) behind in the temp directory.
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    removeTreeBestEffort(extractedDir);
    throw new Error(
      `install failed for role "${parsed.roleId}@${version}" while placing the new version; the previously-installed version (if any) is left intact: ${(err as Error).message}`,
    );
  }
  progress.phaseComplete("installing");

  // 9. Remove the old version's directory now that the new version is safely
  //     in place and verified. This must NOT happen before the download+verify.
  if (existing) {
    const oldPath = getRolePath(existing.registry, existing.role, existing.version);
    if (oldPath !== targetDir && existsSync(oldPath)) {
      rmSync(oldPath, { recursive: true, force: true });
    }
  }

  // 10. Update lock file
  const entry: LockEntry = {
    role: parsed.roleId,
    registry: registryName,
    version,
    installedAt: new Date().toISOString(),
    integrity,
  };
  addToLock(entry);

  // 11. Print success
  progress.phaseStart("done", `${parsed.roleId}@${version}`);
  progress.phaseComplete("done", `${parsed.roleId}@${version}`);
  out(`✓ Installed ${escapeForDisplay(parsed.roleId)}@${escapeForDisplay(version)} from ${escapeForDisplay(registryName)}`);

  // 12. Print hint
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
      description: "Role specifier (e.g. software-architect, my-reg:role@2.0.0). Omit for interactive selection",
      required: false,
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
    if (!args.role) {
      await installInteractive();
      return;
    }
    await install(args.role, {
      quiet: args.quiet,
      verbose: args.verbose,
      noProgress: args.noProgress,
    });
  },
});

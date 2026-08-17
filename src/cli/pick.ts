import * as clack from "@clack/prompts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadLock } from "./config.ts";
import { fetchRegistryManifest } from "./registry-client.ts";
import { getSyncTarget } from "./paths.ts";

/**
 * The subset of the clack prompts API the interactive pickers use. Commands
 * pass the real module by default; tests inject a scripted fake so picker
 * behavior is verifiable without a terminal (and without mocking modules).
 */
export interface PromptApi {
  intro: typeof clack.intro;
  outro: typeof clack.outro;
  cancel: typeof clack.cancel;
  confirm: typeof clack.confirm;
  select: typeof clack.select;
  spinner: typeof clack.spinner;
  isCancel: typeof clack.isCancel;
  log: Pick<typeof clack.log, "error">;
}

/** The real clack prompts module — the default for every picker. */
export const realPrompts: PromptApi = clack;

/**
 * Guard for interactive role selection: prompt-based flows need a real
 * terminal. Throws a friendly error (naming the non-interactive alternative)
 * when stdin is not a TTY, instead of rendering prompt garbage into a pipe or
 * CI log.
 */
export function assertInteractiveContext(command: string, hint: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Interactive role selection for \`rolebox ${command}\` requires a TTY. ${hint}`,
    );
  }
}

function isCancelled(value: unknown, prompts: PromptApi): value is symbol {
  return prompts.isCancel(value);
}

/**
 * Pick an installed role from the lock file.
 * Returns the chosen roleId, or null when the user cancels.
 */
export async function pickInstalledRole(
  message: string,
  prompts: PromptApi = realPrompts,
): Promise<string | null> {
  const lock = loadLock();
  const roles = lock.roles;

  if (roles.length === 0) {
    prompts.log.error("No roles installed. Run `rolebox install` first.");
    return null;
  }

  const picked = await prompts.select({
    message,
    options: roles.map((entry) => ({
      value: entry.role,
      label: entry.role,
      hint: `${entry.version} · ${entry.registry}`,
    })),
    maxItems: 12,
  });

  return isCancelled(picked, prompts) ? null : (picked as string);
}

/**
 * Pick a role that is synced into a target harness directory (a symlink to an
 * installed role). Broken symlinks are skipped.
 * Returns the chosen roleId, or null when the user cancels.
 */
export async function pickSyncedRole(
  target: string,
  message: string,
  prompts: PromptApi = realPrompts,
): Promise<string | null> {
  const syncDir = getSyncTarget(target);
  const roles: string[] = [];

  if (existsSync(syncDir)) {
    for (const entry of readdirSync(syncDir, { withFileTypes: true })) {
      const full = join(syncDir, entry.name);
      try {
        if (statSync(full).isDirectory()) roles.push(entry.name);
      } catch {
        // Broken symlink — skip it rather than offering a dead role.
      }
    }
  }
  roles.sort();

  if (roles.length === 0) {
    prompts.log.error(
      `No roles synced to "${target}". Run \`rolebox sync ${target}\` first.`,
    );
    return null;
  }

  const picked = await prompts.select({
    message,
    options: roles.map((role) => ({ value: role, label: role })),
    maxItems: 12,
  });

  return isCancelled(picked, prompts) ? null : (picked as string);
}

/**
 * Interactive flow for `rolebox install` without a role spec: choose a
 * registry (only when more than one is configured) and then a role from that
 * registry's manifest.
 *
 * Returns a `{ registry?, roleId }` pair — `registry` is omitted when the
 * chosen registry is the default/single one so the resulting spec stays short
 * (`roleId`). Returns null when the user cancels.
 */
export async function pickRegistryAndRole(
  message = "Select a role to install:",
  prompts: PromptApi = realPrompts,
): Promise<{ registry?: string; roleId: string } | null> {
  const config = loadConfig();
  if (config.registries.length === 0) {
    throw new Error("No registries configured. Run 'rolebox registry add' to add one.");
  }

  const defaultRegistry =
    config.registries.find((r) => r.default) ?? config.registries[0];

  let registry = defaultRegistry;
  if (config.registries.length > 1) {
    const picked = await prompts.select({
      message: "Select a registry:",
      options: config.registries.map((r) => ({
        value: r.name,
        label: r.name,
        hint: r.url,
      })),
      initialValue: registry.name,
      maxItems: 12,
    });
    if (isCancelled(picked, prompts)) return null;
    registry = config.registries.find((r) => r.name === picked) ?? registry;
  }

  const spinner = prompts.spinner();
  spinner.start(`Fetching roles from ${registry.name}…`);
  let manifest;
  try {
    manifest = await fetchRegistryManifest(registry);
  } catch (err) {
    spinner.stop("Fetch failed");
    throw err;
  }
  spinner.stop("Done");

  const entries = Object.entries(manifest.roles);
  if (entries.length === 0) {
    prompts.log.error(`Registry "${registry.name}" has no roles.`);
    return null;
  }

  const picked = await prompts.select({
    message,
    options: entries.map(([roleId, info]) => ({
      value: roleId,
      label: roleId,
      hint: [info.version, info.description].filter(Boolean).join(" · ") || undefined,
    })),
    maxItems: 12,
  });
  if (isCancelled(picked, prompts)) return null;

  const roleId = picked as string;
  // Only prefix the registry when it is NOT the default — keeps the spec short
  // (`roleId`) in the common single/default-registry case.
  const registryNeeded =
    config.registries.length > 1 && registry.name !== defaultRegistry.name;

  return { registry: registryNeeded ? registry.name : undefined, roleId };
}

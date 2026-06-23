import { loadConfig, saveConfig, loadLock } from "../config";
import { parseGitHubUrl, fetchRegistryManifest } from "../registry-client";

/**
 * Registry management command dispatcher.
 * args[0] is the subcommand: add, remove, list
 */
export async function registry(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "list") {
    return registryList();
  }

  if (subcommand === "add") {
    return registryAdd(args.slice(1));
  }

  if (subcommand === "remove") {
    return registryRemove(args.slice(1));
  }

  console.error(
    `Unknown registry subcommand '${subcommand}'. Usage: rolebox registry <add|remove|list>`,
  );
  process.exit(1);
}

function registryList(): void {
  const config = loadConfig();
  console.log("Registries:");
  for (const reg of config.registries) {
    const marker = reg.default ? " (default)" : "";
    console.log(`  ${reg.name.padEnd(14)} ${reg.url}${marker}`);
  }
}

async function registryAdd(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) {
    console.error("Usage: rolebox registry add <url>");
    process.exit(1);
  }

  let owner: string, repo: string;
  try {
    ({ owner, repo } = parseGitHubUrl(url));
  } catch {
    console.error("Invalid GitHub URL. Expected: https://github.com/owner/repo");
    process.exit(1);
  }
  const name = repo;

  const entry = { name, url };
  try {
    await fetchRegistryManifest(entry, "main", { noCache: true });
  } catch (err) {
    console.error(`Could not validate registry at ${url}: ${(err as Error).message}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (config.registries.some((r) => r.name === name)) {
    console.error(`Registry '${name}' is already configured`);
    process.exit(1);
  }
  config.registries.push(entry);
  saveConfig(config);
  console.log(`✓ Added registry '${name}' (${url})`);
}

function registryRemove(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error("Usage: rolebox registry remove <name>");
    process.exit(1);
  }

  const config = loadConfig();
  const index = config.registries.findIndex((r) => r.name === name);

  if (index === -1) {
    console.error(`Registry '${name}' not found`);
    process.exit(1);
  }

  if (config.registries[index].default) {
    console.error(`Cannot remove default registry '${name}'`);
    process.exit(1);
  }

  config.registries.splice(index, 1);
  saveConfig(config);
  console.log(`✓ Removed registry '${name}'`);

  // Warn about installed roles from this registry
  const lock = loadLock();
  const affected = lock.roles.filter((r) => r.registry === name);
  if (affected.length > 0) {
    console.warn(
      `Warning: ${affected.length} role(s) from '${name}' are still installed. Use 'rolebox uninstall' to remove them.`,
    );
  }
}

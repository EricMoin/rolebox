import { defineCommand } from "citty";
import { loadConfig, saveConfig, loadLock } from "../config.ts";
import { parseGitHubUrl, fetchRegistryManifest } from "../registry-client.ts";

export function registryListFn(): void {
  const config = loadConfig();
  console.log("Registries:");
  for (const reg of config.registries) {
    const marker = reg.default ? " (default)" : "";
    console.log(`  ${reg.name.padEnd(14)} ${reg.url}${marker}`);
  }
}

export async function registryAddFn(url: string): Promise<void> {
  let owner: string, repo: string;
  try {
    ({ owner, repo } = parseGitHubUrl(url));
  } catch {
    throw new Error("Invalid GitHub URL. Expected: https://github.com/owner/repo");
  }
  const name = repo;

  const entry = { name, url };
  try {
    await fetchRegistryManifest(entry, "main", { noCache: true });
  } catch (err) {
    throw new Error(`Could not validate registry at ${url}: ${(err as Error).message}`);
  }

  const config = loadConfig();
  if (config.registries.some((r) => r.name === name)) {
    throw new Error(`Registry '${name}' is already configured`);
  }
  config.registries.push(entry);
  saveConfig(config);
  console.log(`✓ Added registry '${name}' (${url})`);
}

export function registryRemoveFn(name: string): void {
  const config = loadConfig();
  const index = config.registries.findIndex((r) => r.name === name);

  if (index === -1) {
    throw new Error(`Registry '${name}' not found`);
  }

  if (config.registries[index].default) {
    throw new Error(`Cannot remove default registry '${name}'`);
  }

  config.registries.splice(index, 1);
  saveConfig(config);
  console.log(`✓ Removed registry '${name}'`);

  const lock = loadLock();
  const affected = lock.roles.filter((r) => r.registry === name);
  if (affected.length > 0) {
    console.warn(
      `Warning: ${affected.length} role(s) from '${name}' are still installed. Use 'rolebox uninstall' to remove them.`,
    );
  }
}

const registryList = defineCommand({
  meta: { name: "list", description: "Show all configured registries" },
  run() { registryListFn(); },
});

const registryAdd = defineCommand({
  meta: { name: "add", description: "Add a registry" },
  args: {
    url: { type: "positional", description: "GitHub repository URL", required: true },
  },
  async run({ args }) { await registryAddFn(args.url); },
});

const registryRemove = defineCommand({
  meta: { name: "remove", description: "Remove a registry" },
  args: {
    name: { type: "positional", description: "Registry name to remove", required: true },
  },
  run({ args }) { registryRemoveFn(args.name); },
});

export default defineCommand({
  meta: {
    name: "registry",
    description: "Manage registries (add, remove, list)",
  },
  subCommands: {
    list: registryList,
    add: registryAdd,
    remove: registryRemove,
  },
  default: "list",
});

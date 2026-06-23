import { loadConfig } from "../config.js";
import { fetchRegistryManifest } from "../registry-client.js";
import type { RegistryManifest } from "../types.js";

/**
 * Search for roles matching a query string across all configured registries.
 * If no query provided, lists ALL available roles.
 * Matches against role ID, name, description, and tags.
 */
export async function search(args: string[]): Promise<void> {
  const config = loadConfig();
  const query = args[0]?.toLowerCase();

  let foundAny = false;

  for (const registry of config.registries) {
    let manifest: RegistryManifest;
    try {
      manifest = await fetchRegistryManifest(registry);
    } catch (err) {
      console.warn(
        `Warning: could not fetch registry "${registry.name}": ${(err as Error).message}`,
      );
      continue;
    }

    const entries = Object.entries(manifest.roles);
    const filtered = query
      ? entries.filter(([roleId, info]) => {
          const searchText =
            `${roleId} ${info.description} ${info.tags.join(" ")}`.toLowerCase();
          return searchText.includes(query);
        })
      : entries;

    if (filtered.length === 0) continue;

    foundAny = true;
    console.log(`Results from ${registry.name}:`);
    for (const [roleId, info] of filtered) {
      const padded = roleId.padEnd(24);
      console.log(`  ${padded} ${info.version}  ${info.description}`);
    }
  }

  if (!foundAny) {
    if (query) {
      console.log(`No roles matching '${query}'. Try a different search term.`);
    } else {
      console.log("No roles found in any registry.");
    }
  }
}

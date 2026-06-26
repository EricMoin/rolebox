import { defineCommand } from "citty";
import { loadConfig } from "../config.ts";
import { fetchRegistryManifest } from "../registry-client.ts";
import type { RegistryManifest } from "../types.ts";

export async function search(query: string | undefined, noCache: boolean): Promise<void> {
  const config = loadConfig();
  const normalizedQuery = query?.toLowerCase();

  let foundAny = false;

  for (const registry of config.registries) {
    let manifest: RegistryManifest;
    try {
      manifest = await fetchRegistryManifest(registry, undefined, { noCache });
    } catch (err) {
      console.warn(
        `Warning: could not fetch registry "${registry.name}": ${(err as Error).message}`,
      );
      continue;
    }

    const entries = Object.entries(manifest.roles);
    const filtered = normalizedQuery
      ? entries.filter(([roleId, info]) => {
          const searchText =
            `${roleId} ${info.description} ${info.tags.join(" ")}`.toLowerCase();
          return searchText.includes(normalizedQuery);
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
    if (normalizedQuery) {
      console.log(`No roles matching '${normalizedQuery}'. Try a different search term.`);
    } else {
      console.log("No roles found in any registry.");
    }
  }
}

export default defineCommand({
  meta: {
    name: "search",
    description: "Search available roles in registries",
  },
  args: {
    query: {
      type: "positional",
      description: "Search query (matches name, description, tags)",
    },
    noCache: {
      type: "boolean",
      alias: ["no-cache"],
      description: "Bypass registry cache",
    },
  },
  async run({ args }) {
    await search(args.query, args.noCache ?? false);
  },
});

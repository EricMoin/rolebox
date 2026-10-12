import { defineCommand } from "citty";
import { loadConfig } from "../config.ts";
import { fetchRegistryManifest, escapeForDisplay } from "../registry-client.ts";
import { effectiveRegistries } from "../sources.ts";
import type { RegistryManifest } from "../types.ts";

export async function search(
  query: string | undefined,
  noCache: boolean,
  registryFilter?: string,
): Promise<void> {
  const config = loadConfig();
  const normalizedQuery = query?.toLowerCase();

  const allSources = effectiveRegistries(config);
  let sources = allSources;
  if (registryFilter) {
    const names = registryFilter.split(",").map((n) => n.trim()).filter((n) => n !== "");
    for (const name of names) {
      if (!allSources.some((r) => r.name === name)) {
        const configured = allSources.map((r) => r.name).join(", ") || "(none)";
        throw new Error(`Registry '${name}' not found. Configured sources: ${configured}`);
      }
    }
    sources = allSources.filter((r) => names.includes(r.name));
  }

  let foundAny = false;
  const failed: string[] = [];
  // roleId -> the selected sources that publish it, in lookup order.
  const publishers = new Map<string, string[]>();
  const displayed = new Set<string>();

  for (const registry of sources) {
    let manifest: RegistryManifest;
    try {
      manifest = await fetchRegistryManifest(registry, registry.ref, { noCache });
    } catch (err) {
      failed.push(registry.name);
      console.warn(
        `Warning: could not fetch registry "${registry.name}": ${(err as Error).message}`,
      );
      continue;
    }

    const entries = Object.entries(manifest.roles);
    for (const [roleId] of entries) {
      const names = publishers.get(roleId);
      if (names) names.push(registry.name);
      else publishers.set(roleId, [registry.name]);
    }

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
      displayed.add(roleId);
      const padded = escapeForDisplay(roleId).padEnd(24);
      console.log(`  ${padded} ${escapeForDisplay(info.version)}  ${escapeForDisplay(info.description)}`);
    }
  }

  // A role published by more than one selected source is ambiguous to an
  // unprefixed `rolebox install <role>` — name the candidates.
  for (const [roleId, names] of publishers) {
    if (names.length < 2 || !displayed.has(roleId)) continue;
    console.log(
      `Note: '${roleId}' is published by ${names.length} sources (${names.join(", ")}) — choose one with 'rolebox install ${names[0]}:${roleId}'.`,
    );
  }

  if (!foundAny) {
    if (sources.length > 0 && failed.length === sources.length) {
      console.warn(
        `Warning: could not fetch any configured registry (${failed.length}/${sources.length}) — the result is unknown, not empty.`,
      );
    }
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
      required: false,
      description: "Search query (matches name, description, tags)",
    },
    noCache: {
      type: "boolean",
      alias: ["no-cache"],
      description: "Bypass registry cache",
    },
    registry: {
      type: "string",
      description: "Search only these sources (comma-separated names)",
    },
  },
  async run({ args }) {
    await search(args.query, args.noCache ?? false, args.registry);
  },
});

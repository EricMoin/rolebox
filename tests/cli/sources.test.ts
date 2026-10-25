import { describe, it, expect, vi } from "vitest";
import {
  BUILTIN_REGISTRY,
  BUILTIN_REGISTRY_NAME,
  defaultRegistry,
  effectiveRegistries,
  findRegistry,
  isBuiltinName,
  isGitLabUrl,
  lookupOrder,
  resolveRoleSource,
} from "../../src/cli/sources.ts";
import type { RegistryEntry, RegistryManifest, RoleboxConfig } from "../../src/cli/types.ts";

const BUILTIN_URL = "https://github.com/EricMoin/oh-my-role";

/**
 * The manifest-fetch callback `resolveRoleSource` takes. Declaring it here means
 * a mock typed with it records all three arguments, so assertions on the ref and
 * the options are type-checked against the real call shape.
 */
type FetchManifest = (
  registry: RegistryEntry,
  ref: string | undefined,
  options: { noCache?: boolean },
) => Promise<RegistryManifest>;

function manifest(name: string, roleIds: string[] = []): RegistryManifest {
  return {
    name,
    description: `${name} registry`,
    url: `https://github.com/example/${name}`,
    roles: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        { version: "1.0.0", description: `${roleId} role`, tags: [] },
      ]),
    ),
  };
}

function config(registries: RegistryEntry[]): RoleboxConfig {
  return { registries };
}

describe("BUILTIN_REGISTRY", () => {
  it("is the shipped oh-my-role source", () => {
    expect(BUILTIN_REGISTRY_NAME).toBe("oh-my-role");
    expect(BUILTIN_REGISTRY).toEqual({
      name: "oh-my-role",
      url: BUILTIN_URL,
      default: true,
    });
  });
});

describe("effectiveRegistries", () => {
  it("keeps an explicitly empty list empty (the opt-out)", () => {
    expect(effectiveRegistries(config([]))).toEqual([]);
  });

  it("prepends the built-in source when the file holds only a custom source", () => {
    const result = effectiveRegistries(config([
      { name: "custom", url: "https://github.com/acme/custom" },
    ]));

    expect(result.map((r) => r.name)).toEqual([BUILTIN_REGISTRY_NAME, "custom"]);
    expect(result[0].url).toBe(BUILTIN_URL);
    expect(result[0].builtin).toBe(true);
    expect(result[0].default).toBe(true);
    expect(result[1].builtin).toBe(false);
  });

  it("keeps the file's own oh-my-role entry with its url and ref, listed first", () => {
    const result = effectiveRegistries(config([
      { name: "custom", url: "https://github.com/acme/custom" },
      { name: BUILTIN_REGISTRY_NAME, url: "https://github.com/acme/fork", ref: "v2" },
    ]));

    expect(result.map((r) => r.name)).toEqual([BUILTIN_REGISTRY_NAME, "custom"]);
    expect(result[0].url).toBe("https://github.com/acme/fork");
    expect(result[0].ref).toBe("v2");
    expect(result[0].builtin).toBe(true);
  });

  it("demotes the built-in when a custom source claims the default", () => {
    const result = effectiveRegistries(config([
      { name: "custom", url: "https://github.com/acme/custom", default: true },
    ]));

    expect(result[0].name).toBe(BUILTIN_REGISTRY_NAME);
    expect(result[0].default).toBe(false);
    expect(result[1].default).toBe(true);
  });

  it("preserves custom order and their own flags", () => {
    const result = effectiveRegistries(config([
      { name: "a", url: "https://github.com/acme/a" },
      { name: "b", url: "https://github.com/acme/b", ref: "next" },
      { name: "c", url: "https://github.com/acme/c", default: false },
    ]));

    expect(result.map((r) => r.name)).toEqual([BUILTIN_REGISTRY_NAME, "a", "b", "c"]);
    expect(result[2].ref).toBe("next");
    expect(result[3].default).toBe(false);
  });

  it("returns copies, so normalizing a result never rewrites the config", () => {
    const cfg = config([{ name: "custom", url: "https://github.com/acme/custom" }]);
    const [builtin] = effectiveRegistries(cfg);
    builtin.default = false;

    expect(cfg.registries).toEqual([{ name: "custom", url: "https://github.com/acme/custom" }]);
  });
});

describe("defaultRegistry", () => {
  it("is undefined when no source is configured", () => {
    expect(defaultRegistry(config([]))).toBeUndefined();
  });

  it("prefers a custom source flagged default", () => {
    const result = defaultRegistry(config([
      { name: "custom", url: "https://github.com/acme/custom", default: true },
    ]));
    expect(result?.name).toBe("custom");
  });

  it("falls back to the built-in when nothing claims the default", () => {
    const result = defaultRegistry(config([
      { name: "custom", url: "https://github.com/acme/custom" },
    ]));
    expect(result?.name).toBe(BUILTIN_REGISTRY_NAME);
    expect(result?.builtin).toBe(true);
  });
});

describe("findRegistry / isBuiltinName", () => {
  it("finds the built-in even when the file never names it", () => {
    const cfg = config([{ name: "custom", url: "https://github.com/acme/custom" }]);
    expect(findRegistry(cfg, BUILTIN_REGISTRY_NAME)?.builtin).toBe(true);
    expect(findRegistry(cfg, "custom")?.url).toBe("https://github.com/acme/custom");
    expect(findRegistry(cfg, "missing")).toBeUndefined();
  });

  it("finds nothing in an opted-out config", () => {
    expect(findRegistry(config([]), BUILTIN_REGISTRY_NAME)).toBeUndefined();
  });

  it("recognizes only the built-in name", () => {
    expect(isBuiltinName(BUILTIN_REGISTRY_NAME)).toBe(true);
    expect(isBuiltinName("custom")).toBe(false);
    expect(isBuiltinName("")).toBe(false);
  });
});

describe("lookupOrder", () => {
  it("puts the default source first and keeps the rest in config order", () => {
    const cfg = config([
      { name: "a", url: "https://github.com/acme/a" },
      { name: "b", url: "https://github.com/acme/b", default: true },
      { name: "c", url: "https://github.com/acme/c" },
    ]);

    expect(lookupOrder(cfg).map((r) => r.name)).toEqual(["b", BUILTIN_REGISTRY_NAME, "a", "c"]);
  });

  it("is just the effective order when nothing claims the default", () => {
    const cfg = config([{ name: "a", url: "https://github.com/acme/a" }]);
    expect(lookupOrder(cfg).map((r) => r.name)).toEqual([BUILTIN_REGISTRY_NAME, "a"]);
  });
});

describe("resolveRoleSource", () => {
  it("takes the first match in lookup order and reuses the fetched manifest", async () => {
    const cfg = config([
      { name: "custom", url: "https://github.com/acme/custom", default: true },
    ]);
    const customManifest = manifest("custom", ["shared-role"]);
    const fetchManifest = vi.fn<FetchManifest>(async (registry) =>
      registry.name === "custom"
        ? customManifest
        : manifest(BUILTIN_REGISTRY_NAME, ["shared-role"]),
    );

    const result = await resolveRoleSource("shared-role", cfg, { fetchManifest, noCache: true });

    expect(result.match?.registry.name).toBe("custom");
    // The manifest the role was found in is handed back — the caller never
    // needs a second fetch for the version.
    expect(result.match?.manifest).toBe(customManifest);
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(fetchManifest.mock.calls[0][0]).toMatchObject({
      name: "custom",
      url: "https://github.com/acme/custom",
    });
    expect(fetchManifest.mock.calls[0][2]).toEqual({ noCache: true });
    expect(result.failures).toEqual([]);
    expect(result.searched).toEqual([]);
  });

  it("records a failing source and keeps looking", async () => {
    const cfg = config([
      { name: "broken", url: "https://github.com/acme/broken", default: true },
    ]);
    const fetchManifest = vi.fn(async (registry: RegistryEntry) => {
      if (registry.name === "broken") throw new Error("network error");
      return manifest(registry.name, ["wanted"]);
    });

    const result = await resolveRoleSource("wanted", cfg, { fetchManifest });

    expect(result.match?.registry.name).toBe(BUILTIN_REGISTRY_NAME);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].registry.name).toBe("broken");
    expect(result.failures[0].message).toBe("network error");
    expect(result.searched).toEqual([]);
  });

  it("lists every source that answered without the role", async () => {
    const cfg = config([{ name: "a", url: "https://github.com/acme/a" }]);
    const fetchManifest = async (registry: RegistryEntry) => manifest(registry.name);

    const result = await resolveRoleSource("missing", cfg, { fetchManifest });

    expect(result.match).toBeUndefined();
    expect(result.searched).toEqual([BUILTIN_REGISTRY_NAME, "a"]);
    expect(result.failures).toEqual([]);
  });

  it("reports every failure when no source answers", async () => {
    const cfg = config([{ name: "a", url: "https://github.com/acme/a", default: true }]);
    const fetchManifest = async () => {
      throw new Error("offline");
    };

    const result = await resolveRoleSource("wanted", cfg, { fetchManifest });

    expect(result.match).toBeUndefined();
    expect(result.failures.map((f) => f.registry.name)).toEqual(["a", BUILTIN_REGISTRY_NAME]);
    expect(result.failures.map((f) => f.message)).toEqual(["offline", "offline"]);
    expect(result.searched).toEqual([]);
  });

  it("passes the entry's ref, falling back to the default branch", async () => {
    // The source under test claims the default, so it is consulted first and
    // matches: one fetch per lookup.
    const fetchManifest = vi.fn<FetchManifest>(async (registry) => manifest(registry.name, ["r"]));

    await resolveRoleSource("r", config([{ name: "pinned", url: "u", ref: "v2", default: true }]), {
      fetchManifest,
    });
    await resolveRoleSource("r", config([{ name: "unpinned", url: "u", default: true }]), {
      fetchManifest,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(2);
    expect(fetchManifest.mock.calls[0][1]).toBe("v2");
    expect(fetchManifest.mock.calls[1][1]).toBe("main");
  });

  it("finds nothing when no source is configured", async () => {
    const fetchManifest = vi.fn(async () => manifest("any"));

    const result = await resolveRoleSource("r", config([]), { fetchManifest });

    expect(result.match).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(result.searched).toEqual([]);
    expect(fetchManifest).not.toHaveBeenCalled();
  });
});

describe("isGitLabUrl", () => {
  it("recognizes gitlab.com and self-hosted GitLab projects", () => {
    expect(isGitLabUrl("https://gitlab.com/group/repo")).toBe(true);
    expect(isGitLabUrl("https://code.example.com/group/repo/-/tree/main")).toBe(true);
    expect(isGitLabUrl("https://gitlab.example.com/group/repo")).toBe(true);
  });

  it("does not claim github or plain http sources", () => {
    expect(isGitLabUrl("https://github.com/owner/repo")).toBe(false);
    expect(isGitLabUrl("https://roles.example.com/acme/registry.yaml")).toBe(false);
  });

  it("returns false rather than throwing for an unreadable URL", () => {
    expect(isGitLabUrl("")).toBe(false);
    expect(isGitLabUrl("not-a-url")).toBe(false);
    expect(isGitLabUrl("ftp://host/repo")).toBe(false);
  });
});

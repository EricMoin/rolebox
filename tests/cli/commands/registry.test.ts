import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump, load } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types.ts";

const regConfigDir = mkdtempSync(join(tmpdir(), "rolebox-reg-mod-config-"));
const regDataDir = mkdtempSync(join(tmpdir(), "rolebox-reg-mod-data-"));
process.env.XDG_CONFIG_HOME = regConfigDir;
process.env.XDG_DATA_HOME = regDataDir;

import { createPathsMockPayload } from "../../helpers/paths-mock.ts";

mock.module("../../../src/cli/paths", () => createPathsMockPayload({
  extra: {
    getSyncTarget: (target: string) => {
      if (target === "opencode") {
        const xdg = process.env.XDG_CONFIG_HOME;
        if (xdg) return join(xdg, "opencode", "rolebox");
        return join(homedir(), ".config", "opencode", "rolebox");
      }
      throw new Error(`Unknown sync target: "${target}". Supported targets: opencode`);
    },
  },
}));

afterAll(() => {
  rmSync(regConfigDir, { recursive: true, force: true });
  rmSync(regDataDir, { recursive: true, force: true });
});

const mockFetchManifest = mock();

let tmpConfigDir: string;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-registry-config-"));
  process.env.XDG_CONFIG_HOME = tmpConfigDir;

  mock.module("../../../src/cli/registry-client", () => ({
    parseGitHubUrl: (url: string) => {
      let m = url.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
      );
      if (m) return { owner: m[1], repo: m[2] };
      m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m) return { owner: m[1], repo: m[2] };
      throw new Error(`invalid GitHub URL: "${url}"`);
    },
    fetchRegistryManifest: mockFetchManifest,
  }));
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

const sampleManifest: RegistryManifest = {
  name: "my-registry",
  description: "A test registry",
  url: "https://github.com/owner/repo",
  roles: {
    "test-role": { version: "1.0.0", description: "Test", tags: ["test"] },
  },
};

function capture(
  fn: () => Promise<void>,
): { out: string[]; err: string[]; run: () => Promise<void> } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => {
    out.push(args.map(String).join(" "));
  };
  console.warn = (...args) => {
    out.push(args.map(String).join(" "));
  };
  console.error = (...args) => {
    err.push(args.map(String).join(" "));
  };
  return {
    out,
    err,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
        console.error = origError;
        console.warn = origWarn;
      }
    },
  };
}

function configDir(): string {
  return join(tmpConfigDir, "rolebox");
}

function configPath(): string {
  return join(configDir(), "config.yaml");
}

describe("registry list", () => {
  it("shows the default oh-my-role registry when no config exists", async () => {
    const { registryListFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryListFn());
    await c.run();

    expect(c.out.some((l) => l.includes("oh-my-role"))).toBe(true);
    expect(c.out.some((l) => l.includes("(default)"))).toBe(true);
  });

  it("lists registries without a subcommand (defaults to list)", async () => {
    const { registryListFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryListFn());
    await c.run();

    expect(c.out.some((l) => l.includes("oh-my-role"))).toBe(true);
  });
});

describe("registry add", () => {
  beforeEach(() => {
    mockFetchManifest.mockReset();
    mockFetchManifest.mockImplementation(async () => sampleManifest);
  });

  it("adds a new registry and persists to config", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () =>
      registryAddFn("https://github.com/my-org/my-repo"),
    );
    await c.run();

    expect(c.out.some((l) => l.includes("Added"))).toBe(true);
    expect(c.out.some((l) => l.includes("my-repo"))).toBe(true);

    const raw = readFileSync(configPath(), "utf-8");
    const parsed = load(raw) as any;
    expect(parsed.registries.some((r: any) => r.name === "my-repo")).toBe(true);
  });

  it("rejects an invalid GitHub URL", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await expect(registryAddFn("not-a-url")).rejects.toThrow(/Invalid GitHub URL/);
  });

  it("rejects a duplicate registry name", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await registryAddFn("https://github.com/owner/dup-registry");
    await expect(
      registryAddFn("https://github.com/other/dup-registry"),
    ).rejects.toThrow(/already configured/);
  });

  it("rejects when no URL provided", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await expect(registryAddFn("")).rejects.toThrow(/Invalid GitHub URL/);
  });

  it("validates the URL by fetching registry.yaml", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () =>
      registryAddFn("https://github.com/validated/reg"),
    );
    await c.run();

    expect(c.out.some((l) => l.includes("Added"))).toBe(true);
    expect(mockFetchManifest).toHaveBeenCalledTimes(1);
  });

  it("fails when fetchRegistryManifest throws", async () => {
    mockFetchManifest.mockReset();
    mockFetchManifest.mockRejectedValue(new Error("not found"));

    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await expect(
      registryAddFn("https://github.com/bad/registry"),
    ).rejects.toThrow(/Could not validate registry/);
  });
});

describe("registry remove", () => {
  it("removes a custom registry", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          {
            name: "oh-my-role",
            url: "https://github.com/EricMoin/oh-my-role",
            default: true,
          },
          {
            name: "custom-registry",
            url: "https://github.com/custom/reg",
          },
        ],
      }),
      "utf-8",
    );

    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryRemoveFn("custom-registry"));
    await c.run();

    expect(c.out.some((l) => l.includes("Removed"))).toBe(true);

    const raw = readFileSync(configPath(), "utf-8");
    const parsed = load(raw) as any;
    expect(parsed.registries).toHaveLength(1);
    expect(parsed.registries[0].name).toBe("oh-my-role");
  });

  it("refuses to remove the default registry", async () => {
    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    expect(() => registryRemoveFn("oh-my-role")).toThrow(/Cannot remove default registry/);
  });

  it("rejects removal of non-existent registry", async () => {
    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    expect(() => registryRemoveFn("nonexistent-registry")).toThrow(/not found/);
  });

  it("rejects removal when no name provided", async () => {
    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    expect(() => registryRemoveFn("")).toThrow(/not found/);
  });
});

describe("registry add options", () => {
  beforeEach(() => {
    mockFetchManifest.mockReset();
    mockFetchManifest.mockImplementation(async () => sampleManifest);
  });

  it("persists --name and --ref and passes them to the single validation fetch", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () =>
      registryAddFn("https://github.com/my-org/my-repo", { name: "pinned", ref: "v2" }),
    );
    await c.run();

    expect(c.out.some((l) => l.includes("Added") && l.includes("pinned"))).toBe(true);
    expect(mockFetchManifest).toHaveBeenCalledTimes(1);

    const [entry, ref, options] = mockFetchManifest.mock.calls[0];
    expect(entry).toMatchObject({
      name: "pinned",
      url: "https://github.com/my-org/my-repo",
      ref: "v2",
    });
    expect(ref).toBe("v2");
    expect(options).toEqual({ noCache: true });

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(parsed.registries.find((r: any) => r.name === "pinned")).toMatchObject({
      url: "https://github.com/my-org/my-repo",
      ref: "v2",
    });
  });

  it("rejects a blank --name instead of falling back to the repository name", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await expect(
      registryAddFn("https://github.com/my-org/my-repo", { name: "   " }),
    ).rejects.toThrow(/registry name is empty/);
    expect(mockFetchManifest).not.toHaveBeenCalled();
  });

  it("--default clears the flag on every other source", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" },
          { name: "other", url: "https://github.com/other/roles", default: true },
        ],
      }),
      "utf-8",
    );

    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () =>
      registryAddFn("https://github.com/new/reg", { makeDefault: true }),
    );
    await c.run();

    expect(c.out.some((l) => l.includes("as the default source"))).toBe(true);

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(
      parsed.registries.filter((r: any) => r.default === true).map((r: any) => r.name),
    ).toEqual(["reg"]);
  });

  it("rejects a duplicate name before fetching anything", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await registryAddFn("https://github.com/owner/dup-registry");
    mockFetchManifest.mockClear();

    await expect(
      registryAddFn("https://github.com/other/dup-registry"),
    ).rejects.toThrow(/already configured/);
    expect(mockFetchManifest).not.toHaveBeenCalled();
  });

  it("refuses a source that would take the built-in name", async () => {
    const { registryAddFn } = await import("../../../src/cli/commands/registry.ts");
    await expect(
      registryAddFn("https://github.com/other/oh-my-role"),
    ).rejects.toThrow(/already configured/);
  });
});

describe("registry list output", () => {
  it("marks ref, default and built-in separately", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", ref: "v2" },
          { name: "custom", url: "https://github.com/acme/custom" },
        ],
      }),
      "utf-8",
    );

    const { registryListFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryListFn());
    await c.run();

    const builtinLine = c.out.find((l) => l.includes("oh-my-role")) ?? "";
    expect(builtinLine).toContain("(ref: v2)");
    expect(builtinLine).toContain("(default)");
    expect(builtinLine).toContain("(built-in)");

    const customLine = c.out.find((l) => l.includes("custom")) ?? "";
    expect(customLine).not.toContain("(default)");
    expect(customLine).not.toContain("(built-in)");
  });

  it("lists the built-in source even when the file never names it", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({ registries: [{ name: "custom", url: "https://github.com/acme/custom" }] }),
      "utf-8",
    );

    const { registryListFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryListFn());
    await c.run();

    expect(c.out.some((l) => l.includes("oh-my-role") && l.includes("(built-in)"))).toBe(true);
    expect(c.out.some((l) => l.includes("custom"))).toBe(true);
  });

  it("emits the effective sources as JSON", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({ registries: [{ name: "custom", url: "https://github.com/acme/custom", ref: "dev" }] }),
      "utf-8",
    );

    const { registryListFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryListFn(true));
    await c.run();

    expect(c.out).toHaveLength(1);
    const parsed = JSON.parse(c.out[0]) as any[];
    expect(parsed.map((r) => r.name)).toEqual(["oh-my-role", "custom"]);
    expect(parsed[0].builtin).toBe(true);
    expect(parsed[0].default).toBe(true);
    expect(parsed[1]).toMatchObject({ builtin: false, ref: "dev" });
  });

  it("prints the opt-out hint when no source is configured", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), "registries: []\n", "utf-8");

    const { registryListFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryListFn());
    await c.run();

    expect(c.out).toEqual([
      "No role sources configured. Add one with 'rolebox registry add <url>'.",
    ]);
  });
});

describe("registry default", () => {
  it("makes a custom source the effective default", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
          { name: "custom", url: "https://github.com/acme/custom" },
        ],
      }),
      "utf-8",
    );

    const { registryDefaultFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryDefaultFn("custom"));
    await c.run();

    expect(c.out.some((l) => l.includes("'custom' is now the default source"))).toBe(true);

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(
      parsed.registries.filter((r: any) => r.default === true).map((r: any) => r.name),
    ).toEqual(["custom"]);

    const { defaultRegistry, effectiveRegistries } = await import("../../../src/cli/sources.ts");
    expect(defaultRegistry({ registries: parsed.registries })?.name).toBe("custom");
    // The built-in is demoted rather than silently staying the default.
    expect(effectiveRegistries({ registries: parsed.registries })[0].default).toBe(false);
  });

  it("flags the listed built-in entry and clears the custom default", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" },
          { name: "custom", url: "https://github.com/acme/custom", default: true },
        ],
      }),
      "utf-8",
    );

    const { registryDefaultFn } = await import("../../../src/cli/commands/registry.ts");
    await registryDefaultFn("oh-my-role");

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(
      parsed.registries.filter((r: any) => r.default === true).map((r: any) => r.name),
    ).toEqual(["oh-my-role"]);

    const { defaultRegistry } = await import("../../../src/cli/sources.ts");
    expect(defaultRegistry({ registries: parsed.registries })?.name).toBe("oh-my-role");
  });

  it("clears every file default when the built-in is not listed", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [{ name: "custom", url: "https://github.com/acme/custom", default: true }],
      }),
      "utf-8",
    );

    const { registryDefaultFn } = await import("../../../src/cli/commands/registry.ts");
    await registryDefaultFn("oh-my-role");

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(parsed.registries.some((r: any) => r.default === true)).toBe(false);

    const { defaultRegistry } = await import("../../../src/cli/sources.ts");
    expect(defaultRegistry({ registries: parsed.registries })?.name).toBe("oh-my-role");
  });

  it("rejects an unknown source", async () => {
    const { registryDefaultFn } = await import("../../../src/cli/commands/registry.ts");
    expect(() => registryDefaultFn("nonexistent")).toThrow(/Registry 'nonexistent' not found/);
  });
});

describe("registry remove (built-in and leftover roles)", () => {
  it("refuses the built-in even when the file never lists it", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({ registries: [{ name: "custom", url: "https://github.com/acme/custom" }] }),
      "utf-8",
    );

    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    expect(() => registryRemoveFn("oh-my-role")).toThrow(/Cannot remove default registry/);

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(parsed.registries).toHaveLength(1);
  });

  it("hints how to uninstall roles left behind by the removed source", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
          { name: "gone", url: "https://github.com/acme/gone" },
        ],
      }),
      "utf-8",
    );
    writeFileSync(
      join(configDir(), "rolebox.lock"),
      dump({
        version: 1,
        roles: [
          {
            role: "left-behind",
            registry: "gone",
            version: "1.0.0",
            installedAt: "2025-01-01T00:00:00Z",
            integrity: "sha256-x",
          },
        ],
      }),
      "utf-8",
    );

    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryRemoveFn("gone"));
    await c.run();

    expect(
      c.out.some((l) => l.includes("still installed") && l.includes("rolebox uninstall gone:<role>")),
    ).toBe(true);
  });

  it("removes a custom source that claims the default and restores the built-in", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({ registries: [{ name: "custom", url: "https://github.com/acme/custom", default: true }] }),
      "utf-8",
    );

    const { registryRemoveFn } = await import("../../../src/cli/commands/registry.ts");
    const c = capture(async () => registryRemoveFn("custom"));
    await c.run();

    expect(c.out.some((l) => l.includes("Removed"))).toBe(true);

    const parsed = load(readFileSync(configPath(), "utf-8")) as any;
    expect(parsed.registries).toEqual([]);

    const { defaultRegistry } = await import("../../../src/cli/sources.ts");
    expect(defaultRegistry({ registries: parsed.registries })).toBeUndefined();
  });
});

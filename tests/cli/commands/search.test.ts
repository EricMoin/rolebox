import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types";

const mockFetchManifest = mock();

const sampleManifest: RegistryManifest = {
  name: "oh-my-role",
  description: "Official role registry",
  url: "https://github.com/EricMoin/oh-my-role",
  roles: {
    "software-architect": {
      version: "1.0.0",
      description: "Software architect role for system design",
      tags: ["architecture", "design"],
    },
    "code-reviewer": {
      version: "2.0.0",
      description: "Expert code reviewer",
      tags: ["review", "quality"],
    },
    "devops-engineer": {
      version: "1.5.0",
      description: "DevOps and infrastructure engineer",
      tags: ["devops", "infrastructure", "ci-cd"],
    },
  },
};

const searchConfigDir = mkdtempSync(join(tmpdir(), "rolebox-search-mod-config-"));
process.env.XDG_CONFIG_HOME = searchConfigDir;

mock.module("../../../src/cli/paths", () => {
  function getDataDir(): string {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".local", "share", "rolebox");
  }
  function getConfigDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".config", "rolebox");
  }
  function getRolesDir(): string {
    return join(getDataDir(), "roles");
  }
  function getRolePath(registry: string, roleId: string, version: string): string {
    return join(getRolesDir(), registry, `${roleId}@${version}`);
  }
  function getSyncTarget(target: string): string {
    if (target === "opencode") {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return join(xdg, "opencode", "rolebox");
      return join(homedir(), ".config", "opencode", "rolebox");
    }
    throw new Error(`Unknown sync target: "${target}". Supported targets: opencode`);
  }
  return { getDataDir, getConfigDir, getRolesDir, getRolePath, getSyncTarget };
});

afterAll(() => {
  rmSync(searchConfigDir, { recursive: true, force: true });
});

let tmpConfigDir: string;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-search-config-"));

  process.env.XDG_CONFIG_HOME = tmpConfigDir;

  const configDir = join(tmpConfigDir, "rolebox");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    dump({
      registries: [
        { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
      ],
    }),
    "utf-8",
  );

  mock.module("../../../src/cli/registry-client", () => ({
    fetchRegistryManifest: mockFetchManifest,
  }));

  mockFetchManifest.mockImplementation(async () => sampleManifest);
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  mock.restore();
});

async function importSearch() {
  return await import("../../../src/cli/commands/search");
}

function captureOutput(fn: () => Promise<void>): { logs: string[]; warnings: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const warnings: string[] = [];

  const origLog = console.log;
  const origWarn = console.warn;

  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
    origLog.apply(console, args as any);
  };
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "));
    origWarn.apply(console, args as any);
  };

  return {
    logs,
    warnings,
    run: async () => {
      try { await fn(); } finally { console.log = origLog; console.warn = origWarn; }
    },
  };
}

describe("search", () => {
  it("finds matching roles by name", async () => {
    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => { await search("software", false); });
    await run();

    expect(logs.some((l) => l.includes("software-architect"))).toBe(true);
    expect(logs.some((l) => l.includes("code-reviewer"))).toBe(false);
  });

  it("matches against description and tags", async () => {
    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => { await search("devops", false); });
    await run();

    expect(logs.some((l) => l.includes("devops-engineer"))).toBe(true);
  });

  it("no-match produces helpful message", async () => {
    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => { await search("nonexistent", false); });
    await run();

    expect(logs.some((l) => l.includes("No roles matching"))).toBe(true);
    expect(logs.some((l) => l.includes("nonexistent"))).toBe(true);
  });

  it("no-args lists all available roles", async () => {
    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => { await search(undefined, false); });
    await run();

    expect(logs.some((l) => l.includes("software-architect"))).toBe(true);
    expect(logs.some((l) => l.includes("code-reviewer"))).toBe(true);
    expect(logs.some((l) => l.includes("devops-engineer"))).toBe(true);
  });

  it("registry fetch failure produces warning (not crash)", async () => {
    mockFetchManifest.mockImplementation(async () => {
      throw new Error("network error");
    });

    const { search } = await importSearch();
    const { warnings, run } = captureOutput(async () => { await search("anything", false); });
    await run();

    expect(warnings.some((w) => w.includes("Warning"))).toBe(true);
    expect(warnings.some((w) => w.includes("network error"))).toBe(true);
  });

  it("no roles and no query shows helpful message", async () => {
    mockFetchManifest.mockImplementation(async () => ({
      name: "empty-registry",
      description: "Empty",
      url: "https://example.com",
      roles: {},
    }));

    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => { await search(undefined, false); });
    await run();

    expect(logs.some((l) => l.includes("No roles found"))).toBe(true);
  });

  it("searches across multiple registries", async () => {
    const configDir = join(tmpConfigDir, "rolebox");
    writeFileSync(
      join(configDir, "config.yaml"),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" },
          { name: "community", url: "https://github.com/community/roles" },
        ],
      }),
      "utf-8",
    );

    mockFetchManifest.mockImplementation(async (registry: { name: string }) => {
      if (registry.name === "community") {
        return {
          name: "community",
          description: "Community registry",
          url: "https://github.com/community/roles",
          roles: {
            "react-expert": {
              version: "3.0.0",
              description: "React expert role",
              tags: ["react", "frontend"],
            },
          },
        };
      }
      return sampleManifest;
    });

    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => { await search(undefined, false); });
    await run();

    expect(logs.some((l) => l.includes("software-architect"))).toBe(true);
    expect(logs.some((l) => l.includes("react-expert"))).toBe(true);
    expect(logs.some((l) => l.includes("community"))).toBe(true);
  });
});

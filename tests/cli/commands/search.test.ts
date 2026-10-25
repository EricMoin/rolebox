import { beforeEach as resetBeforeEach } from "vitest";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types.ts";

const mockFetchManifest = vi.fn();

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

import { createPathsMockPayload } from "../../helpers/paths-mock.ts";

vi.doMock("../../../src/cli/paths", () => createPathsMockPayload({
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

  vi.doMock("../../../src/cli/registry-client", () => ({
    fetchRegistryManifest: mockFetchManifest,
    // The real helper the command prints through; the stub mirrors it so the
    // assertions see the same output the shipped code produces.
    escapeForDisplay: (value: unknown) =>
      String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) =>
        `\\x${ch.codePointAt(0)!.toString(16).padStart(2, "0").toUpperCase()}`,
      ),
  }));

  mockFetchManifest.mockImplementation(async () => sampleManifest);
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function importSearch() {
  return await import("../../../src/cli/commands/search.ts");
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

describe("search source selection", () => {
  const communityManifest: RegistryManifest = {
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

  function writeRegistries(
    registries: Array<{ name: string; url: string; default?: boolean; ref?: string }>,
  ): void {
    const configDir = join(tmpConfigDir, "rolebox");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), dump({ registries }), "utf-8");
  }

  function twoSources(): void {
    writeRegistries([
      { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
      { name: "community", url: "https://github.com/community/roles" },
    ]);
  }

  it("--registry fetches only the selected source", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "community" ? communityManifest : sampleManifest,
    );
    mockFetchManifest.mockClear();

    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => {
      await search(undefined, false, "community");
    });
    await run();

    expect(logs.some((l) => l.includes("react-expert"))).toBe(true);
    expect(logs.some((l) => l.includes("software-architect"))).toBe(false);
    expect(mockFetchManifest).toHaveBeenCalledTimes(1);
    expect(mockFetchManifest.mock.calls[0][0]).toMatchObject({ name: "community" });
  });

  it("--registry accepts a comma-separated list", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "community" ? communityManifest : sampleManifest,
    );
    mockFetchManifest.mockClear();

    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => {
      await search(undefined, false, "oh-my-role, community");
    });
    await run();

    expect(logs.some((l) => l.includes("software-architect"))).toBe(true);
    expect(logs.some((l) => l.includes("react-expert"))).toBe(true);
    expect(mockFetchManifest).toHaveBeenCalledTimes(2);
  });

  it("throws for an unknown --registry and names the configured sources", async () => {
    mockFetchManifest.mockClear();

    const { search } = await importSearch();

    await expect(search(undefined, false, "nope")).rejects.toThrow(
      /Registry 'nope' not found.*oh-my-role/,
    );
    expect(mockFetchManifest).not.toHaveBeenCalled();
  });

  it("notes a role published by more than one selected source", async () => {
    writeRegistries([
      { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
      { name: "community", url: "https://github.com/community/roles" },
    ]);
    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "community"
        ? {
            ...communityManifest,
            roles: {
              ...communityManifest.roles,
              "software-architect": {
                version: "9.0.0",
                description: "Software architect role",
                tags: ["architecture"],
              },
            },
          }
        : sampleManifest,
    );

    const { search } = await importSearch();
    const { logs, run } = captureOutput(async () => {
      await search("software", false);
    });
    await run();

    expect(
      logs.some((l) =>
        l.startsWith(
          "Note: 'software-architect' is published by 2 sources (oh-my-role, community)",
        ),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("rolebox install oh-my-role:software-architect"))).toBe(true);
  });

  it("warns that an all-failed search is unknown, not empty", async () => {
    mockFetchManifest.mockImplementation(async () => {
      throw new Error("network error");
    });

    const { search } = await importSearch();
    const { logs, warnings, run } = captureOutput(async () => {
      await search(undefined, false);
    });
    await run();

    expect(warnings.some((w) => w.includes("could not fetch any configured registry (1/1)"))).toBe(true);
    expect(warnings.some((w) => w.includes("result is unknown, not empty"))).toBe(true);
    expect(logs.some((l) => l.includes("No roles found in any registry."))).toBe(true);
  });

  it("keeps the empty-result message for a reachable but empty source", async () => {
    mockFetchManifest.mockImplementation(async () => ({
      name: "empty-registry",
      description: "Empty",
      url: "https://example.com",
      roles: {},
    }));

    const { search } = await importSearch();
    const { logs, warnings, run } = captureOutput(async () => {
      await search(undefined, false);
    });
    await run();

    expect(logs.some((l) => l.includes("No roles found in any registry."))).toBe(true);
    expect(warnings.some((w) => w.includes("result is unknown"))).toBe(false);
  });
});

resetBeforeEach(() => vi.resetModules());

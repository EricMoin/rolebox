import { beforeEach as resetBeforeEach } from "vitest";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { load, dump } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types.ts";

const updConfigDir = mkdtempSync(join(tmpdir(), "rolebox-update-mod-config-"));
const updDataDir = mkdtempSync(join(tmpdir(), "rolebox-update-mod-data-"));
process.env.XDG_CONFIG_HOME = updConfigDir;
process.env.XDG_DATA_HOME = updDataDir;

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
const { compareVersions } = await import("../../../src/cli/commands/update.ts");

afterAll(() => {
  rmSync(updConfigDir, { recursive: true, force: true });
  rmSync(updDataDir, { recursive: true, force: true });
});



const mockFetchManifest = vi.fn();
const mockDownloadRole = vi.fn();
const mockComputeIntegrity = vi.fn();

const sampleManifest: RegistryManifest = {
  name: "oh-my-role",
  description: "Official role registry",
  url: "https://github.com/EricMoin/oh-my-role",
  roles: {
    "software-architect": {
      version: "2.0.0",
      description: "Software architect role",
      tags: ["architecture"],
    },
    "code-reviewer": {
      version: "2.0.0",
      description: "Code reviewer role",
      tags: ["review"],
    },
  },
};

let tmpConfigDir: string;
let tmpDataDir: string;
let tmpExtractedDir: string;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-update-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-update-data-"));
  tmpExtractedDir = mkdtempSync(join(tmpdir(), "rolebox-update-extracted-"));

  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;

  vi.doMock("../../../src/cli/registry-client", async () => ({
    ...await vi.importActual<typeof import("../../../src/cli/registry-client.ts")>("../../../src/cli/registry-client.ts"),
    fetchRegistryManifest: mockFetchManifest,
    downloadRole: mockDownloadRole,
    computeIntegrity: mockComputeIntegrity,
  }));

  const unimplemented = (name: string) => () => {
    throw new Error(`${name} called without mock implementation`);
  };
  mockFetchManifest.mockImplementation(unimplemented("fetchRegistryManifest"));
  mockDownloadRole.mockImplementation(unimplemented("downloadRole"));
  mockComputeIntegrity.mockImplementation(unimplemented("computeIntegrity"));
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
  try {
    rmSync(tmpExtractedDir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

function createMockExtractedDir(roleId: string): string {
  const dir = join(tmpExtractedDir, `mock-${roleId}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.yaml"), `name: ${roleId}\ndescription: Test role\n`, "utf-8");
  return dir;
}

async function importUpdate() {
  return await import("../../../src/cli/commands/update.ts");
}

function setupConfig(registries: Array<{ name: string; url: string; default?: boolean }>) {
  const configDir = join(tmpConfigDir, "rolebox");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), dump({ registries }), "utf-8");
}

function setupLock(entries: Array<{
  role: string;
  registry: string;
  version: string;
  installedAt?: string;
  integrity?: string;
}>) {
  const configDir = join(tmpConfigDir, "rolebox");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "rolebox.lock"),
    dump({
      version: 1,
      roles: entries.map((e) => ({
        role: e.role,
        registry: e.registry,
        version: e.version,
        installedAt: e.installedAt ?? "2025-01-01T00:00:00.000Z",
        integrity: e.integrity ?? "sha256-abc123",
      })),
    }),
    "utf-8",
  );
}

function captureLogs(fn: () => Promise<void>): { logs: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: any[]) => {
    logs.push(args[0]);
    origLog.apply(console, args as any);
  };
  console.warn = (...args: any[]) => {
    logs.push(args[0]);
    origWarn.apply(console, args as any);
  };
  return {
    logs,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
        console.warn = origWarn;
      }
    },
  };
}

describe("compareVersions", () => {
  it("returns negative when a < b", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
  });

  it("returns 0 when versions are equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("detects major version difference", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9.9", "2.0.0")).toBeLessThan(0);
  });

  it("compares minor/patch correctly even with different digit counts", () => {
    expect(compareVersions("1.0.5", "1.0.10")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
  });

  it("treats missing version parts as 0", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("update", () => {
  it("updates role when newer version available in manifest", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([{ role: "software-architect", registry: "oh-my-role", version: "1.0.0" }]);

    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    await update(undefined, false);

    const expectedPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@2.0.0");
    expect(existsSync(expectedPath)).toBe(true);

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.roles[0].version).toBe("2.0.0");
  });

  it("does not update when already at latest version", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([{ role: "software-architect", registry: "oh-my-role", version: "2.0.0" }]);

    mockFetchManifest.mockImplementation(async () => sampleManifest);
    // downloadRole should NOT be called

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update(undefined, false);
    });
    await run();

    expect(logs.some((c) => c.includes("already up to date"))).toBe(true);
    expect(logs.some((c) => c.includes("Updated"))).toBe(false);
  });

  it("shows message when specific role is not installed", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update("nonexistent-role", false);
    });
    await run();

    expect(logs.some((c) => c.includes("not installed"))).toBe(true);
  });

  it("shows message when no roles are installed at all", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update(undefined, false);
    });
    await run();

    expect(logs.some((c) => c.includes("No roles installed"))).toBe(true);
  });

  it("updates only the specified role", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([
      { role: "software-architect", registry: "oh-my-role", version: "1.0.0" },
      { role: "code-reviewer", registry: "oh-my-role", version: "1.0.0" },
    ]);

    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    await update("software-architect", false);

    const archPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@2.0.0");
    expect(existsSync(archPath)).toBe(true);

    const reviewerPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "code-reviewer@2.0.0");
    expect(existsSync(reviewerPath)).toBe(false);

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    const arch = parsed.roles.find((r: any) => r.role === "software-architect");
    const reviewer = parsed.roles.find((r: any) => r.role === "code-reviewer");

    expect(arch.version).toBe("2.0.0");
    expect(reviewer.version).toBe("1.0.0");
  });

  it("updates all roles when no arg (mixed: some newer, some not)", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([
      { role: "software-architect", registry: "oh-my-role", version: "1.0.0" },
      { role: "code-reviewer", registry: "oh-my-role", version: "2.0.0" },
    ]);

    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("any-role"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update(undefined, false);
    });
    await run();

    expect(logs.some((c) => c.includes("Updated 1 roles"))).toBe(true);
    expect(logs.some((c) => c.includes("1 already up to date"))).toBe(true);
  });

  it("prints sync hint after successful update", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([{ role: "software-architect", registry: "oh-my-role", version: "1.0.0" }]);

    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update(undefined, false);
    });
    await run();

    expect(logs.some((c) => c.includes("rolebox sync"))).toBe(true);
  });

  it("skips role when registry not found in config", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([{ role: "old-role", registry: "deleted-registry", version: "1.0.0" }]);

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update(undefined, false);
    });
    await run();

    expect(logs.some((c) => c.includes("not found in config"))).toBe(true);
  });
});

describe("update across sources", () => {
  const customManifest: RegistryManifest = {
    name: "custom",
    description: "Custom registry",
    url: "https://github.com/custom/registry",
    roles: {
      "software-architect": {
        version: "3.0.0",
        description: "Software architect role",
        tags: ["architecture"],
      },
    },
  };

  function twoSources(): void {
    setupConfig([
      { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
      { name: "custom", url: "https://github.com/custom/registry" },
    ]);
  }

  function lockPath(): string {
    return join(tmpConfigDir, "rolebox", "rolebox.lock");
  }

  function versionsBySource(): Record<string, string> {
    const parsed = load(readFileSync(lockPath(), "utf-8")) as any;
    return Object.fromEntries(parsed.roles.map((r: any) => [r.registry, r.version]));
  }

  it("updates every installed copy when a bare role is named", async () => {
    twoSources();
    setupLock([
      { role: "software-architect", registry: "oh-my-role", version: "1.0.0" },
      { role: "software-architect", registry: "custom", version: "2.0.0" },
    ]);

    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "custom" ? customManifest : sampleManifest,
    );
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update("software-architect", false);
    });
    await run();

    expect(
      logs.some((l) => l.includes("✓ Updated software-architect (oh-my-role) from 1.0.0 to 2.0.0")),
    ).toBe(true);
    expect(
      logs.some((l) => l.includes("✓ Updated software-architect (custom) from 2.0.0 to 3.0.0")),
    ).toBe(true);

    expect(versionsBySource()).toEqual({ "oh-my-role": "2.0.0", custom: "3.0.0" });
    expect(
      existsSync(join(tmpDataDir, "rolebox", "roles", "custom", "software-architect@3.0.0")),
    ).toBe(true);
  });

  it("updates only the copy named by a registry:role spec", async () => {
    twoSources();
    setupLock([
      { role: "software-architect", registry: "oh-my-role", version: "1.0.0" },
      { role: "software-architect", registry: "custom", version: "2.0.0" },
    ]);

    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "custom" ? customManifest : sampleManifest,
    );
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update("custom:software-architect", false);
    });
    await run();

    expect(logs.some((l) => l.includes("✓ Updated software-architect (custom) from 2.0.0 to 3.0.0"))).toBe(true);
    expect(logs.some((l) => l.includes("Updated 1 roles"))).toBe(true);

    expect(versionsBySource()).toEqual({ "oh-my-role": "1.0.0", custom: "3.0.0" });
  });
});

resetBeforeEach(() => vi.resetModules());

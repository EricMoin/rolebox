import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { load, dump } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types";

const updConfigDir = mkdtempSync(join(tmpdir(), "rolebox-update-mod-config-"));
const updDataDir = mkdtempSync(join(tmpdir(), "rolebox-update-mod-data-"));
process.env.XDG_CONFIG_HOME = updConfigDir;
process.env.XDG_DATA_HOME = updDataDir;

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
  rmSync(updConfigDir, { recursive: true, force: true });
  rmSync(updDataDir, { recursive: true, force: true });
});

import { compareVersions } from "../../../src/cli/commands/update";

const mockFetchManifest = mock();
const mockDownloadRole = mock();
const mockComputeIntegrity = mock();

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

  mock.module("../../../src/cli/registry-client", () => ({
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
  return await import("../../../src/cli/commands/update");
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
    await update([]);

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
      await update([]);
    });
    await run();

    expect(logs.some((c) => c.includes("already up to date"))).toBe(true);
    expect(logs.some((c) => c.includes("Updated"))).toBe(false);
  });

  it("shows message when specific role is not installed", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update(["nonexistent-role"]);
    });
    await run();

    expect(logs.some((c) => c.includes("not installed"))).toBe(true);
  });

  it("shows message when no roles are installed at all", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update([]);
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
    await update(["software-architect"]);

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
      await update([]);
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
      await update([]);
    });
    await run();

    expect(logs.some((c) => c.includes("rolebox sync"))).toBe(true);
  });

  it("skips role when registry not found in config", async () => {
    setupConfig([{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }]);
    setupLock([{ role: "old-role", registry: "deleted-registry", version: "1.0.0" }]);

    const { update } = await importUpdate();
    const { logs, run } = captureLogs(async () => {
      await update([]);
    });
    await run();

    expect(logs.some((c) => c.includes("not found in config"))).toBe(true);
  });
});

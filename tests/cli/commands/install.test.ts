import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types";

const mockFetchManifest = mock();
const mockDownloadRole = mock();
const mockResolveVersion = mock();
const mockComputeIntegrity = mock();

import { parseRoleSpec } from "../../../src/cli/commands/install";

const sampleManifest: RegistryManifest = {
  name: "oh-my-role",
  description: "Official role registry",
  url: "https://github.com/EricMoin/oh-my-role",
  roles: {
    "software-architect": {
      version: "1.0.0",
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
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-install-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-install-data-"));
  tmpExtractedDir = mkdtempSync(join(tmpdir(), "rolebox-install-extracted-"));

  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;

  mock.module("../../../src/cli/registry-client", () => ({
    fetchRegistryManifest: mockFetchManifest,
    downloadRole: mockDownloadRole,
    resolveVersion: mockResolveVersion,
    computeIntegrity: mockComputeIntegrity,
  }));

  mock.module("../../../src/cli/paths", () => ({
    getDataDir: () => join(tmpDataDir, "rolebox"),
    getConfigDir: () => join(tmpConfigDir, "rolebox"),
    getRolesDir: () => join(tmpDataDir, "rolebox", "roles"),
    getRolePath: (registry: string, roleId: string, version: string) =>
      join(tmpDataDir, "rolebox", "roles", registry, `${roleId}@${version}`),
    getSyncTarget: (target: string) => {
      if (target === "opencode") return join(tmpConfigDir, "opencode", "rolebox");
      throw new Error(`Unknown sync target: "${target}"`);
    },
  }));

  const unimplemented = (name: string) => () => { throw new Error(`${name} called without mock implementation`); };
  mockFetchManifest.mockImplementation(unimplemented("fetchRegistryManifest"));
  mockDownloadRole.mockImplementation(unimplemented("downloadRole"));
  mockResolveVersion.mockImplementation(unimplemented("resolveVersion"));
  mockComputeIntegrity.mockImplementation(unimplemented("computeIntegrity"));
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
  try { rmSync(tmpExtractedDir, { recursive: true, force: true }); } catch { /* already gone */ }
});

function createMockExtractedDir(roleId: string): string {
  const dir = join(tmpExtractedDir, `mock-${roleId}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.yaml"), `name: ${roleId}\ndescription: Test role\n`, "utf-8");
  return dir;
}

async function importInstall() {
  return await import("../../../src/cli/commands/install");
}

function setupBasicMocks(version = "1.0.0", integrity = "sha256-abc123") {
  mockFetchManifest.mockImplementation(async () => sampleManifest);
  mockResolveVersion.mockImplementation(() => version);
  mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
  mockComputeIntegrity.mockImplementation(async () => integrity);
}

function captureLogs(fn: () => Promise<void>): { logs: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => { logs.push(args[0]); origLog.apply(console, args as any); };
  return {
    logs,
    run: async () => {
      try { await fn(); } finally { console.log = origLog; }
    },
  };
}

describe("parseRoleSpec", () => {
  it("parses plain role name", () => {
    expect(parseRoleSpec("software-architect")).toEqual({
      roleId: "software-architect",
    });
  });

  it("parses role with version", () => {
    expect(parseRoleSpec("software-architect@1.0.0")).toEqual({
      roleId: "software-architect",
      version: "1.0.0",
    });
  });

  it("parses registry:role", () => {
    expect(parseRoleSpec("my-registry:custom-role")).toEqual({
      registry: "my-registry",
      roleId: "custom-role",
    });
  });

  it("parses registry:role@version", () => {
    expect(parseRoleSpec("my-registry:role@2.0.0")).toEqual({
      registry: "my-registry",
      roleId: "role",
      version: "2.0.0",
    });
  });

  it("handles role with @ in name (uses only last @ as version separator)", () => {
    expect(parseRoleSpec("some@role@1.0.0")).toEqual({
      roleId: "some@role",
      version: "1.0.0",
    });
  });
});

describe("install", () => {
  it("installs a role at the correct path", async () => {
    setupBasicMocks();

    const { install } = await importInstall();
    await install("software-architect");

    const expectedPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@1.0.0");
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("updates the lock file after install", async () => {
    setupBasicMocks();

    const { install } = await importInstall();
    await install("software-architect");

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    expect(existsSync(lockPath)).toBe(true);

    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    expect(parsed.version).toBe(1);
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.roles[0].role).toBe("software-architect");
    expect(parsed.roles[0].registry).toBe("oh-my-role");
    expect(parsed.roles[0].version).toBe("1.0.0");
    expect(parsed.roles[0].integrity).toBe("sha256-abc123");
    expect(parsed.roles[0].installedAt).toBeDefined();
  });

  it("prints success and hint messages", async () => {
    setupBasicMocks();

    const { install } = await importInstall();
    const { logs, run } = captureLogs(async () => { await install("software-architect"); });
    await run();

    expect(logs.some((c) => c.includes("Installed"))).toBe(true);
    expect(logs.some((c) => c.includes("rolebox sync"))).toBe(true);
  });

  it("is idempotent for same version (already installed)", async () => {
    setupBasicMocks();

    const { install } = await importInstall();

    await install("software-architect");

    const { logs, run } = captureLogs(async () => { await install("software-architect"); });
    await run();

    expect(logs.some((c) => c.includes("already installed"))).toBe(true);
  });

  it("replaces old directory when installing different version", async () => {
    setupBasicMocks("1.0.0", "sha256-abc123");

    const { install } = await importInstall();

    await install("software-architect@1.0.0");

    const oldPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@1.0.0");
    expect(existsSync(oldPath)).toBe(true);

    mockResolveVersion.mockImplementation(() => "2.0.0");
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect-v2"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-def456");

    await install("software-architect@2.0.0");

    expect(existsSync(oldPath)).toBe(false);

    const newPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@2.0.0");
    expect(existsSync(newPath)).toBe(true);

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.roles[0].version).toBe("2.0.0");
    expect(parsed.roles[0].integrity).toBe("sha256-def456");
  });

  it("installs with explicit version from spec", async () => {
    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("code-reviewer"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-xyz");

    const { install } = await importInstall();
    await install("code-reviewer@2.0.0");

    const expectedPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "code-reviewer@2.0.0");
    expect(existsSync(expectedPath)).toBe(true);

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    expect(parsed.roles[0].version).toBe("2.0.0");
  });

  it("installs from a specific registry", async () => {
    const configDir = join(tmpConfigDir, "rolebox");
    mkdirSync(configDir, { recursive: true });
    const { dump } = await import("js-yaml");
    writeFileSync(
      join(configDir, "config.yaml"),
      dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" },
          { name: "custom-registry", url: "https://github.com/custom/registry" },
        ],
      }),
      "utf-8",
    );

    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("custom-role"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-custom");

    const { install } = await importInstall();
    await install("custom-registry:code-reviewer@2.0.0");

    const expectedPath = join(tmpDataDir, "rolebox", "roles", "custom-registry", "code-reviewer@2.0.0");
    expect(existsSync(expectedPath)).toBe(true);

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    expect(parsed.roles[0].registry).toBe("custom-registry");
  });

  it("throws error for non-existent role", async () => {
    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockResolveVersion.mockImplementation(() => {
      throw new Error('role "nonexistent-role" not found in registry "oh-my-role"');
    });

    const { install } = await importInstall();
    await expect(install("nonexistent-role")).rejects.toThrow(/not found/);
  });

  it("throws error for non-existent registry", async () => {
    const { install } = await importInstall();
    await expect(install("nonexistent-registry:some-role")).rejects.toThrow(/not found/);
  });

  it("throws error when no role spec is provided", async () => {
    const { install } = await importInstall();
    await expect(install("")).rejects.toThrow();
  });

  it("throws error for explicitly versioned role not in manifest", async () => {
    mockFetchManifest.mockImplementation(async () => sampleManifest);

    const { install } = await importInstall();
    await expect(install("missing-role@1.0.0")).rejects.toThrow(/not found/);
  });
});

import { describe, it, expect, mock, beforeEach, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dump, load } from "js-yaml";
import type { RegistryManifest } from "../../../src/cli/types.ts";

const mockFetchManifest = mock();
const mockDownloadRole = mock();
const mockResolveVersion = mock();
const mockComputeIntegrity = mock();

// The real registry-client is needed so the beforeEach stub can spread its full
// export surface while overriding only the install-path functions with the mocks
// below. Under `bun test --isolate` the module registry is per-file, so a static
// import resolves to the real on-disk module — no cache-busting required.
import * as realRegistryClient from "../../../src/cli/registry-client.ts";

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
    ...realRegistryClient,
    fetchRegistryManifest: mockFetchManifest,
    downloadRole: mockDownloadRole,
    resolveVersion: mockResolveVersion,
    computeIntegrity: mockComputeIntegrity,
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
  // Cache-bust so each call re-evaluates the command module against the mocks
  // registered in beforeEach rather than reusing a previously cached instance.
  return await import(
    "../../../src/cli/commands/install.ts?t=" + Date.now() + "-" + Math.random()
  );
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

function captureWarnings(fn: () => Promise<void>): { warnings: string[]; run: () => Promise<void> } {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(" ")); origWarn.apply(console, args as any); };
  return {
    warnings,
    run: async () => {
      try { await fn(); } finally { console.warn = origWarn; }
    },
  };
}

describe("parseRoleSpec", () => {
  let parseRoleSpec: (spec: string) => any;
  beforeAll(async () => {
    const mod = await importInstall();
    parseRoleSpec = mod.parseRoleSpec;
  });

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

  it("rolls back: a failed new-version install leaves the previous version intact", async () => {
    setupBasicMocks("1.0.0", "sha256-abc123");

    const { install } = await importInstall();
    await install("software-architect@1.0.0");

    const oldPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@1.0.0");
    expect(existsSync(oldPath)).toBe(true);

    // Now the new-version download fails.
    mockResolveVersion.mockImplementation(() => "2.0.0");
    mockDownloadRole.mockImplementation(async () => {
      throw new Error("download failed (simulated network error)");
    });

    await expect(install("software-architect@2.0.0")).rejects.toThrow(/download failed/);

    // Previous version intact; no partial new version; lock unchanged.
    expect(existsSync(oldPath)).toBe(true);
    const newPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@2.0.0");
    expect(existsSync(newPath)).toBe(false);

    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    const parsed = load(readFileSync(lockPath, "utf-8")) as any;
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.roles[0].version).toBe("1.0.0");
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

describe("install across sources", () => {
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
      { name: "custom", url: "https://github.com/custom/registry" },
    ]);
  }

  function customManifest(roleIds: string[]): RegistryManifest {
    return {
      name: "custom",
      description: "Custom registry",
      url: "https://github.com/custom/registry",
      roles: Object.fromEntries(
        roleIds.map((roleId) => [
          roleId,
          { version: "3.0.0", description: `${roleId} role`, tags: [] },
        ]),
      ),
    };
  }

  function lockPath(): string {
    return join(tmpConfigDir, "rolebox", "rolebox.lock");
  }

  it("installs a role published only by a non-default source", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "custom" ? customManifest(["custom-role"]) : sampleManifest,
    );
    mockResolveVersion.mockImplementation(() => "3.0.0");
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("custom-role"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-custom");
    // The doubles accumulate calls across tests in this file.
    mockFetchManifest.mockClear();

    const { install } = await importInstall();
    await install("custom-role");

    expect(existsSync(join(tmpDataDir, "rolebox", "roles", "custom", "custom-role@3.0.0"))).toBe(true);

    const parsed = load(readFileSync(lockPath(), "utf-8")) as any;
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.roles[0].registry).toBe("custom");

    // The default source was consulted first, then the one that publishes it.
    expect(mockFetchManifest.mock.calls.map((call: any[]) => call[0].name)).toEqual([
      "oh-my-role",
      "custom",
    ]);
  });

  it("prefers the default source when both publish the role", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "custom"
        ? customManifest(["software-architect"])
        : sampleManifest,
    );
    mockResolveVersion.mockImplementation(() => "1.0.0");
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");
    // The doubles accumulate calls across tests in this file.
    mockFetchManifest.mockClear();
    mockDownloadRole.mockClear();

    const { install } = await importInstall();
    await install("software-architect");

    expect(mockFetchManifest).toHaveBeenCalledTimes(1);
    expect(mockDownloadRole.mock.calls[0][0]).toMatchObject({ name: "oh-my-role" });

    const parsed = load(readFileSync(lockPath(), "utf-8")) as any;
    expect(parsed.roles[0].registry).toBe("oh-my-role");
  });

  it("warns about a source it could not reach when another one answers", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) => {
      if (registry.name === "oh-my-role") throw new Error("offline");
      return customManifest(["custom-role"]);
    });
    mockResolveVersion.mockImplementation(() => "3.0.0");
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("custom-role"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-custom");

    const { install } = await importInstall();
    const { warnings, run } = captureWarnings(async () => {
      await install("custom-role");
    });
    await run();

    // The skipped source is reported, not swallowed: the lookup was partial.
    expect(warnings.some((w) => w.includes('could not fetch registry "oh-my-role"'))).toBe(true);
    expect(warnings.some((w) => w.includes("offline"))).toBe(true);

    // ... and the role still installed from the source that answered.
    const parsed = load(readFileSync(lockPath(), "utf-8")) as any;
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.roles[0].registry).toBe("custom");
  });

  it("names the searched sources when no source publishes the role", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async () => customManifest([]));

    const { install } = await importInstall();
    await expect(install("ghost-role")).rejects.toThrow(
      /not found in any configured registry \(searched: oh-my-role, custom\)/,
    );
  });

  it("names the source it could not reach when another answered", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) => {
      if (registry.name === "custom") throw new Error("offline");
      return customManifest([]);
    });

    const { install } = await importInstall();
    await expect(install("ghost-role")).rejects.toThrow(
      /not found in any configured registry \(searched: oh-my-role\); could not reach: custom \(offline\)/,
    );
  });

  it("reports every unreachable source when none can be reached", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async () => {
      throw new Error("offline");
    });

    const { install } = await importInstall();
    await expect(install("ghost-role")).rejects.toThrow(
      /no configured registry could be reached \(oh-my-role: offline, custom: offline\)/,
    );
  });

  it("still installs from B when the role is already installed from A", async () => {
    twoSources();
    mockFetchManifest.mockImplementation(async (registry: { name: string }) =>
      registry.name === "custom"
        ? customManifest(["software-architect"])
        : sampleManifest,
    );
    mockResolveVersion.mockImplementation(() => "1.0.0");
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { install } = await importInstall();
    await install("software-architect");

    const { logs, run } = captureLogs(async () => {
      await install("custom:software-architect");
    });
    await run();

    expect(logs.some((l) => l.includes("already installed"))).toBe(false);
    expect(existsSync(join(tmpDataDir, "rolebox", "roles", "custom", "software-architect@1.0.0"))).toBe(true);

    const parsed = load(readFileSync(lockPath(), "utf-8")) as any;
    expect(parsed.roles.map((r: any) => r.registry).sort()).toEqual(["custom", "oh-my-role"]);
  });
});

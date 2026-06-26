import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dump } from "js-yaml";
import type { LockEntry } from "../../../src/cli/types";

let configTmp: string;
let dataTmp: string;
let logs: string[];
let warns: string[];
let errors: string[];

let origLog: typeof console.log;
let origWarn: typeof console.warn;
let origError: typeof console.error;

beforeEach(() => {
  configTmp = mkdtempSync(join(tmpdir(), "rolebox-sync-config-"));
  dataTmp = mkdtempSync(join(tmpdir(), "rolebox-sync-data-"));
  process.env.XDG_CONFIG_HOME = configTmp;
  process.env.XDG_DATA_HOME = dataTmp;

  // Override stale mock.module from other test files (e.g. install.test.ts)
  mock.module("../../../src/cli/paths", () => ({
    getDataDir: () => join(dataTmp, "rolebox"),
    getConfigDir: () => join(configTmp, "rolebox"),
    getRolesDir: () => join(dataTmp, "rolebox", "roles"),
    getRolePath: (registry: string, roleId: string, version: string) =>
      join(dataTmp, "rolebox", "roles", registry, `${roleId}@${version}`),
    getSyncTarget: (target: string) => {
      if (target === "opencode") return join(configTmp, "opencode", "rolebox");
      throw new Error(`Unknown sync target: "${target}". Supported targets: opencode`);
    },
  }));

  logs = [];
  warns = [];
  errors = [];
  origLog = console.log;
  origWarn = console.warn;
  origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.warn = (...args: unknown[]) => warns.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(configTmp, { recursive: true, force: true });
  rmSync(dataTmp, { recursive: true, force: true });
});

function lockDir(): string {
  return join(configTmp, "rolebox");
}

function setupLock(entries: LockEntry[]): void {
  const dir = lockDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rolebox.lock"),
    dump({ version: 1, roles: entries }),
    "utf-8",
  );
}

function roleSourcePath(registry: string, roleId: string, version: string): string {
  return join(dataTmp, "rolebox", "roles", registry, `${roleId}@${version}`);
}

function setupRoleSource(
  registry: string,
  roleId: string,
  version: string,
): string {
  const sourcePath = roleSourcePath(registry, roleId, version);
  mkdirSync(sourcePath, { recursive: true });
  writeFileSync(
    join(sourcePath, "role.yaml"),
    `name: ${roleId}\ndescription: Test role\n`,
    "utf-8",
  );
  return sourcePath;
}

function syncTarget(): string {
  return join(configTmp, "opencode", "rolebox");
}

async function importSync() {
  return await import("../../../src/cli/commands/sync");
}

describe("sync", () => {
  it("creates symlinks for installed roles", async () => {
    setupLock([
      {
        role: "test-role",
        registry: "hub",
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00Z",
        integrity: "sha256-abc",
      },
    ]);
    const sourcePath = setupRoleSource("hub", "test-role", "1.0.0");

    const { sync } = await importSync();
    await sync("opencode");

    const targetPath = join(syncTarget(), "test-role");
    expect(existsSync(targetPath)).toBe(true);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetPath)).toBe(sourcePath);
    expect(logs.some((l) => l.includes("Synced 1 roles"))).toBe(true);
  });

  it("skips manual directories with warning", async () => {
    setupLock([
      {
        role: "manual-role",
        registry: "hub",
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00Z",
        integrity: "sha256-abc",
      },
    ]);
    setupRoleSource("hub", "manual-role", "1.0.0");

    const manualDir = join(syncTarget(), "manual-role");
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, "role.yaml"), "name: manual\n", "utf-8");

    const { sync } = await importSync();
    await sync("opencode");

    expect(lstatSync(manualDir).isDirectory()).toBe(true);
    expect(lstatSync(manualDir).isSymbolicLink()).toBe(false);
    expect(warns.some((w) => w.includes("regular directory"))).toBe(true);
    expect(logs.some((l) => l.includes("1 skipped"))).toBe(true);
  });

  it("removes stale broken symlinks", async () => {
    setupLock([]);

    const targetDir = syncTarget();
    mkdirSync(targetDir, { recursive: true });
    symlinkSync("/nonexistent/dead/path", join(targetDir, "broken-link"));

    const { sync } = await importSync();
    await sync("opencode");

    expect(existsSync(join(targetDir, "broken-link"))).toBe(false);
    expect(logs.some((l) => l.includes("1 cleaned"))).toBe(true);
  });

  it("is idempotent — running twice produces same result", async () => {
    setupLock([
      {
        role: "idem-role",
        registry: "hub",
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00Z",
        integrity: "sha256-abc",
      },
    ]);
    setupRoleSource("hub", "idem-role", "1.0.0");

    const { sync } = await importSync();
    await sync("opencode");

    logs = [];
    warns = [];
    errors = [];
    await sync("opencode");

    expect(logs.some((l) => l.includes("Synced 1 roles"))).toBe(true);
    expect(warns).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("errors on unknown target", async () => {
    const { sync } = await importSync();
    await expect(sync("unknown-target")).rejects.toThrow(/Unknown sync target/);
  });

  it("warns when source directory is missing", async () => {
    setupLock([
      {
        role: "missing-role",
        registry: "hub",
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00Z",
        integrity: "sha256-abc",
      },
    ]);

    const { sync } = await importSync();
    await sync("opencode");

    expect(
      warns.some((w) => w.includes("source for 'missing-role' not found")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("1 skipped"))).toBe(true);
    expect(logs.some((l) => l.includes("Synced 0 roles"))).toBe(true);
  });

  it("handles empty lock file gracefully — prints 0 roles", async () => {
    setupLock([]);

    const { sync } = await importSync();
    await sync("opencode");

    expect(logs.some((l) => l.includes("Synced 0 roles"))).toBe(true);
    expect(warns).toHaveLength(0);
  });

  it("defaults target to opencode when args is empty", async () => {
    setupLock([
      {
        role: "default-role",
        registry: "hub",
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00Z",
        integrity: "sha256-abc",
      },
    ]);
    const sourcePath = setupRoleSource("hub", "default-role", "1.0.0");

    const { sync } = await importSync();
    await sync("opencode");

    const targetPath = join(syncTarget(), "default-role");
    expect(existsSync(targetPath)).toBe(true);
    expect(readlinkSync(targetPath)).toBe(sourcePath);
    expect(logs.some((l) => l.includes("Synced 1 roles to opencode"))).toBe(
      true,
    );
  });

  it("keeps valid symlinks that are not in the lock", async () => {
    setupLock([]);

    const targetDir = syncTarget();
    mkdirSync(targetDir, { recursive: true });
    const manualSource = join(dataTmp, "manual-source");
    mkdirSync(manualSource, { recursive: true });
    symlinkSync(manualSource, join(targetDir, "manual-symlink"));

    const { sync } = await importSync();
    await sync("opencode");

    expect(existsSync(join(targetDir, "manual-symlink"))).toBe(true);
  });
});

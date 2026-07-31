import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirSymlink } from "../../helpers/symlink";

async function importUninstall() {
  // Cache-bust so each call re-evaluates the command module against the mocks
  // registered in beforeEach rather than reusing a previously cached instance.
  return await import(
    "../../../src/cli/commands/uninstall.ts?t=" + Date.now() + "-" + Math.random()
  );
}

let tmpConfigDir: string;
let tmpDataDir: string;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-uninstall-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-uninstall-data-"));
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function configDir(): string {
  return join(tmpConfigDir, "rolebox");
}

function dataDir(): string {
  return join(tmpDataDir, "rolebox");
}

function syncTargetDir(): string {
  const xdgConfig = tmpConfigDir;
  return join(xdgConfig, "opencode", "rolebox");
}

async function installRole(
  roleId: string,
  registry: string,
  version: string,
  createDir = true,
): Promise<string> {
  const { addToLock } = await import("../../../src/cli/config");
  addToLock({
    role: roleId,
    registry,
    version,
    installedAt: "2024-01-01T00:00:00Z",
    integrity: "sha256-test",
  });

  const { getRolePath } = await import("../../../src/cli/paths");
  const rolePath = getRolePath(registry, roleId, version);

  if (createDir) {
    mkdirSync(rolePath, { recursive: true });
    writeFileSync(join(rolePath, "role.yaml"), "name: test-role\n");
  }

  return rolePath;
}

describe("uninstall", () => {
  it("removes role directory from disk", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(existsSync(rolePath)).toBe(false);
  });

  it("removes lock entry", async () => {
    await installRole("my-role", "my-registry", "1.0.0");

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    const { findInLock } = await import("../../../src/cli/config");
    expect(findInLock("my-role")).toBeUndefined();
  });

  it("removes symlink from sync target if present", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");

    const targetPath = join(syncTargetDir(), "my-role");
    mkdirSync(syncTargetDir(), { recursive: true });
    createDirSymlink(rolePath, targetPath);

    expect(existsSync(targetPath)).toBe(true);

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(existsSync(targetPath)).toBe(false);
  });

  it("does not remove non-symlinked (manual) directories in sync target", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");

    const manualPath = join(syncTargetDir(), "manual-role");
    mkdirSync(syncTargetDir(), { recursive: true });
    mkdirSync(manualPath, { recursive: true });
    writeFileSync(join(manualPath, "role.yaml"), "name: manual-role\n");

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(existsSync(manualPath)).toBe(true);
    expect(existsSync(rolePath)).toBe(false);
  });

  it("handles lock-role inconsistency (dir already gone)", async () => {
    await installRole("my-role", "my-registry", "1.0.0", false);

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    const { findInLock } = await import("../../../src/cli/config");
    expect(findInLock("my-role")).toBeUndefined();
  });

  it("prints error and exits with code 1 when role is not installed", async () => {
    const { uninstall } = await importUninstall();

    await expect(uninstall("nonexistent")).rejects.toThrow("Role 'nonexistent' is not installed");
  });

  it("rejects a roleId that would escape the roles dir (path traversal) and does not delete", async () => {
    const { addToLock } = await import("../../../src/cli/config");
    addToLock({
      role: "../evil",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-test",
    });

    // getRolePath sanitization throws before any rmSync can run.
    const { uninstall } = await importUninstall();
    await expect(uninstall("../evil")).rejects.toThrow(/\.\./);

    // Nothing should have been deleted outside the roles dir.
    expect(existsSync(join(tmpdir(), "evil"))).toBe(false);
  });
});

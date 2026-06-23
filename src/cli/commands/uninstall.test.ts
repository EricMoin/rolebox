import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { rmSync, mkdirSync, existsSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  const { addToLock } = await import("../config");
  addToLock({
    role: roleId,
    registry,
    version,
    installedAt: "2024-01-01T00:00:00Z",
    integrity: "sha256-test",
  });

  const { getRolePath } = await import("../paths");
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

    const { uninstall } = await import("./uninstall");
    await uninstall(["my-role"]);

    expect(existsSync(rolePath)).toBe(false);
  });

  it("removes lock entry", async () => {
    await installRole("my-role", "my-registry", "1.0.0");

    const { uninstall } = await import("./uninstall");
    await uninstall(["my-role"]);

    const { findInLock } = await import("../config");
    expect(findInLock("my-role")).toBeUndefined();
  });

  it("removes symlink from sync target if present", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");

    const targetPath = join(syncTargetDir(), "my-role");
    mkdirSync(syncTargetDir(), { recursive: true });
    symlinkSync(rolePath, targetPath);

    expect(existsSync(targetPath)).toBe(true);

    const { uninstall } = await import("./uninstall");
    await uninstall(["my-role"]);

    expect(existsSync(targetPath)).toBe(false);
  });

  it("does not remove non-symlinked (manual) directories in sync target", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");

    const manualPath = join(syncTargetDir(), "manual-role");
    mkdirSync(syncTargetDir(), { recursive: true });
    mkdirSync(manualPath, { recursive: true });
    writeFileSync(join(manualPath, "role.yaml"), "name: manual-role\n");

    const { uninstall } = await import("./uninstall");
    await uninstall(["my-role"]);

    expect(existsSync(manualPath)).toBe(true);
    expect(existsSync(rolePath)).toBe(false);
  });

  it("handles lock-role inconsistency (dir already gone)", async () => {
    await installRole("my-role", "my-registry", "1.0.0", false);

    const { uninstall } = await import("./uninstall");
    await uninstall(["my-role"]);

    const { findInLock } = await import("../config");
    expect(findInLock("my-role")).toBeUndefined();
  });

  it("prints error and exits with code 1 when role is not installed", async () => {
    const { uninstall } = await import("./uninstall");

    const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await uninstall(["nonexistent"]);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe("exit 1");
    }

    expect(errorSpy).toHaveBeenCalledWith("Role 'nonexistent' is not installed");

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

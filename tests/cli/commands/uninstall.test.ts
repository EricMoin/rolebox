import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirSymlink, isSymlink } from "../../helpers/symlink.ts";

async function importUninstall() {
  // Cache-bust so each call re-evaluates the command module against the mocks
  // registered in beforeEach rather than reusing a previously cached instance.
  return await import(
    "../../../src/cli/commands/uninstall.ts?t=" + Date.now() + "-" + Math.random()
  );
}

let tmpConfigDir: string;
let tmpDataDir: string;
let savedPiDir: string | undefined;
let savedDshHome: string | undefined;
let savedCodexHome: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-uninstall-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-uninstall-data-"));
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;
  // Isolate the pi / dsh / codex sync targets too — uninstall sweeps symlinks
  // across ALL platform sync targets, and without these overrides it would
  // touch the real ~/.pi/agent/rolebox, ~/.dsh/rolebox and ~/.codex/rolebox on
  // the developer's machine.
  savedPiDir = process.env.PI_CODING_AGENT_DIR;
  savedDshHome = process.env.DSH_HOME;
  savedCodexHome = process.env.CODEX_HOME;
  process.env.PI_CODING_AGENT_DIR = join(tmpConfigDir, "pi-agent");
  process.env.DSH_HOME = join(tmpConfigDir, "dsh-home");
  process.env.CODEX_HOME = join(tmpConfigDir, "codex-home");
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedPiDir;
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
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
  const { addToLock } = await import("../../../src/cli/config.ts");
  addToLock({
    role: roleId,
    registry,
    version,
    installedAt: "2024-01-01T00:00:00Z",
    integrity: "sha256-test",
  });

  const { getRolePath } = await import("../../../src/cli/paths.ts");
  const rolePath = getRolePath(registry, roleId, version);

  if (createDir) {
    mkdirSync(rolePath, { recursive: true });
    writeFileSync(join(rolePath, "role.yaml"), "name: test-role\n");
  }

  return rolePath;
}

describe("uninstall", () => {
  it("isolates the codex sync target inside the temporary config dir", async () => {
    // Regression guard: uninstall sweeps every sync target, so CODEX_HOME must
    // resolve under the temp dir instead of the developer's real ~/.codex.
    const { getSyncTarget } = await import("../../../src/cli/paths.ts");
    expect(getSyncTarget("codex")).toBe(join(tmpConfigDir, "codex-home", "rolebox"));
  });

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

    const { findInLock } = await import("../../../src/cli/config.ts");
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

    const { findInLock } = await import("../../../src/cli/config.ts");
    expect(findInLock("my-role")).toBeUndefined();
  });

  it("prints error and exits with code 1 when role is not installed", async () => {
    const { uninstall } = await importUninstall();

    await expect(uninstall("nonexistent")).rejects.toThrow("Role 'nonexistent' is not installed");
  });

  it("rejects a roleId that would escape the roles dir (path traversal) and does not delete", async () => {
    const { addToLock } = await import("../../../src/cli/config.ts");
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

describe("uninstall across sources", () => {
  it("removes only the copy selected by a registry:role spec", async () => {
    const rolePathA = await installRole("my-role", "oh-my-role", "1.0.0");
    const rolePathB = await installRole("my-role", "custom", "2.0.0");

    const { uninstall } = await importUninstall();
    await uninstall("custom:my-role");

    expect(existsSync(rolePathB)).toBe(false);
    expect(existsSync(rolePathA)).toBe(true);

    const { findAllInLock } = await import("../../../src/cli/config.ts");
    expect(findAllInLock("my-role").map((entry) => entry.registry)).toEqual(["oh-my-role"]);
  });

  it("refuses to guess when the role is installed from more than one source", async () => {
    const rolePathA = await installRole("my-role", "oh-my-role", "1.0.0");
    const rolePathB = await installRole("my-role", "custom", "2.0.0");

    const { uninstall } = await importUninstall();
    const error = await uninstall("my-role").catch((err: Error) => err);

    expect(error.message).toContain(
      "Role 'my-role' is installed from more than one source: oh-my-role, custom",
    );
    expect(error.message).toContain("rolebox uninstall oh-my-role:my-role");

    // Nothing was removed: the choice is the user's.
    expect(existsSync(rolePathA)).toBe(true);
    expect(existsSync(rolePathB)).toBe(true);
  });

  it("treats a spec naming a source with no installed copy as not installed", async () => {
    await installRole("my-role", "oh-my-role", "1.0.0");

    const { uninstall } = await importUninstall();
    await expect(uninstall("custom:my-role")).rejects.toThrow(/not installed/);
  });
});

describe("uninstall symlink scoping", () => {
  it("keeps every other role's links resolving when one role is uninstalled", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");
    const otherPaths = [
      await installRole("other-role-a", "my-registry", "1.0.0"),
      await installRole("other-role-b", "my-registry", "1.0.0"),
    ];

    mkdirSync(syncTargetDir(), { recursive: true });
    createDirSymlink(rolePath, join(syncTargetDir(), "my-role"));
    createDirSymlink(otherPaths[0], join(syncTargetDir(), "other-role-a"));
    createDirSymlink(otherPaths[1], join(syncTargetDir(), "other-role-b"));

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(existsSync(join(syncTargetDir(), "my-role"))).toBe(false);
    for (const [index, name] of ["other-role-a", "other-role-b"].entries()) {
      const linkPath = join(syncTargetDir(), name);
      expect(isSymlink(linkPath)).toBe(true);
      expect(realpathSync(linkPath)).toBe(realpathSync(otherPaths[index]));
    }
  });

  it("keeps another source's copy of the same role id and removes only that copy's link", async () => {
    const rolePathA = await installRole("my-role", "oh-my-role", "1.0.0");
    const rolePathB = await installRole("my-role", "custom", "2.0.0");

    // Both sources sync to the same link name; this link points at the copy that
    // is NOT being removed, so it must survive the uninstall and still resolve.
    mkdirSync(syncTargetDir(), { recursive: true });
    const linkPath = join(syncTargetDir(), "my-role");
    createDirSymlink(rolePathB, linkPath);

    const { uninstall } = await importUninstall();
    await uninstall("oh-my-role:my-role");

    expect(existsSync(rolePathA)).toBe(false);
    expect(isSymlink(linkPath)).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(rolePathB));

    // Uninstalling the second copy afterwards does remove its own link.
    await uninstall("custom:my-role");
    expect(isSymlink(linkPath)).toBe(false);
  });

  it("removes a dangling link that pointed at the removed role directory", async () => {
    // The role directory is already gone; only the lock entry and the (now
    // dangling) sync link are left behind.
    const rolePath = await installRole("my-role", "my-registry", "1.0.0", false);

    mkdirSync(syncTargetDir(), { recursive: true });
    const linkPath = join(syncTargetDir(), "my-role");
    createDirSymlink(rolePath, linkPath);

    expect(isSymlink(linkPath)).toBe(true);
    expect(existsSync(linkPath)).toBe(false);

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(isSymlink(linkPath)).toBe(false);
    const { findInLock } = await import("../../../src/cli/config.ts");
    expect(findInLock("my-role")).toBeUndefined();
  });

  it("leaves symlinks that point outside the roles tree alone", async () => {
    await installRole("my-role", "my-registry", "1.0.0");

    const outsideDir = mkdtempSync(join(tmpdir(), "rolebox-outside-"));
    const handMadeTarget = join(outsideDir, "hand-made");
    mkdirSync(handMadeTarget, { recursive: true });

    mkdirSync(syncTargetDir(), { recursive: true });
    const handMadeLink = join(syncTargetDir(), "hand-made");
    createDirSymlink(handMadeTarget, handMadeLink);
    // A link to the registry directory that CONTAINS the removed role points
    // outside the role directory, not inside it.
    const containerLink = join(syncTargetDir(), "registry-dir");
    createDirSymlink(join(dataDir(), "roles", "my-registry"), containerLink);

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(isSymlink(handMadeLink)).toBe(true);
    expect(realpathSync(handMadeLink)).toBe(realpathSync(handMadeTarget));
    expect(isSymlink(containerLink)).toBe(true);

    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("removes the role's link in every sync target and keeps an unrelated role's link", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");
    const otherPath = await installRole("other-role", "my-registry", "1.0.0");

    const { getSyncTarget } = await import("../../../src/cli/paths.ts");
    const targets = ["opencode", "pi", "dsh", "codex"] as const;
    for (const target of targets) {
      const targetDir = getSyncTarget(target);
      mkdirSync(targetDir, { recursive: true });
      createDirSymlink(rolePath, join(targetDir, "my-role"));
      createDirSymlink(otherPath, join(targetDir, "other-role"));
    }

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    for (const target of targets) {
      const targetDir = getSyncTarget(target);
      expect(isSymlink(join(targetDir, "my-role"))).toBe(false);
      const otherLink = join(targetDir, "other-role");
      expect(isSymlink(otherLink)).toBe(true);
      expect(realpathSync(otherLink)).toBe(realpathSync(otherPath));
    }
  });

  it("removes a link that points inside the removed role directory", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");
    mkdirSync(join(rolePath, "skills"), { recursive: true });

    mkdirSync(syncTargetDir(), { recursive: true });
    const linkPath = join(syncTargetDir(), "my-role-skills");
    createDirSymlink(join(rolePath, "skills"), linkPath);

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(isSymlink(linkPath)).toBe(false);
  });

  it("does not delete a real directory sitting at the removed role's target path", async () => {
    const rolePath = await installRole("my-role", "my-registry", "1.0.0");

    const manualPath = join(syncTargetDir(), "my-role");
    mkdirSync(manualPath, { recursive: true });
    writeFileSync(join(manualPath, "role.yaml"), "name: my-role\n");

    const { uninstall } = await importUninstall();
    await uninstall("my-role");

    expect(existsSync(manualPath)).toBe(true);
    expect(existsSync(join(manualPath, "role.yaml"))).toBe(true);
    expect(existsSync(rolePath)).toBe(false);
  });
});

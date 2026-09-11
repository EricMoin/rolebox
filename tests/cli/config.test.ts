import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dump } from "js-yaml";
import type { RoleboxConfig, LockEntry } from "../../src/cli/types";
import type { PromptApi } from "../../src/cli/pick.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-config-test-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function configDir(): string {
  return join(tmpDir, "rolebox");
}

function configPath(): string {
  return join(configDir(), "config.yaml");
}

function lockPath(): string {
  return join(configDir(), "rolebox.lock");
}

// Re-import after env setup so getConfigDir sees our XDG_CONFIG_HOME
async function importConfig() {
  return await import("../../src/cli/config");
}

describe("loadConfig", () => {
  it("creates and returns default config when config.yaml does not exist", async () => {
    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.registries).toHaveLength(1);
    expect(config.registries[0].name).toBe("oh-my-role");
    expect(config.registries[0].url).toBe("https://github.com/EricMoin/oh-my-role");
    expect(config.registries[0].default).toBe(true);
  });

  it("writes default config to disk when file does not exist", async () => {
    const { loadConfig } = await importConfig();
    loadConfig();

    const raw = readFileSync(configPath(), "utf-8");
    expect(raw).toContain("oh-my-role");
    expect(raw).toContain("https://github.com/EricMoin/oh-my-role");
  });

  it("reads existing config file", async () => {
    const customConfig: RoleboxConfig = {
      registries: [
        { name: "my-registry", url: "https://example.com" },
      ],
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir(), { recursive: true });
    await writeFile(configPath(), dump(customConfig), "utf-8");

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.registries).toHaveLength(1);
    expect(config.registries[0].name).toBe("my-registry");
    expect(config.registries[0].url).toBe("https://example.com");
    expect(config.registries[0].default).toBeUndefined();
  });
});

describe("saveConfig", () => {
  it("round-trips config through save and load", async () => {
    const { saveConfig, loadConfig } = await importConfig();

    const config: RoleboxConfig = {
      registries: [
        { name: "a", url: "https://a.dev" },
        { name: "b", url: "https://b.dev", default: false },
        { name: "c", url: "https://c.dev", default: true },
      ],
    };

    saveConfig(config);
    const loaded = loadConfig();

    expect(loaded.registries).toHaveLength(3);
    expect(loaded.registries[0]).toEqual(config.registries[0]);
    expect(loaded.registries[1]).toEqual(config.registries[1]);
    expect(loaded.registries[2]).toEqual(config.registries[2]);
  });

  it("writes valid YAML to disk", async () => {
    const { saveConfig } = await importConfig();

    const config: RoleboxConfig = {
      registries: [
        { name: "test", url: "https://test.dev", default: true },
      ],
    };

    saveConfig(config);
    const raw = readFileSync(configPath(), "utf-8");

    expect(raw).toContain("name: test");
    expect(raw).toContain("url: https://test.dev");
    expect(raw).toContain("default: true");
  });
});

describe("loadLock", () => {
  it("returns empty LockFile when rolebox.lock does not exist", async () => {
    const { loadLock } = await importConfig();
    const lock = loadLock();

    expect(lock.version).toBe(1);
    expect(lock.roles).toEqual([]);
  });

  it("does NOT create lock file when it does not exist (unlike loadConfig)", async () => {
    const { loadLock } = await importConfig();
    loadLock();

    const { existsSync } = await import("node:fs");
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("addToLock", () => {
  it("adds entry to empty lock file", async () => {
    const { addToLock, loadLock } = await importConfig();

    const entry: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc123",
    };

    const lock = addToLock(entry);
    expect(lock.roles).toHaveLength(1);
    expect(lock.roles[0]).toEqual(entry);

    const reloaded = loadLock();
    expect(reloaded.roles[0]).toEqual(entry);
  });

  it("persists entry to disk", async () => {
    const { addToLock } = await importConfig();

    const entry: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc123",
    };

    addToLock(entry);

    const raw = readFileSync(lockPath(), "utf-8");
    expect(raw).toContain("my-role");
    expect(raw).toContain("oh-my-role");
    expect(raw).toContain("1.0.0");
  });

  it("updates existing entry when role+registry match", async () => {
    const { addToLock, loadLock } = await importConfig();

    const original: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-old",
    };

    addToLock(original);

    const updated: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "2.0.0",
      installedAt: "2024-06-01T00:00:00Z",
      integrity: "sha256-new",
    };

    const lock = addToLock(updated);
    expect(lock.roles).toHaveLength(1);
    expect(lock.roles[0].version).toBe("2.0.0");
    expect(lock.roles[0].integrity).toBe("sha256-new");

    const reloaded = loadLock();
    expect(reloaded.roles).toHaveLength(1);
  });

  it("adds separate entry when same roleId but different registry", async () => {
    const { addToLock, loadLock } = await importConfig();

    const entry1: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-a",
    };

    const entry2: LockEntry = {
      role: "my-role",
      registry: "custom-registry",
      version: "2.0.0",
      installedAt: "2024-02-01T00:00:00Z",
      integrity: "sha256-b",
    };

    addToLock(entry1);
    addToLock(entry2);

    const lock = loadLock();
    expect(lock.roles).toHaveLength(2);
  });
});

describe("removeFromLock", () => {
  it("removes matching entry", async () => {
    const { addToLock, removeFromLock, loadLock } = await importConfig();

    const entry: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    };

    addToLock(entry);
    const lock = removeFromLock("my-role", "oh-my-role");

    expect(lock.roles).toEqual([]);

    const reloaded = loadLock();
    expect(reloaded.roles).toEqual([]);
  });

  it("does not remove entry with different roleId", async () => {
    const { addToLock, removeFromLock, loadLock } = await importConfig();

    const entry: LockEntry = {
      role: "keep-me",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    };

    addToLock(entry);
    removeFromLock("other-role", "oh-my-role");

    const lock = loadLock();
    expect(lock.roles).toHaveLength(1);
    expect(lock.roles[0].role).toBe("keep-me");
  });

  it("does not remove entry with same roleId but different registry", async () => {
    const { addToLock, removeFromLock, loadLock } = await importConfig();

    const entry: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    };

    addToLock(entry);
    removeFromLock("my-role", "other-registry");

    const lock = loadLock();
    expect(lock.roles).toHaveLength(1);
  });

  it("handles removal from empty lock gracefully", async () => {
    const { removeFromLock } = await importConfig();

    const lock = removeFromLock("nonexistent", "any-registry");

    expect(lock.roles).toEqual([]);
  });
});

describe("findInLock", () => {
  it("finds entry by roleId", async () => {
    const { addToLock, findInLock } = await importConfig();

    const entry: LockEntry = {
      role: "my-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    };

    addToLock(entry);

    const found = findInLock("my-role");
    expect(found).toBeDefined();
    expect(found!.role).toBe("my-role");
    expect(found!.registry).toBe("oh-my-role");
  });

  it("returns undefined for non-existent role", async () => {
    const { findInLock } = await importConfig();

    const found = findInLock("nonexistent");
    expect(found).toBeUndefined();
  });

  it("finds by roleId across any registry", async () => {
    const { addToLock, findInLock } = await importConfig();

    const entry: LockEntry = {
      role: "my-role",
      registry: "custom-registry",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-xyz",
    };

    addToLock(entry);

    const found = findInLock("my-role");
    expect(found).toBeDefined();
    expect(found!.registry).toBe("custom-registry");
  });

  it("returns first match when multiple registries have same roleId", async () => {
    const { addToLock, findInLock } = await importConfig();

    addToLock({
      role: "dup-role",
      registry: "registry-a",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-a",
    });

    addToLock({
      role: "dup-role",
      registry: "registry-b",
      version: "2.0.0",
      installedAt: "2024-02-01T00:00:00Z",
      integrity: "sha256-b",
    });

    const found = findInLock("dup-role");
    expect(found).toBeDefined();
    expect(found!.registry).toBe("registry-a");
  });
});

describe("ensureConfigDir", () => {
  it("creates config directory if it does not exist", async () => {
    const { ensureConfigDir } = await importConfig();
    const { existsSync } = await import("node:fs");

    expect(existsSync(configDir())).toBe(false);

    ensureConfigDir();

    expect(existsSync(configDir())).toBe(true);
  });

  it("does not throw when directory already exists", async () => {
    const { ensureConfigDir } = await importConfig();
    const { mkdirSync } = await import("node:fs");

    mkdirSync(configDir(), { recursive: true });
    expect(() => ensureConfigDir()).not.toThrow();
  });
});

describe("getConfigPath", () => {
  it("returns path ending in config.yaml inside config dir", async () => {
    const { getConfigPath } = await importConfig();
    const path = getConfigPath();
    expect(path).toBe(join(configDir(), "config.yaml"));
  });
});

describe("getLockPath", () => {
  it("returns path ending in rolebox.lock inside config dir", async () => {
    const { getLockPath } = await importConfig();
    const path = getLockPath();
    expect(path).toBe(join(configDir(), "rolebox.lock"));
  });
});

// ── Sync-target resolution (platform parity) ─────────────────────
//
// These cases exercise the registry-backed `--target` contract: `dsh` resolves
// under `$DSH_HOME`, an unknown id fails with the supported-target list, and
// the config command's omitted `--target` still defaults to opencode. All
// filesystem access is redirected through the XDG_CONFIG_HOME / DSH_HOME env
// seams into a tmpdir — the real home is never touched.

function createFakePrompts(picked: string) {
  const CANCEL = Symbol("clack:cancel");
  const select = mock(async () => picked);
  const prompts: PromptApi = {
    intro: () => {},
    outro: () => {},
    cancel: () => {},
    select: select as unknown as PromptApi["select"],
    confirm: (async () => true) as unknown as PromptApi["confirm"],
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    isCancel: (v: unknown) => v === CANCEL,
    log: { error: () => {} },
  };
  return { prompts, select, CANCEL };
}

async function importPaths() {
  return await import("../../src/cli/paths");
}

async function importConfigCommand() {
  return await import("../../src/cli/commands/config.ts");
}

/** Write a synced role directory (a real dir, as pickSyncedRole follows stat). */
function writeSyncedRole(syncRoot: string, role: string): string {
  const roleDir = join(syncRoot, role);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), `name: ${role}\n`, "utf-8");
  return roleDir;
}

describe("sync-target resolution (platform parity)", () => {
  let dshHome: string;
  let savedDshHome: string | undefined;
  let savedPiDir: string | undefined;

  beforeEach(() => {
    savedDshHome = process.env.DSH_HOME;
    savedPiDir = process.env.PI_CODING_AGENT_DIR;
    dshHome = join(tmpDir, "dsh-home");
    process.env.DSH_HOME = dshHome;
    // Simulate a TTY so configInteractive passes the interactive guard.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedPiDir;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  it("(i) --target dsh resolves the role dir under the DSH_HOME sync root", async () => {
    const { getSyncTarget, getTargetConfigDir, getTargetSkillsDir } = await importPaths();

    expect(getSyncTarget("dsh")).toBe(join(dshHome, "rolebox"));
    expect(getTargetConfigDir("dsh")).toBe(dshHome);
    expect(getTargetSkillsDir("dsh")).toBe(join(dshHome, "skills"));
  });

  it("(ii) an unknown --target throws the registry error listing opencode, pi, dsh", async () => {
    const { getSyncTarget } = await importPaths();

    let message = "";
    try {
      getSyncTarget("bogus");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('Unknown sync target: "bogus"');
    expect(message).toContain("opencode");
    expect(message).toContain("pi");
    expect(message).toContain("dsh");
  });

  it("(iii) omitting --target preserves the opencode default (backward compatibility)", async () => {
    // opencode sync root derives from XDG_CONFIG_HOME (set by the outer beforeEach).
    const opencodeSyncRoot = join(tmpDir, "opencode", "rolebox");
    writeSyncedRole(opencodeSyncRoot, "opencode-role");
    // A different role under dsh must NOT be offered when the target is omitted.
    writeSyncedRole(join(dshHome, "rolebox"), "dsh-role");

    const { configInteractive } = await importConfigCommand();
    const { prompts, select } = createFakePrompts("opencode-role");
    const role = await configInteractive(prompts, "hint");

    expect(role).toBe("opencode-role");
    const offered = (
      select.mock.calls[0][0] as { options: { value: string }[] }
    ).options.map((o) => o.value);
    expect(offered).toEqual(["opencode-role"]);
    expect(offered).not.toContain("dsh-role");
  });

  it("(iv) configInteractive forwards the target to pickSyncedRole", async () => {
    // Both targets have a synced role; only the dsh one may be offered when
    // `target` is "dsh", proving the argument reaches pickSyncedRole.
    writeSyncedRole(join(tmpDir, "opencode", "rolebox"), "opencode-role");
    writeSyncedRole(join(dshHome, "rolebox"), "dsh-role");

    const { configInteractive } = await importConfigCommand();
    const { prompts, select } = createFakePrompts("dsh-role");
    const role = await configInteractive(prompts, "hint", "dsh");

    expect(role).toBe("dsh-role");
    const offered = (
      select.mock.calls[0][0] as { options: { value: string }[] }
    ).options.map((o) => o.value);
    expect(offered).toEqual(["dsh-role"]);
    expect(offered).not.toContain("opencode-role");
  });
});

// ── Interactive target menu ──────────────────────────────────────
//
// `rolebox config` without `--target` must prompt for a platform in
// interactive mode, while an explicit `--target` and the non-interactive
// `--model` path never prompt. Choices are registry-driven, and when the role
// is known only targets where it is synced are surfaced (all targets when it
// is synced nowhere). All filesystem access is redirected through the
// XDG_CONFIG_HOME / PI_CODING_AGENT_DIR / DSH_HOME env seams into a tmpdir.

describe("config target menu (interactive)", () => {
  let piAgentDir: string;
  let dshHome: string;
  let savedDshHome: string | undefined;
  let savedPiDir: string | undefined;

  beforeEach(() => {
    savedDshHome = process.env.DSH_HOME;
    savedPiDir = process.env.PI_CODING_AGENT_DIR;
    piAgentDir = join(tmpDir, "pi-agent");
    dshHome = join(tmpDir, "dsh-home");
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    process.env.DSH_HOME = dshHome;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedPiDir;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  function offeredTargets(select: { mock: { calls: unknown[][] } }): string[] {
    const opts = select.mock.calls[0][0] as { options: { value: string }[] };
    return opts.options.map((o) => o.value);
  }

  it("(a) lists every registry target when no role is known", async () => {
    const { resolveConfigTarget } = await importConfigCommand();
    const { prompts, select } = createFakePrompts("opencode");

    const target = await resolveConfigTarget({ interactive: true, prompts });

    expect(target).toBe("opencode");
    expect(offeredTargets(select)).toEqual(["opencode", "pi", "dsh"]);
  });

  it("(b) selecting pi resolves the role dir under the pi root", async () => {
    writeSyncedRole(join(piAgentDir, "rolebox"), "pi-role");
    writeSyncedRole(join(dshHome, "rolebox"), "dsh-role");

    const { resolveConfigTarget } = await importConfigCommand();
    const { getSyncTarget } = await importPaths();
    const { prompts, select } = createFakePrompts("pi");

    const target = await resolveConfigTarget({ interactive: true, role: "pi-role", prompts });

    expect(target).toBe("pi");
    // Role synced only to pi → menu is filtered to pi.
    expect(offeredTargets(select)).toEqual(["pi"]);
    expect(join(getSyncTarget("pi"), "pi-role")).toBe(join(piAgentDir, "rolebox", "pi-role"));
  });

  it("(b) selecting dsh resolves the role dir under the dsh root", async () => {
    writeSyncedRole(join(piAgentDir, "rolebox"), "pi-role");
    writeSyncedRole(join(dshHome, "rolebox"), "dsh-role");

    const { resolveConfigTarget } = await importConfigCommand();
    const { getSyncTarget } = await importPaths();
    const { prompts, select } = createFakePrompts("dsh");

    const target = await resolveConfigTarget({ interactive: true, role: "dsh-role", prompts });

    expect(target).toBe("dsh");
    expect(offeredTargets(select)).toEqual(["dsh"]);
    expect(join(getSyncTarget("dsh"), "dsh-role")).toBe(join(dshHome, "rolebox", "dsh-role"));
  });

  it("(b2) falls back to every target when the role is synced nowhere", async () => {
    const { resolveConfigTarget } = await importConfigCommand();
    const { prompts, select } = createFakePrompts("dsh");

    const target = await resolveConfigTarget({ interactive: true, role: "ghost-role", prompts });

    expect(target).toBe("dsh");
    expect(offeredTargets(select)).toEqual(["opencode", "pi", "dsh"]);
  });

  it("(b3) run() with an explicit --target writes through that target's sync root", async () => {
    const piRoleDir = writeSyncedRole(join(piAgentDir, "rolebox"), "pi-role");
    writeFileSync(join(piRoleDir, "role.yaml"), "name: pi-role\nmodel: old\n", "utf-8");
    const dshRoleDir = writeSyncedRole(join(dshHome, "rolebox"), "dsh-role");
    writeFileSync(join(dshRoleDir, "role.yaml"), "name: dsh-role\nmodel: old\n", "utf-8");

    const mod = (await importConfigCommand()) as unknown as {
      default: { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };
    };
    await mod.default.run({ args: { role: "pi-role", model: "pi-model", target: "pi" } });
    await mod.default.run({ args: { role: "dsh-role", model: "dsh-model", target: "dsh" } });

    expect(readFileSync(join(piRoleDir, "role.yaml"), "utf-8")).toContain("model: pi-model");
    expect(readFileSync(join(dshRoleDir, "role.yaml"), "utf-8")).toContain("model: dsh-model");
  });

  it("(c) non-interactive with an omitted target defaults to opencode without prompting", async () => {
    const { resolveConfigTarget } = await importConfigCommand();
    const { prompts, select } = createFakePrompts("dsh");

    const target = await resolveConfigTarget({ interactive: false, prompts });

    expect(target).toBe("opencode");
    expect(select).not.toHaveBeenCalled();
  });

  it("(d) an explicit --target skips the menu", async () => {
    const { resolveConfigTarget } = await importConfigCommand();
    const { prompts, select } = createFakePrompts("pi");

    const target = await resolveConfigTarget({
      explicitTarget: "dsh",
      interactive: true,
      role: "any-role",
      prompts,
    });

    expect(target).toBe("dsh");
    expect(select).not.toHaveBeenCalled();
  });
});

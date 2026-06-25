import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, readFileSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dump } from "js-yaml";
import type { RoleboxConfig, LockEntry } from "../../src/cli/types";

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

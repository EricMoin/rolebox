import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump } from "js-yaml";
import type { LockEntry } from "../../../src/cli/types";
import { createDirSymlink } from "../../helpers/symlink";

const statusConfigDir = mkdtempSync(join(tmpdir(), "rolebox-status-config-"));
const statusDataDir = mkdtempSync(join(tmpdir(), "rolebox-status-data-"));
process.env.XDG_CONFIG_HOME = statusConfigDir;
process.env.XDG_DATA_HOME = statusDataDir;

import { createPathsMockPayload } from "../../helpers/paths-mock";

// Redirect every sync target under XDG_CONFIG_HOME so tests never touch a
// developer's real ~/.pi/agent or ~/.dsh directories.
function targetBase(target: string): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (target === "opencode") return join(xdg, "opencode");
  if (target === "pi") return join(xdg, "pi-agent");
  if (target === "dsh") return join(xdg, "dsh");
  throw new Error(`Unknown sync target: "${target}". Supported targets: opencode, pi, dsh`);
}

mock.module("../../../src/cli/paths", () => createPathsMockPayload({
  extra: {
    getSyncTarget: (target: string) => join(targetBase(target), "rolebox"),
    getTargetConfigDir: (target: string) => targetBase(target),
    getTargetSkillsDir: (target: string) => join(targetBase(target), "skills"),
    getOpencodeConfigPath: () => {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return join(xdg, "opencode", "opencode.jsonc");
      return join(homedir(), ".config", "opencode", "opencode.jsonc");
    },
    getOpencodeSkillsDir: () => {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return join(xdg, "opencode", "skills");
      return join(homedir(), ".config", "opencode", "skills");
    },
  },
}));

afterAll(() => {
  rmSync(statusConfigDir, { recursive: true, force: true });
  rmSync(statusDataDir, { recursive: true, force: true });
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-status-test-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.XDG_DATA_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function configDir(): string {
  return join(tmpDir, "rolebox");
}

function lockPath(): string {
  return join(configDir(), "rolebox.lock");
}

function rolesDir(): string {
  return join(tmpDir, "rolebox", "roles");
}

function syncTarget(): string {
  return join(tmpDir, "opencode", "rolebox");
}

function opencodeConfigPath(): string {
  return join(tmpDir, "opencode", "opencode.jsonc");
}

function createLockFile(entries: LockEntry[]): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(lockPath(), dump({ version: 1, roles: entries }), "utf-8");
}

function createRoleDir(registry: string, roleId: string, version: string): string {
  const dir = join(rolesDir(), registry, `${roleId}@${version}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSyncSymlink(roleId: string, target: string): void {
  const syncDir = syncTarget();
  mkdirSync(syncDir, { recursive: true });
  createDirSymlink(target, join(syncDir, roleId));
}

function createOpencodeConfig(plugins: string[]): void {
  const dir = join(tmpDir, "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(opencodeConfigPath(), JSON.stringify({ plugin: plugins }, null, 2), "utf-8");
}

async function importStatus() {
  return await import("../../../src/cli/commands/status");
}

function captureLogs(fn: () => Promise<void>): { logs: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  return {
    logs,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
      }
    },
  };
}

describe("status", () => {
  it("shows no roles message when lock is empty", async () => {
    createLockFile([]);
    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();
    expect(logs.some((l) => l.includes("No roles installed"))).toBe(true);
  });

  it("shows installed roles with sync status", async () => {
    const roleDir = createRoleDir("oh-my-role", "test-role", "1.0.0");
    writeFileSync(join(roleDir, "role.yaml"), dump({ name: "Test Role", description: "A test" }), "utf-8");
    createLockFile([{
      role: "test-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    }]);
    createSyncSymlink("test-role", roleDir);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("test-role");
    expect(allOutput).toContain("1.0.0");
    expect(allOutput).toContain("synced");
  });

  it("detects unsynced roles", async () => {
    createRoleDir("oh-my-role", "unsynced-role", "1.0.0");
    createLockFile([{
      role: "unsynced-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    }]);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("not synced");
  });

  it("detects plugin registration in opencode config", async () => {
    createLockFile([]);
    createOpencodeConfig(["rolebox@latest"]);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("registered");
  });

  it("warns when plugin is not registered", async () => {
    createLockFile([]);
    createOpencodeConfig(["some-other-plugin"]);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("not found");
  });

  it("outputs valid JSON with --json flag", async () => {
    createLockFile([{
      role: "json-test",
      registry: "oh-my-role",
      version: "2.0.0",
      installedAt: "2024-06-01T00:00:00Z",
      integrity: "sha256-xyz",
    }]);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, true));
    await run();

    const parsed = JSON.parse(logs[0]);
    expect(parsed.roles).toBeInstanceOf(Array);
    expect(parsed.roles[0].role).toBe("json-test");
    expect(parsed.roles[0].version).toBe("2.0.0");
    expect(parsed.opencode).toBeDefined();
    expect(parsed.opencode.pluginRegistered).toBeDefined();
    // All three sync targets must be reported.
    expect(parsed.targets).toBeInstanceOf(Array);
    const targetNames = parsed.targets.map((t: any) => t.target).sort();
    expect(targetNames).toEqual(["dsh", "opencode", "pi"]);
    for (const t of parsed.targets) {
      expect(typeof t.syncTarget).toBe("string");
      expect(typeof t.present).toBe("boolean");
      expect(t.roles).toBeInstanceOf(Array);
    }
  });

  it("shows pi and dsh integration sections, not just opencode", async () => {
    const roleDir = createRoleDir("oh-my-role", "multi-role", "1.0.0");
    createLockFile([{
      role: "multi-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    }]);
    createSyncSymlink("multi-role", roleDir);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("OpenCode Integration");
    expect(allOutput).toContain("pi Integration");
    expect(allOutput).toContain("dsh Integration");
  });

  it("reports per-target sync counts in JSON", async () => {
    const roleDir = createRoleDir("oh-my-role", "count-role", "1.0.0");
    createLockFile([{
      role: "count-role",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc",
    }]);
    // Sync only to opencode; pi/dsh should report 0 synced.
    createSyncSymlink("count-role", roleDir);

    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, true));
    await run();

    const parsed = JSON.parse(logs[0]);
    const oc = parsed.targets.find((t: any) => t.target === "opencode");
    const pi = parsed.targets.find((t: any) => t.target === "pi");
    expect(oc.syncedCount).toBe(1);
    expect(oc.totalCount).toBe(1);
    expect(pi.syncedCount).toBe(0);
    expect(pi.totalCount).toBe(1);
  });

  it("handles missing config dir gracefully", async () => {
    const { status } = await importStatus();
    const { logs, run } = captureLogs(() => status(false, false));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("Rolebox");
    expect(allOutput).toContain("No roles installed");
  });
});

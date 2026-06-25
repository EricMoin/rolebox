import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync, readlinkSync, lstatSync, symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump, load } from "js-yaml";
import type { RegistryManifest } from "../../src/cli/types";

const e2eModConfig = mkdtempSync(join(tmpdir(), "rolebox-e2e-mod-config-"));
const e2eModData = mkdtempSync(join(tmpdir(), "rolebox-e2e-mod-data-"));
process.env.XDG_CONFIG_HOME = e2eModConfig;
process.env.XDG_DATA_HOME = e2eModData;

const pGetDataDir = () => {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "rolebox");
  return join(homedir(), ".local", "share", "rolebox");
};
const pGetConfigDir = () => {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "rolebox");
  return join(homedir(), ".config", "rolebox");
};

mock.module("../../src/cli/paths", () => ({
  getDataDir: pGetDataDir,
  getConfigDir: pGetConfigDir,
  getRolesDir: () => join(pGetDataDir(), "roles"),
  getRolePath: (r: string, id: string, v: string) =>
    join(pGetDataDir(), "roles", r, `${id}@${v}`),
  getSyncTarget: (t: string) => {
    if (t === "opencode") {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return join(xdg, "opencode", "rolebox");
      return join(homedir(), ".config", "opencode", "rolebox");
    }
    throw new Error(`Unknown sync target: "${t}". Supported targets: opencode`);
  },
}));

afterAll(() => {
  rmSync(e2eModConfig, { recursive: true, force: true });
  rmSync(e2eModData, { recursive: true, force: true });
});

const sampleManifest: RegistryManifest = {
  name: "oh-my-role",
  description: "Official role registry",
  url: "https://github.com/EricMoin/oh-my-role",
  roles: {
    "test-role": { version: "1.0.0", description: "A test role", tags: ["test"] },
    "code-reviewer": { version: "2.0.0", description: "Code reviewer", tags: ["review"] },
  },
};

function captureOutput(fn: () => Promise<void>) {
  const logs: string[] = []; const warns: string[] = []; const errors: string[] = [];
  const oL = console.log; const oW = console.warn; const oE = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  return {
    logs, warns, errors,
    run: async () => { try { await fn(); } finally { console.log = oL; console.warn = oW; console.error = oE; } },
  };
}

function mockFetchReturning(body: string, status = 200): typeof globalThis.fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status })) as typeof globalThis.fetch;
}

describe("CLI E2E", () => {
  let configDir: string;
  let dataDir: string;
  let origFetch: typeof globalThis.fetch;
  let origExit: typeof process.exit;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "rolebox-e2e-config-"));
    dataDir = mkdtempSync(join(tmpdir(), "rolebox-e2e-data-"));
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.XDG_DATA_HOME = dataDir;
    origFetch = globalThis.fetch;
    origExit = process.exit;
    (process as any).exit = ((_code?: number) => { throw new Error("EXIT"); }) as any;
  });

  afterEach(() => {
    process.exit = origExit;
    process.env.XDG_CONFIG_HOME = e2eModConfig;
    process.env.XDG_DATA_HOME = e2eModData;
    globalThis.fetch = origFetch;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("lifecycle: install → list → sync → uninstall → verify", () => {
    it("completes the full lifecycle", async () => {
      const hubDir = join(dataDir, "rolebox", "roles", "oh-my-role");
      mkdirSync(hubDir, { recursive: true });

      const rolePath = join(hubDir, "test-role@1.0.0");
      mkdirSync(rolePath, { recursive: true });
      writeFileSync(join(rolePath, "role.yaml"), "name: Test Role\ndescription: A test role\n", "utf-8");

      const lockPath = join(configDir, "rolebox", "rolebox.lock");
      mkdirSync(join(configDir, "rolebox"), { recursive: true });
      writeFileSync(lockPath, dump({
        version: 1,
        roles: [{
          role: "test-role", registry: "oh-my-role", version: "1.0.0",
          installedAt: "2025-01-01T00:00:00Z", integrity: "sha256-abc123",
        }],
      }), "utf-8");

      const lockData = load(readFileSync(lockPath, "utf-8")) as any;
      expect(lockData.roles).toHaveLength(1);
      expect(lockData.roles[0].role).toBe("test-role");

      const { list } = await import("../../src/cli/commands/list");
      const { logs: ll, run: rl } = captureOutput(async () => { list([]); });
      await rl();
      expect(ll.some((l) => l.includes("test-role"))).toBe(true);
      expect(ll.some((l) => l.includes("1.0.0"))).toBe(true);
      expect(ll.some((l) => l.includes("oh-my-role"))).toBe(true);

      const { sync } = await import("../../src/cli/commands/sync");
      const { logs: sl, run: rs } = captureOutput(async () => { await sync(["opencode"]); });
      await rs();
      const syncTarget = join(configDir, "opencode", "rolebox", "test-role");
      expect(existsSync(syncTarget)).toBe(true);
      expect(lstatSync(syncTarget).isSymbolicLink()).toBe(true);
      expect(readlinkSync(syncTarget)).toBe(rolePath);
      expect(sl.some((l) => l.includes("Synced 1 roles"))).toBe(true);

      const { uninstall } = await import("../../src/cli/commands/uninstall");
      const { logs: ul, run: ru } = captureOutput(async () => { await uninstall(["test-role"]); });
      await ru();
      expect(existsSync(rolePath)).toBe(false);
      const la = load(readFileSync(lockPath, "utf-8")) as any;
      expect(la.roles).toHaveLength(0);
      expect(ul.some((l) => l.includes("Uninstalled"))).toBe(true);

      const { logs: lf, run: rf } = captureOutput(async () => { list([]); });
      await rf();
      expect(lf.some((l) => l.includes("No roles installed"))).toBe(true);
    });
  });

  describe("registry management flow", () => {
    it("shows default oh-my-role on list", async () => {
      const { registry } = await import("../../src/cli/commands/registry");
      const c = captureOutput(async () => { await registry(["list"]); });
      await c.run();
      expect(c.logs.some((l) => l.includes("oh-my-role"))).toBe(true);
      expect(c.logs.some((l) => l.includes("(default)"))).toBe(true);
    });

    it("adds a new registry and persists to config", async () => {
      globalThis.fetch = mockFetchReturning(dump({
        name: "my-repo", description: "Test", url: "https://github.com/my-org/my-repo", roles: {},
      }));

      const { registry } = await import("../../src/cli/commands/registry");
      const c = captureOutput(async () => { await registry(["add", "https://github.com/my-org/my-repo"]); });
      await c.run();
      expect(c.logs.some((l) => l.includes("Added"))).toBe(true);
      expect(c.logs.some((l) => l.includes("my-repo"))).toBe(true);

      const configPath = join(configDir, "rolebox", "config.yaml");
      const parsed = load(readFileSync(configPath, "utf-8")) as any;
      expect(parsed.registries.some((r: any) => r.name === "my-repo")).toBe(true);
    });

    it("registry list shows the added registry", async () => {
      globalThis.fetch = mockFetchReturning(dump({
        name: "custom-rolebox", description: "Custom",
        url: "https://github.com/custom/custom-rolebox", roles: {},
      }));

      const { registry } = await import("../../src/cli/commands/registry");
      await registry(["add", "https://github.com/custom/custom-rolebox"]);

      const lc = captureOutput(async () => { await registry(["list"]); });
      await lc.run();
      expect(lc.logs.some((l) => l.includes("custom-rolebox"))).toBe(true);
      expect(lc.logs.some((l) => l.includes("oh-my-role"))).toBe(true);
    });

    it("removes a non-default registry", async () => {
      const cfgDir = join(configDir, "rolebox");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.yaml"), dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
          { name: "to-remove", url: "https://github.com/user/to-remove" },
        ],
      }), "utf-8");

      const { registry } = await import("../../src/cli/commands/registry");
      const c = captureOutput(async () => { await registry(["remove", "to-remove"]); });
      await c.run();
      expect(c.logs.some((l) => l.includes("Removed"))).toBe(true);

      const raw = readFileSync(join(cfgDir, "config.yaml"), "utf-8");
      const parsed = load(raw) as any;
      expect(parsed.registries).toHaveLength(1);
      expect(parsed.registries[0].name).toBe("oh-my-role");
    });

    it("refuses to remove the default registry", async () => {
      const { registry } = await import("../../src/cli/commands/registry");
      await expect(registry(["remove", "oh-my-role"])).rejects.toThrow("EXIT");
    });
  });

  describe("error resilience", () => {
    it("handles network failure during registry fetch", async () => {
      globalThis.fetch = mockFetchReturning("", 500);

      const { search } = await import("../../src/cli/commands/search");
      const c = captureOutput(async () => { await search(["anything"]); });
      await c.run();
      expect(c.warns.some((w) => w.includes("Warning"))).toBe(true);
    });

    it("produces error for unknown sync target", async () => {
      const { sync } = await import("../../src/cli/commands/sync");
      await expect(sync(["unknown-target"])).rejects.toThrow("EXIT");
    });

    it("produces error when uninstalling unknown role", async () => {
      const { uninstall } = await import("../../src/cli/commands/uninstall");
      await expect(uninstall(["nonexistent-role"])).rejects.toThrow("EXIT");
    });

    it("produces error when removing default registry", async () => {
      const { registry } = await import("../../src/cli/commands/registry");
      await expect(registry(["remove", "oh-my-role"])).rejects.toThrow("EXIT");
    });

    it("handles registry add with invalid URL", async () => {
      const { registry } = await import("../../src/cli/commands/registry");
      await expect(registry(["add", "not-a-url"])).rejects.toThrow("EXIT");
    });
  });

  describe("sync edge cases", () => {
    it("sync handles empty lock file gracefully", async () => {
      const { sync } = await import("../../src/cli/commands/sync");
      const c = captureOutput(async () => { await sync(["opencode"]); });
      await c.run();
      expect(c.logs.some((l) => l.includes("Synced 0 roles"))).toBe(true);
    });

    it("sync is idempotent", async () => {
      const hubDir = join(dataDir, "rolebox", "roles", "oh-my-role");
      mkdirSync(hubDir, { recursive: true });
      const rolePath = join(hubDir, "test-role@1.0.0");
      mkdirSync(rolePath, { recursive: true });
      writeFileSync(join(rolePath, "role.yaml"), "name: Test Role\n", "utf-8");

      mkdirSync(join(configDir, "rolebox"), { recursive: true });
      writeFileSync(join(configDir, "rolebox", "rolebox.lock"), dump({
        version: 1,
        roles: [{ role: "test-role", registry: "oh-my-role", version: "1.0.0", installedAt: "2025-01-01T00:00:00Z", integrity: "sha256-abc" }],
      }), "utf-8");

      const { sync } = await import("../../src/cli/commands/sync");
      const c1 = captureOutput(async () => { await sync(["opencode"]); });
      await c1.run();
      expect(c1.logs.some((l) => l.includes("Synced 1 roles"))).toBe(true);

      const c2 = captureOutput(async () => { await sync(["opencode"]); });
      await c2.run();
      expect(c2.logs.some((l) => l.includes("Synced 1 roles"))).toBe(true);
      expect(c2.warns).toHaveLength(0);
      expect(c2.errors).toHaveLength(0);
    });

    it("sync skips manual (non-symlink) directories", async () => {
      const hubDir = join(dataDir, "rolebox", "roles", "oh-my-role");
      mkdirSync(hubDir, { recursive: true });
      const rolePath = join(hubDir, "test-role@1.0.0");
      mkdirSync(rolePath, { recursive: true });
      writeFileSync(join(rolePath, "role.yaml"), "name: Test Role\n", "utf-8");

      mkdirSync(join(configDir, "rolebox"), { recursive: true });
      writeFileSync(join(configDir, "rolebox", "rolebox.lock"), dump({
        version: 1,
        roles: [{ role: "manual-role", registry: "oh-my-role", version: "1.0.0", installedAt: "2025-01-01T00:00:00Z", integrity: "sha256-abc" }],
      }), "utf-8");

      const manualRoleDir = join(dataDir, "rolebox", "roles", "oh-my-role", "manual-role@1.0.0");
      mkdirSync(manualRoleDir, { recursive: true });
      writeFileSync(join(manualRoleDir, "role.yaml"), "name: Manual\n", "utf-8");

      const targetDir = join(configDir, "opencode", "rolebox");
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(join(targetDir, "manual-role"), { recursive: true });
      writeFileSync(join(targetDir, "manual-role", "role.yaml"), "name: Manual\n", "utf-8");

      const { sync } = await import("../../src/cli/commands/sync");
      const c = captureOutput(async () => { await sync(["opencode"]); });
      await c.run();
      expect(c.warns.some((w) => w.includes("regular directory"))).toBe(true);
    });

    it("sync cleans up broken symlinks", async () => {
      const targetDir = join(configDir, "opencode", "rolebox");
      mkdirSync(targetDir, { recursive: true });
      symlinkSync("/nonexistent/dead/path", join(targetDir, "broken-link"));

      const { sync } = await import("../../src/cli/commands/sync");
      const c = captureOutput(async () => { await sync(["opencode"]); });
      await c.run();
      expect(existsSync(join(targetDir, "broken-link"))).toBe(false);
      expect(c.logs.some((l) => l.includes("1 cleaned"))).toBe(true);
    });
  });

  describe("list edge cases", () => {
    it("list --json outputs valid JSON when empty", async () => {
      const { list } = await import("../../src/cli/commands/list");
      const { logs, run } = captureOutput(async () => { list(["--json"]); });
      await run();
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    });

    it("list --json outputs valid JSON with installed role", async () => {
      mkdirSync(join(configDir, "rolebox"), { recursive: true });
      writeFileSync(join(configDir, "rolebox", "rolebox.lock"), dump({
        version: 1,
        roles: [{ role: "test-role", registry: "oh-my-role", version: "1.0.0", installedAt: "2025-01-01T00:00:00Z", integrity: "sha256-abc" }],
      }), "utf-8");
      mkdirSync(join(dataDir, "rolebox", "roles", "oh-my-role", "test-role@1.0.0"), { recursive: true });

      const { list } = await import("../../src/cli/commands/list");
      const { logs, run } = captureOutput(async () => { list(["--json"]); });
      await run();
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].role).toBe("test-role");
      expect(parsed[0].version).toBe("1.0.0");
    });

    it("list shows empty message when no roles", async () => {
      const { list } = await import("../../src/cli/commands/list");
      const { logs, run } = captureOutput(async () => { list([]); });
      await run();
      expect(logs.some((l) => l.includes("No roles installed"))).toBe(true);
    });
  });

  describe("search with registry", () => {
    it("searches and finds roles by name", async () => {
      const cfgDir = join(configDir, "rolebox");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.yaml"), dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role", default: true },
        ],
      }), "utf-8");

      globalThis.fetch = mockFetchReturning(dump(sampleManifest));

      const { search } = await import("../../src/cli/commands/search");
      const c = captureOutput(async () => { await search(["test-role"]); });
      await c.run();
      expect(c.logs.some((l) => l.includes("test-role"))).toBe(true);
    });

    it("search shows helpful message when no matches", async () => {
      const cfgDir = join(configDir, "rolebox");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.yaml"), dump({
        registries: [
          { name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" },
        ],
      }), "utf-8");

      globalThis.fetch = mockFetchReturning(dump(sampleManifest));

      const { search } = await import("../../src/cli/commands/search");
      const c = captureOutput(async () => { await search(["nonexistent"]); });
      await c.run();
      expect(c.logs.some((l) => l.includes("No roles matching"))).toBe(true);
    });
  });
});

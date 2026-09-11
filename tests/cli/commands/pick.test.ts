import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load, dump } from "js-yaml";
import type { RegistryManifest, LockEntry } from "../../../src/cli/types";
import type { PromptApi } from "../../../src/cli/pick.ts";

// ── Fake prompts (dependency-injected; no module mocking) ────────
// The pickers take the prompts API as an injectable parameter (defaulting to
// real clack). Tests pass a scripted fake, so no mock.module is needed — and
// no global clack shadowing can leak into sibling test files.
function createFakePrompts() {
  const CANCEL = Symbol("clack:cancel");
  const select = mock(async () => "software-architect");
  const confirm = mock(async () => true);
  const prompts: PromptApi = {
    intro: () => {},
    outro: () => {},
    cancel: () => {},
    select: select as unknown as PromptApi["select"],
    confirm: confirm as unknown as PromptApi["confirm"],
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    isCancel: (v: unknown) => v === CANCEL,
    log: { error: () => {} },
  };
  return { prompts, CANCEL, select, confirm };
}

// ── registry-client mock (install path — same pattern as install.test.ts) ──
const mockFetchManifest = mock();
const mockDownloadRole = mock();
const mockResolveVersion = mock();
const mockComputeIntegrity = mock();

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
let savedPiDir: string | undefined;
let savedDshHome: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-pick-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-pick-data-"));

  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;
  savedPiDir = process.env.PI_CODING_AGENT_DIR;
  savedDshHome = process.env.DSH_HOME;
  process.env.PI_CODING_AGENT_DIR = join(tmpConfigDir, "pi-agent");
  process.env.DSH_HOME = join(tmpConfigDir, "dsh-home");

  // Simulate a TTY so the interactive flows pass the stdin guard.
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

  mock.module("../../../src/cli/registry-client", () => ({
    ...realRegistryClient,
    fetchRegistryManifest: mockFetchManifest,
    downloadRole: mockDownloadRole,
    resolveVersion: mockResolveVersion,
    computeIntegrity: mockComputeIntegrity,
  }));
  mockFetchManifest.mockImplementation(async () => sampleManifest);
  mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
  mockResolveVersion.mockImplementation(() => "1.0.0");
  mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedPiDir;
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function createMockExtractedDir(roleId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rolebox-pick-extracted-"));
  writeFileSync(join(dir, "role.yaml"), `name: ${roleId}\ndescription: Test role\n`, "utf-8");
  return dir;
}

function cacheBust(spec: string) {
  return spec + "?t=" + Date.now() + "-" + Math.random();
}

function configDir(): string {
  return join(tmpConfigDir, "rolebox");
}

function dataDir(): string {
  return join(tmpDataDir, "rolebox");
}

function readLock(): { roles: LockEntry[] } {
  const lockPath = join(configDir(), "rolebox.lock");
  if (!existsSync(lockPath)) return { roles: [] };
  return load(readFileSync(lockPath, "utf-8")) as { roles: LockEntry[] };
}

function writeLock(roles: LockEntry[]) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "rolebox.lock"), dump({ version: 1, roles }), "utf-8");
}

function installedRoleEntry(roleId: string, registry = "oh-my-role", version = "1.0.0"): LockEntry {
  return {
    role: roleId,
    registry,
    version,
    installedAt: new Date().toISOString(),
    integrity: "sha256-abc123",
  };
}

function addRegistry(name: string, url: string, isDefault = false) {
  mkdirSync(configDir(), { recursive: true });
  const existing = (() => {
    try {
      return load(readFileSync(join(configDir(), "config.yaml"), "utf-8")) as { registries: unknown[] };
    } catch {
      return { registries: [] };
    }
  })();
  writeFileSync(
    join(configDir(), "config.yaml"),
    dump({
      registries: [...existing.registries, { name, url, ...(isDefault ? { default: true } : {}) }],
    }),
    "utf-8",
  );
}

// ── pickRegistryAndRole ──────────────────────────────────────────

describe("pickRegistryAndRole", () => {
  it("returns roleId without a registry prefix for the single/default registry", async () => {
    const { prompts, select } = createFakePrompts();
    const { pickRegistryAndRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    const result = await pickRegistryAndRole(undefined, prompts);

    expect(result).toEqual({ roleId: "software-architect" });
    // Single registry → no registry picker prompt; only the role picker ran.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("prefixes the registry when a non-default registry is picked", async () => {
    addRegistry("oh-my-role", "https://github.com/EricMoin/oh-my-role", true);
    addRegistry("custom-registry", "https://github.com/custom/registry");

    const { prompts, select } = createFakePrompts();
    select.mockImplementation(async (opts: { options: { value: string }[] }) => {
      const values = opts.options.map((o) => o.value);
      if (values.includes("custom-registry")) return "custom-registry";
      return "code-reviewer";
    });

    const { pickRegistryAndRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    const result = await pickRegistryAndRole(undefined, prompts);

    expect(result).toEqual({ registry: "custom-registry", roleId: "code-reviewer" });
  });

  it("does not prefix the registry when the default is picked among several", async () => {
    addRegistry("oh-my-role", "https://github.com/EricMoin/oh-my-role", true);
    addRegistry("custom-registry", "https://github.com/custom/registry");

    const { prompts, select } = createFakePrompts();
    select.mockImplementation(async (opts: { options: { value: string }[] }) => {
      const values = opts.options.map((o) => o.value);
      if (values.includes("custom-registry")) return "oh-my-role";
      return "code-reviewer";
    });

    const { pickRegistryAndRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    const result = await pickRegistryAndRole(undefined, prompts);

    expect(result).toEqual({ roleId: "code-reviewer" });
  });

  it("returns null when the user cancels the role picker", async () => {
    const { prompts, select, CANCEL } = createFakePrompts();
    select.mockImplementation(async () => CANCEL);

    const { pickRegistryAndRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    expect(await pickRegistryAndRole(undefined, prompts)).toBeNull();
  });

  it("throws when no registries are configured", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), "config.yaml"), "registries: []\n", "utf-8");

    const { prompts } = createFakePrompts();
    const { pickRegistryAndRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    await expect(pickRegistryAndRole(undefined, prompts)).rejects.toThrow(/No registries configured/);
  });
});

// ── pickInstalledRole / pickSyncedRole ───────────────────────────

describe("pickInstalledRole", () => {
  it("offers installed roles with version + registry hints and returns the picked roleId", async () => {
    writeLock([installedRoleEntry("software-architect"), installedRoleEntry("code-reviewer", "oh-my-role", "2.0.0")]);
    const { prompts, select } = createFakePrompts();
    select.mockImplementation(async () => "code-reviewer");

    const { pickInstalledRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    expect(await pickInstalledRole("Select a role:", prompts)).toBe("code-reviewer");

    const selectOpts = select.mock.calls[0][0] as { options: { value: string; hint: string }[] };
    expect(selectOpts.options.map((o) => o.value)).toEqual(["software-architect", "code-reviewer"]);
    expect(selectOpts.options[1].hint).toContain("2.0.0");
  });

  it("returns null when nothing is installed", async () => {
    const { prompts } = createFakePrompts();
    const { pickInstalledRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    expect(await pickInstalledRole("Select a role:", prompts)).toBeNull();
  });
});

describe("pickSyncedRole", () => {
  it("offers roles synced into the target directory, following symlinks and skipping broken ones", async () => {
    // Simulate `rolebox sync opencode`: a symlink inside the target dir.
    const syncDir = join(tmpConfigDir, "opencode", "rolebox");
    mkdirSync(syncDir, { recursive: true });
    const roleDir = join(dataDir(), "roles", "oh-my-role", "software-architect@1.0.0");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), "name: software-architect\n", "utf-8");

    const { createDirSymlink } = await import("../../../src/utils/symlink.ts");
    createDirSymlink(roleDir, join(syncDir, "software-architect"));
    // A broken symlink must be skipped, not offered.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(syncDir, "does-not-exist"), join(syncDir, "broken-link"));

    const { prompts, select } = createFakePrompts();
    const { pickSyncedRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    const result = await pickSyncedRole("opencode", "Select a role:", prompts);

    expect(result).toBe("software-architect");
    const selectOpts = select.mock.calls[0][0] as { options: { value: string }[] };
    const offered = selectOpts.options.map((o) => o.value);
    expect(offered).toContain("software-architect");
    expect(offered).not.toContain("broken-link");
  });

  it("returns null when nothing is synced", async () => {
    const { prompts } = createFakePrompts();
    const { pickSyncedRole } = await import(cacheBust("../../../src/cli/pick.ts"));
    expect(await pickSyncedRole("opencode", "Select a role:", prompts)).toBeNull();
  });
});

// ── Command wiring: roleless invocation enters the picker ────────

describe("rolebox install (interactive)", () => {
  it("installs the picked role after confirmation", async () => {
    const { prompts } = createFakePrompts();
    const { installInteractive } = await import(cacheBust("../../../src/cli/commands/install.ts"));
    expect(await installInteractive(prompts)).toBe(true);

    const lock = readLock();
    expect(lock.roles).toHaveLength(1);
    expect(lock.roles[0].role).toBe("software-architect");
    expect(lock.roles[0].registry).toBe("oh-my-role");
    expect(lock.roles[0].version).toBe("1.0.0");
  });

  it("does nothing when the user cancels the role picker", async () => {
    const { prompts, select, CANCEL } = createFakePrompts();
    select.mockImplementation(async () => CANCEL);

    const { installInteractive } = await import(cacheBust("../../../src/cli/commands/install.ts"));
    expect(await installInteractive(prompts)).toBe(false);
    expect(readLock().roles).toHaveLength(0);
  });

  it("does nothing when the user declines the confirmation", async () => {
    const { prompts, confirm } = createFakePrompts();
    confirm.mockImplementation(async () => false);

    const { installInteractive } = await import(cacheBust("../../../src/cli/commands/install.ts"));
    expect(await installInteractive(prompts)).toBe(false);
    expect(readLock().roles).toHaveLength(0);
  });

  it("throws a friendly error when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const { installInteractive } = await import(cacheBust("../../../src/cli/commands/install.ts"));
    await expect(installInteractive()).rejects.toThrow(/requires a TTY/);
    expect(readLock().roles).toHaveLength(0);
  });

  it("still installs a role passed explicitly through run(), bypassing the picker", async () => {
    const { default: cmd } = await import(cacheBust("../../../src/cli/commands/install.ts"));
    await cmd.run({ args: { role: "software-architect" } });
    expect(readLock().roles).toHaveLength(1);
  });

  it("run() without a role enters the interactive flow (non-TTY guard fires)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const { default: cmd } = await import(cacheBust("../../../src/cli/commands/install.ts"));
    await expect(cmd.run({ args: { role: undefined } })).rejects.toThrow(/requires a TTY/);
  });
});

describe("rolebox uninstall (interactive)", () => {
  it("uninstalls the picked role after confirmation", async () => {
    const rolePath = join(dataDir(), "roles", "oh-my-role", "software-architect@1.0.0");
    mkdirSync(rolePath, { recursive: true });
    writeFileSync(join(rolePath, "role.yaml"), "name: software-architect\n", "utf-8");
    writeLock([installedRoleEntry("software-architect")]);

    const { prompts } = createFakePrompts();
    const { uninstallInteractive } = await import(cacheBust("../../../src/cli/commands/uninstall.ts"));
    expect(await uninstallInteractive(prompts)).toBe(true);

    expect(readLock().roles).toHaveLength(0);
    expect(existsSync(rolePath)).toBe(false);
  });

  it("keeps the role when the user declines confirmation", async () => {
    writeLock([installedRoleEntry("software-architect")]);
    const { prompts, confirm } = createFakePrompts();
    confirm.mockImplementation(async () => false);

    const { uninstallInteractive } = await import(cacheBust("../../../src/cli/commands/uninstall.ts"));
    expect(await uninstallInteractive(prompts)).toBe(false);
    expect(readLock().roles).toHaveLength(1);
  });
});

describe("rolebox info (interactive)", () => {
  it("shows info for the picked role", async () => {
    const rolePath = join(dataDir(), "roles", "oh-my-role", "software-architect@1.0.0");
    mkdirSync(rolePath, { recursive: true });
    writeFileSync(
      join(rolePath, "role.yaml"),
      "name: Software Architect\ndescription: Architecture role\nmodel: gpt-4o\n",
      "utf-8",
    );
    writeLock([installedRoleEntry("software-architect")]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(String(args[0])); };

    try {
      const { prompts } = createFakePrompts();
      const { infoInteractive, info } = await import(cacheBust("../../../src/cli/commands/info.ts"));
      const roleId = await infoInteractive(prompts);
      expect(roleId).toBe("software-architect");
      await info(roleId, false, false);
    } finally {
      console.log = origLog;
    }

    expect(logs.some((l) => l.includes("software-architect"))).toBe(true);
    expect(logs.some((l) => l.includes("Software Architect"))).toBe(true);
  });

  it("returns undefined when the user cancels", async () => {
    const { prompts, select, CANCEL } = createFakePrompts();
    select.mockImplementation(async () => CANCEL);

    const { infoInteractive } = await import(cacheBust("../../../src/cli/commands/info.ts"));
    expect(await infoInteractive(prompts)).toBeUndefined();
  });

  it("run() with --json and no role requires an explicit role", async () => {
    const { default: cmd } = await import(cacheBust("../../../src/cli/commands/info.ts"));
    await expect(cmd.run({ args: { role: undefined, json: true } })).rejects.toThrow(/requires an explicit role/);
  });
});

describe("rolebox config (interactive)", () => {
  it("applies --model to the picked synced role", async () => {
    const syncDir = join(tmpConfigDir, "opencode", "rolebox");
    const roleDir = join(syncDir, "software-architect");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), "name: Software Architect\nmodel: gpt-4o\n", "utf-8");

    const { prompts } = createFakePrompts();
    const { configInteractive } = await import(cacheBust("../../../src/cli/commands/config.ts"));
    const role = await configInteractive(prompts, "hint");
    expect(role).toBe("software-architect");

    const { runNonInteractive } = await import(cacheBust("../../../src/cli/commands/config.ts"));
    await runNonInteractive(roleDir, "claude-3-5-sonnet", false);

    const yaml = readFileSync(join(roleDir, "role.yaml"), "utf-8");
    expect(yaml).toContain("model: claude-3-5-sonnet");
  });

  it("returns undefined when the user cancels", async () => {
    const { prompts, select, CANCEL } = createFakePrompts();
    select.mockImplementation(async () => CANCEL);

    const { configInteractive } = await import(cacheBust("../../../src/cli/commands/config.ts"));
    expect(await configInteractive(prompts, "hint")).toBeUndefined();
  });
});

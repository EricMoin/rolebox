import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump } from "js-yaml";
import type { LockEntry } from "../types";

const infoConfigDir = mkdtempSync(join(tmpdir(), "rolebox-info-config-"));
const infoDataDir = mkdtempSync(join(tmpdir(), "rolebox-info-data-"));
process.env.XDG_CONFIG_HOME = infoConfigDir;
process.env.XDG_DATA_HOME = infoDataDir;

mock.module("../paths", () => {
  function getDataDir(): string {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".local", "share", "rolebox");
  }
  function getConfigDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".config", "rolebox");
  }
  function getRolesDir(): string {
    return join(getDataDir(), "roles");
  }
  function getRolePath(registry: string, roleId: string, version: string): string {
    return join(getRolesDir(), registry, `${roleId}@${version}`);
  }
  function getSyncTarget(target: string): string {
    if (target === "opencode") {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return join(xdg, "opencode", "rolebox");
      return join(homedir(), ".config", "opencode", "rolebox");
    }
    throw new Error(`Unknown sync target: "${target}". Supported targets: opencode`);
  }
  return { getDataDir, getConfigDir, getRolesDir, getRolePath, getSyncTarget };
});

afterAll(() => {
  rmSync(infoConfigDir, { recursive: true, force: true });
  rmSync(infoDataDir, { recursive: true, force: true });
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-info-test-"));
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

function createLockFile(entries: LockEntry[]): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(lockPath(), dump({ version: 1, roles: entries }), "utf-8");
}

function createRoleDir(registry: string, roleId: string, version: string, roleYaml: object): string {
  const dir = join(rolesDir(), registry, `${roleId}@${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.yaml"), dump(roleYaml), "utf-8");
  return dir;
}

function createSyncSymlink(roleId: string, target: string): void {
  const syncDir = syncTarget();
  mkdirSync(syncDir, { recursive: true });
  symlinkSync(target, join(syncDir, roleId));
}

async function importInfo() {
  return await import("./info");
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

describe("info", () => {
  it("shows error when no role specified", async () => {
    const { info } = await importInfo();
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as any;

    const origErr = console.error;
    let errMsg = "";
    console.error = (...args: any[]) => { errMsg = args.join(" "); };

    try {
      await info([]);
    } catch { /* exit mock */ }

    process.exit = origExit;
    console.error = origErr;
    expect(errMsg).toContain("Usage:");
    expect(exitCode).toBe(1);
  });

  it("shows error when role not installed", async () => {
    createLockFile([]);
    const { info } = await importInfo();
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as any;

    const origErr = console.error;
    let errMsg = "";
    console.error = (...args: any[]) => { errMsg = args.join(" "); };

    try {
      await info(["nonexistent"]);
    } catch { /* exit mock */ }

    process.exit = origExit;
    console.error = origErr;
    expect(errMsg).toContain("not installed");
    expect(exitCode).toBe(1);
  });

  it("displays role details from role.yaml", async () => {
    const roleYaml = {
      name: "Software Architect",
      description: "System design advisor",
      model: "claude-sonnet-4-20250514",
      mode: "primary",
      skills: ["core-skill", "patterns-skill"],
      functions: ["plan", "execute", "review"],
    };

    const roleDir = createRoleDir("oh-my-role", "software-architect", "1.0.0", roleYaml);
    createLockFile([{
      role: "software-architect",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-abc123",
    }]);
    createSyncSymlink("software-architect", roleDir);

    const { info } = await importInfo();
    const { logs, run } = captureLogs(() => info(["software-architect"]));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("software-architect");
    expect(allOutput).toContain("Software Architect");
    expect(allOutput).toContain("System design advisor");
    expect(allOutput).toContain("claude-sonnet-4-20250514");
    expect(allOutput).toContain("core-skill");
    expect(allOutput).toContain("plan");
    expect(allOutput).toContain("review");
    expect(allOutput).toContain("Symlinked");
  });

  it("outputs valid JSON with --json flag", async () => {
    const roleYaml = {
      name: "Test Role",
      description: "Testing",
      skills: ["skill-a"],
      functions: ["plan"],
    };

    createRoleDir("oh-my-role", "test-role", "2.0.0", roleYaml);
    createLockFile([{
      role: "test-role",
      registry: "oh-my-role",
      version: "2.0.0",
      installedAt: "2024-06-01T00:00:00Z",
      integrity: "sha256-def",
    }]);

    const { info } = await importInfo();
    const { logs, run } = captureLogs(() => info(["test-role", "--json"]));
    await run();

    const parsed = JSON.parse(logs[0]);
    expect(parsed.role).toBe("test-role");
    expect(parsed.name).toBe("Test Role");
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.skills).toEqual(["skill-a"]);
    expect(parsed.functions).toEqual(["plan"]);
    expect(parsed.sync).toBeDefined();
  });

  it("detects subagents from subdirectory", async () => {
    const roleYaml = { name: "Team Lead", description: "Coordinates work" };
    const roleDir = createRoleDir("oh-my-role", "team-lead", "1.0.0", roleYaml);

    const subDir = join(roleDir, "subagents", "researcher");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "role.yaml"), dump({ name: "Researcher", description: "Research specialist" }), "utf-8");

    createLockFile([{
      role: "team-lead",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-sub",
    }]);

    const { info } = await importInfo();
    const { logs, run } = captureLogs(() => info(["team-lead"]));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("Researcher");
    expect(allOutput).toContain("Research specialist");
  });

  it("shows collaboration graph info", async () => {
    const roleYaml = {
      name: "Review Team",
      description: "Review workflow",
      collaboration: {
        topology: "review-loop",
        agents: ["coder", "reviewer"],
        max_iterations: 3,
      },
    };

    createRoleDir("oh-my-role", "review-team", "1.0.0", roleYaml);
    createLockFile([{
      role: "review-team",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-collab",
    }]);

    const { info } = await importInfo();
    const { logs, run } = captureLogs(() => info(["review-team"]));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("review-loop");
    expect(allOutput).toContain("coder");
    expect(allOutput).toContain("reviewer");
  });

  it("shows unsynced status when no symlink exists", async () => {
    createRoleDir("oh-my-role", "unsynced", "1.0.0", { name: "Unsynced" });
    createLockFile([{
      role: "unsynced",
      registry: "oh-my-role",
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      integrity: "sha256-ns",
    }]);

    const { info } = await importInfo();
    const { logs, run } = captureLogs(() => info(["unsynced"]));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("Not synced");
  });
});

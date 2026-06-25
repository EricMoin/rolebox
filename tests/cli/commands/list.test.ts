import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump } from "js-yaml";
import type { LockEntry } from "../../../src/cli/types";

const listConfigDir = mkdtempSync(join(tmpdir(), "rolebox-list-config-"));
const listDataDir = mkdtempSync(join(tmpdir(), "rolebox-list-data-"));
process.env.XDG_CONFIG_HOME = listConfigDir;
process.env.XDG_DATA_HOME = listDataDir;

mock.module("../../../src/cli/paths", () => {
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
  rmSync(listConfigDir, { recursive: true, force: true });
  rmSync(listDataDir, { recursive: true, force: true });
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-list-test-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function configDir(): string {
  return join(tmpDir, "rolebox");
}

function lockPath(): string {
  return join(configDir(), "rolebox.lock");
}

async function createLockFile(entries: LockEntry[]): Promise<void> {
  mkdirSync(configDir(), { recursive: true });
  await writeFile(
    lockPath(),
    dump({ version: 1, roles: entries }),
    "utf-8",
  );
}

async function importList() {
  return await import("../../../src/cli/commands/list");
}

function captureLogs(fn: () => void): { logs: string[]; run: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
    origLog.apply(console, args as any);
  };
  return {
    logs,
    run: () => {
      try {
        fn();
      } finally {
        console.log = origLog;
      }
    },
  };
}

describe("list", () => {
  it("shows 'No roles installed' when lock file does not exist", async () => {
    const { list } = await importList();
    const { logs, run } = captureLogs(() => list([]));
    run();
    expect(logs.some((c) => c.includes("No roles installed"))).toBe(true);
  });

  it("shows 'No roles installed' when lock file has empty roles array", async () => {
    await createLockFile([]);

    const { list } = await importList();
    const { logs, run } = captureLogs(() => list([]));
    run();
    expect(logs.some((c) => c.includes("No roles installed"))).toBe(true);
  });

  it("lists installed roles from lock file", async () => {
    await createLockFile([
      {
        role: "software-architect",
        registry: "oh-my-role",
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00Z",
        integrity: "sha256-abc",
      },
    ]);

    const { list } = await importList();
    const { logs, run } = captureLogs(() => list([]));
    run();

    expect(logs[0]).toBe("Installed roles:");
    expect(logs[1]).toContain("software-architect");
    expect(logs[1]).toContain("1.0.0");
    expect(logs[1]).toContain("oh-my-role");
  });

  it("outputs valid JSON with --json flag", async () => {
    await createLockFile([
      {
        role: "code-reviewer",
        registry: "oh-my-role",
        version: "2.0.0",
        installedAt: "2024-06-01T00:00:00Z",
        integrity: "sha256-xyz",
      },
    ]);

    const { list } = await importList();
    const { logs, run } = captureLogs(() => list(["--json"]));
    run();

    const parsed = JSON.parse(logs[0]);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].role).toBe("code-reviewer");
    expect(parsed[0].version).toBe("2.0.0");
    expect(parsed[0].registry).toBe("oh-my-role");
    expect(parsed[0].installedAt).toBe("2024-06-01T00:00:00Z");
    expect(parsed[0].integrity).toBe("sha256-xyz");
  });

  it("outputs empty JSON array with --json when no roles", async () => {
    await createLockFile([]);

    const { list } = await importList();
    const { logs, run } = captureLogs(() => list(["--json"]));
    run();

    const parsed = JSON.parse(logs[0]);
    expect(parsed).toEqual([]);
  });

  it("handles multiple roles with different registries", async () => {
    await createLockFile([
      {
        role: "architect",
        registry: "oh-my-role",
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00Z",
        integrity: "sha256-a",
      },
      {
        role: "code-reviewer",
        registry: "custom-registry",
        version: "2.0.0",
        installedAt: "2024-06-01T00:00:00Z",
        integrity: "sha256-b",
      },
    ]);

    const { list } = await importList();
    const { logs, run } = captureLogs(() => list([]));
    run();

    expect(logs[0]).toBe("Installed roles:");
    expect(logs[1]).toContain("architect");
    expect(logs[1]).toContain("oh-my-role");
    expect(logs[1]).toContain("1.0.0");
    expect(logs[2]).toContain("code-reviewer");
    expect(logs[2]).toContain("custom-registry");
    expect(logs[2]).toContain("2.0.0");
  });

  it("does not print table header when --json is used", async () => {
    await createLockFile([
      {
        role: "test-role",
        registry: "oh-my-role",
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00Z",
        integrity: "sha256-a",
      },
    ]);

    const { list } = await importList();
    const { logs, run } = captureLogs(() => list(["--json"]));
    run();

    expect(logs.some((c) => c.includes("Installed roles:"))).toBe(false);
  });
});

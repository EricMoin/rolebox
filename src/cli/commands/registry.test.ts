import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { dump, load } from "js-yaml";
import type { RegistryManifest } from "../types";

const regConfigDir = mkdtempSync(join(tmpdir(), "rolebox-reg-mod-config-"));
const regDataDir = mkdtempSync(join(tmpdir(), "rolebox-reg-mod-data-"));
process.env.XDG_CONFIG_HOME = regConfigDir;
process.env.XDG_DATA_HOME = regDataDir;

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
  rmSync(regConfigDir, { recursive: true, force: true });
  rmSync(regDataDir, { recursive: true, force: true });
});

const mockFetchManifest = mock();

let tmpConfigDir: string;
let origExit: typeof process.exit;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-registry-config-"));
  process.env.XDG_CONFIG_HOME = tmpConfigDir;

  mock.module("../registry-client", () => ({
    parseGitHubUrl: (url: string) => {
      let m = url.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
      );
      if (m) return { owner: m[1], repo: m[2] };
      m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m) return { owner: m[1], repo: m[2] };
      throw new Error(`invalid GitHub URL: "${url}"`);
    },
    fetchRegistryManifest: mockFetchManifest,
  }));

  origExit = process.exit;
  (process as any).exit = ((_code?: number) => {
    throw new Error("EXIT");
  }) as any;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  if (origExit) process.exit = origExit;
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

const sampleManifest: RegistryManifest = {
  name: "my-registry",
  description: "A test registry",
  url: "https://github.com/owner/repo",
  roles: {
    "test-role": { version: "1.0.0", description: "Test", tags: ["test"] },
  },
};

function capture(
  fn: () => Promise<void>,
): { out: string[]; err: string[]; run: () => Promise<void> } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => {
    out.push(args.map(String).join(" "));
  };
  console.warn = (...args) => {
    out.push(args.map(String).join(" "));
  };
  console.error = (...args) => {
    err.push(args.map(String).join(" "));
  };
  return {
    out,
    err,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
        console.error = origError;
        console.warn = origWarn;
      }
    },
  };
}

async function importRegistry() {
  return await import("./registry");
}

function configDir(): string {
  return join(tmpConfigDir, "rolebox");
}

function configPath(): string {
  return join(configDir(), "config.yaml");
}

describe("registry list", () => {
  it("shows the default oh-my-role registry when no config exists", async () => {
    const { registry } = await importRegistry();
    const c = capture(async () => registry(["list"]));
    await c.run();

    expect(c.out.some((l) => l.includes("oh-my-role"))).toBe(true);
    expect(c.out.some((l) => l.includes("(default)"))).toBe(true);
  });

  it("lists registries without a subcommand (defaults to list)", async () => {
    const { registry } = await importRegistry();
    const c = capture(async () => registry([]));
    await c.run();

    expect(c.out.some((l) => l.includes("oh-my-role"))).toBe(true);
  });
});

describe("registry add", () => {
  beforeEach(() => {
    mockFetchManifest.mockReset();
    mockFetchManifest.mockImplementation(async () => sampleManifest);
  });

  it("adds a new registry and persists to config", async () => {
    const { registry } = await importRegistry();
    const c = capture(async () =>
      registry(["add", "https://github.com/my-org/my-repo"]),
    );
    await c.run();

    expect(c.out.some((l) => l.includes("Added"))).toBe(true);
    expect(c.out.some((l) => l.includes("my-repo"))).toBe(true);

    const raw = readFileSync(configPath(), "utf-8");
    const parsed = load(raw) as any;
    expect(parsed.registries.some((r: any) => r.name === "my-repo")).toBe(true);
  });

  it("rejects an invalid GitHub URL", async () => {
    const { registry } = await importRegistry();
    await expect(registry(["add", "not-a-url"])).rejects.toThrow("EXIT");
  });

  it("rejects a duplicate registry name", async () => {
    const { registry } = await importRegistry();
    await registry(["add", "https://github.com/owner/dup-registry"]);
    await expect(
      registry(["add", "https://github.com/other/dup-registry"]),
    ).rejects.toThrow("EXIT");
  });

  it("rejects when no URL provided", async () => {
    const { registry } = await importRegistry();
    await expect(registry(["add"])).rejects.toThrow("EXIT");
  });

  it("validates the URL by fetching registry.yaml", async () => {
    const { registry } = await importRegistry();
    const c = capture(async () =>
      registry(["add", "https://github.com/validated/reg"]),
    );
    await c.run();

    expect(c.out.some((l) => l.includes("Added"))).toBe(true);
    expect(mockFetchManifest).toHaveBeenCalledTimes(1);
  });

  it("fails when fetchRegistryManifest throws", async () => {
    mockFetchManifest.mockReset();
    mockFetchManifest.mockRejectedValue(new Error("not found"));

    const { registry } = await importRegistry();
    await expect(
      registry(["add", "https://github.com/bad/registry"]),
    ).rejects.toThrow("EXIT");
  });
});

describe("registry remove", () => {
  it("removes a custom registry", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configPath(),
      dump({
        registries: [
          {
            name: "oh-my-role",
            url: "https://github.com/EricMoin/oh-my-role",
            default: true,
          },
          {
            name: "custom-registry",
            url: "https://github.com/custom/reg",
          },
        ],
      }),
      "utf-8",
    );

    const { registry } = await importRegistry();
    const c = capture(async () => registry(["remove", "custom-registry"]));
    await c.run();

    expect(c.out.some((l) => l.includes("Removed"))).toBe(true);

    const raw = readFileSync(configPath(), "utf-8");
    const parsed = load(raw) as any;
    expect(parsed.registries).toHaveLength(1);
    expect(parsed.registries[0].name).toBe("oh-my-role");
  });

  it("refuses to remove the default registry", async () => {
    const { registry } = await importRegistry();
    await expect(registry(["remove", "oh-my-role"])).rejects.toThrow("EXIT");
  });

  it("rejects removal of non-existent registry", async () => {
    const { registry } = await importRegistry();
    await expect(
      registry(["remove", "nonexistent-registry"]),
    ).rejects.toThrow("EXIT");
  });

  it("rejects removal when no name provided", async () => {
    const { registry } = await importRegistry();
    await expect(registry(["remove"])).rejects.toThrow("EXIT");
  });
});

describe("registry unknown subcommand", () => {
  it("rejects an unknown subcommand", async () => {
    const { registry } = await importRegistry();
    await expect(registry(["unknown-sub"])).rejects.toThrow("EXIT");
  });
});

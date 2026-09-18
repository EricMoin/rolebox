import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  escapeTomlString,
  normalizeLinkTarget,
  registerCodexPlugin,
  removeCodexPluginBundle,
  resolveRoleboxPackageRoot,
  unregisterCodexPlugin,
  writeCodexPluginBundle,
  type CodexPluginBundlePaths,
} from "../../src/platform/adapters/codex/plugin-bundle.ts";

// This file NEVER touches the developer's real Codex home: CODEX_HOME (and the
// XDG dirs rolebox itself uses) are redirected into mkdtemp directories, and
// the pi/dsh sync targets are redirected too. No test invokes a real sync.

const PACKAGE_ROOT = resolve(import.meta.dir, "..", "..");
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string }
).version;
const SERVER_ENTRY = join(PACKAGE_ROOT, "dist", "entries", "codex.js");

const MANAGED_START =
  "# >>> rolebox (managed) — do not edit; `rolebox sync codex` rewrites this block >>>";
const MANAGED_END = "# <<< rolebox (managed) <<<";

const ENV_KEYS = [
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PI_CODING_AGENT_DIR",
  "DSH_HOME",
] as const;

let savedEnv: Record<string, string | undefined>;
let codexHome: string;
let xdgConfig: string;
let xdgData: string;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function managedBlock(marketplaceDir: string): string {
  return [
    MANAGED_START,
    "[marketplaces.rolebox]",
    'source_type = "local"',
    `source = "${escapeTomlString(marketplaceDir)}"`,
    '[plugins."rolebox@rolebox"]',
    "enabled = true",
    MANAGED_END,
  ].join("\n");
}

function configPath(): string {
  return join(codexHome, "config.toml");
}

function marketplaceDir(): string {
  return join(codexHome, "rolebox-marketplace");
}

function bundlePaths(): CodexPluginBundlePaths {
  return {
    marketplaceDir: marketplaceDir(),
    pluginDir: join(marketplaceDir(), "plugins", "rolebox"),
    manifestPath: join(marketplaceDir(), "plugins", "rolebox", ".codex-plugin", "plugin.json"),
    mcpConfigPath: join(marketplaceDir(), "plugins", "rolebox", ".mcp.json"),
    marketplaceManifestPath: join(marketplaceDir(), ".agents", "plugins", "marketplace.json"),
    skillsLinkPath: join(marketplaceDir(), "plugins", "rolebox", "skills"),
    configPath: configPath(),
    serverEntry: SERVER_ENTRY,
    serverEntryExists: existsSync(SERVER_ENTRY),
  };
}

/** Normalize a symlink readback (Windows junctions carry a \\?\ prefix). */
function linkTarget(linkPath: string): string {
  return resolve(readlinkSync(linkPath).replace(/^\\\\\?\\/, ""));
}

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "rolebox-codex-home-"));
  xdgConfig = mkdtempSync(join(tmpdir(), "rolebox-codex-xdg-config-"));
  xdgData = mkdtempSync(join(tmpdir(), "rolebox-codex-xdg-data-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  process.env.CODEX_HOME = codexHome;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_DATA_HOME = xdgData;
  process.env.PI_CODING_AGENT_DIR = join(xdgConfig, "pi-agent");
  process.env.DSH_HOME = join(xdgConfig, "dsh-home");
});

afterEach(() => {
  for (const key of ENV_KEYS) restoreEnv(key, savedEnv[key]);
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(xdgConfig, { recursive: true, force: true });
  rmSync(xdgData, { recursive: true, force: true });
});

describe("writeCodexPluginBundle", () => {
  it("writes the evidenced plugin, MCP and marketplace files plus a skills symlink", () => {
    const bundle = writeCodexPluginBundle({
      codexHome,
      packageRoot: PACKAGE_ROOT,
      version: "9.9.9",
    });

    expect(bundle).toEqual(bundlePaths());

    // plugin.json — 2-space indent, trailing newline, rolebox identity.
    const manifestRaw = readFileSync(bundle.manifestPath, "utf-8");
    expect(manifestRaw.endsWith("\n")).toBe(true);
    expect(manifestRaw).toContain('\n  "name"');
    const manifest = JSON.parse(manifestRaw) as Record<string, any>;
    expect(manifest.name).toBe("rolebox");
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.description).toBe(
      "Define custom AI agent roles with per-role prompts, models, skills and permissions.",
    );
    expect(manifest.author).toEqual({ name: "rolebox" });
    expect(manifest.homepage).toBe("https://github.com/EricMoin/rolebox");
    expect(manifest.license).toBe("MIT");
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.interface).toEqual({
      displayName: "rolebox",
      shortDescription: "Role-based agents, skills and tools",
      longDescription:
        "Defines custom AI agent roles, each with its own prompts, models, skills and permissions, and exposes rolebox's role, skill and graph tools to Codex over MCP.",
      developerName: "rolebox",
      category: "Developer Tools",
      capabilities: ["Read", "Write"],
    });

    // .mcp.json — absolute server entry launched by node.
    const mcp = JSON.parse(readFileSync(bundle.mcpConfigPath, "utf-8")) as Record<string, any>;
    expect(mcp).toEqual({
      mcpServers: {
        rolebox: {
          command: "node",
          args: [SERVER_ENTRY],
          startup_timeout_sec: 60,
          tool_timeout_sec: 600,
        },
      },
    });
    expect(isAbsolute(mcp.mcpServers.rolebox.args[0])).toBe(true);

    // marketplace.json — local source pointing at the plugin directory.
    const marketplace = JSON.parse(
      readFileSync(bundle.marketplaceManifestPath, "utf-8"),
    ) as Record<string, any>;
    expect(marketplace).toEqual({
      name: "rolebox",
      interface: { displayName: "rolebox" },
      plugins: [
        {
          name: "rolebox",
          source: { source: "local", path: "./plugins/rolebox" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
    });

    // skills symlink -> <codexHome>/skills (directory link, target exists).
    expect(lstatSync(bundle.skillsLinkPath).isSymbolicLink()).toBe(true);
    expect(linkTarget(bundle.skillsLinkPath)).toBe(resolve(join(codexHome, "skills")));
    expect(lstatSync(join(codexHome, "skills")).isDirectory()).toBe(true);
  });

  it("honours serverEntry and runtimeCommand overrides", () => {
    const customEntry = join(codexHome, "custom-server.js");
    const opts = {
      codexHome,
      packageRoot: PACKAGE_ROOT,
      version: "1.0.0",
      serverEntry: customEntry,
      runtimeCommand: "bun",
    };

    // A missing artifact is reported, never thrown — the bundle still writes.
    const bundle = writeCodexPluginBundle(opts);
    const mcp = JSON.parse(readFileSync(bundle.mcpConfigPath, "utf-8")) as Record<string, any>;
    expect(mcp.mcpServers.rolebox.command).toBe("bun");
    expect(mcp.mcpServers.rolebox.args).toEqual([customEntry]);
    expect(bundle.serverEntryExists).toBe(false);

    writeFileSync(customEntry, "// built entry\n", "utf-8");
    expect(writeCodexPluginBundle(opts).serverEntryExists).toBe(true);
  });

  it("is idempotent — a second write leaves bytes and the skills link identical", () => {
    const opts = { codexHome, packageRoot: PACKAGE_ROOT, version: "1.2.3" };
    const first = writeCodexPluginBundle(opts);
    const snapshot = {
      manifest: readFileSync(first.manifestPath, "utf-8"),
      mcp: readFileSync(first.mcpConfigPath, "utf-8"),
      marketplace: readFileSync(first.marketplaceManifestPath, "utf-8"),
      link: readlinkSync(first.skillsLinkPath),
      ino: lstatSync(first.skillsLinkPath).ino,
    };

    const second = writeCodexPluginBundle(opts);

    expect(second).toEqual(first);
    expect(readFileSync(second.manifestPath, "utf-8")).toBe(snapshot.manifest);
    expect(readFileSync(second.mcpConfigPath, "utf-8")).toBe(snapshot.mcp);
    expect(readFileSync(second.marketplaceManifestPath, "utf-8")).toBe(snapshot.marketplace);
    expect(readlinkSync(second.skillsLinkPath)).toBe(snapshot.link);
    expect(lstatSync(second.skillsLinkPath).ino).toBe(snapshot.ino);
  });
});

describe("escapeTomlString", () => {
  it("escapes the TOML basic-string short escapes", () => {
    expect(escapeTomlString('a\\b"c')).toBe('a\\\\b\\"c');
    expect(escapeTomlString("\b\t\n\f\r")).toBe("\\b\\t\\n\\f\\r");
  });

  it("writes the remaining control characters as \\uXXXX and leaves the rest alone", () => {
    expect(escapeTomlString("\u0000\u001b\u007f")).toBe("\\u0000\\u001B\\u007F");
    // Non-ASCII and ordinary path characters are untouched.
    expect(escapeTomlString("/home/üsér/日本語/codex")).toBe("/home/üsér/日本語/codex");
  });
});

describe("normalizeLinkTarget", () => {
  it("strips the Windows extended-length prefix from a drive path", () => {
    expect(normalizeLinkTarget("\\\\?\\C:\\Users\\dev\\rolebox")).toBe("C:\\Users\\dev\\rolebox");
  });

  it("collapses a UNC junction to a plain UNC path", () => {
    expect(normalizeLinkTarget("\\\\?\\UNC\\server\\share\\dir")).toBe("\\\\server\\share\\dir");
  });

  it("leaves a plain path untouched", () => {
    expect(normalizeLinkTarget("/home/dev/.codex/skills")).toBe("/home/dev/.codex/skills");
  });
});

describe("registerCodexPlugin / unregisterCodexPlugin", () => {
  it("creates a missing config.toml containing only the managed block", () => {
    const result = registerCodexPlugin(configPath(), marketplaceDir());

    expect(result).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(`${managedBlock(marketplaceDir())}\n`);
  });

  it("appends the block after a single blank line and preserves the existing bytes", () => {
    const original = '# my codex settings\nmodel = "gpt-5"\n';
    writeFileSync(configPath(), original, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });

    const after = readFileSync(configPath(), "utf-8");
    expect(after.startsWith(original)).toBe(true);
    expect(after).toBe(`${original}\n${managedBlock(marketplaceDir())}\n`);
  });

  it("adds exactly one leading newline when the file lacks a trailing one", () => {
    const original = 'model = "gpt-5"';
    writeFileSync(configPath(), original, "utf-8");

    registerCodexPlugin(configPath(), marketplaceDir());

    expect(readFileSync(configPath(), "utf-8")).toBe(
      `${original}\n${managedBlock(marketplaceDir())}\n`,
    );
  });

  it("restores a file that lacked a trailing newline byte for byte on unregister", () => {
    const original = 'model = "gpt-5"';
    writeFileSync(configPath(), original, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(
      `${original}\n${managedBlock(marketplaceDir())}\n`,
    );

    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("re-registers in place — a second call is byte-identical and reports unchanged", () => {
    const original = "[mcp_servers.other]\ncommand = \"other\"\n";
    writeFileSync(configPath(), original, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir()).changed).toBe(true);
    const afterFirst = readFileSync(configPath(), "utf-8");

    const second = registerCodexPlugin(configPath(), marketplaceDir());

    expect(second.changed).toBe(false);
    expect(readFileSync(configPath(), "utf-8")).toBe(afterFirst);
    // the pre-existing table is still there, exactly once
    expect(afterFirst.match(/\[mcp_servers\.other\]/g)).toHaveLength(1);
  });

  it("escapes backslashes and quotes in the marketplace source path", () => {
    const weird = join(codexHome, 'we"ird\\dir');

    registerCodexPlugin(configPath(), weird);

    const raw = readFileSync(configPath(), "utf-8");
    const sourceLine = raw.split("\n").find((line) => line.startsWith("source = "));
    expect(sourceLine).toBe(`source = "${escapeTomlString(weird)}"`);
  });

  it("preserves unrelated tables and comments verbatim and restores the original bytes on unregister", () => {
    const original = [
      "# my codex config",
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "other-server"',
      'args = ["--flag"]',
      "",
    ].join("\n");
    writeFileSync(configPath(), original, "utf-8");

    registerCodexPlugin(configPath(), marketplaceDir());
    const withBlock = readFileSync(configPath(), "utf-8");
    expect(withBlock.startsWith(original)).toBe(true);
    expect(withBlock).toContain(original + "\n" + MANAGED_START);

    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("unregister is a no-op when the file has no managed block", () => {
    const original = "[mcp_servers.other]\ncommand = \"other\"\n";
    writeFileSync(configPath(), original, "utf-8");

    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: false });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("unregister is a no-op when config.toml does not exist", () => {
    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: false });
    expect(existsSync(configPath())).toBe(false);
  });

  it("round-trips: register -> unregister -> register yields the same file", () => {
    registerCodexPlugin(configPath(), marketplaceDir());
    const first = readFileSync(configPath(), "utf-8");

    unregisterCodexPlugin(configPath());
    expect(readFileSync(configPath(), "utf-8")).toBe("");

    registerCodexPlugin(configPath(), marketplaceDir());
    expect(readFileSync(configPath(), "utf-8")).toBe(first);
  });

  it("ignores the start marker when it appears inside a TOML string", () => {
    const original = `note = "${MANAGED_START}"\nmodel = "gpt-5"\n`;
    writeFileSync(configPath(), original, "utf-8");
    registerCodexPlugin(configPath(), marketplaceDir());
    const registered = readFileSync(configPath(), "utf-8");

    // The note line survives and the real block is recognized as the region,
    // so re-registering is byte-identical instead of eating the note line.
    expect(registered).toBe(`${original}\n${managedBlock(marketplaceDir())}\n`);
    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: false });
    expect(readFileSync(configPath(), "utf-8")).toBe(registered);
  });

  it("ignores marker lines inside a multi-line TOML string and keeps the user bytes", () => {
    const original = `note = """\n${MANAGED_START}\n"""\nmodel = "gpt-5"\n`;
    writeFileSync(configPath(), `${original}\n${managedBlock("/stale/marketplace")}\n`, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(
      `${original}\n${managedBlock(marketplaceDir())}\n`,
    );
    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: false });

    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("ignores start and end markers inside a multi-line literal string", () => {
    const original = `note = '''\n${MANAGED_START}\n${MANAGED_END}\n'''\n`;
    writeFileSync(configPath(), original, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(
      `${original}\n${managedBlock(marketplaceDir())}\n`,
    );
    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: false });
  });

  it("does not refuse a start marker that is only multi-line string content", () => {
    const original = `note = """\n${MANAGED_START}\n"""\n`;
    writeFileSync(configPath(), original, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(
      `${original}\n${managedBlock(marketplaceDir())}\n`,
    );
  });

  it("does not open a string on a comment or on a triple quote closed in place", () => {
    const original = '# cite """ in a comment\nnote = """ok"""\nmodel = "gpt-5"\n';
    writeFileSync(configPath(), original, "utf-8");

    registerCodexPlugin(configPath(), marketplaceDir());
    const registered = readFileSync(configPath(), "utf-8");

    expect(registered).toBe(`${original}\n${managedBlock(marketplaceDir())}\n`);
    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: false });
  });

  it("recognizes an indented managed block", () => {
    const original = 'model = "gpt-5"\n';
    writeFileSync(configPath(), original, "utf-8");
    registerCodexPlugin(configPath(), marketplaceDir());
    const registered = readFileSync(configPath(), "utf-8");
    writeFileSync(configPath(), registered.replace(`${MANAGED_START}\n`, `  ${MANAGED_START}\n`), "utf-8");

    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("refuses a lone start marker instead of appending a second block", () => {
    const original = `model = "gpt-5"\n${MANAGED_START}\n`;
    writeFileSync(configPath(), original, "utf-8");

    let error: Error | undefined;
    try {
      registerCodexPlugin(configPath(), marketplaceDir());
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(configPath());
    expect(error?.message).toContain(MANAGED_START);
    expect(error?.message).toContain(MANAGED_END);
    expect(error?.message).toMatch(/remove the stray start marker/i);
    // No second block was appended and the user's bytes are untouched.
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("repairs duplicate managed blocks: the first is refreshed and the rest removed", () => {
    const original = '# user config\nmodel = "gpt-5"\n';
    const stale = managedBlock("/stale/marketplace");
    writeFileSync(configPath(), `${original}\n${stale}\n${stale}\n`, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(
      `${original}\n${managedBlock(marketplaceDir())}\n`,
    );
    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: false });
  });

  it("removes every duplicate managed block on unregister", () => {
    const original = 'model = "gpt-5"\n';
    writeFileSync(
      configPath(),
      `${original}\n${managedBlock(marketplaceDir())}\n${managedBlock("/other/marketplace")}\n`,
      "utf-8",
    );

    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("restores a CRLF config byte for byte on unregister", () => {
    const original = 'model = "gpt-5"\r\n[mcp_servers.other]\r\n';
    writeFileSync(configPath(), original, "utf-8");

    expect(registerCodexPlugin(configPath(), marketplaceDir())).toEqual({ changed: true });
    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(original);
  });

  it("keeps user content appended after the block on unregister", () => {
    const original = 'model = "gpt-5"\n';
    writeFileSync(configPath(), original, "utf-8");
    registerCodexPlugin(configPath(), marketplaceDir());

    appendFileSync(configPath(), 'approval_policy = "never"\n');
    expect(unregisterCodexPlugin(configPath())).toEqual({ changed: true });
    expect(readFileSync(configPath(), "utf-8")).toBe(`${original}approval_policy = "never"\n`);
  });
});

describe("removeCodexPluginBundle", () => {
  it("removes the marketplace directory and reports whether it existed", () => {
    writeCodexPluginBundle({ codexHome, packageRoot: PACKAGE_ROOT, version: "1.0.0" });

    expect(removeCodexPluginBundle(codexHome)).toEqual({ removed: true });
    expect(existsSync(marketplaceDir())).toBe(false);
    expect(removeCodexPluginBundle(codexHome)).toEqual({ removed: false });
  });
});

describe("resolveRoleboxPackageRoot", () => {
  it("walks up from a module URL to the directory containing package.json", () => {
    expect(resolveRoleboxPackageRoot(import.meta.url)).toBe(PACKAGE_ROOT);
  });

  it("throws when no package.json exists in the bounded ancestor chain", () => {
    expect(() => resolveRoleboxPackageRoot("file:///nonexistent/a/b/c/mod.ts")).toThrow(
      /Could not resolve the rolebox package root/,
    );
  });
});

describe("rolebox sync codex", () => {
  async function runSyncResult(
    target = "codex",
  ): Promise<{ logs: string[]; error: unknown }> {
    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    let error: unknown;
    try {
      const { sync } = await import("../../src/cli/commands/sync.ts");
      await sync(target);
    } catch (caught) {
      error = caught;
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    return { logs, error };
  }

  async function runSync(target = "codex"): Promise<string[]> {
    const { logs, error } = await runSyncResult(target);
    if (error !== undefined) throw error;
    return logs;
  }

  it("writes the plugin bundle and registers it in the Codex config", async () => {
    const logs = await runSync();
    const output = logs.join("\n");

    const bundle = bundlePaths();
    expect(output).toContain("Synced 0 roles to codex");
    expect(output).toContain(
      `Codex plugin: registered ${bundle.marketplaceDir} in ${bundle.configPath}`,
    );

    // Four generated files.
    expect(existsSync(bundle.manifestPath)).toBe(true);
    expect(existsSync(bundle.mcpConfigPath)).toBe(true);
    expect(existsSync(bundle.marketplaceManifestPath)).toBe(true);
    expect(existsSync(bundle.configPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(bundle.manifestPath, "utf-8")) as Record<string, any>;
    expect(manifest.name).toBe("rolebox");
    // The version is read from package.json — never hardcoded.
    expect(manifest.version).toBe(PACKAGE_VERSION);

    const mcp = JSON.parse(readFileSync(bundle.mcpConfigPath, "utf-8")) as Record<string, any>;
    expect(mcp.mcpServers.rolebox.command).toBe("node");
    expect(isAbsolute(mcp.mcpServers.rolebox.args[0])).toBe(true);
    expect(mcp.mcpServers.rolebox.args[0]).toBe(SERVER_ENTRY);

    expect(lstatSync(bundle.skillsLinkPath).isSymbolicLink()).toBe(true);
    expect(linkTarget(bundle.skillsLinkPath)).toBe(resolve(join(codexHome, "skills")));

    // The missing-artifact warning is driven by the real entry's existence,
    // so assert whichever branch this checkout is in.
    const missingEntryWarning = `Warning: the Codex MCP server entry ${SERVER_ENTRY} does not exist`;
    if (existsSync(SERVER_ENTRY)) {
      expect(output).not.toContain(missingEntryWarning);
    } else {
      expect(output).toContain(missingEntryWarning);
      expect(output).toContain("Build or reinstall rolebox before starting Codex");
    }

    const config = readFileSync(bundle.configPath, "utf-8");
    expect(config).toContain(MANAGED_START);
    expect(config).toContain("[marketplaces.rolebox]");
    expect(config).toContain('source_type = "local"');
    expect(config).toContain(`source = "${escapeTomlString(bundle.marketplaceDir)}"`);
    expect(config).toContain('[plugins."rolebox@rolebox"]');
    expect(config).toContain("enabled = true");
    expect(config).toContain(MANAGED_END);
  });

  // Binding compatibility constraint: the Codex branch is codex-only, so every
  // other target keeps its previous output and does no Codex filesystem work.
  for (const target of ["opencode", "pi", "dsh"] as const) {
    it(`leaves the Codex home untouched when syncing ${target}`, async () => {
      const logs = await runSync(target);
      const output = logs.join("\n");

      expect(output).toContain(`Synced 0 roles to ${target}`);
      expect(output).not.toContain("Codex plugin:");
      expect(existsSync(marketplaceDir())).toBe(false);
      expect(existsSync(configPath())).toBe(false);
      expect(existsSync(join(codexHome, "skills"))).toBe(false);
    });
  }

  it("is idempotent — two sync runs leave the bundle and config byte-identical", async () => {
    await runSync();
    const bundle = bundlePaths();
    const snapshot = {
      manifest: readFileSync(bundle.manifestPath, "utf-8"),
      mcp: readFileSync(bundle.mcpConfigPath, "utf-8"),
      marketplace: readFileSync(bundle.marketplaceManifestPath, "utf-8"),
      config: readFileSync(bundle.configPath, "utf-8"),
    };

    const logs = await runSync();

    expect(logs.join("\n")).toContain("Synced 0 roles to codex");
    expect(readFileSync(bundle.manifestPath, "utf-8")).toBe(snapshot.manifest);
    expect(readFileSync(bundle.mcpConfigPath, "utf-8")).toBe(snapshot.mcp);
    expect(readFileSync(bundle.marketplaceManifestPath, "utf-8")).toBe(snapshot.marketplace);
    expect(readFileSync(bundle.configPath, "utf-8")).toBe(snapshot.config);
  });

  it("preserves a pre-existing Codex config while registering", async () => {
    const original = '# user config\nmodel = "gpt-5"\n';
    writeFileSync(configPath(), original, "utf-8");

    await runSync();

    const after = readFileSync(configPath(), "utf-8");
    expect(after.startsWith(original)).toBe(true);
    expect(after).toContain(MANAGED_START);
    expect(after).toContain(MANAGED_END);
  });

  it("warns with the missing server entry path before Codex is started", async () => {
    const { warnIfCodexServerEntryMissing } = await import("../../src/cli/commands/sync.ts");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      warnIfCodexServerEntryMissing({ serverEntry: "/missing/entry.js", serverEntryExists: false });
      warnIfCodexServerEntryMissing({ serverEntry: SERVER_ENTRY, serverEntryExists: true });
    } finally {
      console.warn = origWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/missing/entry.js");
    expect(warnings[0]).toContain("Build or reinstall rolebox before starting Codex");
  });

  it("reports the partial Codex sync when config.toml registration fails, then rethrows", async () => {
    const original = `model = "gpt-5"\n${MANAGED_START}\n`;
    writeFileSync(configPath(), original, "utf-8");

    const { logs, error } = await runSyncResult();
    const output = logs.join("\n");

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("without a matching end marker");
    // The bundle WAS written; the registration was not.
    const bundle = bundlePaths();
    expect(existsSync(bundle.marketplaceDir)).toBe(true);
    expect(existsSync(bundle.mcpConfigPath)).toBe(true);
    expect(readFileSync(bundle.configPath, "utf-8")).toBe(original);
    // The report names both halves and says a retry is safe.
    expect(output).toContain(`wrote the marketplace directory ${bundle.marketplaceDir}`);
    expect(output).toContain(`registering it in ${bundle.configPath} failed`);
    expect(output).toContain("without a matching end marker");
    expect(output).toContain("safe to repeat");
  });
});

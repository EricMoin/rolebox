/// <reference types="bun-types" />

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { codexPlatformPaths } from "../../src/platform/paths.ts";
import { PLATFORM_REGISTRY, getPlatformDescriptor } from "../../src/platform/registry.ts";
import { codexCapabilities } from "../../src/platform/capabilities.ts";

// Every Codex path this file touches is redirected through CODEX_HOME (and the
// fake HOME) to a mkdtemp directory — the developer's real ~/.codex is never
// read or written.

let codexHome: string;

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeCodexConfig(text: string): string {
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, text, "utf-8");
  return configPath;
}

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "rolebox-codex-home-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  restoreEnv("CODEX_HOME", ORIGINAL_CODEX_HOME);
  rmSync(codexHome, { recursive: true, force: true });
});

describe("codexPlatformPaths", () => {
  it("resolves every path under CODEX_HOME when it is set", () => {
    const paths = codexPlatformPaths();

    expect(paths.platformId).toBe("codex");
    expect(paths.configDir).toBe(codexHome);
    expect(paths.agentsDir).toBe(join(codexHome, "skills"));
    expect(paths.skillsDir).toBe(join(codexHome, "skills"));
    // Codex has no rolebox-owned sessions directory — nothing is invented.
    expect(paths.sessionsDir).toBeUndefined();
  });

  // The fallback is asserted against os.homedir(), exactly like the dsh/pi
  // cases in tests/platform/paths.test.ts: Bun's os.homedir() resolves the real
  // passwd entry and ignores a faked $HOME, so the honest contract is
  // "${homedir()}/.codex". Nothing here touches the filesystem.
  it("treats a blank CODEX_HOME as unset and falls back to ~/.codex", () => {
    const fallback = join(homedir(), ".codex");

    process.env.CODEX_HOME = "";
    expect(codexPlatformPaths().configDir).toBe(fallback);

    process.env.CODEX_HOME = "   ";
    expect(codexPlatformPaths().configDir).toBe(fallback);
  });

  it("falls back to the home-directory .codex when CODEX_HOME is unset", () => {
    delete process.env.CODEX_HOME;

    const paths = codexPlatformPaths();

    expect(paths.configDir).toBe(join(homedir(), ".codex"));
    expect(paths.agentsDir).toBe(join(homedir(), ".codex", "skills"));
    expect(paths.skillsDir).toBe(join(homedir(), ".codex", "skills"));
  });

  it("reads CODEX_HOME at call time rather than capturing it at module load", () => {
    const first = codexPlatformPaths().configDir;
    const second = mkdtempSync(join(tmpdir(), "rolebox-codex-home2-"));
    try {
      process.env.CODEX_HOME = second;
      expect(codexPlatformPaths().configDir).toBe(second);
      expect(codexPlatformPaths().configDir).not.toBe(first);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("codex registry descriptor", () => {
  it("is registered after dsh with the Codex label and resolvable by id", () => {
    expect(PLATFORM_REGISTRY.map((p) => p.id)).toEqual(["opencode", "pi", "dsh", "codex"]);

    const descriptor = getPlatformDescriptor("codex");
    expect(descriptor.id).toBe("codex");
    expect(descriptor.label).toBe("Codex");
    expect(descriptor.paths).toBe(codexPlatformPaths);
    expect(descriptor.paths().configDir).toBe(codexHome);
  });

  it("reports not registered when config.toml does not exist", () => {
    const integration = getPlatformDescriptor("codex").detectIntegration();

    expect(integration?.mechanism).toBe("Plugin + MCP");
    expect(integration?.registered).toBe(false);
    expect(integration?.detail).toBe("not found in codex config");
    expect(integration?.hint).toContain("rolebox sync codex");
    expect(integration?.hint).toContain(join(codexHome, "config.toml"));
  });

  it("reports not registered for an unrelated config.toml", () => {
    writeCodexConfig(
      [
        "# [marketplaces.rolebox] — commented out, must not count",
        'model = "gpt-5"',
        "",
        "[mcp_servers.other]",
        'command = "other-server"',
        "",
        '[plugins."other@other"]',
        "enabled = true",
        "",
      ].join("\n"),
    );

    const integration = getPlatformDescriptor("codex").detectIntegration();

    expect(integration?.registered).toBe(false);
    expect(integration?.detail).toBe("not found in codex config");
  });

  it("detects the [mcp_servers.rolebox] registration form", () => {
    writeCodexConfig('[mcp_servers.rolebox]\ncommand = "node"\nargs = ["/tmp/server.js"]\n');

    const integration = getPlatformDescriptor("codex").detectIntegration();

    expect(integration?.registered).toBe(true);
    expect(integration?.detail).toBe("registered");
    expect(integration?.hint).toBeUndefined();
  });

  it("detects the [marketplaces.rolebox] registration form, tolerating inner whitespace", () => {
    writeCodexConfig('[ marketplaces . rolebox ]\nsource_type = "local"\nsource = "/tmp/market"\n');

    expect(getPlatformDescriptor("codex").detectIntegration()?.registered).toBe(true);
  });

  it('detects the [plugins."rolebox@..."] registration form', () => {
    writeCodexConfig('[plugins."rolebox@rolebox"]\nenabled = true\n');

    expect(getPlatformDescriptor("codex").detectIntegration()?.registered).toBe(true);
  });
});

describe("codexCapabilities", () => {
  it("declares the minimal MCP-only capability shape explicitly", () => {
    expect(codexCapabilities()).toEqual({
      hasBackgroundTasks: false,
      hasSessionFork: false,
      hasSessionCreate: false,
      hasSessionAbort: false,
      hasAgentFileSync: false,
      hasMultiStepTools: true,
      hasEventStream: false,
      hasSessionStatus: false,
      hasRoleSwitch: false,
      platformId: "codex",
    });
  });
});

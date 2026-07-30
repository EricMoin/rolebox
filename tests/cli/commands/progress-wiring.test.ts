import { describe, it, expect, mock, beforeEach, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RegistryManifest } from "../../../src/cli/types";
import type { DownloadProgressOptions } from "../../../src/cli/download-progress";

const mockFetchManifest = mock();
const mockDownloadRole = mock();
const mockResolveVersion = mock();
const mockComputeIntegrity = mock();

import { DownloadProgress } from "../../../src/cli/download-progress";

// The real registry-client is needed so the beforeEach stub can spread its full
// export surface while overriding only the install-path functions with the mocks
// below. Under `bun test --isolate` the module registry is per-file, so a static
// import resolves to the real on-disk module — no cache-busting required.
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
  },
};

let tmpConfigDir: string;
let tmpDataDir: string;
let tmpExtractedDir: string;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-progress-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-progress-data-"));
  tmpExtractedDir = mkdtempSync(join(tmpdir(), "rolebox-progress-extracted-"));

  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;

  mock.module("../../../src/cli/registry-client", () => ({
    ...realRegistryClient,
    fetchRegistryManifest: mockFetchManifest,
    downloadRole: mockDownloadRole,
    resolveVersion: mockResolveVersion,
    computeIntegrity: mockComputeIntegrity,
  }));

  const unimplemented = (name: string) => () => { throw new Error(`${name} called without mock implementation`); };
  mockFetchManifest.mockImplementation(unimplemented("fetchRegistryManifest"));
  mockDownloadRole.mockImplementation(unimplemented("downloadRole"));
  mockResolveVersion.mockImplementation(unimplemented("resolveVersion"));
  mockComputeIntegrity.mockImplementation(unimplemented("computeIntegrity"));
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
  try { rmSync(tmpExtractedDir, { recursive: true, force: true }); } catch { /* already gone */ }
});

function createMockExtractedDir(roleId: string): string {
  const dir = join(tmpExtractedDir, `mock-${roleId}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.yaml"), `name: ${roleId}\ndescription: Test role\n`, "utf-8");
  return dir;
}

function setupBasicMocks(version = "1.0.0") {
  mockFetchManifest.mockImplementation(async () => sampleManifest);
  mockResolveVersion.mockImplementation(() => version);
  mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
  mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");
}

async function importInstall() {
  // Cache-bust so each call re-evaluates the command module against the mocks
  // registered in beforeEach rather than reusing a previously cached instance.
  return await import(
    "../../../src/cli/commands/install.ts?t=" + Date.now() + "-" + Math.random()
  );
}

async function importUpdate() {
  return await import(
    "../../../src/cli/commands/update.ts?t=" + Date.now() + "-" + Math.random()
  );
}

/** Capture writes to process.stdout (the DownloadProgress sink) around fn(). */
function captureStdout(fn: () => Promise<void>): { stdout: string[]; run: () => Promise<void> } {
  const stdout: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any) => { stdout.push(String(chunk)); return true; }) as any;
  return {
    stdout,
    run: async () => {
      try { await fn(); } finally { process.stdout.write = origWrite; }
    },
  };
}

/** Capture console.log / console.warn around fn(). */
function captureLogs(fn: () => Promise<void>): { logs: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args[0]); origLog.apply(console, args as any); };
  console.warn = (...args: any[]) => { logs.push(args[0]); origWarn.apply(console, args as any); };
  return {
    logs,
    run: async () => {
      try { await fn(); } finally { console.log = origLog; console.warn = origWarn; }
    },
  };
}

// ── DownloadProgress rendering guards ─────────────────────────────────
//
// (b) degraded non-TTY emits plain periodic lines with no ANSI.
// (c) NO_COLOR / TERM=dumb / --no-progress each suppress ANSI.
// (d) --quiet suppresses non-error output but phaseFail still surfaces.

function makeHarness(opts: DownloadProgressOptions = {}) {
  const chunks: string[] = [];
  let t = 0;
  const progress = new DownloadProgress({
    write: (s: string) => chunks.push(s),
    now: () => t,
    isTTY: true,
    env: {},
    ...opts,
  });
  return { chunks, progress, advance: (ms: number) => (t += ms) };
}

describe("DownloadProgress degraded non-TTY mode", () => {
  it("emits periodic plain lines with no ANSI escapes or carriage returns", () => {
    const { chunks, progress, advance } = makeHarness({ isTTY: false });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    advance(2100);
    progress.update({ received: 870400, total: 1934222 });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\r");
    expect(joined).toContain("→");
    expect(joined).toContain("850KB");
  });
});

describe("DownloadProgress ANSI suppression", () => {
  it("NO_COLOR suppresses ANSI color on a TTY but still redraws in place", () => {
    const { chunks, progress } = makeHarness({ isTTY: true, env: { NO_COLOR: "1" } });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.update({ received: 512, total: 1024 });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    expect(chunks[chunks.length - 1].startsWith("\r")).toBe(true);
  });

  it("TERM=dumb degrades to plain lines even on a TTY", () => {
    const { chunks, progress } = makeHarness({ isTTY: true, env: { TERM: "dumb" } });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.update({ received: 512, total: 1024 });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\r");
    expect(joined).toContain("→");
  });

  it("--no-progress (noProgress) forces degraded plain lines on a TTY", () => {
    const { chunks, progress } = makeHarness({ isTTY: true, noProgress: true });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.update({ received: 512, total: 1024 });
    const joined = chunks.join("");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\r");
    expect(joined).toContain("→");
  });
});

describe("DownloadProgress quiet mode", () => {
  it("suppresses all non-error output but phaseFail still surfaces", () => {
    const { chunks, progress } = makeHarness({ isTTY: true, quiet: true });
    progress.phaseStart("downloading", "acme/architect@2.0.0");
    progress.phaseComplete("downloading", "acme/architect@2.0.0");
    progress.update({ received: 512, total: 1024 });
    expect(chunks.length).toBe(0);

    progress.phaseFail("downloading", {
      asset: "acme/architect@2.0.0",
      reason: "network error downloading role \"architect\": boom",
      attempt: 1,
      maxAttempts: 1,
    });
    expect(chunks.join("")).toContain("boom");
  });
});

// ── Command wiring: phase markers on stdout ──────────────────────────
//
// (a) install/update emit the phase markers they own (resolving /
// installing / done) to stdout via the DownloadProgress sink. The
// downloading / verifying / extracting markers are emitted inside the real
// downloadRole and covered in tests/cli/download-progress-streaming.test.ts.

describe("install progress wiring", () => {
  it("emits resolving / installing / done phase markers to stdout", async () => {
    setupBasicMocks();
    const { install } = await importInstall();
    const { stdout, run } = captureStdout(async () => { await install("software-architect"); });
    await run();

    const all = stdout.join("");
    expect(all).toContain("resolving");
    expect(all).toContain("installing");
    expect(all).toContain("done");
  });

  it("--quiet suppresses phase markers and success/hint output", async () => {
    setupBasicMocks();
    const { install } = await importInstall();
    const { stdout, run } = captureStdout(async () => { await install("software-architect", { quiet: true }); });
    const { logs, run: runLogs } = captureLogs(async () => { await install("software-architect", { quiet: true }); });
    await run();
    await runLogs();

    expect(stdout.join("")).toBe("");
    expect(logs.some((c) => c.includes("Installed"))).toBe(false);

    // quiet still performs the install work
    const expectedPath = join(tmpDataDir, "rolebox", "roles", "oh-my-role", "software-architect@1.0.0");
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("--quiet still surfaces errors (rejects)", async () => {
    mockFetchManifest.mockImplementation(async () => sampleManifest);
    mockResolveVersion.mockImplementation(() => {
      throw new Error('role "nope" not found in registry "oh-my-role"');
    });

    const { install } = await importInstall();
    await expect(install("nope", { quiet: true })).rejects.toThrow(/not found/);
  });
});

describe("update progress wiring", () => {
  it("emits resolving / installing / done phase markers to stdout", async () => {
    const { dump } = await import("js-yaml");
    const configDir = join(tmpConfigDir, "rolebox");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), dump({
      registries: [{ name: "oh-my-role", url: "https://github.com/EricMoin/oh-my-role" }],
    }), "utf-8");
    writeFileSync(join(configDir, "rolebox.lock"), dump({
      version: 1,
      roles: [{ role: "software-architect", registry: "oh-my-role", version: "1.0.0", installedAt: "2025-01-01T00:00:00.000Z", integrity: "sha256-abc123" }],
    }), "utf-8");

    // registry version is 2.0.0 so an update actually proceeds through
    // downloadRole → installing → done
    mockFetchManifest.mockImplementation(async () => ({
      name: "oh-my-role",
      description: "Official role registry",
      url: "https://github.com/EricMoin/oh-my-role",
      roles: { "software-architect": { version: "2.0.0", description: "Software architect role", tags: ["architecture"] } },
    }));
    mockDownloadRole.mockImplementation(async () => createMockExtractedDir("software-architect"));
    mockComputeIntegrity.mockImplementation(async () => "sha256-abc123");

    const { update } = await importUpdate();
    const { stdout, run } = captureStdout(async () => { await update(undefined, false); });
    await run();

    const all = stdout.join("");
    expect(all).toContain("resolving");
    expect(all).toContain("installing");
    expect(all).toContain("done");
  });
});

describe("parseRoleSpec smoke", () => {
  let parseRoleSpec: (spec: string) => any;
  beforeAll(async () => {
    const mod = await importInstall();
    parseRoleSpec = mod.parseRoleSpec;
  });

  it("still parses (module loads cleanly)", () => {
    expect(parseRoleSpec("software-architect@1.0.0")).toEqual({ roleId: "software-architect", version: "1.0.0" });
  });
});

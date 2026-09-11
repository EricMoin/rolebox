import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// This file exercises the REAL paths module. Under `bun test --isolate` each
// test file has its own module registry, so a static import resolves to the
// real module regardless of mock.module calls registered by other test files.
//
// To ALSO stay correct when the suite runs in a shared process (plain `bun test`
// WITHOUT `--isolate`), the real module is loaded via a cache-busted
// query-string specifier (`?real`). A prior test file's `mock.module("...paths")`
// registration would otherwise shadow a bare static import and break these
// ROLEBOX_* / win32 branch assertions. The distinct specifier is never covered
// by a mock keyed to the bare path (same technique as tests/cli/e2e.test.ts).
const _REAL_PATHS_SPECIFIER = "../../src/cli/paths.ts?real";
const paths = await import(_REAL_PATHS_SPECIFIER);
const {
  getDataDir,
  getConfigDir,
  getRolesDir,
  getSyncTarget,
  getRolePath,
  assertSafePathSegment,
  getPlatform,
  setPlatformForTest,
} = paths;

// Save/restore env vars to prevent pollution from other test files
let savedVars: Record<string, string | undefined>;

beforeEach(() => {
  savedVars = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    ROLEBOX_DATA_DIR: process.env.ROLEBOX_DATA_DIR,
    ROLEBOX_CONFIG_DIR: process.env.ROLEBOX_CONFIG_DIR,
  };
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.ROLEBOX_DATA_DIR;
  delete process.env.ROLEBOX_CONFIG_DIR;
});

afterEach(() => {
  Object.entries(savedVars).forEach(([k, v]) => {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  });
  setPlatformForTest(undefined);
});

import { ensureWritableDir } from "../../src/cli/fs-utils";
import { toPosixPath } from "../../src/utils/paths";

describe("paths", () => {
  it.skipIf(process.platform === "win32")("getDataDir returns ~/.local/share/rolebox on macOS/Linux by default", () => {
    const dir = getDataDir();
    expect(dir).toEndWith(".local/share/rolebox");
  });

  it.skipIf(process.platform === "win32")("getConfigDir returns ~/.config/rolebox on macOS/Linux by default", () => {
    const dir = getConfigDir();
    expect(dir).toEndWith(".config/rolebox");
  });

  it("getDataDir on darwin keeps ~/.local/share parity with opencode (deliberate, not a relocation to ~/Library/Application Support)", () => {
    if (process.platform !== "darwin") return; // darwin-specific assertion
    const dir = getDataDir();
    expect(dir).toEndWith(".local/share/rolebox");
    expect(dir).not.toContain("Library");
  });

  it("getConfigDir on darwin keeps ~/.config parity with opencode (deliberate, not ~/Library/Application Support)", () => {
    if (process.platform !== "darwin") return; // darwin-specific assertion
    const dir = getConfigDir();
    expect(dir).toEndWith(".config/rolebox");
    expect(dir).not.toContain("Library");
  });

  it("getRolesDir returns {dataDir}/roles", () => {
    const rolesDir = getRolesDir();
    expect(rolesDir).toEndWith("roles");
    expect(rolesDir).toContain(getDataDir());
  });

  it("getSyncTarget opencode returns path ending with opencode/rolebox", () => {
    const target = getSyncTarget("opencode");
    // Normalize separators so the assertion holds on win32 (backslashes) and
    // POSIX (forward slashes) alike.
    expect(toPosixPath(target)).toEndWith("opencode/rolebox");
  });

  it("getSyncTarget pi returns path ending with agent/rolebox", () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const target = getSyncTarget("pi");
      expect(toPosixPath(target)).toEndWith(".pi/agent/rolebox");
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  it("getSyncTarget dsh returns path under DSH_HOME", () => {
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = join(tmpdir(), "dsh-home");
    try {
      const target = getSyncTarget("dsh");
      expect(target).toBe(join(tmpdir(), "dsh-home", "rolebox"));
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });

  it("getSyncTarget with unknown target throws", () => {
    expect(() => getSyncTarget("vscode")).toThrow("Unknown sync target");
  });

  it("getRolePath constructs correct path", () => {
    const p = getRolePath("oh-my-role", "software-architect", "1.0.0");
    expect(p).toContain("oh-my-role");
    expect(p).toContain("software-architect@1.0.0");
  });

  it("getDataDir respects XDG_DATA_HOME", () => {
    const orig = process.env.XDG_DATA_HOME;
    // Use a tmpdir()-based path and join() for the expectation so the assertion
    // holds on both POSIX (forward slashes) and Windows (backslashes). The old
    // hardcoded "/tmp/test-xdg/rolebox" literal only matched the POSIX separator.
    const xdg = join(tmpdir(), "test-xdg");
    process.env.XDG_DATA_HOME = xdg;
    try {
      const dir = getDataDir();
      expect(dir).toBe(join(xdg, "rolebox"));
    } finally {
      if (orig) process.env.XDG_DATA_HOME = orig;
      else delete process.env.XDG_DATA_HOME;
    }
  });
});

describe("ROLEBOX_* env overrides", () => {
  it("ROLEBOX_DATA_DIR takes precedence over XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    process.env.ROLEBOX_DATA_DIR = "/custom/data/dir";
    expect(getDataDir()).toBe("/custom/data/dir");
    expect(getRolesDir()).toBe(join("/custom/data/dir", "roles"));
  });

  it("ROLEBOX_CONFIG_DIR takes precedence over XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.ROLEBOX_CONFIG_DIR = "/custom/config/dir";
    expect(getConfigDir()).toBe("/custom/config/dir");
  });
});

describe("win32 branch resolution (simulated process.platform)", () => {
  // These tests exercise the win32 branches of getDataDir / getConfigDir
  // (paths.ts) via the injectable platform getter seam (setPlatformForTest)
  // instead of requiring a real Windows host. The seam leaves production
  // behavior untouched: setPlatformForTest(undefined) restores process.platform.

  it("getDataDir uses %LOCALAPPDATA% on win32", () => {
    setPlatformForTest("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    const dir = getDataDir();
    // The resolved dir is built from the LOCALAPPDATA base + rolebox. The
    // separator is the HOST's (join uses the real process.sep), so assert on
    // the env-derived base prefix rather than a specific slash.
    expect(dir.startsWith(process.env.LOCALAPPDATA!)).toBe(true);
    expect(dir).toEndWith("rolebox");
    expect(dir).not.toContain(".local/share");
    expect(dir).not.toContain(".local");
  });

  it("getDataDir falls back to homedir AppData/Local on win32 when LOCALAPPDATA is unset", () => {
    setPlatformForTest("win32");
    delete process.env.LOCALAPPDATA;
    const dir = getDataDir();
    expect(dir).toContain("AppData");
    expect(dir).toContain("Local");
    expect(dir).toEndWith("rolebox");
  });

  it("ROLEBOX_DATA_DIR wins over LOCALAPPDATA on win32", () => {
    setPlatformForTest("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    process.env.ROLEBOX_DATA_DIR = "C:\\rolebox-data";
    expect(getDataDir()).toBe("C:\\rolebox-data");
    expect(getRolesDir()).toEndWith("roles");
  });

  it("getConfigDir uses %APPDATA% on win32", () => {
    setPlatformForTest("win32");
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const dir = getConfigDir();
    expect(dir.startsWith(process.env.APPDATA!)).toBe(true);
    expect(dir).toEndWith("rolebox");
    expect(dir).not.toContain(".config");
  });

  it("getConfigDir falls back to homedir AppData/Roaming on win32 when APPDATA is unset", () => {
    setPlatformForTest("win32");
    delete process.env.APPDATA;
    const dir = getConfigDir();
    expect(dir).toContain("AppData");
    expect(dir).toContain("Roaming");
    expect(dir).toEndWith("rolebox");
  });

  it("ROLEBOX_CONFIG_DIR wins over APPDATA on win32", () => {
    setPlatformForTest("win32");
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    process.env.ROLEBOX_CONFIG_DIR = "C:\\rolebox-config";
    expect(getConfigDir()).toBe("C:\\rolebox-config");
  });

  it("getDataDir honors XDG_DATA_HOME on win32 (explicit XDG override beats LOCALAPPDATA)", () => {
    setPlatformForTest("win32");
    const xdgData = mkdtempSync(join(tmpdir(), "rolebox-xdg-data-"));
    try {
      process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
      process.env.XDG_DATA_HOME = xdgData;
      expect(getDataDir()).toBe(join(xdgData, "rolebox"));
    } finally {
      rmSync(xdgData, { recursive: true, force: true });
    }
  });

  it("getConfigDir honors XDG_CONFIG_HOME on win32 (explicit XDG override beats APPDATA)", () => {
    setPlatformForTest("win32");
    const xdgConfig = mkdtempSync(join(tmpdir(), "rolebox-xdg-config-"));
    try {
      process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
      process.env.XDG_CONFIG_HOME = xdgConfig;
      expect(getConfigDir()).toBe(join(xdgConfig, "rolebox"));
    } finally {
      rmSync(xdgConfig, { recursive: true, force: true });
    }
  });
});

describe("getRolePath sanitization under a simulated platform", () => {
  // getRolePath / assertSafePathSegment validate unconditionally (they do not
  // branch on platform), but the audit (F5.3) asks that these protections hold
  // regardless of host OS. Assert they still reject hostile inputs when the
  // platform getter reports win32 (the most constrained filesystem) and darwin.
  for (const platform of ["win32", "darwin"]) {
    it(`rejects traversal/separators/invalid chars on ${platform}`, () => {
      setPlatformForTest(platform);
      expect(() => getRolePath("oh-my-role", "../evil", "1.0.0")).toThrow(/\.\./);
      expect(() => getRolePath("oh-my-role", "a/b", "1.0.0")).toThrow(/path separator/);
      expect(() => getRolePath("oh-my-role", ".hidden", "1.0.0")).toThrow(/starts with a dot/);
      expect(() => getRolePath("oh-my-role", "bad:name", "1.0.0")).toThrow(/Windows-invalid character/);
      expect(() => getRolePath("nul", "role", "1.0.0")).toThrow(/reserved device name/);
    });
  }

  it("getPlatform reports the real platform by default and honors the override", () => {
    expect(getPlatform()).toBe(process.platform);
    setPlatformForTest("win32");
    expect(getPlatform()).toBe("win32");
    setPlatformForTest(undefined);
    expect(getPlatform()).toBe(process.platform);
  });
});

describe("getRolePath sanitization", () => {
  it("rejects path traversal via ../ in roleId", () => {
    expect(() => getRolePath("oh-my-role", "../evil", "1.0.0")).toThrow(/\.\./);
  });

  it("rejects path traversal via ../ in registry", () => {
    expect(() => getRolePath("../../etc", "role", "1.0.0")).toThrow(/\.\./);
  });

  it("rejects path separators in roleId", () => {
    expect(() => getRolePath("oh-my-role", "a/b", "1.0.0")).toThrow(/path separator/);
    expect(() => getRolePath("oh-my-role", "a\\b", "1.0.0")).toThrow(/path separator/);
  });

  it("rejects leading-dot roleId", () => {
    expect(() => getRolePath("oh-my-role", ".hidden", "1.0.0")).toThrow(/starts with a dot/);
  });

  it("rejects Windows-invalid characters in roleId", () => {
    for (const ch of [":", "*", "?", "\"", "<", ">", "|"]) {
      expect(() => getRolePath("oh-my-role", `role${ch}name`, "1.0.0")).toThrow(
        /Windows-invalid character/,
      );
    }
  });

  it("rejects Windows reserved device names for roleId", () => {
    for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"]) {
      expect(() => getRolePath("oh-my-role", name, "1.0.0")).toThrow(/reserved device name/);
    }
  });

  it("rejects Windows reserved device names for registry (case-insensitive)", () => {
    expect(() => getRolePath("nul", "role", "1.0.0")).toThrow(/reserved device name/);
  });

  it("allows valid names including @ and digits", () => {
    expect(() => getRolePath("oh-my-role", "some@role", "1.0.0")).not.toThrow();
    expect(() => getRolePath("custom-registry", "code-reviewer", "2.0.0")).not.toThrow();
  });

  it("error names the offending roleId", () => {
    expect(() => getRolePath("oh-my-role", "a/../b", "1.0.0")).toThrow(/roleId/);
  });
});

describe("assertSafePathSegment", () => {
  it("rejects empty values", () => {
    expect(() => assertSafePathSegment("  ", "roleId")).toThrow(/empty/);
  });
});

// The negative assertion in this block relies on chmod(0o500) making a directory
// read-only for the owner. On Windows, chmod is effectively a no-op for write
// permission — access is governed by ACLs, not POSIX mode bits — so a "read-only"
// directory is still writable by the owner and ensureWritableDir never throws.
// That failure path cannot occur there, so the whole pre-check block is skipped on
// win32. macOS/Linux behavior is unchanged (these tests still execute and pass).
describe.skipIf(process.platform === "win32")("ensureWritableDir (writability pre-check)", () => {
  it("fails with a clear actionable message when the directory is not writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-ro-"));
    try {
      chmodSync(dir, 0o500); // read + execute only, no write
      expect(() => ensureWritableDir(dir)).toThrow(
        /is not writable; set ROLEBOX_CONFIG_DIR \/ ROLEBOX_DATA_DIR or fix permissions/,
      );
    } finally {
      chmodSync(dir, 0o700); // restore so we can clean up
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the directory recursively when it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-writable-"));
    try {
      const nested = join(base, "a", "b", "c");
      ensureWritableDir(nested);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

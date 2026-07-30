import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// This file exercises the REAL paths module. Under `bun test --isolate` each
// test file has its own module registry, so a static import resolves to the
// real module regardless of mock.module calls registered by other test files.
import * as paths from "../../src/cli/paths.ts";
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

describe("paths", () => {
  it("getDataDir returns ~/.local/share/rolebox on macOS/Linux by default", () => {
    const dir = getDataDir();
    expect(dir).toEndWith(".local/share/rolebox");
  });

  it("getConfigDir returns ~/.config/rolebox on macOS/Linux by default", () => {
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
    expect(target).toEndWith("opencode/rolebox");
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
    process.env.XDG_DATA_HOME = "/tmp/test-xdg";
    try {
      const dir = getDataDir();
      expect(dir).toBe("/tmp/test-xdg/rolebox");
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

describe("ensureWritableDir (writability pre-check)", () => {
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

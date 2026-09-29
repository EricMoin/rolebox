/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
  currentPlatform,
  detectSystem,
  disposableEnvironmentHint,
  getSystem,
  setPlatformForTest,
  SYSTEM_REGISTRY,
  type DisposablePaths,
  type SystemDescriptor,
  type SystemId,
} from "../../../src/platform/system/index.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────
// Every expectation below is a literal POSIX or Windows string, never a
// host-joined path: a descriptor must answer the same values on any host.

const COMMAND = "printf '%s' \"$HOME\"";
const HOME = "/home/example";
const WINDOWS_HOME = "C:\\Users\\example";

const POSIX_PATHS: DisposablePaths = {
  home: HOME,
  config: `${HOME}/.config`,
  cache: `${HOME}/.cache`,
  temp: "/tmp/graph-worker-command-x",
  env: {},
};

const WINDOWS_PATHS: DisposablePaths = {
  home: WINDOWS_HOME,
  config: `${WINDOWS_HOME}\\.config`,
  cache: `${WINDOWS_HOME}\\.cache`,
  temp: "C:\\Temp\\graph-worker-command-x",
  env: {},
};

function descriptor(id: SystemId): SystemDescriptor {
  const found = SYSTEM_REGISTRY.find(system => system.id === id);
  if (!found) throw new Error(`No system descriptor declared for ${id}`);
  return found;
}

afterEach(() => setPlatformForTest(undefined));

// ── Registry ────────────────────────────────────────────────────────────────

describe("system registry", () => {
  it("declares exactly one descriptor per system id", () => {
    expect(SYSTEM_REGISTRY.map(system => system.id)).toEqual(["darwin", "linux", "win32", "posix"]);
    expect(new Set(SYSTEM_REGISTRY.map(system => system.id)).size).toBe(SYSTEM_REGISTRY.length);
  });

  it("labels every system for diagnostics", () => {
    const labels: Record<SystemId, string> = {
      darwin: "macOS",
      linux: "Linux",
      win32: "Windows",
      posix: "POSIX (unlisted platform)",
    };
    for (const system of SYSTEM_REGISTRY) expect(system.label, system.id).toBe(labels[system.id]);
  });

  it("states shell guidance for every system", () => {
    for (const system of SYSTEM_REGISTRY) {
      expect(system.shellHint.length, system.id).toBeGreaterThan(20);
      expect(system.shellHint, system.id).toContain(system.id === "win32" ? "cmd.exe" : "/bin/sh");
    }
  });
});

// ── Browser caches ──────────────────────────────────────────────────────────

describe("browser cache locations", () => {
  const cases: ReadonlyArray<{ id: SystemId; home: string; playwright: string; puppeteer: string }> = [
    { id: "darwin", home: HOME, playwright: "/home/example/Library/Caches/ms-playwright", puppeteer: "/home/example/.cache/puppeteer" },
    { id: "linux", home: HOME, playwright: "/home/example/.cache/ms-playwright", puppeteer: "/home/example/.cache/puppeteer" },
    { id: "win32", home: WINDOWS_HOME, playwright: "C:\\Users\\example\\AppData\\Local\\ms-playwright", puppeteer: "C:\\Users\\example\\.cache\\puppeteer" },
    { id: "posix", home: HOME, playwright: "/home/example/.cache/ms-playwright", puppeteer: "/home/example/.cache/puppeteer" },
  ];

  for (const expected of cases) {
    it(`${expected.id} answers its own documented cache locations`, () => {
      expect(descriptor(expected.id).browserCaches(expected.home)).toEqual({
        playwright: expected.playwright,
        puppeteer: expected.puppeteer,
      });
    });
  }

  it("keeps Windows values Windows-shaped instead of the macOS layout", () => {
    const caches = descriptor("win32").browserCaches(WINDOWS_HOME);
    expect(caches.playwright).toBe("C:\\Users\\example\\AppData\\Local\\ms-playwright");
    expect(caches.playwright).not.toContain("Library");
    expect(caches.playwright).not.toContain("/");
  });

  it("gives the posix fallback Linux-family caches under its own id", () => {
    expect(descriptor("posix").browserCaches(HOME)).toEqual(descriptor("linux").browserCaches(HOME));
    expect(descriptor("posix").id).not.toBe(descriptor("linux").id);
  });
});

// ── Disposable environments ─────────────────────────────────────────────────

describe("disposable environments", () => {
  it("darwin adds the Cocoa/Chromium names to HOME, XDG_* and TMPDIR", () => {
    expect(descriptor("darwin").disposableEnvironment(POSIX_PATHS)).toEqual({
      HOME: "/home/example",
      XDG_CONFIG_HOME: "/home/example/.config",
      XDG_CACHE_HOME: "/home/example/.cache",
      TMPDIR: "/tmp/graph-worker-command-x",
      CFFIXED_USER_HOME: "/home/example",
      MAC_CHROMIUM_TMPDIR: "/tmp/graph-worker-command-x",
      xcrun_db: "/tmp/graph-worker-command-x/xcrun_db",
    });
  });

  it("linux and posix set exactly the four POSIX disposable variables", () => {
    const expected = {
      HOME: "/home/example",
      XDG_CONFIG_HOME: "/home/example/.config",
      XDG_CACHE_HOME: "/home/example/.cache",
      TMPDIR: "/tmp/graph-worker-command-x",
    };
    expect(descriptor("linux").disposableEnvironment(POSIX_PATHS)).toEqual(expected);
    expect(descriptor("posix").disposableEnvironment(POSIX_PATHS)).toEqual(expected);
  });

  it("win32 names the variables Windows software and os.homedir() read", () => {
    expect(descriptor("win32").disposableEnvironment(WINDOWS_PATHS)).toEqual({
      HOME: "C:\\Users\\example",
      USERPROFILE: "C:\\Users\\example",
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      APPDATA: "C:\\Users\\example\\AppData\\Roaming",
      TEMP: "C:\\Temp\\graph-worker-command-x",
      TMP: "C:\\Temp\\graph-worker-command-x",
      XDG_CONFIG_HOME: "C:\\Users\\example\\.config",
      XDG_CACHE_HOME: "C:\\Users\\example\\.cache",
      TMPDIR: "C:\\Temp\\graph-worker-command-x",
    });
  });

  it("darwin forwards the selected developer toolchain and treats a blank value as unset", () => {
    const darwin = descriptor("darwin");
    expect(darwin.disposableEnvironment(POSIX_PATHS).DEVELOPER_DIR).toBeUndefined();
    expect(darwin.disposableEnvironment({ ...POSIX_PATHS, env: { DEVELOPER_DIR: "" } }).DEVELOPER_DIR).toBeUndefined();
    expect(darwin.disposableEnvironment({ ...POSIX_PATHS, env: { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" } }).DEVELOPER_DIR)
      .toBe("/Applications/Xcode.app/Contents/Developer");
  });

  it("forwards DEVELOPER_DIR on darwin only", () => {
    const env = { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" };
    for (const system of SYSTEM_REGISTRY) {
      const names = Object.keys(system.disposableEnvironment({ ...POSIX_PATHS, env }));
      expect(names.includes("DEVELOPER_DIR"), system.id).toBe(system.id === "darwin");
    }
  });
});

// ── Command shells ──────────────────────────────────────────────────────────

describe("command shells", () => {
  for (const id of ["darwin", "linux", "posix"] as const) {
    it(`${id} runs the command through /bin/sh -c`, () => {
      expect(descriptor(id).commandShell(COMMAND, {})).toEqual(["/bin/sh", "-c", COMMAND]);
    });
  }

  it("win32 uses the host's non-blank COMSPEC", () => {
    expect(descriptor("win32").commandShell(COMMAND, { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }))
      .toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", COMMAND]);
  });

  it("win32 falls back to cmd.exe when COMSPEC is blank or absent", () => {
    for (const env of [{}, { COMSPEC: "" }, { COMSPEC: "   " }]) {
      const argv = descriptor("win32").commandShell(COMMAND, env);
      expect(argv[0], JSON.stringify(env)).toBe("cmd.exe");
      expect(argv.slice(1)).toEqual(["/d", "/s", "/c", COMMAND]);
    }
  });
});

// ── Detection ───────────────────────────────────────────────────────────────

describe("system detection", () => {
  it("resolves every declared id to its own descriptor", () => {
    for (const system of SYSTEM_REGISTRY) expect(detectSystem(system.id)).toBe(system);
  });

  it("resolves an unlisted platform to the posix descriptor instead of throwing or claiming Linux", () => {
    for (const platform of ["freebsd", "aix", "openbsd", "sunos", "android", "cygwin", ""]) {
      const system = detectSystem(platform);
      expect(system.id, platform).toBe("posix");
      expect(system, platform).toBe(descriptor("posix"));
      expect(system.id, platform).not.toBe("linux");
    }
  });

  it("getSystem follows the test platform override and restores the real platform", () => {
    expect(currentPlatform()).toBe(process.platform);
    expect(getSystem()).toBe(detectSystem(process.platform));
    setPlatformForTest("win32");
    expect(currentPlatform()).toBe("win32");
    expect(getSystem().id).toBe("win32");
    setPlatformForTest("freebsd");
    expect(currentPlatform()).toBe("freebsd");
    expect(getSystem().id).toBe("posix");
    setPlatformForTest(undefined);
    expect(currentPlatform()).toBe(process.platform);
    expect(getSystem()).toBe(detectSystem(process.platform));
  });
});

// ── Model-facing hint ───────────────────────────────────────────────────────

describe("disposable environment hint", () => {
  it("names exactly the variables the descriptor sets, for every system", () => {
    for (const system of SYSTEM_REGISTRY) {
      const names = disposableEnvironmentHint(system).split(/ and |, /);
      expect([...names].sort(), system.id).toEqual(Object.keys(system.disposableEnvironment(POSIX_PATHS)).sort());
    }
  });

  it("spells the POSIX and Windows sets for model-facing text", () => {
    expect(disposableEnvironmentHint(descriptor("linux"))).toBe("HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME and TMPDIR");
    expect(disposableEnvironmentHint(descriptor("darwin")))
      .toBe("HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR, CFFIXED_USER_HOME, MAC_CHROMIUM_TMPDIR and xcrun_db");
    expect(disposableEnvironmentHint(descriptor("win32")))
      .toBe("HOME, USERPROFILE, LOCALAPPDATA, APPDATA, TEMP, TMP, XDG_CONFIG_HOME, XDG_CACHE_HOME and TMPDIR");
  });

  it("follows the current system by default", () => {
    setPlatformForTest("linux");
    expect(disposableEnvironmentHint()).toContain("TMPDIR");
    expect(disposableEnvironmentHint()).not.toContain("USERPROFILE");
    setPlatformForTest("win32");
    expect(disposableEnvironmentHint()).toContain("USERPROFILE");
  });
});

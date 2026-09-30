import { afterEach, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserDiscoveryEnvironment, executeGraphWorkerCommand } from "../../../src/platform/sandbox/worker-exec.ts";
import { getSystem, setPlatformForTest } from "../../../src/platform/system/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setPlatformForTest(undefined);
});

function workspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * The shell these probes really run in.
 *
 * The runner is boundary-free: it spawns exactly the vector its caller decided,
 * and a caller decides that vector with the detected system's
 * `commandShell(command, env)` — so these tests build their argv the same way
 * instead of hardcoding a POSIX `/bin/sh` that Windows does not have. The
 * descriptor is resolved once, from the platform this process runs on:
 * `setPlatformForTest` below changes which DESCRIPTOR answers (the disposable
 * variable set under test), never which shell this host can spawn.
 */
const hostSystem = getSystem();
const shell = (command: string): string[] => hostSystem.commandShell(command, process.env);

/** The same probe written for this host's shell: POSIX first, cmd.exe second. */
const perOs = (posix: string, windows: string): string => (hostSystem.id === "win32" ? windows : posix);

it("spawns the caller's argv in the workspace and reports exit code and output", async () => {
  const root = workspace("graph-worker-exec-");
  // `$PWD`/`cd` report the command's own working directory, and cmd's `echo`
  // writes CRLF where /bin/sh's writes LF — so the expected bytes travel with
  // the per-OS command pair.
  const result = await executeGraphWorkerCommand({ workspace: root, timeoutMs: 10_000,
    argv: shell(perOs(`echo decided > output.txt && printf '%s' "$PWD"`, "echo decided> output.txt && cd")) });
  expect(result.exitCode, result.output).toBe(0);
  // The reported directory is the workspace, compared as the canonical path the
  // report names: a short (8.3) or differently-cased spelling of the same
  // directory on Windows still proves which directory the command ran in.
  expect(realpathSync(result.output.trim())).toBe(realpathSync(root));
  expect(readFileSync(join(root, "output.txt"), "utf8")).toBe(perOs("decided\n", "decided\r\n"));
});

it("refuses an empty argv instead of spawning anything", async () => {
  const root = workspace("graph-worker-exec-");
  await expect(executeGraphWorkerCommand({ argv: [], workspace: root })).rejects.toThrow("non-empty spawn argv");
});

it("stops a command at its timeout and reports the stop", async () => {
  const root = workspace("graph-worker-exec-");
  // Both probes outlive the 500ms timeout: /bin/sh's `sleep` is ended by the
  // runner's process-group kill, cmd's `ping` is bounded so the stop report
  // still arrives promptly on a system whose command shell has no process group
  // to kill. The report, and the prompt return, are what this asserts.
  const started = Date.now();
  const result = await executeGraphWorkerCommand({ workspace: root, timeoutMs: 500,
    argv: shell(perOs("sleep 30", "ping -n 4 127.0.0.1 >nul")) });
  expect(result.output).toContain("Command stopped by cancellation, timeout or output limit.");
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

it("provides disposable home, config and cache directories to work software", async () => {
  const root = workspace("graph-worker-software-");
  const result = await executeGraphWorkerCommand({ workspace: root, argv: shell(perOs(
    `test -d "$HOME" && test -d "$XDG_CONFIG_HOME" && test -d "$XDG_CACHE_HOME" && echo configured > "$HOME/settings" && echo cached > "$XDG_CACHE_HOME/cache" && printf '%s' "$HOME"`,
    // No embedded quotes: a command string is one argv entry of `cmd /d /s /c`,
    // and quote characters here would be escaped for CreateProcess and then
    // re-parsed by cmd itself. The disposable paths carry no spaces, and the two
    // writes are chained with `&&` exactly as the POSIX branch chains them, so a
    // write that does not land fails the command instead of being reported as a
    // success.
    `if not exist %HOME% exit /b 1 & if not exist %XDG_CONFIG_HOME% exit /b 1 & if not exist %XDG_CACHE_HOME% exit /b 1 & echo configured> %HOME%\\settings && echo cached> %XDG_CACHE_HOME%\\cache && echo %HOME%`)) });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).not.toBe("");
  // The directory the command reported is its disposable home, and it is gone
  // once the command ends (`echo` adds the line ending of whichever shell ran).
  expect(existsSync(result.output.trim())).toBe(false);
});

// The disposable variable NAMES are per-OS facts (src/platform/system/): Windows
// software and Node's os.homedir() read USERPROFILE, and the macOS-only Cocoa and
// Chromium names must not be set on another system. These are environment
// assertions on a simulated system — the command still runs in THIS host's own
// shell (POSIX sh or cmd.exe), so nothing here claims a Windows or Linux
// execution.
const PROBE_VARIABLES = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "CFFIXED_USER_HOME",
  "MAC_CHROMIUM_TMPDIR", "xcrun_db", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"] as const;

/**
 * One probe's report: what the command saw, and what the descriptor DECLARED.
 *
 * The declared names come from the simulated system's own descriptor rather than
 * from a hand-written list, so the assertions cannot drift from the environment
 * the runner applies. Only the KEY SET is read — the runner chooses the
 * disposable paths, so their values are its own.
 */
interface EnvironmentProbe {
  /** The value the command saw for every name under test ("" when absent). */
  readonly values: Record<string, string>;
  /** The names the simulated descriptor puts in the command's environment. */
  readonly declared: ReadonlySet<string>;
}

/**
 * Read those variables back out of a real command run on the simulated system.
 *
 * The dump is the detected system's own: `env` prints `NAME=value` lines on the
 * POSIX family, `set` prints them under cmd.exe.
 */
async function probeEnvironment(root: string, platform: string): Promise<EnvironmentProbe> {
  setPlatformForTest(platform);
  const declared = new Set(Object.keys(getSystem().disposableEnvironment({
    home: "<home>", config: "<config>", cache: "<cache>", temp: "<temp>", env: process.env,
  })));
  const result = await executeGraphWorkerCommand({ workspace: root, argv: shell(perOs("env", "set")) });
  expect(result.exitCode, result.output).toBe(0);
  const dumped: Record<string, string> = {};
  for (const line of result.output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) dumped[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const values: Record<string, string> = {};
  for (const name of PROBE_VARIABLES) values[name] = dumped[name] ?? "";
  return { values, declared };
}

/** A name the descriptor declares is the descriptor's to fill: the command sees a value. */
function expectDeclared(probe: EnvironmentProbe, ...names: string[]): void {
  for (const name of names) {
    expect(probe.declared.has(name), `${name} must be declared`).toBe(true);
    expect(probe.values[name], name).not.toBe("");
  }
}

/**
 * A name the descriptor does NOT declare is not the descriptor's to decide.
 *
 * "The descriptor leaves it alone" is what this asserts, and that is not the same
 * claim as "the command sees nothing": the runner builds the environment from the
 * descriptor, and a host that carries its own environment into every child
 * (Windows hands every process the ambient USERPROFILE, TEMP, …) shows exactly
 * that ambient value, while a host whose spawn REPLACES the environment shows
 * nothing. Either way the value is never one the descriptor invented — so the
 * assertion is the ambient value or the empty string, and the DECLARED set is
 * checked directly, which is where "macOS-only names nowhere else" really lives.
 */
function expectUndeclared(probe: EnvironmentProbe, ...names: string[]): void {
  for (const name of names) {
    expect(probe.declared.has(name), `${name} must not be declared`).toBe(false);
    const ambient = process.env[name] ?? "";
    const observed = probe.values[name];
    expect([ambient, ""], `${name}=${JSON.stringify(observed)}`).toContain(observed);
  }
}

it("gives a command the disposable variables of the detected system, and macOS-only names nowhere else", async () => {
  const root = workspace("graph-worker-system-");

  // Linux: the POSIX family's four names, and none of the macOS-only ones.
  const linux = await probeEnvironment(root, "linux");
  expectDeclared(linux, "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR");
  expectUndeclared(linux, "CFFIXED_USER_HOME", "MAC_CHROMIUM_TMPDIR", "xcrun_db", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "TEMP", "TMP");

  // macOS: the Cocoa and Chromium names are derived from the same two directories,
  // which is only checkable as a relationship — the paths themselves are the
  // runner's own disposable ones.
  const darwin = await probeEnvironment(root, "darwin");
  expectDeclared(darwin, "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "CFFIXED_USER_HOME",
    "MAC_CHROMIUM_TMPDIR", "xcrun_db");
  expect(darwin.values.CFFIXED_USER_HOME).toBe(darwin.values.HOME);
  expect(darwin.values.MAC_CHROMIUM_TMPDIR).toBe(darwin.values.TMPDIR);
  expect(darwin.values.xcrun_db).toBe(`${darwin.values.TMPDIR}/xcrun_db`);
  expectUndeclared(darwin, "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP");

  // Windows: Node's os.homedir() reads USERPROFILE, so the disposable home is
  // named there too, and the AppData/TEMP names follow it.
  const windows = await probeEnvironment(root, "win32");
  expectDeclared(windows, "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR");
  expect(windows.values.USERPROFILE).toBe(windows.values.HOME);
  expect(windows.values.LOCALAPPDATA.endsWith("AppData\\Local")).toBe(true);
  expect(windows.values.APPDATA.endsWith("AppData\\Roaming")).toBe(true);
  // Asserted against TMPDIR, which Windows does not carry ambiently: the equality
  // proves both names took the descriptor's value rather than the host's TEMP.
  expect(windows.values.TEMP).toBe(windows.values.TMPDIR);
  expect(windows.values.TMP).toBe(windows.values.TMPDIR);
  // HOME and the XDG_* names stay set on Windows (src/cli/paths.ts honours XDG there).
  expect(windows.values.HOME).not.toBe("");
  expect(windows.values.XDG_CONFIG_HOME).not.toBe("");
  expectUndeclared(windows, "CFFIXED_USER_HOME", "MAC_CHROMIUM_TMPDIR", "xcrun_db");
});

// Installed browsers live under the real home, which the disposable command HOME
// hides; the runner names those caches explicitly and lets host configuration win.
// The DEFAULT cache location is a per-OS fact, so each system is asserted with its
// own documented location, passed through the host's resolve() like any default.
const BROWSER_CACHES: ReadonlyArray<{ platform: string; home: string; playwright: string; puppeteer: string }> = [
  { platform: "darwin", home: "/home/example", playwright: "/home/example/Library/Caches/ms-playwright", puppeteer: "/home/example/.cache/puppeteer" },
  { platform: "linux", home: "/home/example", playwright: "/home/example/.cache/ms-playwright", puppeteer: "/home/example/.cache/puppeteer" },
  { platform: "win32", home: "C:\\Users\\example", playwright: "C:\\Users\\example\\AppData\\Local\\ms-playwright", puppeteer: "C:\\Users\\example\\.cache\\puppeteer" },
];

it("keeps browser discovery pointed at installed caches", () => {
  for (const caches of BROWSER_CACHES) {
    setPlatformForTest(caches.platform);
    expect(browserDiscoveryEnvironment("/workspace", {}, caches.home), caches.platform).toEqual({
      PLAYWRIGHT_BROWSERS_PATH: resolve("/workspace", caches.playwright),
      PUPPETEER_CACHE_DIR: resolve("/workspace", caches.puppeteer),
    });
  }
  setPlatformForTest("darwin");
  // A host-set cache path is resolved against the workspace by the HOST's own
  // resolve() — the product promises the host-native absolute path, so the
  // expectation is built with that same call instead of a literal POSIX one.
  expect(browserDiscoveryEnvironment("/workspace", {
    PLAYWRIGHT_BROWSERS_PATH: "../browsers/playwright", PUPPETEER_CACHE_DIR: "../browsers/puppeteer",
    PUPPETEER_EXECUTABLE_PATH: "/tools/Browser.app/Contents/MacOS/browser", UNRELATED: "not-forwarded",
  }, "/home/example")).toEqual({
    PLAYWRIGHT_BROWSERS_PATH: resolve("/workspace", "../browsers/playwright"),
    PUPPETEER_CACHE_DIR: resolve("/workspace", "../browsers/puppeteer"),
    PUPPETEER_EXECUTABLE_PATH: resolve("/workspace", "/tools/Browser.app/Contents/MacOS/browser"),
  });
  expect(browserDiscoveryEnvironment("/workspace", { PLAYWRIGHT_BROWSERS_PATH: "0" }, "/home/example").PLAYWRIGHT_BROWSERS_PATH).toBe("0");
});

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
it.skipIf(process.platform !== "darwin" || !existsSync(chrome))("renders, screenshots and closes an installed browser through the caller's argv", async () => {
  const root = workspace("graph-worker-browser-");
  copyFileSync(new URL("./fixtures/browser-probe.ts", import.meta.url), join(root, "browser-probe.ts"));
  const result = await executeGraphWorkerCommand({ argv: [process.execPath, "browser-probe.ts", chrome], workspace: root, timeoutMs: 20_000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain("worker-browser-ok\nbrowser-closed\n");
  expect(readFileSync(join(root, "screenshot.png")).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}, 25_000);

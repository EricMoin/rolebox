import { afterEach, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserDiscoveryEnvironment, executeGraphWorkerCommand } from "../../../src/platform/sandbox/worker-exec.ts";
import { setPlatformForTest } from "../../../src/platform/system/index.ts";

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

/** The runner is boundary-free: it spawns exactly the vector its caller decided. */
const shell = (command: string): string[] => ["/bin/sh", "-c", command];

it("spawns the caller's argv in the workspace and reports exit code and output", async () => {
  const root = workspace("graph-worker-exec-");
  const result = await executeGraphWorkerCommand({ argv: shell("echo decided > output.txt && printf '%s' \"$PWD\""), workspace: root, timeoutMs: 10_000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toBe(realpathSync(root));
  expect(readFileSync(join(root, "output.txt"), "utf8")).toBe("decided\n");
});

it("refuses an empty argv instead of spawning anything", async () => {
  const root = workspace("graph-worker-exec-");
  await expect(executeGraphWorkerCommand({ argv: [], workspace: root })).rejects.toThrow("non-empty spawn argv");
});

it("stops a command at its timeout and reports the stop", async () => {
  const root = workspace("graph-worker-exec-");
  const started = Date.now();
  const result = await executeGraphWorkerCommand({ argv: shell("sleep 30"), workspace: root, timeoutMs: 500 });
  expect(result.output).toContain("Command stopped by cancellation, timeout or output limit.");
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

it("provides disposable home, config and cache directories to work software", async () => {
  const root = workspace("graph-worker-software-");
  const result = await executeGraphWorkerCommand({ workspace: root,
    argv: shell('test -d "$HOME" && test -d "$XDG_CONFIG_HOME" && test -d "$XDG_CACHE_HOME" && echo configured > "$HOME/settings" && echo cached > "$XDG_CACHE_HOME/cache" && printf "%s" "$HOME"') });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).not.toBe("");
  expect(existsSync(result.output)).toBe(false);
});

// The disposable variable NAMES are per-OS facts (src/platform/system/): Windows
// software and Node's os.homedir() read USERPROFILE, and the macOS-only Cocoa and
// Chromium names must not be set on another system. These are environment
// assertions on a simulated system — the argv is still this host's /bin/sh probe,
// so nothing here claims a Windows or Linux execution.
const PROBE_VARIABLES = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "CFFIXED_USER_HOME",
  "MAC_CHROMIUM_TMPDIR", "xcrun_db", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"] as const;

/** Read those variables back out of a real command run on the simulated system. */
async function probeEnvironment(root: string, platform: string): Promise<Record<string, string>> {
  setPlatformForTest(platform);
  const command = `printf '%s\\n' ${PROBE_VARIABLES.map(name => `"$${name}"`).join(" ")}`;
  const result = await executeGraphWorkerCommand({ workspace: root, argv: shell(command) });
  expect(result.exitCode, result.output).toBe(0);
  const values = result.output.split("\n");
  const environment: Record<string, string> = {};
  PROBE_VARIABLES.forEach((name, index) => { environment[name] = values[index] ?? ""; });
  return environment;
}

it("gives a command the disposable variables of the detected system, and macOS-only names nowhere else", async () => {
  const root = workspace("graph-worker-system-");

  const linux = await probeEnvironment(root, "linux");
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
    expect(linux[name], name).not.toBe("");
  }
  for (const name of ["CFFIXED_USER_HOME", "MAC_CHROMIUM_TMPDIR", "xcrun_db", "USERPROFILE"]) {
    expect(linux[name], name).toBe("");
  }

  const darwin = await probeEnvironment(root, "darwin");
  expect(darwin.CFFIXED_USER_HOME).toBe(darwin.HOME);
  expect(darwin.MAC_CHROMIUM_TMPDIR).toBe(darwin.TMPDIR);
  expect(darwin.xcrun_db).toBe(`${darwin.TMPDIR}/xcrun_db`);
  expect(darwin.USERPROFILE).toBe("");

  const windows = await probeEnvironment(root, "win32");
  expect(windows.USERPROFILE).toBe(windows.HOME);
  expect(windows.LOCALAPPDATA.endsWith("AppData\\Local")).toBe(true);
  expect(windows.APPDATA.endsWith("AppData\\Roaming")).toBe(true);
  expect(windows.TEMP).toBe(windows.TMPDIR);
  expect(windows.TMP).toBe(windows.TMPDIR);
  // HOME and the XDG_* names stay set on Windows (src/cli/paths.ts honours XDG there).
  expect(windows.HOME).not.toBe("");
  expect(windows.XDG_CONFIG_HOME).not.toBe("");
  expect(windows.CFFIXED_USER_HOME).toBe("");
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
  expect(browserDiscoveryEnvironment("/workspace", {
    PLAYWRIGHT_BROWSERS_PATH: "../browsers/playwright", PUPPETEER_CACHE_DIR: "../browsers/puppeteer",
    PUPPETEER_EXECUTABLE_PATH: "/tools/Browser.app/Contents/MacOS/browser", UNRELATED: "not-forwarded",
  }, "/home/example")).toEqual({
    PLAYWRIGHT_BROWSERS_PATH: "/browsers/playwright", PUPPETEER_CACHE_DIR: "/browsers/puppeteer",
    PUPPETEER_EXECUTABLE_PATH: "/tools/Browser.app/Contents/MacOS/browser",
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

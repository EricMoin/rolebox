import { afterEach, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserDiscoveryEnvironment, executeGraphWorkerCommand } from "../../../src/platform/sandbox/worker-exec.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

// Installed browsers live under the real home, which the disposable command HOME
// hides; the runner names those caches explicitly and lets host configuration win.
it("keeps browser discovery pointed at installed caches", () => {
  expect(browserDiscoveryEnvironment("/workspace", {}, "/home/example")).toEqual({
    PLAYWRIGHT_BROWSERS_PATH: "/home/example/Library/Caches/ms-playwright",
    PUPPETEER_CACHE_DIR: "/home/example/.cache/puppeteer",
  });
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

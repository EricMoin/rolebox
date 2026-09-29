import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { graphWorkerSandbox } from "../../../src/platform/sandbox/graph-worker.ts";
import { graphWorkerSoftware } from "../../../src/platform/sandbox/software.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// macOS cannot nest an OS sandbox: applying any profile from an already sandboxed process
// fails with "sandbox_apply: Operation not permitted". That is an environment limitation,
// not a boundary failure. The OS cases below run on a developer machine and in CI; the
// profile they exercise is asserted without spawning a sandbox in tmp-boundary.test.ts.
function canApplySandbox(): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
}
const boundaryRunnable = canApplySandbox();
if (process.platform === "darwin" && !boundaryRunnable) console.warn("nested OS sandbox unavailable: OS boundary cases are skipped in this environment");

it("keeps browser discovery pointed at installed caches when commands use a disposable home", () => {
  const software = graphWorkerSoftware("/workspace", {}, "/home/example");
  expect(software.env).toEqual({
    PLAYWRIGHT_BROWSERS_PATH: "/home/example/Library/Caches/ms-playwright",
    PUPPETEER_CACHE_DIR: "/home/example/.cache/puppeteer",
  });
  expect(software.readPaths).toContain("/Applications");
  expect(software.readPaths).toContain("/home/example/Applications");
  expect(software.readPaths).not.toContain("/home/example");
});

it("resolves configured installations without passing unrelated environment values", () => {
  const software = graphWorkerSoftware("/workspace", {
    PLAYWRIGHT_BROWSERS_PATH: "../browsers/playwright", PUPPETEER_CACHE_DIR: "../browsers/puppeteer",
    PUPPETEER_EXECUTABLE_PATH: "/tools/Browser.app/Contents/MacOS/browser", UNRELATED: "not-forwarded",
  }, "/home/example");
  expect(software.env).toEqual({
    PLAYWRIGHT_BROWSERS_PATH: "/browsers/playwright", PUPPETEER_CACHE_DIR: "/browsers/puppeteer",
    PUPPETEER_EXECUTABLE_PATH: "/tools/Browser.app/Contents/MacOS/browser",
  });
  expect(software.readPaths).toContain("/tools/Browser.app");
  expect(software.readPaths).not.toContain("/tools");
  for (const path of ["/browsers/playwright", "/browsers/puppeteer"]) expect(software.readPaths).toContain(path);
});

it("preserves package-local Playwright installs and standalone browser executables", () => {
  const software = graphWorkerSoftware("/workspace", {
    PLAYWRIGHT_BROWSERS_PATH: "0", PUPPETEER_EXECUTABLE_PATH: "../browser/chrome",
  }, "/home/example");
  expect(software.env.PLAYWRIGHT_BROWSERS_PATH).toBe("0");
  expect(software.readPaths).not.toContain("/workspace/0");
  expect(software.env.PUPPETEER_EXECUTABLE_PATH).toBe("/browser/chrome");
  expect(software.readPaths).toContain("/browser");
});

it.skipIf(!boundaryRunnable)("reads software resources while denying installation writes, private state and paths outside installations", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-worker-software-policy-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const software = graphWorkerSoftware(workspace, {}, home);
  const dataDirectory = join(software.env.PLAYWRIGHT_BROWSERS_PATH!, "authority");
  mkdirSync(workspace);
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, "private"), "host-private-state");
  writeFileSync(join(home, "private"), "unrelated-private-state");
  const resources = [join(home, "Applications", "Work Tool.app", "Contents", "Resources", "asset"),
    join(software.env.PLAYWRIGHT_BROWSERS_PATH!, "browser"), join(software.env.PUPPETEER_CACHE_DIR!, "browser")];
  for (const path of resources) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "software-resource");
  }
  const alias = join(software.env.PLAYWRIGHT_BROWSERS_PATH!, "alias");
  symlinkSync(join(home, "private"), alias);
  const run = (command: string) => {
    const sandbox = graphWorkerSandbox({ executable: "/bin/sh", args: ["-c", command], workspace, dataDirectory,
      workspaceReadsOnly: true, softwareReadPaths: software.readPaths });
    return spawnSync(sandbox.executable, sandbox.args, { cwd: workspace, encoding: "utf8", timeout: 5000 });
  };
  for (const path of resources) {
    const result = run(`cat '${path}'`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("software-resource");
    expect(run(`echo replaced > '${path}'`).status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("software-resource");
  }
  for (const path of [join(home, "private"), join(dataDirectory, "private"), alias]) {
    const result = run(`cat '${path}'`);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("private-state");
  }
});

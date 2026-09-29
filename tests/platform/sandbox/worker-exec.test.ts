import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGraphWorkerCommand } from "../../../src/platform/sandbox/worker-exec.ts";

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

it.skipIf(!boundaryRunnable)("runs system git in the workspace while preserving private and sibling boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-worker-exec-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const dataDirectory = join(workspace, "data");
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, "private"), "host-private-state");
  writeFileSync(join(root, "sibling"), "sibling-private-state");
  symlinkSync(join(root, "sibling"), join(workspace, "alias"));
  const run = (command: string) => executeGraphWorkerCommand({ command, workspace, dataDirectory, inputPaths: [], timeoutMs: 10_000 });
  const result = await run("/usr/bin/git --version && /usr/bin/git init -q && echo result > output.txt && /usr/bin/git status --porcelain");
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain("git version");
  expect(result.output).toContain("?? output.txt");
  expect(result.output).not.toContain("Operation not permitted");
  expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("result\n");
  for (const command of ["cat data/private", "cat ../sibling", "cat alias", "echo overwritten > data/private", "echo overwritten > ../sibling"]) {
    const denied = await run(command);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.output).not.toContain("private-state");
  }
  expect(readFileSync(join(dataDirectory, "private"), "utf8")).toBe("host-private-state");
  expect(readFileSync(join(root, "sibling"), "utf8")).toBe("sibling-private-state");
}, 30_000);

it.skipIf(!boundaryRunnable)("provides disposable home, config and cache directories to work software", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "graph-worker-software-"));
  roots.push(workspace);
  const result = await executeGraphWorkerCommand({ workspace, dataDirectory: join(workspace, ".rolebox"), inputPaths: [],
    command: 'test -d "$HOME" && test -d "$XDG_CONFIG_HOME" && test -d "$XDG_CACHE_HOME" && echo configured > "$HOME/settings" && echo cached > "$XDG_CACHE_HOME/cache" && printf "%s" "$HOME"' });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).not.toBe("");
  expect(existsSync(result.output)).toBe(false);
});

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
it.skipIf(!boundaryRunnable || !existsSync(chrome))("renders, screenshots and closes an installed browser inside the command sandbox", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "graph-worker-browser-"));
  roots.push(workspace);
  copyFileSync(new URL("./fixtures/browser-probe.ts", import.meta.url), join(workspace, "browser-probe.ts"));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const result = await executeGraphWorkerCommand({ workspace, dataDirectory: join(workspace, ".rolebox"), inputPaths: [], timeoutMs: 20_000,
    command: `${quote(process.execPath)} browser-probe.ts ${quote(chrome)}` });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain("worker-browser-ok\nbrowser-closed\n");
  expect(readFileSync(join(workspace, "screenshot.png")).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}, 25_000);

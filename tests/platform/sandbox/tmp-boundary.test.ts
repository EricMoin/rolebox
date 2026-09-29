import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { graphWorkerSandbox } from "../../../src/platform/sandbox/graph-worker.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// macOS refuses to nest one OS sandbox inside another: applying any profile — even
// "(deny default)" — from an already sandboxed process fails with "sandbox_apply:
// Operation not permitted". The runtime cases below therefore execute only where
// sandbox-exec can be applied (a developer machine or CI); the profile assertions
// run everywhere and pin the rule the runtime cases would exercise.
function canApplySandbox(): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
}
const sandboxRunnable = canApplySandbox();
if (process.platform === "darwin" && !sandboxRunnable) console.warn("nested OS sandbox unavailable: runtime /tmp boundary cases are skipped in this environment");

function build(scratch?: string) {
  const root = mkdtempSync(join(tmpdir(), "graph-worker-tmp-policy-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(dataDirectory);
  const sandbox = graphWorkerSandbox({ executable: "/bin/sh", args: ["-c", "true"], workspace, dataDirectory,
    workspaceReadsOnly: true, ...(scratch ? { scratchDirectory: scratch } : {}) });
  expect(sandbox.args[0]).toBe("-p");
  return { workspace, dataDirectory, profile: sandbox.args[1]! };
}

function rule(profile: string, kind: string): string {
  const line = profile.split("\n").find(candidate => candidate.startsWith(`(${kind} (require-all (require-not `));
  expect(line, `${kind} rule with path filters`).toBeDefined();
  return line!;
}

it.skipIf(process.platform !== "darwin")("keeps literal /tmp paths readable and writable where the workspace is read-only", () => {
  const { profile } = build();
  expect(realpathSync("/tmp")).toBe("/private/tmp");
  const temporary = JSON.stringify(realpathSync("/tmp"));
  for (const kind of ["deny file-read-data", "deny file-write*"]) {
    // A path is denied only when it is outside every root; /tmp must therefore appear
    // in both filters, otherwise a literal /tmp path can never satisfy its own rule.
    expect(rule(profile, kind), kind).toContain(`(require-not (subpath ${temporary}))`);
  }
});

it.skipIf(process.platform !== "darwin")("lists only canonical read roots that can match a real path", () => {
  const { profile } = build();
  const listed = [...rule(profile, "deny file-read-data").matchAll(/\(subpath ("(?:[^"\\]|\\.)*")\)/g)].map(match => JSON.parse(match[1]!) as string);
  expect(listed.length).toBeGreaterThan(10);
  expect(new Set(listed).size).toBe(listed.length);
  for (const path of listed) {
    expect(path.startsWith("/"), path).toBe(true);
    expect(resolve(path), path).toBe(path);
    expect(path.includes("/./"), path).toBe(false);
    expect(path.endsWith("/."), path).toBe(false);
  }
});

it.skipIf(!sandboxRunnable)("reads and writes real files and a scratch directory addressed by literal /tmp paths", () => {
  const home = mkdtempSync(join(tmpdir(), "graph-worker-tmp-home-"));
  const scratch = mkdtempSync(join("/tmp", "graph-worker-tmp-scratch-"));
  const visible = mkdtempSync(join("/tmp", "graph-worker-tmp-visible-"));
  roots.push(home, scratch, visible);
  const workspace = join(home, "workspace");
  const dataDirectory = join(home, "data");
  const foreign = join(home, "foreign");
  mkdirSync(workspace);
  mkdirSync(dataDirectory);
  mkdirSync(foreign);
  writeFileSync(join(dataDirectory, "private"), "host-private-state");
  writeFileSync(join(foreign, "credentials"), "foreign-private-state");
  writeFileSync(join(visible, "probe"), "tmp-visible-state");
  symlinkSync(join(dataDirectory, "private"), join(visible, "alias"));
  const run = (command: string) => {
    const sandbox = graphWorkerSandbox({ executable: "/bin/sh", args: ["-c", command], workspace, dataDirectory,
      workspaceReadsOnly: true, scratchDirectory: scratch });
    return spawnSync(sandbox.executable, sandbox.args, { cwd: workspace, encoding: "utf8", timeout: 5000 });
  };
  // `visible` is under /tmp but is not the declared scratch root: the vnode path itself is allowed.
  const written = run(`cat '${join(visible, "probe")}' && echo written > '${join(visible, "created")}' && cat '${join(visible, "created")}'`);
  expect(written.error).toBeUndefined();
  expect(written.status, written.stderr).toBe(0);
  // `probe` is written without a trailing newline, so the first `cat` runs straight
  // into the `cat` of the file the sandbox just created, yielding one line: "written\n".
  expect(written.stdout).toBe("tmp-visible-statewritten\n");
  expect(readFileSync(join(visible, "created"), "utf8")).toBe("written\n");
  const scratchRun = run(`echo scratch-state > '${join(scratch, "file")}' && cat '${join(scratch, "file")}'`);
  expect(scratchRun.status, scratchRun.stderr).toBe(0);
  expect(scratchRun.stdout).toBe("scratch-state\n");
  for (const path of [join(visible, "alias"), join(dataDirectory, "private"), join(foreign, "credentials")]) {
    const denied = run(`cat '${path}'`);
    expect(denied.error).toBeUndefined();
    expect(denied.status, path).not.toBe(0);
    expect(denied.stdout).not.toContain("private-state");
  }
});

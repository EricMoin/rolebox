import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGraphWorkerCommand } from "../../../src/platform/sandbox/worker-exec.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform !== "darwin")("runs system git in the workspace while preserving private and sibling boundaries", async () => {
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

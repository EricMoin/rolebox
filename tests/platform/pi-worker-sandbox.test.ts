import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { graphWorkerSandbox } from "../../src/platform/sandbox/graph-worker.ts";
import { childSessionFile } from "../../src/platform/adapters/pi/child-session.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-worker-sandbox-")); roots.push(root);
  const data = join(root, "data"); mkdirSync(data);
  const authority = join(data, "authority"); writeFileSync(authority, "private-authority");
  const sessions = join(root, ".rolebox", "pi-sessions"); mkdirSync(sessions, { recursive: true });
  const sessionFile = join(sessions, "own.jsonl"); writeFileSync(sessionFile, "own-session");
  const sibling = join(sessions, "other.jsonl"); writeFileSync(sibling, "other-credential");
  symlinkSync(authority, join(root, "alias"));
  const run = (command: string) => {
    const sandbox = graphWorkerSandbox({ executable: "/bin/sh", args: ["-c", command], workspace: root, dataDirectory: data, sessionFile });
    return spawnSync(sandbox.executable, sandbox.args, { cwd: root, encoding: "utf8", timeout: 5000 });
  };
  return { root, authority, run };
}
describe("Pi graph worker OS boundary", () => {
  it.skipIf(process.platform !== "darwin")("blocks authority reads/writes, sibling credentials, symlinks and hardlinks in child commands", () => {
    const { root, authority, run } = fixture();
    for (const command of ["cat data/authority", "echo replaced > data/authority", "cat .rolebox/pi-sessions/other.jsonl", "cat alias", "ln data/authority copied && cat copied"]) {
      const result = run(command);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("private-authority");
      expect(result.stdout).not.toContain("other-credential");
    }
    expect(readFileSync(authority, "utf8")).toBe("private-authority");
    expect(run("echo task-output > result.txt && cat result.txt").stdout).toBe("task-output\n");
    expect(readFileSync(join(root, "result.txt"), "utf8")).toBe("task-output\n");
    expect(run("cat .rolebox/pi-sessions/own.jsonl").stdout).toBe("own-session");
  });

  it("creates the native SDK session with the identity dispatch records and rejects replacement", async () => {
    const { root } = fixture();
    const path = await childSessionFile(root, "fixture-session");
    expect(JSON.parse(readFileSync(path, "utf8")).id).toBe("fixture-session");
    expect(await childSessionFile(root, "fixture-session")).toBe(path);
    const header = JSON.parse(readFileSync(path, "utf8")); header.id = "replacement";
    writeFileSync(path, JSON.stringify(header) + "\n");
    expect(childSessionFile(root, "fixture-session")).rejects.toThrow("identity mismatch");
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gradeBenchmarkWorkspace } from "../../src/benchmark/grading.ts";
import { snapshotBenchmarkFiles } from "../../src/benchmark/workspace.ts";
import type { BenchmarkAssertion, BenchmarkCase, BenchmarkFileSnapshot, BenchmarkWorkerResult } from "../../src/benchmark/types.ts";

const roots: string[] = [];
const result: BenchmarkWorkerResult = {
  protocolVersion: 1, status: "completed", output: "fixed", durationMs: 10, terminationConfirmed: true,
  usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" },
};
const caseWith = (...assertions: BenchmarkAssertion[]): BenchmarkCase => ({ id: "repair", prompt: "Fix the implementation", assertions });
const command = (code: string, options: { timeoutMs?: number; expectedExitCode?: number; args?: string[] } = {}): BenchmarkAssertion => ({
  kind: "command", argv: [process.execPath, "-e", code, ...(options.args ?? [])],
  timeoutMs: options.timeoutMs ?? 3_000, expectedExitCode: options.expectedExitCode ?? 0,
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rolebox-test-workspace-grading-"));
  roots.push(root);
  return root;
}

async function snapshot(files: Record<string, string | Buffer>): Promise<BenchmarkFileSnapshot> {
  const root = await temporaryDirectory();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return snapshotBenchmarkFiles(root);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("benchmark workspace file grading", () => {
  it("combines final text with exact file bytes, substring content and file existence", async () => {
    const workspace = await snapshot({ "src/result.txt": "hello\n世界", "empty.txt": "" });
    const grade = await gradeBenchmarkWorkspace(caseWith(
      { kind: "equals", value: "fixed" },
      { kind: "contains", value: "ixe" },
      { kind: "file_exists", path: "empty.txt" },
      { kind: "file_equals", path: "src/result.txt", value: "hello\n世界" },
      { kind: "file_contains", path: "src/result.txt", value: "世界" },
    ), result, { workspace });
    expect(grade.verdict).toBe("pass");
    expect(grade.assertions).toHaveLength(5);
    expect(grade.terminationConfirmed).toBe(true);
  });

  it("fails missing files, invalid UTF-8, binary content and whitespace mismatches", async () => {
    const workspace = await snapshot({ "newline.txt": "hello\n", "binary.bin": Buffer.from([0, 65]), "control.bin": Buffer.from([1, 65]), "invalid.txt": Buffer.from([0xff]) });
    const grade = await gradeBenchmarkWorkspace(caseWith(
      { kind: "file_exists", path: "missing.txt" },
      { kind: "file_equals", path: "missing.txt", value: "" },
      { kind: "file_equals", path: "newline.txt", value: "hello" },
      { kind: "file_contains", path: "binary.bin", value: "A" },
      { kind: "file_contains", path: "control.bin", value: "A" },
      { kind: "file_contains", path: "invalid.txt", value: "" },
      { kind: "file_exists", path: "binary.bin" },
    ), result, { workspace });
    expect(grade.verdict).toBe("fail");
    expect(grade.assertions.map(assertion => assertion.passed)).toEqual([false, false, false, false, false, false, true]);
  });

  it("preserves the UTF-8 byte order mark in exact text assertions", async () => {
    const workspace = await snapshot({ "bom.txt": "\ufeffhello" });
    const grade = await gradeBenchmarkWorkspace(caseWith(
      { kind: "file_equals", path: "bom.txt", value: "\ufeffhello" },
      { kind: "file_equals", path: "bom.txt", value: "hello" },
    ), result, { workspace });
    expect(grade.assertions.map(assertion => assertion.passed)).toEqual([true, false]);
  });

  it("does not execute any grader after failed, cancelled or unconfirmed model execution", async () => {
    const workspace = await snapshot({});
    const item = caseWith(command("throw new Error('must not run')"));
    for (const status of ["task_failure", "task_timeout", "infra_error", "invalid", "cancelled"] as const) {
      const grade = await gradeBenchmarkWorkspace(item, { ...result, status }, { workspace });
      expect(grade.verdict).toBe(status === "task_failure" || status === "task_timeout" ? "fail" : "unscored");
      expect(grade.assertions).toEqual([]);
    }
    expect((await gradeBenchmarkWorkspace(item, { ...result, terminationConfirmed: false }, { workspace })).assertions).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("benchmark command grading", () => {
  it("runs real external checks that fail a broken artifact and pass a repaired artifact", async () => {
    const checks = await snapshot({ "test.mjs": "const { add } = await import(process.argv[2]); if (add(2, 3) !== 5) { console.error('wrong sum'); process.exit(1); } console.log('checks passed');\n" });
    const item = caseWith({ kind: "command", argv: [process.execPath, "{checks}/test.mjs", "{workspace}/main.mjs"], timeoutMs: 3_000, expectedExitCode: 0 });
    const broken = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({ "main.mjs": "export const add = (a, b) => a - b;\n" }), checks });
    expect(broken.verdict).toBe("fail");
    expect(broken.error).toBeUndefined();
    expect(broken.assertions[0]!.command).toMatchObject({ status: "completed", exitCode: 1, terminationConfirmed: true, stderr: "wrong sum\n" });
    const repaired = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({ "main.mjs": "export const add = (a, b) => a + b;\n" }), checks });
    expect(repaired.verdict).toBe("pass");
    expect(repaired.assertions[0]!.command?.stdout).toBe("checks passed\n");
  });

  it("keeps checks separate from agent files and gives every command a fresh copy", async () => {
    const workspace = await snapshot({ "checks/trusted.txt": "agent replacement", "answer.txt": "original" });
    const checks = await snapshot({ "trusted.txt": "trusted check" });
    const original = JSON.stringify({ workspace, checks });
    const item = caseWith(
      command("const fs = require('node:fs'); if (fs.readFileSync(process.argv[1], 'utf8') !== 'trusted check') process.exit(1); fs.writeFileSync(process.argv[1], 'changed check'); fs.writeFileSync('answer.txt', 'changed'); fs.writeFileSync('marker', 'created');", { args: ["{checks}/trusted.txt"] }),
      command("const fs = require('node:fs'); if (fs.readFileSync(process.argv[1], 'utf8') !== 'trusted check' || fs.readFileSync('answer.txt', 'utf8') !== 'original' || fs.existsSync('marker')) process.exit(1);", { args: ["{checks}/trusted.txt"] }),
      { kind: "file_equals", path: "answer.txt", value: "original" },
    );
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace, checks });
    expect(grade.verdict).toBe("pass");
    expect(JSON.stringify({ workspace, checks })).toBe(original);
    expect(await readFile(join(roots[0]!, "answer.txt"), "utf8")).toBe("original");
    expect(await readFile(join(roots[1]!, "trusted.txt"), "utf8")).toBe("trusted check");
  });

  it("passes literal argv without shell expansion and honors an explicitly expected nonzero exit", async () => {
    const item = caseWith(command("if (process.argv[1] !== '$(echo unexpected); $HOME *') process.exit(1); process.exit(7);", {
      args: ["$(echo unexpected); $HOME *"], expectedExitCode: 7,
    }));
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
    expect(grade.verdict).toBe("pass");
    expect(grade.assertions[0]!.command?.exitCode).toBe(7);
  });

  it("isolates HOME and configuration paths without inheriting arbitrary environment values", async () => {
    const previous = process.env.BENCHMARK_GRADER_TEST_SECRET;
    process.env.BENCHMARK_GRADER_TEST_SECRET = "test-only-sensitive-value";
    try {
      const item = caseWith(command("const fs = require('node:fs'); const path = require('node:path'); if (process.env.BENCHMARK_GRADER_TEST_SECRET !== undefined) process.exit(1); for (const key of ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TEMP', 'TMP', 'ROLEBOX_DATA_DIR', 'ROLEBOX_CONFIG_DIR']) { if (fs.realpathSync(path.dirname(process.env[key])) !== path.dirname(process.cwd())) process.exit(1); } console.log(process.cwd());"));
      const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
      expect(grade.verdict).toBe("pass");
      const workspace = grade.assertions[0]!.command!.stdout.trim();
      expect(workspace).toContain("rolebox-benchmark-grader-");
      await expect(access(dirname(workspace))).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BENCHMARK_GRADER_TEST_SECRET;
      else process.env.BENCHMARK_GRADER_TEST_SECRET = previous;
    }
  });

  it("drains large stdout and stderr while storing only bounded evidence", async () => {
    const item = caseWith(command("process.stdout.write('a'.repeat(200000)); process.stderr.write('b'.repeat(200000));"));
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
    expect(grade.verdict).toBe("pass");
    expect(grade.assertions[0]!.command).toMatchObject({ stdout: "a".repeat(16_384), stderr: "b".repeat(16_384), truncated: true });
  });

  it("scores a command timeout as failure after confirming cleanup", async () => {
    const item = caseWith(command("console.log(process.pid); setInterval(() => {}, 1000);", { timeoutMs: 200 }));
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
    expect(grade.verdict).toBe("fail");
    expect(grade.error).toBeUndefined();
    expect(grade.assertions[0]!.command).toMatchObject({ status: "timeout", exitCode: null, terminationConfirmed: true });
    const pid = Number(grade.assertions[0]!.command!.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(processExists(pid)).toBe(false);
  });

  it("enforces the deadline against a SIGTERM-resistant process and its descendants", async () => {
    const item = caseWith(command("const { spawn } = require('node:child_process'); process.on('SIGTERM', () => {}); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); console.log(JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);", { timeoutMs: 200 }));
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
    expect(grade.verdict).toBe("fail");
    expect(grade.assertions[0]!.command).toMatchObject({ status: "timeout", terminationConfirmed: true });
    const pids = JSON.parse(grade.assertions[0]!.command!.stdout.trim()) as number[];
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(pid).toBeGreaterThan(0);
      expect(processExists(pid)).toBe(false);
    }
  });

  it("continues scoring later assertions after an ordinary failed command", async () => {
    const item = caseWith(command("process.exit(1)"), command("console.log('second check')"));
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
    expect(grade.verdict).toBe("fail");
    expect(grade.assertions.map(assertion => assertion.passed)).toEqual([false, true]);
    expect(grade.assertions[1]!.command?.stdout).toBe("second check\n");
  });

  it("cancels a running command, confirms cleanup and leaves later assertions unscored", async () => {
    const marker = join(await temporaryDirectory(), "ready");
    const controller = new AbortController();
    const item = caseWith(command("require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", { args: [marker] }),
      { kind: "equals", value: "fixed" });
    const grading = gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}), signal: controller.signal });
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try { await access(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      const pid = Number(await readFile(marker, "utf8"));
      controller.abort();
      const grade = await grading;
      expect(grade.verdict).toBe("unscored");
      expect(grade.error).toContain("cancelled");
      expect(grade.terminationConfirmed).toBe(true);
      expect(grade.assertions).toHaveLength(1);
      expect(grade.assertions[0]!.command?.status).toBe("cancelled");
      expect(processExists(pid)).toBe(false);
    } finally { controller.abort(); await grading; }
  });

  it("reaps lingering descendants and treats their unexpected survival as infrastructure failure", async () => {
    const item = caseWith(command("const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); console.log(child.pid);"));
    const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
    expect(grade.verdict).toBe("unscored");
    expect(grade.error).toContain("descendant");
    expect(grade.terminationConfirmed).toBe(true);
    expect(grade.assertions[0]!.command?.status).toBe("error");
    const pid = Number(grade.assertions[0]!.command!.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(processExists(pid)).toBe(false);
  });

  it("retains the grading directory when inherited pipes prevent cleanup confirmation", async () => {
    const marker = join(await temporaryDirectory(), "escaped-child.json");
    const item = caseWith(command("const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] }); child.unref(); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: child.pid, directory: require('node:path').dirname(process.cwd()) }));", { args: [marker] }));
    try {
      const grade = await gradeBenchmarkWorkspace(item, result, { workspace: await snapshot({}) });
      const escaped = JSON.parse(await readFile(marker, "utf8")) as { pid: number; directory: string };
      expect(grade.verdict).toBe("unscored");
      expect(grade.terminationConfirmed).toBe(false);
      expect(grade.error).toContain("process-tree termination");
      expect(grade.assertions[0]!.command?.terminationConfirmed).toBe(false);
      expect(processExists(escaped.pid)).toBe(true);
      await access(escaped.directory);
    } finally {
      const markerContent = await readFile(marker, "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
      if (markerContent) {
        const escaped = JSON.parse(markerContent) as { pid: number; directory: string };
        roots.push(escaped.directory);
        try { process.kill(-escaped.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        const deadline = Date.now() + 1_000;
        while (processExists(escaped.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        expect(processExists(escaped.pid)).toBe(false);
      }
    }
  });

  it("marks missing executables and absent checks as unscored grader errors", async () => {
    const workspace = await snapshot({});
    const missing = await gradeBenchmarkWorkspace(caseWith({ kind: "command", argv: ["/benchmark-command-that-does-not-exist"], timeoutMs: 1_000, expectedExitCode: 0 }), result, { workspace });
    expect(missing.verdict).toBe("unscored");
    expect(missing.terminationConfirmed).toBe(true);
    expect(missing.assertions[0]!.command).toMatchObject({ status: "error", exitCode: null });
    const checks = await gradeBenchmarkWorkspace(caseWith(command("", { args: ["{checks}/test.mjs"] })), result, { workspace });
    expect(checks.verdict).toBe("unscored");
    expect(checks.error).toContain("checks snapshot");
  });

  it("does not start grading when cancellation precedes the request", async () => {
    const grade = await gradeBenchmarkWorkspace(caseWith(command("console.log('must not run')")), result,
      { workspace: await snapshot({}), signal: AbortSignal.abort() });
    expect(grade.verdict).toBe("unscored");
    expect(grade.assertions).toEqual([]);
    expect(grade.terminationConfirmed).toBe(true);
    expect(grade.error).toContain("cancelled");
  });

  it("rejects invalid programmatic deadlines instead of disabling timeout enforcement", async () => {
    const workspace = await snapshot({});
    for (const timeoutMs of [NaN, Infinity, 0, -1, 1.5, 2_147_483_648]) {
      const grade = await gradeBenchmarkWorkspace(caseWith(command("process.exit(0)", { timeoutMs })), result, { workspace });
      expect(grade.verdict).toBe("unscored");
      expect(grade.error).toContain("invalid");
      expect(grade.terminationConfirmed).toBe(true);
    }
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldBenchmark } from "../../src/benchmark/scaffold.ts";
import { loadBenchmarkSuite } from "../../src/benchmark/spec.ts";
import { runBenchmark } from "../../src/benchmark/runner.ts";
import { readBenchmarkRun } from "../../src/benchmark/store.ts";
import { summarizeBenchmarkRun } from "../../src/benchmark/report.ts";
import type { BenchmarkWorkerRequest, BenchmarkWorkerResult } from "../../src/benchmark/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "benchmark-workspace-run-"));
  roots.push(root);
  const directory = await scaffoldBenchmark(join(root, "suite"), "code-fix");
  const loaded = await loadBenchmarkSuite(directory);
  return { root, directory, loaded, outputDirectory: join(root, "results") };
}

function completed(request: BenchmarkWorkerRequest): BenchmarkWorkerResult {
  return { protocolVersion: 1, status: "completed", output: "Fixed", durationMs: 1, terminationConfirmed: true,
    activation: { roleId: request.roleId, provider: request.provider, model: request.model, promptDigest: "a".repeat(64) },
    runtime: { dshVersion: "1.0.0", roleboxVersion: "1.0.0" },
    usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" } };
}

describe.skipIf(process.platform === "win32")("workspace benchmark lifecycle", () => {
  it("freezes fixtures and checks, scores independent trials and preserves final files before cleanup", async () => {
    const target = await fixture();
    const source = join(target.directory, "fixtures", "sum", "src", "sum.mjs");
    const before = await readFile(source, "utf8");
    await writeFile(source, "edited after load");
    await writeFile(join(target.directory, "checks", "sum", "check.mjs"), "throw new Error('changed check');");
    target.loaded.suite.run.repetitions = 2;
    target.loaded.suite.run.concurrency = 2;
    const workspaces: string[] = [];
    const result = await runBenchmark(target.loaded, { outputDirectory: target.outputDirectory, execute: async request => {
      expect(request.workspaceTask).toBe(true);
      workspaces.push(request.workspace);
      const file = join(request.workspace, "src", "sum.mjs");
      expect(await readFile(file, "utf8")).toBe(before);
      await writeFile(file, before.replace("total + value);", "total + value, 0);"));
      return completed(request);
    } });
    expect(result.record.status).toBe("completed");
    expect(summarizeBenchmarkRun(result.record).successRate).toBe(1);
    expect(readBenchmarkRun(result.directory)).toEqual(result.record);
    expect(new Set(workspaces).size).toBe(2);
    for (const trial of result.record.trials) {
      expect(trial.workspace?.changes[0]).toMatchObject({ path: "src/sum.mjs", kind: "modified", beforeText: before });
      expect(trial.grade.assertions[1]!.command?.stdout).toContain("All sum checks passed");
      expect(await readFile(join(result.directory, trial.workspace!.artifactDirectory, "src", "sum.mjs"), "utf8"))
        .toBe(before.replace("total + value);", "total + value, 0);"));
    }
    for (const workspace of workspaces) await expect(access(workspace)).rejects.toThrow();
    expect(await readFile(source, "utf8")).toBe("edited after load");
  });

  it("counts failed checks as a scored failure and a missing grader executable as unscored", async () => {
    const target = await fixture();
    const failed = await runBenchmark(target.loaded, { outputDirectory: target.outputDirectory, execute: async request => completed(request) });
    expect(failed.record.status).toBe("completed");
    expect(summarizeBenchmarkRun(failed.record).successRate).toBe(0);
    expect(readBenchmarkRun(failed.directory).trials[0]!.grade.verdict).toBe("fail");
    target.loaded.cases[0]!.assertions = [{ kind: "command", argv: ["benchmark-executable-does-not-exist"], timeoutMs: 100, expectedExitCode: 0 }];
    const error = await runBenchmark(target.loaded, { outputDirectory: target.outputDirectory, execute: async request => completed(request) });
    expect(error.record.status).toBe("incomplete");
    expect(error.record.trials[0]!.result.status).toBe("completed");
    expect(readBenchmarkRun(error.directory).trials[0]!.grade).toMatchObject({ verdict: "unscored", terminationConfirmed: true });
    expect(summarizeBenchmarkRun(error.record).successRate).toBeNull();
  });

  it("keeps case-sensitive IDs distinct in saved fixture directories", async () => {
    const target = await fixture();
    const original = target.loaded.cases[0]!;
    await writeFile(join(target.directory, "cases.jsonl"), ["Case", "case"].map(id => JSON.stringify({
      ...original, id, assertions: [{ kind: "file_exists", path: "src/sum.mjs" }],
    })).join("\n"));
    const loaded = await loadBenchmarkSuite(target.directory);
    const result = await runBenchmark(loaded, { outputDirectory: target.outputDirectory, execute: async request => completed(request) });
    expect(result.record.status).toBe("completed");
    expect(result.record.trials.map(trial => trial.caseId)).toEqual(["Case", "case"]);
    const plan = JSON.parse(await readFile(join(result.directory, "plan.json"), "utf8"));
    expect(plan.workspaces.Case).toMatchObject({ fixtureDirectory: "fixtures/000000/workspace", checksDirectory: "fixtures/000000/checks" });
    expect(plan.workspaces.case).toMatchObject({ fixtureDirectory: "fixtures/000001/workspace", checksDirectory: "fixtures/000001/checks" });
    for (const id of ["Case", "case"]) {
      expect(await readFile(join(result.directory, plan.workspaces[id].fixtureDirectory, "src/sum.mjs"), "utf8"))
        .toBe(Buffer.from(loaded.workspaces![id]!.fixture.files.find(file => file.path === "src/sum.mjs")!.content, "base64").toString("utf8"));
      expect(await readFile(join(result.directory, plan.workspaces[id].checksDirectory, "check.mjs"), "utf8"))
        .toBe(Buffer.from(loaded.workspaces![id]!.checks!.files.find(file => file.path === "check.mjs")!.content, "base64").toString("utf8"));
    }
  });

  it("records cancellation without materializing fixtures for a pre-aborted run", async () => {
    const target = await fixture();
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    const result = await runBenchmark(target.loaded, {
      outputDirectory: target.outputDirectory, signal: controller.signal,
      execute: async request => { executed = true; return completed(request); },
    });
    expect(executed).toBe(false);
    expect(result.record.status).toBe("incomplete");
    expect(result.record.trials).toHaveLength(target.loaded.cases.length);
    expect(result.record.trials.every(trial => trial.result.status === "cancelled" && trial.grade.verdict === "unscored")).toBe(true);
    await expect(access(join(result.directory, "fixtures"))).rejects.toThrow();
    const plan = JSON.parse(await readFile(join(result.directory, "plan.json"), "utf8"));
    expect(plan.workspaces[target.loaded.cases[0]!.id]).toMatchObject({ fixtureDirectory: "fixtures/000000/workspace", checksDirectory: "fixtures/000000/checks" });
    expect(readBenchmarkRun(result.directory)).toEqual(result.record);
  });

  it("does not treat inherited property names as workspace inputs for response cases", async () => {
    const target = await fixture();
    await writeFile(join(target.directory, "cases.jsonl"), [
      { ...target.loaded.cases[0]!, assertions: [{ kind: "file_exists", path: "src/sum.mjs" }] },
      { id: "constructor", prompt: "Reply Fixed", assertions: [{ kind: "equals", value: "Fixed" }] },
    ].map(item => JSON.stringify(item)).join("\n"));
    const loaded = await loadBenchmarkSuite(target.directory);
    const workspaceTasks: Array<boolean | undefined> = [];
    const result = await runBenchmark(loaded, { outputDirectory: target.outputDirectory, execute: async request => {
      workspaceTasks.push(request.workspaceTask);
      return completed(request);
    } });
    expect(result.record.status).toBe("completed");
    expect(workspaceTasks).toEqual([true, undefined]);
    expect(result.record.trials[1]).toMatchObject({ caseId: "constructor", grade: { verdict: "pass" } });
    expect(result.record.trials[1]!.workspace).toBeUndefined();
    expect(readBenchmarkRun(result.directory)).toEqual(result.record);
  });

  it("rejects output directories nested within fixture or check sources", async () => {
    const target = await fixture();
    for (const directory of ["fixtures/sum", "checks/sum"]) {
      await expect(runBenchmark(target.loaded, { outputDirectory: join(target.directory, directory, "results") })).rejects.toThrow("outside fixture and check");
    }
  });

  it("does not follow unsafe output links and still confirms the already-stopped model cleanup", async () => {
    const target = await fixture();
    let workspace = "";
    const result = await runBenchmark(target.loaded, { outputDirectory: target.outputDirectory, execute: async request => {
      workspace = request.workspace;
      await symlink(join(target.directory, "checks"), join(workspace, "escape"));
      return completed(request);
    } });
    expect(result.record.status).toBe("incomplete");
    expect(result.record.trials[0]!.grade).toMatchObject({ verdict: "unscored", terminationConfirmed: true });
    expect(result.record.trials[0]!.workspace).toBeUndefined();
    await expect(access(workspace)).rejects.toThrow();
    expect(readBenchmarkRun(result.directory).trials[0]!.grade.error).toContain("captured");
  });

  it("does not persist workspace artifacts containing explicitly forwarded values", async () => {
    const target = await fixture();
    const key = "BENCHMARK_TEST_SECRET";
    const previous = process.env[key];
    const secret = "fixture-credential-not-a-real-secret";
    process.env[key] = secret;
    target.loaded.suite.host.env = [key];
    try {
      const result = await runBenchmark(target.loaded, { outputDirectory: target.outputDirectory, execute: async request => {
        await writeFile(join(request.workspace, "credential.txt"), secret);
        return completed(request);
      } });
      expect(result.record.status).toBe("incomplete");
      expect(result.record.trials[0]!.workspace).toBeUndefined();
      expect(result.record.trials[0]!.grade.verdict).toBe("unscored");
      expect(JSON.stringify(readBenchmarkRun(result.directory))).not.toContain(secret);
      await expect(access(join(result.directory, "artifacts"))).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });

  it("does not execute checks after task timeout or a host failure", async () => {
    const target = await fixture();
    target.loaded.cases[0]!.assertions = [{ kind: "command", argv: ["benchmark-executable-does-not-exist"], timeoutMs: 100, expectedExitCode: 0 }];
    for (const status of ["task_timeout", "task_failure"] as const) {
      const result = await runBenchmark(target.loaded, { outputDirectory: target.outputDirectory, execute: async request => ({ ...completed(request), status }) });
      expect(readBenchmarkRun(result.directory).trials[0]!.grade).toEqual({ verdict: "fail", assertions: [] });
      expect(result.record.status).toBe("completed");
    }
  });
});

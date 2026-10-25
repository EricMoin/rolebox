import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmark } from "../../src/benchmark/runner.ts";
import { readBenchmarkRun } from "../../src/benchmark/store.ts";
import { loadBenchmarkSuite } from "../../src/benchmark/spec.ts";
import { scaffoldBenchmark } from "../../src/benchmark/scaffold.ts";
import { summarizeBenchmarkRun } from "../../src/benchmark/report.ts";
import type { BenchmarkWorkerRequest, BenchmarkWorkerResult } from "../../src/benchmark/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bench-run-test-")); roots.push(root);
  const directory = await scaffoldBenchmark(join(root, "example"));
  await writeFile(join(directory, "cases.jsonl"), ["one", "two"].map(id => JSON.stringify({ id, prompt: "Answer yes", assertions: [{ kind: "equals", value: "yes" }] })).join("\n"));
  return { loaded: await loadBenchmarkSuite(directory), output: join(root, "runs") };
}
function completed(request: BenchmarkWorkerRequest): BenchmarkWorkerResult {
  return { protocolVersion: 1, status: "completed", output: "yes", usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" }, durationMs: 1, terminationConfirmed: true,
    activation: { roleId: request.roleId, provider: request.provider, model: request.model, promptDigest: "a".repeat(64) } };
}

describe("benchmark run lifecycle", () => {
  it("runs the full plan in isolated workspaces and persists queryable results", async () => {
    const { loaded, output } = await fixture();
    loaded.suite.run.repetitions = 2;
    loaded.suite.run.concurrency = 2;
    const workspaces = new Set<string>();
    const result = await runBenchmark(loaded, { outputDirectory: output, execute: async request => {
      workspaces.add(request.workspace);
      await writeFile(join(request.workspace, "state"), "trial state");
      return completed(request);
    } });
    expect(workspaces.size).toBe(4);
    expect(result.record.status).toBe("completed");
    expect(readBenchmarkRun(result.directory)).toEqual(result.record);
    const summary = summarizeBenchmarkRun(result.record);
    expect(summary.successRate).toBe(1);
    const plan = JSON.parse(await readFile(join(result.directory, "plan.json"), "utf8"));
    expect(plan.cases).toEqual(loaded.cases);
    expect(plan.target.provider).toBe(loaded.suite.target.provider);
    for (const workspace of workspaces) await expect(access(workspace)).rejects.toThrow();
  });
  it("persists cancellation for the entire planned denominator without starting workers", async () => {
    const { loaded, output } = await fixture();
    const controller = new AbortController(); controller.abort();
    let invoked = false;
    const result = await runBenchmark(loaded, { outputDirectory: output, signal: controller.signal, execute: async request => { invoked = true; return completed(request); } });
    expect(invoked).toBe(false);
    expect(result.record.status).toBe("incomplete");
    expect(result.record.trials).toHaveLength(2);
    expect(result.record.trials.every(trial => trial.result.status === "cancelled")).toBe(true);
    expect(summarizeBenchmarkRun(result.record).successRate).toBeNull();
  });
  it("does not turn a worker error into a task failure or retry", async () => {
    const { loaded, output } = await fixture(); let calls = 0;
    const result = await runBenchmark(loaded, { outputDirectory: output, execute: async request => { calls++; roots.push(join(request.workspace, "..")); throw new Error("private diagnostic"); } });
    expect(calls).toBe(1);
    expect(result.record.status).toBe("incomplete");
    expect(result.record.trials.every(trial => trial.grade.verdict === "unscored")).toBe(true);
    expect(JSON.stringify(result.record)).not.toContain("private diagnostic");
    expect(result.record.trials[0].result.terminationConfirmed).toBe(false);
    expect(result.record.trials[1].result.status).toBe("cancelled");
  });
  it("counts a declared task timeout as a scored failure", async () => {
    const { loaded, output } = await fixture();
    const result = await runBenchmark(loaded, { outputDirectory: output, execute: async request => ({ ...completed(request), status: "task_timeout", output: "" }) });
    expect(result.record.status).toBe("completed");
    expect(summarizeBenchmarkRun(result.record).successRate).toBe(0);
  });
  it("retains the workspace and stops the plan if termination is unconfirmed", async () => {
    const { loaded, output } = await fixture();
    let workspace = "";
    const result = await runBenchmark(loaded, { outputDirectory: output, execute: async request => {
      workspace = request.workspace;
      roots.push(join(workspace, ".."));
      return { ...completed(request), terminationConfirmed: false };
    } });
    await access(workspace);
    expect(result.record.trials[0].result.status).toBe("infra_error");
    expect(result.record.trials[1].result.status).toBe("cancelled");
    expect(result.record.status).toBe("incomplete");
  });
  it("rejects result directories that would mutate the role being measured", async () => {
    const { loaded } = await fixture();
    await expect(runBenchmark(loaded, { outputDirectory: join(loaded.roleDirectory, "results") })).rejects.toThrow("outside the target role");
  });
});

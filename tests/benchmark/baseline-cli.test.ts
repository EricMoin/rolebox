import { spawnProcess } from "../../scripts/node-process.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkBaselineInfo } from "../../src/benchmark/baseline.ts";
import type { BenchmarkComparison } from "../../src/benchmark/compare.ts";
import { BenchmarkStore, readBenchmarkRun } from "../../src/benchmark/store.ts";
import type { BenchmarkRunRecord } from "../../src/benchmark/types.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const entry = process.env.ROLEBOX_BENCH_TEST_ENTRY ? resolve(process.env.ROLEBOX_BENCH_TEST_ENTRY) : join(repository, "src", "cli", "main.ts");
const packageVersion = (JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { version: string }).version;
let root: string;
let env: Record<string, string>;
let cacheContents: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-baseline-cli-"));
  env = {
    PATH: process.env.PATH ?? "", HOME: join(root, "home"), DSH_HOME: join(root, "dsh"),
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"), ROLEBOX_CONFIG_DIR: join(root, "config"),
    ROLEBOX_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp"),
    ROLEBOX_ENGINE_RECOVERY: "off", ROLEBOX_HOT_RELOAD: "false", NO_COLOR: "1",
  };
  for (const name of ["HOME", "DSH_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ROLEBOX_CONFIG_DIR", "ROLEBOX_DATA_DIR", "TMPDIR"]) {
    await mkdir(env[name]!, { recursive: true, mode: 0o700 });
  }
  await mkdir(join(env.ROLEBOX_DATA_DIR!, "cache"), { mode: 0o700 });
  cacheContents = JSON.stringify({ latestVersion: packageVersion, checkedAt: new Date().toISOString() });
  await writeFile(join(env.ROLEBOX_DATA_DIR!, "cache", "version-check.json"), cacheContents, { mode: 0o600 });
});

afterEach(async () => {
  try { expect(await readFile(join(env.ROLEBOX_DATA_DIR!, "cache", "version-check.json"), "utf8")).toBe(cacheContents); }
  finally { await rm(root, { recursive: true, force: true }); }
});

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawnProcess([process.execPath, entry, "bench", ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut) throw new Error("Benchmark baseline CLI fixture exceeded its deadline.");
    return { code, stdout, stderr };
  } finally { clearTimeout(deadline); }
}

async function savedRun(name: string, options: { passes?: boolean[]; incomplete?: boolean; suiteDigest?: string; caseId?: string; missingRuntime?: boolean } = {}): Promise<string> {
  const caseId = options.caseId ?? "case";
  const passes = options.passes ?? [true, true];
  const record: BenchmarkRunRecord = {
    schemaVersion: 1, id: name, suiteId: "offline-suite", suiteDigest: options.suiteDigest ?? "a".repeat(64),
    roleDigest: (name === "baseline" ? "b" : "c").repeat(64), startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z", status: options.incomplete ? "incomplete" : "completed",
    isolation: "trusted-process", plannedTrials: passes.length, repetitions: passes.length, caseIds: [caseId],
    trials: passes.map((passed, repetition) => ({
      id: `trial-${repetition}`, caseId, repetition,
      result: {
        protocolVersion: 1, status: "completed", output: "offline fixture output",
        activation: { roleId: "role", provider: "example-provider", model: "scripted", promptDigest: "d".repeat(64) },
        ...(options.missingRuntime ? {} : { runtime: { dshVersion: "fixture-runtime", roleboxVersion: "fixture-rolebox" } }),
        usage: { source: "host", inputTokens: 10, outputTokens: 5, costUsd: null },
        durationMs: 100, terminationConfirmed: true,
      },
      grade: { verdict: passed ? "pass" : "fail", assertions: [{ kind: "equals", passed }] },
    })),
  };
  if (options.incomplete) record.trials.pop();
  const directory = join(root, name);
  const store = new BenchmarkStore(directory);
  try {
    store.create({ ...record, status: "running", trials: [] });
    for (const trial of record.trials) store.recordTrial(record.id, trial);
    store.finish(record);
  } finally { store.close(); }
  await writeFile(join(directory, "plan.json"), "{\"fixture\":true}\n");
  await mkdir(join(directory, "snapshot"));
  await writeFile(join(directory, "snapshot", "role.yaml"), "name: fixture\n");
  return directory;
}

describe("benchmark baseline and comparison CLI", () => {
  it("captures independent baselines, lists names and retains revisions after their source runs are deleted", async () => {
    const first = await savedRun("baseline", { passes: [false, true] });
    const second = await savedRun("candidate");
    const set = await cli("baseline", "set", "stable", first);
    expect(set.code, set.stderr).toBe(0);
    const captured = JSON.parse(set.stdout) as BenchmarkBaselineInfo & { summary: { successRate: number } };
    expect(captured).toMatchObject({ name: "stable", revision: 1, runId: "baseline", summary: { successRate: 0.5 } });
    expect(captured.recordDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(set.stdout).not.toContain("offline fixture output");
    await rm(first, { recursive: true });
    const show = await cli("baseline", "show", "stable");
    expect(show.code, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout)).toEqual(captured);
    const comparison = await cli("compare", second, "--baseline", "stable");
    expect(comparison.code, comparison.stderr).toBe(0);
    expect(JSON.parse(comparison.stdout)).toMatchObject({ mode: "historical", successRateDelta: 0.5, baseline: { runId: "baseline" } });

    const moved = await cli("baseline", "set", "stable", second);
    expect(moved.code, moved.stderr).toBe(0);
    expect(JSON.parse(moved.stdout)).toMatchObject({ name: "stable", revision: 2, runId: "candidate" });
    const history = await cli("baseline", "history", "stable");
    expect(history.code, history.stderr).toBe(0);
    expect((JSON.parse(history.stdout) as BenchmarkBaselineInfo[]).map(({ revision, runId }) => ({ revision, runId })))
      .toEqual([{ revision: 1, runId: "baseline" }, { revision: 2, runId: "candidate" }]);
    const list = await cli("baseline", "list");
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ name: "stable", revision: 2, runId: "candidate" })]);
  });

  it("compares saved directories in both directions without treating a regression as a CI failure", async () => {
    const baseline = await savedRun("baseline", { passes: [false, true] });
    const candidate = await savedRun("candidate");
    const forward = await cli("compare", candidate, "--against", baseline);
    expect(forward.code, forward.stderr).toBe(0);
    expect(JSON.parse(forward.stdout)).toMatchObject({ comparable: true, complete: true, successRateDelta: 0.5,
      cases: [{ caseId: "case", successRateDelta: 0.5, change: "improved" }] });
    const reverse = await cli("compare", baseline, "--against", candidate);
    expect(reverse.code, reverse.stderr).toBe(0);
    expect(JSON.parse(reverse.stdout)).toMatchObject({ successRateDelta: -0.5, cases: [{ change: "regressed" }] });
  });

  it("requires exactly one baseline selector and rejects invalid or missing baseline names", async () => {
    const candidate = await savedRun("candidate");
    for (const args of [["compare", candidate], ["compare", candidate, "--baseline", "stable", "--against", candidate]]) {
      const result = await cli(...args);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Specify exactly one of --baseline or --against");
    }
    const invalid = await cli("baseline", "set", "../outside", candidate);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("Invalid benchmark baseline name");
    const missing = await cli("compare", candidate, "--baseline", "missing");
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("Benchmark baseline was not found");
    for (const command of ["run", "watch"]) {
      const empty = await cli(command, join(root, "suite"), "--baseline", "");
      expect(empty.code).not.toBe(0);
      expect(empty.stderr).toContain("Invalid benchmark baseline name");
    }
  });

  it("withholds deltas and exits 2 for incomplete or incompatible observations", async () => {
    const baseline = await savedRun("baseline");
    for (const [name, options, comparable, complete] of [
      ["partial", { incomplete: true }, true, false],
      ["changed-suite", { suiteDigest: "f".repeat(64) }, false, true],
      ["legacy", { missingRuntime: true }, false, true],
    ] as const) {
      const candidate = await savedRun(name, options);
      const result = await cli("compare", candidate, "--against", baseline);
      expect(result.code, result.stderr).toBe(2);
      const comparison = JSON.parse(result.stdout) as BenchmarkComparison;
      expect(comparison).toMatchObject({ comparable, complete, successRateDelta: null });
      expect(comparison.cases.every(item => item.successRateDelta === null)).toBe(true);
    }
    const rejected = await cli("baseline", "set", "partial", join(root, "partial"));
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("complete scored run");
  });

  it("exports escaped offline HTML and equivalent JSON without changing saved evidence", async () => {
    const caseId = "<img src=x onerror=alert(1)>";
    const baseline = await savedRun("baseline", { caseId, passes: [false, false] });
    const candidate = await savedRun("candidate", { caseId });
    const html = await cli("compare", candidate, "--against", baseline, "--format", "html");
    expect(html.code, html.stderr).toBe(0);
    expect(html.stdout).toContain("<!doctype html>");
    expect(html.stdout).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html.stdout).not.toContain(caseId);
    const output = join(candidate, "comparison.json");
    const exported = await cli("compare", candidate, "--against", baseline, "--output", output);
    expect(exported.code, exported.stderr).toBe(0);
    expect(exported.stdout).toContain("Comparison:");
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ successRateDelta: 1, candidate: { runId: "candidate" } });
    expect(readBenchmarkRun(baseline).trials.map(trial => trial.grade.verdict)).toEqual(["fail", "fail"]);
    expect(readBenchmarkRun(candidate).trials.map(trial => trial.grade.verdict)).toEqual(["pass", "pass"]);
  });

  it("protects both run directories and the baseline catalog from comparison exports", async () => {
    const baseline = await savedRun("baseline");
    const candidate = await savedRun("candidate");
    const set = await cli("baseline", "set", "stable", baseline);
    expect(set.code, set.stderr).toBe(0);
    const catalog = join(env.ROLEBOX_DATA_DIR!, "benchmarks", "baselines");
    const protectedPaths = [join(baseline, "run.json"), join(baseline, "snapshot", "role.yaml"),
      join(candidate, "benchmark.sqlite"), join(candidate, "plan.json"), join(catalog, "baselines.sqlite")];
    for (const output of protectedPaths) {
      const before = await readFile(output);
      const result = await cli("compare", candidate, "--against", baseline, "--output", output);
      expect(result.code).not.toBe(0);
      expect(await readFile(output)).toEqual(before);
    }
    const insideCatalog = await cli("compare", candidate, "--baseline", "stable", "--output", join(catalog, "new-report.json"));
    expect(insideCatalog.code).not.toBe(0);
    const show = await cli("baseline", "show", "stable");
    expect(show.code, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({ revision: 1, runId: "baseline" });
  });
});

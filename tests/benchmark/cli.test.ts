import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";
import { doctorDshRuntime, resolveDshRuntime } from "../../src/benchmark/hosts/dsh.ts";
import type { BenchmarkComparison } from "../../src/benchmark/compare.ts";
import type { BenchmarkRunSummary } from "../../src/benchmark/report.ts";
import type { BenchmarkRunRecord, BenchmarkSuite } from "../../src/benchmark/types.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const entry = process.env.ROLEBOX_BENCH_TEST_ENTRY ? resolve(process.env.ROLEBOX_BENCH_TEST_ENTRY) : join(repository, "src", "cli", "main.ts");
const provider = fileURLToPath(new URL("./fixtures/scripted-dsh-provider.mjs", import.meta.url));
const packageVersion = (JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { version: string }).version;
const available = doctorDshRuntime().available;
let root: string;
let suiteDirectory: string;
let env: Record<string, string>;
let cacheContents: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-cli-"));
  suiteDirectory = join(root, "fixture-benchmark");
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

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, entry, "bench", ...args], {
    cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error("Benchmark CLI fixture exceeded its deadline.");
    return { code, stdout, stderr };
  } finally { clearTimeout(deadline); clearTimeout(forced); }
}

function jsonOutput<T = Record<string, unknown>>(output: string): T {
  return JSON.parse(output.slice(output.indexOf("{")));
}

async function initialize(): Promise<void> {
  const initialized = await cli("init", suiteDirectory);
  expect(initialized.code, initialized.stderr).toBe(0);
  expect(initialized.stdout).toContain("Created benchmark:");
}

async function configure(options: { expected?: string; repetitions?: number; missingPlugin?: boolean } = {}): Promise<void> {
  const suite = load(await readFile(join(suiteDirectory, "suite.yaml"), "utf8")) as BenchmarkSuite;
  suite.target.provider = "example-provider";
  suite.target.model = "scripted";
  suite.host.plugins = options.missingPlugin ? [{ module: "benchmark-fixture-missing-plugin", config: {} }] : [{
    module: provider, config: { runtimeAnchor: resolveDshRuntime().anchor, mode: "success" },
  }];
  suite.run = { timeoutMs: 5_000, repetitions: options.repetitions ?? 1, concurrency: 1 };
  await writeFile(join(suiteDirectory, "suite.yaml"), dump(suite));
  await writeFile(join(suiteDirectory, "cases.jsonl"), `${JSON.stringify({
    id: "fixture-case", prompt: "Complete the offline fixture task.",
    assertions: [{ kind: "equals", value: options.expected ?? "fixture complete" }],
  })}\n`);
}

async function persistedRun(stdout: string): Promise<{ directory: string; run: BenchmarkRunRecord; summary: BenchmarkRunSummary }> {
  const summary = jsonOutput<BenchmarkRunSummary & { directory: string }>(stdout);
  expect(typeof summary.directory).toBe("string");
  expect(dirname(summary.directory)).toBe(join(await realpath(env.ROLEBOX_DATA_DIR!), "benchmarks"));
  const run = JSON.parse(await readFile(join(summary.directory, "run.json"), "utf8")) as BenchmarkRunRecord;
  return { directory: summary.directory, run, summary };
}

async function capture(stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
  } finally { reader.releaseLock(); }
}

describe("benchmark CLI scaffolding", () => {
  it("creates and validates a suite without loading a provider", async () => {
    await initialize();
    expect((await readdir(suiteDirectory)).sort()).toEqual(["README.md", "cases.jsonl", "role", "suite.yaml"]);
    const validation = await cli("validate", suiteDirectory);
    expect(validation.code, validation.stderr).toBe(0);
    expect(jsonOutput(validation.stdout)).toMatchObject({ valid: true, cases: 3, trials: 3 });
    expect(await readFile(join(env.ROLEBOX_DATA_DIR!, "cache", "version-check.json"), "utf8")).toBe(cacheContents);
  });
});

describe.skipIf(!available || process.platform === "win32")("benchmark CLI with a real dsh host and offline provider", () => {
  it("evaluates native file edits against frozen checks and compares the repaired role with its failing baseline", async () => {
    const initialized = await cli("init", suiteDirectory, "--template", "code-fix");
    expect(initialized.code, initialized.stderr).toBe(0);
    const suitePath = join(suiteDirectory, "suite.yaml");
    const suite = load(await readFile(suitePath, "utf8")) as BenchmarkSuite;
    suite.target.provider = "example-provider";
    suite.target.model = "scripted";
    suite.host.plugins = [{ module: provider, config: { runtimeAnchor: resolveDshRuntime().anchor, mode: "workspace" } }];
    suite.run.timeoutMs = 5_000;
    await writeFile(suitePath, dump(suite));
    const fixturePath = join(suiteDirectory, "fixtures", "sum", "src", "sum.mjs");
    const original = await readFile(fixturePath, "utf8");
    const validation = await cli("validate", suiteDirectory);
    expect(validation.code, validation.stderr).toBe(0);
    const doctor = await cli("doctor", suiteDirectory);
    expect(doctor.code, doctor.stderr).toBe(0);
    const before = await cli("run", suiteDirectory);
    const baseline = await persistedRun(before.stdout);
    expect(before.code, JSON.stringify(baseline.run.trials)).toBe(1);
    expect(baseline.run.trials[0]!.grade.assertions[1]!.command).toMatchObject({ status: "completed", exitCode: 1, terminationConfirmed: true });
    expect(baseline.run.trials[0]!.workspace?.changes).toEqual([]);
    const saved = await cli("baseline", "set", "code-fix", baseline.directory);
    expect(saved.code, saved.stderr).toBe(0);
    const rolePath = join(suiteDirectory, "role", "role.yaml");
    const role = load(await readFile(rolePath, "utf8")) as Record<string, unknown>;
    role.prompt = "APPLY_WORKSPACE_FIX: Read the source, then edit the actual file to fix the empty-array bug.";
    await writeFile(rolePath, dump(role));
    const after = await cli("run", suiteDirectory, "--baseline", "code-fix");
    const candidate = await persistedRun(after.stdout);
    expect(after.code, JSON.stringify(candidate.run.trials)).toBe(0);
    expect(jsonOutput(after.stdout)).toMatchObject({ comparison: { comparable: true, complete: true, successRateDelta: 1 } });
    const trial = candidate.run.trials[0]!;
    expect(trial.grade.assertions[1]!.command?.stdout).toContain("All sum checks passed");
    expect(trial.workspace?.changes).toEqual([expect.objectContaining({ path: "src/sum.mjs", kind: "modified", beforeText: original,
      afterText: original.replace("total + value);", "total + value, 0);") })]);
    expect(await readFile(join(candidate.directory, trial.workspace!.artifactDirectory, "src", "sum.mjs"), "utf8"))
      .toBe(original.replace("total + value);", "total + value, 0);"));
    expect(await readFile(fixturePath, "utf8")).toBe(original);
    expect(await readFile(join(candidate.directory, "fixtures", "000000", "workspace", "src", "sum.mjs"), "utf8")).toBe(original);
    const report = await cli("report", candidate.directory);
    expect(report.code, report.stderr).toBe(0);
    const html = await readFile(join(candidate.directory, "report.html"), "utf8");
    expect(html).toContain("Workspace changes");
    expect(html).toContain("All sum checks passed");
    expect(await readdir(env.TMPDIR!)).toEqual([]);
  }, 45_000);

  it("runs init, validate, doctor, run and report with durable evidence in private storage", async () => {
    await initialize();
    await configure({ repetitions: 2 });
    const validated = await cli("validate", suiteDirectory);
    expect(validated.code, validated.stderr).toBe(0);
    const validation = jsonOutput<{ roleDigest: string }>(validated.stdout);
    expect(validation).toMatchObject({ valid: true, cases: 1, trials: 2 });
    const doctor = await cli("doctor", suiteDirectory);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(jsonOutput(doctor.stdout)).toMatchObject({ available: true, pluginsConfigured: true, liveExecutionVerified: false });

    const executed = await cli("run", suiteDirectory);
    const { directory, run, summary } = await persistedRun(executed.stdout);
    expect(executed.code, run.trials.map(trial => trial.result.diagnostic).join("; ")).toBe(0);
    expect(executed.stdout).toContain("fixture-case #1: completed / pass");
    expect(executed.stdout).toContain("fixture-case #2: completed / pass");
    expect(run.status).toBe("completed");
    expect(run.trials).toHaveLength(2);
    expect(run.roleDigest).toBe(validation.roleDigest);
    expect(summary).toMatchObject({ plannedTrials: 2, recordedTrials: 2, passedTrials: 2, failedTrials: 0, coverage: 1, successRate: 1 });
    for (const trial of run.trials) {
      expect(trial.result.output).toBe("fixture complete");
      expect(trial.result.activation).toMatchObject({ roleId: "role", provider: "example-provider", model: "scripted" });
      expect(trial.result.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: null, source: "host" });
      expect(trial.result.terminationConfirmed).toBe(true);
    }
    expect(await readFile(join(directory, "snapshot", "role", "role.yaml"), "utf8"))
      .toBe(await readFile(join(suiteDirectory, "role", "role.yaml"), "utf8"));
    const plan = JSON.parse(await readFile(join(directory, "plan.json"), "utf8"));
    expect(plan).toMatchObject({ suiteDigest: run.suiteDigest, roleDigest: run.roleDigest,
      target: { host: "dsh", roleId: "role", provider: "example-provider", model: "scripted" },
      run: { repetitions: 2, concurrency: 1, timeoutMs: 5_000 } });
    expect(plan.cases[0].assertions).toEqual([{ kind: "equals", value: "fixture complete" }]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const db = new Database(join(directory, "benchmark.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM trials").get()).toEqual({ count: 2 });
      expect(db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
    } finally { db.close(); }

    const html = await cli("report", directory);
    expect(html.code, html.stderr).toBe(0);
    const report = await readFile(join(directory, "report.html"), "utf8");
    expect(report).toContain("<!doctype html>");
    expect(report).toContain("fixture complete");
    expect(report).toContain("100.0%");
    expect(report).toContain(run.roleDigest);
    const json = await cli("report", directory, "--format", "json");
    expect(json.code, json.stderr).toBe(0);
    const saved = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    expect(saved.run).toEqual(run);
    expect(saved.summary).toMatchObject({ passedTrials: 2, successRate: 1, coverage: 1 });
    expect(await readFile(join(env.ROLEBOX_DATA_DIR!, "cache", "version-check.json"), "utf8")).toBe(cacheContents);
  }, 45_000);

  it("exits 1 for scored assertion failures while retaining a complete run", async () => {
    await initialize();
    await configure({ expected: "a deliberately different answer" });
    const executed = await cli("run", suiteDirectory);
    const { run, summary } = await persistedRun(executed.stdout);
    expect(executed.code, run.trials.map(trial => trial.result.diagnostic).join("; ")).toBe(1);
    expect(run.status).toBe("completed");
    expect(run.trials[0]?.result.status).toBe("completed");
    expect(run.trials[0]?.grade.verdict).toBe("fail");
    expect(summary).toMatchObject({ failedTrials: 1, successRate: 0, coverage: 1 });
  }, 30_000);

  it("exits 2 for an unavailable configured plugin and records an unscored trial", async () => {
    await initialize();
    await configure({ missingPlugin: true });
    const executed = await cli("run", suiteDirectory);
    expect(executed.code, executed.stderr).toBe(2);
    const { run, summary } = await persistedRun(executed.stdout);
    expect(run.status).toBe("incomplete");
    expect(run.trials[0]?.result.status).toBe("infra_error");
    expect(run.trials[0]?.grade.verdict).toBe("unscored");
    expect(summary).toMatchObject({ unscoredTrials: 1, coverage: 0, successRate: null });
  }, 30_000);

  it("rejects an unconfigured provider before creating a run", async () => {
    await initialize();
    const doctor = await cli("doctor", suiteDirectory);
    expect(doctor.code, doctor.stderr).toBe(2);
    expect(jsonOutput(doctor.stdout)).toMatchObject({ available: true, pluginsConfigured: false });
    const executed = await cli("run", suiteDirectory);
    expect(executed.code).toBe(1);
    expect(executed.stderr).toContain("Configure host.plugins");
    expect(await readdir(env.ROLEBOX_DATA_DIR!)).toEqual(["cache"]);
  }, 30_000);

  it("watches saved role revisions with a pinned baseline, writes distinct evidence and drains on SIGINT", async () => {
    await initialize();
    await configure();
    const initial = await cli("run", suiteDirectory);
    expect(initial.code, initial.stderr).toBe(0);
    const initialRun = await persistedRun(initial.stdout);
    const captured = await cli("baseline", "set", "main", initialRun.directory);
    expect(captured.code, captured.stderr).toBe(0);
    expect(jsonOutput(captured.stdout)).toMatchObject({ name: "main", revision: 1, runId: initialRun.run.id });
    const outputDirectory = join(root, "watch-results");
    const rolePath = join(suiteDirectory, "role", "role.yaml");
    const firstSource = await readFile(rolePath, "utf8");
    const child = Bun.spawn([process.execPath, entry, "bench", "watch", suiteDirectory, "--output", outputDirectory, "--baseline", "main"], {
      cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const output = capture(child.stdout, text => { stdout += text; });
    const errors = capture(child.stderr, text => { stderr += text; });
    function currentResults(): Array<{ directory: string; current: boolean; baseline: { name: string; revision: number }; comparison: BenchmarkComparison }> {
      return [...stdout.matchAll(/^\{\n[\s\S]*?^\}/gm)].map(match => JSON.parse(match[0]))
        .filter(result => result.current === true);
    }
    async function waitForCurrentRuns(count: number): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (currentResults().length < count) {
        if (child.exitCode !== null) throw new Error(`Watch exited before the expected run: ${stderr}`);
        if (Date.now() >= deadline) throw new Error(`Watch did not publish the expected revision: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      await waitForCurrentRuns(1);
      expect(stdout).toContain("Watching benchmark inputs");
      const firstWatch = currentResults()[0]!;
      const moved = await cli("baseline", "set", "main", firstWatch.directory);
      expect(moved.code, moved.stderr).toBe(0);
      expect(jsonOutput(moved.stdout)).toMatchObject({ name: "main", revision: 2, runId: firstWatch.comparison.candidate.runId });
      const role = load(firstSource) as Record<string, unknown>;
      role.prompt = "Complete the offline task using the second saved role revision.";
      const secondSource = dump(role);
      await writeFile(rolePath, secondSource);
      await waitForCurrentRuns(2);
      child.kill("SIGINT");
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        stopTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        expect(await child.exited).toBe(130);
      } finally { clearTimeout(stopTimer); }
      await Promise.all([output, errors]);
      const results = currentResults();
      const directories = results.map(result => result.directory);
      expect(directories).toHaveLength(2);
      const runs = await Promise.all(directories.map(async directory =>
        JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as BenchmarkRunRecord));
      expect(runs.every(run => run.status === "completed" && run.trials[0]?.grade.verdict === "pass")).toBe(true);
      expect(runs[0]!.suiteDigest).toBe(runs[1]!.suiteDigest);
      expect(runs[0]!.roleDigest).not.toBe(runs[1]!.roleDigest);
      expect(runs[0]!.trials[0]!.result.activation!.promptDigest).not.toBe(runs[1]!.trials[0]!.result.activation!.promptDigest);
      for (const [index, result] of results.entries()) {
        expect(result.baseline).toEqual({ name: "main", revision: 1 });
        expect(result.comparison).toMatchObject({ mode: "historical", comparable: true, complete: true, successRateDelta: 0,
          baseline: { runId: initialRun.run.id }, candidate: { runId: runs[index]!.id } });
      }
      expect(await readFile(join(directories[0]!, "snapshot", "role", "role.yaml"), "utf8")).toBe(firstSource);
      expect(await readFile(join(directories[1]!, "snapshot", "role", "role.yaml"), "utf8")).toBe(secondSource);
      const compared = await cli("run", suiteDirectory, "--baseline", "main");
      expect(compared.code, compared.stderr).toBe(0);
      const comparedRun = await persistedRun(compared.stdout);
      expect(comparedRun.run.trials[0]?.result.activation).toEqual(runs[1]!.trials[0]!.result.activation);
      expect(jsonOutput(compared.stdout)).toMatchObject({ baseline: { name: "main", revision: 2 },
        comparison: { mode: "historical", comparable: true, complete: true, successRateDelta: 0,
          baseline: { runId: runs[0]!.id }, candidate: { runId: comparedRun.run.id } } });
      expect(await readdir(env.TMPDIR!)).toEqual([]);
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null) child.kill("SIGINT");
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000);
      try { await child.exited; await Promise.all([output, errors]); }
      finally { clearTimeout(timer); }
    }
  }, 40_000);
});

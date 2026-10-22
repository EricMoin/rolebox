import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldBenchmark } from "../../src/benchmark/scaffold.ts";
import { snapshotBenchmarkRole } from "../../src/benchmark/snapshot.ts";
import { loadBenchmarkSuite } from "../../src/benchmark/spec.ts";
import { BenchmarkBaselineStore } from "../../src/benchmark/baseline.ts";
import { watchBenchmark, type BenchmarkWatchOptions, type BenchmarkWatchResult } from "../../src/benchmark/watch.ts";
import type { BenchmarkRunRecord, LoadedBenchmarkSuite } from "../../src/benchmark/types.ts";

const roots: string[] = [];
const controllers: AbortController[] = [];
const watches: Promise<void>[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(watches.splice(0));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Watch observation timed out");
    await sleep(5);
  }
}

async function fixture(template: "response" | "code-fix" = "response") {
  const root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-watch-"));
  roots.push(root);
  const directory = await scaffoldBenchmark(join(root, "suite"), template);
  const controller = new AbortController();
  controllers.push(controller);
  return { root, directory, role: join(directory, "role", "role.yaml"), outputDirectory: join(root, "results"), controller };
}

async function resultFor(loaded: LoadedBenchmarkSuite, index: number): Promise<{ record: BenchmarkRunRecord; directory: string }> {
  const snapshot = await snapshotBenchmarkRole(loaded.roleDirectory);
  return {
    directory: `run-${index}`,
    record: {
      schemaVersion: 1, id: `run-${index}`, suiteId: loaded.suite.id, suiteDigest: loaded.digest, roleDigest: snapshot.digest,
      startedAt: "2026-10-22T00:00:00.000Z", completedAt: "2026-10-22T00:00:01.000Z", status: "completed", isolation: "trusted-process",
      plannedTrials: loaded.cases.length, caseIds: loaded.cases.map(item => item.id), repetitions: 1,
      trials: loaded.cases.map((item, index) => ({
        id: String(index), caseId: item.id, repetition: 0,
        grade: { verdict: "pass", assertions: [{ kind: "equals", passed: true }] },
        result: { protocolVersion: 1, status: "completed", output: "READY", terminationConfirmed: true, durationMs: 1,
          runtime: { dshVersion: "1.0.0", roleboxVersion: "1.0.0" },
          usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" },
          activation: { roleId: snapshot.roleId, provider: loaded.suite.target.provider, model: loaded.suite.target.model, promptDigest: "a".repeat(64) } },
      })),
    },
  };
}

function start(directory: string, options: BenchmarkWatchOptions): Promise<void> {
  const watching = watchBenchmark(directory, { pollIntervalMs: 10, debounceMs: 30, ...options });
  watches.push(watching);
  void watching.catch(() => undefined);
  return watching;
}

describe("benchmark watch", () => {
  it("reruns fixture and check revisions and refuses deltas against their previous conditions", async () => {
    const target = await fixture("code-fix");
    const baseline = (await resultFor(await loadBenchmarkSuite(target.directory), 0)).record;
    const completed: BenchmarkWatchResult[] = [];
    let calls = 0;
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      baseline, run: async loaded => resultFor(loaded, ++calls), onRun: result => completed.push(result) });
    await until(() => completed.length === 1);
    expect(completed[0]!.comparison?.successRateDelta).toBe(0);
    await appendFile(join(target.directory, "fixtures", "sum", "src", "sum.mjs"), "\n// Revised fixture\n");
    await until(() => completed.length === 2);
    await appendFile(join(target.directory, "checks", "sum", "check.mjs"), "\n// Revised checks\n");
    await until(() => completed.length === 3);
    expect(new Set(completed.map(result => result.record.suiteDigest)).size).toBe(3);
    for (const result of completed.slice(1)) {
      expect(result.current).toBe(true);
      expect(result.comparison?.compatibility.status).toBe("incompatible");
      expect(result.comparison?.successRateDelta).toBeNull();
    }
  });
  it("runs initially and does not rerun unchanged content or formatting-only suite saves", async () => {
    const target = await fixture();
    const completed: BenchmarkWatchResult[] = [];
    let calls = 0;
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      run: async loaded => resultFor(loaded, ++calls), onRun: value => completed.push(value) });
    await until(() => completed.length === 1);
    expect(completed[0]!.current).toBe(true);
    await writeFile(target.role, await readFile(target.role, "utf8"));
    await appendFile(join(target.directory, "suite.yaml"), "\n# Formatting-only save\n");
    await sleep(100);
    expect(calls).toBe(1);
  });

  it("debounces saves, cancels a superseded revision and waits for its cleanup", async () => {
    const target = await fixture();
    const baseline = (await resultFor(await loadBenchmarkSuite(target.directory), 0)).record;
    const completed: BenchmarkWatchResult[] = [];
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let cancelled = false;
    let cleanupFinished = false;
    let captured = false;
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    releases.push(() => release());
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal, baseline,
      run: async (loaded, options) => {
        const index = ++calls;
        active++;
        maximumActive = Math.max(maximumActive, active);
        const result = await resultFor(loaded, index);
        if (index === 1) {
          captured = true;
          await new Promise<void>(resolve => {
            const abort = (): void => { cancelled = true; resolve(); };
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) abort();
          });
          await cleanup;
          cleanupFinished = true;
        } else expect(cleanupFinished).toBe(true);
        active--;
        return result;
      }, onRun: value => completed.push(value) });
    await until(() => captured);
    await appendFile(target.role, "\n# Revision two\n");
    await until(() => cancelled);
    await appendFile(target.role, "\n# Revision three\n");
    await sleep(80);
    expect(calls).toBe(1);
    release();
    await until(() => completed.length === 2);
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
    expect(completed.map(value => value.current)).toEqual([false, true]);
    expect(completed[0]!.comparison).toBeUndefined();
    expect(completed[1]!.comparison?.successRateDelta).toBe(0);
    expect(completed[0]!.record.roleDigest).not.toBe(completed[1]!.record.roleDigest);
  });

  it("pins the captured baseline across caller mutations and explicit name updates", async () => {
    const target = await fixture();
    const catalog = new BenchmarkBaselineStore(join(target.root, "baselines"));
    try {
      const original = (await resultFor(await loadBenchmarkSuite(target.directory), 0)).record;
      catalog.set("main", original);
      const pinned = catalog.get("main");
      const completed: BenchmarkWatchResult[] = [];
      let calls = 0;
      start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
        baseline: pinned.record, run: async loaded => resultFor(loaded, ++calls), onRun: value => completed.push(value) });
      await until(() => completed.length === 1);
      pinned.record.id = "mutated-caller";
      const replacement = structuredClone(original);
      replacement.id = "new-baseline";
      catalog.set("main", replacement);
      await appendFile(target.role, "\n# New role version\n");
      await until(() => completed.length === 2);
      expect(catalog.get("main").record.id).toBe("new-baseline");
      expect(completed.map(result => result.comparison?.baseline.runId)).toEqual(["run-0", "run-0"]);
      expect(completed.map(result => result.comparison?.baseline.recordDigest)).toEqual([pinned.recordDigest, pinned.recordDigest]);
      expect(completed[1]!.comparison?.successRateDelta).toBe(0);
    } finally { catalog.close(); }
  });

  it("pauses for invalid configuration and resumes after a valid save", async () => {
    const target = await fixture();
    const config = join(target.directory, "suite.yaml");
    const valid = await readFile(config, "utf8");
    await writeFile(config, "schemaVersion: [\n");
    const diagnostics: string[] = [];
    let calls = 0;
    const completed: BenchmarkWatchResult[] = [];
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      onDiagnostic: message => diagnostics.push(message), run: async loaded => resultFor(loaded, ++calls), onRun: value => completed.push(value) });
    await until(() => diagnostics.length === 1);
    await sleep(50);
    expect(calls).toBe(0);
    expect(diagnostics).toHaveLength(1);
    await writeFile(config, valid);
    await until(() => completed.length === 1);
    expect(completed[0]!.current).toBe(true);
  });

  it("cancels an active revision when a save is invalid and reruns the repaired revision", async () => {
    const target = await fixture();
    const config = join(target.directory, "suite.yaml");
    const valid = await readFile(config, "utf8");
    const completed: BenchmarkWatchResult[] = [];
    let calls = 0;
    let cancelled = false;
    let captured = false;
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      run: async (loaded, options) => {
        const index = ++calls;
        const result = await resultFor(loaded, index);
        if (index === 1) {
          captured = true;
          await new Promise<void>(resolve => {
            const abort = (): void => { cancelled = true; resolve(); };
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) abort();
          });
        }
        return result;
      }, onRun: value => completed.push(value) });
    await until(() => captured);
    await writeFile(config, "schemaVersion: [\n");
    await until(() => cancelled && completed.length === 1);
    expect(completed[0]!.current).toBe(false);
    await writeFile(config, valid);
    await until(() => completed.length === 2);
    expect(completed[1]!.current).toBe(true);
  });

  it("awaits cleanup on shutdown and never starts another revision", async () => {
    const target = await fixture();
    let started = false;
    let stopped = false;
    let settled = false;
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    releases.push(() => release());
    const completed: BenchmarkWatchResult[] = [];
    const watching = start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      run: async (loaded, options) => {
        const result = await resultFor(loaded, 1);
        started = true;
        await new Promise<void>(resolve => { options.signal?.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }); });
        await cleanup;
        return result;
      }, onRun: value => completed.push(value) });
    void watching.then(() => { settled = true; });
    await until(() => started);
    target.controller.abort();
    await until(() => stopped);
    await sleep(40);
    expect(settled).toBe(false);
    release();
    await watching;
    expect(completed.map(value => value.current)).toEqual([false]);
  });

  it("allows a new revision after a returned infrastructure result, without retrying unchanged input", async () => {
    const target = await fixture();
    let calls = 0;
    const completed: BenchmarkWatchResult[] = [];
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      run: async loaded => {
        const result = await resultFor(loaded, ++calls);
        if (calls === 1) {
          result.record.status = "incomplete";
          for (const trial of result.record.trials) {
            trial.result.status = "infra_error";
            trial.grade = { verdict: "unscored", assertions: [] };
          }
        }
        return result;
      }, onRun: value => completed.push(value) });
    await until(() => completed.length === 1);
    await sleep(60);
    expect(calls).toBe(1);
    await appendFile(target.role, "\n# Revised role\n");
    await until(() => completed.length === 2);
    expect(completed[1]!.current).toBe(true);
  });

  it("waits for a burst of saves to stabilize before launching its next revision", async () => {
    const target = await fixture();
    let calls = 0;
    const completed: BenchmarkWatchResult[] = [];
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal, debounceMs: 100,
      run: async loaded => resultFor(loaded, ++calls), onRun: value => completed.push(value) });
    await until(() => completed.length === 1);
    await appendFile(target.role, "\n# Save one\n");
    await sleep(30);
    await appendFile(target.role, "\n# Save two\n");
    await sleep(60);
    expect(calls).toBe(1);
    await until(() => completed.length === 2);
    await sleep(100);
    expect(calls).toBe(2);
    expect(completed[1]!.current).toBe(true);
  });

  it("marks a probe-to-run snapshot mismatch stale and evaluates the stable revision again", async () => {
    const target = await fixture();
    let calls = 0;
    const completed: BenchmarkWatchResult[] = [];
    start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      run: async loaded => {
        const result = await resultFor(loaded, ++calls);
        if (calls === 1) result.record.roleDigest = "0".repeat(64);
        return result;
      }, onRun: value => completed.push(value) });
    await until(() => completed.length === 2);
    expect(completed.map(value => value.current)).toEqual([false, true]);
    expect(calls).toBe(2);
  });

  it("stops after unconfirmed termination or a thrown run rather than overlapping unknown workers", async () => {
    for (const mode of ["unconfirmed", "grader", "throws"] as const) {
      const target = await fixture();
      let calls = 0;
      const watching = start(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
        run: async loaded => {
          calls++;
          if (mode === "throws") throw new Error("private diagnostic");
          const result = await resultFor(loaded, calls);
          if (mode === "grader") result.record.trials[0]!.grade = { verdict: "unscored", assertions: [], error: "Grader cleanup unknown", terminationConfirmed: false };
          else result.record.trials[0]!.result.terminationConfirmed = false;
          return result;
        } });
      await expect(watching).rejects.toThrow(mode === "throws" ? "cleanup could not be verified" : "termination could not be confirmed");
      expect(calls).toBe(1);
    }
  });

  it("rejects a result location inside the watched role even through a symlink", async () => {
    const target = await fixture();
    const link = join(target.root, "role-link");
    await symlink(join(target.directory, "role"), link);
    const diagnostics: string[] = [];
    let calls = 0;
    start(target.directory, { outputDirectory: join(link, "results"), signal: target.controller.signal,
      run: async loaded => resultFor(loaded, ++calls), onDiagnostic: message => diagnostics.push(message) });
    await until(() => diagnostics.length > 0);
    expect(diagnostics[0]).toContain("outside the target role");
    expect(calls).toBe(0);
  });

  it("does no work when already aborted and validates timing options", async () => {
    const target = await fixture();
    target.controller.abort();
    let called = false;
    await watchBenchmark(target.directory, { outputDirectory: target.outputDirectory, signal: target.controller.signal,
      run: async loaded => { called = true; return resultFor(loaded, 1); } });
    expect(called).toBe(false);
    await expect(watchBenchmark(target.directory, { outputDirectory: target.outputDirectory, pollIntervalMs: Number.NaN })).rejects.toThrow("intervals");
  });
});

import { assertBenchmarkOutputDirectory, runBenchmark } from "./runner.ts";
import { snapshotBenchmarkRole } from "./snapshot.ts";
import { BenchmarkSpecError, loadBenchmarkSuite } from "./spec.ts";
import { compareBenchmarkRuns, type BenchmarkComparison } from "./compare.ts";
import { parseBenchmarkRunRecord } from "./report.ts";
import type { BenchmarkRunRecord, BenchmarkTrial, LoadedBenchmarkSuite } from "./types.ts";

export interface BenchmarkWatchResult {
  record: BenchmarkRunRecord;
  directory: string;
  current: boolean;
  comparison?: BenchmarkComparison;
}

export interface BenchmarkWatchOptions {
  outputDirectory: string;
  signal?: AbortSignal;
  baseline?: BenchmarkRunRecord;
  onTrial?: (trial: BenchmarkTrial) => void;
  onRun?: (result: BenchmarkWatchResult) => void;
  onDiagnostic?: (message: string) => void;
  pollIntervalMs?: number;
  debounceMs?: number;
  run?: typeof runBenchmark;
}

interface Revision {
  loaded: LoadedBenchmarkSuite;
  roleDigest: string;
  fingerprint: string;
}

interface ActiveRun {
  revision: Revision;
  controller: AbortController;
  stale: boolean;
  done: Promise<void>;
  outcome?: { kind: "result"; value: Awaited<ReturnType<typeof runBenchmark>> } | { kind: "error" };
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

async function probe(path: string, outputDirectory: string): Promise<Revision> {
  const loaded = await loadBenchmarkSuite(path);
  await assertBenchmarkOutputDirectory(loaded.roleDirectory, outputDirectory);
  const snapshot = await snapshotBenchmarkRole(loaded.roleDirectory);
  return { loaded, roleDigest: snapshot.digest, fingerprint: `${loaded.digest}:${snapshot.digest}:${snapshot.roleId}` };
}

function invalidDiagnostic(error: unknown): string {
  if (error instanceof BenchmarkSpecError) return `${error.message}; waiting for a valid save.`;
  if (error instanceof Error && error.message === "Benchmark results must be stored outside the target role directory") {
    return `${error.message}; waiting for a valid target.`;
  }
  return "Benchmark role snapshot or output location is invalid; waiting for a valid save.";
}

export async function watchBenchmark(path: string, options: BenchmarkWatchOptions): Promise<void> {
  const baseline = options.baseline ? parseBenchmarkRunRecord(structuredClone(options.baseline)) : undefined;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const debounceMs = options.debounceMs ?? 300;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000
    || !Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000) {
    throw new Error("Benchmark watch intervals must be finite milliseconds within 1–60000 for polling and 0–60000 for debounce");
  }
  const execute = options.run ?? runBenchmark;
  let active: ActiveRun | undefined;
  let desired: Revision | undefined;
  let lastAttempt: string | undefined;
  let eligibleAt = 0;
  let firstProbe = true;
  let diagnostic: string | undefined;
  const abort = (): void => { active?.controller.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });

  function finish(attempt: ActiveRun, stopping: boolean): void {
    if (active === attempt) active = undefined;
    if (attempt.outcome?.kind !== "result") {
      throw new Error("Benchmark watch stopped after a run error because worker cleanup could not be verified");
    }
    const value = attempt.outcome.value;
    const unconfirmed = value.record.trials.some((trial) => !trial.result.terminationConfirmed);
    const matches = value.record.suiteDigest === attempt.revision.loaded.digest && value.record.roleDigest === attempt.revision.roleDigest;
    const current = !stopping && !unconfirmed && !attempt.stale && !attempt.controller.signal.aborted
      && desired?.fingerprint === attempt.revision.fingerprint && matches;
    options.onRun?.({ ...value, current, ...(baseline && current ? { comparison: compareBenchmarkRuns(baseline, value.record) } : {}) });
    if (unconfirmed) {
      throw new Error("Benchmark watch stopped because worker termination could not be confirmed");
    }
    if (attempt.stale || !matches) {
      if (lastAttempt === attempt.revision.fingerprint) lastAttempt = undefined;
      if (!matches) eligibleAt = Date.now() + debounceMs;
    }
  }

  try {
    while (!options.signal?.aborted) {
      let next: Revision | undefined;
      let nextDiagnostic: string | undefined;
      try { next = await probe(path, options.outputDirectory); }
      catch (error) { nextDiagnostic = invalidDiagnostic(error); }
      if (options.signal?.aborted) break;
      if (nextDiagnostic && nextDiagnostic !== diagnostic) options.onDiagnostic?.(nextDiagnostic);
      diagnostic = nextDiagnostic;
      if (next?.fingerprint !== desired?.fingerprint) {
        desired = next;
        eligibleAt = Date.now() + (firstProbe ? 0 : debounceMs);
        if (active) {
          active.stale = true;
          active.controller.abort();
        }
      }
      firstProbe = false;

      if (active?.outcome) finish(active, false);
      if (!options.signal?.aborted && !active && desired && desired.fingerprint !== lastAttempt && Date.now() >= eligibleAt) {
        const attempt: ActiveRun = {
          revision: desired, controller: new AbortController(), stale: false, done: Promise.resolve(),
        };
        active = attempt;
        lastAttempt = desired.fingerprint;
        attempt.done = Promise.resolve().then(() => execute(attempt.revision.loaded, {
          outputDirectory: options.outputDirectory,
          signal: attempt.controller.signal,
          onTrial: options.onTrial,
        })).then(
          (value) => { attempt.outcome = { kind: "result", value }; },
          () => { attempt.outcome = { kind: "error" }; },
        );
      }
      await pause(pollIntervalMs, options.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (active) {
      const attempt = active;
      attempt.controller.abort();
      await attempt.done;
      finish(attempt, true);
    }
  }
}

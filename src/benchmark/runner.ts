import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gradeBenchmarkResult, gradeBenchmarkWorkspace } from "./grading.ts";
import { runBenchmarkWorker } from "./process.ts";
import { materializeBenchmarkRole, snapshotBenchmarkRole } from "./snapshot.ts";
import { BenchmarkStore } from "./store.ts";
import { describeBenchmarkWorkspace, materializeBenchmarkFiles, snapshotBenchmarkFiles } from "./workspace.ts";
import type { BenchmarkFileSnapshot, BenchmarkGrade, BenchmarkRunRecord, BenchmarkTrial, BenchmarkWorkerRequest, BenchmarkWorkerResult, BenchmarkWorkspaceEvidence, LoadedBenchmarkSuite } from "./types.ts";

export interface BenchmarkRunOptions {
  outputDirectory: string;
  signal?: AbortSignal;
  onTrial?: (trial: BenchmarkTrial) => void;
  execute?: (request: BenchmarkWorkerRequest, options: { signal?: AbortSignal }) => Promise<BenchmarkWorkerResult>;
}

function interrupted(status: "cancelled" | "infra_error", diagnostic: string): BenchmarkWorkerResult {
  return { protocolVersion: 1, status, output: "", usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" }, durationMs: 0, terminationConfirmed: true, diagnostic };
}

async function canonicalOutput(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalOutput(dirname(path)), basename(path));
  }
}

export async function assertBenchmarkOutputDirectory(roleDirectory: string, output: string): Promise<string> {
  const outputDirectory = await canonicalOutput(resolve(output));
  const fromRole = relative(await realpath(roleDirectory), outputDirectory);
  if (fromRole === "" || (!isAbsolute(fromRole) && fromRole !== ".." && !fromRole.startsWith(`..${sep}`))) {
    throw new Error("Benchmark results must be stored outside the target role directory");
  }
  return outputDirectory;
}

export async function assertBenchmarkInputsOutputDirectory(loaded: LoadedBenchmarkSuite, output: string): Promise<string> {
  const directory = await assertBenchmarkOutputDirectory(loaded.roleDirectory, output);
  for (const item of loaded.cases) {
    if (!item.workspace) continue;
    for (const source of [item.workspace.fixture, item.workspace.checks]) {
      if (!source) continue;
      try { await assertBenchmarkOutputDirectory(resolve(loaded.directory, source), directory); }
      catch { throw new Error("Benchmark results must be stored outside fixture and check directories"); }
    }
  }
  return directory;
}

function snapshotContainsSecret(snapshot: BenchmarkFileSnapshot, values: readonly string[]): boolean {
  return snapshot.files.some(file => values.some(value => file.path.includes(value) || Buffer.from(file.content, "base64").includes(Buffer.from(value))));
}

function redactGrade(grade: BenchmarkGrade, values: readonly string[]): BenchmarkGrade {
  const serialized = JSON.stringify(grade);
  const leaked = values.filter(value => serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1)));
  if (!leaked.length) return grade;
  return { verdict: "unscored", assertions: [], terminationConfirmed: grade.terminationConfirmed !== false,
    error: "Grading evidence contained an explicitly allowed environment value; its output was discarded." };
}

export async function runBenchmark(loaded: LoadedBenchmarkSuite, options: BenchmarkRunOptions): Promise<{ record: BenchmarkRunRecord; directory: string }> {
  const outputDirectory = await assertBenchmarkInputsOutputDirectory(loaded, options.outputDirectory);
  const snapshot = await snapshotBenchmarkRole(loaded.roleDirectory);
  const { suite, cases, workspaces } = structuredClone(loaded);
  const secretValues = [...new Set(suite.host.env.map(name => process.env[name]).filter((value): value is string => !!value))];
  for (const item of cases) {
    if (!item.workspace) continue;
    const input = workspaces?.[item.id];
    if (!input) throw new Error("Workspace cases require frozen fixture inputs");
    if (snapshotContainsSecret(input.fixture, secretValues) || (input.checks && snapshotContainsSecret(input.checks, secretValues))) {
      throw new Error("Workspace inputs contain an explicitly allowed environment value");
    }
  }
  const record: BenchmarkRunRecord = {
    schemaVersion: 1, id: randomUUID(), suiteId: suite.id, suiteDigest: loaded.digest,
    roleDigest: snapshot.digest, startedAt: new Date().toISOString(), status: "running", isolation: "trusted-process",
    plannedTrials: cases.length * suite.run.repetitions, caseIds: cases.map(item => item.id), repetitions: suite.run.repetitions, trials: [],
  };
  const directory = join(outputDirectory, record.id);
  const store = new BenchmarkStore(directory);
  const execute = options.execute ?? runBenchmarkWorker;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const jobs = cases.flatMap(item => Array.from({ length: suite.run.repetitions }, (_, repetition) => ({ item, repetition })));
  let cursor = 0;
  try {
    store.create(record);
    await materializeBenchmarkRole(snapshot, join(directory, "snapshot"));
    const workspaceDirectories: Record<string, { fixtureDirectory: string; checksDirectory?: string }> = Object.create(null);
    for (const [caseIndex, item] of cases.entries()) {
      const input = item.workspace ? workspaces?.[item.id] : undefined;
      if (!input) continue;
      const prefix = `fixtures/${String(caseIndex).padStart(6, "0")}`;
      const fixtureDirectory = `${prefix}/workspace`;
      const checksDirectory = input.checks ? `${prefix}/checks` : undefined;
      workspaceDirectories[item.id] = { fixtureDirectory, ...(checksDirectory ? { checksDirectory } : {}) };
    }
    for (const [caseId, { fixtureDirectory, checksDirectory }] of Object.entries(workspaceDirectories)) {
      if (controller.signal.aborted) break;
      const input = workspaces![caseId]!;
      await materializeBenchmarkFiles(input.fixture, join(directory, fixtureDirectory));
      if (input.checks && checksDirectory) await materializeBenchmarkFiles(input.checks, join(directory, checksDirectory));
    }
    const plan = {
      schemaVersion: 1, suiteId: suite.id, suiteDigest: loaded.digest, roleDigest: snapshot.digest,
      target: { host: suite.target.host, roleId: snapshot.roleId, provider: suite.target.provider, model: suite.target.model },
      host: { moduleRootConfigured: !!suite.host.moduleRoot, env: suite.host.env,
        plugins: suite.host.plugins.map(plugin => ({
          module: plugin.module.startsWith("/") ? `local:${createHash("sha256").update(plugin.module).digest("hex")}` : plugin.module,
          ...(plugin.sourceDigest ? { sourceDigest: plugin.sourceDigest } : {}),
          config: plugin.config,
        })) },
      cases, run: suite.run, isolation: record.isolation,
      ...(workspaces ? { workspaces: Object.fromEntries(Object.entries(workspaces).map(([caseId, input]) => [caseId,
        { ...workspaceDirectories[caseId], fixtureDigest: input.fixture.digest, ...(input.checks ? { checksDigest: input.checks.digest } : {}) }])) } : {}),
    };
    await writeFile(join(directory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    async function consume(): Promise<void> {
      for (;;) {
        const index = cursor++;
        const job = jobs[index];
        if (!job) return;
        let result: BenchmarkWorkerResult;
        let grade: BenchmarkGrade | undefined;
        let evidence: BenchmarkWorkspaceEvidence | undefined;
        if (controller.signal.aborted) result = interrupted("cancelled", "Benchmark run cancelled before trial start");
        else {
          const root = await mkdtemp(join(tmpdir(), "rolebox-bench-trial-"));
          let terminationConfirmed = true;
          try {
            const workspace = join(root, "workspace");
            const rolesDirectory = join(root, "roles");
            const input = job.item.workspace ? workspaces?.[job.item.id] : undefined;
            if (input) await materializeBenchmarkFiles(input.fixture, workspace);
            else await mkdir(workspace, { mode: 0o700 });
            await materializeBenchmarkRole(snapshot, rolesDirectory);
            terminationConfirmed = false;
            result = await execute({ protocolVersion: 1, workspace, rolesDirectory, roleId: snapshot.roleId, provider: suite.target.provider, model: suite.target.model, host: suite.host, prompt: job.item.prompt, timeoutMs: suite.run.timeoutMs,
              ...(input ? { workspaceTask: true } : {}) }, { signal: controller.signal });
            terminationConfirmed = result.terminationConfirmed;
            if (!result.terminationConfirmed) {
              controller.abort();
              result = { ...result, status: "infra_error", diagnostic: "Worker termination could not be confirmed" };
            }
            if (input && result.status === "completed" && terminationConfirmed) {
              let finalWorkspace: BenchmarkFileSnapshot | undefined;
              try {
                finalWorkspace = await snapshotBenchmarkFiles(workspace, { omitRoleboxState: true });
                if (snapshotContainsSecret(finalWorkspace, secretValues)) {
                  grade = { verdict: "unscored", assertions: [], error: "Workspace evidence contained an explicitly allowed environment value; artifacts were not saved.", terminationConfirmed: true };
                } else {
                  const artifactDirectory = `artifacts/${String(index).padStart(6, "0")}/workspace`;
                  const captured = describeBenchmarkWorkspace(input.fixture, finalWorkspace, artifactDirectory);
                  await materializeBenchmarkFiles(finalWorkspace, join(directory, artifactDirectory));
                  evidence = captured;
                }
              } catch {
                grade = { verdict: "unscored", assertions: [], error: "Workspace evidence could not be captured within supported file limits.", terminationConfirmed: true };
              }
              if (finalWorkspace && !grade) {
                try {
                  grade = redactGrade(await gradeBenchmarkWorkspace(job.item, result, { workspace: finalWorkspace, checks: input.checks, signal: controller.signal }), secretValues);
                  if (grade.terminationConfirmed === false) { terminationConfirmed = false; controller.abort(); }
                } catch {
                  controller.abort();
                  terminationConfirmed = false;
                  grade = { verdict: "unscored", assertions: [], error: "Workspace grading failed; cleanup could not be verified.", terminationConfirmed: false };
                }
              }
            }
          } catch {
            if (!terminationConfirmed) controller.abort();
            result = { ...interrupted("infra_error", "Benchmark worker failed; inspect the host capability check"), terminationConfirmed };
          } finally {
            if (terminationConfirmed) await rm(root, { recursive: true, force: true });
          }
        }
        const trial: BenchmarkTrial = { id: String(index).padStart(6, "0"), caseId: job.item.id, repetition: job.repetition, result, grade: grade ?? gradeBenchmarkResult(job.item, result), ...(evidence ? { workspace: evidence } : {}) };
        store.recordTrial(record.id, trial);
        record.trials.push(trial);
        options.onTrial?.(trial);
      }
    }
    const outcomes = await Promise.allSettled(Array.from({ length: suite.run.concurrency }, () => consume().catch(error => { controller.abort(); throw error; })));
    const failure = outcomes.find(outcome => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    record.trials.sort((a, b) => a.id.localeCompare(b.id));
    record.status = record.trials.length === record.plannedTrials && record.trials.every(trial => trial.grade.verdict !== "unscored" && trial.grade.terminationConfirmed !== false && trial.result.terminationConfirmed) ? "completed" : "incomplete";
    record.completedAt = new Date().toISOString();
    store.finish(record);
    return { record, directory };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    store.close();
  }
}

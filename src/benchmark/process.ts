import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkWorkerRequest, BenchmarkWorkerResult } from "./types.ts";

const startupAllowanceMs = 10_000;
const terminationGraceMs = 500;
const terminationConfirmationMs = 2_000;
const maximumResultBytes = 8 * 1024 * 1024;
const statuses = new Set(["completed", "task_failure", "task_timeout", "infra_error", "invalid", "cancelled"]);
const overriddenEnvironment = new Set(["HOME", "DSH_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "ROLEBOX_DATA_DIR", "ROLEBOX_CONFIG_DIR", "TMPDIR", "TEMP", "TMP", "ROLEBOX_HOT_RELOAD", "ROLEBOX_ENGINE_RECOVERY"]);

export interface BenchmarkWorkerOptions {
  signal?: AbortSignal;
  workerPath?: string;
}

function failure(status: BenchmarkWorkerResult["status"], diagnostic: string, started: number,
  terminationConfirmed = true): BenchmarkWorkerResult {
  return { protocolVersion: 1, status, output: "", diagnostic,
    usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" },
    durationMs: Date.now() - started, terminationConfirmed };
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* Confirmation below determines whether shutdown succeeded. */ }
}

async function waitForGroupExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

async function stopGroup(pid: number): Promise<boolean> {
  signalGroup(pid, "SIGTERM");
  if (await waitForGroupExit(pid, terminationGraceMs)) return true;
  signalGroup(pid, "SIGKILL");
  return waitForGroupExit(pid, terminationConfirmationMs);
}

async function isolatedEnvironment(root: string, allowed: string[]): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", ...allowed]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const directories = {
    HOME: join(root, "home"), DSH_HOME: join(root, "dsh"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), ROLEBOX_DATA_DIR: join(root, "rolebox-data"),
    ROLEBOX_CONFIG_DIR: join(root, "rolebox-config"), TMPDIR: join(root, "tmp"),
  };
  await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  return { ...env, ...directories, TEMP: directories.TMPDIR, TMP: directories.TMPDIR,
    ROLEBOX_HOT_RELOAD: "false", ROLEBOX_ENGINE_RECOVERY: "off" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function parseResult(value: unknown, request: BenchmarkWorkerRequest): BenchmarkWorkerResult | undefined {
  if (!isObject(value) || value.protocolVersion !== 1 || typeof value.status !== "string" ||
    !statuses.has(value.status) || typeof value.output !== "string" || value.output.length > 4_194_304 ||
    typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
    typeof value.terminationConfirmed !== "boolean" ||
    (value.diagnostic !== undefined && (typeof value.diagnostic !== "string" || value.diagnostic.length > 65_536))) return;
  const usage = value.usage;
  if (!isObject(usage) || !validCount(usage.inputTokens) || !validCount(usage.outputTokens) ||
    (usage.costUsd !== null && (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) ||
    (usage.source !== "host" && usage.source !== "unavailable")) return;
  if (usage.source === "unavailable" && (usage.inputTokens !== null || usage.outputTokens !== null || usage.costUsd !== null)) return;
  const activation = value.activation;
  if (activation !== undefined && (!isObject(activation) || activation.roleId !== request.roleId ||
    activation.provider !== request.provider || activation.model !== request.model ||
    typeof activation.roleId !== "string" || activation.roleId.length > 128 || !activation.roleId ||
    typeof activation.provider !== "string" || activation.provider.length > 4_096 || !activation.provider ||
    typeof activation.model !== "string" || activation.model.length > 4_096 || !activation.model ||
    typeof activation.promptDigest !== "string" || !/^[a-f0-9]{64}$/.test(activation.promptDigest))) return;
  if (value.status === "completed" && !activation) return;
  const runtime = value.runtime;
  if (runtime !== undefined && (!isObject(runtime) || typeof runtime.dshVersion !== "string" ||
    !runtime.dshVersion || runtime.dshVersion.length > 128 || typeof runtime.roleboxVersion !== "string" ||
    !runtime.roleboxVersion || runtime.roleboxVersion.length > 128)) return;
  return {
    protocolVersion: 1, status: value.status as BenchmarkWorkerResult["status"], output: value.output,
    durationMs: value.durationMs, terminationConfirmed: value.terminationConfirmed,
    usage: { inputTokens: usage.inputTokens as number | null, outputTokens: usage.outputTokens as number | null,
      costUsd: usage.costUsd as number | null, source: usage.source },
    ...(activation ? { activation: { roleId: request.roleId, provider: request.provider, model: request.model,
      promptDigest: (activation as Record<string, string>).promptDigest } } : {}),
    ...(runtime ? { runtime: { dshVersion: (runtime as Record<string, string>).dshVersion,
      roleboxVersion: (runtime as Record<string, string>).roleboxVersion } } : {}),
    ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
  };
}

function redactEnvironmentValues(result: BenchmarkWorkerResult, values: readonly string[]): BenchmarkWorkerResult {
  const serialized = JSON.stringify(result);
  const leaked = values.filter(value => serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1)));
  if (leaked.length === 0) return result;
  let output = result.output;
  for (const value of leaked) output = output.replaceAll(value, "[redacted]");
  if (output.length > 4_194_304) output = "[redacted]";
  return { protocolVersion: 1, status: "invalid", output, usage: result.usage,
    durationMs: result.durationMs, terminationConfirmed: result.terminationConfirmed,
    diagnostic: "The worker exposed an explicitly allowed environment value; sensitive content was redacted." };
}

async function readResult(path: string, request: BenchmarkWorkerRequest): Promise<BenchmarkWorkerResult | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumResultBytes) return;
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) return;
    return parseResult(JSON.parse(buffer.subarray(0, length).toString("utf8")), request);
  } finally { await file.close(); }
}

export async function runBenchmarkWorker(request: BenchmarkWorkerRequest,
  options: BenchmarkWorkerOptions = {}): Promise<BenchmarkWorkerResult> {
  const started = Date.now();
  if (options.signal?.aborted) return failure("cancelled", "The benchmark trial was cancelled before startup.", started);
  if (process.platform === "win32") {
    return failure("invalid", "Benchmark process-tree termination is not supported on Windows.", started);
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647 - startupAllowanceMs) {
    return failure("invalid", "The benchmark execution deadline is invalid.", started);
  }
  let root: string | undefined;
  let child: ChildProcess | undefined;
  let exit: Promise<{ code: number | null; failed: boolean }> | undefined;
  let stopped: Promise<boolean> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let expired = false;
  let terminationConfirmed = true;
  let forwardedValues: string[] = [];
  let reportUnconfirmed: () => void = () => {};
  const unconfirmed = new Promise<{ code: null; failed: true }>(resolve => {
    reportUnconfirmed = () => resolve({ code: null, failed: true });
  });
  let result = failure("infra_error", "The benchmark worker could not be started.", started);
  const stop = (): Promise<boolean> => {
    if (child?.pid) stopped ??= stopGroup(child.pid).then(confirmed => {
      if (!confirmed) reportUnconfirmed();
      return confirmed;
    });
    return stopped ?? Promise.resolve(true);
  };
  const abort = (): void => { cancelled = true; void stop(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-worker-"));
    await chmod(root, 0o700);
    const requestPath = join(root, "request.json");
    const resultPath = join(root, "result.json");
    const env = await isolatedEnvironment(root, request.host.env);
    forwardedValues = [...new Set(request.host.env.filter(name => !overriddenEnvironment.has(name))
      .map(name => env[name]).filter((value): value is string => typeof value === "string" && value.length > 0))]
      .sort((left, right) => right.length - left.length);
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    if (!cancelled) {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const workerPath = options.workerPath ?? fileURLToPath(new URL(`./hosts/dsh-worker.${extension}`, import.meta.url));
      const runtimeArgs = workerPath.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
      if (runtimeArgs.length) env.TSX_DISABLE_CACHE = "1";
      child = spawn(process.execPath, [...runtimeArgs, workerPath, requestPath, resultPath], {
        cwd: request.workspace, env, detached: true, stdio: "ignore", shell: false,
      });
      exit = new Promise(resolve => {
        child!.once("error", () => resolve({ code: null, failed: true }));
        child!.once("exit", code => resolve({ code, failed: false }));
      });
      if (cancelled || options.signal?.aborted) abort();
      deadline = setTimeout(() => { expired = true; void stop(); }, request.timeoutMs + startupAllowanceMs);
      const outcome = await Promise.race([exit, unconfirmed]);
      clearTimeout(deadline);
      // Loader helpers may need a scheduling turn to exit after their worker.
      const lingering = child.pid !== undefined && !await waitForGroupExit(child.pid, terminationGraceMs);
      if (lingering) await stop();
      terminationConfirmed = stopped ? await stopped : true;
      if (!terminationConfirmed) {
        result = failure("infra_error", "The benchmark worker process group did not confirm termination.", started, false);
      } else if (expired) {
        result = failure("infra_error", "The worker exceeded the outer deadline before completing initialization, execution and teardown.", started);
      } else if (outcome.failed || outcome.code !== 0) {
        result = failure("infra_error", "The benchmark worker exited unsuccessfully.", started);
      } else if (lingering) {
        result = failure("infra_error", "The benchmark worker exited with descendant processes still running.", started);
      } else {
        try {
          result = await readResult(resultPath, request) ?? failure("infra_error", "The benchmark worker result did not satisfy the protocol.", started);
          if (!result.terminationConfirmed) {
            result = { ...result, status: "infra_error", diagnostic: "The benchmark worker did not confirm host teardown." };
          }
        } catch {
          result = failure("infra_error", "The benchmark worker result is missing or unreadable.", started);
        }
      }
    }
  } catch {
    terminationConfirmed = await stop();
    if (exit && terminationConfirmed) await exit;
    result = failure("infra_error", "The benchmark worker could not complete its process lifecycle.", started, terminationConfirmed);
  } finally {
    clearTimeout(deadline);
    if (stopped) terminationConfirmed = await stopped;
    if (root && terminationConfirmed) {
      try { await rm(root, { recursive: true, force: true }); }
      catch { result = failure("infra_error", "The benchmark control directory could not be removed.", started, terminationConfirmed); }
    }
    options.signal?.removeEventListener("abort", abort);
  }
  return cancelled
    ? failure("cancelled", "The benchmark trial was cancelled.", started, terminationConfirmed)
    : redactEnvironmentValues(result, forwardedValues);
}

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkAssertion, BenchmarkFileSnapshot, BenchmarkGrade } from "./types.ts";
import { materializeBenchmarkFiles } from "./workspace.ts";

type CommandAssertion = Extract<BenchmarkAssertion, { kind: "command" }>;
type CommandEvidence = NonNullable<BenchmarkGrade["assertions"][number]["command"]>;

export interface BenchmarkCommandInput {
  workspace: BenchmarkFileSnapshot;
  checks?: BenchmarkFileSnapshot;
  signal?: AbortSignal;
}

export interface BenchmarkCommandGrade {
  assertion: BenchmarkGrade["assertions"][number];
  terminationConfirmed: boolean;
  error?: string;
}

const outputLimit = 16_384;
const terminationGraceMs = 500;
const terminationConfirmationMs = 2_000;

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* Group disappearance is confirmed separately. */ }
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

async function isolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const directories = {
    HOME: join(root, "home"), DSH_HOME: join(root, "dsh"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    ROLEBOX_DATA_DIR: join(root, "rolebox-data"), ROLEBOX_CONFIG_DIR: join(root, "rolebox-config"),
    TMPDIR: join(root, "tmp"),
  };
  await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  return { ...env, ...directories, TEMP: directories.TMPDIR, TMP: directories.TMPDIR,
    ROLEBOX_HOT_RELOAD: "false", ROLEBOX_ENGINE_RECOVERY: "off" };
}

async function waitForClose(closed: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), terminationConfirmationMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function runBenchmarkCommand(assertion: CommandAssertion,
  input: BenchmarkCommandInput): Promise<BenchmarkCommandGrade> {
  const started = Date.now();
  const evidence: CommandEvidence = {
    status: "error", exitCode: null, stdout: "", stderr: "", durationMs: 0,
    terminationConfirmed: true, truncated: false,
  };
  let error: string | undefined;
  const finish = (): BenchmarkCommandGrade => ({
    assertion: { kind: "command", passed: evidence.status === "completed" && evidence.exitCode === assertion.expectedExitCode,
      command: { ...evidence, durationMs: Date.now() - started } },
    terminationConfirmed: evidence.terminationConfirmed,
    ...(error ? { error } : {}),
  });
  if (input.signal?.aborted) {
    evidence.status = "cancelled";
    error = "The benchmark grader was cancelled before startup.";
    return finish();
  }
  if (process.platform === "win32") {
    error = "Benchmark command process-tree termination is not supported on Windows.";
    return finish();
  }
  if (!Number.isSafeInteger(assertion.timeoutMs) || assertion.timeoutMs <= 0 || assertion.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(assertion.expectedExitCode) || assertion.expectedExitCode < 0 || assertion.expectedExitCode > 255 ||
    !Array.isArray(assertion.argv) || assertion.argv.length === 0 || !assertion.argv[0] ||
    assertion.argv.some(value => typeof value !== "string" || value.includes("\0"))) {
    error = "The benchmark command assertion is invalid.";
    return finish();
  }
  if (!input.checks && assertion.argv.some(value => value.includes("{checks}"))) {
    error = "The benchmark command requires a checks snapshot.";
    return finish();
  }
  let root: string | undefined;
  let child: ChildProcess | undefined;
  let stopped: Promise<boolean> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let expired = false;
  let reportUnconfirmed: () => void = () => {};
  const unconfirmed = new Promise<{ code: null; failed: true }>(resolve => {
    reportUnconfirmed = () => resolve({ code: null, failed: true });
  });
  const stop = (): Promise<boolean> => {
    if (child?.pid) stopped ??= stopGroup(child.pid).then(confirmed => {
      if (!confirmed) reportUnconfirmed();
      return confirmed;
    });
    return stopped ?? Promise.resolve(true);
  };
  const abort = (): void => { cancelled = true; void stop(); };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-grader-"));
    await chmod(root, 0o700);
    const workspace = join(root, "workspace");
    const checks = join(root, "checks");
    await materializeBenchmarkFiles(input.workspace, workspace);
    if (input.checks) await materializeBenchmarkFiles(input.checks, checks);
    const env = await isolatedEnvironment(root);
    if (!cancelled) {
      const argv = assertion.argv.map(value => value.replaceAll("{workspace}", workspace).replaceAll("{checks}", checks));
      child = spawn(argv[0]!, argv.slice(1), { cwd: workspace, env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const exit = new Promise<{ code: number | null; failed: boolean }>(resolve => {
        child!.once("error", () => resolve({ code: null, failed: true }));
        child!.once("exit", code => resolve({ code, failed: false }));
      });
      const closed = new Promise<void>(resolve => { child!.once("close", () => resolve()); });
      for (const key of ["stdout", "stderr"] as const) {
        child[key]!.setEncoding("utf8");
        child[key]!.on("data", (chunk: string) => {
          const available = outputLimit - evidence[key].length;
          if (chunk.length > available) evidence.truncated = true;
          if (available > 0) evidence[key] += chunk.slice(0, available);
        });
        child[key]!.on("error", () => { error = "The benchmark command output could not be read."; });
      }
      if (cancelled || input.signal?.aborted) abort();
      deadline = setTimeout(() => { expired = true; void stop(); }, assertion.timeoutMs);
      const outcome = await Promise.race([exit, unconfirmed]);
      clearTimeout(deadline);
      evidence.exitCode = outcome.code;
      const lingering = child.pid !== undefined && groupExists(child.pid);
      if (lingering) await stop();
      evidence.terminationConfirmed = stopped ? await stopped : true;
      if (evidence.terminationConfirmed && !await waitForClose(closed)) evidence.terminationConfirmed = false;
      if (!evidence.terminationConfirmed) {
        error = "The benchmark command did not confirm process-tree termination.";
      } else if (cancelled) {
        evidence.status = "cancelled";
        error = "The benchmark grader was cancelled.";
      } else if (expired) {
        evidence.status = "timeout";
      } else if (outcome.failed || outcome.code === null) {
        error = "The benchmark command could not start or exited without an exit code.";
      } else if (lingering) {
        error = "The benchmark command exited with descendant processes still running.";
      } else if (!error) {
        evidence.status = "completed";
      }
    }
  } catch {
    evidence.terminationConfirmed = await stop();
    error = "The benchmark command could not complete its process lifecycle.";
  } finally {
    clearTimeout(deadline);
    if (stopped) evidence.terminationConfirmed &&= await stopped;
    input.signal?.removeEventListener("abort", abort);
    if (root && evidence.terminationConfirmed) {
      try { await rm(root, { recursive: true, force: true }); }
      catch { error = "The benchmark grader directory could not be removed."; }
    }
    if (!evidence.terminationConfirmed) {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
    }
  }
  if (cancelled) {
    evidence.status = "cancelled";
    error = evidence.terminationConfirmed ? "The benchmark grader was cancelled." :
      "The benchmark grader was cancelled without confirmed process-tree termination.";
  } else if (error) evidence.status = "error";
  return finish();
}

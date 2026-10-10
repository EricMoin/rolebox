/**
 * The thin executor behind the computer-use drivers.
 *
 * A driver builds a {@link ComputerPlan} — a pure value — and this module is the
 * only place that turns one into a process. It owns exactly four things the
 * plan cannot: checking that the helper binaries exist, resolving the spawn
 * vector through the system's own {@link resolveSpawnCommand}, bounding the run
 * (timeout plus the caller's `AbortSignal`), and turning every outcome into
 * either the helper's output or one sentence that starts with `Error:`.
 *
 * Nothing here throws: a missing helper, a spawn failure, a timeout, a
 * cancellation and a non-zero exit are all returned as `{ ok: false, error }`,
 * so a tool can hand the text straight back to the model.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, win32 as windowsPath } from "node:path";
import { resolveSpawnCommand, type SpawnCommand } from "../platform/system/spawn-command.ts";
import type { ComputerPlan } from "../platform/system/types.ts";

/** How long one computer-use command may run before it is killed (15s). */
export const DEFAULT_COMPUTER_TIMEOUT_MS = 15_000;

/** Output cap per stream, matching the graph worker command runner. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** How much of a helper's own error text one failure sentence carries. */
const MAX_DETAIL_CHARS = 400;

/** What one executed plan produced. */
export type ComputerRunResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

/** One plan run's bounds. */
export interface ComputerRunOptions {
  /** The environment the helper runs with; defaults to this process's own. */
  readonly env?: NodeJS.ProcessEnv;
  /** Hard limit on the run; defaults to {@link DEFAULT_COMPUTER_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Cancellation forwarded from the tool context. */
  readonly signal?: AbortSignal;
  /** Working directory for the helper. */
  readonly cwd?: string;
  /** The system's install sentence, used when a required helper is absent. */
  readonly installHint?: string;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a required helper can be started with `env`.
 *
 * An absolute path (the macOS and `/bin/sh` plans) is checked directly; a bare
 * name is resolved against `PATH`, with `PATHEXT` extensions on Windows. The
 * host's own rules are used because the executor is starting this host's
 * process: a plan for another system can only be refused here, never faked.
 */
export function helperAvailable(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (name.length === 0) return false;
  if (isAbsolute(name) || windowsPath.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return isExecutableFile(name);
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  if (pathValue.length === 0) return false;
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      if (extension.length === 0 && process.platform === "win32") continue;
      if (isExecutableFile(join(directory, name + extension))) return true;
    }
  }
  return false;
}

/**
 * The exact spawn vector a plan resolves to on this system.
 *
 * The dry-run report and the real run both come through here, so what a caller
 * is shown is what would be started — never a plan that a later step rewrites.
 */
export function spawnVectorFor(plan: ComputerPlan, env: NodeJS.ProcessEnv = process.env): SpawnCommand {
  return resolveSpawnCommand(plan.argv[0], plan.argv.slice(1), env);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find(candidate => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}...` : trimmed;
}

/** Run one plan, bounded by a timeout and the caller's abort signal. */
export async function runComputerPlan(
  plan: ComputerPlan,
  options: ComputerRunOptions = {},
): Promise<ComputerRunResult> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPUTER_TIMEOUT_MS;
  const hint = options.installHint !== undefined && options.installHint.length > 0 ? ` ${options.installHint}` : "";
  const withPermissionHint = (message: string): string =>
    plan.permissionHint === undefined ? message : `${message} ${plan.permissionHint}`;

  const missing = plan.requires.find(helper => !helperAvailable(helper, env));
  if (missing !== undefined) {
    return {
      ok: false,
      error: withPermissionHint(
        `Error: the ${plan.driver} driver needs "${missing}", which is not available.${hint}`,
      ),
    };
  }
  if (options.signal?.aborted === true) {
    return { ok: false, error: `Error: the ${plan.driver} command was cancelled before it started.` };
  }

  const vector = spawnVectorFor(plan, env);
  const executable = vector.argv[0];
  if (typeof executable !== "string" || executable.length === 0) {
    return { ok: false, error: `Error: the ${plan.driver} driver produced an empty command.` };
  }

  return await new Promise<ComputerRunResult>(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped: "timeout" | "abort" | "output" | null = null;
    let settled = false;

    const child = spawn(executable, [...vector.argv.slice(1)], {
      env,
      windowsVerbatimArguments: vector.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      // A POSIX child gets its own process group so a timeout can stop the whole
      // command, not just the shell that started it.
      detached: process.platform !== "win32",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    const stop = (reason: "timeout" | "abort" | "output"): void => {
      if (stopped === null) stopped = reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child is already gone; "close" still reports it.
        }
      }
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop("output");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = (): void => stop("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", error => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, error: withPermissionHint(`Error: could not start "${executable}": ${error.message}`) });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = Buffer.concat(chunks).toString("utf8");
      if (stopped === "timeout") {
        resolve({
          ok: false,
          error: withPermissionHint(
            `Error: the ${plan.driver} command did not finish within ${timeoutMs}ms and was stopped.`,
          ),
        });
        return;
      }
      if (stopped === "abort") {
        resolve({ ok: false, error: withPermissionHint(`Error: the ${plan.driver} command was cancelled.`) });
        return;
      }
      if (stopped === "output") {
        resolve({
          ok: false,
          error: `Error: the ${plan.driver} command produced more than ${MAX_OUTPUT_BYTES} bytes and was stopped.`,
        });
        return;
      }
      if (code !== 0) {
        const detail = firstLine(output);
        resolve({
          ok: false,
          error: withPermissionHint(
            `Error: the ${plan.driver} command exited with status ${code}${detail.length === 0 ? "." : `: ${detail}`}`,
          ),
        });
        return;
      }
      resolve({ ok: true, output: output.trim() });
    });
  });
}

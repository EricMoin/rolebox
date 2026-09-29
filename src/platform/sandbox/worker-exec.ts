import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getSystem } from "../system/index.ts";

/**
 * Keep installed browsers discoverable while a command runs with a disposable
 * HOME. The defaults are the caches an installed Playwright/Puppeteer leaves
 * under the real home OF THE DETECTED SYSTEM (src/platform/system/), which that
 * HOME would otherwise hide; host-set values win, with relative paths resolved
 * against the workspace and Playwright's `0` still selecting package-local
 * browsers. Whether the host policy then permits reading them is the host's
 * decision, not this runner's.
 */
export function browserDiscoveryEnvironment(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Record<string, string> {
  const cached = getSystem().browserCaches(home);
  const playwright = env.PLAYWRIGHT_BROWSERS_PATH || cached.playwright;
  const puppeteer = resolve(workspace, env.PUPPETEER_CACHE_DIR || cached.puppeteer);
  const environment: Record<string, string> = {
    PLAYWRIGHT_BROWSERS_PATH: playwright === "0" ? "0" : resolve(workspace, playwright),
    PUPPETEER_CACHE_DIR: puppeteer,
  };
  if (env.PUPPETEER_EXECUTABLE_PATH) {
    environment.PUPPETEER_EXECUTABLE_PATH = resolve(workspace, env.PUPPETEER_EXECUTABLE_PATH);
  }
  return environment;
}

/**
 * Run one graph worker command as an already-decided spawn vector.
 *
 * The CALLER owns the boundary: `argv` is what the host's confinement service
 * returned for the session's resolved policy (or the plain command vector for a
 * `danger-full-access` session). This runner applies no OS profile of its own —
 * it only provides the per-command scratch environment, the process-group
 * cancellation, the timeout and the output cap.
 */
export async function executeGraphWorkerCommand(options: {
  /** Complete spawn vector: `[executable, ...args]`, validated non-empty before anything is spawned. */
  argv: readonly string[];
  workspace: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ exitCode: number | null; output: string }> {
  const executable = options.argv[0];
  if (typeof executable !== "string" || executable.length === 0 ||
      options.argv.some(part => typeof part !== "string" || part.length === 0)) {
    throw new Error("A graph worker command needs a non-empty spawn argv");
  }
  const scratch = mkdtempSync(join(tmpdir(), "graph-worker-command-"));
  try {
    const home = join(scratch, "home");
    const config = join(home, ".config");
    const cache = join(home, ".cache");
    mkdirSync(config, { recursive: true });
    mkdirSync(cache, { recursive: true });
    return await new Promise((finish, fail) => {
      const child = spawn(executable, options.argv.slice(1), { cwd: options.workspace, detached: true,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8",
          // Which variables make these directories disposable is an OS fact, so
          // it comes from the detected system's descriptor instead of hardcoded
          // macOS/POSIX variable names.
          ...getSystem().disposableEnvironment({ home, config, cache, temp: scratch, env: process.env }),
          ...browserDiscoveryEnvironment(options.workspace) }, stdio: ["ignore", "pipe", "pipe"] });
      const buffers: Buffer[] = [];
      let bytes = 0;
      let terminated = false;
      const stop = () => {
        terminated = true;
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      };
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { stop(); return; }
        buffers.push(chunk);
      };
      child.stdout.on("data", onData); child.stderr.on("data", onData);
      const timer = setTimeout(stop, options.timeoutMs ?? 60_000);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); };
      child.on("error", error => { cleanup(); fail(error); });
      child.on("close", code => {
        cleanup();
        finish({ exitCode: code, output: Buffer.concat(buffers).toString("utf8") + (terminated ? "\nCommand stopped by cancellation, timeout or output limit." : "") });
      });
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

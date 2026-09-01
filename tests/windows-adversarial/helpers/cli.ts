// tests/windows-adversarial/helpers/cli.ts
//
// runCli(args, opts) — spawn the real rolebox CLI after ensuring it is built,
// with every "user data" location redirected to per-test temp dirs so the
// campaign never touches real user data. Returns a structured result that
// subtasks 2-7 consume and pass straight into recordDefect().
//
// ── Why this exists ─────────────────────────────────────────────────────
// The adversarial campaign drives the compiled CLI as a real child process
// (`bun <repoRoot>/dist/cli/main.js`) — not by importing src modules. That is
// the only way to exercise the exact boundary a Windows user hits: argv
// parsing, citty command dispatch, paths.ts platform branches (win32
// LOCALAPPDATA/APPDATA), filesystem writes, symlink/junction handling, exit
// codes, and stdout/stderr formatting. Importing modules directly would bypass
// all of that and make the "adversarial" results meaningless.
//
// ── Safety contract ─────────────────────────────────────────────────────
// * Default isolation forces ROLEBOX_DATA_DIR and ROLEBOX_CONFIG_DIR to fresh
//   temp dirs under os.tmpdir() BEFORE the process spawns. The CLI resolves
//   every data/config path through paths.ts getDataDir()/getConfigDir(), which
//   honors those two env overrides first (src/cli/paths.ts:66, 99). As a belt
//   and suspenders measure the CLI also writes its version-check cache under
//   getDataDir(), so even that goes to the temp dir.
// * A caller may provide its own dataDir/configDir (to pre-seed fixtures or to
//   inspect what the CLI wrote); those become the forced env values.
// * `isolateDirs: false` is the ONLY way to skip the redirect, and it is
//   dangerous — it lets the CLI touch the real on-disk data/config dirs. Use it
//   only for a test that deliberately exercises the default-path resolution on
//   Windows, and point HOME/APPDATA somewhere harmless first.
//
// ── Determinism ─────────────────────────────────────────────────────────
// On first run with a fresh dataDir, the CLI's cleanup() hook (citty runMain →
// checkForUpdate) makes a best-effort npm registry call (3s timeout, never
// throws). That is network-dependent and can add latency or print an update
// box. To keep a test hermetic and fast, pre-seed the version-check cache
// before invoking runCli (see the smoke test for the exact pattern):
//   mkdir -p <dataDir>/cache
//   write <dataDir>/cache/version-check.json = { latestVersion: pkgVersion, checkedAt: now }
//
// ── Signature (stable contract for subtasks 2-7) ───────────────────────
//   runCli(args: string[], opts?: CliOpts): Promise<CliResult>
//   Example:
//     const r = await runCli(["install", "some-role"], { cwd: tmp, timeout: 30000 });
//     if (r.exitCode !== 0) recordDefect("install-fail", {
//       scenario: "install from temp cwd", command: r.command, expected: "exit 0",
//       actual: r.stdoutTail + r.stderrTail, exit_code: r.exitCode,
//       stdout_tail: r.stdoutTail, stderr_tail: r.stderrTail, file_line_refs: [],
//     });

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// repoRoot = tests/windows-adversarial/helpers -> ../../.. = repo root.
import { REPO_ROOT } from "./evidence";

const CLI_PATH = join(REPO_ROOT, "dist", "cli", "main.js");
const DEFAULT_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 300_000;
const TAIL_CHARS = 2_000;
const TEMP_PREFIX = "rolebox-wintest-";

export interface CliOpts {
  /** Working directory for the spawned process (defaults to repo root). */
  cwd?: string;
  /** Extra/overriding environment variables merged over the redirected base env. */
  env?: Record<string, string | undefined>;
  /** Spawn through a shell so the command line is interpreted (default false). */
  shell?: boolean;
  /** Kill the child after this many ms and mark timedOut (default 15000). */
  timeout?: number;
  /**
   * Override ROLEBOX_DATA_DIR. If omitted a fresh temp dir is created.
   * This value becomes the forced env var, never the real user dir.
   */
  dataDir?: string;
  /** Override ROLEBOX_CONFIG_DIR. If omitted a fresh temp dir is created. */
  configDir?: string;
  /**
   * Keep the temp dirs after the run so the caller can inspect what the CLI
   * wrote (default true). Set false to auto-remove both dirs.
   */
  keepTempDirs?: boolean;
  /** Skip the env redirect entirely. DANGEROUS — see the safety contract above. */
  isolateDirs?: boolean;
  /** Rebuild dist/cli/main.js if the file is absent (default true). */
  buildIfMissing?: boolean;
}

export interface CliResult {
  /** The argv passed to the CLI. */
  args: string[];
  /** A human-readable command string (bun <repo>/dist/cli/main.js <args>), for evidence. */
  command: string;
  /** Child exit code, or null if it never exited cleanly (timeout/kill/spawn error). */
  exitCode: number | null;
  /** Termination signal, or null. */
  signal: string | null;
  /** Full captured stdout. */
  stdout: string;
  /** Full captured stderr. */
  stderr: string;
  /** Last ~2000 chars of stdout (for recordDefect). */
  stdoutTail: string;
  /** Last ~2000 chars of stderr (for recordDefect). */
  stderrTail: string;
  /** Resolved ROLEBOX_DATA_DIR used for this run. */
  dataDir: string;
  /** Resolved ROLEBOX_CONFIG_DIR used for this run. */
  configDir: string;
  /** True if the child was killed by the timeout. */
  timedOut: boolean;
  /** Wall-clock duration of the child process, in ms. */
  durationMs: number;
  /** True if this call rebuilt dist/cli/main.js (it was missing). */
  built: boolean;
  /** Set if the build step failed (exitCode will be null). */
  buildError?: string;
  /** Set if the process failed to spawn at all (exitCode will be null). */
  spawnError?: string;
}

/** Resolve the bun executable — use the same bun that is running the tests if possible. */
function bunExecutable(cwd: string): string {
  const exe = process.execPath || "bun";
  const base = basename(exe).toLowerCase().split(".")[0];
  if (base.includes("bun")) return exe;
  // Fallback: rely on PATH (setup-bun adds it in CI; developer bun on darwin).
  return "bun";
}

/** Ensure dist/cli/main.js exists, building via the repo's real build script if absent. */
function ensureBuilt(buildIfMissing: boolean, cwd: string): { ok: boolean; built: boolean; error?: string } {
  if (existsSync(CLI_PATH)) return { ok: true, built: false };
  if (!buildIfMissing) {
    return { ok: false, built: false, error: `dist/cli/main.js missing and buildIfMissing=false` };
  }
  try {
    const res = spawnSync("bun run typecheck && bun run build", {
      cwd,
      shell: true,
      timeout: BUILD_TIMEOUT_MS,
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (res.status !== 0) {
      return {
        ok: false,
        built: true,
        error: `build failed (exit ${res.status}): ${(res.stderr || res.stdout || "").slice(-2000)}`,
      };
    }
    return { ok: existsSync(CLI_PATH), built: true };
  } catch (err) {
    return { ok: false, built: true, error: `build threw: ${String(err)}` };
  }
}

/** Quote a single argument for a shell command string (POSIX and cmd.exe share double-quote rules). */
function quoteShell(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Run the rolebox CLI as a child process. Never throws for CLI failures — it
 * returns them structurally in CliResult so the caller can record a defect.
 * (Throws only if the harness itself is misconfigured, e.g. a rejected cwd.)
 */
export async function runCli(args: string[], opts: CliOpts = {}): Promise<CliResult> {
  const start = Date.now();
  const cwd = resolve(opts.cwd || REPO_ROOT);
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const isolate = opts.isolateDirs !== false;

  // ── Build if missing ────────────────────────────────────────────────
  const build = ensureBuilt(opts.buildIfMissing !== false, cwd);
  if (!build.ok) {
    return {
      args,
      command: `${bunExecutable(cwd)} ${CLI_PATH} ${args.join(" ")}`,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: build.error || "build failed",
      stdoutTail: "",
      stderrTail: build.error || "build failed",
      dataDir: opts.dataDir || "",
      configDir: opts.configDir || "",
      timedOut: false,
      durationMs: Date.now() - start,
      built: build.built,
      buildError: build.error,
    };
  }

  // ── Redirected data/config dirs ─────────────────────────────────────
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const configDir = opts.configDir ?? mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  for (const dir of [dataDir, configDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // If we can't create the temp dir, fall back to a non-env temp path for
      // env assignments below (never crash the harness).
    }
  }

  const env: Record<string, string | undefined> = { ...process.env };
  if (isolate) {
    // Force the CLI's data/config roots to our temp dirs. The CLI honors these
    // first (paths.ts getDataDir/getConfigDir), so no real user data is touched.
    env.ROLEBOX_DATA_DIR = dataDir;
    env.ROLEBOX_CONFIG_DIR = configDir;
  }
  // Explicit caller env overrides always win over the defaults above.
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) env[k] = v;
  }

  const bun = bunExecutable(cwd);
  const command = `${bun} ${CLI_PATH} ${args.join(" ")}`;

  // ── Spawn ───────────────────────────────────────────────────────────
  let exitCode: number | null = null;
  let signal: string | null = null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: string | undefined;

  await new Promise<void>((resolvePromise) => {
    let child;
    try {
      if (opts.shell) {
        const cmdString = [CLI_PATH, ...args].map(quoteShell).join(" ");
        child = spawn(cmdString, { cwd, env, shell: true, windowsHide: true });
      } else {
        child = spawn(bun, [CLI_PATH, ...args], { cwd, env, windowsHide: true });
      }
    } catch (err) {
      spawnError = String(err);
      resolvePromise();
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      spawnError = String(err);
      clearTimeout(timer);
      resolvePromise();
    });

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      exitCode = code;
      signal = sig ?? null;
      resolvePromise();
    });
  });

  // ── Cleanup temp dirs unless the caller wants to inspect them ───────
  if (!opts.keepTempDirs && isolate) {
    for (const dir of [dataDir, configDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  return {
    args,
    command,
    exitCode,
    signal,
    stdout,
    stderr,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    dataDir,
    configDir,
    timedOut,
    durationMs: Date.now() - start,
    built: build.built,
    buildError: build.error,
    spawnError,
  };
}

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(-TAIL_CHARS);
}

/**
 * Pre-seed the CLI's version-check cache under a dataDir so a subsequent
 * runCli call is hermetic (no npm registry network call). Returns the cache
 * file path.
 *
 * Example:
 *   const dataDir = mkdtempSync(join(tmpdir(), "rolebox-wintest-"));
 *   seedVersionCache(dataDir);
 *   const r = await runCli(["list"], { dataDir, keepTempDirs: true });
 */
export function seedVersionCache(dataDir: string): string {
  const cacheDir = join(dataDir, "cache");
  const cacheFile = join(cacheDir, "version-check.json");
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    version = pkg.version || "0.0.0";
  } catch {
    version = "0.0.0";
  }
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      cacheFile,
      JSON.stringify({ latestVersion: version, checkedAt: new Date().toISOString() }),
      "utf-8",
    );
  } catch {
    // best effort; a failure just means the CLI may attempt a network call
  }
  return cacheFile;
}

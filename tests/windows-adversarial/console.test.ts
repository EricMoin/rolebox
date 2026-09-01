// tests/windows-adversarial/console.test.ts
//
// Cluster D: console output, ANSI, interactivity.
//
// These tests drive the REAL compiled CLI (`bun dist/cli/main.js`) as a child
// process and inspect the exact bytes it writes to a PIPED stdout — i.e. the
// non-TTY / redirected condition a Windows user hits when piping `rolebox ...`
// to a file, `more`, or another program. We never assert on the CLI's logic
// (that is not our surface); we assert on the OUTPUT CONTRACT:
//
//   1. Piped (non-TTY) list/status/info must contain NO ANSI SGR sequences
//      (src/cli/format.ts colors are currently unconditional — this is the
//      suspected leak into piped output).
//   2. The same commands under NO_COLOR=1 must also be SGR-free (documents
//      whether NO_COLOR is honored at all).
//   3. cmd.exe and PowerShell wrappers (win32-only) must exit 0 and be
//      byte-identical after ANSI stripping / line-ending normalization.
//   4. Under `chcp 936` (GBK) in cmd.exe (win32-only), list/info of a role with
//      a CJK description must not mojibake — the UTF-8 bytes survive.
//   5. `rolebox install` in CI mode must emit DEGRADED line output with no
//      `\r`-overdraw artifacts (src/cli/download-progress.ts degraded branch).
//   6. `rolebox monitor --watch` with stdout piped must NOT enter the
//      alternate screen (`\x1b[?1049h`) and must exit / error actionably
//      (src/cli/commands/monitor.ts:87,93,105).
//
// Scenarios 3-4 are windows-latest-only (cmd.exe / powershell.exe are not on
// darwin); on non-win32 hosts they print an explicit skip reason and return.
// Scenarios 1-2, 5-6 run on darwin/linux (piped simulation is platform-neutral).
//
// CONTRACT: every violated assertion calls recordDefect() (which never throws)
// with file:line refs BEFORE failing, and byte-level findings carry a hex dump
// of the offending segment. We never modify production source under src/.

import { describe, test, expect, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordDefect } from "./helpers/evidence";
import { REPO_ROOT } from "./helpers/evidence";
import { runCli, seedVersionCache } from "./helpers/cli";

// ── Scenario constants ──────────────────────────────────────────────

const CLUSTER = "console";

/** ANSI SGR (Select Graphic Rendition) escape — `ESC [ digits ; digits m`. */
const ANSI_SGR = /\x1b\[[0-9;]*m/;
const ANSI_SGR_G = /\x1b\[[0-9;]*m/g;
/** Alternate-screen-buffer enter/leave (monitor watch mode). */
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";
/** Any raw CSI/ESC byte, for a broader leak signal. */
const ANY_ESC_G = /\x1b/g;
/** Carriage-return — the byte that an interactive bar redraw uses to overwrite. */
const CR_RE = /\r/g;

const REGISTRY_NAME = "oh-my-role";
const DEFAULT_REGISTRY_URL = "https://github.com/EricMoin/oh-my-role";
const MISSING_REGISTRY_URL = "https://github.com/rolebox-campaign/__console_campaign_missing__";
const ROLE_ID = "software-architect";
const CJK_ROLE_ID = "cjk-role";
const CJK_DESC = "架构师角色，负责系统设计";
const CLI_PATH = join(REPO_ROOT, "dist", "cli", "main.js");

const CONFIG_YAML = [
  "registries:",
  `  - name: ${REGISTRY_NAME}`,
  `    url: ${DEFAULT_REGISTRY_URL}`,
  "    default: true",
].join("\n") + "\n";

const LOCK_YAML = [
  "version: 1",
  "roles:",
  `  - role: ${ROLE_ID}`,
  `    registry: ${REGISTRY_NAME}`,
  '    version: "1.0.0"',
  '    installedAt: "2026-01-01T00:00:00.000Z"',
  '    integrity: "sha256-abc"',
  `  - role: ${CJK_ROLE_ID}`,
  `    registry: ${REGISTRY_NAME}`,
  '    version: "1.0.0"',
  '    installedAt: "2026-01-01T00:00:00.000Z"',
  '    integrity: "sha256-xyz"',
].join("\n") + "\n";

const ROLE_YAML = [
  "name: Software Architect",
  "description: Designs systems",
  "model: claude",
].join("\n") + "\n";

const CJK_ROLE_YAML = [
  "name: CJK Role",
  `description: "${CJK_DESC}"`,
].join("\n") + "\n";

// ── Temp dir bookkeeping ────────────────────────────────────────────

const cleanupDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// ── Sandbox ─────────────────────────────────────────────────────────

interface Sandbox {
  dataDir: string;
  configDir: string;
  projectDir: string;
}

/**
 * Build a hermetic sandbox: config.yaml + rolebox.lock (two roles, incl. a CJK
 * one), the on-disk role dirs (so `info` renders descriptions), and a fresh
 * version-check cache (so cleanup() makes no npm network call).
 */
function makeSandbox(opts: { missingRegistry?: boolean } = {}): Sandbox {
  const dataDir = mkTmp("rbw-console-data-");
  const configDir = mkTmp("rbw-console-config-");
  const projectDir = mkTmp("rbw-console-proj-");
  mkdirSync(join(configDir, "cache"), { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    opts.missingRegistry
      ? CONFIG_YAML.replace(DEFAULT_REGISTRY_URL, MISSING_REGISTRY_URL)
      : CONFIG_YAML,
    "utf-8",
  );
  writeFileSync(join(configDir, "rolebox.lock"), LOCK_YAML, "utf-8");

  const roleDir = join(dataDir, "roles", REGISTRY_NAME, `${ROLE_ID}@1.0.0`);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), ROLE_YAML, "utf-8");
  const cjkRoleDir = join(dataDir, "roles", REGISTRY_NAME, `${CJK_ROLE_ID}@1.0.0`);
  mkdirSync(cjkRoleDir, { recursive: true });
  writeFileSync(join(cjkRoleDir, "role.yaml"), CJK_ROLE_YAML, "utf-8");

  seedVersionCache(dataDir);
  return { dataDir, configDir, projectDir };
}

/** Seed the registry manifest cache so `fetchRegistryManifest` is hermetic
 *  (no raw.githubusercontent.com call) and resolving/verifying phases emit. */
function seedRegistryCache(dataDir: string, url: string, roleId: string): void {
  const cacheDir = join(dataDir, "cache", REGISTRY_NAME);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "registry.yaml"),
    [
      `name: ${REGISTRY_NAME}`,
      "description: campaign test registry",
      `url: ${url}`,
      "roles:",
      `  ${roleId}:`,
      "    version: 1.0.0",
      "    description: demo role",
      "    tags: []",
    ].join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(join(cacheDir, ".timestamp"), new Date().toISOString(), "utf-8");
}

// ── Byte-level helpers ──────────────────────────────────────────────

function hexBytes(buf: Buffer): string {
  return buf.toString("hex").replace(/(..)/g, "$1 ").trim();
}

/** Hex-dump a window of `stdout` centred on a matched offset (offending segment). */
function hexContext(stdout: string, matchOffset: number, span = 24): string {
  const start = Math.max(0, matchOffset - 6);
  const end = Math.min(stdout.length, matchOffset + span);
  return hexBytes(Buffer.from(stdout.slice(start, end), "utf-8"));
}

/** Strip SGR + normalise CRLF→LF, for "semantic" byte comparison. */
function normalizeForCompare(s: string): string {
  return s.replace(ANSI_SGR_G, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ── Windows-shell runners (win32-only scenarios) ────────────────────

interface ShellResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stdoutBuf: Buffer;
  stderr: string;
}

/** Run an external shell wrapper (cmd.exe / powershell.exe) and capture raw bytes. */
function runShell(
  exe: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  timeoutMs: number,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(exe, args, { cwd, env, windowsHide: true, shell: false });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        timedOut,
        stdout: "",
        stdoutBuf: Buffer.alloc(0),
        stderr: String(err),
      });
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
    child.stdout?.on("data", (c) => chunks.push(Buffer.from(c)));
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        timedOut,
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stdoutBuf: Buffer.concat(chunks),
        stderr: stderr + String(err),
      });
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      resolve({
        code,
        signal: sig ?? null,
        timedOut,
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stdoutBuf: Buffer.concat(chunks),
        stderr,
      });
    });
  });
}

/** Build the isolated env a shell wrapper must propagate to the CLI. */
function shellEnv(dataDir: string, configDir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    ROLEBOX_DATA_DIR: dataDir,
    ROLEBOX_CONFIG_DIR: configDir,
    ...extra,
  };
}

/** Quote a Windows command-line token (double quotes; cmd & powershell agree). */
function winQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ── Scenario 1: piped (non-TTY) → no ANSI SGR ───────────────────────

describe("Cluster D: console output / ANSI / interactivity", () => {
  test("scenario-1: list/status/info with stdout PIPED emit no ANSI SGR bytes", async () => {
    const sb = makeSandbox();
    const commands: string[][] = [
      ["list"],
      ["status"],
      ["info", ROLE_ID],
    ];
    const violations: string[] = [];

    for (const args of commands) {
      const r = await runCli(args, {
        dataDir: sb.dataDir,
        configDir: sb.configDir,
        keepTempDirs: true,
        timeout: 30_000,
      });
      // runCli spawns with `stdio: pipe` → the child sees non-TTY, so a
      // piped output contract is exercised exactly. No explicit redirection.
      const matches = r.stdout.match(ANSI_SGR_G) ?? [];
      if (matches.length > 0) {
        const first = matches[0]!;
        const offset = r.stdout.indexOf(first);
        recordDefect("piped-ansi-sgr-leak", {
          scenario: `\`rolebox ${args.join(" ")}\` with stdout piped (non-TTY)`,
          command: r.command,
          expected: "no ANSI SGR escape bytes in piped stdout",
          actual:
            `${matches.length} SGR seq(s) leaked; first=${JSON.stringify(first)}; ` +
            `context_hex=${hexContext(r.stdout, offset)}; ` +
            `any_esc_bytes=${(r.stdout.match(ANY_ESC_G) ?? []).length}; ` +
            `exit=${r.exitCode}; stdout_len=${r.stdout.length}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: [
            "src/cli/format.ts:13-28",
            "src/cli/commands/status.ts:19-35",
            "src/cli/commands/info.ts:13-29",
          ],
          cluster: CLUSTER,
        });
        violations.push(
          `\`rolebox ${args.join(" ")}\`: ${matches.length} SGR seq(s) detected; first=${JSON.stringify(first)}; exit=${r.exitCode}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 2: NO_COLOR=1 → no SGR ───────────────────────────────

  test("scenario-2: list/status/info under NO_COLOR=1 emit no ANSI SGR bytes", async () => {
    const sb = makeSandbox();
    const commands: string[][] = [
      ["list"],
      ["status"],
      ["info", ROLE_ID],
    ];
    const violations: string[] = [];

    for (const args of commands) {
      const r = await runCli(args, {
        dataDir: sb.dataDir,
        configDir: sb.configDir,
        keepTempDirs: true,
        timeout: 30_000,
        env: { NO_COLOR: "1" },
      });
      const matches = r.stdout.match(ANSI_SGR_G) ?? [];
      if (matches.length > 0) {
        const first = matches[0]!;
        const offset = r.stdout.indexOf(first);
        recordDefect("no-color-not-honored", {
          scenario: `\`rolebox ${args.join(" ")}\` with NO_COLOR=1 and stdout piped`,
          command: r.command,
          expected: "NO_COLOR suppresses ANSI color -> no SGR in stdout",
          actual:
            `${matches.length} SGR seq(s) still emitted under NO_COLOR=1; first=${JSON.stringify(first)}; ` +
            `context_hex=${hexContext(r.stdout, offset)}; exit=${r.exitCode}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: [
            "src/cli/format.ts:13-28",
            "src/cli/commands/status.ts:19-35",
            "src/cli/commands/info.ts:13-29",
          ],
          cluster: CLUSTER,
        });
        violations.push(
          `\`rolebox ${args.join(" ")}\`: ${matches.length} SGR seq(s) under NO_COLOR=1; first=${JSON.stringify(first)}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 3: cmd.exe / PowerShell (win32-only) ─────────────────

  test("scenario-3: cmd.exe and powershell produce byte-identical semantic output (plain `list`)", async () => {
    if (process.platform !== "win32") {
      console.log(
        `SKIP scenario-3: cmd.exe / powershell.exe unavailable on ${process.platform} (windows-latest-only). ` +
          `Reproduces as \`cmd /c bun dist/cli/main.js list\` and \`powershell -Command "bun dist/cli/main.js list"\`.`,
      );
      return;
    }

    const sb = makeSandbox();
    const env = shellEnv(sb.dataDir, sb.configDir);
    // Baseline: direct bun spawn (no shell wrapper).
    const baseline = await runCli(["list"], {
      dataDir: sb.dataDir,
      configDir: sb.configDir,
      keepTempDirs: true,
      timeout: 30_000,
    });

    const cmdLine = `${winQuote(process.execPath)} ${winQuote(CLI_PATH)} list`;
    const cmdRun = await runShell("cmd.exe", ["/c", cmdLine], env, REPO_ROOT, 30_000);
    const psRun = await runShell("powershell.exe", ["-Command", cmdLine], env, REPO_ROOT, 30_000);

    const baseNorm = normalizeForCompare(baseline.stdout);
    const cmdNorm = normalizeForCompare(cmdRun.stdout);
    const psNorm = normalizeForCompare(psRun.stdout);

    const sameSemantics = cmdNorm === psNorm && cmdNorm === baseNorm;
    if (!sameSemantics) {
      recordDefect("shell-output-divergence", {
        scenario: "cmd.exe /c and powershell -Command wrapping `rolebox list`",
        command: `cmd /c "bun ${CLI_PATH} list" | powershell -Command "bun ${CLI_PATH} list"`,
        expected:
          "cmd and powershell wrappers exit 0 and produce byte-identical output after ANSI stripping / CRLF normalization",
        actual:
          `cmd_exit=${cmdRun.code}; ps_exit=${psRun.code}; base_exit=${baseline.exitCode}; ` +
          `equal=${sameSemantics}; ` +
          `cmd_len=${cmdNorm.length}, ps_len=${psNorm.length}, base_len=${baseNorm.length}`,
        exit_code: cmdRun.code ?? baseline.exitCode,
        stdout_tail: normalizeForCompare(cmdRun.stdout).slice(-2000),
        stderr_tail: (cmdRun.stderr + psRun.stderr).slice(-2000),
        file_line_refs: ["src/cli/main.ts:38-52"],
        cluster: CLUSTER,
      });
    }

    expect(sameSemantics).toBe(true);
    expect(cmdRun.code).toBe(0);
    expect(psRun.code).toBe(0);
  });

  // ── Scenario 4: chcp 936 (GBK) codepage → no mojibake (win32-only) ─

  test("scenario-4: rolebox list/info under cmd chcp 936 (GBK) preserves UTF-8 CJK (no mojibake)", async () => {
    if (process.platform !== "win32") {
      console.log(
        `SKIP scenario-4: chcp 936 / cmd.exe unavailable on ${process.platform} (windows-latest-only). ` +
          `Reproduces as \`cmd /c "chcp 936 >nul && bun dist/cli/main.js info cjk-role"\` and compares UTF-8 bytes.`,
      );
      return;
    }

    const sb = makeSandbox();
    const env = shellEnv(sb.dataDir, sb.configDir);
    const expectedCjk = Buffer.from(CJK_DESC, "utf-8");
    const violations: string[] = [];

    const cases: Array<{ label: string; cliArgs: string }> = [
      { label: "list", cliArgs: "list" },
      { label: `info ${CJK_ROLE_ID}`, cliArgs: `info ${CJK_ROLE_ID}` },
    ];

    for (const c of cases) {
      const cmdLine = `chcp 936 >nul && ${winQuote(process.execPath)} ${winQuote(CLI_PATH)} ${c.cliArgs}`;
      const r = await runShell("cmd.exe", ["/c", cmdLine], env, REPO_ROOT, 30_000);

      // No mojibake: the exact UTF-8 bytes of the CJK description must appear.
      const includesCjk = r.stdoutBuf.includes(expectedCjk);
      // Also require a clean exit (0) — chcp must not break the run.
      const exitOk = r.code === 0;

      if (!includesCjk || !exitOk) {
        recordDefect("gbk-codepage-mojibake", {
          scenario: `\`chcp 936\` (GBK) then \`rolebox ${c.cliArgs}\` with a CJK description`,
          command: cmdLine,
          expected:
            "UTF-8 bytes of the CJK description survive a GBK console codepage; exit 0",
          actual:
            `includes_utf8_cjk=${includesCjk}; exit=${r.code}; ` +
            `stdout_hex=${hexContext(r.stdout, 0, 48)}; ` +
            `expected_cjk_hex=${hexBytes(expectedCjk)}`,
          exit_code: r.code,
          stdout_tail: r.stdout.slice(-2000),
          stderr_tail: r.stderr.slice(-2000),
          file_line_refs: ["src/cli/commands/info.ts:1-8", "src/cli/commands/list.ts:7-25"],
          cluster: CLUSTER,
        });
        violations.push(
          `\`chcp 936\` + \`rolebox ${c.cliArgs}\`: includes_utf8_cjk=${includesCjk}; exit=${r.code}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 5: download progress in CI mode → degraded, no \r ────

  test("scenario-5: download progress in CI mode emits degraded lines with no CR-overdraw artifacts", async () => {
    const sb = makeSandbox({ missingRegistry: true });
    // Seed the registry manifest cache so resolving/verifying phases are
    // hermetic; the tarball then 404s (or network-errors) fast, which still
    // exercises the degraded progress renderer.
    seedRegistryCache(sb.dataDir, MISSING_REGISTRY_URL, ROLE_ID);

    const r = await runCli(["install", ROLE_ID], {
      dataDir: sb.dataDir,
      configDir: sb.configDir,
      keepTempDirs: true,
      // Bounded well under bun's default 5000ms per-test timeout so our
      // assertions run even if the (deliberately missing) registry tarball
      // request stalls. The degraded "resolving"/"downloading" lines are
      // emitted before any network call, so the no-`\r` inspection holds
      // whether the download 404s fast or is killed mid-flight.
      timeout: 4_000,
      env: { CI: "1" },
    });

    const crCount = (r.stdout.match(CR_RE) ?? []).length;
    const sgrCount = (r.stdout.match(ANSI_SGR_G) ?? []).length;
    const hasDegradedLines = /resolving/.test(r.stdout) || /downloading/.test(r.stdout);
    const violations: string[] = [];

    // A degraded renderer must never overwrite a line with `\r`.
    if (crCount > 0) {
      recordDefect("ci-mode-cr-overdraw", {
        scenario: "`rolebox install` in CI mode (CI=1, piped stdout) using DownloadProgress",
        command: r.command,
        expected:
          "degraded line-based output with NO `\\r`-overdraw bytes in the captured log",
        actual:
          `${crCount} carriage-return byte(s) found in stdout; degraded_lines=${hasDegradedLines}; ` +
          `first_cr_hex=${hexContext(r.stdout, r.stdout.indexOf("\r"))}; exit=${r.exitCode}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: [
          "src/cli/download-progress.ts:130",
          "src/cli/download-progress.ts:140-141",
          "src/cli/download-progress.ts:252-254",
        ],
        cluster: CLUSTER,
      });
      violations.push(`${crCount} CR byte(s) in CI-mode install stdout`);
    }

    // Degraded mode must also be color-free (SGR only appears in interactive mode).
    if (sgrCount > 0) {
      recordDefect("ci-mode-ansi-sgr", {
        scenario: "`rolebox install` in CI mode (CI=1, piped stdout) using DownloadProgress",
        command: r.command,
        expected: "degraded renderer suppresses ANSI color (useColor=false)",
        actual: `${sgrCount} SGR sequence(s) leaked into degraded CI output; exit=${r.exitCode}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/download-progress.ts:143"],
        cluster: CLUSTER,
      });
      violations.push(`${sgrCount} SGR sequence(s) in CI-mode install stdout`);
    }

    // The download progress must actually have run (degraded lines present).
    if (!hasDegradedLines) {
      recordDefect("ci-mode-no-progress-lines", {
        scenario: "`rolebox install` in CI mode (CI=1, piped stdout) using DownloadProgress",
        command: r.command,
        expected: "degraded phase lines (resolving/downloading) emitted",
        actual: `no resolving/downloading line in stdout; exit=${r.exitCode}; stderr=${r.stderrTail.slice(-300)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/install.ts:118-119", "src/cli/commands/install.ts:147"],
        cluster: CLUSTER,
      });
      violations.push("no degraded progress lines in CI-mode install stdout");
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 6: monitor --watch piped → no alt-screen, actionable ──

  test("scenario-6: `rolebox monitor --watch` with stdout piped must not emit alt-screen and must exit/error actionably", async () => {
    const sb = makeSandbox();
    // Bounded: watch mode is an infinite loop; we kill it well under bun's
    // default 5000ms per-test timeout so our assertions run before the test
    // harness itself kills us. The alt-screen escape is written immediately
    // (monitor.ts:87) before the first loop iteration, so a short window is
    // enough to observe the leak.
    const r = await runCli(["monitor", "--watch"], {
      cwd: sb.projectDir,
      dataDir: sb.dataDir,
      configDir: sb.configDir,
      keepTempDirs: true,
      timeout: 2_500,
    });

    const violations: string[] = [];

    // (a) Alt-screen enter MUST NOT be written when stdout is a pipe.
    const leakedEnter = r.stdout.includes(ALT_SCREEN_ENTER);
    if (leakedEnter) {
      recordDefect("monitor-alt-screen-in-pipe", {
        scenario: "`rolebox monitor --watch` with stdout piped (non-TTY)",
        command: r.command,
        expected: "monitor --watch detects non-TTY and does NOT write `\\x1b[?1049h` (alt-screen) into the pipe",
        actual:
          `alt_screen_enter_hex=${hexContext(r.stdout, r.stdout.indexOf(ALT_SCREEN_ENTER), 16)}; ` +
          `alt_screen_leave_present=${r.stdout.includes(ALT_SCREEN_LEAVE)}; ` +
          `exit=${r.exitCode}; timed_out=${r.timedOut}; ` +
          `sgr_count=${(r.stdout.match(ANSI_SGR_G) ?? []).length}; stdout_len=${r.stdout.length}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/monitor.ts:87", "src/cli/commands/monitor.ts:93", "src/cli/commands/monitor.ts:105"],
        cluster: CLUSTER,
      });
      violations.push(
        `alt-screen enter written to pipe; alt_screen_leave_present=${r.stdout.includes(ALT_SCREEN_LEAVE)}; exit=${r.exitCode}`,
      );
    }

    // (b) It must exit on its own OR print an actionable non-TTY error.
    //     A well-behaved CLI that can't draw an interactive dashboard should
    //     exit (code 0/1) or say "monitor --watch requires a TTY". Hanging in
    //     the loop after writing alt-screen into a pipe is a defect.
    const actionableError = /requires a tty|not a tty|not a terminal|--watch requires|stdout is not a tty/i.test(
      r.stderr + "\n" + r.stdout,
    );
    const exitedCleanly = r.exitCode !== null;
    if (!actionableError && !exitedCleanly) {
      recordDefect("monitor-pipe-no-actionable-exit", {
        scenario: "`rolebox monitor --watch` with stdout piped (non-TTY)",
        command: r.command,
        expected: "monitor --watch exits or prints an actionable non-TTY error instead of hanging",
        actual:
          `exit=${r.exitCode} (null => killed by timeout); timed_out=${r.timedOut}; ` +
          `actionable_error=${actionableError}; ` +
          `alt_screen_leave_present=${r.stdout.includes(ALT_SCREEN_LEAVE)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/monitor.ts:82-97"],
        cluster: CLUSTER,
      });
      violations.push(
        `monitor --watch hung on non-TTY (exit=${r.exitCode}, no actionable error); alt_screen_leave_present=${r.stdout.includes(ALT_SCREEN_LEAVE)}`,
      );
    }

    // If it entered the alt screen but was killed before leaving it, that is an
    // additional (dangling terminal state) defect worth flagging.
    if (leakedEnter && !r.stdout.includes(ALT_SCREEN_LEAVE)) {
      recordDefect("monitor-alt-screen-dangling", {
        scenario: "`rolebox monitor --watch` with stdout piped (non-TTY)",
        command: r.command,
        expected: "if alt-screen were used, SIGKILL/exit would still leave the buffer (write `\\x1b[?1049l`)",
        actual:
          `alt-screen entered but never left in captured stdout (leave-present=${r.stdout.includes(ALT_SCREEN_LEAVE)}); exit=${r.exitCode}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/monitor.ts:87", "src/cli/commands/monitor.ts:93"],
        cluster: CLUSTER,
      });
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 7: TERM=dumb → no SGR (the format.ts unconditional-color defect) ──

  test("scenario-7: list/status/info with TERM=dumb emit no ANSI SGR bytes", async () => {
    const sb = makeSandbox();
    const commands: string[][] = [
      ["list"],
      ["status"],
      ["info", ROLE_ID],
    ];
    const violations: string[] = [];

    for (const args of commands) {
      const r = await runCli(args, {
        dataDir: sb.dataDir,
        configDir: sb.configDir,
        keepTempDirs: true,
        timeout: 30_000,
        env: { TERM: "dumb" },
      });
      const matches = r.stdout.match(ANSI_SGR_G) ?? [];
      if (matches.length > 0) {
        const first = matches[0]!;
        const offset = r.stdout.indexOf(first);
        recordDefect("term-dumb-sgr-leak", {
          scenario: `\`rolebox ${args.join(" ")}\` with TERM=dumb and stdout piped`,
          command: r.command,
          expected: "TERM=dumb (equates to no color) suppresses ANSI SGR",
          actual:
            `${matches.length} SGR seq(s) still emitted with TERM=dumb; first=${JSON.stringify(first)}; ` +
            `context_hex=${hexContext(r.stdout, offset)}; exit=${r.exitCode}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: ["src/cli/format.ts:13-28"],
          cluster: CLUSTER,
        });
        violations.push(
          `\`rolebox ${args.join(" ")}\`: ${matches.length} SGR seq(s) under TERM=dumb; first=${JSON.stringify(first)}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 8: TERM empty / unset → no SGR ──────────────────────────

  test("scenario-8: list/status/info with TERM empty emit no ANSI SGR bytes", async () => {
    const sb = makeSandbox();
    const commands: string[][] = [
      ["list"],
      ["status"],
      ["info", ROLE_ID],
    ];
    const violations: string[] = [];

    for (const args of commands) {
      const r = await runCli(args, {
        dataDir: sb.dataDir,
        configDir: sb.configDir,
        keepTempDirs: true,
        timeout: 30_000,
        env: { TERM: "" },
      });
      const matches = r.stdout.match(ANSI_SGR_G) ?? [];
      if (matches.length > 0) {
        const first = matches[0]!;
        const offset = r.stdout.indexOf(first);
        recordDefect("term-empty-sgr-leak", {
          scenario: `\`rolebox ${args.join(" ")}\` with TERM empty (unset) and stdout piped`,
          command: r.command,
          expected: "TERM empty (no terminal capability) suppresses ANSI SGR",
          actual:
            `${matches.length} SGR seq(s) still emitted with TERM empty; first=${JSON.stringify(first)}; ` +
            `context_hex=${hexContext(r.stdout, offset)}; exit=${r.exitCode}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: ["src/cli/format.ts:13-28"],
          cluster: CLUSTER,
        });
        violations.push(
          `\`rolebox ${args.join(" ")}\`: ${matches.length} SGR seq(s) with TERM empty; first=${JSON.stringify(first)}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 9: NO_COLOR + FORCE_COLOR precedence (common CI footgun) ──

  test("scenario-9: NO_COLOR=1 + FORCE_COLOR=1 → NO_COLOR wins, no ANSI SGR", async () => {
    // Documented precedence: an explicit opt-out (NO_COLOR) must win over an
    // opt-in (FORCE_COLOR). A Windows CI that exports both must not recolorize.
    const sb = makeSandbox();
    const commands: string[][] = [
      ["list"],
      ["status"],
      ["info", ROLE_ID],
    ];
    const violations: string[] = [];

    for (const args of commands) {
      const r = await runCli(args, {
        dataDir: sb.dataDir,
        configDir: sb.configDir,
        keepTempDirs: true,
        timeout: 30_000,
        env: { NO_COLOR: "1", FORCE_COLOR: "1" },
      });
      const matches = r.stdout.match(ANSI_SGR_G) ?? [];
      if (matches.length > 0) {
        const first = matches[0]!;
        const offset = r.stdout.indexOf(first);
        recordDefect("no-color-force-color-precedence", {
          scenario: `\`rolebox ${args.join(" ")}\` with NO_COLOR=1 AND FORCE_COLOR=1 both set and stdout piped`,
          command: r.command,
          expected: "NO_COLOR (explicit opt-out) takes precedence over FORCE_COLOR → no SGR",
          actual:
            `${matches.length} SGR seq(s) still emitted; first=${JSON.stringify(first)}; ` +
            `context_hex=${hexContext(r.stdout, offset)}; exit=${r.exitCode}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: ["src/cli/format.ts:13-28", "src/cli/config.ts"],
          cluster: CLUSTER,
        });
        violations.push(
          `\`rolebox ${args.join(" ")}\`: ${matches.length} SGR seq(s) despite NO_COLOR=1; first=${JSON.stringify(first)}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // ── Scenario 10: chcp 437 (US-ASCII) codepage → no corruption (win32-only) ──

  test("scenario-10: rolebox list under cmd chcp 437 preserves a plain ASCII role name (no corruption)", async () => {
    if (process.platform !== "win32") {
      console.log(
        `SKIP scenario-10: chcp 437 / cmd.exe unavailable on ${process.platform} (windows-latest-only). ` +
          `Reproduces as \`cmd /c "chcp 437 >nul && bun dist/cli/main.js list"\` and asserts the ASCII role id survives intact.`,
      );
      return;
    }

    const sb = makeSandbox();
    const env = shellEnv(sb.dataDir, sb.configDir);
    const expectedAscii = Buffer.from(ROLE_ID, "utf-8");
    const cmdLine = `chcp 437 >nul && ${winQuote(process.execPath)} ${winQuote(CLI_PATH)} list`;
    const r = await runShell("cmd.exe", ["/c", cmdLine], env, REPO_ROOT, 30_000);

    // Locks the GBK defect (scenario-4) to non-ASCII content only: under a plain
    // US-ASCII codepage a pure-ASCII role id must survive byte-for-byte.
    const includesAscii = r.stdoutBuf.includes(expectedAscii);
    const exitOk = r.code === 0;
    if (!includesAscii || !exitOk) {
      recordDefect("chp437-ascii-corruption", {
        scenario: "`chcp 437` then `rolebox list` with a plain ASCII role id",
        command: cmdLine,
        expected: "ASCII role id bytes survive a 437 (US-ASCII) codepage; exit 0",
        actual:
          `includes_ascii=${includesAscii}; exit=${r.code}; ` +
          `stdout_hex=${hexContext(r.stdout, 0, 48)}; stdout_len=${r.stdout.length}`,
        exit_code: r.code,
        stdout_tail: r.stdout.slice(-2000),
        stderr_tail: r.stderr.slice(-2000),
        file_line_refs: ["src/cli/commands/list.ts:7-25", "src/cli/commands/info.ts:1-8"],
        cluster: CLUSTER,
      });
      throw new Error(`[console] chcp 437 ASCII corruption: includes_ascii=${includesAscii}; exit=${r.code}`);
    }
  });
});

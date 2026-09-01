// tests/windows-adversarial/env.test.ts
//
// Subtask 7 — Cluster F: config & environment resolution.
//
// This file drives the rolebox CLI's environment / homedir / encoding
// resolution surface and records discovered Windows defects as JSONL evidence.
// It NEVER modifies production source under src/ — src modules are only
// imported (read-only) to observe path resolution, and the compiled CLI is
// spawned as a real child process via the subtask-1 harness (helpers/cli.ts).
//
// ── Layered strategy (cross-platform) ─────────────────────────────
// * The win32 branches of getDataDir/getConfigDir (src/cli/paths.ts:66-124)
//   are exercised in-process via the test-only seam setPlatformForTest("win32")
//   with injected env — this runs on ANY host and is what verifies the
//   fallback/normalization logic on darwin.
// * The compiled CLI is spawned through runCli() as a real child process for
//   the "does the command crash / exit 0" half of each scenario. On
//   windows-latest this spawns a true win32 process and exercises the real
//   APPDATA/LOCALAPPDATA/homedir resolution end-to-end (isolateDirs:false).
// * Scenario 3 (env-var name casing) is Windows-only: POSIX env is
//   case-sensitive by design, so it is skipped on darwin.
// * Scenario 6 (opencode Windows config location) is research on every host.
//
// ── Hermeticity ───────────────────────────────────────────────────
// The harness force-redirects ROLEBOX_DATA_DIR / ROLEBOX_CONFIG_DIR to per-test
// temp dirs (isolateDirs:true by default), and we pre-seed the version-check
// cache so checkForUpdate() never hits the npm registry. Only the flagged
// win32 fallback runs (isolateDirs:false) deliberately point HOME/USERPROFILE
// at a throwaway temp dir so the CLI resolves into temp, never real user data.

import { describe, it, expect, afterAll } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import {
  recordDefect,
  EVIDENCE_ROOT,
  REPO_ROOT,
} from "./helpers/evidence";
import {
  runCli,
  seedVersionCache,
  type CliResult,
  type CliOpts,
} from "./helpers/cli";

// Production path modules — READ-ONLY. We observe their behavior, never edit.
import {
  getDataDir,
  getConfigDir,
  setPlatformForTest,
} from "../../src/cli/paths.ts";
import {
  defaultPlatformPaths,
  piPlatformPaths,
  dshPlatformPaths,
} from "../../src/platform/paths.ts";

const IS_WIN = process.platform === "win32";
const CLUSTER = "env";
const PREV_CLUSTER = process.env.ROLEBOX_CAMPAIGN_CLUSTER;
process.env.ROLEBOX_CAMPAIGN_CLUSTER = CLUSTER;

// ── Source refs (kept in sync with src/) ──────────────────────────
const REFS_DATA_DIR_FALLBACK = ["src/cli/paths.ts:76"];
const REFS_CONFIG_DIR_FALLBACK = ["src/cli/paths.ts:109"];
const REFS_OVERRIDE_RAW = ["src/cli/paths.ts:66-67", "src/cli/paths.ts:99-100"];
const REFS_PI = ["src/platform/paths.ts:59-61"];
const REFS_DSH = ["src/platform/paths.ts:86-88"];
const REFS_OPENCODE = ["src/platform/paths.ts:32-36"];

// ── Temp-dir registry for afterAll cleanup ───────────────────────
const TMP_DIRS: string[] = [];
function tmpName(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}
function bestRm(p?: string): void {
  if (!p) return;
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort — a leak in tmp is harmless */
  }
}

// ── Env snapshot/restore ──────────────────────────────────────────
// The in-process sim mutates process.env; we must restore it exactly so tests
// do not leak into one another (bun runs tests in a file sequentially).
const ENV_KEYS = [
  "APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
  "ROLEBOX_DATA_DIR", "ROLEBOX_CONFIG_DIR", "PI_CODING_AGENT_DIR", "DSH_HOME",
  "HOME", "USERPROFILE", "rolebox_data_dir", "rolebox_config_dir",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = s[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Remove every path-override / fallback env var so resolution starts clean. */
function clearPathOverrides(): void {
  delete process.env.ROLEBOX_DATA_DIR;
  delete process.env.ROLEBOX_CONFIG_DIR;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  delete process.env.LOCALAPPDATA;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.DSH_HOME;
}

/**
 * Run fn under the win32 platform sim with the given env patch. Restores the
 * platform override and process.env in `finally`, so nothing leaks.
 */
function withWin32Sim(
  envPatch: Record<string, string | undefined>,
  fn: () => void,
): void {
  const save = snapshotEnv();
  try {
    setPlatformForTest("win32");
    clearPathOverrides();
    for (const [k, v] of Object.entries(envPatch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    setPlatformForTest(undefined);
    restoreEnv(save);
  }
}

// ── Defect recorder (record, then fail) ───────────────────────────
interface DefectCtx {
  testId: string;
  scenario: string;
  command: string;
  expected: string;
  actual: string;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  fileLineRefs: string[];
  severity?: string;
}

/** Append the defect to the evidence ledger, then throw so the test goes red. */
function recordAndFail(ctx: DefectCtx): never {
  recordDefect(ctx.testId, {
    scenario: ctx.scenario,
    command: ctx.command,
    expected: ctx.expected,
    actual: ctx.actual,
    exit_code: ctx.exitCode ?? null,
    stdout_tail: ctx.stdoutTail ?? "",
    stderr_tail: ctx.stderrTail ?? "",
    file_line_refs: ctx.fileLineRefs,
    cluster: CLUSTER,
  });
  throw new Error(
    `[env] DEFECT recorded (${ctx.testId}, severity=${ctx.severity ?? "unrated"}): ` +
      `${ctx.expected} -- but observed ${ctx.actual}`,
  );
}

/** Append a documented-behavior finding that passed (the ledger records it too). */
function recordPass(testId: string, ctx: {
  scenario: string;
  command: string;
  expected: string;
  actual: string;
  fileLineRefs: string[];
}): void {
  recordDefect(testId, {
    scenario: ctx.scenario,
    command: ctx.command,
    expected: ctx.expected,
    actual: ctx.actual,
    exit_code: 0,
    stdout_tail: "",
    stderr_tail: "",
    file_line_refs: ctx.fileLineRefs,
    cluster: CLUSTER,
  });
}

// ── Hermetic child-run helpers ────────────────────────────────────
async function runCliHermetic(args: string[], opts: CliOpts = {}): Promise<CliResult> {
  const dataDir = tmpName("rb-wintest-data-");
  const configDir = tmpName("rb-wintest-config-");
  seedVersionCache(dataDir);
  TMP_DIRS.push(dataDir, configDir);
  return runCli(args, {
    dataDir,
    configDir,
    keepTempDirs: true,
    timeout: 30_000,
    ...opts,
  });
}

function cleanDirs(r: CliResult): void {
  bestRm(r.dataDir);
  bestRm(r.configDir);
}

function parseStatusJson(r: CliResult): { configPath?: string; version?: string } {
  try {
    const j = JSON.parse(r.stdout);
    return { configPath: j.config?.path, version: j.version };
  } catch {
    return {};
  }
}

// ── Windows-style path normalize for the encoding comparison ──────
// Mirrors how Win32 treats separators: `/` ≡ `\`, and a trailing `\` is
// insignificant. It does NOT strip quotes — quotes are invalid on Windows, so
// retaining them is precisely the defect signal.
function winNormalize(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/\\+$/, "");
}

// ─────────────────────────────────────────────────────────────────

describe("windows-adversarial: cluster env (config + environment resolution)", () => {
  afterAll(() => {
    if (PREV_CLUSTER === undefined) delete process.env.ROLEBOX_CAMPAIGN_CLUSTER;
    else process.env.ROLEBOX_CAMPAIGN_CLUSTER = PREV_CLUSTER;
    for (const d of TMP_DIRS) bestRm(d);
  });

  // ── Scenario 1 ──────────────────────────────────────────────────
  it("S1: APPDATA/LOCALAPPDATA unset -> homedir() fallback works, no crash", async () => {
    // (a) In-process win32 sim: with both fallback vars unset, getDataDir /
    //     getConfigDir must resolve to {homedir()/AppData/Local|Roaming}/rolebox.
    withWin32Sim({}, () => {
      const expectedData = join(homedir(), "AppData", "Local", "rolebox");
      const expectedConfig = join(homedir(), "AppData", "Roaming", "rolebox");
      const data = getDataDir();
      const config = getConfigDir();
      if (data !== expectedData || config !== expectedConfig) {
        recordAndFail({
          testId: "s1-homedir-fallback-sim",
          scenario:
            "win32 fallback to homedir() when APPDATA/LOCALAPPDATA are unset",
          command:
            "getDataDir()+getConfigDir() under setPlatformForTest('win32') with APPDATA/LOCALAPPDATA unset",
          expected: `data=${expectedData} config=${expectedConfig}`,
          actual: `data=${data} config=${config}`,
          fileLineRefs: [...REFS_DATA_DIR_FALLBACK, ...REFS_CONFIG_DIR_FALLBACK],
          severity: "high",
        });
      }
      expect(data).toBe(expectedData);
      expect(config).toBe(expectedConfig);
    });

    // (b) `rolebox list` must exit 0 and not crash (config-dir resolution).
    const list = await runCliHermetic(["list"]);
    if (list.spawnError || list.timedOut || list.exitCode !== 0) {
      recordAndFail({
        testId: "s1-list-no-crash",
        scenario: "`rolebox list` after APPDATA/LOCALAPPDATA unset (win32 fallback)",
        command: list.command,
        expected: "exit 0, no crash",
        actual: `exit=${list.exitCode} timedOut=${list.timedOut} spawnError=${list.spawnError} stderr=${list.stderrTail}`,
        exitCode: list.exitCode,
        stdoutTail: list.stdoutTail,
        stderrTail: list.stderrTail,
        fileLineRefs: REFS_CONFIG_DIR_FALLBACK,
        severity: "high",
      });
    }
    expect(list.spawnError).toBeUndefined();
    expect(list.timedOut).toBe(false);
    expect(list.exitCode).toBe(0);
    cleanDirs(list);

    // (c) `rolebox config` (no TTY in a child) must terminate cleanly. citty
    //     reports the assertInteractiveContext error as a controlled exit-1, not
    //     a crash (no timeout). A null exit / timeout would be a crash defect.
    const cfg = await runCliHermetic(["config"]);
    if (cfg.exitCode === null || cfg.timedOut || cfg.spawnError) {
      recordAndFail({
        testId: "s1-config-no-crash",
        scenario: "`rolebox config` terminates cleanly with no TTY (no crash)",
        command: cfg.command,
        expected: "clean termination (non-null exit, no timeout/spawn error)",
        actual: `exit=${cfg.exitCode} timedOut=${cfg.timedOut} spawnError=${cfg.spawnError}`,
        exitCode: cfg.exitCode,
        stdoutTail: cfg.stdoutTail,
        stderrTail: cfg.stderrTail,
        fileLineRefs: REFS_CONFIG_DIR_FALLBACK,
        severity: "medium",
      });
    }
    expect(cfg.exitCode).not.toBeNull();
    expect(cfg.timedOut).toBe(false);
    expect(cfg.spawnError).toBeUndefined();
    cleanDirs(cfg);

    // (d) REAL win32: end-to-end homedir fallback through the compiled CLI.
    //     Only meaningful on windows-latest. Point USERPROFILE at a temp dir and
    //     unset APPDATA/LOCALAPPDATA so resolution must land under the temp home.
    if (IS_WIN) {
      const home = tmpName("rb-win-home-");
      const dataHint = join(home, "AppData", "Local", "rolebox");
      mkdirSync(join(dataHint, "cache"), { recursive: true });
      seedVersionCache(dataHint);
      const st = await runCli(["status", "--json"], {
        isolateDirs: false,
        keepTempDirs: true,
        timeout: 30_000,
        env: {
          HOME: home,
          USERPROFILE: home,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
          XDG_DATA_HOME: undefined,
          XDG_CONFIG_HOME: undefined,
          ROLEBOX_DATA_DIR: undefined,
          ROLEBOX_CONFIG_DIR: undefined,
        },
      });
      const expectedCfg = join(home, "AppData", "Roaming", "rolebox", "config.yaml");
      const { configPath } = parseStatusJson(st);
      if (st.exitCode !== 0 || configPath !== expectedCfg) {
        recordAndFail({
          testId: "s1-homedir-fallback-win-child",
          scenario:
            "real win32 child: status resolves config under %USERPROFILE%\\AppData\\Roaming\\rolebox when APPDATA unset",
          command: st.command,
          expected: `exit 0, config.path=${expectedCfg}`,
          actual: `exit=${st.exitCode} config.path=${configPath}`,
          exitCode: st.exitCode,
          stdoutTail: st.stdoutTail,
          stderrTail: st.stderrTail,
          fileLineRefs: REFS_CONFIG_DIR_FALLBACK,
          severity: "critical",
        });
      }
      expect(st.exitCode).toBe(0);
      expect(configPath).toBe(expectedCfg);
      bestRm(home);
    }
  });

  // ── Scenario 2 ──────────────────────────────────────────────────
  it("S2: HOME vs USERPROFILE: homedir() resolution consistent, status exits 0", async () => {
    // (a) In-process sim: with APPDATA/LOCALAPPDATA unset the win32 fallback
    //     ALWAYS derives from homedir() — the invariant holds regardless of which
    //     env var (HOME or USERPROFILE) drove the OS homedir.
    withWin32Sim({}, () => {
      const expectedData = join(homedir(), "AppData", "Local", "rolebox");
      const expectedConfig = join(homedir(), "AppData", "Roaming", "rolebox");
      const data = getDataDir();
      const config = getConfigDir();
      if (data !== expectedData || config !== expectedConfig) {
        recordAndFail({
          testId: "s2-homedir-consistency-sim",
          scenario:
            "win32 fallback consistently derives from homedir() (HOME vs USERPROFILE)",
          command: "getDataDir()+getConfigDir() under win32 sim, APPDATA/LOCALAPPDATA unset",
          expected: `data=${expectedData} config=${expectedConfig}`,
          actual: `data=${data} config=${config}`,
          fileLineRefs: REFS_DATA_DIR_FALLBACK,
          severity: "high",
        });
      }
      expect(data).toBe(expectedData);
      expect(config).toBe(expectedConfig);
    });

    // (b) On REAL win32, os.homedir() == %USERPROFILE%. Flip which of
    //     HOME/USERPROFILE is "canonical" and assert the fallback follows it.
    //     (On darwin os.homedir() ignores both, so this half is windows-only.)
    if (IS_WIN) {
      withWin32Sim({}, () => {
        const homeA = tmpName("rb-win-homeA-");
        const homeB = tmpName("rb-win-homeB-");
        // USERPROFILE canonical, HOME different -> homedir()=USERPROFILE
        process.env.USERPROFILE = homeA;
        process.env.HOME = homeB;
        const d1 = getDataDir();
        const c1 = getConfigDir();
        // reverse: HOME canonical, USERPROFILE different -> homedir()=USERPROFILE on Windows
        process.env.USERPROFILE = homeB;
        process.env.HOME = homeA;
        const d2 = getDataDir();
        const c2 = getConfigDir();
        if (d1 !== join(homeA, "AppData", "Local", "rolebox") || c1 !== join(homeA, "AppData", "Roaming", "rolebox")) {
          recordAndFail({
            testId: "s2-win-userprofile-canonical",
            scenario:
              "real win32: USERPROFILE drives os.homedir() -> fallback under it",
            command: "getDataDir()+getConfigDir() with USERPROFILE=homeA, HOME=homeB",
            expected: `data=${join(homeA, "AppData", "Local", "rolebox")} config=${join(homeA, "AppData", "Roaming", "rolebox")}`,
            actual: `data=${d1} config=${c1}`,
            fileLineRefs: REFS_DATA_DIR_FALLBACK,
            severity: "high",
          });
        }
        expect(d1).toBe(join(homeA, "AppData", "Local", "rolebox"));
        expect(c1).toBe(join(homeA, "AppData", "Roaming", "rolebox"));
        expect(d2).toBe(join(homeB, "AppData", "Local", "rolebox"));
        expect(c2).toBe(join(homeB, "AppData", "Roaming", "rolebox"));
        bestRm(homeA);
        bestRm(homeB);
      });
    }

    // (c) `rolebox status` exits 0 (hermetic, isolated).
    const st = await runCliHermetic(["status", "--json"]);
    if (st.spawnError || st.timedOut || st.exitCode !== 0) {
      recordAndFail({
        testId: "s2-status-exit-0",
        scenario: "`rolebox status` exits 0 after HOME/USERPROFILE resolution",
        command: st.command,
        expected: "exit 0",
        actual: `exit=${st.exitCode} timedOut=${st.timedOut} spawnError=${st.spawnError} stderr=${st.stderrTail}`,
        exitCode: st.exitCode,
        stdoutTail: st.stdoutTail,
        stderrTail: st.stderrTail,
        fileLineRefs: REFS_DATA_DIR_FALLBACK,
        severity: "high",
      });
    }
    expect(st.exitCode).toBe(0);
    expect(st.spawnError).toBeUndefined();
    expect(st.timedOut).toBe(false);
    cleanDirs(st);
  });

  // ── Scenario 3 ──────────────────────────────────────────────────
  it.skipIf(!IS_WIN)(
    "S3 (win32-only; skipped on darwin — POSIX env is case-sensitive): lowercase 'rolebox_data_dir' env var",
    () => {
      const save = snapshotEnv();
      try {
        setPlatformForTest("win32");
        clearPathOverrides();
        const lower = tmpName("rb-lowercase-");
        // Only the LOWERCASE key is set — no uppercase ROLEBOX_DATA_DIR.
        process.env.rolebox_data_dir = lower;
        const d = getDataDir(); // reads process.env.ROLEBOX_DATA_DIR
        const honored = d === lower;
        if (!honored) {
          recordAndFail({
            testId: "s3-env-casing-defect",
            scenario:
              "lowercase 'rolebox_data_dir' is NOT honored on Windows (env-var name-casing divergence)",
            command: "getDataDir() with only lowercase 'rolebox_data_dir' set",
            expected: `honored: getDataDir()=${lower}`,
            actual: `getDataDir()=${d}`,
            fileLineRefs: ["src/cli/paths.ts:66"],
            severity: "high",
          });
        }
        // Record the documented-behavior finding even when it passes.
        recordPass("s3-env-casing-ok", {
          scenario:
            "lowercase 'rolebox_data_dir' IS honored on Windows (case-insensitive env — matches documented behavior)",
          command: "getDataDir() with only lowercase 'rolebox_data_dir' set",
          expected: `honored: getDataDir()=${lower}`,
          actual: `honored: getDataDir()=${d}`,
          fileLineRefs: ["src/cli/paths.ts:66"],
        });
        // Pass if honored; if not, `expect` throws (defect already recorded).
        expect(honored).toBe(true);
        bestRm(lower);
      } finally {
        setPlatformForTest(undefined);
        restoreEnv(save);
      }
    },
  );

  // ── Scenario 4 ──────────────────────────────────────────────────
  it("S4: ROLEBOX_DATA_DIR trailing-backslash / quotes / forward-slash encodings", () => {
    withWin32Sim({}, () => {
      const base = tmpName("rb-encoding-");
      const variants = {
        trailing: base + "\\",
        quoted: '"' + base + '"',
        forward: base.replace(/\\/g, "/"),
      };

      const getFor = (v: string): string => {
        process.env.ROLEBOX_DATA_DIR = v;
        const d = getDataDir();
        delete process.env.ROLEBOX_DATA_DIR;
        return d;
      };
      const resolved = {
        trailing: getFor(variants.trailing),
        quoted: getFor(variants.quoted),
        forward: getFor(variants.forward),
      };

      // (a) The override is returned VERBATIM — no quote-stripping or slash /
      //     separator normalization. This is the documented-behavior observation.
      if (resolved.trailing !== variants.trailing) {
        recordAndFail({
          testId: "s4-verbatim-trailing",
          scenario: "ROLEBOX_DATA_DIR trailing-backslash not normalized",
          command: "getDataDir() with trailing-backslash override",
          expected: `verbatim ${JSON.stringify(variants.trailing)}`,
          actual: JSON.stringify(resolved.trailing),
          fileLineRefs: REFS_OVERRIDE_RAW,
          severity: "low",
        });
      }
      if (resolved.quoted !== variants.quoted) {
        recordAndFail({
          testId: "s4-verbatim-quoted",
          scenario: "ROLEBOX_DATA_DIR quoted value not normalized",
          command: "getDataDir() with quoted override",
          expected: `verbatim ${JSON.stringify(variants.quoted)}`,
          actual: JSON.stringify(resolved.quoted),
          fileLineRefs: REFS_OVERRIDE_RAW,
          severity: "low",
        });
      }
      if (resolved.forward !== variants.forward) {
        recordAndFail({
          testId: "s4-verbatim-forward",
          scenario: "ROLEBOX_DATA_DIR forward-slash not normalized",
          command: "getDataDir() with forward-slash override",
          expected: `verbatim ${JSON.stringify(variants.forward)}`,
          actual: JSON.stringify(resolved.forward),
          fileLineRefs: REFS_OVERRIDE_RAW,
          severity: "low",
        });
      }

      // (b) Win32 semantics: trailing-backslash and forward-slash are the SAME
      //     usable directory. The quoted value is NOT — it carries literal quotes
      //     (invalid on Windows → EINVAL), so it resolves to a different dir.
      const trailing = winNormalize(resolved.trailing);
      const forward = winNormalize(resolved.forward);
      const quoted = winNormalize(resolved.quoted);
      const sameTrailingForward = trailing === forward;
      const quotedHasQuote = resolved.quoted.includes('"');
      const quotedDiffers = quoted !== forward;

      if (!sameTrailingForward) {
        recordAndFail({
          testId: "s4-trailing-vs-forward-diverges",
          scenario:
            "ROLEBOX_DATA_DIR trailing-backslash and forward-slash do NOT resolve to the same Windows dir",
          command: "winNormalize(getDataDir()) comparison",
          expected: `both normalize to ${forward}`,
          actual: `trailing=${trailing} forward=${forward}`,
          fileLineRefs: REFS_OVERRIDE_RAW,
          severity: "medium",
        });
      }
      if (quotedHasQuote) {
        recordAndFail({
          testId: "s4-quotes-not-stripped-defect",
          scenario:
            "quoted ROLEBOX_DATA_DIR retains literal quotes -> invalid/unusable dir on Windows (cmd.exe `set VAR=\"C:\\path\"` quirk)",
          command: `ROLEBOX_DATA_DIR=${JSON.stringify(variants.quoted)}`,
          expected:
            "all three encodings resolve to the same usable dir (quotes stripped)",
          actual:
            `getDataDir()=${JSON.stringify(resolved.quoted)} (literal quotes retained; invalid path on Windows) vs forward=${forward}`,
          fileLineRefs: REFS_OVERRIDE_RAW,
          severity: "medium",
        });
      }
      if (!quotedDiffers && !quotedHasQuote) {
        // This can't happen while quotes are retained, but guard the contract.
        recordAndFail({
          testId: "s4-quoted-should-differ",
          scenario: "quoted ROLEBOX_DATA_DIR must resolve differently (quotes invalid)",
          command: "winNormalize(getDataDir()) comparison",
          expected: "quoted != forward",
          actual: `quoted=${quoted} forward=${forward}`,
          fileLineRefs: REFS_OVERRIDE_RAW,
          severity: "medium",
        });
      }

      // Invariants: trailing & forward agree (pass); quoted MUST be flagged as a
      // defect (retained quotes -> not the same usable dir). This is the discover.
      expect(sameTrailingForward).toBe(true);
      expect(quotedHasQuote).toBe(false); // throws: defect already recorded above
      expect(quotedDiffers).toBe(true);
      bestRm(base);
    });
  });

  // ── Scenario 5 ──────────────────────────────────────────────────
  it("S5: PI_CODING_AGENT_DIR / DSH_HOME blank-vs-unset treated as unset", () => {
    withWin32Sim({}, () => {
      const home = homedir();
      const piDefault = join(home, ".pi", "agent");
      const dshDefault = join(home, ".dsh");

      // pi: blank, whitespace-only, and unset must all recover to ~/.pi/agent.
      process.env.PI_CODING_AGENT_DIR = "";
      const piBlank = piPlatformPaths().configDir;
      process.env.PI_CODING_AGENT_DIR = "   ";
      const piWs = piPlatformPaths().configDir;
      delete process.env.PI_CODING_AGENT_DIR;
      const piUnset = piPlatformPaths().configDir;

      // dsh: blank, whitespace-only, unset must all recover to ~/.dsh.
      process.env.DSH_HOME = "";
      const dshBlank = dshPlatformPaths().configDir;
      process.env.DSH_HOME = "\t ";
      const dshWs = dshPlatformPaths().configDir;
      delete process.env.DSH_HOME;
      const dshUnset = dshPlatformPaths().configDir;

      const bad: string[] = [];
      if (piBlank !== piDefault) bad.push(`pi blank=${piBlank}`);
      if (piWs !== piDefault) bad.push(`pi ws=${piWs}`);
      if (piUnset !== piDefault) bad.push(`pi unset=${piUnset}`);
      if (dshBlank !== dshDefault) bad.push(`dsh blank=${dshBlank}`);
      if (dshWs !== dshDefault) bad.push(`dsh ws=${dshWs}`);
      if (dshUnset !== dshDefault) bad.push(`dsh unset=${dshUnset}`);

      if (bad.length > 0) {
        recordAndFail({
          testId: "s5-blank-vs-unset-defect",
          scenario:
            "PI_CODING_AGENT_DIR / DSH_HOME blank(whitespace) NOT treated as unset",
          command: "piPlatformPaths().configDir + dshPlatformPaths().configDir",
          expected: `blank/whitespace/unset all resolve to pi=${piDefault} dsh=${dshDefault}`,
          actual: bad.join(" | "),
          fileLineRefs: [...REFS_PI, ...REFS_DSH],
          severity: "medium",
        });
      }
      expect(piBlank).toBe(piDefault);
      expect(piWs).toBe(piDefault);
      expect(piUnset).toBe(piDefault);
      expect(dshBlank).toBe(dshDefault);
      expect(dshWs).toBe(dshDefault);
      expect(dshUnset).toBe(dshDefault);

      // Documented-behavior finding: blank == unset (matches the docstring).
      recordPass("s5-blank-treated-as-unset-ok", {
        scenario:
          "blank / whitespace-only PI_CODING_AGENT_DIR & DSH_HOME treated as unset (matches docs)",
        command: "piPlatformPaths() + dshPlatformPaths() with blank/ws/unset env",
        expected: "blank==unset -> homespace fallback",
        actual: "blank/whitespace/unset all resolve to homespace fallback",
        fileLineRefs: [...REFS_PI, ...REFS_DSH],
      });
    });
  });

  // ── Scenario 6 (research) ───────────────────────────────────────
  it("S6: opencode Windows config location research verdict", () => {
    const scn6Path = join(EVIDENCE_ROOT, CLUSTER, "opencode-windows-config-location.json");

    // Observe what rolebox actually resolves opencode's config dir to (read-only).
    let roleboxDir = "";
    withWin32Sim({}, () => {
      roleboxDir = defaultPlatformPaths().configDir;
    });
    const home = homedir();
    const expectedWindows = join(home, ".config", "opencode");

    // VERDICT: ~/.config/opencode is CORRECT on Windows. opencode uses the
    // `xdg-basedir` package with NO per-OS branch, so on Windows it resolves to
    // %USERPROFILE%\.config\opencode; rolebox's defaultPlatformPaths() computes
    // os.homedir()/.config/opencode which is the same %USERPROFILE%\.config\opencode.
    const verdict = {
      scenario: "Verify opencode's real global config location on Windows",
      rolebox_sync_target: "~/.config/opencode",
      rolebox_resolves_to: roleboxDir,
      expected_on_windows: expectedWindows,
      opencode_source:
        "https://github.com/anomalyco/opencode/blob/dev/packages/core/src/global.ts",
      opencode_evidence:
        "const config = path.join(xdgConfig!, 'opencode') where xdgConfig comes from the 'xdg-basedir' package; there is NO per-OS branch. xdg-basedir resolves xdgConfig = $XDG_CONFIG_HOME || path.join(os.homedir(), '.config'); on Windows os.homedir()=%USERPROFILE%, so opencode config dir = %USERPROFILE%\\.config\\opencode (= ~/.config/opencode).",
      verdict: "CORRECT",
      defect: false,
      severity: "none",
      note:
        "rolebox defaultPlatformPaths() returns join(os.homedir(), '.config', 'opencode') == %USERPROFILE%\\.config\\opencode on Windows, which matches opencode. A Windows `rolebox sync opencode` is NOT a no-op; the target dir is valid.",
      minor_observation:
        "rolebox's opencode integration detection reads {configDir}/opencode.jsonc (src/platform/registry.ts:141) while opencode's documented global config filename is opencode.json (it also supports .jsonc). Directory location is correct; the filename-extension choice is a separate minor concern, not a sync-target defect.",
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(EVIDENCE_ROOT, CLUSTER), { recursive: true });
    writeFileSync(scn6Path, JSON.stringify(verdict, null, 2), "utf-8");

    // Assert the rolebox resolution is the documented ~/.config/opencode.
    if (roleboxDir !== expectedWindows) {
      recordAndFail({
        testId: "s6-opencode-dir-mismatch",
        scenario:
          "rolebox opencode config dir does not match the documented ~/.config/opencode",
        command: "defaultPlatformPaths().configDir",
        expected: expectedWindows,
        actual: roleboxDir,
        fileLineRefs: REFS_OPENCODE,
        severity: "critical",
      });
    }
    expect(roleboxDir).toBe(expectedWindows);
    expect(existsSync(scn6Path)).toBe(true);
  });
});

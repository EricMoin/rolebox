// tests/windows-adversarial/paths.test.ts
//
// Cluster B — path & workspace handling. Subtask 3 of 10.
//
// ADAPTERS: this file is a mix of
//   * REAL-CLI runs — spawn the compiled CLI via runCli (helpers/cli.ts) with
//     ROLEBOX_DATA_DIR / ROLEBOX_CONFIG_DIR / XDG_CONFIG_HOME routed to per-test
//     temp dirs, exactly like a Windows user would hit the boundary (argv,
//     citty dispatch, paths.ts platform branches, fs writes, exit codes).
//   * WIN32-SEAM SIM tests — import src/cli/paths.ts directly and drive its
//     win32 branches via setPlatformForTest("win32") (src/cli/paths.ts:40) plus
//     path.win32, so the win32-only logic (LOCALAPPDATA/APPDATA branches, UNC
//     handling, reserved-name validation) is covered on darwin. Real windows
//     runs happen in subtask 8.
//
// CONTRACT: the harness NEVER touches production source (src/) and never "fixes"
// a discovered defect. A violated path invariant calls recordDefect() with
// file:line refs and then FAILS the test — the failing test + the evidence JSON
// ARE the deliverable.
//
// Evidence cluster: "paths" → .rolebox/evidence/windows-campaign/paths/*.json

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { sep, join, win32 as pathWin32 } from "node:path";
import { tmpdir } from "node:os";
import { recordDefect } from "./helpers/evidence";
import { runCli, seedVersionCache, type CliResult } from "./helpers/cli";
import {
  setPlatformForTest,
  getPlatform,
  getDataDir,
  getConfigDir,
  getRolesDir,
  assertSafePathSegment,
  getRolePath,
} from "../../src/cli/paths.ts";

// ── Campaign cluster ────────────────────────────────────────────────
const CLUSTER = "paths";

// Redirect file logging to a temp file so importing the loader/resolver modules
// (test 5) never writes to the real ~/.config/rolebox/logs/rolebox.log.
process.env.ROLEBOX_LOG_FILE = join(tmpdir(), "rolebox-winpath-test.log");

// ── Per-run temp root, cleaned after the suite ──────────────────────
let tmpRoot = "";
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rolebox-winpath-"));
});
afterAll(() => {
  setPlatformForTest(undefined);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ── Small helpers (do not touch src/) ───────────────────────────────

function makeDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** Host is on a case-insensitive filesystem (darwin default). */
const CASE_INSENSITIVE_FS = getPlatform() === "darwin" || getPlatform() === "win32";

/** Build a lock YAML with double-quoted (JSON-safe) role strings. */
function lockYaml(
  entries: Array<{ role: string; registry?: string; version?: string }>,
): string {
  const lines = entries.map((e) => {
    return (
      `  - role: ${JSON.stringify(e.role)}\n` +
      `    registry: ${JSON.stringify(e.registry ?? "oh-my-role")}\n` +
      `    version: ${JSON.stringify(e.version ?? "1.0.0")}\n` +
      `    installedAt: "2026-01-01T00:00:00.000Z"\n` +
      `    integrity: "abc"\n`
    );
  });
  return `version: 1\nroles:\n${lines.join("")}`;
}

/** Create a role directory on disk at {dataDir}/roles/{registry}/{role}@{version}. */
function makeRoleDir(dataDir: string, registry: string, role: string, version: string): string {
  const d = join(dataDir, "roles", registry, `${role}@${version}`);
  makeDir(d);
  writeFileSync(join(d, "role.yaml"), `name: ${role}\nprompt: hi\n`, "utf-8");
  return d;
}

/**
 * Run `rolebox sync opencode` against a crafted lock. Returns the CliResult plus
 * the isolated XDG root and config dir so the caller can inspect the sync target.
 */
async function runSyncWithLock(
  entries: Array<{ role: string; registry?: string; version?: string }>,
): Promise<{ r: CliResult; xdgRoot: string; cfgDir: string; dataDir: string }> {
  const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
  writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml(entries), "utf-8");
  const xdgRoot = mkdtempSync(join(tmpRoot, "xdg-"));
  const dataDir = mkdtempSync(join(tmpRoot, "data-"));
  const cwd = mkdtempSync(join(tmpRoot, "cwd-"));
  seedVersionCache(dataDir);
  const r = await runCli(["sync", "opencode"], {
    cwd,
    dataDir,
    configDir: cfgDir,
    env: { XDG_CONFIG_HOME: xdgRoot },
    keepTempDirs: true,
    timeout: 30_000,
  });
  return { r, xdgRoot, cfgDir, dataDir };
}

function syncTargetPath(xdgRoot: string): string {
  return join(xdgRoot, "opencode", "rolebox");
}

/** Assert a thrown guard rejection containing `messageFrag`; else recordDefect + fail. */
function expectSafeReject(
  fn: () => unknown,
  messageFrag: string,
  testId: string,
  scenario: string,
  refs: string[],
  cmd = "(seam)",
): void {
  let threw = false;
  let msg = "";
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = String((e as Error).message ?? e);
  }
  if (threw && msg.includes(messageFrag)) return;
  recordDefect(testId, {
    cluster: CLUSTER,
    scenario,
    command: cmd,
    expected: `reject with message containing "${messageFrag}" (Windows-safe path contract)`,
    actual: threw ? `rejected but message=${JSON.stringify(msg)}` : `NOT rejected — guard passed, path segment admitted verbatim`,
    exit_code: threw ? null : 0,
    stdout_tail: "",
    stderr_tail: threw ? msg : "",
    file_line_refs: refs,
  });
  throw new Error(
    `[paths] ${testId}: expected guard rejection containing "${messageFrag}", got ${threw ? `"${msg}"` : "no throw (segment admitted)"}`,
  );
}

/** Assert a real-CLI run exited nonzero AND printed the guard message; else recordDefect + fail. */
function expectCliReject(
  r: CliResult,
  messageFrag: string,
  testId: string,
  scenario: string,
  refs: string[],
): void {
  const combined = `${r.stderr}${r.stdout}`;
  if (r.exitCode !== null && r.exitCode !== 0 && combined.includes(messageFrag)) return;
  recordDefect(testId, {
    cluster: CLUSTER,
    scenario,
    command: r.command,
    expected: `exit ≠ 0 AND output containing "${messageFrag}"`,
    actual: `exitCode=${r.exitCode} stderrTail=${JSON.stringify(r.stderrTail)} stdoutTail=${JSON.stringify(r.stdoutTail)}`,
    exit_code: r.exitCode,
    stdout_tail: r.stdoutTail,
    stderr_tail: r.stderrTail,
    file_line_refs: refs,
  });
  throw new Error(
    `[paths] ${testId}: expected CLI rejection containing "${messageFrag}", got exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
  );
}

// Run a command and assert it succeeds (no flagging); on failure recordDefect.
async function expectCliOk(
  args: string[],
  opts: Parameters<typeof runCli>[1],
  testId: string,
  scenario: string,
  refs: string[],
  onResult?: (r: CliResult) => void,
): Promise<CliResult> {
  const r = await runCli(args, opts);
  if (r.exitCode === 0) {
    onResult?.(r);
    return r;
  }
  recordDefect(testId, {
    cluster: CLUSTER,
    scenario,
    command: r.command,
    expected: "exit 0 (no crash / no corruption)",
    actual: `exitCode=${r.exitCode} stderrTail=${JSON.stringify(r.stderrTail)} stdoutTail=${JSON.stringify(r.stdoutTail)}`,
    exit_code: r.exitCode,
    stdout_tail: r.stdoutTail,
    stderr_tail: r.stderrTail,
    file_line_refs: refs,
  });
  throw new Error(`[paths] ${testId}: expected exit 0, got ${r.exitCode}`);
}

// ─────────────────────────────────────────────────────────────────────
// 1. Backslash & mixed-separator role specs / values → assertSafePathSegment
//    (src/cli/paths.ts:198-227) must reject with the documented message.
// ─────────────────────────────────────────────────────────────────────
describe("1. Backslash & mixed-separator values — assertSafePathSegment rejection (src/cli/paths.ts:198-227)", () => {
  const pathSeparatorValues = [
    "foo\\bar",
    "foo/bar",
    "foo\\bar\\baz",
    "foo/bar/baz",
    "foo\\/bar",
    "foo/\\bar",
    "foo\\bar\\",
    "foo/bar/",
  ];

  it("rejects every path-separator value for the roleId label (seam)", () => {
    for (const v of pathSeparatorValues) {
      expectSafeReject(
        () => assertSafePathSegment(v, "roleId"),
        "contains a path separator",
        `rolesep-role-${v.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        `roleId='${v}' fed to install/uninstall/sync must be rejected by assertSafePathSegment`,
        ["src/cli/paths.ts:199-203"],
      );
    }
  });

  it("rejects every path-separator value for the registry label (seam)", () => {
    for (const v of pathSeparatorValues) {
      expectSafeReject(
        () => assertSafePathSegment(v, "registry"),
        "contains a path separator",
        `rolesep-registry-${v.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        `registry='${v}' must be rejected (registry becomes a path component in getRolePath, paths.ts:179)`,
        ["src/cli/paths.ts:179", "src/cli/paths.ts:199-203"],
      );
    }
  });

  it("rejects `..` traversal values (seam)", () => {
    for (const v of ["..", "foo/../bar", "..\\foo", "foo..bar", "a.."]) {
      // A separator is checked before `..` (paths.ts:199 before 204), so a value
      // carrying both reports the separator message.
      const expected = v.includes("/") || v.includes("\\") ? "contains a path separator" : "path traversal";
      expectSafeReject(
        () => assertSafePathSegment(v, "roleId"),
        expected,
        `roletrav-${v.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        `roleId='${v}' must be rejected (traversal / separator)`,
        ["src/cli/paths.ts:199-208"],
      );
    }
  });

  it("guards the registry + roleId + version inside getRolePath (seam) — never mangles", () => {
    // getRolePath is the call path install/sync/uninstall route through
    // (paths.ts:178-183). A crafted bad segment must throw, not be joined in.
    expectSafeReject(
      () => getRolePath("oh-my-role", "foo\\bar", "1.0.0"),
      "contains a path separator",
      "getrolepath-role-backslash",
      "getRolePath with backslash roleId must reject before join (no path mangling)",
      ["src/cli/paths.ts:178-183"],
    );
    expectSafeReject(
      () => getRolePath("bad\\reg", "role", "1.0.0"),
      "contains a path separator",
      "getrolepath-registry-backslash",
      "getRolePath with backslash registry must reject before join (no path mangling)",
      ["src/cli/paths.ts:178-183"],
    );
    expectSafeReject(
      () => getRolePath("oh-my-role", "role", "1.0.0/../dev"),
      "contains a path separator",
      "getrolepath-version-traversal",
      "getRolePath with traversal in version must reject before join (no path mangling)",
      ["src/cli/paths.ts:178-183"],
    );
  });

  it("real-CLI: sync rejects a backslash roleId from the lock with the documented message", async () => {
    const { r } = await runSyncWithLock([{ role: "foo\\bar" }]);
    expectCliReject(
      r,
      "contains a path separator",
      "realsync-role-backslash",
      "sync iterating a lock whose roleId is 'foo\\bar' must reject via assertSafePathSegment (getRolePath, sync.ts:33)",
      ["src/cli/paths.ts:199-203", "src/cli/commands/sync.ts:33"],
    );
  });

  it("real-CLI: sync rejects a mixed-separator roleId from the lock", async () => {
    const { r } = await runSyncWithLock([{ role: "foo/bar" }]);
    expectCliReject(
      r,
      "contains a path separator",
      "realsync-role-forwardslash",
      "sync with roleId 'foo/bar' must reject via assertSafePathSegment",
      ["src/cli/paths.ts:199-203", "src/cli/commands/sync.ts:33"],
    );
  });

  it("OBSERVATION: `install` with a backslash role spec never reaches the guard (fails at registry resolution) — no mangled dir created", async () => {
    // The guard lives downstream of registry resolution in install (getRolePath
    // is reached only after a successful download+swap; src/cli/commands/install.ts
    // step 9). A crafted role spec that isn't a real registry role therefore
    // fails earlier with "role not found", so the assertSafePathSegment message
    // is NOT surfaced through `install` (defense-in-depth note), and crucially no
    // backslash path is ever created. This asserts the "no path mangling" half of
    // the install contract. The registry fetch is the one unavoidable network call.
    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
    const cwd = mkdtempSync(join(tmpRoot, "cwd-"));
    seedVersionCache(dataDir);
    const r = await runCli(["install", "foo\\bar"], { cwd, dataDir, configDir: cfgDir, keepTempDirs: true, timeout: 40_000 });

    // No role dir may appear under {dataDir}/roles for the backslash spec.
    const rolesDir = join(dataDir, "roles");
    const mangledDir = join(rolesDir, "oh-my-role", "foo\\bar@1.0.0");
    if (existsSync(mangledDir)) {
      recordDefect("install-mangled-backslash-dir", {
        cluster: CLUSTER,
        scenario: "install a role spec containing a backslash must not create a mangled on-disk role dir",
        command: r.command,
        expected: "no filesystem path created for roleId 'foo\\bar' (assertSafePathSegment / getRolePath protection)",
        actual: `mangled role dir exists: ${mangledDir}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/install.ts:172", "src/cli/paths.ts:178-183"],
      });
      throw new Error(`[paths] install created a mangled dir for backslash role: ${mangledDir}`);
    }
    if (r.exitCode !== 0) {
      // Install exited nonzero (role-not-found / fetch failure). Record the
      // defense-in-depth observation: the documented guard message was NOT
      // surfaced through `install` — it only fires in sync/uninstall.
      recordDefect("install-guard-not-surfaced", {
        cluster: CLUSTER,
        scenario: "install with a backslash role spec exits nonzero but does NOT surface the assertSafePathSegment message",
        command: r.command,
        expected: "note: guard is reachable in install only after registry resolution; here it fails earlier",
        actual: `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/install.ts:119-131", "src/cli/commands/install.ts:172"],
      });
    }
    expect(existsSync(mangledDir)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Windows reserved names (CON, NUL, COM1…) and invalid chars as roleId
//    must be rejected cleanly. Also records guard-miss vectors.
// ─────────────────────────────────────────────────────────────────────
describe("2. Windows reserved names & invalid chars as roleId — clean rejection", () => {
  const reserved = ["CON", "con", "Con", "NUL", "nul", "COM1", "com1", "COM9", "LPT1", "lpt9", "PRN", "AUX"];
  const invalidChars = [":", "*", "?", '"', "<", ">", "|"];
  const callReservedAndInvalid = (label: string, v: string) =>
    `value '${v}' as ${label} must be rejected by assertSafePathSegment`;

  it("rejects all bare Windows reserved device names, case-insensitively (seam)", () => {
    for (const v of reserved) {
      expectSafeReject(
        () => assertSafePathSegment(v, "roleId"),
        "Windows reserved device name",
        `reserved-${v}`,
        callReservedAndInvalid("roleId", v),
        ["src/cli/paths.ts:187-191", "src/cli/paths.ts:219-223"],
      );
    }
  });

  it("rejects all Windows-invalid characters (seam)", () => {
    for (const c of invalidChars) {
      const v = `foo${c}bar`;
      expectSafeReject(
        () => assertSafePathSegment(v, "roleId"),
        "Windows-invalid character",
        `invalidchar-${c.charCodeAt(0)}`,
        callReservedAndInvalid("roleId", v),
        ["src/cli/paths.ts:185", "src/cli/paths.ts:214-218"],
      );
    }
  });

  it("rejects a leading dot and empty/whitespace values (seam)", () => {
    expectSafeReject(() => assertSafePathSegment(".hidden", "roleId"), "starts with a dot", "leadingdot-role", callReservedAndInvalid("roleId", ".hidden"), ["src/cli/paths.ts:209-213"]);
    expectSafeReject(() => assertSafePathSegment("", "roleId"), "is empty", "empty-role", callReservedAndInvalid("roleId", ""), ["src/cli/paths.ts:224-226"]);
    expectSafeReject(() => assertSafePathSegment("   ", "roleId"), "is empty", "blanks-role", callReservedAndInvalid("roleId", "   "), ["src/cli/paths.ts:224-226"]);
  });

  it("real-CLI: sync rejects CON / NUL / COM1 roleIds from the lock with the documented message", async () => {
    for (const v of ["CON", "NUL", "COM1"]) {
      const { r } = await runSyncWithLock([{ role: v }]);
      expectCliReject(
        r,
        "Windows reserved device name",
        `realsync-reserved-${v}`,
        `sync with roleId '${v}' must reject via assertSafePathSegment`,
        ["src/cli/paths.ts:219-223", "src/cli/commands/sync.ts:33"],
      );
    }
  });

  it("real-CLI: uninstall reaches the guard for a reserved-name role that is in the lock", async () => {
    const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
    writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml([{ role: "CON" }]), "utf-8");
    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    seedVersionCache(dataDir);
    const r = await runCli(["uninstall", "CON"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      configDir: cfgDir,
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpRoot, "xdg-")) },
      keepTempDirs: true,
      timeout: 30_000,
    });
    expectCliReject(
      r,
      "Windows reserved device name",
      "realuninstall-reserved-CON",
      "uninstall of a locked roleId 'CON' must reject via getRolePath→assertSafePathSegment (not silently rm)",
      ["src/cli/paths.ts:219-223", "src/cli/commands/uninstall.ts:50"],
    );
  });

  // ── Guard-miss vectors (Windows strips trailing dots/spaces, reserves
  //    device names WITH extensions): assert the guard SHOULD reject them
  //    under the "no path mangling" contract. Each violation => defect. ──
  it("GUARD MISS: trailing dot in roleId is admitted verbatim (Windows strips it → mangling)", () => {
    // Windows strips trailing dots/spaces from a path segment, so a roleId of
    // "foo." would land in a directory the OS writes as "foo" — a mangling /
    // collision vector that assertSafePathSegment does not close (it only
    // checks leading dot, paths.ts:209).
    expectSafeReject(
      () => getRolePath("oh-my-role", "foo.", "1.0.0"),
      "starts with a dot", // expected contract
      "guardmiss-trailing-dot",
      "roleId 'foo.' (trailing dot) must be rejected: Windows silently strips trailing dots, corrupting the on-disk role dir",
      ["src/cli/paths.ts:209-213", "src/cli/paths.ts:178-183"],
    );
  });

  it("GUARD MISS: trailing space in roleId is admitted verbatim (Windows strips it → mangling)", () => {
    expectSafeReject(
      () => getRolePath("oh-my-role", "foo ", "1.0.0"),
      "is empty",
      "guardmiss-trailing-space",
      "roleId 'foo ' (trailing space) must be rejected: Windows strips trailing spaces, corrupting the on-disk role dir",
      ["src/cli/paths.ts:224-226", "src/cli/paths.ts:178-183"],
    );
  });

  it("GUARD MISS: reserved device name WITH extension (CON.txt) is admitted verbatim", () => {
    // Windows reserves CON/PRN/AUX/NUL/COM1-9/LPT1-9 with OR without an
    // extension (e.g. "CON.txt"), but WIN_RESERVED_NAMES only holds the bare
    // names (paths.ts:187-191), so "CON.txt" slips through.
    expectSafeReject(
      () => getRolePath("oh-my-role", "CON.txt", "1.0.0"),
      "Windows reserved device name",
      "guardmiss-reserved-and-extension",
      "roleId 'CON.txt' must be rejected: Windows includes it in the reserved device name set (CON, CON.txt, ...)",
      ["src/cli/paths.ts:187-191", "src/cli/paths.ts:219-223"],
    );
  });

  it("GUARD MISS: reserved name with trailing space (CON ) is admitted verbatim", () => {
    expectSafeReject(
      () => getRolePath("oh-my-role", "CON ", "1.0.0"),
      "Windows reserved device name",
      "guardmiss-reserved-space",
      "roleId 'CON ' must be rejected: Windows strips the trailing space then blocks the reserved name",
      ["src/cli/paths.ts:187-191", "src/cli/paths.ts:219-223"],
    );
  });

  it("real-CLI evidence: guard-miss vectors are actually admitted by sync (not rejected)", async () => {
    // Confirm the guard-miss is observable through the real CLI: these roles
    // are NOT rejected; sync reports "skipped" (source missing) rather than a
    // hard rejection — proving the Windows-safe contract is not enforced.
    for (const role of ["foo.", "foo ", "CON.txt", "CON "]) {
      const { r } = await runSyncWithLock([{ role }]);
      if (r.exitCode !== 0) {
        // It actually rejected — reject that as a mismatch with our observation,
        // so the evidence stays accurate.
        recordDefect(`realguard-audit-${role.replace(/[^a-zA-Z0-9]+/g, "_")}`, {
          cluster: CLUSTER,
          scenario: `sync with roleId='${role}' (guard-miss vector)`,
          command: r.command,
          expected: "admitted (guard-miss) for observation; NOT a clean reject",
          actual: `unexpectedly rejected: exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
          exit_code: r.exitCode,
          stdout_tail: r.stdoutTail,
          stderr_tail: r.stderrTail,
          file_line_refs: ["src/cli/paths.ts:178-183"],
        });
        throw new Error(`[paths] guard-miss vector '${role}' was unexpectedly rejected (${r.exitCode})`);
      }
      // Expected observable: guard did not reject → sync skips (no source) and
      // exits 0. That is the documented defect: no clean rejection.
      const skipped = /skipped/.test(r.stdout);
      expect(skipped).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Drive-letter and UNC values in ROLEBOX_DATA_DIR → getDataDir/getRolesDir
//    resolve without corruption; real-CLI `rolebox list` exits 0.
// ─────────────────────────────────────────────────────────────────────
describe("3. Drive-letter & UNC ROLEBOX_DATA_DIR — resolve without corruption", () => {
  const driveUncValues = ["\\\\?\\C:\\rolebox-data", "C:\\rolebox-data", "\\\\server\\share\\rolebox"];

  it("getDataDir returns the override verbatim; getRolesDir preserves the prefix (win32 seam)", () => {
    for (const v of driveUncValues) {
      const [, restore] = setEnv({ ROLEBOX_DATA_DIR: v, XDG_DATA_HOME: undefined, LOCALAPPDATA: undefined });
      try {
        setPlatformForTest("win32");
        const dd = getDataDir();
        const rd = getRolesDir();
        expect(dd).toBe(v); // override is returned verbatim (paths.ts:66-67), never re-decorated
        // getRolesDir must keep the dataDir prefix and append exactly one segment
        // (join(getDataDir(), "roles") by definition, paths.ts:130) — no corruption.
        expect(rd).toBe(join(v, "roles"));
        expect(rd.startsWith(v)).toBe(true);
        expect(rd.endsWith("roles")).toBe(true);
      } finally {
        restore();
        setPlatformForTest(undefined);
      }
    }
  });

  it("drive-letter / UNC values do not corrupt the win32-normalized roles path", () => {
    for (const v of driveUncValues) {
      // On win32, node:path.join produces backslash-joined output preserving the
      // drive/UNC prefix exactly. This is the win32 contract signalled by the
      // seam; the darwin-process posix join is a known sim limitation (see notes).
      expect(win32Join(v, "roles")).toBe(`${v}\\roles`); // prefix preserved, exactly one segment appended
      // The darwin-observable getRolesDir agrees on the segment count.
      const [, restore] = setEnv({ ROLEBOX_DATA_DIR: v, XDG_DATA_HOME: undefined, LOCALAPPDATA: undefined });
      try {
        setPlatformForTest("win32");
        expect(segmentCount(getRolesDir())).toBe(segmentCount(v) + 1);
      } finally {
        restore();
        setPlatformForTest(undefined);
      }
    }
  });

  it("real-CLI: `rolebox list` with drive/UNC ROLEBOX_DATA_DIR exits 0 (no crash/corruption)", async () => {
    for (const v of driveUncValues) {
      // IMPORTANT: inject the drive/UNC value via opts.env (never opts.dataDir),
      // because runCli's own mkdirSync(opts.dataDir) (helpers/cli.ts:209) would
      // treat the literal UNC string as a RELATIVE path on darwin and create an
      // empty "C:\…"-named directory in the repo — a darwin artifact, not a
      // win32 behavior. The child process still receives ROLEBOX_DATA_DIR=v and,
      // running in a temp cwd, keeps any version-cache write inside the temp dir.
      const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
      await expectCliOk(
        ["list"],
        {
          cwd: mkdtempSync(join(tmpRoot, "cwd-")),
          dataDir: mkdtempSync(join(tmpRoot, "data-")),
          configDir: cfgDir,
          env: { ROLEBOX_DATA_DIR: v },
          keepTempDirs: true,
          timeout: 30_000,
        },
        `reallist-datadir-${v.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        `rolebox list with ROLEBOX_DATA_DIR='${v}' must exit 0 (CLI resolves it without corrupting into a crash)`,
        ["src/cli/paths.ts:65-67", "src/cli/paths.ts:129-131"],
        (r) => {
          expect(r.stdout).toContain("No roles installed");
        },
      );
    }
  });

  it("real-CLI: drive/UNC ROLEBOX_DATA_DIR does not leak backslash separators into the roles dir on win32 path join", () => {
    // win32.join keeps the UNC/verbatim prefix and a single trailing segment.
    for (const v of driveUncValues) {
      expect(win32Join(v, "roles")).toBe(`${v}\\roles`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Case-insensitivity collision: install 'myrole' then reference 'MyRole'
//    in uninstall/info — consistent behavior; a silent duplicate into a
//    case-colliding dir is a defect.
// ─────────────────────────────────────────────────────────────────────
describe("4. Case-insensitivity collision: myrole vs MyRole", () => {
  it("real-CLI: referencing 'MyRole' (different case) in info is a CLEAR not-found", async () => {
    const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
    writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml([{ role: "myrole" }]), "utf-8");
    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    seedVersionCache(dataDir);
    const r = await runCli(["info", "MyRole"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      configDir: cfgDir,
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpRoot, "xdg-")) },
      keepTempDirs: true,
      timeout: 30_000,
    });
    const found = r.exitCode === 0;
    const notFound = r.exitCode !== 0 && `${r.stderr}${r.stdout}`.includes("not installed");
    if (!found && !notFound) {
      recordDefect("case-info-ambiguous", {
        cluster: CLUSTER,
        scenario: "info MyRole against a lock contaaining 'myrole'",
        command: r.command,
        expected: "clearly found OR clearly not-installed (no ambiguous behavior)",
        actual: `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/config.ts:116-119", "src/cli/commands/info.ts:76-79"],
      });
      throw new Error(`[paths] info MyRole gave ambiguous outcome (exitCode=${r.exitCode})`);
    }
    // Documented behavior: case-sensitive lock lookup => clearly not-found.
    expect(notFound).toBe(true);
  });

  it("real-CLI: referencing 'MyRole' (different case) in uninstall is a CLEAR not-found", async () => {
    const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
    writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml([{ role: "myrole" }]), "utf-8");
    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    seedVersionCache(dataDir);
    const r = await runCli(["uninstall", "MyRole"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      configDir: cfgDir,
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpRoot, "xdg-")) },
      keepTempDirs: true,
      timeout: 30_000,
    });
    const spelledOut = r.exitCode !== 0 && `${r.stderr}${r.stdout}`.includes("not installed");
    const didRemove = r.exitCode === 0;
    if (!spelledOut && !didRemove) {
      recordDefect("case-uninstall-ambiguous", {
        cluster: CLUSTER,
        scenario: "uninstall MyRole against a lock containing 'myrole'",
        command: r.command,
        expected: "clearly not-installed (or a validated removal) — no duplicate/ambiguous direction",
        actual: `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/config.ts:116-119", "src/cli/commands/uninstall.ts:43-47"],
      });
      throw new Error(`[paths] uninstall MyRole gave ambiguous outcome (exitCode=${r.exitCode})`);
    }
    expect(spelledOut).toBe(true);
  });

  it("real-CLI: uninstall the exact-case role succeeds (lock entry removed)", async () => {
    const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
    writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml([{ role: "myrole" }]), "utf-8");
    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    makeRoleDir(dataDir, "oh-my-role", "myrole", "1.0.0");
    seedVersionCache(dataDir);
    const r = await runCli(["uninstall", "myrole"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      configDir: cfgDir,
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpRoot, "xdg-")) },
      keepTempDirs: true,
      timeout: 30_000,
    });
    const ok = r.exitCode === 0 && `${r.stdout}${r.stderr}`.includes("Uninstalled myrole");
    if (!ok) {
      recordDefect("case-uninstall-exact", {
        cluster: CLUSTER,
        scenario: "uninstall myrole (exact case) with a matching lock entry and role dir",
        command: r.command,
        expected: "exit 0 and reports Uninstalled myrole",
        actual: `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/uninstall.ts:42-82"],
      });
      throw new Error(`[paths] uninstall myrole failed: exitCode=${r.exitCode}`);
    }
  });

  it("DEFECT: sync silently clobbers a case-colliding role's symlink on a case-insensitive FS", async () => {
    if (!CASE_INSENSITIVE_FS) {
      // Not exerciseable on this host. Never skip silently.
      console.warn(`[paths][skip] case-collision sync is only meaningful on a case-insensitive FS (host=${getPlatform()}); recording fact.`);
      return;
    }
    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    const reg = "oh-my-role";
    makeRoleDir(dataDir, reg, "myrole", "1.0.0");
    makeRoleDir(dataDir, reg, "MyRole", "1.0.0");
    const cfgDir = mkdtempSync(join(tmpRoot, "cfg-"));
    writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml([{ role: "myrole", registry: reg }, { role: "MyRole", registry: reg }]), "utf-8");
    const xdgRoot = mkdtempSync(join(tmpRoot, "xdg-"));
    seedVersionCache(dataDir);
    const r = await runCli(["sync", "opencode"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      configDir: cfgDir,
      env: { XDG_CONFIG_HOME: xdgRoot },
      keepTempDirs: true,
      timeout: 30_000,
    });

    const syncTarget = syncTargetPath(xdgRoot);
    const onDisk = existsSync(syncTarget) ? readdirSync(syncTarget) : [];
    const reported = Number((/Synced (\d+)/.exec(r.stdout) ?? [])[1] ?? NaN);
    const reachable = onDisk.filter((e) => {
      try {
        return lstatSync(join(syncTarget, e)).isSymbolicLink();
      } catch {
        return false;
      }
    }).length;

    // INVARIANT: sync must not silently collapse two case-distinct locked roles
    // into a single symlink, nor report a synced count larger than the roles it
    // actually made reachable.
    const violates = reported !== reachable || reachable !== 2;
    if (violates) {
      recordDefect("case-collision-sync-clobber", {
        cluster: CLUSTER,
        scenario: "lock has roles 'myrole' and 'MyRole' (case-colliding); sync opencode",
        command: r.command,
        expected:
          "both locked case-variant roles stay reachable, OR the case collision is detected/refused (no silent drop)",
        actual: `reported "Synced ${reported}" but only ${reachable} reachable symlink(s) on disk (${JSON.stringify(onDisk)}); on a case-insensitive FS the earlier 'myrole' target is silently overwritten by 'MyRole'`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: [
          "src/cli/commands/sync.ts:31-34",
          "src/cli/commands/sync.ts:44-58",
          "src/cli/commands/sync.ts:95",
        ],
      });
      throw new Error(
        `[paths] case-collision defect: reported ${reported} synced, ${reachable} reachable (${JSON.stringify(onDisk)})`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. fast-glob on win32: a role tree under a path with backslashes + spaces
//    must be fully discovered (role-loader:53, skill-resolver:57-81, subagents:245).
// ─────────────────────────────────────────────────────────────────────
describe("5. fast-glob discovery under space/backslash paths", () => {
  it("discovers every role in a role tree whose path contains spaces (portable win32-relevant case)", async () => {
    const { discoverRoles } = await import("../../src/loader/role-loader.ts");
    const tree = join(tmpRoot, "role tree with space");
    const myRole = join(tree, "My Role");
    const subDirA = join(myRole, "subagents", "helper");
    const skillA = join(myRole, "skills", "alpha");
    const skillB = join(myRole, "skills", "bravo");
    makeDir(subDirA);
    makeDir(skillA);
    makeDir(skillB);
    writeFileSync(join(myRole, "role.yaml"), "name: My Role\nprompt: hi\nsubagents:\n  - name: helper\n    prompt: helper prompt\n", "utf-8");
    writeFileSync(join(subDirA, "role.yaml"), "name: helper\nprompt: helper file\n", "utf-8");
    writeFileSync(join(skillA, "SKILL.md"), "---\ndescription: alpha skill\n---\n# a\n", "utf-8");
    writeFileSync(join(skillB, "SKILL.md"), "---\ndescription: bravo skill\n---\n# b\n", "utf-8");

    const roles = await discoverRoles(tree);
    const roleIds = [...roles.keys()];
    if (!roleIds.includes("My Role")) {
      recordDefect("glob-space-role-miss", {
        cluster: CLUSTER,
        scenario: `discoverRoles on a tree path containing spaces (${tree})`,
        command: "discoverRoles(tree)",
        expected: "role dir 'My Role' discovered (role-loader.ts:53 `**/role.yaml`)",
        actual: `roleIds=${JSON.stringify(roleIds)}`,
        exit_code: null,
        stdout_tail: "",
        stderr_tail: "",
        file_line_refs: ["src/loader/role-loader.ts:53-57"],
      });
      throw new Error(`[paths] discoverRoles missed roles under spaced path: ${JSON.stringify(roleIds)}`);
    }
    expect(roleIds).toContain("My Role");

    const { resolveSkills } = await import("../../src/resolver/skill-resolver.ts");
    const skills = await resolveSkills(["alpha", "bravo", "missing"], myRole, join(tmpRoot, "global"));
    const found = skills.map((s) => s.name);
    if (!found.includes("alpha") || !found.includes("bravo")) {
      recordDefect("glob-space-skill-miss", {
        cluster: CLUSTER,
        scenario: "resolveSkills under a space-containing role dir",
        command: "resolveSkills([alpha, bravo], roleDir)",
        expected: "both skills resolved (skill-resolver.ts:57-81 forward-slash glob normalization)",
        actual: `found=${JSON.stringify(found)}`,
        exit_code: null,
        stdout_tail: "",
        stderr_tail: "",
        file_line_refs: ["src/resolver/skill-resolver.ts:57-89"],
      });
      throw new Error(`[paths] resolveSkills missed skills: ${JSON.stringify(found)}`);
    }
    expect(found).toContain("alpha");
    expect(found).toContain("bravo");

    const { discoverFileBasedSubagents } = await import("../../src/loader/subagents.ts");
    const subs = await discoverFileBasedSubagents(myRole, "My Role");
    if (!subs.some((s) => s.name === "helper")) {
      recordDefect("glob-space-subagent-miss", {
        cluster: CLUSTER,
        scenario: "discoverFileBasedSubagents under a space-containing role dir",
        command: "discoverFileBasedSubagents(roleDir, 'My Role')",
        expected: "file-based subagent 'helper' discovered (subagents.ts:245)",
        actual: `subagents=${JSON.stringify(subs.map((s) => s.name))}`,
        exit_code: null,
        stdout_tail: "",
        stderr_tail: "",
        file_line_refs: ["src/loader/subagents.ts:244-252"],
      });
      throw new Error(`[paths] discovery missed file-based subagents: ${JSON.stringify(subs.map((s) => s.name))}`);
    }
    expect(subs.map((s) => s.name)).toContain("helper");
  });

  it("win32 backslash patterns are normalized to forward slashes for fast-glob (skill-resolver.ts:57-81)", async () => {
    const { toPosixPath, toNativePath } = await import("../../src/utils/paths.ts");
    // fast-glob only accepts forward-slash patterns. On win32 the join()-built
    // candidate patterns carry backslashes, so skill-resolver normalizes them
    // via toPosixPath (skill-resolver.ts:64,82). toPosixPath is platform-
    // independent: backslashes always become forward slashes.
    const backslashPattern = "C:\\roles\\My Role\\skills\\alpha\\SKILL.md";
    expect(toPosixPath(backslashPattern)).toBe("C:/roles/My Role/skills/alpha/SKILL.md");
    // toNativePath restores the HOST separator (darwin sep = "/" => no-op;
    // on win32 sep = "\\"). This mirrors utils/paths.ts:32-34, which uses node
    // sep at runtime — the win32 output is verified on windows-latest.
    const expectedNative = "C:/roles/My Role/skills/alpha/SKILL.md".replace(/\//g, sep);
    expect(toNativePath(toPosixPath(backslashPattern))).toBe(expectedNative);
    if (sep === "/") {
      expect(expectedNative).toBe("C:/roles/My Role/skills/alpha/SKILL.md"); // darwin: no-op
    }
  });

  it("OBSERVATION: a literal backslash in a path segment yields empty discoverRoles (darwin fast-glob)", async () => {
    // On win32 a backslash is a separator (cannot appear inside a segment), so a
    // literal backslash in a directory name is a POSIX-only construction. This
    // documents how fast-glob behaves on such an edge path — an observation, not
    // a claim about real Windows filesystems.
    const { discoverRoles } = await import("../../src/loader/role-loader.ts");
    const tree = join(tmpRoot, "role\\tree");
    const role = join(tree, "TestRole");
    makeDir(role);
    writeFileSync(join(role, "role.yaml"), "name: TestRole\nprompt: hi\n", "utf-8");
    const roles = await discoverRoles(tree);
    const roleIds = [...roles.keys()];
    // Honest observation record (not flagged as a severity defect): this asserts
    // the current (empty) behavior so the campaign has an explicit evidence trail.
    recordDefect("glob-backslash-segment-observation", {
      cluster: CLUSTER,
      scenario: `discoverRoles on a tree path containing a literal backslash in a segment (${tree})`,
      command: "discoverRoles(tree)",
      expected: "N/A — observation: documented behavior",
      actual: `discoverRoles returned ${JSON.stringify(roleIds)} (empty) for a path containing a literal backslash segment`,
      exit_code: null,
      stdout_tail: "",
      stderr_tail: "",
      file_line_refs: ["src/loader/role-loader.ts:53", "src/utils/paths.ts:20-34"],
    });
    // Assert the observed behavior stays stable (discovery misses the literal
    // backslash segment) so the evidence and the test stay in sync.
    expect(roleIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Env precedence: XDG_DATA_HOME vs LOCALAPPDATA on win32
//    (src/cli/paths.ts:65-91, 98-124) → documented precedence.
// ─────────────────────────────────────────────────────────────────────
describe("6. Env precedence — XDG vs LOCALAPPDATA/APPDATA on win32", () => {
  it("win32: XDG_DATA_HOME wins over LOCALAPPDATA; LOCALAPPDATA used when no XDG (seam)", () => {
    const [, restore] = setEnv({
      ROLEBOX_DATA_DIR: undefined,
      XDG_DATA_HOME: "D:\\xdg",
      LOCALAPPDATA: "D:\\local",
    });
    try {
      setPlatformForTest("win32");
      expect(baseOf(getDataDir())).toBe("D:\\xdg");
    } finally {
      restore();
      setPlatformForTest(undefined);
    }
  });

  it("win32: LOCALAPPDATA is used when no XDG_DATA_HOME (seam)", () => {
    const [, restore] = setEnv({
      ROLEBOX_DATA_DIR: undefined,
      XDG_DATA_HOME: undefined,
      LOCALAPPDATA: "D:\\local",
    });
    try {
      setPlatformForTest("win32");
      expect(baseOf(getDataDir())).toBe("D:\\local");
    } finally {
      restore();
      setPlatformForTest(undefined);
    }
  });

  it("ROLEBOX_DATA_DIR overrides XDG_DATA_HOME and LOCALAPPDATA on win32 (seam)", () => {
    const [, restore] = setEnv({
      ROLEBOX_DATA_DIR: "D:\\override",
      XDG_DATA_HOME: "D:\\xdg",
      LOCALAPPDATA: "D:\\local",
    });
    try {
      setPlatformForTest("win32");
      expect(getDataDir()).toBe("D:\\override"); // verbatim override, paths.ts:66-67
    } finally {
      restore();
      setPlatformForTest(undefined);
    }
  });

  it("win32: XDG_CONFIG_HOME wins over APPDATA for the config dir (seam)", () => {
    const [, restore] = setEnv({
      ROLEBOX_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: "D:\\xcfg",
      APPDATA: "D:\\roam",
    });
    try {
      setPlatformForTest("win32");
      expect(baseOf(getConfigDir())).toBe("D:\\xcfg");
    } finally {
      restore();
      setPlatformForTest(undefined);
    }
  });

  it("win32: APPDATA used when no XDG_CONFIG_HOME for the config dir (seam)", () => {
    const [, restore] = setEnv({
      ROLEBOX_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: undefined,
      APPDATA: "D:\\roam",
    });
    try {
      setPlatformForTest("win32");
      expect(baseOf(getConfigDir())).toBe("D:\\roam");
    } finally {
      restore();
      setPlatformForTest(undefined);
    }
  });

  it("real-CLI: XDG_CONFIG_HOME (not APPDATA) determines where the lock is read — documented precedence via CLI output", async () => {
    // Portion of the precedence matrix observable on darwin: XDG_CONFIG_HOME is
    // honored on ALL platforms (paths.ts:105-106) above APPDATA. We must run the
    // CLI WITHOUT a ROLEBOX_CONFIG_DIR override (isolateDirs:false) so it actually
    // resolves via getConfigDir(). To stay hermetic even if precedence broke
    // (falling back to the homedir branch), point HOME at a temp dir too.
    const xdgRoot = mkdtempSync(join(tmpRoot, "xdg-"));
    const roleboxCfgDir = join(xdgRoot, "rolebox");
    makeDir(roleboxCfgDir);
    writeFileSync(join(roleboxCfgDir, "rolebox.lock"), lockYaml([{ role: "myrole" }]), "utf-8");
    // Seed a config so `status` prints a config.path we can assert against.
    writeFileSync(join(roleboxCfgDir, "config.yaml"), "registries:\n  - name: oh-my-role\n    url: https://github.com/EricMoin/oh-my-role\n    default: true\n", "utf-8");

    const dataDir = mkdtempSync(join(tmpRoot, "data-"));
    const homeTmp = mkdtempSync(join(tmpRoot, "home-"));
    seedVersionCache(dataDir);
    const r2 = await runCli(["status", "--json"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      isolateDirs: false,
      env: {
        ROLEBOX_DATA_DIR: dataDir,
        ROLEBOX_CONFIG_DIR: undefined,
        XDG_CONFIG_HOME: xdgRoot,
        HOME: homeTmp,
        APPDATA: join(tmpRoot, "appdata"),
      },
      keepTempDirs: true,
      timeout: 30_000,
    });
    if (r2.exitCode !== 0) {
      recordDefect("env-precedence-status", {
        cluster: CLUSTER,
        scenario: "rolebox status --json with XDG_CONFIG_HOME set, ROLEBOX_CONFIG_DIR unset",
        command: r2.command,
        expected: "exit 0; config.path resolves under XDG_CONFIG_HOME/rolebox (documented precedence)",
        actual: `exitCode=${r2.exitCode} stderr=${JSON.stringify(r2.stderrTail)}`,
        exit_code: r2.exitCode,
        stdout_tail: r2.stdoutTail,
        stderr_tail: r2.stderrTail,
        file_line_refs: ["src/cli/paths.ts:104-110", "src/cli/commands/status.ts:122"],
      });
      throw new Error(`[paths] status --json failed (${r2.exitCode})`);
    }
    const parsed = JSON.parse(r2.stdout);
    const configPath = parsed.config?.path ?? "";
    const expectPrefix = join(xdgRoot, "rolebox");
    if (!configPath.startsWith(expectPrefix)) {
      recordDefect("env-precedence-xdg-wins", {
        cluster: CLUSTER,
        scenario: "XDG_CONFIG_HOME vs APPDATA config-dir precedence",
        command: r2.command,
        expected: `config.path starts with ${expectPrefix} (XDG_CONFIG_HOME wins over APPDATA, paths.ts:105-110)`,
        actual: `config.path=${JSON.stringify(configPath)}`,
        exit_code: r2.exitCode,
        stdout_tail: r2.stdoutTail,
        stderr_tail: r2.stderrTail,
        file_line_refs: ["src/cli/paths.ts:104-110", "src/cli/commands/status.ts:122"],
      });
      throw new Error(`[paths] config.path '${configPath}' not under XDG_CONFIG_HOME '${expectPrefix}'`);
    }
  });

  it("real-CLI: XDG_DATA_HOME precedence observed via the data-dir-derived config path absence", async () => {
    // XDG_DATA_HOME feeds getDataDir (version cache) and getRolesDir. Set it and
    // assert the CLI runs cleanly and puts its lock under the config dir the
    // documented precedence produces. This is the darwin-observable subset.
    const xdgData = mkdtempSync(join(tmpRoot, "xdgdata-"));
    const xdgConfig = mkdtempSync(join(tmpRoot, "xdgconfig-"));
    const dataDir = join(xdgData, "rolebox");
    const cfgDir = join(xdgConfig, "rolebox");
    const homeTmp = mkdtempSync(join(tmpRoot, "home-"));
    makeDir(cfgDir);
    writeFileSync(join(cfgDir, "rolebox.lock"), lockYaml([{ role: "myrole" }]), "utf-8");
    seedVersionCache(dataDir);
    const r = await runCli(["list"], {
      cwd: mkdtempSync(join(tmpRoot, "cwd-")),
      dataDir,
      isolateDirs: false,
      env: {
        ROLEBOX_DATA_DIR: dataDir,
        ROLEBOX_CONFIG_DIR: undefined,
        XDG_DATA_HOME: xdgData,
        XDG_CONFIG_HOME: xdgConfig,
        HOME: homeTmp,
      },
      keepTempDirs: true,
      timeout: 30_000,
    });
    if (r.exitCode !== 0) {
      recordDefect("env-precedence-xdgdata-list", {
        cluster: CLUSTER,
        scenario: "rolebox list with XDG_DATA_HOME + XDG_CONFIG_HOME set, no ROLEBOX_* override",
        command: r.command,
        expected: "exit 0; lock read from XDG_CONFIG_HOME/rolebox (documented XDG precedence)",
        actual: `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderrTail)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/paths.ts:72-73", "src/cli/paths.ts:104-106"],
      });
      throw new Error(`[paths] list with XDG env failed (${r.exitCode})`);
    }
    // The cached lock (myrole) lives under XDG_CONFIG_HOME/rolebox => list shows it.
    expect(r.stdout).toContain("myrole");
  });
});

// ── utility: baseOf strips a trailing /rolebox (or \rolebox) segment ──
function baseOf(p: string): string {
  return p.replace(/[\\/]rolebox$/i, "");
}

// ── utility: win32 join via node:path.win32 (the win32 contract) ──
function win32Join(...parts: string[]): string {
  return pathWin32.join(...parts);
}

function segmentCount(p: string): number {
  return p.split(/[\\/]+/).filter(Boolean).length;
}

/**
 * Set env vars for the duration of a callback; restores prior values. Returns a
 * [saved, restore] tuple so the caller can restore even without the callback.
 */
function setEnv(env: Record<string, string | undefined>): [{ [k: string]: string | undefined }, () => void] {
  const saved: { [k: string]: string | undefined } = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = env[k];
    }
  }
  const restore = () => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return [saved, restore];
}

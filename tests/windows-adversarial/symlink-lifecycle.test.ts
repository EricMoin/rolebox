// tests/windows-adversarial/symlink-lifecycle.test.ts
//
// Subtask 4 / Cluster C — sync / uninstall / symlink lifecycle.
//
// Adversarial Windows tests that drive the REAL compiled CLI (bun
// dist/cli/main.js) against a locally installed fixture role. On a Windows CI
// runner (subtask 8) these catch the suspected "unlinkSync on a junction"
// defect family; on darwin they run the equivalent POSIX-symlink paths so the
// harness itself is proven healthy, and the Windows-only junction semantics are
// exercised via setPlatformForTest("win32") sims + a scoped node:fs mock so no
// scenario is silently skipped.
//
// Sources of truth under test:
//   src/utils/symlink.ts:26-47   createDirSymlink (junction on win32, EPERM-warn)
//   src/utils/symlink.ts:58-76   createFileSymlink (EPERM-warning contract)
//   src/utils/symlink.ts:29-32   win32 forward-slash -> native normalization
//   src/cli/commands/uninstall.ts:66-67  unlinkSync on junction (rmdir required)
//   src/cli/commands/uninstall.ts:69-71  catch swallows the EPERM -> stale junction
//   src/cli/commands/sync.ts:56-58       re-sync unlinkSync on existing junction (uncaught)
//   src/cli/commands/status.ts:92        symlinkValid broken reporting
//   src/cli/commands/info.ts:235-238     "target is missing" reporting
//
// Every violated assertion calls recordDefect() with file:line refs BEFORE the
// assertion fails — a failed test is the deliverable, never a silent skip.
//
// HARD RULE: this file never modifies production source under src/.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dump } from "js-yaml";
import { recordDefect, type DefectDetail } from "./helpers/evidence";
import { runCli, seedVersionCache } from "./helpers/cli";
import { setPlatformForTest } from "../../src/cli/paths";
import {
  createDirSymlink,
  createFileSymlink,
  isSymlink,
} from "../helpers/symlink";
import { uninstall } from "../../src/cli/commands/uninstall";
import { sync as runSync } from "../../src/cli/commands/sync";

// ── Campaign constants ──────────────────────────────────────────────────

const CLUSTER = "symlink";
const REGISTRY = "hub";
const ROLE_ID = "adversary-fixture";
const ROLE_VERSION = "1.0.0";

/** Log the host platform + sim status so nothing is silently skipped. */
const HOST_PLATFORM = process.platform;

// ── Fixture model ───────────────────────────────────────────────────────

interface Fixture {
  tmpRoot: string;
  dataDir: string; // ROLEBOX_DATA_DIR (role sources live here)
  configDir: string; // ROLEBOX_CONFIG_DIR (rolebox.lock lives here)
  xdgConfig: string; // XDG_CONFIG_HOME (opencode config/sync target root)
  piAgentDir: string; // PI_CODING_AGENT_DIR (pi sync target root)
  dshHome: string; // DSH_HOME (dsh sync target root)
  rolePath: string; // {dataDir}/roles/{registry}/{role}@{version}
  syncTargets: {
    opencode: string; // {xdg}/opencode/rolebox
    pi: string; // {piAgent}/rolebox
    dsh: string; // {dshHome}/rolebox
  };
  opencodeSkillsDir: string; // {xdg}/opencode/skills
}

/** Absolute sync-target directory for a target id, matching paths.ts resolution. */
function syncTargetFor(
  target: string,
  fx: { xdgConfig: string; piAgentDir: string; dshHome: string },
): string {
  switch (target) {
    case "opencode":
      return join(fx.xdgConfig, "opencode", "rolebox");
    case "pi":
      return join(fx.piAgentDir, "rolebox");
    case "dsh":
      return join(fx.dshHome, "rolebox");
    default:
      throw new Error(`unexpected sync target: ${target}`);
  }
}

/**
 * Build a self-contained, isolated fixture: a role directory (role.yaml +
 * optional skills) and a populated rolebox.lock. Everything lives under a fresh
 * mkdtemp tree so running the CLI can never touch real user data.
 */
function makeFixture(opts: { withSkills?: boolean } = {}): Fixture {
  const tmpRoot = mkdtempSync(join(tmpdir(), "rolebox-wintest-symlink-"));
  const dataDir = join(tmpRoot, "data");
  const configDir = join(tmpRoot, "config");
  const xdgConfig = join(tmpRoot, "xdg");
  const piAgentDir = join(tmpRoot, "pi-agent");
  const dshHome = join(tmpRoot, "dsh-home");

  for (const dir of [dataDir, configDir, xdgConfig, piAgentDir, dshHome]) {
    mkdirSync(dir, { recursive: true });
  }

  // Role source: {dataDir}/roles/{registry}/{role}@{version}
  const rolePath = join(dataDir, "roles", REGISTRY, `${ROLE_ID}@${ROLE_VERSION}`);
  mkdirSync(rolePath, { recursive: true });
  writeFileSync(
    join(rolePath, "role.yaml"),
    `name: ${ROLE_ID}\ndescription: Windows adversarial fixture\n`,
    "utf-8",
  );

  if (opts.withSkills) {
    // A single-file skill (the createFileSymlink path) plus a directory skill.
    const skillsDir = join(rolePath, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "single-file-skill.md"), "# single\n", "utf-8");
    const dirSkill = join(skillsDir, "dir-skill");
    mkdirSync(dirSkill, { recursive: true });
    writeFileSync(join(dirSkill, "SKILL.md"), "# dir skill\n", "utf-8");
  }

  // Lock file at {configDir}/rolebox.lock (must be a real rolebox.lock entry).
  writeFileSync(
    join(configDir, "rolebox.lock"),
    dump({
      version: 1,
      roles: [
        {
          role: ROLE_ID,
          registry: REGISTRY,
          version: ROLE_VERSION,
          installedAt: "2025-01-01T00:00:00Z",
          integrity: "sha256-adversarial-fixture",
        },
      ],
    }),
    "utf-8",
  );

  // Keep the CLI hermetic: pre-seed the version-check cache (no npm registry call).
  seedVersionCache(dataDir);

  return {
    tmpRoot,
    dataDir,
    configDir,
    xdgConfig,
    piAgentDir,
    dshHome,
    rolePath,
    syncTargets: {
      opencode: syncTargetFor("opencode", { xdgConfig, piAgentDir, dshHome }),
      pi: syncTargetFor("pi", { xdgConfig, piAgentDir, dshHome }),
      dsh: syncTargetFor("dsh", { xdgConfig, piAgentDir, dshHome }),
    },
    opencodeSkillsDir: join(xdgConfig, "opencode", "skills"),
  };
}

/** Recursively collect every descendant path under `dir` (an empty dir => []). */
function collectChildren(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    out.push(p);
    try {
      const s = lstatSync(p);
      // Only recurse into real directories (never follow a symlink/junction).
      if (s.isDirectory() && !s.isSymbolicLink()) {
        out.push(...collectChildren(p));
      }
    } catch {
      // Dangling link or unreadable — still counted as a present child.
    }
  }
  return out;
}

/** lstat-based existence (a dangling symlink "exists" via lstat, not stat). */
function lerpExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Record a defect into the campaign cluster (never throws). */
function defect(
  testId: string,
  detail: Omit<DefectDetail, "cluster">,
): void {
  recordDefect(testId, { ...detail, cluster: CLUSTER });
}

/**
 * Assert a condition; if false, RECORD the defect (cluster symlink) then fail the
 * test. This is the campaign's core discipline — a violated assertion always
 * leaves evidence behind before the test is marked failed.
 */
function assertNoDefect(
  cond: boolean,
  testId: string,
  detail: Omit<DefectDetail, "cluster">,
): void {
  if (!cond) {
    defect(testId, detail);
    throw new Error(`[symlink-lifecycle] DEFECT ${testId}: ${detail.actual}`);
  }
}

/** Per-run env overlay for the real CLI child process. */
function cliEnv(fx: Fixture): Record<string, string> {
  return {
    XDG_CONFIG_HOME: fx.xdgConfig,
    PI_CODING_AGENT_DIR: fx.piAgentDir,
    DSH_HOME: fx.dshHome,
  };
}

/** Temporarily overlay env for an async in-process unit, then restore. */
async function withEnvAsync(
  overrides: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(overrides);
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────

const createdFixtures: Fixture[] = [];

afterEach(() => {
  setPlatformForTest(undefined);
  for (const fx of createdFixtures.splice(0)) {
    try {
      rmSync(fx.tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// ── Describe block ───────────────────────────────────────────────────────

describe("windows-adversarial: symlink lifecycle (sync/uninstall/symlink)", () => {
  console.log(
    `[symlink-lifecycle] platform=${HOST_PLATFORM}; junction/EPERM behavior ` +
      `${HOST_PLATFORM === "win32" ? "exercised natively" : "reproduced via node:fs mock sims"}`,
  );

  // ── Scenario 1: `rolebox sync opencode` ────────────────────────────────
  it("scenario 1: rolebox sync opencode creates dir junctions and honours the file-symlink EPERM contract", async () => {
    const fx = makeFixture({ withSkills: true });
    createdFixtures.push(fx);

    const r = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });

    // A hard crash (non-zero exit, timeout, spawn/build failure, or an unhandled
    // stack trace in stderr) is a defect.
    assertNoDefect(
      r.exitCode === 0 && !r.timedOut && !r.spawnError && !r.buildError,
      "scenario1-sync-hard-crash",
      {
        scenario: "rolebox sync opencode must not hard-crash on a non-elevated runner",
        command: r.command,
        expected: "exit 0, no timeout, no unhandled stack trace",
        actual: `exitCode=${r.exitCode} timedOut=${r.timedOut} spawnError=${r.spawnError ?? "none"} buildError=${r.buildError ?? "none"} stderrTail=${r.stderrTail.trim().slice(-400) || "(empty)"}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:21", "src/utils/symlink.ts:26-47"],
      },
    );

    // Dir junction created: the sync-target entry must be a symlink.
    const dirLink = join(fx.syncTargets.opencode, ROLE_ID);
    assertNoDefect(
      existsSync(fx.syncTargets.opencode) && isSymlink(dirLink),
      "scenario1-junction-missing",
      {
        scenario: "rolebox sync opencode must create a dir junction for each synced role",
        command: r.command,
        expected: `${dirLink} exists and lstatSync().isSymbolicLink() === true`,
        actual: isSymlink(dirLink)
          ? "junction present"
          : `junction missing (syncTarget exists=${existsSync(fx.syncTargets.opencode)}, link exists=${existsSync(dirLink)})`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:53", "src/utils/symlink.ts:26-47"],
      },
    );

    // The junction must point at the role source path.
    assertNoDefect(
      readlinkSync(dirLink) === fx.rolePath,
      "scenario1-junction-target-mismatch",
      {
        scenario: "synced dir junction must resolve to the role source path",
        command: r.command,
        expected: `readlink(${dirLink}) === ${fx.rolePath}`,
        actual: `readlink=${readlinkSync(dirLink)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:53", "src/cli/paths.ts:178-183"],
      },
    );

    // Skill FILE symlink: the runtime deploys skill file symlinks via
    // createFileSymlink (src/utils/symlink.ts:58-76). It must either succeed
    // (real symlink) or fail with an EPERM error (Developer-Mode requirement) —
    // a hard crash or a silently-swallowed non-EPERM error is a defect.
    const skillFile = join(fx.rolePath, "skills", "single-file-skill.md");
    const skillsEntry = join(fx.opencodeSkillsDir, "rolebox--single-file-skill");
    mkdirSync(skillsEntry, { recursive: true });
    const skillLink = join(skillsEntry, "SKILL.md");
    let fileSymlinkOutcome = "not-tested";
    try {
      createFileSymlink(skillFile, skillLink);
      fileSymlinkOutcome = isSymlink(skillLink) ? "created" : "created-but-not-symlink";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Contract at symlink.ts:58-76: EPERM is the one accepted failure mode
      // (logged with an actionable warning, rethrown, never silently swallowed).
      fileSymlinkOutcome = code === "EPERM" ? "EPERM-warning" : `non-EPERM:${code ?? "unknown"}`;
    }

    assertNoDefect(
      fileSymlinkOutcome === "created" || fileSymlinkOutcome === "EPERM-warning",
      "scenario1-file-symlink-eprem-contract",
      {
        scenario:
          "skill FILE symlink (createFileSymlink) must succeed or fail with an actionable EPERM warning",
        command: `createFileSymlink(${skillFile}, ${skillLink})`,
        expected: "symlink created, OR EPERM error naming Developer Mode / admin rights",
        actual: fileSymlinkOutcome,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/utils/symlink.ts:58-76"],
      },
    );
  });

  // ── Scenario 2: `rolebox uninstall <role>` after sync ──────────────────
  it("scenario 2: rolebox uninstall removes every junction/link under every sync target", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    // Sync once so the opencode sync target has a junction.
    const syncRes = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    assertNoDefect(
      syncRes.exitCode === 0,
      "scenario2-presync-failed",
      {
        scenario: "scenario 2 precondition: sync opencode must succeed",
        command: syncRes.command,
        expected: "exit 0",
        actual: `exitCode=${syncRes.exitCode} stderrTail=${syncRes.stderrTail.trim().slice(-300) || "(empty)"}`,
        exit_code: syncRes.exitCode,
        stdout_tail: syncRes.stdoutTail,
        stderr_tail: syncRes.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:21"],
      },
    );

    const un = await runCli(["uninstall", ROLE_ID], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });

    // After uninstall, EVERY sync target dir must be empty of junctions/links.
    const stale: string[] = [];
    for (const target of ["opencode", "pi", "dsh"] as const) {
      const dir = fx.syncTargets[target];
      if (existsSync(dir)) {
        for (const c of collectChildren(dir)) stale.push(`${target}:${c}`);
      }
    }

    assertNoDefect(
      un.exitCode === 0 && stale.length === 0,
      "scenario2-uninstall-stale-junction",
      {
        scenario:
          "rolebox uninstall must remove ALL junctions/links under every sync target (suspected unlinkSync-on-junction defect)",
        command: un.command,
        expected: "all sync target dirs empty after uninstall (junction removed)",
        actual:
          stale.length > 0
            ? `stale junctions/links remain: ${stale.join(", ")}`
            : `uninstall exit=${un.exitCode} (unexpected non-zero)`,
        exit_code: un.exitCode,
        stdout_tail: un.stdoutTail,
        stderr_tail: un.stderrTail,
        file_line_refs: [
          "src/cli/commands/uninstall.ts:66-67",
          "src/cli/commands/uninstall.ts:69-71",
        ],
      },
    );

    // The lock entry must be gone too (uninstall removes the role from the lock).
    const lockRaw = readFileSync(join(fx.configDir, "rolebox.lock"), "utf-8");
    assertNoDefect(
      !lockRaw.includes(ROLE_ID),
      "scenario2-uninstall-lock-not-removed",
      {
        scenario: "rolebox uninstall must remove the role from rolebox.lock",
        command: un.command,
        expected: `"${ROLE_ID}" absent from rolebox.lock`,
        actual: "role still present in lock",
        exit_code: un.exitCode,
        stdout_tail: un.stdoutTail,
        stderr_tail: un.stderrTail,
        file_line_refs: ["src/cli/commands/uninstall.ts:79"],
      },
    );
  });

  // ── Scenario 3: broken-junction resilience ─────────────────────────────
  it("scenario 3: broken-junction resilience — status/info/sync survive a dangling junction", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    // Sync, then delete the role source dir to create a dangling junction.
    const sync1 = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    const dirLink = join(fx.syncTargets.opencode, ROLE_ID);
    assertNoDefect(
      sync1.exitCode === 0 && isSymlink(dirLink),
      "scenario3-presync-failed",
      {
        scenario: "scenario 3 precondition: sync must create a junction before the data dir is removed",
        command: sync1.command,
        expected: "exit 0 and junction present",
        actual: `exitCode=${sync1.exitCode} junction=${isSymlink(dirLink)}`,
        exit_code: sync1.exitCode,
        stdout_tail: sync1.stdoutTail,
        stderr_tail: sync1.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:53"],
      },
    );

    // Delete the role data dir -> dangling junction.
    rmSync(fx.rolePath, { recursive: true, force: true });
    assertNoDefect(
      lerpExists(dirLink) && isSymlink(dirLink) && !existsSync(fx.rolePath),
      "scenario3-dangling-not-prepared",
      {
        scenario: "scenario 3 precondition: junction must be dangling after data dir removal",
        command: "rmSync(rolePath)",
        expected: "link exists via lstat but target missing (dangling)",
        actual: `link lstatExists=${lerpExists(dirLink)} isSymlink=${isSymlink(dirLink)} rolePathExists=${existsSync(fx.rolePath)}`,
        exit_code: sync1.exitCode,
        stdout_tail: sync1.stdoutTail,
        stderr_tail: sync1.stderrTail,
        file_line_refs: ["src/cli/commands/status.ts:92"],
      },
    );

    // (a) `rolebox status --json` must exit cleanly and report the break.
    const st = await runCli(["status", "--json"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    assertNoDefect(
      st.exitCode === 0 && !st.timedOut && !/ENOENT/.test(st.stderr) && !/Error:\s/.test(st.stderr),
      "scenario3-status-does-not-crash",
      {
        scenario: "rolebox status must not crash (no unhandled ENOENT) with a dangling junction",
        command: st.command,
        expected: "exit 0, no ENOENT / stack trace in stderr",
        actual: `exitCode=${st.exitCode} timedOut=${st.timedOut} stderrTail=${st.stderrTail.trim().slice(-300) || "(empty)"}`,
        exit_code: st.exitCode,
        stdout_tail: st.stdoutTail,
        stderr_tail: st.stderrTail,
        file_line_refs: ["src/cli/commands/status.ts:92", "src/cli/format.ts:107-150"],
      },
    );
    assertNoDefect(
      statusReportsBroken(st.stdout, ROLE_ID),
      "scenario3-status-broken-not-reported",
      {
        scenario: "rolebox status must report the dangling junction as a broken link",
        command: st.command,
        expected: `JSON roles[${ROLE_ID}].synced=true and symlinkValid=false`,
        actual: extractStatusRole(st.stdout, ROLE_ID),
        exit_code: st.exitCode,
        stdout_tail: st.stdoutTail,
        stderr_tail: st.stderrTail,
        file_line_refs: ["src/cli/commands/status.ts:92"],
      },
    );

    // (b) `rolebox info <role> --json` must exit cleanly and report break.
    const info = await runCli(["info", ROLE_ID, "--json"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    assertNoDefect(
      info.exitCode === 0 && !info.timedOut && !/ENOENT/.test(info.stderr) && !/Error:\s/.test(info.stderr),
      "scenario3-info-does-not-crash",
      {
        scenario: "rolebox info must not crash (no unhandled ENOENT) with a dangling junction",
        command: info.command,
        expected: "exit 0, no ENOENT / stack trace in stderr",
        actual: `exitCode=${info.exitCode} timedOut=${info.timedOut} stderrTail=${info.stderrTail.trim().slice(-300) || "(empty)"}`,
        exit_code: info.exitCode,
        stdout_tail: info.stdoutTail,
        stderr_tail: info.stderrTail,
        file_line_refs: ["src/cli/commands/info.ts:235-238", "src/cli/format.ts:107-150"],
      },
    );
    assertNoDefect(
      infoReportsBroken(info.stdout),
      "scenario3-info-broken-not-reported",
      {
        scenario: "rolebox info must report 'symlink exists but target is missing'",
        command: info.command,
        expected: "JSON sync.synced=true and sync.symlinkValid=false",
        actual: extractInfoSync(info.stdout),
        exit_code: info.exitCode,
        stdout_tail: info.stdoutTail,
        stderr_tail: info.stderrTail,
        file_line_refs: ["src/cli/commands/info.ts:235-238"],
      },
    );

    // (c) `rolebox sync opencode` must exit cleanly.
    const sync2 = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    assertNoDefect(
      sync2.exitCode === 0 && !sync2.timedOut && !/ENOENT/.test(sync2.stderr),
      "scenario3-sync-does-not-crash",
      {
        scenario: "rolebox sync must not crash (no unhandled ENOENT) with a dangling junction",
        command: sync2.command,
        expected: "exit 0, no ENOENT / stack trace in stderr",
        actual: `exitCode=${sync2.exitCode} timedOut=${sync2.timedOut} stderrTail=${sync2.stderrTail.trim().slice(-300) || "(empty)"}`,
        exit_code: sync2.exitCode,
        stdout_tail: sync2.stdoutTail,
        stderr_tail: sync2.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:80-85"],
      },
    );
  });

  // ── Scenario 4: junction target with forward-slash POSIX path ──────────
  it("scenario 4: junction creation with a forward-slash POSIX-style target succeeds", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    // Black-box: sync with a role source path that is a native (POSIX) forward-slash
    // path on darwin. The junction must still be created end-to-end.
    const r = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    const dirLink = join(fx.syncTargets.opencode, ROLE_ID);
    assertNoDefect(
      r.exitCode === 0 && isSymlink(dirLink),
      "scenario4-forward-slash-target-fails",
      {
        scenario: "dir junction creation must succeed even though the source path is a POSIX forward-slash path",
        command: r.command,
        expected: "sync exit 0 and junction created",
        actual: `exitCode=${r.exitCode} junction=${isSymlink(dirLink)}`,
        exit_code: r.exitCode,
        stdout_tail: r.stdoutTail,
        stderr_tail: r.stderrTail,
        file_line_refs: ["src/utils/symlink.ts:29-32", "src/cli/commands/sync.ts:53"],
      },
    );

    // win32 path: the production helper must normalize a forward-slash target/link
    // to native backslashes and pass "junction" as the libuv type.
    setPlatformForTest("win32");
    const calls: Array<[string, string, string]> = [];
    const spy = spyOn(nodeFs, "symlinkSync").mockImplementation(
      ((target: unknown, link: unknown, type?: string) => {
        calls.push([String(target), String(link), String(type ?? "undefined")]);
      }) as typeof nodeFs.symlinkSync,
    );
    try {
      const symlinkMod = await import("../../src/utils/symlink.ts");
      symlinkMod.createDirSymlink("C:/skills/a/b", "C:/rolebox/link");
      assertNoDefect(
        calls.length === 1 &&
          calls[0][2] === "junction" &&
          calls[0][0] === "C:\\skills\\a\\b" &&
          calls[0][1] === "C:\\rolebox\\link",
        "scenario4-win32-normalization-defect",
        {
          scenario:
            "createDirSymlink must normalize a forward-slash POSIX target to native separators for the junction",
          command: "createDirSymlink('C:/skills/a/b', 'C:/rolebox/link') under setPlatformForTest('win32')",
          expected: "fs.symlinkSync('C:\\skills\\a\\b', 'C:\\rolebox\\link', 'junction')",
          actual: `calls=${JSON.stringify(calls)}`,
          exit_code: null,
          stdout_tail: "",
          stderr_tail: "",
          file_line_refs: ["src/utils/symlink.ts:29-32"],
        },
      );
    } finally {
      spy.mockRestore();
      setPlatformForTest(undefined);
    }
  });

  // ── Scenario 5: re-sync idempotency ────────────────────────────────────
  it("scenario 5: re-sync is idempotent — second run does not EEXIST-crash", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    const first = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });
    assertNoDefect(
      first.exitCode === 0,
      "scenario5-first-sync-failed",
      {
        scenario: "scenario 5 precondition: first sync must succeed",
        command: first.command,
        expected: "exit 0",
        actual: `exitCode=${first.exitCode} stderrTail=${first.stderrTail.trim().slice(-300) || "(empty)"}`,
        exit_code: first.exitCode,
        stdout_tail: first.stdoutTail,
        stderr_tail: first.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:21"],
      },
    );

    const second = await runCli(["sync", "opencode"], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      configDir: fx.configDir,
      env: cliEnv(fx),
      keepTempDirs: true,
      timeout: 30_000,
    });

    // A second sync must not EEXIST-crash. On win32 the unlinkSync at sync.ts:56
    // throws EPERM on an existing junction -> uncaught -> hard crash (defect).
    assertNoDefect(
      second.exitCode === 0 &&
        !second.timedOut &&
        !/EEXIST/.test(second.stderr) &&
        !/EISDIR/.test(second.stderr),
      "scenario5-resync-eexist-crash",
      {
        scenario:
          "running rolebox sync opencode twice must not crash on the second run (suspected unlinkSync-on-junction / EEXIST)",
        command: second.command,
        expected: "second sync exit 0, no EEXIST/EISDIR crash",
        actual: `exitCode=${second.exitCode} timedOut=${second.timedOut} stderrTail=${second.stderrTail.trim().slice(-400) || "(empty)"}`,
        exit_code: second.exitCode,
        stdout_tail: second.stdoutTail,
        stderr_tail: second.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:56", "src/cli/commands/sync.ts:57"],
      },
    );

    // The junction must still be valid after re-sync.
    const dirLink = join(fx.syncTargets.opencode, ROLE_ID);
    assertNoDefect(
      isSymlink(dirLink) && readlinkSync(dirLink) === fx.rolePath,
      "scenario5-resync-junction-invalid",
      {
        scenario: "re-sync must leave a valid junction pointing at the role source",
        command: second.command,
        expected: `junction present and readlink === ${fx.rolePath}`,
        actual: `isSymlink=${isSymlink(dirLink)} readlink=${isSymlink(dirLink) ? readlinkSync(dirLink) : "(missing)"}`,
        exit_code: second.exitCode,
        stdout_tail: second.stdoutTail,
        stderr_tail: second.stderrTail,
        file_line_refs: ["src/cli/commands/sync.ts:56-58"],
      },
    );
  });

  // ── Sim: reproduce the Windows unlinkSync-on-junction defect (scenario 2) ──
  //
  // libuv only accepts junction creation on win32, so on darwin we cannot make a
  // real junction. Instead we faithfully simulate the WINDOWS OS behavior that
  // uninstall trips over: `fs.unlinkSync` on a directory junction throws EPERM.
  // We place a real (POSIX) directory symlink in the sync target, mock unlinkSync
  // to throw EPERM for sync-target entries (Windows junction semantics), and run
  // the production `uninstall` in-process. If the junction survives, the suspected
  // defect at uninstall.ts:66-67 is reproduced and recorded.
  it("sim(win32): uninstall leaves a stale junction when unlinkSync throws EPERM (junction needs rmdir)", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    const syncTarget = fx.syncTargets.opencode;
    mkdirSync(syncTarget, { recursive: true });
    const dirLink = join(syncTarget, ROLE_ID);
    createDirSymlink(fx.rolePath, dirLink);
    if (!isSymlink(dirLink)) {
      console.warn(
        `[symlink-lifecycle] sim(win32) could not prepare a directory symlink on ${HOST_PLATFORM}; ` +
          `sim skipped with reason: host cannot create a directory symlink`,
      );
      return;
    }

    await withEnvAsync(
      {
        ROLEBOX_DATA_DIR: fx.dataDir,
        ROLEBOX_CONFIG_DIR: fx.configDir,
        XDG_CONFIG_HOME: fx.xdgConfig,
        PI_CODING_AGENT_DIR: fx.piAgentDir,
        DSH_HOME: fx.dshHome,
      },
      async () => {
        // Windows junction semantics: unlinkSync fails with EPERM on a junction.
        const realUnlinkSync = nodeFs.unlinkSync;
        const spy = spyOn(nodeFs, "unlinkSync").mockImplementation(
          ((p: unknown) => {
            const ps = String(p);
            const underTarget =
              ps.startsWith(fx.syncTargets.opencode) ||
              ps.startsWith(fx.syncTargets.pi) ||
              ps.startsWith(fx.syncTargets.dsh);
            if (underTarget) {
              const err = new Error(`EPERM: operation not permitted, unlink '${ps}'`);
              (err as NodeJS.ErrnoException).code = "EPERM";
              throw err;
            }
            return realUnlinkSync(p as Parameters<typeof nodeFs.unlinkSync>[0]);
          }) as typeof nodeFs.unlinkSync,
        );

        let threw: unknown = null;
        try {
          await uninstall(ROLE_ID);
        } catch (err) {
          threw = err;
        } finally {
          spy.mockRestore();
        }

        if (threw !== null) {
          defect("sim-uninstall-unexpected-throw", {
            scenario:
              "uninstall with a Windows-junction-like entry must not propagate an error (it should clean up or warn)",
            command: "uninstall(" + ROLE_ID + ") in-process (unlinkSync mocked to EPERM)",
            expected: "uninstall resolves; junction cleaned OR an actionable warning emitted",
            actual: `uninstall threw: ${String(threw).slice(0, 400)}`,
            exit_code: null,
            stdout_tail: "",
            stderr_tail: String(threw).slice(0, 400),
            file_line_refs: ["src/cli/commands/uninstall.ts:66-67"],
          });
        }

        // The defect: the junction survived uninstall (stale) AND the lock entry was
        // dropped — a dangling/duplicated junction is left behind.
        const staleJunction = lerpExists(dirLink) && isSymlink(dirLink);
        const lockStillRefsRole = readFileSync(
          join(fx.configDir, "rolebox.lock"),
          "utf-8",
        ).includes(ROLE_ID);
        assertNoDefect(
          !staleJunction,
          "sim-uninstall-unlink-on-junction",
          {
            scenario:
              "[win32 sim] uninstall must remove the junction even though unlinkSync throws EPERM (junction removal requires rmdir/rm)",
            command: "uninstall(" + ROLE_ID + ") with fs.unlinkSync mocked to EPERM for sync-target paths (Windows junction semantics)",
            expected: "sync target empty after uninstall",
            actual: staleJunction
              ? `junction SURVIVED uninstall (stale): ${dirLink} (lock still references role: ${lockStillRefsRole})`
              : "junction removed",
            exit_code: null,
            stdout_tail: "",
            stderr_tail: "",
            file_line_refs: [
              "src/cli/commands/uninstall.ts:66-67",
              "src/cli/commands/uninstall.ts:69-71",
            ],
          },
        );
      },
    );
  });

  // ── Sim: reproduce the Windows re-sync unlinkSync-on-junction crash (scenario 5) ──
  it("sim(win32): re-sync hard-crashes when unlinkSync throws EPERM on an existing junction", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    const syncTarget = fx.syncTargets.opencode;
    mkdirSync(syncTarget, { recursive: true });
    const dirLink = join(syncTarget, ROLE_ID);
    createDirSymlink(fx.rolePath, dirLink);

    await withEnvAsync(
      {
        ROLEBOX_DATA_DIR: fx.dataDir,
        ROLEBOX_CONFIG_DIR: fx.configDir,
        XDG_CONFIG_HOME: fx.xdgConfig,
        PI_CODING_AGENT_DIR: fx.piAgentDir,
        DSH_HOME: fx.dshHome,
      },
      async () => {
        const realUnlinkSync = nodeFs.unlinkSync;
        const spy = spyOn(nodeFs, "unlinkSync").mockImplementation(
          ((p: unknown) => {
            const ps = String(p);
            const underTarget =
              ps.startsWith(fx.syncTargets.opencode) ||
              ps.startsWith(fx.syncTargets.pi) ||
              ps.startsWith(fx.syncTargets.dsh);
            if (underTarget) {
              const err = new Error(`EPERM: operation not permitted, unlink '${ps}'`);
              (err as NodeJS.ErrnoException).code = "EPERM";
              throw err;
            }
            return realUnlinkSync(p as Parameters<typeof nodeFs.unlinkSync>[0]);
          }) as typeof nodeFs.unlinkSync,
        );

        let resolved = false;
        let thrown: unknown = null;
        try {
          await runSync("opencode");
          resolved = true;
        } catch (err) {
          thrown = err;
        } finally {
          spy.mockRestore();
        }

        // On Windows, sync.ts:56 unlinkSync is NOT wrapped in try/catch, so the
        // EPERM escapes and `sync` rejects (the CLI exits non-zero with a stack
        // trace). That is the re-sync hard-crash defect.
        assertNoDefect(
          resolved,
          "sim-resync-unlink-on-junction-crash",
          {
            scenario:
              "[win32 sim] re-running sync must not hard-crash on an existing junction (unlinkSync throws EPERM, uncaught at sync.ts:56)",
            command: "sync('opencode') in-process with fs.unlinkSync mocked to EPERM for an existing junction",
            expected: "sync resolves without throwing (EPERM handled / junction replaced)",
            actual: resolved
              ? "sync resolved"
              : `sync THREW (hard-crash path): ${String(thrown).slice(0, 400)}`,
            exit_code: null,
            stdout_tail: "",
            stderr_tail: String(thrown ?? "").slice(0, 400),
            file_line_refs: ["src/cli/commands/sync.ts:56"],
          },
        );
      },
    );
  });

  // ── Round 2: re-sync idempotency to pi / dsh targets (not just opencode) ──
  it("round2: re-sync to pi and dsh targets is idempotent (3 runs) with no EPERM/EEXIST crash", async () => {
    const fx = makeFixture();
    createdFixtures.push(fx);

    for (const target of ["pi", "dsh"] as const) {
      const targetPath = syncTargetFor(target, {
        xdgConfig: fx.xdgConfig,
        piAgentDir: fx.piAgentDir,
        dshHome: fx.dshHome,
      });
      mkdirSync(targetPath, { recursive: true });

      for (let run = 1; run <= 3; run++) {
        const r = await runCli(["sync", target], {
          cwd: fx.dataDir,
          dataDir: fx.dataDir,
          configDir: fx.configDir,
          env: cliEnv(fx),
          keepTempDirs: true,
          timeout: 30_000,
        });
        const hasRawFsError = /EEXIST|EISDIR|EPERM/i.test(r.stderr);
        assertNoDefect(
          r.exitCode === 0 && !r.timedOut && !hasRawFsError,
          `round2-${target}-sync-run${run}-crash`,
          {
            scenario: `running rolebox sync ${target} (run ${run}) on an existing junction must not hard-crash (unlinkSync EPERM at sync.ts:56)`,
            command: r.command,
            expected: "exit 0, no EEXIST/EISDIR/EPERM crash",
            actual: `exitCode=${r.exitCode} timedOut=${r.timedOut} stderrTail=${r.stderrTail.trim().slice(-300) || "(empty)"}`,
            exit_code: r.exitCode,
            stdout_tail: r.stdoutTail,
            stderr_tail: r.stderrTail,
            file_line_refs: ["src/cli/commands/sync.ts:56", "src/cli/commands/sync.ts:57"],
          },
        );
      }

      // The junction must still be valid after three re-syncs.
      const dirLink = join(targetPath, ROLE_ID);
      assertNoDefect(
        isSymlink(dirLink) && readlinkSync(dirLink) === fx.rolePath,
        `round2-${target}-junction-valid`,
        {
          scenario: `sync ${target} x3 must leave a valid junction pointing at the role source`,
          command: `(sync ${target} x3)`,
          expected: `junction present and readlink === ${fx.rolePath}`,
          actual: `isSymlink=${isSymlink(dirLink)} readlink=${isSymlink(dirLink) ? readlinkSync(dirLink) : "(missing)"}`,
          exit_code: null,
          stdout_tail: "",
          stderr_tail: "",
          file_line_refs: ["src/cli/commands/sync.ts:56-58"],
        },
      );
    }
  });
});

// ── Parsing helpers for status/info JSON ─────────────────────────────────

/** Extract the per-role status line from `rolebox status --json` output. */
function extractStatusRole(stdout: string, roleId: string): string {
  try {
    const j = JSON.parse(stdout);
    const role = (j.roles ?? []).find((r: { role: string }) => r.role === roleId);
    return role ? JSON.stringify(role) : "role-not-in-status-json";
  } catch (e) {
    return `status-output-not-json: ${String(e).slice(0, 120)}`;
  }
}

/** True when status --json reports the role as a broken link (synced, target missing). */
function statusReportsBroken(stdout: string, roleId: string): boolean {
  try {
    const j = JSON.parse(stdout);
    const role = (j.roles ?? []).find((r: { role: string }) => r.role === roleId);
    return !!role && role.synced === true && role.symlinkValid === false;
  } catch {
    return false;
  }
}

/** Extract the sync block from `rolebox info <role> --json` output. */
function extractInfoSync(stdout: string): string {
  try {
    const j = JSON.parse(stdout);
    return JSON.stringify(j.sync ?? {});
  } catch (e) {
    return `info-output-not-json: ${String(e).slice(0, 120)}`;
  }
}

/** True when info --json reports the role as a broken link (synced, target missing). */
function infoReportsBroken(stdout: string): boolean {
  try {
    const j = JSON.parse(stdout);
    return !!j.sync && j.sync.synced === true && j.sync.symlinkValid === false;
  } catch {
    return false;
  }
}

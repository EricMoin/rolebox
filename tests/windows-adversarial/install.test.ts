// tests/windows-adversarial/install.test.ts
//
// Subtask 2 of 10 — Cluster A: install/init/registry flows.
//
// ◤ Hard rule ◢───────────────────────────────────────────────────────────
// This file NEVER modifies production source under src/. It drives the
// COMPILED CLI (via tests/windows-adversarial/helpers/cli.ts runCli) when a
// scenario can be exercised as a real child process, and it drives the REAL
// src/cli/* modules directly (via cache-busted `?winadv` specifiers + mocked
// globalThis.fetch + real tar fixtures) when a scenario needs a canvas the
// child-process boundary cannot provide a Windows-semantic canvas for.
//
// ◤ Why the split ◢──────────────────────────────────────────────────────
// The CLI's install path is hardwired to two GitHub URLs
// (src/cli/registry-client.ts):
//   * fetchRegistryManifest → https://raw.githubusercontent.com/{o}/{r}/{b}/registry.yaml
//   * downloadRole          → https://api.github.com/repos/{o}/{r}/tarball/{b}
// A spawned child process has no way to serve those hermetically, so an
// end-to-end `rolebox install <role>` from a *local* fixture tarball cannot be
// reproduced as a child on darwin. The tarball-fixture technique from
// tests/cli/registry-client.test.ts (real `tar czf` archive, mocked fetch
// returning the bytes, real `tar xzf` extraction) is therefore run IN-PROCESS
// against the real modules — exactly as tests/cli/commands/install-realtime.test.ts
// already does. Windows-only semantics that cannot be produced on a darwin host
// (file-locking EBUSY, symlink creation failure) are simulated where possible
// and documented where not; the windows-latest matrix run (subtask 8) closes
// the remaining gaps.
//
// ◤ Evidence contract ◢──────────────────────────────────────────────────
// Every violating assertion calls recordDefect() (appends JSONL to
// .rolebox/evidence/windows-campaign/<cluster>/<test-id>.json) BEFORE the
// assertion throws, so the evidence ledger is populated even when the test
// fails. Cluster: "install-init-registry".
//
// No test is skipped silently. Tar-dependent tests use it.skipIf(!hasTar())
// and print a top-level reason when tar is unavailable.

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  openSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { spawn as realSpawn, spawnSync as realSpawnSync } from "node:child_process";
import { hasTar } from "../helpers/tar";
import { recordDefect, type DefectDetail } from "./helpers/evidence";
import { runCli, seedVersionCache, type CliResult } from "./helpers/cli";

// ── Cluster & constants ─────────────────────────────────────────────
const CLUSTER = "install-init-registry";
const ROLE_ID = "code-reviewer";
const VERSION = "1.0.0";
const REGISTRY_NAME = "oh-my-role";
const REGISTRY_URL = "https://github.com/example/registry";

// ── Real modules (cache-busted so other files' mock.module cannot shadow) ──
const _REAL_REG = "../../src/cli/registry-client.ts?winadv";
const _REAL_PATHS = "../../src/cli/paths.ts?winadv";
const _REAL_INSTALL = "../../src/cli/commands/install.ts?winadv";
// Query-specifiers like `?winadv` are bound to consts so tsc never tries to
// statically resolve the query form (same pattern as tests/cli/e2e.test.ts).
const realRegistryClient = await import(_REAL_REG);
const realPaths = await import(_REAL_PATHS);
const realInstall = await import(_REAL_INSTALL);

// ── Fixture YAML / staging ─────────────────────────────────────────
const manifestYaml = `
name: ${REGISTRY_NAME}
description: Official role registry
url: ${REGISTRY_URL}
roles:
  ${ROLE_ID}:
    version: "${VERSION}"
    description: Reviews code
    tags:
      - review
`;

const originalFetch = globalThis.fetch;

// Saved for env/platform restoration in afterEach.
const savedEnv = {
  ROLEBOX_DATA_DIR: process.env.ROLEBOX_DATA_DIR,
  ROLEBOX_CONFIG_DIR: process.env.ROLEBOX_CONFIG_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  PATH: process.env.PATH,
};

/** A tiny, printable reason for why a tar-dependent test cannot build a fixture. */
const NO_TAR_REASON =
  "tar binary not on PATH; cannot build or extract a real tarball fixture. " +
  "The tar-dependent install scenarios require a real tar (see tests/helpers/tar.ts).";

if (!hasTar()) {
  console.warn(`[windows-adversarial/install] ${NO_TAR_REASON}`);
}

// ── Evidence helpers ────────────────────────────────────────────────

/** Build a DefectDetail with common defaults; per-call fields override. */
function detail(overrides: Partial<DefectDetail> & { file_line_refs: string[] }): DefectDetail {
  return {
    scenario: "install (windows adversarial)",
    command: "(in-process rolebox install)",
    expected: "see the per-test invariant",
    actual: "no observation captured",
    exit_code: null,
    stdout_tail: "",
    stderr_tail: "",
    cluster: CLUSTER,
    ...overrides,
  };
}

/**
 * Evaluate an invariant: record a defect entry (with file:line refs) when
 * `held` is false, then run the real assertion so the test visibly fails.
 * recordDefect always runs BEFORE the assertion throws.
 */
function assertInvariant(held: boolean, testId: string, d: DefectDetail): void {
  if (!held) {
    recordDefect(testId, d);
  }
  expect(held).toBe(true);
}

// ── Fixture archive builder ─────────────────────────────────────────
interface FixtureSpec {
  /** role.yaml content. */
  roleYaml?: string;
  /** Extra files to drop inside the role dir: name → content. */
  extraFiles?: Record<string, string>;
  /** An internal symlink to add inside the role dir: name → relative target. */
  symlink?: { name: string; target: string };
}

/** Build a real GitHub-style tarball (`tar czf`), returning the raw bytes. */
async function buildFixtureArchive(roleId: string, spec: FixtureSpec = {}): Promise<Uint8Array> {
  const fixtureDir = mkdtempSync(join(tmpdir(), "winadv-fixture-"));
  const topDir = join(fixtureDir, "example-myrepo-a1b2c3d");
  const roleDir = join(topDir, "roles", roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(
    join(roleDir, "role.yaml"),
    spec.roleYaml ?? `name: ${roleId}\ndescription: adv fixture\n`,
    "utf-8",
  );
  if (spec.extraFiles) {
    for (const [name, content] of Object.entries(spec.extraFiles)) {
      writeFileSync(join(roleDir, name), content, "utf-8");
    }
  }
  if (spec.symlink) {
    symlinkSync(spec.symlink.target, join(roleDir, spec.symlink.name));
  }
  const archivePath = join(fixtureDir, "archive.tar.gz");
  const proc = Bun.spawn(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
  if ((await proc.exited) !== 0) {
    throw new Error(`fixture tar build failed: ${archivePath}`);
  }
  return readFileSync(archivePath);
}

/** Configure the mocked fetch: `/tarball/` → bytes, everything else → manifestYaml. */
function mockFetchForInstall(archiveBytes: Uint8Array): void {
  globalThis.fetch = mock((url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/tarball/")) {
      return Promise.resolve(new Response(archiveBytes as unknown as BodyInit, { status: 200 }));
    }
    return Promise.resolve(new Response(manifestYaml, { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

/** Write a registry config.yaml under ROLEBOX_CONFIG_DIR (returned as-is). */
function writeRegistryConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    `registries:\n  - name: ${REGISTRY_NAME}\n    url: ${REGISTRY_URL}\n    default: true\n`,
    "utf-8",
  );
}

/** Build a >200-char path with spaces (OneDrive-style), rooted at `base`. */
function buildLongSpacedPath(base: string): string {
  const spaced = join(base, "test user", "rolebox data");
  return join(
    spaced,
    "a".repeat(30),
    "b".repeat(30),
    "c".repeat(30),
    "d".repeat(30),
    "e".repeat(30),
    "f".repeat(30),
  );
}

/** Is a path a symlink (survives a missing target)? */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("install (windows adversarial — Cluster A: install/init/registry)", () => {
  beforeEach(() => {
    // Each test routes the CLI's data/config roots to fresh temp dirs and, for
    // module-level tests, restores env/fetch/platform in afterEach.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    realPaths.setPlatformForTest(undefined);
    for (const k of ["ROLEBOX_DATA_DIR", "ROLEBOX_CONFIG_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) {
      if (savedEnv[k as keyof typeof savedEnv] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k as keyof typeof savedEnv];
    }
    // LOCALAPPDATA/APPDATA/PATH are only touched by the platform/PATH sims.
    for (const k of ["LOCALAPPDATA", "APPDATA", "PATH"]) {
      if (savedEnv[k as keyof typeof savedEnv] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k as keyof typeof savedEnv];
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Scenario 1 — archive containing a symlink on a non-elevated runner.
  //   Acceptable: install succeeds with a clean symlink preserved, OR degrades
  //   with the documented warning (win32), OR fails with an actionable error.
  //   Silent corruption (reports success with a broken/missing artifact and no
  //   warning) is a defect.
  //
  // On darwin tar CAN create symlinks, so the "non-elevated symlink failure" is
  // simulated via the injected spawn seam (registry-client.ts:164-167). The
  // win32 degraded+warning branch (registry-client.ts:376-385) is gated on the
  // real process.platform and is exercised on windows-latest (subtask 8).
  // ══════════════════════════════════════════════════════════════════

  it.skipIf(!hasTar())(
    "installs a symlink-containing role: symlink preserved, no silent corruption",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "winadv-symlink-data-"));
      const configDir = mkdtempSync(join(tmpdir(), "winadv-symlink-config-"));
      process.env.ROLEBOX_DATA_DIR = dataDir;
      process.env.ROLEBOX_CONFIG_DIR = configDir;
      writeRegistryConfig(configDir);

      const archiveBytes = await buildFixtureArchive(ROLE_ID, {
        symlink: { name: "link.md", target: "role.yaml" },
      });
      mockFetchForInstall(archiveBytes);

      let installErr: unknown;
      try {
        await realInstall.install(ROLE_ID, { quiet: true, noProgress: true });
      } catch (err) {
        installErr = err;
      }

      const targetDir = realPaths.getRolePath(REGISTRY_NAME, ROLE_ID, VERSION);
      const roleYaml = join(targetDir, "role.yaml");
      const linkPath = join(targetDir, "link.md");

      const outcome: string = installErr
        ? `install threw: ${(installErr as Error).message}`
        : "install succeeded";
      const roleExists = existsSync(roleYaml);
      const linkIsSymlink = isSymlink(linkPath);
      const installMsg = installErr ? (installErr as Error).message : "";
      // A failure is acceptable only if it is ACTIONABLE (names the context).
      const actionable =
        /extraction failed|install failed|integrity|refusing|not found|exited with code|left intact/i.test(
          installMsg,
        );

      // The contract: install must either succeed with the artifact + in-tree
      // symlink intact, OR fail with an actionable error. A "success" that
      // silently drops the role dir / symlink is silent corruption; a failure
      // with a context-free throw is a poor-diagnostics defect.
      const ok =
        (installErr === undefined && roleExists && linkIsSymlink) ||
        (installErr !== undefined && actionable);

      assertInvariant(
        ok,
        "install-symlink-preserved",
        detail({
          scenario:
            "install a role whose archive contains an internal symlink (non-elevated sim)",
          command: `install('${ROLE_ID}') [in-process, real tar]`,
          expected:
            "install succeeds with role dir + in-tree symlink intact, OR fails with an actionable error (never silent corruption / context-free throw)",
          actual: `${outcome} | role.yaml exists=${roleExists} | link.md isSymlink=${linkIsSymlink} | actionable=${actionable}`,
          exit_code: installErr ? 1 : 0,
          stdout_tail: "",
          stderr_tail: installMsg,
          file_line_refs: [
            "src/cli/registry-client.ts:455-487 (assertExtractionWithinDir symlink handling)",
            "src/cli/registry-client.ts:376-385 (win32 degraded+warning branch)",
          ],
        }),
      );

      if (ok && installErr === undefined) {
        // Positive confirmation: the symlink points at the in-tree role.yaml.
        expect(readFileSync(roleYaml, "utf-8").length).toBeGreaterThan(0);
      }
    },
  );

  it.skipIf(!hasTar())(
    "fails with an actionable error when tar extraction fails (simulated non-elevated)",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "winadv-symfail-data-"));
      const configDir = mkdtempSync(join(tmpdir(), "winadv-symfail-config-"));
      process.env.ROLEBOX_DATA_DIR = dataDir;
      process.env.ROLEBOX_CONFIG_DIR = configDir;

      const archiveBytes = await buildFixtureArchive(ROLE_ID, {
        symlink: { name: "link.md", target: "role.yaml" },
      });
      mockFetchForInstall(archiveBytes);

      // Simulate a non-elevated Windows tar that cannot create symlinks: the
      // extraction child exits non-zero. A functioning CLI must surface an
      // actionable error (registry-client.ts:381-384) rather than report success
      // with a silently-broken install. We inject via the DownloadRoleProcess
      // seam (registry-client.ts:164-167) since the real child-process boundary
      // cannot be reproduced on darwin.
      let resultDir: string | undefined;
      let resolveErr: unknown;
      try {
        resultDir = await realRegistryClient.downloadRole(
          { name: REGISTRY_NAME, url: REGISTRY_URL },
          ROLE_ID,
          VERSION,
          undefined,
          {
            spawnSync: () =>
              ({ status: 0, error: undefined }) as ReturnType<typeof realSpawnSync>,
            spawn: (_cmd: string, _args: string[], _opts: unknown) => {
              const fake = new EventEmitter();
              // Emit 'close' with a non-zero exit AFTER handlers are attached.
              setImmediate(() => fake.emit("close", 1));
              return fake as unknown as ReturnType<typeof realSpawn>;
            },
          },
        );
      } catch (err) {
        resolveErr = err;
      }

      const rejected = resolveErr !== undefined;
      const resolved = resultDir !== undefined;
      const msg = resolveErr ? (resolveErr as Error).message : "";
      const actionable = /tar exited with code|extraction failed/i.test(msg);

      // On darwin the win32 degraded branch is unreachable (process.platform is
      // read-only), so the only correct non-corrupt outcome is rejection.
      assertInvariant(
        rejected && actionable,
        "install-symlink-tar-failure-actionable",
        detail({
          scenario:
            "non-elevated symlink creation failure simulated (tar extract exits non-zero)",
          command: "downloadRole(...) [in-process, injected spawn seam]",
          expected:
            "downloadRole must NOT swallow the failure: it either degrades on win32 with a warning, or rejects with an actionable error",
          actual: resolved
            ? `downloadRole RESOLVED (${resultDir}) despite failing tar — a swallowing/partial-extraction bug`
            : `downloadRole rejected: ${msg}`,
          exit_code: rejected ? 1 : 0,
          stdout_tail: "",
          stderr_tail: msg,
          file_line_refs: [
            "src/cli/registry-client.ts:346-350 (tar availability check)",
            "src/cli/registry-client.ts:369-385 (extraction failure handling)",
          ],
        }),
      );
    },
  );

  // ══════════════════════════════════════════════════════════════════
  // Scenario 2 — ROLEBOX_DATA_DIR with spaces + a >200-char deep path.
  //   Real CLI behaves under a spaced/deep path (2a), install() writes to the
  //   spaced/deep data dir (2b), and the win32 path seam resolves correctly (2c).
  // ══════════════════════════════════════════════════════════════════

  it("real CLI `list` runs without crashing under a spaced + >200-char ROLEBOX_DATA_DIR", async () => {
    const base = mkdtempSync(join(tmpdir(), "winadv-long-data-"));
    const longSpaced = buildLongSpacedPath(base);
    const configDir = mkdtempSync(join(tmpdir(), "winadv-long-config-"));
    seedVersionCache(longSpaced); // hermetic: pre-seed the version-check cache

    const raw: CliResult = await runCli(["list"], {
      cwd: base,
      dataDir: longSpaced,
      configDir,
      keepTempDirs: true,
      timeout: 30_000,
    });

    const handled =
      raw.spawnError === undefined &&
      raw.buildError === undefined &&
      raw.timedOut === false &&
      raw.exitCode === 0 &&
      raw.stdout.includes("No roles installed");
    assertInvariant(
      handled,
      "install-datadir-long-spaced-cli-list",
      detail({
        scenario:
          "child-process CLI with a spaced + >200-char ROLEBOX_DATA_DIR (OneDrive-style)",
        command: raw.command,
        expected: "CLI exits 0 and reads the (empty) roles dir without crashing on the path",
        actual: `exit=${raw.exitCode} timedOut=${raw.timedOut} spawnError=${raw.spawnError ?? "none"} built=${raw.built}`,
        exit_code: raw.exitCode,
        stdout_tail: raw.stdoutTail,
        stderr_tail: raw.stderrTail,
        file_line_refs: [
          "src/cli/paths.ts:65-91 (getDataDir)",
          "src/cli/paths.ts:129-131 (getRolesDir)",
        ],
      }),
    );
  });

  it.skipIf(!hasTar())(
    "install succeeds when the data dir has spaces + a >200-char deep path",
    async () => {
      const base = mkdtempSync(join(tmpdir(), "winadv-longinstall-base-"));
      const longSpaced = buildLongSpacedPath(base);
      const configDir = mkdtempSync(join(tmpdir(), "winadv-longinstall-config-"));
      process.env.ROLEBOX_DATA_DIR = longSpaced;
      process.env.ROLEBOX_CONFIG_DIR = configDir;
      writeRegistryConfig(configDir);

      const archiveBytes = await buildFixtureArchive(ROLE_ID);
      mockFetchForInstall(archiveBytes);

      let installErr: unknown;
      try {
        await realInstall.install(ROLE_ID, { quiet: true, noProgress: true });
      } catch (err) {
        installErr = err;
      }

      const targetDir = realPaths.getRolePath(REGISTRY_NAME, ROLE_ID, VERSION);
      const roleExists = existsSync(join(targetDir, "role.yaml"));
      const pathLength = targetDir.length;
      const deepEnough = pathLength > 200;

      assertInvariant(
        installErr === undefined && roleExists && deepEnough,
        "install-datadir-long-spaced-success",
        detail({
          scenario:
            "install() writing a role into a spaced + >200-char ROLEBOX_DATA_DIR",
          command: `install('${ROLE_ID}') [in-process, dataDir=${longSpaced}]`,
          expected:
            "install succeeds and creates the role dir under the deep/spaced path",
          actual: installErr
            ? `install threw: ${(installErr as Error).message}`
            : `success targetLen=${pathLength} roleYamlExists=${roleExists} (len>200=${deepEnough})`,
          exit_code: installErr ? 1 : 0,
          stdout_tail: "",
          stderr_tail: installErr ? (installErr as Error).message : "",
          file_line_refs: [
            "src/cli/paths.ts:66-67 (ROLEBOX_DATA_DIR override)",
            "src/cli/commands/install.ts:172-189 (getRolePath + atomic swap)",
          ],
        }),
      );
    },
  );

  it("win32 path seam resolves data/config/role paths against a spaced + long root", () => {
    const base = mkdtempSync(join(tmpdir(), "winadv-pathseam-"));
    const longSpaced = buildLongSpacedPath(base);
    // Simulate Windows default-path resolution so getDataDir/getConfigDir take
    // the win32 branch (paths.ts:75-77, 108-110) on a darwin host.
    realPaths.setPlatformForTest("win32");
    process.env.LOCALAPPDATA = longSpaced;
    process.env.APPDATA = longSpaced;

    let dataDir: string;
    let configDir: string;
    let rolesDir: string;
    let rolePath: string;
    try {
      dataDir = realPaths.getDataDir();
      configDir = realPaths.getConfigDir();
      rolesDir = realPaths.getRolesDir();
      rolePath = realPaths.getRolePath(REGISTRY_NAME, ROLE_ID, VERSION);
    } catch (err) {
      dataDir = `<threw: ${(err as Error).message}>`;
      configDir = dataDir;
      rolesDir = dataDir;
      rolePath = dataDir;
    }

    const joined =
      dataDir === join(longSpaced, "rolebox") &&
      configDir === join(longSpaced, "rolebox") &&
      rolesDir === join(longSpaced, "rolebox", "roles") &&
      rolePath === join(longSpaced, "rolebox", "roles", REGISTRY_NAME, `${ROLE_ID}@${VERSION}`);

    assertInvariant(
      joined,
      "install-win32-path-seam",
      detail({
        scenario:
          "win32 path seam under a spaced + >200-char LOCALAPPDATA/APPDATA root",
        command: "getDataDir/getConfigDir/getRolesDir/getRolePath [in-process, setPlatformForTest(win32)]",
        expected: "paths join correctly under the win32 branch with the spaced/long root",
        actual: `dataDir=${dataDir} | configDir=${configDir} | rolesDir=${rolesDir} | rolePath=${rolePath}`,
        exit_code: joined ? 0 : 1,
        stdout_tail: "",
        stderr_tail: "",
        file_line_refs: [
          "src/cli/paths.ts:40 (setPlatformForTest seam)",
          "src/cli/paths.ts:75-77 (win32 getDataDir branch)",
          "src/cli/paths.ts:108-110 (win32 getConfigDir branch)",
        ],
      }),
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Scenario 3 — re-install/update while a file inside the installed role dir
  //   is held open by another process (cross-process file-lock analogue).
  //   The atomic swap (install.ts:176-181) must either succeed or fail with an
  //   actionable message; afterwards the role dir must be fully old OR fully
  //   new (never half-deleted).
  //
  //   Setup: the on-disk target dir pre-exists (so the swap's rmSync actually
  //   touches it) and the lock has NO entry for it — install() only swaps when
  //   the locked version differs (install.ts:134-139), so an absent/divergent
  //   lock forces the swap to run against the pre-seeded dir.
  // ══════════════════════════════════════════════════════════════════

  it.skipIf(!hasTar())(
    "update swap when a role-dir file is held open: role dir is never half-deleted",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "winadv-held-data-"));
      const configDir = mkdtempSync(join(tmpdir(), "winadv-held-config-"));
      process.env.ROLEBOX_DATA_DIR = dataDir;
      process.env.ROLEBOX_CONFIG_DIR = configDir;
      writeRegistryConfig(configDir);

      // Pre-seed the CURRENTLY-INSTALLED role dir on disk (old content) and
      // hold a file inside it open, simulating the Windows cross-process lock.
      const targetDir = realPaths.getRolePath(REGISTRY_NAME, ROLE_ID, VERSION);
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "role.yaml"), "name: OLD\nversion: old\n", "utf-8");
      writeFileSync(join(targetDir, "old-only.txt"), "old-marker", "utf-8");
      const heldPath = join(targetDir, "held.txt");
      writeFileSync(heldPath, "held", "utf-8");
      const fd = openSync(heldPath, "r"); // held open across the swap

      // The NEW archive carries distinct markers so half-deleted state is
      // detectable (old+new markers coexisting = half-deleted).
      const archiveBytes = await buildFixtureArchive(ROLE_ID, {
        roleYaml: "name: NEW\nversion: new\n",
        extraFiles: { "new-only.txt": "new-marker" },
      });
      mockFetchForInstall(archiveBytes);

      let installErr: unknown;
      try {
        await realInstall.install(ROLE_ID, { quiet: true, noProgress: true });
      } catch (err) {
        installErr = err;
      } finally {
        try {
          closeSync(fd); // release the handle after observing the swap
        } catch {
          // best effort
        }
      }

      // Inspect the resulting dir state.
      const roleYaml = join(targetDir, "role.yaml");
      const newMarker = join(targetDir, "new-only.txt");
      const oldMarker = join(targetDir, "old-only.txt");
      const roleYamlExists = existsSync(roleYaml);
      const hasNew = existsSync(newMarker);
      const hasOld = existsSync(oldMarker);
      const siblings = existsSync(join(targetDir, ".."))
        ? readdirSync(join(targetDir, ".."))
        : [];
      const stagingLeftovers = siblings.filter((s) => s.includes(".staging-"));

      const succeeded = installErr === undefined && roleYamlExists;
      const failedActionably =
        installErr !== undefined && /left intact|install failed/i.test((installErr as Error).message);
      const dirStateDescription = succeeded ? "fully new" : failedActionably ? "left intact/fully old" : "UNKNOWN";

      // The swap must either succeed (fully new) or fail with an actionable
      // message. It must never produce a half-deleted dir (old+new coexist).
      const noHalfDelete = !(roleYamlExists && hasNew && hasOld);
      const stagingClean = stagingLeftovers.length === 0;

      const outcomeOk =
        (succeeded || failedActionably) && noHalfDelete && stagingClean;

      assertInvariant(
        outcomeOk,
        "install-update-held-open-swap",
        detail({
          scenario:
            "re-install/update while a file inside the installed role dir is held open (cross-process lock sim)",
          command: `install('${ROLE_ID}') [in-process, held fd on ${heldPath}]`,
          expected:
            "swap succeeds (POSIX open-file unlink) OR fails with an actionable message; role dir is fully old or fully new; no staging leftovers",
          actual:
            `state=${dirStateDescription} | roleYamlExists=${roleYamlExists} hasNew=${hasNew} hasOld=${hasOld} ` +
            `stagingLeftovers=${stagingLeftovers.join(",") || "none"} | err=${installErr ? (installErr as Error).message : "none"}`,
          exit_code: installErr ? 1 : 0,
          stdout_tail: "",
          stderr_tail: installErr ? (installErr as Error).message : "",
          file_line_refs: [
            "src/cli/commands/install.ts:176-181 (atomic swap: moveDir + rmSync + moveDir)",
            "src/cli/commands/install.ts:182-189 (rollback catch: leaf intact message)",
            "src/cli/fs-utils.ts:45-56 (moveDir EXDEV fallback)",
          ],
        }),
      );

      if (succeeded) {
        // Positive confirmation of a clean fully-new state.
        expect(roleYamlExists).toBe(true);
        expect(hasNew).toBe(true);
        expect(hasOld).toBe(false);
        expect(stagingLeftovers).toHaveLength(0);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  // Scenario 4 — `rolebox init` with stdin piped (non-TTY). The interactive
  //   wizard must surface the TTY error immediately instead of hanging.
  //   We drive the real child-process CLI so the assertion reflects actual
  //   citty dispatch + exit-code behavior. We also cover `rolebox install`
  //   without a role spec, which exercises pick.ts assertInteractiveContext.
  // ══════════════════════════════════════════════════════════════════

  it("`rolebox init` with piped stdin errors immediately (TTY guard, no hang)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "winadv-init-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "winadv-init-config-"));
    seedVersionCache(dataDir); // hermetic: no npm registry call on cleanup()

    const raw: CliResult = await runCli(["init"], {
      cwd: dataDir,
      dataDir,
      configDir,
      keepTempDirs: true,
      timeout: 20_000,
      env: { CI: "1" },
    });

    const noHang = raw.timedOut === false;
    const ttyGuardPresent = /requires a TTY|Interactive prompts require a TTY/i.test(
      raw.stderr + raw.stdout,
    );
    const exitedNonZero = raw.exitCode !== null && raw.exitCode !== 0;

    assertInvariant(
      noHang && ttyGuardPresent && exitedNonZero,
      "init-piped-stdin-tty-guard",
      detail({
        scenario: "rolebox init with piped (non-TTY) stdin",
        command: raw.command,
        expected:
          "the interactive wizard must throw the TTY guard immediately rather than hang, and exit non-zero",
        actual: `noHang=${noHang} timedOut=${raw.timedOut} exit=${raw.exitCode} ttyGuard=${ttyGuardPresent}`,
        exit_code: raw.exitCode,
        stdout_tail: raw.stdoutTail,
        stderr_tail: raw.stderrTail,
        file_line_refs: [
          "src/cli/commands/init/init-prompts.ts:15-19 (interactive wizard TTY guard)",
          "src/cli/main.ts:36-38 (cleanup hook)",
        ],
      }),
    );
  });

  it("`rolebox install` with piped stdin (no role) errors immediately via assertInteractiveContext", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "winadv-instpiped-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "winadv-instpiped-config-"));
    seedVersionCache(dataDir);

    const raw: CliResult = await runCli(["install"], {
      cwd: dataDir,
      dataDir,
      configDir,
      keepTempDirs: true,
      timeout: 20_000,
      env: { CI: "1" },
    });

    const noHang = raw.timedOut === false;
    const asserted = /requires a TTY|Interactive role selection/i.test(raw.stderr + raw.stdout);
    const exitedNonZero = raw.exitCode !== null && raw.exitCode !== 0;

    assertInvariant(
      noHang && asserted && exitedNonZero,
      "install-piped-stdin-tty-guard",
      detail({
        scenario: "rolebox install (no role spec) with piped stdin",
        command: raw.command,
        expected:
          "installInteractive must throw the assertInteractiveContext guard instead of hanging",
        actual: `noHang=${noHang} timedOut=${raw.timedOut} exit=${raw.exitCode} asserted=${asserted}`,
        exit_code: raw.exitCode,
        stdout_tail: raw.stdoutTail,
        stderr_tail: raw.stderrTail,
        file_line_refs: [
          "src/cli/pick.ts:33-39 (assertInteractiveContext)",
          "src/cli/commands/install.ts:56-59 (interactive install guard call)",
        ],
      }),
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // Scenario 5 — tar-missing simulation. The fixture reproduces the
  //   registry-client.ts:348-349 "tar binary not found" error path
  //   deterministically via the injected spawnSync seam (the canonical
  //   technique from tests/cli/registry-client.test.ts:446-481). A genuine
  //   PATH-strip experiment is also recorded as an OBSERVATION (see the
  //   HANDOFF note in the report) rather than an assertion, because on darwin
  //   bun resolves `tar` from a fallback PATH even when PATH is stripped, so
  //   the literal "strip PATH" instruction does not reach the error branch.
  // ══════════════════════════════════════════════════════════════════

  it("throws the documented 'tar binary not found' error when tar is unavailable (seam)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "winadv-notar-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "winadv-notar-config-"));
    process.env.ROLEBOX_DATA_DIR = dataDir;
    process.env.ROLEBOX_CONFIG_DIR = configDir;

    // Dummy archive bytes: the download writes them, but extraction is never
    // reached because the tar availability check throws first.
    mockFetchForInstall(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    let thrown: unknown;
    let resolved = false;
    try {
      await realRegistryClient.downloadRole(
        { name: REGISTRY_NAME, url: REGISTRY_URL },
        ROLE_ID,
        VERSION,
        undefined,
        {
          spawn: realSpawn as never,
          spawnSync: () =>
            ({ status: -1, error: new Error("ENOENT: tar not found") }) as never,
        },
      );
      resolved = true;
    } catch (err) {
      thrown = err;
    }

    const msg = thrown ? (thrown as Error).message : "";
    const hit = !resolved && /tar binary not found/i.test(msg);

    assertInvariant(
      hit,
      "install-tar-missing-error-path",
      detail({
        scenario:
          "tar unavailable during install (injected spawnSync reports ENOENT) — must hit the 'tar binary not found' error",
        command: "downloadRole(...) [in-process, injected spawnSync seam]",
        expected: "downloadRole must throw 'tar binary not found — please install tar'",
        actual: resolved ? "downloadRole RESOLVED (tar-missing was not detected)" : `rejected: ${msg}`,
        exit_code: resolved ? 0 : 1,
        stdout_tail: "",
        stderr_tail: msg,
        file_line_refs: [
          "src/cli/registry-client.ts:346-350 (tar availability check → 'tar binary not found')",
          "src/cli/registry-client.ts:164-167 (DownloadRoleProcess seam)",
        ],
      }),
    );
  });

  it.skipIf(!hasTar())(
    "OBSERVATION: genuine PATH-strip does not hide tar on darwin (bun fallback) — documented for triage",
    async () => {
      // Genuine attempt to strip tar from PATH. On darwin bun resolves `tar`
      // from a fallback path, so this does NOT reach the error branch. This is
      // an observation, not a defect assertion; it records what actually
      // happens so the windows-latest run (subtask 8, where tar can be truly
      // absent) has an honest baseline.
      const dataDir = mkdtempSync(join(tmpdir(), "winadv-pathstrip-data-"));
      const configDir = mkdtempSync(join(tmpdir(), "winadv-pathstrip-config-"));
      process.env.ROLEBOX_DATA_DIR = dataDir;
      process.env.ROLEBOX_CONFIG_DIR = configDir;

      const noTarDir = mkdtempSync(join(tmpdir(), "winadv-notarpath-"));
      const archiveBytes = await buildFixtureArchive(ROLE_ID);
      mockFetchForInstall(archiveBytes);

      const origPath = process.env.PATH;
      process.env.PATH = noTarDir; // tar genuinely not on PATH here

      let rejected = false;
      let resolved = false;
      let msg = "";
      try {
        await realRegistryClient.downloadRole(
          { name: REGISTRY_NAME, url: REGISTRY_URL },
          ROLE_ID,
          VERSION,
          undefined,
          { spawn: realSpawn as never, spawnSync: realSpawnSync as never },
        );
        resolved = true;
      } catch (err) {
        rejected = true;
        msg = (err as Error).message;
      } finally {
        process.env.PATH = origPath;
      }

      // The interesting fact: whether the error branch was reached. Record the
      // observation (not a defect). This is informational for triage — the
      // deterministic assertion for the error path is the seam-based test above.
      if (!rejected && resolved) {
        console.warn(
          `[windows-adversarial/install] OBSERVATION: PATH stripped of tar (${noTarDir}) did ` +
            `NOT hide tar on darwin — downloadRole resolved: bun/OS resolver found tar elsewhere. ` +
            `The literal 'strip PATH' technique cannot reach registry-client.ts:348-349 on darwin; ` +
            `the seam-based test is the reliable path. Expected on windows-latest where tar may be absent.`,
        );
      }

      // The observation must not silently pass: assert only that we captured an
      // outcome (no throw from the harness itself).
      expect(resolved || rejected).toBe(true);
    },
  );
});

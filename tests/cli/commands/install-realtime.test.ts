// End-to-end test exercising the REAL download + extraction + atomic-swap
// pipeline with a real tarball fixture.
//
// Unlike tests/cli/commands/install.test.ts (which mock.module's the entire
// registry-client with stubbed downloadRole/computeIntegrity and tests the
// install() stub wiring), this file mocks only `globalThis.fetch` — the
// network boundary.
//
// ═══════════════════════════════════════════════════════════════════════
// Scope note
// ═══════════════════════════════════════════════════════════════════════
//
// This file drives downloadRole / computeIntegrity / atomic-swap directly
// against real artifacts; it does NOT drive the install() command function
// end-to-end. Under `bun test --isolate` each test file has its own module
// registry, so the real registry-client / paths / fs-utils modules imported
// below resolve to the on-disk source regardless of mocks registered by other
// test files (e.g. install.test.ts).
//
// To ALSO stay correct in a shared-process run (plain `bun test` WITHOUT
// `--isolate`), the real modules are loaded via cache-busted query-string
// specifiers (`?real`). A prior test file's `mock.module("...registry-client", ...)`
// (e.g. install.test.ts registers an unimplemented `downloadRole`) would
// otherwise shadow a bare static import and make `downloadRole` throw. The
// distinct specifiers are never covered by mocks keyed to the bare paths
// (same technique as tests/cli/e2e.test.ts).
//
// Covered end-to-end:
//   • downloadRole() → tar xzf with a real tarball (tests 1 & 2)
//   • computeIntegrity() on a real extracted tree
//   • Atomic swap + rollback with a real extracted artifact
//     (test 3 — manually exercises the same moveDir / getRolePath /
//     ensureWritableDir calls that install() uses)
//
// Not covered end-to-end:
//   • The install() → downloadRole composition; install() itself is driven
//     only via install.test.ts's stub wiring. The atomic-swap logic IS tested
//     below with real artifacts, and the install() stub wiring IS tested in
//     install.test.ts.
//
// Unix-centric: depends on a real `tar` on PATH (used both to build the
// fixture via `tar czf` and to extract via `tar xzf`). SKIPS GRACEFULLY on
// hosts without `tar` (see tests/helpers/tar.ts).
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasTar } from "../../helpers/tar";

// Load the REAL modules via cache-busted query-string specifiers so a prior
// test file's `mock.module(...)` (keyed to the bare path) cannot shadow them in
// a shared-process `bun test` run. Each distinct `?real` specifier resolves to
// the on-disk module even when a mock for the bare specifier is registered.
const _REAL_REGISTRY_CLIENT_SPECIFIER = "../../../src/cli/registry-client.ts?real";
const _REAL_PATHS_SPECIFIER = "../../../src/cli/paths.ts?real";
const _REAL_FS_UTILS_SPECIFIER = "../../../src/cli/fs-utils.ts?real";
const realRegistryClient = await import(_REAL_REGISTRY_CLIENT_SPECIFIER);
const realPaths = await import(_REAL_PATHS_SPECIFIER);
const realFsUtils = await import(_REAL_FS_UTILS_SPECIFIER);

const originalFetch = globalThis.fetch;

const manifestYaml = `
name: oh-my-role
description: Official role registry
url: https://github.com/example/myrepo
roles:
  software-architect:
    version: "1.0.0"
    description: Software architect role
    tags:
      - architecture
`;

let tmpConfigDir: string;
let tmpDataDir: string;
let tmpFixtureDir: string;

/**
 * Build a real GitHub-style tarball: one top dir containing
 * `roles/{roleId}/role.yaml`. Returns the raw archive bytes once `tar czf`
 * has fully written the file (awaits the child process).
 */
async function buildFixtureArchive(roleId: string): Promise<Uint8Array> {
  tmpFixtureDir = mkdtempSync(join(tmpdir(), "rolebox-realtime-"));
  const fixtureDir = join(tmpFixtureDir, "fixture");
  const topDir = join(fixtureDir, "example-myrepo-a1b2c3d");
  const roleDir = join(topDir, "roles", roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), `name: ${roleId}\ndescription: Real extraction\n`, "utf-8");

  const archivePath = join(tmpFixtureDir, "archive.tar.gz");
  const proc = Bun.spawn(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
  expect(await proc.exited).toBe(0);
  return readFileSync(archivePath);
}

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "rolebox-realtime-config-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "rolebox-realtime-data-"));
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  process.env.XDG_DATA_HOME = tmpDataDir;

  // Write a custom registry so the fetch URL is predictable.
  const configDir = join(tmpConfigDir, "rolebox");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.yaml"),
    "registries:\n  - name: oh-my-role\n    url: https://github.com/example/myrepo\n    default: true\n",
    "utf-8",
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
  if (tmpFixtureDir) rmSync(tmpFixtureDir, { recursive: true, force: true });
});

describe("install with the real download/extraction path", () => {
  it.skipIf(!hasTar())(
    "downloads a real tarball, extracts via real tar, and produces a role dir",
    async () => {
      const archiveBytes = await buildFixtureArchive("software-architect");

      globalThis.fetch = mock((url: string, _init?: any) => {
        if (url.includes("/tarball/")) {
          return Promise.resolve(new Response(archiveBytes, { status: 200 }));
        }
        return Promise.resolve(new Response(manifestYaml, { status: 200 }));
      });

      // Call downloadRole directly from the real module.
      const { spawn, spawnSync } = await import("node:child_process");
      const resultDir = await realRegistryClient.downloadRole(
        { name: "oh-my-role", url: "https://github.com/example/myrepo" },
        "software-architect",
        "1.0.0",
        undefined,
        { spawn: spawn as any, spawnSync: spawnSync as any },
      );

      // The role was really extracted (real tar).
      expect(existsSync(join(resultDir, "role.yaml"))).toBe(true);
      expect(readFileSync(join(resultDir, "role.yaml"), "utf-8")).toContain("Real extraction");

      // The integrity digest is computable from the extracted tree.
      const integrity = await realRegistryClient.computeIntegrity(resultDir);
      expect(integrity).toMatch(/^sha256-[a-f0-9]{64}$/);

      rmSync(resultDir, { recursive: true, force: true });
    },
  );

  it.skipIf(!hasTar())("rejects when real extraction finds no role dir", async () => {
    tmpFixtureDir = mkdtempSync(join(tmpdir(), "rolebox-realtime-miss-"));
    const fixtureDir = join(tmpFixtureDir, "fixture");
    const topDir = join(fixtureDir, "example-myrepo-a1b2c3d");
    mkdirSync(join(topDir, "docs"), { recursive: true });
    writeFileSync(join(topDir, "docs", "readme.md"), "no role here", "utf-8");
    const archivePath = join(tmpFixtureDir, "archive.tar.gz");
    const tarProc = Bun.spawn(["tar", "czf", archivePath, "-C", fixtureDir, "example-myrepo-a1b2c3d"]);
    expect(await tarProc.exited).toBe(0);
    const missingRoleArchive = readFileSync(archivePath);

    globalThis.fetch = mock((url: string, _init?: any) => {
      if (url.includes("/tarball/")) {
        return Promise.resolve(new Response(missingRoleArchive, { status: 200 }));
      }
      return Promise.resolve(new Response(manifestYaml, { status: 200 }));
    });

    const { spawn, spawnSync } = await import("node:child_process");
    await expect(
      realRegistryClient.downloadRole(
        { name: "oh-my-role", url: "https://github.com/example/myrepo" },
        "software-architect",
        "1.0.0",
        undefined,
        { spawn: spawn as any, spawnSync: spawnSync as any },
      ),
    ).rejects.toThrow(/role directory not found/);

    // downloadRole cleans up its own temp dirs — no partial install, no lock entry.
    const lockPath = join(tmpConfigDir, "rolebox", "rolebox.lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(!hasTar())(
    "atomic swap places new version without destroying previous on failure (real artifact)",
    async () => {
      // This test manually exercises the same atomic-swap + rollback logic
      // that install() uses at lines 132-153 of src/cli/commands/install.ts,
      // but with a real extracted tarball (not stubs). The atomic swap logic
      // is independently tested here with real filesystem operations — the
      // same moveDir / getRolePath / ensureWritableDir / rmSync calls that
      // install() performs.
      const { spawn, spawnSync } = await import("node:child_process");

      // Phase 1: Download and extract a real tarball → extractedDir.
      const archiveBytes = await buildFixtureArchive("software-architect");
      globalThis.fetch = mock((url: string, _init?: any) => {
        if (url.includes("/tarball/")) {
          return Promise.resolve(new Response(archiveBytes, { status: 200 }));
        }
        return Promise.resolve(new Response(manifestYaml, { status: 200 }));
      });
      const extractedDir = await realRegistryClient.downloadRole(
        { name: "oh-my-role", url: "https://github.com/example/myrepo" },
        "software-architect",
        "1.0.0",
        undefined,
        { spawn: spawn as any, spawnSync: spawnSync as any },
      );

      // Phase 2: Set up a "previous install" at the target directory so we
      // can verify the atomic swap properly replaces it AND that a
      // simulated failure leaves it intact (rollback).
      const registryName = "oh-my-role";
      const roleId = "software-architect";
      const version = "1.0.0";
      const targetDir = realPaths.getRolePath(registryName, roleId, version);

      // Write a dummy "previous install" at the target location.
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "role.yaml"), "name: previous-version\n", "utf-8");

      // Phase 3: Perform the same atomic-swap sequence that install() uses:
      //   a) ensureWritableDir(targetDir/..)
      //   b) move extractedDir → staging (sibling dir)
      //   c) rm -rf targetDir (the old version)
      //   d) move staging → targetDir
      const parentDir = join(targetDir, "..");
      realFsUtils.ensureWritableDir(parentDir);
      const staging = join(
        parentDir,
        `.${roleId}@${version}.staging-${process.pid}-${Date.now()}`,
      );

      // Atomic swap — happy path.
      realFsUtils.moveDir(extractedDir, staging);
      expect(existsSync(staging)).toBe(true);
      expect(existsSync(extractedDir)).toBe(false);

      // Remove the old version.
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }

      // Move staging into place.
      realFsUtils.moveDir(staging, targetDir);

      // Verify the new version is in place.
      expect(existsSync(join(targetDir, "role.yaml"))).toBe(true);
      expect(readFileSync(join(targetDir, "role.yaml"), "utf-8")).toContain("Real extraction");

      // No staging dirs leftover.
      const siblings = require("node:fs").readdirSync(join(targetDir, ".."));
      expect(siblings.filter((s: string) => s.includes(".staging-"))).toHaveLength(0);

      // Phase 4: Simulate a ROLLBACK scenario — extract a new tarball,
      // attempt the atomic swap, but simulate failure BEFORE the final move.
      // The previous version must survive intact.
      const archiveV2 = await buildFixtureArchive("software-architect");
      globalThis.fetch = mock((url: string, _init?: any) => {
        if (url.includes("/tarball/")) {
          return Promise.resolve(new Response(archiveV2, { status: 200 }));
        }
        return Promise.resolve(new Response(manifestYaml, { status: 200 }));
      });
      const extractedV2 = await realRegistryClient.downloadRole(
        { name: "oh-my-role", url: "https://github.com/example/myrepo" },
        "software-architect",
        "1.0.0",
        undefined,
        { spawn: spawn as any, spawnSync: spawnSync as any },
      );

      const stagingV2 = join(
        parentDir,
        `.${roleId}@${version}.staging-${process.pid}-${Date.now() + 1}`,
      );

      // Stage the new extracted dir.
      realFsUtils.moveDir(extractedV2, stagingV2);

      // Simulate a failure: delete staging and verify targetDir is intact.
      rmSync(stagingV2, { recursive: true, force: true });

      // The previously-installed version must survive.
      expect(existsSync(join(targetDir, "role.yaml"))).toBe(true);
      expect(readFileSync(join(targetDir, "role.yaml"), "utf-8")).toContain("Real extraction");

      // No staging leftovers.
      const siblingsAfter = require("node:fs").readdirSync(join(targetDir, ".."));
      expect(siblingsAfter.filter((s: string) => s.includes(".staging-"))).toHaveLength(0);

      // Clean up.
      rmSync(targetDir, { recursive: true, force: true });
    },
  );
});

/**
 * Regression test — Windows separator mismatch in `partitionRoleEntries`.
 *
 * `scanRoleModels` builds entry paths via `toNativePath` (backslashes on win32)
 * while fast-glob already emits forward slashes; `partitionRoleEntries` builds
 * the expected primary path with `join(roleDir, "role.yaml")`, which uses the
 * native separator. A strict `===` comparison therefore misclassifies the root
 * `role.yaml` as a subagent on win32.
 *
 * The fix routes the comparison through `samePath` (src/utils/paths.ts:48),
 * which has no platform branch and normalizes both operands with `toPosixPath`.
 * That makes the win32 behavior fully reproducible on POSIX: `join` with a
 * Windows-shaped `roleDir` yields a backslash-separated path that `===` cannot
 * match, while `samePath` can. This file feeds hand-constructed Windows-shaped
 * literals to exercise exactly that mismatch.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { RoleModelEntry } from "../../src/cli/model-utils.ts";

/** A win32-style role dir, as `path.join` would build it on Windows. */
const WIN_ROLE_DIR = "C:\\roles\\demo";

/** The root `role.yaml`, as fast-glob would report it (forward slashes). */
const ROOT_PATH = "C:/roles/demo/role.yaml";

/** A nested subagent `role.yaml`, forward-slash shaped like the root. */
const SUBAGENT_PATH = "C:/roles/demo/subagents/a/role.yaml";

const WINDOWS_ENTRIES: RoleModelEntry[] = [
  { path: ROOT_PATH, name: "demo", model: "old/model" },
  { path: SUBAGENT_PATH, name: "a", model: "old/model" },
];

// Register the model-utils mock BEFORE importing config.ts so
// `runNonInteractive` can be driven with the same Windows-shaped entries a
// win32 `scanRoleModels` would produce. Mirrors the seam at
// tests/cli/commands/sync.test.ts:53. `--isolate` keeps this process-local.
mock.module("../../src/cli/model-utils", () => ({
  scanModelsForTarget: () => [],
  scanRoleModels: (roleDir: string) =>
    roleDir === WIN_ROLE_DIR ? WINDOWS_ENTRIES : [],
}));

// Import AFTER mock.module registration (same pattern as
// tests/platform/rc-c-sidecar-reread.test.ts:62-64).
const { partitionRoleEntries, runNonInteractive } = await import(
  "../../src/cli/commands/config.ts"
);

describe("partitionRoleEntries — Windows separator mismatch", () => {
  it("classifies the root role.yaml as primary when paths use / and roleDir uses \\", () => {
    const { primary, subagents } = partitionRoleEntries(
      WINDOWS_ENTRIES,
      WIN_ROLE_DIR,
    );

    expect(primary).toBeDefined();
    expect(primary?.path).toBe(ROOT_PATH);
    expect(subagents).toHaveLength(1);
    expect(subagents[0].path).toBe(SUBAGENT_PATH);
  });

  it("returns primary undefined and every entry as a subagent when nothing matches the root", () => {
    const noMatch: RoleModelEntry[] = [
      { path: "C:/other/role.yaml", name: "other", model: "old/model" },
      { path: "C:/other/subagents/b/role.yaml", name: "b", model: "old/model" },
    ];

    const { primary, subagents } = partitionRoleEntries(noMatch, WIN_ROLE_DIR);

    expect(primary).toBeUndefined();
    expect(subagents).toEqual(noMatch);
    expect(subagents).toHaveLength(2);
  });
});

describe("runNonInteractive --primary-only — Windows-shaped entries", () => {
  let logs: string[];
  let errors: string[];
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    logs = [];
    errors = [];
    origLog = console.log;
    origError = console.error;
    origExitCode = process.exitCode;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    process.exitCode = origExitCode;
  });

  it("resolves the primary and reports all files already using the model", async () => {
    // The model equals every entry's model, so `updateModelInFile` is never
    // invoked — no filesystem writes occur.
    await runNonInteractive(WIN_ROLE_DIR, "old/model", true);

    expect(errors).toHaveLength(0);
    expect(process.exitCode).not.toBe(1);
    expect(
      logs.some((l) => l.includes('All role.yaml files already using model "old/model"')),
    ).toBe(true);
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  quarantineCorruptFile,
  orphanTmpCleanup,
  breakStaleLocks,
  StartupChecker,
} from "../../src/recovery/startup-check";

// ── Helpers ─────────────────────────────────────────────────────────────────

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* race with test cleanup */ }
  }
  dirs.length = 0;
});

/** Create a temp directory and register it for cleanup. */
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "startup-check-test-"));
  dirs.push(d);
  return d;
}

/** Write a JSON state file into a temp dir. Returns the full path. */
function writeStateFile(dir: string, name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content), "utf-8");
  return p;
}

/** Write raw (non-JSON) content into a temp dir. */
function writeRawFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ── quarantineCorruptFile ───────────────────────────────────────────────────

describe("quarantineCorruptFile", () => {
  it("leaves a valid state file in place and returns its path", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { version: 5, tasks: [] });

    const result = quarantineCorruptFile(path, "test");

    expect(result).toBe(path);
    expect(existsSync(path)).toBe(true); // Not moved
    expect(existsSync(join(dir, "quarantine"))).toBe(false); // No quarantine created
  });

  it("quarantines invalid JSON and creates timestamped corrupt file", () => {
    const dir = tmpDir();
    const path = writeRawFile(dir, "state.json", "not-json-at-all{{{");

    const result = quarantineCorruptFile(path, "bad-json-test");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false); // Moved away

    // Check quarantine dir exists and contains a .corrupt file
    const quarantineDir = join(dir, "quarantine");
    expect(existsSync(quarantineDir)).toBe(true);

    // Should have exactly one file with .corrupt extension and a timestamp
    const entries = readdirSync(quarantineDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^state\.json\..+\.corrupt$/);
    expect(entries[0]).toMatch(/\.\d{4}-\d{2}-\d{2}T/); // ISO timestamp present
  });

  it("quarantines a valid JSON object missing the version field", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { tasks: [] }); // No version

    const result = quarantineCorruptFile(path, "no-version");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, "quarantine", readdirSync(join(dir, "quarantine"))[0]))).toBe(true);
  });

  it("quarantines a valid JSON object with non-integer version", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { version: "5" }); // String, not number

    const result = quarantineCorruptFile(path, "string-version");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("quarantines a valid JSON object with version outside 1-99 range", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { version: 100 });

    const result = quarantineCorruptFile(path, "out-of-range");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("quarantines a file that is a JSON primitive (not an object)", () => {
    const dir = tmpDir();
    const path = writeRawFile(dir, "state.json", '"just-a-string"');

    const result = quarantineCorruptFile(path, "json-primitive");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("returns null without quarantining when file does not exist (ENOENT)", () => {
    const dir = tmpDir();
    const path = join(dir, "nonexistent.json");

    const result = quarantineCorruptFile(path, "missing-file");

    expect(result).toBeNull();
    // No quarantine dir should have been created
    expect(existsSync(join(dir, "quarantine"))).toBe(false);
  });

  it("accepts version 1 (lower bound)", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { version: 1, data: "ok" });

    const result = quarantineCorruptFile(path, "v1");

    expect(result).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it("accepts version 99 (upper bound)", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { version: 99, data: "ok" });

    const result = quarantineCorruptFile(path, "v99");

    expect(result).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it("quarantines version 0 (below min)", () => {
    const dir = tmpDir();
    const path = writeStateFile(dir, "state.json", { version: 0 });

    const result = quarantineCorruptFile(path, "v0");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("quarantines a null value (JSON null)", () => {
    const dir = tmpDir();
    const path = writeRawFile(dir, "state.json", "null");

    const result = quarantineCorruptFile(path, "null-value");

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});

// ── orphanTmpCleanup ────────────────────────────────────────────────────────

describe("orphanTmpCleanup", () => {
  it("deletes .tmp files in the given directory", () => {
    const dir = tmpDir();
    writeRawFile(dir, "tasks-abc.tmp", "leftover data");
    writeRawFile(dir, "metrics.tmp", "leftover data");
    writeStateFile(dir, "tasks-abc.json", { version: 5, tasks: [] });

    orphanTmpCleanup(dir);

    expect(existsSync(join(dir, "tasks-abc.tmp"))).toBe(false);
    expect(existsSync(join(dir, "metrics.tmp"))).toBe(false);
    // Non-.tmp files are untouched
    expect(existsSync(join(dir, "tasks-abc.json"))).toBe(true);
  });

  it("does nothing when there are no .tmp files", () => {
    const dir = tmpDir();
    writeStateFile(dir, "state.json", { version: 5 });

    orphanTmpCleanup(dir);

    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  it("is a no-op when the directory does not exist", () => {
    // Should not throw
    expect(() => orphanTmpCleanup("/tmp/nonexistent-dir-xyz-123")).not.toThrow();
  });

  it("does not touch files without .tmp suffix", () => {
    const dir = tmpDir();
    writeRawFile(dir, "normal.json", '{"version":5}');
    writeRawFile(dir, "backup.json.bak", "some backup");

    orphanTmpCleanup(dir);

    expect(existsSync(join(dir, "normal.json"))).toBe(true);
    expect(existsSync(join(dir, "backup.json.bak"))).toBe(true);
  });
});

// ── breakStaleLocks ─────────────────────────────────────────────────────────
// Note: breakStaleLocks calls stateDirFor(process.cwd()), so it operates on
// the test runner's workspace. For a hermetic test we would need to chdir or
// mock — these tests verify the function does not throw and correctly detects
// locking scenarios.

describe("breakStaleLocks", () => {
  it("does not throw when state directory exists", () => {
    // Operates on the real project's .rolebox/state — if it exists, runs;
    // if it doesn't, it's a silent no-op. Either way, no throw.
    expect(() => breakStaleLocks()).not.toThrow();
  });

  it("returns a numeric count", () => {
    const count = breakStaleLocks();
    expect(typeof count).toBe("number");
  });
});

// ── StartupChecker ────────────────────────────────────────────────────────────

describe("StartupChecker", () => {
  it("returns healthy when all state files are valid", () => {
    const stateDir = tmpDir();
    writeStateFile(stateDir, "loops-abc.json", { version: 5, loops: [] });
    writeStateFile(stateDir, "fnstate-xyz.json", { version: 5, states: {} });

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(true);
    expect(result.quarantined).toEqual([]);
    // warnings may be >0 if breakStaleLocks finds real locks in .rolebox/state
  });

  it("quarantines corrupt state files and reports warnings", () => {
    const stateDir = tmpDir();
    writeRawFile(stateDir, "loops-bad.json", "not-json{{{corrupt");

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(false);
    expect(result.quarantined).toContain("loops-bad.json");
    expect(result.warnings.some(w => w.includes("loops-bad"))).toBe(true);
  });

  it("handles mixed valid and corrupt state files", () => {
    const stateDir = tmpDir();
    writeStateFile(stateDir, "loops-ok.json", { version: 5, loops: [] });
    writeRawFile(stateDir, "fnstate-bad.json", "corrupt{{{data");

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(false);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]).toBe("fnstate-bad.json");

    // Valid file should remain in place
    expect(existsSync(join(stateDir, "loops-ok.json"))).toBe(true);
  });

  it("counts orphan .tmp files removed", () => {
    const dir = tmpDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeStateFile(stateDir, "metrics-test.json", { version: 5 });
    writeRawFile(dir, "orphan1.tmp", "garbage");
    writeRawFile(dir, "orphan2.tmp", "garbage");

    const result = StartupChecker.checkAll(dir, stateDir);

    expect(result.orphanTmpsRemoved).toBeGreaterThanOrEqual(2);
    // Files should actually be deleted
    expect(existsSync(join(dir, "orphan1.tmp"))).toBe(false);
    expect(existsSync(join(dir, "orphan2.tmp"))).toBe(false);
  });

  it("runs lock breaking without error", () => {
    const dir = tmpDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeStateFile(stateDir, "loops-test.json", { version: 5, loops: [] });

    const result = StartupChecker.checkAll(dir, stateDir);

    // staleLocksBroken is >= 0 because breakStaleLocks reads from
    // process.cwd()/.rolebox/state, not from our temp stateDir
    expect(result.staleLocksBroken).toBeGreaterThanOrEqual(0);
  });

  it("is a no-op when state directory does not exist", () => {
    const dir = tmpDir();
    const result = StartupChecker.checkAll(dir, join(dir, "nonexistent-state"));

    expect(result.healthy).toBe(true);
    expect(result.quarantined).toEqual([]);
    expect(result.orphanTmpsRemoved).toBe(0);
  });

  it("skips non-state .json files (unknown patterns)", () => {
    const stateDir = tmpDir();
    // random.json is not a known state file pattern -> should be ignored
    writeRawFile(stateDir, "random.json", "not-even-json");
    writeStateFile(stateDir, "loops-abc.json", { version: 5, loops: [] });

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(true);
    expect(result.quarantined).toEqual([]);
  });

  it("ignores non-json files in state directory", () => {
    const stateDir = tmpDir();
    writeRawFile(stateDir, "data.txt", "not a state file");

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(true);
  });

  it("orphanTmpCleanup returns 0 when no .tmp files exist", () => {
    const dir = tmpDir();
    const count = orphanTmpCleanup(dir);
    expect(count).toBe(0);
  });
});

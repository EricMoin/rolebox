import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StartupChecker } from "../../src/recovery/startup-check";
import { acquireStateLock } from "../../src/dispatch/concurrency/state-lock";
import { shortHash } from "../../src/utils/state-paths";
import { LoopStore } from "../../src/loop/loop-store";
import { FunctionRuntimeStore } from "../../src/function/runtime-store";
import { TaskStateStore } from "../../src/dispatch/persistence/task-store";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence";
import { BudgetTracker } from "../../src/dispatch/budget/budget-tracker";
import { DEFAULT_CONFIG } from "../../src/dispatch/config";
import { recoverInterruptedGraphs } from "../../src/graph/engine/engine-startup";
import type { DispatchManager } from "../../src/dispatch/core/manager";

// ── Temp-dir hygiene (mirrors startup-check.test.ts) ─────────────────────────

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* race with test cleanup */
    }
  }
  dirs.length = 0;
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "startup-resilience-"));
  dirs.push(d);
  return d;
}

function stateDir(dir: string): string {
  return join(dir, ".rolebox", "state");
}

function ensureStateDir(dir: string): string {
  const sd = stateDir(dir);
  mkdirSync(sd, { recursive: true });
  return sd;
}

/** Write an arbitrary string into a file (creating parent dirs). */
function writeRaw(filePath: string, content: string): string {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Write a 0-byte file (creating parent dirs). */
function writeEmpty(filePath: string): string {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "", "utf-8");
  return filePath;
}

/** shortHash-based state filename for a store keyed by the workspace dir. */
function namedFile(prefix: string, dir: string): string {
  return `${prefix}-${shortHash(dir)}.json`;
}

// ── Failure-mode fixtures ────────────────────────────────────────────────────

/** The five version-gated state prefixes StartupChecker scans. */
const PREFIXES = ["loops", "dispatch", "fnstate", "engine", "budget"] as const;

/** (a) Corrupted JSON — garbage bytes that JSON.parse rejects. */
function seedCorrupt(sd: string, prefix: string): string {
  return writeRaw(join(sd, `${namedFile(prefix, sd)}`), `not-json{{{${prefix}`);
}

/** (b) Empty (0-byte) files. */
function seedEmpty(sd: string, prefix: string): string {
  return writeEmpty(join(sd, `${namedFile(prefix, sd)}`));
}

/** (c) Truncated JSON — a valid prefix cut mid-object. */
function seedTruncated(sd: string, prefix: string): string {
  return writeRaw(join(sd, `${namedFile(prefix, sd)}`), `{"version":1,"${prefix}":[{"id":"x","v`);
}

/**
 * Minimal structural DispatchManager stub. When every `engine-*.json` is
 * corrupt, the sweep never reaches `createEngine` + `recover()`, so this stub
 * is never invoked. Cast to the concrete type because a real manager is far
 * too heavy for a unit test.
 */
function managerStub(): DispatchManager {
  return {} as unknown as DispatchManager;
}

// ── Entry point 1: StartupChecker.checkAll never throws + quarantines ─────────

describe("StartupChecker.checkAll under seeded failure modes", () => {
  for (const mode of ["corrupt", "empty", "truncated"] as const) {
    it(`never throws and quarantines every ${mode} state file (all prefixes)`, () => {
      const dir = tmpDir();
      const sd = ensureStateDir(dir);

      const seed = mode === "corrupt" ? seedCorrupt : mode === "empty" ? seedEmpty : seedTruncated;
      for (const prefix of PREFIXES) seed(sd, prefix);

      // checkAll is total by contract — the call itself is the not-throw proof.
      const result = StartupChecker.checkAll(dir, sd);

      // Every seeded file was quarantined (filename reported, original gone).
      for (const prefix of PREFIXES) {
        const name = namedFile(prefix, sd);
        expect(result!.quarantined).toContain(name);
        expect(existsSync(join(sd, name))).toBe(false);
      }
      expect(result!.healthy).toBe(false);

      // The quarantine dir exists and holds a `.corrupt` snapshot per file.
      const quarantine = join(sd, "quarantine");
      expect(existsSync(quarantine)).toBe(true);
      const entries = readdirSync(quarantine);
      for (const prefix of PREFIXES) {
        expect(entries.some((e) => e.startsWith(`${namedFile(prefix, sd)}.`) && e.endsWith(".corrupt"))).toBe(true);
      }
    });
  }

  it("(d) is a clean no-op when the .rolebox/state directory is entirely missing", () => {
    const dir = tmpDir();
    const sd = stateDir(dir); // never created

    const result = StartupChecker.checkAll(dir, sd); // total — a throw would fail here

    expect(result.healthy).toBe(true);
    expect(result.quarantined).toEqual([]);
    expect(result.orphanTmpsRemoved).toBe(0);
  });

  it("(e) breaks a stale .lock whose recorded PID is dead and never throws", () => {
    const dir = tmpDir();
    const sd = ensureStateDir(dir);
    // In-range valid JSON, dead PID (out of valid range, effectively never alive).
    writeRaw(
      join(sd, "loops-stale.json.lock"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now(), lastHeartbeat: Date.now() }),
    );

    const result = StartupChecker.checkAll(dir, sd); // total — dead PID is broken
    expect(result.staleLocksBroken).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(sd, "loops-stale.json.lock"))).toBe(false);
  });

  it("(f) removes a .lock with truncated content during checkAll and never throws", () => {
    const dir = tmpDir();
    const sd = ensureStateDir(dir);
    // Unparseable lock — definitionally stale per breakStaleLocks pass 1.
    writeRaw(join(sd, "loops-trunc.json.lock"), `{"pid":12`);

    const result = StartupChecker.checkAll(dir, sd); // total — truncated lock is broken
    expect(result.staleLocksBroken).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(sd, "loops-trunc.json.lock"))).toBe(false);
  });
});

// ── Entry point 2: each store's load() returns null / fresh ───────────────────

describe("store load() under seeded failure modes", () => {
  for (const mode of ["corrupt", "empty", "truncated"] as const) {
    it(`LoopStore / FunctionRuntimeStore / TaskStateStore / EnginePersistence return null on ${mode} files`, () => {
      const dir = tmpDir();
      const sd = ensureStateDir(dir);
      const seed = mode === "corrupt" ? seedCorrupt : mode === "empty" ? seedEmpty : seedTruncated;
      for (const prefix of ["loops", "fnstate", "dispatch", "engine"]) seed(sd, prefix);

      expect(() => new LoopStore(dir).load()).not.toThrow();
      expect(new LoopStore(dir).load()).toBeNull();

      expect(() => new FunctionRuntimeStore(dir).load()).not.toThrow();
      expect(new FunctionRuntimeStore(dir).load()).toBeNull();

      expect(() => new TaskStateStore(dir).load()).not.toThrow();
      expect(new TaskStateStore(dir).load()).toBeNull();

      const engine = new EnginePersistence(dir);
      expect(() => engine.load("x")).not.toThrow();
      expect(engine.load("x")).toBeNull();
    });
  }

  it("BudgetTracker constructor restores fresh from a corrupt budget file and stays usable", () => {
    const dir = tmpDir();
    const sd = ensureStateDir(dir);
    seedCorrupt(sd, "budget");

    let tracker: BudgetTracker | undefined;
    expect(() => {
      tracker = new BudgetTracker(DEFAULT_CONFIG, dir);
    }).not.toThrow();

    // Fresh state: no error budget consumed, status renders as a string.
    expect(tracker!.getRequestUsage("no-such-session")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
    expect(typeof tracker!.getStatus("sess")).toBe("string");
  });

  it("(d) every store's load() returns null when the state directory is missing", () => {
    const dir = tmpDir(); // no .rolebox/state created

    expect(new LoopStore(dir).load()).toBeNull();
    expect(new FunctionRuntimeStore(dir).load()).toBeNull();
    expect(new TaskStateStore(dir).load()).toBeNull();
    expect(new EnginePersistence(dir).load("x")).toBeNull();
    // BudgetTracker.restore tolerates a missing file and starts fresh.
    expect(() => new BudgetTracker(DEFAULT_CONFIG, dir)).not.toThrow();
  });
});

// ── Entry point 3: acquireStateLock returns a LockResult, never throws ────────

describe("acquireStateLock under seeded failure modes", () => {
  it("returns a LockResult for a nonexistent lock file", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-x.json");

    let lock: ReturnType<typeof acquireStateLock> | undefined;
    expect(() => {
      lock = acquireStateLock(statePath);
    }).not.toThrow();
    expect(typeof lock!.ok).toBe("boolean");
    expect(typeof lock!.release).toBe("function");
    lock!.release();
  });

  it("(e) reclaims a lock held by a dead PID and returns ok", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-x.json");
    writeRaw(
      `${statePath}.lock`,
      JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now(), lastHeartbeat: Date.now() }),
    );

    let lock: ReturnType<typeof acquireStateLock> | undefined;
    expect(() => {
      lock = acquireStateLock(statePath);
    }).not.toThrow();
    expect(lock!.ok).toBe(true);
    lock!.release();
  });

  it("(f) treats a truncated lock file as reclaimable and never throws", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-x.json");
    writeRaw(`${statePath}.lock`, `{"pid":12`); // cut mid-object

    let lock: ReturnType<typeof acquireStateLock> | undefined;
    expect(() => {
      lock = acquireStateLock(statePath);
    }).not.toThrow();
    expect(typeof lock!.ok).toBe("boolean");
    lock!.release();
  });

  it("(a) treats a garbage-bytes lock file as reclaimable and never throws", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-x.json");
    writeRaw(`${statePath}.lock`, `totallynotjson{{{`);

    let lock: ReturnType<typeof acquireStateLock> | undefined;
    expect(() => {
      lock = acquireStateLock(statePath);
    }).not.toThrow();
    expect(typeof lock!.ok).toBe("boolean");
    lock!.release();
  });
});

// ── Entry point 4: recoverInterruptedGraphs returns a report, never throws ────

describe("recoverInterruptedGraphs under seeded failure modes", () => {
  for (const mode of ["corrupt", "empty", "truncated"] as const) {
    it(`returns a report listing ${mode} engine files in failed[], not thrown`, async () => {
      const dir = tmpDir();
      const sd = ensureStateDir(dir);
      const seed = mode === "corrupt" ? seedCorrupt : mode === "empty" ? seedEmpty : seedTruncated;
      seed(sd, "engine");
      seed(sd, "engine"); // second file to prove the sweep continues past a bad one
      writeRaw(join(sd, "engine-alsobad.json"), mode === "empty" ? "" : `bad{{{`);

      let report: Awaited<ReturnType<typeof recoverInterruptedGraphs>> | undefined;
      await expect(
        (async () => {
          report = await recoverInterruptedGraphs({ directory: dir, manager: managerStub() });
        })(),
      ).resolves.toBeUndefined();

      expect(report!.scanned).toBeGreaterThanOrEqual(2);
      expect(report!.recovered).toBe(0);
      expect(report!.failed.length).toBe(report!.scanned);
      expect(report!.failed.every((f) => f.startsWith("engine-*.json:"))).toBe(true);
    });
  }

  it("(d) returns a clean no-op report when .rolebox/state is missing", async () => {
    const dir = tmpDir();

    let report: Awaited<ReturnType<typeof recoverInterruptedGraphs>> | undefined;
    await expect(
      (async () => {
        report = await recoverInterruptedGraphs({ directory: dir, manager: managerStub() });
      })(),
    ).resolves.toBeUndefined();

    expect(report).toEqual({ scanned: 0, recovered: 0, failed: [] });
  });
});

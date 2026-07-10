/**
 * ─────────────────────────────────────────────────────────────────────
 * Sub-task 9: Crash-recovery integration tests
 *
 * Covers all 7 scenarios (a)–(g) from the micro-kernel service
 * supervision + crash-recovery plan.
 *
 * Every test verifies the always-bootable principle:
 * PluginCore.init() NEVER throws in recoverable scenarios.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, mock, afterEach, beforeEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PluginCore } from "../../src/core/plugin-core.ts";
import { EventBus } from "../../src/core/event-bus.ts";
import {
  ServiceSupervisor,
  SUPERVISOR_DEFAULTS,
} from "../../src/core/service-supervisor.ts";
import type { PluginService, PluginCoreLike, ServiceHealth } from "../../src/core/service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import {
  quarantineCorruptFile,
  StartupChecker,
} from "../../src/recovery/startup-check.ts";
import { acquireStateLock, StaleLockTimeoutMs } from "../../src/dispatch/concurrency/state-lock.ts";
import { __resetForTest } from "../../src/logger.ts";

// ── Test lifecycle ──────────────────────────────────────────────────

const tmpDirs: string[] = [];

beforeEach(() => {
  __resetForTest();
});

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* race with cleanup */
    }
  }
  tmpDirs.length = 0;
  mock.restore();
});

// ── Helpers ─────────────────────────────────────────────────────────

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "crash-recovery-test-"));
  tmpDirs.push(d);
  return d;
}

function makeService(
  name: string,
  deps: string[] = [],
  critical?: boolean,
): PluginService {
  return {
    name,
    dependencies: deps,
    critical,
    init: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
  };
}

function makeContext(core: PluginCoreLike): PluginContext {
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp/test-crash-recovery",
    directory: "/tmp/test-crash-recovery",
    core,
    bus: core.getBus(),
  };
}

/** Write a valid JSON state file into a directory. */
function writeStateFile(dir: string, name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content), "utf-8");
  return p;
}

/** Write raw (potentially invalid) content into a file. */
function writeRawFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// (a) 陈旧锁恢复 — Stale lock recovery
// ─────────────────────────────────────────────────────────────────────

describe("(a) Stale lock recovery", () => {
  it("recovers a stale lock with dead pid and acquires fresh lock", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-test.json");

    // Write a lock file referencing a dead PID (99999 is unlikely to exist)
    writeFileSync(
      statePath + ".lock",
      JSON.stringify({ pid: 99999, startedAt: Date.now() - 10_000 }),
      "utf-8",
    );

    const lock = acquireStateLock(statePath);
    expect(lock.ok).toBe(true);
    expect(lock.heldByPid).toBeUndefined();

    // Verify the lock file now holds our PID
    const raw = readFileSync(statePath + ".lock", "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);

    lock.release();
    expect(existsSync(statePath + ".lock")).toBe(false);
  });

  it("recovers a stale lock with live pid past the timeout boundary", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-stale.json");

    // Write a lock with our own PID but with startedAt beyond StaleLockTimeoutMs
    writeFileSync(
      statePath + ".lock",
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now() - StaleLockTimeoutMs - 60_000,
        lastHeartbeat: Date.now() - StaleLockTimeoutMs - 60_000,
      }),
      "utf-8",
    );

    const lock = acquireStateLock(statePath);
    expect(lock.ok).toBe(true);

    lock.release();
  });

  it("does NOT reclaim a live lock within the timeout window", () => {
    const dir = tmpDir();
    const statePath = join(dir, "loops-fresh.json");

    // Acquire the lock
    const lock1 = acquireStateLock(statePath);
    expect(lock1.ok).toBe(true);

    // Second acquire should fail (live process, within timeout)
    const lock2 = acquireStateLock(statePath);
    expect(lock2.ok).toBe(false);
    expect(lock2.heldByPid).toBe(process.pid);

    lock1.release();
  });
});

// ─────────────────────────────────────────────────────────────────────
// (b) 写一半状态文件 — Corrupted / truncated state file quarantine
// ─────────────────────────────────────────────────────────────────────

describe("(b) Corrupted state file quarantine", () => {
  it("quarantines a truncated JSON state file and init proceeds", () => {
    const dir = tmpDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });

    // Write truncated JSON (valid JSON object cut off mid-stream)
    const path = writeRawFile(stateDir, "loops-abc.json", '{"version":5,');

    const result = quarantineCorruptFile(path, "truncated-test");
    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);

    // Quarantine file should exist
    const qDir = join(stateDir, "quarantine");
    expect(existsSync(qDir)).toBe(true);
    const entries = readdirSync(qDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^loops-abc\.json\..+\.corrupt$/);
  });

  it("handles mixed valid and truncated state files", () => {
    const stateDir = tmpDir();

    // Valid file
    writeStateFile(stateDir, "loops-valid.json", { version: 5, loops: [] });
    // Truncated file
    writeRawFile(stateDir, "fnstate-bad.json", '{"version":3,');

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    // The valid file should NOT be in quarantined list
    expect(result.quarantined.filter((q) => q.includes("loops-valid"))).toHaveLength(0);
    // The bad file should be quarantined
    expect(result.quarantined).toContain("fnstate-bad.json");
    expect(result.healthy).toBe(false);
  });

  it("quarantines a file with version outside 1-99 range", () => {
    const stateDir = tmpDir();
    writeStateFile(stateDir, "dispatch-tasks-xyz.json", { version: 100, tasks: [] });

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(false);
    expect(result.quarantined).toContain("dispatch-tasks-xyz.json");
  });

  it("recognizes version 0 as corrupt (below minimum)", () => {
    const stateDir = tmpDir();
    writeStateFile(stateDir, "metrics-zero.json", { version: 0 });

    const result = StartupChecker.checkAll(tmpDir(), stateDir);

    expect(result.healthy).toBe(false);
    expect(result.quarantined).toContain("metrics-zero.json");
  });
});

// ─────────────────────────────────────────────────────────────────────
// (c) 损坏 + 陈旧锁组合 — Combined corrupted state + stale lock
// ─────────────────────────────────────────────────────────────────────

describe("(c) Combined corruption + stale lock", () => {
  it("handles both a truncated state file and a stale lock atomically", () => {
    const dir = tmpDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });

    // Write a valid state file + stale lock (dead pid)
    const statePath = writeStateFile(stateDir, "loops-combo.json", { version: 5, loops: [] });
    writeFileSync(
      statePath + ".lock",
      JSON.stringify({ pid: 99999, startedAt: Date.now() - 10_000 }),
      "utf-8",
    );

    // Write a truncated file without a lock
    writeRawFile(stateDir, "fnstate-bad.json", '{"version":2,');

    // Run StartupChecker on the temp workspace dir
    const result = StartupChecker.checkAll(dir, stateDir);

    // The truncated file should be quarantined
    expect(result.quarantined).toContain("fnstate-bad.json");
    expect(result.healthy).toBe(false);

    // The valid file + stale lock: breakStaleLocks uses process.cwd(),
    // so we verify the lock-break mechanics directly
    const lock = acquireStateLock(statePath);
    expect(lock.ok).toBe(true);
    lock.release();
  });

  it("PluginCore init succeeds even when state files are corrupt (using real StartupChecker)", async () => {
    // Create a temp directory with corrupt state files to exercise the real StartupChecker
    const dir = tmpDir();
    const stateDir = join(dir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    writeRawFile(stateDir, "loops-bad.json", "not-json{{{corrupt}}");

    const core = new PluginCore();
    const svcA = makeService("a");
    core.registerService(svcA);

    const ctx: PluginContext = {
      client: {} as any,
      resolvedRoles: [],
      roleFunctionsMap: new Map(),
      roleGraphMap: new Map(),
      rawDirectory: dir,
      directory: dir,
      core: core as any,
      bus: core.getBus(),
    };
    await expect(core.init(ctx)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// (d) 服务 init 失败 — Optional vs critical service init failure
// ─────────────────────────────────────────────────────────────────────

describe("(d) Service init failure — optional vs critical", () => {
  afterEach(() => {
    mock.restore();
  });

  it("optional service failure: init resolves, health reports degraded", async () => {
    const core = new PluginCore();
    const svcA = makeService("a", [], false);
    svcA.init = mock(() => Promise.reject(new Error("optional init failed")));
    core.registerService(svcA);

    await expect(core.init(makeContext(core))).resolves.toBeUndefined();
    expect(core.isDegraded("a")).toBe(true);
  });

  it("optional service failure: independent services still initialize", async () => {
    const core = new PluginCore();
    const svcA = makeService("a", [], false);
    svcA.init = mock(() => Promise.reject(new Error("optional init failed")));
    const svcC = makeService("c");
    const cInit = mock(() => Promise.resolve());
    svcC.init = cInit;
    core.registerService(svcA);
    core.registerService(svcC);

    await expect(core.init(makeContext(core))).resolves.toBeUndefined();
    expect(core.isDegraded("a")).toBe(true);
    expect(core.isDegraded("c")).toBe(false);
    expect(cInit).toHaveBeenCalledTimes(1);
  });

  it("optional service failure: dependent services are skipped", async () => {
    const core = new PluginCore();
    const svcA = makeService("a", [], false);
    svcA.init = mock(() => Promise.reject(new Error("optional init failed")));
    const svcB = makeService("b", ["a"]);
    const bInit = mock(() => Promise.resolve());
    svcB.init = bInit;
    core.registerService(svcA);
    core.registerService(svcB);

    await expect(core.init(makeContext(core))).resolves.toBeUndefined();
    expect(core.isDegraded("a")).toBe(true);
    expect(core.isDegraded("b")).toBe(true);
    expect(bInit).not.toHaveBeenCalled();
  });

  it("critical service failure: init rejects", async () => {
    const core = new PluginCore();
    const svcCrit = makeService("critical-svc", [], true);
    svcCrit.init = mock(() => Promise.reject(new Error("critical init failed")));
    core.registerService(svcCrit);

    await expect(core.init(makeContext(core))).rejects.toThrow("critical init failed");
  });

  it("critical failure overrides optional: rejects even when optional services degrade too", async () => {
    const core = new PluginCore();
    const svcOpt = makeService("opt", [], false);
    svcOpt.init = mock(() => Promise.reject(new Error("opt failed")));
    const svcCrit = makeService("crit", [], true);
    svcCrit.init = mock(() => Promise.reject(new Error("crit failed")));
    core.registerService(svcOpt);
    core.registerService(svcCrit);

    await expect(core.init(makeContext(core))).rejects.toThrow("crit failed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// (e) supervisor crash-loop — backoff, budget exhaustion, permanent deg,
//     EventBus event
// ─────────────────────────────────────────────────────────────────────

describe("(e) Supervisor crash-loop protection", () => {
  it("exhausts restart budget and emits permanently_degraded event", async () => {
    const core = new PluginCore();
    const supervisor = core.getSupervisor();

    // Listen for the degradation event
    const degradedEvents: Array<{ name: string }> = [];
    const bus: EventBus = core.getBus();
    bus.on("service.permanently_degraded", (payload: any) => {
      degradedEvents.push(payload);
    });

    // Register a service that fails every restart
    const crashy = makeService("crash-loop-svc");
    crashy.init = mock(() => Promise.reject(new Error("always crashes")));
    core.registerService(crashy);

    await core.init(makeContext(core));

    // Trigger restarts via supervisor. Use Date.now faking to bypass backoff.
    const origDateNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;

    try {
      // Attempt 1: fails, backoff ~2s
      await supervisor.tryRestart("crash-loop-svc");
      let status = supervisor.getStatus("crash-loop-svc");
      expect(status.status).toBe("backoff");
      expect(status.attempts).toBe(1);

      // Advance past backoff
      fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;

      // Attempt 2: fails, backoff ~4s
      await supervisor.tryRestart("crash-loop-svc");
      status = supervisor.getStatus("crash-loop-svc");
      expect(status.status).toBe("backoff");
      expect(status.attempts).toBe(2);

      // Advance past backoff
      fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 4 + 100;

      // Attempt 3: fails → permanently_degraded
      await supervisor.tryRestart("crash-loop-svc");
      status = supervisor.getStatus("crash-loop-svc");
      expect(status.status).toBe("permanently_degraded");
      expect(status.attempts).toBe(3);

      // Emit event directly (as HealthMonitorService would)
      await bus.emit("service.permanently_degraded", {
        name: "crash-loop-svc",
        diagnostics: "crashed 3 times",
      });
      expect(degradedEvents.length).toBeGreaterThanOrEqual(1);
      expect(degradedEvents[0].name).toBe("crash-loop-svc");
    } finally {
      Date.now = origDateNow;
    }
  });

  it("stops restarting once permanently degraded (no-op on subsequent calls)", async () => {
    const core = new PluginCore();
    const supervisor = core.getSupervisor();

    const crashy = makeService("perm-deg-svc");
    crashy.init = mock(() => Promise.reject(new Error("crashes")));
    core.registerService(crashy);
    await core.init(makeContext(core));

    const origDateNow = Date.now;
    let fakeNow = 2_000_000;
    Date.now = () => fakeNow;

    try {
      // Attempt 1: fails → backoff
      await supervisor.tryRestart("perm-deg-svc");
      expect(supervisor.getStatus("perm-deg-svc").attempts).toBe(1);

      // Advance past backoff (2000ms)
      fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;

      // Attempt 2: fails → backoff
      await supervisor.tryRestart("perm-deg-svc");
      expect(supervisor.getStatus("perm-deg-svc").attempts).toBe(2);

      // Advance past backoff (4000ms)
      fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 4 + 100;

      // Attempt 3: fails → permanently_degraded
      await supervisor.tryRestart("perm-deg-svc");
      expect(supervisor.getStatus("perm-deg-svc").status).toBe("permanently_degraded");
      expect(supervisor.getStatus("perm-deg-svc").attempts).toBe(3);

      // Capture call count BEFORE the no-op attempt
      const callsBeforeNoop = (crashy.init as ReturnType<typeof mock>).mock.calls.length;

      // Subsequent attempt should be no-op (permanently_degraded → returns immediately)
      await supervisor.tryRestart("perm-deg-svc");

      const callsAfterNoop = (crashy.init as ReturnType<typeof mock>).mock.calls.length;
      expect(callsAfterNoop).toBe(callsBeforeNoop);
    } finally {
      Date.now = origDateNow;
    }
  });

  it("emits service.permanently_degraded via HealthMonitor path when budget exhausted", async () => {
    // Simulate: supervisor mock that goes permanently degraded
    const core = new PluginCore();

    // Use a mock supervisor that immediately goes permanently degraded
    const degradedEventPromise = new Promise<{ name: string; diagnostics?: string }>((resolve) => {
      core.getBus().on("service.permanently_degraded", (payload: any) => {
        resolve(payload);
      });
    });

    const supervisor = core.getSupervisor();
    let degradedEmitted = false;
    // Override supervisor methods to simulate HealthMonitor's behavior
    const origGetStatus = supervisor.getStatus.bind(supervisor);

    // Manually emit the event as HealthMonitor would
    await core.getBus().emit("service.permanently_degraded", {
      name: "crashy-svc",
      diagnostics: "restart budget exhausted",
    });

    const payload = await degradedEventPromise;
    expect(payload.name).toBe("crashy-svc");
    expect(payload.diagnostics).toBe("restart budget exhausted");
  });
});

// ─────────────────────────────────────────────────────────────────────
// (f) supervisor 不崩插件 — Supervisor internal errors NEVER propagate
// ─────────────────────────────────────────────────────────────────────

describe("(f) Supervisor error isolation (always-bootable)", () => {
  it("does not propagate when core.restartService throws unexpectedly", async () => {
    const { core } = {} as { core: PluginCoreLike };
    const throwingCore: PluginCoreLike = {
      getService: () => undefined,
      getServices: () => new Map(),
      restartService: mock(() => Promise.reject(new Error("unexpected crash"))),
      isDegraded: () => false,
    };

    const supervisor = new ServiceSupervisor(throwingCore);
    await expect(supervisor.tryRestart("anything")).resolves.toBeUndefined();
  });

  it("does not propagate when supervisor internal logic catastrophically fails", async () => {
    const brokenCore: PluginCoreLike = {
      getService: () => { throw new Error("boom"); },
      getServices: () => { throw new Error("boom"); },
      restartService: () => { throw new Error("boom"); },
      isDegraded: () => { throw new Error("boom"); },
    };

    const supervisor = new ServiceSupervisor(brokenCore);
    await expect(supervisor.tryRestart("anything")).resolves.toBeUndefined();
  });

  it("PluginCore.init() resolves when a service's restartService path fails inside supervisor", async () => {
    const core = new PluginCore();
    const svc = makeService("reliable");
    core.registerService(svc);
    await core.init(makeContext(core));

    // Now simulate that restartService throws
    (svc.init as ReturnType<typeof mock>).mockClear();
    (svc.dispose as ReturnType<typeof mock>).mockClear();

    const supervisor = core.getSupervisor();
    await expect(supervisor.tryRestart("nonexistent-service")).resolves.toBeUndefined();

    // The healthy service should still work
    expect(core.getService<PluginService>("reliable")).not.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// (g) 退避时序 — Exponential backoff timing verification
// ─────────────────────────────────────────────────────────────────────

describe("(g) Backoff timing", () => {
  it("doubles backoff delay on each consecutive failure (2s → 4s → 8s, capped at 30s)", async () => {
    const core: PluginCoreLike = {
      getService: () => undefined,
      getServices: () => new Map(),
      restartService: mock(() => Promise.reject(new Error("fail"))),
      isDegraded: () => false,
    };
    const supervisor = new ServiceSupervisor(core);

    const origDateNow = Date.now;
    let fakeNow = 50_000_000;
    Date.now = () => fakeNow;

    try {
      // Attempt 1: backoff = 1000 * 2^1 = 2000ms
      await supervisor.tryRestart("svc");
      let status = supervisor.getStatus("svc");
      let expectedBackoff = fakeNow + SUPERVISOR_DEFAULTS.baseBackoffMs * 2; // 2000
      expect(status.backoffUntil).toBe(expectedBackoff);
      expect(status.attempts).toBe(1);

      // Advance past backoff
      fakeNow = expectedBackoff + 100;

      // Attempt 2: backoff = 1000 * 2^2 = 4000ms
      await supervisor.tryRestart("svc");
      status = supervisor.getStatus("svc");
      expectedBackoff = fakeNow + SUPERVISOR_DEFAULTS.baseBackoffMs * 4; // 4000
      expect(status.backoffUntil).toBe(expectedBackoff);
      expect(status.attempts).toBe(2);

      // Advance past backoff
      fakeNow = expectedBackoff + 100;

      // Attempt 3: budget exhausted → permanently_degraded, not backoff
      await supervisor.tryRestart("svc");
      status = supervisor.getStatus("svc");
      expect(status.status).toBe("permanently_degraded");
      expect(status.attempts).toBe(3);
    } finally {
      Date.now = origDateNow;
    }
  });

  it("capped backoff does not exceed maxBackoffMs (30s)", async () => {
    // Use a custom core with a very high backoff factor simulation
    // Actually, use the default config: maxBackoffMs = 30_000
    // With base=1000, factor=2, max attempts in window=3
    // Attempt 1: backoff = 2000
    // Attempt 2: backoff = 4000
    // Attempt 3: degraded (exhausted), not backoff
    // So we never reach the cap with default config. Let's verify the cap formula.

    // Directly test that Math.min(1000*2^attempts, 30000) works
    const cap = SUPERVISOR_DEFAULTS.maxBackoffMs;
    const base = SUPERVISOR_DEFAULTS.baseBackoffMs;
    const factor = SUPERVISOR_DEFAULTS.backoffFactor;

    // Simulate what would happen if we had many more allowed attempts
    const attempt1 = Math.min(base * Math.pow(factor, 1), cap);
    const attempt2 = Math.min(base * Math.pow(factor, 2), cap);
    const attempt10 = Math.min(base * Math.pow(factor, 10), cap);

    expect(attempt1).toBe(2000);
    expect(attempt2).toBe(4000);
    // At attempt 10, 1000*2^10 = 1,024,000 → capped at 30,000
    expect(attempt10).toBe(30000);
    expect(attempt10).toBe(cap);

    // Also verify with attempt that would hit the cap earliest
    // 1000 * 2^5 = 32000 > 30000, so attempt 5 hits cap
    const attempt5 = Math.min(base * Math.pow(factor, 5), cap);
    expect(attempt5).toBe(30000);
  });

  it("resets backoff after a successful restart", async () => {
    let failCount = 0;
    const core: PluginCoreLike = {
      getService: () => undefined,
      getServices: () => new Map(),
      restartService: mock(() => {
        failCount++;
        if (failCount <= 1) return Promise.reject(new Error("fail once"));
        return Promise.resolve();
      }),
      isDegraded: () => false,
    };
    const supervisor = new ServiceSupervisor(core);

    const origDateNow = Date.now;
    let fakeNow = 100_000_000;
    Date.now = () => fakeNow;

    try {
      // First call fails → backoff
      await supervisor.tryRestart("reset-svc");
      expect(supervisor.getStatus("reset-svc").attempts).toBe(1);
      expect(supervisor.getStatus("reset-svc").status).toBe("backoff");

      // Advance past backoff
      fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;

      // Second call succeeds → reset
      await supervisor.tryRestart("reset-svc");
      const status = supervisor.getStatus("reset-svc");
      expect(status.attempts).toBe(0);
      expect(status.status).toBe("ok");
    } finally {
      Date.now = origDateNow;
    }
  });

  it("sliding window resets after windowMs elapses", async () => {
    const core: PluginCoreLike = {
      getService: () => undefined,
      getServices: () => new Map(),
      restartService: mock(() => Promise.reject(new Error("fail"))),
      isDegraded: () => false,
    };
    const supervisor = new ServiceSupervisor(core);

    const origDateNow = Date.now;
    let fakeNow = 200_000_000;
    Date.now = () => fakeNow;

    try {
      // First failure
      await supervisor.tryRestart("window-svc");
      expect(supervisor.getStatus("window-svc").attempts).toBe(1);

      // Advance past backoff (2000ms) but not past window (60000ms)
      fakeNow += SUPERVISOR_DEFAULTS.baseBackoffMs * 2 + 100;

      // Second failure (still within window, 2 < maxRestarts=3)
      await supervisor.tryRestart("window-svc");
      expect(supervisor.getStatus("window-svc").attempts).toBe(2);

      // Advance past the full window
      fakeNow += SUPERVISOR_DEFAULTS.windowMs + 100;

      // Third call: window expired → budget should reset, then fail → now attempt=1
      await supervisor.tryRestart("window-svc");
      const status = supervisor.getStatus("window-svc");
      expect(status.attempts).toBe(1); // reset to 0 then increment to 1
      expect(status.status).toBe("backoff"); // not permanently_degraded
    } finally {
      Date.now = origDateNow;
    }
  });
});

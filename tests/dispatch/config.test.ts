import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_CONFIG,
  resolveEnvConfig,
  mergeConfig,
  DEFAULT_SYNC_PROMPT_TIMEOUT_MS,
  TASK_TTL_MS,
  MIN_RUNTIME_MS,
  BACKGROUND_STALE_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
  SYNC_TIMEOUT_MS,
  MATERIALIZE_TIMEOUT_MS,
  RESULT_RETENTION_MS,
  OUTBOX_FIRST_RETRY_MS,
  OUTBOX_MAX_RETRY_MS,
  OUTBOX_SWEEP_INTERVAL_MS,
} from "../../src/dispatch/config";

const savedEnv: Record<string, string | undefined> = {};

function resetEnvVars() {
  for (const key of [
    "ROLEBOX_DISPATCH_BG_STALE_MS",
    "ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS",
    "ROLEBOX_DISPATCH_RESULT_RETENTION_MS",
  ]) {
    if (key in process.env) {
      savedEnv[key] = process.env[key];
    }
    delete process.env[key];
  }
}

function restoreEnvVars() {
  for (const key of Object.keys(savedEnv)) {
    process.env[key] = savedEnv[key];
  }
}

describe("DEFAULT_CONFIG", () => {
  it("contains all live config fields with correct default values", () => {
    expect(DEFAULT_CONFIG.syncPromptTimeoutMs).toBe(DEFAULT_SYNC_PROMPT_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.syncPromptTimeoutMs).toBe(600000);

    expect(DEFAULT_CONFIG.materializeTimeoutMs).toBe(MATERIALIZE_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.materializeTimeoutMs).toBe(10000);

    expect(DEFAULT_CONFIG.resultRetentionMs).toBe(RESULT_RETENTION_MS);
    expect(DEFAULT_CONFIG.resultRetentionMs).toBe(3600000);

    expect(DEFAULT_CONFIG.outboxFirstRetryMs).toBe(OUTBOX_FIRST_RETRY_MS);
    expect(DEFAULT_CONFIG.outboxFirstRetryMs).toBe(3000);

    expect(DEFAULT_CONFIG.outboxMaxRetryMs).toBe(OUTBOX_MAX_RETRY_MS);
    expect(DEFAULT_CONFIG.outboxMaxRetryMs).toBe(60000);

    expect(DEFAULT_CONFIG.outboxSweepIntervalMs).toBe(OUTBOX_SWEEP_INTERVAL_MS);
    expect(DEFAULT_CONFIG.outboxSweepIntervalMs).toBe(5000);
  });

  it("retains all live timing fields", () => {
    expect(DEFAULT_CONFIG.taskTtlMs).toBe(TASK_TTL_MS);
    expect(DEFAULT_CONFIG.minRuntimeMs).toBe(MIN_RUNTIME_MS);
    expect(DEFAULT_CONFIG.backgroundStaleTimeoutMs).toBe(BACKGROUND_STALE_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.watchdogIntervalMs).toBe(WATCHDOG_INTERVAL_MS);
    expect(DEFAULT_CONFIG.globalSweepIntervalMs).toBe(GLOBAL_SWEEP_INTERVAL_MS);
    expect(DEFAULT_CONFIG.idleDebounceMs).toBe(IDLE_DEBOUNCE_MS);
    expect(DEFAULT_CONFIG.syncTimeoutMs).toBe(SYNC_TIMEOUT_MS);
  });

  it("does not contain removed concurrency/budget fields", () => {
    expect("maxConcurrent" in DEFAULT_CONFIG).toBe(false);
    expect("maxQueueDepth" in DEFAULT_CONFIG).toBe(false);
    expect("syncReservedSlots" in DEFAULT_CONFIG).toBe(false);
    expect("maxActivePerParent" in DEFAULT_CONFIG).toBe(false);
    expect("maxTotalSessionsPerRequest" in DEFAULT_CONFIG).toBe(false);
    expect("retryAfterMs" in DEFAULT_CONFIG).toBe(false);
    expect("backpressureMaxRetries" in DEFAULT_CONFIG).toBe(false);
    expect("backpressureMaxDelayMs" in DEFAULT_CONFIG).toBe(false);
    expect("syncAcquireTimeoutMs" in DEFAULT_CONFIG).toBe(false);
  });

  it("does not contain dead poll-era fields", () => {
    expect("pollIntervalMs" in DEFAULT_CONFIG).toBe(false);
    expect("staleTimeoutMs" in DEFAULT_CONFIG).toBe(false);
    expect("sessionGoneTimeoutMs" in DEFAULT_CONFIG).toBe(false);
    expect("messageStalenessTimeoutMs" in DEFAULT_CONFIG).toBe(false);
    expect("minStabilityPolls" in DEFAULT_CONFIG).toBe(false);
    expect("minSessionGonePolls" in DEFAULT_CONFIG).toBe(false);
    expect("minPollIntervalMs" in DEFAULT_CONFIG).toBe(false);
    expect("maxPollIntervalMs" in DEFAULT_CONFIG).toBe(false);
  });
});

describe("resolveEnvConfig", () => {
  beforeEach(resetEnvVars);
  afterEach(restoreEnvVars);

  it("returns empty object when no env vars are set", () => {
    const result = resolveEnvConfig();
    expect(Object.keys(result).length).toBe(0);
  });

  it("parses valid numeric env vars", () => {
    process.env.ROLEBOX_DISPATCH_BG_STALE_MS = "600000";
    process.env.ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS = "20000";
    process.env.ROLEBOX_DISPATCH_RESULT_RETENTION_MS = "7200000";

    const result = resolveEnvConfig();
    expect(result.backgroundStaleTimeoutMs).toBe(600000);
    expect(result.materializeTimeoutMs).toBe(20000);
    expect(result.resultRetentionMs).toBe(7200000);
  });

  it("ignores NaN values", () => {
    process.env.ROLEBOX_DISPATCH_BG_STALE_MS = "not-a-number";
    process.env.ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS = "abc";

    const result = resolveEnvConfig();
    expect("backgroundStaleTimeoutMs" in result).toBe(false);
    expect("materializeTimeoutMs" in result).toBe(false);
  });

  it("ignores values ≤ 0", () => {
    process.env.ROLEBOX_DISPATCH_BG_STALE_MS = "0";
    process.env.ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS = "-5";

    const result = resolveEnvConfig();
    expect("backgroundStaleTimeoutMs" in result).toBe(false);
    expect("materializeTimeoutMs" in result).toBe(false);
  });

  it("ignores empty string values", () => {
    process.env.ROLEBOX_DISPATCH_BG_STALE_MS = "";
    process.env.ROLEBOX_DISPATCH_RESULT_RETENTION_MS = "";

    const result = resolveEnvConfig();
    expect("backgroundStaleTimeoutMs" in result).toBe(false);
    expect("resultRetentionMs" in result).toBe(false);
  });

  it("returns only explicitly set keys (not all config keys)", () => {
    process.env.ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS = "8000";

    const result = resolveEnvConfig();
    expect(Object.keys(result)).toEqual(["materializeTimeoutMs"]);
    expect(result.materializeTimeoutMs).toBe(8000);
  });

  it("parses all supported env vars", () => {
    process.env.ROLEBOX_DISPATCH_BG_STALE_MS = "600000";
    process.env.ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS = "20000";
    process.env.ROLEBOX_DISPATCH_RESULT_RETENTION_MS = "7200000";

    const result = resolveEnvConfig();
    expect(result.backgroundStaleTimeoutMs).toBe(600000);
    expect(result.materializeTimeoutMs).toBe(20000);
    expect(result.resultRetentionMs).toBe(7200000);
    expect(Object.keys(result).length).toBe(3);
  });
});

describe("mergeConfig", () => {
  it("returns base when no overrides", () => {
    const result = mergeConfig(DEFAULT_CONFIG);
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("role overrides base", () => {
    const roleCfg = { materializeTimeoutMs: 20000, resultRetentionMs: 7200000 };
    const result = mergeConfig(DEFAULT_CONFIG, roleCfg);
    expect(result.materializeTimeoutMs).toBe(20000);
    expect(result.resultRetentionMs).toBe(7200000);
    expect(result.syncTimeoutMs).toBe(DEFAULT_CONFIG.syncTimeoutMs);
  });

  it("env overrides role", () => {
    const roleCfg = { materializeTimeoutMs: 20000 };
    const envCfg = { materializeTimeoutMs: 30000, resultRetentionMs: 7200000 };
    const result = mergeConfig(DEFAULT_CONFIG, roleCfg, envCfg);
    expect(result.materializeTimeoutMs).toBe(30000);
    expect(result.resultRetentionMs).toBe(7200000);
  });

  it("env > role > default precedence for overlapping key", () => {
    const base = { ...DEFAULT_CONFIG, materializeTimeoutMs: 5000 };
    const roleCfg = { materializeTimeoutMs: 8000 };
    const envCfg = { materializeTimeoutMs: 12000 };

    const result = mergeConfig(base, roleCfg, envCfg);
    expect(result.materializeTimeoutMs).toBe(12000);
  });

  it("empty overrides do not mutate base", () => {
    const result = mergeConfig(DEFAULT_CONFIG, {}, {});
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("partial env-only override", () => {
    const envCfg = { backgroundStaleTimeoutMs: 500000 };
    const result = mergeConfig(DEFAULT_CONFIG, undefined, envCfg);
    expect(result.backgroundStaleTimeoutMs).toBe(500000);
    expect(result.materializeTimeoutMs).toBe(DEFAULT_CONFIG.materializeTimeoutMs);
  });

  it("does not mutate input objects", () => {
    const base = { ...DEFAULT_CONFIG };
    const roleCfg = { materializeTimeoutMs: 99999 };
    mergeConfig(base, roleCfg);
    expect(base.materializeTimeoutMs).toBe(DEFAULT_CONFIG.materializeTimeoutMs);
    expect(roleCfg.materializeTimeoutMs).toBe(99999);
  });
});

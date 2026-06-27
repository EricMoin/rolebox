import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_CONFIG,
  resolveEnvConfig,
  mergeConfig,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_SYNC_RESERVED_SLOTS,
  DEFAULT_MAX_ACTIVE_PER_PARENT,
  DEFAULT_RETRY_AFTER_MS,
  DEFAULT_BACKPRESSURE_MAX_RETRIES,
  DEFAULT_BACKPRESSURE_MAX_DELAY_MS,
  DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS,
  DEFAULT_SYNC_PROMPT_TIMEOUT_MS,
  TASK_TTL_MS,
  MIN_RUNTIME_MS,
  BACKGROUND_STALE_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  GLOBAL_SWEEP_INTERVAL_MS,
  IDLE_DEBOUNCE_MS,
  SYNC_TIMEOUT_MS,
} from "../../src/dispatch/config";

const savedEnv: Record<string, string | undefined> = {};

function resetEnvVars() {
  for (const key of [
    "ROLEBOX_DISPATCH_MAX_CONCURRENT",
    "ROLEBOX_DISPATCH_MAX_QUEUE_DEPTH",
    "ROLEBOX_DISPATCH_SYNC_RESERVED",
    "ROLEBOX_DISPATCH_MAX_ACTIVE_PER_PARENT",
    "ROLEBOX_DISPATCH_RETRY_AFTER_MS",
    "ROLEBOX_DISPATCH_BG_STALE_MS",
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
  it("contains all new config fields with correct default values", () => {
    expect(DEFAULT_CONFIG.maxActivePerParent).toBe(DEFAULT_MAX_ACTIVE_PER_PARENT);
    expect(DEFAULT_CONFIG.maxActivePerParent).toBe(3);

    expect(DEFAULT_CONFIG.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(DEFAULT_CONFIG.retryAfterMs).toBe(30000);

    expect(DEFAULT_CONFIG.backpressureMaxRetries).toBe(DEFAULT_BACKPRESSURE_MAX_RETRIES);
    expect(DEFAULT_CONFIG.backpressureMaxRetries).toBe(5);

    expect(DEFAULT_CONFIG.backpressureMaxDelayMs).toBe(DEFAULT_BACKPRESSURE_MAX_DELAY_MS);
    expect(DEFAULT_CONFIG.backpressureMaxDelayMs).toBe(60000);

    expect(DEFAULT_CONFIG.syncAcquireTimeoutMs).toBe(DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.syncAcquireTimeoutMs).toBe(120000);

    expect(DEFAULT_CONFIG.syncPromptTimeoutMs).toBe(DEFAULT_SYNC_PROMPT_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.syncPromptTimeoutMs).toBe(600000);
  });

  it("retains all live legacy fields", () => {
    expect(DEFAULT_CONFIG.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(DEFAULT_CONFIG.maxQueueDepth).toBe(DEFAULT_MAX_QUEUE_DEPTH);
    expect(DEFAULT_CONFIG.syncReservedSlots).toBe(DEFAULT_SYNC_RESERVED_SLOTS);
    expect(DEFAULT_CONFIG.taskTtlMs).toBe(TASK_TTL_MS);
    expect(DEFAULT_CONFIG.minRuntimeMs).toBe(MIN_RUNTIME_MS);
    expect(DEFAULT_CONFIG.backgroundStaleTimeoutMs).toBe(BACKGROUND_STALE_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.watchdogIntervalMs).toBe(WATCHDOG_INTERVAL_MS);
    expect(DEFAULT_CONFIG.globalSweepIntervalMs).toBe(GLOBAL_SWEEP_INTERVAL_MS);
    expect(DEFAULT_CONFIG.idleDebounceMs).toBe(IDLE_DEBOUNCE_MS);
    expect(DEFAULT_CONFIG.syncTimeoutMs).toBe(SYNC_TIMEOUT_MS);
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
    process.env.ROLEBOX_DISPATCH_MAX_CONCURRENT = "10";
    process.env.ROLEBOX_DISPATCH_MAX_QUEUE_DEPTH = "20";
    process.env.ROLEBOX_DISPATCH_SYNC_RESERVED = "2";

    const result = resolveEnvConfig();
    expect(result.maxConcurrent).toBe(10);
    expect(result.maxQueueDepth).toBe(20);
    expect(result.syncReservedSlots).toBe(2);
  });

  it("ignores NaN values", () => {
    process.env.ROLEBOX_DISPATCH_MAX_CONCURRENT = "not-a-number";
    process.env.ROLEBOX_DISPATCH_RETRY_AFTER_MS = "abc";

    const result = resolveEnvConfig();
    expect("maxConcurrent" in result).toBe(false);
    expect("retryAfterMs" in result).toBe(false);
  });

  it("ignores values ≤ 0", () => {
    process.env.ROLEBOX_DISPATCH_MAX_CONCURRENT = "0";
    process.env.ROLEBOX_DISPATCH_MAX_QUEUE_DEPTH = "-5";
    process.env.ROLEBOX_DISPATCH_SYNC_RESERVED = "0";

    const result = resolveEnvConfig();
    expect("maxConcurrent" in result).toBe(false);
    expect("maxQueueDepth" in result).toBe(false);
    expect("syncReservedSlots" in result).toBe(false);
  });

  it("ignores empty string values", () => {
    process.env.ROLEBOX_DISPATCH_MAX_CONCURRENT = "";
    process.env.ROLEBOX_DISPATCH_MAX_ACTIVE_PER_PARENT = "";

    const result = resolveEnvConfig();
    expect("maxConcurrent" in result).toBe(false);
    expect("maxActivePerParent" in result).toBe(false);
  });

  it("returns only explicitly set keys (not all config keys)", () => {
    process.env.ROLEBOX_DISPATCH_MAX_CONCURRENT = "8";

    const result = resolveEnvConfig();
    expect(Object.keys(result)).toEqual(["maxConcurrent"]);
    expect(result.maxConcurrent).toBe(8);
  });

  it("parses all supported env vars", () => {
    process.env.ROLEBOX_DISPATCH_MAX_CONCURRENT = "10";
    process.env.ROLEBOX_DISPATCH_MAX_QUEUE_DEPTH = "50";
    process.env.ROLEBOX_DISPATCH_SYNC_RESERVED = "3";
    process.env.ROLEBOX_DISPATCH_MAX_ACTIVE_PER_PARENT = "7";
    process.env.ROLEBOX_DISPATCH_RETRY_AFTER_MS = "15000";
    process.env.ROLEBOX_DISPATCH_BG_STALE_MS = "600000";

    const result = resolveEnvConfig();
    expect(result.maxConcurrent).toBe(10);
    expect(result.maxQueueDepth).toBe(50);
    expect(result.syncReservedSlots).toBe(3);
    expect(result.maxActivePerParent).toBe(7);
    expect(result.retryAfterMs).toBe(15000);
    expect(result.backgroundStaleTimeoutMs).toBe(600000);
    expect(Object.keys(result).length).toBe(6);
  });
});

describe("mergeConfig", () => {
  it("returns base when no overrides", () => {
    const result = mergeConfig(DEFAULT_CONFIG);
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("role overrides base", () => {
    const roleCfg = { maxConcurrent: 10, retryAfterMs: 15000 };
    const result = mergeConfig(DEFAULT_CONFIG, roleCfg);
    expect(result.maxConcurrent).toBe(10);
    expect(result.retryAfterMs).toBe(15000);
    expect(result.maxQueueDepth).toBe(DEFAULT_CONFIG.maxQueueDepth);
  });

  it("env overrides role", () => {
    const roleCfg = { maxConcurrent: 10 };
    const envCfg = { maxConcurrent: 20, retryAfterMs: 15000 };
    const result = mergeConfig(DEFAULT_CONFIG, roleCfg, envCfg);
    expect(result.maxConcurrent).toBe(20);
    expect(result.retryAfterMs).toBe(15000);
  });

  it("env > role > default precedence for overlapping key", () => {
    const base = { ...DEFAULT_CONFIG, maxConcurrent: 3 };
    const roleCfg = { maxConcurrent: 8 };
    const envCfg = { maxConcurrent: 12 };

    const result = mergeConfig(base, roleCfg, envCfg);
    expect(result.maxConcurrent).toBe(12);
  });

  it("empty overrides do not mutate base", () => {
    const result = mergeConfig(DEFAULT_CONFIG, {}, {});
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("partial env-only override", () => {
    const envCfg = { maxActivePerParent: 5 };
    const result = mergeConfig(DEFAULT_CONFIG, undefined, envCfg);
    expect(result.maxActivePerParent).toBe(5);
    expect(result.maxConcurrent).toBe(DEFAULT_CONFIG.maxConcurrent);
  });

  it("does not mutate input objects", () => {
    const base = { ...DEFAULT_CONFIG };
    const roleCfg = { maxConcurrent: 99 };
    mergeConfig(base, roleCfg);
    expect(base.maxConcurrent).toBe(DEFAULT_CONFIG.maxConcurrent);
    expect(roleCfg.maxConcurrent).toBe(99);
  });
});

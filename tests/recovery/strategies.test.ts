/**
 * ─────────────────────────────────────────────────────────────────────
 * Sub-task 7: strategies unit tests
 *
 * Covers StrategyRegistry (register/get/has/names/clear) and all
 * built-in strategy execution (retry, compact, abort, fallback_model,
 * remind_and_retry, truncate, summarize), plus custom strategy
 * registration.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { StrategyRegistry } from "../../src/recovery/strategies/registry.ts";
import { retryStrategy } from "../../src/recovery/strategies/retry-strategy.ts";
import { abortStrategy } from "../../src/recovery/strategies/abort-strategy.ts";
import { compactStrategy } from "../../src/recovery/strategies/compact-strategy.ts";
import { summarizeStrategy } from "../../src/recovery/strategies/summarize-strategy.ts";
import { truncateStrategy } from "../../src/recovery/strategies/truncate-strategy.ts";
import { fallbackModelStrategy } from "../../src/recovery/strategies/fallback-model-strategy.ts";
import { remindAndRetryStrategy } from "../../src/recovery/strategies/remind-and-retry-strategy.ts";
import { registerBuiltinStrategies } from "../../src/recovery/strategies/index.ts";
import type {
  RecoveryStrategy,
  RecoveryStrategyContext,
  RecoveryStrategyResult,
  RecoveryError,
} from "../../src/recovery/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<RecoveryStrategyContext>): RecoveryStrategyContext {
  return {
    sessionID: "test-session",
    error: {
      category: "session_error",
      errorType: "test_error",
      message: "test error message",
      timestamp: Date.now(),
    },
    attempt: 0,
    stepConfig: {},
    inject: () => {},
    ...overrides,
  };
}

function makeError(overrides?: Partial<RecoveryError>): RecoveryError {
  return {
    category: "session_error",
    errorType: "test_error",
    message: "test error",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── StrategyRegistry Tests ───────────────────────────────────────────────

describe("StrategyRegistry", () => {
  afterEach(() => {
    mock.restore();
  });

  it("starts empty", () => {
    const reg = new StrategyRegistry();
    expect(reg.names()).toEqual([]);
    expect(reg.has("anything")).toBe(false);
    expect(reg.get("anything")).toBeUndefined();
  });

  it("register adds a strategy", () => {
    const reg = new StrategyRegistry();
    const strategy: RecoveryStrategy = {
      name: "test-strat",
      async execute() {
        return { status: "success", message: "ok" };
      },
    };
    reg.register(strategy);
    expect(reg.has("test-strat")).toBe(true);
    expect(reg.get("test-strat")).toBe(strategy);
    expect(reg.names()).toContain("test-strat");
  });

  it("register overwrites existing strategy with same name", () => {
    const reg = new StrategyRegistry();
    const s1: RecoveryStrategy = { name: "dup", async execute() { return { status: "success", message: "v1" }; } };
    const s2: RecoveryStrategy = { name: "dup", async execute() { return { status: "success", message: "v2" }; } };
    reg.register(s1);
    reg.register(s2);
    expect(reg.get("dup")).toBe(s2);
  });

  it("clear removes all strategies", () => {
    const reg = new StrategyRegistry();
    reg.register({ name: "a", async execute() { return { status: "success" }; } });
    reg.register({ name: "b", async execute() { return { status: "success" }; } });
    expect(reg.names()).toHaveLength(2);
    reg.clear();
    expect(reg.names()).toHaveLength(0);
  });

  it("names returns all registered strategy names", () => {
    const reg = new StrategyRegistry();
    reg.register({ name: "x", async execute() { return { status: "success" }; } });
    reg.register({ name: "y", async execute() { return { status: "success" }; } });
    reg.register({ name: "z", async execute() { return { status: "success" }; } });
    const names = reg.names();
    expect(names).toHaveLength(3);
    expect(names).toContain("x");
    expect(names).toContain("y");
    expect(names).toContain("z");
  });
});

// ── Built-in Strategy Tests ──────────────────────────────────────────────

describe("retryStrategy", () => {
  it("returns retry when attempt < max_retries", async () => {
    const ctx = makeCtx({ attempt: 0, stepConfig: { max_retries: 2, backoff_ms: 100, backoff_factor: 2 } });
    const result = await retryStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect((result as any).delayMs).toBeGreaterThan(0);
  });

  it("returns next_strategy when attempt >= max_retries", async () => {
    const ctx = makeCtx({ attempt: 2, stepConfig: { max_retries: 2 } });
    const result = await retryStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
  });

  it("uses defaults when config is missing", async () => {
    const ctx = makeCtx({ attempt: 0, stepConfig: {} });
    const result = await retryStrategy.execute(ctx);
    expect(result.status).toBe("retry");
  });

  it("computes exponential delay", async () => {
    const ctx = makeCtx({ attempt: 1, stepConfig: { backoff_ms: 1000, backoff_factor: 2 } });
    const result = await retryStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect((result as any).delayMs).toBe(2000); // 1000 * 2^1
  });
});

describe("abortStrategy", () => {
  it("returns abort with configured message", async () => {
    const injected: string[] = [];
    const ctx = makeCtx({
      stepConfig: { message: "custom abort message" },
      inject: (t) => { injected.push(t); },
      error: makeError({ message: "something broke" }),
    });
    const result = await abortStrategy.execute(ctx);
    expect(result.status).toBe("abort");
    expect((result as any).reason).toBe("custom abort message");
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]).toContain("custom abort message");
    expect(injected[0]).toContain("something broke");
  });

  it("uses default message when none configured", async () => {
    const ctx = makeCtx({ stepConfig: {} });
    const result = await abortStrategy.execute(ctx);
    expect(result.status).toBe("abort");
    expect((result as any).reason).toContain("Recovery aborted");
  });
});

describe("compactStrategy", () => {
  it("returns next_strategy when client has no session.compact", async () => {
    const ctx = makeCtx({});
    const result = await compactStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
    expect((result as any).reason).toContain("not available");
  });

  it("returns success when compact succeeds", async () => {
    const compact = mock(() => Promise.resolve());
    const ctx = makeCtx({
      client: { session: { compact } },
    });
    const result = await compactStrategy.execute(ctx);
    expect(result.status).toBe("success");
    expect(compact).toHaveBeenCalledWith({ path: { id: "test-session" } });
  });

  it("returns next_strategy when compact throws", async () => {
    const compact = mock(() => Promise.reject(new Error("compact failed")));
    const ctx = makeCtx({
      client: { session: { compact } },
    });
    const result = await compactStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
  });
});

describe("summarizeStrategy", () => {
  it("injects+retry when no client.session.promptAsync exists", async () => {
    const injected: string[] = [];
    const ctx = makeCtx({ inject: (t) => { injected.push(t); } });
    const result = await summarizeStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]).toContain("SUMMARIZATION");
  });

  it("returns success when promptAsync succeeds", async () => {
    const promptAsync = mock(() => Promise.resolve({}));
    const ctx = makeCtx({
      client: { session: { promptAsync } },
      error: makeError({ message: "too many tokens" }),
    });
    const result = await summarizeStrategy.execute(ctx);
    expect(result.status).toBe("success");
  });

  it("falls back to inject when promptAsync throws", async () => {
    const promptAsync = mock(() => Promise.reject(new Error("api down")));
    const injected: string[] = [];
    const ctx = makeCtx({
      client: { session: { promptAsync } },
      inject: (t) => { injected.push(t); },
      error: makeError({ message: "too many tokens" }),
    });
    const result = await summarizeStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect(injected.length).toBeGreaterThan(0);
  });
});

describe("truncateStrategy", () => {
  it("returns retry with inject when attempt < max_truncations", async () => {
    const injected: string[] = [];
    const ctx = makeCtx({
      attempt: 0,
      stepConfig: { max_truncations: 3, target_ratio: 0.6 },
      inject: (t) => { injected.push(t); },
    });
    const result = await truncateStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]).toContain("TRUNCATION");
  });

  it("returns next_strategy when attempt >= max_truncations", async () => {
    const ctx = makeCtx({ attempt: 8, stepConfig: { max_truncations: 8 } });
    const result = await truncateStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
  });

  it("uses defaults when config is missing", async () => {
    const ctx = makeCtx({ attempt: 0, stepConfig: {} });
    const result = await truncateStrategy.execute(ctx);
    expect(result.status).toBe("retry");
  });
});

describe("fallbackModelStrategy", () => {
  it("returns next_strategy when no model configured", async () => {
    const ctx = makeCtx({ stepConfig: {} });
    const result = await fallbackModelStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
  });

  it("returns success when promptAsync succeeds", async () => {
    const promptAsync = mock(() => Promise.resolve({}));
    const ctx = makeCtx({
      stepConfig: { model: "claude-3-haiku" },
      client: { session: { promptAsync } },
      error: makeError({ message: "model overloaded" }),
    });
    const result = await fallbackModelStrategy.execute(ctx);
    expect(result.status).toBe("success");
  });

  it("returns next_strategy when promptAsync throws", async () => {
    const promptAsync = mock(() => Promise.reject(new Error("no fallback available")));
    const ctx = makeCtx({
      stepConfig: { model: "gpt-3.5" },
      client: { session: { promptAsync } },
    });
    const result = await fallbackModelStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
  });
});

describe("remindAndRetryStrategy", () => {
  it("returns retry with inject and delay when attempt < max_retries", async () => {
    const injected: string[] = [];
    const ctx = makeCtx({
      attempt: 0,
      stepConfig: { max_retries: 3, reminder_text: "FIX IT" },
      inject: (t) => { injected.push(t); },
    });
    const result = await remindAndRetryStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect((result as any).delayMs).toBe(1000);
    expect(injected[0]).toContain("FIX IT");
  });

  it("returns next_strategy when attempt >= max_retries", async () => {
    const ctx = makeCtx({ attempt: 2, stepConfig: { max_retries: 2 } });
    const result = await remindAndRetryStrategy.execute(ctx);
    expect(result.status).toBe("next_strategy");
  });

  it("uses default reminder when none configured", async () => {
    const injected: string[] = [];
    const ctx = makeCtx({ attempt: 0, stepConfig: { max_retries: 1 }, inject: (t) => { injected.push(t); } });
    const result = await remindAndRetryStrategy.execute(ctx);
    expect(result.status).toBe("retry");
    expect(injected[0]).toContain("ERROR");
  });
});

// ── registerBuiltinStrategies ────────────────────────────────────────────

describe("registerBuiltinStrategies", () => {
  it("registers all 7 built-in strategies", () => {
    const reg = new StrategyRegistry();
    registerBuiltinStrategies(reg);
    const names = reg.names();
    expect(names).toHaveLength(7);
    expect(names).toContain("retry");
    expect(names).toContain("compact");
    expect(names).toContain("fallback_model");
    expect(names).toContain("abort");
    expect(names).toContain("remind_and_retry");
    expect(names).toContain("truncate");
    expect(names).toContain("summarize");
  });
});

// ── Custom Strategy Registration ─────────────────────────────────────────

describe("custom strategy registration", () => {
  it("allows registering a custom strategy and executing it via the registry", async () => {
    const reg = new StrategyRegistry();
    const custom: RecoveryStrategy = {
      name: "my_custom_recovery",
      async execute(ctx): Promise<RecoveryStrategyResult> {
        ctx.inject(`[CUSTOM] Attempt ${ctx.attempt}: ${ctx.error.message}`);
        return { status: "success", message: "custom recovery applied" };
      },
    };

    reg.register(custom);
    expect(reg.has("my_custom_recovery")).toBe(true);

    const injected: string[] = [];
    const result = await reg.get("my_custom_recovery")!.execute(
      makeCtx({ inject: (t) => { injected.push(t); } }),
    );
    expect(result.status).toBe("success");
    expect((result as any).message).toBe("custom recovery applied");
    expect(injected[0]).toContain("[CUSTOM]");
  });

  it("allows registering a strategy that returns abort", async () => {
    const reg = new StrategyRegistry();
    const custom: RecoveryStrategy = {
      name: "fail_fast",
      async execute() {
        return { status: "abort", reason: "user requested abort" };
      },
    };
    reg.register(custom);
    const result = await reg.get("fail_fast")!.execute(makeCtx());
    expect(result.status).toBe("abort");
  });

  it("allows registering a strategy that returns next_strategy", async () => {
    const reg = new StrategyRegistry();
    const custom: RecoveryStrategy = {
      name: "skip_strategy",
      async execute() {
        return { status: "next_strategy", reason: "skip me" };
      },
    };
    reg.register(custom);
    const result = await reg.get("skip_strategy")!.execute(makeCtx());
    expect(result.status).toBe("next_strategy");
  });
});

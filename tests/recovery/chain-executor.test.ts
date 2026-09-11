/**
 * ─────────────────────────────────────────────────────────────────────
 * Sub-task 7: chain-executor unit tests
 *
 * Covers RecoveryChainExecutor: strategy chain ordering, retry/backoff
 * on same step, partial failure moving to next strategy, abort,
 * global attempt limit, missing strategies, onAttempt callback.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { RecoveryChainExecutor, type ChainResult } from "../../src/recovery/chain-executor.ts";
import { StrategyRegistry } from "../../src/recovery/strategies/registry.ts";
import type {
  RecoveryStrategy,
  RecoveryConfig,
  RecoveryChainConfig,
  RecoveryError,
  RecoveryAttempt,
} from "../../src/recovery/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeError(overrides?: Partial<RecoveryError>): RecoveryError {
  return {
    category: "session_error",
    errorType: "test_error",
    message: "something went wrong",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<RecoveryConfig>): RecoveryConfig {
  return {
    enabled: true,
    maxTotalAttempts: 10,
    persistState: false,
    collectMetrics: false,
    chains: {},
    ...overrides,
  };
}

/** Factory for a simple strategy that always returns the given result. */
function fixedStrategy(name: string, result: { status: "success" | "retry" | "next_strategy" | "abort"; message?: string; delayMs?: number; reason?: string }): RecoveryStrategy {
  return {
    name,
    async execute() {
      return result as any;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("RecoveryChainExecutor", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns exhausted when chain is disabled", async () => {
    const registry = new StrategyRegistry();
    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "retry" }], enabled: false },
      () => {},
    );
    expect(result.status).toBe("exhausted");
    expect(result.totalAttempts).toBe(0);
    expect(result.finalError).toBe("chain disabled");
  });

  it("returns exhausted when chain is empty", async () => {
    const registry = new StrategyRegistry();
    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [] },
      () => {},
    );
    expect(result.status).toBe("exhausted");
    expect(result.totalAttempts).toBe(0);
    expect(result.finalError).toBe("empty chain");
  });

  it("executes strategies in order and returns recovered on success", async () => {
    const registry = new StrategyRegistry();
    registry.register(fixedStrategy("step-a", { status: "next_strategy", reason: "skip" }));
    registry.register(fixedStrategy("step-b", { status: "success", message: "fixed" }));

    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "step-a" }, { strategy: "step-b" }] },
      () => {},
    );
    expect(result.status).toBe("recovered");
    expect(result.totalAttempts).toBe(2);
    expect(result.finalError).toBe("fixed");
  });

  it("skips unregistered strategies and continues chain", async () => {
    const registry = new StrategyRegistry();
    registry.register(fixedStrategy("step-b", { status: "success", message: "ok" }));

    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "missing-strategy" }, { strategy: "step-b" }] },
      () => {},
    );
    expect(result.status).toBe("recovered");
    expect(result.totalAttempts).toBe(1);
  });

  it("stays on same step when strategy returns retry", async () => {
    let callCount = 0;
    const registry = new StrategyRegistry();
    registry.register({
      name: "flaky",
      async execute() {
        callCount++;
        if (callCount < 3) {
          return { status: "retry" as const, reason: "not yet", delayMs: 1 };
        }
        return { status: "success" as const, message: "ok on third try" };
      },
    });

    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "flaky" }] },
      () => {},
    );
    expect(result.status).toBe("recovered");
    expect(result.totalAttempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it("returns aborted when strategy returns abort", async () => {
    const registry = new StrategyRegistry();
    registry.register(fixedStrategy("doom", { status: "abort", reason: "cannot proceed" }));

    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "doom" }] },
      () => {},
    );
    expect(result.status).toBe("aborted");
    expect(result.finalError).toBe("cannot proceed");
    expect(result.totalAttempts).toBe(1);
  });

  it("respects global maxTotalAttempts limit", async () => {
    const registry = new StrategyRegistry();
    registry.register({
      name: "always-retry",
      async execute() {
        return { status: "retry" as const, reason: "keep trying", delayMs: 1 };
      },
    });

    const executor = new RecoveryChainExecutor(registry, makeConfig({ maxTotalAttempts: 3 }));
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "always-retry" }] },
      () => {},
    );
    expect(result.status).toBe("exhausted");
    expect(result.finalError).toBe("global attempt limit reached");
    expect(result.totalAttempts).toBe(3);
  });

  it("invokes onAttempt callback for each strategy execution", async () => {
    const registry = new StrategyRegistry();
    registry.register(fixedStrategy("s1", { status: "next_strategy", reason: "skip" }));
    registry.register(fixedStrategy("s2", { status: "success", message: "done" }));

    const attempts: RecoveryAttempt[] = [];
    const executor = new RecoveryChainExecutor(registry, makeConfig());

    await executor.executeChain(
      "test-session",
      makeError({ errorType: "test_type" }),
      { chain: [{ strategy: "s1" }, { strategy: "s2" }] },
      () => {},
      undefined,
      (a) => { attempts.push(a); },
    );

    expect(attempts).toHaveLength(2);
    expect(attempts[0].strategy).toBe("s1");
    expect(attempts[0].result).toBe("next_strategy");
    expect(attempts[0].chainPosition).toBe(0);
    expect(attempts[0].category).toBe("session_error");
    expect(attempts[0].errorType).toBe("test_type");
    expect(typeof attempts[0].timestamp).toBe("number");

    expect(attempts[1].strategy).toBe("s2");
    expect(attempts[1].result).toBe("success");
    expect(attempts[1].chainPosition).toBe(1);
  });

  it("returns exhausted when chain falls off end without success", async () => {
    const registry = new StrategyRegistry();
    registry.register(fixedStrategy("s1", { status: "next_strategy", reason: "skip1" }));
    registry.register(fixedStrategy("s2", { status: "next_strategy", reason: "skip2" }));

    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "s1" }, { strategy: "s2" }] },
      () => {},
    );
    expect(result.status).toBe("exhausted");
    expect(result.finalError).toBe("chain exhausted");
    expect(result.totalAttempts).toBe(2);
  });

  it("handles strategy throwing during execution gracefully (falls to next_strategy)", async () => {
    const registry = new StrategyRegistry();
    registry.register({
      name: "thrower",
      async execute() {
        throw new Error("unexpected crash");
      },
    });
    registry.register(fixedStrategy("savior", { status: "success", message: "saved" }));

    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const result = await executor.executeChain(
      "test-session",
      makeError(),
      { chain: [{ strategy: "thrower" }, { strategy: "savior" }] },
      () => {},
    );
    expect(result.status).toBe("recovered");
    expect(result.totalAttempts).toBe(2);
  });

  it("passes inject, sessionClient, and stepConfig through to the strategy", async () => {
    const registry = new StrategyRegistry();
    const receivedCtx: any[] = [];
    registry.register({
      name: "inspector",
      async execute(ctx) {
        receivedCtx.push(ctx);
        return { status: "success" as const, message: "inspected" };
      },
    });

    const inject = (t: string) => { /* noop */ };
    const client = { name: "test-client" } as any;
    const executor = new RecoveryChainExecutor(registry, makeConfig());

    await executor.executeChain(
      "inspected-session",
      makeError({ errorType: "inspect_type" }),
      { chain: [{ strategy: "inspector", config: { key: "val" } }] },
      inject,
      client,
    );

    expect(receivedCtx).toHaveLength(1);
    expect(receivedCtx[0].sessionID).toBe("inspected-session");
    expect(receivedCtx[0].error.errorType).toBe("inspect_type");
    expect(receivedCtx[0].attempt).toBe(0);
    expect(receivedCtx[0].stepConfig.key).toBe("val");
    expect(receivedCtx[0].inject).toBe(inject);
    expect(receivedCtx[0].sessionClient).toBe(client);
  });
});

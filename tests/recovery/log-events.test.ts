/**
 * THE RECOVERY SLICE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * Stage 4 promoted the recovery slice's recurring, identity-carrying warnings
 * into registered events — the chain executor, the engine, the context-window
 * monitor and the built-in hook registry. What is pinned HERE is the part the
 * slice owns:
 *
 * 1. THE VOCABULARY. Every code this slice reports is registered in the shared
 *    table (src/log/registry.ts) at `warn` — the level the loose call sites had,
 *    so visibility does not move — and each one's sentence is a single line.
 * 2. THE CHANNELS. A code reports on the channel of the module that emits it:
 *    `recovery:chain-executor`, `recovery:engine`, `hook:context-window` (the
 *    monitor keeps the channel its own createSubLogger already used) and
 *    `recovery:builtin-registry` — which is what the file sink turns into
 *    <logDir>/<channel>.log. The slice owns every code on those channels.
 * 3. THE FIELD SHAPE. The session being recovered is IDENTITY and travels in
 *    the scope as `sessionId`; the strategy name, the failure text and the
 *    attempt count stay fields.
 * 4. THE REAL CALL SITES. Two codes are emitted by driving the production chain
 *    executor — over a registry that does not hold the named strategy, and over
 *    a strategy that throws — rather than by calling logEvent directly.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  LOG_EVENTS,
  configureLogging,
  isLogEventCode,
  logEvent,
  logEventDefinition,
  withLogScope,
} from "../../src/log/index.ts";
import type { LogEventCode } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { RecoveryChainExecutor } from "../../src/recovery/chain-executor.ts";
import { StrategyRegistry } from "../../src/recovery/strategies/registry.ts";
import type { RecoveryChainConfig, RecoveryConfig, RecoveryError } from "../../src/recovery/types.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** Every event the recovery slice registers, and the channel it belongs to. */
const RECOVERY_EVENTS: ReadonlyArray<readonly [LogEventCode, string]> = [
  ["chain-executor.strategy-missing", "recovery:chain-executor"],
  ["chain-executor.strategy-threw", "recovery:chain-executor"],
  ["engine.aborted", "recovery:engine"],
  ["engine.exhausted", "recovery:engine"],
  ["context-window.large-output", "hook:context-window"],
  ["builtin-registry.hook-failed", "recovery:builtin-registry"],
];

/** The channels this slice's modules own. */
const SLICE_CHANNELS: readonly string[] = [
  "recovery:chain-executor",
  "recovery:engine",
  "hook:context-window",
  "recovery:builtin-registry",
];

/** The identity names a record carries in its scope instead of its fields. */
const SCOPE_KEYS: readonly string[] = ["sessionId", "graphId", "attemptId", "effectId"];

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 64 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

function makeError(overrides: Partial<RecoveryError> = {}): RecoveryError {
  return {
    category: "session_error",
    errorType: "test_error",
    message: "something went wrong",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RecoveryConfig> = {}): RecoveryConfig {
  return {
    enabled: true,
    maxTotalAttempts: 10,
    persistState: false,
    collectMetrics: false,
    chains: {},
    ...overrides,
  };
}

describe("recovery slice event vocabulary", () => {
  it("registers exactly the slice's six events on the slice's channels", () => {
    expect(RECOVERY_EVENTS.length).toBe(6);
    for (const [code] of RECOVERY_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => SLICE_CHANNELS.includes(entry.channel))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(RECOVERY_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps every slice event at warn, the level its call site had", () => {
    for (const [code] of RECOVERY_EVENTS) {
      expect(logEventDefinition(code).level).toBe("warn");
    }
  });

  it("routes every slice event to the channel of the module that emits it", () => {
    for (const [code, channel] of RECOVERY_EVENTS) {
      expect(logEventDefinition(code).channel).toBe(channel);
    }
  });

  it("keeps every message a single non-empty sentence", () => {
    for (const [code] of RECOVERY_EVENTS) {
      const { message } = logEventDefinition(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    }
  });

  it("carries identity in the scope and data in the fields", () => {
    for (const [code, channel] of RECOVERY_EVENTS) {
      withLogScope({ sessionId: "s1", agent: "role-1" }, () => {
        logEvent(code, { strategy: "retry", reason: "exhausted", totalAttempts: 3, hook: "context-window-monitor" });
      });
      const record = memory.last();
      expect(record?.code).toBe(code);
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe(channel);
      expect(record?.scope).toEqual({ sessionId: "s1", agent: "role-1" });
      expect(record?.fields).toEqual({
        strategy: "retry",
        reason: "exhausted",
        totalAttempts: 3,
        hook: "context-window-monitor",
      });
      for (const identity of SCOPE_KEYS) {
        expect(Object.hasOwn(record?.fields ?? {}, identity)).toBe(false);
      }
    }
  });
});

describe("the recovery slice's events come from the modules that own them", () => {
  it("reports an unregistered strategy from the real chain executor", async () => {
    const sessionID = "session-recovery-missing";
    const executor = new RecoveryChainExecutor(new StrategyRegistry(), makeConfig());
    const chainConfig: RecoveryChainConfig = { enabled: true, chain: [{ strategy: "not-registered" }] };

    await executor.executeChain(sessionID, makeError(), chainConfig, () => {});

    const record = memory.records().find((item) => item.code === "chain-executor.strategy-missing");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("recovery:chain-executor");
    expect(record?.message).toBe(LOG_EVENTS["chain-executor.strategy-missing"].message);
    expect(record?.scope).toEqual({ sessionId: sessionID });
    expect(record?.fields).toEqual({ strategy: "not-registered" });
  });

  it("reports a throwing strategy from the real chain executor", async () => {
    const sessionID = "session-recovery-threw";
    const registry = new StrategyRegistry();
    registry.register({
      name: "boom",
      async execute() {
        throw new Error("strategy exploded");
      },
    });
    const executor = new RecoveryChainExecutor(registry, makeConfig());
    const chainConfig: RecoveryChainConfig = { enabled: true, chain: [{ strategy: "boom" }] };

    await executor.executeChain(sessionID, makeError(), chainConfig, () => {});

    const record = memory.records().find((item) => item.code === "chain-executor.strategy-threw");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("recovery:chain-executor");
    expect(record?.message).toBe(LOG_EVENTS["chain-executor.strategy-threw"].message);
    expect(record?.scope).toEqual({ sessionId: sessionID });
    expect(record?.fields).toEqual({ strategy: "boom", error: "strategy exploded" });
  });
});

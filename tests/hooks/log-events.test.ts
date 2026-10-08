/**
 * THE HOOKS SLICE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * Stage 4 promoted the hooks slice's recurring, identity-carrying warnings into
 * registered events — the tool.execute.after pipeline, the deprecated-tool
 * check, the handler drain, the system-prompt transform and the custom hook
 * registry. What is pinned HERE is the part the slice owns:
 *
 * 1. THE VOCABULARY. Every code this slice reports is registered in the shared
 *    table (src/log/registry.ts) at `warn` — the level the loose call sites had,
 *    so visibility does not move — and each one's sentence is a single line.
 * 2. THE CHANNELS. A code reports on the channel of the module that emits it:
 *    `hook-tool-after`, `hook-tool-before`, `handler-drain`, `hook-sys-xform`
 *    and `hook:custom-registry` (which is what the file sink turns into
 *    <logDir>/<channel>.log). The slice owns every code on those channels.
 * 3. THE FIELD SHAPE. Identity travels in the SCOPE (`sessionId`, `tool` — both
 *    are scope vocabulary) and the rest stays fields: a function name, a hook
 *    name, an event name and the failure text.
 * 4. A REAL CALL SITE. Two codes are emitted by driving the production drain —
 *    drainHandlerContext over a handler context that exceeds its injection byte
 *    cap and its activation cap — rather than by calling logEvent directly.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  LOG_EVENTS,
  __resetLoggingForTest,
  configureLogging,
  isLogEventCode,
  logEvent,
  logEventDefinition,
  withLogScope,
} from "../../src/log/index.ts";
import type { LogEventCode } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { drainHandlerContext } from "../../src/hooks/drain-handler.ts";
import type { FunctionContext } from "../../src/function/context.ts";
import type { FunctionSessionState } from "../../src/function/session-state.ts";
import type { FunctionRuntimeManager } from "../../src/function/runtime-state.ts";
import type { ResolvedFunction } from "../../src/types.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** Every event the hooks slice registers, and the channel it belongs to. */
const HOOKS_EVENTS: ReadonlyArray<readonly [LogEventCode, string]> = [
  ["tool-after.observe-failed", "hook-tool-after"],
  ["tool-after.handler-failed", "hook-tool-after"],
  ["tool-before.deprecated-tool", "hook-tool-before"],
  ["handler-drain.inject-cap-reached", "handler-drain"],
  ["handler-drain.activation-cap-reached", "handler-drain"],
  ["sys-xform.memory-inject-failed", "hook-sys-xform"],
  ["custom-registry.on-load-failed", "hook:custom-registry"],
  ["custom-registry.hook-failed", "hook:custom-registry"],
  ["custom-registry.on-dispose-failed", "hook:custom-registry"],
];

/** The channels this slice's modules own. */
const SLICE_CHANNELS: readonly string[] = [
  "hook-tool-after",
  "hook-tool-before",
  "handler-drain",
  "hook-sys-xform",
  "hook:custom-registry",
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

/** The fields the drain reads from a function context. */
function makeContext(injects: string[], activate: string[]): FunctionContext {
  return {
    injects,
    pendingActivations: { activate, deactivate: [] },
    continuationReasons: [],
  } as unknown as FunctionContext;
}

function makeSessionState(): FunctionSessionState {
  return {
    activate: mock(() => {}),
    deactivate: mock(() => {}),
    getActive: mock(() => new Set<string>()),
  } as unknown as FunctionSessionState;
}

function makeRuntime(): FunctionRuntimeManager {
  return {
    init: mock(() => ({})),
    get: mock(() => undefined),
    markDirty: mock(() => {}),
    all: mock(() => new Map()),
  } as unknown as FunctionRuntimeManager;
}

describe("hooks slice event vocabulary", () => {
  it("registers exactly the slice's nine events on the slice's channels", () => {
    expect(HOOKS_EVENTS.length).toBe(9);
    for (const [code] of HOOKS_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => SLICE_CHANNELS.includes(entry.channel))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(HOOKS_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps every slice event at warn, the level its call site had", () => {
    for (const [code] of HOOKS_EVENTS) {
      expect(logEventDefinition(code).level).toBe("warn");
    }
  });

  it("routes every slice event to the channel of the module that emits it", () => {
    const counts: Record<string, number> = {};
    for (const [code, channel] of HOOKS_EVENTS) {
      expect(logEventDefinition(code).channel).toBe(channel);
      counts[channel] = (counts[channel] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "hook-tool-after": 2,
      "hook-tool-before": 1,
      "handler-drain": 2,
      "hook-sys-xform": 1,
      "hook:custom-registry": 3,
    });
  });

  it("keeps every message a single non-empty sentence", () => {
    for (const [code] of HOOKS_EVENTS) {
      const { message } = logEventDefinition(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    }
  });

  it("carries identity in the scope and data in the fields", () => {
    for (const [code, channel] of HOOKS_EVENTS) {
      withLogScope({ sessionId: "s1", tool: "hashline_read" }, () => {
        logEvent(code, { fn: "handler", hook: "custom-hook", event: "tool.execute.after", error: "boom" });
      });
      const record = memory.last();
      expect(record?.code).toBe(code);
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe(channel);
      expect(record?.scope).toEqual({ sessionId: "s1", tool: "hashline_read" });
      expect(record?.fields).toEqual({
        fn: "handler",
        hook: "custom-hook",
        event: "tool.execute.after",
        error: "boom",
      });
      for (const identity of SCOPE_KEYS) {
        expect(Object.hasOwn(record?.fields ?? {}, identity)).toBe(false);
      }
    }
  });
});

describe("the hooks slice's events come from the modules that own them", () => {
  it("reports a handler that passed the injection byte cap from the real drain", () => {
    const sessionID = "session-drain-1";
    drainHandlerContext(
      makeContext(["x".repeat(4_097)], []),
      sessionID,
      "overflow-handler",
      new Map<string, string>(),
      makeSessionState(),
      makeRuntime(),
      [],
    );

    const record = memory.records().find((item) => item.code === "handler-drain.inject-cap-reached");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("handler-drain");
    expect(record?.message).toBe(LOG_EVENTS["handler-drain.inject-cap-reached"].message);
    expect(record?.scope).toEqual({ sessionId: sessionID });
    expect(record?.fields).toEqual({ fn: "overflow-handler" });
  });

  it("reports a handler that passed the activation cap from the real drain", () => {
    const sessionID = "session-drain-2";
    const allFns = ["a", "b", "c", "d"].map((name) => ({ name }) as ResolvedFunction);
    const sessionState = makeSessionState();
    drainHandlerContext(
      makeContext([], ["a", "b", "c", "d"]),
      sessionID,
      "activation-handler",
      new Map<string, string>(),
      sessionState,
      makeRuntime(),
      allFns,
    );

    const record = memory.records().find((item) => item.code === "handler-drain.activation-cap-reached");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("handler-drain");
    expect(record?.message).toBe(LOG_EVENTS["handler-drain.activation-cap-reached"].message);
    expect(record?.scope).toEqual({ sessionId: sessionID });
    expect(record?.fields).toEqual({ fn: "activation-handler" });
    // The three activations under the cap still happened; the fourth did not.
    expect((sessionState.activate as ReturnType<typeof mock>).mock.calls.length).toBe(3);
  });
});

/**
 * CONSOLE RENDERING AND THE SECOND GATE.
 *
 * The line shape is a contract other tools grep: `[level] channel code
 * scope=… field=… — message`, with the scope's keys shortened to the names the
 * ids are known by and rendered in a fixed order, and the caller's fields in the
 * caller's order. These cases pin the shape, the quoting rule, the omission
 * rules, the method routing (warn → console.warn, error and fatal → console.error,
 * info and debug → console.debug) and the ROLEBOX_LOG_CONSOLE_LEVEL gate — including
 * the promise that an invalid value falls back to "warn" rather than throwing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { __resetLoggingForTest, configureLogging, createLogger, logEvent, withLogScope } from "../../src/log/index.ts";
import {
  CONSOLE_LEVEL_ENV,
  createConsoleSink,
  formatLogFields,
  formatLogLine,
  formatLogScope,
} from "../../src/log/sinks/console.ts";
import { beginLogTest, captureConsole, endLogTest, makeRecord, setLogEnv, type CapturedConsole } from "../helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };

beforeEach(() => {
  state = beginLogTest();
});

afterEach(() => {
  endLogTest(state);
});

describe("console rendering", () => {
  it("renders the documented line: level, channel, code, scope, fields, message", () => {
    const line = formatLogLine(
      makeRecord({
        level: "warn",
        channel: "graph:host",
        code: "sweep.store-blocked",
        message: "the workspace store could not be read",
        scope: { graphId: "g1", attemptId: "a2" },
        fields: { reason: 'permission "denied"' },
      }),
    );

    expect(line).toBe(
      '[warn] graph:host sweep.store-blocked graph=g1 attempt=a2 reason="permission \\"denied\\"" — the workspace store could not be read',
    );
  });

  it("omits the code, the scope and the field segment when there is nothing to show", () => {
    expect(formatLogLine(makeRecord({ level: "info", message: "hello" }))).toBe("[info] dispatch — hello");
    expect(formatLogLine(makeRecord({ level: "info", channel: "graph:host", code: "sweep.summary", message: "summary" }))).toBe(
      "[info] graph:host sweep.summary — summary",
    );
  });

  it("quotes and escapes strings, writes numbers and booleans bare", () => {
    const line = formatLogLine(
      makeRecord({
        level: "warn",
        fields: { reason: 'has "quotes" and \\ backslash', count: 2, blocked: false, ratio: 0.5, missing: undefined },
      }),
    );
    expect(line).toBe(
      '[warn] dispatch reason="has \\"quotes\\" and \\\\ backslash" count=2 blocked=false ratio=0.5 — something happened',
    );
  });

  it("joins an array into one quoted value and keeps the caller's field order", () => {
    const line = formatLogLine(
      makeRecord({ level: "warn", fields: { started: ["g1", "g2"], counts: [1, 2], zeta: "last", alpha: "first" } }),
    );
    expect(line).toBe('[warn] dispatch started="g1,g2" counts="1,2" zeta="last" alpha="first" — something happened');
  });

  it("omits undefined fields and renders an empty array as an empty quoted value", () => {
    expect(formatLogFields({ a: undefined, b: 1 })).toBe("b=1");
    expect(formatLogFields({ empty: [] })).toBe('empty=""');
    expect(formatLogFields({})).toBe("");
    expect(formatLogFields(undefined)).toBe("");
  });

  it("renders the scope in its canonical order, whatever order the keys arrived in", () => {
    const scope = formatLogScope({ tool: "read", attemptId: "a2", graphId: "g1", sessionId: "s1", effectId: "e1" });
    expect(scope).toBe("session=s1 graph=g1 attempt=a2 effect=e1 tool=read");
    expect(formatLogScope({})).toBe("");
    expect(formatLogScope(undefined)).toBe("");
  });

  it("does not render a scope key the contract does not declare", () => {
    expect(formatLogScope({ graphId: "g1", ...({ mystery: "x" } as object) })).toBe("graph=g1");
  });
});

describe("console gate and routing", () => {
  it("drops info and debug at the default warn level and keeps warn and error", () => {
    const calls: string[] = [];
    const sink = createConsoleSink({ emit: (method, line) => calls.push(method + ":" + line) });

    for (const level of ["debug", "info", "warn", "error"] as const) {
      sink(makeRecord({ level, message: level + " message" }));
    }

    expect(calls).toEqual(["warn:[warn] dispatch — warn message", "error:[error] dispatch — error message"]);
  });

  it("honors ROLEBOX_LOG_CONSOLE_LEVEL, case-insensitively, per record", () => {
    const calls: string[] = [];
    const sink = createConsoleSink({ emit: (method, line) => calls.push(method + ":" + line) });

    setLogEnv(CONSOLE_LEVEL_ENV, "DEBUG");
    for (const level of ["debug", "info", "warn", "error"] as const) sink(makeRecord({ level }));

    expect(calls.map((call) => call.split(":")[0])).toEqual(["debug", "debug", "warn", "error"]);
  });

  it("falls back to warn for an unset, blank or invalid console level", () => {
    const calls: string[] = [];
    const sink = createConsoleSink({ emit: (method) => calls.push(method) });

    for (const value of [undefined, "", "   ", "loud", "5"]) {
      setLogEnv(CONSOLE_LEVEL_ENV, value);
      calls.length = 0;
      for (const level of ["debug", "info", "warn", "error"] as const) sink(makeRecord({ level }));
      expect(calls).toEqual(["warn", "error"]);
    }
  });

  it("lets an explicit option level beat the environment", () => {
    const calls: string[] = [];
    const sink = createConsoleSink({ level: "error", emit: (method) => calls.push(method) });

    setLogEnv(CONSOLE_LEVEL_ENV, "debug");
    for (const level of ["debug", "info", "warn", "error"] as const) sink(makeRecord({ level }));

    expect(calls).toEqual(["error"]);
  });

  it("routes warn to console.warn, error to console.error and info/debug to console.debug", () => {
    const captured: CapturedConsole = captureConsole();
    try {
      configureLogging({ level: "debug", sinks: [createConsoleSink({ level: "debug" })] });
      const log = createLogger("graph:host");
      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      log.error("error message");
    } finally {
      captured.restore();
    }

    expect(captured.debug.map((line) => line.split(" ")[0])).toEqual(["[debug]", "[info]"]);
    expect(captured.warn).toHaveLength(1);
    expect(captured.error).toHaveLength(1);
    expect(captured.warn[0]).toContain("— warn message");
    expect(captured.error[0]).toContain("— error message");
  });

  it("routes fatal to console.error and admits it above every gate", () => {
    const calls: string[] = [];
    const sink = createConsoleSink({ level: "fatal", emit: (method, line) => calls.push(method + ":" + line) });

    for (const level of ["debug", "info", "warn", "error", "fatal"] as const) {
      sink(makeRecord({ level, message: level + " message" }));
    }

    expect(calls).toEqual(["error:[fatal] dispatch — fatal message"]);
  });

  it("contains a console method that throws", () => {
    const original = console.warn;
    console.warn = (): void => {
      throw new Error("console is broken");
    };
    try {
      const sink = createConsoleSink();
      expect(() => sink(makeRecord({ level: "warn" }))).not.toThrow();
    } finally {
      console.warn = original;
    }
  });

  it("carries the ambient scope into the rendered line", async () => {
    const lines: string[] = [];
    configureLogging({ sinks: [createConsoleSink({ level: "debug", emit: (_method, line) => lines.push(line) })] });

    await withLogScope({ graphId: "g1", attemptId: "a2" }, async () => {
      await Promise.resolve();
      logEvent("log.sink.failed", { sink: "file", error: "EACCES" });
    });

    expect(lines[0]).toBe('[error] log log.sink.failed graph=g1 attempt=a2 sink="file" error="EACCES" — a log sink threw while receiving a record; the record was dropped for that destination and the failure is reported once');
  });
});

// Keeps the process-wide kernel (and its memory buffer) free of this file's
// records for any suite that runs after it in the same process.
afterEach(() => {
  __resetLoggingForTest();
});

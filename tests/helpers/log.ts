// ── Shared test scaffolding for the logging kernel ──────────────────────────
//
// Not a test file (no `.test.ts`), just the three things every suite that logs
// needs: a controlled environment, a temporary log directory, and a console
// capture. It lives in `tests/helpers/` because more than one slice uses it
// (tests/log/**, tests/logger.test.ts and tests/graph/graph-log-events.test.ts):
// a helper under a slice's own directory would make every other slice depend on
// that slice's scaffolding.
//
// WHY THE ENVIRONMENT IS ALWAYS RESET FIRST. The kernel reads its level and
// directory settings from the process environment, and a test that forgot to
// clear them would inherit whatever the previous file left behind — or worse,
// write into the workspace's own `.rolebox/logs`. Every suite therefore clears
// the ROLEBOX_LOG* variables and resets the kernel before its first record, and
// restores the environment afterwards.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetLoggingForTest } from "../../src/log/index.ts";
import type { LogLevel, LogRecord } from "../../src/log/types.ts";

/** Every environment variable this kernel reads. */
export const LOG_ENV_KEYS: readonly string[] = [
  "ROLEBOX_LOG_LEVEL",
  "ROLEBOX_LOG_CONSOLE_LEVEL",
  "ROLEBOX_LOG_DIR",
  "ROLEBOX_LOG_MAX_BYTES",
  "ROLEBOX_LOG_RETAIN",
];

/** The ROLEBOX_LOG* environment as the test found it. */
export function snapshotLogEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) snapshot[key] = process.env[key];
  }
  return snapshot;
}

/** Drop every ROLEBOX_LOG* variable, then restore the snapshot's values. */
export function restoreLogEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) delete process.env[key];
  }
  for (const key of Object.keys(snapshot)) {
    const value = snapshot[key];
    if (value !== undefined) process.env[key] = value;
  }
}

/** Set (or, with `undefined`, unset) one environment variable. */
export function setLogEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** A fresh directory under the OS temp directory. The caller removes it. */
export function tempDir(prefix = "rolebox-log-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a directory tree, tolerating an already-removed path. */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A test must not fail while cleaning up.
  }
}

/** A console capture: the three methods the sink writes through. */
export interface CapturedConsole {
  readonly debug: string[];
  readonly warn: string[];
  readonly error: string[];
  restore(): void;
}

/** Replace console.debug/warn/error so a test can read the rendered lines. */
export function captureConsole(): CapturedConsole {
  const debug: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const original = { debug: console.debug, warn: console.warn, error: console.error };
  console.debug = (...args: unknown[]): void => {
    debug.push(String(args[0]));
  };
  console.warn = (...args: unknown[]): void => {
    warn.push(String(args[0]));
  };
  console.error = (...args: unknown[]): void => {
    error.push(String(args[0]));
  };
  return {
    debug,
    warn,
    error,
    restore: (): void => {
      console.debug = original.debug;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/**
 * The standard opening for a suite that logs: snapshot and clear the
 * environment, reset the kernel, and point ROLEBOX_LOG_DIR at a temporary
 * directory so a default pipeline can never touch the workspace.
 */
export function beginLogTest(): { env: Record<string, string | undefined>; dir: string } {
  const env = snapshotLogEnv();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) delete process.env[key];
  }
  __resetLoggingForTest();
  const dir = tempDir();
  process.env.ROLEBOX_LOG_DIR = dir;
  return { env, dir };
}

/** The matching teardown: reset the kernel, restore the environment, remove the directory. */
export function endLogTest(state: { env: Record<string, string | undefined>; dir: string }): void {
  __resetLoggingForTest();
  restoreLogEnv(state.env);
  removeDir(state.dir);
}

/** Build a record with the fields a rendering or sink case cares about. */
export function makeRecord(overrides: Partial<LogRecord> & { level: LogLevel }): LogRecord {
  return {
    time: 1,
    channel: "dispatch",
    message: "something happened",
    fields: {},
    scope: {},
    process: { pid: 1, role: "host" },
    ...overrides,
  };
}

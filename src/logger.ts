import { Logger } from "tslog";
import type { ILogObj } from "tslog";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "./cli/paths.ts";

const LEVEL_MAP: Record<string, number> = {
  silly: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
};

/**
 * Parse the ROLEBOX_LOG_LEVEL env var.
 * Case-insensitive. Defaults to 3 (info).
 * Writes to stderr on invalid values.
 */
export function parseLogLevel(raw?: string): number {
  const value = (raw ?? process.env.ROLEBOX_LOG_LEVEL ?? "").toLowerCase().trim();
  if (!value) return 3;
  const level = LEVEL_MAP[value];
  if (level !== undefined) return level;
  process.stderr.write(
    `[rolebox] Invalid ROLEBOX_LOG_LEVEL='${raw ?? process.env.ROLEBOX_LOG_LEVEL}', falling back to 'info'\n`,
  );
  return 3;
}

function ensureLogDir(filePath: string): string | null {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Resolve the log file path with fallback chain:
 * 1. ROLEBOX_LOG_FILE env var
 * 2. ~/.config/rolebox/logs/rolebox.log (via getConfigDir)
 * 3. /tmp/rolebox.log
 * Returns null if all options fail (disable file logging).
 */
export function resolveLogFilePath(): string | null {
  // 1. Explicit env var
  if (process.env.ROLEBOX_LOG_FILE) {
    const result = ensureLogDir(process.env.ROLEBOX_LOG_FILE);
    if (result) return result;
  }

  // 2. Config dir
  try {
    const configLogPath = join(getConfigDir(), "logs", "rolebox.log");
    const result = ensureLogDir(configLogPath);
    if (result) return result;
  } catch {
    // getConfigDir itself shouldn't throw, but guard anyway
  }

  // 3. /tmp fallback
  const tmpPath = "/tmp/rolebox.log";
  const tmpResult = ensureLogDir(tmpPath);
  if (tmpResult) return tmpResult;

  // All failed — disable file logging
  return null;
}

const parsedLevel = parseLogLevel();
const logFilePath = resolveLogFilePath();

export const rootLogger = new Logger<ILogObj>({
  type: "hidden",
  name: "rolebox",
  minLevel: parsedLevel,
});

if (logFilePath) {
  rootLogger.attachTransport((logObj) => {
    try {
      const entry = JSON.stringify({ ...logObj, pid: process.pid }) + "\n";
      appendFileSync(logFilePath, entry);
    } catch {
      // Best effort — never crash the application
    }
  });
}

/**
 * Create a sub-logger inheriting the root logger's settings.
 * Sub-logger name is appended to the parent name chain (e.g., "rolebox:MySub").
 */
export function createSubLogger(name: string, minLevel?: number): Logger<ILogObj> {
  const settings: { name: string; minLevel?: number } = { name };
  if (minLevel !== undefined) settings.minLevel = minLevel;
  return rootLogger.getSubLogger(settings);
}

/**
 * Normalize any error-like value into { message, stack?, name? }.
 * Handles Error objects, strings, null, undefined, and arbitrary objects.
 */
export function formatError(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  if (err === null || err === undefined) {
    return { message: String(err) };
  }
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

/**
 * Returns the resolved log file path, or null if file logging is disabled.
 */
export function getLogFilePath(): string | null {
  return logFilePath;
}

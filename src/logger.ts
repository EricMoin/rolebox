import { Logger } from "tslog";
import type { ILogObj } from "tslog";
import { createWriteStream, statSync, renameSync, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { getConfigDir } from "./cli/paths.ts";

/** Default max log file size before rotation (10 MB). */
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Number of rotated log files to keep (rolebox.log.1, .2, etc.). */
const MAX_ROTATED_FILES = 3;

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
 * 3. {os.tmpdir()}/rolebox.log
 * Returns null if all options fail (disable file logging).
 */
export function resolveLogFilePath(): string | null {
  // 1. Explicit env var
  if (process.env.ROLEBOX_LOG_FILE) {
    const result = ensureLogDir(process.env.ROLEBOX_LOG_FILE);
    if (result) return result;
  }

  // 2. Project-local .rolebox dir (set via configureLogDirectory)
  if (_baseDirectory) {
    const localPath = join(_baseDirectory, ".rolebox", "logs", "rolebox.log");
    const result = ensureLogDir(localPath);
    if (result) return result;
  }

  // 3. Config dir (fallback for CLI / pre-init calls)
  try {
    const configLogPath = join(getConfigDir(), "logs", "rolebox.log");
    const result = ensureLogDir(configLogPath);
    if (result) return result;
  } catch {
    // getConfigDir itself shouldn't throw, but guard anyway
  }

  // 4. OS-native temp directory fallback (cross-platform)
  const tmpPath = join(tmpdir(), "rolebox.log");
  const tmpResult = ensureLogDir(tmpPath);
  if (tmpResult) return tmpResult;

  // All failed — disable file logging
  return null;
}

/**
 * Rotate log file if it exceeds maxBytes.
 * Keeps up to MAX_ROTATED_FILES old copies (rolebox.log.1, .2, .3).
 */
function rotateIfNeeded(filePath: string, maxBytes: number): void {
  try {
    const stat = statSync(filePath);
    if (stat.size < maxBytes) return;
  } catch {
    // File doesn't exist yet or stat failed — nothing to rotate
    return;
  }

  // Shift existing rotated files: .3 → deleted, .2 → .3, .1 → .2
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dst = `${filePath}.${i}`;
    try {
      renameSync(src, dst);
    } catch {
      // Source doesn't exist — skip
    }
  }
}

/** Manages an async write stream with rotation support. */
class LogTransport {
  private stream: WriteStream | null = null;
  private filePath: string;
  private maxBytes: number;
  private bytesWritten = 0;
  private drainRegistered = false;

  constructor(filePath: string, maxBytes: number) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    rotateIfNeeded(filePath, maxBytes);
    this.stream = this.openStream();
    this.registerDrain();
  }

  private openStream(): WriteStream {
    return createWriteStream(this.filePath, { flags: "a" });
  }

  private registerDrain(): void {
    if (this.drainRegistered) return;
    this.drainRegistered = true;

    const flush = (): void => {
      if (this.stream && !this.stream.destroyed) {
        this.stream.end();
      }
    };

    process.on("exit", flush);
    process.on("SIGINT", () => { flush(); process.exit(130); });
    process.on("SIGTERM", () => { flush(); process.exit(143); });
  }

  write(entry: string): void {
    if (!this.stream || this.stream.destroyed) return;

    const bytes = Buffer.byteLength(entry, "utf-8");
    this.bytesWritten += bytes;

    this.stream.write(entry);

    if (this.bytesWritten >= this.maxBytes) {
      this.stream.end();
      rotateIfNeeded(this.filePath, this.maxBytes);
      this.stream = this.openStream();
      this.bytesWritten = 0;
    }
  }

  /** Explicitly close the stream (for testing). */
  close(): void {
    if (this.stream && !this.stream.destroyed) {
      this.stream.end();
    }
    this.stream = null;
  }
}

let _rootLogger: Logger<ILogObj> | null = null;
let _logFilePath: string | null | undefined;
let _parsedLevel: number | undefined;
let _transport: LogTransport | null = null;
let _baseDirectory: string | undefined;

function ensureInitialized(): void {
  if (_rootLogger) return;

  _parsedLevel = parseLogLevel();
  _logFilePath = resolveLogFilePath();

  _rootLogger = new Logger<ILogObj>({
    type: "hidden",
    name: "rolebox",
    minLevel: _parsedLevel,
  });

  if (_logFilePath) {
    const maxBytes = process.env.ROLEBOX_LOG_MAX_BYTES
      ? parseInt(process.env.ROLEBOX_LOG_MAX_BYTES, 10) || DEFAULT_MAX_FILE_BYTES
      : DEFAULT_MAX_FILE_BYTES;

    _transport = new LogTransport(_logFilePath, maxBytes);

    _rootLogger.attachTransport((logObj) => {
      try {
        const entry = JSON.stringify({ ...logObj, pid: process.pid }) + "\n";
        _transport!.write(entry);
      } catch {
        // Best effort — never crash the application
      }
    });
  }
}

/**
 * Get the root logger (lazy-initialized on first access).
 */
export function getRootLogger(): Logger<ILogObj> {
  ensureInitialized();
  return _rootLogger!;
}

/** Backward-compatible alias: direct access to the root logger singleton. */
export const rootLogger: Logger<ILogObj> = new Proxy({} as Logger<ILogObj>, {
  get(_target, prop, receiver) {
    const real = getRootLogger();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Create a sub-logger inheriting the root logger's settings.
 * Sub-logger name is appended to the parent name chain (e.g., "rolebox:MySub").
 */
export function createSubLogger(name: string, minLevel?: number): Logger<ILogObj> {
  const settings: { name: string; minLevel?: number } = { name };
  if (minLevel !== undefined) settings.minLevel = minLevel;
  return getRootLogger().getSubLogger(settings);
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
  ensureInitialized();
  return _logFilePath ?? null;
}

export function configureLogDirectory(directory: string): void {
  _baseDirectory = directory;
  const newPath = resolveLogFilePath();
  if (newPath === _logFilePath) return;

  if (_transport) {
    _transport.close();
    _transport = null;
  }

  _logFilePath = newPath;

  if (_logFilePath && _rootLogger) {
    const maxBytes = process.env.ROLEBOX_LOG_MAX_BYTES
      ? parseInt(process.env.ROLEBOX_LOG_MAX_BYTES, 10) || DEFAULT_MAX_FILE_BYTES
      : DEFAULT_MAX_FILE_BYTES;

    _transport = new LogTransport(_logFilePath, maxBytes);

    _rootLogger.attachTransport((logObj) => {
      try {
        const entry = JSON.stringify({ ...logObj, pid: process.pid }) + "\n";
        _transport!.write(entry);
      } catch {}
    });
  }
}

/**
 * Reset the logger singleton (for testing only).
 * Closes the current transport and clears all cached state,
 * allowing re-initialization with different env vars.
 */
export function __resetForTest(): void {
  if (_transport) {
    _transport.close();
    _transport = null;
  }
  _rootLogger = null;
  _logFilePath = undefined;
  _parsedLevel = undefined;
}

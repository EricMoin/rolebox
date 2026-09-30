/**
 * OS-level system adapter — the declared facts of one operating system.
 *
 * A graph-worker command path cannot guess its host: where an installed browser
 * cache lives, which environment variables make a home/config/cache/temp set
 * disposable, and which shell interprets a command string all differ per OS.
 * Declaring those facts here, one {@link SystemDescriptor} per system, replaces
 * the hardcoded macOS/POSIX assumptions a consumer would otherwise carry, so a
 * caller asks the platform instead of assuming one.
 */

/**
 * The operating systems rolebox declares.
 *
 * `posix` is the fallback for every platform not listed here — it carries
 * POSIX-family facts under its own id, so diagnostics say which system answered.
 */
export type SystemId = "darwin" | "linux" | "win32" | "posix";

/**
 * The disposable directory set a command runs with, plus the host environment
 * the descriptor may read conditional facts from.
 */
export interface DisposablePaths {
  /** Disposable home: what `HOME` (and the OS-specific equivalent) points at. */
  home: string;
  /** Disposable config directory. */
  config: string;
  /** Disposable cache directory. */
  cache: string;
  /** Disposable temporary directory, removed with the command. */
  temp: string;
  /** The ambient environment, for facts a descriptor forwards rather than invents. */
  env: NodeJS.ProcessEnv;
}

/**
 * One operating system's facts. Every member is a method or a value derived from
 * this descriptor alone, so the same descriptor answers identically on any host
 * running the tests.
 */
export interface SystemDescriptor {
  readonly id: SystemId;
  /** Human-readable label for diagnostics (never used to branch on). */
  readonly label: string;
  /**
   * Whether this OS lets Node fsync a DIRECTORY handle — the POSIX idiom that
   * makes a newly written directory entry (the new file's name) durable.
   * Windows has no equivalent through Node, so a caller skips the sync there and
   * relies on the filesystem's metadata journaling instead; the POSIX family
   * keeps the sync, so a crash cannot lose the entry.
   */
  readonly canSyncDirectoryEntries: boolean;
  /** The installed Playwright/Puppeteer cache locations under a REAL home. */
  browserCaches(home: string): { playwright: string; puppeteer: string };
  /** The variables that point software at the disposable directories. */
  disposableEnvironment(paths: DisposablePaths): Record<string, string>;
  /** The spawn vector that runs `command` through this system's shell. */
  commandShell(command: string, env: NodeJS.ProcessEnv): string[];
  /** One sentence of shell guidance for model-facing text. */
  readonly shellHint: string;
}

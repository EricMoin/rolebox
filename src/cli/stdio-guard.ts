/**
 * Broken-pipe guard for the rolebox CLI.
 *
 * A CLI's reader can disappear while the CLI is still writing: `rolebox list |
 * head` stops reading after a few lines, a terminal window is closed in the
 * middle of an interactive picker, and an agent PTY that launched the command
 * is torn down. The next write then fails with EPIPE. Bun (like Node) treats a
 * stream `error` that nobody listens for — and an unhandled promise rejection —
 * as fatal, so the command dies with a runtime crash report (`EPIPE: broken
 * pipe, write` plus a stack trace) instead of ending quietly. The interactive
 * pickers are the worst case: `@clack/prompts` redraws its prompt line on every
 * keystroke, and a failed redraw inside `node:readline` is thrown out of the
 * prompt's promise, so the crash report lands on top of a half-drawn prompt.
 *
 * Installing the guard turns that into the quiet exit the situation calls for:
 * the only thing left to print would go to the stream that just proved nobody
 * is reading it. A broken pipe is not a rolebox failure, so the process exits
 * with the Unix convention for "terminated by SIGPIPE" (128 + 13 = 141) and
 * prints nothing. Everything that is NOT a broken pipe keeps the runtime's own
 * diagnosis: an uncaught exception is still printed by the runtime and still
 * exits 1 (the guard only observes it through `uncaughtExceptionMonitor`), and
 * an unhandled rejection is handed back untouched.
 *
 * The terminal is restored first (raw mode cleared) so a closed *stdout* alone
 * cannot leave the user's shell with echo disabled.
 *
 * The guard is installed once, by the CLI entry (`src/cli/main.ts`); library
 * entry points never install it, so embedding rolebox never changes how the
 * host process handles its own stdio or promise rejections.
 *
 * @module
 */

/** 128 + SIGPIPE (13) — the conventional status of a process whose reader left. */
export const BROKEN_PIPE_EXIT_CODE = 141;

/** The `error`-emitting, optionally writable surface the guard needs. */
export interface StdioEventStream {
  on(event: "error", listener: (error: unknown) => void): unknown;
  removeListener?(event: "error", listener: (error: unknown) => void): unknown;
  write?(chunk: string): unknown;
}

/**
 * The process-level events a fatal failure can arrive on. `process` satisfies
 * this; tests pass an `EventEmitter` so no real handler is ever installed.
 *
 * `uncaughtExceptionMonitor` is used instead of `uncaughtException` on purpose:
 * it is observed *before* the runtime reports the crash, and it does not take
 * the report away from the runtime.
 */
export interface FatalEventSource {
  on(
    event: "uncaughtExceptionMonitor" | "unhandledRejection",
    listener: (error: unknown) => void,
  ): unknown;
  removeListener?(
    event: "uncaughtExceptionMonitor" | "unhandledRejection",
    listener: (error: unknown) => void,
  ): unknown;
}

/** Options accepted by {@link installBrokenPipeGuard}; all are injectable for tests. */
export interface BrokenPipeGuardOptions {
  /** Defaults to `process.stdout`. */
  readonly stdout?: StdioEventStream;
  /** Defaults to `process.stderr`. */
  readonly stderr?: StdioEventStream;
  /** Ends the process now; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /**
   * Ends the process after the runtime has printed its report; defaults to
   * setting `process.exitCode` and exiting from a microtask.
   */
  readonly deferExit?: (code: number) => void;
  /** Runs before a broken-pipe exit; defaults to clearing raw mode on a TTY stdin. */
  readonly restoreTerminal?: () => void;
  /** Handles a non-EPIPE stdio error; defaults to one stderr line, then exit 1. */
  readonly reportFailure?: (error: unknown) => void;
  /**
   * Hands a non-EPIPE unhandled rejection back to the runtime; defaults to
   * re-rejecting it from a microtask so the runtime reports the original stack
   * and exits 1.
   */
  readonly rereject?: (error: unknown) => void;
  /** Defaults to `process`. */
  readonly fatalEvents?: FatalEventSource;
}

/**
 * True when `error` is the OS's "the reader is gone" failure (EPIPE).
 *
 * Bun and Node both attach `code` to the system error; the message is never
 * parsed, so a wrapped or renamed error cannot be mistaken for a broken pipe.
 */
export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "EPIPE";
}

/**
 * Install the guard on stdout, stderr and the fatal process events, and return
 * a disposer that removes every listener. The CLI entry calls this once and
 * never disposes; tests call it with fakes so no real stream, process or exit
 * is touched.
 */
export function installBrokenPipeGuard(
  options: BrokenPipeGuardOptions = {},
): () => void {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const deferExit =
    options.deferExit ??
    ((code: number): void => {
      process.exitCode = code;
      queueMicrotask(() => exit(code));
    });
  const restoreTerminal = options.restoreTerminal ?? clearStdinRawMode;
  const fatalEvents =
    options.fatalEvents ?? (process as unknown as FatalEventSource);
  const rereject =
    options.rereject ??
    ((error: unknown): void => {
      queueMicrotask(() => {
        void Promise.reject(error);
      });
    });

  const reportFailure =
    options.reportFailure ??
    ((error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        stderr.write?.(`rolebox: stdio error: ${message}\n`);
      } catch {
        // stderr is the stream that may have just failed; printing is best effort.
      }
      exit(1);
    });

  const quitQuietly = (): void => {
    // A terminal that lost its writer may still hold raw mode; restore it so
    // the shell is usable after the command is gone.
    try {
      restoreTerminal();
    } catch {
      // Nothing left to restore to.
    }
    exit(BROKEN_PIPE_EXIT_CODE);
  };

  const handleStdioError = (error: unknown): void => {
    if (isBrokenPipeError(error)) {
      quitQuietly();
      return;
    }
    reportFailure(error);
  };

  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stdout.removeListener?.("error", handleStdioError);
    stderr.removeListener?.("error", handleStdioError);
    fatalEvents.removeListener?.("uncaughtExceptionMonitor", handleUncaught);
    fatalEvents.removeListener?.("unhandledRejection", handleRejection);
  }

  function handleUncaught(error: unknown): void {
    if (isBrokenPipeError(error)) {
      quitQuietly();
      return;
    }
    // The runtime prints its own report for this exception after the monitor
    // event; keep it fatal (a monitor listener alone would let the process run
    // on) without replacing the report.
    deferExit(1);
  }

  function handleRejection(error: unknown): void {
    if (isBrokenPipeError(error)) {
      quitQuietly();
      return;
    }
    // Not ours to swallow: stop watching and re-reject, so the runtime reports
    // the original stack and exits 1 exactly as it would with no listener.
    dispose();
    rereject(error);
  }

  stdout.on("error", handleStdioError);
  stderr.on("error", handleStdioError);
  fatalEvents.on("uncaughtExceptionMonitor", handleUncaught);
  fatalEvents.on("unhandledRejection", handleRejection);

  return dispose;
}

/** Clear raw mode on a TTY stdin; a no-op otherwise. */
function clearStdinRawMode(): void {
  const stdin = process.stdin;
  if (stdin.isTTY && stdin.isRaw) stdin.setRawMode(false);
}

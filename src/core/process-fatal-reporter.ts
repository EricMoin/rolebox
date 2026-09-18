import { createSubLogger, formatError } from "../logger.ts";

const log = createSubLogger("process-fatal");

/** The two host process events this reporter observes. */
export type ProcessFatalEventType = "uncaughtException" | "unhandledRejection";

/** Structured record written for every observed fatal event. */
export interface ProcessFatalEntry {
  type: ProcessFatalEventType;
  message: string;
  stack?: string;
  name?: string;
  timestamp: string;
}

/**
 * Minimal process surface the reporter installs on. Structural (no host SDK
 * import) — the host's real `process` satisfies it, and tests can pass a spy
 * target to observe exactly which listeners are added and removed.
 */
export interface ProcessListenerTarget {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  /**
   * Live listener census for an event. `process` is an EventEmitter and
   * provides it; a structural target that cannot report a count is treated as
   * not-proven-sole, so an invisible host handler is never pre-empted.
   */
  listenerCount?(event: string): number;
}

export interface ProcessFatalReporterOptions {
  /**
   * Synchronous, best-effort rolebox state flush — the same flush the host
   * exit handler performs. Runs at most once, before the log entry; a throw is
   * swallowed and logged, never propagated.
   */
  flush?: () => void;
  /** Sink for the structured entry; defaults to the rolebox `process-fatal` sub-logger. */
  report?: (entry: ProcessFatalEntry) => void;
  /** Listener target; defaults to the host `process`. */
  target?: ProcessListenerTarget;
  /** Force the single stderr line on/off; defaults to `ROLEBOX_FATAL_STDERR === "1"`. */
  stderr?: boolean;
  /**
   * Reproduce the host's default `uncaughtException` status when rolebox's
   * listener is the event's sole listener: the handler calls `process.exit(1)`
   * after the flush and the single log entry. Default `true` — a crash must
   * not be swallowed. Set `false` to observe without exiting.
   */
  preserveUncaughtExit?: boolean;
  /**
   * Opt into exiting after an `unhandledRejection`. Default `false`: the host
   * keeps running after an unhandled rejection, so exiting would change
   * semantics rather than preserve them.
   */
  exitOnUnhandledRejection?: boolean;
}

/**
 * Observation-first process-fatal reporter that preserves the host's crash
 * semantics instead of overriding them.
 *
 * Measured on Node v26.4.0 and Bun 1.3.14: a thrown error with no
 * `uncaughtException` listener prints the stack and exits 1; with any listener
 * the process stays alive and later exits 0. A listener that only logs
 * therefore turns a crash into a surviving corrupted process.
 *
 * The `uncaughtException` handler flushes rolebox state, writes ONE structured
 * entry, and then calls `process.exit(1)` — the status the runtime would have
 * used on its own — but only when rolebox's listener is the sole listener for
 * the event (`target.listenerCount(event) === 1`) and no
 * `process.setUncaughtExceptionCaptureCallback` is installed, so the process
 * does NOT survive a crash. A target that cannot report a listener count, or
 * an event with another listener, is observed only: a pre-existing host
 * handler is never pre-empted. `unhandledRejection` is observe-only by
 * default, since the host default there already keeps running; pass
 * `exitOnUnhandledRejection` to opt into the exit.
 *
 * The handler never re-throws, never calls `process.abort()`, and never
 * touches stdout. The behaviour delta is a log line (plus an opt-in stderr
 * line), the flush, and — for a sole-owner crash — the exit status the host
 * would have had without any listener.
 */
export class ProcessFatalReporter {
  private readonly target: ProcessListenerTarget;
  private readonly flushFn: (() => void) | undefined;
  private readonly report: (entry: ProcessFatalEntry) => void;
  private readonly stderr: boolean;
  private readonly preserveUncaughtExit: boolean;
  private readonly exitOnUnhandledRejection: boolean;
  private listeners: Array<{ event: ProcessFatalEventType; listener: (arg: unknown) => void }> = [];
  private installed = false;
  /** Latches on the first fatal event: every later event is a no-op. */
  private handled = false;

  constructor(options: ProcessFatalReporterOptions = {}) {
    this.target = options.target ?? (process as unknown as ProcessListenerTarget);
    this.flushFn = options.flush;
    this.report = options.report ?? ((entry) => log.fatal("process fatal", entry));
    this.stderr = options.stderr ?? process.env.ROLEBOX_FATAL_STDERR === "1";
    this.preserveUncaughtExit = options.preserveUncaughtExit ?? true;
    this.exitOnUnhandledRejection = options.exitOnUnhandledRejection ?? false;
  }

  /**
   * Install the two listeners once (idempotent). Returns an uninstall() that
   * removes exactly the listeners this call added.
   */
  install(): () => void {
    if (!this.installed) {
      this.installed = true;
      const handlers: Array<[ProcessFatalEventType, (arg: unknown) => void]> = [
        ["uncaughtException", (error: unknown) => this.handle("uncaughtException", error)],
        ["unhandledRejection", (reason: unknown) => this.handle("unhandledRejection", reason)],
      ];
      for (const [event, listener] of handlers) {
        try {
          this.target.on(event, listener);
          this.listeners.push({ event, listener });
        } catch (err) {
          // A host target that refuses listeners must not break plugin init.
          this.safeDebug("install failed", event, err);
        }
      }
    }
    return () => this.uninstall();
  }

  /** Remove exactly the listeners install() added. Idempotent. */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    const remove = this.target.off?.bind(this.target) ?? this.target.removeListener?.bind(this.target);
    for (const { event, listener } of this.listeners) {
      try {
        remove?.(event, listener);
      } catch (err) {
        this.safeDebug("uninstall failed", event, err);
      }
    }
    this.listeners = [];
  }

  /**
   * Handle one fatal event: flush once, write one log entry, optionally one
   * stderr line, then reproduce the host's default exit status when rolebox is
   * the event's sole owner. Never throws, never re-throws. Once an event has
   * been handled every later event is a no-op — state is already flushed, and
   * a crash storm must not multiply the flush, the log or the exit.
   */
  handle(type: ProcessFatalEventType, error: unknown): void {
    if (this.handled) return;
    this.handled = true;
    try {
      try {
        this.flushFn?.();
      } catch (err) {
        this.safeDebug("flush failed", type, err);
      }

      const info = formatError(error);
      const entry: ProcessFatalEntry = {
        type,
        message: info.message,
        ...(info.stack !== undefined ? { stack: info.stack } : {}),
        ...(info.name !== undefined ? { name: info.name } : {}),
        timestamp: new Date().toISOString(),
      };
      try {
        this.report(entry);
      } catch (err) {
        this.safeDebug("report failed", type, err);
      }

      if (this.stderr) {
        try {
          process.stderr.write(`[rolebox] ${type}: ${info.message}\n`);
        } catch {
          // stderr may already be closed — nothing left to report to.
        }
      }

      if (this.shouldExit(type)) {
        try {
          process.exit(1);
        } catch (err) {
          // An exit that cannot run must not become a second crash.
          this.safeDebug("exit failed", type, err);
        }
      }
    } catch (err) {
      // Final backstop: the handler must never throw into the host.
      this.safeDebug("handler failed", type, err);
    }
  }

  /**
   * Whether rolebox should reproduce the host's default fatal status. Only a
   * sole-owner `uncaughtException` does: the runtime default is exit 1, and
   * this handler is what suppressed it. An `unhandledRejection` stays
   * observe-only unless the caller opted in.
   */
  private shouldExit(type: ProcessFatalEventType): boolean {
    if (type === "unhandledRejection") return this.exitOnUnhandledRejection;
    if (!this.preserveUncaughtExit) return false;
    if (this.hasCaptureCallback()) return false;
    return this.soleOwner("uncaughtException");
  }

  /** True only when the target proves rolebox is the event's only listener. */
  private soleOwner(event: ProcessFatalEventType): boolean {
    let count: number | undefined;
    try {
      count = this.target.listenerCount?.(event);
    } catch (err) {
      this.safeDebug("listenerCount failed", event, err);
    }
    // No census means sole ownership cannot be proven; observing only keeps
    // the reporter from pre-empting a handler it cannot see.
    return count === 1;
  }

  /** True when a capture callback has taken over uncaught-exception handling. */
  private hasCaptureCallback(): boolean {
    try {
      return process.hasUncaughtExceptionCaptureCallback?.() === true;
    } catch {
      return false;
    }
  }

  /** Best-effort diagnostic logging that can never propagate. */
  private safeDebug(message: string, event: string, err: unknown): void {
    try {
      log.debug(`process-fatal ${message}`, { event, error: formatError(err).message });
    } catch {
      // Logging is best-effort — swallow.
    }
  }
}

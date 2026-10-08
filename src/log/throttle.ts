// ── Opt-in windowed throttling ──────────────────────────────────────────────
//
// SUPPRESSION IS SOMETHING AN EVENT DECLARES, NEVER SOMETHING THE PIPELINE
// DECIDES. A (channel, code) pair is throttled only when its registry entry
// carries `throttleMs`; every other record is emitted every time. That keeps
// the interesting diagnostics lossless by default and confines the loss to the
// entries that deliberately asked for it.
//
// WHAT A WINDOW DOES
//   • the first occurrence opens the window and is emitted;
//   • every occurrence inside the window is dropped and counted;
//   • the first occurrence at or after the window's end is emitted, and the
//     count of what was dropped rides along with it — as the `suppressed` field
//     on that record — so the loss is reported by the next record rather than
//     being silent.
//
// The clock is injectable so a test can move time instead of waiting; the
// process-wide instance (logThrottle) uses Date.now. A clock that steps
// backwards opens a fresh window instead of suppressing until it catches up.

/** What the gate decided about one occurrence. */
export interface ThrottleDecision {
  /** True when this occurrence must be emitted. */
  readonly emit: boolean;
  /** How many earlier occurrences this emitted record reports as dropped. */
  readonly suppressed: number;
}

/** The windowed gate. One instance holds the state of every (channel, code). */
export interface LogThrottle {
  /**
   * Decide one occurrence. `throttleMs` is the entry's window; `undefined` or a
   * non-positive value means "never throttled" — the occurrence is emitted and
   * any pending suppressed count (which cannot exist in that case) rides along.
   */
  check(key: string, throttleMs: number | undefined): ThrottleDecision;
  /** Forget every window. */
  reset(): void;
}

/** Injection seam for the clock the windows are measured with. */
export interface LogThrottleOptions {
  readonly now?: () => number;
}

interface WindowState {
  /** When the last occurrence was emitted; `undefined` before the first. */
  last: number | undefined;
  /** Occurrences dropped since that emit. */
  pending: number;
}

/**
 * Build a throttle. `options.now` replaces Date.now, which is the only reason
 * this factory exists: the pipeline's own instance (logThrottle) is built with
 * the real clock, and a test injects one it controls.
 */
export function createLogThrottle(options?: LogThrottleOptions): LogThrottle {
  const windows = new Map<string, WindowState>();
  const injected = options?.now;
  const clock = (): number => {
    try {
      return typeof injected === "function" ? injected() : Date.now();
    } catch {
      return Date.now();
    }
  };

  return {
    check(key: string, throttleMs: number | undefined): ThrottleDecision {
      const state = windows.get(key) ?? { last: undefined, pending: 0 };
      windows.set(key, state);

      const window = typeof throttleMs === "number" && Number.isFinite(throttleMs) ? throttleMs : 0;
      if (window <= 0) {
        const suppressed = state.pending;
        state.pending = 0;
        return { emit: true, suppressed };
      }

      const now = clock();
      const opened = state.last === undefined || now < state.last || now - state.last >= window;
      if (!opened) {
        state.pending += 1;
        return { emit: false, suppressed: 0 };
      }

      state.last = now;
      const suppressed = state.pending;
      state.pending = 0;
      return { emit: true, suppressed };
    },

    reset(): void {
      windows.clear();
    },
  };
}

/** The key one throttled window is measured over: the channel and the code. */
export function logThrottleKey(channel: string, code: string): string {
  return channel + "\u0000" + code;
}

/** The process-wide instance the pipeline uses. */
let processThrottle: LogThrottle = createLogThrottle();

/** The process-wide throttle (the pipeline's own gate). */
export function logThrottle(): LogThrottle {
  return processThrottle;
}

/** Test seam: install a throttle built with an injected clock. */
export function __setLogThrottleForTest(throttle?: LogThrottle): void {
  processThrottle = throttle ?? createLogThrottle();
}

/** Test seam: forget every window of the process-wide throttle. */
export function __resetLogThrottleForTest(): void {
  processThrottle.reset();
}

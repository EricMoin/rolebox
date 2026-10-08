// ── Opt-in windowed throttling ──────────────────────────────────────────────
//
// SUPPRESSION IS SOMETHING AN EVENT DECLARES, NEVER SOMETHING THE PIPELINE
// DECIDES. An event is throttled only when its registry entry carries
// `throttleMs`; every other record is emitted every time. That keeps the
// interesting diagnostics lossless by default and confines the loss to the
// entries that deliberately asked for it.
//
// WHAT ONE WINDOW IS MEASURED OVER (the key). A window is keyed by three parts:
// the registry channel, the event code and — for an entry that declares
// `throttleBy` — a SUBJECT read out of the record's own fields. The subject is
// what a suppression would otherwise hide: the drifted code of an
// `log.event.unknown-code` record, or the caller channel of a
// `log.field.narrowed` record. Every distinct subject therefore holds its OWN
// window, so suppressing a repeat of subject A can never hide the first report
// about subject B. `throttleBy` names the field; a field that is absent, or
// whose value is not a string, degrades to the empty subject, which is exactly
// the pre-subject key.
//
// WHAT A WINDOW DOES
//   • the first occurrence of a subject opens its window and is emitted;
//   • every occurrence of that subject inside the window is dropped and counted;
//   • the first occurrence of that subject at or after the window's end is
//     emitted, and the count of what was dropped rides along with it — as the
//     `suppressed` field on that record — so the loss is reported by the next
//     record about the SAME subject rather than being silent.
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
   * Decide one occurrence of one subject. `throttleMs` is the entry's window;
   * `undefined` or a non-positive value means "never throttled" — the
   * occurrence is emitted and any pending suppressed count (which cannot exist
   * in that case) rides along. Each key holds its own window.
   */
  check(key: string, throttleMs: number | undefined): ThrottleDecision;
  /**
   * The same decision for one `(channel, code, subject)` occurrence. A missing
   * or non-string `subject` is the empty subject — the pre-subject key, kept so
   * an entry without `throttleBy` behaves exactly as it did before.
   */
  checkSubject(key: string, throttleMs: number | undefined, subject?: string): ThrottleDecision;
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

  const decide = (
    key: string,
    throttleMs: number | undefined,
    subject: string | undefined,
  ): ThrottleDecision => {
    // One window per subject: the subject is part of the key, so the empty
    // subject and every named one are measured apart from each other.
    const windowKey = logThrottleKey(key, "", typeof subject === "string" ? subject : "");
    const state = windows.get(windowKey) ?? { last: undefined, pending: 0 };
    windows.set(windowKey, state);

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
  };

  return {
    check(key: string, throttleMs: number | undefined): ThrottleDecision {
      return decide(key, throttleMs, "");
    },

    checkSubject(key: string, throttleMs: number | undefined, subject?: string): ThrottleDecision {
      return decide(key, throttleMs, subject);
    },

    reset(): void {
      windows.clear();
    },
  };
}

/**
 * The key one throttled window is measured over: the channel, the code and the
 * SUBJECT. `subject` is the third dimension and stays optional so the
 * pre-subject callers keep their exact old key (the empty subject).
 */
export function logThrottleKey(channel: string, code: string, subject = ""): string {
  return channel + "\u0000" + code + "\u0000" + subject;
}

/**
 * The subject one record contributes to its entry's throttle key: the value of
 * the field `throttleBy` names. A missing field, a non-string value or a
 * `throttleBy` that is not a usable name all degrade to the empty subject — an
 * entry whose subject dimension is misconfigured loses the dimension, it never
 * throws and never suppresses a subject under another subject's key.
 */
export function logThrottleSubject(
  fields: Readonly<Record<string, unknown>> | undefined,
  throttleBy: string | undefined,
): string {
  if (fields === undefined || typeof throttleBy !== "string" || throttleBy.length === 0) return "";
  const value = fields[throttleBy];
  return typeof value === "string" ? value : "";
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

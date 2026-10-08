// ── Bounded in-memory ring buffer ───────────────────────────────────────────
//
// THE LIVE VIEW OF THE PIPELINE. A console line is gone as soon as it scrolls,
// and a file line is only as fresh as the last read; this sink keeps the last N
// records in the process, in order, so a TUI panel or a web route can render
// what just happened and a test can assert on it without touching the file
// system.
//
// BOUNDED ON PURPOSE. 500 records by default, never grown by configuration: a
// long-running host must not accumulate a second copy of its own log. The oldest
// record is overwritten, and the buffer never allocates per record beyond the
// snapshot a reader asks for.
//
// THE READ SIDE IS A COPY. `records()` returns a frozen snapshot array and
// `last()` a single record; neither can be used to reach into the buffer. A
// subscription is called for every record the sink receives and its errors are
// contained — a slow or broken viewer must not break the pipeline.

import type { LogRecord, LogSink } from "../types.ts";

/** The mark that identifies a memory sink among arbitrary sinks. */
export const MEMORY_SINK_KIND = "rolebox.log.memory";

/** The ring size used when no capacity is given. */
export const DEFAULT_MEMORY_CAPACITY = 500;

/** Options for {@link createMemorySink}. */
export interface MemorySinkOptions {
  /** How many records to keep; a non-positive or invalid value means the default. */
  readonly capacity?: number;
}

/** A bounded, subscribable record buffer. */
export interface MemorySink extends LogSink {
  readonly kind: typeof MEMORY_SINK_KIND;
  readonly capacity: number;
  /** How many records are buffered right now (at most `capacity`). */
  readonly size: number;
  /** A frozen snapshot of the buffer, oldest first. */
  records(): readonly LogRecord[];
  /** The most recent record, or `undefined` when the buffer is empty. */
  last(): LogRecord | undefined;
  /** Listen to every record the sink receives; returns an unsubscribe function. */
  subscribe(listener: (record: LogRecord) => void): () => void;
  /** Drop every record and every subscription, as if the sink were just built. */
  clear(): void;
}

/** True when `sink` was built by {@link createMemorySink}. */
export function isMemorySink(sink: LogSink): sink is MemorySink {
  return typeof sink === "function" && (sink as Partial<MemorySink>).kind === MEMORY_SINK_KIND;
}

/** A positive integer, or the fallback. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Build a memory sink. The returned value is a `LogSink` function with the
 * buffer's read/subscribe surface attached, so it can be handed to
 * configureLogging({ sinks: [...] }) like any other sink.
 */
export function createMemorySink(options?: MemorySinkOptions): MemorySink {
  const capacity = positiveInt(options?.capacity, DEFAULT_MEMORY_CAPACITY);
  const buffer: LogRecord[] = new Array<LogRecord>(capacity);
  const listeners = new Set<(record: LogRecord) => void>();
  let start = 0;
  let count = 0;

  const push = (record: LogRecord): void => {
    if (count < capacity) {
      buffer[(start + count) % capacity] = record;
      count += 1;
      return;
    }
    buffer[start] = record;
    start = (start + 1) % capacity;
  };

  const snapshot = (): readonly LogRecord[] => {
    const out: LogRecord[] = [];
    for (let i = 0; i < count; i++) out.push(buffer[(start + i) % capacity]);
    return Object.freeze(out);
  };

  const sink = ((record: LogRecord): void => {
    try {
      push(record);
    } catch {
      // A buffer that cannot take a record must not break the pipeline.
    }
    for (const listener of [...listeners]) {
      try {
        listener(record);
      } catch {
        // A viewer must not break the pipeline either.
      }
    }
  }) as MemorySink;

  Object.defineProperties(sink, {
    kind: { value: MEMORY_SINK_KIND, enumerable: true },
    capacity: { value: capacity, enumerable: true },
    size: { get: (): number => count, enumerable: true },
    records: { value: snapshot, enumerable: true },
    last: {
      value: (): LogRecord | undefined => (count === 0 ? undefined : buffer[(start + count - 1) % capacity]),
      enumerable: true,
    },
    subscribe: {
      value: (listener: (record: LogRecord) => void): (() => void) => {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
      enumerable: true,
    },
    clear: {
      value: (): void => {
        for (let i = 0; i < capacity; i++) buffer[i] = undefined as unknown as LogRecord;
        start = 0;
        count = 0;
        listeners.clear();
      },
      enumerable: true,
    },
  });

  return sink;
}

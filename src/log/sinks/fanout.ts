// ── Fan-out with per-sink isolation ─────────────────────────────────────────
//
// ONE RECORD, EVERY DESTINATION, NO SHARED FAILURE. The pipeline's sink is a
// fan-out over the configured destinations (console + file + memory by default).
// Each member is called inside its own guard, so a destination that throws —
// a broken viewer, a full disk rendered as an exception, a sink a caller built
// wrong — loses only its own copy of the record: the other destinations still
// receive it, and the caller that emitted it is never disturbed.
//
// REPORTED ONCE, NOT ONCE PER RECORD. A destination that throws on EVERY record
// would otherwise turn the pipeline into a flood of failure reports — and if it
// is the file destination, each report would try to write the file that just
// failed. The fan-out therefore reports each destination's first failure to its
// `onFailure` callback and stays silent about the rest; the callback is invoked
// outside the per-member guard and its own errors are contained, so a reporter
// that emits another record cannot recurse (the name is already in the reported
// set, and a nested report is skipped outright).
//
// The fan-out itself never throws.

import type { LogRecord, LogSink } from "../types.ts";

/** How the fan-out is named and observed. */
export interface FanoutOptions {
  /** Destination names, index-aligned with the sinks; defaults to "sink#<i>". */
  readonly names?: readonly string[];
  /** Called at most once per destination, with the error that destination threw. */
  readonly onFailure?: (name: string, error: unknown) => void;
}

/** A composite sink over an ordered list of destinations. */
export interface FanoutSink extends LogSink {
  /** The destinations, in order. */
  readonly sinks: readonly LogSink[];
  /** The destination names, index-aligned with `sinks`. */
  readonly names: readonly string[];
  /** The names whose failure has already been reported, in report order. */
  failed(): readonly string[];
}

/**
 * Compose `sinks` into one sink. A member that is not callable is treated as a
 * failing destination (reported once) rather than throwing at the caller.
 */
export function createFanoutSink(sinks: readonly LogSink[], options?: FanoutOptions): FanoutSink {
  const members = [...sinks];
  const names = members.map((_, index) => options?.names?.[index] ?? "sink#" + index);
  const reported = new Set<string>();
  const failedNames: string[] = [];
  let reporting = false;

  const sink = ((record: LogRecord): void => {
    for (let index = 0; index < members.length; index++) {
      try {
        const member = members[index];
        if (typeof member !== "function") throw new TypeError("sink is not a function");
        member(record);
      } catch (error) {
        const name = names[index];
        if (reported.has(name)) continue;
        reported.add(name);
        failedNames.push(name);
        if (reporting) continue;
        reporting = true;
        try {
          options?.onFailure?.(name, error);
        } catch {
          // A reporter must not break the pipeline.
        } finally {
          reporting = false;
        }
      }
    }
  }) as FanoutSink;

  Object.defineProperties(sink, {
    sinks: { value: Object.freeze(members), enumerable: true },
    names: { value: Object.freeze([...names]), enumerable: true },
    failed: { value: (): readonly string[] => Object.freeze([...failedNames]), enumerable: true },
  });

  return sink;
}

/**
 * The log source, WATCHED — the file-system edge of the live log surfaces.
 *
 * Both live surfaces are CURSOR pollers: the TUI's Logs pane reads in process
 * and the dsh web console's log panel reads `GET /rolebox/logs`, and each holds
 * one cursor string between polls. A cursor makes a poll incremental, but a poll
 * on a timer still answers "nothing new" at a cadence nobody asked for, and it
 * answers up to one interval LATE when something did move.
 *
 * This module is the other edge: one debounced `fs.watch` over the location a
 * read resolves to, so an append wakes a surface instead of an interval noticing
 * it. Both surfaces keep a slow poll as the safety net — a platform without
 * `fs.watch`, a directory that does not exist yet at watch time, a dropped
 * event — which is why nothing here has to be reliable in the strong sense: the
 * fallback is what makes the loss tolerable, and this edge only has to make the
 * common case immediate.
 *
 * THE WATCHED LOCATION IS THE READ LOCATION, resolved through the reader's own
 * {@link resolveLogSource} and never restated here; that is the property that
 * cannot drift. `kind: "dir"` watches the directory a per-channel read lists.
 * `kind: "file"` (the legacy single-file mode) watches that file's PARENT
 * directory, because a read of that source also scans the file's rotated
 * copies (`<file>.1`, `.2`, …) beside it, and a rotation renames the active
 * file away — a watch bound to the file's own name would lose the entry it was
 * attached to.
 *
 * FAILURE IS NEVER FATAL, exactly as in the state-directory watcher
 * (`src/platform/adapters/dsh/watch-rolebox-state.ts`): an absent directory, a
 * platform without `fs.watch`, an exhausted watch budget or a permission error
 * all degrade to a NO-OP disposer. The directory is never created — creating one
 * in order to watch it would be a side effect of merely looking. A throwing
 * observer is caught, so the next change still triggers.
 *
 * PLATFORM VARIANCE IS PART OF THE CONTRACT, NOT HIDDEN BY IT. `fs.watch`
 * behaves differently on every platform — the same reason `followLogRecords`
 * polls instead of watching (`src/log/read.ts`) — and the difference is
 * observable here: a watch on a DIRECTORY reports a channel's file appearing
 * and a rotation renaming it on every platform, while a write to a file that is
 * ALREADY THERE is reported on the platforms whose directory watch carries
 * child content changes and not on the ones whose does not (measured on macOS in
 * tests/log/watch.test.ts, whose append case is guarded by platform). Appends to
 * the active channel file are what the caller's fallback poll is for, and the
 * design spends that poll rather than watching each channel file: a per-file
 * watch would have to re-arm on every rotation and on every channel that
 * appears, which is the follower's listing all over again.
 *
 * NODE-ONLY. This module imports `node:fs` and `node:path`, so browser-bundle
 * code must never reach it: `tests/platform/dsh-web-ui-logs-bundle.test.ts`
 * fails the build if `node:*` or `src/log/` appears in the client bundle.
 *
 * @module
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { resolveLogSource, type ListLogFilesOptions } from "./read.ts";

/**
 * What {@link watchLogSource} accepts: the READER's own source shape.
 *
 * Reused rather than restated, so the watcher and the read cannot disagree
 * about what `logDir` / `logFile` mean: on both sides an explicit field beats
 * the environment, through the same {@link resolveLogSource}.
 */
export type WatchLogSourceOptions = ListLogFilesOptions;

/** Coalescing window for raw file-system events (the state watcher's own value). */
export const LOG_WATCH_DEBOUNCE_MS = 120;

/**
 * Watch the location a log read resolves to, and signal a debounced change.
 *
 * The signal is a WAKE-UP, never a payload: the observer answers by running its
 * own cursor poll, so the poll stays the single source of truth and this channel
 * never models a delta.
 *
 * @param options - the reader's own source options, or `undefined` to watch
 *                  wherever the writer's chain resolves (the same answer the
 *                  reader gets with no options).
 * @param onChange - called once per debounced burst of file-system events, on
 *                   the event loop. A throw is swallowed.
 * @returns the disposer closing every watcher (idempotent, never throws). It is
 *          a no-op when nothing could be watched.
 */
export function watchLogSource(
  options: WatchLogSourceOptions | undefined,
  onChange: () => void,
): () => void {
  const source = resolveLogSource(options);
  // See the module comment: a legacy single file is watched through the
  // directory that holds it and its rotated copies.
  const target = source.kind === "file" ? dirname(source.path) : source.path;
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Coalesce a burst of raw events into one call.
   *
   * One logical append reaches `fs.watch` as several events (create, change,
   * rename-as-rotation) and a logging process emits them as a stream, while the
   * observer only needs to know that SOMETHING moved. The window does not slide:
   * the first event starts it and later events inside it are absorbed.
   */
  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch {
        // A throwing observer must not kill the watcher; the next change
        // re-triggers it.
      }
    }, LOG_WATCH_DEBOUNCE_MS);
    timer.unref?.();
  };

  // An absent directory is NOT created in order to be watched: rolebox makes the
  // log directory lazily with the first record, and creating one here would be a
  // side effect of merely looking. Nothing is armed; the caller's fallback poll
  // is what notices the directory appearing.
  if (existsSync(target)) {
    try {
      const watcher = watch(target, { persistent: false }, schedule);
      // AN FSWatcher IS AN EVENTEMITTER, AND AN `error` EVENT WITH NO LISTENER
      // IS THROWN — it is not returned to the caller and not merely logged: it
      // is thrown in whichever process holds the watcher. `fs.watch` reports
      // the ordinary life of a watched log directory that way (the directory
      // removed or rotated away while it was being watched, a permission error,
      // an exhausted watch budget), so an unlistened watcher turns a routine
      // file-system condition into a process-level crash of whatever host
      // embedded this edge. The contract above already says a watcher that
      // cannot report is simply SILENT with the caller's fallback poll in
      // charge, so the error is absorbed here.
      //
      // Absorbed SILENTLY rather than logged: this watcher watches the log
      // directory, so writing a log record from inside its own failure path is
      // a feedback loop into the very edge that just failed.
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Unsupported platform / exhausted watch budget / permissions: this edge
      // simply does not report, and the caller's fallback poll stays in charge.
    }
  }

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    /* istanbul ignore next -- close() is total here; the guard is defensive. */
    for (const watcher of watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
  };
}

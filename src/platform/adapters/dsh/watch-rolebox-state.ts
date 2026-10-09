/**
 * Rolebox state-directory watcher — the file-system edge of the run console's
 * event-driven updates.
 *
 * The console renders a COMPOSED snapshot (`GET /rolebox/status` +
 * `/rolebox/metrics`) that is read from rolebox's own state files: engine
 * graphs, dispatch task files, loop snapshots, progress and checkpoint files.
 * Those files are the one surface every producer in the process already writes
 * to — engines, the dispatch adapter, the loop coordinator's persistence — so a
 * watch on the directory is what turns "something moved" into a signal without
 * teaching every subsystem about the UI.
 *
 * It exists BESIDE the in-process hooks (the loop coordinator's persist callback
 * and the graph toolset's terminal observer), not instead of them: those two
 * fire immediately and with a precise reason, while the watcher catches the
 * rest (node-level engine writes, dispatch progress, checkpoints) at the cost
 * of a small debounce.
 *
 * Failure is never fatal: a platform without `fs.watch`, an unreadable
 * directory, or a directory that does not exist yet all degrade to "no file
 * signal" and the console still updates on the other two edges plus manual
 * refresh.
 *
 * @module
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { stateDirFor } from "../../../utils/state-paths.ts";

/**
 * Directories watched under the state root.
 *
 * The root itself holds `engine-*.json`, `dispatch-*.json` and
 * `metrics-*.json`; the two subdirectories hold the progress and checkpoint
 * summaries the console reads. Watching a directory that is absent is skipped
 * rather than created: rolebox makes these lazily, and creating one to watch it
 * would be a side effect of merely looking.
 */
const WATCHED_SUBDIRS = ["", "progress", "checkpoints"] as const;

/** Coalescing window for raw file-system events. */
export const WATCH_DEBOUNCE_MS = 120;

/**
 * Watch rolebox's state directory for changes that could move the snapshot.
 *
 * @param dir - the workspace/project directory (the same value the monitor
 *              route is constructed with); the state root is derived from it
 *              exactly as the readers derive it.
 * @param onChange - called once per debounced burst of file-system events.
 * @returns the disposer closing every watcher (idempotent, never throws).
 */
export function watchRoleboxState(dir: string, onChange: () => void): () => void {
  const root = stateDirFor(dir);
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Coalesce a burst of raw events into one call.
   *
   * A single logical write reaches `fs.watch` as several events (create,
   * change, rename-as-atomic-save), and a graph emitting node states arrives as
   * a stream; the caller only needs to know that SOMETHING moved.
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
    }, WATCH_DEBOUNCE_MS);
    timer.unref?.();
  };

  for (const sub of WATCHED_SUBDIRS) {
    const target = sub === "" ? root : join(root, sub);
    if (!existsSync(target)) continue;
    try {
      const watcher = watch(target, { persistent: false }, schedule);
      // AN FSWatcher IS AN EVENTEMITTER, AND AN `error` EVENT WITH NO LISTENER
      // IS THROWN — it is not returned to the caller and not merely logged: it
      // is thrown in whichever process holds the watcher. `fs.watch` reports
      // the ordinary life of a watched state directory that way (the directory
      // removed while it was being watched, a permission error, an exhausted
      // watch budget), so an unlistened watcher turns a routine file-system
      // condition into a crash of whatever process hosts the run console. The
      // contract above already says a watcher that cannot report degrades to
      // "no file signal" with the console still correct on its other edges, so
      // the error is absorbed here.
      //
      // Absorbed SILENTLY rather than logged: this edge exists so that state
      // writes reach the console, and a failure path that wrote a record of
      // itself would be feeding the very edge that just failed; the contract
      // above already makes a missing signal invisible.
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Unsupported platform / exhausted inotify watches / permissions: this
      // edge simply does not report, and the console stays correct.
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

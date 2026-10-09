/// <reference types="bun-types" />

/**
 * Regression test — an `'error'` event on the state watcher must not crash the host.
 *
 * The console's file-system edge is the sibling of the log watcher
 * (`src/log/watch.ts`) and it carried the identical defect: `fs.watch` returns
 * an FSWatcher, an FSWatcher is an EventEmitter, and an `'error'` event with no
 * listener is THROWN. `fs.watch` reports the ordinary life of a watched state
 * directory that way — the directory removed while it was being watched, a
 * permission error, an exhausted watch budget — so an unguarded watcher turns a
 * routine file-system condition into a crash of whatever process hosts the run
 * console. On the Windows CI lane that surfaced as `bun test` exiting 1 with 0
 * failures: the throw landed BETWEEN tests, which Bun treats as an unhandled
 * error. On macOS and Linux the watcher tends to go quiet instead, so this suite
 * drives the event directly rather than waiting for a platform to produce it.
 *
 * THE ROUTE. The claim is about the watcher the MODULE creates and what happens
 * when THAT object emits `'error'`, so the test hands the module a watcher it
 * can drive: `node:fs` is mocked BEFORE the module under test is imported (the
 * mock-then-dynamic-import seam tests/cli/config-path-partition.test.ts:34-47
 * uses), with the real module spread in and only `watch` replaced by a factory
 * returning a real EventEmitter that also carries `close()`. A static import in
 * tests/platform/dsh-rolebox-state-watch.test.ts would bind the real `node:fs`
 * first, which is why this lives in its own file. The module is then driven
 * through its public `watchRoleboxState` entry point against a REAL temporary
 * workspace, so its own `existsSync` guard still decides which subdirectories to
 * arm. Every assertion is on runtime behaviour; no source text is inspected.
 *
 * @module
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The REAL `node:fs`, captured before the mock below replaces the registry entry. */
const realFs = await import("node:fs");

/**
 * What `fs.watch` hands back, reduced to what this module touches: an
 * EventEmitter — so an `'error'` event with no listener is THROWN, exactly as on
 * the real class — with the `close()` the disposer must call.
 */
class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

/** Every watcher the mocked `watch` handed out, in creation order. */
const createdWatchers: FakeWatcher[] = [];
/** Every target the module asked to watch. */
const watchedTargets: string[] = [];

mock.module("node:fs", () => ({
  ...realFs,
  // The real fs.watch registers its observer as the watcher's own `change`
  // listener; mirroring that is what lets a case drive the module's debounce by
  // hand after an `'error'` has been absorbed.
  watch: (target: string, _options: unknown, listener?: () => void) => {
    watchedTargets.push(target);
    const watcher = new FakeWatcher();
    if (listener !== undefined) watcher.on("change", listener);
    createdWatchers.push(watcher);
    return watcher;
  },
}));

// Import AFTER the mock registration: the module under test must receive the
// fake `watch` above, which a static import would prevent.
const { WATCH_DEBOUNCE_MS, watchRoleboxState } = await import(
  "../../src/platform/adapters/dsh/watch-rolebox-state.ts"
);

/** A fresh REAL workspace whose state root exists, as the watcher requires. */
function tempWorkspace(): { dir: string; stateDir: string } {
  const dir = realFs.mkdtempSync(join(tmpdir(), "rolebox-watch-error-"));
  const stateDir = join(dir, ".rolebox", "state");
  realFs.mkdirSync(stateDir, { recursive: true });
  return { dir, stateDir };
}

/** Resolve `true` once `check` holds, or `false` after `ms` — a bounded wait. */
async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

beforeEach(() => {
  createdWatchers.length = 0;
  watchedTargets.length = 0;
});

describe("watchRoleboxState — a watcher 'error' event is absorbed", () => {
  it("does not throw when every watcher it armed emits 'error'", () => {
    const { dir, stateDir } = tempWorkspace();
    realFs.mkdirSync(join(stateDir, "progress"), { recursive: true });
    const dispose = watchRoleboxState(dir, () => {});
    try {
      // Both existing subdirectories were armed; the guard under test therefore
      // covers every watcher the module holds, not just the first.
      expect(watchedTargets).toEqual([stateDir, join(stateDir, "progress")]);
      expect(createdWatchers).toHaveLength(2);

      for (const watcher of createdWatchers) {
        // THE DEFECT: with no `'error'` listener this call THROWS in the process
        // that holds the watcher instead of failing quietly.
        expect(() => watcher.emit("error", new Error("EPERM: watch failed"))).not.toThrow();
      }
    } finally {
      dispose();
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps delivering the debounced signal after an absorbed 'error'", async () => {
    const { dir } = tempWorkspace();
    let signals = 0;
    const dispose = watchRoleboxState(dir, () => {
      signals += 1;
    });
    try {
      const watcher = createdWatchers.at(0);
      if (watcher === undefined) throw new Error("watchRoleboxState armed no watcher");
      watcher.emit("error", new Error("ENOSPC: watch budget exhausted"));

      // A raw event after the failure: the module's own schedule callback is
      // still bound, so the console keeps its file-system edge instead of losing
      // it to the error.
      watcher.emit("change", "change", "engine-a.json");
      expect(await waitUntil(() => signals > 0, WATCH_DEBOUNCE_MS + 1_500)).toBe(true);
      expect(signals).toBe(1);
    } finally {
      dispose();
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still closes every watcher it armed, once, on disposal", () => {
    const { dir, stateDir } = tempWorkspace();
    realFs.mkdirSync(join(stateDir, "checkpoints"), { recursive: true });
    const dispose = watchRoleboxState(dir, () => {});
    try {
      expect(createdWatchers).toHaveLength(2);
      dispose();
      dispose(); // idempotent, as the disposer's contract states
      for (const watcher of createdWatchers) {
        expect(watcher.closeCalls).toBe(1);
      }
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { beforeEach as resetBeforeEach } from "vitest";


import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.doMock("node:fs", () => ({
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
const { LOG_WATCH_DEBOUNCE_MS, watchLogSource } = await import("../../src/log/watch.ts");

/** The watcher the module armed, or a failure that names the missing arming. */
function armedWatcher(): FakeWatcher {
  const watcher = createdWatchers.at(-1);
  if (watcher === undefined) throw new Error("watchLogSource armed no watcher");
  return watcher;
}

/** A fresh REAL temporary directory that the module's `existsSync` guard accepts. */
function tempLogDir(): string {
  return realFs.mkdtempSync(join(tmpdir(), "rolebox-log-watch-error-"));
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

describe("watchLogSource — a watcher 'error' event is absorbed", () => {
  it("does not throw when the watcher it armed emits 'error'", () => {
    const dir = tempLogDir();
    const dispose = watchLogSource({ logDir: dir }, () => {});
    try {
      const watcher = armedWatcher();
      // The watch was armed on the location the read resolves to, so the guard
      // under test is a real armed watcher and not a skipped edge.
      expect(watchedTargets).toEqual([dir]);

      // THE DEFECT: with no `'error'` listener this call THROWS in the process
      // that holds the watcher instead of failing quietly.
      expect(() => watcher.emit("error", new Error("EPERM: watch failed"))).not.toThrow();
    } finally {
      dispose();
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps delivering the debounced signal after an absorbed 'error'", async () => {
    const dir = tempLogDir();
    let signals = 0;
    const dispose = watchLogSource({ logDir: dir }, () => {
      signals += 1;
    });
    try {
      const watcher = armedWatcher();
      watcher.emit("error", new Error("ENOSPC: watch budget exhausted"));

      // A raw event after the failure: the module's own schedule callback is
      // still bound, so the edge degrades to its documented silent self rather
      // than going deaf.
      watcher.emit("change", "change", "app.log");
      expect(await waitUntil(() => signals > 0, LOG_WATCH_DEBOUNCE_MS + 1_500)).toBe(true);
      expect(signals).toBe(1);
    } finally {
      dispose();
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still closes the watcher it armed, once, on disposal", () => {
    const dir = tempLogDir();
    const dispose = watchLogSource({ logDir: dir }, () => {});
    try {
      const watcher = armedWatcher();
      dispose();
      dispose(); // idempotent, as the disposer's contract states
      expect(watcher.closeCalls).toBe(1);
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

resetBeforeEach(() => vi.resetModules());

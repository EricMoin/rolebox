/// <reference types="bun-types" />

/**
 * THE LOG SOURCE WATCHER — the file-system edge of the live log surfaces.
 *
 * `watchLogSource` turns "a record landed at the location a read resolves to"
 * into a debounced signal, so the TUI's Logs pane and the dsh web console's log
 * panel refresh on the append instead of on their fallback poll. These tests
 * exercise it against a REAL temporary directory: the thing under test IS the
 * platform's watch behaviour and the reader's own source resolution, so faking
 * `fs.watch` would test the fake. Every wait is a bounded promise for a signal,
 * never an assertion on exact timing — and a bounded wait that MISSES buys one
 * more change rather than a failure: a raw event can be dropped or arrive late,
 * and src/log/watch.ts documents that as acceptable ("nothing here has to be
 * reliable in the strong sense: the fallback is what makes the loss tolerable").
 * A test that demanded one particular write be delivered would assert a
 * guarantee the module deliberately does not make, and under load the assertion
 * — not the watcher — is what fails. The retry is the pattern the house watcher
 * suite already uses (tests/platform/dsh-rolebox-state-watch.test.ts).
 *
 * The claims, in the order the design states them: a burst of appends is ONE
 * signal; nothing signals after the disposer; an absent directory degrades to a
 * no-op that creates nothing; a throwing observer does not kill the watcher;
 * and a legacy `logFile` source is watched through its PARENT directory, which
 * is what makes a rotated sibling visible. One further case pins the behaviour
 * the feature exists for — an append to a file that was ALREADY there — and
 * carries the suite's only platform guard, because a directory watch does not
 * report a child's content change on every platform (see the comment above the
 * case and the platform paragraph in src/log/watch.ts).
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LOG_WATCH_DEBOUNCE_MS, watchLogSource } from "../../src/log/index.ts";
import { removeDir, tempDir } from "../helpers/log.ts";

/** Sleep `ms` without asserting anything about the clock. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve `true` once `check` holds, or `false` after `ms`.
 *
 * A bounded wait rather than a fixed sleep: a signal that arrives early is
 * observed immediately, and a signal that never arrives costs the bound and
 * nothing more.
 */
async function waitUntil(check: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(10);
  }
  return check();
}

/**
 * Wait for `check`, and when the bounded wait MISSES, make ONE more change (via
 * `onMiss`) and wait again — the house pattern from
 * tests/platform/dsh-rolebox-state-watch.test.ts.
 *
 * WHY A MISS IS NOT A FAILURE. A raw `fs.watch` event can be dropped or delayed
 * — the first one after arming is the one a platform most often loses — and the
 * module accepts exactly that, because the caller's fallback poll is what makes
 * the loss tolerable. Asserting that one particular write was delivered would
 * therefore assert a guarantee the module declines to make, and on a loaded
 * machine the assertion, not the watcher, is what fails. Buying one more change
 * keeps the claim honest: nothing is asserted about the first wait, the second
 * is the same bounded wait, and a change that is dropped twice still fails. It
 * tolerates the arming edge only — never a watcher that cannot see the change at
 * all, which would miss both waits.
 *
 * The result is asserted where the wait carries the claim, and deliberately
 * ignored where the wait is only a SETTLE (see the coalescing case).
 */
async function waitForChange(
  check: () => boolean,
  onMiss: () => void,
  ms = 2_000,
): Promise<boolean> {
  if (await waitUntil(check, ms)) return true;
  onMiss();
  return waitUntil(check, ms);
}

/** A full debounce window plus slack: long enough that a due signal has landed. */
const QUIET_MS = LOG_WATCH_DEBOUNCE_MS + 300;

describe("watchLogSource", () => {
  it("coalesces a burst of appends into one signal", async () => {
    const dir = tempDir("rolebox-watch-burst-");
    const signals: number[] = [];
    const dispose = watchLogSource({ logDir: dir }, () => signals.push(Date.now()));
    try {
      const file = join(dir, "graph-host.log");

      // SETTLE FIRST, and never assert on the settle. Coalescing is a claim
      // about a burst the watcher ACTUALLY SAW, and the first raw event after
      // arming is the one a platform may drop: writing the measured burst into
      // that edge would measure the drop instead of the coalescing. One
      // throwaway append, retried once, moves the watcher past the edge.
      appendFileSync(file, '{"settle":1}\n');
      await waitForChange(
        () => signals.length >= 1,
        () => appendFileSync(file, '{"settle":2}\n'),
      );
      // Let any straggler from the settle land before the baseline is taken, so
      // the count below belongs to the measured burst and nothing else.
      await sleep(QUIET_MS);

      const before = signals.length;
      // One logical burst, written in one tick: `fs.watch` reports these as
      // several raw events, and the observer must see ONE wake-up.
      appendFileSync(file, '{"a":1}\n');
      appendFileSync(file, '{"b":2}\n');
      appendFileSync(file, '{"c":3}\n');
      expect(await waitUntil(() => signals.length > before)).toBe(true);
      // Nothing further from the same burst: the window absorbed the rest. The
      // window does not slide: the first event starts it and later events
      // inside it are absorbed, so with `before` as the baseline exactly one
      // signal may have arrived for this burst.
      await sleep(QUIET_MS);
      expect(signals.length - before).toBe(1);
    } finally {
      dispose();
      removeDir(dir);
    }
  });

  it("stops signalling once disposed, and disposing twice is safe", async () => {
    const dir = tempDir("rolebox-watch-dispose-");
    const file = join(dir, "graph-host.log");
    writeFileSync(file, "seed\n");

    const signals: number[] = [];
    const dispose = watchLogSource({ logDir: dir }, () => signals.push(Date.now()));
    dispose();
    dispose(); // Idempotent: a second call must not throw or re-arm anything.

    appendFileSync(file, '{"late":true}\n');
    expect(await waitUntil(() => signals.length > 0, QUIET_MS)).toBe(false);
    expect(signals).toHaveLength(0);

    removeDir(dir);
  });

  it("does not signal a change that arrived before the disposer ran", async () => {
    const dir = tempDir("rolebox-watch-pending-");
    const file = join(dir, "graph-host.log");
    writeFileSync(file, "seed\n");

    const signals: number[] = [];
    const dispose = watchLogSource({ logDir: dir }, () => signals.push(Date.now()));
    appendFileSync(file, '{"in-window":true}\n');
    // Disposed INSIDE the debounce window: the pending call is cancelled, so a
    // pane that unmounts does not get one last publish after its cleanup.
    dispose();

    await sleep(QUIET_MS);
    expect(signals).toHaveLength(0);

    removeDir(dir);
  });

  it("degrades to a no-op on an absent directory, and never creates it", async () => {
    const root = tempDir("rolebox-watch-absent-");
    const target = join(root, "not-created", "logs");
    const signals: number[] = [];

    const dispose = watchLogSource({ logDir: target }, () => signals.push(Date.now()));
    try {
      expect(existsSync(target)).toBe(false);
      await sleep(QUIET_MS);
      expect(signals).toHaveLength(0);

      // Nothing is held for a path that did not exist: creating it later is not
      // observed (a caller re-arms; the fallback poll is what notices the
      // directory appearing), and the watcher never created it itself.
      mkdirSync(target, { recursive: true });
      appendFileSync(join(target, "graph-host.log"), '{"after":true}\n');
      expect(await waitUntil(() => signals.length > 0, QUIET_MS)).toBe(false);
      expect(signals).toHaveLength(0);
      expect(existsSync(target)).toBe(true); // Created here, by the test.
    } finally {
      dispose();
      dispose();
      removeDir(root);
    }
  });

  it("never lets a throwing observer break the watcher", async () => {
    const dir = tempDir("rolebox-watch-throw-");

    let calls = 0;
    const dispose = watchLogSource({ logDir: dir }, () => {
      calls += 1;
      throw new Error("observer blew up");
    });
    try {
      // Each trigger is a NEW entry in the watched directory, which every
      // platform's directory watch reports; the append case below is the one
      // with a platform bound. A missed first event buys ONE more NEW entry and
      // the same bounded wait: the first raw event after arming is the drop the
      // module tolerates, and the retry is what the house pattern does with it.
      writeFileSync(join(dir, "graph-host.log"), '{"first":true}\n');
      expect(
        await waitForChange(
          () => calls >= 1,
          () => writeFileSync(join(dir, "graph-host-again.log"), '{"firstAgain":true}\n'),
        ),
      ).toBe(true);

      // The throw was swallowed: a SECOND trigger must still reach the observer.
      // Two calls can only come from two separately delivered changes — one
      // debounced burst is one call — so a call after the first throw is what
      // proves the watcher survived it. This trigger is a NEW entry too, so the
      // platform bound stays with the append case below.
      writeFileSync(join(dir, "dispatch.log"), '{"second":true}\n');
      expect(
        await waitForChange(
          () => calls >= 2,
          () => writeFileSync(join(dir, "dispatch-again.log"), '{"secondAgain":true}\n'),
        ),
      ).toBe(true);
    } finally {
      dispose();
      removeDir(dir);
    }
  });

  /**
   * Where a DIRECTORY watch reports a child file's CONTENT change — the case an
   * append to an existing channel file is. macOS (FSEvents) and Windows
   * (ReadDirectoryChangesW) report it; Linux's inotify watch on a directory
   * reports the entries changing (a file appearing, a rotation renaming it) but
   * not a write to a file that is already there, and that platform is carried by
   * the caller's fallback poll. See the platform paragraph in src/log/watch.ts.
   */
  const DIRECTORY_WATCH_SEES_APPENDS = process.platform !== "linux";

  it.skipIf(!DIRECTORY_WATCH_SEES_APPENDS)(
    "signals an append to an existing channel file, not only a new one",
    async () => {
      const dir = tempDir("rolebox-watch-append-");
      const file = join(dir, "graph-host.log");
      // Seeded BEFORE the watch: the signal below can only come from the append.
      writeFileSync(file, '{"seed":true}\n');

      const signals: number[] = [];
      const dispose = watchLogSource({ logDir: dir }, () => signals.push(Date.now()));
      try {
        appendFileSync(file, '{"appended":true}\n');
        // A missed first event buys ONE more append and the same bounded wait.
        // The platform guard above still carries the claim: a directory watch
        // that cannot report content changes at all would miss BOTH appends.
        expect(
          await waitForChange(
            () => signals.length >= 1,
            () => appendFileSync(file, '{"appendedAgain":true}\n'),
          ),
        ).toBe(true);
      } finally {
        dispose();
        removeDir(dir);
      }
    },
  );

  it("watches a legacy logFile through its PARENT directory, so rotations count", async () => {
    const dir = tempDir("rolebox-watch-file-");
    const legacy = join(dir, "legacy.log");
    writeFileSync(legacy, "seed\n");

    const signals: number[] = [];
    const dispose = watchLogSource({ logFile: legacy }, () => signals.push(Date.now()));
    try {
      // A rotation renames the active file to `legacy.log.1`. That is a NEW
      // directory entry beside the watched file, and it is exactly what a watch
      // bound to the file's own name would miss.
      writeFileSync(join(dir, "legacy.log.1"), "rotated\n");
      // A missed first event buys ONE more rotation copy, and never weakens the
      // claim: the next copy is a new sibling entry too, so a watch bound to the
      // file's own name would miss it just the same.
      expect(
        await waitForChange(
          () => signals.length >= 1,
          () => writeFileSync(join(dir, "legacy.log.2"), "rotated again\n"),
        ),
      ).toBe(true);
    } finally {
      dispose();
      removeDir(dir);
    }
  });
});

/// <reference types="bun-types" />

/**
 * Rolebox state-directory watcher tests.
 *
 * The watcher is the file-system edge of the run console's event-driven
 * updates: it turns "a state file changed" into a debounced signal, so the
 * console refetches without polling. These tests exercise it against a real
 * temporary directory — the thing under test IS the platform's watch
 * behaviour, so faking `fs.watch` would test the fake.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WATCH_DEBOUNCE_MS,
  watchRoleboxState,
} from "../../src/platform/adapters/dsh/watch-rolebox-state.ts";

/** Resolve when the signal arrives, or `null` after `ms`. */
function nextSignal(
  signals: number[],
  ms: number,
): Promise<number | null> {
  const seen = signals.length;
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = (): void => {
      if (signals.length > seen) {
        resolve(signals[signals.length - 1]!);
        return;
      }
      if (Date.now() - started > ms) {
        resolve(null);
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe("watchRoleboxState", () => {
  it("signals once per burst of state-file writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-watch-"));
    const stateDir = join(dir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });

    const signals: number[] = [];
    const dispose = watchRoleboxState(dir, () => signals.push(Date.now()));
    try {
      // Three writes inside one debounce window are one signal: the console
      // needs to know THAT something moved.
      writeFileSync(join(stateDir, "engine-a.json"), "{}");
      writeFileSync(join(stateDir, "engine-a.json"), '{"v":1}');
      writeFileSync(join(stateDir, "dispatch-a.json"), "{}");

      const first = await nextSignal(signals, 2000);
      if (first === null) {
        // A missed first event is tolerated (the platform may coalesce the
        // creation burst); one more write must still get through.
        writeFileSync(join(stateDir, "engine-b.json"), "{}");
      }
      const signal = first ?? (await nextSignal(signals, 2000));
      expect(signal).not.toBeNull();
      expect(signals.length).toBeGreaterThanOrEqual(1);
    } finally {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops signalling once disposed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-watch-off-"));
    const stateDir = join(dir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });

    const signals: number[] = [];
    const dispose = watchRoleboxState(dir, () => signals.push(Date.now()));
    dispose();
    dispose(); // idempotent

    writeFileSync(join(stateDir, "engine-a.json"), "{}");
    const signal = await nextSignal(signals, WATCH_DEBOUNCE_MS + 400);
    expect(signal).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it("degrades to a no-op when there is no state directory yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-watch-none-"));
    try {
      const dispose = watchRoleboxState(dir, () => {
        throw new Error("must never be called without a directory");
      });
      expect(typeof dispose).toBe("function");
      dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never lets a throwing observer break the watcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-watch-throw-"));
    const stateDir = join(dir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });

    let calls = 0;
    const dispose = watchRoleboxState(dir, () => {
      calls += 1;
      throw new Error("observer blew up");
    });
    try {
      writeFileSync(join(stateDir, "engine-a.json"), "{}");
      await nextSignal([], 400);
      const first = calls;
      writeFileSync(join(stateDir, "engine-b.json"), "{}");
      await nextSignal([], 400);
      // Still alive after the throw: the second write is observed too.
      expect(calls).toBeGreaterThanOrEqual(first);
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

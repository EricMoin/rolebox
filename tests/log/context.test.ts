/**
 * THE AMBIENT SCOPE, PINNED WITH REAL PROMISES AND TIMERS.
 *
 * Two halves have to hold at once, and they are the two halves the kernel's
 * JSDoc promises:
 *
 * 1. WHAT PROPAGATES. A scope entered with withLogScope survives `await`, a
 *    promise chain built inside it and a timer created inside it, so the work a
 *    graph advance starts keeps its identity without passing ids around.
 * 2. WHAT DOES NOT. A continuation that was created OUTSIDE the scope never
 *    sees it — a boot-time `setInterval`, a `.then` registered elsewhere — even
 *    while a scoped run is in flight. Those entry points must re-enter with
 *    withLogScope, which the last cases prove works.
 *
 * The identity is also pinned where it matters for the record contract: it
 * lands in `scope` and never in `fields`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  configureLogging,
  createLogger,
  currentLogScope,
  withLogScope,
} from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import type { LogScope } from "../../src/log/types.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 50 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

/** A real timer wait, so the propagation cases exercise the event loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ambient log scope", () => {
  it("answers an empty scope when none is active", () => {
    expect(currentLogScope()).toEqual({});
  });

  it("propagates across await into a microtask, a promise chain and a real timer", async () => {
    await withLogScope({ sessionId: "s1", graphId: "g1" }, async () => {
      expect(currentLogScope()).toEqual({ sessionId: "s1", graphId: "g1" });

      await Promise.resolve();
      expect(currentLogScope().graphId).toBe("g1");

      const chained = await Promise.resolve(1).then(() => currentLogScope());
      expect(chained.sessionId).toBe("s1");

      await sleep(5);
      expect(currentLogScope().graphId).toBe("g1");
    });
  });

  it("returns the callback's value and propagates its error", () => {
    expect(withLogScope({ graphId: "g1" }, () => 42)).toBe(42);
    expect(() =>
      withLogScope({ graphId: "g1" }, () => {
        throw new Error("advance failed");
      }),
    ).toThrow("advance failed");
    // The failed run leaves nothing behind.
    expect(currentLogScope()).toEqual({});
  });

  it("nests by merging, with the child overriding only the keys it names", () => {
    withLogScope({ graphId: "g1", attemptId: "a1" }, () => {
      withLogScope({ attemptId: "a2", nodeId: "n1" }, () => {
        expect(currentLogScope()).toEqual({ graphId: "g1", attemptId: "a2", nodeId: "n1" });
      });
      expect(currentLogScope()).toEqual({ graphId: "g1", attemptId: "a1" });
    });
  });

  it("treats an undefined or blank value as absent, so it cannot clear an inherited key", () => {
    withLogScope({ graphId: "g1", attemptId: "a1" }, () => {
      withLogScope({ attemptId: undefined, nodeId: "" }, () => {
        expect(currentLogScope()).toEqual({ graphId: "g1", attemptId: "a1" });
      });
    });
  });

  it("hands out a copy, so a caller can neither rewrite nor unsee the ambient scope", () => {
    withLogScope({ graphId: "g1" }, () => {
      const seen = currentLogScope();
      (seen as { graphId?: string }).graphId = "mutated";
      expect(currentLogScope().graphId).toBe("g1");
    });
    expect(currentLogScope()).toEqual({});
  });

  it("stamps the scope onto a record and keeps identity out of the fields", async () => {
    await withLogScope({ graphId: "g1", attemptId: "a1" }, async () => {
      await Promise.resolve();
      createLogger("graph:host").info("advancing", { state: "running" });
    });

    const record = memory.last();
    expect(record?.scope).toEqual({ graphId: "g1", attemptId: "a1" });
    expect(record?.fields).toEqual({ state: "running" });
    expect(Object.keys(record?.fields ?? {})).not.toContain("graphId");
    expect(Object.keys(record?.scope ?? {})).not.toContain("state");
  });

  it("records nothing about the scope outside the callback", () => {
    createLogger("graph:host").info("outside");
    expect(memory.last()?.scope).toEqual({});
  });

  it("does not give a continuation registered outside the scope the scope it resolves in", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Registered HERE, in the file's own (unscoped) context: the callback below
    // is a detached continuation, whatever happens while it is pending.
    const detached = gate.then(() => currentLogScope());

    await withLogScope({ graphId: "g-detached" }, async () => {
      release();
      await sleep(2);
    });

    expect(await detached).toEqual({});
  });

  it("does not give a boot-time interval the scope that happens to be active when it fires", async () => {
    const seen: LogScope[] = [];
    // The watchdog is created at "boot" — outside any scope, exactly as a
    // process-level setInterval is — and fires while a scoped run is in flight.
    const timer = setInterval(() => seen.push(currentLogScope()), 2);
    try {
      await withLogScope({ graphId: "g-interval", attemptId: "a1" }, () => sleep(40));
    } finally {
      clearInterval(timer);
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((scope) => scope.graphId === undefined && scope.attemptId === undefined)).toBe(true);
  });

  it("sees the scope again when the detached callback re-enters explicitly", async () => {
    const seen: LogScope[] = [];
    const scope: LogScope = { graphId: "g-reentry", attemptId: "a1" };
    const timer = setInterval(() => withLogScope(scope, () => seen.push(currentLogScope())), 2);
    try {
      await sleep(40);
    } finally {
      clearInterval(timer);
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.graphId === "g-reentry" && entry.attemptId === "a1")).toBe(true);
  });

  it("does give a listener the scope when the emit itself happens inside it", async () => {
    // The nuance worth documenting: propagation follows the CALL, not the
    // registration. A listener invoked synchronously from inside the scope sees
    // it; the same listener invoked later from outside does not.
    const seen: LogScope[] = [];
    const listener = (): void => {
      seen.push(currentLogScope());
    };

    withLogScope({ graphId: "g-sync" }, () => {
      listener();
    });
    listener();

    expect(seen).toEqual([{ graphId: "g-sync" }, {}]);
  });
});

/**
 * THE MEMORY SLICE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * Stage 4 promoted the memory slice's one recurring, identity-carrying warning
 * into a registered event — the failed read of a memory entry by id. What is
 * pinned HERE is the part the slice owns:
 *
 * 1. THE VOCABULARY. The code is registered in the shared table
 *    (src/log/registry.ts) at `warn` — the level its call site had — and its
 *    sentence is a single line.
 * 2. THE CHANNEL. It reports on `memory:store`, the module's own channel (which
 *    is what the file sink turns into <logDir>/memory:store.log), and the slice
 *    owns every code on it.
 * 3. THE FIELD SHAPE. The scope vocabulary (src/log/types.ts) carries sessions,
 *    agents, graphs and tools — NOT memory entries — so the entry id stays a
 *    FIELD (`id`), the way the engine events keep an execution id.
 * 4. A REAL CALL SITE. The event is emitted by driving the production store — a
 *    real MemoryStore whose connection is closed, so the read query throws —
 *    rather than by calling logEvent directly.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_EVENTS,
  configureLogging,
  isLogEventCode,
  logEvent,
  logEventDefinition,
} from "../../src/log/index.ts";
import type { LogEventCode } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** Every event the memory slice registers, and the channel it belongs to. */
const MEMORY_EVENTS: ReadonlyArray<readonly [LogEventCode, string]> = [
  ["store.read-failed", "memory:store"],
];

/** The channel this slice's module owns. */
const SLICE_CHANNELS: readonly string[] = ["memory:store"];

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 32 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

describe("memory slice event vocabulary", () => {
  it("registers exactly the slice's event on the slice's channel", () => {
    expect(MEMORY_EVENTS.length).toBe(1);
    for (const [code] of MEMORY_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => SLICE_CHANNELS.includes(entry.channel))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(MEMORY_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps the slice event at warn, the level its call site had", () => {
    expect(logEventDefinition("store.read-failed").level).toBe("warn");
  });

  it("routes the slice event to the channel of the module that emits it", () => {
    expect(logEventDefinition("store.read-failed").channel).toBe("memory:store");
  });

  it("keeps the message a single non-empty sentence", () => {
    const { message } = logEventDefinition("store.read-failed");
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("\n");
  });

  it("takes the level, channel and message from the table", () => {
    logEvent("store.read-failed", { id: "mem-1", error: "database is closed" });

    const record = memory.last();
    expect(record?.code).toBe("store.read-failed");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("memory:store");
    expect(record?.message).toBe(LOG_EVENTS["store.read-failed"].message);
    expect(record?.fields).toEqual({ id: "mem-1", error: "database is closed" });
    expect(Object.hasOwn(record?.fields ?? {}, "sessionId")).toBe(false);
  });
});

describe("the memory slice's event comes from the module that owns it", () => {
  it("reports a failed read from the real store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-log-events-"));
    try {
      const store = await MemoryStore.create(dir);
      // Closing the connection makes every later query throw, which is the
      // failure the store's read() catch reports.
      store.close();

      expect(store.read("mem-does-not-exist")).toBeNull();

      const record = memory.records().find((item) => item.code === "store.read-failed");
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe("memory:store");
      expect(record?.message).toBe(LOG_EVENTS["store.read-failed"].message);
      expect(record?.scope).toEqual({});
      expect(record?.fields?.id).toBe("mem-does-not-exist");
      expect(typeof record?.fields?.error).toBe("string");
      expect(String(record?.fields?.error).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * THE ENGINE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * The engine no longer owns a log module — the three files under src/graph that
 * held one (log.ts, log-format.ts, log-sinks.ts) are gone, the five emitting
 * files call the kernel directly
 * (logEvent / withLogScope from src/log/index.ts) and the kernel's own
 * behaviour — level gates, rendering, sinks, throttling, redaction, scope
 * propagation — is pinned by tests/log/**. What is left to pin HERE is the part
 * the engine is still responsible for:
 *
 * 1. THE VOCABULARY. Every diagnostic this slice reports is registered in the
 *    shared table (src/log/registry.ts) at `warn`, so the default console gate
 *    (ROLEBOX_LOG_CONSOLE_LEVEL, "warn") keeps all of them visible — the
 *    visibility the deleted module had for the engine's nineteen, and the
 *    visibility the outbox's three loose warn calls had before stage 4 moved
 *    them here. The sentences are those events' facts RE-WORDED for the table
 *    (the old lines were multi-clause, with rationale and formatted id lists);
 *    no id, reason or count was lost.
 * 2. THE CHANNELS. A code reports on the channel of the module that emits it —
 *    graph:host / graph:index / graph:tool / graph:declare — which is what the
 *    file sink turns into <logDir>/<channel>.log.
 * 3. THE FIELD SHAPE. A record's identity (graph, node, attempt, effect)
 *    travels in the SCOPE and its data (states, reasons, counts and the ids the
 *    scope vocabulary does not carry) in the fields, so a file record filters by
 *    `scope.graphId` and its fields stay flat. Identity names are asserted NOT
 *    to appear among the fields.
 * 4. THE DEFAULT CONSOLE LINE. One engine event, emitted under the kernel's
 *    default configuration, still lands on the console as a single line.
 * 5. A REAL CALL SITE. One of the outbox's three events is emitted by driving
 *    the production drain (GraphNotifications.flush) with a transport that
 *    throws, so the code is proven reachable from the module that owns it and
 *    not merely typed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_EVENTS,
  __resetLoggingForTest,
  configureLogging,
  isLogEventCode,
  logEvent,
  logEventDefinition,
  withLogScope,
} from "../../src/log/index.ts";
import type { LogEventCode } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { GraphNotifications } from "../../src/graph/application/graph-notifications.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { beginLogTest, captureConsole, endLogTest } from "../helpers/log.ts";

/**
 * Every event the engine emits and the channel it belongs to: the host's own
 * files report on graph:host, the execution index on graph:index, the tool
 * binding on graph:tool and the declaration tool on graph:declare.
 */
const GRAPH_EVENTS: ReadonlyArray<readonly [LogEventCode, string]> = [
  ["host.control-continuation.failed", "graph:host"],
  ["sweep.store-blocked", "graph:host"],
  ["sweep.summary", "graph:host"],
  ["watch.unwatched-executions", "graph:host"],
  ["watch.port-threw", "graph:host"],
  ["watch.announcement-unconfirmed", "graph:host"],
  ["watch.announcement-settled", "graph:host"],
  ["watch.settlement-threw", "graph:host"],
  ["dispatch.delivery-unproven", "graph:host"],
  ["dispatch.prime-failed", "graph:host"],
  ["dispatch.query-threw", "graph:host"],
  ["dispatch.binding-failed", "graph:host"],
  ["dispatch.unclaimed-confirmation", "graph:host"],
  ["index.confirmation-refused", "graph:index"],
  ["index.release-unproven", "graph:index"],
  ["tool.control-continuation", "graph:tool"],
  ["tool.control-follow-up-threw", "graph:tool"],
  ["tool.cancel-delivery", "graph:tool"],
  ["declare.persistence-failed", "graph:declare"],
  // Stage 4 moved the notification outbox's three loose warn calls into the
  // table, on the outbox's own channel.
  ["notifications.source-unreadable", "graph:notifications"],
  ["notifications.lease-renewal-failed", "graph:notifications"],
  ["notifications.delivery-failed", "graph:notifications"],
];

/** The identity names a record carries in its scope instead of its fields. */
const IDENTITY_KEYS: readonly string[] = ["graphId", "nodeId", "attemptId", "effectId"];

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 64 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

describe("graph engine event vocabulary", () => {
  it("registers exactly the twenty-two graph-slice events in the shared table", () => {
    expect(GRAPH_EVENTS.length).toBe(22);
    for (const [code] of GRAPH_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    // The slice owns every code that reports on a "graph:" channel — the
    // nineteen the engine migration registered and the notification outbox's
    // three — so nothing outside this list can claim one.
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => entry.channel.startsWith("graph:"))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(GRAPH_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps every graph-slice event at warn", () => {
    for (const [code] of GRAPH_EVENTS) {
      expect(logEventDefinition(code).level).toBe("warn");
    }
  });

  it("routes every graph-slice event to the channel of the module that emits it", () => {
    const counts: Record<string, number> = {};
    for (const [code, channel] of GRAPH_EVENTS) {
      expect(logEventDefinition(code).channel).toBe(channel);
      counts[channel] = (counts[channel] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "graph:host": 13,
      "graph:index": 2,
      "graph:tool": 3,
      "graph:declare": 1,
      "graph:notifications": 3,
    });
  });

  it("keeps every message a single non-empty sentence", () => {
    for (const [code] of GRAPH_EVENTS) {
      const { message } = logEventDefinition(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    }
  });

  it("carries identity in the scope and data in the fields", () => {
    for (const [code, channel] of GRAPH_EVENTS) {
      withLogScope({ graphId: "g1", nodeId: "n1", attemptId: "a1", effectId: "e1" }, () => {
        logEvent(code, { reason: "denied", count: 2, ok: false, ids: ["a", "b"] });
      });
      const record = memory.last();
      expect(record?.code).toBe(code);
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe(channel);
      expect(record?.scope).toEqual({ graphId: "g1", nodeId: "n1", attemptId: "a1", effectId: "e1" });
      // The data keeps its shape: strings, numbers, booleans and a real array.
      expect(record?.fields).toEqual({ reason: "denied", count: 2, ok: false, ids: ["a", "b"] });
      for (const identity of IDENTITY_KEYS) {
        expect(Object.hasOwn(record?.fields ?? {}, identity)).toBe(false);
      }
    }
  });

  it("reaches the console as one line under the kernel's default configuration", () => {
    const capture = captureConsole();
    try {
      __resetLoggingForTest();
      configureLogging({ role: "host" });
      logEvent("sweep.store-blocked", { reason: "unreadable" });
    } finally {
      capture.restore();
    }
    expect(capture.warn.length).toBe(1);
    expect(capture.warn[0]).toContain("sweep.store-blocked");
    expect(capture.warn[0]).toContain('reason="unreadable"');
    expect(capture.warn[0]?.split("\n").length).toBe(1);
  });
});

describe("the notification outbox's events come from the outbox itself", () => {
  it("reports a failed delivery from the drain loop as notifications.delivery-failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "graph-log-events-"));
    // A pending delivery of the outbox's own kind, exactly as capture() inserts
    // it: the drain loop picks it up and hands it to the transport below. Its
    // notice is terminal, so the drain asks the transport instead of consulting
    // the run's suppression rule first.
    const store = GraphStore.openFile(root);
    store.run(
      `INSERT INTO ${GRAPH_STORE_TABLES.pendingEffects}
        (graph_id, run_id, effect_id, attempt_id, kind, payload, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      "g1", "r1", "notify:1", "notify:1", "graph-notification",
      JSON.stringify({
        notification: {
          id: "notify:1", graphId: "g1", runId: "r1", sessionId: "s1",
          kind: "complete", reason: "All activated graph work completed.",
        },
        attempts: 0,
        retryAt: 0,
      }),
      Date.now() - 1_000,
    );
    store.close();

    const notifications = new GraphNotifications(root, {
      send: async () => { throw new Error("transport unavailable"); },
    });
    try {
      await notifications.flush();
    } finally {
      notifications.close();
      rmSync(root, { recursive: true, force: true });
    }

    const record = memory.records().find((item) => item.code === "notifications.delivery-failed");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("graph:notifications");
    expect(record?.message).toBe(LOG_EVENTS["notifications.delivery-failed"].message);
    // The notice's own identity travels in the scope; the failure text is data.
    expect(record?.scope).toEqual({ graphId: "g1", runId: "r1" });
    expect(record?.fields).toEqual({ error: "transport unavailable" });
  });
});

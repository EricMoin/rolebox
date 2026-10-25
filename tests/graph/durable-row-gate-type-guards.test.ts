
/**
 * THE DURABLE-ROW GATE — the notification payload and the run-state body
 * (F-07, and F-03's application/run-view half).
 *
 * WHY THIS FILE EXISTS. Two persisted rows used to be narrowed by ASSERTION
 * rather than by reading:
 *
 * 1. `ledger_pending_effects.payload` was `JSON.parse`d and `as Delivery`-cast
 *    before `delivery.retryAt`, `delivery.attempts + 1` and
 *    `delivery.notification.graphId` were dereferenced. A foreign or corrupt
 *    row (the table is shared, and the envelope carries no format tag) made the
 *    drain throw a raw `TypeError` — its caller only logs — or compute
 *    `now + NaN` backoff. The cases below plant every shape this build does not
 *    write and require the row to be COMPLETED and REPORTED instead, while a
 *    payload this build wrote still drains with exactly the pre-fix
 *    attempts/lease arithmetic.
 * 2. `application/graph-notifications.ts` asserted `GraphStateRecord.body` to
 *    `OutcomeGraphState`, although `readGraphView` had already decoded the same
 *    row with the versioned reader and thrown the decoded value away. The view
 *    now exposes the decoded phase (`recordedPhase`), so the assertion is gone;
 *    the run-state cases pin both the runtime value and the type, and the last
 *    case pins the source property itself (no `readGraphStateOf`, no
 *    `as OutcomeGraphState` in the application layer).
 *
 * STRENGTH: store-level, one process; every fixture lives in an isolated temp
 * tree removed with its connections.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphNotifications, type GraphNotification } from "../../src/graph/application/graph-notifications.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../src/graph/tools/declare-graph.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { GraphStore, type PendingNotificationEffect } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import type { OutcomeGraphPhase } from "../../src/graph/outcome/state-model.ts";
import { queryGraphs, type GraphView } from "../../src/graph/query/graph-query.ts";
import { configureLogging, __resetLoggingForTest } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { removeTempTree } from "./helpers/temp-dirs.ts";

const EFFECTS = GRAPH_STORE_TABLES.pendingEffects;
const EFFECT_KIND = "graph-notification";
const EFFECT_ID = "notify:1";
/** The drain's own claim lease, mirrored here so the case can assert it. */
const LEASE_MS = 60_000;
const RETRY_MS = 1_000;
const CLOCK = 1_700_000_000_000;

const roots: string[] = [];
const closers: { close(): void }[] = [];
let logState: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  logState = beginLogTest();
  memory = createMemorySink({ capacity: 64 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  for (const closer of closers.splice(0).reverse()) closer.close();
  endLogTest(logState);
  for (const root of roots.splice(0)) removeTempTree(root);
});

/** A fresh isolated store directory this case owns. */
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Plant one pending notification effect holding `payload` verbatim. */
function seedEffect(root: string, payload: string): void {
  const store = GraphStore.openFile(root);
  try {
    store.run(
      `INSERT INTO ${EFFECTS}
        (graph_id, run_id, effect_id, attempt_id, kind, payload, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      "g1", "r1", EFFECT_ID, EFFECT_ID, EFFECT_KIND, payload, CLOCK - 1_000,
    );
  } finally {
    store.close();
  }
}

/** The one effect's stored row, as the drain's own columns read it. */
function effectRow(root: string): { status: string; payload: string } {
  const store = GraphStore.openFile(root);
  try {
    const row = store.all(`SELECT status, payload FROM ${EFFECTS} WHERE effect_id = ?`, EFFECT_ID)[0];
    return { status: String(row?.["status"]), payload: String(row?.["payload"]) };
  } finally {
    store.close();
  }
}

/** The envelope THIS build's `capture()` writes, with the fields a case overrides. */
function deliveryPayload(overrides: {
  attempts?: number;
  retryAt?: number;
  leaseUntil?: number;
} = {}): string {
  return JSON.stringify({
    notification: {
      id: EFFECT_ID, graphId: "g1", runId: "r1", sessionId: "s1",
      kind: "complete", reason: "All activated graph work completed.",
    },
    attempts: overrides.attempts ?? 0,
    retryAt: overrides.retryAt ?? 0,
    ...(overrides.leaseUntil === undefined ? {} : { leaseUntil: overrides.leaseUntil }),
  });
}

/** One parsed stored envelope, as the cases inspect it. */
interface StoredDelivery {
  readonly notification: { readonly id: string };
  readonly attempts: number;
  readonly retryAt: number;
  readonly owner?: string;
  readonly leaseUntil?: number;
}

/** Parse the stored payload the way a reader documents the format, for assertions. */
function storedDelivery(root: string): StoredDelivery {
  return JSON.parse(effectRow(root).payload) as StoredDelivery;
}

/** Every `notifications.source-unreadable` record this case produced. */
function unreadableReports() {
  return memory.records().filter((record) => record.code === "notifications.source-unreadable");
}

// ── F-07 · a foreign payload is completed and reported, never delivered ─────

/**
 * Every shape this build never writes into a `graph-notification` payload.
 *
 * `ledger_pending_effects` is shared, so a row of another kind, a hand-edited
 * row, or a payload written by another build is reachable; none of these may
 * reach the transport, throw out of the drain, or be rewritten with a `NaN`
 * backoff (`JSON.stringify({ retryAt: NaN })` renders `null`).
 */
const CORRUPT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["text that is not JSON at all", "not json at all"],
  ["the JSON literal null", "null"],
  ["a JSON array", "[]"],
  ["a JSON string", '"a string"'],
  ["a JSON object with no notification", "{}"],
  ["a null notification", '{"notification":null,"attempts":0,"retryAt":0}'],
  [
    "a non-numeric attempt count",
    '{"notification":{"id":"notify:1","graphId":"g1","runId":"r1","sessionId":"s1","kind":"complete","reason":"ok"},"attempts":"zero","retryAt":0}',
  ],
  [
    "an unknown notice kind",
    '{"notification":{"id":"notify:1","graphId":"g1","runId":"r1","sessionId":"s1","kind":"unknown","reason":"ok"},"attempts":0,"retryAt":0}',
  ],
  [
    "an empty notification id",
    '{"notification":{"id":"","graphId":"g1","runId":"r1","sessionId":"s1","kind":"complete","reason":"ok"},"attempts":0,"retryAt":0}',
  ],
  [
    "a notification with no reason",
    '{"notification":{"id":"notify:1","graphId":"g1","runId":"r1","sessionId":"s1","kind":"complete"},"attempts":0,"retryAt":0}',
  ],
  [
    "a lease instant that is not a non-negative safe integer",
    '{"notification":{"id":"notify:1","graphId":"g1","runId":"r1","sessionId":"s1","kind":"complete","reason":"ok"},"attempts":0,"retryAt":0,"leaseUntil":-5}',
  ],
];

describe("a foreign notification payload is refused, completed and reported", () => {
  for (const [label, payload] of CORRUPT_CASES) {
    it(`completes and reports a row holding ${label}`, async () => {
      const root = tempRoot("durable-rows-refused-");
      seedEffect(root, payload);
      const sent: GraphNotification[] = [];
      const notifications = new GraphNotifications(root, {
        clock: () => CLOCK,
        retryMs: RETRY_MS,
        send: async (notification) => { sent.push(notification); return true; },
      });
      closers.push(notifications);

      // NEVER THROWS OUT OF THE DRAIN: the pre-fix `as Delivery` dereference
      // raised a raw `TypeError` here (whose caller only logs).
      await notifications.flush();

      // NOT DELIVERED, and not retried into a `NaN` backoff: the row is done and
      // its payload is byte-for-byte the foreign text nobody could decode.
      expect(sent).toEqual([]);
      expect(effectRow(root)).toEqual({ status: "done", payload });
      // REPORTED, not silently dropped: the unreadable source is named once.
      const reports = unreadableReports();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.scope).toEqual({ graphId: "g1", effectId: EFFECT_ID });
      expect(String(reports[0]?.fields["error"])).toContain("could not be read");
    });
  }
});

// ── F-07 · a payload this build wrote still drains identically ──────────────

describe("a payload this build wrote still drains with the same attempts and lease", () => {
  it("claims, leases, retries with the pre-fix backoff and then settles", async () => {
    const root = tempRoot("durable-rows-valid-");
    seedEffect(root, deliveryPayload());
    const sent: GraphNotification[] = [];
    let now = CLOCK;
    let claimed: StoredDelivery | undefined;
    let deliver = false;
    const notifications = new GraphNotifications(root, {
      clock: () => now,
      retryMs: RETRY_MS,
      send: async (notification) => {
        sent.push(notification);
        claimed = storedDelivery(root);
        return deliver;
      },
    });
    closers.push(notifications);

    await notifications.flush();

    // The notice itself is unchanged, and the CLAIM carried the drain's lease.
    expect(sent.map((notification) => notification.id)).toEqual([EFFECT_ID]);
    expect(claimed?.attempts).toBe(0);
    expect(typeof claimed?.owner).toBe("string");
    expect(claimed?.leaseUntil).toBe(CLOCK + LEASE_MS);
    // The transport refused: attempts advanced by one and the backoff is the
    // SAME expression as before the fix — `retryMs * 2 ** (attempts - 1)`.
    const retried = storedDelivery(root);
    expect(effectRow(root).status).toBe("pending");
    expect(retried.attempts).toBe(1);
    expect(retried.retryAt).toBe(CLOCK + RETRY_MS);
    expect(retried.owner).toBeUndefined();
    expect(retried.leaseUntil).toBeUndefined();
    expect(sent).toHaveLength(1);

    // The retry window opens, the transport accepts, the row is done at once.
    now = CLOCK + RETRY_MS;
    deliver = true;
    await notifications.flush();
    expect(sent).toHaveLength(2);
    expect(effectRow(root).status).toBe("done");
    expect(storedDelivery(root)).toMatchObject({ attempts: 2, retryAt: 0 });
  });

  it("honours an unexpired lease without touching the row, then retries after it lapses", async () => {
    const root = tempRoot("durable-rows-lease-");
    seedEffect(root, deliveryPayload({ attempts: 3, leaseUntil: CLOCK + 30_000 }));
    const sent: GraphNotification[] = [];
    let now = CLOCK;
    const notifications = new GraphNotifications(root, {
      clock: () => now,
      retryMs: RETRY_MS,
      send: async (notification) => { sent.push(notification); return false; },
    });
    closers.push(notifications);

    await notifications.flush();
    // ANOTHER OWNER'S LIVE LEASE IS STILL RESPECTED, byte for byte.
    expect(sent).toEqual([]);
    expect(effectRow(root)).toEqual({ status: "pending", payload: deliveryPayload({ attempts: 3, leaseUntil: CLOCK + 30_000 }) });

    now = CLOCK + 31_000;
    await notifications.flush();
    expect(sent).toHaveLength(1);
    const retried = storedDelivery(root);
    expect(retried.attempts).toBe(4);
    expect(retried.retryAt).toBe(now + RETRY_MS * 2 ** 3);
    expect(effectRow(root).status).toBe("pending");
  });

  it("completes a row whose payload column is not the TEXT this format writes", async () => {
    const root = tempRoot("durable-rows-blob-");
    const store = GraphStore.openFile(root);
    try {
      store.run(
        `INSERT INTO ${EFFECTS}
          (graph_id, run_id, effect_id, attempt_id, kind, payload, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        "g1", "r1", EFFECT_ID, EFFECT_ID, EFFECT_KIND, new Uint8Array([1, 2, 3]), CLOCK - 1_000,
      );
    } finally {
      store.close();
    }
    const sent: GraphNotification[] = [];
    const notifications = new GraphNotifications(root, {
      clock: () => CLOCK,
      send: async (notification) => { sent.push(notification); return true; },
    });
    closers.push(notifications);

    await notifications.flush();
    expect(sent).toEqual([]);
    expect(effectRow(root).status).toBe("done");
    expect(unreadableReports()).toHaveLength(1);
  });
});

// ── F-07 · the typed accessors replace the two raw-bag reads ────────────────

describe("the store's typed accessors", () => {
  it("counts executions and reports pending notification effects as typed rows", () => {
    expectTypeOf<GraphStore["countExecutions"]>().toEqualTypeOf<() => number>();
    expectTypeOf<GraphStore["readPendingNotificationEffects"]>()
      .toEqualTypeOf<(kind: string) => readonly PendingNotificationEffect[]>();

    const root = tempRoot("durable-rows-accessor-");
    seedEffect(root, deliveryPayload());
    const store = GraphStore.openFile(root);
    try {
      expect(store.countExecutions()).toBe(0);
      const effects = store.readPendingNotificationEffects(EFFECT_KIND);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toEqual({
        rowId: expect.any(Number),
        graphId: "g1",
        effectId: EFFECT_ID,
        payload: deliveryPayload(),
      });
      // Another kind is never handed to the notification drain.
      expect(store.readPendingNotificationEffects("some-other-kind")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

// ── F-03 · the run view still carries the decoded state it always projected ─

const VIEW_GRAPH = "durable.rows.view";

function viewDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: VIEW_GRAPH,
    nodes: [
      { id: "A", agent: "a1", prompt: "p1", outcomes: [{ id: "done" }] },
      { id: "B", agent: "a2", prompt: "p2", outcomes: [{ id: "done" }] },
    ],
    edges: [{ from: "A", to: "B", outcome: "done" }],
  };
}

/**
 * Declare one graph through the real writer and run it to the point `A` is
 * settled and `B` dispatched, so the run-state row the view reads is one this
 * build's own run path wrote — never hand-shaped.
 */
async function declareAndRun(storeDirectory: string, now: number): Promise<void> {
  const graph = buildDeclaredOutcomeGraph({ declaration: viewDeclaration() });
  expect(persistDeclaredGraph(graph, storeDirectory)).toBe(true);
  const ledger = await SqliteAcceptanceLedger.create(storeDirectory);
  try {
    const credentials = new Map<string, string>();
    const runtime = new OutcomeGraphRuntime({
      plan: graph.plan,
      ledger,
      dispatch: (request) => { credentials.set(request.attemptId, request.credential); },
      validators: createValidatorRegistry([]),
      artifactRoot: storeDirectory,
      clock: () => now,
      credentialIsolation: testHostCredentialIsolation(storeDirectory),
    });
    runtime.start(now);
    const credential = credentials.get("A#1");
    if (credential === undefined) throw new Error("fixture: no attempt for A");
    expect(runtime.submit({ nodeId: "A", outcomeId: "done", credential }, now + 30).kind).toBe("accepted");
  } finally {
    ledger.close();
  }
}

type GraphRunView = GraphView["runs"][number];

/** `true` only when `body` is not a key of the run view. */
type NoRawBody<T> = "body" extends keyof T ? never : true;

describe("the run view exposes the decoded state instead of a narrowed body", () => {
  it("keeps the phase, stop, nodes and loops, and adds the body's own phase", async () => {
    const root = tempRoot("durable-rows-view-");
    await declareAndRun(root, 100);

    const [view] = queryGraphs(root).graphs;
    if (view === undefined) throw new Error("fixture: no graph view");
    const [run] = view.runs;
    if (run === undefined) throw new Error("fixture: no run view");
    // THE SAME FACES A CONSUMER READ BEFORE THE FIX.
    expect(run.phase).toBe("executing");
    expect(run.stop).toBeUndefined();
    expect(run.nodes.map((node) => `${node.nodeId}:${node.status}`)).toEqual(["A:settled", "B:dispatched"]);
    expect(run.loops).toEqual([]);
    // THE DECODED BODY'S OWN PHASE, from `readGraphView`'s versioned read.
    expect(run.recordedPhase).toBe("executing");
    expect(Object.hasOwn(run, "recordedPhase")).toBe(true);
  });

  it("pins the decoded phase on the view type and keeps the raw body off it", () => {
    expectTypeOf<GraphRunView["recordedPhase"]>().toEqualTypeOf<OutcomeGraphPhase | undefined>();
    expectTypeOf<NoRawBody<GraphRunView>>().toEqualTypeOf<true>();
  });

  it("no longer names the run-state row or its body in the application layer", () => {
    const source = readFileSync(
      new URL("../../src/graph/application/graph-notifications.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("readGraphStateOf");
    expect(source).not.toContain("as OutcomeGraphState");
  });
});

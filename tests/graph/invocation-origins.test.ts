/**
 * The host's record of a graph's declaring invocation
 * (`src/graph/host/invocation-origins.ts`).
 *
 * The record exists because the window that arms a dispatch is not always the
 * declaring call: a successor is armed by an acceptance observed out of band,
 * and a restarted host re-arms what a dead process left pending. The tests pin
 * the four properties the sweep depends on — a recorded origin is readable
 * back, a re-declaration with a different attribution replaces it, an origin
 * that names nothing is refused, and memory durability writes nothing durable.
 *
 * THE RECORD IS A ROW OF THE WORKSPACE'S ONE GRAPH STORE NOW. It used to be a
 * whole-file JSON authority beside the acceptance ledger; P1 item 3 replaced
 * that file with the store's `graph_invocation_origins` table, so these cases
 * assert the same capabilities against the substrate that holds them today —
 * including that a store this build cannot read is REFUSED rather than treated
 * as "no origins".
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { HostInvocationOrigins } from "../../src/graph/host/invocation-origins.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { makeTmpDir } from "./helpers/host-graph-fixture.ts";

describe("HostInvocationOrigins", () => {
  it("records one origin per graph and replaces it when the invocation changes", () => {
    const root = makeTmpDir("invocation-origins-");
    const origins = HostInvocationOrigins.open({ root, durability: "memory" });

    expect(origins.record("graph.a", { sessionId: "session-1", agent: "agent.one" })).toBe(true);
    // The same attribution again is not a change.
    expect(origins.record("graph.a", { sessionId: "session-1", agent: "agent.one" })).toBe(false);
    expect(origins.get("graph.a")).toEqual({ sessionId: "session-1", agent: "agent.one" });
    expect(origins.get("graph.b")).toBeUndefined();
    expect(origins.graphIds()).toEqual(["graph.a"]);
    expect(origins.size).toBe(1);

    // A re-declaration from another invocation is the newer attribution.
    expect(origins.record("graph.a", { sessionId: "session-2" })).toBe(true);
    expect(origins.get("graph.a")).toEqual({ sessionId: "session-2" });
    expect(origins.record("graph.b", { sessionId: "session-3" })).toBe(true);
    expect(origins.graphIds()).toEqual(["graph.a", "graph.b"]);
  });

  it("refuses an origin that names no session, or no graph", () => {
    const root = makeTmpDir("invocation-origins-invalid-");
    const origins = HostInvocationOrigins.open({ root, durability: "memory" });
    expect(() => origins.record("", { sessionId: "session-1" })).toThrow(/graph id/);
    expect(() => origins.record("graph.a", { sessionId: "" })).toThrow(/declaring session/);
  });

  it("reads its durable record back in a later process", () => {
    const root = makeTmpDir("invocation-origins-durable-");
    const first = HostInvocationOrigins.open({ root, durability: "file" });
    first.record("graph.a", { sessionId: "session-1", agent: "agent.one" });
    first.record("graph.b", { sessionId: "session-2" });
    // The record lives in the workspace's graph store: no second authority file.
    expect(existsSync(graphStoreFilePath(root))).toBe(true);
    expect(existsSync(root + "/host-invocation-origins.json")).toBe(false);

    const second = HostInvocationOrigins.open({ root, durability: "file" });
    expect(second.get("graph.a")).toEqual({ sessionId: "session-1", agent: "agent.one" });
    expect(second.get("graph.b")).toEqual({ sessionId: "session-2" });
    expect(second.graphIds()).toEqual(["graph.a", "graph.b"]);
  });

  it("writes nothing durable in memory durability", () => {
    const root = makeTmpDir("invocation-origins-memory-");
    const origins = HostInvocationOrigins.open({ root, durability: "memory" });
    origins.record("graph.a", { sessionId: "session-1" });
    expect(existsSync(graphStoreFilePath(root))).toBe(false);
    expect(HostInvocationOrigins.open({ root }).get("graph.a")).toBeUndefined();
  });

  it("refuses a store file it cannot read instead of treating it as empty", () => {
    const root = makeTmpDir("invocation-origins-corrupt-");
    mkdirSync(root, { recursive: true });
    writeFileSync(graphStoreFilePath(root), "{ not json", "utf8");
    expect(() => HostInvocationOrigins.open({ root, durability: "file" })).toThrow();

    // A ZERO-BYTE authoritative file is a damaged store, never a fresh one.
    const emptyRoot = makeTmpDir("invocation-origins-empty-");
    mkdirSync(emptyRoot, { recursive: true });
    writeFileSync(graphStoreFilePath(emptyRoot), "", "utf8");
    expect(() => HostInvocationOrigins.open({ root: emptyRoot, durability: "file" })).toThrow();
  });

  it("stores its record in the same file as the acceptance ledger", async () => {
    const root = makeTmpDir("invocation-origins-one-store-");
    const origins = HostInvocationOrigins.open({ root, durability: "file" });
    origins.record("graph.a", { sessionId: "session-1" });
    const { SqliteAcceptanceLedger } = await import(
      "../../src/graph/ledger/sqlite-ledger.ts"
    );
    const ledger = await SqliteAcceptanceLedger.create(root);
    try {
      // The ledger opened the SAME file the origin wrote: one database, one
      // schema, one format gate for both records.
      expect(ledger.filePath).toBe(graphStoreFilePath(root));
    } finally {
      ledger.close();
    }
  });
});

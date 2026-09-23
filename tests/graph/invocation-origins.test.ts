/**
 * The host's record of a graph's declaring invocation
 * (`src/graph/host/invocation-origins.ts`).
 *
 * The record exists because the window that arms a dispatch is not always the
 * declaring call: a successor is armed by an acceptance observed out of band,
 * and a restarted host re-arms what a dead process left pending. The tests pin
 * the three properties the sweep depends on — a recorded origin is readable
 * back, a record this build cannot read is REFUSED rather than treated as
 * empty, and memory durability writes nothing.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  HOST_INVOCATION_ORIGINS_FILE,
  HostInvocationOrigins,
} from "../../src/graph/host/invocation-origins.ts";
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
    expect(existsSync(join(root, HOST_INVOCATION_ORIGINS_FILE))).toBe(true);

    const second = HostInvocationOrigins.open({ root, durability: "file" });
    expect(second.get("graph.a")).toEqual({ sessionId: "session-1", agent: "agent.one" });
    expect(second.get("graph.b")).toEqual({ sessionId: "session-2" });
    expect(second.graphIds()).toEqual(["graph.a", "graph.b"]);
  });

  it("writes nothing in memory durability", () => {
    const root = makeTmpDir("invocation-origins-memory-");
    const origins = HostInvocationOrigins.open({ root, durability: "memory" });
    origins.record("graph.a", { sessionId: "session-1" });
    expect(existsSync(join(root, HOST_INVOCATION_ORIGINS_FILE))).toBe(false);
    expect(HostInvocationOrigins.open({ root }).get("graph.a")).toBeUndefined();
  });

  it("refuses a record file it cannot read instead of treating it as empty", () => {
    const root = makeTmpDir("invocation-origins-corrupt-");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, HOST_INVOCATION_ORIGINS_FILE), "{ not json", "utf8");
    expect(() => HostInvocationOrigins.open({ root, durability: "file" })).toThrow(
      /refusing to open it as if it were empty/,
    );

    writeFileSync(
      join(root, HOST_INVOCATION_ORIGINS_FILE),
      JSON.stringify({ version: 99, origins: [] }),
      "utf8",
    );
    expect(() => HostInvocationOrigins.open({ root, durability: "file" })).toThrow(
      /does not declare format version 1/,
    );

    writeFileSync(
      join(root, HOST_INVOCATION_ORIGINS_FILE),
      JSON.stringify({ version: 1, origins: [{ graphId: "graph.a", sessionId: "" }] }),
      "utf8",
    );
    expect(() => HostInvocationOrigins.open({ root, durability: "file" })).toThrow(
      /carries an entry this build cannot read/,
    );
  });

  it("writes the record atomically with mode 0600", () => {
    const root = makeTmpDir("invocation-origins-mode-");
    const origins = HostInvocationOrigins.open({ root, durability: "file" });
    origins.record("graph.a", { sessionId: "session-1" });
    const text = readFileSync(join(root, HOST_INVOCATION_ORIGINS_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1,
      origins: [{ graphId: "graph.a", sessionId: "session-1" }],
    });
  });
});

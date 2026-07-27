import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readGraphEvents } from "../../src/cli/commands/monitor/monitor-reader-graph.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-reader-graph-events-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, ".rolebox", "state");
}

/** Write an NDJSON event file directly into the state dir. */
function writeEventFile(filename: string, lines: string[]): string {
  const path = join(stateDir(), filename);
  // Each event is one complete line + a trailing newline (writer convention).
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""), "utf-8");
  return path;
}

describe("readGraphEvents", () => {
  it("returns an empty array when no graph-events files exist", () => {
    mkdirSync(stateDir(), { recursive: true });
    expect(readGraphEvents(stateDir())).toEqual([]);
  });

  it("returns an empty array when the state dir does not exist", () => {
    expect(readGraphEvents(join(tmpDir, "missing", ".rolebox", "state"))).toEqual(
      [],
    );
  });

  it("returns an empty array when only non-graph-events files exist", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      join(stateDir(), "unrelated.ndjson"),
      `{"ts":1}\n`,
      "utf-8",
    );
    expect(readGraphEvents(stateDir())).toEqual([]);
  });

  it("parses valid NDJSON graph-event lines into typed events in order", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEventFile("graph-events-aaa.ndjson", [
      JSON.stringify({
        ts: 100,
        graphId: "g1",
        nodeId: "n1",
        event: "node_dispatched",
        status: "running",
        agent: "emperor--jinyiwei--backend",
        startedAt: 90,
      }),
      JSON.stringify({
        ts: 200,
        graphId: "g1",
        nodeId: "n1",
        event: "node_completed",
        status: "completed",
        signalType: "answer",
        agent: "emperor--jinyiwei--backend",
        startedAt: 90,
        completedAt: 200,
      }),
      JSON.stringify({
        ts: 300,
        graphId: "g1",
        event: "phase_change",
        status: "complete",
      }),
    ]);

    const events = readGraphEvents(stateDir());
    expect(events).toHaveLength(3);

    // Ordered by ts ascending.
    expect(events.map((e) => e.event)).toEqual([
      "node_dispatched",
      "node_completed",
      "phase_change",
    ]);

    // node_dispatched — no signalType/completedAt.
    expect(events[0]).toEqual({
      ts: 100,
      graphId: "g1",
      nodeId: "n1",
      event: "node_dispatched",
      status: "running",
      agent: "emperor--jinyiwei--backend",
      startedAt: 90,
    });

    // node_completed — full node-scoped surface.
    expect(events[1]).toEqual({
      ts: 200,
      graphId: "g1",
      nodeId: "n1",
      event: "node_completed",
      status: "completed",
      signalType: "answer",
      agent: "emperor--jinyiwei--backend",
      startedAt: 90,
      completedAt: 200,
    });

    // phase_change — no nodeId/agent.
    expect(events[2]).toEqual({
      ts: 300,
      graphId: "g1",
      event: "phase_change",
      status: "complete",
    });
  });

  it("coalesces and chronologically orders events across multiple files", () => {
    mkdirSync(stateDir(), { recursive: true });
    // ts deliberately out of file / line order to prove chronological sort.
    writeEventFile("graph-events-bbb.ndjson", [
      JSON.stringify({ ts: 500, graphId: "g2", event: "phase_change", status: "complete" }),
      JSON.stringify({ ts: 100, graphId: "g2", event: "phase_change", status: "executing" }),
    ]);
    writeEventFile("graph-events-aaa.ndjson", [
      JSON.stringify({ ts: 300, graphId: "g1", event: "phase_change", status: "executing" }),
      JSON.stringify({ ts: 400, graphId: "g1", event: "node_dispatched", nodeId: "n9", status: "running" }),
    ]);

    const events = readGraphEvents(stateDir());
    expect(events.map((e) => e.ts)).toEqual([100, 300, 400, 500]);
    expect(events.map((e) => e.graphId)).toEqual(["g2", "g1", "g1", "g2"]);
  });

  it("skips malformed lines without aborting the file or the reader", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEventFile("graph-events-mixed.ndjson", [
      JSON.stringify({ ts: 10, graphId: "g", event: "phase_change", status: "executing" }),
      "not valid json {{{",
      "", // empty / trailing newline
      JSON.stringify({ graphId: "g", event: "phase_change" }), // missing ts
      JSON.stringify({ ts: 20, event: "phase_change" }), // missing graphId
      JSON.stringify({ ts: "30", graphId: "g", event: "phase_change" }), // ts wrong type
      JSON.stringify({ ts: 40, graphId: "g", event: "phase_change", status: "complete" }),
      JSON.stringify([1, 2, 3]), // array, not an object
    ]);

    const events = readGraphEvents(stateDir());
    expect(events.map((e) => e.ts)).toEqual([10, 40]);
  });

  it("returns only the most recent maxLines events", () => {
    mkdirSync(stateDir(), { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ ts: i + 1, graphId: "g", event: "phase_change", status: "executing" }),
    );
    writeEventFile("graph-events-many.ndjson", lines);

    expect(readGraphEvents(stateDir(), 3).map((e) => e.ts)).toEqual([8, 9, 10]);
    // Default limit of 20 is above the 10 events, so all are returned.
    expect(readGraphEvents(stateDir())).toHaveLength(10);
    // A limit of 0 / negative yields nothing.
    expect(readGraphEvents(stateDir(), 0)).toEqual([]);
  });

  it("returns an empty array when only malformed content is present", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEventFile("graph-events-onlybad.ndjson", [
      "this is not json",
      "{broken",
    ]);
    expect(readGraphEvents(stateDir())).toEqual([]);
  });
});

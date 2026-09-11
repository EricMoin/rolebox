/// <reference types="bun-types" />

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GraphEventPoll, foldGraphSignals } from "../../src/tui/events";
import type { RoleboxEvent } from "../../src/tui/events";

// ── Test helpers ─────────────────────────────────────────────────────

let tmpProjectDir: string;

function setupStateDir(): string {
  tmpProjectDir = join(
    tmpdir(),
    `rolebox-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const stateDir = join(tmpProjectDir, ".rolebox", "state");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function graphFile(stateDir: string, name = "abc"): string {
  return join(stateDir, `graph-events-${name}.ndjson`);
}

/** One complete `node_dispatched` line (with trailing newline). */
function dispatchedLine(
  over: Partial<{ ts: number; graphId: string; nodeId: string; agent: string }> = {},
): string {
  return JSON.stringify({
    ts: 1_000,
    graphId: "g1",
    nodeId: "n1",
    event: "node_dispatched",
    status: "running",
    agent: "agent-x",
    ...over,
  }) + "\n";
}

/** One complete `node_completed` line (with trailing newline). */
function completedLine(
  over: Partial<{
    ts: number;
    graphId: string;
    nodeId: string;
    agent: string;
    status: string;
    signalType: string;
  }> = {},
): string {
  return JSON.stringify({
    ts: 2_000,
    graphId: "g1",
    nodeId: "n1",
    event: "node_completed",
    status: "completed",
    signalType: "answer",
    agent: "agent-x",
    ...over,
  }) + "\n";
}

afterEach(() => {
  if (tmpProjectDir) rmSync(tmpProjectDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("GraphEventPoll (TUI graph-events bridge)", () => {
  it("appending one line emits exactly one graph_node_start event", () => {
    const stateDir = setupStateDir();
    const poll = new GraphEventPoll(stateDir);

    // No files yet → nothing emitted.
    expect(poll.poll()).toHaveLength(0);

    const file = graphFile(stateDir);
    appendFileSync(file, dispatchedLine());

    const events = poll.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "graph_node_start",
      graphId: "g1",
      nodeId: "n1",
      agent: "agent-x",
      // node_dispatched lines carry status "running" — surfaced as the event status.
      status: "running",
    });
    expect(typeof events[0].ts).toBe("string");
  });

  it("re-polling with no new lines emits none", () => {
    const stateDir = setupStateDir();
    const poll = new GraphEventPoll(stateDir);

    const file = graphFile(stateDir);
    appendFileSync(file, dispatchedLine());
    expect(poll.poll()).toHaveLength(1);

    // No new content → no new events.
    expect(poll.poll()).toHaveLength(0);
    expect(poll.poll()).toHaveLength(0);
  });

  it("a corrupted/partial last line is not double-emitted", () => {
    const stateDir = setupStateDir();
    const poll = new GraphEventPoll(stateDir);

    const file = graphFile(stateDir);
    // Complete line, then a partial line with NO trailing newline.
    appendFileSync(file, dispatchedLine({ nodeId: "n1" }));
    appendFileSync(file, '{"ts":2000,"graphId":"g1","nodeId":"n2","event":');

    // Only the complete line is emitted; the partial tail is held, not dropped.
    const first = poll.poll();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "graph_node_start", nodeId: "n1" });

    // Re-poll: the partial tail must not be emitted (and line1 not re-emitted).
    expect(poll.poll()).toHaveLength(0);

    // Now the partial line completes → it surfaces exactly once.
    appendFileSync(file, '"node_dispatched","agent":"a"}\n');
    const second = poll.poll();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      type: "graph_node_start",
      nodeId: "n2",
    });

    // And it is not emitted again.
    expect(poll.poll()).toHaveLength(0);
  });

  it("a corrupted complete line is skipped without re-emission", () => {
    const stateDir = setupStateDir();
    const poll = new GraphEventPoll(stateDir);

    const file = graphFile(stateDir);
    appendFileSync(file, dispatchedLine());
    // A complete line (newline-terminated) that is not valid JSON.
    appendFileSync(file, "this-is-not-json\n");

    const events = poll.poll();
    // Only the valid line surfaces; the corrupt complete line is skipped.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "graph_node_start", nodeId: "n1" });

    // Skipped corrupt line is NOT re-emitted on the next poll.
    expect(poll.poll()).toHaveLength(0);
  });

  it("maps node_completed → graph_node_end and phase_change → graph_signal", () => {
    const stateDir = setupStateDir();
    const poll = new GraphEventPoll(stateDir);

    const file = graphFile(stateDir);
    appendFileSync(file, completedLine());
    appendFileSync(file, JSON.stringify({
      ts: 3_000,
      graphId: "g1",
      event: "phase_change",
      status: "complete",
    }) + "\n");
    // budget_update and unknown kinds have no TUI surface — skipped.
    appendFileSync(file, JSON.stringify({
      ts: 4_000,
      graphId: "g1",
      event: "budget_update",
      budget: {},
    }) + "\n");
    appendFileSync(file, JSON.stringify({
      ts: 5_000,
      graphId: "g1",
      event: "node_dispatched",
    }) + "\n"); // node event missing nodeId → dropped

    const events = poll.poll();
    expect(events).toHaveLength(2);

    const [end, signal] = events;
    expect(end).toMatchObject({
      type: "graph_node_end",
      graphId: "g1",
      nodeId: "n1",
      agent: "agent-x",
      status: "completed",
      signalType: "answer",
    });
    expect(signal).toMatchObject({
      type: "graph_signal",
      graphId: "g1",
      status: "complete",
    });
  });

  it("surfaces each appended line exactly once across a batch", () => {
    const stateDir = setupStateDir();
    const poll = new GraphEventPoll(stateDir);

    const file = graphFile(stateDir);
    for (let i = 1; i <= 5; i++) {
      appendFileSync(file, dispatchedLine({ nodeId: `n${i}` }));
    }

    const events = poll.poll();
    expect(events).toHaveLength(5);
    expect(events.map((e: RoleboxEvent) => (e as { nodeId?: string }).nodeId)).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    expect(poll.poll()).toHaveLength(0);
  });
});

// ── foldGraphSignals (live-signal fold) ────────────────────────────────

describe("foldGraphSignals (live-signal fold)", () => {
  const ts = "2026-08-20T00:00:00.000Z";

  it("folds a running node entry into the node-scoped map", () => {
    const { graphSignals, nodeSignals } = foldGraphSignals(
      [
        {
          type: "graph_node_start",
          graphId: "g1",
          nodeId: "n1",
          agent: "agent-x",
          status: "running",
          ts,
        },
      ],
      new Map(),
      new Map(),
    );

    // node_dispatched → graph_node_start carries status "running".
    expect(nodeSignals.get("g1::n1")).toBe("running");
    // Node events never write the graph-level (engine-phase) map.
    expect(graphSignals.size).toBe(0);
  });

  it("keeps the graph-level map engine-phase-only and folds node statuses", () => {
    const events: RoleboxEvent[] = [
      { type: "graph_signal", graphId: "g1", status: "executing", ts },
      { type: "graph_node_start", graphId: "g1", nodeId: "n1", agent: "agent-x", status: "running", ts },
      {
        type: "graph_node_end",
        graphId: "g1",
        nodeId: "n1",
        agent: "agent-x",
        status: "completed",
        signalType: "answer",
        ts,
      },
    ];

    const { graphSignals, nodeSignals } = foldGraphSignals(events, new Map(), new Map());

    // graph-level slot carries the engine phase (graph_signal only)…
    expect(graphSignals.get("g1")).toBe("executing");
    // …while the node-scoped slot carries the node status, never the
    // terminating signalType (answer/revise_needed).
    expect(nodeSignals.get("g1::n1")).toBe("completed");
    expect(nodeSignals.get("g1::n1")).not.toBe("answer");
  });

  it("preserves prior entries and lets later events win", () => {
    const { graphSignals, nodeSignals } = foldGraphSignals(
      [
        {
          type: "graph_node_end",
          graphId: "g1",
          nodeId: "n1",
          agent: "agent-x",
          status: "completed",
          signalType: "answer",
          ts,
        },
      ],
      new Map([["g1", "executing"]]),
      new Map([["g1::n1", "running"]]),
    );

    // running → completed in place; the graph-level phase survives untouched.
    expect(nodeSignals.get("g1::n1")).toBe("completed");
    expect(graphSignals.get("g1")).toBe("executing");
  });
});

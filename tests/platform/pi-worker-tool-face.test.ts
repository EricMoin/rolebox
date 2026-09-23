/**
 * The Pi worker's handed tool face (A21 / plan §3.3).
 *
 * WHAT THIS FILE PINS. A spawned Pi child receives EXACTLY
 * `PI_SUBAGENT_TOOLS` — the deterministic allowlist the entry passes to
 * `registerAgentConfig` and to the child process's `--tools` — so that list
 * IS the worker's model-facing tool face on this platform. Of the graph face it
 * must carry the delivery channel and nothing else: the declaration ingress
 * (graph_declare), the store inventory (graph_audit) and the status query
 * (graph_status) belong to the declaring/operating principal, and a worker that
 * needs them is a principal the run path does not have.
 *
 * ONE SOURCE OF TRUTH. The list is asserted against
 * `WORKER_GRANTED_GRAPH_TOOLS`, the same allow-list the host's per-call
 * boundary enforces (src/graph/host/outcome-host.ts), so the face a child is
 * HANDED and the face its calls are JUDGED BY cannot drift apart. The wiring of
 * the list into the spawned child's argv is covered by
 * tests/pi-process-session-json.test.ts (it asserts `--tools` equals this
 * constant, comma-joined); this file covers what the list must contain.
 *
 * STRENGTH: pure unit over the shipped entry's exported allowlist. No real Pi
 * SDK runs in this environment.
 */

import { describe, expect, it } from "bun:test";

import { PI_SUBAGENT_TOOLS } from "../../src/entries/pi.ts";
import { WORKER_GRANTED_GRAPH_TOOLS } from "../../src/graph/host/outcome-host.ts";

describe("the Pi spawned-child tool face", () => {
  it("carries exactly the host's worker grant of the graph face", () => {
    const graphTools = PI_SUBAGENT_TOOLS.filter((name) => name.startsWith("graph_"));
    expect(graphTools).toEqual([...WORKER_GRANTED_GRAPH_TOOLS]);
    expect(graphTools).toEqual(["graph_submit_outcome"]);
  });

  it("does not carry the declaration ingress, the store inventory or the status query", () => {
    for (const declarerTool of ["graph_declare", "graph_audit", "graph_status"]) {
      expect(PI_SUBAGENT_TOOLS).not.toContain(declarerTool);
    }
  });

  it("carries no duplicate tool name", () => {
    expect(new Set(PI_SUBAGENT_TOOLS).size).toBe(PI_SUBAGENT_TOOLS.length);
  });
});

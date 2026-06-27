import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractDispatchTarget,
  advanceGraphForDispatch,
} from "../../src/graph/advance";
import { graphSessionState } from "../../src/graph/state";
import type { ResolvedGraph } from "../../src/types";

function makeTestGraph(): ResolvedGraph {
  return {
    edges: [
      { from: "parent", to: "coder" },
      { from: "coder", to: "reviewer", label: "code ready" },
      { from: "reviewer", to: "parent", exit: true, label: "approved" },
    ],
    nodes: ["coder", "reviewer"],
    maxIterations: 3,
    exitEdges: [
      { from: "reviewer", to: "parent", exit: true, label: "approved" },
    ],
  };
}

describe("extractDispatchTarget", () => {
  // ── Structured args ────────────────────────────────────────────

  it("extracts subagent_type from structured task args", () => {
    const result = extractDispatchTarget("task", {
      subagent_type: "coder",
      prompt: "do something",
    });
    expect(result).toBe("coder");
  });

  it("extracts subagent from structured dispatch args", () => {
    const result = extractDispatchTarget("dispatch", {
      subagent: "reviewer",
    });
    expect(result).toBe("reviewer");
  });

  it("returns undefined for missing field in structured task args", () => {
    const result = extractDispatchTarget("task", { prompt: "x" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for missing field in structured dispatch args", () => {
    const result = extractDispatchTarget("dispatch", { prompt: "x" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string subagent_type", () => {
    const result = extractDispatchTarget("task", { subagent_type: "" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string subagent", () => {
    const result = extractDispatchTarget("dispatch", { subagent: "" });
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    const result = extractDispatchTarget("task", {});
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-string subagent_type (number)", () => {
    const result = extractDispatchTarget("task", { subagent_type: 123 });
    expect(result).toBeUndefined();
  });

  // ── String fallback: quoted regex ──────────────────────────────

  it("extracts quoted subagent_type from string args", () => {
    const result = extractDispatchTarget(
      "task",
      'task(subagent_type="team-lead--coder", prompt="do it")',
    );
    expect(result).toBe("team-lead--coder");
  });

  it("extracts single-quoted subagent_type from string args", () => {
    const result = extractDispatchTarget(
      "task",
      "task(subagent_type='team-lead--coder', prompt='do it')",
    );
    expect(result).toBe("team-lead--coder");
  });

  it("extracts quoted subagent from dispatch string args", () => {
    const result = extractDispatchTarget(
      "dispatch",
      'some text subagent="team-lead--coder" more',
    );
    expect(result).toBe("team-lead--coder");
  });

  // ── String fallback: unquoted regex ────────────────────────────

  it("extracts unquoted subagent_type from string args", () => {
    const result = extractDispatchTarget(
      "task",
      "task(subagent_type=explore, run_in_background=true)",
    );
    expect(result).toBe("explore");
  });

  it("extracts unquoted subagent_type when quoted regex fails", () => {
    const result = extractDispatchTarget(
      "task",
      'task(subagent_type=team-lead--coder, prompt="do it")',
    );
    expect(result).toBe("team-lead--coder");
  });

  it("extracts unquoted subagent when quoted regex fails", () => {
    const result = extractDispatchTarget(
      "dispatch",
      "subagent=team-lead--coder",
    );
    expect(result).toBe("team-lead--coder");
  });

  it("unquoted regex handles agent name with hyphens and double-dash", () => {
    const result = extractDispatchTarget(
      "task",
      "task(subagent_type=rolebox--impl-agent)",
    );
    expect(result).toBe("rolebox--impl-agent");
  });

  it("unquoted regex stops at closing paren", () => {
    const result = extractDispatchTarget("task", "subagent_type=explore)");
    expect(result).toBe("explore");
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it("returns undefined for null args", () => {
    const result = extractDispatchTarget("task", null);
    expect(result).toBeUndefined();
  });

  it("returns undefined for number args", () => {
    const result = extractDispatchTarget("task", 42);
    expect(result).toBeUndefined();
  });

  it("returns undefined for boolean args", () => {
    const result = extractDispatchTarget("dispatch", true);
    expect(result).toBeUndefined();
  });

  it("returns undefined for array args", () => {
    const result = extractDispatchTarget("task", ["something"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined for unknown tool with structured args", () => {
    const result = extractDispatchTarget("unknown_tool", {
      subagent_type: "coder",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when string fallback matches nothing", () => {
    const result = extractDispatchTarget("task", "no subagent_type here");
    expect(result).toBeUndefined();
  });
});

describe("advanceGraphForDispatch", () => {
  const SESSION_ID = "test-session-1";

  beforeEach(() => {
    graphSessionState.clear(SESSION_ID);
  });

  // ── In-route dispatches (normal flow, no correction) ───────────

  it("advances state when called with valid structured task args", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    const outcome = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
      prompt: "x",
    });

    expect(outcome.result.kind).toBe("advanced");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state).toBeDefined();
    expect(state!.completed).toContain("coder");
    expect(state!.frontier).toEqual(["reviewer"]);
  });

  it("advances state when called with valid dispatch args", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    const outcome = advanceGraphForDispatch(SESSION_ID, "dispatch", {
      subagent: "coder",
    });

    expect(outcome.result.kind).toBe("advanced");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state).toBeDefined();
    expect(state!.completed).toContain("coder");
  });

  it("advances state from string fallback args", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    const outcome = advanceGraphForDispatch(
      SESSION_ID,
      "task",
      'task(subagent_type="coder", prompt="x")',
    );

    expect(outcome.result.kind).toBe("advanced");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state).toBeDefined();
    expect(state!.completed).toContain("coder");
  });

  // ── Ignored cases (no graph state, inactive, untargetable) ─────

  it("returns ignored when session has no graph state", () => {
    const outcome = advanceGraphForDispatch("nonexistent", "task", {
      subagent_type: "coder",
    });

    expect(outcome.result.kind).toBe("ignored");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState("nonexistent");
    expect(state).toBeUndefined();
  });

  it("returns ignored when state status is complete", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    graphSessionState.getState(SESSION_ID)!.status = "complete";

    const outcome = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });

    expect(outcome.result.kind).toBe("ignored");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toEqual([]);
  });

  it("returns ignored when state status is exhausted", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    graphSessionState.getState(SESSION_ID)!.status = "exhausted";

    const outcome = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });

    expect(outcome.result.kind).toBe("ignored");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toEqual([]);
  });

  it("returns ignored when target cannot be extracted", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    const outcome = advanceGraphForDispatch(SESSION_ID, "task", {});

    expect(outcome.result.kind).toBe("ignored");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toEqual([]);
  });

  it("returns ignored when args is null", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    const outcome = advanceGraphForDispatch(SESSION_ID, "task", null);

    expect(outcome.result.kind).toBe("ignored");
    expect(outcome.correction).toBeUndefined();

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toEqual([]);
  });

  // ── Multi-step flow (completed graph walk) ─────────────────────

  it("advances through multiple steps correctly", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());

    const outcome1 = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });
    expect(outcome1.result.kind).toBe("advanced");
    expect(outcome1.correction).toBeUndefined();

    let state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toContain("coder");
    expect(state!.status).toBe("active");

    const outcome2 = advanceGraphForDispatch(SESSION_ID, "dispatch", {
      subagent: "reviewer",
    });
    expect(outcome2.result.kind).toBe("completed");
    expect(outcome2.correction).toBeUndefined();

    state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toContain("reviewer");
    expect(state!.status).toBe("complete");
  });

  // ── Off-route dispatch (target not in frontier) ────────────────

  it("returns correction for off-route dispatch (target not in frontier)", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());

    // Advance past "coder" so frontier is ["reviewer"]
    advanceGraphForDispatch(SESSION_ID, "task", { subagent_type: "coder" });

    // Dispatch "coder" again — not in frontier, should be off_route
    const outcome = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });

    expect(outcome.result.kind).toBe("off_route");
    expect(outcome.correction).toBeDefined();
    expect(outcome.correction!).toContain("coder");
    expect(outcome.correction!).toContain("reviewer");
    expect(outcome.correction!).toContain("off");

    // State unchanged
    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.frontier).toEqual(["reviewer"]);
    expect(state!.completed.filter((s) => s === "coder").length).toBe(1);
  });

  // ── Unknown agent target ───────────────────────────────────────

  it("returns correction for unknown agent target", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());

    const outcome = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "unknown-agent",
    });

    expect(outcome.result.kind).toBe("unknown");
    expect(outcome.correction).toBeDefined();
    expect(outcome.correction!).toContain("unknown-agent");
    expect(outcome.correction!).toContain("not part of the collaboration graph");

    // State unchanged
    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed).toEqual([]);
    expect(state!.status).toBe("active");
  });

  // ── Deduplication (second dispatch of same agent = off_route) ──

  it("deduplicates consecutive advance for same agent (double-trigger)", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());

    const outcome1 = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });
    expect(outcome1.result.kind).toBe("advanced");
    expect(outcome1.correction).toBeUndefined();

    const outcome2 = advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });
    expect(outcome2.result.kind).toBe("off_route");
    expect(outcome2.correction).toBeDefined();
    expect(outcome2.correction!).toContain("coder");

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completed.filter((s) => s === "coder").length).toBe(1);
    expect(state!.iterationCount).toBe(0);
  });
});

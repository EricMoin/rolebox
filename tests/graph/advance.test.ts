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

  it("advances state when called with valid structured task args", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
      prompt: "x",
    });

    const state = graphSessionState.getState(SESSION_ID);
    expect(state).toBeDefined();
    expect(state!.completedSteps).toContain("coder");
    expect(state!.currentStep).toBe(1);
  });

  it("advances state when called with valid dispatch args", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    advanceGraphForDispatch(SESSION_ID, "dispatch", {
      subagent: "coder",
    });

    const state = graphSessionState.getState(SESSION_ID);
    expect(state).toBeDefined();
    expect(state!.completedSteps).toContain("coder");
  });

  it("advances state from string fallback args", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    advanceGraphForDispatch(
      SESSION_ID,
      "task",
      'task(subagent_type="coder", prompt="x")',
    );

    const state = graphSessionState.getState(SESSION_ID);
    expect(state).toBeDefined();
    expect(state!.completedSteps).toContain("coder");
  });

  it("does nothing when session has no state", () => {
    advanceGraphForDispatch("nonexistent", "task", {
      subagent_type: "coder",
    });
    const state = graphSessionState.getState("nonexistent");
    expect(state).toBeUndefined();
  });

  it("does nothing when state status is complete", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    graphSessionState.getState(SESSION_ID)!.status = "complete";

    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toEqual([]);
  });

  it("does nothing when state status is exhausted", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    graphSessionState.getState(SESSION_ID)!.status = "exhausted";

    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toEqual([]);
  });

  it("does nothing when target cannot be extracted", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    advanceGraphForDispatch(SESSION_ID, "task", {});

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toEqual([]);
  });

  it("does nothing when args is null", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    advanceGraphForDispatch(SESSION_ID, "task", null);

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toEqual([]);
  });

  it("advances through multiple steps correctly", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());

    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });
    let state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toContain("coder");
    expect(state!.status).toBe("active");

    advanceGraphForDispatch(SESSION_ID, "dispatch", {
      subagent: "reviewer",
    });
    state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toContain("reviewer");
    expect(state!.status).toBe("complete");
  });

  it("does nothing with unknown agent target", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());
    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "unknown-agent",
    });

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps).toEqual([]);
    expect(state!.status).toBe("active");
  });

  it("deduplicates consecutive advance for same agent (double-trigger)", () => {
    graphSessionState.initGraph(SESSION_ID, makeTestGraph());

    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });
    advanceGraphForDispatch(SESSION_ID, "task", {
      subagent_type: "coder",
    });

    const state = graphSessionState.getState(SESSION_ID);
    expect(state!.completedSteps.filter((s) => s === "coder").length).toBe(1);
    expect(state!.iterationCount).toBe(0);
  });
});

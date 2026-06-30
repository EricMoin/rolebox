import { describe, it, expect, beforeEach } from "bun:test";
import {
  advanceGraphForDispatch,
  setAdvanceJudge,
  MAX_CORRECTIONS,
} from "../../src/graph/advance";
import { graphSessionState } from "../../src/graph/state";
import type { ResolvedGraph } from "../../src/types";
import type { JudgeFn } from "../../src/graph/termination-async";

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
    loopGroups: [],
  };
}

function makeGraphWithConverged(): ResolvedGraph {
  return {
    edges: [
      { from: "parent", to: "coder" },
      { from: "coder", to: "reviewer" },
      { from: "reviewer", to: "parent", exit: true },
    ],
    nodes: ["coder", "reviewer"],
    maxIterations: 5,
    exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
    loopGroups: [],
    termination: {
      config: {
        any_of: [{ converged: "Judge the convergence quality" }],
      },
      loopGroups: [],
    },
  };
}

function makeGraphWithConvergedAndStuck(): ResolvedGraph {
  // Back-edge loop so stuck can fire with repeated results.
  // Converged takes priority.
  return {
    edges: [
      { from: "parent", to: "coder" },
      { from: "coder", to: "reviewer" },
      { from: "reviewer", to: "coder", label: "loop" },
      { from: "reviewer", to: "parent", exit: true },
    ],
    nodes: ["coder", "reviewer"],
    maxIterations: 10,
    exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
    loopGroups: [
      {
        id: "coder,reviewer",
        nodes: ["coder", "reviewer"],
        backEdges: [{ from: "reviewer", to: "coder", label: "loop" }],
      },
    ],
    termination: {
      config: {
        any_of: [
          { converged: "Are the results good?" },
          { stuck: { repeats: 2 } },
        ],
      },
      loopGroups: [
        {
          id: "coder,reviewer",
          nodes: ["coder", "reviewer"],
          backEdges: [{ from: "reviewer", to: "coder", label: "loop" }],
        },
      ],
    },
  };
}

function makeGraphNoTermination(): ResolvedGraph {
  return {
    edges: [
      { from: "parent", to: "coder" },
      { from: "coder", to: "reviewer" },
      { from: "reviewer", to: "parent", exit: true },
    ],
    nodes: ["coder", "reviewer"],
    maxIterations: 5,
    exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
    loopGroups: [],
  };
}

describe("advanceGraphForDispatch v2", () => {
  const SID = "adv-v2-session";

  beforeEach(() => {
    graphSessionState.clear(SID);
    // Reset judge between tests to avoid cross-test leakage
    setAdvanceJudge(undefined as unknown as JudgeFn);
  });

  // ── 1. Off-route correction escalation after budget ────────────

  it("escalates correction message after MAX_CORRECTIONS off-route dispatches", () => {
    graphSessionState.initGraph(SID, makeTestGraph());

    // Step 1: advance past coder so frontier = [reviewer]
    const step1 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(step1.result.kind).toBe("advanced");
    expect(step1.correction).toBeUndefined();

    // Off-route #1 (correctionCount: 0→1)
    const r1 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(r1.result.kind).toBe("off_route");
    expect(r1.correction).toBeDefined();
    expect(r1.correction!).toContain("went off the collaboration graph route");
    expect(r1.correction!).not.toContain("has terminated due to repeated");

    // Off-route #2 (correctionCount: 1→2)
    const r2 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(r2.result.kind).toBe("off_route");
    expect(r2.correction).toBeDefined();
    expect(r2.correction!).toContain("went off the collaboration graph route");
    expect(r2.correction!).not.toContain("has terminated due to repeated");

    // Off-route #3 (correctionCount: 2→3) → escalated
    const r3 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(r3.result.kind).toBe("off_route");
    expect(r3.correction).toBeDefined();
    expect(r3.correction!).toContain(
      "has terminated due to repeated off-route dispatches",
    );
    expect(r3.correction!).toContain(
      "Stop dispatching and synthesize the best final result",
    );

    // Verify correctionCount on state
    const state = graphSessionState.getState(SID);
    expect(state!.correctionCount).toBe(3);

    // Off-route #4: still escalated (budget already exceeded)
    const r4 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(r4.correction!).toContain(
      "has terminated due to repeated off-route dispatches",
    );
    expect(graphSessionState.getState(SID)!.correctionCount).toBe(4);
  });

  it("MAX_CORRECTIONS is exported as 3", () => {
    expect(MAX_CORRECTIONS).toBe(3);
  });

  // ── 2. Async result applied to state for next turn ─────────────

  it("applies async converged result to state for next turn", async () => {
    const graph = makeGraphWithConverged();
    graphSessionState.initGraph(SID, graph);

    let judgePrompt = "";
    let judgeContext = "";
    setAdvanceJudge(async (prompt, context) => {
      judgePrompt = prompt;
      judgeContext = context;
      return true;
    });

    const outcome = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    // Sync: coder→reviewer forward edge, frontier now [reviewer], status active
    expect(outcome.result.kind).toBe("advanced");
    expect(outcome.correction).toBeUndefined();

    // Wait for async microtask + evaluateAsync to resolve
    await new Promise((r) => setTimeout(r, 30));

    expect(judgePrompt).toBe("Judge the convergence quality");
    expect(judgeContext).toContain("coder");
    expect(judgeContext).toContain("reviewer");

    const state = graphSessionState.getState(SID);
    expect(state!.terminationReason).toBe("converged");
    expect(state!.convergenceSignal).toBe("converged");
    expect(state!.status).toBe("complete");
  });

  it("applies async result_match result to state (no converged)", async () => {
    const graph: ResolvedGraph = {
      edges: [
        { from: "parent", to: "coder" },
        { from: "coder", to: "reviewer" },
        { from: "reviewer", to: "parent", exit: true },
      ],
      nodes: ["coder", "reviewer"],
      maxIterations: 5,
      exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
      loopGroups: [],
      termination: {
        config: {
          any_of: [{ result_matches: { agent: "coder", contains: "done" } }],
        },
        loopGroups: [],
      },
    };
    graphSessionState.initGraph(SID, graph);

    // Seed lastResults so result_matches can match
    const state = graphSessionState.getState(SID)!;
    state.lastResults = {
      coder: { hash: "abc123", text: "the work is done" },
    };

    // No judge needed for result_matches (it's sync within evaluateAsync)
    setAdvanceJudge(async () => false);

    const outcome = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(outcome.result.kind).toBe("advanced");

    await new Promise((r) => setTimeout(r, 30));

    const updated = graphSessionState.getState(SID);
    expect(updated!.terminationReason).toBe("result_match");
    expect(updated!.convergenceSignal).toBeUndefined();
    expect(updated!.status).toBe("complete");
  });

  it("does NOT change state when async converged fails", async () => {
    const graph = makeGraphWithConverged();
    graphSessionState.initGraph(SID, graph);

    setAdvanceJudge(async () => false);

    const outcome = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(outcome.result.kind).toBe("advanced");

    await new Promise((r) => setTimeout(r, 30));

    const state = graphSessionState.getState(SID);
    // No change — converged was false
    expect(state!.terminationReason).toBeNull();
    expect(state!.convergenceSignal).toBeUndefined();
    expect(state!.status).toBe("active");
  });

  // ── 3. Priority: converged > stuck ────────────────────────────

  it("converged wins over stuck (converged=true in async overrides stuck)", async () => {
    const graph = makeGraphWithConvergedAndStuck();
    graphSessionState.initGraph(SID, graph);

    // Seed lastResults so stuck fires synchronously in advanceStep
    const state = graphSessionState.getState(SID)!;
    state.lastResults = {
      coder: { hash: "abc", text: "result" },
      reviewer: { hash: "abc", text: "result" },
    };

    setAdvanceJudge(async () => true);

    // Advance coder: stuck fires in sync (2 agents same hash, repeats=2)
    // Sync result is "exhausted" because stuck has lower priority than converged
    // but no async result yet → sync treats it as exhausted
    advanceGraphForDispatch(SID, "task", { subagent_type: "coder" });

    // Wait for async to complete — converged should override stuck
    await new Promise((r) => setTimeout(r, 30));

    const updated = graphSessionState.getState(SID);
    // Converged wins → status should be complete, NOT exhausted
    expect(updated!.terminationReason).toBe("converged");
    expect(updated!.convergenceSignal).toBe("converged");
    expect(updated!.status).toBe("complete");
  });

  // ── 4. No async trigger when termination config lacks ──────────
  //    converged/result_matches

  it("does not trigger async when graph has no termination config", async () => {
    const graph = makeGraphNoTermination();
    graphSessionState.initGraph(SID, graph);

    let judgeCalled = false;
    setAdvanceJudge(async () => {
      judgeCalled = true;
      return true;
    });

    const outcome = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(outcome.result.kind).toBe("advanced");

    await new Promise((r) => setTimeout(r, 30));

    // Judge should never have been called — no async trigger
    expect(judgeCalled).toBe(false);

    const state = graphSessionState.getState(SID);
    expect(state!.terminationReason).toBeNull();
    expect(state!.convergenceSignal).toBeUndefined();
    expect(state!.status).toBe("active");
  });

  it("does not trigger async when termination config lacks converged/result_matches", async () => {
    const graph: ResolvedGraph = {
      edges: [
        { from: "parent", to: "coder" },
        { from: "coder", to: "reviewer" },
        { from: "reviewer", to: "parent", exit: true },
      ],
      nodes: ["coder", "reviewer"],
      maxIterations: 5,
      exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
      loopGroups: [],
      termination: {
        config: {
          any_of: [{ max_iterations: 3 }, { stuck: { repeats: 2 } }],
        },
        loopGroups: [],
      },
    };
    graphSessionState.initGraph(SID, graph);

    let judgeCalled = false;
    setAdvanceJudge(async () => {
      judgeCalled = true;
      return true;
    });

    advanceGraphForDispatch(SID, "task", { subagent_type: "coder" });

    await new Promise((r) => setTimeout(r, 30));

    // Only sync conditions (max_iterations, stuck) — no converged/result_matches
    expect(judgeCalled).toBe(false);
  });

  // ── 5. Normal advance still works (legacy paths) ───────────────

  it("normal advance through pipeline still works without termination", () => {
    graphSessionState.initGraph(SID, makeTestGraph());

    const out1 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(out1.result.kind).toBe("advanced");
    expect(out1.correction).toBeUndefined();

    let state = graphSessionState.getState(SID);
    expect(state!.completed).toContain("coder");
    expect(state!.frontier).toEqual(["reviewer"]);
    expect(state!.status).toBe("active");

    const out2 = advanceGraphForDispatch(SID, "dispatch", {
      subagent: "reviewer",
    });
    expect(out2.result.kind).toBe("completed");
    expect(out2.correction).toBeUndefined();

    state = graphSessionState.getState(SID);
    expect(state!.completed).toContain("reviewer");
    expect(state!.status).toBe("complete");
  });

  it("off-route still returns correction (legacy path)", () => {
    graphSessionState.initGraph(SID, makeTestGraph());

    // Advance coder
    advanceGraphForDispatch(SID, "task", { subagent_type: "coder" });

    // Off-route dispatch to coder again
    const out = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(out.result.kind).toBe("off_route");
    expect(out.correction).toBeDefined();
    expect(out.correction!).toContain("coder");
    expect(out.correction!).toContain("reviewer");

    // State unchanged
    const state = graphSessionState.getState(SID);
    expect(state!.frontier).toEqual(["reviewer"]);
  });

  it("unknown agent still returns correction (legacy path)", () => {
    graphSessionState.initGraph(SID, makeTestGraph());

    const out = advanceGraphForDispatch(SID, "task", {
      subagent_type: "unknown-agent",
    });
    expect(out.result.kind).toBe("unknown");
    expect(out.correction).toBeDefined();
    expect(out.correction!).toContain("unknown-agent");
    expect(out.correction!).toContain("not part of the collaboration graph");
  });

  it("ignored for missing session or inactive state (legacy paths)", () => {
    // No init → ignored
    const out1 = advanceGraphForDispatch("no-session", "task", {
      subagent_type: "coder",
    });
    expect(out1.result.kind).toBe("ignored");

    // Complete state → ignored
    graphSessionState.initGraph(SID, makeTestGraph());
    graphSessionState.getState(SID)!.status = "complete";
    const out2 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(out2.result.kind).toBe("ignored");

    // Exhausted state → ignored
    graphSessionState.clear(SID);
    graphSessionState.initGraph(SID, makeTestGraph());
    graphSessionState.getState(SID)!.status = "exhausted";
    const out3 = advanceGraphForDispatch(SID, "task", {
      subagent_type: "coder",
    });
    expect(out3.result.kind).toBe("ignored");
  });
});

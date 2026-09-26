/**
 * `renderGraphQuery` — THE COMPACT STATUS RENDER OF A STOPPED ATTEMPT.
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR. The compact (non-`json`, non-`group_by`)
 * status text keeps the TWO stopping shapes apart:
 *
 * - a NODE-SCOPED `failure`/`timeout` claims NO run control fact, so the render
 *   names the stopped attempt's own decision (`node_id`, `attempt_id`, command,
 *   reason, `decided_at`) while the run keeps executing;
 * - a RUN-WIDE `cancel`/`budget-stop` claims the run's control fact, so the
 *   render carries `control` and NEVER an attempt decision;
 * - a run that carries neither shape renders neither key.
 *
 * WHY A DEDICATED FILE. The stopped-attempt branch lives in the compact branch
 * of `src/graph/query/render.ts` (`stoppedAttemptDecisions` plus the
 * `view.control === undefined && stopped.length > 0` gate). The shipped
 * `graph_status` path reaches it only through a real store, so it was pinned
 * INDIRECTLY — one compact-status assertion inside `control-entry.test.ts` and
 * `tests/graph/status-queries.test.ts` covering `filterNodes`, not this render.
 * This file drives the SHIPPED `renderGraphQuery` on the view objects it
 * actually consumes: hand-built `GraphView` values, in the same spirit as the
 * hand-built `GraphNodeView` fixtures of `tests/graph/status-queries.test.ts`.
 *
 * EVERY CASE STATES HOW IT GOES RED, and the negative controls were actually
 * run: emptying `stoppedAttemptDecisions` (returning `[]`) turns the
 * node-scoped cases red; dropping the `view.control === undefined` half of the
 * gate turns the run-wide cases red; emitting the stopped set unconditionally
 * turns the neither-shape case red.
 *
 * STRENGTH: unit-level, text-level, on the shipped renderer — no store, no
 * host and no child process, so nothing here is real-host evidence either.
 */

import { describe, expect, it } from "bun:test";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { ZERO_BUDGET_USAGE, type BudgetReport } from "../../src/graph/domain/budget.ts";
import type { ControlDecisionRecord, RunControlRecord } from "../../src/graph/ledger/types.ts";
import type { GraphNodeView, GraphQueryResult, GraphView } from "../../src/graph/query/graph-query.ts";
import { renderGraphQuery, type GraphStatusArgs } from "../../src/graph/query/render.ts";

const GRAPH_ID = "render.chain";
const PLAN_REVISION = "plan-revision.render.chain";
const RUN_ID = "render.chain#1";
const DECIDED_AT = 1_700_000_000_123;

type GraphRunView = GraphView["runs"][number];

/** One node view, every face spelled out like the fixtures in `status-queries.test.ts`. */
function nodeView(nodeId: "work" | "review", status: GraphNodeView["status"], attemptId?: string): GraphNodeView {
  return {
    nodeId,
    agent: nodeId === "work" ? "worker" : "reviewer",
    prompt: nodeId === "work" ? "Produce the artifact" : "Consume the artifact",
    status,
    attemptId,
    outcomeId: undefined,
    dispatchedAt: undefined,
    settledAt: undefined,
    inputs: undefined,
    inputRefusals: undefined,
    arrivals: undefined,
  };
}

/** One durable decision row, as `store.controlDecisions` hands it to the view. */
function decision(
  command: ControlDecisionRecord["command"],
  reason: string,
  attemptId = "work#1",
  nodeId = "work",
): ControlDecisionRecord {
  return { graphId: GRAPH_ID, runId: RUN_ID, nodeId, attemptId, command, reason, decidedAt: DECIDED_AT };
}

/** The run control fact ONLY a run-wide `cancel`/`budget-stop` claims. */
function runControl(command: RunControlRecord["command"], reason: string): RunControlRecord {
  return { graphId: GRAPH_ID, runId: RUN_ID, command, reason, decidedAt: DECIDED_AT };
}

/**
 * The `GraphView` the renderer consumes, carrying exactly the faces the compact
 * branch reads. The faces no case here enables (`attempts`, `approvals`,
 * `loops`, `unsettledEffects`, the budget rows) are empty: the render only
 * reaches them through `include_*` flags, which this file never sets. The
 * projected `phase` mirrors the production projection in `readGraphView` — a
 * run with a control fact reads `stopped`, a run without one keeps the state's
 * own phase.
 */
function graphView(spec: {
  nodes: GraphNodeView[];
  decisions?: readonly ControlDecisionRecord[];
  control?: RunControlRecord;
  stop?: GraphRunView["stop"];
}): GraphView {
  const declaration: GraphDeclarationV3 = {
    version: 3,
    name: GRAPH_ID,
    nodes: [
      { id: "work", agent: "worker", prompt: "Produce the artifact", outcomes: [{ id: "done" }] },
      {
        id: "review", agent: "reviewer", prompt: "Consume the artifact",
        outcomes: [{ id: "done" }], inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [{ from: "work", to: "review", outcome: "done" }],
  };
  const budget: BudgetReport = {
    graphId: GRAPH_ID, runId: RUN_ID, planRevision: PLAN_REVISION,
    nodes: [], totals: ZERO_BUDGET_USAGE, reservedTotals: ZERO_BUDGET_USAGE,
    unknownUsageAttempts: 0, overruns: [],
  };
  const run: GraphRunView = {
    graphId: GRAPH_ID, runId: RUN_ID, planRevision: PLAN_REVISION, runSeq: 1,
    startedAt: DECIDED_AT - 1_000,
    phase: spec.control === undefined ? "executing" : "stopped",
    updatedAt: DECIDED_AT,
    control: spec.control,
    stop: spec.stop,
    attempts: [],
    nodes: spec.nodes,
    loops: [],
    approvals: [],
    decisions: spec.decisions ?? [],
    unsettledEffects: [],
    budget,
  };
  return {
    graphId: GRAPH_ID, planRevision: PLAN_REVISION, declaration, recordedAt: run.startedAt,
    phase: run.phase, updatedAt: run.updatedAt, nodes: spec.nodes, current: run, runs: [run],
  };
}

/** The shipped render, reached the way `graph_status` reaches it. */
function render(view: GraphView, args: GraphStatusArgs = {}): string {
  const query: GraphQueryResult = { graphs: [view], refused: [] };
  return renderGraphQuery(query, { graph_id: GRAPH_ID, scope: "all", ...args }, new Set());
}

/** The JSON object the compact branch appends after the node rows. */
function bodyOf(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("fixture: the compact render carries no JSON body");
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

describe("renderGraphQuery — the compact render of a stopped attempt", () => {
  for (const command of ["failure", "timeout"] as const) {
    it(`names a NODE-SCOPED ${command} decision and claims no control fact while the run keeps executing`, () => {
      const reason = `${command}: the worker process died before it declared an outcome`;
      const view = graphView({
        nodes: [nodeView("work", "dispatched", "work#1"), nodeView("review", "pending")],
        decisions: [decision(command, reason)],
      });

      const text = render(view);

      // The run keeps executing and the stopped attempt is still named as
      // dispatched — the two facts the readers must be able to tell apart.
      expect(text).toContain("[phase: executing]");
      expect(text).toContain("  work [dispatched] worker");
      // The ATTEMPT's decision is what the render carries ...
      expect(text).toContain('"decisions": [');
      expect(text).toContain('"nodeId": "work"');
      expect(text).toContain('"attemptId": "work#1"');
      expect(text).toContain(`"command": "${command}"`);
      expect(text).toContain(reason);
      expect(text).toContain(`"decidedAt": ${DECIDED_AT}`);
      // ... and NOTHING claims the run: a node-scoped stop writes no run fact.
      expect(text).not.toContain('"control"');
      expect(text).not.toContain('"stop"');
      expect(bodyOf(text)).toEqual({
        decisions: [{
          graphId: GRAPH_ID, runId: RUN_ID, nodeId: "work", attemptId: "work#1",
          command, reason, decidedAt: DECIDED_AT,
        }],
      });

      // RED WHEN THE BRANCH IS EMPTIED: with `stoppedAttemptDecisions` returning
      // `[]` (or the spread removed) the body is `{}`, so `"decisions": [`, the
      // node id, the attempt id, the command, the reason and the `decidedAt`
      // reading all disappear — the five `toContain`s and the `toEqual` fail.
      // RED IF THE RENDER INVENTED A CONTROL FACT for a node-scoped stop: the
      // `not.toContain('"control"')` assertion fails.
    });
  }

  it("carries the same attempt decision through the TREE format", () => {
    const reason = "timeout: the worker exceeded its deadline";
    const view = graphView({
      nodes: [nodeView("work", "dispatched", "work#1"), nodeView("review", "pending")],
      decisions: [decision("timeout", reason)],
    });

    const text = render(view, { format: "tree" });

    // The tree rows are the other row shape of the SAME compact branch.
    expect(text).toContain("work [dispatched]");
    expect(text).toContain("  review [pending]");
    expect(text).toContain('"command": "timeout"');
    expect(text).toContain(reason);
    expect(text).not.toContain('"control"');

    // RED WHEN THE BRANCH IS EMPTIED: the two decision assertions go red while
    // the tree rows stay green, which is what separates "the branch is gone"
    // from "the renderer is gone".
  });

  for (const command of ["cancel", "budget-stop"] as const) {
    it(`keeps a RUN-WIDE ${command} a control fact and renders no attempt decisions`, () => {
      const reason = `${command}: the trusted principal ended the run`;
      const view = graphView({
        nodes: [nodeView("work", "dispatched", "work#1"), nodeView("review", "pending")],
        // A run-wide stop records a decision too, naming the attempt it ended —
        // the same shape `control-entry.test.ts` reads back from the store — so
        // this view carries the decision AND the control fact, and the render
        // must still prefer `control` over `decisions`.
        decisions: [decision(command, reason)],
        control: runControl(command, reason),
      });

      const text = render(view);

      expect(text).toContain("[phase: stopped]");
      expect(text).toContain('"control": {');
      expect(text).toContain(`"command": "${command}"`);
      expect(text).toContain(reason);
      expect(text).toContain(`"decidedAt": ${DECIDED_AT}`);
      // The stopped set is NOT rendered once the run itself is claimed: the
      // compact face states one stopping reason, not two.
      expect(text).not.toContain('"decisions"');
      expect(bodyOf(text)).toEqual({
        control: {
          graphId: GRAPH_ID, runId: RUN_ID, command, reason, decidedAt: DECIDED_AT,
        },
      });

      // RED WHEN THE `view.control === undefined` HALF OF THE GATE IS DROPPED:
      // `cancel`/`budget-stop` are members of `STOPPING_CONTROL_COMMANDS` and
      // this view's decision names a still-dispatched attempt, so a gate that
      // only asked `stopped.length > 0` would append the decision array — the
      // two `not.toContain('"decisions"')` readings and the `toEqual` fail.
    });
  }

  it("renders neither key for a run that carries NEITHER shape", () => {
    const view = graphView({
      nodes: [nodeView("work", "dispatched", "work#1"), nodeView("review", "pending")],
      decisions: [],
    });

    const text = render(view);

    // Not vacuous: the run has a dispatched attempt and a JSON body to carry
    // the facts, and that body is empty.
    expect(text).toContain("[phase: executing]");
    expect(text).toContain("  work [dispatched] worker");
    expect(text).not.toContain('"control"');
    expect(text).not.toContain('"decisions"');
    expect(bodyOf(text)).toEqual({});

    // RED WHEN THE RENDER EMITS UNCONDITIONALLY: spreading the (empty) stopped
    // set, or `decisions: view.decisions`, adds a `"decisions"` key to this
    // body, so both absence readings and the `toEqual({})` fail. This case is
    // deliberately NOT sensitive to the branch being emptied — it pins the
    // other direction (no fact, no key).
  });

  it("reports only a STOPPING decision on the attempt the node is STILL on", () => {
    // A pause on a dispatched attempt: `approval-request` is a control
    // decision, and it is NOT one of the commands that end an attempt.
    const paused = render(graphView({
      nodes: [nodeView("work", "dispatched", "work#1")],
      decisions: [decision("approval-request", "wait for the approver")],
    }));
    expect(paused).not.toContain('"decisions"');
    expect(paused).not.toContain('"control"');

    // A `failure` superseded by a trusted `retry`: the node is dispatched
    // again as `work#2`, so the stop names an attempt the node is no longer
    // on — the classifier's second conjunct, and the shape the retry path
    // leaves behind (`control-entry.test.ts` reads exactly these two rows).
    const retried = render(graphView({
      nodes: [nodeView("work", "dispatched", "work#2")],
      decisions: [
        decision("failure", "the worker process died", "work#1"),
        decision("retry", "mint a successor", "work#1"),
      ],
    }));
    expect(retried).not.toContain('"decisions"');

    // RED WHEN THE CLASSIFICATION IS DROPPED: a filter over "every decision"
    // renders the paused attempt as stopped (first case) — the membership test
    // in `STOPPING_CONTROL_COMMANDS` is what keeps a pause out. RED WHEN THE
    // ATTEMPT-IDENTITY CONJUNCT IS DROPPED: matching on the node alone renders
    // the superseded `work#1` stop on top of the live `work#2` attempt.
  });
});
